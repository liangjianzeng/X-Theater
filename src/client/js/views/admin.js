/* 剧场 Studio · 运维台视图（视图 B：admin） */
// BACKEND-ISSUE: 骨架 store.loadAlerts() 走 POST /api/admin/alerts/simulate —— 每次加载都会新写 3 条
//   「演练」告警并广播（无 GET 列表端点）。本视图因此只在点「载入系统告警」时才调用，避免反复写入。
//   期望：提供 GET /api/admin/alerts 只读列表。
// BACKEND-ISSUE: rules/quant.js decide 只接受硬规则序 nvfp4→int8→MXFP8+FP8 内的档位（registryEntry.tiers
//   缺省时不认 published 里的已发布档，如 Q5_K_M / UD-Q4_K_XL / fp16 → 409 QUANT_RULE）。本视图下拉按契约
//   「published∪兜底档位」给出选项，选中规则外档位会收到 409 复述提示。期望：decide 认 published∪规则序。
// BACKEND-ISSUE: 骨架 store.loadRegistry 的 sanitizeDeep 会把 published/quant/endpoint 里的档位串与
//   ComfyUI/SGLang 等词一并消毒成「生成引擎」——「已发布/不可用档」列因此显示残缺串，且若把消毒值回写
//   服务端会永久污染注册表。本视图已规避：调档下发只用未被消毒的原始档位；段位巡检改从 T.api.get 取原始
//   endpoint 下发（仅请求载荷，不上界面）。期望：注册表数据豁免深度消毒或后端提供未消毒的 tier/endpoint 字段。
(function (global) {
  "use strict";
  const T = global.__T;
  const store = T.store;
  const Vue = global.Vue;
  const views = (global.__VIEWS = global.__VIEWS || {});

  const TIER_ORDER = ["nvfp4", "int8", "MXFP8+FP8"];
  const TIER_CN = {
    "nvfp4": "极速档", "int8": "均衡档", "mxfp8+fp8": "兜底档",
    "q5_k_m": "高画质档", "ud-q4_k_xl": "高画质档",
    "fp16": "原精度档", "fp8": "半精度档", "n/a": "固定档"
  };
  function tierKey(t) { return String(t == null ? "" : t).trim().toLowerCase(); }
  function tierLabel(t) { return TIER_CN[tierKey(t)] || String(t == null ? "" : t) || "—"; } // 豁免面：未知名显原值

  const ALERT_KIND_CN = {
    queue_stall: "队列疑似卡死", budget_warn: "预算护栏预警", engine_unavail: "引擎不可达"
  };
  const ACTION_CN = {
    login: "登录", logout: "登出",
    review_decide: "复审处置",
    card_accept: "卡片拍板", card_edit: "卡片改稿", card_reject: "卡片重出一版",
    episode_create: "新建剧集",
    quant_change: "段位调档", quant_fallback: "兜底降级留痕", quant_reject: "调档被规则拦下",
    endpoint_change: "端点变更", model_change: "模型变更",
    export: "导出成片", shoot: "开机拍摄",
    alerts_simulate: "告警巡检触发",
    music_adopt: "配乐挂接", music_candidates: "配乐候选生成", music_regenerate: "配乐重出",
    episode_driver_switch: "剧集驱动切换", llm_config_update: "LLM 档案更新", llm_node_switch: "LLM 承载节点切换", l2_gpu_yield: "助手 GPU 让路", llm_stop: "停止 LLM 让路",
    job_retry: "任务重试", job_stop: "任务叫停"
  };
  function actionCn(a) {
    const key = String(a == null ? "" : a).trim().toLowerCase();
    return ACTION_CN[key] || T.sanitize(a || "—");
  }

  views.Admin = {
    components: {
      "err-state": T.components.ErrState,
      "empty-state": T.components.EmptyState,
      "loading": T.components.Loading,
      "time-ago": T.components.TimeAgo
    },
    template: `
      <div class="v-admin">
        <div class="panel">
        <div class="panel-title">🖥 节点驱动 <span class="weak">每部剧选渲染节点＋LLM 模型档案</span></div>
        <div class="kv" v-if="nodesState.data">
          <div class="kv-row"><span>LLM 大脑</span>
            <span class="grow">{{ nodesState.data.llm.online ? ("在线 · " + (nodesState.data.llm.model || "已配置")) : (nodesState.data.llm.base ? "离线（配置了但没连上）" : "未配置") }}</span>
            <span class="badge" :class="nodesState.data.llm.online ? 'badge-ok' : 'badge-warn'">{{ nodesState.data.llm.online ? "在线" : "离线" }}</span></div>
          <div class="kv-row" v-for="nd in nodesState.data.nodes" :key="nd.id">
            <span class="grow"><b>{{ nd.label }}</b>
              <span class="weak" v-if="nd.comfy && nd.comfy.base">· 渲染 {{ nd.comfy.base }}</span>
              <span class="badge badge-ok" v-if="nd.is_llm_host">LLM 承载</span></span>
            <span class="weak" v-if="nd.llm && nd.llm.base">LLM {{ nd.llm.model || "—" }}</span>
            <button class="btn btn-sm" v-if="!nd.is_llm_host" @click="switchLlmNode(nd.id)">让 LLM 落在这个节点</button>
          </div>
          <div class="kv-row" v-for="(nd, ni) in (nodesState.data.nodes || []).filter(n => n.is_llm_host || n.id === 'dgx')" :key="'llmform' + ni">
            <span class="grow weak">「{{ nd.label }}」LLM 档案</span>
            <input class="input" style="max-width:220px" v-model.trim="nd.llm.base" placeholder="http://127.0.0.1:8090" />
            <input class="input" style="max-width:160px" v-model.trim="nd.llm.model" placeholder="模型别名" />
            <button class="btn btn-sm btn-primary" :disabled="nodesState.savingLlm" @click="saveLlm(nd)">保存</button>
          </div>
          <hr class="sep" />
          <div class="kv-row" v-for="ep in (nodesState.data.episodes || [])" :key="ep.id">
            <span class="grow"><b>{{ ep.title }}</b> <span class="weak">{{ ep.id }}</span></span>
            <select class="select" style="max-width:150px" :value="ep.driver" :disabled="nodesState.savingEp === ep.id" @change="switchDriver(ep, $event.target.value)">
              <option value="local">本机 5060 Ti</option>
              <option value="dgx">DGX H3 全家桶</option>
            </select>
          </div>
        </div>
        <loading v-else-if="nodesState.loading"></loading>
        <err-state v-else-if="nodesState.err" :err="nodesState.err" :on-retry="loadNodes" compact></err-state>
      </div>

      <div class="panel">
          <div class="panel-title">引擎段位注册表
            <span class="badge" v-if="data && data.langlint_exempt">语言表豁免面</span>
            <button class="btn btn-ghost btn-sm" @click="probeAll" :disabled="probing" :aria-busy="probing">
              {{ probing ? '巡检中…' : '段位巡检' }}</button>
            <button class="btn btn-ghost btn-sm" @click="reload" :aria-busy="loading">刷新</button>
          </div>
          <loading v-if="loading && !data"></loading>
          <err-state v-else-if="err && !data" :err="err" :on-retry="reload"></err-state>
          <empty-state v-else-if="data && !rows.length" icon="🛠" text="注册表还是空的"
            sub="引擎段位登记后会出现在这里"></empty-state>
          <div class="table-scroll" v-else-if="rows.length">
          <table class="table">
            <thead>
              <tr>
                <th>段位</th><th>引擎</th><th>量化档</th><th>泳道</th><th>端点</th>
                <th>已发布</th><th>不可用档</th><th class="v-admin-probe-cell">巡检</th><th>调档</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="x in rows" :key="x.id">
                <td class="mono">{{ raw(x.id) }}</td>
                <td>{{ raw(x.engine) }}</td>
                <td><span class="badge">{{ tierLabel(x.tier || x.quant) }}</span></td>
                <td class="weak">{{ raw(x.lane) }}</td>
                <td class="weak mono">{{ raw(x.endpoint) }}</td>
                <td>
                  <span class="badge badge-ok" v-for="(p, i) in (x.published || [])" :key="i"
                    style="margin-right:4px">{{ tierLabel(p) }}</span>
                  <span class="muted" v-if="!(x.published && x.published.length)">—</span>
                </td>
                <td>
                  <span class="badge badge-err" v-for="(u, i) in (x.unavail || [])" :key="i"
                    style="margin-right:4px">{{ tierLabel(u) }}</span>
                  <span class="muted" v-if="!(x.unavail && x.unavail.length)">—</span>
                </td>
                <td class="v-admin-probe-cell">
                  <span class="v-admin-dot stat st-ok" v-if="ui[x.id] && ui[x.id].probe === 'ok'"><i></i>可达</span>
                  <span class="v-admin-dot stat st-err" v-else-if="ui[x.id] && ui[x.id].probe === 'err'"><i></i>不通</span>
                  <span class="v-admin-dot stat st-run" v-else-if="ui[x.id] && ui[x.id].probe === 'busy'"><i></i>试探</span>
                  <span class="muted" v-else>未检</span>
                </td>
                <td>
                  <div class="row wrap" v-if="ui[x.id]">
                    <select class="select v-admin-select" v-model="ui[x.id].tier">
                      <option v-for="(t, i) in tierOptions(x)" :key="i" :value="t">{{ tierLabel(t) }}</option>
                    </select>
                    <input class="input v-admin-reason" v-model.trim="ui[x.id].reason"
                      placeholder="调档理由（兜底档必填）" />
                    <button class="btn btn-sm" :disabled="ui[x.id].busy" :aria-busy="ui[x.id].busy"
                      @click="applyQuant(x)">调档</button>
                    <span class="badge badge-warn" v-if="ui[x.id].last && ui[x.id].last.audit_needed">
                      审计号 <b class="num">{{ ui[x.id].last.audit_id }}</b></span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>

        <div class="grid2">
          <div class="panel">
            <div class="panel-title">系统告警
              <button class="btn btn-ghost btn-sm" @click="loadAlerts" :aria-busy="alertsLoading">载入系统告警</button>
            </div>
            <div class="weak" v-if="!alerts">点「载入系统告警」对队列、预算护栏、引擎可达性做一轮巡检。</div>
            <loading v-else-if="alertsLoading && !alerts.length"></loading>
            <empty-state v-else-if="alerts && !alerts.length" icon="🔔" text="暂无告警" sub="系统各通道都安静"></empty-state>
            <div class="list" v-else-if="alerts">
              <div class="list-item" v-for="a in alerts" :key="a.id">
                <div class="row wrap">
                  <span class="badge" :class="a.kind === 'budget_warn' ? 'badge-err' : 'badge-warn'">
                    {{ alertKind(a.kind) }}</span>
                  <span class="muted"><time-ago :ts="a.ts"></time-ago></span>
                </div>
                <div class="card-sub">{{ hs(a.msg) }}</div>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-title">审计流水（最近 50 条）
              <button class="btn btn-ghost btn-sm" @click="loadAuditRows" :aria-busy="auditLoading">刷新</button>
            </div>
            <loading v-if="auditLoading && !auditRows"></loading>
            <empty-state v-else-if="auditRows && !auditRows.length" icon="📜" text="还没有审计流水"
              sub="登录、调档、导出等动作都会留痕在这里"></empty-state>
            <div class="table-scroll" v-else-if="auditRows">
            <table class="table">
              <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>留痕</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in auditRows" :key="r.id || i">
                  <td class="muted mono">{{ fmtTime(r.ts) }}</td>
                  <td>{{ r.operator ? hs(r.operator) : '系统' }}</td>
                  <td>{{ actionCn(r.action) }}</td>
                  <td class="mono weak">{{ hs(r.target) }}</td>
                  <td class="weak">
                    <span v-if="r.tier">{{ tierLabel(r.tier) }}</span>
                    <span v-if="r.decision"> · {{ decisionCn(r.decision) }}</span>
                    <span v-if="r.audit_id"> · 审计号 <b class="num">{{ r.audit_id }}</b></span>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>`,
    setup() {
      const probing = Vue.ref(false);
      const auditLoading = Vue.ref(false);
      const alertsLoading = Vue.ref(false);
      const ui = Vue.reactive({});

      const rows = Vue.computed(() => {
        const d = store.registry.data;
        const reg = (d && d.registry) || {};
        return Object.keys(reg).map(id => Object.assign({ id }, reg[id]));
      });
      /* store 层 sanitizeDeep 会把 nvfp4/Q5_K_M 等档位串消毒成「生成引擎」；
         这类残缺串不可作为下发值，下拉只保留原始档位＋硬规则序常量 */
      function rawTier(t) {
        const s = String(t == null ? "" : t).trim();
        return s && !/生成引擎/.test(s) && /^[\x20-\x7e]+$/.test(s) ? s : "";
      }
      function tierOptions(x) {
        const cur = rawTier(x.tier) || rawTier(x.quant);
        const src = (Array.isArray(x.published) ? x.published : []).concat(TIER_ORDER, cur ? [cur] : []);
        const seen = {}; const out = [];
        src.forEach(t => {
          const v = rawTier(t);
          if (!v) return;
          const k = tierKey(v);
          if (seen[k]) return;
          seen[k] = 1; out.push(v);
        });
        return out;
      }

      /* 每行局部 UI 状态（下拉选择/理由/巡检结果/最近一次裁决） */
      Vue.watch(rows, list => {
        list.forEach(x => {
          if (!ui[x.id]) {
            const opts = tierOptions(x);
            const cur = rawTier(x.tier) || rawTier(x.quant);
            ui[x.id] = { tier: cur || opts[0] || "", reason: "", busy: false, probe: "", last: null };
          }
        });
      }, { immediate: true });

      async function applyQuant(x) {
        const u = ui[x.id];
        if (!u || u.busy) return;
        const tier = String(u.tier || "").trim();
        const reason = String(u.reason || "").trim();
        const cur = rawTier(x.tier) || rawTier(x.quant);
        if (!tier) { store.toast("先选择要切到的档位", "warn"); return; }
        if (tierKey(tier) === tierKey(cur)) { store.toast("这个段位已经在这档上", "warn"); return; }
        if (tierKey(tier) === "mxfp8+fp8" && !reason) {
          store.toast("切到兜底档必须写明理由（要留审计号）", "warn"); return;
        }
        u.busy = true;
        try {
          const r = await store.setQuant(x.id, tier, reason);
          u.last = r || null;
          u.reason = "";
        } catch (e) { /* store 已 toast 人话 */ }
        finally { u.busy = false; }
      }

      async function probeAll() {
        if (probing.value) return;
        probing.value = true;
        /* store 数据已消毒，直接回写会污染端点；取原始注册表用于下发（仅请求载荷，不上界面） */
        let raw = {};
        try { const r = await T.api.get("/admin/registry"); raw = (r && r.registry) || {}; }
        catch (e) { /* 拿不到就退回行内值 */ }
        try {
          for (const x of rows.value) {
            const u = ui[x.id];
            if (u) u.probe = "busy";
            const endpoint = (raw[x.id] && raw[x.id].endpoint) || x.endpoint;
            try { await store.probeEngine(x.id, endpoint); if (u) u.probe = "ok"; }
            catch (e) { if (u) u.probe = "err"; }
          }
        } finally { probing.value = false; }
      }

      function loadAlerts() {
        alertsLoading.value = true;
        Promise.resolve(store.loadAlerts())
          .catch(() => {})
          .finally(() => { alertsLoading.value = false; });
      }
      function loadAuditRows() {
        auditLoading.value = true;
        Promise.resolve(store.loadAudit())
          .catch(() => {})
          .finally(() => { auditLoading.value = false; });
      }
      function reload() { return store.loadRegistry().catch(() => {}); }

      Vue.onMounted(() => {
        reload();
        if (!store.registry.audit) loadAuditRows();
      });

      /* ---- 节点驱动配置（llm-gw 配套） ---- */
      const nodesState = Vue.reactive({ data: null, loading: false, err: null, savingEp: "", savingLlm: false });
      async function loadNodes() {
        nodesState.loading = true; nodesState.err = null;
        try { nodesState.data = await T.api.get("/nodes"); } catch (e) { nodesState.err = e; }
        finally { nodesState.loading = false; }
      }
      async function switchDriver(ep, driver) {
        nodesState.savingEp = ep.id;
        try {
          await T.api.put("/nodes/episodes/" + encodeURIComponent(ep.id) + "/driver", { driver });
          store.toast("「" + ep.title + "」驱动已切到 " + (driver === "dgx" ? "DGX 节点" : "本机节点"));
          await loadNodes();
        } catch (e) { store.toast(T.humanErr(e).text, "err"); }
        finally { nodesState.savingEp = ""; }
      }
      async function saveLlm(node) {
        nodesState.savingLlm = true;
        try {
          await T.api.put("/nodes/llm", { base: node.llm.base, model: node.llm.model });
          store.toast("LLM 档案已保存（热生效）");
          await loadNodes();
        } catch (e) { store.toast(T.humanErr(e).text, "err"); }
        finally { nodesState.savingLlm = false; }
      }
      async function switchLlmNode(id) {
        try {
          await T.api.put("/nodes/llm-node", { node: id });
          store.toast("LLM 承载节点已切到 " + id);
          await loadNodes();
        } catch (e) { store.toast(T.humanErr(e).text, "err"); }
      }
      Vue.onMounted(() => { loadNodes().catch(() => {}); });


      return {
        data: Vue.computed(() => store.registry.data),
        loading: Vue.computed(() => store.registry.loading),
        err: Vue.computed(() => store.registry.error),
        rows, ui, probing, auditLoading, alertsLoading,
        alerts: Vue.computed(() => store.registry.alerts),
        auditRows: Vue.computed(() => {
          const a = store.registry.audit;
          return Array.isArray(a) ? a.slice(-50).slice().reverse() : null;
        }),
        reload, applyQuant, probeAll, loadAlerts, loadAuditRows, tierOptions,
        nodesState, loadNodes, switchDriver, saveLlm, switchLlmNode,
        tierLabel, actionCn,
        hs: s => T.sanitize(s),
        // 运维台注册表＝语言表豁免面：段位/引擎/泳道/端点显原值
        raw: s => String(s == null ? "" : s),
        alertKind: k => ALERT_KIND_CN[String(k || "").toLowerCase()] || T.sanitize(k || "告警"),
        decisionCn: d => ({ pass: "放行", reject: "打回", offline: "下架" })[String(d)] || T.sanitize(d),
        fmtTime: ts => T.fmtTime(ts)
      };
    }
  };
})(window);
