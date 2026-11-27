// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import ChatCharacterProfile from '../components/chat/ChatCharacterProfile';
import type { CharacterProfile, DailySchedule } from '../types';
import { lastInnerStateKey, saveInnerState } from './emotionState';

vi.mock('../apps/Character', () => ({
    default: ({ profileCharacterId }: { profileCharacterId: string }) =>
        React.createElement('textarea', { 'aria-label': '核心指令', 'data-character': profileCharacterId }),
}));

const character = {
    id: 'iris', name: '小梨', description: '书店的朋友', avatar: '🌿',
    scheduleFeatureEnabled: true, emotionConfig: { enabled: true },
    activeBuffs: [{ id: 'calm', name: 'calm', label: '安心', intensity: 1 }],
} as CharacterProfile;
const schedule: DailySchedule = {
    id: 'today', charId: character.id, date: '2026-11-19', generatedAt: 0,
    slots: [{ startTime: '00:00', activity: '整理书架', innerThought: '今天想读一本新书。' }],
};
let root: Root;
let host: HTMLDivElement;
const noop = () => {};
const tab = (name: string) => host.querySelector<HTMLButtonElement>(`[data-tab="${name}"]`)!;
const render = (char = character, day = schedule, onPlayTheater: (index: number) => void = noop) => act(() => root.render(
    React.createElement(ChatCharacterProfile, {
        key: char.id, character: char, schedule: day, onClose: noop, onMemory: noop, onSchedule: noop, onPlayTheater,
    }),
));

// jsdom lacks the native dialog lifecycle.
const needsDialogMethods = !HTMLDialogElement.prototype.showModal;
beforeAll(() => {
    if (needsDialogMethods) Object.assign(HTMLDialogElement.prototype, {
        showModal(this: HTMLDialogElement) { this.open = true; },
        close(this: HTMLDialogElement) { this.open = false; },
    });
});
afterAll(() => {
    if (needsDialogMethods) {
        Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
        Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    }
});
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.removeItem(lastInnerStateKey(character.id));
    vi.unstubAllGlobals();
});

it('uses the current slot’s thought and only applies live updates from the displayed character', () => {
    render();
    expect(host.textContent).not.toContain('整理书架');
    expect(host.querySelector('.chat-profile-thought')?.textContent).toContain('今天想读一本新书。');
    const broadcast = (charId: string) => act(() => {
        window.dispatchEvent(new CustomEvent('emotion-innerstate-updated', { detail: { charId, innerState: '刚刚的心声' } }));
    });
    broadcast('other');
    expect(host.textContent).not.toContain('刚刚的心声');
    broadcast(character.id);
    expect(host.textContent).toContain('刚刚的心声');
    expect(host.textContent).toContain('安心');
});

it('hides cached emotion when disabled and shows the schedule state on its own tab', () => {
    localStorage.setItem(lastInnerStateKey(character.id), '以前的心声');
    render({ ...character, emotionConfig: { enabled: false } });
    expect(host.querySelector('.chat-profile-thought,.chat-profile-emotions')).toBeNull();
    expect(host.textContent).not.toContain('整理书架');
    act(() => tab('日程').click());
    expect(host.textContent).toContain('整理书架');
    render({ ...character, scheduleFeatureEnabled: false });
    expect(host.textContent).toContain('日程未开启');
    expect(host.textContent).not.toContain('整理书架');
    expect(host.querySelector('.chat-profile-thought,.chat-profile-emotions')).toBeNull();
});

it('omits empty emotional fields and ignores a schedule left over from another character', () => {
    render({ ...character, activeBuffs: [] }, { ...schedule, charId: 'other' });
    expect(host.querySelector('.chat-profile-thought,.chat-profile-emotions')).toBeNull();
    act(() => tab('日程').click());
    expect(host.textContent).not.toContain('整理书架');
    expect(host.textContent).toContain('今天还没有日程');
});

it('ends the current page at emotion and mounts settings and the full schedule only on their own tabs', async () => {
    render(character, { ...schedule, slots: [...schedule.slots, { startTime: '23:59', activity: '关店' }] });
    const panel = host.querySelector<HTMLElement>('[role="tabpanel"]')!;
    expect(tab('当前').getAttribute('aria-selected')).toBe('true');
    expect(panel.querySelector('.chat-profile-current')?.lastElementChild?.getAttribute('aria-label')).toBe('当前情绪');
    expect(panel.textContent).not.toMatch(/日程|整理书架|关店|角色设定/);
    expect(host.textContent).not.toContain('对话校准');
    await act(async () => { tab('设定').click(); });
    expect(panel.querySelector('textarea')?.dataset.character).toBe(character.id);
    expect(host.textContent).toContain('对话校准');
    expect(panel.textContent).not.toMatch(/心声|安心|整理书架|关店/);
    act(() => tab('日程').click());
    expect(tab('日程').getAttribute('aria-selected')).toBe('true');
    expect(panel.textContent).toContain('关店');
    expect(panel.textContent).toContain('日程与情绪设置');
    expect(panel.querySelector('[aria-current="time"]')).not.toBeNull();
    expect(panel.querySelector('textarea')).toBeNull();
    expect(host.textContent).not.toMatch(/对话校准|安心/);
    act(() => { tab('日程').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    expect(document.activeElement).toBe(tab('当前'));
    expect(panel.textContent).toContain('安心');
    expect(panel.textContent).not.toContain('日程');
});

it('plays started slots, reopens cached performances and locks future slots in character time', () => {
    vi.useFakeTimers();
    try {
        vi.setSystemTime(new Date('2026-11-19T02:00:00Z'));
        const onPlay = vi.fn();
        render({ ...character, customTimezoneEnabled: true, customTimezone: 'Asia/Shanghai' }, { ...schedule, slots: [
            { startTime: '08:00', activity: '整理书架', theater: { generatedAt: 0, lines: [{ text: '推开了门。' }] } },
            { startTime: '10:00', activity: '开窗' }, { startTime: '12:00', activity: '午饭' },
        ] }, onPlay);
        act(() => tab('日程').click());
        const buttons = host.querySelectorAll<HTMLButtonElement>('.sully-schedule-play button');
        expect([...buttons].map(button => button.title)).toEqual(['重看小剧场', '窥视这一刻', '还没到这个时间哦']);
        act(() => { buttons[0].click(); buttons[1].click(); buttons[2].click(); });
        expect(onPlay.mock.calls).toEqual([[0], [1]]);
        expect(host.querySelector('[role="status"]')?.textContent).toBe('还没到这个时间哦');
    } finally { vi.useRealTimers(); }
});

it('keeps explicitly deleted thoughts empty instead of reviving the schedule fallback', () => {
    render();
    act(() => saveInnerState(character.id, 'edited thought'));
    expect(host.querySelector('.chat-profile-thought')?.textContent).toContain('edited thought');
    act(() => saveInnerState(character.id, ''));
    expect(host.querySelector('.chat-profile-thought')?.textContent).not.toContain('今天想读一本新书。');
    expect(host.querySelector('.chat-profile-thought')?.textContent).toContain('暂无心声');
});

it('long-press menu deletion clears the next model context after confirmation', async () => {
    localStorage.setItem(lastInnerStateKey(character.id), 'old private thought');
    render();
    act(() => host.querySelector('.chat-profile-thought')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(host.querySelector('textarea[aria-label="编辑心声"]')).not.toBeNull();
    const buttons = () => Array.from(document.querySelectorAll('button')).filter(b => b.textContent === '删除');
    await act(async () => buttons()[0].click());
    expect(localStorage.getItem(lastInnerStateKey(character.id))).toBe('old private thought');
    await act(async () => buttons().at(-1)!.click());
    expect(localStorage.getItem(lastInnerStateKey(character.id))).toBe('');
    const { ContextBuilder } = await import('./context');
    expect(ContextBuilder.buildEmotionContext(character, { surface: 'chat' })).not.toContain('old private thought');
    expect(ContextBuilder.buildEmotionContext(character, { surface: 'chat' })).not.toContain('当前内心想法');
});

it('long-press emotion editing persists the description, and confirmed deletion removes model input', async () => {
    const { DB } = await import('./db');
    const { ContextBuilder } = await import('./context');
    await DB.saveCharacter({ ...character, buffInjection: '以前的安心' });
    render();
    act(() => host.querySelector('.chat-profile-emotions li')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    const input = host.querySelector<HTMLInputElement>('input[aria-label="情绪名称"]')!;
    expect(input).not.toBeNull();
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '期待');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const editor = () => host.querySelector('[aria-label="编辑情绪"]')!;
    await act(async () => { const saved = new Promise(resolve => window.addEventListener('emotion-updated', resolve, { once: true })); (Array.from(editor().querySelectorAll('button')).find(b => b.textContent === '保存') as HTMLButtonElement).click(); await saved; });
    expect((await DB.getCharacter(character.id))?.activeBuffs?.[0].label).toBe('期待');
    expect(host.querySelector('.chat-profile-emotions')?.textContent).toContain('期待');
    act(() => host.querySelector('.chat-profile-emotions li')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    await act(async () => (Array.from(editor().querySelectorAll('button')).find(b => b.textContent === '删除') as HTMLButtonElement).click());
    expect((await DB.getCharacter(character.id))?.activeBuffs).toHaveLength(1);
    await act(async () => { const saved = new Promise(resolve => window.addEventListener('emotion-updated', resolve, { once: true })); (Array.from(document.querySelectorAll('button')).filter(b => b.textContent === '删除').at(-1) as HTMLButtonElement).click(); await saved; });
    const current = (await DB.getCharacter(character.id))!;
    expect(current.activeBuffs).toEqual([]); expect(current.buffInjection).toBe('');
    expect(ContextBuilder.buildEmotionContext(current, { surface: 'chat' })).not.toContain('期待');
});
