/* 剧场 Studio · 运维台视图（视图 B：admin）—— 2026-11-21 重构：顶部四 tab（算力节点/引擎段位/告警/审计） */
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
    node_comfy_update: "节点渲染端点更新", node_probe: "节点探测",
    template_create: "模板新建", template_update: "模板更新", template_remove: "模板删除",
    quickstart: "一句话开拍",
    scriptgen: "LLM 剧本生成",
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
        <div class="admin-tabs">
          <button :class="{ on: tab === 'nodes' }" @click="tab = 'nodes'">🖥 算力节点</button>
          <button :class="{ on: tab === 'registry' }" @click="tab = 'registry'">⚙️ 引擎段位</button>
          <button :class="{ on: tab === 'templates' }" @click="tab = 'templates'">🧩 模板</button>
          <button :class="{ on: tab === 'alerts' }" @click="tab = 'alerts'">🔔 告警<i class="admin-tab-badge" v-if="alertCount">{{ alertCount }}</i></button>
          <button :class="{ on: tab === 'audit' }" @click="tab = 'audit'">📜 审计</button>
        </div>

        <!-- ═══ Tab 1 算力节点：机器卡片＋显存闸＋剧集渲染分配 ═══ -->
        <template v-if="tab === 'nodes'">
          <div class="hint">💡 节点＝一台干活的机器：既能跑「渲染」（ComfyUI 出图/出片），也能跑「LLM 大脑」（剧本理解 / 复审 / 助手）。大脑同一时刻只落在一台机器上；每部剧的渲染活可在下方单独指派。机器卡上的「承载引擎」即这台机实际在跑的渲染引擎。</div>

          <div class="node-cards" v-if="nodesState.data">
            <div class="node-card" v-for="nd in nodesState.data.nodes" :key="nd.id">
              <div class="row wrap node-card-head">
                <b>{{ nd.label }}</b>
                <span class="badge badge-ok" v-if="nd.is_llm_host">🧠 LLM 承载中</span>
                <span class="badge" v-else>渲染机器</span>
              </div>

              <div class="node-card-row">
                <span class="node-label">渲染端点</span>
                <input class="input node-input" v-model.trim="nd.comfy.base" />
                <button class="btn btn-sm" :disabled="nodesState.savingComfy === nd.id" @click="saveComfy(nd)">保存</button>
                <button class="btn btn-ghost btn-sm" :disabled="nodeProbe[nd.id] && nodeProbe[nd.id].busy" @click="probeNode(nd)">
                  {{ nodeProbe[nd.id] && nodeProbe[nd.id].busy ? "探测中…" : "探测" }}</button>
              </div>
              <div class="node-card-sub">
                <span class="v-admin-dot stat st-ok" v-if="nodeProbe[nd.id] && nodeProbe[nd.id].done && nodeProbe[nd.id].ok"><i></i>可达 · {{ nodeProbe[nd.id].ms }}ms</span>
                <span class="v-admin-dot stat st-err" v-else-if="nodeProbe[nd.id] && nodeProbe[nd.id].done && !nodeProbe[nd.id].ok"><i></i>不通 · {{ nodeProbe[nd.id].detail }}</span>
                <span class="weak" v-else>点「探测」测连通；端点改动保存后即时生效（workers 下个任务读取）</span>
              </div>

              <div class="node-card-row">
                <span class="node-label">LLM 端点</span>
                <input class="input node-input" v-model.trim="nd.llm.base" placeholder="http://127.0.0.1:8090" />
              </div>
              <div class="node-card-row">
                <span class="node-label">模型别名</span>
                <input class="input node-input" v-model.trim="nd.llm.model" placeholder="模型别名" />
                <button class="btn btn-sm btn-primary" :disabled="nodesState.savingLlm === nd.id" @click="saveLlm(nd)">保存档案</button>
              </div>

              <div class="node-card-actions">
                <button class="btn btn-sm" v-if="!nd.is_llm_host && nd.llm && nd.llm.base" @click="switchLlmNode(nd)">让 LLM 大脑落在这台机器</button>
                <span class="weak" v-if="nd.is_llm_host">剧本理解 / 复审 / 助手都调用这台机器上的 LLM</span>
                <span class="weak" v-else-if="!(nd.llm && nd.llm.base)">这台机器还没配 LLM 档案，填好并保存后才能承接大脑</span>
              </div>

              <div class="node-card-row" v-if="enginesOf(nd.id)">
                <span class="node-label">承载引擎</span>
                <span class="weak">{{ enginesOf(nd.id) }}</span>
              </div>

              <div class="gate-warn" v-if="nd.id === 'local' && gpuData && gpuData.llm && gpuData.llm.online">
                <div>⚠️ LLM 正跑在本机：独显被占用，本机生图/拍摄已被挡。</div>
                <div class="row wrap" style="margin-top:6px">
                  <button class="btn btn-sm btn-danger" @click="yieldGpu">停止 LLM 让路</button>
                  <span class="weak">或把剧的渲染分配切到其它节点，绕开本机显存。</span>
                </div>
              </div>
            </div>
          </div>
          <loading v-else-if="nodesState.loading"></loading>
          <err-state v-else-if="nodesState.err" :err="nodesState.err" :on-retry="loadNodes" compact></err-state>

          <div class="panel">
            <div class="panel-title">📺 每部剧的渲染分配 <span class="weak">这部戏的生图/出片派给哪台机器</span></div>
            <div class="kv" v-if="nodesState.data && nodesState.data.episodes.length">
              <div class="kv-row" v-for="ep in nodesState.data.episodes" :key="ep.id">
                <span class="grow"><b>{{ ep.title }}</b> <span class="weak mono">{{ ep.id }}</span></span>
                <span class="weak admin-driver-note">渲染走「{{ nodeLabelOf(ep.driver) }}」<template v-if="ep.driver === 'local'">（LLM 在线时生图会被显存闸挡）</template></span>
                <select class="select" style="max-width:170px" :value="ep.driver" :disabled="nodesState.savingEp === ep.id" @change="switchDriver(ep, $event.target.value)">
                  <option v-for="n in (nodesState.data ? nodesState.data.nodes : [])" :key="n.id" :value="n.id">{{ n.label }}</option>
                </select>
              </div>
            </div>
            <empty-state v-else-if="nodesState.data" icon="📺" text="还没有剧集" sub="先在项目工作区建剧，再来分配渲染机器"></empty-state>
          </div>
        </template>

        <!-- ═══ Tab 2 引擎段位 ═══ -->
        <template v-else-if="tab === 'registry'">
          <div class="panel">
            <div class="panel-title">⚙️ 引擎段位注册表
              <span class="badge" v-if="data && data.langlint_exempt">语言表豁免面</span>
              <button class="btn btn-ghost btn-sm" @click="probeAll" :disabled="probing" :aria-busy="probing">
                {{ probing ? '巡检中…' : '段位巡检' }}</button>
              <button class="btn btn-ghost btn-sm" @click="reload" :aria-busy="loading">刷新</button>
            </div>
            <div class="hint">每个引擎落在哪个量化档；端点列第一行是你自定义的端点名，第二行是归属节点（名字取自「算力节点」档案）＋workers 实际拨号的服务地址。调档走规则裁决，切到兜底档要写理由并留审计号；点引擎名展开泳道与档位明细。</div>
            <loading v-if="loading && !data"></loading>
            <err-state v-else-if="err && !data" :err="err" :on-retry="reload"></err-state>
            <empty-state v-else-if="data && !rows.length" icon="🛠" text="注册表还是空的"
              sub="引擎段位登记后会出现在这里"></empty-state>
            <div class="table-scroll" v-else-if="rows.length">
            <table class="table">
              <thead>
                <tr><th>引擎</th><th>端点</th><th>当前档</th><th class="v-admin-probe-cell">巡检</th><th>调档</th></tr>
              </thead>
              <tbody>
                <template v-for="x in rows" :key="x.id">
                  <tr>
                    <td class="admin-expand" @click="toggleDetail(x.id)" title="展开/收起明细">
                      <span class="mono">{{ raw(x.id) }}</span>
                      <div class="weak admin-eng">{{ raw(x.engine) }}</div>
                      <span class="admin-caret">{{ ui[x.id] && ui[x.id].open ? "▾" : "▸" }}</span>
                    </td>
                    <td class="admin-endpoint">
                      <div class="admin-endpoint-name" :title="raw(x.endpoint)">{{ raw(x.endpoint) || "—" }}</div>
                      <div class="admin-serve" v-if="x.node">
                        <span class="node-chip">{{ nodeLabelOf(x.node) }}</span>
                        <span class="mono weak">{{ x.serve || "—" }}</span>
                      </div>
                      <div class="admin-serve" v-else-if="x.serve === 'in-proc'"><span class="mono weak">服务器进程内</span></div>
                      <div class="admin-serve" v-else><span class="mono weak">{{ x.serve || "独立服务未配置（stub 模式）" }}</span></div>
                    </td>
                    <td><span class="badge">{{ tierLabel(x.tier || x.quant) }}</span></td>
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
                  <tr v-if="ui[x.id] && ui[x.id].open" class="admin-detail-row">
                    <td colspan="5">
                      <div class="row wrap"><span class="weak">泳道</span><span class="mono weak">{{ raw(x.lane) || "—" }}</span></div>
                      <div class="row wrap"><span class="weak">已发布</span>
                        <span class="badge badge-ok" v-for="(p, i) in (x.published || [])" :key="'p' + i">{{ tierLabel(p) }}</span>
                        <span class="muted" v-if="!(x.published && x.published.length)">—</span></div>
                      <div class="row wrap"><span class="weak">不可用档</span>
                        <span class="badge badge-err" v-for="(u2, i) in (x.unavail || [])" :key="'u' + i">{{ tierLabel(u2) }}</span>
                        <span class="muted" v-if="!(x.unavail && x.unavail.length)">—</span></div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
            </div>
          </div>
        </template>

        <!-- ═══ Tab 3 系统告警 ═══ -->
        <template v-else-if="tab === 'alerts'">
          <div class="panel">
            <div class="panel-title">🔔 系统告警
              <span class="weak">队列卡死 / 预算护栏 / 引擎不可达，本页 10 秒自动刷新</span>
              <button class="btn btn-ghost btn-sm" @click="loadAlerts" :aria-busy="alertsLoading">刷新</button>
            </div>
            <loading v-if="alertsLoading && !alerts"></loading>
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
        </template>

        <!-- ═══ Tab 4 审计流水 ═══ -->
        <template v-else-if="tab === 'audit'">
          <div class="panel">
            <div class="panel-title">📜 审计流水（最近 50 条）
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
        </template>

        <!-- ═══ Tab 5 题材节拍模板（FR-1001 最小闭环 + FR-1304 运营可配） ═══ -->
        <template v-else-if="tab === 'templates'">
          <div class="hint">💡 模板＝题材节拍器＋风格预设。首页「模板流」用它一键开拍；节拍表会作为 LLM 剧本生成（scriptgen）的展开骨架。改动即时生效，版本只增可回溯。</div>

          <div class="panel">
            <div class="panel-title">🧩 模板注册表
              <button class="btn btn-ghost btn-sm" @click="loadTemplates" :aria-busy="templatesLoading">刷新</button>
              <button class="btn btn-primary btn-sm" @click="editTemplate(null)">＋ 新建模板</button>
            </div>
            <loading v-if="templatesLoading && !templates"></loading>
            <empty-state v-else-if="templates && !templates.length" icon="🧩" text="还没有模板"
              sub="点「新建模板」加一个题材节拍模板"></empty-state>
            <div class="list" v-else-if="templates">
              <div class="list-item row wrap" v-for="t in templates" :key="t.id">
                <b>{{ hs(t.name) }}</b>
                <span class="badge">{{ hs(t.genre) }}</span>
                <span class="badge" :class="t.enabled ? 'badge-ok' : 'badge-warn'">{{ t.enabled ? '启用' : '停用' }}</span>
                <span class="weak mono">v{{ t.ver }} · {{ (t.beats || []).length }} 节拍</span>
                <span class="grow"></span>
                <button class="btn btn-sm" @click="editTemplate(t)">编辑</button>
                <button class="btn btn-sm btn-ghost" @click="toggleTemplate(t)">{{ t.enabled ? '停用' : '启用' }}</button>
                <button class="btn btn-sm btn-danger" @click="deleteTemplate(t)">删除</button>
              </div>
            </div>
          </div>

          <div class="panel" v-if="tplEdit">
            <div class="panel-title">{{ tplEdit.id ? '✏️ 编辑模板 · ' + hs(tplEdit.name || '') : '✨ 新建模板' }}
              <span class="weak mono">v{{ tplEdit.ver }}</span></div>
            <form class="v-home-form" @submit.prevent="saveTemplate">
              <label class="field"><span class="field-label">名称</span>
                <input class="input" v-model.trim="tplEdit.name" placeholder="例：逆袭 · 战神归来" /></label>
              <label class="field"><span class="field-label">题材</span>
                <input class="input" v-model.trim="tplEdit.genre" placeholder="逆袭 / 甜宠 / 悬疑 / 带货…" /></label>
              <label class="field" style="grid-column:1/3"><span class="field-label">一句话介绍</span>
                <input class="input" v-model.trim="tplEdit.desc" placeholder="这个模板擅长讲什么故事" /></label>
              <label class="field"><span class="field-label">影调 look</span>
                <select class="select" v-model="tplEdit.style.look">
                  <option>写实电影感</option><option>柔光唯美</option><option>冷冽悬疑</option>
                </select></label>
              <label class="field"><span class="field-label">配色</span>
                <input class="input" v-model.trim="tplEdit.style.palette" placeholder="青橙 / 暖橘 / 冷蓝…" /></label>
              <label class="field" style="grid-column:1/3"><span class="field-label">节拍表（每行一个：节拍名|创作引导）</span>
                <textarea class="textarea" rows="5" v-model="tplEdit.beatsText"
                  placeholder="开局被踩|主角被打到底，憋屈拉满"></textarea></label>
              <label class="field" style="grid-column:1/3"><span class="field-label">卖点骨架（用模板时预填的文案）</span>
                <input class="input" v-model.trim="tplEdit.brief_skeleton"
                  placeholder="还在为____烦恼？这条视频给解决办法——" /></label>
              <label class="field"><span class="field-label">demo 视频地址（可空）</span>
                <input class="input" v-model.trim="tplEdit.demoUrl" placeholder="/var/out/xxx.mp4" /></label>
              <label class="field"><span class="field-label">成片时长（秒）</span>
                <input class="input num" type="number" min="5" max="600" v-model.number="tplEdit.demoDur" /></label>
              <label class="field" style="grid-column:1/3"><span class="row">
                <input type="checkbox" v-model="tplEdit.enabled" id="tpl-enabled" />
                <span for="tpl-enabled">启用（首页模板流可见）</span></span></label>
              <div class="v-home-acts">
                <button class="btn btn-primary" type="submit" :disabled="tplSaving" :aria-busy="tplSaving">保存</button>
                <button class="btn btn-ghost" type="button" @click="tplEdit = null">取消</button>
              </div>
            </form>
          </div>
        </template>
      </div>`,
    setup() {
      /* ---- Tab 状态 ---- */
      const tab = Vue.ref("nodes");

      /* ---- 引擎段位（tab 2） ---- */
      const probing = Vue.ref(false);
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

      /* 每行局部 UI 状态（下拉选择/理由/巡检结果/最近一次裁决/明细展开） */
      Vue.watch(rows, list => {
        list.forEach(x => {
          if (!ui[x.id]) {
            const opts = tierOptions(x);
            const cur = rawTier(x.tier) || rawTier(x.quant);
            ui[x.id] = { tier: cur || opts[0] || "", reason: "", busy: false, probe: "", last: null, open: false };
          }
        });
      }, { immediate: true });

      function toggleDetail(id) { if (ui[id]) ui[id].open = !ui[id].open; }

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

      function reload() { return store.loadRegistry().catch(() => {}); }

      /* ---- 系统告警（tab 3） ---- */
      const alertsLoading = Vue.ref(false);
      function loadAlerts() {
        alertsLoading.value = true;
        Promise.resolve(store.loadAlerts())
          .catch(() => {})
          .finally(() => { alertsLoading.value = false; });
      }
      const alertCount = Vue.computed(() => {
        const s = store.state;
        return (s && s.alerts_unacked) || 0;
      });

      /* ---- 审计流水（tab 4） ---- */
      const auditLoading = Vue.ref(false);
      function loadAuditRows() {
        auditLoading.value = true;
        Promise.resolve(store.loadAudit())
          .catch(() => {})
          .finally(() => { auditLoading.value = false; });
      }

      /* ---- 算力节点（tab 1） ---- */
      const nodesState = Vue.reactive({ data: null, loading: false, err: null, savingEp: "", savingLlm: "", savingComfy: "" });
      const nodeProbe = Vue.reactive({});
      const gpuData = Vue.computed(() => store.gpu.data || null);

      async function loadNodes() {
        nodesState.loading = true; nodesState.err = null;
        try { nodesState.data = await T.api.get("/nodes"); } catch (e) { nodesState.err = e; }
        finally { nodesState.loading = false; }
      }
      /* 节点显示名一律取自节点档案（state.nodes），前端不写死机器名 */
      function nodeLabelOf(id) {
        const ns = (nodesState.data && nodesState.data.nodes) || [];
        const n = ns.filter(v => v.id === id)[0];
        return n ? n.label : String(id || "—");
      }
      /* 某节点承载的引擎清单：来自注册表下发的 node 归属字段（后端按泳道解析），只挂渲染节点的服务 */
      function enginesOf(nodeId) {
        const d = store.registry.data;
        const reg = (d && d.registry) || {};
        return Object.keys(reg)
          .filter(id => reg[id] && reg[id].node === nodeId)
          .map(id => reg[id].engine || id)
          .join("、");
      }
      async function switchDriver(ep, driver) {
        nodesState.savingEp = ep.id;
        try {
          await T.api.put("/nodes/episodes/" + encodeURIComponent(ep.id) + "/driver", { driver });
          store.toast("「" + ep.title + "」渲染已分配到「" + nodeLabelOf(driver) + "」");
          await loadNodes();
        } catch (e) { store.toast(T.humanErr(e).text, "err"); }
        finally { nodesState.savingEp = ""; }
      }
      /* 保存指定节点的 LLM 档案（node 显式带上，避免误改当前承载节点的档案） */
      async function saveLlm(nd) {
        nodesState.savingLlm = nd.id;
        try {
          const r = await T.api.put("/nodes/llm", { node: nd.id, base: nd.llm.base, model: nd.llm.model });
          store.toast(r && r.note ? r.note : "LLM 档案已保存");
          await loadNodes();
        } catch (e) { store.toast(T.humanErr(e).text, "err"); }
        finally { nodesState.savingLlm = ""; }
      }
      async function saveComfy(nd) {
        nodesState.savingComfy = nd.id;
        try {
          await T.api.put("/nodes/" + encodeURIComponent(nd.id) + "/comfy", { base: nd.comfy.base });
          store.toast("渲染端点已保存（workers 下个任务即读取）");
          delete nodeProbe[nd.id]; // 端点变了，旧探测结果作废
          await loadNodes();
        } catch (e) { store.toast(T.humanErr(e).text, "err"); }
        finally { nodesState.savingComfy = ""; }
      }
      async function switchLlmNode(nd) {
        try {
          await T.api.put("/nodes/llm-node", { node: nd.id });
          store.toast("LLM 大脑已切到「" + nd.label + "」");
          await loadNodes();
        } catch (e) { store.toast(T.humanErr(e).text, "err"); }
      }
      async function probeNode(nd) {
        const p = nodeProbe[nd.id] || (nodeProbe[nd.id] = { busy: false, done: false, ok: false, ms: 0, detail: "" });
        if (p.busy) return;
        p.busy = true; p.done = false;
        try {
          const r = await T.api.post("/nodes/" + encodeURIComponent(nd.id) + "/probe", {});
          p.ok = !!r.ok; p.ms = r.ms || 0; p.detail = r.detail || ""; p.done = true;
        } catch (e) { p.ok = false; p.detail = T.humanErr(e).text; p.done = true; }
        finally { p.busy = false; }
      }
      async function yieldGpu() {
        try { await store.stopLlm(); } catch (e) { /* store 已 toast 人话 */ }
        loadNodes().catch(() => {});
      }

      /* ---- 题材节拍模板（tab 5）：运营可配（FR-1304） ---- */
      const templatesLoading = Vue.ref(false);
      const templates = Vue.ref(null);
      const tplEdit = Vue.ref(null);
      const tplSaving = Vue.ref(false);
      function loadTemplates() {
        templatesLoading.value = true;
        return store.loadTemplates()
          .then(list => { templates.value = list || []; })
          .catch(() => {})
          .finally(() => { templatesLoading.value = false; });
      }
      function beatsToText(beats) {
        return (beats || []).map(b => (b.beat || "") + (b.guide ? "|" + b.guide : "")).join("\n");
      }
      function textToBeats(text) {
        return String(text || "").split("\n").map(l => l.trim()).filter(Boolean).map(l => {
          const parts = l.split("|");
          return { beat: (parts[0] || "").trim(), guide: (parts[1] || "").trim() };
        });
      }
      function editTemplate(t) {
        tplEdit.value = t ? {
          id: t.id, name: t.name, genre: t.genre, desc: t.desc || "",
          style: Object.assign({ look: "写实电影感", palette: "青橙", ratio: "9:16" }, t.style || {}),
          beatsText: beatsToText(t.beats),
          brief_skeleton: t.brief_skeleton || "",
          demoUrl: (t.demo && t.demo.url) || "",
          demoDur: (t.demo && t.demo.dur_sec) || 45,
          enabled: !!t.enabled, ver: t.ver
        } : {
          id: null, name: "", genre: "", desc: "",
          style: { look: "写实电影感", palette: "青橙", ratio: "9:16" },
          beatsText: "", brief_skeleton: "", demoUrl: "", demoDur: 45, enabled: true, ver: 1
        };
      }
      async function saveTemplate() {
        const e = tplEdit.value;
        if (!e || tplSaving.value) return;
        if (!String(e.name || "").trim()) { store.toast("模板名称必填", "warn"); return; }
        tplSaving.value = true;
        try {
          await store.saveTemplate({
            id: e.id || undefined, name: e.name, genre: e.genre, desc: e.desc,
            style: e.style, beats: textToBeats(e.beatsText),
            brief_skeleton: e.brief_skeleton,
            demo: { url: e.demoUrl || null, dur_sec: e.demoDur },
            enabled: !!e.enabled
          });
          tplEdit.value = null;
          await loadTemplates();
        } catch (err) { /* store 已 toast */ }
        finally { tplSaving.value = false; }
      }
      async function toggleTemplate(t) {
        try {
          await store.saveTemplate(Object.assign({}, t, { enabled: !t.enabled }));
          await loadTemplates();
        } catch (err) { /* store 已 toast */ }
      }
      async function deleteTemplate(t) {
        try {
          await store.removeTemplate(t.id, false); // false → store 弹二次确认
          await loadTemplates();
        } catch (err) { /* store 已 toast（含确认取消） */ }
      }

      /* ---- Tab 懒加载＋告警页 10s 轮询 ---- */
      let alertsTimer = null;
      Vue.watch(tab, (t) => {
        if (t === "registry" && !store.registry.data) reload();
        if (t === "templates" && !templates.value) loadTemplates();
        if (t === "audit" && !store.registry.audit) loadAuditRows();
        if (t === "alerts") {
          loadAlerts();
          if (!alertsTimer) alertsTimer = setInterval(() => loadAlerts(), 10000);
        } else if (alertsTimer) { clearInterval(alertsTimer); alertsTimer = null; }
      }, { immediate: true });

      Vue.onMounted(() => { loadNodes().catch(() => {}); });
      Vue.onUnmounted(() => { if (alertsTimer) clearInterval(alertsTimer); });

      return {
        tab,
        data: Vue.computed(() => store.registry.data),
        loading: Vue.computed(() => store.registry.loading),
        err: Vue.computed(() => store.registry.error),
        rows, ui, probing, toggleDetail, applyQuant, probeAll, reload,
        alerts: Vue.computed(() => store.registry.alerts),
        alertCount, alertsLoading, loadAlerts,
        auditRows: Vue.computed(() => {
          const a = store.registry.audit;
          return Array.isArray(a) ? a.slice(-50).slice().reverse() : null;
        }),
        auditLoading, loadAuditRows,
        templates, templatesLoading, loadTemplates, tplEdit, tplSaving, editTemplate, saveTemplate, toggleTemplate, deleteTemplate,
        nodesState, nodeProbe, gpuData, loadNodes, switchDriver, saveLlm, saveComfy, switchLlmNode, probeNode, yieldGpu, nodeLabelOf, enginesOf,
        tierOptions, tierLabel, actionCn,
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
