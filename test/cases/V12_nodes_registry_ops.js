'use strict';
/**
 * V12 节点/引擎注册表运维（2026-11-22 运维台化整改验收）：
 *  - 算力节点 CRUD：登记新节点 → 201；重复/非法 id → 409/400；改名/显存闸 → 200；GET /api/nodes 全量可见。
 *  - 剧集渲染分配：driver 可指向任意已登记节点（不再二值钳制 dgx/local）；未知节点 → 400。
 *  - 引擎注册表 CRUD：登记新引擎（lane 枚举校验/未知节点校验）→ 201；改绑归属节点 428→confirmed→200；
 *  - 删节点护栏：有引擎绑定 → 409 NODE_HAS_ENGINES；有剧集指向 → 409 NODE_HAS_EPISODES；解绑后可删。
 *  - 注销引擎：无 confirmed → 428；confirmed → 200 且 GET 不再出现。
 *  - LLM 承载切换：任意已登记节点可承载；审计留痕 node_add/node_remove/registry_add 等。
 * 依赖 ops 角色（种子决定）；拿不到 ops → SKIP。
 */
const lib = require('../lib');
const H = require('./_helpers');
const { expect } = lib;

const NODES = '/api/nodes';
const REG = '/api/admin/registry';
const NID = 'gpu3';
const ENGINE_ID = 'V12-Test-Engine';

async function fn(ctx) {
  const opsToken = await ctx.ensureOpsToken();
  if (!opsToken) {
    ctx.skip('无 ops 账号（INV-DEMO-1 种子 role 非 ops）：节点/引擎注册表运维面无法调用，跳过');
    return;
  }
  const audit0 = (ctx.ledger('audit').rows || []).length;

  // ① 基线：GET /api/nodes → 种子 local/dgx，且带 gpu_gate 布尔与剧集清单
  const r0 = await ctx.api('GET', NODES, null, opsToken);
  expect.status(r0, 200, 'GET /api/nodes');
  const baseNodes = (r0.body && r0.body.nodes) || [];
  const ids = baseNodes.map((n) => n.id);
  expect.ok(ids.indexOf('local') >= 0, '种子节点 local 存在');
  expect.ok(ids.indexOf('dgx') >= 0, '种子节点 dgx 存在');
  baseNodes.forEach((n) => expect.ok(typeof n.gpu_gate === 'boolean', '节点 ' + n.id + ' 带 gpu_gate 布尔'));
  expect.ok(Array.isArray(r0.body.episodes), 'GET /api/nodes 带剧集渲染分配清单');

  // ② 节点登记：合法 → 201；重复 → 409；非法 id → 400
  const rAdd = await ctx.api('POST', NODES,
    { id: NID, label: '3 号测试机', comfy_base: 'http://127.0.0.1:9188', gpu_gate: false }, opsToken);
  expect.status(rAdd, 201, 'POST /api/nodes 登记新节点');
  const rDup = await ctx.api('POST', NODES, { id: NID, label: '重复' }, opsToken);
  expect.status(rDup, 409, '重复节点 id → 409');
  expect.code(rDup, 'CONFLICT', '重复节点 id 错误码');
  const rBad = await ctx.api('POST', NODES, { id: '不/合法', label: 'x' }, opsToken);
  expect.status(rBad, 400, '非法节点 id → 400');

  // ③ 节点信息编辑：改名＋开闸 → 200；GET 可见
  const rUpd = await ctx.api('PUT', NODES + '/' + NID, { label: '3 号机（改）', gpu_gate: true }, opsToken);
  expect.status(rUpd, 200, 'PUT /api/nodes/:id 信息编辑');
  const rGet1 = await ctx.api('GET', NODES, null, opsToken);
  const gpu3 = (rGet1.body.nodes || []).filter((n) => n.id === NID)[0];
  expect.ok(gpu3, '新节点出现在节点注册表');
  expect.eq(gpu3.label, '3 号机（改）', '节点改名生效');
  expect.eq(gpu3.gpu_gate, true, '显存互斥闸开启生效');

  // ④ 剧集渲染分配：driver 指向新节点 → 200；未知节点 → 400
  const rDrv = await ctx.api('PUT', NODES + '/episodes/e1/driver', { driver: NID }, opsToken);
  expect.status(rDrv, 200, 'driver 指向任意已登记节点');
  const rDrvGet = await ctx.api('GET', NODES, null, opsToken);
  const epRow = (rDrvGet.body.episodes || []).filter((e) => e.id === 'e1')[0];
  expect.ok(epRow, 'e1 在分配清单');
  expect.eq(epRow.driver, NID, 'e1.driver 已指到新节点（不再钳制 dgx/local）');
  const rDrvBad = await ctx.api('PUT', NODES + '/episodes/e1/driver', { driver: '不存在节点' }, opsToken);
  expect.status(rDrvBad, 400, '未知节点 driver → 400');

  // ⑤ 引擎注册表基线：条目带 node 绑定＋lanes 枚举下发
  const rReg0 = await ctx.api('GET', REG, null, opsToken);
  expect.status(rReg0, 200, 'GET /api/admin/registry');
  const reg0 = (rReg0.body && rReg0.body.registry) || {};
  expect.ok(Array.isArray(rReg0.body.lanes) && rReg0.body.lanes.length >= 8, '注册表响应带 lanes 车道枚举');
  expect.ok(reg0['MiniMax-H3-Image'] && reg0['MiniMax-H3-Image'].node === 'dgx', '存量引擎 MiniMax-H3-Image 绑定 dgx（迁移/种子补齐）');
  expect.ok(reg0['qwen-image-2.1-turbo-Q5_K_M'] && reg0['qwen-image-2.1-turbo-Q5_K_M'].node === 'local', '存量引擎 img5060 绑定 local');

  // ⑥ 引擎登记：未知 lane → 400；未知节点 → 400；合法 → 201
  const rEngBadLane = await ctx.api('POST', REG, { engineId: ENGINE_ID, lane: '不存在的车道' }, opsToken);
  expect.status(rEngBadLane, 400, '未知 lane → 400');
  const rEngBadNode = await ctx.api('POST', REG, { engineId: ENGINE_ID, lane: 'music', node: '幽灵节点' }, opsToken);
  expect.status(rEngBadNode, 400, '未知归属节点 → 400');
  const rEng = await ctx.api('POST', REG,
    { engineId: ENGINE_ID, lane: 'music', node: null, quant: 'fp16', endpoint: 'V12 演练端点', published: ['fp16'] }, opsToken);
  expect.status(rEng, 201, 'POST /api/admin/registry 登记新引擎');

  // ⑦ 改绑归属节点：无 confirmed → 428；confirmed → 200
  const rBind0 = await ctx.api('POST', REG + '/node', { engineId: ENGINE_ID, node: NID }, opsToken);
  expect.status(rBind0, 428, '改绑缺 confirmed → 428');
  const rBind = await ctx.api('POST', REG + '/node', { engineId: ENGINE_ID, node: NID, confirmed: true }, opsToken);
  expect.status(rBind, 200, '改绑归属节点 → 200');
  expect.eq((rBind.body.entry || {}).node, NID, '改绑后 node=新节点');

  // ⑧ 删节点护栏：有引擎绑定 → 409 NODE_HAS_ENGINES（message 复述绑定引擎清单）
  const rDel0 = await ctx.api('POST', NODES + '/' + NID + '/remove', {}, opsToken);
  expect.status(rDel0, 409, '有引擎绑定的节点拒绝删除');
  expect.code(rDel0, 'NODE_HAS_ENGINES', '护栏错误码 NODE_HAS_ENGINES');
  expect.match(rDel0.text || '', new RegExp(ENGINE_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '409 message 复述绑定引擎');

  // ⑨ 解绑引擎 → 仍有剧集指向 → 409 NODE_HAS_EPISODES → 换回 local 后仍有用户默认算力 → 409 NODE_HAS_USERS → 清除后可删
  const rUnbind = await ctx.api('POST', REG + '/node', { engineId: ENGINE_ID, node: null, confirmed: true }, opsToken);
  expect.status(rUnbind, 200, '解绑引擎归属节点');
  const rDel1 = await ctx.api('POST', NODES + '/' + NID + '/remove', {}, opsToken);
  expect.status(rDel1, 409, '有剧集指向的节点拒绝删除');
  expect.code(rDel1, 'NODE_HAS_EPISODES', '护栏错误码 NODE_HAS_EPISODES');
  const rDrvBack = await ctx.api('PUT', NODES + '/episodes/e1/driver', { driver: 'local' }, opsToken);
  expect.status(rDrvBack, 200, 'e1 渲染分配切回 local');
  // 用户默认算力（2026-11-22 用户级路由）：指向新节点 → 撤节点被拦 → 清除后可删
  const rUdrv = await ctx.api('PUT', NODES + '/users/u1/driver', { driver: NID }, opsToken);
  expect.status(rUdrv, 200, '用户默认算力指向新节点');
  const rDel1u = await ctx.api('POST', NODES + '/' + NID + '/remove', {}, opsToken);
  expect.status(rDel1u, 409, '有用户默认算力指向的节点拒绝删除');
  expect.code(rDel1u, 'NODE_HAS_USERS', '护栏错误码 NODE_HAS_USERS');
  const rUdrvClear = await ctx.api('PUT', NODES + '/users/u1/driver', { driver: '' }, opsToken);
  expect.status(rUdrvClear, 200, '清除用户默认算力');
  const rDel2 = await ctx.api('POST', NODES + '/' + NID + '/remove', {}, opsToken);
  expect.status(rDel2, 200, '解绑＋换向＋清默认后节点可删');
  const rGet2 = await ctx.api('GET', NODES, null, opsToken);
  expect.ok(((rGet2.body.nodes || []).filter((n) => n.id === NID)).length === 0, 'GET 不再出现已撤节点');

  // ⑩ 注销引擎：无 confirmed → 428；confirmed → 200 且 GET 消失
  const rEngDel0 = await ctx.api('POST', REG + '/remove', { engineId: ENGINE_ID }, opsToken);
  expect.status(rEngDel0, 428, '注销引擎缺 confirmed → 428');
  const rEngDel = await ctx.api('POST', REG + '/remove', { engineId: ENGINE_ID, confirmed: true }, opsToken);
  expect.status(rEngDel, 200, '注销引擎 → 200');
  const rEngGet = await ctx.api('GET', REG + '/' + encodeURIComponent(ENGINE_ID), null, opsToken);
  expect.status(rEngGet, 404, '注销后 GET → 404');

  // ⑪ LLM 承载切换：任意已登记节点可承载（切 dgx 再切回 local）
  const rLlmDgx = await ctx.api('PUT', NODES + '/llm-node', { node: 'dgx' }, opsToken);
  expect.status(rLlmDgx, 200, 'LLM 承载切到 dgx');
  const rLlmBack = await ctx.api('PUT', NODES + '/llm-node', { node: 'local' }, opsToken);
  expect.status(rLlmBack, 200, 'LLM 承载切回 local');
  const rLlmBad = await ctx.api('PUT', NODES + '/llm-node', { node: '幽灵节点' }, opsToken);
  expect.status(rLlmBad, 400, '未知节点承载 LLM → 400');

  // ⑫ 审计留痕：节点/引擎全生命周期动作都在 audit 账本
  const rows = (ctx.ledger('audit').rows || []).slice(audit0);
  const actions = rows.map((r) => r.action);
  ['node_add', 'node_update', 'node_remove', 'episode_driver_switch', 'registry_add',
    'registry_node_rebind', 'registry_remove', 'llm_node_switch', 'user_driver_switch'].forEach((a) =>
    expect.ok(actions.indexOf(a) >= 0, '审计留痕含 ' + a));

  // ⑬ 复原（幂等收尾）：确认种子拓扑未被本用例破坏。
  // 注意：state.json 是 50ms 防抖落盘，此处读盘会撞竞态——套件纪律"只经 HTTP 观察"，走 GET /api/nodes。
  const rFinal = await ctx.api('GET', NODES, null, opsToken);
  expect.eq((rFinal.body.nodes || []).length, 2, '收尾：节点表回到 local/dgx 两台');
  const epFinal = (rFinal.body.episodes || []).filter((e) => e.id === 'e1')[0];
  expect.ok(epFinal, '收尾：分配清单含 e1');
  expect.eq(epFinal.driver, 'local', '收尾：e1.driver=local');
}

module.exports = { name: 'V12_nodes_registry_ops', fn };
