'use strict';
/**
 * X-Theater 一期验收套件 · 公共库
 * 约束：零 npm 依赖 / CommonJS / Node>=18（全局 fetch）。
 * 只经 HTTP + var/ 账本文件观察系统，绝不 require src/ 内部模块。
 *
 * 提供：
 *  - startServer({port, varDir})  起 src/server/index.js（env PORT / THEATER_VAR），
 *    等 stdout "theater server on" 或轮询 GET /api/state；kill 收尾；启动失败优雅报错不挂死。
 *  - makeApi(port) → api(method, path, body, token)
 *  - expect 断言集（抛 AssertionError）
 *  - readLedger(varDir, kind)  读 JSONL 账本（log-<kind>.jsonl 等多候选路径）
 *  - openSse(...)  SSE 流式订阅
 *  - pollUntil / pickList / extractId 等杂项
 *  - buildCaseContext(...)  给 run.js 用的单用例上下文（独立 var 临时目录 + 登录 + 账本读取）
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'src', 'server', 'index.js');
const TMP_ROOT = path.join(__dirname, 'tmp');
const BASE_PORT = Number(process.env.TEST_BASE_PORT) || 18766; // 环境变量可避让并行会话的套件端口（2026-11-22）
const INVITE = 'INV-DEMO-1';

// job / shot 状态词汇表（契约未穷举，宽容匹配）
const BUSY_STATES = new Set(['queued', 'pending', 'running', 'waiting', 'scheduled', 'in_progress', 'retrying', 'initiated', 'shooting', 'processing']);
const DONE_STATES = new Set(['done', 'completed', 'ok', 'succeeded', 'passed', 'finished', 'verified']);
const FAILED_STATES = new Set(['failed', 'error', 'cancelled', 'canceled', 'aborted']);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function j(x) { try { return JSON.stringify(x); } catch { return String(x); } }
function trunc(s, n = 300) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

/* ------------------------------- 断言 ------------------------------- */
class AssertionError extends Error {
  constructor(msg) { super(msg); this.name = 'AssertionError'; }
}

function fail(msg) { throw new AssertionError(msg); }

const expect = {
  ok(v, msg) { if (!v) fail(`${msg || 'expect.ok'}: got falsy ${trunc(j(v))}`); },
  eq(actual, expected, msg) {
    if (actual !== expected) fail(`${msg || 'expect.eq'}: expected ${trunc(j(expected))}, got ${trunc(j(actual))}`);
  },
  deepEq(actual, expected, msg) {
    const a = j(actual), b = j(expected);
    if (a !== b) fail(`${msg || 'expect.deepEq'}:\n  expected ${trunc(b)}\n  actual   ${trunc(a)}`);
  },
  lte(a, b, msg) { if (!(a <= b)) fail(`${msg || 'expect.lte'}: ${a} > ${b}`); },
  gte(a, b, msg) { if (!(a >= b)) fail(`${msg || 'expect.gte'}: ${a} < ${b}`); },
  match(str, re, msg) {
    if (!re.test(String(str == null ? '' : str))) fail(`${msg || 'expect.match'}: /${re.source}/ not found in ${trunc(str)}`);
  },
  notMatch(str, re, msg) {
    if (re.test(String(str == null ? '' : str))) fail(`${msg || 'expect.notMatch'}: unexpected /${re.source}/ in ${trunc(str)}`);
  },
  includes(arr, item, msg) {
    if (!Array.isArray(arr) || !arr.includes(item)) fail(`${msg || 'expect.includes'}: ${trunc(j(item))} not in ${trunc(j(arr))}`);
  },
  status(resp, codes, msg) {
    const list = Array.isArray(codes) ? codes : [codes];
    if (!list.includes(resp.status)) fail(`${msg || 'HTTP'} ${resp.method || ''} ${resp.path || ''}: expected ${list.join('/')}, got ${resp.status} body=${trunc(resp.text)}`);
  },
  code(resp, code, msg) {
    const got = resp && resp.body && resp.body.error && resp.body.error.code;
    if (got !== code) fail(`${msg || 'error.code'}: expected ${code}, got ${trunc(j(got))} body=${trunc(resp && resp.text)}`);
  },
};

/* ------------------------------- 启动服务 ------------------------------- */
async function killChild(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  try { child.kill(); } catch { /* ignore */ }
  const dl = Date.now() + 3000;
  while (Date.now() < dl) {
    if (child.exitCode != null || child.signalCode) return;
    await sleep(100);
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

async function startServer({ port, varDir, readyTimeoutMs = 20000 } = {}) {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`server start failed: 入口不存在 ${SERVER_ENTRY}（core 尚未交付 src/server/index.js）`);
  }
  fs.mkdirSync(varDir, { recursive: true });
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    // THEATER_COMPOSE_REAL=0：套件显式 stub 模式（t2v take 是占位字节，真 ffmpeg concat 必炸；
    // 占位出货由 meta placeholder 如实标注，真合成出货走真机 E2E——2026-11-23 compose 真合成默认化）
    env: Object.assign({}, process.env, { PORT: String(port), THEATER_VAR: varDir, THEATER_COMPOSE_REAL: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const tail = { out: '', err: '' };
  child.stdout.on('data', (d) => { tail.out = (tail.out + d).slice(-8000); });
  child.stderr.on('data', (d) => { tail.err = (tail.err + d).slice(-8000); });
  let exitInfo = null;
  child.on('exit', (code, signal) => { exitInfo = { code, signal }; });
  child.on('error', (e) => { tail.err += `\nspawn error: ${e.message}`; });

  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (exitInfo) break;
    try {
      // 任何 HTTP 应答（含 401/404）即视为端口已起；契约要求 GET /api/state 存在
      await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1200) });
      ready = true; break;
    } catch { /* 未就绪 */ }
    if (/theater server on/.test(tail.out)) {
      // stdout 已宣告，再快速确认端口
      try {
        await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1200) });
        ready = true; break;
      } catch { /* fallthrough */ }
    }
    await sleep(250);
  }
  if (!ready) {
    const why = exitInfo
      ? `进程提前退出 code=${exitInfo.code} signal=${exitInfo.signal}`
      : `端口 ${port} 在 ${readyTimeoutMs}ms 内无 HTTP 应答`;
    await killChild(child);
    throw new Error(`server start failed: ${why}\n[stdout]\n${tail.out}\n[stderr]\n${tail.err}`);
  }
  return {
    child, port, varDir, tail,
    markerSeen: /theater server on/.test(tail.out),
    async kill() { await killChild(child); },
  };
}

/* ------------------------------- var 目录 / 账本 ------------------------------- */
/**
 * 定位真实的 var 目录：优先 THEATER_VAR 临时目录；若 core 不支持 env 覆盖
 * （目录里没有 state.json / log-*.jsonl），退化为仓库 var/（此时不做任何删除）。
 */
function resolveVarDir(varDirEnv) {
  const cands = [
    varDirEnv,
    path.join(ROOT, 'var'),
    path.join(ROOT, 'src', 'server', 'var'),
    path.join(process.cwd(), 'var'),
  ];
  for (const d of cands) {
    try {
      if (!d || !fs.existsSync(d)) continue;
      const files = fs.readdirSync(d);
      if (files.some((f) => /^(log-.*\.jsonl|state\.json)$/.test(f))) return d;
    } catch { /* ignore */ }
  }
  return varDirEnv;
}

/** 读 <var>/log-<kind>.jsonl（含备选命名）；找不到返回 {rows:null,tried} */
function readLedger(varDir, kind) {
  const cands = [
    path.join(varDir, `log-${kind}.jsonl`),
    path.join(varDir, `${kind}.jsonl`),
    path.join(varDir, 'ledger', `log-${kind}.jsonl`),
    path.join(varDir, 'ledger', `${kind}.jsonl`),
  ];
  for (const f of cands) {
    if (!fs.existsSync(f)) continue;
    const rows = [];
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch { /* 半行容忍 */ }
    }
    return { rows, file: f };
  }
  return { rows: null, file: null, tried: cands };
}

function readStateJson(varDir) {
  const p = path.join(varDir, 'state.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/* ------------------------------- HTTP ------------------------------- */
function makeApi(port, defaultTimeoutMs = 25000) {
  return async function api(method, p, body, token, opts = {}) {
    const headers = {};
    let payload;
    if (body !== undefined && body !== null) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(opts.timeoutMs || defaultTimeoutMs),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON（静态页等） */ }
    const out = { status: res.status, ok: res.ok, body: parsed, text, method, path: p, headers: Object.fromEntries(res.headers.entries() || []) };
    return out;
  };
}

/* ------------------------------- SSE ------------------------------- */
function parseSseFrame(frame, events) {
  let name = null;
  const dataLines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith(':')) { // 注释/心跳 :ping（计为存活帧）
      if (/ping/i.test(line)) events.push({ topic: '_ping', data: null, raw: line });
      continue;
    }
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  const raw = dataLines.join('\n');
  if (!raw && !name) return;
  let data = raw;
  try { data = JSON.parse(raw); } catch { /* 原样字符串 */ }
  let topic = name;
  if (!topic && data && typeof data === 'object') topic = data.topic || data.type || '';
  events.push({ topic: String(topic || raw), data, raw });
}

async function openSse({ port, token, path: p = '/api/events' }) {
  const headers = { accept: 'text/event-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok) throw new Error(`SSE GET ${p} -> ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
  let closed = false;
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          parseSseFrame(frame, events);
        }
      }
    } catch (e) {
      if (!closed) events.push({ topic: '_stream_error', data: { message: String((e && e.message) || e) }, raw: '' });
    }
  })();
  return {
    events,
    async waitFor(pred, { timeoutMs = 15000, label = 'event' } = {}) {
      const dl = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() >= dl) {
          throw new Error(`SSE timeout ${timeoutMs}ms 等待 ${label}（共 ${events.length} 帧：${trunc(events.map((e) => e.topic).join(','), 200)}）`);
        }
        await sleep(100);
      }
    },
    close() { closed = true; try { reader.cancel(); } catch { /* ignore */ } },
  };
}

/* ------------------------------- 杂项 ------------------------------- */
async function pollUntil(fn, { timeoutMs = 60000, intervalMs = 500, label = 'condition' } = {}) {
  const dl = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = { error: String((e && e.message) || e) }; }
    if (Date.now() >= dl) break;
    await sleep(intervalMs);
  }
  throw new Error(`timeout(${timeoutMs}ms) 等待 ${label}；last=${trunc(j(last))}`);
}

/** 从响应体里捞数组（契约未定包装键，宽容取） */
function pickList(body, keys = ['items', 'list', 'data']) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  for (const k of keys) if (Array.isArray(body[k])) return body[k];
  for (const v of Object.values(body)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of keys) if (Array.isArray(v[k])) return body[k];
    }
  }
  return null;
}

/** 从响应体里捞实体 id */
function extractId(body, keyHints = ['id']) {
  if (!body) return null;
  if (typeof body === 'string') return body;
  for (const k of keyHints) if (typeof body[k] === 'string') return body[k];
  if (typeof body.id === 'string') return body.id;
  for (const v of Object.values(body)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of keyHints) if (typeof v[k] === 'string') return v[k];
      if (typeof v.id === 'string') return v.id;
    }
  }
  return null;
}

function bySeqThenId(a, b) {
  const sa = Number(a && a.seq) || 0, sb = Number(b && b.seq) || 0;
  if (sa !== sb) return sa - sb;
  return String(a && a.id) < String(b && b.id) ? -1 : 1;
}

/* ------------------------------- 用例上下文 ------------------------------- */
/**
 * 单个用例的独立上下文：
 *  - 独立临时 var 目录（THEATER_VAR）；core 不支持时自动退化到仓库 var/（不删除）。
 *  - api/login/ops 探测、账本读取、SSE 注册表、skip/note 收集。
 */
function buildCaseContext({ caseName, portIndex = 0 }) {
  const safe = String(caseName).replace(/[^A-Za-z0-9._-]/g, '_');
  const varDir = path.join(TMP_ROOT, `${safe}-${Date.now()}`);
  const ctx = {
    caseName,
    basePort: BASE_PORT + portIndex * 7,
    port: null,
    server: null,
    varDir,                 // 期望的隔离目录（THEATER_VAR）
    actualVarDir: varDir,   // 实际账本所在目录（resolveVarDir 之后）
    outDir: path.join(varDir, 'out'),
    api: null,
    skips: [],
    notes: [],
    streams: [],
    skip(reason) { ctx.skips.push(reason); },
    note(s) { ctx.notes.push(String(s)); },
    async start() {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        const port = ctx.basePort + attempt * 101;
        try {
          ctx.server = await startServer({ port, varDir: ctx.varDir });
          ctx.port = port;
          ctx.actualVarDir = resolveVarDir(ctx.varDir);
          ctx.outDir = path.join(ctx.actualVarDir, 'out');
          ctx.api = makeApi(port);
          if (ctx.actualVarDir !== ctx.varDir) {
            ctx.note(`core 不支持 THEATER_VAR，退化共享目录 ${ctx.actualVarDir}（用例间共享、结束不删除）`);
          }
          return;
        } catch (e) {
          lastErr = e;
          if (/EADDRINUSE|address already/i.test(String((e && e.message) || e))) continue;
          throw e;
        }
      }
      throw lastErr;
    },
    async stop() {
      for (const s of ctx.streams) { try { s.close(); } catch { /* ignore */ } }
      ctx.streams = [];
      if (ctx.server) { try { await ctx.server.kill(); } catch { /* ignore */ } }
    },
    ledger(kind) { return readLedger(ctx.actualVarDir, kind); },
    stateJson() { return readStateJson(ctx.actualVarDir); },
    async sse(pathName, token) {
      const s = await openSse({ port: ctx.port, token, path: pathName });
      ctx.streams.push(s);
      return s;
    },
    async login(code = INVITE) {
      const resp = await ctx.api('POST', '/api/login', { code });
      expect.status(resp, [200, 201], 'POST /api/login');
      const token = (resp.body && (resp.body.token || (resp.body.data && resp.body.data.token))) || null;
      const user = (resp.body && (resp.body.user || (resp.body.data && resp.body.data.user))) || null;
      expect.ok(token, `POST /api/login 未返回 token：${trunc(resp.text)}`);
      return { token, user };
    },
    _user: null,
    async ensureUser() {
      if (!ctx._user) {
        const r = await ctx.login();
        ctx._user = { token: r.token, user: r.user };
      }
      return ctx._user;
    },
    _ops: undefined,
    /** ops 登录码同 invite；role 由服务端种子决定。拿不到返回 null（用例据此 SKIP）。 */
    async ensureOpsToken(probeRoute = '/api/review/queue') {
      if (ctx._ops !== undefined) return ctx._ops;
      try {
        const { token, user } = await ctx.login();
        if (user && String(user.role).toLowerCase() === 'ops') { ctx._ops = token; return token; }
        // 种子不给 ops：探测服务端是否对 ops 面强制角色；403 才算真拿不到
        const probe = await ctx.api('GET', probeRoute, null, token);
        if (probe.status === 403 || probe.status === 401) { ctx._ops = null; return null; }
        ctx.note('服务端未按契约对 ops 面强制角色，creator token 代打 ops 面（记 note）');
        ctx._ops = token;
        return token;
      } catch (e) {
        ctx._ops = null;
        return null;
      }
    },
  };
  return ctx;
}

module.exports = {
  ROOT, SERVER_ENTRY, TMP_ROOT, INVITE,
  BUSY_STATES, DONE_STATES, FAILED_STATES,
  AssertionError, expect,
  sleep, j, trunc,
  startServer, killChild,
  resolveVarDir, readLedger, readStateJson,
  makeApi, openSse,
  pollUntil, pickList, extractId, bySeqThenId,
  buildCaseContext,
};
