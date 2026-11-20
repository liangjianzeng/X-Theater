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

async function runReal(ctx, job, p, seed) {
  const http = require("http");
  const url = String((ctx.cfg && ctx.cfg.tts && ctx.cfg.tts.url) || process.env.THEATER_TTS_URL || "");
  if (!url) return null;
  const st = ctx.store.get();
  const ep = st.episodes && st.episodes[(p.episodeId || job.episodeId || "")];
  const script = ep && ep.script;
  const lines = [];
  (script && script.scenes || []).forEach((sc) => (sc.shots || []).forEach((sh, i) => {
    if (sh.dialogue) lines.push({ seq: i + 1, text: sh.dialogue, cast: (sh.cast || [])[0] || "" });
  }));
  if (!lines.length) return null;
  const out = [];
  for (const ln of lines) {
    const body = JSON.stringify({ text: ln.text, speaker: ln.cast });
    const r = await new Promise((resolve, reject) => {
      const rq = http.request(url + "/tts", { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 180000 }, (rs) => {
        let s = ""; rs.on("data", (c) => s += c); rs.on("end", () => { try { resolve({ st: rs.statusCode, b: JSON.parse(s || "{}") }); } catch (e) { reject(Object.assign(new Error("TTS 响应异常"), { code: "TTS_BAD" })); } });
      });
      rq.on("timeout", () => { rq.destroy(); reject(Object.assign(new Error("TTS 超时"), { code: "TTS_TIMEOUT" })); });
      rq.on("error", (e) => reject(Object.assign(new Error("TTS 不可达：" + e.message), { code: "TTS_UNREACHABLE" })));
      rq.write(body); rq.end();
    });
    if (r.st !== 200) throw Object.assign(new Error("TTS 失败 HTTP " + r.st), { code: "TTS_HTTP" });
    const wav = fs.readFileSync(r.b.file);
    const fn = "tts_" + safeSeg(job.id) + "_" + ln.seq + ".wav";
    writeOut(ctx, fn, wav);
    out.push({ seq: ln.seq, text: ln.text, cast: ln.cast, art: "var/out/" + fn, seconds: r.b.seconds || null });
  }
  return { lines: out };
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  if (ctx.cfg && ctx.cfg.tts && ctx.cfg.tts.url) {
    const rr = await runReal(ctx, job, p, null);
    if (rr) {
      const id2 = "voice_" + safeSeg(job.id);
      const meta2 = { kind: "voice-real", lane: NAME, engine: ENGINE, episodeId: p.episodeId || job.episodeId || null, lines: rr.lines, cents: 5 };
      const bag2 = { ok: true, cents: 5, art: rr.lines[0] ? rr.lines[0].art : null, meta: meta2, lines: rr.lines, engine: "自部署·标准档" };
      job.result = bag2; job.art = bag2;
      return { ok: true, cents: 5, art: bag2.art, meta: meta2 };
    }
  }
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
