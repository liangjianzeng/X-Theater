"use strict";
/**
 * api/review.js — 审片（契约 §3，ops）
 * GET /api/review/queue · POST /api/review/:id/decide {action:"pass|reject|offline",reason,ver}
 * ops only（非 ops → {code:"FORBIDDEN"}）；留痕 audit；reject→shot.flags.stale=true。
 * 全部 pass → C8（cards.maybeFinishShoot）。
 */

const cardsMod = require("./cards.js");

function requireOps(auth) {
  if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
  if ((auth.role || auth.role_name) !== "ops") throw { code: "FORBIDDEN", message: "需要 ops 角色" };
}

function register(router, ctx) {
  const { store, util, bus } = ctx;

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  function findItem(id) {
    const st = store.get();
    return (st.review_q || []).filter((r) => r.id === id)[0] || null;
  }

  // GET /api/review/queue
  router.add(
    "GET",
    "/api/review/queue",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const queue = (st.review_q || []).slice();
      return router.json(res, 200, {
        queue,
        pending: queue.filter((r) => r.status === "pending").length
      });
    },
    { auth: true }
  );

  // POST /api/review/:id/decide {action,reason,ver}
  router.add(
    "POST",
    "/api/review/:id/decide",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const item = findItem(params.id);
      if (!item) throw { code: "NOT_FOUND", message: "复审项不存在: " + params.id };
      const b = body || {};
      const action = b.action;
      if (["pass", "reject", "offline"].indexOf(action) < 0) {
        throw { code: "BAD_ACTION", message: "action 必须为 pass|reject|offline" };
      }
      if (action === "reject" && !b.reason) {
        throw { code: "BAD_REQUEST", message: "reject 必须给 reason" };
      }
      if (typeof item.ver !== "number") item.ver = 1; // 种子项补 ver
      util.cas(item, b.ver); // 409 STALE

      const shot = (st.shots || {})[item.shotId] || null;
      const episodeId = shot ? shot.episodeId : null;
      item.status = action === "pass" ? "pass" : action === "reject" ? "reject" : "offline";
      item.decided_by = (auth && (auth.uid || auth.id)) || null;
      item.decided_at = util.now();
      item.ver += 1; // 改必 ver++
      if (action === "reject" && shot) {
        shot.flags = shot.flags || {};
        shot.flags.stale = true;
      }
      if (action === "pass" && shot && shot.status === "pending_review") {
        shot.status = "ok";
      }
      let c8 = null;
      if (episodeId) c8 = cardsMod.maybeFinishShoot(ctx, episodeId);
      store.commit();
      audit(auth, "review_decide", item.id, {
        shotId: item.shotId,
        decision: action,
        reason: b.reason || null
      });
      try {
        bus.publish("review", { event: "decided", item, c8: c8 && c8.id });
      } catch (e) {}
      return router.json(res, 200, { item, shot: shot || undefined, c8: c8 || undefined });
    },
    { auth: true }
  );
}

module.exports.register = register;
