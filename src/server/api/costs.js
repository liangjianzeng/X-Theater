"use strict";
/**
 * api/costs.js — 成本（契约 §3）
 * GET /api/episodes/:id/costs → 镜级穿透＋Σ（源＝billing 影子账本）
 * GET /api/billing?episodeId= → 原始影子账（ops；非 ops → {code:"FORBIDDEN"}）
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

function readBilling(ctx) {
  try {
    return ctx.store.readLog("billing") || [];
  } catch (e) {
    return [];
  }
}

function requireOps(auth) {
  if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
  const role = auth.role || auth.role_name;
  if (role !== "ops") throw { code: "FORBIDDEN", message: "需要 ops 角色" };
}

function register(router, ctx) {
  const { store } = ctx;

  // GET /api/episodes/:id/costs — 镜级穿透＋Σ
  router.add(
    "GET",
    "/api/episodes/:id/costs",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const ep = (st.episodes || {})[params.id];
      if (!ep) throw { code: "NOT_FOUND", message: "剧集不存在: " + params.id };
      const rows = readBilling(ctx).filter((b) => b && b.episodeId === params.id);
      const shots = Object.keys(st.shots || {})
        .map((k) => st.shots[k])
        .filter((s) => s.episodeId === params.id)
        .sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const byShot = {};
      let total = 0;
      rows.forEach((b) => {
        const key = b.shotId || "__common__";
        if (!byShot[key]) byShot[key] = { shotId: b.shotId || null, cents: 0, items: [] };
        byShot[key].cents += b.cents || 0;
        byShot[key].items.push({ kind: b.kind || b.type || "other", cents: b.cents || 0, ts: b.ts });
        total += b.cents || 0;
      });
      const shotRows = shots.map((sh) => {
        const g = byShot[sh.id] || { shotId: sh.id, cents: 0, items: [] };
        return {
          shotId: sh.id,
          name: sh.name,
          seq: sh.seq,
          status: sh.status,
          takes: (sh.takes || []).length,
          cents: g.cents,
          items: g.items
        };
      });
      const commons = Object.keys(byShot)
        .filter((k) => k === "__common__")
        .map((k) => Object.assign({ name: "非镜头级（集级公共）" }, byShot[k]));
      return router.json(res, 200, {
        episodeId: params.id,
        shots: shotRows,
        common: commons,
        total_cents: total,
        cost_cents: ep.cost_cents || 0,
        budget_cents: ep.budget_cents || 0,
        paused: !!ep.paused,
        estimate: ep.est || null
      });
    },
    { auth: true }
  );

  // GET /api/billing?episodeId= — ops 原始影子账
  router.add(
    "GET",
    "/api/billing",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const q = parseQuery(req);
      let rows = readBilling(ctx);
      if (q.episodeId) rows = rows.filter((b) => b && b.episodeId === q.episodeId);
      const sum = rows.reduce((a, b) => a + (b.cents || 0), 0);
      return router.json(res, 200, { rows, total: rows.length, cents: sum });
    },
    { auth: true }
  );
}

module.exports.register = register;
