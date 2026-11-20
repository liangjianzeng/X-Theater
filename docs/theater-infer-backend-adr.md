# ADR-001 · 计算后端评估：自建推理服务 vs ComfyUI 接口

> 状态：**已决策（2026-11-20），同日按发起人确认修订分期策略**：一期（商业化之前）执行主体＝**自部署模型**（5060 Ti 开发调试＋DGX Spark 验收/自生产）；托管弹性与商业 API 质量档＝**二期商业化策略**（一期仅契约/UI 槽位预留）。随实现复审
> 上下文：剧场为全云端 API-first 新模块，算力以**自部署开源模型为主**，商业 API 为二期商用运营辅轨。
> 问题原话：「API 接入以自建开源模型服务为主，是需要自建服务端，还是走 ComfyUI 接口更好？」
> 关联：[theater-ux-design.md](theater-ux-design.md)（产品与架构母文档）· [theater-mode-plan.md](theater-mode-plan.md)（商业/合规/单位经济）

---

## 0. 结论（TL;DR）

**「自建服务 vs ComfyUI」是伪二分。正确的拆法是把问题分成三层，三层分别选型：**

| 层 | 决策 | 结论 |
|---|---|---|
| ① 产品契约层 | **必须自建，无讨论空间** | 产品 API 契约、租户/配额/计费、一致性门、审核、任务账本永远是我们的（release_task/query_result 形态）。**ComfyUI 的任何端点都不对用户暴露** |
| ② worker 执行层 | **P0 统一用无头 ComfyUI；高量路径「毕业」为自建直调代码** | 新模型接入速度是生死线：ComfyUI 已是视频模型的事实分发层（长尾模型只有 ComfyUI 模板、没有可复用 serve 代码）；团队仓库实证已有 ComfyUI 肌肉记忆（h3_*/ltx25_* 实验） |
| ③ 弹性供给层（**二期商业化接入**） | **托管 ComfyUI（Comfy API/fal/RunPod）+ 商业 API 质量档** | 一期仅 worker_type/ProviderAdapter 契约与 UI 槽位预留；二期承担峰值弹性、公测 SLA 主力、BYOK |

一句话：**ComfyUI 当执行引擎，不当生产服务**——队列 SLA、多租户隔离、worker 生命周期、合规交付这四件事它不提供，全部由我们的平台层补。

---

## 1. 三个候选，六个维度打分

**候选**：A 自建直调 worker（diffusers/官方 inference 代码自包装）｜ B 无头 ComfyUI worker（我们的编排经 API 驱动）｜ C 托管 ComfyUI（workflow JSON 上平台换托管 API）

| 维度 | A 自建直调 | B ComfyUI worker | C 托管 ComfyUI |
|---|---|---|---|
| 新模型接入速度 | ✗ 周级起（GGUF 量化、参数怪癖、dequant 坑全自己踩——团队在 v0.0.6 生图线上已实证踩过全部） | **✓ 天级**（社区/官方节点 day-one，头部四家全发 workflow） | ✓ 天级（同 B + 免运维） |
| 契约与多租户控制 | ✓ 最好 | △ 可达（契约在我们手里，ComfyUI 藏在 worker 内） | △ 契约在我们，运行时在平台 |
| 稳定性/SLA | ✓ 最好 | △ 需自己补：显存泄漏 2026 年仍月月有 issue、队列卡死史、`/prompt` 官方**无跨版本兼容承诺** | △ 看平台 SLA（官方 Comfy API/RunPod 有扩缩机制） |
| 显存成本效率 | ✓ 最好（可定制 offload/批量） | ✓ 良好（一模型一 worker） | ✗ 按秒计费含 idle，冷启动要对冲 |
| 运维成本（1–2 人团队） | ✗ 最重（模型工程团队级投入） | ✓ 可接受（Docker+四元组锁定+轮换） | ✓ 最轻 |
| 许可证合规 | ✓ 最干净（可全 Apache 权重） | ✓ SaaS 形态零义务（GPL-3.0 不分发不触发）／**私有化交付触发源码义务** | ✓ 同 SaaS；另受平台条款约束 |

**辅助判断（实证）**：
- 团队 ComfyUI 熟练度：仓库根 `h3_i2v_*.py`、`ltx25_*.json`、ComfyUI :8188 实验——**B/C 路径有现成肌肉记忆**；
- 头部实验室（Wan/腾讯/Lightricks/MiniMax）已收敛为「三件套」发布：inference 代码 + diffusers 集成 + ComfyUI 官方教程——A 路径在**头部模型**上可行；但 ComfyUI docs 视频模型教程库数十个模型页中相当多**只有 ComfyUI 模板**，长尾全靠 ComfyUI——**放弃 B 等于放弃长尾生态**；
- 商用先例成立：Comfy 官方客户故事（Series Entertainment 视频管线、Svedka 超级碗 AI 广告、Moment Factory）；RunComfy/Comfy Deploy 等本身就是「拿 ComfyUI 当后端卖 API」的成熟商业产品。

---

## 2. 决定性事实（调研实锤，选型据此）

1. **`/prompt`/`/history`/WS 官方明示「为 UI 服务的内部件，无跨版本兼容承诺」**——官方解法是版本化的 **ComfyAPI v2**（持久 job ID/幂等提交/SSE 进度）+ 开源 **comfy-api-proxy**（自建实例获得同一契约）。→ **我们接 ComfyUI 必须经 v2 契约（proxy 或自写适配层），禁止裸调 `/prompt`**。这条直接否定了「随手把 ComfyUI 挂上去当后端」的接法，但不否定 B 本身。
2. **显存回归长期存在**（2026-06/07/08 连续 issue：内存劣化、每次换 prompt 重载模型）→ 生产通行做法 = **worker 定期轮换 + 内存高水位重启**，纳入平台层职责。
3. **版本固化是官方最佳实践**：fal 官方指南要求 ComfyUI 与每个 custom node 都 pin commit；官方平台按 Build 快照部署。→ 落为 §4-2 的「**四元组锁定**」＝ComfyUI commit × 各 custom node commit × 权重文件版本 × 模板 JSON hash，四项同仓入库（终审补定义）。
4. **安全红线**：ComfyUI 服务器**默认零鉴权**；workflow 可实例化任意 custom node = 任意代码执行。→ **永不执行用户上传的 workflow**，只跑模板库审过的固化模板；节点白名单（Manager security_level=strong、不暴露 Manager）。
5. **GPL-3.0 边界**：SaaS 运行不分发 → 无开源义务（是 GPL 非 AGPL）；**私有化部署交付客户机房 = 分发 → 须附完整对应源码**，且不得使用 ComfyUI 商标。→ P3 私有化线必须走「毕业为代码」的 worker（Apache 权重 + 自研代码）。
6. **模型权重许可证地雷（商用必读）**：Wan2.2 = Apache-2.0（干净）；**LTX-2.x = 年收入 ≥$10M 需购 Lightricks 商用授权**；**MiniMax-H3 = 年营收 >$20M 需书面授权 + 商用 UI 须显著标注「MiniMax H3」**；Hunyuan-1.5 = MAU>1 亿需授权且 EU/UK/KR 不适用。→ 主力自建档优先 Apache（Wan 系），其余设营收门槛监控与授权预算线。
7. **弹性层已完全商品化**：Comfy API（官方 serverless，Build/Release/Deployment + worker 池扩缩）、Comfy Cloud（明示含商用）、fal.ai（ComfyUI 容器 serverless，多卡 Ulysses 示例）、RunPod（ComfyUI 模板，4090 $0.34–0.89/h、H100 $1.99/h 起）、Replicate、RunComfy、Comfy Deploy。冷启动用常驻 min-worker/权重 volume 对冲。
8. **并行直调框架活跃**：xDiT（Ulysses/Ring/PipeFusion，Apache）、FastVideo（SGLang-Diffusion 的源头，FastWan/FastH3 蒸馏权重）——毕业期与多卡大模型直调的现成底座。

---

## 3. 推荐架构

```
产品 API（我们的契约：release_task/query_result + WSS 进度）
   │
编排器（持久 DAG 账本 · 配额 · 预算护栏 · 幂等计费）
   │
模型网关（质量档路由表 · 降级链 · 成本穿透到镜头）
   ├─► W-B 无头 ComfyUI worker（一期执行主体：5060 Ti 开发调试 + Spark 验收/自生产）
   │     · 生图（先行）：qwen-image-2.1-turbo-Q5_K_M——定妆/turnaround、分镜图、局部重绘
   │     · 视频：LTX-2.5 distilled + GGUF UD-Q4_K_XL（唯一全入 16G 档）、补帧超分、长尾新模型
   │     · 一期锁定＝镜像 digest + 模板 JSON 入 Git + nightly 5-shot 冒烟；经 ComfyAPI v2
   │       （proxy 或自写适配）驱动，绝不暴露 /prompt；生图与 i2v 禁热载共存
   │     · **5060 Ti 端点形态（终审定案）：GGUF 系生图/视频一律走 W-B 无头 ComfyUI，不另起
   │       llama.cpp/serve 栈**（S15 注册表端点以此为准，UI 规范 §11.2 同步）
   ├─► W-M 自部署生乐服务（一期标准版裁决 2026-11-20：ACE-Step FastAPI 常驻 5060 Ti，
   │     情绪标签→配段落映射、候选缓存、许可双标记；Stable Audio Open 备选——W1 核证；带唱二期）
   ├─► W-A 自建直调 worker（毕业层）
   │     · **首个毕业 = H3 on DGX Spark（FastVideo NVFP4 直调，不进 ComfyUI 主线）**；
   │       int8 留 VAE/TAE；H3-Context-IR 托管件本地复刻入锁定；Apache 权重优先（Wan 系）为后续
   │     · 生图直调降级为回归参照（量小、托管价优时 ROI 负）；毕业 = vendored 上游 serve 代码 pin + 许可台账
   ├─► 弹性层（**二期接入，契约预留**）：托管 ComfyUI（Comfy API / fal / RunPod）按秒计费
   └─► 质量档（**二期商业化**）：商业 API（可灵/Seedance/Vidu/海螺，已备案底座，BYOK）——一期仅接口与 UI 槽位预留
```

**核心不变式**：上层永远只见我们的契约；`worker_type` 是 job 的实现细节，B→A→托管→API 四条路随时互换，业务层无感。这正是 [U] §6.2「模型网关 ProviderAdapter」的具象化（终审修正引用源）。

成本结构（对齐 v2.0 §6，**二期商业化口径**）：自部署量产档 1–4 元/分钟（前提 4 步蒸馏＋利用率 ≥55–65%）+ 托管层按秒 + API 档 15–90 元/分钟——混合后平均 ~3–8 元/分钟，工作流溢价下毛利模型不变。**一期硬件（5060 Ti＋Spark×1）为验收与自生产定位，不摊产线成本、不承诺 SLA**（Spark FastH3 768p 实测 ≈340s/镜→单台月产能 150–400 分钟；夜间闲时队列）。

---

## 4. ComfyUI worker 生产化清单（Definition of Done）

| # | 项 | 要求 |
|---|---|---|
| 1 | 接入契约 | ComfyAPI v2（自托管 comfy-api-proxy）或自写 `/prompt`+WS 适配层；任务级 watchdog（超时/取消/幂等键）；失败→账本重入队 |
| 2 | 版本固化 | **一期（单机现实）**：容器镜像 digest＋模板 API-format JSON 入 Git＋**nightly 5-shot 冒烟**（15–25min，跑开发机空档）＋模板升级人工 10-shot diff；**二期/公测前**：完整 CI 回归基准集（一致性/质量/吞吐）于 Spark/托管跑（生产同构），锁定项扩为**五元组**（＋comfy-api-proxy commit＋镜像 digest；proxy 仅 4 个月大/14★，须预留自写 /prompt+WS 适配兜底） |
| 3 | 显存与生命周期 | 生产侧一模型一 worker（**5060 Ti 开发机不模拟 worker 池**：单卡显存互斥、模板切换显式卸载、**生图与 i2v 禁热载共存**）；内存高水位/每 N 任务轮换重启；**OOM 铁律：同参数不重试（重试＝降档梯子）；OOM 后强制重启 ComfyUI 进程**；崩溃由编排器幂等重派 |
| 4 | 安全 | 只执行模板库固化模板（**禁止用户 workflow 直跑**）；custom nodes 白名单（Manager `security_level=strong`、pip/downgrade 黑名单）；8188 不出内网、反代+鉴权、Manager UI 关闭；每租户容器/进程隔离 |
| 5 | 产物 | 经 `/view` 或 v2 下载 + sidecar（seed/参数/模型版本/GPU 秒成本）——与既有 sidecar lineage 纪律同构 |
| 6 | 观测 | 节点级耗时、失败分类（排队/超时/模型 OOM/审核拦截）、worker 健康探活 |
| 7 | 冷启动 | 权重 volume 缓存 + min-worker 常驻（自建档）；托管层用 min_workers 参数 |
| 8 | **模型准入白名单（一期新增）** | **商用链路只走 Apache/MIT**：Wan 2.x、Qwen-Image(-Edit)（**Apache 限定原版/2509/2511/2512；⚠ 2.1/2.1-Turbo＝Qwen Research License 非 Apache——5060 Ti 现成的 qwen-image-2.1-turbo-Q5_K_M 仅一期内测/调测用，商用前法务审或切 Z-Image-Turbo/Qwen-Image-2512**）、Z-Image(-Turbo)、ACE-Step 1.5、CosyVoice2；**门槛监控**：MiniMax-H3-Image（Spark 生图主力：大陆可用＋排除 EU/UK/US/KR＋**年营收 >$1M 或对外托管需书面**＋UI 标注）、LTX-2.x（<$10M 全免含商用；≥$10M 购授权＋禁蒸馏他模＋Gemma 编码器条款）、MiniMax-H3（>$20M＋UI 显著标注＋**排除 EU/UK/KR/US**＋托管防滥用＋禁训练他模；FastH3 蒸馏权重同义务）、Hunyuan（MAU>1 亿＋排除 EU/UK/KR）；**禁入商用链路**：FLUX.1-dev/Kontext 全系、F5-TTS、MiniMax M2.7 开源权重、IndexTTS-2（license 未核）、CogVideoX（需注册＋月访问 ≤100 万）、LatentSync（两处 license 不一致，以包内文本留证） |

---

## 5. 毕业机制（何时把 ComfyUI worker 换成自建代码）

**触发（四条中满足三条）**：月调用量进前三；该 workflow 上游 2 个版本未变更（生态稳定）；成本敏感（GPU 时租占比高）；SLA 被大客户点名。
**首批毕业清单（2026-11-20 顺序修正）**：① **H3/FastVideo 直调 on Spark**（NVFP4 QAD，随 Spark 上线即自然发生——H3 不进 ComfyUI 主线：nvfp4 kernel 覆盖不全，靠 worker_type 抽象消化）＋**MiniMax-H3-Image（Spark 生图）走 SGLang 官方 recipe 常驻服务**（同属毕业层直调形态；**2K≈16.2s/图为 SGLang 官方 recipe 标称档，当前定档 MXFP8+FP8 实测≈11.0s/图——档位归属见 §6，终审标注**）→ ② ComfyUI 生图直调（**降级为回归参照**：仅当量进前三且托管涨价时重启，当前 ROI 不成立）→ ③ 主力 i2v（Wan 系定型后）。
**长期留在 ComfyUI 层**：turnaround、补帧、超分、口型、FLF/转场、一切长尾与新模型——生态更新快，写死是负债。
**纪律**：毕业后的 ComfyUI workflow 不删除，转为该功能的**回归参照实现**（差分测试：同种子对比直调与 ComfyUI 产物质量）。

---

## 6. 分期落地

| 阶段 | 计算后端动作 |
|---|---|
| **一期（MVP，商业化之前）** | **全自部署**：5060 Ti 开发调试（Ubuntu/WSL2；生图 qwen-image-2.1-turbo-Q5_K_M＋视频 LTX-2.5 distilled GGUF UD-Q4_K_XL）＋DGX Spark 验收/自生产（**FastH3 NVFP4 直调＝首个毕业**；Spark 生图＝**MiniMax-H3-Image**（官方开放权重 T2I+编辑独立 checkpoint，2026-11-03，33.1B DiT/6 步/原生 ~16MP；SGLang 官方 Spark recipe 实测 2K≈16.2s/图、MXFP8+FP8≈11.0s/图，建议常驻服务；**DGX 量化优先级（发起人确认）：nvfp4→int8→（皆无才）MXFP8+FP8——H3-Image 主 DiT 暂无官方 NVFP4/int8，暂用 SGLang MXFP8+FP8 实测档，跟踪发布出现即切换并重跑定档回归**；Apache 兜底 Z-Image-Turbo/Qwen-Image-2512））；模板首批按**生图先行**：定妆/turnaround/分镜图/局部重绘→LTX-2.5 i2v/FLF→合成链（补帧+超分+转场）；digest 锁定＋nightly 冒烟；**本地调测工作流 C**：量化档位对比（CLIP/DINO＋盲评）、golden diff 基准、显存预算实测、故障注入 5 类（OOM/死锁/泄漏/队列卡死/黑帧）、Spark 5s@720p 验收计时；H3-Context-IR 本地复刻入锁定；**托管/商业 API 仅 worker_type/ProviderAdapter 契约预留** |
| **二期（公测/商业化）** | **托管双供应商接入（fal/RunPod，公测 SLA 主力）**＋**商业 API 质量档＋BYOK（对外供应商能力面开启）**；comfy-api-proxy v2 契约（含自写适配兜底）；模板注册表＋CI 回归基准（Spark 生产同构）上线；模型网关路由表/降级链完整；Spark 健康摘除进路由表 |
| **P2** | GPU 池自动扩缩（自建 min-worker + 托管 burst）；第二毕业：主力 i2v；私有化交付线启动（合规包：对应源码 bundle、去 ComfyUI 商标、MiniMax-H3 类 UI 标注义务、各权重 license 清单） |
| **P3** | 大模型多卡直调评估（xDiT/FastVideo）；营收门槛监控（LTX ≥$10M、H3 >$20M → 授权预算线） |

---

## 7. 风险与对冲

| 风险 | 对冲 |
|---|---|
| ComfyUI 上游 API/workflow 跨版本断裂 | v2 契约 + 四元组锁定 + CI 回归（已消解主险） |
| 关键 custom node 维护者弃更 | 白名单准入即评审；高风险节点 vendor fork；毕业机制兜底 |
| 托管平台涨价/数据驻留要求 | 双供应商（Comfy API + fal/RunPod）+ 自建层兜底——workflow JSON 与契约都在自己手里，切换成本低 |
| 权重许可营收门槛（LTX/MiniMax/Hunyuan） | 主力 Apache（Wan）优先；法务监控营收阈值；授权预算入年度成本线 |
| GPL 私有化源码义务 | P3 私有化只交付毕业层（自研代码）；如仍含 ComfyUI，交付合规源码 bundle 并去掉商标 |
| 被 Comfy Org 产品线锁定 | 一切资产 = workflow JSON + 我们的契约；B↔A↔托管↔API 可换（§3 不变式） |
| **DGX Spark 吞吐瓶颈**（273GB/s 内存带宽，FastH3 768p 实测 340s/镜、解码占约 1/3） | 一期不承诺 SLA（验收/自生产语义）；夜间闲时队列；二期托管弹性为 SLA 主力；Spark 定位＝容量/验收/补峰＋LLM/合成负载，不当唯一量产机 |
| **GB10 nvfp4 生态单点依赖 FastVideo**（GB10 无官方 TensorRT 视频引擎支持） | FastVideo/ltx-kernels 锁 commit＋可编译镜像入 digest 锁定，入 vendor fork 白名单；跟踪 ComfyUI 官方 FastH3 模板为第二路径 |
| **H3-Context-IR 为托管件** | 按官方 skills 仓库本地复刻纳入锁定；否则自建档与 API 档质量不可比、一致性门误判 |
| **自部署量化档质量不达商用线** | 工作流 C 量化档位对比＋盲评定档；一致性评测集回归；二期商业 API 质量档兜底 |

---

## 8. 决策记录

| # | 决策 | 状态 |
|---|---|---|
| D1 | 产品契约层自建，ComfyUI 端点零暴露 | 定 |
| D2 | worker 执行层 **一期＝自部署**（5060 Ti 无头 ComfyUI 开发调试＋Spark FastH3 直调验收/自生产）；锁定项一期＝镜像 digest＋nightly 冒烟，五元组+CI 回归随二期；高量路径按毕业机制转自建代码 | 定（2026-11-20 修订） |
| D3 | 弹性供给层 = 托管 ComfyUI 双供应商 + 商业 API 质量档（BYOK）——**二期商业化接入，一期仅契约/UI 槽位预留** | 定（2026-11-20 修订） |
| D5 | **硬件定位**：5060 Ti＝开发调试机（模板熔炉，一切 dev/前期调测在此）；DGX Spark＝商业化之前验收＋自生产（非量产/非 SLA 依据）；**生图先行**（图确认后才进视频与厂家确认）；模型准入白名单（§4-8）；**DGX 量化优先级：nvfp4 首选→int8 次选→皆无才 MXFP8+FP8 档** | 定（发起人 2026-11-20 确认） |
| D4 | 私有化交付线以毕业层为前提，GPL/商标/权重标注合规包随 P3 建 | 定（随 P3 复审） |

---

## 附 · 主要来源

- ComfyUI 许可证与产品：github.com/Comfy-Org/ComfyUI（GPL-3.0，v0.46.0）、comfy.org/pricing（Cloud 明示含商用）、comfy.org/enterprise（From $5,000/月）、docs.comfy.org（serverless/API v2 与 sdks-design、self-hosting、startup-flags、manager 安全配置、workflow_templates）
- API 契约与坑：docs.comfy.org/development/api-development/sdks-design.md（/prompt 无兼容承诺 → v2）、github.com/Comfy-Org/comfy-api-proxy；ComfyUI GitHub issues #14907/#15884/#14618（显存回归）、#1045 类队列卡死
- 托管层：docs.comfy.org/development/serverless/overview.md（Comfy API）、fal.ai/docs/examples/image-generation/run-comfyui-visual.md（含节点 pin 要求）、docs.runpod.io/tutorials/serverless/comfyui.md 与 /serverless/pricing（4090 $0.34–0.89/h、H100 $1.99/h）、replicate.com/pricing、runcomfy.com/pricing、comfydeploy.com
- 商用先例：comfy.org/customers（Series Entertainment、Svedka×Silverside 超级碗广告、Moment Factory）
- 模型许可与 serve 代码：github.com/Wan-Video/Wan2.2（Apache-2.0 + 官方多卡代码 + diffusers）、github.com/Lightricks/LTX-2（权重 Community License ≥$10M）、hf MiniMaxAI/MiniMax-H3（>$20M 需授权 + UI 标注 + diffusers/vLLM 支持）、github.com/Tencent-Hunyuan/HunyuanVideo-1.5（MAU>1 亿、EU/UK/KR 除外）
- 并行框架：github.com/xdit-project/xDiT（Apache）、github.com/hao-ai-lab/FastVideo（SGLang-Diffusion 源头，FastWan/FastH3 蒸馏）
- **2026-11-20 分期修订补充**：LTX-2.5 档位与 unsloth GGUF 实测表（UD-Q4_K_XL 14.0GB 为唯一全入 16G 档；Lightricks/unsloth HF 页）；FastH3 on DGX Spark 官方实测（haoai-lab FastH3 博客：768p≈340s/镜、NVFP4 QAD 官方 Spark 支持）；DGX Spark 官方规格（nvidia.com：GB10 sm_121、128GB LPDDR5X @273GB/s、~1 PFLOPS FP4）；Wan2.2 官方 issue 吞吐与 lightx2v 蒸馏实测；MiniMax-H3 LICENSE 原文（>$20M＋UI 标注＋区域排除＋托管防滥用＋禁训练）；LTX-2 LICENSE-2_x 原文（<$10M 全免含商用）；DeepSeek 官方价目与并发上限（峰谷双价、flash 2500/pro 500、v4-pro 无 vision）；**生图专项核实（2026-11-20）**：hf MiniMaxAI/MiniMax-H3（本体仅视频+音频，无 T2I）与 MiniMaxAI/MiniMax-H3-Image（2026-11-03 开放权重 T2I+编辑，社区协议 LICENSE 原文）；SGLang 官方 cookbook DGX Spark recipe（docs.sglang.io，2K≈16.2s/图、MXFP8+FP8≈11.0s/图）；Efficient-Large-Model/Open-H3-Regenerate-2K（2K 重生成＝video-to-video）；unsloth/Qwen-Image-2.1-Turbo-GGUF（Q5_K_M 5.39GB）与 docs.unsloth.ai（Q4_K_M 含 TE+VAE 9.1GB 实测）；hf Qwen/Qwen-Image-2.1-Turbo（Qwen Research License 双端一致）；Tongyi-MAI/Z-Image-Turbo（Apache，官方称 16G 消费卡可跑）；Lightricks/LTX-2.5（image-to-video，无 T2I tag）
