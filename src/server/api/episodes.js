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
        template_id: b.templateId && (st.templates || {})[b.templateId] ? b.templateId : null,
        stage: 1,
        decisions: 0,
        budget_cents: typeof b.budget_cents === "number" ? b.budget_cents : DEFAULT_BUDGET_CENTS,
        driver: b.driver === "dgx" ? "dgx" : "local", // 节点驱动：local=本机 5060 Ti｜dgx=DGX H3 全家桶
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

  // POST /api/quickstart {brief, mode?, templateId?, projectId?, title?, driver?}
  // 一句话成片/模板跟拍一站式直跑（2026-11-21 补全 FR-201 最短路径）：
  //   输入一句 → 自动建项目（可显式指定，模板风格预设落 style_pkg）→ 建集 →
  //   派 scriptgen（纯 LLM 车道，不受 GPU/LLM 互斥闸）→ 完成后 cards.js 直接产 C1 卡。
  //   长文本（>150 字）自动按小说改编（kind:"novel"）处理；模板节拍作为展开骨架随行。
  router.add(
    "POST",
    "/api/quickstart",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const b = body || {};
      const st = store.get();
      const brief = String(b.brief || "").trim();
      if (!brief) throw { code: "BAD_REQUEST", message: "先写一句话：想拍什么？" };
      if (brief.length > 20000) throw { code: "BAD_REQUEST", message: "文本太长（上限 2 万字），先拆一集贴进来" };
      const kind = b.mode === "novel" || brief.length > 150 ? "novel" : "one_liner";
      const titleIn = String(b.title || "").trim().slice(0, 40);

      st.templates = st.templates || {};
      const tpl = b.templateId ? st.templates[b.templateId] : null;
      if (b.templateId && !tpl) throw { code: "NOT_FOUND", message: "模板不存在: " + b.templateId };

      // 项目：显式指定 or 自动新建（模板 style 预设落到项目 style_pkg）
      let project = null;
      if (b.projectId) {
        project = (st.projects || {})[b.projectId];
        if (!project) throw { code: "NOT_FOUND", message: "项目不存在: " + b.projectId };
      } else {
        const style = tpl && tpl.style
          ? { look: String(tpl.style.look || "写实电影感").slice(0, 30), palette: String(tpl.style.palette || "青橙").slice(0, 20), ratio: String(tpl.style.ratio || "9:16").slice(0, 10) }
          : { look: "写实电影感", palette: "青橙", ratio: "9:16" };
        project = {
          id: util.uid("pj"),
          title: titleIn || (tpl ? tpl.name : brief.slice(0, 12) + "…"),
          style_pkg: style,
          music_enabled: true
        };
        st.projects = st.projects || {};
        st.projects[project.id] = project;
        store.log("audit", { operator: (auth && (auth.uid || auth.id)) || null, action: "project_create", target: project.id, title: project.title, via: "quickstart" });
      }

      const ep = {
        id: util.uid("ep"),
        projectId: project.id,
        title: titleIn || brief.slice(0, 20),
        brief,
        kind,
        script: null,
        template_id: tpl ? tpl.id : null,
        stage: 1,
        decisions: 0,
        budget_cents: DEFAULT_BUDGET_CENTS,
        driver: b.driver === "dgx" ? "dgx" : "local",
        cost_cents: 0,
        paused: false,
        estimate_ver: null,
        shoot_confirmed_ver: null,
        est: null
      };
      st.episodes = st.episodes || {};
      st.episodes[ep.id] = ep;
      store.commit();

      // 派 LLM 剧本生成（scriptgen 完成后 cards.js 直接产 C1 卡；LLM 离线则落占位结构，流程不卡死）
      const tplSnap = tpl ? { genre: tpl.genre, beats: tpl.beats, style: tpl.style } : null;
      const job = engine.enqueue(
        "scriptgen",
        { episodeId: ep.id, title: ep.title, brief, kind, template: tplSnap },
        { episodeId: ep.id, initiated_by: "user", free: true }
      );
      audit(auth, "quickstart", ep.id, { job_id: job && job.id, kind, template_id: tpl ? tpl.id : null, project_id: project.id });
      try { bus.publish("cards", { event: "episode_created", episode: ep }); } catch (e) {}
      return router.json(res, 201, { project, episode: ep, job });
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
      let dedupedN = 0;
      const only = Array.isArray(body && body.shotIds) ? body.shotIds.map(String) : null; // 局部重拍（复审 stale 镜）
      shots.forEach((sh) => {
        if (only && only.indexOf(sh.id) < 0) return;
        // 幂等派单（2026-11-21）：同镜 video 活任务（内存+账本，账本行带 shotId）在跑 → 不重派。
        // 连点「开机」/重复提交不再为每镜堆多条渲染任务（每条 ≈7 分钟 GPU）；已完成镜重拍不受影响。
        const r = engine.enqueueOnce
          ? engine.enqueueOnce(
              "video",
              { episodeId: ep.id, shotId: sh.id, sec: sh.sec || 5, width: sh.width, height: sh.height },
              { episodeId: ep.id, initiated_by: "user", tier: sh.tier === "high" ? "high" : undefined }
            )
          : { deduped: false, job: engine.enqueue(
              "video",
              { episodeId: ep.id, shotId: sh.id, sec: sh.sec || 5, width: sh.width, height: sh.height },
              { episodeId: ep.id, initiated_by: "user", tier: sh.tier === "high" ? "high" : undefined }
            ) };
        if (r.job) jobs.push(r.job);
        if (r.deduped) dedupedN++;
      });
      ep.shoot_confirmed_ver = ep.estimate_ver;
      ep.stage = Math.max(ep.stage || 1, 7);
      store.commit();
      audit(auth, "shoot", ep.id, { shots: shots.length, estimate_ver: ep.estimate_ver, deduped_n: dedupedN });
      try { bus.publish("cards", { event: "shot_start", episodeId: ep.id, jobs: jobs.length }); } catch (e) {}
      return router.json(res, 202, { episodeId: ep.id, jobs, started: Math.max(0, jobs.length - dedupedN), deduped_n: dedupedN });
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
      // 幂等派单（2026-11-21）：同角色 cast_init 活任务（内存+账本）在跑 → 不重派，防连点堆任务
      const r = engine.enqueueOnce
        ? engine.enqueueOnce(
            "cast_init",
            { episodeId: ep.id, role, prompt: String(b.prompt || "").slice(0, 400) },
            { episodeId: ep.id, initiated_by: "user" }
          )
        : { deduped: false, job: engine.enqueue(
            "cast_init",
            { episodeId: ep.id, role, prompt: String(b.prompt || "").slice(0, 400) },
            { episodeId: ep.id, initiated_by: "user" }
          ) };
      const job = r.job;
      audit(auth, "castref_generate", ep.id, { role, job_id: job && job.id, deduped: r.deduped });
      return router.json(res, 202, { job, role, deduped: r.deduped });
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
      // 全员初始定妆齐 → 自动派试妆试镜（幂等 2026-11-21：逐角色活任务防重，内存+账本兜底，
      // 守护重启清内存也不会重复堆任务；重复 confirm/连点不再生成一堆同款试镜）
      const jobs = [];
      let dedupedN = 0;
      const allCast = ep.script.cast || [];
      if (allCast.every((c) => c.refImage)) {
        allCast.forEach((c) => {
          const r = engine.enqueueOnce
            ? engine.enqueueOnce("screen_test", { episodeId: ep.id, role: c.role }, { episodeId: ep.id, initiated_by: "system" })
            : { deduped: false, job: engine.enqueue("screen_test", { episodeId: ep.id, role: c.role }, { episodeId: ep.id, initiated_by: "system" }) };
          if (r.deduped) dedupedN++;
          if (r.job) jobs.push(r.job);
        });
      }
      try { ctx.bus.publish("episodes", { event: "castref_confirm", episodeId: ep.id, role }); } catch (e) {}
      return router.json(res, 200, { cast: ep.script.cast, confirmed: role, screen_tests: jobs, deduped: dedupedN > 0, deduped_n: dedupedN });
    },
    { auth: true }
  );

  // POST /api/episodes/:id/song — 歌曲锚点修订（拍摄前）：{title?, motif?, accompaniment?, tempo?, key?, voice?}
  // 整首歌统一风格写入 ep.script.song，每镜视频 IR 引用同一段锚点（H3 音画直出的「小样」机制：
  // 先拍 1 镜试唱定风格，全量拍摄时同一锚点保证 8 镜拼起来像同一首歌）
  router.add(
    "POST",
    "/api/episodes/:id/song",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const e = requireEpisode(ctx, params.id);
      if ((e.stage || 1) >= 7) throw { code: "LOCKED", message: "已开拍，歌曲锚点锁定" };
      if (!e.script) throw { code: "BAD_REQUEST", message: "本集无剧本" };
      const b = body || {};
      const cur = e.script.song || {};
      e.script.song = {
        title: String(b.title != null ? b.title : cur.title || "").slice(0, 40),
        motif: String(b.motif || cur.motif || "one gentle slow ballad, the same melodic motif carried through the whole song").slice(0, 200),
        accompaniment: String(b.accompaniment || cur.accompaniment || "soft piano arpeggios with light strings").slice(0, 120),
        tempo: String(b.tempo || cur.tempo || "about 70 bpm").slice(0, 40),
        key: String(b.key || cur.key || "G major").slice(0, 40),
        voice: String(b.voice || cur.voice || "young female vocals, breathy and intimate, close to the microphone").slice(0, 160)
      };
      store.commit();
      audit(auth, "song_revise", e.id, { title: e.script.song.title });
      try { ctx.bus.publish("episodes", { event: "song_revise", episodeId: e.id }); } catch (err) {}
      return router.json(res, 200, { song: e.script.song });
    },
    { auth: true }
  );

  // GET /api/episodes/:id/timeline — 全程时间线（2026-11-21）：job 账本＋审计日志合并、
  // 人话化倒序——多次重出/失败/驳回一屏看全「何时发生了什么、有什么问题」
  const JOB_CN = {
    c1plan: "方向海报", storyboard: "场景分镜", casting: "定妆", cast_init: "初始定妆生成",
    screen_test: "试妆试镜视频", storyboard_char: "角色分镜", video: "镜头拍摄",
    voice: "配音", music: "配乐", compose: "混流", moderate: "机审", aireview: "AI 审查"
  };
  const AUDIT_CN = {
    episode_create: "建集", card_accept: "拍板", card_reject: "驳回", card_edit: "递修改意见",
    castref_upload: "上传初始定妆图", castref_confirm: "确认初始定妆", castref_generate: "AI 生成初始图",
    song_revise: "歌曲锚点修订", viewrefs_refresh: "参考库重固化", review_decide: "复审批复",
    shoot: "开机拍摄", quant_change: "量化档调整", export_artifacts: "成片导出"
  };
  router.add(
    "GET",
    "/api/episodes/:id/timeline",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const epId = params.id;
      requireEpisode(ctx, epId);
      const events = [];
      const fs = require("fs");
      const pathm = require("path");
      const readJsonl = (f) => {
        try {
          const p = pathm.join(process.cwd(), "var", f);
          if (!fs.existsSync(p)) return [];
          return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => {
            try { return JSON.parse(l); } catch (e) { return null; }
          }).filter(Boolean);
        } catch (e) { return []; }
      };
      // 统一镜号（2026-11-21）：shotId → 「镜 03」（seq 模 100 补零）——时间线不再显示哈希尾数
      const shotsMap = store.get().shots || {};
      const shotNoOf = (sid) => {
        const s = shotsMap[sid];
        const n = s && s.seq ? (Number(s.seq) % 100 || Number(s.seq)) : null;
        return n ? (n < 10 ? "0" + n : String(n)) : null;
      };
      readJsonl("log-job.jsonl").forEach((r) => {
        if (r.episodeId !== epId) return;
        const cn = JOB_CN[r.type] || r.type;
        const at = r.attempts ? ("（第 " + (r.attempts + 1) + " 次）") : "";
        const sn = r.shotId && shotNoOf(r.shotId) ? " · 镜 " + shotNoOf(r.shotId) : "";
        if (r.status === "done") events.push({ ts: r.ts, level: "ok", text: "✓ " + cn + sn + at + " 完成" + (r.cost_cents ? "（" + r.cost_cents + " 分）" : ""), job: r.job_id });
        else if (r.status === "failed") events.push({ ts: r.ts, level: "err", text: "✗ " + cn + sn + " 失败" + (r.error ? "：" + String(r.error).slice(0, 120) : ""), job: r.job_id });
        else if (r.status === "retry") events.push({ ts: r.ts, level: "warn", text: "⟳ " + cn + sn + " 自动重试：" + String(r.error || "").slice(0, 100), job: r.job_id });
        else if (r.status === "running") events.push({ ts: r.ts, level: "info", text: "▶ " + cn + sn + " 开始渲染", job: r.job_id });
        else if (r.status === "cancelled") events.push({ ts: r.ts, level: "warn", text: "■ " + cn + sn + " 已取消", job: r.job_id });
      });
      readJsonl("log-audit.jsonl").forEach((r) => {
        const cn = AUDIT_CN[r.action];
        if (!cn) return;
        if (r.action === "review_decide") {
          const sn = r.shotId && shotNoOf(r.shotId) ? "镜 " + shotNoOf(r.shotId) : String(r.shotId || "").slice(-6);
          if (r.decision === "pass") events.push({ ts: r.ts, level: "ok", text: "✓ 复审批复：" + sn + " 通过" });
          else events.push({ ts: r.ts, level: "warn", text: "↺ 复审批复：" + sn + " 重拍" });
          return;
        }
        // 卡片类审计带批次号（从 state 里取该卡 round）
        let roundTag = "";
        if ((r.action === "card_accept" || r.action === "card_reject") && r.target) {
          const st = store.get();
          const cd = (st.cards || {})[r.target];
          if (cd && cd.round) roundTag = "第 " + cd.round + " 版";
          if (cd && cd.type) roundTag = (JOB_CN[cd.type] || cd.type) + " " + roundTag;
        }
        events.push({ ts: r.ts, level: r.action === "card_reject" ? "warn" : "info", text: "· " + cn + (roundTag ? "：" + roundTag : "") });
      });
      events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      const q = 200;
      return router.json(res, 200, { events: events.slice(0, q), total: events.length });
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
      e.script_source = "user"; // 用户修订过剧本 → C1 驳回不再自动重新生成（保护用户改动）
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
