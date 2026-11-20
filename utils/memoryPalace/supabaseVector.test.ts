import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from '../db';
import { MemoryNodeDB } from './db';
import { vectorSearch } from './vectorSearch';
import {
    fetchRemoteByRoom, getVectorCount, getVectorSyncProgress, invalidateRemoteCoverage,
    readUpgrade, remoteCoversLocal, searchVectors, subscribeVectorSync, upgradeRemoteVectors, syncLocalToRemote, testConnection, upsertVectorBatch,
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

    it('表可读但检索函数缺失时准确报告', async () => {
        const http = vi.fn().mockResolvedValueOnce(Response.json([]))
            .mockResolvedValueOnce(Response.json({ code: '42703' }, { status: 400 }));
        vi.stubGlobal('fetch', http);
        expect(await testConnection(config)).toMatchObject({ ok: false, message: expect.stringContaining('检索函数不可用') });
        expect(http.mock.calls[1][0]).toContain('/rpc/match_vectors?select=');
    });

    it('逐页确认，失败留存进度；重试复用存量字节与元数据，按原 ID 回填', async () => {
        await MemoryNodeDB.saveVectorizedMany(Array.from({ length: 101 }, (_, i) => entry('m' + i)));
        let writes = 0;
        const remote = new Map<string, any>();
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe(config.supabaseUrl + '/rest/v1/memory_vectors');
            if (++writes === 2) return Response.json({ code: '42501', message: 'private text' }, { status: 403 });
            for (const row of JSON.parse(String(init.body))) remote.set(row.memory_id, row);
            return new Response(null, { status: 201 });
        }));
        const ack: number[] = [];
        const unsub = subscribeVectorSync(() => ack.push(getVectorSyncProgress(config)!.synced));
        try {
            expect(await syncLocalToRemote(config)).toMatchObject({
                running: false, total: 101, synced: 50, failed: 50, reason: expect.stringContaining('42501'),
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

describe('零操作兼容原版 Supabase', () => {
    it('使用旧表和旧 RPC 回填与召回扩展字段，保留已有模型、向量和其他设备的修改', async () => {
        const cfg = { ...config, supabaseUrl: 'https://legacy.invalid' };
        const existing = { memory_id: 'old', char_id: 'char', content: node.content, model: 'remote-model', vector: '[0.1,0.2]' };
        const rows = new Map<string, any>([['old', existing], ['edited', { ...existing, memory_id: 'edited', content: '其他设备的新正文' }]]);
        await MemoryNodeDB.saveVectorizedMany(['old', 'edited', 'missing'].map(entry));
        const http = vi.fn(async (url: string, init: RequestInit = {}) => {
            const u = new URL(url), fields = u.searchParams.get('select') || '';
            if (u.pathname.includes('/rpc/')) {
                if (fields) return Response.json([]);
                return Response.json([{ memory_id: 'old', char_id: 'char', content: node.content, similarity: 1 }]);
            }
            if (fields.includes('entities')) return Response.json({ code: '42703' }, { status: 400 });
            if (u.searchParams.get('limit') === '0') return Response.json([]);
            if (init.method === 'PATCH') {
                expect(u.searchParams.get('memory_id')).toBe('eq.old');
                const patch = JSON.parse(String(init.body));
                expect(Object.keys(patch)).toEqual(['model']);
                Object.assign(existing, patch);
                return Response.json([{ memory_id: 'old' }]);
            }
            if (init.method === 'POST') {
                const batch = JSON.parse(String(init.body));
                for (const r of batch) {
                    expect(r).not.toHaveProperty('entities');
                    expect(r.tags).toEqual(node.tags);
                    rows.set(r.memory_id, r);
                }
                return new Response(null, { status: 201 });
            }
            return Response.json([...rows.values()]);
        });
        vi.stubGlobal('fetch', http);
        expect(await testConnection(cfg)).toMatchObject({ ok: true, message: expect.stringContaining('兼容') });
        const progress = vi.fn();
        await upgradeRemoteVectors(cfg, new AbortController().signal, progress);
        expect(progress).toHaveBeenLastCalledWith(3, 3);
        expect(readUpgrade(cfg)).toMatchObject({ done: true, divergent: true });
        expect(rows.get('old').vector).toBe('[0.1,0.2]');
        expect(rows.get('old').model).toContain('remote-model');
        expect(rows.get('edited').content).toBe('其他设备的新正文');
        expect(rows.get('missing').vector).toBe('[0.25,0.5]');
        const hits = await searchVectors(cfg, [1, 0], 'char');
        expect(hits[0].node).toMatchObject({ entities: node.entities, groupName: node.groupName,
            relativeTimeAnchor: node.relativeTimeAnchor, digestedAt: 123 });
        const calls = http.mock.calls.length;
        await upgradeRemoteVectors(cfg, new AbortController().signal, progress);
        expect(http).toHaveBeenCalledTimes(calls);
    });

    it('从上次已确认页继续，停用时不发请求', async () => {
        const cfg = { ...config, supabaseUrl: 'https://resume.invalid' };
        const ids = Array.from({ length: 101 }, (_, i) => 'resume-' + String(i).padStart(3, '0'));
        await MemoryNodeDB.saveVectorizedMany(ids.map(entry));
        const batches: string[][] = [];
        const http = vi.fn(async (url: string, init: RequestInit = {}) => {
            if (init.method !== 'POST') return Response.json([]);
            batches.push(JSON.parse(String(init.body)).map((r: any) => r.memory_id));
            return new Response(null, { status: batches.length === 2 ? 503 : 201 });
        });
        vi.stubGlobal('fetch', http);
        await upgradeRemoteVectors({ ...cfg, enabled: false }, new AbortController().signal, vi.fn());
        expect(http).not.toHaveBeenCalled();
        await expect(upgradeRemoteVectors(cfg, new AbortController().signal, vi.fn())).rejects.toThrow('503');
        expect(readUpgrade(cfg)).toMatchObject({ last: 'resume-049' });
        await upgradeRemoteVectors(cfg, new AbortController().signal, vi.fn());
        expect(batches.map(b => b[0])).toEqual(['resume-000','resume-050','resume-050','resume-100']);
    });
});
