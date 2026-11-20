'use strict';
/**
 * V4-lite（双端浏览器冒烟属硬件/Playwright 项，不在本套件）：
 *  - GET /（静态兜底）返回 client 的 index.html。
 *  - SSE：流式读 GET /api/events → 走一次 publish 路径（建集后对首个 job POST retry）收到 jobs 事件。
 */
const lib = require('../lib');
const H = require('./_helpers');
const { expect } = lib;

const isJobsEvent = (e) => {
  const t = String(e.topic || '').toLowerCase();
  if (/job/.test(t)) return true;
  const d = e.data;
  if (d && typeof d === 'object' && (d.jobId || d.job_id || /job/i.test(String(d.topic || d.type || '')))) return true;
  return false;
};

async function fn(ctx) {
  // ---- 静态首页 ----
  const home = await ctx.api('GET', '/', null, null, { timeoutMs: 10000 });
  expect.status(home, 200, 'GET / （client index.html）');
  const ct = String(home.headers['content-type'] || '').toLowerCase();
  expect.ok(ct.includes('text/html') || /<html/i.test(home.text || ''),
    `GET / 应返回 HTML（content-type=${ct} body头=${lib.trunc((home.text || '').slice(0, 120))}）`);
  expect.match(home.text || '', /<html/i, '首页应含 <html');

  // ---- SSE + jobs publish ----
  const { token } = await ctx.ensureUser();
  const stream = await ctx.sse('/api/events', token);
  // 通道存活软检（:ping 心跳 15s 一发；不作为硬断言，硬断言 = retry 后 jobs 事件）
  try {
    await stream.waitFor(() => stream.events.length > 0, { timeoutMs: 20000, label: 'SSE 首帧（数据帧或 :ping）' });
  } catch (e) {
    ctx.note(`SSE 20s 内无任何帧（${lib.trunc(e.message, 80)}），继续等 publish 事件`);
  }

  // 建集触发 job 入队（bus.publish jobs）
  const mark0 = stream.events.length;
  const epResp = await ctx.api('POST', '/api/episodes', {
    projectId: 'p1', title: `V4冒烟集-${Date.now()}`, brief: '塔台夜灯。', kind: 'one_liner',
  }, token);
  expect.status(epResp, [200, 201, 202], 'POST /api/episodes（SSE 触发源）');
  const evCreate = await stream
    .waitFor((e) => isJobsEvent(e) && stream.events.indexOf(e) >= mark0, { timeoutMs: 12000, label: '建集 enqueue 的 jobs 事件' })
    .catch(() => null);

  const jobs = await pollUntilJobs(ctx);
  expect.gte(jobs.length, 1, '建集后应至少 1 个 job（c1plan）');
  // GET /api/jobs 返回账本追加行时，重试要用真实 job_id（非账本行 id）
  const jobId = jobs[0]._job_id || jobs[0].job_id || jobs[0].id;
  expect.ok(jobId, `job 缺 id：${lib.trunc(jobs[0])}`);

  // 主触发：retry 一次 job → 应收到 jobs 事件（publish 路径）
  const mark1 = stream.events.length;
  const retry = await ctx.api('POST', `/api/jobs/${encodeURIComponent(jobId)}/retry`, {}, token);
  if (retry.status === 404) {
    // 引擎可能不把已终态 job 留在 live 队列（契约 engine.retry 语义待 worker 落地）；退化用入队事件
    ctx.note(`retry(${jobId}) 404（非 live 队列任务）；以入队 publish 事件代证`);
    expect.ok(evCreate, 'retry 404 且建集阶段也未收到任何 jobs 事件 → SSE publish 路径不通');
  } else {
    expect.status(retry, [200, 201, 202, 204], `POST /api/jobs/${jobId}/retry`);
    await stream.waitFor((e) => isJobsEvent(e) && stream.events.indexOf(e) >= mark1,
      { timeoutMs: 15000, label: 'retry 后收到 jobs 主题 SSE 事件' });
  }
  ctx.note(`SSE jobs 事件 OK（retry=${retry.status}）`);

  // stop 面顺手可用性（不断言结果态）
  await ctx.api('POST', `/api/jobs/${encodeURIComponent(jobId)}/stop`, {}, token);
}

async function pollUntilJobs(ctx) {
  return lib.pollUntil(async () => {
    const st = await H.getState(ctx);
    const eps = H.asMap(st.episodes);
    const epId = Object.keys(eps).find((k) => String(eps[k].title || '').startsWith('V4冒烟集'));
    if (!epId) return null;
    const jobs = await H.listJobs(ctx, { episodeId: epId });
    return jobs.length >= 1 ? jobs : null;
  }, { timeoutMs: 25000, label: 'V4 冒烟集出现 job' });
}

module.exports = { name: 'V4_lite_static_sse', fn };
