#!/usr/bin/env bash
# regen2k 精修组件下载（hf-mirror → NVMe models 目录）
# 等迁移脚本结束后再动 models 目录
set -u
BASE="https://hf-mirror.com/1038lab/Open-H3-Regenerate-2K/resolve/main"
M="/home/jianzengliang/ComfyUI/models"

while ! grep -q "MIGRATE DONE" ~/migrate_hot.log 2>/dev/null; do echo "[$(date +%T)] waiting migration..."; sleep 15; done

mkdir -p "$M/loras/minmax"
dl() { local url="$1" dest="$2"
  echo "[$(date +%F' '%T)] START $dest"
  if wget -c -q --tries=0 --timeout=60 -O "$dest.part" "$url"; then
    mv "$dest.part" "$dest"; echo "[$(date +%F' '%T)] DONE  $dest ($(ls -lh "$dest" | awk '{print $5}'))"
  else echo "[$(date +%F' '%T)] FAIL  $dest"; fi
}
dl "$BASE/lora/open_h3_regenerate_2k_bf16.safetensors"           "$M/loras/minmax/open_h3_regenerate_2k_bf16.safetensors" &
dl "$BASE/lora/minimax_h3_open_regenerate_2k_r128_bf16.safetensors" "$M/loras/minmax/minimax_h3_open_regenerate_2k_r128_bf16.safetensors" &
dl "$BASE/lora/sharp_curve_branches.safetensors"                 "$M/loras/minmax/sharp_curve_branches.safetensors" &
dl "$BASE/latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors" "$M/latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors" &
dl "$BASE/vae/fast_h3_vae_noncausal_24l.safetensors"             "$M/vae/fast_h3_vae_noncausal_24l.safetensors" &
wait
echo "[$(date +%F' '%T)] REGEN2K DL DONE"
