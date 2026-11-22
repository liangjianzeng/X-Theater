"use strict";
/**
 * core/tenants.js — 域（主账户/租户）核心（2026-11-22 S3）
 * 方案：docs/permission-domain-plan.md —— pool 模式的应用层等价物：
 * 全域实体带 tenantId ＋ 唯一读取入口投影（scopedView）＋ 归属校验（guard*）。
 *
 * 两层角色：
 *   平台层 users.role："ops"＝平台运营（全域通行）；"creator"＝普通用户
 *   域层   tenants[tid].members[uid]：owner | admin | member | viewer
 *     owner/admin  管理域（成员/域邀请码）
 *     member       域内读写（建项目/建集/拍板/删除）
 *     viewer       域内只读（审片/看进度）
 */

const DEFAULT_TID = "tid_default";

function defaultTid(st) {
  const t = (st && st.tenants) || {};
  if (t[DEFAULT_TID]) return DEFAULT_TID;
  return Object.keys(t)[0] || DEFAULT_TID;
}

/** auth 的域上下文：token.tid 优先；老 token 无 tid → 默认域 */
function contextTid(st, auth) {
  const tid = auth && auth.tid;
  if (tid && (st.tenants || {})[tid]) return tid;
  return defaultTid(st);
}

/** 用户在某域的角色：platform | owner | admin | member | viewer | null（无权） */
function accessOf(st, auth, tid) {
  if (!auth) return null;
  if (auth.role === "ops") return "platform";
  const t = (st.tenants || {})[tid];
  if (!t) return null;
  return (t.members || {})[String((auth && (auth.id || auth.uid)) || "")] || null;
}

function canRead(st, auth, tid) {
  return !!accessOf(st, auth, tid);
}

function canWrite(st, auth, tid) {
  const a = accessOf(st, auth, tid);
  return a === "platform" || a === "owner" || a === "admin" || a === "member";
}

function canManage(st, auth, tid) {
  const a = accessOf(st, auth, tid);
  return a === "platform" || a === "owner" || a === "admin";
}

/** 归属守卫：无读权 → 404（不向域外用户确认资源存在） */
function guardRead(st, auth, tid) {
  if (!canRead(st, auth, tid)) {
    throw { code: "NOT_FOUND", status: 404, message: "资源不存在或无权访问" };
  }
}

function guardWrite(st, auth, tid) {
  guardRead(st, auth, tid);
  if (!canWrite(st, auth, tid)) {
    throw { code: "FORBIDDEN", message: "本域身份只读（viewer），不能执行该操作" };
  }
}

function guardManage(st, auth, tid) {
  guardRead(st, auth, tid);
  if (!canManage(st, auth, tid)) {
    throw { code: "FORBIDDEN", message: "需要域 owner/admin 权限" };
  }
}

/** 用户的域成员列表（切域下拉/登录定域）；平台 ops 附带全部域（role:"platform"） */
function membershipsOf(st, auth) {
  if (!auth) return [];
  const uid = String((auth && (auth.id || auth.uid)) || "");
  const out = [];
  Object.keys(st.tenants || {}).forEach((tid) => {
    const t = st.tenants[tid];
    const role = (t.members || {})[uid];
    if (role) out.push({ id: tid, name: t.name, role });
  });
  if (auth.role === "ops") {
    Object.keys(st.tenants || {}).forEach((tid) => {
      if (!out.some((x) => x.id === tid)) {
        out.push({ id: tid, name: st.tenants[tid].name, role: "platform" });
      }
    });
  }
  return out;
}

/**
 * GET /api/state 投影（心脏）：唯一读取入口，等价 RLS 的会话上下文。
 * 浅拷贝＋按域过滤，不触碰原 state（写侧仍直接 store.get() 改真身）。
 * 返回 {tid, view}；view 与原 state 同形，替换了域敏感集合。
 */
function scopedView(st, auth) {
  const dt = defaultTid(st);
  const tid = contextTid(st, auth);
  // 自愈语义（2026-11-22 真机）：漏 stamp 的实体视为默认域——默认域内可见，域外不隐形
  const eps = {};
  Object.keys(st.episodes || {}).forEach((k) => {
    const e = st.episodes[k];
    if ((e.tenantId || dt) === tid) eps[k] = e;
  });
  const epIds = new Set(Object.keys(eps));
  const pick = (obj, pred) => {
    const out = {};
    Object.keys(obj || {}).forEach((k) => {
      if (pred(obj[k], k)) out[k] = obj[k];
    });
    return out;
  };
  const scenes = pick(st.scenes, (s) => s && epIds.has(s.episodeId));
  const sceneIds = new Set(Object.keys(scenes));
  const view = Object.assign({}, st, {
    projects: pick(st.projects, (p) => ((p || {}).tenantId || dt) === tid),
    episodes: eps,
    cards: pick(st.cards, (c) => c && epIds.has(c.episodeId)),
    shots: pick(st.shots, (s) => s && epIds.has(s.episodeId)),
    scenes,
    review_q: (st.review_q || []).filter((r) => {
      if (!r || !r.shotId) return true; // 无镜头引用的系统条目照旧透出
      const sh = (st.shots || {})[r.shotId];
      return sh && epIds.has(sh.episodeId);
    }),
    // 音乐库：无场景归属的全局条目共享；挂到本域场景的按域隔离
    music_lib: (st.music_lib || []).filter(
      (m) => !m || !m.sceneId || sceneIds.has(m.sceneId)
    ),
    viewRefs: pick(st.viewRefs, (v, k) => epIds.has(k)),
    voice_lines: pick(st.voice_lines, (v, k) => epIds.has(k)),
    music_pending: pick(st.music_pending, (v, k) => epIds.has(k))
  });
  return { tid, view };
}

/**
 * /var/* 资产归属反查（S3-7）：path→tid 索引，按 store.rev() 缓存失效。
 * 返回 null＝索引里查不到（历史遗留/系统文件）→ 退化为登录墙语义放行。
 */
function makeAssetIndex(store) {
  let cache = null;
  let cacheRev = -1;
  return function assetTid(st, relPath) {
    const rel = String(relPath || "");
    if (!rel) return null;
    const rev = typeof store.rev === "function" ? store.rev() : 0;
    if (!cache || rev !== cacheRev) {
      cache = {};
      cacheRev = rev;
      const eps = st.episodes || {};
      const tidOf = (epId) => (eps[epId] || {}).tenantId || defaultTid(st);
      const add = (p, tid) => {
        if (p && tid) cache[String(p)] = tid;
      };
      Object.keys(st.shots || {}).forEach((k) => {
        const s = st.shots[k];
        (s.takes || []).forEach((t) => add(t && t.art, tidOf(s.episodeId)));
      });
      Object.keys(st.cards || {}).forEach((k) => {
        const c = st.cards[k];
        const tid = tidOf(c.episodeId);
        add(c.art, tid);
        const p = c.payload || {};
        add(p.grid, tid);
        (p.views || []).forEach((v) => add(v && v.art, tid));
        (p.images || []).forEach((v) => add(v && v.art, tid));
      });
      Object.keys(st.viewRefs || {}).forEach((eid) => {
        const tid = tidOf(eid);
        Object.keys(st.viewRefs[eid] || {}).forEach((role) => {
          (st.viewRefs[eid][role] || []).forEach((r) => add(r && r.art, tid));
        });
      });
      Object.keys(st.voice_lines || {}).forEach((eid) => {
        const tid = tidOf(eid);
        (st.voice_lines[eid] || []).forEach((l) => add(l && l.art, tid));
      });
      Object.keys(eps).forEach((eid) => {
        const cast = ((eps[eid].script || {}).cast || []);
        cast.forEach((c) => {
          if (c && c.refImage) add("var/assets/cast/" + c.refImage, tidOf(eid));
        });
      });
    }
    return cache[rel] || null;
  };
}

module.exports = {
  DEFAULT_TID,
  defaultTid,
  contextTid,
  accessOf,
  canRead,
  canWrite,
  canManage,
  guardRead,
  guardWrite,
  guardManage,
  membershipsOf,
  scopedView,
  makeAssetIndex
};
