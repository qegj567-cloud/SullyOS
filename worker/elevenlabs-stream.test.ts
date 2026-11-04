import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Worker entry is plain runtime JavaScript.
import worker from './index.js';

describe('ElevenLabs proxy streaming', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    ['voice_id=voice_abcdefgh', 'text-to-speech/voice_abcdefgh'],
    ['mode=dialogue', 'text-to-dialogue'],
  ])('forwards %s timestamps without buffering and exposes continuity ids', async (query, endpoint) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'application/json', 'request-id': 'continuity-1' } }));
    vi.stubGlobal('fetch', fetcher);
    const response = await worker.fetch(new Request(`https://local.test/elevenlabs/tts?${query}&timestamps=1&output_format=pcm_24000`, {
      method: 'POST', headers: { 'xi-api-key': 'test-only', 'content-type': 'application/json' }, body: '{"text":"hello"}',
    }), {}, { waitUntil() {} });
    expect(response.status).toBe(200);
    expect(String(fetcher.mock.calls[0][0])).toBe(`https://api.elevenlabs.io/v1/${endpoint}/stream/with-timestamps?output_format=pcm_24000`);
    expect(response.headers.get('request-id')).toBe('continuity-1');
    expect(response.headers.get('access-control-expose-headers')).toContain('request-id');
    controller.enqueue(new TextEncoder().encode('{"audio_base64":"AAA="}\n'));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('AAA=');
    controller.close();
    await reader.cancel();
  });
});
