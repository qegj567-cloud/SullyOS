/** Streaming audio primitives shared by chat, calls and reading. */
export interface VoiceCue { text: string; start: number; end: number; voiceId?: string }
export const VOICE_SAMPLE_RATE = 24000;

export function throwIfVoiceAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('语音已停止', 'AbortError');
}

/** ElevenLabs HTTP streaming uses newline-delimited JSON, not SSE. */
export async function readVoiceJsonStream(
  response: Response,
  onFrame: (frame: any) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfVoiceAborted(signal);
  if (!response.ok) throw new Error(`ElevenLabs (${response.status}): ${(await response.text()).slice(0, 300)}`);
  if (!response.body) throw new Error('当前环境没有返回音频流');
  if (response.headers.get('content-type')?.startsWith('audio/')) {
    await response.body.cancel().catch(() => {});
    throw new Error('语音代理未返回时间戳数据，请更新 ElevenLabs 代理后重试');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const deliver = async (line: string) => {
    if (!line.trim()) return;
    let frame: any;
    try { frame = JSON.parse(line); } catch { throw new Error('ElevenLabs 响应不是有效的时间戳 JSON，请检查语音代理'); }
    if (frame.error || frame.detail) {
      const error = frame.error || frame.detail;
      throw new Error(typeof error === 'string' ? error : error.message || JSON.stringify(error));
    }
    throwIfVoiceAborted(signal);
    await onFrame(frame);
  };
  try {
    while (true) {
      throwIfVoiceAborted(signal);
      const { value, done } = await reader.read();
      throwIfVoiceAborted(signal);
      pending += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        await deliver(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (done) { await deliver(pending); break; }
      if (pending.length > 16 * 1024 * 1024) throw new Error('音频流数据格式异常');
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Lossless splitting: directions and IPA are indivisible, Unicode counted as code points. */
export function splitSpeechText(text: string, limit = 1800): string[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('无效的语音分段长度');
  const tokens = text.match(/\[[^\]]*\]|\/[^/\n]+\/|[^]/gu) || [];
  const parts: string[] = [];
  let chunk: string[] = [];
  let length = 0;
  let boundary = 0;
  for (const token of tokens) {
    const size = Array.from(token).length;
    if (size > limit) throw new Error('单个语音标签或发音指令过长，请缩短后再朗读');
    if (length + size > limit) {
      const cut = boundary || chunk.length;
      parts.push(chunk.slice(0, cut).join(''));
      chunk = chunk.slice(cut);
      length = Array.from(chunk.join('')).length;
      boundary = 0;
      if (length + size > limit) {
        parts.push(chunk.join('')); chunk = []; length = 0;
      }
    }
    chunk.push(token); length += size;
    if (/^[。！？!?；;\n\s]$/u.test(token) || token === '.') boundary = chunk.length;
  }
  if (chunk.length) parts.push(chunk.join(''));
  return parts;
}

export function decodeVoiceBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

export function pcmToWav(chunks: Uint8Array[], sampleRate = VOICE_SAMPLE_RATE): Blob {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (size % 2) throw new Error('音频流不完整：PCM 样本被截断');
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const label = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  label(0, 'RIFF'); view.setUint32(4, 36 + size, true); label(8, 'WAVE'); label(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, size, true);
  return new Blob([header, ...chunks.map(chunk => new Uint8Array(chunk).buffer)], { type: 'audio/wav' });
}

/** PCM chunks are scheduled on the audio clock, including gaps caused by network stalls. */
export class PcmVoicePlayer {
  private sources = new Set<AudioBufferSourceNode>();
  private schedule: { at: number; offset: number; duration: number }[] = [];
  private tail = new Uint8Array(0);
  private duration = 0;
  private stopped = false;
  private ended = false;
  private waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];

  constructor(readonly context: AudioContext, readonly sampleRate = VOICE_SAMPLE_RATE, private readonly output: AudioNode = context.destination) {}

  get currentTime(): number {
    const now = this.context.currentTime;
    for (let i = this.schedule.length - 1; i >= 0; i--) {
      const part = this.schedule[i];
      if (now >= part.at) return part.offset + Math.min(now - part.at, part.duration);
    }
    return 0;
  }

  async resume(): Promise<void> {
    if (this.stopped) throw new DOMException('语音已停止', 'AbortError');
    await this.context.resume();
    if (this.context.state !== 'running') throw new DOMException('请点播放以允许音频输出', 'NotAllowedError');
  }

  push(bytes: Uint8Array): void {
    if (this.stopped || this.ended) throw new DOMException('语音已停止', 'AbortError');
    const joined = new Uint8Array(this.tail.length + bytes.length);
    joined.set(this.tail); joined.set(bytes, this.tail.length);
    const sampleCount = Math.floor(joined.length / 2);
    this.tail = joined.slice(sampleCount * 2);
    if (!sampleCount) return;
    const samples = new Float32Array(sampleCount);
    const data = new DataView(joined.buffer);
    for (let i = 0; i < sampleCount; i++) samples[i] = data.getInt16(i * 2, true) / 32768;
    const buffer = this.context.createBuffer(1, sampleCount, this.sampleRate);
    buffer.copyToChannel(samples, 0);
    const last = this.schedule[this.schedule.length - 1];
    const at = Math.max(this.context.currentTime + 0.04, last ? last.at + last.duration : 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.connect(this.output);
    this.schedule.push({ at, offset: this.duration, duration: buffer.duration });
    this.duration += buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source); source.disconnect();
      if (this.ended && !this.sources.size) this.waiters.splice(0).forEach(w => w.resolve());
    };
    source.start(at);
  }

  finish(): Promise<void> {
    if (this.stopped) return Promise.reject(new DOMException('语音已停止', 'AbortError'));
    if (this.tail.length) return Promise.reject(new Error('音频流不完整：PCM 样本被截断'));
    this.ended = true;
    return this.sources.size ? new Promise((resolve, reject) => this.waiters.push({ resolve, reject })) : Promise.resolve();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear();
    this.waiters.splice(0).forEach(w => w.reject(new DOMException('语音已停止', 'AbortError')));
  }
}

/** Mask whole directions before selecting a window, preserving each spoken character's timing. */
export function voiceCaptionAt(cues: VoiceCue[], time: number): { spoken: string; upcoming: string } {
  const visible: VoiceCue[] = [];
  let bracket = 0;
  let ipa = false;
  for (const cue of cues) {
    let text = '';
    for (const char of cue.text) {
      if (char === '[') { bracket++; continue; }
      if (char === ']') { bracket = Math.max(0, bracket - 1); continue; }
      if (bracket) continue;
      if (char === '/') { ipa = !ipa; continue; }
      if (!ipa) text += char;
    }
    if (text) visible.push({ ...cue, text });
  }
  let current = -1;
  for (let i = 0; i < visible.length; i++) { if (visible[i].start <= time) current = i; else break; }
  return {
    spoken: visible.slice(Math.max(0, current - 24), current + 1).map(cue => cue.text).join(''),
    upcoming: visible.slice(current + 1, current + 37).map(cue => cue.text).join(''),
  };
}
