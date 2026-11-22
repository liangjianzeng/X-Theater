"use strict";
/**
 * workers/worker.sfx.js — 音效拟音车道（对标调研第二梯队⑦·2026-11-22）
 * 行业标配（Veo 3.1 原生音效/可灵 Kling-Foley/即梦音效）。我们 LTX 环境声已进终混，缺「事件级
 * 拟音」（关门/脚步/打斗）。方案（调研定档）：Stable Audio Open 1.0（Stability Community License：
 * 年营收 <$1M 可商用；MMAudio 权重 CC-BY-NC 禁商用仅预览）。产物入 asset_lib.audio.sfx，
 * 采纳后由 compose 按 ambience 同通道混入（事件级时间轴点位编辑器见实施记录，本期不做）。
 *
 * 双模式（ADR-001 同款纪律）：
 *  - real 模式（THEATER_SFX_URL 已配）：POST <url>/sfx {prompt, seconds} → wav 字节。
 *    服务实现见 runtime/sfx/。
 *  - stub 模式（默认，验收套件）：静音 wav 占位（meta kind:"sfx-stub"，绝不冒充真音频）。
 * payload：{ episodeId, desc, sec?≤47, sceneId? }。
 */
const fs = require("fs");
const path = require("path");

const NAME = "sfx";
const ENGINE = "音效生成服务";
const ENGINE_USER = "音效生成服务";
const COST_CENTS = 5;

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

/** 最小合法静音 wav（16bit PCM 48k 单声道，stub 占位） */
function silentWav(seconds) {
  const sampleRate = 48000;
  const n = Math.max(1, Math.round((Number(seconds) || 2) * sampleRate));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

async function runReal(ctx, j, p, seed, sec) {
  const base = String(process.env.THEATER_SFX_URL || "").replace(/\/+$/, "");
  const r = await fetch(base + "/sfx", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: String(p.desc || ""), seconds: sec }),
    signal: AbortSignal.timeout(600000)
  });
  if (!r.ok) throw Object.assign(new Error("音效服务失败：" + r.status), { code: "SFX_FAIL" });
  return Buffer.from(await r.arrayBuffer());
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  if (!String(p.desc || "").trim()) {
    throw Object.assign(new Error("音效生成缺少描述（desc）"), { code: "BAD_JOB" });
  }
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, payload: p });
  const sec = Math.min(47, Math.max(1, Number(p.sec) > 0 ? Number(p.sec) : 3));
  const sfxId = "sfx_" + seed.slice(0, 10);
  const fileName = sfxId + ".wav";
  const art = "var/out/" + fileName;
  const realOn = !!process.env.THEATER_SFX_URL;
  const bytes = realOn ? await runReal(ctx, j, p, seed, sec) : silentWav(sec);
  const meta = {
    kind: realOn ? "sfx-comfy" : "sfx-stub", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    episodeId: p.episodeId || j.episodeId || null, sceneId: p.sceneId || null,
    desc: String(p.desc).slice(0, 120), sec, seed
  };
  writeOut(ctx, fileName, bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  const bag = {
    ok: true, cents: COST_CENTS, art, path: art, meta,
    engine: ENGINE_USER, cost_cents: COST_CENTS,
    license: { model: "Stability Community", usage: "ok" },
    sfx_id: sfxId, sec
  };
  j.result = bag; j.art = bag;
  return { ok: true, cents: COST_CENTS, art, meta };
}

module.exports = { name: NAME, lane: NAME, run };
