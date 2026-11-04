// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MessageItem from '../components/chat/MessageItem';
import type { ChatTheme, Message } from '../types';

const readSource = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('Launcher 桌面分页滚动样式（竖屏不产生纵向滚动手势抢占，横屏保留纵向滚动）', () => {
    const launcherSource = readSource('../apps/Launcher.tsx');
    const styleMatch = launcherSource.match(/<style>\{`([\s\S]*?)`\}<\/style>/);
    const styleContent = styleMatch?.[1] ?? '';

    const stripLandscapeBlocks = (css: string) =>
        css.replace(/@media\s*\(orientation:\s*landscape\)[^{]*\{(?:[^{}]*|\{[^{}]*\})*\}/g, '');

    it('提取到了 Launcher 内联样式表', () => {
        expect(styleContent.length).toBeGreaterThan(0);
    });

    it('默认（竖屏）下 .launcher-page 不开启 overflow-y: auto，且不强制子项 flex-shrink: 0', () => {
        const baseCss = stripLandscapeBlocks(styleContent);
        const pageRuleMatch = baseCss.match(/\.launcher-page\s*\{([^}]*)\}/);
        expect(pageRuleMatch).not.toBeNull();
        expect(pageRuleMatch![1]).not.toMatch(/overflow-y\s*:\s*auto/);
        expect(pageRuleMatch![1]).not.toMatch(/overscroll-behavior-y\s*:\s*contain/);
        expect(baseCss).not.toMatch(/\.launcher-page\s*>\s*\*\s*\{[^}]*flex-shrink\s*:\s*0/);
    });

    it('默认（竖屏）下第 2 页 .launcher-pinwheel-content 保持自适应收缩居中，不撑高页面', () => {
        const baseCss = stripLandscapeBlocks(styleContent);
        const pinwheelRuleMatch = baseCss.match(/\.launcher-pinwheel-content\s*\{([^}]*)\}/);
        expect(pinwheelRuleMatch).not.toBeNull();
        expect(pinwheelRuleMatch![1]).toContain('flex: 1 1 0%');
        expect(pinwheelRuleMatch![1]).toContain('min-height: 0');
        expect(pinwheelRuleMatch![1]).toContain('justify-content: center');
    });

    it('横屏 @media (orientation: landscape) 下为 .launcher-page 开启纵向滚动与子项不收缩', () => {
        const landscapeMatch = styleContent.match(
            /@media\s*\(orientation:\s*landscape\)\s*\{((?:[^{}]*|\{[^{}]*\})*)\}/,
        );
        expect(landscapeMatch).not.toBeNull();
        const landscapeCss = landscapeMatch![1];
        expect(landscapeCss).toMatch(/\.launcher-page\s*\{[^}]*overflow-y:\s*auto/);
        expect(landscapeCss).toMatch(/\.launcher-page\s*\{[^}]*overscroll-behavior-y:\s*contain/);
        expect(landscapeCss).toMatch(/\.launcher-page\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0/);
        expect(landscapeCss).toMatch(/\.launcher-pinwheel-content\s*\{[^}]*flex:\s*0\s+0\s+auto/);
    });
});

describe('MessageItem 聊天气泡静止态不创建冗余 transform 合成层', () => {
    let root: Root;
    let host: HTMLDivElement;

    const mockTheme: ChatTheme = {
        id: 'default',
        name: 'Default',
        type: 'preset',
        user: {
            textColor: '#ffffff',
            backgroundColor: '#3b82f6',
            borderRadius: 16,
            opacity: 1,
        },
        ai: {
            textColor: '#1e293b',
            backgroundColor: '#ffffff',
            borderRadius: 16,
            opacity: 1,
        },
    };

    const mockMessage: Message = {
        id: 101,
        charId: 'char-1',
        role: 'assistant',
        type: 'text',
        content: '测试聊天气泡滚动性能',
        timestamp: 1700000000000,
    };

    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.restoreAllMocks();
    });

    it('静止未左滑（replyOffset === 0）时不挂载内联 transform，左滑引用时才挂载并在松手后清除', async () => {
        await act(async () => {
            root.render(
                React.createElement(MessageItem, {
                    msg: mockMessage,
                    isFirstInGroup: true,
                    isLastInGroup: true,
                    activeTheme: mockTheme,
                    charAvatar: '',
                    charName: 'Sully',
                    userAvatar: '',
                    onLongPress: vi.fn(),
                    onReply: vi.fn(),
                    selectionMode: false,
                    isSelected: false,
                    onToggleSelect: vi.fn(),
                }),
            );
        });

        const contentWrap = host.querySelector('.sully-chat-message-content') as HTMLElement;
        expect(contentWrap).not.toBeNull();
        const replyIndicator = contentWrap.children[0] as HTMLElement;
        const gestureLayer = contentWrap.children[1] as HTMLElement;

        // 静止态：不应带有 transform: translateX(0px) 等内联 transform
        expect(gestureLayer.style.transform).toBe('');
        expect(replyIndicator.style.transform).toBe('');

        // 触发触摸左滑引用手势
        await act(async () => {
            gestureLayer.dispatchEvent(
                new PointerEvent('pointerdown', {
                    bubbles: true,
                    cancelable: true,
                    button: 0,
                    pointerId: 1,
                    pointerType: 'touch',
                    clientX: 200,
                    clientY: 100,
                }),
            );
            gestureLayer.dispatchEvent(
                new PointerEvent('pointermove', {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 1,
                    pointerType: 'touch',
                    clientX: 140,
                    clientY: 101,
                }),
            );
        });

        expect(gestureLayer.style.transform).toBe('translateX(-60px)');
        expect(replyIndicator.style.transform).toContain('translateY(-50%)');

        // 松手复位：内联 transform 清空，释放合成层
        await act(async () => {
            gestureLayer.dispatchEvent(
                new PointerEvent('pointerup', {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 1,
                    pointerType: 'touch',
                    clientX: 140,
                    clientY: 101,
                }),
            );
        });

        expect(gestureLayer.style.transform).toBe('');
        expect(replyIndicator.style.transform).toBe('');
    });
});
