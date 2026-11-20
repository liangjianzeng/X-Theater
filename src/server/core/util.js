"use strict";
/**
 * core/util.js — 工具：uid / hash12 / now / sign / verify / cas
 * 契约 §2：确定性纪律——禁用 Math.random，一切伪随机从 hash12 派生。
 * 零 npm 依赖，只用 Node 内置模块。
 */

const crypto = require("crypto");

// 演示密钥（一期自能力期硬编码即可，二期换 KMS/环境变量）
const SECRET = "x-theater-phase1-demo-secret";

/* ---------- 单调时钟 ---------- */
let _lastTs = 0;
function now() {
  const t = Date.now();
  _lastTs = t > _lastTs ? t : _lastTs + 1; // 单调不减（契约 §9）
  return _lastTs;
}

/* ---------- 确定性哈希 ---------- */
function canonical(v) {
  if (v === null || typeof v !== "object") return v === undefined ? null : v;
  if (Array.isArray(v)) return v.map(canonical);
  const o = {};
  for (const k of Object.keys(v).sort()) {
    if (v[k] === undefined) continue;
    o[k] = canonical(v[k]);
  }
  return o;
}

/** hash12(obj) → 12 位 hex（键序无关，同输入同输出） */
function hash12(obj) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(obj)), "utf8")
    .digest("hex")
    .slice(0, 12);
}

/* ---------- uid ---------- */
let _seq = 0;
function uid(pfx) {
  _seq += 1;
  const p = pfx || "id";
  return p + "_" + hash12({ p, t: now(), c: _seq });
}

/* ---------- token：base64url(json).hmac ---------- */
function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString("utf8");
}
function hmacHex(payload) {
  return b64url(crypto.createHmac("sha256", SECRET).update(payload, "utf8").digest());
}

/** sign(obj) → token（"payload.sig"） */
function sign(obj) {
  const payload = b64url(JSON.stringify(obj == null ? {} : obj));
  return payload + "." + hmacHex(payload);
}

/** verify(token) → obj | null（签名不符/被篡改/过期 → null） */
function verify(token) {
  if (typeof token !== "string") return null;
  const i = token.lastIndexOf(".");
  if (i <= 0 || i === token.length - 1) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = hmacHex(payload);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expect, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(b64urlDecode(payload));
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.exp === "number" && obj.exp < now()) return null; // 可选 TTL（l2 审批令牌用）
    return obj;
  } catch (e) {
    return null;
  }
}

/* ---------- CAS ---------- */
/** cas(entity, ver)：版本不匹配 → throw {code:"STALE"}（HTTP 层转 409） */
function cas(entity, ver) {
  if (!entity || entity.ver !== ver) {
    const err = { code: "STALE", message: "上下文已变" };
    throw err;
  }
  return entity;
}

module.exports = { uid, hash12, now, sign, verify, cas, SECRET };
