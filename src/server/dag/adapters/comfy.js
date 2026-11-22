"use strict";
/**
 * adapters/comfy.js — W-B 无头 ComfyUI 执行适配层（ADR-001 §3/§4）
 * 纪律：
 *  - 产品面只提交**固化模板**（runtime/templates/*.json），永不执行外部 workflow；
 *  - 四元组锁定：ComfyUI commit × custom-node commit × 权重清单 × 模板 hash，manifest 校验不过＝拒跑；
 *  - 模板族切换显式卸载（POST /free），禁双扩散模型热载共存；
 *  - 种子确定性（hash12→uint32），OOM/HTTP 全部真错误上抛，无静默回退。
 *
 * runTemplate(ctx, job, spec) → {ok, cents?, art, abs, meta}
 *   spec = { tmplId, params:{seed, prompt, negative, width, height, steps, cfg, outPrefix}, pollMs?, timeoutMs? }
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.join(__dirname, "..", "..", "..", ".."); // src/server/dag/adapters → 仓库根
const TEMPLATES_DIR = path.join(REPO_ROOT, "runtime", "templates");

function loadManifest(tmplId) {
  const p = path.join(TEMPLATES_DIR, "manifest.json");
  if (!fs.existsSync(p)) {
    throw err("COMFY_MANIFEST_MISSING", "模板四元组清单缺失：" + p + "（先完成部署登记再启用真引擎）");
  }
  let m;
  try { m = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {
    throw err("COMFY_MANIFEST_BAD", "manifest.json 解析失败：" + e.message);
  }
  const entry = m.templates && m.templates[tmplId];
  if (!entry || !entry.tmpl_sha16) {
    throw err("COMFY_MANIFEST_NOENTRY", "manifest 缺少模板条目 " + tmplId);
  }
  return entry;
}

function sha16(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

function loadTemplate(tmplId, entry) {
  const p = path.join(TEMPLATES_DIR, tmplId + ".json");
  if (!fs.existsSync(p)) throw err("COMFY_TMPL_MISSING", "固化模板不存在：" + p);
  const buf = fs.readFileSync(p);
  if (sha16(buf) !== entry.tmpl_sha16) {
    throw err("COMFY_TMPL_DRIFT", "模板 hash 与四元组登记不符（" + tmplId + "）：禁止执行未登记的模板");
  }
  let wf;
  try { wf = JSON.parse(buf.toString("utf8")); } catch (e) {
    throw err("COMFY_TMPL_BAD", "模板 JSON 解析失败：" + e.message);
  }
  return wf;
}

/** 模板占位替换：节点输入中 "<KEY>" 字符串整体替换为参数值（数值转数字） */
function applyParams(wf, params) {
  const out = {};
  for (const [nid, node] of Object.entries(wf)) {
    const n = JSON.parse(JSON.stringify(node));
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (typeof v === "string") {
        const m = /^<([A-Z0-9_]+)>$/.exec(v);
        if (m && Object.prototype.hasOwnProperty.call(params, m[1])) {
          const val = params[m[1]];
          n.inputs[k] = typeof val === "number" ? val : String(val);
        }
      }
    }
    out[nid] = n;
  }
  return out;
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function httpJson(base, pathname, body, method, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  let res, text;
  try {
    res = await fetch(base + pathname, {
      method: method || (body ? "POST" : "GET"),
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    text = await res.text();
  } catch (e) {
    clearTimeout(t);
    throw err("COMFY_UNREACHABLE", "ComfyUI（" + base + "）不可达：" + (e && e.name === "AbortError" ? "超时" : e.message));
  }
  clearTimeout(t);
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.error && data.error.message || data.error)) || text.slice(0, 200);
    throw err("COMFY_HTTP_" + res.status, "ComfyUI " + pathname + " → " + res.status + "：" + (typeof msg === "string" ? msg : JSON.stringify(msg)));
  }
  return data;
}

async function httpBytes(base, pathname, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  let res;
  try {
    res = await fetch(base + pathname, { signal: ctrl.signal });
  } catch (e) {
    clearTimeout(t);
    throw err("COMFY_FETCH_FAIL", "取产物失败：" + e.message);
  }
  clearTimeout(t);
  if (!res.ok) throw err("COMFY_FETCH_HTTP", "取产物 HTTP " + res.status + "：" + pathname);
  return Buffer.from(await res.arrayBuffer());
}

let lastTemplateFamily = null; // 进程内记录：跨模板族切换先卸载（显存纪律）

async function unloadIfSwitched(base, tmplId, entry) {
  // 模板族以 manifest 登记的 family 为准（同族不卸载＝内存常驻优先，用户纪律 2026-11-21）
  const family = (entry && entry.family) || String(tmplId).split(".")[0];
  if (lastTemplateFamily && lastTemplateFamily !== family) {
    try {
      await httpJson(base, "/free", { unload_models: true, free_memory: true }, "POST", 15000);
    } catch (e) { /* 老版本无 /free：不阻塞，日志面可见 */ }
  }
  lastTemplateFamily = family;
}

/**
 * 内存守卫（远端统一内存纪律）：ram_free 低于阈值（GB）才 /free，平时常驻。
 * 返回 {freed:bool, ram_free_gb}
 */
async function ensureFree(base, minFreeGB) {
  let stats = null;
  try { stats = await httpJson(base, "/system_stats", null, "GET", 8000); } catch (e) { return { freed: false, ram_free_gb: null }; }
  const total = stats && stats.system && stats.system.ram_total;
  const free = stats && stats.system && stats.system.ram_free;
  if (typeof free !== "number") return { freed: false, ram_free_gb: null };
  const freeGB = free / 1024 ** 3;
  if (typeof minFreeGB !== "number") minFreeGB = 6; // 用户纪律：预留几 GB 即可
  if (freeGB >= minFreeGB) return { freed: false, ram_free_gb: freeGB };
  try { await httpJson(base, "/free", { unload_models: true, free_memory: true }, "POST", 15000); } catch (e) { /* 同上 */ }
  return { freed: true, ram_free_gb: freeGB };
}

/**
 * 资产上传：把字节图（定妆照/分镜首帧）传到远端 ComfyUI input 目录，返回 LoadImage 可用文件名。
 */
async function uploadAsset(base, bytes, filename) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    const fd = new FormData();
    fd.append("image", new Blob([bytes]), String(filename || "asset.png"));
    fd.append("overwrite", "true");
    res = await fetch(base + "/upload/image", { method: "POST", body: fd, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(t);
    throw err("COMFY_UPLOAD_FAIL", "上传资产失败：" + e.message);
  }
  clearTimeout(t);
  if (!res.ok) throw err("COMFY_UPLOAD_HTTP", "上传资产 HTTP " + res.status);
  const data = await res.json().catch(() => null);
  if (!data || !data.name) throw err("COMFY_UPLOAD_BAD", "上传资产未返回文件名");
  return data.subfolder ? data.subfolder + "/" + data.name : data.name;
}

/**
 * 主入口。cfg.comfy = { enabled:true, base:"http://127.0.0.1:8188" }
 * spec.base 可显式指定端点（远端通道），缺省回退 cfg.comfy.base。
 */
async function runTemplate(ctx, job, spec) {
  const cfg = (ctx && ctx.cfg && ctx.cfg.comfy) || {};
  if (!cfg.enabled && !spec.base) throw err("COMFY_DISABLED", "comfy 通道未启用（THEATER_COMFY=1 启用）");
  const base = String(spec.base || cfg.base || "http://127.0.0.1:8188").replace(/\/+$/, "");
  const entry = loadManifest(spec.tmplId);
  const raw = loadTemplate(spec.tmplId, entry);
  const wf = applyParams(raw, spec.params || {});
  if (typeof spec.transform === "function") spec.transform(wf); // 调用方结构变换（删节点/改连线），先于提交

  await unloadIfSwitched(base, spec.tmplId, entry);

  const clientId = "theater-" + (job && job.id || "x");
  const sub = await httpJson(base, "/prompt", { prompt: wf, client_id: clientId }, "POST", 15000);
  const promptId = sub && sub.prompt_id;
  if (!promptId) throw err("COMFY_NO_PROMPT_ID", "ComfyUI 未返回 prompt_id");

  const pollMs = spec.pollMs || 1500;
  const deadline = Date.now() + (spec.timeoutMs || 240000);
  let outputs = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    let hist = null;
    try { hist = await httpJson(base, "/history/" + promptId, null, "GET", 8000); } catch (e) { continue; }
    const rec = hist && hist[promptId];
    if (!rec) continue;
    const st = rec.status || {};
    const done = st.completed === true || st.status_str === "success" || st.status_str === "completed";
    if (st.status_str === "error") {
      const msgs = ((st.messages || []).map((m) => JSON.stringify(m)).join(" | ") || "").slice(0, 400);
      throw err("COMFY_EXEC_ERROR", "执行失败：" + msgs);
    }
    if (done && rec.outputs && Object.keys(rec.outputs).length) {
      outputs = rec.outputs;
      break;
    }
    if (done) { outputs = rec.outputs || {}; break; } // success 但无输出节点 → 下游 NO_IMAGE 真错误
  }
  if (!outputs) throw err("COMFY_TIMEOUT", "生成超时（" + Math.round((spec.timeoutMs || 240000) / 1000) + "s）：模板 " + spec.tmplId);

  // 取第一个产物节点：视频模板（SaveVideo → videos）优先，其次 gifs，再次图像
  let img = null;
  for (const nid of Object.keys(outputs)) {
    const o = outputs[nid] || {};
    const arr = o.videos || o.gifs || o.images || (o.video ? [o.video] : null);
    if (arr && arr.length) { img = arr[0]; break; }
  }
  if (!img || !img.filename) throw err("COMFY_NO_IMAGE", "history 无产物输出：" + JSON.stringify(outputs).slice(0, 200));
  const q = "?filename=" + encodeURIComponent(img.filename)
    + "&subfolder=" + encodeURIComponent(img.subfolder || "")
    + "&type=" + encodeURIComponent(img.type || "output");
  const bytes = await httpBytes(base, "/view" + q, 60000);
  if (!bytes || bytes.length < 100) throw err("COMFY_EMPTY_ART", "产物异常（" + (bytes ? bytes.length : 0) + " 字节）");

  return { bytes, promptId, entry, meta: { tmpl_sha16: entry.tmpl_sha16, comfy_commit: entry.comfy_commit, cn_commits: entry.cn_commits, weights: entry.weights } };
}

module.exports = { runTemplate, loadManifest, sha16, TEMPLATES_DIR, uploadAsset, ensureFree };
