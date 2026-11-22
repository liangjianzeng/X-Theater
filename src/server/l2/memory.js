"use strict";
/**
 * l2/memory.js — 会话记忆 v1：项目事实台账（蓝图 §6 P2「项目事实摘要，跨会话」，2026-11-22）
 *
 * 记什么：只记【真实执行结果】（工具 ok 后规则提取的中文事实，一句 ≤64 字，不露 ID）。
 *   不记推测、不记闲聊、不记查询类（query_* 只读无事实）、不记建议类（suggest_card 未拍板不算数）。
 * 谁来记：adapter.runTurn（同步工具成功后）＋ facade.decideApproval（昂贵工具批准执行成功后）。
 * 怎么用：llmintent.systemPrompt 注入「项目记忆」块（最新在前 ≤8 条）；规则脸不读——fail-open：
 *   LLM 离线时记忆只是不注入，一切照旧（§0 铁律二）。
 * 生命周期：state.assist_memory[projectId] 环缓冲（≤30 条）；记录失败绝不影响回合（try/catch 全包）。
 */
const governance = require("./governance.js");

const MAX_KEEP = 30;   // 每项目留存条数（环缓冲）
const MAX_INJECT = 8;  // prompt 注入条数（3B 级小模型，prompt 预算金贵）
const MAX_LEN = 64;    // 单条字数

function storeOf(st) {
  if (!st.assist_memory || typeof st.assist_memory !== "object") st.assist_memory = {};
  return st.assist_memory;
}

function fmtDate(ts) {
  const d = new Date(Number(ts) || 0);
  const mm = String(d.getMonth() + 1); const dd = String(d.getDate());
  return (mm.length < 2 ? "0" + mm : mm) + "-" + (dd.length < 2 ? "0" + dd : dd);
}

/** 事实提取：tool+args+result → 中文一句（全部来自真实 result，缺字段就不写，绝不编造）。无事实 → null */
function factOf(tool, args, result) {
  const r = result || {};
  const a = args || {};
  switch (tool) {
    case "create_project":
      return r.title ? "立项《" + r.title + "》" + (r.look ? "，影调「" + r.look + "」" : "") : null;
    case "create_episode": {
      if (!r.title) return null;
      const brief = String(a.brief || "").trim();
      return "新增一集《" + r.title + "》" + (brief ? "：" + brief.slice(0, 32) : "");
    }
    case "decide_card": {
      if (!r.type) return null;
      const label = governance.cardLabel(r.type) || r.type;
      return a.action === "reject"
        ? label + "卡重出一版（用户不满意旧版）"
        : label + "卡通过拍板";
    }
    case "apply_suggestion":
      return (r.type === "C1" ? "故事方向卡" : "卡") + "已按 AI 建议修订，仍等用户拍板";
    case "shoot_episode":
      return r.jobs != null ? "开机拍摄（" + r.jobs + " 镜任务派完）" : null;
    case "export_episode":
      return "导出成片（进入交付）";
    default:
      return null; // 查询/建议/镜头级操作不进台账
  }
}

/** 项目定位：result 自证优先（project_id/episode_id/card_id），兜底会话绑定集 */
function projectIdFor(ctx, session, tool, result) {
  const r = result || {};
  const st = ctx.store.get();
  if (r.project_id && (st.projects || {})[r.project_id]) return r.project_id;
  const epOf = function (epId) {
    const ep = (st.episodes || {})[epId];
    return ep && ep.projectId ? ep.projectId : null;
  };
  if (r.episode_id) { const p = epOf(r.episode_id); if (p) return p; }
  if (r.card_id) {
    const card = (st.cards || {})[r.card_id];
    if (card) { const p = epOf(card.episodeId); if (p) return p; }
  }
  try {
    const p = epOf(governance.defaultEpisodeId(ctx, session));
    if (p) return p;
  } catch (e) { /* 未绑定集 → 不记 */ }
  return null;
}

/** 写一条事实（工具 ok 后调用）；失败/无项目/无事实一律静默——记忆永不影响回合 */
function note(ctx, projectId, tool, args, result) {
  try {
    if (!projectId) return null;
    const text = factOf(tool, args, result);
    if (!text) return null;
    const st = ctx.store.get();
    const mem = storeOf(st);
    const arr = Array.isArray(mem[projectId]) ? mem[projectId] : [];
    const entry = { ts: (ctx.util && ctx.util.now ? ctx.util.now() : Date.now()), text: String(text).slice(0, MAX_LEN) };
    arr.push(entry);
    mem[projectId] = arr.slice(-MAX_KEEP);
    if (ctx.store && typeof ctx.store.commit === "function") ctx.store.commit();
    return entry;
  } catch (e) {
    return null;
  }
}

/** 读某项目的全部事实（时间正序） */
function list(ctx, projectId) {
  try {
    const arr = (ctx.store.get().assist_memory || {})[String(projectId)];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

/** prompt 注入块：最新在前 ≤MAX_INJECT 条；无记忆返回 ""（systemPrompt 据此省略整块） */
function block(ctx, epId) {
  try {
    const st = ctx.store.get();
    const ep = (st.episodes || {})[epId];
    if (!ep || !ep.projectId) return "";
    const arr = list(ctx, ep.projectId).slice(-MAX_INJECT).reverse();
    if (!arr.length) return "";
    return arr.map(function (e) { return "- " + fmtDate(e.ts) + " " + e.text; }).join("\n");
  } catch (e) {
    return "";
  }
}

module.exports = { note, list, block, factOf, projectIdFor, MAX_KEEP, MAX_INJECT, MAX_LEN };
