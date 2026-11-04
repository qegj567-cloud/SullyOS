/**
 * 懒加载 chunk 失败自愈 — "Importing a module script failed." 一键恢复
 *
 * 触发场景 (iOS Safari standalone PWA 高发):
 *  - PWA 从后台恢复瞬间网络连接还没拉起来, 此时点 App 图标触发的动态 import 失败;
 *  - 部署更新后旧 bundle 还驻留在内存里, 引用的旧 hash chunk 已从服务器消失 (404)。
 *
 * 关键: Safari 会把"加载失败"缓存进模块表 — 同一 URL 在本页生命周期内再 import
 * 直接秒失败、不再发网络请求。所以"返回桌面再点进"永远修不好, 只有整页 reload
 * (用户侧表现为"大退重进") 才能恢复。这里做的就是把这次 reload 自动化。
 *
 * 防循环: sessionStorage 记录上次自动刷新时间, 冷却期内不再自刷 (留给手动按钮),
 * 避免服务器真把 chunk 弄丢时无限刷新。大退后 sessionStorage 自然清空, 护栏复位。
 */

const RELOAD_MARK_KEY = 'sullyos_chunk_reload_at';
const RELOAD_COOLDOWN_MS = 60_000;

export type ChunkAutoReloadResult = 'reloading' | 'offline' | 'cooldown' | 'storage-unavailable';

// EOF 本身不能证明是 chunk：JSON / 用户脚本也会报语法错误。
// 只为懒加载 Promise 的拒绝记录来源，保留原 Error 和堆栈（也兼容 frozen Error）。
const moduleLoadErrors = new WeakSet<object>();
export const markModuleLoadError = (error: unknown): void => {
    if (error !== null && typeof error === 'object') moduleLoadErrors.add(error);
};

const INCOMPLETE_MODULE_RE = /^(?:Unexpected EOF|Unexpected end of (?:input|script))\.?$/i;

/** 各浏览器动态 import / chunk 加载失败的报错指纹 (Safari / Chrome / Firefox / webpack 风格) */
const CHUNK_ERROR_RE = new RegExp(
    [
        'Importing a module script failed',          // iOS/macOS Safari
        'Failed to fetch dynamically imported module', // Chrome
        'error loading dynamically imported module',   // Firefox
        'Failed to load module script',                 // MIME/网络层失败
        'not a valid JavaScript MIME type',             // Safari: 'text/html' is not a valid JavaScript MIME type
        'server responded with a MIME type of ["\']?text/html', // Chromium: SPA fallback returned HTML for a module
        'Unable to preload CSS',                        // Vite __vitePreload CSS 依赖失败
        'ChunkLoadError',
        'Loading chunk \\S+ failed',
    ].join('|'),
    'i',
);

export const isChunkLoadError = (err: unknown): boolean => {
    const msg = err instanceof Error
        ? `${err.name}: ${err.message}`
        : typeof err === 'string' ? err : '';
    if (CHUNK_ERROR_RE.test(msg)) return true;
    return err instanceof Error
        && moduleLoadErrors.has(err)
        && err.name === 'SyntaxError'
        && INCOMPLETE_MODULE_RE.test(err.message.trim());
};

/**
 * 尝试自动整页刷新来恢复 chunk 加载失败。
 * 明确离线时保留当前页面，不消耗冷却额度；联网后由用户手动重试。
 * 返回发起刷新或阻止刷新的原因，调用方据此展示手动恢复提示。
 */
export const tryAutoReloadForChunkError = (): ChunkAutoReloadResult => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    try {
        const last = parseInt(sessionStorage.getItem(RELOAD_MARK_KEY) || '0', 10) || 0;
        const now = Date.now();
        if (now - last < RELOAD_COOLDOWN_MS) return 'cooldown';
        sessionStorage.setItem(RELOAD_MARK_KEY, String(now));
    } catch {
        // sessionStorage 不可用时没法防刷新循环 → 不自动刷, 走手动按钮兜底
        return 'storage-unavailable';
    }
    window.location.reload();
    return 'reloading';
};
