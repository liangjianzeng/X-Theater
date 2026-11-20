"use strict";
/**
 * workers/tts.js — 配音（CosyVoice2）stub
 * 契约 §4：voice job stub——写 var/out/<id>.mp3 占位＋.meta.json。
 * 成本无契约硬性数字，取确定性 2–6 分（hash 派生；见交付说明之假设）。
 */
const fs = require("fs");
const path = require("path");

const NAME = "tts";
const ENGINE = "CosyVoice2";
const MP3_STUB = Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00XTHEATER-STUB", "latin1");

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
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, shotId: p.shotId || null, text: p.text || p.line || null, voice: p.voice || null });
  const cents = 2 + (numFrom(seed) % 5); // 2–6 分（确定性）

  const idSeg = safeSeg(j.id || "voice_" + sub(seed, 0, 8));
  const fileName = idSeg + ".mp3";
  const art = "var/out/" + fileName;

  const meta = {
    kind: "voice-stub",
    lane: NAME,
    engine: ENGINE,
    voice: p.voice || "旁白",
    sec: Number(p.sec) > 0 ? Number(p.sec) : 4,
    text_hash: "h_" + sub(seed, 4, 12),
    text_len: String(p.text || p.line || "").length,
    shotId: p.shotId || null,
    episodeId: p.episodeId || j.episodeId || null,
    seed,
    cents
  };
  const abs = writeOut(ctx, fileName, MP3_STUB);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;

  const bag = { ok: true, cents, art, path: art, meta, engine: ENGINE };
  j.result = bag;
  j.art = bag;
  return { ok: true, cents, art, meta };
}

module.exports = { name: NAME, lane: NAME, run };
