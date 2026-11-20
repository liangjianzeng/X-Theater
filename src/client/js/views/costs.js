/* 剧场 Studio · 成本视图（视图 B：costs） */
// BACKEND-ISSUE: GET /api/episodes/:id/costs 的镜级行不透出引擎档位（takes[].engine 未随账本返回），
//   本页「产出档」列暂以账本条目 kind 人话化代替；期望后端在 shots[] 内补 engine/tier 字段。
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  const KIND_CN = {
    video: "视频条", music: "配乐", tts: "配音", compose: "成片合成",
    img: "图像", image: "图像", moderate: "机审", other: "其他"
  };
  function kindHuman(k) {
    const key = String(k == null ? "" : k).trim().toLowerCase();
    return KIND_CN[key] || T.sanitize(k || "其他");
  }
  function kindsOf(items) {
    if (!Array.isArray(items) || !items.length) return "—";
    const seen = [];
    items.forEach(it => {
      const h = kindHuman(it && it.kind);
      if (seen.indexOf(h) < 0) seen.push(h);
    });
    return seen.join("、");
  }

  views.Costs = {
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "loading": T.components.Loading,
      "money": T.components.Money,
      "status-dot": T.components.StatusDot
    },
    props: { epId: { type: String, required: true } },
    template: `
      <div class="v-costs">
        <loading v-if="loading && !data"></loading>
        <err-state v-else-if="err && !data" :err="err" :on-retry="reload"></err-state>

        <template v-else-if="data">
          <div class="stat-cards">
            <div class="stat-card">
              <span class="stat-lab">已花（账本合计）</span>
              <money :cents="data.total_cents"></money>
            </div>
            <div class="stat-card">
              <span class="stat-lab">已记账</span>
              <money :cents="data.cost_cents"></money>
            </div>
            <div class="stat-card">
              <span class="stat-lab">预算
                <span class="badge badge-err" v-if="data.paused">已自动暂停</span>
              </span>
              <money :cents="data.budget_cents"></money>
              <template v-if="pct != null">
                <div class="progress" :class="{ over: overFlag }">
                  <div class="bar"><span :style="{ width: barW + '%' }"></span></div>
                </div>
                <span class="stat-sub">已记账占预算 <b class="num">{{ pct }}%</b><span v-if="overFlag"> · 已超支</span></span>
              </template>
            </div>
          </div>

          <div class="panel">
            <div class="panel-title">镜头账本 <span class="weak">「分」＝内部成本核算（影子记账·非收费）；付费 API 档才显示实付价格</span>
              <span class="weak" v-if="overFlag">已超预算，超支会触发自动暂停；差额见 Σ 对账行</span>
              <span class="weak" v-else>账本与记账差额见 Σ 对账行</span>
              <button class="btn btn-ghost btn-sm" @click="showBilling" :aria-busy="billingLoading">影子账本全量</button>
            </div>
            <empty-state v-if="!shots.length" icon="💰" text="本集还没有镜头账目"
              sub="开机开拍后，每条产出的影子成本会逐条记在这里"></empty-state>
            <div class="table-scroll" v-else>
              <table class="table">
                <thead>
                  <tr><th>镜名</th><th>状态</th><th>拍摄条</th><th>产出档</th><th class="ta-r">成本</th></tr>
                </thead>
                <tbody>
                  <tr v-for="s in shots" :key="s.shotId">
                    <td><span class="mono muted">{{ s.seq }}.</span> {{ hs(s.name) }}</td>
                    <td><status-dot :status="s.status"></status-dot></td>
                    <td><b class="num">{{ s.takes }}</b></td>
                    <td class="weak">{{ kindsOf(s.items) }}</td>
                    <td class="ta-r"><money :cents="s.cents"></money></td>
                  </tr>
                  <tr v-for="(c, i) in common" :key="'cm' + i" class="v-costs-common">
                    <td class="weak">{{ hs(c.name) || '非镜头级（集级公共）' }}</td>
                    <td class="weak">公共项</td>
                    <td class="weak">—</td>
                    <td class="weak">{{ kindsOf(c.items) }}</td>
                    <td class="ta-r"><money :cents="c.cents"></money></td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td><b>Σ 对账</b></td>
                    <td></td><td></td>
                    <td class="weak">记账 <b class="num">{{ fen(data.cost_cents) }}</b></td>
                    <td class="ta-r"><money :cents="data.total_cents"></money></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div class="panel" v-if="billingShown">
            <div class="panel-title">影子账本全量（最近 40 行）
              <span class="weak" v-if="billingRows">共 <b class="num">{{ billingTotal }}</b> 行 ·
                合计 <money :cents="billingCents"></money></span>
              <button class="btn btn-ghost btn-sm" @click="showBilling" :aria-busy="billingLoading">刷新</button>
            </div>
            <loading v-if="billingLoading && !billingRows"></loading>
            <err-state v-else-if="billingErr" :err="billingErr" :on-retry="showBilling"></err-state>
            <empty-state v-else-if="billingRows && !billingRows.length" icon="🧾" text="账本还是空的"
              sub="有产出后每一笔影子成本都会落在这里"></empty-state>
            <div class="table-scroll" v-else-if="billingRows">
              <table class="table">
                <thead><tr><th>类型</th><th class="ta-r">金额</th><th>执行方</th><th>时间</th></tr></thead>
                <tbody>
                  <tr v-for="r in billingRows" :key="r.id">
                    <td>{{ kindHuman(r.kind) }}</td>
                    <td class="ta-r"><money :cents="r.cents"></money></td>
                    <td class="weak">{{ workerHuman(r.worker_type) }}</td>
                    <td class="muted mono">{{ fmtTime(r.ts) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </div>`,
    setup(props) {
      const billingShown = Vue.ref(false);

      function reload() { return store.loadCosts(props.epId).catch(() => {}); }
      Vue.onMounted(() => {
        if (!store.state) store.refreshState().catch(() => {});
        reload();
      });
      function showBilling() { billingShown.value = true; store.loadBilling().catch(() => {}); }

      const pct = Vue.computed(() => {
        const d = store.costs.data;
        if (!d) return null;
        const b = Number(d.budget_cents) || 0;
        if (b <= 0) return null;
        return Math.round((Number(d.cost_cents) || 0) / b * 100);
      });
      const overFlag = Vue.computed(() => pct.value != null && pct.value > 100);
      const barW = Vue.computed(() => (pct.value == null ? 0 : Math.min(100, pct.value)));

      return {
        data: Vue.computed(() => store.costs.data),
        loading: Vue.computed(() => store.costs.loading),
        err: Vue.computed(() => store.costs.error),
        shots: Vue.computed(() => (store.costs.data && store.costs.data.shots) || []),
        common: Vue.computed(() => (store.costs.data && store.costs.data.common) || []),
        pct, overFlag, barW,
        billingShown,
        billingRows: Vue.computed(() => {
          const r = store.billing.rows;
          return Array.isArray(r) ? r.slice(-40).slice().reverse() : null;
        }),
        billingTotal: Vue.computed(() => store.billing.total || 0),
        billingCents: Vue.computed(() => store.billing.cents || 0),
        billingLoading: Vue.computed(() => store.billing.loading),
        billingErr: Vue.computed(() => store.billing.error),
        reload, showBilling,
        hs: s => T.sanitize(s),
        kindsOf,
        kindHuman,
        workerHuman: w => (w == null || w === "" ? "—" : T.sanitize(String(w))),
        fmtTime: ts => T.fmtTime(ts),
        fen: c => T.fmtFen(c)
      };
    }
  };
})(window);
