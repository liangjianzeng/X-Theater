/* 剧场 Studio · 首页视图（视图 C 负责）
   #/home 项目工作区：项目卡（风格包）＋集列表（阶段/决策/成本进度）＋新建集。
   数据全部来自 store.state（GET /api/state），无任何本地拼数据。 */
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  /* state 里的 projects 是 map、episodes 实测是数组（契约允许两种）——统一成数组 */
  function toList(x) {
    if (Array.isArray(x)) return x.filter(v => v && typeof v === "object");
    if (x && typeof x === "object") {
      return Object.keys(x).map(k =>
        x[k] && typeof x[k] === "object" ? Object.assign({ id: k }, x[k]) : { id: k }
      );
    }
    return [];
  }

  const ProjectEmpty = {
    components: { "empty-state": T.components.EmptyState },
    template: `
      <div class="panel">
        <empty-state icon="🎬" text="还没有项目"
          sub="新项目由运营在后台开通；开通后刷新这里就能看到。"></empty-state>
      </div>`
  };

  views.Home = {
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "loading": T.components.Loading,
      "money": T.components.Money,
      "project-empty": ProjectEmpty
    },
    setup() {
      const state = Vue.computed(() => store.state);
      const err = Vue.computed(() => store.err.state);
      const bootLoading = Vue.computed(() => store.loading.state && !store.state);
      const projects = Vue.computed(() => toList(state.value && state.value.projects));
      const episodes = Vue.computed(() => toList(state.value && state.value.episodes));

      function epsOf(pid) {
        return episodes.value.filter(e => String(e.projectId) === String(pid));
      }
      function retry() { store.refreshState().catch(() => {}); }

      function costPct(e) {
        const b = Number(e && e.budget_cents);
        const c = Number(e && e.cost_cents) || 0;
        if (!Number.isFinite(b) || b <= 0) return 0;
        return Math.min(100, Math.round((c / b) * 100));
      }
      function costOver(e) {
        const b = Number(e && e.budget_cents);
        return Number.isFinite(b) && b > 0 && Number(e.cost_cents) > b;
      }
      /* 集行状态色（纯展示映射）：1 灰起步 / 2–3 蓝推进 / 4–5 黄待交付 / ≥6 绿完成 / 暂停红 */
      function epTone(e) {
        if (!e) return "dim";
        if (e.paused) return "err";
        const st = Number(e.stage) || 0;
        if (st >= 6) return "ok";
        if (st >= 4) return "warn";
        if (st >= 2) return "run";
        return "dim";
      }
      function epHref(tab, id) {
        return "#/ep/" + encodeURIComponent(id) + "/" + tab;
      }

      /* ---------- 新建集 ---------- */
      const form = Vue.reactive({ projectId: "", title: "", brief: "" });
      const busy = Vue.ref(false);
      const formErr = Vue.ref(null);
      Vue.watch(projects, ps => {
        if (!form.projectId && ps.length) form.projectId = String(ps[0].id);
      }, { immediate: true });

      async function submit() {
        if (busy.value) return;
        if (!form.projectId) { store.toast("先选一个项目", "warn"); return; }
        if (!String(form.title || "").trim()) { store.toast("给集起个标题", "warn"); return; }
        if (!String(form.brief || "").trim()) { store.toast("写一句话故事（必填）", "warn"); return; }
        busy.value = true;
        formErr.value = null;
        try {
          const ep = await store.createEpisode({
            projectId: form.projectId,
            title: String(form.title).trim(),
            brief: String(form.brief).trim()
          });
          const id = ep && ep.id;
          if (id) global.__ROUTER.go("#/ep/" + encodeURIComponent(id) + "/flow");
        } catch (e) {
          formErr.value = e;
        } finally {
          busy.value = false;
        }
      }

      return {
        store, state, err, bootLoading, projects, episodes,
        epsOf, retry, costPct, costOver, epTone, epHref,
        form, busy, formErr, submit
      };
    },
    template: `
      <div class="v-home">

        <loading v-if="bootLoading && !err"></loading>
        <div class="panel" v-else-if="err">
          <err-state :err="err" :on-retry="retry"></err-state>
        </div>

        <template v-else-if="state">
          <project-empty v-if="!projects.length"></project-empty>

          <div class="panel" v-for="p in projects" :key="p.id">
            <div class="v-home-proj">
              <span class="card-title">{{ p.title }}</span>
              <span class="badge" v-if="p.style_pkg && p.style_pkg.look">{{ p.style_pkg.look }}</span>
              <span class="badge" v-if="p.style_pkg && p.style_pkg.palette">配色 {{ p.style_pkg.palette }}</span>
              <span class="badge" v-if="p.style_pkg && p.style_pkg.ratio">{{ p.style_pkg.ratio }}</span>
            </div>

            <div class="list" v-if="epsOf(p.id).length">
              <div class="list-item v-home-ep" v-for="e in epsOf(p.id)" :key="e.id">
                <div class="row wrap">
                  <span class="v-home-epdot" :class="epTone(e)"></span>
                  <b>{{ e.title }}</b>
                  <span class="badge v-home-stage" :class="epTone(e)">阶段 {{ e.stage == null ? '—' : e.stage }}</span>
                  <span class="badge badge-warn" v-if="e.paused">已暂停</span>
                  <span class="weak">人工决策 <b class="num">{{ e.decisions || 0 }}</b>/5</span>
                  <span class="grow"></span>
                  <a class="btn btn-primary btn-sm" :href="epHref('flow', e.id)">进工作台</a>
                  <a class="btn btn-sm" :href="epHref('shoot', e.id)">拍摄</a>
                </div>
                <div class="v-home-cost">
                  <money :cents="e.cost_cents"></money>
                  <span class="weak">/ 预算</span>
                  <money :cents="e.budget_cents"></money>
                  <div class="progress" :class="{ over: costOver(e) }">
                    <div class="bar"><span :style="{ width: costPct(e) + '%' }"></span></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="weak" v-else>这个项目还没有集，用下方表单开一集。</div>
          </div>

          <div class="panel">
            <div class="panel-title">🎬 新建集 <span class="weak">建完直接进卡流</span></div>
            <form class="v-home-form" @submit.prevent="submit">
              <label class="field">
                <span class="field-label">项目</span>
                <select class="select" v-model="form.projectId">
                  <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ p.title }}</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">集标题</span>
                <input class="input" v-model.trim="form.title" placeholder="例：第 2 集 · 灯塔之约" />
              </label>
              <label class="field v-home-brief">
                <span class="field-label">一句话故事（必填）</span>
                <textarea class="textarea" rows="3" v-model.trim="form.brief"
                  placeholder="例：雨夜，她在灯塔下和十年前出走的母亲和解。"></textarea>
              </label>
              <div class="v-home-acts">
                <button class="btn btn-primary" type="submit" :disabled="busy" :aria-busy="busy">
                  {{ busy ? '创建中…' : '创建并进卡流' }}
                </button>
                <loading v-if="busy"></loading>
                <err-state v-if="formErr" :err="formErr" :on-retry="submit" compact></err-state>
              </div>
            </form>
          </div>
        </template>
      </div>`
  };
})(window);
