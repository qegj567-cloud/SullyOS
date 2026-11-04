// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    blendStatusBarColors,
    createIOSStatusBarEdge,
    installIOSStatusBarEdge,
    parseStatusBarColor,
    shouldInstallIOSStatusBarEdge,
} from './iosStatusBarEdge';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

const iphone27 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Version/27.0.1 Mobile/15E148 Safari/604.1';

describe('iOS status bar eligibility', () => {
    it('uses Safari version when iPhone OS is frozen at 18', () => {
        expect(shouldInstallIOSStatusBarEdge(iphone27, true, false)).toBe(true);
        expect(shouldInstallIOSStatusBarEdge(iphone27, false, false)).toBe(false);
        expect(shouldInstallIOSStatusBarEdge(iphone27, true, true)).toBe(false);
    });
    it('leaves older iOS and desktop platforms alone', () => {
        expect(shouldInstallIOSStatusBarEdge(iphone27.replace('27.0.1', '26.5'), true, false)).toBe(false);
        expect(shouldInstallIOSStatusBarEdge('Mozilla/5.0 Macintosh Version/27.0 Safari/605', true, false)).toBe(false);
        expect(shouldInstallIOSStatusBarEdge('Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)', true, false)).toBe(true);
    });
});

describe('status bar background composition', () => {
    it('keeps alpha when reading computed colors', () => {
        expect(parseStatusBarColor('rgba(255, 255, 255, 0.5)')).toEqual([255, 255, 255, 0.5]);
        expect(parseStatusBarColor('#182c40')).toEqual([24, 44, 64, 1]);
        expect(parseStatusBarColor('transparent')).toEqual([0, 0, 0, 0]);
    });
    it('composites transparent headers over their actual backing color', () => {
        expect(blendStatusBarColors([[255, 255, 255, 0.5], [24, 44, 64, 1]])).toBe('rgb(140, 150, 160)');
        expect(blendStatusBarColors([[24, 44, 64, 1], [255, 255, 255, 1]])).toBe('rgb(24, 44, 64)');
    });
});

describe('status bar edge lifecycle', () => {
    let cleanup: (() => void) | undefined;
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '<main id="root"><header style="background:rgb(24,44,64)"></header></main>';
        document.head.innerHTML = '<meta name="viewport" content="width=device-width, viewport-fit=cover">';
        const header = document.querySelector('header')!;
        vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 90, width: 402, height: 90 } as DOMRect);
        Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: vi.fn(() => [header, document.body]) });
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: iphone27 });
        Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
        window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    });
    afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

    it('creates an empty clipped element without changing safe-area layout', () => {
        const edge = createIOSStatusBarEdge();
        expect(edge.style.height).toBe('11px');
        expect(edge.style.backgroundClip).toBe('text');
        expect(edge.style.pointerEvents).toBe('none');
        expect(edge.textContent).toBe('');
        expect(edge.getAttribute('aria-hidden')).toBe('true');
    });

    it('supports navigator.standalone even when the CSS media query says browser', async () => {
        cleanup = installIOSStatusBarEdge();
        await vi.advanceTimersByTimeAsync(160);
        const edge = document.getElementById('sully-ios-status-bar-edge')!;
        expect(edge.parentElement).toBe(document.body);
        expect(edge.style.backgroundColor).toBe('rgb(24, 44, 64)');
        expect(document.documentElement.style.paddingTop).toBe('');
        expect(document.querySelector('meta[name="viewport"]')!.getAttribute('content')).toContain('viewport-fit=cover');
        expect(document.documentElement.hasAttribute('data-ios-status-bar-contained')).toBe(false);

        document.querySelector('header')!.style.background = 'rgb(240, 230, 220)';
        await vi.advanceTimersByTimeAsync(160);
        expect(edge.style.backgroundColor).toBe('rgb(240, 230, 220)');
    });

    it('contains manifest standalone before layout and restores the viewport on cleanup', async () => {
        document.head.innerHTML = '<meta name="viewport" content="width=device-width, viewport-fit=cover">';
        window.matchMedia = vi.fn().mockReturnValue({ matches: true });
        cleanup = installIOSStatusBarEdge();
        expect(document.querySelector('meta[name="viewport"]')!.getAttribute('content')).toBe('width=device-width, viewport-fit=contain');
        expect(document.documentElement.hasAttribute('data-ios-status-bar-contained')).toBe(true);
        await vi.advanceTimersByTimeAsync(160);
        expect(document.documentElement.style.getPropertyValue('--ios-status-bar-color')).toBe('rgb(24, 44, 64)');
        cleanup(); cleanup = undefined;
        expect(document.querySelector('meta[name="viewport"]')!.getAttribute('content')).toBe('width=device-width, viewport-fit=cover');
        expect(document.documentElement.hasAttribute('data-ios-status-bar-contained')).toBe(false);
    });

    it('does not install twice and removes its own element on cleanup', async () => {
        cleanup = installIOSStatusBarEdge();
        const secondCleanup = installIOSStatusBarEdge();
        expect(document.querySelectorAll('#sully-ios-status-bar-edge')).toHaveLength(1);
        secondCleanup();
        expect(document.querySelectorAll('#sully-ios-status-bar-edge')).toHaveLength(1);
        cleanup(); cleanup = undefined;
        await vi.advanceTimersByTimeAsync(2500);
        expect(document.getElementById('sully-ios-status-bar-edge')).toBeNull();
    });

    it('ignores streaming text and style changes below the top edge', async () => {
        cleanup = installIOSStatusBarEdge();
        await vi.advanceTimersByTimeAsync(160);
        const hitTest = vi.mocked(document.elementsFromPoint);
        hitTest.mockClear();
        const message = document.createElement('p');
        vi.spyOn(message, 'getBoundingClientRect').mockReturnValue({ top: 250, bottom: 400 } as DOMRect);
        document.querySelector('main')!.append(message);
        await vi.advanceTimersByTimeAsync(160);
        hitTest.mockClear();
        message.textContent = '流式回复';
        message.style.opacity = '0.8';
        await vi.advanceTimersByTimeAsync(160);
        expect(hitTest).not.toHaveBeenCalled();
    });

    it('does not let a late wallpaper sample overwrite the next screen', async () => {
        const image = { crossOrigin: '', src: '', onload: null, onerror: null };
        vi.stubGlobal('Image', vi.fn(() => image));
        const header = document.querySelector('header')!;
        header.style.backgroundImage = 'url("https://example.com/wallpaper.png")';
        cleanup = installIOSStatusBarEdge();
        await vi.advanceTimersByTimeAsync(160);
        header.style.background = 'rgb(240,230,220)';
        await vi.advanceTimersByTimeAsync(160);
        expect(document.getElementById('sully-ios-status-bar-edge')!.style.backgroundColor).toBe('rgb(240, 230, 220)');
        await vi.advanceTimersByTimeAsync(2600);
        expect(document.getElementById('sully-ios-status-bar-edge')!.style.backgroundColor).toBe('rgb(240, 230, 220)');
        vi.unstubAllGlobals();
    });
});
