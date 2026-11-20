"use strict";
/**
 * L2 tools —— theater-mcp 白名单工具面（CONTRACT §5）
 *
 * execute(tool,args,ctx,session,auth[,opts]) → {ok,result,used_cents,trace_id,job_id?}
 *  - 入口三连闸：白名单（governance.assertToolAllowed）→ 租户参数域（validateArgs）→ 预算熔断（checkBudget）；
 *  - 昂贵动作（reroll_shot/music_candidates）：未持有效确认票（hash+TTL+ver+未消费）→ {code:"CONFIRM_REQ"}，
 *    绝不落 engine.enqueue（红队②：绕过审批直发昂贵动作必失败）；
 *  - 全部执行落 agentrun 账本 + session.used_cents 累加 + commit。
 *
 * opts.budgetChecked=true：facade 审批路径已核过预算，避免重复告警。
 */
const governance = require("./governance.js");

function fail(ctx, session, tool, code, message, trace, extra) {
  governance.ledger(ctx, session, Object.assign(
    {
      tool: String(tool),
      status: code === "CONFIRM_REQ" ? "confirm_req" : "failed",
      code: code,
      args: governance.argsDigest(ctx, {}),
      trace_id: trace
    },
    extra || {}
  ));
  const out = { ok: false, code: code, message: message, trace_id: trace };
  return out;
}

function execute(tool, args, ctx, session, auth, opts) {
  const allow = governance.assertToolAllowed(tool, session, ctx);
  if (allow) {
    const trace = governance.newTrace(ctx, session, "allow");
    return fail(ctx, session, tool, allow.code, allow.message, trace);
  }
  const bad = governance.validateArgs(tool, args, session, ctx, auth);
  if (bad) {
    const trace = governance.newTrace(ctx, session, "tenant");
    governance.ledger(ctx, session, {
      tool: tool,
      status: "denied_tenant",
      code: "FORBIDDEN",
      args: governance.argsDigest(ctx, args),
      trace_id: trace
    });
    return { ok: false, code: bad.code, message: bad.message, trace_id: trace };
  }
  const est = governance.estimate(tool, args, ctx);
  if (!(opts && opts.budgetChecked)) {
    const budget = governance.checkBudget(session, est, ctx);
    if (budget) return { ok: false, code: "BUDGET", message: budget.message };
  }
  const trace = (opts && opts.trace) || governance.newTrace(ctx, session, tool);

  // —— 昂贵动作必答门（服务端终裁；红队②）——
  let approval = null;
  if (governance.isExpensive(tool)) {
    approval = governance.consumeApproval(session, tool, args, ctx);
    if (!approval) {
      return fail(
        ctx, session, tool, "CONFIRM_REQ",
        "昂贵动作未持有效确认票（hash/TTL/ver/未消费任一不满足），服务端拒绝执行",
        trace
      );
    }
  }

  const st = ctx.store.get();
  const util = ctx.util;
  let result = {};
  let used_cents = est.cents;
  let job_id = null;

  switch (tool) {
    case "query_progress": {
      const q = (ctx.engine && typeof ctx.engine.queueState === "function")
        ? (ctx.engine.queueState() || {})
        : {};
      // queueState 两种形态：扁平 {queued,running} 或按 lane {lane:{queued,running}}
      let queued = 0;
      let running = 0;
      if (typeof q.queued === "number") queued = q.queued;
      if (typeof q.running === "number") running = q.running;
      Object.keys(q).forEach(function (k) {
        const v = q[k];
        if (v && typeof v === "object") {
          queued += v.queued || 0;
          running += v.running || 0;
        }
      });
      const epId = args.episode_id || governance.defaultEpisodeId(ctx, session);
      const ep = st.episodes[epId] || null;
      const shots = Object.values(st.shots || {}).filter(function (s) {
        return String(s.episodeId) === String(epId);
      });
      const counts = {};
      let done = 0;
      shots.forEach(function (s) {
        counts[s.status] = (counts[s.status] || 0) + 1;
        if (s.status === "done") done += 1;
      });
      result = {
        episode_id: epId,
        episode_title: ep ? ep.title : null,
        total: shots.length,
        done: done,
        by_status: counts,
        queue: q,
        queued: queued + running
      };
      break;
    }
    case "query_cost": {
      const ep = st.episodes[args.episode_id];
      const rows = (ctx.store.readLog("billing") || []).filter(function (b) {
        return String(b.episodeId) === String(args.episode_id);
      });
      const sum = rows.reduce(function (acc, b) { return acc + (b.cents || 0); }, 0);
      result = {
        episode_id: args.episode_id,
        cost_cents: ep.cost_cents || 0,
        billing_sum: sum,
        billing_rows: rows.length,
        budget_cents: ep.budget_cents || 0
      };
      break;
    }
    case "reroll_shot": {
      const shot = st.shots[args.shot_id];
      const job = ctx.engine.enqueue("video", { shotId: args.shot_id }, {
        episodeId: args.episode_id,
        initiated_by: "user"
      });
      shot.rerolls = (shot.rerolls || 0) + 1;
      shot.status = "generating";
      job_id = job ? job.id : null;
      used_cents = (approval && approval.est && approval.est.cents) || est.cents;
      result = {
        shot_id: args.shot_id,
        shot_name: shot.name,
        job_id: job_id,
        rerolls: shot.rerolls
      };
      break;
    }
    case "pick_take": {
      const shot = st.shots[args.shot_id];
      const takes = shot.takes || [];
      if (!takes.length) {
        return fail(ctx, session, tool, "NO_TAKES", "该镜头还没有可选的条", trace);
      }
      const usable = takes
        .map(function (tk, i) { return { tk: tk, i: i }; })
        .filter(function (x) { return !x.tk.license || x.tk.license.usage !== "missing"; });
      const pool = usable.length ? usable : takes.map(function (tk, i) { return { tk: tk, i: i }; });
      let best = pool[0];
      pool.forEach(function (x) {
        if ((x.tk.cost_cents || 0) < (best.tk.cost_cents || 0)) best = x;
      });
      shot.bestTake = best.tk.id;
      shot.bestTakeIndex = best.i + 1;
      ctx.store.log("audit", {
        operator: (auth && auth.id) || session.uid,
        action: "l2_pick_take",
        audit_id: util.uid("AUD"),
        reason: "shot " + args.shot_id + " -> take " + best.tk.id
      });
      result = { shot_id: args.shot_id, shot_name: shot.name, best_take: best.tk.id, index: best.i + 1 };
      break;
    }
    case "music_candidates": {
      const scene = st.scenes[args.scene_id];
      const mood = args.mood || scene.mood || "释然";
      const job = ctx.engine.enqueue("music", { sceneId: args.scene_id, mood: mood }, {
        episodeId: scene.episodeId,
        initiated_by: "user"
      });
      job_id = job ? job.id : null;
      used_cents = (approval && approval.est && approval.est.cents) || est.cents;
      result = {
        scene_id: args.scene_id,
        scene_name: scene.name,
        mood: mood,
        candidates: 3,
        job_id: job_id
      };
      break;
    }
    case "set_mood": {
      const scene = st.scenes[args.scene_id];
      const before = scene.mood;
      scene.mood = String(args.mood).trim();
      ctx.store.log("audit", {
        operator: (auth && auth.id) || session.uid,
        action: "l2_set_mood",
        audit_id: util.uid("AUD"),
        reason: "scene " + args.scene_id + "：" + before + " -> " + scene.mood
      });
      result = { scene_id: args.scene_id, scene_name: scene.name, mood: scene.mood, before: before };
      break;
    }
    default:
      return fail(ctx, session, tool, "FORBIDDEN", "未实现工具", trace);
  }

  if (approval) approval.status = "executed"; // 一票一次，杜绝复用
  session.used_cents = (session.used_cents || 0) + used_cents;
  governance.ledger(ctx, session, {
    tool: tool,
    status: "ok",
    args: governance.argsDigest(ctx, args),
    trace_id: trace,
    used_cents: used_cents,
    job_id: job_id
  });
  ctx.store.commit();
  return { ok: true, result: result, used_cents: used_cents, trace_id: trace, job_id: job_id };
}

module.exports = { execute };
