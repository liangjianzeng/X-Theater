"use strict";
/**
 * api/auth.js — 认证（契约 §3：POST /api/login {code}，无 auth）
 * 只写本文件；router.useAuth 由 index.js 装配，这里只消费 handler 第 5 参 auth。
 */

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天

const Tenants = require("../core/tenants.js");

// 邀请码两形态（2026-11-22 按人发码升级）：
//   老数组 ["CODE"] → 登录时就地升级 {CODE:{}}；
//   新对象 {CODE:{name?,role?,uid?}} → 配置过的码首次使用建档绑定（一人一码一号）；
//     未配置的裸码 {} 沿用旧 fallback（先 ops 账号），保证 INV-DEMO-1 出厂行为不变。
function inviteMap(st, store) {
  if (Array.isArray(st.invites)) {
    const m = {};
    st.invites.forEach((c) => { if (c) m[String(c)] = {}; });
    st.invites = m;
    if (store) store.commit();
  }
  return st.invites && typeof st.invites === "object" && !Array.isArray(st.invites) ? st.invites : {};
}

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
      const m = inviteMap(st, store);
      const inv = m[code];
      if (!inv) {
        throw { code: "INVALID_CODE", message: "邀请码无效" };
      }
      st.users = st.users || {};
      let user = inv.uid ? st.users[String(inv.uid)] || null : null;
      if (!user) {
        if (inv.name || inv.role) {
          // 配置过的码 → 一人一码一号（2026-11-22）：首次使用即建档并绑定
          user = {
            id: util.uid("u"),
            name: String(inv.name || "creator").slice(0, 20),
            role: inv.role === "ops" ? "ops" : "creator"
          };
          st.users[user.id] = user;
          inv.uid = user.id;
        } else {
          // 裸码：沿用旧语义（既有 ops 账号 → 首个用户 → 建 creator）
          const users = Object.keys(st.users)
            .sort()
            .map((k) => st.users[k]);
          user =
            users.filter((u) => u && u.role === "ops")[0] ||
            users[0] ||
            null;
          if (!user) {
            user = { id: util.uid("u"), name: "creator", role: "creator" };
            st.users[user.id] = user;
          }
          inv.uid = user.id;
        }
        store.commit();
      }

      // 域绑定（S3-4）：码带 tid → 入该域为 member；否则沿用已有成员身份；两者皆无 → 入默认域
      st.tenants = st.tenants || {};
      let tid = null;
      if (inv.tid && st.tenants[inv.tid]) {
        const t = st.tenants[inv.tid];
        t.members = t.members || {};
        if (!t.members[user.id]) {
          // 域内身份随码（P2）：member（默认）| viewer（只读审片）| admin；已有成员不降级
          t.members[user.id] = ["owner", "admin", "member", "viewer"].indexOf(inv.domain_role) >= 0
            ? inv.domain_role
            : "member";
          store.commit();
        }
        tid = inv.tid;
      } else {
        const mems = Tenants.membershipsOf(st, user).filter((x) => x.role !== "platform");
        if (mems.length) {
          tid = mems[0].id;
        } else {
          const dt = Tenants.defaultTid(st);
          st.tenants[dt] = st.tenants[dt] || {
            id: dt, name: "默认工作台", owner_uid: null, members: {}, created_at: Date.now()
          };
          const t0 = st.tenants[dt];
          t0.members = t0.members || {};
          if (!t0.members[user.id]) {
            t0.members[user.id] = "member";
            store.commit();
          }
          tid = dt;
        }
      }

      const token = util.sign({
        uid: user.id,
        role: user.role,
        tid,
        exp: util.now() + TOKEN_TTL_MS
      });
      // 登录即种 cookie（2026-11-22）：/var/* 资产墙（img/video 标签带不上 Authorization 头）同源自动携带
      try {
        res.setHeader("Set-Cookie", "theater_tok=" + encodeURIComponent(token) + "; Path=/; Max-Age=604800; SameSite=Lax");
      } catch (e) { /* SSE 等场景 res 已接管则忽略 */ }
      auditRow(auth, "login", user.id, { via: "invite", tid });
      return router.json(res, 200, {
        token,
        user: { id: user.id, name: user.name, role: user.role }
      });
    },
    { auth: false }
  );

  // GET /api/auth/tenants — 我的域列表（切域下拉/登录定域）
  router.add(
    "GET",
    "/api/auth/tenants",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const list = Tenants.membershipsOf(st, auth);
      const cur = Tenants.contextTid(st, auth);
      return router.json(res, 200, {
        tenants: list,
        current: cur,
        current_name: ((st.tenants || {})[cur] || {}).name || null
      });
    },
    { auth: true }
  );

  // POST /api/auth/switch {tid} — 切域：校验成员身份 → 重签 token（带新 tid）→ 换 cookie
  router.add(
    "POST",
    "/api/auth/switch",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const tid = String((body || {}).tid || "");
      if (!(st.tenants || {})[tid]) throw { code: "NOT_FOUND", message: "域不存在" };
      if (!Tenants.canRead(st, auth, tid)) throw { code: "FORBIDDEN", message: "你不是该域成员" };
      const user = st.users[String(auth.id)];
      if (!user) throw { code: "UNAUTHORIZED", message: "账号不存在" };
      const token = util.sign({
        uid: user.id,
        role: user.role,
        tid,
        exp: util.now() + TOKEN_TTL_MS
      });
      try {
        res.setHeader("Set-Cookie", "theater_tok=" + encodeURIComponent(token) + "; Path=/; Max-Age=604800; SameSite=Lax");
      } catch (e) { /* res 已接管则忽略 */ }
      store.log("audit", { operator: auth.id, action: "tenant_switch", target: tid });
      return router.json(res, 200, {
        token,
        tid,
        user: { id: user.id, name: user.name, role: user.role }
      });
    },
    { auth: true }
  );

  // GET /api/login/hint（无 auth）：仅当邀请码仍是出厂种子（未自定义）时回显演示码——
  // 自部署运营者本人也常被「向运营索取」卡在门外（2026-11-22 用户实测）。运营改过邀请码
  // 后本口立即静默（返回 null），不泄露任何真实码。只读：不做数组→对象就地升级（无鉴权路径不改 state）。
  router.add(
    "GET",
    "/api/login/hint",
    (req, res) => {
      const st = store.get();
      const keys = Array.isArray(st.invites)
        ? st.invites.filter(Boolean).map(String)
        : Object.keys(st.invites || {});
      const isSeed = keys.length === 1 && keys[0] === "INV-DEMO-1";
      return router.json(res, 200, { code: isSeed ? "INV-DEMO-1" : null });
    },
    { auth: false }
  );
}

module.exports.register = register;
