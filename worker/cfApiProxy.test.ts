/**
 * 中心 worker 的 /cf-api 中转（worker/index.js）。
 *
 * 这条路存在的唯一理由是 api.cloudflare.com 不返回 CORS 头，浏览器发不出请求。
 * 转发的又是一枚能改用户整个账号 Workers 的 token，所以下面几条护栏一旦松掉，
 * 这个端点就从「amsg 一键部署的中转」变成「公开的 CF API 中继」。用测试钉住：
 *   - 目标 host 只能是 api.cloudflare.com，路径只能落在账号级资源里
 *   - 拒绝的请求一次上游都不能发
 *   - 日志里不许出现 token
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error 中心 worker 是纯 JS 单文件，仓库没开 allowJs
import worker from './index.js';

const TOKEN = 'Bearer cf-token-must-not-leak';

/** 装一个假的上游 fetch，返回它收到的调用记录。 */
const stubUpstream = (status = 200, body = '{"success":true}') => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fake);
    return calls;
};

const callProxy = (
    path: string,
    { method = 'POST', cfMethod = 'GET', auth = TOKEN, headers = {}, body = undefined as BodyInit | undefined } = {}
) => {
    const h: Record<string, string> = { ...headers };
    if (auth) h['Authorization'] = auth;
    if (cfMethod) h['X-CF-Method'] = cfMethod;
    const url = `https://proxy.test/cf-api?path=${encodeURIComponent(path)}`;
    return worker.fetch(new Request(url, { method, headers: h, body }), {}, { waitUntil: () => {} });
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('/cf-api 路径白名单', () => {
    it('账号级路径放行，并打到 api.cloudflare.com', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts?per_page=50');

        expect(res.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts?per_page=50');
        expect(calls[0].init.method).toBe('GET');
        expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe(TOKEN);
    });

    it('/zones/* 拒掉，且一次上游都不发', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/zones/abc123/dns_records', { cfMethod: 'POST' });

        expect(res.status).toBe(403);
        expect(calls).toHaveLength(0);
    });

    it('绝对地址不能把目标带走', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts/../../https://evil.example/steal');

        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it('路径里的 .. 直接 400', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts/../zones/abc');

        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it('不以 / 开头的路径直接 400', async () => {
        const calls = stubUpstream();
        const res = await callProxy('accounts');

        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });
});

describe('/cf-api 请求约束', () => {
    it('没有 Authorization 就不往上游发', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts', { auth: '' });

        expect(res.status).toBe(401);
        expect(calls).toHaveLength(0);
    });

    it('真正的转发只收 POST，其余方法 405', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts', { method: 'PUT', cfMethod: 'GET' });

        expect(res.status).toBe(405);
        expect(calls).toHaveLength(0);
    });

    it('GET 是探针：不带凭据也回 200，且不碰上游', async () => {
        const calls = stubUpstream();
        const res = await worker.fetch(
            new Request('https://proxy.test/cf-api', { method: 'GET' }),
            {},
            { waitUntil: () => {} }
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, relay: 'cf-api' });
        expect(calls).toHaveLength(0);
    });

    it('X-CF-Method 不在名单里就 400', async () => {
        const calls = stubUpstream();
        const res = await callProxy('/accounts', { cfMethod: 'TRACE' });

        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it('multipart 上传时 Content-Type 原样转发（boundary 不能丢）', async () => {
        const calls = stubUpstream();
        const contentType = 'multipart/form-data; boundary=----SullyOSBoundary123';
        const res = await callProxy('/accounts/acc123/workers/scripts/sullyos-amsg', {
            cfMethod: 'PUT',
            headers: { 'Content-Type': contentType },
            body: 'payload-bytes',
        });

        expect(res.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].init.method).toBe('PUT');
        expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe(contentType);
        expect(new TextDecoder().decode(calls[0].init.body as ArrayBuffer)).toBe('payload-bytes');
    });

    it('上游状态码原样透传，前端能分辨 token 无效和权限不够', async () => {
        stubUpstream(403, '{"success":false,"errors":[{"code":9109}]}');
        const res = await callProxy('/accounts');

        expect(res.status).toBe(403);
        expect(await res.text()).toContain('9109');
    });
});

describe('/cf-api 日志', () => {
    it('日志里不出现 token 和 query（账号 id 会留在路径里，可接受）', async () => {
        stubUpstream();
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await callProxy('/accounts?per_page=50');

        const logged = spy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(logged).toContain('cf-api');
        expect(logged).not.toContain(TOKEN);
        expect(logged).not.toContain('cf-token-must-not-leak');
        expect(logged).not.toContain('per_page');
    });
});

describe('/amsg-bundle 官方部署包代拉', () => {
    it('默认拉 main 分支的 worker.bundle.js，也支持 canary 的 wrangler.toml', async () => {
        const calls = stubUpstream(200, 'export default {}');

        const res1 = await worker.fetch(new Request('https://proxy.test/amsg-bundle'), {}, { waitUntil: () => {} });
        expect(res1.status).toBe(200);
        expect(res1.headers.get('Content-Type')).toContain('application/javascript');
        expect(calls[0].url).toBe('https://raw.githubusercontent.com/Tosd0/sullyos-workers/main/amsg/worker.bundle.js');

        const res2 = await worker.fetch(
            new Request('https://proxy.test/amsg-bundle?file=wrangler.toml&channel=canary'),
            {},
            { waitUntil: () => {} }
        );
        expect(res2.status).toBe(200);
        expect(res2.headers.get('Content-Type')).toContain('text/plain');
        expect(calls[1].url).toBe('https://raw.githubusercontent.com/Tosd0/sullyos-workers/canary/amsg/wrangler.toml');
    });

    it('白名单外的文件名、通道名和非 GET 请求一律拒绝，不发上游请求', async () => {
        const calls = stubUpstream();

        const badFile = await worker.fetch(new Request('https://proxy.test/amsg-bundle?file=../../secret'), {}, { waitUntil: () => {} });
        expect(badFile.status).toBe(400);

        const badChannel = await worker.fetch(new Request('https://proxy.test/amsg-bundle?channel=evil'), {}, { waitUntil: () => {} });
        expect(badChannel.status).toBe(400);

        const badMethod = await worker.fetch(new Request('https://proxy.test/amsg-bundle', { method: 'POST' }), {}, { waitUntil: () => {} });
        expect(badMethod.status).toBe(405);

        expect(calls).toHaveLength(0);
    });
});
