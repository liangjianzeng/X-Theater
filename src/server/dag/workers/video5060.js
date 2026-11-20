"use strict";
/**
 * workers/video5060.js — 视频·5060 Ti（LTX-2.5 distilled GGUF UD-Q4_K_XL · W-B）stub
 * 契约 §4：video job cost 80 分/5s；art=var/out/<takeId>.mp4 二进制占位＋.meta.json{sec,tier,engine,peak_valley}。
 * 确定性：ctx.util.hash12 派生；无 Math.random；无慢档（peak_valley 恒 false，量产档）。
 */
const fs = require("fs");
const path = require("path");

const NAME = "vid5060";
const ENGINE = "LTX-2.5 distilled GGUF UD-Q4_K_XL";
const TIER = "UD-Q4_K_XL";
const COST_CENTS = 80;
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
function regEntry(ctx, lane) {
  try {
    const st = ctx && ctx.store && typeof ctx.store.get === "function" ? ctx.store.get() || {} : {};
    const reg = (st.settings && st.settings.registry) || {};
    return reg[lane] || {};
  } catch (e) {
    return {};
  }
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const reg = regEntry(ctx, NAME);
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, payload: p });

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
    peak_valley: false,
    takeId,
    shotId: p.shotId || null,
    episodeId: p.episodeId || j.episodeId || null,
    seed
  };
  const abs = writeOut(ctx, fileName, MP4_STUB);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;

  const take = {
    id: takeId,
    // 语言表纪律：用户面 take 不带型号（真机型在 meta/sidecar 与 job 账本，内部豁免面可查）
    engine: "自部署·标准档",
    cost_cents: COST_CENTS,
    art,
    license: { model: "MIT", usage: "ok" }
  };
  const bag = { ok: true, cents: COST_CENTS, art, path: art, meta, take, engine, cost_cents: COST_CENTS, license: take.license, sec, tier, peak_valley: false };
  j.result = bag;
  j.art = bag; // onVideoDone 读 art.take → 直接落 shot.takes
  return { ok: true, cents: COST_CENTS, art, meta };
}

module.exports = { name: NAME, lane: NAME, run };
