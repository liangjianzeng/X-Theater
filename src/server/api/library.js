"use strict";
/**
 * api/library.js — 素材中心（方案 docs/theater-asset-center-plan.md ＋ 施工 docs/theater-asset-center-build.md）
 *
 * 五域资产库 st.asset_lib（audio{music,sfx,ambience,voices}/images/characters/scenes/canon）
 * ＋候选临时池 st.asset_drafts（TTL 7 天惰性清理，core/store.js）。
 *
 * 语义（施工 §0.2 冲突裁决表，一律行业主流）：
 *  - K1 生成与绑定解耦：generate 不需要 sceneId（projectId 可选），产物一律先落候选池
 *  - K2 绑定 1:N：bind/unbind + used_by 反向索引 + primary（compose 每场取主曲）
 *  - K3 候选状态机：draft → adopt → approved → featured/retired
 *  - K6 双轨供给：集内自动流（cards.js）照旧；素材中心手动流并行，两者共用本库
 *  - K8 成本口径：global 素材任务不挂 episodeId（engine 对账天然跳过单集 Σcost）
 *  - K9/K10 产物引用：adopt 时归档 var/out → var/assets/library/<域>/（静态面直接可播）
 *
 * 兼容出口（A8）：adoptCandidate / hasSceneBinding / musicForScene / libraryEntries —— 供
 * api/music.js（旧路由薄壳）与 cards.js / compose.js 引用，签名不变。
 */

const fs = require("fs");
const path = require("path");
const prompts = require("../prompts/index.js");

/* ---------------- 数据面 ---------------- */

const DOMAINS = {
  music: (l) => l.audio.music,
  sfx: (l) => l.audio.sfx,
  ambience: (l) => l.audio.ambience,
  voices: (l) => l.audio.voices,
  images: (l) => l.images,
  characters: (l) => l.characters,
  scenes: (l) => l.scenes
};

function libOf(state) {
  const l = state && state.asset_lib;
  return l && l.version
    ? l
    : require("../core/store.js").ensureAssetLib(state) && state.asset_lib; // 兜底（正常由 openStore 保证）
}

function draftList(state, domain) {
  const d = state.asset_drafts || (state.asset_drafts = { music: [], images: [] });
  return Array.isArray(d[domain]) ? d[domain] : (d[domain] = []);
}

function findEntry(ctx, domain, id) {
  const arr = DOMAINS[domain] ? DOMAINS[domain](libOf(ctx.store.get())) : null;
  return arr ? arr.filter((x) => x && x.id === id)[0] || null : null;
}

/** 场景绑定解析（K2）：primary 绑定优先 → 任意绑定 → 旧 sceneId 字段（迁移兼容）。 */
function musicForScene(ctx, sceneId) {
  const st = ctx.store.get();
  const sid = String(sceneId || "");
  if (!sid) return null;
  const arr = libOf(st).audio.music.filter((m) => m && m.status !== "retired");
  const bound = arr.filter((m) => (Array.isArray(m.used_by) ? m.used_by : []).some((u) => u && u.kind === "scene" && String(u.id) === sid));
  if (bound.length) {
    const prim = bound.filter((m) => (m.used_by || []).some((u) => u.kind === "scene" && String(u.id) === sid && u.primary));
    return (prim.length ? prim : bound)[0];
  }
  return arr.filter((m) => m.sceneId && String(m.sceneId) === sid)[0] || null;
}

function hasSceneBinding(ctx, sceneId) {
  return !!musicForScene(ctx, sceneId);
}

/** 全库条目（compose 等旧读取面迁移用）：music 域全部非 retired 条目。 */
function libraryEntries(ctx) {
  return libOf(ctx.store.get()).audio.music.filter((m) => m && m.status !== "retired");
}

/* ---------------- 文件归档（K9） ---------------- */

/** var 根：THEATER_VAR 部署可变——cfg.outDir 恒为 <varDir>/out，反推 varDir */
function varRoot(ctx) {
  const outDir = String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join(process.cwd(), "var", "out"));
  return path.dirname(outDir);
}

/** 产物物理文件：优先 cfg.outDir＋basename（compose.resolveArt 同口径），兜底 CWD 字面路径 */
function resolveOutFile(ctx, art) {
  const a = String(art || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!a) return null;
  const cands = [
    path.join(String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join(process.cwd(), "var", "out")), path.basename(a)),
    path.join(process.cwd(), a)
  ];
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* 忽略 */ }
  }
  return null;
}

/** var/out 产物 → var/assets/library/<domain>/（静态面直接可播；原文件不删，回滚无忧） */
function archiveArt(ctx, art, domain) {
  const a = String(art || "").replace(/\\/g, "/");
  if (!a || a.indexOf("var/out/") !== 0) return a || null;
  const src = resolveOutFile(ctx, a);
  if (!src) return a;
  const dir = path.join(varRoot(ctx), "assets", "library", domain);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fn = path.basename(a);
    const dst = path.join(dir, fn);
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
    return "var/assets/library/" + domain + "/" + fn;
  } catch (e) {
    return a; // 归档失败不阻断入库（原路径仍在静态面）
  }
}

/* ---------------- 审计与校验 ---------------- */

function audit(ctx, auth, action, target, extra) {
  ctx.store.log("audit", Object.assign({
    operator: (auth && (auth.uid || auth.id)) || null,
    action,
    target
  }, extra || {}));
}

const STATUSES = ["candidate", "approved", "featured", "retired"];
function statusOk(s) { return STATUSES.indexOf(String(s || "")) >= 0; }

/* ---------------- 入库合规软门（B4）：文本面禁词＋文件存在性 ---------------- */

function moderateAsset(ctx, spec) {
  const out = { pass: true, reason: "", checks: [] };
  const lint = ctx.rules && ctx.rules.langlint;
  const text = String((spec && spec.text) || "");
  if (text && lint && typeof lint.lint === "function") {
    try {
      const r = lint.lint(text, { exempt: false });
      const hits = (r && r.hits) || [];
      if (hits.length) { out.pass = false; out.reason = "文案命中语言纪律词表：" + hits.slice(0, 3).map(String).join("、"); }
      out.checks.push("langlint");
    } catch (e) { /* lint 失败不阻断 */ }
  }
  const art = String((spec && spec.art) || "");
  if (art) {
    const abs = resolveOutFile(ctx, art) || (art.indexOf("var/assets/") === 0 ? path.join(varRoot(ctx), art.slice("var/".length)) : null);
    if (!abs || !fs.existsSync(abs)) { out.pass = false; out.reason = "产物文件不存在（" + art + "）"; }
    out.checks.push("file");
  }
  return out;
}

/* ---------------- register ---------------- */

function register(router, ctx) {
  const { store, engine, bus, util } = ctx;
  require("../core/store.js").pruneDrafts(store.get());

  /** query 串解析（router 只给路径参数；upload/筛选等 ?k=v 面用） */
  function parseQ(req) {
    const i = (req.url || "").indexOf("?");
    const out = {};
    if (i >= 0) new URLSearchParams(req.url.slice(i + 1)).forEach((v, k) => { out[k] = v; });
    return out;
  }

  /* ---------- 回流监听（B8 后端半边）：无集归属的素材任务完成 → 候选池 ----------
   * 集内 music/img 任务由 cards.js 卡流负责（K6 不双写）；这里只收素材中心派发的自由任务。 */
  bus.on("jobs", (evt) => {
    try {
      if (!evt || evt.event !== "done" || !evt.job) return;
      const job = evt.job;
      if (job.episodeId) return; // 集内任务不进素材候选池
      const st = store.get();
      const p = job.payload || {};
      if (job.type === "music" && job.result && Array.isArray(job.result.candidates)) {
        require("../core/store.js").pruneDrafts(st);
        const arr = draftList(st, "music");
        let n = 0;
        job.result.candidates.forEach((c) => {
          if (!c || !c.id || arr.some((x) => x.id === c.id)) return;
          arr.push({
            id: String(c.id),
            domain: "music",
            type: c.asset_type || p.type || "bgm",
            title: c.title || "未命名配乐",
            mood: c.mood || p.mood || "中性",
            sec: c.sec || 45,
            tags: c.tags || p.tags || "",
            engine: c.engine || "",
            license: c.license || { model: "MIT", usage: "missing" },
            shadow_cents: c.shadow_cents || 0,
            art: c.art || null,
            art_abs: c.art_abs || null,
            scope: p.projectId ? "project" : "global",
            projectId: p.projectId || null,
            created_at: Date.now()
          });
          n++;
        });
        if (n) {
          store.commit();
          try { bus.publish("cards", { event: "studio_drafts", domain: "music", count: n }); } catch (e) {}
        }
      }
      if (job.type === "img_free" && (job.art || (job.result && job.result.art))) {
        require("../core/store.js").pruneDrafts(st);
        const art = typeof job.art === "string" ? job.art : (job.result && (job.result.art || (job.result.meta && job.result.meta.art))) || null;
        if (art) {
          const arr = draftList(st, "images");
          const id = "img_" + String(job.id || util.uid("img")).slice(-12);
          if (!arr.some((x) => x.id === id)) {
            arr.push({
              id,
              domain: "images",
              type: p.type || "mood",
              title: (p.desc || "").slice(0, 24) || "自由生成",
              desc: p.desc || "",
              style_look: p.styleLook || "",
              ref_image: p.refImage || null,
              ratio: p.ratio || "9:16",
              engine: (job.result && job.result.engine) || "",
              shadow_cents: (job.result && (job.result.cents || job.result.cost_cents)) || 0,
              art,
              scope: p.projectId ? "project" : "global",
              projectId: p.projectId || null,
              created_at: Date.now()
            });
            store.commit();
            try { bus.publish("cards", { event: "studio_drafts", domain: "images", count: 1 }); } catch (e) {}
          }
        }
      }
    } catch (e) { /* 回流异常隔离：不影响任务链 */ }
  });

  /* ================= summary / readiness ================= */

  router.add("GET", "/api/studio/summary", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const st = store.get();
    require("../core/store.js").pruneDrafts(st);
    const l = libOf(st);
    const counts = {
      music: l.audio.music.filter((m) => m.status !== "retired").length,
      sfx: l.audio.sfx.length,
      ambience: l.audio.ambience.length,
      voices: l.audio.voices.length,
      images: l.images.filter((m) => m.status !== "retired").length,
      characters: l.characters.length,
      scenes: l.scenes.length,
      drafts: st.asset_drafts.music.length + st.asset_drafts.images.length
    };
    return router.json(res, 200, { counts, version: l.version });
  }, { auth: true });

  // 开拍就绪度（B9）：场景有主曲？场景卡有定场图？角色有库实体与帧池？
  router.add("GET", "/api/studio/readiness/:episodeId", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const st = store.get();
    const ep = (st.episodes || {})[params.episodeId];
    if (!ep) throw { code: "NOT_FOUND", message: "集不存在: " + params.episodeId };
    const l = libOf(st);
    const scenes = Object.keys(st.scenes || {}).map((k) => st.scenes[k]).filter((s) => s.episodeId === ep.id);
    const sceneItems = scenes.map((s) => ({
      kind: "scene", id: s.id, name: s.name,
      hasMusic: !!musicForScene(ctx, s.id),
      hasCard: l.scenes.some((c) => c && c.status !== "retired" && (c.boundSceneId === s.id || String(c.name) === String(s.name)))
    }));
    const script = ep.script || {};
    const roles = (script.cast || []).map((c) => c.role).filter(Boolean);
    const charItems = roles.map((role) => {
      const char = l.characters.filter((c) => c && c.status !== "retired" && c.role === role)[0] || null;
      return {
        kind: "character", id: role, name: role,
        hasCharacter: !!char,
        hasViews: !!(char && Array.isArray(char.views) && char.views.length),
        hasCast: !!(char && char.refImage)
      };
    });
    const theme = l.audio.music.filter((m) => m.status !== "retired" && m.type === "theme").length > 0;
    const items = sceneItems.concat(charItems);
    const ready = theme && items.every((i) => (i.kind === "scene" ? (i.hasMusic && i.hasCard) : (i.hasCharacter && i.hasCast)));
    return router.json(res, 200, { episodeId: ep.id, ready, theme, items });
  }, { auth: true });

  /* ================= 列表 / 元数据 ================= */

  // 候选池列表（先于通用 :domain 注册——router 首中即停）
  router.add("GET", "/api/studio/drafts", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const st = store.get();
    require("../core/store.js").pruneDrafts(st);
    const domain = parseQ(req).domain;
    const out = domain
      ? { [domain]: draftList(st, domain).slice() }
      : { music: draftList(st, "music").slice(), images: draftList(st, "images").slice() };
    return router.json(res, 200, { drafts: out });
  }, { auth: true });

  // 公共库科目（C8，ops；同样先于通用 :domain 注册）
  router.add("GET", "/api/studio/public_ledger", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    if (auth.role !== "ops") throw { code: "FORBIDDEN", message: "需要 ops 角色" };
    const rows = store.readLog("billing").filter((r) => r && r.episodeId == null);
    const byKind = {};
    let total = 0;
    rows.forEach((r) => {
      const k = r.kind || "other";
      byKind[k] = (byKind[k] || 0) + (Number(r.cents) || 0);
      total += Number(r.cents) || 0;
    });
    const st = store.get();
    const counts = {
      global_music: (st.asset_lib.audio.music || []).filter((m) => (m.scope || "global") === "global" && m.status !== "retired").length,
      global_images: (st.asset_lib.images || []).filter((m) => (m.scope || "global") === "global" && m.status !== "retired").length
    };
    return router.json(res, 200, { rows: rows.length, total, by_kind: byKind, counts, note: "公共库科目：素材任务不进任何单集 Σcost（施工 K8 口径）" });
  }, { auth: true, role: "ops" });

  router.add("GET", "/api/studio/:domain", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    if (!DOMAINS[params.domain]) throw { code: "NOT_FOUND", message: "未知素材域: " + params.domain };
    const st = store.get();
    let arr = DOMAINS[params.domain](libOf(st)).slice();
    const q = parseQ(req);
    const qs = String(q.q || q.search || "").trim();
    if (qs) {
      const needle = qs.toLowerCase();
      arr = arr.filter((x) => JSON.stringify({ t: x.title, n: x.name, m: x.mood, d: x.desc, g: x.tags, r: x.role }).toLowerCase().indexOf(needle) >= 0);
    }
    if (q.status) arr = arr.filter((x) => x.status === q.status);
    else arr = arr.filter((x) => x.status !== "retired");
    if (q.scope) arr = arr.filter((x) => (x.scope || "global") === q.scope);
    if (q.projectId) arr = arr.filter((x) => !x.projectId || x.projectId === q.projectId);
    if (q.type) arr = arr.filter((x) => (x.type || "") === q.type);
    if (q.mood) arr = arr.filter((x) => (x.mood || "") === q.mood);
    arr.sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || String(a.id).localeCompare(String(b.id)));
    return router.json(res, 200, { domain: params.domain, list: arr });
  }, { auth: true });

  // 元数据/状态修改（评分/标题/tags/状态流转）；retired 带影响面提示（K2 反向索引）
  router.add("PATCH", "/api/studio/:domain/:id", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const e = findEntry(ctx, params.domain, params.id);
    if (!e) throw { code: "NOT_FOUND", message: "素材不存在: " + params.id };
    const b = body || {};
    if (b.rating !== undefined) e.rating = Math.max(0, Math.min(5, Number(b.rating) | 0));
    if (b.title !== undefined) e.title = String(b.title).slice(0, 60);
    if (b.tags !== undefined) e.tags = String(b.tags).slice(0, 120);
    if (b.mood !== undefined) e.mood = String(b.mood).slice(0, 12);
    if (b.desc !== undefined) e.desc = String(b.desc).slice(0, 400);
    if (b.envDesc !== undefined) e.env_desc = String(b.envDesc).slice(0, 300);
    if (b.lightPreset !== undefined) e.light_preset = String(b.lightPreset).slice(0, 120);
    if (b.ambienceId !== undefined) e.ambienceId = b.ambienceId || null;
    if (b.gender !== undefined && params.domain === "voices") e.gender = b.gender === "男" ? "男" : "女";
    if (b.status !== undefined) {
      if (!statusOk(b.status)) throw { code: "BAD_REQUEST", message: "status 取值非法" };
      const usedBy = Array.isArray(e.used_by) ? e.used_by.filter(Boolean) : [];
      if (b.status === "retired" && usedBy.length && !b.force) {
        return router.json(res, 409, { error: { code: "IN_USE", message: "素材仍被引用（退役请传 force:true）" }, used_by: usedBy });
      }
      e.status = b.status;
    }
    store.commit();
    audit(ctx, auth, "asset_update", params.domain + ":" + params.id, { patch: Object.keys(b) });
    return router.json(res, 200, { entry: e });
  }, { auth: true });

  /* ================= 绑定（K2：1:N + primary + 反向索引） ================= */

  const KINDS = ["scene", "episode", "character", "project"];
  router.add("POST", "/api/studio/:domain/:id/bind", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    if (KINDS.indexOf(b.kind) < 0) throw { code: "BAD_REQUEST", message: "kind 取值非法" };
    const st = store.get();
    // 绑定目标存在性
    if (b.kind === "scene" && !(st.scenes || {})[b.id]) throw { code: "NOT_FOUND", message: "场景不存在: " + b.id };
    if (b.kind === "episode" && !(st.episodes || {})[b.id]) throw { code: "NOT_FOUND", message: "集不存在: " + b.id };
    if (b.kind === "project" && !(st.projects || {})[b.id]) throw { code: "NOT_FOUND", message: "项目不存在: " + b.id };
    if (b.kind === "character" && !findEntry(ctx, "characters", b.id)) throw { code: "NOT_FOUND", message: "角色不存在: " + b.id };
    const e = findEntry(ctx, params.domain, params.id);
    if (!e) throw { code: "NOT_FOUND", message: "素材不存在: " + params.id };
    if (e.status === "retired") throw { code: "BAD_REQUEST", message: "素材已退役，不能绑定" };
    e.used_by = Array.isArray(e.used_by) ? e.used_by : [];
    if (e.used_by.some((u) => u && u.kind === b.kind && String(u.id) === String(b.id))) {
      if (b.primary) e.used_by.forEach((u) => { if (u.kind === b.kind && String(u.id) === String(b.id)) u.primary = true; });
    } else {
      e.used_by.push({ kind: b.kind, id: String(b.id), primary: !!b.primary, at: Date.now() });
    }
    // 场景主曲唯一（compose 每场取一条）：换主曲时取消同场其它 primary
    if (b.kind === "scene" && b.primary) {
      libOf(st).audio.music.forEach((m) => {
        if (m === e || !Array.isArray(m.used_by)) return;
        m.used_by.forEach((u) => { if (u.kind === "scene" && String(u.id) === String(b.id)) u.primary = false; });
      });
    }
    store.commit();
    audit(ctx, auth, "asset_bind", params.domain + ":" + params.id, { kind: b.kind, id: b.id, primary: !!b.primary });
    return router.json(res, 200, { entry: e });
  }, { auth: true });

  router.add("POST", "/api/studio/:domain/:id/unbind", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    const e = findEntry(ctx, params.domain, params.id);
    if (!e) throw { code: "NOT_FOUND", message: "素材不存在: " + params.id };
    e.used_by = (Array.isArray(e.used_by) ? e.used_by : []).filter((u) => !(u && u.kind === b.kind && String(u.id) === String(b.id)));
    store.commit();
    audit(ctx, auth, "asset_unbind", params.domain + ":" + params.id, { kind: b.kind, id: b.id });
    return router.json(res, 200, { entry: e });
  }, { auth: true });

  router.add("GET", "/api/studio/used_by/:domain/:id", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const st = store.get();
    const e = findEntry(ctx, params.domain, params.id);
    if (!e) throw { code: "NOT_FOUND", message: "素材不存在: " + params.id };
    const used = (Array.isArray(e.used_by) ? e.used_by : []).map((u) => {
      let name = u.id;
      if (u.kind === "scene" && st.scenes[u.id]) name = st.scenes[u.id].name;
      else if (u.kind === "episode" && st.episodes[u.id]) name = st.episodes[u.id].title;
      else if (u.kind === "project" && st.projects[u.id]) name = st.projects[u.id].title;
      else if (u.kind === "character") { const c = findEntry(ctx, "characters", u.id); name = c ? c.role : u.id; }
      return Object.assign({}, u, { name });
    });
    return router.json(res, 200, { used_by: used });
  }, { auth: true });

  /* ================= 生成（K1：与绑定解耦） ================= */

  // 音乐：一次 count 个任务 × 3 候选 → 候选池；不挂集（K8），scope 由 projectId 决定。
  // 专业配置层（2026-11-22·对齐 ACE-Step 1.5 原生通道）：tags 组装/lyrics 结构标记/
  // caption 自然语言/instrumental/BPM——最终 tags 在 API 层组装（顺序稳定，随 payload 快照可回放）。
  router.add("POST", "/api/studio/audio/music/generate", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    const st = store.get();
    const projectId = b.projectId ? String(b.projectId) : null;
    if (projectId && !(st.projects || {})[projectId]) throw { code: "NOT_FOUND", message: "项目不存在: " + projectId };
    const mood = String(b.mood || "").trim().slice(0, 12) || "释然";
    const type = ["bgm", "theme", "ambient", "mv"].indexOf(b.type) >= 0 ? b.type : "bgm";
    const sec = Math.max(15, Math.min(180, Number(b.sec) || 0)) || undefined;

    const instrumental = !!b.instrumental;
    // tags 组装（prompts/dicts.js composeMusicTags）：base 优先级＝专家自由 tags > 情绪词典 > 类型 hint
    const genres = Array.isArray(b.genres) ? b.genres.map((x) => String(x).slice(0, 40)).join(", ") : String(b.genres || "").slice(0, 200);
    const instruments = Array.isArray(b.instruments) ? b.instruments.map((x) => String(x).slice(0, 40)).join(", ") : String(b.instruments || "").slice(0, 200);
    const base = String(b.tags || "").trim().slice(0, 300) || prompts.musicTags(mood);
    const finalTags = prompts.composeMusicTags({
      base: (base !== prompts.musicTags(mood)) ? base : "",  // 显式 tags 才作 base
      genres, instruments,
      moodWord: (base === prompts.musicTags(mood)) ? mood : "",
      bpm: Number(b.bpm) || "",
      vocal: instrumental ? "" : String(b.vocal || "").slice(0, 60),
      extra: prompts.MUSIC_TYPE_PRESETS[type] ? prompts.MUSIC_TYPE_PRESETS[type].tagsHint : ""
    }) || prompts.musicTags(mood);
    // lyrics：纯音乐默认结构段标记（ACE-Step 无文本段标记法）；主题曲/MV 走完整歌词
    const preset = prompts.MUSIC_TYPE_PRESETS[type] || {};
    let lyrics = String(b.lyrics || "").slice(0, 4000);
    if (instrumental && !lyrics.trim()) lyrics = String(b.structure || preset.structureLine || "[instrumental]").slice(0, 400);
    const caption = String(b.caption || "").slice(0, 400);
    const warns = prompts.lyricsWarnings(lyrics, instrumental);

    const jobs = [];
    const count = Math.max(1, Math.min(3, Number(b.count) || 2));
    for (let i = 0; i < count; i++) {
      jobs.push(engine.enqueue("music", {
        type, mood, tags: finalTags, lyrics, instrumental, bpm: Number(b.bpm) || undefined,
        caption: caption || undefined, sec, projectId,
        gen_mode: String(b.mode || "quick").slice(0, 12)
      }, { initiated_by: "user" }));
    }
    audit(ctx, auth, "studio_music_generate", projectId || "global", { type, mood, count, mode: b.mode || "quick", tags: finalTags.slice(0, 120), instrumental });
    return router.json(res, 202, { jobs, expected: count * 3, tags: finalTags, lyrics_used: instrumental ? "structure-marks" : "user-lyrics", warnings: warns });
  }, { auth: true });

  // 图像：img_free ×count → 候选池。专业配置（2026-11-22 下午③）：景别/光线/负面增补进 payload，
  // worker 侧 buildFreeImagePrompt 四层拼装（风格锚→景别机位→描述→光线）；desc 支持多行专家模式。
  router.add("POST", "/api/studio/images/generate", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    const desc = String(b.desc || b.text || "").trim();
    if (!desc) throw { code: "BAD_REQUEST", message: "desc（画面描述）必填" };
    const st = store.get();
    const projectId = b.projectId ? String(b.projectId) : null;
    if (projectId && !(st.projects || {})[projectId]) throw { code: "NOT_FOUND", message: "项目不存在: " + projectId };
    const jobs = [];
    const count = Math.max(1, Math.min(4, Number(b.count) || 1));
    for (let i = 0; i < count; i++) {
      jobs.push(engine.enqueue("img_free", {
        type: ["establishing", "empty", "prop", "poster", "mood", "mv"].indexOf(b.type) >= 0 ? b.type : "mood",
        desc: desc.slice(0, 800),
        styleLook: String(b.styleLook || "").slice(0, 30) || undefined,
        refImage: b.refImage ? String(b.refImage).slice(0, 200) : undefined,
        ratio: b.ratio === "9:16" || b.ratio === "16:9" || b.ratio === "1:1" ? b.ratio : "9:16",
        size: String(b.size || "").slice(0, 12) || undefined,          // 景别（dicts.SHOT_SIZE 键）
        light: String(b.light || "").slice(0, 120) || undefined,        // 光线一句话
        negativeExtra: String(b.negativeExtra || "").slice(0, 200) || undefined,
        projectId
      }, { initiated_by: "user" }));
    }
    audit(ctx, auth, "studio_image_generate", projectId || "global", { count, type: b.type || "mood", size: b.size || "", hasRef: !!b.refImage });
    return router.json(res, 202, { jobs, expected: count });
  }, { auth: true });

  /* ================= 通用上传（B3，复用 castref/upload 原始字节范式） =================
   * POST /api/studio/upload?domain=images|sfx|ambience&title=…&type=…&licenseModel=…&licenseUsage=…
   * 图像域：PNG/JPEG（魔数校验）；音频域：WAV(RIFF)/MP3(ID3|FFFB)。直接入库（approved，source=upload）。 */

  router.add("POST", "/api/studio/upload", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const q = parseQ(req);
    const domain = q.domain;
    if (["images", "sfx", "ambience"].indexOf(domain) < 0) throw { code: "BAD_REQUEST", message: "domain 只能是 images|sfx|ambience（?domain=）" };
    const buf = Buffer.isBuffer(body) ? body : null;
    if (!buf || buf.length < 100) throw { code: "BAD_REQUEST", message: "请求体须为文件原始字节" };
    const s = buf.toString("latin1");
    const isPng = buf.length > 24 && s.slice(1, 4) === "PNG";
    const isJpg = s.slice(0, 3) === "\xff\xd8\xff";
    const isWav = s.slice(0, 4) === "RIFF" && s.slice(8, 12) === "WAVE";
    const isMp3 = s.slice(0, 3) === "ID3" || (buf.length > 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    if (domain === "images" && !isPng && !isJpg) throw { code: "BAD_REQUEST", message: "图像域仅支持 PNG/JPEG" };
    if (domain !== "images" && !isWav && !isMp3) throw { code: "BAD_REQUEST", message: "音频域仅支持 WAV/MP3" };
    const dir = path.join(varRoot(ctx), "assets", "library", domain);
    fs.mkdirSync(dir, { recursive: true });
    const ext = domain === "images" ? (isPng ? ".png" : ".jpg") : (isWav ? ".wav" : ".mp3");
    const fn = "up_" + util.uid("f") + ext;
    fs.writeFileSync(path.join(dir, fn), buf);
    const st = store.get();
    const entry = {
      id: util.uid(domain === "images" ? "img" : "aud"),
      title: String(q.title || "上传素材").slice(0, 60),
      type: String(q.type || (domain === "images" ? "mood" : "bgm")).slice(0, 20),
      mood: String(q.mood || "").slice(0, 12),
      sec: domain === "images" ? undefined : Number(q.sec) || undefined,
      desc: String(q.desc || "").slice(0, 400),
      tags: String(q.tags || "").slice(0, 120),
      license: { model: String(q.licenseModel || "自持授权").slice(0, 40), usage: String(q.licenseUsage || "ok") === "missing" ? "missing" : "ok" },
      shadow_cents: 0,
      art: "var/assets/library/" + domain + "/" + fn,
      scope: q.projectId && (st.projects || {})[q.projectId] ? "project" : "global",
      projectId: q.projectId || null,
      status: "approved",
      rating: 0,
      used_by: [],
      moderation: { pass: true, checked_at: Date.now(), checks: ["upload-magic"] },
      source: "upload",
      created_at: Date.now()
    };
    if (domain === "images") st.asset_lib.images.push(entry);
    else if (domain === "sfx") st.asset_lib.audio.sfx.push(entry);
    else st.asset_lib.audio.ambience.push(entry);
    store.commit();
    audit(ctx, auth, "asset_upload", domain + ":" + entry.id, { file: fn, bytes: buf.length, license: entry.license });
    return router.json(res, 200, { entry, file: fn, bytes: buf.length });
  }, { auth: true, raw: true, limit: 64 * 1024 * 1024 });

  /* ================= 候选池（K3） ================= */

  router.add("DELETE", "/api/studio/drafts/:domain/:id", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const st = store.get();
    const arr = draftList(st, params.domain);
    const idx = arr.findIndex((x) => x.id === params.id);
    if (idx < 0) throw { code: "NOT_FOUND", message: "候选不存在: " + params.id };
    arr.splice(idx, 1);
    store.commit();
    audit(ctx, auth, "studio_draft_discard", params.domain + ":" + params.id, {});
    return router.json(res, 200, { ok: true });
  }, { auth: true });

  // 候选 → 入库（状态机 draft→approved）；图像可挂角色版本/场景定场图（回流闭环）
  router.add("POST", "/api/studio/drafts/:domain/:id/adopt", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    const st = store.get();
    require("../core/store.js").pruneDrafts(st);
    const arr = draftList(st, params.domain);
    const idx = arr.findIndex((x) => x.id === params.id);
    if (idx < 0) throw { code: "NOT_FOUND", message: "候选不存在: " + params.id };
    const d = arr[idx];

    const gate = moderateAsset(ctx, { text: params.domain === "images" ? d.desc : d.title, art: d.art });
    if (!gate.pass) {
      return router.json(res, 422, { error: { code: "MODERATION_FAIL", message: gate.reason } });
    }

    const art = archiveArt(ctx, d.art, params.domain);
    let entry;
    if (params.domain === "music") {
      entry = {
        id: d.id || util.uid("mus"),
        title: b.title || d.title || "未命名配乐",
        type: d.type || "bgm",
        mood: d.mood || "中性",
        sec: d.sec || 45,
        tags: d.tags || "",
        engine: d.engine || "",
        license: d.license || { model: "MIT", usage: "missing" },
        shadow_cents: d.shadow_cents || 0,
        art,
        scope: d.scope || (d.projectId ? "project" : "global"),
        projectId: d.projectId || null,
        status: "approved",
        rating: 0,
        used_by: [],
        source: "generated",
        source_job_id: d.source_job_id || null,
        created_at: Date.now()
      };
      libOf(st).audio.music.push(entry);
    } else if (params.domain === "images") {
      entry = {
        id: d.id || util.uid("img"),
        title: b.title || d.title || "未命名图像",
        type: d.type || "mood",
        desc: d.desc || "",
        style_look: d.style_look || "",
        ref_image: d.ref_image || null,
        ratio: d.ratio || "9:16",
        art,
        shadow_cents: d.shadow_cents || 0,
        scope: d.scope || (d.projectId ? "project" : "global"),
        projectId: d.projectId || null,
        status: "approved",
        rating: 0,
        used_by: [],
        moderation: { pass: true, checked_at: Date.now() },
        source: "generated",
        created_at: Date.now()
      };
      st.asset_lib.images.push(entry);
      // 回流挂接：角色重定妆版本 / 场景定场图
      if (b.attachCharacter) {
        const ch = findEntry(ctx, "characters", String(b.attachCharacter));
        if (ch) {
          ch.versions = Array.isArray(ch.versions) ? ch.versions : [];
          ch.versions.push({ ver: (ch.versions.length + 1), art, at: Date.now(), note: String(b.note || "重定妆").slice(0, 40) });
          if (!ch.refImage) ch.refImage = art;
        }
      }
      if (b.attachScene) {
        const sc = findEntry(ctx, "scenes", String(b.attachScene));
        if (sc) {
          if (b.variantTag) {
            sc.variants = Array.isArray(sc.variants) ? sc.variants : [];
            const v = sc.variants.filter((x) => x.tag === b.variantTag)[0];
            if (v) v.img = art; else sc.variants.push({ tag: String(b.variantTag).slice(0, 12), img: art });
          } else sc.establishing = art;
        }
      }
    } else {
      throw { code: "NOT_FOUND", message: "候选池不支持该域: " + params.domain };
    }
    arr.splice(idx, 1);
    store.commit();
    audit(ctx, auth, "studio_adopt", params.domain + ":" + entry.id, { attach: { character: b.attachCharacter || null, scene: b.attachScene || null, variant: b.variantTag || null } });
    try { bus.publish("cards", { event: "studio_adopted", domain: params.domain, id: entry.id }); } catch (e2) {}
    return router.json(res, 200, { entry });
  }, { auth: true });

  /* ================= 角色域（B5：主体库，可灵等价物） ================= */

  // 从集 cast 实体化（生产回流入口之一）
  router.add("POST", "/api/studio/characters/extract", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    const st = store.get();
    const ep = (st.episodes || {})[b.episodeId];
    if (!ep) throw { code: "NOT_FOUND", message: "集不存在: " + b.episodeId };
    const cast = ((ep.script || {}).cast || []).filter((c) => c && c.role);
    const c = cast.filter((x) => x.role === b.role)[0] || cast[0];
    if (!c) throw { code: "NOT_FOUND", message: "剧本里找不到角色: " + (b.role || "（cast 为空）") };
    const existing = libOf(st).characters.filter((x) => x.role === c.role && x.status !== "retired")[0];
    if (existing) return router.json(res, 200, { character: existing, existed: true });
    const views = ((st.viewRefs || {})[ep.id] || {})[c.role] || [];
    const entry = {
      id: util.uid("chr"),
      role: c.role,
      name: c.name || c.role,
      gender: c.gender === "男" ? "男" : "女",
      voice: c.voice || "",
      anchor: c.desc || "",
      refImage: c.refImage || null,
      views: Array.isArray(views) ? views.slice() : [],
      wardrobe: [],
      versions: c.refImage ? [{ ver: 1, art: c.refImage, at: Date.now(), note: "从《" + (ep.title || ep.id) + "》提取" }] : [],
      scope: "project",
      projectId: ep.projectId || null,
      status: "approved",
      used_by: [{ kind: "episode", id: ep.id, at: Date.now() }],
      created_at: Date.now()
    };
    st.asset_lib.characters.push(entry);
    store.commit();
    audit(ctx, auth, "character_extract", entry.id, { episodeId: ep.id, role: c.role });
    return router.json(res, 201, { character: entry });
  }, { auth: true });

  // 重定妆 = 新版本（K 版本管理）：img_free 任务（锚点+参考图）→ 候选池 → adopt {attachCharacter}
  router.add("POST", "/api/studio/characters/:id/recast", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    const ch = findEntry(ctx, "characters", params.id);
    if (!ch) throw { code: "NOT_FOUND", message: "角色不存在: " + params.id };
    const job = engine.enqueue("img_free", {
      type: "establishing",
      desc: "角色定妆照：" + String(ch.anchor || ch.role).slice(0, 300),
      refImage: ch.refImage || undefined,
      ratio: "9:16",
      projectId: ch.projectId || undefined
    }, { initiated_by: "user" });
    audit(ctx, auth, "character_recast", ch.id, { job_id: job && job.id });
    return router.json(res, 202, { job, note: "候选出来后在素材中心「图像」tab 收藏，并选择挂到该角色（生成新版本）" });
  }, { auth: true });

  // 试镜帧池回流（B8）：viewRefs → character.views
  router.add("POST", "/api/studio/characters/:id/promote_frames", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    const st = store.get();
    const ch = findEntry(ctx, "characters", params.id);
    if (!ch) throw { code: "NOT_FOUND", message: "角色不存在: " + params.id };
    const refs = ((st.viewRefs || {})[b.episodeId] || {})[b.role || ch.role] || [];
    if (!Array.isArray(refs) || !refs.length) throw { code: "NOT_FOUND", message: "该集/角色没有已固化的试镜帧池" };
    const before = (ch.views || []).length;
    ch.views = refs.slice();
    store.commit();
    audit(ctx, auth, "character_promote_frames", ch.id, { episodeId: b.episodeId, from: before, to: refs.length });
    return router.json(res, 200, { character: ch, added: refs.length - before });
  }, { auth: true });

  /* ================= 场景域（B6：场景卡） ================= */

  router.add("POST", "/api/studio/scenes", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    const name = String(b.name || "").trim().slice(0, 40);
    if (!name) throw { code: "BAD_REQUEST", message: "name 必填" };
    const st = store.get();
    const entry = {
      id: util.uid("scn"),
      name,
      mood: String(b.mood || "中性").slice(0, 12),
      env_desc: String(b.envDesc || "").slice(0, 300),
      light_preset: String(b.lightPreset || "").slice(0, 120),
      ambienceId: b.ambienceId || null,
      establishing: null,
      variants: [],
      boundSceneId: b.boundSceneId || null,
      scope: b.projectId && (st.projects || {})[b.projectId] ? "project" : "global",
      projectId: b.projectId || null,
      status: "approved",
      used_by: [],
      created_at: Date.now()
    };
    st.asset_lib.scenes.push(entry);
    store.commit();
    audit(ctx, auth, "scene_card_create", entry.id, { name });
    return router.json(res, 201, { scene: entry });
  }, { auth: true });

  // 定场图生成（img_free，场景特化：env_desc + 变体）→ 候选池 → adopt {attachScene}
  router.add("POST", "/api/studio/scenes/:id/establishing", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    const sc = findEntry(ctx, "scenes", params.id);
    if (!sc) throw { code: "NOT_FOUND", message: "场景卡不存在: " + params.id };
    const variant = String(b.variantTag || "").trim().slice(0, 12);
    const light = variant ? (variant + "光线下的") + (sc.env_desc || sc.name) : (sc.env_desc || sc.name);
    const job = engine.enqueue("img_free", {
      type: "establishing",
      desc: ("场景定场图：" + light + "，氛围" + (sc.mood || "中性")).slice(0, 400),
      ratio: "9:16",
      projectId: sc.projectId || undefined
    }, { initiated_by: "user" });
    audit(ctx, auth, "scene_establishing", sc.id, { job_id: job && job.id, variant: variant || null });
    return router.json(res, 202, { job, variantTag: variant || null });
  }, { auth: true });

  /* ================= 音色域（C3） ================= */

  router.add("POST", "/api/studio/voices", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    const name = String(b.name || "").trim().slice(0, 30);
    if (!name) throw { code: "BAD_REQUEST", message: "name 必填" };
    const st = store.get();
    const entry = {
      id: util.uid("voi"),
      name,
      gender: b.gender === "男" ? "男" : "女",
      spk: String(b.spk || "").slice(0, 40) || (b.gender === "男" ? "中文男" : "中文女"),
      note: String(b.note || "").slice(0, 80),
      used_by: [],
      created_at: Date.now()
    };
    st.asset_lib.audio.voices.push(entry);
    store.commit();
    audit(ctx, auth, "voice_create", entry.id, { name });
    return router.json(res, 201, { voice: entry });
  }, { auth: true });

  /* ================= 设定域（C1） ================= */

  const CANON_KINDS = {
    style_pkgs: (l) => l.canon.style_pkgs,
    reject_rules: (l) => l.canon.reject_rules,
    lore: (l) => l.canon.lore,
    beats: (l) => l.canon.beats
  };

  router.add("GET", "/api/studio/canon/:kind", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const get = CANON_KINDS[params.kind];
    if (!get) throw { code: "NOT_FOUND", message: "未知设定种类: " + params.kind };
    return router.json(res, 200, { kind: params.kind, list: get(libOf(store.get())) });
  }, { auth: true });

  router.add("POST", "/api/studio/canon/:kind", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const get = CANON_KINDS[params.kind];
    if (!get) throw { code: "NOT_FOUND", message: "未知设定种类: " + params.kind };
    const b = body || {};
    const st = store.get();
    let entry;
    if (params.kind === "style_pkgs") {
      // 风格包多包管理（C1）：以 look 为键，保留完整包字段（t2i_suffix/grade_line/light_by_mood/music_tags…）
      const look = String(b.look || "").trim().slice(0, 30);
      if (!look) throw { code: "BAD_REQUEST", message: "look 必填" };
      const arr = get(st.asset_lib);
      const ex = arr.filter((x) => x.look === look)[0];
      entry = Object.assign({}, ex || { id: util.uid("sty"), look, created_at: Date.now() }, {
        look,
        grade_line: String(b.grade_line || (ex && ex.grade_line) || "").slice(0, 120),
        t2i_suffix: String(b.t2i_suffix || (ex && ex.t2i_suffix) || "").slice(0, 300),
        video_suffix_zh: String(b.video_suffix_zh || (ex && ex.video_suffix_zh) || "").slice(0, 200),
        light_by_mood: b.light_by_mood && typeof b.light_by_mood === "object" ? b.light_by_mood : (ex && ex.light_by_mood) || {},
        ambience_by_env: b.ambience_by_env && typeof b.ambience_by_env === "object" ? b.ambience_by_env : (ex && ex.ambience_by_env) || {},
        music_tags: String(b.music_tags || (ex && ex.music_tags) || "").slice(0, 200),
        negative_extra: String(b.negative_extra || (ex && ex.negative_extra) || "").slice(0, 200),
        updated_at: Date.now()
      });
      if (!ex) arr.push(entry); else Object.assign(ex, entry);
    } else {
      entry = {
        id: util.uid("can"),
        kind: params.kind,
        title: String(b.title || "未命名").slice(0, 60),
        content: String(b.content || "").slice(0, 2000),
        created_at: Date.now()
      };
      get(st.asset_lib).push(entry);
    }
    store.commit();
    audit(ctx, auth, "canon_update", params.kind, { title: (entry && entry.look) || (entry && entry.title) || "" });
    return router.json(res, 201, { entry });
  }, { auth: true });

  /* ================= 公共库与素材包（C5） ================= */

  // 导出：manifest（元数据 JSON；文件引用同机 var/assets 路径，自部署单机无需搬二进制）
  router.add("POST", "/api/studio/packs/export", (req, res, body, params, auth) => {
    if (!auth || !auth || (auth.role !== "ops" && auth.role !== "creator")) throw { code: "FORBIDDEN", message: "需要登录" };
    const st = store.get();
    const l = libOf(st);
    const pack = {
      format: "theater-asset-pack",
      version: 1,
      exported_at: Date.now(),
      data: {
        music: l.audio.music, sfx: l.audio.sfx, ambience: l.audio.ambience, voices: l.audio.voices,
        images: l.images, characters: l.characters, scenes: l.scenes, canon: l.canon
      }
    };
    audit(ctx, auth, "asset_pack_export", "library", {});
    return router.json(res, 200, { pack });
  }, { auth: true });

  // 导入：元数据合并（新 id，scope=global，source=import；冲突条目跳过）
  router.add("POST", "/api/studio/packs/import", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const pack = (body || {}).pack;
    if (!pack || pack.format !== "theater-asset-pack" || !pack.data) throw { code: "BAD_REQUEST", message: "素材包格式不对（theater-asset-pack v1）" };
    const st = store.get();
    const l = libOf(st);
    const reId = () => util.uid("imp");
    const rebindIds = {};
    let added = 0;
    const mergeArr = (srcArr, dstArr, fix) => {
      (Array.isArray(srcArr) ? srcArr : []).forEach((x) => {
        if (!x || !x.id) return;
        const dup = dstArr.some((y) => (y.source_key && y.source_key === (x.id + "|" + (x.title || x.name || x.role || ""))) || (x.role && y.role === x.role && y.scope === "global" && dstArr === l.characters));
        if (dup) return;
        const copy = JSON.parse(JSON.stringify(x));
        rebindIds[x.id] = reId();
        copy.id = rebindIds[x.id];
        copy.source_key = x.id + "|" + (x.title || x.name || x.role || "");
        copy.scope = "global";
        copy.projectId = null;
        copy.source = "import";
        copy.used_by = [];
        if (fix) fix(copy);
        dstArr.push(copy);
        added++;
      });
    };
    mergeArr(pack.data.music, l.audio.music);
    mergeArr(pack.data.sfx, l.audio.sfx);
    mergeArr(pack.data.ambience, l.audio.ambience);
    mergeArr(pack.data.voices, l.audio.voices);
    mergeArr(pack.data.images, l.images);
    mergeArr(pack.data.characters, l.characters, (c) => { c.versions = Array.isArray(c.versions) ? c.versions : []; c.views = Array.isArray(c.views) ? c.views : []; });
    mergeArr(pack.data.scenes, l.scenes, (s) => { s.variants = Array.isArray(s.variants) ? s.variants : []; });
    // canon：style_pkgs 按 look 合并，其余追加
    const cIn = pack.data.canon || {};
    (Array.isArray(cIn.style_pkgs) ? cIn.style_pkgs : []).forEach((sp) => {
      if (!sp || !sp.look) return;
      if (l.canon.style_pkgs.some((x) => x.look === sp.look)) return;
      const copy = JSON.parse(JSON.stringify(sp));
      copy.id = reId();
      copy.scope = "global";
      copy.source = "import";
      l.canon.style_pkgs.push(copy);
      added++;
    });
    ["reject_rules", "lore", "beats"].forEach((k) => mergeArr(cIn[k], l.canon[k]));
    store.commit();
    audit(ctx, auth, "asset_pack_import", "library", { added });
    return router.json(res, 200, { added });
  }, { auth: true });

  /* ================= AI 辅助（2026-11-22 下午③）：歌词扩写/画面提示词 =================
   * 行业口径（Suno/即梦「AI 帮我写」）：粘贴素材 → 按模型特性扩写结构化产物。
   * llm 离线 → 503 LLM_OFFLINE（如实，不降级伪造）。payload 全量审计。 */

  router.add("POST", "/api/studio/ai/lyrics", async (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    if (!ctx.llm || !ctx.llm.enabled()) throw { code: "LLM_OFFLINE", message: "AI 助手没在线（左下角 GPU 徽章可看状态）——离线时不能 AI 扩写" };
    const paste = String(b.paste || "").trim();
    if (!paste) throw { code: "BAD_REQUEST", message: "paste（歌词素材/主题描述）必填" };
    const typeLabel = (prompts.MUSIC_TYPE_PRESETS[b.type] || {}).label || "主题曲";
    const sys = prompts.buildAssistLyricsSys();
    const usr = prompts.buildAssistLyricsUsr({
      paste, typeLabel, mood: b.mood, style: String(b.style || "").slice(0, 80),
      sec: Number(b.sec) || 0, instrumental: !!b.instrumental, note: b.note
    });
    const r = await (async () => ctx.llm.chat(
      [{ role: "system", content: sys }, { role: "user", content: usr }],
      { temperature: 0.7, maxTokens: 1600, timeoutMs: 90000 }
    ))();
    if (!r || !r.ok || !r.content) throw { code: "LLM_BAD", message: "AI 没给出结果（" + ((r && r.error) || "超时") + "）——稍后重试" };
    const lyrics = String(r.content).replace(/```[a-z]*\n?/gi, "").trim().slice(0, 4000);
    audit(ctx, auth, "ai_lyrics_assist", b.type || "theme", { paste_len: paste.length, out_len: lyrics.length });
    return router.json(res, 200, { lyrics, warnings: prompts.lyricsWarnings(lyrics, !!b.instrumental) });
  }, { auth: true });

  router.add("POST", "/api/studio/ai/image-prompt", async (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    if (!ctx.llm || !ctx.llm.enabled()) throw { code: "LLM_OFFLINE", message: "AI 助手没在线（左下角 GPU 徽章可看状态）——离线时不能 AI 写画面" };
    const idea = String(b.idea || "").trim();
    if (!idea) throw { code: "BAD_REQUEST", message: "idea（画面想法）必填" };
    const sys = prompts.buildAssistImageSys();
    const usr = prompts.buildAssistImageUsr({ idea, type: b.type, mood: b.mood, styleLook: b.styleLook, ratio: b.ratio });
    const r = await (async () => ctx.llm.chat(
      [{ role: "system", content: sys }, { role: "user", content: usr }],
      { temperature: 0.6, maxTokens: 900, timeoutMs: 90000 }
    ))();
    if (!r || !r.ok || !r.content) throw { code: "LLM_BAD", message: "AI 没给出结果（" + ((r && r.error) || "超时") + "）——稍后重试" };
    const m = String(r.content).match(/\{[\s\S]*\}/);
    let out = null;
    try { out = JSON.parse(m[0]); } catch (e) { out = null; }
    if (!out || !out.desc) throw { code: "LLM_BAD", message: "AI 输出解析失败——稍后重试" };
    audit(ctx, auth, "ai_image_assist", b.type || "mood", { idea_len: idea.length });
    return router.json(res, 200, {
      desc: String(out.desc || "").slice(0, 600),
      negative: String(out.negative || "").slice(0, 200),
      tags: String(out.tags || "").slice(0, 200)
    });
  }, { auth: true });

  /* ================= 集级音色映射（C3） ================= */

  // PATCH 语义：{voice_map:{role: voiceId|spk键|null}} 合并写入 episode.voice_map（null 删除该角色覆盖）
  router.add("POST", "/api/studio/voice_map/:episodeId", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const st = store.get();
    const ep = (st.episodes || {})[params.episodeId];
    if (!ep) throw { code: "NOT_FOUND", message: "集不存在: " + params.episodeId };
    const b = body || {};
    const map = b.voice_map && typeof b.voice_map === "object" ? b.voice_map : {};
    ep.voice_map = ep.voice_map && typeof ep.voice_map === "object" ? ep.voice_map : {};
    Object.keys(map).forEach((role) => {
      if (map[role] == null || map[role] === "") delete ep.voice_map[role];
      else ep.voice_map[role] = String(map[role]).slice(0, 60);
    });
    if (!Object.keys(ep.voice_map).length) delete ep.voice_map;
    store.commit();
    audit(ctx, auth, "voice_map_update", params.episodeId, { roles: Object.keys(map) });
    return router.json(res, 200, { voice_map: ep.voice_map || null });
  }, { auth: true });

  /* ================= MV 素材包（C7）：选曲＋选图 → 宣发短片 =================
   * 行业口径：MV 是宣发物料——主题曲 × 定妆/定场图轮播，ffmpeg best-effort；
   * 环境无 ffmpeg 时如实返回 skipped（不伪造产物）。 */

  router.add("POST", "/api/studio/mv/build", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    const b = body || {};
    const st = store.get();
    const music = findEntry(ctx, "music", b.musicId);
    if (!music || !music.art) throw { code: "NOT_FOUND", message: "主题曲不存在或缺产物文件: " + b.musicId };
    const imgIds = Array.isArray(b.imageIds) ? b.imageIds.slice(0, 12) : [];
    const imgs = imgIds.map((id) => findEntry(ctx, "images", id)).filter((x) => x && x.art);
    if (!imgs.length) throw { code: "BAD_REQUEST", message: "imageIds 至少给 1 张素材图" };
    const musicAbs = resolveOutFile(ctx, music.art) || path.join(varRoot(ctx), String(music.art).replace(/^var\//, ""));
    if (!fs.existsSync(musicAbs)) throw { code: "NOT_FOUND", message: "音频文件不存在: " + music.art };
    const imgAbs = imgs.map((im) => resolveOutFile(ctx, im.art) || path.join(varRoot(ctx), String(im.art).replace(/^var\//, ""))).filter((p) => fs.existsSync(p));
    if (!imgAbs.length) throw { code: "NOT_FOUND", message: "素材图文件全部缺失" };

    const segSec = Math.max(1.5, Math.min(6, Number(b.secPerImage) || 3));
    const outDir = varRoot(ctx) ? path.join(varRoot(ctx), "out") : path.join(process.cwd(), "var", "out");
    fs.mkdirSync(outDir, { recursive: true });
    const mvId = util.uid("mv");
    const finalPath = path.join(outDir, "mv_" + mvId + ".mp4");
    const manifest = {
      kind: "mv-pack", id: mvId, title: String(b.title || "宣发 MV").slice(0, 40),
      music: { id: music.id, title: music.title }, images: imgs.map((im) => ({ id: im.id, title: im.title })),
      sec_per_image: segSec, images_used: imgAbs.length, created_at: Date.now()
    };
    // best-effort 合成：每图一段（loop+zoompan 轻推）→ concat → 配乐垫底（音频随最短轨）
    const hasFfmpeg = (function () { try { require("child_process").execSync("ffmpeg -version", { stdio: "ignore" }); return true; } catch (e) { return false; } })();
    if (!hasFfmpeg) {
      return router.json(res, 200, { ok: false, skipped: "本机没有 ffmpeg——MV 清单已生成，装好 ffmpeg 重试即可出片", manifest });
    }
    try {
      const tmp = path.join(outDir, "_mv_" + mvId);
      fs.mkdirSync(tmp, { recursive: true });
      const { execFileSync } = require("child_process");
      const segs = [];
      imgAbs.forEach((img, i) => {
        const seg = path.join(tmp, "seg" + i + ".mp4");
        execFileSync("ffmpeg", ["-y", "-loop", "1", "-i", img, "-t", String(segSec),
          "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,zoompan=z='min(zoom+0.0008,1.08)':d=" + Math.round(segSec * 24) + ":s=720x1280:fps=24",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", seg], { timeout: 120000, stdio: "ignore" });
        segs.push(seg);
      });
      const listFile = path.join(tmp, "list.txt");
      fs.writeFileSync(listFile, segs.map((s) => "file '" + s.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'").join("\n"), "utf8");
      execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-i", musicAbs,
        "-map", "0:v", "-map", "1:a", "-shortest", "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", finalPath], { timeout: 180000, stdio: "ignore" });
      fs.rmSync(tmp, { recursive: true, force: true });
      manifest.art = "var/out/mv_" + mvId + ".mp4";
      store.log("audit", { operator: (auth && (auth.uid || auth.id)) || null, action: "mv_build", target: mvId, manifest });
      return router.json(res, 200, { ok: true, manifest });
    } catch (e) {
      return router.json(res, 200, { ok: false, skipped: "合成失败：" + String((e && e.message) || e).slice(0, 120), manifest });
    }
  }, { auth: true });

  /* ================= 旧读取面查询口（A8 兼容缝） ================= */

  router.add("GET", "/api/studio/music_for_scene/:sceneId", (req, res, body, params, auth) => {
    if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
    return router.json(res, 200, { music: musicForScene(ctx, params.sceneId) });
  }, { auth: true });
}

module.exports.register = register;
module.exports.musicForScene = musicForScene;
module.exports.hasSceneBinding = hasSceneBinding;
module.exports.libraryEntries = libraryEntries;
module.exports.findEntry = findEntry;
module.exports.moderateAsset = moderateAsset;
module.exports.archiveArt = archiveArt;
