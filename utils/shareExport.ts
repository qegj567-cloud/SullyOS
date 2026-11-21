import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { ShareCardOptions } from './pngShare';

export interface ShareOrDownloadOptions {
    /** 有可导入内容的分享入口：打开 PNG 分享卡编辑器，并保留原格式导出。 */
    card?: ShareCardOptions;
    /** 文件文本内容（目前导出都是文本，如 JSON / txt）。 */
    content: string;
    /** 带扩展名的文件名，如 `worldbook.json`。 */
    fileName: string;
    /** MIME 类型，默认 `application/json`。 */
    mimeType?: string;
    /** 系统 / Web 分享面板标题，默认取文件名。 */
    shareTitle?: string;
}

export interface ShareOrDownloadBlobOptions {
    card?: ShareCardOptions;
    blob: Blob;
    fileName: string;
    shareTitle?: string;
    /** 大型 ZIP 在原生 WebView 中分片转 base64 并追加写盘，避免一次性读入导致 OOM。 */
    nativeChunked?: boolean;
    /** 网页端明确显示为“下载”的入口跳过 Web Share；原生 App 仍使用系统分享。 */
    preferDownloadOnWeb?: boolean;
}

const NATIVE_WRITE_CHUNK_SIZE = 3 * 1024 * 1024;

// Capacitor's iOS and Android plugins reject with this message (without AbortError).
const isShareCancelled = (error: any): boolean => error?.name === 'AbortError'
    || /^share cancel(?:ed|led)$/i.test(String(error?.message || '').trim());

const blobToBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
        const dataUrl = String(reader.result || '');
        const comma = dataUrl.indexOf(',');
        if (comma < 0) reject(new Error('文件编码失败'));
        else resolve(dataUrl.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.readAsDataURL(blob);
});

const base64ToBlob = (value: string, mimeType: string): Blob => {
    const base64 = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
};

/** Fetch a downloadable blob, using native HTTP as a CORS-free fallback in Capacitor. */
export async function fetchBlobForShare(sourceUrl: string, fallbackMimeType = 'application/octet-stream', options?: RequestInit & { __sullyHandlesFailure?: boolean }): Promise<Blob> {
    try {
        const response = await fetch(sourceUrl, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.size) throw new Error('文件为空');
        return blob;
    } catch (webError) {
        if (!Capacitor.isNativePlatform() || !/^https?:\/\//i.test(sourceUrl)) throw webError;
        const response = await CapacitorHttp.request({ url: sourceUrl, method: 'GET', responseType: 'blob' });
        if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
        const blob = base64ToBlob(String(response.data || ''), String(response.headers?.['content-type'] || fallbackMimeType));
        if (!blob.size) throw new Error('文件为空');
        return blob;
    }
}

/**
 * 保存二进制媒体：原生壳写缓存并调系统分享，移动浏览器优先 Web Share，
 * 桌面浏览器才使用 a.download。WebView 普遍不可靠的裸 download 点击只作为末级兜底。
 */
export async function shareOrDownloadBlob(options: ShareOrDownloadBlobOptions): Promise<'shared' | 'downloaded' | 'cancelled'> {
    const { blob, fileName, shareTitle = fileName, nativeChunked = false, preferDownloadOnWeb = false } = options;
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('文件为空，无法保存');
    if (options.card) {
        const { openShareCardDialog } = await import('../components/share/ShareCardDialog');
        return openShareCardDialog(options, options.card);
    }

    const nativePlatform = Capacitor.isNativePlatform();
    let nativeFailure: unknown = null;
    if (nativePlatform) {
        const tempName = `${fileName}.${Date.now()}.part`;
        try {
            if (nativeChunked && blob.size > NATIVE_WRITE_CHUNK_SIZE) {
                for (let start = 0, index = 0; start < blob.size; start += NATIVE_WRITE_CHUNK_SIZE, index += 1) {
                    const data = await blobToBase64(blob.slice(start, Math.min(start + NATIVE_WRITE_CHUNK_SIZE, blob.size)));
                    if (index === 0) {
                        await Filesystem.writeFile({ path: tempName, data, directory: Directory.Cache });
                    } else {
                        await Filesystem.appendFile({ path: tempName, data, directory: Directory.Cache });
                    }
                }
                await Filesystem.rename({ from: tempName, to: fileName, directory: Directory.Cache });
            } else {
                await Filesystem.writeFile({
                    path: fileName,
                    data: await blobToBase64(blob),
                    directory: Directory.Cache,
                });
            }
            const uriResult = await Filesystem.getUri({ directory: Directory.Cache, path: fileName });
            await Share.share({ title: shareTitle, files: [uriResult.uri] });
            return 'shared';
        } catch (error: any) {
            if (isShareCancelled(error)) return 'cancelled';
            console.error('Native Blob Share Error', error);
            nativeFailure = error;
            if (nativeChunked) {
                try { await Filesystem.deleteFile({ path: tempName, directory: Directory.Cache }); } catch { /* best effort */ }
            }
        }
    }

    try {
        const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
        const canShareFile = typeof navigator !== 'undefined'
            && !preferDownloadOnWeb
            && typeof navigator.share === 'function'
            && (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] }));
        if (canShareFile) {
            await navigator.share({ title: shareTitle, files: [file] });
            return 'shared';
        }
    } catch (error: any) {
        if (isShareCancelled(error)) return 'cancelled';
        const expectedPermissionFallback = error?.name === 'NotAllowedError'
            || /permission denied|not allowed|user activation/i.test(String(error?.message || error));
        if (!expectedPermissionFallback) console.error('Web Blob Share Error', error);
    }

    // 原生壳绝不能伪装成“浏览器已下载”：WebView 的 a.download 正是最常见的无反应来源。
    if (nativePlatform) {
        throw nativeFailure instanceof Error ? nativeFailure : new Error('无法拉起系统文件分享');
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'downloaded';
}

/**
 * 强制拉起分享的文件导出：原生（Capacitor Share）→ Web Share API → 浏览器下载兜底。
 *
 * SullyOS 常被包成移动端 WebView / 原生壳，这类环境里 `<a download>` 往往不触发任何东西，
 * 直接下载会「点了没反应 = 导不出来」。所以先尝试调起系统 / 浏览器的分享面板把文件送出去，
 * 只有在既没有原生分享、也没有 Web Share 能力时，才退回到浏览器下载。
 *
 * 与 apps/Character.tsx 的角色卡导出保持一致的三级兜底策略。
 *
 * @returns `'shared'` 已调起分享面板；`'downloaded'` 走了浏览器下载兜底。
 */
export async function shareOrDownloadFile(options: ShareOrDownloadOptions & { card?: undefined }): Promise<'shared' | 'downloaded'>;
export async function shareOrDownloadFile(options: ShareOrDownloadOptions): Promise<'shared' | 'downloaded' | 'cancelled'>;
export async function shareOrDownloadFile(options: ShareOrDownloadOptions): Promise<'shared' | 'downloaded' | 'cancelled'> {
    const { content, fileName, mimeType = 'application/json', shareTitle = fileName } = options;
    if (options.card) return shareOrDownloadBlob({ blob: new Blob([content], { type: mimeType }), fileName, shareTitle, card: options.card });

    // 1) 原生平台：写缓存 → 取 URI → 调起系统分享面板。
    const nativePlatform = Capacitor.isNativePlatform();
    let nativeFailure: unknown = null;
    if (nativePlatform) {
        try {
            await Filesystem.writeFile({
                path: fileName,
                data: content,
                directory: Directory.Cache,
                encoding: Encoding.UTF8,
            });
            const uriResult = await Filesystem.getUri({
                directory: Directory.Cache,
                path: fileName,
            });
            await Share.share({
                title: shareTitle,
                files: [uriResult.uri],
            });
            return 'shared';
        } catch (e) {
            // 原生插件失败后仍尝试 Web Share；若也不可用则明确报错，不伪装成已下载。
            console.error('Native Export Error', e);
            nativeFailure = e;
        }
    }

    // 2) Web Share API（移动端浏览器 / 支持的 WebView）。
    try {
        const file = new File([content], fileName, { type: mimeType });
        const canShareFile = typeof navigator !== 'undefined'
            && typeof navigator.share === 'function'
            && (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] }));

        if (canShareFile) {
            await navigator.share({
                title: shareTitle,
                files: [file],
            });
            return 'shared';
        }
    } catch (e: any) {
        // 用户取消（AbortError）与不支持的情况都继续走下载兜底，保证一定能拿到文件。
        if (e?.name !== 'AbortError') {
            console.error('Web Share Export Error', e);
        }
    }

    if (nativePlatform) {
        throw nativeFailure instanceof Error ? nativeFailure : new Error('无法拉起系统文件分享');
    }

    // 3) 浏览器下载兜底。
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return 'downloaded';
}
