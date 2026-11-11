// @vitest-environment jsdom
// 见面从挂起恢复后的对话画面（见 docs/date-leave-reminder.md）：记录是挂载后才异步读回来的，
// 读回来的还是挂起时那条就别重播；离开期间到了新回复才接着播。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DateState } from '../types';

vi.mock('../context/OSContext', () => ({ useOS: () => ({
    theme: {}, apiConfig: {}, registerBackHandler: () => () => {}, addToast: vi.fn(), updateCharacter: vi.fn(),
}) }));
vi.mock('../components/date/DateSettings', () => ({ default: () => null }));
import DateSession from '../components/date/DateSession';

const OLD_REPLY = '[normal] 第一句。\n[normal] 第二句。\n[normal] 第三句。';
const row = (id: number, content: string) => ({
    id, charId: 'c', role: 'assistant', type: 'text', timestamp: id, content,
    metadata: { source: 'date', dateEncounterId: 'e' },
});

const host = document.createElement('div');
document.body.append(host);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root = createRoot(host);
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(host); });

const mount = async (messages: any[], snapshotRef: React.MutableRefObject<DateState | null>, initialState: DateState) => {
    const props = {
        char: { id: 'c', name: '角色', avatar: '' }, userProfile: { name: '用户' }, encounterId: 'e', peekStatus: '',
        onSendMessage: async () => '', onReroll: async () => '', onExit: () => {}, onEditMessage: () => {},
        onDeleteMessage: () => {}, onDeleteMessages: async () => {}, onSettings: () => {},
        initialState, snapshotRef,
    };
    await act(async () => root.render(React.createElement(DateSession, { ...props, messages } as any)));
    return (next: any[]) => act(async () => root.render(React.createElement(DateSession, { ...props, messages: next } as any)));
};

const restoredAtSecondLine = (): DateState => ({
    dialogueQueue: [{ text: '第三句。' } as any],
    dialogueBatch: [{ text: '第一句。' }, { text: '第二句。' }, { text: '第三句。' }] as any,
    currentText: '第二句。', isNovelMode: false, timestamp: 1, peekStatus: '',
    lastAssistantContent: OLD_REPLY,
});

it('恢复后读回的还是挂起时那条回复 → 停在原来那一句，不从头重播', async () => {
    const snapshotRef = { current: null as DateState | null };
    const setMessages = await mount([], snapshotRef, restoredAtSecondLine());
    await setMessages([row(1, OLD_REPLY)]);
    expect(snapshotRef.current?.currentText).toBe('第二句。');
    expect(snapshotRef.current?.dialogueQueue).toHaveLength(1);
});

it('离开期间到了新回复 → 读回来时接着播新的那批', async () => {
    const snapshotRef = { current: null as DateState | null };
    const setMessages = await mount([], snapshotRef, restoredAtSecondLine());
    await setMessages([row(1, OLD_REPLY), row(2, '[normal] 你回来啦。\n[normal] 刚才去哪了？')]);
    expect(snapshotRef.current?.currentText).toBe('你回来啦。');
    expect(snapshotRef.current?.lastAssistantContent).toContain('刚才去哪了');
});
