import { expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { AsrTranscript, asrPacket, asrStartPacket, parseAsrPacket } from './doubaoProtocol';

export function responsePacket(data: unknown, compressed = false, code = 0) {
  const json = new TextEncoder().encode(JSON.stringify(data));
  const payload = compressed ? gzipSync(json) : json;
  const buffer = new ArrayBuffer(12 + payload.length), view = new DataView(buffer);
  new Uint8Array(buffer).set([0x11, code ? 0xf0 : 0x91, compressed ? 0x11 : 0x10, 0]);
  view.setInt32(4, code || 1); view.setUint32(8, payload.length);
  new Uint8Array(buffer, 12).set(payload); return buffer;
}

it('encodes documented uncompressed configuration and little-endian PCM payload framing', () => {
  const start = asrStartPacket(), bytes = new Uint8Array(start);
  expect([...bytes.slice(0, 4)]).toEqual([0x11, 0x10, 0x10, 0]);
  expect(new DataView(start).getUint32(4)).toBe(bytes.length - 8);
  const config = JSON.parse(new TextDecoder().decode(bytes.slice(8)));
  expect(config.audio).toEqual({ format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 });
  expect(config.request).toMatchObject({ show_utterances: true, enable_nonstream: true, end_window_size: 800 });
  expect([...new Uint8Array(asrPacket(2, new Uint8Array([0xff, 0x7f]), true))]).toEqual([0x11, 0x22, 0, 0, 0, 0, 0, 2, 0xff, 0x7f]);
});

it('decodes raw/gzip sequenced snapshots and rejects truncated frames without leaking server error bodies', async () => {
  const data = { result: { utterances: [{ text: '这件不错', start_time: 0, end_time: 1000, definite: true }] } };
  for (const compressed of [false, true]) expect(await parseAsrPacket(responsePacket(data, compressed))).toEqual(data);
  await expect(parseAsrPacket(responsePacket(data).slice(0, -1))).rejects.toThrow('不完整');
  await expect(parseAsrPacket(responsePacket({ secret: 'do-not-surface' }, false, 45000001))).rejects.toThrow('45000001');
  try { await parseAsrPacket(responsePacket({ secret: 'do-not-surface' }, false, 45000001)); }
  catch (error) { expect(String(error)).not.toContain('do-not-surface'); }
});

it('deduplicates full snapshots and holds an early definite segment while the user continues speaking', () => {
  const transcript = new AsrTranscript();
  const a = { text: '这件', start_time: 0, end_time: 700 };
  const b = { text: '怎么样', start_time: 800, end_time: 1600 };
  expect(transcript.consume({ result: { utterances: [a] } })).toEqual({ partial: '这件', finals: [] });
  expect(transcript.consume({ result: { utterances: [{ ...a, definite: true }, b] } })).toEqual({ partial: '这件怎么样', finals: [] });
  const finished = { result: { utterances: [{ ...a, definite: true }, { ...b, definite: true }] } };
  expect(transcript.consume(finished)).toEqual({ partial: '', finals: ['这件', '怎么样'] });
  expect(transcript.consume(finished)).toEqual({ partial: '', finals: [] });
  expect(transcript.consume({ result: { utterances: [...finished.result.utterances, { text: '等一下', start_time: 2000, end_time: 2500 }] } }).partial).toBe('等一下');
});

it.each([44100, 48000])('resamples %i Hz microphone blocks into exact 200 ms mono PCM16 packets', rate => {
  const packets: ArrayBuffer[] = []; let Processor: any;
  runInNewContext(readFileSync(new URL('./doubaoPcm.worklet.js', import.meta.url), 'utf8'), {
    sampleRate: rate,
    AudioWorkletProcessor: class { port = { postMessage: (buffer: ArrayBuffer) => packets.push(buffer) }; },
    registerProcessor: (_name: string, constructor: any) => { Processor = constructor; },
  });
  const processor = new Processor();
  for (let offset = 0; offset < rate * 0.4; offset += 128) {
    processor.process([[new Float32Array(Math.min(128, rate * 0.4 - offset)).fill(-0.5)]]);
  }
  expect(packets).toHaveLength(2);
  for (const packet of packets) {
    expect(packet.byteLength).toBe(6400);
    const view = new DataView(packet);
    for (let i = 0; i < 3200; i++) expect(view.getInt16(i * 2, true)).toBe(-16384);
  }
});
