"use strict";
/**
 * api/nodes.js — 算力节点注册表（2026-11-21 引入；2026-11-22 注册表化整改）
 *
 * 节点＝一台干活的机器（渲染 ComfyUI ＋ 可选 LLM 档案），state.nodes 是唯一拓扑事实源：
 *   - 可增删改（本模块 CRUD；不再写死 local/dgx 两台，加节点/撤节点运维台直接操作）
 *   - episode.driver＝节点 id（任意已登记节点），引擎改道由注册表 lane→node 绑定派生（dag/engine.js）
 *   - Agent 大脑＝llm_profiles[llm_active]（api/llmprofiles.js 增删切换）；llm_node 仅作存量迁移源
 *   - node.gpu_gate＝该机"LLM 与渲染互斥"（16G 单卡）；大卡节点 false 不受显存闸
 * 节点真实化：workers 经 index.js cfg.laneBase(lane)→注册表→节点档案取端点——改档案即热生效。
 * 首启种子（local/dgx）只为零配置开机，之后一切以 state 为准。写操作一律 ops 角色＋审计。
 */

const { ensureLlmProfiles, llmHostNode } = require("../core/store");
const http = require("http");

/* 首启种子（仅 state.nodes 缺失时用；用户删过就不再回种）
   kind: "comfy"＝ComfyUI 渲染机（本机/远程）；"cloud"＝付费云 API（非 ComfyUI，api.* 档案） */
const SEED_NODES = {
  local: {
    id: "local", label: "本机渲染节点", kind: "comfy", gpu_gate: true,
    comfy: { base: "http://127.0.0.1:8188" },
    llm: { base: "http://127.0.0.1:8090", model: "Huihui35B:vision", bat: "E:/MyLLM/8090_huihui35b_q4k_cpu19.bat" }
  },
  dgx: {
    id: "dgx", label: "DGX H3 全家桶", kind: "comfy", gpu_gate: false,
    comfy: { base: "http://100.81.83.59:8188" },
    llm: { base: "", model: "", bat: "" } // DGX 侧 LLM 未部署时留空（助手继续用承载节点档案）
  }
};
const SEED_LLM_BAT = { local: SEED_NODES.local.llm.bat };

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** 幂等补齐：缺失种子节点/缺失字段（不覆盖用户已改值）；llm_node 有效性自愈；
 *  kind/api 归一化（2026-11-22 云 API 目标）＋用户默认算力有效性自愈 */
function ensureNodes(st) {
  st.nodes = st.nodes || {};
  Object.keys(SEED_NODES).forEach((id) => {
    if (!st.nodes[id]) st.nodes[id] = JSON.parse(JSON.stringify(SEED_NODES[id]));
  });
  Object.keys(st.nodes).forEach((id) => {
    const n = st.nodes[id];
    if (!n || typeof n !== "object") { delete st.nodes[id]; return; }
    n.id = id;
    if (n.kind !== "cloud") n.kind = "comfy"; // 未知 kind 一律归 ComfyUI 机（存量档案默认）
    if (typeof n.label !== "string" || !n.label.trim()) n.label = id;
    if (!n.comfy || typeof n.comfy !== "object") n.comfy = { base: "" };
    if (typeof n.comfy.base !== "string") n.comfy.base = "";
    if (!n.llm || typeof n.llm !== "object") n.llm = { base: "", model: "", bat: "" };
    ["base", "model", "bat"].forEach((k) => { if (typeof n.llm[k] !== "string") n.llm[k] = ""; });
    if (typeof n.gpu_gate !== "boolean") n.gpu_gate = id === "local"; // 存量档案补默认：本机互斥
    // 云 API 档案（kind:"cloud" 时生效）：endpoint/key/model/price_cents（key 不回显）
    if (!n.api || typeof n.api !== "object") n.api = { endpoint: "", key: "", model: "", price_cents: 0 };
    ["endpoint", "key", "model"].forEach((k) => { if (typeof n.api[k] !== "string") n.api[k] = ""; });
    if (!Number.isFinite(Number(n.api.price_cents))) n.api.price_cents = 0;
    // 早期档案缺 llm.bat → 从种子补齐（不覆盖用户已改值）
    if (!n.llm.bat && SEED_LLM_BAT[id]) n.llm.bat = SEED_LLM_BAT[id];
  });
  if (!st.nodes[st.llm_node]) st.llm_node = st.nodes.local ? "local" : Object.keys(st.nodes)[0];
  // 用户默认算力自愈（2026-11-22 用户级路由）：指向的节点已删 → 清空（未指定＝建集落首个节点）
  Object.keys(st.users || {}).forEach((uid) => {
    const u = st.users[uid];
    if (u && u.driver != null && !(st.nodes || {})[u.driver]) u.driver = "";
  });
  return st.nodes;
}

function register(router, ctx) {
  const { store, util, cfg, engine } = ctx;

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

  // 引擎注册表里绑定到指定节点的引擎 id 清单（删节点护栏用）
  function enginesOn(nodeId) {
    const reg = (store.get().settings || {}).registry || {};
    return Object.keys(reg).filter((k) => reg[k] && reg[k].node === nodeId);
  }

  // 节点档案种子：启动时补齐并落盘一次（幂等）；随后把节点上的 LLM 档案迁入大脑注册表（一次性）
  ensureNodes(store.get());
  ensureLlmProfiles(store.get());
  store.commit();

  // GET /api/nodes — 算力节点注册表＋每集/每用户分派（只管渲染拓扑；LLM 大脑档案见 /api/llm-profiles）
  router.add(
    "GET",
    "/api/nodes",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "UNAUTHORIZED", message: "需要登录" };
      const st = store.get();
      const nodes = ensureNodes(st); // 内存兜底补齐（正常已在启动时落盘）
      // Agent 大脑宿主机（llm_profiles[llm_active].node）：节点卡「显存互斥」提示用
      const llm_host_node = llmHostNode(st);
      return router.json(res, 200, {
        llm_host_node,
        nodes: Object.keys(nodes).map((id) => ({
          id,
          label: nodes[id].label,
          kind: nodes[id].kind || "comfy",
          gpu_gate: !!nodes[id].gpu_gate,
          comfy: nodes[id].comfy,
          // 云 API 档案（key 只回显「已配置/未配置」，不回显明文）
          api: nodes[id].kind === "cloud"
            ? {
                endpoint: nodes[id].api.endpoint,
                has_key: !!nodes[id].api.key,
                model: nodes[id].api.model,
                price_cents: Number(nodes[id].api.price_cents) || 0
              }
            : null,
          engines: enginesOn(id),
          is_llm_host: llm_host_node === id
        })),
        // 用户默认算力（2026-11-22 用户级路由）：账户→默认节点，建集时落集
        users: Object.keys(st.users || {}).map((uid) => ({
          uid,
          name: st.users[uid].name,
          role: st.users[uid].role,
          driver: st.users[uid].driver || ""
        })),
        episodes: Object.keys(st.episodes || {}).map((k) => ({
          id: k, title: st.episodes[k].title, driver: st.episodes[k].driver || "local"
        }))
      });
    },
    { auth: true }
  );

  /* ---------- 节点 CRUD（2026-11-22 注册表化：加节点/撤节点不再改代码） ---------- */

  // POST /api/nodes {id,label,comfy_base?,gpu_gate?,llm_base?,llm_model?} — 登记新节点
  router.add(
    "POST",
    "/api/nodes",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const nodes = ensureNodes(st);
      const b = body || {};
      const id = String(b.id || "").trim();
      if (!ID_RE.test(id)) throw { code: "BAD_REQUEST", message: "节点 id 需为字母/数字开头的短标识（≤32 位，可含 - _）: " + (id || "（空）") };
      if (nodes[id]) throw { code: "CONFLICT", message: "节点 id 已存在: " + id };
      const label = String(b.label || "").trim().slice(0, 40);
      if (!label) throw { code: "BAD_REQUEST", message: "节点名称必填（如「3 号机房 A100」）" };
      const base = String(b.comfy_base || "").trim().replace(/\/+$/, "").slice(0, 120);
      if (base && !/^https?:\/\//i.test(base)) throw { code: "BAD_REQUEST", message: "渲染端点需以 http(s):// 开头" };
      const kind = b.kind === "cloud" ? "cloud" : "comfy";
      // 云 API 档案（kind:"cloud"）：OpenAI 兼容 /v1/images/generations 端点＋密钥＋单价（分/张）
      let api = { endpoint: "", key: "", model: "", price_cents: 0 };
      if (kind === "cloud") {
        const ab = b.api || {};
        const endpoint = String(ab.endpoint || "").trim().replace(/\/+$/, "").slice(0, 160);
        if (!/^https?:\/\//i.test(endpoint)) throw { code: "BAD_REQUEST", message: "云 API 端点需以 http(s):// 开头（OpenAI 兼容 /v1 基址）" };
        if (!String(ab.key || "").trim()) throw { code: "BAD_REQUEST", message: "云 API 密钥必填（api.key）" };
        api = {
          endpoint,
          key: String(ab.key).trim().slice(0, 200),
          model: String(ab.model || "").trim().slice(0, 80),
          price_cents: Math.max(0, Math.round(Number(ab.price_cents) || 0))
        };
      }
      nodes[id] = {
        id,
        label,
        kind,
        gpu_gate: b.gpu_gate === true,
        comfy: { base },
        api,
        llm: {
          base: String(b.llm_base || "").trim().slice(0, 120),
          model: String(b.llm_model || "").trim().slice(0, 60),
          bat: ""
        }
      };
      store.commit();
      audit(auth, "node_add", id, { label, kind, comfy_base: base || null, gpu_gate: !!b.gpu_gate, cloud_endpoint: kind === "cloud" ? api.endpoint : null });
      try { ctx.bus.publish("nodes", { event: "node_add", node: id }); } catch (e) { /* SSE 未就绪 */ }
      const note = kind === "cloud"
        ? "云 API 目标「" + label + "」已登记——下一步去「引擎段位」登记一个 t2i.cloud 引擎并改绑到本节点，再把剧集驱动/用户默认算力指过来"
        : "节点「" + label + "」已登记——渲染端点留空时先探测再补；引擎绑定去「引擎段位」改";
      return router.json(res, 201, { node: Object.assign({}, nodes[id], { api: Object.assign({}, api, { key: undefined, has_key: !!api.key }) }), note });
    },
    { auth: true }
  );

  // PUT /api/nodes/:id 节点信息编辑已移至静态 PUT（llm/llm-node）之后注册——见 llm-node 路由后。

  // POST /api/nodes/:id/remove — 撤节点（护栏：LLM 承载中／有引擎绑定／有剧集指向／有用户默认算力 / 最后一个节点）
  router.add(
    "POST",
    "/api/nodes/:id/remove",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const nodes = ensureNodes(st);
      const node = nodes[params.id];
      if (!node) throw { code: "NOT_FOUND", message: "节点不存在: " + params.id };
      if (Object.keys(nodes).length <= 1) throw { code: "LAST_NODE", status: 409, message: "至少保留一个节点" };
      if (llmHostNode(st) === node.id) throw { code: "NODE_IS_LLM_HOST", status: 409, message: "Agent 大脑正落在这台机器上（LLM 档案运行位置指向它）——先去「Agent 助手 LLM」把档案运行位置改到别处或云端" };
      const engines = enginesOn(node.id);
      if (engines.length) throw { code: "NODE_HAS_ENGINES", status: 409, message: "该节点仍绑定引擎（" + engines.join("、") + "）——先在「引擎段位」改绑/删除", engines };
      const eps = Object.keys(st.episodes || {}).filter((k) => st.episodes[k].driver === node.id);
      if (eps.length) throw { code: "NODE_HAS_EPISODES", status: 409, message: "还有 " + eps.length + " 部剧的渲染分配指向该节点——先在剧集行改派其它节点", episodes: eps };
      const usersOn = Object.keys(st.users || {}).filter((uid) => (st.users[uid] || {}).driver === node.id);
      if (usersOn.length) throw { code: "NODE_HAS_USERS", status: 409, message: "还有 " + usersOn.length + " 个用户的默认算力指向该节点——先在「用户默认算力」里改派", users: usersOn };
      delete nodes[node.id];
      store.commit();
      audit(auth, "node_remove", node.id, { label: node.label });
      try { ctx.bus.publish("nodes", { event: "node_remove", node: node.id }); } catch (e) { /* SSE 未就绪 */ }
      return router.json(res, 200, { removed: node.id, note: "节点「" + node.label + "」已撤" });
    },
    { auth: true }
  );

  // PUT /api/nodes/episodes/:id/driver {driver} — 切换剧集渲染节点（审计留痕，ops）
  router.add(
    "PUT",
    "/api/nodes/episodes/:id/driver",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const nodes = ensureNodes(st);
      const ep = st.episodes[params.id];
      if (!ep) throw { code: "NOT_FOUND", message: "剧集不存在: " + params.id };
      const driver = String((body || {}).driver || "local").trim();
      if (!nodes[driver]) throw { code: "BAD_REQUEST", message: "未知节点: " + driver };
      const before = nodes[ep.driver] ? ep.driver : "local";
      ep.driver = driver;
      store.commit();
      audit(auth, "episode_driver_switch", ep.id, { from: before, to: driver });
      try { ctx.bus.publish("episodes", { event: "driver_switch", episodeId: ep.id, driver }); } catch (e) {}
      // 提示按节点实况拼：该节点是否有同族引擎绑定（没有→任务会显式报 NODE_NO_LANE，提前告知）
      const reg = st.settings && st.settings.registry ? st.settings.registry : {};
      const famHas = (prefix) => Object.keys(reg).some((k) => reg[k] && reg[k].node === driver && String(reg[k].lane || "").indexOf(prefix) === 0);
      const missing = [];
      if (!famHas("img")) missing.push("生图");
      if (!famHas("vid")) missing.push("视频");
      const note = driver === before
        ? "本集渲染节点未变"
        : "本集生图/视频将由「" + nodes[driver].label + "」承担" + (missing.length ? "（注意：该节点未绑定" + missing.join("/") + "引擎，相关任务会明确报错，先去「引擎段位」绑定）" : "，原节点显存随之释放");
      return router.json(res, 200, { episodeId: ep.id, driver, warning: missing.length ? missing : null, note });
    },
    { auth: true }
  );

  // LLM 档案路由已迁出（2026-11-22 大脑层解耦）：/api/llm-profiles 增删改/切换/探测（api/llmprofiles.js）。
  // 通用 PUT /api/nodes/:id 放在静态路由之后注册即可，无单段静态 PUT 竞争。

  // PUT /api/nodes/:id {label?,gpu_gate?,api?} — 节点信息编辑（端点走 :id/comfy）。
  router.add(
    "PUT",
    "/api/nodes/:id",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const node = ensureNodes(st)[params.id];
      if (!node) throw { code: "NOT_FOUND", message: "节点不存在: " + params.id };
      const b = body || {};
      if (b.label != null) {
        const label = String(b.label).trim().slice(0, 40);
        if (!label) throw { code: "BAD_REQUEST", message: "节点名称不能为空" };
        node.label = label;
      }
      if (b.gpu_gate != null) {
        node.gpu_gate = b.gpu_gate === true;
      }
      // 云 API 档案编辑（kind:"cloud"；key 传空串＝不改，显式 null＝清除）
      if (b.api && typeof b.api === "object") {
        node.api = node.api || { endpoint: "", key: "", model: "", price_cents: 0 };
        if (b.api.endpoint != null) {
          const ep = String(b.api.endpoint).trim().replace(/\/+$/, "").slice(0, 160);
          if (ep && !/^https?:\/\//i.test(ep)) throw { code: "BAD_REQUEST", message: "云 API 端点需以 http(s):// 开头" };
          node.api.endpoint = ep;
        }
        if (b.api.key != null) node.api.key = String(b.api.key).trim().slice(0, 200);
        if (b.api.model != null) node.api.model = String(b.api.model).trim().slice(0, 80);
        if (b.api.price_cents != null) node.api.price_cents = Math.max(0, Math.round(Number(b.api.price_cents) || 0));
      }
      store.commit();
      audit(auth, "node_update", node.id, { label: node.label, gpu_gate: node.gpu_gate });
      return router.json(res, 200, { node: Object.assign({}, node, { api: node.api ? Object.assign({}, node.api, { key: undefined, has_key: !!node.api.key }) : null }) });
    },
    { auth: true }
  );

  // PUT /api/nodes/:id/comfy {base} — 改节点渲染端点（节点真实化：workers 经 cfg.laneBase 即时读取，ops）
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
      return router.json(res, 200, { node: params.id, comfy: node.comfy, note: "渲染端点已更新（绑定该节点的引擎下一次任务即读取）" });
    },
    { auth: true }
  );

  // POST /api/nodes/:id/probe — 真连通探测（comfy：GET /system_stats；cloud：GET {endpoint}/models 带 Bearer，2.5s 超时；ops）
  router.add(
    "POST",
    "/api/nodes/:id/probe",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const nodes = ensureNodes(st);
      const node = nodes[params.id];
      if (!node) throw { code: "NOT_FOUND", message: "节点不存在: " + params.id };
      const isCloud = node.kind === "cloud";
      const base = String((isCloud ? node.api && node.api.endpoint : node.comfy && node.comfy.base) || "");
      let u = null;
      try { u = new URL(base); } catch (e) { /* 下面统一报 BAD_REQUEST */ }
      if (!u || !u.hostname) throw { code: "BAD_REQUEST", message: (isCloud ? "云 API 端点" : "渲染端点") + "未配置或非法: " + (base || "（空）") };
      const t0 = Date.now();
      const pathP = isCloud ? (u.pathname.replace(/\/+$/, "") + "/models") : "/system_stats";
      const headers = isCloud && node.api.key ? { authorization: "Bearer " + node.api.key } : {};
      const out = new Promise((resolve) => {
        const rq = http.request(
          { host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), path: pathP, method: "GET", timeout: 2500, headers },
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
        audit(auth, "node_probe", params.id, { ok: r.ok, ms, endpoint: base, kind: node.kind });
        return router.json(res, 200, { node: params.id, endpoint: base, kind: node.kind || "comfy", ok: r.ok, code: r.code, ms, detail: r.detail });
      });
    },
    { auth: true }
  );

  // PUT /api/nodes/users/:uid/driver {driver} — 用户默认算力（2026-11-22 用户级路由）：
  // 账户→默认节点；建集/快开时自动落集（集级仍可改派覆盖）。driver 传 ""＝清除（跟随全局）。
  router.add(
    "PUT",
    "/api/nodes/users/:uid/driver",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const nodes = ensureNodes(st);
      const user = (st.users || {})[params.uid];
      if (!user) throw { code: "NOT_FOUND", message: "用户不存在: " + params.uid };
      const driver = String((body || {}).driver || "").trim();
      if (driver && !nodes[driver]) throw { code: "BAD_REQUEST", message: "未知节点: " + driver };
      const before = user.driver || "";
      user.driver = driver;
      store.commit();
      audit(auth, "user_driver_switch", params.uid, { from: before || null, to: driver || null });
      return router.json(res, 200, {
        uid: params.uid,
        driver,
        note: driver
          ? "用户「" + user.name + "」新建剧集将默认落在「" + nodes[driver].label + "」"
          : "用户「" + user.name + "」默认算力已清除（新剧集跟随首个登记节点）"
      });
    },
    { auth: true }
  );

  void cfg; void engine;
}

module.exports.register = register;
module.exports.ensureNodes = ensureNodes;
