#!/usr/bin/env bash
# EchoMimicV3-Flash 权重幂等下载（Apache-2.0 可商用）。Spark 直连 HF 不稳 → ModelScope/hf-mirror 双通道。
set -e
mkdir -p weights
# 首选 ModelScope（国内直连稳定），回退 hf-mirror.com
BASE_MS="https://modelscope.cn/models/antgroup/echomimic_v3/resolve/master"
BASE_HF="https://hf-mirror.com/antgroup/echomimic_v3/resolve/main"
FILES=(
  "echomimic_v3-flash.safetensors"
  "denosing_net.safetensors"
  "reference_net.safetensors"
  "vwav.safetensors"
  "audio_encoder.bin"
)
for f in "${FILES[@]}"; do
  if [ -s "weights/$f" ]; then echo "skip $f"; continue; fi
  echo "downloading $f ..."
  curl -L --fail --retry 3 -o "weights/$f.part" "$BASE_MS/$f" || curl -L --fail --retry 3 -o "weights/$f.part" "$BASE_HF/$f"
  mv "weights/$f.part" "weights/$f"
done
echo "OK: weights/ 就绪（sha16 建议登记 manifest 纪律）"
