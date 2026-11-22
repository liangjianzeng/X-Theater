#!/usr/bin/env python
"""音效生成服务（Stable Audio Open 1.0）· 端口 8197
API:
  GET  /health → {"ok": true, "engine": "stable_audio_open", "weights_loaded": bool}
  POST /sfx    {prompt, seconds≤47} → wav bytes
未装权重直接退出（诚实失败），绝不静默降级。
"""
import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEIGHTS_HINT = "weights/stable_audio_open_1.0.safetensors （bash dl_weights.sh）"

def weights_ready() -> bool:
    return os.path.isfile("weights/stable_audio_open_1.0.safetensors")

def generate(prompt: str, seconds: int) -> bytes:
    """真引擎实现点：Stable Audio Open 1.0 推理（weights 就绪后接线）。
    TODO(install): stable-audio-tools 管线：prompt → 47s 内 wav（44.1k stereo）。
    """
    raise RuntimeError("sfx 引擎未接线：先完成 runtime/sfx/README.md 的安装步骤")

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[sfx] " + (fmt % args) + "\n")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "engine": "stable_audio_open", "weights_loaded": weights_ready()})
        self._json(404, {"error": {"code": "NOT_FOUND", "message": self.path}})

    def do_POST(self):
        if self.path != "/sfx":
            return self._json(404, {"error": {"code": "NOT_FOUND", "message": self.path}})
        n = int(self.headers.get("content-length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._json(400, {"error": {"code": "BAD_JSON", "message": str(e)}})
        if not weights_ready():
            return self._json(503, {"error": {"code": "WEIGHTS_MISSING", "message": WEIGHTS_HINT}})
        sec = min(47, max(1, int(req.get("seconds") or 3)))
        try:
            data = generate(req.get("prompt", ""), sec)
        except RuntimeError as e:
            return self._json(501, {"error": {"code": "NOT_IMPLEMENTED", "message": str(e)}})
        except Exception as e:
            return self._json(500, {"error": {"code": "SFX_FAIL", "message": str(e)}})
        self.send_response(200)
        self.send_header("content-type", "audio/wav")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8197)
    a = ap.parse_args()
    if not weights_ready():
        print("[sfx] 权重缺失：" + WEIGHTS_HINT + " —— 服务拒绝启动（诚实失败）", file=sys.stderr)
        sys.exit(2)
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
