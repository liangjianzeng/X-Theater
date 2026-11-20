# W-M 自部署生乐服务（ACE-Step 1.5, :8190）· 执行证据（EVIDENCE）

> 执行时间：2026-11-21 01:10 – 01:55（北京时间）
> 依据：W-M 部署任务书（惰性加载＋响应后释放显存；档位纪律 nvfp4→int8→fp8→低比特，bf16 大权重禁下需登记兜底理由；ModelScope 权重通道 + 阿里云 pip 通道；绝不碰 E:\Work\X-Theater\src 与 E:\ComfyUI）
> 结论先行：**部署完成，两次真实 45s 配乐生成通过（释然/离别各一，均非静音真音频），服务常驻 127.0.0.1:8190，响应后显存释放到 181MB 残留**

---

## 1. 版本固化登记

| 项 | 值 |
|---|---|
| ACE-Step 代码仓库 | **ACE-Step-1.5 v1.5.0**，commit `7202bc3`（"feat: opt-in on-demand model loading instead of silent fallback to primary (#1284)"，gitcode gh_mirrors 镜像克隆——github 直连被墙沿用 W-B 固化通道） |
| 权重仓库 | ModelScope **`ACE-Step/Ace-Step1.5`**（官方 ACE-Step 组织上传， Downloads≈134.5k；即 Model Zoo 中 `acestep-v15-turbo` DiT + `acestep-5Hz-lm-1.7B` LM 的官方组合包） |
| Python | 3.12.13（CPython，uv venv 绝对路径建——uv 0.13.5 python 发现缺陷沿用 W-B 绕障） |
| PyTorch | **2.7.1+cu128**（sm_120 识别 RTX 5060 Ti，CUDA 可用；仓库 requirements 对 win32 的官方钉版） |
| 关键依赖 | transformers 4.57.6（仓库上限 <4.58 ✓）/ diffusers 0.37.1 / torchao 0.16.0（int8 量化）/ accelerate 1.16.0 / safetensors 0.7.0 / soundfile 0.14.0 / fastapi 0.165.0 / uvicorn 0.54.0 / modelscope 1.40.3（完整清单见 `venv_freeze_key_deps.txt`） |
| 服务 | 自研 FastAPI `server.py` @ **127.0.0.1:8190**（严格不外网暴露） |

---

## 2. 权重台账（文件 / 字节 / sha256 / 档位 / 为何选它 / 显存账）

来源：`modelscope.snapshot_download('ACE-Step/Ace-Step1.5')` → `E:\Work\X-Theater\runtime\acestep\models\`，198s 全量 9.4GB（实测 ≈48MB/s，优于基线 28MB/s）。四件大权重 sha256 前 16 位与 ModelScope API `ModelInfos.safetensor.files` 逐件核对一致，dtype 经 safetensors 头解析实测（非凭文件名）。

| 文件（models/ 下相对路径） | 字节 | sha256 前 16 | 实测 dtype | 档位与选型理由 | 运行态 |
|---|---|---|---|---|---|
| `acestep-v15-turbo/model.safetensors` | 4,787,825,604 | `3f6e0797fad420a3` | BF16×677 张量 | DiT 主模型，**运行时 torchao int8_weight_only 量化**（官方 gpu_config 16GB 档默认 `quantization_default=True`）。**兜底理由：ACE-Step 组织 ModelScope 全系（base/sft/turbo/xl-base、0.6B/1.7B/4B LM）实测无 nvfp4/int8/fp8 预量化文件（仓库名逐个探测 404），官方只发 bf16 → 按「官方无更低位档」规则取 bf16 权重 + 运行时 int8（权重驻卡字节减半），高于"直接 bf16 驻卡"档** | DiT 驻卡 int8 ≈ **2,388 MiB**（init 后实测 allocated 3074.6 MiB 含 VAE/TE 句柄），响应后卸回 CPU RAM |
| `acestep-5Hz-lm-1.7B/model.safetensors` | 3,708,521,528 | `f161689da73e5ece` | BF16×310 | 5Hz LM（CoT 元数据 + 音频语义 codes 生成）。tier5/6a 官方推荐 1.7B；**pt 后端 + offload_to_cpu=True：推理时进卡（~3.4GB bf16），Phase 结束自动卸回 CPU + empty_cache**（官方 `_load_model_context` 机制，逐 Phase 进出卡） | 仅推理期驻卡，响应后 = 0 |
| `Qwen3-Embedding-0.6B/model.safetensors` | 1,191,586,416 | `0437e45c94563b09` | BF16×310 | 文本编码器（TE），cpu offload 常驻 RAM，编码 Phase 进出卡 | 仅推理期驻卡 |
| `vae/diffusion_pytorch_model.safetensors` | 337,431,388 | `da17edb604c40dea` | BF16×365 | VAE（tiled decode，chunk=128 + wav offload cpu） | 仅推理期驻卡 |
| `acestep-v15-turbo/silence_latent.pt` | 3,841,215 | — | — | 生成初始化 latent（小件随主包） | 随 DiT |

**备选未采用**：`acestep-v15-xl-base`（4B DiT，50 步 + CFG，更慢更大）、`acestep-v15-base/sft`（50 步）、`acestep-5Hz-lm-0.6B`（更省但作曲能力 Medium，16G 卡装得下 1.7B 无需降档）——均非必要。

### 显存账（16310.6 MiB 总量，16G 卡显存互斥场景）

| 阶段 | torch allocated 峰值 | nvidia-smi 全卡实测 | 说明 |
|---|---|---|---|
| 服务空闲（未加载） | 0 MB | — | 惰性：不请求不占卡 |
| 冷加载完成（DiT int8 驻卡） | **4,591 MB** | — | DiT 加载 bf16 4.8GB→int8 量化瞬间双份是峰值来源 |
| 生成全程（LM+DiT+VAE 分时进出卡） | **6,864 MB** | **7,281 MiB**（1s 采样，第二次运行，独占干净态） | = 45.4% 总显存；LM/DiT 分 Phase 交替驻卡是官方 offload 设计 |
| **响应后（/music 返回即释放）** | **181 MB 残留** | 14,826 MiB free / 16,310 | DiT/VAE/TE/LM 全部卸回 CPU RAM + `empty_cache`；181MB 为 CUDA context 级残留 |
| /unload 端点 | 同上 | 同上 | 幂等，可反复调 |

**16G 适配结论**：峰值 7.3GB ≪ 16G，无需牺牲 ComfyUI 完整生图工作流的共存余量；与 ComfyUI(:8188)/CosyVoice(:9880) 显存互斥由编排层保证（生成前 POST 8188/free 卸载，本服务 7.3G 峰值不与其 14.9G 工作流争卡）。

---

## 3. 许可预检（双源核验，usage=ok）

| 项 | 值 |
|---|---|
| 代码仓 LICENSE | **MIT**（`acestep-repo/LICENSE`：Copyright (c) 2026 ACEStep） |
| ModelScope API License 字段 | **`"License": "mit"`**（`/api/v1/models/ACE-Step/Ace-Step1.5`） |
| 模型卡声明 | "Commercial-Ready: …You can strictly use the generated music for commercial purposes"；训练数据 = 授权曲库 + 免版税/无版权曲库 + 合成数据 |
| pyproject | `license = {text = "MIT"}` |
| 结论 | **model license = MIT（双源一致），usage=ok（可商用出品的配乐）** |

---

## 4. 部署步骤实际执行版（含绕障记录）

| 步骤 | 实际执行 | 备注 |
|---|---|---|
| 1. 仓库定位 | ModelScope API 探测确认 `ACE-Step/Ace-Step1.5`（1.5 而非 1.0：README 标题/模型卡/Tech Report arXiv 2602.00744 三证） | 量化档变体（fp8/int8 仓）404 → int8 兜底理由成立 |
| 2. 代码 | `git clone --depth 1 https://gitcode.com/gh_mirrors/ac/ACE-Step-1.5.git`（github 被墙，沿用 W-B 通道） | v1.5.0，含官方 api_server（本部署改用自研轻量 server 直调 handler） |
| 3. venv | `uv venv --python <绝对路径 cpython-3.12.13>` → `E:\Work\X-Theater\runtime\acestep\venv` | **未触碰 E:\ComfyUI venv** |
| 4. torch | uv 解析器对 `torch==2.7.1+cu128` 在 pytorch 索引上误报"无版本"（索引页实测有货）→ **curl 直下 3 个轮子（torch/torchaudio/torchvision cu128 cp312，共 ~3.28GB，断点续传）+ 本地 wheel 安装**，依赖经阿里云镜像 | 轮子文件名含 `%2B` 需重命名还原 `+`；install 时把依赖解析带入的 torch 2.15.0 降回 2.7.1+cu128 |
| 5. 其余依赖 | 阿里云 PyPI 镜像：transformers<4.58、torchao<0.17、diffusers、soundfile、fastapi、uvicorn、modelscope、numba、vector-quantize-pytorch、pytorch-wavelets 等；gradio/torchcodec/lightning/peft（仅 UI/训练用）**未装** | **绕障一处**：pytorch_wavelets 依赖 `pkg_resources`，setuptools 84 已移除 → 钉 `setuptools==80.10.2` 修复 |
| 6. 权重 | `snapshot_download` 全量 29 文件 9.4GB → `models/`（布局即 `ACESTEP_CHECKPOINTS_DIR` 期望布局，零搬运） | 198s ≈48MB/s |
| 7. 服务 | 自研 `server.py`（惰性加载 + 单代锁 + 响应后 `model/vae/text_encoder/llm.to('cpu')` + `empty_cache`） | 127.0.0.1:8190 |
| 8. 真生成验证 | 两次（详见 §5）；显存 1s 采样存证 | 生成前 POST 8188/free |

**首次运行踩坑修正（已固化）**：首轮 DCW 小波校正因 `pkg_resources` 缺失被官方代码静默降级 no-op（仅告警，不影响出声）；已修 setuptools 钉版并重启服务，第二轮日志确认 `[DCW] Built DWT1D … wavelet='haar'` 真实生效。

---

## 5. 真实生成结果（45s 配乐 ×2，均验证非静音真音频）

生成前均执行 `POST http://127.0.0.1:8188/free {"unload_models": true}`（ComfyUI 返回 200 空响应体——解析报错属外观问题，卸载实际生效：全卡显存 14337→1729 MiB 由采样序列佐证）。

| 跑 | mood | seed | 总耗时 gen_seconds | 其中模型/冷加载 | 显存峰值（torch / 全卡采样） | 产物 |
|---|---|---|---|---|---|---|
| 冷启动首跑 | 释然，平静温暖的钢琴与弦乐，放下与释怀的情感，柔和渐远 | 20261121 | **91.12s** | model 44.53s + 冷加载 45.30s | 6,839 MB / 15,871 MiB* | `1a1fa0caef9-06d60b09.wav` 17,280,088 B，45.000s，RMS 0.1295 |
| **稳态（DCW 生效）** | 离别，钢琴主导的抒情曲，弦乐渐弱，克制的忧伤与祝福 | 20261122 | **73.07s** | model 33.50s + 冷加载 37.73s | **6,864 MB / 7,281 MiB** | `1a1fa11be98-31cc722c.wav` 17,280,088 B，45.000s，RMS 0.1225 |

\* 首跑全卡 15871 MiB 含 ComfyUI/GameViewer 同窗残留（/free 尚在卸载中即开始采样），非本服务独占值；第二次运行在干净态下实测 **7,281 MiB（44.6%）** 为本服务真实占卡水平。

- LM Phase 生成 **225 个 audio codes = 45s × 5Hz 精确命中**；CoT 元数据（bpm/调式/语言）由 1.7B LM 产出；DiT turbo 8 步；DCW 小波校正 double/haar 生效。
- 两曲 sha256 不同（`2b4d8510…` / `0dd292b1…`），非缓存复用；均通过 GET 回读字节数比对 match=True。
- 响应即释放：两次 /music 返回后 torch allocated 均回落 **181/296 MB**（CUDA context 级），`POST /unload` 幂等可再压。

---

## 6. API 契约（产品 worker 直调）

服务地址：`http://127.0.0.1:8190`（仅本机回环，无鉴权端点不出机）。

### POST /music —— 生成配乐（同步返回）

请求体：
```json
{"mood": "释然，平静温暖的钢琴与弦乐，放下与释怀的情感，柔和渐远", "seconds": 45, "seed": 20261121}
```
- `mood`: str 必填 1–500 字，任意语言（中文实测 OK，LM 会 CoT 改写扩写）
- `seconds`: int 必填，仅接受 **30 | 45 | 60**（越界 422）
- `seed`: int 可选；省略则随机（响应中回传实际使用的 seed）
- 语义：纯器乐配乐（`[Instrumental]`），单次仅允许一个生成在跑（并发第二个请求 409）

真实响应样例（2026-11-21 实录）：
```json
{"id": "1a1fa11be98-31cc722c", "seconds": 45,
 "file": "E:\\Work\\X-Theater\\runtime\\acestep\\out\\1a1fa11be98-31cc722c.wav",
 "url": "/music/1a1fa11be98-31cc722c/file",
 "bytes": 17280088, "gen_seconds": 73.07, "model_seconds": 33.5, "warmup_seconds": 37.73,
 "seed": 20261122, "vram_peak_mb": 6864.4,
 "mood": "离别，钢琴主导的抒情曲，弦乐渐弱，克制的忧伤与祝福"}
```
- `gen_seconds` 含冷加载（首请求 ~45s 模型装载；热态 ≈ model_seconds + 2–5s CPU→GPU 回卡）
- `file` 为本机绝对路径（同机 worker 可直读）；跨机/通用取流用 `url`

### GET /music/{id}/file —— 取音频字节

```
GET /music/1a1fa11be98-31cc722c/file
→ 200, Content-Type: audio/wav, Content-Length: 17280088
```
404 = id 不存在；400 = id 非法字符。产物 WAV 规格：48kHz / 立体声 / 32bit float / 响度归一 -1dB。

### POST /unload —— 释放显存（幂等）

```json
→ {"ok": true, "cuda": true, "gpu": "NVIDIA GeForce RTX 5060 Ti", "vram_allocated_mb": 181.0,
   "vram_reserved_mb": 296.0, "vram_free_mb": 14826.0, "vram_total_mb": 16310.6, "vram_peak_mb": 6864.4}
```

### GET /health —— 状态探活

```json
{"service": "w-m-acestep", "version": "1.0.0", "port": 8190,
 "models_dir": "E:\\Work\\X-Theater\\runtime\\acestep\\models",
 "handler_ready": true, "lm_ready": true, "init_error": null, "gen_count": 2,
 "uptime_seconds": 431.0, "vram": {…同上字段…}}
```
错误语义：409 = 显存不足需先卸 ComfyUI（响应体带 `/free` 指引）/ 已有生成在跑；422 = seconds 非法；500 = 生成失败（含原因）；503 = 无 CUDA。

### worker 侧标准时序（显存互斥）

```
1. POST http://127.0.0.1:8188/free {"unload_models": true}   # 卸生图/视频模型
2. POST http://127.0.0.1:8190/music {mood, seconds, seed?}    # 同步等结果
3. （可选）GET http://127.0.0.1:8190/music/{id}/file          # 取字节
4. /music 响应即自动释放本服务显存（无需额外调用）
5. ComfyUI 可立即恢复生图工作流
```

---

## 7. 重启命令（服务当前保持运行 :8190）

```bash
# Git Bash / 任意 shell（venv 独立，与 E:\ComfyUI 零关联）
"E:/Work/X-Theater/runtime/acestep/venv/Scripts/python.exe" "E:/Work/X-Theater/runtime/acestep/server.py"
```

等价 CMD：`E:\Work\X-Theater\runtime\acestep\venv\Scripts\python.exe E:\Work\X-Theater\runtime\acestep\server.py`

- 日志：`E:\Work\X-Theater\runtime\acestep\server.log`（20MB 轮转 ×3）
- 健康探活：`GET http://127.0.0.1:8190/health`
- 冷启动幂等：服务进程本身零显存占用，模型在首个 /music 时装载（~40–45s），/unload 后下一请求自动重暖
- 权重根目录由 server.py 内置 `ACESTEP_CHECKPOINTS_DIR=E:\Work\X-Theater\runtime\acestep\models`，离线运行（HF_HUB_OFFLINE=1）不依赖外网

---

## 8. 遗留问题清单

1. **torchao 0.16.0 C++ 扩展与 torch 2.7.1 不兼容告警**（"Skipping import of cpp extensions"）：int8_weight_only 走纯 torch 实现路径，功能正常、速度略降。上游 flash-attn 无 cp312 win 轮子 → nano-vllm 强制 eager（LM 走 pt 后端本就不依赖）。若要解锁 int8 C++ 内核需 torch≥2.9 + torchao≥0.18 组合重构，属后续性能优化项，非功能阻塞。
2. **冷加载 37–45s**：每次进程冷启动首个 /music 慢（DiT bf16→int8 在线量化 + 4 组件装载 + constrained processor）。已在响应体拆分 `warmup_seconds` 供编排层感知；常驻进程下只有第一次慢。
3. **ComfyUI /free 空响应体**：返回 200 + 空 body，标准 JSON 客户端会报解析错（卸载实际生效）。编排层调用应以"忽略 body / 捕获后继续"处理，或以 nvidia-smi 复核。
4. **seed 复现性边界**：同 seed 同 mood 理论可复现，但 LM 采样含温度（0.85）且 constrained decoding 受 CUDA 版本影响，跨 torch 版本不保证逐比特复现——产品侧应将 seed 视作"倾向复现"而非"强复现"。
5. **mood→caption 为直通语义**：本服务不做 mood 词表映射，worker 传什么 caption 就是什么；LM CoT 会自动扩写风格/结构。若产品需要受控曲风词表（如固定 bpm/调式），可通过 `GenerationParams` 的 bpm/keyscale/cot_* 字段扩展（服务端已预留，未暴露到 HTTP 契约）。
6. **产物为 32bit float WAV（17.3MB/45s）**：若产品要 mp3 分发格式，可在 server.py 传 `audio_format="mp3"`（依赖已具备的 soundfile/ffmpeg 路径），当前按"保真优先"出 WAV。
7. **bytes 字段与 file 字段同时返回**：file 为绝对路径，跨机部署时该字段无意义，应以 url 为准（本机部署两者皆可用）。
8. **GameViewer.exe（网易）长期占卡**：与本服务无关但参与显存互斥预算（首轮采样 15871 MiB 高峰的成因之一），编排层做互斥决策时应把桌面进程计入。

## 附 · 证据文件清单（本目录）

- `w_m_release_45s_seed20261121.wav` / `w_m_parting_45s_seed20261122.wav` — 两次真生成产物（45.000s，非静音，sha256 各异）
- `evidence_run_20261121_014143.json` / `evidence_run_20261121_014715.json` — 完整采样序列（含响应体/下载比对/卸载后状态/mood/seed）
- `venv_freeze_key_deps.txt` — venv 关键依赖版本固化
- 服务端日志全文：`E:\Work\X-Theater\runtime\acestep\server.log`；HTTP 服务脚本：`E:\Work\X-Theater\runtime\acestep\server.py`；验证脚本：`E:\Work\X-Theater\runtime\acestep\work\verify_generation.py`
- 权重本体：`E:\Work\X-Theater\runtime\acestep\models\`（29 文件 9.4GB，布局即官方 checkpoints 布局）
