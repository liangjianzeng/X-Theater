# 剧场 Studio · 素材中心（Asset Center）建设方案

| 项 | 内容 |
|---|---|
| 文档 | theater-asset-center-plan.md |
| 日期 | 2026-11-22 |
| 范围 | 独立一级「素材中心」：音频/图像/角色/场景/设定 五资产域 + 候选池 + 回流 + 就绪度门禁 + 挂接语义升级 |
| 关联 | theater-prompt-system-plan.md（六层提示词资产——本方案的 L0/L3 直接被素材中心消费）、theater-product-master-plan.md §4.3 |
| 方法 | 代码库素材链路盘点（music/imgspark/compose/moderate/castref 全触点）＋ 行业调研（可灵主体库 / 即梦多模态参考 / Epidemic Sound / Shotgrid / Unity Content Browser / AI 短剧工业化实践，来源见 §10） |

---

## 1. 结论速览（TL;DR）

用户原始诉求是「音乐和图像生成独立一级菜单」（背景音乐/主题音乐/MV 素材/角色维护/场景维护），但从行业标准看这只是**音频与视觉两域的一半**。专业评估后的完整范围是**五个资产域 × 三级作用域 × 九条横切机制**，核心主张：

1. **素材中心是与生产流水线平级的先道工序**：AI 短剧工业实践共识是「先建创作资产库，再进流水线」（定妆/定场/配乐先行，分镜、定妆图、场景概念图三线并行）。没有库，每集从零抽卡，一致性靠运气、成本不可控。
2. **五域划分**（用户 ABCD 的专业扩展）：音频域（音乐+**音效 SFX+环境音 ambience+音色 voice**）、图像域、角色域（角色包=锚点+定妆+帧池+音色+服装变体）、场景域（场景卡=定场图+变体+环境音+光线预设）、**设定域**（剧集圣经：风格包实体化/判废表/人物小传——用户想不到但工业化必需的一致性根）。
3. **素材积累五路径**：抽卡生成、**生产回流**（定妆/帧池/配乐候选一键入库，现全部用完即弃）、上传导入（castref/upload 已有先例）、预置包冷启动（内置 starter pack）、跨集跨季复用（角色包/场景包迁移）。
4. **挂接语义 1:1 → 1:N**：现 `adoptCandidate` 同场换曲=替换，改为多对多绑定+集级覆盖+反向索引（改素材前看影响面）。
5. **就绪度门禁**：集工作台加「开拍就绪」检查（场景有定场图？角色有定妆+帧池？主题曲选定？），缺项直跳素材中心——把「先铺库再开拍」变成流程约束。
6. 分三期落地：P0 骨架+音频域闭环（1–2 天）、P1 图像/角色/场景域+回流（3–5 天）、P2 设定域+音效混音+全局公共库+Copilot 素材工具+MV 素材包（1 周+）。全部复用现有 job 引擎/影子账本/幂等派单/GPU 让路，零新基建。

---

## 2. 现状盘点：素材链路资产与缺口

### 2.1 已有资产（可直接升格进素材中心）

| 资产 | 位置 | 现状 | 缺口 |
|---|---|---|---|
| 曲库 | `st.music_lib`（`core/store.js`） | 全局曲库+license+shadow_cents，`sceneId` 单挂接 | 必须绑定 sceneId 才能生成（`api/music.js:83`）；1:1 替换语义；无类型/评分/作用域 |
| 配乐生成 | `workers/music.js` + ACE-Step | P1 已接 tags 通道（MOOD_TAGS+风格包 music_tags） | 无时长/结构/歌词参数透传；候选池 TTL 清理无 |
| 角色锚点+帧池 | `ep.script.cast[]`、`st0.viewRefs` | 五要素锚点、试镜帧池（动态三视图） | 长在每集剧本里，跨集不复用；帧池用完沉底 |
| 定妆链 | cast_init/casting/screen_test 四任务 | 幂等派单、双档位、facegate | 产物不回流（`var/out/` 沉淀无索引） |
| 角色参考上传 | `POST /api/episodes/:id/castref/upload` | 已有上传通道先例 | 仅限单集角色参考，未成通用素材上传 |
| 风格包 | `project.style_pkg`（prompts/style.js 四内置包） | L0 层贯通全链 | 单项目单包，不可多包管理/A/B 对比 |
| 题材节拍 | `api/templates.js` 六款 | scriptgen 消费 | 无用户自建节拍 |
| 机审 | `workers/moderate.js` + `rules.moderation` | 镜级合规门 | 素材入库无合规门 |
| 合成 | `workers/compose.js` | 片头字幕卡+BGM(0.18)+台词 amix | **无 SFX/环境音混音通道**（音效域的后端前提） |

### 2.2 根因（沿用上轮诊断）

1. 素材埋在集工作台，脱离单集无法生产（Assets 视图强依赖 sceneId）。
2. 角色/场景是每集 script 临时数据，不是库资产。
3. 生产副产品全部流失（job 产物无收藏回流路径）。

---

## 3. 行业调研：素材体系怎么做

| 参照 | 机制 | 本方案对应 |
|---|---|---|
| 可灵「主体库」（O1） | 为一致性而生的素材宝库：上传多角度参考图，AI 记住角色/道具/场景，后续生成引用保持一致 | 角色域=主体库等价物（锚点+定妆+帧池）；场景/道具同理入库 |
| 即梦多模态参考 | 单次生成混合引用 9 图/3 视频/3 音频；先用图片模型定角色设定与场景概念图再生成 | 生成工作台「参考挂载」参数；图像域概念图先行 |
| AI 短剧工业化实践（百度/腾讯云系列） | 「创作资产库+流程表」先于生产；**定妆资产规范表/主体定义模板/判废表**；空镜/氛围素材与主角表演镜头**分层管理** | 设定域判废表；就绪度门禁；图像域 type 分层 |
| Epidemic Sound / Artlist（音乐库金标准） | mood×曲风×BPM×时长多维筛选、试听、收藏夹、使用追踪 | 音频域筛选器与收藏/评分 |
| Shotgrid（影视资产管理） | 资产版本管理、反向索引（被哪些镜头引用）、状态机（wip→appr→retired） | 版本管理、used_by、状态机 |
| Unity/Unreal Content Browser | 分类树+标签+缩略图预览+收藏夹+搜索 | 素材中心 UI 范式 |
| Runway Assets 面板 | 生成物与上传物统一入库，session 只引用不持有 | 集工作台只挂接，素材全在库 |

共识结论：**AI 视频生产平台的素材体系 = 内容库（成品素材）+ 一致性资产（参考/锚点/规范）双轨**，且「上传/生成/回流」三入口统一入库。

---

## 4. 目标架构

```
一级菜单：🎨 素材中心（#/studio）                ← 与项目工作区平级
  ├─ 🎵 音频   music(主题曲|BGM|氛围|MV) / sfx / ambience / voice
  ├─ 🖼 图像   establishing(定场) / empty(空镜) / prop(道具) / poster / mood(氛围) / mv
  ├─ 👤 角色   角色包：五要素锚点+gender+voice绑定+定妆图集+帧池+服装变体+版本
  ├─ 🏞 场景   场景卡：定场图+mood+环境音绑定+光线预设+日夜/天气变体
  ├─ 🎭 设定   风格包(多包管理) / 判废表 / 人物小传 / 自建节拍
  └─ 📥 候选池 drafts（生成未入库，TTL 自动清理）

三级作用域：global 公共库（跨剧）→ project 项目库 → episode 集覆盖
生命周期：  draft 候选 → candidate 待选 → approved 入库 → featured 精选 → retired 淘汰
积累路径：  抽卡生成 | 生产回流 | 上传导入 | 预置包 | 跨剧复用
```

组装原则：**素材中心只管「资产与绑定」，生产链只做「引用与覆盖」**——集工作台的「资产/音乐」tab 降级为挂接消费视图；提示词注册中心（prompts/）继续负责把库资产编译进各 worker 提示词。

---

## 5. 分域设计

### 5.1 音频域（用户「音乐」的专业完整版）

**music**：`type: theme(片头/片尾主题曲) | bgm | ambient(垫乐) | mv(成曲)`。
- 生成工作台参数：type/mood/曲风 tags（默认 MOOD_TAGS 词典+风格包 music_tags，可覆盖）/时长（15/30/45/60s）/结构（intro-build-fade，透传 ACE-Step lyrics 通道）；批量 3–6 段进候选池。
- 候选池网格：内联试听（audio player）、评分（1–5 星）、收藏入库/淘汰；TTL 7 天自动清。
- 挂接：1:N 绑定到场景（`bind`）或集级默认（主题曲挂集）；同场多曲=主曲+备选（compose 取主曲）。
- **sfx 音效**（P2）：事件性短音效（开门/耳光/雨打窗/心跳），来源=内置包+上传；**前提是 compose 扩混音通道**（现 amix 仅 BGM+台词，加 n 路 SFX 输入，量级小改）。
- **ambience 环境音**（P2）：场景级音床，与场景卡绑定；替代 ENV_AMBIENCE 词典的「文本描述」层——H3 IR soundscape 继续用文本，LTX/compose 用真音频。
- **voice 音色**（P1 轻量）：配音资产=可管理条目（音色名/gender/试听/绑角色）；tts.js `speakerFor` 推导已有，升级为「集级 voice_map UI + 角色域 voice 绑定」；旁白音色独立条目。

### 5.2 图像域

`type: establishing | empty | prop | poster | mood | mv`。
- 新任务类型 `img_free`（imgspark/img5060 双档复用）：参数=风格包+五要素提示词（复用 prompts/index.js buildXxx 范式新增 buildFreeImagePrompt）+可选参考图（即梦式挂载）+比例（默认 864×1536）。
- 定场图生成走场景域（见 5.4）；道具/氛围图走自由生图。
- 上传通道：推广 castref/upload 为通用 `POST /api/studio/images/upload`（自有授权素材导入，license 必填声明）。
- 合规：入库前过 rules.moderation 等价机检（软门：fail → 候选池标红，不自动入库）。

### 5.3 角色域（可灵「主体库」等价物）

角色包 = 一致性资产的集合体：
```
{id, role, scope, anchor(五要素), gender, voiceId, refImage,
 views[帧池], wardrobe[{name, desc}], 服装变体定妆图,
 versions[{ver, job_id, at, note}], used_by[{episodeId, castIdx}]}
```
- **实体化**：从集 cast 一键提取（回流）；新角色直接在素材中心建（锚点编辑器带五要素引导，复用 anchorWarnings 软校验）。
- **重定妆=版本**：v1/v2 并存，旧集引用旧版本不漂移（Shotgrid 版本语义）；换装=wardrobe 子条目各自出图。
- **复用**：跨集引用（C2 卡「从角色库引用」）；跨剧=复制角色包+换风格包重定妆（锚点保留）——第二季继承第一季。
- 帧池回流：screen_test 完成后帧池仍在 `viewRefs`，提供「帧池入库」动作挂到角色包。

### 5.4 场景域

场景卡 = {name, mood, env_desc, establishing 图, ambienceId, light_preset, variants[{tag:'夜|雨|雾', img}]}。
- 定场图：场景卡上直接生成（img_free 带场景 env_desc+风格包），变体各自出图。
- **接线（P2 生产打通）**：C1 分场后把剧本场景挂接场景卡——`scene.light` 取场景卡光线预设、`ENV_AMBIENCE` 查询先查场景卡 ambienceId、LTX/分镜图优先用定场图做 i2i 参考。这直接吃掉上轮 prompt 方案遗留的「场景一致性靠文本」短板。
- 跨集复用：同一部剧「卧室」全场次统一挂一张场景卡。

### 5.5 设定域（剧集圣经——一致性的根，行业「判废表」所在）

- **风格包实体化**：style_pkg 从 project 单值升级为库条目（多包管理）；项目选主包，素材/生成可选副包（为 P2 的 A/B 双包对比框架铺路）；四内置包继续做种子。
- **判废表**：按域/节点维护「判废标准」清单（面部畸变/口型漂移/景别单一张/串味词），aireview rubric 与人工复审共读同一份——把「判废」从隐性经验变库资产。
- **人物小传/世界观**（轻量）：brief 之外的结构化设定块（世界观/人物关系/称谓表），scriptgen usr 注入——解决长剧集连续性。
- **自建节拍**：templates.js 六款外允许用户存节拍模板（设定域条目，scriptgen 可选）。

---

## 6. 横切机制（九条）

1. **三级作用域**：`scope: 'global' | 'project'`；集级只做覆盖不做持有（Runway 语义）。P0 只落 project（global 字段预留），P2 开公共库。
2. **状态机**：draft→candidate→approved→featured→retired；只有 approved 会被生产链自动选中；retired 保留引用记录不物理删除。
3. **合规与许可**：入库软门（moderation 等价规则）；license 对象纪律延续（上传素材必填声明）；audit 全动作留痕（现有 `store.log("audit")`）。
4. **影子账本口径**：素材生成全部入影子账；`scope=project` 记项目账本，`scope=global` 记公共库科目（**不摊进单集**，避免破坏 Σcost==cost_cents 单集不变量；公共库单独汇总口径，运维台可见）。复用已入库资产=0 计费。
5. **版本管理**：重定妆/重出图/风格包改版=新版本条目，旧引用绑旧版本。
6. **反向索引**：所有绑定写 `used_by[]`；删除/改版前 UI 展示影响面（哪些场/集在用）。
7. **上传通道**：通用素材上传（图像/音频），沿用 castref/upload 的实现范式；文件落 `var/assets/library/<domain>/`。
8. **预置包冷启动**：内置 starter pack（曲库种子 mu1/mu2 迁移为首批 + 通用 SFX 包 + 四风格包示例图 + 常用场景卡包）——解决「空库没法开始生产」的冷启动死锁。
9. **就绪度门禁**：集工作台 EpisodeBar 加「开拍就绪」徽标（场景有定场图？角色有定妆+帧池？主题曲选定？voice_map 齐？），缺项清单直跳素材中心对应 tab。

**Copilot 集成**（P2）：llmintent 工具表加 3–4 个素材工具（`search_assets` / `generate_music` / `bind_asset` / `library_stats`），副驾升级为「素材管理员」（"给这场配三段压抑的 BGM"→ 直接代办）。

---

## 7. 数据模型与 API

### 7.1 state（store.js 迁移 + 种子）

```js
st.asset_lib = {
  version: 1,
  audio:  { music: [], sfx: [], ambience: [], voices: [] },
  images: [],
  characters: [],
  scenes: [],
  canon:  { style_pkgs: [], reject_rules: [], lore: [], beats: [] }
}
st.asset_drafts = { music: [], images: [] }   // 候选临时池，TTL 清理
```

迁移：openStore 检测无 asset_lib → 一次性迁移 `music_lib`（mu1/mu2 → audio.music，scope:'global'，status:'approved'，sceneId → used_by[]）；version 字段防重跑。

### 7.2 API 面（新 `api/library.js`，零依赖风格）

```
GET    /api/studio/summary                       # 各域计数+就绪度
POST   /api/studio/audio/music/generate          # {projectId?, type, mood, tags, sec, count} → jobs → drafts
GET    /api/studio/drafts / POST /api/studio/drafts/:id/adopt {status} / DELETE /:id
PATCH  /api/studio/:domain/:id                   # 元数据/评分/状态
POST   /api/studio/:domain/:id/bind    {kind, id}   / unbind          # 1:N 挂接
POST   /api/studio/images/generate               # img_free 任务（风格包+prompt+参考）
POST   /api/studio/images/upload                 # 通用上传（license 必填）
POST   /api/studio/characters/:id/recast         # 重定妆=新版本
POST   /api/studio/characters/:id/promote_frames # viewRefs 帧池回流入库
POST   /api/studio/scenes/:id/establishing       # 生成定场图（可带变体 tag）
GET    /api/studio/used_by/:domain/:id           # 反向索引
```

### 7.3 客户端

| 触点 | 改动 |
|---|---|
| `router.js` | ROUTES 加 `#/studio`、`#/studio/:tab`（music/images/characters/scenes/canon/drafts） |
| `app.js` | 导航一级项「🎨 素材中心」；EP_VIEWS 不变 |
| `views/studio.js`（新） | 五 tab+候选池；共享「资产网格」组件（预览/筛选/评分/绑定/影响面） |
| `store.js` | studio API 方法 + drafts 轮询（复用 genCandidates 的 3s 重取范式） |
| `components.js` | EpisodeBar「资产/音乐」→「素材挂接」+ 就绪度徽标；资产/音乐视图改为挂接视图 |
| 卡流 | C1 场景卡加「挂场景卡」入口、C2 加「从角色库引用」、配乐候选加「收藏入库」 |

---

## 8. 落地路线图

| 期 | 内容 | 触点 | 预估 |
|---|---|---|---|
| **P0 骨架+音频闭环** | 素材中心菜单/路由/五 tab 骨架；音乐域完整工作流（自由生成不绑场、type/mood/tags/时长、批量候选池、试听评分、入库淘汰、1:N 挂接）；music_lib→asset_lib 迁移；starter 曲库种子；集工作台挂接视图改造 | api/library.js、core/store.js、router/app/views/store、api/music.js（adopt 兼容层） | 1–2 天 |
| **P1 图像+角色+场景+回流** | img_free 任务+buildFreeImagePrompt；通用上传；定场图；角色域实体化（提取/版本/帧池回流）；场景域场景卡；就绪度门禁；入库合规软门 | imgspark/img5060、prompts/index.js、api/library.js、components.js、episodes.js（C1/C2 接线） | 3–5 天 |
| **P2 设定+打通+公共库** | 风格包多包管理+判废表+人物小传；SFX/ambience 库+compose 混音通道；voice_map UI；C1/C2 生产链引用素材（定场图 i2i、场景卡光线/环境音）；全局公共库+角色包/场景包导出导入；Copilot 素材工具；MV 素材包（选曲+选图接 compose 出宣发片） | prompts/style.js、compose.js、tts.js、llmintent.js、api/library.js | 1 周+ |

依赖：P1 的 buildFreeImagePrompt 依赖已落地的风格包/词典层（无新增依赖）；P2 compose 混音是 SFX 域前置。

---

## 9. 验收标准

1. **冷启动可用**：全新项目不进集工作台，仅靠素材中心（starter pack+抽卡）完成一集的配乐铺底与场景定场。
2. **一曲多挂**：同一首 BGM 绑 3 个场景，解绑 1 个不影响其余；主题曲挂集级默认，逐场可覆盖。
3. **回流闭环**：跑完一集试镜+定妆，帧池与定妆图一键入库为角色资产；第二季新项目复制该角色包重定妆成功，锚点保留。
4. **就绪度拦截**：素材不齐的集在 EpisodeBar 显示缺项清单，点击直达对应域。
5. **账本不变量**：scope=project 素材成本入项目账本；global 入公共科目不进单集；既有 Σcost==cost_cents 与 10/10 验收套件零回归。
6. **审计可查**：任一素材条目可追溯 source_job_id/上传者/license/版本链/used_by 全量历史。

---

## 10. 调研来源

- 可灵主体库（O1 release note）：https://klingai.com/release-note/release-notes/u3o4p73f2h ；可灵创作台：https://klingai.com/app
- 即梦 AI 全功能教程（多模态参考 9 图/3 视频/3 音频、角色一致性）：即梦官方文档与教程汇总
- AI 短剧工业化：[创作资产库+流程表实操指南（百度智能云）](https://cloud.baidu.com/article/10217552)、[定妆资产规范表/主体定义模板/判废表（腾讯云）](https://developer.cloud.tencent.com/article/2755047)、[从零复刻千万播放 AI 短剧全流程]、[AI 视频进入「生产线」调研（36 氪）]
- 音乐库范式：Epidemic Sound / Artlist（mood×genre×BPM×时长筛选、收藏夹、使用追踪）
- 影视资产管理：Autodesk Flow Production Tracking（Shotgrid）资产版本与引用追踪；Unity/Unreal Content Browser
- 本项目内证：`api/music.js` / `workers/music.js` / `workers/compose.js` / `workers/moderate.js` / `workers/imgspark.js` / `api/episodes.js`（castref 链）/ `core/store.js`（music_lib 种子）

---

## 11. 实施记录

**2026-11-22 已全量落地**（P0/P1/P2 一次施工完成）。任务卡级明细、踩坑记录与已知边界见 [theater-asset-center-build.md §11](theater-asset-center-build.md)。

- 验收：新增 V11 素材中心套件（迁移/冷启动闭环/1:N 多挂/旧接口兼容/账本口径/img_free/角色回流/就绪度/素材包/设定域/音色/MV/公共科目），全量回归 **11/11 PASS 零破坏**。
- 五域 API 落在 `src/server/api/library.js`（含候选池回流监听、1:N 绑定、primary 主曲、合规软门、上传、素材包、MV、公共科目）。
- 生产链接线：C9 采纳/配乐预检走素材库主曲口径；compose 环境音铺底通道；scriptgen lore 注入；aireview 判废表注入；tts 三级音色解析；img5060 场景卡光线四级。
- 客户端：一级「🎨 素材中心」（六 tab）＋集侧「素材挂接」视图（就绪度门禁）＋卡流回流按钮＋运维台公共科目 tab。
- **AI 生成编排（2026-11-22 下午④）**：歌词编辑器「✨ AI 扩写」（粘贴素材→按 ACE-Step 段标记规范结构化，主题忠实约束）；图像「✨ AI 写画面」（一句话→四层专业描述）；副驾工具 assist_lyrics/assist_image_prompt/generate_image——对话即可代办扩写与生成。明细见 build 文档 §11。
