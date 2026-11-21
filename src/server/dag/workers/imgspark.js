"use strict";
/**
 * workers/imgspark.js — 生图·DGX Spark（MiniMax-H3-Image int8_convrot · ComfyUI :8188）
 * 双模式（ADR-001 + 2026-11-21 裁决）：
 *  - spark-comfy 模式（cfg.comfySpark.enabled）：h3-image-cast 固化模板（6 步 euler，16 参考图模型）
 *      casting  → 角色定妆（剧本 cast[castIdx] 人设 + refImage 参考）
 *      注意：lane 默认映射不动（c1plan/storyboard/storyboard_char 仍 img5060），
 *      本 worker 仅承接 casting 类任务，走 admin registry engineId 可选切换。
 *  - stub 模式（默认，验收套件）：确定性占位 PNG（meta kind:image-stub，绝不冒充真图）。
 * 用户面引擎标签一律「自部署·高价值档」；型号细节只进 meta/sidecar（豁免面）。
 */
const fs = require("fs");
const path = require("path");
const comfy = require("../adapters/comfy.js");

const NAME = "imgspark";
const ENGINE = "MiniMax-H3-Image int8_convrot 6step";
const ENGINE_USER = "自部署·高价值档";
const COST_CENTS = 20;
const TMPL_CAST = "h3-image-cast";
const TMPL_EDIT = "h3-image-edit";
const TMPL_FL2VA = "h3-fl2va-video";
const STYLE_SUFFIX = "实拍电影剧照质感，真实摄影，自然皮肤纹理与真实光影，浅景深";
// 试妆试镜视频规格：与原图 720×1280 等比例最近的 32 倍数画幅（736×1312，比例误差 0.27%）；
// 5 秒＝124 帧（17k+5 网格），turbo 4 步。
const ST_W = 736, ST_H = 1312, ST_LEN = 124, ST_STEPS = 4, ST_SEC = 5.17;
// 试妆试镜动作设计：左右 3/4 侧脸＋仰头闭眼——覆盖床上唱歌分镜所需头部角度；
// 面部/发型/服装全程锁定。用户重出意见（p.note）追加在尾部。
const SCREEN_TEST_PROMPT = [
  "Beauty screen test, one continuous static shot, no camera movement.",
  "She faces the camera, then slowly turns her head into a three-quarter profile and holds,",
  "returns to front, then slowly turns into the other three-quarter profile and holds,",
  "then gently tilts her head up and closes her eyes for a moment,",
  "then opens her eyes and looks back at the camera with a soft natural smile.",
  "Keep her face, facial features, hairstyle and outfit exactly consistent throughout.",
  "Warm soft key light, subtle hair movement, natural skin texture, shallow depth of field.",
  "No dialogue."
].join(" ");
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

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
function numFrom(hex) {
  return parseInt(String(hex).slice(0, 8), 16) >>> 0;
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
function settingsOf(ctx) {
  try {
    const st = ctx && ctx.store && typeof ctx.store.get === "function" ? ctx.store.get() || {} : {};
    return st.settings || {};
  } catch (e) {
    return {};
  }
}
/** 定妆角色定义（同 img5060.castOf 语义：剧本 cast[] 按 castIdx） */
function castOf(ctx, episodeId) {
  try {
    const st = ctx.store.get();
    const ep = st.episodes && st.episodes[episodeId];
    const cast = (ep && ep.script && ep.script.cast) || [];
    return cast.map((c) => ({ role: c.role, name: c.name, desc: c.desc, refImage: c.refImage || null }));
  } catch (e) {
    return [];
  }
}
function readRefBytes(ctx, refImage) {
  if (!refImage) return null;
  try {
    const name = safeSeg(String(refImage).replace(/^.*[\\/]/, ""));
    // 剧本 refImage 位于 var/assets/cast（img5060.ensureInComfyInput 同源）；候选产物在 var/out
    const candidates = [
      path.join(process.cwd(), "var", "assets", "cast", name),
      path.join(String(ctx.cfg && ctx.cfg.outDir || path.join("var", "out")), name)
    ];
    for (const p of candidates) if (fs.existsSync(p)) return fs.readFileSync(p);
  } catch (e) { /* fallthrough */ }
  return null;
}

/** ffmpeg 助手（runtime/bin/ffmpeg.exe，essentials 版无 ffprobe）；spawn 数组传参不走 shell */
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.cwd(), "runtime", "bin", "ffmpeg.exe");
    if (!fs.existsSync(exe)) return reject(Object.assign(new Error("ffmpeg 不存在（runtime/bin）"), { code: "NO_FFMPEG" }));
    const pr = require("child_process").spawn(exe, args, { windowsHide: true });
    let err = "";
    pr.stderr.on("data", (c) => { if (err.length < 4000) err += String(c); });
    pr.on("close", (code) => code === 0 ? resolve(true) : reject(Object.assign(new Error("ffmpeg 失败：" + err.slice(-300)), { code: "FFMPEG_FAIL" })));
    pr.on("error", (e) => reject(Object.assign(new Error("ffmpeg 启动失败：" + e.message), { code: "FFMPEG_SPAWN" })));
    setTimeout(() => { try { pr.kill(); } catch (e) {} reject(Object.assign(new Error("ffmpeg 超时"), { code: "FFMPEG_TIMEOUT" })); }, timeoutMs || 120000).unref();
  });
}

const CAST_DIR = path.join(process.cwd(), "var", "assets", "cast");
function castAssetPath(rel) {
  // rel 可为 var/out/xxx、var/assets/cast/xxx 或裸文件名 → 绝对路径；仅允许仓库内两处白名单目录
  const name = safeSeg(String(rel || "").replace(/^.*[\\/]/, ""));
  const cands = [path.join(CAST_DIR, name), path.join(process.cwd(), "var", "out", name)];
  for (const p of cands) if (fs.existsSync(p)) return p;
  return null;
}

/** facegate 门控调用（127.0.0.1:8195）：原照片脸换回 + ArcFace 打分 */
async function faceGateSwap(pngBytes) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch("http://127.0.0.1:8195/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dst_b64: pngBytes.toString("base64") }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const d = await res.json().catch(() => ({}));
    if (d && d.png_b64) return { png: Buffer.from(d.png_b64, "base64"), score: Number(d.score) || 0 };
    throw Object.assign(new Error((d.detail && (d.detail.message || d.detail.code)) || ("facegate HTTP " + res.status)), { code: "FACEGATE_ERR" });
  } catch (e) {
    clearTimeout(t);
    if (e.code === "FACEGATE_ERR") throw e;
    throw Object.assign(new Error("facegate 不可达: " + e.message), { code: "FACEGATE_UNREACHABLE" });
  }
}

/** 角色分镜全套 H3：逐镜 H3-Image edit（输入=用户原图，img2img 身份像素级保真）+ facegate 门控，竖屏 */
function pngSize(bytes) {
  if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return { w: 768, h: 1344 };
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}
function r16(x) { return Math.max(256, Math.floor(x / 16) * 16); }
async function faceGateScore(pngBytes) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch("http://127.0.0.1:8195/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ img_b64: pngBytes.toString("base64") }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const d = await res.json().catch(() => ({}));
    return {
      score: (d && d.score) != null ? Number(d.score) : 0,
      yaw: (d && d.yaw != null) ? Number(d.yaw) : null,
      pitch: (d && d.pitch != null) ? Number(d.pitch) : null
    };
  } catch (e) {
    clearTimeout(t);
    return { score: 0, yaw: null, pitch: null };
  }
}

/** 姿态标签（facegate yaw/pitch 粗估）：观众视角 left=左侧脸 */
function angleTag(yaw, pitch) {
  const y = Number(yaw) || 0;
  const pp = Number(pitch) || 0;
  if (pp < -0.05) return "down"; // 低头（眼口纵向距压缩）
  if (pp > 0.05) return "up";    // 仰头
  if (y <= -0.2) return "left";
  if (y >= 0.2) return "right";
  return "front";
}

/** 分镜角度需求解析（desc/anchor 关键词 → 参考帧角度） */
function shotAngleNeed(desc) {
  const s = String(desc || "");
  if (/仰头|抬头|仰望|仰视|仰面/.test(s)) return "up";
  if (/低头|垂眸|俯首|低眉/.test(s)) return "down";
  if (/左侧脸|左脸|向左|左回眸|画面左/.test(s)) return "left";
  if (/右侧脸|右脸|向右|右回眸|画面右/.test(s)) return "right";
  return "front";
}

/** 从试妆抽帧参考里挑本镜输入：精确角度 → 正面 → 最高分兜底 */
function pickView(views, need) {
  const ok = (views || []).filter((v) => v && v.art && (v.score == null || v.score >= 0.6));
  if (!ok.length) return null;
  const by = (tag) => ok.filter((v) => v.angle === tag).sort((a, b) => (b.score || 0) - (a.score || 0));
  return by(need)[0] || by("front")[0] || ok.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
}
async function runSparkCharShots(ctx, job, p, seed, cents) {
  const j = job || {};
  const base = String(ctx.cfg.comfySpark.base || "http://100.81.83.59:8188").replace(/\/+$/, "");
  const st0 = ctx.store.get();
  const ep = st0.episodes && st0.episodes[p.episodeId];
  const script = (ep && ep.script) || { scenes: [], cast: [] };
  const cast = script.cast || [];
  const shots = [];
  (script.scenes || []).forEach((sc) => (sc.shots || []).forEach((sh) => shots.push(Object.assign({ scene: sc.name }, sh))));
  const castDef0 = cast.find((x) => x.refImage) || cast[0] || {};
  const nameOrig = castDef0.refImage ? safeSeg(String(castDef0.refImage).replace(/^.*[\\/]/, "")) : null;
  const refPath = [
    nameOrig ? path.join(process.cwd(), "var", "assets", "cast", nameOrig) : null,
    path.join(process.cwd(), "var", "assets", "cast", "liangchen.png")
  ].filter(Boolean).find((p2) => fs.existsSync(p2));
  if (!refPath) throw Object.assign(new Error("定妆原图缺失（var/assets/cast）"), { code: "CAST_FILE_MISSING" });
  const refBytes = fs.readFileSync(refPath);
  const dim = pngSize(refBytes);
  const editW = r16(dim.w), editH = r16(dim.h);
  const refNameU = await comfy.uploadAsset(base, refBytes, "h3edit_ref_" + seed.slice(0, 6) + ".png");
  const images = [];
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i];
    if (!(sh.cast || []).length) continue; // 空镜不在本 worker 范围
    const refName = sh.cast[0];
    const castDef = cast.find((x) => x.role === refName || x.name === refName) || {};
    const cleanDesc = String(sh.desc || "").replace(/。人物锚点：[\s\S]*$/, "");
    const prompt = [
      "编辑 <Picture 1>：保持同一位人物完全不变——脸、五官、发型、香槟色缎面吊带睡裙都与参考图一致。",
      "新的镜头：" + cleanDesc + "。",
      "单幅剧照（single frame）：整个画面只有一个镜头时刻，禁止分屏、多格拼贴。",
      "烛光卧室、白床品、暖调，实拍电影剧照质感，真实摄影，浅景深"
    ].filter(Boolean).join(" ");
    await comfy.ensureFree(base, 8);
    let pngBytes = null, gateScore = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await comfy.runTemplate(ctx, j, {
        base,
        tmplId: TMPL_EDIT,
        params: {
          SEED: (numFrom(hash12(ctx, { jobId: j.id, i, attempt, shot: sh.desc })) + attempt * 7919) % 18446744073709551615,
          PROMPT: prompt,
          IMAGE: refNameU,
          WIDTH: editW, HEIGHT: editH
        },
        pollMs: 1500,
        timeoutMs: 300000
      });
      const sc = await faceGateScore(r.bytes);
      let best = { png: r.bytes, score: sc.score || 0 };
      if (best.score < 0.6) {
        try { const sw = await faceGateSwap(r.bytes); if (sw.score > best.score) best = sw; } catch (e) { log2(j, "swap fallback fail: " + e.message); }
      }
      log2(j, "shot " + (i + 1) + " attempt" + attempt + " gate=" + best.score);
      if (best.score > gateScore) { gateScore = best.score; pngBytes = best.png; }
      if (gateScore >= 0.6) break;
    }
    if (gateScore < 0.6) throw Object.assign(new Error("分镜身份门控未过（ArcFace " + gateScore.toFixed(3) + " < 0.6）: " + refName + " 镜" + (i + 1)), { code: "IDENTITY_GATE_FAIL" });
    const fn = safeSeg(j.id) + "_h3char" + (i + 1) + ".png";
    const artPath = "var/out/" + fn;
    writeOut(ctx, fn, pngBytes);
    images.push({ shotId: null, seq: i + 1, art: artPath, bytes: pngBytes.length, gate: gateScore });
    log2(j, "shot " + (i + 1) + "/" + shots.length + " done (H3-Edit+gate " + gateScore + ")");
  }
  const metaC = { kind: "image-comfy-spark-char", lane: NAME, engine: ENGINE + " edit", engine_user: ENGINE_USER, jobType: "storyboard_char", episodeId: p.episodeId, tmpl_id: TMPL_EDIT, images, cents, ai_label: "AI 生成内容（MiniMax H3-Image edit）" };
  const bagC = { ok: true, cents, art: images.length ? images[0].art : null, meta: metaC, engine: ENGINE_USER, images };
  j.result = bagC; j.art = bagC;
  return bagC;
}

/** C1 策划：封面海报（H3-Image t2i）＋剧本 plan（场景=剧本源头） */
async function runSparkC1Plan(ctx, job, p, seed, cents) {
  const j = job || {};
  const base = String(ctx.cfg.comfySpark.base || "http://100.81.83.59:8188").replace(/\/+$/, "");
  const st0 = ctx.store.get();
  const ep = st0.episodes && st0.episodes[p.episodeId];
  const script = (ep && ep.script) || { scenes: [], cast: [] };
  const brief = (ep && ep.brief) || p.brief || "";
  await comfy.ensureFree(base, 8);
  const r = await comfy.runTemplate(ctx, j, {
    base,
    tmplId: TMPL_CAST,
    params: {
      SEED: numFrom(seed) % 18446744073709551615,
      PROMPT: [brief, "主视觉海报，竖屏，电影感", STYLE_SUFFIX].filter(Boolean).join(" "),
      WIDTH: 768, HEIGHT: 1344,
      REF_IMAGE_1: "cast___.png", REF_IMAGE_2: "cast___.png", REF_IMAGE_3: "cast___.png"
    },
    transform: (wf) => { // 纯 t2i：去掉参考图节点与 images 条件
      ["4", "5", "6"].forEach((id) => delete wf[id]);
      const c = wf["7"];
      if (c && c.inputs && c.inputs.images !== undefined) c.inputs.images = [];
    },
    pollMs: 1500,
    timeoutMs: 300000
  });
  const fn = safeSeg(j.id) + "_poster.png";
  const art = "var/out/" + fn;
  const abs = writeOut(ctx, fn, r.bytes);
  const meta = {
    kind: "image-comfy-spark", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    tmpl_id: TMPL_CAST, tmpl_sha16: r.meta.tmpl_sha16, prompt_id: r.promptId,
    bytes: r.bytes.length, seed: String(numFrom(seed) % 18446744073709551615), cents,
    ai_label: "AI 生成内容（MiniMax H3-Image）"
  };
  writeOut(ctx, fn + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const bag = { ok: true, cents, art, path: art, meta, engine: ENGINE_USER };
  j.result = bag; j.art = bag;
  const res = { ok: true, cents, art, meta };
  if (script.scenes && script.scenes.length) {
    res.plan = { summary: brief, scenes: script.scenes.map((sc) => ({ name: sc.name, mood: sc.mood, shots: sc.shots })) };
  }
  return res;
}
function log2(job, msg) { try { console.log("[imgspark " + String(job.id || "").slice(4, 10) + "] " + msg); } catch (e) {} }

async function runSparkComfy(ctx, job, p, seed, cents) {
  const j = job || {};
  const base = String(ctx.cfg.comfySpark.base || "http://100.81.83.59:8188").replace(/\/+$/, "");
  const cast = castOf(ctx, p.episodeId);
  const actor = cast[p.castIdx] || { desc: p.prompt || "", refImage: null, role: "", name: "" };
  const prompt = [actor.name, actor.role, actor.desc, "定妆照", "Use <Picture 1> as identity reference; keep facial identity consistent.", STYLE_SUFFIX].filter(Boolean).join(" ");

  const names = [];
  const refBytes = readRefBytes(ctx, actor.refImage);
  if (refBytes) {
    names.push(await comfy.uploadAsset(base, refBytes, "sparkimg_ref_" + safeSeg(actor.role) + "_" + seed.slice(0, 6) + ".png"));
  }
  while (names.length < 3) names.push(names[0] || "female_ref.png");

  // 内存常驻优先：仅低于阈值才释放（用户纪律 2026-11-21）
  await comfy.ensureFree(base, 8);
  const r = await comfy.runTemplate(ctx, j, {
    base,
    tmplId: TMPL_CAST,
    params: {
      SEED: numFrom(seed) % 18446744073709551615,
      PROMPT: prompt,
      WIDTH: 1024, HEIGHT: 1024,
      REF_IMAGE_1: names[0], REF_IMAGE_2: names[1], REF_IMAGE_3: names[2]
    },
    pollMs: 1500,
    timeoutMs: 600000
  });

  const idSeg = safeSeg(j.id || "imgspk_" + seed.slice(0, 8));
  const fileName = idSeg + "_cast.png";
  const meta = {
    kind: "image-comfy-spark", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    tmpl_id: TMPL_CAST, tmpl_sha16: r.meta.tmpl_sha16, comfy_commit: r.meta.comfy_commit, cn_commits: r.meta.cn_commits,
    weights: r.meta.weights, prompt_id: r.promptId, bytes: r.bytes.length,
    castIdx: p.castIdx, actorRole: actor.role, seed: String(numFrom(seed) % 18446744073709551615), cents,
    ai_label: "AI 生成内容（MiniMax H3-Image）" // Community License：UI 显著标注
  };
  const art = "var/out/" + fileName;
  const abs = writeOut(ctx, fileName, r.bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const take = { id: idSeg, engine: ENGINE_USER, cost_cents: cents, art, license: { model: "MiniMax-H3-Image Community", usage: "attribution" } };
  const bag = { ok: true, cents, art, path: art, meta, take, engine: ENGINE_USER, cost_cents: cents, license: take.license };
  j.result = bag; j.art = bag;
  const res = { ok: true, cents, art, meta };
  res.actor = { idx: p.castIdx, role: actor.role, name: actor.name };
  return res;
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const settings = settingsOf(ctx);
  const reg = (settings.registry || {})[NAME] || {};
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, type: j.type, payload: p });
  const comfyOn = !!(ctx && ctx.cfg && ctx.cfg.comfySpark && ctx.cfg.comfySpark.enabled);
  const cents = comfyOn ? COST_CENTS : 15 + (numFrom(seed) % 11); // stub 15–25 分，真跑 20 分

  if (comfyOn && j.type === "casting") return runSparkComfy(ctx, j, p, seed, cents);
  if (comfyOn && j.type === "storyboard_char") return runSparkCharShots(ctx, j, p, seed, cents);
  if (comfyOn && j.type === "c1plan") return runSparkC1Plan(ctx, j, p, seed, cents);

  // —— stub 模式（验收套件 / 非 casting 类型）——
  const idSeg = safeSeg(j.id || "imgspk_" + seed.slice(0, 8));
  const fileName = idSeg + ".png";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "image-stub",
    lane: NAME,
    engine: reg.model || ENGINE,
    jobType: j.type || null,
    episodeId: p.episodeId || j.episodeId || null,
    seed,
    tmpl_hash: "h_" + seed.slice(8, 20),
    comfy_commit: "c" + seed.slice(0, 7),
    cn_commit: "c" + seed.slice(4, 11),
    weights: "MXFP8+FP8",
    cents
  };
  const abs = writeOut(ctx, fileName, PNG_1x1);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;

  const bag = { ok: true, cents, art, meta, engine: reg.model || ENGINE, path: art };
  j.result = bag;
  j.art = bag;
  return { ok: true, cents, art, meta };
}

module.exports = { name: NAME, lane: NAME, run };
