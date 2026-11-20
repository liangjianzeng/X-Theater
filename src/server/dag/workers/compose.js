"use strict";
/**
 * workers/compose.js — 成片合成（FFmpeg stub）
 * 契约 §4：读 episode 全 shots 的 takes→成片 stub 写 var/out/<episodeId>_final.mp4＋sidecar .meta.json，
 * sidecar 必含 {explicit_mark:true, implicit_mark:true, watermark:"内测水印", music:[每场挂曲及 license 快照],
 *              resolution:"1080x1920", fps:30}。确定性排序：场景 seq→镜 seq→id。
 */
const fs = require("fs");
const path = require("path");

const NAME = "compose";
const ENGINE = "FFmpeg stub";
const COST_CENTS = 20; // 合成档成本无契约硬性数字，固定 20 分（假设，见交付说明）
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
function writeOut(ctx, fileName, data) {
  const dir = path.join(String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join("var", "out")));
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, safeSeg(fileName));
  fs.writeFileSync(fp, data);
  return fp;
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
  const lib = Array.isArray(st.music_lib) ? st.music_lib : [];
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

  const seed = hash12(ctx, { lane: NAME, episodeId, shots: shotList, music });
  const fileName = safeSeg(episodeId) + "_final.mp4";
  const art = "var/out/" + fileName;

  const meta = {
    kind: "final-stub",
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
