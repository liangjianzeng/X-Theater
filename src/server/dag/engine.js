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
const { DEFAULT_LANE_NODE } = require("../core/store");
const llmMod = require("../llm/llm");
// 本机 Comfy lane（img5060 全部任务＋video）：显存与 llm-gw 互斥（img_free=素材中心自由生图，施工 B1）
const LOCAL_GPU_TYPES = ["c1plan", "casting", "storyboard", "storyboard_char", "video", "img_free"];
function llmBlocked(cfg) {
  try { return !!(llmMod && llmMod.blockedByLocalLLM && cfg && llmMod.blockedByLocalLLM(cfg)); } catch (e2) { return false; }
}

const ALL_LANES = ["img5060", "imgspark", "vid5060", "vidspark", "music", "tts", "compose", "moderate", "aireview", "scriptgen"];
const TYPE_LANE = {
  // 一句话/小说→结构化剧本（2026-11-21 补全）：纯 LLM 车道，不占显存、不受 GPU/LLM 互斥闸
  scriptgen: "scriptgen",
  c1plan: "img5060",
  casting: "img5060",
  storyboard_char: "img5060",
  storyboard: "img5060",
  // 素材中心自由生图（2026-11-22 施工 B1）：默认落本机 t2i/i2i 车道；episode.driver 指到别的节点时
  // 仍按节点路由改道（在 DRIVER_ROUTABLE 白名单内），"固定"只对"无跨节点意图"成立
  img_free: "img5060",
  img_spark: "imgspark",
  // H3 线（试妆试镜流程 2026-11-21）：初始定妆图生成与试妆试镜视频固定走 imgspark
  //（引擎专用工作流，不在 driver 改道白名单——它们点名要 H3 引擎，不随剧集节点漂移）
  cast_init: "imgspark",
  screen_test: "imgspark",
  // 卡流节点审查（2026-11-21）：拍板点自动多人格机检；真 LLM 到位后换 lane 承载，人格骨架不变
  aireview: "aireview",
  music: "music",
  voice: "tts",
  compose: "compose",
  moderate: "moderate"
};

// 剧集驱动（episode.driver）可改道的任务类型白名单：这些是"通用工作流"，落到哪个节点由
// driver 指向的算力节点决定（按注册表 lane→node 绑定找同族车道）。引擎专用工作流
//（img_spark/cast_init/screen_test）不在内。白名单制：新增类型默认不改道，要跨节点需显式加入。
const DRIVER_ROUTABLE = ["c1plan", "casting", "storyboard", "storyboard_char", "img_free", "video"];

function laneFor(type, opts) {
  if (type === "video") return opts && opts.tier === "high" ? "vidspark" : "vid5060";
  // H3 线（2026-11-21）：Spark 通道启用（tier:"high"）→ 生图全族走 imgspark，5060 不再接 H3 任务
  if (opts && opts.tier === "high" && ["casting", "storyboard_char", "c1plan", "storyboard"].indexOf(type) >= 0) return "imgspark";
  const l = TYPE_LANE[type];
  if (!l) {
    const err = { code: "BAD_TYPE", message: "未知任务类型: " + type };
    throw err;
  }
  return l;
}

/* ---------- 车道→节点解析（注册表 lane→node 是唯一事实源，存内建回退表兜底） ---------- */
// 车道族：img*/vid* 前缀（img5060/imgspark 同族可互换节点；命名约定，新车道遵守即入族）
function familyOf(lane) {
  const l = String(lane || "");
  if (l.indexOf("img") === 0) return "img";
  if (l.indexOf("vid") === 0) return "video";
  return null;
}

function createEngine({ store, bus, cfg }) {
  cfg = cfg || {};
  const workersDir = cfg.workersDir || path.join(__dirname, "workers");
  const llmApi = llmMod.create(cfg); // worker ctx.llm（aireview LLM 叠加等用；未配置时 enabled()=false）

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

  /* ---------- 车道→节点绑定（注册表唯一事实源；存量库回退内建表） ---------- */
  function registryEntries() {
    const st = store.get();
    const reg = (st.settings && st.settings.registry) || {};
    return Object.keys(reg).map((k) => reg[k]);
  }

  /** lane 当前绑定到哪个节点（取登记序第一条绑定；无绑定时回退内建表） */
  function laneBoundNode(lane) {
    const hit = registryEntries().find((e) => e && e.lane === lane && e.node);
    if (hit) return hit.node;
    return DEFAULT_LANE_NODE[lane] || null;
  }

  /** 同族（img/video）车道里绑定到指定节点的第一条；同族引擎全无绑定时回退内建表 */
  function laneBoundTo(family, nodeId) {
    if (!family || !nodeId) return null;
    const entries = registryEntries();
    let anyBound = false;
    for (const e of entries) {
      if (e && familyOf(e.lane || "") === family) {
        if (e.node) {
          anyBound = true;
          if (e.node === nodeId) return e.lane;
        }
      }
    }
    if (!anyBound) {
      for (const l of Object.keys(DEFAULT_LANE_NODE)) {
        if (familyOf(l) === family && DEFAULT_LANE_NODE[l] === nodeId) return l;
      }
    }
    return null;
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
          tid: job.tid || null, // 域维度（S3-6）：按域聚合计费/审计
          initiated_by: job.initiated_by,
          free: !!job.free,
          attempts: job.attempts,
          // 可读化（2026-11-21）：账本行带镜号与时长——拍摄页队列/时间线能显示「镜 N」与进度
          shotId: (job.payload && job.payload.shotId) || null,
          sec: (job.payload && job.payload.sec) || null,
          // 幂等防重（2026-11-21）：账本行带 payload 关键标识（role），重启后 enqueueOnce 靠账本兜底防重派
          role: (job.payload && job.payload.role) || null
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
        tid: job.tid || null, // 域维度（S3-6）：SSE 订阅端按此过滤
        attempts: job.attempts,
        // 完整 job 快照：卡流需要 payload（shotId/sceneId/mood）驱动派生
        job: {
          id: job.id,
          type: job.type,
          lane: job.lane,
          status,
          episodeId: job.episodeId,
          tid: job.tid || null,
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

  /* ---------- 域级预算护栏（P2） ---------- */
  // 复用集级 120% 语义：域累计（Σ本域 episode.cost_cents）> 域预算×1.2 → 暂停本域全部进行中集＋告警。
  // 恢复：运营调高预算或手动恢复集（用户裁量），护栏不自动解除。
  function tenantGuardrail(st, tid) {
    const t = (st.tenants || {})[tid];
    if (!t || !(t.budget_cents > 0)) return;
    const sum = Object.keys(st.episodes || {})
      .map((k) => st.episodes[k])
      .filter((e) => (e.tenantId || "tid_default") === tid)
      .reduce((a, e) => a + (e.cost_cents || 0), 0);
    if (sum > t.budget_cents * 1.2) {
      let n = 0;
      Object.keys(st.episodes || {}).forEach((k) => {
        const e = st.episodes[k];
        if ((e.tenantId || "tid_default") === tid && !e.paused && (e.stage || 1) < 8) {
          e.paused = true;
          n++;
        }
      });
      if (n) {
        store.commit();
        const a = pushAlert(
          "budget",
          "域「" + (t.name || tid) + "」累计成本 " + sum + " 分已超域预算 " + t.budget_cents + " 分的 120%，已暂停 " + n + " 个进行中的集（调高预算或手动恢复）"
        );
        bus.publish("alerts", a);
      }
    }
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

    const ctx = { store, bus, engine, rules: engine.rules || {}, util, cfg, llm: llmApi };
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
        tid: job.tid || null, // 域维度（P2）：按域聚合计费
        shotId: (job.payload && job.payload.shotId) || null,
        kind: job.type,
        cents
      });
      const ep = epOf(job.episodeId);
      if (ep) {
        ep.cost_cents = (ep.cost_cents || 0) + cents;
        store.commit();
        guardrail(ep);
        // 域级护栏（P2）：本域预算超限 → 暂停全域进行中的集
        if (ep.tenantId) tenantGuardrail(store.get(), ep.tenantId);
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
      const st = store.get();
      // 剧集驱动节点路由（2026-11-22 数据驱动化）：episode.driver＝算力节点 id（state.nodes），
      // img/video 改道目标＝该节点绑定的同族车道（注册表 lane→node）——加节点/改绑定/删节点不再改代码。
      // driver 指向已不存在的节点（如节点被删后遗留）→ 回退首个登记节点（不写死 local，离开 5060 Ti 也能活）。
      const epForDriver = epOf(opts.episodeId) || (payload && payload.episodeId ? epOf(payload.episodeId) : null);
      const driver = epForDriver && (st.nodes || {})[epForDriver.driver]
        ? epForDriver.driver
        : Object.keys(st.nodes || {})[0] || "local";
      let lane = laneFor(type, opts);
      if (DRIVER_ROUTABLE.indexOf(type) >= 0) {
        const target = laneBoundTo(familyOf(lane), driver);
        if (target) {
          lane = target;
        } else if (laneBoundNode(lane) !== driver) {
          throw {
            code: "NODE_NO_LANE",
            message: "节点「" + driver + "」未绑定该类引擎车道——去运维台「引擎段位」给该节点登记或改绑一个同族引擎，或把本集驱动切回有引擎的节点"
          };
        }
      }
      // 显存互斥硬闸（2026-11-21 引入；2026-11-22 数据驱动化）：车道归属节点开启 gpu_gate
      // 且 LLM 正承载在同一节点 → 拒绝入队（16G 单卡装不下双家；DGX 等大卡节点 gpu_gate=false 不受闸）。
      const laneNode = laneBoundNode(lane);
      if (
        laneNode &&
        st.llm_node === laneNode &&
        ((st.nodes || {})[laneNode] || {}).gpu_gate &&
        LOCAL_GPU_TYPES.indexOf(type) >= 0 &&
        llmBlocked(cfg)
      ) {
        throw { code: "GPU_BUSY", message: "本机 LLM 正占用独显（约 14.4GB），本机生图/拍摄装不下——请在左下角 GPU 徽章「让路」停掉 LLM 后重试，或去运维台把本集驱动切到别的节点。" };
      }
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
        // 域归属（S3-6）：经 episode 反查（账本/事件/SSE 域过滤的租户维度；episodeId 是全任务公共键）
        tid: (epOf(opts.episodeId || (payload && payload.episodeId) || null) || {}).tenantId || null,
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

    // 已知车道名清单（ALL_LANES ∪ 已装载 worker 车道 ∪ 已用过车道）：引擎登记/改绑的合法 lane 枚举源
    laneNames() {
      return Array.from(new Set(ALL_LANES.concat(Object.keys(workersByLane), Object.keys(lanes))));
    },

    // lane 当前绑定到哪个节点（注册表 lane→node，缺绑定回退内建表）：运维台归属解析用
    laneBoundNode(lane) {
      return laneBoundNode(lane);
    },

    // 在队/在跑任务查询（试妆试镜流程防重派；重启后 Map 清空＝无在跑，语义安全）
    activeOf(type, episodeId) {
      const out = [];
      for (const job of jobs.values()) {
        if (job.type !== type) continue;
        if (episodeId && job.episodeId !== episodeId) continue;
        if (["queued", "running"].indexOf(job.status) >= 0) out.push(job);
      }
      return out;
    },

    // 幂等派单（2026-11-21「反复点击生成一大堆任务」根治）：
    // 同 type + episodeId + payload 关键标识（role/shotId）已有活任务（queued/running）→ 不再派，
    // 返回 { deduped:true, existing }；无活任务才真派。活任务判定＝内存 Map（热路径）＋账本兜底
    //（守护频繁重启会清内存——从 log-job.jsonl 每 job_id 最新行恢复 queued/running 判断，防重不失效）。
    enqueueOnce(type, payload, opts) {
      const p = payload || {};
      const epId = (opts && opts.episodeId) || p.episodeId || null;
      const keyOf = (x) => String((x && x.role) || "") + "|" + String((x && x.shotId) || "");
      // —— 内存活任务 ——
      for (const j of jobs.values()) {
        if (j.type !== type) continue;
        if (epId && j.episodeId !== epId) continue;
        if (keyOf(j.payload || {}) !== keyOf(p)) continue;
        if (["queued", "running"].indexOf(j.status) >= 0) return { deduped: true, existing: j, job: null };
      }
      // —— 账本兜底已删除（2026-11-21 二次修正）：跨实例账本判定本质上不成立——旧实例被杀后
      //    其 queued/running 行是孤儿（任务已断），重派＋接续池领回产物才是正确恢复路径；
      //    账本拦它们反而造成「重派永远被拦」（实测：守护反复杀实例 → 每次重派全 deduped）。
      //    防重只信当前实例内存 Map（enqueue 同步写入，连点防重完整覆盖）。 ——
      const job = this.enqueue(type, payload, opts);
      return { deduped: false, existing: null, job };
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
