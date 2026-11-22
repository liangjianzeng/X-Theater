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
function scenesOfEpisode(st, epId) {
  return Object.keys(st.scenes || {}).map((k) => st.scenes[k])
    .filter((x) => x && String(x.episodeId) === String(epId));
}

const governance = require("./governance.js");
function util2uid(ctx) { try { return ctx.util.uid("AUD"); } catch (e) { return "AUD"; } }

const cardsMod = require("../api/cards.js"); // 拍板原语/建议/刷新（与路由同一实现）
const musicMod = require("../api/music.js"); // adoptCandidate（C9 采用）

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

async function execute(tool, args, ctx, session, auth, opts) {
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

  // 2026-11-21 用户裁决：助手不代停 LLM（曾为出海报停 LLM=职责颠倒）。
  // 生图类流程撞 GPU_BUSY → 引擎拒绝 → 助手如实转告，由用户自行决定让路时机。

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

  try {
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
    // ---- 全流程查询（2026-11-21 扩容） ----
    case "query_cards": {
      const epId = args.episode_id || governance.defaultEpisodeId(ctx, session);
      const list = Object.keys(st.cards || {}).map((k) => st.cards[k])
        .filter((c) => c.episodeId === epId)
        .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
        .map((c) => ({ id: c.id, type: c.type, status: c.status, ver: c.ver,
          ai_verdict: c.payload && c.payload.ai_review ? c.payload.ai_review.verdict : null,
          decided_at: c.decided_at || null }));
      result = { episode_id: epId, cards: list, pending: list.filter((c) => c.status === "pending").length };
      break;
    }
    case "query_card": {
      const c = st.cards[args.card_id];
      const p = c.payload || {};
      const digest = { id: c.id, type: c.type, status: c.status, ver: c.ver };
      if (c.type === "C1") { digest.summary = p.summary; digest.cast = (p.cast || []).map((x) => x.role + "·" + x.name);
        digest.scenes = (p.scenes || []).map((sc) => ({ name: sc.name, mood: sc.mood, shots: (sc.shots || []).length })); }
      if (c.type === "C6") digest.estimate = p.estimate || null;
      if (p.ai_review) digest.ai_review = { verdict: p.ai_review.verdict, engine: p.ai_review.engine };
      result = digest;
      break;
    }
    case "query_projects":
      result = { projects: Object.values(st.projects || {}).map((p) => ({ id: p.id, title: p.title, look: p.style_pkg && p.style_pkg.look })) };
      break;
    case "query_episodes": {
      const all = Object.values(st.episodes || {}).filter((e) => (args.project_id == null ? true : String(e.projectId) === String(args.project_id)));
      result = { episodes: all.map((e) => ({ id: e.id, title: e.title, projectId: e.projectId, stage: e.stage, decisions: e.decisions, cost_cents: e.cost_cents, budget_cents: e.budget_cents })) };
      break;
    }
    case "query_scenes": {
      const epId = args.episode_id || governance.defaultEpisodeId(ctx, session);
      const ep = st.episodes[epId] || {};
      result = { episode_id: epId, title: ep.title, scenes: (ep.script && ep.script.scenes) || [], cast: (ep.script && ep.script.cast) || [] };
      break;
    }
    case "query_music": {
      const epId = args.episode_id || governance.defaultEpisodeId(ctx, session);
      const lib = (st.music_lib || []).filter((m) => m && (scenesOfEpisode(st, epId) || []).some((sc) => sc.id === m.sceneId));
      const pend = (st.music_pending || {})[epId] || [];
      result = { episode_id: epId, adopted: lib.map((m) => ({ sceneId: m.sceneId, title: m.title })), candidates: pend.map((c) => ({ id: c.id, title: c.title, mood: c.mood, sceneId: c.sceneId, license: c.license })) };
      break;
    }
    case "query_gpu": {
      const cachedGpu = (ctx.llm && ctx.llm.enabled()) ? (ctx.llm.cached() || {}) : { configured: false, llmOnline: false };
      const epIdGpu = args.episode_id || governance.defaultEpisodeId(ctx, session);
      const epG = st.episodes[epIdGpu] || {};
      result = Object.assign({}, cachedGpu, {
        episode_driver: epG.driver === "dgx" ? "dgx" : "local",
        nodes: Object.keys(st.nodes || {}).map(function (id) { return { id: id, label: st.nodes[id].label, is_llm_host: (st.llm_node || "local") === id }; }),
        llm_node: st.llm_node || "local"
      });
      break;
    }
    // ---- 全流程动作 ----
    case "create_project": {
      const p = {
        id: util.uid("pj"),
        title: String(args.title).trim().slice(0, 40),
        style_pkg: { look: args.look || "写实电影感", palette: "青橙", ratio: "9:16" },
        music_enabled: true
      };
      st.projects = st.projects || {};
      st.projects[p.id] = p;
      ctx.store.log("audit", { operator: (auth && auth.id) || session.uid, action: "l2_create_project", audit_id: util.uid("AUD"), reason: p.id + "：" + p.title });
      result = { project_id: p.id, title: p.title, look: p.style_pkg.look };
      break;
    }
    case "create_episode": {
      let proj = args.project_id ? st.projects[args.project_id] : null;
      if (!proj && args.project_name) {
        const hits = Object.keys(st.projects || {}).map((k) => st.projects[k])
          .filter((p) => p.title === String(args.project_name).trim());
        proj = hits.length === 1 ? hits[0] : null;
      }
      if (!proj) return fail(ctx, session, tool, "FORBIDDEN", "项目定位失败（可先让助手建项目）", trace);
      const ep = {
        id: util.uid("ep"),
        projectId: proj.id,
        title: String(args.title).trim().slice(0, 60),
        brief: String(args.brief).trim().slice(0, 300),
        kind: "one_liner",
        script: null,
        stage: 1,
        decisions: 0,
        budget_cents: 5000,
        cost_cents: 0,
        paused: false,
        estimate_ver: null,
        shoot_confirmed_ver: null,
        est: null
      };
      // 2026-11-21 接通「对话一键成片」：派 scriptgen（LLM 结构化剧本）而非裸 c1plan——
      // 与首页 /api/quickstart 同链；完成后 cards.js 直接产 C1 真剧本卡（LLM 离线落占位，fail-open）
      const job = ctx.engine.enqueue("scriptgen", { episodeId: ep.id, title: ep.title, brief: ep.brief, kind: "one_liner", template: null }, { episodeId: ep.id, initiated_by: "user", free: true });
      st.episodes = st.episodes || {};
      st.episodes[ep.id] = ep;
      job_id = job ? job.id : null;
      ctx.store.log("audit", { operator: (auth && auth.id) || session.uid, action: "l2_create_episode", audit_id: util.uid("AUD"), reason: ep.id + "：" + ep.title });
      result = { episode_id: ep.id, title: ep.title, project_id: proj.id, job_id: job_id };
      break;
    }
    case "revise_scenes": {
      const ep = st.episodes[args.episode_id];
      const roles = (ep.script.cast || []).map((c) => c.role);
      const scenes = args.scenes.map((sc) => ({
        name: String(sc.name || "场").slice(0, 40),
        mood: String(sc.mood || "中性").slice(0, 20),
        shots: sc.shots.map((sh) => ({
          desc: String(sh.desc || "").slice(0, 300),
          sec: Number(sh.sec) > 0 ? Math.min(15, Math.round(Number(sh.sec))) : 5,
          cast: (Array.isArray(sh.cast) ? sh.cast.map(String) : []).filter((r) => roles.indexOf(r) >= 0),
          dialogue: String(sh.dialogue || "").slice(0, 200)
        }))
      }));
      ep.script.scenes = scenes;
      ctx.store.commit();
      cardsMod.refreshPendingC1(ctx, ep.id); // C1 重导出＋重审
      ctx.store.log("audit", { operator: (auth && auth.id) || session.uid, action: "l2_revise_scenes", audit_id: util.uid("AUD"), reason: ep.id + "：场景数 " + scenes.length });
      result = { episode_id: ep.id, scenes: scenes.length, refreshed_c1: true };
      break;
    }
    case "decide_card": {
      let card = args.card_id ? st.cards[args.card_id] : null;
      if (!card && args.card_type) {
        const pend = Object.keys(st.cards || {}).map((k) => st.cards[k])
          .filter((c) => c.status === "pending" && c.type === String(args.card_type));
        card = pend.length === 1 ? pend[0] : null;
      }
      if (!card) {
        const pend2 = Object.keys(st.cards || {}).map((k) => st.cards[k])
          .filter((c) => c.status === "pending");
        if (pend2.length === 1) card = pend2[0];
      }
      if (!card) return fail(ctx, session, tool, "FORBIDDEN", "待拍板卡定位失败", trace);
      const episode = st.episodes[card.episodeId] || null;
      const uid = (auth && auth.id) || session.uid;
      if (args.action === "accept") {
        const derived = cardsMod.advanceOnAccept(ctx, card, episode, uid);
        if (["C1", "C2", "C6", "C7", "C8"].indexOf(card.type) >= 0 && episode) {
          episode.decisions = (episode.decisions || 0) + 1;
          episode.stage = Math.min(8, 1 + (episode.decisions || 0));
        }
        card.status = "decided";
        card.decided_by = uid;
        card.decided_at = util.now();
        card.ver += 1;
        try { ctx.bus.publish("cards", { event: "decided", card: card }); } catch (e2) {}
        ctx.store.log("audit", { operator: uid, action: "l2_card_accept", audit_id: util.uid("AUD"), reason: card.id + "：" + card.type });
        result = { card_id: card.id, action: "accept", type: card.type, decisions: episode ? episode.decisions : null, derived_jobs: (derived || []).length };
      } else {
        const reJob = cardsMod.reEnqueueOnReject(ctx, card);
        card.ver += 1;
        if (card.type === "C4" && reJob) card.status = "pending";
        card.payload = Object.assign({}, card.payload, { regenerating: !!reJob, reject_note: "助手代为重出（确认票已核）" });
        card.updated_at = util.now();
        try { ctx.bus.publish("cards", { event: "updated", card: card }); } catch (e2) {}
        ctx.store.log("audit", { operator: uid, action: "l2_card_reject", audit_id: util.uid("AUD"), reason: card.id + "：" + card.type });
        result = { card_id: card.id, action: "reject", type: card.type, rerun_job: reJob ? reJob.id : null };
      }
      break;
    }
    case "adopt_music": {
      const r = musicMod.adoptCandidate(ctx, args.candidate_id, args.scene_id);
      result = { candidate_id: args.candidate_id, scene_id: args.scene_id, adopted: !!(r && r.entry) };
      break;
    }
    case "suggest_card": {
      const card = st.cards[args.card_id];
      const p = card.payload || {};
      const sys = [
        "你是剧场 Studio 的剧本策划顾问。依据修改意见修订分场分镜表，输出 JSON。",
        "硬约束：scenes 数组长度必须与输入一致；每场 shots 长度必须与输入一致；只改 name/mood/desc/dialogue/sec 的内容，不改结构；台词 ≤40 字；sec 取 3–15 整数；cast 只能用输入里出现的角色名。",
        '只输出：{"reply":"给制片人的一句话说明（≤120字）","scenes":[…完整新数组…]}'
      ].join("\n");
      const usr = "当前卡内容：" + JSON.stringify({ summary: p.summary, cast: p.cast, scenes: p.scenes }).slice(0, 4000) + "\n修改意见：" + String(args.note).slice(0, 300);
      const rr = await ctx.llm.chat([{ role: "system", content: sys }, { role: "user", content: usr }], { temperature: 0.4, maxTokens: 1600, timeoutMs: 60000 });
      if (!rr.ok) return fail(ctx, session, tool, "NOT_READY", "LLM 未给出建议（" + (rr.error || "超时") + "）", trace);
      const m = String(rr.content).match(/\{[\s\S]*\}/);
      let reply = "", scenes = null;
      if (m) {
        try {
          const j = JSON.parse(m[0]);
          reply = String(j.reply || "").slice(0, 200);
          if (Array.isArray(j.scenes) && Array.isArray(p.scenes) && j.scenes.length === p.scenes.length) {
            const castRoles = (p.cast || []).map((c) => c.role);
            const ok = j.scenes.every((sc, i) => Array.isArray(sc.shots) && sc.shots.length === (p.scenes[i].shots || []).length);
            if (ok) scenes = j.scenes;
          }
        } catch (e3) { /* 解析失败 → scenes=null */ }
      }
      if (!reply && !scenes) return fail(ctx, session, tool, "NOT_READY", "LLM 输出无法解析，请换个说法再试", trace);
      result = { card_id: card.id, reply: reply || "已按意见修订（见分镜表）", scenes: scenes };
      break;
    }
    case "shoot_episode": {
      const ep = st.episodes[args.episode_id];
      if (!ep.estimate_ver) return fail(ctx, session, tool, "NOT_READY", "预估未生成（先过 C5/C6 拍板）", trace);
      const c6 = Object.keys(st.cards || {}).map((k) => st.cards[k]).some((c) => c.episodeId === ep.id && c.type === "C6" && c.status === "decided");
      if (!c6) return fail(ctx, session, tool, "NOT_READY", "C6 开机确认卡还没拍板", trace);
      const shots = Object.keys(st.shots || {}).map((k) => st.shots[k])
        .filter((x) => x.episodeId === ep.id).sort((a, b) => (a.seq || 0) - (b.seq || 0));
      if (!shots.length) return fail(ctx, session, tool, "NOT_READY", "镜头未生成", trace);
      const jobs = [];
      shots.forEach((sh) => {
        jobs.push(ctx.engine.enqueue("video", { episodeId: ep.id, shotId: sh.id, sec: sh.sec || 5, width: sh.width, height: sh.height }, { episodeId: ep.id, initiated_by: "user", tier: sh.tier === "high" ? "high" : undefined }));
      });
      ep.shoot_confirmed_ver = ep.estimate_ver;
      ep.stage = Math.max(ep.stage || 1, 7);
      job_id = jobs.length ? jobs[0].id : null;
      ctx.store.log("audit", { operator: (auth && auth.id) || session.uid, action: "l2_shoot", audit_id: util.uid("AUD"), reason: ep.id + "：" + shots.length + " 镜" });
      result = { episode_id: ep.id, jobs: jobs.length, estimate_ver: ep.estimate_ver };
      break;
    }
    case "export_episode": {
      const deliverMod = require("../api/deliver.js");
      const pre = deliverMod.computePrecheck(ctx, args.episode_id);
      if (!pre.pass) return fail(ctx, session, tool, "BLOCKED_PRECHECK", "交付预检未全绿：缺 " + (pre.items || []).filter((i) => !i.pass).map((i) => i.item).join("、"), trace);
      const job = ctx.engine.enqueue("compose", { episodeId: args.episode_id, purpose: "export", resolution: "720x1280", platform_spec: { aspect: "9:16", target: "1080x1920", upscale: "compose_chain" }, explicit_mark: true, implicit_mark: true }, { episodeId: args.episode_id, initiated_by: "user" });
      job_id = job ? job.id : null;
      used_cents = (approval && approval.est && approval.est.cents) || est.cents;
      ctx.store.log("audit", { operator: (auth && auth.id) || session.uid, action: "l2_export", audit_id: util.uid("AUD"), reason: args.episode_id });
      result = { episode_id: args.episode_id, job_id: job_id, artifacts: (job && job.status === "done" && job.art) ? (job.art.art || job.art.path || null) : null };
      break;
    }
    default:
      return fail(ctx, session, tool, "FORBIDDEN", "未实现工具", trace);
  }
  } catch (e) {
    // 引擎/下游错误（如 GPU_BUSY、NOT_READY）转用户面人话，绝不 500
    return fail(ctx, session, tool, (e && e.code) || "FAILED", (e && e.message) || "执行失败", trace);
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
