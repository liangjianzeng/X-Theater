# 剧场 Studio · AI 能力全景蓝图（实现基准 v1）

> 定位：**本文件是 AI 能力的唯一实现基准**。任何 AI 相关改动先在此定位所属层、对照矩阵，实现后回写 §7 状态列。
> 立此存照的原因：此前的演进方式是「用户一个问题 → 打一个补丁」，能力没有全局形状。补丁可以有，但必须能回答「它属于哪一层、补了矩阵哪一格」。
> 更新纪律：改行为必改状态列；改设计必改对应节；废弃能力标 ❌ 不删（留决策痕迹）。

---

## 0. 一句话总纲

**剧场是一条「人拍板、AI 打样」的短剧流水线；AI 的任务是在每个节点把「专业初稿＋多维审查＋下一步建议」递到人面前，Agent 助手是把这条流水线装进一个对话界面的大脑——感知全局、评估卡点、推荐选项、经人确认后执行、带人去该去的地方。**

三条铁律（全局不变量，任何实现不得绕过）：

1. **拍板权在人**：AI 可打样、可审查、可建议、可出确认票，绝不代拍板（C1-C9 每张卡停在人的 approve/reject；昂贵动作必须确认票）。
2. **fail-open 分层**：思考层（LLM）断 → 规则兜底（诚实标注切换）；装饰层（顾问卡/芯片）失败 → 静默降级为纯文本。任何 AI 故障不阻断创作流水线。
3. **诚实标注**：用户面只说「LLM/规则模式」，型号只进 meta 豁免面；用户面话术不露 `ep_/card_/pj_` 编号，一律中文名称呼。

---

## 1. 全局架构：AI 能力栈（L0-L6）

```
L6 交互面    copilot 助手栏（对话/任务/审批）· 卡流页 AI 块 · 运维台节点面板 · 芯片 · GPU 徽章
L5 审查层    aireview worker（规则机检＋LLM 人格叠加）· 台词语速校验 · C7 复审 AI 建议
L4 顾问层    advisor 顾问卡 · suggest_card 修订建议 · replyFor/llmReply 顾问话术 · TOOL_ADVICE
L3 执行层    tools.js 21 工具 · governance（白名单/租户/预算/确认票/影子账）· 审批票
L2 理解层    llmintent（systemPrompt 语义面）· llmParse（LLM 优先）· modeB 正则兜底 · 注入检测
L1 感知层    /api/state · /api/gpu · /api/nodes · stateSummary 会话感知 · 卡流/GPU 轮询
L0 基础设施  llm-gw（llama-server :8090 Huihui35B:vision＋watchdog）· 节点驱动（local 5060Ti / DGX H3）· 显存互斥闸
```

分层契约：

| 层 | 职责 | 禁止 |
|---|---|---|
| L0 | 让 LLM 随时在线、让渲染与 LLM 不抢显存 | LLM 服务于思考/审查/建议，**不直接生成视频/海报产物**（那是生图视频线的事） |
| L1 | 把剧场状态变成 LLM 和 UI 能读的结构化事实 | 感知面不掺解释性文案（解释是 L2/L4 的事） |
| L2 | 把用户的话变成治理可裁决的意图 | 理解层**无执行权**：parse 只产出 intent，闸门在 L3 |
| L3 | 白名单＋租户＋预算＋确认票，唯一执行通道 | 任何绕过 governance 直接调 store/engine 的通道都是违规 |
| L4 | 把执行结果变成「看得懂、能决策、可点选」的顾问输出 | 顾问层的选项只能 send（回发话术走 L3）或导航（href/tab），**没有直接执行工具的旁路** |
| L5 | 多人格视角挑毛病，产出 findings/verdict | 审查只出意见不改决策；fail-open 只出规则结果 |
| L6 | 渲染卡片/芯片/徽章；点击行为全部走 L4 约定 | 交互面不做业务判断（判断在 L4），不做直连 API 的私货 |

---

## 2. 全流程 AI 参与矩阵（C1-C9 × AI 能力）

> 读法：每行一个流程节点；「AI 打样」=AI 生成初稿/产物，「AI 审查」=aireview 出 findings，「AI 建议」=advisor/suggest 出下一步；每格标注引擎与兜底。**每一行的终点都是「人拍板」。**

| 节点 | 产物 | AI 打样 | AI 审查 | AI 建议/交互 | 人拍板 | 兜底（LLM 断时） |
|---|---|---|---|---|---|---|
| C1 故事方向 | 策划案（梗概/人物/分场分镜） | scriptgen（LLM 剧本；quickstart/一句话成片入口） | aireview：编剧/导演/剪辑/合规人格＋语速校验 | 修改建议（suggest_card→revise_scenes 确认票）；重出一版（decide reject 确认票） | ✓ | 规则机检仍跑；模板节拍可拍 |
| C2 演员定妆 | 角色定妆图 | 生图线（ComfyUI/Spark，上传/AI 生成） | aireview（C2 在审查类型表） | 定妆入口引导；重拍某角色 | ✓ | 产物线不受 LLM 影响 |
| C2S 试妆试镜 | 试妆试镜片 | 生图线 screen_test | aireview | 按角色重出；确认后进批量出图 | ✓ | 同上 |
| C3 演员表锁定 | 锁定表 | storyboard_char 派单（生图线） | — | 拍板引导；锁定后才能试拍 | ✓ | — |
| C4 分镜画面 | 每镜首帧/分镜图 | img 出图（按 episode.driver 路由 local/dgx） | aireview | 重拍第 N 镜（确认票）；择优 pick_take | ✓ | 产物线不受影响 |
| C5 样片审看 | 预览成片 | compose 预览（视频线） | aireview：节奏/时长/语速 | 样片问题清单导读 | ✓ | 规则校验仍跑 |
| C6 开机报价 | 报价单 | estimate（shots×单价，动态） | — | 开机引导＋GPU 互斥知情提示（gpuNote） | ✓（确认票，最大额） | 静态单价 |
| C7 复审批复 | 灰区镜头 pass/fail | — | AI 给 pass/fail **建议**（规则机检先走） | 复审台队列导读 | ✓（决策留人） | 规则机检 |
| C8 交付确认 | 成片文件 | export 合成（确认票＋预检全绿前置） | 交付预检（precheck 规则） | 看片 checklist（规划中 §6 P2） | ✓ | 预检不依赖 LLM |
| C9 配乐提案 | 每场候选曲 | music_candidates（确认票→生成） | — | 采纳 adopt_music；regen 重出 | ✓（采纳） | — |

矩阵的使用规则：
- 新增 AI 能力必须落到本表某一格；落不进去的格子（如「AI 自动跳过审查」）就是**不该做的能力**。
- 每格的引擎标注必须跟随实际（「LLM·Huihui35B:vision」进 meta 豁免面；用户面显示「LLM 审查＋规则机检」或「规则机检」）。

---

## 3. Agent 助手设计（重点）

### 3.1 定位

**助手 = 剧场的大脑皮层：感知 → 评估 → 推荐 →（人确认后）执行 → 带路。**
反面对照（已经挨过批的旧形态）：统计播报员（「3 张卡 1 张待审」）、陪聊（什么都干不了）、越界者（代拍板/代停 LLM/抢生成线的活）。

### 3.2 顾问循环（每一轮对话的骨架）

```
感知（绑定集＋stateSummary＋GPU/卡流）
  → 理解（意图：工具 or 直答 or 追问）
  → 执行（只读直走 / 廉价直走 / 昂贵出票）
  → 评估（结果意味着什么、卡在哪、影响下游什么）
  → 顾问输出（话术 + 选项卡/提问卡/跳转卡）
  → 用户点选/答复
  → 回到感知（循环，直到任务闭环）
```

助手每轮收尾必须回答制片人心里的问题：**「所以我现在该干嘛？」**——用话术说清，用选项卡给出口。

### 3.3 能力栈：21 工具面（L3 白名单，数字随版本更新）

| 类别 | 工具 | 执行策略 |
|---|---|---|
| 感知/查询（只读） | query_cards/query_card/query_projects/query_episodes/query_scenes/query_music/query_gpu/query_progress/query_cost | 直接执行，回执＝顾问话术＋卡片 |
| 创作代办（廉价） | create_project/create_episode/suggest_card/adopt_music/set_mood/pick_take | 直接执行（建项建集入账、建议片可回退） |
| 动作（昂贵→确认票） | reroll_shot/music_candidates/revise_scenes/decide_card/shoot_episode/export_episode | 只出确认票（hash/TTL60s/ver CAS/一票一次），人批准才执行 |
| 会话内 | export_session | 导出会话内容 |

### 3.4 交互协议：消息内嵌顾问卡（本轮落地的核心原语）

消息流 = 文本气泡 + 可选卡。**卡是「可点的下一步」，不是装饰**。规范：

```js
card = {
  kind: "choices" | "ask",
  question: "…提问卡的问题（ask）…",          // 答复直接在主输入框回复，走正常解析链
  options: [                                  // ≤4 项
    { label ≤40, hint ≤48,
      send: "替用户发这句话",                  // → 走完整 interpret→gate→审批治理链（无旁路）
      href: "#/ep/<id>/flow",                 // → 站内 hash 路由（白名单正则）
      tab:  "apv"                             // → 助手栏内切页（chat/tasks/apv 白名单）
    }
  ]
}
```

- **生命周期**：一次性（点过即 `used` 收起，防重复触发）；SSE `msg_card` 事件挂最新助手气泡；8s 全量合并带回卡；resume 旧会话 8s 内补挂。
- **安全清洗**（adapter.cleanCard）：只放行已知键位；字符串过 langlint sanitize；`href` 过 `^#\/[A-Za-z0-9_\-%=.\/]+$`（防 javascript:）；无动作的选项不放行。
- **fail-silent**：advisor 构建异常 → null → 纯文本回执，绝不阻断。
- **卡目录（v1 已定）**：待拍板卡→[去卡流页核对 / 出修改建议 / 重出一版]；卡全定案→[去工作台推进 / 导出成片]；GPU 被挡→[去运维台]；全镜完成→[导出成片 / 去复审台]；成本→[成本页逐镜账]；无项目→ask 剧名；建项成功→ask 第一集梗概；建集成功→[卡流页跟进]；建议出完→[看详情 / 按建议改剧本]；确认票出票→[去审批面板 / 先不批]；解析失败→能力菜单卡。

### 3.5 多轮任务链（ask → 答复 → 继续）

ask 卡是长任务链的钩子。已通链路：
- 建剧链：`帮我新建一部剧` →（LLM 追问剧名 or ask 卡）→ 用户报名字 → create_project → ask「开第一集吗」→ 一句话梗概 → create_episode（project_name 原文匹配，两步可以一轮收口）
- 修改链：`改一下 X` → suggest_card 出建议 → 选项卡「按建议改剧本」→ revise_scenes 确认票 → 批准 → C1 重导出重审
- 拍板链：`重出一版` → decide_card reject 确认票 → 批准 → 重派打样任务 → 新卡 pending → 循环

**设计规则：任务链的每一环都要有「看得见的入口」（芯片/选项卡/提问卡）和「看得见的状态」（任务 tab/审批 tab/回执话术），不允许只有 LLM 心里知道的多轮。**

### 3.6 主动性（P2 规划：助手从「被问才答」到「该说话时说话」）

事件驱动 hint（已有机制雏形：l2:<sid> topic + assistant_hint 设计）：
- 卡流事件 → 有新待拍板卡 → 推送：「C2 演员定妆卡到了，分镜在等它」＋选项卡
- 任务完成/失败 → 排队清空/重试耗尽 → 提示下一步（导出/重出）
- GPU 看护拉起 LLM → 提示显存冲突根因＋运维台入口
- 复审 AI 建议出现 ⚠ 密集 → 提醒批量处理
纪律：hint 只推「有可点下一步」的场景（无动作的提醒是噪音）；同一事件 5 分钟内不重复打扰。

### 3.7 上下文纪律

- **单集语境**：会话绑定集（📌 chip），切集自动开新会话（跨集历史污染已修）；prompt 注入绑定纪律——历史涉及其它剧集一律以本次绑定为准。
- **数据引用纪律**：镜头/卡状态逐字引用上下文标记（✓/⚠/无标记），禁止把「未拍」说成「已就绪」，禁止编造数字。
- **ID 纪律**：ID 只许从上下文复制进 args；幻觉 ID 一律丢弃并按 card_type/唯一 pending 兜底；用户面话术用中文名（故事方向卡/演员定妆卡/《灯塔来信》）。
- **状态感知源**：stateSummary（绑定集/场次/镜头/待拍板卡/驱动）＋GPU 缓存；感知面只供事实，解释归 LLM/顾问层。

### 3.8 治理红线（助手能力的边界，全部不动）

白名单 21 工具；租户参数裁决（跨租户 FORBIDDEN）；预算熔断线（broken 会话禁代办）；昂贵 6 类确认票；validateArgs 禁 shell/cmd/path 键；注入文本不解析出工具；**助手线不碰生成线**（不自动触发生图/视频生成任务、不代停 LLM——让路/切节点是用户在运维台的决策）；LLM 不可达回退规则并诚实标注。

---

## 4. 提示词与语义资产（单一来源原则）

| 资产 | 位置 | 内容 |
|---|---|---|
| 助手 systemPrompt | llmintent.js systemPrompt() | persona＋21 工具 schema＋语义映射（重出一版=reject/就这个=accept/改一下=suggest…）＋绑定/引用/ID 纪律 |
| 回执推荐视角 | llmintent.js TOOL_ADVICE | 每工具一句「顾问该怎么想」（query_cards 按依赖链挑最该拍板的…） |
| 卡类型语义表 | governance.js CARD_LABEL/CARD_NEXT/CARD_ORDER | C1 故事方向…C9 配乐提案；拍板后解锁什么；多卡推荐顺序——**服务端唯一来源**（客户端 TYPE_META 展示对齐即可） |
| payload 摘要 | governance.js cardDigest | 从真实 payload 字段取人话摘要（note/summary/role/cast/estimate/images），取不到就 null，绝不编造 |
| 审查人格 prompt | aireview worker | 多人格机检规则＋LLM 人格叠加输入卡 payload |
| 建议构建器 | prompts/ 注册中心（他线在建） | suggest sys/usr 单一来源（tools.js 与 /suggest 路由共用） |

规则：**同一语义只许一个来源**。改话术/改顺序/改类型名，改资产表一处，不要在 worker/adapter/client 各抄一份。

---

## 5. L0 基础设施要点（AI 算力与互斥）

- llm-gw：chat（enable_thinking 开关走 chat_template_kwargs）/status/cached/blockedByLocalLLM/stop；watchdog 掉线自动拉起（连 3 次离线→spawn bat，45s 冷却，10 分钟≤3 次熔断转人工 alert）。
- 节点驱动：`state.nodes`（local=5060Ti：ComfyUI:8188＋LLM:8090；dgx=DGX H3 全家桶）＋`state.llm_node`（LLM 承载节点，档案热切换）＋`episode.driver`——剧集级选渲染节点；engine 按 driver 路由 lane（dgx→imgspark/vidspark），GPU_BUSY 闸只掃本机 lane；本机显存留给 LLM。
- 显存互斥是**配置问题不是代码问题**：解法优先级＝切 DGX 驱动 > 停 LLM 让路（运维台手动）> watchdog 兜底拉起。

---

## 6. 路线图（P0 已落地 → P3）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0 已落地** | llm-gw 真脑接入；21 工具面；aireview LLM 人格叠加；watchdog 看护；节点驱动＋每集 driver；芯片状态推导；切集换会话 | selfcheck l2 129/129＋llm 9/9；真机：LLM 在线全链/关 LLM 回退规则双态验证 |
| **P1 进行中** | 顾问卡 v1（choices/ask＋send/href/tab）；replyFor/llmReply 顾问化（现状/评估/推荐，不露 ID）；query_cards 富化（中文名/摘要/依赖链推荐）；能力菜单卡；审批引导卡 | 真机：点芯片→回执可读→点选项卡执行/跳转闭环；LLM 断→规则脸同样出卡 |
| **P1 剩余** | ask 多轮链补全（每条链都有入口+状态）；消息卡回归用例进 selfcheck | 每条任务链真机走通一遍；selfcheck 覆盖卡清洗（javascript: 拒绝/键位白名单） |
| **P2** | 主动性 hint（卡流/任务/GPU 事件→有动作的提醒）；C2-C8 各节点助手感知深化（把 §2 矩阵「AI 建议/交互」列落全）；会话记忆（项目事实摘要，跨会话）；批量建议（多镜重拍/多卡连拍） | 矩阵每格有实现或明确标「不适用」；hint 有开关不打扰 |
| **P3** | 评测基准：意图解析回归集（≥100 条真实话术）；回执质量抽样（顾问三段齐/无 ID 露出）；红队注入回归；规则 vs LLM 双跑对比账（影子评测） | 回归集进 selfcheck；对比账支撑「哪些环节值得继续加 LLM」的决策 |

---

## 7. 现状盘点（回写区——每次改动更新此表）

| 能力 | 状态 | 位置 | 备注 |
|---|---|---|---|
| llm-gw 通道＋watchdog | ✅ | src/server/llm/llm.js | 掉线 30s 自动拉起已实证 |
| 节点驱动/每集 driver/LLM 档案热切换 | ✅ | api/nodes.js·engine·admin.js | 灯塔来信/床头情歌已切 dgx |
| 21 工具面＋确认票＋影子账 | ✅ | l2/governance.js·tools.js | 治理红线零改动 |
| aireview 规则机检＋LLM 人格 | ✅ | dag/workers/aireview.js | 标注跟随实际引擎 |
| scriptgen/suggest_card/revise_scenes | ✅ | scriptgen·cards.js·tools.js | 建议片走卡流 UI 采纳 |
| 芯片贴场景推导 | ✅ | copilot.js CHIPS computed | 未绑/绑 local+busy/绑 dgx 三态 |
| 会话感知 stateSummary＋切集换会话 | ✅ | llmintent.js·copilot.js | 待拍板卡行已带中文名 |
| GPU 徽章＋开机互斥知情提示 | ✅ | app.js·flow.js·adapter gpuNote | 中性文案不露型号 |
| **顾问卡 v1（choices/ask/href/tab）** | ✅ | l2/advisor.js·adapter say(card)·copilot msg_card | 真机闭环：芯片→三段式回执→点选项跳转→一次性收起（合并不复活）；selfcheck 141/141 |
| **顾问话术（replyFor/llmReply 三段式）** | ✅ | adapter.js·llmintent.js TOOL_ADVICE | 现状/评估/推荐，用户面不露 ID（真机验证） |
| query_cards 富化（label/summary/依赖链） | ✅ | tools.js·governance cardDigest | 卡摘要入回执与选项 hint |
| 顾问卡回归用例 | ✅ | test/selfcheck/l2.js | advisor 形状＋清洗面（javascript:/越权键位/无动作选项） |
| 三条任务链真机验证 | ✅ | 建剧链（建项→ask 梗概→建集→卡流页跟进）✓；拍板链（重出一版→确认票→审批面板→tab 切换）✓；修改链✓全通（建议→落卡→采纳→仍待拍板） | 采纳腿设计：场景物化在 C1 accept 时，待拍板期不走 revise_scenes——新增廉价工具 apply_suggestion（建议落进卡 payload，ver++＋重派 AI 审，拍板权仍在人）；草稿期建议允许增删场次（逐场结构校验） |
| 链式语境 lastProject | ✅ | adapter 记录＋llmintent toIntent 三级兜底 | 「建完项目答梗概就建集」ask 链承接（selfcheck 覆盖） |
| ID 机械剥除 | ✅ | llmintent llmReply/toIntent say | 真机发现模型不守「不露编号」纪律 → 清洗层兜底（selfcheck 覆盖） |
| L2 建项/建集租户戳 | ✅ | tools.js create_project/create_episode | 真机发现漏 tenantId＝scopedView 全域隐形（集建成不可见）→ 与 api 路由同口径 |
| 主动性 hint（新待拍板卡） | ✅ | copilot.js 本地横幅（cards_pending diff） | 绑定集限定；切集基线静默（不回灌旧卡）；按卡 ID 会话级去重；hint＝文本＋可点选项（send 走治理链/href 导航）＋✕ 收起；真机验证基线静默/弹出/点选发送/收起 |
| 主动性 hint（复审事件） | ✅ | copilot.js（review_pending × shots_by_episode 归属绑定集） | 新 ⚠ 待复审镜头→单槽位提示「N 个镜头待复审」＋[去复审台/查进度]；真机验证弹出/导航/收起 |
| 主动性 hint（任务完成/失败） | ✅ | copilot.js（loadJobs 一次＋SSE 保鲜，签名去重＋首评基线静默） | 失败→[去拍摄页/查进度]；全部拍完→[导出成片(send 出确认票)/去复审台]；单槽位随状态替换；真机验证两变体 |
| C2-C8 节点感知深化 | ⬜ 未开工 | 规划 §2 矩阵「建议/交互」列 | P2 |
| 会话记忆/项目事实摘要 | ⬜ 未开工 | 规划 §3.6 | P2 |
| 意图回归集（规则脸·selfcheck 门禁） | ✅ | test/selfcheck/intent-corpus.js＋l2.js | 106 条话术路由断言＋12 条注入红线全过；语料驱动规则表补词（拍到哪/拍完/没拍/到哪儿/待批/新卡/节点/立项等）与排序修正（progress 先于 newshow，裸「怎么样」双轨） |
| 意图回归集（LLM 脸·在线双跑验收） | ✅ | test/acceptance/llm-intent.js（非门禁，手动跑） | 复用同语料只读面子集；LLM 离线自动跳过；输出分类正确率/严格一致率/越权执行数 |

---

## 8. 本基准的使用规则（写给自己和后续任何会话）

1. **动 AI 相关代码前**：先答三个问题——属于哪一层（L0-L6）？补了 §2 矩阵哪一格？交互走 §3.4 协议还是新增原语（新增必须先改本文件）？
2. **不许再出现**：绕过 governance 的执行通道、绕过消息卡协议的私有交互格式、绕过语义资产表的散装话术。
3. **补丁合法化**：用户报一个问题时，先归因（感知缺了？理解缺了？交互原语缺了？顾问缺了？），补丁落在对应层，并在 §7 回写。
4. **验证底线**：LLM 在线/离线双态都要能用（fail-open）；selfcheck 全绿；真机闭环一遍（用户可见的行为必须有浏览器/接口证据）。

### 8.1 双线文件分界协议（2026-11-22 用户裁决）

背景：助手线与视频线同仓工作，共享文件竞态已三次互相吃编辑（store.js boot 崩溃、tools.js registry hunk 丢失、server 运行中互杀）。

- **助手线专属**：`src/server/l2/llmintent.js`、`src/server/l2/advisor.js`、`src/server/l2/adapter.js`、`src/server/l2/modeB.js`、`src/client/js/views/copilot.js`、`docs/ai-blueprint.md`、`test/selfcheck/*`、`test/acceptance/*`
- **视频线专属**：`src/server/dag/workers/*`、`src/server/api/prompts` 相关、`src/server/prompts/*`、`src/client/js/store.js`、`src/client/js/api.js`、`src/client/js/views/flow.js` 等流程/素材面
- **共享错峰文件**：`src/server/l2/tools.js`、`src/server/l2/governance.js`、`src/server/api/cards.js`——双方都可能改；**动之前先声明，对方有未提交改动时等对方 commit 后再动**；提交前逐 hunk 隔离（只提交自己的）
- **LLM 承载（用户裁决 2026-11-22）**：LLM 迁 DGX 缓行——LLM 最终只是节点档案里的一个配置（`state.llm_node` 热切换已就绪），运维台后续重构架构统一承载；本线不主动迁移

### 8.2 交接视频线：默认渲染节点＋GPU_BUSY 降噪（2026-11-22 用户批语「dgx 的算力应该可以设置为默认，不要老提示这种垃圾消息」）

- **需求**：①节点注册表支持「默认渲染节点」设置（新集默认继承，不再逐集手切）；②engine GPU_BUSY 闸命中时若存在可用远端节点→自动改道或一次性引导切换，而不是每次弹长 toast；③toast 文案降噪（现场抱怨样本：engine.js:415 的 14.4GB 长文案）。
- **归属**：engine.js/nodes.js 均为视频线 in-flight 重构区（节点注册表数据驱动化进行中），助手线按 §8.1 协议不动其未提交区。
- **助手线已做的即时止血**：现存走本机的集已全部切 DGX（运营动作，可逆）。
- **助手线面（后续配合）**：copilot 的 gpuBlocked 芯片与 adapter 的 gpuNote 文案在注册表落地后同步改语义（driver=node id），避免两套「被挡」话术打架。

### 8.3 算力调度目标架构（2026-11-22 用户批语「车道泳道全是和 5060/DGX 捆绑写死」——硬规格）

**原则：节点是数据，车道是能力，路由是策略——代码里不许出现任何硬件名。**

1. **节点（Node）＝纯数据**：`st.nodes[id] = { id, label, caps: ["t2i","i2i","t2v","compose","music","tts","moderate","llm"], endpoint, gpu_gate: bool, is_default_render: bool, online }`。新增/更换硬件＝运维台填一条数据，零代码。
2. **车道（Lane）＝能力名，不是硬件名**：现存 `img5060/vid5060/imgspark/...` 全部退役为「节点上的能力绑定」。job 只声明**能力需求**（如 `cap:"t2i"`），不再点名车道。
3. **路由策略（唯一入队口 engine.enqueue 内聚）**：
   - 有集任务：集 driver=node → 该节点有能力→走它；没能力→NODE_NO_LANE 引导绑引擎（现文案保留）。
   - **无集任务（素材中心 img_free 等）：走 `is_default_render` 节点**；默认节点被 gpu_gate 挡→自动落到其它有同能力且未 gate 的节点；全都被挡→才提示（一次性、带一键改默认）。
   - **不再允许**「无集任务焊死在本机」的现状（素材中心撞闸的直接根因）。
4. **旧名兼容映射**（一次性迁移表，落库即删）：`img5060→cap:t2i@local`、`imgspark→cap:t2i@dgx`、`vid5060→cap:t2v@local`、`vidspark→cap:t2v@dgx`……worker 文件改名去硬件（img5060.js→worker.t2i.js 等）。
5. **验收**：①新增一张虚拟节点（纯数据）跑通生图；②停本机 LLM 不再影响任何走 DGX/默认节点的任务；③素材中心无集生图零提示自动出图；④代码全局 grep `5060|spark` 零命中（worker 文件名与历史账本除外）。
- **归属**：engine/workers 视频线 in-flight（节点注册表已建一半）；本规格＝其完成线。助手线只消费路由结果（GPU_BUSY 面文案与 hint 已按此同步语义）。
- **实现状态 v1 ✅（2026-11-22，经用户直接裁决在已提交的注册表之上实现）**：engine.enqueue 内聚 poolPick——候选序（集指定→发起人默认算力→云 API 已配→远端 comfy→本机）、gpu_gate 节点自动跳过找下家、tier:high 固定不漂移、全空才一句 POOL_EMPTY 收口（替代 14.4GB 长文案）；selfcheck pool 7/7＋llm 9/9（更新到池契约）；真机实证：LLM 占卡时素材中心无集生图 → job.lane=imgspark（DGX）→ done，零提示。车道名退役（img5060 等改能力名＋worker 改名）为遗留迁移项，不影响池语义。
- **「假图冒充候选」根治 ✅（用户批语「DGX 几小时没人调用，生成出来都是假的」）**：根因＝imgspark 真跑分发不含 img_free → stub 占位图冒充候选（各记 20 分，DGX 零调用）。修复：①H3 条件化节点参考图输入为可选（官方语义零参考纯 t2i）→ 新模板 `h3-image-free.json`＋manifest 登记（sha16 过闸，裸测证据 prompt_id 399be88c）；②imgspark 增 img_free 真跑分支 runSparkImgFree（四层拼装提示词＋零参考 t2i）；③账本 worker_type 静态假标签「self-host-stub」改实际模式判定（账本不许撒谎）。真机实证：img_free → imgspark → H3 真出图 1.97MB（黄昏码头验图通过，meta kind=image-comfy-spark-free）。已知模型行为：中文提示词可能被 H3 画进图（验收文案带「验收」字样会渲染成标题字），素材线后续可加 negative 抑制。
