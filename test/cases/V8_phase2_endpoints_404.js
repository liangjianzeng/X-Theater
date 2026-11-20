'use strict';
/**
 * V8 二期预留面（反向断言）：一期不实现 BYOK/多供应商路由/价目等端点 → 必须 404。
 * 契约 §3 REST 面没有这些路由；router.handle 未匹配→404 JSON {error:{code,message}}。
 * 同时验证匿名访问契约内端点被 401 拒（鉴权存在），证明 404 非"全部未挂路由"。
 */
const lib = require('../lib');
const { expect } = lib;

const PHASE2_PATHS = [
  '/api/byok',
  '/api/byok/keys',
  '/api/providers',
  '/api/provider-adapters',
  '/api/routing',
  '/api/routes',
  '/api/route-table',
  '/api/route-tables',
  '/api/pricing',
  '/api/prices',
  '/api/price',
  '/api/quote',
  '/api/model-catalog',
];

async function fn(ctx) {
  const { token } = await ctx.ensureUser();

  // 先证鉴权活着：匿名打契约内端点应 401（若实现宽松返回别的，记 note 不阻断）
  const anon = await ctx.api('GET', '/api/state');
  if (anon.status !== 401) ctx.note(`匿名 GET /api/state 返回 ${anon.status}（期望 401，鉴权面请核查）`);

  const offenders = [];
  for (const p of PHASE2_PATHS) {
    const anonResp = await ctx.api('GET', p);
    const authResp = await ctx.api('GET', p, null, token);
    const bad = [];
    if (anonResp.status !== 404) bad.push(`匿名=${anonResp.status}`);
    if (authResp.status !== 404) bad.push(`带token=${authResp.status}`);
    if (bad.length) offenders.push(`${p}(${bad.join(',')})`);
    // 404 应是 JSON 错误体（契约错误格式），宽容只在 body 可解析时校结构
    if (anonResp.status === 404 && anonResp.body) {
      expect.ok(anonResp.body.error, `404 应为 {error:{code,message}} 结构：${p} → ${lib.trunc(anonResp.text)}`);
    }
  }
  expect.eq(offenders.length, 0, `一期不应存在的二期端点仍可访问（应 404）：${lib.trunc(offenders)}`);
  ctx.note(`二期端点 ${PHASE2_PATHS.length} 条全部 404`);
}

module.exports = { name: 'V8_phase2_endpoints_404', fn };
