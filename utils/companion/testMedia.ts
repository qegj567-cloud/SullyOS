import { companionRecordingMime, recordCompanionClip } from './capture';

function testCanvas() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('此浏览器无法生成测试图形');
  const paint = (second: boolean) => {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = second ? '#0055ee' : '#ee2222';
    if (second) ctx.fillRect(64, 64, 128, 128);
    else { ctx.beginPath(); ctx.arc(128, 128, 64, 0, Math.PI * 2); ctx.fill(); }
  };
  paint(false); return { canvas, paint };
}

export function companionTestImage() { return testCanvas().canvas.toDataURL('image/png'); }

/** Generated shapes only: never request camera permission or inspect the user's screen. */
export async function companionTestVideo(signal: AbortSignal) {
  signal.throwIfAborted();
  const mime = companionRecordingMime(), { canvas, paint } = testCanvas();
  if (!canvas.captureStream) throw new Error('此浏览器无法生成测试视频，请换用新版 Chrome、Edge 或 Safari');
  const stream = canvas.captureStream(10), start = performance.now();
  const timer = setInterval(() => paint(performance.now() - start >= 800), 100);
  try { return await recordCompanionClip(stream, mime, signal, 2000); }
  finally { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); }
}
