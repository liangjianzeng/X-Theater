/* 剧场 Studio · 工具层 __T（骨架文件，agent 勿改） */
(function (global) {
  "use strict";

  const T = (global.__T = global.__T || {});

  /* ---------- 格式化 ---------- */
  T.fmtYuan = function (cents) {
    if (cents == null || !Number.isFinite(Number(cents))) return "—";
    return "¥" + (Number(cents) / 100).toFixed(2);
  };
  T.fmtMin = function (min) {
    if (min == null || !Number.isFinite(Number(min))) return "—";
    const m = Math.round(Number(min));
    return m >= 60 ? Math.floor(m / 60) + " 小时 " + (m % 60 ? m % 60 + " 分" : "") : m + " 分钟";
  };
  T.relTime = function (ts) {
    const d = Date.now() - Number(ts || 0);
    if (!Number.isFinite(d) || d < 0) return "—";
    if (d < 60000) return "刚刚";
    if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
    if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
    return Math.floor(d / 86400000) + " 天前";
  };
  T.fmtTime = function (ts) {
    const d = new Date(Number(ts || 0));
    const p = n => String(n).padStart(2, "0");
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  };
  T.cls = function () {
    const out = [];
    for (const x of arguments) {
      if (!x) continue;
      if (typeof x === "string") out.push(x);
      else if (Array.isArray(x)) out.push(T.cls.apply(null, x));
      else for (const k in x) if (x[k]) out.push(k);
    }
    return out.join(" ");
  };
  T.sleep = ms => new Promise(r => setTimeout(r, ms));
  T.esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };

  /* ---------- 语言表（服务端 rules.langlint 同表·客户端二次过滤，幂等） ---------- */
  const SAN_MAP = [
    [/\btakes?\b/gi, "拍摄条"], [/\bseed\b/gi, "随机种子"], [/\bprompt\b/gi, "需求描述"],
    [/\bi2v\b/gi, "图生视频"], [/\blora\b/gi, "角色强化包"], [/\bstale\b/gi, "需重做"],
    [/超分/g, "画质增强"], [/补帧/g, "流畅增强"], [/\brouting\b/gi, "调度"], [/路由/g, "调度"],
    [/\bworker\b/gi, "执行器"], [/\bprompting\b/gi, "需求描述"]
  ];
  const SAN_MODEL = /(?:qwen[- ]?image|MiniMax[- ]?H3(?:[- ]?Image)?|LTX[- ]?2\.5|FastH3|ACE[- ]?Step|CosyVoice\d?|Stable Audio Open|Stable Audio|DeepSeek|SGLang|ComfyUI|GGUF|nvfp4|int8|MXFP8(?:\+FP8)?|Q5_K_M|UD-Q4_K_XL)[\w.\-+]*/gi;
  T.sanitize = function (s) {
    let x = String(s == null ? "" : s);
    for (const [re, rep] of SAN_MAP) x = x.replace(re, rep);
    return x.replace(SAN_MODEL, "生成引擎");
  };
  T.sanitizeDeep = function (o) {
    if (typeof o === "string") return T.sanitize(o);
    if (Array.isArray(o)) return o.map(T.sanitizeDeep);
    if (o && typeof o === "object") {
      const r = {};
      for (const k in o) r[k] = typeof o[k] === "string" ? T.sanitize(o[k]) : T.sanitizeDeep(o[k]);
      return r;
    }
    return o;
  };

  /* ---------- 错误人话表 ---------- */
  const HUMAN = {
    UNAUTHORIZED: ["没登录或登录过期了", false],
    FORBIDDEN: ["这个操作你没权限（需要运营角色或本人会话）", false],
    INVALID_CODE: ["邀请码无效，找运营要一个", false],
    NOT_FOUND: ["要找的东西不存在（可能已被清理）", true],
    STALE: ["上下文已变：内容被别人更新过，刷新后重试", true],
    ALREADY_DECIDED: ["这张卡已经拍板过了", true],
    BLOCKED_PRECHECK: ["交付预检没过：先处理红色拦截项", false],
    BUDGET: ["触发预算护栏：本轮花费超上限，已自动暂停等你确认", false],
    BUDGET_LINE: ["副驾预算线已用完（本期 ¥80）", false],
    L2_UNAVAILABLE: ["制片助手（L2）没启用", true],
    RUNTIME: ["制片助手运行环境异常，稍后再试", true],
    INVALID_MODE: ["助手模式只支持 A（托管）或 B（内置）", false],
    BAD_DECISION: ["审批选项只能是批准或驳回", false],
    BAD_ACTION: ["复审动作不合法", false],
    BAD_REQUEST: ["提交的内容不完整", false],
    NO_TAKES: ["这条镜头还没有产出条，先重拍", true],
    ESTIMATE_MISMATCH: ["预估已更新，请重新预览报价再开机", true],
    NO_ESTIMATE: ["还没有开机报价：先在卡流里确认开机卡", true],
    METHOD_NOT_ALLOWED: ["请求方式不对", false],
    QUANT_AUDIT_REQUIRED: ["降级到兜底段位需要写明理由并留审计", false]
  };
  T.humanErr = function (err) {
    if (!err) return { code: "UNKNOWN", text: "出了点小状况", retriable: true };
    const code = String(err.code || (err.body && err.body.error && err.body.error.code) || "");
    const mapped = HUMAN[code];
    const text = mapped ? mapped[0] : (T.sanitize(err.message || "") || "出了点小状况（" + (code || err.status || "?") + "）");
    const retriable = mapped ? mapped[1] : [0, 502, 503, 504].includes(Number(err.status));
    return { code: code || String(err.status || "ERR"), text, retriable };
  };

  global.__T = T;
})(window);
