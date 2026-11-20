# src/client 视图层施工契约（v1 · 2026-11-20 前端重做轮）

> 背景：旧「原型壳＋live.js」已整体删除。本目录是**真系统前端**：Vue 3 免构建
> （`vendor/vue.global.prod.js`，全局 `Vue`），零 npm、零打包、零外部 CDN。
> 骨架（index.html / css/app.css / js/util.js / js/api.js / js/store.js /
> js/router.js / js/components.js / js/app.js / js/views/login.js）由主控维护，
> **agent 只写分配给自己的 `js/views/*.js`**，不得改任何骨架文件或其他 agent 的文件。
> 界面上禁止出现：「原型 / 演示 / demo / 离线回退 / 假数据」；API 失败必须呈现真实错误态＋重试。
> 语言表纪律：任何引擎型号名不得出现在用户面（骨架 `T.sanitize` 已做二次过滤，视图别绕过）。

## 0. 加载方式（无模块系统）

`index.html` 按序加载：vendor Vue → js/util.js → js/api.js → js/store.js →
js/router.js → js/components.js → js/views/*.js（按文件名序）→ js/app.js。
每个视图文件向全局命名空间注册组件：

```js
/* js/views/flow.js —— 只允许这样的外层结构 */
(function (global) {
  "use strict";
  const T = global.__T;           // 工具命名空间（骨架提供，见 §2）
  const store = T.store;          // 全局响应式 store（骨架提供，见 §3）
  const views = (global.__VIEWS = global.__VIEWS || {});
  views.Flow = {                  // 组件名 ＝ 路由表注册名（见 §5）
    components: { /* 用 T.components 里的共享组件，如 'err-state': T.components.ErrState */ },
    props: { epId: { type: String, required: true } },   // 仅带 ep 的路由会收到 epId
    setup(props) { /* Vue.setup，用 Vue.ref / computed / onMounted */ },
    template: `...`               // 模板字符串；骨架已配 Vue in-DOM？否——用 template 选项
  };
})(window);
```

- 全局可用：`Vue`（createApp/ref/reactive/computed/onMounted/watch 直接用 `Vue.ref` 等）、
  `__T`、`__VIEWS`、`__ROUTER`。
- 不引入任何新全局；不 `document.write`；不 eval。
- 样式：只允许 `css/app.css` 已有类（见 §4）＋组件内 `<style>`（template 顶部内嵌
  `<style>` 标签是允许的，类名前缀必须 `v-<视图名小写>-`，如 `v-flow-card`）。

## 1. 骨架已提供的路由（hash 路由）

| 路由 | 组件（`__VIEWS.X`） | props | 归属 |
|---|---|---|---|
| #/login | Login | — | 骨架（别动） |
| #/home | Home | — | **C** |
| #/ep/:id/flow | Flow | epId | **A** |
| #/ep/:id/shoot | Shoot | epId | **A** |
| #/ep/:id/assets | Assets | epId | **C** |
| #/ep/:id/deliver | Deliver | epId | **B** |
| #/ep/:id/costs | Costs | epId | **B** |
| #/review | Review | — | **B** |
| #/admin | Admin | — | **B** |
| #/settings | Settings | — | **C** |

`#/ep/:id`（无 tab）由骨架重定向到 `flow`。副驾（Copilot 右侧常驻栏）由骨架挂在布局上：
`views/copilot.js` 注册 `__VIEWS.Copilot`（**C** 写），骨架 app.js 以
`<component :is="'Copilot'">` 渲染；`#/login` 时骨架自动隐藏。

## 2. `__T` 工具面（骨架 js/util.js 提供，签名如下，别重复实现）

```
T.fmtYuan(cents)            // 1280 → "¥12.80"（分→元两位小数；null→"—"）
T.fmtMin(min)               // 24 → "24 分钟"
T.relTime(ts)               // ts(ms) → "3 分钟前"（<60s "刚刚"）
T.fmtTime(ts)               // → "11-20 21:43"
T.sanitize(str)             // 语言表二次过滤（引擎型号→「生成引擎」等；对服务端已消毒字段幂等）
T.humanErr(err)             // ApiError → { code, text(人话), retriable(bool) }
T.cls(...xs)                // class 合并
T.sleep(ms)
```

## 3. 全局 store（骨架 js/store.js 提供，`T.store`）

```
store = Vue.reactive({
  auth:  { ready:false, token:null, user:null },      // user:{id,name,role}
  conn:  { sse:"off"|"connecting"|"on", lastAt:0, err:null },
  state: null,            // GET /api/state 原样：{projects,episodes,scenes_by_episode,
                          //   shots_by_episode,cards_pending,review_pending,music_library,
                          //   alerts_unacked,queue,server_time}
  loading: { state:false },
  err:     { state:null },
  toasts: [ {id,text,kind:"ok"|"err"|"warn",ts} ]     // 骨架渲染
  sheet:   null           // 骨架渲染的模态：{title,html,body,actions:[{label,kind,onClick}],cas}
})
```

Actions（全部已实现，失败会 `T.toast`＋抛 ApiError，视图内 catch 后展示 ErrState）：

```
T.api  —— REST 层（见下），视图一般直接用 store actions
store.refreshState()                    // GET /api/state → store.state
store.toast(text, kind)
store.openSheet(spec) / store.closeSheet()
store.confirm({title, summary, time, cost, shots, okLabel}) → Promise<boolean>  // 开机类二次确认
// 卡流（A 用）
store.loadCards(epId)      → GET /api/cards?episodeId=  → {list, loading, error, cards:{}}
store.decideCard(card, action, payload?)  // action:"accept"|"reject"|"edit"；内部自动带 ver，STALE→sheet 提示重刷
// 拍摄（A 用）
store.loadJobs(epId)       → GET /api/jobs?episodeId=   → {list, loading, error}
store.retryJob(id) / store.stopJob(id)
store.estimate(epId)       → GET /api/episodes/:id/estimate → {est:{shots,time_min,cents,ver,breakdown}}
store.shoot(epId, ver)     → POST shoot（先内部 confirm）→ 成功 toast＋跳 #/ep/:id/shoot
// 复审/交付/成本（B 用）
store.loadReview()         → GET /api/review/queue      → {queue, pending, loading, error}
store.decideReview(item, action, reason)   // action:"pass"|"reject"|"offline"，内部带 ver
store.precheck(epId)       → POST precheck → {items:[{item,pass,note}]}
store.exportEpisode(epId)  → POST export（预检非全绿会被 422 拦→ApiError）
store.loadCosts(epId)      → GET /api/episodes/:id/costs → {data:{shots,common,total_cents,cost_cents,budget_cents}, loading, error}
store.loadBilling()        → GET /api/billing           → {rows,total,cents}
store.loadRegistry()       → GET /api/admin/registry    → {registry, langlint_exempt, loading, error}
store.setQuant(engineId,tier,reason)  // POST registry/quant；返回 {tier,audit_needed,audit_id}
store.probeRegistry() / store.loadAudit()  → {alerts,audit}
// 资产/音乐（C 用）
store.loadMusic()          → GET /api/music/library     → {library:[{id,title,mood,sec,engine,license:{model,usage},shadow_cents,sceneId}]}
store.adoptMusic(id, sceneId) / store.regenMusic(id) / store.genCandidates(sceneId,mood)
// 项目/集（C 用）
store.createEpisode({projectId,title,brief}) → POST /api/episodes → {episode}
// 副驾（C 用）
store.l2 = { sid, mode, status:"idle"|"ready"|"broken", msgs:[{me:0|1,t,ts,sig?,runtime?}],
             tasks:[{id,label,status,shot?,job_id?}], approvals:[{id,tool,args,est:{cents,time},status,ttl_until,ver}],
             used_cents:0, budget_line:8000 }
store.l2Create(mode)      // 建会话（自动按 settings.runtime_mode 或参）
store.l2Send(text, ctxChips?)   // POST messages；202 语义＝工具失败也算送达，展示 tool_outcome
store.l2Decide(approvalId, "approve"|"reject")
// 设置/登录
store.logout()
```

**SSE**：骨架已连 `GET /api/events?token=…`，事件到达后：
- `jobs` 事件 → `store.jobs.list` 内对应 job 就地更新（含 `job.art/job.result`），并 `refreshState`（防抖）；
- `cards` 事件 → `store.cards` 重取；`review` 事件 → `store.review` 重取；
- `alerts` 事件 → toast；
- `l2:<sid>` → `store.l2Event(d)`（msg_delta/task_update/approval_new/approval_resolved/tool_call/denied 全量分发）。
视图**不要**自己 new EventSource。视图轮询兜底：A 的 flow/shoot、C 的 copilot 允许 5s setInterval 调 load，`onUnmounted` 清掉。

## 4. CSS 类（骨架 css/app.css 已提供，视图优先用这些）

布局：`.app-shell .app-nav .app-main .ep-head .panel .panel-title .grid2 .row .grow .wrap .col`
内容：`.card .card-head .card-title .card-sub .kv .kv-row .badge .badge-ok .badge-warn .badge-err .chip .chip-sel .table th td .num .mono .weak .muted .sep`
按钮：`.btn .btn-primary .btn-ghost .btn-danger .btn-sm`（disabled 用 `:disabled`＋`aria-busy`）
输入：`.input .select .textarea .field .field-label`
状态：`.empty`（空态）`.err-state`（错误态：由 ErrState 组件渲染）`.loading`（骨架屏三点）`.progress .bar`
列表：`.list .list-item .list-item.active`
金额时间一律 `<b class=num>`。

## 5. 共享组件（`T.components`，骨架提供，用 `components:{ 'err-state':T.components.ErrState }` 注册）

- `ErrState` props:{ err, onRetry } —— 人话错误＋重试按钮（retriable 才给重试）
- `EmptyState` props:{ icon, text, sub }
- `Money` props:{ cents } —— 渲染 `<b class=num>¥…</b>`
- `TimeAgo` props:{ ts }
- `StatusDot` props:{ status } —— queued/running/done/failed/pending_review… 映射中文＋色点
- `LicenseBadge` props:{ license } —— `{model,usage}` → 「双许可齐 ✓ / 使用权缺失」（usage missing 红）
- `ConfirmSheet`（store.confirm 内部用，视图不直接碰）

## 6. 视图行为硬要求（验收会逐条浏览器过）

A. **flow.js**：渲染本集卡片流（pending 排前）。C1..C8 卡：主按钮「就这个」→decideCard accept；
   「让它改改」→输入 note 后 edit；「重出一版」→reject（C1 reject 会派生重生成 job——文案「重出一版，影子成本照常入账」）。
   C6 卡显示服务端 estimate 明细（store.estimate）＋「开机」按钮→store.shoot（内部 confirm 弹二次确认，含 breakdown 行）。
   C7 卡显示 payload.items 复审清单；C9 卡：候选行（标题/时长/影子成本/LicenseBadge）＋「▶ 试听」（audio 元素，src 用 `art` 字段，无 art 则禁用）＋「用这条」→adoptMusic＋「换一批」→regenMusic。
   卡流空态：引导去首页开新项目。
A. **shoot.js**：16 镜网格（shots_by_episode），每格：镜名/秒数/StatusDot/takes 数/成本 Money；
   running/queued 显示实时进度；failed/pending_review 高亮；job 操作：retryJob/stopJob（仅 running/queued 给 stop，failed 给 retry）。
B. **review.js**：复审队列（图占位用 hash 色块即可）：通过/打回（打回必填 reason，用内联输入）/下架；ver CAS 由 store 处理，409→ErrState「上下文已变」。
B. **deliver.js**：「跑预检」按钮→items 清单（✓/✗＋note）；全绿才允许「导出」（disabled 态＋toast 解释）；导出成功列出 artifacts（job.art）＋下载链接（/var 静态路径若 404 则仅列名）。
B. **costs.js**：镜头账本表（shot→takes/engine-tier/cost）、common 行、Σ对账行（total_cents vs cost_cents vs budget_cents 进度条，>1.2×预算 标红）＋「全部账单」GET /api/billing。
B. **admin.js**：注册表表格（engine/quant/lane/endpoint/published/unavail）＋「量化裁决」下拉（tier 选择→setQuant，需 reason，返回 audit_needed 时展示 audit_id）＋ 段位探测按钮（probeRegistry→逐段位 toast/表内色点）＋ 告警列表＋审计流水（最近 50 条，action 人话化）。
C. **home.js**：项目卡（state.projects）＋集列表（state.episodes：stage/decisions/cost 进度）＋「新建集」表单（projectId/title/brief→createEpisode→跳 #/ep/:id/flow）。
C. **assets.js**：曲库表（title/mood/时长/LicenseBadge/影子成本）＋「生成候选」表单（sceneId+mood→genCandidates）＋adopt 按钮。
C. **settings.js**：当前身份（token 内 user）＋L2 runtime 模式切换（A/B 单选→store.l2Create）＋「退出登录」。
C. **copilot.js**：右侧常驻三视图（对话/任务/审批 tab）。对话：消息流（me 右 ai 左；`sig/runtime` 徽标）＋输入框（Enter 发送）＋快捷指令 chips；任务列表（StatusDot）；审批列表（tool/args 摘要/est/剩余 TTL 倒计时，批准/驳回→l2Decide；approval_new 到达时 tab 角标计数）。会话未建→「连接制片助手」按钮→l2Create。断线（conn.sse==="off"）→顶部红条。

所有视图：加载中显示 `.loading`；错误显示 ErrState（含 retry）；空显示 EmptyState。**任何情况不许渲染假数据/占位演示数据**。

## 7. 提交边界

- A 只写 `js/views/flow.js`、`js/views/shoot.js`
- B 只写 `js/views/review.js`、`js/views/deliver.js`、`js/views/costs.js`、`js/views/admin.js`
- C 只写 `js/views/home.js`、`js/views/assets.js`、`js/views/settings.js`、`js/views/copilot.js`
- 需要后端配合的问题写在自己文件顶部注释 `// BACKEND-ISSUE:`，不要自己改后端。
