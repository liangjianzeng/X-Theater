"use strict";
/**
 * server/index.js — 引导：http server + 静态兜底 + 装配（契约 §0/§2）
 * openStore → createBus → createEngine → rules 聚合 → engine.rules 注入 →
 * createL2 → createRouter → useAuth → api/* register → 静态兜底（src/client）→ listen
 * ctx = {store, bus, engine, rules, l2, util, cfg}；cfg = {outDir: var/out, seed: true}
 * 端口 process.env.PORT || 8766；数据目录 path.join(repoRoot, "var")。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const util = require("./core/util");
const { openStore } = require("./core/store");
const { createBus } = require("./core/bus");
const { createRouter } = require("./core/router");
const { createEngine } = require("./dag/engine");

const repoRoot = path.join(__dirname, "..", "..");
// THEATER_VAR：验收套件用独立数据目录隔离（test/lib.js 注入），默认仓库 var/
const varDir = process.env.THEATER_VAR
  ? path.resolve(process.env.THEATER_VAR)
  : path.join(repoRoot, "var");
const clientDir = path.join(__dirname, "..", "client");
const PORT = Number(process.env.PORT || 8766);

fs.mkdirSync(varDir, { recursive: true });
const outDir = path.join(varDir, "out");
fs.mkdirSync(outDir, { recursive: true });

/* ---------- 装配 ---------- */
const store = openStore(varDir, { minimal: process.env.THEATER_SEED_MINIMAL === "1" });
const bus = createBus();
// comfy 通道：THEATER_COMFY=1 启用真引擎（W-B 无头 ComfyUI :8188）；不设＝stub 模式（验收套件）
const cfg = {
  outDir,
  seed: true,
  comfy: {
    enabled: process.env.THEATER_COMFY === "1",
    base: process.env.THEATER_COMFY_URL || "http://127.0.0.1:8188",
    inputDir: process.env.THEATER_COMFY_INPUT || "E:/ComfyUI/input"
  }
};
const engine = createEngine({ store, bus, cfg });

// rules 聚合（契约 §2：api ctx.rules＝rules/ 下各库聚合）。
// 开发期某库缺失不阻断启动（记警告），装配完整后自然全绿。
function tryRequire(p, label) {
  try {
    return require(p);
  } catch (e) {
    console.warn("[index] 规则库缺失 " + (label || p) + ": " + e.message);
    return null;
  }
}
const rules = {
  langlint: tryRequire("./rules/langlint", "langlint"),
  quant: tryRequire("./rules/quant", "quant"),
  license: tryRequire("./rules/license", "license"),
  moderation: tryRequire("./rules/moderation", "moderation"),
  budget: tryRequire("./rules/budget", "budget")
};
engine.rules = rules; // worker ctx.rules 由此注入

const ctx = { store, bus, engine, rules, l2: null, util, cfg };

const l2Facade = tryRequire("./l2/facade", "l2/facade");
if (l2Facade && typeof l2Facade.createL2 === "function") {
  ctx.l2 = l2Facade.createL2(ctx);
}

const router = createRouter();

// 鉴权：Authorization: Bearer <util.sign 的 token> → state.users 记录
// SSE 例外：EventSource 无法带自定义头，仅 /api/events 允许 ?token= 兜底
router.useAuth((req) => {
  let raw = "";
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  if (m) raw = m[1];
  else if (String(req.url || "").split("?")[0] === "/api/events") {
    const qi = String(req.url || "").indexOf("?");
    if (qi >= 0) raw = new URLSearchParams(req.url.slice(qi + 1)).get("token") || "";
  }
  if (!raw) return null;
  const payload = util.verify(raw);
  if (!payload) return null;
  const uidv = payload.uid || payload.id || (payload.user && payload.user.id) || null;
  if (!uidv) return null;
  const st = store.get();
  return (
    st.users[String(uidv)] ||
    (payload.role ? { id: String(uidv), name: payload.name || String(uidv), role: payload.role } : null)
  );
});

// api 模块：module.exports.register = (router, ctx) => {}
const apiDir = path.join(__dirname, "api");
if (fs.existsSync(apiDir)) {
  for (const f of fs.readdirSync(apiDir).filter((x) => /\.js$/.test(x)).sort()) {
    try {
      const mod = require(path.join(apiDir, f));
      if (mod && typeof mod.register === "function") mod.register(router, ctx);
      else console.warn("[index] api 模块无 register:", f);
    } catch (e) {
      console.error("[index] api 模块加载失败:", f, e);
    }
  }
}

/* ---------- 静态兜底（src/client；契约 §0：静态由 index.js 兜底） ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

function serveStatic(req, res) {
  let pathname = String(req.url || "/").split("?")[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch (e) {
    /* noop */
  }
  if (!pathname || pathname === "/") pathname = "/index.html";

  // /var/out/* → 产物静态面（试听/导出文件；仅 out 目录，防穿越）
  if (pathname.startsWith("/var/out/")) {
    const outRoot = path.join(varDir, "out");
    const fp = path.normalize(path.join(outRoot, pathname.slice("/var/out/".length)));
    const rootN = path.resolve(outRoot).toLowerCase();
    const fpN = path.resolve(fp).toLowerCase();
    if (fpN !== rootN && !fpN.startsWith(rootN + path.sep)) {
      return router.json(res, 403, { error: { code: "FORBIDDEN", message: "路径非法" } });
    }
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      return router.json(res, 404, { error: { code: "NOT_FOUND", message: "产物不存在" } });
    }
    try {
      const buf = fs.readFileSync(fp);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream",
        "Content-Length": buf.length,
        "Cache-Control": "no-cache"
      });
      res.end(buf);
    } catch (e) {
      router.json(res, 500, { error: { code: "INTERNAL", message: "产物读取失败" } });
    }
    return;
  }

  const rel = path.normalize(pathname).replace(/^([/\\])+/, "");
  const fp = path.normalize(path.join(clientDir, rel));
  // 防目录穿越
  const rootN = path.resolve(clientDir).toLowerCase();
  const fpN = path.resolve(fp).toLowerCase();
  if (fpN !== rootN && !fpN.startsWith(rootN + path.sep)) {
    return router.json(res, 403, { error: { code: "FORBIDDEN", message: "路径非法" } });
  }

  const ext = path.extname(fp).toLowerCase();
  let target = fp;
  if (!ext) {
    // GET / 与无扩展名路径 → SPA 兜底 index.html
    target = path.join(clientDir, "index.html");
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return router.json(res, 404, { error: { code: "NOT_FOUND", message: "资源不存在" } });
  }
  try {
    const buf = fs.readFileSync(target);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Length": buf.length
    });
    res.end(buf);
  } catch (e) {
    router.json(res, 500, { error: { code: "INTERNAL", message: "静态读取失败" } });
  }
}

/* ---------- HTTP 服务 ---------- */
const server = http.createServer((req, res) => {
  Promise.resolve(router.handle(req, res))
    .then((handled) => {
      if (handled) return;
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
      return router.json(res, 404, { error: { code: "NOT_FOUND", message: "资源不存在" } });
    })
    .catch((err) => {
      const code = err && typeof err.code === "string" ? err.code : "INTERNAL";
      router.json(res, router.statusOf({ code }), {
        error: { code, message: (err && err.message) || "服务器内部错误" }
      });
    });
});

server.listen(PORT, () => {
  console.log("theater server on :" + PORT);
});

module.exports = { server, ctx, store, bus, engine, router };
