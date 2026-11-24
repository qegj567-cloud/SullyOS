/**
 * GitHub Releases Client for Cloud Backup
 *
 * Why Releases (not Gist / Contents API):
 *   - Single asset can be up to 2 GB (full backups with media routinely exceed
 *     25 MB, the practical Contents API ceiling).
 *   - Binary upload — no Base64 33% bloat.
 *   - Each backup = one release, so listing/cleanup map cleanly to the same
 *     UX as WebDAV ('cleanupOldBackups keeps latest N').
 *
 * Two transports, mirroring webdavClient.ts:
 *   - Direct: api.github.com and uploads.github.com are contacted separately.
 *     Reachability differs by device, browser/PWA, VPN rules and network; being
 *     able to open github.com or pass token verification proves neither route.
 *   - App-level proxy: after explicit user consent, both requests go through
 *     the configured Cloudflare Worker. This is independent of the system VPN
 *     and can succeed or fail independently too.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';

import { CloudBackupConfig, CloudBackupFile } from '../types';
import { DownloadedBackup, receiveBackupDownload, verifyBackupPart } from './backupDownload';
import { getProxyWorkerUrl } from './proxyWorker';
import { formatTraceBytes, startStepTrace } from './taskTrace';

const API_HOST = 'https://api.github.com';
const UPLOAD_HOST = 'https://uploads.github.com';
const DEFAULT_REPO = 'sully-backup';
const TAG_PREFIX = 'sully-backup-';
const TRANSACTIONAL_TAG_PREFIX = `${TAG_PREFIX}v2-`;
const RELEASE_NAME_PREFIX = 'Sully Backup ';

// 32 MB / 片。备份超过这个体积时会自动切成多个 asset 上传到同一个
// release，恢复时再拼回来。
// Keep every transfer comfortably below both Cloudflare's request-body ceiling
// and its 128 MB isolate memory ceiling. Smaller parts also reduce the native
// Capacitor base64 bridge peak during downloads.
const MAX_PART_SIZE = 32 * 1024 * 1024;
const PART_FILENAME_RE = /^(.+)\.part(\d+)of(\d+)\.zip$/i;
const MANIFEST_SUFFIX = '.sully-backup.json';
const MAX_ASSET_ATTEMPTS = 3;
const MAX_RELEASE_PAGES = 50;
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

type GithubAsset = {
    id: number;
    name: string;
    size: number;
    state?: string;
    digest?: string | null;
    created_at?: string;
    updated_at?: string;
};

type UploadAssetResult = {
    ok: boolean;
    message: string;
    status?: number;
    headers?: Record<string, string>;
    asset?: GithubAsset;
};

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const parseRetryDelay = (headers: Record<string, string> = {}, attempt: number): number => {
    const retryAfter = Number(headers['retry-after']);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        return Math.min(30_000, retryAfter * 1000);
    }
    return Math.min(8_000, 750 * (2 ** attempt));
};

const isRetryableStatus = (status: number | undefined, headers: Record<string, string> = {}): boolean => {
    if (!status) return true;
    if (status === 408 || status === 429 || status >= 500) return true;
    return status === 403 && (Boolean(headers['retry-after']) || headers['x-ratelimit-remaining'] === '0');
};

const isUsableAsset = (asset: any, expectedSize?: number): asset is GithubAsset => {
    if (!asset || !Number.isFinite(Number(asset.id)) || Number(asset.id) <= 0) return false;
    if (asset.state && asset.state !== 'uploaded') return false;
    const size = Number(asset.size);
    if (!Number.isFinite(size) || size <= 0) return false;
    return expectedSize === undefined || size === expectedSize;
};

const isNative = (): boolean => {
    try { return Capacitor.isNativePlatform(); } catch { return false; }
};

// Capacitor 官方文档明确说：Android/iOS 上 CapacitorHttp 的 data 字段只接受
// string 或 JSON。直接塞 Blob / ArrayBuffer，native bridge 会调 .toString()
// 得到 "[object ArrayBuffer]" 之类的垃圾字符串发上去——GitHub 照样回 201
// Created，但 asset 只有几十字节，UI 上看就是 0.0 MB。修法是把二进制转成
// base64 字符串、加上 dataType:'file'，原生层会自己 base64 解码后写原始字节。
//
// 用 FileReader.readAsDataURL 走流式编码，比 btoa(String.fromCharCode(...))
// 抗大文件——后者一次性展开 80MB Uint8Array 当 apply 参数会爆栈。
export const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
        reader.readAsDataURL(blob);
    });

// 安全默认：GitHub 备份优先直连。只有用户在新版风险提示下亲手开启过代理，
// 才允许把 Token 与备份流量交给所选 Worker。consentVersion 会让旧配置里由
// 历史“默认开启”写进去的 githubUseProxy=true 自动失效，所有人重新选择一次。
export const shouldUseGithubProxy = (config: CloudBackupConfig): boolean =>
    config.githubUseProxy === true && config.githubProxyConsentVersion === 1;

const proxify = (url: string): string =>
    `${getProxyWorkerUrl()}/github?url=${encodeURIComponent(url)}`;

/**
 * A browser reports DNS failures, blocked domains, VPN split-routing misses,
 * CORS rejection and some iOS PWA networking failures through the same opaque
 * XHR/fetch error. Do not flatten that into "开梯子"：the GitHub website,
 * REST API, release-upload host and the optional Worker are separate routes.
 */
export const describeGithubUploadTransportFailure = (
    config: CloudBackupConfig,
    kind: 'network' | 'timeout' = 'network',
): string => {
    const prefix = kind === 'timeout' ? '上传超时' : '上传失败：网络请求未完成';
    if (shouldUseGithubProxy(config)) {
        let workerHost = getProxyWorkerUrl();
        try { workerHost = new URL(workerHost).host; } catch { /* keep the configured URL */ }
        return `${prefix}。当前走应用内 Cloudflare 中转（${workerHost}），说明这台设备到中转、`
            + '中转到 GitHub、或大文件传输中的某一段未打通。能打开 github.com、Token 测试通过或开着梯子，'
            + '都不能证明这条上传线路可用。中转能不能连上取决于本机网络：没开梯子的话，请先开梯子再试；'
            + '开着仍然失败，请到「自定义网络代理 (Worker)」检查或更换 Worker'
            + (isNative() ? '，也可关闭中转改试直连。' : '。');
    }
    // uploads.github.com 不回应浏览器的 CORS 预检，网页直连上传必然失败；原生壳走系统网络栈，直连失败才是线路问题
    if (!isNative()) {
        return `${prefix}。网页里不能直连 GitHub 的附件上传域名 uploads.github.com：它不允许网页访问，`
            + '能打开 github.com、api.github.com 测试通过或开着梯子都一样。请到「GitHub 备份 → 高级选项」'
            + '开启“应用内 Cloudflare 中转”后重试。';
    }
    return `${prefix}。当前正在直连 GitHub 附件域名 uploads.github.com；它与 github.com、api.github.com 是不同线路。`
        + '能打开 GitHub、Token 测试通过或开着梯子，都不代表附件域名已被代理接管；请到「GitHub 备份 → 高级选项」'
        + '开启“应用内 Cloudflare 中转”后重试。';
};

const authHeaders = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
});

type GhMethod = 'GET' | 'POST' | 'DELETE' | 'PATCH';
type GhResponse = {
    status: number;
    headers: Record<string, string>;
    text: () => Promise<string>;
    json: () => Promise<any>;
    arrayBuffer: (onProgress?: (loadedBytes: number) => void) => Promise<ArrayBuffer>;
};

const parseXhrHeaders = (raw: string): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
    return headers;
};

const cleanGithubErrorBody = (raw: string): string => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<title\b|<!--)/i.test(trimmed)) {
        const titleMatch = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return title ? `HTML 错误页 (${title.slice(0, 80)})` : 'HTML 错误页';
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim().slice(0, 180);
        if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error.trim().slice(0, 180);
    } catch { /* plain text */ }
    return trimmed.replace(/\s+/g, ' ').trim().slice(0, 180);
};

const describeGithubHttpError = async (stage: string, response: GhResponse): Promise<Error> => {
    let detail = '';
    try {
        const raw = await response.text();
        if (raw) detail = cleanGithubErrorBody(raw);
    } catch { /* response body is only diagnostic */ }

    if (response.status === 401) return new Error(`${stage}失败：GitHub Token 无效或已过期（HTTP 401）。`);
    if (response.status === 403) {
        if (response.headers['retry-after'] || response.headers['x-ratelimit-remaining'] === '0') {
            return new Error(`${stage}失败：GitHub 请求过于频繁，请稍后重试（HTTP 403）。`);
        }
        return new Error(`${stage}失败：Token 没有仓库内容权限（HTTP 403）。`);
    }
    if (response.status === 404) {
        return new Error(`${stage}失败：备份仓库不存在，或 Token 无权访问该私有仓库（HTTP 404）。`);
    }
    if (response.status === 429) return new Error(`${stage}失败：GitHub 请求过于频繁，请稍后重试（HTTP 429）。`);
    return new Error(`${stage}失败（HTTP ${response.status}）${detail ? `：${detail}` : '。'}`);
};

/** Read a fetch response incrementally so large release assets can report
 * real byte progress instead of appearing frozen at the initial 2%. */
export const readResponseArrayBuffer = async (
    response: Pick<Response, 'body' | 'arrayBuffer'>,
    onProgress?: (loadedBytes: number) => void,
): Promise<ArrayBuffer> => {
    if (!onProgress || !response.body) return response.arrayBuffer();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress(loaded);
    }

    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged.buffer;
};

const decodeBinary = (data: any): ArrayBuffer => {
    if (data instanceof ArrayBuffer) return data;
    if (data && data.buffer instanceof ArrayBuffer) return data.buffer;
    if (typeof data === 'string') {
        const bin = atob(data);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out.buffer;
    }
    return new ArrayBuffer(0);
};

/**
 * Single request entry point. Routing priority:
 *   1. useProxy ON  → fetch() via CF Worker (works on both web and native;
 *      WebView fetch handles Blob bodies fine, and going through the Worker
 *      avoids CapacitorHttp's binary-body bridge bug while also helping
 *      users behind the GFW reach github.com).
 *   2. native + useProxy OFF → CapacitorHttp direct (uses OS HTTP stack,
 *      bypasses WebView CORS). For binary uploads, callers (uploadOneAsset)
 *      bypass this and use fetch() directly because CapacitorHttp can't
 *      forward ArrayBuffer/Blob body across the JS↔native bridge.
 *   3. web + useProxy OFF → fetch() direct.
 */
const ghRequest = async (
    config: CloudBackupConfig,
    fullUrl: string,
    method: GhMethod,
    opts: { headers?: Record<string, string>; body?: BodyInit | ArrayBuffer | Blob; binary?: boolean } = {},
): Promise<GhResponse> => {
    const baseHeaders = opts.headers || {};

    if (shouldUseGithubProxy(config)) {
        const headers: Record<string, string> = {
            ...baseHeaders,
            'X-GitHub-Method': method,
        };
        const res = await fetch(proxify(fullUrl), {
            method: 'POST',
            headers,
            body: (opts.body as BodyInit | undefined) ?? null,
        });
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v; });
        return {
            status: res.status,
            headers: respHeaders,
            text: () => res.text(),
            json: () => res.json(),
            arrayBuffer: (onProgress) => readResponseArrayBuffer(res, onProgress),
        };
    }

    if (isNative()) {
        // 仅 useProxy=false 才走到这里。CapacitorHttp 用 OS HTTP 栈，绕过
        // WebView CORS 直连 GitHub。注意：binary 上传不会走到这条路 —
        // uploadOneAsset 的 native 分支专门用 fetch() 处理 Blob body，
        // 因为 CapacitorHttp 不能正确转发二进制 body（桥会 JSON 化）。
        let data: any = undefined;
        let dataType: 'file' | undefined;
        if (opts.body !== undefined && opts.body !== null) {
            if (opts.body instanceof Blob) {
                data = await blobToBase64(opts.body);
                dataType = 'file';
            } else if (opts.body instanceof ArrayBuffer) {
                data = await blobToBase64(new Blob([opts.body]));
                dataType = 'file';
            } else if (typeof opts.body === 'string') {
                data = opts.body;
            } else {
                data = opts.body;
            }
        }
        const response = await CapacitorHttp.request({
            url: fullUrl,
            method,
            headers: baseHeaders,
            data,
            ...(dataType ? { dataType } : {}),
            responseType: opts.binary ? 'arraybuffer' : 'json',
        });
        const respData = response.data;
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(response.headers || {})) {
            respHeaders[k.toLowerCase()] = String(v);
        }
        return {
            status: response.status,
            headers: respHeaders,
            text: async () => (typeof respData === 'string' ? respData : JSON.stringify(respData)),
            json: async () => (typeof respData === 'string' ? JSON.parse(respData || 'null') : respData),
            arrayBuffer: async () => decodeBinary(respData),
        };
    }

    const res = await fetch(fullUrl, {
        method,
        headers: baseHeaders,
        body: (opts.body as BodyInit | undefined) ?? null,
        redirect: 'follow',
    });
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v; });
    return {
        status: res.status,
        headers: respHeaders,
        text: () => res.text(),
        json: () => res.json(),
        arrayBuffer: (onProgress) => readResponseArrayBuffer(res, onProgress),
    };
};

const repoName = (config: CloudBackupConfig): string =>
    (config.githubRepo || DEFAULT_REPO).trim();

/**
 * Step 1: validate the token and learn the user's login (so we don't make
 * the user fill in 'owner' themselves).
 */
export const verifyToken = async (
    token: string,
    useProxyOverride?: boolean,
    proxyConsentVersion?: number,
): Promise<{ ok: boolean; login?: string; message: string }> => {
    try {
        const tempConfig: CloudBackupConfig = {
            enabled: false, webdavUrl: '', username: '', password: '', remotePath: '',
            githubToken: token,
            githubUseProxy: useProxyOverride,
            githubProxyConsentVersion: proxyConsentVersion,
        };
        const res = await ghRequest(tempConfig, `${API_HOST}/user`, 'GET', {
            headers: authHeaders(token),
        });
        if (res.status === 200) {
            const data = await res.json();
            return { ok: true, login: data.login, message: '已连接 GitHub' };
        }
        if (res.status === 401) return { ok: false, message: 'Token 无效或已过期' };
        if (res.status === 403) return { ok: false, message: '权限不足，请确认 Token 勾选了 repo 范围' };
        return { ok: false, message: `GitHub 返回 ${res.status}` };
    } catch (e: any) {
        return { ok: false, message: `连接失败: ${e?.message || '网络错误'}` };
    }
};

/**
 * Step 2: ensure the backup repo exists. If not, auto-create it as private
 * with auto_init=true (we need at least one commit so releases can tag it).
 */
export const ensureRepo = async (config: CloudBackupConfig): Promise<{ ok: boolean; message: string }> => {
    const token = config.githubToken;
    const owner = config.githubOwner;
    const repo = repoName(config);
    if (!token || !owner) return { ok: false, message: 'Token 或用户名未设置' };

    try {
        const get = await ghRequest(config, `${API_HOST}/repos/${owner}/${repo}`, 'GET', {
            headers: authHeaders(token),
        });
        if (get.status === 200) return { ok: true, message: '仓库已就绪' };
        if (get.status !== 404) return { ok: false, message: `检查仓库失败 (${get.status})` };

        const create = await ghRequest(config, `${API_HOST}/user/repos`, 'POST', {
            headers: authHeaders(token, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                name: repo,
                description: 'Sully 自动备份仓库',
                private: true,
                auto_init: true,
            }),
        });
        if (create.status === 201) return { ok: true, message: '已自动创建私有仓库' };
        if (create.status === 422) return { ok: false, message: `仓库名 "${repo}" 已被占用，请换一个` };
        if (create.status === 403) return { ok: false, message: '权限不足，Token 需要 repo 范围' };
        return { ok: false, message: `创建仓库失败 (${create.status})` };
    } catch (e: any) {
        return { ok: false, message: `连接失败: ${e?.message || '网络错误'}` };
    }
};

/**
 * Combines verifyToken + ensureRepo for the one-click connect flow.
 * Returns the resolved owner so the caller can persist it.
 */
export const testConnection = async (
    config: CloudBackupConfig,
): Promise<{ ok: boolean; message: string; login?: string }> => {
    const token = config.githubToken;
    if (!token) return { ok: false, message: '请先填写 Token' };

    const ver = await verifyToken(token, config.githubUseProxy, config.githubProxyConsentVersion);
    if (!ver.ok) return { ok: false, message: ver.message };

    const cfg = { ...config, githubOwner: ver.login };
    const repo = await ensureRepo(cfg);
    if (!repo.ok) return { ok: false, message: repo.message, login: ver.login };

    return { ok: true, message: `已连接 @${ver.login} → ${repoName(cfg)}`, login: ver.login };
};

/**
 * Upload one blob as a single asset on an existing release. Extracted so
 * uploadBackup() can call this once for small backups or N times for
 * multi-part backups. onFraction is 0..1 of this single asset's progress.
 */
const uploadOneAsset = async (
    config: CloudBackupConfig,
    releaseId: number,
    blob: Blob,
    assetName: string,
    onFraction?: (frac: number) => void,
    contentType: string = 'application/zip',
): Promise<UploadAssetResult> => {
    const token = config.githubToken!;
    const owner = config.githubOwner!;
    const repo = repoName(config);
    const url = `${UPLOAD_HOST}/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;

    if (isNative()) {
        // CapacitorHttp 在原生这边不能正确转发二进制 body — 把 Blob/ArrayBuffer
        // 通过 JS↔native 桥传过去，桥会尝试 JSON 化导致 upstream 收到 0 字节体，
        // GitHub 还是 201 创建了 asset，但 size = 0（用户看到的就是 0.0 MB）。
        // WebView 自带的 fetch() 可以直接处理 Blob body；是否真的能触达
        // uploads.github.com 仍取决于设备网络、VPN/PWA 接管和服务端跨域行为。
        // useProxy 决定走应用内 Worker 还是直连。
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), UPLOAD_TIMEOUT_MS);
        try {
            const targetUrl = shouldUseGithubProxy(config) ? proxify(url) : url;
            const headers: Record<string, string> = {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': contentType,
            };
            if (shouldUseGithubProxy(config)) headers['X-GitHub-Method'] = 'POST';
            const res = await fetch(targetUrl, {
                method: 'POST',
                headers,
                body: blob,
                signal: abortController.signal,
            });
            onFraction?.(1);
            const responseHeaders: Record<string, string> = {};
            res.headers.forEach((value, key) => { responseHeaders[key.toLowerCase()] = value; });
            if (res.status === 201) {
                let asset: GithubAsset | undefined;
                try { asset = await res.json(); } catch { /* reconciled by caller */ }
                if (isUsableAsset(asset, blob.size)) {
                    return { ok: true, message: '上传成功', status: res.status, headers: responseHeaders, asset };
                }
                return {
                    ok: false,
                    status: res.status,
                    headers: responseHeaders,
                    message: 'GitHub 已创建附件，但附件状态或大小不正确',
                };
            }
            const text = await res.text();
            const summary = cleanGithubErrorBody(text);
            return {
                ok: false,
                status: res.status,
                headers: responseHeaders,
                message: `上传失败 (${res.status})${summary ? `: ${summary.slice(0, 120)}` : ''}`,
            };
        } catch (e: any) {
            const kind = e?.name === 'AbortError' ? 'timeout' : 'network';
            return { ok: false, message: describeGithubUploadTransportFailure(config, kind) };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    return new Promise((resolve) => {
        const targetUrl = shouldUseGithubProxy(config) ? proxify(url) : url;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', targetUrl);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.setRequestHeader('Accept', 'application/vnd.github+json');
        xhr.setRequestHeader('Content-Type', contentType);
        if (shouldUseGithubProxy(config)) xhr.setRequestHeader('X-GitHub-Method', 'POST');
        xhr.timeout = UPLOAD_TIMEOUT_MS;
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onFraction?.(e.loaded / e.total);
        };
        xhr.onload = () => {
            onFraction?.(1);
            const headers = parseXhrHeaders(xhr.getAllResponseHeaders());
            if (xhr.status === 201) {
                let asset: GithubAsset | undefined;
                try { asset = JSON.parse(xhr.responseText || 'null'); } catch { /* reconciled by caller */ }
                if (isUsableAsset(asset, blob.size)) {
                    resolve({ ok: true, message: '上传成功', status: xhr.status, headers, asset });
                } else {
                    resolve({
                        ok: false,
                        status: xhr.status,
                        headers,
                        message: 'GitHub 已创建附件，但附件状态或大小不正确',
                    });
                }
            } else {
                const summary = cleanGithubErrorBody(xhr.responseText || '');
                console.warn(`[GitHubBackup] 分片上传失败 (HTTP ${xhr.status}):`, summary || xhr.status);
                resolve({
                    ok: false,
                    status: xhr.status,
                    headers,
                    message: `上传失败 (${xhr.status})${summary ? `: ${summary.slice(0, 120)}` : ''}`,
                });
            }
        };
        xhr.onerror = () => resolve({ ok: false, message: describeGithubUploadTransportFailure(config) });
        xhr.onabort = () => resolve({ ok: false, message: '上传已取消' });
        xhr.ontimeout = () => resolve({ ok: false, message: describeGithubUploadTransportFailure(config, 'timeout') });
        xhr.send(blob);
    });
};

const listReleaseAssets = async (
    config: CloudBackupConfig,
    releaseId: number,
): Promise<GithubAsset[]> => {
    const token = config.githubToken!;
    const owner = config.githubOwner!;
    const repo = repoName(config);
    const assets: GithubAsset[] = [];
    for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
        const response = await ghRequest(
            config,
            `${API_HOST}/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`,
            'GET',
            { headers: authHeaders(token) },
        );
        if (response.status !== 200) throw await describeGithubHttpError('读取 GitHub 附件', response);
        const current: GithubAsset[] = await response.json();
        assets.push(...current);
        if (current.length < 100) return assets;
    }
    throw new Error('这个 GitHub Release 的附件过多，无法安全完成备份。');
};

const deleteReleaseAsset = async (
    config: CloudBackupConfig,
    assetId: number,
): Promise<boolean> => {
    const token = config.githubToken!;
    const owner = config.githubOwner!;
    const repo = repoName(config);
    const response = await ghRequest(
        config,
        `${API_HOST}/repos/${owner}/${repo}/releases/assets/${assetId}`,
        'DELETE',
        { headers: authHeaders(token) },
    );
    return response.status === 204 || response.status === 404;
};

/**
 * A failed upload can still leave a GitHub `starter` asset, and a lost client
 * response can hide an upload that actually completed. Reconcile by name
 * before retrying so we neither duplicate nor discard a valid part.
 */
const reconcileAsset = async (
    config: CloudBackupConfig,
    releaseId: number,
    assetName: string,
    expectedSize: number,
): Promise<GithubAsset | null> => {
    const matches = (await listReleaseAssets(config, releaseId)).filter(asset => asset.name === assetName);
    const usable = matches.find(asset => isUsableAsset(asset, expectedSize));
    if (usable) return usable;
    for (const asset of matches) {
        await deleteReleaseAsset(config, asset.id).catch(() => false);
    }
    return null;
};

const uploadAssetWithRetry = async (
    config: CloudBackupConfig,
    releaseId: number,
    blob: Blob,
    assetName: string,
    onFraction?: (frac: number) => void,
    contentType: string = 'application/zip',
): Promise<UploadAssetResult> => {
    let lastResult: UploadAssetResult = { ok: false, message: '上传失败' };
    for (let attempt = 0; attempt < MAX_ASSET_ATTEMPTS; attempt++) {
        lastResult = await uploadOneAsset(config, releaseId, blob, assetName, onFraction, contentType);
        if (lastResult.ok) return lastResult;

        try {
            const existing = await reconcileAsset(config, releaseId, assetName, blob.size);
            if (existing) {
                onFraction?.(1);
                return { ok: true, message: '上传成功', asset: existing, status: 201 };
            }
        } catch {
            // Keep the original upload error. The whole draft release will be
            // rolled back if this attempt ultimately cannot be recovered.
        }

        // A 201 response with an invalid/starter asset is also retryable after
        // reconciliation removed that unusable asset.
        const retryable = lastResult.status === 201 || isRetryableStatus(lastResult.status, lastResult.headers);
        if (attempt >= MAX_ASSET_ATTEMPTS - 1 || !retryable) break;
        await delay(parseRetryDelay(lastResult.headers, attempt));
    }
    return lastResult;
};

const deleteReleaseAndTag = async (
    config: CloudBackupConfig,
    releaseId: number,
    tagName?: string | null,
): Promise<boolean> => {
    const token = config.githubToken;
    const owner = config.githubOwner;
    const repo = repoName(config);
    if (!token || !owner || !releaseId) return false;

    try {
        const response = await ghRequest(
            config,
            `${API_HOST}/repos/${owner}/${repo}/releases/${releaseId}`,
            'DELETE',
            { headers: authHeaders(token) },
        );
        if (response.status !== 204 && response.status !== 404) return false;
        if (tagName) {
            await ghRequest(
                config,
                `${API_HOST}/repos/${owner}/${repo}/git/refs/tags/${encodeURIComponent(tagName)}`,
                'DELETE',
                { headers: authHeaders(token) },
            ).catch(() => undefined);
        }
        return true;
    } catch {
        return false;
    }
};

/**
 * Upload a backup as one (or several) Release assets.
 *
 * Flow:
 *   1. POST /releases  → get release_id
 *   2. If blob ≤ MAX_PART_SIZE: POST one asset → done.
 *      Else: slice the blob into N parts of MAX_PART_SIZE each, name them
 *      `{base}.part{NN}of{NN}.zip`, upload each as a separate asset on the
 *      same release. Restore detects the partN naming and re-stitches them.
 *
 * Why this exists: Cloudflare Worker free tier caps each request body at
 * ~100MB, so users who go through the proxy (most mainland users) couldn't
 * upload a >100MB full backup. Splitting bypasses the limit cleanly without
 * needing harsher compression.
 */
export const uploadBackup = async (
    config: CloudBackupConfig,
    blob: Blob,
    filename: string,
    onProgress?: (percent: number) => void,
): Promise<{ ok: boolean; message: string }> => {
    const token = config.githubToken;
    const owner = config.githubOwner;
    const repo = repoName(config);
    if (!token || !owner) return { ok: false, message: '未连接 GitHub' };

    let releaseId = 0;
    let tag = '';
    // 中断留痕（utils/taskTrace.ts）：只有上传途中页面没了才留下来，正常结束、报错结束都在 finally 删掉。
    const trace = startStepTrace('cloudUpload', { 云端: 'GitHub', 备份大小: formatTraceBytes(blob.size) });
    try {
        onProgress?.(2);
        trace.step('创建备份草稿');
        const ts = Date.now();
        tag = `${TRANSACTIONAL_TAG_PREFIX}${ts}`;
        const releaseName = `${RELEASE_NAME_PREFIX}${new Date(ts).toISOString()}`;
        const releaseBody = `自动备份 · ${new Date(ts).toLocaleString('zh-CN')}\n\nSully backup transaction v2`;
        const releaseRes = await ghRequest(config, `${API_HOST}/repos/${owner}/${repo}/releases`, 'POST', {
            headers: authHeaders(token, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                tag_name: tag,
                name: releaseName,
                body: releaseBody,
                draft: true,
                prerelease: true,
            }),
        });
        if (releaseRes.status !== 201) {
            throw await describeGithubHttpError('创建 GitHub 备份草稿', releaseRes);
        }
        const release = await releaseRes.json();
        releaseId = Number(release.id);
        if (!releaseId) throw new Error('GitHub 没有返回有效的 Release 标识。');

        onProgress?.(5);
        const totalParts = Math.max(1, Math.ceil(blob.size / MAX_PART_SIZE));
        trace.note({ 分片数: totalParts });
        const baseName = filename.replace(/\.zip$/i, '');
        const padWidth = String(totalParts).length;
        const span = 86 / Math.max(1, totalParts);
        const uploadedAssets: GithubAsset[] = [];

        for (let i = 0; i < totalParts; i++) {
            const start = i * MAX_PART_SIZE;
            const end = Math.min(start + MAX_PART_SIZE, blob.size);
            const partBlob = blob.slice(start, end, 'application/zip');
            const partName = totalParts === 1
                ? filename
                : `${baseName}.part${String(i + 1).padStart(padWidth, '0')}of${String(totalParts).padStart(padWidth, '0')}.zip`;

            const base = 5 + i * span;
            const partStep = `上传第 ${i + 1} / ${totalParts} 片`;
            trace.step(partStep, start, blob.size, 'B');
            const result = await uploadAssetWithRetry(config, releaseId, partBlob, partName, (frac) => {
                onProgress?.(Math.min(91, Math.floor(base + frac * span)));
                trace.step(partStep, start + Math.floor(frac * (end - start)), blob.size, 'B');
            });
            if (!result.ok || !result.asset) {
                throw new Error(`第 ${i + 1}/${totalParts} 片失败：${result.message}`);
            }
            uploadedAssets.push(result.asset);
        }

        // The manifest is deliberately uploaded last. Its presence marks a
        // release whose every data part was acknowledged with the right size.
        const manifest = {
            schemaVersion: 2,
            filename,
            size: blob.size,
            createdAt: ts,
            parts: uploadedAssets.map(asset => ({
                id: asset.id,
                name: asset.name,
                size: asset.size,
                digest: asset.digest || undefined,
            })),
        };
        const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
        const manifestName = `${baseName}${MANIFEST_SUFFIX}`;
        trace.step('写入完成标记');
        const manifestResult = await uploadAssetWithRetry(
            config,
            releaseId,
            manifestBlob,
            manifestName,
            frac => onProgress?.(91 + Math.floor(frac * 5)),
            'application/json',
        );
        if (!manifestResult.ok || !manifestResult.asset) {
            throw new Error(`写入完成标记失败：${manifestResult.message}`);
        }

        trace.step('发布备份');
        const publish = await ghRequest(
            config,
            `${API_HOST}/repos/${owner}/${repo}/releases/${releaseId}`,
            'PATCH',
            {
                headers: authHeaders(token, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    name: releaseName,
                    body: releaseBody,
                    draft: false,
                    prerelease: true,
                }),
            },
        );
        if (publish.status !== 200) throw await describeGithubHttpError('发布 GitHub 备份', publish);

        onProgress?.(100);
        return {
            ok: true,
            message: totalParts > 1 ? `分片上传成功（${totalParts} 片）` : '上传成功',
        };
    } catch (e: any) {
        const reason = e?.message || '未知错误';
        if (releaseId) {
            const cleaned = await deleteReleaseAndTag(config, releaseId, tag);
            return {
                ok: false,
                message: `上传失败：${reason}${cleaned ? '；未完成的 GitHub 草稿已清理。' : '；未完成草稿未能自动清理，可在恢复列表中查看。'}`,
            };
        }
        return { ok: false, message: `上传失败：${reason}` };
    } finally {
        trace.clear();
    }
};

/**
 * Each release with assets is one logical "backup file". For multi-part
 * uploads (.partNNofMM.zip), we group siblings on the same release and
 * expose one entry whose href carries all asset IDs (comma-separated, in
 * part order) so downloadBackup can fetch + stitch without a second
 * listing round-trip.
 *
 * href format:
 *   single-part: '{releaseId}:{assetId}'
 *   multi-part:  '{releaseId}:{assetId1},{assetId2},...'  (already in part order)
 */
export const listBackups = async (config: CloudBackupConfig): Promise<CloudBackupFile[]> => {
    const token = config.githubToken;
    const owner = config.githubOwner;
    const repo = repoName(config);
    if (!token || !owner) throw new Error('GitHub 配置不完整，请先重新测试并连接账号。');

    try {
        const releases: any[] = [];
        for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
            const res = await ghRequest(
                config,
                `${API_HOST}/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
                'GET',
                { headers: authHeaders(token) },
            );
            if (res.status !== 200) throw await describeGithubHttpError('读取 GitHub 备份列表', res);
            const current = await res.json();
            if (!Array.isArray(current)) throw new Error('GitHub 返回了无法识别的备份列表。');
            releases.push(...current);
            if (current.length < 100) break;
            if (page === MAX_RELEASE_PAGES) {
                throw new Error('GitHub 备份 Release 数量过多，请先整理仓库后重试。');
            }
        }

        const files: CloudBackupFile[] = [];
        for (const rel of releases) {
            if (!rel.tag_name?.startsWith(TAG_PREFIX)) continue;
            const isTransactional = rel.tag_name.startsWith(TRANSACTIONAL_TAG_PREFIX);
            let assets = Array.isArray(rel.assets) ? rel.assets : [];
            let hasCompletionManifest = assets.some((asset: any) =>
                typeof asset?.name === 'string'
                && asset.name.endsWith(MANIFEST_SUFFIX)
                && isUsableAsset(asset)
            );
            // The assets embedded in a release response can be truncated for
            // large, heavily-split backups. Resolve the release's paginated
            // asset endpoint before declaring parts or the manifest missing.
            if (assets.length >= 30 || (isTransactional && !rel.draft && !hasCompletionManifest)) {
                assets = await listReleaseAssets(config, Number(rel.id));
                hasCompletionManifest = assets.some((asset: any) =>
                    typeof asset?.name === 'string'
                    && asset.name.endsWith(MANIFEST_SUFFIX)
                    && isUsableAsset(asset)
                );
            }

            // Group multi-part siblings by their stripped basename.
            type PartInfo = { idx: number; asset: any };
            const groups = new Map<string, { parts: PartInfo[]; total: number; totalMismatch: boolean }>();
            for (const asset of assets) {
                if (!/\.zip$/i.test(asset.name || '')) continue;
                const m = asset.name.match(PART_FILENAME_RE);
                if (m) {
                    const display = `${m[1]}.zip`;
                    const idx = parseInt(m[2], 10);
                    const total = parseInt(m[3], 10);
                    if (!groups.has(display)) groups.set(display, { parts: [], total, totalMismatch: false });
                    const group = groups.get(display)!;
                    if (group.total !== total) group.totalMismatch = true;
                    group.parts.push({ idx, asset });
                } else {
                    groups.set(asset.name, { parts: [{ idx: 1, asset }], total: 1, totalMismatch: false });
                }
            }

            if (groups.size === 0) {
                files.push({
                    name: rel.name || rel.tag_name || '未完成的 GitHub 备份',
                    size: 0,
                    lastModified: rel.updated_at || rel.created_at || '',
                    href: `${rel.id}:`,
                    status: 'incomplete',
                    statusMessage: rel.draft ? '上传中断：Release 仍是草稿且没有可用附件' : '上传未完成：没有可用的 ZIP 附件',
                });
                continue;
            }

            for (const [name, group] of groups) {
                group.parts.sort((a, b) => a.idx - b.idx);
                const indexes = new Set(group.parts.map(part => part.idx));
                const hasEveryIndex = group.total > 0
                    && indexes.size === group.total
                    && Array.from({ length: group.total }, (_, index) => index + 1).every(index => indexes.has(index));
                const assetsReady = group.parts.every(part => isUsableAsset(part.asset));
                const isComplete = !rel.draft
                    && !group.totalMismatch
                    && group.parts.length === group.total
                    && hasEveryIndex
                    && assetsReady
                    && (!isTransactional || hasCompletionManifest);
                const totalSize = group.parts.reduce((sum, part) => sum + Math.max(0, Number(part.asset.size) || 0), 0);
                const ids = group.parts.map(p => p.asset.id).join(',');
                const lastModified = group.parts[group.parts.length - 1].asset.updated_at || rel.created_at || '';
                const incompleteReasons: string[] = [];
                if (rel.draft) incompleteReasons.push('Release 仍是草稿');
                if (group.totalMismatch || !hasEveryIndex || group.parts.length !== group.total) {
                    incompleteReasons.push(`分片不完整（${indexes.size}/${group.total || '?'}）`);
                }
                if (!assetsReady) incompleteReasons.push('包含 0 字节或 GitHub 未完成附件');
                if (isTransactional && !hasCompletionManifest) incompleteReasons.push('缺少完成标记');
                files.push({
                    name,
                    size: totalSize,
                    lastModified,
                    href: `${rel.id}:${ids}`,
                    status: isComplete ? 'ready' : 'incomplete',
                    statusMessage: isComplete ? undefined : `上传未完成：${incompleteReasons.join('；') || '附件状态异常'}`,
                    partSizes: group.parts.map(part => Math.max(0, Number(part.asset.size) || 0)),
                    partDigests: group.parts.map(part => (typeof part.asset.digest === 'string' ? part.asset.digest : undefined)),
                });
            }
        }
        files.sort((a, b) => String(b.lastModified || '').localeCompare(String(a.lastModified || '')));
        return files;
    } catch (error: any) {
        if (error instanceof Error && error.message) throw error;
        throw new Error(`读取 GitHub 备份列表失败：${String(error || '未知错误')}`);
    }
};

/**
 * Asset download: GET /releases/assets/{id} with Accept:octet-stream returns
 * a 302 to a signed CDN URL. fetch() with redirect:'follow' handles it on
 * web; CapacitorHttp follows redirects by default.
 *
 * For multi-part backups, href is 'releaseId:id1,id2,id3,...'. We download
 * each part sequentially and append it to one download file — bytes line up
 * directly because uploadBackup used Blob.slice() with no envelope/header.
 */
const downloadAssetPart = async (
    config: CloudBackupConfig,
    assetId: number,
    expectedSize: number | undefined,
    expectedDigest: string | undefined,
    label: string,
    onPartProgress?: (loadedBytes: number) => void,
): Promise<Uint8Array<ArrayBuffer>> => {
    const token = config.githubToken!;
    const owner = config.githubOwner!;
    const repo = repoName(config);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_ASSET_ATTEMPTS; attempt++) {
        try {
            const response = await ghRequest(
                config,
                `${API_HOST}/repos/${owner}/${repo}/releases/assets/${assetId}`,
                'GET',
                {
                    headers: authHeaders(token, { Accept: 'application/octet-stream' }),
                    binary: true,
                },
            );
            if (response.status !== 200 && response.status !== 206) {
                lastError = await describeGithubHttpError('下载 GitHub 备份附件', response);
                if (attempt < MAX_ASSET_ATTEMPTS - 1 && isRetryableStatus(response.status, response.headers)) {
                    await delay(parseRetryDelay(response.headers, attempt));
                    continue;
                }
                throw lastError;
            }

            const bytes = new Uint8Array(await response.arrayBuffer(onPartProgress));
            try {
                await verifyBackupPart(bytes, {
                    label,
                    size: expectedSize || undefined,
                    digest: expectedDigest,
                });
            } catch (mismatch: any) {
                lastError = mismatch;
                if (attempt < MAX_ASSET_ATTEMPTS - 1) {
                    await delay(750 * (attempt + 1));
                    continue;
                }
                throw lastError;
            }
            if (bytes.byteLength === 0) throw new Error('GitHub 返回了 0 字节备份附件。');
            return bytes;
        } catch (error: any) {
            lastError = error instanceof Error ? error : new Error(String(error || '下载失败'));
            if (attempt >= MAX_ASSET_ATTEMPTS - 1) break;
            if (!/network|fetch|连接|超时/i.test(lastError.message)) throw lastError;
            await delay(750 * (attempt + 1));
        }
    }
    throw lastError || new Error('下载 GitHub 备份附件失败。');
};

export const downloadBackup = async (
    config: CloudBackupConfig,
    file: CloudBackupFile,
    onProgress?: (percent: number) => void,
): Promise<DownloadedBackup | null> => {
    const token = config.githubToken;
    const owner = config.githubOwner;
    const repo = repoName(config);
    if (!token || !owner) {
        throw new Error('GitHub 配置不完整，请先重新测试并连接账号。');
    }
    if (file.status === 'incomplete') {
        throw new Error(file.statusMessage || '这个 GitHub 备份上传未完成，不能恢复。');
    }

    const [, idsStr] = file.href.split(':');
    const assetIds = (idsStr || '').split(',').map(s => Number(s)).filter(n => n > 0);
    if (assetIds.length === 0) {
        throw new Error('这个备份缺少有效的 GitHub 附件标识，请刷新备份列表后重试。');
    }

    const trace = startStepTrace('cloudDownload', { 云端: 'GitHub', 备份大小: formatTraceBytes(Number(file.size) || 0), 分片数: assetIds.length });
    try {
        onProgress?.(2);
        let downloadedBytes = 0;
        const totalBytes = Math.max(0, Number(file.size) || 0);
        const span = 96 / assetIds.length;
        const backup = await receiveBackupDownload(async sink => {
            for (let i = 0; i < assetIds.length; i++) {
                const completedBeforePart = downloadedBytes;
                const label = `GitHub 备份第 ${i + 1}/${assetIds.length} 片`;
                const partStep = `下载第 ${i + 1} / ${assetIds.length} 片`;
                trace.step(partStep, downloadedBytes, totalBytes || undefined, 'B');
                const bytes = await downloadAssetPart(config, assetIds[i], file.partSizes?.[i], file.partDigests?.[i], label, (partLoadedBytes) => {
                    trace.step(partStep, completedBeforePart + partLoadedBytes, totalBytes || undefined, 'B');
                    if (totalBytes > 0) {
                        const byteFraction = Math.min(1, (completedBeforePart + partLoadedBytes) / totalBytes);
                        onProgress?.(Math.min(98, Math.max(2, Math.floor(2 + byteFraction * 96))));
                    }
                });
                await sink.write(bytes);
                downloadedBytes += bytes.byteLength;
                onProgress?.(totalBytes > 0
                    ? Math.min(99, Math.floor(2 + Math.min(1, downloadedBytes / totalBytes) * 96))
                    : Math.min(99, Math.floor(2 + (i + 1) * span)));
            }
        }, totalBytes || undefined, trace);
        onProgress?.(100);
        return backup;
    } catch (error: any) {
        if (
            !shouldUseGithubProxy(config)
            && !isNative()
            && (error instanceof TypeError || /failed to fetch/i.test(String(error?.message || '')))
        ) {
            throw new Error(
                // 附件下载会被重定向到 release-assets.githubusercontent.com，那边不带 CORS 头，网页直连必然读不到
                '网页里不能直接下载 GitHub 的备份附件：GitHub 存放附件的服务器不允许网页读取，开着梯子也一样。'
                + '请到「云端备份 → GitHub → 高级选项」手动开启应用内 Cloudflare 中转后重试；应用不会自动开启。',
            );
        }
        // 中转只解决「网页不能直连」，本机到中转这一段照样可能不通
        if (
            shouldUseGithubProxy(config)
            && (error instanceof TypeError || /failed to fetch/i.test(String(error?.message || '')))
        ) {
            throw new Error(
                '经应用内 Cloudflare 中转下载 GitHub 备份失败：这台设备没连上中转，或者传输中途断了。'
                + '中转能不能连上取决于本机网络：没开梯子的话，请先开梯子再试；'
                + '开着仍然失败，请到「自定义网络代理 (Worker)」检查或更换 Worker。',
            );
        }
        if (error instanceof Error) throw error;
        throw new Error(`GitHub 附件下载失败：${String(error || '未知错误')}`);
    } finally {
        trace.clear();
    }
};

/**
 * Delete = DELETE the release. GitHub keeps the underlying tag dangling, so
 * we delete the tag too via /git/refs to keep the repo tidy.
 */
export const deleteBackup = async (
    config: CloudBackupConfig,
    file: CloudBackupFile,
): Promise<boolean> => {
    const token = config.githubToken;
    const owner = config.githubOwner;
    const repo = repoName(config);
    if (!token || !owner) return false;

    const [releaseIdStr] = file.href.split(':');
    const releaseId = Number(releaseIdStr);
    if (!releaseId) return false;

    try {
        let tagName: string | null = null;
        try {
            const meta = await ghRequest(config, `${API_HOST}/repos/${owner}/${repo}/releases/${releaseId}`, 'GET', {
                headers: authHeaders(token),
            });
            if (meta.status === 200) {
                const data = await meta.json();
                tagName = data.tag_name || null;
            }
        } catch { /* non-fatal */ }
        return deleteReleaseAndTag(config, releaseId, tagName);
    } catch {
        return false;
    }
};

export const cleanupOldBackups = async (
    config: CloudBackupConfig,
    keepCount: number = 5,
): Promise<number> => {
    // Interrupted releases remain visible for manual repair/removal, but are
    // never counted as successful backups and are never auto-deleted.
    const files = (await listBackups(config)).filter(file => file.status !== 'incomplete');
    if (files.length <= keepCount) return 0;
    let deleted = 0;
    for (const file of files.slice(keepCount)) {
        if (await deleteBackup(config, file)) deleted++;
    }
    return deleted;
};
