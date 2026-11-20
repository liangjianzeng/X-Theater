"use strict";
/**
 * workers/video5060.js — 视频·5060 Ti（LTX-2.5 distilled GGUF UD-Q4_K_XL · W-B 无头 ComfyUI :8188）
 * 双模式（ADR-001）：
 *  - comfy 模式（cfg.comfy.enabled）：LTX-2.5 两段蒸馏 I2V——首帧＝该镜分镜图（C2 payload.images 按 shotId 绑定的真图）；
 *    720×1280 5s@24fps，显存峰值 ~15.8G（96.8%），生成前强制 POST /free 卸载其它家族（显存互斥铁律）。
 *  - stub 模式（默认，验收套件）：mp4 头占位（meta kind:video-stub，绝不冒充真片）。
 * 用户面引擎标签一律「自部署·标准档」；型号细节只进 meta/sidecar（豁免面）。
 */
const fs = require("fs");
const path = require("path");
const comfy = require("../adapters/comfy.js");

const NAME = "vid5060";
const ENGINE = "LTX-2.5 distilled GGUF UD-Q4_K_XL";
const ENGINE_USER = "自部署·标准档";
const TIER = "UD-Q4_K_XL";
const COST_CENTS = 80;
const TMPL_I2V = "ltx25-i2v";
const MP4_STUB = Buffer.from("\x00\x00\x00\x20ftypiso6\x00\x00\x02\x00iso6avc1mp41", "latin1");
const STYLE = "电影感镜头运动，青橙影调，雨夜暖光，浅景深";

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
function regEntry(ctx, lane) {
  try {
    const st = ctx && ctx.store && typeof ctx.store.get === "function" ? ctx.store.get() || {} : {};
    const reg = (st.settings && st.settings.registry) || {};
    return reg[lane] || {};
  } catch (e) {
    return {};
  }
}
function sbFileForShot(ctx, episodeId, shotId) {
  const st = ctx.store.get();
  const cards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
  const c2 = cards.find((x) => x.episodeId === episodeId && x.type === "C2");
  const im = c2 && c2.payload && (c2.payload.images || []).find((x) => x.shotId === shotId && x.art);
  if (!im) return null;
  const local = path.join(String(ctx.cfg && ctx.cfg.outDir || path.join("var", "out")), safeSeg(im.art.replace(/^.*[\\/]/, "")));
  if (!fs.existsSync(local)) return null;
  const inputDir = String((ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.inputDir) || "");
  if (!inputDir) return null;
  const name = "sb_" + safeSeg(shotId) + ".png";
  const dst = path.join(inputDir, name);
  try { fs.copyFileSync(local, dst); } catch (e) { return null; }
  return name;
}
/** 该镜描述（剧本 shots 按 seq 对齐）＋在场角色人设 */
function shotDesc(ctx, episodeId, shot) {
  try {
    const st = ctx.store.get();
    const ep = st.episodes && st.episodes[episodeId];
    const script = ep && ep.script;
    if (!script) return shot.name || "";
    const flat = [];
    (script.scenes || []).forEach((sc) => (sc.shots || []).forEach((sh) => flat.push(Object.assign({ scene: sc.name }, sh))));
    const sh = flat[(shot.seq || 1) - 1] || {};
    const cast = script.cast || [];
    const who = (sh.cast || []).map((role) => {
      const c = cast.find((x) => x.role === role || x.name === role);
      return c ? c.desc + "。" : "";
    }).join("");
    return [sh.desc || shot.name, who, STYLE].filter(Boolean).join(" ");
  } catch (e) { return (shot && shot.name) || ""; }
}

async function freeComfy(ctx) {
  const base = String((ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.base) || "http://127.0.0.1:8188").replace(/\/+$/, "");
  try {
    await fetch(base + "/free", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
  } catch (e) { /* 无 /free 或不可达：下游真错误会暴露 */ }
}

async function runComfy(ctx, job, p, seed, cents) {
  const j = job || {};
  const shotId = p.shotId || null;
  const st = ctx.store.get();
  const shot = (st.shots || {})[shotId] || {};
  const episodeId = p.episodeId || j.episodeId || null;
  const img = sbFileForShot(ctx, episodeId, shotId);
  if (!img) throw (() => { const e = new Error("该镜没有可用的分镜首帧（storyboard 真图缺失）: " + shotId); e.code = "NO_STORYBOARD_ART"; return e; })();
  await freeComfy(ctx); // 显存互斥：卸掉生图/其它家族再加载 LTX
  const r = await comfy.runTemplate(ctx, j, {
    tmplId: TMPL_I2V,
    params: {
      SEED: numFrom(seed) % 4294967295,
      PROMPT: shotDesc(ctx, episodeId, shot),
      NEGATIVE: "低质量，模糊，变形，水印，文字，闪切",
      WIDTH: 720, HEIGHT: 1280,
      FPS: 24, LENGTH: 121,
      STAGE1_W: 360, STAGE1_H: 640,
      CFG: 1, SIGMAS1: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
      SIGMAS2: "0.85, 0.7250, 0.4219, 0.0",
      IMAGE: img
    },
    timeoutMs: 900000
  });
  await freeComfy(ctx); // 生成完归还显存（音乐/配音 lane 要用）
  const takeId = safeSeg(p.takeId || "tk_" + seed.slice(0, 8));
  const fileName = takeId + ".mp4";
  const meta = {
    kind: "video-comfy", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER, tier: TIER,
    sec: 5, shotId, episodeId, prompt_id: r.promptId,
    tmpl_sha16: r.meta.tmpl_sha16, cn_commits: r.meta.cn_commits, weights: r.meta.weights,
    bytes: r.bytes.length, seed: String(numFrom(seed) % 4294967295), cents
  };
  const res = (() => {
    const art = "var/out/" + fileName;
    const abs = writeOut(ctx, fileName, r.bytes);
    writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
    meta.art_abs = abs;
    const take = { id: takeId, engine: ENGINE_USER, cost_cents: cents, art, license: { model: "MIT", usage: "ok" }, best: true };
    const bag = { ok: true, cents, art, path: art, meta, take, engine: ENGINE_USER, cost_cents: cents, license: take.license, sec: 5, tier: TIER };
    j.result = bag; j.art = bag;
    return { ok: true, cents, art, meta };
  })();
  return res;
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, payload: p });
  const cents = COST_CENTS;
  const comfyOn = !!(ctx && ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.enabled);
  if (comfyOn) return runComfy(ctx, j, p, seed, cents);

  // —— stub 模式（验收套件）——
  const reg = regEntry(ctx, NAME);
  const takeId = safeSeg(p.takeId || p.take || "tk_" + seed.slice(0, 8));
  const fileName = takeId + ".mp4";
  const meta = {
    kind: "video-stub", lane: NAME, engine: reg.model || ENGINE, tier: reg.tier || TIER,
    sec: Number(p.sec) > 0 ? Number(p.sec) : 5, peak_valley: false, takeId,
    shotId: p.shotId || null, episodeId: p.episodeId || j.episodeId || null, seed
  };
  const res2 = (() => {
    const art = "var/out/" + fileName;
    const abs = writeOut(ctx, fileName, MP4_STUB);
    writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
    meta.art_abs = abs;
    const take = { id: takeId, engine: "自部署·标准档", cost_cents: cents, art, license: { model: "MIT", usage: "ok" } };
    const bag = { ok: true, cents, art, path: art, meta, take, engine: "自部署·标准档", cost_cents: cents, license: take.license, sec: meta.sec, tier: meta.tier, peak_valley: false };
    j.result = bag; j.art = bag;
    return { ok: true, cents, art, meta };
  })();
  return res2;
}

module.exports = { name: NAME, lane: NAME, run };
