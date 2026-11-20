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
    costs: { data: null, loading: false, error: null, epId: null },
    billing: { rows: null, total: 0, cents: 0, loading: false, error: null },
    registry: { data: null, probes: null, alerts: null, audit: null, loading: false, error: null },
    l2: {
      sid: null, mode: "A", status: "idle",
      msgs: [], tasks: [], approvals: [],
      used_cents: 0, budget_line: 8000,
      loading: false, error: null, sending: false
    },
    toasts: [],
    sheet: null
  });
  T.store = store;

  /* ---------------- token ---------------- */
  try {
    store.auth.token = localStorage.getItem(LS_TOKEN) || null;
    const u = localStorage.getItem(LS_USER);
    store.auth.user = u ? JSON.parse(u) : null;
  } catch (e) { /* 隐私模式 */ }
  T.setTokenGetter(() => store.auth.token);

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
    store.connectSSE();
    store.refreshState().catch(() => {});
    return r.user;
  };
  store.logout = function () {
    store.auth.token = null; store.auth.user = null;
    try { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER); } catch (e) {}
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
      store.toast(action === "reject" ? "已重出一版（影子成本照常入账）" : action === "edit" ? "修改意见已带给制片组" : "已拍板，下游任务已派生");
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
  store.shoot = async function (epId, est) {
    const e = (est && (est.estimate || est.est)) || est || {};
    const ok = await store.confirm({
      title: "开机确认（服务端报价）",
      time: e.time_min != null ? "约 " + e.time_min + " 分钟" : null,
      cost: "本地自部署 · 无生成费用（内部核算 " + (e.cents != null ? e.cents : "—") + " 分）",
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

  /* ---------------- 项目 / 集 ---------------- */
  store.createEpisode = async function (spec) {
    try {
      const r = await T.api.post("/episodes", spec);
      store.toast("新集已建，卡流开始进来了");
      refreshStateSoon();
      return r.episode || r;
    } catch (e) { store.toast(T.humanErr(e).text, "err"); throw e; }
  };

  /* ---------------- L2 副驾 ---------------- */
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
