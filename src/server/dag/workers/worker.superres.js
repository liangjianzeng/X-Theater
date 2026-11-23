"use strict";
/**
 * workers/worker.superres.js — 成片超分车道（对标调研第二梯队⑥·2026-11-22）
 * 720p 是当前交付短板（红果/抖音平台 1080p 渐成门槛）。方案（调研定档）：SeedVR2-3B FP8
 * （Apache-2.0，FP8+block swap 后 12–16GB 可跑 5060 Ti）720→1080p；帧率补齐走 RIFE（MIT）。
 *
 * 双模式（ADR-001 同款纪律）：
 *  - real 模式（THEATER_SUPERRES_URL 已配）：POST <url>/superres {video} → mp4 字节。
 *    服务实现见 runtime/seedvr2/（SeedVR2-3B FP8；模板/权重登记后启用——权重未装时
 *    probe /object_info 探测 SeedVR2 节点缺失 → NO_SEEDVR2_NODE 真错误，绝不静默降级）。
 *  - stub 模式（默认，验收套件）：mp4 头占位（meta kind:"superres-stub"，绝不冒充真片）。
 * 用户面引擎标签一律「自部署·精修档」；型号细节只进 meta/sidecar（豁免面）。
 */
const fs = require("fs");
const path = require("path");

const NAME = "superres";
const ENGINE = "视频超分服务";
const ENGINE_USER = "自部署·精修档";
const COST_CENTS = 10;
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
function resolveArt(ctx, art) {
  const a = String(art || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const base = String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join(vdir(ctx), "out"));
  const byBase = path.join(base, path.basename(a));
  if (fs.existsSync(byBase)) return byBase;
  return path.join(vdir(ctx), a.replace(/^var\//, ""));
}

async function runReal(ctx, j, p, seed) {
  const base = String(process.env.THEATER_SUPERRES_URL || "").replace(/\/+$/, "");
  const st = ctx.store.get();
  const shot = (st.shots || {})[p.shotId];
  if (!shot) throw Object.assign(new Error("超分目标镜头不存在: " + p.shotId), { code: "NO_SHOT" });
  const takes = (shot.takes || []).filter((t) => t && t.art);
  const srcTake = (p.takeId && takes.find((t) => t.id === p.takeId)) || takes.filter((t) => t.best).pop() || takes[takes.length - 1];
  if (!srcTake) throw Object.assign(new Error("该镜尚无成片 take，无法超分: " + p.shotId), { code: "NO_SOURCE_TAKE" });
  const srcAbs = resolveArt(ctx, srcTake.art);
  if (!fs.existsSync(srcAbs)) throw Object.assign(new Error("take 文件缺失: " + srcAbs), { code: "TAKE_MISSING" });
  const r = await fetch(base + "/superres", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ video: srcAbs, target: "1080x1920" }),
    signal: AbortSignal.timeout(1800000)
  });
  if (!r.ok) throw Object.assign(new Error("超分服务失败：" + r.status), { code: "SUPERRES_FAIL" });
  const bytes = Buffer.from(await r.arrayBuffer());
  const takeId = safeSeg(p.takeId || "tksr_" + seed.slice(0, 8));
  const fileName = takeId + "_1080.mp4";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "superres-comfy", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    shotId: p.shotId, episodeId: p.episodeId || j.episodeId || null,
    superres_of: srcTake.id, resolution: "1080x1920", bytes: bytes.length, seed
  };
  writeOut(ctx, fileName, bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  const take = { id: takeId, engine: ENGINE_USER, cost_cents: COST_CENTS, art, license: { model: "Apache-2.0", usage: "ok" }, best: true, superres_of: srcTake.id };
  const bag = { ok: true, cents: COST_CENTS, art, path: art, meta, take, engine: ENGINE_USER, cost_cents: COST_CENTS, license: take.license, resolution: meta.resolution };
  j.result = bag; j.art = bag;
  return { ok: true, cents: COST_CENTS, art, meta };
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, payload: p });
  const realOn = !!process.env.THEATER_SUPERRES_URL;
  if (realOn) return runReal(ctx, j, p, seed);

  // —— stub 模式（验收套件）——占位 mp4 头，绝不冒充真片
  const takeId = safeSeg(p.takeId || "tksr_" + seed.slice(0, 8));
  const fileName = takeId + "_1080.mp4";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "superres-stub", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    shotId: p.shotId || null, episodeId: p.episodeId || j.episodeId || null,
    resolution: "1080x1920", seed
  };
  writeOut(ctx, fileName, MP4_STUB);
  const take = { id: takeId, engine: ENGINE_USER, cost_cents: COST_CENTS, art, license: { model: "Apache-2.0", usage: "ok" }, best: true };
  const bag = { ok: true, cents: COST_CENTS, art, path: art, meta, take, engine: ENGINE_USER, cost_cents: COST_CENTS, license: take.license, resolution: meta.resolution };
  j.result = bag; j.art = bag;
  return { ok: true, cents: COST_CENTS, art, meta };
}

module.exports = { name: NAME, lane: NAME, run };
