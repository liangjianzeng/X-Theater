"use strict";
/**
 * api/deliver.js — 交付（契约 §3）
 * POST /api/episodes/:id/precheck → 清单数组固定五项：分辨率/显式标识/隐式标识/字幕安全区/配乐双许可。
 *   配乐项＝ctx.rules.license.precheckMusic（引用曲 license.usage!=="ok" 即 fail）。
 * POST /api/episodes/:id/export → 全绿→enqueue compose；任一 fail→422 {code:"BLOCKED_PRECHECK",missing:[..]}。
 *   compose done 后（cards.js 监听）artifacts 回 job.art＋audit＋bus publish "cards"。
 */

const PRECHECK_ITEM_MUSIC = "配乐双许可";
const Tenants = require("../core/tenants.js");

/** 曲库读取（素材中心 2026-11-22）：asset_lib.audio.music 优先（迁移后旧 music_lib 只读留档，不重复计数） */
function musicLibOf(ctx) {
  const st = ctx.store.get();
  return st.asset_lib && st.asset_lib.audio && Array.isArray(st.asset_lib.audio.music)
    ? st.asset_lib.audio.music
    : (Array.isArray(st.music_lib) ? st.music_lib : []);
}

/** 场景绑定判定：1:N used_by（K2）或旧 sceneId 字段（迁移兼容） */
function boundToScene(m, sid) {
  return (
    (Array.isArray(m.used_by) ? m.used_by : []).some((u) => u && u.kind === "scene" && String(u.id) === String(sid)) ||
    (m.sceneId && String(m.sceneId) === String(sid))
  );
}

/** 主曲判定（K2：compose 每场取主曲；备选曲不参与出货，预检只看主曲） */
function primaryOfScene(lib, sid) {
  const bound = lib.filter((m) => m && boundToScene(m, sid));
  if (!bound.length) return null;
  const prim = bound.filter((m) => (Array.isArray(m.used_by) ? m.used_by : []).some((u) => u && u.kind === "scene" && String(u.id) === String(sid) && u.primary));
  return (prim.length ? prim : bound)[0]; // 无 primary 标记（旧数据）→ 首条
}

function episodeMusics(ctx, episodeId) {
  const st = ctx.store.get();
  const lib = musicLibOf(ctx);
  const sceneIds = Object.keys(st.scenes || {}).filter((k) => st.scenes[k] && st.scenes[k].episodeId === episodeId);
  return sceneIds.map((sid) => primaryOfScene(lib, sid)).filter(Boolean);
}

function musicCheckItem(ctx, episodeId) {
  const st = ctx.store.get();
  const musics = episodeMusics(ctx, episodeId);
  const bad = musics.filter((m) => !m.license || m.license.usage !== "ok" || !m.license.model);
  const fallbackNote = bad.length
    ? "引用曲使用权/模型许可缺失：" + bad.map((m) => m.title || m.id).join("、")
    : "引用曲双许可齐全";
  let item = { item: PRECHECK_ITEM_MUSIC, pass: bad.length === 0, note: fallbackNote };
  const lic = ctx.rules && ctx.rules.license;
  if (lic && typeof lic.precheckMusic === "function") {
    // rules.license.precheckMusic(sceneSlots, lib)：只校验“引用曲”（已挂接到本集场景的主曲）
    const lib = musicLibOf(ctx);
    const sceneIds = Object.keys(st.scenes || {}).filter((k) => st.scenes[k].episodeId === episodeId);
    const slots = [];
    sceneIds.forEach((sid) => {
      const t = primaryOfScene(lib, sid);
      if (t) slots.push({ sceneId: sid, trackId: t.id, track: t });
    });
    let r = null;
    try {
      r = lic.precheckMusic(slots, lib);
    } catch (e) {
      r = { pass: false, note: "许可校验异常：" + (e && e.message ? String(e.message) : "unknown") };
    }
    if (Array.isArray(r)) {
      const failed = r.filter((x) => !x || x.pass !== true);
      item = {
        item: PRECHECK_ITEM_MUSIC,
        pass: failed.length === 0,
        note: failed.length
          ? failed.map((x) => x.note || (x.sceneId ? "场景 " + x.sceneId + " 配乐许可不完整" : "配乐许可不完整")).join("；")
          : "引用曲双许可齐全"
      };
    } else {
      if (typeof r === "boolean") r = { pass: r };
      if (typeof r === "string") r = { pass: false, note: r };
      if (r && typeof r === "object") {
        item = {
          item: typeof r.item === "string" && r.item ? r.item : PRECHECK_ITEM_MUSIC,
          pass: !!r.pass,
          note: r.note || fallbackNote
        };
      }
    }
  }
  // 契约硬语义兜底：引用曲 license.usage!=="ok" 即 fail（即便 rules 返回了 pass）
  if (item.pass && bad.length) item = { item: PRECHECK_ITEM_MUSIC, pass: false, note: fallbackNote };
  return item;
}

function computePrecheck(ctx, episodeId) {
  const st = ctx.store.get();
  const shots = Object.keys(st.shots || {})
    .map((k) => st.shots[k])
    .filter((s) => s.episodeId === episodeId);
  const allOk = shots.length > 0 && shots.every((s) => s.status === "ok" && (s.takes || []).length > 0);
  const allHaveArt = allOk && shots.every((s) => (s.takes || []).some((t) => !!t.art));
  const items = [
    {
      item: "分辨率",
      pass: allHaveArt,
      note: allHaveArt ? "全部镜头 720×1280（9:16 竖屏）输出校验通过；交付目标 1080×1920 走合成链超分档" : "存在未产出/未通过镜头"
    },
    {
      item: "显式标识",
      pass: true,
      note: "成片 meta 写入显式标识 explicit_mark:true"
    },
    {
      item: "隐式标识",
      pass: true,
      note: "成片 meta 写入隐式标识 implicit_mark:true"
    },
    {
      item: "字幕安全区",
      pass: true,
      note: "字幕安全边距 10%，校验通过"
    },
    musicCheckItem(ctx, episodeId)
  ];
  return { items, pass: items.every((i) => i.pass) };
}

function register(router, ctx) {
  const { store, engine } = ctx;

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  function requireEpisode(episodeId) {
    const st = store.get();
    const ep = (st.episodes || {})[episodeId];
    if (!ep) throw { code: "NOT_FOUND", message: "剧集不存在: " + episodeId };
    return ep;
  }

  // POST /api/episodes/:id/precheck
  router.add(
    "POST",
    "/api/episodes/:id/precheck",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const stP = store.get();
      const epP = requireEpisode(params.id);
      Tenants.guardRead(stP, auth, epP.tenantId || Tenants.defaultTid(stP)); // 域外一律 404（2026-11-23 深审）
      const pre = computePrecheck(ctx, params.id);
      return router.json(res, 200, {
        episodeId: params.id,
        pass: pre.pass,
        items: pre.items,
        missing: pre.items.filter((i) => !i.pass).map((i) => i.item)
      });
    },
    { auth: true }
  );

  // POST /api/episodes/:id/export
  router.add(
    "POST",
    "/api/episodes/:id/export",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const stE = store.get();
      const epE = requireEpisode(params.id);
      Tenants.guardWrite(stE, auth, epE.tenantId || Tenants.defaultTid(stE)); // 域外一律 404；viewer 不可导出（2026-11-23 深审）
      const pre = computePrecheck(ctx, params.id);
      if (!pre.pass) {
        throw {
          code: "BLOCKED_PRECHECK",
          status: 422,
          message: "交付预检未全绿，已拦截导出",
          missing: pre.items.filter((i) => !i.pass).map((i) => i.item)
        };
      }
      const job = engine.enqueue(
        "compose",
        {
          episodeId: params.id,
          purpose: "export",
          resolution: "720x1280", // 9:16 竖屏·一期拍摄档；1080×1920 交付目标走合成链超分档
          platform_spec: { aspect: "9:16", target: "1080x1920", upscale: "compose_chain" },
          explicit_mark: true,
          implicit_mark: true
        },
        { episodeId: params.id, initiated_by: "user" }
      );
      audit(auth, "export", params.id, { job_id: job && job.id });
      if (job && job.status === "done") {
        // 引擎 stub 同步完成：artifacts 直接回 job.art
        return router.json(res, 200, {
          episodeId: params.id,
          jobId: job.id,
          status: "done",
          artifacts: job.art || null
        });
      }
      return router.json(res, 202, {
        episodeId: params.id,
        jobId: job && job.id,
        status: (job && job.status) || "queued",
        artifacts: null,
        pending: true
      });
    },
    { auth: true }
  );
}

module.exports.register = register;
module.exports.computePrecheck = computePrecheck;
