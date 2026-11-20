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
      // 引擎与段位注册表（契约 §4；rules.quant 依 registry[engineId].unavail/published 裁决）
      registry: {
        "qwen-image-2.1-turbo-Q5_K_M": {
          lane: "img5060", engine: "qwen-image-2.1-turbo", quant: "Q5_K_M",
          endpoint: "W-B ComfyUI :8188", published: ["Q5_K_M"], unavail: []
        },
        "MiniMax-H3-Image": {
          lane: "imgspark", engine: "MiniMax-H3-Image", quant: "MXFP8+FP8",
          endpoint: "Spark SGLang 常驻", published: ["MXFP8+FP8"], unavail: ["nvfp4", "int8"]
        },
        "LTX-2.5": {
          lane: "vid5060", engine: "LTX-2.5 UD", quant: "UD-Q4_K_XL",
          endpoint: "W-B ComfyUI :8188", published: ["UD-Q4_K_XL"], unavail: []
        },
        "FastH3": {
          lane: "vidspark", engine: "FastH3", quant: "nvfp4",
          endpoint: "Spark", published: ["nvfp4"], unavail: []
        },
        "ACE-Step 1.5": {
          lane: "music", engine: "ACE-Step 1.5", quant: "fp16",
          endpoint: "W-M :8190", published: ["fp16"], unavail: []
        },
        "CosyVoice2": {
          lane: "tts", engine: "CosyVoice2", quant: "fp16",
          endpoint: "W-B :9880", published: ["fp16"], unavail: []
        },
        "FFmpeg": {
          lane: "compose", engine: "FFmpeg", quant: "n/a",
          endpoint: "容器池", published: ["n/a"], unavail: []
        },
        "moderate-rules": {
          lane: "moderate", engine: "规则码＋抽帧 stub", quant: "n/a",
          endpoint: "in-proc", published: ["n/a"], unavail: []
        }
      },
      runtime_mode: "A",
      peak_valley: true,
      moderation_pass: true
    }
  };
}

/* ---------------- openStore ---------------- */

function openStore(varDir) {
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
    state = seedState();
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
  }

  let timer = null;
  const store = {
    varDir,
    statePath,
    seeded,

    /** → state（可变对象；改完调 commit()） */
    get() {
      return state;
    },

    /** 防抖 50ms 写 state.json */
    commit() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
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

module.exports = { openStore, seedState };
