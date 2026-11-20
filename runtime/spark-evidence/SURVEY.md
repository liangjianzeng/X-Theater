# DGX Spark 实机勘探记录（Phase 0）

- 日期：2026-11-21 04:00-04:10 (CST)
- 勘探人：ZCode 主会话（不开子智能体，用户指令）
- 连接：`/c/Windows/System32/OpenSSH/ssh.exe DgxSpark`（= jianzengliang@100.81.83.59，Tailscale tailfe4bdd.ts.net，nvsync.key 免密）
  - Git Bash 自带 ssh 解析不了 Windows config 的 Include，必须用 Windows OpenSSH 全路径

## 1. 硬件与系统

| 项 | 值 |
|---|---|
| 主机 | gx10-85f3（DGX GX10 / Spark，ASUS 版） |
| 内核 | 7.0.0-1025-nvidia，Ubuntu 24.04 LTS aarch64 |
| GPU | NVIDIA GB10，驱动 580.178.04，**CUDA 13.0**，Persistence On |
| 统一内存 | 121GB（Total VRAM 124544MB，DynamicVRAM 支持 ✅） |
| 磁盘 | 内置 NVMe 916G（已用 333G，**余 536G**）；外置 SSD /mnt/models-ssd（/dev/sda1，systemd automount，TB4 级 ~1.2GB/s，372G，root 所有不放新文件） |
| Python | ComfyUI venv：Python 3.12.3，**torch 2.12.1+cu130**（int8_convrot 要求满足） |

## 2. 共宿主服务（纪律：绝不可动）

- 监听端口（勘探时）：22, 53, 2222, **3080(open-webui)**, 3350, 3389, 5201, 8080, 9230, 11000, 17670, 45893, 55319, 64038
- datongxiaoyi 生产（:3001/:8000/:5001）与 llama-server（:8085/8088/8089）**当前未监听**（停着）——但仍不得 pkill/改动其文件
- 端口约定：ComfyUI 用 **8188**（原 Spark 侧已用此端口跑过 LTX，无冲突）

## 3. ComfyUI 与权重库现状

- **ComfyUI v0.45.0-40-g1e719279f**（≥0.39，H3 全特性齐：多帧参考/稀疏注意力/FastH3/light VAE）
- 位置 `~/ComfyUI`（venv 3.12），custom nodes 此前仅 ComfyUI-LTXVideo；本次新增 `ComfyUI-Open-H3-Regenerate-2K`（1038lab，吃 ComfyUI 已加载 MODEL，精修 LoRA 放 `models/loras/minmax/`）
- `~/ComfyUI/models` 原为符号链接 → `/mnt/models-ssd/ComfyUI/models`；**迁移脚本（migrate_hot_to_nvme.sh）已把它替换为 NVMe 真目录**：热集拷入 NVMe、冷集软链回 SSD

### 权重台账（勘探时点 → 迁移后）

| 文件 | 大小 | 原位置 | 迁移后 |
|---|---|---|---|
| minimax_h3_fl2va_pruned_int8_convrot | 20G | SSD | **NVMe 热集** |
| minimax_h3_ref2va_pruned_int8_convrot | 20G | SSD（本次 ModelScope 新下载） | **NVMe 热集** |
| minimax_h3_image_pruned_int8_convrot | 20G | SSD（h3-eval 软链） | **NVMe 热集** |
| qwen3vl_32b_minimax_h3_nvfp4_awq (TE，视频/图共用) | 15G | SSD（h3-eval 软链） | **NVMe 热集** |
| qwen3.5_9b_w4a8_gptq (H3-Image TE) | 6.9G | SSD（本次新下载） | **NVMe 热集** |
| video VAE fp16 + audio VAE fp32 + image VAE fp16 | 4.9G+578M+1.1G | SSD | **NVMe 热集** |
| fl2v turbo LoRA 4step/8step + ref2v turbo 4step | 1.9G×3 | SSD（ref2v 本次新下载） | **NVMe 热集** |
| LTX-2.5 全套（TE+DiT+VAE×2） | ~30G | SSD | 冷集（软链） |
| Music3-Comfy、Qwen3.8-Flash-FP4(96G)、DeepSeek、Ornith、TongYi 等 | — | SSD | 冷集（软链） |
| regen2k 精修件（open_h3_regenerate_2k 8.8G / r128 2.0G / sharp_curve 1.24G / latent_upscaler 0.69G / fast VAE 6.47G） | — | hf-mirror（1038lab/Open-H3-Regenerate-2K） | 下载中 → **NVMe** |

### 下载通道
- ModelScope 直链（`resolve/master`，实测 ~40MB/s）：Comfy-Org/MiniMax-H3 与 Comfy-Org/MiniMax-H3-Image 全量镜像
- hf-mirror.com：1038lab/Open-H3-Regenerate-2K（Spark 直连 HF API 不稳）

## 4. 运行脚本（部署产物）

| 脚本 | 位置 | 用途 |
|---|---|---|
| start_comfyui.sh | Spark `~/start_comfyui.sh` | 幂等启动（pidfile + 端口占用兜底，绝不杀别人进程），`--port 8188 --listen 0.0.0.0` |
| dl_h3.sh | Spark `~/dl_h3.sh` | H3 视频三件下载（已完成） |
| migrate_hot_to_nvme.sh | Spark `~/migrate_hot_to_nvme.sh` | 热权重 SSD→NVMe（执行中） |
| dl_h3_regen2k.sh | Spark `~/dl_h3_regen2k.sh` | regen2k 组件下载（迁移完成后自动接力） |

本地留档：`E:\Work\X-Theater\runtime\spark-evidence\`（四个脚本源码 + 本文件）

## 5. 连通性验证

- Windows → `http://100.81.83.59:8188/system_stats`：**HTTP 200** ✅（comfyui_version 0.45.0，ram_free ~104GB）
- `/free` 端点：POST 带 JSON body `{"unload_models":true,"free_memory":true}` → **200** ✅（空 body 500 为预期行为）

## 6. 存储与内存纪律（用户 2026-11-21 指令）

1. **热权重集中内置 NVMe**：外置 SSD 经不起频繁加载；频繁加载的模型挪回主硬盘（已完成迁移脚本化）
2. **内存常驻优先**：121GB 统一内存够单套组合（~50GB 峰值）常驻；同模板族连续出片**不重复加载、不 /free**；仅跨模板族切换或 `ram_free` 低于预留阈值（几 GB）时才释放——Phase 4 worker 按此实现，与 5060 Ti 的强制前后 /free 策略区分
3. 冷权重（Qwen3.8 等）留在 SSD，用软链挂进 ComfyUI models 目录（ComfyUI 递归扫描支持软链，已有先例）

## 7. 遗留决定

- TE int8_convrot (27G) 暂不下（nvfp4_awq 已可用；AB 需要时再拉）
- nvfp4 diffusion 权重（社区 Abiray/DmitryDB）待 Phase 5 AB 时下载（Blackwell GB10 可跑）
- H3-Context-IR 本地复刻待 Phase 4（h3ir.js，LLM 复用 Spark 侧 llama-server 或降级规则拼装）
