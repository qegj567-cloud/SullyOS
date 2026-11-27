import React from 'react';
import { createRoot } from 'react-dom/client';
import { CompanionSurface } from '../../apps/CompanionApp';
import type { observeCompanionVideo } from '../../utils/companion/vision';
import { createBuiltinSullyLive2DConfig } from '../../utils/builtinSullyLive2D';
import roomUrl from '../../assets/sar-club-room.png';
import chibi from '../../assets/sar/aiven-chibi.png';

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
const busyCamera = new URLSearchParams(location.search).get('case') === 'busy';
const scenePreview = new URLSearchParams(location.search).get('view') === 'scene';
if (busyCamera) {
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'fixture-vts', groupId: '', label: 'VTubeStudioCam', toJSON() { return {}; } },
  ];
}
navigator.mediaDevices.getUserMedia = async constraints => {
  if (busyCamera && !(typeof constraints?.video === 'object' && typeof constraints.video.deviceId === 'object'
    && 'exact' in constraints.video.deviceId && constraints.video.deviceId.exact === 'fixture-vts')) {
    throw new DOMException('Device in use', 'NotReadableError');
  }
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const room = scenePreview ? new Image() : undefined;
  if (room) {
    room.src = roomUrl;
    await room.decode();
    canvas.width = 480; canvas.height = 720;
  }
  const ctx = canvas.getContext('2d')!, origin = performance.now(); let frame = 0;
  const paint = () => {
    if (room) {
      const scale = Math.max(canvas.width / room.naturalWidth, canvas.height / room.naturalHeight);
      const width = room.naturalWidth * scale, height = room.naturalHeight * scale;
      const pan = 0.5 + 0.18 * Math.sin((performance.now() - origin) / 6000);
      ctx.drawImage(room, (canvas.width - width) * pan, (canvas.height - height) / 2, width, height);
      return;
    }
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
  return { text: scenePreview ? '模拟分析：镜头扫过活动室里的沙发。' : '模拟分析：橙色圆形从左向右移动。', from: clip.from, to: clip.to };
};
createRoot(document.getElementById('root')!).render(<>
  <div className="fixture-controls" hidden={scenePreview}>合成镜头 · 真实 MP4 录制 · 模拟分析（不调用 API）<br/>
    {busyCamera && <span>点自己的镜头，体验从占用提示切换到模拟 VTubeStudioCam。</span>}
    <button onClick={() => { brokenEncoders = 2; }}>模拟录制失败</button>
    <button onClick={() => { failedRequests = 2; }}>模拟 API 连续失败</button>
    <span id="clip-proof">等待开始录制</span>
    <span id="codec-proof"/>
  </div>
  <CompanionSurface introKey="sully_companion_fixture_intro_v1" characters={[{ id: 'fixture', name: '林间', avatar: '/sar-portraits/Aiven/normal.webp',
    companionAvatar: { source: 'date' }, sprites: { normal: '/sar-portraits/Aiven/normal.webp', happy: '/sar-portraits/Aiven/happy.webp', chibi },
    videoAvatar: createBuiltinSullyLive2DConfig(), systemPrompt: '温柔、自然', contextLimit: 50 } as any]}
    user={{ name: '小雨' } as any} api={{ baseUrl: 'https://unused.invalid', model: 'fixture', apiKey: 'fixture',
      companionVideoApi: { baseUrl: 'https://unused.invalid', model: 'fixture', apiKey: '' } } as any}
    close={() => { document.title = '同行已关闭'; }} videoObserver={observer}
    requestFactory={context => ({ quick: async () => '先把镜头对准袖口，我在听你说。', prepare: async (_, a) => a as any,
      full: async () => (context.replyFormat?.().includes('[[AVATAR') ? '[[AVATAR: emotion=happy; model_action=expression-4]]\n' : '') + '这是固定示例回复。' })}/>
</>);
