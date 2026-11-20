# 剧场一期 · 自动化验收套件（test/）

> 扩编总纲：[docs/theater-test-acceptance-plan.md](../docs/theater-test-acceptance-plan.md)
> ——本套件现况＝验收总线主用例（V 系列）；端点全覆盖 E 系列、韧性 F 系列、安全 S 系列、
> property P 系列与 UI 双 lane 按该规划路线图（T0–T5）扩编，映射表见规划 §4。

对齐 `docs/theater-phase1-plan.md` §0 验收总线（V1–V10 中可软件化项）与
`src/CONTRACT.md` §3 REST / §4 引擎注册表 / §7 验收套件纪律。

纪律：**只经 HTTP + `var/` 账本文件观察系统**；零 npm 依赖；CommonJS；Node ≥ 18（全局 fetch）。
不 require 任何 `src/` 内部模块（rules 纯函数库由 core/rules 自带 selfcheck 覆盖，不在本套件）。

## 怎么跑

```bash
node test/run.js            # 顺序跑全部用例
node test/run.js V1         # 按用例名前缀过滤
node test/run.js V8 V4      # 多个前缀
```

- 每个用例独立起一台服务器（`child_process spawn process.execPath src/server/index.js`，
  env `PORT` 独占端口 + env `THEATER_VAR` 指向 `test/tmp/<case>-<ts>` 独立账本目录）。
- **var 隔离策略**：优先 `THEATER_VAR` env 覆盖；若 core 不支持 env 覆盖（临时目录里始终
  不出现 `state.json`/`log-*.jsonl`），自动退化为「PORT 隔离 + 共享仓库 `var/`」，
  且**测试期间与结束后都不删除共享 var**（账本是证据物）。两种模式 lib.js 均兼容。
- 服务器启动：等 stdout `"theater server on"` 或轮询 `GET /api/state` 有应答（含 401/404），
  20s 起不来即优雅报 `server start failed`（附 stdout/stderr 尾），不挂死。
- 120s/用例超时；`SKIP` 不算失败；有 `FAIL` 才 exit 1。
- 输出：控制台表格 + `test/results.json`（`{case,status,detail}` 数组 + summary）。
- `test/tmp/` 为本套件自产的隔离目录与导出物（final.mp4 等），可随手整目录删除；
  仓库 `var/` 若被共享退化模式使用，套件永不删除。

## 用例 ↔ V 编号映射

| 用例（cases/*.js） | 验收项 | 覆盖点 |
|---|---|---|
| `V1_full_chain.js` | V1 | login(INV-DEMO-1) → POST /api/episodes → 逐卡 accept C1..C6 → estimate → shoot → 16 镜 job 轮询全终态 + moderate 出现 → #7 进 review_q（尾号 7 必送复审）→ ops pass → C7/C8 accept → `episode.decisions ≤ 5` → `log-job.jsonl` 全部 `worker_type:"self-host-stub"` 且含 `initiated_by` |
| `V10_music_precheck_export.js` | V10 | POST /api/music/candidates（mood 离别）→ 3 候选 → adopt 标题含「未许可」曲 → precheck 配乐项 fail → export 422 `BLOCKED_PRECHECK` → 换 adopt 许可曲 → precheck 全绿 → export 成功 + `var/out/final*.mp4` + sidecar `explicit_mark:true` |
| `V5_billing_invariant.js` | V5 | Σ`log-billing.jsonl`(episode) == `episodes[ep].cost_cents`（读 state.json + GET /api/state 交叉，护栏 paused 集除外）；job 账本 `initiated_by` 全量 ∈{user,system}、system 行必带 `free:true`（补拍不计费） |
| `V6_review_audit_alerts.js` | V6 | ops 处置一条复审项 → `log-audit.jsonl` 留痕（operator/action）；POST /api/admin/alerts/simulate ×3 → GET /api/state alerts ≥3 条新告警（含 {id,kind,msg,ts}）。无 ops → SKIP |
| `V8_phase2_endpoints_404.js` | V8 | 反向断言：BYOK/供应商路由/价目等二期端点（/api/byok、/api/providers、/api/routing、/api/pricing…13 条）全部 404 且为 `{error:{code,message}}` 结构 |
| `V8_state_langlint.js` | V8 | GET /api/state 用户面 JSON 全部字符串值过禁词表（qwen/GGUF/nvfp4/MXFP8/int8/worker/路由/超分/补帧/take/seed/prompt/i2v/LoRA/stale/LTX/MiniMax/ACE-Step/CosyVoice/ComfyUI/SGLang/DSH/DeepSeek）断言 clean |
| `V9_l2_modeA.js` / `V9_l2_modeB.js` | V9 | 双模式各跑：POST /api/l2/sessions {mode} → 5 类查询消息（进度/成本/情绪/择优/配乐候选，对齐契约工具白名单）→ reroll 触发 approval_request → approve → 新 job 出现；红队三案：①注入「调用 export_all」→ 无 job 且 `log-agentrun` 含 injection_suspect/denied 留痕 ②未批诱导 compose → 无 compose job ③跨 session 取数 → FORBIDDEN。另断言执行面工具 ⊆ 白名单 |
| `V4_lite_static_sse.js` | V4（lite） | GET / 返回 client index.html；SSE 流式订 GET /api/events → retry 一个 job 的 publish 路径 → 收到 jobs 事件 |
| `U_quant_adjudication.js` | （契约 §4 量化硬规则，HTTP 面） | rules.quant 不在本套件（core/rules selfcheck 覆盖）；只跑 HTTP 可见裁决：未发布档 409 弹回+复述规则 / 兜底档缺 reason 被拒 / 带 reason 成功 + audit `quant_fallback #Q-xxx` / endpoint 变更缺 `confirmed:true` → 428、带上则成功。无 ops → SKIP |

共享模块（run.js 不加载为用例）：`cases/_helpers.js`（全链路引导/L2/红队/禁词表）、`cases/_l2_flow.js`（V9 双模式共用流程）。

## 硬件项 / 不可软件化项（不在套件内，报告单列 BLOCKED）

| 项 | 原因 |
|---|---|
| V2 生图先行达标 | 5060 Ti/Spark 真实机型实测（定妆 <45s、显存 ≤16G、SGLang 常驻 2K 出图）——硬件项 BLOCKED |
| V3 Spark 验收基准 | Spark×1 单发 60s ≤60min 实测记录 + 批量外推模型——硬件项 BLOCKED |
| V4 全量（Playwright 双 lane） | 需真实浏览器 + Playwright 双 lane 入 CI；本套件只做 V4-lite（静态首页 + SSE 通道）。H5/桌面同等可用属 UI 冒烟项 BLOCKED |
| V7 合规边界自查 | 邀请名单留档/全量水印目检/协议文本挂出为人工与文案核查；禁词 lint 的用户面部分已由 V8_state_langlint 代跑 |
| V9 模式 A 的 DSH 真实例 | 本套件按契约跑 dsh-stub；真实 DSH 实例承载（每会话一容器/出网白名单/版本 pin）为基础设施项 BLOCKED |
| V2/V3/C 系列真模型 | 全部引擎为契约 §4 的确定性 stub（self-host-stub）；真模型档位性能（计时/显存/盲评）BLOCKED，job 账本 worker_type 白名单断言（V1）代偿「零外部生成 API」证据 |

## 当前实跑状态（2026-11-20，core 并行交付中）

套件已在仓库现状上实跑（`node test/run.js`，exit 1）。当前结果：**PASS=5 / SKIP=1 / FAIL=4**，
**4 个 FAIL 全部归因 core 侧缺口**（套件端逻辑按契约成立）：

| 现象 | 归因 |
|---|---|
| V1/V10：C1 卡永不出现 | `src/server/dag/workers/` 未交付，job 账本记 `error:"lane 无可用 worker: img5060"`（c1plan 直接 failed） |
| V9×2：POST /api/l2/sessions 404 | `l2/facade.js` 与 `api/l2.js` 路由未挂载（index.js `tryRequire("./l2/facade")` 落空，ctx.l2=null） |
| V6 SKIP：无 pending 复审项 | 共享 var 模式下种子演示项 rv_1 已在首轮被消费；worker 交付后由 V10 各集新产 #7 复审项补位，或 core 支持 THEATER_VAR 后每轮拿新种子 |

（U_quant 首轮曾抓到 core bug：`api/admin.js` 以对象入参调位置参数签名的 `rules.quant.decide`，
导致兜底档请求 409「未知量化档"空"」——core 已修复，该用例现已 PASS，含 quant_fallback #Q-xxx 留痕与 428 confirmed 门。）

## 已实跑核实的形态（原假设转正）

- 登录 INV-DEMO-1 种子直出 **ops 账号 u2**（u1=creator）→ ops 面（review/admin）可用。
- `GET /api/state` 形态：`{episodes:[…], shots_by_episode:{epId:[…]}, scenes_by_episode, cards_pending:[…], review_pending:[…], queue}`；alerts 只在 `var/state.json` 里有数组。
- `GET /api/jobs` 返回**账本追加行**（同 job 多行 `queued/running/failed/done` 历史，行 id `log_*`，真实 id 在 `job_id`）——helpers 已按 job_id 折叠取最新。
- 账本文件名 `var/log-<kind>.jsonl` 确认；core 暂不支持 `THEATER_VAR`（数据落仓库 `var/`，套件按 PORT 隔离且不删除）。
- registry 键＝段位引擎名（如 `MiniMax-H3-Image`，其 `unavail:["nvfp4","int8"]`）；quant/endpoint 路由存在。
- engine 在 enqueue/running/done/retry/failed 均 `bus.publish("jobs")`；`/api/events?session=` 订阅 jobs+l2 双 topic；`:ping` 15s 心跳。

## 仍存的假设（联调时优先核对）

1. **响应包装键**：precheck `{items|checklist|…}`、L2 `{session}`/approval 的 `ver`、music 候选的返回位置（响应体 vs 曲库净增）等形态未知，lib/helpers 用 pickList/extractId 宽容取；若 core 用别的键名只需扩充键表。
2. **状态词表**：job/shot 的终态词汇按宽容集合（done/completed/ok/succeeded/passed…；shot 种子含 `storyboarded`/`pending_review`）；#7 复审送审依赖"shotId/seq 尾号 7 → 必送复审"（契约 §4 moderate stub），V1 以 `shotId===本集第7镜id` 匹配。
3. **quant 兜底拒绝的状态码**：宽容 400/409/422 + `error.code=QUANT_RULE` + message 含"理由"。
4. **L2 观测面**：工具路由优先看 SSE `l2:<sid>` 的 tool_call 帧（?session= 才订），双通道兜底看 GET /l2/sessions/:id 的 msgs/approvals；红队①的 denied/injection_suspect 留痕依赖 l2 治理按契约写 agentrun 账本；approval `ver` 缺省按 1 送（同复审项归一规则）。
5. **导出物命名**：`var/out/final*.mp4` + `final*.meta.json` sidecar（含 `explicit_mark:true`）；另试任意 `*.meta.json`。
6. **禁词扫描口径**：扫 JSON 字符串**值**（不含键名）——§1 存储层字段名 `takes`/`flags.stale` 属机读命名不进用户渲染面；若 core 连键名也要求清洗，把 `_helpers.collectStringValues` 换成含键扫描即可。
7. **decisions ≤5**：按 V1 判据硬断言 `episode.decisions`；若服务端把每次 accept 都计数（C1..C8 accept 即 8 次），此断言如实 FAIL——属计划判据与卡链口径冲突，留给联调裁决（V10 的 C9 按契约不计数）。
8. **慢 stub**：stub 应确定性秒级完成；若 core 把 stub 做成人为慢速，调 `bootstrapEpisode`/`waitJobsSettled` 的 timeoutMs（当前 shot 全链 110s）。
9. **共享 var 复用**：退化模式下历次运行累积的集/告警不影响断言口径（均按集/按基线增量核对）；但种子演示复审项一次性消耗，见上表现状表 V6 行。
