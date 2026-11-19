import { blobToDataUrl, dataUrlToBlob, hashBlob } from '@rei-standard/blob-store';
import type { APIConfig, Emoji, EmojiCategory } from '../types';
import { DB, openDB, SULLY_PRESET_EMOJIS } from './db';
import { getBlobForRef, isBlobRef, putImageBlobDeduped } from './blobRef';
import { withSharedAssetLock } from './sharedAssetLock';
import { cachedEmojiOriginal, isRemoteEmoji, probeEmojiBlob, stickerLink } from './emojiOriginals';
import { createLocalId } from './localId';
import { safeFetchJson, extractContent, extractJson } from './safeApi';
import { emojiExtension, packManifest } from './emojiExport';
import { processImageToBlob } from './file';
import { normalizeLlmBaseUrl } from './llmEndpoint';

export type ImportSticker = { name: string; group: string } & (
    | { read: () => Promise<Blob>; url?: never; fromPack?: boolean }
    | { url: string; read?: never; fromPack?: never }
);
export interface StickerFiles {
    items: ImportSticker[];
    ignored: number;
    close: () => Promise<void>;
}
const formats: Record<string, string> = {
    gif: 'image/gif',
    png: 'image/png',
    apng: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    avif: 'image/avif',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
};
const extension = (name: string) => name.split('.').pop()?.toLowerCase() || '';
const base = (name: string) => name.replace(/\.[^.]+$/, '').trim() || '表情';


export async function openStickerFiles(files: File[]): Promise<StickerFiles> {
    const items: ImportSticker[] = [];
    const closers: (() => Promise<void>)[] = [];
    let ignored = 0;
    const close = async () => {
        await Promise.all(closers.splice(0).map((fn) => fn()));
    };
    try {
        for (const file of files) {
            if (extension(file.name) !== 'zip') {
                const mime = formats[extension(file.name)];
                if (file.type.startsWith('image/') || mime) {
                    const image = file.type.startsWith('image/') ? file : file.slice(0, file.size, mime);
                    items.push({ name: base(file.name), group: '本地表情', read: async () => image });
                } else ignored++;
                continue;
            }
            const { ZipReader, BlobReader, BlobWriter, TextWriter, configure } = await import('@zip.js/zip.js');
            const { default: wasmURI } = await import('@zip.js/zip.js/dist/zip-module.wasm?url');
            configure({ wasmURI });
            const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
            closers.push(() => reader.close());
            const entries = (await reader.getEntries()).filter((e) => !e.directory);
            const manifest = entries.find((e) => e.filename === packManifest);
            const labels = new Map<string, { name: string; group: string }>();
            if (manifest) {
                if (manifest.uncompressedSize > 8 * 1024 * 1024) throw new Error('表情分组清单过大');
                const data = JSON.parse(await manifest.getData(new TextWriter()));
                if (data.format !== 'sully-stickers' || ![1, 2].includes(data.version) || !Array.isArray(data.items))
                    throw new Error('表情包清单格式无法读取');
                for (const row of data.items) {
                    if (typeof row?.name !== 'string' || typeof row.group !== 'string') continue;
                    if (typeof row.path === 'string') labels.set(row.path, row);
                    else if (data.version === 2 && typeof row.url === 'string' && isRemoteEmoji(row.url)) {
                        items.push({ name: row.name, group: row.group, url: row.url });
                    }
                }
            }
            for (const entry of entries) {
                const path = entry.filename.replace(/\\/g, '/').split('/');
                const label = labels.get(entry.filename);
                if (entry === manifest || (!label && path.some((part) => part.startsWith('.') || part === '__MACOSX')))
                    continue;
                const name = path.at(-1)!;
                const mime = formats[extension(name)];
                if (!mime || entry.encrypted) {
                    if (label) throw new Error('ZIP 内的表情图片格式不支持或已加密');
                    ignored++;
                    continue;
                }
                labels.delete(entry.filename);
                items.push({
                    name: label?.name.trim() || base(name),
                    fromPack: !!label,
                    group: label?.group.trim() || path.slice(0, -1).join(' / ') || base(file.name),
                    read: () => entry.getData(new BlobWriter(mime), { checkSignature: true }),
                });
            }
            if (labels.size) throw new Error('ZIP 缺少清单里列出的表情图片，请重新导出文件');
        }
        return { items, ignored, close };
    } catch (error) {
        await close();
        throw error;
    }
}

/** APNG declares acTL before its first IDAT; skip animations and unfamiliar containers. */
async function isStaticPng(blob: Blob) {
    const header = new DataView(await blob.slice(0, 256 * 1024).arrayBuffer());
    for (let offset = 8; offset + 8 <= header.byteLength;) {
        const type = header.getUint32(offset + 4);
        if (type === 0x6163544c) return false; // acTL
        if (type === 0x49444154) return true;  // IDAT
        offset += 12 + header.getUint32(offset);
    }
    return false;
}

export async function prepareStickerImport(item: ImportSticker) {
    if (item.url !== undefined) return { hash: item.url, size: 0, compact: undefined };
    const blob = await item.read();
    const hash = await hashBlob(blob);
    const original = { hash, size: blob.size, compact: undefined };
    if (item.fromPack || blob.size <= 96 * 1024) return original;
    const ext = await emojiExtension(blob);
    if (ext !== 'jpg' && ext !== 'bmp' && !(ext === 'png' && await isStaticPng(blob))) return original;
    const compact = await processImageToBlob(blob, { maxWidth: 768, quality: 0.82, outputType: 'image/webp' }).catch(() => null);
    if (!compact || compact.type !== 'image/webp' || !compact.size || compact.size >= blob.size) return original;
    return { hash, size: blob.size, compact: { blob: compact, hash: await hashBlob(compact) } };
}

export function newPersonalGroup(name: string): EmojiCategory {
    return { id: 'stickers_' + createLocalId(), name: name.trim() || '本地表情', personalOnly: true };
}

export async function localStickerBlob(url: string): Promise<Blob | undefined> {
    if (isBlobRef(url)) return (await getBlobForRef(url)) || undefined;
    if (url.startsWith('data:image/')) return dataUrlToBlob(url);
    if (isRemoteEmoji(url)) return cachedEmojiOriginal(url);
}

export function planStickerName(baseName: string, hash: string, taken: ReadonlyMap<string, string>) {
    let name = baseName.trim() || '表情',
        suffix = 2;
    const stem = name;
    while (taken.has(name) && taken.get(name) !== hash) name = stem + ' ' + suffix++;
    return { name, duplicate: taken.has(name) };
}

/** Read old images only when their names actually collide. Uniqueness is rechecked in the write transaction. */
export async function stickerNameIndex(rows: Emoji[], names: string[]) {
    const wanted = new Set(names.map((n) => n.trim()));
    const index = new Map<string, string>();
    for (const row of rows) {
        let hash = stickerLink(row) || row.contentHash || '';
        if (!hash && (wanted.has(row.name) || wanted.has(row.name.replace(/ \d+$/, '')))) {
            const blob = await localStickerBlob(row.url).catch(() => undefined);
            if (blob) hash = await hashBlob(blob);
        }
        index.set(row.name, hash);
    }
    return index;
}

export async function importSticker(
    item: ImportSticker,
    group: EmojiCategory,
    newGroup: boolean,
    known: ReadonlyMap<string, { url: string; hash: string }>
) {
    let image: Blob | undefined;
    if (item.url === undefined) {
        const blob = await item.read();
        const ext = await emojiExtension(blob);
        image = blob.type === formats[ext] ? blob : blob.slice(0, blob.size, formats[ext]);
        if (!image.size || (typeof Image !== 'undefined' && (await probeEmojiBlob(image)) !== 'ok'))
            throw new Error('图片无法打开');
    } else if (!isRemoteEmoji(item.url)) throw new Error('表情链接无效');
    const hash = image ? await hashBlob(image) : item.url!;
    return withSharedAssetLock('shared', async () => {
        const token = image ? (await putImageBlobDeduped(image)).token : item.url!;
        const db = await openDB();
        return new Promise<{ name: string; duplicate: boolean }>((resolve, reject) => {
            const tx = db.transaction(['emojis', 'emoji_categories'], 'readwrite');
            const table = tx.objectStore('emojis'),
                cats = tx.objectStore('emoji_categories');
            let result: { name: string; duplicate: boolean };
            let message = '图片写入失败';
            const stem = item.name.trim() || '表情';
            const findName = (suffix: number) => {
                const name = suffix === 1 ? stem : stem + ' ' + suffix;
                const request = table.get(name);
                request.onsuccess = () => {
                    const old = request.result as Emoji | undefined;
                    if (old) {
                        const previous = known.get(name);
                        if (
                            old.url === token ||
                            stickerLink(old) === hash || old.contentHash === hash ||
                            (previous?.url === old.url && previous.hash === hash)
                        ) {
                            if (
                                !old.url ||
                                (isBlobRef(old.url) && old.url !== token && old.contentHash === hash)
                            ) {
                                table.put({ ...old, url: token, contentHash: hash });
                            }
                            result = { name, duplicate: true };
                        } else findName(suffix + 1);
                        return;
                    }
                    const target = cats.get(group.id);
                    target.onsuccess = () => {
                        if (!target.result && !newGroup) {
                            message = '目标分组已删除';
                            tx.abort();
                            return;
                        }
                        if (!target.result) cats.add(group);
                        table.add({ name, url: token, categoryId: group.id, ...(image && { contentHash: hash }) });
                        result = { name, duplicate: false };
                    };
                };
            };
            findName(1);
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error || new Error(message));
        });
    });
}

export async function moveStickers(items: Emoji[], groupId: string) {
    const db = await openDB();
    return new Promise<number>((resolve, reject) => {
        const tx = db.transaction(['emoji_categories', 'emojis'], 'readwrite');
        const group = tx.objectStore('emoji_categories').get(groupId);
        let count = 0;
        group.onsuccess = () => {
            if (!group.result) {
                tx.abort();
                return;
            }
            const table = tx.objectStore('emojis');
            for (const row of items) {
                const request = table.get(row.name);
                request.onsuccess = () => {
                    if (request.result?.url !== row.url || request.result?.categoryId !== row.categoryId)
                        return;
                    table.put({ ...request.result, categoryId: groupId });
                    count++;
                };
            }
        };
        tx.oncomplete = () => resolve(count);
        tx.onabort = () => reject(tx.error || new Error('分组已变化，请重新选择'));
    });
}

async function stickerNamingImage(url: string): Promise<string> {
    const blob = isRemoteEmoji(url)
        ? await cachedEmojiOriginal(url).catch(() => undefined)
        : await localStickerBlob(url);
    if (!blob) {
        if (isRemoteEmoji(url)) return url;
        throw new Error('缺少本机原图');
    }
    if ((blob.type === 'image/png' || blob.type === 'image/jpeg') && blob.size <= 256 * 1024) {
        return blobToDataUrl(blob);
    }
    // A single still lets the same multimodal request include animated GIFs and large local originals.
    const source = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = source;
        await image.decode();
        const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法生成识图预览');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.85);
    } finally {
        URL.revokeObjectURL(source);
    }
}

export async function suggestStickerNames(
    rows: Emoji[],
    api: Pick<APIConfig, 'baseUrl' | 'model' | 'apiKey' | 'apiType'>,
    signal: AbortSignal
) {
    const content: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] = [
        {
            type: 'text',
            text: '为下面每张聊天表情起一个方便搜索的中文短名，通常 2 到 5 个字。根据动作、神态或图中文字命名，让不同的表情容易区分。每张图片前有编号，按各自编号返回 JSON 数组，例如 [{"id":1,"name":"猫猫探头"}]。只返回编号和名称。',
        },
    ];
    const previews = new Map<string, string>();
    const sent = new Map<number, string>();
    const errors = new Map<string, string>();
    for (const [index, row] of rows.entries()) {
        if (signal.aborted) throw new DOMException('已停止', 'AbortError');
        try {
            const image = previews.get(row.url) || (await stickerNamingImage(row.url));
            previews.set(row.url, image);
            const id = index + 1;
            sent.set(id, row.name);
            content.push(
                { type: 'text', text: '图片 ' + id },
                { type: 'image_url', image_url: { url: image } }
            );
        } catch {
            errors.set(row.name, '无法读取这张原图，可以手动填写名称。');
        }
    }
    if (signal.aborted) throw new DOMException('已停止', 'AbortError');
    const names = new Map<string, string>();
    if (!sent.size) return { names, errors };
    const response = await safeFetchJson(
        normalizeLlmBaseUrl(api.baseUrl, api.apiType) + '/chat/completions',
        {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + api.apiKey },
            body: JSON.stringify({ model: api.model, stream: false, messages: [{ role: 'user', content }] }),
        },
        0,
        120_000,
        { appId: 'chat', appName: '消息', purpose: '表情看图起名' }
    );
    const payload = extractJson(extractContent(response), { silent: true });
    const entries: unknown = Array.isArray(payload) ? payload : payload?.items;
    if (!Array.isArray(entries)) throw new Error('主 API 没有返回带编号的名称，请重试或手动填写。');
    const seen = new Set<number>();
    for (const entry of entries) {
        const id = typeof entry?.id === 'string' && /^\d+$/.test(entry.id) ? Number(entry.id) : entry?.id;
        const original = sent.get(id);
        if (original === undefined) continue;
        if (seen.has(id)) {
            names.delete(original);
            continue;
        }
        seen.add(id);
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (name && !/[\r\n]/.test(name) && Array.from(name).length <= 12) names.set(original, name);
    }
    for (const original of sent.values()) {
        if (!names.has(original)) errors.set(original, '没有收到可对应的短名，可以重试或手动填写。');
    }
    return { names, errors };
}

export const stickerBytes = (n: number) =>
    n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

export async function measureStickerStorage(items: Emoji[]) {
    const totals = { builtIn: 0, local: 0, cached: 0, remoteOnly: 0, links: 0, files: 0, groups: new Map<string, number>() };
    const perGroup = new Set<string>();
    const originals = new Map<string, { kind: 'builtIn' | 'local' | 'cached'; size: number }>();
    const urls = new Map<string, { hash: string; size: number } | null>();
    const defaults = new Set(SULLY_PRESET_EMOJIS.map((e) => e.url));
    for (const row of items) {
        const link = stickerLink(row);
        if (link) totals.links++;
        if (!urls.has(row.url)) {
            const blob = await localStickerBlob(row.url);
            urls.set(
                row.url,
                blob ? { hash: row.contentHash || (await hashBlob(blob)), size: blob.size } : null
            );
        }
        const entry = urls.get(row.url);
        if (!entry) {
            if (link) totals.remoteOnly++;
            continue;
        }
        if (!link) totals.files++;
        const group = row.categoryId || 'default';
        const groupKey = JSON.stringify([group, entry.hash]);
        if (!perGroup.has(groupKey)) {
            perGroup.add(groupKey);
            totals.groups.set(group, (totals.groups.get(group) || 0) + entry.size);
        }
        const kind =
            !link ? 'local' : row.builtIn || defaults.has(link) ? 'builtIn' : 'cached';
        const previous = originals.get(entry.hash);
        if (!previous || kind === 'local' || (kind === 'builtIn' && previous.kind === 'cached')) {
            originals.set(entry.hash, { kind, size: entry.size });
        }
    }
    for (const { kind, size } of originals.values()) totals[kind] += size;
    return totals;
}
