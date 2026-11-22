"use strict";
/**
 * api/cards.js — 卡流链式派生（契约 §1/§3/§4，任务书关键语义）
 *
 * 链：POST /episodes→(job c1plan)→C1；accept C1→决策++＋storyboard→C2（演员 4 候选 stub）；
 * accept C2→C3；accept C3→C4；accept C4（样片）→voice＋music(每场，若 music_enabled 且该场无曲)
 * ＋compose(stub)→C5；accept C5→estimate（episodes.estimate_ver=hash12）→C6；
 * accept C6＋POST /shoot→16 video→逐镜 moderate；moderate pass→shot ok／fail→review_q＋C7；
 * 全 review pass→C8。music 候选完成→临时 music_pending＋C9（payload=candidates）；
 * C9 accept 不 ++决策；reject→重 enqueue。
 *
 * jobs-done 约定（与 core agent 一致）：engine done 时 bus.publish("jobs",{event:"done",job})，
 * 本模块经 ctx.bus.on("jobs",fn) 订阅。
 */

const musicMod = require("./music.js");

const DEFAULT_SCENES = [
  { name: "场1·重逢", mood: "释然" },
  { name: "场2·离别", mood: "离别" },
  { name: "场3·对峙", mood: "压抑" },
  { name: "场4·灯塔", mood: "释然" }
];
const SHOTS_PER_SCENE = 4;

function parseQuery(req) {
  const url = (req && req.url) || "";
  const i = url.indexOf("?");
  const out = {};
  if (i >= 0) {
    const sp = new URLSearchParams(url.slice(i + 1));
    sp.forEach((v, k) => {
      out[k] = v;
    });
  }
  return out;
}

function scenesOf(ctx, episodeId) {
  const st = ctx.store.get();
  return Object.keys(st.scenes || {})
    .map((k) => st.scenes[k])
    .filter((s) => s.episodeId === episodeId)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

function shotsOf(ctx, episodeId) {
  const st = ctx.store.get();
  return Object.keys(st.shots || {})
    .map((k) => st.shots[k])
    .filter((s) => s.episodeId === episodeId)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

function projectOf(ctx, episode) {
  const st = ctx.store.get();
  return episode ? (st.projects || {})[episode.projectId] : null;
}

/* ---------------- 卡片原语 ---------------- */

function upsertCard(ctx, spec) {
  // spec: {episodeId,type,payload,key?(card)=>bool,skipIfDecided?:bool}
  const st = ctx.store.get();
  st.cards = st.cards || {};
  const match = (c) =>
    c.episodeId === spec.episodeId && c.type === spec.type && (!spec.key || spec.key(c));
  const ids = Object.keys(st.cards);
  for (let i = 0; i < ids.length; i++) {
    const c = st.cards[ids[i]];
    if (c.status === "pending" && match(c)) {
      c.payload = spec.payload;
      c.ver += 1;
      c.updated_at = ctx.util.now();
      enqueueAiReview(ctx, c); // 内容变更 → 重审
      return { card: c, created: false };
    }
  }
  if (spec.skipIfDecided) {
    for (let i = 0; i < ids.length; i++) {
      const c = st.cards[ids[i]];
      if (c.status === "decided" && match(c)) return { card: null, created: false };
    }
  }
  const card = {
    id: ctx.util.uid("card"),
    episodeId: spec.episodeId,
    type: spec.type,
    payload: spec.payload,
    status: "pending",
    ver: 1,
    round: (() => { // 批次号（2026-11-21）：同集同类型第几版——多次重出唯一标识「这批是哪一版」
      let mx = 0;
      for (let i = 0; i < ids.length; i++) {
        const c = st.cards[ids[i]];
        if (c.episodeId === spec.episodeId && c.type === spec.type) mx = Math.max(mx, c.round || 1);
      }
      return mx + 1;
    })(),
    decided_by: null,
    decided_at: null,
    created_at: ctx.util.now()
  };
  st.cards[card.id] = card;
  enqueueAiReview(ctx, card); // 新 pending 卡 → 进审
  return { card, created: true };
}

function publishCard(ctx, event, card) {
  if (!card) return;
  try {
    ctx.bus.publish("cards", { event, card });
  } catch (e) {
    /* bus 未就绪 */
  }
}

/* ---------------- 节点 AI 审查（拍板点自动机检，2026-11-21） ---------------- */

const AI_REVIEW_TYPES = ["C1", "C2", "C4", "C6"];

/** pending 卡进审：免重派（有在途 aireview 即跳过）；审查结果由 onAiReviewDone 回写 payload.ai_review */
function enqueueAiReview(ctx, card) {
  if (!card || card.status !== "pending" || AI_REVIEW_TYPES.indexOf(card.type) < 0) return null;
  if ((card.payload || {}).ai_review) return null; // 已带审查（edit 合并保留旧审）
  const jobs = typeof ctx.engine.listJobs === "function" ? ctx.engine.listJobs({}) : []; // listJobs 只认 episodeId/status，cardId 自行过滤
  const inFlight = jobs.some((jb) => jb && (jb.payload || {}).cardId === card.id && (jb.status === "queued" || jb.status === "running"));
  if (inFlight) return null;
  return ctx.engine.enqueue(
    "aireview",
    { cardId: card.id, episodeId: card.episodeId },
    { episodeId: card.episodeId, initiated_by: "system", free: true }
  );
}

function onAiReviewDone(ctx, job, episodeId) {
  const st = ctx.store.get();
  const cardId = (job.payload || {}).cardId;
  const card = (st.cards || {})[cardId];
  if (!card || card.status !== "pending") return false;
  const art = job.art || job.result || {};
  if (!Array.isArray(art.personas) || !art.personas.length) return false;
  card.payload = Object.assign({}, card.payload, {
    ai_review: { verdict: art.verdict || "pass", engine: art.engine || "规则机检", personas: art.personas, ts: ctx.util.now() }
  });
  card.ver += 1; // 卡内容变更必 ver++
  try {
    const w = card.payload.ai_review.verdict;
    ctx.bus.publish("alerts", {
      id: ctx.util.uid("al"),
      kind: "ai_review",
      msg: "AI 审查完成：" + card.type + " 卡 " + (w === "pass" ? "通过" : w === "warn" ? "有提醒" : "有硬伤") + "，等你拍板。",
      ts: ctx.util.now(),
      acked: false
    });
  } catch (e2) { /* 提示失败不阻断 */ }
  card.updated_at = ctx.util.now();
  publishCard(ctx, "updated", card);
  return true;
}

/* ---------------- 素材合成（stub 假数据，确定性） ---------------- */

function synthesizeCasting(ctx, episodeId) {
  const actors = [];
  for (let i = 1; i <= 4; i++) {
    const candidates = [];
    for (let j = 1; j <= 4; j++) {
      const h = ctx.util.hash12({ episodeId, actor: i, cand: j, k: "casting" });
      candidates.push({
        id: "cand_" + h,
        name: "演员候选 " + i + "-" + j,
        style: ["清冷", "明艳", "英气", "沉稳"][(j - 1) % 4],
        score: 60 + (parseInt(h.slice(0, 2), 16) % 40),
        art: "var/out/cast_" + h + ".png"
      });
    }
    actors.push({ id: "actor_" + i, role: "角色 " + i, name: "人物 " + i, candidates });
  }
  return { actors, note: "定妆照 4 候选/人 · 机检通过" };
}

function realStoryboardImages(ctx, episodeId) {
  // 从 C2 卡取真实分镜图（seq→shotId 已绑定）；不足或缺失则回退 stub
  const st = ctx.store.get();
  const cards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
  const c2 = cards.find((x) => x.episodeId === episodeId && x.type === "C2");
  const images = (c2 && c2.payload && c2.payload.images) || [];
  const ok = images.filter((im) => im.art && im.shotId);
  if (!ok.length) return null;
  return { images: ok, note: "分镜首帧（真机）· 逐格可查" };
}

function synthesizeStoryboard(ctx, episodeId) {
  const shots = shotsOf(ctx, episodeId);
  return {
    images: shots.map((sh) => ({
      shotId: sh.id,
      seq: sh.seq,
      art: "var/out/sb_" + ctx.util.hash12({ episodeId, shotId: sh.id, k: "sb" }) + ".png"
    })),
    note: "分镜图已生成 · 逐格可查"
  };
}

function synthesizeMusicCandidates(ctx, episodeId, sceneId, mood) {
  const out = [];
  for (let j = 1; j <= 3; j++) {
    const h = ctx.util.hash12({ episodeId, sceneId, mood, j, k: "music" });
    const unlicensed = j === 1; // 首条为“未许可”演示曲（契约 §8 曲库策略语义）
    out.push({
      id: "mus_" + h,
      title: (unlicensed ? "未许可演示曲-" : "配乐候选-") + h.slice(0, 4),
      mood: mood || "中性",
      sec: 30 + (parseInt(h.slice(0, 2), 16) % 31),
      engine: "ACE-Step 1.5",
      license: { model: "MIT", usage: unlicensed ? "missing" : "ok" },
      shadow_cents: 5 + (parseInt(h.slice(2, 4), 16) % 11),
      sceneId: sceneId || null,
      episodeId
    });
  }
  return out;
}

function normalizeCandidates(ctx, job, episodeId) {
  const art = (job && (job.art || job.result)) || {};
  const payload = (job && job.payload) || {};
  let raw = art.candidates;
  let list;
  if (Array.isArray(raw) && raw.length) {
    list = raw.slice(0, 3).map((c, j) => Object.assign({}, c, {
      id: c.id || "mus_" + ctx.util.hash12({ episodeId, sceneId: payload.sceneId, j, k: "mus" }),
      title: c.title || ("配乐候选-" + (j + 1)),
      mood: c.mood || payload.mood || "中性",
      sec: c.sec || 30 + (j * 10),
      engine: c.engine || "ACE-Step 1.5",
      license: c.license || { model: "MIT", usage: "ok" },
      shadow_cents: typeof c.shadow_cents === "number" ? c.shadow_cents : 10,
      sceneId: c.sceneId || payload.sceneId || null,
      episodeId
    }));
  } else {
    list = synthesizeMusicCandidates(ctx, episodeId, payload.sceneId, payload.mood);
  }
  return list;
}

/* ---------------- 场景/镜头物化（C1 accept 时） ---------------- */

function ensureScenesAndShots(ctx, episode, card) {
  const st = ctx.store.get();
  const existing = scenesOf(ctx, episode.id);
  if (existing.length) return { scenes: existing, shots: shotsOf(ctx, episode.id) };
  const payload = (card && card.payload) || {};
  // 剧本是结构化源头（契约：episodes POST script）：有 script.scenes 时以其为准，
  // C1 plan 的场景仅为无剧本时的兜底（2026-11-21 修复：H3 线镜 5-8 未物化）。
  const scriptScenes = episode.script && Array.isArray(episode.script.scenes) ? episode.script.scenes : null;
  const planScenes = scriptScenes && scriptScenes.length
    ? scriptScenes
    : (Array.isArray(payload.scenes) && payload.scenes.length ? payload.scenes : DEFAULT_SCENES);
  st.scenes = st.scenes || {};
  st.shots = st.shots || {};
  const scenes = [];
  planScenes.forEach((ps, i) => {
    const sc = {
      id: ctx.util.uid("sc"),
      episodeId: episode.id,
      name: ps.name || "场" + (i + 1),
      mood: ps.mood || "中性",
      seq: i + 1
    };
    st.scenes[sc.id] = sc;
    scenes.push(sc);
    const n = Array.isArray(ps.shots) && ps.shots.length ? ps.shots.length : SHOTS_PER_SCENE;
    for (let j = 1; j <= n; j++) {
      // 剧本是结构化源头：sec/tier/width/height 从 ep.script.scenes 透传（H3 线 2026-11-21）
      const ss = (episode.script && Array.isArray(episode.script.scenes) && episode.script.scenes[i] && Array.isArray(episode.script.scenes[i].shots)) ? (episode.script.scenes[i].shots[j - 1] || {}) : {};
      const sh = {
        id: ctx.util.uid("sh"),
        sceneId: sc.id,
        episodeId: episode.id,
        seq: (i + 1) * 100 + j,
        name: sc.name + "-镜" + j,
        sec: Number(ss.sec) > 0 ? Number(ss.sec) : 5,
        tier: ss.tier === "high" ? "high" : undefined,
        width: Number(ss.width) > 0 ? Number(ss.width) : undefined,
        height: Number(ss.height) > 0 ? Number(ss.height) : undefined,
        status: "pending",
        takes: [],
        rerolls: 0,
        flags: { stale: false }
      };
      st.shots[sh.id] = sh;
    }
  });
  return { scenes, shots: shotsOf(ctx, episode.id) };
}

/* ---------------- accept 推进（链式派生） ---------------- */

function adoptedForScene(ctx, sceneId) {
  const st = ctx.store.get();
  return (st.music_lib || []).some((m) => m.sceneId === sceneId);
}

function pendingForScene(ctx, episodeId, sceneId) {
  const st = ctx.store.get();
  return ((st.music_pending || {})[episodeId] || []).some((c) => c.sceneId === sceneId);
}

function advanceOnAccept(ctx, card, episode, operator) {
  const derived = [];
  const epId = card.episodeId;
  const t = card.type;

  if (t === "C1") {
    ensureScenesAndShots(ctx, episode || { id: epId }, card);
    const job = ctx.engine.enqueue(
      "storyboard",
      { episodeId: epId },
      // Spark 通道启用 → storyboard 走 imgspark（结构化 no-op，分镜首帧由 storyboard_char 在试妆后产出）
      { episodeId: epId, initiated_by: "user", tier: ctx.cfg && ctx.cfg.comfySpark && ctx.cfg.comfySpark.enabled ? "high" : undefined }
    );
    derived.push({ kind: "job", job });
  } else if (t === "C2") {
    const cast = ((card.payload || {}).actors || []).map((a) => {
      const pick = (a.candidates || [])[0] || null;
      return { actorId: a.id, role: a.role, name: a.name, chosen: pick };
    });
    const r = upsertCard(ctx, {
      episodeId: epId,
      type: "C3",
      payload: { cast, note: "演员表锁定（选定首选定妆）" },
      skipIfDecided: true
    });
    if (r.created) {
      publishCard(ctx, "created", r.card);
      derived.push({ kind: "card", card: r.card });
    }
  } else if (t === "C3") {
    const realImages = realStoryboardImages(ctx, epId);
    const r = upsertCard(ctx, {
      episodeId: epId,
      type: "C4",
      payload: realImages || synthesizeStoryboard(ctx, epId),
      skipIfDecided: true
    });
    if (r.created) {
      publishCard(ctx, "created", r.card);
      derived.push({ kind: "card", card: r.card });
    }
  } else if (t === "C4") {
    // H3 全家桶线（2026-11-21 用户裁决）：台词/歌声由 H3 视频音画直出（vidspark FL2VA/R2VA），
    // 不派独立 TTS/配乐/预览混流——样片即开机后的真视频。直接进 C5 预算确认。
    // 旧链（stub 时代：voice/music/compose preview）仅在 Spark 通道关闭时保留。
    const sparkOn = !!(ctx.cfg && ctx.cfg.comfySpark && ctx.cfg.comfySpark.enabled);
    if (sparkOn) {
      const r = upsertCard(ctx, {
        episodeId: epId,
        type: "C5",
        payload: {
          note: "H3 全家桶：台词与歌声由视频生成时音画直出，无独立配音/配乐环节；确认预算后开机拍摄",
          h3_direct: true
        },
        skipIfDecided: true
      });
      if (r.created) {
        publishCard(ctx, "created", r.card);
        derived.push({ kind: "card", card: r.card });
      }
    } else {
      const scenes = scenesOf(ctx, epId);
      const project = projectOf(ctx, episode);
      const musicEnabled = !(project && project.music_enabled === false);
      scenes.forEach((sc) => {
        const job = ctx.engine.enqueue(
          "voice",
          { episodeId: epId, sceneId: sc.id, text: sc.name },
          { episodeId: epId, initiated_by: "user" }
        );
        derived.push({ kind: "job", job });
      });
      if (musicEnabled) {
        scenes.forEach((sc) => {
          if (adoptedForScene(ctx, sc.id) || pendingForScene(ctx, epId, sc.id)) return;
          const job = ctx.engine.enqueue(
            "music",
            { episodeId: epId, sceneId: sc.id, mood: sc.mood },
            { episodeId: epId, initiated_by: "user" }
          );
          derived.push({ kind: "job", job });
        });
      }
      const job = ctx.engine.enqueue(
        "compose",
        { episodeId: epId, purpose: "preview" },
        { episodeId: epId, initiated_by: "user" }
      );
      derived.push({ kind: "job", job });
    }
  } else if (t === "C5") {
    const { estimateBreakdown } = require("./episodes.js");
    const project = projectOf(ctx, episode);
    const est = estimateBreakdown(ctx, { id: epId }, project);
    if (episode) {
      episode.estimate_ver = ctx.util.hash12({
        episodeId: epId,
        breakdown: est.breakdown,
        time_min: est.time_min,
        shots: est.shots
      });
      episode.est = { time_min: est.time_min, cents: est.cents, shots: est.shots };
    }
    // 开机批次快照（2026-11-21）：C6 卡唯一标识本次开机用哪个版本的素材——
    // 每镜首帧来源（试妆第几版的哪个角度帧），拍板前一眼看清「开机 = 拍这一批」
    const stSnap = ctx.store.get();
    const c2cur = Object.keys(stSnap.cards || {}).map((k) => stSnap.cards[k])
      .filter((c) => c.episodeId === epId && c.type === "C2")
      .sort((a, b) => (b.ver || 0) - (a.ver || 0))[0];
    const c2sDec = Object.keys(stSnap.cards || {}).map((k) => stSnap.cards[k])
      .filter((c) => c.episodeId === epId && c.type === "C2S" && c.status === "decided")
      .sort((a, b) => (b.decided_at || 0) - (a.decided_at || 0))[0];
    const r = upsertCard(ctx, {
      episodeId: epId,
      type: "C6",
      payload: {
        estimate: { shots: est.shots, time_min: est.time_min, cents: est.cents },
        breakdown: est.breakdown,
        estimate_ver: episode ? episode.estimate_ver : null,
        snapshot: {
          castRound: (c2sDec && c2sDec.round) || null,
          frames: ((c2cur && c2cur.payload && c2cur.payload.images) || [])
            .filter((im) => im && im.art)
            .map((im) => ({ seq: im.seq, angle: im.refAngle || null, t: im.refT != null ? im.refT : null, file: String(im.art || "").replace(/^.*[\\/]/, "") }))
        },
        note: "开机确认：接受后以 ver 调 POST /api/episodes/:id/shoot"
      },
      skipIfDecided: true
    });
    if (r.created) {
      publishCard(ctx, "created", r.card);
      derived.push({ kind: "card", card: r.card });
    }
  } else if (t === "C2S") {
    // 试妆试镜拍板 → 固化多角度抽帧参考（viewRefs＝分镜选帧的身份输入源）→ 派角色分镜
    // （幂等：本次拍板已出过分镜卡/同款任务在跑 → 不重派，derived 里带 deduped 标记）
    const role = refineViewRefs(ctx, epId, card);
    if (role) {
      const r = enqueueStoryboardChar(ctx, epId, { initiated_by: "user" });
      derived.push({ kind: r.deduped ? "deduped" : "job", job: r.job && r.job.id ? r.job : null, deduped: r.deduped });
    }
  } else if (t === "C9") {
    const st = ctx.store.get();
    const p = card.payload || {};
    const pend = (st.music_pending || {})[epId] || [];
    const cands = Array.isArray(p.candidates) && p.candidates.length
      ? p.candidates
      : pend.filter((c) => c.sceneId === p.sceneId);
    let chosen = null;
    if (p.candidateId) chosen = cands.filter((c) => c.id === p.candidateId)[0] || null;
    if (!chosen) chosen = cands.filter((c) => c.license && c.license.usage === "ok")[0] || cands[0] || null;
    if (!chosen) throw { code: "NOT_FOUND", message: "无可用候选，请先换一批" };
    const res = musicMod.adoptCandidate(ctx, chosen.id, p.sceneId);
    derived.push({ kind: "music", music: res.entry });
  }
  // C6/C7/C8 accept：仅决策留痕，无进一步派生
  return derived;
}

/** 从已拍板的 C2S 卡固化 viewRefs（可重入：阈值调整/勾选变更后刷新，不重渲试妆）。
 *  0.45 弱同人下限：同源试妆帧血缘明确（首帧=原图、时间轴连续），用户拍板高于机检硬线。 */
function refineViewRefs(ctx, episodeId, c2sCard) {
  const st = ctx.store.get();
  const p2 = (c2sCard && c2sCard.payload) || {};
  const role = p2.role || "主角色";
  const roleSeg = String(role).replace(/[^A-Za-z0-9._-]/g, "_") || "role";
  st.viewRefs = st.viewRefs || {};
  st.viewRefs[episodeId] = st.viewRefs[episodeId] || {};
  const fs = require("fs");
  const path = require("path");
  const vdir = path.join(process.cwd(), "var", "assets", "cast", roleSeg, "views");
  fs.mkdirSync(vdir, { recursive: true });
  const refs = [];
  (p2.views || []).forEach((v) => {
    if (!v || !v.art) return;
    if (v.selected === false) return; // 用户取消勾选的帧不收
    if (v.score != null && v.score < 0.45) return; // <0.45 疑似换人，硬线
    const name = String(v.art).replace(/^.*[\\/]/, "");
    const src = [path.join(process.cwd(), "var", "out", name), path.join(process.cwd(), "var", "assets", "cast", name)]
      .find((x) => fs.existsSync(x));
    if (!src) return;
    if (path.resolve(path.dirname(src)).toLowerCase() !== path.resolve(vdir).toLowerCase()) {
      fs.copyFileSync(src, path.join(vdir, name));
    }
    refs.push({ art: "var/assets/cast/" + roleSeg + "/views/" + name, t: v.t, score: v.score, angle: v.angle });
  });
  st.viewRefs[episodeId][role] = refs;
  return refs.length ? role : null;
}

/* scriptgen 入参组装（一句话/小说→剧本；节拍模板快照随行） */
function scriptgenPayload(ctx, ep) {
  const st = ctx.store.get();
  const tpl = ep && ep.template_id && st.templates ? st.templates[ep.template_id] : null;
  return {
    episodeId: ep.id,
    title: ep.title || "",
    brief: ep.brief || "",
    kind: ep.kind === "novel" ? "novel" : "one_liner",
    template: tpl ? { genre: tpl.genre, beats: tpl.beats, style: tpl.style } : null
  };
}

/** 幂等派单统一出口（2026-11-21「反复点击生成一大堆任务」根治）：
 *  引擎有 enqueueOnce（内存+账本双重活任务判定，重启不破）则走幂等；返回统一形状
 *  { deduped, job }——job 为新派任务或已在跑的同款任务（调用方 reJob.id/regenerating 均可用）。 */
function idemEnqueue(ctx, type, payload, opts) {
  if (ctx.engine.enqueueOnce) {
    const r = ctx.engine.enqueueOnce(type, payload, opts);
    return { deduped: !!r.deduped, job: r.job || r.existing || null };
  }
  return { deduped: false, job: ctx.engine.enqueue(type, payload, opts) };
}
/** job 快照附加 __deduped 标记（浅拷贝，不污染引擎内存对象）——前端据此提示「未重复派」 */
function withDedup(r) {
  if (!r || !r.job) return null;
  return Object.assign({}, r.job, { __deduped: !!r.deduped });
}

/** 角色分镜（storyboard_char）幂等派单＋产物级防重（2026-11-21）：
 *  ①产物级：本集已有 pending C2 且生成时间晚于最新拍板 C2S——本次拍板已派过且分镜卡已出（等用户拍板）
 *    → 跳过不重派（除非 force，如 viewrefs/refresh 显式重出）。
 *  ②任务级：enqueueOnce 同集活 storyboard_char（内存+账本）不重派。 */
function enqueueStoryboardChar(ctx, epId, opts) {
  const force = !!(opts && opts.force);
  const initiatedBy = (opts && opts.initiated_by) || "user";
  const st = ctx.store.get();
  if (!force) {
    const c2sDecided = Object.keys(st.cards || {}).map((k) => st.cards[k])
      .filter((c) => c.episodeId === epId && c.type === "C2S" && c.status === "decided")
      .sort((a, b) => (b.decided_at || 0) - (a.decided_at || 0))[0];
    if (c2sDecided) {
      const freshPendingC2 = Object.keys(st.cards || {}).map((k) => st.cards[k])
        .find((c) => c.episodeId === epId && c.type === "C2" && c.status === "pending"
          && (c.created_at || 0) >= (c2sDecided.decided_at || 0));
      if (freshPendingC2) return { deduped: true, job: freshPendingC2, existingCard: freshPendingC2 };
    }
  }
  const r = idemEnqueue(
    ctx,
    "storyboard_char",
    { episodeId: epId },
    { episodeId: epId, initiated_by: initiatedBy, tier: ctx.cfg && ctx.cfg.comfySpark && ctx.cfg.comfySpark.enabled ? "high" : undefined }
  );
  return r;
}

function reEnqueueOnReject(ctx, card, body) {
  const epId = card.episodeId;
  const opts = { episodeId: epId, initiated_by: "user" };
  switch (card.type) {
    case "C1": {
      // 无剧本集（一句话/小说/纯 brief）驳回重出＝重派 LLM 剧本生成——不再反复落占位结构；
      // scriptgen 出的剧本驳回＝重新生成一版（用户要的是新方向，不是重贴同一剧本）
      const st = ctx.store.get();
      const ep = (st.episodes || {})[epId];
      const hasScript = ep && ep.script && Array.isArray(ep.script.scenes) && ep.script.scenes.length;
      if (ep && (!hasScript || ep.script_source === "scriptgen")) {
        return ctx.engine.enqueue("scriptgen", scriptgenPayload(ctx, ep), Object.assign(opts, { free: true }));
      }
      // tier 随 Spark 通道（对齐 C2/C3 分支）：LLM 在线时缺 tier 会让 c1plan 落本机 img5060 被 GPU 闸 409
      return withDedup(idemEnqueue(ctx, "c1plan", { episodeId: epId }, Object.assign(opts, {
        tier: ctx.cfg && ctx.cfg.comfySpark && ctx.cfg.comfySpark.enabled ? "high" : undefined
      })));
    }
    case "C2":
      // 分镜图由 storyboard_char 产出（试妆抽帧换背景壳）——驳回重出＝重跑角色分镜（幂等：活任务不重派）
      return withDedup(idemEnqueue(ctx, "storyboard_char", { episodeId: epId }, Object.assign(opts, { tier: ctx.cfg && ctx.cfg.comfySpark && ctx.cfg.comfySpark.enabled ? "high" : undefined })));
    case "C3":
      return withDedup(idemEnqueue(ctx, "storyboard_char", { episodeId: epId }, Object.assign(opts, { tier: ctx.cfg && ctx.cfg.comfySpark && ctx.cfg.comfySpark.enabled ? "high" : undefined })));
    case "C2S": {
      // 试妆重出：驳回意见（edit 留的 note / 本次 reject 附言）→ 试妆动作提示（幂等：同角色活任务不重派）
      const p = card.payload || {};
      const note = ((body && body.payload && body.payload.note) || p.note || "").trim() || undefined;
      return withDedup(idemEnqueue(
        ctx,
        "screen_test",
        { episodeId: epId, role: p.role || undefined, note },
        opts
      ));
    }
    case "C4": {
      // 配音重出：重派全场景 voice（真 TTS 重渲染，产物落盘并持久化）
      const scenes2 = scenesOf(ctx, epId);
      let first = null;
      (scenes2 || []).forEach((sc) => {
        const jb = ctx.engine.enqueue("voice", { episodeId: epId, sceneId: sc.id, text: sc.name }, { episodeId: epId, initiated_by: "user" });
        if (!first) first = jb;
      });
      return first;
    }
    case "C5":
      return ctx.engine.enqueue("compose", { episodeId: epId, purpose: "preview" }, opts);
    case "C9": {
      const p = card.payload || {};
      return ctx.engine.enqueue(
        "music",
        { episodeId: epId, sceneId: p.sceneId, mood: p.mood },
        opts
      );
    }
    default:
      return null;
  }
}

/* ---------------- jobs-done 监听（链式推进的心脏） ---------------- */

function onPlanDone(ctx, job, episodeId) {
  const st = ctx.store.get();
  const ep = (st.episodes || {})[episodeId] || {};
  // 剧本是结构化源头（契约：POST /episodes script）：C1 卡必须呈现真实内容——
  // 梗概＋人物表＋分场分镜表（画面描述＋台词）。job.art.plan 只作无剧本兜底。
  const script = ep.script && Array.isArray(ep.script.scenes) && ep.script.scenes.length ? ep.script : null;
  const art = job.art || job.result || {};
  const plan = art.plan || null;
  let payload;
  if (script) {
    payload = {
      summary: ep.brief || (plan && plan.summary) || "故事策划已就位",
      scenes: script.scenes.map((sc) => ({
        name: sc.name,
        mood: sc.mood,
        shots: (sc.shots || []).map((sh) => ({
          desc: sh.desc || "",
          sec: sh.sec || 5,
          cast: sh.cast || [],
          dialogue: sh.dialogue || ""
        }))
      })),
      cast: (script.cast || []).map((c) => ({ role: c.role, name: c.name, desc: c.desc || "" }))
    };
  } else {
    payload = plan && typeof plan === "object"
      ? Object.assign({}, plan, { summary: ep.brief || plan.summary || "故事策划已就位", scenes: Array.isArray(plan.scenes) && plan.scenes.length ? plan.scenes : DEFAULT_SCENES.map((s) => Object.assign({}, s)) })
      : { summary: ep.brief || "故事策划已就位", scenes: DEFAULT_SCENES.map((s) => Object.assign({}, s)) };
  }
  const r = upsertCard(ctx, { episodeId, type: "C1", payload, skipIfDecided: true });
  if (r.created) publishCard(ctx, "created", r.card);
  else if (r.card) publishCard(ctx, "updated", r.card);
  return true;
}

function onVoiceDone(ctx, job, episodeId) {
  // 台词产物持久化（voice job result 只在内存，重启即失 → compose 依赖它做台词混流）
  const st = ctx.store.get();
  const lines = ((job.art || job.result || {}).lines) || [];
  if (!lines.length) return false;
  st.voice_lines = st.voice_lines || {};
  const cur = (st.voice_lines[episodeId] || []).slice();
  const byText = {};
  cur.forEach((l) => { if (l && l.text) byText[l.text] = l; });
  lines.forEach((l) => {
    if (l && l.text && l.art && !byText[l.text]) {
      byText[l.text] = { text: l.text, art: l.art, seconds: l.seconds || null, cast: l.cast || null, sceneName: l.sceneName || null, seq: l.seq || null };
    }
  });
  st.voice_lines[episodeId] = Object.values(byText);
  return true;
}

function onStoryboardDone(ctx, job, episodeId) {
  const st = ctx.store.get();
  const art = job.art || job.result || {};
  const ep2 = (st.episodes || {})[episodeId];
  const cast = (ep2 && ep2.script && ep2.script.cast) || [];
  const comfyOn = !!(ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.enabled);
  const allCards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
  let payload;
  if (comfyOn && cast.length) {
    // 真实模式：角色定义即选角卡主体；初始定妆＝用户确认的 refImage（上传/生成后确认），
    // 未确认的角色等待用户在卡上操作——不再自动派 casting 生成定妆
    payload = {
      actors: cast.map((cc, i) => {
        // 继承既有定妆（按 role 匹配任意旧 C2）：脸不重掷
        const prev = allCards.find((x) => x.episodeId === episodeId && x.type === "C2" && (x.payload && x.payload.actors || []).some((pa) => pa.role === cc.role && ((pa.candidates || [])[0] || {}).art));
        const prevActor = prev && (prev.payload.actors || []).find((pa) => pa.role === cc.role);
        const prevCand = prevActor && (prevActor.candidates || []).filter((x) => x.art);
        let candidates;
        if (prevCand && prevCand.length) candidates = prevCand;
        else if (cc.refImage) candidates = [{ id: "cand_ref_" + i, name: "初始定妆（已确认）", art: String(cc.refImage).indexOf("var/") === 0 ? cc.refImage : "var/assets/cast/" + cc.refImage, score: null }];
        else candidates = [{ id: "cand_" + i + "_0", name: "等待初始定妆（上传或生成）", art: null, score: null }];
        return {
          id: "actor_" + i, role: cc.role, name: cc.name, desc: cc.desc, refImage: cc.refImage,
          candidates
        };
      }),
      images: (art.images || []).map(im => im),
      note: cast.every((cc) => cc.refImage)
        ? "角色定义 " + cast.length + " 人 · 初始定妆已确认 · 试妆试镜进行中"
        : "角色定义 " + cast.length + " 人 · 请上传或生成初始定妆图"
    };
  } else {
    payload = art.casting || synthesizeCasting(ctx, episodeId);
  }
  // 分镜图按 seq 绑定 shotId（真实模式 images 带真实产物）
  const shots = shotsOf(ctx, episodeId).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const images = (art.images || []).map((im) => {
    const sh = shots[(im.seq || 1) - 1];
    return Object.assign({}, im, { shotId: sh ? sh.id : null });
  });
  payload.images = images;
  const r = upsertCard(ctx, { episodeId, type: "C2", payload, skipIfDecided: true });
  if (r.created) publishCard(ctx, "created", r.card);
  else if (r.card) publishCard(ctx, "updated", r.card);
  // 数据刷新：新分镜图刷进本集所有 C2/C4（含已拍板卡）——不改任何决策，仅产物更新
  const refreshCards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
  refreshCards.forEach((x) => {
    if (x.episodeId !== episodeId) return;
    if (x.type !== "C2" && x.type !== "C4") return;
    if (x.status === "pending" && x.id === (r.card && r.card.id)) return; // pending 新卡已在 upsert 时写入
    x.payload = Object.assign({}, x.payload, { images: images });
    x.ver += 1;
    x.updated_at = ctx.util.now();
    publishCard(ctx, "updated", x);
  });
  // 试妆试镜流程（2026-11-21）：初始定妆齐 → 派试妆试镜（C2S 拍板后才进分镜）；
  // 初始图只能「上传」或「cast_init 生成后确认」，不再自动派 casting 生成定妆
  if (comfyOn && cast.length && cast.every((cc) => cc.refImage)) {
    // 幂等派试妆（2026-11-21）：逐角色活任务防重（内存+账本），重复触发不再堆同款任务
    cast.forEach((cc) => {
      idemEnqueue(ctx, "screen_test", { episodeId: episodeId, role: cc.role }, { episodeId: episodeId, initiated_by: "system" });
    });
  }
  return true;
}

function onStoryboardCharDone(ctx, job, episodeId) {
  const st = ctx.store.get();
  const art = job.art || job.result || {};
  const images = (art.images || []);
  const shots = shotsOf(ctx, episodeId).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const bound = images.map((im) => {
    const sh = shots[(im.seq || 1) - 1];
    return Object.assign({}, im, { shotId: sh ? sh.id : null });
  });
  const cards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
  cards.forEach((x) => {
    if (x.episodeId !== episodeId) return;
    if (x.type !== "C2" && x.type !== "C4") return;
    const old = (x.payload && x.payload.images) || [];
    const merged = old.filter((im) => !bound.some((b) => b.seq === im.seq)).concat(bound).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    x.payload = Object.assign({}, x.payload, { images: merged });
    x.ver += 1;
    x.updated_at = ctx.util.now();
    publishCard(ctx, "updated", x);
  });
  return bound.length > 0;
}

/** cast_init done：AI 生成的初始定妆图追加为该角色候选（用户卡上确认后才固化 refImage） */
function onCastInitDone(ctx, job, episodeId) {
  const st = ctx.store.get();
  const art = job.art || job.result || {};
  const role = art.role || (job.payload || {}).role;
  if (!art.art || !role) return false;
  const cards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
  const c2 = cards.find((x) => x.episodeId === episodeId && x.type === "C2" && x.status === "pending");
  if (!c2) return false;
  const actors = (c2.payload || {}).actors || [];
  const target = actors.find((a) => a.role === role);
  if (!target) return false;
  const cands = (target.candidates || []).filter((c) => c && c.art);
  cands.push({ id: "cand_init_" + cands.length + "_" + String(job.id).slice(-4), name: "AI 初始图（提示词生成）", art: art.art, score: null });
  target.candidates = cands;
  c2.ver += 1;
  c2.updated_at = ctx.util.now();
  try { ctx.bus.publish("cards", { event: "updated", card: c2 }); } catch (e) {}
  return true;
}

/** screen_test done：出 C2S 试妆试镜卡（试妆视频＋抽帧网格＋多角度候选＋确认清单） */
function onScreenTestDone(ctx, job, episodeId) {
  const art = job.art || job.result || {};
  if (!art.art) return false;
  const r = upsertCard(ctx, {
    episodeId,
    type: "C2S",
    payload: {
      role: art.role || (job.payload || {}).role || "主角色",
      video: {
        art: art.art,
        sec: art.sec || 10.13,
        frames: art.frames || 243,
        width: (art.meta && art.meta.width) || 736,
        height: (art.meta && art.meta.height) || 1312
      },
      grid: art.grid || null,
      refImage: art.refImage || null,
      views: (art.views || []),
      checklist: art.checklist || ["五官与脸型", "身材与体态", "服装与细节", "多角度头部人脸（按分镜需求）"],
      note: "试妆试镜：看视频确认五官/身材/服装与多角度人脸；拍板后抽帧固化为分镜参考（分镜只换背景）"
    }
  });
  if (r.created) publishCard(ctx, "created", r.card);
  else if (r.card) publishCard(ctx, "updated", r.card);
  return true;
}

function onCastingDone(ctx, job, episodeId) {
  const st = ctx.store.get();
  const art = job.art || job.result || {};
  const actor = art.actor || { idx: (job.payload || {}).castIdx };
  // 找本集 pending 的 C2 卡，把真定妆图回填到对应角色首个候选
  const cards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
  const c2 = cards.find((x) => x.episodeId === episodeId && x.type === "C2" && x.status === "pending");
  if (!c2 || !art.art) return false;
  const actors = (c2.payload || {}).actors || [];
  const target = actors[actor.idx] || actors.find((a) => a.role === actor.role);
  if (!target) return false;
  target.candidates = [{
    id: "cand_" + actor.idx + "_0",
    name: "定妆·真机（自部署）",
    art: art.art,
    score: null
  }];
  const pendingCast = actors.filter((a) => !(a.candidates || [])[0] || !(a.candidates[0] || {}).art).length;
  c2.payload.note = pendingCast
    ? "角色定义 " + actors.length + " 人 · 定妆生成中（剩 " + pendingCast + " 人）"
    : "角色定义 " + actors.length + " 人 · 定妆齐（真机）";
  if (pendingCast === 0 && ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.enabled) {
    // 全员定妆齐 → 派试妆试镜（C2S 拍板后才进分镜；试妆试镜流程 2026-11-21）
    const st2 = ctx.store.get();
    const ep2 = (st2.episodes || {})[episodeId] || {};
    const cast2 = (ep2.script && ep2.script.cast) || [];
    const castList = cast2.length ? cast2 : [{ role: (art.actor || {}).role || "主角色" }];
    // 幂等派试妆（2026-11-21）：逐角色活任务防重（内存+账本），重复触发不再堆同款任务
    castList.forEach((cc) => {
      idemEnqueue(ctx, "screen_test", { episodeId: episodeId, role: cc.role }, { episodeId: episodeId, initiated_by: "system" });
    });
  }
  c2.ver += 1;
  c2.updated_at = ctx.util.now();
  try { ctx.bus.publish("cards", { event: "updated", card: c2 }); } catch (e) {}
  return true;
}

function onVideoDone(ctx, job, episodeId) {
  const payload = job.payload || {};
  const st = ctx.store.get();
  const shot = (st.shots || {})[payload.shotId];
  if (!shot) return false;
  const art = job.art || job.result || {};
  const take = art.take || {
    id: ctx.util.uid("tk"),
    engine: art.engine ? "自部署·标准档" : "自部署·标准档", // 语言表纪律：用户面不带型号
    cost_cents: typeof art.cost_cents === "number" ? art.cost_cents : 80,
    art: art.art || art.path || null,
    license: art.license || { model: "MIT", usage: "ok" }
  };
  shot.takes = (shot.takes || []).concat([take]);
  shot.status = "moderating";
  ctx.engine.enqueue(
    "moderate",
    { episodeId, shotId: shot.id },
    { episodeId, initiated_by: "system" }
  );
  return true;
}

function verdictOf(art) {
  if (art.verdict) return art.verdict;
  if (art.pass === false) return "fail_review";
  if (art.fail_review || art.review || art.need_review) return "fail_review";
  return "pass";
}

function onModerateDone(ctx, job, episodeId) {
  const payload = job.payload || {};
  const st = ctx.store.get();
  const shot = (st.shots || {})[payload.shotId];
  const art = job.art || job.result || {};
  const verdict = verdictOf(art);
  if (shot) {
    if (verdict === "pass") {
      shot.status = "ok";
    } else {
      shot.status = "pending_review";
      const rq = {
        id: ctx.util.uid("rq"),
        shotId: shot.id,
        reason: art.reason || "机审建议人工复审",
        status: "pending",
        sla_left: 24 * 3600,
        ver: 1,
        ts: ctx.util.now()
      };
      st.review_q = st.review_q || [];
      st.review_q.push(rq);
      // C7 ＝每集唯一「复审批复卡」（宪法 3：必答门每集只计一次）。
      // 同集新的不通过镜并入同一张 pending 卡 items；已批复后再有新镜落审则开新批。
      const item = { shotId: shot.id, reviewId: rq.id, reason: rq.reason, at: ctx.util.now() };
      const c7 = Object.keys(st.cards || {})
        .map((k) => st.cards[k])
        .find((c) => c.episodeId === episodeId && c.type === "C7" && c.status === "pending");
      if (c7) {
        const items = Array.isArray((c7.payload || {}).items) ? c7.payload.items : [];
        if (!items.some((x) => x && x.shotId === shot.id)) items.push(item);
        c7.payload = Object.assign({}, c7.payload, {
          items: items,
          shotIds: items.map((x) => x.shotId),
          shotId: items[0] && items[0].shotId,
          reviewId: items[0] && items[0].reviewId,
          reason: rq.reason
        });
        c7.ver += 1;
        c7.updated_at = ctx.util.now();
        publishCard(ctx, "updated", c7);
      } else {
        const r = upsertCard(ctx, {
          episodeId,
          type: "C7",
          payload: {
            items: [item],
            shotIds: [shot.id],
            shotId: shot.id,
            reviewId: rq.id,
            reason: rq.reason
          }
        });
        if (r.created) publishCard(ctx, "created", r.card);
        else if (r.card) publishCard(ctx, "updated", r.card);
      }
      try {
        ctx.bus.publish("review", { event: "submitted", item: rq });
      } catch (e) {}
    }
  }
  maybeFinishShoot(ctx, episodeId);
  try {
    ctx.bus.publish("review", { event: "moderated", episodeId, shotId: payload.shotId, verdict });
  } catch (e) {}
  return true;
}

function onComposeDone(ctx, job, episodeId) {
  const payload = job.payload || {};
  if (payload.purpose === "export") {
    ctx.store.log("audit", {
      operator: null,
      action: "export_artifacts",
      target: episodeId,
      artifacts: (job.art && (job.art.art || job.art.path || job.art)) || null
    });
    try {
      ctx.bus.publish("cards", {
        event: "artifacts",
        episodeId,
        artifacts: job.art || null,
        job_id: job.id
      });
    } catch (e) {}
    return false;
  }
  // 样片 compose → C5
  const r = upsertCard(ctx, {
    episodeId,
    type: "C5",
    payload: { art: job.art || null, purpose: "preview" },
    skipIfDecided: true
  });
  if (r.created) publishCard(ctx, "created", r.card);
  else if (r.card) publishCard(ctx, "updated", r.card);
  return true;
}

function onMusicDone(ctx, job, episodeId) {
  const payload = job.payload || {};
  const sceneId = payload.sceneId || null;
  const st = ctx.store.get();
  st.music_pending = st.music_pending || {};
  const list = (st.music_pending[episodeId] = st.music_pending[episodeId] || []);
  const candidates = normalizeCandidates(ctx, job, episodeId);
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].sceneId === sceneId) list.splice(i, 1); // 换一批：替换该场旧候选
  }
  candidates.forEach((c) => list.push(c));
  let card = null;
  if (sceneId && !adoptedForScene(ctx, sceneId)) {
    const r = upsertCard(ctx, {
      episodeId,
      type: "C9",
      payload: { episodeId, sceneId, mood: payload.mood || "中性", candidates },
      key: (c) => (c.payload || {}).sceneId === sceneId,
      skipIfDecided: true
    });
    card = r.card;
    if (r.created) publishCard(ctx, "created", card);
    else if (card) publishCard(ctx, "updated", card);
  }
  try {
    ctx.bus.publish("cards", { event: "music_candidates", episodeId, sceneId, candidates });
  } catch (e) {}
  return true;
}

function handleJobDone(ctx, evt) {
  if (!evt || evt.event !== "done" || !evt.job) return;
  const job = evt.job;
  if (job.status && job.status !== "done") return;
  const st = ctx.store.get();
  const episodeId =
    (job.opts && job.opts.episodeId) || (job.payload && job.payload.episodeId) || job.episodeId;
  if (!episodeId || !(st.episodes || {})[episodeId]) return;
  let touched = false;
  switch (job.type) {
    case "scriptgen": {
      // 一句话/小说→剧本（2026-11-21 补全）：剧本写回源头 → C1 卡立即呈现（不等海报）；
      // 海报 c1plan 降级为可选增强——本机 LLM 在线时 GPU 闸会拒（GPU_BUSY），缺席无妨。
      const res = job.art || job.result || {};
      const ep = (st.episodes || {})[episodeId];
      if (ep && res.script && Array.isArray(res.script.scenes) && res.script.scenes.length) {
        ep.script = res.script;
        ep.script_source = "scriptgen"; // 来源标记：驳回时按「重新生成」处理（不是重贴同一剧本）
        ctx.store.commit();
      }
      try {
        ctx.engine.enqueue(
          "c1plan",
          { episodeId },
          {
            episodeId,
            initiated_by: "system",
            free: true,
            tier: ctx.cfg && ctx.cfg.comfySpark && ctx.cfg.comfySpark.enabled ? "high" : undefined
          }
        );
      } catch (e) { /* GPU_BUSY 等：海报缺席不阻断 C1 卡 */ }
      touched = onPlanDone(ctx, job, episodeId);
      break;
    }
    case "c1plan":
      touched = onPlanDone(ctx, job, episodeId);
      break;
    case "storyboard":
      touched = onStoryboardDone(ctx, job, episodeId);
      break;
    case "casting":
      touched = onCastingDone(ctx, job, episodeId);
      break;
    case "cast_init":
      touched = onCastInitDone(ctx, job, episodeId);
      break;
    case "screen_test":
      touched = onScreenTestDone(ctx, job, episodeId);
      break;
    case "storyboard_char":
      touched = onStoryboardCharDone(ctx, job, episodeId);
      break;
    case "video":
      touched = onVideoDone(ctx, job, episodeId);
      break;
    case "moderate":
      touched = onModerateDone(ctx, job, episodeId);
      break;
    case "compose":
      touched = onComposeDone(ctx, job, episodeId);
      break;
    case "aireview":
      touched = onAiReviewDone(ctx, job, episodeId);
      break;
    case "music":
      touched = onMusicDone(ctx, job, episodeId);
      break;
    case "voice":
      touched = onVoiceDone(ctx, job, episodeId);
      break;
    default:
      touched = false;
  }
  if (touched) ctx.store.commit();
}

function attachJobDoneListener(ctx) {
  if (!ctx.bus || typeof ctx.bus.on !== "function") return null;
  const handler = (evt) => {
    try {
      handleJobDone(ctx, evt);
    } catch (e) {
      /* 监听器内部异常不得打挂总线 */
    }
  };
  ctx.bus.on("jobs", handler);
  return handler;
}

/* ---------------- 拍摄收官 → C8 ---------------- */

function maybeFinishShoot(ctx, episodeId) {
  const st = ctx.store.get();
  const shots = Object.keys(st.shots || {})
    .map((k) => st.shots[k])
    .filter((s) => s.episodeId === episodeId);
  if (!shots.length) return null;
  const allOk = shots.every((s) => s.status === "ok" && (s.takes || []).length > 0);
  if (!allOk) return null;
  const shotIds = {};
  shots.forEach((s) => {
    shotIds[s.id] = true;
  });
  const pendingReview = (st.review_q || []).some(
    (r) => shotIds[r.shotId] && r.status === "pending"
  );
  if (pendingReview) return null;
  const exists = Object.keys(st.cards || {}).some(
    (k) => st.cards[k].episodeId === episodeId && st.cards[k].type === "C8"
  );
  if (exists) return null;
  const r = upsertCard(ctx, {
    episodeId,
    type: "C8",
    payload: { summary: "全部镜头审核通过", shots: shots.length }
  });
  if (r.created) publishCard(ctx, "created", r.card);
  return r.card;
}

/* ---------------- 路由注册 ---------------- */

function register(router, ctx) {
  const { store, engine, util } = ctx;

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  // GET /api/cards?episodeId=&status=
  router.add(
    "GET",
    "/api/cards",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const q = parseQuery(req);
      const st = store.get();
      let list = Object.keys(st.cards || {}).map((k) => st.cards[k]);
      if (q.episodeId) list = list.filter((c) => c.episodeId === q.episodeId);
      if (q.status) list = list.filter((c) => c.status === q.status);
      list = list.filter((c) => {
        if (c.type !== "C9") return true;
        const ep = (st.episodes || {})[c.episodeId];
        const pj = ep && (st.projects || {})[ep.projectId];
        return !(pj && pj.music_enabled === false); // music_enabled=false 的项目不出 C9
      });
      list.sort(
        (a, b) => (a.created_at || 0) - (b.created_at || 0) || String(a.id).localeCompare(String(b.id))
      );
      return router.json(res, 200, { cards: list });
    },
    { auth: true }
  );

  router.add(
    "POST",
    "/api/cards/:id/suggest",
    async (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const card = (st.cards || {})[params.id];
      if (!card) throw { code: "NOT_FOUND", message: "卡片不存在: " + params.id };
      if (card.type !== "C1") throw { code: "BAD_REQUEST", message: "建议片一期只支持 C1 故事方向卡" };
      if (card.status !== "pending") throw { code: "ALREADY_DECIDED", message: "卡片已决策" };
      const note = String((body || {}).note || "").trim();
      if (!note) throw { code: "BAD_REQUEST", message: "note（修改意见）必填" };
      if (!ctx.llm || !ctx.llm.enabled()) throw { code: "NOT_READY", message: "LLM 未在线（本机 8090 未起或未配置），建议片不可用" };
      const p = card.payload || {};
      const sys = [
        "你是剧场 Studio 的剧本策划顾问。依据修改意见修订分场分镜表，输出 JSON。",
        "硬约束：scenes 数组长度必须与输入一致；每场 shots 长度必须与输入一致；只改 name/mood/desc/dialogue/sec 的内容，不改结构；台词 ≤40 字；sec 取 3–15 整数；cast 只能用输入里出现的角色名。",
        "只输出：{\"reply\":\"给制片人的一句话说明（≤120字）\",\"scenes\":[…完整新数组…]}"
      ].join("\n");
      const usr = "当前卡内容：" + JSON.stringify({ summary: p.summary, cast: p.cast, scenes: p.scenes }).slice(0, 4000) + "\n修改意见：" + note.slice(0, 300);
      const r = await ctx.llm.chat([{ role: "system", content: sys }, { role: "user", content: usr }], { temperature: 0.4, maxTokens: 1600, timeoutMs: 60000 });
      if (!r.ok) throw { code: "NOT_READY", message: "LLM 未给出建议（" + (r.error || "超时") + "），请稍后再试" };
      const m = String(r.content).match(/\{[\s\S]*\}/);
      let reply = "", scenes = null;
      if (m) {
        try {
          const j = JSON.parse(m[0]);
          reply = String(j.reply || "").slice(0, 200);
          if (Array.isArray(j.scenes) && Array.isArray(p.scenes) && j.scenes.length === p.scenes.length) {
            const castRoles = (p.cast || []).map((c) => c.role);
            const ok = j.scenes.every((sc, i) => Array.isArray(sc.shots) && sc.shots.length === (p.scenes[i].shots || []).length);
            if (ok) {
              scenes = j.scenes.map((sc, i) => ({
                name: String(sc.name || p.scenes[i].name).slice(0, 40),
                mood: String(sc.mood || p.scenes[i].mood).slice(0, 20),
                shots: sc.shots.map((sh) => ({
                  desc: String(sh.desc || "").slice(0, 300),
                  sec: Number(sh.sec) > 0 ? Math.min(15, Math.round(Number(sh.sec))) : 5,
                  cast: (Array.isArray(sh.cast) ? sh.cast.map(String) : []).filter((x) => castRoles.indexOf(x) >= 0),
                  dialogue: String(sh.dialogue || "").slice(0, 200)
                }))
              }));
            }
          }
        } catch (e) { /* 解析失败 → scenes=null */ }
      }
      if (!reply && !scenes) throw { code: "NOT_READY", message: "LLM 输出无法解析为结构化修订，请换个说法再试" };
      store.log("audit", { operator: (auth && (auth.uid || auth.id)) || null, action: "card_suggest", target: card.id, note_digest: String(util.hash12({ note })) });
      return router.json(res, 200, { reply: reply || "已按你的意见修订（见下方分镜表）", scenes: scenes });
    },
    { auth: true }
  );
  // POST /api/episodes/:id/viewrefs/refresh — 从本集最新已拍板 C2S 卡重固化 viewRefs（阈值调整后可重入），
  // 并重派选帧分镜（storyboard_char，零生成秒级）
  router.add(
    "POST",
    "/api/episodes/:id/viewrefs/refresh",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const epId = params.id;
      if (!(st.episodes || {})[epId]) throw { code: "NOT_FOUND", message: "剧集不存在: " + epId };
      const c2sList = Object.keys(st.cards || {}).map((k) => st.cards[k])
        .filter((c) => c.episodeId === epId && c.type === "C2S" && c.status === "decided")
        .sort((a, b) => (b.decided_at || 0) - (a.decided_at || 0));
      const card = c2sList[0];
      if (!card) throw { code: "NOT_READY", message: "本集尚无已拍板的试妆试镜卡（C2S）" };
      const role = refineViewRefs(ctx, epId, card);
      if (!role) throw { code: "NOT_READY", message: "固化后参考库为空（帧缺失或全部被勾选取消）" };
      // 幂等（force＝显式重出：跳过产物级判断，仅活任务防重——同一拍板下重复点不再堆任务）
      const r = enqueueStoryboardChar(ctx, epId, { force: true, initiated_by: "user" });
      const vr = (st.viewRefs || {})[epId] || {};
      audit(auth, "viewrefs_refresh", epId, { role, frames: (vr[role] || []).length, job_id: r.job && r.job.id, deduped: r.deduped });
      store.commit();
      return router.json(res, 200, { role, frames: (vr[role] || []).length, job: r.job, deduped: r.deduped });
    },
    { auth: true }
  );

  // DELETE /api/cards/:id — 垃圾批次清理（2026-11-21）：仅允许删未拍板（pending/rejected）卡，
  // 已拍板卡是版本档案不在此删（历史区自动收档）。同时清理卡引用的过程产物（var/out 下
  // art/grid/views/images），防垃圾帧堆积（用户纪律：垃圾数据及时删除）。audit 留痕。
  router.add(
    "DELETE",
    "/api/cards/:id",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const card = (st.cards || {})[params.id];
      if (!card) throw { code: "NOT_FOUND", message: "卡片不存在: " + params.id };
      if (card.status === "decided") throw { code: "PROTECTED", message: "已拍板卡是版本档案，不能删除（历史区自动收档）" };
      const fs = require("fs");
      const path = require("path");
      const outs = [];
      const collect = (rel) => { if (rel && String(rel).indexOf("var/out/") === 0 && outs.indexOf(String(rel)) < 0) outs.push(String(rel)); };
      collect(card.art);
      const p = card.payload || {};
      collect(p.grid);
      (p.views || []).forEach((v) => { if (v && v.art) collect(v.art); });
      (p.images || []).forEach((v) => { if (v && v.art) collect(v.art); });
      outs.forEach((rel) => {
        try { fs.unlinkSync(path.join(process.cwd(), rel)); } catch (e) {}
        try { fs.unlinkSync(path.join(process.cwd(), rel + ".meta.json")); } catch (e) {}
      });
      delete st.cards[card.id];
      store.commit();
      store.log("audit", { operator: (auth && (auth.uid || auth.id)) || null, action: "card_delete", target: card.id, card_type: card.type, round: card.round || null, files_removed: outs.length });
      try { ctx.bus.publish("cards", { event: "deleted", id: card.id }); } catch (e) {}
      return router.json(res, 200, { deleted: card.id, files_removed: outs.length });
    },
    { auth: true }
  );

  // POST /api/cards/:id/views/select {sel:{art:bool}} — C2S 角度帧勾选落库。
  // 修「根本没法勾」bug（2026-11-21）：此前勾选是纯内存态，flow 视图 5s 轮询/SSE cards 事件
  // 重拉卡片即被服务端旧数据覆盖——点击视觉一闪即逝。现按 art 匹配写 payload.views[i].selected
  //（不用 index：viewsOf 过滤了无 art 帧，index 会错位）。不 ver++：勾选是操作态，last-write-win，
  // 不与 decide 的 CAS 竞争；不 publish cards 事件：避免自己触发重拉闪烁。accept 时 payload.views
  // 随决策打包固化（单一真相落库）。
  router.add(
    "POST",
    "/api/cards/:id/views/select",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const card = (st.cards || {})[params.id];
      if (!card) throw { code: "NOT_FOUND", message: "卡片不存在: " + params.id };
      if (card.type !== "C2S") throw { code: "BAD_REQUEST", message: "仅试妆试镜卡（C2S）支持帧勾选" };
      if (card.status !== "pending") throw { code: "ALREADY_DECIDED", message: "卡片已决策，勾选不可再改" };
      const sel = (body || {}).sel || {};
      const views = (card.payload || {}).views || [];
      let n = 0;
      views.forEach((v) => {
        if (v && v.art && Object.prototype.hasOwnProperty.call(sel, v.art)) {
          v.selected = sel[v.art] === false ? false : undefined; // undefined＝默认勾选（JSON 落盘时省略）
          n++;
        }
      });
      if (!n) throw { code: "BAD_REQUEST", message: "sel 中没有匹配到任何帧（按 art 匹配）" };
      card.updated_at = ctx.util.now();
      store.commit();
      return router.json(res, 200, { saved: n, ver: card.ver });
    },
    { auth: true }
  );

  // POST /api/cards/:id/decide {action:"accept|edit|reject",payload?,ver}
  router.add(
    "POST",
    "/api/cards/:id/decide",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const card = (st.cards || {})[params.id];
      if (!card) throw { code: "NOT_FOUND", message: "卡片不存在: " + params.id };
      const b = body || {};
      const action = b.action;
      if (["accept", "edit", "reject"].indexOf(action) < 0) {
        throw { code: "BAD_ACTION", message: "action 必须为 accept|edit|reject" };
      }
      util.cas(card, b.ver); // ver 不符 → {code:"STALE"} → HTTP 409
      const operator = (auth && (auth.uid || auth.id)) || null;
      const episode = (st.episodes || {})[card.episodeId] || null;

      if (action === "edit") {
        card.payload = Object.assign({}, card.payload, b.payload || {});
        card.ver += 1; // 改卡必 ver++
        card.updated_at = util.now();
        enqueueAiReview(ctx, card); // 改卡后若审查缺失（如清旧审）→ 重派（幂等）
        store.commit();
        audit(auth, "card_edit", card.id, { type: card.type });
        publishCard(ctx, "updated", card);
        return router.json(res, 200, { card });
      }

      if (card.status !== "pending") {
        // 重出语义：已拍板的卡产物不满意 → 允许驳回重出（决策留痕不撤、计数不变）
        if (card.status === "decided" && action === "reject") {
          card.status = "rejected";
        } else {
          throw { code: "ALREADY_DECIDED", message: "卡片已决策" };
        }
      }

      if (action === "reject") {
        const reJob = reEnqueueOnReject(ctx, card, b);
        card.ver += 1;
        if (card.type === "C4" && reJob) card.status = "pending"; // 配音卡重出＝回待确认（新产物到位后重新拍板）
        card.payload = Object.assign({}, card.payload, {
          regenerating: !!reJob,
          reject_note: (b.payload && b.payload.note) || null
        });
        card.updated_at = util.now();
        store.commit();
        audit(auth, "card_reject", card.id, { type: card.type, job_id: reJob && reJob.id });
        publishCard(ctx, "updated", card);
        return router.json(res, 200, { card, job: reJob || undefined });
      }

      // accept（可能抛错的操作放前面，抛错则不产生决策）
      if (b.payload) card.payload = Object.assign({}, card.payload, b.payload);
      const derived = advanceOnAccept(ctx, card, episode, operator);
      // 宪法 3：必答门计数＝C1 方向／C2 签约／C6 预算开机（预算触发）／C7 验收／C8 导出确认＝4＋1；
      // C3（默认过）/C4（软确认）/C5（出口在 C6）为软卡不计数，C9 永不计数。
      if (["C1", "C2", "C6", "C7", "C8"].indexOf(card.type) >= 0 && episode) {
        episode.decisions = (episode.decisions || 0) + 1;
      }
      card.status = "decided";
      card.decided_by = operator; // decided_by 取 auth.uid
      card.decided_at = util.now();
      card.ver += 1; // 改卡必 ver++
      if (episode) episode.stage = Math.min(8, 1 + (episode.decisions || 0));
      store.commit();
      audit(auth, "card_accept", card.id, {
        type: card.type,
        decisions: episode ? episode.decisions : null
      });
      publishCard(ctx, "decided", card);
      return router.json(res, 200, {
        card,
        episode: episode || undefined,
        derived: derived.length ? derived : undefined
      });
    },
    { auth: true }
  );

  attachJobDoneListener(ctx);

  // 启动自愈：pending 卡缺审查 → 补派（幂等，审查 free 不计影子成本）
  const st0 = store.get();
  Object.keys(st0.cards || {}).forEach((k) => {
    const cd = st0.cards[k];
    if (cd && cd.status === "pending") enqueueAiReview(ctx, cd);
  });
}

/** 剧本源头变更（script-scenes）后：pending C1 重导出（与 onPlanDone 同口径）＋清旧审＋重派审 */
function refreshPendingC1(ctx, episodeId) {
  const st = ctx.store.get();
  const ep = (st.episodes || {})[episodeId];
  if (!ep || !ep.script) return false;
  const card = Object.keys(st.cards || {}).map((k) => st.cards[k])
    .find((c) => c.episodeId === episodeId && c.type === "C1" && c.status === "pending");
  if (!card) return false;
  const payload = {
    summary: ep.brief || "故事策划已就位",
    scenes: ep.script.scenes.map((sc) => ({
      name: sc.name, mood: sc.mood,
      shots: (sc.shots || []).map((sh) => ({ desc: sh.desc || "", sec: sh.sec || 5, cast: sh.cast || [], dialogue: sh.dialogue || "" }))
    })),
    cast: (ep.script.cast || []).map((c) => ({ role: c.role, name: c.name, desc: c.desc || "" }))
  };
  delete payload.ai_review; // 内容已变，旧审作废（enqueueAiReview 会重派）
  card.payload = payload;
  card.ver += 1;
  card.updated_at = ctx.util.now();
  publishCard(ctx, "updated", card);
  enqueueAiReview(ctx, card);
  return true;
}
module.exports.register = register;
module.exports.refreshPendingC1 = refreshPendingC1;
module.exports.advanceOnAccept = advanceOnAccept;
module.exports.reEnqueueOnReject = reEnqueueOnReject;
module.exports.upsertCard = upsertCard;
module.exports.maybeFinishShoot = maybeFinishShoot;
module.exports.handleJobDone = handleJobDone;
module.exports.attachJobDoneListener = attachJobDoneListener;
module.exports.synthesizeMusicCandidates = synthesizeMusicCandidates;
module.exports.enqueueAiReview = enqueueAiReview; // L2 apply_suggestion 采纳后重派 AI 审（2026-11-22）
