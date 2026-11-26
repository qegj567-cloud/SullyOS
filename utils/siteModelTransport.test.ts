import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSiteModelTransport, modelEndpoint, modelRelayPath, siteOrigin } from './siteModelTransport';
import worker, { ModelRelayBudget } from '../worker/static-site-not-found';

const base = 'https://models.example.com/custom/v1';
const chat = base + '/chat/completions';
const models = base + '/models';
const headers = {authorization: 'Bearer sample', 'content-type': 'application/json'};
const post = {method:'POST', headers, body:'{"model":"sample","messages":[]}'};
afterEach(() => vi.unstubAllGlobals());

describe('site model connection', () => {
    it('keeps normal replies and HTTP errors direct, probes once, and never replays a generation', async () => {
        const network = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null,{status:405}))
            .mockResolvedValueOnce(new Response(null,{status:401})).mockRejectedValueOnce(new TypeError('disconnected'));
        const send = createSiteModelTransport(network, siteOrigin);
        expect((await send(chat,post)).status).toBe(401);
        await expect(send(chat,post)).rejects.toThrow('disconnected');
        expect(network.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([[chat,'HEAD'],[chat,'POST'],[chat,'POST']]);
    });
    it('uses a same-origin POST after failed browser probes for both models and chat', async () => {
        for (const [url,init] of [[models,{headers}], [chat,post]] as const) {
            const network = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('CORS')).mockResolvedValue(new Response('{}'));
            const send = createSiteModelTransport(network, siteOrigin);
            await send(url,init);
            await send(url,init);
            expect(network.mock.calls.map(([to]) => to)).toEqual([url,siteOrigin + modelRelayPath,siteOrigin + modelRelayPath]);
            expect(new Headers(network.mock.calls[1][1]?.headers).get('x-model-endpoint')).toBe(url);
            expect(network.mock.calls[1][1]?.body).toBe('body' in init ? init.body : undefined);
        }
    });
    it('does not relay cancellation, native Messages or other deployments', async () => {
        const aborted = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('cancelled','AbortError'));
        await expect(createSiteModelTransport(aborted,siteOrigin)(chat,post)).rejects.toThrow('cancelled');
        expect(aborted).toHaveBeenCalledTimes(1);
        expect(createSiteModelTransport(aborted,'https://somewhere.example')).toBe(aborted);
        expect(modelEndpoint(base + '/messages')).toBeUndefined();
    });
});

describe('site model Worker', () => {
    it('atomically caps admissions and resets the same anonymous counter on the new UTC day', async () => {
        const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
        const db = new DatabaseSync(':memory:');
        const budget = new ModelRelayBudget({storage:{sql:{exec(query,...values) {
            return db.prepare(query).all(...values) as {used:number}[];
        }}}});
        try {
            expect((await budget.fetch()).status).toBe(204);
            db.exec('UPDATE budget SET used=19999');
            expect((await Promise.all([budget.fetch(),budget.fetch()])).map(r=>r.status)).toEqual([204,429]);
            db.exec("UPDATE budget SET day='2000-01-01'");
            expect((await budget.fetch()).status).toBe(204);
            expect(db.prepare('SELECT used FROM budget').all()).toEqual([{used:1}]);
        } finally {
            db.close();
        }
    });
    const budget = {getByName: () => ({fetch: async () => new Response(null,{status:204})})};
    const env = { MODEL_BUDGET: budget, MODEL_RATE: {limit: async () => ({success:true})} };
    const request = (target:string, origin=siteOrigin) => new Request(siteOrigin + modelRelayPath,{
        ...post, headers:{...headers, origin,'cf-connecting-ip':'192.0.2.1','x-model-endpoint':target, cookie:'test=sensitive'},
    });
    it('streams the response and sends only intended credentials to the configured endpoint', async () => {
        const net = vi.fn<typeof fetch>().mockResolvedValue(new Response('data: hello\n\n',{headers:{'content-type':'text/event-stream','set-cookie':'untrusted=1'}}));
        vi.stubGlobal('fetch',net);
        const response = await worker.fetch(request(chat),env);
        expect(await response.text()).toBe('data: hello\n\n');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.has('set-cookie')).toBe(false);
        const [to,init] = net.mock.calls[0];
        expect(to).toBe(chat);
        expect(init?.redirect).toBe('manual');
        const sent = new Headers(init?.headers);
        expect(sent.get('authorization')).toBe(headers.authorization);
        expect(sent.get('origin')).toBe(siteOrigin);
        expect(sent.has('cookie')).toBe(false);
    });
    it('rejects other callers, private addresses, non-model paths and exhausted budgets before forwarding', async () => {
        const net = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch',net);
        expect((await worker.fetch(request(chat,'https://other.example'),env)).status).toBe(403);
        for (const target of ['http://test.example/v1/models','https://127.0.0.1/v1/models','https://router.local/models',base+'/files',siteOrigin+'/models']) {
            expect((await worker.fetch(request(target),env)).status).toBe(400);
        }
        expect((await worker.fetch(new Request(siteOrigin+'/missing.js'),env)).status).toBe(404);
        const full = {getByName: () => ({fetch: async () => new Response(null,{status:429})})};
        expect((await worker.fetch(request(chat),{...env,MODEL_BUDGET:full})).status).toBe(429);
        expect(net).not.toHaveBeenCalled();
    });
});
