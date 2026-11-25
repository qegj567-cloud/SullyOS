// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canUseDoubaoListening, doubaoRelayUrl, startDoubaoListening } from './doubaoListening';
vi.mock('../proxyWorker', () => ({ getProxyWorkerUrl: () => 'https://proxy.test' }));

const config = { provider: 'doubao', apiKey: 'test-key', resourceId: 'volc.seedasr.sauc.duration' } as const;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const callbacks = () => ({ speech: vi.fn(), partial: vi.fn(), final: vi.fn(), error: vi.fn(), state: vi.fn(), diagnostics: vi.fn() });
class Context {
  state = 'running'; sampleRate = 48000;
  static blockResume = false;
  static instances: Context[] = [];
  audioWorklet = { addModule: vi.fn(async () => {}) };
  destination = {}; resume = vi.fn(() => Context.blockResume ? new Promise<void>(() => {}) : Promise.resolve()); close = vi.fn(async () => {});
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
  constructor() { Context.instances.push(this); }
}
class Worklet {
  onprocessorerror: (() => void) | null = null;
  static instances: Worklet[] = [];
  port = { onmessage: null as any }; connect = vi.fn(); disconnect = vi.fn();
  constructor() { Worklet.instances.push(this); }
}
class Socket {
  static OPEN = 1; static instances: Socket[] = [];
  readyState = 1; binaryType = ''; bufferedAmount = 0;
  onopen?: () => void; onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void; onclose?: () => void;
  send = vi.fn(); close = vi.fn(() => { this.readyState = 3; });
  constructor(public url: string) { Socket.instances.push(this); }
  receive(data: unknown) { this.onmessage?.({ data }); }
}
const response = (utterances: unknown[]) => {
  const payload = new TextEncoder().encode(JSON.stringify({ result: { utterances } }));
  const result = new ArrayBuffer(8 + payload.length);
  new Uint8Array(result).set([0x11, 0x90, 0x10, 0]);
  new DataView(result).setUint32(4, payload.length); new Uint8Array(result, 8).set(payload); return result;
};
let track: { stop: ReturnType<typeof vi.fn>; onended?: () => void }, media: any;
beforeEach(() => {
  vi.useFakeTimers(); Context.instances = []; Context.blockResume = false; Socket.instances = []; Worklet.instances = [];
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Worklet); vi.stubGlobal('WebSocket', Socket);
  track = { stop: vi.fn() }; media = { getTracks: () => [track], getAudioTracks: () => [track] };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => media) } });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uses local relay in preview, production proxy otherwise, without credentials in either URL', () => {
  expect(doubaoRelayUrl({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:5175' } as Location)).toBe('ws://127.0.0.1:5175/doubao/asr');
  expect(doubaoRelayUrl({ hostname: 'app.test', origin: 'https://app.test' } as Location)).toBe('wss://proxy.test/doubao/asr');
  expect(canUseDoubaoListening()).toBe(true);
});

it('interrupts on interim, commits once on definite, and releases mic/audio/connection on stop', async () => {
  const cb = callbacks(), stop = startDoubaoListening(config, cb); await flush();
  const socket = Socket.instances[0]; socket.onopen!();
  expect(socket.url).not.toContain(config.apiKey);
  expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: 'start', apiKey: 'test-key', resourceId: config.resourceId });
  socket.receive('{"type":"ready"}'); await flush();
  Worklet.instances[0].port.onmessage({ data: new ArrayBuffer(6400) });
  expect((socket.send.mock.calls.at(-1)![0] as ArrayBuffer).byteLength).toBe(6408);
  const utterance = { text: '这件怎么样', start_time: 0, end_time: 900 };
  socket.receive(response([utterance])); await flush();
  expect(cb.speech).toHaveBeenCalledOnce(); expect(cb.final).not.toHaveBeenCalled();
  socket.receive(response([{ ...utterance, definite: true }])); await flush();
  expect(cb.final).toHaveBeenCalledWith('这件怎么样');
  const count = cb.speech.mock.calls.length;
  socket.receive(response([{ ...utterance, definite: true }])); await flush();
  expect(cb.final).toHaveBeenCalledOnce(); expect(cb.speech).toHaveBeenCalledTimes(count);
  stop(); socket.receive(response([{ text: '晚到的结果', start_time: 1000, end_time: 2000, definite: true }])); await flush();
  expect(cb.final).toHaveBeenCalledOnce(); expect(cb.error).not.toHaveBeenCalled();
  expect(track.stop).toHaveBeenCalledOnce(); expect(Context.instances[0].close).toHaveBeenCalledOnce();
  expect(socket.close).toHaveBeenCalled(); expect(Worklet.instances[0].disconnect).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels while permission is pending and disposes the late stream without ever opening a socket', async () => {
  let grant!: (value: MediaStream) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => new Promise(resolve => { grant = resolve; }));
  const cb = callbacks(), stop = startDoubaoListening(config, cb);
  stop(); grant(media); await flush();
  expect(track.stop).toHaveBeenCalledOnce(); expect(Socket.instances).toHaveLength(0); expect(cb.error).not.toHaveBeenCalled();
});

it('reports the actual outgoing PCM level and packet/response counts without treating noise as speech', async () => {
  const cb = callbacks(), stop = startDoubaoListening(config, cb); await flush();
  Socket.instances[0].receive('{"type":"ready"}'); await flush();
  const pcm = new ArrayBuffer(6400), view = new DataView(pcm);
  for (let i = 0; i < 3200; i++) view.setInt16(i * 2, 16384, true);
  Worklet.instances[0].port.onmessage({ data: pcm });
  expect(cb.diagnostics.mock.calls.at(-1)![0]).toMatchObject({ rms: 0.5, packets: 1, responses: 0, quietSeconds: 0 });
  expect(cb.speech).not.toHaveBeenCalled();
  Socket.instances[0].receive(response([])); await flush();
  expect(cb.diagnostics.mock.calls.at(-1)![0].responses).toBe(1);
  for (let i = 0; i < 30; i++) Worklet.instances[0].port.onmessage({ data: new ArrayBuffer(6400) });
  expect(cb.diagnostics.mock.calls.at(-1)![0].quietSeconds).toBeCloseTo(6);
  stop(); expect(vi.getTimerCount()).toBe(0);
});

it('releases the microphone if a worklet crashes or stops delivering audio', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const cb = callbacks(); startDoubaoListening(config, cb); await flush();
  Socket.instances[0].receive('{"type":"ready"}'); await flush();
  Worklet.instances[0].onprocessorerror?.();
  expect(cb.error).toHaveBeenCalledWith(expect.stringContaining('音频处理停止'));
  expect(track.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  startDoubaoListening(config, cb); await flush();
  Socket.instances[1].receive('{"type":"ready"}'); await flush();
  clock.mockReturnValue(6000);
  await vi.advanceTimersByTimeAsync(6000);
  expect(cb.error).toHaveBeenLastCalledWith(expect.stringContaining('没有音频数据'));
  expect(vi.getTimerCount()).toBe(0);
});

it('does not leave the mic on indefinitely when browser audio resume never resolves', async () => {
  Context.blockResume = true;
  const cb = callbacks(); startDoubaoListening(config, cb); await flush();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(cb.error).toHaveBeenCalledWith(expect.stringContaining('音频仍未启动'));
  expect(track.stop).toHaveBeenCalledOnce(); expect(Socket.instances).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('stops capture on authentication errors and network stalls, without retrying or falling back', async () => {
  const cb = callbacks(); startDoubaoListening(config, cb); await flush();
  Socket.instances[0].receive('{"type":"error","code":"http-401"}'); await flush();
  expect(cb.error).toHaveBeenCalledWith(expect.stringContaining('http-401'), 'stt'); expect(track.stop).toHaveBeenCalledOnce();
  const other = callbacks(); startDoubaoListening(config, other); await flush();
  vi.advanceTimersByTime(20_000);
  expect(other.error).toHaveBeenCalledWith(expect.stringContaining('超时'), 'stt'); expect(Socket.instances).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
