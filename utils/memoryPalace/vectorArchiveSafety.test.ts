import { afterEach, describe, expect, it, vi } from 'vitest';
import { vectorizeAndStore, updateStoredMemoryNode, rebuildAllVectors } from './vectorStore';
import { MemoryNodeDB, MemoryVectorDB } from './db';
import { buildAutoArchiveFragments, mergePalaceFragmentsIntoMemories } from './pipeline';
import type { MemoryNode } from './types';

const config = { baseUrl: 'https://test.invalid', apiKey: 'test', model: 'test', dimensions: 2 };
function node(id: string, charId: string): MemoryNode {
    return { id, charId, content: id, room: 'living_room', tags: [], importance: 5, mood: '', embedded: false, createdAt: 1, lastAccessedAt: 1, accessCount: 0 };
}
function embeddings(values: number[][]) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: values.map((embedding, index) => ({ index, embedding })) }) })));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('vectorization and linked archive safety', () => {
    it('long box summary creation, editing and rebuilding all index the complete tail', async () => {
        const batches: string[][] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
            const input = JSON.parse(init.body).input as string[];
            batches.push(input);
            return { ok: true, json: async () => ({ data: input.map((text, index) => ({
                index, embedding: text.includes('末尾事实') ? [0, 1] : [1, 0],
            })) }) };
        }));
        const summary = { ...node('long-summary', 'long-box'), isBoxSummary: true,
            content: '前'.repeat(4200) + '末尾事实：钥匙交给小林。' };
        await vectorizeAndStore([summary], config, undefined, { skipDedup: true });
        expect(batches.flat().join('')).toBe(summary.content);
        expect((await MemoryVectorDB.getByMemoryId(summary.id))!.vector[1]).toBeGreaterThan(0);
        expect((await MemoryNodeDB.getById(summary.id))!.content).toBe(summary.content);
        batches.length = 0;
        const edited = summary.content + '补充的新事实。';
        await updateStoredMemoryNode(summary.id, { content: edited }, config);
        expect(batches.flat().join('')).toBe(edited);
        batches.length = 0;
        await rebuildAllVectors(summary.charId, config);
        expect(batches.flat().join('')).toBe(edited);
    });

    it('commits vectors and nodes together, and creates links only for stored nodes after dedup', async () => {
        embeddings([[1, 0], [1, 0], [0, 1]]);
        const nodes = [node('first', 'dedup-safe'), node('duplicate', 'dedup-safe'), node('second', 'dedup-safe')];
        expect(await vectorizeAndStore(nodes, config)).toEqual({ stored: 2, skipped: 1 });
        const stored = await MemoryNodeDB.getByCharId('dedup-safe');
        expect(stored.map(n => n.id).sort()).toEqual(['first', 'second']);
        expect(await MemoryVectorDB.getByMemoryId('duplicate')).toBeUndefined();
        expect(await MemoryVectorDB.getByMemoryId('first')).toBeDefined();
        const fragments = buildAutoArchiveFragments(stored, 20, true)!.fragments;
        expect(fragments.map(f => f.palaceMemoryId).sort()).toEqual(['first', 'second']);
        expect(mergePalaceFragmentsIntoMemories(fragments, fragments)).toEqual(fragments);
    });
    it('rejects incomplete vector responses without saving any extracted memory', async () => {
        embeddings([[1, 0]]);
        await expect(vectorizeAndStore([node('short-a', 'short'), node('short-b', 'short')], config)).rejects.toThrow('不完整');
        expect(await MemoryNodeDB.getByCharId('short')).toEqual([]);
    });
    it('rolls back a batch if a later record cannot be persisted, then succeeds on retry', async () => {
        embeddings([[1, 0], [0, 1]]);
        const first = node('atomic-first', 'atomic');
        const second = node('atomic-second', 'atomic');
        // Simulate an IndexedDB cloning failure after the first record was queued.
        (second as any).uncloneable = () => {};
        await expect(vectorizeAndStore([first, second], config)).rejects.toThrow();
        expect(await MemoryNodeDB.getByCharId('atomic')).toEqual([]);
        expect(await MemoryVectorDB.getByMemoryId(first.id)).toBeUndefined();
        expect(first.embedded).toBe(false);
        delete (second as any).uncloneable;
        expect(await vectorizeAndStore([first, second], config)).toEqual({ stored: 2, skipped: 0 });
        expect((await MemoryNodeDB.getByCharId('atomic')).length).toBe(2);
    });
});
