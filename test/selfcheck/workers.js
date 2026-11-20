"use strict";
/**
 * test/selfcheck/workers.js —— workers 模块自查（只测名下 worker＋rules；假 ctx 注入，不 require core/engine/api/l2）
 * 运行：node test/selfcheck/workers.js  → 全 PASS 则 exit 0。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const WDIR = path.join(ROOT, "src", "server", "dag", "workers");
const RDIR = path.join(ROOT, "src", "server", "rules");

const rules = {
  langlint: require(path.join(RDIR, "langlint.js")),
  quant: require(path.join(RDIR, "quant.js")),
  license: require(path.join(RDIR, "license.js")),
  moderation: require(path.join(RDIR, "moderation.js")),
  budget: require(path.join(RDIR, "budget.js"))
};
const WORKER_FILES = ["img5060.js", "imgspark.js", "video5060.js", "vidspark.js", "music.js", "tts.js", "compose.js", "moderate.js"];
const workers = {};
for (const f of WORKER_FILES) workers[f.replace(/\.js$/, "")] = require(path.join(WDIR, f));

/* ---------- 假 ctx ---------- */
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
  },
  uid(p) { return p + "_fixed"; },
  now() { return 1737331200000; }
};

function baseState() {
  return {
    episodes: { e1: { id: "e1", projectId: "p1", title: "夜航西飞·第1集", budget_cents: 5000, cost_cents: 0, stage: 5 } },
    scenes: {
      sc1: { id: "sc1", episodeId: "e1", name: "场1 重逢", mood: "释然", seq: 1 },
      sc2: { id: "sc2", episodeId: "e1", name: "场2 离别", mood: "离别", seq: 2 }
    },
    shots: {
      s1: { id: "s1", sceneId: "sc1", episodeId: "e1", seq: 2, name: "重逢路口", sec: 5, status: "done", takes: [{ id: "tk1", engine: "vid5060", cost_cents: 80, art: "var/out/tk1.mp4", license: { model: "MIT", usage: "ok" } }] },
      s2: { id: "s2", sceneId: "sc1", episodeId: "e1", seq: 1, name: "开场空镜", sec: 5, status: "done", takes: [{ id: "tk2", engine: "vid5060", cost_cents: 80, art: "var/out/tk2.mp4" }, { id: "tk2b", engine: "vidspark", cost_cents: 150, art: "var/out/tk2b.mp4" }] },
      s7: { id: "s7", sceneId: "sc2", episodeId: "e1", seq: 1, name: "月台雾", sec: 5, status: "pending_review", takes: [] },
      s3: { id: "s3", sceneId: "sc2", episodeId: "e1", seq: 2, name: "汽笛长鸣", sec: 5, status: "done", takes: [{ id: "tk3", engine: "vid5060", cost_cents: 80, art: "var/out/tk3.mp4" }] }
    },
    music_lib: [
      { id: "m1", title: "码头暮色", mood: "离别", sec: 42, engine: "music", license: { model: "MIT", usage: "ok" }, shadow_cents: 10, sceneId: "sc2" },
      { id: "m2", title: "晚风（未许可 demo）", mood: "释然", sec: 35, engine: "music", license: { model: "MIT", usage: "missing" }, shadow_cents: 8, sceneId: "sc1" }
    ],
    settings: {
      registry: {
        img5060: { id: "img5060", model: "qwen-image-2.1-turbo-Q5_K_M", tiers: ["nvfp4", "int8", "MXFP8+FP8"] },
        imgspark: { id: "imgspark", model: "MiniMax-H3-Image", tiers: ["nvfp4", "int8", "MXFP8+FP8"], unavail: ["nvfp4", "int8"], tier: "MXFP8+FP8" },
        vid5060: { id: "vid5060", model: "LTX-2.5 distilled GGUF UD-Q4_K_XL", tier: "UD-Q4_K_XL", tiers: ["nvfp4", "int8", "MXFP8+FP8"] },
        vidspark: { id: "vidspark", model: "FastH3 nvfp4", tier: "nvfp4", tiers: ["nvfp4", "int8", "MXFP8+FP8"] }
      },
      runtime_mode: "A",
      peak_valley: true,
      moderation_pass: true
    },
    review_q: [],
    alerts: []
  };
}
function makeCtx(state) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "xth-wo-"));
  const logs = [];
  const store = {
    _state: state,
    get() { return this._state; },
    commit() {},
    log(kind, obj) { logs.push(Object.assign({ kind }, obj)); return obj; },
    readLog() { return logs; }
  };
  return { store, bus: null, engine: null, util, cfg: { outDir }, rules, logs };
}
function physical(ctx, art) { return path.join(ctx.cfg.outDir, path.basename(art)); }
function readSidecar(ctx, art) {
  const fp = physical(ctx, art) + ".meta.json";
  assert.ok(fs.existsSync(fp), "sidecar 缺失: " + fp);
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

/* ---------- 用例 ---------- */
const checks = [];
function t(name, fn) { checks.push({ name, fn }); }

t("shape: {name,lane,run} 且 lane 对齐 engine ALL_LANES", () => {
  // engine TYPE_LANE/ALL_LANES 口径：文件名 video5060.js → lane "vid5060"，其余同名
  const EXPECTED = {
    img5060: "img5060", imgspark: "imgspark", video5060: "vid5060", vidspark: "vidspark",
    music: "music", tts: "tts", compose: "compose", moderate: "moderate"
  };
  for (const f of WORKER_FILES) {
    const base = f.replace(/\.js$/, "");
    const w = workers[base];
    assert.strictEqual(w.lane, EXPECTED[base], base + " lane");
    assert.strictEqual(w.name, EXPECTED[base], base + " name");
    assert.strictEqual(typeof w.run, "function", base + " run");
  }
});

t("img5060：c1plan 出图占位＋3–8 分＋四元组 meta", async () => {
  const ctx = makeCtx(baseState());
  const job = { id: "job_img1", type: "c1plan", lane: "img5060", payload: { episodeId: "e1" } };
  const r = await workers.img5060.run(job, ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(r.cents >= 3 && r.cents <= 8, "cents 3–8，实得 " + r.cents);
  assert.strictEqual(r.art, "var/out/job_img1.png");
  const png = physical(ctx, r.art);
  assert.ok(fs.existsSync(png), "png 未写出");
  const meta = readSidecar(ctx, r.art);
  for (const k of ["seed", "tmpl_hash", "comfy_commit", "cn_commit", "weights"]) assert.ok(meta[k], "meta." + k);
  assert.strictEqual(meta.weights, "Q5_K_M");
  assert.ok(job.art && job.result, "job.art/result 回写");
});

t("imgspark：15–25 分＋MXFP8+FP8 权重", async () => {
  const ctx = makeCtx(baseState());
  const job = { id: "job_img2", type: "img_spark", lane: "imgspark", payload: { episodeId: "e1" } };
  const r = await workers.imgspark.run(job, ctx);
  assert.ok(r.cents >= 15 && r.cents <= 25, "cents 15–25，实得 " + r.cents);
  assert.strictEqual(r.art, "var/out/job_img2.png");
  assert.strictEqual(readSidecar(ctx, r.art).weights, "MXFP8+FP8");
});

t("img5060 确定性：同输入两跑＝同分同种子同字节", async () => {
  const a = makeCtx(baseState());
  const b = makeCtx(baseState());
  const mk = () => ({ id: "job_imgD", type: "storyboard", lane: "img5060", payload: { episodeId: "e1" } });
  const r1 = await workers.img5060.run(mk(), a);
  const r2 = await workers.img5060.run(mk(), b);
  assert.strictEqual(r1.cents, r2.cents);
  assert.strictEqual(r1.meta.seed, r2.meta.seed);
  assert.deepStrictEqual(fs.readFileSync(physical(a, r1.art)), fs.readFileSync(physical(b, r2.art)));
});

t("video5060：80 分/镜＋take 回写＋meta{sec,tier,engine,peak_valley}", async () => {
  const ctx = makeCtx(baseState());
  const job = { id: "job_v1", type: "video", lane: "vid5060", payload: { shotId: "s1", takeId: "tk_demo1", episodeId: "e1" } };
  const r = await workers.video5060.run(job, ctx);
  assert.strictEqual(r.cents, 80);
  assert.strictEqual(r.art, "var/out/tk_demo1.mp4");
  assert.ok(fs.existsSync(physical(ctx, r.art)));
  const meta = readSidecar(ctx, r.art);
  assert.strictEqual(meta.sec, 5);
  assert.strictEqual(meta.tier, "UD-Q4_K_XL");
  assert.ok(/LTX/.test(meta.engine));
  assert.strictEqual(meta.peak_valley, false);
  assert.ok(job.art && job.art.take, "job.art.take 回写（onVideoDone 消费面）");
  assert.strictEqual(job.art.take.id, "tk_demo1");
  assert.strictEqual(job.art.take.cost_cents, 80);
  assert.strictEqual(job.art.take.license.usage, "ok");
});

t("vidspark：150 分＋peak_valley 慢档（固定延迟≥120ms）", async () => {
  const st = baseState(); // settings.peak_valley=true
  const ctx = makeCtx(st);
  const job = { id: "job_v2", type: "video", lane: "vidspark", payload: { shotId: "s2", takeId: "tk_pv1", episodeId: "e1", tier: "high" } };
  const t0 = Date.now();
  const r = await workers.vidspark.run(job, ctx);
  const el = Date.now() - t0;
  assert.strictEqual(r.cents, 150);
  assert.ok(el >= 120, "慢档延迟应≥120ms，实得 " + el);
  assert.ok(el < 500, "慢档延迟必须 <300ms 量级，实得 " + el);
  const meta = readSidecar(ctx, r.art);
  assert.strictEqual(meta.peak_valley, true);
  assert.strictEqual(meta.engine, "FastH3 nvfp4");
  assert.strictEqual(meta.tier, "nvfp4");
  assert.strictEqual(job.art.take.cost_cents, 150);
});

t("vidspark：peak_valley=false 时不排队（快跑）", async () => {
  const st = baseState();
  st.settings.peak_valley = false;
  const ctx = makeCtx(st);
  const job = { id: "job_v3", type: "video", lane: "vidspark", payload: { shotId: "s3", episodeId: "e1" } };
  const t0 = Date.now();
  const r = await workers.vidspark.run(job, ctx);
  const el = Date.now() - t0;
  assert.ok(el < 100, "非慢档应 <100ms，实得 " + el);
  assert.strictEqual(readSidecar(ctx, r.art).peak_valley, false);
  assert.ok(/\.mp4$/.test(r.art), "缺省 takeId 也要产 mp4 占位");
});

t("music：3 候选三标题规则＋usage/许可＋5–15 分/条", async () => {
  const ctx = makeCtx(baseState());
  const job = { id: "job_m1", type: "music", lane: "music", payload: { sceneId: "sc2", mood: "离别", episodeId: "e1" } };
  const r = await workers.music.run(job, ctx);
  const cands = job.result && job.result.candidates;
  assert.ok(Array.isArray(cands) && cands.length === 3, "job.result.candidates 必须 3 条");
  assert.deepStrictEqual(cands.map((c) => c.title), ["码头暮色", "码头暮色 · 变奏", "码头暮色（未许可 demo）"]);
  assert.ok(cands[2].title.includes("未许可"), "第 3 条固定带「未许可」");
  assert.deepStrictEqual(cands.map((c) => c.license.usage), ["ok", "ok", "missing"]);
  assert.deepStrictEqual(cands.map((c) => c.license.model), ["MIT", "MIT", "MIT"]);
  let sum = 0;
  for (const c of cands) {
    assert.ok(c.shadow_cents >= 5 && c.shadow_cents <= 15, "候选影子费 5–15，实得 " + c.shadow_cents);
    assert.ok(c.sec >= 30 && c.sec <= 60, "sec 30–60，实得 " + c.sec);
    assert.ok(fs.existsSync(c.art_abs), "候选 mp3 未写出");
    sum += c.shadow_cents;
  }
  assert.strictEqual(r.cents, sum);
  // rules.license 交叉断言：前二过、第三拦
  assert.strictEqual(rules.license.check(cands[0]).ok, true);
  const bad = rules.license.check(cands[2]);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.missing.includes("license.usage"));
});

t("music：mood 词库映射（释然→晚风系／压抑→汽笛系）＋确定性两跑一致", async () => {
  const mkJob = (mood) => ({ id: "job_mood", type: "music", lane: "music", payload: { sceneId: "sc1", mood, episodeId: "e1" } });
  const a = makeCtx(baseState());
  const b = makeCtx(baseState());
  const jobA = mkJob("释然");
  const jobB = mkJob("释然");
  const r1 = await workers.music.run(jobA, a);
  await workers.music.run(jobB, b);
  assert.ok(r1.meta.candidates.every((c) => c.title.startsWith("晚风")), "释然→晚风系");
  const c = makeCtx(baseState());
  const jobC = mkJob("压抑");
  await workers.music.run(jobC, c);
  assert.ok(jobC.result.candidates.every((x) => x.title.startsWith("汽笛")), "压抑→汽笛系");
  const strip = (cs) => cs.map((x) => ({ id: x.id, title: x.title, sec: x.sec, cents: x.shadow_cents, usage: x.license.usage }));
  assert.deepStrictEqual(strip(jobA.result.candidates), strip(jobB.result.candidates), "同输入两跑候选必须一致");
});

t("tts：.mp3 占位＋meta＋小额确定性成本", async () => {
  const ctx = makeCtx(baseState());
  const job = { id: "job_vo1", type: "voice", lane: "tts", payload: { shotId: "s1", text: "这是夜航西飞的台词", episodeId: "e1" } };
  const r = await workers.tts.run(job, ctx);
  assert.strictEqual(r.art, "var/out/job_vo1.mp3");
  assert.ok(fs.existsSync(physical(ctx, r.art)));
  assert.ok(r.cents >= 2 && r.cents <= 6, "tts 2–6 分，实得 " + r.cents);
  const meta = readSidecar(ctx, r.art);
  assert.strictEqual(meta.engine, "CosyVoice2");
  assert.ok(meta.text_hash);
});

t("compose：final.mp4＋sidecar 必含标识/水印/挂曲 license 快照/规格", async () => {
  const ctx = makeCtx(baseState());
  const job = { id: "job_c1", type: "compose", lane: "compose", episodeId: "e1", payload: { episodeId: "e1", purpose: "export" } };
  const r = await workers.compose.run(job, ctx);
  assert.strictEqual(r.art, "var/out/e1_final.mp4");
  assert.ok(fs.existsSync(physical(ctx, r.art)));
  const meta = readSidecar(ctx, r.art);
  assert.strictEqual(meta.explicit_mark, true, "explicit_mark");
  assert.strictEqual(meta.implicit_mark, true, "implicit_mark");
  assert.strictEqual(meta.watermark, "内测水印");
  assert.strictEqual(meta.resolution, "1080x1920");
  assert.strictEqual(meta.fps, 30);
  assert.strictEqual(meta.takes, 4, "全镜 takes 汇总");
  assert.strictEqual(meta.take_files.length, 4);
  assert.deepStrictEqual(meta.shots.map((s) => s.id), ["s2", "s1", "s7", "s3"], "排序＝场景 seq→镜 seq");
  assert.strictEqual(meta.music.length, 2);
  const byScene = {};
  for (const m of meta.music) byScene[m.sceneId] = m;
  assert.strictEqual(byScene.sc1.title, "晚风（未许可 demo）");
  assert.strictEqual(byScene.sc1.license.usage, "missing", "挂曲 license 快照须反映 usage=missing");
  assert.strictEqual(byScene.sc2.license.usage, "ok");
  assert.strictEqual(job.art.art, r.art, "audit artifacts 取 job.art.art");
});

t("moderate：#7 必拦＋inspect 回写＋review reason", async () => {
  const ctx = makeCtx(baseState());
  const job = { id: "job_md1", type: "moderate", lane: "moderate", payload: { shotId: "s7", episodeId: "e1" } };
  const r = await workers.moderate.run(job, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cents, 1);
  assert.strictEqual(job.art.pass, false);
  assert.strictEqual(job.art.verdict, "fail_review");
  assert.strictEqual(job.art.reason, "复审：疑似元素");
  assert.ok((job.art.checks || []).includes("frame_tail7"), "尾号 7 → frame_tail7");
});

t("moderate：普通镜过审＋无此镜抛 NOT_FOUND", async () => {
  const st = baseState();
  const passIds = ["shot1", "shot2", "shot3", "shot4", "shot5", "shot6", "shot8", "shot9"]
    .filter((id) => rules.moderation.inspect({ id }, ctxProbe()).pass);
  assert.ok(passIds.length >= 3, "确定性哈希下 8 个普通 id 应至少 3 个过审，实得 " + passIds.length);
  st.shots[passIds[0]] = { id: passIds[0], sceneId: "sc1", episodeId: "e1", seq: 9, name: "灯塔远望", takes: [] };
  const ctx = makeCtx(st);
  const job = { id: "job_md2", type: "moderate", lane: "moderate", payload: { shotId: passIds[0], episodeId: "e1" } };
  await workers.moderate.run(job, ctx);
  assert.strictEqual(job.art.pass, true);
  assert.strictEqual(job.art.verdict, "pass");
  const ctx2 = makeCtx(baseState());
  let code = null;
  try {
    await workers.moderate.run({ id: "x", type: "moderate", payload: { shotId: "nope" } }, ctx2);
  } catch (e) { code = e.code; }
  assert.strictEqual(code, "NOT_FOUND");
});
function ctxProbe() { return { util, store: null }; }

t("卫生：无 Math.random／require 白名单（fs/path/名下 rules）", () => {
  const ALLOW = /^(fs|path|\.\.\/rules\/[a-z0-9]+)$/;
  for (const f of WORKER_FILES) {
    const raw = fs.readFileSync(path.join(WDIR, f), "utf8");
    // 去注释后扫描（注释里允许出现术语本身）
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(!/Math\.random/.test(src), f + " 代码含 Math.random");
    const re = /require\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      assert.ok(ALLOW.test(m[1]), f + " 非法依赖: " + m[1]);
    }
  }
});

/* ---------- 跑批 ---------- */
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
  console.log("------ workers selfcheck: " + pass + " pass / " + fail + " fail ------");
  process.exit(fail ? 1 : 0);
})();
