"use strict";
/**
 * dag/engine.js — 队列/DAG 推进/预算护栏/自动补拍（契约 §2/§4）
 * - createEngine({store,bus,cfg})；cfg.workersDir 可覆盖 worker 目录（默认 ./workers，自测注入桩）
 * - worker 模块形状 {name, lane, run(job, ctx)}，ctx={store,bus,engine,rules,util,cfg}（rules 由 index 注入 engine.rules）
 * - enqueue(type,payload,opts)：lane 内串行（每 lane 并发 1）、lane 间并行；入队即写 job 账本
 * - 失败梯子：worker.run throw → 自动补拍（initiated_by:"system",free:true）≤2 次（含首发共跑 3 次）→ failed＋告警
 * - 预算护栏：episode 累计成本 > budget*1.2 → paused=true＋暂停该集调度＋告警；paused 时该集新 enqueue 拒绝 {code:"BUDGET"}
 * - retry(jobId)（attempts 重置重新入队，账本 initiated_by:"user"）· stop(jobId)（queued→cancelled）· queueState()
 * 确定性：引擎自身不含随机；伪随机一律由 worker 经 util.hash12 派生。
 */

const fs = require("fs");
const path = require("path");
const util = require("../core/util");

const ALL_LANES = ["img5060", "imgspark", "vid5060", "vidspark", "music", "tts", "compose", "moderate"];
const TYPE_LANE = {
  c1plan: "img5060",
  casting: "img5060",
  storyboard: "img5060",
  img_spark: "imgspark",
  music: "music",
  voice: "tts",
  compose: "compose",
  moderate: "moderate"
};

function laneFor(type, opts) {
  if (type === "video") return opts && opts.tier === "high" ? "vidspark" : "vid5060";
  const l = TYPE_LANE[type];
  if (!l) {
    const err = { code: "BAD_TYPE", message: "未知任务类型: " + type };
    throw err;
  }
  return l;
}

function createEngine({ store, bus, cfg }) {
  cfg = cfg || {};
  const workersDir = cfg.workersDir || path.join(__dirname, "workers");

  /* ---------- worker 装载 ---------- */
  const workersByLane = {};
  if (fs.existsSync(workersDir)) {
    for (const f of fs.readdirSync(workersDir).filter((x) => /\.js$/.test(x)).sort()) {
      try {
        const w = require(path.join(workersDir, f));
        if (w && typeof w.run === "function" && w.lane) {
          (workersByLane[w.lane] = workersByLane[w.lane] || []).push(w);
        } else {
          console.warn("[engine] worker 形状不合规（需 {name,lane,run}）:", f);
        }
      } catch (e) {
        console.error("[engine] worker 加载失败:", f, e.message);
      }
    }
  }

  /* ---------- 队列状态 ---------- */
  const jobs = new Map(); // jobId → job
  const lanes = {};
  ALL_LANES.forEach((l) => (lanes[l] = { queue: [], busy: false }));
  let scheduled = false;

  function laneOf(name) {
    if (!lanes[name]) lanes[name] = { queue: [], busy: false }; // 桩 worker 自定义 lane 兜底
    return lanes[name];
  }

  function epOf(id) {
    return id ? store.get().episodes[id] || null : null;
  }
  function isPausedEpisode(job) {
    const ep = epOf(job.episodeId);
    return !!(ep && ep.paused);
  }

  /* ---------- 账本与事件 ---------- */
  function logJob(job, status, extra) {
    return store.log(
      "job",
      Object.assign(
        {
          job_id: job.id,
          worker_type: "self-host-stub", // V1：链路零外部生成 API，账本可证
          type: job.type,
          lane: job.lane,
          status,
          episodeId: job.episodeId,
          initiated_by: job.initiated_by,
          free: !!job.free,
          attempts: job.attempts
        },
        extra || {}
      )
    );
  }

  function jobEvent(job, status, extra) {
    return Object.assign(
      {
        job_id: job.id,
        type: job.type,
        lane: job.lane,
        status,
        event: status, // 订阅方（cards 卡流状态机）按 event 分发
        episodeId: job.episodeId,
        attempts: job.attempts,
        // 完整 job 快照：卡流需要 payload（shotId/sceneId/mood）驱动派生
        job: {
          id: job.id,
          type: job.type,
          lane: job.lane,
          status,
          episodeId: job.episodeId,
          payload: job.payload || {},
          initiated_by: job.initiated_by,
          free: !!job.free,
          attempts: job.attempts,
          // 卡流消费 worker 回写面（job.art / job.result）：机审 verdict、video take、music 候选都在里面
          art: job.art || null,
          result: job.result || null
        }
      },
      extra || {}
    );
  }

  function pushAlert(kind, msg) {
    const st = store.get();
    const a = { id: util.uid("al"), kind, msg, ts: util.now(), acked: false };
    st.alerts.unshift(a);
    if (st.alerts.length > 200) st.alerts.length = 200;
    store.commit();
    return a;
  }

  /* ---------- 预算护栏 ---------- */
  function guardrail(ep) {
    if (!ep || !(ep.budget_cents > 0)) return;
    if (ep.cost_cents > ep.budget_cents * 1.2 && !ep.paused) {
      ep.paused = true;
      store.commit();
      const a = pushAlert(
        "budget",
        "《" + (ep.title || ep.id) + "》累计成本 " + ep.cost_cents + " 分已超预算 " + ep.budget_cents + " 分的 120%，拍摄已暂停"
      );
      bus.publish("alerts", a);
    }
  }

  /* ---------- 调度 ---------- */
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      drain();
    });
  }

  function drain() {
    for (const laneName of Object.keys(lanes)) {
      const L = lanes[laneName];
      if (L.busy) continue;
      // 暂停集的任务留在队列中（护栏触发→该集 queued job 暂停调度）
      const idx = L.queue.findIndex((id) => {
        const j = jobs.get(id);
        return j && !isPausedEpisode(j);
      });
      if (idx < 0) continue;
      const [id] = L.queue.splice(idx, 1);
      const job = jobs.get(id);
      if (!job) continue;
      L.busy = true;
      Promise.resolve()
        .then(() => runJob(job))
        .catch((err) => {
          // runJob 内部已兜异常；走到这里＝引擎自身出错
          job.status = "failed";
          logJob(job, "failed", { error: String((err && err.message) || err) });
          pushAlert("engine", "引擎内部错误（" + job.id + "）: " + String((err && err.message) || err));
          bus.publish("alerts", { job_id: job.id, kind: "engine" });
        })
        .finally(() => {
          L.busy = false;
          schedule();
        });
    }
  }

  function failJob(job, errMsg) {
    job.attempts += 1;
    if (job.attempts < 3) {
      // 自动补拍梯子（≤2 次；系统发起不计费，契约 §2/A7）
      job.status = "queued";
      job.initiated_by = "system";
      job.free = true;
      logJob(job, "retry", { error: String(errMsg).slice(0, 200) });
      laneOf(job.lane).queue.push(job.id);
      bus.publish("jobs", jobEvent(job, "retry"));
    } else {
      job.status = "failed";
      logJob(job, "failed", { error: String(errMsg).slice(0, 200) });
      const a = pushAlert("job_failed", "任务失败：" + job.id + "（" + job.type + "）" + String(errMsg).slice(0, 160));
      bus.publish("alerts", a);
      bus.publish("jobs", jobEvent(job, "failed"));
    }
  }

  async function runJob(job) {
    const ws = workersByLane[job.lane] || [];
    const w = ws[0];
    if (!w) {
      // 该 lane 无 worker：直接判失败（不烧补拍梯子）
      job.status = "failed";
      logJob(job, "failed", { error: "lane 无可用 worker: " + job.lane });
      const a = pushAlert("job_failed", "引擎未注册（lane=" + job.lane + "），任务 " + job.id + " 失败");
      bus.publish("alerts", a);
      bus.publish("jobs", jobEvent(job, "failed"));
      return;
    }
    job.status = "running";
    logJob(job, "running");
    bus.publish("jobs", jobEvent(job, "running"));

    const ctx = { store, bus, engine, rules: engine.rules || {}, util, cfg };
    let result = null;
    try {
      result = await w.run(job, ctx);
    } catch (err) {
      failJob(job, (err && err.message) || String(err));
      return;
    }

    job.status = "done";
    const cents =
      result && typeof result.cents === "number"
        ? result.cents
        : result && typeof result.cost_cents === "number"
          ? result.cost_cents
          : 0;
    logJob(job, "done", { cost_cents: cents });

    if (cents > 0 && !job.free) {
      // 影子记账（对账不变量：Σbilling(episode)==episode.cost_cents；free 任务不记不计）
      store.log("billing", {
        episodeId: job.episodeId,
        shotId: (job.payload && job.payload.shotId) || null,
        kind: job.type,
        cents
      });
      const ep = epOf(job.episodeId);
      if (ep) {
        ep.cost_cents = (ep.cost_cents || 0) + cents;
        store.commit();
        guardrail(ep);
      } else {
        store.commit();
      }
    }
    bus.publish("jobs", jobEvent(job, "done", { cost_cents: cents }));
  }

  /* ---------- 对外 API ---------- */
  const engine = {
    rules: {}, // index.js 装配时注入 {langlint,quant,license,moderation,budget}

    enqueue(type, payload, opts) {
      opts = opts || {};
      const lane = laneFor(type, opts);
      const ep = epOf(opts.episodeId);
      if (ep && ep.paused) {
        const err = { code: "BUDGET", message: "预算护栏已触发，该集任务暂停（需运营处理）" };
        throw err;
      }
      const job = {
        id: util.uid("job"),
        type,
        lane,
        status: "queued",
        episodeId: opts.episodeId || null,
        payload: payload || {},
        initiated_by: opts.initiated_by || "user",
        free: !!opts.free,
        attempts: 0,
        at: util.now()
      };
      jobs.set(job.id, job);
      logJob(job, "queued");
      laneOf(lane).queue.push(job.id);
      schedule();
      bus.publish("jobs", jobEvent(job, "queued"));
      return job;
    },

    retry(jobId) {
      const job = jobs.get(jobId);
      if (!job) {
        const err = { code: "NOT_FOUND", message: "任务不存在: " + jobId };
        throw err;
      }
      const ep = epOf(job.episodeId);
      if (ep && ep.paused) {
        const err = { code: "BUDGET", message: "预算护栏已触发，该集任务暂停" };
        throw err;
      }
      const L = laneOf(job.lane);
      const i = L.queue.indexOf(job.id);
      if (i >= 0) L.queue.splice(i, 1);
      if (job.status === "running") {
        const err = { code: "CONFLICT", message: "任务执行中，无法重排" };
        throw err;
      }
      job.attempts = 0;
      job.status = "queued";
      job.initiated_by = "user"; // 用户主动重试（计费；仅系统补拍 free）
      job.free = false;
      logJob(job, "retry", { manual: true });
      L.queue.push(job.id);
      schedule();
      bus.publish("jobs", jobEvent(job, "queued", { manual: true }));
      return job;
    },

    stop(jobId) {
      const job = jobs.get(jobId);
      if (!job) {
        const err = { code: "NOT_FOUND", message: "任务不存在: " + jobId };
        throw err;
      }
      if (job.status !== "queued") {
        const err = { code: "CONFLICT", message: "仅排队中的任务可停止（当前 " + job.status + "）" };
        throw err;
      }
      const L = laneOf(job.lane);
      const i = L.queue.indexOf(job.id);
      if (i >= 0) L.queue.splice(i, 1);
      job.status = "cancelled";
      logJob(job, "cancelled");
      bus.publish("jobs", jobEvent(job, "cancelled"));
      return job;
    },

    queueState() {
      const out = {};
      for (const l of Object.keys(lanes)) {
        out[l] = { queued: lanes[l].queue.length, running: lanes[l].busy ? 1 : 0 };
      }
      return out;
    },

    getJob(jobId) {
      return jobs.get(jobId) || null;
    },

    listJobs(filter) {
      let arr = Array.from(jobs.values());
      if (filter) {
        if (filter.episodeId) arr = arr.filter((j) => j.episodeId === filter.episodeId);
        if (filter.status) arr = arr.filter((j) => j.status === filter.status);
      }
      return arr;
    }
  };

  return engine;
}

module.exports = { createEngine };
