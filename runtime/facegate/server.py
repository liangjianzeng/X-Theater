# -*- coding: utf-8 -*-
"""facegate — 人脸身份门控服务（W-B 通道，127.0.0.1:8195）
契约：
  GET  /health                                → {status, ref_loaded}
  POST /score  {img_b64, ref_file?}           → {score, yaw, pitch, pass}（ArcFace 余弦＋姿态粗估）
  POST /swap   {dst_b64, gate?, ref_file?}    → {png_b64, score}（用指定参考脸对 dst 图换脸）
参考脸：ref_file 指定 var/assets/cast/<file>（支持角色 views 子目录相对路径）；
缺省用 FACEGATE_REF（默认 liangchen.png）。按文件缓存 embedding（多角色/多集复用）。
姿态粗估（5 点 kps）：yaw=鼻尖相对双眼中点的水平偏移（观众视角 left≈-1）；pitch=眼口纵向距
占脸高比例相对基线 0.33 的偏移（down<0 / up>0）。粗档位标签由调用方（imgspark.angleTag）完成。
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
_ref_cache = {}  # ref_file → (face, normed_embedding)


def _main_face(img):
    fs = _fa.get(img)
    if not fs:
        return None
    return max(fs, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))


def _ref(ref_file=None):
    key = (ref_file or REF_FILE).replace("\\", "/")
    if key in _ref_cache:
        return _ref_cache[key]
    cands = []
    rel = key.lstrip("/")
    if rel.startswith("var/"):
        cands.append(os.path.join(REPO, rel))  # 全相对路径（含角色 views 子目录）
    base = os.path.basename(key)
    cands += [
        os.path.join(REPO, "var", "assets", "cast", base),
        os.path.join(REPO, "runtime", "assets", "cast", base),
    ]
    p = next((c for c in cands if os.path.exists(c)), cands[0])
    img = cv2.imread(p)
    if img is None:
        raise RuntimeError("参考图缺失: " + p)
    f = _main_face(img)
    if f is None:
        raise RuntimeError("参考图未检出人脸: " + p)
    pair = (f, f.normed_embedding)
    _ref_cache[key] = pair
    return pair


class ImgIn(BaseModel):
    dst_b64: str
    gate: float = GATE
    ref_file: str = None

class ScoreIn(BaseModel):
    img_b64: str
    ref_file: str = None


def _dec(b64):
    return cv2.imdecode(np.frombuffer(base64.b64decode(b64), dtype=np.uint8), cv2.IMREAD_COLOR)

def _enc(img):
    ok, buf = cv2.imencode(".png", img)
    return base64.b64encode(buf.tobytes()).decode("ascii") if ok else None

def _pose(f):
    """5 点 kps → (yaw, pitch) 粗估；取不到时 (0,0)"""
    try:
        kps = f.kps
        le, re, nose, ml, mr = kps[0], kps[1], kps[2], kps[3], kps[4]
        dx = max(float(re[0] - le[0]), 1e-3)
        yaw = ((float(nose[0] - le[0]) / dx) - 0.5) * 2.0
        x1, y1, x2, y2 = [float(v) for v in f.bbox]
        bh = max(y2 - y1, 1e-3)
        eye_mid_y = (float(le[1]) + float(re[1])) / 2.0
        mouth_y = (float(ml[1]) + float(mr[1])) / 2.0
        pitch = (mouth_y - eye_mid_y) / bh - 0.33
        return round(yaw, 3), round(pitch, 3)
    except Exception:
        return 0.0, 0.0


@app.get("/health")
def health():
    return {"status": "ok", "ref_loaded": REF_FILE in _ref_cache or bool(_ref_cache), "ref_file": REF_FILE, "gate": GATE}


@app.post("/score")
def score(inp: ScoreIn):
    img = _dec(inp.img_b64)
    if img is None:
        raise HTTPException(400, "image decode failed")
    f = _main_face(img)
    if f is None:
        return {"score": None, "reason": "no_face"}
    _, emb = _ref(inp.ref_file)
    s = float(np.dot(emb, f.normed_embedding))
    yaw, pitch = _pose(f)
    return {"score": round(s, 4), "yaw": yaw, "pitch": pitch, "gate": GATE, "pass": s >= GATE}


@app.post("/swap")
def swap(inp: ImgIn):
    img = _dec(inp.dst_b64)
    if img is None:
        raise HTTPException(400, "image decode failed")
    f = _main_face(img)
    if f is None:
        raise HTTPException(409, {"code": "NO_FACE", "message": "构图图未检出人脸"})
    ref_face, emb = _ref(inp.ref_file)
    out = _swapper.get(img, f, ref_face, paste_back=True)
    f2 = _main_face(out)
    s = float(np.dot(emb, f2.normed_embedding)) if f2 is not None else 0.0
    if s < inp.gate:
        raise HTTPException(409, {"code": "GATE_FAIL", "score": round(s, 4), "gate": inp.gate,
                                  "png_b64": _enc(out), "message": "换脸后相似度低于门控"})
    return {"png_b64": _enc(out), "score": round(s, 4), "gate": inp.gate, "pass": True}
