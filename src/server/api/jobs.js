"use strict";
/**
 * api/jobs.js — 任务（契约 §3）
 * GET /api/jobs?episodeId=&status= · POST /api/jobs/:id/retry · POST /api/jobs/:id/stop
 * 队列来源优先 engine.queueState()，退化读 job 账本。
 */

function parseQuery(req) {
  const url = (req && req.url) || "";
  const i = url.indexOf("?");
  const out = {};
  if (i >= 0) {
    const sp = new URLSearchParams(url.slice(i + 1));
    sp.forEach((v, k) => {
      out[k] = v;
    });
  }
  return out;
}

function jobEpisodeId(job) {
  return (job.opts && job.opts.episodeId) || job.episodeId || (job.payload && job.payload.episodeId) || null;
}

function liveJobs(ctx) {
  // 活队列任务（含 payload/status）——拍摄墙的停/重拍按钮只认这些
  try {
    if (ctx.engine && typeof ctx.engine.listJobs === "function") {
      const arr = ctx.engine.listJobs(null);
      if (Array.isArray(arr)) return arr.slice();
    }
  } catch (e) { /* fallthrough */ }
  return [];
}

function listJobs(ctx) {
  // 合并视图：账本行（历史，按 job_id 去重）＋活队列行（权威，覆盖同 id）。
  // 2026-11-21 修复「任务僵死假象」：账本历史行打 live:false 标——引擎重启后内存清空，
  // 日志里的 running/queued 是残影，不再冒充当前状态（前端队列只认 live 行）。
  // 2026-11-21 队列可读化：活行内存里只有入队 at，没有状态变迁时间——把账本同 job_id
  // 最后一行的 ts（running 行＝开拍时刻）与 error 合进活行，前端「已等 X 分钟」才有真值。
  let ledger = [];
  try { ledger = ctx.store.readLog("job").slice(); } catch (e) { /* 账本不可读时仍返回活队列 */ }
  const lastRow = new Map();
  ledger.forEach(function (r) {
    if (r && r.job_id) lastRow.set(String(r.job_id), r);
  });
  const live = liveJobs(ctx).map(function (j) {
    const o = Object.assign({}, j, { live: true });
    const last = lastRow.get(String(j.id)) || {};
    if (o.ts == null) o.ts = last.ts != null ? last.ts : (j.at != null ? j.at : null);
    if (last.error && !o.error) o.error = last.error;
    o.shotId = (j.payload && j.payload.shotId) || null;
    o.sec = (j.payload && j.payload.sec) || null;
    return o;
  });
  const liveKeys = new Set(live.map(function (j) { return String(j.id); }));
  const rows = ledger.filter(function (r) {
    return !liveKeys.has(String(r.job_id || r.id));
  }).map(function (r) {
    return Object.assign({}, r, { live: false, id: r.job_id || r.id });
  });
  return rows.concat(live);
}

function register(router, ctx) {
  const { store, engine } = ctx;

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  function findLiveJob(id) {
    const jobs = liveJobs(ctx); // 只认真活队列：账本历史行的 retry 仍按契约 404
    for (let i = 0; i < jobs.length; i++) {
      if (jobs[i] && (jobs[i].id === id || String(jobs[i].id) === String(id))) return jobs[i];
    }
    return null;
  }

  // GET /api/jobs?episodeId=&status=
  router.add(
    "GET",
    "/api/jobs",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const q = parseQuery(req);
      let jobs = listJobs(ctx);
      if (q.episodeId) jobs = jobs.filter((j) => jobEpisodeId(j) === q.episodeId);
      if (q.status) jobs = jobs.filter((j) => j.status === q.status);
      return router.json(res, 200, { jobs, total: jobs.length });
    },
    { auth: true }
  );

  // POST /api/jobs/:id/retry
  router.add(
    "POST",
    "/api/jobs/:id/retry",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const live = findLiveJob(params.id);
      if (!live) throw { code: "NOT_FOUND", message: "任务不存在: " + params.id };
      const r = engine.retry(params.id);
      audit(auth, "job_retry", String(params.id), { type: live.type });
      return router.json(res, 200, { ok: true, job: r || live });
    },
    { auth: true }
  );

  // POST /api/jobs/:id/stop
  router.add(
    "POST",
    "/api/jobs/:id/stop",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const live = findLiveJob(params.id);
      if (!live) throw { code: "NOT_FOUND", message: "任务不存在: " + params.id };
      const r = engine.stop(params.id);
      audit(auth, "job_stop", String(params.id), { type: live.type });
      return router.json(res, 200, { ok: true, job: r || live });
    },
    { auth: true }
  );
}

module.exports.register = register;
module.exports.listJobs = listJobs;
