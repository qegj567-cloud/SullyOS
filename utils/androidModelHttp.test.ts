import { beforeEach, describe, expect, it, vi } from 'vitest';
const cap = vi.hoisted(() => ({ platform: vi.fn(), request: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: cap.platform }, CapacitorHttp: { request: cap.request } }));
import { androidModelHttp, useAndroidModelHttp } from './androidModelHttp';

describe('Android main model transport', () => {
    const base = 'https://one.example/relay/v1';
    const post = { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'fixture', messages: [], stream: false }) };
    beforeEach(() => { vi.resetAllMocks(); cap.platform.mockReturnValue('android'); });
    it.each([base, 'https://two.example/v1'])('matches configured endpoint %s', url => {
        expect(useAndroidModelHttp(url + '/models', { __sullySettingsModelBase: url }, base)).toBe(true);
        expect(useAndroidModelHttp(url + '/chat/completions', post, url + '/')).toBe(true);
    });
    it('leaves other origins, other paths, HTTP, Anthropic, streams and web alone', () => {
        for (const url of ['https://two.example/relay/v1/models', base + '/other/models', base + '/models?redirect=1']) {
            expect(useAndroidModelHttp(url, {}, base)).toBe(false);
        }
        for (const url of ['http://one.example', base + '/messages']) expect(useAndroidModelHttp(url + '/models', {}, url)).toBe(false);
        expect(useAndroidModelHttp(base + '/chat/completions', { ...post, body: JSON.stringify({model:'m',messages:[],stream:true}) }, base)).toBe(false);
        cap.platform.mockReturnValue('web');
        expect(useAndroidModelHttp(base + '/models', {}, base)).toBe(false);
    });
    it('preserves server status and JSON without retrying or following redirects', async () => {
        cap.request.mockResolvedValue({ status: 401, headers: {'content-type':'application/json'}, data: {error:'invalid key'} });
        const reply = await androidModelHttp(base + '/chat/completions', post);
        expect(reply.status).toBe(401); expect(await reply.json()).toEqual({error:'invalid key'});
        expect(cap.request).toHaveBeenCalledTimes(1);
        expect(cap.request).toHaveBeenCalledWith(expect.objectContaining({disableRedirects:true,headers:post.headers,data:JSON.parse(post.body)}));
    });
    it('rejects a cancelled request without sending or replaying it', async () => {
        const ac = new AbortController(); ac.abort();
        await expect(androidModelHttp(base + '/models', {signal:ac.signal})).rejects.toBeDefined();
        expect(cap.request).not.toHaveBeenCalled();
        const active = new AbortController();
        cap.request.mockReturnValue(new Promise(() => {}));
        const waiting = androidModelHttp(base + '/models', {signal:active.signal});
        active.abort();
        await expect(waiting).rejects.toBeDefined();
        expect(cap.request).toHaveBeenCalledTimes(1);
    });
});
