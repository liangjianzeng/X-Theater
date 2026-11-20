# W-B 配音服务（CosyVoice2-0.5B :9880）EVIDENCE

日期：2026-11-21　机器：RTX 5060 Ti 16G（driver 610.60）／Windows 11 + WSL2 Ubuntu-22.04
服务：`E:\Work\X-Theater\runtime\cosyvoice\server.py`（实际运行于 WSL，经 localhost 转发对 Windows 暴露 127.0.0.1:9880）
状态：服务运行中（pid 见 `logs/server.pid`），惰性加载，响应后自动卸载模型权重。

---

## 1. 路线选择与理由

**结论：WSL2 路线（Ubuntu-22.04 + python3.10 venv）。原生 Windows venv 探针失败。**

- 原生探针（uv venv @ `runtime/cosyvoice/native-probe-venv`，python 3.13）：
  `pip install pynini` 无 Windows wheel、走 sdist 编译，MSVC `cl.exe` 直接报错
  `error D8021: 无效的参数"/Wno-register"`（OpenFst 源码带 GCC 专有编译参数，MSVC 不认）。
  完整日志：`native-venv-pynini-fail.log`。即原生路线必须过 pynini/OpenFst 编译关，与已知痛点一致。
- 注意：当前 CosyVoice 仓库 main 的 requirements 已含 `wetext==0.0.4`（免 pynini 的 TN 前端），但 WSL 路线
  仍因以下原因被选定：python3.10 与官方 conda 版本一致、linux wheel 生态齐全、CUDA 直通可用
  （WSL 内 `nvidia-smi` 正常，torch 2.8.0+cu128 实算通过，capability (12,0)=sm_120）。
- WSL 内 github 直连实际可用（git clone --recursive 成功，含 Matcha-TTS 子模块）；pip 全程走阿里云镜像。
- 权重下载走 ModelScope（`modelscope download --model iic/CosyVoice2-0.5B --include ...`，1.40.3）。

**重要环境事实：**
- 模型从 /mnt/e（9p/drvfs）读取大 .pt 曾出现读停摆（io 冻结），且 9p 加载慢（>5min 未完成）。
  最终方案：E: 盘为登记副本，服务副本放 WSL ext4（`~/xtheater-cosyvoice/models`），加载 8-25s。
- 服务器后台化必须 `setsid nohup ... &`，否则 wsl.exe 会话退出会杀掉进程（已入 start.sh）。
- Windows→WSL：WSL2 localhost 转发生效（Windows `netstat` 显示 wslrelay 监听 127.0.0.1:9880），产品 worker 直调 `http://127.0.0.1:9880` 无需任何额外配置。

## 2. 权重台账（iic/CosyVoice2-0.5B）

登记副本：`E:\Work\X-Theater\runtime\cosyvoice\models\CosyVoice2-0.5B\`（ModelScope 下载，仅取推理所需文件）
服务副本：`~/xtheater-cosyvoice/models/CosyVoice2-0.5B\`（WSL ext4，字节一致核验通过）

| 文件 | 字节 |
|---|---:|
| llm.pt | 2,023,316,821 |
| CosyVoice-BlankEN/model.safetensors | 988,097,824 |
| speech_tokenizer_v2.onnx | 496,082,973 |
| flow.pt | 450,575,567 |
| hift.pt | 83,390,254 |
| campplus.onnx | 28,303,423 |
| CosyVoice-BlankEN/vocab.json | 2,776,833 |
| CosyVoice-BlankEN/merges.txt | 1,402,109 |
| README.md | 11,556 |
| cosyvoice2.yaml | 7,330 |
| CosyVoice-BlankEN/tokenizer_config.json | 1,287 |
| CosyVoice-BlankEN/config.json | 659 |
| CosyVoice-BlankEN/generation_config.json | 242 |
| configuration.json | 47 |
| **合计** | **4,073,966,925 (3.79 GB)** |

与 ModelScope API 清单逐文件字节一致。跳过项：flow.cache.pt / flow.encoder.*.zip / flow.decoder.estimator.fp32.onnx / speech_tokenizer_v2.batch.onnx（JIT/TRT/批量变体，fp32 torch 推理不需要）。

注册产物：`spk2info.pt`（60,190B，WSL 模型目录内，证据副本 `spk2info_registered.pt`）——默认音色「中文女」，
由官方 `asset/zero_shot_prompt.wav`（实测 F0 中位 266.7Hz=女声；cross_lingual_prompt.wav 为男声 149Hz 落选）
+ 官方示例文本「希望你以后能够做的比我还好呦。」经 `add_zero_shot_spk` 注册。

代码仓：`~/xtheater-cosyvoice/CosyVoice`（FunAudioLLM/CosyVoice main@074ca6d，含 third_party/Matcha-TTS）。
venv：`~/xtheater-cosyvoice/venv`（python 3.10.12）。
关键版本：torch 2.8.0+cu128（5060 Ti sm_120 实算通过）、torchaudio 2.8.0、transformers 4.51.3、
wetext 0.0.4（TN，免 pynini）、onnxruntime-gpu 1.18.0（CUDA EP 创建失败自动纯 CPU，见遗留）、
hydra-core 1.3.2、lightning 2.2.4、setuptools 80.9.0（>=81 无 pkg_resources，lightning/whisper 需要）、
openai-whisper 20231117、numpy 1.26.4。

## 3. 显存账（与 ComfyUI(:8188)/ACE-Step(:8190) 互斥）

基线（ComfyUI 空闲、已 POST /free）：**231 MB**
模型常驻（load 完成待合成）：**2,450 MB**（torch allocated）
合成峰值（nvidia-smi 主机侧）：**3,204 MB**（官方验证跑 03:09:02；torch max_memory_allocated=2,545 MB）
响应后自动卸载（keep_loaded 缺省 false）：**464 MB**（模型权重全释放；余 ~233MB 为该 WSL 进程 CUDA 上下文常驻，
进程退出才归零——给 ComfyUI 15GB 级任务留足余量）

nvidia-smi 2s 采样：`vram_trace3.csv`（官方验证跑）及 vram_trace*.csv（调试期全过程）。
调用 ComfyUI 的卸载：合成前 `POST http://127.0.0.1:8188/free {"unload_models":true,"free_memory":true}`（实测 200，14.3GB→755MB）。

## 4. API 契约（127.0.0.1:9880，Windows 侧直调）

```
POST /tts            {text, speaker?, prompt_wav?, prompt_text?, speed?, keep_loaded?}
GET  /tts/{id}/file  -> audio/wav (24kHz mono PCM_16)
POST /unload         -> {ok, vram_used_mb_before, vram_used_mb_after}
GET  /health         -> {service, loaded, device, gpu, vram_used_mb, sample_rate, available_speakers, load_ms, last_error, ...}
```

真实请求/响应样例（官方验证跑，证据文件 `tts_resp1.json`）：

```json
POST /tts {"text": "雨夜的灯塔，是我和过去和解的地方。"}
→ 200 {
  "id": "4cb795d0aacf",
  "seconds": 3.64,
  "file": "E:\\Work\\X-Theater\\runtime\\cosyvoice\\out\\4cb795d0aacf.wav",
  "sample_rate": 24000,
  "mode": "sft_cached",          // 已注册音色走缓存声学提示
  "speaker": "中文女",
  "synth_ms": 2406.9,            // 纯合成（不含加载）
  "load_ms": 8356.0,             // 首次/重新加载耗时（0 表示复用常驻）
  "vram_peak_mb": 2545.4
}
```

- 默认「中文女」；`speaker` 可传已注册音色名；zero-shot 复刻参数位：`prompt_wav`（wav 路径，WSL/挂载路径均可）+ `prompt_text`。
- `keep_loaded:true` 可保留模型常驻（批量生成用）；缺省响应即释放显存。
- 幂等性：同文本同音色输出字节级一致（两次独立请求产物 174,764B 完全相同）——适合确定性回归。
- 延迟参考（RTF 实测 ~0.5-0.7）：一次短句 ≈ load(8-25s 冷) + synth(1.9-2.6s)。
  批量场景建议首请求带 keep_loaded:true，尾请求 POST /unload。
- 音色 F0 核验：产物 `artifacts/tts_line_rainy_night_lighthouse.wav`（24kHz/3.64s）F0 中位 240Hz → 中文女声。

## 5. 重启命令（Windows 侧 Git Bash）

```bash
# 停止
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/Work/X-Theater/runtime/cosyvoice/wsl/stop.sh
# 启动（幂等；内含 LD_LIBRARY_PATH/setsid/nohup 与 pid 管理）
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-22.04 -- bash /mnt/e/Work/X-Theater/runtime/cosyvoice/wsl/start.sh
# 健康检查（Windows 直调）
curl http://127.0.0.1:9880/health
```

注意：`wsl.exe` 传参会被 MSYS 路径转换改写，命令必须带 `MSYS_NO_PATHCONV=1`。
日志：`runtime/cosyvoice/logs/server.log`。

## 6. 遗留问题

1. **onnxruntime-gpu 1.18 CUDA EP 在本组合下创建失败**（cudnn 版本组合告警），已强制纯 CPU。
   speech tokenizer 只在音色注册/zero-shot 提示编码时使用（3-10s 音频 ≈ 秒级），不影响常规合成延迟。
   后续可升级 onnxruntime-gpu 至与 cu128 匹配的版本以启用 GPU EP。
2. **/mnt/e 9p 读大文件曾停摆**（io 冻结 >5min，两次服务卡死均发生在该配置下）；已改 ext4 服务副本规避。
   E: 登记副本不要被服务直接消费。
3. **卸载后残留 ~233MB CUDA 上下文**（进程存活期间无法归零）；对 16GB 卡与 ComfyUI 15GB 级任务无实际影响。
4. torch 2.8.0+cu128 在 sm_120 上部分算子走 JIT（`~/.nv/ComputeCache` 已缓存，二次加载无惩罚）；
   首次冷加载+合成实测 46s+16s，缓存生效后 8-25s+2s。
5. ComfyUI 侧 qwen-image 任务在验证期间与本项目并发抢占过显存（trace2 02:44 窗口 13.5GB），
   显存互斥流程（先 /free）必须保留在产品 worker 的调用纪律中。
6. 当前仓库 main 为 Fun-CosyVoice3 演进版；CosyVoice2 类仍完整支持（本部署即证），
   但官方 CosyVoice2 示例代码（传 tensor）与现仓库 frontend（传路径）存在 API 漂移，server.py 已适配为路径入参。

## 7. 产物清单（runtime/cosyvoice-evidence/）

- `artifacts/tts_line_rainy_night_lighthouse.wav` — 官方验证台词产物（=out/4cb795d0aacf.wav）
- `artifacts/fea8189f9984.wav` — 最终冒烟产物（同文本，字节一致）
- `tts_resp1.json` / `tts_resp2.json` — 契约响应样例（unload 前后两次）
- `vram_trace*.csv` — nvidia-smi 2s 采样（调试全程 + 官方验证跑）
- `native-venv-pynini-fail.log` — 原生路线失败证据（cl.exe D8021）
- `spk2info_registered.pt` — 「中文女」音色注册表副本
- `server_run.log` — 服务运行日志副本
