"use strict";
/**
 * workers/moderate.js — 机审（规则码＋抽帧 stub）
 * 契约 §4：ctx.rules.moderation.inspect(shot, ctx) 结果回写 job。
 * 结果对象含 pass/reason/verdict（cards.onModerateDone 读 job.art || job.result）：
 * pass=false → verdict:"fail_review"＋reason（→ review_q＋C7 复审卡）；机审成本 1 分。
 */

const NAME = "moderate";
const COST_CENTS = 1;

function inspectViaRules(shot, ctx) {
  const viaCtx = ctx && ctx.rules && ctx.rules.moderation && ctx.rules.moderation.inspect;
  const fn = typeof viaCtx === "function" ? viaCtx : require("../rules/moderation").inspect; // 装配缺失时兜底（同为名下模块）
  return fn(shot, ctx || {});
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const shotId = p.shotId || p.shot || null;
  const st = (ctx && ctx.store && typeof ctx.store.get === "function" && ctx.store.get()) || {};
  const shot = shotId != null ? (st.shots || {})[shotId] : null;
  if (!shot) {
    const err = new Error("机审对象不存在: shotId=" + shotId);
    err.code = "NOT_FOUND";
    throw err;
  }

  // 全局镜序（V6 演示路径「第 7 镜必送复审」按集内排序，而非 seq 数值）
  const epShots = Object.values(st.shots || {})
    .filter((x) => x && x.episodeId === shot.episodeId)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const rank = epShots.findIndex((x) => x.id === shot.id) + 1;
  const res = inspectViaRules(Object.assign({}, shot, { global_rank: rank }), ctx);
  const verdict = res.pass ? "pass" : "fail_review";
  const bag = {
    ok: true,
    cents: COST_CENTS,
    art: null,
    pass: !!res.pass,
    verdict,
    reason: res.reason || null,
    checks: res.checks || [],
    shotId: res.shotId != null ? res.shotId : shotId
  };
  j.result = bag; // 契约：inspect 结果回写 job
  j.art = bag;    // onModerateDone 读 job.art：pass→shot ok；fail→review_q＋C7
  return { ok: true, cents: COST_CENTS, art: null, meta: { shotId: bag.shotId, pass: bag.pass, verdict, reason: bag.reason, checks: bag.checks } };
}

module.exports = { name: NAME, lane: NAME, run };
