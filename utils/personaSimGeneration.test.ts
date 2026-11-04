// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CheckPhone from '../apps/CheckPhone';
import { AppID, type CharacterProfile, type SimScript } from '../types';
import { appShortcutLaunch } from './appShortcutLaunch';
import { personaSimStore } from './personaSimStore';
import { DB } from './db';

const mocks = vi.hoisted(() => ({ useOS: vi.fn(), generate: vi.fn() }));
vi.mock('../context/OSContext', () => ({ useOS: mocks.useOS }));
vi.mock('../apps/PersonaSim', () => ({
    generatePersonaScript: mocks.generate,
    default: ({ onStart, sim }: any) => React.createElement('button', {
        onClick: () => onStart('daily', '雨天'),
    }, `生成小剧场 · ${sim.status}`),
    LifeLog: () => null,
}));
vi.mock('./context', () => ({ ContextBuilder: {} }));
vi.mock('./memoryPalace/pipeline', () => ({ injectMemoryPalace: vi.fn() }));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../components/os/TokenImg', () => ({ default: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let characters: CharacterProfile[];
let pendingWrites: Promise<void>[];

const script: SimScript = {
    title: '雨天剧本', summary: '雨停了',
    beats: [{ kind: 'lock' }, { kind: 'end' }], buff: { label: '平静' },
};

beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    personaSimStore.reset();
    characters = ['a', 'b'].map(id => ({ id, name: id, phoneState: { records: [] } } as unknown as CharacterProfile));
    pendingWrites = [];
    mocks.useOS.mockImplementation(() => ({
        characters, activeCharacterId: 'a', characterGroups: [], apiPresets: [],
        apiConfig: { apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'test' },
        userProfile: { name: '用户' }, closeApp: vi.fn(), addToast: vi.fn(),
        updateCharacter: (id: string, update: (current: CharacterProfile) => Partial<CharacterProfile>) => {
            characters = characters.map(char => char.id === id ? { ...char, ...update(char) } : char);
            pendingWrites.push(DB.saveCharacter(characters.find(char => char.id === id)!));
        },
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    await Promise.all(pendingWrites);
    host.remove();
    personaSimStore.reset();
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

async function openPersona(characterId: string) {
    await act(async () => {
        appShortcutLaunch.request({ appId: AppID.CheckPhone, entryId: 'persona', characterId });
        root.render(React.createElement(CheckPhone));
    });
}

it('离开查手机后生成完成，完整剧本仍落库，尚未播放也不施加情绪效果', async () => {
    let resolveGeneration!: (script: SimScript) => void;
    mocks.generate.mockReturnValue(new Promise<SimScript>(resolve => { resolveGeneration = resolve; }));
    await openPersona('a');
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(personaSimStore.get().status).toBe('loading');
    await act(async () => root.render(null));
    await act(async () => resolveGeneration(script));
    await Promise.all(pendingWrites);
    const saved = (await DB.getAllCharacters()).find(char => char.id === 'a')!;
    expect(saved.phoneState?.simLogs).toHaveLength(1);
    expect(saved.phoneState?.simLogs?.[0].script).toEqual(script);
    expect(saved.phoneState?.simLogs?.[0].playback).toEqual({ beatIndex: 0, status: 'ready' });
    expect(saved.activeBuffs).toBeUndefined();
    expect(personaSimStore.get()).toMatchObject({ status: 'ready', logId: saved.phoneState?.simLogs?.[0].id });
});

it('切到另一角色的小剧场时，生成结果只归档给原角色，通知也不会串台', async () => {
    let resolveGeneration!: (script: SimScript) => void;
    mocks.generate.mockReturnValue(new Promise<SimScript>(resolve => { resolveGeneration = resolve; }));
    await openPersona('a');
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    await openPersona('b');
    expect(host.textContent).toContain('生成小剧场 · idle');
    await act(async () => resolveGeneration(script));
    expect(characters.find(char => char.id === 'a')?.phoneState?.simLogs).toHaveLength(1);
    expect(characters.find(char => char.id === 'b')?.phoneState?.simLogs).toBeUndefined();
    expect(host.textContent).toContain('生成小剧场 · idle');
});
