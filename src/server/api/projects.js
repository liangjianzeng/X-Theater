"use strict";
/**
 * api/projects.js — 项目管理（新建/列表）
 * POST /api/projects {title, style_pkg?} → st.projects；GET /api/projects 列表。
 * 项目是集的容器：一期自部署，用户在界面直接建项目（不再依赖运营后台开通）。
 */

function register(router, ctx) {
  const { store, util, bus } = ctx;

  router.add(
    "GET",
    "/api/projects",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      return router.json(res, 200, { projects: st.projects || {} });
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
      st.projects = st.projects || {};
      const p = {
        id: util.uid("pj"),
        title: title.slice(0, 40),
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
}

module.exports.register = register;
