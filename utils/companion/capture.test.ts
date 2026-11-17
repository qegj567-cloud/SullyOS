import { afterEach, expect, it, vi } from 'vitest';
import { companionRecordingMime, createCompanionClipRecorder, recordCompanionClip, startCompanionVideoLoop, MAX_CLIP_BYTES, type CompanionClip } from './capture';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const clip = (from: number): CompanionClip => ({ blob: new Blob(['video'], { type: 'video/mp4' }), from, to: from + 8000 });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('records independent MP4 clips and cancels an unfinished recorder', async () => {
  vi.useFakeTimers();
  const instances: Recorder[] = [];
  class Recorder {
    static isTypeSupported = (mime: string) => mime === 'video/mp4';
    state = 'inactive'; onstop: null | (() => void) = null; onerror = null; ondataavailable: null | ((e: any) => void) = null;
    constructor() { instances.push(this); }
    start = vi.fn(() => { this.state = 'recording'; });
    stop = vi.fn(() => { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['complete-mp4']) }); this.onstop?.(); });
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  const mime = companionRecordingMime(); expect(mime).toBe('video/mp4');
  const abort = new AbortController();
  const first = recordCompanionClip({} as any, mime, abort.signal);
  expect(instances[0].start).toHaveBeenCalledWith(1000);
  await vi.advanceTimersByTimeAsync(8000);
  expect((await first).blob.type).toBe('video/mp4');
  const second = recordCompanionClip({} as any, mime, abort.signal);
  const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort(); await rejected;
  expect(instances).toHaveLength(2); expect(instances[1].stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it('joins all periodic pieces and the final piece instead of submitting fragment-only videos', async () => {
  vi.useFakeTimers(); let recorder: Recorder;
  class Recorder {
    state = 'inactive'; onstop: null | (() => void) = null; onerror = null; ondataavailable: null | ((e: any) => void) = null;
    constructor() { recorder = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['-final']) }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  const task = recordCompanionClip({} as any, 'video/mp4', new AbortController().signal);
  recorder!.ondataavailable!({ data: new Blob(['header-']) });
  recorder!.ondataavailable!({ data: new Blob(['frames']) });
  await vi.advanceTimersByTimeAsync(8000);
  expect(await (await task).blob.text()).toBe('header-frames-final'); expect(vi.getTimerCount()).toBe(0);
});

it('distinguishes empty output from oversized video, bounds buffering and leaves camera tracks untouched', async () => {
  vi.useFakeTimers(); let recorder: Recorder;
  class Recorder {
    state = 'inactive'; onstop: null | (() => void) = null; onerror = null; ondataavailable: null | ((e: any) => void) = null;
    constructor() { recorder = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  const track = { stop: vi.fn() }, stream = { getTracks: () => [track] } as any;
  const empty = recordCompanionClip(stream, 'video/mp4', new AbortController().signal);
  const emptyResult = expect(empty).rejects.toMatchObject({ kind: 'empty', message: expect.stringContaining('0 字节') });
  await vi.advanceTimersByTimeAsync(8000); await emptyResult;
  const large = recordCompanionClip(stream, 'video/mp4', new AbortController().signal);
  const largeResult = expect(large).rejects.toMatchObject({ kind: 'size' });
  recorder!.ondataavailable!({ data: new Blob([new Uint8Array(MAX_CLIP_BYTES + 1)]) });
  await largeResult; expect(recorder!.state).toBe('inactive'); expect(vi.getTimerCount()).toBe(0);
  expect(track.stop).not.toHaveBeenCalled();
});

it('tries another supported MP4 encoder locally after empty output, then retains the working choice', async () => {
  vi.useFakeTimers(); const formats: string[] = [];
  class Recorder {
    static isTypeSupported = () => true;
    state = 'inactive'; onstop: null | (() => void) = null; onerror = null; ondataavailable: null | ((e: any) => void) = null;
    constructor(_stream: unknown, private options: { mimeType: string }) { formats.push(options.mimeType); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; if (this.options.mimeType.includes('codecs')) this.ondataavailable?.({ data: new Blob(['complete']) }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  const record = createCompanionClipRecorder({} as any, new AbortController().signal);
  const first = record(); await vi.advanceTimersByTimeAsync(16000); expect((await first).blob.size).toBe(8);
  const next = record(); await vi.advanceTimersByTimeAsync(8000); await next;
  expect(formats).toEqual(['video/mp4', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1.42E01E']);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not silently fall back to screenshots or unsupported webm', () => {
  vi.stubGlobal('MediaRecorder', { isTypeSupported: (mime: string) => mime === 'video/webm' });
  expect(() => companionRecordingMime()).toThrow('MP4');
});

it('records while analysis runs, keeps only the latest pending clip and ignores it after abort', async () => {
  const abort = new AbortController(), recordings = Array.from({ length: 5 }, () => deferred<CompanionClip>()), processing = [deferred<void>(), deferred<void>()];
  let recordIndex = 0, observeIndex = 0;
  const observe = vi.fn((_clip: CompanionClip) => processing[observeIndex++].promise), error = vi.fn();
  startCompanionVideoLoop({ signal: abort.signal, record: () => recordings[recordIndex++].promise, observe, error });
  recordings[0].resolve(clip(0)); await flush();
  recordings[1].resolve(clip(8000)); await flush();
  recordings[2].resolve(clip(16000)); await flush();
  expect(observe).toHaveBeenCalledTimes(1); expect(recordIndex).toBe(4);
  processing[0].resolve(); await flush();
  expect(observe).toHaveBeenCalledTimes(2); expect(observe.mock.calls[1][0].from).toBe(16000);
  recordings[3].resolve(clip(24000)); await flush();
  abort.abort(); processing[1].resolve(); recordings[4].resolve(clip(32000)); await flush();
  expect(observe).toHaveBeenCalledTimes(2); expect(error).not.toHaveBeenCalled();
});
