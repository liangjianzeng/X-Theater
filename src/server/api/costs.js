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
      require("../core/tenants.js").guardRead(st, auth, ep.tenantId || require("../core/tenants.js").defaultTid(st)); // 域外一律 404（2026-11-23 深审）
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
      // 产出档透出（2026-11-23 深审）：档位来自 job 账本（派单时 engine.logJob 写 tier），
      // 同 job_id 取最新行；串拍组行无单镜 shotId → 该镜 tier 为 null（客户端如实显「—」）。
      const tierByShot = {};
      try {
        const latest = {}; // job_id → 最新账本行
        (store.readLog("job") || []).forEach((r) => {
          if (!r || r.episodeId !== params.id) return;
          const k = String(r.job_id != null ? r.job_id : r.id);
          if (!latest[k] || Number(r.ts || 0) >= Number(latest[k].ts || 0)) latest[k] = r;
        });
        Object.keys(latest).forEach((k) => {
          const r = latest[k];
          if (r.shotId && (r.type === "video" || r.type === "video_ms")) tierByShot[String(r.shotId)] = r.tier || null;
        });
      } catch (e) { /* 账本读失败不阻断成本页：档位列留空 */ }
      const shotRows = shots.map((sh) => {
        const g = byShot[sh.id] || { shotId: sh.id, cents: 0, items: [] };
        // 引擎＝实际出片那条 take 的人话名（与 compose 选条同规则：best 最后一条，否则最新一条）
        const tks = (sh.takes || []).filter((t) => t && t.art);
        const bests = tks.filter((t) => t.best);
        const best = bests.length ? bests[bests.length - 1] : (tks.length ? tks[tks.length - 1] : null);
        return {
          shotId: sh.id,
          name: sh.name,
          seq: sh.seq,
          status: sh.status,
          takes: (sh.takes || []).length,
          engine: (best && best.engine) || null,
          tier: tierByShot[sh.id] || null,
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
