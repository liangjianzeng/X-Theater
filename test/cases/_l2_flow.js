'use strict';
/**
 * V9 L2 双模式共用流程（下划线开头 = run.js 不作为用例加载）。
 * 5 类真实任务（查询/重拍/择优/成本/进度，对应契约 §5 工具白名单）
 * + approval 必答门（reroll 昂贵动作）+ 红队三案。
 */
const lib = require('../lib');
const H = require('./_helpers');
const { expect, pollUntil } = lib;

async function runL2Full(ctx, mode) {
  const label = `mode=${mode}`;
  const { token } = await ctx.ensureUser();

  // 参考素材：种子集 e1 的镜头/场次（供 择优/重拍 消息引用）
  const st = await H.getState(ctx);
  const shots = H.shotsOfEpisode(st, H.SEED_EPISODE_ID);
  expect.gte(shots.length, 2, `种子集 ${H.SEED_EPISODE_ID} 应至少 2 镜，实际 ${shots.length}`);
  const pickShot = shots[0];
  const rerollShot = shots[1];
  const scene = H.scenesOfEpisode(st, H.SEED_EPISODE_ID)[0];
  const sceneLabel = scene ? `「${scene.name || scene.id}」(scene ${scene.id})` : '第一场景';
  const epLabel = st.episodes && (H.asMap(st.episodes)[H.SEED_EPISODE_ID] || {}).title
    ? `《${(H.asMap(st.episodes)[H.SEED_EPISODE_ID] || {}).title}》` : `第 ${H.SEED_EPISODE_ID} 集`;

  // 建会话（mode 显式传入）
  const resp = await ctx.api('POST', '/api/l2/sessions', { mode }, token);
  expect.status(resp, [200, 201, 202], `POST /api/l2/sessions {mode:"${mode}"}`);
  const sid = lib.extractId(resp.body, ['sessionId', 'id']) || lib.extractId(resp.body && resp.body.session);
  expect.ok(sid, `${label}：会话 id 不可得 ${lib.trunc(resp.text)}`);
  const sess0 = resp.body && resp.body.session ? resp.body.session : resp.body;
  if (sess0 && sess0.mode) expect.eq(String(sess0.mode).toUpperCase(), mode, `${label}：session.mode 应为 ${mode}`);
  ctx.note(`${label} session=${sid}`);

  // 订阅 l2:<sid>（SSE ?session= 才订）
  const stream = await ctx.sse(`/api/events?session=${encodeURIComponent(sid)}`, token);

  // ---- 5 类查询消息（文本对齐契约工具白名单关键词）----
  const querySpecs = [
    { tool: 'query_progress', text: `${epLabel}现在拍摄进度怎么样了？已完成多少镜？` },
    { tool: 'query_cost', text: `这集目前一共花了多少钱？超预算了吗？` },
    { tool: 'set_mood', text: `把${sceneLabel}的情绪设为「离别」。` },
    { tool: 'pick_take', text: `第 ${rerollShot.seq ?? rerollShot.id} 镜（${rerollShot.name || rerollShot.id}）择优，锁定最佳版本。` },
    { tool: 'music_candidates', text: `给${sceneLabel}按「离别」情绪生成一批配乐候选。` },
  ];
  for (const q of querySpecs) {
    await H.runL2Message(ctx, sid, stream, q.text, q.tool, { allowApproval: true, timeoutMs: 25000 });
  }
  ctx.note(`${label}：5 类查询消息均路由到白名单工具`);

  // ---- approval 必答门：reroll 触发 approval_request → approve → job 出现 ----
  const jobsBefore = (await H.listJobs(ctx, { episodeId: H.SEED_EPISODE_ID })).length;
  await H.runL2Message(ctx, sid, stream,
    `重拍第 ${rerollShot.seq ?? rerollShot.id} 镜（${rerollShot.name || rerollShot.id}），这条不行。`,
    'reroll_shot', { allowApproval: true, timeoutMs: 30000 });
  const jobsAfter = await pollUntil(async () => {
    const jobs = await H.listJobs(ctx, { episodeId: H.SEED_EPISODE_ID });
    return jobs.length > jobsBefore ? jobs : null;
  }, { timeoutMs: 25000, label: `${label}：approve 后 reroll job 出现` });
  expect.gte(jobsAfter.length, jobsBefore + 1, `${label}：approve 后应出现新 job`);
  ctx.note(`${label}：reroll approval→job 通过（jobs ${jobsBefore}→${jobsAfter.length}）`);

  // ---- 白名单纪律：会话执行面不得出现白名单外工具 ----
  H.assertWhitelist(stream);

  // ---- 红队三案（双模式各跑，零越权）----
  const problems = await H.redTeam(ctx, mode);
  expect.eq(problems.length, 0, `${label} 红队三案违规：\n  ${lib.trunc(problems.join('\n  '), 1200)}`);
  ctx.note(`${label}：红队三案零越权`);
}

module.exports = { runL2Full };
