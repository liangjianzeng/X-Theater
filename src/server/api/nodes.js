"use strict";
/**
 * api/nodes.js — 节点驱动配置（2026-11-21，运维设置；同日重构）
 *
 * 用户方案落地：节点档案（state.nodes）＝渲染车道＋LLM 模型档案两件套：
 *   local = 本机 5060 Ti（本机 ComfyUI :8188 ＋ 本机 llama-server :8090 Huihui35B）
 *   dgx   = DGX H3 全家桶（远程 Spark ComfyUI ＋ LLM 档案预留）
 * episode.driver 选节点：dgx 驱动的剧 → 生图/视频走远程，本机显存让给 LLM 常驻（互斥消失）。
 * state.llm_node = 当前 LLM 承载节点（index.js 的 cfg.llm getter 动态解析，热切换不重启）。
 * 节点真实化：workers 的 Comfy 地址经 index.js cfg getter 读节点档案——本模块改档案即热生效，
 *   不再有「档案只是展示」的双源问题。写操作（驱动/档案/承载切换/端点）一律 ops 角色。
 */

const http = require("http");

const NODE_LABELS = { local: "本机 5060 Ti", dgx: "DGX H3 全家桶" };

function ensureNodes(st) {
  st.nodes = st.nodes || {
    local: {
      id: "local", label: NODE_LABELS.local,
      comfy: { base: "http://127.0.0.1:8188" },
      llm: { base: "http://127.0.0.1:8090", model: "Huihui35B:vision", bat: "E:/MyLLM/8090_huihui35b_q4k_cpu19.bat" }
    },
    dgx: {
      id: "dgx", label: NODE_LABELS.dgx,
      comfy: { base: "http://100.81.83.59:8188" },
      llm: { base: "", model: "" } // DGX 侧 LLM 未部署时留空（助手继续用本机节点档案）
    }
  };
  st.llm_node = st.llm_node === "dgx" ? "dgx" : "local";
  // 早期档案缺字段（如 llm.bat）→ 从默认种子补齐（不覆盖用户已改值）
  const SEED = {
    local: { llm: { bat: "E:/MyLLM/8090_huihui35b_q4k_cpu19.bat" } },
    dgx: { llm: { bat: "" } }
  };
  Object.keys(SEED).forEach(function (id) {
    if (st.nodes[id] && st.nodes[id].llm && st.nodes[id].llm.bat == null && SEED[id].llm.bat) {
      st.nodes[id].llm.bat = SEED[id].llm.bat;
    }
  });
  return st.nodes;
}

function register(router, ctx) {
  const { store, util, cfg } = ctx;

  // 运维写操作的角色闸（对齐 api/admin.js；未登录 401，非 ops 403）
  function requireOps(auth) {
    if (!auth) throw { code: "UNAUTHORIZED", message: "需要登录" };
    if ((auth.role || auth.role_name) !== "ops") throw { code: "FORBIDDEN", message: "需要 ops 角色" };
  }

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  // 节点档案种子：启动时补齐并落盘一次（幂等）；GET 之后保持只读
  ensureNodes(store.get());
  store.commit();

  // GET /api/nodes — 节点档案＋在线态＋每集驱动（运维设置数据源，只读）
  router.add(
    "GET",
    "/api/nodes",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "UNAUTHORIZED", message: "需要登录" };
      const st = store.get();
      const nodes = ensureNodes(st); // 内存兜底补齐（正常已在启动时落盘）
      const llm = (ctx.llm && ctx.llm.enabled()) ? (ctx.llm.cached() || {}) : { configured: false, llmOnline: false };
      // 在线探测：llm-gw 监视缓存（LLM）＋nodes 各 comfy 缓存（此处给 base，前端可按需调 POST /api/nodes/:id/probe）
      return router.json(res, 200, {
        llm_node: st.llm_node,
        nodes: Object.keys(nodes).map((id) => ({
          id,
          label: nodes[id].label,
          comfy: nodes[id].comfy,
          llm: nodes[id].llm,
          comfy_online: id === "local" ? !!(llm.comfy && llm.comfy.online) : null,
          is_llm_host: st.llm_node === id
        })),
        llm: {
          online: !!llm.llmOnline,
          model: llm.llmModel || (nodes[st.llm_node] && nodes[st.llm_node].llm.model) || null,
          base: nodes[st.llm_node] && nodes[st.llm_node].llm.base
        },
        episodes: Object.keys(st.episodes || {}).map((k) => ({
          id: k, title: st.episodes[k].title, driver: st.episodes[k].driver === "dgx" ? "dgx" : "local"
        }))
      });
    },
    { auth: true }
  );

  // PUT /api/nodes/episodes/:id/driver {driver} — 切换剧集驱动（审计留痕，ops）
  router.add(
    "PUT",
    "/api/nodes/episodes/:id/driver",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const ep = st.episodes[params.id];
      if (!ep) throw { code: "NOT_FOUND", message: "剧集不存在: " + params.id };
      const driver = (body || {}).driver === "dgx" ? "dgx" : "local";
      const before = ep.driver === "dgx" ? "dgx" : "local";
      ep.driver = driver;
      store.commit();
      audit(auth, "episode_driver_switch", ep.id, { from: before, to: driver });
      try { ctx.bus.publish("episodes", { event: "driver_switch", episodeId: ep.id, driver }); } catch (e) {}
      return router.json(res, 200, { episodeId: ep.id, driver, note: driver === "dgx" ? "本集生图/视频将走 DGX 节点，本机显存留给 LLM" : "本集生图/视频走本机 5060 Ti（LLM 在线时生图会被显存闸挡）" });
    },
    { auth: true }
  );

  // PUT /api/nodes/llm {node?, base, model, bat?} — 改指定节点的 LLM 档案（node 缺省＝当前承载节点，向后兼容；
  //   热生效：cfg.llm getter 每次调用动态读 nodes[llm_node]，非承载节点的档案在切换承载后生效）
  router.add(
    "PUT",
    "/api/nodes/llm",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const nodes = ensureNodes(st);
      const b = body || {};
      const nodeId = b.node != null && nodes[b.node] ? b.node : st.llm_node;
      const node = nodes[nodeId];
      if (!node) throw { code: "NOT_FOUND", message: "节点未配置: " + nodeId };
      if (b.base != null) node.llm.base = String(b.base).trim().slice(0, 120);
      if (b.model != null) node.llm.model = String(b.model).trim().slice(0, 60);
      if (b.bat != null) node.llm.bat = String(b.bat).trim().slice(0, 160);
      store.commit();
      audit(auth, "llm_config_update", node.id, { base: node.llm.base, model: node.llm.model });
      const hosting = st.llm_node === node.id;
      return router.json(res, 200, {
        node: node.id, llm: node.llm,
        note: hosting
          ? "热生效（llm-gw 每次调用动态读取）"
          : "已保存到「" + node.label + "」档案（该机当前不承载 LLM，切换承载后生效）"
      });
    },
    { auth: true }
  );

  // PUT /api/nodes/llm-node {node} — 切换 LLM 承载节点（本地↔DGX 侧档案，ops）
  router.add(
    "PUT",
    "/api/nodes/llm-node",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const nodes = ensureNodes(st);
      const node = (body || {}).node;
      if (!nodes[node]) throw { code: "BAD_REQUEST", message: "未知节点: " + node };
      st.llm_node = node;
      store.commit();
      audit(auth, "llm_node_switch", node);
      return router.json(res, 200, { llm_node: node, llm: nodes[node].llm, note: "LLM 将按该节点档案调用（热生效）" });
    },
    { auth: true }
  );

  // PUT /api/nodes/:id/comfy {base} — 改节点渲染端点（节点真实化：workers 经 cfg getter 即时读取，ops）
  router.add(
    "PUT",
    "/api/nodes/:id/comfy",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const nodes = ensureNodes(st);
      const node = nodes[params.id];
      if (!node) throw { code: "NOT_FOUND", message: "节点不存在: " + params.id };
      const base = String((body || {}).base || "").trim().replace(/\/+$/, "").slice(0, 120);
      if (!/^https?:\/\//i.test(base)) throw { code: "BAD_REQUEST", message: "渲染端点需以 http(s):// 开头" };
      const before = node.comfy && node.comfy.base;
      node.comfy = node.comfy || {};
      node.comfy.base = base;
      store.commit();
      audit(auth, "node_comfy_update", params.id, { from: before || null, to: base });
      try { ctx.bus.publish("nodes", { event: "comfy_update", node: params.id, base }); } catch (e) { /* SSE 未就绪 */ }
      return router.json(res, 200, { node: params.id, comfy: node.comfy, note: "渲染端点已更新（workers 下一次任务即读取）" });
    },
    { auth: true }
  );

  // POST /api/nodes/:id/probe — 对节点渲染端点做真连通探测（GET /system_stats，2.5s 超时；ops）
  router.add(
    "POST",
    "/api/nodes/:id/probe",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const nodes = ensureNodes(st);
      const node = nodes[params.id];
      if (!node) throw { code: "NOT_FOUND", message: "节点不存在: " + params.id };
      const base = String((node.comfy && node.comfy.base) || "");
      let u = null;
      try { u = new URL(base); } catch (e) { /* 下面统一报 BAD_REQUEST */ }
      if (!u || !u.hostname) throw { code: "BAD_REQUEST", message: "渲染端点未配置或非法: " + (base || "（空）") };
      const t0 = Date.now();
      const out = new Promise((resolve) => {
        const rq = http.request(
          { host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), path: "/system_stats", method: "GET", timeout: 2500 },
          (rs) => {
            let buf = "";
            rs.on("data", (c) => { if (buf.length < 400) buf += c; });
            rs.on("end", () => resolve({ ok: rs.statusCode >= 200 && rs.statusCode < 500, code: rs.statusCode, detail: buf.slice(0, 200) }));
          }
        );
        rq.on("timeout", () => { rq.destroy(); resolve({ ok: false, code: 0, detail: "超时（2.5s）" }); });
        rq.on("error", (e) => resolve({ ok: false, code: 0, detail: String(e.message || e).slice(0, 160) }));
        rq.end();
      });
      return out.then((r) => {
        const ms = Date.now() - t0;
        audit(auth, "node_probe", params.id, { ok: r.ok, ms, endpoint: base });
        return router.json(res, 200, { node: params.id, endpoint: base, ok: r.ok, code: r.code, ms, detail: r.detail });
      });
    },
    { auth: true }
  );

  void cfg;
}

module.exports.register = register;
module.exports.ensureNodes = ensureNodes;
