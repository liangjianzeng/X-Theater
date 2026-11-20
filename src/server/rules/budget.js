"use strict";
/**
 * rules/budget.js —— 预算护栏（纯函数，确定性；暂停/告警副作用由调用方做）
 * 依据：CONTRACT §2（预算护栏：billing 累计 > budget*1.2 → 暂停该集）· §5（L2 熔断线 8000 分）
 */

const GUARD_RATIO = 1.2;
const L2_BROKEN_LINE_CENTS = 8000;

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/**
 * guard(episode, newCents) → {allow:true, reason:null} | {allow:false, reason:"人话"}
 * 投影成本（已花＋新增）> budget_cents * 1.2 → 不放行。
 */
function guard(episode, newCents) {
  if (!episode || typeof episode !== "object") {
    return { allow: false, reason: "缺少集信息，无法核销预算，已暂停" };
  }
  const budget = num(episode.budget_cents);
  const spent = num(episode.cost_cents);
  const add = Number(newCents);
  if (!isFinite(add) || add < 0) {
    return { allow: false, reason: "新增成本非法，已暂停" };
  }
  const line = budget * GUARD_RATIO;
  if (spent + add > line) {
    return {
      allow: false,
      reason:
        "本集已花 " + spent + " 分，再加 " + add + " 分会超过预算（" + budget +
        " 分）的 120%（上限 " + line + " 分）。拍摄已暂停，请先到成本页复核。",
    };
  }
  return { allow: true, reason: null };
}

/** L2 会话预算熔断线（分）——固定 8000（契约 §5 broken_line） */
function l2Line(cents) {
  void cents;
  return L2_BROKEN_LINE_CENTS;
}

module.exports = { guard, l2Line, GUARD_RATIO, L2_BROKEN_LINE_CENTS };
