# runtime/sfx — 音效拟音服务（第二梯队⑦）

文本→音效（T2SFX）/视频→音效（V2A）事件级拟音。产物入 `asset_lib.audio.sfx`，采纳后经
compose ambience 同通道混入。剧场侧车道：`sfx`（worker.sfx.js），真引擎开关
`THEATER_SFX_URL=http://127.0.0.1:8197`。

## 选型（2026-11 调研定档）

| 方案 | 许可 | 结论 |
|---|---|---|
| **Stable Audio Open 1.0（首选）** | Stability Community License：年营收 <$1M 可商用 | T2SFX 合规首选，~6-8GB |
| MMAudio | 代码 MIT，**权重 CC-BY-NC 禁商用** | 仅预览用；商用走 API |
| 可灵 Kling-Foley / ElevenLabs SFX | 商用 API | 二期商业化精修档（BYOK/直购） |

## 启动

```bash
cd runtime/sfx
python -m venv venv && venv/Scripts/python -m pip install -r requirements.txt
bash dl_weights.sh
venv/Scripts/python server.py --port 8197
```

- API：`POST /sfx {prompt, seconds≤47}` → wav 字节；`GET /health`。
- 未装权重时启动即退出（诚实失败）。
