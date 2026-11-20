'use strict';
/**
 * V9 L2 Copilot · 模式 A（dsh-stub）：
 *  POST /api/l2/sessions {mode:"A"} → 5 类查询消息（白名单工具）→ approval 流程（reroll 触发
 *  approval_request→approve→job 出现）→ 红队三案（间接注入/未批 execute/跨 session）。
 * 注意：模式 A 为 DSH stub；DSH 真实例为硬件项（BLOCKED，见 README）。
 */
const H = require('./_helpers');
const { runL2Full } = require('./_l2_flow');

module.exports = { name: 'V9_l2_modeA', fn: (ctx) => runL2Full(ctx, 'A') };
