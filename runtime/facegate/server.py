# -*- coding: utf-8 -*-
"""facegate — 人脸身份门控服务（W-B 通道，127.0.0.1:8195）
契约：
  GET  /health                      → {status, ref_loaded}
  POST /swap  {dst_b64}             → 用锁定源脸对 dst 图换脸 → {png_b64, score}
  POST /score {img_b64}             → {score}（对锁定源脸的 ArcFace 余弦）
门控：score < GATE(默认0.6) → 409 {score}（调用方决定重试策略）。
源脸：启动时从 runtime/assets/cast/<REF_FILE> 提取并缓存（env FACEGATE_REF 可覆盖文件名）。
"""
import base64, os
import numpy as np
import cv2
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REF_FILE = os.environ.get("FACEGATE_REF", "liangchen.png")
GATE = float(os.environ.get("FACEGATE_GATE", "0.6"))
MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

from insightface.app import FaceAnalysis
from insightface.model_zoo import model_zoo

app = FastAPI(title="facegate")
_fa = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
_fa.prepare(ctx_id=-1, det_size=(640, 640))
_swapper = model_zoo.get_model(os.path.join(MODEL_DIR, "inswapper_128.onnx"), providers=["CPUExecutionProvider"])
_ref_face = None
_ref_emb = None

def _main_face(img):
    fs = _fa.get(img)
    if not fs:
        return None
    return max(fs, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))

def _load_ref():
    global _ref_face, _ref_emb
    cands = [
        os.path.join(REPO, "var", "assets", "cast", REF_FILE),
        os.path.join(REPO, "runtime", "assets", "cast", REF_FILE),
    ]
    p = next((c for c in cands if os.path.exists(c)), cands[0])
    img = cv2.imread(p)
    if img is None:
        raise RuntimeError("参考图缺失: " + p)
    f = _main_face(img)
    if f is None:
        raise RuntimeError("参考图未检出人脸: " + p)
    _ref_face = f
    _ref_emb = f.normed_embedding

_load_ref()

class ImgIn(BaseModel):
    dst_b64: str
    gate: float = GATE

class ScoreIn(BaseModel):
    img_b64: str

def _dec(b64):
    return cv2.imdecode(np.frombuffer(base64.b64decode(b64), dtype=np.uint8), cv2.IMREAD_COLOR)

def _enc(img):
    ok, buf = cv2.imencode(".png", img)
    return base64.b64encode(buf.tobytes()).decode("ascii") if ok else None

@app.get("/health")
def health():
    return {"status": "ok", "ref_loaded": _ref_face is not None, "ref_file": REF_FILE, "gate": GATE}

@app.post("/score")
def score(inp: ScoreIn):
    img = _dec(inp.img_b64)
    if img is None:
        raise HTTPException(400, "image decode failed")
    f = _main_face(img)
    if f is None:
        return {"score": None, "reason": "no_face"}
    s = float(np.dot(_ref_emb, f.normed_embedding))
    return {"score": round(s, 4), "gate": GATE, "pass": s >= GATE}

@app.post("/swap")
def swap(inp: ImgIn):
    img = _dec(inp.dst_b64)
    if img is None:
        raise HTTPException(400, "image decode failed")
    f = _main_face(img)
    if f is None:
        raise HTTPException(409, {"code": "NO_FACE", "message": "构图图未检出人脸"})
    out = _swapper.get(img, f, _ref_face, paste_back=True)
    f2 = _main_face(out)
    s = float(np.dot(_ref_emb, f2.normed_embedding)) if f2 is not None else 0.0
    if s < inp.gate:
        raise HTTPException(409, {"code": "GATE_FAIL", "score": round(s, 4), "gate": inp.gate,
                                  "png_b64": _enc(out), "message": "换脸后相似度低于门控"})
    return {"png_b64": _enc(out), "score": round(s, 4), "gate": inp.gate, "pass": True}
