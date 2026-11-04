import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBox, MemoryNode } from './types';

const mocks = vi.hoisted(() => ({
    responses: [] as any[],
    safeFetchJson: vi.fn(),
    getEmbeddings: vi.fn(),
}));

vi.mock('./embedding', () => ({ getEmbeddings: mocks.getEmbeddings, cosineSimilarity: vi.fn() }));

vi.mock('./supabaseVector', () => ({
    bulkSetArchived: vi.fn(async () => true),
    upsertVector: vi.fn(async () => true),
}));

vi.mock('./roomPlates', () => ({
    isPlateRoom: vi.fn(() => false),
    updatePlateFromBoxSummary: vi.fn(async () => {}),
}));

vi.mock('../safeApi', () => ({
    safeFetchJson: mocks.safeFetchJson,
    extractContent: (data: any) => data?.choices?.[0]?.message?.content || '',
    extractJson: (raw: string) => {
        try { return JSON.parse(raw); } catch { return null; }
    },
}));

import {
    hasSummaryReasoningLeak,
    regenerateEventBoxSummary,
    maybeCompressEventBoxes,
} from './eventBoxCompression';
import { EventBoxDB, MemoryNodeDB, MemoryVectorDB } from './db';
import { bulkSetArchived } from './supabaseVector';

const llmConfig = { baseUrl: 'https://llm.example/v1', apiKey: 'key', model: 'flash' };
const embeddingConfig = {
    baseUrl: 'https://embedding.example/v1', apiKey: 'emb-key', model: 'embed', dimensions: 3,
};

function memory(id: string, content: string, overrides: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id,
        charId: 'char-1',
        content,
        room: 'living_room',
        tags: [id],
        importance: 6,
        mood: 'neutral',
        embedded: true,
        createdAt: id === 'archived-1' ? 100 : 200,
        lastAccessedAt: 200,
        accessCount: 0,
        eventBoxId: 'box-1',
        archived: id.startsWith('archived'),
        ...overrides,
    };
}

function box(): EventBox {
    return {
        id: 'box-1',
        charId: 'char-1',
        name: '旧盒名',
        tags: ['旧标签'],
        summaryNodeId: 'summary-1',
        liveMemoryIds: ['live-1'],
        archivedMemoryIds: ['archived-1'],
        compressionCount: 3,
        createdAt: 1,
        updatedAt: 2,
        lastCompressedAt: 2,
        sealed: true,
    };
}

function completion(content: string) {
    return {
        choices: [{
            message: {
                content: JSON.stringify({
                    content,
                    name: '干净盒名',
                    tags: ['人物甲', '地点乙'],
                    room: 'living_room',
                    importance: 8,
                    mood: 'tender',
                }),
            },
        }],
    };
}

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
    mocks.responses.length = 0;
    mocks.safeFetchJson.mockReset();
    mocks.safeFetchJson.mockImplementation(async () => mocks.responses.shift());
    mocks.getEmbeddings.mockReset();
    mocks.getEmbeddings.mockResolvedValue([new Float32Array([1, 0, 0])]);
    vi.mocked(bulkSetArchived).mockClear();

    await EventBoxDB.save(box());
    await MemoryNodeDB.save(memory('summary-1', 'Wait, let’s count...旧坏总结', {
        isBoxSummary: true,
        archived: false,
    }));
    await MemoryNodeDB.save(memory('archived-1', '第一条归档原始记忆'));
    await MemoryNodeDB.save(memory('live-1', '第二条活跃原始记忆', { archived: false }));
    await MemoryVectorDB.save({ memoryId: 'summary-1', charId: 'char-1', vector: new Float32Array([0, 1, 0]), dimensions: 3, model: 'embed' });
});

describe('hasSummaryReasoningLeak', () => {
    it('识别截图中的字数计算过程，但不误伤单个普通英文短语', () => {
        expect(hasSummaryReasoningLeak(
            "Wait, let's count: Paragraph 1: 31 chars. Still too long. Need to get under 700.",
        )).toBe(true);
        expect(hasSummaryReasoningLeak('那天他说「Let’s count together」，我笑了。')).toBe(false);
    });
});

describe('regenerateEventBoxSummary', () => {
    it('精简后仍超目标时完整保存、向量化，召回也包含末尾事实', async () => {
        const longSummary = '压缩后仍然超长'.repeat(150) + '末尾事实：我把钥匙交给了小林。';
        mocks.responses.push(completion('完整记忆'.repeat(400)), {
            choices: [{ message: { content: longSummary } }],
        });
        const result = await regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色甲');
        expect(result.summary.content).toBe(longSummary);
        expect(mocks.getEmbeddings).toHaveBeenCalledWith([longSummary], embeddingConfig);
        expect((await MemoryNodeDB.getById('summary-1'))?.content).toBe(longSummary);
        expect((await MemoryNodeDB.getById('live-1'))?.archived).toBe(true);
        expect((await MemoryNodeDB.getById('archived-1'))?.content).toBe('第一条归档原始记忆');
        const { expandAndFormat } = await import('./formatter');
        const recalled = await expandAndFormat([{ node: result.summary, finalScore: 1 } as any], 'char-1');
        expect(recalled).toContain(longSummary);
    });

    it('二次输出被 token 上限截断时保留首次完整长正文', async () => {
        const content = '长回忆'.repeat(400) + '完整结尾。';
        mocks.responses.push(completion(content), {
            choices: [{ finish_reason: 'length', message: { content: '被截断的一半' } }],
        });
        const result = await regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色甲');
        expect(result.summary.content).toBe(content);
    });

    it('首次输出未完成时拒绝写入，即使返回的 JSON 恰好可解析', async () => {
        const truncated = completion('未完成的正文');
        (truncated.choices[0] as any).finish_reason = 'length';
        mocks.responses.push(truncated, truncated);
        await expect(regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色甲'))
            .rejects.toThrow('原内容已保留');
        expect(mocks.getEmbeddings).not.toHaveBeenCalled();
        expect((await MemoryNodeDB.getById('live-1'))?.archived).toBe(false);
        expect((await MemoryNodeDB.getById('summary-1'))?.content).toContain('旧坏总结');
    });

    it('用全部 archived + live 原文重做，覆盖同一 summary 并强制重新向量化', async () => {
        mocks.responses.push(completion('这是重新整合后的干净回忆。'));

        const result = await regenerateEventBoxSummary(
            'box-1', llmConfig, embeddingConfig, '角色甲', '用户乙',
        );

        expect(result.sourceCount).toBe(2);
        expect(result.summary.id).toBe('summary-1');
        expect(result.summary.content).toBe('这是重新整合后的干净回忆。');
        expect(result.summary.embedded).toBe(true);
        expect(mocks.getEmbeddings).toHaveBeenCalledTimes(1);
        expect(await MemoryNodeDB.getById('summary-1')).toMatchObject({
            id: 'summary-1',
            content: '这是重新整合后的干净回忆。',
            embedded: true,
        });

        const requestBody = JSON.parse(mocks.safeFetchJson.mock.calls[0][1].body);
        const sourcePrompt = requestBody.messages[1].content as string;
        expect(sourcePrompt).toContain('第一条归档原始记忆');
        expect(sourcePrompt).toContain('第二条活跃原始记忆');
        expect(sourcePrompt).not.toContain('旧坏总结');

        const savedBox = (await EventBoxDB.getById('box-1'))!;
        expect(savedBox.sealed).toBe(true);
        expect(savedBox.compressionCount).toBe(4);
        expect(savedBox.liveMemoryIds).toEqual([]);
        expect(savedBox.archivedMemoryIds).toEqual(['archived-1', 'live-1']);
        expect((await MemoryNodeDB.getById('live-1'))?.archived).toBe(true);
        expect(savedBox.name).toBe('干净盒名');
        expect(savedBox.tags).toEqual(['人物甲', '地点乙']);
    });

    it('拒绝推理泄漏并自动重试一次，只向量化干净结果', async () => {
        mocks.responses.push(
            completion("Wait, let's count: Paragraph 1: 31 chars. Still too long."),
            completion('第二次返回的干净回忆。'),
        );

        const result = await regenerateEventBoxSummary(
            'box-1', llmConfig, embeddingConfig, '角色甲', '用户乙',
        );

        expect(mocks.safeFetchJson).toHaveBeenCalledTimes(2);
        expect(mocks.getEmbeddings).toHaveBeenCalledTimes(1);
        expect(result.summary.content).toBe('第二次返回的干净回忆。');
    });

    it('Embedding 失败时不覆盖旧 summary 和事件盒元数据', async () => {
        mocks.responses.push(completion('本来准备写入的新回忆。'));
        mocks.getEmbeddings.mockRejectedValueOnce(new Error('embedding unavailable'));

        await expect(regenerateEventBoxSummary(
            'box-1', llmConfig, embeddingConfig, '角色甲', '用户乙',
        )).rejects.toThrow('embedding unavailable');

        expect((await MemoryNodeDB.getById('summary-1'))?.content).toBe('Wait, let’s count...旧坏总结');
        expect((await EventBoxDB.getById('box-1'))?.name).toBe('旧盒名');
        expect((await MemoryNodeDB.getById('live-1'))?.archived).toBe(false);
    });

    it('复现 4 归档 + 8 活节点：成功后活 0 归档 12 并封盒，再重做不重复计数', async () => {
        const sources = Array.from({ length: 12 }, (_, i) => memory(`source-${i}`, `原始回忆 ${i}`, { archived: i < 4 }));
        for (const node of sources) await MemoryNodeDB.save(node);
        await EventBoxDB.save({ ...box(), sealed: false, compressionCount: 1,
            liveMemoryIds: sources.slice(4).map(n => n.id), archivedMemoryIds: sources.slice(0, 4).map(n => n.id) });
        const remote = { enabled: true, initialized: true, supabaseUrl: 'https://test.invalid', supabaseAnonKey: 'test' };
        // No real network: the summary upload and archive sync are both mocked.
        mocks.responses.push(completion('全部十二条的总结。'), completion('再次修订总结。'));
        const first = await regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色', '用户', remote);
        expect(first.sourceCount).toBe(12);
        expect(first.box).toMatchObject({ liveMemoryIds: [], sealed: true, compressionCount: 2 });
        expect(first.box.archivedMemoryIds).toHaveLength(12);
        expect((await Promise.all(sources.map(n => MemoryNodeDB.getById(n.id)))).every(n => n?.archived)).toBe(true);
        expect(bulkSetArchived).toHaveBeenCalledWith(remote, expect.arrayContaining(sources.map(n => n.id)), true);
        const second = await regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色');
        expect(second.box.compressionCount).toBe(2);
        expect(second.box.archivedMemoryIds).toHaveLength(12);
    });

    it('API 等待期间新进的节点不归档，不进入本次总结', async () => {
        mocks.responses.push(completion('只总结原来的两条。'));
        mocks.getEmbeddings.mockImplementationOnce(async () => {
            await MemoryNodeDB.save(memory('late', '后来加入的回忆', { archived: false }));
            const fresh = (await EventBoxDB.getById('box-1'))!;
            await EventBoxDB.save({ ...fresh, sealed: false, liveMemoryIds: [...fresh.liveMemoryIds, 'late'] });
            return [new Float32Array([1, 0, 0])];
        });
        const result = await regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色');
        expect(result.box.liveMemoryIds).toEqual(['late']);
        expect(result.box.sealed).toBe(false);
        expect((await MemoryNodeDB.getById('late'))?.archived).toBe(false);
        expect(result.sourceCount).toBe(2);
    });

    it('没有旧总结也能手动整合，重复成员只归档一次，少于阈值不封盒', async () => {
        await EventBoxDB.save({ ...box(), summaryNodeId: null, sealed: false, compressionCount: 0,
            liveMemoryIds: ['live-1', 'live-1'], archivedMemoryIds: [] });
        mocks.responses.push(completion('首次整合。'));
        const result = await regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色');
        expect(result.sourceCount).toBe(1);
        expect(result.box).toMatchObject({ liveMemoryIds: [], archivedMemoryIds: ['live-1'], sealed: false, compressionCount: 1 });
        expect(await MemoryVectorDB.getByMemoryId(result.summary.id)).toBeDefined();
    });

    it.each(['llm', 'vector'])('%s 返回无效结果时不归档、不覆盖总结', async stage => {
        if (stage === 'vector') {
            mocks.responses.push(completion('向量无效，不能保存。'));
            mocks.getEmbeddings.mockResolvedValueOnce([]);
        } else mocks.responses.push({}, {});
        await expect(regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色')).rejects.toThrow();
        expect((await MemoryNodeDB.getById('summary-1'))?.content).toContain('旧坏总结');
        expect((await MemoryNodeDB.getById('live-1'))?.archived).toBe(false);
        expect((await EventBoxDB.getById('box-1'))?.compressionCount).toBe(3);
        expect(bulkSetArchived).not.toHaveBeenCalled();
    });

    it.each(['edit', 'unbind', 'delete', 'delete-box', 'other-summary'])('并发 %s 拒绝旧结果，不改原总结和向量', async action => {
        mocks.responses.push(completion('不得写入的旧快照总结。'));
        mocks.getEmbeddings.mockImplementationOnce(async () => {
            const fresh = (await EventBoxDB.getById('box-1'))!;
            if (action === 'edit') await MemoryNodeDB.save({ ...(await MemoryNodeDB.getById('live-1'))!, content: '已编辑' });
            if (action === 'unbind') await EventBoxDB.save({ ...fresh, liveMemoryIds: [] });
            if (action === 'delete') await MemoryNodeDB.delete('live-1');
            if (action === 'delete-box') await EventBoxDB.delete('box-1');
            if (action === 'other-summary') await EventBoxDB.save({ ...fresh, lastCompressedAt: 999 });
            return [new Float32Array([1, 0, 0])];
        });
        await expect(regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色')).rejects.toThrow();
        expect((await MemoryNodeDB.getById('summary-1'))?.content).toContain('旧坏总结');
        expect(Array.from((await MemoryVectorDB.getByMemoryId('summary-1'))!.vector)).toEqual([0, 1, 0]);
        expect(bulkSetArchived).not.toHaveBeenCalled();
    });

    it('事务最后写盒子失败时，总结、向量和已排队的归档全部回滚', async () => {
        mocks.responses.push(completion('不得部分保存的总结。'));
        const put = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
            if (this.name === 'event_boxes') throw new Error('模拟存储失败');
            return put.call(this, value, key);
        });
        await expect(regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色')).rejects.toThrow('模拟存储失败');
        expect((await MemoryNodeDB.getById('summary-1'))?.content).toContain('旧坏总结');
        expect((await MemoryNodeDB.getById('live-1'))?.archived).toBe(false);
        expect((await EventBoxDB.getById('box-1'))?.liveMemoryIds).toEqual(['live-1']);
        expect(Array.from((await MemoryVectorDB.getByMemoryId('summary-1'))!.vector)).toEqual([0, 1, 0]);
    });

    it('手动整合期间阻止重复点击和自动压缩，失败后释放锁允许重试', async () => {
        let release!: () => void;
        let started!: () => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        const pending = new Promise<void>(resolve => { release = resolve; });
        mocks.safeFetchJson.mockImplementationOnce(async () => { started(); await pending; return completion('单次整合。'); });
        mocks.getEmbeddings.mockRejectedValueOnce(new Error('embedding failed'));
        const first = regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色');
        const rejected = expect(first).rejects.toThrow('embedding failed');
        await entered;
        try {
            await expect(regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色')).rejects.toThrow('正在整合');
            expect(await maybeCompressEventBoxes(['box-1'], llmConfig, embeddingConfig, '角色')).toEqual({ compressed: 0, skipped: 1 });
            expect(mocks.safeFetchJson).toHaveBeenCalledTimes(1);
        } finally { release(); }
        await rejected;
        mocks.responses.push(completion('重试成功。'));
        expect((await regenerateEventBoxSummary('box-1', llmConfig, embeddingConfig, '角色')).summary.content).toBe('重试成功。');
    });
});

describe('automatic compression rate-limit safety', () => {
    it('embedding failure leaves summary, vectors and live nodes unchanged', async () => {
        const current = box(); current.liveMemoryIds = ['live-1', 'live-2', 'live-3', 'live-4']; current.sealed = false;
        await EventBoxDB.save(current);
        for (const id of current.liveMemoryIds) await MemoryNodeDB.save(memory(id, '待压缩的原始记忆 ' + id, { archived: false }));
        mocks.responses.push(completion('新的摘要，不应在向量失败时保存。'));
        mocks.getEmbeddings.mockRejectedValue(new Error('Embedding API error 429'));
        const result = await maybeCompressEventBoxes([current.id], llmConfig, embeddingConfig, '角色甲', '用户乙');
        expect(result.compressed).toBe(0);
        expect((await MemoryNodeDB.getById('summary-1'))?.content).toContain('旧坏总结');
        expect((await EventBoxDB.getById(current.id))?.liveMemoryIds).toEqual(current.liveMemoryIds);
        for (const id of current.liveMemoryIds) expect((await MemoryNodeDB.getById(id))?.archived).toBe(false);
    });
});
