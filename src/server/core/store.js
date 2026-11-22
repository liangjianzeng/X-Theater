"use strict";
/**
 * core/store.js — 状态与账本（契约 §1/§2/§8）
 * - openStore(varDir)：state.json 不存在 → 按附录 A 种子初始化（p1/e1/4 scenes/16 shots/#7 送复审/music_lib 2 曲）
 * - get / commit（防抖 50ms fs.writeFileSync）/ flush / log(kind,obj) / readLog(kind)
 * - 账本 append-only JSONL：var/log-<kind>.jsonl（job|billing|audit|agentrun）
 * 零 npm 依赖，Windows 路径安全（一律 path.join）。
 */

const fs = require("fs");
const path = require("path");
const util = require("./util");

/* ---------------- 节点拓扑内建默认（2026-11-22 节点注册表化） ----------------
 * 存量库注册表引擎缺 node 绑定时的回退表（2026-11-22 之前的硬编码拓扑）。
 * 启动时 ensureRegistryNodes 会把绑定写进注册表，此后注册表是 lane→node 唯一事实源；
 * 本表仅兜底「注册表同族引擎全无绑定」的过渡态。引擎登记/改绑见 api/admin.js。 */
const DEFAULT_LANE_NODE = { img5060: "local", vid5060: "local", imgspark: "dgx", vidsark: "dgx", vidspark: "dgx" };
// 注：vidsark 为 2026-11-22 之前的拼写残留（兼容保留），正确键名 vidspark 修正同绑 dgx

/** 幂等迁移：注册表引擎补 node 绑定字段（缺省按 DEFAULT_LANE_NODE，其余车道 null） */
function ensureRegistryNodes(state) {
  const st = state || {};
  st.settings = st.settings || {};
  const reg = (st.settings.registry = st.settings.registry || {});
  let n = 0;
  Object.keys(reg).forEach((id) => {
    const e = reg[id];
    if (e && e.node === undefined) {
      e.node = DEFAULT_LANE_NODE[e.lane] !== undefined ? DEFAULT_LANE_NODE[e.lane] : null;
      n++;
    }
  });
  return n;
}

/* ---------------- 种子数据（契约 §8 附录 A） ---------------- */

const SHOT_TYPES = ["特写", "中景", "全景", "空镜"];
const SCENE_SEED = [
  { id: "s1", name: "场1 重逢", mood: "释然" },
  { id: "s2", name: "场2 离别", mood: "离别" },
  { id: "s3", name: "场3 对峙", mood: "压抑" },
  { id: "s4", name: "场4 灯塔", mood: "释然" }
];

/** 确定性 takes：普通镜 1 条；每逢 3 的镜 2 条；#7 双条（重拍记录演示）。pick 择优按低价合规条。 */
function mkTakes(id, seq) {
  const n = seq === 7 ? 2 : seq % 3 === 0 ? 2 : 1;
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      id: "tk_" + id + "_" + (k + 1),
      engine: "自部署·标准档", // 语言表纪律：用户面不带型号
      cost_cents: 80 + k * 15,
      art: "var/out/" + id + "_" + (k + 1) + ".mp4",
      license: { model: "MIT", usage: "ok" },
      best: k === 0
    });
  }
  return out;
}

function seedState() {
  const scenes = {};
  const shots = {};
  let seq = 0;
  SCENE_SEED.forEach((sc, si) => {
    scenes[sc.id] = {
      id: sc.id,
      episodeId: "e1",
      name: sc.name,
      mood: sc.mood,
      seq: si + 1
    };
    for (let i = 0; i < 4; i++) {
      seq += 1;
      const id = "sh" + String(seq).padStart(2, "0");
      // #7（sh07）＝演示路径：pending_review 关联 review_q 一条（契约 §8，配合 rules.moderation 尾号 7 必送复审 V6）
      const st = seq === 7 ? "pending_review" : "storyboarded";
      shots[id] = {
        id,
        sceneId: sc.id,
        episodeId: "e1",
        seq,
        name: sc.name + " " + SHOT_TYPES[(seq - 1) % SHOT_TYPES.length] + " " + String(seq).padStart(2, "0"),
        sec: 5,
        status: st,
        // 演示「已开拍」属性：确定性 takes（V9 择优/成本面有真实数据；#7 双条＝重拍记录演示）
        takes: mkTakes(id, seq),
        rerolls: seq === 7 ? 1 : 0,
        flags: { stale: false }
      };
    }
  });

  return {
    users: {
      // 演示账号：u1 创作者 / u2 运营（ops 端点需 ops 角色）
      u1: { id: "u1", name: "阿航", role: "creator" },
      u2: { id: "u2", name: "运营小李", role: "ops" }
    },
    invites: ["INV-DEMO-1"],
    projects: {
      p1: { id: "p1", title: "夜航西飞", style_pkg: { look: "夜色胶片", palette: "青橙", ratio: "9:16" }, music_enabled: true }
    },
    episodes: {
      e1: {
        id: "e1",
        projectId: "p1",
        title: "夜航西飞 · 第 1 集",
        brief: "一句话：女飞行员夜航归乡，在灯塔下与往事和解。",
        stage: 1,
        decisions: 0,
        budget_cents: 5000,
        cost_cents: 0,
        paused: false,
        estimate_ver: null,
        shoot_confirmed_ver: null,
        est: { time_min: 24, cents: 1280, shots: 16 }
      }
    },
    scenes,
    shots,
    cards: {},
    // music_lib 预置 2 曲（契约 §8 演示）。
    // 曲库策略（契约 §4）＝「标题含『未许可』→ license.usage:"missing"」；
    // 预置曲《码头暮色》为演示预检拦截，《晚风》为放行对照——
    // 二者均由种子**直接给定 license 对象**（规则只约束 music job 新产出的候选，二者并存）。
    music_lib: [
      {
        id: "mu1",
        title: "晚风",
        mood: "释然",
        sec: 45,
        engine: "ACE-Step 1.5",
        license: { model: "MIT", usage: "ok" },
        shadow_cents: 8,
        sceneId: null
      },
      {
        id: "mu2",
        title: "码头暮色", // 演示用：标题不含"未许可"但按契约 §8 需 usage:"missing"，故直接构造 license 对象（种子即事实源）
        mood: "离别",
        sec: 38,
        engine: "ACE-Step 1.5",
        license: { model: "MIT", usage: "missing" },
        shadow_cents: 11,
        sceneId: null
      }
    ],
    review_q: [
      { id: "rv_1", shotId: "sh07", reason: "机审抽帧命中灰区（演示 V6）", status: "pending", sla_left: 120, ver: 1, ts: Date.now() }
    ],
    alerts: [],
    l2_sessions: {},
    settings: {
      // 引擎与段位注册表（契约 §4；rules.quant 依 registry[engineId].unavail/published 裁决）。
      // node＝引擎归属算力节点（state.nodes 的 id，2026-11-22 节点注册表化）：
      //   车道拨号（cfg.laneBase）与运维台「归属节点」列均由此派生——注册表是 lane→node 的唯一事实源。
      //   null＝不挂算力节点的独立服务/进程内车道。
      registry: {
        "qwen-image-2.1-turbo-Q5_K_M": {
          lane: "img5060", node: "local", engine: "qwen-image-2.1-turbo", quant: "Q5_K_M",
          endpoint: "W-B ComfyUI :8188", published: ["Q5_K_M"], unavail: []
        },
        "MiniMax-H3-Image": {
          lane: "imgspark", node: "dgx", engine: "MiniMax-H3-Image", quant: "int8_convrot",
          endpoint: "Spark ComfyUI :8188", published: ["int8", "MXFP8+FP8"], unavail: ["nvfp4"]
        },
        "LTX-2.5": {
          lane: "vid5060", node: "local", engine: "LTX-2.5 UD", quant: "UD-Q4_K_XL",
          endpoint: "W-B ComfyUI :8188", published: ["UD-Q4_K_XL"], unavail: []
        },
        "FastH3": {
          lane: "vidspark", node: "dgx", engine: "MiniMax-H3", quant: "int8_convrot",
          endpoint: "Spark ComfyUI :8188", published: ["nvfp4", "int8", "MXFP8+FP8"], unavail: []
        },
        "ACE-Step 1.5": {
          lane: "music", node: null, engine: "ACE-Step 1.5", quant: "fp16",
          endpoint: "W-M :8190", published: ["fp16"], unavail: []
        },
        "CosyVoice2": {
          lane: "tts", node: null, engine: "CosyVoice2", quant: "fp16",
          endpoint: "W-B :9880", published: ["fp16"], unavail: []
        },
        "FFmpeg": {
          lane: "compose", node: null, engine: "FFmpeg", quant: "n/a",
          endpoint: "容器池", published: ["n/a"], unavail: []
        },
        "moderate-rules": {
          lane: "moderate", node: null, engine: "规则码＋抽帧 stub", quant: "n/a",
          endpoint: "in-proc", published: ["n/a"], unavail: []
        }
      },
      runtime_mode: "A",
      peak_valley: true,
      moderation_pass: true
    }
  };
}


/* 极简种子（THEATER_SEED_MINIMAL=1）：真实流程档——无假镜头/假账本/假复审/假曲库，
   一切数据由真实操作产生。验收套件不设此 env，仍用完整种子。 */
function seedStateMinimal() {
  return {
    users: {
      u1: { id: "u1", name: "阿航", role: "creator" },
      u2: { id: "u2", name: "运营小李", role: "ops" }
    },
    invites: ["INV-DEMO-1"],
    projects: {
      p1: { id: "p1", title: "剧场首部短剧", style_pkg: { look: "写实电影感", palette: "青橙", ratio: "9:16" }, music_enabled: true }
    },
    episodes: {},
    scenes: {},
    shots: {},
    cards: {},
    music_lib: [],
    review_q: [],
    alerts: [],
    l2_sessions: {},
    settings: seedState().settings
  };
}

/* ---------------- 素材中心（asset_lib）骨架与一次性迁移（素材中心方案 §2/施工 A1） ----------------
 * st.asset_lib：五域资产库（audio{music,sfx,ambience,voices}/images/characters/scenes/canon）。
 * st.asset_drafts：候选临时池（生成未入库，TTL 7 天惰性清理）。
 * 迁移：music_lib → asset_lib.audio.music（只增不删——旧数组保留一版，回滚=代码回退旧包）。
 * 条目补齐：type/scope/status/rating/used_by/source；sceneId → used_by[{kind:"scene",primary}]。
 */
const ASSET_DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;

function ensureAssetLib(state) {
  if (!state || typeof state !== "object") return state;
  if (state.asset_lib && state.asset_lib.version) return state;
  state.asset_lib = {
    version: 1,
    audio: { music: [], sfx: [], ambience: [], voices: [] },
    images: [],
    characters: [],
    scenes: [],
    canon: { style_pkgs: [], reject_rules: [], lore: [], beats: [] }
  };
  state.asset_drafts = { music: [], images: [] };
  // 一次性迁移曲库（mu1/mu2 种子曲 → global/approved）
  const migrated = [];
  (Array.isArray(state.music_lib) ? state.music_lib : []).forEach((m) => {
    if (!m || !m.id) return;
    const used_by = [];
    if (m.sceneId) used_by.push({ kind: "scene", id: String(m.sceneId), primary: true });
    migrated.push(
      Object.assign({}, m, {
        type: m.type || "bgm",
        tags: m.tags || "",
        scope: m.scope || "global",
        projectId: m.projectId || null,
        status: m.status || "approved",
        rating: m.rating || 0,
        used_by,
        source: m.source || "seed"
      })
    );
  });
  state.asset_lib.audio.music = migrated;
  return state;
}

/** 候选池 TTL 惰性清理：读取面（list/summary）调用；过期候选直接淘汰。 */
function pruneDrafts(state, now) {
  const drafts = state && state.asset_drafts;
  if (!drafts) return state;
  const t = now || Date.now();
  ["music", "images"].forEach((k) => {
    const arr = Array.isArray(drafts[k]) ? drafts[k] : (drafts[k] = []);
    for (let i = arr.length - 1; i >= 0; i--) {
      const d = arr[i];
      if (!d || !d.created_at || t - d.created_at > ASSET_DRAFT_TTL_MS) arr.splice(i, 1);
    }
  });
  return state;
}

/* ---------------- openStore ---------------- */

function openStore(varDir, opts) {
  fs.mkdirSync(varDir, { recursive: true });
  const statePath = path.join(varDir, "state.json");

  let state = null;
  let seeded = false;
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch (e) {
      state = null; // 损坏 → 重建种子
    }
  }
  if (!state || typeof state !== "object" || !state.projects || !state.episodes) {
    state = (opts && opts.minimal) ? seedStateMinimal() : seedState();
    ensureAssetLib(state); // 种子即带素材库骨架（种子曲随迁移进库）
    seeded = true;
    // e1 演示集已开拍：镜像种子影子账本，Σbilling(episode)==cost_cents 不变量出生即成立（V5）
    let sum = 0;
    const lines = [];
    Object.values(state.shots || {}).forEach((s) => {
      (s.takes || []).forEach((t) => {
        sum += t.cost_cents || 0;
        lines.push({
          id: "log_seed_" + t.id,
          ts: Date.now(),
          episodeId: "e1",
          shotId: s.id,
          kind: "video",
          cents: t.cost_cents || 0,
          worker_type: "self-host-stub",
          initiated_by: "user",
          seeded: true
        });
      });
    });
    if (state.episodes && state.episodes.e1) state.episodes.e1.cost_cents = sum;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    if (lines.length) {
      fs.appendFileSync(
        path.join(varDir, "log-billing.jsonl"),
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
      );
    }
  } else {
    // 素材库骨架/迁移：存量库统一走 ensure（version 防重跑；只增不删可回滚）
    ensureAssetLib(state);
    // 注册表引擎 node 绑定迁移（2026-11-22 节点注册表化）：幂等补齐
    if (ensureRegistryNodes(state)) {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
  }

  /* ---------- 域（tenant）迁移＋自愈 stamp（2026-11-22 S3） ---------- */
  // 首次：建「默认工作台」回填全部存量（pool 模式，方案 docs/permission-domain-plan.md）。
  // 此后每次启动仍幂等补 stamp：并行写入方/历史数据漏戳的实体归默认域，防 scopedView 全域隐形
  //（2026-11-22 真机：副驾 create_episode 漏戳，集建成即不可见）。
  {
    const hasTenants = state.tenants && Object.keys(state.tenants).length;
    const dt = hasTenants ? Object.keys(state.tenants)[0] : "tid_default";
    const stampTid = (o) => {
      let n = 0;
      Object.keys(o || {}).forEach((k) => {
        if (o[k] && !o[k].tenantId) { o[k].tenantId = dt; n++; }
      });
      return n;
    };
    if (!hasTenants) {
      const users = state.users || {};
      const opsUser =
        Object.keys(users).map((k) => users[k]).find((u) => u && u.role === "ops") || null;
      const members = {};
      Object.keys(users).forEach((uid) => {
        members[uid] = opsUser && uid === opsUser.id ? "owner" : "member";
      });
      state.tenants = {
        tid_default: {
          id: "tid_default",
          name: "默认工作台",
          owner_uid: opsUser ? opsUser.id : null,
          members,
          created_at: Date.now()
        }
      };
    }
    const fixed =
      stampTid(state.projects) + stampTid(state.episodes) + stampTid(state.l2_sessions);
    if (!hasTenants || fixed) {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
  }

  let timer = null;
  let revCounter = 0; // state 修订号（commit/flush 自增）：域级资产反查索引用它做失效
  const store = {
    varDir,
    statePath,
    seeded,

    /** state 修订号（资产索引缓存失效用） */
    rev() {
      return revCounter;
    },

    /** → state（可变对象；改完调 commit()） */
    get() {
      return state;
    },

    /** 防抖 50ms 写 state.json */
    commit() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        revCounter++;
        try {
          fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        } catch (e) {
          console.error("[store] commit failed:", e.message);
        }
      }, 50);
    },

    /** 立即落盘（自测/退出前用） */
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      revCounter++;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    },

    /** 账本追加：自动加 {id,ts}，返回该行对象（账本只增不改） */
    log(kind, obj) {
      const line = Object.assign({ id: util.uid("log"), ts: util.now() }, obj || {});
      fs.appendFileSync(path.join(varDir, "log-" + kind + ".jsonl"), JSON.stringify(line) + "\n");
      return line;
    },

    /** 读账本 → 数组 */
    readLog(kind) {
      const p = path.join(varDir, "log-" + kind + ".jsonl");
      if (!fs.existsSync(p)) return [];
      const out = [];
      for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
        const t = raw.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t));
        } catch (e) {
          /* 跳过坏行 */
        }
      }
      return out;
    }
  };

  return store;
}

module.exports = { openStore, seedState, ensureAssetLib, pruneDrafts, ASSET_DRAFT_TTL_MS, DEFAULT_LANE_NODE, ensureRegistryNodes };
