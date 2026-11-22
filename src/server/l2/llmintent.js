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
  lines.push("待拍板卡：" + (pendingCards.map(function (c) { return c.type + "·" + (governance.cardLabel(c.type) || "") + "(" + c.id + ")"; }).join("、") || "无"));
  lines.push("本集驱动：" + ((ep.driver === "dgx") ? "DGX 节点（生图/视频走远程，不占本机显存，LLM 可常驻）" : "本机 5060 Ti（与本机 LLM 互斥；可在运维台切 DGX）"));
  const chips = [];
  return lines.join("\n");
}

function chipSummary(chips) {
  const list = (chips || []).filter(function (c) { return c && c.id; })
    .map(function (c) { return String(c.type) + "=" + String(c.id); });
  return list.length ? list.join("、") : "无";
}

/* 广告工具表（单一来源，2026-11-22）：systemPrompt 只广告这些；toIntent 也只认这些。
   在线双跑实锤：「写一首诗」被幻觉成白名单内但未广告的 runtime_spawn——
   parse 层先按广告面拒，幻觉工具根本到不了治理层（治理白名单照旧兜底）。 */
const LLM_TOOLS = [
  ["query_progress", "{} 查询拍摄进度"],
  ["query_cost", "{} 查询成本"],
  ["reroll_shot", '{"shot_no":N} 或 {"shot_id":"sh_..."} 重拍镜头（花钱，会出确认卡）'],
  ["pick_take", '{"shot_no":N} 或 {"shot_id":"sh_..."} 为镜头选最佳条'],
  ["music_candidates", '{"scene_no":N,"mood":"中文情绪词"} 生成配乐候选（花钱，会出确认卡）'],
  ["set_mood", '{"scene_no":N,"mood":"中文情绪词"} 设定场次情绪'],
  ["query_cards", "{} 查本集创作卡（待拍板/已拍板）"],
  ["query_card", '{"card_id":"card_..."} 查单卡详情'],
  ["query_projects", "{} 查项目列表"],
  ["query_episodes", '{"project_id":"pj_..."} 查项目下的集'],
  ["query_scenes", "{} 查剧本分场分镜表（画面与台词）"],
  ["query_music", "{} 查配乐挂接与候选"],
  ["query_gpu", "{} 查本机 LLM/GPU 占用"],
  ["create_project", '{"title":"项目名","look":"写实电影感|柔光唯美|冷冽悬疑"} 新建项目（用户指定了影调就必须放进 look 参数）'],
  ["create_episode", '{"project_id":"pj_..." 或 "project_name":"项目名","title":"集标题","brief":"一句话故事"} 新建集（自动生成结构化剧本＋C1 故事卡）'],
  ["suggest_card", '{"card_id":"card_...","note":"修改意见"} 对 C1 出 AI 修改建议（只建议，不改）'],
  ["adopt_music", '{"candidate_id":"mus_...","scene_id":"sc_..."} 采用配乐候选'],
  ["revise_scenes", '{"episode_id":"ep_...","scenes":[完整新分场分镜表]} 修订剧本（改源头，会出确认卡；scenes 结构必须与 query_scenes 的一致，场数/镜数不变）'],
  ["decide_card", '{"card_id":"card_..." 或 "card_type":"C1","action":"accept|reject"} 拍板卡（card_id 见上下文「待拍板卡」清单；会出确认卡，用户确认后才执行）'],
  ["apply_suggestion", '{"card_id":"card_..."} 把已出的修改建议落进待拍板 C1 卡（先 suggest_card 出过建议；采纳后仍由用户拍板）'],
  ["shoot_episode", '{"episode_id":"ep_..."} 开机拍摄（大额花钱，会出确认卡）'],
  ["export_episode", '{"episode_id":"ep_..."} 导出成片（需预检全绿，会出确认卡）'],
  ["search_assets", '{"domain":"music|images|characters|scenes","q":"关键词"} 检索素材中心资产库（只读）'],
  ["library_stats", "{} 素材中心库存统计（各域计数＋候选池）"],
  ["bind_asset", '{"domain":"music","asset_id":"mus_...","scene_no":N,"primary":true} 把素材绑定到场景（主曲/备选；不花钱）'],
  ["generate_music", '{"mood":"中文情绪词","type":"bgm|theme|ambient|mv","sec":45} 素材中心生成配乐候选（不挂场进候选池；花钱，会出确认卡）'],
  ["assist_lyrics", '{"paste":"歌词素材或主题","type":"theme|bgm|ambient|mv","mood":"中文情绪词"} AI 把素材扩写为结构化歌词（结果直接回给你看）'],
  ["assist_image_prompt", '{"idea":"画面想法","type":"establishing|empty|prop|poster|mood|mv","mood":"中文情绪词"} AI 把想法扩写为专业画面描述（结果直接回给你看）'],
  ["generate_image", '{"desc":"画面描述","type":"mood|establishing|empty|prop|poster|mv","ratio":"9:16"} 素材中心生成图像候选（不挂集进候选池；花钱，会出确认卡）']
];
const LLM_TOOL_NAMES = LLM_TOOLS.map(function (t) { return t[0]; });

function systemPrompt(ctx, session, chips) {
  /* 会话记忆 v1（蓝图 §6 P2）：跨会话项目事实台账注入（最新在前 ≤8 条；无记忆整块省略） */
  let memBlock = "";
  try { memBlock = require("./memory.js").block(ctx, governance.defaultEpisodeId(ctx, session)); } catch (e) { /* 无绑定集 → 无记忆 */ }
  return [
    "你是剧场 Studio 的制片组助手。根据用户的话与当前上下文，决定做什么。只输出一个 JSON 对象。",
    "",
    "可选工具（只能从中选；列表之外的任何工具名都无效）：",
    LLM_TOOLS.map(function (t) { return "- " + t[0] + " " + t[1]; }).join("\n"),
    "",
    "绑定纪律：你只服务上下文里的绑定剧集；对话历史若涉及其它剧集，一律以本次绑定为准，不要延续旧剧的语境、数字或进度。",
    "上下文：",
    stateSummary(ctx, session),
    ...(memBlock ? ["项目记忆（此前会话沉淀的事实，供延续语境；与上面实时状态冲突时以实时状态为准）：", memBlock, ""] : []),
    "@芯片（用户明确指向的对象）：" + chipSummary(chips),
    "",
    "规则：",
    "1. 用户想做的任何剧场内事务，优先选工具代办，不要让用户「自己去界面办」。语义映射：用户说「重出一版/重新生成/不满意」＝decide_card{action:\"reject\"}；说「就这个/通过/接受」＝decide_card{action:\"accept\"}；说「改一下X」＝suggest_card{note:X}；说「采纳建议/就用建议这版」＝apply_suggestion；说「建集/开一集」＝create_episode；问「到哪一步/进度/拍完没有」＝query_progress；问「要多久/多少钱/预估/花了多少」＝query_cost；问「为什么被挡/显存/GPU/开不了机」＝query_gpu（只读解释，绝不代停 LLM）；问「待拍板的卡/卡流」＝query_cards。意图命中工具 → 输出 {\"tool\":\"工具名\",\"args\":{...}}；args 只含该工具 schema 列出的键位；「第N镜」→ shot_no:N，「第N场」→ scene_no:N；mood 只能取：" + MOODS.join("/") + "。建集（create_episode）必须带 project_name（刚建完项目用户接着回梗概时，用刚建的剧名）或 project_id，以及 title 和 brief。",
    "1a. 查询必须走工具拿实时数据——上下文摘要只是定位线索，不是实时面板，禁止拿它直接 say 回答：问卡/待拍板/有几张卡/卡流 → query_cards；问进度/到哪一步/拍完没有/完成了没 → query_progress；问花了多少/成本/预算/还要多少钱 → query_cost；问显存/GPU/占卡/为什么开不了机 → query_gpu。这四类永远输出对应工具调用。",
    "2. 涉及改剧本（revise_scenes）需要完整新表——先输出 query_scenes 拿到当前表，除非用户已给出足够细节且你确信结构；拿不准就先用 suggest_card 出建议给用户看。",
    "3. 与工具无关的一般问题（问剧情、要剧场内的创作建议、打招呼闲聊）→ {\"say\":\"...\"}：制片人口吻、基于上下文直接回答，120 字以内；剧场外创作（写诗/写小说/写代码/讲故事）不是创作建议，走拒答且绝不调用任何工具。",
    "4. 数据引用纪律（防幻觉）：镜头/任务状态必须逐字引用上下文里的标记——✓=已通过，⚠=待复审，无标记=还没拍；禁止把「未拍」说成「已就绪」，禁止编造成本/进度数字。所有 ID（card_id/project_id/shot_id 等）只能从上下文复制，绝不许编造——上下文没有就改用 card_type/project_name 等名称定位。",
    "5. 完全剧场外且不该代办的事 → {\"refusal\":\"一句话拒答并指路\"}；无法理解 → {\"say\":\"我可以帮你：建项目建集、查进度成本、看卡拍板、改剧本、重拍镜头、择优、配乐、开机、导出。想做什么直接说。\"}",
    "示例（只示范格式与路由，内容勿抄）：",
    "用户「现在有哪些卡等我拍板？」→ {\"tool\":\"query_cards\",\"args\":{}}",
    "用户「显存还够吗？为什么开不了机？」→ {\"tool\":\"query_gpu\",\"args\":{}}",
    "用户「这集花了多少钱？」→ {\"tool\":\"query_cost\",\"args\":{}}",
    "用户「剧本写到哪一步了？」→ {\"tool\":\"query_progress\",\"args\":{}}",
    "用户「写一首诗/讲个故事」→ {\"say\":\"剧场外的创作不归我管；建剧建集、查进度成本、看卡拍板、配乐开机我随时能办。\"}",
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
  apply_suggestion: ["card_id"],
  suggest_card: ["card_id", "note"],
  create_project: ["title", "look"],
  create_episode: ["project_id", "project_name", "title", "brief"],
  revise_scenes: ["episode_id", "scenes"],
  adopt_music: ["candidate_id", "scene_id"],
  shoot_episode: ["episode_id"],
  export_episode: ["episode_id"],
  query_episodes: ["project_id"],
  // 素材中心（2026-11-22 施工 C6）
  search_assets: ["domain", "q"],
  library_stats: [],
  bind_asset: ["domain", "asset_id", "scene_no", "scene_id", "primary"],
  generate_music: ["mood", "type", "sec", "project_id"],
  // AI 生成编排（2026-11-22 下午③）
  assist_lyrics: ["paste", "type", "mood", "note"],
  assist_image_prompt: ["idea", "type", "mood", "ratio"],
  generate_image: ["desc", "type", "ratio", "project_id"]
};
const TEXT_KEYS = { title: 60, brief: 300, note: 300 };

/** LLM 输出 → intent；非法/越界键位剥除（治理面之前的第一道清洗） */
function toIntent(ctx, session, out, epId, text) {
  if (!out || typeof out !== "object") return null;
  if (typeof out.refusal === "string" && out.refusal.trim()) {
    return { refusal: String(out.refusal).trim().slice(0, 200), name: "llm_refusal" };
  }
  if (typeof out.say === "string" && out.say.trim()) {
    /* ID 纪律机械兜底：直答文本剥除 ep_/pj_/card_ 类编号（模型偶发不守规矩，清洗层保底） */
    const said = String(out.say).trim().replace(/[A-Za-z]{1,4}_[0-9a-fA-F]{6,}/g, "…").slice(0, 400);
    return { say: said };
  }
  const tool = typeof out.tool === "string" ? out.tool : null;
  // 广告面校验（parse 层第一道闸）：只认 systemPrompt 广告过的工具，幻觉名（如 runtime_spawn）直接 null
  // → 上层回退规则意图表；治理白名单（WHITELIST）在 gateTool 照旧兜底，两层互不替代。
  if (!tool || LLM_TOOL_NAMES.indexOf(tool) < 0) return null;
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
  // create_episode：LLM 忘传项目定位时的三级兜底——①用户话里提到项目名（原文匹配）；
  // ②会话链式语境（本会话刚建的项目＝lastProject，承接「建完项目答梗概就建集」的 ask 链）
  if (tool === "create_episode" && args.project_id == null && args.project_name == null) {
    const st2 = ctx.store.get();
    const hit = Object.keys(st2.projects || {}).map(function (k) { return st2.projects[k]; })
      .filter(function (p) { return p.title && String(text || "").indexOf(p.title) >= 0; });
    if (hit.length === 1) args.project_name = hit[0].title;
    else if (hit.length === 0 && session.lastProject && st2.projects[session.lastProject.id]) {
      args.project_name = session.lastProject.title;
    }
  }
  // card_id 幻觉清理（decide_card/suggest_card/query_card/apply_suggestion 通用）：state 无此 ID → 按类型/唯一 pending 补全
  if (["decide_card", "suggest_card", "query_card", "apply_suggestion"].indexOf(tool) >= 0 && args.card_id && !(ctx.store.get().cards || {})[args.card_id]) {
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

/* 回执推荐视角（按工具注入；与 advisor.js 选项卡同向，话术不与卡片重复罗列） */
const TOOL_ADVICE = {
  query_cards: "挑最该先拍板的那张（依赖顺序 C1故事方向→C2S试妆试镜→C2演员定妆→C3演员表锁定→C4分镜画面→C5样片审看→C6开机报价→C7灰区批复→C9配乐→C8交付），说清下游什么在等它。",
  query_progress: "指出卡点（排队/待复审/待拍板卡），给最短推进路径。",
  query_cost: "对照预算判断余量，花得多就点出花在哪。",
  query_gpu: "解释谁占着谁，给解锁选项（运维台切 DGX／停 LLM 让路），助手绝不代停。",
  query_scenes: "点出最薄弱的一场，给一句改进方向。",
  query_music: "说清哪些场还没挂音轨。",
  apply_suggestion: "说明建议落在卡上哪些地方（场次/镜头数变化），强调拍板权仍在用户。"
};

/** LLM 人话回执（成功后；失败 → 回退 replyFor 模板）
    顾问式三段：现状（中文名，不露 ID）→ 评估（卡在哪/影响什么）→ 推荐（下一步，选项卡承接动作）。 */
async function llmReply(tool, args, r, ctx, session, fallbackText) {
  if (!ctx.llm || typeof ctx.llm.chat !== "function" || !ctx.llm.enabled()) return fallbackText;
  const res = r.result || {};
  const sys = "你是剧场 Studio 的制片组助手——制片顾问，不是统计播报员。汇报连成一段大白话（≤150 字）：①现状，对象一律用中文名（《剧名》/卡类型中文名/场次名），绝不露 ep_/card_/pj_ 这类编号；②评估，这个结果意味着什么、卡在哪、影响下游什么；③推荐，给一条明确的下一步，可执行的动作会以选项卡出现在消息下方，话术点一句「我给你几个选项」即可，不必罗列步骤。只用执行结果里的真实数字与名称，禁止编造。";
  const usr = "用户请求：工具 " + tool + "，参数 " + JSON.stringify(args).slice(0, 200) + "\n执行结果：" + JSON.stringify(res).slice(0, 900) + (TOOL_ADVICE[tool] ? "\n推荐视角：" + TOOL_ADVICE[tool] : "");
  const out = await ctx.llm.chat(
    [{ role: "system", content: sys }, { role: "user", content: usr }],
    { temperature: 0.4, maxTokens: 280, timeoutMs: 20000 }
  );
  if (!out.ok || !out.content || out.content.length < 2) return fallbackText;
  /* ID 纪律机械兜底：回执文本剥除 ep_/pj_/card_/sh_/sc_ 类编号（模型不守规矩时清洗层保底） */
  const t = String(out.content).trim().replace(/[A-Za-z]{1,4}_[0-9a-fA-F]{6,}/g, "…").slice(0, 280);
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

module.exports = { buildInterpret, llmParse, llmReply, extractJson, toIntent, systemPrompt, LLM_TOOLS, LLM_TOOL_NAMES };
