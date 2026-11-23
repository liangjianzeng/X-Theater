"use strict";
/**
 * workers/compose.js — 成片合成（FFmpeg）
 * 契约 §4：读 episode 全 shots 的 takes→成片写 var/out/<episodeId>_final.mp4＋sidecar .meta.json，
 * sidecar 必含 {explicit_mark:true, implicit_mark:true, watermark:"内测水印", music:[每场挂曲及 license 快照],
 *              resolution, fps}。确定性排序：场景 seq→镜 seq→id。
 * 交付口径（2026-11-23 用户令「交付了就要存库随时可看」）：
 *  - purpose=export＝真合成出货：runtime/bin/ffmpeg.exe 在就真跑；缺→如实报错（COMPOSE_NO_FFMPEG），
 *    绝不再写 28 字节占位冒充交付成片（床头情歌 stub 出货事故根因：旧版靠 THEATER_COMPOSE_REAL=1 才真跑，
 *    重启丢环境变量→静默出货占位）。
 *  - THEATER_COMPOSE_REAL=0＝显式 stub 模式（验收套件专用）：写占位＋meta 如实标 placeholder/kind:*-stub。
 *  - purpose=preview（C5 样片）永远走占位链且写 <episodeId>_preview.mp4——不再覆写已出货的 _final。
 */
const fs = require("fs");
const path = require("path");

const NAME = "compose";
const ENGINE = "FFmpeg stub";
const COST_CENTS = 20; // 合成档成本无契约硬性数字，固定 20 分（假设，见交付说明）
const MP4_STUB = Buffer.from("\x00\x00\x00\x20ftypiso6\x00\x00\x02\x00iso6avc1mp41", "latin1");
const FFMPEG_EXE = path.join(process.cwd(), "runtime", "bin", "ffmpeg.exe");
function hasFfmpeg() {
  return fs.existsSync(FFMPEG_EXE);
}
// 显式 stub 模式仅一个值 "0"（验收套件）；未设/其它值＝真合成默认（有 ffmpeg 就真跑）
function stubMode() {
  return process.env.THEATER_COMPOSE_REAL === "0";
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
function sub(hex, start, len) {
  const h = String(hex || "0");
  const reps = Math.ceil((start + len) / h.length) + 1;
  return h.repeat(reps).slice(start, start + len);
}
function safeSeg(s) {
  const v = String(s == null ? "" : s)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 120);
  return v || "x";
}
/* var 数据根（2026-11-23 深审 D1 收口）：cfg.varDir＝唯一事实源；兜底 process.cwd()/var＝cfg 缺省旧行为。
   runtime/bin/ffmpeg.exe 等仓库根静态二进制不受 THEATER_VAR 影响，仍走 process.cwd()（仓库根约定）。 */
function vdir(ctx) {
  return (ctx && ctx.cfg && ctx.cfg.varDir) || path.join(process.cwd(), "var");
}
function writeOut(ctx, fileName, data) {
  const dir = path.join(String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join(vdir(ctx), "out")));
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, safeSeg(fileName));
  fs.writeFileSync(fp, data);
  return fp;
}

function runFfmpeg(ctx, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    if (!hasFfmpeg()) return reject(Object.assign(new Error("ffmpeg 不存在（runtime/bin）"), { code: "NO_FFMPEG" }));
    const pr = spawn(FFMPEG_EXE, args, { cwd: process.cwd() });
    let err = "";
    pr.stderr.on("data", (d) => { err = (err + String(d)).slice(-4000); });
    pr.on("close", (code) => code === 0 ? resolve(true) : reject(Object.assign(new Error("ffmpeg 失败：" + err.slice(-400))), { code: "FFMPEG_FAIL" }));
    pr.on("error", (e) => reject(Object.assign(new Error("ffmpeg 启动失败：" + e.message), { code: "FFMPEG_SPAWN" })));
    setTimeout(() => { try { pr.kill(); } catch (e) {} reject(Object.assign(new Error("ffmpeg 超时"), { code: "FFMPEG_TIMEOUT" })); }, timeoutMs || 600000).unref();
  });
}

/** ffmpeg -i stderr 解析时长与音轨存在性（essentials 包无 ffprobe） */
function probeMedia(file) {
  return new Promise((resolve) => {
    const { spawn } = require("child_process");
    const pr = spawn(FFMPEG_EXE, ["-i", file], { cwd: process.cwd() });
    let err = "";
    pr.stderr.on("data", (d) => { err += String(d); });
    pr.on("close", () => {
      const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(err);
      const sec = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
      resolve({ sec, hasAudio: /Stream.*Audio:/.test(err) });
    });
    pr.on("error", () => resolve({ sec: null, hasAudio: false }));
    setTimeout(() => { try { pr.kill(); } catch (e) {} resolve({ sec: null, hasAudio: false }); }, 15000).unref();
  });
}

/** art 虚拟路径（var/out/x）→ 物理文件：优先 cfg.outDir＋basename（THEATER_VAR 部署可变），兜底 varDir 字面路径 */
function resolveArt(ctx, art) {
  const a = String(art || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const base = String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join(vdir(ctx), "out"));
  const byBase = path.join(base, path.basename(a));
  if (fs.existsSync(byBase)) return byBase;
  return path.join(vdir(ctx), a.replace(/^var\//, ""));
}
function stripLead(s) {
  let x = String(s == null ? "" : s);
  while (x.startsWith("/") || x.startsWith("\\")) x = x.slice(1);
  return x;
}

/** 可用中文字体（字幕烧录）：msyh → simhei → null（无字体时诚实跳过烧录，cue 仍记 meta） */
function pickZhFont() {
  const cands = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/simhei.ttf"];
  for (const f of cands) {
    if (fs.existsSync(f)) return f;
  }
  return null;
}

async function runReal(ctx, job, p, episodeId, shotsSorted, musicInfo, lib) {
  // 真合成：片头字幕卡 2s + 逐镜 take（best）拼接 + 转场衔接镜织入 + BGM 全程垫底 + 台词对位 + 字幕烧录
  const outDir = path.join(String(ctx.cfg && ctx.cfg.outDir || path.join("var", "out")));
  const tmp = path.join(outDir, "_compose_" + safeSeg(episodeId));
  fs.mkdirSync(tmp, { recursive: true });
  const parts = [];
  const episode = (ctx.store.get().episodes || {})[episodeId] || {};
  const stReal = (ctx && ctx.store && typeof ctx.store.get === "function" && ctx.store.get()) || {};
  const settingsReal = stReal.settings || {};
  // 1) 片头字幕卡（黑底白字 2s；垫无声轨保证 concat 流统一）
  const title = (episode.title || "短剧") + "｜" + String(episode.brief || "").slice(0, 20);
  const cardMp4 = path.join(tmp, "card.mp4");
  // 片头卡 drawtext 显式 fontfile（Windows fontconfig 回退不可靠，缺字/失败会炸整个交付任务，2026-11-23 E2E 前加固）
  const cardFont = pickZhFont();
  const cardVf = "drawtext=" + (cardFont ? "fontfile=" + cardFont.replace(/\\/g, "/").replace(":", "\\:") + ":" : "") +
    "text=" + JSON.stringify(title.replace(/['":\\]/g, "").slice(0, 30)) + ":fontcolor=white:fontsize=34:x=(w-text_w)/2:y=(h-text_h)/2";
  await runFfmpeg(ctx, ["-y", "-f", "lavfi", "-i", "color=c=black:s=720x1280:d=2:r=24",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-map", "0:v", "-map", "1:a", "-shortest",
    "-vf", cardVf,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", cardMp4], 120000);
  parts.push(cardMp4);
  const partShots = [null]; // parts[i] ↔ 镜对象（0=片头卡；转场镜段=null）
  const speechBySeq = {}; // 镜 seq → take 自带原生说话声（compose 不再叠 TTS）
  // 转场衔接镜（FR-506 落地 2026-11-22）：from=镜A 且 to=紧随镜B → B 前织入衔接段
  const transitionsAll = Object.keys(stReal.transitions || {})
    .map((k) => stReal.transitions[k])
    .filter((t) => t && t.episodeId === episodeId && t.take && t.take.art);
  const transUsed = [];
  // 2) 逐镜 take（best 条）——音轨统一重编码（aac 48k stereo；video copy）
  for (let si = 0; si < shotsSorted.length; si++) {
    const s = shotsSorted[si];
    const takes = (s.takes || []).filter((t) => t && t.art);
    if (!takes.length) continue;
    // 选条：优先显式 best 标志（取最后一条——新拍覆盖旧拍）；否则最新一条
    const bests = takes.filter((t) => t.best);
    const best = bests[bests.length - 1] || takes[takes.length - 1];
    const src = resolveArt(ctx, best.art);
    if (!fs.existsSync(src)) throw Object.assign(new Error("镜 take 文件缺失：" + src), { code: "TAKE_MISSING" });
    if (best.native_speech) speechBySeq[Number(s.seq)] = true; // take 自带说话声
    const info = await probeMedia(src);
    const norm = path.join(tmp, "norm_" + path.basename(src));
    if (info.hasAudio) {
      await runFfmpeg(ctx, ["-y", "-i", src, "-map", "0:v", "-map", "0:a",
        "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", norm], 120000);
    } else {
      await runFfmpeg(ctx, ["-y", "-i", src, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-map", "0:v", "-map", "1:a", "-shortest",
        "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", norm], 120000);
    }
    parts.push(norm);
    partShots.push(s);
    // 2.5) 转场衔接镜织入：from=当前镜 且 to=下一镜（shotsSorted 邻接）→ 取 best 衔接 take
    const next = shotsSorted[si + 1];
    if (next) {
      const tr = transitionsAll.find((t) => String(t.fromShotId) === String(s.id) && String(t.toShotId) === String(next.id));
      if (tr) {
        const trSrc = resolveArt(ctx, tr.take.art);
        if (fs.existsSync(trSrc)) {
          const trInfo = await probeMedia(trSrc);
          const trNorm = path.join(tmp, "norm_tr_" + path.basename(trSrc));
          if (trInfo.hasAudio) {
            await runFfmpeg(ctx, ["-y", "-i", trSrc, "-map", "0:v", "-map", "0:a",
              "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", trNorm], 120000);
          } else {
            await runFfmpeg(ctx, ["-y", "-i", trSrc, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
              "-map", "0:v", "-map", "1:a", "-shortest",
              "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", trNorm], 120000);
          }
          parts.push(trNorm);
          partShots.push(null);
          transUsed.push(tr.id);
        }
      }
    }
  }
  if (parts.length < 2) throw Object.assign(new Error("无可拼接镜头（takes 不足）"), { code: "NO_TAKES" });
  // 3) concat 列表
  const listFile = path.join(tmp, "list.txt");
  fs.writeFileSync(listFile, parts.map((f) => "file '" + String(f).replace(/\\/g, "/") + "'").join("\n"));
  // 3.2) 段时间轴起点（parts 顺序＝片头卡＋shotsSorted（含织入的转场段））
  const starts = [];
  let cum = 0;
  for (let i = 0; i < parts.length; i++) {
    starts[i] = cum;
    const d = await probeMedia(parts[i]);
    cum += (d && d.sec) || 0;
  }
  const ends = parts.map((_, i) => (i + 1 < parts.length ? starts[i + 1] : cum));
  // 3.5) 台词对位：voice 真实产物按台词文本对齐全局镜序（LTX 音轨是环境声，台词必须叠加）
  const dlgInputs = [];
  const dlgFilters = [];
  const epScript = ((stReal.episodes || {})[episodeId] || {}).script || null;
  try {
    const jobs = (ctx.engine && typeof ctx.engine.listJobs === "function")
      ? ctx.engine.listJobs({ episodeId: episodeId, status: "done" }).filter((jb) => jb && jb.type === "voice" && jb.result && Array.isArray(jb.result.lines))
      : [];
    const pool = ((stReal.voice_lines || {})[episodeId] || []).filter((l) => l && l.text && l.art).slice();
    jobs.forEach((jb) => (jb.result.lines || []).forEach((l) => { if (l && l.text && l.art) pool.push(l); }));
    // 剧本扁平镜序（与 t2i.local 分镜绑定同一口径）：场序 si、场内镜序 i → shot.seq=(si+1)*100+i+1
    const flat = [];
    (epScript && epScript.scenes || []).forEach((sc, si) => (sc.shots || []).forEach((sh, i) => flat.push({ si, i, dialogue: sh.dialogue || null })));
    const usedArts = {};
    for (const f of flat) {
      if (!f.dialogue) continue;
      const ln = pool.find((l) => l.text === f.dialogue && !usedArts[l.art]);
      if (!ln) continue;
      const expectedSeq = (f.si + 1) * 100 + f.i + 1;
      const partIdx = partShots.findIndex((ps) => ps && Number(ps.seq) === expectedSeq);
      if (partIdx < 0) continue; // 该镜无 take，不混
      if (speechBySeq[expectedSeq]) continue; // take 已含原生说话声，不再叠 TTS
      const wavAbs = resolveArt(ctx, ln.art);
      if (!fs.existsSync(wavAbs)) continue;
      usedArts[ln.art] = true;
      const ms = Math.round((starts[partIdx] || 0) * 1000);
      const di = dlgInputs.length;
      dlgInputs.push(wavAbs);
      dlgFilters.push("[" + (2 + di) + ":a]aresample=48000,aformat=channel_layouts=stereo" + (ms > 0 ? ",adelay=" + ms + ":all=1" : "") + "[d" + di + "]");
    }
  } catch (e) { /* 台词对位失败不阻断成片（BGM/画面兜底） */ }
  // 3.7) 字幕 cue（梯队②，确定性）：台词镜从段起点起，按 5 字/秒估时（与 aireview 语速校验同口径），
  // 上限＝段长；native_speech 镜同样出 cue（LTX 台词听感起始不确定，取段起点＋0.3s 缓冲）。
  const subtitleCues = [];
  const subsOn = settingsReal.subtitles !== "off";
  if (subsOn && epScript) {
    const flat = [];
    (epScript.scenes || []).forEach((sc, si) => (sc.shots || []).forEach((sh, i) => flat.push({ si, i, dialogue: sh.dialogue || null })));
    for (const f of flat) {
      if (!f.dialogue) continue;
      const expectedSeq = (f.si + 1) * 100 + f.i + 1;
      const partIdx = partShots.findIndex((ps) => ps && Number(ps.seq) === expectedSeq);
      if (partIdx < 0) continue;
      const segSec = Math.max(0.5, (ends[partIdx] || cum) - (starts[partIdx] || 0));
      const dur = Math.min(Math.max(String(f.dialogue).length / 5, 1.2), segSec);
      subtitleCues.push({
        t0: Number((starts[partIdx] + 0.15).toFixed(2)),
        t1: Number((starts[partIdx] + 0.15 + dur).toFixed(2)),
        text: String(f.dialogue)
      });
    }
  }
  // 4) 终混：concat（含环境声）＋BGM 垫底＋台词对位叠加（normalize=0 保留各轨电平）
  // 素材中心（2026-11-22）：取曲读 asset_lib——本集场景的 primary 绑定优先，其次任意绑定，最后旧 sceneId 字段
  const scenesReal = stReal.scenes || {};
  const epSceneIds = new Set(
    Object.keys(scenesReal)
      .map((k) => scenesReal[k])
      .filter((sc) => sc && sc.episodeId === episodeId)
      .map((sc) => String(sc.id))
  );
  const boundOf = (m, wantPrimary) =>
    (Array.isArray(m.used_by) ? m.used_by : []).some(
      (u) => u && u.kind === "scene" && epSceneIds.has(String(u.id)) && (!wantPrimary || u.primary)
    );
  const adopted =
    (lib || []).find((m) => m && m.art && boundOf(m, true)) ||
    (lib || []).find((m) => m && m.art && boundOf(m, false)) ||
    (lib || []).find((m) => m && m.sceneId && m.art);
  const bgm = adopted && fs.existsSync(resolveArt(ctx, adopted.art)) ? resolveArt(ctx, adopted.art) : null;
  // 环境音铺底（素材中心 C2，2026-11-22）：本集各场绑定的 ambience 素材，按该场首镜起点延迟混入（音量 0.12）；
  // 失败不阻断成片（与台词对位同一容错口径）。SFX 事件级时间轴需要点位编辑器，本期不做（见实施记录）。
  const ambInputs = [];
  const ambFilters = [];
  try {
    const ambLib = (stReal.asset_lib && stReal.asset_lib.audio && Array.isArray(stReal.asset_lib.audio.ambience)) ? stReal.asset_lib.audio.ambience : [];
    const scAll = Object.keys(scenesReal).map((k) => scenesReal[k])
      .filter((sc) => sc && sc.episodeId === episodeId)
      .sort((a, b) => (a.seq || 0) - (b.seq || 0));
    scAll.forEach((sc) => {
      const amb = ambLib.find((a) => a && a.art && (Array.isArray(a.used_by) ? a.used_by : []).some((u) => u && u.kind === "scene" && String(u.id) === String(sc.id)));
      if (!amb) return;
      const abs = resolveArt(ctx, amb.art);
      if (!fs.existsSync(abs)) return;
      const partIdx = partShots.findIndex((ps) => ps && Number(ps.seq) > (sc.seq || 0) * 100 && Number(ps.seq) <= ((sc.seq || 0) + 1) * 100);
      if (partIdx < 0) return;
      const ms = Math.round((starts[partIdx] || 0) * 1000);
      const ai = ambInputs.length;
      ambInputs.push(abs);
      ambFilters.push("[" + (2 + dlgInputs.length + ai) + ":a]aresample=48000,aformat=channel_layouts=stereo,volume=0.12" + (ms > 0 ? ",adelay=" + ms + ":all=1" : "") + "[a" + ai + "]");
    });
  } catch (e) { /* 环境音失败不阻断成片 */ }
  const finalName = safeSeg(episodeId) + "_final.mp4";
  const finalPath = path.join(outDir, finalName);
  if ((bgm || dlgInputs.length || ambInputs.length) && fs.existsSync(path.join(tmp, "list.txt"))) {
    const inputs = ["-y", "-f", "concat", "-safe", "0", "-i", listFile];
    if (bgm) inputs.push("-i", bgm);
    dlgInputs.forEach((f) => inputs.push("-i", f));
    ambInputs.forEach((f) => inputs.push("-i", f));
    const fc = [];
    let mix = "[0:a]";
    if (bgm) { fc.push("[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.18[b]"); mix += "[b]"; }
    dlgFilters.forEach((f) => fc.push(f));
    ambFilters.forEach((f) => fc.push(f));
    for (let i = 0; i < dlgInputs.length; i++) mix += "[d" + i + "]";
    for (let i = 0; i < ambInputs.length; i++) mix += "[a" + i + "]";
    const nIn = 1 + (bgm ? 1 : 0) + dlgInputs.length + ambInputs.length;
    fc.push(mix + "amix=inputs=" + nIn + ":duration=first:normalize=0[aout]");
    await runFfmpeg(ctx, inputs.concat(["-filter_complex", fc.join(";"),
      "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", finalPath]), 600000);
  } else {
    await runFfmpeg(ctx, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", finalPath], 600000);
  }
  // 5) 字幕烧录（梯队②）：drawtext 按 cue enable 窗口叠加，底部安全区（距底 8% 高度＋边框）。
  // 无中文字体 → 诚实跳过烧录（cue 仍记 meta，交付预检可核对）。
  let burned = false;
  if (subtitleCues.length) {
    const font = pickZhFont();
    if (font) {
      const fontArg = "fontfile=" + font.replace(/\\/g, "/").replace(":", "\\:");
      const chain = subtitleCues.map((c) => {
        const txt = String(c.text).replace(/['"\\:;,%]/g, "");
        return "drawtext=" + fontArg + ":text=" + JSON.stringify(txt) +
          ":fontcolor=white:fontsize=44:borderw=2:bordercolor=black@0.8" +
          ":x=(w-text_w)/2:y=h-text_h-h*0.08" +
          ":enable='between(t," + c.t0 + "," + c.t1 + ")'";
      }).join(",");
      const subPath = finalPath.replace(/\.mp4$/, "_sub.mp4");
      await runFfmpeg(ctx, ["-y", "-i", finalPath, "-vf", chain,
        "-c:v", "libx264", "-crf", "20", "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "copy", subPath], 900000);
      try { fs.unlinkSync(finalPath); fs.renameSync(subPath, finalPath); } catch (e) { /* 重命名失败保留两版 */ }
      burned = true;
    }
  }
  // 6) 升帧（梯队④，默认关）：settings.interp_fps > 输出帧率 → minterpolate 补帧（观感顺滑；慢，慎开）
  let outFps = 24;
  const interpFps = Number(settingsReal.interp_fps) || 0;
  if (interpFps > 24) {
    const ipPath = finalPath.replace(/\.mp4$/, "_ip.mp4");
    await runFfmpeg(ctx, ["-y", "-i", finalPath, "-vf", "minterpolate=fps=" + Math.round(interpFps) + ":mi_mode=mci:mc_mode=aobmc:vsbmc=1",
      "-c:v", "libx264", "-crf", "20", "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "copy", ipPath], 1800000);
    try { fs.unlinkSync(finalPath); fs.renameSync(ipPath, finalPath); } catch (e) { /* 重命名失败保留两版 */ }
    outFps = Math.round(interpFps);
  }
  return { finalPath, finalName, parts: parts.length, bgm: bgm || null, dialogue: dlgInputs.length, transUsed, subtitleCues, subtitlesBurned: burned, fps: outFps };
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const episodeId = p.episodeId || j.episodeId || (j.opts && j.opts.episodeId) || null;
  if (!episodeId) {
    const err = new Error("compose 缺少 episodeId");
    err.code = "BAD_JOB";
    throw err;
  }
  const st = (ctx && ctx.store && typeof ctx.store.get === "function" && ctx.store.get()) || {};
  const allShots = st.shots || {};
  const scenes = st.scenes || {};
  // 素材中心（2026-11-22）：曲库读 asset_lib（迁移后 music_lib 保留只读一版作兜底）
  const lib =
    st.asset_lib && st.asset_lib.audio && Array.isArray(st.asset_lib.audio.music)
      ? st.asset_lib.audio.music
      : Array.isArray(st.music_lib)
        ? st.music_lib
        : [];
  const episode = (st.episodes || {})[episodeId] || {};

  const shots = Object.keys(allShots)
    .map((k) => allShots[k])
    .filter((s) => s && s.episodeId === episodeId);
  const sceneSeqOf = (sceneId) => (scenes[sceneId] && Number(scenes[sceneId].seq)) || 0;
  shots.sort(
    (a, b) =>
      sceneSeqOf(a.sceneId) - sceneSeqOf(b.sceneId) ||
      (Number(a.seq) || 0) - (Number(b.seq) || 0) ||
      String(a.id).localeCompare(String(b.id))
  );

  const shotList = [];
  const takeFiles = [];
  for (const s of shots) {
    const takes = Array.isArray(s.takes) ? s.takes : [];
    for (const t of takes) {
      if (t && t.art) takeFiles.push(t.art);
    }
    shotList.push({
      id: s.id,
      sceneId: s.sceneId || null,
      seq: s.seq == null ? null : s.seq,
      name: s.name || null,
      sec: s.sec == null ? null : s.sec,
      takes: takes.length
    });
  }

  const sceneIds = [];
  for (const s of shots) if (s.sceneId && sceneIds.indexOf(s.sceneId) < 0) sceneIds.push(s.sceneId);
  const music = lib
    .filter((m) => m && m.sceneId && sceneIds.indexOf(m.sceneId) >= 0)
    .slice()
    .sort((a, b) => String(a.sceneId).localeCompare(String(b.sceneId)) || String(a.id).localeCompare(String(b.id)))
    .map((m) => ({
      sceneId: m.sceneId,
      sceneName: (scenes[m.sceneId] && scenes[m.sceneId].name) || null,
      trackId: m.id || null,
      title: m.title || null,
      mood: m.mood || null,
      sec: m.sec == null ? null : m.sec,
      license: {
        model: (m.license && m.license.model) || null,
        usage: (m.license && m.license.usage) || null
      }
    }));

  if (p.purpose === "export" && !stubMode()) {
    // 交付出货＝真合成（2026-11-23 铁规）：ffmpeg 缺→如实报错，绝不写占位冒充成片
    if (!hasFfmpeg()) {
      throw Object.assign(new Error("本机 ffmpeg 缺失（runtime/bin/ffmpeg.exe），无法真合成出货；stub 占位不算交付"), {
        code: "COMPOSE_NO_FFMPEG"
      });
    }
    const t0 = Date.now();
    const real = await runReal(ctx, job, p, episodeId, shots, music, lib);
    const seedR = hash12(ctx, { lane: NAME, episodeId, k: "real" });
    const fileName = real.finalName;
    const art = "var/out/" + fileName;
    const meta = {
      kind: "final-comfy", lane: NAME, engine: "FFmpeg 6.0（真合成）",
      episodeId, episodeTitle: episode.title || null, purpose: "export",
      explicit_mark: true, implicit_mark: true, watermark: "内测水印",
      resolution: "720x1280", fps: real.fps || 24, music, shots: shotList, parts: real.parts,
      bgm: real.bgm, dialogue_lines: real.dialogue != null ? real.dialogue : null,
      transitions_used: real.transUsed || [],
      subtitles: { enabled: (real.subtitleCues || []).length > 0, burned: !!real.subtitlesBurned, cues: real.subtitleCues || [] },
      delivered_at: new Date().toISOString(),
      gen_seconds: Math.round((Date.now() - t0) / 1000), seed: seedR
    };
    writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
    const bag = { ok: true, cents: COST_CENTS, art, path: art, meta, engine: "FFmpeg 6.0（真合成）", resolution: meta.resolution, fps: meta.fps, watermark: meta.watermark };
    job.result = bag; job.art = bag;
    return { ok: true, cents: COST_CENTS, art, meta };
  }
  const seed = hash12(ctx, { lane: NAME, episodeId, shots: shotList, music });
  // preview（C5 样片）永远占位且独立命名；_final 文件名只属于真交付或显式 stub 模式（验收套件）
  const isExportStub = p.purpose === "export";
  const fileName = safeSeg(episodeId) + (isExportStub ? "_final" : "_preview") + ".mp4";
  const art = "var/out/" + fileName;

  const meta = {
    kind: isExportStub ? "final-stub" : "preview-stub",
    placeholder: true, // 占位如实标注（UI 据此显示「占位」而非「合成完成」）
    lane: NAME,
    engine: ENGINE,
    episodeId,
    episodeTitle: episode.title || null,
    purpose: p.purpose || "preview",
    explicit_mark: true,
    implicit_mark: true,
    watermark: "内测水印",
    resolution: "1080x1920",
    fps: 30,
    music,
    shots: shotList,
    takes: takeFiles.length,
    take_files: takeFiles,
    seed
  };
  const abs = writeOut(ctx, fileName, MP4_STUB);
  writeOut(ctx, fileName + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  meta.art_abs = abs;

  const bag = { ok: true, cents: COST_CENTS, art, path: art, meta, engine: ENGINE, resolution: meta.resolution, fps: meta.fps, watermark: meta.watermark };
  j.result = bag;
  j.art = bag; // onComposeDone：audit artifacts 取 job.art.art || job.art.path
  return { ok: true, cents: COST_CENTS, art, meta };
}

module.exports = { name: NAME, lane: NAME, run };
