"use strict";
/**
 * workers/img5060.js — 生图·5060 Ti（qwen-image-2.1-turbo-Q5_K_M · W-B ComfyUI :8188）stub
 * 契约 §4：job c1plan/storyboard 出图占位（var/out/<id>.png 几字节占位＋.meta.json）＋cost 3–8 分。
 * 确定性：一切伪随机从 ctx.util.hash12 派生；产物字节恒定，meta 不含时间戳。
 */
const fs = require("fs");
const path = require("path");

const NAME = "img5060";
const ENGINE = "qwen-image-2.1-turbo-Q5_K_M";
const WEIGHTS = "Q5_K_M";
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

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, type: j.type, payload: p });
  const cents = 3 + (numFrom(seed) % 6); // 3–8 分，确定性

  const idSeg = safeSeg(j.id || "img_" + seed.slice(0, 8));
  const fileName = idSeg + ".png";
  const art = "var/out/" + fileName;

  const meta = {
    kind: "image-stub",
    lane: NAME,
    engine: ENGINE,
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

  const bag = { ok: true, cents, art, meta, engine: ENGINE, path: art };
  j.result = bag;
  j.art = bag; // cards.js 读 job.art || job.result（无 plan/casting → 其自行合成，语义兼容）
  return { ok: true, cents, art, meta };
}

module.exports = { name: NAME, lane: NAME, run };
