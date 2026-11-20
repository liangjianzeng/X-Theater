#!/usr/bin/env bash
# Spark H3 权重补齐下载脚本（ModelScope 直链，断点续传）
# 用法: nohup bash dl_h3.sh > ~/dl_h3.log 2>&1 &
set -u
BASE="https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master"
BASE_IMG="https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3-Image/resolve/master"
M="/mnt/models-ssd/ComfyUI/models"

dl() { # url dest
  local url="$1" dest="$2"
  echo "[$(date +%F' '%T)] START $dest"
  if wget -c -q --tries=0 --timeout=60 -O "$dest.part" "$url"; then
    mv "$dest.part" "$dest"
    echo "[$(date +%F' '%T)] DONE  $dest ($(ls -lh "$dest" | awk '{print $5}'))"
  else
    echo "[$(date +%F' '%T)] FAIL  $dest"
  fi
}

# 1. ref2va int8_convrot diffusion —— 保脸角色镜核心 (21GB)
dl "$BASE/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors" \
   "$M/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors" &

# 2. ref2v turbo 4step LoRA —— GB10 步数蒸馏加速 (2GB)
dl "$BASE/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors" \
   "$M/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors" &

# 3. H3-Image 的 qwen3.5_9b TE (7.3GB)
dl "$BASE_IMG/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors" \
   "$M/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors" &

wait
echo "[$(date +%F' '%T)] ALL DONE"
