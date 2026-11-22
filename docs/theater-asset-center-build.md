# 剧场 Studio · 素材中心施工计划

| 项 | 内容 |
|---|---|
| 文档 | theater-asset-center-build.md |
| 日期 | 2026-11-22 |
| 依据 | theater-asset-center-plan.md（方案）＋ theater-prompt-system-plan.md（提示词体系，L0/L3 直接消费） |
| 范围 | P0/P1/P2 全量任务卡：数据迁移、服务端、引擎、提示词、客户端、生产链接线、测试与回滚 |
| 施工原则 | **能复用的全部复用，冲突处一律以行业主流实现为准**（裁决表见 §0.2，现有实现让位） |

---

## 0. 施工总则

### 0.1 复用清单（白得的能力，一律不重造）

| 能力 | 位置 | 素材中心怎么吃 |
|---|---|---|
| job 引擎（lane 串行/失败梯子/幂等/预算护栏） | `src/server/dag/engine.js` | 素材生成=普通 enqueue；`img_free` 只需 TYPE_LANE 加一行 |
| GPU/LLM 互斥让路 | `engine.js:9 LOCAL_GPU_TYPES` | `img_free` 加入该数组 → 自动参与独显让路 |
| 影子账本/license/audit | `shadow_cents` + `store.log("audit")` | 全素材条目延续；公共科目口径见 §6.4 |
| 静态产物面 | `src/server/index.js:182`（`/var/out/`、`/var/assets/`） | 素材文件落 `var/assets/library/` → URL 直接可用，零改动 |
| 原始字节上传范式 | `api/episodes.js:359` castref/upload（`{raw:true,limit:16MB}`+魔数校验） | 复制为通用素材上传（加 WAV/MP3 魔数） |
| 机审规则 | `rules/moderation.js` | 入库软门复用 |
| 提示词注册中心 | `src/server/prompts/`（style/dicts/index） | buildFreeImagePrompt 照 buildCastingPrompt 范式加；词典全复用 |
| 图像 worker 双档 | `workers/imgspark.js`（cast_init/casting/screen_test）+ `img5060.js` | 角色域生成全复用，只加 library 生成分支 |
| 音乐 worker | `workers/music.js`（ACE-Step tags 通道已接） | 加 type/sec/结构参数透传 |
| 客户端范式 | store 方法+3s 轮询（`store.js:318`）、Vue 视图注册、C9 试听 UI（`flow.js:441`） | Studio 视图照抄范式 |

### 0.2 冲突裁决表（现有实现 vs 行业主流——一律按行业主流改）

| # | 冲突点 | 现有实现 | 行业主流 | 裁决 |
|---|---|---|---|---|
| K1 | 生产入口 | 生成强绑 sceneId（`api/music.js:83`），图像无独立入口 | 库先行：素材中心独立生产，生成与绑定解耦（Runway/Epidemic/可灵主体库） | **推翻** sceneId 强校验；generate 的 projectId 可选、sceneId 不传 |
| K2 | 挂接语义 | 1:1，同场换曲=替换（`music.js:34` adoptCandidate） | 1:N 绑定＋集覆盖＋反向引用追踪（Shotgrid） | **推翻**替换语义；新 bind/unbind；C9 采纳改走 bind |
| K3 | 候选管理 | `music_pending` 集级临时数组 | 统一候选池：状态机 draft→approved + 评分 + TTL（Epidemic 收藏夹） | **推翻**；新建 `asset_drafts`，music_pending 保留只读兼容一版 |
| K4 | 库结构 | `st.music_lib` 扁平全局数组 | 分域条目 + scope/status/rating/version | **迁移** music_lib → `st.asset_lib.audio.music`（旧字段保留一版） |
| K5 | 角色/场景归属 | 每集 `ep.script.cast/scenes` 临时数据 | 主体库/场景库实体资产，集做引用（可灵主体库） | 角色域实体化；script.cast 增加 `charId` 引用字段（可选，向后兼容） |
| K6 | 配乐工作流 | C4 拍板自动每场 3 候选→C9 现场挑 | 库驱动：按 mood 推荐已有库存 + 不足才生成 | 自动流保留但**落库化**（候选入 drafts，采纳=bind），素材中心手动流并行 |
| K7 | 音色管理 | speakerFor 推导 + 1 条映射（`tts.js`） | 音色库条目＋试听＋集级 voice_map（配音资产管理） | 建 voices 子域；voice_map UI（P2） |
| K8 | 成本口径 | 全记单集账本 | 公共资产记公共科目（资产会计） | scope=global → 公共科目，**不入单集 Σcost**；项目库照旧 |
| K9 | 产物引用 | `art:"var/out/*.mp3"` 相对路径（`flow.js:6` 已挂 BACKEND-ISSUE） | 资产条目持有稳定归档文件 | 入库时归档到 `var/assets/library/<域>/`，条目存 `file`；`var/out` 原件不动 |
| K10 | 预览寻址 | 曲目音频靠静态兜底拼路径 | 稳定资产 URL | `var/assets/library/…` 直接命中现有静态面，**零改动解决** K9 |

---

## 1. 分期总览与任务卡

### P0 —— 骨架 + 音频域闭环（1–2 天）

| 卡 | 任务 | 触点 | 关键点 | 验收 |
|---|---|---|---|---|
| A1 | state 骨架＋一次性迁移 | `core/store.js` | `st.asset_lib`/`st.asset_drafts` 缺失时建构；music_lib→audio.music（条目补 scope/status/rating/used_by，旧字段保留）；种子 mu1/mu2 → global/approved | 老库打开自动迁移，version 防重跑；旧接口不报错 |
| A2 | `api/library.js` 骨架＋音频 API | 新文件（api/*.js 自动装载） | 路由表见 §3.1 | summary/music 全通 |
| A3 | music worker 参数扩展 | `workers/music.js` | payload 加 `type/sec/tags` 透传 ACE-Step；sec 缺省 45 | 指定时长生效 |
| A4 | 引擎无需改 | — | music lane 已存在；global 任务无 episodeId → 预算护栏自然跳过（护栏逻辑按 episodeId 存在与否分支，施工时确认） | — |
| A5 | 客户端骨架 | `router.js`（#/studio、#/studio/:tab）、`app.js`（一级导航）、新 `views/studio.js`、`store.js`（studio API） | 五 tab 空壳＋音频 tab 完整 | 一级菜单可见可路由 |
| A6 | 音频 tab 工作台 | `views/studio.js` | 生成表单（type/mood/tags/时长/数量）→ drafts 网格（audio 内联试听、评分、收藏/淘汰）→ 库表（筛选+绑定管理+影响面） | 不进任何一集完成「生成→筛选→入库→绑定」闭环 |
| A7 | 集侧挂接视图 | `views/assets.js` 重写、`components.js` EpisodeBar tab 改名「素材挂接」 | 本集场景×库曲绑定/解绑；主曲标记；就绪度 v0（有主题曲？每场有曲？） | 一曲绑 3 场互不影响 |
| A8 | C9 兼容接线 | `api/cards.js:467`、`api/music.js` | adoptCandidate 变薄壳：出 pending → 写 drafts adopt → bind(sceneId)；`hasMusicFor`（cards.js:293）改查 bind；`compose.js:187` 取曲改 `library.musicForScene()` | C9 拍板流程回归通过 |
| A9 | 回归＋单测 | `test/` | 新增 V11 素材中心套件（§8）；既有 10/10 不破 | 全绿 |

### P1 —— 图像/角色/场景域 + 回流（3–5 天）

| 卡 | 任务 | 触点 | 关键点 | 验收 |
|---|---|---|---|---|
| B1 | `img_free` 任务类型 | `engine.js`（TYPE_LANE＋LOCAL_GPU_TYPES）、`workers/imgspark.js`（tier=high）/`img5060.js`（标准） | 素材生成分支：不挂集、产物落 `var/out`→adopt 归档 | GPU 让路生效；stub/真引擎双模式 |
| B2 | buildFreeImagePrompt | `prompts/index.js` | 风格包锚最前＋五要素＋景别光线＋分层负面（复用 negativeFor）；参考图优先级声明 | 同 brief 三风格包出图无串味 |
| B3 | 图像域 API＋上传 | `api/library.js` | images generate/upload/bind；上传复制 raw 范式＋PNG/JPEG 魔数；license 必填 | 上传→预览→绑定通 |
| B4 | 入库合规软门 | `api/library.js` adopt | rules.moderation 等价机检 fail → 候选标红不入库 | 违规图被拦 |
| B5 | 角色域 | `api/library.js`、`episodes.js` | extract（集 cast→角色包）/recast（版本）/promote_frames（viewRefs→帧池入库）/bind；script.cast 加可选 charId | 一键提取→跨集引用→重定妆 v2 旧引用不漂移 |
| B6 | 场景域 | `api/library.js`、`prompts/dicts.js` | 场景卡 CRUD/establishing 生成/变体/ambienceId+light_preset 字段 | 场景卡出定场图，变体各自出图 |
| B7 | Studio 三 tab UI | `views/studio.js` | 共享资产网格组件（预览灯箱/筛选/评分/绑定/影响面）；角色包卡片（锚点+图集+版本） | 五 tab 全部可用 |
| B8 | 回流接线 | `views/flow.js`（C9:441、C2 候选区）、试镜完成回调 | 定妆/帧池/配乐候选加「收藏入库」按钮 | 生产一集素材库净增长 |
| B9 | 就绪度门禁 | `components.js`、`api/library.js` | summary 出就绪度清单；EpisodeBar 徽标+缺项直达 | 缺定场图的集显缺项 |
| B10 | 回归＋单测 | `test/` | V11 扩图像/角色/场景 | 全绿 |

### P2 —— 设定域 + 生产打通 + 公共库（1 周+）

| 卡 | 任务 | 触点 | 关键点 | 验收 |
|---|---|---|---|---|
| C1 | 设定域 | `api/library.js`、`prompts/style.js`、`scriptgen.js`、`aireview.js` | 风格包多包管理（项目主包+素材副包）；判废表（aireview rubric 同源）；lore 注入 scriptgen usr | 双包 A/B 出样片；lore 进剧本 |
| C2 | SFX/ambience 域＋compose 通道 | `workers/compose.js`、上传 | amix 扩 n 路（SFX 按镜/按事件时间轴）；环境音按场铺底 | 成片带音效层 |
| C3 | voices 域＋voice_map | `tts.js`、views | 音色条目（试听）＋集级 role→音色 UI；旁白独立 | 男频剧全男声 |
| C4 | 生产链引用 | `workers/img5060.js`/`imgspark.js`/`video5060.js`、`cards.js` C1/C2 | 场景卡→light/ambience/定场图 i2i；角色包→C2 直接引用不重生成 | 场景跨镜同图一致 |
| C5 | 全局公共库＋包迁移 | `api/library.js` | scope=global 生效；角色包/场景包导出导入（manifest+文件 zip） | 第二季继承第一季角色包重定妆 |
| C6 | Copilot 素材工具 | `l2/llmintent.js`、`l2/tools.js` | search_assets/generate_music/bind_asset/library_stats 四工具进工具表 | "给这场配三段压抑 BGM"直接代办 |
| C7 | MV 素材包 | `api/library.js`、`compose.js` | 选曲+选图/片段→宣发 MV（复用片头字幕卡管线） | 出 30s 宣发片 |
| C8 | 运维台公共科目 | `views/admin.js`、`api/costs.js` | 公共库账本汇总视图 | 公共成本可见 |

---

## 2. 数据模型施工（A1）

```js
// core/store.js —— openStore 时 ensure/migrate（一次性，version 防重跑）
st.asset_lib = {
  version: 1,
  audio: {
    music: [/* 迁移自 music_lib，条目补齐 ↓ */],
    sfx: [], ambience: [], voices: []
  },
  images: [], characters: [], scenes: [],
  canon: { style_pkgs: [], reject_rules: [], lore: [], beats: [] }
}
st.asset_drafts = { music: [], images: [] }   // TTL 7 天（load 时惰性清理）

// music 条目（迁移补齐字段；旧字段 sec/mood/engine/license/shadow_cents/art 保留）
{
  id, title, type: "bgm"|"theme"|"ambient"|"mv",
  mood, tags, sec, engine, license, shadow_cents,
  scope: "global"|"project", projectId: null,
  status: "approved",            // candidate|approved|featured|retired
  rating: 0, file: "library/audio/xxx.mp3",   // 归档相对 var/assets/
  used_by: [{ kind: "scene", id, primary: true }],
  source_job_id, source: "generated"|"upload"|"seed", created_at
}
// images / characters / scenes / canon 条目结构见方案文档 §5
```

迁移要点：只增不删——`music_lib` 原数组保留只读一版（P1 结束后删）；`sceneId` → `used_by[{kind:"scene",id,primary:true}]`；`art` → `file`（归档复制到 library/，原 var/out 文件不动，K9）。

---

## 3. 服务端施工

### 3.1 `api/library.js` 路由表（A2/B3/B5/B6）

```
GET    /api/studio/summary                          # 各域计数+就绪度+drafts 计数
GET    /api/studio/:domain                          # 列表（domain=music|images|characters|scenes|sfx|ambience|voices|canon.*）支持 ?scope/status/type/mood/q 筛选
POST   /api/studio/audio/music/generate             # {projectId?, type, mood, tags?, sec?, count≤6} → engine.enqueue("music",...) ×N → drafts
POST   /api/studio/images/generate                  # {projectId?, prompt, styleLook?, refImage?, ratio?} → engine.enqueue("img_free",...) → drafts
POST   /api/studio/upload?domain=images|sfx|ambience&license=…   # raw bytes（复用 {raw:true,limit}）
PATCH  /api/studio/:domain/:id                      # 元数据/评分/status（retired 校验 used_by 提示）
DELETE /api/studio/drafts/:domain/:id               # 候选淘汰
POST   /api/studio/drafts/:domain/:id/adopt         # draft→approved，归档 var/out→var/assets/library/，机审软门（图像）
POST   /api/studio/:domain/:id/bind                 # {kind:"scene"|"episode"|"character", id, primary?} → used_by.push；scene 曲 primary 互斥（compose 语义）
POST   /api/studio/:domain/:id/unbind               # {kind,id}
GET    /api/studio/used_by/:domain/:id              # 反向索引（UI 影响面）
POST   /api/studio/characters/:id/extract           # {episodeId, role} ← 集 cast 实体化
POST   /api/studio/characters/:id/recast            # 重定妆 → versions.push
POST   /api/studio/characters/:id/promote_frames    # viewRefs → 帧池入库
POST   /api/studio/scenes/:id/establishing          # 生成定场图（变体 tag 可选）
GET    /api/studio/music_for_scene/:sceneId         # compose/cards 查询口（primary 曲）
```

### 3.2 引擎施工（B1，两行改 + worker 分支）

- `engine.js` TYPE_LANE 加 `img_free: "img5060"`；`laneFor` 加 `tier==="high" → "imgspark"`；`LOCAL_GPU_TYPES` 加 `img_free`（让路联动）。
- `imgspark.js` run() 加 `j.type === "img_free"` 分支：payload{prompt, styleLook, refImage, ratio} → buildFreeImagePrompt → comfySpark/stub 双模式，产物 `var/out/lib_<hash>.png`。
- `img5060.js` 同构标准档分支。

### 3.3 兼容层（A8——不破坏现有流程的关键缝）

| 旧引用点 | 改法 |
|---|---|
| `cards.js:293 hasMusicFor` | 改查 `library.hasBinding("scene", sceneId)` |
| `cards.js:467` C9 accept `adoptCandidate` | 内部改：出 pending → drafts.adopt → bind(sceneId, primary)；对外签名不变 |
| `compose.js:187` 取 BGM | 改 `library.musicForScene(sceneId)`（used_by primary） |
| `api/music.js` 三路由 | 保留为薄壳转发 library（旧客户端/AI 审查引用不断）；`GET /api/music/library` 投影旧形状 |
| `cards.js:989 music_pending` 写入 | 保留（C4 自动流继续），但 candidates 同步镜像进 drafts（K6 落库化） |

---

## 4. 客户端施工

| 卡 | 内容 |
|---|---|
| A5 | `router.js` ROUTES 加 `#/studio`、`#/studio/:tab`（view:"Studio"）；`app.js` nav 加「🎨 素材中心」（登录可见，非 ops 也可见——素材是创作者工作面） |
| A6/B7 | `views/studio.js`：组件树 = StudioShell（tab 栏+summary 头）→ AssetGrid（共享：卡片网格/预览/筛选器/评分/绑定/影响面抽屉）→ 域面板（AudioPanel/ImagePanel/CharPanel/ScenePanel/CanonPanel/DraftsPanel）。音频试听 `<audio controls>` 直指 `var/assets/library/...` 静态 URL；图像灯箱复用既有 img 展示范式 |
| A7 | `views/assets.js` 重写为挂接视图：本集场景列表 × 每场「主曲+备选」绑定器 + 就绪度清单 v0；`store.js` loadMusic 改指 /api/studio |
| B8 | `views/flow.js`：C9 候选区（:441）加「收藏入库」；C2 定妆候选加「入库为角色资产」；试镜完成 toast 加帧池入库入口 |
| B9 | `components.js` EpisodeBar：tab 改名「素材挂接」+ 就绪度徽标（红点=缺项，点开缺项清单，每项直达 #/studio/<tab>?…） |

---

## 5. 提示词层施工（B2/C1）

- `prompts/index.js` 加 `buildFreeImagePrompt({style_pkg, prompt, size, light, refNote})`——骨架照 buildCastingPrompt：风格锚最前+五要素+景别/光线（词典）+分层负面+单幅纪律；有参考图时声明「用户参考图优先」。
- 场景定场图 = buildFreeImagePrompt 的场景特化（env_desc+变体 tag 映射光线/天气词）。
- C1 判废表（P2）：`canon.reject_rules` → aireview rubric 拼接处注入；lore → scriptgen usr 注入（q() 定界）。

---

## 6. 生产链与口径（P2）

1. **场景引用**：cards.js C1 物化时若 scene 绑定场景卡 → `scene.light` 取卡 light_preset、ambience 查卡 ambienceId、storyboard/LTX 生成时 establishing 图作 i2i 参考（payload 加 refEstablishing）。
2. **角色引用**：C2 卡 accept 时若 cast 有 charId → 直接引用库内定妆/帧池，跳过重复生成；无引用才走现流程（渐进迁移）。
3. **compose SFX 通道**：ffmpeg filtergraph 扩展——现 `amix`（compose.js:195-200）从 `[bgm]+[dlg…]` 扩 `[sfxN]`（每路 `adelay=事件时间轴`），duration=first 语义保留。
4. **成本口径（K8）**：enqueue 时 `opts.episodeId` 为空（素材任务）→ job 账本标 `scope:"global"`；costs 汇总分「项目账本/公共库科目」两视图；**公共科目不进任何单集 Σcost**（护栏只对有 episodeId 的 job 生效——A4 施工时确认 engine 预算检查对无 episodeId 任务天然跳过，若无则加分支）。
5. **公共库护栏（P2）**：公共科目月累计超阈值 → ops 告警（不拦截）。

---

## 7. 迁移与兼容策略

1. **迁移开关**：`ensureAssetLib(st)` 在 openStore 与每次 commit 前调用；`asset_lib.version` 存在即跳过。旧字段（music_lib、music_pending、entry.sceneId/art）保留至 P1 验收后单独清理卡（D1）。
2. **API 兼容**：`/api/music/*` 三个路由全程保留薄壳；客户端切换后可下线视图调用但接口不删（外部脚本/AI 引用面）。
3. **回滚**：schema 只增不删 → 回滚=代码回退旧包即可（旧代码读旧字段照常工作）；归档文件复制不移动，原 var/out 产物不受影响。
4. **验收环境**：`runtime/start-8767.cmd` 本地库 + 种子库双跑迁移验证。

---

## 8. 测试与验收

新增 V11 素材中心套件（挂入既有验收脚本，风格同 V1/V5/V9/V10）：

| 用例 | 断言 |
|---|---|
| V11.1 迁移 | 旧种子库打开 → asset_lib.version=1；mu1/mu2 在 audio.music 且 used_by 投影正确；music_lib 保留 |
| V11.2 冷启动闭环 | 无集上下文 generate×3 → drafts 出 3 → adopt 1 → bind 2 场 → musicForScene 返回 primary |
| V11.3 多挂解绑 | 绑 3 场解绑 1 → 其余 used_by 不变；primary 换曲 → musicForScene 跟随 |
| V11.4 img_free | enqueue→stub 产物→adopt 归档→静态 URL 200；tier=high 走 imgspark lane |
| V11.5 合规软门 | 构造 moderation fail → adopt 拒绝入 approved |
| V11.6 角色回流 | extract→promote_frames→recast v2→旧集引用仍指 v1 |
| V11.7 就绪度 | 缺定场图集 → summary.ready=false 且缺项清单含该项 |
| V11.8 账本口径 | global 素材 job 不进任何集 Σcost；project 素材 job 计入 projectId 账本；Σcost==cost_cents 全程不变量 |
| V11.9 兼容 | /api/music/library 旧形状投影==迁移前内容；C9 accept 全流程回归 |

既有回归：V1 全链 / V5 账本 / V9 L2 双模 / V10 配乐预检 零回归是每期合入门槛。

---

## 9. 风险表

| 风险 | 缓解 |
|---|---|
| C9/adopt 兼容层回归破坏配乐流 | A8 单独成卡＋V11.9 专门回归；薄壳不改签名 |
| engine 预算护栏对无 episodeId 任务行为未知 | A4 施工首项确认；无则加显式分支（global 任务跳过护栏） |
| state.json 膨胀（素材元数据+used_by） | 条目只存元数据不存二进制；retired 不物理删；drafts TTL 清理 |
| var/assets/library 存储增长 | 上传/adopt 全 audit；运维台存储视图（P2 C8 顺带） |
| 双写期数据漂移（music_lib 与 asset_lib） | 迁移后 music_lib 只读；所有写路径收口 api/library.js |
| 音频时长参数 ACE-Step 实际不支持 | A3 先透传，预检（V10 范式）探测能力，不支持则退 45s 默认＋toast 说明 |

---

## 10. 施工顺序（P0 两日切分）

- **D1 上午**：A1 迁移＋种子 → A2 library 骨架＋summary/music 列表 → V11.1 过
- **D1 下午**：A3 worker 参数 → A5 客户端骨架＋路由＋导航 → Studio 音频 tab 只读
- **D2 上午**：A6 生成/drafts/adopt/bind 全流程 → V11.2/11.3 过
- **D2 下午**：A7 挂接视图 → A8 兼容层 → A9 全量回归（V11 + 既有 10/10）→ **P0 合入**

P1/P2 依卡顺序推进，每卡独立可验证，合入门槛同 §8。

---

## 11. 实施记录

**2026-11-22 全量落地**（P0+P1+P2 一次施工完成），验收套件 **11/11 PASS 零回归**（含新增 V11 素材中心套件 10 组断言）。

### 服务端

| 卡 | 落地内容 |
|---|---|
| A1 | `core/store.js`：`ensureAssetLib`（version 防重跑）＋`pruneDrafts`（TTL 7 天惰性清理）；music_lib→asset_lib.audio.music 一次性迁移（旧数组只读留档，可回滚） |
| A2 | 新 `api/library.js`（约 700 行）：summary/readiness/:domain 列表/PATCH/bind/unbind/used_by/music_for_scene + 候选池 drafts(列表/淘汰/adopt)；**回流监听**（bus.on("jobs")：无集归属 music/img_free 完成→候选池）；路由按「具体前缀先于通用 :domain」注册（首中即停语义，drafts/public_ledger 两处踩坑已修） |
| A3 | `workers/music.js`：payload type/sec/tags 透传（真模式 body.seconds+tags 覆盖；stub 固定时长）；候选带 asset_type/tags |
| A4 | 引擎确认无需改：无 episodeId 任务天然跳过预算护栏与单集 Σcost（`engine.js` runJob ep null 分支）——billing 行 episodeId=null 即公共科目 |
| A8 | `api/music.js` 重写为素材库薄壳：adoptCandidate 签名不变，内部入库+bindPrimary（primary 互斥＝每场主曲唯一，替换旧「同场换曲删除」语义）；`cards.js` adoptedForScene→`libMod.hasSceneBinding`；`compose.js` 取曲 primary 绑定优先（修正了 runReal 作用域引用隐患）；`deliver.js` 预检改**主曲口径**（备选曲不拉 fail，V10 语义修复） |
| B1 | `engine.js`：TYPE_LANE+`img_free:"img5060"`、LOCAL_GPU_TYPES 加入（GPU 让路联动）。**实施偏离记录**：img_free 固定 img5060 车道，未接 imgspark 高价值档——素材生图不需要 H3 身份档，一条代码路径风险最低；`img5060.js` img_free 分支（buildFreeImagePrompt+TMPL_T2I/I2I+参考图拷入 ComfyUI input） |
| B2 | `prompts/index.js`：buildFreeImagePrompt（风格锚最前+单幅纪律+负面分层） |
| B3/B4 | 通用上传 `POST /api/studio/upload?domain=`（raw bytes+魔数校验 PNG/JPEG/WAV/MP3，license 必填）；入库合规软门 moderateAsset（langlint 文本+产物文件存在性，fail→422 MODERATION_FAIL） |
| B5/B6 | 角色域 extract（幂等 existed）/recast（img_free→adopt attachCharacter=新版本）/promote_frames（viewRefs→character.views）；场景域场景卡 CRUD+establishing 生成（adopt attachScene+variantTag） |
| C1 | scriptgen usr 注入 canon.lore（q() 定界）；aireview sys 注入 canon.reject_rules（判废表） |
| C2 | compose 终混扩环境音通道：本集各场绑定 ambience 按「该场首镜起点 adelay」混入（volume 0.12，失败不阻断）。**SFX 事件级时间轴未做**——需要点位编辑器，列入后续批次 |
| C3 | `tts.js` resolveSpeaker 三级：集 voice_map（音色库 id→spk）→ 角色域 voice 绑定 → 既有推导；`POST /api/studio/voice_map/:episodeId` |
| C4 | `img5060.js` storyboard 光线四级：镜 light → 场景卡 light_preset（state 场景 1:1 序对齐）→ mood 词典 → 风格包 |
| C5 | packs/export（theater-asset-pack v1 manifest）+ import（新 id 合并、scope=global、冲突跳过） |
| C6 | Copilot 4 工具：search_assets/library_stats/bind_asset/generate_music（governance TOOLS+estimate、llmintent 工具表+ARG_KEYS、tools.js 执行器；bind_asset 内联 scene_no 解析——llmintent.resolveSceneNo 不在作用域，踩坑已修） |
| C7 | `POST /api/studio/mv/build`：选曲+选图→ffmpeg 轮播+配乐（zoompan 轻推），best-effort——无 ffmpeg 如实 skipped 不伪造 |
| C8 | `GET /api/studio/public_ledger`（ops）：episodeId=null 账本行汇总+公共库计数；运维台新增「🏛 公共科目」tab |

### 客户端

| 卡 | 落地内容 |
|---|---|
| A5 | router `#/studio(/:tab)`；app.js 一级菜单「🎨 素材中心」；`api.js` +patch/+rawPost；store.js studio 方法段（24 个方法） |
| A6/B7 | 新 `views/studio.js`：六 tab（音频/图像/角色/场景/设定/候选池）——生成表单（类型/mood/tags/时长/批数/归属）、候选池试听/看图/收藏/淘汰（图像候选可挂角色版本/场景定场图）、曲库表（评分★/绑定主曲/影响面/上传）、角色卡（提取/帧池入库/重定妆）、场景卡（建卡/出定场图/变体）、设定域三栏、40s 轮询 |
| A7 | `views/assets.js` 重写为挂接视图：开拍就绪清单+每场主曲绑定器（1:N+备选展示）；EpisodeBar tab 改「素材挂接」+就绪度徽标（缺素材红点/就绪绿勾） |
| B8 | flow.js 回流：C9 候选「收藏入库」（POST /api/music/:id/adopt 无 sceneId→入库不挂场）；C2 角色「入库为角色资产」 |
| CSS | app.css 追加 v-studio-* 段 |

### 并行会话冲突处理

施工期间检测到另一会话在做「删除项目/集」功能（store.js/home.js/projects.js/episodes.js 同时段变更）：本施工全部改动收窄在素材中心文件面，store.js 客户端仅追加 studio 方法段（合并无冲突）。

### 已知边界（后续批次）

1. SFX 事件级时间轴混音（需点位编辑器）——环境音铺底通道已上；
2. img_free 未接 Spark 高价值档（素材生图标准档足够）；
3. 素材包导出为元数据 manifest（自部署单机文件同盘，无需搬二进制；跨机部署需加文件 zip）；
4. MV 合成依赖本机 ffmpeg，缺席如实 skipped；
5. Copilot 素材工具未进 V9 断言（白名单已加；LLM 意图命中依赖真实 llm-gw）。

### 追加修复（2026-11-22 下午·浏览器实测「图片显示不出」专项）

用户报告「角色提取、入库图片显示不出」——浏览器 E2E 实测定位三根因并全部修复：

| # | 根因 | 修复 |
|---|---|---|
| 1 | **素材寻址 404**：cast 参考图 refImage 是裸文件名（var/assets/cast/ 相对名），Studio 视图直接 `/文件名` → 404 | 客户端统一 `T.artUrl()`（util.js）：裸文件名→cast 目录、var/ 相对→根路径；studio/assets/flow 三视图全部接线（与 cards.js:699 服务端约定对齐） |
| 2 | **占位图不可见**：stub 模式产物是 1×1 透明 PNG——卡片里放大＝一片空白 | `core/util.js` 新增 `stubPng()`（零依赖手写 PNG：CRC32+zlib，深底斜纹竖屏 26KB）；img5060/imgspark stub 全量替换——占位图一眼可辨 |
| 3 | **浏览器缓存旧 JS（主因）**：客户端静态面无 Cache-Control → 启发式缓存；并发会话 bump 的 `?v=ch3` 版本键早于本施工的 store.js 编辑 → 用户侧永远拿旧文件 → 素材中心渲染空白 | `index.js` 静态面补 `Cache-Control: no-cache`（每次 revalidate）；版本键 bump ch4 冲存量 |
| 附 | img_free 参考图解析 | 兼容 var/assets/cast 裸文件名（重定妆带参考图生效） |
| 附 | 套件端口碰撞 | `test/lib.js` BASE_PORT 支持 `TEST_BASE_PORT` 环境变量（与并行会话的套件互不干扰） |

E2E 实测记录（浏览器真机）：登录→素材中心六 tab→音频生成 6 候选→UI 收藏入库（drafts 6→5、归档 var/assets/library、音频 HTTP 200）→图像上传入库（HTTP 200、PNG 解码 720×1280）→角色卡（林晚 refImage 200）→场景卡建卡渲染→设定域 lore 入库→集侧就绪度清单（缺项＋去补）→主曲绑定 UI（行内更新）→卡流页零 JS 错误→运维台公共科目（账本 2 行/65 分/库存曲 1 图 1）。全量回归 **11/11 PASS**。

### 追加迭代（2026-11-22 下午②·音乐生成专业化＋样式修复）

用户反馈「样式显示不全＋音乐生成太随意」——调研主流（Suno Custom Mode / ACE-Step 1.5 官方教程）后重构：

**音乐生成专业配置（对齐引擎三通道）**
- `prompts/dicts.js` 新增 `MUSIC_GENRES`（18 曲风）/`MUSIC_INSTRUMENTS`（15 乐器）/`MUSIC_VOCALS`（6 人声）/`MUSIC_TYPE_PRESETS`（四类型预设：默认人声/结构段/歌词骨架/hint）＋`composeMusicTags`（稳定顺序组装：曲风→乐器→情绪→BPM→人声→类型 hint）＋`lyricsWarnings`（[Chorus] 缺失软校验）
- `api/library.js` generate：三模式（quick/standard/expert）＋类型预设；最终 tags 在 API 层组装并随 payload 快照（审计可回放）；纯音乐默认结构段标记（ACE-Step 无文本段标记法）；lyrics/caption/instrumental 全通道透传
- `workers/music.js`：ACE-Step body 增加 `lyrics/prompt/instrumental`（旧服务端忽略无害）；sec 上限放宽 180s（BGM 长垫乐）
- `views/studio.js` 音频面板重构：类型预设 4 卡片（选中态驱动默认值）→ 模式三段切换（快速=心情一键／标准=曲风·乐器·人声·BPM chips＋结构行／专家=自由 tags 覆写＋caption 通道＋完整歌词编辑器带 [Verse]/[Chorus] 快捷插入与恢复预设）→ 生成按钮带段数与配置摘要＋软警告行
- E2E 实测：standard 模式（cinematic+orchestral+piano+strings ensemble+72bpm）→ 候选 tags `cinematic, orchestral, piano, strings ensemble, 释然, 72 bpm, ambient, cinematic, underscore` 全链落位；expert 模式主题曲（男声+歌词骨架改写+caption）→ `tags: 释然, male vocal, cinematic pop, emotional`、`lyrics_used: user-lyrics`

**样式修复（截图定位）**
- 曲库/候选池表格列被 audio/绑定控件挤成一字一行竖排：`.v-studio/.v-assets .table` 加 `min-width:980px`＋`th/td nowrap`（绑定区允许换行）＋横向滚动
- 新组件样式：预设卡（选中橙边）／模式胶囊／chips（选中反色）／歌词编辑器（mono、pre、可拉伸）／软警告条

回归 **11/11 PASS**（TEST_BASE_PORT=18900 避让并行套件）。

### 追加迭代（2026-11-22 下午④·AI 生成编排＋图像专业化）

用户诉求：歌词编辑器粘贴后 AI 按模型特性扩写结构化；图像对齐音乐的专业度；引入 AI 助手编排。

- **AI 辅助端点**（prompts 注册中心新 buildAssistLyricsSys/Usr、buildAssistImageSys/Usr）：
  - POST /api/studio/ai/lyrics——粘贴素材→按 ACE-Step 段标记规范扩写结构化歌词；忠实约束（素材核心意象必须保留，防主题漂移）；[Chorus] 缺失软警告；离线 503 如实
  - POST /api/studio/ai/image-prompt——简单想法→四层专业画面描述＋negative＋tags（JSON 契约）
- **UI**：歌词编辑器加「✨ AI 扩写」＋素材粘贴区；图像面板重构对齐音乐（6 类型预设卡＋快速/标准/专家＋景别/光线 chips＋参考图即梦式挂载＋负面增补＋「✨ AI 写画面」）；img_free 扩参 size/light/negativeExtra 进 buildFreeImagePrompt 四层拼装
- **Copilot 编排**：新工具 assist_lyrics/assist_image_prompt（AI 扩写直接回给用户）/generate_image（进候选池，必答门）——用户可在对话里「帮这场写一段压抑的主题曲歌词」「给码头出一张定场图」直接代办；并行 commit 覆盖的 C6 四工具已重打恢复
- **真机实测**（LLM 在线）：AI 歌词扩写（灯塔素材→完整结构化歌词，意象全保留，副歌记忆点）；AI 画面扩写（雨夜码头老兵→四层描述＋negative＋tags）；UI 两按钮全流程通过
- **修复**：渲染空白根因＝return 块丢失 musicFilter/musicList（渲染期 TypeError 被 prod 静默吞掉）——vnode 解剖定位后补回
- 回归 **12/12 PASS**（含并行会话新增 V12；TEST_BASE_PORT 避让）

### 追加迭代（2026-11-22 下午⑤·候选池溯源＋生成中可见性＋选项中文化）

用户三连反馈：「候选池要加生成要素，不然搞不清什么要素生成的样本」「得把引擎/节点/时间显示出来」「风格那些不要用英文，可能不懂」。

- **草稿溯源落库**（api/library.js）：
  - 生成 payload 快照 `gen` 配置块（音乐：mode/genres/instruments/bpm/vocal/instrumental；图像：mode/size/light/negativeExtra）随任务走
  - bus 回流监听给草稿盖章：`gen`＋`caption`＋`lyrics_head`＋`engine`（worker 实报）＋`lane`（真实车道，可能被驱动改道）＋`node`（注册表解析车道→节点标签 `nodeLabelForLane`）＋`created_at`
  - 存量草稿（加戳前）诚实降级：引擎/时间有则显，节点缺省不造假
- **候选池 UI**（views/studio.js）：
  - 每张草稿卡三行溯源：`要素：标准 · 中景 · 霓虹夜色，湿地面反光`（gen 块中文渲染，词典值→中文标签映射）／`引擎 tags（模型英文词汇）：…`（引擎收英文 tag 的口径说明）／`⚙ 生成引擎 × · 节点 · MM-DD HH:mm`
  - **生成中横幅**：派发即挂（音乐/图像分道，含模式与张数摘要＋已等秒数实时跳），候选回流（计数超基线）自动收；轮询窗口音乐 60→180s、图像 60→150s（盖过真机 ≈70–120s，根治「没结果」错觉）；tick 同时刷新 summary 计数
  - **选项全部中文**：曲风/乐器 chips 改 {值,中文标签} 双列（值仍英文发引擎，界面只讲中文；Lo-fi/R&B/City Pop 属行业通用叫法保留），AI 歌词辅助的 style 参数同表转中文
- **真机验证**：音乐 3 候选 ≈70s 回流（晚风×3：`要素：标准 · 纯音乐`＋`⚙ 生成引擎 1.5 · 本机 · 17:54`）；图像 LLM 在线下零弹窗直跑（写死兜底生效：深夜便利店→真 DGX H3 引擎 `MiniMax-H3-Image int8_convrot 6step · DGX H3 全家桶 · 17:59`；清晨码头→imgspark 车道 `MiniMax-H3-Image 6step`）；横幅出现→回流自动收
- **修复**：`draftDomain is not defined`（helper 块落在 setup 作用域外，改内联 domain 判断）；横幅首帧「已等 -51 秒」（tickNow 未同步，markGoing 时置基准＋Math.max(0)）
- 回归 **12/12 PASS**（TEST_BASE_PORT=19420）；客户端缓存戳 ch11

### 追加迭代（2026-11-22 下午⑥·曲库标准播放器＋媒体可跳转）

用户反馈「音乐播放的组件能力都显示不全，使用有问题」——裸 `<audio controls>` 在窄卡/窄列里只渲染出播放·静音·菜单，进度条与时长看不见且不能拖。

- **StudioAudio 标准播放器**（views/studio.js 模块内组件，局部注册 studio-audio）：
  - 能力对齐主流曲库产品：播放/暂停、全宽进度条（点击＋拖拽 seek）、已播/总长（mm:ss）、倍速循环（1→1.25→1.5→2→0.75）、音量滑条＋静音、加载失败诚实态（占位/坏文件如实标注，不冒充可用）、页内单实例互斥（播 A 停 B）、换源自动复位
  - 替换三处裸 audio：候选池草稿卡（全尺寸＋音乐卡媒体列 170→240px）、曲库表格行（compact）、声纹样本试听（compact）；audioFail 反应式并入组件内部失败态
  - 两行布局：row1=播放+时间+倍速+静音+音量，row2=进度条独占全宽（窄卡 54px 进度条是精度根因）
- **媒体可跳转的真正病根＝静态服务无 HTTP Range**（src/server/index.js）：无 `Accept-Ranges` 时 Chromium 只能在已缓冲区间内 seek（拖进度条被钳回缓冲末端）。/var/out/* 与 /var/assets/* 资产面补齐 Range/206（`bytes=a-b`／`bytes=-N` 后缀／416 越界兜底，`fs.createReadStream` 分段流式），200 全量路径同样带 `Accept-Ranges: bytes`
- **修复**：`bar` 模板 ref 未进 setup return → `ref="bar"` 永远 null → seekTo 静默早退（点击/拖拽全失效的真凶）；音乐草稿卡类绑定补回
- **真机实测**：真实点击进度条中心 → 61s（期望 60）；cua 真实拖拽 25%→75% → 91s（期望 90）；播放中 ⏸/1x/音量控件全渲染；HTTP 层 curl 验证 206 `bytes 1000-1999/46080088`
- 回归与缓存戳：全量套件重跑；客户端 ch13
