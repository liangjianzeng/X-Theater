# -*- coding: utf-8 -*-
"""ArcFace 人脸相似度打分：参考图 vs 全部定妆候选。输出余弦相似度排名。"""
import sys, os, glob, json
import numpy as np
from insightface.app import FaceAnalysis

REF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ref_user.png")
BASE = os.path.dirname(os.path.abspath(__file__))

app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
app.prepare(ctx_id=-1, det_size=(640, 640))

def embed(path):
    img = cv2.imread(path) if False else None
    import cv2
    img = cv2.imread(path)
    if img is None:
        return None, "读图失败"
    faces = app.get(img)
    if not faces:
        return None, "未检出人脸"
    f = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
    return f.normed_embedding, None

ref_e, err = embed(REF)
if ref_e is None:
    print("参考图 embedding 失败:", err); sys.exit(1)

def cos(a, b):
    return float(np.dot(a, b))

rows = []
# 历史候选：v1 冒烟 + 本次 6 seed + 被驳回的旧定妆（若在）
cands = [("cand_v1.png", "v1冒烟(似参考构图)")]
for i in range(9, 15):
    cands.append(("cand_%d.png" % i, "seed2026111%d" % (i - 9 + 21)))
drift = r"E:\Work\X-Theater\var\out\job_2029e6ca1767_cast.png"
cands.append((drift, "旧锚点版(用户判负)"))
for path, tag in cands:
    if not os.path.exists(path):
        rows.append((tag, path, None)); continue
    e, err = embed(path)
    if e is None:
        rows.append((tag, path, None)); continue
    rows.append((tag, path, cos(ref_e, e)))

rows2 = [r for r in rows if r[2] is not None]
rows2.sort(key=lambda x: -x[2])
out = {"reference": REF, "scale_note": "ArcFace 余弦: >0.65 强同 persons; 0.45-0.65 弱同/亲属级; <0.35 不同人", "rank": []}
for tag, path, score in rows2:
    print("%.4f  %s  (%s)" % (score, tag, os.path.basename(path)))
    out["rank"].append({"score": round(score, 4), "tag": tag, "file": path})
for tag, path, score in rows:
    if score is None:
        print("N/A    %s  (%s)" % (tag, path))
        out["rank"].append({"score": None, "tag": tag, "file": path})
with open(os.path.join(BASE, "scores.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("saved scores.json")
