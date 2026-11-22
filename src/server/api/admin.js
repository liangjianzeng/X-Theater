"use strict";
/**
 * api/admin.js — 后台（契约 §3/§4，ops）
 * GET  /api/admin/registry · GET /api/admin/registry/:engineId（渲染字段 langlint 豁免 exempt:true）
 * POST /api/admin/registry {engineId,lane,node?,...} → 登记新引擎（lane 需为已装载车道）
 * POST /api/admin/registry/remove {engineId,confirmed:true} → 注销引擎（护栏：可加回，审计留痕）
 * POST /api/admin/registry/node {engineId,node,confirmed:true} → 改绑引擎归属节点（拨号热生效）
 * POST /api/admin/registry/quant {engineId,tier,reason?} → rules.quant.decide 裁决：
 *      QUANT_RULE → 409 复述 message；audit_needed → store.log("audit",{action:"quant_fallback",audit_id:"Q-"+hash12.slice(0,4)})
 * POST /api/admin/registry/endpoint|model → body 无 confirmed:true → 428 {code:"CONFIRM_REQ"}
 * POST /api/admin/alerts/simulate → 3 条 alert＋bus
 * GET  /api/admin/audit?kind= → readLog(kind)（默认 audit）
 */

const { ensureRegistryNodes } = require("../core/store");

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
  const { store, util, bus, cfg, engine } = ctx;

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  function getRegistry() {
    const st = store.get();
    st.settings = st.settings || {};
    st.settings.registry = st.settings.registry || {};
    ensureRegistryNodes(st); // 幂等：存量条目补 node 绑定（正常已在启动迁移时补齐）
    return st.settings.registry;
  }

  // 引擎→实际服务归属解析（2026-11-22 注册表化：lane→node 绑定住注册表，前端零写死）：
  //   img*/vid* → 注册表引擎的归属节点档案端点（cfg.laneBase 动态读，改绑/改端点即热生效）；
  //   music/tts → cfg.music/tts.url 独立服务（可空＝未配置/stub）；其余 → 服务器进程内。
  // 返回 serve＝workers 实际拨号的地址；node＝归属节点 id（不挂节点的服务为 null）。
  function resolveServe(lane) {
    const l = String(lane || "").toLowerCase();
    if (l === "music") return { node: null, serve: String((cfg.music && cfg.music.url) || "") };
    if (l === "tts") return { node: null, serve: String((cfg.tts && cfg.tts.url) || "") };
    if (l.indexOf("img") === 0 || l.indexOf("vid") === 0) {
      return {
        node: engine && typeof engine.laneBoundNode === "function" ? engine.laneBoundNode(l) : null,
        serve: typeof cfg.laneBase === "function" ? cfg.laneBase(l) : ""
      };
    }
    return { node: null, serve: "in-proc" };
  }

  // 只读下发视图：附加 node/serve 字段；不回写 state（registry 是 quant 规则的裁决数据源）
  function registryView() {
    const reg = getRegistry();
    const out = {};
    Object.keys(reg).forEach((id) => {
      const e = reg[id] || {};
      const r = resolveServe(e.lane);
      out[id] = Object.assign({}, e, { node: r.node, serve: r.serve });
    });
    return out;
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
      return router.json(res, 200, {
        registry: registryView(),
        langlint_exempt: exempted,
        // 合法车道枚举（登记/改绑引擎用）：ALL_LANES ∪ 已装载 worker 车道
        lanes: engine && typeof engine.laneNames === "function" ? engine.laneNames() : []
      });
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
      const r = resolveServe(e.lane);
      return router.json(res, 200, { engineId: params.engineId, entry: Object.assign({}, e, { node: r.node, serve: r.serve }) });
    },
    { auth: true }
  );

  /* ---------------- 引擎注册表 CRUD（2026-11-22：登记/注销/改绑不再改代码） ---------------- */

  // 引擎登记/改绑共用的载荷清洗（字符串截断、档位数组去空白）
  function cleanEntryPayload(b) {
    const str = (v, cap) => String(v == null ? "" : v).trim().slice(0, cap);
    const tiers = (v) =>
      Array.isArray(v) ? v.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 16) : undefined;
    return {
      engine: str(b.engine, 60),
      quant: str(b.quant, 40),
      endpoint: str(b.endpoint, 80),
      published: tiers(b.published),
      unavail: tiers(b.unavail)
    };
  }

  // POST /api/admin/registry {engineId,lane,node?,engine?,quant?,endpoint?,published?,unavail?} — 登记新引擎
  router.add(
    "POST",
    "/api/admin/registry",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const b = body || {};
      const engineId = String(b.engineId || "").trim().slice(0, 80);
      if (!engineId) throw { code: "BAD_REQUEST", message: "engineId 必填（如「SDXL-turbo-Q8」）" };
      const lane = String(b.lane || "").trim();
      const lanes = engine && typeof engine.laneNames === "function" ? engine.laneNames() : [];
      if (lanes.length && lanes.indexOf(lane) < 0) {
        throw { code: "BAD_REQUEST", message: "未知车道: " + (lane || "（空）") + "——可选: " + lanes.join("、") };
      }
      const reg = getRegistry();
      if (reg[engineId]) throw { code: "CONFLICT", message: "引擎已存在: " + engineId };
      // 归属节点：可空（进程内/独立服务）；给了必须在节点注册表里
      let node = b.node == null || b.node === "" ? null : String(b.node).trim();
      if (node) {
        const st = store.get();
        if (!((st.nodes || {})[node])) throw { code: "BAD_REQUEST", message: "未知节点: " + node + "——先在「算力节点」登记" };
      }
      const c = cleanEntryPayload(b);
      reg[engineId] = {
        lane,
        node,
        engine: c.engine || engineId,
        quant: c.quant || "n/a",
        endpoint: c.endpoint || "",
        published: c.published || [],
        unavail: c.unavail || []
      };
      store.commit();
      audit(auth, "registry_add", engineId, { lane, node, quant: reg[engineId].quant });
      try { bus.publish("alerts", { kind: "registry", msg: "引擎已登记: " + engineId + "（lane=" + lane + "，node=" + (node || "—") + "）" }); } catch (e) {}
      return router.json(res, 201, { engineId, entry: reg[engineId] });
    },
    { auth: true }
  );

  // POST /api/admin/registry/remove {engineId,confirmed:true} — 注销引擎（二次确认；在飞任务不受影响）
  router.add(
    "POST",
    "/api/admin/registry/remove",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const b = body || {};
      const engineId = String(b.engineId || "").trim();
      if (!engineId) throw { code: "BAD_REQUEST", message: "engineId 必填" };
      if (b.confirmed !== true) throw { code: "CONFIRM_REQ", status: 428, message: "注销引擎需二次确认：body 带 confirmed:true" };
      const reg = getRegistry();
      if (!reg[engineId]) throw { code: "NOT_FOUND", message: "引擎不存在: " + engineId };
      const gone = reg[engineId];
      delete reg[engineId];
      store.commit();
      audit(auth, "registry_remove", engineId, { lane: gone.lane, node: gone.node || null });
      return router.json(res, 200, { removed: engineId, note: "引擎「" + engineId + "」已注销；指向其车道的新任务将按注册表重新解析归属" });
    },
    { auth: true }
  );

  // POST /api/admin/registry/node {engineId,node,confirmed:true} — 改绑引擎归属节点（拨号热生效）
  router.add(
    "POST",
    "/api/admin/registry/node",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const b = body || {};
      const engineId = String(b.engineId || "").trim();
      if (!engineId) throw { code: "BAD_REQUEST", message: "engineId 必填" };
      if (b.confirmed !== true) throw { code: "CONFIRM_REQ", status: 428, message: "改绑归属节点需二次确认：body 带 confirmed:true" };
      const reg = getRegistry();
      const entry = reg[engineId];
      if (!entry) throw { code: "NOT_FOUND", message: "引擎不存在: " + engineId };
      let node = b.node == null || b.node === "" ? null : String(b.node).trim();
      if (node) {
        const st = store.get();
        if (!((st.nodes || {})[node])) throw { code: "BAD_REQUEST", message: "未知节点: " + node + "——先在「算力节点」登记" };
      }
      const before = entry.node || null;
      entry.node = node;
      store.commit();
      audit(auth, "registry_node_rebind", engineId, { from: before, to: node });
      try { bus.publish("alerts", { kind: "registry", msg: "引擎改绑节点: " + engineId + "（" + (before || "—") + " → " + (node || "—") + "）" }); } catch (e) {}
      return router.json(res, 200, { engineId, entry, note: "归属节点已改绑，绑定该引擎的任务下一次拨号即读取新端点" });
    },
    { auth: true }
  );

  // POST /api/admin/episodes/:id/purge {confirmed:true} —— 删除剧集及其全部派生数据（调试清场用，ops 专用）
  router.add(
    "POST",
    "/api/admin/episodes/:id/purge",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const b = body || {};
      if (b.confirmed !== true) throw { code: "CONFIRM_REQUIRED", message: "purge 需要 {confirmed:true}" };
      const st = store.get();
      const epId = params.id;
      if (!(st.episodes || {})[epId]) throw { code: "NOT_FOUND", message: "剧集不存在: " + epId };
      const drop = (obj) => { Object.keys(obj || {}).forEach((k) => { if ((obj[k] || {}).episodeId === epId) delete obj[k]; }); };
      // 复审队列条目不带 episodeId（只带 shotId）——按本集镜头集合过滤，否则 purge 后留死条目
      const shotIdSet = {};
      Object.keys(st.shots || {}).forEach((k) => {
        if ((st.shots[k] || {}).episodeId === epId) shotIdSet[k] = true;
      });
      drop(st.cards); drop(st.scenes); drop(st.shots); drop(st.alerts);
      if (Array.isArray(st.review_q)) {
        st.review_q = st.review_q.filter((r) => !r || !r.shotId || !shotIdSet[r.shotId]);
      }
      (st.music_lib || []).forEach((m) => { if ((m || {}).episodeId === epId) m.episodeId = null; });
      // 活队列在引擎内存（不在 state）：排队中的任务随 purge 停掉；在跑的由 engine.stop 语义自然收尾
      const engine = ctx.engine;
      if (engine && typeof engine.listJobs === "function") {
        (engine.listJobs({ episodeId: epId }) || []).forEach((j) => {
          if (j.status === "queued") { try { engine.stop(j.id); } catch (e) { /* 已被调度则收尾时自行失败 */ } }
        });
      }
      delete st.episodes[epId];
      store.commit();
      audit(auth, "episode_purge", epId, { confirmed: true });
      return router.json(res, 200, { purged: epId });
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

  // POST /api/admin/registry/probe {engineId} —— 真探测：按注册表端点做 TCP/HTTP 连通测试（可观测，不假绿）
  router.add(
    "POST",
    "/api/admin/registry/probe",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const b = body || {};
      if (!b.engineId) throw { code: "BAD_REQUEST", message: "engineId 必填" };
      const reg = getRegistry();
      const entry = reg[b.engineId];
      if (!entry) throw { code: "NOT_FOUND", message: "引擎不存在: " + b.engineId };
      const endpoint = String(entry.endpoint || "");
      const portM = /:(\d{2,5})/.exec(endpoint);
      const hostM = /\b(\d+\.\d+\.\d+\.\d+)\b/.exec(endpoint);
      const host = hostM ? hostM[1] : "127.0.0.1";
      const port = portM ? Number(portM[1]) : 80;
      const t0 = Date.now();
      const sys = require("http");
      const reqOpts = { host, port, path: /comfy/i.test(endpoint) ? "/system_stats" : "/", method: "GET", timeout: 2500 };
      const out = new Promise((resolve) => {
        const rq = sys.request(reqOpts, (rs) => {
          let buf = "";
          rs.on("data", (c) => { if (buf.length < 400) buf += c; });
          rs.on("end", () => resolve({ ok: rs.statusCode >= 200 && rs.statusCode < 500, code: rs.statusCode, detail: buf.slice(0, 200) }));
        });
        rq.on("timeout", () => { rq.destroy(); resolve({ ok: false, code: 0, detail: "超时（2.5s）" }); });
        rq.on("error", (e) => resolve({ ok: false, code: 0, detail: String(e.message || e).slice(0, 160) }));
        rq.end();
      });
      return out.then((r) => {
        const ms = Date.now() - t0;
        audit(auth, "registry_probe", b.engineId, { ok: r.ok, ms, endpoint });
        return router.json(res, 200, { engineId: b.engineId, endpoint, host, port, ok: r.ok, code: r.code, ms, detail: r.detail });
      });
    },
    { auth: true }
  );

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
        { kind: "queue_stall", msg: "演练：t2i.local lane 队列疑似卡死" },
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

  /* ---------------- 邀请码管理（2026-11-22 按人发码：一人一码一号） ---------------- */
  function inviteMapOf(st) {
    if (Array.isArray(st.invites)) {
      const m = {};
      st.invites.forEach((c) => { if (c) m[String(c)] = {}; });
      st.invites = m;
      store.commit();
    }
    return st.invites && typeof st.invites === "object" && !Array.isArray(st.invites) ? st.invites : {};
  }

  // GET /api/admin/invites — 码清单（含绑定人与首用状态）
  router.add(
    "GET",
    "/api/admin/invites",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const m = inviteMapOf(st);
      const invites = Object.keys(m).map((code) => {
        const bound = m[code].uid ? (st.users || {})[String(m[code].uid)] : null;
        return {
          code,
          name: m[code].name || null,
          role: m[code].role || null,
          used: !!m[code].uid,
          bound_name: bound ? bound.name : null,
          bound_uid: m[code].uid || null
        };
      });
      return router.json(res, 200, { invites });
    },
    { auth: true }
  );

  // POST /api/admin/invites {name, role} → 生成新码（一人一码；role 仅 ops|creator）
  router.add(
    "POST",
    "/api/admin/invites",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const b = body || {};
      const m = inviteMapOf(store.get());
      // 邀请码要不可预测（可预测码＝外人可自注册）：crypto.randomBytes，非 hash12/Math.random
      const code = "INV-" + require("crypto").randomBytes(4).toString("hex").toUpperCase();
      if (m[code]) throw { code: "CONFLICT", message: "码冲突，重试一次即可" };
      m[code] = {
        name: String(b.name || "creator").slice(0, 20),
        role: b.role === "ops" ? "ops" : "creator"
      };
      store.commit();
      audit(auth, "invite_add", code, { name: m[code].name, role: m[code].role });
      return router.json(res, 201, { code, name: m[code].name, role: m[code].role });
    },
    { auth: true }
  );

  // POST /api/admin/invites/remove {code} — 吊销（保护最后一个码，防自锁门外）
  router.add(
    "POST",
    "/api/admin/invites/remove",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const b = body || {};
      const code = String(b.code || "");
      const m = inviteMapOf(store.get());
      if (!m[code]) throw { code: "NOT_FOUND", message: "邀请码不存在: " + code };
      if (Object.keys(m).length <= 1) {
        throw { code: "LAST_CODE", message: "至少保留一个邀请码，否则无人能登录" };
      }
      const bound = m[code].uid || null;
      delete m[code];
      store.commit();
      audit(auth, "invite_remove", code, { bound_uid: bound });
      return router.json(res, 200, { removed: code });
    },
    { auth: true }
  );
}

module.exports.register = register;
