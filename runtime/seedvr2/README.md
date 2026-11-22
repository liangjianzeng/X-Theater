# runtime/seedvr2 — 成片超分（第二梯队⑥）

720×1280 → 1080×1920 交付档（红果/抖音 1080p 渐成门槛）。选型（2026-11 调研定档）：

| 方案 | 许可 | 显存 | 结论 |
|---|---|---|---|
| **SeedVR2-3B FP8（首选）** | Apache-2.0 | FP8+block swap 12–16GB | 5060 Ti 可跑；对 AI 生成纹理比 Topaz 更会"造" |
| SeedVR2-7B | Apache-2.0 | 24GB+ | 放 Spark/二期托管 |
| RIFE v4.6（帧率补齐搭档） | MIT | 2–4GB | 24→30fps 实时级（compose 升帧备选：ffmpeg minterpolate 已内建，默认关） |

## 落地路径（5060 Ti ComfyUI）

1. custom node：`ComfyUI-SeedVR2_VideoUpscaler`（FurkanGozukara 版，`custom_nodes/` git clone）
2. 权重：`bash dl_weights.sh`（ModelScope/hf-mirror 幂等下载 3B fp8 ≈ 8GB）
3. 模板登记：节点探活通过后，固化 `seedvr2-3b-fp8.json` 模板进 `runtime/templates/`＋manifest（四元组纪律），worker.superres 切真模板
4. 服务化：`server.py`（HTTP :8197+1→8199）或直接由 worker 走 ComfyUI 通道（THEATER_SUPERRES_URL 指向本服务）

在节点未装/权重未到位时，worker 探测 `/object_info` 无 SeedVR2 类 → 报 `NO_SEEDVR2_NODE` 真错误，绝不静默降级。
