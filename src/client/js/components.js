/* 剧场 Studio · 共享组件 T.components（骨架文件，agent 勿改） */
(function (global) {
  "use strict";
  const T = global.__T;
  const C = (T.components = {});

  C.ErrState = {
    props: { err: Object, onRetry: Function, compact: Boolean },
    template: `
      <div class="err-state" :class="{compact}">
        <div class="es-icon">⚠️</div>
        <div class="es-text">{{ human.text }}</div>
        <div class="es-code mono" v-if="human.code && human.code!=='NETWORK'">{{ human.code }}</div>
        <button class="btn btn-ghost btn-sm" v-if="human.retriable && onRetry" @click="onRetry()">重试</button>
      </div>`,
    setup(props) {
      return { human: global.Vue.computed(() => T.humanErr(props.err)) };
    }
  };

  C.EmptyState = {
    props: { icon: String, text: String, sub: String },
    template: `
      <div class="empty">
        <div class="em-icon">{{ icon || '🗂' }}</div>
        <div class="em-text">{{ text }}</div>
        <div class="em-sub weak" v-if="sub">{{ sub }}</div>
        <slot></slot>
      </div>`
  };

  /* 一期全自部署：不存在「价格」——所有成本数字＝内部成本核算单位「分」（影子记账，非收费）。
     付费 API（二期托管/商业档）接入后，付费面才显示实付货币。 */
  C.Money = {
    props: { cents: [Number, String] },
    template: `<b class="num">{{ txt }}</b>`,
    setup(props) { return { txt: global.Vue.computed(() => T.fmtFen(props.cents)) }; }
  };

  C.TimeAgo = {
    props: { ts: [Number, String] },
    template: `<span class="muted">{{ txt }}</span>`,
    setup(props) { return { txt: global.Vue.computed(() => T.relTime(props.ts)) }; }
  };

  const JOB_CN = {
    queued: ["排队中", "q"], pending: ["排队中", "q"], running: ["进行中", "run"],
    done: ["完成", "ok"], ok: ["完成", "ok"], completed: ["完成", "ok"],
    failed: ["失败", "err"], error: ["失败", "err"], cancelled: ["已取消", "err"],
    needs_reroll: ["待重拍", "warn"], reroll: ["待重拍", "warn"],
    stale: ["需重做", "warn"], pending_review: ["待复审", "warn"],
    moderating: ["机审中", "run"], shooting: ["拍摄中", "run"],
    storyboarded: ["已分镜", "q"], adopted: ["已采用", "ok"]
  };
  C.StatusDot = {
    props: { status: String },
    template: `<span class="stat" :class="'st-'+k"><i></i>{{ cn }}</span>`,
    setup(props) {
      const f = global.Vue.computed(() => JOB_CN[String(props.status || "").toLowerCase()] || [T.sanitize(props.status || "—"), "q"]);
      return { cn: global.Vue.computed(() => f.value[0]), k: global.Vue.computed(() => f.value[1]) };
    }
  };

  C.LicenseBadge = {
    props: { license: Object },
    template: `<span class="badge" :class="ok ? 'badge-ok' : 'badge-err'">{{ txt }}</span>`,
    setup(props) {
      const ok = global.Vue.computed(() => !props.license || String(props.license.usage || "ok") === "ok");
      return {
        ok,
        txt: global.Vue.computed(() => ok.value ? "双许可齐 ✓" : "使用权缺失")
      };
    }
  };

  C.Loading = {
    template: `<div class="loading"><i></i><i></i><i></i></div>`
  };

  /* 集工作台顶栏（tabs 由各路由提供） */
  C.EpisodeBar = {
    props: { epId: String },
    template: `
      <div class="ep-head" v-if="ep">
        <div class="col">
          <div class="ep-title">{{ ep.title }}</div>
          <div class="ep-meta muted">
            阶段 {{ ep.stage }} · 人工决策 <b class="num">{{ ep.decisions || 0 }}</b>/5 ·
            成本 <money :cents="ep.cost_cents"></money> / 预算 <money :cents="ep.budget_cents"></money>
          </div>
        </div>
        <nav class="ep-tabs">
          <a v-for="t in tabs" :key="t.key" :href="href(t.key)" :class="{active: tab===t.key}">{{ t.label }}</a>
        </nav>
      </div>
      <div class="ep-head" v-else>
        <div class="col"><div class="ep-title muted">载入中…</div></div>
      </div>`,
    components: { money: C.Money },
    setup(props) {
      const store = T.store;
      const ep = global.Vue.computed(() => {
        const s = store.state;
        return s && s.episodes && (Array.isArray(s.episodes) ? s.episodes.find(e => e.id === props.epId) : s.episodes[props.epId]);
      });
      const tabs = [
        { key: "flow", label: "创作卡流" }, { key: "shoot", label: "拍摄" },
        { key: "assets", label: "资产/音乐" }, { key: "deliver", label: "交付" }, { key: "costs", label: "成本" }
      ];
      return {
        ep, tabs,
        href: k => global.__ROUTER.ep(k, props.epId),
        tab: global.Vue.computed(() => (global.__ROUTER.current.view || "").toLowerCase().replace("assets", "assets"))
      };
    }
  };
})(window);
