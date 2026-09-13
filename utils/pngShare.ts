/** Portable SullyOS files in a PNG ancillary chunk. No remote storage or image decoding needed.
 * Chunk layout and CRC: https://www.w3.org/TR/png-3/#5Chunk-layout
 * suLy = ancillary, private, reserved bit clear, safe to copy.
 */
export const SHARE_KINDS = {
    'chat-decoration': '聊天装扮', character: '角色卡', worldbook: '世界书', 'chrome-css': '白框 CSS',
    'chrome-presets': '白框预设集', 'journal-css': '日记 CSS', 'chat-theme': '气泡主题',
    appearance: '外观预设', story: '剧情预设', room: '小屋样板房',
    'pixel-home': '像素小屋', 'whitebox-sound': '白框提示音',
} as const;
export type ShareKind = keyof typeof SHARE_KINDS;
export type ShareCardStyle = 'paper' | 'poster' | 'business';
export interface ShareCardOptions {
    kind: ShareKind;
    title?: string;
    author?: string;
    restrictions?: string;
    previewUrl?: string;
}
export interface ShareCardMetadata {
    format: 'sullyos-share';
    version: 1;
    kind: ShareKind;
    title: string;
    author: string;
    restrictions: string;
    style: ShareCardStyle;
    fileName: string;
    mimeType: string;
}
export const MAX_SHARE_BYTES = 64 * 1024 * 1024;
const MAX_PNG_BYTES = MAX_SHARE_BYTES + 32 * 1024 * 1024;
const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CHUNK = 'suLy';
const MAGIC = new TextEncoder().encode('SullyOS\0');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
});
function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}
export function isPng(bytes: Uint8Array): boolean {
    return SIGNATURE.every((b, i) => bytes[i] === b);
}
function chunks(bytes: Uint8Array): { type: string; start: number; end: number; data: Uint8Array }[] {
    if (!isPng(bytes)) throw new Error('请选择 PNG 原文件；截图或转换格式后的图片无法导入');
    if (bytes.length > MAX_PNG_BYTES) throw new Error('图片过大，请使用原格式文件导入');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = [];
    let hasImage = false;
    for (let start = 8; start < bytes.length;) {
        if (start + 12 > bytes.length) throw new Error('PNG 文件不完整');
        const length = view.getUint32(start);
        const end = start + length + 12;
        if (end > bytes.length) throw new Error('PNG 数据长度异常，文件可能已损坏');
        const type = String.fromCharCode(...bytes.subarray(start + 4, start + 8));
        if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) throw new Error('PNG 数据块无效');
        if (crc32(bytes.subarray(start + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error('PNG 校验失败，文件可能已损坏，请重新获取原文件');
        if (result.length === 0 && (type !== 'IHDR' || length !== 13)) throw new Error('PNG 图片头无效');
        if (type === 'IDAT') hasImage = true;
        result.push({ type, start, end, data: bytes.subarray(start + 8, end - 4) });
        if (type === 'IEND') {
            if (length !== 0 || end !== bytes.length || !hasImage) throw new Error('PNG 文件结构异常');
            return result;
        }
        start = end;
    }
    throw new Error('PNG 文件不完整');
}
function validateMetadata(value: unknown): asserts value is ShareCardMetadata {
    const m = value as ShareCardMetadata | null;
    if (!m || m.format !== 'sullyos-share') throw new Error('不是 SullyOS 分享图片');
    if (m.version !== 1) throw new Error('暂不支持此分享图片版本，请更新 SullyOS');
    if (!Object.prototype.hasOwnProperty.call(SHARE_KINDS, m.kind)) throw new Error('无法识别分享内容类型');
    for (const [key, max] of [['title', 60], ['author', 32], ['restrictions', 120], ['fileName', 240], ['mimeType', 120]] as const) {
        if (typeof m[key] !== 'string' || m[key].length > max) throw new Error('分享图片信息无效');
    }
    if (!m.title.trim() || !m.fileName || /[\\/\x00-\x1f]/.test(m.fileName) || /[\r\n]/.test(m.mimeType)
        || !['paper', 'poster', 'business'].includes(m.style)) throw new Error('分享图片信息无效');
}
export function safeShareFileName(name: string): string {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 220) || 'SullyOS';
}
export function embedShareInPng(png: Uint8Array, metadata: ShareCardMetadata, payload: Uint8Array): Uint8Array {
    validateMetadata(metadata);
    if (!payload.length || payload.length > MAX_SHARE_BYTES) throw new Error('分享内容为空或超过 64 MB，请使用原格式导出');
    const parsed = chunks(png);
    const header = encoder.encode(JSON.stringify(metadata));
    const data = new Uint8Array(MAGIC.length + 4 + header.length + payload.length);
    data.set(MAGIC);
    new DataView(data.buffer).setUint32(MAGIC.length, header.length);
    data.set(header, MAGIC.length + 4);
    data.set(payload, MAGIC.length + 4 + header.length);
    const chunk = new Uint8Array(data.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(encoder.encode(CHUNK), 4);
    chunk.set(data, 8);
    view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
    // Replace existing Sully data, never retain a previous payload on re-export.
    const kept = parsed.filter(c => c.type !== CHUNK);
    const size = 8 + chunk.length + kept.reduce((n, c) => n + c.end - c.start, 0);
    if (size > MAX_PNG_BYTES) throw new Error('分享图片过大，请使用原格式导出');
    const output = new Uint8Array(size);
    output.set(SIGNATURE);
    let offset = 8;
    for (const c of kept) {
        if (c.type === 'IEND') { output.set(chunk, offset); offset += chunk.length; }
        output.set(png.subarray(c.start, c.end), offset);
        offset += c.end - c.start;
    }
    return output;
}
export function extractShareFromPng(png: Uint8Array, expectedKind?: ShareKind): { metadata: ShareCardMetadata; payload: Uint8Array } {
    const found = chunks(png).filter(c => c.type === CHUNK);
    if (!found.length) throw new Error('图片中没有可导入的 SullyOS 内容。请使用导出的 PNG 原文件，不要截图或压缩');
    if (found.length !== 1) throw new Error('分享图片含有重复数据，无法导入');
    const data = found[0].data;
    if (data.length < 12 || !MAGIC.every((b, i) => data[i] === b)) throw new Error('分享图片标识无效');
    const headerLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8);
    if (headerLength > 8192 || headerLength < 2 || 12 + headerLength >= data.length) throw new Error('分享图片数据不完整');
    let metadata: unknown;
    try { metadata = JSON.parse(decoder.decode(data.subarray(12, 12 + headerLength))); }
    catch { throw new Error('分享图片信息已损坏'); }
    validateMetadata(metadata);
    if (expectedKind && metadata.kind !== expectedKind) throw new Error(`这是一张${SHARE_KINDS[metadata.kind]}分享图，请到对应功能导入；此处需要${SHARE_KINDS[expectedKind]}`);
    const payload = data.subarray(12 + headerLength);
    if (payload.length > MAX_SHARE_BYTES) throw new Error('分享内容超过 64 MB，请使用原格式文件导入');
    return { metadata, payload };
}

/** Keep original files unchanged; unwrap only PNGs, then use the existing domain importer. */
export async function readShareFile(file: File, expectedKind: ShareKind): Promise<File> {
    const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (!isPng(signature) && !/\.png$/i.test(file.name) && file.type !== 'image/png') return file;
    if (file.size > MAX_PNG_BYTES) throw new Error('图片过大，请使用原格式文件导入');
    const { metadata, payload } = extractShareFromPng(new Uint8Array(await file.arrayBuffer()), expectedKind);
    return new File([new Uint8Array(payload).buffer], metadata.fileName, { type: metadata.mimeType });
}
export async function readShareText(file: File, expectedKind: ShareKind): Promise<string> {
    return (await readShareFile(file, expectedKind)).text();
}

/** Distinguish a plain PNG from a share card; corrupt cards still fail validation. */
export function pngHasShare(bytes:Uint8Array):boolean { return chunks(bytes).some(chunk=>chunk.type===CHUNK); }
