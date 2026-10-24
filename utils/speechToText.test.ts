import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isOfficialMiniMaxBaseUrl,
  resolveMiniMaxSttApiKey,
  isSttProviderConfigured,
  resolveSttProvider,
  encodeWavFromFloat32,
  cleanFishAsrText,
  transcribeAudioWithProvider,
} from '../utils/speechToText';

describe('speechToText provider resolution & strict key guards', () => {
  it('only treats official MiniMax domains as MiniMax baseUrl', () => {
    expect(isOfficialMiniMaxBaseUrl('https://api.minimaxi.com/v1')).toBe(true);
    expect(isOfficialMiniMaxBaseUrl('https://api.minimax.io/v1')).toBe(true);
    expect(isOfficialMiniMaxBaseUrl('https://api.minimax.cn/v1')).toBe(true);
    expect(isOfficialMiniMaxBaseUrl('https://api.openai.com/v1')).toBe(false);
    expect(isOfficialMiniMaxBaseUrl('https://api.deepseek.com/v1')).toBe(false);
    expect(isOfficialMiniMaxBaseUrl('')).toBe(false);
  });

  it('never falls back to non-MiniMax main apiKey for MiniMax STT', () => {
    expect(
      resolveMiniMaxSttApiKey({
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-deepseek-123',
        minimaxApiKey: '',
      }),
    ).toBe('');

    expect(
      resolveMiniMaxSttApiKey({
        baseUrl: 'https://api.minimaxi.com/v1',
        apiKey: 'Bearer mm-main-key',
        minimaxApiKey: '',
      }),
    ).toBe('mm-main-key');

    expect(
      resolveMiniMaxSttApiKey({
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-deepseek-123',
        minimaxApiKey: 'mm-dedicated-key',
      }),
    ).toBe('mm-dedicated-key');
  });

  it('allows TTS on one platform and STT on another when the STT platform key is configured', () => {
    const config = {
      ttsProvider: 'minimax' as const,
      sttProvider: 'elevenlabs' as const,
      minimaxApiKey: 'mm-key',
      elevenLabsApiKey: 'el-key',
      fishAudioApiKey: '',
    };
    expect(isSttProviderConfigured('minimax', config)).toBe(true);
    expect(isSttProviderConfigured('elevenlabs', config)).toBe(true);
    expect(isSttProviderConfigured('fishaudio', config)).toBe(false);
    expect(resolveSttProvider(config)).toBe('elevenlabs');
  });

  it('prevents selecting an unconfigured STT provider and falls back to configured provider or browser', () => {
    // Explicit sttProvider is fishaudio, but fishAudioApiKey is empty; elevenlabs key is present
    expect(
      resolveSttProvider({
        ttsProvider: 'minimax',
        sttProvider: 'fishaudio',
        elevenLabsApiKey: 'el-key',
      }),
    ).toBe('elevenlabs');

    // No paid STT keys configured at all (even if main LLM apiKey is set for OpenAI)
    expect(
      resolveSttProvider({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai',
        ttsProvider: 'minimax',
      }),
    ).toBe('browser');
  });
});

describe('speechToText WAV encoding & provider transcription', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('encodes Float32 samples into a 16kHz 16-bit mono WAV blob', async () => {
    const samples = new Float32Array(48000); // 1 second at 48kHz
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((i / 48000) * Math.PI * 2 * 440) * 0.5;
    }
    const blob = encodeWavFromFloat32(samples, 48000, 16000);
    expect(blob.type).toBe('audio/wav');
    // 1 second at 16kHz = 16000 samples * 2 bytes + 44 header = 32044 bytes
    expect(blob.size).toBe(32044);
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // 16kHz
    expect(view.getUint16(34, true)).toBe(16); // 16-bit
  });

  it('strips speaker turn tags from Fish Audio ASR output', () => {
    expect(cleanFishAsrText('<|speaker:0|> 你好呀，今天过得怎么样？')).toBe('你好呀，今天过得怎么样？');
    expect(cleanFishAsrText('<|speaker:0|>第一句 <|speaker:1|>第二句')).toBe('第一句 第二句');
  });

  it('calls MiniMax, Fish Audio, and ElevenLabs official STT endpoints with expected headers and fields', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      calls.push({ url, init: init || {} });
      if (url.includes('minimax/stt')) {
        return new Response(JSON.stringify({ text: '海螺识别结果', duration: 1.2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('fishaudio/stt')) {
        return new Response(JSON.stringify({ text: '<|speaker:0|> 鱼声识别结果', duration: 1.5 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ text: 'ElevenLabs 识别结果', language_code: 'zho' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    const wav = encodeWavFromFloat32(new Float32Array(1600), 16000, 16000);
    const apiConfig = {
      minimaxApiKey: 'mm-secret',
      minimaxRegion: 'overseas' as const,
      fishAudioApiKey: 'fish-secret',
      elevenLabsApiKey: 'el-secret',
    };

    const mmText = await transcribeAudioWithProvider(wav, 'minimax', 'yue', apiConfig);
    expect(mmText).toBe('海螺识别结果');
    expect(calls[0].url).toBe('/api/minimax/stt');
    expect((calls[0].init.headers as any)['Authorization']).toBe('Bearer mm-secret');
    expect((calls[0].init.headers as any)['X-MiniMax-Region']).toBe('overseas');
    expect((calls[0].init.headers as any)['language']).toBe('yue');

    const fishText = await transcribeAudioWithProvider(wav, 'fishaudio', 'zh-CN', apiConfig);
    expect(fishText).toBe('鱼声识别结果');
    expect(calls[1].url).toBe('/api/fishaudio/stt');
    expect((calls[1].init.headers as any)['Authorization']).toBe('Bearer fish-secret');
    expect((calls[1].init.headers as any)['model']).toBe('transcribe-1-pro');

    const elText = await transcribeAudioWithProvider(wav, 'elevenlabs', 'zh-CN', apiConfig);
    expect(elText).toBe('ElevenLabs 识别结果');
    expect(calls[2].url).toBe('/api/elevenlabs/stt');
    expect((calls[2].init.headers as any)['xi-api-key']).toBe('el-secret');
  });

  it.runIf(Boolean(process.env.ELEVENLABS_TEST_KEY))(
    'live: transcribes synthesized speech via in-app ElevenLabs STT pipeline and serverless handler',
    async () => {
      const { execSync } = await import('node:child_process');
      const { readFileSync, unlinkSync } = await import('node:fs');
      const { default: elevenLabsSttHandler } = await import('../api/elevenlabs/stt');

      const tmpRaw = '/tmp/sully_stt_live_test.wav';
      const spokenPrompt = '你好，我是糯米机的语音通话测试，今天天气真不错，语音转文字测试成功。';
      execSync(`say -v Tingting -o ${tmpRaw} --data-format=LEF32@48000 "${spokenPrompt}"`);
      const buf = readFileSync(tmpRaw);
      unlinkSync(tmpRaw);

      let dataOffset = 44;
      for (let i = 12; i < Math.min(buf.length - 8, 512); i += 1) {
        if (buf.toString('ascii', i, i + 4) === 'data') {
          dataOffset = i + 8;
          break;
        }
      }
      const aligned = buf.subarray(dataOffset);
      const floatSamples = new Float32Array(
        aligned.buffer.slice(aligned.byteOffset, aligned.byteOffset + aligned.byteLength - (aligned.byteLength % 4)),
      );

      // 1. Encode 48kHz Float32 PCM -> 16kHz 16-bit mono WAV via in-app encoder
      const wavBlob = encodeWavFromFloat32(floatSamples, 48000, 16000);
      expect(wavBlob.size).toBeGreaterThan(10000);

      // 2. Route `/api/elevenlabs/stt` through our actual api/elevenlabs/stt.ts proxy handler -> real ElevenLabs API
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        if (url === '/api/elevenlabs/stt') {
          const serializedReq = new Request('http://localhost/api/elevenlabs/stt', {
            method: 'POST',
            headers: init?.headers,
            body: init?.body,
          });
          const rawReqBuf = Buffer.from(await serializedReq.arrayBuffer());
          const headersLower: Record<string, string> = {};
          serializedReq.headers.forEach((v, k) => {
            headersLower[k.toLowerCase()] = v;
          });

          let statusCode = 200;
          const resHeaders: Record<string, string> = {};
          let resBody = '';
          const mockReq = { method: 'POST', headers: headersLower, body: rawReqBuf };
          const mockRes = {
            setHeader: (k: string, v: string) => { resHeaders[k] = v; },
            status: (c: number) => { statusCode = c; return mockRes; },
            json: (obj: any) => { resBody = JSON.stringify(obj); return mockRes; },
            send: (txt: string) => { resBody = txt; return mockRes; },
            end: () => mockRes,
          };

          globalThis.fetch = originalFetch;
          await elevenLabsSttHandler(mockReq, mockRes);
          return new Response(resBody, { status: statusCode, headers: resHeaders });
        }
        return originalFetch(input, init);
      }) as any;

      const transcript = await transcribeAudioWithProvider(wavBlob, 'elevenlabs', 'zh-CN', {
        elevenLabsApiKey: process.env.ELEVENLABS_TEST_KEY,
        sttProvider: 'elevenlabs',
      });

      console.log('[LIVE ELEVENLABS STT RESULT]', {
        wavBytes: wavBlob.size,
        spokenPrompt,
        transcript,
      });
      expect(transcript).toMatch(/糯米[机鸡]/);
      expect(transcript).toContain('语音转文字测试成功');
    },
    30000,
  );
});
