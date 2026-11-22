#!/usr/bin/env bash
# Stable Audio Open 1.0 权重幂等下载（Stability Community License：年营收 <$1M 可商用）
set -e
mkdir -p weights
BASE_MS="https://modelscope.cn/models/AI-ModelScope/stable-audio-open-1.0/resolve/master"
BASE_HF="https://hf-mirror.com/stabilityai/stable-audio-open-1.0/resolve/main"
F="stable_audio_open_1.0.safetensors"
if [ -s "weights/$F" ]; then echo "skip $F"; else
  curl -L --fail --retry 3 -o "weights/$F.part" "$BASE_MS/$F" || curl -L --fail --retry 3 -o "weights/$F.part" "$BASE_HF/$F"
  mv "weights/$F.part" "weights/$F"
fi
echo "OK: weights/ 就绪"
