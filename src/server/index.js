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
const { openStore, DEFAULT_LANE_NODE } = require("./core/store");
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
const tenants = require("./core/tenants");
// bus 带域解析器（S3-6）：订阅端可按域过滤 SSE——消息体里的 project/episode/episodeId/card/shotId
// 反查归属域；解析不出（系统级消息如 alerts）→ 广播给所有人。
const bus = createBus({
  tidOf(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (obj.tid) return obj.tid;
    if (obj.job && obj.job.tid) return obj.job.tid;
    try {
      const st = store.get();
      if (obj.project && obj.project.tenantId) return obj.project.tenantId;
      if (obj.episode && obj.episode.tenantId) return obj.episode.tenantId;
      let eid =
        obj.episodeId ||
        (obj.card && obj.card.episodeId) ||
        (obj.ep && obj.ep.id) ||
        null;
      if (!eid && obj.shotId) {
        eid = ((st.shots || {})[obj.shotId] || {}).episodeId || null;
      }
      if (eid) return ((st.episodes || {})[eid] || {}).tenantId || null;
    } catch (e) { /* 反查失败＝广播 */ }
    return null;
  }
});
// comfy 通道：THEATER_COMFY=1 启用真引擎（W-B 无头 ComfyUI :8188）；不设＝stub 模式（验收套件）
// comfyRemote 通道：THEATER_COMFY_REMOTE=1 启用远端 ComfyUI（H3 线 t2v.remote/t2i.remote 真引擎；
//   旧部署种子 THEATER_COMFY_SPARK / THEATER_COMFY_SPARK_URL 仍读——env 名是外部契约，仅此一处兼容）
// 端点解析（2026-11-22 节点注册表化）：一律经 cfg.laneBase(lane)→注册表 lane→node 绑定→节点档案，
// 运维台改绑定/改端点热生效，单一事实源是 state.nodes——代码里不再写死机器 IP。
// env 仅作内建回退表覆盖不到时的部署种子（老部署路径）。
const LANE_ENV_FALLBACK = {
  "t2i.local": "THEATER_COMFY_URL", "t2v.local": "THEATER_COMFY_URL",
  "t2i.remote": process.env.THEATER_COMFY_REMOTE_URL ? "THEATER_COMFY_REMOTE_URL" : "THEATER_COMFY_SPARK_URL",
  "t2v.remote": process.env.THEATER_COMFY_REMOTE_URL ? "THEATER_COMFY_REMOTE_URL" : "THEATER_COMFY_SPARK_URL"
};
const laneBase = (lane) => {
  try {
    const st = store.get();
    const reg = (st.settings && st.settings.registry) || {};
    const hit = Object.keys(reg).map((k) => reg[k]).find((e) => e && e.lane === lane && e.node);
    const nodeId = hit ? hit.node : DEFAULT_LANE_NODE[lane];
    const nd = nodeId && st.nodes && st.nodes[nodeId];
    if (!nd) return process.env[LANE_ENV_FALLBACK[lane]] || "";
    // 云 API 目标（2026-11-22）：kind:"cloud" 的节点端点在 api.endpoint（非 ComfyUI）
    if (nd.kind === "cloud" && nd.api && nd.api.endpoint) return nd.api.endpoint;
    if (nd.comfy && nd.comfy.base) return nd.comfy.base;
  } catch (e) { /* store 未就绪走 env 兜底 */ }
  return process.env[LANE_ENV_FALLBACK[lane]] || "";
};
const cfg = {
  outDir,
  seed: true,
  // lane→节点档案端点解析挂到 cfg 上：workers / 运维台 resolveServe 经 cfg.laneBase(lane) 取拨号端点
  laneBase,
  comfy: {
    enabled: process.env.THEATER_COMFY === "1",
    inputDir: process.env.THEATER_COMFY_INPUT || "E:/ComfyUI/input",
    get base() { return laneBase("t2i.local"); }
  },
  comfyRemote: {
    enabled: process.env.THEATER_COMFY_REMOTE === "1" || process.env.THEATER_COMFY_SPARK === "1",
    get base() { return laneBase("t2i.remote"); }
  },
  h3ir: {
    llmUrl: process.env.THEATER_H3IR_LLM_URL || "",   // 可选：远端 llama-server /v1 全英文 IR 重写；空＝规则拼装
    llmModel: process.env.THEATER_H3IR_LLM_MODEL || "default"
  },
  // Agent 大脑宿主机的 Comfy 端点（显存互斥监视/卸载用——与大脑同机才有显存冲突）。
  // 大脑＝llm_profiles[llm_active]：运行位置指向渲染机 → 盯那台的 Comfy；云端/远程 → 不盯任何本机 Comfy。
  get llmHostComfy() {
    try {
      const st = store.get();
      if (st.llm_active != null && st.llm_profiles && st.llm_profiles[st.llm_active]) {
        const nid = st.llm_profiles[st.llm_active].node;
        const nd = nid && st.nodes && st.nodes[nid];
        return (nd && nd.comfy && nd.comfy.base) || "";
      }
      const nd = st.nodes && (st.nodes[st.llm_node || "local"] || st.nodes.local);
      if (nd && nd.comfy && nd.comfy.base) return nd.comfy.base;
    } catch (e) { /* store 未就绪走 env */ }
    return process.env.THEATER_COMFY_URL || "";
  },
  // llm-gw 大脑：Agent LLM 档案（state.llm_profiles[state.llm_active]，api/llmprofiles.js 增删切换，热生效）；
  // 存量库未迁移时回退旧节点档案路径，env 作最终兜底
  get llm() {
    try {
      const st = store.get();
      if (st.llm_active != null && st.llm_profiles && st.llm_profiles[st.llm_active]) {
        const p = st.llm_profiles[st.llm_active];
        return { base: p.base || "", model: p.model || "default", bat: p.bat || process.env.THEATER_LLM_BAT || "" };
      }
      const node = st && st.nodes && st.nodes[st.llm_node || "local"];
      if (node && node.llm && node.llm.base) return { base: node.llm.base, model: node.llm.model || "default", bat: node.llm.bat || process.env.THEATER_LLM_BAT || "" };
    } catch (e) { /* store 未就绪走 env */ }
    return { base: process.env.THEATER_LLM_URL || "", model: process.env.THEATER_LLM_MODEL || "default", bat: process.env.THEATER_LLM_BAT || "" };
  },
  music: { url: process.env.THEATER_MUSIC_URL || "" },
  tts: { url: process.env.THEATER_TTS_URL || "" }
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

const ctx = { store, bus, engine, rules, l2: null, util, cfg, llm: null, tenants };

// llm-gw：真脑通道＋显存互斥监视（LLM 在线＝本机 Comfy 生图/拍摄被闸；engine 同步读缓存）
try {
  const llmMod = require("./llm/llm");
  ctx.llm = llmMod.create(cfg);
  llmMod.startMonitor(cfg, bus); // 看护掉线自动拉起＋alerts 通知
} catch (e) {
  console.warn("[index] llm-gw 装配失败（LLM 相关能力回退规则模式）:", e.message);
}

const l2Facade = tryRequire("./l2/facade", "l2/facade");
if (l2Facade && typeof l2Facade.createL2 === "function") {
  ctx.l2 = l2Facade.createL2(ctx);
}

const router = createRouter();

// 鉴权：凭据三路提取（2026-11-22）：Authorization Bearer ＋ Cookie theater_tok（/var/ 资产
// 标签带不上自定义头，同源自动携带）＋ ?token=（EventSource 兜底，仅 /api/events 与 /var/ 面）
function tokenOf(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  if (m) return m[1];
  const cm = /(?:^|;\s*)theater_tok=([^;]+)/.exec(String(req.headers["cookie"] || ""));
  if (cm) {
    try { return decodeURIComponent(cm[1]); } catch (e) { return cm[1]; }
  }
  const url = String(req.url || "");
  const p = url.split("?")[0];
  if (p === "/api/events" || p.startsWith("/var/out/") || p.startsWith("/var/assets/")) {
    const qi = url.indexOf("?");
    if (qi >= 0) return new URLSearchParams(url.slice(qi + 1)).get("token") || "";
  }
  return "";
}

router.useAuth((req) => {
  const raw = tokenOf(req);
  if (!raw) return null;
  const payload = util.verify(raw);
  if (!payload) return null;
  const uidv = payload.uid || payload.id || (payload.user && payload.user.id) || null;
  if (!uidv) return null;
  const st = store.get();
  const u = st.users[String(uidv)];
  // 2026-11-22 堵兜底：账号已被删/不存在 → 一律 401，不再信任 token 里的 role 造用户
  if (!u) return null;
  // 域上下文（S3-4）：token.tid 随凭据走，切换域＝重签 token
  return { id: u.id, name: u.name, role: u.role, tid: payload.tid || null };
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

  // /var/out/* 与 /var/assets/* → 产物/定妆资产静态面（仅这两个目录，防穿越）
  // 登录墙（2026-11-22）：产物不再裸奔——Bearer/Cookie/?token= 任一有效凭据才可读，
  // 账号须仍存在（与 useAuth 同一裁决）。
  const varRoots = ["/var/out/", "/var/assets/"];
  const vr = varRoots.find((p) => pathname.startsWith(p));
  if (vr) {
    const cred = util.verify(tokenOf(req));
    const uidv = cred && (cred.uid || cred.id);
    if (!uidv || !store.get().users[String(uidv)]) {
      return router.json(res, 401, { error: { code: "UNAUTHORIZED", message: "需要登录（凭据缺失或已失效）" } });
    }
    // 域级 ACL（S3-7）：资产归属反查——命中他域资产 → 404（不确认存在）；
    // 反查不到（历史/系统文件）→ 退化为登录墙语义放行。
    try {
      const assetTid = tenants.assetTid(store.get(), pathname.replace(/^\//, ""));
      if (assetTid) {
        const ctxTid = tenants.contextTid(store.get(), {
          id: uidv, role: cred.role, tid: cred.tid || null
        });
        if (assetTid !== ctxTid && cred.role !== "ops") {
          return router.json(res, 404, { error: { code: "NOT_FOUND", message: "产物不存在" } });
        }
      }
    } catch (e) { /* ACL 反查失败不阻断（登录墙已过） */ }
    const root = path.join(varDir, vr.slice("/var/".length).replace(/\/+$/, ""));
    const fp = path.normalize(path.join(root, pathname.slice(vr.length)));
    const rootN = path.resolve(root).toLowerCase();
    const fpN = path.resolve(fp).toLowerCase();
    if (fpN !== rootN && !fpN.startsWith(rootN + path.sep)) {
      return router.json(res, 403, { error: { code: "FORBIDDEN", message: "路径非法" } });
    }
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      return router.json(res, 404, { error: { code: "NOT_FOUND", message: "产物不存在" } });
    }
    try {
      /* 媒体可跳转（2026-11-22 用户批语：播放组件使用有问题）：HTTP Range/206——
         无 Accept-Ranges 时 Chromium 只能在已缓冲区间内 seek（拖进度条被钳回），音频波形进度不可用。
         音频/图像统一走这里；不支持的 Range 头按 200 全量兜底。 */
      const size = fs.statSync(fp).size;
      const ctype = MIME[path.extname(fp).toLowerCase()] || "application/octet-stream";
      const rng = String(req.headers["range"] || "").trim();
      const m = /^bytes=(\d*)-(\d*)$/.exec(rng);
      if (m && (m[1] !== "" || m[2] !== "") && size > 0) {
        let start, end;
        if (m[1] === "") {                        // bytes=-N：尾部 N 字节
          const n = Math.min(size - 1, parseInt(m[2], 10) || 0);
          if (n <= 0) { res.writeHead(416, { "Content-Range": "bytes */" + size }); res.end(); return; }
          start = size - n; end = size - 1;
        } else {
          start = parseInt(m[1], 10);
          end = m[2] === "" ? size - 1 : Math.min(size - 1, parseInt(m[2], 10));
          if (start > size - 1 || start > end) { res.writeHead(416, { "Content-Range": "bytes */" + size }); res.end(); return; }
        }
        res.writeHead(206, {
          "Content-Type": ctype,
          "Content-Range": "bytes " + start + "-" + end + "/" + size,
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache"
        });
        fs.createReadStream(fp, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        "Content-Type": ctype,
        "Content-Length": size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache"
      });
      fs.createReadStream(fp).pipe(res);
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
      "Content-Length": buf.length,
      // 客户端静态面 no-cache（2026-11-22 修复：无缓存头时浏览器启发式缓存旧 JS——
      // 同一 ?v= 版本键下的代码更新用户侧永远看不到，素材中心视图渲染空白即此因）
      "Cache-Control": "no-cache"
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
