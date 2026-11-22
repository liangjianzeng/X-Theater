"use strict";
/**
 * prompts/validate.js — 输出契约校验（提示词体系 L5，2026-11-22，零依赖）
 *
 * 方案（docs/theater-prompt-system-plan.md §6.5）的最小落地：
 *  - anchorWarnings：定妆锚点五要素软校验（缺项记 warning，不 fail——提示词层引导而非硬闸）
 *  - validateIR：h3ir LLM 全英重写产物校验（六段标题保留 + <d> 台词标签逐字保留），
 *    替代旧版「长度 >40 即采纳」的裸检查
 */

/* 锚点五要素：性别年龄 / 脸型五官标志 / 发型发色 / 体型 / 服装 */
function anchorWarnings(desc) {
  const s = String(desc || "");
  const missing = [];
  if (!/岁|年龄|年老|年轻|青年|中年|少年/.test(s)) missing.push("性别年龄");
  if (!/脸|眉|眼|鼻|嘴|痣|颜|五官|酒窝/.test(s)) missing.push("脸型五官标志");
  if (!/发|辫|髻|秃/.test(s)) missing.push("发型发色");
  if (!/高|瘦|胖|壮|纤细|微胖|身形|身材|体态/.test(s)) missing.push("体型");
  if (!/穿|着|服装|袍|裙|衣|西装|卫衣|制服|铠甲|斗篷|衫|裤/.test(s)) missing.push("服装风格");
  return missing;
}

/**
 * IR 重写产物校验：out 必须保留全部六段标题；srcIr 里有 <d> 台词标签时逐个数量一致。
 * 返回 {ok, reason}——ok=false 时调用方 fail-open 用原 IR。
 */
function validateIR(out, srcIr) {
  const o = String(out || "");
  const segs = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
  for (const s of segs) {
    if (o.indexOf(s) < 0) return { ok: false, reason: "rewrite lost IR section: " + s };
  }
  const srcDlg = (String(srcIr || "").match(/<d>/g) || []).length;
  const outDlg = (o.match(/<d>/g) || []).length;
  if (srcDlg > 0 && outDlg !== srcDlg) return { ok: false, reason: "rewrite changed dialogue tag count (" + srcDlg + "→" + outDlg + "）" };
  return { ok: true, reason: null };
}

module.exports = { anchorWarnings, validateIR };
