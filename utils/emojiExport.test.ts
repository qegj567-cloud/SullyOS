import { beforeEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { emojiExtension, prepareEmojiExport } from './emojiExport';
import { getBlobForRef } from './blobRef';
import { fetchBlobForShare } from './shareExport';
vi.mock('./blobRef', () => ({ isBlobRef: (s: string) => s.startsWith('blobref:'), getBlobForRef: vi.fn() }));
vi.mock('./shareExport', () => ({ fetchBlobForShare: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it('preserves original GIF bytes even when served with the wrong MIME type', async () => {
    const original = new Blob(['GIF89a-original-animated-bytes'], { type: 'image/png' });
    vi.mocked(getBlobForRef).mockResolvedValue(original);
    const result = await prepareEmojiExport([{ name: '动图', url: 'blobref:test' }]);
    expect(result.fileName).toBe('动图.gif');
    expect(result.blob).toBe(original);
    expect(await emojiExtension(new Blob([new Uint8Array([137, 80, 78, 71])]))).toBe('png');
});
it('archives original formats with safe unique names, supporting remote and local sources', async () => {
    const gif = new Blob(['GIF89a-original']);
    vi.mocked(getBlobForRef).mockResolvedValue(gif);
    vi.mocked(fetchBlobForShare).mockResolvedValue(gif);
    const result = await prepareEmojiExport([{ name: '../同名', url: 'blobref:a' }, { name: '../同名', url: 'https://example.com/a' }], '分类');
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(result.fileName).toBe('分类.zip');
    const names = Object.keys(zip.files);
    expect(names).toHaveLength(2);
    expect(names.every(n => !n.includes('/') && n.endsWith('.gif'))).toBe(true);
    for (const name of names) expect(await zip.file(name)!.async('string')).toBe('GIF89a-original');
});
it('rejects missing assets instead of silently delivering a partial archive', async () => {
    vi.mocked(getBlobForRef).mockResolvedValue(null);
    await expect(prepareEmojiExport([{ name: '丢失', url: 'blobref:missing' }])).rejects.toThrow('已丢失');
    await expect(prepareEmojiExport([])).rejects.toThrow('没有');
});
it('names the sticker and its host as the source when original download fails', async () => {
    vi.mocked(fetchBlobForShare).mockRejectedValue(new Error('HTTP 404'));
    await expect(prepareEmojiExport([{ name: '招手', url: 'https://example.test/wave.gif' }])).rejects.toThrow(/表情包图床.*招手.*删除/);
});
