/* 剧场 Studio · 根应用（骨架文件） */
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const ROUTER = global.__ROUTER;
  const Vue = global.Vue;

  /* 启动：有 token 先验活（401→登出），无 token 去登录 */
  let gpuTimer = null;
  function startGpuPoll() {
    if (gpuTimer) return;
    store.loadGpu().catch(() => {});
    gpuTimer = setInterval(() => { if (store.auth.token) store.loadGpu().catch(() => {}); }, 5000);
  }

  async function boot() {
    if (store.auth.token) {
      try {
        await store.refreshState();
        store.auth.ready = true;
        store.connectSSE();
        if (!store.l2.sid) store.l2Resume().then(ok => { if (!ok) return store.l2Create().catch(() => { /* 副驾显示连接按钮 */ }); }).catch(() => { });
      } catch (e) {
        if (e.status === 401 || e.code === "UNAUTHORIZED") store.logout();
        store.auth.ready = true;
      }
    } else store.auth.ready = true;
    const cur = global.location.hash || "";
    if (!store.auth.token && cur !== "#/login") ROUTER.go("#/login");
    if (store.auth.token && (cur === "" || cur === "#/" || cur === "#/login")) ROUTER.go("#/home");
  }

  const App = {
    components: {
      "err-state": T.components.ErrState,
      "loading": T.components.Loading,
      "episode-bar": T.components.EpisodeBar
    },
    setup() {
      const route = Vue.ref(Object.assign({}, ROUTER.current));
      ROUTER.onChange(r => { route.value = Object.assign({}, r); });
      Vue.watch(() => store.auth.token, tok => {
        if (!tok && ROUTER.current.view !== "Login") ROUTER.go("#/login");
      });
      const viewComp = Vue.computed(() => {
        const name = route.value.view;
        if (name === "Login" || !store.auth.token) return "Login";
        return global.__VIEWS && global.__VIEWS[name] ? name : "Home";
      });
      const showNav = Vue.computed(() => viewComp.value !== "Login");
      const showRail = Vue.computed(() => viewComp.value !== "Login" && !!global.__VIEWS.Copilot);
      /* 集工作台路由（#/ep/:id/*）：骨架统一在 main 顶部渲染 EpisodeBar，各视图不再自带 */
      const EP_VIEWS = ["Flow", "Shoot", "Assets", "Deliver", "Costs"];
      const isEpRoute = Vue.computed(() => EP_VIEWS.indexOf(route.value.view) >= 0);
      const isOps = Vue.computed(() => store.auth.user && store.auth.user.role === "ops");
      const navBadge = Vue.computed(() => {
        const s = store.state;
        return {
          review: s && s.review_pending ? (Array.isArray(s.review_pending) ? s.review_pending.length : 0) : 0,
          cards: s && s.cards_pending ? (Array.isArray(s.cards_pending) ? s.cards_pending.length : Object.keys(s.cards_pending).length) : 0,
          alerts: s ? s.alerts_unacked : 0
        };
      });
      function closeSheet() { store.closeSheet(); }
      /* GPU/LLM 徽章：LLM 在线＝独显被占（生图/拍摄被挡），点开可「让路」 */
      const gpu = Vue.computed(() => store.gpu.data || null);
      const gpuText = Vue.computed(() => {
        const g = gpu.value;
        if (!g || !g.llm) return 'GPU 状态…';
        if (!g.llm.configured) return 'LLM 未配置';
        return g.llm.online ? '🧠 LLM 在线 · 拍摄被挡' : (g.comfy && g.comfy.online ? 'GPU 空闲 · LLM 离线' : 'GPU/LLM 离线');
      });
      const gpuCls = Vue.computed(() => {
        const g = gpu.value;
        return g && g.llm && g.llm.online ? 'gpu-on' : 'gpu-off';
      });
      function openGpu() {
        const g = gpu.value || { llm: {} };
        store.openSheet({
          title: 'GPU / 本机 LLM',
          rows: [
            'LLM：' + (g.llm && g.llm.online ? ('在线（' + (g.llm.model || '本机') + '）') : (g.llm && g.llm.configured ? '离线' : '未配置')),
            (g.comfy && g.comfy.online ? ('ComfyUI：在线 · 显存空闲 ' + (g.comfy.vram_free_mib || '?') + ' MiB / ' + (g.comfy.vram_total_mib || '?') + ' MiB') : 'ComfyUI：离线'),
            g.gpu_busy ? '16G 独显被 LLM 占用：生图/拍摄已挡，先让路。' : '生图/拍摄可用。'
          ].filter(Boolean),
          html: null,
          actions: [
            g.llm && g.llm.online ? { label: '停止 LLM 让路', kind: 'btn-danger', onClick: (close) => { store.stopLlm().catch(() => {}); close(); } } : null,
            { label: '知道了', kind: 'btn-ghost', onClick: (close) => close() }
          ].filter(Boolean)
        });
      }
      function act(a) { if (a && a.onClick) a.onClick(closeSheet); else closeSheet(); }
      /* 键盘：Esc 关 sheet */
      global.addEventListener("keydown", e => { if (e.key === "Escape" && store.sheet) closeSheet(); });
      return { store, route, viewComp, showNav, showRail, isEpRoute, isOps, navBadge, act, closeSheet, epId: Vue.computed(() => route.value.epId), gpu, gpuText, gpuCls, openGpu };
    },
    template: `
    <div class="app-shell" :class="{ 'no-rail': !showRail }">
      <aside class="app-nav" v-if="showNav">
        <div class="nav-brand"><span class="brand-mark">剧</span><b>剧场 Studio</b></div>
        <nav>
          <a class="nav-item" :class="{on: route.view==='Home'}" href="#/home">🏠 项目工作区</a>
          <a class="nav-item" :class="{on: route.view==='Review'}" href="#/review" v-if="isOps">🧐 复审台
            <span class="nav-badge" v-if="navBadge.review">{{ navBadge.review }}</span></a>
          <a class="nav-item" :class="{on: route.view==='Admin'}" href="#/admin" v-if="isOps">🛠 运维台
            <span class="nav-badge warn" v-if="navBadge.alerts">{{ navBadge.alerts }}</span></a>
          <a class="nav-item" :class="{on: route.view==='Settings'}" href="#/settings">⚙️ 设置</a>
        </nav>
        <div class="nav-foot">
          <div class="conn gpu-badge" :class="gpuCls" role="button" tabindex="0" @click="openGpu" @keydown.enter="openGpu" title="点击看 GPU/LLM 状态">
            <i></i>{{ gpuText }}
          </div>
          <div class="conn" :class="'conn-'+store.conn.sse">
            <i></i>{{ store.conn.sse==='on' ? '实时连接正常' : store.conn.sse==='connecting' ? '连接中…' : (store.conn.err || '实时连接已断') }}
          </div>
          <div class="who weak" v-if="store.auth.user">{{ store.auth.user.name }}
            <span class="badge">{{ store.auth.user.role==='ops' ? '运营' : '创作者' }}</span></div>
        </div>
      </aside>
      <main class="app-main">
        <episode-bar v-if="isEpRoute" :ep-id="epId"></episode-bar>
        <component :is="viewComp" :ep-id="epId" :key="route.view + (epId||'')"></component>
      </main>
      <aside class="app-rail" v-if="showRail"><component :is="'Copilot'"></component></aside>

      <!-- 全局模态 -->
      <div class="overlay" v-if="store.sheet" @click.self="closeSheet">
        <div class="sheet card">
          <div class="sheet-title">{{ store.sheet.title }}</div>
          <div class="kv num" v-if="store.sheet.rows && store.sheet.rows.length">
            <div v-for="r in store.sheet.rows" :key="r">{{ r }}</div>
          </div>
          <div class="sheet-body" v-if="store.sheet.html" v-html="store.sheet.html"></div>
          <div class="sheet-acts">
            <button v-for="(a,i) in store.sheet.actions" :key="i" class="btn"
              :class="a.kind || 'btn-ghost'" @click="act(a)">{{ a.label }}</button>
          </div>
        </div>
      </div>

      <!-- 全局 toast -->
      <div class="toastbar" v-if="store.toasts.length">
        <div class="toast" v-for="t in store.toasts" :key="t.id" :class="'toast-'+t.kind">{{ t.text }}</div>
      </div>
    </div>`
  };

  const app = Vue.createApp(App);
  // 注册全部视图组件（__VIEWS 由各 views/*.js 填充）
  const V = global.__VIEWS || {};
  for (const k in V) app.component(k, V[k]);
  app.config.errorHandler = (err) => {
    console.error("[studio]", err);
    try { store.toast("界面出了个异常（" + T.sanitize(err && err.message ? err.message : "未知") + "），已继续运行", "err"); } catch (e) {}
  };
  boot().finally(() => { app.mount("#app"); ROUTER.start(); startGpuPoll(); });
})(window);
