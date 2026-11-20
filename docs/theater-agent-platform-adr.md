# ADR-003 · 智能体平台：三层 Agent · 人格 · 技能 · DSH 嵌入决策

> 状态：**已决策（2026-11-20）**
> 背景：剧场业务流（剧本解析/扩写/分镜/抱怨翻译/运营辅助）大量需要 LLM+Agent 辅助；要求支持①智能体助手能力嵌入 ②人格定义 ③技能建立与积累。
> 问题原话：「Agent 能力是否可以直接使用已部署的 DeepSeek Harness（DSH）去嵌入实现？」
> 前提（承前）：剧场 = 全新独立项目，全云端，**完全独立产品（与任何既有应用零绑定，[ADR-002](theater-client-web-adr.md)）**；算力后端已决（[ADR-001](theater-infer-backend-adr.md)）。
> 关联：[theater-ux-design.md](theater-ux-design.md) §3.1（AI 制片组——本文把该隐喻落成工程事实）

---

## 0. 结论

1. **剧场自建服务端 Agent 平台，作为多租户核心**。判据：agent loop 本身不是护城河（成熟库几百行），**工具面（theater API 的 MCP 化）+ 人格 + 技能 + 治理才是**——这四样必须自家持有；**runtime 不必自建（发起人 2026-11-20 裁决）：L2 runtime 由已部署的 DSH 实例承载**，平台自持四件套＋控制面（实例编排/授权/预算熔断/审批终裁/审计汇聚）；
2. **DSH 三层嵌入判定**：

| 用法 | 判定 | 说明 |
|---|---|---|
| ① LLM 模型通道 | **✓ 立即采用** | 剧场模型网关的 LLM 主力走 DSH 已验证的 DeepSeek 通道；复用「通道与调参经验」，不复用循环代码 |
| ② 直接当 SaaS 核心 runtime | **✓ 承载 L2 runtime（发起人 2026-11-20 裁决，推翻原「✗ 当前形态」）** | 承载模型＝**每会话一个 DSH 沙箱实例**：容器级隔离把「单用户形态」化解为实例属性（§5.2 四反模式逐条化解）；DSH 承担 agent loop／tool-use 编排／会话轨迹，剧场保留控制面与全部裁决权——工具面只许 theater-mcp 白名单（DSH 自带 shell/文件/代码执行工具**整体禁用**红线不变）；§5.4 六条从复审窗口转为准入硬验收 |
| ③ 当外部智能体客户端 | ✓ **一期＝接口契约文档化（第一天做契约，不做接入）；试点接入＝P2**（与 §7/总文档 FR-1210 期别一致，终审对齐） | 剧场把工具面以 **theater-mcp** 暴露，DSH（已支持 MCP 类工具面）未来可作「制片主任的外挂操作台」接入；同时是 P3 外部智能体生态的首个验证（业界先例：可灵向外部 Agent 开放 MCP/CLI 调度出片） |

3. **平台纪律（凌驾于一切 agent 能力之上）**：**workflow-first，agent-assisted**——八阶段流水线是确定性 DAG 骨架，agent 只承担语言与判断（解析/改写/翻译/推荐），**昂贵动作（生成视频/批量任务/删除资产）必须过必答门**，agent 无权自主点火；
4. **成本哲学一句话**：LLM 是全链路最便宜的一层，视频是最贵的一层——**让便宜层做厚**（一切思考、翻译、调参、重试决策交给 LLM），保护昂贵层（少拍废片）。

---

## 1. 三层智能体

| 层 | 谁 | 运行位置 | 自由度 |
|---|---|---|---|
| **L1 剧组流水线智能体** | 编剧/选角导演/美术指导/分镜师/音乐监制/摄制组/制片主任（七位，内置 persona 包） | 编排器 DAG 内的 LLM 步骤 | 最低：单步函数式调用（输入→结构化输出→机检），无循环、无自选工具 |
| **L2 对话副驾驶（Copilot）** | 用户唯一可见的「制片组助手」，创作驾驶对话流的驱动者 | **已部署 DSH 实例承载（每会话一沙箱实例，loop + tool-use 由 DSH 编排；剧场侧供控制面＋theater-mcp 工具面，§0-②/§5.2）** | 中：可读写剧场 API（经工具白名单），昂贵动作走必答门（服务端终裁） |
| **L3 自定义助手** | 用户/工作室自建的具名助手（人格+技能绑定），团队内共享 | 同 L2 runtime，带租户配置 | 受 persona 行为策略约束；P3 起可上架市场 |

**为什么 L1 不给自由**：生产管线的可靠性靠 DAG 确定性（断点续跑/成本核算/审计都挂在上面）；把「编剧」做成自由 agent 等于把生产事故率外包给模型。L1 的「拟人」是 persona 渲染层的事，不是 runtime 形态的事。

**工程现实注（2026-11-20 评审修订）**：L1「七角色」实际为 **6 个结构化 LLM 调用点**（编剧／选角抽取／美术推导／分镜／音乐 mood／制片主任预估；「摄制组」「后期」是规则代码而非 LLM），排期按调用点计。结构化输出失败走**四层策略**：① 温度 0＋JSON Schema 约束＋枚举化 → ② 修复回路（schema diff 回喂 ≤1 次）→ ③ 换通道备模型（flash↔pro/第二通道）→ ④ 确定性保守兜底＋升人工；persona×prompt 版本失败率 >2% 阻断发布（**一期回归载体＝B3「第二通道契约回归/每周回归」同一 CI——终审修正：发布门禁不再悬置于 P1 交付物 FR-1303；FR-1303 为二期完整基准**）。

---

## 2. 人格定义系统（Persona）

Persona = 可版本化的声明式包：

```jsonc
persona {
  "id": "p_screenwriter_suspense", "name": "阿编（悬疑向编剧）",
  "identity": "十二年悬疑短剧编剧，写过 3 部破亿播放漫剧",   // 拟人层（文案）
  "tone": "直接、苛刻、先说问题", "forbidden": ["不承诺播放量", "不改台词本已锁定内容"],
  "style_prefs": { "beat": "三幕压两幕", "vocabulary_blacklist": ["卧槽式惊叹"] },
  "system_prompt_ref": "versions/...",
  "behavior_policy": {                      // 行为层（治理，非文案）
    "tool_whitelist": ["script.*", "shotlist.read", "shotlist.write", "skill.suggest"],
    "expensive_gates": "inherit",           // 昂贵动作一律继承必答门，persona 不可豁免
    "max_cost_per_run": "¥0.5"
  },
  "memory_scopes": ["series:lore", "studio:prefs", "user:notes"],
  "version": 3, "status": "published"
}
```

- 七位剧组组员 = 内置 persona 包（ux-design §3.1 的隐喻在此实体化）；
- 用户可新建 persona（「悬疑向编剧阿编」「毒舌审片监制」），**persona × skill 组合**构成 L3 自定义助手；
- persona 变更即新版本，AgentRun 记录 persona 快照（可审计「当时是谁在干活」）。

---

## 3. 技能系统（建立与积累）

**Skill = 声明式包，数据不是代码**（与 ComfyUI workflow 同纪律：永不执行任意上传内容）：

```jsonc
skill {
  "id": "sk_shotlist_suspense_v2", "name": "悬疑镜头表节拍器",
  "trigger_desc": "当场次 mood 含[悬疑]且要求分镜时",
  "template_ref": "prompt 模板（通道化：scene/motion/camera）",
  "tool_chain": ["llm.complete", "shotlist.validate"],
  "validators": ["shotlist schema", "时长合计∈[0.9,1.1]×集时长", "出场角色引用完整"],
  "examples": [ /* 输入→已批准输出 对 */ ],
  "stats": { "adoption_rate": 0.71, "runs": 1240 }
}
```

**积累三通道**（用户越用，系统越懂）：

| 通道 | 机制 | 沉淀物 |
|---|---|---|
| ① 模板资产化 | 每次扩写/解析被用户「采用」或「改后采用」，diff 自动进技能候选池（改前/改后/场景标签三元组） | 技能候选 + few-shot 案例库（按工作室/系列隔离） |
| ② 采纳反馈学习 | 必答卡的通过率/改稿距离统计 → 偏好画像（景别偏好、节奏快慢、词汇黑名单、配色倾向） | PreferenceProfile，注入所有 persona 的 prompt 组装 |
| ③ 宏沉淀 | 检测到重复的手工操作序列（如「每场转场后插空镜+改冷色调」≥3 次）→ 主动提议「存为一键配方」 | Studio 级技能（Recipe），时间线/批量动作复用 |

**生命周期**：候选（私有）→ 发布（工作室共享，需管理员）→ 平台市场（P3，分成，对齐 mode-plan §2.7 模板与市场）。
**质量治理**：每技能挂固定评测集 + 在线采纳率，采纳率跌破阈值自动降权/下架——技能库不靠人工策展，靠数据新陈代谢。

---

## 4. 运行时与治理（AgentOps）

| 件 | 设计 |
|---|---|
| LLM 网关 | 多供应商路由（DeepSeek 主力，§0-②）+ 缓存 + 租户配额 + BYOK 兼容（**二期**）。**注：LLM API 属一期主用通道，不在「生成供应商（视频/图像）API 移二期」范畴**。实测约束（2026-11-20）：峰谷双价（忙时 ×2）→ 计量记峰谷时段；并发上限 flash 2500/pro 500 → 租户级配额；v4-pro 不支持 vision → 抽帧盲评走 flash；第二已备案通道挂同一工具调用契约后每周回归；persona 固化 model version 字符串，版本变更走一期 CI 回归（B3 载体；FR-1303 为二期完整基准） |
| **工具注册表（theater-mcp）** | 剧场全部业务 API 的工具化暴露（MCP 形态）：`project.* series.* episode.* scene.* shotlist.* shot.regenerate take.pick asset.read timeline.* cost.query script.breakdown skill.suggest`……权限矩阵与剧场 RBAC 挂钩（编剧角色改不了预算）；**这既是 L2 runtime 的工具面，也是 DSH/外部智能体的接入面——同一套资产**；**实现策略（评审修订）**：OpenAPI spec 为唯一事实源、工具面 codegen 派生（杜绝双份 schema 漂移）；P0 精调 5–8 个制片主任**只读**工具（进度/成本/重拍提案）**＋L2 写侧 3–5 工具（重拍/择优/提案，昂贵动作必经必答门——随 L2 一期必上裁决更新，与 §7/B9 同径）**；版本策略＝工具 schema 随 API semver、minor 只增不改、删除需 ≥1 minor 弃用期＋调用量归零证明、AgentRun 快照记 toolset_version |
| 记忆分层 | 会话上下文 / 系列 Lore / 工作室偏好画像 / 技能案例库——按租户硬隔离，用户输入按数据处理（防 prompt 注入） |
| 护栏 | 三层上限（单 run turn 数 / token 预算 / 现金预算）+ 循环检测 + 昂贵动作门（继承必答点地图，persona 不可豁免）+ prompt/产出双审（复用内容安全流水线）；**审批门竞态防护（评审补）**：审批令牌＝hash(动作参数摘要+成本预估+实体版本向量)，执行时 CAS、不匹配即作废回「上下文已变」重预览，TTL 30min，同实体单 pending；**注入防护具体机制（评审补，堵三洞）**：工具选择与授权全在服务端策略层（客户端只提交意图）、数据槽定界注入、入库净化/读取再净化、参数域校验禁跨租户——①小说/剧本正文间接注入镜头表与路由档位 ②技能案例库/偏好画像持久化投毒（入库过审＋读取净化＋diff 报警）③参考图四槽位上传入口机审＋人脸比对；**L2 用户面输出受 [U] §7 语言表约束（A9 DoD，终审补）**。术语定义（终审统一）：**必答门＝服务端机制；必答卡＝UI 件；必答点/决策点地图＝每集 4–5 张的规划面** |
| 观测与计费 | **日志即真相（服务端形态）**：AgentRun 事件流 append-only 表（SQLite 只做索引）+ trace 视图；计费 meter 新增 `llm_token`，成本穿透到镜头/技能/persona |
| 评测 | 固定评测集（剧本解析结构正确率/分镜质量盲评/扩写采纳率）随模型版本回归；**北极星 = 采纳率**（agent 产出被用户直接采用的比例） |
| **Agent Runtime 控制面（L2 承载，双模式，2026-11-20）** | **`AgentRuntimeAdapter` 契约**（runtime＝可替换执行器）：`spawn(session_cfg)→runtime_id · stream_input · on_tool_call(路由至 theater-mcp) · approval_request(仅展示→服务端裁决) · trace_tail · terminate(先导出后销毁)`。**模式 A·现有承载（一期默认）**：每会话起一个容器化 DSH 实例（独立 `~/.dsh`、工作目录＝租户/会话虚拟工作区、出网白名单＝theater-mcp 网关＋LLM 通道）；配置由剧场下发（模型通道/persona system prompt/技能目录渲染进 `.dsh/skills`/工具白名单/turn·token 上限）；**DSH 自带 shell/文件/代码执行类工具整体禁用（红线不变，容器+配置双保险）**；ApprovalPanel 仅展示层——审批令牌 hash+CAS+TTL 服务端裁决不变（DSH 被注入说服也绕不过）；**JSONL trace collector**→AgentRun append-only 表（「日志即真相」汇聚为平台账本）；实例版本 pin 死，升级走每周契约回归。**模式 B·自建 runtime（兜底位）**：剧场自研轻量 loop+tool-use（几百行循环，本就非护城河），实现同一契约——供 headless 入口失败/上游不可控时切换，及「零外部组件」私有化形态；一期落契约＋mock 双跑验收，完整实现排 **M2 缓冲**（发起人基线口径，终审收紧；如需放宽至二期初须发起人在 D7 显式注记；内部测试 L2 依赖高即启动，约 +12pd）。**两模式共享治理面：工具面白名单/服务端审批/预算硬熔断/AgentRun 审计/计费——runtime 可换，裁决权与资产面永远在剧场** |

---

## 5. DSH 嵌入评估（本次决策）

### 5.1 DSH 现状（事实）
单用户桌面智能体 harness（源码 `E:\deepseek-harness-src`，本环境不可达源码，以下据其对外语义）：`~/.dsh` 单一数据家、JSONL 事件日志为会话唯一真相（SQLite 仅作索引）、`SessionHeader.cwd` 绑定工作区、composer 接管式审批、项目级技能目录（`.dsh/skills`）、上下文压缩检查点、轨迹视图、Cordis/Node 插件体系、已部署可用。

### 5.2 单用户形态 × 多租户：沙箱实例模型的化解（原判「✗」的保留分析与推翻理由）
原分析成立但结论被发起人裁决推翻——四条反模式的正确解法不是「重写 DSH」，而是**把单用户形态下沉到实例层**（每会话一个容器化 DSH 实例，§4 控制面）：

| 原反模式判断 | 沙箱实例模型下的化解 |
|---|---|
| 单一数据家 `~/.dsh` ≠ 租户隔离 | **每会话一个数据家**（容器内私有＋销毁即弃）→「单用户」从缺陷变成隔离单元 |
| 本地 JSONL 真相源 ≠ 集中账本 | 实例 JSONL 是**局部真相源**，collector 强制汇聚→AgentRun 平台集中账本；计费/审计只认平台账本，DSH 日志为佐证 |
| `SessionHeader.cwd` 绑定 ≠ 项目树寻址 | 实例 cwd＝虚拟工作区；业务寻址从来走 theater-mcp 参数（租户内资源 ID），不依赖文件系统 |
| 桌面 composer 审批 ≠ 服务端审批流+计费门 | ApprovalPanel 降级为展示层；审批令牌（hash+CAS+TTL）与计费门在服务端强制，**DSH 侧任何「同意」都只是信号不是授权** |

**安全红线（不变，且在容器层再加固）**：DSH 自带的 shell/文件/代码执行类工具在服务端多租户场景**必须整体禁用**，工具面只允许 theater-mcp 白名单；实例出网白名单＝theater-mcp 网关＋LLM 通道。
**推翻的正当性**：原「补齐这些等于重写」的前提是「把一套 DSH 实例直接当多租户核心用」；裁决选择的承载模型是「N 套单实例＋自建控制面」——控制面（实例编排/配置下发/trace/审批桥）约 8pd（一期计划 B10），远小于自建 runtime 的隐性成本，且换来 DSH 已验证的智能体产品骨架。**四件套（工具面/persona/技能/治理）与控制面自持不变，不构成绑定**（§5.3 语义＋§0-③ 外部客户端逻辑同样适用于 runtime：任何 harness 可换，工具面是资产）。

### 5.3 采纳什么
- **架构语义 blueprint 全盘采纳**（它的形态是被验证过的智能体产品骨架）：日志即真相→append-only 事件表；session-query→查询服务；ApprovalPanel→必答门审批；`.dsh/skills`→技能注册表（声明式）；compaction checkpoint→长会话压缩；trajectory→观测 trace；
- **DSH 作为首个外部智能体客户端接入**（theater-mcp 的第一个 consumer）：制片主任/重度用户在自己的 DSH 里用自然语言驱动剧场（查进度、批量重拍、成本问询）；这同时验证 P3「外部智能体生态」的开放性——**工具面自持，任何 harness 可插，我们不被任何 harness 绑定**。

### 5.4 L2 上线准入硬验收（原「复审窗口」六条 → 一期 L2 上线前逐条核查，对应一期计划 V9）
① **无头服务端入口**——**W1 前置核验**（唯一外部依赖风险）：已部署版本若有 SDK/HTTP 入口直接采用；若无，fallback＝守护进程桥接（stdio/PTY 封装＋心跳），并向上游提 headless 需求；桥接稳定性靠升级回归集兜底；
② **多会话租户隔离**——沙箱实例模型化解（§5.2 行 1），核查项＝跨会话数据家/网络/文件系统零渗透测试；
③ **工具注册表可插拔**——配置禁用全部自带工具＋仅注入 theater-mcp，核查项＝工具列表快照＋越权调用被拒；
④ **审批钩子可挂昂贵动作门**——ApprovalPanel→审批令牌桥（展示层），核查项＝红队「绕过审批直发昂贵动作」必失败；
⑤ **会话级 trace 导出**——JSONL collector→AgentRun，核查项＝trace 100% 落库可对账；
⑥ **资源上限可配**——实例侧 turn/token 上限＋**theater-mcp 服务端现金硬熔断双保险**，核查项＝注入超预算用例被服务端掐断。
**验收归属**：一期计划 V9（红队三案：间接注入／昂贵动作绕过／跨租户探测，零越权）。**双模式说明（D7）**：六条适用于模式 A（DSH 承载）；模式 B（自建 runtime）按同一 `AgentRuntimeAdapter` 契约跑同一组验收——①–⑤ 中 runtime 侧条款对模式 B 即自检项，治理面条款两模式同源；模式 B 完整实现前以 **mock adapter 双跑**纳入 V9。**绑定防线**：runtime 只是执行器，任何一条不满足即切另一模式，产品与数据零损失。DSH 官方后续若提供正式服务化形态，按本清单复核定新架构版本。

---

## 6. 数据模型增量

```sql
persona(id, tenant_id, name, spec jsonb, system_prompt_ref, version, status)
skill(id, tenant_id|null, name, trigger_desc, template_ref, validators jsonb,
      examples jsonb[], scope private|studio|market, adoption_rate, runs, status)
agent_def(id, persona_id, skill_ids[], tool_whitelist[], run_mode step|loop)
agent_run(id, tenant_id, agent_def_id, persona_snapshot jsonb, trigger,
      tokens, cost, adoption state, started_at)          -- 事件流另存 append-only event_log
preference_profile(tenant_id, series_id|null, prefs jsonb, updated_at)
billing_event.meter += 'llm_token'
```

## 7. 分期

| 阶段 | 智能体平台动作 |
|---|---|
| **P0（一期）** | LLM 网关（DeepSeek 通道：峰谷计量/租户配额/第二通道契约回归）+ L1 **6 个结构化调用点**＋四层失败策略＋护栏三层上限＋审批门 CAS 字段埋设 + persona 文案层；**theater-mcp＝OpenAPI codegen＋只读 5–8 工具＋L2 写侧 3–5 工具（重拍/择优/提案，昂贵动作必经必答门）**；**L2 Copilot 上线（发起人 2026-11-20 裁决必须上）**：runtime 双模式（§4 AgentRuntimeAdapter）——**模式 A 现有承载（DSH 实例，一期默认）**经 B10 控制面上线＋S18 对话前端（A9）；**模式 B 自建 runtime 一期落契约＋mock 双跑验收**，完整实现排 M2 缓冲（终审收紧基线）；上线前 §5.4 六条硬验收＋V9 红队（双模式跑）；**S18＝右侧常驻驾驶栏（桌面默认）／H5 中央 tab（§5.2 UI 规范）** |
| **P1（二期）** | 采纳率统计看板 + 技能候选池显形（通道①）+ PreferenceProfile（通道②）注入 Copilot prompt＋主动建议卡（通道③建议形态）+ 评测 CI；DSH 作为外部客户端接入试点（与 runtime 承载并行，验证同一工具面） |
| **P2** | L3 自定义 persona/skill 编辑器 + 工作室技能共享 + 宏沉淀（通道③完整形态）+ 模式 B 全量投产评审 |
| **P3** | 技能市场分成；开放 API 含 MCP 端点（外部智能体生态）；runtime 双模式按 §5.4 复审迭代 |

## 8. 决策记录

| # | 决策 | 状态 |
|---|---|---|
| D1 | 智能体平台自建服务端核心；工具面（theater-mcp）自持且第一天定义 | 定 |
| D2 | DSH：LLM 通道复用 ✓；核心 runtime 原「✗」已被 D6/D7 推翻（改双模式承载）；外部客户端 ✓ 试点（与承载并行） | 修订（2026-11-20） |
| D3 | workflow-first 纪律：agent 不自主执行昂贵动作，必答门不可被 persona 豁免 | 定 |
| D4 | 技能 = 声明式数据，永不执行任意上传；采纳率驱动新陈代谢 | 定 |
| D5 | ~~DSH-as-runtime 维持 ✗ 随 §5.4 复审~~（被 D6 推翻） | 废（2026-11-20） |
| D6 | **L2 对话副驾一期必须上线**，runtime 经 `AgentRuntimeAdapter` 契约承载：每会话一沙箱实例、工具面仅 theater-mcp 白名单、审批/预算/审计终裁在剧场服务端、trace 汇聚 AgentRun；四件套（工具面/persona/技能/治理）＋控制面自持不变 | 定（发起人 2026-11-20；准入验收 §5.4＋V9） |
| D7 | **runtime 双模式**：模式 A 现有承载（已部署 DSH 实例，一期默认）＋模式 B 自建 runtime（同一契约，兜底与零外部组件私有化形态；一期契约+mock 验收，完整实现 M2 缓冲（终审收紧基线），~+12pd）——两模式共享工具面白名单/服务端审批/预算熔断/审计计费；**runtime 可替换、无绑定** | 定（发起人 2026-11-20） |
