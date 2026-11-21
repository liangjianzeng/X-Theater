"use strict";
/**
 * l2/llmintent.js — L2 真脑：LLM 意图解析＋人话回执（2026-11-21，llm-gw 配套）
 *
 * 接缝：runTurn 的 interpret.parse（原为 modeB 正则意图表）与 replyFor（原为手写模板）。
 * 治理红线一律不动：LLM 产出的 tool/args 照旧过 gateTool（白名单→租户→预算）＋昂贵确认票；
 * detectInjection 正则保留在前（LLM 不替代红线）。
 *
 * 契约（与 modeB.parseIntent 兼容，parse 升级为 async）：
 *   {tool,args}  —— 交给治理面
 *   {refusal,name} —— 人话拒答
 *   {say,text}   —— 无工具的直答（ grounded 于状态摘要；依然过 langlint）
 *   null         —— 回退规则意图表
 *
 * fail-open：LLM 不可达/超时/输出非法 → null（上层回退规则）；30s 截断；思考关闭（快）。
 * 防幻觉：LLM args 只接受白名单键位；episode_id/uid/session_id 一律剥除，由服务端注入
 * （chips＋defaultEpisodeId），租户裁决仍由 governance 把关（红队③不变）。
 */
const governance = require("./governance.js");

const MOODS = ["释然", "离别", "压抑", "温馨", "紧张", "悬疑", "欢快", "悲伤", "伤感", "治愈", "平静", "热烈"];

function stateSummary(ctx, session) {
  const st = ctx.store.get();
  const epId = governance.defaultEpisodeId(ctx, session);
  const ep = (st.episodes || {})[epId] || {};
  const scenes = Object.keys(st.scenes || {}).map(function (k) { return st.scenes[k]; })
    .filter(function (s) { return String(s.episodeId) === String(epId); })
    .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
  const shots = Object.keys(st.shots || {}).map(function (k) { return st.shots[k]; })
    .filter(function (s) { return String(s.episodeId) === String(epId); })
    .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
  const lines = [];
  lines.push("绑定剧集：" + epId + "《" + (ep.title || "未命名") + "》（stage " + (ep.stage || 1) + "）");
  lines.push("场次：" + (scenes.map(function (s) { return "seq" + s.seq + "「" + s.name + "」"; }).join("、") || "无"));
  lines.push("镜头：" + (shots.map(function (s) {
    return "seq" + s.seq + (s.status === "ok" ? "✓" : s.status === "pending_review" ? "⚠" : "");
  }).join("、") || "无"));
  const pendingCards = Object.keys(st.cards || {}).map(function (k) { return st.cards[k]; })
    .filter(function (c) { return c.status === "pending" && String(c.episodeId) === String(epId); });
  lines.push("待拍板卡：" + (pendingCards.map(function (c) { return c.type + "(" + c.id + ")"; }).join("、") || "无"));
  lines.push("本集驱动：" + ((ep.driver === "dgx") ? "DGX 节点（生图/视频走远程，不占本机显存，LLM 可常驻）" : "本机 5060 Ti（与本机 LLM 互斥；可在运维台切 DGX）"));
  const chips = [];
  return lines.join("\n");
}

function chipSummary(chips) {
  const list = (chips || []).filter(function (c) { return c && c.id; })
    .map(function (c) { return String(c.type) + "=" + String(c.id); });
  return list.length ? list.join("、") : "无";
}

function systemPrompt(ctx, session, chips) {
  return [
    "你是剧场 Studio 的制片组助手。根据用户的话与当前上下文，决定做什么。只输出一个 JSON 对象。",
    "",
    "可选工具（只能从中选）：",
    '- query_progress {} 查询拍摄进度',
    '- query_cost {} 查询成本',
    '- reroll_shot {"shot_no":N} 或 {"shot_id":"sh_..."} 重拍镜头（花钱，会出确认卡）',
    '- pick_take {"shot_no":N} 或 {"shot_id":"sh_..."} 为镜头选最佳条',
    '- music_candidates {"scene_no":N,"mood":"中文情绪词"} 生成配乐候选（花钱，会出确认卡）',
    '- set_mood {"scene_no":N,"mood":"中文情绪词"} 设定场次情绪',
    "",
    "全流程工具（都能直接代办）：",
    '- query_cards {} 查本集创作卡（待拍板/已拍板）',
    '- query_card {"card_id":"card_..."} 查单卡详情',
    '- query_projects {} 查项目列表',
    '- query_episodes {"project_id":"pj_..."} 查项目下的集',
    '- query_scenes {} 查剧本分场分镜表（画面与台词）',
    '- query_music {} 查配乐挂接与候选',
    '- query_gpu {} 查本机 LLM/GPU 占用',
    '- create_project {"title":"项目名","look":"写实电影感|柔光唯美|冷冽悬疑"} 新建项目（用户指定了影调就必须放进 look 参数）',
    '- create_episode {"project_id":"pj_..." 或 "project_name":"项目名","title":"集标题","brief":"一句话故事"} 新建集（自动出 C1 故事卡）',
    '- suggest_card {"card_id":"card_...","note":"修改意见"} 对 C1 出 AI 修改建议（只建议，不改）',
    '- adopt_music {"candidate_id":"mus_...","scene_id":"sc_..."} 采用配乐候选',
    '- revise_scenes {"episode_id":"ep_...","scenes":[完整新分场分镜表]} 修订剧本（改源头，会出确认卡；scenes 结构必须与 query_scenes 的一致，场数/镜数不变）',
    '- decide_card {"card_id":"card_..." 或 "card_type":"C1","action":"accept|reject"} 拍板卡（card_id 见上下文「待拍板卡」清单；会出确认卡，用户确认后才执行）',
    '- shoot_episode {"episode_id":"ep_..."} 开机拍摄（大额花钱，会出确认卡）',
    '- export_episode {"episode_id":"ep_..."} 导出成片（需预检全绿，会出确认卡）',
    "",
    "绑定纪律：你只服务上下文里的绑定剧集；对话历史若涉及其它剧集，一律以本次绑定为准，不要延续旧剧的语境、数字或进度。",
    "上下文：",
    stateSummary(ctx, session),
    "@芯片（用户明确指向的对象）：" + chipSummary(chips),
    "",
    "规则：",
    "1. 用户想做的任何剧场内事务，优先选工具代办，不要让用户「自己去界面办」。语义映射：用户说「重出一版/重新生成/不满意」＝decide_card{action:\"reject\"}；说「就这个/通过/接受」＝decide_card{action:\"accept\"}；说「改一下X」＝suggest_card{note:X}；说「建集/开一集」＝create_episode。意图命中工具 → 输出 {\"tool\":\"工具名\",\"args\":{...}}；args 只含该工具 schema 列出的键位；「第N镜」→ shot_no:N，「第N场」→ scene_no:N；mood 只能取：" + MOODS.join("/") + "。",
    "2. 涉及改剧本（revise_scenes）需要完整新表——先输出 query_scenes 拿到当前表，除非用户已给出足够细节且你确信结构；拿不准就先用 suggest_card 出建议给用户看。",
    "3. 与工具无关的一般问题（问剧情、要创作建议、闲聊）→ {\"say\":\"...\"}：制片人口吻、基于上下文直接回答，120 字以内。",
    "4. 数据引用纪律（防幻觉）：镜头/任务状态必须逐字引用上下文里的标记——✓=已通过，⚠=待复审，无标记=还没拍；禁止把「未拍」说成「已就绪」，禁止编造成本/进度数字。所有 ID（card_id/project_id/shot_id 等）只能从上下文复制，绝不许编造——上下文没有就改用 card_type/project_name 等名称定位。",
    "5. 完全剧场外且不该代办的事 → {\"refusal\":\"一句话拒答并指路\"}；无法理解 → {\"say\":\"我可以帮你：建项目建集、查进度成本、看卡拍板、改剧本、重拍镜头、择优、配乐、开机、导出。想做什么直接说。\"}",
    "只输出 JSON，不要解释。"
  ].join("\n");
}

/** 从 LLM 文本里抠 JSON（容忍 ``` 围栏与前后杂语） */
function extractJson(text) {
  const s = String(text || "").replace(/```(?:json)?/gi, "`").trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    return null;
  }
}

function resolveShotNo(ctx, session, n) {
  const st = ctx.store.get();
  const epId = governance.defaultEpisodeId(ctx, session);
  const shots = Object.keys(st.shots || {}).map(function (k) { return st.shots[k]; })
    .filter(function (s) { return String(s.episodeId) === String(epId); })
    .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
  return shots[n - 1] ? shots[n - 1].id : null;
}

function resolveSceneNo(ctx, session, n) {
  const st = ctx.store.get();
  const epId = governance.defaultEpisodeId(ctx, session);
  const scenes = Object.keys(st.scenes || {}).map(function (k) { return st.scenes[k]; })
    .filter(function (s) { return String(s.episodeId) === String(epId); })
    .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
  return scenes[n - 1] ? scenes[n - 1].id : null;
}

/** 各工具允许的 args 键位（防幻觉注入：schema 外的键一律剥除，租户面由 governance 把关） */
const TOOL_ARG_KEYS = {
  default: ["shot_id", "shot_no", "scene_id", "scene_no", "mood"],
  query_card: ["card_id"],
  decide_card: ["card_id", "card_type", "action"],
  suggest_card: ["card_id", "note"],
  create_project: ["title", "look"],
  create_episode: ["project_id", "project_name", "title", "brief"],
  revise_scenes: ["episode_id", "scenes"],
  adopt_music: ["candidate_id", "scene_id"],
  shoot_episode: ["episode_id"],
  export_episode: ["episode_id"],
  query_episodes: ["project_id"]
};
const TEXT_KEYS = { title: 60, brief: 300, note: 300 };

/** LLM 输出 → intent；非法/越界键位剥除（治理面之前的第一道清洗） */
function toIntent(ctx, session, out, epId, text) {
  if (!out || typeof out !== "object") return null;
  if (typeof out.refusal === "string" && out.refusal.trim()) {
    return { refusal: String(out.refusal).trim().slice(0, 200), name: "llm_refusal" };
  }
  if (typeof out.say === "string" && out.say.trim()) {
    return { say: String(out.say).trim().slice(0, 400) };
  }
  const tool = typeof out.tool === "string" ? out.tool : null;
  if (!tool || !governance.WHITELIST.some(function (t) { return t === tool; })) return null;
  const raw = out.args && typeof out.args === "object" ? out.args : {};
  const args = {};
  (TOOL_ARG_KEYS[tool] || TOOL_ARG_KEYS.default).forEach(function (k) {
    const v = raw[k];
    if (v == null) return;
    if (k === "shot_no" || k === "scene_no") {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0 && n < 100) args[k] = n;
    } else if (k === "mood") {
      const m = String(v).slice(0, 20);
      if (m) args[k] = m;
    } else if (k === "action") {
      if (v === "accept" || v === "reject") args[k] = v;
    } else if (k === "scenes") {
      if (Array.isArray(v) && v.length) args[k] = v;
    } else if (TEXT_KEYS[k] != null) {
      const t = String(v).trim().slice(0, TEXT_KEYS[k]);
      if (t) args[k] = t;
    } else {
      const id = String(v).replace(/[^A-Za-z0-9_\-]/g, "");
      if (id) args[k] = id;
    }
  });
  // no/序号 → id 解析（与 modeB shotsOfEpisode 同口径；解析失败交给 governance 报错文案）
  if (args.shot_no != null && args.shot_id == null) {
    const id = resolveShotNo(ctx, session, args.shot_no);
    if (id) args.shot_id = id;
    delete args.shot_no;
  }
  if (args.scene_no != null && args.scene_id == null) {
    const id = resolveSceneNo(ctx, session, args.scene_no);
    if (id) args.scene_id = id;
    delete args.scene_no;
  }
  // create_episode：LLM 忘传项目定位时，用原文匹配项目名兜底（真实项目名出现在用户话里）
  if (tool === "create_episode" && args.project_id == null && args.project_name == null) {
    const st2 = ctx.store.get();
    const hit = Object.keys(st2.projects || {}).map(function (k) { return st2.projects[k]; })
      .filter(function (p) { return p.title && String(text || "").indexOf(p.title) >= 0; });
    if (hit.length === 1) args.project_name = hit[0].title;
  }
  // card_id 幻觉清理（decide_card/suggest_card/query_card 通用）：state 无此 ID → 按类型/唯一 pending 补全
  if (["decide_card", "suggest_card", "query_card"].indexOf(tool) >= 0 && args.card_id && !(ctx.store.get().cards || {})[args.card_id]) {
    delete args.card_id;
    const st3 = ctx.store.get();
    const pend3 = Object.keys(st3.cards || {}).map(function (k) { return st3.cards[k]; })
      .filter(function (c) { return c.status === "pending"; });
    const wanted = args.card_type || (/C1/.test(String(text || "")) ? "C1" : null);
    const hit = wanted ? pend3.filter(function (c) { return c.type === wanted; }) : pend3;
    if (hit.length === 1) args.card_id = hit[0].id;
    else if (pend3.length === 1) args.card_id = pend3[0].id;
    if (tool === "decide_card" && !args.card_type && args.card_id) args.card_type = (ctx.store.get().cards || {})[args.card_id].type;
  }
  if (epId && args.episode_id == null) args.episode_id = epId; // 默认绑定本集（显式给的尊重 LLM/清洗结果）
  return { tool: tool, args: args };
}

/** LLM 意图解析（async；失败→null 回退规则） */
async function llmParse(text, chips, ctx, session) {
  if (!ctx.llm || typeof ctx.llm.chat !== "function" || !ctx.llm.enabled()) return null;
  const r = await ctx.llm.chat(
    [
      { role: "system", content: systemPrompt(ctx, session, chips) },
      { role: "user", content: String(text || "").slice(0, 500) }
    ],
    { temperature: 0.2, maxTokens: 300, timeoutMs: 30000 }
  );
  if (!r.ok) return null;
  const out = extractJson(r.content);
  const epId = governance.defaultEpisodeId(ctx, session);
  return toIntent(ctx, session, out, epId, text);
}

/** LLM 人话回执（成功后；失败 → 回退 replyFor 模板） */
async function llmReply(tool, args, r, ctx, session, fallbackText) {
  if (!ctx.llm || typeof ctx.llm.chat !== "function" || !ctx.llm.enabled()) return fallbackText;
  const res = r.result || {};
  const sys = "你是剧场 Studio 的制片组助手。用一句话向制片人汇报刚办完的事，用大白话、带关键数字，不要客套。这是系统记录的真实结果，不许编造别的数字。";
  const usr = "用户请求：工具 " + tool + "，参数 " + JSON.stringify(args) + "\n执行结果：" + JSON.stringify(res).slice(0, 600);
  const out = await ctx.llm.chat(
    [{ role: "system", content: sys }, { role: "user", content: usr }],
    { temperature: 0.4, maxTokens: 160, timeoutMs: 15000 }
  );
  if (!out.ok || !out.content || out.content.length < 2) return fallbackText;
  const t = String(out.content).trim().slice(0, 220);
  return t;
}

/**
 * interpret 组装：detect 永远是正则红线；parse = LLM 优先（失败/无匹配回退规则表）。
 * rules = {detect, parse}（modeA/modeB 各自传入）。
 */
function buildInterpret(ctx, rules) {
  return {
    detect: rules.detect,
    parse: async function (text, chips, c, session) {
      if (ctx.llm && ctx.llm.enabled()) {
        try {
          const i = await llmParse(text, chips, ctx, session);
          if (i) return i;
        } catch (e) { /* fail-open → 规则表 */ }
      }
      return rules.parse(text, chips, ctx, session);
    }
  };
}

module.exports = { buildInterpret, llmParse, llmReply, extractJson, toIntent, systemPrompt };
