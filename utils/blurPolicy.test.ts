// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MessageItem from '../components/chat/MessageItem';
import ChatHeaderShell from '../components/chat/ChatHeaderShell';
import { AppID, type ChatTheme, type Message } from '../types';
import {
    REDUCED_BLUR_ATTR,
    REDUCED_BLUR_PREF_KEY,
    canHideShellBackdropWhenSettled,
    getReducedBlurPreference,
    installReducedBlurPolicy,
    isGeckoEngine,
    reducedBlurSetting,
    resolveReducedGlassCardStyle,
    setReducedBlurPreference,
    shouldUseReducedBlur,
    updateVirtualTimeIfChanged,
    useReducedBlur,
} from './blurPolicy';
import { isSharedSpaceKey } from './userSpaces';
import { privateLocalExcluded } from './userSpaceBackup';

const readSource = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('blurPolicy 引擎与无障碍透明度策略识别', () => {
    it('识别 Android / 鸿蒙容器版与桌面版 Gecko Firefox，排除 WebKit / Blink 浏览器', () => {
        // 鸿蒙容器 / Android 版 Firefox
        expect(
            isGeckoEngine('Mozilla/5.0 (Android 12; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0'),
        ).toBe(true);
        // 桌面版 Firefox
        expect(
            isGeckoEngine('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0'),
        ).toBe(true);

        // iOS 版 Firefox (FxiOS) 为 WebKit 内核，含 "like Gecko"
        expect(
            isGeckoEngine(
                'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/136.0 Mobile/15E148 Safari/605.1.15',
            ),
        ).toBe(false);
        // iOS Safari
        expect(
            isGeckoEngine(
                'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
            ),
        ).toBe(false);
        // Chrome / Blink
        expect(
            isGeckoEngine(
                'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
            ),
        ).toBe(false);
        // 鸿蒙原生 ArkWeb
        expect(
            isGeckoEngine(
                'Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile',
            ),
        ).toBe(false);
    });

    it('系统开启 prefers-reduced-transparency 时在任意引擎上启用收敛策略', () => {
        expect(
            shouldUseReducedBlur({
                ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
                prefersReducedTransparency: true,
            }),
        ).toBe(true);
        expect(
            shouldUseReducedBlur({
                ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
                prefersReducedTransparency: false,
            }),
        ).toBe(false);
    });

    it('installReducedBlurPolicy 同步根节点标记并响应 matchMedia 动态变化', () => {
        let matches = false;
        const listeners = new Set<() => void>();
        const mockWin = {
            navigator: {
                userAgent:
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            },
            matchMedia: vi.fn().mockImplementation(() => ({
                get matches() {
                    return matches;
                },
                addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
                removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
            })),
        } as unknown as Window;

        document.documentElement.removeAttribute(REDUCED_BLUR_ATTR);
        const dispose = installReducedBlurPolicy(document, mockWin);
        expect(document.documentElement.hasAttribute(REDUCED_BLUR_ATTR)).toBe(false);

        matches = true;
        listeners.forEach((cb) => cb());
        expect(document.documentElement.hasAttribute(REDUCED_BLUR_ATTR)).toBe(true);

        matches = false;
        listeners.forEach((cb) => cb());
        expect(document.documentElement.hasAttribute(REDUCED_BLUR_ATTR)).toBe(false);

        dispose();
        expect(listeners.size).toBe(0);
    });

    describe('「减弱模糊」手动开关', () => {
        const CHROME_UA =
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36';
        const FIREFOX_UA = 'Mozilla/5.0 (Android 12; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0';

        /** 可以手动切换系统「减弱透明度」的假窗口。 */
        const mockWindow = (ua: string) => {
            const state = { matches: false };
            const listeners = new Set<() => void>();
            const win = {
                navigator: { userAgent: ua },
                matchMedia: () => ({
                    get matches() {
                        return state.matches;
                    },
                    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
                    removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
                }),
            } as unknown as Window;
            const setSystemReduced = (value: boolean) => {
                state.matches = value;
                listeners.forEach((cb) => cb());
            };
            return { win, setSystemReduced };
        };
        const marked = () => document.documentElement.hasAttribute(REDUCED_BLUR_ATTR);

        beforeEach(() => {
            localStorage.clear();
            document.documentElement.removeAttribute(REDUCED_BLUR_ATTR);
        });
        afterEach(() => {
            localStorage.clear();
            document.documentElement.removeAttribute(REDUCED_BLUR_ATTR);
        });

        it('默认关；打开后在任意引擎上生效，只认写死的开值', () => {
            expect(getReducedBlurPreference()).toBe(false);
            expect(shouldUseReducedBlur({ ua: CHROME_UA, userEnabled: true })).toBe(true);
            expect(shouldUseReducedBlur({ ua: CHROME_UA, userEnabled: false })).toBe(false);

            localStorage.setItem(REDUCED_BLUR_PREF_KEY, 'true');
            expect(getReducedBlurPreference()).toBe(false);
            setReducedBlurPreference(true);
            expect(localStorage.getItem(REDUCED_BLUR_PREF_KEY)).toBe('1');
            expect(getReducedBlurPreference()).toBe(true);
            setReducedBlurPreference(false);
            expect(localStorage.getItem(REDUCED_BLUR_PREF_KEY)).toBeNull();
        });

        it('开关关着时 Firefox 与系统「减弱透明度」照旧自动生效，开关不能把模糊开回来', () => {
            expect(shouldUseReducedBlur({ ua: FIREFOX_UA, userEnabled: false })).toBe(true);
            expect(
                shouldUseReducedBlur({ ua: CHROME_UA, prefersReducedTransparency: true, userEnabled: false }),
            ).toBe(true);

            const { win } = mockWindow(FIREFOX_UA);
            const dispose = installReducedBlurPolicy(document, win);
            expect(marked()).toBe(true);
            setReducedBlurPreference(true);
            setReducedBlurPreference(false);
            expect(marked()).toBe(true);
            dispose();
        });

        it('切换开关立即同步根节点标记；系统偏好来回变化不会冲掉打开的开关', () => {
            const { win, setSystemReduced } = mockWindow(CHROME_UA);
            const dispose = installReducedBlurPolicy(document, win);
            expect(marked()).toBe(false);

            setReducedBlurPreference(true);
            expect(marked()).toBe(true);

            setSystemReduced(true);
            expect(marked()).toBe(true);
            setSystemReduced(false);
            expect(marked()).toBe(true);

            setReducedBlurPreference(false);
            expect(marked()).toBe(false);

            dispose();
            setReducedBlurPreference(true);
            expect(marked()).toBe(false);
        });

        it('冷启动时已打开的开关在安装策略时就生效', () => {
            localStorage.setItem(REDUCED_BLUR_PREF_KEY, '1');
            const dispose = installReducedBlurPolicy(document, mockWindow(CHROME_UA).win);
            expect(marked()).toBe(true);
            dispose();
        });

        it('useReducedBlur 的组件跟着开关即时变化，不需要重新挂载', async () => {
            (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
            const dispose = installReducedBlurPolicy(document, mockWindow(CHROME_UA).win);
            const Probe = () => React.createElement('i', { 'data-reduced': String(useReducedBlur()) });
            const host = document.createElement('div');
            document.body.append(host);
            const root = createRoot(host);
            const read = () => host.querySelector('i')?.getAttribute('data-reduced');

            await act(async () => root.render(React.createElement(Probe)));
            expect(read()).toBe('false');
            await act(async () => setReducedBlurPreference(true));
            expect(read()).toBe('true');
            await act(async () => setReducedBlurPreference(false));
            expect(read()).toBe('false');

            await act(async () => root.unmount());
            host.remove();
            dispose();
        });

        it('三态摘要：手动开 / 自动生效 / 关', () => {
            expect(reducedBlurSetting()).toBe('关');
            document.documentElement.setAttribute(REDUCED_BLUR_ATTR, '');
            expect(reducedBlurSetting()).toBe('自动');
            setReducedBlurPreference(true);
            expect(reducedBlurSetting()).toBe('开');
        });

        it('index.html 的内联脚本在首屏前按同一个键打上标记，这个键各用户空间共用', () => {
            expect(isSharedSpaceKey(REDUCED_BLUR_PREF_KEY)).toBe(true);
            // 设备级选择：各空间共用，但不跟着备份去别的设备。
            expect(privateLocalExcluded(REDUCED_BLUR_PREF_KEY)).toBe(true);
            const inline = readSource('../index.html').match(
                /<script>\s*(\(function \(\) \{(?:(?!<\/script>)[\s\S])*?data-reduced-blur(?:(?!<\/script>)[\s\S])*?)<\/script>/,
            )?.[1];
            expect(inline).toContain(`'${REDUCED_BLUR_PREF_KEY}'`);

            new Function(inline!)();
            expect(marked()).toBe(false);
            localStorage.setItem(REDUCED_BLUR_PREF_KEY, '1');
            new Function(inline!)();
            expect(marked()).toBe(true);
        });
    });

    it('resolveReducedGlassCardStyle 统一使用图标框同系浅白半透底，仅对高亮度浅色字补轻量文字阴影', () => {
        const forPureWhite = resolveReducedGlassCardStyle('#ffffff');
        const forLavenderWhite = resolveReducedGlassCardStyle('#f6efff');
        const forMidPurple = resolveReducedGlassCardStyle('#7c729c');
        const forPaperBrown = resolveReducedGlassCardStyle('#4b4136');
        const forDarkSlate = resolveReducedGlassCardStyle('#1e293b');
        const forRgbLight = resolveReducedGlassCardStyle('rgb(255, 255, 255)');
        const forRgbDark = resolveReducedGlassCardStyle('rgb(75, 65, 54)');

        // 怀旧版白字、中灰紫美化字与深棕默认字均保持与桌面图标框一致的浅白半透底，不再跳变深灰块
        for (const style of [forPureWhite, forLavenderWhite, forMidPurple, forPaperBrown, forDarkSlate]) {
            expect(style.background).toBe('rgba(255, 255, 255, 0.42)');
            expect(style.border).toBe('1px solid rgba(255, 255, 255, 0.38)');
        }

        // 接近白色的浅色字补 text-shadow 兜底亮壁纸可读性；中灰紫与深色字不挂阴影光晕
        expect(forPureWhite.textShadow).not.toBe('none');
        expect(forLavenderWhite.textShadow).not.toBe('none');
        expect(forRgbLight.textShadow).not.toBe('none');
        expect(forMidPurple.textShadow).toBe('none');
        expect(forPaperBrown.textShadow).toBe('none');
        expect(forDarkSlate.textShadow).toBe('none');
        expect(forRgbDark.textShadow).toBe('none');
    });
});

describe('外壳底层壁纸虚化层与时钟状态更新守卫', () => {
    it('全屏不透明 App 入场稳定后允许隐藏外壳底层纹理，透底 App 与自定义白框 CSS 保留底层', () => {
        expect(canHideShellBackdropWhenSettled(AppID.Launcher)).toBe(false);
        expect(canHideShellBackdropWhenSettled(AppID.MemoryPalace)).toBe(false);
        expect(canHideShellBackdropWhenSettled(AppID.QQBridge)).toBe(false);
        expect(canHideShellBackdropWhenSettled(AppID.Character)).toBe(false);
        expect(canHideShellBackdropWhenSettled(AppID.ThemeMaker)).toBe(false);
        expect(canHideShellBackdropWhenSettled(AppID.Music)).toBe(false);

        expect(canHideShellBackdropWhenSettled(AppID.Settings)).toBe(true);
        expect(canHideShellBackdropWhenSettled(AppID.Chat)).toBe(true);
        expect(canHideShellBackdropWhenSettled(AppID.GroupChat)).toBe(true);

        expect(
            canHideShellBackdropWhenSettled(AppID.Chat, { hasCustomChatChromeCss: true }),
        ).toBe(false);
        expect(
            canHideShellBackdropWhenSettled(AppID.Settings, { iosStandalone: true }),
        ).toBe(false);
    });

    it('updateVirtualTimeIfChanged 在分/时/星期未变时复用原对象引用，跨分钟时返回新值', () => {
        const prev = { hours: 21, minutes: 34, day: 'Mon' };
        const sameMinute = { hours: 21, minutes: 34, day: 'Mon' };
        const nextMinute = { hours: 21, minutes: 35, day: 'Mon' };

        expect(updateVirtualTimeIfChanged(prev, sameMinute)).toBe(prev);
        expect(updateVirtualTimeIfChanged(prev, nextMinute)).toBe(nextMinute);
    });
});

describe('多层毛玻璃去重与滚动列表滤镜守卫', () => {
    it('index.html 包含 data-reduced-blur、prefers-reduced-transparency 与 Gecko @supports 兜底规则', () => {
        const html = readSource('../index.html');
        expect(html).toContain('html[data-reduced-blur]');
        expect(html).toContain('@media (prefers-reduced-transparency: reduce)');
        expect(html).toContain('@supports (-moz-appearance: none)');
        expect(html).toMatch(/backdrop-filter:\s*none\s*!important/);
    });

    it('PhoneShell 外壳遮罩层 .sully-shell-wash 不叠加 backdrop-blur', () => {
        const shellSource = readSource('../components/PhoneShell.tsx');
        const washMatch = shellSource.match(/sully-shell-wash[\s\S]{0,260}/);
        expect(washMatch).not.toBeNull();
        expect(washMatch![0]).not.toContain('backdrop-blur');
    });

    it('私聊与群聊滚动列表内的历史加载条、系统提示条与互动条不使用实时 backdrop-blur', () => {
        const chatSource = readSource('../apps/Chat.tsx');
        const groupChatSource = readSource('../apps/GroupChat.tsx');

        expect(chatSource).not.toMatch(/加载更早的[\s\S]{0,120}backdrop-blur/);
        expect(chatSource).not.toMatch(/已显示全部[\s\S]{0,120}backdrop-blur/);
        expect(groupChatSource).not.toMatch(/加载更早的[\s\S]{0,120}backdrop-blur/);
    });

    describe('MessageItem DOM 渲染守卫', () => {
        let root: Root;
        let host: HTMLDivElement;

        const baseTheme: ChatTheme = {
            id: 'ios-theme',
            name: 'iOS Theme',
            type: 'preset',
            user: {
                textColor: '#ffffff',
                backgroundColor: 'rgba(59, 130, 246, 0.82)',
                borderRadius: 18,
                opacity: 1,
            },
            ai: {
                textColor: '#1e293b',
                backgroundColor: 'rgba(255, 255, 255, 0.85)',
                borderRadius: 18,
                opacity: 1,
            },
        };

        beforeEach(() => {
            (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
            document.documentElement.removeAttribute(REDUCED_BLUR_ATTR);
            host = document.createElement('div');
            document.body.append(host);
            root = createRoot(host);
        });

        afterEach(async () => {
            document.documentElement.removeAttribute(REDUCED_BLUR_ATTR);
            await act(async () => root.unmount());
            host.remove();
        });

        it('system 与 interaction 消息胶囊使用高不透明度底色且不带 backdrop-blur 类名', async () => {
            const sysMsg: Message = {
                id: 1,
                charId: 'c1',
                role: 'system',
                type: 'system',
                content: '已开启新对话',
                timestamp: 1700000000000,
            };
            const pokeMsg: Message = {
                id: 2,
                charId: 'c1',
                role: 'assistant',
                type: 'interaction',
                content: '戳一戳',
                timestamp: 1700000001000,
            };

            await act(async () => {
                root.render(
                    React.createElement(
                        React.Fragment,
                        null,
                        React.createElement(MessageItem, {
                            msg: sysMsg,
                            isFirstInGroup: true,
                            isLastInGroup: true,
                            activeTheme: baseTheme,
                            charAvatar: '',
                            charName: 'Sully',
                            userAvatar: '',
                            onLongPress: vi.fn(),
                            onReply: vi.fn(),
                            selectionMode: false,
                            isSelected: false,
                            onToggleSelect: vi.fn(),
                        }),
                        React.createElement(MessageItem, {
                            msg: pokeMsg,
                            isFirstInGroup: true,
                            isLastInGroup: true,
                            activeTheme: baseTheme,
                            charAvatar: '',
                            charName: 'Sully',
                            userAvatar: '',
                            onLongPress: vi.fn(),
                            onReply: vi.fn(),
                            selectionMode: false,
                            isSelected: false,
                            onToggleSelect: vi.fn(),
                        }),
                    ),
                );
            });

            expect(host.innerHTML).not.toContain('backdrop-blur');
            expect(host.innerHTML).toContain('bg-white/60');
        });

        it('bubbleVariant="ios" 在常规环境保留内联 backdropFilter，在 data-reduced-blur 下省略', async () => {
            const textMsg: Message = {
                id: 3,
                charId: 'c1',
                role: 'assistant',
                type: 'text',
                content: '你好呀',
                timestamp: 1700000002000,
            };

            await act(async () => {
                root.render(
                    React.createElement(MessageItem, {
                        msg: textMsg,
                        isFirstInGroup: true,
                        isLastInGroup: true,
                        activeTheme: baseTheme,
                        bubbleVariant: 'ios',
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

            const normalBubble = host.querySelector('.sully-bubble-ai') as HTMLElement;
            expect(normalBubble).not.toBeNull();
            expect(normalBubble.style.backdropFilter).toBe('blur(12px)');

            document.documentElement.setAttribute(REDUCED_BLUR_ATTR, '');
            await act(async () => {
                root.render(
                    React.createElement(MessageItem, {
                        msg: { ...textMsg, id: 4 },
                        isFirstInGroup: true,
                        isLastInGroup: true,
                        activeTheme: baseTheme,
                        bubbleVariant: 'ios',
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

            const reducedBubble = host.querySelector('.sully-bubble-ai') as HTMLElement;
            expect(reducedBubble).not.toBeNull();
            expect(reducedBubble.style.backdropFilter).toBe('');
        });
    });

    it('渐变顶栏在常规环境不垫白底，保留透出聊天背景的半透明渐变；仅降级模式垫白底', async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        const renderHeaderClass = async () => {
            const host = document.createElement('div');
            document.body.append(host);
            const root = createRoot(host);
            await act(async () => {
                root.render(React.createElement(ChatHeaderShell, {
                    selectionMode: false,
                    selectedCount: 0,
                    onCancelSelection: vi.fn(),
                    activeCharacter: { id: 'c1', name: 'Sully', avatar: '' },
                    isTyping: false,
                    isSummarizing: false,
                    lastTokenUsage: null,
                    onClose: vi.fn(),
                    onTriggerAI: vi.fn(),
                    onShowCharsPanel: vi.fn(),
                    headerStyle: 'gradient',
                }));
            });
            const className = host.querySelector('.sully-chat-header')?.className ?? '';
            await act(async () => root.unmount());
            host.remove();
            return className;
        };

        document.documentElement.removeAttribute(REDUCED_BLUR_ATTR);
        const normal = await renderHeaderClass();
        expect(normal).toContain('bg-gradient-to-r');
        expect(normal).toContain('backdrop-blur-xl');
        expect(normal).not.toContain('bg-white/90');

        document.documentElement.setAttribute(REDUCED_BLUR_ATTR, '');
        const reduced = await renderHeaderClass();
        document.documentElement.removeAttribute(REDUCED_BLUR_ATTR);
        expect(reduced).toContain('bg-white/90');
        expect(reduced).not.toContain('backdrop-blur');
    });
});
