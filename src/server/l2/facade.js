"use strict";
/**
 * L2 facade —— 剧场侧控制面对外 API（CONTRACT §5，index.js 装配调用 createL2(ctx)）
 *
 * createL2(ctx={store,bus,engine,rules,util,cfg}) →
 *   {createSession(auth,mode?), getSession(id), listSessions(uid), getSessions(uid),
 *    postMessage(id,{text,ctx[]},auth?)→async, decideApproval(id,{decision,ver},auth)}
 *
 * 落盘：store.state.l2_sessions（msgs {me:0|1,t,ts,sig?,runtime?} /
 *   tasks {id,label,status(queued|running|done|failed),shot?} /
 *   approvals {id,tool,args,est{cents,time},hash,ver,status,ttl_until}）。
 * 裁决全部服务端执行（客户端谎报无效）：governance 白名单/租户/预算＋确认票（hash+CAS+TTL60s+一票一次）。
 * 代跑任务经 ctx.bus.on("jobs",…) 订阅 engine 完成事件推进（bus 无 on 时优雅降级，任务保持队列态可查）。
 */
const adapter = require("./adapter.js");
const governance = require("./governance.js");
const tools = require("./tools.js");

function createL2(ctx) {
  if (!ctx || !ctx.store || !ctx.bus || !ctx.util) {
    throw new Error("l2: ctx={store,bus,engine,rules,util,cfg} 未注入");
  }
  const store = ctx.store;
  const util = ctx.util;
  const runtimes = new Map(); // sid → runtime（内存态；重启后懒重建）

  function state() {
    return store.get();
  }
  function sessionsMap() {
    const st = state();
    if (!st.l2_sessions) st.l2_sessions = {};
    return st.l2_sessions;
  }
  function findApproval(id) {
    const map = sessionsMap();
    for (const sid of Object.keys(map)) {
      const s = map[sid];
      const a = (s.approvals || []).find(function (x) {
        return x.id === id;
      });
      if (a) return { session: s, approval: a };
    }
    return null;
  }
  function ensureRuntime(s) {
    let rt = runtimes.get(s.id);
    if (!rt) {
      rt = adapter.createRuntime(s.mode, s, ctx);
      const sp = rt.spawn();
      if (!sp || !sp.ok) return { err: sp || { code: "RUNTIME", message: "runtime 启动失败" } };
      runtimes.set(s.id, rt);
    }
    return { rt: rt };
  }

  /* ---------- 会话 ---------- */
  function createSession(auth, mode) {
    if (!auth || !auth.id) return { code: "FORBIDDEN", message: "需要登录身份" };
    const m = String(
      mode || (state().settings && state().settings.runtime_mode) || "A"
    ).toUpperCase();
    if (m !== "A" && m !== "B") return { code: "INVALID_MODE", message: "runtime_mode 仅支持 A|B" };
    const s = {
      id: util.uid("l2s"),
      uid: String(auth.id),
      mode: m,
      msgs: [],
      tasks: [],
      approvals: [],
      ctx: [],
      budget_cents: governance.l2Line(ctx),
      used_cents: 0,
      broken: false,
      ver: 1,
      created_at: util.now()
    };
    sessionsMap()[s.id] = s;
    const ensured = ensureRuntime(s);
    if (ensured.err) {
      delete sessionsMap()[s.id];
      store.commit();
      return ensured.err;
    }
    store.commit();
    return { ok: true, session: s, runtime: s.runtime };
  }

  function getSession(id) {
    const s = sessionsMap()[id];
    if (!s) return { code: "NOT_FOUND", message: "会话不存在" };
    return s;
  }

  function listSessions(uid) {
    const map = sessionsMap();
    return Object.keys(map)
      .filter(function (k) {
        return !uid || String(map[k].uid) === String(uid);
      })
      .map(function (k) {
        return map[k];
      });
  }

  /* ---------- 对话 ---------- */
  async function postMessage(id, payload, auth) {
    const s = getSession(id);
    if (s.code) return s;
    if (auth && String(s.uid) !== String(auth.id)) {
      return { code: "FORBIDDEN", message: "跨租户访问：会话不属于你" };
    }
    // 红队③防线：会话面不提供其它会话数据出口（即便同租户，会话隔离仍是硬边界）
    const probe = String((payload && payload.text) || "") + " " + JSON.stringify((payload && payload.ctx) || []);
    const foreign = (probe.match(/l2s_[0-9a-zA-Z]+/g) || []).filter(function (x) { return x !== id; });
    if (foreign.length) {
      governance.ledger(ctx, s, {
        tool: "export_session",
        status: "denied_cross_session",
        code: "FORBIDDEN",
        args: governance.argsDigest(ctx, { foreign: foreign.slice(0, 3) }),
        trace_id: governance.newTrace(ctx, s, "cross_session")
      });
      ctx.bus.publish("l2:" + s.id, { type: "denied", sid: s.id, code: "FORBIDDEN", tool: "export_session", reason: "cross_session" });
      ctx.bus.publish("l2:" + s.id, { type: "msg_delta", sid: s.id, t: "这个我做不到：会话之间是硬边界，我不能把其它会话的内容搬过来。要看的记录可以去「历史会话」条里逐条打开。" });
      return { code: "FORBIDDEN", message: "跨会话访问被拒：L2 对话面不提供其它会话的数据出口" };
    }
    const ensured = ensureRuntime(s);
    if (ensured.err) return ensured.err;
    const text = payload && payload.text != null ? String(payload.text) : "";
    const chips = payload && Array.isArray(payload.ctx) ? payload.ctx : [];
    s.ctx = chips;
    s.ver = (s.ver || 1) + 1; // 会话上下文版本推进（确认票 ver CAS 的比对基线）
    s.msgs.push({ me: 1, t: text, ts: util.now() }); // me:1＝用户
    store.commit();
    const r = await ensured.rt.streamInput({ text: text, chips: chips }, auth || { id: s.uid });
    store.commit();
    return r;
  }

  /* ---------- 审批终裁（服务端裁决；ApprovalPanel 仅展示层） ---------- */
  async function decideApproval(id, decisionObj, auth) {
    const found = findApproval(id);
    if (!found) return { code: "NOT_FOUND", message: "审批不存在" };
    const s = found.session;
    const a = found.approval;
    if (auth && String(s.uid) !== String(auth.id)) {
      return { code: "FORBIDDEN", message: "跨租户访问：审批不属于你" };
    }
    const events = [];
    const pub = function (obj) {
      events.push(obj);
      ctx.bus.publish("l2:" + s.id, obj);
    };
    const operator = (auth && auth.id) || s.uid;

    // —— 有效性五连：未消费 → TTL → hash → ver CAS → 令牌 ——
    if (a.status !== "pending") {
      return { code: "STALE", message: "审批已终结或已消费", events: events };
    }
    if (util.now() > a.ttl_until) {
      a.status = "expired";
      governance.ledger(ctx, s, {
        tool: a.tool,
        status: "stale_expired",
        code: "STALE",
        args: governance.argsDigest(ctx, a.args),
        trace_id: governance.newTrace(ctx, s, "ttl")
      });
      pub({ type: "approval_resolved", sid: s.id, id: a.id, status: "expired" });
      store.commit();
      return { code: "STALE", message: "审批已过期（TTL 60s）", events: events };
    }
    if (governance.approvalHash(ctx, a) !== String(a.hash)) {
      return { code: "STALE", message: "上下文已变（hash 校验失败）", events: events };
    }
    const verIn = decisionObj && Object.prototype.hasOwnProperty.call(decisionObj, "ver")
      ? decisionObj.ver
      : a.ver;
    try {
      util.cas({ ver: a.ver }, verIn); // 版本不匹配 → throw {code:"STALE",message:"上下文已变"}
    } catch (e) {
      return { code: (e && e.code) || "STALE", message: (e && e.message) || "上下文已变", events: events };
    }
    const tok = util.verify(a.token);
    if (!tok || tok.hash !== String(a.hash) || tok.id !== a.id) {
      return { code: "STALE", message: "令牌校验失败（签名/过期）", events: events };
    }

    const decision = decisionObj && decisionObj.decision;
    // —— 驳回：留痕即可 ——
    if (decision === "reject") {
      a.status = "rejected";
      store.log("audit", {
        operator: String(operator),
        action: "l2_approval_reject",
        reason: (decisionObj && decisionObj.reason) || "用户驳回",
        audit_id: util.uid("AUD"),
        sessionId: s.id,
        tool: a.tool
      });
      governance.ledger(ctx, s, {
        tool: a.tool,
        status: "approval_rejected",
        args: governance.argsDigest(ctx, a.args),
        trace_id: governance.newTrace(ctx, s, "reject")
      });
      pub({ type: "approval_resolved", sid: s.id, id: a.id, status: "rejected" });
      store.commit();
      return { ok: true, status: "rejected", events: events };
    }
    if (decision !== "approve") {
      return { code: "BAD_DECISION", message: "decision 仅支持 approve|reject", events: events };
    }

    // —— approve：governance 复核（白名单/租户/预算——客户端谎报无效，执行前再核一次）——
    const allow = governance.assertToolAllowed(a.tool, s, ctx);
    if (allow) return Object.assign({ events: events }, allow);
    const bad = governance.validateArgs(a.tool, a.args, s, ctx, auth);
    if (bad) return Object.assign({ events: events }, bad);
    const budget = governance.checkBudget(s, a.est, ctx);
    if (budget) {
      a.status = "budget_blocked";
      pub({ type: "approval_resolved", sid: s.id, id: a.id, status: "budget_blocked" });
      store.commit();
      return Object.assign({ events: events }, { code: "BUDGET", message: budget.message });
    }
    a.status = "approved";
    store.commit();

    // —— 执行（tool_call 事件流 queued→done）——
    const tcId = util.uid("tc");
    const trace = governance.newTrace(ctx, s, a.tool);
    pub({ type: "tool_call", sid: s.id, id: tcId, tool: a.tool, status: "queued", trace_id: trace });
    const r = await tools.execute(a.tool, a.args, ctx, s, auth || { id: s.uid }, {
      budgetChecked: true,
      trace: trace // queued/running/done 事件与 agentrun 账本共用同一 trace_id（对账用）
    });
    if (!r.ok) {
      pub({
        type: "tool_call", sid: s.id, id: tcId, tool: a.tool,
        status: "failed", code: r.code, trace_id: r.trace_id || trace
      });
      store.commit();
      return Object.assign({ events: events }, { code: r.code || "FAILED", message: r.message });
    }
    pub({
      type: "tool_call", sid: s.id, id: tcId, tool: a.tool,
      status: "done", trace_id: r.trace_id || trace, result: r.result
    });

    // —— 代跑任务（点击可跳 S8/S10；经 bus jobs 事件推进）——
    if (r.job_id) {
      const task = {
        id: util.uid("task"),
        label: taskLabel(a, ctx),
        status: "queued",
        shot: a.args && a.args.shot_id ? a.args.shot_id : undefined,
        job_id: r.job_id,
        ts: util.now()
      };
      s.tasks.push(task);
      pub({ type: "task_update", sid: s.id, task: task });
    }
    const reply = execReply(a, ctx);
    s.msgs.push({
      me: 0, // 助手署名方
      t: adapter.sanitize(ctx, reply),
      ts: util.now(),
      sig: "制片组助手",
      runtime: adapter.RUNTIME_LABEL[s.mode]
    });
    store.log("audit", {
      operator: String(operator),
      action: "l2_approval_approve",
      audit_id: util.uid("AUD"),
      sessionId: s.id,
      tool: a.tool,
      est_cents: a.est && a.est.cents
    });
    pub({ type: "approval_resolved", sid: s.id, id: a.id, status: "approved" });
    store.commit();
    return {
      ok: true,
      result: r.result,
      used_cents: r.used_cents,
      trace_id: r.trace_id || trace,
      events: events
    };
  }

  function taskLabel(a, c) {
    const st = c.store.get();
    if (a.tool === "reroll_shot") {
      const sh = st.shots[a.args.shot_id];
      return "重拍 " + ((sh && sh.name) || a.args.shot_id);
    }
    if (a.tool === "music_candidates") {
      const sc = st.scenes[a.args.scene_id];
      return "配乐候选·" + ((sc && sc.name) || a.args.scene_id);
    }
    return a.tool;
  }
  function execReply(a, c) {
    const st = c.store.get();
    if (a.tool === "reroll_shot") {
      const sh = st.shots[a.args.shot_id] || {};
      return "重拍「" + (sh.name || a.args.shot_id) + "」已安排上队，跑完我在任务里同步。";
    }
    if (a.tool === "music_candidates") {
      const sc = st.scenes[a.args.scene_id] || {};
      return "「" + (sc.name || a.args.scene_id) + "」的配乐候选已安排生成，出来我会放进曲库供你挑。";
    }
    return "办好了。";
  }

  /* ---------- engine 完成事件 → 任务推进（契约 §2 bus topic "jobs"） ---------- */
  function onJobs(evt) {
    if (!evt) return;
    const jid = evt.job_id || evt.id || (evt.job && evt.job.id);
    if (!jid) return;
    const status = evt.status || (evt.job && evt.job.status);
    if (!status) return;
    const map = sessionsMap();
    Object.keys(map).forEach(function (sid) {
      const s = map[sid];
      (s.tasks || []).forEach(function (t) {
        if (String(t.job_id) !== String(jid)) return;
        if (t.status === "done" || t.status === "failed") return;
        const next =
          status === "failed" || status === "cancelled" || status === "error"
            ? "failed"
            : status === "done"
              ? "done"
              : status === "running"
                ? "running"
                : t.status;
        if (next === t.status) return;
        t.status = next;
        store.commit();
        try {
          ctx.bus.publish("l2:" + sid, { type: "task_update", sid: sid, task: t });
        } catch (e) { /* 事件面故障不改任务账 */ }
      });
    });
  }
  if (typeof ctx.bus.on === "function") {
    ctx.bus.on("jobs", onJobs);
  }

  return {
    createSession: createSession,
    getSession: getSession,
    listSessions: listSessions,
    getSessions: listSessions, // 契约 §5 别名
    postMessage: postMessage,
    decideApproval: decideApproval
  };
}

module.exports = { createL2 };
