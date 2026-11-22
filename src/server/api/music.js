"use strict";
/**
 * api/music.js — 配乐（契约 §3/§4）· 素材中心薄壳（2026-11-22 素材中心施工 A8）
 * 旧三路由全部保留为兼容面，内部改走素材库（api/library.js + st.asset_lib）：
 *  - POST /api/music/candidates {sceneId,mood} → engine.enqueue("music")；候选仍进 episode 级
 *    music_pending（cards.js C9 流照旧），但 handleJobDone 同时把无集归属任务镜像进候选池（K6 双轨）。
 *  - POST /api/music/:id/adopt {sceneId} → 素材库入库（如尚在库外）＋ 1:N 绑定（K2：primary 互斥，
 *    不再删除他场绑定）。旧「同场换曲=替换」语义由 primary 互斥承载——每场主曲唯一，曲本身保留。
 *  - POST /api/music/:id/regenerate → 重新派音乐任务（候选池/集内 pending 均支持）。
 *  - GET  /api/music/library → 素材库 music 域投影旧形状（sceneId=primary 场绑定，向后兼容）。
 */

const libMod = require("./library.js");

function findPending(ctx, id) {
  const st = ctx.store.get();
  const pend = st.music_pending || {};
  const eps = Object.keys(pend);
  for (let i = 0; i < eps.length; i++) {
    const list = pend[eps[i]] || [];
    for (let j = 0; j < list.length; j++) {
      if (list[j] && list[j].id === id) {
        return { candidate: list[j], episodeId: eps[i], list, index: j };
      }
    }
  }
  return null;
}

function findLib(ctx, id) {
  return libMod.findEntry(ctx, "music", id);
}

/** primary 场绑定 → 旧形状 sceneId 投影 */
function sceneIdOf(entry) {
  const binds = Array.isArray(entry.used_by) ? entry.used_by.filter((u) => u && u.kind === "scene") : [];
  const prim = binds.filter((u) => u.primary)[0] || binds[0];
  return prim ? prim.id : (entry.sceneId || null);
}

/** 绑定 + primary 互斥（compose 每场一条主曲；其它绑定不受影响——K2 1:N） */
function bindPrimary(ctx, entry, sid) {
  const st = ctx.store.get();
  entry.used_by = Array.isArray(entry.used_by) ? entry.used_by : [];
  if (!entry.used_by.some((u) => u && u.kind === "scene" && String(u.id) === String(sid))) {
    entry.used_by.push({ kind: "scene", id: String(sid), primary: true, at: Date.now() });
  } else {
    entry.used_by.forEach((u) => { if (u.kind === "scene" && String(u.id) === String(sid)) u.primary = true; });
  }
  (st.asset_lib.audio.music || []).forEach((m) => {
    if (m === entry || !Array.isArray(m.used_by)) return;
    m.used_by.forEach((u) => { if (u.kind === "scene" && String(u.id) === String(sid)) u.primary = false; });
  });
}

/**
 * 采纳候选（供 cards.js C9 accept 复用，签名不变）。
 * K2 语义：候选先入库（approved），再绑 sceneId（primary 互斥＝每场主曲唯一；其它绑定不受影响）。
 */
function adoptCandidate(ctx, candidateId, sceneIdOverride) {
  const st = ctx.store.get();
  const l = st.asset_lib && st.asset_lib.audio ? st.asset_lib.audio.music : null;

  const pend = findPending(ctx, candidateId);
  if (pend) {
    const cand = pend.candidate;
    const episodeId = pend.episodeId;
    const inLib = l && l.some((m) => m.id === candidateId);
    pend.list.splice(pend.index, 1); // 出临时（换批/采纳均出）
    if (inLib) {
      const entry = l.filter((m) => m.id === candidateId)[0];
      if (sceneIdOverride) bindPrimary(ctx, entry, sceneIdOverride);
      return { entry, episodeId };
    }
    // pending 候选入库（归档＋字段补齐）
    const sceneId = sceneIdOverride || cand.sceneId || null;
    const entry = {
      id: cand.id || ctx.util.uid("mus"),
      title: cand.title || "未命名配乐",
      type: cand.asset_type || "bgm",
      mood: cand.mood || "中性",
      sec: cand.sec || 45,
      tags: cand.tags || "",
      engine: cand.engine || "自部署·标准档",
      license: cand.license || { model: "MIT", usage: "missing" }, // 直接来自候选
      shadow_cents: typeof cand.shadow_cents === "number" ? cand.shadow_cents : 10,
      art: libMod.archiveArt(ctx, cand.art || null, "music") || cand.art || null, // 采用条目必须携带音频文件引用（compose BGM 依赖）
      scope: "global",
      projectId: null,
      status: "approved",
      rating: 0,
      used_by: [],
      source: "generated",
      created_at: Date.now()
    };
    st.asset_lib.audio.music.push(entry);
    if (sceneId) bindPrimary(ctx, entry, sceneId);
    if (episodeId) entry.episodeId = episodeId; // 来源集留痕（旧字段兼容）
    return { entry, episodeId };
  }

  const entry = findLib(ctx, candidateId);
  if (!entry) throw { code: "NOT_FOUND", message: "候选不存在: " + candidateId };
  if (sceneIdOverride) bindPrimary(ctx, entry, sceneIdOverride);
  return { entry, episodeId: entry.episodeId || null };
}

function register(router, ctx) {
  const { store, engine, util, bus } = ctx;

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  // POST /api/music/candidates {sceneId,mood} —— 集内自动流保留（C4 拍板派生也走这里）
  router.add(
    "POST",
    "/api/music/candidates",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const b = body || {};
      const scene = (st.scenes || {})[b.sceneId];
      if (!scene) throw { code: "NOT_FOUND", message: "场景不存在: " + b.sceneId };
      const mood = b.mood || scene.mood || "中性";
      const job = engine.enqueue(
        "music",
        { episodeId: scene.episodeId, sceneId: scene.id, mood },
        { episodeId: scene.episodeId, initiated_by: "user" }
      );
      audit(auth, "music_candidates", scene.id, { mood, job_id: job && job.id });
      return router.json(res, 202, { job, sceneId: scene.id, mood, expected: 3 });
    },
    { auth: true }
  );

  // POST /api/music/:id/adopt {sceneId}
  router.add(
    "POST",
    "/api/music/:id/adopt",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const r = adoptCandidate(ctx, params.id, body && body.sceneId);
      store.commit();
      audit(auth, "music_adopt", params.id, {
        sceneId: sceneIdOf(r.entry),
        license: r.entry.license
      });
      try {
        bus.publish("cards", { event: "music_adopted", music: oldShape(r.entry) });
      } catch (e) {}
      return router.json(res, 200, { music: oldShape(r.entry), library: (store.get().asset_lib.audio.music || []).filter((m) => m.status !== "retired").length });
    },
    { auth: true }
  );

  // POST /api/music/:id/regenerate —— 换一批（集内 pending / 素材库条目均可）
  router.add(
    "POST",
    "/api/music/:id/regenerate",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      let sceneId = null;
      let mood = null;
      let episodeId = null;
      const pend = findPending(ctx, params.id);
      if (pend) {
        sceneId = pend.candidate.sceneId;
        mood = pend.candidate.mood;
        episodeId = pend.episodeId;
        pend.list.splice(pend.index, 1); // 换一批：移除旧候选
      } else {
        const entry = findLib(ctx, params.id);
        if (!entry) throw { code: "NOT_FOUND", message: "候选不存在: " + params.id };
        sceneId = sceneIdOf(entry);
        mood = entry.mood;
        const sc = sceneId ? (st.scenes || {})[sceneId] : null;
        episodeId = entry.episodeId || (sc && sc.episodeId) || null;
      }
      const job = engine.enqueue(
        "music",
        { episodeId, sceneId, mood },
        { episodeId: episodeId || undefined, initiated_by: "user" }
      );
      audit(auth, "music_regenerate", params.id, { sceneId, job_id: job && job.id });
      return router.json(res, 202, { job, sceneId, mood, expected: 3 });
    },
    { auth: true }
  );

  // GET /api/music/library —— 素材库 music 域旧形状投影
  router.add(
    "GET",
    "/api/music/library",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const list = ((st.asset_lib && st.asset_lib.audio && st.asset_lib.audio.music) || [])
        .filter((m) => m && m.status !== "retired")
        .map(oldShape);
      return router.json(res, 200, { library: list });
    },
    { auth: true }
  );
}

/** 新条目 → 旧形状（cards.js V10 等读取面兼容） */
function oldShape(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    title: entry.title,
    mood: entry.mood,
    sec: entry.sec,
    engine: entry.engine,
    license: entry.license,
    shadow_cents: entry.shadow_cents,
    art: entry.art,
    sceneId: sceneIdOf(entry),
    episodeId: entry.episodeId || null
  };
}

module.exports.register = register;
module.exports.adoptCandidate = adoptCandidate;
module.exports.findPending = findPending;
module.exports.oldShape = oldShape;
