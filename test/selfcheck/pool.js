/* 算力资源池 selfcheck（蓝图 §8.3，2026-11-22 用户裁决「调度池」）
   覆盖：池改道（闸挡本机→找下家）/用户默认算力/云 API 优先/全部不可用收口/
   显式节点未绑引擎引导/tier:high 固定车道/无闸回落本机。 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; failures.push(name); console.log("  FAIL  " + name); }
}
function section(name) { console.log("\n== " + name + " =="); }

/* ---------- 引擎夹具：stub workers＋注册表状态 ---------- */
function makeEngine(opts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pool-workers-"));
  ["t2i.local", "t2i.remote", "t2v.local", "t2v.remote"].forEach((lane) => {
    fs.writeFileSync(path.join(tmp, lane + ".js"),
      "exports.lane=" + JSON.stringify(lane) + ";exports.name='stub';exports.run=function(ctx,job,done){done();};");
  });
  const state = {
    nodes: {
      local: { id: "local", label: "本机", kind: "comfy", gpu_gate: true, comfy: { base: "http://127.0.0.1:8188" } },
      dgx: { id: "dgx", label: "DGX", kind: "comfy", gpu_gate: false, comfy: { base: "http://10.0.0.9:8188" } }
    },
    users: { u1: { id: "u1", name: "甲", driver: (opts && opts.userDriver) || "" }, u2: { id: "u2", name: "乙", driver: "" } },
    settings: { registry: opts.registry || {} },
    episodes: { e1: { id: "e1", projectId: "p1", title: "测试集", driver: (opts && opts.epDriver) || "" } },
    projects: { p1: { id: "p1", title: "测试项目" } },
    llm_node: "local",
    alerts: [],
  };
  const store = {
    get() { return state; },
    commit() {},
    log() { return {}; },
    readLog() { return []; }
  };
  const bus = { publish() {}, on() {}, off() {}, attach() { return function () {}; }, detach() {} };
  const engineMod = require("../../src/server/dag/engine.js");
  const engine = engineMod.createEngine({
    store, bus,
    cfg: { workersDir: tmp, llmBlockedOverride: !!opts.blocked }
  });
  return { engine, state, tmp };
}

function run() {
  const BIND_BOTH = { r1: { lane: "t2i.local", node: "local", quant: "std" }, r2: { lane: "t2i.remote", node: "dgx", quant: "std" } };

  section("池改道：LLM 占卡（本机被闸）→ img_free 自动落 DGX 车道");
  {
    const { engine, tmp } = makeEngine({ registry: BIND_BOTH, blocked: true, userDriver: "dgx" });
    const job = engine.enqueue("img_free", { desc: "测试图", projectId: "p1" }, { initiated_by: "u1", free: true });
    ok(job.lane === "t2i.remote", "img_free 无集任务 → 用户默认算力 DGX（t2i.remote），不再撞本机闸");
    const job2 = engine.enqueue("img_free", { desc: "甲乙丙", projectId: "p1" }, { initiated_by: "u2", free: true }); // 无默认算力 → 远端优先于本机
    ok(job2.lane === "t2i.remote", "无默认算力 → 远端 comfy 优先于本机");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  section("无闸回落：LLM 不占卡 → 本机可用（排在远端之后，但远端被删时回落）");
  {
    const regLocalOnly = { r1: { lane: "t2i.local", node: "local", quant: "std" } }; // dgx 未绑 img 族
    const { engine, tmp } = makeEngine({ registry: regLocalOnly, blocked: false });
    const job = engine.enqueue("img_free", { desc: "x", projectId: "p1" }, { initiated_by: "u2", free: true });
    ok(job.lane === "t2i.local", "唯一绑定＝本机 → 回落本机车道");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  section("全部不可用 → POOL_EMPTY 一句收口（不点名硬件）");
  {
    const regLocalOnly = { r1: { lane: "t2i.local", node: "local", quant: "std" } };
    const { engine, tmp } = makeEngine({ registry: regLocalOnly, blocked: true });
    let threw = null;
    try { engine.enqueue("img_free", { desc: "x", projectId: "p1" }, { initiated_by: "u2", free: true }); }
    catch (e) { threw = e; }
    ok(threw && threw.code === "POOL_EMPTY" && String(threw.message).indexOf("算力池") >= 0, "本机被闸＋无其它节点 → POOL_EMPTY 收口文案");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  section("显式集节点未绑引擎 → NODE_NO_LANE 引导改绑");
  {
    const regLocalOnly = { r1: { lane: "t2i.local", node: "local", quant: "std" } };
    const { engine, tmp } = makeEngine({ registry: regLocalOnly, blocked: true, epDriver: "dgx" });
    let threw = null;
    try { engine.enqueue("img_free", { desc: "x", projectId: "p1" }, { episodeId: "e1", initiated_by: "u1", free: true }); }
    catch (e) { threw = e; }
    ok(threw && threw.code === "NODE_NO_LANE", "集指定 DGX 但未绑 img 族引擎 → 引导改绑");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  section("tier:high 固定车道不漂移（H3 专用引擎）＋池外防御闸");
  {
    const { engine, tmp } = makeEngine({ registry: BIND_BOTH, blocked: true, epDriver: "local" });
    const job = engine.enqueue("casting", { projectId: "p1" }, { episodeId: "e1", initiated_by: "u1", tier: "high", free: true });
    ok(job.lane === "t2i.remote", "tier:high → t2i.remote 固定（不走池）");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  section("video 族同池语义");
  {
    const regV = { r1: { lane: "t2v.local", node: "local", quant: "std" }, r2: { lane: "t2v.remote", node: "dgx", quant: "std" } };
    const { engine, tmp } = makeEngine({ registry: regV, blocked: true, userDriver: "dgx" });
    const job = engine.enqueue("video", { shotId: "sh1", sec: 5, projectId: "p1" }, { episodeId: "e1", initiated_by: "u1", free: true });
    ok(job.lane === "t2v.remote", "video LLM 占卡 → t2v.remote（DGX）");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("\n──────── 算力池 selfcheck 汇总 ────────");
  console.log("PASS " + passed + " / FAIL " + failed);
  if (failed) console.log("失败项：" + failures.join(" | "));
  process.exitCode = failed ? 1 : 0;
}
run();
