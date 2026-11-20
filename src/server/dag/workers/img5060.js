"use strict";
/**
 * workers/img5060.js — 生图·5060 Ti（qwen-image-2.1-turbo-Q5_K_M · W-B 无头 ComfyUI :8188）
 * 双模式（ADR-001）：
 *  - comfy 模式（cfg.comfy.enabled）：固化模板真出图；三类任务——
 *      c1plan     → 剧本封面图＋plan.scenes（剧本结构化分镜表，一期不做 LLM 解析）
 *      storyboard → 逐镜分镜首帧（镜内有角色→i2i 锚定参考图，否则 t2i）
 *      casting    → 角色定妆（有参考图→i2i 保影调，无→t2i 按人设）
 *  - stub 模式（默认，验收套件）：确定性占位 PNG（meta kind:image-stub，绝不冒充真图）。
 * 用户面引擎标签一律「自部署·标准档」；型号细节只进 meta/sidecar（豁免面）。
 */
const fs = require("fs");
const path = require("path");
const comfy = require("../adapters/comfy.js");

const NAME = "img5060";
const ENGINE = "qwen-image-2.1-turbo-Q5_K_M";
const ENGINE_USER = "自部署·标准档";
const WEIGHTS = "Q5_K_M";
const TMPL_T2I = "qwen-image-turbo";
const TMPL_I2I = "qwen-image-turbo-i2i";
const STYLE_SUFFIX = "写实电影感人像，青橙影调，烛光夜色一致，浅景深，胶片质感";
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
function scriptOf(ctx, episodeId) {
  try {
    const st = ctx.store.get();
    const ep = st.episodes && st.episodes[episodeId];
    return (ep && ep.script) || null;
  } catch (e) { return null; }
}
function castOf(ctx, episodeId) {
  const sc = scriptOf(ctx, episodeId);
  return (sc && sc.cast) || [];
}
/** 角色参考图确保在 ComfyUI input（var/assets/cast → ComfyUI input） */
function ensureInComfyInput(ctx, refImage) {
  if (!refImage) return null;
  const base = String((ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.inputDir) || "");
  if (!base) return refImage;
  const dst = path.join(base, safeSeg(refImage));
  try {
    if (!fs.existsSync(dst)) {
      const src = path.join(process.cwd(), "var", "assets", "cast", refImage);
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
      else return null;
    }
    return safeSeg(refImage);
  } catch (e) { return null; }
}

async function genOne(ctx, job, { tmplId, prompt, negative, image, seedHex, width, height, steps, cfgv }) {
  const params = {
    SEED: numFrom(seedHex) % 4294967295,
    PROMPT: prompt,
    NEGATIVE: negative || "低质量，模糊，变形，水印，文字，多人",
    WIDTH: width || 1024,
    HEIGHT: height || 1024,
    STEPS: steps || 8,
    CFG: cfgv || 1.0
  };
  let tmpl = tmplId;
  if (image) {
    const ok = ensureInComfyInput(ctx, image);
    if (ok) { tmpl = tmplId; params.IMAGE = ok; }
    else tmpl = tmplId.replace("-i2i", "");
  }
  const r = await comfy.runTemplate(ctx, job, {
    tmplId: tmpl,
    params: Object.assign({}, params, tmpl === TMPL_I2I ? { IMAGE: params.IMAGE, DENOISE: 0.45 } : {}),
    timeoutMs: 300000
  });
  return r;
}

function bag(ctx, job, { bytes, fileName, meta, cents }) {
  const art = "var/out/" + fileName;
  const abs = writeOut(ctx, fileName, bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const bag = { ok: true, cents, art, meta, engine: ENGINE_USER, path: art };
  job.result = bag;
  job.art = bag;
  return { ok: true, cents, art, meta };
}

async function runComfy(ctx, job, p, seed, cents) {
  const j = job || {};
  const type = String(j.type || "");
  const idSeg = safeSeg(j.id || "img_" + seed.slice(0, 8));
  const baseMeta = {
    lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    jobType: type, episodeId: p.episodeId || j.episodeId || null,
    tmpl_sha16: null, prompt_id: null, cents
  };

  if (type === "storyboard") {
    // 逐镜分镜首帧：镜内角色带参考图 → i2i；否则按镜描述 t2i
    const script = scriptOf(ctx, p.episodeId) || { scenes: [] };
    const cast = castOf(ctx, p.episodeId);
    const shots = [];
    (script.scenes || []).forEach((sc) => (sc.shots || []).forEach((sh) => shots.push(Object.assign({ scene: sc.name }, sh))));
    const images = [];
    for (let i = 0; i < shots.length; i++) {
      const sh = shots[i];
      const refName = (sh.cast || [])[0];
      const ref = cast.find((c) => c.role === refName || c.name === refName);
      const who = ref ? ref.desc + "。" : "";
      const r = await genOne(ctx, j, {
        tmplId: ref && ref.refImage ? TMPL_I2I : TMPL_T2I,
        prompt: [sh.desc, who, STYLE_SUFFIX].filter(Boolean).join(" "),
        image: ref ? ref.refImage : null,
        seedHex: hash12(ctx, { jobId: j.id, i, shot: sh.desc }),
        width: 720, height: 1280, steps: 8, cfgv: 1.0
      });
      const fn = idSeg + "_sb" + (i + 1) + ".png";
      images.push({ shotId: null, seq: i + 1, art: "var/out/" + fn, bytes: r.bytes.length });
      writeOut(ctx, fn, r.bytes);
    }
    // 分镜图与镜的绑定在 onStoryboardDone 里按 seq 对齐
    const meta = Object.assign({}, baseMeta, { kind: "image-comfy-storyboard", images, seed });
    const bagRes = { ok: true, cents, art: images.length ? images[0].art : null, meta, engine: ENGINE_USER, images };
    j.result = bagRes; j.art = bagRes;
    return bagRes;
  }

  if (type === "casting") {
    const cast = castOf(ctx, p.episodeId);
    const actor = cast[p.castIdx] || { desc: p.prompt || "", refImage: null };
    const r = await genOne(ctx, j, {
      tmplId: actor.refImage ? TMPL_I2I : TMPL_T2I,
      prompt: [actor.name, actor.role, actor.desc, "定妆照", STYLE_SUFFIX].filter(Boolean).join(" "),
      image: actor.refImage,
      seedHex: hash12(ctx, { jobId: j.id, actor: p.castIdx }),
      width: 1024, height: 1024, steps: 8, cfgv: 1.0
    });
    const fn = idSeg + "_cast.png";
    const meta = Object.assign({}, baseMeta, {
      kind: "image-comfy", tmpl_sha16: r.meta.tmpl_sha16, cn_commits: r.meta.cn_commits,
      weights: r.meta.weights, prompt_id: r.promptId, bytes: r.bytes.length,
      castIdx: p.castIdx, actorRole: actor.role, seed: String(numFrom(seed) % 4294967295)
    });
    const res = bag(ctx, j, { bytes: r.bytes, fileName: fn, meta, cents });
    res.actor = { idx: p.castIdx, role: actor.role, name: actor.name };
    return res;
  }

  // c1plan（默认）：封面图＋剧本 plan
  const script = scriptOf(ctx, p.episodeId);
  const brief = (() => { try { const st = ctx.store.get(); const ep = st.episodes[p.episodeId]; return (ep && ep.brief) || p.brief || ""; } catch (e) { return p.brief || ""; } })();
  const r = await genOne(ctx, j, {
    tmplId: TMPL_T2I,
    prompt: [brief, "主视觉海报", STYLE_SUFFIX].filter(Boolean).join(" "),
    seedHex: seed, width: 1024, height: 1024, steps: 8, cfgv: 1.0
  });
  const fn = idSeg + ".png";
  const meta = Object.assign({}, baseMeta, {
    kind: "image-comfy", tmpl_sha16: r.meta.tmpl_sha16, cn_commits: r.meta.cn_commits,
    weights: r.meta.weights, prompt_id: r.promptId, bytes: r.bytes.length,
    seed: String(numFrom(seed) % 4294967295)
  });
  const res = bag(ctx, j, { bytes: r.bytes, fileName: fn, meta, cents });
  if (script && script.scenes && script.scenes.length) {
    res.plan = {
      summary: brief,
      scenes: script.scenes.map((sc) => ({ name: sc.name, mood: sc.mood, shots: sc.shots }))
    };
  }
  return res;
}

async function runStub(ctx, job, p, seed, cents) {
  const j = job || {};
  const idSeg = safeSeg(j.id || "img_" + seed.slice(0, 8));
  const fileName = idSeg + ".png";
  const meta = {
    kind: "image-stub", // 诚实标注：这是占位，不是真模型产物
    lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    jobType: j.type || null, episodeId: p.episodeId || j.episodeId || null,
    seed, tmpl_hash: "h_" + seed.slice(8, 20), comfy_commit: "c" + seed.slice(0, 7),
    cn_commit: "c" + seed.slice(4, 11), weights: WEIGHTS, cents
  };
  return bag(ctx, j, { bytes: PNG_1x1, fileName, meta, cents });
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, type: j.type, payload: p });
  const cents = 3 + (numFrom(seed) % 6); // 3–8 分，确定性
  const comfyOn = !!(ctx && ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.enabled);
  return comfyOn ? runComfy(ctx, j, p, seed, cents) : runStub(ctx, j, p, seed, cents);
}

module.exports = { name: NAME, lane: NAME, run };
