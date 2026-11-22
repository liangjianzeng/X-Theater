"use strict";
/**
 * workers/tts.js — 配音（CosyVoice2）stub
 * 契约 §4：voice job stub——写 var/out/<id>.mp3 占位＋.meta.json。
 * 成本无契约硬性数字，取确定性 2–6 分（hash 派生；见交付说明之假设）。
 */
const fs = require("fs");
const path = require("path");
const prompts = require("../../prompts/index.js");

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
// 音色推导（2026-11-22 提示词体系升级，方案 §5.6/A10）：部署面映射优先 → 性别词典
// （cast.gender 字段 → desc/anchor 关键词 → role 名）→ 未映射省略 speaker（服务端默认音色）。
// 旁白走独立男声（旧版所有角色共用一个音色；CosyVoice2 无中性音色，男声作旁白音区）。
const SPK_MAP = { "女主": "中文女" };
function speakerFor(castDef, roleName) {
  if (SPK_MAP[roleName]) return SPK_MAP[roleName];
  if (roleName === "旁白") return "中文男";
  const g = prompts.genderOf(castDef, roleName);
  if (g === "男") return "中文男";
  if (g === "女") return "中文女";
  return undefined;
}

/** 音色解析三级（素材中心 C3，2026-11-22）：集级 voice_map（音色库 id→spk 或直写音色键）
 * → 角色域 voice 绑定 → 既有推导（SPK_MAP/gender）。素材库（asset_lib）优先级最高——
 * 行业口径：音色是配音资产，角色库绑定跨集生效，集级 map 做本集覆盖。 */
function resolveSpeaker(ctx, castDef, roleName, ep) {
  const st = (ctx && ctx.store && typeof ctx.store.get === "function" && ctx.store.get()) || {};
  const voices = (st.asset_lib && st.asset_lib.audio && Array.isArray(st.asset_lib.audio.voices)) ? st.asset_lib.audio.voices : [];
  const vm = (ep && ep.voice_map) || null;
  const v = vm && vm[roleName];
  if (v) {
    const vo = voices.find((x) => x && x.id === v);
    if (vo && vo.spk) return String(vo.spk);
    return String(v);
  }
  // 角色域绑定：voice 存的可能是音色库 id 或音色键
  if (castDef && castDef.voice) {
    const vo = voices.find((x) => x && x.id === castDef.voice);
    if (vo && vo.spk) return String(vo.spk);
    return String(castDef.voice);
  }
  return speakerFor(castDef, roleName);
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

/** 显存互斥：卸载 ComfyUI 常驻模型（编辑模型热载 ~14.5G，不卸载则 TTS/音乐必 OOM） */
async function freeComfy(ctx) {
  const base = String((ctx && ctx.cfg && (ctx.cfg.llmHostComfy || (ctx.cfg.comfy && ctx.cfg.comfy.base))) || ""); // 本机（LLM 承载机）Comfy——同机模型常驻才有显存冲突，挂节点档案
  if (!base) return;
  try {
    await new Promise((resolve) => {
      const u = new URL(base + "/free");
      const rq = require("http").request(u, { method: "POST", headers: { "content-type": "application/json" } }, (rs) => { rs.resume(); rs.on("end", resolve); rs.on("error", resolve); });
      rq.on("error", resolve);
      rq.end(JSON.stringify({ unload_models: true, free_memory: true }));
    });
  } catch (e) { /* 卸载失败不阻断主流程 */ }
}
async function runReal(ctx, job, p, seed) {
  await freeComfy(ctx);
  const http = require("http");
  const url = String((ctx.cfg && ctx.cfg.tts && ctx.cfg.tts.url) || process.env.THEATER_TTS_URL || "");
  if (!url) return null;
  const st = ctx.store.get();
  const ep = st.episodes && st.episodes[(p.episodeId || job.episodeId || "")];
  const script = ep && ep.script;
  const lines = [];
  // 场景对齐：state 场景按 seq 排序 ↔ script.scenes 顺序（ensureScenesAndShots 1:1 有序创建）
  let sceneIdx = -1;
  if (p.sceneId) {
    const scAll = Object.keys(st.scenes || {}).map((k) => st.scenes[k])
      .filter((x) => x && x.episodeId === (p.episodeId || job.episodeId))
      .sort((a, b) => (a.seq || 0) - (b.seq || 0));
    sceneIdx = scAll.findIndex((x) => x.id === p.sceneId);
    if (sceneIdx < 0) return { lines: [] }; // 场景对不上：诚实空结果（不落 stub 造假）
  }
  (script && script.scenes || []).forEach((sc, si) => {
    if (p.sceneId && si !== sceneIdx) return; // 每场景 job 只渲染本场景台词
    (sc.shots || []).forEach((sh, i) => {
      const role0 = (sh.cast || [])[0] || "";
      if (sh.dialogue) lines.push({
        sceneName: sc.name, mood: sc.mood, seq: i + 1, text: sh.dialogue,
        cast: role0, castDef: (script.cast || []).find((x) => x.role === role0) || null
      });
    });
  });
  if (!lines.length) return { lines: [] }; // 真实模式下无台词场景＝诚实空结果
  const out = [];
  for (const ln of lines) {
    // 情感指令（CosyVoice2 instruct 通道，方案 §5.6/A9）：mood→语气短语，作为可选字段透传；
    // 服务端未实现 instruct 时忽略该字段无害。克隆模式下 instruct 不可靠（官方已知限制）。
    const ins = prompts.ttsInstruct(ln.mood);
    const body = JSON.stringify({ text: ln.text, speaker: resolveSpeaker(ctx, ln.castDef, ln.cast, ep), instruct: ins || undefined });
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
  if ((ctx.cfg && ctx.cfg.tts && ctx.cfg.tts.url) || process.env.THEATER_TTS_URL) {
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
