'use strict';
/**
 * V6 运营最小后台（可软件化部分）：
 *  - review 队列处置留痕：ops 处置一条复审项（种子 #7 演示项）→ var/log-audit.jsonl 出现留痕（operator/action）。
 *  - 告警演练：POST /api/admin/alerts/simulate ×3（心跳/积压/失败率）→ GET /api/state alerts 至少 3 条新告警。
 * 依赖 ops 角色（登录码同 invite，role 由服务端种子决定）；拿不到 ops → SKIP 并说明。
 */
const lib = require('../lib');
const H = require('./_helpers');
const { expect, pollUntil } = lib;

async function fn(ctx) {
  const opsToken = await ctx.ensureOpsToken();
  if (!opsToken) {
    ctx.skip('无 ops 账号（INV-DEMO-1 种子 role 非 ops 且服务端对 ops 面返 401/403）：复审处置留痕与告警演练跳过');
    return;
  }

  // ---- 复审队列处置留痕 ----
  const qResp = await ctx.api('GET', '/api/review/queue', null, opsToken);
  expect.status(qResp, 200, 'GET /api/review/queue (ops)');
  let queue = lib.pickList(qResp.body, ['queue', 'items', 'list', 'entries']) || [];
  let entry = queue.find((r) => String(r.status || 'pending').toLowerCase() === 'pending');

  if (!entry) {
    const st = await H.getState(ctx);
    const rq = H.reviewQueue(st);
    entry = rq.find((r) => String(r.status || 'pending').toLowerCase() === 'pending');
    queue = rq;
  }
  if (!entry) {
    ctx.skip('复审队列无 pending 项（种子附录 A 应预置 #7 演示项）：处置留痕跳过');
  } else {
    const auditBefore = (ctx.ledger('audit').rows || []).length;
    // 种子复审项可能缺 ver；服务端 decide 前会把非数字 ver 归一为 1（cas 基准 =1）
    let dec = await ctx.api('POST', `/api/review/${encodeURIComponent(entry.id)}/decide`,
      { action: 'pass', reason: 'V6 运营演练：机审误报人工放行', ver: entry.ver ?? 1 }, opsToken);
    if (dec.status === 409) {
      const q2 = await ctx.api('GET', '/api/review/queue', null, opsToken);
      const rq2 = lib.pickList(q2.body, ['queue', 'items', 'list', 'entries']) || [];
      const fresh = rq2.find((r) => r.id === entry.id);
      dec = await ctx.api('POST', `/api/review/${encodeURIComponent(entry.id)}/decide`,
        { action: 'pass', reason: 'V6 运营演练：机审误报人工放行', ver: (fresh && fresh.ver) ?? 1 }, opsToken);
    }
    expect.status(dec, [200, 201, 202, 204], `POST /api/review/${entry.id}/decide pass`);

    const row = await pollUntil(() => {
      const a = ctx.ledger('audit');
      const rows = a.rows || [];
      if (rows.length <= auditBefore) return null;
      const hit = rows.slice(auditBefore).find((r) => /review|复审|disposition|pass/i.test(`${r.action || ''} ${r.reason || ''}`));
      return hit || (rows.length > auditBefore ? rows[rows.length - 1] : null);
    }, { timeoutMs: 10000, intervalMs: 300, label: 'log-audit.jsonl 出现复审处置留痕' });
    expect.ok(row, '审计留痕为空');
    expect.ok(row.operator || row.operator_id || row.actor, `审计行缺 operator：${lib.trunc(lib.j(row))}`);
    expect.ok(row.action, `审计行缺 action：${lib.trunc(lib.j(row))}`);
  }

  // ---- 告警演练：三条（alerts 数组从 var/state.json 观察；/api/state 仅计数）----
  const alertsBefore = H.alertsOf(ctx).length;
  const kinds = ['worker_heartbeat', 'queue_backlog', 'failure_rate'];
  for (const kind of kinds) {
    const r = await ctx.api('POST', '/api/admin/alerts/simulate', { kind }, opsToken);
    expect.status(r, [200, 201, 202], `POST /api/admin/alerts/simulate kind=${kind}`);
  }
  const alerts = await pollUntil(() => {
    const a = H.alertsOf(ctx);
    return a.length >= alertsBefore + 3 ? a : null;
  }, { timeoutMs: 15000, intervalMs: 500, label: `alerts 至少新增 3 条（基线 ${alertsBefore}）` });
  const fresh = alerts.slice(alertsBefore);
  expect.gte(fresh.length, 3, 'simulate 后 alerts 应 ≥3 条');
  expect.ok(fresh.every((a) => a.id && a.kind != null && a.msg != null && a.ts != null),
    `新告警应含 {id,kind,msg,ts}：${lib.trunc(fresh.slice(0, 3).map((a) => lib.j(a)))}`);
  ctx.note(`alerts ${alertsBefore}→${alerts.length}`);
}

module.exports = { name: 'V6_review_audit_alerts', fn };
