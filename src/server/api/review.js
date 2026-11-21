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

  // GET /api/review/queue —— 2026-11-21 可读化：每项带真镜号/镜名/分镜首帧/成片链接，
  // 批复时知道批的是哪镜什么画面（此前只有 shotId 尾数＋哈希色块，完全看不出是什么）
  router.add(
    "GET",
    "/api/review/queue",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const shots = st.shots || {};
      const framesByShot = {}; // shotId → 最新 C2 分镜首帧 art
      let latestC2Ver = -1, latestC2 = null;
      Object.keys(st.cards || {}).forEach((k) => {
        const c = st.cards[k];
        if (c.type !== "C2") return;
        if ((c.ver || 0) >= latestC2Ver) { latestC2Ver = c.ver || 0; latestC2 = c; }
      });
      ((latestC2 && latestC2.payload && latestC2.payload.images) || []).forEach((im) => {
        if (im && im.shotId && im.art) framesByShot[im.shotId] = im.art;
      });
      const queue = (st.review_q || []).slice().map((r) => {
        const sh = shots[r.shotId] || null;
        const takes = (sh && sh.takes) || [];
        const lastTake = takes.length ? takes[takes.length - 1] : null;
        // 受控链透明化（2026-11-21）：从 take 的 meta.json 读最终 IR 提示词与首帧——复审时知道这条片怎么被控制
        let prompt = null, firstFrame = null, irUsed = null;
        if (lastTake && lastTake.art) {
          try {
            const fs = require("fs");
            const path = require("path");
            const mf = path.join(process.cwd(), "var", "out", String(lastTake.art).replace(/^.*[\\/]/, "") + ".meta.json");
            const mj = JSON.parse(fs.readFileSync(mf, "utf8"));
            prompt = mj.prompt || null;
            firstFrame = mj.first_frame || null;
            irUsed = mj.ir_llm_used != null ? !!mj.ir_llm_used : null;
          } catch (e) { /* meta 缺失（旧 take）则不显示 */ }
        }
        return Object.assign({}, r, {
          seq: sh ? sh.seq : null,
          shotName: sh ? sh.name : null,
          sec: sh ? sh.sec : null,
          // 统一镜号+条次（2026-11-21）：同镜多条送审可区分（第 N 条 · 送审时间 · 真帧缩略）
          takeNo: takes.length || null,
          frame: framesByShot[r.shotId] || null,
          takeArt: lastTake && lastTake.art ? lastTake.art : null,
          prompt, first_frame: firstFrame, ir_llm_used: irUsed
        });
      });
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
