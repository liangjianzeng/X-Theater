# -*- coding: utf-8 -*-
"""W-B 配音服务 (CosyVoice2-0.5B) — 127.0.0.1:9880
惰性加载：首个 /tts 才加载模型；响应后默认释放显存（显存与 ComfyUI(:8188)/ACE-Step(:8190) 互斥）。
运行环境：WSL2 Ubuntu-22.04 (~/xtheater-cosyvoice/venv)，GPU 经 /usr/lib/wsl/lib 直通。
契约:
  POST /tts {text, speaker?, prompt_wav?, prompt_text?, speed?, keep_loaded?} -> {id, seconds, file, ...}
  GET  /tts/{id}/file -> audio/wav
  POST /unload -> {ok, ...}
  GET  /health -> {loaded, ...}
"""
import gc
import faulthandler
import os
import sys
import time
import uuid
import threading

faulthandler.enable()

import numpy as np
import torch
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

# ---------------------------------------------------------------- paths
E_BASE = "/mnt/e/Work/X-Theater/runtime/cosyvoice"
REPO = os.path.expanduser("~/xtheater-cosyvoice/CosyVoice")
# 服务副本放 WSL ext4（/mnt/e 9p 读大文件慢且曾出现读停摆）；E: 侧为登记副本
MODEL_DIR = os.path.expanduser("~/xtheater-cosyvoice/models/CosyVoice2-0.5B")
OUT_DIR = os.path.join(E_BASE, "out")
LOG_DIR = os.path.join(E_BASE, "logs")
WIN_BASE = "E:\\Work\\X-Theater\\runtime\\cosyvoice"
PROMPT_WAV = os.path.join(REPO, "asset", "zero_shot_prompt.wav")  # F0 median 266.7Hz -> female
PROMPT_TEXT = "希望你以后能够做的比我还好呦。"  # official prompt transcript (model card)
DEFAULT_SPK = "中文女"
HOST, PORT = "127.0.0.1", 9880

for p in (REPO, os.path.join(REPO, "third_party", "Matcha-TTS")):
    if p not in sys.path:
        sys.path.insert(0, p)
os.makedirs(OUT_DIR, exist_ok=True)

# onnxruntime: 强制纯 CPU——CUDA EP 在 ORT 1.18 与 torch cu128 组合下创建失败
# 且曾诱发进程内 libcuda JIT 死锁（nvcubins.bin 停在读位置、全线程 futex_wait）。
# speech tokenizer 只在注册音色时用一次（3-10s prompt），CPU 耗时可接受。
import onnxruntime as _ort  # noqa: E402

_orig_is = _ort.InferenceSession.__init__

def _cpu_only_init(self, *a, **kw):
    kw["providers"] = ["CPUExecutionProvider"]
    return _orig_is(self, *a, **kw)

_ort.InferenceSession.__init__ = _cpu_only_init

from cosyvoice.cli.cosyvoice import CosyVoice2  # noqa: E402

app = FastAPI(title="W-B CosyVoice2 TTS", version="1.0.0")

_S = {
    "engine": None,
    "lock": threading.RLock(),  # 可重入: load_engine 失败路径会嵌套调用 unload_engine
    "load_ms": None,
    "last_error": None,
}


def _win_path(wsl_path: str) -> str:
    rel = os.path.relpath(wsl_path, E_BASE)
    return os.path.join(WIN_BASE, rel).replace("/", "\\")


def unload_engine():
    """释放全部模型与显存（可重复调用）。"""
    with _S["lock"]:
        eng = _S["engine"]
        if eng is not None:
            try:
                del eng.model
                del eng.frontend
            except AttributeError:
                pass
            _S["engine"] = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()


def load_engine() -> tuple:
    """惰性加载 CosyVoice2-0.5B + 注册默认中文女声（spk2info.pt 缓存）。返回 (engine, load_ms)。"""
    t0 = time.time()
    with _S["lock"]:
        if _S["engine"] is not None:
            return _S["engine"], 0.0
        try:
            # 卡死自诊断: 加载超过 180s 则每 180s 向 stderr(日志) dump 全线程栈
            faulthandler.dump_traceback_later(180, repeat=True)
            # 先建 torch CUDA 上下文并预热，避免模型加载路径上的首次 JIT 与其他库纠缠
            if torch.cuda.is_available():
                _warm = torch.zeros(8, 8, device="cuda")
                _warm = (_warm @ _warm).sum().item()
                del _warm
            eng = CosyVoice2(MODEL_DIR, load_jit=False, load_trt=False, load_vllm=False, fp16=False)
            if DEFAULT_SPK not in eng.frontend.spk2info:
                prompt = load_wav(PROMPT_WAV, 16000)
                eng.add_zero_shot_spk(PROMPT_TEXT, prompt, DEFAULT_SPK)
                eng.save_spkinfo()  # 写 model_dir/spk2info.pt，下次启动免注册
            _S["engine"] = eng
            faulthandler.cancel_dump_traceback_later()
            _S["load_ms"] = round((time.time() - t0) * 1000, 1)
            _S["last_error"] = None
            return eng, _S["load_ms"]
        except Exception as e:  # noqa: BLE001
            _S["last_error"] = f"{type(e).__name__}: {e}"
            faulthandler.cancel_dump_traceback_later()
            unload_engine()
            raise


class TTSReq(BaseModel):
    text: str
    speaker: str = DEFAULT_SPK
    # zero-shot 复刻参数位：给 prompt_wav(+prompt_text) 则忽略 speaker
    prompt_wav: str | None = None
    prompt_text: str | None = None
    speed: float = 1.0
    keep_loaded: bool = False  # 默认响应后释放显存


@app.post("/tts")
def tts(req: TTSReq):
    if not req.text or not req.text.strip():
        raise HTTPException(400, "text is empty")
    try:
        eng, load_ms = load_engine()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"model load failed: {_S['last_error'] or e}")

    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()

    t1 = time.time()
    try:
        if req.prompt_wav:
            if not req.prompt_text:
                raise HTTPException(400, "prompt_wav requires prompt_text (zero-shot)")
            if not os.path.isfile(req.prompt_wav):
                raise HTTPException(400, f"prompt_wav not found: {req.prompt_wav}")
            # 当前仓库 frontend 内部自行 load_wav(16000/24000)，入参为文件路径
            gen = eng.inference_zero_shot(req.text.strip(), req.prompt_text.strip(), req.prompt_wav,
                                          stream=False, speed=req.speed)
            mode = "zero_shot"
        else:
            if req.speaker not in eng.frontend.spk2info:
                raise HTTPException(404, f"speaker {req.speaker!r} not registered; "
                                         f"available={eng.list_available_spks()}")
            # 已注册音色走缓存条目（add_zero_shot_spk 产物含声学提示，inference_sft 不兼容）
            gen = eng.inference_zero_shot(req.text.strip(), "", PROMPT_WAV,
                                          zero_shot_spk_id=req.speaker,
                                          stream=False, speed=req.speed)
            mode = "sft_cached"
        chunks = [o["tts_speech"] for o in gen]
    except HTTPException:
        if not req.keep_loaded:
            unload_engine()
        raise
    except Exception as e:  # noqa: BLE001
        if not req.keep_loaded:
            unload_engine()
        raise HTTPException(500, f"synthesis failed: {type(e).__name__}: {e}")

    audio = torch.cat(chunks).squeeze(0).cpu().numpy()
    sr = eng.sample_rate
    synth_ms = round((time.time() - t1) * 1000, 1)
    seconds = round(audio.shape[0] / sr, 3)

    sid = uuid.uuid4().hex[:12]
    wav_path = os.path.join(OUT_DIR, f"{sid}.wav")
    sf.write(wav_path, audio, sr, subtype="PCM_16")

    peak_mb = None
    if torch.cuda.is_available():
        peak_mb = round(torch.cuda.max_memory_allocated() / 1048576, 1)

    if not req.keep_loaded:
        unload_engine()

    return {
        "id": sid,
        "seconds": seconds,
        "file": _win_path(wav_path),
        "sample_rate": sr,
        "mode": mode,
        "speaker": req.speaker if not req.prompt_wav else "zero_shot",
        "synth_ms": synth_ms,
        "load_ms": load_ms,
        "vram_peak_mb": peak_mb,
    }


@app.get("/tts/{sid}/file")
def tts_file(sid: str):
    if len(sid) != 12 or any(c not in "0123456789abcdef" for c in sid):
        raise HTTPException(400, "bad id")
    path = os.path.join(OUT_DIR, f"{sid}.wav")
    if not os.path.isfile(path):
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="audio/wav", filename=f"{sid}.wav")


@app.post("/unload")
def unload():
    before = _vram()
    unload_engine()
    return {"ok": True, "vram_used_mb_before": before, "vram_used_mb_after": _vram()}


def _vram():
    try:
        out = os.popen("nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits").read().strip()
        return float(out.splitlines()[0]) if out else None
    except Exception:  # noqa: BLE001
        return None


@app.get("/health")
def health():
    eng = _S["engine"]
    d = {
        "service": "w-b-cosyvoice2",
        "loaded": eng is not None,
        "device": "cuda" if torch.cuda.is_available() else "cpu",
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "vram_used_mb": _vram(),
        "sample_rate": eng.sample_rate if eng else None,
        "available_speakers": eng.list_available_spks() if eng else [],
        "load_ms": _S["load_ms"],
        "last_error": _S["last_error"],
    }
    if eng is not None and torch.cuda.is_available():
        d["vram_allocated_mb"] = round(torch.cuda.memory_allocated() / 1048576, 1)
        d["vram_reserved_mb"] = round(torch.cuda.memory_reserved() / 1048576, 1)
    return d


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, workers=1, log_level="info")
