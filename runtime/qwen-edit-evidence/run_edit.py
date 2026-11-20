# -*- coding: utf-8 -*-
"""Qwen-Image-2.1-Edit (cast photo -> new scene) run harness.

Reads the registered template E:/Work/X-Theater/runtime/templates/qwen-image-edit-cast.json,
substitutes <KEY> placeholders, submits via ComfyUI /prompt, polls /history,
samples nvidia-smi VRAM at 1s, copies the output PNG into the evidence dir.

Usage:
  venv python run_edit.py --tag ladder --instruction "..." --seed 20261121
"""
import argparse
import copy
import json
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HOST = "http://127.0.0.1:8188"
TEMPLATE = Path(r"E:/Work/X-Theater/runtime/templates/qwen-image-edit-cast.json")
EVIDENCE = Path(r"E:/Work/X-Theater/runtime/qwen-edit-evidence")
NEGATIVE = "低质量，模糊，畸变，多余的手指，文字，水印"


def http_json(path, payload=None, timeout=30):
    url = HOST + path
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def post_free():
    try:
        req = urllib.request.Request(
            HOST + "/free",
            data=json.dumps({"unload_models": True, "free_memory": True}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read().decode("utf-8", "replace").strip()
        print("[free] POST /free ok (body=%r)" % body[:40])
    except Exception as e:
        print("[free] POST /free failed:", e)


def vram_sampler(stop_evt, out):
    while not stop_evt.is_set():
        try:
            line = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=15,
            ).stdout.strip().splitlines()[0]
            out.append((time.time(), int(line)))
        except Exception:
            pass
        time.sleep(1.0)


def build_workflow(instruction, seed, width, height, steps, cfg, image, negative=NEGATIVE):
    raw = TEMPLATE.read_text(encoding="utf-8")
    subs = {
        "<IMAGE>": image,
        "<INSTRUCTION>": instruction,
        "<NEGATIVE>": negative,
        "<SEED>": str(int(seed)),
        "<WIDTH>": str(int(width)),
        "<HEIGHT>": str(int(height)),
        "<STEPS>": str(int(steps)),
        "<CFG>": str(cfg),
    }
    for k, v in subs.items():
        raw = raw.replace(k, v)
    leftover = re.findall(r"<[A-Z_]+>", raw)
    if leftover:
        raise RuntimeError("unsubstituted placeholders: %s" % sorted(set(leftover)))
    wf = json.loads(raw)
    # numeric coercion for INT/FLOAT widgets left as strings by replacement
    wf["7"]["inputs"]["width"] = int(width)
    wf["7"]["inputs"]["height"] = int(height)
    wf["8"]["inputs"]["seed"] = int(seed)
    wf["8"]["inputs"]["steps"] = int(steps)
    wf["8"]["inputs"]["cfg"] = float(cfg)
    return wf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--instruction", required=True)
    ap.add_argument("--image", default="female_ref.png")
    ap.add_argument("--seed", type=int, default=20261121)
    ap.add_argument("--width", type=int, default=720)
    ap.add_argument("--height", type=int, default=1280)
    ap.add_argument("--steps", type=int, default=25)
    ap.add_argument("--cfg", type=float, default=1.0)
    ap.add_argument("--timeout", type=int, default=1200)
    args = ap.parse_args()

    post_free()

    wf = build_workflow(args.instruction, args.seed, args.width, args.height,
                        args.steps, args.cfg, args.image)
    wf_path = EVIDENCE / ("workflow_run_%s.json" % args.tag)
    wf_path.write_text(json.dumps(wf, ensure_ascii=False, indent=1), encoding="utf-8")

    resp = http_json("/prompt", {"prompt": wf, "client_id": "edit-evidence"}, timeout=60)
    if "prompt_id" not in resp:
        print(json.dumps(resp, ensure_ascii=False))
        sys.exit("submit failed")
    pid = resp["prompt_id"]
    print("[submit] prompt_id =", pid)

    samples, stop_evt = [], threading.Event()
    th = threading.Thread(target=vram_sampler, args=(stop_evt, samples), daemon=True)
    t0 = time.time()
    th.start()

    result, err = None, None
    while time.time() - t0 < args.timeout:
        time.sleep(2.0)
        try:
            h = http_json("/history/%s" % pid)
        except Exception as e:
            print("[poll] transient:", e)
            continue
        if pid not in h:
            continue
        entry = h[pid]
        status = entry.get("status", {})
        if status.get("status_str") == "error" or status.get("completed") and not entry.get("outputs"):
            err = json.dumps(status, ensure_ascii=False)[:2000]
            break
        if status.get("completed"):
            result = entry.get("outputs", {})
            break
    stop_evt.set()
    th.join(timeout=3)

    wall = time.time() - t0
    peak = max((m for _, m in samples), default=0)
    rec = {
        "tag": args.tag, "prompt_id": pid, "wall_s": round(wall, 1),
        "vram_peak_mib": peak, "samples": len(samples),
        "seed": args.seed, "size": [args.width, args.height],
        "steps": args.steps, "cfg": args.cfg,
        "instruction": args.instruction,
    }
    if err:
        rec["error"] = err
        print(json.dumps(rec, ensure_ascii=False, indent=1))
        (EVIDENCE / ("run_%s.json" % args.tag)).write_text(
            json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        sys.exit(1)

    # collect saved images
    saved = []
    for node_id, node_out in (result or {}).items():
        for img in node_out.get("images", []):
            saved.append(img)
    if not saved:
        sys.exit("no output images: %s" % json.dumps(result, ensure_ascii=False)[:800])
    src = Path(saved[0]["fullpath"]) if saved[0].get("fullpath") else \
        Path(r"E:/ComfyUI/output") / saved[0]["filename"]
    dst = EVIDENCE / ("%s_%s.png" % (args.tag, pid[:8]))
    shutil.copy2(src, dst)
    rec["output"] = str(dst)
    rec["output_bytes"] = dst.stat().st_size
    post_free()
    (EVIDENCE / ("run_%s.json" % args.tag)).write_text(
        json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(rec, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
