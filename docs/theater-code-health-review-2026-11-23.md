# 剧场 Studio · 全仓代码健康深审报告（2026-11-23）

| 项 | 内容 |
|---|---|
| 版本 | v1.0（2026-11-23） |
| 评审范围 | 全仓 83 个源文件 / 约 2.7 万行：`core/` 5＋`index.js` → `api/` 20 → `dag/`（engine＋adapters＋workers 17）→ `prompts/` 4 → client 核心 7 → client views 12 → 横向扫描（鉴权覆盖/路径穿越/v-html/裸 catch/err.code 映射） |
| 评审方式 | 主会话单线程逐文件深读（用户裁决，不派子智能体）；安全项、数据风险项就地修复，workers 并行施工区（V12/V15 线）只记录不动刀 |
| 验证 | 全量验收套件回归 **14/15**；唯一 FAIL `V12_nodes_registry_ops` 经 `git stash` 往返验证在本轮改动前的 HEAD 上同样失败（并行线施工中，非本轮引入） |
| 修复足迹 | 15 个文件，＋188/−53 行 |

---

## 0. 结论（TL;DR）

骨架健康：分层清晰（router/store/bus/tenants/api/dag）、零 npm 依赖纪律、账本 append-only、确定性 uid/hash12、域投影 scopedView 设计完整。**本轮发现的系统性风险集中在三类**，全部已收口：

1. **state.json 数据丢失链**（P2）：非原子写 → 写一半崩溃 → 下次启动 JSON.parse 失败**静默回种子**＝全库清零，且损坏文件无留证；
2. **越权面缺口**（P2，14 处）：素材库全域共享是设计，但「绑定/派单/导出/停任务/读成本」可跨域操作他域实体，域隔离在素材/后期/交付/队列面断档；
3. **机检可绕过**（P2）：decide 的请求体可注入伪造 `ai_review`，假「机检通过」随决策档案固化并短路重审。

另修复：purge 漏清复审队列、可预测邀请码、17 个用户面错误码落 500、卡链断链无痕、`/s+/g` 死笔误。

---

## 1. 已修复清单（按严重度）

### 1.1 数据丢失风险（P2）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| F1 | `core/store.js` | state.json 直接 `writeFileSync` 覆盖：写一半崩溃（断电/被杀）留下截断文件 → 下次启动解析失败静默回种子，**用户全库数据被种子覆盖**；损坏文件无留证 | 新增 `writeState()`：tmp＋同目录 rename 原子替换（commit/flush/启动迁移 5 处全改走它）；损坏文件改名 `state.json.corrupt-<ts>` 留证再重建 |
| F2 | `index.js` | commit 为 50ms 防抖，退出不 flush 丢窗口内最后一次写 | SIGINT/SIGTERM → `store.flush()` 后退出 |

### 1.2 越权面（P2，14 处补齐）

原则：素材库（asset_lib）全域共享是产品决策，保留；但**目标是「他域实体」的写动作一律 404**（与 cards/episodes 既有纪律对齐；ops 角色全域通行不受影响）。

| # | 端点 | 原缺口 |
|---|---|---|
| F3 | `library.js` bind/unbind | 可把素材绑到他域场景/集/项目（篡改他域出片配置）→ 目标实体 guardWrite |
| F4 | `library.js` voice_map/:episodeId | 可改他域集的音色映射 → guardWrite |
| F5 | `library.js` characters/extract | 可从他域集提取角色入库 → guardRead |
| F6 | `library.js` readiness/:episodeId | 可读他域集开拍就绪度 → guardRead |
| F7 | `library.js` characters/:id/promote_frames | 可读他域集试镜帧池 → guardRead |
| F8 | `music.js` candidates | 可给他域场景派配乐任务（影子计费落他域）→ guardWrite |
| F9 | `music.js` adopt | 可绑曲到他域场景＋出队他域候选池 → guardWrite |
| F10 | `music.js` regenerate | 可对他域候选池/库条目换批 → guardRead |
| F11 | `deliver.js` precheck/export | 可跨域预检/导出他人剧 → guardRead/guardWrite |
| F12 | `jobs.js` GET /api/jobs | 全部任务跨域可见 → 非 ops 按域过滤（无集归属的素材级任务保持共享） |
| F13 | `jobs.js` retry/stop | 可重试/停止他域任务 → 集级任务 guardWrite |
| F14 | `costs.js` costs/:id | 可读他域集成本穿透 → guardRead |

### 1.3 机检完整性（P2）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| F15 | `cards.js` decide（edit/accept） | 请求体 `payload.ai_review` 可注入伪造机检结论（假「机检通过」随决策档案固化；edit 路径还会让 `enqueueAiReview` 判「已有审查」短路重审） | 两处 merge 后 `delete card.payload.ai_review`——机检结论只允许 `onAiReviewDone` 写入 |

### 1.4 可观测性与语义正确性（P2/P3）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| F16 | `cards.js` attachJobDoneListener | 卡链推进心脏的 catch 全静默——链断无痕，只能人工巡检 | console.error 带 job type/id |
| F17 | `library.js` jobs 回流监听 | 同上（候选池回流断链无痕） | 同上 |
| F18 | `admin.js` purge | review_q 条目不带 episodeId（只带 shotId），`drop(st.review_q)` 空转——purge 后留死条目 | 先收本集 shotId 集合，按 shotId 过滤 |
| F19 | `admin.js`/`tenants.js` 邀请码 | `Math.random()` 生成：违反自家确定性纪律（契约 §9），且可预测码＝外人可自注册 | `crypto.randomBytes(4)`；llmprofiles 档案 id 同步 |
| F20 | `core/router.js` CODE_STATUS | 17 个用户面错误码（NOT_READY/LOCKED/NOT_A_FACE/ALREADY_DECIDED/POOL_EMPTY/LLM_OFFLINE/HAS_EPISODES/PROTECTED/IN_USE…）未映射，全落 500——HTTP 语义失真 | 逐项映射（409/422/400/401/429/502/503） |
| F21 | `library.js` 候选回流 | `/s+/g` 死笔误（应为 `/\s+/g`）——歌词头被吞掉全部字母 s | 修正 |
| F22 | `core/util.js` SECRET | 演示密钥硬编码，token 可伪造 | `THEATER_SECRET` env 覆盖口（不设保持演示值＝存量 token 兼容；设了重启换签全量重登） |
| F23 | `cards.js` onVideoDone | `art.engine ? A : A` 死条件 | 清理 |

### 1.4.b 本轮自纠错（如实记录）

首轮全量回归 12/15：`music.js` adopt 路由 500——我把本文件的 `findPending` 误调到 `libMod`（library.js 无此导出）。被验收套件当场抓住，改回本文件作用域后 V10/V11 复绿。**教训与 ai-blueprint §8.8 基线对照纪律互相印证：动共享面后必须跑全量，12/15 的「并行线施工中」结论先 stash 验证再下笔。**

---

## 2. 审过且干净的面（零修改通过）

| 层 | 结论 |
|---|---|
| `core/router.js` | 鉴权先于 body 解析、参数 decode、404/405 语义、1MB 上限＋溢出丢弃——健壮 |
| `core/bus.js` | SSE 域过滤闭环（tidOf 反查）、订阅者异常隔离、ping unref |
| `core/tenants.js` | scopedView 域投影完整（projects/episodes/cards/shots/scenes/review_q/music_lib/viewRefs/voice_lines/music_pending）；guard* 三层角色闸一致 |
| `core/util.js` | timingSafeEqual 验签、单调时钟、imgSpecFor 能力回落二次钳制 |
| `index.js` 静态面 | var/client 两路 normalize＋resolve＋前缀钳制，防穿越扎实；?token= 白名单仅 events/var；凭据三路提取 |
| `dag/engine.js` | 账本诚实（worker_type 实判）、影子记账对账不变量、预算/域预算双护栏、enqueueOnce 内存防重（账本孤儿行裁决有注释背书）、POOL_EMPTY 收口 |
| `dag/workers` 扫描 | 无 shell 注入（spawn 全数组参数）、云 API key 只走 Bearer header 不落日志、adapters 全带 AbortController 超时 |
| `api/admin.js` 写面 | requireOps 全覆盖、二次确认（confirmed:true）纪律、probe 无注入面 |
| `api/l2.js` | 会话归属双核（facade uid 过滤＋路由层再核）、工具级失败 202 不冒 HTTP 错 |
| `api/templates.js`/`llmprofiles.js` | ops 闸、key 不回显（has_key）、payload 清洗截断 |
| client 全层 | `encodeURIComponent` 全覆盖、`sanitizeDeep` 展示面消毒、v-html 唯一使用点内容为开发者静态串（无用户数据插值）、无 eval/Function/外跳、token 过期 401 自动登出、SSE 退避重连封顶 15s |
| `prompts/` | validateIR fail-open 有注释背书、六段标题＋台词标签数校验 |

---

## 3. 记账未动（债务清单，按优先序）

| # | 项 | 说明 | 归属建议 |
|---|---|---|---|
| D1 | **workers 层 CWD 拼接 ×33 处** | `worker.t2i.remote.js`(9)/`t2v.remote.js`(7)/`compose.js`(5)/`t2i.local.js`(4)/`t2v.local.js`(3)…读 var/assets/cast、var/out、var/tmp 全走 `process.cwd()`。THEATER_VAR/非仓库根 CWD 下错位（与 female_ref.png 事故同根因）。api 层已统一 `varBase(ctx)` 口径，worker 层待收口。已在 `worker.t2v.remote.js:256`、`worker.t2i.local.js:91` 留 code-comment | V15 postprod 并行线顺路收口 |
| D2 | **login 无速率限制** | POST /api/login 无限尝试；8 位码可暴力。自部署内网可接受，公网部署前必须加（失败退避＋按 IP 限频） | 二期安全包 |
| D3 | `GET /api/nodes` 普通用户可见全体用户清单（uid/name/role/driver） | 运维台数据面未按角色收窄 | 节点面重构时顺路 |
| D4 | `POST /api/gpu/llm/stop` 无角色闸 | 任意登录用户可停共享 LLM；`restart_hint` 回显服务器 .bat 路径 | 同上 |
| D5 | `makeAssetIndex` 缺场景定场图/转场 art 反查 | 域隔离退化＝登录墙语义（不越权，只是少隔离） | 素材线 |
| D6 | HEAD 方法静态面回全量 body；readJsonl/账本面全量读文件过滤 | 量级小，暂无感 | 量上来再说 |

---

## 4. 回归证据

| 轮次 | 结果 | 说明 |
|---|---|---|
| 修复前基线 | 14/15 | V12 存量失败（注册表绑定断言；并行线施工中） |
| 修复后首轮 | 12/15 | 新增 V10/V11 失败＝本轮 `libMod.findPending` 笔误（§1.4.b），修后复绿 |
| 最终 | **14/15** | `TOTAL=15 PASS=14 FAIL=1`；唯一 FAIL＝V12（stash 往返验证：改动前 HEAD 同样失败，非本轮引入） |

配套行（并行会话 `0ce9d28` 已收走）：library.js Tenants import/lyrics_head、studio.js MOODS 对齐 MOOD_LIGHT。
