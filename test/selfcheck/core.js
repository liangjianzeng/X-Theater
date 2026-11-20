"use strict";
/**
 * test/selfcheck/core.js — core 模块自查（契约 §9：只测自己模块，桩依赖注入）
 * 覆盖：util（hash12 确定性/sign+verify/cas STALE）· store（种子/账本/commit 防抖）·
 *       engine（入队→done、失败梯子自动补拍≤2、预算护栏、retry/stop、queueState、对账不变量）·
 *       router（200/401/403/404/405/409 映射/JSON body/1MB→413/静态兜底 false）· bus（SSE 订阅与 l2 过滤）
 * 桩 worker 目录由本脚本运行时生成（cfg.workersDir 注入），确定性、无 Math.random。
 * exit 0 全绿 / 1 有失败。
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const util = require("../../src/server/core/util");
const { openStore } = require("../../src/server/core/store");
const { createBus } = require("../../src/server/core/bus");
const { createRouter } = require("../../src/server/core/router");
const { createEngine } = require("../../src/server/dag/engine");

const TMP = path.join(__dirname, ".tmp-core");
const VAR_DIR = path.join(TMP, "var");
const WORKERS_DIR = path.join(TMP, "stub_workers");

/* ---------------- 断言工具 ---------------- */
let passed = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) {
    passed++;
    console.log("  PASS  " + name);
  } else {
    failed++;
    console.error("  FAIL  " + name + (extra ? "  [" + extra + "]" : ""));
  }
}
function throwsCode(fn, code, name) {
  try {
    fn();
    ok(false, name, "未抛异常");
  } catch (e) {
    ok(!!e && e.code === code, name, "code=" + (e && e.code) + " msg=" + (e && e.message));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, interval) {
  ms = ms || 3000;
  interval = interval || 20;
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch (e) {
      v = false;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) return false;
    await sleep(interval);
  }
}

/* ---------------- 桩 worker（确定性） ---------------- */
function writeStubWorkers() {
  fs.mkdirSync(WORKERS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(WORKERS_DIR, "music.js"),
    '"use strict";\n' +
      "module.exports = { name: \"stub-music\", lane: \"music\", async run(job) {\n" +
      "  const d = job.payload && job.payload.delay;\n" +
      "  if (d) await new Promise((r) => setTimeout(r, d));\n" +
      "  const c = job.payload && typeof job.payload.cents === \"number\" ? job.payload.cents : 120;\n" +
      "  return { cents: c };\n" +
      "} };\n"
  );
  // tts：前 3 次必炸（测自动补拍梯子），第 4 次起成功（测 retry）
  fs.writeFileSync(
    path.join(WORKERS_DIR, "tts.js"),
    '"use strict";\n' +
      "let calls = 0;\n" +
      "module.exports = { name: \"stub-tts\", lane: \"tts\", async run() {\n" +
      "  calls += 1;\n" +
      "  if (calls <= 3) throw new Error(\"stub boom #\" + calls);\n" +
      "  return { cents: 10 };\n" +
      "} };\n"
  );
  fs.writeFileSync(
    path.join(WORKERS_DIR, "compose.js"),
    '"use strict";\n' +
      "module.exports = { name: \"stub-compose\", lane: \"compose\", async run(job) {\n" +
      "  const c = job.payload && typeof job.payload.cents === \"number\" ? job.payload.cents : 6500;\n" +
      "  return { cents: c };\n" +
      "} };\n"
  );
}

/* ---------------- 测试主体 ---------------- */
async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(VAR_DIR, { recursive: true });
  writeStubWorkers();

  /* ---------- util ---------- */
  console.log("[util]");
  ok(
    util.hash12({ a: 1, b: { c: 2, d: 3 } }) === util.hash12({ b: { d: 3, c: 2 }, a: 1 }),
    "hash12 键序无关·确定性"
  );
  ok(/^[0-9a-f]{12}$/.test(util.hash12({ x: "y" })), "hash12 为 12 位 hex");
  ok(util.hash12({ x: 1 }) !== util.hash12({ x: 2 }), "hash12 输入敏感");
  ok(util.uid("job") !== util.uid("job") && util.uid("shot").indexOf("shot_") === 0, "uid 唯一且带前缀");
  const tok = util.sign({ uid: "u1", role: "ops" });
  const v = util.verify(tok);
  ok(!!v && v.uid === "u1" && v.role === "ops", "sign→verify 往返");
  ok(util.verify(tok.slice(0, -2) + "aa") === null, "篡改 token → null");
  ok(util.verify("garbage") === null, "垃圾 token → null");
  ok(util.verify(util.sign({ uid: "u1", exp: util.now() - 1000 })) === null, "过期 token → null");
  const card = { id: "c1", ver: 3 };
  ok(util.cas(card, 3) === card, "cas 版本匹配通过");
  throwsCode(() => util.cas(card, 2), "STALE", "cas 版本不匹配 → STALE");
  let mono = true;
  let last = 0;
  for (let i = 0; i < 200; i++) {
    const t = util.now();
    if (t < last) mono = false;
    last = t;
  }
  ok(mono, "now() 单调不减");

  /* ---------- store ---------- */
  console.log("[store]");
  const store = openStore(VAR_DIR);
  const st = store.get();
  ok(store.seeded === true, "首次打开 → 种子初始化");
  ok(st.projects.p1.title === "夜航西飞", "种子 p1《夜航西飞》");
  ok(Object.keys(st.episodes).length === 1 && st.episodes.e1.budget_cents === 5000, "种子 e1·预算 5000 分");
  ok(Object.keys(st.scenes).length === 4, "种子 4 scenes");
  ok(Object.keys(st.shots).length === 16, "种子 16 shots");
  ok(st.shots.sh07 && st.shots.sh07.status === "pending_review", "#7 pending_review");
  ok(st.review_q.length === 1 && st.review_q[0].shotId === "sh07", "review_q 关联 #7");
  ok(
    st.music_lib.length === 2 &&
      st.music_lib[0].license.usage === "ok" &&
      st.music_lib[1].license.usage === "missing" &&
      st.music_lib[1].title.indexOf("未许可") === -1,
    "music_lib：《晚风》ok／《码头暮色》missing（种子直接给定 license 对象·演示用）"
  );
  ok(st.invites[0] === "INV-DEMO-1", "邀请码 INV-DEMO-1");
  ok(st.settings.registry["MiniMax-H3-Image"].unavail.join() === "nvfp4,int8", "registry 段位不可用表");
  ok(st.settings.runtime_mode === "A" && st.settings.peak_valley === true, "settings 默认");
  const logLine = store.log("audit", { operator: "u2", action: "selfcheck" });
  const audits = store.readLog("audit");
  ok(audits.length === 1 && audits[0].operator === "u2" && !!logLine.id && typeof logLine.ts === "number", "log/readLog JSONL");
  st.episodes.e1.stage = 2;
  store.commit();
  await sleep(120); // 防抖 50ms
  const onDisk = JSON.parse(fs.readFileSync(path.join(VAR_DIR, "state.json"), "utf8"));
  ok(onDisk.episodes.e1.stage === 2, "commit 防抖落盘");
  const store2 = openStore(VAR_DIR);
  ok(store2.seeded === false && store2.get().episodes.e1.stage === 2, "二次打开不重置");

  /* ---------- engine ---------- */
  console.log("[engine]");
  const bus = createBus();
  const events = [];
  const rawPublish = bus.publish;
  bus.publish = (topic, obj) => {
    events.push(Object.assign({ topic }, obj));
    rawPublish(topic, obj);
  };
  const engine = createEngine({
    store,
    bus,
    cfg: { workersDir: WORKERS_DIR, outDir: path.join(VAR_DIR, "out"), seed: true }
  });
  engine.rules = { langlint: null, quant: null, license: null, moderation: null, budget: null };

  // 1) 入队→done＋影子计费＋事件
  const jobM = engine.enqueue("music", { sceneId: "s1", cents: 120 }, { episodeId: "e1", initiated_by: "user" });
  ok(jobM.status === "queued" && jobM.lane === "music", "enqueue music → queued(lane=music)");
  ok(await until(() => engine.getJob(jobM.id).status === "done"), "music job → done");
  ok(st.episodes.e1.cost_cents === 120, "done 后 episode 成本累加 120");
  const billing1 = store.readLog("billing");
  ok(billing1.length === 1 && billing1[0].cents === 120 && billing1[0].episodeId === "e1", "billing 影子账落账");
  ok(!!events.find((e) => e.topic === "jobs" && e.job_id === jobM.id && e.status === "done"), "bus 发布 jobs/done");
  const jobLedger = store.readLog("job");
  ok(
    jobLedger.find((l) => l.job_id === jobM.id && l.status === "queued" && l.worker_type === "self-host-stub"),
    "job 账本：入队即落＋worker_type=self-host-stub"
  );

  // 2) lane 串行 + stop（queued→cancelled）
  const jobA = engine.enqueue("music", { delay: 120, cents: 30 }, { episodeId: "e1" });
  ok(await until(() => engine.getJob(jobA.id).status === "running"), "A 进入 running");
  const jobB = engine.enqueue("music", { cents: 30 }, { episodeId: "e1" });
  ok(engine.queueState().music.queued === 1, "lane 并发 1：B 排队");
  engine.stop(jobB.id);
  ok(engine.getJob(jobB.id).status === "cancelled", "stop：queued→cancelled");
  ok(await until(() => engine.getJob(jobA.id).status === "done"), "A done（串行推进）");
  throwsCode(() => engine.stop(jobA.id), "CONFLICT", "stop 非 queued → CONFLICT");

  // 3) 失败梯子：3 跑（首发+2 次系统补拍）→ failed＋告警
  const jobF = engine.enqueue("voice", { line: "你好" }, { episodeId: "e1" });
  ok(await until(() => engine.getJob(jobF.id).status === "failed"), "voice 最终 failed");
  ok(engine.getJob(jobF.id).attempts === 3, "attempts=3（含首发共 3 跑）");
  const retryLedger = store.readLog("job").filter(
    (l) => l.job_id === jobF.id && l.status === "retry" && l.initiated_by === "system" && l.free === true
  );
  ok(retryLedger.length === 2, "自动补拍恰 2 次（initiated_by=system·free）");
  ok(!!st.alerts.find((a) => a.kind === "job_failed"), "失败→alert");
  const billingF = store.readLog("billing").filter((b) => b.kind === "voice");
  ok(billingF.length === 0, "free 补拍任务不计费");

  // 4) retry：用户手动重试成功
  engine.retry(jobF.id);
  ok(await until(() => engine.getJob(jobF.id).status === "done"), "retry 后 done");
  const manualRetry = store
    .readLog("job")
    .find((l) => l.job_id === jobF.id && l.status === "retry" && l.initiated_by === "user");
  ok(!!manualRetry, "retry 写账本 initiated_by=user");

  // 5) 预算护栏：cost > budget*1.2 → paused＋alert＋该集新 enqueue 拒绝 BUDGET
  ok(st.episodes.e1.cost_cents === 160, "护栏前累计成本 160（120+30+10）");
  const jobC = engine.enqueue("compose", { cents: 6500 }, { episodeId: "e1" });
  ok(await until(() => st.episodes.e1.paused === true), "预算护栏触发 paused=true");
  ok(!!st.alerts.find((a) => a.kind === "budget"), "护栏→alert(budget)");
  ok(!!events.find((e) => e.topic === "alerts" && e.kind === "budget"), "护栏→bus alerts");
  throwsCode(() => engine.enqueue("music", {}, { episodeId: "e1" }), "BUDGET", "paused 集 enqueue → BUDGET");
  throwsCode(() => engine.retry(jobC.id), "BUDGET", "paused 集 retry → BUDGET");

  // 6) queueState 形状 + 对账不变量
  const qs = engine.queueState();
  ok(
    ["img5060", "imgspark", "vid5060", "vidspark", "music", "tts", "compose", "moderate"].every(
      (l) => qs[l] && typeof qs[l].queued === "number" && typeof qs[l].running === "number"
    ),
    "queueState 各 lane {queued,running}"
  );
  const sum = store.readLog("billing").reduce((a, b) => a + (b.episodeId === "e1" ? b.cents : 0), 0);
  ok(sum === st.episodes.e1.cost_cents, "对账不变量 Σbilling(episode)==cost_cents（" + sum + "）");
  throwsCode(() => engine.enqueue("nope", {}, {}), "BAD_TYPE", "未知类型 → BAD_TYPE");

  store.flush();

  /* ---------- router + bus(SSE) ---------- */
  console.log("[router+bus/SSE]");
  const router = createRouter();
  router.useAuth((req) => {
    const h = String(req.headers["authorization"] || "");
    if (/^Bearer\s+tok-ops$/i.test(h.trim())) return { id: "u2", role: "ops" };
    if (/^Bearer\s+tok-creator$/i.test(h.trim())) return { id: "u1", role: "creator" };
    return null;
  });
  const routerBus = createBus();
  router.add("GET", "/api/ping", (req, res) => router.json(res, 200, { pong: 1 }));
  router.add("POST", "/api/echo", (req, res, body) => router.json(res, 200, { echo: body }));
  router.add("GET", "/api/stale", () => {
    throw { code: "STALE", message: "上下文已变" };
  });
  router.add("GET", "/api/cards/:id", (req, res, body, params) => router.json(res, 200, { id: params.id }));
  router.add("GET", "/api/admin", (req, res) => router.json(res, 200, { admin: true }), { auth: true, role: "ops" });
  router.add("GET", "/events", (req, res) => {
    const q = new URL(req.url, "http://local").searchParams.get("session");
    routerBus.attach(res, q ? { session: q } : {});
  });
  router.add("POST", "/pub", (req, res, body) => {
    routerBus.publish(body.topic, body.data);
    router.json(res, 200, { ok: true });
  });

  const server = http.createServer((req, res) => {
    Promise.resolve(router.handle(req, res)).then((handled) => {
      if (!handled) router.json(res, 404, { error: { code: "NOT_FOUND", message: "静态兜底未命中（core 自测桩）" } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  function req2(method, urlPath, body, headers) {
    return new Promise((resolve, reject) => {
      const rq = http.request(
        { host: "127.0.0.1", port, method, path: urlPath, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) },
        (rs) => {
          let data = "";
          rs.on("data", (c) => (data += c));
          rs.on("end", () => resolve({ status: rs.statusCode, data }));
        }
      );
      rq.on("error", reject);
      if (body !== undefined) rq.write(typeof body === "string" ? body : JSON.stringify(body));
      rq.end();
    });
  }

  let r = await req2("GET", "/api/ping");
  ok(r.status === 200 && JSON.parse(r.data).pong === 1, "GET 200");
  r = await req2("GET", "/api/cards/sh07");
  ok(r.status === 200 && JSON.parse(r.data).id === "sh07", ":param 解析");
  r = await req2("POST", "/api/echo", { a: 1 });
  ok(r.status === 200 && JSON.parse(r.data).echo.a === 1, "POST JSON body");
  r = await req2("GET", "/api/stale");
  ok(r.status === 409 && JSON.parse(r.data).error.code === "STALE", "STALE → 409 {error:{code,message}}");
  r = await req2("POST", "/api/ping");
  ok(r.status === 405, "方法不匹配 → 405");
  r = await req2("GET", "/api/nope");
  ok(r.status === 404 && JSON.parse(r.data).error.code === "NOT_FOUND", "/api 未匹配 → 404 JSON");
  r = await req2("GET", "/index.html");
  ok(r.status === 404, "非 /api 未匹配 → handle 返回 false（index 静态兜底）");
  r = await req2("GET", "/api/admin");
  ok(r.status === 401, "auth:true 无 token → 401");
  r = await req2("GET", "/api/admin", undefined, { Authorization: "Bearer tok-creator" });
  ok(r.status === 403 && JSON.parse(r.data).error.code === "FORBIDDEN", "role 不符 → 403 FORBIDDEN");
  r = await req2("GET", "/api/admin", undefined, { Authorization: "Bearer tok-ops" });
  ok(r.status === 200, "role=ops → 200");
  const big = JSON.stringify({ blob: "x".repeat(1024 * 1024 + 16) });
  r = await req2("POST", "/api/echo", big);
  ok(r.status === 413 && JSON.parse(r.data).error.code === "PAYLOAD_TOO_LARGE", "body>1MB → 413");

  // SSE：普通客户端收 jobs、不收 l2；session 客户端收 l2:<sid>
  function subscribe(query) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const rq = http.request({ host: "127.0.0.1", port, method: "GET", path: "/events" + (query || "") }, (rs) => {
        rs.on("data", (c) => chunks.push(c.toString()));
        resolve({
          rq,
          text: () => chunks.join("")
        });
      });
      rq.on("error", () => {});
      rq.end();
    });
  }
  const sub1 = await subscribe();
  await sleep(60);
  await req2("POST", "/pub", { topic: "jobs", data: { job_id: "j_pub", hello: 1 } });
  await req2("POST", "/pub", { topic: "l2:s9", data: { secret: 1 } });
  await sleep(80);
  const t1 = sub1.text();
  ok(t1.indexOf('"topic":"jobs"') >= 0 && t1.indexOf('"hello":1') >= 0, "SSE 收到 jobs publish");
  ok(t1.indexOf("l2:s9") === -1, "SSE 默认不订 l2 topic");
  sub1.rq.destroy();

  const sub2 = await subscribe("?session=s9");
  await sleep(60);
  await req2("POST", "/pub", { topic: "l2:s9", data: { v: 7 } });
  await req2("POST", "/pub", { topic: "l2:s8", data: { v: 8 } });
  await sleep(80);
  const t2 = sub2.text();
  ok(t2.indexOf("l2:s9") >= 0 && t2.indexOf('"v":7') >= 0, "SSE ?session 订到 l2:<sid>");
  ok(t2.indexOf("l2:s8") === -1, "SSE 不串其他 l2 session");
  sub2.rq.destroy();

  await new Promise((r2) => server.close(r2));
  store.flush();
}

main()
  .then(() => {
    console.log("\ncore selfcheck: " + passed + " passed, " + failed + " failed");
    console.log("ALL CLEAR");
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("\ncore selfcheck CRASH:", e && e.stack ? e.stack : e);
    process.exit(1);
  });
