"use strict";
/**
 * workers/worker.t2i.remote.js — 生图·远端车道（MiniMax-H3-Image int8_convrot · ComfyUI :8188）
 * 双模式（ADR-001 + 2026-11-21 裁决）：
 *  - remote-comfy 模式（cfg.comfyRemote.enabled）：h3-image-cast 固化模板（6 步 euler，16 参考图模型）
 *      casting  → 角色定妆（剧本 cast[castIdx] 人设 + refImage 参考）
 *      注意：lane 默认映射不动（c1plan/storyboard/storyboard_char 仍 t2i.local），
 *      本 worker 仅承接 casting 类任务，走 admin registry engineId 可选切换。
 *  - stub 模式（默认，验收套件）：确定性占位 PNG（meta kind:image-stub，绝不冒充真图）。
 * 用户面引擎标签一律「自部署·高价值档」；型号细节只进 meta/sidecar（豁免面）。
 */
const fs = require("fs");
const path = require("path");
const comfy = require("../adapters/comfy.js");
const prompts = require("../../prompts/index.js");
const coreUtil = require("../../core/util.js");

const NAME = "t2i.remote";
const ENGINE = "MiniMax-H3-Image int8_convrot 6step";
const ENGINE_USER = "自部署·高价值档";
const COST_CENTS = 20;
const TMPL_CAST = "h3-image-cast";
const TMPL_EDIT = "h3-image-edit";
const TMPL_FL2VA = "h3-fl2va-video";
const TMPL_FREE = "h3-image-free"; // 素材中心自由生图（img_free）零参考纯 t2i 变体（2026-11-22 用户裁决：DGX 真承接，stub 冒充退役）
const TMPL_FREE_REF = "h3-image-free-ref"; // 自由生图＋参考图槽（subject-reference 保主体；2026-11-22 上传编辑）
// 试妆试镜视频规格：与原图 720×1280 等比例最近的 32 倍数画幅（736×1312，比例误差 0.27%）；
// 10 秒档＝243 帧（17k+5 网格：243/24≈10.1s，训练范围 124-362 内），turbo 4 步。
const ST_W = 736, ST_H = 1312, ST_LEN = 243, ST_STEPS = 4, ST_SEC = 10.13;
const ST_STEP = 8; // 抽帧步长：243/8≈30 帧（场景巡游段多，加密抽帧保证每段 3~4 帧可用）
// 试妆试镜动作设计（2026-11-22 v5 场景参数化）：动作序列与段落表同源不变，但两场景组合由
// 剧本场景关键词挑选（prompts.SCENE_PAIRS：卧室→阳台／办公室→走廊／妆台→庭院回廊／棚拍兜底），
// 动作代词随角色性别（prompts.genderOf）——替代「床头→阳台 + she/her」演示剧写死。
// 段落表纪律不变：抽帧按时间轴标注「场景×动作段」，转场段 prod:false 仅取材不进生产。
function screenTestPlan(script, castDef) {
  const g = prompts.genderOf(castDef, castDef && castDef.role); // 无线索 → 「女」兜底（与旧默认一致）
  const pair = prompts.pickScenePair(script);
  const needs = new Set(["front", "left", "right", "down"]); // 仰头段按剧本分镜需求条件插入
  (script.scenes || []).forEach((sc) => (sc.shots || []).forEach((sh) => {
    if (shotAngleNeed(String((sh && sh.desc) || "")) === "up") needs.add("up");
  }));
  const acts = [];          // 英文动作序列（拼 prompt）
  const segs = [];          // 段落表 {tag, w, scene}——w=时长权重；scene 供后续按镜场景选帧
  const poss = prompts.possEn(g);
  // —— 场景 A（初始图环境，组合库 actFront）——
  acts.push(prompts.fillAct(pair.actFront, g)); segs.push({ tag: "front", w: 1.1, scene: pair.sceneA });
  acts.push("then slowly turns " + poss + " head into a left three-quarter profile and holds"); segs.push({ tag: "left", w: 0.9, scene: pair.sceneA });
  acts.push("then slowly turns into a right three-quarter profile and holds"); segs.push({ tag: "right", w: 0.9, scene: pair.sceneA });
  acts.push("then lowers " + poss + " head with eyes cast down and a soft smile"); segs.push({ tag: "down", w: 0.9, scene: pair.sceneA });
  if (needs.has("up")) { acts.push("gently tilts " + poss + " head up with eyes closed"); segs.push({ tag: "up", w: 0.9, scene: pair.sceneA }); }
  // —— 场景巡游转场（走位即转场，镜头轻跟）。prod:false＝转场段仅用于「新背景定场首帧」的
  //    取材（用户裁决 2026-11-21）：转场帧不进生产内容、选帧直出时跳过，生产价值在转场两端
  //    两个场景块的干净 hold 段——相当于「11 秒产出＝1 秒转场＋两端干净内容」。——
  acts.push(prompts.fillAct(pair.walk, g)); segs.push({ tag: "walk", w: 1.0, scene: pair.sceneB, prod: false });
  // —— 场景 B（组合库 actFrontB/actLeftB/actGazeB）——
  acts.push(prompts.fillAct(pair.actFrontB, g)); segs.push({ tag: "wfront", w: 1.1, scene: pair.sceneB });
  acts.push(prompts.fillAct(pair.actLeftB, g)); segs.push({ tag: "wleft", w: 0.9, scene: pair.sceneB });
  acts.push(prompts.fillAct(pair.actGazeB, g)); segs.push({ tag: "wgaze", w: 1.1, scene: pair.sceneB });
  const prompt = [
    "Beauty screen test, one continuous shot, the camera stays close to " + prompts.pronEn(g) + " and gently follows " + (g === "男" ? "him" : "her") + " movement.",
    acts.join(", then ") + ".",
    "Each pose holds clearly and distinctly so every head angle is easy to see.",
    "Keep " + poss + " face, facial features, hairstyle, eyes and outfit exactly consistent throughout the scene change — the same person as the first frame.",
    pair.light + ", matte skin with natural fine texture and no oily shine, subtle hair movement, shallow depth of field.",
    "No dialogue."
  ].join(" ");
  return { prompt, segments: segs, pair };
}

/** 按段落表把帧时间戳映射到段落对象（权重均分总时长）；返回 {tag, scene} */
function segmentAngle(segments, t, secTotal) {
  if (!segments || !segments.length) return null;
  const wSum = segments.reduce((a, s) => a + (s.w || 1), 0);
  let acc = 0;
  for (const s of segments) {
    acc += (s.w || 1) / wSum * secTotal;
    if (t <= acc) return s;
  }
  return segments[segments.length - 1];
}
// stub 占位图（素材中心 2026-11-22 修复）：1×1 透明 PNG＝界面上看不见——换可见真 PNG
const PNG_STUB = require("../../core/util.js").stubPng(720, 1280);

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
/** 定妆角色定义（同 t2i.local castOf 语义：剧本 cast[] 按 castIdx） */
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
    const rel = String(refImage).replace(/\\/g, "/").replace(/^\/+/, "");
    const name = safeSeg(String(refImage).replace(/^.*[\\/]/, ""));
    // 剧本 refImage 位于 var/assets/cast（ensureInComfyInput 同源）；候选产物在 var/out；
    // 素材库上传为 var/ 全相对路径（2026-11-22 图像上传编辑）——三种候选按序找
    const candidates = [
      path.join(process.cwd(), "var", "assets", "cast", name),
      path.join(String(ctx.cfg && ctx.cfg.outDir || path.join("var", "out")), name),
      path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel)
    ];
    for (const p of candidates) if (fs.existsSync(p)) return fs.readFileSync(p);
  } catch (e) { /* fallthrough */ }
  return null;
}

/** ffmpeg 助手（runtime/bin/ffmpeg.exe，essentials 版无 ffprobe）；spawn 数组传参不走 shell */
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.cwd(), "runtime", "bin", "ffmpeg.exe");
    if (!fs.existsSync(exe)) return reject(Object.assign(new Error("ffmpeg 不存在（runtime/bin）"), { code: "NO_FFMPEG" }));
    const pr = require("child_process").spawn(exe, args, { windowsHide: true });
    let err = "";
    pr.stderr.on("data", (c) => { if (err.length < 4000) err += String(c); });
    pr.on("close", (code) => code === 0 ? resolve(true) : reject(Object.assign(new Error("ffmpeg 失败：" + err.slice(-300)), { code: "FFMPEG_FAIL" })));
    pr.on("error", (e) => reject(Object.assign(new Error("ffmpeg 启动失败：" + e.message), { code: "FFMPEG_SPAWN" })));
    setTimeout(() => { try { pr.kill(); } catch (e) {} reject(Object.assign(new Error("ffmpeg 超时"), { code: "FFMPEG_TIMEOUT" })); }, timeoutMs || 120000).unref();
  });
}

const CAST_DIR = path.join(process.cwd(), "var", "assets", "cast");
function castAssetPath(rel) {
  // rel 可为 var/... 全相对路径（含角色 views 子目录）、var/out/xxx、裸文件名 → 绝对路径
  const s = String(rel || "");
  const name = safeSeg(s.replace(/^.*[\\/]/, ""));
  const cands = [];
  if (/^var[\\/]/.test(s)) cands.push(path.join(process.cwd(), s)); // 全相对路径优先（保子目录）
  cands.push(path.join(CAST_DIR, name), path.join(process.cwd(), "var", "out", name));
  for (const p of cands) if (fs.existsSync(p)) return p;
  return null;
}

/** facegate 门控调用（127.0.0.1:8195）：指定参考脸（ref_file）换回 + ArcFace 打分 */
async function faceGateSwap(pngBytes, refFile) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch("http://127.0.0.1:8195/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dst_b64: pngBytes.toString("base64"), ref_file: refFile || undefined }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const d = await res.json().catch(() => ({}));
    if (d && d.png_b64) return { png: Buffer.from(d.png_b64, "base64"), score: Number(d.score) || 0 };
    throw Object.assign(new Error((d.detail && (d.detail.message || d.detail.code)) || ("facegate HTTP " + res.status)), { code: "FACEGATE_ERR" });
  } catch (e) {
    clearTimeout(t);
    if (e.code === "FACEGATE_ERR") throw e;
    throw Object.assign(new Error("facegate 不可达: " + e.message), { code: "FACEGATE_UNREACHABLE" });
  }
}

/** 角色分镜全套 H3：逐镜 H3-Image edit（输入=用户原图，img2img 身份像素级保真）+ facegate 门控，竖屏 */
function pngSize(bytes) {
  if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return { w: 768, h: 1344 };
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}
function r16(x) { return Math.max(256, Math.floor(x / 16) * 16); }
async function faceGateScore(pngBytes, refFile) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch("http://127.0.0.1:8195/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ img_b64: pngBytes.toString("base64"), ref_file: refFile || undefined }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const d = await res.json().catch(() => ({}));
    return {
      score: (d && d.score) != null ? Number(d.score) : 0,
      yaw: (d && d.yaw != null) ? Number(d.yaw) : null,
      pitch: (d && d.pitch != null) ? Number(d.pitch) : null
    };
  } catch (e) {
    clearTimeout(t);
    return { score: 0, yaw: null, pitch: null };
  }
}

/** 姿态标签（facegate yaw/pitch 粗估）：观众视角 left=左侧脸 */
function angleTag(yaw, pitch) {
  const y = Number(yaw) || 0;
  const pp = Number(pitch) || 0;
  if (pp < -0.05) return "down"; // 低头（眼口纵向距压缩）
  if (pp > 0.05) return "up";    // 仰头
  if (y <= -0.2) return "left";
  if (y >= 0.2) return "right";
  return "front";
}

/** 分镜角度需求解析（desc/anchor 关键词 → 参考帧角度） */
function shotAngleNeed(desc) {
  const s = String(desc || "");
  if (/窗|月光|夜色/.test(s)) return "window";
  if (/仰头|抬头|仰望|仰视|仰面/.test(s)) return "up";
  if (/低头|垂眸|俯首|低眉|低垂/.test(s)) return "down";
  if (/左侧脸|左脸|向左|左回眸|画面左/.test(s)) return "left";
  if (/右侧脸|右脸|向右|右回眸|画面右/.test(s)) return "right";
  return "front";
}

/** 从试妆抽帧参考里挑分镜首帧：目标动作段内按镜序轮换（同段多帧时相邻镜取不同帧）。
 *  段内无合格帧 → 正面段轮换 → 全局最优。
 *  角度别名（2026-11-21 场景巡游）：窗前段（wfront/wleft/wgaze）与床头同名段等价——
 *  分镜按角度需求选帧时不区分场景（场景选择维度待巡游验收后系统化）。
 *  角度门：仅正面帧要求 |yaw|≤0.8（防深侧帧混入正面池）；侧脸/仰/低头帧的 yaw 本就偏移，
 *  不设 yaw 门（选帧直出时代——帧已过用户拍板与 0.45 身份线，edit 时代的崩脸守门退役）。 */
const ANGLE_ALIAS = { front: ["front", "wfront"], left: ["left", "wleft"], right: ["right", "wright"], window: ["window", "wgaze"] };
function pickView(views, need, shotIdx) {
  const ok = (views || []).filter((v) => v && v.art && v.prod !== false && (v.score == null || v.score >= 0.45));
  if (!ok.length) return null;
  const near = (tag) => ok.filter((v) => {
    if ((ANGLE_ALIAS[tag] || [tag]).indexOf(v.angle) < 0) return false;
    if (tag === "front") return Math.abs(Number(v.yaw) || 0) <= 0.8;
    return true;
  }).sort((a, b) => (b.score || 0) - (a.score || 0));
  const globalBest = ok.slice().filter((v) => Math.abs(Number(v.yaw) || 0) <= 0.8)
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
  const pick = (list) => (list && list.length ? list[(Number(shotIdx) || 0) % list.length] : null);
  return pick(near(need)) || pick(near("front")) || globalBest;
}

/** cast_init：初始定妆图生成（用户提示词＋角色人设 → H3-Image t2i，864×1536 精确 9:16） */
async function runRemoteCastInit(ctx, job, p, seed, cents) {
  const j = job || {};
  const base = String(ctx.cfg.comfyRemote.base || "").replace(/\/+$/, ""); // 端点挂节点档案（index.js cfg getter），env 兜底在 getter 内
  const st0 = ctx.store.get();
  const ep = st0.episodes && st0.episodes[p.episodeId];
  const script = (ep && ep.script) || { cast: [] };
  const castDef = script.cast.find((c) => c.role === p.role) || {};
  // 初始定妆（2026-11-22 方案 §5.2/A3）：用户词优先、人设兜底；不写死背景（该图是试镜首帧，场景交给巡游组合 A）
  const pkg = prompts.style.resolve(ctx, p.episodeId);
  const prompt = prompts.buildCastInitPrompt({
    userPrompt: String(p.prompt || "").trim(),
    desc: castDef.desc,
    styleSuffix: pkg.t2i_suffix
  });
  await comfy.ensureFree(base, 8);
  const sd = numFrom(seed) % 18446744073709551615;
  const r = await comfy.runTemplate(ctx, j, {
    base,
    tmplId: TMPL_CAST,
    params: {
      SEED: sd, PROMPT: prompt, WIDTH: 864, HEIGHT: 1536,
      REF_IMAGE_1: "cast___.png", REF_IMAGE_2: "cast___.png", REF_IMAGE_3: "cast___.png"
    },
    transform: (wf) => { // 纯 t2i：去掉参考图节点与 images 条件
      ["4", "5", "6"].forEach((id) => delete wf[id]);
      const c = wf["7"];
      if (c && c.inputs && c.inputs.images !== undefined) c.inputs.images = [];
    },
    pollMs: 1500,
    timeoutMs: 300000
  });
  const fn = safeSeg(j.id) + "_castinit.png";
  const art = "var/out/" + fn;
  const abs = writeOut(ctx, fn, r.bytes);
  const meta = {
    kind: "image-comfy-remote", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    tmpl_id: TMPL_CAST, tmpl_sha16: r.meta.tmpl_sha16, prompt_id: r.promptId, bytes: r.bytes.length,
    jobType: "cast_init", episodeId: p.episodeId, role: p.role, seed: String(sd), cents,
    ai_label: "AI 生成内容（MiniMax H3-Image）"
  };
  writeOut(ctx, fn + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const bag = { ok: true, cents, art, meta, engine: ENGINE_USER, role: p.role };
  j.result = bag; j.art = bag;
  return { ok: true, cents, art, meta, role: p.role };
}

/** screen_test：试妆试镜——初始图为首帧 → FL2VA 10.1 秒等比例视频 → ffmpeg 抽帧 → ArcFace 打分＋角度标签 */
async function runRemoteScreenTest(ctx, job, p, seed, cents) {
  const j = job || {};
  const base = String(ctx.cfg.comfyRemote.base || "").replace(/\/+$/, ""); // 端点挂节点档案（index.js cfg getter），env 兜底在 getter 内
  const st0 = ctx.store.get();
  const ep = st0.episodes && st0.episodes[p.episodeId];
  const script = (ep && ep.script) || { cast: [] };
  const castDef = script.cast.find((c) => c.role === p.role) || script.cast.find((c) => c.refImage) || script.cast[0] || {};
  if (!castDef.refImage) throw Object.assign(new Error("初始定妆未确认：请先在 C2 卡上传或生成初始图并确认"), { code: "CAST_REF_MISSING" });
  const refPath = castAssetPath(castDef.refImage);
  if (!refPath) throw Object.assign(new Error("初始定妆文件缺失: " + castDef.refImage), { code: "CAST_FILE_MISSING" });

  // 1) 孤儿产物接续（断点续跑，2026-11-21）：服务重启/重派时，远端已渲染成功的同规格
  //    试妆产物直接领回续跑（抽帧/打分/出卡），不再重渲浪费 GPU。已消费的 prompt_id 落账防重复。
  //    计划代际校验（2026-11-21 v3）：领回前比对产物 prompt 与当前段落计划——计划换代（如床头→
  //    阳台巡游）后的同规格旧产物不领，防「旧动作视频按新段落表错位标注」。
  const plan = screenTestPlan(script, castDef);
  const st0c = ctx.store.get();
  st0c.settings = st0c.settings || {};
  const usedPool = st0c.settings.remote_reuse_pool || (st0c.settings.remote_reuse_pool = []);
  let mp4Bytes = null, reusedPid = null, reusedSha = null;
  try {
    const hist = await fetch(base + "/history", { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
    const ids = Object.keys(hist).reverse();
    for (const pid of ids) {
      if (usedPool.indexOf(pid) >= 0) continue;
      const rec = hist[pid] || {};
      if ((rec.status || {}).status_str !== "success") continue;
      let isST = false, artNode = null, promptTxt = "";
      Object.values((rec.prompt && rec.prompt[2]) || {}).forEach((n) => {
        if (n && n.class_type === "MiniMaxH3ImageToVideo") {
          if (n.inputs && n.inputs.length === ST_LEN && n.inputs.width === ST_W && n.inputs.height === ST_H) isST = true;
          if (n.inputs && typeof n.inputs.prompt === "string") promptTxt = n.inputs.prompt;
        }
      });
      if (!isST) continue;
      if (promptTxt.indexOf(plan.prompt.slice(0, 120)) < 0) { log2(j, "reuse skip " + pid.slice(0, 8) + ": 计划已换代（旧产物不领）"); continue; }
      for (const nid of Object.keys(rec.outputs || {})) {
        const arr = rec.outputs[nid].videos || rec.outputs[nid].gifs || rec.outputs[nid].images || [];
        if (arr.length && (arr[0].videos !== undefined || true)) artNode = arr[0];
      }
      if (!artNode) continue;
      const q = "?filename=" + encodeURIComponent(artNode.filename) + "&subfolder=" + encodeURIComponent(artNode.subfolder || "") + "&type=" + encodeURIComponent(artNode.type || "output");
      const res = await fetch(base + "/view" + q, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) continue;
      mp4Bytes = Buffer.from(await res.arrayBuffer());
      if (!mp4Bytes || mp4Bytes.length < 100000) { mp4Bytes = null; continue; }
      reusedPid = pid;
      break;
    }
  } catch (e) {
    log2(j, "reuse pool skip: " + e.message);
  }

  // 2) 无可接续产物 → 首帧等比适配＋FL2VA 真跑
  let renderMeta = null;
  if (!mp4Bytes) {
    const tmpDir = path.join(process.cwd(), "var", "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const fitPath = path.join(tmpDir, safeSeg(j.id) + "_fit.png");
    await runFfmpeg(["-y", "-i", refPath, "-vf", "scale=" + ST_W + ":" + ST_H + ":force_original_aspect_ratio=increase,crop=" + ST_W + ":" + ST_H, fitPath]);
    const fitBytes = fs.readFileSync(fitPath);
    const ffName = await comfy.uploadAsset(base, fitBytes, "screentest_ff_" + seed.slice(0, 6) + ".png");
    await comfy.ensureFree(base, 8);
    const sd = numFrom(hash12(ctx, { jobId: j.id, note: p.note || "", role: p.role })) % 18446744073709551615;
    const prompt = plan.prompt + (p.note ? " Additional direction: " + String(p.note).slice(0, 160) : "");
    log2(j, "screen test start seed=" + sd + " segments=" + plan.segments.map((s) => s.tag).join("/"));
    const r = await comfy.runTemplate(ctx, j, {
      base,
      tmplId: TMPL_FL2VA,
      params: { SEED: sd, PROMPT: prompt, FIRST_FRAME: ffName, WIDTH: ST_W, HEIGHT: ST_H, LENGTH: ST_LEN, STEPS: ST_STEPS },
      pollMs: 3000,
      timeoutMs: 1500000
    });
    mp4Bytes = r.bytes;
    renderMeta = r.meta;
  }
  // 段落表与渲染/接续同源（plan 在接续前已按当前剧本生成）
  const mp4Name = safeSeg(j.id) + "_screentest.mp4";
  if (reusedPid) {
    log2(j, "接续孤儿产物 prompt_id=" + reusedPid + "（" + mp4Bytes.length + " bytes，免重渲）");
    usedPool.push(reusedPid);
    ctx.store.commit();
  } else {
    log2(j, "mp4 done " + mp4Bytes.length + " bytes");
  }
  const mp4Path = writeOut(ctx, mp4Name, mp4Bytes);

  // 3) 抽帧（每 8 帧取 1 → 约 30 帧全分辨率候选，736×1312；巡游段多，加密抽帧）
  const outDir = path.join(process.cwd(), "var", "out");
  const prefix = safeSeg(j.id) + "_view_";
  const viewPat = path.join(outDir, prefix + "%02d.png");
  await runFfmpeg(["-y", "-i", mp4Path, "-vf", "select=not(mod(n\\," + ST_STEP + "))", "-vsync", "vfr", viewPat]);
  const viewFiles = fs.readdirSync(outDir).filter((f) => f.indexOf(prefix) === 0 && f.endsWith(".png")).sort();

  // 4) 逐帧 ArcFace 打分＋「场景×动作段」标注（段落表为主，几何 yaw 仅留档交叉参考）
  const views = [];
  for (let i = 0; i < viewFiles.length; i++) {
    const fp = path.join(outDir, viewFiles[i]);
    const sc = await faceGateScore(fs.readFileSync(fp), castDef.refImage);
    const t = Math.round((i * ST_STEP) / 24 * 100) / 100;
    const sg = segmentAngle(plan.segments, t, ST_SEC);
    views.push({
      art: "var/out/" + viewFiles[i],
      t: t,
      score: sc.score,
      yaw: sc.yaw,
      pitch: sc.pitch,
      angle: sg ? sg.tag : (sc.yaw != null ? angleTag(sc.yaw, sc.pitch) : null),
      scene: sg ? (sg.scene || "bedside") : null,
      prod: sg ? (sg.prod !== false) : true, // 转场段仅取材
      selected: sg && sg.prod === false ? false : undefined // 转场帧默认不勾（用户可手动恢复）
    });
    log2(j, "view " + (i + 1) + "/" + viewFiles.length + " t=" + t + "s " + (sg ? (sg.scene + "/" + sg.tag) : "no-seg") + " yaw=" + sc.yaw + " pitch=" + sc.pitch + " score=" + sc.score);
  }

  // 5) contact grid（5×5 缩略，卡片一眼看全）
  const gridName = safeSeg(j.id) + "_grid.png";
  await runFfmpeg(["-y", "-i", mp4Path, "-vf", "select=not(mod(n\\," + ST_STEP + ")),scale=184:328,tile=5x5", "-vsync", "vfr", "-frames:v", "1", path.join(outDir, gridName)]);

  const meta = {
    kind: "video-comfy-remote-screentest", lane: NAME, engine: ENGINE + " fl2va first-frame", engine_user: ENGINE_USER,
    tmpl_id: TMPL_FL2VA, tmpl_sha16: renderMeta ? renderMeta.tmpl_sha16 : null, prompt_id: renderMeta ? renderMeta.promptId : (reusedPid || null), bytes: mp4Bytes.length,
    jobType: "screen_test", episodeId: p.episodeId, role: castDef.role, seed: renderMeta ? String(numFrom(hash12(ctx, { jobId: j.id, note: p.note || "", role: p.role })) % 18446744073709551615) : ("reuse:" + (reusedPid || "")),
    width: ST_W, height: ST_H, frames: ST_LEN, sec: ST_SEC, cents,
    ai_label: "AI 生成内容（MiniMax H3 FL2VA）"
  };
  writeOut(ctx, mp4Name + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  const bag = {
    ok: true, cents, art: "var/out/" + mp4Name, meta, engine: ENGINE_USER,
    role: castDef.role, views, grid: "var/out/" + gridName, sec: ST_SEC, frames: ST_LEN,
    refImage: castDef.refImage,
    checklist: ["五官与脸型", "身材与体态", "服装与细节", "多角度头部人脸（按本集分镜需求）", "场景巡游（" + plan.pair.label + "）转场自然度"]
  };
  j.result = bag; j.art = bag;
  return bag;
}
/** 角色分镜首帧 v2（2026-11-22「热舞派对全在床上」复盘）：
 *  旧 v1「选帧直出」把试棚环境原样带进正片（试妆帧=卧室 → 分镜首帧=卧室 → FL2VA=卧室）。
 *  新 v2＝参考条件生成：h3-image-cast 保留 REF 节点——试妆拍板帧只作**身份参考**，
 *  场景按镜头描述全新生成（舞池/霓虹/露台…），服装走人设锁。单镜生成失败回退 v1 直选帧
 *  （批次不破）；真空镜（desc 不含任何角色名）走纯 T2I。 */
async function runRemoteCharShots(ctx, job, p, seed, cents) {
  const j = job || {};
  const base = String(ctx.cfg.comfyRemote.base || "").replace(/\/+$/, "");
  const st0 = ctx.store.get();
  const ep = st0.episodes && st0.episodes[p.episodeId];
  const script = (ep && ep.script) || { scenes: [], cast: [] };
  const cast = script.cast || [];
  const shots = [];
  (script.scenes || []).forEach((sc) => (sc.shots || []).forEach((sh) => shots.push(Object.assign({ scene: sc.name, mood: sc.mood }, sh))));
  const viewsByRole = (st0.viewRefs || {})[p.episodeId] || {};
  const castDef0 = cast.find((x) => x.refImage) || cast[0] || {};
  const outDirAbs = path.join(process.cwd(), "var", "out");
  const images = [];
  let rendered = 0;
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i];
    const fn = safeSeg(j.id) + "_h3char" + (i + 1) + ".png";
    const artPath = "var/out/" + fn;
    const need = shotAngleNeed(String(sh.desc || ""));
    // 在场角色：显式 cast 优先；LLM 剧本镜头 cast 常为空 → 按描述里点名的角色回退
    const mentioned = cast.filter((c) => sh.desc && (sh.desc.indexOf(c.role) >= 0 || (c.name && sh.desc.indexOf(c.name) >= 0)));
    const roles = (sh.cast || []).length ? sh.cast.slice(0, 3) : mentioned.map((c) => c.role).slice(0, 3);
    // 身份参考帧：各角色按角度需求选拍板帧，缺者回退其初始定妆原图
    const refFrames = [];
    roles.forEach((role) => {
      const cd = cast.find((x) => x.role === role || x.name === role) || {};
      const view = pickView(viewsByRole[role], need, i);
      const srcAbs = view ? castAssetPath(view.art) : (cd.refImage ? castAssetPath(cd.refImage) : null);
      if (srcAbs && fs.existsSync(srcAbs)) refFrames.push({ bytes: fs.readFileSync(srcAbs), def: cd, role });
    });
    const view0 = roles.length ? pickView(viewsByRole[roles[0]], need, i) : null;
    // 不再回退「别人的定妆图/试棚帧」——那正是场景污染源（热舞派对复盘）。无拍板帧 → 跳过该镜
    // 首帧，视频走参考条件路径（R2VA 按 desc 出场景）。
    const copyAbs = view0 ? castAssetPath(view0.art) : null;
    let done = false, usedSeed = numFrom(seed) + i;
    if (refFrames.length) {
      // —— v2 参考条件生成（场景按描述，身份按参考）——
      try {
        await comfy.ensureFree(base, 8);
        const names = [];
        for (let r = 0; r < refFrames.length; r++) {
          names.push(await comfy.uploadAsset(base, refFrames[r].bytes, "sbref_" + safeSeg(refFrames[r].role) + "_" + seed.slice(0, 6) + "_" + r + ".png"));
        }
        while (names.length < 3) names.push(names[names.length - 1]);
        const anchors = refFrames.map((rf) => {
          const cd = rf.def || {};
          const an = cd.anchor || cd.desc || "";
          return "画面中是" + (cd.name || rf.role) + "（参考图里同一位人物，同一人）：" + an + "。";
        });
        // 禁用「场景：X（Y）——Z」标头式行——H3 会把这类标题结构直接烧成画面字幕（热舞派对复盘）；
        // 场景/氛围改织入叙述句。desc 里的后期指令（定格/淡出/字幕等）会诱发「片尾卡」模式
        // 把人名烧成片名——先剥掉含这些词的从句，只留纯视觉描述。
        const visualDesc = String(sh.desc || "")
          .split(/(?<=[。；;])/)
          .filter((seg) => !/(定格|淡出|叠化|黑场|黑屏|字幕|标题|片名|片头|片尾)/.test(seg))
          .join("") || String(sh.desc || "");
        // 年龄硬约束（2026-11-22 用户反馈「显老」）：desc 里的岁数埋在开头权重太低、
        // 参考图人脸年龄会压过文字——把岁数单独提成末段强约束行；缺省按短剧主力观众带年轻化。
        const ageLines = refFrames.map((rf) => {
          const cd = rf.def || {};
          const m = String(cd.desc || cd.anchor || "").match(/(\d{1,2})\s*岁/);
          return "年龄硬约束：" + (cd.name || rf.role) + (m ? " " + m[1] + " 岁" : " 20～25 岁") + "——面容必须呈现同龄的年轻状态，禁止显老、禁止中年化。";
        });
        // 多角色在场强制（角色消失修复）：镜头点名了几个人，画面就必须有几人
        const presenceLine = roles.length > 1
          ? "在场人数硬约束：画面必须同时出现 " + roles.length + " 位角色（" + roles.map((r) => cast.find((c) => c.role === r) ? (cast.find((c) => c.role === r).name || r) : r).join("、") + "），各自按上述参考图保持身份，任何角色不得消失或换人。"
          : "在场人数硬约束：画面只出现 1 位主角（" + (refFrames[0] ? (refFrames[0].def.name || roles[0]) : "主角") + "），不添加多余人物。";
        const prompt = anchors.concat([
          "剧情发生在" + (sh.scene || "剧情现场") + (sh.mood ? "，整体氛围" + sh.mood : "") + "。" + visualDesc,
          "服装与发型严格按上述人物设定，不要漂移；背景与光线按镜头描述，忽略参考图中的环境。",
          "电影感实拍质感，竖屏构图，" + (sh.mood || "") + "氛围。",
          ageLines.join(" "),
          presenceLine,
          "严格禁止：画面中出现任何文字、字幕、标题、水印或 logo，画面必须是纯摄影内容。"
        ]).join("\n");
        const sd = (numFrom(seed) + i) % 18446744073709551615;
        const r = await comfy.runTemplate(ctx, j, {
          base,
          tmplId: TMPL_CAST,
          params: {
            SEED: sd, PROMPT: prompt,
            WIDTH: Number(sh.width) > 0 ? Number(sh.width) : 768,
            HEIGHT: Number(sh.height) > 0 ? Number(sh.height) : 1344,
            REF_IMAGE_1: names[0], REF_IMAGE_2: names[1], REF_IMAGE_3: names[2]
          },
          pollMs: 1500,
          timeoutMs: 300000
        });
        writeOut(ctx, fn, r.bytes);
        rendered++;
        done = true;
        images.push({
          shotId: null, seq: i + 1, art: artPath,
          bytes: fs.statSync(path.join(outDirAbs, fn)).size,
          gate: view0 ? view0.score : null,
          refAngle: view0 ? view0.angle : "castref", refT: view0 ? view0.t : null,
          source: "ref_cond_t2i", roles
        });
        log2(j, "shot " + (i + 1) + "/" + shots.length + " ← 参考条件生成（refs=" + refFrames.length + "，场景=" + (sh.scene || "") + "）");
      } catch (e) {
        log2(j, "shot " + (i + 1) + " 参考生成失败回退直选帧：" + (e && e.message || e));
      }
    }
    if (!done) {
      // —— v1 直选帧兜底（试棚环境随帧——批次不破优先）——
      const srcAbs = copyAbs;
      if (!srcAbs || !fs.existsSync(srcAbs)) {
        if (!roles.length) { log2(j, "shot " + (i + 1) + " 空镜且无参考帧，跳过"); continue; }
        throw Object.assign(new Error("镜 " + (i + 1) + " 无可用参考帧：请先完成试妆试镜（C2S）拍板"), { code: "CAST_FILE_MISSING" });
      }
      writeOut(ctx, fn, fs.readFileSync(srcAbs));
      images.push({
        shotId: null, seq: i + 1, art: artPath,
        bytes: fs.statSync(path.join(outDirAbs, fn)).size,
        gate: view0 ? view0.score : null,
        refAngle: view0 ? view0.angle : "original", refT: view0 ? view0.t : null,
        source: view0 ? "screen_test_frame" : "cast_ref"
      });
      log2(j, "shot " + (i + 1) + "/" + shots.length + " ← 直选帧兜底 (need=" + need + ")");
    }
  }
  const metaC = {
    kind: "image-storyboard-refcond", lane: NAME, engine: "分镜首帧·参考条件生成", engine_user: ENGINE_USER,
    jobType: "storyboard_char", episodeId: p.episodeId, images, cents: rendered * COST_CENTS,
    ai_label: "AI 生成内容（MiniMax H3-Image）"
  };
  const bagC = { ok: true, cents: rendered * COST_CENTS, art: images.length ? images[0].art : null, meta: metaC, engine: ENGINE_USER, images };
  j.result = bagC; j.art = bagC;
  return bagC;
}

/** C1 策划：封面海报（H3-Image t2i）＋剧本 plan（场景=剧本源头） */
async function runRemoteC1Plan(ctx, job, p, seed, cents) {
  const j = job || {};
  const base = String(ctx.cfg.comfyRemote.base || "").replace(/\/+$/, ""); // 端点挂节点档案（index.js cfg getter），env 兜底在 getter 内
  const st0 = ctx.store.get();
  const ep = st0.episodes && st0.episodes[p.episodeId];
  const script = (ep && ep.script) || { scenes: [], cast: [] };
  const brief = (ep && ep.brief) || p.brief || "";
  const pkg = prompts.style.resolve(ctx, p.episodeId);
  await comfy.ensureFree(base, 8);
  const r = await comfy.runTemplate(ctx, j, {
    base,
    tmplId: TMPL_CAST,
    params: {
      SEED: numFrom(seed) % 18446744073709551615,
      // 海报（2026-11-22 方案 §5.4）：brief 不整段直拼——title＋首冲突意象＋标题负空间留白
      PROMPT: prompts.buildPosterPrompt({ title: (ep && ep.title) || "", brief, styleSuffix: pkg.t2i_suffix }),
      WIDTH: 768, HEIGHT: 1344,
      REF_IMAGE_1: "cast___.png", REF_IMAGE_2: "cast___.png", REF_IMAGE_3: "cast___.png"
    },
    transform: (wf) => { // 纯 t2i：去掉参考图节点与 images 条件
      ["4", "5", "6"].forEach((id) => delete wf[id]);
      const c = wf["7"];
      if (c && c.inputs && c.inputs.images !== undefined) c.inputs.images = [];
    },
    pollMs: 1500,
    timeoutMs: 300000
  });
  const fn = safeSeg(j.id) + "_poster.png";
  const art = "var/out/" + fn;
  const abs = writeOut(ctx, fn, r.bytes);
  const meta = {
    kind: "image-comfy-remote", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    tmpl_id: TMPL_CAST, tmpl_sha16: r.meta.tmpl_sha16, prompt_id: r.promptId,
    bytes: r.bytes.length, seed: String(numFrom(seed) % 18446744073709551615), cents,
    ai_label: "AI 生成内容（MiniMax H3-Image）"
  };
  writeOut(ctx, fn + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const bag = { ok: true, cents, art, path: art, meta, engine: ENGINE_USER };
  j.result = bag; j.art = bag;
  const res = { ok: true, cents, art, meta };
  if (script.scenes && script.scenes.length) {
    res.plan = { summary: brief, scenes: script.scenes.map((sc) => ({ name: sc.name, mood: sc.mood, shots: sc.shots })) };
  }
  return res;
}
function log2(job, msg) { try { console.log("[t2i.remote " + String(job.id || "").slice(4, 10) + "] " + msg); } catch (e) {} }

async function runRemoteComfy(ctx, job, p, seed, cents) {
  const j = job || {};
  const base = String(ctx.cfg.comfyRemote.base || "").replace(/\/+$/, ""); // 端点挂节点档案（index.js cfg getter），env 兜底在 getter 内
  const cast = castOf(ctx, p.episodeId);
  const actor = cast[p.castIdx] || { desc: p.prompt || "", refImage: null, role: "", name: "" };
  // 定妆照（2026-11-22 方案 §5.2/A3）：构图指令＋身份参考句（远端档）＋风格包后缀
  const pkg = prompts.style.resolve(ctx, p.episodeId);
  const prompt = prompts.buildCastingPrompt({ name: actor.name, role: actor.role, desc: actor.desc, styleSuffix: pkg.t2i_suffix, withIdentityRef: true });

  const names = [];
  const refBytes = readRefBytes(ctx, actor.refImage);
  if (refBytes) {
    names.push(await comfy.uploadAsset(base, refBytes, "t2ir_ref_" + safeSeg(actor.role) + "_" + seed.slice(0, 6) + ".png"));
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
      WIDTH: 864, HEIGHT: 1536, // 定妆照改竖屏 9:16（2026-11-22 方案 §5.2，与成片画幅一致）
      REF_IMAGE_1: names[0], REF_IMAGE_2: names[1], REF_IMAGE_3: names[2]
    },
    pollMs: 1500,
    timeoutMs: 600000
  });

  const idSeg = safeSeg(j.id || "imgspk_" + seed.slice(0, 8));
  const fileName = idSeg + "_cast.png";
  const meta = {
    kind: "image-comfy-remote", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
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

async function runRemoteImgFree(ctx, job, p, seed, cents) {
  const j = job || {};
  const base = String(ctx.cfg.comfyRemote.base || "").replace(/\/+$/, "");
  const pkg = prompts.style.resolve(ctx, p.episodeId || "");
  const lookPkg = (p.styleLook && prompts.style.BUILTIN_LOOKS[p.styleLook]) || null;
  const suffix = (lookPkg && lookPkg.t2i_suffix) || pkg.t2i_suffix;
  // 画幅×清晰度（2026-11-22）：imgSpecFor 按引擎能力自适应（DGX align16 / ≤2048² 官方调优档）；
  // usage=ref（subject-reference 保主体）/edit（latent←输入图像素级保真改图）——参考图经 uploadAsset 上 Spark。
  const usage = p.usage === "edit" ? "edit" : "ref";
  const spec = coreUtil.imgSpecFor({ ratio: p.ratio, tier: p.tier }, { align: 16, maxMP: 4.2, maxEdge: 2048 });
  const negFinal = [prompts.negativeFor("t2i_empty"), p.negativeExtra].filter(Boolean).join("，");
  const seedBig = numFrom(seed) % 18446744073709551615;

  await comfy.ensureFree(base, 8);
  let tmplId = TMPL_FREE;
  const params = {
    SEED: seedBig,
    PROMPT: prompts.buildFreeImagePrompt({
      desc: p.desc,
      styleSuffix: suffix,
      size: p.size,
      light: p.light,
      refNote: usage === "ref" ? "" : "",
      negative: negFinal
    }),
    WIDTH: spec.w,
    HEIGHT: spec.h
  };
  if (p.refImage) {
    const bytes = readRefBytes(ctx, p.refImage);
    if (!bytes) {
      throw Object.assign(new Error("参考图不可达（" + String(p.refImage || "") + "）——诚实失败，不冒充 t2i"), { code: "EDIT_REF_MISSING" });
    }
    const refName = await comfy.uploadAsset(base, bytes, "libref_" + seed.slice(0, 6) + ".png");
    if (usage === "edit") {
      // 官方 image_edit 语义：引用 <Picture 1> 的编辑指令；latent←输入图＝像素级保真
      if (!String(p.editInstruction || "").trim()) {
        throw Object.assign(new Error("编辑改图缺编辑指令"), { code: "EDIT_INSTRUCTION_MISSING" });
      }
      tmplId = TMPL_EDIT;
      params.PROMPT = prompts.buildImageEditPrompt({ instruction: p.editInstruction, engine: "h3" });
      params.IMAGE = refName;
    } else {
      // subject-reference：conditioning images 槽保主体（新变体模板，试验档）
      tmplId = TMPL_FREE_REF;
      params.REF_IMAGE = refName;
      params.PROMPT = prompts.buildFreeImagePrompt({
        desc: p.desc,
        styleSuffix: suffix,
        size: p.size,
        light: p.light,
        refNote: "以参考图为基准：主体与参考图保持一致。",
        negative: negFinal
      });
    }
  } else if (usage === "edit") {
    throw Object.assign(new Error("编辑改图需要参考图"), { code: "EDIT_REF_MISSING" });
  }
  const r = await comfy.runTemplate(ctx, j, {
    base,
    tmplId,
    params,
    pollMs: 1500,
    timeoutMs: 600000
  });

  const idSeg = safeSeg(j.id || "imgspk_" + seed.slice(0, 8));
  const fileName = idSeg + "_free.png";
  const meta = {
    kind: "image-comfy-remote-free", lane: NAME, engine: ENGINE, engine_user: ENGINE_USER,
    tmpl_id: tmplId, tmpl_sha16: r.meta.tmpl_sha16, comfy_commit: r.meta.comfy_commit, cn_commits: r.meta.cn_commits,
    weights: r.meta.weights, prompt_id: r.promptId, bytes: r.bytes.length,
    desc: String(p.desc || "").slice(0, 200), ratio: p.ratio || "9:16", tier: p.tier || "standard",
    usage, width: spec.w, height: spec.h, size_downgraded: spec.downgraded || false,
    seed: String(seedBig), cents,
    ai_label: "AI 生成内容（MiniMax H3-Image）" // Community License：UI 显著标注
  };
  const art = "var/out/" + fileName;
  const abs = writeOut(ctx, fileName, r.bytes);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;
  const take = { id: idSeg, engine: ENGINE_USER, cost_cents: cents, art, license: { model: "MiniMax-H3-Image Community", usage: "attribution" } };
  const bag = { ok: true, cents, art, path: art, meta, take, engine: ENGINE_USER, cost_cents: cents, license: take.license };
  j.result = bag; j.art = bag;
  return { ok: true, cents, art, meta };
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const settings = settingsOf(ctx);
  const reg = (settings.registry || {})[NAME] || {};
  const seed = hash12(ctx, { lane: NAME, jobId: j.id, type: j.type, payload: p });
  const comfyOn = !!(ctx && ctx.cfg && ctx.cfg.comfyRemote && ctx.cfg.comfyRemote.enabled);
  const cents = comfyOn ? COST_CENTS : 15 + (numFrom(seed) % 11); // stub 15–25 分，真跑 20 分

  if (comfyOn && j.type === "casting") return runRemoteComfy(ctx, j, p, seed, cents);
  if (comfyOn && j.type === "storyboard_char") return runRemoteCharShots(ctx, j, p, seed, cents);
  if (comfyOn && j.type === "c1plan") return runRemoteC1Plan(ctx, j, p, seed, cents);
  if (comfyOn && j.type === "cast_init") return runRemoteCastInit(ctx, j, p, seed, cents);
  if (comfyOn && j.type === "screen_test") return runRemoteScreenTest(ctx, j, p, seed, cents);
  if (comfyOn && j.type === "img_free") return runRemoteImgFree(ctx, j, p, seed, cents);
  if (comfyOn && j.type === "storyboard") {
    // H3 线：场景级本机 t2i 分镜退役——C2 由剧本＋初始定妆直采构成，分镜首帧由
    // storyboard_char 在试妆（C2S）拍板后按 viewRefs 产出（背景只换壳）。本任务只承载卡流推进。
    const bag = {
      ok: true, cents: 0, art: null, engine: ENGINE_USER, images: [],
      meta: { kind: "storyboard-h3-defer", lane: NAME, jobType: "storyboard", episodeId: p.episodeId || null, images: [] }
    };
    j.result = bag; j.art = bag;
    return { ok: true, cents: 0, meta: bag.meta, images: [] };
  }

  // —— stub 模式（验收套件 / 非 casting 类型）——
  const idSeg = safeSeg(j.id || "imgspk_" + seed.slice(0, 8));
  const fileName = idSeg + ".png";
  const art = "var/out/" + fileName;
  const meta = {
    kind: "image-stub",
    lane: NAME,
    // 诚实标注（2026-11-23）：stub 占位绝不冒真引擎名——此前印 reg.model 导致候选池看到「真引擎」却拿到占位图
    engine: "占位·远端未连通（" + (reg.model || ENGINE) + " 未拨通）",
    model_ref: reg.model || ENGINE,
    jobType: j.type || null,
    episodeId: p.episodeId || j.episodeId || null,
    seed,
    tmpl_hash: "h_" + seed.slice(8, 20),
    comfy_commit: "c" + seed.slice(0, 7),
    cn_commit: "c" + seed.slice(4, 11),
    weights: "MXFP8+FP8",
    cents
  };
  const abs = writeOut(ctx, fileName, PNG_STUB);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;

  const bag = { ok: true, cents, art, meta, engine: meta.engine, path: art };
  j.result = bag;
  j.art = bag;
  return { ok: true, cents, art, meta };
}

module.exports = { name: NAME, lane: NAME, run };
