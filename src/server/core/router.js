"use strict";
/**
 * core/router.js — 迷你路由（契约 §2/§3）
 * - router.add(method, path, handler, opts)   path 支持 :param；opts:{auth:true, role:"ops"}
 * - router.useAuth(fn)                         fn(req) → user|null
 * - router.handle(req,res)                     → Promise<boolean>：true=已应答；
 *                                              非 /api 前缀未匹配 → false（由 index.js 静态兜底）；
 *                                              /api 未匹配 → 404 JSON。
 * - router.json(res, code, obj)
 * - 异常统一 {error:{code,message}}；err.code 映射 HTTP：
 *   STALE→409 · QUANT_RULE→409 · BLOCKED_PRECHECK→422 · BUDGET→402 · FORBIDDEN→403 · CONFIRM_REQ→428，否则 500。
 * JSON body 上限 1MB。
 */

const MAX_BODY = 1024 * 1024; // 1MB

const CODE_STATUS = {
  STALE: 409,
  QUANT_RULE: 409,
  CONFLICT: 409,
  BLOCKED_PRECHECK: 422,
  BUDGET: 402,
  FORBIDDEN: 403,
  CONFIRM_REQ: 428,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  BAD_JSON: 400,
  BAD_TYPE: 400,
  BAD_REQUEST: 400,
  CONFIRM_REQUIRED: 428,
  NO_WORKER: 400,
  GPU_BUSY: 409,
  // 节点注册表护栏（2026-11-22）：撤节点被拓扑引用拦下
  NODE_HAS_ENGINES: 409,
  NODE_HAS_EPISODES: 409,
  NODE_IS_LLM_HOST: 409,
  LAST_NODE: 409,
  NODE_HAS_USERS: 409,
  NODE_NO_LANE: 400,
  PROFILE_ACTIVE: 409,
  // 状态/语义类（2026-11-23 深审补齐）：此前未映射全落 500，客户端 humanErr 靠 code 兜底但 HTTP 语义失真
  ALREADY_DECIDED: 409,
  BAD_ACTION: 400,
  LOCKED: 409,
  NOT_READY: 409,
  NOT_A_FACE: 422,
  HAS_EPISODES: 409,
  NOT_EMPTY: 409,
  PROTECTED: 409,
  LAST_CODE: 409,
  IN_USE: 409,
  POOL_EMPTY: 409,
  MODERATION_FAIL: 422,
  LLM_OFFLINE: 503,
  LLM_BAD: 502,
  INVALID_CODE: 401,
  INVALID_MODE: 400,
  BAD_DECISION: 400,
  RUNTIME: 503,
  L2_UNAVAILABLE: 503,
  TURN_LIMIT: 429
};

function statusOf(err) {
  if (err && typeof err.code === "string" && CODE_STATUS[err.code]) return CODE_STATUS[err.code];
  return 500;
}

function createRouter() {
  const routes = []; // {method, pattern, keys, handler, opts}
  let authFn = null;

  function json(res, code, obj) {
    if (res.writableEnded) return;
    if (res.headersSent) {
      try { res.end(); } catch (e) { /* noop */ }
      return;
    }
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  }

  function fail(res, code, message) {
    return json(res, statusOf({ code }), { error: { code, message } });
  }

  function add(method, p, handler, opts) {
    const keys = [];
    const base = p.replace(/\/+$/, ""); // 去尾斜杠
    const patternSrc =
      "^" +
      base
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // 转义正则元字符（":name" 中的冒号不受影响）
        .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (m, k) => {
          keys.push(k);
          return "([^/]+)";
        }) +
      "/?$";
    routes.push({
      method: String(method).toUpperCase(),
      pattern: new RegExp(patternSrc),
      keys,
      handler,
      opts: opts || {}
    });
  }

  function useAuth(fn) {
    authFn = typeof fn === "function" ? fn : null;
  }

  // opts.raw=true → body 为原始 Buffer（图片上传等二进制面）；opts.limit 覆盖 1MB JSON 上限
  function readBody(req, opts) {
    const raw = !!(opts && opts.raw);
    const limit = (opts && typeof opts.limit === "number" && opts.limit > 0) ? opts.limit : MAX_BODY;
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on("data", (c) => {
        if (tooBig) return; // 溢出后丢弃剩余分片，等 413 应答
        size += c.length;
        if (size > limit) {
          tooBig = true;
          reject({ code: "PAYLOAD_TOO_LARGE", message: "请求体超过 " + Math.round(limit / 1024 / 1024) + "MB 上限" });
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (tooBig) return;
        if (raw) return resolve(Buffer.concat(chunks));
        const s = Buffer.concat(chunks).toString("utf8").trim();
        if (!s) return resolve({});
        try {
          resolve(JSON.parse(s));
        } catch (e) {
          reject({ code: "BAD_JSON", message: "JSON 解析失败" });
        }
      });
      req.on("error", (e) => reject({ code: "BAD_JSON", message: String(e && e.message) }));
    });
  }

  async function handle(req, res) {
    let pathname = String(req.url || "/").split("?")[0];
    try {
      pathname = decodeURIComponent(pathname);
    } catch (e) {
      /* 保留原串 */
    }

    let match = null;
    let methodMismatch = false;
    for (const r of routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      if (r.method === req.method) {
        match = { r, m };
        break;
      }
      methodMismatch = true;
    }

    if (!match) {
      if (methodMismatch) {
        fail(res, "METHOD_NOT_ALLOWED", "方法不允许");
        return true;
      }
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        fail(res, "NOT_FOUND", "接口不存在");
        return true;
      }
      return false; // 交给 index.js 静态兜底
    }

    const { r, m } = match;
    const params = {};
    r.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]);
      } catch (e) {
        params[k] = m[i + 1];
      }
    });

    // 鉴权
    let user = null;
    if (r.opts.auth) {
      user = authFn ? authFn(req) : null;
      if (!user) {
        fail(res, "UNAUTHORIZED", "需要登录（Authorization: Bearer <token>）");
        return true;
      }
      if (r.opts.role && user.role !== r.opts.role) {
        fail(res, "FORBIDDEN", "需要 " + r.opts.role + " 角色");
        return true;
      }
    }

    // body
    let body = {};
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
      try {
        body = await readBody(req, r.opts);
      } catch (err) {
        const code = err && err.code ? err.code : "BAD_JSON";
        json(res, statusOf(err), { error: { code, message: (err && err.message) || "请求体错误" } });
        return true;
      }
    }

    try {
      await r.handler(req, res, body, params, user);
    } catch (err) {
      const code = err && typeof err.code === "string" ? err.code : "INTERNAL";
      const message = (err && err.message) || "服务器内部错误";
      if (code === "INTERNAL") console.error("[router]", req.method, pathname, err);
      json(res, statusOf(err), { error: { code, message } });
    }
    return true;
  }

  return { add, useAuth, handle, json, statusOf, routes };
}

module.exports = { createRouter };
