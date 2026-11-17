import { afterEach, expect, it, vi } from 'vitest';
import { companionRecordingMime, recordCompanionClip, startCompanionVideoLoop, type CompanionClip } from './capture';
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
  await vi.advanceTimersByTimeAsync(8000);
  expect((await first).blob.type).toBe('video/mp4');
  const second = recordCompanionClip({} as any, mime, abort.signal);
  const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort(); await rejected;
  expect(instances).toHaveLength(2); expect(instances[1].stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
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
