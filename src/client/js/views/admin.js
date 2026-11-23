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
    llm_profile_add: "Agent LLM 档案登记", llm_profile_update: "Agent LLM 档案更新", llm_profile_remove: "Agent LLM 档案删除",
    llm_profile_activate: "Agent 大脑切换", llm_profile_probe: "Agent LLM 探测",
    node_comfy_update: "节点渲染端点更新", node_probe: "节点探测",
    node_add: "登记节点", node_update: "节点信息更新", node_remove: "撤除节点",
    user_driver_switch: "用户默认算力切换",
    template_create: "模板新建", template_update: "模板更新", template_remove: "模板删除",
    invite_add: "发新邀请码", invite_remove: "吊销邀请码",
    tenant_create: "新建域", tenant_switch: "切换域", tenant_delete: "删除域",
    tenant_transfer: "转让域主", tenant_budget: "域预算调整",
    member_role: "成员身份变更", member_remove: "成员移出",
    episode_delete: "删除剧集", project_delete: "删除项目", episode_purge: "清空剧集（调试）",
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
      "time-ago": T.components.TimeAgo,
      "money": T.components.Money
    },
    template: `
      <div class="v-admin">
        <div class="admin-tabs">
          <button :class="{ on: tab === 'brain' }" @click="tab = 'brain'">🤖 Agent 助手 LLM</button>
          <button :class="{ on: tab === 'nodes' }" @click="tab = 'nodes'">🖥 算力节点</button>
          <button :class="{ on: tab === 'registry' }" @click="tab = 'registry'">⚙️ 引擎段位</button>
          <button :class="{ on: tab === 'templates' }" @click="tab = 'templates'">🧩 模板</button>
          <button :class="{ on: tab === 'invites' }" @click="tab = 'invites'">🔐 成员</button>
          <button :class="{ on: tab === 'alerts' }" @click="tab = 'alerts'">🔔 告警<i class="admin-tab-badge" v-if="alertCount">{{ alertCount }}</i></button>
          <button :class="{ on: tab === 'audit' }" @click="tab = 'audit'">📜 审计</button>
          <button :class="{ on: tab === 'public' }" @click="tab = 'public'; loadPubLedger()">🏛 公共科目</button>
        </div>

        <!-- ═══ Tab 1 🤖 Agent 助手 LLM：大脑档案注册表（与渲染机器解耦，可增删配置） ═══ -->
        <template v-if="tab === 'brain'">
          <div class="hint">💡 Agent 助手的大脑＝一份可增删配置的 LLM 档案表：制片助手、AI 剧本、AI 审查、建议片都用「当前启用」的这套。加档案、删档案、换大脑都在这里，与渲染机器完全解耦；每份档案声明「运行位置」——指向某台渲染机＝占那台的显存（互斥闸生效），选云端/远程＝不占任何渲染机。</div>

          <div class="panel">
            <div class="panel-title">🤖 LLM 档案注册表
              <span class="badge badge-ok" v-if="brainState.data && brainState.data.llm.online">🟢 在线 · {{ brainState.data.llm.model || "已连接" }}</span>
              <span class="badge badge-warn" v-else-if="brainState.data && (brainState.data.profiles || []).some(p => p.is_active)">🟡 离线</span>
              <span class="badge badge-err" v-else-if="brainState.data">未配置（AI 能力走规则兜底）</span>
              <button class="btn btn-ghost btn-sm" @click="brainState.showAdd = !brainState.showAdd">
                {{ brainState.showAdd ? "收起" : "➕ 新增 LLM 档案" }}</button>
              <button class="btn btn-ghost btn-sm" @click="loadBrain()" :aria-busy="brainState.loading">刷新</button>
            </div>

            <div class="row wrap" v-if="brainState.showAdd" style="align-items:flex-end;gap:8px">
              <label class="weak">档案名称<br /><input class="input" v-model.trim="brainForm.label" placeholder="如 本机 Huihui35B / DeepSeek 云" style="max-width:210px" /></label>
              <label class="weak">端点（OpenAI 兼容 /v1）<br /><input class="input" v-model.trim="brainForm.base" placeholder="http://127.0.0.1:8090 或 https://api.xxx.com/v1" style="max-width:300px" /></label>
              <label class="weak">模型别名<br /><input class="input" v-model.trim="brainForm.model" placeholder="如 Huihui35B:vision / deepseek-chat" style="max-width:190px" /></label>
              <label class="weak">密钥（云 API 才填）<br /><input class="input" type="password" v-model.trim="brainForm.key" placeholder="sk-…（可空）" style="max-width:160px" /></label>
              <label class="weak">运行位置<br />
                <select class="select" v-model="brainForm.node" style="max-width:200px">
                  <option value="">☁️ 云端 / 远程（不占渲染机显存）</option>
                  <option v-for="n in (nodesList || [])" :key="n.id" :value="n.id">🖥 {{ n.label }}（占该机显存）</option>
                </select></label>
              <label class="weak">重启脚本（仅提示用）<br /><input class="input" v-model.trim="brainForm.bat" placeholder="E:\\MyLLM\\xxx.bat（可空，只在停服提示里显示，不自动运行）" style="max-width:230px" /></label>
              <button class="btn btn-sm btn-primary" :disabled="brainState.saving === 'add'" @click="addBrainProfile">登记</button>
            </div>

            <loading v-if="brainState.loading && !brainState.data"></loading>
            <err-state v-else-if="brainState.err && !brainState.data" :err="brainState.err" :on-retry="loadBrain" compact></err-state>
            <empty-state v-else-if="brainState.data && !(brainState.data.profiles || []).length" icon="🤖"
              text="还没有 LLM 档案" sub="登记一份端点即可点亮 AI 能力（AI 剧本 / 复审 / 助手）"></empty-state>
            <div class="list" v-else-if="brainState.data">
              <div class="list-item" v-for="p in (brainState.data.profiles || [])" :key="p.id"
                :style="p.is_active ? 'border-color:var(--ok,#2e7d32)' : ''">
                <div class="row wrap">
                  <button class="btn btn-sm" :class="p.is_active ? '' : 'btn-primary'" :disabled="p.is_active || brainState.saving === p.id"
                    @click="activateBrainProfile(p)" :title="p.is_active ? '当前启用中' : '把 Agent 大脑切到这套档案'">
                    {{ p.is_active ? "✓ 启用中" : "启用" }}</button>
                  <input class="input" v-model.trim="p.label" style="max-width:190px" title="改名后点「保存」生效" />
                  <span class="badge" :class="p.node ? 'badge-warn' : ''" :title="p.node ? 'LLM 物理跑在这台渲染机上，在线时占它的显存' : '不占任何渲染机显存'">
                    {{ brainHostOf(p) }}</span>
                  <span class="badge badge-ok" v-if="p.has_key">🔑 密钥已配置</span>
                  <button class="btn btn-sm btn-danger" style="margin-left:auto" @click="removeBrainProfile(p)">删除</button>
                </div>
                <div class="row wrap" style="margin-top:6px;align-items:center">
                  <span class="weak">端点</span>
                  <input class="input" v-model.trim="p.base" style="max-width:300px" placeholder="http://127.0.0.1:8090" />
                  <span class="weak">模型</span>
                  <input class="input" v-model.trim="p.model" style="max-width:170px" placeholder="模型别名" />
                  <span class="weak">重启脚本（手动）</span>
                  <input class="input" v-model.trim="p.bat" style="max-width:210px" placeholder="E:\\MyLLM\\xxx.bat（可空，仅提示）" />
                  <button class="btn btn-sm btn-primary" :disabled="brainState.saving === p.id" @click="saveBrainProfile(p)">保存</button>
                  <button class="btn btn-ghost btn-sm" :disabled="brainState.probe[p.id] && brainState.probe[p.id].busy" @click="probeBrainProfile(p)">
                    {{ brainState.probe[p.id] && brainState.probe[p.id].busy ? "探测中…" : "探测" }}</button>
                </div>
                <div class="card-sub weak" style="margin-top:4px">
                  <span class="v-admin-dot stat st-ok" v-if="brainState.probe[p.id] && brainState.probe[p.id].done && brainState.probe[p.id].ok"><i></i>可达 · {{ brainState.probe[p.id].ms }}ms</span>
                  <span class="v-admin-dot stat st-err" v-else-if="brainState.probe[p.id] && brainState.probe[p.id].done && !brainState.probe[p.id].ok"><i></i>不通 · {{ brainState.probe[p.id].detail }}</span>
                  <span v-else>点「探测」测 /v1/models 连通；{{ p.node ? "该档案占用「" + brainHostOf(p) + "」的显存——那台机若开互斥闸，大脑在线时它的渲染会被挡" : "云端大脑不占渲染机显存，显存互斥闸对它不生效" }}。</span>
                </div>
              </div>
            </div>
            <div class="weak" style="margin-top:6px" v-if="brainState.data">
              LLM 进程完全由你手动启停：平台只探测在线状态，绝不自动拉起任何模型进程；离线＝AI 能力如实报错＋规则兜底。
              未配置档案＝AI 能力全部规则兜底（AI 剧本落占位结构、AI 审查只走规则、助手无人话增强、建议片不可用）。
            </div>
          </div>
        </template>

        <!-- ═══ Tab 2 🖥 算力节点：渲染机器注册表＋分派（大脑档案在「Agent 助手 LLM」tab） ═══ -->
        <template v-else-if="tab === 'nodes'">
          <div class="hint">💡 节点＝一台干活的渲染机器：ComfyUI 出图/出片，或付费云 API。每台机器的「承载引擎」、谁用哪台（用户默认＋每部剧的分派）都在这一页；Agent 大脑的 LLM 档案不在这里——去「🤖 Agent 助手 LLM」页增删配置。</div>

          <div class="panel">
            <div class="panel-title">🖥 节点注册表
              <button class="btn btn-ghost btn-sm" @click="nodesState.showAdd = !nodesState.showAdd">
                {{ nodesState.showAdd ? "收起" : "➕ 新增节点" }}</button>
              <span class="weak">加机器/撤机器在这里，不用改代码</span>
            </div>
            <div class="row wrap" v-if="nodesState.showAdd" style="align-items:flex-end;gap:8px">
              <label class="weak">节点 ID<br /><input class="input" v-model.trim="nodeForm.id" placeholder="如 gpu3（字母数字-_)，登记后不可改" style="max-width:180px" /></label>
              <label class="weak">名称<br /><input class="input" v-model.trim="nodeForm.label" placeholder="如 3 号机房 A100" style="max-width:200px" /></label>
              <label class="weak">类型<br />
                <select class="select" v-model="nodeForm.kind" style="max-width:170px">
                  <option value="comfy">🖥 渲染机（ComfyUI）</option>
                  <option value="cloud">☁️ 付费云 API</option>
                </select></label>
              <template v-if="nodeForm.kind === 'cloud'">
                <label class="weak">API 端点<br /><input class="input" v-model.trim="nodeForm.api_endpoint" placeholder="OpenAI 兼容 /v1 基址" style="max-width:260px" /></label>
                <label class="weak">密钥<br /><input class="input" type="password" v-model.trim="nodeForm.api_key" placeholder="sk-…" style="max-width:180px" /></label>
                <label class="weak">模型<br /><input class="input" v-model.trim="nodeForm.api_model" placeholder="如 dall-e-3 / 即梦-x" style="max-width:160px" /></label>
                <label class="weak">单价（分/张）<br /><input class="input num" v-model.number="nodeForm.api_price" placeholder="30" style="max-width:90px" /></label>
              </template>
              <template v-else>
                <label class="weak">渲染端点<br /><input class="input" v-model.trim="nodeForm.comfy_base" placeholder="http://192.168.1.20:8188（可留空后补）" style="max-width:280px" /></label>
                <label class="weak" style="white-space:nowrap"><input type="checkbox" v-model="nodeForm.gpu_gate" /> 显存互斥闸<br /><span class="weak mono">16G 单卡才开</span></label>
              </template>
              <button class="btn btn-sm btn-primary" :disabled="nodesState.adding" @click="addNode">登记</button>
            </div>
          </div>

          <div class="node-cards" v-if="nodesState.data">
            <div class="node-card" v-for="nd in nodesState.data.nodes" :key="nd.id">
              <div class="row wrap node-card-head">
                <input class="input node-input" v-model.trim="nd.label" style="max-width:180px" title="改名后点「保存信息」生效" />
                <button class="btn btn-sm" :disabled="nodesState.savingInfo === nd.id" @click="saveNodeInfo(nd)">保存信息</button>
                <span class="badge" :class="nd.kind === 'cloud' ? '' : 'badge-ok'">{{ nd.kind === 'cloud' ? '☁️ 付费云 API' : '🖥 渲染机' }}</span>
                <label class="weak" v-if="nd.kind !== 'cloud'" style="white-space:nowrap" title="开启后：LLM 在线时该机的生图/拍摄任务被显存闸挡（16G 单卡机器才开）">
                  <input type="checkbox" v-model="nd.gpu_gate" @change="saveNodeInfo(nd)" /> 显存互斥闸</label>
                <span class="badge badge-ok" v-if="nd.is_llm_host" title="Agent 大脑的运行位置指向这台机器（在「Agent 助手 LLM」页配置）">🤖 大脑宿主</span>
                <button class="btn btn-sm btn-danger" style="margin-left:auto" @click="removeNodeCard(nd)">撤节点</button>
              </div>

              <!-- 云 API 节点：api 档案（key 只显示状态，改密钥整串重填） -->
              <template v-if="nd.kind === 'cloud'">
                <div class="node-card-row">
                  <span class="node-label">API 端点</span>
                  <input class="input node-input" v-model.trim="nd.api.endpoint" placeholder="OpenAI 兼容 /v1 基址" />
                </div>
                <div class="node-card-row">
                  <span class="node-label">模型</span>
                  <input class="input node-input" v-model.trim="nd.api.model" placeholder="模型名" />
                  <span class="weak">{{ nd.api.has_key ? '🔑 密钥已配置' : '⚠️ 未配密钥' }}</span>
                </div>
                <div class="node-card-row">
                  <span class="node-label">新密钥</span>
                  <input class="input node-input" v-model.trim="nd._newKey" type="password" placeholder="不填＝不改动" />
                  <span class="node-label">单价/张</span>
                  <input class="input node-input num" style="max-width:90px" v-model.number="nd.api.price_cents" />
                  <button class="btn btn-sm btn-primary" :disabled="nodesState.savingInfo === nd.id" @click="saveNodeApi(nd)">保存云档案</button>
                  <button class="btn btn-ghost btn-sm" :disabled="nodeProbe[nd.id] && nodeProbe[nd.id].busy" @click="probeNode(nd)">
                    {{ nodeProbe[nd.id] && nodeProbe[nd.id].busy ? "探测中…" : "探测" }}</button>
                </div>
                <div class="node-card-sub">
                  <span class="v-admin-dot stat st-ok" v-if="nodeProbe[nd.id] && nodeProbe[nd.id].done && nodeProbe[nd.id].ok"><i></i>可达 · {{ nodeProbe[nd.id].ms }}ms</span>
                  <span class="v-admin-dot stat st-err" v-else-if="nodeProbe[nd.id] && nodeProbe[nd.id].done && !nodeProbe[nd.id].ok"><i></i>不通 · {{ nodeProbe[nd.id].detail }}</span>
                  <span class="weak" v-else>计费＝单价×张数（影子账本）；计费走 /v1/images/generations 适配</span>
                </div>
                <div class="node-card-row" v-if="enginesOf(nd.id)">
                  <span class="node-label">承载引擎</span>
                  <span class="weak">{{ enginesOf(nd.id) }}</span>
                </div>
              </template>

              <!-- ComfyUI 渲染机：原有 comfy/LLM 档案 -->
              <template v-else>
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

                <!-- LLM 档案已解耦到「Agent 助手 LLM」页：机器卡只管渲染拓扑 -->

                <div class="node-card-row" v-if="enginesOf(nd.id)">
                  <span class="node-label">承载引擎</span>
                  <span class="weak">{{ enginesOf(nd.id) }}</span>
                </div>

                <div class="gate-warn" v-if="nd.gpu_gate && nd.is_llm_host && gpuData && gpuData.llm && gpuData.llm.online">
                  <div>⚠️ Agent 大脑正跑在这台机器：独显被占用，本机生图/拍摄已被挡。</div>
                  <div class="row wrap" style="margin-top:6px">
                    <button class="btn btn-sm btn-danger" @click="yieldGpu">停止 LLM 让路</button>
                    <span class="weak">或把大脑换到云端档案 / 把剧的渲染分配切到其它节点。</span>
                  </div>
                </div>
              </template>
            </div>
          </div>
          <loading v-else-if="nodesState.loading"></loading>
          <err-state v-else-if="nodesState.err" :err="nodesState.err" :on-retry="loadNodes" compact></err-state>

          <div class="panel">
            <div class="panel-title">👤 用户默认算力 <span class="weak">该用户新建剧集自动落在这个节点（剧集行仍可单集改派）</span></div>
            <div class="kv" v-if="nodesState.data && nodesState.data.users && nodesState.data.users.length">
              <div class="kv-row" v-for="u in nodesState.data.users" :key="u.uid">
                <span class="grow"><b>{{ u.name }}</b>
                  <span class="badge">{{ u.role === 'ops' ? '运营' : '创作' }}</span>
                  <span class="weak mono">{{ u.uid }}</span></span>
                <span class="weak">默认走「{{ u.driver ? nodeLabelOf(u.driver) : '首个登记节点' }}」</span>
                <select class="select" style="max-width:170px" :value="u.driver" :disabled="nodesState.savingUser === u.uid"
                  @change="saveUserDriver(u, $event.target.value)">
                  <option value="">跟随全局（首个登记节点）</option>
                  <option v-for="n in (nodesState.data ? nodesState.data.nodes : [])" :key="n.id" :value="n.id">{{ n.label }}</option>
                </select>
              </div>
            </div>
            <empty-state v-else-if="nodesState.data" icon="👤" text="还没有用户" sub="有人用邀请码进来后，在这里指派默认算力"></empty-state>
          </div>

          <div class="panel">
            <div class="panel-title">📺 每部剧的渲染分配 <span class="weak">这部戏的生图/出片派给哪台机器</span></div>
            <div class="kv" v-if="nodesState.data && nodesState.data.episodes.length">
              <div class="kv-row" v-for="ep in nodesState.data.episodes" :key="ep.id">
                <span class="grow"><b>{{ ep.title }}</b> <span class="weak mono">{{ ep.id }}</span></span>
                <span class="weak admin-driver-note">渲染走「{{ nodeLabelOf(ep.driver) }}」<template v-if="nodeGateOf(ep.driver)">（该机开着显存互斥闸：LLM 在线时生图会被挡）</template></span>
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
              <button class="btn btn-ghost btn-sm" @click="showAddEngine = !showAddEngine">
                {{ showAddEngine ? "收起" : "➕ 登记引擎" }}</button>
              <button class="btn btn-ghost btn-sm" @click="probeAll" :disabled="probing" :aria-busy="probing">
                {{ probing ? '巡检中…' : '段位巡检' }}</button>
              <button class="btn btn-ghost btn-sm" @click="reload" :aria-busy="loading">刷新</button>
            </div>
            <div class="row wrap" v-if="showAddEngine" style="align-items:flex-end;gap:8px">
              <label class="weak">引擎 ID<br /><input class="input" v-model.trim="engineForm.engineId" placeholder="如 SDXL-turbo-Q8" style="max-width:200px" /></label>
              <label class="weak">车道 lane<br />
                <select class="select" v-model="engineForm.lane" style="max-width:160px">
                  <option v-for="l in (lanesList || [])" :key="l" :value="l">{{ l }}</option>
                </select></label>
              <label class="weak">归属节点<br />
                <select class="select" v-model="engineForm.node" style="max-width:180px">
                  <option value="">— 独立服务/进程内 —</option>
                  <option v-for="n in (nodesList || [])" :key="n.id" :value="n.id">{{ n.label }}</option>
                </select></label>
              <label class="weak">量化档<br /><input class="input" v-model.trim="engineForm.quant" placeholder="如 int8 / Q5_K_M / fp16" style="max-width:150px" /></label>
              <label class="weak">端点名<br /><input class="input" v-model.trim="engineForm.endpoint" placeholder="如 W-B ComfyUI :8188" style="max-width:200px" /></label>
              <label class="weak">已发布档<br /><input class="input" v-model.trim="engineForm.published" placeholder="逗号分隔，如 nvfp4,int8" style="max-width:180px" /></label>
              <label class="weak">不可用档<br /><input class="input" v-model.trim="engineForm.unavail" placeholder="逗号分隔" style="max-width:150px" /></label>
              <button class="btn btn-sm btn-primary" :disabled="addingEngine" @click="addEngineRow">登记</button>
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
                      <div class="row wrap">
                        <span class="weak">归属节点</span>
                        <select class="select" style="max-width:200px" v-model="ui[x.id].node" @change="rebindEngineRow(x)">
                          <option value="">— 独立服务/进程内 —</option>
                          <option v-for="n in (nodesList || [])" :key="n.id" :value="n.id">{{ n.label }}</option>
                        </select>
                        <button class="btn btn-sm btn-danger" @click="removeEngineRow(x)">注销引擎</button>
                      </div>
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

        <!-- ═══ Tab 公共科目（素材中心 C8）：素材账本单独口径 ═══ -->
        <template v-else-if="tab === 'public'">
          <div class="panel">
            <div class="panel-title">🏛 公共库科目
              <span class="weak">素材任务不进任何单集 Σcost——公共池单独对账（施工 K8 口径）</span>
              <button class="btn btn-ghost btn-sm" @click="loadPubLedger" :aria-busy="pubLoading">刷新</button>
            </div>
            <loading v-if="pubLoading && !pubLedger"></loading>
            <div class="kv num" v-else-if="pubLedger">
              <div>账本行数：<b class="num">{{ pubLedger.rows }}</b></div>
              <div>公共池累计：<money :cents="pubLedger.total"></money></div>
              <div v-for="(v,k) in (pubLedger.by_kind || {})" :key="k">{{ k }}：<money :cents="v"></money></div>
              <div>公共库库存：曲 {{ (pubLedger.counts || {}).global_music || 0 }} · 图 {{ (pubLedger.counts || {}).global_images || 0 }}</div>
            </div>
            <div class="weak" v-else>公共科目暂不可读（需要 ops 角色）</div>
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

        <!-- ═══ Tab 6 成员与邀请码（2026-11-22 按人发码：一人一码一号） ═══ -->
        <template v-else-if="tab === 'invites'">
          <div class="hint">💡 一人一码一号：新成员用各自的码登录，审计里分得清谁拍的板。码吊销后无法再登录（已绑定账号不受影响）。</div>

          <div class="panel">
            <div class="panel-title">🔐 邀请码
              <button class="btn btn-ghost btn-sm" @click="loadInvites" :aria-busy="invitesLoading">刷新</button>
            </div>
            <form class="v-home-form" @submit.prevent="newInvite">
              <label class="field"><span class="field-label">成员名</span>
                <input class="input" v-model.trim="invForm.name" placeholder="例：运营小王" /></label>
              <label class="field"><span class="field-label">身份</span>
                <select class="select" v-model="invForm.role">
                  <option value="creator">创作（工作台全功能）</option>
                  <option value="ops">运营（＋运维台/重合成）</option>
                </select></label>
              <div class="v-home-acts">
                <button class="btn btn-primary" type="submit">＋ 生成新码</button>
              </div>
            </form>
            <div class="card" v-if="invForm.lastCode" style="margin-top:8px">
              ✅ 新码：<b class="mono">{{ raw(invForm.lastCode) }}</b>
              <span class="weak">——发给对应成员，用它在登录页进入</span>
              <button type="button" class="btn btn-sm" @click="copyCode">复制</button>
            </div>

            <loading v-if="invitesLoading && !invites"></loading>
            <empty-state v-else-if="invites && !invites.length" icon="🔐" text="还没有邀请码"
              sub="生成一个码，发给要协作的成员"></empty-state>
            <div class="table-scroll" v-else-if="invites">
              <table class="table">
                <thead><tr><th>邀请码</th><th>预置身份</th><th>状态</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="iv in invites" :key="iv.code">
                    <td class="mono"><b>{{ raw(iv.code) }}</b></td>
                    <td>
                      <span v-if="iv.name">{{ hs(iv.name) }}</span><span v-else class="weak">—</span>
                      <span class="badge" v-if="iv.role">{{ iv.role === 'ops' ? '运营' : '创作' }}</span>
                    </td>
                    <td>
                      <span v-if="iv.used" class="badge badge-ok">已绑定 {{ hs(iv.bound_name || '') }}</span>
                      <span v-else class="badge">未使用</span>
                    </td>
                    <td><button class="btn btn-sm btn-danger" @click="revokeInvite(iv)">吊销</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </div>`,
    setup() {
      /* ---- Tab 状态 ---- */
      const tab = Vue.ref("brain");

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

      /* 每行局部 UI 状态（下拉选择/理由/巡检结果/最近一次裁决/明细展开/归属节点改绑） */
      Vue.watch(rows, list => {
        list.forEach(x => {
          if (!ui[x.id]) {
            const opts = tierOptions(x);
            const cur = rawTier(x.tier) || rawTier(x.quant);
            ui[x.id] = { tier: cur || opts[0] || "", reason: "", busy: false, probe: "", last: null, open: false, node: x.node || "" };
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

      /* ---- 引擎登记/注销/改绑（tab 2，2026-11-22 注册表化） ---- */
      const showAddEngine = Vue.ref(false);
      const addingEngine = Vue.ref(false);
      const engineForm = Vue.reactive({
        engineId: "", lane: "", node: "", engine: "", quant: "", endpoint: "", published: "", unavail: ""
      });
      /* 合法车道枚举：后端 GET /admin/registry 随注册表下发（ALL_LANES ∪ 已装载 worker 车道） */
      const lanesList = Vue.computed(() => {
        const d = store.registry.data;
        return (d && d.lanes) || [];
      });
      /* 节点清单（登记引擎/改绑归属节点用）：算力节点 tab 的加载结果直接复用 */
      const nodesList = Vue.computed(() => {
        return (nodesState.data && nodesState.data.nodes) || [];
      });
      function csvTiers(s) {
        return String(s || "").split(/[,，]/).map(t => t.trim()).filter(Boolean);
      }
      async function addEngineRow() {
        const f = engineForm;
        const engineId = String(f.engineId || "").trim();
        if (!engineId) { store.toast("先给引擎起个 ID（如 SDXL-turbo-Q8）", "warn"); return; }
        if (!f.lane) { store.toast("选一个车道 lane（任务跑在哪条流水线上）", "warn"); return; }
        addingEngine.value = true;
        try {
          await store.addEngine({
            engineId,
            lane: f.lane,
            node: f.node || null,
            engine: String(f.engine || "").trim() || engineId,
            quant: String(f.quant || "").trim() || "n/a",
            endpoint: String(f.endpoint || "").trim(),
            published: csvTiers(f.published),
            unavail: csvTiers(f.unavail)
          });
          Object.assign(f, { engineId: "", engine: "", quant: "", endpoint: "", published: "", unavail: "" });
          showAddEngine.value = false;
        } catch (e) { /* store 已 toast 人话 */ }
        finally { addingEngine.value = false; }
      }
      async function removeEngineRow(x) {
        try { await store.removeEngine(x.id, false); } catch (e) { /* store 已 toast（含确认取消） */ }
      }
      async function rebindEngineRow(x) {
        const u = ui[x.id];
        if (!u) return;
        try {
          await store.rebindEngine(x.id, u.node || null);
          u.node = u.node || ""; // 成功后保持下拉与注册表一致
        } catch (e) { /* store 已 toast；失败时回读注册表还原下拉 */ reload(); }
      }

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
      /* LLM 档案编辑已迁出（2026-11-22 大脑层解耦）→「🤖 Agent 助手 LLM」tab 的档案注册表 */
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
        loadBrain().catch(() => {});
      }

      /* ---- 节点注册表 CRUD（2026-11-22 运维台化：加机器/撤机器/改信息不再改代码） ---- */
      nodesState.showAdd = false; nodesState.adding = false; nodesState.savingInfo = ""; nodesState.savingUser = "";
      const nodeForm = Vue.reactive({ id: "", label: "", kind: "comfy", comfy_base: "", gpu_gate: false, api_endpoint: "", api_key: "", api_model: "", api_price: 30 });
      async function addNode() {
        const f = nodeForm;
        const id = String(f.id || "").trim();
        if (!id) { store.toast("先给节点起个 ID（如 gpu3）", "warn"); return; }
        if (!String(f.label || "").trim()) { store.toast("给节点起个人看的名字", "warn"); return; }
        const payload = { id, label: f.label, kind: f.kind, gpu_gate: f.gpu_gate };
        if (f.kind === "cloud") {
          payload.api = { endpoint: f.api_endpoint, key: f.api_key, model: f.api_model, price_cents: Number(f.api_price) || 0 };
        } else {
          payload.comfy_base = f.comfy_base;
        }
        nodesState.adding = true;
        try {
          await store.addNode(payload);
          Object.assign(f, { id: "", label: "", kind: "comfy", comfy_base: "", gpu_gate: false, api_endpoint: "", api_key: "", api_model: "", api_price: 30 });
          nodesState.showAdd = false;
          await loadNodes();
        } catch (e) { /* store 已 toast 人话 */ }
        finally { nodesState.adding = false; }
      }
      /* 云 API 档案保存（endpoint/model/price＋可选新密钥） */
      async function saveNodeApi(nd) {
        nodesState.savingInfo = nd.id;
        try {
          const api = { endpoint: nd.api.endpoint, model: nd.api.model, price_cents: Number(nd.api.price_cents) || 0 };
          if (nd._newKey) api.key = nd._newKey; // 空＝不改密钥
          await store.updateNode(nd.id, { api });
          nd._newKey = "";
          store.toast("云 API 档案已保存");
          await loadNodes();
        } catch (e) { /* store 已 toast */ }
        finally { nodesState.savingInfo = ""; }
      }
      /* 用户默认算力（账户→默认节点；""＝跟随全局） */
      async function saveUserDriver(u, driver) {
        nodesState.savingUser = u.uid;
        try {
          const r = await T.api.put("/nodes/users/" + encodeURIComponent(u.uid) + "/driver", { driver });
          store.toast((r && r.note) || "用户默认算力已更新");
          await loadNodes();
        } catch (e) { store.toast(T.humanErr(e).text, "err"); }
        finally { nodesState.savingUser = ""; }
      }

      /* ---- 🤖 Agent 助手 LLM（2026-11-22 大脑层解耦）：档案注册表可增删配置，与渲染机器解耦 ---- */
      const brainState = Vue.reactive({ data: null, loading: false, err: null, saving: "", showAdd: false, probe: {} });
      const brainForm = Vue.reactive({ label: "", base: "", model: "", key: "", bat: "", node: "" });
      async function loadBrain() {
        brainState.loading = true; brainState.err = null;
        try { brainState.data = await store.loadLlmProfiles(); }
        catch (e) { brainState.err = e; }
        finally { brainState.loading = false; }
        return brainState.data;
      }
      /* 运行位置显示名：指向渲染机 → 节点名；null → 云端/远程 */
      function brainHostOf(p) {
        return p.node ? (p.node_label || p.node) : "云端 / 远程（不占渲染机显存）";
      }
      async function addBrainProfile() {
        const f = brainForm;
        if (!String(f.label || "").trim()) { store.toast("给档案起个名（如「本机 Huihui35B」「DeepSeek 云」）", "warn"); return; }
        brainState.saving = "add";
        try {
          await store.addLlmProfile({
            label: f.label, base: f.base, model: f.model, key: f.key, bat: f.bat,
            node: f.node || null
          });
          Object.assign(f, { label: "", base: "", model: "", key: "", bat: "", node: "" });
          brainState.showAdd = false;
          await loadBrain();
        } catch (e) { /* store 已 toast 人话 */ }
        finally { brainState.saving = ""; }
      }
      async function saveBrainProfile(p) {
        brainState.saving = p.id;
        try {
          await store.updateLlmProfile(p.id, { label: p.label, base: p.base, model: p.model, bat: p.bat, node: p.node || null });
          await loadBrain();
          loadNodes().catch(() => {}); // 运行位置变了 → 节点卡徽章跟着刷
        } catch (e) { /* store 已 toast；失败回读还原 */ loadBrain().catch(() => {}); }
        finally { brainState.saving = ""; }
      }
      async function removeBrainProfile(p) {
        try {
          const r = await store.removeLlmProfile(p.id, p.label, false);
          if (r) await loadBrain();
        } catch (e) { /* store 已 toast（含确认取消） */ }
      }
      async function activateBrainProfile(p) {
        try {
          await store.activateLlmProfile(p.id);
          await loadBrain();
          loadNodes().catch(() => {}); // 节点卡「大脑宿主」徽章跟随宿主机变化
        } catch (e) { /* store 已 toast */ }
      }
      async function probeBrainProfile(p) {
        const pr = brainState.probe[p.id] || (brainState.probe[p.id] = { busy: false, done: false, ok: false, ms: 0, detail: "" });
        if (pr.busy) return;
        pr.busy = true; pr.done = false;
        try {
          const r = await store.probeLlmProfile(p.id);
          pr.ok = !!r.ok; pr.ms = r.ms || 0; pr.detail = r.detail || ""; pr.done = true;
        } finally { pr.busy = false; }
      }
      function clearBrainProbe(p) { delete brainState.probe[p.id]; }

      async function saveNodeInfo(nd) {
        nodesState.savingInfo = nd.id;
        try {
          await store.updateNode(nd.id, { label: nd.label, gpu_gate: nd.gpu_gate === true });
          await loadNodes();
        } catch (e) { /* store 已 toast；失败回读还原 */ loadNodes().catch(() => {}); }
        finally { nodesState.savingInfo = ""; }
      }
      async function removeNodeCard(nd) {
        try {
          const r = await store.removeNode(nd.id, false);
          if (r) await loadNodes();
        } catch (e) { /* store 已 toast（含确认取消） */ }
      }
      /* 剧集行提示：驱动指向的节点是否开着显存互斥闸（名字一律取节点档案，不写死机器） */
      function nodeGateOf(id) {
        const ns = (nodesState.data && nodesState.data.nodes) || [];
        const n = ns.filter(v => v.id === id)[0];
        return !!(n && n.gpu_gate);
      }

      /* ---- 公共库科目（素材中心 C8）：素材任务不进单集 Σcost，公共池单独口径 ---- */
      const pubLedger = Vue.ref(null);
      const pubLoading = Vue.ref(false);
      async function loadPubLedger() {
        pubLoading.value = true;
        try { pubLedger.value = await T.api.get("/studio/public_ledger"); }
        catch (e) { pubLedger.value = null; }
        finally { pubLoading.value = false; }
        return pubLedger.value;
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

      /* ---- 成员与邀请码（tab 6，2026-11-22 按人发码） ---- */
      const invites = Vue.ref(null);
      const invitesLoading = Vue.ref(false);
      const invForm = Vue.reactive({ name: "", role: "creator", lastCode: "" });
      function loadInvites() {
        invitesLoading.value = true;
        Promise.resolve(store.loadInvites())
          .then(list => { invites.value = list; })
          .catch(() => {})
          .finally(() => { invitesLoading.value = false; });
      }
      async function newInvite() {
        const name = String(invForm.name || "").trim();
        if (!name) { store.toast("给新成员起个名字", "warn"); return; }
        try {
          const r = await store.addInvite(name, invForm.role);
          invForm.name = "";
          invForm.lastCode = (r && r.code) || "";
          loadInvites();
        } catch (e) { /* store 已 toast */ }
      }
      async function revokeInvite(iv) {
        try { await store.removeInvite(iv.code); loadInvites(); } catch (e) { /* store 已 toast */ }
      }
      function copyCode() {
        try { navigator.clipboard.writeText(invForm.lastCode); store.toast("已复制"); }
        catch (e) { store.toast("复制失败，手动选中文本复制", "warn"); }
      }

      /* ---- Tab 懒加载＋告警页 10s 轮询 ---- */
      let alertsTimer = null;
      Vue.watch(tab, (t) => {
        if (t === "brain" && !brainState.data) loadBrain().catch(() => {});
        if (t === "registry" && !store.registry.data) reload();
        if (t === "templates" && !templates.value) loadTemplates();
        if (t === "audit" && !store.registry.audit) loadAuditRows();
        if (t === "invites" && !invites.value) loadInvites();
        if (t === "alerts") {
          loadAlerts();
          if (!alertsTimer) alertsTimer = setInterval(() => loadAlerts(), 10000);
        } else if (alertsTimer) { clearInterval(alertsTimer); alertsTimer = null; }
      }, { immediate: true });

      Vue.onMounted(() => { loadNodes().catch(() => {}); loadBrain().catch(() => {}); });
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
        pubLedger, pubLoading, loadPubLedger,
        templates, templatesLoading, loadTemplates, tplEdit, tplSaving, editTemplate, saveTemplate, toggleTemplate, deleteTemplate,
        invites, invitesLoading, loadInvites, invForm, newInvite, revokeInvite, copyCode,
        nodesState, nodeProbe, gpuData, loadNodes, switchDriver, saveComfy, probeNode, yieldGpu, nodeLabelOf, enginesOf,
        nodeForm, addNode, saveNodeInfo, saveNodeApi, saveUserDriver, removeNodeCard, nodeGateOf,
        brainState, brainForm, loadBrain, brainHostOf, addBrainProfile, saveBrainProfile, removeBrainProfile, activateBrainProfile, probeBrainProfile, clearBrainProbe,
        showAddEngine, addingEngine, engineForm, lanesList, nodesList, addEngineRow, removeEngineRow, rebindEngineRow,
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
