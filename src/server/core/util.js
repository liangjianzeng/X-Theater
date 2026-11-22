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

/* ---------- stub 占位图（素材中心 2026-11-22 修复：图片「显示不出」） ----------
 * 旧 stub 产物是 1×1 透明 PNG——网格里放大等于一片空白，用户看到的就是「没有图」。
 * 行业口径：占位图必须可见且自明。零依赖手写 PNG（CRC32 + zlib.deflateSync）：
 * 深底斜纹＋边框＋中缝留白，740×1280 竖屏，任何卡片/灯箱里一眼可辨「这是占位不是成品」。 */
const CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 可见占位 PNG（RGB）：底 #232936，斜纹 #2E3646，边框 #46516A，中线留白。确定性输出。 */
function stubPng(width, height) {
  const w = Math.max(1, Math.min(4096, Number(width) || 720)) | 0;
  const h = Math.max(1, Math.min(4096, Number(height) || 1280)) | 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const base = [0x23, 0x29, 0x36], stripe = [0x2e, 0x36, 0x46], frame = [0x46, 0x51, 0x6a], mid = [0x1c, 0x21, 0x2b];
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      let c = base;
      const isFrame = x < 6 || y < 6 || x >= w - 6 || y >= h - 6;
      if (isFrame) c = frame;
      else if (((x + y) / 48) % 2 < 1) c = stripe;
      else if (Math.abs(x - w / 2) < 3) c = mid;
      raw[p++] = c[0]; raw[p++] = c[1]; raw[p++] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  const zlib = require("zlib");
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---------------- 图像尺寸自适应（2026-11-22 素材中心：比例×清晰度两维） ---------------- */

/** 从 PNG/JPEG 字节读宽高（编辑模式按参考图自适应输出尺寸用）。失败返回 null。
 *  PNG：IHDR 定长（offset 16 起大端 W/H）；JPEG：段扫描 SOF0/SOF1/SOF2（C0/C1/C2）。 */
function imgSizeOfBuf(buf) {
  try {
    if (!buf || buf.length < 32) return null;
    // PNG 魔数 89504E47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG 魔数 FFD8；逐段找 SOF（C0/C1/C2/C3 除外 C4/C8/CC 段类型）
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        off += 2 + len;
      }
    }
  } catch (e) { /* fallthrough */ }
  return null;
}

/** 比例×清晰度 → 引擎安全像素（align 对齐 + maxMP/maxEdge 回落）。
 *  caps={align,maxMP,maxEdge}：img5060（16G 卡）={8,2.1,1920}；imgspark（DGX）={16,4.2,2048}。
 *  超能力等比就近回落，返回 {w,h,downgraded}（downgraded=true 时调用方必须进 meta 如实标注）。 */
function imgSpecFor(spec, caps) {
  const RATIO_STD = {
    "9:16": [720, 1280], "16:9": [1280, 720], "1:1": [1024, 1024],
    "3:4": [960, 1280], "4:3": [1280, 960], "21:9": [1520, 656]
  };
  const TIER_BASE = { "9:16": 720, "16:9": 1280, "1:1": 1024 }; // 高清/超清按短边基准等比推算
  const ratio = String((spec && spec.ratio) || "9:16");
  const tier = String((spec && spec.tier) || "standard");
  const caps_ = Object.assign({ align: 16, maxMP: 4.2, maxEdge: 2048 }, caps || {});
  const al = Math.max(8, Math.round(caps_.align) || 16);
  const align = (v) => Math.max(al, Math.round(v / al) * al);
  let target = RATIO_STD[ratio];
  if (!target) target = [720, 1280];
  if (tier === "hd" || tier === "uhd") {
    // 高清≈2MP（9:16→1080×1920）、超清≈4.2MP（9:16→1152×2048）；其余比例按面积等比推算后对齐
    const area = tier === "uhd" ? 2048 * 2048 : 1080 * 1920;
    const [rw, rh] = target;
    const scale = Math.sqrt(area / (rw * rh));
    target = [align(rw * scale), align(rh * scale)];
  }
  let w = Math.round(target[0]), h = Math.round(target[1]);
  // 引擎能力回落：单边超 maxEdge 或面积超 maxMP → 等比缩进能力内（对齐后取最小可行档）
  const mp = (w * h) / 1e6;
  if (w > caps_.maxEdge || h > caps_.maxEdge || mp > caps_.maxMP) {
    const byEdge = Math.min(caps_.maxEdge / w, caps_.maxEdge / h);
    const byArea = Math.sqrt((caps_.maxMP * 1e6) / (w * h));
    const k = Math.min(byEdge, byArea);
    w = align(w * k); h = align(h * k);
    // 对齐向上取整可能再次越界：二次钳到边内（等步收缩直到入界）
    while (w > caps_.maxEdge || h > caps_.maxEdge || (w * h) / 1e6 > caps_.maxMP) {
      w = Math.max(al, w - al);
      h = Math.max(al, h - al);
    }
    return { w, h, downgraded: true };
  }
  return { w, h, downgraded: false };
}

module.exports = { uid, hash12, now, sign, verify, cas, stubPng, imgSizeOfBuf, imgSpecFor, SECRET };
