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
    decided_by: null,
    decided_at: null,
    created_at: ctx.util.now()
  };
  st.cards[card.id] = card;
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
  const planScenes = Array.isArray(payload.scenes) && payload.scenes.length ? payload.scenes : DEFAULT_SCENES;
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
      const sh = {
        id: ctx.util.uid("sh"),
        sceneId: sc.id,
        episodeId: episode.id,
        seq: (i + 1) * 100 + j,
        name: sc.name + "-镜" + j,
        sec: 5,
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
      { episodeId: epId, initiated_by: "user" }
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
    const r = upsertCard(ctx, {
      episodeId: epId,
      type: "C6",
      payload: {
        estimate: { shots: est.shots, time_min: est.time_min, cents: est.cents },
        breakdown: est.breakdown,
        estimate_ver: episode ? episode.estimate_ver : null,
        note: "开机确认：接受后以 ver 调 POST /api/episodes/:id/shoot"
      },
      skipIfDecided: true
    });
    if (r.created) {
      publishCard(ctx, "created", r.card);
      derived.push({ kind: "card", card: r.card });
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

function reEnqueueOnReject(ctx, card) {
  const epId = card.episodeId;
  const opts = { episodeId: epId, initiated_by: "user" };
  switch (card.type) {
    case "C1":
      return ctx.engine.enqueue("c1plan", { episodeId: epId }, opts);
    case "C2":
      return ctx.engine.enqueue("storyboard", { episodeId: epId }, opts);
    case "C3":
      return ctx.engine.enqueue("storyboard", { episodeId: epId }, opts);
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
  const art = job.art || job.result || {};
  const plan = art.plan;
  const payload = plan && typeof plan === "object"
    ? Object.assign({}, plan, { scenes: Array.isArray(plan.scenes) && plan.scenes.length ? plan.scenes : DEFAULT_SCENES.map((s) => Object.assign({}, s)) })
    : { summary: "故事策划已就位", scenes: DEFAULT_SCENES.map((s) => Object.assign({}, s)) };
  const r = upsertCard(ctx, { episodeId, type: "C1", payload, skipIfDecided: true });
  if (r.created) publishCard(ctx, "created", r.card);
  else if (r.card) publishCard(ctx, "updated", r.card);
  return true;
}

function onStoryboardDone(ctx, job, episodeId) {
  const st = ctx.store.get();
  const art = job.art || job.result || {};
  const ep2 = (st.episodes || {})[episodeId];
  const cast = (ep2 && ep2.script && ep2.script.cast) || [];
  const comfyOn = !!(ctx.cfg && ctx.cfg.comfy && ctx.cfg.comfy.enabled);
  let payload;
  if (comfyOn && cast.length) {
    // 真实模式：角色定义即选角卡主体；定妆图由 casting 任务异步回填
    payload = {
      actors: cast.map((cc, i) => ({
        id: "actor_" + i, role: cc.role, name: cc.name, desc: cc.desc, refImage: cc.refImage,
        candidates: [{ id: "cand_" + i + "_0", name: "定妆生成中…", art: null, score: null }]
      })),
      images: (art.images || []).map(im => im),
      note: "角色定义 " + cast.length + " 人 · 定妆生成中（真机）"
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
  const allCards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
  allCards.forEach((x) => {
    if (x.episodeId !== episodeId) return;
    if (x.type !== "C2" && x.type !== "C4") return;
    if (x.status === "pending" && x.id === (r.card && r.card.id)) return; // pending 新卡已在 upsert 时写入
    x.payload = Object.assign({}, x.payload, { images: images });
    x.ver += 1;
    x.updated_at = ctx.util.now();
    publishCard(ctx, "updated", x);
  });
    // 真实模式：为缺真定妆的角色派生 casting 任务（onCastingDone 回填 C2）
  if (comfyOn && cast.length) {
    const actors = (r.card && r.card.payload && r.card.payload.actors) || [];
    actors.forEach((a) => {
      if (((a.candidates || [])[0] || {}).art) return;
      const idx = cast.findIndex((cc) => cc.role === a.role);
      if (idx < 0) return;
      ctx.engine.enqueue(
        "casting",
        { episodeId: episodeId, castIdx: idx },
        { episodeId: episodeId, initiated_by: "system" }
      );
    });
  }
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
    case "c1plan":
      touched = onPlanDone(ctx, job, episodeId);
      break;
    case "storyboard":
      touched = onStoryboardDone(ctx, job, episodeId);
      break;
    case "casting":
      touched = onCastingDone(ctx, job, episodeId);
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
    case "music":
      touched = onMusicDone(ctx, job, episodeId);
      break;
    case "voice":
      touched = false;
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
        const reJob = reEnqueueOnReject(ctx, card);
        card.ver += 1;
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
}

module.exports.register = register;
module.exports.upsertCard = upsertCard;
module.exports.maybeFinishShoot = maybeFinishShoot;
module.exports.handleJobDone = handleJobDone;
module.exports.attachJobDoneListener = attachJobDoneListener;
module.exports.synthesizeMusicCandidates = synthesizeMusicCandidates;
