// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStreamingVoice } from '../hooks/useStreamingVoice';
import type { APIConfig, CharacterProfile } from '../types';
import { DB } from './db';
vi.mock('./db', () => ({ DB: { getAssetRaw: vi.fn(async () => null), saveAssetRaw: vi.fn(async () => {}) } }));
vi.mock('./proxyWorker', () => ({ getProxyWorkerUrl: () => 'https://proxy.example.test' }));
const char = { id: 'a', voiceProfile: { elevenLabsVoiceId: 'voice_abcdefgh' } } as CharacterProfile;
const config = { elevenLabsApiKey: 'test-only', elevenLabsModel: 'eleven_v4' } as APIConfig;
const frame = JSON.stringify({ audio_base64: btoa(String.fromCharCode(...new Uint8Array(4800))), alignment: { characters: ['你'], character_start_times_seconds: [0], character_end_times_seconds: [.1] } }) + '\n';
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0; state = 'running'; destination = {}; sampleRate = 24000;
  sources: any[] = [];
  constructor() { FakeAudioContext.instances.push(this); }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = 'closed'; });
  createAnalyser = () => ({ fftSize: 1024, context: this, connect: vi.fn(), disconnect: vi.fn() });
  createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
  createBuffer = (_channels: number, count: number, rate: number) => ({ duration: count / rate, copyToChannel() {} });
  createBufferSource = () => {
    const source = { connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(), start: vi.fn(), onended: null as any, buffer: null };
    this.sources.push(source); return source;
  };
}
let root: Root;
let host: HTMLDivElement;
let voice: ReturnType<typeof useStreamingVoice>;
function Surface({ owner }: { owner: string }) { voice = useStreamingVoice(owner); return React.createElement('span', null, voice.state?.status); }
const render = async (owner = 'a') => { await act(async () => { root.render(React.createElement(Surface, { owner })); }); };
beforeEach(async () => {
  vi.clearAllMocks(); FakeAudioContext.instances = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('streaming voice surface lifecycle', () => {
  it('plays before EOF and resolves only when the scheduled sound finishes', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { controller = c; } }))));
    let finished = false;
    let pending!: ReturnType<typeof voice.speak>;
    await act(async () => { pending = voice.speak('one', '你好', char, config); void pending.then(() => { finished = true; }); });
    await act(async () => { controller.enqueue(new TextEncoder().encode(frame)); await new Promise(r => setTimeout(r, 100)); });
    expect(host.textContent).toBe('playing');
    const context = FakeAudioContext.instances[0];
    expect(context.sources[0].start).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    await act(async () => { controller.close(); await new Promise(r => setTimeout(r, 0)); });
    expect(finished).toBe(false);
    await act(async () => { context.sources[0].onended(); await pending; });
    expect(host.textContent).toBe('done');
    expect(finished).toBe(true);
  });

  it('stops scheduled sound and the pending network reader when switching owners', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame)); }, cancel }))));
    let pending!: ReturnType<typeof voice.speak>;
    await act(async () => { voice.prime(); pending = voice.speak('old', '你好', char, config); void pending.catch(() => {}); await new Promise(r => setTimeout(r, 0)); });
    const context = FakeAudioContext.instances[0];
    await render('b');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(context.sources[0].stop).toHaveBeenCalledOnce();
    expect(DB.saveAssetRaw).not.toHaveBeenCalled();
    expect(host.textContent).toBe('');
    expect(context.close).not.toHaveBeenCalled(); // gesture-unlocked context is reusable across owners
  });

  it('keeps a newer utterance alive when an older canceled request finishes late', async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { controllers.push(c); } }))));
    let old!: ReturnType<typeof voice.speak>;
    let next!: ReturnType<typeof voice.speak>;
    await act(async () => { old = voice.speak('old', '第一句', char, config); void old.catch(() => {}); });
    await act(async () => { next = voice.speak('new', '第二句', char, config); void next.catch(() => {}); });
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await act(async () => { controllers[1].enqueue(new TextEncoder().encode(frame)); await new Promise(r => setTimeout(r, 100)); });
    expect(voice.state?.id).toBe('new'); expect(voice.state?.status).toBe('playing');
    await act(async () => { voice.stop(); });
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports a blocked audio context before making a paid request', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await act(async () => { voice.prime(); });
    FakeAudioContext.instances[0].resume.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    await act(async () => { await expect(voice.speak('one', '你好', char, config)).rejects.toMatchObject({ name: 'NotAllowedError' }); });
    expect(fetch).not.toHaveBeenCalled(); expect(voice.state?.status).toBe('error');
  });
});
