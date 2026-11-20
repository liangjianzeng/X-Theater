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
