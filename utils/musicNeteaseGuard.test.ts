/**
 * 客户端网易云凭据规范化、风控报错翻译与缓存防污染守卫
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { musicApi, MusicCfg, normalizeCookie } from './../context/MusicContext';
import { cachedCall, clearAll } from './musicCache';

const baseCfg: MusicCfg = {
  workerUrl: 'https://proxy.test',
  cookie: '',
  quality: 'exhigh',
};

describe('normalizeCookie 凭据规范化', () => {
  it('裸令牌补 MUSIC_U= 前缀，整段浏览器 Cookie 原样保留不重复加前缀', () => {
    expect(normalizeCookie('')).toBe('');
    expect(normalizeCookie('  abc123token  ')).toBe('MUSIC_U=abc123token');
    expect(normalizeCookie('MUSIC_U=abc123token')).toBe('MUSIC_U=abc123token');
    expect(normalizeCookie('NMTID=00Oxyz; MUSIC_U=abc123token; __csrf=def456')).toBe(
      'NMTID=00Oxyz; MUSIC_U=abc123token; __csrf=def456',
    );
  });
});

describe('musicCache 异常结果不落缓存', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAll();
  });

  it('song/url 返回空 url 时不缓存，下一次调用重新请求网络', async () => {
    let calls = 0;
    const first = await cachedCall('/song/url', { ids: [4337168] }, '', async () => {
      calls++;
      return { code: 200, data: [{ id: 4337168, url: null }] };
    });
    expect(first.data[0].url).toBeNull();

    const second = await cachedCall('/song/url', { ids: [4337168] }, '', async () => {
      calls++;
      return { code: 200, data: [{ id: 4337168, url: 'https://m701.music.126.net/ok.mp3' }] };
    });
    expect(calls).toBe(2);
    expect(second.data[0].url).toBe('https://m701.music.126.net/ok.mp3');
  });

  it('lyric 等长 TTL 接口返回非 200 业务码时不缓存', async () => {
    let calls = 0;
    await cachedCall('/lyric', { id: 1 }, '', async () => {
      calls++;
      return { code: -460, message: 'risk' };
    });
    const ok = await cachedCall('/lyric', { id: 1 }, '', async () => {
      calls++;
      return { code: 200, lrc: { lyric: '[00:01.00]hello' } };
    });
    expect(calls).toBe(2);
    expect(ok.code).toBe(200);
  });
});

describe('musicApi._raw 风控错误可读化', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('旧版 Worker 返回 502 且 detail 标明 risk-control 时转为明确风控提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({
        error: 'netease upstream fetch failed (all sources)',
        detail: 'api-enhanced.example.com risk-control (code=-460)',
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(musicApi._raw(baseCfg, '/song/url', { ids: [1] })).rejects.toThrow(
      '网易云接口触发风控，请稍后再试',
    );
  });

  it('上游以 HTTP 200 透传 code=-460 时拦截并抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      code: -460,
      message: '检测到您的网络环境存在风险，请稍后再试',
    })));

    await expect(musicApi._raw(baseCfg, '/song/url', { ids: [1] })).rejects.toThrow(
      '检测到您的网络环境存在风险，请稍后再试',
    );
  });
});
