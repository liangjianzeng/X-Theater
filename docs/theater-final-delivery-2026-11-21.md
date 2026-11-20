# 全流程真机交付报告 —《灯塔来信》final.mp4（2026-11-21）

## 交付物

| 项 | 值 |
| --- | --- |
| 成片 | `var/client-demo/out/ep_ed1a8f1a82ae_final.mp4`（26.4MB） |
| 规格 | 720×1280（9:16）· 24fps · 1:22.66 · h264+aac 48k stereo · 片头字幕卡＋16 镜 |
| 台词 | 2 行真实 TTS（CosyVoice2「中文女」，1.84s／2.44s）按镜对位混流（响度实证：对白段 max -5dB vs 无对白段 -25dB） |
| 配乐 | ACE-Step 自部署（MIT 预检通过）· -13dB 垫底 amix normalize=0 |
| meta | `final-comfy`·explicit/implicit_mark·内测水印·dialogue_lines:2·shots:16 |

## 链路（全部真实产物，产品界面驱动）

剧本（结构化 4 场 16 镜）→ C1 故事策划 → 两阶段分镜（7 空镜 t2i turbo ＋ 9 角色镜 Qwen-Image-2.1 编辑模型保脸换姿势）→ 定妆沿用（女主＝导演原片直用）→ C2/C3 拍板 → C4 配音（真 TTS·诚实空结果）＋ 音乐（4 场候选·C9 采用）→ C5 预览 → C6 预算确认 → **16 镜 LTX-2.5 拍摄**（22B-distill GGUF·两阶段 TI2V·15.7GB 峰值无 OOM）→ 复审逐条 pass → C7/C8 → **真 FFmpeg 导出**（归一化→拼接→台词对位→BGM）。

## LTX-2.5 分镜保脸方案（功课→实测→定稿）

功课与证据：`runtime/ltx-face-evidence/`（RESEARCH.md＋V0/V1/V2 对照 mp4/抽帧）。

1. **提示词锚定**（官方 Technique4）：角色 anchor 块前置、只变动作/镜头——worker 全镜接入（与分镜同一套 cast.anchor/wardrobe 字段）。
2. **角色镜 overlap 参考**：`ltx25-i2v-ref` 模板变体（`LTXVAddGuide(定妆原片, frame_idx=-1)`＋`LTXVCropGuides`）——单角色镜实测保脸最贴参考。
3. **双人镜规则**：不挂单人 overlap 参考（会把第二人拽向参考形象——实测翻车两次后定规），改用双角色形象块文字锚定（分镜＋视频两侧同时锚）。
4. 二期路线：角色 LoRA 训练；Best-Face-ID（LTX-2.3 专用，不兼容 2.5 权重，弃）。

## 过程修复（全部进提交 dbd45e4）

- 视频镜序定位：`shot.seq`（场×100 全局编号）误作扁平下标 → 按 seq 排序取位
- compose：art 读回统一 `resolveArt`（THEATER_VAR 部署口径）；concat list 标准单引号格式（JSON.stringify 双引号格式 ffmpeg 拒读）；stderr 保留尾部（banner 吞错）；台词对位＋BGM 混流
- music：采用条目携带 `art`（否则 compose 找不到 BGM 文件）＋存量数据迁移
- voice：台词行持久化 `state.voice_lines`（内存重启即失→compose 断供）；场景过滤（每场景 job 只渲染本镜台词）；诚实空结果（不落 stub 造假）；speaker 映射（女主→中文女）；合成前卸载 ComfyUI 显存（互斥）
- cards/episodes：C4 重出语义（重派 voice＋回 pending）；C3 重出；cast/script-scenes 修订 API；shoot `shotIds` 局部重拍；复审 stale 镜可局部重拍

## 遗留

- GitHub push 受网络间歇阻断（本地 commit dbd45e4 待推，后台重试中）
- 复审 stale→自动重拍未闭环（一期用 `shotIds` 局部重拍手动补）
- 角色 LoRA 训练（二期）；1080×1920 交付档走 compose 超分链（预留 platform_spec）
