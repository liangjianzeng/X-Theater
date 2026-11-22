'use strict';
/**
 * V11 素材中心（施工 docs/theater-asset-center-build.md §8）：
 *  1) 迁移：种子曲 mu1/mu2 → asset_lib.audio.music（global/approved），旧 music_lib 保留
 *  2) 冷启动闭环：无集上下文 generate → 候选池 → adopt → bind（primary）
 *  3) 多挂/解绑：一曲绑 2 场互不影响；解绑其一其余不变
 *  4) 旧接口兼容：/api/music/library 旧形状投影（primary→sceneId）；/api/music/:id/adopt 走绑定
 *  5) 账本口径：素材任务 billing 行 episodeId=null；单集 Σbilling 不变量不受影响
 *  6) img_free：自由生图 → 候选池 → 入库
 *  7) 角色回流：集 cast → extract 入库（含集引用 used_by）
 *  8) 就绪度：缺主题曲/缺配乐/缺角色 → ready=false 且缺项可读
 *  9) 素材包：export → import（元数据合并）
 */
const lib = require('../lib');
const H = require('./_helpers');
const { expect, pollUntil } = lib;

async function fn(ctx) {
  const { token } = await ctx.ensureUser();
  const api = (m, p, b) => ctx.api(m, p, b, token);
  const jget = async (m, p, b) => {
    const r = await api(m, p, b);
    if (r.status >= 400) throw new Error(`${m} ${p} → ${r.status} ${lib.trunc(r.text, 200)}`);
    return r.body || {};
  };

  /* ---- 1) 迁移 ---- */
  const sum0 = await jget('GET', '/api/studio/summary');
  expect.ok(sum0.counts && sum0.counts.music >= 2, `迁移后曲库应含种子 2 曲，实际 ${JSON.stringify(sum0.counts)}`);
  const libList = await jget('GET', '/api/studio/music');
  const wanfeng = libList.list.find((m) => m.title === '晚风');
  const matou = libList.list.find((m) => m.title === '码头暮色');
  expect.ok(wanfeng, '迁移后曲库应含《晚风》');
  expect.ok(matou, '迁移后曲库应含《码头暮色》');
  expect.eq(wanfeng.status, 'approved', '迁移条目 status=approved');
  expect.eq(wanfeng.scope, 'global', '迁移条目 scope=global');
  ctx.note(`迁移：music=${sum0.counts.music} 条（晚风/码头暮色在列）`);

  /* ---- 2) 冷启动闭环 ---- */
  const genResp = await api('POST', '/api/studio/audio/music/generate', { mood: '压抑', count: 1 });
  expect.status(genResp, [200, 201, 202], 'POST /api/studio/audio/music/generate（无 sceneId）');
  const gen = genResp.body || {};
  expect.ok(gen.expected >= 3, `generate 应返回 expected>=3，got ${gen.expected}`);
  const drafts = await pollUntil(async () => {
    const d = await jget('GET', '/api/studio/drafts?domain=music');
    return (d.drafts && d.drafts.music && d.drafts.music.length >= 3) ? d.drafts.music : null;
  }, { timeoutMs: 45000, label: '素材任务 3 候选进候选池' });
  expect.gte(drafts.length, 3, `候选池应 >=3 条，实际 ${drafts.length}`);
  const cand = drafts[0];

  const adoptResp = await api('POST', `/api/studio/drafts/music/${encodeURIComponent(cand.id)}/adopt`, {});
  expect.status(adoptResp, [200, 201], 'draft adopt → 入库');
  const entry = adoptResp.body.entry;
  expect.eq(entry.status, 'approved', '入库后 status=approved');
  expect.ok(entry.art, '入库条目带产物引用 art');
  ctx.note(`冷启动闭环：生成 ${drafts.length} 候选 → adopt ${entry.id}`);

  /* ---- 3) 多挂/解绑 ---- */
  const st0 = await H.getState(ctx);
  const seedScenes = H.scenesOfEpisode(st0, H.SEED_EPISODE_ID);
  expect.gte(seedScenes.length, 2, '种子集应 >=2 场');
  const sc1 = seedScenes[0], sc2 = seedScenes[1];
  await api('POST', `/api/studio/music/${encodeURIComponent(entry.id)}/bind`, { kind: 'scene', id: sc1.id, primary: true });
  const m1 = (await jget('GET', `/api/studio/music_for_scene/${encodeURIComponent(sc1.id)}`)).music;
  expect.ok(m1 && m1.id === entry.id, 'bind 后 music_for_scene(sc1) 命中主曲');
  // 绑第二场（primary 互斥不应影响第一场绑定）
  await api('POST', `/api/studio/music/${encodeURIComponent(entry.id)}/bind`, { kind: 'scene', id: sc2.id, primary: true });
  const m1b = (await jget('GET', `/api/studio/music_for_scene/${encodeURIComponent(sc1.id)}`)).music;
  const m2 = (await jget('GET', `/api/studio/music_for_scene/${encodeURIComponent(sc2.id)}`)).music;
  expect.ok(m1b && m1b.id === entry.id, '第二场绑主曲后第一场绑定仍在（1:N）');
  expect.ok(m2 && m2.id === entry.id, '第二场主曲命中');
  // 解绑第一场 → 第二场不变
  await api('POST', `/api/studio/music/${encodeURIComponent(entry.id)}/unbind`, { kind: 'scene', id: sc1.id });
  const m1c = (await jget('GET', `/api/studio/music_for_scene/${encodeURIComponent(sc1.id)}`)).music;
  const m2b = (await jget('GET', `/api/studio/music_for_scene/${encodeURIComponent(sc2.id)}`)).music;
  expect.eq(m1c, null, '解绑后第一场无曲');
  expect.ok(m2b && m2b.id === entry.id, '解绑第一场不影响第二场');
  ctx.note(`多挂：sc1 绑/解绑不影响 sc2（1:N 语义）`);

  /* ---- 4) 旧接口兼容 ---- */
  const oldLib = (await jget('GET', '/api/music/library')).library;
  const proj = oldLib.find((m) => m.id === entry.id);
  expect.ok(proj, '旧 /api/music/library 含新入库曲');
  expect.eq(proj.sceneId, sc2.id, '旧形状 sceneId = primary 场绑定');
  // 旧 adopt（无 sceneId → 只入库不绑定；带 sceneId → 换主曲）
  const oldAdopt = await api('POST', `/api/music/${encodeURIComponent(entry.id)}/adopt`, { sceneId: sc1.id });
  expect.status(oldAdopt, [200, 201, 202], '旧 adopt 路由兼容（绑定+primary 互斥）');
  const m1d = (await jget('GET', `/api/studio/music_for_scene/${encodeURIComponent(sc1.id)}`)).music;
  expect.ok(m1d && m1d.id === entry.id, '旧 adopt 后第一场主曲命中');
  ctx.note(`兼容：/api/music/* 三路由走素材库语义`);

  /* ---- 5) 账本口径 ---- */
  const bill0 = (await ctx.ledger('billing')).rows || [];
  const epRows0 = bill0.filter((r) => r.episodeId === H.SEED_EPISODE_ID).reduce((a, r) => a + (Number(r.cents) || 0), 0);
  const st1 = await H.getState(ctx);
  const e1cost = (H.asMap(st1.episodes)[H.SEED_EPISODE_ID] || {}).cost_cents;
  const globalRows = bill0.filter((r) => r.episodeId == null && r.kind === 'music');
  expect.gte(globalRows.length, 1, '素材任务应有 episodeId=null 的账本行（公共科目口径）');
  expect.eq(epRows0, e1cost, '素材生成不进单集账本（Σbilling(e1)==cost_cents 仍成立）');

  /* ---- 6) img_free ---- */
  const genImg = await api('POST', '/api/studio/images/generate', { desc: 'V11 验收：冷雨夜码头空镜，集装箱剪影，青橙影调', count: 1 });
  expect.status(genImg, [200, 201, 202], 'POST /api/studio/images/generate');
  const imgDrafts = await pollUntil(async () => {
    const d = await jget('GET', '/api/studio/drafts?domain=images');
    return (d.drafts && d.drafts.images && d.drafts.images.length >= 1) ? d.drafts.images : null;
  }, { timeoutMs: 45000, label: 'img_free 候选进池' });
  expect.gte(imgDrafts.length, 1, 'img_free 候选应 >=1');
  const imgAdopt = await api('POST', `/api/studio/drafts/images/${encodeURIComponent(imgDrafts[0].id)}/adopt`, {});
  expect.status(imgAdopt, [200, 201], '图像候选 adopt 入库');
  const imgList = (await jget('GET', '/api/studio/images')).list;
  expect.ok(imgList.some((x) => x.id === imgAdopt.body.entry.id), '图像入库后可见');
  ctx.note(`img_free：生成→候选池→入库通`);

  /* ---- 7) 角色回流（轻量：建集直传 script——不依赖本机 LLM） ---- */
  const epTitle = `V11回流验收集-${Date.now()}`;
  const inlineScript = {
    title: '灯塔夜雨',
    scenes: [{ name: '场1 灯塔', mood: '压抑', shots: [{ desc: '老兵推门而入，抖落蓑衣雨水；灯塔油灯昏黄', size: '中景', move: '跟拍', light: '夜雨油灯昏黄', sec: 5, cast: ['老陈'], dialogue: '我回来了。', tier: 'high' }] }],
    cast: [{ role: '老陈', name: '老陈', gender: '男', desc: '五十八岁男性，方脸左颊一道旧疤，灰白短发，体格硬朗，穿褪色军绿雨衣' }]
  };
  const epResp = await api('POST', '/api/episodes', { projectId: 'p1', title: epTitle, brief: 'V11 回流验收：灯塔夜雨，老兵与灯塔守护人重逢。', script: inlineScript });
  expect.status(epResp, [200, 201, 202], 'POST /api/episodes（直传 script）');
  const epId = lib.extractId(epResp.body, ['episodeId', 'id'])
    || await pollUntil(async () => {
      const st = await H.getState(ctx);
      const hit = Object.values(H.asMap(st.episodes)).find((e) => e && e.title === epTitle);
      return hit ? hit.id : null;
    }, { timeoutMs: 8000, label: '新集 id' });
  expect.ok(epId, '回流验收集 id 不可得');
  const st2 = await H.getState(ctx);
  const ep = H.asMap(st2.episodes)[epId];
  const roles = ((ep.script || {}).cast || []).map((c) => c.role).filter(Boolean);
  expect.gte(roles.length, 1, '直传 script 后剧本应有 cast');
  // C1 拍板 → 场景/镜头物化（就绪度检查需要场景项）
  await H.acceptCardChain(ctx, epId, 1, 1, { perCardTimeoutMs: 40000 });
  const exResp = await api('POST', '/api/studio/characters/extract', { episodeId: epId, role: roles[0] });
  expect.status(exResp, [200, 201], 'POST /api/studio/characters/extract');
  const char = exResp.body.character;
  expect.eq(char.role, roles[0], '提取角色 role 一致');
  expect.ok((char.used_by || []).some((u) => u.kind === 'episode' && u.id === epId), '提取带集引用 used_by');
  const chars = (await jget('GET', '/api/studio/characters')).list;
  expect.ok(chars.some((c) => c.id === char.id), '角色库可见');
  // 重提取 → existed=true（幂等）
  const exResp2 = await api('POST', '/api/studio/characters/extract', { episodeId: epId, role: roles[0] });
  expect.ok(exResp2.body.existed === true, '重复提取幂等（existed）');
  ctx.note(`角色回流：${roles[0]} → 角色库（used_by 带集）`);

  /* ---- 8) 就绪度 ---- */
  const ready = await jget('GET', `/api/studio/readiness/${encodeURIComponent(epId)}`);
  expect.eq(ready.ready, false, '素材未铺满时 readiness.ready=false');
  expect.eq(ready.theme, false, '未入库主题曲 → theme=false');
  const sceneItems = (ready.items || []).filter((i) => i.kind === 'scene');
  expect.gte(sceneItems.length, 1, 'readiness 应列出本集场景项');
  const charItem = (ready.items || []).find((i) => i.kind === 'character' && i.name === roles[0]);
  expect.ok(charItem && charItem.hasCharacter === true, 'readiness 角色项 hasCharacter=true');
  ctx.note(`就绪度：ready=false（theme 缺），场景/角色项齐全`);

  /* ---- 9) 素材包 ---- */
  const packResp = await api('POST', '/api/studio/packs/export', {});
  expect.status(packResp, 200, 'POST /api/studio/packs/export');
  const pack = packResp.body.pack;
  expect.eq(pack.format, 'theater-asset-pack', '素材包格式标记');
  const impResp = await api('POST', '/api/studio/packs/import', { pack });
  expect.status(impResp, 200, 'POST /api/studio/packs/import');
  expect.ok(impResp.body.added >= 0, '导入返回 added 计数');
  ctx.note(`素材包：export→import（added=${(impResp.body || {}).added}）`);

  /* ---- 10) 设定域 / 音色 / MV / 公共科目（C1/C3/C7/C8） ---- */
  // 设定域：lore + 判废表 + 风格包
  await api('POST', '/api/studio/canon/lore', { title: '世界观', content: '故事发生在南方海滨小城，渔港码头建于 1946 年。' });
  await api('POST', '/api/studio/canon/reject_rules', { title: '面部判废', content: '五官漂移、多人拼贴、口型错位一律判废。' });
  await api('POST', '/api/studio/canon/style_pkgs', { look: 'V11测试包', t2i_suffix: '实拍质感，冷色调', music_tags: 'piano, 70 bpm' });
  const loreList = await jget('GET', '/api/studio/canon/lore');
  expect.ok(loreList.list.some((l) => l.title === '世界观'), 'lore 已入库');
  const rulesList = await jget('GET', '/api/studio/canon/reject_rules');
  expect.ok(rulesList.list.some((r) => r.title === '面部判废'), '判废表已入库');
  const pkgList = await jget('GET', '/api/studio/canon/style_pkgs');
  expect.ok(pkgList.list.some((p) => p.look === 'V11测试包'), '自定义风格包已入库');
  ctx.note('设定域：lore/判废表/风格包入库');

  // 音色域：建音色 + 集级 voice_map
  const voi = (await api('POST', '/api/studio/voices', { name: '旁白男声', gender: '男', spk: '中文男' })).body.voice;
  expect.ok(voi && voi.id, '音色条目已建');
  const vmResp = await api('POST', `/api/studio/voice_map/${encodeURIComponent(epId)}`, { voice_map: { '老陈': voi.id } });
  expect.status(vmResp, 200, 'POST /api/studio/voice_map/:episodeId');
  expect.eq(vmResp.body.voice_map && vmResp.body.voice_map['老陈'], voi.id, 'voice_map 写入生效');
  ctx.note('音色域：音色库＋集级 voice_map');

  // MV：选曲＋选图 → manifest（ffmpeg 缺席＝skipped，也是合法结果）
  const mvResp = await api('POST', '/api/studio/mv/build', {
    musicId: entry.id, imageIds: [imgAdopt.body.entry.id], title: 'V11 宣发 MV'
  });
  expect.status(mvResp, 200, 'POST /api/studio/mv/build');
  expect.ok(mvResp.body.manifest && mvResp.body.manifest.kind === 'mv-pack', 'MV manifest 生成');
  expect.ok(mvResp.body.ok === true || typeof mvResp.body.skipped === 'string', 'MV 出片或如实 skipped（无伪造）');
  ctx.note(`MV：${mvResp.body.ok ? '出片 ' + mvResp.body.manifest.art : 'skipped（' + mvResp.body.skipped + '）'}`);

  // 公共科目（ops 口径）：素材任务 billing 行 episodeId=null 应可见
  const pubResp = await api('GET', '/api/studio/public_ledger', null);
  expect.status(pubResp, 200, 'GET /api/studio/public_ledger（ops）');
  expect.gte(pubResp.body.rows, 1, '公共科目应有素材任务账本行');
  expect.gte(pubResp.body.counts.global_music, 2, '公共库曲计数含种子曲');
  ctx.note(`公共科目：rows=${pubResp.body.rows} total=${pubResp.body.total}`);

  ctx.note('V11 素材中心全链通过');
}

module.exports = { name: 'V11_studio_library', fn, timeoutMs: 180000 };
