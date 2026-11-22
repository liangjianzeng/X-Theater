"use strict";
/**
 * selfcheck/llm.js — llm-gw 通道自查（2026-11-21）
 * 覆盖：chat 正常/思考开关参数/空回复 fail-open；status 探测；监视缓存＋engine 显存互斥闸；
 * llmintent extractJson/toIntent 键位清洗（防幻觉注入）。
 * 运行：node test/selfcheck/llm.js（自起假 llama-server，端口随机）
 */
const http = require("http");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const llmMod = require("../../src/server/llm/llm.js");
const intent = require("../../src/server/l2/llmintent.js");
const { createEngine } = require("../../src/server/dag/engine.js");

const results = [];
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push(["ok", name]); console.log("  ✓ " + name); })
    .catch((e) => { results.push(["fail", name + " :: " + (e && e.message)]); console.error("  ✗ " + name + " :: " + (e && e.message)); });
}

/* 假 llama-server：/v1/models（在线）＋ /v1/chat/completions（回显+断言参数） */
let lastChatBody = null;
function fakeServer(mode) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        if (req.url.indexOf("/models") >= 0) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ object: "list", data: [{ id: "FakeLLM", name: "FakeLLM" }] }));
        }
        if (req.url.indexOf("/chat/completions") >= 0) {
          lastChatBody = JSON.parse(b || "{}");
          const content = mode === "empty"
            ? ""
            : mode === "fenced"
              ? "```json\n{\"tool\":\"reroll_shot\",\"args\":{\"shot_no\":\"3\",\"episode_id\":\"ep_HACK\",\"shell\":\"ls\"}}\n```"
              : mode === "say"
                ? "```json\n{\"say\":\"目前 16 镜全过审，进度正常。\"}\n```"
                : "好的，办妥了。";
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { completion_tokens: 5 } }));
        }
        res.writeHead(404); res.end("{}");
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

function makeStore() {
  const rows = [];
  const state = { alerts: [], episodes: { ep_t: { id: "ep_t", projectId: "p1", title: "测试剧", budget_cents: 5000, cost_cents: 0, stage: 1, decisions: 0, paused: false } }, cards: {} };
  return {
    get: () => state,
    commit: () => {},
    log: (kind, obj) => rows.push([kind, obj])
  };
}

(async () => {
  const { srv, port } = await fakeServer("ok");
  const base = "http://127.0.0.1:" + port;
  const cfg = { llm: { base, model: "FakeLLM" }, comfy: { base: "http://127.0.0.1:1" } };

  await t("chat：正常路径（content/usage/秒）", async () => {
    const r = await llmMod.chat(cfg, [{ role: "user", content: "hi" }], { maxTokens: 10 });
    assert.strictEqual(r.ok, true, "ok");
    assert.strictEqual(r.content, "好的，办妥了。");
    assert.ok(r.seconds >= 0);
  });

  await t("chat：默认关思考（chat_template_kwargs.enable_thinking=false）", async () => {
    await llmMod.chat(cfg, [{ role: "user", content: "hi" }], {});
    assert.strictEqual(lastChatBody.chat_template_kwargs.enable_thinking, false);
    assert.strictEqual(lastChatBody.model, "FakeLLM");
  });

  await t("chat：空回复 → fail-open（ok:false, LLM_BAD_OUTPUT）", async () => {
    const r = await llmMod.chat(cfg, [{ role: "user", content: "hi" }], { maxTokens: 10 });
    void r;
    const r2 = await llmMod.chat({ llm: { base, model: "FakeLLM" } }, [{ role: "user", content: "hi" }], { maxTokens: 10 });
    void r2;
    // 用独立空回复 server 避免与上一条竞态：
    const { srv: s2, port: p2 } = await fakeServer("empty");
    const r3 = await llmMod.chat({ llm: { base: "http://127.0.0.1:" + p2, model: "FakeLLM" } }, [{ role: "user", content: "hi" }], {});
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(r3.code, "LLM_BAD_OUTPUT");
    s2.close();
  });

  await t("chat：死端口 → fail-open（LLM_TIMEOUT）不抛异常", async () => {
    const r = await llmMod.chat({ llm: { base: "http://127.0.0.1:1", model: "x" } }, [{ role: "user", content: "hi" }], { timeoutMs: 1500 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.code === "LLM_TIMEOUT" || r.code === "LLM_BAD_OUTPUT");
  });

  await t("status：探测在线＋模型名", async () => {
    const s = await llmMod.status(cfg);
    assert.strictEqual(s.online, true);
    assert.strictEqual(s.model, "FakeLLM");
  });

  await t("监视缓存＋算力池：LLM 在线 → 本机被闸自动改道（有下家）/ 无下家收口 POOL_EMPTY，voice 放行", async () => {
    llmMod.startMonitor(cfg);
    await new Promise((r) => setTimeout(r, 120));
    const workersDir = path.join(os.tmpdir(), "llmcheck_" + Date.now());
    fs.mkdirSync(workersDir, { recursive: true });
    ["t2i.local", "t2i.remote", "t2v.local", "t2v.remote"].forEach((lane) => {
      fs.writeFileSync(path.join(workersDir, lane + ".js"),
        "exports.lane=" + JSON.stringify(lane) + ";exports.name='stub';exports.run=function(ctx,job,done){done();};");
    });
    const bus = { publish() {}, on() {} };
    /* 态1：只有本机（被闸）→ 池无下家 → POOL_EMPTY 收口（替代旧 GPU_BUSY 长文案） */
    const engineSolo = createEngine({ store: makeStore(), bus, cfg: Object.assign({}, cfg, { workersDir }) });
    assert.throws(() => engineSolo.enqueue("c1plan", { episodeId: "ep_t" }, { episodeId: "ep_t" }), (e) => e.code === "POOL_EMPTY", "本机被闸且无下家 → POOL_EMPTY");
    assert.throws(() => engineSolo.enqueue("video", { shotId: "s1" }, { episodeId: "ep_t" }), (e) => e.code === "POOL_EMPTY", "video 同收口");
    /* 态2：注册表有非 gated 远端节点（dgx）→ 自动改道，不再拒绝 */
    const store2 = makeStore();
    store2.get().nodes = { local: { id: "local", label: "本机", kind: "comfy", gpu_gate: true }, dgx: { id: "dgx", label: "DGX", kind: "comfy", gpu_gate: false } };
    store2.get().settings = { registry: { r1: { lane: "t2i.local", node: "local" }, r2: { lane: "t2i.remote", node: "dgx" }, r3: { lane: "t2v.local", node: "local" }, r4: { lane: "t2v.remote", node: "dgx" } } };
    const engine2 = createEngine({ store: store2, bus, cfg: Object.assign({}, cfg, { workersDir }) });
    const j1 = engine2.enqueue("c1plan", { episodeId: "ep_t" }, { episodeId: "ep_t" });
    assert.strictEqual(j1.lane, "t2i.remote", "c1plan 改道 DGX 车道");
    const j2 = engine2.enqueue("video", { shotId: "s1" }, { episodeId: "ep_t" });
    assert.strictEqual(j2.lane, "t2v.remote", "video 改道 DGX 车道");
    // 非 GPU 类型（voice→tts lane）不在闸名单：enqueue 本身不应抛 GPU_BUSY
    let enqErr = null;
    try { engine2.enqueue("voice", { episodeId: "ep_t", sceneId: "sc1", text: "x" }, { episodeId: "ep_t" }); } catch (e) { enqErr = e; }
    assert.ok(!(enqErr && enqErr.code === "GPU_BUSY"), "voice 不应被 GPU 闸拦（enqErr=" + (enqErr && enqErr.code) + "）");
  });

  await t("llmintent.extractJson：容忍围栏与杂语", async () => {
    const j = intent.extractJson("前置废话```json\n{\"a\":1}\n```后置");
    assert.deepStrictEqual(j, { a: 1 });
  });

  await t("llmintent.toIntent：键位清洗（剥 episode_id/shell）＋shot_no→shot_id", async () => {
    const { srv: s3, port: p3 } = await fakeServer("fenced");
    const cfg3 = { llm: { base: "http://127.0.0.1:" + p3, model: "FakeLLM" } };
    const ctx = {
      llm: llmMod.create(cfg3),
      store: (function () {
        const state = {
          episodes: { ep_t: { id: "ep_t", projectId: "p1", title: "测试剧" } },
          shots: { sh_1: { id: "sh_1", episodeId: "ep_t", seq: 101 }, sh_2: { id: "sh_2", episodeId: "ep_t", seq: 102 }, sh_3: { id: "sh_3", episodeId: "ep_t", seq: 103 } },
          scenes: {}
        };
        return { get: () => state, commit: () => {} };
      })(),
      util: { hash12: () => "abcdef1234567890", now: () => 1, uid: () => "u1" }
    };
    const session = { id: "l2s_x", uid: "u2" };
    const i = await intent.llmParse("重拍第3镜", [], ctx, session);
    assert.ok(i, "应解析出意图");
    assert.strictEqual(i.tool, "reroll_shot");
    assert.strictEqual(i.args.shot_id, "sh_3");
    assert.strictEqual(i.args.episode_id, "ep_t", "episode_id 由服务端注入（defaultEpisodeId）");
    assert.ok(!("shell" in i.args), "禁键位必须剥除");
    s3.close();
  });

  await t("llmintent：say 直答意图透传", async () => {
    const { srv: s4, port: p4 } = await fakeServer("say");
    const cfg4 = { llm: { base: "http://127.0.0.1:" + p4, model: "FakeLLM" } };
    const ctx = {
      llm: llmMod.create(cfg4),
      store: (function () { const state = { episodes: { ep_t: { id: "ep_t", projectId: "p1", title: "测试剧" } }, shots: {}, scenes: {} }; return { get: () => state, commit: () => {} }; })(),
      util: { hash12: () => "abcdef1234567890", now: () => 1, uid: () => "u1" }
    };
    const session = { id: "l2s_x", uid: "u2" };
    const i = await intent.llmParse("咱们进度怎么样？", [], ctx, session);
    assert.ok(i && i.say && i.say.indexOf("16 镜") >= 0, "say 直答");
    s4.close();
  });

  /* ---------- 会话记忆 v1（蓝图 §6 P2：项目事实摘要，跨会话） ---------- */
  const mem = require("../../src/server/l2/memory.js");

  await t("memory：真实结果→事实台账（查询/建议不记＋无 ID 纪律）", async () => {
    const state = { projects: {}, episodes: {}, cards: {} };
    const ctx = { store: { get: () => state, commit: () => {} }, util: { now: () => 1795400000000 } };
    const e1 = mem.note(ctx, "pj_t", "create_project", { title: "记忆验证剧" }, { project_id: "pj_t", title: "记忆验证剧", look: "写实电影感" });
    assert.ok(e1 && e1.text.indexOf("记忆验证剧") >= 0 && e1.text.indexOf("写实电影感") >= 0, "立项事实入库");
    assert.strictEqual(mem.note(ctx, "pj_t", "query_progress", {}, { done: 1 }), null, "查询类不记");
    assert.strictEqual(mem.note(ctx, "pj_t", "suggest_card", {}, {}), null, "建议类不记");
    assert.strictEqual(mem.note(ctx, "pj_t", "query_gpu", {}, {}), null, "只读工具一律不记");
    const arr = mem.list(ctx, "pj_t");
    assert.strictEqual(arr.length, 1, "台账只有 1 条");
    assert.ok(!/pj_|ep_|card_|sh_|l2s_/.test(arr[0].text), "无 ID 露出（用户面纪律）");
  });

  await t("memory：环缓冲 30＋block 注入最新在前 ≤8", async () => {
    const state = { projects: { pj_t: { id: "pj_t" } }, episodes: { ep_t: { id: "ep_t", projectId: "pj_t" } }, cards: {} };
    const ctx = { store: { get: () => state, commit: () => {} }, util: { now: () => 1795400000000 } };
    for (let i = 1; i <= 35; i++) {
      mem.note(ctx, "pj_t", "create_episode", { brief: "第" + i + "个故事" }, { episode_id: "ep_t", title: "第" + i + "集", project_id: "pj_t" });
    }
    assert.strictEqual(mem.list(ctx, "pj_t").length, 30, "环缓冲封顶 30");
    assert.ok(mem.list(ctx, "pj_t")[0].text.indexOf("第6集") >= 0, "最老 5 条被挤出（保 6..35）");
    const lines = mem.block(ctx, "ep_t").split("\n");
    assert.strictEqual(lines.length, 8, "注入封顶 8（实际 " + lines.length + "）");
    assert.ok(lines[0].indexOf("第35集") >= 0, "最新在前");
    assert.ok(lines[7].indexOf("第28集") >= 0, "最旧注入第28集");
  });

  await t("memory：systemPrompt 注入项目记忆块（绑定集→项目→台账；无绑定则整块省略）", async () => {
    const state = {
      projects: { pj_t: { id: "pj_t", title: "记忆验证剧" } },
      episodes: { ep_t: { id: "ep_t", projectId: "pj_t", title: "测试剧", stage: 1 } },
      scenes: {}, shots: {}, cards: { card_x: { id: "card_x", episodeId: "ep_t" } }
    };
    const ctx = { store: { get: () => state, commit: () => {} }, util: { now: () => 1795400000000 } };
    /* 卡片路径定位项目（decide_card 走审批执行，result.card_id → card.episodeId → project） */
    mem.note(ctx, mem.projectIdFor(ctx, { ctx: [] }, "decide_card", { card_id: "card_x", type: "C1" }), "decide_card", { action: "accept" }, { card_id: "card_x", type: "C1", action: "accept" });
    const sp = intent.systemPrompt(ctx, { id: "l2s_x", uid: "u2", ctx: [{ type: "episode", id: "ep_t" }] }, []);
    assert.ok(sp.indexOf("项目记忆") >= 0, "块标题在场");
    assert.ok(sp.indexOf("故事方向卡通过拍板") >= 0, "C1 拍板事实（cardLabel 中文名）");
    assert.ok(sp.indexOf("card_x") < 0 && sp.indexOf("pj_t") < 0, "无 ID 露出");
    /* 无绑定集会话：项目块整块省略（fail-open，prompt 不含空段落） */
    const sp2 = intent.systemPrompt(ctx, { id: "l2s_y", uid: "u2", ctx: [{ type: "episode", id: "ep_none" }] }, []);
    assert.ok(sp2.indexOf("项目记忆") < 0, "无绑定→无记忆块");
  });

  srv.close();
  const fails = results.filter((r) => r[0] === "fail");
  console.log("\n== llm selfcheck: " + (results.length - fails.length) + "/" + results.length + " passed ==");
  if (fails.length) { process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
