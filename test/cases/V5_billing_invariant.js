'use strict';
/**
 * V5 成本透明与影子记账（账本不变量部分）：
 *  - Σbilling(episode) 与 episode.cost_cents 一致（读 var/log-billing.jsonl + state.json，另与 GET /api/state 交叉）。
 *  - job 账本 initiated_by 全量 ∈ {user,system}；system 发起（自动补拍）必带 free 字段。
 * 基于种子集 e1（不依赖前序用例写入），共享 var 场景亦可独立成立。
 */
const lib = require('../lib');
const H = require('./_helpers');
const { expect, sleep } = lib;

function episodeCost(state, epId) {
  const eps = H.asMap(state && state.episodes);
  const ep = eps[epId] || Object.values(eps).find((e) => e && e.id === epId);
  return ep ? Number(ep.cost_cents ?? 0) : null;
}

async function fn(ctx) {
  // 隔离 var 下先制造最小计费链（c1plan job → billing），避免空账本假阴性
  try {
    await H.bootstrapEpisode(ctx, { cardsUpTo: 1, brief: '影子记账最小链：一句话到策划案。' });
  } catch (e) {
    ctx.note(`bootstrap 降级：${lib.trunc(e.message, 80)}`);
  }
  await sleep(600); // 账本落盘窗口
  // ---- Σbilling(episode) == episode.cost_cents ----
  const sj = ctx.stateJson();
  expect.ok(sj, `var/state.json 不可读（var=${ctx.actualVarDir}）`);
  const { rows, file, tried } = ctx.ledger('billing');
  const billingRows = rows || [];
  if (!rows) {
    // 账本文件尚不存在：仅当所有集成本为 0（尚未产生任何计费链路）时空账本平凡成立
    const zeroAll = Object.values(H.asMap(sj.episodes)).every((e) => Number(e.cost_cents ?? 0) === 0);
    if (!zeroAll) expect.ok(rows, `billing 账本不可读但存在非零成本（尝试路径：${(tried || []).join(', ')}）`);
    else ctx.note('billing 账本文件不存在且全部集 cost_cents=0 → Σ=0 不变量空账本平凡成立');
  }

  const eps = Object.keys(H.asMap(sj.episodes));
  expect.gte(eps.length, 1, 'state.json 无 episodes');

  let checked = 0;
  for (const epId of eps) {
    const billings = billingRows.filter((r) => r.episodeId === epId);
    const sum = billings.reduce((a, r) => a + (Number(r.cents ?? r.amount_cents ?? 0) || 0), 0);
    const cost = episodeCost(sj, epId);
    expect.ok(cost != null, `episode ${epId} 无 cost_cents`);
    // 护栏触发（paused）时契约允许 system 补差，本套流程不触发护栏 → 严格相等
    const ep = H.asMap(sj.episodes)[epId];
    if (ep && ep.paused === true) {
      ctx.note(`episode ${epId} paused（护栏），Σbilling 允许补差，跳过严格相等`);
      continue;
    }
    expect.eq(sum, cost, `对账不变量：Σbilling(${epId})=${sum} ≠ cost_cents=${cost}（billing 行数 ${billings.length}，${file}）`);
    checked++;
  }
  expect.gte(checked, 1, '没有任何 episode 完成对账检查');
  ctx.note(`billing 对账通过 ${checked} 集（rows=${billingRows.length}）`);

  // 与 GET /api/state 交叉核对种子集（用户面成本可见）
  const st = await H.getState(ctx);
  const costViaApi = episodeCost(st, H.SEED_EPISODE_ID);
  const costViaFile = episodeCost(sj, H.SEED_EPISODE_ID);
  if (costViaApi != null && costViaFile != null) {
    expect.eq(costViaApi, costViaFile, `GET /api/state 与 state.json 的 e1.cost_cents 不一致`);
  }

  // ---- job 账本 initiated_by / free 补拍字段 ----
  const jobLedger = ctx.ledger('job');
  expect.ok(jobLedger.rows, `job 账本不可读（尝试路径：${(jobLedger.tried || []).join(', ')}）`);
  const jobs = jobLedger.rows;
  const badInit = jobs.filter((r) => !['user', 'system'].includes(String(r.initiated_by ?? '')));
  expect.eq(badInit.length, 0, `job 账本 initiated_by 非法/缺失：${lib.trunc(badInit.slice(0, 3).map((r) => `${r.id}:${r.initiated_by}`))}`);
  const sysRows = jobs.filter((r) => String(r.initiated_by) === 'system');
  const sysNoFree = sysRows.filter((r) => r.free !== true);
  expect.eq(sysNoFree.length, 0, `system 发起（自动补拍）的 job 应带 free:true：${lib.trunc(sysNoFree.slice(0, 3).map((r) => `${r.id}:${r.type}`))}`);
  ctx.note(`job 账本：user=${jobs.length - sysRows.length} system(free)=${sysRows.length}`);
}

module.exports = { name: 'V5_billing_invariant', fn };
