'use strict';
/**
 * V1 全链路自部署成片（可软件化部分）：
 * login(INV-DEMO-1) → POST /api/episodes → 逐卡 accept C1..C6（等待派生 jobs 轮询到 done）
 * → GET estimate → POST shoot → 轮询 16 镜全 ok + moderate 完成
 * → #7 进 review_q 由 ops pass（无 ops 则 SKIP 该段）→ C7 accept → C8 accept
 * → 决策计数断言 ≤5 → job 账本全部 worker_type=self-host-stub 且含 initiated_by。
 */
const lib = require('../lib');
const H = require('./_helpers');
const { expect, pollUntil, sleep } = lib;

async function fn(ctx) {
  // 登录（邀请码登录 + 用户角色可见）
  const { token, user } = await ctx.login(lib.INVITE);
  expect.ok(user && user.id, `login 未返回 user：${truncSafe(user)}`);
  ctx.note(`login user=${user.id}/${user.role}`);

  // 建集 → C1..C6 → estimate → shoot → 16 镜 job 终态
  const { epId, accepts, jobs } = await H.bootstrapEpisode(ctx, { cardsUpTo: 6 });
  expect.eq(accepts.length >= 6, true, `C1..C6 accept 数量不足：${accepts}`);

  // moderate job 出现过（七类引擎含 moderate，命名宽容）
  const moderates = jobs.filter((r) => /moderat|review|audit/i.test(String(r.type || '')));
  expect.ok(moderates.length > 0, `job 列表中未见 moderate 类 job（types=${[...new Set(jobs.map((r) => r.type))].join(',')}）`);

  // 16 镜状态（shots 可能随 job 收尾异步出现，轮询等齐）
  let shots = await lib.pollUntil(async () => {
    const sh = H.shotsOfEpisode(await H.getState(ctx), epId);
    return sh.length >= H.EXPECTED_SHOTS ? sh.slice(0, H.EXPECTED_SHOTS) : null;
  }, { timeoutMs: 25000, intervalMs: 700, label: `开机后生成 ${H.EXPECTED_SHOTS} 镜` });
  const okSet = lib.DONE_STATES;
  const isOk = (s) => okSet.has(String(s.status || '').toLowerCase());
  const shot7 = shots.find((s) => Number(s.seq) === 7) || shots[6];
  const shotsNow = async () => (await H.getState(ctx));
  // 产品既定路径：抽帧 hash 灰区（<0.08）会把随机镜也送复审——验收期由 ops 放行非 #7 项，
  // #7 项留给下方 V6 演示断言专用（ops 不可用时不代放，维持原 SKIP 归因）。
  const opsTokenEarly = await ctx.ensureOpsToken();
  await pollUntil(async () => {
    const stNow = await shotsNow();
    const sh = H.shotsOfEpisode(stNow, epId).slice(0, H.EXPECTED_SHOTS);
    if (opsTokenEarly) {
      const gray = H.reviewQueue(stNow).filter((r) =>
        String(r.status || 'pending') === 'pending' && r.shotId !== shot7.id);
      for (const it of gray) {
        await ctx.api('POST', '/api/review/' + encodeURIComponent(it.id) + '/decide',
          { action: 'pass', reason: 'V1 验收：ops 放行灰区抽帧复审（非 #7）', ver: it.ver ?? 1 }, opsTokenEarly);
      }
    }
    return sh.filter((s) => s.id !== shot7.id && isOk(s)).length >= H.EXPECTED_SHOTS - 1 ? true : null;
  }, { timeoutMs: 30000, intervalMs: 800, label: `15 镜（除 #7）全部 ok` });

  // #7 → review_q
  const entry = await pollUntil(async () => {
    const st = await H.getState(ctx);
    const rq = H.reviewQueue(st);
    return rq.find((r) => r.shotId === shot7.id && String(r.status || 'pending') === 'pending') || null;
  }, { timeoutMs: 25000, intervalMs: 700, label: '#7 进入 review_q(pending)' });
  expect.ok(entry, `shot #7(${shot7.id}) 应因尾号 7 送复审但 review_q 无该条`);

  // ops 处置 #7（拿不到 ops → SKIP 该段 + C7/C8 依赖段）
  const opsToken = await ctx.ensureOpsToken();
  let opsPassed = false;
  if (!opsToken) {
    ctx.skip('无 ops 账号（邀请码种子 role 非 ops）：#7 复审 pass 与 C7/C8 链式依赖跳过');
  } else {
    // 复审项 ver 缺省时服务端归一为 1（cas 基准 =1）
    const dec = await ctx.api('POST', `/api/review/${encodeURIComponent(entry.id)}/decide`,
      { action: 'pass', reason: 'V1 验收自动 pass', ver: entry.ver ?? 1 }, opsToken);
    if (dec.status === 409) {
      const st2 = await H.getState(ctx);
      const rq2 = Array.isArray(st2.review_q) ? st2.review_q : Object.values(H.asMap(st2.review_q));
      const fresh = rq2.find((r) => r.id === entry.id);
      const dec2 = await ctx.api('POST', `/api/review/${encodeURIComponent(entry.id)}/decide`,
        { action: 'pass', reason: 'V1 验收自动 pass', ver: (fresh && fresh.ver) ?? 1 }, opsToken);
      expect.status(dec2, [200, 201, 202, 204], 'POST /api/review/:id/decide pass（重试）');
    } else {
      expect.status(dec, [200, 201, 202, 204], 'POST /api/review/:id/decide pass');
    }
    opsPassed = true;
    await pollUntil(async () => {
      const sh = H.shotsOfEpisode(await shotsNow(), epId).slice(0, H.EXPECTED_SHOTS);
      const s = sh.find((x) => x.id === shot7.id);
      return s && isOk(s) ? s : null;
    }, { timeoutMs: 20000, intervalMs: 700, label: 'ops pass 后 #7 变 ok' });
  }

  // 全 16 镜 ok（ops 可用时硬断言；否则上面已 SKIP）
  if (opsPassed) {
    const sh = H.shotsOfEpisode(await shotsNow(), epId).slice(0, H.EXPECTED_SHOTS);
    const okCount = sh.filter(isOk).length;
    expect.eq(okCount, H.EXPECTED_SHOTS, `ops pass 后应 ${H.EXPECTED_SHOTS} 镜全 ok，实际 ${okCount}`);
  }

  // C7 / C8 accept（无 ops 时 #7 卡链可能不推进 → 失败即 SKIP 归因）
  if (opsToken) {
    await H.acceptCardChain(ctx, epId, 7, 8, { perCardTimeoutMs: 45000 });
  } else {
    try { await H.acceptCardChain(ctx, epId, 7, 8, { perCardTimeoutMs: 20000 }); }
    catch { ctx.skip('C7/C8 等待超时（已标记：无 ops 账号依赖）'); }
  }

  // 决策计数 ≤5（V1 判据：人工决策点 ≤5；C9 配乐卡不计）
  const st3 = await H.getState(ctx);
  const eps = H.asMap(st3.episodes);
  const ep = eps[epId] || Object.values(eps).find((e) => e.id === epId);
  expect.ok(ep, `state 中找不到 episode ${epId}`);
  const decisions = Number(ep.decisions ?? 0);
  ctx.note(`decisions=${decisions}`);
  expect.lte(decisions, 5, `V1 判据：人工决策点（episode.decisions）应 ≤5`);

  // job 账本：本集相关行 worker_type 全部 self-host-stub；含 initiated_by
  const { rows, file, tried } = ctx.ledger('job');
  expect.ok(rows, `job 账本不可读（尝试路径：${(tried || []).join(', ')}）`);
  const mine = rows.filter((r) => r.episodeId === epId || JSON.stringify(r).includes(epId));
  expect.gte(mine.length, H.EXPECTED_SHOTS, `本集 job 账本行数应 ≥${H.EXPECTED_SHOTS}，实际 ${mine.length}`);
  const badWorker = rows.filter((r) => String(r.worker_type || '') !== 'self-host-stub');
  expect.eq(badWorker.length, 0, `job 账本存在非 self-host-stub 行（V1 判据：零外部生成 API）：${lib.trunc(badWorker.slice(0, 3).map((r) => `${r.id}:${r.worker_type}`))}`);
  const noInit = rows.filter((r) => !['user', 'system'].includes(String(r.initiated_by || '')));
  expect.eq(noInit.length, 0, `job 账本缺 initiated_by：${lib.trunc(noInit.slice(0, 3).map((r) => r.id))}`);
  ctx.note(`ledger job rows=${rows.length} (本集 ${mine.length})`);
}

function truncSafe(x) { return lib.trunc(lib.j(x)); }

module.exports = { name: 'V1_full_chain', fn };
