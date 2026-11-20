"use strict";
/**
 * rules/license.js —— 配乐版权双许可（纯函数，确定性）
 * 依据：CONTRACT §3（交付预检·配乐双许可）· §4（music license{model,usage}）
 * 规则：license.model / license.usage 任一 falsy，或 usage==="missing" → fail。
 */

/**
 * check(track) → {ok:boolean, missing:string[]}
 * track 形如 {id,title,license:{model,usage}}。
 */
function check(track) {
  if (!track || typeof track !== "object") {
    return { ok: false, missing: ["track"] };
  }
  const missing = [];
  const lic = track.license && typeof track.license === "object" ? track.license : {};
  if (!lic.model) missing.push("license.model");
  if (!lic.usage || lic.usage === "missing") missing.push("license.usage");
  return { ok: missing.length === 0, missing };
}

/**
 * precheckMusic(sceneSlots, lib) → 逐场结果数组
 * sceneSlots=[{sceneId, trackId?|musicId?|track?}]；lib＝曲库（music_lib）数组。
 * 每项 → {sceneId, trackId, title, pass, missing[], note|null}
 */
function precheckMusic(sceneSlots, lib) {
  const slots = Array.isArray(sceneSlots) ? sceneSlots : [];
  const libArr = Array.isArray(lib) ? lib : [];
  return slots.map((slot) => {
    const sc = slot || {};
    const sceneId = sc.sceneId != null ? sc.sceneId : sc.scene != null ? sc.scene : null;
    const trackId = sc.trackId != null ? sc.trackId : sc.musicId != null ? sc.musicId : sc.id != null ? sc.id : null;
    let track = sc.track && typeof sc.track === "object" ? sc.track : null;
    if (!track && trackId != null) {
      track = libArr.find((t) => t && t.id === trackId) || null;
    }
    if (!track) {
      return {
        sceneId,
        trackId: trackId,
        title: null,
        pass: false,
        missing: ["track"],
        note: trackId != null ? "配乐许可不完整：曲库查无此曲（" + trackId + "）" : "配乐许可不完整：该场未挂曲",
      };
    }
    const r = check(track);
    return {
      sceneId,
      trackId: trackId != null ? trackId : track.id != null ? track.id : null,
      title: track.title != null ? track.title : null,
      pass: r.ok,
      missing: r.missing,
      note: r.ok ? null : "配乐许可不完整：" + r.missing.join("、") + "（引用曲 usage 必须为 ok）",
    };
  });
}

module.exports = { check, precheckMusic };
