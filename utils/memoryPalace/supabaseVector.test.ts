import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from '../db';
import { MemoryNodeDB } from './db';
import { vectorSearch } from './vectorSearch';
import {
    fetchRemoteByRoom, getVectorCount, getVectorSyncProgress, invalidateRemoteCoverage,
    remoteCoversLocal, subscribeVectorSync, syncLocalToRemote, testConnection, upsertVectorBatch,
} from './supabaseVector';
import type { MemoryNode } from './types';

const config = { supabaseUrl: 'https://example.invalid', supabaseAnonKey: 'example', enabled: true, initialized: true };
const node: MemoryNode = {
    id: 'sample', charId: 'char', content: '原文', embedded: true, room: 'study', importance: 5,
    createdAt: 10, lastAccessedAt: 10, accessCount: 0, tags: [], mood: '',
    entities: [{ name: '样例' }], relativeTimeAnchor: { dateKey: '2026-11-19', source: 'message' },
    groupId: 'group', groupName: '群名', digestedAt: 123,
};

function entry(id: string) {
    return {
        node: { ...node, id },
        vector: { memoryId: id, charId: node.charId, vector: new Float32Array([0.25, 0.5]), dimensions: 2, model: 'original' },
    };
}
beforeEach(async () => {
    localStorage.clear();
    invalidateRemoteCoverage();
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['memory_nodes', 'memory_vectors'], 'readwrite');
        tx.objectStore('memory_nodes').clear();
        tx.objectStore('memory_vectors').clear();
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('远程向量', () => {
    it('区分真实零、失败响应、无计数头与断网', async () => {
        const http = vi.fn()
            .mockResolvedValueOnce(new Response(null, { headers: { 'content-range': '*/0' } }))
            .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'content-range': '*/0' } }))
            .mockResolvedValueOnce(new Response(null))
            .mockRejectedValueOnce(new TypeError('offline'));
        vi.stubGlobal('fetch', http);
        expect(await getVectorCount(config)).toBe(0);
        for (let i = 0; i < 3; i++) expect(await getVectorCount(config)).toBeNull();
    });

    it('表可读但 RPC 缺字段时提示升级', async () => {
        const http = vi.fn().mockResolvedValueOnce(Response.json([]))
            .mockResolvedValueOnce(Response.json({ code: '42703' }, { status: 400 }));
        vi.stubGlobal('fetch', http);
        expect(await testConnection(config)).toMatchObject({ ok: false, message: expect.stringContaining('升级 SQL') });
        expect(http.mock.calls[1][0]).toContain('/rpc/match_vectors?select=');
    });

    it('逐页确认，失败留存进度；重试复用存量字节与元数据，按原 ID 回填', async () => {
        await MemoryNodeDB.saveVectorizedMany(Array.from({ length: 101 }, (_, i) => entry('m' + i)));
        let writes = 0;
        const remote = new Map<string, any>();
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe(config.supabaseUrl + '/rest/v1/memory_vectors');
            if (++writes === 2) return Response.json({ code: 'PGRST204', message: 'private text' }, { status: 400 });
            for (const row of JSON.parse(String(init.body))) remote.set(row.memory_id, row);
            return new Response(null, { status: 201 });
        }));
        const ack: number[] = [];
        const unsub = subscribeVectorSync(() => ack.push(getVectorSyncProgress(config)!.synced));
        try {
            expect(await syncLocalToRemote(config)).toMatchObject({
                running: false, total: 101, synced: 50, failed: 50, reason: expect.stringContaining('PGRST204'),
            });
            expect(ack).toContain(50);
            expect(getVectorSyncProgress(config)?.reason).not.toContain('private text');
            expect(await remoteCoversLocal(config, 'char')).toBe(false);
            expect(await syncLocalToRemote(config)).toMatchObject({ total: 101, synced: 101, failed: 0, reason: '' });
        } finally { unsub(); }
        expect(remote.size).toBe(101);
        const row = remote.get('m1');
        expect(row).toMatchObject({
            vector: '[0.25,0.5]', dimensions: 2, model: 'original', entities: node.entities,
            relative_time_anchor: node.relativeTimeAnchor, group_id: node.groupId, group_name: node.groupName, digested_at: 123,
        });
        vi.stubGlobal('fetch', vi.fn(async (url: string) =>
            Response.json(url.includes('select=memory_id&') ? [...remote.keys()].map(memory_id => ({ memory_id })) : [row])));
        expect(await remoteCoversLocal(config, 'char')).toBe(true);
        expect((await fetchRemoteByRoom(config, 'char', 'study'))[0]).toMatchObject({ ...node, id: 'm1' });
    });

    it('同数量不同 ID 时直接命中本地向量，其他角色的纯云端召回仍可用', async () => {
        await MemoryNodeDB.saveVectorizedMany([entry('local-only')]);
        const http = vi.fn(async (url: string) => {
            if (url.includes('rpc/match_vectors')) return Response.json([{ memory_id: 'other', char_id: 'remote-only', similarity: 1, entities: node.entities }]);
            return Response.json(url.includes('memory_id=gt.') ? [] : [{ memory_id: 'stale' }]);
        });
        vi.stubGlobal('fetch', http);
        const hits = await vectorSearch([0.25, 0.5], 'char', 0.3, 20, config);
        expect(hits.map(hit => hit.node.id)).toEqual(['local-only']);
        expect(http.mock.calls.every(([url]) => !url.includes('/rpc/'))).toBe(true);
        const remote = await vectorSearch([0.25, 0.5], 'remote-only', 0.3, 20, config);
        expect(remote[0].node).toMatchObject({ id: 'other', entities: node.entities });
    });

    it('自动写入失败后即使旧 ID 存在也优先本地；更换项目独立核对', async () => {
        const item = entry('m');
        await MemoryNodeDB.saveVectorizedMany([item]);
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) =>
            init.method === 'POST' ? new Response(null, { status: 403 }) : Response.json([{ memory_id: 'm' }])));
        expect(await remoteCoversLocal(config, 'char')).toBe(true);
        expect(await upsertVectorBatch(config, [{ ...item.vector, node: item.node }])).toBe(false);
        expect(await remoteCoversLocal(config, 'char')).toBe(false);
        expect(await remoteCoversLocal({ ...config, supabaseUrl: 'https://other.invalid' }, 'char')).toBe(true);
    });
});
