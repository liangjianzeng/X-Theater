"use strict";
/**
 * L2 governance —— 服务端裁决层（CONTRACT §5，ADR-003 §4/§5.2 护栏语义）
 *
 * 纪律（凌驾一切 agent 能力之上）：
 *  - 工具面只许 theater-mcp 白名单（无 shell/文件/代码执行面）；白名单外 → FORBIDDEN + agentrun 账本记 denied（红队①证据）；
 *  - 昂贵动作（reroll_shot/music_candidates）必须持有效确认票（hash 校验 + TTL 60s + ver CAS + 未消费）才准执行，
 *    否则 → CONFIRM_REQ（红队②：DSH 侧任何「同意」都只是信号不是授权）；
 *  - 预算硬熔断：session.used_cents + 预估 > rules.budget.l2Line(8000) → BUDGET + 告警（服务端裁决，客户端谎报无效；
 *    approve 后、执行前再核一次）；
 *  - 参数域校验禁跨租户（红队③）：episodeId 必须属 auth 可见项目（种子单租户＝校验存在性 + session 绑定 uid）。
 *
 * 零依赖 CommonJS；一切副作用只经注入的 ctx={store,bus,engine,rules,util,cfg}。
 */

// ---- 白名单（theater-mcp 精调工具面；昂贵?:bool） ----
const TOOLS = {
  query_progress: { expensive: false, desc: "查询拍摄进度与队列态" },
  query_cost: { expensive: false, desc: "查询本集成本与影子账" },
  reroll_shot: { expensive: true, desc: "重拍指定镜头（花真金白银，必答门）" },
  pick_take: { expensive: false, desc: "为镜头选定最佳条" },
  music_candidates: { expensive: true, desc: "生成配乐候选（批量生成，必答门）" },
  set_mood: { expensive: false, desc: "设定场次情绪基调" }
};
const WHITELIST = Object.keys(TOOLS);
const APPROVAL_TTL_MS = 60 * 1000; // 契约 §5：TTL 60s
const DEFAULT_L2_LINE = 8000; // 熔断线（分）

// trace_id 序号（进程内单调，保证同调用序同输出＝确定性）
let _traceSeq = 0;

function newTrace(ctx, session, tag) {
  _traceSeq += 1;
  const h = String(ctx.util.hash12({
    s: session && session.id ? session.id : "-",
    tag: String(tag || "run"),
    n: _traceSeq,
    t: ctx.util.now()
  }));
  return "tr_" + h.slice(0, 16);
}

/** agentrun 账本（append-only，store.log 自动补 ts/id） */
function ledger(ctx, session, obj) {
  const row = Object.assign({ sessionId: session && session.id ? session.id : null }, obj);
  ctx.store.log("agentrun", row);
  return row;
}

/** args 摘要（账本只记摘要，不落敏感原文全量） */
function argsDigest(ctx, args) {
  return {
    keys: Object.keys(args || {}).sort(),
    digest: String(ctx.util.hash12(args || {}))
  };
}

/** 白名单闸：非白名单 → {code:"FORBIDDEN"} + 账本 denied（红队①证据） */
function assertToolAllowed(tool, session, ctx) {
  if (!Object.prototype.hasOwnProperty.call(TOOLS, tool)) {
    const trace = newTrace(ctx, session, "denied");
    ledger(ctx, session, {
      tool: String(tool),
      status: "denied",
      code: "FORBIDDEN",
      args: { reason: "not_in_whitelist" },
      trace_id: trace
    });
    return { code: "FORBIDDEN", message: "工具不在 theater-mcp 白名单（无 shell/文件/代码面）：" + tool };
  }
  return null;
}

function isExpensive(tool) {
  return !!(TOOLS[tool] && TOOLS[tool].expensive);
}

function l2Line(ctx) {
  // cfg.l2_line 为显式覆盖位（selfcheck/演练用）；否则取 rules.budget.l2Line（可能为函数或数值）
  if (ctx.cfg && typeof ctx.cfg.l2_line === "number" && ctx.cfg.l2_line > 0) return ctx.cfg.l2_line;
  try {
    const b = ctx.rules && ctx.rules.budget;
    if (b) {
      if (typeof b.l2Line === "function") {
        const n = Number(b.l2Line());
        if (isFinite(n) && n > 0) return n;
      }
      if (typeof b.l2Line === "number" && b.l2Line > 0) return b.l2Line;
      if (typeof b.L2_BROKEN_LINE_CENTS === "number" && b.L2_BROKEN_LINE_CENTS > 0) return b.L2_BROKEN_LINE_CENTS;
    }
  } catch (e) { /* 规则库故障走硬编码兜底线，绝不放行 */ }
  return DEFAULT_L2_LINE;
}

/** 成本预估（确定性；昂贵动作的预估进入确认票 hash） */
function estimate(tool, args, ctx) {
  const st = ctx.store.get();
  switch (tool) {
    case "reroll_shot": {
      const shot = (args && st.shots[args.shot_id]) || null;
      const sec = (shot && (shot.sec || shot.sec_num)) || 5;
      return { cents: 80 * Math.max(1, Math.ceil(sec / 5)), time_min: 3 };
    }
    case "music_candidates":
      return { cents: 45, time_min: 2 }; // 3 条 × 影子 5–15 分/条，取保守上界
    default:
      return { cents: 1, time_min: 1 };
  }
}

/**
 * 租户/参数域校验（红队③）。
 * episodeId 必须属 auth 可见项目：种子单租户＝校验存在性 + session 绑定 uid。
 */
function validateArgs(tool, args, session, ctx, auth) {
  const st = ctx.store.get();
  const a = args || {};
  const forbidden = function (msg) {
    return { code: "FORBIDDEN", message: msg };
  };
  // 参数面禁一切 shell/文件/代码类键位
  for (const k of ["shell", "cmd", "command", "exec", "code", "path", "file", "sudo", "script"]) {
    if (Object.prototype.hasOwnProperty.call(a, k)) return forbidden("参数含禁用域：" + k);
  }
  // 跨租户：args 带别的 session/uid 数据 → FORBIDDEN
  if (a.session_id != null && String(a.session_id) !== String(session.id)) {
    return forbidden("跨租户访问：参数指向其它会话");
  }
  for (const uidKey of ["uid", "user_id", "owner", "tenant_id"]) {
    if (a[uidKey] != null && String(a[uidKey]) !== String(session.uid)) {
      return forbidden("跨租户访问：参数指向其它用户");
    }
  }
  if (a.episode_id != null) {
    const ep = st.episodes[a.episode_id];
    if (!ep) return forbidden("对象不存在或不可见：" + a.episode_id);
    if (!st.projects[ep.projectId]) return forbidden("对象不存在或不可见：项目 " + ep.projectId);
    if (ep.uid && String(ep.uid) !== String(session.uid)) return forbidden("跨租户访问：该集不属于你");
  }
  if (a.shot_id != null) {
    const sh = st.shots[a.shot_id];
    if (!sh) return forbidden("对象不存在或不可见：" + a.shot_id);
    if (a.episode_id != null && String(sh.episodeId) !== String(a.episode_id)) {
      return forbidden("参数不一致：镜头不属于该集");
    }
  }
  if (a.scene_id != null) {
    const sc = st.scenes[a.scene_id];
    if (!sc) return forbidden("对象不存在或不可见：" + a.scene_id);
    if (a.episode_id != null && String(sc.episodeId) !== String(a.episode_id)) {
      return forbidden("参数不一致：场次不属于该集");
    }
  }
  // 必备参数
  switch (tool) {
    case "reroll_shot":
    case "pick_take":
      if (!a.shot_id) return forbidden("缺少镜头参数");
      if (!a.episode_id) return forbidden("缺少集参数");
      break;
    case "query_cost":
      if (!a.episode_id) return forbidden("缺少集参数");
      break;
    case "music_candidates":
      if (!a.scene_id) return forbidden("缺少场次参数");
      break;
    case "set_mood":
      if (!a.scene_id) return forbidden("缺少场次参数");
      if (typeof a.mood !== "string" || !a.mood.trim()) return forbidden("缺少情绪参数");
      if (!/^[一-龥A-Za-z0-9 ·、-]{1,12}$/.test(a.mood)) return forbidden("情绪参数非法");
      break;
    default:
      break;
  }
  void auth;
  return null;
}

/** 预算硬熔断（服务端裁决）：used + est > l2Line → BUDGET + 告警 */
function checkBudget(session, est, ctx, opts) {
  const cents = (session.used_cents || 0) + ((est && est.cents) || 0);
  const line = l2Line(ctx);
  if (cents <= line) return null;
  if (!(opts && opts.silentLedger)) {
    ledger(ctx, session, {
      tool: "budget",
      status: "budget_denied",
      code: "BUDGET",
      args: { used_cents: session.used_cents || 0, est_cents: (est && est.cents) || 0, line },
      trace_id: newTrace(ctx, session, "budget")
    });
  }
  const util = ctx.util;
  const alert = {
    id: util.uid("al"),
    kind: "l2_budget",
    msg: "L2 会话 " + session.id + " 预估 " + ((est && est.cents) || 0) + " 分将越过熔断线 " + line + " 分，服务端已掐断",
    ts: util.now(),
    acked: false
  };
  ctx.store.get().alerts.push(alert);
  ctx.store.commit();
  try { ctx.bus.publish("alerts", alert); } catch (e) { /* 告警通道故障不吞裁决 */ }
  return { code: "BUDGET", message: "预算熔断线拦截（服务端裁决）", alert: alert };
}

/** 消息面总闸：白名单 → 租户参数 → 预算 */
function gateTool(tool, args, session, ctx, auth) {
  const allow = assertToolAllowed(tool, session, ctx);
  if (allow) return allow;
  const bad = validateArgs(tool, args, session, ctx, auth);
  if (bad) {
    ledger(ctx, session, {
      tool: tool,
      status: "denied_tenant",
      code: "FORBIDDEN",
      args: argsDigest(ctx, args),
      trace_id: newTrace(ctx, session, "tenant")
    });
    return bad;
  }
  const budget = checkBudget(session, estimate(tool, args, ctx), ctx);
  if (budget) return budget;
  return null;
}

/** 确认票 canonical hash（hash＝动作参数摘要+成本预估+实体版本向量） */
function approvalHash(ctx, a) {
  return String(ctx.util.hash12({
    id: a.id,
    tool: a.tool,
    args: a.args,
    est: a.est,
    ver: a.ver,
    session: a.session
  }));
}

/** 签发确认票（令牌＝util.sign({id,hash,tool,ver})，TTL 60s） */
function createApproval(session, tool, args, est, ctx) {
  const util = ctx.util;
  const id = util.uid("apv");
  const ver = typeof session.ver === "number" ? session.ver : (session.ver = 1);
  const draft = {
    id: id,
    tool: tool,
    args: args,
    est: est,
    ver: ver,
    session: session.id,
    status: "pending",
    ttl_until: util.now() + APPROVAL_TTL_MS,
    created_at: util.now()
  };
  draft.hash = approvalHash(ctx, draft);
  // 令牌带 exp：util.verify 到期即 null（双保险，主裁决仍走 ttl_until）
  draft.token = util.sign({ id: id, hash: draft.hash, tool: tool, ver: ver, exp: draft.ttl_until });
  session.approvals.push(draft);
  ctx.store.commit();
  ledger(ctx, session, {
    tool: tool,
    status: "approval_requested",
    args: Object.assign(argsDigest(ctx, args), { est: est, apv: id }),
    trace_id: newTrace(ctx, session, "approval")
  });
  return draft;
}

/** 取用有效确认票（昂贵动作执行前的硬闸）：hash 校验 + TTL + 令牌校验 + 未消费 */
function consumeApproval(session, tool, args, ctx) {
  const util = ctx.util;
  const wantArgs = String(util.hash12(args || {}));
  const list = (session.approvals || []).filter(function (a) {
    return a.tool === tool && a.status === "approved" && String(util.hash12(a.args || {})) === wantArgs;
  });
  for (const a of list) {
    if (approvalHash(ctx, a) !== String(a.hash)) continue; // hash 被篡改
    if (util.now() > a.ttl_until) continue; // TTL 过期
    const tok = util.verify(a.token);
    if (!tok || tok.hash !== String(a.hash) || tok.id !== a.id) continue; // 令牌无效
    return a;
  }
  return null;
}

/** 同实体单 pending：昂贵工具已有未过期 pending 票时不重复签发 */
function hasPendingApproval(session, tool, args, ctx) {
  const util = ctx.util;
  const wantArgs = String(util.hash12(args || {}));
  return (session.approvals || []).some(function (a) {
    return (
      a.tool === tool &&
      a.status === "pending" &&
      util.now() <= a.ttl_until &&
      String(util.hash12(a.args || {})) === wantArgs
    );
  });
}

/** trace 尾：AgentRun 汇聚——按会话过滤 agentrun 账本 */
function traceTail(ctx, session) {
  const rows = ctx.store.readLog("agentrun") || [];
  return rows.filter(function (r) {
    return r && String(r.sessionId) === String(session.id);
  });
}

/** 默认集解析（会话上下文芯片 → 种子首集；单租户演示） */
function defaultEpisodeId(ctx, session) {
  const st = ctx.store.get();
  const chips = (session && session.ctx) || [];
  for (const c of chips) {
    if (c && String(c.type || "").toLowerCase() === "episode" && c.id) return c.id;
  }
  const eps = Object.values(st.episodes || {});
  if (session && session.ctx && session.ctx.episode_id) return session.ctx.episode_id;
  return eps.length ? eps[0].id : null;
}

module.exports = {
  TOOLS,
  WHITELIST,
  APPROVAL_TTL_MS,
  DEFAULT_L2_LINE,
  newTrace,
  ledger,
  argsDigest,
  assertToolAllowed,
  isExpensive,
  l2Line,
  estimate,
  validateArgs,
  checkBudget,
  gateTool,
  approvalHash,
  createApproval,
  consumeApproval,
  hasPendingApproval,
  traceTail,
  defaultEpisodeId
};
