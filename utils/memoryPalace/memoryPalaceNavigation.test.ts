// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemoryPalaceApp from '../../apps/MemoryPalaceApp';
import { MemoryNodeDB } from './db';
import type { MemoryNode } from './types';

const addToast = vi.fn();
const remoteConfig = { enabled: false, initialized: false, supabaseUrl: 'https://private-project.invalid', supabaseAnonKey: 'private-key' };
const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock('../analytics', async importOriginal => ({ ...await importOriginal<typeof import('../analytics')>(), trackEvent }));
const mockChar = {
    id: 'char_nav_test',
    name: '阿泽',
    avatar: '',
    memoryPalaceEnabled: true,
    personalityStyle: 'narrative',
};

vi.mock('../../context/OSContext', () => ({
    useOS: () => ({
        activeCharacterId: mockChar.id,
        characters: [mockChar],
        updateCharacter: vi.fn(),
        setActiveCharacterId: vi.fn(),
        closeApp: vi.fn(),
        apiPresets: [],
        userProfile: { name: '小夏' },
        memoryPalaceConfig: {
            embedding: { baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm', dimensions: 4 },
            lightLLM: { baseUrl: '', apiKey: '', model: '' },
            rerank: { enabled: false, baseUrl: '', apiKey: '', model: '', topN: 5 },
            relativeTimeAnnotations: false,
        },
        updateMemoryPalaceConfig: vi.fn(),
        remoteVectorConfig: remoteConfig,
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
        tags: ['旧标签'],
        importance: 7,
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

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function findClickableByText(text: string): HTMLElement {
    const all = Array.from(host.querySelectorAll<HTMLElement>('*'));
    const match = all.reverse().find(el => el.textContent?.trim() === text || el.textContent?.includes(text));
    if (!match) throw new Error(`Element not found for text: ${text}`);
    return match;
}

beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    remoteConfig.enabled = remoteConfig.initialized = false;
    vi.unstubAllGlobals();
});

describe('MemoryPalaceApp list scroll preservation and return sync', () => {
    it('restores scrollTop and reflects edited metadata when returning from memory detail to all memories', async () => {
        const n1 = makeNode('nav_n1', '第一条夏夜散步记忆', new Date(2026, 6, 15, 12, 0).getTime());
        const n2 = makeNode('nav_n2', '第二条海边烟花记忆', new Date(2026, 6, 1, 12, 0).getTime());
        await MemoryNodeDB.saveMany([n1, n2]);

        await act(async () => {
            root.render(React.createElement(MemoryPalaceApp));
        });

        // 从角色选择进入阿泽的宫殿概览，再打开「查看全部记忆」
        await act(async () => {
            findClickableByText('阿泽').click();
        });
        await act(async () => {
            findClickableByText('查看全部记忆').click();
        });

        const allScroll = host.querySelector<HTMLDivElement>('[data-mp-scroll-view="all"]');
        expect(allScroll).not.toBeNull();
        allScroll!.scrollTop = 420;
        act(() => {
            allScroll!.dispatchEvent(new Event('scroll'));
        });

        // 点进第二条记忆详情，确认详情使用独立滚动容器且起始为 0
        await act(async () => {
            findClickableByText('第二条海边烟花记忆').click();
        });
        const detailScroll = host.querySelector<HTMLDivElement>('[data-mp-scroll-view="memory"]');
        expect(detailScroll).not.toBeNull();
        expect(detailScroll!.scrollTop).toBe(0);

        // 编辑标签并保存（不改正文，不触发 Embedding API）
        await act(async () => {
            findClickableByText('编辑').click();
        });
        const tagInput = host.querySelector<HTMLInputElement>('input[placeholder*="标签1"]')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(tagInput, '烟花, 纪念日');
            tagInput.dispatchEvent(new Event('input', { bubbles: true }));
            tagInput.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => {
            findClickableByText('保存修改').click();
            await new Promise(resolve => setTimeout(resolve, 30));
        });
        expect(addToast).toHaveBeenCalledWith('记忆设置已保存', 'success');

        // 左上角返回「全部记忆」：滚动位置仍为 420，且新标签立即展示在列表中
        await act(async () => {
            findClickableByText('← 返回 全部记忆').click();
        });

        const restoredScroll = host.querySelector<HTMLDivElement>('[data-mp-scroll-view="all"]');
        expect(restoredScroll).not.toBeNull();
        expect(restoredScroll!.scrollTop).toBe(420);
        expect(host.textContent).toContain('纪念日');
    });

    it('returns to palace overview with preserved scroll when opening a sticky note from overview', async () => {
        const pinned = makeNode(
            'nav_pinned',
             '便利贴里的约定事项',
            new Date(2026, 10, 10, 12, 0).getTime(),
            { pinnedUntil: Date.now() + 7 * 24 * 3600 * 1000 },
        );
        await MemoryNodeDB.saveMany([pinned]);

        await act(async () => {
            root.render(React.createElement(MemoryPalaceApp));
        });
        await act(async () => {
            findClickableByText('阿泽').click();
        });

        const palaceScroll = host.querySelector<HTMLDivElement>('[data-mp-scroll-view="palace"]');
        expect(palaceScroll).not.toBeNull();
        palaceScroll!.scrollTop = 260;
        act(() => {
            palaceScroll!.dispatchEvent(new Event('scroll'));
        });

        await act(async () => {
            findClickableByText('便利贴里的约定事项').click();
        });

        expect(host.textContent).toContain('← 返回 记忆宫殿');
        await act(async () => {
            findClickableByText('← 返回 记忆宫殿').click();
        });

        const restoredPalace = host.querySelector<HTMLDivElement>('[data-mp-scroll-view="palace"]');
        expect(restoredPalace).not.toBeNull();
        expect(restoredPalace!.scrollTop).toBe(260);
        expect(host.textContent).toContain('阿泽 的记忆宫殿');
    });
});

it('远程设置保留上传进度、错误原因和未尝试数量，统计只发送固定结果', async () => {
    remoteConfig.enabled = remoteConfig.initialized = true;
    await MemoryNodeDB.saveVectorizedMany(Array.from({ length: 101 }, (_, index) => {
        const node = makeNode('upload-' + index, '隐私正文', 1000);
        return { node, vector: { memoryId: node.id, charId: node.charId, vector: [1, 0], dimensions: 2 } };
    }));
    let rejectPage!: (res: Response) => void;
    const pendingPage = new Promise<Response>(resolve => { rejectPage = resolve; });
    const http = vi.fn().mockResolvedValueOnce(new Response(null, { status: 201 })).mockReturnValueOnce(pendingPage);
    vi.stubGlobal('fetch', http);
    await act(async () => { root.render(React.createElement(MemoryPalaceApp)); });
    act(() => host.querySelector<HTMLElement>('[title="记忆宫殿全局配置（API 等）"]')!.click());
    act(() => findClickableByText('同步本地向量到远程').click());
    await act(async () => { await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(2)); });
    expect(host.querySelector('[role="status"]')?.textContent).toContain('成功 50 · 失败 0 · 上传中 50 · 尚未尝试 1');
    await act(async () => {
        rejectPage(Response.json({ code: 'PGRST204', message: '隐私正文' }, { status: 400 }));
        await vi.waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringContaining('同步结束'), 'error'));
    });
    const summary = host.querySelector('[role="status"]')?.textContent;
    expect(summary).toContain('成功 50 · 失败 50 · 尚未尝试 1');
    expect(summary).toContain('PGRST204');
    expect(summary).toContain('升级 SQL');
    expect(trackEvent.mock.calls.filter(([name]) => name.includes('记忆向量'))).toEqual([
        ['同步记忆向量到云端'], ['记忆向量同步结果', { 结果: '部分完成' }],
    ]);
});
