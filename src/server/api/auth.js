"use strict";
/**
 * api/auth.js — 认证（契约 §3：POST /api/login {code}，无 auth）
 * 只写本文件；router.useAuth 由 index.js 装配，这里只消费 handler 第 5 参 auth。
 */

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天

function register(router, ctx) {
  const { store, util } = ctx;

  function auditRow(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  // POST /api/login {code} → {token,user}
  router.add(
    "POST",
    "/api/login",
    (req, res, body, params, auth) => {
      const code = body && body.code;
      if (!code || typeof code !== "string") {
        throw { code: "BAD_REQUEST", message: "缺少邀请码 code" };
      }
      const st = store.get();
      const invites = Array.isArray(st.invites) ? st.invites : [];
      if (invites.indexOf(code) === -1) {
        throw { code: "INVALID_CODE", message: "邀请码无效" };
      }
      st.users = st.users || {};
      // 演示语义：邀请码登录到既有的 ops 账号（后台/审片可用），否则首个用户，再否则建 creator。
      const users = Object.keys(st.users)
        .sort()
        .map((k) => st.users[k]);
      let user =
        users.filter((u) => u && u.role === "ops")[0] ||
        users[0] ||
        null;
      if (!user) {
        user = { id: util.uid("u"), name: "creator", role: "creator" };
        st.users[user.id] = user;
        store.commit();
      }
      const token = util.sign({
        uid: user.id,
        role: user.role,
        exp: util.now() + TOKEN_TTL_MS
      });
      auditRow(auth, "login", user.id, { via: "invite" });
      return router.json(res, 200, {
        token,
        user: { id: user.id, name: user.name, role: user.role }
      });
    },
    { auth: false }
  );
}

module.exports.register = register;
