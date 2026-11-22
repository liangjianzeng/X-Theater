"use strict";
/* 意图回归·在线双跑（蓝图 §6 P3，验收脚本非门禁）：
   node test/acceptance/llm-intent.js [--base http://127.0.0.1:8767] [--code INV-DEMO-1]
   复用 test/selfcheck/intent-corpus.js 语料，只跑【只读面】（query_progress/cost/cards/gpu/projects＋
   闲聊 say）——新建/拍板/重拍/导出/配乐类话术在线会真实执行（建项/出票/派单），验收一律不自动发。
   断言：LLM 脸路由结果 ∈ 允许集合；输出每类正确率与错误明细。LLM 离线自动跳过（提示先起 :8090）。 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function argOf(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const BASE = argOf("--base", "http://127.0.0.1:8767") + "/api";
const CODE = argOf("--code", "INV-DEMO-1");
const corpus = require(path.join(__dirname, "..", "selfcheck", "intent-corpus.js"));

/* 在线安全面：只读工具白名单＋闲聊（期望 say/refusal/null 均算“未执行动作”） */
const READ_TOOLS = ["query_progress", "query_cost", "query_cards", "query_gpu", "query_projects"];
const rows = fs.readFileSync(path.join(__dirname, "..", "..", "var", "log-agentrun.jsonl"), "utf8").trim().split("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, body, tok) {
  const r = await fetch(BASE + p, { method, headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

(async () => {
  const login = await call("POST", "/login", { code: CODE });
  const tok = login.j.token;
  if (!tok) { console.log("登录失败"); return; }
  const gpu = await call("GET", "/gpu", null, tok);
  if (!(gpu.j && gpu.j.llm && gpu.j.llm.online)) {
    console.log("LLM 离线（:8090 未起）——在线双跑需先起本机 LLM；离线路由已由 selfcheck 覆盖。");
    return;
  }
  const s = await call("POST", "/l2/sessions", { mode: "B" }, tok);
  const sid = s.j.session.id;
  const ledger = () => fs.readFileSync(path.join(__dirname, "..", "..", "var", "log-agentrun.jsonl"), "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean)
    .filter((r) => String(r.sessionId || "") === String(sid));

  /* 语料筛选：只读面（期望 tool ∈ READ_TOOLS）＋兜底口语（期望 null→say，不落任何工具） */
  const cases = corpus.rules.filter(([, want]) => want === "null" || READ_TOOLS.indexOf(want) >= 0);
  const results = [];
  for (const [text, want] of cases) {
    const before = ledger().length;
    await call("POST", "/l2/sessions/" + sid + "/messages", { text, ctx: [] }, tok);
    let tool = "none";
    for (let i = 0; i < 28; i++) { // CPU 推理延迟宽窗：最长 42s
      await sleep(1500);
      const rows2 = ledger();
      const mine = rows2.slice(before).filter((r) => r.status === "ok" || r.status === "denied_tenant");
      if (mine.length) { tool = mine[mine.length - 1].tool; break; }
    }
    const norm = (x) => (x === "null" ? "none" : x); // 闲聊期望归一：null≡none（未落任何工具）
    let pass;
    if (want === "null") pass = tool === "none"; // 闲聊不落任何工具
    else pass = tool === want || (tool === "none"); // LLM 直答也算未越界（不判错，只统计路由）
    results.push({ text, want: norm(want), tool, pass });
    process.stdout.write((pass ? "✓" : "✗") + " ");
  }
  console.log("\n");
  const n = results.length;
  const strictPass = results.filter((r) => (r.want === "none" ? r.tool === "none" : r.tool === r.want)).length;
  const safePass = results.filter((r) => r.pass).length;
  const byWant = {};
  results.forEach((r) => { byWant[r.want] = byWant[r.want] || [0, 0]; byWant[r.want][1]++; if (r.tool === r.want) byWant[r.want][0]++; });
  console.log("在线双跑报告（LLM 脸）——语料 " + n + " 条（只读面）");
  Object.keys(byWant).forEach((k) => console.log("  期望 " + k + ": " + byWant[k][0] + "/" + byWant[k][1]));
  console.log("  严格路由一致: " + strictPass + "/" + n);
  console.log("  安全执行（未越权落动作）: " + safePass + "/" + n);
  results.filter((r) => !r.pass).forEach((r) => console.log("  ✗ 「" + r.text + "」 want=" + r.want + " got=" + r.tool));
  const gotDist = {};
  results.forEach((r) => { gotDist[r.tool] = (gotDist[r.tool] || 0) + 1; });
  console.log("  实际路由分布: " + JSON.stringify(gotDist));
  console.log("(验收会话 " + sid + " 请在运维台或下次清账时移除；本脚本不自动删会话)");
})();
