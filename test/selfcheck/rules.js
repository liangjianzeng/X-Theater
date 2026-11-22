"use strict";
/**
 * test/selfcheck/rules.js —— rules 五库自查（纯函数，无 ctx 依赖）
 * 运行：node test/selfcheck/rules.js  → 全 PASS 则 exit 0。
 */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const RDIR = path.join(ROOT, "src", "server", "rules");
const langlint = require(path.join(RDIR, "langlint.js"));
const quant = require(path.join(RDIR, "quant.js"));
const license = require(path.join(RDIR, "license.js"));
const moderation = require(path.join(RDIR, "moderation.js"));
const budget = require(path.join(RDIR, "budget.js"));

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
const util = {
  hash12(obj) {
    const s = JSON.stringify(obj);
    return fnv1a(s) + fnv1a(s + "|x").slice(0, 4);
  }
};

const checks = [];
function t(name, fn) { checks.push({ name, fn }); }
function throwsQUANT(fn, substrs) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, "应 throw QUANT_RULE，实际未抛错");
  assert.strictEqual(err.code, "QUANT_RULE", "code 应为 QUANT_RULE，实得 " + err.code + "：" + err.message);
  for (const s of substrs) assert.ok(String(err.message).includes(s), "message 应含「" + s + "」，实得：" + err.message);
}

/* ---------------- langlint ---------------- */
t("langlint：FORBIDDEN 数组＝10 词＋模型名正则", () => {
  assert.ok(Array.isArray(langlint.FORBIDDEN));
  const words = ["take", "seed", "prompt", "i2v", "LoRA", "stale", "超分", "补帧", "路由", "worker"];
  for (const w of words) assert.ok(langlint.FORBIDDEN.includes(w), "FORBIDDEN 缺 " + w);
  assert.strictEqual(langlint.FORBIDDEN.filter((x) => x instanceof RegExp).length, 1, "模型名正则一项");
});

t("langlint：全部禁词命中（词＋模型名）", () => {
  const samples = [
    ["这条 take 不错", "take"], ["改 seed", "seed"], ["写 prompt", "prompt"],
    ["走 i2v", "i2v"], ["挂 LoRA", "LoRA"], ["标记 stale", "stale"],
    ["做超分", "超分"], ["加补帧", "补帧"], ["换路由", "路由"], ["起 worker", "worker"],
    ["qwen-image-2.1 出图", "qwen-image"], ["MiniMax-H3-Image", "MiniMax"],
    ["LTX-2.5 GGUF", "LTX-2\\.5"], ["FastH3 慢", "FastH3"], ["ACE-Step 1.5", "ACE-Step"],
    ["CosyVoice2 配音", "CosyVoice"], ["DeepSeek 峰谷", "DeepSeek"], ["SGLang 起", "SGLang"],
    ["ComfyUI :8188", "ComfyUI"], ["GGUF 量化", "GGUF"], ["nvfp4 档", "nvfp4"],
    ["int8 档", "int8"], ["MXFP8+FP8 兜底", "MXFP8"]
  ];
  for (const [text, needle] of samples) {
    const r = langlint.lint(text);
    assert.strictEqual(r.clean, false, "应命中: " + text);
    const joined = r.hits.map((h) => h.term).join("|");
    const probe = needle.includes("\\") ? "LTX-2.5" : needle;
    assert.ok(joined.toLowerCase().includes(probe.toLowerCase()), text + " 应命中 " + needle + "，实得 " + joined);
  }
});

t("langlint：正常文案不误伤（mistake≠take／prompts 命中）", () => {
  assert.strictEqual(langlint.lint("This is a mistake, not a snake.").clean, true);
  assert.strictEqual(langlint.lint("prompts 需要改写").clean, false, "复数 prompts 应命中");
  assert.strictEqual(langlint.lint(null).clean, true);
  assert.strictEqual(langlint.lint("").clean, true);
});

t("langlint：exempt 豁免面直 clean", () => {
  const r = langlint.lint("worker 路由到 ComfyUI，用 LTX-2.5 GGUF", { exempt: true });
  assert.strictEqual(r.clean, true);
  assert.deepStrictEqual(r.hits, []);
});

t("langlint：sanitize 全映射为人话且净化后 lint 必 clean", () => {
  const dirty = "take/seed/prompt/i2v/LoRA/stale/超分/补帧/路由/worker；" +
    "qwen-image、MiniMax、LTX-2.5、FastH3、ACE-Step、CosyVoice、DeepSeek、SGLang、ComfyUI、GGUF、nvfp4、int8、MXFP8";
  const clean = langlint.sanitize(dirty);
  assert.strictEqual(langlint.lint(clean).clean, true, "sanitize 后仍有禁词：" + clean);
  for (const w of ["take", "seed", "prompt", "i2v", "LoRA", "stale", "超分", "补帧", "路由", "worker", "GGUF", "nvfp4", "int8", "MXFP8", "MiniMax", "ComfyUI"]) {
    assert.ok(!clean.toLowerCase().includes(w.toLowerCase()), "替换里不应残留 " + w);
  }
  assert.ok(clean.includes("条"), "take→条");
  assert.ok(clean.includes("调度"), "路由→调度");
  assert.ok(clean.includes("画质增强"), "超分→画质增强");
  assert.ok(clean.includes("画面顺滑处理"), "补帧→画面顺滑处理");
  assert.ok(clean.includes("自部署档"), "模型名→自部署档");
});

/* ---------------- quant ---------------- */
const remoteEntry = { id: "MiniMax-H3-Image", model: "MiniMax-H3-Image", tiers: ["nvfp4", "int8", "MXFP8+FP8"], unavail: ["nvfp4", "int8"] };
const stdEntry = { id: "LTX-2.5", model: "LTX-2.5", tiers: ["nvfp4", "int8", "MXFP8+FP8"] };
const ggufEntry = { id: "LTX-2.5-GGUF", model: "LTX-2.5 GGUF", tiers: ["UD-Q4_K_XL"] };

t("quant：未发布档拦回＋复述硬规则", () => {
  throwsQUANT(() => quant.decide(remoteEntry, "nvfp4"), ["权重未发布：核实通过后才能切", "nvfp4→int8→MXFP8+FP8"]);
  throwsQUANT(() => quant.decide(remoteEntry, "int8"), ["权重未发布"]);
});

t("quant：兜底档需理由；带理由成功→audit_needed", () => {
  throwsQUANT(() => quant.decide(stdEntry, "MXFP8+FP8"), ["需理由"]);
  throwsQUANT(() => quant.decide(stdEntry, "MXFP8+FP8", "   "), ["需理由"]);
  const r = quant.decide(stdEntry, "MXFP8+FP8", "盲测打平，int8 权重待核实");
  assert.deepStrictEqual(r, { ok: true, audit_needed: true });
});

t("quant：正常档直通；规则外档位不可达", () => {
  assert.deepStrictEqual(quant.decide(stdEntry, "nvfp4"), { ok: true, audit_needed: false });
  assert.deepStrictEqual(quant.decide(stdEntry, "int8", null), { ok: true, audit_needed: false });
  throwsQUANT(() => quant.decide(stdEntry, "fp8"), ["不可达"]);
  throwsQUANT(() => quant.decide(stdEntry, "bf16"), ["不可达"]);
  throwsQUANT(() => quant.decide(stdEntry, ""), ["未知量化档"]);
  assert.deepStrictEqual(quant.decide(ggufEntry, "UD-Q4_K_XL"), { ok: true, audit_needed: false }, "GGUF 固定档直通");
  throwsQUANT(() => quant.decide(null, "nvfp4"), ["QUANT_RULE"]);
});

/* ---------------- license ---------------- */
t("license：双标记判定", () => {
  assert.deepStrictEqual(license.check({ id: "m", license: { model: "MIT", usage: "ok" } }), { ok: true, missing: [] });
  let r = license.check({ id: "m", license: { model: "MIT", usage: "missing" } });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.missing, ["license.usage"]);
  r = license.check({ id: "m", license: { usage: "ok" } });
  assert.ok(!r.ok && r.missing.includes("license.model"));
  r = license.check({ id: "m" });
  assert.ok(!r.ok && r.missing.length === 2);
  r = license.check(null);
  assert.ok(!r.ok && r.missing.includes("track"));
});

t("license：precheckMusic 逐场结果", () => {
  const lib = [
    { id: "m1", title: "码头暮色", license: { model: "MIT", usage: "ok" } },
    { id: "m2", title: "晚风（未许可 demo）", license: { model: "MIT", usage: "missing" } }
  ];
  const slots = [
    { sceneId: "sc1", trackId: "m1" },
    { sceneId: "sc2", trackId: "m2" },
    { sceneId: "sc3", trackId: "mX" },
    { sceneId: "sc4" }
  ];
  const rs = license.precheckMusic(slots, lib);
  assert.strictEqual(rs.length, 4);
  assert.deepStrictEqual(rs.map((r) => r.pass), [true, false, false, false]);
  assert.strictEqual(rs[1].title, "晚风（未许可 demo）");
  assert.ok(rs[2].note.includes("mX"));
  assert.ok(rs[3].note.includes("未挂曲"));
  // 内联 track（不查库）
  const rs2 = license.precheckMusic([{ sceneId: "s", track: { title: "t", license: { model: "MIT", usage: "ok" } } }], []);
  assert.strictEqual(rs2[0].pass, true);
});

/* ---------------- moderation ---------------- */
t("moderation：尾号 7 必拦＋黑名单＋普通镜过审（确定性）", () => {
  for (const id of ["shot7", "s07", "ep1_shot27", "7"]) {
    const r = moderation.inspect({ id, name: "夜雾" }, { util });
    assert.strictEqual(r.pass, false, id + " 应必拦");
    assert.strictEqual(r.reason, "复审：疑似元素");
    assert.ok(r.checks.includes("frame_tail7"));
  }
  const normalIds = ["shot1", "shot2", "shot3", "shot4", "shot5", "shot6", "shot8", "shot9"]
    .filter((id) => moderation.inspect({ id, name: "灯塔远望" }, { util }).pass);
  assert.ok(normalIds.length >= 3, "8 个普通 id 至少 3 个过审，实得 " + normalIds.length);
  const bl = moderation.inspect({ id: normalIds[0], name: "月台血腥对峙" }, { util });
  assert.strictEqual(bl.pass, false);
  assert.strictEqual(bl.reason, "复审：疑似元素");
  assert.ok(bl.checks[0].startsWith("blacklist"), "黑名单命中记 checks：" + JSON.stringify(bl.checks));
  // 确定性：同输入两跑一致
  assert.deepStrictEqual(moderation.inspect({ id: "shot7" }, { util }), moderation.inspect({ id: "shot7" }, { util }));
});

/* ---------------- budget ---------------- */
t("budget：>120% 拦截；等线放行；L2 线恒 8000", () => {
  assert.strictEqual(budget.guard({ budget_cents: 1000, cost_cents: 1100 }, 100).allow, true, "1200==上限放行");
  const blocked = budget.guard({ budget_cents: 1000, cost_cents: 1100 }, 101);
  assert.strictEqual(blocked.allow, false);
  assert.ok(blocked.reason.includes("120%"));
  assert.strictEqual(budget.guard({ budget_cents: 5000, cost_cents: 0 }, 4000).allow, true);
  assert.strictEqual(budget.guard(null, 10).allow, false);
  assert.strictEqual(budget.guard({ budget_cents: 1000 }, -5).allow, false);
  assert.strictEqual(budget.l2Line(), 8000);
  assert.strictEqual(budget.l2Line(123), 8000);
});

(async () => {
  let pass = 0;
  let fail = 0;
  for (const c of checks) {
    try {
      await c.fn();
      pass++;
      console.log("PASS  " + c.name);
    } catch (e) {
      fail++;
      console.log("FAIL  " + c.name + "  →  " + (e && e.message));
    }
  }
  console.log("------ rules selfcheck: " + pass + " pass / " + fail + " fail ------");
  process.exit(fail ? 1 : 0);
})();
