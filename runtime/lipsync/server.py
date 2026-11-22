#!/usr/bin/env python
"""口型重绘服务（EchoMimicV3-Flash 首选 / LatentSync 1.5 备选）· 端口 8196
API:
  GET  /health  → {"ok": true, "engine": "...", "weights_loaded": bool}
  POST /lipsync {video, audio, text?} → mp4 bytes
未装权重直接退出（诚实失败），绝不静默降级。
"""
import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEIGHTS_HINT = "weights/ （bash dl_weights.sh 幂等下载）"

def weights_ready() -> bool:
    return os.path.isdir("weights") and any(os.scandir("weights")) if os.path.isdir("weights") else False

def lipsync(video_path: str, audio_path: str, text: str = "") -> bytes:
    """真引擎实现点：EchoMimicV3-Flash 推理（weights 就绪后接线）。
    TODO(install): pip -r requirements.txt + bash dl_weights.sh 后，在此调用推理管线：
      1) 抽取 video 帧序列 + audio wav（ffmpeg）
      2) EchoMimicV3 Flash 8-step 采样（分段 ≤10s）
      3) 段间拼接 → mp4（h264+aac，与源视频同分辨率/帧率）
    """
    raise RuntimeError("lipsync 引擎未接线：先完成 runtime/lipsync/README.md 的安装步骤")

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[lipsync] " + (fmt % args) + "\n")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "engine": "echomimic_v3_flash", "weights_loaded": weights_ready()})
        self._json(404, {"error": {"code": "NOT_FOUND", "message": self.path}})

    def do_POST(self):
        if self.path != "/lipsync":
            return self._json(404, {"error": {"code": "NOT_FOUND", "message": self.path}})
        n = int(self.headers.get("content-length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._json(400, {"error": {"code": "BAD_JSON", "message": str(e)}})
        if not weights_ready():
            return self._json(503, {"error": {"code": "WEIGHTS_MISSING", "message": WEIGHTS_HINT}})
        try:
            data = lipsync(req.get("video", ""), req.get("audio", ""), req.get("text", ""))
        except RuntimeError as e:
            return self._json(501, {"error": {"code": "NOT_IMPLEMENTED", "message": str(e)}})
        except Exception as e:
            return self._json(500, {"error": {"code": "LIPSYNC_FAIL", "message": str(e)}})
        self.send_response(200)
        self.send_header("content-type", "video/mp4")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8196)
    a = ap.parse_args()
    if not weights_ready():
        print("[lipsync] 权重缺失：" + WEIGHTS_HINT + " —— 服务拒绝启动（诚实失败）", file=sys.stderr)
        sys.exit(2)
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
