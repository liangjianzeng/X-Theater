# W-B 无头 ComfyUI 部署＋生图先行 · 执行证据（EVIDENCE）

> 执行时间：2026-11-20 23:37 – 2026-11-21 00:37（北京时间）
> 依据：docs/theater-infer-backend-adr.md（ADR-001，已决策定案）+ 发起人硬纪律（权重档位优先级 nvfp4 → int8 → fp8-scaled → GGUF 低比特；16G 装不进的大权重禁下；bf16 大文件禁下）
> 结论先行：**部署完成，真生图验证通过（两张语义正确 PNG），ComfyUI 常驻 :8188 保持运行**

---

## 1. 四元组登记（ADR-001 §4-2 版本固化）

| 项 | 值 |
|---|---|
| ComfyUI commit | `a20552b5efd844ddf4da9dce4f55e313333a9ef9`（v0.46.0，2026-11-20 提交，全量 6379 commits；克隆源 **gitcode.com/gh_mirrors/co/ComfyUI.git**——github.com 直连被重置、gitclone.com/ghproxy 系全部超时，gitcode 镜像验证与上游当日同步） |
| ComfyUI-GGUF commit | `9ecc3c48e7ec48ec6fee95de90197ae7aee6644e`（2026-01-12，#402；克隆源 gitcode gh_mirrors。**镜像略旧于上游 master**：nodes.py 上游多一个 metadata 透传 compat 改进、__init__.py 仅 EOL 差异；GGUF 解析本体 loader.py 与上游 master 逐字节一致，经 raw.githubusercontent.com 比对） |
| 权重文件版本 | 见 §2（sha256 前 16 位逐件登记） |
| workflow hash | `f60542d080014baf`（= sha256[0:16] of canonical JSON：`json.dumps(WORKFLOW, sort_keys=True, ensure_ascii=False, indent=1)`，即 workflow_api.json 文件内容；模板固化于 generate_and_verify.py，**非用户输入 workflow**，符合 ADR 安全红线） |

运行时版本：ComfyUI **0.46.0** / Python **3.12.13**（CPython，uv venv）/ PyTorch **2.11.0+cu128**（CUDA 可用，识别 RTX 5060 Ti）/ comfy-kitchen 0.2.41 / gguf 0.19.0 / transformers 5.23.0。

---

## 2. 权重台账（文件 / 字节 / 档位 / 为何选它 / 显存账）

| 文件 | 字节 | sha256 前 16 | 档位 | 为何选它 | 状态 |
|---|---|---|---|---|---|
| `E:\Unsloth\models\qwen-image-2.1-turbo-Q5_K_M.gguf` | 5,390,223,168 | `37c51ff446f4db2e` | GGUF Q5_K_M（transformer） | 已盘内资产（豁免，未重下）。GGUF 头解析 265 tensor、arch=qwen_image，`txt_in.in_layer=[4096,4096]`+`img_mlp.gate_up` 键 → ComfyUI 检测为 qwen_image21 ✓ | **采用**（UNETLoaderGGUF 加载实测 5332.50MB full load） |
| `E:\ComfyUI\models\text_encoders\qwen3vl_8b_int8_convrot.safetensors` | 9,350,798,360 | `8bfd0f6e12abf2d2` | **int8**（ConvRot INT8，官方 Comfy-Org/Qwen-Image-2.1） | 优先级阶梯：nvfp4 官方仓无货 → **int8 为最高可得档** → 采用（fp8 档官方仓对 qwen3vl_8b 无货） | **采用**（CLIPLoader type=qwen_image → 服务端加载为 `QwenImage21TEModel_`，staged 8916MB） |
| `E:\ComfyUI\models\vae\qwen_image_2.1_vae_bf16_comfyorg.safetensors` | 675,509,688 | `bb21f7473051e1ac` | VAE bf16（小文件豁免档） | **盘内同名文件被证实张冠李戴**：675,508,656B 与官方 675,509,688B 不符，且 `encoder.conv_in.weight=[96,4,3,3]`（4 输入通道）导致 ComfyUI VAE 架构识别错乱、加载报错；官方文件（safetensors metadata=`qwen_image_2.1_vae`，conv1/conv2 Conv3d 新键名）加载正常。盘内坏文件在 E:\Unsloth\models，**未越界改动**，以独立文件名放置官方件 | **采用**（WanVAE 识别，staged 644MB） |
| `E:\ComfyUI\models\text_encoders\qwen_2.5_vl_7b_fp8_scaled.safetensors` | 9,384,670,680 | `cb5636d852a0ea6a` | fp8-scaled（Qwen2.5-VL-7B） | **按原任务书下载**；执行中发现选型错误：Qwen-Image-**2.1** DiT 的 `txt_in` 期待 4096 维（Qwen3-VL-8B 隐层），2.5-VL-7B 输出 3584 维 → **维度不兼容，未用于本次生图** | 保留（对 Qwen-Image 1.0/2512 Apache 线仍有效，不浪费） |
| `qwen3vl_8b_bf16.safetensors`（17,534,334,616B） | — | — | bf16 | **违反硬纪律**：下载约启动即被发起人叫停，已终止下载并删除残件。教训记录：先算显存账再下载 | 已删除 ✗ |

### 显存预算账（16G 卡，禁 --highvram，默认显存进出调度）

| 组件 | 服务端实测（log） |
|---|---|
| TE `QwenImage21TEModel_`（int8_convrot，dtype fp16 工作态） | **staged 8916 MB** |
| DiT `QwenImage21`（GGUF Q5_K_M → fp16 计算，GGUF 量化驻卡） | **loaded 5332.50 MB**（usable 6363.60 MB，full load: True） |
| VAE `WanVAE`（bf16） | **staged 644 MB** |
| 三件常驻合计 | ≈ 14.9 GB |
| **实测 nvidia-smi 峰值（1s 采样）** | **14800 MiB / 16311 MiB = 90.7%**（冷启动首跑 14190 MiB）——无 OOM、零重试 |
| 调度行为 | NORMAL_VRAM + DynamicVRAM + async weight offloading（2 streams）；TE 编码与 DiT 采样常驻共存（ComfyUI 复用缓存），单扩散模型 ✓，无第二个 DiT 热载 |
| 遗留提示 | 90.7% 峰值对本 workflow 安全；后续若接入 LTX-2.5 UD-Q4_K_XL（14GB 档）必须显式卸载生图三件（ADR 禁生图/i2v 热载共存，编排层职责） |

---

## 3. 部署步骤实际执行版（含全部绕障记录）

| 步骤 | 任务书原案 | 实际执行 | 备注 |
|---|---|---|---|
| 1. 克隆 ComfyUI | github 直连，备用 gitclone/ghproxy | ✗ github 连接重置；✗ gitclone.com / ghfast.top / gh-proxy.com / github.moeyy.xyz 全部超时或拒连；✓ **gitcode.com/gh_mirrors/co/ComfyUI.git**（全量历史，与上游当日同步） | codeload.github.com 与 raw.githubusercontent.com 可达但 api.github.com 不可用 |
| 2a. venv | `uv venv --python 3.12` 自动装 python | ✓ 但 uv 0.13.5 发现不了本机已有 cpython-3.12.13（Roaming\uv\python 旧布局）→ **绝对路径建 venv** 绕过 | 本机无系统 python |
| 2b. torch cu128 | `uv pip install torch torchvision --index-url download.pytorch.org/whl/cu128` | ✗ 该命令吊死（8 分钟零下载，uv 解析器卡死）；✓ 改为 **curl 断点续传轮子自下载**（torch-2.11.0+cu128 2.75GB，2–7MB/s）+ `uv pip install <本地轮子>`；依赖解析默认 pypi.org 也吊死 → **UV_DEFAULT_INDEX=mirrors.aliyun.com/pypi/simple** 后成功 | 阿里云 pytorch-wheels/cu128 目录实测仅 39KB/s（弃）；download.pytorch.org 直连轮子可用 |
| 2c. requirements | ComfyUI requirements.txt + GGUF requirements.txt | ✓ 经阿里云 PyPI 镜像安装成功 | transformers 5.23.0、gguf 0.19.0 等 |
| 3. ComfyUI-GGUF | github 直连 | ✓ gitcode gh_mirrors/co/ComfyUI-GGUF.git | requirements 已装 |
| 4. 模型路径 | extra_model_paths.yaml 指路，不复制大文件 | ✓ `E:\ComfyUI\extra_model_paths.yaml`：diffusion_models/unet/vae → `E:\Unsloth\models`；text_encoders 用核心默认目录。服务端 object_info 验证三个文件均可见 | 未软链/硬链/复制任何大文件 |
| 5. 启动 + 健康检查 | 后台常驻 :8188 | ✓ `GET /system_stats`：cuda:0 RTX 5060 Ti，vram_total 17102864384B，pytorch 2.11.0+cu128，ComfyUI 0.46.0 | system_stats.json 存证 |
| 6. 真生图 | POST /prompt 固化模板 + 轮询 /history | ✓ 见 §4 | 两次真实生成 + 一次缓存命中演示 |
| 7. 证据落盘 | 本目录 | ✓ | EVIDENCE.md 即本文 |

权重下载通道实测：**ModelScope（modelscope.cn，Comfy-Org 官方镜像）28MB/s** 为首选；hf-mirror.com 可用但仅 ~1MB/s。

---

## 4. 真生图结果（生图先行 ✓）

Workflow（API 格式，固化模板）：UnetLoaderGGUF(qwen-image-2.1-turbo-Q5_K_M.gguf) → CLIPLoader(qwen3vl_8b_int8_convrot.safetensors, type=qwen_image) → VAELoader(官方 2.1 VAE) → CLIPTextEncode×2（正向「一张写实夜航灯塔明信片」/ 负向「低质量」）→ EmptySD3LatentImage(1024×1024) → KSampler(steps=8, cfg=1.0, euler, simple, denoise=1.0) → VAEDecode → SaveImage。

| 跑 | prompt_id | seed | 耗时 | 显存峰值 | 产物 |
|---|---|---|---|---|---|
| 冷启动（首次，含模型加载） | `0079d0de-1790-4ce4-8da2-c9a92a0a116a` | 20261121 | **30.8s** | 14190 MiB | `w_b_lighthouse_00001_.png` 1,180,983 B → 存证 `w_b_lighthouse_seed20261121.png` |
| 缓存命中演示（同 workflow 重提交） | `a3aa528e-e6cd-491a-97dc-3b646cdd8829` | 20261121 | 2.1s（节点全缓存命中，未重算——API 幂等性证据） | 13168 MiB | 同图复用 |
| **稳态真生成** | `c05e7fa4-1623-467c-a59b-4d81a1e78076` | 20261122 | **21.2s** | **14800 MiB** | `w_b_lighthouse_00002_.png` 1,444,398 B |

两张 PNG 均经目视核验：夜航灯塔场景、构图随 seed 变化、语义命中正向提示词（int8_convrot TE 在 cu128 下语义理解正常 → 非噪声图）。

**16G 铁律遵守记录**：未使用 --highvram；单次提交一次成功，全程无 OOM、无同参数重试；nvidia-smi 1s 采样峰值已记录（evidence_run_*.json 内含完整采样序列）。

---

## 5. 重启命令（ComfyUI 进程当前保持运行 :8188）

```bash
# Git Bash / 任意 shell（cwd 必须是 E:\ComfyUI）
cd /e/ComfyUI && ./venv/Scripts/python.exe main.py --port 8188 --listen 127.0.0.1
```

等价 CMD 形式：`cd /d E:\ComfyUI && E:\ComfyUI\venv\Scripts\python.exe main.py --port 8188 --listen 127.0.0.1`

- 日志：`E:\ComfyUI\comfyui_server.log`（快照存证 `comfyui_server.log.snapshot`）
- 健康探活：`GET http://127.0.0.1:8188/system_stats`
- 提交生图：`E:\Work\X-Theater\runtime\comfyui-evidence\generate_and_verify.py`（venv python 运行，可带 seed 参数）
- 严格不外网暴露：仅 --listen 127.0.0.1，无鉴权端点不出本机（ADR §4-4 安全红线）

---

## 6. 遗留问题清单

1. **torch cu128 vs ComfyUI 0.46 的 cu130 性能警告**：启动日志明示 "PYTORCH CUDA VERSION BELOW 13.0 … Performance will be terrible"，comfy-kitchen 的优化 CUDA 内核（含 int8_convrot/w4a8 加速路径、fp8 TensorCore 布局）在 cu128 下被禁用。**功能实测正常**（int8 TE + GGUF DiT 真出图、语义正确），但吞吐不是最优。任务书硬定 cu128 系（sm_120 要求），未擅自升级；建议后续决策：切 torch 2.11.0+cu130 轮子（阿里云有货，sm_120 同样支持，非降级）以解锁 comfy-kitchen 加速，尤其接入 LTX-2.5/更多量化档前。
2. **任务书 TE 选型错误（已纠正）**：qwen-image-**2.1** 的 text encoder 是 Qwen3-VL-8B（4096 维），非 Qwen2.5-VL-7B（3584 维）——依据：ComfyUI `comfy/sd.py` CLIPType.QWEN_IMAGE×TEModel.QWEN3VL_8B → qwen_image21 分支 + GGUF `txt_in.in_layer=[4096,4096]`。已按硬纪律改下官方 int8_convrot 档。8.73GB fp8 文件保留（2512/1.0 Apache 线可用）。
3. **盘内坏 VAE（E:\Unsloth\models）**：`qwen_image_2.1_vae_bf16.safetensors`（675,508,656B）为张冠李戴文件（encoder.conv_in=[96,4,3,3]，非 2.1 VAE 架构，ComfyUI 加载失败）。未越界删改，官方件以 `…_comfyorg.safetensors` 独立名放置。**建议主控通报权重盘点负责人**：该目录文件不能只信文件名。
4. **ComfyUI-GGUF 镜像略旧**：gitcode 镜像 HEAD=9ecc3c48（2026-01-12），上游 master 多一个 metadata 透传改进（nodes.py 6 行），不影响本 workflow；github 直连被墙无法 git fetch 上游，后续升级需走 codeload 快照或等 gitcode 同步。
5. **网络基线固化**：本机 github.com / pypi.org / gitclone.com 不可用或吊死；可用通道 = gitcode（git）、ModelScope（权重，28MB/s）、download.pytorch.org（轮子 2–7MB/s）、aliyun pypi（pip）。后续部署/CI 脚本应直接内置这些源，勿再从 github/pypi 默认源起步。
6. **uv 0.13.5 python 发现缺陷**：识别不了 Roaming\uv\python 下的旧布局 cpython-3.12.13，需绝对路径建 venv（已绕过）。
7. **显存余量**：本 workflow 峰值 90.7%；同卡再排 LTX-2.5 UD-Q4_K_XL（14GB）必须先卸载生图三件或重启 worker——编排器侧需实现「模板切换显式卸载」（ADR §4-3），本机已具备单模型进出调度的验证基础。
8. **ComfyUI 现网残留状态**：进程常驻且模型三件驻卡（~14GB），属 ComfyUI 正常复用缓存；若编排器要求零驻留冷态，重启进程即回收。

## 附 · 证据文件清单（本目录）

- `workflow_api.json` — 固化模板（hash `f60542d080014baf`）
- `generate_and_verify.py` — 模板固化 + /object_info 校验 + /prompt 提交 + /history 轮询 + nvidia-smi 采样
- `evidence_run_cold.json` / `evidence_run_steady.json` / `evidence_run.json` — prompt_id/耗时/显存采样序列
- `w_b_lighthouse_seed20261121.png` / `w_b_lighthouse_00002_.png` — 两次真生成产物
- `system_stats.json` / `object_info_snapshot.json` — 健康检查与节点注册快照
- `te_int8_sha256.txt` / `comfyui_server.log.snapshot` — TE 哈希 / 服务端日志（含模型加载显存行）
