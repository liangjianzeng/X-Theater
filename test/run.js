'use strict';
/**
 * X-Theater 一期验收套件 runner。
 *   用法：node test/run.js            （顺序跑全部用例）
 *         node test/run.js V1 V9      （按名称前缀过滤）
 * 特性：
 *  - 每用例独立服务器 + 独立临时 var 目录（THEATER_VAR；core 不支持则退化仓库 var/，不删除）。
 *  - 120s/用例超时；SKIP 不算失败；FAIL 才算失败（exit code 非 0）。
 *  - 控制台表格 + test/results.json（{case,status,detail} 数组 + summary）。
 */
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const CASES_DIR = path.join(__dirname, 'cases');
const RESULTS_PATH = path.join(__dirname, 'results.json');
const PER_CASE_TIMEOUT_MS = 120000;

// 显式顺序：V6（会往共享 var 灌模拟告警）排最后，避免影响 V8 禁词扫描等
const ORDER = [
  'V1_full_chain',
  'V10_music_precheck_export',
  'V5_billing_invariant',
  'V8_phase2_endpoints_404',
  'V8_state_langlint',
  'V4_lite_static_sse',
  'U_quant_adjudication',
  'V9_l2_modeA',
  'V9_l2_modeB',
  'V6_review_audit_alerts',
];

/** 清理历史空 tmp（core 未支持 THEATER_VAR 时这些目录未被使用）；非空目录保留为证据 */
function cleanEmptyTmp() {
  try {
    if (!fs.existsSync(lib.TMP_ROOT)) return;
    for (const d of fs.readdirSync(lib.TMP_ROOT)) {
      const p = path.join(lib.TMP_ROOT, d);
      try {
        if (fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0) fs.rmdirSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function loadCases() {
  const out = [];
  if (!fs.existsSync(CASES_DIR)) return out;
  for (const f of fs.readdirSync(CASES_DIR).sort()) {
    if (!f.endsWith('.js') || f.startsWith('_')) continue; // _helpers/_l2_flow 等共享模块不作用例
    let mod;
    try {
      mod = require(path.join(CASES_DIR, f));
    } catch (e) {
      out.push({ name: f.replace(/\.js$/, ''), fn: async () => { throw new Error(`用例模块加载失败：${e.message}`); } });
      continue;
    }
    const items = Array.isArray(mod) ? mod
      : Array.isArray(mod.cases) ? mod.cases
        : (typeof mod.fn === 'function' ? [{ name: mod.name || f.replace(/\.js$/, ''), fn: mod.fn }] : []);
    for (const it of items) {
      if (it && typeof it.fn === 'function') out.push({ name: it.name || f, fn: it.fn, timeoutMs: it.timeoutMs || PER_CASE_TIMEOUT_MS });
    }
  }
  out.sort((a, b) => {
    const ia = ORDER.indexOf(a.name), ib = ORDER.indexOf(b.name);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || String(a.name).localeCompare(String(b.name));
  });
  return out;
}

function withTimeout(promiseFactory, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) { done = true; reject(new Error(`用例超时（${timeoutMs}ms）：${label}`)); }
    }, timeoutMs);
    (async () => { try { const v = await promiseFactory(); if (!done) { done = true; clearTimeout(t); resolve(v); } } catch (e) { if (!done) { done = true; clearTimeout(t); reject(e); } } })();
  });
}

function oneLine(s) { return String(s == null ? '' : s).replace(/\s*\n\s*/g, ' | '); }

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function main() {
  const filters = process.argv.slice(2);
  const all = loadCases();
  const cases = filters.length ? all.filter((c) => filters.some((f) => c.name.startsWith(f))) : all;
  if (!cases.length) {
    console.error('没有匹配的用例。cases 目录：' + CASES_DIR);
    process.exit(2);
  }

  cleanEmptyTmp();
  console.log(`X-Theater 一期验收套件 · ${cases.length} 个用例（超时 ${PER_CASE_TIMEOUT_MS / 1000}s/用例）`);
  console.log('core 入口：' + lib.SERVER_ENTRY + (fs.existsSync(lib.SERVER_ENTRY) ? '' : '  [缺失——core 未交付，用例将以 FAIL(server start failed) 收尾]'));
  console.log('');

  const results = [];
  let pass = 0, fail = 0, skip = 0;

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const t0 = Date.now();
    let status = 'PASS', detail = '';
    const ctx = lib.buildCaseContext({ caseName: c.name, portIndex: i });
    try {
      await withTimeout(async () => { await ctx.start(); await c.fn(ctx); }, c.timeoutMs || PER_CASE_TIMEOUT_MS, c.name);
      if (ctx.skips.length) { status = 'SKIP'; detail = ctx.skips.join('; '); }
      else detail = ctx.notes.join('; ');
    } catch (e) {
      status = 'FAIL';
      detail = oneLine((e && e.message) || String(e));
      if (ctx.skips.length) detail += `（skip 背景：${oneLine(ctx.skips.join('; '))}）`;
    } finally {
      try { await withTimeout(() => ctx.stop(), 15000, `${c.name} 收尾`); } catch { /* 收尾失败不再改判 */ }
    }
    if (status === 'PASS') pass++; else if (status === 'FAIL') fail++; else skip++;
    const dur = ((Date.now() - t0) / 1000).toFixed(1) + 's';
    results.push({ case: c.name, status, detail: detail || (status === 'PASS' ? 'ok' : '') });
    console.log(`  ${c.name} … ${status} (${dur})${detail ? ' — ' + lib.trunc(detail, 140) : ''}`);
  }

  // 控制台表格
  const wCase = Math.max(4, ...results.map((r) => r.case.length));
  const wStat = 4;
  console.log('');
  console.log(pad('CASE', wCase) + '  ' + pad('STATUS', wStat) + '  DETAIL');
  console.log('-'.repeat(wCase + wStat + 80));
  for (const r of results) {
    console.log(pad(r.case, wCase) + '  ' + pad(r.status, wStat) + '  ' + lib.trunc(r.detail, 110));
  }
  console.log('-'.repeat(wCase + wStat + 80));
  console.log(`TOTAL=${results.length}  PASS=${pass}  FAIL=${fail}  SKIP=${skip}`);

  fs.writeFileSync(RESULTS_PATH, JSON.stringify({
    generated_at: new Date().toISOString(),
    node: process.version,
    summary: { total: results.length, pass, fail, skip },
    results,
  }, null, 2));
  console.log('结果已写入 ' + RESULTS_PATH);

  process.exit(fail > 0 ? 1 : 0);
}

process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', (e && e.message) || e); });

main().catch((e) => {
  console.error('runner 崩溃：', e);
  process.exit(2);
});
