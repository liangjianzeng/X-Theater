'use strict';
/**
 * V9 L2 Copilot · 模式 B（selfloop 自建规则式）：与模式 A 同一流程双跑（契约 §5 / V9 双模式零越权）。
 */
const { runL2Full } = require('./_l2_flow');

module.exports = { name: 'V9_l2_modeB', fn: (ctx) => runL2Full(ctx, 'B') };
