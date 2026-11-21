"use strict";
/**
 * api/episodes.js — 建集/预估/开机（契约 §3）
 * POST /api/episodes → enqueue("c1plan")；卡的链式派生在 cards.js 的 jobs-done 监听里。
 * GET  /api/episodes/:id/estimate → 确定性预估卡（C5 accept 时生成 estimate_ver）。
 * POST /api/episodes/:id/shoot {ver} → cas(estimate_ver) → 16 video job（moderate 由 video done 后逐镜派生）。
 */

const DEFAULT_BUDGET_CENTS = 5000;

// 确定性预估（契约：12×80 + 3×150 + 1×110 分档 ＋ music/tts 行，time_min≈24）
const ESTIMATE_PLAN = {
  time_min: 24,
  lines: [
    { item: "标准镜头（12 镜 × 80 分）", unit: 80, qty: 12, cents: 960, tier: "std" },
    { item: "高价值镜头（3 镜 × 150 分）", unit: 150, qty: 3, cents: 450, tier: "hi" },
    { item: "关键镜头（1 镜 × 110 分）", unit: 110, qty: 1, cents: 110, tier: "key" }
  ]
};

function estimateBreakdown(ctx, episode, project) {
  const shots = Object.keys(ctx.store.get().shots || {})
    .map((k) => ctx.store.get().shots[k])
    .filter((s) => s.episodeId === episode.id);
  const breakdown = ESTIMATE_PLAN.lines.map((l) => Object.assign({}, l));
  const musicEnabled = !(project && project.music_enabled === false);
  if (musicEnabled) {
    breakdown.push({
      item: "配乐候选（影子计费 5–15 分/条）",
      unit: 10, qty: 12, cents: 120, tier: "music"
    });
  }
  breakdown.push({
    item: "配音轨",
    unit: 5, qty: Math.max(shots.length, 1), cents: 5 * Math.max(shots.length, 1), tier: "tts"
  });
  const cents = breakdown.reduce((a, b) => a + (b.cents || 0), 0);
  return {
    episodeId: episode.id,
    shots: shots.length || 16,
    time_min: ESTIMATE_PLAN.time_min,
    cents,
    breakdown,
    ver: episode.estimate_ver || null
  };
}

function requireEpisode(ctx, id) {
  const st = ctx.store.get();
  const ep = (st.episodes || {})[id];
  if (!ep) throw { code: "NOT_FOUND", message: "剧集不存在: " + id };
  return ep;
}

function cardDecided(ctx, episodeId, type) {
  const st = ctx.store.get();
  return Object.keys(st.cards || {}).some(
    (k) => st.cards[k].episodeId === episodeId && st.cards[k].type === type && st.cards[k].status === "decided"
  );
}

function register(router, ctx) {
  const { store, engine, util, bus } = ctx;

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  // POST /api/episodes {projectId,title,brief,kind}
  router.add(
    "POST",
    "/api/episodes",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const b = body || {};
      const st = store.get();
      if (!b.title || !b.brief) throw { code: "BAD_REQUEST", message: "title/brief 必填" };
      if (!b.projectId || !(st.projects || {})[b.projectId]) {
        throw { code: "NOT_FOUND", message: "项目不存在: " + b.projectId };
      }
      const kind = b.kind === "novel" ? "novel" : "one_liner";
      // 剧本结构（真实流程档）：scenes 分镜表（场/镜/台词）＋cast 角色定义（含参考图）。
      // 一期不用 LLM 解析——剧本即结构化输入；C1/C2/拍摄全链按此跑。
      let script = null;
      if (b.script && typeof b.script === "object") {
        const scenes = Array.isArray(b.script.scenes) ? b.script.scenes : [];
        const cast = Array.isArray(b.script.cast) ? b.script.cast : [];
        if (!scenes.length) throw { code: "BAD_REQUEST", message: "script.scenes 不能为空（至少一场）" };
        script = {
          scenes: scenes.map((sc) => ({
            name: String(sc.name || "场").slice(0, 40),
            mood: String(sc.mood || "中性").slice(0, 20),
            shots: (Array.isArray(sc.shots) ? sc.shots : []).map((sh) => ({
              desc: String(sh.desc || "").slice(0, 300),
              sec: Number(sh.sec) > 0 ? Math.min(Number(sh.sec), 15) : 5,
              cast: Array.isArray(sh.cast) ? sh.cast.map(String) : [],
              dialogue: String(sh.dialogue || "").slice(0, 200),
              tier: sh.tier === "high" ? "high" : undefined,
              width: Number(sh.width) > 0 ? Number(sh.width) : undefined,
              height: Number(sh.height) > 0 ? Number(sh.height) : undefined
            }))
          })),
          cast: cast.map((c) => ({
            role: String(c.role || "角色").slice(0, 30),
            name: String(c.name || "").slice(0, 30),
            desc: String(c.desc || "").slice(0, 400),
            refImage: c.refImage ? String(c.refImage).replace(/[^\w.\-]/g, "_") : null
          }))
        };
      }
      const ep = {
        id: util.uid("ep"),
        projectId: b.projectId,
        title: b.title,
        brief: b.brief,
        kind,
        script,
        stage: 1,
        decisions: 0,
        budget_cents: typeof b.budget_cents === "number" ? b.budget_cents : DEFAULT_BUDGET_CENTS,
        cost_cents: 0,
        paused: false,
        estimate_ver: null,
        shoot_confirmed_ver: null,
        est: null
      };
      st.episodes = st.episodes || {};
      st.episodes[ep.id] = ep;
      store.commit();
      const job = engine.enqueue(
        "c1plan",
        { episodeId: ep.id, title: ep.title, brief: ep.brief, kind },
        // Spark 通道启用 → c1plan 走 imgspark（H3-Image 海报，全套 H3）
        { episodeId: ep.id, initiated_by: "user", tier: ctx.cfg && ctx.cfg.comfySpark && ctx.cfg.comfySpark.enabled ? "high" : undefined }
      );
      audit(auth, "episode_create", ep.id, { job_id: job && job.id, kind });
      try { bus.publish("cards", { event: "episode_created", episode: ep }); } catch (e) {}
      return router.json(res, 201, { episode: ep, job });
    },
    { auth: true }
  );

  // GET /api/episodes/:id/estimate
  router.add(
    "GET",
    "/api/episodes/:id/estimate",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const ep = requireEpisode(ctx, params.id);
      if (!ep.estimate_ver) {
        throw { code: "NOT_READY", message: "预估未生成：请先完成 C5 样片确认" };
      }
      const project = (st.projects || {})[ep.projectId];
      const card = estimateBreakdown(ctx, ep, project);
      card.ver = ep.estimate_ver;
      return router.json(res, 200, card);
    },
    { auth: true }
  );

  // POST /api/episodes/:id/shoot {ver}
  router.add(
    "POST",
    "/api/episodes/:id/shoot",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const ep = requireEpisode(ctx, params.id);
      if (!ep.estimate_ver) {
        throw { code: "NOT_READY", message: "预估未生成，无法开机" };
      }
      if (!cardDecided(ctx, ep.id, "C6")) {
        throw { code: "NOT_READY", message: "请先接受 C6 开机确认卡" };
      }
      // cas(estimate_ver)：ver 不符 → {code:"STALE"} → 409
      util.cas({ ver: ep.estimate_ver }, body && body.ver);
      const shots = Object.keys(st.shots || {})
        .map((k) => st.shots[k])
        .filter((s) => s.episodeId === ep.id)
        .sort((a, b) => (a.seq || 0) - (b.seq || 0));
      if (!shots.length) {
        throw { code: "NOT_READY", message: "镜头未生成，无法开机" };
      }
      const jobs = [];
      const only = Array.isArray(body && body.shotIds) ? body.shotIds.map(String) : null; // 局部重拍（复审 stale 镜）
      shots.forEach((sh) => {
        if (only && only.indexOf(sh.id) < 0) return;
        const job = engine.enqueue(
          "video",
          { episodeId: ep.id, shotId: sh.id, sec: sh.sec || 5, width: sh.width, height: sh.height },
          { episodeId: ep.id, initiated_by: "user", tier: sh.tier === "high" ? "high" : undefined }
        );
        jobs.push(job);
      });
      ep.shoot_confirmed_ver = ep.estimate_ver;
      ep.stage = Math.max(ep.stage || 1, 7);
      store.commit();
      audit(auth, "shoot", ep.id, { shots: shots.length, estimate_ver: ep.estimate_ver });
      try { bus.publish("cards", { event: "shot_start", episodeId: ep.id, jobs: jobs.length }); } catch (e) {}
      return router.json(res, 202, { episodeId: ep.id, jobs, started: jobs.length });
    },
    { auth: true }
  );

    router.add(
      "POST",
      "/api/episodes/:id/cast",
      (req, res, body, params, auth) => {
        if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
        const st = store.get();
        const ep = requireEpisode(ctx, params.id);
        const b = body || {};
        const list = Array.isArray(b.cast) ? b.cast : [];
        if (!list.length) throw { code: "BAD_REQUEST", message: "cast 不能为空" };
        if (!ep.script || !Array.isArray(ep.script.cast)) throw { code: "BAD_REQUEST", message: "本集无剧本 cast" };
        // 只允许修订既有角色（场景/镜已入 state，不可通过此口变动）
        const changed = [];
        list.forEach((c) => {
          const role = String(c.role || "");
          const cur = ep.script.cast.find((x) => x.role === role);
          if (!cur) throw { code: "NOT_FOUND", message: "角色不存在: " + role };
          if (c.desc != null) cur.desc = String(c.desc).slice(0, 400);
          if (c.anchor != null) cur.anchor = String(c.anchor).slice(0, 400);
          if (c.wardrobe != null) cur.wardrobe = String(c.wardrobe).slice(0, 120);
          if (c.refImage !== undefined) cur.refImage = c.refImage ? String(c.refImage).replace(/[^A-Za-z0-9._-]/g, "_") : null;
          changed.push(role);
        });
        store.commit();
        audit(auth, "cast_revise", ep.id, { roles: changed });
        try { ctx.bus.publish("episodes", { event: "cast_revise", episodeId: ep.id }); } catch (e) {}
        return router.json(res, 200, { cast: ep.script.cast });
      },
      { auth: true }
    );

  // ---------- 初始定妆入口（试妆试镜流程 2026-11-21） ----------
  // 用户上传原图 或 提示词生成初始图 → confirm 固化为角色 refImage → 全员确认后自动派试妆试镜
  function parseQ(req) {
    const i = (req.url || "").indexOf("?");
    const out = {};
    if (i >= 0) new URLSearchParams(req.url.slice(i + 1)).forEach((v, k) => { out[k] = v; });
    return out;
  }
  function castDir() { return require("path").join(process.cwd(), "var", "assets", "cast"); }

  // POST /api/episodes/:id/castref/upload?role=X — raw bytes（PNG/JPEG ≤16MB）→ var/assets/cast/
  router.add(
    "POST",
    "/api/episodes/:id/castref/upload",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const ep = requireEpisode(ctx, params.id);
      const q = parseQ(req);
      const role = String(q.role || "").trim();
      if (!role) throw { code: "BAD_REQUEST", message: "role 必填（query ?role=）" };
      const cur = (ep.script && ep.script.cast || []).find((x) => x.role === role);
      if (!cur) throw { code: "NOT_FOUND", message: "角色不存在: " + role };
      const buf = Buffer.isBuffer(body) ? body : null;
      if (!buf || buf.length < 100) throw { code: "BAD_REQUEST", message: "请求体须为图片原始字节" };
      const isPng = buf.length > 24 && buf.toString("latin1", 1, 4) === "PNG";
      const isJpg = buf.length > 3 && buf.toString("latin1", 0, 3) === "\xff\xd8\xff";
      if (!isPng && !isJpg) throw { code: "BAD_REQUEST", message: "仅支持 PNG/JPEG" };
      const fs = require("fs");
      const path = require("path");
      const dir = castDir();
      fs.mkdirSync(dir, { recursive: true });
      const fn = "upload_" + role.replace(/[^A-Za-z0-9._-]/g, "_") + "_" + Date.now() + (isPng ? ".png" : ".jpg");
      fs.writeFileSync(path.join(dir, fn), buf);
      audit(auth, "castref_upload", ep.id, { role, file: fn, bytes: buf.length });
      return router.json(res, 200, { file: fn, bytes: buf.length, role });
    },
    { auth: true, raw: true, limit: 16 * 1024 * 1024 }
  );

  // POST /api/episodes/:id/castref/generate {role, prompt} — 提示词生成初始图（cast_init job，异步）
  router.add(
    "POST",
    "/api/episodes/:id/castref/generate",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const ep = requireEpisode(ctx, params.id);
      const b = body || {};
      const role = String(b.role || "").trim();
      const cur = (ep.script && ep.script.cast || []).find((x) => x.role === role);
      if (!cur) throw { code: "NOT_FOUND", message: "角色不存在: " + role };
      const job = engine.enqueue(
        "cast_init",
        { episodeId: ep.id, role, prompt: String(b.prompt || "").slice(0, 400) },
        { episodeId: ep.id, initiated_by: "user" }
      );
      audit(auth, "castref_generate", ep.id, { role, job_id: job && job.id });
      return router.json(res, 202, { job, role });
    },
    { auth: true }
  );

  // POST /api/episodes/:id/castref/confirm {role, file} — 确认初始定妆（人脸存在性机检）；
  // 全员确认 → 自动派试妆试镜（screen_test）
  router.add(
    "POST",
    "/api/episodes/:id/castref/confirm",
    async (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const ep = requireEpisode(ctx, params.id);
      const b = body || {};
      const role = String(b.role || "").trim();
      const cur = (ep.script && ep.script.cast || []).find((x) => x.role === role);
      if (!cur) throw { code: "NOT_FOUND", message: "角色不存在: " + role };
      const rel = String(b.file || "");
      const name = require("path").basename(rel).replace(/[^A-Za-z0-9._-]/g, "_");
      const fs = require("fs");
      const path = require("path");
      const src = [path.join(castDir(), name), path.join(process.cwd(), "var", "out", name)]
        .find((p) => fs.existsSync(p));
      if (!src) throw { code: "NOT_FOUND", message: "文件不存在: " + rel };
      // 人脸存在性机检（facegate :8195；无 face 时拒绝确认）
      try {
        const r = await fetch("http://127.0.0.1:8195/score", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ img_b64: fs.readFileSync(src).toString("base64") })
        });
        const d = await r.json().catch(() => ({}));
        if (d && d.reason === "no_face") throw { code: "NOT_A_FACE", message: "图中未检出人脸，不能作为初始定妆" };
      } catch (e) {
        if (e && e.code) throw e; // facegate 不可达不阻断确认（离线兜底）
      }
      const dir = castDir();
      fs.mkdirSync(dir, { recursive: true });
      if (path.dirname(src) !== dir) fs.copyFileSync(src, path.join(dir, name));
      cur.refImage = name;
      store.commit();
      audit(auth, "castref_confirm", ep.id, { role, file: name });
      // 回填 pending C2 卡：该角色候选清为「已确认初始定妆」（覆盖旧生成垃圾），refImage 同步
      const cards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
      const c2 = cards.find((x) => x.episodeId === ep.id && x.type === "C2" && x.status === "pending");
      if (c2) {
        const actors = (c2.payload || {}).actors || [];
        const target = actors.find((a) => a.role === role);
        if (target) {
          target.refImage = name;
          target.candidates = [{ id: "cand_ref_" + actors.indexOf(target), name: "初始定妆（已确认）", art: "var/assets/cast/" + name, score: null }];
          const pendingCast = actors.filter((a) => !((a.candidates || [])[0] || {}).art).length;
          c2.payload.note = pendingCast
            ? "角色定义 " + actors.length + " 人 · 等待初始定妆（剩 " + pendingCast + " 人）"
            : "角色定义 " + actors.length + " 人 · 初始定妆已确认 · 试妆试镜进行中";
          c2.ver += 1;
          c2.updated_at = util.now();
          try { ctx.bus.publish("cards", { event: "updated", card: c2 }); } catch (e) {}
        }
      }
      // 全员初始定妆齐 → 自动派试妆试镜（每角色一条；已有在队/在跑的不重派）
      const jobs = [];
      const allCast = ep.script.cast || [];
      const dupScreenTest = engine.activeOf("screen_test", ep.id).length > 0;
      if (!dupScreenTest && allCast.every((c) => c.refImage)) {
        allCast.forEach((c) => {
          const job = engine.enqueue(
            "screen_test",
            { episodeId: ep.id, role: c.role },
            { episodeId: ep.id, initiated_by: "system" }
          );
          jobs.push(job);
        });
      }
      try { ctx.bus.publish("episodes", { event: "castref_confirm", episodeId: ep.id, role }); } catch (e) {}
      return router.json(res, 200, { cast: ep.script.cast, confirmed: role, screen_tests: jobs });
    },
    { auth: true }
  );

  // POST /api/episodes/:id/script-scenes — 剧本场景修订（拍摄前；与 state 场景按 seq 1:1 对齐）
  router.add(
    "POST",
    "/api/episodes/:id/script-scenes",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const e = requireEpisode(ctx, params.id);
      if ((e.stage || 1) >= 7) throw { code: "LOCKED", message: "已开拍，场景表锁定" };
      if (!e.script || !Array.isArray(e.script.cast)) throw { code: "BAD_REQUEST", message: "本集无剧本" };
      const b = body || {};
      const scenes = Array.isArray(b.scenes) ? b.scenes : [];
      const stScenes = Object.keys(st.scenes || {}).map((k) => st.scenes[k])
        .filter((x) => x && x.episodeId === e.id).sort((x, y) => (x.seq || 0) - (y.seq || 0));
      if (scenes.length !== stScenes.length) {
        throw { code: "BAD_REQUEST", message: "场景数须与镜库一致（" + stScenes.length + " 场，按 seq 顺序 1:1）" };
      }
      const castRoles = (e.script.cast || []).map((c) => c.role);
      e.script.scenes = scenes.map((sc, i) => {
        const shots = (Array.isArray(sc.shots) ? sc.shots : []).map((sh) => ({
          desc: String(sh.desc || "").slice(0, 300),
          sec: Number(sh.sec) > 0 ? Math.min(Number(sh.sec), 15) : 5,
          cast: (Array.isArray(sh.cast) ? sh.cast : []).map(String).filter((r) => castRoles.indexOf(r) >= 0),
          dialogue: String(sh.dialogue || "").slice(0, 200)
        }));
        if (!shots.length) throw { code: "BAD_REQUEST", message: "每场至少 1 镜（场 " + (i + 1) + "）" };
        return {
          name: String(sc.name || stScenes[i].name || "场").slice(0, 40),
          mood: String(sc.mood || "中性").slice(0, 20),
          shots
        };
      });
      store.commit();
      audit(auth, "script_scenes_revise", e.id, { scenes: e.script.scenes.length });
      // 剧本源头变更 → pending C1 重导出＋重审（AI 建议片采纳链的落地点）
      try { require("./cards.js").refreshPendingC1(ctx, e.id); } catch (err2) { /* 刷新失败不阻断 */ }
      try { ctx.bus.publish("episodes", { event: "script_scenes_revise", episodeId: e.id }); } catch (err) {}
      return router.json(res, 200, { scenes: e.script.scenes });
    },
    { auth: true }
  );
}

module.exports.register = register;
module.exports.estimateBreakdown = estimateBreakdown;
