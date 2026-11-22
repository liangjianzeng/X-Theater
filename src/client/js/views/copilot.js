/* 剧场 Studio · 制片助手副驾（视图 C 负责）
   右侧常驻栏（骨架挂在布局 .app-rail）：对话 / 任务 / 审批 三 tab。
   SSE 由骨架 store 维护；本组件只做 8s 全量兜底（GET /api/l2/sessions/:id）与展示。

   // BACKEND-ISSUE: GET /api/l2/sessions/:id 的 msgs 落库方向与前端契约相反——
   //   服务端把「用户消息」存成 me:0、「助手回复」存成 me:1（带 sig/runtime 署名），
   //   而骨架 store（l2Send 推 me:1、msg_delta 归 me:0）约定 me:1=本人、me=0=助手。
   //   本视图合并时按「有无 sig 署名」归一化（有署名=助手 me:0，无署名=本人 me:1），
   //   该规则对两种方向都成立；后端修正落库方向后无需改前端。
   // BACKEND-ISSUE: SSE l2:<sid> 的流式增量事件字段是 {type:"msg_delta", text, done}，
   //   且从不发 msg_done；骨架 store.l2Event 读的是 d.t 并等 msg_done 收尾。
   //   本组件挂载时给 store.l2Event 装一层带守卫的兼容转发（text→t、done→msg_done），
   //   不改骨架文件、不新订 SSE；仅当骨架字段名与后端对齐后可整层移除。
   // BACKEND-ISSUE: 审批新事件名是 approval_request（载荷嵌在 d.approval），
   //   VIEWS-CONTRACT §3 与骨架 l2Event 期望的是扁平 approval_new。同上，由兼容转发层归一。
   // BACKEND-ISSUE: 会话预算线字段服务端叫 budget_cents，骨架 store.l2 叫 budget_line；
   //   本视图兜底同步时做 budget_cents→budget_line 映射。
   // BACKEND-ISSUE: 审批预估字段服务端是 est.time_min，契约 §3 写的是 est.time；
   //   本视图读取 time_min，并兼容 time。
*/
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  /* P2 主动性 hint（蓝图 §3.6）：卡类型中文名＋下游影响——展示面与客户端 TYPE_META 同口径 */
  const CARD_CN = {
    C1: { name: "故事方向卡", next: "定妆、试镜、分镜全在等它" },
    C2: { name: "演员定妆卡", next: "定妆定了分镜首帧才好落" },
    C2S: { name: "试妆试镜卡", next: "确认后才进批量出图" },
    C3: { name: "演员表锁定卡", next: "演员表锁定才能试拍" },
    C4: { name: "分镜画面卡", next: "分镜定了才有样片" },
    C5: { name: "样片审看卡", next: "样片过审就到开机报价" },
    C6: { name: "开机报价卡", next: "报价拍板＝真金白银开跑" },
    C7: { name: "灰区镜头批复卡", next: "批复完镜头才放行" },
    C8: { name: "交付确认卡", next: "全镜放行即可导出成片" },
    C9: { name: "配乐提案卡", next: "音轨就位后成片不返工" }
  };

  const TOOL_CN = {
    reroll_shot: "重拍镜头",
    music_candidates: "配乐候选",
    set_mood: "调整场次情绪",
    pick_take: "择优采用",
    query_cost: "查成本",
    query_progress: "查进度",
    query_projects: "查项目",
    export_session: "导出会话内容"
  };
  const ARG_CN = {
    episode_id: "剧集", shot_id: "镜头", scene_id: "场景", mood: "情绪",
    take_id: "候选条", text: "内容", ctx: "上下文"
  };

  /* ---------- store.l2Event 兼容转发层（见顶部 BACKEND-ISSUE） ---------- */
  let bridgeInstalled = false;
  function installBridge() {
    if (bridgeInstalled) return;
    const orig = store.l2Event;
    if (!orig || orig.__copilotCompat) { bridgeInstalled = true; return; }
    const wrap = function (d) {
      try {
        if (d && d.type === "approval_request" && d.approval) {
          return orig.call(store, Object.assign({ type: "approval_new" }, T.sanitizeDeep(d.approval)));
        }
        if (d && d.type === "msg_card" && d.card) {
          /* 顾问卡挂到最新一条助手气泡（流式文本已落地，卡随后到） */
          const lst = store.l2.msgs;
          for (let i = lst.length - 1; i >= 0; i--) {
            if (lst[i].me === 0 && !lst[i].card) { lst[i].card = T.sanitizeDeep(d.card); break; }
          }
          return;
        }
        if (d && d.type === "msg_delta" && d.t == null && typeof d.text === "string") {
          orig.call(store, { type: "msg_delta", t: d.text });
          if (d.done) {
            const lst = store.l2.msgs;
            const last = lst.length ? lst[lst.length - 1] : null;
            if (last && last.me === 0 && last.streaming) orig.call(store, { type: "msg_done" });
          }
          return;
        }
      } catch (e) { /* 兼容层出错绝不阻断骨架分发 */ }
      return orig.call(store, d);
    };
    wrap.__copilotCompat = true;
    store.l2Event = wrap;
    bridgeInstalled = true;
  }

  function fmtArgs(args) {
    let s;
    try { s = JSON.stringify(args || {}); } catch (e) { s = ""; }
    Object.keys(ARG_CN).forEach(k => { s = s.split('"' + k + '"').join('"' + ARG_CN[k] + '"'); });
    s = String(s || "").replace(/[{}"]/g, "").replace(/:/g, "：").replace(/,/g, " · ");
    if (s.length > 72) s = s.slice(0, 72) + "…";
    return T.sanitize(s || "无参数");
  }

  views.Copilot = {
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "loading": T.components.Loading,
      "money": T.components.Money,
      "status-dot": T.components.StatusDot
    },
    setup() {
      const L = store.l2;
      const tab = Vue.ref("chat");
      const draft = Vue.ref("");
      const connecting = Vue.ref(false);
      const busyId = Vue.ref("");
      const srvBroken = Vue.ref(false);
      const nowTick = Vue.ref(Date.now());
      const rootEl = Vue.ref(null);
      const bodyEl = Vue.ref(null);

      function isMobile() {
        return !!(global.matchMedia && global.matchMedia("(max-width: 860px)").matches);
      }
      /* 桌面默认展开；H5 一律收起（fab 唤出），跨断点切换时强制归位 */
      const open = Vue.ref(!isMobile());
      function syncParent() {
        const el = rootEl.value;
        if (!el || !el.closest) return;
        const aside = el.closest(".app-rail");
        if (aside) aside.classList.toggle("open", !!open.value);
      }
      function toggleFab() { open.value = !open.value; }
      function closeRail() { open.value = false; }
      Vue.watch(open, syncParent);
      if (global.matchMedia) {
        try {
          global.matchMedia("(max-width: 860px)").addEventListener("change", (ev) => {
            open.value = !ev.matches; // 进手机档→收起；回桌面→展开
          });
        } catch (e) { /* 老内核无 change 事件：保持挂载初态 */ }
      }

      /* ---------- 连接 ---------- */
      async function connect() {
        if (connecting.value) return;
        connecting.value = true;
        try {
          await store.l2Create();
          srvBroken.value = false;
        } catch (e) { /* store.l2.status=broken，ErrState 呈现 */ }
        finally { connecting.value = false; }
      }

      /* ---------- 发送 ---------- */
      async function send(t) {
        const text = String(t == null ? draft.value : t).trim();
        if (!text || L.sending || !L.sid) return;
        if (t == null) {
          draft.value = "";
          const el = document.querySelector(".v-copilot-input");
          if (el) el.style.height = "";
        }
        try { await store.l2Send(text, ctxChips()); } catch (e) { /* store 已 toast */ }
      }
      /* Enter 发送（中文输入法组词中的 Enter 不发送）；Shift+Enter 由浏览器默认换行 */
      function onEnter(e) {
        if (e && (e.isComposing || e.keyCode === 229)) return;
        send();
      }
      /* 自适应增高（3 行起步，封顶约 10 行） */
      function autoGrow(e) {
        const el = e && e.target;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 220) + "px";
      }

      /* ---------- 上下文芯片：创作路由内自动绑定当前集（发消息随行，助手就本集办事） ---------- */
      const ctxAuto = Vue.ref(true);
      const boundEp = Vue.computed(() => {
        const R = global.__ROUTER;
        const r = R && R.current;
        if (!ctxAuto.value || !r || !r.epId || !store.state) return null;
        const eps = store.state.episodes || {};
        const ep = Array.isArray(eps) ? eps.find(x => x.id === r.epId) : eps[r.epId];
        return ep ? { id: r.epId, title: ep.title || r.epId } : { id: r.epId, title: r.epId };
      });
      function clearCtx() { ctxAuto.value = false; store.toast("已解除本集上下文绑定"); }
      /* 切集自动换会话：会话历史是单集语境的——跨集继续聊会被旧剧上下文带跑（2026-11-21 用户实测） */
      Vue.watch(() => (boundEp.value && boundEp.value.id) || "", (nv, ov) => {
        if (nv && ov && nv !== ov && store.l2.status === "ready") {
          newSession().then(() => store.toast("已切换到本集上下文，开了新会话"));
        }
        /* 任务 hint 数据源：绑定集的 jobs 拉一次，此后 SSE jobs 事件自动保持新鲜 */
        if (nv) store.loadJobs(nv).catch(() => {});
      });

      /* ---------- P2 主动性 hint（蓝图 §3.6）：新待拍板卡主动递可点的下一步 ----------
         数据源＝/state cards_pending（卡流事件自动刷新）；只对绑定集推（无绑定不打扰）；
         切集基线静默（已存在的卡不回灌提醒），会话生命周期内按卡 ID 去重；
         hint 是组件内本地横幅（不进会话落账），点选项走既有通路（send 走治理链/href 导航）。 */
      const hints = Vue.ref([]);
      const seenCardIds = new Set();
      const baselined = Vue.ref(false);
      const boundPending = Vue.computed(() => {
        const b = boundEp.value;
        if (!b || !store.state) return [];
        return (store.state.cards_pending || []).filter(c => c && c.episodeId === b.id);
      });
      Vue.watch(boundPending, (list) => {
        const b = boundEp.value;
        if (!b) return;
        if (!baselined.value) { list.forEach(c => seenCardIds.add(c.id)); baselined.value = true; return; }
        let fresh = 0;
        list.forEach(c => {
          if (seenCardIds.has(c.id)) return;
          seenCardIds.add(c.id);
          const meta = CARD_CN[c.type] || { name: c.type + "卡", next: "拍板后下游才好走" };
          hints.value.push({
            id: c.id,
            text: "📌 新卡待拍板：" + meta.name + "——" + meta.next,
            options: [
              { label: "看看待拍板的卡", send: "看看待拍板的卡" },
              { label: "去卡流页", href: "#/ep/" + encodeURIComponent(b.id) + "/flow" }
            ]
          });
          fresh++;
        });
        while (hints.value.length > 2) hints.value.shift();
        if (fresh) store.toast("有新卡等你拍板", "warn");
      });
      Vue.watch(() => (boundEp.value && boundEp.value.id) || "", () => { hints.value = []; baselined.value = false; seenRqIds.clear(); reviewBaselined.value = false; });
      /* 复审事件 hint：复审台出现新 ⚠ 待复审镜头（经 shots_by_episode 归属到绑定集）——
         单槽位（数量变化就更新文案），基线静默同卡流 hint。 */
      const seenRqIds = new Set();
      const reviewBaselined = Vue.ref(false);
      const boundReviews = Vue.computed(() => {
        const b = boundEp.value;
        if (!b || !store.state) return [];
        const shots = (store.state.shots_by_episode || {})[b.id] || [];
        const ids = new Set(shots.map(s => s.id));
        return (store.state.review_pending || []).filter(r => r && ids.has(r.shotId));
      });
      Vue.watch(boundReviews, (list) => {
        if (!boundEp.value) return;
        if (!reviewBaselined.value) { list.forEach(r => seenRqIds.add(r.id)); reviewBaselined.value = true; return; }
        let fresh = 0;
        list.forEach(r => { if (!seenRqIds.has(r.id)) { seenRqIds.add(r.id); fresh++; } });
        if (!fresh) return;
        const n = list.length;
        hints.value = hints.value.filter(h => h.id !== "review");
        hints.value.push({
          id: "review",
          text: "📌 " + n + " 个镜头待复审——建议先处理 ⚠ 密集的那场，批复完镜头才放行",
          options: [
            { label: "去复审台", href: "#/review" },
            { label: "查本集现在到哪一步了", send: "本集现在到哪一步了" }
          ]
        });
        while (hints.value.length > 2) hints.value.shift();
        store.toast("有镜头待复审", "warn");
      });
      /* 任务完成/失败 hint（蓝图 §3.6 最后一格）：绑定集 jobs 状态面（SSE 自动保鲜）——
         失败→去拍摄页处理；全部拍完→导出成片。签名去重＋首次基线静默，单槽位替换。 */
      const seenJobSig = Vue.ref("");
      const boundJobs = Vue.computed(() => {
        const b = boundEp.value;
        if (!b || store.jobs.epId !== b.id || !Array.isArray(store.jobs.list)) return null;
        const l = store.jobs.list;
        return {
          total: l.length,
          failed: l.filter(j => j.status === "failed").length,
          done: l.filter(j => j.status === "done").length,
          active: l.filter(j => j.status === "queued" || j.status === "running").length
        };
      });
      Vue.watch(boundJobs, (q) => {
        const b = boundEp.value;
        if (!q || !b || q.total === 0) return;
        const sig = q.total + "/" + q.done + "/" + q.failed;
        const prev = seenJobSig.value;
        if (sig === prev) return;
        seenJobSig.value = sig;
        if (prev === "") return; // 首次基线静默
        if (q.failed > 0) {
          hints.value = hints.value.filter(h => h.id !== "jobs");
          hints.value.push({
            id: "jobs",
            text: "📌 " + q.failed + " 个任务失败——多半在渲染侧，先去拍摄页看失败原因",
            options: [
              { label: "去拍摄页处理", href: "#/ep/" + encodeURIComponent(b.id) + "/shoot" },
              { label: "查本集现在到哪一步了", send: "本集现在到哪一步了" }
            ]
          });
          store.toast("有任务失败", "warn");
        } else if (q.done >= q.total && q.active === 0) {
          hints.value = hints.value.filter(h => h.id !== "jobs");
          hints.value.push({
            id: "jobs",
            text: "📌 本集镜头全部拍完——下一步是导出成片（会出确认票）",
            options: [
              { label: "导出成片", send: "导出成片" },
              { label: "去复审台看看", href: "#/review" }
            ]
          });
          store.toast("本集镜头拍完了", "warn");
        }
      });
      function dismissHint(h) { hints.value = hints.value.filter(x => x !== h); }
      function hintOpt(h, o) {
        if (!h || !o) return;
        dismissHint(h);
        if (o.tab) { tab.value = String(o.tab); return; }
        if (o.href) { global.location.hash = String(o.href); return; }
        if (o.send) send(String(o.send));
      }

      function ctxChips() {
        const b = boundEp.value;
        return b ? [{ type: "episode", id: b.id }] : [];
      }

      /* ---------- 快捷芯片：贴场景推导，不再写死句（2026-11-22） ----------
         数据源全是现成状态面：/state 的 cards_pending（卡流事件自动刷新）、/api/gpu 的 5s 轮询、
         剧集 driver。芯片只描述「此刻状态」——待拍板/进度/被挡/成本，不写死剧名镜号，
         换任何剧都成立；每条都落在助手真有的工具上（只读优先）：
         「重出一版」这类拍板动作绝不进芯片——拍板权在人，助手只引路。 */
      const epObj = Vue.computed(() => {
        const b = boundEp.value;
        if (!b || !store.state) return null;
        const eps = store.state.episodes || {};
        return (Array.isArray(eps) ? eps.find(x => x.id === b.id) : eps[b.id]) || null;
      });
      const penCards = Vue.computed(() => {
        const all = (store.state && store.state.cards_pending) || [];
        const b = boundEp.value;
        return b ? all.filter(c => c && c.episodeId === b.id) : all;
      });
      const gpuBlocked = Vue.computed(() => {
        const e = epObj.value;
        return !!((!e || e.driver !== "dgx") && store.gpu && store.gpu.data && store.gpu.data.gpu_busy);
      });
      const CHIPS = Vue.computed(() => {
        const out = [];
        const b = boundEp.value;
        if (penCards.value.length) out.push("看看待拍板的卡");
        if (b) {
          out.push("本集现在到哪一步了");
          if (gpuBlocked.value) out.push("为什么开机拍摄被挡了");
          out.push("这集拍完要多久多少钱");
        } else {
          const pjs = (store.state && store.state.projects) || {};
          if (Object.keys(pjs).length) {
            out.push("看看有哪些项目");
            out.push("最近的剧集进展怎么样");
          } else {
            out.push("帮我新建一部剧");
          }
        }
        if (out.length < 4) out.push("成本花了多少");
        return out.slice(0, 4);
      });

      /* ---------- 会话管理：新会话 / 历史会话切换 ---------- */
      const menuOpen = Vue.ref(false);
      const histOpen = Vue.ref(false);
      const histList = Vue.ref([]);
      async function openHist() {
        histOpen.value = !histOpen.value;
        if (!histOpen.value) return;
        try {
          const r = await T.api.get("/l2/sessions");
          histList.value = T.sanitizeDeep((r.sessions || []).filter(x => (x.msgs && x.msgs.length) || x.id === L.sid).slice(-14).reverse());
        } catch (e) { store.toast(T.humanErr(e).text, "err"); }
      }
      function histSnip(h) {
        const ms = h.msgs || [];
        if (!ms.length) return "空会话";
        return T.sanitize(String((ms[ms.length - 1] || {}).t || "").slice(0, 18)) || "（空）";
      }
      function histTs(h) {
        const ms = h.msgs || [];
        return (ms.length && ms[ms.length - 1].ts) || h.created_at || null;
      }
      async function loadSession(id) {
        try { await store.l2Resume(id); histOpen.value = false; } catch (e) { store.toast(T.humanErr(e).text, "err"); }
      }
      async function newSession() {
        try { await store.l2Create(L.mode); histOpen.value = false; store.toast("已开新会话"); }
        catch (e) { /* store 已 toast */ }
      }

      /* ---------- 消息复制 ---------- */
      function copyMsg(m) {
        const txt = String((m && m.t) || "");
        try {
          navigator.clipboard.writeText(txt).then(
            () => store.toast("已复制"),
            () => store.toast("复制失败", "err")
          );
        } catch (e) { store.toast("复制失败", "err"); }
      }

      /* ---------- Esc 关闭（手机档）＋ 打开自动聚焦 ---------- */
      global.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { menuOpen.value = false; if (isMobile() && open.value) closeRail(); }
      });
      Vue.watch(open, (v) => {
        if (v && isMobile()) Vue.nextTick(() => {
          const ta = document.querySelector(".v-copilot-input");
          if (ta) ta.focus();
        });
      });

      /* ---------- 移动端软键盘避让（visualViewport） ---------- */
      Vue.onMounted(() => {
        const vv = global.visualViewport;
        const aside = rootEl.value && rootEl.value.closest ? rootEl.value.closest(".app-rail") : null;
        if (!vv || !aside) return;
        const onR = () => {
          try { aside.style.bottom = Math.max(0, global.innerHeight - vv.height) + "px"; } catch (e) { /* 忽略 */ }
        };
        vv.addEventListener("resize", onR);
        Vue.onUnmounted(() => { try { vv.removeEventListener("resize", onR); } catch (e) { /* 忽略 */ } });
      });

      /* ---------- 8s 全量兜底（SSE 已增量；合并以服务端为准） ---------- */
      async function syncFull() {
        const sid = L.sid;
        if (!sid || !store.auth.token) return;
        let s = null;
        try {
          const r = await T.api.get("/l2/sessions/" + encodeURIComponent(sid));
          s = r && r.session;
        } catch (e) {
          if (e && (e.status === 404 || e.code === "NOT_FOUND")) {
            /* 会话在服务端没了（如重启清账）→ 回到可重连态 */
            L.sid = null; L.status = "idle";
            L.msgs = []; L.tasks = []; L.approvals = [];
            srvBroken.value = false;
          }
          return; /* 其它错误静默：SSE 是主通道，下轮再试 */
        }
        if (!s || String(s.id) !== String(sid)) return;
        mergeSession(s);
      }

      function mergeSession(s) {
        /* —— msgs：服务端为准；me 方向按「有无署名」归一（见顶部 BACKEND-ISSUE）。
              本地最后一条 streaming 中的助手气泡若服务端尚未落账，则保留续流。 —— */
        const localLast = L.msgs.length ? L.msgs[L.msgs.length - 1] : null;
        const keep = localLast && localLast.me === 0 && localLast.streaming ? localLast : null;
        const norm = (s.msgs || []).map(m => ({
          me: m && m.sig ? 0 : 1,
          t: (m && m.t) || "",
          ts: m && m.ts,
          sig: (m && m.sig) || null,
          runtime: (m && m.runtime) || null,
          denied: !!(m && m.denied),
          card: (m && m.card) ? T.sanitizeDeep(m.card) : null
        }));
        let dropKeep = false;
        if (keep) {
          const kt = keep.t || "";
          dropKeep = norm.some(x =>
            x.me === 0 && x.t && kt &&
            (x.t === kt || x.t.indexOf(kt) >= 0 || (x.t.length >= 8 && kt.indexOf(x.t) === 0))
          );
        }
        const out = keep && !dropKeep ? norm.concat([keep]) : norm;
        L.msgs = T.sanitizeDeep(out);

        /* —— tasks：服务端为准；SSE tool_call 的瞬态行（服务端不持久化、仍在跑）保留 —— */
        const sTasks = s.tasks || [];
        const seen = {};
        sTasks.forEach(t => { seen[String(t.id)] = true; });
        const ephemeral = L.tasks.filter(t =>
          t.toolCallId && !seen[String(t.id)] && (t.status === "queued" || t.status === "running")
        );
        L.tasks = T.sanitizeDeep(sTasks.concat(ephemeral));

        /* —— approvals：服务端为准，只留展示字段（token/hash 不进界面） —— */
        L.approvals = T.sanitizeDeep((s.approvals || []).map(a => ({
          id: a.id, tool: a.tool, args: a.args, est: a.est,
          status: a.status, ttl_until: a.ttl_until, ver: a.ver, created_at: a.created_at
        })));

        if (typeof s.used_cents === "number") L.used_cents = s.used_cents;
        if (typeof s.budget_cents === "number") L.budget_line = s.budget_cents;
        srvBroken.value = !!s.broken;
      }

      let pollTimer = null, tickTimer = null;
      Vue.onMounted(() => {
        installBridge();
        syncParent();
        pollTimer = setInterval(() => { syncFull().catch(() => {}); }, 8000);
        tickTimer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
      });
      Vue.onUnmounted(() => {
        clearInterval(pollTimer);
        clearInterval(tickTimer);
      });

      /* 新消息滚到底 */
      Vue.watch(
        () => L.msgs.length + ":" + ((L.msgs[L.msgs.length - 1] || {}).t || "").length,
        () => {
          Vue.nextTick(() => {
            const el = bodyEl.value;
            if (el) el.scrollTop = el.scrollHeight;
          });
        }
      );

      /* ---------- 展示辅助 ---------- */
      const sseOff = Vue.computed(() => store.conn.sse === "off" && !!store.auth.token);
      const budgetPct = Vue.computed(() => {
        const line = Number(L.budget_line);
        if (!Number.isFinite(line) || line <= 0) return 0;
        return Math.min(100, Math.round((Number(L.used_cents) || 0) / line * 100));
      });
      const budgetOver = Vue.computed(() => Number(L.used_cents) > Number(L.budget_line));

      function isPending(a) { return String(a.status || "pending") === "pending"; }
      function isExpired(a) {
        return isPending(a) && a.ttl_until != null && a.ttl_until <= nowTick.value;
      }
      const pendingCount = Vue.computed(() =>
        (L.approvals || []).filter(a => isPending(a) && !isExpired(a)).length
      );
      const apvSorted = Vue.computed(() => {
        const arr = (L.approvals || []).slice();
        arr.sort((a, b) =>
          (isPending(a) ? 0 : 1) - (isPending(b) ? 0 : 1) ||
          (Number(b.ttl_until) || 0) - (Number(a.ttl_until) || 0)
        );
        return arr;
      });

      function msgCls(m) { return { me: !!m.me, ai: !m.me, denied: !!m.denied }; }
      function toolTxt(tool) {
        const k = String(tool || "");
        return TOOL_CN[k] || T.sanitize(k) || "动作";
      }
      function itemCls(a) { return { "v-copilot-expired": isExpired(a) }; }
      function apvStatus(a) {
        const st = String(a.status || "pending");
        if (st === "pending") return isExpired(a) ? { cls: "badge", txt: "已过期" } : { cls: "badge-warn", txt: "等你确认" };
        if (st === "approved") return { cls: "badge-ok", txt: "已批准" };
        if (st === "rejected") return { cls: "badge", txt: "已驳回" };
        if (st === "budget_blocked") return { cls: "badge-err", txt: "被预算拦下" };
        if (st === "expired") return { cls: "badge", txt: "已过期" };
        return { cls: "badge", txt: T.sanitize(st) };
      }
      function ttlTxt(a) {
        if (!isPending(a) || a.ttl_until == null) return "";
        const left = Math.ceil((a.ttl_until - nowTick.value) / 1000);
        return left > 0 ? "剩 " + left + " 秒" : "已过期";
      }
      function canDecide(a) { return isPending(a) && !isExpired(a) && !busyId.value; }
      function estCents(a) { return a.est && a.est.cents != null ? a.est.cents : null; }
      function estTime(a) {
        if (!a.est) return null;
        const v = a.est.time_min != null ? a.est.time_min : a.est.time;
        return v == null ? null : v;
      }
      async function decide(a, decision) {
        if (busyId.value) return;
        busyId.value = String(a.id);
        try { await store.l2Decide(a.id, decision); } catch (e) { /* store 已 toast */ }
        finally { busyId.value = ""; }
      }

      /* ---------- 顾问卡交互（2026-11-22）：选项点了就走既有通路 ----------
         send＝把那句话发进会话（interpret→gate→审批全治理链照走，无旁路）；
         href＝hash 路由跳转（直达卡流页/成本页/运维台）；tab＝助手栏内切页。
         卡是一次性的：点过即收起，防重复触发；提问卡不嵌输入框，用户在主输入框直接答。
         「点过」记在组件级 Set（消息签名），8s 全量合并重建消息数组也不会复活。 */
      const usedCards = new Set();
      function cardKey(m) { return (m && m.ts || 0) + ":" + String((m && m.t) || "").slice(0, 16); }
      function isUsed(m) { return usedCards.has(cardKey(m)); }
      function pickOpt(m, o) {
        if (!m || !m.card || !o) return;
        usedCards.add(cardKey(m));
        if (o.tab) { tab.value = String(o.tab); return; }
        if (o.href) { global.location.hash = String(o.href); return; }
        if (o.send) { send(String(o.send)); return; }
      }

      return {
        store, L, tab, draft, connecting, busyId, srvBroken, rootEl, bodyEl, onEnter, autoGrow, boundEp, clearCtx, menuOpen, histOpen, histList, openHist, loadSession, newSession, copyMsg, histSnip, histTs,
        CHIPS, open, toggleFab, closeRail, isMobile,
        connect, send, sseOff, budgetPct, budgetOver,
        pendingCount, apvSorted, msgCls, toolTxt, itemCls, apvStatus, ttlTxt,
        canDecide, estCents, estTime, decide, pickOpt, isUsed, hints, dismissHint, hintOpt,
        fmtArgsStatic: fmtArgs,
        clean: T.sanitize, rel: T.relTime
      };
    },
    template: `
      <div class="rail" :class="{ open: open }" ref="rootEl">
        <div class="v-copilot-sticky">
          <div class="v-copilot-head">
            <div class="row">
              <span class="v-copilot-title">🤝 制片助手</span>
              <span class="badge" v-if="L.sid">{{ L.mode === 'B' ? 'B · 本机内置' : 'A · 云端托管' }}</span>
              <span class="chip chip-sel v-copilot-bind" v-if="boundEp" @click="clearCtx" title="点击解除本集绑定">📌 {{ clean(boundEp.title) }} ✕</span>
              <span class="grow"></span>
              <button class="v-copilot-kebab" @click="menuOpen = !menuOpen" aria-label="会话操作" :aria-expanded="menuOpen ? 'true' : 'false'">⋯</button>
              <span class="v-copilot-close" v-if="isMobile()" @click="closeRail">✕</span>
            </div>
          </div>
          <div class="v-copilot-menu" v-if="menuOpen">
            <button class="v-copilot-menu-item" @click="newSession">＋ 新会话</button>
            <button class="v-copilot-menu-item" @click="openHist">{{ histOpen ? '收起历史' : '历史会话' }}</button>
            <button class="v-copilot-menu-item" v-if="boundEp" @click="clearCtx">解除本集绑定</button>
          </div>
          <div class="v-copilot-hist" v-if="histOpen">
            <div class="v-copilot-hist-item" v-for="h in histList" :key="h.id" @click="loadSession(h.id)">
              <span class="badge">{{ h.mode === 'B' ? 'B' : 'A' }}</span>
              <span class="grow v-copilot-hist-snip">{{ histSnip(h) }}</span>
              <span class="weak">{{ (h.msgs || []).length }} 条 · {{ rel(histTs(h)) }}</span>
            </div>
            <div class="weak v-copilot-hist-empty" v-if="!histList.length">还没有历史会话</div>
          </div>
          <div class="v-copilot-off" v-if="sseOff">实时断了，重连中</div>

          <div class="v-copilot-tabwrap">
            <div class="rail-tabs">
              <button :class="{ on: tab === 'chat' }" @click="tab = 'chat'">对话</button>
              <button :class="{ on: tab === 'tasks' }" @click="tab = 'tasks'">任务</button>
              <button :class="{ on: tab === 'apv' }" @click="tab = 'apv'">审批<i class="v-copilot-badge" v-if="pendingCount">{{ pendingCount }}</i></button>
            </div>
          </div>

          <!-- 对话 -->
          <template v-if="tab === 'chat'">
            <div class="v-copilot-body" ref="bodyEl" v-if="L.sid">
              <!-- P2 主动性 hint：新待拍板卡的本地横幅（一次性，点选项或 ✕ 收起） -->
              <div class="v-copilot-hints" v-if="hints.length">
                <div class="v-copilot-hint" v-for="h in hints" :key="h.id">
                  <div class="row">
                    <span class="grow v-copilot-hint-t">{{ h.text }}</span>
                    <button class="v-copilot-hint-x" @click="dismissHint(h)" aria-label="收起提醒">✕</button>
                  </div>
                  <div class="row wrap">
                    <button class="chip" v-for="(o, j) in h.options" :key="j" @click="hintOpt(h, o)">{{ o.label }}</button>
                  </div>
                </div>
              </div>
              <div class="v-copilot-warn" v-if="srvBroken">这个会话已被预算护栏掐断，助手暂不代办动作。</div>
              <div class="loading" v-if="!L.msgs.length && L.sending"><i></i><i></i><i></i></div>
              <empty-state v-else-if="!L.msgs.length" icon="💬" text="跟制片助手说点什么"
                sub="问进度、问成本、重拍某镜、给某场配配乐，都能开口。"></empty-state>
              <div v-for="(m, i) in L.msgs" :key="i" class="v-copilot-msg" :class="msgCls(m)">
                <div class="v-copilot-txt">{{ m.t }}<i class="v-copilot-caret" v-if="m.streaming">▍</i></div>
                <!-- 顾问卡：选项（点了执行/跳转）／提问（主输入框直接答）；一次性，点过即收 -->
                <div class="v-copilot-mcard" v-if="m.card && !isUsed(m)">
                  <div class="v-copilot-mcard-q" v-if="m.card.question">❓ {{ m.card.question }}</div>
                  <button v-for="(o, j) in (m.card.options || [])" :key="j" class="v-copilot-mopt"
                    @click="pickOpt(m, o)">{{ o.label }}<span class="v-copilot-mopt-hint" v-if="o.hint"> · {{ o.hint }}</span></button>
                </div>
                <div class="v-copilot-meta" v-if="m.sig || m.runtime || m.ts">
                  <span class="badge" v-if="m.sig">{{ clean(m.sig) }}</span>
                  <span class="badge" v-if="m.runtime">{{ clean(m.runtime) }}</span>
                  <span class="weak">{{ rel(m.ts) }}</span>
                  <button class="v-copilot-copy" @click="copyMsg(m)" title="复制全文">⧉</button>
                </div>
              </div>
            </div>

            <div class="v-copilot-connect" v-else>
              <err-state v-if="L.status === 'broken' && L.error" :err="L.error" :on-retry="connect"></err-state>
              <empty-state v-else icon="🤝" text="还没连上制片助手"
                sub="连上之后，问进度、催重拍、配配乐都在这里一句话的事。">
                <button class="btn btn-primary" :disabled="connecting" :aria-busy="connecting" @click="connect"
                  style="margin-top:10px;">
                  {{ connecting ? '连接中…' : '连接制片助手' }}
                </button>
              </empty-state>
            </div>

            <div class="v-copilot-foot" v-if="L.sid">
              <div class="row wrap v-copilot-chips">
                <button class="chip" v-for="(c, i) in CHIPS" :key="i" :disabled="L.sending" @click="send(c)">{{ c }}</button>
              </div>
              <div class="row v-copilot-inrow">
                <textarea class="input grow v-copilot-input" v-model="draft" :disabled="L.sending" rows="3"
                  placeholder="问进度、问成本、让它去办…（Enter 发送，Shift+Enter 换行）"
                  @keydown.enter.exact.prevent="onEnter" @input="autoGrow"></textarea>
                <div class="v-copilot-side">
                  <span class="v-copilot-sending" v-if="L.sending"><i></i><i></i><i></i></span>
                  <button class="btn btn-primary" :disabled="L.sending || !draft.trim()" @click="send()">发送</button>
                </div>
              </div>
            </div>
          </template>

          <!-- 任务 -->
          <div class="v-copilot-body" v-else-if="tab === 'tasks'">
            <div class="list" v-if="L.tasks.length">
              <div class="list-item" v-for="t in L.tasks" :key="t.id">
                <div class="row">
                  <span class="grow">{{ clean(t.label) }}</span>
                  <status-dot :status="t.status"></status-dot>
                </div>
                <div class="weak" v-if="t.shot">涉及镜头 <span class="mono">{{ t.shot }}</span></div>
              </div>
            </div>
            <empty-state v-else class="v-copilot-empty-tasks" icon="📋" text="还没有代办任务"
              sub="让助手去重拍、出配乐候选，任务会列在这里。"></empty-state>
          </div>

          <!-- 审批 -->
          <div class="v-copilot-body" v-else>
            <div class="list" v-if="apvSorted.length">
              <div class="list-item" v-for="a in apvSorted" :key="a.id" :class="itemCls(a)">
                <div class="row">
                  <span class="grow card-title">{{ toolTxt(a.tool) }}</span>
                  <span class="badge" :class="apvStatus(a).cls">{{ apvStatus(a).txt }}</span>
                </div>
                <div class="weak v-copilot-args">{{ fmtArgsStatic(a.args) }}</div>
                <div class="row">
                  <span class="weak">预估</span><money :cents="estCents(a)"></money>
                  <span class="weak" v-if="estTime(a) !== null">· 约 <b class="num">{{ estTime(a) }}</b> 分钟</span>
                  <span class="v-copilot-ttl" v-if="ttlTxt(a)">{{ ttlTxt(a) }}</span>
                </div>
                <div class="row" v-if="canDecide(a)">
                  <button class="btn btn-primary btn-sm" :disabled="busyId === String(a.id)"
                    @click="decide(a, 'approve')">批准</button>
                  <button class="btn btn-danger btn-sm" :disabled="busyId === String(a.id)"
                    @click="decide(a, 'reject')">驳回</button>
                </div>
              </div>
            </div>
            <empty-state v-else class="v-copilot-empty-tasks" icon="✅" text="没有等你确认的动作"
              sub="助手要花真金白银的活儿都会先来这张单里排队。"></empty-state>
          </div>
        </div>

        <teleport to="body">
          <button v-show="!open" class="rail-fab" @click="toggleFab" aria-label="打开制片助手">🤖</button>
        </teleport>
      </div>`
  };
})(window);
