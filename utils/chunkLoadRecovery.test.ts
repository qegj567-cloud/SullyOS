import { describe, it, expect, vi, afterEach } from 'vitest';
import { isChunkLoadError, markModuleLoadError, tryAutoReloadForChunkError } from './chunkLoadRecovery';

// 锁住 "Importing a module script failed." 自愈链路:
// iOS Safari standalone PWA 下动态 import 失败会被缓存进模块表, 本页内重试必失败,
// 只有整页 reload 能恢复 — AppErrorBoundary 靠这两个函数识别 + 自动刷新 (带防循环冷却)。

describe('isChunkLoadError', () => {
    it('识别各浏览器的 chunk 加载失败指纹', () => {
        // iOS / macOS Safari (用户报错原文)
        expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
        // Chrome
        expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x.dev/assets/Chat-Ck2f.js'))).toBe(true);
        // Firefox
        expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
        // Vite CSS 依赖预载失败
        expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/Chat-D3xq.css'))).toBe(true);
        // Safari / WebKit：部署更新后旧 chunk URL 被 SPA fallback 回成 index.html。
        expect(isChunkLoadError(new TypeError("'text/html' is not a valid JavaScript MIME type."))).toBe(true);
        // Chromium 对同一类 HTML-as-module 响应的报错文案。
        expect(isChunkLoadError(new TypeError('Expected a JavaScript module script but the server responded with a MIME type of "text/html".'))).toBe(true);
        // 字符串形态也接受
        expect(isChunkLoadError('Importing a module script failed.')).toBe(true);
    });

    it('普通运行时错误不误判', () => {
        expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
        expect(isChunkLoadError(new Error('Network request failed'))).toBe(false);
        expect(isChunkLoadError(null)).toBe(false);
        expect(isChunkLoadError(undefined)).toBe(false);
        expect(isChunkLoadError(42)).toBe(false);
    });

    it.each(['Unexpected EOF', 'Unexpected end of input', 'Unexpected end of script.'])('只有加载阶段的 %s 才走资源恢复', message => {
        const error = Object.freeze(new SyntaxError(message));
        expect(isChunkLoadError(error)).toBe(false);
        markModuleLoadError(error);
        expect(isChunkLoadError(error)).toBe(true);
    });

    it('带 JSON 提示的解析失败、组件运行异常不自动刷新', () => {
        for (const error of [
            new SyntaxError('JSON Parse error: Unexpected EOF'),
            new SyntaxError('Unexpected end of JSON input'),
            new TypeError("Cannot read properties of undefined (reading 'map')"),
            new Error('Unexpected EOF'),
        ]) {
            markModuleLoadError(error);
            expect(isChunkLoadError(error)).toBe(false);
        }
        markModuleLoadError(null);
        markModuleLoadError('Unexpected EOF');
        expect(isChunkLoadError('Unexpected EOF')).toBe(false);
        expect(isChunkLoadError(new SyntaxError('Unexpected EOF'))).toBe(false);
    });
});

describe('tryAutoReloadForChunkError', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const stubEnv = (nav: { onLine?: boolean } = { onLine: true }) => {
        const store = new Map<string, string>();
        const reload = vi.fn();
        const getItem = vi.fn((k: string) => (store.has(k) ? store.get(k)! : null));
        const setItem = vi.fn((k: string, v: string) => { store.set(k, String(v)); });
        vi.stubGlobal('sessionStorage', {
            getItem,
            setItem,
        });
        vi.stubGlobal('window', { location: { reload } });
        vi.stubGlobal('navigator', nav);
        return { reload, store, getItem, setItem };
    };

    it('首次触发: 记录时间戳并整页刷新', () => {
        const { reload } = stubEnv();
        expect(tryAutoReloadForChunkError()).toBe('reloading');
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('冷却期内再触发: 不再自动刷新 (防循环), 留给手动按钮', () => {
        const { reload } = stubEnv();
        expect(tryAutoReloadForChunkError()).toBe('reloading');
        expect(tryAutoReloadForChunkError()).toBe('cooldown');
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('sessionStorage 不可用时不自动刷新 (没法防循环)', () => {
        const reload = vi.fn();
        vi.stubGlobal('window', { location: { reload } });
        // 不 stub sessionStorage → 访问抛 ReferenceError → 内部 catch → 不自刷
        expect(tryAutoReloadForChunkError()).toBe('storage-unavailable');
        expect(reload).not.toHaveBeenCalled();
    });

    it('明确离线时不刷新、不读写冷却，联网本身不刷新，之后重试仍有额度', () => {
        const nav = { onLine: false };
        const { reload, store, getItem, setItem } = stubEnv(nav);

        expect(tryAutoReloadForChunkError()).toBe('offline');
        expect(reload).not.toHaveBeenCalled();
        expect(getItem).not.toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();
        expect(store.size).toBe(0);

        nav.onLine = true;
        expect(reload).not.toHaveBeenCalled();
        expect(tryAutoReloadForChunkError()).toBe('reloading');
        expect(reload).toHaveBeenCalledTimes(1);
        expect(setItem).toHaveBeenCalledTimes(1);
    });

    it.each([true, undefined])('onLine 为 %s 时不作为离线拦截', onLine => {
        const { reload } = stubEnv({ onLine });
        expect(tryAutoReloadForChunkError()).toBe('reloading');
        expect(reload).toHaveBeenCalledTimes(1);
    });
});
