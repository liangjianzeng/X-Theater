"use strict";
/**
 * workers/img5060.js — 生图·5060 Ti（qwen-image-2.1-turbo-Q5_K_M · W-B 无头 ComfyUI :8188）
 * 双模式（ADR-001）：
 *  - comfy 模式（cfg.comfy.enabled）：经 adapters/comfy 固化模板真出图（四元组校验+显存纪律+真错误上抛）；
 *  - stub 模式（默认，验收套件/无实位时）：确定性占位 PNG——meta 标注 kind:image-stub，绝不冒充真图。
 * 用户面引擎标签一律「自部署·标准档」（语言表纪律）；型号细节只进 meta/sidecar（豁免面）。
 */
const fs = require("fs");
const path = require("path");
const comfy = require("../adapters/comfy.js");

const NAME = "img5060";
const ENGINE = "qwen-image-2.1-turbo-Q5_K_M";
const ENGINE_USER = "自部署·标准档";
const WEIGHTS = "Q5_K_M";
const TMPL_ID = "qwen-image-turbo";
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
function sub(hex, start, len) {
  const h = String(hex || "0");
  const reps = Math.ceil((start + len) / h.length) + 1;
  return h.repeat(reps).slice(start, start + len);
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

/** 从 store 推导确定性提示词（集 brief＋场名/情绪；job 无 prompt 字段时兜底） */
function buildPrompt(ctx, p) {
  let brief = "";
  let sceneName = "";
  let mood = "";
  try {
    const st = ctx.store.get();
    const ep = st.episodes && (st.episodes[p.episodeId] || Object.values(st.episodes).find((e) => e.id === p.episodeId));
    brief = (ep && (ep.brief || ep.title)) || "";
    const sc = p.sceneId && st.scenes && st.scenes[p.sceneId];
    sceneName = (sc && sc.name) || "";
    mood = (sc && sc.mood) || "";
  } catch (e) { /* store 缺席时走通用词 */ }
  return [brief, sceneName, mood && mood + " 情绪", "电影感构图，青橙夜色调，胶片质感"]
    .filter(Boolean).join(" · ") || "夜航灯塔，电影感构图，青橙夜色调";
}

async function runComfy(ctx, job, p, seed, cents) {
  const j = job || {};
  const r = await comfy.runTemplate(ctx, j, {
    tmplId: TMPL_ID,
    params: {
      SEED: numFrom(seed) % 4294967295,
      PROMPT: buildPrompt(ctx, p),
      NEGATIVE: "低质量，模糊，变形，水印，文字",
      WIDTH: 1024,
      HEIGHT: 1024,
      STEPS: 8, // turbo 蒸馏档：8 步 CFG1.0（16G 显存纪律内）
      CFG: 1.0
    },
    timeoutMs: 300000
  });
  const idSeg = safeSeg(j.id || "img_" + seed.slice(0, 8));
  const fileName = idSeg + ".png";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "image-comfy",
    lane: NAME,
    engine: ENGINE, // 豁免面：meta/sidecar 可带型号
    engine_user: ENGINE_USER,
    jobType: j.type || null,
    episodeId: p.episodeId || j.episodeId || null,
    seed: String(numFrom(seed) % 4294967295),
    tmpl_id: TMPL_ID,
    tmpl_sha16: r.meta.tmpl_sha16,
    comfy_commit: r.meta.comfy_commit,
    cn_commits: r.meta.cn_commits,
    weights: r.meta.weights,
    prompt_id: r.promptId,
    bytes: r.bytes.length,
    cents
  };
  const abs = writeOut(ctx, fileName, r.bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const bag = { ok: true, cents, art, meta, engine: ENGINE_USER, path: art };
  j.result = bag;
  j.art = bag;
  return { ok: true, cents, art, meta };
}

async function runStub(ctx, job, p, seed, cents) {
  const j = job || {};
  const idSeg = safeSeg(j.id || "img_" + seed.slice(0, 8));
  const fileName = idSeg + ".png";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "image-stub", // 诚实标注：这是占位，不是真模型产物
    lane: NAME,
    engine: ENGINE,
    engine_user: ENGINE_USER,
    jobType: j.type || null,
    episodeId: p.episodeId || j.episodeId || null,
    seed,
    tmpl_hash: "h_" + sub(seed, 8, 12),
    comfy_commit: "c" + sub(seed, 0, 7),
    cn_commit: "c" + sub(seed, 4, 7),
    weights: WEIGHTS,
    cents
  };
  const abs = writeOut(ctx, fileName, PNG_1x1);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const bag = { ok: true, cents, art, meta, engine: ENGINE_USER, path: art };
  j.result = bag;
  j.art = bag;
  return { ok: true, cents, art, meta };
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, type: j.type, payload: p });
  const cents = 3 + (numFrom(seed) % 6); // 3–8 分，确定性
  const comfyOn = !!(ctx && ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.enabled);
  return comfyOn ? runComfy(ctx, j, p, seed, cents) : runStub(ctx, j, p, seed, cents);
}

module.exports = { name: NAME, lane: NAME, run };
