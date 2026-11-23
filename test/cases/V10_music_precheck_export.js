'use strict';
/**
 * V10 配乐标准版（可软件化部分）：
 * POST music candidates（mood=离别）→ 3 候选
 * → adopt 标题含「未许可」曲 → precheck 配乐项 fail + export 422/BLOCKED_PRECHECK
 * → 改 adopt 许可曲 → precheck 全绿 → export 成功 + var/out 有 final.mp4
 * + sidecar meta 含 explicit_mark。
 */
const fs = require('fs');
const path = require('path');
const lib = require('../lib');
const H = require('./_helpers');
const { expect, pollUntil, sleep } = lib;

async function fn(ctx) {
  // 前置：跑一集到开机完成（配乐/预检/导出需要成片素材就绪）
  const { epId } = await H.bootstrapEpisode(ctx, { cardsUpTo: 6, brief: '离别之夜，塔台灯火下告别旧友。' });
  // C7/C8 尽力 accept（交付预检清单不含复审门，超时不阻断本用例）
  try {
    await H.acceptCardChain(ctx, epId, 7, 8, { perCardTimeoutMs: 25000 });
  } catch (e) {
    ctx.note(`C7/C8 未完成（export 不依赖）：${lib.trunc(e.message, 80)}`);
  }

  const { token } = await ctx.ensureUser();

  // 找本集「离别」场景（种子 4 scenes 之场2·离别；找不到退回本集任一场景）
  const st0 = await H.getState(ctx);
  let scenes = H.scenesOfEpisode(st0, epId);
  if (!scenes.length) scenes = H.scenesOfEpisode(st0, H.SEED_EPISODE_ID);
  expect.gte(scenes.length, 1, 'state 中无可用 scenes');
  const scene = scenes.find((s) => String(s.mood || '').includes('离别')) || scenes[0];
  const sceneId = scene.id;
  ctx.note(`scene=${sceneId}(mood=${scene.mood})`);

  // ---- 候选 ----
  const base = (await H.listMusicLibrary(ctx)).length;
  const candResp = await ctx.api('POST', '/api/music/candidates', { sceneId, mood: '离别' }, token);
  expect.status(candResp, [200, 201, 202], 'POST /api/music/candidates');
  let candidates = lib.pickList(candResp.body, ['candidates', 'tracks', 'items', 'list']) || [];
  if (candidates.length !== 3) {
    // 候选语义（契约 C9）：完成后进「配乐提案卡」payload.candidates 或曲库净增——两路都认
    candidates = await pollUntil(async () => {
      const libNow = await H.listMusicLibrary(ctx);
      const added = libNow.slice(base);
      if (added.length >= 3) return added;
      const cr = await ctx.api('GET', '/api/cards?episodeId=' + epId + '&status=pending', null, token);
      const pending = (cr.body && (cr.body.cards || cr.body.list || [])) || [];
      for (const c of pending) {
        const cs = (c.payload && (c.payload.candidates || c.payload.tracks)) || [];
        if (cs.length >= 3) return cs;
      }
      return null;
    }, { timeoutMs: 30000, label: 'music 候选 3 条（响应体/曲库净增/C9 提案卡）' });
  }
  expect.gte(candidates.length, 3, `候选应 3 条，实际 ${candidates.length}`);
  // 影子计费 5–15 分/条（软记录）
  const cents = candidates.map((c) => Number(c.shadow_cents ?? c.cost_cents)).filter(Number.isFinite);
  if (cents.length) ctx.note(`候选影子计费=${cents.join(',')}`);

  // ---- adopt「未许可」曲 → 预检应拦 ----
  const libNow = await H.listMusicLibrary(ctx);
  const badTrack = libNow.find((t) => /未许可/.test(String(t.title || '')) && t && t.license && String(t.license.usage) === 'missing')
    || candidates.find((t) => /未许可/.test(String(t.title || '')))
    || libNow.find((t) => /未许可/.test(String(t.title || '')));
  expect.ok(badTrack, '曲库/候选中找不到标题含「未许可」且 usage=missing 的演示曲（种子附录 A 应预置）');
  let resp = await ctx.api('POST', `/api/music/${encodeURIComponent(badTrack.id)}/adopt`, { sceneId }, token);
  if (resp.status === 409) resp = await ctx.api('POST', `/api/music/${encodeURIComponent(badTrack.id)}/adopt`, { sceneId }, token);
  expect.status(resp, [200, 201, 202], 'adopt 未许可曲');

  // precheck：配乐项 fail
  const pc1 = await H.precheck(ctx, epId);
  expect.status(pc1, [200, 422], 'POST precheck（配乐缺许可）');
  const items1 = H.precheckItems(pc1);
  expect.ok(items1 && items1.length >= 4, `precheck 清单异常：${lib.trunc(pc1.text)}`);
  const musicItem1 = items1.find((it) => /配乐|音乐|许可|music|license/i.test(String(it.item || it.name || '')));
  expect.ok(musicItem1, `precheck 清单缺「配乐双许可」项：${lib.trunc(items1.map((i) => i.item || i.name))}`);
  expect.eq(musicItem1.pass, false, 'adopt 未许可曲后配乐项应 fail');

  // export 应被拦：422 + BLOCKED_PRECHECK
  const ex1 = await ctx.api('POST', `/api/episodes/${encodeURIComponent(epId)}/export`, {}, token);
  expect.status(ex1, [422], '未全绿 export 应 422');
  expect.code(ex1, 'BLOCKED_PRECHECK', 'export 被拦');

  // ---- 换许可曲 → 全绿 → export ----
  const goodTrack = candidates.find((t) => !/未许可/.test(String(t.title || '')) && (!t.license || String(t.license.usage || 'ok') === 'ok'))
    || candidates.find((t) => !/未许可/.test(String(t.title || '')))
    || libNow.find((t) => !/未许可/.test(String(t.title || '')) && t.license && String(t.license.usage) === 'ok');
  expect.ok(goodTrack, '找不到可 adopt 的许可曲');
  let resp2 = await ctx.api('POST', `/api/music/${encodeURIComponent(goodTrack.id)}/adopt`, { sceneId }, token);
  if (resp2.status === 409) resp2 = await ctx.api('POST', `/api/music/${encodeURIComponent(goodTrack.id)}/adopt`, { sceneId }, token);
  expect.status(resp2, [200, 201, 202], 'adopt 许可曲');

  // 交付前置批复：本集复审项全部放行（「分辨率」项的产品语义＝无未通过镜头；与 V1/V6 同一道门）
  // 注意 H.reviewQueue 的入参是 state 对象（非 ctx）；login(INV-DEMO-1) 即 ops 账号（契约 §8）
  {
    const rqAll = H.reviewQueue(await H.getState(ctx)) || [];
    for (const it of rqAll) {
      if (String(it.status || 'pending') !== 'pending') continue;
      const dr = await ctx.api('POST', '/api/review/' + encodeURIComponent(it.id) + '/decide',
        { action: 'pass', reason: '验收预检前批复（自动化验收脚本）', ver: it.ver ?? 1 }, token);
      if (dr.status !== 200) ctx.note(`review ${it.id} decide→${dr.status} ${lib.trunc(dr.text)}`);
    }
    await pollUntil(async () => {
      const rq2 = H.reviewQueue(await H.getState(ctx)) || [];
      return rq2.every((r) => String(r.status || 'pending') !== 'pending') ? true : null;
    }, { timeoutMs: 15000, intervalMs: 600, label: '复审项全部批复（pass）' });
  }

  const pc2 = await H.precheck(ctx, epId);
  expect.status(pc2, [200], 'POST precheck（换许可曲后）');
  const items2 = H.precheckItems(pc2) || [];
  const failing = items2.filter((it) => it.pass !== true);
  expect.eq(failing.length, 0, `换许可曲后 precheck 应全绿，仍 fail：${JSON.stringify(failing)}`);

  const ex2 = await ctx.api('POST', `/api/episodes/${encodeURIComponent(epId)}/export`, {}, token);
  expect.status(ex2, [200, 201, 202], '全绿 export 应成功');

  // var/out/final.mp4 + sidecar meta explicit_mark
  const outDir = ctx.outDir;
  await pollUntil(() => {
    if (!fs.existsSync(outDir)) return null;
    const files = fs.readdirSync(outDir);
    const mp4 = files.find((f) => /final.*\.mp4$/i.test(f));
    if (!mp4) return null;
    const st = fs.statSync(path.join(outDir, mp4));
    return st.size > 0 ? { mp4, files } : null;
  }, { timeoutMs: 60000, intervalMs: 700, label: `var/out/ 出现非空 final mp4（目录=${outDir}）` });

  const files = fs.readdirSync(outDir);
  const metaFile = files.find((f) => /final.*\.meta\.json$/i.test(f) || /^final\.meta\.json$/i.test(f))
    || files.find((f) => /\.meta\.json$/i.test(f));
  expect.ok(metaFile, `var/out 缺 sidecar meta（文件=${files.join(',')}）`);
  const metaText = fs.readFileSync(path.join(outDir, metaFile), 'utf8');
  expect.match(metaText, /"explicit_mark"\s*:\s*true/, `sidecar ${metaFile} 应含 explicit_mark:true`);

  // ---- 成片存库随时可看（2026-11-23 用户令）：交付路径必须持久化进 episode（重启不丢） ----
  const stAfter = await H.getState(ctx);
  const epAfter = H.asMap(stAfter.episodes)[epId] || {}; // /api/state 的 episodes 是数组（H.asMap 兼容两种形态）
  expect.ok(epAfter.final_art, '导出后 ep.final_art 应持久化交付路径（旧版只活在内存 jobs Map，重启即蒸发）');
  const finalAbs = path.join(ctx.actualVarDir, String(epAfter.final_art || '').replace(/^var\//, ''));
  expect.ok(fs.existsSync(finalAbs), `ep.final_art 指向的文件应存在：${finalAbs}`);
  expect.ok(epAfter.final_meta && epAfter.final_meta.delivered_at, 'final_meta 应含 delivered_at 出货时间');
  expect.eq(epAfter.final_meta && epAfter.final_meta.placeholder, true,
    '套件 stub 模式出货必须如实标 placeholder（真合成出货由真机 E2E 覆盖）');

  ctx.note(`export artifacts: ${files.join(',')}`);
}

module.exports = { name: 'V10_music_precheck_export', fn };
