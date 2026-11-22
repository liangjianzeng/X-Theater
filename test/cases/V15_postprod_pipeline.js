'use strict';
/**
 * V15 后期流水线（2026-11-22 对标调研梯队落实，stub 面）：
 *  1) 多镜串拍（video_ms）：shoot mode:"group" → 同场相邻镜一次前生成按时间码分段落 take
 *     ——每镜 take 带 multishot_group（groupId/seg_index/frames），段文件落盘
 *  2) 转场衔接镜（transition）：POST /transitions {pairs} → 幂等 → done 后 state.transitions 带 take，
 *     GET /transitions 可查；重复提交 dedup
 *  3) 口型重绘（lipsync）：POST /api/shots/:id/lipsync → 新 take「自部署·口型档」+ lipsync-stub 诚实占位
 *  4) 超分（superres）：POST /api/shots/:id/superres → 新 take「自部署·精修档」resolution 1080x1920
 *  5) 音效（sfx）：POST /api/episodes/:id/sfx → asset_lib.audio.sfx 入库 + wav 落盘
 *  6) aireview 钩子人格：C1 payload.ai_review.personas 含「网感编辑视角」（梯队③）
 */
const fs = require('fs');
const path = require('path');
const lib = require('../lib');
const H = require('./_helpers');
const { expect, pollUntil } = lib;

const DONE = lib.DONE_STATES;
const isDone = (s) => DONE.has(String(s && s.status || '').toLowerCase());

async function fn(ctx) {
  const { token } = await ctx.ensureUser();
  const api = (m, p, b) => ctx.api(m, p, b, token);

  // 0) 常规开机一轮（bootstrap 到 C6，16 镜全终态）——先有 takes，转场衔接镜才有 A 侧输入
  const { epId } = await H.bootstrapEpisode(ctx, { title: '验收集-后期流水线-' + Date.now() });

  // 1) 多镜串拍：mode:"group" 二次开机（幂等：单镜 video 会被 dedup，新增的是 video_ms 组）
  // shoot 走 cas(estimate_ver)：先取最新预估 ver 再提交
  const estG = await api('GET', `/api/episodes/${encodeURIComponent(epId)}/estimate`);
  expect.status(estG, 200, 'GET estimate（group 开机）');
  const shoot2 = await api('POST', `/api/episodes/${encodeURIComponent(epId)}/shoot`, { ver: (estG.body || {}).ver, mode: 'group' });
  expect.status(shoot2, [200, 201, 202], 'POST shoot mode:group');

  const msJobs = await pollUntil(async () => {
    const r = await api('GET', `/api/jobs?episodeId=${encodeURIComponent(epId)}`);
    if (r.status !== 200) return null;
    const rows = (r.body && (r.body.jobs || r.body.rows)) || [];
    const ms = rows.filter((x) => x && x.type === 'video_ms');
    return ms.length >= 1 && ms.every((x) => isDone(x)) ? ms : null;
  }, { timeoutMs: 60000, intervalMs: 800, label: 'video_ms 组任务全部终态' });
  expect.ok(msJobs && msJobs.length >= 1, `mode:group 应派 video_ms 组任务，实际 ${msJobs && msJobs.length}`);

  // 分段落 take：每镜 take 带 multishot_group 且段文件在盘上
  const st1 = await H.getState(ctx);
  const shots1 = H.shotsOfEpisode(st1, epId);
  const msTakes = [];
  for (const s of shots1) {
    for (const t of (s.takes || [])) {
      if (t && t.multishot_group) msTakes.push({ shot: s, take: t });
    }
  }
  expect.ok(msTakes.length >= 2, `video_ms 应为 ≥2 镜落分段 take，实际 ${msTakes.length}`);
  const outDir = ctx.outDir;
  const missing = msTakes.filter((x) => !fs.existsSync(path.join(outDir, path.basename(String(x.take.art || '')))));
  expect.eq(missing.length, 0, `分段 take 文件缺失：${lib.trunc(missing.map((x) => x.take.art).join(','))}`);
  expect.ok(msTakes.every((x) => x.take.multishot_group.groupId), '分段 take 带 groupId');
  // 组内 seg_index 连续（同组）
  const g0 = msTakes[0].take.multishot_group.groupId;
  const segs = msTakes.filter((x) => x.take.multishot_group.groupId === g0).map((x) => x.take.multishot_group.seg_index).sort((a, b) => a - b);
  expect.ok(segs.every((v, i) => v === i), `组 ${g0} seg_index 应连续：${segs.join(',')}`);

  // 2) 转场衔接镜：组内相邻镜（同一场景内 seq 相邻）一对 → 派单 → done → 台账可查 → 幂等 dedup
  const sorted = shots1.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const withTake = sorted.filter((s) => (s.takes || []).length);
  expect.ok(withTake.length >= 2, '至少 2 镜有 take 才能测转场');
  const pair = { fromShotId: withTake[0].id, toShotId: withTake[1].id };
  const tr1 = await api('POST', `/api/episodes/${encodeURIComponent(epId)}/transitions`, { pairs: [pair], sec: 2 });
  expect.status(tr1, [200, 201, 202], 'POST /transitions');
  const tr2 = await api('POST', `/api/episodes/${encodeURIComponent(epId)}/transitions`, { pairs: [pair], sec: 2 });
  expect.status(tr2, [200, 201, 202], 'POST /transitions 重复提交');
  // 幂等口径：transitionId 确定性（tr_hash(episode+from+to)）→ 无论 dedup 与否（stub 任务毫秒级完成，
  // 重复提交可能已过「活任务」窗口而重新派单），台账同一 pair 只有一条记录、take 覆盖不堆叠

  await pollUntil(async () => {
    const r = await api('GET', `/api/episodes/${encodeURIComponent(epId)}/transitions`);
    if (r.status !== 200) return null;
    const list = ((r.body || {}).transitions || []).filter((t) => t.fromShotId === pair.fromShotId);
    return list.length === 1 && list[0].take && list[0].take.art ? list[0] : null;
  }, { timeoutMs: 60000, intervalMs: 800, label: '转场衔接镜 take 落台账' });
  const trList = await api('GET', `/api/episodes/${encodeURIComponent(epId)}/transitions`);
  const trRec = ((trList.body || {}).transitions || []).find((t) => t.fromShotId === pair.fromShotId);
  expect.ok(trRec && trRec.take && trRec.take.art, '转场台账含 take.art');
  expect.ok(fs.existsSync(path.join(outDir, path.basename(String(trRec.take.art)))), '转场衔接镜文件落盘');

  // 2.5) 生成档位（2026-11-22 运营化）：拍摄前选 speed/quality → 预估报价联动 + 派单车道切换
  const estP0 = await api('GET', `/api/episodes/${encodeURIComponent(epId)}/estimate`);
  expect.status(estP0, 200, 'GET estimate（档位基线）');
  expect.eq((estP0.body || {}).video_pref, 'auto', '缺省档位 auto');
  // 档位路由确定性：把本集驱动指到 dgx（池按用户默认算力先候选——测试用户 driver 可能钉 local）
  const opsT = await ctx.ensureOpsToken();
  if (opsT) {
    const drv = await ctx.api('PUT', `/api/nodes/episodes/${encodeURIComponent(epId)}/driver`, { driver: 'dgx' }, opsT);
    expect.status(drv, 200, 'PUT driver=dgx（档位路由确定性）');
  }
  const setQ = await api('POST', `/api/episodes/${encodeURIComponent(epId)}/video-pref`, { pref: 'quality' });
  expect.status(setQ, 200, 'POST video-pref quality');
  expect.eq((setQ.body || {}).video_pref, 'quality', '档位写入 quality');
  const estP1 = await api('GET', `/api/episodes/${encodeURIComponent(epId)}/estimate`);
  expect.eq((estP1.body || {}).video_pref, 'quality', '预估联动 quality');
  expect.ok(((estP1.body || {}).breakdown || []).some((b) => b.tier === 'high' && (b.qty || 0) >= 1), 'quality：全部镜头计高价值档');
  const shootQ = await api('POST', `/api/episodes/${encodeURIComponent(epId)}/shoot`, { ver: (estP1.body || {}).ver, shotIds: [withTake[0].id] });
  expect.status(shootQ, [200, 201, 202], 'quality 档开机（单镜局部重拍口径，防与全量任务幂等相撞）');
  const qJobs = ((shootQ.body || {}).jobs || []).filter((x) => x && x.type === 'video');
  expect.ok(qJobs.length >= 1, 'quality：派出 video 任务');
  expect.ok(qJobs.every((x) => x.lane === 't2v.remote'), 'quality：video 走远程车道');
  expect.ok(qJobs.every((x) => x.tier === 'high'), 'quality：任务 tier=high');
  const setS = await api('POST', `/api/episodes/${encodeURIComponent(epId)}/video-pref`, { pref: 'speed' });
  expect.status(setS, 200, 'POST video-pref speed');
  const estP2 = await api('GET', `/api/episodes/${encodeURIComponent(epId)}/estimate`);
  expect.ok(((estP2.body || {}).breakdown || []).some((b) => b.tier === 'fast' && (b.qty || 0) >= 1), 'speed：全部镜头计快速档');
  const shootS = await api('POST', `/api/episodes/${encodeURIComponent(epId)}/shoot`, { ver: (estP2.body || {}).ver, shotIds: [withTake[1].id] });
  expect.status(shootS, [200, 201, 202], 'speed 档开机（另一镜）');
  const sJobs = ((shootS.body || {}).jobs || []).filter((x) => x && x.type === 'video');
  expect.ok(sJobs.length >= 1 && sJobs.every((x) => x.lane === 't2v.remote'), 'speed：video 走远程车道');
  expect.ok(sJobs.every((x) => x.tier === 'fast'), 'speed：任务 tier=fast（worker 选 LTX 快速档）');
  const backA = await api('POST', `/api/episodes/${encodeURIComponent(epId)}/video-pref`, { pref: 'auto' });
  expect.status(backA, 200, '档位切回 auto');
  const bad = await api('POST', `/api/episodes/${encodeURIComponent(epId)}/video-pref`, { pref: 'xxx' });
  expect.status(bad, 400, '非法档位 400');

  // 3) 口型重绘（stub 诚实占位）
  const lsShot = withTake[0];
  const ls = await api('POST', `/api/shots/${encodeURIComponent(lsShot.id)}/lipsync`, {});
  expect.status(ls, [200, 201, 202], 'POST /api/shots/:id/lipsync');
  await pollUntil(async () => {
    const st = await H.getState(ctx);
    const s = H.shotsOfEpisode(st, epId).find((x) => x.id === lsShot.id);
    return s && (s.takes || []).some((t) => t && t.engine === '自部署·口型档') ? true : null;
  }, { timeoutMs: 30000, intervalMs: 600, label: '口型重绘新 take 落镜' });
  const stLs = await H.getState(ctx);
  const lsTake = H.shotsOfEpisode(stLs, epId).find((x) => x.id === lsShot.id).takes.find((t) => t.engine === '自部署·口型档');
  expect.ok(fs.existsSync(path.join(outDir, path.basename(String(lsTake.art)))), '口型 take 文件落盘');

  // 4) 超分（stub 诚实占位，1080x1920 档）
  const sr = await api('POST', `/api/shots/${encodeURIComponent(lsShot.id)}/superres`, {});
  expect.status(sr, [200, 201, 202], 'POST /api/shots/:id/superres');
  await pollUntil(async () => {
    const st = await H.getState(ctx);
    const s = H.shotsOfEpisode(st, epId).find((x) => x.id === lsShot.id);
    return s && (s.takes || []).some((t) => t && t.engine === '自部署·精修档') ? true : null;
  }, { timeoutMs: 30000, intervalMs: 600, label: '超分新 take 落镜' });

  // 5) 音效：desc → asset_lib.audio.sfx 入库 + wav 落盘
  const sfx = await api('POST', `/api/episodes/${encodeURIComponent(epId)}/sfx`, { desc: '深夜码头关门声，低频闷响', sec: 3 });
  expect.status(sfx, [200, 201, 202], 'POST /api/episodes/:id/sfx');
  const sfxEntry = await pollUntil(async () => {
    const r = await api('GET', `/api/episodes/${encodeURIComponent(epId)}/sfx`);
    if (r.status !== 200) return null;
    const list = ((r.body || {}).sfx || []).filter((x) => x && x.title && String(x.title).indexOf('关门声') >= 0);
    return list.length ? list[list.length - 1] : null;
  }, { timeoutMs: 30000, intervalMs: 600, label: '音效素材入库' });
  expect.ok(sfxEntry && sfxEntry.art, '音效条目带 art');
  expect.ok(fs.existsSync(path.join(outDir, path.basename(String(sfxEntry.art)))), '音效 wav 落盘');

  // 6) aireview 网感编辑人格（梯队③）：C1 pending 窗口内轮询（aireview 结果只回写 pending 卡，
  //    bootstrap 快速拍板会错过窗口——这里单开一集，先等审查落卡再拍板）
  const ep2Title = '验收集-钩子审查-' + Date.now();
  const ep2Resp = await api('POST', '/api/episodes', { projectId: H.PROJECT_ID, title: ep2Title, brief: '豪门弃妇携子归来，全家跪求原谅。', kind: 'one_liner' }, token);
  expect.status(ep2Resp, [200, 201, 202], 'POST /api/episodes（钩子审查集）');
  const epId2 = await pollUntil(async () => {
    const st = await H.getState(ctx);
    const hit = Object.values(H.asMap(st.episodes)).find((e) => e && e.title === ep2Title);
    return hit ? hit.id : null;
  }, { timeoutMs: 10000, intervalMs: 500, label: '钩子审查集 id' });
  expect.ok(epId2, '钩子审查集 id 不可得');
  await pollUntil(async () => {
    const r = await api('GET', `/api/cards?episodeId=${encodeURIComponent(epId2)}&type=C1`);
    if (r.status !== 200) return null;
    const cards = (r.body && (r.body.cards || r.body.rows)) || [];
    const hit = cards.some((c) => {
      const personas = c && c.payload && c.payload.ai_review && c.payload.ai_review.personas;
      return Array.isArray(personas) && personas.some((p) => p && p.persona === '网感编辑视角');
    });
    return hit ? true : null;
  }, { timeoutMs: 40000, intervalMs: 700, label: 'C1 aireview 含网感编辑人格（pending 窗口）' });

  ctx.note(`V15 OK：video_ms 组 ${msJobs.length}、分段 take ${msTakes.length}、转场 1、口型/超分/音效各 1`);
}

module.exports = { name: 'V15_postprod_pipeline', fn };
