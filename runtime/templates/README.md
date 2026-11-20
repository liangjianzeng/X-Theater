# runtime/templates — ComfyUI 固化模板库（ADR-001 四元组锁定）

此目录是产品 worker（src/server/dag/adapters/comfy.js）唯一接受的模板来源。
部署/验证产物（workflow JSON、commit、权重清单）由部署侧产出后，按下面格式登记于此。

## 文件
- `<tmplId>.json` — ComfyUI API 格式 workflow（POST /prompt 的 prompt 字段内容）。
  参数占位：节点 input 写字符串 `"<SEED>"`、`"<PROMPT>"`、`"<NEGATIVE>"`、`"<WIDTH>"`、
  `"<HEIGHT>"`、`"<STEPS>"`、`"<CFG>"` 等，适配层按 manifest 对应 params 替换（数值自动转数字）。
- `manifest.json` — 四元组登记：

```json
{
  "templates": {
    "qwen-image-turbo": {
      "tmpl_sha16": "workflow 文件 sha256 前 16 位",
      "comfy_commit": "ComfyUI HEAD",
      "cn_commits": { "ComfyUI-GGUF": "<commit>" },
      "weights": [
        { "file": "qwen-image-2.1-turbo-Q5_K_M.gguf", "sha16": "…", "role": "diffusion_model" },
        { "file": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "sha16": "…", "role": "text_encoder" },
        { "file": "qwen_image_2.1_vae_bf16.safetensors", "sha16": "…", "role": "vae" }
      ],
      "vram_profile": "16G：TE 编码→逐出→transformer 上卡；禁双模型热载"
    }
  }
}
```

## 纪律（ADR §4）
- hash 不符＝拒跑（COMFY_TMPL_DRIFT），模板只能重登记、不能临时改；
- 模板族切换＝显式 `/free` 卸载；
- OOM 不重试同参数（降分辨率/steps 走降档梯子，由编排层处理）。
