"use strict";
/**
 * workers/imgspark.js — 生图·DGX Spark（MiniMax-H3-Image int8_convrot · ComfyUI :8188）
 * 双模式（ADR-001 + 2026-11-21 裁决）：
 *  - spark-comfy 模式（cfg.comfySpark.enabled）：h3-image-cast 固化模板（6 步 euler，16 参考图模型）
 *      casting  → 角色定妆（剧本 cast[castIdx] 人设 + refImage 参考）
 *      注意：lane 默认映射不动（c1plan/storyboard/storyboard_char 仍 img5060），
 *      本 worker 仅承接 casting 类任务，走 admin registry engineId 可选切换。
 *  - stub 模式（默认，验收套件）：确定性占位 PNG（meta kind:image-stub，绝不冒充真图）。
 * 用户面引擎标签一律「自部署·高价值档」；型号细节只进 meta/sidecar（豁免面）。
 */
const fs = require("fs");
const path = require("path");
const comfy = require("../adapters/comfy.js");

const NAME = "imgspark";
const ENGINE = "MiniMax-H3-Image int8_convrot 6step";
const ENGINE_USER = "自部署·高价值档";
const COST_CENTS = 20;
const TMPL_CAST = "h3-image-cast";
const STYLE_SUFFIX = "实拍电影剧照质感，真实摄影，自然皮肤纹理与真实光影，浅景深";
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
function settingsOf(ctx) {
  try {
    const st = ctx && ctx.store && typeof ctx.store.get === "function" ? ctx.store.get() || {} : {};
    return st.settings || {};
  } catch (e) {
    return {};
  }
}
/** 定妆角色定义（同 img5060.castOf 语义：剧本 cast[] 按 castIdx） */
function castOf(ctx, episodeId) {
  try {
    const st = ctx.store.get();
    const ep = st.episodes && st.episodes[episodeId];
    const cast = (ep && ep.script && ep.script.cast) || [];
    return cast.map((c) => ({ role: c.role, name: c.name, desc: c.desc, refImage: c.refImage || null }));
  } catch (e) {
    return [];
  }
}
function readRefBytes(ctx, refImage) {
  if (!refImage) return null;
  try {
    const name = safeSeg(String(refImage).replace(/^.*[\\/]/, ""));
    // 剧本 refImage 位于 var/assets/cast（img5060.ensureInComfyInput 同源）；候选产物在 var/out
    const candidates = [
      path.join(process.cwd(), "var", "assets", "cast", name),
      path.join(String(ctx.cfg && ctx.cfg.outDir || path.join("var", "out")), name)
    ];
    for (const p of candidates) if (fs.existsSync(p)) return fs.readFileSync(p);
  } catch (e) { /* fallthrough */ }
  return null;
}

async function runSparkComfy(ctx, job, p, seed, cents) {
  const j = job || {};
  const base = String(ctx.cfg.comfySpark.base || "http://100.81.83.59:8188").replace(/\/+$/, "");
  const cast = castOf(ctx, p.episodeId);
  const actor = cast[p.castIdx] || { desc: p.prompt || "", refImage: null, role: "", name: "" };
  const prompt = [actor.name, actor.role, actor.desc, "定妆照", "Use <Picture 1> as identity reference; keep facial identity consistent.", STYLE_SUFFIX].filter(Boolean).join(" ");

  const names = [];
  const refBytes = readRefBytes(ctx, actor.refImage);
  if (refBytes) {
    names.push(await comfy.uploadAsset(base, refBytes, "sparkimg_ref_" + safeSeg(actor.role) + "_" + seed.slice(0, 6) + ".png"));
  }
  while (names.length < 3) names.push(names[0] || "female_ref.png");

  // 内存常驻优先：仅低于阈值才释放（用户纪律 2026-11-21）
  await comfy.ensureFree(base, 8);
  const r = await comfy.runTemplate(ctx, j, {
    base,
    tmplId: TMPL_CAST,
    params: {
      SEED: numFrom(seed) % 18446744073709551615,
      PROMPT: prompt,
      WIDTH: 1024, HEIGHT: 1024,
      REF_IMAGE_1: names[0], REF_IMAGE_2: names[1], REF_IMAGE_3: names[2]
    },
    pollMs: 1500,
    timeoutMs: 600000
  });

  const idSeg = safeSeg(j.id || "imgspk_" + seed.slice(0, 8));
  const fileName = idSeg + "_cast.png";
  const meta = {
    kind: "image-comfy-spark", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    tmpl_id: TMPL_CAST, tmpl_sha16: r.meta.tmpl_sha16, comfy_commit: r.meta.comfy_commit, cn_commits: r.meta.cn_commits,
    weights: r.meta.weights, prompt_id: r.promptId, bytes: r.bytes.length,
    castIdx: p.castIdx, actorRole: actor.role, seed: String(numFrom(seed) % 18446744073709551615), cents,
    ai_label: "AI 生成内容（MiniMax H3-Image）" // Community License：UI 显著标注
  };
  const art = "var/out/" + fileName;
  const abs = writeOut(ctx, fileName, r.bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const take = { id: idSeg, engine: ENGINE_USER, cost_cents: cents, art, license: { model: "MiniMax-H3-Image Community", usage: "attribution" } };
  const bag = { ok: true, cents, art, path: art, meta, take, engine: ENGINE_USER, cost_cents: cents, license: take.license };
  j.result = bag; j.art = bag;
  const res = { ok: true, cents, art, meta };
  res.actor = { idx: p.castIdx, role: actor.role, name: actor.name };
  return res;
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const settings = settingsOf(ctx);
  const reg = (settings.registry || {})[NAME] || {};
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, type: j.type, payload: p });
  const comfyOn = !!(ctx && ctx.cfg && ctx.cfg.comfySpark && ctx.cfg.comfySpark.enabled);
  const cents = comfyOn ? COST_CENTS : 15 + (numFrom(seed) % 11); // stub 15–25 分，真跑 20 分

  if (comfyOn && j.type === "casting") return runSparkComfy(ctx, j, p, seed, cents);

  // —— stub 模式（验收套件 / 非 casting 类型）——
  const idSeg = safeSeg(j.id || "imgspk_" + seed.slice(0, 8));
  const fileName = idSeg + ".png";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "image-stub",
    lane: NAME,
    engine: reg.model || ENGINE,
    jobType: j.type || null,
    episodeId: p.episodeId || j.episodeId || null,
    seed,
    tmpl_hash: "h_" + seed.slice(8, 20),
    comfy_commit: "c" + seed.slice(0, 7),
    cn_commit: "c" + seed.slice(4, 11),
    weights: "MXFP8+FP8",
    cents
  };
  const abs = writeOut(ctx, fileName, PNG_1x1);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;

  const bag = { ok: true, cents, art, meta, engine: reg.model || ENGINE, path: art };
  j.result = bag;
  j.art = bag;
  return { ok: true, cents, art, meta };
}

module.exports = { name: NAME, lane: NAME, run };
