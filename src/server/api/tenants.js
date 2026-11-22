"use strict";
/**
 * api/tenants.js — 域（主账户）管理（2026-11-22 S3，方案 docs/permission-domain-plan.md）
 * POST /api/tenants {name}                自助建域（建者＝owner）
 * GET  /api/tenants/:tid                  域详情＋成员表（owner/admin/platform）
 * POST /api/tenants/:tid/invites {name,role}  域邀请码（登录即入该域）
 * POST /api/tenants/:tid/members/remove {uid} 移除成员（owner 不可移除）
 * 域内角色：owner > admin > member > viewer；平台 ops（role:"ops"）全域通行。
 */

const Tenants = require("../core/tenants.js");

function register(router, ctx) {
  const { store, util } = ctx;

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  // POST /api/tenants {name}
  router.add(
    "POST",
    "/api/tenants",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const name = String((body || {}).name || "").trim().slice(0, 30);
      if (!name) throw { code: "BAD_REQUEST", message: "域名必填" };
      st.tenants = st.tenants || {};
      const tid = util.uid("tid");
      st.tenants[tid] = {
        id: tid,
        name,
        owner_uid: auth.id,
        members: { [auth.id]: "owner" },
        created_at: Date.now()
      };
      store.commit();
      audit(auth, "tenant_create", tid, { name });
      try { ctx.bus.publish("alerts", { kind: "tenant", msg: "新域已创建：" + name }); } catch (e) {}
      return router.json(res, 201, { tenant: st.tenants[tid] });
    },
    { auth: true }
  );

  // GET /api/tenants/:tid — 详情＋成员表
  router.add(
    "GET",
    "/api/tenants/:tid",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const t = (st.tenants || {})[params.tid];
      if (!t) throw { code: "NOT_FOUND", message: "域不存在" };
      Tenants.guardManage(st, auth, params.tid);
      const members = Object.keys(t.members || {}).map((uid) => {
        const u = (st.users || {})[uid] || { id: uid, name: uid, role: "creator" };
        return { uid, name: u.name, platform_role: u.role, role: t.members[uid] };
      });
      // 域邀请码
      const invites = Object.keys(st.invites && typeof st.invites === "object" && !Array.isArray(st.invites) ? st.invites : {})
        .filter((code) => st.invites[code] && st.invites[code].tid === params.tid)
        .map((code) => ({
          code,
          name: st.invites[code].name || null,
          role: st.invites[code].role || null,
          used: !!st.invites[code].uid,
          bound_uid: st.invites[code].uid || null
        }));
      return router.json(res, 200, { tenant: t, members, invites });
    },
    { auth: true }
  );

  // DELETE /api/tenants/:tid — 删域（owner/平台）：仅空域可删（仍有项目/集 → 拒绝），
  // 默认工作台保护（防误删全站唯一落点）；成员账号保留（只是脱离本域）。
  router.add(
    "DELETE",
    "/api/tenants/:tid",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const t = (st.tenants || {})[params.tid];
      if (!t) throw { code: "NOT_FOUND", message: "域不存在" };
      const acc = Tenants.accessOf(st, auth, params.tid);
      if (acc !== "owner" && acc !== "platform") {
        throw { code: "FORBIDDEN", message: "只有域主或平台运营可删除域" };
      }
      if (params.tid === Tenants.DEFAULT_TID) {
        throw { code: "PROTECTED", message: "默认工作台不可删除" };
      }
      const used =
        Object.keys(st.projects || {}).some((k) => (st.projects[k] || {}).tenantId === params.tid) ||
        Object.keys(st.episodes || {}).some((k) => (st.episodes[k] || {}).tenantId === params.tid);
      if (used) throw { code: "NOT_EMPTY", message: "域下还有项目/剧集，先删完再删域" };
      delete st.tenants[params.tid];
      store.commit();
      audit(auth, "tenant_delete", params.tid, { name: t.name });
      return router.json(res, 200, { deleted: params.tid });
    },
    { auth: true }
  );

  // POST /api/tenants/:tid/invites {name, domain_role} — 域邀请码（登录即入域）
  // domain_role: member（读写，默认）| viewer（只读审片）| admin（管理员；仅域主/平台可发）
  router.add(
    "POST",
    "/api/tenants/:tid/invites",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      if (!(st.tenants || {})[params.tid]) throw { code: "NOT_FOUND", message: "域不存在" };
      Tenants.guardManage(st, auth, params.tid);
      const acc = Tenants.accessOf(st, auth, params.tid);
      const b = body || {};
      const domainRole = ["admin", "member", "viewer"].indexOf(b.domain_role) >= 0 ? b.domain_role : "member";
      if (domainRole === "admin" && acc !== "owner" && acc !== "platform") {
        throw { code: "FORBIDDEN", message: "管理员邀请码只有域主/平台运营可发" };
      }
      const m = st.invites && typeof st.invites === "object" && !Array.isArray(st.invites)
        ? st.invites
        : (st.invites = {});
      const code = "INV-" + util.hash12({ ts: util.now(), rnd: Math.random() }).slice(0, 8).toUpperCase();
      if (m[code]) throw { code: "CONFLICT", message: "码冲突，重试一次即可" };
      m[code] = {
        name: String(b.name || "member").slice(0, 20),
        role: "creator",
        tid: params.tid,
        domain_role: domainRole
      };
      store.commit();
      audit(auth, "invite_add", code, { name: m[code].name, domain_role: domainRole, tid: params.tid });
      return router.json(res, 201, { code, name: m[code].name, domain_role: domainRole, tid: params.tid });
    },
    { auth: true }
  );

  // POST /api/tenants/:tid/invites/remove {code} — 吊销域邀请码
  router.add(
    "POST",
    "/api/tenants/:tid/invites/remove",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      if (!(st.tenants || {})[params.tid]) throw { code: "NOT_FOUND", message: "域不存在" };
      Tenants.guardManage(st, auth, params.tid);
      const code = String((body || {}).code || "");
      const inv = (st.invites || {})[code];
      if (!inv || inv.tid !== params.tid) throw { code: "NOT_FOUND", message: "邀请码不存在或不属于本域" };
      delete st.invites[code];
      store.commit();
      audit(auth, "invite_remove", code, { tid: params.tid });
      return router.json(res, 200, { removed: code });
    },
    { auth: true }
  );

  // POST /api/tenants/:tid/members/role {uid, role} — 变更域内身份（owner 不可改；admin 任命需域主/平台）
  router.add(
    "POST",
    "/api/tenants/:tid/members/role",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const t = (st.tenants || {})[params.tid];
      if (!t) throw { code: "NOT_FOUND", message: "域不存在" };
      Tenants.guardManage(st, auth, params.tid);
      const uid = String((body || {}).uid || "");
      const role = String((body || {}).role || "");
      if (["admin", "member", "viewer"].indexOf(role) < 0) {
        throw { code: "BAD_REQUEST", message: "role 必须为 admin|member|viewer" };
      }
      if (!t.members || !t.members[uid]) throw { code: "NOT_FOUND", message: "成员不存在" };
      if (uid === t.owner_uid) throw { code: "PROTECTED", message: "域主身份不可在此变更（走转让）" };
      const acc = Tenants.accessOf(st, auth, params.tid);
      if (role === "admin" && acc !== "owner" && acc !== "platform") {
        throw { code: "FORBIDDEN", message: "任命管理员需要域主权限" };
      }
      const prev = t.members[uid];
      t.members[uid] = role;
      store.commit();
      audit(auth, "member_role", params.tid, { uid, prev, role });
      return router.json(res, 200, { uid, role, members: t.members });
    },
    { auth: true }
  );

  // POST /api/tenants/:tid/transfer {uid} — 转让域主（原域主降为 admin）
  router.add(
    "POST",
    "/api/tenants/:tid/transfer",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const t = (st.tenants || {})[params.tid];
      if (!t) throw { code: "NOT_FOUND", message: "域不存在" };
      const acc = Tenants.accessOf(st, auth, params.tid);
      if (acc !== "owner" && acc !== "platform") {
        throw { code: "FORBIDDEN", message: "只有域主或平台运营可转让域" };
      }
      const uid = String((body || {}).uid || "");
      if (!t.members || !t.members[uid]) throw { code: "NOT_FOUND", message: "目标成员不在本域" };
      if (uid === t.owner_uid) throw { code: "BAD_REQUEST", message: "目标已是域主" };
      const prev = t.owner_uid;
      if (prev && t.members[prev]) t.members[prev] = "admin";
      t.owner_uid = uid;
      t.members[uid] = "owner";
      store.commit();
      audit(auth, "tenant_transfer", params.tid, { prev, to: uid });
      return router.json(res, 200, { owner_uid: t.owner_uid, members: t.members });
    },
    { auth: true }
  );

  // POST /api/tenants/:tid/budget {budget_cents|null} — 设域预算（null＝无上限）
  router.add(
    "POST",
    "/api/tenants/:tid/budget",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const t = (st.tenants || {})[params.tid];
      if (!t) throw { code: "NOT_FOUND", message: "域不存在" };
      Tenants.guardManage(st, auth, params.tid);
      const v = (body || {}).budget_cents;
      let next = null;
      if (v !== null && v !== undefined && v !== "") {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n) || n < 0) throw { code: "BAD_REQUEST", message: "budget_cents 须为 ≥0 的整数（单位：分）或 null" };
        next = n;
      }
      const prev = t.budget_cents || null;
      t.budget_cents = next;
      store.commit();
      audit(auth, "tenant_budget", params.tid, { prev, next });
      try { ctx.bus.publish("alerts", { kind: "budget", msg: "域「" + (t.name || params.tid) + "」预算已" + (next === null ? "清除（无上限）" : "设为 " + next + " 分") }); } catch (e) {}
      return router.json(res, 200, { budget_cents: t.budget_cents });
    },
    { auth: true }
  );

  // GET /api/tenants/:tid/billing — 域计费聚合（账本行带 tid 优先；历史行经 episode 反查）
  router.add(
    "GET",
    "/api/tenants/:tid/billing",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const t = (st.tenants || {})[params.tid];
      if (!t) throw { code: "NOT_FOUND", message: "域不存在" };
      Tenants.guardManage(st, auth, params.tid);
      const eps = st.episodes || {};
      const tidOf = (eid) => (eps[eid] || {}).tenantId || "tid_default";
      let rows = [];
      try { rows = store.readLog("billing") || []; } catch (e) { rows = []; }
      let total = 0;
      const byEp = {};
      const byKind = {};
      rows.forEach((r) => {
        if (!r) return;
        if ((r.tid || tidOf(r.episodeId)) !== params.tid) return;
        const c = r.cents || 0;
        total += c;
        byKind[r.kind || "other"] = (byKind[r.kind || "other"] || 0) + c;
        if (r.episodeId) {
          const e = (byEp[r.episodeId] = byEp[r.episodeId] || {
            episodeId: r.episodeId,
            title: (eps[r.episodeId] || {}).title || "（已删）",
            cents: 0
          });
          e.cents += c;
        }
      });
      return router.json(res, 200, {
        total_cents: total,
        budget_cents: t.budget_cents || null,
        pct: t.budget_cents > 0 ? Math.min(999, Math.round((total / t.budget_cents) * 100)) : null,
        by_episode: Object.values(byEp).sort((a, b) => b.cents - a.cents).slice(0, 10),
        by_kind: byKind
      });
    },
    { auth: true }
  );

  // POST /api/tenants/:tid/members/remove {uid} — 移除成员（owner 不可移除；自己可退出）
  router.add(
    "POST",
    "/api/tenants/:tid/members/remove",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const t = (st.tenants || {})[params.tid];
      if (!t) throw { code: "NOT_FOUND", message: "域不存在" };
      Tenants.guardManage(st, auth, params.tid);
      const uid = String((body || {}).uid || "");
      if (!t.members || !t.members[uid]) throw { code: "NOT_FOUND", message: "成员不存在" };
      if (uid === t.owner_uid) throw { code: "PROTECTED", message: "域 owner 不能被移除（请先转让）" };
      delete t.members[uid];
      store.commit();
      audit(auth, "member_remove", params.tid, { uid });
      return router.json(res, 200, { removed: uid, members: t.members });
    },
    { auth: true }
  );
}

module.exports.register = register;
