'use strict';
/**
 * 单元级 · quant 裁决（仅 HTTP 可见面；rules 纯函数库由 core/rules selfcheck 覆盖，此处不重复）：
 *  rules.quant 硬规则：tier 序 nvfp4→int8→MXFP8+FP8；unavail 含该 tier → QUANT_RULE 409 弹回＋复述规则；
 *  兜底档（MXFP8+FP8）缺 reason → QUANT_RULE("需理由")；成功兜底 → audit 留痕 quant_fallback + audit_id(#Q-xxx)。
 *  端点/模型变更需 {confirmed:true}，否则 428。
 * 依赖 ops 角色（种子决定）；拿不到 ops → SKIP。
 */
const lib = require('../lib');
const H = require('./_helpers');
const { expect } = lib;

const QUANT_PATH = '/api/admin/registry/quant';
const ENDPOINT_PATH = '/api/admin/registry/endpoint';
// 契约 §4：registry 键＝段位引擎名；imgspark lane 的 MiniMax-H3-Image unavail ["nvfp4","int8"]，兜底档 MXFP8+FP8
const ENGINE_UNAVAIL = process.env.XT_QUANT_ENGINE || 'MiniMax-H3-Image';
const ENGINE_ENDPOINT = process.env.XT_ENDPOINT_ENGINE || 'LTX-2.5';

async function fn(ctx) {
  const opsToken = await ctx.ensureOpsToken();
  if (!opsToken) {
    ctx.skip('无 ops 账号（INV-DEMO-1 种子 role 非 ops）：quant/registry 裁决面无法调用，跳过');
    return;
  }

  // 引擎 id：优先从 state.json settings.registry 动态找 unavail 含 nvfp4 的段位（契约 §4 imgspark lane）
  let engineId = ENGINE_UNAVAIL;
  const sj = ctx.stateJson() || {};
  const reg = (sj.settings && sj.settings.registry) || {};
  const dyn = Object.keys(reg).find((k) => Array.isArray(reg[k].unavail) && reg[k].unavail.includes('nvfp4'));
  if (dyn) engineId = dyn;
  const endpointEngine = Object.keys(reg).find((k) => /LTX/i.test(k)) || ENGINE_ENDPOINT;

  // ① 未发布档（unavail 含 nvfp4）→ 409 弹回 + 复述规则
  const r1 = await ctx.api('POST', QUANT_PATH, { engineId, tier: 'nvfp4' }, opsToken);
  expect.status(r1, [409], `quant 未发布档应 409 弹回（engineId=${engineId}）`);
  expect.code(r1, 'QUANT_RULE', 'quant 未发布档');
  expect.match(r1.text || '', /nvfp4/, `409 应复述规则（含被拒档位 nvfp4）：${lib.trunc(r1.text)}`);
  expect.match(r1.text || '', /(unavail|未发布|不可用|规则)/i, `409 message 应复述规则语义：${lib.trunc(r1.text)}`);

  // ② 兜底档缺 reason → QUANT_RULE("需理由")
  const r2 = await ctx.api('POST', QUANT_PATH, { engineId, tier: 'MXFP8+FP8' }, opsToken);
  expect.status(r2, [400, 409, 422], '兜底档缺 reason 应被拒');
  expect.code(r2, 'QUANT_RULE', '兜底档缺 reason');
  expect.match(r2.text || '', /理由|reason/, `错误应提示"需理由"：${lib.trunc(r2.text)}`);

  // ③ 兜底档带 reason → 成功 + audit 留痕 quant_fallback(#Q-xxx)
  const auditBefore = (ctx.ledger('audit').rows || []).length;
  const r3 = await ctx.api('POST', QUANT_PATH, { engineId, tier: 'MXFP8+FP8', reason: '验收演练：nvfp4/int8 未发布，兜底 MXFP8+FP8' }, opsToken);
  expect.status(r3, [200, 201, 202], '兜底档带 reason 应成功');
  await lib.pollUntil(() => {
    const rows = ctx.ledger('audit').rows || [];
    if (rows.length <= auditBefore) return null;
    return rows.slice(auditBefore).find((r) => /quant_fallback/i.test(String(r.action || ''))) || null;
  }, { timeoutMs: 8000, intervalMs: 300, label: 'log-audit 出现 quant_fallback 留痕' })
    .then((row) => {
      const auditId = String(row.audit_id ?? row.auditId ?? '');
      expect.match(auditId, /^#?Q-/, `quant_fallback 应带 #Q-xxx audit_id，got "${auditId}"`);
    });

  // ④ 端点变更未 confirmed → 428；confirmed:true → 成功
  const r4 = await ctx.api('POST', ENDPOINT_PATH, { engineId: endpointEngine, endpoint: 'http://127.0.0.1:8188' }, opsToken);
  expect.status(r4, [428], `endpoint 变更缺 confirmed:true 应 428（engineId=${endpointEngine}）`);
  const r5 = await ctx.api('POST', ENDPOINT_PATH, { engineId: endpointEngine, endpoint: 'http://127.0.0.1:8188', confirmed: true }, opsToken);
  expect.status(r5, [200, 201, 202], 'endpoint 变更带 confirmed:true 应成功');
}

module.exports = { name: 'U_quant_adjudication', fn };
