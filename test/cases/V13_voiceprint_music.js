'use strict';
/**
 * V13 声纹克隆（2026-11-22）：素材中心音乐线 voiceId 通道
 *  1) 声纹登记：样本上传（domain=voices 只落盘不建条目）→ POST /studio/voices kind=clone 绑定 ref
 *     - 未勾授权 → 400（合规底线）
 *     - ref 不在 voices 归档 / 文件缺失 → 400
 *  2) 克隆出歌（stub 面）：/studio/audio/music/generate 带 voiceId → 候选带 voiceId 标记 → adopt 入库带溯源
 *     - 克隆无歌词 → 400（克隆音色必须演唱自定义歌词）
 *     - voiceId 不存在/非克隆 → 400
 *  3) 声纹删除：DELETE /studio/voices/:id → 列表移除；已入库歌曲不受影响
 */
const lib = require('../lib');
const { expect, pollUntil } = lib;

async function fn(ctx) {
  const { token } = await ctx.ensureUser();
  const api = (m, p, b) => ctx.api(m, p, b, token);
  const jget = async (m, p, b) => {
    const r = await api(m, p, b);
    if (r.status >= 400) throw new Error(`${m} ${p} → ${r.status} ${lib.trunc(r.text, 200)}`);
    return r.body || {};
  };
  // 原始字节上传助手（服务端 raw:true 面；测试 api 助手只发 JSON，这里直连 fetch）
  const rawPost = async (p, buf) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
      body: buf,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, body, text };
  };

  /* ---- 1) 声纹样本上传 + 登记 ---- */
  // 最小合法 WAV（RIFF/WAVE 魔数即可过服务端校验；stub 面不实际解码）
  const wavBytes = Buffer.concat([
    Buffer.from('RIFF\x24\x08\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x80\x3e\x00\x00\x00\x77\x01\x00\x02\x00\x10\x00data\x00\x08\x00\x00', 'latin1'),
    Buffer.alloc(2048, 0),
  ]);

  const up = await rawPost('/api/studio/upload?domain=voices&title=%E5%A3%B0%E7%BA%B9%E6%A0%B7%E6%9C%ACA', wavBytes);
  expect.status(up, [200, 201], 'POST /api/studio/upload?domain=voices');
  expect.ok(up.body && up.body.art, 'voices 域上传返回 art 路径（只落盘不建条目）');
  expect.ok(String(up.body.art || '').indexOf('var/assets/library/voices/') === 0, '样本落在 voices 归档目录');

  const noConsent = await api('POST', '/api/studio/voices', { kind: 'clone', name: '阿岚', ref: up.body.art });
  expect.status(noConsent, [400], '未勾授权登记克隆声纹应 400（合规底线）');

  const badRef = await api('POST', '/api/studio/voices', { kind: 'clone', name: '阿岚', consent: true, ref: 'var/assets/library/voices/不存在.wav' });
  expect.status(badRef, [400], 'ref 指向不存在文件应 400');

  const mk = await api('POST', '/api/studio/voices', {
    kind: 'clone', name: '阿岚', gender: '女',
    desc: 'young female vocals, breathy', prompt_text: '希望你以后能够做的比我还好呦。',
    consent: true, ref: up.body.art,
  });
  expect.status(mk, [200, 201], '克隆声纹登记');
  const voice = mk.body.voice;
  expect.ok(voice && voice.id && voice.kind === 'clone' && voice.ref === up.body.art, '登记条目 kind=clone 且 ref 绑定');
  ctx.note(`声纹登记：${voice.id}（ref=${up.body.file}）`);

  /* ---- 2) 克隆出歌（stub 面：无 THEATER_MUSIC_URL，候选照常 3 段并带 voiceId 标记） ---- */
  const genNoLyrics = await api('POST', '/api/studio/audio/music/generate', { mood: '释然', voiceId: voice.id, count: 1 });
  expect.status(genNoLyrics, [400], '克隆无歌词应 400');

  const genBadVoice = await api('POST', '/api/studio/audio/music/generate', { mood: '释然', voiceId: 'voi_missing', lyrics: '[Verse] a', count: 1 });
  expect.status(genBadVoice, [400], 'voiceId 不存在应 400');

  const gen = await api('POST', '/api/studio/audio/music/generate', {
    mood: '释然', type: 'theme', voiceId: voice.id, count: 1,
    lyrics: '[Verse]\n晚风把码头吹旧\n[Chorus]\n汽笛替我说了再见',
  });
  expect.status(gen, [200, 201, 202], '克隆生成入队');
  expect.ok(gen.body.jobs && gen.body.jobs.length === 1, '一次 1 job');

  const cands = await pollUntil(async () => {
    const d = await jget('GET', '/api/studio/drafts?domain=music');
    const arr = (d.drafts && d.drafts.music) || [];
    const hit = arr.filter((c) => c.voiceId === voice.id);
    return hit.length ? hit : null;
  }, { timeoutMs: 40000, intervalMs: 2000, label: '克隆候选回流' });
  const c0 = cands[0];
  expect.ok(c0.gen && c0.gen.voiceId === voice.id && c0.gen.cloneMode === 'full', 'gen 快照含 voiceId/cloneMode');
  expect.eq(c0.engine, 'ACE-Step 1.5', 'stub 面引擎标注不变');

  const adopt = await api('POST', `/api/studio/drafts/music/${encodeURIComponent(c0.id)}/adopt`, {});
  expect.status(adopt, [200, 201], '克隆候选入库');
  const libList = await jget('GET', '/api/studio/music');
  const adopted = (libList.list || []).find((m) => m.id === c0.id);
  expect.ok(adopted, '入库后曲库可见');
  expect.eq(adopted.voiceId, voice.id, '曲库条目保留声纹溯源');

  /* ---- 3) 删除声纹（文件保留、条目移除、已入库歌曲不受影响） ---- */
  const del = await api('DELETE', `/api/studio/voices/${encodeURIComponent(voice.id)}`);
  expect.status(del, [200], '删除声纹');
  const vs = await jget('GET', '/api/studio/voices');
  expect.ok(!(vs.list || []).some((v) => v.id === voice.id), '列表已移除');
  const libAfter = await jget('GET', '/api/studio/music');
  expect.ok((libAfter.list || []).some((m) => m.id === c0.id), '已入库歌曲不受删除影响');
}

module.exports = { name: 'V13_voiceprint_music', fn };
