#!/usr/bin/env bash
# 热权重迁移：外置 SSD(/mnt/models-ssd) → 内置 NVMe
# 热集 = H3 线全部会频繁加载的权重；冷集留在 SSD 用软链接回。
# 原则：热权重放内置盘（经得起反复读），SSD 原文件保留作备份。
set -u
SRC=/mnt/models-ssd/ComfyUI/models
DST=/home/jianzengliang/ComfyUI/models

HOT="diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors
diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors
diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors
text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
text_encoders/qwen3.5_9b_w4a8_gptq.safetensors
vae/minimax_h3_video_vae_fp16.safetensors
vae/minimax_h3_audio_vae_fp32.safetensors
vae/minimax_h3_image_vae_fp16.safetensors
loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors
loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"

# 0) 等 wget 全部结束（下载脚本还在写 SSD 时不迁移）
while pgrep -x wget >/dev/null 2>&1; do echo "[$(date +%T)] waiting for wget..."; sleep 20; done

# 1) models 若是符号链接 → 替换为真目录（NVMe）
if [ -L "$DST" ]; then
  rm "$DST"
fi
mkdir -p "$DST"
for sub in diffusion_models text_encoders vae loras latent_upscale_models model_patches configs unet upscale_models style_models photomaker optical_flow hypernetworks gligen vae_approx; do
  mkdir -p "$DST/$sub"
done

# 2) 热集逐个 cp 到 NVMe（跳过已存在）
for rel in $HOT; do
  if [ -f "$SRC/$rel" ] && [ ! -f "$DST/$rel" ]; then
    echo "[$(date +%T)] COPY $rel ($(ls -lh "$SRC/$rel" | awk '{print $5}'))"
    cp "$SRC/$rel" "$DST/$rel" || echo "[$(date +%T)] FAIL $rel"
  fi
done

# 3) 其余全部软链回 SSD（冷集）；占位文件/分块缓存跳过
shopt -s nullglob
for sub in diffusion_models text_encoders vae loras latent_upscale_models model_patches configs unet upscale_models style_models photomaker optical_flow hypernetworks gligen vae_approx; do
  for f in "$SRC/$sub/"*; do
    b=$(basename "$f")
    case "$b" in put_*|*.part) continue;; esac
    if [ ! -e "$DST/$sub/$b" ]; then
      ln -s "$f" "$DST/$sub/$b"
    fi
  done
done

# 4) 汇报
echo "[$(date +%T)] NVME HOT SET:"
du -sh "$DST"/{diffusion_models,text_encoders,vae,loras} 2>/dev/null
echo "[$(date +%T)] MIGRATE DONE"
