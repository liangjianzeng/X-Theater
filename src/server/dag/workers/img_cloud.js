"use strict";
/**
 * dag/workers/img_cloud.js — 付费云 API 图像车道（2026-11-22 用户要求：引擎目标全可配）
 *
 * 目标类型 kind:"cloud" 的算力节点（运维台「算力节点」登记）＝非 ComfyUI 的付费 API：
 *   node.api = { endpoint, key, model, price_cents }  —— OpenAI 兼容 /v1/images/generations 适配。
 * 路由全走既有机制：引擎注册表把 img_cloud 车道改绑到云节点（POST /api/admin/registry/node），
 * 剧集驱动/用户默认算力指到云节点 → 引擎 laneBoundTo(family img) 自动落到本车道。
 * 计费诚实：cents＝node.api.price_cents（每张价，运维自填）；0＝不计费（影子账本跳过）。
 * 密钥只在服务端 state（与 llm bat 路径同信任级），不回显、不进审计/账本。
 */

const fs = require("fs");
const path = require("path");

const NAME = "img_cloud";
const ENGINE_USER = "付费云 API"; // 语言表纪律：用户面不带型号
const TIMEOUT_MS = 120 * 1000;

function safeSeg(s) {
  return String(s || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

function writeOut(ctx, fileName, data) {
  const dir = path.join(String((ctx && ctx.cfg && ctx.cfg.outDir) || path.join("var", "out")));
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, safeSeg(fileName));
  fs.writeFileSync(fp, data);
  return fp;
}

/** 云节点档案解析：注册表 lane→node 绑定（唯一事实源）→ node.api；entry.endpoint 可作覆写 */
function resolveApi(ctx, job) {
  const st = ctx.store.get();
  const reg = (st.settings || {}).registry || {};
  const hit = Object.keys(reg).map((k) => reg[k]).find((e) => e && e.lane === NAME && e.node);
  const nodeId = hit && hit.node;
  const nd = nodeId && (st.nodes || {})[nodeId];
  const api = nd && nd.api ? nd.api : null;
  const endpoint = (api && api.endpoint) || (hit && hit.endpoint) || "";
  if (!endpoint) {
    throw { code: "CLOUD_NOT_CONFIGURED", message: "云 API 车道未配置端点——运维台「算力节点」给云节点填 api.endpoint（OpenAI 兼容 /v1 基址）" };
  }
  if (!(api && api.key)) {
    throw { code: "CLOUD_NOT_CONFIGURED", message: "云 API 密钥未配置——运维台「算力节点」编辑该云节点填 api.key" };
  }
  return {
    endpoint: String(endpoint).replace(/\/+$/, ""),
    key: api.key,
    model: (api && api.model) || (hit && hit.engine) || "",
    price_cents: Math.max(0, Math.round(Number(api && api.price_cents) || 0)),
    node_label: (nd && nd.label) || nodeId || NAME
  };
}

function imagesUrl(base) {
  // 基址兼容：已带 /v1 → 直拼 images/generations；否则补 /v1
  return /\/v\d+(\/)?$/.test(base)
    ? base.replace(/\/+$/, "") + "/images/generations"
    : base.replace(/\/+$/, "") + "/v1/images/generations";
}

async function run(job, ctx) {
  const j = job || {};
  const p = j.payload || {};
  const api = resolveApi(ctx, j);
  const prompt = String(p.prompt || p.brief || p.desc || p.title || "").trim();
  if (!prompt) throw { code: "BAD_REQUEST", message: "云生图缺提示词（payload.prompt/brief 均空）" };
  const size = p.width > 0 && p.height > 0 ? Math.round(p.width) + "x" + Math.round(p.height) : undefined;

  const body = { model: api.model || undefined, prompt, n: 1 };
  if (size) body.size = size;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, data;
  try {
    res = await fetch(imagesUrl(api.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + api.key },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  } catch (e) {
    clearTimeout(timer);
    throw { code: "CLOUD_UNREACHABLE", message: "云 API 不可达（" + api.node_label + "）：" + String((e && e.message) || e).slice(0, 120) };
  }
  clearTimeout(timer);
  if (!res.ok) {
    const msg = (data && (data.error && data.error.message || data.message)) || ("HTTP " + res.status);
    throw { code: "CLOUD_API_ERROR", message: "云 API 拒绝（" + res.status + "）：" + String(msg).slice(0, 160) };
  }

  const item = (data && Array.isArray(data.data) && data.data[0]) || null;
  if (!item) throw { code: "CLOUD_BAD_RESPONSE", message: "云 API 返回无图像数据（data[0] 缺失）" };

  let bytes = null;
  if (item.b64_json) {
    bytes = Buffer.from(String(item.b64_json), "base64");
  } else if (item.url) {
    const r2 = await fetch(String(item.url), { signal: AbortSignal.timeout(60 * 1000) });
    if (!r2.ok) throw { code: "CLOUD_DOWNLOAD_FAIL", message: "云端产物下载失败（HTTP " + r2.status + "）" };
    bytes = Buffer.from(await r2.arrayBuffer());
  }
  if (!bytes || !bytes.length) throw { code: "CLOUD_EMPTY", message: "云 API 返回空图像" };

  const ext = bytes.length > 3 && bytes.toString("latin1", 0, 3) === "\xff\xd8\xff" ? ".jpg" : ".png";
  const fn = safeSeg("cloud_" + (j.id || Date.now())) + ext;
  const art = "var/out/" + fn;
  const abs = writeOut(ctx, fn, bytes);
  const meta = {
    kind: "image-cloud", // 诚实标注：付费云产物，非本机/自部署
    lane: NAME, engine: api.model || ENGINE_USER, engine_user: ENGINE_USER,
    node: api.node_label, jobType: j.type || null, episodeId: p.episodeId || j.episodeId || null,
    endpoint_host: (function () { try { return new URL(api.endpoint).host; } catch (e) { return ""; } })(),
    price_cents: api.price_cents,
    bytes: bytes.length
  };
  writeOut(ctx, fn + ".meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));

  const out = { ok: true, cents: api.price_cents, art, meta, engine: ENGINE_USER, path: art };
  j.result = out;
  j.art = out;
  return out;
}

module.exports = { name: NAME, lane: NAME, run };
