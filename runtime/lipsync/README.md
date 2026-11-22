# runtime/lipsync — 口型重绘服务（第二梯队⑤）

对拍完的 take + 台词配音音轨做口型重绘，产出「口型与配音对齐」的新 take。
剧场侧车道：`lipsync`（worker.lipsync.js），真引擎开关 `THEATER_LIPSYNC_URL=http://127.0.0.1:8196`。

## 选型（2026-11 调研定档）

| 方案 | 许可 | 显存 | 结论 |
|---|---|---|---|
| **EchoMimicV3-Flash（首选）** | Apache-2.0（代码+权重） | 12GB | 5060 Ti 直接跑，8 步采样最快 |
| LatentSync 1.5（备选） | Apache-2.0（repo LICENSE）；⚠ ADR 白名单注：两处 license 表述不一致，**仅一期调测档，商用链路禁入** | 8GB | 中文口碑好 |
| Sonic | CC BY-NC-SA **禁商用** | — | 排除 |

## 启动

```bash
cd runtime/lipsync
python -m venv venv && venv/Scripts/python -m pip install -r requirements.txt
# 权重（幂等）：bash dl_weights.sh  （ModelScope/hf-mirror 双通道）
venv/Scripts/python server.py --port 8196
```

- API：`POST /lipsync {video, audio, text?}` → mp4 字节（≤10s 分段；4090 实测约 4-8 倍实时，5060 Ti 预留 2-6 分钟/镜）。
- 健康检查：`GET /health`。
- 未装权重时启动即退出（诚实失败，不降级造假）。
