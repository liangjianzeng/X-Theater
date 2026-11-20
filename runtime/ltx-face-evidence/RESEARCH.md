# LTX-2.5 分镜保脸·功课与实验记录（runtime/ltx-face-evidence/）

## 一、官方机制（来源：ltx.io 官方博客《How to Maintain Character Consistency in AI Video》，2026-08）

| 机制 | 原理 | 我们可用性 |
| --- | --- | --- |
| 1. Image Conditioning | 首帧 latent 替换噪声态，模型以首帧为时间起点延展；帧 0 外观向后传播 | ✅ 已用（ltx25-i2v 两段 Inplace：stage1 0.7 / stage2 1.0） |
| 2. IC-LoRA | 结构控制（pose/depth/edge），官方 22B-IC-LoRA-Union-Control 是 LTX-2.3 权重、参考下采样 0.5 | ⚠️ 2.3 权重 vs 我们 2.5 22B-distill GGUF，未验证兼容 |
| 3. Character LoRA | 20-30 张多角度图训练，rank 32-64，500-2000 步 | ⏸ 二期（16G 卡训 22B 不可行；需 trainer＋训练算力） |
| 4. Prompt Anchoring | 标准化角色描述块置于每条提示词开头，只变动作/镜头 | ✅ 零成本，本次 V1 实测 |
| 参考图库 | 每角色多景别参考，按镜别取用；同一参考贯穿全片 | ✅ 分镜首帧即参考（构图像素级匹配），定妆统一血统 |

## 二、社区方案考证（HF Alissonerdx/LTX-Best-Face-ID）

- Identity LoRA：overlap 参考条件（参考 latent 放帧 0 RoPE 网格邻位）＋ TASS-RoPE source-phase（source_id=2 相位标记）＋ ArcFace 恒等损失。
- **绑定 LTX-2.3 (22B)**；依赖 ComfyUI-BFSNodes（含 insightface 等 Windows 重依赖）；参考图要求胸像特写。
- 结论：与我们的 2.5 22B-distill 权重不保证兼容＋安装链路重，**不作为一期方案**。
- 技术本质（参考 latent 放帧 0 邻位）＝ LTX-2.5 原生 `LTXVAddGuide`(frame_idx=-1) ＋ `LTXVCropGuides` 的 overlap 机制 → 用原生节点等价实现（V2）。

## 三、本地节点语义确认（comfy_extras/nodes_lt.py）

- `LTXVAddLatentGuide`：半尺寸 guide 会被**膨胀到稀疏网格覆盖整个画布**（x2 IC-LoRA 语义）；但 720×1280 的真半尺寸 360×640 → latent 宽 45 为奇数，LTX VAE 按 2 分块报 einops 错（实测 f1056aff）→ 此路不通。
- `LTXVAddGuide`：image 进、内部编码，frame_idx=-1 把参考帧放在帧 0 之前（不占输出时轴）；`LTXVCropGuides` 采样后裁掉参考帧。官方 FLF2V/IC-LoRA 模板同款接线。
- 官方 IC-LoRA 模板（video_ltx2_3_ic_lora.json）确认标准对：AddGuide → KSampler → CropGuides → Decode。

## 四、对照实验（首帧＝char2 读信帧；seed 20261121；121 帧 24fps）

| 组 | 变量 | 耗时 | 结果 |
| --- | --- | --- | --- |
| V0 基线 | 现模板＋plain 提示词 | 373s（含冷载） | 0.5s＝首帧本人；4.8s 特写仍同一人（轻微：皮肤更油亮、脸稍饱满）；平缓运镜下首帧锚定站得住 |
| V1 提示词锚定 | 官方 Technique4：角色块前置＋只变动作 | 211s | 同一人保持；情绪指令命中（抬头/释然）——保脸不劣化且更听话 |
| V2 overlap 参考 | AddGuide(female_ref, idx=-1)＋CropGuides | 199s | 同一人保持；特写帧五官最贴参考图（饱满唇形/杏眼）；参考帧被 CropGuides 正确裁掉，时长不变 |

## 五、结论与拍摄方案（定稿）

1. **全镜提示词锚定**（官方 Technique4）：video5060 的 PROMPT 改为「角色 anchor 块（与分镜同一套 anchor/wardrobe 字段）前置＋镜动作/镜头描述」——零成本，实测保脸不劣化且指令更听话。
2. **角色镜加 overlap 参考**：模板变体 `ltx25-i2v-ref`——stage2 的 latent 链插 `LTXVAddGuide(定妆原片, frame_idx=-1, strength 1.0)` ＋采样后 `LTXVCropGuides`。非角色空镜沿用现 `ltx25-i2v`。实测参考帧不占时长、保脸更稳。
3. **产品护栏**：复审 lane 逐条 take 目检（已有），失真 take 驳回重拍（reroll 换 seed）。
4. **二期路线**（本机 16G 一期不做）：角色 LoRA 训练（需 trainer＋算力）；Best-Face-ID Identity LoRA（LTX-2.3 权重，需 BFSNodes＋insightface，与 2.5 兼容性未证）。

证据：V0_baseline_plain.mp4/f0-f2.png、V1_prompt_anchor.mp4/f0-f2.png、V2_latent_ref.mp4/f0-f2.png（同目录）。
