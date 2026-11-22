/* 剧场 Studio · 全局 store（骨架文件，agent 勿改）
   唯一 REST/SSE 出口；无演示数据回退；SSE 断线自动重连（退避封顶 15s）。 */
(function (global) {
  "use strict";
  const T = global.__T;
  const Vue = global.Vue;
  const reactive = Vue.reactive;

  const LS_TOKEN = "studio_token";
  const LS_USER = "studio_user";

  const store = reactive({
    auth: { ready: false, token: null, user: null },
    conn: { sse: "off", lastAt: 0, err: null, retries: 0 },
    state: null,
    loading: { state: false },
    err: { state: null },
    cards: { list: null, loading: false, error: null, epId: null },
    jobs: { list: null, loading: false, error: null, epId: null },
    review: { queue: null, pending: 0, loading: false, error: null },
    music: { library: null, loading: false, error: null },
    templates: { list: null, loading: false, error: null },
    costs: { data: null, loading: false, error: null, epId: null },
    gpu: { data: null, loading: false, error: null },
    billing: { rows: null, total: 0, cents: 0, loading: false, error: null },
    registry: { data: null, probes: null, alerts: null, audit: null, loading: false, error: null },
    l2: {
      sid: null, mode: "A", status: "idle",
      msgs: [], tasks: [], approvals: [],
      used_cents: 0, budget_line: 8000,
      loading: false, error: null, sending: false
    },
    toasts: [],
    sheet: null,
    tenant: { list: [], current: null, currentName: null, loading: false } // 域（S3-8）
  });
  T.store = store;

  /* ---------------- token ---------------- */
  try {
    store.auth.token = localStorage.getItem(LS_TOKEN) || null;
    const u = localStorage.getItem(LS_USER);
    store.auth.user = u ? JSON.parse(u) : null;
  } catch (e) { /* 隐私模式 */ }
  T.setTokenGetter(() => store.auth.token);

  /* cookie 引导（2026-11-22）：/var/* 资产墙凭据走同源 cookie——img/video 标签带不上
     Authorization 头，登录后/已有会话启动时把 token 同步进 cookie，登出即清 */
  function syncAuthCookie() {
    try {
      if (store.auth.token) {
        document.cookie = "theater_tok=" + encodeURIComponent(store.auth.token) + "; Path=/; Max-Age=604800; SameSite=Lax";
      } else {
        document.cookie = "theater_tok=; Path=/; Max-Age=0";
      }
    } catch (e) { /* 隐私模式 */ }
  }
  syncAuthCookie();
  /* 守卫（2026-11-22 跨线补丁）：loadTenants 以属性赋值挂载在本文件后段，IIFE 此处直接调用
     会在挂载前抛 TypeError → 整个 store.js 中断，toast/l2Create/SSE 全部失挂（客户端全瘫）。
     延迟到脚本装载完成后执行，语义不变。 */
  setTimeout(function () { if (store.auth.token && store.loadTenants) store.loadTenants().catch(function () {}); }, 0); // 域列表随会话引导（S3-8）

  let toastSeq = 0;
  store.toast = function (text, kind) {
    const id = ++toastSeq;
    store.toasts.push({ id, text: String(text), kind: kind || "ok", ts: Date.now() });
    setTimeout(() => {
      const i = store.toasts.findIndex(t => t.id === id);
      if (i >= 0) store.toasts.splice(i, 1);
    }, 4200);
  };

  /* ---------------- 模态（开机/危险操作二次确认） ---------------- */
  store.openSheet = spec => { store.sheet = spec; };
  store.closeSheet = () => { store.sheet = null; };
  store.confirm = function (spec) {
    return new Promise(resolve => {
      store.openSheet({
        title: spec.title || "确认这个动作？",
        rows: [
          spec.time && ("⏱ " + spec.time),
          spec.cost && ("💰 " + spec.cost),
          spec.shots && ("🎬 " + spec.shots)
        ].filter(Boolean),
        html: spec.html || "",
        actions: [
          { label: spec.okLabel || "确认", kind: "btn-primary", onClick: close => { close(); resolve(true); } },
          { label: "先不了", onClick: close => { close(); resolve(false); } }
        ]
      });
    });
  };

  /* ---------------- 登录 ---------------- */
  store.login = async function (code) {
    const r = await T.api.post("/login", { code });
    if (!r || !r.token) throw new T.ApiError(500, "NO_TOKEN", "登录没返回凭据");
    store.auth.token = r.token;
    store.auth.user = r.user || null;
    store.auth.ready = true;
    try {
      localStorage.setItem(LS_TOKEN, r.token);
      localStorage.setItem(LS_USER, JSON.stringify(r.user || {}));
    } catch (e) { /* 忽略 */ }
    syncAuthCookie();
    store.connectSSE();
    store.refreshState().catch(() => {});
    return r.user;
  };
  store.logout = function () {
    store.auth.token = null; store.auth.user = null;
    try { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER); } catch (e) {}
    syncAuthCookie();
    store.closeSSE();
    store.state = null;
    T.__ROUTER.go("#/login");
  };

  /* ---------------- 全局 state ---------------- */
  let stateTimer = null;
  store.refreshState = async function () {
    store.loading.state = true;
    try {
      const r = await T.api.get("/state");
      store.state = T.sanitizeDeep(r);
      store.err.state = null;
      // 域上下文跟随服务端投影（S3-8）：顶栏域名显示的单一事实源
      if (store.state && store.state.tenant_id) {
        store.tenant.current = store.state.tenant_id;
        store.tenant.currentName = store.state.tenant_name || null;
      }
    } catch (e) {
      store.err.state = e;
      throw e;
    } finally { store.loading.state = false; }
  };
  function refreshStateSoon() {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => store.refreshState().catch(() => {}), 600);
  }

  /* ---------------- 卡流 ---------------- */
  store.loadCards = async function (epId) {
    store.cards.loading = true; store.cards.error = null;
    try {
      const r = await T.api.get("/cards?episodeId=" + encodeURIComponent(epId));
      store.cards.list = T.sanitizeDeep(r.cards || []);
      store.cards.epId = epId;
    } catch (e) { store.cards.error = e; }
    finally { store.cards.loading = false; }
    return store.cards.list;
  };
  store.decideCard = async function (card, action, payload) {
    const body = { action: action };
    if (payload !== undefined) body.payload = payload;
    if (card.ver != null) body.ver = card.ver;
    try {
      const r = await T.api.post("/cards/" + encodeURIComponent(card.id) + "/decide", body);
      if (r && r.job && r.job.__deduped) {
        store.toast("同款任务已在跑或已生成（" + (r.job.id || "").slice(0, 14) + "…），未重复派——不用再点", "ok");
      } else {
        store.toast(action === "reject" ? "已重出一版（影子成本照常入账）" : action === "edit" ? "修改意见已带给制片组" : "已拍板，下游任务已派生");
      }
      if (store.cards.epId) store.loadCards(store.cards.epId).catch(() => {});
      refreshStateSoon();
      return r;
    } catch (e) {
      if (e.code === "STALE") store.openSheet({
        title: "上下文已变",
        rows: ["这张卡已被更新（版本号变了）"],
        actions: [{ label: "刷新卡片", kind: "btn-primary", onClick: close => { close(); if (store.cards.epId) store.loadCards(store.cards.epId); } },
          { label: "先不了", onClick: c => c() }]
      });
      else store.toast(T.humanErr(e).text, "err");
      throw e;
    }
  };

  /* ---------------- 拍摄 ---------------- */
  store.loadJobs = async function (epId) {
    store.jobs.loading = true; store.jobs.error = null;
    try {
      const r = await T.api.get("/jobs?episodeId=" + encodeURIComponent(epId));
      store.jobs.list = T.sanitizeDeep(r.jobs || []);
      store.jobs.epId = epId;
    } catch (e) { store.jobs.error = e; }
    finally { store.jobs.loading = false; }
    return store.jobs.list;
  };
  store.retryJob = async function (id) {
    try { await T.api.post("/jobs/" + encodeURIComponent(id) + "/retry", {}); store.toast("已重新入队"); if (store.jobs.epId) store.loadJobs(store.jobs.epId); }
    catch (e) { store.toast(T.humanErr(e).text, "err"); }
  };
  store.stopJob = async function (id) {
    try { await T.api.post("/jobs/" + encodeURIComponent(id) + "/stop", {}); store.toast("已请求停止"); if (store.jobs.epId) store.loadJobs(store.jobs.epId); }
    catch (e) { store.toast(T.humanErr(e).text, "err"); }
  };
  store.estimate = async function (epId) {
    const r = await T.api.get("/episodes/" + encodeURIComponent(epId) + "/estimate");
    return T.sanitizeDeep(r);
  };
  /* 生成档位（2026-11-22 运营化）：拍摄前选速度优先/质量优先/自动，报价即时联动 */
  store.setVideoPref = async function (epId, pref) {
    const r = await T.api.post("/episodes/" + encodeURIComponent(epId) + "/video-pref", { pref });
    store.toast(r && r.engine_note ? r.engine_note : "生成档位已更新");
    return r;
  };
  store.shoot = async function (epId, est) {
    const e = (est && (est.estimate || est.est)) || est || {};
    const ok = await store.confirm({
      title: "开机确认（服务端报价）",
      time: e.time_min != null ? "约 " + e.time_min + " 分钟" : null,

      shots: e.shots != null ? "拍 " + e.shots + " 镜" : null,
      okLabel: "确认开跑"
    });
    if (!ok) return null;
    const ver = e.ver != null ? e.ver : (est && est.ver);
    const r = await T.api.post("/episodes/" + encodeURIComponent(epId) + "/shoot", { ver: ver });
    store.toast("已批量入队 " + ((r.jobs && r.jobs.length) || 16) + " 镜 · 完成后在这里通知你");
    refreshStateSoon();
    return r;
  };

  /* ---------------- 复审 ---------------- */
  store.loadReview = async function () {
    store.review.loading = true; store.review.error = null;
    try {
      const r = await T.api.get("/review/queue");
      store.review.queue = T.sanitizeDeep(r.queue || []);
      store.review.pending = r.pending != null ? r.pending : store.review.queue.filter(x => (x.status || "pending") === "pending").length;
    } catch (e) { store.review.error = e; }
    finally { store.review.loading = false; }
    return store.review.queue;
  };
  store.decideReview = async function (item, action, reason) {
    try {
      const r = await T.api.post("/review/" + encodeURIComponent(item.id) + "/decide",
        { action, reason: reason || "", ver: item.ver != null ? item.ver : 1 });
      store.toast("复审已处置：" + (action === "pass" ? "放行" : action === "reject" ? "打回（镜头标需重做）" : "下架"));
      store.loadReview().catch(() => {});
      refreshStateSoon();
      return r;
    } catch (e) {
      store.toast(T.humanErr(e).text, "err");
      throw e;
    }
  };

  /* ---------------- 交付 / 成本 / 注册表 ---------------- */
  store.precheck = async function (epId) {
    const r = await T.api.post("/episodes/" + encodeURIComponent(epId) + "/precheck", {});
    return T.sanitizeDeep(r);
  };
  store.exportEpisode = async function (epId) {
    const r = await T.api.post("/episodes/" + encodeURIComponent(epId) + "/export", {});
    store.toast("导出任务已排队，产物出来会列在这里");
    return T.sanitizeDeep(r);
  };
  store.loadCosts = async function (epId) {
    store.costs.loading = true; store.costs.error = null;
    try {
      const r = await T.api.get("/episodes/" + encodeURIComponent(epId) + "/costs");
      store.costs.data = T.sanitizeDeep(r);
      store.costs.epId = epId;
    } catch (e) { store.costs.error = e; }
    finally { store.costs.loading = false; }
    return store.costs.data;
  };
  store.loadBilling = async function () {
    store.billing.loading = true; store.billing.error = null;
    try {
      const r = await T.api.get("/billing");
      store.billing.rows = T.sanitizeDeep(r.rows || []);
      store.billing.total = r.total || 0;
      store.billing.cents = r.cents || 0;
    } catch (e) { store.billing.error = e; }
    finally { store.billing.loading = false; }
    return store.billing.rows;
  };
  store.loadRegistry = async function () {
    store.registry.loading = true; store.registry.error = null;
    try {
      const r = await T.api.get("/admin/registry");
      // 运维台＝语言表豁免面（契约 §6/设计 §11.2）：段位/引擎/端点必须显原值，不消毒
      store.registry.data = r;
    } catch (e) { store.registry.error = e; }
    finally { store.registry.loading = false; }
    return store.registry.data;
  };
  store.setQuant = async function (engineId, tier, reason) {
    try {
      const r = await T.api.post("/admin/registry/quant", { engineId, tier, reason });
      store.toast(r.audit_needed ? "已按理由降级 · 审计号 " + r.audit_id : "段位已切换为 " + tier);
      store.loadRegistry().catch(() => {});
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  /* ---- 节点/引擎注册表 CRUD（2026-11-22 运维台化：加节点/撤节点/登记引擎不再改代码） ---- */
  store.addNode = async function (payload) {
    try {
      const r = await T.api.post("/nodes", payload);
      store.toast((r && r.note) || "节点已登记");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.updateNode = async function (id, payload) {
    try {
      const r = await T.api.put("/nodes/" + encodeURIComponent(id), payload);
      store.toast("节点「" + ((r && r.node && r.node.label) || id) + "」已更新");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.removeNode = async function (id, confirmed) {
    if (!confirmed) {
      const ok = await store.confirm({
        title: "撤掉节点「" + id + "」？",
        body: "有引擎绑定或剧集指向时会被拦下；撤掉的节点随时可以重新登记。"
      });
      if (!ok) return null;
    }
    try {
      const r = await T.api.post("/nodes/" + encodeURIComponent(id) + "/remove", {});
      store.toast((r && r.note) || "节点已撤");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.addEngine = async function (payload) {
    try {
      const r = await T.api.post("/admin/registry", payload);
      store.toast("引擎「" + payload.engineId + "」已登记");
      store.loadRegistry().catch(() => {});
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.removeEngine = async function (engineId, confirmed) {
    if (!confirmed) {
      const ok = await store.confirm({
        title: "注销引擎「" + engineId + "」？",
        body: "注册表里删掉这个引擎；指向其车道的新任务将按注册表重新解析归属。"
      });
      if (!ok) return null;
    }
    try {
      const r = await T.api.post("/admin/registry/remove", { engineId, confirmed: true });
      store.toast((r && r.note) || "引擎已注销");
      store.loadRegistry().catch(() => {});
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.rebindEngine = async function (engineId, node) {
    try {
      const r = await T.api.post("/admin/registry/node", { engineId, node: node || null, confirmed: true });
      store.toast((r && r.note) || "引擎归属节点已改绑");
      store.loadRegistry().catch(() => {});
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  /* ---- Agent 助手 LLM 档案（2026-11-22 大脑层解耦：档案可增删配置，与渲染机器解耦） ---- */
  store.loadLlmProfiles = async function () {
    try { return await T.api.get("/llm-profiles"); }
    catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.addLlmProfile = async function (payload) {
    try {
      const r = await T.api.post("/llm-profiles", payload);
      store.toast((r && r.note) || "LLM 档案已登记");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.updateLlmProfile = async function (id, payload) {
    try {
      const r = await T.api.put("/llm-profiles/" + encodeURIComponent(id), payload);
      store.toast((r && r.note) || "LLM 档案已保存");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.removeLlmProfile = async function (id, label, confirmed) {
    if (!confirmed) {
      const ok = await store.confirm({
        title: "删除 LLM 档案「" + (label || id) + "」？",
        body: "正在被 Agent 助手使用的档案会被拦下；删除后随时可以重新登记。"
      });
      if (!ok) return null;
    }
    try {
      const r = await T.api.post("/llm-profiles/" + encodeURIComponent(id) + "/remove", {});
      store.toast((r && r.note) || "LLM 档案已删除");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.activateLlmProfile = async function (id) {
    try {
      const r = await T.api.post("/llm-profiles/activate", { id });
      store.toast((r && r.note) || "Agent 大脑已切换");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.probeLlmProfile = async function (id) {
    try { return await T.api.post("/llm-profiles/" + encodeURIComponent(id) + "/probe", {}); }
    catch (e) { return { ok: false, detail: T.humanErr(e).text }; }
  };
  store.probeRegistry = async function () {
    try {
      const r = await T.api.post("/admin/registry/endpoint", {});
      return r;
    } catch (e) { /* 探测失败也回结构化结果 */ return { error: T.humanErr(e) }; }
  };
  store.probeEngine = async function (engineId) {
    try {
      const r = await T.api.post("/admin/registry/probe", { engineId });
      return r; // {ok, code, ms, detail} —— 真探测结果
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.loadAudit = async function () {
    try {
      const r = await T.api.get("/admin/audit");
      store.registry.audit = T.sanitizeDeep(r.rows || r.audit || r.list || []);
      return store.registry.audit;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.loadAlerts = async function () {
    try {
      const r = await T.api.get("/admin/alerts");
      store.registry.alerts = T.sanitizeDeep(r.alerts || []);
      return store.registry.alerts;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };

  /* ---------------- 音乐 / 资产 ---------------- */
  store.loadMusic = async function () {
    store.music.loading = true; store.music.error = null;
    try {
      const r = await T.api.get("/music/library");
      store.music.library = T.sanitizeDeep(r.library || []);
    } catch (e) { store.music.error = e; }
    finally { store.music.loading = false; }
    return store.music.library;
  };
  store.adoptMusic = async function (id, sceneId) {
    try {
      const r = await T.api.post("/music/" + encodeURIComponent(id) + "/adopt", { sceneId: sceneId || null });
      store.toast("已挂接到该场音轨");
      store.loadMusic().catch(() => {});
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.regenMusic = async function (id) {
    try { await T.api.post("/music/" + encodeURIComponent(id) + "/regenerate", {}); store.toast("已重出这批候选（影子成本照常入账）"); }
    catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.genCandidates = async function (sceneId, mood) {
    try {
      const r = await T.api.post("/music/candidates", { sceneId, mood });
      store.toast("候选生成中，稍后进曲库");
      return T.sanitizeDeep(r);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };

  /* ---------------- 素材中心（2026-11-22 施工 A5：五域资产库＋候选池＋绑定） ---------------- */
  store.studio = {
    summary: null, loading: false, error: null,
    drafts: { music: [], images: [] },
    lib: { music: [], images: [], characters: [], scenes: [], sfx: [], ambience: [], voices: [] },
    readiness: null
  };
  store.loadStudioSummary = async function () {
    try { store.studio.summary = T.sanitizeDeep(await T.api.get("/studio/summary")); }
    catch (e) { store.toast(T.humanErr(e).text, "err"); }
    return store.studio.summary;
  };
  store.loadStudioDomain = async function (domain) {
    try {
      const r = await T.api.get("/studio/" + encodeURIComponent(domain));
      store.studio.lib[domain] = T.sanitizeDeep(r.list || []);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); }
    return store.studio.lib[domain];
  };
  store.loadStudioDrafts = async function () {
    try {
      const r = await T.api.get("/studio/drafts");
      const d = T.sanitizeDeep(r.drafts || {});
      store.studio.drafts.music = d.music || [];
      store.studio.drafts.images = d.images || [];
    } catch (e) { /* 静默：轮询面 */ }
    return store.studio.drafts;
  };
  store.studioGenerateMusic = async function (spec) {
    try {
      const r = await T.api.post("/studio/audio/music/generate", spec);
      store.toast("配乐候选生成中（一次 " + (r.expected || 6) + " 段），出来后进「候选池」挑选入库");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioGenerateImage = async function (spec) {
    try {
      const r = await T.api.post("/studio/images/generate", spec);
      store.toast("图像生成中（" + (r.expected || 2) + " 张），出来后进「候选池」挑选入库");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioAdoptDraft = async function (domain, id, payload) {
    try {
      const r = await T.api.post("/studio/drafts/" + encodeURIComponent(domain) + "/" + encodeURIComponent(id) + "/adopt", payload || {});
      store.toast("已入素材库");
      store.loadStudioDrafts().catch(() => {});
      store.loadStudioDomain(domain).catch(() => {});
      return T.sanitizeDeep(r.entry || r);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioDiscardDraft = async function (domain, id) {
    try { await T.api.del("/studio/drafts/" + encodeURIComponent(domain) + "/" + encodeURIComponent(id)); store.loadStudioDrafts().catch(() => {}); }
    catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioBind = async function (domain, id, kind, targetId, primary) {
    try {
      const r = await T.api.post("/studio/" + encodeURIComponent(domain) + "/" + encodeURIComponent(id) + "/bind",
        { kind, id: targetId, primary: !!primary });
      store.toast("已绑定" + (primary ? "（主曲）" : ""));
      store.loadStudioDomain(domain).catch(() => {});
      return T.sanitizeDeep(r.entry || r);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioUnbind = async function (domain, id, kind, targetId) {
    try {
      await T.api.post("/studio/" + encodeURIComponent(domain) + "/" + encodeURIComponent(id) + "/unbind", { kind, id: targetId });
      store.toast("已解绑");
      store.loadStudioDomain(domain).catch(() => {});
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioPatch = async function (domain, id, patch) {
    try {
      const rr = await T.api.patch("/studio/" + encodeURIComponent(domain) + "/" + encodeURIComponent(id), patch);
      store.loadStudioDomain(domain).catch(() => {});
      return T.sanitizeDeep(rr.entry || rr);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioUsedBy = async function (domain, id) {
    try {
      const r = await T.api.get("/studio/used_by/" + encodeURIComponent(domain) + "/" + encodeURIComponent(id));
      return T.sanitizeDeep(r.used_by || []);
    } catch (e) { return []; }
  };
  store.studioUpload = async function (domain, file, meta) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const qs = new URLSearchParams();
      qs.set("domain", domain);
      const m = meta || {};
      if (m.title) qs.set("title", String(m.title).slice(0, 60));
      if (m.type) qs.set("type", String(m.type));
      if (m.licenseModel) qs.set("licenseModel", String(m.licenseModel).slice(0, 40));
      if (m.licenseUsage) qs.set("licenseUsage", String(m.licenseUsage));
      if (m.desc) qs.set("desc", String(m.desc).slice(0, 400));
      const r = await T.api.rawPost("/studio/upload?" + qs.toString(), buf);
      store.toast("素材已上传入库");
      store.loadStudioDomain(domain).catch(() => {});
      return T.sanitizeDeep(r.entry || r);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  /* 声纹克隆（2026-11-22）：两步登记——样本先落盘（upload?domain=voices 只存文件），
   * 再 POST /studio/voices kind=clone 带授权绑定 ref；缺授权服务端 400。 */
  store.studioCreateVoice = async function (file, meta) {
    try {
      const m = meta || {};
      const buf = new Uint8Array(await file.arrayBuffer());
      const qs = new URLSearchParams();
      qs.set("domain", "voices");
      if (m.name) qs.set("title", String(m.name).slice(0, 60));
      const up = await T.api.rawPost("/studio/upload?" + qs.toString(), buf);
      const r = await T.api.post("/studio/voices", {
        kind: "clone", name: m.name || "声纹", gender: m.gender === "男" ? "男" : "女",
        desc: m.desc || "", prompt_text: m.prompt_text || "", consent: true, ref: up.art
      });
      store.toast("声纹已登记");
      store.loadStudioDomain("voices").catch(() => {});
      return T.sanitizeDeep(r.voice || r);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioDeleteVoice = async function (id) {
    try { await T.api.del("/studio/voices/" + encodeURIComponent(id)); store.loadStudioDomain("voices").catch(() => {}); }
    catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioExtractCharacter = async function (episodeId, role) {
    try {
      const r = await T.api.post("/studio/characters/extract", { episodeId, role });
      store.toast(r.existed ? "该角色已在素材库中" : "角色已提取入库（含试镜帧池）");
      store.loadStudioDomain("characters").catch(() => {});
      return T.sanitizeDeep(r.character || r);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioPromoteFrames = async function (id, episodeId, role) {
    try {
      const r = await T.api.post("/studio/characters/" + encodeURIComponent(id) + "/promote_frames", { episodeId, role });
      store.toast("试镜帧池已入库" + (r.added >= 0 ? "（新增 " + r.added + " 帧）" : ""));
      store.loadStudioDomain("characters").catch(() => {});
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioRecast = async function (id) {
    try {
      const r = await T.api.post("/studio/characters/" + encodeURIComponent(id) + "/recast", {});
      store.toast("重定妆已排队：候选出来后在「候选池」收藏并挂回该角色（生成新版本）");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioCreateScene = async function (spec) {
    try {
      const r = await T.api.post("/studio/scenes", spec);
      store.toast("场景卡已建");
      store.loadStudioDomain("scenes").catch(() => {});
      return T.sanitizeDeep(r.scene || r);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioEstablishing = async function (id, variantTag) {
    try {
      const r = await T.api.post("/studio/scenes/" + encodeURIComponent(id) + "/establishing", { variantTag: variantTag || null });
      store.toast("定场图生成中，候选出来后收藏并挂回该场景卡");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioReadiness = async function (epId) {
    try {
      const r = await T.api.get("/studio/readiness/" + encodeURIComponent(epId));
      store.studio.readiness = T.sanitizeDeep(r);
    } catch (e) { store.studio.readiness = null; }
    return store.studio.readiness;
  };
  store.studioCanon = async function (kind) {
    try {
      const r = await T.api.get("/studio/canon/" + encodeURIComponent(kind));
      return T.sanitizeDeep(r.list || []);
    } catch (e) { return []; }
  };
  store.studioSaveCanon = async function (kind, entry) {
    try {
      const r = await T.api.post("/studio/canon/" + encodeURIComponent(kind), entry);
      store.toast("设定已保存");
      return T.sanitizeDeep(r.entry || r);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioDeleteCanon = async function (kind, id) {
    try {
      const r = await T.api.del("/studio/canon/" + encodeURIComponent(kind) + "/" + encodeURIComponent(id));
      store.toast("设定条目已删除");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioExportPack = async function () {
    try {
      const r = await T.api.post("/studio/packs/export", {});
      store.toast("素材包已导出（元数据清单）");
      return r.pack;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioImportPack = async function (pack) {
    try {
      const r = await T.api.post("/studio/packs/import", { pack });
      store.toast("素材包已导入（新增 " + (r.added || 0) + " 条）");
      ["music", "images", "characters", "scenes"].forEach(d => store.loadStudioDomain(d).catch(() => {}));
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioAiLyrics = async function (spec) {
    try {
      const r = await T.api.post("/studio/ai/lyrics", spec);
      return T.sanitizeDeep(r);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.studioAiImage = async function (spec) {
    try {
      const r = await T.api.post("/studio/ai/image-prompt", spec);
      return T.sanitizeDeep(r);
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };

  /* ---------------- AI 建议片 / 剧本修订 ---------------- */
  store.suggestCard = async function (cardId, note) {
    const r = await T.api.post('/cards/' + encodeURIComponent(cardId) + '/suggest', { note });
    return T.sanitizeDeep(r || {});
  };
  store.reviseScenes = async function (epId, scenes) {
    const r = await T.api.post('/episodes/' + encodeURIComponent(epId) + '/script-scenes', { scenes });
    store.toast('剧本分镜表已修订，C1 卡同步刷新');
    refreshStateSoon();
    return r;
  };

    /* ---------------- GPU/LLM（llm-gw 状态面） ---------------- */
  store.loadGpu = async function () {
    store.gpu.loading = true; store.gpu.error = null;
    try { store.gpu.data = await T.api.get('/gpu'); }
    catch (e) { store.gpu.error = e; }
    finally { store.gpu.loading = false; }
    return store.gpu.data;
  };
  store.stopLlm = async function () {
    try {
      const r = await T.api.post('/gpu/llm/stop', {});
      store.toast(r && r.message ? r.message : 'LLM 已停，显存已释放');
      store.loadGpu().catch(() => {});
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, 'err'); throw e; }
  };

    /* ---------------- 项目 / 集 ---------------- */
  store.createProject = async function (spec) {
    try {
      const r = await T.api.post("/projects", spec);
      store.toast("新项目已建，可以在下面开集了");
      refreshStateSoon();
      return r.project || r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.createEpisode = async function (spec) {
    try {
      const r = await T.api.post("/episodes", spec);
      store.toast("新集已建，卡流开始进来了");
      refreshStateSoon();
      return r.episode || r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };

  /* ---------------- 一句话成片 / 题材节拍模板（2026-11-21 补全） ---------------- */
  /* 一站式直跑：自动建项目（可指定）→建集→派 LLM 剧本生成→进卡流看 C1 卡 */
  store.quickstart = async function (spec) {
    try {
      const r = await T.api.post("/quickstart", spec);
      store.toast("已开机：剧本组正在拆策划案，卡流马上进来");
      refreshStateSoon();
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.loadTemplates = async function () {
    store.templates.loading = true; store.templates.error = null;
    try {
      const r = await T.api.get("/templates");
      store.templates.list = T.sanitizeDeep(r.templates || []);
    } catch (e) { store.templates.error = e; }
    finally { store.templates.loading = false; }
    return store.templates.list;
  };
  store.saveTemplate = async function (t) {
    try {
      const r = await T.api.post("/admin/templates", t);
      store.toast(t.id ? "模板已保存（v" + (r.template && r.template.ver) + "）" : "模板已新建");
      store.loadTemplates().catch(() => {});
      return r.template;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.removeTemplate = async function (id, confirmed) {
    if (!confirmed) {
      const ok = await store.confirm({
        title: "删除模板（不可撤销）",
        okLabel: "确认删除"
      });
      if (!ok) return null;
    }
    try {
      const r = await T.api.post("/admin/templates/remove", { id, confirmed: !!confirmed });
      store.toast("模板已删除");
      store.loadTemplates().catch(() => {});
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };

  /* ---------------- 删除（2026-11-22：二次确认内置，confirmed=true 跳过弹窗） ---------------- */
  store.deleteEpisode = async function (id, confirmed) {
    if (!confirmed) {
      const ok = await store.confirm({
        title: "删除这一集？（不可恢复）",
        html: "该集的卡、镜头、场景、试妆参考与过程产物文件将<b>一并删除</b>；排队中的任务取消，账本保留审计记录。",
        okLabel: "确认删除"
      });
      if (!ok) return null;
    }
    try {
      const r = await T.api.del("/episodes/" + encodeURIComponent(id));
      store.toast("该集已删除");
      refreshStateSoon();
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.deleteProject = async function (id, confirmed) {
    if (!confirmed) {
      const ok = await store.confirm({
        title: "删除这个项目？（不可恢复）",
        html: "仅空项目可删——项目下还有集时请先删集，再删项目。",
        okLabel: "确认删除"
      });
      if (!ok) return null;
    }
    try {
      const r = await T.api.del("/projects/" + encodeURIComponent(id));
      store.toast("项目已删除");
      refreshStateSoon();
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };

  /* ---------------- 邀请码管理（2026-11-22 按人发码，ops 运维台） ---------------- */
  store.loadInvites = async function () {
    const r = await T.api.get("/admin/invites");
    return r.invites || [];
  };
  store.addInvite = async function (name, role) {
    try {
      const r = await T.api.post("/admin/invites", { name, role });
      store.toast("新码已生成：" + r.code);
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.removeInvite = async function (code, confirmed) {
    if (!confirmed) {
      const ok = await store.confirm({
        title: "吊销这个邀请码？",
        html: "吊销后该码无法再登录（已绑定账号不受影响）。",
        okLabel: "确认吊销"
      });
      if (!ok) return null;
    }
    try {
      const r = await T.api.post("/admin/invites/remove", { code });
      store.toast("邀请码已吊销");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };

  /* ---------------- 域（主账户）切换与管理（S3-8） ---------------- */
  store.loadTenants = async function () {
    store.tenant.loading = true;
    try {
      const r = await T.api.get("/auth/tenants");
      store.tenant.list = r.tenants || [];
      store.tenant.current = r.current || null;
      store.tenant.currentName = r.current_name || null;
      return store.tenant.list;
    } catch (e) {
      return [];
    } finally { store.tenant.loading = false; }
  };
  store.switchTenant = async function (tid) {
    if (tid === store.tenant.current) return null;
    try {
      const r = await T.api.post("/auth/switch", { tid });
      store.auth.token = r.token;
      if (r.user) store.auth.user = r.user;
      try {
        localStorage.setItem(LS_TOKEN, r.token);
        localStorage.setItem(LS_USER, JSON.stringify(r.user || {}));
      } catch (e) { /* 忽略 */ }
      syncAuthCookie();
      store.closeSSE();
      store.connectSSE();
      await store.refreshState();
      store.loadTenants().catch(() => {});
      const t = (store.tenant.list || []).find(x => x.id === tid);
      store.toast("已切换到「" + ((t && t.name) || tid) + "」");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.createTenant = async function (name) {
    try {
      const r = await T.api.post("/tenants", { name });
      store.toast("域已创建：" + (r.tenant && r.tenant.name));
      await store.loadTenants();
      return r.tenant;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.loadTenantDetail = async function (tid) {
    const r = await T.api.get("/tenants/" + encodeURIComponent(tid));
    return r; // {tenant, members, invites}
  };
  store.addTenantInvite = async function (tid, name, role) {
    try {
      const r = await T.api.post("/tenants/" + encodeURIComponent(tid) + "/invites", { name, role });
      store.toast("域邀请码已生成：" + r.code);
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.removeTenantMember = async function (tid, uid) {
    try {
      const r = await T.api.post("/tenants/" + encodeURIComponent(tid) + "/members/remove", { uid });
      store.toast("成员已移出本域");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.loadTenantBilling = async function (tid) {
    const r = await T.api.get("/tenants/" + encodeURIComponent(tid) + "/billing");
    return r; // {total_cents, budget_cents, pct, by_episode, by_kind}
  };
  store.setTenantBudget = async function (tid, cents) {
    try {
      const r = await T.api.post("/tenants/" + encodeURIComponent(tid) + "/budget", { budget_cents: cents });
      store.toast(cents === null ? "域预算已清除（无上限）" : "域预算已设为 " + cents + " 分");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.setTenantMemberRole = async function (tid, uid, role) {
    try {
      const r = await T.api.post("/tenants/" + encodeURIComponent(tid) + "/members/role", { uid, role });
      store.toast("成员身份已更新");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.transferTenant = async function (tid, uid) {
    const ok = await store.confirm({
      title: "转让域主身份？",
      html: "你将降为管理员，新域主拥有全部管理权（含转让与删域）。可再转回。",
      okLabel: "确认转让"
    });
    if (!ok) return null;
    try {
      const r = await T.api.post("/tenants/" + encodeURIComponent(tid) + "/transfer", { uid });
      store.toast("域主已转让");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  store.removeTenantInvite = async function (tid, code) {
    const ok = await store.confirm({
      title: "吊销这个域邀请码？",
      html: "吊销后该码无法再入域（已入域成员不受影响）。",
      okLabel: "确认吊销"
    });
    if (!ok) return null;
    try {
      const r = await T.api.post("/tenants/" + encodeURIComponent(tid) + "/invites/remove", { code });
      store.toast("域邀请码已吊销");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };

  /* ---------------- L2 副驾 ---------------- */
  /* 恢复会话：id 给定→加载指定；否则取最近一个非空会话；无非空会话→false（调用方决定是否新建）。
     修复：此前每次 boot 无脑 l2Create()，刷新 N 次堆 N 个空会话。 */
  store.l2Resume = async function (id) {
    let s = null;
    if (id) {
      const r = await T.api.get('/l2/sessions/' + encodeURIComponent(id));
      s = r.session || null;
    } else {
      const r = await T.api.get('/l2/sessions');
      const list = (r.sessions || []).filter(x => x.msgs && x.msgs.length);
      s = list.length ? list[list.length - 1] : null;
    }
    if (!s) return false;
    const L = store.l2;
    L.sid = s.id || null;
    L.mode = s.mode || 'A';
    L.msgs = T.sanitizeDeep((s.msgs || []).map(m => ({ me: m.me, t: m.t, ts: m.ts, sig: m.sig, runtime: m.runtime })));
    L.tasks = T.sanitizeDeep(s.tasks || []);
    L.approvals = T.sanitizeDeep((s.approvals || []).map(a => ({ id: a.id, tool: a.tool, args: a.args, est: a.est, status: a.status, ttl_until: a.ttl_until, ver: a.ver })));
    L.used_cents = s.used_cents || 0;
    L.budget_line = s.budget_cents || 8000;
    L.status = 'ready';
    store.connectSSE(); // 重挂 l2:<sid>
    return true;
  };
  store.l2Create = async function (mode) {
    store.l2.loading = true; store.l2.error = null;
    try {
      const r = await T.api.post("/l2/sessions", mode ? { mode } : {});
      const s = r.session || {};
      store.l2.sid = s.id || null;
      store.l2.mode = s.mode || mode || "A";
      store.l2.msgs = []; store.l2.tasks = []; store.l2.approvals = [];
      store.l2.used_cents = 0;
      store.l2.budget_line = s.budget_cents || 8000;
      store.l2.status = "ready";
      store.connectSSE(); // 重挂 l2:<sid>
      return s;
    } catch (e) { store.l2.error = e; store.l2.status = "broken"; throw e; }
    finally { store.l2.loading = false; }
  };
  store.l2Send = async function (text, chips) {
    if (!store.l2.sid) throw new T.ApiError(400, "NO_SESSION", "先连接制片助手");
    store.l2.sending = true;
    store.l2.msgs.push({ me: 1, t: text, ts: Date.now() });
    try {
      const r = await T.api.post("/l2/sessions/" + encodeURIComponent(store.l2.sid) + "/messages",
        { text, ctx: chips || [] });
      if (r && r.code) store.toast(T.humanErr(r).text, "warn");
      return r;
    } catch (e) {
      store.toast(T.humanErr(e).text, "err");
      throw e;
    } finally { store.l2.sending = false; }
  };
  store.l2Decide = async function (approvalId, decision) {
    try {
      const r = await T.api.post("/l2/approvals/" + encodeURIComponent(approvalId), { decision });
      if (r && r.code) store.toast(T.humanErr(r).text, "warn");
      else store.toast(decision === "approve" ? "已批准，助手去办了" : "已驳回 · 留痕");
      return r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };
  /* l2:<sid> topic 事件分发（骨架 SSE 收流后调用；视图别自己订） */
  store.l2Event = function (d) {
    const L = store.l2;
    switch (d.type) {
      case "msg_delta": {
        const last = L.msgs[L.msgs.length - 1];
        if (last && last.me === 0 && last.streaming) last.t = (last.t || "") + (d.t || "");
        else L.msgs.push({ me: 0, t: d.t || "", ts: Date.now(), sig: d.sig || "制片组助手", runtime: d.runtime, streaming: true });
        break;
      }
      case "msg_done": {
        const last = L.msgs[L.msgs.length - 1];
        if (last && last.me === 0 && last.streaming) { last.streaming = false; if (d.t != null) last.t = d.t; }
        else L.msgs.push({ me: 0, t: d.t || "", ts: Date.now(), sig: d.sig || "制片组助手", runtime: d.runtime });
        break;
      }
      case "tool_call": {
        const ex = L.tasks.find(x => x.toolCallId === d.id);
        const label = (d.status === "queued" ? "执行 " : "") + T.sanitize(d.tool || "动作") + (d.status === "done" ? " ✓" : d.status === "failed" ? " ✗" : " …");
        if (ex) { ex.status = d.status; ex.label = label; }
        else L.tasks.push({ id: d.id, toolCallId: d.id, label, status: d.status, trace: d.trace_id });
        break;
      }
      case "task_update": {
        const t = d.task || {};
        const ex = L.tasks.find(x => x.id === t.id);
        if (ex) Object.assign(ex, t);
        else L.tasks.push(t);
        break;
      }
      case "approval_new": {
        if (!L.approvals.find(a => a.id === d.id)) L.approvals.push(Object.assign({ status: "pending" }, d));
        store.toast("助手有个动作等你确认", "warn");
        break;
      }
      case "approval_resolved": {
        const a = L.approvals.find(x => x.id === d.id);
        if (a) a.status = d.status;
        break;
      }
      case "denied": {
        store.toast("助手有个越界动作被拦下：" + T.sanitize(d.tool || "") , "warn");
        L.msgs.push({ me: 0, t: "（这个动作被治理层拦下了：" + T.sanitize(d.reason || "越权") + "）", ts: Date.now(), sig: "治理", denied: true });
        break;
      }
      case "budget": {
        if (d.used_cents != null) L.used_cents = d.used_cents;
        break;
      }
      default: break;
    }
  };

  /* ---------------- SSE ---------------- */
  let es = null;
  let backoff = 1000;
  let retryTimer = null;
  let wantConn = false;

  store.connectSSE = function () {
    if (!store.auth.token) return;
    wantConn = true;
    open();
  };
  store.closeSSE = function () {
    wantConn = false;
    clearTimeout(retryTimer);
    if (es) { try { es.close(); } catch (e) {} es = null; }
    store.conn.sse = "off";
  };
  function open() {
    if (es) { try { es.close(); } catch (e) {} es = null; }
    store.conn.sse = "connecting";
    const url = T.eventsUrl(store.l2.sid || undefined);
    let h;
    try {
      es = new global.EventSource(url);
    } catch (e) {
      store.conn.sse = "off"; store.conn.err = String(e);
      schedule(); return;
    }
    const handle = topic => ev => {
      let d = null;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (!d || d.ping) return;
      store.conn.lastAt = Date.now();
      store.conn.sse = "on"; backoff = 1000;
      routeEvent(topic || d.topic, d);
    };
    es.onopen = () => { store.conn.sse = "on"; store.conn.err = null; backoff = 1000; };
    es.onmessage = handle(null);
    ["jobs", "cards", "alerts", "review"].forEach(tp => es.addEventListener(tp, handle(tp)));
    if (store.l2.sid) es.addEventListener("l2:" + store.l2.sid, handle("l2"));
    es.onerror = () => {
      if (!wantConn) return;
      store.conn.sse = "off";
      store.conn.err = "连接断了，正在自动重连…";
      open2();
    };
  }
  function open2() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (wantConn) open(); }, backoff);
    backoff = Math.min(backoff * 2, 15000);
  }
  function routeEvent(topic, d) {
    if (topic === "jobs" || d.job_id || (d.job && d.job.id)) {
      const jid = d.job_id || (d.job && d.job.id);
      const lst = store.jobs.list;
      if (jid && Array.isArray(lst)) {
        const ex = lst.find(j => String(j.id) === String(jid));
        if (ex) Object.assign(ex, d.job || {}, { status: d.status || ex.status, attempts: d.attempts != null ? d.attempts : ex.attempts });
        else if (!d.episodeId || !store.jobs.epId || d.episodeId === store.jobs.epId) store.loadJobs(store.jobs.epId).catch(() => {});
      }
      return;
    }
    if (topic === "cards") { if (store.cards.epId) store.loadCards(store.cards.epId).catch(() => {}); refreshStateSoon(); return; }
    if (topic === "review") { store.loadReview().catch(() => {}); refreshStateSoon(); return; }
    if (topic === "alerts") { store.toast(T.sanitize(d.msg || "收到一条系统告警"), "warn"); refreshStateSoon(); return; }
    if (topic === "l2" || (d.sid && d.sid === store.l2.sid)) { store.l2Event(d); return; }
    refreshStateSoon();
  }

  global.__STORE = store;
})(window);
