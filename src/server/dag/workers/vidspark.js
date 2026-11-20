"use strict";
/**
 * workers/vidspark.js — 视频·DGX Spark（FastH3 nvfp4 · 高价值/夜间闲时档）stub
 * 契约 §4：高价值档 150 分；settings.peak_valley=true 时排队慢档——run 前 await 一个
 * 固定 150ms 短延迟模拟（确定性常量，<300ms；无 Math.random）。
 */
const fs = require("fs");
const path = require("path");

const NAME = "vidspark";
const ENGINE = "FastH3 nvfp4";
const TIER = "nvfp4";
const COST_CENTS = 150;
const SLOW_LANE_MS = 150; // 固定慢档延迟（确定性）
const MP4_STUB = Buffer.from("\x00\x00\x00\x20ftypiso6\x00\x00\x02\x00iso6avc1mp41", "latin1");

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

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const settings = settingsOf(ctx);
  const reg = (settings.registry || {})[NAME] || {};
  const peakValley = !!settings.peak_valley;

  if (peakValley) await sleep(SLOW_LANE_MS); // 夜间闲时排队慢档（确定性固定延迟）

  const seed = hash12(ctx, { lane: NAME, jobId: j.id, payload: p, pv: peakValley });
  const takeId = safeSeg(p.takeId || p.take || "tk_" + sub(seed, 0, 8));
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
    slow_lane_ms: peakValley ? SLOW_LANE_MS : 0,
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
