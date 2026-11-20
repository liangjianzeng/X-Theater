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

  const CHIPS = ["今天哪几个镜头没过", "最新预估", "重拍 #7", "给场2换段配乐"];

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
        try { await store.l2Send(text); } catch (e) { /* store 已 toast */ }
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
          denied: !!(m && m.denied)
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

      return {
        store, L, tab, draft, connecting, busyId, srvBroken, rootEl, bodyEl, onEnter, autoGrow,
        CHIPS, open, toggleFab, closeRail, isMobile,
        connect, send, sseOff, budgetPct, budgetOver,
        pendingCount, apvSorted, msgCls, toolTxt, itemCls, apvStatus, ttlTxt,
        canDecide, estCents, estTime, decide,
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
              <span class="v-copilot-close" v-if="isMobile()" @click="closeRail">✕</span>
            </div>
          </div>

          <div class="v-copilot-off" v-if="sseOff">实时断了，重连中</div>

          <div class="v-copilot-budgetrow" v-if="L.sid">
            <div class="row">
              <span class="weak">本会话已用</span><money :cents="L.used_cents"></money>
              <span class="weak">/ 预算</span><money :cents="L.budget_line"></money>
            </div>
            <div class="progress v-copilot-budget" :class="{ over: budgetOver }">
              <div class="bar"><span :style="{ width: budgetPct + '%' }"></span></div>
            </div>
          </div>

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
              <div class="v-copilot-warn" v-if="srvBroken">这个会话已被预算护栏掐断，助手暂不代办动作。</div>
              <div class="loading" v-if="!L.msgs.length && L.sending"><i></i><i></i><i></i></div>
              <empty-state v-else-if="!L.msgs.length" icon="💬" text="跟制片助手说点什么"
                sub="问进度、问成本、重拍某镜、给某场配配乐，都能开口。"></empty-state>
              <div v-for="(m, i) in L.msgs" :key="i" class="v-copilot-msg" :class="msgCls(m)">
                <div class="v-copilot-txt">{{ m.t }}<i class="v-copilot-caret" v-if="m.streaming">▍</i></div>
                <div class="v-copilot-meta" v-if="m.sig || m.runtime || m.ts">
                  <span class="badge" v-if="m.sig">{{ clean(m.sig) }}</span>
                  <span class="badge" v-if="m.runtime">{{ clean(m.runtime) }}</span>
                  <span class="weak">{{ rel(m.ts) }}</span>
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
          <button class="rail-fab" @click="toggleFab" aria-label="打开制片助手">🤖</button>
        </teleport>
      </div>`
  };
})(window);
