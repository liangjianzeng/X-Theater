"use strict";
/**
 * api/music.js — 配乐（契约 §3/§4）
 * POST /api/music/candidates {sceneId,mood} → engine.enqueue("music",{sceneId,mood}) → 3 候选入临时（episode 级 music_pending，由 cards.js jobs-done 监听落账）。
 * POST /api/music/:id/adopt {sceneId} → 入库 music_lib（license 对象直接来自候选）＋sceneId 挂接（同场换曲＝替换）＋audit。
 * POST /api/music/:id/regenerate → 重 enqueue。 GET /api/music/library → music_lib。
 */

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
  const st = ctx.store.get();
  const hit = (st.music_lib || []).filter((m) => m.id === id)[0] || null;
  return hit;
}

/**
 * 采纳候选入库（供 cards.js C9 accept 复用）。
 * 同 sceneId 已有曲 → 替换（换曲语义）。license 对象直接来自候选。
 */
function adoptCandidate(ctx, candidateId, sceneIdOverride) {
  const st = ctx.store.get();
  let cand = null;
  let episodeId = null;
  const pend = findPending(ctx, candidateId);
  if (pend) {
    cand = pend.candidate;
    episodeId = pend.episodeId;
    pend.list.splice(pend.index, 1); // 出临时
  } else {
    cand = findLib(ctx, candidateId);
    if (!cand) throw { code: "NOT_FOUND", message: "候选不存在: " + candidateId };
    episodeId = cand.episodeId || null;
  }
  const sceneId = sceneIdOverride || cand.sceneId || null;
  st.music_lib = (st.music_lib || []).filter((m) => !(sceneId && m.sceneId === sceneId));
  const entry = {
    id: cand.id || ctx.util.uid("mus"),
    title: cand.title || "未命名配乐",
    mood: cand.mood || "中性",
    sec: cand.sec || 45,
    engine: cand.engine || "ACE-Step 1.5",
    license: cand.license || { model: "MIT", usage: "missing" }, // 直接来自候选
    shadow_cents: typeof cand.shadow_cents === "number" ? cand.shadow_cents : 10,
    art: cand.art || null, // 采用条目必须携带音频文件引用（compose BGM 依赖）
    sceneId
  };
  st.music_lib.push(entry);
  return { entry, episodeId };
}

function register(router, ctx) {
  const { store, engine, util, bus } = ctx;

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  // POST /api/music/candidates {sceneId,mood}
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
        sceneId: r.entry.sceneId,
        license: r.entry.license
      });
      try {
        bus.publish("cards", { event: "music_adopted", music: r.entry });
      } catch (e) {}
      return router.json(res, 200, { music: r.entry, library: (store.get().music_lib || []).length });
    },
    { auth: true }
  );

  // POST /api/music/:id/regenerate
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
        const lib = findLib(ctx, params.id);
        if (!lib) throw { code: "NOT_FOUND", message: "候选不存在: " + params.id };
        sceneId = lib.sceneId;
        mood = lib.mood;
        const sc = sceneId ? (st.scenes || {})[sceneId] : null;
        episodeId = lib.episodeId || (sc && sc.episodeId) || null;
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

  // GET /api/music/library
  router.add(
    "GET",
    "/api/music/library",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      return router.json(res, 200, { library: st.music_lib || [] });
    },
    { auth: true }
  );
}

module.exports.register = register;
module.exports.adoptCandidate = adoptCandidate;
module.exports.findPending = findPending;
