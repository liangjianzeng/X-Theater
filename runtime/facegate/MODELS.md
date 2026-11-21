# 本地模型权重留档（git 不入库）

> 2026-11-21 起 `*.onnx`、`buffalo_l.zip`、`__pycache__/` 进 `.gitignore`（单文件超 GitHub 100MB 硬限，push 会被拒）。
> 权重本体留在本机原位，过程产物不删；本清单即其账。

| 文件 | 大小 | 用途 | 来源 |
| --- | --- | --- | --- |
| `runtime/facegate/models/inswapper_128.onnx` | 554,253,681 B | facegate 服务（runtime/facegate/server.py）：参考脸换装/换脸用于保脸对照证据链 | insightface inswapper_128 公开权重 |
| `runtime/spark-evidence/facegate/inswapper_128.onnx` | 554,253,681 B | 同上（spark 证据目录副本，face-swap 对照实验） | 同上 |
| `runtime/spark-evidence/facegate/buffalo_l.zip` | 288,621,354 B | insightface buffalo_l 人脸检测/识别模型包（facegate 的 det/rec 前置） | insightface buffalo_l 公开权重 |

## 复现/装载

- facegate 服务：`runtime/facegate/server.py`（加载 `models/inswapper_128.onnx` ＋解包 `buffalo_l.zip`）
- 证据页：`runtime/spark-evidence/facegate/scores.json`、`cand_*.png`、`vframe_*.jpg`（已入库，git 可查）

## 纪律

- 任何 >100MB 单文件不得 `git add`；新增权重先在此登记再落盘。
- 证据图/JSON/mp4（小体积）一律入库，代码仓可追溯。
