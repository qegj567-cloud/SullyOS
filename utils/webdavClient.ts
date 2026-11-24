/**
 * WebDAV Client for Cloud Backup
 *
 * Supports: 坚果云 (Nutstore), Nextcloud, Synology NAS, TeraCloud, Box, etc.
 *
 * Two transports:
 *   - Native (Capacitor Android/iOS): hits the WebDAV server directly via
 *     CapacitorHttp, which uses the OS HTTP stack and bypasses CORS. No
 *     Cloudflare Worker request quota burned, no extra hop.
 *   - Web: routes POST + X-WebDAV-Method through the sully-n CF Worker so the
 *     browser CORS preflight passes (TeraCloud / infini-cloud / NAS don't
 *     return CORS headers).
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { formatUnknownError } from './errorSelfCheck';
import { summarizeHtmlErrorBody } from './networkFailureDiagnosis';

import { CloudBackupConfig, CloudBackupFile } from '../types';
import { BackupSpaceError, DownloadedBackup, receiveBackupDownload } from './backupDownload';
import { getProxyWorkerUrl } from './proxyWorker';
import { formatTraceBytes, startStepTrace, type StepTraceWriter } from './taskTrace';
import { blobToBase64 } from './githubClient';

// 经 CF Worker 代理上传（web 路径）的请求体上限。Cloudflare Worker 免费版单次请求体约 100MB，
// 超了会被 Worker/平台直接拒（返回 413 之类），且大请求体上行还可能撞 ~42s 上行超时。所以在发起
// 上传前先按 blob 大小预检：超限直接给可执行的报错（改用本地导出 / GitHub），别让用户傻等几十秒
// 才失败。备份 blob 已是压缩 zip，gzip 上行无意义，这里只做大小闸。
// 注：native 路径（CapacitorHttp 直连上游 WebDAV，不过 Worker）不受此限，上游各家容量不一，
// 由响应状态兜底；native 端要把整个 blob 转成 base64 字符串过桥（约 1.33 倍体积）是已知内存开销，
// 彻底解需改「先落临时文件再按路径 PUT」，列为 follow-up。
const WORKER_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const formatMiB = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

const isNative = (): boolean => {
    try {
        return Capacitor.isNativePlatform();
    } catch {
        return false;
    }
};

const buildFullUrl = (webdavUrl: string, path: string): string =>
    webdavUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');

const buildProxyUrl = (fullUrl: string): string =>
    `${getProxyWorkerUrl()}/webdav?url=${encodeURIComponent(fullUrl)}`;

const buildAuthHeader = (config: CloudBackupConfig): string =>
    `Basic ${btoa(`${config.username}:${config.password}`)}`;

type WebdavMethod = 'GET' | 'HEAD' | 'PUT' | 'PROPFIND' | 'MKCOL' | 'DELETE';
type WebdavOptions = {
    range?: string;
    depth?: '0' | '1';
    contentType?: string;
    body?: string | ArrayBuffer | Blob;
};
type WebdavResponse = {
    status: number;
    /** 仅原生端有：CapacitorHttp 原样带回的响应头，键名大小写随服务器。 */
    headers?: Record<string, string>;
    text: () => Promise<string>;
    arrayBuffer: () => Promise<ArrayBuffer>;
    /** 仅网页端有：响应体的流，大文件按它逐块落盘。 */
    body?: ReadableStream<Uint8Array<ArrayBuffer>> | null;
};

// Android's HttpURLConnection (which CapacitorHttp uses under the hood) rejects
// non-standard HTTP verbs like PROPFIND and MKCOL with `ProtocolException`.
// Standard verbs go direct on native; the rest fall back to the Worker, which
// is fine because PROPFIND/MKCOL responses are <1 KB.
const NATIVE_DIRECT_METHODS: ReadonlySet<WebdavMethod> = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

const decodeBinaryFromCapacitor = (data: any): ArrayBuffer => {
    if (data instanceof ArrayBuffer) return data;
    if (data && data.buffer instanceof ArrayBuffer) return data.buffer;
    if (typeof data === 'string') {
        // Capacitor encodes binary as base64 for the JS bridge
        const bin = atob(data);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out.buffer;
    }
    return new ArrayBuffer(0);
};

const webdavRequest = async (
    config: CloudBackupConfig,
    path: string,
    method: WebdavMethod,
    opts: WebdavOptions = {},
): Promise<WebdavResponse> => {
    const fullUrl = buildFullUrl(config.webdavUrl, path);
    const auth = buildAuthHeader(config);

    if (isNative() && NATIVE_DIRECT_METHODS.has(method)) {
        const headers: Record<string, string> = { Authorization: auth };
        if (opts.range) headers['Range'] = opts.range;
        if (opts.depth) headers['Depth'] = opts.depth;
        if (opts.contentType) headers['Content-Type'] = opts.contentType;

        // 原生桥把 options JSON.stringify 后交给 Java，ArrayBuffer 会变成 "{}" 被原样写进请求体；
        // 二进制必须转 base64 并标 dataType:'file'，原生层才会解码成原始字节。
        let data: any = undefined;
        let dataType: 'file' | undefined;
        if (opts.body !== undefined && opts.body !== null) {
            if (typeof opts.body === 'string') {
                data = opts.body;
            } else {
                data = await blobToBase64(opts.body instanceof Blob ? opts.body : new Blob([opts.body]));
                dataType = 'file';
            }
        }

        const isBinaryGet = method === 'GET';
        const response = await CapacitorHttp.request({
            url: fullUrl,
            method,
            headers,
            data,
            ...(dataType ? { dataType } : {}),
            responseType: isBinaryGet ? 'arraybuffer' : 'text',
        });

        const respData = response.data;
        return {
            status: response.status,
            headers: response.headers,
            text: async () => (typeof respData === 'string' ? respData : ''),
            arrayBuffer: async () => decodeBinaryFromCapacitor(respData),
        };
    }

    // Web path → POST through Worker, real method goes in X-WebDAV-Method
    const url = buildProxyUrl(fullUrl);
    const headers: Record<string, string> = {
        Authorization: auth,
        'X-WebDAV-Method': method,
    };
    if (opts.range) headers['X-WebDAV-Range'] = opts.range;
    if (opts.depth) headers['X-WebDAV-Depth'] = opts.depth;
    if (opts.contentType) headers['Content-Type'] = opts.contentType;

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: (opts.body as BodyInit | undefined) ?? null,
    });
    return {
        status: res.status,
        text: () => res.text(),
        arrayBuffer: () => res.arrayBuffer(),
        body: res.body,
    };
};

/**
 * Test WebDAV connection by doing a PROPFIND on the remote path
 */
export const testConnection = async (config: CloudBackupConfig): Promise<{ ok: boolean; message: string }> => {
    try {
        const res = await webdavRequest(config, config.remotePath, 'PROPFIND', {
            depth: '0',
            contentType: 'application/xml; charset=utf-8',
            body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
        });

        if (res.status === 207 || res.status === 200) return { ok: true, message: '连接成功' };
        if (res.status === 401) return { ok: false, message: '认证失败：请检查用户名和应用密码 (HTTP 401)' };
        if (res.status === 403) return { ok: false, message: '权限不足：请检查应用密码读写权限或备份路径 (HTTP 403)' };
        if (res.status === 404) {
            const mkcolOk = await createDirectory(config);
            if (mkcolOk) return { ok: true, message: '连接成功（已自动创建备份目录）' };
            return { ok: false, message: '备份目录不存在且无法自动创建，请先在网盘内手动创建该文件夹' };
        }
        const rawErrText = (await res.text().catch(() => '')).trim();
        const detail = /^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<title\b|<!--)/i.test(rawErrText)
            ? summarizeHtmlErrorBody(rawErrText).headline
            : rawErrText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (res.status >= 500) {
            return { ok: false, message: `网盘或代理网关异常 (HTTP ${res.status})${detail ? `：${detail}` : ''}` };
        }
        return { ok: false, message: `服务器返回 HTTP ${res.status}${detail ? `：${detail}` : ''}` };
    } catch (e: any) {
        return { ok: false, message: `连接失败: ${formatUnknownError(e, '网络异常')}` };
    }
};

/**
 * Create remote directory (MKCOL)
 */
export const createDirectory = async (config: CloudBackupConfig): Promise<boolean> => {
    try {
        const res = await webdavRequest(config, config.remotePath, 'MKCOL');
        return res.status === 201 || res.status === 405; // 405 = already exists
    } catch {
        return false;
    }
};

/**
 * Upload a backup file to WebDAV.
 *
 * Web: XMLHttpRequest so upload.onprogress can report real bytes-uploaded.
 * Native: CapacitorHttp PUT direct to upstream — no real progress events,
 * but the round-trip skips the Worker entirely.
 */
export const uploadBackup = async (
    config: CloudBackupConfig,
    blob: Blob,
    filename: string,
    onProgress?: (percent: number) => void,
): Promise<{ ok: boolean; message: string }> => {
    const remotePath = config.remotePath.replace(/\/+$/, '') + '/' + filename;
    // 中断留痕（utils/taskTrace.ts）：只有上传途中页面没了才留下来，正常结束、报错结束都在 finally 删掉。
    const trace = startStepTrace('cloudUpload', { 云端: 'WebDAV', 备份大小: formatTraceBytes(blob.size) });
    try {
        trace.step('上传', 0, blob.size, 'B');
        return await uploadAndVerify(config, blob, remotePath, (percent) => {
            onProgress?.(percent);
            trace.step('上传', Math.floor(blob.size * percent / 100), blob.size, 'B');
        }, trace);
    } finally {
        trace.clear();
    }
};

const uploadAndVerify = async (
    config: CloudBackupConfig,
    blob: Blob,
    remotePath: string,
    onProgress: (percent: number) => void,
    trace: StepTraceWriter,
): Promise<{ ok: boolean; message: string }> => {
    const result = await putBackup(config, blob, remotePath, onProgress);
    if (!result.ok) return result;
    trace.step('核对云端大小');

    // 服务端可能回 201 却存下 0 字节或垃圾内容，只有回读远端大小才能确认这份备份能用。
    let remoteSize = await probeRemoteSize(config, remotePath);
    // 刚传完的文件在部分服务器上会短暂读不到、或先报 0 / 旧值，稍等再试几次。
    for (
        let attempt = 1;
        remoteSize !== blob.size && remoteSize !== 'unreported' && attempt < SIZE_PROBE_ATTEMPTS;
        attempt++
    ) {
        await new Promise(r => setTimeout(r, SIZE_PROBE_RETRY_MS * attempt));
        remoteSize = await probeRemoteSize(config, remotePath);
    }
    if (remoteSize === blob.size) return result;
    // 文件确实在、只是服务器不报大小：这类服务器无从核对，按上传状态码算成功。
    if (remoteSize === 'unreported') return result;
    if (remoteSize === null) {
        return { ok: false, message: '上传后无法读取云端文件大小，未能确认备份完整，请稍后重试' };
    }
    await webdavRequest(config, remotePath, 'DELETE').catch(() => undefined);
    return {
        ok: false,
        message: `上传后云端文件大小不符（本地 ${blob.size} 字节，云端 ${remoteSize} 字节），已删除这份不完整的备份，请重试`,
    };
};

const SIZE_PROBE_ATTEMPTS = 3;
const SIZE_PROBE_RETRY_MS = 1000;

const parseSize = (text: string | null | undefined): number | null => {
    const trimmed = text?.trim();
    const size = Number(trimmed);
    return trimmed && Number.isInteger(size) && size >= 0 ? size : null;
};

/**
 * 读一次远端文件大小。number = 读到的字节数；'unreported' = 确认文件在，但服务器没报大小；
 * null = 连文件在不在都没法确认。
 */
const probeRemoteSize = async (config: CloudBackupConfig, path: string): Promise<number | 'unreported' | null> => {
    let existsWithoutSize = false;
    // 原生端 PROPFIND 要绕 Worker，内网 NAS 这类 Worker 够不着的服务器只能靠直连 HEAD。
    if (isNative()) {
        try {
            const res = await webdavRequest(config, path, 'HEAD');
            if (res.status === 200) {
                const lengthKey = Object.keys(res.headers || {}).find(k => k.toLowerCase() === 'content-length');
                const size = parseSize(lengthKey ? res.headers![lengthKey] : undefined);
                if (size !== null) return size;
                existsWithoutSize = true;
            }
        } catch { /* 退回 PROPFIND */ }
    }
    try {
        const res = await webdavRequest(config, path, 'PROPFIND', {
            depth: '0',
            contentType: 'application/xml; charset=utf-8',
            body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>',
        });
        if (res.status === 207 || res.status === 200) {
            const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
            return parseSize(doc.querySelector('getcontentlength')?.textContent) ?? 'unreported';
        }
    } catch { /* 下面统一处理 */ }
    return existsWithoutSize ? 'unreported' : null;
};

const putBackup = async (
    config: CloudBackupConfig,
    blob: Blob,
    remotePath: string,
    onProgress?: (percent: number) => void,
): Promise<{ ok: boolean; message: string }> => {
    const mapStatus = (s: number) => {
        if (s === 200 || s === 201 || s === 204) return { ok: true, message: '上传成功' };
        if (s === 401) return { ok: false, message: '认证失败' };
        if (s === 413) return { ok: false, message: `备份文件 ${formatMiB(blob.size)} 超出云端上传上限，请改用「本地导出」或「GitHub 备份」` };
        if (s === 507) return { ok: false, message: '云端空间不足' };
        return { ok: false, message: `上传失败 (${s})` };
    };

    // On native, PUT goes direct via CapacitorHttp (no XHR upload progress
    // available, so we just bookend with 5% → 100%). On web we keep XHR for
    // real byte-level progress through the Worker.
    if (isNative() && NATIVE_DIRECT_METHODS.has('PUT')) {
        try {
            onProgress?.(5);
            const res = await webdavRequest(config, remotePath, 'PUT', {
                contentType: 'application/zip',
                body: blob,
            });
            onProgress?.(100);
            return mapStatus(res.status);
        } catch (e: any) {
            return { ok: false, message: `上传失败: ${e?.message || '未知错误'}` };
        }
    }

    return new Promise((resolve) => {
        // 大小预检：经 Worker 代理的上传超体积上限时，直接给可执行报错，不发起注定失败的上传。
        if (blob.size > WORKER_MAX_UPLOAD_BYTES) {
            resolve({
                ok: false,
                message: `备份文件 ${formatMiB(blob.size)} 超过云端代理上传上限（约 ${formatMiB(WORKER_MAX_UPLOAD_BYTES)}），请改用「本地导出」或「GitHub 备份」`,
            });
            return;
        }

        const url = buildProxyUrl(buildFullUrl(config.webdavUrl, remotePath));
        const auth = buildAuthHeader(config);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Authorization', auth);
        xhr.setRequestHeader('Content-Type', 'application/zip');
        xhr.setRequestHeader('X-WebDAV-Method', 'PUT');

        xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            const pct = Math.min(99, Math.floor((e.loaded / e.total) * 100));
            onProgress?.(pct);
        };
        xhr.onload = () => {
            onProgress?.(100);
            const mapped = mapStatus(xhr.status);
            if (!mapped.ok) {
                const rawHint = (xhr.responseText || '').trim();
                const bodyHint = /^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<title\b|<!--)/i.test(rawHint)
                    ? summarizeHtmlErrorBody(rawHint).headline
                    : rawHint.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
                const fullMsg = bodyHint && xhr.status >= 400 && xhr.status !== 401 && xhr.status !== 413 && xhr.status !== 507
                    ? `${mapped.message}：${bodyHint}`
                    : mapped.message;
                console.warn(`[WebDAV] 上传备份失败 (HTTP ${xhr.status}):`, bodyHint || mapped.message);
                resolve({ ok: false, message: fullMsg });
                return;
            }
            resolve(mapped);
        };
        xhr.onerror = () => {
            console.warn('[WebDAV] 上传备份请求遇到网络或跨域错误');
            resolve({ ok: false, message: '上传失败: 网络连接中断或跨域被拦截' });
        };
        xhr.onabort = () => resolve({ ok: false, message: '上传已取消' });
        xhr.ontimeout = () => resolve({ ok: false, message: '上传超时' });

        xhr.send(blob);
    });
};

/**
 * List backup files on WebDAV
 */
export const listBackups = async (config: CloudBackupConfig): Promise<CloudBackupFile[]> =>
    (await listBackupEntries(config, { throwOnError: true })).map(e => e.file);

type ListedBackup = {
    file: CloudBackupFile;
    /** 服务器是否给了 getcontentlength；没给时 file.size 记为 0，但不能当成真的 0 字节。 */
    sizeReported: boolean;
    /** 文件名 Sully_Backup_<mode>_<毫秒时间戳>.zip 里的时间戳；不是这个命名的为 null。 */
    timestamp: number | null;
};

const listBackupEntries = async (
    config: CloudBackupConfig,
    opts?: { throwOnError?: boolean },
): Promise<ListedBackup[]> => {
    try {
        const res = await webdavRequest(config, config.remotePath, 'PROPFIND', {
            depth: '1',
            contentType: 'application/xml; charset=utf-8',
            body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:displayname/><d:resourcetype/></d:prop></d:propfind>',
        });
        // 404 代表远端备份目录尚未创建，属于首次使用前的正常空列表
        if (res.status === 404) return [];
        if (res.status !== 207 && res.status !== 200) {
            if (opts?.throwOnError) {
                if (res.status === 401) throw new Error('WebDAV 认证失败（HTTP 401），请检查账号或应用专用密码');
                if (res.status === 403) throw new Error('WebDAV 拒绝访问（HTTP 403），请检查目录权限或坚果云路径');
                throw new Error(`拉取 WebDAV 备份列表失败（HTTP ${res.status}）`);
            }
            return [];
        }
        const xml = await res.text();
        return parseWebDAVListing(xml, config);
    } catch (err) {
        if (opts?.throwOnError) throw err instanceof Error ? err : new Error('连接 WebDAV 服务器失败，请检查地址与网络');
        return [];
    }
};

/**
 * Download a backup file from WebDAV in fixed-size chunks via HTTP Range.
 *
 * Single-shot GET reliably failed for large backups: through the Worker, the
 * upstream→worker→client pipe outlived the worker's wall-clock budget on slow
 * links and the browser logged `net::ERR_FAILED 200 (OK)`. Through native
 * CapacitorHttp, the whole response would have to land in JS as one
 * ArrayBuffer (OOM risk on big zips). Chunking solves both: each request is
 * bounded, retries are local, and progress reflects actual bytes.
 */
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 3;

const fetchChunk = async (
    config: CloudBackupConfig,
    path: string,
    start: number,
    end: number,
): Promise<Uint8Array<ArrayBuffer>> => {
    let lastErr: any = null;
    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
        try {
            const res = await webdavRequest(config, path, 'GET', { range: `bytes=${start}-${end}` });
            // 200 是服务器没理 Range、回了整个文件：重试也一样，取消响应体，直接交给整包流式下载。
            if (res.status === 200) {
                await res.body?.cancel().catch(() => undefined);
                lastErr = new Error('server ignored Range');
                break;
            }
            if (res.status === 206) {
                const bytes = new Uint8Array(await res.arrayBuffer());
                if (bytes.byteLength === end - start + 1) return bytes;
                lastErr = new Error(`chunk size ${bytes.byteLength}, expected ${end - start + 1}`);
            } else {
                lastErr = new Error(`chunk HTTP ${res.status}`);
            }
        } catch (e) {
            lastErr = e;
        }
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
    throw lastErr || new Error('chunk failed');
};

export const downloadBackup = async (
    config: CloudBackupConfig,
    file: CloudBackupFile,
    onProgress?: (percent: number) => void,
): Promise<DownloadedBackup | null> => {
    onProgress?.(2);
    // 没报大小的服务器 size 记为 0，无从核对。
    const total = file.size > 0 ? file.size : undefined;

    // 中断留痕（utils/taskTrace.ts）：只有下载途中页面没了才留下来。
    const trace = startStepTrace('cloudDownload', { 云端: 'WebDAV', 备份大小: formatTraceBytes(file.size) });
    try {
        return await downloadWithTrace(config, file, total, trace, onProgress);
    } finally {
        trace.clear();
    }
};

const downloadWithTrace = async (
    config: CloudBackupConfig,
    file: CloudBackupFile,
    total: number | undefined,
    trace: StepTraceWriter,
    onProgress?: (percent: number) => void,
): Promise<DownloadedBackup | null> => {
    if (file.size > CHUNK_SIZE) {
        try {
            const backup = await receiveBackupDownload(async sink => {
                for (let start = 0; start < file.size; start += CHUNK_SIZE) {
                    const end = Math.min(start + CHUNK_SIZE - 1, file.size - 1);
                    trace.step('分段下载', start, file.size, 'B');
                    await sink.write(await fetchChunk(config, file.href, start, end));
                    onProgress?.(Math.min(99, Math.floor(((end + 1) / file.size) * 100)));
                }
            }, total, trace);
            onProgress?.(100);
            return backup;
        } catch (e) {
            // 空间不足换整包下载也一样写不下，不再白下一遍。
            if (e instanceof BackupSpaceError) throw e;
            // Most likely: the deployed Worker hasn't been redeployed with the
            // X-WebDAV-Range header allowed by CORS preflight, or the server
            // ignores Range. Fall through to a single streamed GET.
            console.warn('[webdav] chunked download failed, falling back to single GET', e);
            onProgress?.(2);
        }
    }

    // Small / unknown size, or chunked fallback — single GET
    trace.step('整包下载：等待服务器响应');
    const res = await webdavRequest(config, file.href, 'GET');
    if (res.status !== 200 && res.status !== 206) {
        if (res.status === 401) throw new Error('WebDAV 下载认证失败（HTTP 401），请检查账号或密码');
        if (res.status === 404) throw new Error('云端备份文件不存在或已被删除（HTTP 404）');
        throw new Error(`WebDAV 下载失败（HTTP ${res.status}）`);
    }
    const backup = await receiveBackupDownload(async sink => {
        // 原生壳拿到的是整包 base64，只能整块写入。
        if (!res.body) {
            onProgress?.(50);
            await sink.write(new Uint8Array(await res.arrayBuffer()));
            return;
        }
        const reader = res.body.getReader();
        let received = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                await sink.write(value);
                received += value.byteLength;
                trace.step('整包下载', received, total, 'B');
                if (total) onProgress?.(Math.min(99, Math.floor((received / total) * 100)));
            }
        } catch (error) {
            // 写盘失败时断开连接，别让剩下的字节还在往下载。
            await reader.cancel().catch(() => undefined);
            throw error;
        }
    }, total, trace);
    onProgress?.(100);
    return backup;
};

/**
 * Delete a backup file from WebDAV
 */
export const deleteBackup = async (
    config: CloudBackupConfig,
    file: CloudBackupFile,
): Promise<boolean> => {
    try {
        const res = await webdavRequest(config, file.href, 'DELETE');
        return res.status === 204 || res.status === 200;
    } catch {
        return false;
    }
};

/**
 * Parse WebDAV PROPFIND XML response into file list
 */
const parseWebDAVListing = (xml: string, config: CloudBackupConfig): ListedBackup[] => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    const responses = doc.querySelectorAll('response');
    const files: ListedBackup[] = [];

    responses.forEach((response) => {
        const href = response.querySelector('href')?.textContent || '';
        const isCollection = response.querySelector('resourcetype collection') !== null;
        if (isCollection) return;

        const displayName = response.querySelector('displayname')?.textContent || '';
        const contentLength = response.querySelector('getcontentlength')?.textContent;
        const lastModified = response.querySelector('getlastmodified')?.textContent || '';

        const name = displayName || href.split('/').filter(Boolean).pop() || '';
        if (!name.endsWith('.zip')) return;

        const size = parseSize(contentLength);
        const timestampMatch = /^Sully_Backup_.+_(\d+)\.zip$/.exec(name);
        files.push({
            file: {
                name,
                size: size ?? 0,
                lastModified,
                href: config.remotePath.replace(/\/+$/, '') + '/' + name,
            },
            sizeReported: size !== null,
            timestamp: timestampMatch ? Number(timestampMatch[1]) : null,
        });
    });

    // 按时间戳新到旧排；文件名以 mode 开头，按名字排会让 text_only 永远压在 full 前面。
    files.sort((a, b) => {
        if (a.timestamp !== null && b.timestamp !== null) return b.timestamp - a.timestamp;
        if (a.timestamp !== null) return -1;
        if (b.timestamp !== null) return 1;
        return b.file.name.localeCompare(a.file.name);
    });
    return files;
};

// zip 结尾目录记录的最小长度，比它小的文件不可能是一份备份。
const MIN_ZIP_BYTES = 22;

/**
 * Clean up old backups, keeping only the latest N
 */
export const cleanupOldBackups = async (config: CloudBackupConfig, keepCount: number = 5): Promise<number> => {
    // 只清理带时间戳的本应用备份：别的命名分不出新旧，不占名额也不删。
    // 服务器报了大小且小到不可能是 zip 的，同样不占名额也不删，否则几次坏上传就能把好备份挤掉。
    const files = (await listBackupEntries(config))
        .filter(e => e.timestamp !== null && !(e.sizeReported && e.file.size < MIN_ZIP_BYTES))
        .map(e => e.file);
    if (files.length <= keepCount) return 0;

    let deleted = 0;
    const toDelete = files.slice(keepCount);
    for (const file of toDelete) {
        if (await deleteBackup(config, file)) deleted++;
    }
    return deleted;
};

/**
 * Format file size for display
 */
export const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
