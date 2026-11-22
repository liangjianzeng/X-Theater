# -*- coding: utf-8 -*-
"""
W-M 自部署生乐服务（ACE-Step 1.5）· FastAPI 常驻服务
端口 127.0.0.1:8190 · 惰性加载 · 响应后释放显存（DiT/VAE/TE/LM 全部回 CPU RAM + empty_cache）

API 契约:
  POST /music            {mood, seconds 15-180, seed?, tags?, lyrics?, instrumental?, caption?, bpm?} -> {id, seconds, file, ...}
  GET  /music/{id}/file  -> 音频字节 (audio/wav)
  POST /unload           -> 释放显存 {ok, vram_*}
  GET  /health           -> 服务/模型/显存状态
"""

import os
import sys
import time
import uuid
import gc
import threading
from pathlib import Path

# ---- 环境变量必须在 import acestep / torch 之前设置 ----
BASE_DIR = Path(__file__).resolve().parent
REPO_DIR = BASE_DIR / "acestep-repo"
MODELS_DIR = BASE_DIR / "models"
OUT_DIR = BASE_DIR / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)

os.environ["ACESTEP_CHECKPOINTS_DIR"] = str(MODELS_DIR)
os.environ["ACESTEP_DISABLE_TQDM"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["HF_HUB_OFFLINE"] = "1"          # 全部本地权重，禁止外网补拉
os.environ["TRANSFORMERS_OFFLINE"] = "1"
# ModelScope 为首选权重源；这里模型已就位，禁掉多余的网络探测
os.environ["MODELSCOPE_CACHE"] = str(BASE_DIR / "work" / "modelscope_cache")

sys.path.insert(0, str(REPO_DIR))

import torch                                    # noqa: E402
from fastapi import FastAPI, HTTPException      # noqa: E402
from fastapi.responses import FileResponse      # noqa: E402
from pydantic import BaseModel, Field           # noqa: E402
import uvicorn                                  # noqa: E402

from loguru import logger                       # noqa: E402

logger.remove()
logger.add(sys.stderr, level="INFO",
           format="<green>{time:HH:mm:ss.SSS}</green> | <level>{level: <7}</level> | {message}")
LOG_FILE = BASE_DIR / "server.log"
logger.add(LOG_FILE, level="INFO", rotation="20 MB", retention=3,
           format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <7} | {message}")

# ---- ACE-Step 推理入口 ----
from acestep.handler import AceStepHandler                 # noqa: E402
from acestep.llm_inference import LLMHandler               # noqa: E402
from acestep.inference import (                            # noqa: E402
    GenerationParams, GenerationConfig, generate_music,
)

# ---- 服务初始化参数（档位纪律：int8 量化 DiT，全组件 CPU offload，16GB 卡安全档） ----
INIT = dict(
    project_root=str(REPO_DIR),
    config_path="acestep-v15-turbo",       # DiT: 4.79GB bf16 权重，8 步蒸馏，官方无更低位档文件（torchao int8 加载时量化）
    device="cuda",
    use_flash_attention=False,             # win/cp312 无 flash-attn 轮子，SDPA 兜底
    compile_model=False,                   # 不做 torch.compile（triton-windows 仅 cp311；避免首次编译墙）
    offload_to_cpu=True,                   # VAE/TE/LM 用完即回 CPU（官方 _load_model_context 机制）
    offload_dit_to_cpu=False,              # DiT 初始化后驻卡 int8(~2.4G)；每次响应后由本服务手动卸回 CPU
    quantization="int8_weight_only",       # torchao INT8 weight-only：nvfp4/int8 官方无现成量化文件 → 运行时 int8 为最高可得档
    use_mlx_dit=False,                     # 仅 Apple Silicon
)
LM_INIT = dict(
    lm_model_path="acestep-5Hz-lm-1.7B",   # tier5/6a 推荐 LM；bf16 3.45GB
    backend="pt",                          # 确定性选择：pt 后端 + offload_to_cpu=True 推理时进卡、结束自动回 CPU + empty_cache
    device="cuda",
    offload_to_cpu=True,
    dtype=torch.bfloat16,
)

VALID_SECONDS = (30, 45, 60)

app = FastAPI(title="W-M ACE-Step 1.5 music service", version="1.0.0")

_state = {
    "handler": None,
    "llm": None,
    "handler_ready": False,
    "lm_ready": False,
    "init_error": None,
    "started_at": time.time(),
    "gen_count": 0,
}
_init_lock = threading.Lock()
_gen_lock = threading.Lock()


def _vram_stats() -> dict:
    if not torch.cuda.is_available():
        return {"cuda": False}
    free_b, total_b = torch.cuda.mem_get_info()
    return {
        "cuda": True,
        "gpu": torch.cuda.get_device_name(0),
        "vram_allocated_mb": round(torch.cuda.memory_allocated() / 1024**2, 1),
        "vram_reserved_mb": round(torch.cuda.memory_reserved() / 1024**2, 1),
        "vram_free_mb": round(free_b / 1024**2, 1),
        "vram_total_mb": round(total_b / 1024**2, 1),
        "vram_peak_mb": round(torch.cuda.max_memory_allocated() / 1024**2, 1),
    }


def _release_gpu_vram() -> dict:
    """响应后释放显存：DiT/VAE/TE/silence_latent 全部卸回 CPU RAM，LM 确认在 CPU，empty_cache。
    权重保留在 RAM（offload 模式常驻），下次请求秒级回卡，无需重读磁盘。"""
    handler, llm = _state["handler"], _state["llm"]
    if handler is not None:
        for attr in ("model", "vae", "text_encoder"):
            comp = getattr(handler, attr, None)
            if comp is not None:
                try:
                    comp.to("cpu")
                except Exception as exc:
                    logger.warning(f"[release] {attr}.to(cpu) failed: {exc}")
        if getattr(handler, "silence_latent", None) is not None:
            handler.silence_latent = handler.silence_latent.to("cpu")
    if llm is not None and llm.llm is not None:
        try:
            if next(llm.llm.parameters()).device.type != "cpu":
                llm.llm.to("cpu")
        except StopIteration:
            pass
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
    logger.info(f"[release] VRAM released -> {_vram_stats()}")
    return _vram_stats()


def _ensure_models() -> float:
    """惰性加载：DiT(int8) + VAE + TE + LM。返回本次加载耗时（已加载则 0）。"""
    if _state["handler_ready"] and _state["lm_ready"]:
        return 0.0
    with _init_lock:
        if _state["handler_ready"] and _state["lm_ready"]:
            return 0.0
        t0 = time.time()
        if not torch.cuda.is_available():
            raise HTTPException(status_code=503, detail="CUDA unavailable on this host")
        # 冷启动前检查显存互斥：若其他服务（ComfyUI 等）驻卡，直接报错给编排层
        free_b, total_b = torch.cuda.mem_get_info()
        free_gb = free_b / 1024**3
        if free_gb < 6.0:
            raise HTTPException(
                status_code=409,
                detail=f"GPU busy: only {free_gb:.1f}GB free of {total_b/1024**3:.1f}GB. "
                       "POST http://127.0.0.1:8188/free {\"unload_models\": true} first (ComfyUI/CosyVoice VRAM mutex).",
            )
        if not _state["handler_ready"]:
            logger.info(f"[init] DiT handler init (int8 quantize + cpu-offload): {INIT}")
            handler = AceStepHandler()
            msg, ok = handler.initialize_service(**INIT)
            if not ok:
                _state["init_error"] = msg
                logger.error(f"[init] DiT init FAILED:\n{msg}")
                raise HTTPException(status_code=500, detail=f"DiT init failed: {msg[:800]}")
            _state["handler"] = handler
            _state["handler_ready"] = True
            logger.info(f"[init] DiT ready: {msg[:400]}")
        if not _state["lm_ready"]:
            logger.info(f"[init] LM init: {LM_INIT}")
            llm = LLMHandler(persistent_storage_path=None)
            msg, ok = llm.initialize(
                checkpoint_dir=str(MODELS_DIR),
                **LM_INIT,
            )
            if not ok:
                _state["init_error"] = msg
                logger.error(f"[init] LM init FAILED:\n{msg}")
                raise HTTPException(status_code=500, detail=f"LM init failed: {msg[:800]}")
            _state["llm"] = llm
            _state["lm_ready"] = True
            logger.info(f"[init] LM ready: {msg[:300]}")
        load_s = time.time() - t0
        logger.info(f"[init] total warmup {load_s:.1f}s, vram={_vram_stats()}")
        return load_s


class MusicRequest(BaseModel):
    mood: str = Field(..., min_length=1, max_length=500, description="情绪/场景描述（任意语言）")
    seconds: int = Field(..., ge=15, le=180, description="目标时长秒（15–180；模型支持 10–600）")
    seed: int | None = Field(None, description="可复现随机种子；缺省随机")
    tags: str = Field("", max_length=600, description="曲风/乐器/人声/BPM 逗号串（并入 caption 通道）")
    lyrics: str = Field("", max_length=4000, description="歌词（含 [Verse] 等段标记）；空=纯音乐 [Instrumental]")
    instrumental: bool = Field(True, description="纯音乐")
    caption: str = Field("", max_length=500, description="自然语言主描述（缺省用 mood）")
    bpm: int | None = Field(None, ge=30, le=300, description="节拍（缺省自动估计）")


@app.post("/music")
def post_music(req: MusicRequest):
    # seconds 15–180 已由模型校验（ge/le）；duration 模型支持 10–600
    if not _gen_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A generation is already running (single-GPU mutex)")
    try:
        t0 = time.time()
        warmup_s = _ensure_models()

        # 配置项融入生成（2026-11-22 用户裁决）：tags 并入 caption 通道；实词 lyrics；bpm 直传
        caption = ((req.caption or "").strip() or req.mood.strip())
        if (req.tags or "").strip():
            caption = (caption + ", " + req.tags.strip()).strip(", ")
        lyrics = (req.lyrics or "").strip() or "[Instrumental]"
        instrumental = bool(req.instrumental) or lyrics == "[Instrumental]"
        vocal_language = "unknown"
        params = GenerationParams(
            task_type="text2music",
            caption=caption[:500],
            lyrics=lyrics[:4000],
            instrumental=instrumental,
            vocal_language=vocal_language,
            bpm=req.bpm if req.bpm else None,
            duration=float(req.seconds),
            inference_steps=8,          # turbo 官方档
            seed=req.seed if req.seed is not None else -1,
            thinking=True,
        )
        if req.seed is not None:
            config = GenerationConfig(batch_size=1, use_random_seed=False, seeds=[req.seed], audio_format="wav")
        else:
            config = GenerationConfig(batch_size=1, use_random_seed=True, seeds=None, audio_format="wav")

        logger.info(f"[gen] mood={req.mood!r} seconds={req.seconds} seed={req.seed}")
        torch.cuda.reset_peak_memory_stats()
        t1 = time.time()
        result = generate_music(_state["handler"], _state["llm"], params, config, save_dir=str(OUT_DIR))
        gen_s = time.time() - t1

        if not result.success or not result.audios:
            detail = (result.error or result.status_message or "unknown failure")[:800]
            logger.error(f"[gen] FAILED: {detail}")
            raise HTTPException(status_code=500, detail=detail)

        audio0 = result.audios[0]
        src_path = Path(audio0["path"])
        gen_id = f"{int(time.time()*1000):x}-{uuid.uuid4().hex[:8]}"
        final_path = OUT_DIR / f"{gen_id}.wav"
        if src_path.resolve() != final_path.resolve():
            src_path.replace(final_path)
        bytes_n = final_path.stat().st_size

        _release_gpu_vram()
        _state["gen_count"] += 1
        resp = {
            "id": gen_id,
            "seconds": req.seconds,
            "file": str(final_path),
            "url": f"/music/{gen_id}/file",
            "bytes": bytes_n,
            "gen_seconds": round(time.time() - t0, 2),
            "model_seconds": round(gen_s, 2),
            "warmup_seconds": round(warmup_s, 2),
            "seed": audio0["params"].get("seed", req.seed),
            "vram_peak_mb": _vram_stats()["vram_peak_mb"],
            "mood": req.mood,
        }
        logger.info(f"[gen] OK id={gen_id} bytes={bytes_n} gen={resp['gen_seconds']}s "
                    f"(model={resp['model_seconds']}s warmup={resp['warmup_seconds']}s) "
                    f"vram_peak={resp['vram_peak_mb']}MB seed={resp['seed']}")
        return resp
    finally:
        _gen_lock.release()


@app.get("/music/{gen_id}/file")
def get_music_file(gen_id: str):
    if not gen_id.replace("-", "").isalnum():
        raise HTTPException(status_code=400, detail="bad id")
    path = OUT_DIR / f"{gen_id}.wav"
    if not path.exists():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type="audio/wav", filename=f"{gen_id}.wav")


@app.post("/unload")
def post_unload():
    stats = _release_gpu_vram()
    return {"ok": True, **stats}


@app.get("/health")
def health():
    return {
        "service": "w-m-acestep",
        "version": "1.0.0",
        "port": 8190,
        "models_dir": str(MODELS_DIR),
        "handler_ready": _state["handler_ready"],
        "lm_ready": _state["lm_ready"],
        "init_error": _state["init_error"],
        "gen_count": _state["gen_count"],
        "uptime_seconds": round(time.time() - _state["started_at"], 1),
        "vram": _vram_stats(),
    }


if __name__ == "__main__":
    logger.info("W-M ACE-Step service starting on 127.0.0.1:8190")
    uvicorn.run(app, host="127.0.0.1", port=8190, log_level="warning")
