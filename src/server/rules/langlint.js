"use strict";
/**
 * rules/langlint.js —— 语言表禁词 lint / 净化（纯函数，零依赖，确定性）
 * 依据：CONTRACT §4（rules.langlint）· theater-ux-design §7 语言表 · theater-ui-interaction-design §12 lint 清单
 * 豁免面＝S15「模型与运行时」配置面等内部/机读界面：lint(text,{exempt:true}) 直 clean。
 */

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// —— 禁词表（契约 §4：take/seed/prompt/i2v/LoRA/stale/超分/补帧/路由/worker + 模型名正则表）——
const WORD_TERMS = [
  ["take", "条"],
  ["seed", "复刻编号"],
  ["prompt", "导演阐述"],
  ["i2v", "开机拍摄"],
  ["LoRA", "演员签约"],
  ["stale", "需重做"],
  ["worker", "拍摄工位"],
];
const CJK_TERMS = [
  ["超分", "画质增强"],
  ["补帧", "画面顺滑处理"],
  ["路由", "调度"],
];
const MODEL_ALT =
  "qwen-image|MiniMax|LTX-2\\.5|FastH3|ACE-Step|CosyVoice|DeepSeek|SGLang|ComfyUI|GGUF|nvfp4|int8|MXFP8";

// —— 规则表：ASCII 词带词边界（含复数 s），CJK 词直接子串，模型名走合并正则 ——
const RULES = [];
for (const [term, repl] of WORD_TERMS) {
  RULES.push({
    term,
    re: new RegExp("(?<![A-Za-z0-9])" + esc(term) + "(?:s)?(?![A-Za-z0-9])", "gi"),
    repl,
  });
}
for (const [term, repl] of CJK_TERMS) {
  RULES.push({ term, re: new RegExp(esc(term), "g"), repl });
}
RULES.push({ term: "model-name", re: new RegExp(MODEL_ALT, "gi"), repl: "自部署档" });

// 契约口径的禁词数组（字符串词 + 模型名正则），供 CI/测试直接引用
const FORBIDDEN = WORD_TERMS.map(([t]) => t)
  .concat(CJK_TERMS.map(([t]) => t))
  .concat([new RegExp(MODEL_ALT, "i")]);

/**
 * lint(text,{exempt}) → {clean,hits[]}
 * hits=[{term,rule,at}]，按首次出现排序去重；exempt:true 直 clean（豁免面）。
 */
function lint(text, opts) {
  if (opts && opts.exempt === true) return { clean: true, hits: [] };
  const s = typeof text === "string" ? text : text == null ? "" : String(text);
  const hits = [];
  for (const rule of RULES) {
    const re = rule.re;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      hits.push({ term: m[0], rule: rule.term, at: m.index });
      if (m.index === re.lastIndex) re.lastIndex++;
      if (hits.length > 2000) break;
    }
  }
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const k = h.rule + "|" + h.term.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(h);
    }
  }
  out.sort((a, b) => a.at - b.at);
  return { clean: out.length === 0, hits: out };
}

/**
 * sanitize(text) → 把命中词映射为人话替代表（[U] §7 映射口径；替换串绝不含禁词）。
 * 不受 exempt 影响（净化是兜底过滤面，用户可见文案必须过它）。
 */
function sanitize(text) {
  let s = typeof text === "string" ? text : text == null ? "" : String(text);
  for (const rule of RULES) {
    const re = rule.re;
    re.lastIndex = 0;
    s = s.replace(re, rule.repl);
  }
  return s;
}

module.exports = { FORBIDDEN, lint, sanitize, MODEL_ALT };
