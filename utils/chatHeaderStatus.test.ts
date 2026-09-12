// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ChatHeaderShell from '../components/chat/ChatHeaderShell';

let container: HTMLDivElement, root: Root;
type Props = React.ComponentProps<typeof ChatHeaderShell>;
const render = (patch: Partial<Props>) => act(() => root.render(React.createElement(ChatHeaderShell, {
    activeCharacter: { id: 'qa', name: '测试角色', avatar: '' },
    selectionMode: false, selectedCount: 0, onCancelSelection() {},
    isTyping: false, isSummarizing: false, lastTokenUsage: null,
    onClose() {}, onTriggerAI() {}, onShowCharsPanel() {}, ...patch,
})));
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const styles: NonNullable<Props['headerStyle']>[] = ['default', 'minimal', 'gradient', 'wechat', 'telegram', 'discord', 'pixel'];
const aligns: NonNullable<Props['headerAlign']>[] = ['left', 'center'];
const statuses: NonNullable<Props['statusStyle']>[] = ['subtle', 'pill', 'dot'];
describe('chat header online appearance', () => {
    it.each(styles.flatMap(headerStyle => aligns.flatMap(headerAlign => statuses.map(statusStyle => ({ headerStyle, headerAlign, statusStyle })))))
   ('$headerStyle / $headerAlign respects $statusStyle', options => {
        render({ ...options, headerDensity: 'compact' });
        const status = container.querySelector('.sully-chat-status')!;
        expect(status).not.toBeNull();
        expect(status.textContent?.toLowerCase()).toBe('online');
        expect(status.querySelector('.bg-emerald-400') !== null).toBe(options.statusStyle === 'dot');
        expect(status.querySelector('.rounded-full.font-semibold') !== null).toBe(options.statusStyle === 'pill');
    });
    it.each(aligns)('keeps group status text and custom CSS hook with %s alignment', headerAlign => {
        render({ headerAlign, headerStyle: 'telegram', statusStyle: 'dot', statusText: '3 成员' });
        expect(container.querySelector('.sully-chat-status')?.textContent).toBe('3 成员');
        expect(container.textContent).not.toContain('Online');
    });
});
