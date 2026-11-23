/* 剧场 Studio · 工具层 __T（骨架文件，agent 勿改） */
(function (global) {
  "use strict";

  const T = (global.__T = global.__T || {});

  /* ---------- 格式化 ---------- */
  T.fmtYuan = function (cents) {
    if (cents == null || !Number.isFinite(Number(cents))) return "—";
    return "¥" + (Number(cents) / 100).toFixed(2);
  };
  /* 一期自部署口径：分＝内部成本核算单位（影子记账），不是价格；付费 API 面才用 fmtYuan */
  T.fmtFen = function (cents) {
    if (cents == null || !Number.isFinite(Number(cents))) return "—";
    return Number(cents) + " 分";
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
    // 兼容数字毫秒与 ISO 字符串（final_meta.delivered_at 走 ISO；旧版 Number() 强转→NaN 显示 NaN-NaN）
    const d = ts instanceof Date ? ts : new Date(typeof ts === "string" ? ts : Number(ts || 0));
    if (isNaN(d.getTime())) return "—";
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

  /* ---------------- 统一镜号规范（2026-11-21「编号乱」根治） ----------------
     全链唯一口径：seq=场景编码+镜序（101→「镜 01」）；name 剥掉尾部机械序号（卧室·夜-镜1→卧室·夜）；
     显示统一「镜 03 · 卧室·夜 · 7.5s」；重拍条次单独标「第 N 条」，绝不混入镜号。
     拍摄墙/队列/复审台/卡流/时间线一律走这几个助手，禁止各自拼 seq%100 或 shotId 尾哈希。 */
  T.pad2 = function (n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x <= 0) return "—";
    return x < 100 ? ("0" + x).slice(-2) : String(x);
  };
  T.shotNo = function (s) { return T.pad2(Number(s && s.seq) % 100 || (s && s.seq)); };
  T.shotScene = function (s) { return String((s && s.name) || "").replace(/[-_·\s]*镜\s*\d+\s*$/, "").trim(); };
  T.shotLabel = function (s) { return "镜 " + T.shotNo(s); };
  T.shotFull = function (s) {
    return "镜 " + T.shotNo(s)
      + (T.shotScene(s) ? " · " + T.shotScene(s) : "")
      + (s && s.sec ? " · " + s.sec + "s" : "");
  };

  /* ---------------- 产物/素材 URL（素材中心 2026-11-22 修复：图片显示不出） ----------------
     统一寻址口径（与服务端 cards.js cast 候选拼装同约定）：
     - 裸文件名＝定妆参考（var/assets/cast/ 相对名）→ /var/assets/cast/<fn>
     - var/out|var/assets 相对路径 → 根路径（登录墙靠同源 Cookie theater_tok 自动携带）
     - 绝对 URL / 以 / 开头 → 原样 */
  T.artUrl = function (art) {
    const a = String(art == null ? "" : art).trim().replace(/\\/g, "/");
    if (!a) return "";
    if (/^https?:\/\//i.test(a)) return a;
    if (/^var\//i.test(a)) return "/" + a;
    if (a.charAt(0) === "/") return a;
    return "/var/assets/cast/" + a;
  };

  global.__T = T;
})(window);
