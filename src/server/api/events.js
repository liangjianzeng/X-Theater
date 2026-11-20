"use strict";
/**
 * api/events.js — SSE（契约 §3：GET /api/events → bus.attach(res)）
 * ?session=<sid> 时只订该 l2 topic ＋ jobs；否则全 topic（jobs/cards/alerts/review）。
 */

function parseQuery(req) {
  const url = (req && req.url) || "";
  const i = url.indexOf("?");
  const out = {};
  if (i >= 0) {
    const sp = new URLSearchParams(url.slice(i + 1));
    sp.forEach((v, k) => {
      out[k] = v;
    });
  }
  return out;
}

function register(router, ctx) {
  const { bus } = ctx;

  router.add(
    "GET",
    "/api/events",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const q = parseQuery(req);
      if (q.session) {
        // core bus 契约：{session} → 放行全部非 l2 topic ＋ 该会话 l2:<sid>
        if (typeof bus.attach === "function") {
          bus.attach(res, { session: q.session });
        }
      } else {
        if (typeof bus.attach === "function") bus.attach(res);
      }
      // SSE 已接管 res（含 :ping 心跳）；不再 json。
      return undefined;
    },
    { auth: true }
  );
}

module.exports.register = register;
