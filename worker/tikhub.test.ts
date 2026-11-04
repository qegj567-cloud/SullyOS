import {afterEach, expect, it, vi} from 'vitest';
// @ts-expect-error Plain JavaScript Worker runtime.
import worker from './index.js';
afterEach(() => vi.unstubAllGlobals());
it('retires the paid route for old clients without forwarding any request or credential', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const method of ['GET', 'POST']) {
        const r = await worker.fetch(new Request('https://proxy.test/tikhub?platform=x&id=12345', {
            method, headers: {Authorization: 'Bearer test-only-key', Origin: 'https://app.test'},
        }), {}, {});
        expect(r.status).toBe(410); expect(r.headers.get('cache-control')).toBe('no-store');
        expect(r.headers.get('access-control-allow-origin')).toBe('https://app.test');
        expect(await r.text()).not.toContain('test-only-key');
    }
    expect(fetcher).not.toHaveBeenCalled();
});
