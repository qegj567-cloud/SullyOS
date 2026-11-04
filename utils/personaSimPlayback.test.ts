// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import PersonaSim, { LifeLog, type SimState } from '../apps/PersonaSim';
import { DB } from './db';
import type { CharacterProfile, SimScript } from '../types';

const mocks = vi.hoisted(() => ({ useOS: vi.fn(), toast: vi.fn() }));
vi.mock('../context/OSContext', () => ({ useOS: mocks.useOS }));
vi.mock('./context', () => ({ ContextBuilder: {} }));
vi.mock('./chatContextRange', () => ({ loadCharacterContextMessages: vi.fn() }));
vi.mock('./memoryPalace/pipeline', () => ({ injectMemoryPalace: vi.fn() }));
vi.mock('./scheduleGenerator', () => ({ isScheduleFeatureOn: () => true }));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./blobRef', async importOriginal => ({
    ...await importOriginal<typeof import('./blobRef')>(), useBlobRefUrl: () => undefined,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const script: SimScript = {
    title: '雨天小剧场', summary: '雨停了。',
    beats: [
        { kind: 'lock', monologue: '第一段' },
        { kind: 'thought', monologue: '第二段', vibe: 'happy' },
        { kind: 'end' },
    ],
    buff: { label: '平静', description: '看完雨天后的平静' },
};

let host: HTMLDivElement;
let root: Root;
let character: CharacterProfile;
let pendingWrites: Promise<void>[];
const listeners = new Set<() => void>();

function button(label: string): HTMLButtonElement {
    const result = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === label);
    expect(result, `找不到按钮：${label}`).toBeDefined();
    return result!;
}

async function renderPlayer(sim: SimState = { status: 'idle' }) {
    await act(async () => root.render(React.createElement(PersonaSim, {
        targetChar: character, sim, onExit: () => root.render(null),
        openLifeLog: vi.fn(), onStart: vi.fn(), onConsumed: vi.fn(),
    })));
}

async function advance() {
    const stage = host.querySelector<HTMLDivElement>('.select-none');
    expect(stage).not.toBeNull();
    await act(async () => stage!.click());
}

function ready(startIndex = 0): SimState {
    return { status: 'ready', mode: 'daily', theme: '雨天', script, logId: 'saved-sim', startIndex };
}

beforeEach(async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    pendingWrites = [];
    listeners.clear();
    character = {
        id: 'playback-char', name: '甲',
        phoneState: { records: [], simLogs: [{
            id: 'saved-sim', mode: 'daily', theme: '雨天', title: script.title,
            summary: script.summary, timestamp: 1, beatsCount: script.beats.length, script,
            playback: { beatIndex: 0, status: 'ready' },
        }] },
    } as unknown as CharacterProfile;
    await DB.saveCharacter(character);
    mocks.useOS.mockImplementation(() => {
        React.useSyncExternalStore(listener => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        }, () => character);
        return {
        addToast: mocks.toast,
        updateCharacter: (id: string, update: (current: CharacterProfile) => Partial<CharacterProfile>) => {
            expect(id).toBe(character.id);
            character = { ...character, ...update(character) };
            pendingWrites.push(DB.saveCharacter(character));
            listeners.forEach(listener => listener());
        },
        };
    });
});

afterEach(async () => {
    await act(async () => root.unmount());
    await Promise.all(pendingWrites);
    host.remove();
    vi.clearAllMocks();
});

describe('小剧场断点播放', () => {
    it('中途退出后重读数据库，入口可选择继续当前段落或从头播放', async () => {
        await renderPlayer(ready());
        await advance();
        expect(pendingWrites).toHaveLength(2); // 包括上下文刷新，同一段也只保存一次。
        await act(async () => button('退出').click());
        await Promise.all(pendingWrites);
        character = (await DB.getAllCharacters()).find(c => c.id === character.id)!;
        expect(character.phoneState?.simLogs).toHaveLength(1);
        expect(character.phoneState?.simLogs?.[0].playback?.beatIndex).toBe(1);

        await renderPlayer();
        expect(host.textContent).toContain('雨天小剧场');
        button('从头播放');
        await act(async () => button('继续上次').click());
        expect(host.textContent).toContain('第二段');
        expect(host.textContent).not.toContain('第一段');
    });

    it('续播第一次到结尾才加情绪效果，从头再播不会重复落库或叠加效果', async () => {
        const emotionUpdated = vi.fn();
        window.addEventListener('emotion-updated', emotionUpdated);
        try {
            await renderPlayer(ready(1));
            expect(character.activeBuffs).toBeUndefined();
            expect(host.textContent).toContain('第二段');
            await advance();
            expect(character.phoneState?.simLogs).toHaveLength(1);
            expect(character.phoneState?.simLogs?.[0].playback?.status).toBe('completed');
            expect(character.activeBuffs).toHaveLength(1);
            expect(emotionUpdated).toHaveBeenCalledOnce();

            await act(async () => root.render(null));
            await renderPlayer(ready());
            await advance();
            await advance();
            expect(character.phoneState?.simLogs).toHaveLength(1);
            expect(character.activeBuffs).toHaveLength(1);
            expect(emotionUpdated).toHaveBeenCalledOnce();
        } finally {
            window.removeEventListener('emotion-updated', emotionUpdated);
        }
    });

    it('生活记录显示未看完的进度，继续和从头播放使用同一条记录', async () => {
        const log = character.phoneState!.simLogs![0];
        log.playback = { beatIndex: 1, status: 'playing' };
        const onReplay = vi.fn();
        await act(async () => root.render(React.createElement(LifeLog, {
            targetChar: character, onBack: vi.fn(), onReplay,
        })));
        expect(host.textContent).toContain('未看完');
        expect(host.textContent).not.toContain(script.summary);
        await act(async () => button('继续上次').click());
        expect(onReplay).toHaveBeenLastCalledWith(log, 'resume');
        await act(async () => button('从头播放').click());
        expect(onReplay).toHaveBeenLastCalledWith(log, 'restart');
    });

    it('从头播放会重置断点，随后直接离开页面也能继续新的进度', async () => {
        character.phoneState!.simLogs![0].playback = { beatIndex: 1, status: 'playing' };
        await renderPlayer();
        await act(async () => button('从头播放').click());
        expect(character.phoneState?.simLogs?.[0].playback?.beatIndex).toBe(0);
        await advance();
        await act(async () => root.render(null)); // 模拟系统返回／切换 App，不走退出按钮。
        await renderPlayer();
        await act(async () => button('继续上次').click());
        expect(host.textContent).toContain('第二段');
        expect(character.phoneState?.simLogs).toHaveLength(1);
    });

    it('旧版已完成记录仍能重播，且不会再次触发情绪效果', async () => {
        const log = character.phoneState!.simLogs![0];
        delete log.playback;
        await act(async () => root.render(React.createElement(LifeLog, {
            targetChar: character, onBack: vi.fn(), onReplay: vi.fn(),
        })));
        button('重播');
        expect(host.textContent).toContain(script.summary);
        await renderPlayer(ready());
        await advance();
        await advance();
        expect(character.phoneState?.simLogs).toHaveLength(1);
        expect(character.activeBuffs).toBeUndefined();
    });
});
