"use strict";
/**
 * prompts/dicts.js — 镜头语言/情绪/性别 词典层（提示词体系 L3，2026-11-22）
 *
 * 提示词体系优化方案（docs/theater-prompt-system-plan.md §6.3/§6.4/§6.6）的落地点：
 * 把散落在各 worker 里的演示剧硬编码（场1-场4 光照、"她/She" 写死、女性巡游动作、
 * 女声歌曲锚点、单点负面词）收敛为四张词典＋性别工具，全链统一取用。
 *
 * 纪律：本模块纯数据＋纯函数，不 require 任何业务模块（零依赖、无环）。
 */

/* ---------- 景别（scriptgen shots[].size 枚举 → 构图短语） ---------- */
const SHOT_SIZE = {
  "特写": { zh: "特写构图，面部充满画面，背景虚化", en: "close-up" },
  "近景": { zh: "近景构图，胸部以上", en: "medium close-up" },
  "中景": { zh: "中景构图，腰部以上", en: "medium shot" },
  "全景": { zh: "全景构图，人物全身与环境同框", en: "full shot" },
  "远景": { zh: "远景构图，环境为主，人物较小", en: "wide shot" }
};
const SIZE_KEYS = Object.keys(SHOT_SIZE);

/* ---------- 运镜（scriptgen shots[].move 枚举 → 中文短语 / 英文运镜句） ---------- */
const CAMERA_MOVE = {
  "固定": { zh: "固定机位，轻微手持呼吸感", en: "The camera holds the composition with subtle handheld micro-movement" },
  "缓推": { zh: "镜头缓慢向前推进", en: "The camera slowly dollies in toward the subject" },
  "缓拉": { zh: "镜头缓慢向后拉远，带出更多环境", en: "The camera slowly pulls back, revealing more of the scene" },
  "左摇": { zh: "镜头平稳向左横摇", en: "The camera gently pans left across the scene" },
  "右摇": { zh: "镜头平稳向右横摇", en: "The camera gently pans right across the scene" },
  "跟拍": { zh: "镜头跟随人物移动", en: "The camera tracks alongside the subject, handheld" },
  "环绕": { zh: "镜头绕人物缓慢环绕", en: "The camera slowly arcs around the subject" },
  "手持": { zh: "手持晃动感跟拍", en: "The camera moves handheld with the action" },
  "升起": { zh: "镜头缓慢升起", en: "The camera slowly cranes up" }
};
const MOVE_KEYS = Object.keys(CAMERA_MOVE);

/* 旧剧本无 size/move 字段时按 desc 关键词推导（shotAngleNeed 同思路，兜底中景/固定） */
function guessSize(desc) {
  const s = String(desc || "");
  if (/特写|瞳孔|眼神|泪|嘴唇|面部大|脸部/.test(s)) return "特写";
  if (/远景|大远景|城市天际|整座|空旷|航拍/.test(s)) return "远景";
  if (/全身|从头到脚|整个人/.test(s)) return "全景";
  if (/近景|半身|胸部以上/.test(s)) return "近景";
  return "中景";
}
function guessMove(desc) {
  const s = String(desc || "");
  if (/环绕|绕着|弧形围绕/.test(s)) return "环绕";
  if (/跟拍|跟随|追随|一路跟/.test(s)) return "跟拍";
  if (/手持|晃动/.test(s)) return "手持";
  if (/升起|升镜|航拍|俯冲/.test(s)) return "升起";
  if (/拉远|拉出|后退|拉开/.test(s)) return "缓拉";
  if (/推近|推进|缓缓靠近|逼近/.test(s)) return "缓推";
  if (/向左摇|左摇|左移/.test(s)) return "左摇";
  if (/向右摇|右摇|右移/.test(s)) return "右摇";
  return "固定";
}
function sizeZh(size) { return (SHOT_SIZE[size] || SHOT_SIZE[guessSize("")]).zh; }
function sizeEn(size) { return (SHOT_SIZE[size] || {}).en || "medium shot"; }
function moveZh(move) { return (CAMERA_MOVE[move] || CAMERA_MOVE["固定"]).zh; }
/* 英文运镜句（H3 IR 用）：固定→默认微动句；其余把 "The camera ..." 句式直接给 */
function moveEn(move) { return (CAMERA_MOVE[move] || CAMERA_MOVE["固定"]).en; }

/* ---------- mood → 光线（t2i/LTX 用 zh，IR 用 en；style_pkg.light_by_mood 优先） ---------- */
const MOOD_LIGHT = {
  "压抑": { zh: "冷蓝低照度，硬阴影，对比沉重", en: "cold blue low-key lighting with hard shadows" },
  "释然": { zh: "暖金柔光，轻微逆光雾", en: "warm golden soft light with a gentle haze" },
  "离别": { zh: "暮色暖黄，长影子，边缘微冷", en: "dusk amber light with long shadows and slightly cool edges" },
  "紧张": { zh: "顶光硬照，明暗快速对切", en: "hard top light with sharp contrast" },
  "温馨": { zh: "暖黄实用光源，大面积柔漫射", en: "warm practical lights with broad soft diffusion" },
  "惊悚": { zh: "低照度冷绿，阴影吞没局部", en: "low-key cold green lighting with swallowing shadows" }
};
function lightZh(mood, pkg) {
  const m = String(mood || "").trim();
  if (pkg && pkg.light_by_mood && pkg.light_by_mood[m]) return String(pkg.light_by_mood[m]);
  return (MOOD_LIGHT[m] || {}).zh || "自然光效，写实光影";
}
function lightEn(mood, pkg) {
  const m = String(mood || "").trim();
  if (pkg && pkg.light_by_mood && pkg.light_by_mood[m]) return String(pkg.light_by_mood[m]);
  return (MOOD_LIGHT[m] || {}).en || "naturalistic lighting";
}

/* ---------- 场景关键词 → 环境音（H3 IR overall_soundscape 用，英文） ---------- */
const ENV_AMBIENCE = [
  [/雨|暴雨|雨幕|雨夜/, "rain drumming on surfaces with muffled city hum"],
  [/卧室|床|房间|酒店|民宿/, "quiet bedroom room tone"],
  [/办公室|办公|会议室|写字楼|工位/, "muffled office ambience with distant keyboard clicks"],
  [/街道|马路|码头|巷|路口/, "distant traffic and city street hum"],
  [/庭院|回廊|宫殿|府|檐|苑/, "soft night wind with distant insects in a courtyard"],
  [/酒吧|餐厅|食堂|市集/, "low murmur of a busy room"],
  [/森林|山|野外|林/, "wind through trees and distant birds"],
  [/电梯|走廊|楼道/, "hollow corridor room tone with faint electric hum"]
];
function ambienceEn(sceneName, pkg) {
  const s = String(sceneName || "");
  if (pkg && pkg.ambience_by_env) {
    for (const k of Object.keys(pkg.ambience_by_env)) {
      if (s.indexOf(k) >= 0) return String(pkg.ambience_by_env[k]);
    }
  }
  for (const [re, v] of ENV_AMBIENCE) { if (re.test(s)) return v; }
  return "quiet location room tone";
}

/* ---------- mood → TTS 情感指令（CosyVoice2 instruct 通道，服务端不支持则忽略该字段） ---------- */
const MOOD_TTS = {
  "压抑": "低沉压抑", "释然": "轻快释然", "离别": "哽咽不舍",
  "紧张": "急促紧绷", "温馨": "温柔松弛", "惊悚": "压低气声"
};
function ttsInstruct(mood) { return MOOD_TTS[String(mood || "").trim()] || null; }

/* ---------- mood → 配乐 tags（ACE-Step tags 通道；style_pkg.music_tags 优先） ---------- */
const MOOD_TAGS = {
  "压抑": "dark ambient ballad, low strings, sparse piano, 65 bpm",
  "释然": "warm acoustic, gentle piano, soft pads, 80 bpm",
  "离别": "melancholic ballad, strings, piano, 70 bpm",
  "紧张": "tense pulsing synth, low drone, 100 bpm",
  "温馨": "cozy acoustic, warm guitar, light percussion, 85 bpm",
  "惊悚": "eerie drone, sparse textures, 60 bpm"
};
function musicTags(mood, pkg) {
  if (pkg && pkg.music_tags) return String(pkg.music_tags);
  return MOOD_TAGS[String(mood || "").trim()] || MOOD_TAGS["释然"];
}

/* ---------- 音乐生成专业配置层（素材中心 2026-11-22·对齐 ACE-Step 1.5 原生通道） ----------
 * 引擎三通道：tags（全局控制，逗号分隔）／lyrics（结构标记局部控制）／caption（自然语言描述）。
 * 行业口径（Suno Custom Mode 同构）：风格描述与歌词分离、结构标记 [Verse]/[Chorus]、
 * 纯音乐＝无歌词或 [instrumental] 段标记。类型预设驱动默认值，专家模式全字段可覆写。 */
const MUSIC_GENRES = [
  { tag: "pop", zh: "流行" }, { tag: "ballad", zh: "民谣谣曲" }, { tag: "rock", zh: "摇滚" },
  { tag: "electronic", zh: "电子" }, { tag: "synthwave", zh: "合成器浪潮" }, { tag: "orchestral", zh: "管弦" },
  { tag: "solo piano", zh: "钢琴独奏" }, { tag: "strings", zh: "弦乐" }, { tag: "lo-fi", zh: "Lo-fi" },
  { tag: "jazz", zh: "爵士" }, { tag: "r&b", zh: "R&B" }, { tag: "hip-hop", zh: "嘻哈" },
  { tag: "folk", zh: "民谣" }, { tag: "chinese traditional", zh: "国风" }, { tag: "ambient", zh: "环境音乐" },
  { tag: "cinematic", zh: "影视配乐" }, { tag: "city pop", zh: "City Pop" }, { tag: "blues", zh: "蓝调" }
];
const MUSIC_INSTRUMENTS = [
  { tag: "piano", zh: "钢琴" }, { tag: "acoustic guitar", zh: "木吉他" }, { tag: "electric guitar", zh: "电吉他" },
  { tag: "strings ensemble", zh: "弦乐组" }, { tag: "brass", zh: "铜管" }, { tag: "flute", zh: "长笛" },
  { tag: "dizi", zh: "笛箫" }, { tag: "guzheng", zh: "古筝" }, { tag: "erhu", zh: "二胡" },
  { tag: "synth pad", zh: "合成器 Pad" }, { tag: "drums", zh: "鼓组" }, { tag: "bass", zh: "贝斯" },
  { tag: "guitar solo", zh: "吉他独奏" }, { tag: "violin solo", zh: "小提琴独奏" }, { tag: "hand percussion", zh: "手打击乐" }
];
const MUSIC_VOCALS = [
  { tag: "", zh: "纯音乐", instrumental: true },
  { tag: "female vocal", zh: "女声" },
  { tag: "male vocal", zh: "男声" },
  { tag: "duet female male vocal", zh: "男女对唱" },
  { tag: "choir", zh: "合唱" },
  { tag: "whisper vocal", zh: "气声吟唱" }
];
/* 类型预设：选中即填默认 tags/人声/结构/歌词骨架——快速可生成，专家可覆写 */
const MUSIC_TYPE_PRESETS = {
  bgm: {
    label: "背景 BGM",
    instrumental: true,
    structureLine: "[intro] [gentle build] [sustain] [soft fade]",
    tagsHint: "ambient, cinematic, underscore",
    lyrics: "",
    captionHint: "例：影视垫乐质感的氛围底铺，弦乐长音与钢琴点缀，不抢台词"
  },
  theme: {
    label: "主题曲（片头/片尾）",
    instrumental: false,
    structureLine: "[Intro] [Verse 1] [Pre-Chorus] [Chorus] [Verse 2] [Chorus] [Bridge] [Final Chorus] [Outro]",
    tagsHint: "cinematic pop, emotional",
    lyrics: "[Intro]\n[Verse 1]\n（主歌第一段：起于场景与人物）\n\n[Pre-Chorus]\n（情绪推进，铺垫爆发）\n\n[Chorus]\n（副歌记忆点：主题句重复两遍）\n\n[Verse 2]\n（主歌第二段：关系或冲突推进）\n\n[Chorus]\n\n[Bridge]\n（转折段：留白或转调）\n\n[Final Chorus]\n（最后一遍副歌，加和声/升 key）\n\n[Outro]",
    captionHint: "例：大气温情的主题曲，副歌有记忆点，结尾留悬念感"
  },
  ambient: {
    label: "氛围垫乐",
    instrumental: true,
    structureLine: "[ambient drone] [texture layers] [slow evolution] [fade]",
    tagsHint: "ambient, drone, texture, underscore",
    lyrics: "",
    captionHint: "例：雨夜氛围床，低频铺底加稀疏钢琴，循环无痕"
  },
  mv: {
    label: "MV 成曲",
    instrumental: false,
    structureLine: "[Intro] [Verse] [Pre-Chorus] [Chorus] [Post-Chorus] [Verse] [Chorus] [Outro]",
    tagsHint: "pop, catchy, radio-ready",
    lyrics: "[Intro]\n[Verse]\n（叙事段）\n\n[Pre-Chorus]\n\n[Chorus]\n（强记忆点）\n\n[Post-Chorus]\n（hook 重复段）\n\n[Verse]\n\n[Chorus]\n\n[Outro]",
    captionHint: "例：节奏明快的宣发曲，hook 密集，适合卡点剪辑"
  }
};
/** 组装最终 tags 串：曲风/乐器/BPM/人声/情绪词典——顺序稳定（审计快照可回放） */
function composeMusicTags(parts) {
  const p = parts || {};
  const segs = [];
  const push = (v) => { const s = String(v || "").trim().replace(/,\s*$/, ""); if (s) segs.push(s); };
  push(p.base);            // 用户 tags 或 mood 词典/风格包（唯一主描述来源）
  push(p.genres);          // 曲风 chips（逗号串）
  push(p.instruments);     // 乐器 chips（逗号串）
  push(p.moodWord);        // 情绪词（无 base 时兜底主控）
  push(p.bpm ? (Number(p.bpm) + " bpm") : "");
  push(p.vocal);           // 人声 tag（纯音乐为空）
  push(p.extra);           // 类型 hint 等
  return segs.join(", ").slice(0, 400);
}
/* 歌词骨架有效性软校验：主题曲/MV 至少含一个 [Chorus]（ACE-Step 结构标记纪律） */
function lyricsWarnings(lyrics, instrumental) {
  if (instrumental) return [];
  const l = String(lyrics || "");
  if (!l.trim()) return ["歌词为空且未勾选纯音乐——引擎将按无歌词处理（等于纯音乐），要人声请填写歌词"];
  const warn = [];
  if (!/\[chorus\]/i.test(l)) warn.push("缺 [Chorus] 段标记——副歌结构会不可控");
  if (!/\[(verse|intro)/i.test(l)) warn.push("缺 [Verse]/[Intro] 段标记——建议用骨架补全");
  return warn;
}

/* ---------- 歌曲锚点（t2v.remote DEFAULT_SONG 按情绪+主唱性别生成，替代女性慢谣常量） ---------- */
const SONG_MOOD = {
  "释然": { motif: "one memorable gentle theme, the same melodic motif carried through the whole song", accompaniment: "soft piano arpeggios with light strings", tempo: "about 72 bpm", key: "G major" },
  "离别": { motif: "one melancholic falling theme repeated across the song", accompaniment: "soft strings with piano", tempo: "about 66 bpm", key: "A minor" },
  "压抑": { motif: "one brooding minimal motif", accompaniment: "dark pads with sparse piano", tempo: "about 60 bpm", key: "D minor" },
  "紧张": { motif: "one urgent rhythmic motif", accompaniment: "pulsing synth bass with light strings", tempo: "about 100 bpm", key: "E minor" }
};
function defaultSongFor(mood, gender) {
  const base = Object.assign({}, SONG_MOOD[String(mood || "").trim()] || SONG_MOOD["释然"]);
  base.voice = gender === "男"
    ? "young male vocals, warm and close to the microphone"
    : "young female vocals, breathy and intimate, close to the microphone";
  return base;
}

/* ---------- 分层负面词库（§6.6）：按节点类型取用，替代单点 NEGATIVE ---------- */
const NEG = {
  quality: "低质量，模糊，畸变，噪点，水印，logo",
  person: "面部畸变，多余的手指，肢体扭曲，五官漂移",
  comp_single: "多人，分屏，拼贴，连环画",
  style: "插画，动漫，卡通，二次元，3D 渲染，CG 感，磨皮过度",
  text: "文字，字幕",
  video: "闪切，跳帧，拖影，黑帧"
};
function negativeFor(kind) {
  const j = (parts) => parts.join("，");
  switch (kind) {
    case "t2i_empty": return j([NEG.quality, NEG.text, NEG.style]); // 空镜：无人物层
    case "t2i_single": return j([NEG.quality, NEG.text, NEG.style, NEG.person, NEG.comp_single]); // 单人物镜
    case "t2i_multi": return j([NEG.quality, NEG.text, NEG.style, NEG.person]); // 双人镜：不禁多人
    case "edit": return j([NEG.quality, NEG.text, NEG.style, NEG.person]); // i2i 编辑
    case "poster": return j([NEG.quality, NEG.style, NEG.person, NEG.comp_single, NEG.text]); // 海报禁文字（标题后期字幕卡叠加）
    case "video": return j([NEG.quality, NEG.text, NEG.video]);
    default: return j([NEG.quality, NEG.text, NEG.style, NEG.person]);
  }
}

/* ---------- 性别工具（§6.4）：gender 字段优先 → desc/anchor 关键词 → role 名（旧逻辑降为末位） ---------- */
function genderOf(def, roleName) {
  const g = def && String(def.gender || "").trim();
  if (/^(女|女性|female|f|woman)$/i.test(g)) return "女";
  if (/^(男|男性|male|m|man)$/i.test(g)) return "男";
  const text = [def && def.desc, def && def.anchor].filter(Boolean).join(" ");
  if (text) {
    const f = text.search(/女性|女的|她|女生|女孩|少女|woman|girl|she/i);
    const m = text.search(/男性|男的|他|男生|男孩|少年|man(?!ager)|boy|\bhe\b/i);
    if (f >= 0 && (m < 0 || f < m)) return "女";
    if (m >= 0 && (f < 0 || m < f)) return "男";
  }
  const rn = String(roleName || (def && def.role) || "");
  if (/女/.test(rn)) return "女";
  if (/男/.test(rn)) return "男";
  return null; // 全无线索 → 上层按「女」兜底（与旧巡游/歌声默认一致，注释于调用面）
}
function pronZh(g) { return g === "男" ? "他" : "她"; }
function genderNounZh(g) { return g === "男" ? "一位年轻男性" : "一位年轻女性"; }
function pronEn(g) { return g === "男" ? "he" : "she"; }
function pronEnCap(g) { return g === "男" ? "He" : "She"; }
function possEn(g) { return g === "男" ? "his" : "her"; }

/* ---------- 试镜巡游两场景组合库（§5.3）：按剧本场景关键词挑组合，动作模板性别无关 ---------- */
const SCENE_PAIRS = [
  {
    id: "bedroom_balcony", label: "床头→阳台落地窗（城市夜景）",
    match: /卧室|床|房间|家|公寓|酒店|民宿/,
    sceneA: "bedside", sceneB: "balcony",
    actFront: "{P} sits at the bedside facing the camera and holds still for a moment",
    walk: "then rises from the bed and slowly walks to the floor-to-ceiling window of the balcony, the camera gently following {P}, revealing the glittering city night view outside the glass",
    actFrontB: "stands by the window facing the camera with the city lights bokeh behind {P} and holds",
    actLeftB: "slowly turns into a left three-quarter profile by the window with city light rim light on {Ps} face and holds",
    actGazeB: "finally turns {Ps} head to gaze out at the city night view with soft glow on {Ps} face and holds",
    light: "Soft diffused bedside lamp glow at first, then cool blue city night light with warm street light bokeh through the glass"
  },
  {
    id: "office_window", label: "办公桌窗前→走廊落地窗（城市天际线）",
    match: /办公|公司|写字楼|会议室|工位|职场/,
    sceneA: "desk", sceneB: "corridor",
    actFront: "{P} sits at the desk facing the camera and holds still for a moment",
    walk: "then rises from the desk and slowly walks to the floor-to-ceiling window at the end of the corridor, the camera gently following {P}, revealing the vast city skyline outside the glass",
    actFrontB: "stands by the glass facing the camera with the city skyline bokeh behind {P} and holds",
    actLeftB: "slowly turns into a left three-quarter profile by the glass with cool daylight rim light on {Ps} face and holds",
    actGazeB: "finally turns {Ps} head to gaze out at the city skyline with soft glow on {Ps} face and holds",
    light: "Soft diffused office daylight at first, then cool glass-filtered daylight with skyline bokeh"
  },
  {
    id: "mirror_courtyard", label: "妆台铜镜前→庭院回廊（月下）",
    match: /宫殿|庭院|府|宫|客栈|酒馆|阁|苑|居|殿/,
    sceneA: "mirror", sceneB: "courtyard",
    actFront: "{P} sits at the vanity mirror facing the camera and holds still for a moment",
    walk: "then rises and slowly walks through the arched door into the moonlit courtyard corridor, the camera gently following {P}, revealing lanterns glowing along the corridor",
    actFrontB: "stands under the corridor lanterns facing the camera with warm lantern bokeh behind {P} and holds",
    actLeftB: "slowly turns into a left three-quarter profile with lantern rim light on {Ps} face and holds",
    actGazeB: "finally turns {Ps} head to gaze into the moonlit courtyard with soft glow on {Ps} face and holds",
    light: "Warm candle and lantern glow at first, then cool moonlight mixed with warm lantern bokeh"
  },
  {
    id: "studio_window", label: "棚拍正面→窗前（兜底）",
    match: null,
    sceneA: "studio", sceneB: "window",
    actFront: "{P} stands facing the camera and holds still for a moment",
    walk: "then slowly walks to the large window nearby, the camera gently following {P}, revealing soft daylight outside the glass",
    actFrontB: "stands by the window facing the camera with soft daylight bokeh behind {P} and holds",
    actLeftB: "slowly turns into a left three-quarter profile by the window with soft rim light on {Ps} face and holds",
    actGazeB: "finally turns {Ps} head to gaze outside the window with soft glow on {Ps} face and holds",
    light: "Soft diffused studio light at first, then soft window daylight with gentle bokeh"
  }
];
function pickScenePair(script) {
  const hay = [];
  (script && script.scenes || []).forEach((sc) => {
    hay.push(String((sc && sc.name) || ""));
    (sc.shots || []).forEach((sh) => hay.push(String((sh && sh.desc) || "")));
  });
  const s = hay.join(" ");
  for (const p of SCENE_PAIRS) { if (p.match && p.match.test(s)) return p; }
  return SCENE_PAIRS[SCENE_PAIRS.length - 1];
}
function fillAct(tpl, g) {
  return String(tpl || "").replace(/\{Ps\}/g, possEn(g)).replace(/\{P\}/g, pronEn(g));
}

module.exports = {
  SHOT_SIZE, SIZE_KEYS, CAMERA_MOVE, MOVE_KEYS,
  guessSize, guessMove, sizeZh, sizeEn, moveZh, moveEn,
  MOOD_LIGHT, lightZh, lightEn,
  ENV_AMBIENCE, ambienceEn,
  MOOD_TTS, ttsInstruct,
  MOOD_TAGS, musicTags,
  MUSIC_GENRES, MUSIC_INSTRUMENTS, MUSIC_VOCALS, MUSIC_TYPE_PRESETS,
  composeMusicTags, lyricsWarnings,
  SONG_MOOD, defaultSongFor,
  NEG, negativeFor,
  genderOf, pronZh, genderNounZh, pronEn, pronEnCap, possEn,
  SCENE_PAIRS, pickScenePair, fillAct
};
