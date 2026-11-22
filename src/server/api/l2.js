"use strict";
/**
 * api/l2.js — L2 副驾 REST 面（契约 §3 L2 行；集成补齐：facade 与 HTTP 的接缝层）
 * 治理/裁决全在 l2 facade＋governance，本层只做路由、身份归一化与错误→HTTP 映射。
 */

const CODE_HTTP = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STALE: 409,
  QUANT_RULE: 409,
  BUDGET: 402,
  CONFIRM_REQ: 428,
  INVALID_MODE: 400,
  BAD_DECISION: 400,
  RUNTIME: 503,
  L2_UNAVAILABLE: 503
};

function httpOf(r) {
  return CODE_HTTP[r && r.code] || 400;
}

function normAuth(auth) {
  if (!auth) return null;
  // tid 随身份走（S3-4）：会话建档记域，Phase 2 副驾域感知用
  return { id: auth.id || auth.uid, role: auth.role, tid: auth.tid || null };
}

module.exports.register = (router, ctx) => {
  const ready = () => ctx.l2 && typeof ctx.l2.createSession === "function";

  router.add("POST", "/api/l2/sessions", (req, res, body, params, auth) => {
    if (!ready()) return router.json(res, 503, { error: { code: "L2_UNAVAILABLE", message: "L2 runtime 未装配" } });
    const r = ctx.l2.createSession(normAuth(auth), body && body.mode);
    if (r && r.code) return router.json(res, httpOf(r), { error: { code: r.code, message: r.message } });
    router.json(res, 201, { session: r.session, runtime: r.runtime });
  }, { auth: true });

  router.add("GET", "/api/l2/sessions", (req, res, body, params, auth) => {
    if (!ready()) return router.json(res, 503, { error: { code: "L2_UNAVAILABLE", message: "L2 runtime 未装配" } });
    const list = ctx.l2.listSessions((normAuth(auth) || {}).id) || [];
    router.json(res, 200, { sessions: list });
  }, { auth: true });

  router.add("GET", "/api/l2/sessions/:id", (req, res, body, params, auth) => {
    if (!ready()) return router.json(res, 503, { error: { code: "L2_UNAVAILABLE", message: "L2 runtime 未装配" } });
    const r = ctx.l2.getSession(params.id);
    if (r && r.code) return router.json(res, httpOf(r), { error: { code: r.code, message: r.message } });
    // 红队③兜底：会话不属于你 → FORBIDDEN（facade 部分路径靠 uid 过滤，这里再核一次）
    const a = normAuth(auth);
    if (a && r && String(r.uid) !== String(a.id)) {
      return router.json(res, 403, { error: { code: "FORBIDDEN", message: "跨租户访问：会话不属于你" } });
    }
    router.json(res, 200, { session: r });
  }, { auth: true });

  // DELETE 会话（2026-11-22）：验收脚本自清账（谁建的谁删）＋用户清理不要的会话；仅本人可删
  router.add("DELETE", "/api/l2/sessions/:id", (req, res, body, params, auth) => {
    if (!ready()) return router.json(res, 503, { error: { code: "L2_UNAVAILABLE", message: "L2 runtime 未装配" } });
    const r = ctx.l2.deleteSession(params.id, normAuth(auth));
    if (r && r.code) return router.json(res, httpOf(r), { error: { code: r.code, message: r.message } });
    router.json(res, 200, { deleted: true, id: params.id });
  }, { auth: true });

  // 访问控制/会话级错误才上 HTTP 码；工具级失败（NO_TAKES 等）＝对话内容，回合已执行 → 202
  const MSG_ERR_CODES = { FORBIDDEN: 403, NOT_FOUND: 404, STALE: 409, INVALID_MODE: 400, RUNTIME: 503, L2_UNAVAILABLE: 503 };
  router.add("POST", "/api/l2/sessions/:id/messages", async (req, res, body, params, auth) => {
    if (!ready()) return router.json(res, 503, { error: { code: "L2_UNAVAILABLE", message: "L2 runtime 未装配" } });
    const r = await ctx.l2.postMessage(params.id, body || {}, normAuth(auth));
    if (r && r.code && MSG_ERR_CODES[r.code]) {
      return router.json(res, MSG_ERR_CODES[r.code], { error: { code: r.code, message: r.message } });
    }
    router.json(res, 202, { accepted: true, session_id: params.id, tool_outcome: r && r.code ? { code: r.code, message: r.message } : null });
  }, { auth: true });

  router.add("POST", "/api/l2/approvals/:id", async (req, res, body, params, auth) => {
    if (!ready()) return router.json(res, 503, { error: { code: "L2_UNAVAILABLE", message: "L2 runtime 未装配" } });
    const r = await ctx.l2.decideApproval(params.id, body || {}, normAuth(auth));
    if (r && r.code) return router.json(res, httpOf(r), { error: { code: r.code, message: r.message }, events: r.events } );
    router.json(res, 200, r);
  }, { auth: true });
};
