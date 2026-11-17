import React from 'react';
import { createRoot } from 'react-dom/client';
import { CompanionSurface } from '../../apps/CompanionApp';
import type { observeCompanionVideo } from '../../utils/companion/vision';

// Explicit fixture: generated moving frames + real MediaRecorder, simulated analysis, no camera/API/storage.
let brokenEncoders = 0, failedRequests = 0, analyzed = 0;
const NativeRecorder = window.MediaRecorder;
window.MediaRecorder = class extends NativeRecorder {
  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    if (brokenEncoders > 0) { brokenEncoders--; throw new Error('模拟编码器不可用'); }
    super(stream, options);
    this.addEventListener('start', () => { document.querySelector('#codec-proof')!.textContent = '录制格式：' + this.mimeType; });
  }
};
navigator.mediaDevices.getUserMedia = async () => {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d')!, origin = performance.now(); let frame = 0;
  const paint = () => {
    ctx.fillStyle = '#d6e8db'; ctx.fillRect(0, 0, 640, 360);
    ctx.strokeStyle = '#286d55'; ctx.lineWidth = 8; ctx.strokeRect(5, 5, 630, 350);
    ctx.fillStyle = '#172b25'; ctx.font = '20px sans-serif';
    ctx.fillText('左上', 18, 32); ctx.fillText('右上', 575, 32); ctx.fillText('左下', 18, 338); ctx.fillText('右下', 575, 338);
    ctx.font = '26px sans-serif'; ctx.fillText('实时画面 · ' + ((performance.now() - origin) / 1000).toFixed(1) + ' 秒', 150, 90);
    ctx.fillStyle = '#d58042'; ctx.beginPath(); ctx.arc(70 + (frame++ * 4) % 500, 200, 35, 0, Math.PI * 2); ctx.fill();
  };
  paint(); const stream = canvas.captureStream(12);
  const timer = setInterval(() => { if (stream.getVideoTracks()[0].readyState === 'ended') clearInterval(timer); else paint(); }, 80);
  return stream;
};
const observer: typeof observeCompanionVideo = async (clip, _api, _id, _name, signal) => {
  const video = document.createElement('video'), url = URL.createObjectURL(clip.blob);
  video.muted = true; video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('样片解码超时')), 5000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('MP4 无法解码')); };
    });
    document.querySelector('#clip-proof')!.textContent = `已验证完整 MP4：${video.videoWidth} × ${video.videoHeight}，${clip.blob.size} 字节；分析次数 ${++analyzed}`;
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, 10_000);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
  signal.throwIfAborted();
  if (failedRequests > 0) { failedRequests--; throw new Error('模拟视频 API 失败'); }
  return { text: '模拟分析：橙色圆形从左向右移动。', from: clip.from, to: clip.to };
};
createRoot(document.getElementById('root')!).render(<>
  <div className="fixture-controls">合成镜头 · 真实 MP4 录制 · 模拟分析（不调用 API）<br/>
    <button onClick={() => { brokenEncoders = 2; }}>模拟录制失败</button>
    <button onClick={() => { failedRequests = 2; }}>模拟 API 连续失败</button>
    <span id="clip-proof">等待开始录制</span>
    <span id="codec-proof"/>
  </div>
  <CompanionSurface characters={[{ id: 'fixture', name: '林间', systemPrompt: '温柔、自然', contextLimit: 50 } as any]}
    user={{ name: '小雨' } as any} api={{ companionVideoApi: { baseUrl: 'https://unused.invalid', model: 'fixture', apiKey: '' } } as any}
    close={() => { document.title = '同行已关闭'; }} videoObserver={observer}
    requestFactory={() => ({ quick: async () => '先把镜头对准袖口，我在听你说。', prepare: async (_, a) => a as any, full: async () => '这是固定示例回复。实时预览应该始终显示在上方。' })}/>
</>);
