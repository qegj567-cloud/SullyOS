// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemoryPalaceApp from '../../apps/MemoryPalaceApp';
import { MemoryNodeDB } from './db';
import { resolveLinkedArchives } from './linkedArchive';
import {
    applyPartialDatePatchToNode,
    batchUpdateMemoryDates,
    parsePartialDateDraft,
    syncLinkedArchiveFragmentDates,
} from './memoryDateEdit';
import type { MemoryNode } from './types';

const addToast = vi.fn();
const updateCharacter = vi.fn();
const mockChar = {
    id: 'char_date_edit_test',
    name: '阿泽',
    avatar: '',
    memoryPalaceEnabled: true,
    personalityStyle: 'narrative',
    memories: [
        { id: 'frag_linked', date: '2026-11-12', summary: '7.15当晚去海边', mood: 'palace', palaceMemoryId: 'date_n1' },
        { id: 'frag_legacy', date: '2026-11-12', summary: '旧版无绑定记录', mood: 'palace' },
    ],
};

vi.mock('../../context/OSContext', () => ({
    useOS: () => ({
        activeCharacterId: mockChar.id,
        characters: [mockChar],
        updateCharacter,
        setActiveCharacterId: vi.fn(),
        closeApp: vi.fn(),
        apiPresets: [],
        userProfile: { name: '小夏' },
        memoryPalaceConfig: {
            embedding: { baseUrl: '', apiKey: '', model: '', dimensions: 4 },
            lightLLM: { baseUrl: '', apiKey: '', model: '' },
            rerank: { enabled: false, baseUrl: '', apiKey: '', model: '', topN: 5 },
            relativeTimeAnnotations: false,
        },
        updateMemoryPalaceConfig: vi.fn(),
        remoteVectorConfig: { enabled: false, initialized: false, supabaseUrl: '', supabaseAnonKey: '' },
        updateRemoteVectorConfig: vi.fn(),
        addToast,
        apiConfig: { baseUrl: '', apiKey: '', model: '' },
        characterGroups: [],
        groups: [],
        realtimeConfig: {},
    }),
}));

vi.mock('../../components/os/TokenImg', () => ({
    default: () => null,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeNode(id: string, content: string, createdAt: number, extra: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id,
        charId: mockChar.id,
        content,
        room: 'bedroom',
        tags: [],
        importance: 8,
        mood: 'tender',
        embedded: true,
        createdAt,
        lastAccessedAt: createdAt,
        accessCount: 0,
        pinnedUntil: null,
        eventBoxId: null,
        ...extra,
    };
}

describe('memoryDateEdit partial year/month/day replacement', () => {
    it('replaces only specified fields while preserving original fields and intra-day time order', () => {
        const firstTs = new Date(2026, 6, 1, 19, 1, 15, 200).getTime();   // 2026-07-01 19:01:15.200
        const secondTs = new Date(2026, 6, 15, 19, 2, 15, 200).getTime(); // 2026-07-15 19:02:15.200

        const yearOnlyPatch = parsePartialDateDraft({ year: '2025', month: '', day: '' });
        const updatedFirst = applyPartialDatePatchToNode(makeNode('a', '7.1', firstTs), yearOnlyPatch);
        const updatedSecond = applyPartialDatePatchToNode(makeNode('b', '7.15', secondTs), yearOnlyPatch);

        const d1 = new Date(updatedFirst.createdAt);
        const d2 = new Date(updatedSecond.createdAt);
        expect([d1.getFullYear(), d1.getMonth() + 1, d1.getDate(), d1.getHours(), d1.getMinutes()]).toEqual([2025, 7, 1, 19, 1]);
        expect([d2.getFullYear(), d2.getMonth() + 1, d2.getDate(), d2.getHours(), d2.getMinutes()]).toEqual([2025, 7, 15, 19, 2]);
        expect(updatedFirst.lastAccessedAt).toBe(updatedFirst.createdAt);

        // 已被检索过的记忆保留独立的 lastAccessedAt
        const accessedLater = new Date(2026, 10, 12, 20, 0).getTime();
        const accessedNode = makeNode('c', '已访问记忆', firstTs, {
            accessCount: 3,
            lastAccessedAt: accessedLater,
        });
        const updatedAccessed = applyPartialDatePatchToNode(accessedNode, yearOnlyPatch);
        expect(updatedAccessed.lastAccessedAt).toBe(accessedLater);
    });

    it('rejects invalid inputs and rolls back whole batch if any selected node produces a non-existent calendar date', async () => {
        expect(() => parsePartialDateDraft({ year: '25', month: '', day: '' })).toThrow('4 位数字');
        expect(() => parsePartialDateDraft({ year: '', month: '2', day: '30' })).toThrow('2 月没有 30 日');
        expect(() => parsePartialDateDraft({ year: '', month: '', day: '' }, { requireAtLeastOne: true })).toThrow('至少填写');

        const leapDay = makeNode('leap_node', '闰日记忆', new Date(2024, 1, 29, 12, 0).getTime(), { charId: 'char_unit_batch_test' });
        const normalDay = makeNode('normal_node', '普通记忆', new Date(2024, 6, 15, 12, 0).getTime(), { charId: 'char_unit_batch_test' });
        await MemoryNodeDB.saveMany([leapDay, normalDay]);

        const patch2025 = parsePartialDateDraft({ year: '2025', month: '', day: '' });
        await expect(batchUpdateMemoryDates(['leap_node', 'normal_node'], patch2025)).rejects.toThrow('2025 年 2 月 29 日');

        // 原子校验：两条记录都不应被写入半截修改
        const afterNormal = await MemoryNodeDB.getById('normal_node');
        expect(new Date(afterNormal!.createdAt).getFullYear()).toBe(2024);
    });

    it('syncs explicit palaceMemoryId archive dates while leaving unlinked archives untouched', async () => {
        const updatedNode = makeNode('date_n1', '7.15当晚去海边', new Date(2025, 6, 15, 12, 0).getTime());
        await MemoryNodeDB.saveMany([updatedNode]);

        const synced = syncLinkedArchiveFragmentDates(mockChar.memories, [updatedNode]);
        expect(synced).not.toBeNull();
        expect(synced![0].date).toBe('2025-07-15');
        expect(synced![1]).toBe(mockChar.memories[1]);

        const resolved = await resolveLinkedArchives(mockChar.id, mockChar.memories);
        expect(resolved[0].date).toBe('2025-07-15');
        expect(resolved[1]).toBe(mockChar.memories[1]);
    });
});

describe('MemoryPalaceApp single and multi-select partial date UI', () => {
    let host: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    const findClickable = (text: string): HTMLElement => {
        const all = Array.from(host.querySelectorAll<HTMLElement>('*'));
        const match = all.reverse().find(el => el.textContent?.trim() === text || el.textContent?.includes(text));
        if (!match) throw new Error(`Element not found: ${text}`);
        return match;
    };

    const fillInput = async (ariaLabel: string, value: string) => {
        const input = host.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`);
        if (!input) throw new Error(`Input not found: ${ariaLabel}`);
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        await MemoryNodeDB.delete('date_n1').catch(() => {});
        await MemoryNodeDB.delete('date_n2').catch(() => {});
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    it('supports batch year-only replacement in all-memories view and single-item month/day edit without Embedding API', async () => {
        // 模拟外部搬入缺少四位年份而落到今天的 2 条记忆（月日暂为 11/12 与 7/1）
        const n1 = makeNode('date_n1', '7.15当晚去看海', new Date(2026, 10, 12, 19, 1).getTime());
        const n2 = makeNode('date_n2', '7.1我主动出击', new Date(2026, 6, 1, 19, 2).getTime(), { room: 'windowsill' });
        await MemoryNodeDB.saveMany([n1, n2]);

        await act(async () => {
            root.render(React.createElement(MemoryPalaceApp));
        });
        await act(async () => {
            findClickable('阿泽').click();
        });
        await act(async () => {
            findClickable('查看全部记忆').click();
        });

        // 1. 多选全选，只填「年 = 2025」，月日留空保留各自原值
        await act(async () => {
            findClickable('选择').click();
        });
        await act(async () => {
            findClickable('全选').click();
        });
        await act(async () => {
            findClickable('改日期').click();
        });
        await fillInput('批量记忆年份', '2025');
        await act(async () => {
            findClickable('应用日期 (2)').click();
            await new Promise(resolve => setTimeout(resolve, 30));
        });

        expect(addToast).toHaveBeenCalledWith('已修改 2 条记忆的日期', 'success');
        expect(host.textContent).toContain('2025/11/12');
        expect(host.textContent).toContain('2025/7/1');

        // 2. 点进第一条记忆，单条编辑只改「月 = 7、日 = 15」，年份留空保留 2025（且未配 Embedding API 也能保存）
        await act(async () => {
            findClickable('7.15当晚去看海').click();
        });
        await act(async () => {
            findClickable('编辑').click();
        });
        await fillInput('单条记忆月份', '7');
        await fillInput('单条记忆日期', '15');
        await act(async () => {
            findClickable('保存修改').click();
            await new Promise(resolve => setTimeout(resolve, 30));
        });
        await act(async () => {
            findClickable('← 返回 全部记忆').click();
        });

        expect(host.textContent).toContain('2025/7/15');
        expect(host.textContent).toContain('2025/7/1');
        expect(updateCharacter).toHaveBeenCalledWith(
            mockChar.id,
            expect.objectContaining({
                memories: expect.arrayContaining([
                    expect.objectContaining({ id: 'frag_linked', date: '2025-07-15' }),
                ]),
            }),
        );
    });
});
