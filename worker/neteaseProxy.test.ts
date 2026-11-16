/**
 * 中心 Worker 的 /netease/* 音乐代理回归守卫（worker/index.js）
 *
 * 钉住四条防线：
 *   1. 320k 及以下音质（standard / higher / exhigh）直接走 crypto=weapi，避开海外机房 IP + 无状态实例缺 NMTID 触发的客户端 eapi 风控。
 *   2. lossless / hires 先走默认通道保留高解析度；一旦上游返回 -460/-7 风控（无论 HTTP 400 还是 HTTP 200），自动降级重试一次 crypto=weapi。
 *   3. 单上游下 HTTP 200 的 -460/-7 风控报文也一律按失败拦截，绝不放行或写入边缘缓存。
 *   4. song/url 边缘缓存按 Cookie 单向摘要分桶（不共用单一 vip 桶、不落明文凭据），试听片段与空直链不入边缘缓存。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error 中心 worker 是纯 JS 单文件，仓库没开 allowJs
import worker from './index.js';

const createFakeEdgeCache = () => {
  const store = new Map<string, Response>();
  const match = vi.fn(async (req: Request | string) => {
    const key = typeof req === 'string' ? req : req.url;
    const hit = store.get(key);
    return hit ? hit.clone() : undefined;
  });
  const put = vi.fn(async (req: Request | string, res: Response) => {
    const key = typeof req === 'string' ? req : req.url;
    store.set(key, res.clone());
  });
  vi.stubGlobal('caches', { default: { match, put } });
  return { store, match, put };
};

const callNetease = async (
  action: string,
  body: Record<string, unknown>,
  cookie = '',
) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['X-Netease-Cookie'] = cookie;
  const pending: Promise<unknown>[] = [];
  const res = await worker.fetch(
    new Request(`https://proxy.test/netease/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    {},
    { waitUntil: (p: Promise<unknown>) => { pending.push(p); } },
  );
  await Promise.all(pending);
  return res;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/netease/song/url 通道选择与风控降级', () => {
  it('exhigh 及以下档位直接附带 crypto=weapi 请求上游', async () => {
    createFakeEdgeCache();
    const calls: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(new URL(url));
      return Response.json({
        code: 200,
        data: [{ id: 4337168, url: 'https://m701.music.126.net/full.mp3', br: 320000, freeTrialInfo: null }],
      });
    }));

    const res = await callNetease('song/url', { ids: [4337168], level: 'exhigh' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].pathname).toBe('/song/url/v1');
    expect(calls[0].searchParams.get('level')).toBe('exhigh');
    expect(calls[0].searchParams.get('crypto')).toBe('weapi');
  });

  it('lossless 首轮不强制 weapi；撞上 HTTP 400 -460 风控时自动用 crypto=weapi 重试并恢复', async () => {
    createFakeEdgeCache();
    const calls: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      calls.push(u);
      if (!u.searchParams.get('crypto')) {
        return new Response(
          JSON.stringify({ code: -460, message: '检测到您的网络环境存在风险，请稍后再试' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return Response.json({
        code: 200,
        data: [{ id: 1993420647, url: 'https://m801.music.126.net/fallback.mp3', br: 320000, freeTrialInfo: null }],
      });
    }));

    const res = await callNetease('song/url', { ids: [1993420647], level: 'lossless' }, 'MUSIC_U=vip_token');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].searchParams.get('crypto')).toBeNull();
    expect(calls[1].searchParams.get('crypto')).toBe('weapi');
    const json = await res.json();
    expect(json.data[0].url).toBe('https://m801.music.126.net/fallback.mp3');
  });

  it('单上游返回 HTTP 200 但 body 为 code=-460 时按风控失败拦截，绝不放行或写边缘缓存', async () => {
    const cache = createFakeEdgeCache();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      code: -460,
      message: '检测到您的网络环境存在风险，请稍后再试',
    })));

    const res = await callNetease('lyric', { id: 4337168 });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('网易云接口触发风控，请稍后再试');
    expect(body.detail).toContain('risk-control (code=-460)');
    expect(cache.put).not.toHaveBeenCalled();
  });
});

describe('/netease/song/url 边缘缓存分桶与试听过滤', () => {
  it('不同账号各自独立缓存桶且键中不含明文 Cookie，同账号二次请求命中边缘缓存', async () => {
    const cache = createFakeEdgeCache();
    const fetcher = vi.fn(async (url: string) => {
      const ck = new URL(url).searchParams.get('cookie') || '';
      return Response.json({
        code: 200,
        data: [{ id: 4337168, url: `https://m701.music.126.net/${ck}.mp3`, br: 320000, freeTrialInfo: null }],
      });
    });
    vi.stubGlobal('fetch', fetcher);

    const r1 = await callNetease('song/url', { ids: [4337168], level: 'exhigh' }, 'MUSIC_U=secret_account_alpha');
    expect(r1.headers.get('X-Sully-Cache')).toBe('MISS');

    const r1Hit = await callNetease('song/url', { ids: [4337168], level: 'exhigh' }, 'MUSIC_U=secret_account_alpha');
    expect(r1Hit.headers.get('X-Sully-Cache')).toBe('HIT');
    expect(fetcher).toHaveBeenCalledTimes(1);

    const r2 = await callNetease('song/url', { ids: [4337168], level: 'exhigh' }, 'MUSIC_U=secret_account_beta');
    expect(r2.headers.get('X-Sully-Cache')).toBe('MISS');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await r2.json()).data[0].url).toContain('secret_account_beta');

    const keys = [...cache.store.keys()];
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(k).not.toContain('secret_account');
      expect(k).toMatch(/\/song\/url\/u_[0-9a-f]{16}\?/);
    }
  });

  it('试听片段（freeTrialInfo 非空）和空直链不写入边缘缓存', async () => {
    const cache = createFakeEdgeCache();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({
        code: 200,
        data: [{ id: 4337168, url: 'https://m701.music.126.net/trial.mp3', br: 128000, freeTrialInfo: { start: 0, end: 45 } }],
      }))
      .mockResolvedValueOnce(Response.json({
        code: 200,
        data: [{ id: 4337168, url: null, br: 0, freeTrialInfo: null }],
      })));

    const trialRes = await callNetease('song/url', { ids: [4337168], level: 'exhigh' }, 'MUSIC_U=normal_user');
    expect(trialRes.status).toBe(200);
    expect(cache.put).not.toHaveBeenCalled();

    const emptyRes = await callNetease('song/url', { ids: [4337168], level: 'exhigh' });
    expect(emptyRes.status).toBe(200);
    expect(cache.put).not.toHaveBeenCalled();
  });
});
