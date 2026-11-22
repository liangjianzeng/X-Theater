"use strict";
/**
 * workers/worker.t2v.local.js — 视频·本机车道（LTX-2.5 distilled GGUF UD-Q4_K_XL · W-B 无头 ComfyUI :8188）
 * 双模式（ADR-001）：
 *  - comfy 模式（cfg.comfy.enabled）：LTX-2.5 两段蒸馏 I2V——首帧＝该镜分镜图（C2 payload.images 按 shotId 绑定的真图）；
 *    720×1280 5s@24fps，显存峰值 ~15.8G（96.8%），生成前强制 POST /free 卸载其它家族（显存互斥铁律）。
 *  - stub 模式（默认，验收套件）：mp4 头占位（meta kind:video-stub，绝不冒充真片）。
 * 用户面引擎标签一律「自部署·标准档」；型号细节只进 meta/sidecar（豁免面）。
 */
const fs = require("fs");
const path = require("path");
const comfy = require("../adapters/comfy.js");
const prompts = require("../../prompts/index.js");

const NAME = "t2v.local";
const ENGINE = "LTX-2.5 distilled GGUF UD-Q4_K_XL";
const ENGINE_USER = "自部署·标准档";
const TIER = "UD-Q4_K_XL";
const COST_CENTS = 80;
const TMPL_I2V = "ltx25-i2v";
const TMPL_I2V_REF = "ltx25-i2v-ref";
// 多镜串拍（LTX-2.5 原生 multishot：一次前向生成同场多镜，角色/环境/声跨切一致，ComfyUI 官方能力 2026-08）
const TMPL_MS = "ltx25-multishot";
// 转场衔接镜（FR-506 落地）：A 镜尾帧（frame 0）＋B 镜首帧（AddGuide frame_idx=-1，同 ltx25-i2v-ref 机制）
const TMPL_FLF = "ltx25-flf";
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

/* ---------- 多镜串拍 / 转场衔接镜 工具（2026-11-22 对标调研第一梯队①＋转场落实） ---------- */

/** LTX 帧长约束：8n+1（≥9）。给定秒数 → 最小可行帧数 */
function frames8n1(sec) {
  const n = Math.max(1, Math.ceil((Number(sec) || 5) * 24));
  let f = 9;
  while (f < n) f += 8;
  return f;
}

/** ffmpeg（runtime/bin）——分段/抽帧用；不存在时抛真错误（分段是硬依赖） */
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.cwd(), "runtime", "bin", "ffmpeg.exe");
    if (!fs.existsSync(exe)) return reject(Object.assign(new Error("ffmpeg 不存在（runtime/bin）"), { code: "NO_FFMPEG" }));
    const pr = require("child_process").spawn(exe, args, { windowsHide: true });
    let errOut = "";
    pr.stderr.on("data", (d) => { if (errOut.length < 4000) errOut += String(d); });
    pr.on("close", (code) => code === 0 ? resolve(true) : reject(Object.assign(new Error("ffmpeg 失败：" + errOut.slice(-300)), { code: "FFMPEG_FAIL" })));
    pr.on("error", (e) => reject(Object.assign(new Error("ffmpeg 启动失败：" + e.message), { code: "FFMPEG_SPAWN" })));
    setTimeout(() => { try { pr.kill(); } catch (e2) {} reject(Object.assign(new Error("ffmpeg 超时"), { code: "FFMPEG_TIMEOUT" })); }, timeoutMs || 120000).unref();
  });
}

/** 多镜串拍分段：整段 mp4 按 planned 秒比例切成 N 段（LTX 实际时长=LENGTH/24，按比例缩放切点）。返回段文件绝对路径数组 */
async function splitMultishotFrames(ctx, srcAbs, shotSecs, takeId, totalFrames) {
  const outDir = String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join("var", "out"));
  const totalPlan = shotSecs.reduce((a, b) => a + b, 0);
  const actualSec = totalFrames ? totalFrames / 24 : totalPlan; // LTX 实际时长（帧长约束会向上取整）
  const k = actualSec / totalPlan;
  const segs = [];
  let acc = 0;
  for (let i = 0; i < shotSecs.length; i++) {
    const from = acc * k;
    acc += shotSecs[i];
    const to = (i === shotSecs.length - 1) ? actualSec + 0.001 : acc * k;
    const seg = path.join(outDir, safeSeg(takeId + "_s" + i) + ".mp4");
    await runFfmpeg(["-y", "-ss", from.toFixed(3), "-to", to.toFixed(3), "-i", srcAbs,
      "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "2", seg], 300000);
    segs.push(seg);
  }
  return segs;
}

/** 提取视频最后一帧（转场衔接镜 A 侧输入）：ffmpeg -sseof 抽帧 → 目标目录文件名 */
async function extractLastFrame(srcAbs, dstFile) {
  await runFfmpeg(["-y", "-sseof", "-0.05", "-i", srcAbs, "-frames:v", "1", "-q:v", "2", dstFile], 60000);
  return dstFile;
}

/** 镜序升序取本集镜头（state shots seq 全局编号） */
function shotsByIds(ctx, episodeId, shotIds) {
  const st = ctx.store.get();
  const all = Object.keys(st.shots || {}).map((k) => st.shots[k]).filter((x) => x && x.episodeId === episodeId);
  const ids = (shotIds || []).map(String);
  const picked = all.filter((x) => ids.indexOf(x.id) >= 0);
  picked.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return picked;
}

/** 转场衔接提示词：空间/光线延续＋动作衔接，无台词（台词由 A/B 两镜本镜承载） */
function transitionPrompt(ctx, episodeId, shotA, shotB) {
  const pkg = prompts.style.resolve(ctx, episodeId);
  const descA = String((shotA && shotA.name) || "").slice(0, 60);
  const descB = String((shotB && shotB.name) || "").slice(0, 60);
  return [
    "连续镜头：画面从上一镜自然延续到下一镜，同一空间内光线与色调完全一致。",
    "上一镜结束于：" + descA + "。",
    "下一镜开始于：" + descB + "。",
    "镜头平稳过渡（无硬切、无淡入淡出），动作连贯衔接。",
    pkg.video_suffix_zh
  ].filter(Boolean).join(" ");
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
/** art 虚拟路径（var/out/x）→ cfg.outDir 物理文件（读回产物统一口径） */
function resolveArt(ctx, art) {
  const a = String(art || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const base = String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join("var", "out"));
  const byBase = path.join(base, path.basename(a));
  if (fs.existsSync(byBase)) return byBase;
  return path.join(process.cwd(), a);
}

/** 该镜主角色（cast[0]）的定妆原片 → 拷进 ComfyUI input 作 overlap 参考；无则 null */
function castRefForShot(ctx, episodeId, shot) {
  try {
    const st = ctx.store.get();
    const script = ((st.episodes || {})[episodeId] || {}).script;
    if (!script) return null;
    const flat = [];
    (script.scenes || []).forEach((sc) => (sc.shots || []).forEach((sh) => flat.push(Object.assign({ scene: sc.name }, sh))));
    // state 镜 seq 是全局编号（场×100+序），须按 seq 排序后取位，不能直接当下标
    const sorted = Object.keys(st.shots || {}).map((k) => st.shots[k])
      .filter((x) => x && x.episodeId === episodeId).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const pos = sorted.findIndex((x) => x.id === (shot && shot.id));
    const sh = (pos >= 0 ? flat[pos] : null) || flat[(shot.seq || 1) - 1] || {};
    // 所有镜统一挂「该镜分镜首帧」作 overlap 参考：首帧已含正确场景＋人物＋构图，
    // 人物与场景双重锁定（编辑模型已在分镜阶段保证身份与双人正确性）
    const cards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
    const c2 = cards.filter((x) => x.episodeId === episodeId && x.type === "C2" && (x.payload || {}).images)
      .sort((x, y) => String(y.updated_at || "").localeCompare(String(x.updated_at || "")))[0]; // 最新 C2（驳回重出会产生多张）
    const im = c2 && (c2.payload.images || []).find((x) => x.shotId === (shot && shot.id) && x.art);
    const art = im ? im.art : null;
    if (!art) return null;
    const local = resolveArt(ctx, art);
    if (!fs.existsSync(local)) return null;
    const inputDir = String((ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.inputDir) || "");
    if (!inputDir) return null;
    const name = "ref_" + safeSeg((shot && shot.id) || "x") + ".png";
    fs.copyFileSync(local, path.join(inputDir, name));
    return name;
  } catch (e) { return null; }
}

/** 该镜是否有台词（native speech 生成标记用） */
function hasNativeSpeech(ctx, episodeId, shot) {
  try {
    const st = ctx.store.get();
    const ep = st.episodes && st.episodes[episodeId];
    const script = ep && ep.script;
    if (!script) return false;
    const flat = [];
    (script.scenes || []).forEach((sc) => (sc.shots || []).forEach((sh) => flat.push(sh)));
    const sorted = Object.keys(st.shots || {}).map((k) => st.shots[k])
      .filter((x) => x && x.episodeId === episodeId).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const pos = sorted.findIndex((x) => x.id === (shot && shot.id));
    const sh = (pos >= 0 ? flat[pos] : null) || {};
    return !!(sh.dialogue);
  } catch (e) { return false; }
}

/** 提示词锚定：角色 anchor 块前置（功课结论 V1/V2），只变动作与镜头 */
function shotDesc(ctx, episodeId, shot) {
  try {
    const st = ctx.store.get();
    const ep = st.episodes && st.episodes[episodeId];
    const script = ep && ep.script;
    if (!script) return shot.name || "";
    const flat = [];
    (script.scenes || []).forEach((sc) => (sc.shots || []).forEach((sh) => flat.push(Object.assign({ scene: sc.name, sceneMood: sc.mood }, sh))));
    // state 镜 seq 是全局编号（场×100+序），须按 seq 排序后取位，不能直接当下标
    const sorted = Object.keys(st.shots || {}).map((k) => st.shots[k])
      .filter((x) => x && x.episodeId === episodeId).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const pos = sorted.findIndex((x) => x.id === (shot && shot.id));
    const sh = (pos >= 0 ? flat[pos] : null) || flat[(shot.seq || 1) - 1] || {};
    const refName = (sh.cast || [])[0];
    const cc0 = (script.cast || []).find((x) => x.role === refName || x.name === refName) || {};
    const g0 = prompts.genderOf(cc0, refName);
    // 参考图只锚 cast[0]；其余角色用形象块文字锚定（否则双人镜第二人会漂成女性——实测）
    const whoBlocks = (sh.cast || []).slice(0, 2).map((role, ci) => {
      const cc = (script.cast || []).find((x) => x.role === role || x.name === refName && x.role === role || x.name === role);
      const an = (cc && (cc.anchor || cc.desc)) || "";
      const wd = (cc && cc.wardrobe) || "";
      const nm = (cc && cc.name) || role;
      const g = prompts.genderOf(cc, role);
      const pron = prompts.pronZh(g);
      if (ci === 0) {
        return [
          an ? "画面中是参考图里同一位人物（同一人）：" + an + "。" : "",
          "" + pron + "的面部五官、脸型与发型与参考图完全一致，全片同一人。",
          wd ? "服装：" + wd + "，与参考图一致。" : ""
        ].filter(Boolean).join("");
      }
      return nm + "：" + prompts.genderNounZh(g) + "，" + an + (wd ? "，穿" + wd : "") + "。";
    }).join("");
    const legacyWho = (sh.cast || []).map((role) => {
      const cc = (script.cast || []).find((x) => x.role === role || x.name === role);
      return cc ? cc.desc + "。" : "";
    }).join("");
    // 场景光照统一块（2026-11-22 提示词体系升级）：shot.light（剧本 schema v2）→ mood 光线词典
    // → 风格包 light_by_mood，替代《雨夜》场1-场4 写死映射；场内视觉连续性纪律不变。
    const pkg = prompts.style.resolve(ctx, episodeId);
    const light = String(sh.light || "").trim() || prompts.lightZh(sh.sceneMood || sh.mood, pkg);
    // 运镜具体化：shot.move（schema v2）→ 关键词推导 → 词典短语，替代「电影感镜头运动」泛写
    const moveLine = prompts.moveZh(sh.move || prompts.guessMove(sh.desc || ""));
    // 台词直接写进提示词：LTX-2.5 音视频联合生成说话口型＋同期声（实测 SP_speech 口型与语音同步）
    const speech = sh.dialogue
      ? prompts.pronZh(g0) + "面向镜头开口说话，语音清晰说出：「" + sh.dialogue + "」。" + prompts.pronZh(g0) + "说话时嘴唇随台词自然开合，口型与台词对应，同期声收录" + prompts.pronZh(g0) + "的说话声。"
      : "";
    return [
      whoBlocks.length ? whoBlocks : legacyWho,
      sh.desc || shot.name || "",
      light,
      moveLine,
      speech,
      pkg.video_suffix_zh
    ].filter(Boolean).join(" ");
  } catch (e) { return (shot && shot.name) || ""; }
}

async function freeComfy(ctx) {
  const base = dialBase(ctx); // 与本 lane 拨号同端点（同机模型常驻才有显存冲突），挂节点档案
  try {
    await fetch(base + "/free", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
  } catch (e) { /* 无 /free 或不可达：下游真错误会暴露 */ }
}

/** 本车道拨号端点：注册表 lane→node 绑定 → 节点档案（旧部署回退 cfg.comfy 通道） */
function dialBase(ctx) {
  const c = (ctx && ctx.cfg) || {};
  if (typeof c.laneBase === "function") return String(c.laneBase(NAME) || "").replace(/\/+$/, "");
  return String((c.comfy && c.comfy.base) || "").replace(/\/+$/, "");
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
  const ref = castRefForShot(ctx, episodeId, shot); // 该镜分镜首帧 overlap 参考
  const hasNS = hasNativeSpeech(ctx, episodeId, shot);
  const r = await comfy.runTemplate(ctx, j, {
    tmplId: ref ? TMPL_I2V_REF : TMPL_I2V,
    base: dialBase(ctx), // 本 lane 绑定节点的 Comfy 端点（显式传入，不随 t2i 绑定漂移）
    params: Object.assign({
      SEED: numFrom(seed) % 4294967295,
      PROMPT: shotDesc(ctx, episodeId, shot),
      NEGATIVE: prompts.negativeFor("video"),
      WIDTH: 720, HEIGHT: 1280,
      FPS: 24, LENGTH: 121,
      STAGE1_W: 360, STAGE1_H: 640,
      CFG: 1, SIGMAS1: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
      SIGMAS2: "0.85, 0.7250, 0.4219, 0.0",
      IMAGE: img
    }, ref ? { REF: ref } : {}),
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
    const take = { id: takeId, engine: ENGINE_USER, cost_cents: cents, art, license: { model: "MIT", usage: "ok" }, best: true, native_speech: hasNS };
    const bag = { ok: true, cents, art, path: art, meta, take, engine: ENGINE_USER, cost_cents: cents, license: take.license, sec: 5, tier: TIER };
    j.result = bag; j.art = bag;
    return { ok: true, cents, art, meta };
  })();
  return res;
}

/* ---------- 多镜串拍（video_ms）：同场相邻镜一次前向 → 按时间码分段落 take（梯队①） ---------- */

/** 组内每镜描述（时间码多镜描述，跨镜身份/环境一致由模型原生保证） */
function msGroupPrompt(ctx, episodeId, shots, secs) {
  const pkg = prompts.style.resolve(ctx, episodeId);
  let acc = 0;
  const parts = shots.map((sh, i) => {
    const from = acc.toFixed(1);
    acc += secs[i];
    const to = acc.toFixed(1);
    return from + "s-" + to + "s：第" + (i + 1) + "镜：" + shotDesc(ctx, episodeId, sh);
  });
  return parts.join("\n") + "\n" + pkg.video_suffix_zh;
}

async function runMultishotComfy(ctx, j, p, seed) {
  const episodeId = p.episodeId || j.episodeId || null;
  const shots = shotsByIds(ctx, episodeId, p.shotIds);
  if (shots.length < 2) throw (() => { const e = new Error("多镜串拍至少需要 2 个有效镜头: " + String((p.shotIds || []).join(","))); e.code = "MS_GROUP_TOO_SMALL"; return e; })();
  const secs = shots.map((s) => (Number(s.sec) > 0 ? Number(s.sec) : 5));
  const totalSec = secs.reduce((a, b) => a + b, 0);
  if (totalSec > 10) throw (() => { const e = new Error("多镜串拍总时长超上限（≤10s/组，当前 " + totalSec + "s）"); e.code = "MS_GROUP_TOO_LONG"; return e; })();
  const img = sbFileForShot(ctx, episodeId, shots[0].id);
  if (!img) throw (() => { const e = new Error("组首镜没有可用的分镜首帧: " + shots[0].id); e.code = "NO_STORYBOARD_ART"; return e; })();
  await freeComfy(ctx);
  const LENGTH = frames8n1(totalSec);
  const groupId = safeSeg(p.groupId || "ms_" + seed.slice(0, 8));
  const takeId = safeSeg(p.takeId || groupId);
  const cost = Math.max(COST_CENTS, Math.round(COST_CENTS * (LENGTH / 121)));
  const r = await comfy.runTemplate(ctx, j, {
    tmplId: TMPL_MS,
    base: dialBase(ctx),
    params: {
      SEED: numFrom(seed) % 4294967295,
      PROMPT: msGroupPrompt(ctx, episodeId, shots, secs),
      NEGATIVE: prompts.negativeFor("video"),
      WIDTH: 720, HEIGHT: 1280,
      FPS: 24, LENGTH,
      STAGE1_W: 360, STAGE1_H: 640,
      CFG: 1, SIGMAS1: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
      SIGMAS2: "0.85, 0.7250, 0.4219, 0.0",
      IMAGE: img
    },
    timeoutMs: 1200000
  });
  await freeComfy(ctx);
  const master = takeId + "_full.mp4";
  const masterAbs = writeOut(ctx, master, r.bytes);
  const segs = await splitMultishotFrames(ctx, masterAbs, secs, takeId, LENGTH);
  const takes = shots.map((sh, i) => ({
    id: takeId + "_s" + i,
    shotId: sh.id,
    sec: secs[i],
    art: "var/out/" + path.basename(segs[i]),
    cost_cents: Math.round(cost * secs[i] / totalSec),
    engine: "自部署·标准档",
    license: { model: "MIT", usage: "ok" },
    best: true,
    native_speech: hasNativeSpeech(ctx, episodeId, sh),
    multishot_group: { groupId, master: "var/out/" + master, seg_index: i, frames: LENGTH }
  }));
  const meta = {
    kind: "video-comfy-multishot", lane: NAME, engine: ENGINE + " multishot", engine_user: "自部署·标准档", tier: TIER,
    tmpl_id: TMPL_MS, group: { groupId, shotIds: shots.map((s) => s.id), secs, frames: LENGTH, master: "var/out/" + master },
    prompt_id: r.promptId, tmpl_sha16: r.meta.tmpl_sha16, cn_commits: r.meta.cn_commits, weights: r.meta.weights,
    sec: Number((LENGTH / 24).toFixed(2)), episodeId, prompt: msGroupPrompt(ctx, episodeId, shots, secs).slice(0, 400),
    seed: String(numFrom(seed) % 4294967295), cents: cost
  };
  const bag = { ok: true, cents: cost, art: takes[0].art, path: takes[0].art, meta, takes, engine: "自部署·标准档", cost_cents: cost, license: takes[0].license, sec: meta.sec, tier: TIER, group: meta.group };
  j.result = bag; j.art = bag;
  return { ok: true, cents: cost, art: takes[0].art, meta };
}

function stubMultishot(ctx, j, p, seed) {
  const episodeId = p.episodeId || j.episodeId || null;
  const shots = shotsByIds(ctx, episodeId, p.shotIds);
  const groupId = safeSeg(p.groupId || "ms_" + seed.slice(0, 8));
  const takeId = safeSeg(p.takeId || groupId);
  const secs = shots.map((s) => (Number(s.sec) > 0 ? Number(s.sec) : 5));
  const totalSec = secs.reduce((a, b) => a + b, 0);
  const LENGTH = frames8n1(Math.min(totalSec, 10));
  const cost = Math.max(COST_CENTS, Math.round(COST_CENTS * (LENGTH / 121)));
  const takes = shots.map((sh, i) => {
    const fileName = takeId + "_s" + i + ".mp4";
    const art = "var/out/" + fileName;
    writeOut(ctx, fileName, MP4_STUB);
    return {
      id: takeId + "_s" + i, shotId: sh.id, sec: secs[i], art,
      cost_cents: Math.round(cost * secs[i] / totalSec), engine: "自部署·标准档",
      license: { model: "MIT", usage: "ok" }, native_speech: hasNativeSpeech(ctx, episodeId, sh),
      multishot_group: { groupId, seg_index: i, frames: LENGTH }
    };
  });
  const meta = {
    kind: "video-stub", lane: NAME, engine: ENGINE, tier: TIER, multishot: true,
    group: { groupId, shotIds: shots.map((s) => s.id), secs, frames: LENGTH },
    sec: Number((LENGTH / 24).toFixed(2)), shotId: shots[0] && shots[0].id, episodeId, seed, cents: cost
  };
  const bag = { ok: true, cents: cost, art: takes.length ? takes[0].art : null, path: takes.length ? takes[0].art : null, meta, takes, engine: "自部署·标准档", cost_cents: cost, license: takes.length ? takes[0].license : { model: "MIT", usage: "ok" }, sec: meta.sec, tier: TIER, group: meta.group };
  j.result = bag; j.art = bag;
  return { ok: true, cents: cost, art: bag.art, meta };
}

/* ---------- 转场衔接镜（transition）：A 尾帧+B 首帧 → 桥接段（FR-506 落地） ---------- */

async function runTransitionComfy(ctx, j, p, seed) {
  const episodeId = p.episodeId || j.episodeId || null;
  const st = ctx.store.get();
  const shotA = (st.shots || {})[p.fromShotId] || null;
  const shotB = (st.shots || {})[p.toShotId] || null;
  if (!shotA || !shotB) throw (() => { const e = new Error("转场衔接镜缺少起止镜头: " + p.fromShotId + "→" + p.toShotId); e.code = "BAD_TRANSITION_PAIR"; return e; })();
  // A 侧：best take 尾帧（无 take → 真错误，转场依赖已拍成镜）
  const takesA = (shotA.takes || []).filter((t) => t && t.art);
  const bestA = takesA.filter((t) => t.best).pop() || takesA[takesA.length - 1];
  if (!bestA) throw (() => { const e = new Error("起点镜尚无成片 take，无法生成衔接镜: " + shotA.id); e.code = "NO_SOURCE_TAKE"; return e; })();
  const srcA = resolveArt(ctx, bestA.art);
  if (!fs.existsSync(srcA)) throw (() => { const e = new Error("起点镜 take 文件缺失: " + srcA); e.code = "TAKE_MISSING"; return e; })();
  const inputDir = String((ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.inputDir) || "");
  if (!inputDir) throw (() => { const e = new Error("ComfyUI input 目录未配置"); e.code = "NO_INPUT_DIR"; return e; })();
  const tmpDir = path.join(process.cwd(), "var", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const frameTmp = path.join(tmpDir, "trA_" + safeSeg(shotA.id) + ".png");
  await extractLastFrame(srcA, frameTmp);
  const imgName = "trA_" + safeSeg(shotA.id) + "_" + seed.slice(0, 6) + ".png";
  fs.copyFileSync(frameTmp, path.join(inputDir, imgName));
  const imgB = sbFileForShot(ctx, episodeId, shotB.id);
  if (!imgB) throw (() => { const e = new Error("终点镜没有可用的分镜首帧: " + shotB.id); e.code = "NO_STORYBOARD_ART"; return e; })();
  await freeComfy(ctx);
  const LENGTH = frames8n1(Number(p.sec) > 0 ? Number(p.sec) : 2);
  const cost = Math.max(20, Math.round(COST_CENTS * (LENGTH / 121)));
  const takeId = safeSeg(p.takeId || "tr_" + seed.slice(0, 8));
  const r = await comfy.runTemplate(ctx, j, {
    tmplId: TMPL_FLF,
    base: dialBase(ctx),
    params: {
      SEED: numFrom(seed) % 4294967295,
      PROMPT: transitionPrompt(ctx, episodeId, shotA, shotB),
      NEGATIVE: prompts.negativeFor("video"),
      WIDTH: 720, HEIGHT: 1280,
      FPS: 24, LENGTH,
      STAGE1_W: 360, STAGE1_H: 640,
      CFG: 1, SIGMAS1: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
      SIGMAS2: "0.85, 0.7250, 0.4219, 0.0",
      IMAGE: imgName,
      REF: imgB
    },
    timeoutMs: 900000
  });
  await freeComfy(ctx);
  const fileName = takeId + ".mp4";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "video-comfy-transition", lane: NAME, engine: ENGINE + " FLF", engine_user: "自部署·标准档", tier: TIER,
    tmpl_id: TMPL_FLF, transitionId: p.transitionId || null,
    fromShotId: shotA.id, toShotId: shotB.id, from_take: bestA.id,
    prompt_id: r.promptId, tmpl_sha16: r.meta.tmpl_sha16, cn_commits: r.meta.cn_commits, weights: r.meta.weights,
    sec: Number((LENGTH / 24).toFixed(2)), episodeId, prompt: transitionPrompt(ctx, episodeId, shotA, shotB).slice(0, 400),
    seed: String(numFrom(seed) % 4294967295), cents: cost
  };
  const abs = writeOut(ctx, fileName, r.bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const take = { id: takeId, engine: "自部署·标准档", cost_cents: cost, art, license: { model: "MIT", usage: "ok" }, best: true, transition: true };
  const bag = { ok: true, cents: cost, art, path: art, meta, take, engine: "自部署·标准档", cost_cents: cost, license: take.license, sec: meta.sec, tier: TIER };
  j.result = bag; j.art = bag;
  return { ok: true, cents: cost, art, meta };
}

function stubTransition(ctx, j, p, seed) {
  const takeId = safeSeg(p.takeId || "tr_" + seed.slice(0, 8));
  const fileName = takeId + ".mp4";
  const art = "var/out/" + fileName;
  const LENGTH = frames8n1(Number(p.sec) > 0 ? Number(p.sec) : 2);
  const cost = Math.max(20, Math.round(COST_CENTS * (LENGTH / 121)));
  const meta = {
    kind: "video-stub", lane: NAME, engine: ENGINE, tier: TIER, transition: true,
    transitionId: p.transitionId || null, fromShotId: p.fromShotId || null, toShotId: p.toShotId || null,
    sec: Number((LENGTH / 24).toFixed(2)), episodeId: p.episodeId || j.episodeId || null, seed
  };
  writeOut(ctx, fileName, MP4_STUB);
  const take = { id: takeId, engine: "自部署·标准档", cost_cents: cost, art, license: { model: "MIT", usage: "ok" }, transition: true };
  const bag = { ok: true, cents: cost, art, path: art, meta, take, engine: "自部署·标准档", cost_cents: cost, license: take.license, sec: meta.sec, tier: TIER };
  j.result = bag; j.art = bag;
  return { ok: true, cents: cost, art, meta };
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, payload: p });
  const cents = COST_CENTS;
  const comfyOn = !!(ctx && ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.enabled);
  if (comfyOn) {
    if (j.type === "video_ms") return runMultishotComfy(ctx, j, p, seed);
    if (j.type === "transition") return runTransitionComfy(ctx, j, p, seed);
    return runComfy(ctx, j, p, seed, cents);
  }
  // —— stub 模式（验收套件）——
  if (j.type === "video_ms") return stubMultishot(ctx, j, p, seed);
  if (j.type === "transition") return stubTransition(ctx, j, p, seed);

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
