"use strict";
/**
 * adapters/h3ir.js — MiniMax H3-Context-IR 本地复刻（ADR-001 §75-76 锁定项）
 *
 * 官方 Context-IR 是托管系统未开源；本模块按官方 prompting guide（仓库
 * skills/h3-prompt-writing/references/{base-en,ref-en}.txt，留档 runtime/spark-evidence/refs/h3-skill/）
 * 做**规则化拼装**，输出六段式/三字段 IR。多行 prompt 安全（调用方为对象级参数替换）。
 *
 * 双语言策略：IR 骨架与固定段为英文（官方要求），镜头/人设描述保留中文原文——H3 为双语模型，
 * 结构化英文骨架 + 中文内容可用；可选 LLM 全英文重写见 rewriteWithLLM（默认关闭）。
 *
 * 导出：
 *   buildFL2VA({ shotDesc, dialogue, lang, style, sec }) → IR 字符串（h3-fl2va-video 模板用）
 *   buildRef2VA({ subjects, shotDesc, dialogue, lang, style, sec, shotIndex }) → IR 字符串（h3-ref2va-video 用）
 *   rewriteWithLLM(ir, cfg) → Promise<string>（cfg.h3ir.llmUrl 存在时走 OpenAI 兼容端点；失败回退原文）
 *   lengthFrames(sec) → 17k+5 帧网格帧数（124=~5s，训练区间 124-362）
 */

/** 17k+5 帧网格：24fps，124≈5s，上限 362（≈15s 官方训练区间）。
 *  向上取整：len = 5 + 17·ceil((base-5)/17)（2026-11-21 修负数取模 bug：7.5s 180帧 原错出 175） */
function lengthFrames(sec) {
  const s = Number(sec) > 0 ? Number(sec) : 5;
  const base = Math.max(124, Math.round(s * 24));
  const k = Math.ceil((base - 5) / 17);
  const len = 5 + 17 * Math.max(0, k);
  return Math.min(362, len);
}

function dialogueTag(dialogue, lang) {
  const d = String(dialogue || "").trim();
  if (!d) return "";
  const l = String(lang || "中文").trim();
  return " <d>[" + l + "]" + d + "</d>";
}

/** 歌曲锚点（2026-11-21）：整首歌统一风格——同一旋律动机+伴奏+唱法写进每镜 IR，
 *  保证 8 镜独立生成拼起来像同一首歌。song 可为字符串（直接用）或 {motif,accompaniment,tempo,key,voice}。 */
function songLine(song) {
  if (!song) return "";
  if (typeof song === "string") return String(song).trim();
  const s = song;
  const parts = [];
  if (s.motif) parts.push(s.motif);
  if (s.accompaniment) parts.push(s.accompaniment + " accompaniment");
  if (s.tempo) parts.push(s.tempo);
  if (s.key) parts.push(s.key);
  if (s.voice) parts.push(s.voice);
  return parts.join(", ");
}

/**
 * FL2VA 三字段 IR（base-en.txt §2.2）：instruction 行 + 三核心字段。
 * - shotDesc：该镜中文描述（剧本 shots[].desc + 在场角色人设 + 风格锚点）
 * - dialogue：该镜台词（逐句）
 */
function buildFL2VA(opts) {
  const o = opts || {};
  const sec = Number(o.sec) > 0 ? Number(o.sec) : 5;
  const dlg = dialogueTag(o.dialogue, o.lang);
  const style = String(o.style || "").trim();
  const desc = String(o.shotDesc || "").trim();
  const song = songLine(o.song);
  const speaker = o.speaker ? " The speaker (" + o.speaker + ") sings these lyrics softly:" : (o.dialogue ? " She sings these lyrics softly:" : "");
  const lines = [];
  if (style) lines.push(style);
  lines.push(
    "integrated_multimodal_description: [Shot 1] Live-action, cinematic. " + desc +
    speaker + dlg +
    " The camera holds the composition with subtle handheld micro-movement throughout; the action begins immediately and completes just before the final second."
  );
  lines.push(
    "overall_soundscape: Quiet bedroom room tone matching the scene, soft cloth rustle" +
    (song ? "; she sings the lyrics above as " + song + " — the sung vocals are clearly audible and lip-synced" : (o.dialogue ? "; the spoken dialogue is clearly audible and lip-synced" : "")) + "."
  );
  lines.push("non_diegetic_music: " + (o.music || (song ? "the accompaniment of the song she sings is part of the scene; no extra background music." : "none; keep the natural location ambience only.")));
  return lines.join("\n");
}

/**
 * Ref2VA 六段式 IR（ref-en.txt §1）：subject_definitions / summary / retention_analysis /
 * detailed_description / overall_soundscape / non_diegetic_music。
 * - subjects: [{name, desc, wardrobe}]（剧本 cast[]，≤9 个，对应 ref_images 顺序）
 * - refImages: ["<Picture 1>", ...] 说明每个参考图角色（与模板 ref_images 顺序一致）
 */
function buildRef2VA(opts) {
  const o = opts || {};
  const sec = Number(o.sec) > 0 ? Number(o.sec) : 5;
  const dlg = dialogueTag(o.dialogue, o.lang);
  const subjects = Array.isArray(o.subjects) ? o.subjects.slice(0, 9) : [];
  const pics = Array.isArray(o.refImages) ? o.refImages : [];

  const defs = [];
  subjects.forEach((s, i) => {
    const n = i + 1;
    const picSrc = pics[i] ? " from " + pics[i] : "";
    defs.push(
      "<Subject " + n + "> is the character '" + String(s.name || "role" + n) + "'" + picSrc +
      ": " + String(s.desc || "") + (s.wardrobe ? " Wardrobe: " + s.wardrobe + "." : "")
    );
  });
  pics.forEach((p, i) => {
    const hasSubject = subjects[i] != null;
    if (!hasSubject) defs.push("<Picture " + (i + 1) + "> is a reference image providing identity and styling for the target shot.");
  });

  const speakers = subjects.map((s, i) => "<Subject " + (i + 1) + "> (S" + (i + 1) + ")").join(", ");
  const summary =
    "[reference generation + keyframe completion] The target video is a single cinematic shot. " +
    (subjects.length ? speakers + " appear as defined" : "The referenced appearance is used as identity anchor") +
    (pics.length ? ", with " + pics.join(", ") + " as identity reference frames." : ".") +
    " " + String(o.shotDesc || "").trim();

  const retention = subjects.map((s, i) =>
    "<Subject " + (i + 1) + "> (appears in [Shot 1]): fully_preserved - identity, hairstyle, face and wardrobe are retained exactly as defined" +
    (pics[i] ? " from " + pics[i] + "." : ".")
  );

  const speaker0 = subjects.length ? " <Subject 1> (S1)" : "";
  const detailed =
    "[Shot 1] Live-action, cinematic shot with shallow depth of field. " +
    String(o.shotDesc || "").trim() +
    (o.dialogue ? speaker0 + " speaks the line:" + dlg + " Lip movement naturally syncs with the spoken dialogue." : " No dialogue in this shot; the subject's breathing and micro-expressions remain natural.") +
    " The camera holds with subtle movement, completing the action just before the final second.";

  const soundscape =
    "Quiet location room tone consistent with the scene; soft cloth rustle and footstep sounds follow the visible movements" +
    (o.dialogue ? "; the spoken dialogue is clearly audible and lip-synced." : ".");

  return [
    "subject_definitions:",
    defs.join("\n"),
    "",
    "summary:",
    summary,
    "",
    "retention_analysis:",
    retention.join("\n"),
    "",
    "detailed_description:",
    detailed,
    "",
    "overall_soundscape:",
    soundscape,
    "",
    "non_diegetic_music:",
    o.music || "none; keep the natural location ambience only."
  ].join("\n");
}

/**
 * 可选 LLM 全英文重写（OpenAI 兼容 /v1/chat/completions，复用 Spark 侧 llama-server）。
 * cfg.h3ir.llmUrl 为空（默认）→ 原样返回（规则拼装已可用）；
 * 任何错误（不可达/超时/格式）→ 原样返回，绝不静默吞错误：返回值带 {ir, llm_used}。
 */
async function rewriteWithLLM(ir, cfg) {
  const url = cfg && cfg.h3ir && cfg.h3ir.llmUrl ? String(cfg.h3ir.llmUrl) : "";
  if (!url) return { ir, llm_used: false };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: (cfg.h3ir.llmModel || "default"),
        messages: [
          { role: "system", content: "You are the MiniMax H3 Context-IR rewriter. Rewrite the user's IR so that subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape and non_diegetic_music are fully in English, preserving all <Subject N>/<Picture N>/<Audio N> labels, speaker IDs (S1...) and dialogue verbatim inside <d>[Language]...</d> tags. Output only the rewritten IR." },
          { role: "user", content: ir }
        ],
        temperature: 0.3, max_tokens: 3000
      }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!res.ok) return { ir, llm_used: false };
    const data = await res.json();
    const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!out || typeof out !== "string" || out.length < 40) return { ir, llm_used: false };
    return { ir: out.trim(), llm_used: true };
  } catch (e) {
    clearTimeout(t);
    return { ir, llm_used: false };
  }
}

module.exports = { buildFL2VA, buildRef2VA, rewriteWithLLM, lengthFrames };
