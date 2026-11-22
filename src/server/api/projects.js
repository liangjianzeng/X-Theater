"use strict";
/**
 * api/projects.js — 项目管理（新建/列表）
 * POST /api/projects {title, style_pkg?} → st.projects；GET /api/projects 列表。
 * 项目是集的容器：一期自部署，用户在界面直接建项目（不再依赖运营后台开通）。
 */

function register(router, ctx) {
  const { store, util, bus } = ctx;
  const Tenants = require("../core/tenants.js");

  router.add(
    "GET",
    "/api/projects",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      // 域投影（S3-5）：只出本域项目（漏 stamp 实体视为默认域，自愈）
      const dt = Tenants.defaultTid(st);
      const tid = Tenants.contextTid(st, auth);
      const projects = {};
      Object.keys(st.projects || {}).forEach((k) => {
        if (((st.projects[k] || {}).tenantId || dt) === tid) projects[k] = st.projects[k];
      });
      return router.json(res, 200, { projects });
    },
    { auth: true }
  );

  // POST /api/projects {title, style_pkg{look,palette,ratio}}
  router.add(
    "POST",
    "/api/projects",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const b = body || {};
      const title = String(b.title || "").trim();
      if (!title) throw { code: "BAD_REQUEST", message: "title 必填" };
      const sp = b.style_pkg && typeof b.style_pkg === "object" ? b.style_pkg : {};
      const st = store.get();
      const tid = Tenants.contextTid(st, auth);
      Tenants.guardWrite(st, auth, tid); // viewer 不可建
      st.projects = st.projects || {};
      const p = {
        id: util.uid("pj"),
        title: title.slice(0, 40),
        tenantId: tid,
        style_pkg: {
          look: String(sp.look || "写实电影感").slice(0, 30),
          palette: String(sp.palette || "青橙").slice(0, 20),
          ratio: String(sp.ratio || "9:16").slice(0, 10)
        },
        music_enabled: b.music_enabled === false ? false : true
      };
      st.projects[p.id] = p;
      store.commit();
      store.log("audit", {
        operator: (auth && (auth.uid || auth.id)) || null,
        action: "project_create",
        target: p.id,
        title: p.title
      });
      try { bus.publish("projects", { event: "created", project: p }); } catch (e) {}
      return router.json(res, 201, { project: p });
    },
    { auth: true }
  );

  // DELETE /api/projects/:id — 删除项目（2026-11-22）：登录即可删（授权口径与
  // DELETE /api/cards/:id 一致），前端二次确认后才发请求。仅空项目可删——项目下还有集时
  // 拒绝（HAS_EPISODES），防连带误删整链 GPU 产物；删集请走 DELETE /api/episodes/:id。
  router.add(
    "DELETE",
    "/api/projects/:id",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const p = (st.projects || {})[params.id];
      if (!p) throw { code: "NOT_FOUND", message: "项目不存在: " + params.id };
      Tenants.guardWrite(st, auth, p.tenantId || Tenants.defaultTid(st)); // 域外一律 404（不确认存在）
      const eps = Object.keys(st.episodes || {})
        .map((k) => st.episodes[k])
        .filter((e) => e && String(e.projectId) === String(p.id));
      if (eps.length) {
        throw {
          code: "HAS_EPISODES",
          message: "项目下还有 " + eps.length + " 集，先删集再删项目"
        };
      }
      delete st.projects[p.id];
      store.commit();
      store.log("audit", {
        operator: (auth && (auth.uid || auth.id)) || null,
        action: "project_delete",
        target: p.id,
        title: p.title
      });
      try { bus.publish("projects", { event: "deleted", id: p.id }); } catch (e) {}
      return router.json(res, 200, { deleted: p.id });
    },
    { auth: true }
  );
}

module.exports.register = register;
