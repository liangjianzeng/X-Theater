# DGX Spark · MiniMax H3 线部署验收证据（EVIDENCE）

- 日期：2026-11-21 · 执行：ZCode 主会话（无子智能体，用户指令）
- 结论：**H3 线全链路落地并冒烟通过**——三模板真跑全绿，产品接线完成，测试套件 10/10。

## 1. 环境四元组（锁定）

| 项 | 值 |
|---|---|
| ComfyUI commit（Spark） | `1e719279f56558b2c6d5d2f2aa590b197559f1f6`（v0.45.0-40） |
| custom nodes | 全原生节点（cn_commits: {}）；`ComfyUI-Open-H3-Regenerate-2K`（1038lab，regen2k 模板启用前登记） |
| 权重清单 | manifest.json `h3-ref2va-video / h3-fl2va-video / h3-image-cast` 三条目（sha16 已登记，见下表） |
| 模板 hash | tmpl_sha16 校验通过（COMFY_TMPL_DRIFT 纪律沿用） |

环境勘探细节见 [SURVEY.md](SURVEY.md)。

## 2. 权重台账（Spark NVMe `~/ComfyUI/models`，热集；SSD 冷集软链）

| 权重 | sha16 | 字节 |
|---|---|---|
| minimax_h3_fl2va_pruned_int8_convrot | e889202c41dafb67 | 20,970,379,616 |
| minimax_h3_ref2va_pruned_int8_convrot | 9255f52b6677845a | 20,970,379,616 |
| minimax_h3_image_pruned_int8_convrot | 83eb140f1ff95c06 | 20,979,314,802 |
| qwen3vl_32b_minimax_h3_nvfp4_awq（TE） | 35a88d51044231fe | 15,687,142,551 |
| qwen3.5_9b_w4a8_gptq（TE-LLM 备用） | 4cc6a1543ad20618 | 7,343,591,088 |
| minimax_h3_video_vae_fp16 | 7c1f131492e7edda | 5,207,808,496 |
| minimax_h3_audio_vae_fp32 | 8e505d95dd1561d4 | 605,254,808 |
| minimax_h3_image_vae_fp16 | d80e9c2e5cfc9844 | 1,168,505,312 |
| fl2v turbo 4step / 8step LoRA | c396a9a06f58399e / 2339acdf19bfe123 | 1.96G×2 |
| ref2v turbo 4step LoRA | 5b9ab5ade15d0775 | 1.96G |
| regen2k 组件（open_h3_regenerate_2k 8.8G / r128 2.0G / sharp_curve 1.24G / latent_upscaler 0.69G / fast VAE 6.1G） | （hf-mirror 1038lab/Open-H3-Regenerate-2K） | — |

下载通道：ModelScope 直链（Comfy-Org/MiniMax-H3 / -H3-Image）+ hf-mirror（1038lab）。脚本：dl_h3.sh / dl_h3_regen2k.sh / migrate_hot_to_nvme.sh（均无头幂等，本地留档）。

## 3. 真跑证据（裸 POST /prompt，不经产品）

| 模板 | prompt_id | 耗时 | 产物 | 验收 |
|---|---|---|---|---|
| h3-image-cast | f9497a6c-5292-4e5a-9018-4d60d4c389b5 | **14.91s** | [image_cast_result.png](smoke/image_cast_result.png) | 定妆照 1024²：影棚三点布光、真实皮肤纹理、身份锚点生效 |
| h3-fl2va-video | 058c24f5-7bdb-449e-a6cd-4e6af21a2f92 | **286.5s** | [fl2va_result.mp4](smoke/fl2va_result.mp4) | 768×1344 未用（冒烟为 1344×768）、5.17s/124 帧/24fps，TE 15G+DiT 20G 动态分页无 OOM，原生声画 |
| h3-ref2va-video | 19598fb7-91c2-47f2-9ee7-8f634bf16b0c | **260.4s** | [ref2va_result.mp4](smoke/ref2va_result.mp4) | subject reference 保脸：黑长发+深灰高领与参考一致，抬头→张口说台词逐项命中 IR，五帧身份稳定 |

对比基线：ADR-001 估档 bf16 FastH3 768p ≈340s/镜 → int8 turbo4 实测 260-286s/镜，优于估档。

## 4. 产品接线（src/server）

- `adapters/comfy.js`：spec.base 多端点路由（THEATER_COMFY_SPARK_URL）；manifest family 判定（同族常驻不 /free）；产物识别 videos/gifs/images；uploadAsset（multipart /upload/image）；ensureFree（ram_free 阈值守卫，默认 6G）
- `adapters/h3ir.js`（新）：Context-IR 本地复刻——buildFL2VA 三字段 / buildRef2VA 六段式（官方 ref-en.txt/base-en.txt，留档 refs/h3-skill/）+ lengthFrames 17k+5 帧网格 + rewriteWithLLM 可选钩子（Spark llama-server /v1，默认关）
- `workers/vidspark.js`：真实现——分镜首帧→fl2va / 无分镜有定妆→ref2va；上传资产；IR 拼装；timeout 1800s；默认竖屏 768×1344；影子记账 150 分；meta.ai_label 许可标注
- `workers/imgspark.js`：真实现——casting 类型走 h3-image-cast（20 分）；lane 默认映射不动
- `engine.js`：video tier:"high"→vidspark（原有）；casting tier:"high"→imgspark（新，Spark 通道启用时）
- `episodes.js/cards.js`：script shots 的 sec/tier/width/height 全链透传（剧本=结构化源头）；shoot 端点按镜 tier 路由
- `core/store.js` registry：MiniMax-H3-Image published ["int8","MXFP8+FP8"] unavail ["nvfp4"]；FastH3 published ["nvfp4","int8","MXFP8+FP8"]；endpoint 改 Spark ComfyUI :8188
- `src/CONTRACT.md`：lane 表同步
- 许可合规：take.license {model:"MiniMax-H3 Community", usage:"attribution"} + meta.ai_label「AI 生成内容（MiniMax H3）」；用户面 take.engine 仍「自部署·高价值档」（语言表纪律）

## 5. 回归

`node test/run.js` **10/10 PASS**（registry 新档位下 U_quant_adjudication 演练路径保持全绿）。

## 6. 内存/存储纪律（用户 2026-11-21 指令）

热权重内置 NVMe（~94G）、冷权重 SSD 软链；内存常驻优先——同模板族连续出片不重复加载不 /free，仅跨族或 ram_free<阈值才释放；预留几 GB 余量。

## 6. LTX-2.5 on Spark：multishot＋FLF 冒烟（2026-11-22 · 对标调研梯队落实）

- 背景：LTX-2.5 全套权重本就在 Spark（SSD 冷集软链：22B int8_convrot DiT / gemma4-12b TE / 视频+音频 VAE / spatial upscaler）；ComfyUI-LTXVideo @15d09ab。本次补齐**模板两条线并真机调测**。
- 模板登记：`ltx25-multishot-spark`（时间码多镜描述，IMAGE=组首镜帧跨镜身份锚）/ `ltx25-flf-spark`（IMAGE=A 尾帧 frame 0 ＋ REF=B 首帧 AddGuide frame_idx=-1）；manifest 四元组已登记（tmpl_sha16 实算）。
- 冒烟（裸 POST /prompt，不经产品；prompt_id 见 meta）：

| 模板 | 规格 | 耗时 | 产物 | 验收 |
|---|---|---|---|---|
| ltx25-multishot-spark | 2 镜×2s＝97 帧 · 720×1280 · 时间码双镜描述 | **105s** | [ltx25_ms_spark_97f.mp4](smoke/ltx25_ms_spark_97f.mp4)（988KB） | 双镜一次前向跨切生成；**原生音轨在**（环境声+海风） |
| ltx25-flf-spark | 2s＝49 帧 · 720×1280 · A 尾帧+B 首帧桥接 | **35s** | [ltx25_flf_spark_49f.mp4](smoke/ltx25_flf_spark_49f.mp4)（633KB） | 首尾帧衔接生成；**原生音轨在** |

- 吞吐对比（更正 2026-11-22：首版误写「快约 10 倍」，同口径实算应为**约 2 倍**）：GB10 上 LTX-2.5 int8 两段蒸馏 ≈ 26s/成片秒（105s/4.04s），H3 int8 turbo4 ≈ 52-57s/成片秒（260-286s/5s）——**同机同档约 2 倍速**；且 Spark LTX 对比本机 5060 Ti LTX（UD-Q4 GGUF ≈420s/5s）快约 3 倍。据此把「速度优势」产品化为生成档位（video-pref：speed=远程快速档 100 分/5s、quality=远程高价值档 150 分/5s、auto=按镜分级），见 src/CONTRACT.md §3/§4。
- 产品接线（src/server，2026-11-22）：engine `video_ms`/`transition` 双类型（tier 路由 local=GGUF / remote=int8）；shoot mode:"group" 分组派单（Σsec≤10s）；POST /episodes/:id/transitions 幂等派单＋台账；compose 真模式织入转场＋字幕烧录（settings.subtitles）＋可选升帧（settings.interp_fps）；后期三车道 lipsync/superres/sfx（stub 默认，THEATER_LIPSYNC_URL/SUPERRES_URL/SFX_URL 真引擎）。V15 用例全绿（多镜串拍/转场/口型/超分/音效/网感人格）。
- 待办：Spark DiT sha16 补 manifest 占位（计算中）；vid5060 本机 multishot 真跑（GGUF UD-Q4_K_XL 121→241 帧显存实测）。
- 抽帧核验（var/tmp/ms_check.png / flf_check.png / flf_last.png）：multishot 第1镜继承组首镜 guide（集装箱码头）、第2镜按时间码描述生成「男子望灯塔」——跨切叙事成立；FLF 起帧逐字钉住 A 尾帧（占位图文字可见）、末帧语义走到 B 场景（人+集装箱+灯塔一致）但未逐字钉住 B 占位图（纯色+文字属极端 OOD 输入，真用分镜图与生产 i2v-ref 同链路——V2 保脸证据已覆盖该路径）。占位图冒烟的结论以「链路通＋声画全＋跨切叙事成立」为准。

## 7. LTX-2.5 NVFP4 A/B（2026-11-23 · 回应「nvfp4 是否好过/快过 UD-Q4_K_XL」）

- 权重：官方 `ltx-2.5-22b-distilled-transformer-nvfp4.safetensors`（**18.72GB**，Lightricks/LTX-2.5，ModelScope 直链下载到 Spark NVMe；sha 建议后续 manifest 登记时实测）。ComfyUI ≥0.32＋Blackwell 限定；本机 ComfyUI a20552b/Spark v0.45 均满足。
- **体积裁决**：nvfp4 18.72GB 超出 5060 Ti 16G 显存（GGUF UD-Q4_K_XL 14.0GB 是唯一全入档）——**本机档不换**；Spark 128G 可跑。
- **A/B 实测**（同 seed=20261122 同 prompt 同首帧，multishot 97 帧 720×1280，裸 POST）：

| 轮次 | int8_convrot | nvfp4 | 说明 |
|---|---|---|---|
| 第 1 轮 | 65s（热） | 226s（冷：含 18.7GB 首载） | 首轮被加载时间污染 |
| 第 2 轮 | 221s（冷：被 nvfp4 换出后重载） | **70s（热）** | 对称污染 |
| **热态结论** | **65s** | **70s** | **基本打平，int8 略快 7%** |

- **裁决：Spark 快速档维持 int8_convrot，不换 nvfp4**——速度无收益（GB10 上 int8 convrot 内核已近带宽上限），质量目检同水平（[ab_grid 抽帧]：nvfp4 对 guide 贴合稍松、细节略多，无硬差异）；且 int8 数值精度更高。nvfp4 权重留在 Spark NVMe（18.7G）备用。
- **运营发现（比 A/B 更有价值）**：ComfyUI 单 DiT 常驻——**跨引擎切换＝整套重载**（int8↔nvfp4 互切各 ~150s+，GB10 统一内存带宽下 ~150-220s/次）。调度纪律应避免 Spark 上 LTX↔H3 频繁横跳：同族任务攒批派发（与既有「同族常驻不 /free」纪律同源，量化为：切引擎成本 ≈ 一次 5s 镜的 2-3 倍渲染时间）。
- 「nvfp4 快过 GGUF」的直觉修正：快不快取决于内核路径而非位宽（GB10 上 int8 convrot 内核更成熟）；nvfp4 的真实优势是**显存占用**——只对 16G 卡有意义，但 18.7GB 又恰恰装不进 16G 卡。GGUF Q4_K_XL 在本机的地位不变。
- **人工复查包（2026-11-23）**：真实定妆原片（《灯塔来信》女主导演原照）为 guide＋台词「这座城市，每一盏灯都像一封信。」（原生声画口型）同条件 A/B：int8 100s / nvfp4 246s（121 帧 720×1280；Spark 统一内存计时抖动 85~246s，速度裁决不变）。复查产物：`ltx25_abq_int8.mp4` / `ltx25_abq_nvfp4.mp4` / `ltx25_abq_同屏对比.mp4`（左右同屏＋标签）/ `ltx25_abq_多时点帧格.png`（0.3/1.5/2.5/4.5s 四对）/ `ltx25_abq_人脸裁切.png`（说话中 3 对 100% 裁切）。裁决留人。
