import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import worker from './index';
import { SIGNAL_ARCHIVE_REVISION as revision } from '../../../utils/vrWorld/bifangConfig';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
let sqlite: any;
let env: any;
function statement(sql: string, params: any[] = []): any {
    return {
        bind: (...values: any[]) => statement(sql, values),
        first: async () => sqlite.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
        run: async () => sqlite.prepare(sql).run(...params),
    };
}
const req = (device = 'device-a', extra = {}) => new Request('https://bifang.test/po/poem/recover-ownership', {
    method: 'POST', body: JSON.stringify({ device, ...extra }),
});
const legacy = (mine = true, content = '原句') => ({ ok: true, poems: [{ id: 'p', mineCount: mine ? 1 : 0, lines: [{ seq: 3, content, mine }] }] });
const record = () => sqlite.prepare('SELECT * FROM po_archive_recovery').get();

beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../../post-office/schema.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    sqlite.prepare('INSERT INTO po_archive_manifest VALUES (?, 1, 1)').run(revision);
    sqlite.exec("INSERT INTO po_poems (id,booklet_id,title,target_lines,line_count,status,created_at) VALUES ('p','b','标题',4,1,'sealed',1)");
    sqlite.exec("INSERT INTO po_poem_lines VALUES ('l','p','b',3,'','笔名','原句',1)");
    env = { DB: { prepare: statement, exec: async (sql: string) => sqlite.exec(sql), batch: async (statements: any[]) => {
        sqlite.exec('BEGIN');
        try { const results = []; for (const stmt of statements) results.push(await stmt.run()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } } };
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('verified archive ownership recovery', () => {
    it('keeps the new postal send, receive and reply round trip working', async () => {
        const post = (path: string, body: object) => worker.fetch(new Request(`https://bifang.test/po/${path}`, { method: 'POST', body: JSON.stringify(body) }), env);
        const sent: any = await (await post('letters', { device: 'sender', letters: [{ pen: '旅人', content: '测试来信' }] })).json();
        expect(sent.ids).toHaveLength(1);
        const inbox: any = await (await worker.fetch(new Request('https://bifang.test/po/inbox?device=reader'), env)).json();
        expect(inbox.letters[0].id).toBe(sent.ids[0]);
        expect(await (await post('replies', { device: 'reader', replies: [{ letterId: sent.ids[0], pen: '读者', content: '测试回信' }] })).json()).toMatchObject({ accepted: 1 });
        const replies: any = await (await worker.fetch(new Request('https://bifang.test/po/replies?device=sender'), env)).json();
        expect(replies.replies[0]).toMatchObject({ letter_id: sent.ids[0], content: '测试回信' });
    });
    it('keeps original seq/content, verifies at the fixed origin, and serves mine without another legacy call', async () => {
        const fetcher = vi.fn(async (..._args: any[]) => Response.json(legacy())); vi.stubGlobal('fetch', fetcher);
        expect(await (await worker.fetch(req(), env)).json()).toMatchObject({ completed: true, revision });
        const url = new URL(String(fetcher.mock.calls[0][0]));
        expect(url.origin).toBe('https://noir2.cc.cd'); expect(url.searchParams.get('device')).toBe('device-a');
        expect(sqlite.prepare('SELECT seq,content,device FROM po_poem_lines').get()).toMatchObject({ seq: 3, content: '原句', device: 'device-a' });
        expect(await (await worker.fetch(req(), env)).json()).toMatchObject({ completed: true });
        expect(fetcher).toHaveBeenCalledTimes(1);
        const feed: any = await (await worker.fetch(new Request('https://bifang.test/po/poem/feed?device=device-a&mine=1'), env)).json();
        expect(feed.poems[0].lines[0]).toMatchObject({ seq: 3, mine: true });
        expect(feed.poems[0].lines[0]).not.toHaveProperty('device');
    });
    it('ignores forged client claims and completes a legitimate empty response', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, poems: [] })));
        expect(await (await worker.fetch(req('device-a', { claims: [{ poemId: 'p', seq: 3, mine: true }] }), env)).json()).toMatchObject({ completed: true });
        expect(sqlite.prepare('SELECT device FROM po_poem_lines').get().device).toBe('');
    });
    it('uses the Workers-compatible manual redirect mode and refuses redirected identity requests', async () => {
        const fetcher = vi.fn(async (_url: any, init: any) => {
            expect(init.redirect).toBe('manual');
            return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/' } });
        });
        vi.stubGlobal('fetch', fetcher);
        expect((await worker.fetch(req(), env)).status).toBe(503);
        expect(fetcher).toHaveBeenCalledTimes(1); expect(record().completed).toBe(0);
    });
    it.each([
        { ok: true }, { ok: false, poems: [] }, { ok: true, poems: Array(100).fill(legacy().poems[0]) },
        { ok: true, poems: [{ id: 'p', mineCount: 1, lines: [{ seq: 3, content: '原句' }] }] },
        legacy(true, '被修改的句子'),
    ])('does not complete or mutate on incomplete or conflicting upstream data: %j', async data => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
        expect((await worker.fetch(req(), env)).status).toBe(503);
        expect(record().completed).toBe(0);
        expect(sqlite.prepare('SELECT device FROM po_poem_lines').get().device).toBe('');
    });
    it('does not overwrite an existing different owner', async () => {
        sqlite.exec("UPDATE po_poem_lines SET device='someone-else'");
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(legacy())));
        expect((await worker.fetch(req(), env)).status).toBe(503);
        expect(sqlite.prepare('SELECT device FROM po_poem_lines').get().device).toBe('someone-else');
    });
    it('holds a durable lease across overlapping requests and retries after upstream failure', async () => {
        let reject!: (reason: Error) => void;
        const fetcher = vi.fn(() => new Promise<Response>((_, no) => { reject = no; })); vi.stubGlobal('fetch', fetcher);
        const first = worker.fetch(req(), env);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        expect((await worker.fetch(req(), env)).status).toBe(202);
        reject(new Error('offline')); expect((await first).status).toBe(503);
        expect((await worker.fetch(req(), env)).status).toBe(202);
        sqlite.exec('UPDATE po_archive_recovery SET retry_at=0');
        fetcher.mockImplementation(async () => Response.json(legacy()));
        expect(await (await worker.fetch(req(), env)).json()).toMatchObject({ completed: true });
    });
    it('does not run recovery from GET; keeps the ended-event gate and CORS', async () => {
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        expect((await worker.fetch(new Request('https://bifang.test/po/poem/feed?device=device-a'), env)).status).toBe(200);
        expect(fetcher).not.toHaveBeenCalled(); expect(record()).toBeUndefined();
        expect((await worker.fetch(new Request('https://bifang.test/po/poem/start', { method: 'POST' }), env)).status).toBe(410);
        const preflight = await worker.fetch(new Request('https://bifang.test/po/poem/recover-ownership', { method: 'OPTIONS' }), env);
        expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
    it('requires imported archive metadata and rejects reserved identities', async () => {
        vi.stubGlobal('fetch', vi.fn());
        expect((await worker.fetch(req('signal-seed'), env)).status).toBe(400);
        sqlite.exec('DELETE FROM po_archive_manifest');
        expect((await worker.fetch(req(), env)).status).toBe(503); expect(fetch).not.toHaveBeenCalled();
    });
});
