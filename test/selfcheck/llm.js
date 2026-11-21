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

  await t("监视缓存＋engine 显存互斥闸：LLM 在线 → 本机生图/拍摄类型拒绝，voice 放行", async () => {
    llmMod.startMonitor(cfg);
    await new Promise((r) => setTimeout(r, 120));
    const store = makeStore();
    const bus = { publish() {}, on() {} };
    const engine = createEngine({ store, bus, cfg: Object.assign({}, cfg, { workersDir: path.join(os.tmpdir(), "llmcheck_" + Date.now()) }) });
    assert.throws(() => engine.enqueue("c1plan", { episodeId: "ep_t" }, { episodeId: "ep_t" }), (e) => e.code === "GPU_BUSY", "c1plan 应被闸");
    assert.throws(() => engine.enqueue("video", { shotId: "s1" }, { episodeId: "ep_t" }), (e) => e.code === "GPU_BUSY", "video 应被闸");
    // 非 GPU 类型（voice→tts lane）不在闸名单：但 lane 需要 worker 才执行——enqueue 本身不应抛 GPU_BUSY
    let enqErr = null;
    try { engine.enqueue("voice", { episodeId: "ep_t", sceneId: "sc1", text: "x" }, { episodeId: "ep_t" }); } catch (e) { enqErr = e; }
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

  srv.close();
  const fails = results.filter((r) => r[0] === "fail");
  console.log("\n== llm selfcheck: " + (results.length - fails.length) + "/" + results.length + " passed ==");
  if (fails.length) { process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
