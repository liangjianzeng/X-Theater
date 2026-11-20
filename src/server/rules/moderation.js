"use strict";
/**
 * rules/moderation.js —— 机审 stub（纯函数，确定性；audit/队列副作用由调用方做）
 * 依据：CONTRACT §4（moderate：黑名单词命中→fail_review；抽帧 stub＝hash 尾数送复审）
 * 本实现按任务书口径：shot.id 尾号 "7" → 必送复审（V6 演示路径）；hash 尾数 <0.08 → 送复审。
 */

const BLACKLIST = ["涉政", "血腥", "暴力", "色情", "裸露", "毒品", "赌博", "恐怖", "辱骂", "违禁"];
const REVIEW_REASON = "复审：疑似元素";
const HASH_FAIL_THRESHOLD = 0.08;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 取 12 位 hex hash：优先 ctx.util.hash12，缺失时用内置 FNV-1a 兜底（仍确定性） */
function hash12of(util, obj) {
  if (util && typeof util.hash12 === "function") {
    try {
      const h = String(util.hash12(obj) || "");
      if (/^[0-9a-fA-F]{2,}$/.test(h)) return h.toLowerCase();
    } catch (e) {
      /* fallthrough */
    }
  }
  const s = JSON.stringify(obj);
  return fnv1a(s) + fnv1a(s + "|x").slice(0, 4);
}

/**
 * inspect(shot, {store, util}) → {pass:true, checks:[]}
 *                       | {pass:false, reason:"复审：疑似元素", checks:[...], shotId}
 * checks 记录命中来源：blacklist:词 / frame_tail7 / frame_hash（确定性，同输入同结果）。
 */
function inspect(shot, deps) {
  const d = deps || {};
  const s = shot && typeof shot === "object" ? shot : {};
  const id = s.id != null ? String(s.id) : "";
  const checks = [];

  const text = [s.name, s.title, s.desc, s.note]
    .filter((x) => typeof x === "string" && x.length)
    .join(" ");
  const hits = BLACKLIST.filter((w) => text.includes(w));
  if (hits.length) checks.push("blacklist:" + hits.join(","));

  // 「第 7 镜必送复审」＝V6 演示路径；对新建集（id 尾为随机 hash）按镜序 seq 判定
  const seqNum = Number(
    s.seq != null ? s.seq : s.n != null ? s.n : (id.match(/(\d+)$/)||[])[1]
  );
  if (Number(s.global_rank) === 7 || seqNum === 7 || id.endsWith("7")) checks.push("frame_rank7");

  const h = hash12of(d.util, { id, frame: "probe" });
  const frac = parseInt(h.slice(-2), 16) / 256;
  if (frac < HASH_FAIL_THRESHOLD) checks.push("frame_hash");

  if (checks.length) {
    return { pass: false, reason: REVIEW_REASON, checks, shotId: id };
  }
  return { pass: true, checks: [], shotId: id };
}

module.exports = { inspect, BLACKLIST, REVIEW_REASON, HASH_FAIL_THRESHOLD };
