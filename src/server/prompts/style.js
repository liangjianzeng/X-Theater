"use strict";
/**
 * prompts/style.js — 风格包层（提示词体系 L0，2026-11-22）
 *
 * 方案（docs/theater-prompt-system-plan.md §6.2）落地：project.style_pkg（既有 {look,palette,ratio}
 * 形态向后兼容）按 look 名并入内置风格包，得到 t2i 后缀 / 视频风格 / IR grade / mood→光线 /
 * 场景→环境音 / 配乐 tags 的完整包；t2i.local / t2i.remote / t2v.local / h3ir 四处演示剧硬编码（车道名已按 2026-11-22 能力化迁移更新）
 * （"青橙影调，雨夜烛光" 等）全部改由本层供给。
 *
 * 优先级：project.style_pkg 覆盖 内置包（按 look 匹配）覆盖 DEFAULT。
 * 纪律：任何 worker 提示词里不允许再出现与具体剧集无关的写死风格词。
 */

const DEFAULT_STYLE_PKG = {
  look: "写实电影感",
  palette: "通用",
  ratio: "9:16",
  grade_line: "natural filmic color grade",
  t2i_suffix: "实拍电影剧照质感，真实摄影，自然皮肤纹理与真实光影，浅景深",
  video_suffix_zh: "电影感镜头运动，写实光影，浅景深",
  light_by_mood: {},
  ambience_by_env: {},
  music_tags: "",
  negative_extra: ""
};

/* 内置风格包：key = style_pkg.look（templates.js 六款题材的 style.look 与种子项目落在这几档） */
const BUILTIN_LOOKS = {
  "写实电影感": {
    grade_line: "natural filmic grade",
    t2i_suffix: "实拍电影剧照质感，真实摄影，35mm 胶片颗粒，自然皮肤纹理与真实光影，浅景深",
    video_suffix_zh: "电影感镜头运动，写实光影，浅景深"
  },
  "柔光唯美": {
    grade_line: "soft romantic grade with airy highlights",
    t2i_suffix: "柔光唯美电影感画面，真实摄影，柔和漫射光，细腻皮肤质感，浅景深",
    video_suffix_zh: "电影感镜头运动，柔光唯美，浅景深"
  },
  "冷冽悬疑": {
    grade_line: "cold desaturated suspense grade",
    t2i_suffix: "冷冽悬疑电影感画面，真实摄影，冷色调低照度，自然皮肤纹理，浅景深",
    video_suffix_zh: "电影感镜头运动，冷冽影调，浅景深"
  },
  "夜色胶片": {
    grade_line: "teal-orange night grade",
    t2i_suffix: "实拍电影剧照质感，真实摄影，35mm 胶片颗粒，自然皮肤纹理，青橙影调，夜色氛围，浅景深",
    video_suffix_zh: "电影感镜头运动，青橙影调，夜色氛围，浅景深"
  }
};

function clone(o) { return o && typeof o === "object" ? JSON.parse(JSON.stringify(o)) : {}; }
function merge(dst, src) {
  if (!src || typeof src !== "object") return dst;
  Object.keys(DEFAULT_STYLE_PKG).forEach((k) => {
    if (src[k] === undefined || src[k] === null) return;
    if (k === "light_by_mood" || k === "ambience_by_env") {
      dst[k] = Object.assign({}, dst[k] || {}, src[k]);
    } else {
      dst[k] = src[k];
    }
  });
  return dst;
}

/** 解析某集生效风格包：project.style_pkg ⊕ 内置包（按 look）⊕ DEFAULT */
function resolve(ctx, episodeId) {
  let pjPkg = null;
  try {
    const st = ctx.store.get();
    const ep = st.episodes && st.episodes[episodeId];
    const pj = ep && st.projects && st.projects[ep.projectId];
    pjPkg = (pj && pj.style_pkg) || null;
  } catch (e) { pjPkg = null; }
  const look = pjPkg && String(pjPkg.look || "").trim();
  const base = BUILTIN_LOOKS[look] || {};
  return merge(merge(clone(DEFAULT_STYLE_PKG), base), pjPkg || {});
}

/** IR 顶部风格行（h3ir FL2VA/Ref2VA 用，英文） */
function irStyleEn(pkg) {
  const p = pkg || DEFAULT_STYLE_PKG;
  return "Live-action cinematic look, " + (p.grade_line || DEFAULT_STYLE_PKG.grade_line) +
    ", matte natural skin with no oily shine, subtle film grain, shallow depth of field";
}

module.exports = { DEFAULT_STYLE_PKG, BUILTIN_LOOKS, resolve, irStyleEn };
