# W-B 无头 ComfyUI 生图先行验证脚本（固化模板，非用户输入 workflow —— ADR-001 安全红线）
# 用法: E:/ComfyUI/venv/Scripts/python.exe generate_and_verify.py
# 产物: 同目录 evidence_run.json + 复制的输出 PNG
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8188"
EVID = os.path.dirname(os.path.abspath(__file__))
COMFY_OUT = r"E:\ComfyUI\output"

WORKFLOW = {
    "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": "qwen-image-2.1-turbo-Q5_K_M.gguf"}},
    "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_8b_int8_convrot.safetensors", "type": "qwen_image"}},
    "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_2.1_vae_bf16_comfyorg.safetensors"}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "一张写实夜航灯塔明信片", "clip": ["2", 0]}},
    "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "低质量", "clip": ["2", 0]}},
    "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
    "7": {"class_type": "KSampler", "inputs": {
        "seed": int(sys.argv[1]) if len(sys.argv) > 1 else 20261121, "steps": 8, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
        "denoise": 1.0, "model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
    "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "w_b_lighthouse", "images": ["8", 0]}},
}

NEEDED = ["UnetLoaderGGUF", "CLIPLoader", "VAELoader", "CLIPTextEncode",
          "EmptySD3LatentImage", "KSampler", "VAEDecode", "SaveImage"]


def get_json(path, timeout=30):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def check_object_info():
    info = get_json("/object_info", timeout=60)
    missing = [n for n in NEEDED if n not in info]
    if missing:
        print("FATAL: missing node classes in /object_info:", missing)
        sys.exit(2)
    oi = {n: info[n] for n in NEEDED}
    checks = [
        ("unet_name", "qwen-image-2.1-turbo-Q5_K_M.gguf", oi["UnetLoaderGGUF"]),
        ("clip_name", "qwen3vl_8b_int8_convrot.safetensors", oi["CLIPLoader"]),
        ("vae_name", "qwen_image_2.1_vae_bf16_comfyorg.safetensors", oi["VAELoader"]),
        ("sampler_name", "euler", oi["KSampler"]),
        ("scheduler", "simple", oi["KSampler"]),
    ]
    for key, want, spec in checks:
        opts = spec["input"].get("required", {}).get(key, [])
        opts = opts[0] if opts and isinstance(opts[0], list) else []
        if want not in opts:
            print("FATAL: %s=%r not in options (have %d options)" % (key, want, len(opts)))
            print("sample options:", opts[:10])
            sys.exit(3)
    print("object_info check OK: all 8 nodes present, model files visible to server")
    return oi


def gpu_mem_sampler(stop_flag, out):
    # 采样显存（MiB），记录峰值
    peak = 0
    while not stop_flag[0]:
        try:
            r = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10)
            v = int(r.stdout.strip().splitlines()[0])
            out.append(v)
            peak = max(peak, v)
        except Exception:
            pass
        time.sleep(1.0)
    return peak


def main():
    t0 = time.time()
    stats = get_json("/system_stats")
    dev = stats.get("devices", [{}])[0]
    print("system_stats: name=%s vram_total=%sMiB torch=%s cuda_avail=%s" % (
        dev.get("name"), dev.get("vram_total"), stats.get("system", {}).get("comfyui_version"), dev.get("torch_version")))

    check_object_info()

    stop_flag = [False]
    samples = []
    import threading
    th = threading.Thread(target=lambda: samples.append(gpu_mem_sampler(stop_flag, [0])), daemon=True)
    # 简化：直接线程内记录
    def sampler():
        peak = 0
        while not stop_flag[0]:
            try:
                r = subprocess.run(
                    ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=10)
                for line in r.stdout.strip().splitlines():
                    v = int(line)
                    samples.append(v)
                    peak = max(peak, v)
            except Exception:
                pass
            time.sleep(1.0)
        samples.append(peak)
    th = threading.Thread(target=sampler, daemon=True)
    th.start()

    submit_t = time.time()
    req = urllib.request.Request(
        BASE + "/prompt",
        data=json.dumps({"prompt": WORKFLOW, "client_id": "wb-evidence"}).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print("FATAL: /prompt rejected:", e.read().decode("utf-8", "replace"))
        stop_flag[0] = True
        sys.exit(4)
    prompt_id = resp.get("prompt_id")
    print("prompt_id =", prompt_id, "submitted at +%.1fs" % (time.time() - t0))

    history = None
    deadline = submit_t + 1800  # 30min 上限
    poll = 0
    while time.time() < deadline:
        time.sleep(2)
        poll += 1
        h = get_json("/history/" + prompt_id, timeout=30)
        if prompt_id in h:
            st = h[prompt_id].get("status", {})
            if st.get("completed"):
                history = h[prompt_id]
                break
            if st.get("status_str") == "error":
                print("FATAL: execution error. messages:")
                for m in st.get("messages", []):
                    print("  ", json.dumps(m, ensure_ascii=False)[:500])
                stop_flag[0] = True
                sys.exit(5)
        if poll % 15 == 0:
            print("  polling... +%.0fs vram_used_last=%sMiB" % (time.time() - submit_t, samples[-1] if samples else "?"))

    stop_flag[0] = True
    th.join(timeout=5)
    gen_seconds = time.time() - submit_t
    vram_peak = max(samples) if samples else None

    if history is None:
        print("FATAL: timeout waiting for completion")
        sys.exit(6)

    outputs = history.get("outputs", {})
    pngs = []
    for node_id, node_out in outputs.items():
        for img in node_out.get("images", []):
            if img.get("type") == "output":
                p = os.path.join(COMFY_OUT, img.get("subfolder", ""), img["filename"])
                pngs.append(p)
    if not pngs:
        print("FATAL: no output image in history outputs:", json.dumps(outputs, ensure_ascii=False)[:800])
        sys.exit(7)

    result = {
        "prompt_id": prompt_id,
        "submit_iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(submit_t)),
        "generate_seconds": round(gen_seconds, 1),
        "vram_peak_mib": vram_peak,
        "vram_samples_mib": samples,
        "outputs": pngs,
    }
    for p in pngs:
        sz = os.path.getsize(p)
        ok = sz > 0
        print("PNG: %s size=%d bytes ok=%s" % (p, sz, ok))
        if ok:
            shutil.copy2(p, os.path.join(EVID, os.path.basename(p)))
        result.setdefault("png_sizes", {})[p] = sz
        if not ok:
            sys.exit(8)

    with open(os.path.join(EVID, "evidence_run.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print("DONE in %.1fs (generate %.1fs) vram_peak=%sMiB" % (time.time() - t0, gen_seconds, vram_peak))


if __name__ == "__main__":
    main()
