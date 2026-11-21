import { createBackupArchive } from './backupArchive';
import type { Emoji, EmojiCategory } from '../types';
import { getBlobForRef, isBlobRef } from './blobRef';
import { fetchBlobForShare } from './shareExport';
import { stickerLink } from './emojiOriginals';

const safeName = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '表情';

export async function emojiExtension(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const header = String.fromCharCode(...bytes);
    if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'gif';
    if (bytes[0] === 137 && header.slice(1, 4) === 'PNG') return 'png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
    if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'webp';
    const extension = ({ 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico' } as Record<string, string>)[blob.type.split(';')[0]];
    if (!extension) throw new Error('无法识别图片原始格式');
    return extension;
}

export const packManifest = 'sully-stickers.json';

/** Only locally sourced stickers contribute image files. Links travel as manifest entries. */
export async function prepareEmojiExport(emojis: Emoji[], title = '表情包', groups?: EmojiCategory[]) {
    if (!emojis.length) throw new Error('没有可下载的表情');
    const zip = createBackupArchive();
    const manifest: (({path:string} | {url:string}) & {name:string; group:string})[] = [];
    let hasLinks = false;
    const groupNames = new Map(groups?.map(g => [g.id,g.name]));
    const used = new Set<string>();
    let single: { blob: Blob; fileName: string } | undefined;
    for (const emoji of emojis) {
        const label = { name: emoji.name, group: groupNames.get(emoji.categoryId || 'default') || '默认' };
        const link = stickerLink(emoji);
        if (link) {
            hasLinks = true;
            manifest.push({ ...label, url: link });
            continue;
        }
        const blob = isBlobRef(emoji.url) ? await getBlobForRef(emoji.url)
            : emoji.url ? await fetchBlobForShare(emoji.url) : null;
        if (!blob?.size) throw new Error(`表情「${emoji.name}」的原文件已丢失`);
        const ext = await emojiExtension(blob);
        const base = safeName(emoji.name).replace(/\.(png|gif|jpe?g|webp|avif|heic|heif|svg|bmp|ico)$/i, '');
        let fileName = `${base}.${ext}`, suffix = 2;
        while (used.has(fileName.toLowerCase())) fileName = `${base}_${suffix++}.${ext}`;
        used.add(fileName.toLowerCase());
        single = { blob, fileName };
        if (emojis.length > 1) {
            zip.fileBlob(fileName, blob, {compression:'STORE'});
            manifest.push({ ...label, path: fileName });
        }
    }
    if (emojis.length === 1 && single) return single;
    zip.file(packManifest, JSON.stringify({format:'sully-stickers',version:hasLinks ? 2 : 1,items:manifest}));
    return { blob: await zip.generateBlob(), fileName: `${safeName(emojis.length === 1 ? emojis[0].name : title)}.zip` };
}
