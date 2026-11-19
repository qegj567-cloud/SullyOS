import { beforeEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CharacterProfile, Emoji, Message } from '../types';
import { DB, openDB } from './db';
import { getBlobForRef } from './blobRef';
import { exportUserSpaces, importUserSpaces } from './userSpaceBackup';
import { commitSpaceRows } from './userSpaceData';
import { saveUserSpaces } from './userSpaces';
import {
    importSticker,
    newPersonalGroup,
    openStickerFiles,
    measureStickerStorage,
    suggestStickerNames,
} from './emojiLibrary';
import { prepareEmojiExport } from './emojiExport';
import { ChatPrompts } from './chatPrompts';
import { buildGroupHistoryBlock } from './groupChat/prompts';
import { materializeVisionDescriptions } from './visionApi';
import { patchEmojiOriginal } from './emojiBackup';

const gif = new File(
    [
        Uint8Array.from(
            Buffer.from(
                '47494638396101000100800000000000ffffff21f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b',
                'hex'
            )
        ),
    ],
    '点头.gif',
    { type: 'image/gif' }
);
const png = new File(
    [
        Uint8Array.from(
            Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGM8kRfFgA0wYRUdtBIAPOUBoN377ToAAAAASUVORK5CYII=',
                'base64'
            )
        ),
    ],
    '点头.png',
    { type: 'image/png' }
);
beforeEach(async () => {
    saveUserSpaces([{ id: 'default', name: '本地' }]);
    await commitSpaceRows(
        await openDB(),
        { emojis: [], emoji_categories: [], messages: [], characters: [] },
        true
    );
});
it('reimports the exported ZIP with original GIF bytes, original names and group labels', async () => {
    const group = newPersonalGroup('动物 / 表情');
    const url = 'https://stickers.example.test/remote.gif';
    await DB.saveEmoji('外链点头', url, group.id);
    const picked = await openStickerFiles([gif, png]);
    const outcome = await Promise.all(picked.items.map((item) => importSticker(item, group, true, new Map())));
    expect(outcome.map((r) => r.name).sort()).toEqual(['点头', '点头 2']);
    expect((await importSticker(picked.items[0], group, true, new Map())).duplicate).toBe(true);
    await picked.close();
    const original = await DB.getEmojis();
    const exported = await prepareEmojiExport(original, '表情库', [group]);
    const directory = await mkdtemp(join(tmpdir(), 'sully-sticker-roundtrip-'));
    let downloaded: File;
    try {
        const path = join(directory, exported.fileName);
        await writeFile(path, new Uint8Array(await exported.blob.arrayBuffer()));
        downloaded = new File([Uint8Array.from(await readFile(path))], exported.fileName);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
    const fromZip = await openStickerFiles([downloaded]);
    expect(fromZip.items.map((r) => r.group)).toEqual([group.name, group.name, group.name]);
    expect(fromZip.items.find(r => r.url)?.url).toBe(url);
    const local = original.find(e => e.url.startsWith('blobref:'))!;
    const userMessage = await DB.saveMessage({
        charId: 'reader',
        role: 'user',
        type: 'emoji',
        content: local.url,
        metadata: { stickerName: local.name },
    });
    expect(await DB.deleteScannedEmojis(original)).toBe(3);
    expect(
        (await DB.getMessagesByCharId('reader')).some(
            (m) => m.id === userMessage && m.content === local.url
        )
    ).toBe(true);
    for (const item of fromZip.items) await importSticker(item, group, false, new Map());
    await fromZip.close();
    const restored = await DB.getEmojis();
    expect(restored.map((e) => [e.name, e.contentHash, e.categoryId])).toEqual(
        original.map((e) => [e.name, e.contentHash, e.categoryId])
    );
    for (const row of restored) {
        if (row.name === '外链点头') { expect(row.url).toBe(url); continue; }
        const blob = (await getBlobForRef(row.url))!;
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
            new Uint8Array(await (blob.type === 'image/gif' ? gif : png).arrayBuffer())
        );
    }
    const sent = restored.map((row, i) => ({
        id: i + 1, charId: 'reader', role: 'user' as const, type: 'emoji' as const,
        content: row.url, metadata: { stickerName: row.name }, timestamp: i + 1,
    }));
    const groupHistory = buildGroupHistoryBlock(sent, [], []);
    expect(groupHistory.attachedImages).toEqual([]);
    for (const row of restored) expect(groupHistory.text).toContain('[表情包: ' + row.name + ']');
    expect(groupHistory.text).not.toMatch(/blobref:|https?:|data:image/);
    expect((await measureStickerStorage([...restored, { ...local, name: '别名' }])).local).toBe(
        gif.size + png.size
    );
    expect(ChatPrompts.filterVisibleEmojis(restored, [group], 'reader').emojis).toHaveLength(0);
});
it('keeps explicit image IDs across missing originals, duplicate IDs and out-of-order model output', async () => {
    const rows = ['one', 'missing', 'three', 'four'].map((name, i) => ({
        name,
        url: i === 1 ? '' : 'https://example.test/' + name + '.png',
    }));
    const request = vi.fn(
        async (_url: RequestInfo | URL, _init?: RequestInit) =>
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    items: [
                                        { id: '4', name: '探头' },
                                        { id: 1, name: '早安' },
                                        { id: 3, name: '微笑' },
                                        { id: 3, name: '再见' },
                                        { id: 100, name: '错位' },
                                    ],
                                }),
                            },
                        },
                    ],
                }),
                { headers: { 'Content-Type': 'application/json' } }
            )
    );
    vi.stubGlobal('fetch', request);
    try {
        const { names, errors } = await suggestStickerNames(
            rows,
            { baseUrl: 'https://model.example.test/v1', model: 'demo', apiKey: 'test' },
            new AbortController().signal
        );
        expect(request).toHaveBeenCalledTimes(1);
        const content = JSON.parse(String(request.mock.calls[0][1]?.body)).messages[0].content;
        expect(
            content
                .slice(1)
                .map((p: { text?: string; image_url?: { url: string } }) => p.text || p.image_url?.url)
        ).toEqual(['图片 1', rows[0].url, '图片 3', rows[2].url, '图片 4', rows[3].url]);
        expect(Object.fromEntries(names)).toEqual({ one: '早安', four: '探头' });
        expect([...errors.keys()].sort()).toEqual(['missing', 'three']);
        await expect(
            suggestStickerNames(rows, { baseUrl: '', model: 'demo', apiKey: 'test' }, AbortSignal.abort())
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(request).toHaveBeenCalledTimes(1);
    } finally {
        vi.unstubAllGlobals();
    }
});

it('uses folder and file names in third-party ZIPs and ignores metadata and non-images', async () => {
    const zip = new JSZip();
    zip.file('小猫/探头.gif', await gif.arrayBuffer());
    zip.file('眨眼.png', await png.arrayBuffer());
    zip.file('__MACOSX/._眨眼.png', 'metadata');
    zip.file('说明.txt', '文本说明');
    const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
    const opened = await openStickerFiles([new File([bytes], '常用.zip')]);
    try {
        expect(opened.items.map(({ name, group }) => [name, group])).toEqual([
            ['探头', '小猫'],
            ['眨眼', '常用'],
        ]);
        expect(opened.ignored).toBe(1);
        expect(await (await opened.items[0].read!()).arrayBuffer()).toEqual(await gif.arrayBuffer());
    } finally {
        await opened.close();
    }
});
it('restores dot-prefixed sticker names from the manifest and reports missing originals', async () => {
    const group = newPersonalGroup('动物');
    await importSticker({ name: '.探头', group: group.name, read: async () => gif }, group, true, new Map());
    await DB.saveEmoji('抱抱', 'https://stickers.example.test/hug.gif', group.id);
    const result = await prepareEmojiExport(await DB.getEmojis(), '动物', [group]);
    const restored = await openStickerFiles([new File([result.blob], result.fileName)]);
    try {
        const local = restored.items.find(item => item.name === '.探头');
        expect(await (await local!.read!()).arrayBuffer()).toEqual(await gif.arrayBuffer());
    } finally { await restored.close(); }
    const incomplete = await JSZip.loadAsync(await result.blob.arrayBuffer());
    incomplete.remove('.探头.gif');
    const zip = new File([await incomplete.generateAsync({ type: 'arraybuffer' })], result.fileName);
    await expect(openStickerFiles([zip])).rejects.toThrow('ZIP 缺少');
});

it('restores text then matching media and preserves newer role assignment; full backup carries role settings and image', async () => {
    const group = newPersonalGroup('表情');
    await importSticker({ name: '开心', group: group.name, read: async () => gif }, group, true, new Map());
    const link = 'https://example.test/remote.gif';
    await DB.saveEmoji('远程', link, group.id);
    await DB.saveCharacter({ id: 'reader', name: '测试', stickerVision: true } as CharacterProfile);
    const original = (await DB.getEmojis()).find(e => e.name === '开心')!;
    const sent = { id: 21, charId: 'reader', role: 'user', type: 'emoji', timestamp: 123, content: original.url, metadata: { stickerName: '开心' } } as Message;
    await commitSpaceRows(await openDB(), { messages: [sent] });
    const open = async (mode: 'text_only' | 'media_only' | 'full') =>
        JSZip.loadAsync(await (await exportUserSpaces(mode, 'current')).arrayBuffer());
    const text = await open('text_only'),
        media = await open('media_only'),
        full = await open('full');
    for (const archive of [media, full]) {
        const manifest = JSON.parse(await archive.file('user-spaces.json')!.async('string'));
        expect(manifest.blobs.map((b: { id: string }) => 'blobref:' + b.id)).toEqual([original.url]);
    }
    await DB.deleteScannedEmojis([original]);
    await importUserSpaces(text);
    expect((await DB.getMessagesByCharId('reader'))[0]).toMatchObject({ content: '', metadata: sent.metadata });
    expect((await DB.getEmojis()).find(e => e.name === '开心')?.url).toBe('');
    expect((await DB.getEmojis()).find(e => e.name === '远程')?.url).toBe(link);
    await DB.saveEmojiCategory({ ...group, personalOnly: false, allowedCharacterIds: ['reader'] });
    await importUserSpaces(media);
    expect((await DB.getMessagesByCharId('reader'))[0]).toMatchObject(sent);
    expect((await DB.getEmojis()).find(e => e.name === '开心')?.url).toBe(original.url);
    expect((await DB.getEmojiCategories())[0].allowedCharacterIds).toEqual(['reader']);
    await DB.deleteScannedEmojis(await DB.getEmojis());
    await commitSpaceRows(await openDB(), { messages: [{ ...sent, charId: 'another', type: 'text', content: '同 ID 的另一条消息' }] });
    await importUserSpaces(media);
    expect((await DB.getMessagesByCharId('another'))[0].content).toBe('同 ID 的另一条消息');
    await DB.importFullData({ collaborationBackupMode: 'media_only', characters: [], messages: [{ ...sent }] } as any);
    expect(await DB.getCharacter('reader')).toMatchObject({ id: 'reader' });
    expect((await DB.getMessagesByCharId('another'))[0].content).toBe('同 ID 的另一条消息');
    expect(await DB.getEmojis()).toHaveLength(0);
    await importUserSpaces(full);
    expect((await DB.getCharacter('reader'))?.stickerVision).toBe(true);
    expect((await DB.getEmojiCategories())[0].personalOnly).toBe(true);
    expect((await DB.getEmojis()).find(e => e.name === '远程')?.url).toBe(link);
    expect((await getBlobForRef((await DB.getEmojis()).find(e => e.name === '开心')!.url))?.size).toBe(gif.size);
    const conflicting = { ...original, contentHash: 'changed', url: 'blobref:b_new' };
    expect(patchEmojiOriginal(conflicting, original)).toBeUndefined();
});
it('only includes sent user stickers for opted-in private chat; optional vision failure retains the name', async () => {
    const char = { id: 'reader', name: '测试' } as CharacterProfile;
    const msg = {
        id: 1,
        charId: char.id,
        role: 'user',
        type: 'emoji',
        content: 'blobref:b_image',
        timestamp: 1,
        metadata: { stickerName: '眨眼' },
    } as Message;
    const history = (messages: Message[], enabled: boolean, descriptions = false) =>
        ChatPrompts.buildMessageHistory(messages, 10, char, {} as any, [], undefined, {
            stickerVision: enabled,
            useVisionDescriptions: descriptions,
        }).apiMessages;
    expect(history([msg], false)[0].content).toContain('眨眼');
    expect(JSON.stringify(history([msg], false))).not.toContain('blobref');
    expect(history([msg], true)[0].content).toContainEqual({
        type: 'image_url',
        image_url: { url: msg.content },
    });
    expect(JSON.stringify(history([{ ...msg, role: 'assistant' }], true))).not.toContain('image_url');
    const config = { baseUrl: 'https://vision.example.test', apiKey: 'fixture', model: 'demo', enabled: true };
    expect(await materializeVisionDescriptions([msg], { ...config, apiKey: '' })).toEqual([msg]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('test failure')));
    try {
        const prepared = await materializeVisionDescriptions(
            [{ ...msg, content: 'data:image/png;base64,AA==' }],
            config,
            {},
            true
        );
        expect(history(prepared, true, true)[0].content).toContain('眨眼');
        expect(JSON.stringify(history(prepared, true, true))).not.toContain('image_url');
        expect(
            JSON.stringify(
                history(
                    [{ ...msg, metadata: { ...msg.metadata, visionDescription: '画面专属描述' } }],
                    false,
                    true
                )
            )
        ).not.toContain('画面专属描述');
    } finally {
        vi.unstubAllGlobals();
    }
});
