/* 剧场 Studio · 页面录音（2026-11-22 声纹登记：页面内按需录音为主入口，文件上传为辅助）
 * 链路：MediaRecorder(webm/opus) → decodeAudioData → OfflineAudioContext 重采样 16kHz 单声道
 * → PCM16 WAV 编码 → File(audio/wav)——产物直接复用既有上传链路（服务端 WAV 魔数校验零改动）。
 * 16k 单声道 WAV 同时是 CosyVoice zero-shot prompt 的原生规格（声纹样本双线复用预留）。
 */
(function (global) {
  "use strict";

  const R = (global.__REC = global.__REC || {});

  /* PCM16 WAV 封装（RIFF 标准头；mono 16-bit） */
  function encodeWav(pcm16, sampleRate) {
    const n = pcm16.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const wstr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); wstr(8, "WAVE");
    wstr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wstr(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, pcm16[i], true);
    return new Blob([buf], { type: "audio/wav" });
  }

  /* 任意浏览器录音 Blob → 16k 单声道 PCM16 WAV Blob（decode 失败抛错，调用方走上传辅助入口） */
  R.blobToWav = async function (blob, targetRate) {
    const sr = Number(targetRate) || 16000;
    const ac = new (global.AudioContext || global.webkitAudioContext)();
    let audio;
    try {
      audio = await ac.decodeAudioData(await blob.arrayBuffer());
    } finally {
      try { ac.close(); } catch (e) { /* 忽略 */ }
    }
    const frames = Math.max(1, Math.ceil(audio.duration * sr));
    const off = new (global.OfflineAudioContext || global.webkitOfflineAudioContext)(1, frames, sr);
    const src = off.createBufferSource();
    src.buffer = audio;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const ch = rendered.getChannelData(0);
    const pcm = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return encodeWav(pcm, sr);
  };

  /* 录音 Blob → 可上传 File（复用 studioCreateVoice 的 file.arrayBuffer() 链路） */
  R.blobToWavFile = async function (blob, name) {
    const wav = await R.blobToWav(blob);
    return new File([wav], String(name || "recording") + ".wav", { type: "audio/wav" });
  };

  /* 麦克风能力探测（无 API / 非安全上下文 → false，UI 据此隐藏录音入口） */
  R.supported = function () {
    return !!(global.navigator && global.navigator.mediaDevices && global.navigator.mediaDevices.getUserMedia
      && typeof global.MediaRecorder === "function");
  };
})(window);
