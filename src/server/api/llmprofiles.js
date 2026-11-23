"use strict";
/**
 * api/llmprofiles.js — Agent 助手 LLM 档案注册表（2026-11-22 大脑层解耦）
 *
 * Agent 助手（制片助手 / AI 剧本 / AI 审查 / 建议片）用哪个大模型＝一份可增删配置的档案表：
 *   state.llm_profiles[id] = { label, base(OpenAI 兼容 /v1), model, bat(重启脚本路径，仅在停服/提示里展示，不自动运行), key(云 API 密钥), node }
 *   state.llm_active = 当前启用档案 id（热切换，cfg.llm getter 动态读）
 * profile.node ＝ 这台 LLM 物理跑在哪台渲染机上：
 *   - 指向渲染机 → LLM 在线时占那台机显存（该机若开 gpu_gate，生图/拍摄被显存闸挡）；
 *   - null（云端/远程）→ 不占任何渲染机显存，互斥闸不生效。
 * 与算力节点解耦：节点只管渲染拓扑；大脑加第三套/第十套 API 都不用改代码。写操作一律 ops＋审计。
 */

const { ensureLlmProfiles, llmActiveProfile, llmHostNode } = require("../core/store");
const http = require("http");

function register(router, ctx) {
  const { store, util } = ctx;

  function requireOps(auth) {
    if (!auth) throw { code: "UNAUTHORIZED", message: "需要登录" };
    if ((auth.role || auth.role_name) !== "ops") throw { code: "FORBIDDEN", message: "需要 ops 角色" };
  }

  function audit(auth, action, target, extra) {
    const obj = { operator: (auth && (auth.uid || auth.id)) || null, action, target };
    if (extra) Object.assign(obj, extra);
    store.log("audit", obj);
  }

  function profilesOf(st) {
    ensureLlmProfiles(st);
    st.llm_profiles = st.llm_profiles || {};
    return st.llm_profiles;
  }

  /* 档案视图（D4 同类面收口 2026-11-23）：bat（服务器本机重启脚本路径）与 base（内网端点）
     只随 ops 身份下发——普通登录用户不下发（与 gpu.js restart_hint 同一纪律；唯一消费面是运维台页）。
     在线态/model 保留：客户端非 ops 面（助手横幅、GPU 徽章）需要。 */
  function profileView(st, p, isOps) {
    const nodeLabel = p.node && (st.nodes || {})[p.node] ? st.nodes[p.node].label : null;
    return {
      id: p.id,
      label: p.label,
      base: isOps ? p.base : "",
      model: p.model,
      bat: isOps ? p.bat || "" : "",
      has_key: !!p.key,
      node: p.node || null,
      node_label: nodeLabel,
      is_active: st.llm_active === p.id
    };
  }

  // 载荷清洗：base 必须 http(s)；node 必须是已登记节点或空（云端）
  function cleanPayload(st, b, partial) {
    const out = {};
    const str = (v, cap) => String(v == null ? "" : v).trim().slice(0, cap);
    if (!partial || b.label != null) {
      const label = str(b.label, 40);
      if (!label) throw { code: "BAD_REQUEST", message: "档案名称必填（如「本机 Huihui35B」「DeepSeek 云」）" };
      out.label = label;
    }
    if (!partial || b.base != null) {
      const base = str(b.base, 160).replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(base)) throw { code: "BAD_REQUEST", message: "LLM 端点需以 http(s):// 开头（OpenAI 兼容 /v1 基址）" };
      out.base = base;
    }
    if (!partial || b.model != null) out.model = str(b.model, 80);
    if (!partial || b.bat != null) out.bat = str(b.bat, 200);
    if (!partial || b.key != null) out.key = str(b.key, 200);
    if (!partial || b.node != null) {
      const node = b.node == null || b.node === "" ? null : String(b.node).trim();
      if (node && !((st.nodes || {})[node])) {
        throw { code: "BAD_REQUEST", message: "运行位置节点不存在: " + node + "——先在「算力节点」登记，或选「云端/远程」" };
      }
      out.node = node;
    }
    return out;
  }

  // 启动补迁移（nodes.js 注册在先的场景已迁；此处兜底加载顺序）＋落盘
  ensureLlmProfiles(store.get());
  store.commit();

  // GET /api/llm-profiles — 档案清单＋当前启用＋在线态（只读）
  router.add(
    "GET",
    "/api/llm-profiles",
    (req, res, body, params, auth) => {
      if (!auth) throw { code: "UNAUTHORIZED", message: "需要登录" };
      const st = store.get();
      const profiles = profilesOf(st);
      const llm = (ctx.llm && ctx.llm.enabled()) ? (ctx.llm.cached() || {}) : { configured: false, llmOnline: false };
      return router.json(res, 200, {
        active: st.llm_active || "",
        llm_host_node: llmHostNode(st),
        llm: {
          configured: !!llm.configured,
          online: !!llm.llmOnline,
          model: llm.llmModel || (llmActiveProfile(st) || {}).model || null
        },
        profiles: Object.keys(profiles).map((id) => profileView(st, profiles[id], auth.role === "ops"))
      });
    },
    { auth: true }
  );

  // POST /api/llm-profiles {label,base,model?,bat?,key?,node?} — 新增档案
  router.add(
    "POST",
    "/api/llm-profiles",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const profiles = profilesOf(st);
      const c = cleanPayload(st, body || {}, false);
      // id 唯一性用 crypto 随机（契约 §9 确定性纪律：进程内禁 Math.random；非密料但同规矩）
      const id = "lp_" + require("crypto").randomBytes(4).toString("hex");
      if (profiles[id]) throw { code: "CONFLICT", message: "档案 id 冲突，重试一次即可" };
      profiles[id] = Object.assign({ id }, c);
      if (!st.llm_active) st.llm_active = id; // 第一份档案自动启用
      store.commit();
      audit(auth, "llm_profile_add", id, { label: c.label, base: c.base, node: c.node || null });
      return router.json(res, 201, {
        profile: profileView(st, profiles[id], true),
        note: "档案「" + c.label + "」已登记" + (st.llm_active === id ? "并启用（热生效）" : "——点「启用」切换")
      });
    },
    { auth: true }
  );

  // PUT /api/llm-profiles/:id {label?,base?,model?,bat?,key?,node?} — 编辑档案（热生效）
  router.add(
    "PUT",
    "/api/llm-profiles/:id",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const profiles = profilesOf(st);
      const p = profiles[params.id];
      if (!p) throw { code: "NOT_FOUND", message: "LLM 档案不存在: " + params.id };
      const c = cleanPayload(st, body || {}, true);
      Object.assign(p, c);
      store.commit();
      audit(auth, "llm_profile_update", p.id, { label: p.label, base: p.base, node: p.node || null });
      const hosting = st.llm_active === p.id;
      return router.json(res, 200, {
        profile: profileView(st, p, true),
        note: hosting ? "已保存并热生效（llm-gw 每次调用动态读取）" : "已保存到「" + p.label + "」（当前未启用，切换后生效）"
      });
    },
    { auth: true }
  );

  // POST /api/llm-profiles/activate {id} — 切换当前大脑（热生效）
  router.add(
    "POST",
    "/api/llm-profiles/activate",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const profiles = profilesOf(st);
      const id = String((body || {}).id || "").trim();
      if (!profiles[id]) throw { code: "BAD_REQUEST", message: "未知 LLM 档案: " + id };
      const before = st.llm_active || "";
      st.llm_active = id;
      store.commit();
      audit(auth, "llm_profile_activate", id, { from: before || null, to: id });
      try { ctx.bus.publish("nodes", { event: "llm_profile_activate", profile: id }); } catch (e) { /* SSE 未就绪 */ }
      return router.json(res, 200, {
        active: id,
        profile: profileView(st, profiles[id], true),
        note: "Agent 助手大脑已切到「" + profiles[id].label + "」（热生效）"
      });
    },
    { auth: true }
  );

  // POST /api/llm-profiles/:id/remove — 删除档案（护栏：当前启用中的先切换）
  router.add(
    "POST",
    "/api/llm-profiles/:id/remove",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const profiles = profilesOf(st);
      const p = profiles[params.id];
      if (!p) throw { code: "NOT_FOUND", message: "LLM 档案不存在: " + params.id };
      if (st.llm_active === p.id) {
        throw { code: "PROFILE_ACTIVE", status: 409, message: "「" + p.label + "」正在被 Agent 助手使用——先切换到其它档案再删除" };
      }
      delete profiles[p.id];
      // 迁移源清理：该档案源自节点 llm 子对象时，同步清掉节点的迁移源——防止下次启动复活
      if (p.node && (st.nodes || {})[p.node] && st.nodes[p.node].llm && st.nodes[p.node].llm.base === p.base) {
        st.nodes[p.node].llm.base = "";
      }
      store.commit();
      audit(auth, "llm_profile_remove", p.id, { label: p.label });
      return router.json(res, 200, { removed: p.id, note: "档案「" + p.label + "」已删除" });
    },
    { auth: true }
  );

  // POST /api/llm-profiles/:id/probe — 真连通探测（GET {base}/v1/models，2.5s 超时；ops）
  router.add(
    "POST",
    "/api/llm-profiles/:id/probe",
    (req, res, body, params, auth) => {
      requireOps(auth);
      const st = store.get();
      const profiles = profilesOf(st);
      const p = profiles[params.id];
      if (!p) throw { code: "NOT_FOUND", message: "LLM 档案不存在: " + params.id };
      let u = null;
      try { u = new URL(p.base); } catch (e) { /* 下面统一报 */ }
      if (!u || !u.hostname) throw { code: "BAD_REQUEST", message: "端点未配置或非法: " + (p.base || "（空）") };
      const basePath = u.pathname.replace(/\/+$/, "");
      const pathP = /\/v1$/.test(basePath) ? basePath + "/models" : basePath + "/v1/models"; // OpenAI 兼容 /v1/models
      const headers = p.key ? { authorization: "Bearer " + p.key } : {};
      const t0 = Date.now();
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
        audit(auth, "llm_profile_probe", p.id, { ok: r.ok, ms, base: p.base });
        return router.json(res, 200, { profile: p.id, base: p.base, ok: r.ok, code: r.code, ms, detail: r.detail });
      });
    },
    { auth: true }
  );
}

module.exports.register = register;
