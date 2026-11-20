/* 剧场 Studio · REST 层 __T.api（骨架文件，agent 勿改）
   统一错误模型 ApiError{status,code,message}；无静默回退。token 由 store 注入。 */
(function (global) {
  "use strict";
  const T = global.__T;

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message || ("HTTP " + status));
      this.status = status; this.code = code || "";
    }
  }
  T.ApiError = ApiError;

  let tokenGetter = () => null;
  T.setTokenGetter = fn => { tokenGetter = fn; };

  const TIMEOUT_MS = 15000;

  async function call(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const headers = { "accept": "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const tok = tokenGetter();
    if (tok) headers["authorization"] = "Bearer " + tok;
    let res, text;
    try {
      res = await fetch(path, {
        method, headers, signal: ctrl.signal,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      text = await res.text();
    } catch (e) {
      clearTimeout(timer);
      throw new ApiError(0, "NETWORK", e && e.name === "AbortError" ? "服务端没响应（超时）" : "网络不通，检查一下服务");
    }
    clearTimeout(timer);
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }
    if (!res.ok) {
      const code = (data && data.error && data.error.code) || (data && data.code) || "";
      const msg = (data && data.error && data.error.message) || (data && data.message) || "";
      throw new ApiError(res.status, code, msg);
    }
    return data || {};
  }

  T.api = {
    get: p => call("GET", "/api" + p),
    post: (p, body) => call("POST", "/api" + p, body === undefined ? {} : body)
  };

  /* SSE 地址（EventSource 走 ?token= 兜底，服务端仅 /api/events 接受） */
  T.eventsUrl = function (session) {
    const tok = tokenGetter();
    const q = [];
    if (tok) q.push("token=" + encodeURIComponent(tok));
    if (session) q.push("session=" + encodeURIComponent(session));
    return "/api/events" + (q.length ? "?" + q.join("&") : "");
  };
})(window);
