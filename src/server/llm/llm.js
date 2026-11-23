"use strict";
/**
 * llm/llm.js — llm-gw：本机 OpenAI 兼容 LLM 通道（一期自部署纪律：禁云端 API）
 *
 * 端点：用户侧 llama-server（E:\MyLLM\8090_huihui35b_q4k_cpu19.bat）→ :8090 /v1，
 * 别名 Huihui35B:vision（Qwen3.6-35B-A3B MoE Q4_K，attention 上 GPU ~14.4GB，专家在 CPU）。
 *
 * 纪律：
 *  - fail-open：LLM 不可达/超时 → chat 返回 {ok:false}，调用方回退规则模式，绝不阻断创作链。
 *  - 诚实标注：meta 用 label()（LLM·<model>，豁免面）；用户面一律「LLM/规则模式」，不带型号。
 *  - 思考开关：Qwen3 模板必须用 chat_template_kwargs.enable_thinking（/no_think 文本开关无效，实测）。
 *  - 显存互斥：LLM 在线＝本机 ComfyUI 生图/拍摄不可跑（16G 卡装不下两家）。
 *    monitor 每 3s 探测 LLM＋Comfy 状态缓存，engine/api 同步闸读 cached()。
 */
const { execFile } = require("child_process");

/* ---------- 状态监视（模块级单例，进程内共享） ---------- */
const monitor = { base: null, llmOnline: false, llmModel: "", ts: 0, comfy: null, timer: null };
/* 自动拉起已移除（2026-11-23 用户要求）：
   原 watchdog 会在 monitor 连续 3 次探测离线时 spawn 本机 8090 bat，导致服务被杀后又被反复拉起。
   现仅保留在线状态监视（fail-open 与显存互斥闸依赖 monitor），不再启动任何本机模型进程。 */
let lastOnline = null;

async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    if (!res.ok) return { status: res.status };
    const j = await res.json();
    return { status: res.status, json: j };
  } catch (e) {
    return { status: 0, error: (e && e.message) || String(e) };
  } finally {
    clearTimeout(t);
  }
}

function cfgOf(cfg) {
  const base = String((cfg && cfg.llm && cfg.llm.base) || "").replace(/\/+$/, "");
  return {
    base,
    model: (cfg && cfg.llm && cfg.llm.model) || "default",
    bat: (cfg && cfg.llm && cfg.llm.bat) || "",
    enabled: !!base,
    comfyBase: String((cfg && (cfg.llmHostComfy || (cfg.comfy && cfg.comfy.base))) || "").replace(/\/+$/, "") // LLM 承载机的 Comfy（显存互斥监视对象）
  };
}

function chatUrl(base) {
  return /\/v1$/.test(base) ? base + "/chat/completions" : base + "/v1/chat/completions";
}
function modelsUrl(base) {
  return /\/v1$/.test(base) ? base + "/models" : base + "/v1/models";
}

/** meta 豁免面用（带型号）；用户面文案一律「LLM」 */
function label(cfg) {
  const c = cfgOf(cfg);
  return "LLM·" + c.model;
}

/* ---------- chat：主通道 ---------- */
/**
 * chat(cfg, messages, opts) →
 *   {ok:true, content, reasoning, usage, seconds, model}
 *   {ok:false, error, code:"LLM_OFFLINE"|"LLM_TIMEOUT"|"LLM_BAD_OUTPUT"}
 * opts: {timeoutMs=30000, maxTokens=700, temperature=0.4, thinking=false}
 */
async function chat(cfg, messages, opts) {
  const c = cfgOf(cfg);
  const o = opts || {};
  if (!c.enabled) return { ok: false, code: "LLM_OFFLINE", error: "未配置 THEATER_LLM_URL" };
  const body = {
    model: c.model,
    messages,
    temperature: typeof o.temperature === "number" ? o.temperature : 0.4,
    max_tokens: Number(o.maxTokens) > 0 ? Number(o.maxTokens) : 700,
    chat_template_kwargs: { enable_thinking: o.thinking === true } // 默认关思考（快，够用）
  };
  const t0 = Date.now();
  const r = await fetchJson(chatUrl(c.base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, o.timeoutMs || 30000);
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  if (r.status === 0) return { ok: false, code: "LLM_TIMEOUT", error: r.error, seconds };
  if (r.status !== 200 || !r.json) return { ok: false, code: "LLM_BAD_OUTPUT", error: "HTTP " + r.status, seconds };
  const msg = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message;
  const content = msg && typeof msg.content === "string" ? msg.content.trim() : "";
  if (!content) return { ok: false, code: "LLM_BAD_OUTPUT", error: "空回复（思考未收敛？）", seconds, reasoning: (msg && msg.reasoning_content) || "" };
  return {
    ok: true,
    content,
    reasoning: (msg && msg.reasoning_content) || "",
    usage: r.json.usage || null,
    seconds,
    model: c.model
  };
}

/* ---------- status：即时探测 ---------- */
async function status(cfg) {
  const c = cfgOf(cfg);
  if (!c.enabled) return { online: false, configured: false };
  const t0 = Date.now();
  const r = await fetchJson(modelsUrl(c.base), {}, 1500);
  const online = r.status === 200 && !!(r.json && r.json.data && r.json.data.length);
  return {
    online,
    configured: true,
    model: online && r.json.data[0] && (r.json.data[0].id || r.json.data[0].name) || c.model,
    seconds: Math.round((Date.now() - t0) / 100) / 10
  };
}

/* ---------- 缓存读（同步闸用） ---------- */
function cached(cfg) {
  const c = cfgOf(cfg);
  if (!c.enabled) return { configured: false, llmOnline: false };
  const stale = Date.now() - monitor.ts > 15000;
  return {
    configured: true,
    llmOnline: !stale ? monitor.llmOnline : false, // 监视过期按离线处理（fail-open 方向＝放行生成线）
    llmModel: monitor.llmModel,
    comfy: monitor.comfy,
    age_s: Math.round((Date.now() - monitor.ts) / 1000)
  };
}

/** 本机 Comfy lane 硬闸：LLM 在线 → 生图/拍摄拒绝（16G 卡装不下两家） */
function blockedByLocalLLM(cfg) {
  const s = cached(cfg);
  return !!(s.configured && s.llmOnline);
}

/* ---------- stop：一键让路（taskkill llama-server） ---------- */
function stopServer(cfg) {
  const c = cfgOf(cfg);
  if (!c.enabled) return Promise.resolve({ ok: false, message: "未配置 LLM 端点" });
  const m = /:(\d+)$/.test(c.base) ? Number(/:(\d+)$/.exec(c.base)[1]) : 8090;
  if (process.platform !== "win32") return Promise.resolve({ ok: false, message: "非 win32 环境不支持自动停止" });
  return new Promise((resolve) => {
    execFile("netstat", ["-ano"], (err, stdout) => {
      if (err) return resolve({ ok: false, message: "netstat 失败: " + err.message });
      let pid = null;
      String(stdout).split("\n").some((line) => {
        if (line.indexOf("LISTENING") >= 0 && line.indexOf(":" + m + " ") >= 0) {
          const parts = line.trim().split(/\s+/);
          pid = parts[parts.length - 1];
          return true;
        }
        return false;
      });
      if (!pid) return resolve({ ok: false, message: "端口 " + m + " 无监听进程（LLM 本就不在线）" });
      execFile("taskkill", ["/F", "/PID", pid, "/T"], (err2) => {
        monitor.llmOnline = false; // 立即失效缓存，闸放行
        resolve(err2
          ? { ok: false, message: "taskkill 失败: " + err2.message }
          : { ok: true, pid, message: "LLM 已停（PID " + pid + "），显存已释放。重启请运行 E:\\MyLLM\\8090_huihui35b_q4k_cpu19.bat" });
      });
    });
  });
}

/* ---------- monitor：3s 轮询缓存 ---------- */
let busRef = null;
function startMonitor(cfg, bus) {
  busRef = bus || null;
  const c = cfgOf(cfg);
  if (!c.enabled || monitor.timer) return false;
  monitor.base = c.base;
  const tick = async () => {
    try {
      const s = await status(cfg);
      monitor.llmOnline = !!s.online;
      monitor.llmModel = s.model || "";
      monitor.ts = Date.now();
    } catch (e) {
      monitor.llmOnline = false;
    }
    // 仅记录在线/离线翻转，不再自动拉起（2026-11-23：自动拉起会与用户的手动启停冲突）
    if (monitor.llmOnline !== lastOnline) {
      lastOnline = monitor.llmOnline;
      console.log(monitor.llmOnline ? "[llm] online model=" + monitor.llmModel : "[llm] offline (auto-restart disabled) base=" + c.base);
    }
    if (c.comfyBase) {
      const r = await fetchJson(c.comfyBase + "/system_stats", {}, 1500);
      const d = r.json && r.json.devices && r.json.devices[0];
      monitor.comfy = d
        ? { online: true, vram_total_mib: Math.round((d.vram_total || 0) / 1048576), vram_free_mib: Math.round((d.vram_free || 0) / 1048576) }
        : { online: false };
    }
  };
  tick();
  monitor.timer = setInterval(tick, 3000);
  if (monitor.timer.unref) monitor.timer.unref();
  return true;
}

function create(cfg) {
  return {
    chat: (messages, opts) => chat(cfg, messages, opts),
    status: () => status(cfg),
    cached: () => cached(cfg),
    blockedByLocalLLM: () => blockedByLocalLLM(cfg),
    stop: () => stopServer(cfg),
    label: () => label(cfg),
    enabled: () => cfgOf(cfg).enabled
  };
}

module.exports = { create, chat, status, cached, blockedByLocalLLM, stopServer, startMonitor, label, cfgOf };
