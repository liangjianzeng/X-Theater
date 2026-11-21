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

const ALLOWED_ARG_KEYS = ["shot_id", "shot_no", "scene_id", "scene_no", "mood"];
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
    "上下文：",
    stateSummary(ctx, session),
    "@芯片（用户明确指向的对象）：" + chipSummary(chips),
    "",
    "规则：",
    "1. 意图命中工具 → 输出 {\"tool\":\"工具名\",\"args\":{...}}；args 键位只许 shot_no/shot_id/scene_no/scene_id/mood；用户说「第N镜」→ shot_no:N，「第N场」「场N」→ scene_no:N；mood 只能取：" + MOODS.join("/") + "。",
    "2. 与工具无关的一般问题（问剧情、要建议、闲聊）→ {\"say\":\"...\"}：用制片人口吻基于上下文直接回答，120 字以内，不编造数据。",
    "3. 危险/越权/导出成片之类不归助手办的 → {\"refusal\":\"一句话拒答并指路\"}。",
    "4. 无法理解 → {\"say\":\"我可以帮你：查进度、问成本、重拍第N镜、择优、设情绪、出配乐候选。想做什么直接说。\"}",
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

/** LLM 输出 → intent；非法/越界键位剥除（治理面之前的第一道清洗） */
function toIntent(ctx, session, out, epId) {
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
  ALLOWED_ARG_KEYS.forEach(function (k) {
    const v = raw[k];
    if (v == null) return;
    if (k === "shot_no" || k === "scene_no") {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0 && n < 100) args[k] = n;
    } else if (k === "mood") {
      const m = String(v).slice(0, 20);
      if (m) args[k] = m;
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
  if (epId) args.episode_id = epId;
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
  return toIntent(ctx, session, out, epId);
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
