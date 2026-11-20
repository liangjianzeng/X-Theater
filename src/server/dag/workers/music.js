"use strict";
/**
 * workers/music.js — 配乐·5060 Ti（ACE-Step 1.5 · W-M :8190）stub
 * 契约 §4：music job 产 3 候选（30–60s 占位 mp3 stub）写回 job.result.candidates；
 * 标题从 mood 词库确定性取名：离别→码头暮色系／释然→晚风系／压抑→汽笛系；
 * 三轮标题＝[主名, 主名+" · 变奏", 主名+"（未许可 · 备选）"]——第 3 条固定含「未许可」→
 * license.usage="missing"（演示预检拦截路径）；license.model 恒 "MIT"；影子计费 5–15 分/条。
 */
const fs = require("fs");
const path = require("path");

const NAME = "music";
const ENGINE = "ACE-Step 1.5";
const MOOD_BASE = { "离别": "码头暮色", "释然": "晚风", "压抑": "汽笛" };
const DEFAULT_MOOD = "释然";
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

async function runReal(ctx, job, p, mood) {
  // 真模式：W-M ACE-Step :8190（MIT；惰性加载，响应即释放显存）。产物 wav → var/out + 曲库候选结构。
  const http = require("http");
  const url = String((ctx.cfg && ctx.cfg.music && ctx.cfg.music.url) || process.env.THEATER_MUSIC_URL || "");
  if (!url) return null;
  const body = JSON.stringify({ mood, seconds: 45, seed: numFrom(hash12(ctx, { lane: NAME, jobId: job.id, mood })) % 4294967295 });
  const r = await new Promise((resolve, reject) => {
    const rq = http.request(url + "/music", { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 300000 }, (rs) => {
      let s = ""; rs.on("data", (c) => s += c); rs.on("end", () => { try { resolve({ st: rs.statusCode, b: JSON.parse(s || "{}") }); } catch (e) { reject(Object.assign(new Error("W-M 响应异常"), { code: "MUSIC_BAD" })); } });
    });
    rq.on("timeout", () => { rq.destroy(); reject(Object.assign(new Error("W-M 超时（300s）"), { code: "MUSIC_TIMEOUT" })); });
    rq.on("error", (e) => reject(Object.assign(new Error("W-M 不可达：" + e.message), { code: "MUSIC_UNREACHABLE" })));
    rq.write(body); rq.end();
  });
  if (r.st !== 200) throw Object.assign(new Error("W-M 生成失败 HTTP " + r.st + ": " + JSON.stringify(r.b).slice(0, 200)), { code: "MUSIC_HTTP" });
  const info = r.b;
  // wav 拷进 var/out（/var/out 静态面可播放）
  const wav = fs.readFileSync(info.file);
  const seed = hash12(ctx, { lane: NAME, jobId: job.id, mood, k: "real" });
  const id = "mus_" + sub(seed, 0, 8);
  const fileName = "music_" + id + ".wav";
  const abs = writeOut(ctx, fileName, wav);
  const meta = {
    kind: "music-real", lane: NAME, engine: ENGINE + "（int8 权重档）", engine_user: "自部署·标准档",
    id, title: mood + " · " + Math.round(info.seconds) + "s", mood, sec: info.seconds,
    license: { model: "MIT", usage: "ok" }, sceneId: p.sceneId || null,
    episodeId: p.episodeId || job.episodeId || null, cents: 12, seed: String(info.seed || ""),
    gen_seconds: info.gen_seconds, vram_peak_mb: info.vram_peak_mb, source: info.file
  };
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  return {
    id, title: meta.title, mood, sec: info.seconds, license: { model: "MIT", usage: "ok" },
    engine: "自部署·标准档", shadow_cents: 12, sceneId: p.sceneId || null, art: "var/out/" + fileName, art_abs: abs
  };
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const mood = p.mood || DEFAULT_MOOD;
  const base = MOOD_BASE[mood] || "长夜";
  const titles = [base, base + " · 变奏", base + "（未许可 · 备选）"];
  const jobSeg = safeSeg(j.id || "music_" + sub(hash12(ctx, { lane: NAME, p }), 0, 8));

  if ((ctx.cfg && ctx.cfg.music && ctx.cfg.music.url) || process.env.THEATER_MUSIC_URL) {
    const cand = await runReal(ctx, j, p, mood);
    if (cand) {
      const bag2 = { ok: true, cents: 12, count: 1, mood, candidates: [cand], engine: "自部署·标准档", cost_cents: 12, meta: { kind: "music-real" } };
      j.result = bag2; j.art = bag2;
      return { ok: true, cents: 12, art: cand.art, meta: bag2.meta };
    }
  }
  const candidates = [];
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const seed = hash12(ctx, { lane: NAME, jobId: j.id, i, mood, sceneId: p.sceneId || null });
    const n = numFrom(seed);
    const cents = 5 + (n % 11); // 5–15 分/条
    total += cents;
    const sec = 30 + (numFrom(sub(seed, 4, 8)) % 31); // 30–60s
    const title = titles[i];
    const usage = title.includes("未许可") ? "missing" : "ok";
    const id = "mus_" + sub(seed, 0, 8) + "_" + i;
    const fileName = "music_" + id + ".mp3";
    const art = "var/out/" + fileName;
    const license = { model: "MIT", usage };

    const meta = {
      kind: "music-stub",
      lane: NAME,
      engine: ENGINE,
      id,
      title,
      mood,
      sec,
      license,
      sceneId: p.sceneId || null,
      episodeId: p.episodeId || j.episodeId || null,
      cents,
      seed
    };
    const abs = writeOut(ctx, fileName, MP3_STUB);
    writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));

    candidates.push({
      id,
      title,
      mood,
      sec,
      license,
      engine: ENGINE,
      shadow_cents: cents,
      sceneId: p.sceneId || null,
      art,
      art_abs: abs
    });
  }

  const bag = {
    ok: true,
    cents: total,
    count: candidates.length,
    mood,
    engine: ENGINE,
    art: candidates[0].art,
    path: candidates[0].art,
    candidates
  };
  j.result = bag; // 契约：3 候选写回 job.result.candidates
  j.art = bag;    // cards.onMusicDone/normalizeCandidates 读 job.art || job.result
  return { ok: true, cents: total, art: candidates[0].art, meta: { count: candidates.length, mood, candidates: candidates.map((c) => ({ id: c.id, title: c.title, mood: c.mood, sec: c.sec, usage: c.license.usage, cents: c.shadow_cents })) } };
}

module.exports = { name: NAME, lane: NAME, run, MOOD_BASE };
