"use strict";
/**
 * workers/worker.t2v.remote.js — 视频·远端车道（MiniMax H3 · ComfyUI :8188 高价值/夜间闲时档）
 * 双模式（ADR-001 + 2026-11-21 裁决）：
 *  - remote-comfy 模式（cfg.comfyRemote.enabled）：
 *      · 首选 h3-fl2va-video：首帧＝该镜分镜图（C2 payload.images 按 shotId 绑定），原生声画直出；
 *      · 无分镜图但有定妆 refs（C2 候选/剧本 refImage）→ h3-ref2va-video（subject reference 保脸）；
 *      · prompt＝h3ir 规则拼装 IR（可选 LLM 全英文重写），LENGTH 按 17k+5 帧网格；
 *      · turbo 4step；内存常驻优先：仅 ram_free 低于阈值才 /free（用户纪律 2026-11-21）。
 *  - stub 模式（默认，验收套件）：mp4 头占位（meta kind:video-stub，绝不冒充真片）。
 * 用户面引擎标签一律「自部署·高价值档」；型号细节只进 meta/sidecar（豁免面）。
 */
const fs = require("fs");
const path = require("path");
const comfy = require("../adapters/comfy.js");
const h3ir = require("../adapters/h3ir.js");
const prompts = require("../../prompts/index.js");

const NAME = "t2v.remote";
const ENGINE = "MiniMax-H3 int8_convrot turbo4";
const ENGINE_USER = "自部署·高价值档";
const TIER = "h3-int8";
const COST_CENTS = 150;
// 生成档位（2026-11-22 运营化·节点配置＋注册表解析，不绑死模型）：
//   任务 tier fast/high 是「类」约束；落到哪个节点由算力池按类过滤；在节点上用哪个引擎由
//   注册表（settings.registry，带 class+tmpl 字段）解析——自动档缺省用节点 gen_pref。
//   加新引擎＝「引擎段位」登记一行（engine 名含 LTX/H3 决定代码路径族，tmpl 可覆盖固化模板）。
//   影子单价：LTX 类 100 分/5s、H3 类 150 分/5s。
const TMPL_LTX_I2V = "ltx25-i2v-spark";
const ENGINE_LTX = "LTX-2.5 int8_convrot";
const ENGINE_LTX_USER = "自部署·快速档";
const TIER_LTX = "ltx-int8";
const COST_LTX_CENTS = 100;

/** 本车道绑定的节点 id（注册表 lane→node 唯一事实源） */
function laneNodeId(ctx) {
  try {
    const st = ctx.store.get();
    const reg = (st.settings && st.settings.registry) || {};
    const hit = Object.keys(reg).map((k) => reg[k]).find((e) => e && e.lane === NAME && e.node);
    return hit ? hit.node : null;
  } catch (e) { return null; }
}

/** 任务档位 → 引擎类：显式 tier 优先；自动档用节点 gen_pref（速度优先/质量优先的节点配置） */
function wantClassOfJob(ctx, job) {
  if (job && job.tier === "fast") return "fast";
  if (job && job.tier === "high") return "quality";
  try {
    const st = ctx.store.get();
    const n = (st.nodes || {})[laneNodeId(ctx) || ""] || {};
    return n.gen_pref === "speed" ? "fast" : "quality";
  } catch (e) { return "quality"; }
}

/** 节点视频族引擎登记解析：按类优先，缺类回退第一条（meta 记 fallback，诚实标注） */
function videoEntryFor(ctx, wantClass) {
  const st = ctx.store.get();
  const reg = (st.settings && st.settings.registry) || {};
  const nodeId = laneNodeId(ctx);
  const entries = Object.keys(reg)
    .map((k) => Object.assign({ id: k }, reg[k]))
    .filter((e) => e && e.node === nodeId && String(e.lane || "") === NAME);
  if (!entries.length) return null;
  const hit = entries.find((e) => (e.class || "quality") === wantClass);
  if (hit) return { id: hit.id, entry: hit, fallback: false };
  return { id: entries[0].id, entry: entries[0], fallback: true };
}

/** 该登记是否 LTX 族（LTX→时间码提示词/两段蒸馏模板族；H3→IR 提示词族） */
function isLtxEntry(entry) {
  return /LTX/i.test(String((entry && entry.engine) || ""));
}
const TMPL_FL2VA = "h3-fl2va-video";
const TMPL_REF2VA = "h3-ref2va-video";
// LTX-2.5 Spark 档（2026-11-22 对标调研梯队①＋转场）：多镜串拍/转场衔接镜走远端 int8_convrot
const TMPL_MS = "ltx25-multishot-spark";
const TMPL_FLF = "ltx25-flf-spark";
// 歌曲锚点（2026-11-22 提示词体系升级）：不再写死「温柔女声慢谣」常量——按首场 mood+主唱性别
// 由 prompts.defaultSongFor 生成；ep.script.song（POST /api/episodes/:id/song）仍最高优先。
// 整首歌统一旋律动机/伴奏/唱法的纪律不变——8 镜独立生成拼起来像同一首歌。
const MP4_STUB = Buffer.from("\x00\x00\x00\x20ftypiso6\x00\x00\x02\x00iso6avc1mp41", "latin1");

/** ffmpeg 助手（runtime/bin/ffmpeg.exe，essentials 版） */
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.cwd(), "runtime", "bin", "ffmpeg.exe");
    if (!fs.existsSync(exe)) return reject(Object.assign(new Error("ffmpeg 不存在（runtime/bin）"), { code: "NO_FFMPEG" }));
    const pr = require("child_process").spawn(exe, args, { windowsHide: true });
    let err = "";
    pr.stderr.on("data", (c) => { if (err.length < 4000) err += String(c); });
    pr.on("close", (code) => code === 0 ? resolve(true) : reject(Object.assign(new Error("ffmpeg 失败：" + err.slice(-300)), { code: "FFMPEG_FAIL" })));
    pr.on("error", (e) => reject(Object.assign(new Error("ffmpeg 启动失败：" + e.message), { code: "FFMPEG_SPAWN" })));
    setTimeout(() => { try { pr.kill(); } catch (e2) {} reject(Object.assign(new Error("ffmpeg 超时"), { code: "FFMPEG_TIMEOUT" })); }, timeoutMs || 120000).unref();
  });
}

/** 首帧等比适配到镜幅（cover 居中裁切，不拉伸——试妆抽帧 736×1312 → 镜幅 768×1344 等） */
/** H3 全家桶原生音轨探测（2026-11-22 配音修复）：mp4 是否含音频流。
 *  fail-open（探测不了 → 视为有音）——H3 台词镜默认按「原生说话声」走。 */
function probeHasAudio(abs) {
  return new Promise((resolve) => {
    try {
      const exe = path.join(process.cwd(), "runtime", "bin", "ffmpeg.exe");
      if (!fs.existsSync(exe)) return resolve(true);
      const pr = require("child_process").spawn(exe, ["-hide_banner", "-i", abs], { windowsHide: true });
      let out = "";
      pr.stderr.on("data", (c) => { if (out.length < 8000) out += String(c); });
      pr.on("close", () => resolve(/Stream.*Audio:/.test(out)));
      pr.on("error", () => resolve(true));
    } catch (e) { resolve(true); }
  });
}

/** 首帧等比适配到镜幅（cover 居中裁切，不拉伸——试妆抽帧 736×1312 → 镜幅 768×1344 等） */
async function fitFrame(bytes, width, height, tag) {
  const tmpDir = path.join(process.cwd(), "var", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const src = path.join(tmpDir, "ff_" + tag + "_src.png");
  const dst = path.join(tmpDir, "ff_" + tag + "_fit.png");
  fs.writeFileSync(src, bytes);
  await runFfmpeg(["-y", "-i", src, "-vf", "scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,crop=" + width + ":" + height, dst]);
  const out = fs.readFileSync(dst);
  try { fs.unlinkSync(src); fs.unlinkSync(dst); } catch (e) { /* 临时文件清理失败不阻断 */ }
  return out;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function hash12(ctx, obj) {
  if (ctx && ctx.util && typeof ctx.util.hash12 === "function") {
    try {
      const h = String(ctx.util.hash12(obj) || "");
      if (/^[0-9a-fA-F]{8,}$/.test(h)) return h.toLowerCase();
    } catch (e) { /* fallthrough */ }
  }
  const s = JSON.stringify(obj);
  return fnv1a(s) + fnv1a(s + "|x").slice(0, 4);
}
function sub(hex, start, len) {
  const h = String(hex || "0");
  const reps = Math.ceil((start + len) / h.length) + 1;
  return h.repeat(reps).slice(start, start + len);
}
function safeSeg(s) {
  const v = String(s == null ? "" : s)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 120);
  return v || "x";
}
function writeOut(ctx, fileName, data) {
  const dir = path.join(String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join("var", "out")));
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, safeSeg(fileName));
  fs.writeFileSync(fp, data);
  return fp;
}
function log2(job, msg) { try { console.log("[t2v.remote " + String(job.id || "").slice(4, 10) + "] " + msg); } catch (e) {} }
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function settingsOf(ctx) {
  try {
    const st = ctx && ctx.store && typeof ctx.store.get === "function" ? ctx.store.get() || {} : {};
    return st.settings || {};
  } catch (e) {
    return {};
  }
}
/** 该镜剧本数据：desc、台词、在场角色人设、镜头语言字段与场景情绪（shots 按 seq 对齐，同 t2v.local） */
function shotScript(ctx, episodeId, shot) {
  const st = ctx.store.get();
  const ep = st.episodes && st.episodes[episodeId];
  const script = ep && ep.script;
  const out = { desc: (shot && shot.name) || "", dialogue: "", castDefs: [], scene: "", mood: "", size: null, move: null, light: "" };
  if (!script) return out;
  const flat = [];
  (script.scenes || []).forEach((sc) => (sc.shots || []).forEach((sh) => flat.push(Object.assign({ scene: sc.name, sceneMood: sc.mood }, sh))));
  const sh = flat[(shot.seq || 1) - 1] || {};
  out.desc = sh.desc || out.desc;
  out.dialogue = sh.dialogue || "";
  out.scene = sh.scene || "";
  out.mood = sh.sceneMood || "";
  out.size = sh.size || null;
  out.move = sh.move || null;
  out.light = sh.light || "";
  const cast = script.cast || [];
  out.castDefs = (sh.cast || []).map((role) => cast.find((x) => x.role === role || x.name === role)).filter(Boolean);
  // 兜底（2026-11-22 热舞派对复盘）：LLM 生成剧本的镜头常不写 cast 字段——空则回退全剧角色
  //（最多 3 人）做身份锚，否则 refs 恒空、开机全灭。真空镜仍可被 desc 驱动，塞人风险由
  // 分镜首帧路径（storyboard_char → FL2VA）优先覆盖，本回退只在没有首帧时兜底。
  if (!out.castDefs.length && cast.length) out.castDefs = cast.slice(0, 3);
  return out;
}
/** 分镜首帧：C2 payload.images 按 shotId 绑定的真图（同 t2v.local.sbFileForShot）。
 *  返回 { bytes, art }——art 供 meta 落盘（UI 展示每镜「首帧来源」与提示词受控链）。 */
function sbArtForShot(ctx, episodeId, shotId) {
  try {
    const st = ctx.store.get();
    const cards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
    // 首帧两处找：C2（storyboard 挂卡）为主，C4（分镜画面卡）兜底——2026-11-22 热舞派对复盘中
    // 发现 C2 被 castref 回填重写后 images 清空、图落在 C4 的实际案例
    const candidates = [];
    const c2 = cards.filter((x) => x.episodeId === episodeId && x.type === "C2").pop();
    if (c2 && c2.payload) candidates.push(c2.payload);
    const c4 = cards.filter((x) => x.episodeId === episodeId && x.type === "C4").pop();
    if (c4 && c4.payload) candidates.push(c4.payload);
    for (const payload of candidates) {
      const im = (payload.images || []).find((x) => x.shotId === shotId && x.art);
      if (!im) continue;
      const local = path.join(String(ctx.cfg && ctx.cfg.outDir || path.join("var", "out")), safeSeg(im.art.replace(/^.*[\\/]/, "")));
      if (fs.existsSync(local)) return { bytes: fs.readFileSync(local), art: im.art };
    }
    return null;
  } catch (e) {
    return null;
  }
}
/** 定妆 refs：C2 候选（按在场角色）→ 剧本 refImage → 内置默认，最多 3 张字节 Buffer */
function castRefArts(ctx, episodeId, castDefs) {
  const arts = [];
  try {
    const st = ctx.store.get();
    const cards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
    const c2 = cards.filter((x) => x.episodeId === episodeId && x.type === "C2").pop(); // 最新 C2
    const p = (c2 && c2.payload) || {};
    const flat = Array.isArray(p.candidates) ? p.candidates : []; // 旧扁平形态
    const nested = Array.isArray(p.actors) ? p.actors : []; // 2026-11-21 试妆试镜重构：actors[].candidates[]
    const localOf = (art) => path.join(String(ctx.cfg && ctx.cfg.outDir || path.join("var", "out")), safeSeg(String(art).replace(/^.*[\\/]/, "")));
    for (const cd of castDefs) {
      const cand = flat.find((x) => x && (x.role === cd.role || x.name === cd.name) && x.art)
        || nested.map((a) => (a && a.candidates) || []).reduce((acc, cs) => acc.concat(cs), [])
          .find((x) => x && (x.role === cd.role || x.name === cd.name) && x.art)
        || nested.map((a) => ({ role: a.role, art: a.refImage })).find((x) => x.role === cd.role && x.art);
      if (cand) {
        const local = localOf(cand.art);
        if (fs.existsSync(local) && !arts.some((a) => a.def && a.def.role === cd.role)) {
          arts.push({ bytes: fs.readFileSync(local), def: cd });
        }
      }
    }
  } catch (e) { /* 候选缺失走剧本 refImage */ }
  for (const cd of castDefs) {
    if (arts.length >= 3) break;
    if (arts.some((a) => a.def && a.def.role === cd.role)) continue;
    if (!cd.refImage) continue;
    const name = safeSeg(String(cd.refImage).replace(/^.*[\\/]/, ""));
    const candidates = [
      path.join(process.cwd(), "var", "assets", "cast", name),
      path.join(String(ctx.cfg && ctx.cfg.outDir || path.join("var", "out")), name)
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) { arts.push({ bytes: fs.readFileSync(p), def: cd }); break; }
    }
  }
  return arts.slice(0, 3);
}

/** LTX 快速档单镜 i2v（档位解析出的 LTX 类登记）：分镜首帧＋时间码单镜描述 → 原生声画直出。
 *  与 multishot 同模板族（两段蒸馏），仅 LENGTH/描述为单镜；影子计费 100 分/5s。
 *  ventry＝注册表登记（可带 tmpl.i2v 覆盖固化模板）。 */
async function runLtxFastComfy(ctx, job, p, seed, ventry) {
  const tmplId = (ventry && ventry.entry && ventry.entry.tmpl && ventry.entry.tmpl.i2v) || TMPL_LTX_I2V;
  const base = String((typeof ctx.cfg.laneBase === "function" ? ctx.cfg.laneBase(NAME) : (ctx.cfg.comfyRemote && ctx.cfg.comfyRemote.base) || "") || "").replace(/\/+$/, "");
  const shotId = p.shotId || null;
  const episodeId = p.episodeId || job.episodeId || null;
  const st = ctx.store.get();
  const shot = (st.shots || {})[shotId] || {};
  const scr = shotScript(ctx, episodeId, shot);
  const pkg = prompts.style.resolve(ctx, episodeId);
  const sb = sbArtForShot(ctx, episodeId, shotId);
  if (!sb) throw (() => { const e = new Error("该镜没有可用的分镜首帧（快速档也依赖分镜图）: " + shotId); e.code = "NO_REMOTE_INPUT_ART"; return e; })();
  const sec = Number(p.sec) > 0 ? Number(p.sec) : 5;
  const width = Number(p.width) > 0 ? Number(p.width) : 768;
  const height = Number(p.height) > 0 ? Number(p.height) : 1344;
  const LENGTH = frames8n1(sec);
  const cost = Math.max(COST_LTX_CENTS, Math.round(COST_LTX_CENTS * (LENGTH / 121)));
  const dlg = scr.dialogue ? "，台词：「" + scr.dialogue + "」" : "";
  const PROMPT = "0.0s-" + sec.toFixed(1) + "s：" + (scr.desc || shot.name || "") + dlg + "\n" + prompts.style.irStyleEn(pkg);
  await comfy.ensureFree(base, 8);
  const fitBytes = await fitFrame(sb.bytes, width, height, safeSeg(shotId).slice(0, 24));
  const ffName = await comfy.uploadAsset(base, fitBytes, "t2vr_ltx_" + safeSeg(shotId) + "_" + seed.slice(0, 6) + ".png");
  const r = await comfy.runTemplate(ctx, job, {
    base,
    tmplId: TMPL_LTX_I2V,
    params: {
      SEED: parseInt(String(seed).slice(0, 8), 16) % 18446744073709551615,
      PROMPT, WIDTH: width, HEIGHT: height, LENGTH,
      FPS: 24,
      STAGE1_W: Math.round(width / 2), STAGE1_H: Math.round(height / 2),
      CFG: 1,
      SIGMAS1: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
      SIGMAS2: "0.85, 0.7250, 0.4219, 0.0",
      IMAGE: ffName
    },
    pollMs: 3000,
    timeoutMs: 1200000
  });
  const takeId = safeSeg(p.takeId || "tk_" + seed.slice(0, 8));
  const fileName = takeId + ".mp4";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "video-comfy-remote", lane: NAME, engine: ENGINE_LTX, engine_user: ENGINE_LTX_USER, tier: TIER_LTX,
    engine_id: ventry ? ventry.id : null, class_fallback: ventry ? !!ventry.fallback : false,
    tmpl_id: tmplId, video_pref: "speed",
    sec: Number((LENGTH / 24).toFixed(2)), length: LENGTH, shotId, episodeId,
    prompt: PROMPT.slice(0, 400), first_frame: sb.art,
    prompt_id: r.meta.promptId, tmpl_sha16: r.meta.tmpl_sha16, comfy_commit: r.meta.comfy_commit, cn_commits: r.meta.cn_commits, weights: r.meta.weights,
    bytes: r.bytes.length, seed: String(parseInt(String(seed).slice(0, 8), 16)), cents: cost,
    ai_label: "AI 生成内容"
  };
  const abs = writeOut(ctx, fileName, r.bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const dlgText = String(scr.dialogue || "").trim();
  const nativeSpeech = dlgText ? await probeHasAudio(abs) : false;
  if (nativeSpeech) { meta.native_speech = true; meta.speech_text = dlgText; }
  const take = { id: takeId, engine: ENGINE_LTX_USER, cost_cents: cost, art, license: { model: "MIT", usage: "ok" }, best: true, native_speech: nativeSpeech, speech_text: nativeSpeech ? dlgText : undefined };
  const bag = { ok: true, cents: cost, art, path: art, meta, take, engine: ENGINE_LTX_USER, cost_cents: cost, license: take.license, sec: meta.sec, tier: TIER_LTX };
  job.result = bag; job.art = bag;
  return { ok: true, cents: cost, art, meta };
}

async function runRemoteComfy(ctx, job, p, seed, cents, settings) {
  const j = job || {};
  const base = String((typeof ctx.cfg.laneBase === "function" ? ctx.cfg.laneBase(NAME) : (ctx.cfg.comfyRemote && ctx.cfg.comfyRemote.base) || "") || "").replace(/\/+$/, ""); // 本 lane 绑定节点的 Comfy 端点（注册表 lane→node），旧部署回退 comfyRemote 通道
  const shotId = p.shotId || null;
  const st = ctx.store.get();
  const shot = (st.shots || {})[shotId] || {};
  const episodeId = p.episodeId || j.episodeId || null;
  const epRow = (st.episodes || {})[episodeId] || {};
  const scr = shotScript(ctx, episodeId, shot);
  // 风格包（2026-11-22）：IR 风格行/运镜/环境音全走注册中心，删写死 STYLE 常量
  const pkg = prompts.style.resolve(ctx, episodeId);
  const gender0 = scr.castDefs.length ? prompts.genderOf(scr.castDefs[0], scr.castDefs[0].role) : null;
  // 歌曲锚点仅在剧本显式给歌（POST /api/episodes/:id/song）时启用——MV/歌曲向集。
  // 2026-11-22 配音修复：defaultSongFor 永远生成一首歌会让对话剧每句台词都被 H3「唱」出来
  //（人声埋进自己生成的伴奏里听不清）。对话剧无歌 → IR 走 speaks 分支，台词正常说+口型。
  const song = (epRow.script && epRow.script.song) || null;
  const move = scr.move || prompts.guessMove(scr.desc);
  const ambience = prompts.ambienceEn(scr.scene, pkg);
  const sec = Number(p.sec) > 0 ? Number(p.sec) : 5;
  const length = h3ir.lengthFrames(sec);
  // 手机短剧默认竖屏 768×1344（H3 768p 短边），payload 可覆盖
  const width = Number(p.width) > 0 ? Number(p.width) : 768;
  const height = Number(p.height) > 0 ? Number(p.height) : 1344;
  const seedNum = parseInt(String(seed).slice(0, 8), 16) % 18446744073709551615;

  // 素材上传到远端 input
  const sb = sbArtForShot(ctx, episodeId, shotId);
  const sbBytes = sb && sb.bytes;
  const sbArt = sb && sb.art;
  const refs = castRefArts(ctx, episodeId, scr.castDefs);
  let tmplId, params, irLlmUsed = false, rMeta = null, mp4Bytes = null, reusedPid = null;
  if (sbBytes) {
    // 孤儿产物接续（断点续跑 2026-11-21）：同规格（length/width/height）+ 本镜歌词文本匹配的
    // 已渲成功产物直接领回（守护环境长任务随时被打断，避免重复渲染）。消费过的 prompt_id 落账。
    try {
      const st2 = ctx.store.get();
      st2.settings = st2.settings || {};
      const pool = st2.settings.remote_reuse_pool || (st2.settings.remote_reuse_pool = []);
      const keyDlg = String((scr.dialogue || "").trim().slice(0, 12));
      if (keyDlg) {
        const hist = await fetch(base + "/history", { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
        for (const pid of Object.keys(hist).reverse()) {
          if (pool.indexOf(pid) >= 0) continue;
          const rec = hist[pid] || {};
          if ((rec.status || {}).status_str !== "success") continue;
          let okSpec = false, promptTxt = "";
          Object.values((rec.prompt && rec.prompt[2]) || {}).forEach((n) => {
            if (n && n.class_type === "MiniMaxH3ImageToVideo" && n.inputs && n.inputs.length === length && n.inputs.width === width && n.inputs.height === height) okSpec = true;
            if (n && n.inputs && typeof n.inputs.prompt === "string") promptTxt += n.inputs.prompt;
          });
          if (!okSpec || promptTxt.indexOf(keyDlg) < 0) continue;
          let a0 = null;
          Object.values(rec.outputs || {}).forEach((o) => {
            const arr = o.videos || o.gifs || o.images || [];
            if (arr.length && !a0) a0 = arr[0];
          });
          if (!a0) continue;
          const q = "?filename=" + encodeURIComponent(a0.filename) + "&subfolder=" + encodeURIComponent(a0.subfolder || "") + "&type=" + encodeURIComponent(a0.type || "output");
          const res = await fetch(base + "/view" + q, { signal: AbortSignal.timeout(120000) });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (!buf || buf.length < 100000) continue;
          mp4Bytes = buf;
          reusedPid = pid;
          break;
        }
      }
      if (reusedPid) {
        log2(j, "接续孤儿产物 prompt_id=" + reusedPid + "（" + mp4Bytes.length + " bytes，免重渲）");
        pool.push(reusedPid);
        ctx.store.commit();
      }
    } catch (e) {
      log2(j, "reuse pool skip: " + e.message);
    }
  }
  if (sbBytes && mp4Bytes) {
    // 已接续：直接出 take（跳过渲染）
  } else if (sbBytes) {
    // 首帧等比适配到镜幅（开机前校准 2026-11-21：试妆抽帧 736×1312 → 镜幅 768×1344，cover 裁切防拉伸）
    const fitBytes = await fitFrame(sbBytes, width, height, safeSeg(shotId).slice(0, 24));
    const ffName = await comfy.uploadAsset(base, fitBytes, "t2vr_sb_" + safeSeg(shotId) + "_" + seed.slice(0, 6) + ".png");
    const ir = h3ir.buildFL2VA({
      shotDesc: scr.desc, dialogue: scr.dialogue, lang: "中文",
      style: prompts.style.irStyleEn(pkg), sec,
      speaker: scr.castDefs[0] && scr.castDefs[0].name,
      cameraEn: prompts.moveEn(move), ambienceEn: ambience, gender: gender0, song
    });
    const rewritten = await h3ir.rewriteWithLLM(ir, ctx.cfg);
    irLlmUsed = rewritten.llm_used === true;
    if (rewritten.reject_reason) log2(j, "IR 重写产物弃用（" + rewritten.reject_reason + "）——回退规则 IR");
    tmplId = TMPL_FL2VA;
    params = { SEED: seedNum, PROMPT: rewritten.ir, WIDTH: width, HEIGHT: height, LENGTH: length, STEPS: 4, FIRST_FRAME: ffName };
  } else if (refs.length) {
    const names = [];
    for (let i = 0; i < refs.length; i++) {
      names.push(await comfy.uploadAsset(base, refs[i].bytes, "t2vr_ref_" + safeSeg(refs[i].def.role || String(i)) + "_" + seed.slice(0, 6) + "_" + i + ".png"));
    }
    while (names.length < 3) names.push(names[names.length - 1]);
    const ir = h3ir.buildRef2VA({
      subjects: refs.map((r) => r.def), shotDesc: scr.desc, dialogue: scr.dialogue, lang: "中文",
      style: prompts.style.irStyleEn(pkg), sec,
      refImages: names.map((_, i) => "<Picture " + (i + 1) + ">"),
      sizeEn: prompts.sizeEn(scr.size || prompts.guessSize(scr.desc)),
      cameraEn: prompts.moveEn(move), ambienceEn: ambience, gender: gender0, song
    });
    const rewritten = await h3ir.rewriteWithLLM(ir, ctx.cfg);
    irLlmUsed = rewritten.llm_used === true;
    if (rewritten.reject_reason) log2(j, "IR 重写产物弃用（" + rewritten.reject_reason + "）——回退规则 IR");
    tmplId = TMPL_REF2VA;
    params = { SEED: seedNum, PROMPT: rewritten.ir, WIDTH: width, HEIGHT: height, LENGTH: length, STEPS: 4, REF_IMAGE_1: names[0], REF_IMAGE_2: names[1], REF_IMAGE_3: names[2] };
  } else {
    const e = new Error("该镜既无分镜首帧也无定妆参考（storyboard/casting 真图缺失）: " + shotId);
    e.code = "NO_REMOTE_INPUT_ART";
    throw e;
  }

  // 渲染（接续路径跳过——mp4Bytes 已领回）
  if (!mp4Bytes) {
    // 内存常驻优先：仅低于阈值才释放（用户纪律 2026-11-21）
    await comfy.ensureFree(base, 8);
    const r = await comfy.runTemplate(ctx, j, {
      base,
      tmplId,
      params,
      pollMs: 3000,
      timeoutMs: 1800000 // GB10 慢档：30 分钟上限
    });
    mp4Bytes = r.bytes;
    rMeta = r.meta;
  }

  const takeId = safeSeg(p.takeId || "tk_" + seed.slice(0, 8));
  const fileName = takeId + ".mp4";
  const meta = {
    kind: "video-comfy-remote", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER, tier: TIER,
    tmpl_id: tmplId, ir_llm_used: irLlmUsed,
    sec, length, shotId, episodeId,
    // 受控链透明化（2026-11-21）：最终下发 IR 提示词＋首帧来源——UI 可展示每镜「怎么被控制」
    prompt: params && params.PROMPT ? String(params.PROMPT) : null,
    shot_camera: prompts.moveZh(move), shot_ambience: ambience, shot_gender: gender0 || null,
    first_frame: sbArt || null,
    prompt_id: rMeta ? rMeta.promptId : (reusedPid || null),
    tmpl_sha16: rMeta ? rMeta.tmpl_sha16 : null, comfy_commit: rMeta ? rMeta.comfy_commit : null, cn_commits: rMeta ? rMeta.cn_commits : null, weights: rMeta ? rMeta.weights : null,
    reused: !!reusedPid,
    bytes: mp4Bytes.length, seed: String(seedNum), cents,
    ai_label: "AI 生成内容（MiniMax H3）" // Community License：UI 显著标注
  };
  const art = "var/out/" + fileName;
  const abs = writeOut(ctx, fileName, mp4Bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  // H3 全家桶原生语音（2026-11-22 配音修复）：IR 带台词 → H3 直接生成「说话＋口型同步」音轨。
  // take 打 native_speech 标记 → compose 见标跳过 TTS 对位（旧链永远叠 TTS＝口型和配音两张皮）。
  const dlgText = String((scr && scr.dialogue) || "").trim();
  const hasDlg = dlgText.length > 0;
  const nativeSpeech = hasDlg ? await probeHasAudio(abs) : false;
  if (nativeSpeech) {
    meta.native_speech = true;
    meta.speech_text = dlgText;
  }
  const take = { id: takeId, engine: ENGINE_USER, cost_cents: cents, art, license: { model: "MiniMax-H3 Community", usage: "attribution" }, best: true,
    native_speech: nativeSpeech, speech_text: nativeSpeech ? dlgText : undefined };
  const bag = { ok: true, cents, art, path: art, meta, take, engine: ENGINE_USER, cost_cents: cents, license: take.license, sec, tier: TIER };
  j.result = bag; j.art = bag;
  return { ok: true, cents, art, meta };
}

/** LTX 帧长约束：8n+1（≥9） */
function frames8n1(sec) {
  const n = Math.max(1, Math.ceil((Number(sec) || 5) * 24));
  let f = 9;
  while (f < n) f += 8;
  return f;
}

/** 多镜串拍（远端）：同场相邻镜一次前向 → 按时间码分段落 take。fast=true＝速度优先（LTX 快速档计价/标签） */
async function runMultishotRemote(ctx, j, p, seed, fast) {
  const ENG = fast ? ENGINE_LTX : ENGINE;
  const ENG_USER = fast ? ENGINE_LTX_USER : ENGINE_USER;
  const TIERX = fast ? TIER_LTX : TIER;
  const BASE5 = fast ? COST_LTX_CENTS : COST_CENTS;
  const LICENSE = fast ? { model: "MIT", usage: "ok" } : { model: "MiniMax-H3 Community", usage: "attribution" };
  const AI_LABEL = fast ? "AI 生成内容" : "AI 生成内容（MiniMax H3）";
  const base = String((typeof ctx.cfg.laneBase === "function" ? ctx.cfg.laneBase(NAME) : (ctx.cfg.comfyRemote && ctx.cfg.comfyRemote.base) || "") || "").replace(/\/+$/, "");
  const episodeId = p.episodeId || j.episodeId || null;
  const st = ctx.store.get();
  const ids = (p.shotIds || []).map(String);
  const shots = Object.keys(st.shots || {}).map((k) => st.shots[k])
    .filter((x) => x && x.episodeId === episodeId && ids.indexOf(x.id) >= 0)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  if (shots.length < 2) throw (() => { const e = new Error("多镜串拍至少需要 2 个有效镜头"); e.code = "MS_GROUP_TOO_SMALL"; return e; })();
  const secs = shots.map((s) => (Number(s.sec) > 0 ? Number(s.sec) : 5));
  const totalSec = secs.reduce((a, b) => a + b, 0);
  if (totalSec > 10) throw (() => { const e = new Error("多镜串拍总时长超上限（≤10s/组）"); e.code = "MS_GROUP_TOO_LONG"; return e; })();
  const sb0 = sbArtForShot(ctx, episodeId, shots[0].id);
  if (!sb0) throw (() => { const e = new Error("组首镜没有可用的分镜首帧: " + shots[0].id); e.code = "NO_REMOTE_INPUT_ART"; return e; })();
  const scr0 = shotScript(ctx, episodeId, shots[0]);
  const width = Number(p.width) > 0 ? Number(p.width) : 768;
  const height = Number(p.height) > 0 ? Number(p.height) : 1344;
  const pkg = prompts.style.resolve(ctx, episodeId);
  // 时间码多镜描述（组内各镜 desc＋台词，身份锚点由首帧＋描述共同承载）
  let acc = 0;
  const promptParts = shots.map((sh, i) => {
    const sc = shotScript(ctx, episodeId, sh);
    const from = acc.toFixed(1);
    acc += secs[i];
    const to = acc.toFixed(1);
    const dlg = sc.dialogue ? "，台词：「" + sc.dialogue + "」" : "";
    return from + "s-" + to + "s：第" + (i + 1) + "镜：" + (sc.desc || sh.name || "") + dlg;
  });
  const PROMPT = promptParts.join("\n") + "\n" + prompts.style.irStyleEn(pkg);
  await comfy.ensureFree(base, 8);
  const ffName = await comfy.uploadAsset(base, sb0.bytes, "t2vr_ms_" + safeSeg(shots[0].id) + "_" + seed.slice(0, 6) + ".png");
  const LENGTH = frames8n1(totalSec);
  const cost = Math.max(BASE5, Math.round(BASE5 * (LENGTH / 121)));
  const r = await comfy.runTemplate(ctx, j, {
    base,
    tmplId: TMPL_MS,
    params: {
      SEED: parseInt(String(seed).slice(0, 8), 16) % 18446744073709551615,
      PROMPT, WIDTH: width, HEIGHT: height, LENGTH,
      FPS: 24,
      STAGE1_W: Math.round(width / 2), STAGE1_H: Math.round(height / 2),
      CFG: 1,
      SIGMAS1: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
      SIGMAS2: "0.85, 0.7250, 0.4219, 0.0",
      IMAGE: ffName
    },
    pollMs: 3000,
    timeoutMs: 1800000
  });
  // 分段落 take（整段 mp4 按 planned 秒比例切）
  const takeId = safeSeg(p.takeId || p.groupId || "ms_" + seed.slice(0, 8));
  const masterName = takeId + "_full.mp4";
  const masterAbs = writeOut(ctx, masterName, r.bytes);
  const segs = [];
  let accT = 0;
  const actualSec = LENGTH / 24;
  const k = actualSec / totalSec;
  for (let i = 0; i < shots.length; i++) {
    const from = accT * k;
    accT += secs[i];
    const to = i === shots.length - 1 ? actualSec + 0.001 : accT * k;
    const seg = path.join(String(ctx.cfg && ctx.cfg.outDir || path.join("var", "out")), safeSeg(takeId + "_s" + i) + ".mp4");
    await runFfmpeg(["-y", "-ss", from.toFixed(3), "-to", to.toFixed(3), "-i", masterAbs,
      "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "2", seg], 300000);
    segs.push(seg);
  }
  const groupId = safeSeg(p.groupId || "ms_" + seed.slice(0, 8));
  const takes = shots.map((sh, i) => ({
    id: takeId + "_s" + i, shotId: sh.id, sec: secs[i],
    art: "var/out/" + path.basename(segs[i]),
    cost_cents: Math.round(cost * secs[i] / totalSec),
    engine: ENG_USER, license: LICENSE,
    best: true,
    native_speech: !!((shotScript(ctx, episodeId, sh) || {}).dialogue),
    multishot_group: { groupId, master: "var/out/" + masterName, seg_index: i, frames: LENGTH }
  }));
  const meta = {
    kind: "video-comfy-multishot", lane: NAME, engine: ENG + " LTX multishot", engine_user: ENG_USER, tier: TIERX,
    tmpl_id: TMPL_MS, group: { groupId, shotIds: shots.map((s) => s.id), secs, frames: LENGTH, master: "var/out/" + masterName },
    prompt_id: r.meta.promptId, tmpl_sha16: r.meta.tmpl_sha16, comfy_commit: r.meta.comfy_commit, cn_commits: r.meta.cn_commits, weights: r.meta.weights,
    sec: Number(actualSec.toFixed(2)), episodeId, prompt: PROMPT.slice(0, 400),
    seed: String(parseInt(String(seed).slice(0, 8), 16)), cents: cost,
    ai_label: AI_LABEL
  };
  const bag = { ok: true, cents: cost, art: takes[0].art, path: takes[0].art, meta, takes, engine: ENG_USER, cost_cents: cost, license: takes[0].license, sec: meta.sec, tier: TIERX, group: meta.group };
  j.result = bag; j.art = bag;
  return { ok: true, cents: cost, art: takes[0].art, meta };
}

/** 转场衔接镜（远端）：A 尾帧（服务端抽取后上传）＋B 首帧 → 桥接段 */
async function runTransitionRemote(ctx, j, p, seed, fast) {
  const ENG = fast ? ENGINE_LTX : ENGINE;
  const ENG_USER = fast ? ENGINE_LTX_USER : ENGINE_USER;
  const TIERX = fast ? TIER_LTX : TIER;
  const BASE5 = fast ? COST_LTX_CENTS : COST_CENTS;
  const LICENSE = fast ? { model: "MIT", usage: "ok" } : { model: "MiniMax-H3 Community", usage: "attribution" };
  const AI_LABEL = fast ? "AI 生成内容" : "AI 生成内容（MiniMax H3）";
  const base = String((typeof ctx.cfg.laneBase === "function" ? ctx.cfg.laneBase(NAME) : (ctx.cfg.comfyRemote && ctx.cfg.comfyRemote.base) || "") || "").replace(/\/+$/, "");
  const episodeId = p.episodeId || j.episodeId || null;
  const st = ctx.store.get();
  const shotA = (st.shots || {})[p.fromShotId] || null;
  const shotB = (st.shots || {})[p.toShotId] || null;
  if (!shotA || !shotB) throw (() => { const e = new Error("转场衔接镜缺少起止镜头"); e.code = "BAD_TRANSITION_PAIR"; return e; })();
  const takesA = (shotA.takes || []).filter((t) => t && t.art);
  const bestA = takesA.filter((t) => t.best).pop() || takesA[takesA.length - 1];
  if (!bestA) throw (() => { const e = new Error("起点镜尚无成片 take: " + shotA.id); e.code = "NO_SOURCE_TAKE"; return e; })();
  const srcA = resolveArtLocal(bestA.art);
  if (!fs.existsSync(srcA)) throw (() => { const e = new Error("起点镜 take 文件缺失: " + srcA); e.code = "TAKE_MISSING"; return e; })();
  const sbB = sbArtForShot(ctx, episodeId, shotB.id);
  if (!sbB) throw (() => { const e = new Error("终点镜没有可用的分镜首帧: " + shotB.id); e.code = "NO_REMOTE_INPUT_ART"; return e; })();
  // A 尾帧抽取（本机 ffmpeg）→ cover 适配镜幅 → 上传
  const tmpDir = path.join(process.cwd(), "var", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const frameTmp = path.join(tmpDir, "trA_" + safeSeg(shotA.id) + "_src.png");
  await runFfmpeg(["-y", "-sseof", "-0.05", "-i", srcA, "-frames:v", "1", "-q:v", "2", frameTmp], 60000);
  const width = Number(p.width) > 0 ? Number(p.width) : 768;
  const height = Number(p.height) > 0 ? Number(p.height) : 1344;
  const frameBytes = fs.readFileSync(frameTmp);
  const fitBytes = await fitFrame(frameBytes, width, height, safeSeg(shotA.id).slice(0, 24));
  const imgA = await comfy.uploadAsset(base, fitBytes, "t2vr_trA_" + safeSeg(shotA.id) + "_" + seed.slice(0, 6) + ".png");
  const imgB = await comfy.uploadAsset(base, sbB.bytes, "t2vr_trB_" + safeSeg(shotB.id) + "_" + seed.slice(0, 6) + ".png");
  const scrA = shotScript(ctx, episodeId, shotA);
  const scrB = shotScript(ctx, episodeId, shotB);
  const pkg = prompts.style.resolve(ctx, episodeId);
  const PROMPT = [
    "Continuous shot: the scene flows naturally from the previous shot into the next, same space, identical lighting and color.",
    "Previous shot ended with: " + (scrA.desc || "").slice(0, 80) + ".",
    "Next shot begins with: " + (scrB.desc || "").slice(0, 80) + ".",
    "Smooth motion transition, no hard cut, no fade."
  ].join(" ") + " " + prompts.style.irStyleEn(pkg);
  const LENGTH = frames8n1(Number(p.sec) > 0 ? Number(p.sec) : 2);
  const cost = Math.max(20, Math.round(BASE5 * (LENGTH / 121)));
  await comfy.ensureFree(base, 8);
  const r = await comfy.runTemplate(ctx, j, {
    base,
    tmplId: TMPL_FLF,
    params: {
      SEED: parseInt(String(seed).slice(0, 8), 16) % 18446744073709551615,
      PROMPT, WIDTH: width, HEIGHT: height, LENGTH,
      FPS: 24,
      STAGE1_W: Math.round(width / 2), STAGE1_H: Math.round(height / 2),
      CFG: 1,
      SIGMAS1: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
      SIGMAS2: "0.85, 0.7250, 0.4219, 0.0",
      IMAGE: imgA,
      REF: imgB
    },
    pollMs: 3000,
    timeoutMs: 1800000
  });
  const takeId = safeSeg(p.takeId || "tr_" + seed.slice(0, 8));
  const fileName = takeId + ".mp4";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "video-comfy-transition", lane: NAME, engine: ENG + " LTX FLF", engine_user: ENG_USER, tier: TIERX,
    tmpl_id: TMPL_FLF, transitionId: p.transitionId || null, fromShotId: shotA.id, toShotId: shotB.id, from_take: bestA.id,
    prompt_id: r.meta.promptId, tmpl_sha16: r.meta.tmpl_sha16, comfy_commit: r.meta.comfy_commit, cn_commits: r.meta.cn_commits, weights: r.meta.weights,
    sec: Number((LENGTH / 24).toFixed(2)), episodeId, prompt: PROMPT.slice(0, 400),
    seed: String(parseInt(String(seed).slice(0, 8), 16)), cents: cost,
    ai_label: AI_LABEL
  };
  const abs = writeOut(ctx, fileName, r.bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const take = { id: takeId, engine: ENG_USER, cost_cents: cost, art, license: LICENSE, best: true, transition: true };
  const bag = { ok: true, cents: cost, art, path: art, meta, take, engine: ENG_USER, cost_cents: cost, license: take.license, sec: meta.sec, tier: TIERX };
  j.result = bag; j.art = bag;
  return { ok: true, cents: cost, art, meta };
}

/** art 虚拟路径 → 物理文件（远端车道用） */
function resolveArtLocal(art) {
  const a = String(art || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const base = path.join(process.cwd(), "var", "out");
  const byBase = path.join(base, path.basename(a));
  if (fs.existsSync(byBase)) return byBase;
  return path.join(process.cwd(), a);
}

/** 远端车道 stub：多镜串拍（分段占位）与转场衔接镜共用 */
function stubMsTrRemote(ctx, j, p, seed, settings, reg) {
  const takeId = safeSeg(p.takeId || p.groupId || (j.type === "transition" ? "tr_" : "ms_") + seed.slice(0, 8));
  const meta = {
    kind: "video-stub", lane: NAME, engine: reg.model || ENGINE, tier: reg.tier || TIER,
    type: j.type, peak_valley: false, takeId,
    shotId: p.shotId || (j.type === "transition" ? p.fromShotId : null) || null,
    episodeId: p.episodeId || j.episodeId || null,
    transitionId: j.type === "transition" ? (p.transitionId || null) : undefined,
    fromShotId: j.type === "transition" ? (p.fromShotId || null) : undefined,
    toShotId: j.type === "transition" ? (p.toShotId || null) : undefined,
    multishot: j.type === "video_ms" || undefined,
    sec: Number(p.sec) > 0 ? Number(p.sec) : (j.type === "transition" ? 2 : 5),
    slow_lane_ms: 0, seed
  };
  const out = [];
  const ids = j.type === "video_ms" ? (p.shotIds || []) : [null];
  const secs = j.type === "video_ms" ? ids.map((_, i) => Number((p.secs || [])[i]) || 5) : [meta.sec];
  ids.forEach((sid, i) => {
    const fn = ids.length > 1 ? takeId + "_s" + i + ".mp4" : takeId + ".mp4";
    const art = "var/out/" + fn;
    writeOut(ctx, fn, MP4_STUB);
    out.push({
      id: takeId + (ids.length > 1 ? "_s" + i : ""), shotId: sid, sec: secs[i], art,
      cost_cents: Math.round(COST_CENTS * secs[i] / secs.reduce((a, b) => a + b, 0)),
      engine: "自部署·高价值档", license: { model: "MiniMax-H3 Community", usage: "attribution" }, best: true,
      transition: j.type === "transition" || undefined
    });
  });
  const cost = Math.max(20, Math.round(COST_CENTS * (secs.reduce((a, b) => a + b, 0) / 5)));
  const bag = { ok: true, cents: cost, art: out[0].art, path: out[0].art, meta, takes: ids.length > 1 ? out : undefined, take: ids.length > 1 ? undefined : out[0], engine: "自部署·高价值档", cost_cents: cost, license: out[0].license, sec: meta.sec, tier: meta.tier, peak_valley: false };
  j.result = bag; j.art = bag;
  return { ok: true, cents: cost, art: bag.art, meta };
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const settings = settingsOf(ctx);
  const reg = (settings.registry || {})[NAME] || {};
  const peakValley = !!settings.peak_valley;
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, payload: p, pv: peakValley });
  const comfyOn = !!(ctx && ctx.cfg && ctx.cfg.comfyRemote && ctx.cfg.comfyRemote.enabled);

  if (comfyOn) {
    if (peakValley) await sleep(150); // 夜间闲时排队慢档（确定性固定延迟）
    // 生成档位→引擎类→注册表登记解析（不绑死模型）：显式 tier 优先，自动档随节点 gen_pref
    const wantClass = wantClassOfJob(ctx, j);
    if (j.type === "video") {
      const ventry = videoEntryFor(ctx, wantClass);
      if (!ventry) throw (() => { const e = new Error("本节点没有登记视频引擎——去运维台「引擎段位」登记（带 class: fast/quality）"); e.code = "NODE_NO_ENGINE"; return e; })();
      if (isLtxEntry(ventry.entry)) return runLtxFastComfy(ctx, j, p, seed, ventry);
      return runRemoteComfy(ctx, j, p, seed, COST_CENTS, settings);
    }
    // 多镜串拍/转场衔接镜目前只有 LTX 族实现（H3 无 multishot/FLF 模板）——固定取快速档登记
    const ltxEntry = videoEntryFor(ctx, "fast");
    if (!ltxEntry || !isLtxEntry(ltxEntry.entry)) {
      throw (() => { const e = new Error("本节点没有登记 LTX 族（快速档）视频引擎——多镜串拍/转场衔接镜依赖它"); e.code = "NODE_NO_ENGINE"; return e; })();
    }
    if (j.type === "video_ms") return runMultishotRemote(ctx, j, p, seed, wantClass === "fast");
    if (j.type === "transition") return runTransitionRemote(ctx, j, p, seed, wantClass === "fast");
    return runRemoteComfy(ctx, j, p, seed, COST_CENTS, settings);
  }
  if (j.type === "video_ms" || j.type === "transition") {
    return stubMsTrRemote(ctx, j, p, seed, settings, reg);
  }

  // —— stub 模式（验收套件）——
  if (peakValley) await sleep(150);
  const takeId = safeSeg(p.takeId || p.take || "tk_" + seed.slice(0, 8));
  const fileName = takeId + ".mp4";
  const art = "var/out/" + fileName;
  const sec = Number(p.sec) > 0 ? Number(p.sec) : 5;
  const engine = reg.model || ENGINE;
  const tier = reg.tier || TIER;
  const meta = {
    kind: "video-stub",
    lane: NAME,
    engine,
    tier,
    sec,
    peak_valley: peakValley,
    takeId,
    shotId: p.shotId || null,
    episodeId: p.episodeId || j.episodeId || null,
    slow_lane_ms: peakValley ? 150 : 0,
    seed
  };
  const abs = writeOut(ctx, fileName, MP4_STUB);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;

  const take = {
    id: takeId,
    // 语言表纪律：用户面 take 不带型号（真机型在 meta/sidecar 与 job 账本，内部豁免面可查）
    engine: "自部署·高价值档",
    cost_cents: COST_CENTS,
    art,
    license: { model: "MIT", usage: "ok" }
  };
  const bag = { ok: true, cents: COST_CENTS, art, path: art, meta, take, engine, cost_cents: COST_CENTS, license: take.license, sec, tier, peak_valley: peakValley };
  j.result = bag;
  j.art = bag;
  return { ok: true, cents: COST_CENTS, art, meta };
}

module.exports = { name: NAME, lane: NAME, run };
