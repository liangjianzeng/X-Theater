"use strict";
/**
 * api/postprod.js — 后期三车道 REST（对标调研第二梯队·2026-11-22）
 *   POST /api/shots/:id/lipsync   {takeId?}  → 口型重绘（台词镜后处理；需该镜有 take＋已配音）
 *   POST /api/shots/:id/superres  {takeId?}  → 超分 720→1080p（SeedVR2 档）
 *   POST /api/episodes/:id/sfx    {desc,sec?,sceneId?} → 音效拟音 → asset_lib.audio.sfx
 * 全部走 governance（engine.enqueue，影子记账）；默认 stub，真引擎通道见各 worker 头注。
 */
const Tenants = require("../core/tenants.js");

module.exports.register = function register(router, ctx) {
  const { store, engine } = ctx;

  function requireShot(shotId) {
    const st = store.get();
    const shot = (st.shots || {})[String(shotId)];
    if (!shot) throw { code: "NOT_FOUND", message: "镜头不存在" };
    return shot;
  }
  function audit(auth, action, target, extra) {
    store.log("audit", Object.assign({ operator: auth && auth.id, action, target }, extra || {}));
  }
  function guardWrite(st, auth, epId) {
    const ep = (st.episodes || {})[epId] || {};
    Tenants.guardWrite(st, auth, ep.tenantId || Tenants.defaultTid(st));
  }
  function guardRead(st, auth, epId) {
    const ep = (st.episodes || {})[epId] || {};
    Tenants.guardRead(st, auth, ep.tenantId || Tenants.defaultTid(st));
  }

  // POST /api/shots/:id/lipsync {takeId?}
  router.add("POST", "/api/shots/:id/lipsync", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const st = store.get();
    const shot = requireShot(params.id);
    const epId = shot.episodeId;
    guardWrite(st, auth, epId);
    const job = engine.enqueue(
      "lipsync",
      { episodeId: epId, shotId: shot.id, takeId: (body && body.takeId) || undefined },
      { episodeId: epId, initiated_by: "user" }
    );
    audit(auth, "lipsync", shot.id, { job_id: job && job.id });
    return router.json(res, 202, { job });
  }, { auth: true });

  // POST /api/shots/:id/superres {takeId?}
  router.add("POST", "/api/shots/:id/superres", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const st = store.get();
    const shot = requireShot(params.id);
    const epId = shot.episodeId;
    guardWrite(st, auth, epId);
    const job = engine.enqueue(
      "superres",
      { episodeId: epId, shotId: shot.id, takeId: (body && body.takeId) || undefined },
      { episodeId: epId, initiated_by: "user" }
    );
    audit(auth, "superres", shot.id, { job_id: job && job.id });
    return router.json(res, 202, { job });
  }, { auth: true });

  // POST /api/episodes/:id/sfx {desc, sec?, sceneId?}
  router.add("POST", "/api/episodes/:id/sfx", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const st = store.get();
    const ep = (st.episodes || {})[params.id];
    if (!ep) throw { code: "NOT_FOUND", message: "剧集不存在" };
    guardWrite(st, auth, ep.id);
    const desc = String((body && body.desc) || "").trim();
    if (!desc) throw { code: "BAD_REQUEST", message: "缺少 desc（音效描述）" };
    const sceneId = (body && body.sceneId) || undefined;
    if (sceneId && !(st.scenes || {})[sceneId]) throw { code: "NOT_FOUND", message: "场景不存在" };
    const job = engine.enqueue(
      "sfx",
      { episodeId: ep.id, desc, sec: Number(body && body.sec) > 0 ? Number(body.sec) : undefined, sceneId },
      { episodeId: ep.id, initiated_by: "user" }
    );
    audit(auth, "sfx", ep.id, { job_id: job && job.id, desc: desc.slice(0, 40) });
    return router.json(res, 202, { job });
  }, { auth: true });

  // GET /api/episodes/:id/sfx — 本集音效素材清单
  router.add("GET", "/api/episodes/:id/sfx", (req, res, body, params, auth) => {
    const st = store.get();
    const ep = (st.episodes || {})[params.id];
    if (!ep) throw { code: "NOT_FOUND", message: "剧集不存在" };
    guardRead(st, auth, ep.id);
    const list = ((st.asset_lib || {}).audio || {}).sfx || [];
    return router.json(res, 200, { episodeId: ep.id, sfx: list });
  }, { auth: true });

};
