"use strict";
/**
 * workers/worker.lipsync.js — 口型重绘车道（对标调研第二梯队⑤·2026-11-22）
 * 行业全系标配能力（可灵/即梦对口型；开源 LatentSync/EchoMimicV3）。一期定位：台词镜后处理——
 * 已拍 take＋该镜台词 TTS 音轨 → 口型重绘新 take（口型与配音对齐，替代「画外音+空镜」规避策略 FR-607）。
 *
 * 双模式（ADR-001 同款纪律）：
 *  - real 模式（THEATER_LIPSYNC_URL 已配）：POST <url>/lipsync {video, audio} → mp4 字节。
 *    服务实现见 runtime/lipsync/（首选 EchoMimicV3-Flash：Apache-2.0 可商用；LatentSync 1.5 备选
 *    ——ADR 模型白名单注：LatentSync license 两处不一致，仅一期调测档，商用链路禁入）。
 *  - stub 模式（默认，验收套件）：mp4 头占位（meta kind:"lipsync-stub"，绝不冒充真片）。
 * 用户面引擎标签一律「自部署·口型档」；型号细节只进 meta/sidecar（豁免面）。
 * 输入（payload）：{ episodeId, shotId, takeId? }——take 缺省取 best；台词音轨取 state.voice_lines
 * 匹配（voice done 产物）。无 take 或无台词 → 真错误（诚实失败，不造假）。
 */
const fs = require("fs");
const path = require("path");

const NAME = "lipsync";
const ENGINE = "口型重绘服务";
const ENGINE_USER = "自部署·口型档";
const COST_CENTS = 10; // 口型重绘＝后处理轻任务（影子记账，实测后校准）
const MP4_STUB = Buffer.from("\x00\x00\x00\x20ftypiso6\x00\x00\x02\x00iso6avc1mp41", "latin1");

/* var 数据根（2026-11-23 深审 D1 收口）：cfg.varDir＝唯一事实源；兜底 process.cwd()/var＝cfg 缺省旧行为 */
function vdir(ctx) {
  return (ctx && ctx.cfg && ctx.cfg.varDir) || path.join(process.cwd(), "var");
}

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
  const dir = path.join(String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join(vdir(ctx), "out")));
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, safeSeg(fileName));
  fs.writeFileSync(fp, data);
  return fp;
}
/** art 虚拟路径 → 物理文件 */
function resolveArt(ctx, art) {
  const a = String(art || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const base = String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join(vdir(ctx), "out"));
  const byBase = path.join(base, path.basename(a));
  if (fs.existsSync(byBase)) return byBase;
  return path.join(vdir(ctx), a.replace(/^var\//, ""));
}

/** 该镜台词 → voice_lines（voice lane done 产物）里匹配的音轨文件 */
function dialogueAudioOf(ctx, episodeId, shot) {
  try {
    const st = ctx.store.get();
    const ep = (st.episodes || {})[episodeId] || {};
    const script = ep.script;
    if (!script) return null;
    const flat = [];
    (script.scenes || []).forEach((sc) => (sc.shots || []).forEach((sh) => flat.push(sh)));
    const sorted = Object.keys(st.shots || {}).map((k) => st.shots[k])
      .filter((x) => x && x.episodeId === episodeId).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const pos = sorted.findIndex((x) => x.id === shot.id);
    const sh = (pos >= 0 ? flat[pos] : null) || {};
    const dlg = String(sh.dialogue || "").trim();
    if (!dlg) return null;
    const pool = (st.voice_lines || {})[episodeId] || [];
    const ln = pool.find((l) => l && l.text === dlg && l.art) || null;
    if (!ln) return null;
    const abs = resolveArt(ctx, ln.art);
    return fs.existsSync(abs) ? { abs, text: dlg } : null;
  } catch (e) { return null; }
}

function bestTakeOf(shot) {
  const takes = (shot.takes || []).filter((t) => t && t.art);
  if (!takes.length) return null;
  return takes.filter((t) => t.best).pop() || takes[takes.length - 1];
}

async function runReal(ctx, j, p, seed) {
  const base = String(process.env.THEATER_LIPSYNC_URL || "").replace(/\/+$/, "");
  const episodeId = p.episodeId || j.episodeId;
  const st = ctx.store.get();
  const shot = (st.shots || {})[p.shotId];
  if (!shot) throw Object.assign(new Error("口型重绘目标镜头不存在: " + p.shotId), { code: "NO_SHOT" });
  const srcTake = bestTakeOf(shot);
  if (!srcTake) throw Object.assign(new Error("该镜尚无成片 take，无法口型重绘: " + p.shotId), { code: "NO_SOURCE_TAKE" });
  const srcAbs = resolveArt(ctx, srcTake.art);
  if (!fs.existsSync(srcAbs)) throw Object.assign(new Error("take 文件缺失: " + srcAbs), { code: "TAKE_MISSING" });
  const audio = dialogueAudioOf(ctx, episodeId, shot);
  if (!audio) throw Object.assign(new Error("该镜台词没有已生成的配音音轨（先跑配音）: " + p.shotId), { code: "NO_DIALOGUE_AUDIO" });
  const r = await fetch(base + "/lipsync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ video: srcAbs, audio: audio.abs, text: audio.text }),
    signal: AbortSignal.timeout(1200000)
  });
  if (!r.ok) throw Object.assign(new Error("口型重绘服务失败：" + r.status), { code: "LIPSYNC_FAIL" });
  const bytes = Buffer.from(await r.arrayBuffer());
  const takeId = safeSeg(p.takeId || "tkls_" + seed.slice(0, 8));
  const fileName = takeId + ".mp4";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "lipsync-comfy", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    shotId: p.shotId, episodeId, lipsync_of: srcTake.id, speech_text: audio.text,
    bytes: bytes.length, seed
  };
  writeOut(ctx, fileName, bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  const take = { id: takeId, engine: ENGINE_USER, cost_cents: COST_CENTS, art, license: { model: "MIT", usage: "ok" }, best: true, lipsync_of: srcTake.id };
  const bag = { ok: true, cents: COST_CENTS, art, path: art, meta, take, engine: ENGINE_USER, cost_cents: COST_CENTS, license: take.license };
  j.result = bag; j.art = bag;
  return { ok: true, cents: COST_CENTS, art, meta };
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, payload: p });
  const realOn = !!process.env.THEATER_LIPSYNC_URL;
  if (realOn) return runReal(ctx, j, p, seed);

  // —— stub 模式（验收套件）——占位 mp4 头，绝不冒充真片
  const takeId = safeSeg(p.takeId || "tkls_" + seed.slice(0, 8));
  const fileName = takeId + ".mp4";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "lipsync-stub", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    shotId: p.shotId || null, episodeId: p.episodeId || j.episodeId || null, seed
  };
  writeOut(ctx, fileName, MP4_STUB);
  const take = { id: takeId, engine: ENGINE_USER, cost_cents: COST_CENTS, art, license: { model: "MIT", usage: "ok" }, best: true };
  const bag = { ok: true, cents: COST_CENTS, art, path: art, meta, take, engine: ENGINE_USER, cost_cents: COST_CENTS, license: take.license };
  j.result = bag; j.art = bag;
  return { ok: true, cents: COST_CENTS, art, meta };
}

module.exports = { name: NAME, lane: NAME, run };
