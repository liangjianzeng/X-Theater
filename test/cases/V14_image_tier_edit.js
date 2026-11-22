'use strict';
/**
 * V14 图像画幅×清晰度＋上传编辑（2026-11-22）：素材中心 img_free 的 ratio/tier/usage 通道（stub 面）
 *  1) 画幅×清晰度白名单：ratio 6 档 + tier 3 档；非法值回落缺省（9:16/standard）
 *  2) 编辑改图校验：usage=edit 缺参考图或缺指令 → 400；齐备 → 入队 payload 透传
 *  3) 尺寸自适应（stub 面 meta 断言）：imgSpecFor 映射与超档回落（uhd 在本机线回落 → meta.size_downgraded）
 *  4) 上传→参考图关联：upload?domain=images → refImage 路径生成（stub 面候选带 gen.usage）
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

  /* ---- 1) 画幅×清晰度：合法档与非法回落 ---- */
  const gen1 = await api('POST', '/api/studio/images/generate', { desc: '雨夜码头冷蓝霓虹', ratio: '3:4', tier: 'hd', count: 1 });
  expect.status(gen1, [200, 201, 202], 'img_free 3:4 + hd 入队');
  const gen2 = await api('POST', '/api/studio/images/generate', { desc: '竹帘特写', ratio: '7:2', tier: 'xxx', count: 1 });
  expect.status(gen2, [200, 201, 202], '非法 ratio/tier 不炸（回落缺省）');
  const g2 = gen2.body.jobs[0];
  expect.eq(g2.payload.ratio, '9:16', '非法 ratio 回落 9:16');
  expect.eq(g2.payload.tier, 'standard', '非法 tier 回落 standard');

  /* ---- 2) 编辑改图校验 ---- */
  const editNoRef = await api('POST', '/api/studio/images/generate', { desc: '改图', usage: 'edit', editInstruction: '把背景换成雨夜码头', count: 1 });
  expect.status(editNoRef, [400], 'usage=edit 缺参考图应 400');
  const editNoIns = await api('POST', '/api/studio/images/generate', { desc: '改图', usage: 'edit', refImage: 'var/assets/library/images/none.png', count: 1 });
  expect.status(editNoIns, [400], 'usage=edit 缺编辑指令应 400');

  /* ---- 3) 尺寸自适应（stub 面）：uhd 在本机线回落 → meta.size_downgraded=true ---- */
  // stub 面 meta：image-stub 不带尺寸——尺寸断言走 payload 透传（真引擎在 worker 内算），
  // 因此这里断言 payload.ratio/tier/usage 通道 + generate 返回 202；meta 尺寸断言放真机冒烟。
  const gen3 = await api('POST', '/api/studio/images/generate', { desc: '竖版海报底图', ratio: '9:16', tier: 'uhd', count: 1 });
  expect.status(gen3, [200, 201, 202], 'uhd 档入队（本机线 worker 内回落）');
  expect.eq(gen3.body.jobs[0].payload.tier, 'uhd', 'uhd 透传');
  const gen4 = await api('POST', '/api/studio/images/generate', { desc: '码头横幅', ratio: '21:9', count: 1 });
  expect.eq(gen4.body.jobs[0].payload.ratio, '21:9', '21:9 宽幅透传');

  /* ---- 4) 上传→参考图关联 + 编辑齐备入队 ---- */
  // 合法 1×1 PNG（带 tEXt 块垫高——上传面要求 ≥100 字节原始体）
  function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    try { crc.writeUInt32BE(require('zlib').crc32(body) >>> 0, 0); } catch (e) { crc.writeUInt32BE(0, 0); }
    return Buffer.concat([len, body, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; // 1×1 RGB
  const idat = require('zlib').deflateSync(Buffer.concat([Buffer.from([0]), Buffer.from([255, 255, 255])]));
  const ttxt = Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.from('theater studio test reference image '.repeat(3), 'latin1')]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('tEXt', ttxt), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))
  ]);
  const up = await rawPost('/api/studio/upload?domain=images&title=%E5%8F%82%E8%80%83%E5%9B%BE', png);
  expect.status(up, [200, 201], 'images 域上传');
  expect.ok(up.body.entry && up.body.entry.art, '上传入库带 art 路径');
  const refArt = up.body.entry.art;
  const editOk = await api('POST', '/api/studio/images/generate', { desc: '把背景换成雨夜码头，人物不动', usage: 'edit', refImage: refArt, editInstruction: '把背景换成雨夜码头，人物不动', count: 1 });
  expect.status(editOk, [200, 201, 202], '编辑改图齐备入队');
  const jp = editOk.body.jobs[0].payload;
  expect.eq(jp.usage, 'edit', 'usage=edit 透传');
  expect.eq(jp.refImage, refArt, '参考图路径透传');
  expect.ok(jp.editInstruction && jp.editInstruction.length > 0, '编辑指令透传');

  /* ---- 候选池回流（stub 面 1 候选/任务）---- */
  const found = await pollUntil(async () => {
    const d = await jget('GET', '/api/studio/drafts?domain=images');
    const arr = (d.drafts && d.drafts.images) || [];
    const editCand = arr.find((c) => c.gen && c.gen.usage === 'edit');
    const uhdCand = arr.find((c) => c.gen && c.gen.tier === 'uhd');
    return (editCand && uhdCand) ? { editCand, uhdCand } : null;
  }, { timeoutMs: 45000, intervalMs: 2000, label: '图像候选回流（edit+uhd）' });
  expect.ok(found.editCand, '候选池带 gen.usage=edit 溯源');
  expect.ok(found.uhdCand, '候选 gen 快照带清晰度档（uhd）');
  expect.eq(found.editCand.gen.tier, 'standard', '未指定 tier 的编辑候选回落 standard');
}

module.exports = { name: 'V14_image_tier_edit', fn };
