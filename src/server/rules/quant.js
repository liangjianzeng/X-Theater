"use strict";
/**
 * rules/quant.js —— 量化档硬规则（纯函数，不碰 store；audit 副作用由调用方落）
 * 依据：CONTRACT §4 · theater-ui-interaction-design §11.2
 * 硬规则序：nvfp4（首选）→ int8（次选）→ MXFP8+FP8（兜底，必须附理由＋审计）。
 * 规则外档位（FP8/bf16 直选等）不可达。
 */

const TIER_ORDER = ["nvfp4", "int8", "MXFP8+FP8"];
const FALLBACK_TIER = "MXFP8+FP8";

function normTier(t) {
  return String(t == null ? "" : t).trim().toLowerCase();
}

function fail(message) {
  const err = new Error(message);
  err.code = "QUANT_RULE";
  throw err;
}

/**
 * decide(registryEntry, tier, reason)
 *  → {ok:true, audit_needed:boolean}
 *  → throw {code:"QUANT_RULE", message}
 * registryEntry 形如 {id,model,tiers:[...],unavail:[...]}。
 * 兜底档成功 → audit_needed:true（调用方写 audit #Q-xxx）。
 */
function decide(registryEntry, tier, reason) {
  if (!registryEntry || typeof registryEntry !== "object") {
    fail("QUANT_RULE：缺少注册表段位条目");
  }
  const entryId = registryEntry.id || registryEntry.engine || registryEntry.engineId || "engine";
  const tiersSrc =
    Array.isArray(registryEntry.tiers) && registryEntry.tiers.length
      ? registryEntry.tiers
      : Array.isArray(registryEntry.published) && registryEntry.published.length
        ? registryEntry.published
        : TIER_ORDER;
  // 允许集＝tiers ∪ published（切到现行已发布档＝无操作成功；规则外新档仍不可达）
  const tiers = tiersSrc.map(normTier)
    .concat(Array.isArray(registryEntry.published) ? registryEntry.published.map(normTier) : [])
    .concat(Array.isArray(registryEntry.tiers) ? registryEntry.tiers.map(normTier) : []);
  const unavail = (Array.isArray(registryEntry.unavail) ? registryEntry.unavail : []).map(normTier);

  const tRaw = String(tier == null ? "" : tier).trim();
  const t = normTier(tRaw);
  if (!t || !tiers.includes(t)) {
    fail(
      "QUANT_RULE：未知量化档「" + (tRaw || "空") + "」：" + entryId +
      " 可选 [" + tiersSrc.join(" → ") + "]；硬规则序 nvfp4→int8→MXFP8+FP8，规则外档位（FP8/bf16 直选）不可达"
    );
  }
  if (unavail.includes(t)) {
    fail(
      "QUANT_RULE：权重未发布：核实通过后才能切 · 硬规则序 nvfp4→int8→MXFP8+FP8" +
      "（" + entryId + " 的档「" + tRaw + "」标记为未发布）"
    );
  }
  if (t === normTier(FALLBACK_TIER)) {
    const r = typeof reason === "string" ? reason.trim() : "";
    if (!r) {
      fail("QUANT_RULE：兜底档「" + FALLBACK_TIER + "」必须附理由（需理由），并生成审计记录");
    }
    return { ok: true, audit_needed: true };
  }
  return { ok: true, audit_needed: false };
}

module.exports = { decide, TIER_ORDER, FALLBACK_TIER };
