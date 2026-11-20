# LTX-2.5 接入 W-B ComfyUI（:8188）部署实证 — 2026-11-21

目标：16G RTX 5060 Ti 真实跑通 LTX-2.5 i2v/t2v 5s@720p 竖屏（720×1280），模板四元组登记进产品适配层。
结论：**已达成**。两次真实生成均一次成功、无 OOM、无同参数重试；模板已登记（manifest 合并，qwen 条目未动）。

---

## 1. 接入方式结论

- **官方路径**：ComfyUI 0.46.0（HEAD `a20552b5efd844ddf4da9dce4f55e313333a9ef9`）原生内置 LTX-2.5 支持：
  - 前端模板库 `comfyui-workflow-templates 0.11.112` 含官方模板 `video_ltx2_5_t2v.json / video_ltx2_5_i2v.json / video_ltx2_5_flf2v.json`
    （venv 路径 `E:\ComfyUI\venv\Lib\site-packages\comfyui_workflow_templates_json\templates\`，API /api/templates 同源）。
  - 核心节点在 `comfy_extras/nodes_lt.py / nodes_lt_audio.py / nodes_lt_upsampler.py`；模型族 `LTXV/LTXAV` 在 `comfy/supported_models.py`；TE（gemma4-12b + 双投影）在 `comfy/text_encoders/lt.py`。
- **官方两段流水线**（蒸馏档）：stage1 在半分辨率生成（8 步，ManualSigmas
  `1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0`）→ `LTXVLatentUpsampler` x2 →
  stage2 全分辨率精修（3 步，`0.85, 0.7250, 0.4219, 0.0`）；`LTXVDualCFGGuider video_cfg=1 audio_cfg=1`、
  `euler_ancestral`、采样在 AV 联合 latent（`LTXVConcatAVLatent/SeparateAVLatent`）上进行，天然输出**带同步音频**。
- **组件构成**（官方 int8 档对 22B 模型不适配 16G，见权重台账）：
  - diffusion：LTX-2.5 22B distilled transformer；
  - text encoder：gemma4-12b-with-proj（含 video/audio 双投影层），CLIPLoader `type="ltxv"`；
  - VAE：video VAE + audio VAE **各一个独立文件**，均非内置、需下载；
  - latent 上采样：`latent_upscale_models` 独立模型文件。
- **GGUF 通道**：ComfyUI-GGUF（gitcode 镜像 HEAD `9ecc3c48`，与 github 上游仅差 6 行 metadata 透传）可直接加载
  unsloth LTX-2.5 GGUF——实测 GGUF 头 `general.architecture = "ltxv"`（在该节点 `IMG_ARCH_LIST` 白名单内），
  张量为裸名（`transformer_blocks.*`），经 `comfy.sd.load_diffusion_model_state_dict` 走 comfy 原生模型探测，
  与 LTX-2.5 `AVTransformer3DModel` 命名匹配，**无需升级节点**。TE/VAE 走官方 safetensors。
- **I2V 首帧锁定**：`LTXVImgToVideoInplace`（两段各一次：stage1 strength 0.7、stage2 strength 1.0）；
  节点内部自动把首帧图 cover-crop+resize 到当前 latent 分辨率，无需外部 Resize 节点。

## 2. 权重台账（全部 ModelScope 实测可得，2026-11-21 下载）

存放：`E:\ComfyUI\models\{diffusion_models,text_encoders,vae,latent_upscale_models}\`

| 文件 | 字节 | sha256-16 | 档位/理由 | 显存账 |
|---|---|---|---|---|
| `diffusion_models/ltx-2.5-22b-distilled-UD-Q4_K_XL.gguf` | 14,000,234,880 | `55442750eb0013d9` | unsloth Dynamic 2.0，22B distilled；**16G 唯一合理档**：官方 int8-convrot（21.5G）与 nvfp4（18.7G）均超卡；bf16 42G 禁下；unsloth 自测 UD-Q4_K_XL ≈Q5_K_M 质量且比 Q4_K_M 好 | 全驻 ≈13.4G（Q4_K_XL），实测运行段 14.5–15.8G 含激活 |
| `text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` | 15,372,969,374 | `6ce688a0aa98a5fa` | 官方 comfy int8-convrot TE（模板钦定档）；ModelScope 无更小主 TE 档（unsloth 仓 TE 仅 bf16 26G 禁下，QuantStack 仓为空，gemma4 GGUF TE 无货） | 15.4G **staged**：动态上卡编码一次即逐出（不与 DiT 并驻） |
| `vae/ltx-2.5-video-vae-bf16.safetensors` | 1,472,223,346 | `847e14ca7f3355de` | 官方 video VAE bf16；无更小档，1.4G 可接受 | ≈1.4G |
| `vae/ltx-2.5-audio-vae-bf16.safetensors` | 364,866,540 | `c52733d37f6a7fb7` | 音轨必需（LTX-2.5 卖点：AV 同步生成）；仅 0.35G | ≈0.36G |
| `latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | 995,778,752 | `eb5a71fe4068ee87` | 两段流水线必需（stage1→stage2 x2）；1.0G | ≈1.0G |

合计磁盘 ≈32.2GB；同卡驻留峰值组合 = DiT 13.4G + VAE/upscale 2.8G ≈ 16.2G → 由 comfy 动态装载/逐出压进 16G。
bf16 大权重（26G TE / 42G DiT）未下载。下载源 URL 前缀 `https://modelscope.cn/models/{unsloth/LTX-2.5-GGUF,Lightricks/LTX-2.5}/resolve/master/…`，实测 ~27MB/s，全程 21 分钟。

## 3. 部署步骤（实际执行版）

1. **调研**：读官方模板 JSON（subgraph 展平后得到全部节点/接线/sigmas/负向词），/object_info 逐一核对节点 schema。
2. **GGUF 兼容性**：下 256KB 文件头解析 arch=`ltxv` ∈ `IMG_ARCH_LIST` → 免升级（gitcode 镜像亦无新版可拉）。
3. **权重**：后台 curl 顺序下载 5 件（见台账），字节数逐一与 ModelScope API 对账一致，sha256 全量计算登记。
4. **进程**：发现 ComfyUI 已死（见 §7-1），按既定命令重启（`--port 8188 --listen 127.0.0.1`，detached），探活恢复。
5. **首帧素材**：`female_ref.png` 复制入 `E:\ComfyUI\input\`（实为 720×1280，非任务书所述 1024×1024）。
6. **T2V 提交**：`POST /free {unload_models:true, free_memory:true}` → `POST /prompt` → 轮询 /history → 再次 /free。
   第一次提交因 `LTXVEmptyLatentAudio` 漏接 `audio_vae` 被校验 400 拒绝（补线后过）——**校验拦截，非执行失败**。
7. **I2V 提交**：同流程，一次通过。
8. **固化**：验证过的 workflow 以 `<KEY>` 占位符化写入 `runtime/templates/ltx25-t2v.json / ltx25-i2v.json`；
   manifest.json **读-合并-写**，新增 `ltx25-t2v / ltx25-i2v`，`qwen-image-turbo(-i2i)` 条目原样保留。

## 4. 两次真实生成记录

| 项 | T2V | I2V |
|---|---|---|
| prompt_id | `12b1146b-608b-43d4-a48e-ea50b9695e72` | `f31002dd-0e37-4571-b4cc-8f285503e416` |
| 内容 | 「雨夜灯塔，航标灯旋转，暖光扫过海面，电影感」 | female_ref.png 首帧：抬头看镜头微笑+轻推镜 |
| 规格 | 720×1280@24fps，121 帧 5.04s，含音轨 | 同左 |
| wall | **190.7s**（含 TE 编码、两段采样、解码、封装） | **220.9s** |
| 显存峰值 | **15785 MiB（96.8%）** | **15755 MiB（96.6%）** |
| OOM/重试 | 无 | 无 |
| 产物（已拷贝） | `runtime/ltx25-evidence/t2v_test_720x1280_00001_.mp4`（2.0MB） | `runtime/ltx25-evidence/i2v_test_720x1280_00001_.mp4`（1.2MB） |
| 源文件 | `E:\ComfyUI\output\ltx25\t2v_test_720x1280_00001_.mp4` | `E:\ComfyUI\output\ltx25\i2v_test_720x1280_00001_.mp4` |
| 语义核验 | 视频抽帧确认：夜景塔式灯塔、航标灯暖光、海面光斑扫动，竖屏 | 首帧与 female_ref.png 一致（同发饰/吊裙/卧室），后续自然动效 |

显存时间线（T2V，1s 采样，完整序列在 `evidence_run_t2v.json`）：TE 阶段冲高 15.8G→回落 → stage1 爬坡至 15.8G 平台（≈35–72s，8 步）→ upscaler+stage2 14.6G（3 步）→ 解码 15.2G → 封装收尾。I2V 同构。

## 5. 显存纪律执行账

- 16G 卡（16311 MiB 可见）；bf16 大权重零下载；nvfp4（18.7G）/int8（21.5G）档明确排除并记录理由。
- 每次 `POST /prompt` 前 `POST /free {unload_models:true, free_memory:true}`，完成后再次 /free 归还（runner `E:\tmp_ltxprobe\run_gen.py` 自动执行，日志见 evidence_run_*.json）。
- 单次 OOM 不重试同参数：本次两次均一次成功，未触发降档梯子。
- 与生图三件套禁热载共存：T2V/I2V 提交前 /free 已卸载生图常驻（重启后本就为空）；测完 /free 归还。

## 6. 模板登记（四元组）

| tmpl | tmpl_sha16 | comfy_commit | cn_commits | weights | vram_profile |
|---|---|---|---|---|---|
| `ltx25-t2v` | `f4a3eae224cbb3e1` | `a20552b5efd844ddf4da9dce4f55e313333a9ef9` | ComfyUI-GGUF `9ecc3c48e7ec48ec6fee95de90197ae7aee6644e` | 5 件（§2，含 sha16） | 峰值 96.8% 实测 |
| `ltx25-i2v` | `fefa64344445cc8d` | 同上 | 同上 | 同上 | 峰值 96.6% 实测 |

- 文件：`E:\Work\X-Theater\runtime\templates\ltx25-t2v.json`、`ltx25-i2v.json`；manifest.json 合并登记（schema 1），
  额外写入 `params`（各占位符默认值）、`notes`（分辨率对齐说明）、`verified`（prompt_id/耗时/峰值）便于编排层取用。
- 占位符（适配层 `^<([A-Z0-9_]+)>$` 整值替换，数值转数字）：
  `<PROMPT> <NEGATIVE> <WIDTH> <HEIGHT> <SEED> <FPS> <LENGTH> <STAGE1_W> <STAGE1_H> <CFG> <SIGMAS1> <SIGMAS2>`，
  I2V 另有 `<IMAGE>`（ComfyUI/input 内首帧文件名）。
- **分辨率铁则**：LTX-2.5 VAE 空间压缩 32、两段流水线输出 = stage1 尺寸×2×32 → 目标宽高须 64 对齐。
  720 非 64 对齐不可原生表示，模板约定：`<STAGE1_W>/<STAGE1_H>`（=360/640）出原生 704×1280，
  尾接 `ImageScale lanczos` 精确到 `<WIDTH>×<HEIGHT>`（720×1280，横向 2.3% 重采样，视觉不可辨）。

## 7. 遗留问题 / 事件记录

1. **ComfyUI 会话中途退出（崩溃记录）**：本次会话初期 system_stats 探活正常，约 01:35 发现 :8188 无监听、无 python 主进程
   （同期仅有外部 ACE-Step 下载任务在跑，未见崩溃堆栈；不排除被外部终止）。按预案重启：
   `cd /e/ComfyUI && ./venv/Scripts/python.exe main.py --port 8188 --listen 127.0.0.1`（detached），重启后全程稳定。
   旧 stdout 日志被重定向覆盖，崩溃前快照仍在 `runtime/comfyui-evidence/comfyui_server.log.snapshot`。
2. **torch cu128 限制**（沿一期）：comfy-kitchen CUDA 加速后端 disabled（需 cu130），int8-convrot/GGUF 反量化走 eager 路径，
   功能正确、吞吐非最优。两次生成 191/221s 已达标，如需提速可评估切 cu130 轮子。
3. **同卡外部并发**：I2V 结束后检测到另一进程提交 qwen 生图 workflow（prompt `5a3b5dc8…`）占用显存——
   编排器「模板切换显式 /free」纪律必须由 worker 侧强制（ADR §4-3），否则 LTX 模板会被生图驻留挤出导致低效/OOM。
4. **gitcode ComfyUI-GGUF 镜像停滞**：HEAD 仍为 `9ecc3c48`（2026-01-12），上游多 6 行 metadata 透传；
   本次实测不需要。若未来 LTX 新档需上游代码，走 codeload 快照或等镜像同步。
5. **任务书偏差**：cast 素材实为 720×1280（非 1024×1024），对 I2V 反而免裁切；已如实按现状执行。
6. **720×1280 的 2.3% 横向重采样**：由 64 对齐固有约束引入（§6），如产品可接受 704×1280 原生输出可省去 ImageScale。
7. **清理命令**（把显存还给生图三件套或冷态）：
   `curl -X POST http://127.0.0.1:8188/free -H "Content-Type: application/json" -d "{\"unload_models\":true,\"free_memory\":true}"`
   探活：`curl http://127.0.0.1:8188/system_stats`。删除 LTX 部署＝删除 §2 五文件 + templates 两个 json + manifest 两条目。

## 附 · 本目录文件

- `EVIDENCE.md` 本文件
- `t2v_test_720x1280_00001_.mp4` / `i2v_test_720x1280_00001_.mp4` — 两次真实生成产物
- `evidence_run_t2v.json` / `evidence_run_i2v.json` — prompt_id/wall/显存 1s 采样序列/输出元数据
- `workflow_t2v_used.json` / `workflow_i2v_used.json` — 实跑 workflow_api（定值版，模板的占位符版在 runtime/templates）
