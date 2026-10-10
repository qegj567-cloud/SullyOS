/// <reference types="vitest" />
/**
 * utils/iosStandalone.keyboard.test.ts — 键盘态布局的回归守卫。
 *
 * 背景：iOS 全屏 PWA 下 body 高度会比可视区多出一段底部安全区（给 home 条留位），
 * `.ios-keyboard-open` 一挂，外壳就铺到那段溢出区、聊天输入栏同时收掉自己的让位间隙。
 * 两个动作合起来净位移为 0，前提是「标记挂上」和「app 高度收到键盘上方」同时发生。
 * 只要有一边先动，输入条就整条沉出屏幕、home 条骑到输入框上。
 *
 * 这里钉住的不变式：键盘态只认 visualViewport 真的变矮，不认焦点事件。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SCREEN_H = 852; // 竖屏可视高度
const SAFE_BOTTOM = 34; // home 条安全区
const SAFE_TOP = 44;
const KEYBOARD_H = 336;

type Listener = () => void;
let vvListeners: Record<string, Listener[]>;
let visualViewport: { height: number; offsetTop: number; addEventListener: (t: string, fn: Listener) => void; removeEventListener: () => void };

const setupIOSStandalone = () => {
    vvListeners = { resize: [], scroll: [] };
    visualViewport = {
        height: SCREEN_H,
        offsetTop: 0,
        addEventListener: (type: string, fn: Listener) => { (vvListeners[type] ||= []).push(fn); },
        removeEventListener: () => {},
    };
    Object.defineProperty(window, 'visualViewport', { value: visualViewport, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: SCREEN_H, configurable: true, writable: true });
    Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
        configurable: true,
    });
    window.matchMedia = ((query: string) => ({
        matches: query.includes('standalone'),
        media: query,
        onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    window.scrollTo = vi.fn() as typeof window.scrollTo;

    // jsdom 不认 env()，安全区探针会读到 0，那段 34px 溢出区就不存在、用例也就测不到错位。
    // 认出探针（fixed + hidden 的临时 div）后返回真机数值，其余元素照常走 jsdom。
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element, pseudo?: string | null) => {
        const style = (el as HTMLElement).style;
        if (style?.position === 'fixed' && style?.visibility === 'hidden') {
            return { paddingTop: `${SAFE_TOP}px`, paddingBottom: `${SAFE_BOTTOM}px` } as CSSStyleDeclaration;
        }
        return realGetComputedStyle(el as Element, pseudo as string | undefined);
    }) as typeof window.getComputedStyle);
};

/** 重新加载模块再装载，绕开「只装一次」的单例标志，顺带清掉基线高度等模块级状态。 */
const install = async () => {
    vi.resetModules();
    const mod = await import('./iosStandalone');
    mod.installIOSStandaloneWorkaround();
    return mod;
};

const emitViewportResize = (height: number) => {
    visualViewport.height = height;
    vvListeners.resize.forEach(fn => fn());
};

const focusTextarea = () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    return textarea;
};

const appHeight = () => document.documentElement.style.getPropertyValue('--app-height');
const inKeyboardMode = () => document.body.classList.contains('ios-keyboard-open');

describe('iOS 全屏 PWA 键盘态', () => {
    beforeEach(() => {
        document.body.className = '';
        document.body.innerHTML = '';
        document.documentElement.removeAttribute('style');
        document.documentElement.removeAttribute('data-ios-status-bar-contained');
        setupIOSStandalone();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('键盘态允许输入框内部滑动与选区，同时继续拦截外层拖动', async () => {
        await install();
        const textarea = focusTextarea();
        emitViewportResize(SCREEN_H - KEYBOARD_H);
        const inside = new Event('touchmove', { bubbles: true, cancelable: true });
        textarea.dispatchEvent(inside);
        expect(inside.defaultPrevented).toBe(false);
        const outside = new Event('touchmove', { bubbles: true, cancelable: true });
        document.body.dispatchEvent(outside);
        expect(outside.defaultPrevented).toBe(true);
    });

    it('无键盘时 app 高度 = 可视高度 + 底部安全区（那段溢出区留给 home 条）', async () => {
        await install();
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
        expect(inKeyboardMode()).toBe(false);
    });

    it('contain 的零安全区不回退 44px，延迟缩小的视口重新建立高度基线', async () => {
        document.documentElement.setAttribute('data-ios-status-bar-contained', '');
        vi.mocked(window.getComputedStyle).mockReturnValue({ paddingTop: '0px', paddingBottom: '0px' } as CSSStyleDeclaration);
        await install();
        expect(document.documentElement.style.getPropertyValue('--standalone-safe-area-top')).toBe('0px');
        emitViewportResize(SCREEN_H - 62);
        expect(appHeight()).toBe(`${SCREEN_H - 62}px`);
        expect(inKeyboardMode()).toBe(false);
        emitViewportResize(SCREEN_H - 62 - KEYBOARD_H);
        expect(inKeyboardMode()).toBe(true);
        expect(appHeight()).toBe(`${SCREEN_H - 62 - KEYBOARD_H}px`);
        emitViewportResize(SCREEN_H - 62);
        expect(inKeyboardMode()).toBe(false);
        expect(appHeight()).toBe(`${SCREEN_H - 62}px`);
    });

    it('contain 只触发 visualViewport resize 时也丢弃启动前读到的 cover 安全区', async () => {
        document.documentElement.setAttribute('data-ios-status-bar-contained', '');
        await install();
        vi.mocked(window.getComputedStyle).mockReturnValue({ paddingTop: '0px', paddingBottom: '0px' } as CSSStyleDeclaration);
        emitViewportResize(SCREEN_H);
        expect(document.documentElement.style.getPropertyValue('--standalone-safe-area-top')).toBe('0px');
        emitViewportResize(SCREEN_H - 62);
        expect(document.documentElement.style.getPropertyValue('--standalone-safe-area-top')).toBe('0px');
        expect(document.documentElement.style.getPropertyValue('--standalone-safe-area-bottom')).toBe('0px');
        expect(appHeight()).toBe(`${SCREEN_H - 62}px`);
    });

    // 回归守卫：输入框拿到焦点不等于键盘弹出来了。设备上键盘弹不出来时（外接键盘、输入法异常），
    // 旧实现照样挂标记，外壳铺到那 34px 溢出区、输入栏又收掉让位间隙，输入条整条沉出屏幕。
    it('焦点进来但可视区没变矮 → 不进键盘态，高度不动', async () => {
        await install();
        focusTextarea();

        expect(inKeyboardMode()).toBe(false);
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
    });

    it('可视区真的变矮 → 标记和高度一起进键盘态', async () => {
        await install();
        focusTextarea();
        emitViewportResize(SCREEN_H - KEYBOARD_H);

        expect(inKeyboardMode()).toBe(true);
        expect(appHeight()).toBe(`${SCREEN_H - KEYBOARD_H}px`);
    });

    // 回归守卫：聚焦中的输入框被 React 卸载时（退出聊天页），WebKit 不派发 focusout。
    // 旧实现只有 focusout 能摘标记，于是标记永久卡在 body 上，全局界面底部一直错位。
    it('输入框被直接移除、没有 focusout → 键盘收起后标记不残留', async () => {
        await install();
        const textarea = focusTextarea();
        emitViewportResize(SCREEN_H - KEYBOARD_H);
        expect(inKeyboardMode()).toBe(true);

        textarea.remove();
        emitViewportResize(SCREEN_H);

        expect(inKeyboardMode()).toBe(false);
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
    });

    it('键盘动画期可视高度报脏值 → 退化成无键盘态，不把布局撑崩', async () => {
        await install();
        focusTextarea();
        emitViewportResize(80);

        expect(inKeyboardMode()).toBe(false);
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
    });

    it.each(['Android Chrome', 'iPhone Safari'])('浏览器平移不抵消键盘高度：%s', async userAgent => {
        Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
        const originalMatchMedia = window.matchMedia;
        window.matchMedia = query => ({ ...originalMatchMedia(query), matches: false });
        await install();
        visualViewport.offsetTop = KEYBOARD_H;
        emitViewportResize(SCREEN_H - KEYBOARD_H);
        expect(inKeyboardMode()).toBe(true);
        expect(appHeight()).toBe(`${SCREEN_H - KEYBOARD_H}px`);
        visualViewport.offsetTop = 0;
        emitViewportResize(SCREEN_H);
        expect(inKeyboardMode()).toBe(false);
        expect(appHeight()).toBe(`${SCREEN_H}px`);
    });
});
