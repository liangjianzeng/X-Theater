"use strict";
/**
 * test/selfcheck/api.js — api 层自查（契约 §9：只测自己模块，假依赖注入 stub ctx）
 *
 * 不起真 core：内存 store / fake bus{publish,on 收集,attach} / fake engine（记录 enqueue，
 * 可手动 emitDone 推进链式派生并落 billing 影子账）/ rules 真 require src/server/rules
 * （逐库冒烟：不符合契约语义的库回退为按 §4 语义实现的 stub）/ l2 stub。
 * 假 router 收集 add 的 handler，逐端点直调；throw {code} → 按 core 约定映射 HTTP 码。
 *
 * 运行：node test/selfcheck/api.js → 全绿 exit 0，否则 exit 1。
 */

const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..", "..");
const API_DIR = path.join(ROOT, "src", "server", "api");

/* ============================ 断言器 ============================ */
let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  PASS  " + name);
  } else {
    failed++;
    failures.push(name + (detail ? " :: " + JSON.stringify(detail).slice(0, 400) : ""));
    console.log("  FAIL  " + name + (detail ? " :: " + JSON.stringify(detail).slice(0, 400) : ""));
  }
}
function section(t) {
  console.log("\n== " + t + " ==");
}

/* ============================ fake util ============================ */
let idCounter = 0;
let nowMs = 1730000000000;
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const util = {
  uid(pfx) {
    idCounter++;
    return (pfx || "id") + "_x" + idCounter.toString(36);
  },
  hash12(obj) {
    return crypto.createHash("sha256").update(stableStringify(obj)).digest("hex").slice(0, 12);
  },
  now() {
    nowMs++;
    return nowMs;
  },
  sign(obj) {
    return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url") + ".fakesig";
  },
  verify(token) {
    try {
      return JSON.parse(Buffer.from(String(token).split(".")[0], "base64url").toString("utf8"));
    } catch (e) {
      return null;
    }
  },
  cas(entity, ver) {
    if (!entity || entity.ver !== ver) throw { code: "STALE", message: "上下文已变" };
  }
};

/* ============================ 种子（契约 §8） ============================ */
function createSeed() {
  const scenes = {};
  const shots = {};
  const sceneDefs = [
    { id: "s1", name: "场1·重逢", mood: "释然" },
    { id: "s2", name: "场2·离别", mood: "离别" },
    { id: "s3", name: "场3·对峙", mood: "压抑" },
    { id: "s4", name: "场4·灯塔", mood: "释然" }
  ];
  sceneDefs.forEach((sd, i) => {
    scenes[sd.id] = { id: sd.id, episodeId: "e1", name: sd.name, mood: sd.mood, seq: i + 1 };
    for (let j = 1; j <= 4; j++) {
      const id = "sh" + (i * 4 + j);
      shots[id] = {
        id,
        sceneId: sd.id,
        episodeId: "e1",
        seq: (i + 1) * 100 + j,
        name: "PROTO-" + sd.name + "-镜" + j,
        sec: 5,
        status: id === "sh7" ? "pending_review" : "ok",
        takes: [{ id: "tk_seed_" + id, engine: "LTX-2.5", cost_cents: 80, art: "var/out/seed_" + id + ".mp4", license: { model: "MIT", usage: "ok" } }],
        rerolls: 0,
        flags: { stale: false }
      };
    }
  });
  return {
    users: {
      u1: { id: "u1", name: "导演", role: "ops" },
      u2: { id: "u2", name: "创作者", role: "creator" }
    },
    invites: ["INV-DEMO-1"],
    projects: { p1: { id: "p1", title: "夜航西飞", style_pkg: "PROTO", music_enabled: true } },
    episodes: {
      e1: {
        id: "e1",
        projectId: "p1",
        title: "第1集·夜航西飞",
        brief: "非洲夜空下的重逢与离别",
        stage: 8,
        decisions: 8,
        budget_cents: 5000,
        cost_cents: 0,
        paused: false,
        estimate_ver: "e1estseed001",
        shoot_confirmed_ver: "e1estseed001",
        est: { time_min: 24, cents: 1720, shots: 16 }
      }
    },
    scenes,
    shots,
    cards: {},
    music_lib: [
      {
        id: "mus_seed",
        title: "未许可演示曲",
        mood: "释然",
        sec: 45,
        engine: "ACE-Step 1.5",
        license: { model: "MIT", usage: "missing" },
        shadow_cents: 10,
        sceneId: "s1"
      }
    ],
    review_q: [
      { id: "rq1", shotId: "sh7", reason: "演示复审项（抽帧尾号 7）", status: "pending", sla_left: 86400, ver: 1 }
    ],
    alerts: [],
    l2_sessions: {},
    settings: {
      registry: {
        img5060: { tier: "MXFP8+FP8", endpoint: "http://w-b:8188", model: "qwen-image-2.1-turbo-Q5_K_M" },
        imgspark: { tier: "MXFP8+FP8", unavail: ["nvfp4", "int8"], model: "MiniMax-H3-Image" },
        vid5060: { tier: "UD-Q4_K_XL", model: "LTX-2.5" },
        vidspark: { tier: "nvfp4", model: "FastH3" },
        music: { tier: "fp16", endpoint: "http://w-m:8190", model: "ACE-Step 1.5" },
        tts: { tier: "fp16", model: "CosyVoice2" },
        compose: { tier: "cpu", model: "FFmpeg-stub" },
        moderate: { tier: "rules", model: "rules+frames-stub" }
      },
      runtime_mode: "A",
      peak_valley: true,
      moderation_pass: true
    },
    music_pending: {}
  };
}

const state = createSeed();
const ledgers = { job: [], billing: [], audit: [], agentrun: [] };
let logId = 0;
const store = {
  get() {
    return state;
  },
  commit() {
    state._commits = (state._commits || 0) + 1;
  },
  log(kind, obj) {
    const row = Object.assign({}, obj, { ts: util.now(), id: kind + "_" + ++logId });
    (ledgers[kind] = ledgers[kind] || []).push(row);
    return row;
  },
  readLog(kind) {
    return (ledgers[kind] || []).slice();
  }
};

/* ============================ fake bus（on/off/publish/attach） ============================ */
const bus = {
  subs: {},
  events: [],
  attached: [],
  publish(topic, obj) {
    this.events.push({ topic, obj });
    (this.subs[topic] || []).slice().forEach((f) => f(obj));
  },
  on(topic, fn) {
    (this.subs[topic] = this.subs[topic] || []).push(fn);
  },
  off(topic, fn) {
    this.subs[topic] = (this.subs[topic] || []).filter((x) => x !== fn);
  },
  attach(res, opts) {
    res.sse = true;
    this.attached.push({ res, opts: opts || null });
  }
};

/* ============================ fake engine（stub 引擎语义） ============================ */
const COSTS = { c1plan: 5, storyboard: 5, video: 80, moderate: 1, music: 10, voice: 5, compose: 12 };
const engine = {
  jobs: [],
  enqueue(type, payload, opts) {
    const job = { id: util.uid("job"), type, payload: payload || {}, opts: opts || {}, status: "queued", ver: 1, ts: util.now() };
    this.jobs.push(job);
    store.log("job", Object.assign({}, job, { worker_type: "self-host-stub", initiated_by: (opts && opts.initiated_by) || "user" }));
    return job;
  },
  find(id) {
    return this.jobs.filter((j) => j.id === id)[0] || null;
  },
  retry(id) {
    const j = this.find(id);
    if (!j) throw { code: "NOT_FOUND", message: "任务不存在" };
    j.status = "queued";
    j.rerolls = (j.rerolls || 0) + 1;
    return j;
  },
  stop(id) {
    const j = this.find(id);
    if (!j) throw { code: "NOT_FOUND", message: "任务不存在" };
    j.status = "stopped";
    return j;
  },
  queueState() {
    return this.jobs.slice();
  },
  emitDone(idOrJob, artOverride) {
    const j = typeof idOrJob === "string" ? this.find(idOrJob) : idOrJob;
    if (!j) return null;
    j.status = "done";
    j.art = artOverride !== undefined ? artOverride : synthArt(j);
    const eid = (j.opts && j.opts.episodeId) || (j.payload && j.payload.episodeId);
    if (eid) {
      store.log("billing", {
        episodeId: eid,
        shotId: (j.payload && j.payload.shotId) || null,
        kind: j.type,
        cents: COSTS[j.type] || 0,
        ts: util.now()
      });
    }
    bus.publish("jobs", { event: "done", job: j }); // 契约 §2：done 时 publish("jobs",{event:"done",job})
    return j;
  }
};
function synthArt(job) {
  const p = job.payload || {};
  switch (job.type) {
    case "c1plan":
      return {
        plan: {
          summary: "故事策划（stub）",
          scenes: [
            { name: "场1·重逢", mood: "释然" },
            { name: "场2·离别", mood: "离别" },
            { name: "场3·对峙", mood: "压抑" },
            { name: "场4·灯塔", mood: "释然" }
          ]
        }
      };
    case "storyboard":
      return { images: [] }; // casting 缺失 → cards.js 合成 4 候选 stub（任务书要求）
    case "video":
      return {
        art: "var/out/take_" + p.shotId + ".mp4",
        cost_cents: 80,
        engine: "LTX-2.5 UD-Q4_K_XL",
        license: { model: "MIT", usage: "ok" }
      };
    case "moderate":
      // 契约 §4：shotId 尾号 7 → 必送复审
      return String(p.shotId || "").endsWith("7")
        ? { verdict: "fail_review", reason: "抽帧尾号 7 → 必送复审（V6 演示路径）" }
        : { verdict: "pass" };
    case "compose":
      return p.purpose === "export"
        ? { art: "var/out/ep_" + p.episodeId + "_final.mp4", explicit_mark: true, implicit_mark: true }
        : { art: "var/out/ep_" + p.episodeId + "_preview.mp4" };
    case "voice":
      return { art: "var/out/vo_" + (p.sceneId || "x") + ".mp3" };
    case "music":
      return {}; // candidates 缺失 → cards.js 合成 3 条（首条“未许可”，契约 §8 语义）
    default:
      return {};
  }
}

/* ============================ rules：真 require ＋逐库冒烟回退 ============================ */
function stubRules() {
  const BANNED = ["take", "seed", "prompt", "i2v", "lora", "stale", "超分", "补帧", "路由", "worker", "模型名"];
  const ORDER = ["nvfp4", "int8", "MXFP8+FP8"];
  return {
    langlint: {
      lint(text, opts) {
        if (opts && opts.exempt) return { clean: true, hits: [] };
        const t = String(text == null ? "" : text).toLowerCase();
        const hits = BANNED.filter((w) => t.indexOf(w) >= 0);
        return { clean: hits.length === 0, hits };
      },
      sanitize(text) {
        const r = this.lint(text, { exempt: false });
        let out = String(text == null ? "" : text);
        r.hits.forEach((w) => {
          out = out.split(w).join("语言表层文案").split(w.toUpperCase()).join("语言表层文案");
        });
        return { text: out, clean: r.clean, hits: r.hits };
      }
    },
    quant: {
      // 主形态与 rules/quant.js 对齐：decide(registryEntry, tier, reason) → {ok,audit_needed}
      decide(entry, tier, reason) {
        const e = entry || {};
        const tiers = Array.isArray(e.tiers) && e.tiers.length ? e.tiers : ORDER;
        if (!tiers.map(String).some((t) => t.toLowerCase() === String(tier).toLowerCase())) {
          throw { code: "QUANT_RULE", message: "QUANT_RULE：未知量化档「" + tier + "」硬规则序 nvfp4→int8→MXFP8+FP8" };
        }
        if (Array.isArray(e.unavail) && e.unavail.some((u) => String(u).toLowerCase() === String(tier).toLowerCase())) {
          throw { code: "QUANT_RULE", message: "QUANT_RULE：权重未发布（" + tier + " 未发布档须弹回，硬规则序 nvfp4→int8→MXFP8+FP8）" };
        }
        if (String(tier).toLowerCase() === ORDER[ORDER.length - 1]) {
          if (!String(reason || "").trim()) throw { code: "QUANT_RULE", message: "QUANT_RULE：兜底档（MXFP8+FP8）必须附理由（需理由）" };
          return { ok: true, audit_needed: true };
        }
        return { ok: true, audit_needed: false };
      }
    },
    license: {
      // 主形态与 rules/license.js 对齐：precheckMusic(sceneSlots, lib) → 逐场结果数组
      precheckMusic(slots, lib) {
        return (slots || []).map((s) => {
          const t = (s && s.track) || (Array.isArray(lib) ? lib.filter((m) => m.id === (s && s.trackId))[0] : null);
          const ok = !!(t && t.license && t.license.model && t.license.usage === "ok");
          return {
            sceneId: s && s.sceneId,
            trackId: s && s.trackId,
            title: t && t.title,
            pass: ok,
            missing: ok ? [] : ["license.usage"],
            note: ok ? null : "配乐许可不完整：引用曲 usage 必须为 ok"
          };
        });
      }
    },
    moderation: {
      check(text) {
        const hits = BANNED.filter((w) => String(text || "").toLowerCase().indexOf(w) >= 0);
        return { pass: hits.length === 0, verdict: hits.length ? "fail_review" : "pass", hits };
      }
    },
    budget: {
      check(used, budget) {
        return used <= (budget || 0) * 1.2;
      }
    }
  };
}

function loadRules() {
  const stub = stubRules();
  let real = null;
  const srcs = [];
  try {
    real = require(path.join(ROOT, "src", "server", "rules"));
    srcs.push("index");
  } catch (e) {
    try {
      const dir = path.join(ROOT, "src", "server", "rules");
      real = {
        langlint: require(path.join(dir, "langlint")),
        quant: require(path.join(dir, "quant")),
        license: require(path.join(dir, "license")),
        moderation: require(path.join(dir, "moderation")),
        budget: require(path.join(dir, "budget"))
      };
      srcs.push("files");
    } catch (e2) {
      real = null;
    }
  }
  const out = {};
  const used = {};
  // langlint 冒烟：sanitize 命中替换
  const langOk =
    real &&
    real.langlint &&
    (typeof real.langlint.sanitize === "function"
      ? (function () {
          const r = real.langlint.sanitize("请把 prompt 写清楚");
          if (typeof r === "string") return r.indexOf("prompt") < 0;
          return !!(r && ((r.hits && r.hits.length) || (typeof r.text === "string" && r.text.indexOf("prompt") < 0)));
        })()
      : typeof real.langlint.lint === "function");
  out.langlint = langOk ? real.langlint : stub.langlint;
  used.langlint = langOk ? "real(" + srcs.join("+") + ")" : "stub";
  // quant 冒烟（与 rules/quant.js 主形态 decide(entry,tier,reason) 对齐）：unavail 弹回＋兜底档需理由
  let quantOk = false;
  try {
    if (real && real.quant && typeof real.quant.decide === "function") {
      let threw1 = false;
      let threw2 = false;
      try {
        real.quant.decide({ id: "x", unavail: ["nvfp4"] }, "nvfp4", "");
      } catch (e) {
        threw1 = !!(e && e.code === "QUANT_RULE");
      }
      try {
        real.quant.decide({ id: "x" }, "MXFP8+FP8");
      } catch (e) {
        threw2 = !!(e && e.code === "QUANT_RULE");
      }
      let ok3 = false;
      try {
        const r = real.quant.decide({ id: "x" }, "MXFP8+FP8", "测试理由");
        ok3 = !!r && (r.ok === undefined || r.ok === true) && r.audit_needed !== false;
      } catch (e) {
        ok3 = false;
      }
      quantOk = threw1 && threw2 && ok3;
    }
  } catch (e) {
    quantOk = false;
  }
  out.quant = quantOk ? real.quant : stub.quant;
  used.quant = quantOk ? "real(" + srcs.join("+") + ")" : "stub";
  // license 冒烟（与 rules/license.js 主形态 precheckMusic(slots,lib) 对齐）：usage missing → fail
  let licOk = false;
  try {
    if (real && real.license && typeof real.license.precheckMusic === "function") {
      const r = real.license.precheckMusic(
        [{ sceneId: "s1", trackId: "m1", track: { id: "m1", title: "t", license: { model: "MIT", usage: "missing" } } }],
        []
      );
      licOk = Array.isArray(r) ? r.length > 0 && r.some((x) => !x || x.pass !== true) : r === false || (r && r.pass === false);
    }
  } catch (e) {
    licOk = false;
  }
  out.license = licOk ? real.license : stub.license;
  used.license = licOk ? "real(" + srcs.join("+") + ")" : "stub";
  out.moderation = (real && real.moderation) || stub.moderation;
  out.budget = (real && real.budget) || stub.budget;
  used.moderation = real && real.moderation ? "real" : "stub";
  used.budget = real && real.budget ? "real" : "stub";
  console.log("rules 来源: " + JSON.stringify(used));
  return out;
}

const rules = loadRules();
const l2 = {
  createSession() {
    return null;
  },
  postMessage() {},
  decideApproval() {},
  getSessions() {
    return [];
  }
};
const cfg = { port: 8766, varDir: "var" };
const ctx = { store, bus, engine, rules, l2, util, cfg };

/* ============================ 假 router ＋ 调用器 ============================ */
const routes = [];
const router = {
  add(method, p, handler, opts) {
    routes.push({ method: method.toUpperCase(), path: p, segs: p.split("/"), handler, opts: opts || {} });
  },
  useAuth() {},
  json(res, code, obj) {
    res.statusCode = code;
    res.body = obj;
    return res;
  }
};

const STATUS_MAP = {
  STALE: 409,
  FORBIDDEN: 403,
  CONFIRM_REQ: 428,
  BLOCKED_PRECHECK: 422,
  QUANT_RULE: 409,
  NOT_READY: 409,
  ALREADY_DECIDED: 409,
  INVALID_CODE: 403,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  BAD_ACTION: 400,
  BUDGET: 402
};

function matchRoute(route, segs) {
  if (route.segs.length !== segs.length) return null;
  const params = {};
  for (let i = 0; i < segs.length; i++) {
    const rs = route.segs[i];
    if (rs.startsWith(":")) params[rs.slice(1)] = decodeURIComponent(segs[i]);
    else if (rs !== segs[i]) return null;
  }
  return params;
}

function invoke(method, url, body, auth) {
  const parts = url.split("?");
  const segs = parts[0].split("/");
  const cands = [];
  routes.forEach((r) => {
    if (r.method !== method.toUpperCase()) return;
    const params = matchRoute(r, segs);
    if (params) cands.push({ r, params, dyn: r.segs.filter((s) => s.startsWith(":")).length });
  });
  if (!cands.length) {
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "无此路由 " + method + " " + url } } };
  }
  cands.sort((a, b) => a.dyn - b.dyn); // 静态段优先
  const { r, params } = cands[0];
  const req = { url, method, headers: {} };
  const res = { statusCode: 200, body: null };
  try {
    r.handler(req, res, body || {}, params, auth);
  } catch (e) {
    const code = (e && e.code) || "INTERNAL";
    const status = typeof e.status === "number" ? e.status : STATUS_MAP[code] || 500;
    const err = { code, message: e.message || code };
    Object.keys(e || {}).forEach((k) => {
      if (["code", "message", "status"].indexOf(k) < 0) err[k] = e[k]; // 透传 missing 等扩展字段
    });
    return { status, body: { error: err } };
  }
  return { status: res.statusCode, body: res.body };
}

/* 注册全部 api 模块 */
["auth", "state", "episodes", "cards", "jobs", "costs", "deliver", "music", "review", "admin", "events"].forEach((n) => {
  require(path.join(API_DIR, n)).register(router, ctx);
});

const OPS = { uid: "u1", id: "u1", role: "ops" };
const CREATOR = { uid: "u2", id: "u2", role: "creator" };

/* ============================ 工具 ============================ */
function cardsFor(episodeId, status) {
  const url = "/api/cards?episodeId=" + episodeId + (status ? "&status=" + status : "");
  return invoke("GET", url, null, OPS).body.cards || [];
}
function findCard(episodeId, type, status) {
  return cardsFor(episodeId, status).filter((c) => c.type === type)[0] || null;
}
function jobsFor(episodeId, type, status) {
  return engine.jobs.filter(
    (j) => ((j.opts && j.opts.episodeId) || (j.payload && j.payload.episodeId)) === episodeId &&
      (!type || j.type === type) &&
      (!status || j.status === status)
  );
}
function emitAll(list) {
  list.slice().forEach((j) => {
    if (j.status !== "done") engine.emitDone(j);
  });
}
function auditRows() {
  return store.readLog("audit");
}

/* ============================ 测试主体 ============================ */
(function main() {
  section("T1 认证");
  let r = invoke("POST", "/api/login", { code: "WRONG-CODE" }, null);
  check("login 错误邀请码 → 403 INVALID_CODE", r.status === 403 && r.body.error.code === "INVALID_CODE", r);
  r = invoke("POST", "/api/login", {}, null);
  check("login 缺 code → 400", r.status === 400 && r.body.error.code === "BAD_REQUEST", r);
  r = invoke("POST", "/api/login", { code: "INV-DEMO-1" }, null);
  const loginOk = r.status === 200 && r.body.token && r.body.user && r.body.user.id === "u1";
  check("login INV-DEMO-1 → 200 {token,user}", loginOk, r);
  const tok = util.verify(r.body && r.body.token);
  check("token sign/verify 还原 {uid,role,exp}", !!tok && tok.uid === "u1" && tok.role === "ops" && typeof tok.exp === "number", tok);
  check("login 落 audit 账", auditRows().some((a) => a.action === "login"));

  section("T2 总览 /state");
  r = invoke("GET", "/api/state", null, OPS);
  check("GET /state → 200，含 projects/episodes/queue", r.status === 200 && r.body.projects.p1 && r.body.episodes.some((e) => e.id === "e1") && Array.isArray(r.body.queue), r && r.status);
  check("GET /state 回 decisions", r.body.episodes.some((e) => e.id === "e1" && e.decisions === 8));
  r = invoke("GET", "/api/state", null, null);
  check("GET /state 无 auth → 403", r.status === 403);
  r = invoke("GET", "/api/nope", null, OPS);
  check("未注册路由 → 404", r.status === 404, r);

  section("T3 建集 → C1（job c1plan done 派生）");
  r = invoke("POST", "/api/episodes", { projectId: "p1", title: "新剧·试镜", brief: "一场关于试镜的重逢故事", kind: "one_liner" }, CREATOR);
  check("POST /episodes → 201 + episode(stage1,decisions0)", r.status === 201 && r.body.episode.stage === 1 && r.body.episode.decisions === 0, r && r.status);
  const EP = r.body.episode.id;
  const c1planJob = jobsFor(EP, "c1plan")[0];
  check("建集即 enqueue c1plan（initiated_by user）", !!c1planJob && c1planJob.opts.initiated_by === "user", c1planJob);
  check("建集落 job 账本（worker_type self-host-stub）", store.readLog("job").some((j) => j.type === "c1plan" && j.worker_type === "self-host-stub"));
  check("建集落 audit", auditRows().some((a) => a.action === "episode_create" && a.target === EP));

  engine.emitDone(c1planJob);
  let c1 = findCard(EP, "C1", "pending");
  check("c1plan done → C1 卡出现（ver1 pending）", !!c1 && c1.ver === 1 && c1.status === "pending", c1);
  check("bus 已 publish cards(created)", bus.events.some((e) => e.topic === "cards" && e.obj.event === "created"));

  section("T4 卡流链式派生 C1→C2→C3→C4");
  r = invoke("POST", "/api/cards/" + c1.id + "/decide", { action: "accept", ver: 999 }, OPS);
  check("decide 错 ver → 409 STALE", r.status === 409 && r.body.error.code === "STALE", r);
  r = invoke("POST", "/api/cards/" + c1.id + "/decide", { action: "accept" }, OPS);
  check("decide 缺 ver → 409 STALE", r.status === 409, r);
  r = invoke("POST", "/api/cards/" + c1.id + "/decide", { action: "fly", ver: c1.ver }, OPS);
  check("decide 非法 action → 400 BAD_ACTION", r.status === 400 && r.body.error.code === "BAD_ACTION", r);
  r = invoke("POST", "/api/cards/card_missing/decide", { action: "accept", ver: 1 }, OPS);
  check("decide 不存在卡 → 404", r.status === 404 && r.body.error.code === "NOT_FOUND", r);

  r = invoke("POST", "/api/cards/" + c1.id + "/decide", { action: "accept", ver: c1.ver }, OPS);
  check("accept C1 → decisions=1 且派生 storyboard job", r.status === 200 && r.body.episode.decisions === 1 && jobsFor(EP, "storyboard").length === 1, r && r.status);
  check("accept 留痕 decided_by=auth.uid 且 audit", r.body.card.decided_by === "u1" && auditRows().some((a) => a.action === "card_accept" && a.operator === "u1"));
  r = invoke("POST", "/api/cards/" + c1.id + "/decide", { action: "accept", ver: r.body.card.ver }, OPS);
  check("重复 accept 已决卡 → 409 ALREADY_DECIDED", r.status === 409 && r.body.error.code === "ALREADY_DECIDED", r);

  emitAll(jobsFor(EP, "storyboard", "queued"));
  let c2 = findCard(EP, "C2", "pending");
  check("storyboard done → C2（演员 4 候选 stub）", !!c2 && c2.payload.actors.length === 4 && c2.payload.actors[0].candidates.length === 4, c2 && c2.payload && Object.keys(c2.payload));
  r = invoke("POST", "/api/cards/" + c2.id + "/decide", { action: "accept", ver: c2.ver }, OPS);
  check("accept C2 → decisions=2 → C3", r.body.episode.decisions === 2 && !!findCard(EP, "C3", "pending"), r.body.episode);
  let c3 = findCard(EP, "C3", "pending");
  r = invoke("POST", "/api/cards/" + c3.id + "/decide", { action: "accept", ver: c3.ver }, OPS);
  check("accept C3 → decisions=3 → C4（分镜 stub）", r.body.episode.decisions === 3 && !!findCard(EP, "C4", "pending"));

  section("T5 C4 accept → voice＋music(每场)＋compose → C5");
  const beforeVoice = jobsFor(EP, "voice").length;
  const beforeMusic = jobsFor(EP, "music").length;
  let c4 = findCard(EP, "C4", "pending");
  r = invoke("POST", "/api/cards/" + c4.id + "/decide", { action: "accept", ver: c4.ver }, OPS);
  check("accept C4 → decisions=4", r.body.episode.decisions === 4, r.body.episode);
  check("voice 按场 enqueue ×4", jobsFor(EP, "voice").length - beforeVoice === 4);
  check("music_enabled → music 按场 ×4", jobsFor(EP, "music").length - beforeMusic === 4);
  check("compose(preview) enqueue", jobsFor(EP, "compose").some((j) => j.payload.purpose === "preview"));
  const sceneIds = Object.keys(state.scenes).filter((k) => state.scenes[k].episodeId === EP);
  const shotIds = Object.keys(state.shots).filter((k) => state.shots[k].episodeId === EP);
  check("C1 accept 物化 4 scenes / 16 shots", sceneIds.length === 4 && shotIds.length === 16, { sceneIds: sceneIds.length, shotIds: shotIds.length });
  emitAll(jobsFor(EP, "voice", "queued"));
  emitAll(jobsFor(EP, "compose", "queued"));
  check("compose(preview) done → C5", !!findCard(EP, "C5", "pending"));

  section("T6 C5 → estimate → C6");
  let c5 = findCard(EP, "C5", "pending");
  r = invoke("GET", "/api/episodes/" + EP + "/estimate", null, OPS);
  check("C5 前 GET estimate → 409 NOT_READY", r.status === 409 && r.body.error.code === "NOT_READY", r);
  r = invoke("POST", "/api/cards/" + c5.id + "/decide", { action: "accept", ver: c5.ver }, OPS);
  check("accept C5 → decisions=5，estimate_ver=hash12", r.body.episode.decisions === 5 && typeof r.body.episode.estimate_ver === "string" && /^[0-9a-f]{12}$/.test(r.body.episode.estimate_ver), r.body.episode);
  check("ep.est ≈ {time_min:24}", r.body.episode.est && r.body.episode.est.time_min === 24 && r.body.episode.est.shots === 16, r.body.episode.est);
  check("accept C5 → C6", !!findCard(EP, "C6", "pending"));
  const EVER = state.episodes[EP].estimate_ver;
  r = invoke("GET", "/api/episodes/" + EP + "/estimate", null, OPS);
  const bd = r.body;
  check("GET estimate → ver＋breakdown(12×80/3×150/1×110)", bd.ver === EVER &&
    bd.breakdown.some((l) => l.qty === 12 && l.unit === 80) &&
    bd.breakdown.some((l) => l.qty === 3 && l.unit === 150) &&
    bd.breakdown.some((l) => l.qty === 1 && l.unit === 110), bd && bd.breakdown);
  check("estimate 含 music 行＋tts 行，cents=1720", bd.breakdown.some((l) => l.tier === "music") && bd.breakdown.some((l) => l.tier === "tts") && bd.cents === 1720, bd && bd.cents);

  section("T7 C6 accept＋POST /shoot（cas estimate）→ 16 video＋逐镜 moderate");
  r = invoke("POST", "/api/episodes/" + EP + "/shoot", { ver: EVER }, OPS);
  check("C6 未 accept 前 shoot → 409 NOT_READY", r.status === 409 && r.body.error.code === "NOT_READY", r);
  let c6 = findCard(EP, "C6", "pending");
  r = invoke("POST", "/api/cards/" + c6.id + "/decide", { action: "accept", ver: c6.ver }, OPS);
  check("accept C6 → decisions=6", r.body.episode.decisions === 6);
  r = invoke("POST", "/api/episodes/" + EP + "/shoot", { ver: "WRONG-VER" }, OPS);
  check("shoot 错 ver → 409 STALE（cas estimate）", r.status === 409 && r.body.error.code === "STALE", r);
  r = invoke("POST", "/api/episodes/" + EP + "/shoot", { ver: EVER }, OPS);
  check("shoot 正确 ver → 202＋16 video job", r.status === 202 && r.body.started === 16 && jobsFor(EP, "video").length === 16, r && r.status);
  check("shoot 写 shoot_confirmed_ver＋audit(user)", state.episodes[EP].shoot_confirmed_ver === EVER && auditRows().some((a) => a.action === "shoot"));
  check("video job 账本 initiated_by user", store.readLog("job").filter((j) => j.type === "video").every((j) => j.initiated_by === "user"));

  emitAll(jobsFor(EP, "video", "queued"));
  check("video done → take 入镜＋状态 moderating", shotIds.every((id) => state.shots[id].takes.length >= 1 && state.shots[id].status === "moderating"));
  check("逐镜 enqueue moderate ×16（initiated_by system）", jobsFor(EP, "moderate").length === 16 && store.readLog("job").some((j) => j.type === "moderate" && j.initiated_by === "system"));

  emitAll(jobsFor(EP, "moderate", "queued"));
  const failShots = shotIds.filter((id) => state.shots[id].status === "pending_review");
  const okShots = shotIds.filter((id) => state.shots[id].status === "ok");
  check("moderate 尾号7→fail：存在送复审镜且其余 ok", failShots.length >= 1 && failShots.length + okShots.length === 16, { fail: failShots.length, ok: okShots.length });
  check("fail → review_q pending 对应", state.review_q.filter((q) => failShots.indexOf(q.shotId) >= 0 && q.status === "pending").length === failShots.length);
  check("fail → C7 卡对应", cardsFor(EP, "pending").filter((c) => c.type === "C7").length === failShots.length);

  section("T8 审片（ops）→ 全 pass → C8");
  r = invoke("GET", "/api/review/queue", null, CREATOR);
  check("review 队列非 ops → 403 FORBIDDEN", r.status === 403 && r.body.error.code === "FORBIDDEN", r);
  r = invoke("GET", "/api/review/queue", null, OPS);
  check("GET /review/queue → 200 含新集复审项", r.status === 200 && r.body.queue.some((q) => failShots.indexOf(q.shotId) >= 0));
  const myRqs = state.review_q.filter((q) => failShots.indexOf(q.shotId) >= 0 && q.status === "pending");
  myRqs.forEach((q) => {
    const rr = invoke("POST", "/api/review/" + q.id + "/decide", { action: "pass", ver: q.ver || 1 }, OPS);
    check("ops pass " + q.id + " → 200", rr.status === 200, rr);
  });
  check("全镜 pass → C8 出现", !!findCard(EP, "C8", "pending"));
  check("reject 无 reason → 400", invoke("POST", "/api/review/rq1/decide", { action: "reject", ver: 1 }, OPS).status === 400);
  r = invoke("POST", "/api/review/rq1/decide", { action: "reject", reason: "脸不像", ver: 1 }, CREATOR);
  check("creator reject → 403", r.status === 403);
  r = invoke("POST", "/api/review/rq1/decide", { action: "reject", reason: "脸不像", ver: 1 }, OPS);
  check("ops reject（种子项）→ 200＋shot.flags.stale", r.status === 200 && state.shots.sh7.flags.stale === true && auditRows().some((a) => a.action === "review_decide"));
  r = invoke("POST", "/api/review/rq1/decide", { action: "pass", ver: 1 }, OPS);
  check("改后旧 ver 再 decide → 409 STALE（ver++）", r.status === 409 && r.body.error.code === "STALE", r);
  r = invoke("POST", "/api/review/rq1/decide", { action: "pass", ver: state.review_q.filter((q) => q.id === "rq1")[0].ver }, OPS);
  check("种子 rq1 pass → e1 也出 C8", r.status === 200 && findCard("e1", "C8", "pending") !== null, r);

  const c7s = cardsFor(EP, "pending").filter((c) => c.type === "C7");
  c7s.forEach((c) => {
    invoke("POST", "/api/cards/" + c.id + "/decide", { action: "accept", ver: c.ver }, OPS);
  });
  const c8 = findCard(EP, "C8", "pending");
  r = invoke("POST", "/api/cards/" + c8.id + "/decide", { action: "accept", ver: c8.ver }, OPS);
  check("accept C7×" + c7s.length + "＋C8 → decisions=6+" + (c7s.length + 1), r.body.episode.decisions === 6 + c7s.length + 1, r.body.episode);

  section("T9 music jobs done → 临时 music_pending＋C9；C9 accept 不计数");
  emitAll(jobsFor(EP, "music", "queued"));
  const pending = (state.music_pending || {})[EP] || [];
  check("music done → 每场 3 候选入 music_pending", pending.length === 12, pending.length);
  const c9s = cardsFor(EP, "pending").filter((c) => c.type === "C9");
  check("每场发一张 C9（payload=candidates）", c9s.length === 4 && c9s.every((c) => Array.isArray(c.payload.candidates) && c.payload.candidates.length === 3), c9s.length);
  const decBefore = state.episodes[EP].decisions;

  const c9a = c9s[0];
  const badCand = c9a.payload.candidates.filter((c) => c.license.usage === "missing")[0] || c9a.payload.candidates[0];
  r = invoke("POST", "/api/cards/" + c9a.id + "/decide", { action: "accept", payload: { candidateId: badCand.id }, ver: c9a.ver }, OPS);
  check("C9 accept(指定未许可曲) → 200 且 decisions 不变", r.status === 200 && state.episodes[EP].decisions === decBefore, r && r.status);
  const sceneA = c9a.payload.sceneId;
  check("采纳 → music_lib 挂 sceneId＋license 直接来自候选", state.music_lib.some((m) => m.sceneId === sceneA && m.license.usage === "missing" && m.id === badCand.id));
  const c9b = cardsFor(EP, "pending").filter((c) => c.type === "C9" && c.payload.sceneId !== sceneA)[0];
  r = invoke("POST", "/api/cards/" + c9b.id + "/decide", { action: "accept", ver: c9b.ver }, OPS);
  check("C9 accept(缺省选 ok 曲) → 不计数且采纳 ok 曲", state.episodes[EP].decisions === decBefore && state.music_lib.some((m) => m.sceneId === c9b.payload.sceneId && m.license.usage === "ok"));
  const c9c = cardsFor(EP, "pending").filter((c) => c.type === "C9" && c.payload.sceneId !== sceneA && c.payload.sceneId !== c9b.payload.sceneId)[0];
  const c9cVer = c9c.ver; // 提前捕获（返回体是 state 活引用，ver 会被本次 decide 改写）
  const musicBefore = jobsFor(EP, "music").length;
  r = invoke("POST", "/api/cards/" + c9c.id + "/decide", { action: "reject", ver: c9cVer }, OPS);
  check("C9 reject → 重 enqueue music＋卡留 pending(ver++)", r.status === 200 && jobsFor(EP, "music").length === musicBefore + 1 && r.body.card.status === "pending" && r.body.card.ver === c9cVer + 1, { status: r.status, body: r.body });
  emitAll(jobsFor(EP, "music", "queued"));
  check("重出后 C9 候选更新（同场候选替换）", (state.music_pending[EP] || []).filter((c) => c.sceneId === c9c.payload.sceneId).length === 3);

  section("T10 交付：precheck 拦 → 换曲 → export");
  r = invoke("POST", "/api/episodes/" + EP + "/precheck", {}, OPS);
  const items = r.body.items || [];
  check("precheck 固定五项", r.status === 200 && items.length === 5 && items.some((i) => i.item === "配乐双许可"));
  check("引用曲 usage=missing → 配乐项 fail", items.filter((i) => i.item === "配乐双许可")[0].pass === false, items);
  check("其余四项 stub 全绿", items.filter((i) => i.item !== "配乐双许可").every((i) => i.pass === true));
  r = invoke("POST", "/api/episodes/" + EP + "/export", {}, OPS);
  check("export 有 fail → 422 BLOCKED_PRECHECK＋missing", r.status === 422 && r.body.error.code === "BLOCKED_PRECHECK" && (r.body.error.missing || []).indexOf("配乐双许可") >= 0, r);
  r = invoke("POST", "/api/music/candidates", { sceneId: sceneA, mood: "释然" }, OPS);
  check("POST /music/candidates → 202 job(music)", r.status === 202 && r.body.job.type === "music");
  emitAll(jobsFor(EP, "music", "queued"));
  const adoptedBad = state.music_lib.filter((m) => m.sceneId === sceneA)[0];
  r = invoke("POST", "/api/music/" + adoptedBad.id + "/regenerate", {}, OPS);
  check("POST /music/:id/regenerate（库内曲）→ 重 enqueue", r.status === 202 && r.body.job.type === "music");
  emitAll(jobsFor(EP, "music", "queued"));
  const goodCand = (state.music_pending[EP] || []).filter((c) => c.sceneId === sceneA && c.license.usage === "ok")[0];
  r = invoke("POST", "/api/music/" + goodCand.id + "/adopt", { sceneId: sceneA }, OPS);
  check("adopt → license 来自候选＋同场换曲替换", r.status === 200 && state.music_lib.filter((m) => m.sceneId === sceneA).length === 1 && state.music_lib.filter((m) => m.sceneId === sceneA)[0].license.usage === "ok");
  check("library GET 可见", invoke("GET", "/api/music/library", null, OPS).body.library.some((m) => m.sceneId === sceneA));
  check("adopt/候选/重生成均落 audit", ["music_candidates", "music_regenerate", "music_adopt"].every((a) => auditRows().some((x) => x.action === a)));
  r = invoke("POST", "/api/episodes/" + EP + "/precheck", {}, OPS);
  check("换曲后 precheck 全绿", r.status === 200 && r.body.pass === true, r.body);
  r = invoke("POST", "/api/episodes/" + EP + "/export", {}, OPS);
  check("export 全绿 → 202 compose export job", (r.status === 202 || r.status === 200) && jobsFor(EP, "compose").some((j) => j.payload.purpose === "export"), r);
  const exportJob = jobsFor(EP, "compose").filter((j) => j.payload.purpose === "export").pop();
  engine.emitDone(exportJob);
  check("compose done → artifacts 回 job.art＋bus(cards)+audit", bus.events.some((e) => e.topic === "cards" && e.obj.event === "artifacts" && e.obj.artifacts && e.obj.artifacts.art) && auditRows().some((a) => a.action === "export_artifacts"));

  section("T11 任务与成本");
  r = invoke("GET", "/api/jobs?episodeId=" + EP + "&status=done", null, OPS);
  check("GET /jobs?status=done 过滤", r.status === 200 && r.body.jobs.length > 30 && r.body.jobs.every((j) => j.status === "done"), r.body && r.body.total);
  const vid = jobsFor(EP, "video")[0];
  r = invoke("POST", "/api/jobs/" + vid.id + "/retry", {}, OPS);
  check("POST /jobs/:id/retry → engine.retry 生效", r.status === 200 && engine.find(vid.id).status === "queued" && auditRows().some((a) => a.action === "job_retry"));
  r = invoke("POST", "/api/jobs/" + vid.id + "/stop", {}, OPS);
  check("POST /jobs/:id/stop → stopped", r.status === 200 && engine.find(vid.id).status === "stopped");
  r = invoke("GET", "/api/jobs?episodeId=" + EP + "&status=stopped", null, OPS);
  check("GET /jobs?status=stopped 命中", r.body.jobs.some((j) => j.id === vid.id));
  r = invoke("POST", "/api/jobs/job_none/retry", {}, OPS);
  check("retry 不存在任务 → 404", r.status === 404, r);
  r = invoke("GET", "/api/episodes/" + EP + "/costs", null, OPS);
  const cst = r.body;
  const shotSum = (cst.shots || []).reduce((a, s) => a + s.cents, 0);
  const commonSum = (cst.common || []).reduce((a, s) => a + s.cents, 0);
  check("costs 镜级穿透＋Σ 一致", r.status === 200 && (cst.shots || []).length === 16 && shotSum + commonSum === cst.total_cents && cst.total_cents > 0, { shotSum, commonSum, total: cst.total_cents });
  r = invoke("GET", "/api/billing?episodeId=" + EP, null, CREATOR);
  check("GET /billing 非 ops → 403", r.status === 403 && r.body.error.code === "FORBIDDEN");
  r = invoke("GET", "/api/billing?episodeId=" + EP, null, OPS);
  check("GET /billing?episodeId= 过滤影子账", r.status === 200 && r.body.rows.length > 0 && r.body.rows.every((b) => b.episodeId === EP) && r.body.cents === cst.total_cents, r.body && r.body.cents);

  section("T12 后台 registry / quant / confirmed / alerts / audit");
  r = invoke("GET", "/api/admin/registry", null, CREATOR);
  check("registry 非 ops → 403", r.status === 403);
  r = invoke("GET", "/api/admin/registry", null, OPS);
  check("GET /admin/registry → 200＋豁免渲染", r.status === 200 && r.body.registry.imgspark.unavail.join(",") === "nvfp4,int8" && r.body.langlint_exempt === true);
  r = invoke("POST", "/api/admin/registry/quant", { engineId: "imgspark", tier: "nvfp4" }, OPS);
  check("quant 未发布档(unavail) → 409 QUANT_RULE 复述", r.status === 409 && r.body.error.code === "QUANT_RULE" && String(r.body.error.message).indexOf("nvfp4") >= 0, r);
  r = invoke("POST", "/api/admin/registry/quant", { engineId: "imgspark", tier: "MXFP8+FP8" }, OPS);
  check("quant 兜底档缺 reason → 409", r.status === 409 && r.body.error.code === "QUANT_RULE", r);
  r = invoke("POST", "/api/admin/registry/quant", { engineId: "imgspark", tier: "MXFP8+FP8", reason: "nvfp4/int8 未发布" }, OPS);
  check("quant 兜底档带 reason → 200＋audit_needed＋Q- 号", r.status === 200 && r.body.audit_needed === true && /^Q-/.test(r.body.audit_id), r);
  check("quant_fallback 落 audit 账", auditRows().some((a) => a.action === "quant_fallback" && /^Q-/.test(a.audit_id || "")));
  check("registry 已应用 tier", state.settings.registry.imgspark.tier === "MXFP8+FP8");
  r = invoke("POST", "/api/admin/registry/quant", { engineId: "nope", tier: "nvfp4" }, OPS);
  check("quant 未知引擎 → 404", r.status === 404, r);
  r = invoke("POST", "/api/admin/registry/endpoint", { engineId: "music", endpoint: "http://w-m:8191" }, OPS);
  check("endpoint 变更无 confirmed → 428 CONFIRM_REQ", r.status === 428 && r.body.error.code === "CONFIRM_REQ", r);
  r = invoke("POST", "/api/admin/registry/endpoint", { engineId: "music", endpoint: "http://w-m:8191", confirmed: true }, OPS);
  check("endpoint confirmed → 200 已更新", r.status === 200 && state.settings.registry.music.endpoint === "http://w-m:8191");
  r = invoke("POST", "/api/admin/registry/model", { engineId: "vid5060", model: "LTX-2.5-rc2" }, OPS);
  check("model 变更无 confirmed → 428", r.status === 428);
  r = invoke("POST", "/api/admin/registry/model", { engineId: "vid5060", model: "LTX-2.5-rc2", confirmed: true }, OPS);
  check("model confirmed → 200＋audit", r.status === 200 && state.settings.registry.vid5060.model === "LTX-2.5-rc2" && auditRows().some((a) => a.action === "model_change"));
  r = invoke("GET", "/api/admin/registry/vid5060", null, OPS);
  check("GET /admin/registry/:engineId → 单引擎", r.status === 200 && r.body.entry.model === "LTX-2.5-rc2");
  const alertsBefore = state.alerts.length;
  r = invoke("POST", "/api/admin/alerts/simulate", {}, OPS);
  check("alerts/simulate → 3 条＋bus(alerts)×3", r.status === 200 && r.body.alerts.length === 3 && state.alerts.length === alertsBefore + 3 && bus.events.filter((e) => e.topic === "alerts").length >= 3);
  r = invoke("GET", "/api/admin/audit?kind=audit", null, OPS);
  const acts = (r.body.rows || []).map((x) => x.action);
  check("GET /admin/audit?kind=audit 汇总关键动作", r.status === 200 && ["login", "episode_create", "card_accept", "shoot", "export", "export_artifacts", "quant_fallback", "review_decide"].every((a) => acts.indexOf(a) >= 0), acts.filter((v, i, s) => s.indexOf(v) === i));
  r = invoke("GET", "/api/admin/audit?kind=billing", null, OPS);
  check("GET /admin/audit?kind=billing → readLog(billing)", r.status === 200 && r.body.kind === "billing" && r.body.rows.every((b) => typeof b.cents === "number"));

  section("T13 SSE /api/events");
  invoke("GET", "/api/events", null, OPS);
  const last = bus.attached[bus.attached.length - 1];
  check("GET /events → bus.attach(res)（全 topic）", last && last.res && last.res.sse === true && !last.opts, last);
  invoke("GET", "/api/events?session=sess42", null, OPS);
  const last2 = bus.attached[bus.attached.length - 1];
  check("?session= 只订 l2:sess42＋jobs", last2 && last2.opts && last2.opts.topics.indexOf("l2:sess42") >= 0 && last2.opts.topics.indexOf("jobs") >= 0, last2 && last2.opts);
  r = invoke("GET", "/api/events", null, null);
  check("无 auth SSE → 403", r.status === 403);

  section("T14 music_enabled=false：无 music job、无 C9");
  state.projects.p2 = { id: "p2", title: "无声剧", style_pkg: "NOIR", music_enabled: false };
  r = invoke("POST", "/api/episodes", { projectId: "p2", title: "无声剧·首集", brief: "没有配乐的试验集", kind: "novel" }, CREATOR);
  const EP2 = r.body.episode.id;
  emitAll(jobsFor(EP2, "c1plan", "queued"));
  let c1b = findCard(EP2, "C1", "pending");
  invoke("POST", "/api/cards/" + c1b.id + "/decide", { action: "accept", ver: c1b.ver }, OPS);
  emitAll(jobsFor(EP2, "storyboard", "queued"));
  ["C2", "C3", "C4"].forEach((t) => {
    const c = findCard(EP2, t, "pending");
    if (c) invoke("POST", "/api/cards/" + c.id + "/decide", { action: "accept", ver: c.ver }, OPS);
  });
  check("music_enabled=false → C4 accept 无 music job（voice 照常）", jobsFor(EP2, "music").length === 0 && jobsFor(EP2, "voice").length === 4);
  emitAll(jobsFor(EP2, "compose", "queued"));
  const c5b = findCard(EP2, "C5", "pending");
  check("样片链仍完整（C5 出）", !!c5b);
  const INJECTED_NOTE = "用 prompt 调 seed 生成，注意路由";
  if (c5b) {
    c5b.payload = Object.assign({}, c5b.payload, { note: INJECTED_NOTE }); // 注入禁词测 /state 兜底
    store.commit();
  }
  state.cards.seedc9 = {
    id: "seedc9",
    episodeId: EP2,
    type: "C9",
    payload: { sceneId: "sX" },
    status: "pending",
    ver: 1,
    created_at: util.now()
  };
  r = invoke("GET", "/api/cards?episodeId=" + EP2, null, OPS);
  check("GET /cards：music_enabled=false 项目不出 C9", r.body.cards.every((c) => c.type !== "C9"), r.body.cards.map((c) => c.type));

  section("T15 /state 禁词兜底 sanitize＋告警");
  const alertsBefore2 = state.alerts.length;
  r = invoke("GET", "/api/state", null, OPS);
  const c5s = (r.body.cards_pending || []).filter((c) => c.episodeId === EP2 && c.type === "C5");
  const payloadStr = JSON.stringify(c5s.length ? c5s[0].payload : {});
  check(
    "payload 禁词被替换为语言表层文案（sanitize 生效）",
    c5s.length === 1 &&
      payloadStr.indexOf("prompt") < 0 &&
      payloadStr.indexOf("seed") < 0 &&
      c5s[0].payload.note !== INJECTED_NOTE,
    payloadStr.slice(0, 200)
  );
  check("命中记告警＋audit(langlint_sanitize)", state.alerts.length > alertsBefore2 && auditRows().some((a) => a.action === "langlint_sanitize"));
  check("store 内 payload 已就地替换", JSON.stringify(state.cards[c5s[0] ? c5s[0].id : "none"] || {}).indexOf("prompt") < 0);
  check("/state 摘要也不出 music_enabled=false 项目的 C9", !(r.body.cards_pending || []).some((c) => c.type === "C9" && c.episodeId === EP2));

  section("T16 收尾：审计链完整＋卡流终态");
  r = invoke("GET", "/api/cards?episodeId=" + EP, null, OPS);
  const types = r.body.cards.map((c) => c.type);
  check("新集集齐全链卡 C1..C9", ["C1", "C2", "C3", "C4", "C5", "C6", "C8", "C9"].every((t) => types.indexOf(t) >= 0) && types.filter((t) => t === "C7").length >= 1, types);
  check("decided 卡均留痕 decided_by", r.body.cards.filter((c) => c.status === "decided").every((c) => c.decided_by === "u1"));
  check("job 账本含全部七类任务型", ["c1plan", "storyboard", "voice", "music", "video", "moderate", "compose"].every((t) => store.readLog("job").some((j) => j.type === t)));
  check("billing 账本 episodeId 完整", store.readLog("billing").every((b) => typeof b.episodeId === "string" && typeof b.cents === "number" && b.ts));

  /* ============================ 汇总 ============================ */
  console.log("\n================ api selfcheck ================");
  console.log("passed=" + passed + "  failed=" + failed);
  if (failed) {
    console.log("FAILURES:");
    failures.forEach((f) => console.log(" - " + f));
    process.exit(1);
  }
  console.log("ALL GREEN");
  process.exit(0);
})();
