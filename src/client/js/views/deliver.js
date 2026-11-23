/* 剧场 Studio · 交付视图（视图 B：deliver） */
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  const FILE_EXT_RE = /\.(mp4|mov|webm|mkv|mp3|wav|json|txt|srt|vtt|csv|jpg|jpeg|png)$/i;

  /* 产物归一：兼容 job.art 字符串、{art,path} 袋、数组、{文件名: 路径} 映射 */
  function normArtifacts(raw) {
    const list = [];
    function add(name, src) {
      const nm = String(name == null ? "" : name).split(/[\\/]/).pop() || "产物";
      let href = null;
      const s = String(src || name || "");
      if (/^https?:\/\//i.test(s)) href = s;
      else if (/[\\/]/.test(s) || FILE_EXT_RE.test(s)) href = "/" + s.replace(/^\/+/, "");
      list.push({ name: nm, href });
    }
    function one(x) {
      if (x == null) return;
      if (typeof x === "string") { add(x, x); return; }
      if (typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach(one); return; }
      const p = x.art || x.path || x.url || x.file || null;
      if (p) { add(x.name || p, p); return; }
      const keys = Object.keys(x);
      keys.forEach(k => { if (x[k] != null) add(k, String(x[k])); });
    }
    one(raw);
    return list;
  }

  function statusCn(s) {
    const k = String(s || "").toLowerCase();
    if (k === "done") return "合成完成";
    if (k === "failed" || k === "error" || k === "cancelled" || k === "canceled") return "合成失败";
    if (k === "queued" || k === "pending") return "排队中";
    return "进行中";
  }

  views.Deliver = {
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "loading": T.components.Loading
    },
    props: { epId: { type: String, required: true } },
    template: `
      <div class="v-deliver">
        <div class="panel" v-if="delivered">
          <div class="panel-title">成片（已交付）
            <span class="badge" :class="delivered.placeholder ? 'badge-warn' : 'badge-ok'">
              {{ delivered.placeholder ? '占位·套件模式' : '已出货 ✓' }}</span>
          </div>
          <div class="col" style="align-items:center">
            <video controls preload="metadata" :src="delivered.href"
              style="max-height:60vh;max-width:100%;background:#000;border-radius:8px"></video>
          </div>
          <div class="row wrap" style="margin-top:6px;justify-content:center">
            <span class="muted mono">{{ delivered.name }}</span>
            <span class="muted" v-if="delivered.info">{{ delivered.info }}</span>
            <span class="muted" v-if="delivered.at">交付于 {{ delivered.at }}</span>
          </div>
          <div class="row" style="margin-top:6px;justify-content:center">
            <a class="btn btn-primary btn-sm" :href="delivered.href" download>下载成片</a>
            <a class="btn btn-ghost btn-sm" :href="delivered.href" target="_blank" rel="noopener">打开</a>
            <a class="btn btn-ghost btn-sm" :href="delivered.metaHref" target="_blank" rel="noopener">元数据</a>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">交付预检
            <span class="badge" :class="allGreen ? 'badge-ok' : 'badge-warn'" v-if="pre">
              {{ allGreen ? '全绿 ✓' : '存在拦截项' }}</span>
            <button class="btn btn-primary btn-sm" @click="runPrecheck"
              :disabled="preBusy" :aria-busy="preBusy">{{ preBusy ? '检查中…' : '跑预检' }}</button>
          </div>
          <err-state v-if="preErr" :err="preErr" :on-retry="runPrecheck"></err-state>
          <loading v-else-if="preBusy && !pre"></loading>
          <empty-state v-else-if="!pre" icon="🧪" text="还没跑过预检"
            sub="点右上角「跑预检」，五项全绿才允许导出成片"></empty-state>
          <div v-else>
            <div class="v-deliver-item" v-for="(it, i) in pre.items" :key="i">
              <span class="v-deliver-mark" :class="it.pass ? 'v-deliver-ok' : 'v-deliver-no'">{{ it.pass ? '✓' : '✗' }}</span>
              <div class="grow col">
                <b>{{ hs(it.item) }}</b>
                <span class="weak">{{ hs(it.note) }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">导出成片
            <button class="btn btn-primary" @click="doExport"
              :disabled="expBusy || !allGreen" :aria-busy="expBusy">{{ expBusy ? '导出中…' : '导出' }}</button>
          </div>
          <div class="weak" v-if="!allGreen">预检全绿才能导出：先跑预检并处理红色拦截项。</div>
          <err-state v-if="expErr" :err="expErr"></err-state>
          <div v-if="expErr" class="row" style="justify-content:center">
            <button class="btn btn-ghost btn-sm" @click="runPrecheck">重跑预检</button>
          </div>
          <div v-if="done" class="col">
            <div class="row wrap">
              <span class="badge" :class="done.status === 'failed' ? 'badge-err' : done.pending ? 'badge-warn' : 'badge-ok'">{{ statusCn(done.status) }}</span>
              <span class="muted mono" v-if="done.jobId">任务 {{ done.jobId }}</span>
            </div>
            <div class="weak" v-if="done.pending">合成任务已排队，产物出来后再刷新本页即可看到。</div>
            <div class="weak" v-if="done.status === 'failed'" style="color:var(--err)">{{ done.error || '合成任务失败，原因见任务详情' }}</div>
            <div v-if="done.items.length">
              <div class="card-sub" style="margin:6px 0 2px">产物清单</div>
              <div class="v-deliver-art" v-for="(a, i) in done.items" :key="i">
                <span class="mono">{{ a.name }}</span>
                <a v-if="a.href" class="btn btn-ghost btn-sm" :href="a.href" target="_blank" rel="noopener">打开</a>
                <span v-else class="muted">暂不提供直链</span>
              </div>
            </div>
          </div>
        </div>
      </div>`,
    setup(props) {
      const pre = Vue.ref(null);
      const preBusy = Vue.ref(false);
      const preErr = Vue.ref(null);
      const expBusy = Vue.ref(false);
      const expErr = Vue.ref(null);
      const done = Vue.ref(null);
      const allGreen = Vue.computed(() => !!(pre.value && pre.value.pass));
      // 成片随时可看（2026-11-23）：交付链接读 episode 持久字段（compose 出货时 cards 存库），
      // 不再依赖 engine 内存 jobs——重启后产物清单不再变空（床头情歌事故根因之二）。
      const delivered = Vue.computed(() => {
        const st = store.state;
        const eps = st && st.episodes;
        // /api/state 的 episodes 是数组——map 形态一并兼容
        const ep = Array.isArray(eps)
          ? eps.find((e) => e && e.id === props.epId)
          : eps && eps[props.epId];
        const art = ep && ep.final_art;
        if (!art) return null;
        const href = "/" + String(art).replace(/^\/+/, "");
        const m = ep.final_meta || {};
        return {
          name: String(art).split(/[\\/]/).pop(),
          href,
          metaHref: href + ".meta.json",
          placeholder: !!m.placeholder,
          at: m.delivered_at ? T.fmtTime(m.delivered_at) : null,
          info: [m.resolution, m.fps ? m.fps + "fps" : null].filter(Boolean).join(" · ") || null
        };
      });

      async function runPrecheck() {
        if (preBusy.value) return;
        preBusy.value = true; preErr.value = null;
        try {
          const r = await store.precheck(props.epId);
          pre.value = r;
          if (r && r.pass) store.toast("预检全绿，可以导出了");
          else store.toast("预检存在红色拦截项，先按清单处理", "warn");
        } catch (e) { preErr.value = e; pre.value = null; }
        finally { preBusy.value = false; }
      }
      async function doExport() {
        if (expBusy.value || !allGreen.value) return;
        expBusy.value = true; expErr.value = null;
        try {
          const r = await store.exportEpisode(props.epId);
          const status = (r && r.status) || "queued";
          done.value = {
            jobId: r && r.jobId,
            status,
            pending: !!(r && (r.pending || status !== "done")),
            items: normArtifacts(r && (r.artifacts != null ? r.artifacts : r.art))
          };
          if (done.value.items.length) store.toast("产物已就绪，列在下方清单");
        } catch (e) {
          expErr.value = e;
          if (e && e.code === "BLOCKED_PRECHECK") pre.value = null; // 预检结论已过期，强制重跑
        } finally { expBusy.value = false; }
      }

      Vue.onMounted(() => {
        if (!store.state) store.refreshState().catch(() => {});
        // 产物回收：本集已完成的导出合成（含刷新/SSE 后补取）
        store.loadJobs(props.epId).then(() => {
          const a = artifactsFromJobs();
          if (a && !done.value) done.value = a;
        }).catch(() => {});
      });
      function artifactsFromJobs() {
        const lst = store.jobs.list || [];
        const exp = lst
          .filter(j => /compose/i.test(String(j.type || "")) && j.payload && j.payload.purpose === "export")
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
        if (!exp) return null;
        const st = String(exp.status || "").toLowerCase();
        if (st === "failed" || st === "error" || st === "cancelled" || st === "canceled") {
          // 合成失败如实显示（真合成/占位都不再假成功，2026-11-23）
          return { jobId: exp.job_id || exp.id, status: "failed", pending: false, items: [], error: exp.error || null };
        }
        if (st !== "done") {
          return { jobId: exp.job_id || exp.id, status: st || "queued", pending: true, items: [] };
        }
        const art = exp.art || exp.result || null;
        return {
          jobId: exp.job_id || exp.id,
          status: "done",
          pending: false,
          items: normArtifacts(art && (art.artifacts != null ? art.artifacts : art))
        };
      }
      Vue.watch(() => store.jobs.list, () => {
        const a = artifactsFromJobs();
        if (a) done.value = a;
        // 导出合成完成 → 拉一次 state，让 cards 刚存库的 ep.final_art 立刻可见
        const lst = store.jobs.list || [];
        if (lst.some(j => /compose/i.test(String(j.type || "")) && j.payload && j.payload.purpose === "export" && String(j.status) === "done")) {
          store.refreshState().catch(() => {});
        }
      });

      return {
        pre, preBusy, preErr, expBusy, expErr, done, allGreen, delivered,
        runPrecheck, doExport,
        hs: s => T.sanitize(s),
        statusCn
      };
    }
  };
})(window);
