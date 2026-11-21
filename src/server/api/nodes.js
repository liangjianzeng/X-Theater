"use strict";
/**
 * api/nodes.js — 节点驱动配置（2026-11-21，运维设置）
 *
 * 用户方案落地：节点档案（state.nodes）＝渲染车道＋LLM 模型档案两件套：
 *   local = 本机 5060 Ti（本机 ComfyUI :8188 ＋ 本机 llama-server :8090 Huihui35B）
 *   dgx   = DGX H3 全家桶（远程 Spark ComfyUI ＋ LLM 档案预留）
 * episode.driver 选节点：dgx 驱动的剧 → 生图/视频走远程，本机显存让给 LLM 常驻（互斥消失）。
 * state.llm_node = 当前 LLM 承载节点（index.js 的 cfg.llm getter 动态解析，热切换不重启）。
 */

const NODE_LABELS = { local: "本机 5060 Ti", dgx: "DGX H3 全家桶" };

function ensureNodes(st) {
  st.nodes = st.nodes || {
    local: {
      id: "local", label: NODE_LABELS.local,
      comfy: { base: "http://127.0.0.1:8188" },
      llm: { base: "http://127.0.0.1:8090", model: "Huihui35B:vision" }
    },
    dgx: {
      id: "dgx", label: NODE_LABELS.dgx,
      comfy: { base: "http://100.81.83.59:8188" },
      llm: { base: "", model: "" } // DGX 侧 LLM 未部署时留空（助手继续用本机节点档案）
    }
  };
  st.llm_node = st.llm_node === "dgx" ? "dgx" : "local";
  return st.nodes;
}

function register(router, ctx) {
  const { store, util, cfg } = ctx;

  // GET /api/nodes — 节点档案＋在线态＋每集驱动（运维设置数据源）
  router.add(
    "GET",
    "/api/nodes",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const nodes = ensureNodes(st);
      store.commit(); // 节点档案种子落盘（幂等）
      const llm = (ctx.llm && ctx.llm.enabled()) ? (ctx.llm.cached() || {}) : { configured: false, llmOnline: false };
      // 在线探测：llm-gw 监视缓存（LLM）＋nodes 各 comfy 缓存（此处给 base，前端/引擎可自测；不现场串网探测远程）
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

  // PUT /api/nodes/episodes/:id/driver {driver} — 切换剧集驱动（审计留痕）
  router.add(
    "PUT",
    "/api/nodes/episodes/:id/driver",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const ep = st.episodes[params.id];
      if (!ep) throw { code: "NOT_FOUND", message: "剧集不存在: " + params.id };
      const driver = (body || {}).driver === "dgx" ? "dgx" : "local";
      const before = ep.driver === "dgx" ? "dgx" : "local";
      ep.driver = driver;
      store.commit();
      store.log("audit", {
        operator: (auth && (auth.uid || auth.id)) || null,
        action: "episode_driver_switch",
        target: ep.id,
        from: before, to: driver
      });
      try { ctx.bus.publish("episodes", { event: "driver_switch", episodeId: ep.id, driver }); } catch (e) {}
      return router.json(res, 200, { episodeId: ep.id, driver, note: driver === "dgx" ? "本集生图/视频将走 DGX 节点，本机显存留给 LLM" : "本集生图/视频走本机 5060 Ti（LLM 在线时生图会被显存闸挡）" });
    },
    { auth: true }
  );

  // PUT /api/nodes/llm {base, model} — 改当前 LLM 承载节点上的模型档案（热生效：cfg.llm getter 动态读）
  router.add(
    "PUT",
    "/api/nodes/llm",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const nodes = ensureNodes(st);
      const node = nodes[st.llm_node];
      if (!node) throw { code: "NOT_FOUND", message: "LLM 承载节点未配置" };
      const b = body || {};
      if (b.base != null) node.llm.base = String(b.base).trim().slice(0, 120);
      if (b.model != null) node.llm.model = String(b.model).trim().slice(0, 60);
      store.commit();
      store.log("audit", {
        operator: (auth && (auth.uid || auth.id)) || null,
        action: "llm_config_update",
        target: node.id,
        base: node.llm.base, model: node.llm.model
      });
      return router.json(res, 200, { node: node.id, llm: node.llm, note: "热生效（llm-gw 每次调用动态读取）" });
    },
    { auth: true }
  );

  // PUT /api/nodes/llm-node {node} — 切换 LLM 承载节点（本地↔DGX 侧档案）
  router.add(
    "PUT",
    "/api/nodes/llm-node",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "FORBIDDEN", message: "需要登录" };
      const st = store.get();
      const nodes = ensureNodes(st);
      const node = (body || {}).node;
      if (!nodes[node]) throw { code: "BAD_REQUEST", message: "未知节点: " + node };
      st.llm_node = node;
      store.commit();
      store.log("audit", { operator: (auth && (auth.uid || auth.id)) || null, action: "llm_node_switch", target: node });
      return router.json(res, 200, { llm_node: node, llm: nodes[node].llm, note: "LLM 将按该节点档案调用（热生效）" });
    },
    { auth: true }
  );

  void cfg;
}

module.exports.register = register;
