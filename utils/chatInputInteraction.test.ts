// @vitest-environment jsdom
import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatInputArea from '../components/chat/ChatInputArea';
import ChatInputSettings from '../components/chat/ChatInputSettings';
import ChatSettingsSection from '../components/chat/ChatSettingsSection';
import ChatHeader from '../components/chat/ChatHeaderShell';
import { CHAT_INPUT_PREFERENCES_KEY, loadChatInputPreferences, saveChatInputPreferences } from './chatInputPreferences';

vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
let props: React.ComponentProps<typeof ChatInputArea>;
const textarea = () => container.querySelector('textarea')!;
const primary = () => container.querySelector<HTMLButtonElement>('button[aria-label="发送文字"], button[aria-label="生成回复"], button[aria-label="停止回复"]')!;
const renderInput = (patch: Partial<typeof props> = {}) => {
    props = { ...props, ...patch };
    act(() => root.render(React.createElement(ChatInputArea, props)));
};
const keydown = (init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
    act(() => { textarea().dispatchEvent(event); });
    return event;
};
const pointerdown = (target: Element) => {
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    act(() => { target.dispatchEvent(event); });
    return event;
};

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    props = {
        input: '你好', setInput: vi.fn(), isTyping: false, selectionMode: false,
        showPanel: 'none', setShowPanel: vi.fn(), onSend: vi.fn(), onGenerate: vi.fn(),
        onDeleteSelected: vi.fn(), selectedCount: 0, emojis: [], onPanelAction: vi.fn(),
        onImageSelect: vi.fn(), isSummarizing: false, onReroll: vi.fn(), canReroll: false,
    };
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe('private chat input controls', () => {
    it.each([false, true])('closes the toolbar on an outside touch regardless of auto reply (%s) and keyboard focus', autoReplyEnabled => {
        renderInput({ showPanel: 'actions', autoReplyEnabled });
        pointerdown(container);
        expect(props.setShowPanel).toHaveBeenLastCalledWith('none');
        vi.mocked(props.setShowPanel).mockClear();
        act(() => textarea().focus());
        pointerdown(container);
        expect(props.setShowPanel).toHaveBeenLastCalledWith('none');
        expect(props.onSend).not.toHaveBeenCalled();
        expect(props.onPanelAction).not.toHaveBeenCalled();
    });

    it('keeps toolbar buttons usable and only removes its own outside listener when closed', () => {
        renderInput({ showPanel: 'actions' });
        const action = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('戳一戳'))!;
        expect(action).toBeDefined();
        pointerdown(action);
        expect(props.setShowPanel).not.toHaveBeenCalled();
        act(() => action.click());
        expect(props.onPanelAction).toHaveBeenCalled();
        renderInput({ showPanel: 'none' });
        vi.mocked(props.setShowPanel).mockClear();
        pointerdown(container);
        expect(props.setShowPanel).not.toHaveBeenCalled();
    });

    it.each(['emojis', 'chars'] as const)('also dismisses the %s panel when a nested message stops bubbling', showPanel => {
        renderInput({ showPanel });
        const message = document.createElement('div');
        message.addEventListener('pointerdown', event => event.stopPropagation());
        container.append(message);
        pointerdown(message);
        expect(props.setShowPanel).toHaveBeenCalledWith('none');
    });

    it('keeps the existing send button and Enter behavior by default', () => {
        renderInput();
        expect(primary().getAttribute('aria-label')).toBe('发送文字');
        expect(keydown().defaultPrevented).toBe(true);
        expect(props.onSend).toHaveBeenCalledTimes(1);
        expect(props.onGenerate).not.toHaveBeenCalled();
        renderInput({ input: '' });
        expect(primary().disabled).toBe(true);
    });

    it('allows newlines when Enter sending is off, and Shift+Enter in either mode', () => {
        renderInput({ enterToSend: false });
        expect(textarea().getAttribute('enterkeyhint')).toBe('enter');
        expect(keydown().defaultPrevented).toBe(false);
        renderInput({ enterToSend: true });
        expect(keydown({ shiftKey: true }).defaultPrevented).toBe(false);
        expect(props.onSend).not.toHaveBeenCalled();
    });

    it('does not send when confirming IME candidates, including the 229 fallback', () => {
        renderInput();
        expect(keydown({ isComposing: true }).defaultPrevented).toBe(false);
        expect(keydown({ keyCode: 229 }).defaultPrevented).toBe(false);
        expect(props.onSend).not.toHaveBeenCalled();
    });

    it('sends without switching to generation during pointer focus changes', () => {
        renderInput({ sendButtonGenerates: true });
        expect(primary().getAttribute('aria-label')).toBe('生成回复');
        act(() => textarea().focus());
        expect(primary().getAttribute('aria-label')).toBe('发送文字');
        const button = primary();
        const press = pointerdown(button.querySelector('svg')!);
        expect(press.defaultPrevented).toBe(true);
        // 模拟浏览器：未阻止 pointerdown 时，按钮会夺走输入框焦点。
        if (!press.defaultPrevented) act(() => button.focus());
        act(() => button.click());
        expect(document.activeElement).toBe(textarea());
        expect(props.onSend).toHaveBeenCalledTimes(1);
        expect(props.onGenerate).not.toHaveBeenCalled();
        renderInput({ input: '' });
        expect(primary().disabled).toBe(true);
    });

    it('switches on an outside tap, preserves unsent text, and generates once', () => {
        renderInput({ sendButtonGenerates: true });
        act(() => textarea().focus());
        pointerdown(container);
        expect(document.activeElement).not.toBe(textarea());
        expect(primary().getAttribute('aria-label')).toBe('生成回复');
        expect(textarea().value).toBe('你好');
        act(() => primary().click());
        expect(props.onGenerate).toHaveBeenCalledTimes(1);
        expect(props.onSend).not.toHaveBeenCalled();
        expect(props.setInput).not.toHaveBeenCalled();
    });

    it('offers stop while replying and still allows sending text when editing', () => {
        renderInput({ sendButtonGenerates: true, isTyping: true });
        expect(primary().disabled).toBe(false);
        expect(primary().getAttribute('aria-label')).toBe('停止回复');
        act(() => primary().click());
        expect(props.onGenerate).toHaveBeenCalledTimes(1);
        act(() => textarea().focus());
        expect(primary().disabled).toBe(false);
        act(() => primary().click());
        expect(props.onSend).toHaveBeenCalledTimes(1);
    });

    it('supports Escape, pill style, and the shared group-chat fallback', () => {
        renderInput({ sendButtonGenerates: true, sendButtonStyle: 'pill' });
        act(() => textarea().focus());
        keydown({ key: 'Escape' });
        expect(primary().textContent).toBe('生成');
        renderInput({ onGenerate: undefined });
        expect(primary().textContent).toBe('发送');
    });

    it('removes the top lightning in standard and centered headers only when requested', () => {
        const headerProps: React.ComponentProps<typeof ChatHeader> = {
            activeCharacter: { id: 'test', name: 'Test', avatar: '' },
            selectionMode: false, selectedCount: 0, onCancelSelection: vi.fn(),
            isTyping: false, isSummarizing: false, lastTokenUsage: null,
            onClose: vi.fn(), onTriggerAI: vi.fn(), onShowCharsPanel: vi.fn(),
        };
        for (const headerAlign of ['left', 'center'] as const) {
            act(() => root.render(React.createElement(ChatHeader, { ...headerProps, headerAlign })));
            expect(container.querySelector('.sully-chat-trigger')).not.toBeNull();
            act(() => root.render(React.createElement(ChatHeader, { ...headerProps, headerAlign, hideTrigger: true })));
            expect(container.querySelector('.sully-chat-trigger')).toBeNull();
        }
    });

    it('uses the requested checkbox defaults and opens help without toggling a setting', () => {
        const onChange = vi.fn();
        act(() => root.render(React.createElement(ChatInputSettings, { value: loadChatInputPreferences(), onChange })));
        const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        expect(Array.from(boxes, box => box.checked)).toEqual([false, true, false, false, true, true]);
        const help = container.querySelector<HTMLButtonElement>('button[aria-label="发送按钮代替生成按钮说明"]')!;
        act(() => help.click());
        expect(help.getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelector<HTMLParagraphElement>('#chat-input-help-sendButtonGenerates')!.hidden).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
        act(() => boxes[0].click());
        expect(onChange).toHaveBeenCalledWith({ sendButtonGenerates: true, enterToSend: true, autoReply: false, emojiSuggestions: false, linkCards: true, xhsCards: true, linkCardNoticeSeen: false, xhsCardNoticeSeen: false });
    });

    it('persists global preferences and falls back safely for old or broken storage', () => {
        saveChatInputPreferences({ sendButtonGenerates: true, enterToSend: false, autoReply: true, emojiSuggestions: true, linkCards: true, xhsCards: true, linkCardNoticeSeen: false, xhsCardNoticeSeen: false });
        expect(loadChatInputPreferences()).toEqual({ sendButtonGenerates: true, enterToSend: false, autoReply: true, emojiSuggestions: true, linkCards: true, xhsCards: true, linkCardNoticeSeen: false, xhsCardNoticeSeen: false });
        for (const raw of ['{broken', 'null', '{}', '{"sendButtonGenerates":"true","enterToSend":null,"emojiSuggestions":"true"}']) {
            localStorage.setItem(CHAT_INPUT_PREFERENCES_KEY, raw);
            expect(loadChatInputPreferences()).toEqual({ sendButtonGenerates: false, enterToSend: true, autoReply: false, emojiSuggestions: false, linkCards: true, xhsCards: true, linkCardNoticeSeen: false, xhsCardNoticeSeen: false });
        }
    });

    it('only suggests when enabled, using the supplied visible library across categories', () => {
        const hug = { name: '抱抱', url: 'hug.png', categoryId: 'another-category' };
        renderInput({ input: '抱', suggestionEmojis: [hug] });
        expect(container.querySelector('[aria-label="表情包联想"]')).toBeNull();
        renderInput({ emojiSuggestionsEnabled: true });
        expect(container.querySelector('[aria-label="发送表情：抱抱"]')).not.toBeNull();
        renderInput({ showPanel: 'emojis' });
        expect(container.querySelector('[aria-label="表情包联想"]')).toBeNull();
        renderInput({ showPanel: 'none', suggestionEmojis: [] });
        expect(container.querySelector('[aria-label="表情包联想"]')).toBeNull();
    });

    it('preserves community composer selectors and input identity when auxiliary rows appear', () => {
        renderInput({ input: '抱', emojis: [{ name: '抱抱', url: 'hug.png' }] });
        const original = textarea();
        const composer = container.querySelector('.sully-chat-inputbar > div:first-child');
        const wrap = container.querySelector('.sully-chat-inputbar > div:nth-child(1) > div');
        act(() => original.focus());
        original.setSelectionRange(1, 1);
        for (const patch of [
            { emojiSuggestionsEnabled: true },
            { autoReplySeconds: 5 },
            { emojiSuggestionsEnabled: false },
            { autoReplySeconds: null },
        ]) {
            renderInput(patch);
            expect(container.querySelector('.sully-chat-inputbar > div:first-child')).toBe(composer);
            expect(container.querySelector('.sully-chat-inputbar > div:nth-child(1) > div')).toBe(wrap);
            expect(wrap?.contains(original)).toBe(true);
            expect(textarea()).toBe(original);
            expect(document.activeElement).toBe(original);
            expect(original.selectionStart).toBe(1);
        }
    });

    it('hides suggestions during IME composition and never sends the confirmation key', () => {
        renderInput({ input: '抱', emojiSuggestionsEnabled: true, emojis: [{ name: '抱抱', url: 'hug.png' }] });
        act(() => textarea().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
        expect(container.querySelector('[aria-label="表情包联想"]')).toBeNull();
        keydown({ isComposing: true });
        expect(props.onPanelAction).not.toHaveBeenCalled();
        expect(props.onSend).not.toHaveBeenCalled();
        act(() => textarea().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '抱' })));
        expect(container.querySelector('[aria-label="发送表情：抱抱"]')).not.toBeNull();
    });

    it('sends a chosen sticker once, keeps the draft and focus, and dismisses that query', () => {
        const hug = { name: '抱抱', url: 'hug.png' };
        renderInput({ input: '抱', emojiSuggestionsEnabled: true, emojis: [hug], sendButtonGenerates: true });
        act(() => textarea().focus());
        const suggestion = container.querySelector<HTMLButtonElement>('[aria-label="发送表情：抱抱"]')!;
        pointerdown(suggestion);
        expect(document.activeElement).toBe(textarea());
        act(() => suggestion.click());
        expect(props.onPanelAction).toHaveBeenCalledTimes(1);
        expect(props.onPanelAction).toHaveBeenCalledWith('send-emoji', hug);
        expect(props.onSend).not.toHaveBeenCalled();
        expect(props.onGenerate).not.toHaveBeenCalled();
        expect(props.setInput).not.toHaveBeenCalled();
        expect(textarea().value).toBe('抱');
        expect(document.activeElement).toBe(textarea());
        expect(container.querySelector('[aria-label="表情包联想"]')).toBeNull();
        renderInput({ input: '抱抱' });
        expect(container.querySelector('[aria-label="发送表情：抱抱"]')).not.toBeNull();
    });

    it('starts settings sections collapsed and preserves an unsaved choice across toggles', () => {
        const Settings = () => {
            const [value, onChange] = React.useState(loadChatInputPreferences);
            return React.createElement(ChatSettingsSection, { title: '输入与发送', summary: '输入习惯', children: React.createElement(ChatInputSettings, { value, onChange }) });
        };
        act(() => root.render(React.createElement(Settings)));
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]')!;
        const body = document.getElementById(header.getAttribute('aria-controls')!)!;
        expect(header.getAttribute('aria-expanded')).toBe('false');
        expect(body.hidden).toBe(true);
        act(() => header.click());
        const box = Array.from(container.querySelectorAll('label')).find(label => label.textContent?.includes('表情包智能匹配'))!.querySelector('input')!;
        expect(box.checked).toBe(false);
        act(() => box.click());
        act(() => header.click());
        expect(body.hidden).toBe(true);
        act(() => header.click());
        expect(box.checked).toBe(true);
    });
});
