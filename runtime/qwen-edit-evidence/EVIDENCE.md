# Qwen-Image-Edit（定妆照→新场景新姿势）接入 · 执行证据（EVIDENCE）

> 执行时间：2026-11-21 02:30 – 03:40（北京时间）
> 目标：在既有 ComfyUI :8188（0.46.0 + ComfyUI-GGUF 9ecc3c48，RTX 5060 Ti 16G）接入图像编辑能力（同脸换构图/姿势/场景），两次真实「定妆照→新场景」生成验证 + 模板固化 `qwen-image-edit-cast`
> 结论先行：**接入完成，两次真实编辑生成均通过（人脸身份保持 + 场景/道具/影调命中），模板已登记 manifest.json（tmpl_sha16=41c960acb50e0288）**

---

## 1. arch 支持验证（先小成本，后下载）

| 验证项 | 结果 |
|---|---|
| ComfyUI-GGUF 白名单 | `loader.py:12 IMG_ARCH_LIST = {"flux","sd1","sdxl","sd3","aura","hidream","cosmos","ltxv","hyvid","wan","lumina2","qwen_image"}` — **qwen_image 在列**；TXT_ARCH_LIST 含 qwen3vl/qwen2vl |
| 在盘 turbo 同族旁证 | `qwen-image-2.1-turbo-Q5_K_M.gguf`（前序任务已验）GGUF 头 `general.architecture=qwen_image`，加载识别为 `QwenImage21` 模型类 |
| 全量 2.1 GGUF 张量签名 | 265 tensor，`model.diffusion_model.txt_in.in_layer.weight=[4096,4096]`（qwen3vl-8B 4096 维接口）+ `img_mlp.gate_up` 键 → 与 turbo 同族，ComfyUI 按键集识别为 qwen_image21 |
| 服务端可见性 | 下载后 `UnetLoaderGGUF` object_info 即列出 `qwen-image-2.1-Q5_K_M.gguf` |
| **意外坑（已修复）** | unsloth 全量档容器**零 KV 元数据**（仅 GGUF.version/tensor_count/kv_count，无 general.architecture）→ loader 走 detect_arch 兜底 → convert.py 张量名识别表不识 → `UnetLoaderGGUF` 抛 "Unknown model architecture"（首次提交 prompt_id=95ec7aad 失败，TE/VAE 节点已正常执行）。**修复**：gguf 库逐 tensor raw_dtype 原样拷贝重写容器，补写 `general.architecture=qwen_image` + `quantization_version=2`（与 unsloth 自家 turbo 档完全同构，修复后体积 5,390,223,168B 恰与 turbo 同构文件等大）；校验 265 tensor 名字/量化类型/字节数清单一致 → 张量载荷零改动。修复脚本 `fix_gguf_metadata.py` 存证 |
| 官方节点支持 | comfy_extras/nodes_qwen.py（0.46.0 原生）：`TextEncodeQwenImage21`（prompt+negative_prompt+vae+images×16 → positive/negative/LATENT 三路，参考图经 vision tower + VAE ref_latents 注入）、`QwenImage21Cache`（KV cache 显存控制）；官方模板 `image_qwen_image_2_1_image_edit.json` / `image_qwen_image_2_1_turbo_image_edit.json` 证实 2.1 系（含 turbo）**t2i+edit 统一**，TE=qwen3vl_8b_int8_convrot、VAE=qwen_image_2.1_vae_bf16 与在盘件完全一致 → TE/VAE 零新增下载 |

### 与旧 20B Edit 线的选型对比（为何不选 QuantStack/Qwen-Image-Edit-2509-GGUF）
- 旧线（20B）TE=qwen_2.5_vl_7b（3584 维），2.1 DiT txt_in 期待 4096 维 → 与在盘 qwen3vl int8 **维度不兼容**（前序 EVIDENCE 已实证）；且 20B Q4_K_M ≈11.8G + TE 9.4G 在 16G 卡更紧
- 2.1 线（7B）与在盘 TE/VAE 完全兼容、Q5_K_M 仅 5.4G、官方编辑节点/模板齐备 → 选 **unsloth/Qwen-Image-2.1-GGUF（ModelScope）全量档**，非 turbo（turbo 8 步蒸馏编辑保真弱于全量 25 步，且全量档位成本相同）

## 2. 权重台账

| 文件 | 字节 | sha256 前 16 | 档位 | 为何选它 | 状态 |
|---|---|---|---|---|---|
| `E:\ComfyUI\models\diffusion_models\qwen-image-2.1-Q5_K_M.gguf` | 5,390,223,168 | 下载原件 `4b53321654dd3bf0`（与 ModelScope 清单一致，但容器缺元数据）→ **修复后 `f638bd4e385ea2af`（登记以此为准）** | GGUF Q5_K_M（7B 全量 DiT，t2i+edit 统一） | 任务书要求的「Qwen-Image-Edit 编辑模型」在 2.1 线即本模型（官方编辑模板直接用）；Q5_K_M 与在盘 turbo 同字节包络（显存账已验证），优于 Q4 保真；**禁 bf16/F16（14.2G）**；unsloth ModelScope 仓 ~40MB/s | **采用**（UnetLoaderGGUF full load 5332MB） |
| `E:\ComfyUI\models\text_encoders\qwen3vl_8b_int8_convrot.safetensors` | 9,350,798,360 | `8bfd0f6e12abf2d2` | int8 ConvRot（复用在盘） | 2.1 系官方 TE，内含 vision tower（TextEncodeQwenImage21 图像 token 化必需） | **采用**（staged 8916MB） |
| `E:\ComfyUI\models\vae\qwen_image_2.1_vae_bf16_comfyorg.safetensors` | 675,509,688 | `bb21f7473051e1ac` | VAE bf16 小件（复用在盘） | 2.1 系官方 VAE | **采用**（staged 644MB） |

新下载仅 1 件（5.4GB），TE/VAE 全复用。选档理由：全量档 Q5_K_M ≈ turbo Q5_K_M 显存包络（同 7B 架构同量化），编辑质量优于 turbo 蒸馏档；Q4_K_M（4.2G）可作进一步降档备选。

## 3. 两次真实编辑生成记录（+ 身份调优全过程）

参考图：`E:\ComfyUI\input\female_ref.png`（女主沈晚定妆，720×1280 RGB 黑长直东亚面孔）
流程：每次 POST /free → 提交 /prompt → 轮询 /history → nvidia-smi 1s 采样 → 产物拷证据目录 → POST /free

### 终版两张（登记 verified）
| 跑 | 指令 | prompt_id | seed/cfg/steps | 耗时 | 显存峰值 | 产物 | 目视核验 |
|---|---|---|---|---|---|---|---|
| a. 雨夜灯塔旋梯+马灯（任务指令 a 原文） | 「让画面中的女子站在雨夜灯塔旋梯上，手提点亮的老式马灯，裙摆被风吹动，保持面部特征与发型不变，实拍电影剧照质感，青橙影调」 | `06ad41f9-7779-4c43-9253-72d6220c130f` | 20261121 / 1.0 / 25 | **59.3s** | **15969 MiB（97.9%）** | `ladder_06ad41f9.png`（1,301,074B） | 同一女子（黑长直+同脸型），旋梯/马灯/风吹裙摆/雨夜/青橙全命中，实拍质感 |
| b. 塔顶值班室读信（任务指令 b 语义+身份锚点前置写法） | 「画面中是参考图里同一位黑发年轻东亚女性（同一人），她在灯塔塔顶值班室里读一封旧信，烛光映脸，她的面部特征与黑色长直发型与参考图完全一致，实拍电影剧照质感」 | `629c3e5e-bb3a-40f9-aca9-9bd76bacad0f` | 20261121 / 1.0 / 25 | **57.1s** | **14480 MiB（88.8%）** | `letter_629c3e5e.png`（1,108,329B） | 同一女子（黑长直+同脸），灯室窗内读旧信+烛光映脸+冷蓝夜色，实拍质感 |

### 身份调优记录（重要工程结论，供 worker 提示词写法）
同一指令 b 原文「让画面中的女子在灯塔塔顶值班室里读一封旧信，烛光映脸，保持面部特征与发型不变…」在**远景小脸+重打光构图**下会换人：

| 尝试 | prompt_id | seed | cfg | 结果 |
|---|---|---|---|---|
| b-1 | `4f5e1688-cfdb-4c1e-b495-7cc808992e63` | 20261121 | 1.0 | ✗ 换人（卷发刘海他人），场景命中（`letter_4f5e1688.png`） |
| b-2 | `e3e42d6e-4217-4c94-b731-727e8b234853` | 20261122 | 1.0 | ✗ 换人（金发短发），场景命中（`letter_e3e42d6e.png`） |
| b-3 | `ccc793b2-ded9-42a6-885a-07fea5faf2c6` | 20261121 | **2.5** | ✗ 仍换人，场景更佳；cfg 不是身份杠杆，且耗时 104.8s（+83%）（`letter_ccc793b2.png`） |
| b-4 终版 | `629c3e5e-bb3a-40f9-aca9-9bd76bacad0f` | 20261121 | 1.0 | ✓ **指令前置显式身份锚点后同脸**（黑长直东亚面孔回归） |

**结论：身份保真 = 指令文本结构问题，非采样参数问题。** 推荐写法（已写入 manifest params.PROMPT）：把「参考图里同一位…女性（同一人）…面部特征与发型与参考图完全一致」锚点**前置**，场景描述在后；裸写「保持面部特征与发型不变」不可靠。中近景构图（跑 a）裸子句即可保身份。

## 4. 显存账（16G 纪律）

| 项 | 值 |
|---|---|
| DiT Q5_K_M | full load 5332MB 驻卡（GGUF 量化） |
| TE int8 | staged 8916MB（编码后与 DiT 共存，ComfyUI DynamicVRAM） |
| VAE | staged 644MB |
| 编辑额外开销 | 参考图 VAE ref_latent 编码 + vision tower 编码 + 编辑序列 KV cache（QwenImage21Cache device=auto：溢出自动落 RAM） |
| **实测峰值** | 冷启动首跑 **15969 MiB / 16311（97.9%）** 无 OOM；稳态跑 14480–14512 MiB（88.8–89%） |
| 纪律执行 | 每次生成前后 POST /free（body=`{"unload_models":true,"free_memory":true}`；空 body 会 500）；无 OOM 无重试；未与 LTX 热载共存 |

## 5. API / 模板说明

- 模板：`E:\Work\X-Theater\runtime\templates\qwen-image-edit-cast.json`（tmpl_sha16=`41c960acb50e0288`）
- 占位符（worker 契约，字符串替换）：`<IMAGE>`（LoadImage 文件名）、`<PROMPT>`（编辑指令=正向）、`<NEGATIVE>`、`<SEED>`、`<WIDTH>`、`<HEIGHT>`、`<STEPS>`、`<CFG>`
- 图结构：`UnetLoaderGGUF → QwenImage21Cache(device=auto,dtype=default)` → KSampler.model；`CLIPLoader(qwen3vl_8b_int8_convrot, type=qwen_image)` + `VAELoader(2.1 vae)` + `LoadImage(<IMAGE>)` → `TextEncodeQwenImage21(resolution=1024, images={"image_1":[LoadImage,0]})` 出 positive/negative/LATENT 三路；KSampler positive/negative 接前两路，**latent_image 接 `EmptySD3LatentImage(<WIDTH>,<HEIGHT>)`**；VAEDecode → SaveImage；sampler=euler/simple、denoise=1（固定）
- **与协调方接线描述的偏差（有意为之，需知悉）**：协调方描述「KSampler latent_image 接 TextEncodeQwenImage21 的 LATENT 路」，但该 LATENT 尺寸=参考图按 resolution 32 对齐重采样（720×1280 输入 → 768×1376），**无法精确输出分镜要求的 720×1280**，且会使 `<WIDTH>/<HEIGHT>` 占位符失效。故模板接 EmptySD3LatentImage（两次冒烟即此接法，输出精确 720×1280）。若要「严格跟随参考图构图」语义，把节点 8 的 `latent_image` 改 `["5", 2]` 一行即可
- COMFY_AUTOGROW_V3（images）在 /prompt API 里是 dict：`"images": {"image_1": ["4", 0]}`
- 每次实际提交的 workflow 存证：`workflow_run_ladder.json` / `workflow_run_letter.json`（本目录）

## 6. 重启与清理命令

```bash
# ComfyUI 原命令行重启（崩溃时按此重启；当前应保持运行）
E:\ComfyUI\venv\Scripts\python.exe E:\ComfyUI\main.py --port 8188 --listen 127.0.0.1

# 生成前后卸载（空 body 会 500，必须带 body）
curl -s -X POST http://127.0.0.1:8188/free -H "Content-Type: application/json" \
     -d '{"unload_models":true,"free_memory":true}'

# 单测一次编辑生成（读注册模板替换占位符，显存 1s 采样，产物自动拷证据目录）
E:\ComfyUI\venv\Scripts\python.exe -I E:\Work\X-Theater\runtime\qwen-edit-evidence\run_edit.py \
     --tag <tag> --seed 20261121 \
     --instruction "<编辑指令，身份锚点前置写法>"

# 复跑冒烟前核对权重在位
ls -la E:\ComfyUI\models\diffusion_models\qwen-image-2.1-Q5_K_M.gguf   # 5,390,223,168 B
```

## 7. 存证清单（本目录）

| 文件 | 说明 |
|---|---|
| `ladder_06ad41f9.png` | 终版跑 a 产物（身份✓） |
| `letter_629c3e5e.png` | 终版跑 b 产物（身份✓） |
| `letter_4f5e1688.png` / `letter_e3e42d6e.png` / `letter_ccc793b2.png` | 跑 b 三次换人失败件（提示词写法反例存证） |
| `run_ladder.json` / `run_letter.json` | 终版跑记录（prompt_id/耗时/峰值/产物） |
| `workflow_run_ladder.json` / `workflow_run_letter.json` | 实际提交的 /prompt workflow |
| `run_edit.py` | 冒烟跑批器（读注册模板→替换占位符→/prompt→采样→拷产物） |
| `fix_gguf_metadata.py` | GGUF 零元数据容器修复脚本（含 265 tensor 清单校验） |
| `oi_snapshot.json` | object_info 快照（节点契约存证） |

## 8. 遗留问题

1. **远景/重打光构图的裸身份子句不可靠**（见 §3 调优记录）——产品侧 PROMPT 生成必须用锚点前置写法；worker 若要硬保底，可考虑后续接控制权重/换装线，但当前模板契约内以提示词写法解决
2. **cfg=1 时 NEGATIVE 不生效**（2.1 族蒸馏定 cfg=1，官方模板即如此）——<NEGATIVE> 占位保留但无效果；若产品要负向约束生效需 cfg>1（代价 +83% 耗时，实测对身份无帮助）
3. 参考图服装不锁定：跑 a 中吊带裙被改写为长裙（场景合理但非保服装）；需锁服装时在指令中显式写「服装与参考图一致」
4. ComfyUI-GGUF 若日后升级（qwen_image21 进 detect_arch 表），可换回未修复原件（sha16=4b53321654dd3bf0）；当前 pin 9ecc3c48 + 修复件即可
5. turbo 档（8 步快线）未启用——若产品要 <5s 级预览，可加 turbo 变体模板（在盘 turbo GGUF 即 edit-capable），本次未登记
