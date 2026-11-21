"use strict";
/**
 * workers/scriptgen.js — 一句话/小说 → 结构化剧本（2026-11-21，补全「一句话成片」缺口）
 *
 * 缺口背景：POST /api/episodes 一直接受 kind:"one_liner"|"novel"，但没有「一句话→结构化剧本」
 * 的生成环节——无剧本的集，C1 卡落到 DEFAULT_SCENES 占位。本 worker 用本机 LLM（llm-gw）
 * 把 brief 展开成 script{scenes,cast}（可选按题材节拍模板的 beats 展开），写回 ep.script 后
 * 由 cards.js 的 jobs-done 监听直接产 C1 卡（海报 c1plan 降级为可选增强，见 cards.js case "scriptgen"）。
 *
 * 纪律：
 *   - fail-open：LLM 离线/超时/输出不可解析 → 工内重试一次，仍失败则 script=null（流程绝不卡死，
 *     C1 落占位结构，C1 驳回会重派 scriptgen，见 cards.js reEnqueueOnReject）。
 *   - 真实模型（Huihui35B）JSON 服从性实测偏弱（2026-11-21 全链路冒烟发现）：键名漂移、场名缺失、
 *     镜头 cast 空缺——本 worker 做别名容错解析＋场名从画面描述兜底＋单角色回填，重试时收紧指令。
 *   - 输出钳制与 POST /api/episodes 的 script 校验同构（scenes/shots/cast 字段与长度上限一致）。
 *   - 纯 LLM 车道（lane scriptgen）：不占显存、不进 LOCAL_GPU_TYPES、free:true（影子成本 0）。
 *   - 禁随机（确定性纪律不适用于模型输出本身；本 worker 不引入额外随机源）。
 */

const NAME = "scriptgen";
const LANE = "scriptgen";

/* 钳制上限（对齐 api/episodes.js POST /api/episodes 的 script 校验口径） */
const MAX_SCENES = 5;
const MAX_SHOTS = 5;
const MAX_CAST = 5;

function clampStr(v, n) {
  return String(v == null ? "" : v).trim().slice(0, n);
}
/* 别名容错取值：真实模型常漂移键名（name/scene/title…），按序取第一个非空 */
function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}
/* cast 字段形态容错：["李算"] / [{role:"李算"}] / "李算,掌柜" → 角色名数组 */
function castNames(v, roles) {
  let arr = [];
  if (Array.isArray(v)) {
    arr = v.map((x) => (typeof x === "string" ? x : pick(x, ["role", "name", "character", "角色"]) || "")).map((s) => String(s).trim());
  } else if (typeof v === "string") {
    arr = v.split(/[，,、\/]/).map((s) => s.trim());
  }
  return arr.filter((x) => x && roles.indexOf(x) >= 0).slice(0, 3);
}

/* LLM JSON → script（同 episodes.js 口径，含别名容错与兜底）；结构不合格返回 null */
function toScript(j) {
  if (!j || typeof j !== "object") return null;
  const scenesIn = Array.isArray(j.scenes) ? j.scenes : (Array.isArray(j.storyboard) ? j.storyboard : []);
  if (!scenesIn.length) return null;
  const castIn = (Array.isArray(j.cast) ? j.cast : (Array.isArray(j.characters) ? j.characters : [])).slice(0, MAX_CAST);
  const cast = castIn.map((c) => ({
    role: clampStr(pick(c, ["role", "name", "character", "角色", "角色名"]) || "角色", 30) || "角色",
    name: clampStr(pick(c, ["name", "actor", "演员"]), 30),
    desc: clampStr(pick(c, ["desc", "description", "appearance", "外貌", "设定", "描述"]), 400)
  }));
  const roles = cast.map((c) => c.role);
  const scenes = scenesIn.slice(0, MAX_SCENES).map((sc, si) => {
    const shotsIn = Array.isArray(sc && (sc.shots || sc.镜头 || sc.shotList)) ? (sc.shots || sc.镜头 || sc.shotList) : [];
    const shots = shotsIn.slice(0, MAX_SHOTS).map((sh) => {
      let castShot = castNames(pick(sh, ["cast", "characters", "roles", "角色"]), roles);
      if (!castShot.length && roles.length === 1) castShot = [roles[0]]; // 独角剧回填
      return {
        desc: clampStr(pick(sh, ["desc", "description", "visual", "画面", "描述"]), 300),
        sec: Number(pick(sh, ["sec", "duration", "时长", "seconds"])) > 0
          ? Math.min(15, Math.max(3, Math.round(Number(pick(sh, ["sec", "duration", "时长", "seconds"])))))
          : 5,
        cast: castShot,
        dialogue: clampStr(pick(sh, ["dialogue", "line", "台词", "对白"]), 200),
        tier: pick(sh, ["tier"]) === "high" ? "high" : undefined
      };
    });
    if (!shots.length) return null;
    // 场名兜底：模型常缺 name → 取首镜画面描述前 12 字，再不行按序号
    const name = clampStr(pick(sc, ["name", "scene", "title", "场", "场景"]), 40)
      || clampStr(shots[0].desc, 12)
      || "第" + (si + 1) + "场";
    return {
      name,
      mood: clampStr(pick(sc, ["mood", "atmosphere", "情绪", "氛围"]), 20) || "中性",
      shots
    };
  }).filter(Boolean);
  if (!scenes.length) return null;
  return { scenes, cast };
}

function beatsBlock(tpl) {
  if (!tpl || !Array.isArray(tpl.beats) || !tpl.beats.length) return "";
  const lines = tpl.beats
    .map((b, i) => `${i + 1}. ${b.beat}${b.guide ? "：" + b.guide : ""}`)
    .join("\n");
  return `\n题材节拍（${tpl.genre || "通用"}）——剧情按此节拍展开：\n${lines}`;
}

function buildSys(tpl) {
  return [
    "你是剧场 Studio 的短剧编剧。把输入的故事想法扩写成一集竖屏短剧的分场分镜剧本，只输出一个 JSON 对象。",
    "JSON 字段（键名必须一字不差）：",
    `{"title":"片名(≤16字)","scenes":[{"name":"场名(2-10字)","mood":"氛围(2-6字)","shots":[{"desc":"画面描述","sec":5,"cast":["角色名"],"dialogue":"台词"}]}],"cast":[{"role":"角色名","name":"演员名","desc":"外貌设定"}]}`,
    "硬约束：",
    `1. scenes 3–${MAX_SCENES} 场，每场 shots 2–${MAX_SHOTS} 镜，全片总时长 60–100 秒。`,
    "2. 每个 shot：desc 是文生图画面描述（人物动作/表情/机位/光线，40–80 字）；sec 是 3–15 整数；cast 填该镜出场角色名（必须与 cast.role 一致，空镜才留空数组）；dialogue 是该镜台词（≤40 字，无台词用空字符串）。关键情绪镜 tier 填 \"high\"（最多 2 镜）。",
    "3. cast 数组 2–4 人：role 是剧中称呼；desc 是定妆画像——年龄、性别、发型、服装、气质（40–80 字，跨镜稳定）。",
    "4. 不要输出解释文字、不要 markdown 代码块、不要在 JSON 前后加任何内容。",
    beatsBlock(tpl),
    tpl && tpl.style && tpl.style.look ? `影调风格：${tpl.style.look}。desc 与 mood 与此风格一致。` : ""
  ].filter(Boolean).join("\n");
}

function buildUsr(p, brief, kind, tpl) {
  const srcText = kind === "novel"
    ? `以下是一段小说/故事文本，从中提炼改编出一集短剧剧本（可只取最戏剧化的主线）：\n${brief.slice(0, 3000)}`
    : `一句话/一段话的想法：\n${brief.slice(0, 500)}`;
  return `${srcText}\n剧名（可用它起片名）：${clampStr(p.title, 40)}`;
}

/* 结果必须挂到 job 上（与 img5060 bag() 同纪律）：bus 广播与 cards.js 只读 job.result/job.art */
function attach(job, bag) {
  job.result = bag;
  job.art = bag;
  return bag;
}

function parseScript(content) {
  const m = String(content || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return toScript(JSON.parse(m[0])); } catch (e) { return null; }
}

async function generate(ctx, job, sys, usr) {
  const tpl = job.payload && job.payload.template;
  const r = await ctx.llm.chat(
    [{ role: "system", content: sys }, { role: "user", content: usr }],
    { temperature: 0.5, maxTokens: 3000, timeoutMs: 90000 }
  );
  if (!r || !r.ok) {
    return { script: null, note: "LLM 未给出结果（" + ((r && r.error) || "超时") + "）——先用占位结构，可驳回方向卡重出" };
  }
  let script = parseScript(r.content);
  if (script) {
    return {
      script,
      title_suggest: clampStr(parseTitle(r.content), 16) || null,
      note: tplNote(tpl, script)
    };
  }
  /* 工内重试一次：真实模型首出常带解释文字/键名漂移——收紧指令再要一版 */
  const r2 = await ctx.llm.chat(
    [
      { role: "system", content: sys },
      { role: "user", content: usr },
      { role: "assistant", content: String(r.content || "").slice(0, 500) },
      { role: "user", content: "上一次输出无法解析。只输出一个 JSON 对象：{\"title\":…,\"scenes\":[…],\"cast\":[…]}，键名一字不差，不要任何其他文字或代码块。" }
    ],
    { temperature: 0.3, maxTokens: 3000, timeoutMs: 90000 }
  );
  script = r2 && r2.ok ? parseScript(r2.content) : null;
  if (script) {
    return { script, title_suggest: clampStr(parseTitle(r2.content), 16) || null, note: tplNote(tpl, script) };
  }
  return { script: null, note: "LLM 输出两次都无法解析为剧本 JSON——先用占位结构，可驳回方向卡重出" };
}

function parseTitle(content) {
  try {
    const j = JSON.parse(String(content || "").match(/\{[\s\S]*\}/)[0]);
    return j.title;
  } catch (e) { return null; }
}
function tplNote(tpl, script) {
  const n = script ? script.scenes.length : 0;
  return tpl ? `按「${tpl.genre || "通用"}」节拍生成 ${n} 场剧本` : `生成 ${n} 场剧本`;
}

async function run(job, ctx) {
  const p = job.payload || {};
  const brief = clampStr(p.brief, 20000);
  const kind = p.kind === "novel" ? "novel" : "one_liner";
  const tpl = p.template && typeof p.template === "object" ? p.template : null;

  /* fail-open 前提检查：LLM 通道不可用 → 占位结构兜底，流程继续 */
  const enabled = ctx.llm && typeof ctx.llm.enabled === "function" ? ctx.llm.enabled() : false;
  if (!enabled || !brief) {
    return attach(job, {
      script: null,
      note: !brief ? "brief 为空，无法生成剧本" : "LLM 未在线（llm-gw 未起或未配置）——先用占位结构，方向卡上可改或驳回重出"
    });
  }

  try {
    const bag = await generate(ctx, job, buildSys(tpl), buildUsr(p, brief, kind));
    return attach(job, bag);
  } catch (e) {
    return attach(job, {
      script: null,
      note: "剧本生成异常（" + ((e && e.message) || "未知") + "）——先用占位结构，可驳回方向卡重出"
    });
  }
}

module.exports = { name: NAME, lane: LANE, run };
