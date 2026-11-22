#!/usr/bin/env bash
# SeedVR2-3B FP8 权重幂等下载（Apache-2.0 可商用）
set -e
mkdir -p weights
BASE_MS="https://modelscope.cn/models/DIY-GST/seedvr2-3b-fp8/resolve/master"
BASE_HF="https://hf-mirror.com/DIY-GST/SeedVR2-3B-FP8/resolve/main"
F="seedvr2_3b_fp8.safetensors"
if [ -s "weights/$F" ]; then echo "skip $F"; else
  curl -L --fail --retry 3 -o "weights/$F.part" "$BASE_MS/$F" || curl -L --fail --retry 3 -o "weights/$F.part" "$BASE_HF/$F"
  mv "weights/$F.part" "weights/$F"
fi
echo "OK: weights/ 就绪（装好后按 README 固化模板＋manifest 登记）"
