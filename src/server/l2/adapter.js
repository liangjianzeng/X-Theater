"use strict";
/**
 * L2 adapter —— AgentRuntimeAdapter（CONTRACT §5，ADR-003 §4/§5.2）
 *
 * runtime＝可替换执行器：createRuntime(mode,session,ctx) → {spawn,streamInput,terminate,traceTail}。
 * 模式 A（dsh-stub，见 modeA.js）与模式 B（selfloop，见 modeB.js）输出同一事件流：
 *   bus.publish(`l2:${sid}`, {type:"msg_delta",...})            —— 3–5 段，setTimeout 50ms
 *   {type:"tool_call",id,tool,status:"queued"→"running"→"done"|"failed",trace_id}
 *   {type:"approval_request",approval}                           —— 昂贵动作
 * 裁决权永远在剧场服务端：本文件只做事件流与回合编排，白名单/预算/确认票全走 governance。
 */
const governance = require("./governance.js");
const tools = require("./tools.js");
const advisor = require("./advisor.js");

const RUNTIME_LABEL = { A: "DSH·模式A", B: "自建·模式B" };

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/** 文本分段（确定性：按标点切 token 后轮转均分成 3–5 段） */
function segment(text, n) {
  const s = String(text == null ? "" : text);
  const tokens = s.match(/[^。！？；，、]+[。！？；，、]?/g) || [s];
  const groups = [];
  for (let i = 0; i < n; i++) groups.push("");
  tokens.forEach(function (tk, i) { groups[i % n] += tk; });
  return groups.filter(function (g) { return g.length > 0; });
}

function segCount(ctx, seedObj) {
  const h = parseInt(String(ctx.util.hash12(seedObj)).replace(/[^0-9a-f]/gi, ""), 16);
  return 3 + ((Number.isFinite(h) ? h : 0) % 3); // 3–5 段
}

/** 用户面文案强制过 langlint.sanitize（[U] §7 语言表；A9 DoD） */
function sanitize(ctx, text) {
  const t = String(text == null ? "" : text);
  try {
    const ll = ctx && ctx.rules && ctx.rules.langlint;
    if (ll && typeof ll.sanitize === "function") return String(ll.sanitize(t));
    if (ll && typeof ll.lint === "function") {
      const r = ll.lint(t, { exempt: false });
      if (r && r.clean === false) return "这句话里有不合规范的行话，我换成大白话再说一次。";
    }
  } catch (e) { /* 净化面故障不阻断会话 */ }
  return t;
}

/** 事件流发射器（msg_delta 分段 / tool_call 状态推进） */
function makeStream(ctx, sid, publish) {
  const pub = publish || function (obj) { ctx.bus.publish("l2:" + sid, obj); };
  return {
    async deltas(text) {
      const msgId = ctx.util.uid("msg");
      const parts = segment(text, segCount(ctx, { t: text, sid: sid }));
      for (let i = 0; i < parts.length; i++) {
        await sleep(50);
        const last = i + 1 === parts.length;
        // t＝前端契约字段，text＝历史字段（双发兼容）
        pub({ type: "msg_delta", sid: sid, msg_id: msgId, seq: i + 1, t: parts[i], text: parts[i], done: last });
        if (last) pub({ type: "msg_done", sid: sid, msg_id: msgId, t: text });
      }
      return msgId;
    },
    tool(ev) {
      pub(Object.assign({ type: "tool_call", sid: sid }, ev));
    }
  };
}

// —— persona 人话（署名「制片组助手」；用词避开语言表禁词）——
const REPLY = {
  injected: "抱歉，这句话我不能照办。我能帮的是：查进度、问成本、重拍某一镜、择优、配配乐。",
  fallback: "我可以帮你：查进度、问成本、重拍第N镜、择优、给某场设情绪、出配乐候选。想做什么直接说。",
  forbidden: "这个请求越界了：我只能操作你自己的会话里、项目里真实存在的对象。",
  budget: "这一下会越过预算熔断线，我先掐住没放行。请到成本页核对预算，或请制片主任调整。",
  broken: "本会话的预算熔断线已经触发，我暂时不能代办任何动作。请到成本页核对后由制片主任放行。",
  failed: "这一步没走通，我先记下，你可以在任务视图看细节。",
  export: "导出成片这活儿不归我办——得先在交付页过完预检才能点火，我不能替你绕。要我帮你看看还差哪些项吗？",
  reroll_pre: function (shotName, est) {
    return "重拍「" + shotName + "」预计 " + est.cents + " 分、约 " + est.time_min + " 分钟。这是花真金白银的活儿，确认卡已发出，请在确认面板核对无误后批准。";
  },
  music_pre: function (sceneName, mood, est) {
    return "给「" + sceneName + "」备 3 段「" + mood + "」气质的配乐候选，预计 " + est.cents + " 分。确认卡已发出，批准后我就安排生成。";
    },
  need_shot_no: "要重拍或择优的话，说清是第几镜，比如「重拍第3镜」。",
  expensive_pre: function (tool, args, est, ctx) {
    const gpuNote = " ⚠ 本机 LLM 正在线——这些动作的下游生图/拍摄需要独占显卡，会被挡。建议先点左下角 GPU 徽章「停止 LLM 让路」再让我执行。";
    const gpuOn = ctx.llm && ctx.llm.enabled() && ctx.llm.blockedByLocalLLM ? ctx.llm.blockedByLocalLLM() : false;
    if (tool === "decide_card") {
      const t = String(args.card_type || "卡");
      return "你要「" + (args.action === "accept" ? "通过" : "重出") + "」" + t + "卡。这一步会推进制作流程，确认卡已发出，请在确认面板批准后我才执行。" + (gpuOn ? gpuNote : "");
    }
    if (tool === "shoot_episode") return "开机拍摄整集，预计 " + est.cents + " 分。这是最大的一笔开销，确认卡已发出——请核对预算后批准。" + (gpuOn ? gpuNote : "");
    if (tool === "export_episode") return "导出成片（含交付预检），预计 " + est.cents + " 分。确认卡已发出，批准后我就点火合成。";
    if (tool === "revise_scenes") return "修订剧本分场分镜表（" + ((args.scenes || []).length) + " 场），C1 卡会重导出重审。确认卡已发出，批准后生效。" + (gpuOn ? gpuNote : "");
    return "这步动作需要确认，确认卡已发出，请在确认面板批准后执行。";
  }
};

/**
 * 双模式共享回合机（模式 A/B 的 streamInput 都收敛到这里）：
 *   interpret = { detect(text)→{pattern,tool}|null, parse(text,chips,ctx,session)→intent|null }
 *   intent：{tool,args} 或 {refusal:"文案"}（解析得出但白名单无此工具的意图，如导出）。
 * 红队①：注入文本 → 不解析出任何工具；persona 人话拒答 + agentrun 记 injection_suspect。
 */
async function runTurn(opts) {
  const session = opts.session;
  const ctx = opts.ctx;
  const mode = opts.mode;
  const input = opts.input || {};
  const auth = opts.auth || { id: session.uid };
  const interpret = opts.interpret;
  const util = ctx.util;
  const events = [];
  const publish = function (obj) { events.push(obj); ctx.bus.publish("l2:" + session.id, obj); };
  const stream = makeStream(ctx, session.id, publish);
  const label = RUNTIME_LABEL[mode] || "";
  const trace0 = governance.newTrace(ctx, session, "turn");

  function pushMsg(t) {
    // 方向约定：me:1＝用户，me:0＝助手（sig 署名方）
    const m = { me: 0, t: t, ts: util.now(), sig: "制片组助手", runtime: label };
    session.msgs.push(m);
    return m;
  }
  async function say(t, card) {
    const clean = sanitize(ctx, t);
    await stream.deltas(clean);
    const m = pushMsg(clean);
    const c = cleanCardOf(ctx, card);
    if (c) {
      m.card = c;
      publish({ type: "msg_card", sid: session.id, card: c }); // 客户端桥接到最新一条助手气泡
    }
    ctx.store.commit();
    return clean;
  }

  if (session.broken) {
    await say(REPLY.broken);
    return { ok: false, code: "BUDGET", events: events, trace_id: trace0 };
  }

  const text = String(input.text == null ? "" : input.text);
  const chips = Array.isArray(input.chips) ? input.chips : [];

  // —— 注入检测（工具选择与授权全在服务端策略层；客户端只提交意图）——
  const inj = interpret.detect(text);
  if (inj) {
    if (inj.tool) governance.assertToolAllowed(inj.tool, session, ctx); // 白名单外假工具 → 账本 denied（红队①证据）
    governance.ledger(ctx, session, {
      tool: "none",
      status: "injection_suspect",
      args: { pattern: inj.pattern, digest: String(util.hash12({ text: text })) },
      trace_id: governance.newTrace(ctx, session, "injection")
    });
    ctx.store.commit();
    await say(REPLY.injected);
    return { ok: true, injected: true, events: events, trace_id: trace0 };
  }

  const intent = await interpret.parse(text, chips, ctx, session);
  if (!intent) {
    await say(REPLY.fallback, advisor.menuCard(ctx, session)); // 能力菜单卡：解析不出意图也给出可点的出口
    return { ok: true, intent: null, events: events, trace_id: trace0 };
  }
  if (intent.say) {
    await say(intent.say);
    return { ok: true, said: true, intent: intent.name || 'say', events: events, trace_id: trace0 };
  }
    if (intent.refusal) {
    await say(intent.refusal);
    return { ok: true, refused: true, intent: intent.name || null, events: events, trace_id: trace0 };
  }

  const tool = intent.tool;
  const args = intent.args || {};

  // —— 消息面总闸（服务端裁决；红队③跨租户在此 FORBIDDEN）——
  const gate = governance.gateTool(tool, args, session, ctx, auth);
  if (gate) {
    if (gate.code === "BUDGET") {
      await say(REPLY.budget);
      return { ok: false, code: "BUDGET", events: events, trace_id: trace0 };
    }
    const tcId = util.uid("tc");
    const trace = governance.newTrace(ctx, session, "gate");
    stream.tool({ id: tcId, tool: tool, status: "queued", trace_id: trace });
    stream.tool({ id: tcId, tool: tool, status: "failed", code: gate.code, trace_id: trace });
    await say(gate.code === "FORBIDDEN" ? (gate.message || REPLY.forbidden) : REPLY.failed); // 治理文案更具体（人话）
    return { ok: false, code: gate.code, events: events, trace_id: trace };
  }

  // —— 昂贵动作：只发确认票，绝不直接执行（红队②的正面路径）——
  if (governance.isExpensive(tool)) {
    const st = ctx.store.get();
    const est = governance.estimate(tool, args, ctx);
    if (governance.hasPendingApproval(session, tool, args, ctx)) {
      await say("这个确认卡已经发出去了，等你在确认面板拍板就行。");
      return { ok: true, needs_approval: true, events: events, trace_id: trace0 };
    }
    const approval = governance.createApproval(session, tool, args, est, ctx);
    if (tool === "reroll_shot") {
      const shot = st.shots[args.shot_id] || {};
      await say(REPLY.reroll_pre(shot.name || args.shot_id, est), advisor.approvalCard());
        } else if (tool === "music_candidates") {
      const scene = st.scenes[args.scene_id] || {};
      await say(REPLY.music_pre(scene.name || args.scene_id, args.mood || scene.mood || "释然", est), advisor.approvalCard());
    } else {
      await say(REPLY.expensive_pre(tool, args, est, ctx), advisor.approvalCard());
    }
    publish({ type: "approval_request", sid: session.id, approval: approval });
    // 前端契约事件（扁平）：approval_new
    publish(Object.assign({ type: "approval_new", sid: session.id }, approval));
    return { ok: true, needs_approval: true, approval_id: approval.id, events: events, trace_id: trace0 };
  }

  // —— 同步工具：queued → running → done ——
  const tcId = util.uid("tc");
  const trace = governance.newTrace(ctx, session, tool);
  stream.tool({ id: tcId, tool: tool, status: "queued", trace_id: trace });
  await sleep(50);
  stream.tool({ id: tcId, tool: tool, status: "running", trace_id: trace });
  const r = await tools.execute(tool, args, ctx, session, auth, { trace: trace }); // execute 已 async（全流程工具含 LLM 建议片）
  stream.tool({
    id: tcId, tool: tool,
    status: r.ok ? "done" : "failed",
    trace_id: r.trace_id || trace,
    code: r.code
  });
  {
    const fallback = r.ok ? replyFor(tool, args, r, ctx, session) : (r.code === "FORBIDDEN" ? (r.message || REPLY.forbidden) : (r.code === "GPU_BUSY" ? "这一步没生效：下游生图/拍摄要独占 GPU，而本机 LLM 正在线——点左下角 GPU 徽章「停止 LLM 让路」后，再让我执行一次。" : REPLY.failed));
    let rep = fallback;
    if (r.ok && ctx.llm && typeof ctx.llm.chat === "function" && ctx.llm.enabled()) {
      try { rep = await require("./llmintent.js").llmReply(tool, args, r, ctx, session, fallback); } catch (e) { rep = fallback; }
    }
    await say(rep, advisor.buildCard(tool, args, r, ctx, session)); // 顾问卡：现状之后直接给可点的下一步
  }
  return {
    ok: !!r.ok,
    code: r.code,
    result: r.result,
    used_cents: r.used_cents,
    trace_id: r.trace_id || trace,
    events: events
  };
}

/** 顾问卡清洗（模块级，供 selfcheck 直测）：只放行 label/hint/send/href/tab 已知键位；
    href 只许站内 hash 路由（防 javascript: 注入）；无动作的选项不放行；字符串全过 langlint。 */
function cleanCardOf(ctx, card) {
  if (!card || typeof card !== "object") return null;
  const out = {};
  if (card.kind) out.kind = String(card.kind).slice(0, 12);
  if (card.question) out.question = sanitize(ctx, String(card.question)).slice(0, 120);
  if (Array.isArray(card.options)) {
    out.options = card.options.slice(0, 4).map(function (o) {
      if (!o || typeof o !== "object") return null;
      const c = { label: sanitize(ctx, String(o.label || "")).slice(0, 40) };
      if (!c.label) return null;
      if (o.hint) c.hint = sanitize(ctx, String(o.hint)).slice(0, 48);
      if (o.send) c.send = sanitize(ctx, String(o.send)).slice(0, 120);
      if (o.href && advisor.HREF_RE.test(String(o.href))) c.href = String(o.href);
      if (o.tab && advisor.TABS.indexOf(o.tab) >= 0) c.tab = o.tab;
      if (!c.send && !c.href && !c.tab) return null; // 无动作的选项不放行
      return c;
    }).filter(Boolean);
    if (!out.options.length) delete out.options;
  }
  if (!out.question && !out.options) return null;
  return out;
}

/** 工具执行后的人话回执（persona 口吻，全部经 sanitize） */
function replyFor(tool, args, r, ctx, session) {
  const st = ctx.store.get();
  switch (tool) {
    case "query_progress": {
      const res = r.result || {};
      const done = Number(res.done) || 0, total = Number(res.total) || 0, queued = Number(res.queued) || 0;
      let s = "《" + (res.episode_title || "本集") + "》目前完成 " + done + "/" + total + " 镜，队列里排着 " + queued + " 个活儿。";
      if (total > 0 && done >= total) s += "都拍完了——下一步是导出成片（选项卡里点，我先出预检）。";
      else if (queued > 0) s += "排队不动的话，多半在等卡拍板或复审——说「看看待拍板的卡」我来查。";
      else if (done < total) s += "没有在跑的活儿，八成是等拍板——说「看看待拍板的卡」我来查。";
      return s;
    }
    case "query_cost": {
      const res = r.result || {};
      return "本集已花 " + res.cost_cents + " 分，影子账合计 " + res.billing_sum + " 分（" + res.billing_rows + " 笔），账本可逐镜穿透核对。";
    }
    case "pick_take": {
      const res = r.result || {};
      return "「" + (res.shot_name || args.shot_id) + "」的第 " + res.index + " 条我看过最稳，已标为选定。";
    }
    case "set_mood": {
      const res = r.result || {};
      return "「" + (res.scene_name || args.scene_id) + "」的情绪基调已改为「" + res.mood + "」，后续镜头都照这个调子走。";
    }
    case "query_cards": {
      const res = r.result || {};
      const all = res.cards || [];
      const pen = all.filter(c => c.status === "pending");
      const title = res.episode_title || "本集";
      if (!all.length) return "《" + title + "》还没有卡进来——卡流会随创作流程自己长出来，我盯着。";
      /* 顾问式：先点名最该先拍板的那张（依赖链），再说全景 */
      const ordered = pen.slice().sort((a, b) => governance.CARD_ORDER.indexOf(a.type) - governance.CARD_ORDER.indexOf(b.type));
      const first = ordered[0];
      let s;
      if (first) {
        const digest = governance.cardDigest(first);
        s = "《" + title + "》卡流：" + all.length + " 张里 " + pen.length + " 张等你拍板。最先动这张——" + governance.cardLabel(first.type) + "卡" + (first.ver != null ? "（v" + first.ver + "）" : "") + (digest ? "，" + digest : "") + "，" + (governance.CARD_NEXT[first.type] || "拍板后下游才好走") + "。";
        if (pen.length > 1) s += "其余待拍板：" + ordered.slice(1).map(c => governance.cardLabel(c.type)).join("、") + "。";
        s += "拍板我不代做——选项卡里去卡流页核对，或让我先出修改建议。";
      } else {
        s = "《" + title + "》" + all.length + " 张卡都定案了，没有压着的审批。该往前走了——要推进开机或导出，选项卡里点；有新卡进来我叫你。";
      }
      return s;
    }
    case "query_gpu": {
      const res = r.result || {};
      const llmOn = !!res.llmOnline;
      if (res.episode_driver === "dgx") {
        return "本集走 DGX 节点渲染，不吃本机显存；本机 LLM " + (llmOn ? "在线，两边互不打架。" : "当前离线/未启用。") + (llmOn ? "创作咨询随时说。" : "");
      }
      return llmOn
        ? "本机 LLM 正占着 5060 Ti，本机生图/拍摄暂时进不去——两个解法：去运维台把这部局的渲染节点切到 DGX（推荐，LLM 不用停），或临时停 LLM 让路。我不代停，选项卡里带你去。"
        : "本机 LLM 离线/未启用，本机渲染畅通，直接开机就行。";
    }
    case "query_projects": {
      const res = r.result || {};
      const ps = res.projects || [];
      return ps.length
        ? "现在有 " + ps.length + " 个项目：" + ps.map(p => "《" + (p.title || p.id) + "》").join("、") + "。想深入哪部，直接报名字；要开新剧也行。"
        : "还没有项目——回复个剧名，我给你从建项开始走。";
    }
    default:
      void st; void session;
      return "办好了。";
  }
}

/**
 * 工厂：mode A → dsh-stub；mode B → selfloop（懒 require，避免环）。
 */
function createRuntime(mode, session, ctx) {
  const m = String(mode || "A").toUpperCase();
  if (m === "A") return require("./modeA.js").createModeARuntime(session, ctx);
  if (m === "B") return require("./modeB.js").createModeBRuntime(session, ctx);
  return {
    kind: "invalid",
    spawn: function () { return { ok: false, code: "INVALID_MODE", message: "runtime_mode 仅支持 A|B" }; },
    streamInput: async function () { return { ok: false, code: "INVALID_MODE" }; },
    terminate: function () {},
    traceTail: function () { return []; }
  };
}

module.exports = {
  createRuntime,
  runTurn,
  makeStream,
  sanitize,
  segment,
  sleep,
  REPLY,
  RUNTIME_LABEL,
  cleanCardOf
};
