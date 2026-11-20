"use strict";
/**
 * api/admin.js — 后台（契约 §3/§4，ops）
 * GET  /api/admin/registry · GET /api/admin/registry/:engineId（渲染字段 langlint 豁免 exempt:true）
 * POST /api/admin/registry/quant {engineId,tier,reason?} → rules.quant.decide 裁决：
 *      QUANT_RULE → 409 复述 message；audit_needed → store.log("audit",{action:"quant_fallback",audit_id:"Q-"+hash12.slice(0,4)})
 * POST /api/admin/registry/endpoint|model → body 无 confirmed:true → 428 {code:"CONFIRM_REQ"}
 * POST /api/admin/alerts/simulate → 3 条 alert＋bus
 * GET  /api/admin/audit?kind= → readLog(kind)（默认 audit）
 */

const FALLBACK_TIER = "MXFP8+FP8"; // tier 序 nvfp4→int8→MXFP8+FP8 的兜底档

function requireOps(auth) {
  if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
  if ((auth.role || auth.role_name) !== "ops") throw { code: "FORBIDDEN", message: "需要 ops 角色" };
}

// rules.quant.decide 主形态＝decide(registryEntry, tier, reason)（rules 交付实现）；
// 若为对象参数形态则回退 decide({registry,engineId,tier,reason})。QUANT_RULE 属裁决结论，不重试。
function callQuantDecide(rules, entry, tier, reason, reg, engineId, state) {
  try {
    return rules.quant.decide(entry, tier, reason);
  } catch (e) {
    if (e && e.code === "QUANT_RULE") throw e;
    return rules.quant.decide({ registry: reg, engineId, tier, reason, state });
  }
}

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
  const { store, util, bus } = ctx;

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  function getRegistry() {
    const st = store.get();
    st.settings = st.settings || {};
    st.settings.registry = st.settings.registry || {};
    return st.settings.registry;
  }

  // GET /api/admin/registry — 渲染字段 langlint 豁免（exempt:true，原样透出）
  router.add(
    "GET",
    "/api/admin/registry",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const lint = ctx.rules && ctx.rules.langlint;
      let exempted = true;
      if (lint && typeof lint.lint === "function") {
        try {
          lint.lint("registry", { exempt: true }); // 声明豁免渲染面
        } catch (e) {
          exempted = true;
        }
      }
      return router.json(res, 200, { registry: getRegistry(), langlint_exempt: exempted });
    },
    { auth: true }
  );

  // GET /api/admin/registry/:engineId
  router.add(
    "GET",
    "/api/admin/registry/:engineId",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const reg = getRegistry();
      const e = reg[params.engineId];
      if (!e) throw { code: "NOT_FOUND", message: "引擎不存在: " + params.engineId };
      return router.json(res, 200, { engineId: params.engineId, entry: e });
    },
    { auth: true }
  );

  // POST /api/admin/registry/quant {engineId,tier,reason?}
  router.add(
    "POST",
    "/api/admin/registry/quant",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const b = body || {};
      if (!b.engineId || !b.tier) {
        throw { code: "BAD_REQUEST", message: "engineId/tier 必填" };
      }
      const reg = getRegistry();
      const entry = reg[b.engineId];
      if (!entry) throw { code: "NOT_FOUND", message: "引擎不存在: " + b.engineId };
      const st = store.get();
      let decision;
      try {
        decision = callQuantDecide(ctx.rules, entry, b.tier, b.reason, reg, b.engineId, st);
      } catch (e) {
        if (e && e.code === "QUANT_RULE") {
          audit(auth, "quant_reject", b.engineId, { tier: b.tier, message: e.message });
          // 409 弹回＋复述规则
          throw { code: "QUANT_RULE", status: 409, message: e.message || "量化硬规则拒绝" };
        }
        throw e;
      }
      let appliedTier = b.tier;
      let auditNeeded = false;
      if (typeof decision === "string") appliedTier = decision;
      else if (decision && typeof decision === "object") {
        if (decision.tier) appliedTier = decision.tier;
        if (decision.audit_needed === true) auditNeeded = true;
      }
      if (appliedTier === FALLBACK_TIER) auditNeeded = true; // 兜底档必留痕
      const auditId = "Q-" + util.hash12({ engineId: b.engineId, tier: appliedTier, ts: util.now() }).slice(0, 4);
      entry.tier = appliedTier;
      store.commit();
      audit(auth, "quant_change", b.engineId, { tier: appliedTier, reason: b.reason || null });
      if (auditNeeded) {
        store.log("audit", {
          operator: (auth && (auth.uid || auth.id)) || null,
          action: "quant_fallback",
          target: b.engineId,
          tier: appliedTier,
          reason: b.reason || null,
          audit_id: auditId
        });
      }
      return router.json(res, 200, {
        engineId: b.engineId,
        tier: appliedTier,
        audit_needed: auditNeeded,
        audit_id: auditNeeded ? auditId : null
      });
    },
    { auth: true }
  );

  function confirmedChange(req, res, body, params, auth, field) {
    requireOps(auth);
    const b = body || {};
    if (!b.engineId) throw { code: "BAD_REQUEST", message: "engineId 必填" };
    if (b.confirmed !== true) {
      throw {
        code: "CONFIRM_REQ",
        status: 428,
        message: "endpoint/模型变更需二次确认：body 带 confirmed:true"
      };
    }
    const reg = getRegistry();
    const entry = reg[b.engineId];
    if (!entry) throw { code: "NOT_FOUND", message: "引擎不存在: " + b.engineId };
    const value = b[field];
    if (value === undefined || value === null) {
      throw { code: "BAD_REQUEST", message: field + " 必填" };
    }
    entry[field] = value;
    store.commit();
    audit(auth, field === "endpoint" ? "endpoint_change" : "model_change", b.engineId, {
      value,
      confirmed: true
    });
    return router.json(res, 200, { engineId: b.engineId, entry });
  }

  // POST /api/admin/registry/endpoint {engineId,endpoint,confirmed:true}
  router.add(
    "POST",
    "/api/admin/registry/endpoint",
    (req, res, body, params, auth) => confirmedChange(req, res, body, params, auth, "endpoint"),
    { auth: true }
  );

  // POST /api/admin/registry/model {engineId,model,confirmed:true}
  router.add(
    "POST",
    "/api/admin/registry/model",
    (req, res, body, params, auth) => confirmedChange(req, res, body, params, auth, "model"),
    { auth: true }
  );

  // GET /api/admin/alerts → 告警列表（只读；simulate 是演练注入，不作为列取面）
  router.add(
    "GET",
    "/api/admin/alerts",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const alerts = (st.alerts || []).slice(-100).reverse();
      return router.json(res, 200, { alerts, unacked: alerts.filter((a) => !a.acked).length });
    },
    { auth: true }
  );

  // POST /api/admin/alerts/simulate → 3 条 alert＋bus
  router.add(
    "POST",
    "/api/admin/alerts/simulate",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const seeds = [
        { kind: "queue_stall", msg: "演练：img5060 lane 队列疑似卡死" },
        { kind: "budget_warn", msg: "演练：预算护栏触发（>budget×1.2）" },
        { kind: "engine_unavail", msg: "演练：music 引擎 W-M :8190 不可达" }
      ];
      const created = seeds.map((s) => {
        const a = { id: util.uid("al"), kind: s.kind, msg: s.msg, ts: util.now(), acked: false };
        st.alerts = st.alerts || [];
        st.alerts.push(a);
        return a;
      });
      store.commit();
      audit(auth, "alerts_simulate", "alerts", { count: created.length });
      created.forEach((a) => {
        try {
          bus.publish("alerts", a);
        } catch (e) {}
      });
      return router.json(res, 200, { alerts: created });
    },
    { auth: true }
  );

  // GET /api/admin/audit?kind=
  router.add(
    "GET",
    "/api/admin/audit",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const q = parseQuery(req);
      const kind = ["job", "billing", "audit", "agentrun"].indexOf(q.kind) >= 0 ? q.kind : "audit";
      let rows = [];
      try {
        rows = store.readLog(kind) || [];
      } catch (e) {
        rows = [];
      }
      return router.json(res, 200, { kind, rows, total: rows.length });
    },
    { auth: true }
  );
}

module.exports.register = register;
