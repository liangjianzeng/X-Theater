"use strict";
/**
 * workers/music.js — 配乐·本机 ACE-Step 1.5（W-M :8190）stub
 * 契约 §4：music job 产 3 候选（30–60s 占位 mp3 stub）写回 job.result.candidates；
 * 标题从 mood 词库确定性取名：离别→码头暮色系／释然→晚风系／压抑→汽笛系；
 * 三轮标题＝[主名, 主名+" · 变奏", 主名+"（未许可 · 备选）"]——第 3 条固定含「未许可」→
 * license.usage="missing"（演示预检拦截路径）；license.model 恒 "MIT"；影子计费 5–15 分/条。
 */
const fs = require("fs");
const path = require("path");
const prompts = require("../../prompts/index.js");

const NAME = "music";
const ENGINE = "ACE-Step 1.5";

/* var 数据根（2026-11-23 深审 D1 收口）：cfg.varDir＝唯一事实源；兜底 process.cwd()/var＝cfg 缺省旧行为 */
function vdir(ctx) {
  return (ctx && ctx.cfg && ctx.cfg.varDir) || path.join(process.cwd(), "var");
}
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

/** POST <url>/music（300s 超时；非 200 抛 MUSIC_* 错误码，段2 失败由调用方诚实降级） */
async function postMusic(url, payload) {
  const http = require("http");
  const body = JSON.stringify(payload);
  const r = await new Promise((resolve, reject) => {
    const rq = http.request(url + "/music", { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 300000 }, (rs) => {
      let s = ""; rs.on("data", (c) => s += c); rs.on("end", () => { try { resolve({ st: rs.statusCode, b: JSON.parse(s || "{}") }); } catch (e) { reject(Object.assign(new Error("W-M 响应异常"), { code: "MUSIC_BAD" })); } });
    });
    rq.on("timeout", () => { rq.destroy(); reject(Object.assign(new Error("W-M 超时（300s）"), { code: "MUSIC_TIMEOUT" })); });
    rq.on("error", (e) => reject(Object.assign(new Error("W-M 不可达：" + e.message), { code: "MUSIC_UNREACHABLE" })));
    rq.write(body); rq.end();
  });
  if (r.st !== 200) throw Object.assign(new Error("W-M 生成失败 HTTP " + r.st + ": " + JSON.stringify(r.b).slice(0, 200)), { code: "MUSIC_HTTP" });
  return r.b;
}

/** 声纹解析（2026-11-22）：voiceId → asset_lib.audio.voices 克隆条目（kind=clone 且 ref 在登记）。
 * ref 为 "var/assets/..." 相对路径——THEATER_VAR 部署可变，varRoot 必须从 cfg.outDir 反推
 * （同 library.js varRoot 口径，不能 path.resolve 到进程 cwd）；样本缺失/非克隆返回 null
 * （回退标准档，engine_user 如实标「标准档」，不冒充克隆）。 */
function resolveVoice(ctx, voiceId) {
  if (!voiceId) return null;
  const st = (ctx && ctx.store && typeof ctx.store.get === "function" && ctx.store.get()) || {};
  const voices = (((st.asset_lib || {}).audio || {}).voices) || [];
  const vo = voices.find((x) => x && x.id === voiceId);
  if (!vo || vo.kind !== "clone" || !vo.ref) return null;
  const ref = String(vo.ref).replace(/\\/g, "/").replace(/^\/+/, "");
  const outDir = String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join(vdir(ctx), "out"));
  const varRoot = path.dirname(outDir);
  const ref_abs = path.isAbsolute(ref) ? ref
    : (ref.indexOf("var/") === 0 ? path.join(varRoot, ref.slice("var/".length)) : path.resolve(ref));
  try { if (!fs.existsSync(ref_abs)) return null; } catch (e) { return null; }
  return { id: vo.id, name: vo.name || "", ref_abs };
}

async function runReal(ctx, job, p, mood) {
  await freeComfy(ctx);
  // 真模式：W-M ACE-Step :8190（MIT；惰性加载，响应即释放显存）。产物 wav → var/out + 曲库候选结构。
  const url = String((ctx.cfg && ctx.cfg.music && ctx.cfg.music.url) || process.env.THEATER_MUSIC_URL || "");
  if (!url) return null;
  // 曲风 tags（2026-11-22 提示词体系升级，方案 §5.7）：mood→tags 词典＋风格包 music_tags 覆盖，
  // 作为可选字段透传（ACE-Step 支持 tags+lyrics 双通道；旧服务端忽略该字段无害）。
  // 素材中心专业配置（2026-11-22 下午）：API 层已组装 final tags；lyrics（结构标记/歌词）、
  // caption（自然语言）、instrumental 全通道透传——旧服务端忽略未知字段无害。
  const pkg = prompts.style.resolve(ctx, p.episodeId || job.episodeId || "");
  const sec = Math.max(15, Math.min(180, Number(p.sec) || 45)) | 0;
  const tags = String(p.tags || "").trim() || prompts.musicTags(mood, pkg);
  const lyrics = String(p.lyrics || "") || undefined;
  const caption = String(p.caption || "") || undefined;
  const bpm = Number(p.bpm) || undefined;
  const seed = numFrom(hash12(ctx, { lane: NAME, jobId: job.id, mood })) % 4294967295;

  // 声纹克隆（2026-11-22）：完整档两段——① text2music 完整歌曲（用户歌词/tags/bpm/时长）→
  // ② cover 变声（src_audio=①产物 + ref_audio=声纹样本 + cover_strength，模型锁①时长）；
  // 快档单段——text2music+ref_audio（风格迁移 0.2，音色较松）。声纹模式强制人声。
  const voice = resolveVoice(ctx, p.voiceId);
  const cloneMode = voice ? (p.cloneMode === "fast" ? "fast" : "full") : null;
  let info, engineUser = "自部署·标准档", cents = 12;
  const cloneMeta = {};
  if (voice && cloneMode === "fast") {
    engineUser = "自部署·声纹克隆档（快档·风格迁移）";
    Object.assign(cloneMeta, { voiceId: voice.id, voice_name: voice.name, clone: { mode: "fast", strength: 0.2 } });
    info = await postMusic(url, {
      mood, seconds: sec, seed, tags, bpm, lyrics, prompt: caption, instrumental: false,
      ref_audio: voice.ref_abs, cover_strength: 0.2
    });
  } else if (voice) {
    engineUser = "自部署·声纹克隆档（两段）";
    cents = 24; // 两段 GPU 生成
    const strength = Math.max(0, Math.min(1, Number(p.coverStrength) || 0.7));
    Object.assign(cloneMeta, { voiceId: voice.id, voice_name: voice.name, clone: { mode: "full", strength } });
    const guide = await postMusic(url, { mood, seconds: sec, seed, tags, bpm, lyrics, prompt: caption, instrumental: false });
    try {
      info = await postMusic(url, {
        mood, seconds: sec, seed: (seed + 1) % 4294967295, tags, bpm, lyrics, prompt: caption, instrumental: false,
        src_audio: guide.file, ref_audio: voice.ref_abs, cover_strength: strength
      });
      cloneMeta.clone.guide_seconds = guide.seconds;
    } catch (e) {
      // 诚实降级：cover 段失败 → 交段1 完整歌曲并如实标注，不冒充克隆成功、不丢候选
      info = guide;
      cloneMeta.clone.stage2_failed = true;
      cloneMeta.clone.stage2_error = String((e && e.message) || e).slice(0, 200);
    }
  } else {
    info = await postMusic(url, { mood, seconds: sec, seed, tags, bpm, lyrics, prompt: caption, instrumental: !!p.instrumental || undefined });
  }

  // wav 拷进 var/out（/var/out 静态面可播放）
  const wav = fs.readFileSync(info.file);
  const seed2 = hash12(ctx, { lane: NAME, jobId: job.id, mood, k: "real" });
  const id = "mus_" + sub(seed2, 0, 8);
  const fileName = "music_" + id + ".wav";
  const abs = writeOut(ctx, fileName, wav);
  const meta = {
    kind: "music-real", lane: NAME, engine: ENGINE + "（int8 权重档）", engine_user: engineUser,
    id, title: mood + " · " + Math.round(info.seconds) + "s", mood, sec: info.seconds,
    license: { model: "MIT", usage: "ok" }, sceneId: p.sceneId || null, asset_type: p.type || "bgm", tags: p.tags || "",
    episodeId: p.episodeId || job.episodeId || null, cents, seed: String(info.seed || ""),
    gen_seconds: info.gen_seconds, vram_peak_mb: info.vram_peak_mb, source: info.file,
    task_type: info.task_type || null, ...cloneMeta
  };
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  return {
    id, title: meta.title, mood, sec: info.seconds, license: { model: "MIT", usage: "ok" },
    engine: engineUser, engine_user: engineUser, shadow_cents: cents, sceneId: p.sceneId || null,
    asset_type: p.type || "bgm", tags: p.tags || "", voiceId: p.voiceId || null,
    art: "var/out/" + fileName, art_abs: abs
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
      const bag2 = { ok: true, cents: cand.shadow_cents, count: 1, mood, candidates: [cand], engine: cand.engine, cost_cents: cand.shadow_cents, meta: { kind: "music-real" } };
      j.result = bag2; j.art = bag2;
      return { ok: true, cents: cand.shadow_cents, art: cand.art, meta: bag2.meta };
    }
  }
  const candidates = [];
  let total = 0;
  const secFixed = Math.max(15, Math.min(120, Number(p.sec) || 0)) | 0; // 素材中心：显式时长优先（0=随机 30–60s）
  for (let i = 0; i < 3; i++) {
    const seed = hash12(ctx, { lane: NAME, jobId: j.id, i, mood, sceneId: p.sceneId || null });
    const n = numFrom(seed);
    const cents = 5 + (n % 11); // 5–15 分/条
    total += cents;
    const sec = secFixed || 30 + (numFrom(sub(seed, 4, 8)) % 31); // 30–60s
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
      asset_type: p.type || "bgm",
      tags: p.tags || "",
      episodeId: p.episodeId || j.episodeId || null,
      voiceId: p.voiceId || null,
      cloneMode: p.voiceId ? (p.cloneMode === "fast" ? "fast" : "full") : null,
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
      asset_type: p.type || "bgm",
      tags: p.tags || "",
      voiceId: p.voiceId || null,
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
