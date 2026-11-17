export interface CompanionClip { blob: Blob; from: number; to: number }
export interface CompanionFrame { image: string; at: number }
export const CLIP_MS = 8000;
export const MAX_CLIP_BYTES = 8 * 1024 * 1024;

export class CompanionRecordingError extends Error {
  constructor(readonly kind: 'empty' | 'size' | 'encoder' | 'stopped', message: string) { super(message); }
}

function recordingMimes(): string[] {
  // Let the browser choose its working MP4 codec before forcing a specific H.264 profile.
  return typeof MediaRecorder === 'undefined' ? [] : ['video/mp4', 'video/mp4;codecs=avc1.42E01E']
    .filter(value => MediaRecorder.isTypeSupported(value));
}

/** Only negotiate formats supported by the video API. Never disguise stills as video. */
export function companionRecordingMime(): string {
  const mime = recordingMimes()[0];
  if (!mime) throw new Error('此浏览器不能录制 MP4 视频片段，请使用支持 MP4 录制的新版 Chrome、Edge 或 Safari。');
  return mime;
}

/** Retry only local encoder failures with another supported MP4 mode; never retry an API here. */
export function createCompanionClipRecorder(stream: MediaStream, signal: AbortSignal) {
  const mimes = recordingMimes();
  if (!mimes.length) companionRecordingMime();
  let selected = 0;
  return async () => {
    while (true) {
      try { return await recordCompanionClip(stream, mimes[selected], signal); }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof CompanionRecordingError) || !['empty', 'encoder'].includes(error.kind) || selected + 1 >= mimes.length) throw error;
        selected++;
      }
    }
  };
}

/** Restart each recorder: timeslice chunks alone are not standalone videos. */
export function recordCompanionClip(stream: MediaStream, mime: string, signal: AbortSignal, durationMs = CLIP_MS): Promise<CompanionClip> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 700_000 }); }
    catch { reject(new CompanionRecordingError('encoder', '浏览器未能启动 MP4 编码器')); return; }
    const parts: Blob[] = [];
    const from = Date.now();
    let timer: ReturnType<typeof setTimeout>, finishTimer: ReturnType<typeof setTimeout>, settled = false, bytes = 0, to: number | undefined;
    const cleanup = () => { clearTimeout(timer); clearTimeout(finishTimer); signal.removeEventListener('abort', cancel); recorder.onstop = recorder.ondataavailable = recorder.onerror = null; };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup();
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* Still release callbacks and reject. */ }
      parts.length = 0;
      reject(error);
    };
    const cancel = () => fail(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    recorder.ondataavailable = event => {
      if (settled || !event.data.size) return;
      bytes += event.data.size;
      if (bytes > MAX_CLIP_BYTES) { fail(new CompanionRecordingError('size', `录制片段超过 8 MB（已收到 ${(bytes / 1024 / 1024).toFixed(1)} MB），本段未发送`)); return; }
      parts.push(event.data);
    };
    recorder.onerror = () => fail(new CompanionRecordingError('encoder', '浏览器 MP4 编码失败，本段未发送'));
    recorder.onstop = () => {
      if (settled) return;
      settled = true; cleanup();
      const blob = new Blob(parts, { type: 'video/mp4' });
      parts.length = 0;
      if (!blob.size) { reject(new CompanionRecordingError('empty', '浏览器录制结果为 0 字节，本段未发送；可重试视频理解或换摄像头后重开')); return; }
      resolve({ blob, from, to: to ?? Date.now() });
    };
    try {
      // Collect bounded pieces, then join every piece (including the final one) into ONE complete MP4.
      recorder.start(1000);
      timer = setTimeout(() => {
        to = Date.now();
        finishTimer = setTimeout(() => fail(new CompanionRecordingError('encoder', '浏览器未能完成 MP4 封装，本段未发送')), 5000);
        try { if (recorder.state !== 'inactive') recorder.stop(); }
        catch { fail(new CompanionRecordingError('encoder', '浏览器未能结束视频录制，本段未发送')); }
      }, durationMs);
    } catch { fail(new CompanionRecordingError('encoder', '浏览器未能开始视频录制，本段未发送')); }
  });
}

/** Capture continuously; while one request runs, retain only the latest complete pending clip. */
export function startCompanionVideoLoop(options: {
  signal: AbortSignal;
  record: () => Promise<CompanionClip>;
  observe: (clip: CompanionClip) => Promise<void>;
  error: (error: unknown, fatal: boolean) => void;
}) {
  const { signal } = options;
  let pending: CompanionClip | undefined, busy = false, stopped = false, failures = 0;
  const stop = () => { stopped = true; pending = undefined; };
  signal.addEventListener('abort', stop, { once: true });
  const drain = async () => {
    if (busy || stopped || signal.aborted) return;
    busy = true;
    try {
      while (pending && !stopped && !signal.aborted) {
        const clip = pending; pending = undefined;
        try { await options.observe(clip); failures = 0; }
        catch (error) {
          if (stopped || signal.aborted) break;
          const fatal = ++failures >= 2;
          if (fatal) stop();
          options.error(error, fatal);
        }
      }
    } finally { busy = false; }
  };
  void (async () => {
    try {
      while (!stopped && !signal.aborted) {
        const clip = await options.record();
        if (stopped || signal.aborted) break;
        pending = clip;
        void drain();
      }
    } catch (error) { if (!stopped && !signal.aborted) { stop(); options.error(error, true); } }
    finally { signal.removeEventListener('abort', stop); }
  })();
}

export function blobDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const clean = () => signal.removeEventListener('abort', cancel);
    const cancel = () => { clean(); reader.abort(); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
    reader.onload = () => { clean(); resolve(String(reader.result)); };
    reader.onerror = () => { clean(); reject(new Error('视频片段读取失败')); };
    reader.readAsDataURL(blob);
  });
}

/** Seek the analyzed clip, so optional stills cannot accidentally come from a newer scene. */
export async function extractCompanionFrames(clip: CompanionClip, seconds: number[], signal: AbortSignal): Promise<CompanionFrame[]> {
  signal.throwIfAborted();
  const video = document.createElement('video'), url = URL.createObjectURL(clip.blob);
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  const waitFor = (event: 'loadeddata' | 'seeked', action: () => void) => new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener('error', fail); signal.removeEventListener('abort', cancel); };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('无法从视频中提取补充截图')); };
    const cancel = () => { cleanup(); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(fail, 8000);
    video.addEventListener(event, done, { once: true }); video.addEventListener('error', fail, { once: true }); signal.addEventListener('abort', cancel, { once: true });
    try { signal.throwIfAborted(); action(); } catch (error) { cleanup(); reject(error); }
  });
  try {
    await waitFor('loadeddata', () => { video.src = url; video.load(); });
    const duration = Number.isFinite(video.duration) ? video.duration : (clip.to - clip.from) / 1000;
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    if (!ctx || !video.videoWidth) throw new Error('无法读取视频截图');
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    const frames: CompanionFrame[] = [];
    for (const second of seconds.slice(0, 3)) {
      signal.throwIfAborted();
      const target = Math.max(0, Math.min(second, duration - 0.1));
      if (Math.abs(video.currentTime - target) > 0.01) await waitFor('seeked', () => { video.currentTime = target; });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ image: canvas.toDataURL('image/jpeg', 0.7), at: clip.from + target * 1000 });
    }
    return frames;
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}
