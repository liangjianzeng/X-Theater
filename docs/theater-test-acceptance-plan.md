# 剧场 · 全业务自动化测试与验收规划 v1.0

> 版本：v1.0（2026-11-21）｜从属：[一期计划 §0 验收总线](theater-phase1-plan.md)（冲突以总文档与计划为准）、[施工契约 §7 验收套件](../src/CONTRACT.md)、[验收报告 2026-11-20](theater-acceptance-report-2026-11-20.md)
> 定位：把「验收总线 V1–V10+U ＋ 10 用例套件」扩展为**覆盖全部业务与功能的分层自动化测试与验收体系**——补的不是"再写几个用例"，而是**分层模型、覆盖矩阵、执行节律、证据链治理**四件套。
> 纪律继承（不变）：零 npm 依赖（产品与套件）；黑盒观察（只经 HTTP ＋ `var/` 账本文件，不 require `src/` 内部模块）；确定性 stub；BLOCKED 不伪造绿灯。

---

## 0. 现状盘点（2026-11-21）

### 0.1 已有测试资产

| 资产 | 内容 | 状态 |
|---|---|---|
| `test/run.js` | 套件 runner：每用例独立服务器（spawn）＋ `THEATER_VAR` 独立账本目录、120s 超时、SKIP/FAIL 语义、`test/results.json` 输出 | ✅ 可用 |
| `test/lib.js` | 黑盒工具：startServer / makeApi / expect 断言集 / readLedger / openSse / pollUntil / buildCaseContext | ✅ 可用 |
| `test/cases/*.js` ×10 | 验收总线用例 V1/V4-lite/V5/V6/V8×2/V9×2/V10/U——**2026-11-20 实跑 10/10 PASS** | ✅ 全绿 |
| `test/selfcheck/*.js` ×5 | 模块级自查（契约 §9）：api / core / l2 / rules / workers，假依赖注入 | ✅ 可用 |
| 双端人工真验 | 验收报告 §4：桌面 1440×900 ＋ H5 390×844 九步全链路浏览器实测 | ✅ 一次性记录 |
| 真推理证据链 | `runtime/comfyui-evidence/`（V2：真 PNG 21s、显存峰值、manifest 锁定） | ✅ 先例 |
| `core` 隔离支持 | `src/server/index.js:22` 支持 `THEATER_VAR` env | ✅ 已核实 |

### 0.2 缺口清单（本规划针对的靶子）

| # | 缺口 | 证据 |
|---|---|---|
| G1 | **端点异常路径覆盖薄**：34 端点主要走了 happy path；CAS 409 / 403 / 428 / 422 / TTL 过期 / 无效入参多数只在 selfcheck 层或个别用例出现 | test/README 映射表 |
| G2 | **UI 自动化缺位**：V4 只有 lite（静态首页＋SSE）；计划判据是「Playwright 双 lane 入 CI 且全绿」 | phase1-plan V4 |
| G3 | **韧性无自动化**：kill -9 零丢单、断点续跑、失败梯子、预算护栏——只有 selfcheck 层桩测，无 HTTP 层真进程验证 | B2/C6 DoD |
| G4 | **并发与幂等未在 HTTP 层验证**：同 ver 双 decide、双客户端同时 shoot、同键不重复扣费 | 契约 §1/§2 |
| G5 | **无回归档案**：results.json 单文件覆盖写，无历史归档与趋势 | test/run.js:137 |
| G6 | **无执行节律与门禁**：没有 commit gate / 每日回归 / nightly 的定义与脚本 | — |
| G7 | **桩→真切换无标准回归 profile**：V2 evidence 是一次性手工链路，真引擎接入后无"同套件重跑"机制 | 验收报告 §6 |
| G8 | **安全面分散**：红队只在 L2（V9）；auth/role/静态产物面的系统化验证缺失 | — |
| G9 | **人工验收项无 checklist 治理**：V7 文案核查、情绪盲评、双端真验靠口头，无留痕模板 | phase1-plan V7/V10 |

---

## 1. 测试目标与质量门禁（对齐 NFR/验收判据）

| 门禁 | 通过判据 | 依据 |
|---|---|---|
| QG-1 功能正确 | 全部 L1–L3 用例 PASS；V1–V10+U 全绿；34 端点主路径＋异常路径均有断言 | CONTRACT §3 |
| QG-2 账本不变量 | Σbilling(episode)==cost_cents 在任意操作序列后成立（护栏暂停例外）；账本 append-only/monotonic | V5、契约 §1 |
| QG-3 体验宪法 | 决策计数规则（C9 不计、≤5）；标识不可绕过（export sidecar `explicit_mark`）；用户面禁词 clean | 宪法 3、V8/V10 |
| QG-4 韧性 | kill -9 零丢单；重启后账本/队列恢复；失败梯子 ≤2 免费补拍；护栏 1.2× 自动暂停 | B2/C6 |
| QG-5 安全 | 未认证 401、越权 403、跨租户 FORBIDDEN、注入拒答留痕、工具白名单不可逃逸、L2 红队双模式零越权 | NFR-05、V9 |
| QG-6 双端同等 | 桌面 lane 全量＋H5 lane 全部界面主路径全绿（裸浏览器） | V4 判据 |
| QG-7 性能锚点 | stub profile 全套件 ≤15min；样片链路秒级（stub 确定性）；真实档计时以 job 账本为唯一计时源（n≥50） | NFR-01 |
| QG-8 证据链 | 每个 Vx 可指到：用例名＋results 归档＋账本/截图/实测记录；BLOCKED 项有原因与解锁路径 | 验收报告纪律 |

---

## 2. 分层测试模型（L0–L4）

```
L4 夜检/门禁    nightly 归档报表 · 里程碑闸门 · 人工 checklist 治理
L3 UI 双端      Playwright 双 lane（仓库外工具）· 视图契约 §6 逐条
L2 业务链路 E2E 多角色全链 · 韧性 F 系列 · 并发幂等 · 安全 S 系列
L1 端点契约     E 系列（34 端点 × 主路径/异常路径）· 现有 V 用例
L0 模块自查     selfcheck ×5（api/core/l2/rules/workers）· node --check 全仓
```

| 层 | 观察面 | 谁维护 | 节律 | 现状 |
|---|---|---|---|---|
| L0 | 模块内部（假依赖注入） | 各 agent 名下 | 每次提交前 | ✅ 已有，保持 |
| L1 | HTTP ＋账本文件 | tests | 每次提交（快组）/每日（全量） | ⚠️ 10 用例，E 系列补 |
| L2 | HTTP ＋账本＋**真进程生命周期** | tests | 每日 | 🆕 F/S/P 系列 |
| L3 | 真浏览器（双端） | tests（Playwright spec） | nightly | 🆕 仓库外工具 |
| L4 | 结果归档＋报表＋闸门 | tests＋发起人 | nightly/里程碑 | 🆕 |

---

## 3. 用例编号体系

在现有 **V**（验收总线）、**U**（量化裁决）之外新增四个系列，与 V 并列进 `test/cases/`、纳入同一 runner（`node test/run.js E1 F1 …` 前缀过滤已支持）：

| 系列 | 语义 | 观察面 | 超时建议 |
|---|---|---|---|
| `E*` | 端点契约与异常路径 | HTTP | 60–90s |
| `F*` | 韧性/故障注入/并发 | HTTP＋进程＋账本 | 120–180s |
| `S*` | 安全（auth/role/治理扩展/账本完整性） | HTTP＋账本 | 60–90s |
| `P*` | 不变量 property（随机序列×固定种子） | HTTP＋账本 | 120s |
| `N*` | UI lane 的 API 侧前置（给 Playwright 造数） | HTTP | — |

---

## 4. 覆盖矩阵

### 4.1 端点矩阵（34 路径 × 现状 × 补测）

现状标注：✅=已有用例覆盖主路径；△=仅间接/部分；🆕=本规划补。

| 组 | 端点 | 现状 | 补测 |
|---|---|---|---|
| 认证 | POST /api/login | ✅ V1 | E1（无效码/结构化 error/伪造 Bearer） |
| 总览 | GET /api/state | ✅ V8/V1 | E1（未认证 401）、E12（形态校验） |
| SSE | GET /api/events | ✅ V4-lite/V9 | E10（:ping 15s 心跳、?session= 过滤、retry 重连帧、未知 topic） |
| 链路 | POST /api/episodes | ✅ V1 | E12（空体/未知 projectId/超长 brief） |
| | GET /api/cards | ✅ V1 | E3（status 过滤、music_enabled=false 不出 C9） |
| | POST /api/cards/:id/decide | ✅ V1/V10 | E3（同 ver 双 decide 一胜一 409 STALE、edit 生效、reject 重出新 ver、无效 action、C9 不计 decisions） |
| 预估开机 | GET /api/episodes/:id/estimate | △ V1 | E4（ver 存在、breakdown 完整、重复调用稳定） |
| | POST /api/episodes/:id/shoot | ✅ V1 | E4（ver 不符 409、paused 拦截 BUDGET、重复 shoot 行为口径） |
| 任务 | GET /api/jobs | ✅ V1/V4 | E5（status/episodeId 过滤、账本行按 job_id 折叠口径） |
| | POST /api/jobs/:id/retry · /stop | △ V4 | E5（stop 只对 queued/running、failed 才可 retry、未知 id 404 结构） |
| 成本 | GET /api/episodes/:id/costs | ✅ V5 | E12（未知集 404） |
| | GET /api/billing | △ V5 | E2（creator 是否 403——ops-only 口径裁决） |
| 交付 | POST /api/episodes/:id/precheck | ✅ V10 | E4（清单项穷举：分辨率/显式/隐式/字幕/双许可） |
| | POST /api/episodes/:id/export | ✅ V10 | E4（422 BLOCKED_PRECHECK 结构、paused 拦截、重复导出幂等口径） |
| 配乐 | POST /api/music/candidates | ✅ V10 | E6（未知 sceneId、mood 缺省行为） |
| | POST /api/music/:id/adopt | ✅ V10 | E6（重复 adopt、missing 许可曲 adopt 仍允许但预检拦——契约口径） |
| | POST /api/music/:id/regenerate | 🆕 | E6 |
| | GET /api/music/library | △ V10 | E6（license 双标记字段完整） |
| 审片 | GET /api/review/queue | ✅ V6 | E7（种子项治理：THEATER_VAR 隔离后每轮新种子） |
| | POST /api/review/:id/decide | ✅ V6 | E7（reject→flags.stale→重拍回流、offline、ver CAS、creator 403） |
| 后台 | GET /api/admin/registry | ✅ U | E8（exempt 面显原值——V8 豁免口径回归） |
| | registry/:engineId（写档） | △ U | E8（无 confirmed 428——已有；扩展：非法 tier 409） |
| | registry/quant · endpoint · model | ✅ U | E8（audit #Q-xxx 留痕回归） |
| | registry/probe | 🆕 | E8（stub 探测全绿＋告警语义） |
| | GET /api/admin/alerts · simulate | ✅ V6 | E8（ack 语义、kind 过滤） |
| | GET /api/admin/audit | △ V6/U | E8（kind 过滤、≥6 个月留存口径） |
| L2 | POST/GET /api/l2/sessions | ✅ V9×2 | E9（无效 mode、broken session、预算 8000 分断线） |
| | GET /api/l2/sessions/:id | ✅ V9 | E9（跨会话取数 FORBIDDEN 回归） |
| | POST /l2/sessions/:id/messages | ✅ V9 | E9（202 语义、ctx chips 绑定本集——验收报告 §5-1 残留项的回归位） |
| | POST /l2/approvals/:id | ✅ V9 | E9（TTL 60s 过期拒、令牌一次性重放拒、ver CAS） |
| 静态 | GET / · /var/out/* | △ V4-lite | E11（index.html 形态；**/var/out 产物面鉴权口径待裁决**，见 CORE-TEST-2） |
| 404 面 | 未知路径/二期 13 端点 | ✅ V8 | E11（任意未知路径统一 `{error:{code,message}}`） |

### 4.2 业务链路矩阵（场景级）

| 场景 | 主链 | 用例 |
|---|---|---|
| S1 一句话成片（creator 全链） | 登录→建集→C1..C6 拍板→开机→16 镜→复审→C7/C8→交付 | V1（stub）＋U2-桌面 lane（真浏览器） |
| S2 小说改编批量 | 贴长文本→分集→批量出集 | E3 扩展（novel kind 入参）；UI 侧随 U1 |
| S3 移动审片（制片人） | H5 逐镜大按钮通过/重拍＋撤销 | U2-H5 lane（对齐 V4「核心链路双端各跑一遍」） |
| S4 配乐交付 | 情绪候选→adopt→双许可预检→导出 | V10 |
| S5 副驾驾驶 | 5 类任务＋审批＋红队 | V9×2＋E9＋S2 |
| S6 运营值守 | 复审处置→告警→审计→调档 | V6＋E7＋E8＋U |
| S7 故障续跑 | 拍摄中途 kill -9→重启→零丢单 | F1 |

### 4.3 UI 视图 × 双端矩阵（12 视图，对齐 VIEWS-CONTRACT §6 硬要求）

| 视图 | 桌面 lane（1440×900） | H5 lane（390×844） |
|---|---|---|
| login | 邀请码登录、错误态 | 同左＋软键盘不遮输入 |
| home | 项目卡/集列表/新建集 | 主行动可达＋无横向溢出 |
| flow | 卡流逐卡（就这个/让它改改/重出一版）、C6 开机二次确认、C9 试听/用这条/换一批 | 两列墙/单列流、底部 sheet、拇指热区 |
| shoot | 16 镜网格、StatusDot、retry/stop（活队列才给） | 全功能：重拍确认＋5s 撤销、护栏处置 |
| review | 复审队列、打回必填 reason | 降格形态（队列＋一键处置） |
| deliver | 预检清单→全绿才可导出→artifacts 链接 | 三步向导 |
| costs | 镜头账本、Σ 对账行、水位条 | 折叠卡形态 |
| admin | 注册表（显原值）、调档需理由、probe、审计 | 告警落地页形态 |
| assets | 曲库表、LicenseBadge、生成候选 | 主行动可达 |
| settings | 身份、A/B 模式切换、退出确认 | 同左 |
| copilot | 三视图、审批 TTL 倒计时、上下文芯片、快捷指令 | 中央一级 tab、fab 不遮输入（回归 6f07b6d/ce39fcf 修复位） |
| 连接指示器 | SSE「实时连接正常」 | 同左 |

执行方式见 §5.5；**判据**：桌面全量＋H5 全部主路径全绿＝V4 达标证据。

### 4.4 FR/NFR 映射（P0 项全部有测试落点）

| FR/NFR | 测试落点 |
|---|---|
| FR-102/103 五级树/系列 | 种子 p1/e1 形态断言（E12）；多级树 CRUD 一期仅项目/集两级，如实标注 |
| FR-104/305 演员表/签约锁定 | C2 卡链（V1） |
| FR-106 风格圣经锁定 | C3（V1） |
| FR-201/202 策划案/自动分集 | C1（V1＋E3 novel kind） |
| FR-301/302 自动选角/4 候选 | C2（V1） |
| FR-401/403 美术锁定/回滚警示 | C3（V1；回滚强警示属 UI 项→U1） |
| FR-501/503/505 镜头表/分镜图/开机预估 | C4–C6＋estimate（E4） |
| FR-601/603/606 批量 i2v/重拍/护栏 | V1＋F3（护栏）＋F2（失败梯子＝系统重拍 ≤2 不计费） |
| FR-701 分场配乐 | V10 |
| FR-803/804 标识强制/平台规格 | V10 sidecar `explicit_mark:true`＋meta 断言 |
| FR-901 决策卡流五类必答 | V1（决策计数恰 5） |
| FR-902 移动审片 | U2-H5 |
| FR-1101 邀请登录 | E1 |
| FR-1102/1104 影子记账/成本穿透 | V5＋P1（property 化）＋costs 页（U1） |
| FR-1204/1209 L2 副驾/护栏三层 | V9×2＋E9（预算断线）＋S2（白名单穷举） |
| FR-1301 机审→复审→留痕 | V6＋E7 |
| FR-1302 worker 探活 | E8 probe |
| NFR-01 计时唯一源 | real profile 断言从 job 账本时间戳取数 |
| NFR-03 断点续跑/幂等 | F1＋F4 |
| NFR-04 ≤5 决策/LCP | P3＋U1（LCP 用 Playwright trace 采样，软指标） |
| NFR-05/06 安全/合规 | S 系列＋V8＋V7 checklist |
| NFR-08 agent 不自主昂贵动作 | V9 红队＋S2 |

### 4.5 验收总线映射（V1–V10+U ↔ 套件）

维持 test/README.md 映射表不变；本规划新增用例**不改变 V 编号语义**，只把每个 Vx 的证据从「单一用例」加厚为「主用例＋异常路径＋UI lane＋账本证据」四件套。Gated 项维持 BLOCKED 纪律：V3（Spark）、真实 DSH、ACE-Step 真生乐、V2 视频段（LTX-2.5）。

---

## 5. 关键专项设计

### 5.1 桩→真双 profile 回归（G7）

- runner 增加 `--profile stub|real`（默认 stub）。profile 只影响**断言分层与超时**，不改用例逻辑：
  - `stub`：确定性秒级；断言 worker_type 白名单（`self-host-stub`）。
  - `real`：worker 已切真推理（契约 §4 切换面）——结构断言全部不变；新增**媒体断言升级**：产物魔数（PNG `\x89PNG`/MP4 `ftyp`/MP3 `ID3|0xFFEx`）、尺寸/时长合理区间、耗时上限（定妆 <45s、样片 <3min）、`prompt_id`/seed 留痕进账本。
- 真实档证据目录固化为 `runtime/evidence/<date>-<item>/`（沿用 comfyui-evidence 先例）。
- 硬件 gated 项（V3/DSH/ACE-Step/LTX-2.5）：每项一个 gated spec（env `THEATER_REAL_<X>=1` 才跑），未解锁时 runner 输出 `SKIP(gated: …)` 并进报告 BLOCKED 区——**SKIP 不算失败，但必须在验收报告可见**。

### 5.2 韧性/故障注入（G3，F 系列）

黑盒可做的：真进程 kill（lib 已 spawn，kill -9 后同 `THEATER_VAR` 重启）、账本/状态文件核验、并发 HTTP。
黑盒做不了的，列 **CORE-TEST 配合项**（不破黑盒纪律——契约级 env 开关，生产默认关）：

| 项 | 请求 core | 服务于 |
|---|---|---|
| CORE-TEST-1 | `THEATER_FAULT=worker_fail:<lane>,rate=1` 等注入 env | F2 失败梯子、F5 watchdog |
| CORE-TEST-2 | 裁决 `/var/out/*` 静态面鉴权口径（公开 or auth） | E11/S 系列 |
| CORE-TEST-3 | 重启后 `running` 行的收尾语义确认（接管 or 标 stale） | F1 断言 |

### 5.3 安全（G8，S 系列）

- E1/E2 承载 auth/role 全矩阵（401/403，对齐 selfcheck/core 已证的 401/403/404/405/409/413 映射）。
- S2：V9 红队三案之外扩——**写侧工具白名单穷举断言**（6 工具之外全部拒）、approval 令牌一次性（重放拒）、ctx 跨集探测。
- S3：写侧产物回流面（C 卡 payload、agent 输出、alert msg）再过禁词表——防「消毒只做 /state 一层」。
- S4：账本完整性——重启后行数单调不减、ts 单调、id 唯一、append-only（改写尝试被文件系统事实证伪）。

### 5.4 不变量 property（G4，P 系列）

- P1：随机操作序列（固定 hash 种子、n≥30 序列）后 Σbilling==cost_cents 仍成立（护栏暂停例外记 system 补差行）——V5 的 property 化。
- P2：确定性——同输入双跑，stub 产物哈希一致（对齐契约 §9 确定性纪律）。
- P3：decisions 计数规则跨卡型穷举（C1–C8 计、C9 不计）。
- P4：estimate_ver→shoot_confirmed_ver 链式 CAS 全路径。

### 5.5 UI 双 lane（G2，Playwright 仓库外）

- **零依赖纪律不破**：产品与 test/ 仍零 npm；Playwright 是**开发基建**，落 `tools/ui-lane/`（独立 package.json，`node_modules` 入 .gitignore），只在本机/CI 跑，不被任何 `src/`、`test/` 文件 require。
- 结构：`tools/ui-lane/specs/desktop/*.spec.mjs`＋`specs/h5/*.spec.mjs`＋`playwright.config.mjs`（两 lane＝两个 project：viewport 1440×900 / 390×844）。目标服务＝`node src/server/index.js`（THEATER_VAR 指向 lane 专用临时目录）。
- 范围控制（防维护成本失控）：**只锁 VIEWS-CONTRACT §6 硬要求＋4.3 矩阵行**，不做像素级比对；截图留档 `tools/ui-lane/artifacts/` 作人审参考。
- 判据：桌面 lane 全量＋H5 lane 全部主路径全绿 ⇒ V4 达标证据（替代"一次性人工真验"为可重复机器证据）。

### 5.6 硬件项与人工项治理（G9）

| 项 | 处置 |
|---|---|
| V2 真生图 | ✅ 已 PASS（comfyui-evidence）；real profile 化后回归 |
| V3 Spark / LTX-2.5 / ACE-Step / DSH 真实例 | gated spec＋BLOCKED 报告区（5.1） |
| V7 合规文案（名单留档/协议挂出/水印目检） | **人工 checklist 模板** `docs/acceptance-manual-checklist.md`：脚本负责起环境＋产出物准备，人逐条勾选＋签名留痕，纳入闸门材料 |
| V10 情绪盲评 ≥4/5 | 同上（盲评表模板化，n 曲目×评委记录） |
| 双端真验抽查 | 机器 lane 全绿后，人工按 §4.3 抽 3 条主路径复验留痕 |

---

## 6. 基础设施改动清单（文件级）

| 文件 | 改动 | 批次 |
|---|---|---|
| `test/run.js` | ＋`--profile`/`--report-dir` 参数；结果归档 `test/reports/<date>-<profile>.json`（results.json 保持最新快照） | T0 |
| `test/lib.js` | ＋restartServer（kill→重启同 var）、killTree、collectStringValues 公开、property 种子工具 | T0/T2 |
| `test/cases/E1..E12*.js` | 新增 12 文件（见 §4.1） | T1 |
| `test/cases/F1..F4*.js` | 新增 4 文件 | T2 |
| `test/cases/S2..S4*.js` | 新增 3 文件（S1 归 E1/E2） | T3 |
| `test/cases/P1..P4*.js` | 新增 4 文件 | T2 |
| `test/gate.js` | 门禁脚本：node --check 全仓→selfcheck×5→快组用例（E1/E2/E3＋V 系列子集），exit code 即门禁 | T0 |
| `tools/ui-lane/*` | Playwright 工具目录（独立 package.json） | T4 |
| `docs/acceptance-manual-checklist.md` | 人工项 checklist 模板 | T5 |
| `.gitignore` | ＋`tools/ui-lane/node_modules/`、`tools/ui-lane/artifacts/` | T4 |

---

## 7. 执行节律与门禁

| 节律 | 内容 | 时长预算 | 触发 |
|---|---|---|---|
| 提交前（gate） | node --check＋selfcheck×5＋快组（E1/E2/E3） | ≤3min | 每次提交 |
| 每日回归 | 全量 L1/L2（V＋E＋F＋S＋P，stub profile） | ≤15min（QG-7） | 手动或 Actions |
| nightly | 每日回归＋UI 双 lane＋归档报表 | ≤25min | GitHub Actions cron（origin 已在 GitHub）或本地任务计划程序 |
| 里程碑闸门（M1/M2） | 全量＋real profile（已解锁硬件项）＋人工 checklist＋BLOCKED 区盘点 | 半天 | 闸门周 |

失败处置纪律：nightly 红灯→当轮修复或登记「已知红」进验收报告 §残留（不许静默跳过）。

---

## 8. 证据链与报告治理

- **可追溯三元组**：每条验收判定 →（用例名，results 归档文件，证据物路径）。证据物＝账本 JSONL / results.json / 截图 / comfyui-evidence 类目录 / 盲评表。
- **归档**：`test/reports/` 按日期保留（gitignore 不含它——归档即证据，进仓库）；`results.json` 仅为最新快照。
- **报告节奏**：验收报告每轮更新附 results 摘要＋缺口趋势（G1–G9 逐条闭合记录）；BLOCKED 区持续列出硬件项与解锁条件。
- **人工项**：checklist 文档随闸门提交，勾选＋日期＋签名。

---

## 9. 实施路线图

| 批次 | 内容 | 工作量 | 出口判据 |
|---|---|---|---|
| T0 基建 | gate.js、profile/归档参数、lib 增工具 | 1pd | `node test/gate.js` 可跑且 ≤3min；归档落盘 |
| T1 端点全覆盖 | E1–E12 | 2pd | §4.1 矩阵无 🆕 剩余；全套件仍全绿 |
| T2 韧性＋property | F1–F4、P1–P4（含 CORE-TEST-1/3 对接） | 2pd | kill -9 零丢单可重复演示；P1 随机序列 30 轮全绿 |
| T3 安全收口 | S2–S4＋CORE-TEST-2 裁决 | 1pd | QG-5 全绿；静态面口径有裁决记录 |
| T4 UI 双 lane | tools/ui-lane 双 project＋spec 12 视图 | 3–4pd | V4 判据达标（双 lane 全绿＋CI 可跑） |
| T5 治理收尾 | 人工 checklist 模板、nightly 化、报告模板 | 1pd | nightly 首跑归档；checklist 随 M 闸门可用 |

合计 ≈ **10–11pd**（不含 nightly 日常维护）。其中 T4 的施工量与 phase1-plan B9（Playwright 双 lane，已含在 WBS）重叠——B9 施工时按本规划 §5.5 的 spec 范围执行，避免二次排期。

---

## 10. 风险与预案

| 风险 | 信号 | 预案 |
|---|---|---|
| 黑盒故障注入能力不足 | F2/F5 无法触发 | CORE-TEST-1 契约级 env；core 未给前 F2 标 SKIP(需 CORE-TEST-1)，不伪造 |
| Playwright 引入摩擦（Windows/浏览器下载） | lane 起不来 | 先 H5 单 lane 最小 spec 上线，桌面 lane 跟进；报告如实标部分 lane |
| UI spec 维护成本失控 | 每轮 UI 修复后 spec 大面积红 | 只锁契约 §6 硬要求；选择器走 data-testid 约定（client 契约补充一行，T4 提出） |
| stub 语义漂移导致套件脆弱 | 假设类断言频繁 FAIL | 沿用 test/README「假设→核实→转正」流程；P2 确定性断言兜底 |
| 单机并发跑套件端口冲突 | 并行 CI 抢端口 | BASE_PORT 分段（profile×lane 错开）；runner portIndex 已有 |
| nightly 长期无人看 | 归档积压无趋势 | 报表固定入周五评审（对齐 phase1-plan §5 周动作） |

---

## 11. 范围外（出现即范围蔓延）

商业 API/BYOK/实名/价目（二期 404 面仅反向断言，V8 已有）、原生 App、L3 自定义助手、P2/P3 级 FR（三视图/口型/模板市场等——测其「预留槽位 404/占位」而非功能）、像素级视觉回归、压测/容量外推（归 C6/C7 硬件实测线，不在本套件）。
