'use strict';
/**
 * V8 用户面语言纪律：GET /api/state 全量用户面 JSON 过禁词表（契约 §4 rules.langlint 词表），
 * 断言 clean（用户面零模型名/零 worker/路由/take 等技术词；服务端应在 /state 兜底跑 langlint）。
 * 扫描口径：JSON 内全部字符串"值"（不含键名——§1 存储层键名如 takes.flags.stale 属机读命名，
 * 不在用户渲染面；langlint 面向文案值）。本用例在告警演练(V6)之前跑，避免共享 var 下模拟告警文案干扰。
 */
const lib = require('../lib');
const H = require('./_helpers');
const { expect } = lib;

async function fn(ctx) {
  const st = await H.getState(ctx);
  expect.ok(st && Object.keys(st).length > 0, 'GET /api/state 返回空对象');
  const strings = H.collectStringValues(st);
  expect.gte(strings.length, 5, `/state 字符串值过少，疑似端点未按契约返回 projects/episodes/shots 等`);

  const hits = [];
  for (const s of strings) {
    for (const [re, name] of H.BANNED_PATTERNS) {
      if (re.test(s)) hits.push(`${name} ← "${lib.trunc(s, 120)}"`);
    }
  }
  expect.eq(hits.length, 0, `用户面 /state 命中禁词表（langlint 兜底未生效）：\n  ${lib.trunc(hits.slice(0, 10).join('\n  '), 1500)}`);
  ctx.note(`/state ${strings.length} 个字符串值过禁词表 clean`);
}

module.exports = { name: 'V8_state_langlint', fn };
