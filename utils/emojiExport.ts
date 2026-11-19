import JSZip from 'jszip';
import type { Emoji } from '../types';
import { getBlobForRef, isBlobRef } from './blobRef';
import { fetchBlobForShare } from './shareExport';
import { cachedEmojiOriginal, hasEmojiCacheStorage, isRemoteEmoji, rememberEmojiOriginal } from './emojiOriginals';

const safeName = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '表情';

export async function emojiExtension(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const header = String.fromCharCode(...bytes);
    if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'gif';
    if (bytes[0] === 137 && header.slice(1, 4) === 'PNG') return 'png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
    if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'webp';
    const extension = ({ 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico' } as Record<string, string>)[blob.type.split(';')[0]];
    if (!extension) throw new Error('无法识别图片原始格式');
    return extension;
}

/** Keep original bytes, including animation; never re-encode through canvas. */
export async function prepareEmojiExport(emojis: Pick<Emoji, 'name' | 'url'>[], title = '表情包') {
    if (!emojis.length) throw new Error('没有可下载的表情');
    const zip = new JSZip();
    const used = new Set<string>();
    let single: { blob: Blob; fileName: string } | undefined;
    for (const emoji of emojis) {
        let blob = isBlobRef(emoji.url) ? await getBlobForRef(emoji.url)
            : await cachedEmojiOriginal(emoji.url).catch(() => undefined);
        if (!blob && !isBlobRef(emoji.url)) {
            const remote = isRemoteEmoji(emoji.url);
            try {
                blob = await fetchBlobForShare(emoji.url, undefined, { __sullyHandlesFailure: remote });
            } catch (error) {
                if (!remote) throw error;
                throw new Error(`未能从表情包图床下载「${emoji.name}」的原图。如果聊天里也一直打不开，可以到私聊 → 笑脸 → 铅笔，选中这张表情包后删除。`, { cause: error });
            }
            if (remote && hasEmojiCacheStorage()) {
                await rememberEmojiOriginal(emoji.url, blob).catch(() => false);
            }
        }
        if (!blob?.size) throw new Error(`表情「${emoji.name}」的原文件已丢失`);
        const ext = await emojiExtension(blob);
        const base = safeName(emoji.name).replace(/\.(png|gif|jpe?g|webp|avif|svg|bmp|ico)$/i, '');
        let fileName = `${base}.${ext}`, suffix = 2;
        while (used.has(fileName.toLowerCase())) fileName = `${base}_${suffix++}.${ext}`;
        used.add(fileName.toLowerCase());
        single = { blob, fileName };
        if (emojis.length > 1) zip.file(fileName, await blob.arrayBuffer());
    }
    return emojis.length === 1 ? single! : { blob: await zip.generateAsync({ type: 'blob', compression: 'STORE' }), fileName: `${safeName(title)}.zip` };
}
