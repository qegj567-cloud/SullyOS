import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { DB, openDB } from './db';
import { putImageBlob, getBlobForRef, deleteBlobRef, restoreBlobRef } from './blobRef';
import { collectBlobRefs, writeBlobsToZip, readBlobsIndex, restoreBlobsFromZip, restoreAssetFilesInPlace } from './backupBlobs';
import {
    writeV2Backup, assembleV2Backup, openLegacyBackup, pendingBackupField, readBackupField, loadAllBackupFields,
    createDamagedPictureGuard, detectBackupFileKind,
    type AssembleV2Options, type ShardLimits,
} from './backupFormat';
import { openBackupZip } from './backupZipReader';
import { restoreVoiceMessageBlobs, VOICE_BACKUP_DIR, VOICE_BACKUP_MARKER } from './voiceMessageBackup';
import { createImportProgressMarker, IMPORT_IN_PROGRESS_KEY } from './backupImportPolicy';

// 单空间旧格式三代（v1 data.json、v2 / v3 manifest + stores/）的恢复：真 zip 字节 → 按需读包 → 字段懒加载 → importFullData。
// importSystem 在 5000 行的 Provider 里没法直接跑，这里按它的顺序把同一批模块串起来；调用顺序本身由 backupExportWiring.test.ts 在语法树上钉住。

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
const VOICE = new Uint8Array([73, 68, 51, 4, 0, 9, 8, 7]);
const VOICE_PATH = `${VOICE_BACKUP_DIR}/voice_favorite_audio_1_0.bin`;
const TEXT = '你好，小明 👋🏽 今天也要加油呀 🎉 𠮷野家';
const TAMPER_TARGET = 'TAMPER-TARGET-0123456789';
const SMALL_SHARDS: ShardLimits = { maxLen: 1 << 30, maxItems: 50, hardMaxLen: 1 << 30 };
const STORES = ['characters', 'messages', 'gallery', 'diaries', 'memory_nodes', 'memory_vectors', 'assets', 'user_profile'];

/** 备份里的原始数据。image 是这一代格式里图片在 JSON 中的写法：assets/ 路径（v1、v2）或 blobref 令牌（v3）。 */
const sampleData = (image: string, vectors: 'json' | 'binary') => ({
    timestamp: 1700000000000,
    version: 3,
    characters: [
        { id: 'c1', name: '角色甲 🐱', avatar: image, systemPrompt: TEXT, memories: [] },
        { id: 'c2', name: '角色乙', memories: [{ id: 'm', content: '一起看过海 🌊' }] },
    ],
    mediaAssets: [],
    messages: [
        ...Array.from({ length: 120 }, (_, i) => ({ id: i + 1, charId: i % 2 ? 'c1' : 'c2', role: 'user', type: 'text', content: `${TEXT} #${i}` })),
        { id: 121, charId: 'c1', role: 'assistant', type: 'text', content: TAMPER_TARGET },
        { id: 122, charId: 'c1', role: 'user', type: 'image', content: image },
    ],
    galleryImages: [{ id: 'g1', charId: 'c1', url: image }],
    diaries: [{ id: 'd1', charId: 'c1', content: `日记 📔 ${TEXT}` }],
    memoryNodes: [{ id: 'n1', charId: 'c1', content: '记忆节点 🧠' }],
    ...(vectors === 'json' ? { memoryVectors: [{ memoryId: 'n1', charId: 'c1', dimensions: 3, vector: [0.5, 0.25, -1] }] } : {}),
    assets: [
        { id: 'wallpaper', data: image },
        { id: 'voice_favorite_audio_1', data: { blob: { [VOICE_BACKUP_MARKER]: true, path: VOICE_PATH, mimeType: 'audio/mpeg', size: VOICE.byteLength } } },
    ],
    userProfile: { name: '小明', avatar: image, bio: '🙂' },
});

/** 恢复后库里应有的内容：图片引用换成库里的形态，向量是 Float32 字节，语音标记换回 Blob。 */
const expectedDb = (imageInDb: string) => {
    const data = sampleData(imageInDb, 'json');
    return {
        characters: data.characters,
        messages: data.messages,
        gallery: data.galleryImages,
        diaries: data.diaries,
        memory_nodes: data.memoryNodes,
        memory_vectors: [{ memoryId: 'n1', charId: 'c1', dimensions: 3, vector: new Uint8Array(new Float32Array([0.5, 0.25, -1]).buffer) }],
        assets: [{ id: 'voice_favorite_audio_1', data: { blob: 'audio/mpeg:73,68,51,4,0,9,8,7' } }, { id: 'wallpaper', data: imageInDb }],
        user_profile: [{ ...data.userProfile, id: 'me' }],
    };
};

type Generation = 'v1' | 'v2' | 'v3';

async function buildPackage(generation: Generation, edit?: (zip: JSZip) => void): Promise<{ bytes: Uint8Array; imageInDb: string; token?: string }> {
    const zip = new JSZip();
    zip.file(VOICE_PATH, VOICE);
    let imageInDb = PNG_DATA_URL;
    let token: string | undefined;
    if (generation === 'v3') {
        token = imageInDb = await putImageBlob(new Blob([PNG], { type: 'image/png' }));
        const tokens = new Set<string>();
        const f32 = new Float32Array([0.5, 0.25, -1]);
        await writeV2Backup(zip as any, sampleData(token, 'binary'), {
            mode: 'full', limits: SMALL_SHARDS, onSerialized: text => collectBlobRefs(text, tokens),
            vectors: { bin: new Uint8Array(f32.buffer), index: [{ memoryId: 'n1', charId: 'c1', dimensions: 3, byteOffset: 0, byteLength: 12 }] },
        });
        expect((await writeBlobsToZip(zip as any, tokens, getBlobForRef)).missing).toEqual([]);
        // 包里带着图片本体：恢复前把本机这张删掉，能读回来才算数。
        await deleteBlobRef(token);
    } else {
        zip.file('assets/asset_1.png', PNG);
        const data = sampleData('assets/asset_1.png', 'json');
        if (generation === 'v1') zip.file('data.json', JSON.stringify(data));
        else {
            const manifest = await writeV2Backup(zip as any, data, { mode: 'full', limits: SMALL_SHARDS });
            zip.file('manifest.json', JSON.stringify({ ...manifest, formatVersion: 2 }));
        }
    }
    edit?.(zip);
    return { bytes: await zip.generateAsync({ type: 'uint8array' }), imageInDb, token };
}

const seedStore = async (name: string, records: any[]) => {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        for (const record of records) tx.objectStore(name).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
};

/** 各表的现状；Blob 换成「类型:字节」方便比较。 */
const dumpDb = async () => {
    const dump: Record<string, any[]> = {};
    for (const store of STORES) dump[store] = await DB.getRawStoreData(store);
    dump.assets = await Promise.all(dump.assets.map(async row => (row.data?.blob instanceof Blob
        ? { ...row, data: { ...row.data, blob: `${row.data.blob.type}:${new Uint8Array(await row.data.blob.arrayBuffer()).join(',')}` } }
        : row)));
    return dump;
};

const markerStorage = () => {
    const values = new Map<string, string>();
    return { values, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};

type Zip = { file(name: string): any; verify?: () => Promise<void> };
const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

/** 与 importSystem 同序：只读校验全过 → 记「导入中」→ 图片二进制 → 各表；失败时照样补一笔 error。 */
async function restoreFrom(zip: Zip, readData: () => Promise<Record<string, any>>, storage: ReturnType<typeof markerStorage>, importOptions: Parameters<typeof DB.importFullData>[1] = {}, damaged: string[] = []) {
    const marker = createImportProgressMarker('backup.zip', storage);
    try {
        const data = await readData();
        const blobEntries = await readBlobsIndex(zip);
        marker.beginWrite();
        await restoreBlobsFromZip(zip, blobEntries, restoreBlobRef, { onDamaged: entry => { damaged.push(entry.id); } });
        const skipDamaged = createDamagedPictureGuard(zip);
        await DB.importFullData(data as any, {
            ...importOptions,
            beforeWrite: root => restoreAssetFilesInPlace(zip, root, {
                skipDamaged,
                onDamaged: filename => { if (!damaged.includes(`assets/${filename}`)) damaged.push(`assets/${filename}`); },
            }),
        });
        marker.clear();
    } catch (error) {
        marker.update('error');
        throw error;
    }
}

const voiceFrom = (zip: Zip) => async (path: string): Promise<Uint8Array | null> => zip.file(path)?.async('uint8array') ?? null;
const withVoice = (zip: Zip, options: AssembleV2Options = {}): AssembleV2Options => ({
    ...options,
    onFieldRead: async (field, rows) => {
        await options.onFieldRead?.(field, rows);
        if (field === 'assets') await restoreVoiceMessageBlobs(rows, voiceFrom(zip));
    },
});

/** 现在的读法：zip.js 按需读 + 字段懒加载。 */
async function restoreLazily(source: Uint8Array | Blob, storage = markerStorage()) {
    const zip = await openBackupZip(source instanceof Blob ? source : blobOf(source));
    try {
        await restoreFrom(zip, () => openLegacyBackup(zip, withVoice(zip)), storage);
    } finally {
        await zip.close();
    }
}

/** 改造前的读法：JSZip 整包读入，全部字段拼好再写库。 */
async function restoreEagerly(source: Uint8Array | Blob, storage = markerStorage()) {
    const zip = await JSZip.loadAsync(source instanceof Blob ? await source.arrayBuffer() : source) as unknown as Zip;
    await restoreFrom(zip, async () => {
        const manifestFile = zip.file('manifest.json');
        const data = manifestFile
            ? await assembleV2Backup(zip, JSON.parse(await manifestFile.async('string')))
            : JSON.parse(await zip.file('data.json').async('string'));
        await restoreVoiceMessageBlobs(data.assets, voiceFrom(zip));
        return data;
    }, storage);
}

let liveData: Record<string, any[]>;

beforeEach(async () => {
    // 本机原有的数据：恢复成功后被备份替换，写库前被拒绝的恢复必须让它原样留着。
    await seedStore('characters', [{ id: 'old-char', name: '本机原有角色' }]);
    await seedStore('messages', [{ id: 900001, charId: 'old-char', role: 'user', type: 'text', content: '本机原有聊天' }]);
    await seedStore('gallery', [{ id: 'old-image', url: 'data:image/png;base64,AAAA' }]);
    await seedStore('diaries', [{ id: 'old-diary', content: '本机原有日记' }]);
    await seedStore('memory_nodes', [{ id: 'old-node', content: '本机原有记忆' }]);
    await seedStore('memory_vectors', [{ memoryId: 'old-node', charId: 'old-char', dimensions: 1, vector: new Uint8Array(4) }]);
    await seedStore('assets', [{ id: 'old-asset', data: '本机原有资源' }]);
    await seedStore('user_profile', [{ id: 'me', name: '本机用户' }]);
    liveData = await dumpDb();
});

describe.each([
    ['按需读包 + 字段懒加载', restoreLazily],
    ['JSZip 整包读入 + 一次读全（改造前的读法）', restoreEagerly],
] as const)('三代旧格式完整恢复 · %s', (_name, restore) => {
    it.each(['v1', 'v2', 'v3'] as const)('%s：文字表、带图片的表、图片二进制、语音、中文和 emoji 都与原始数据一致', async generation => {
        const { bytes, imageInDb, token } = await buildPackage(generation);
        const storage = markerStorage();
        await restore(bytes, storage);

        expect(await dumpDb()).toEqual(expectedDb(imageInDb));
        expect(storage.values.size).toBe(0);
        if (token) {
            const image = await getBlobForRef(token);
            expect(image!.type).toBe('image/png');
            expect(new Uint8Array(await image!.arrayBuffer())).toEqual(PNG);
        }
    });
});

describe('按文件头认格式', () => {
    it('名字不带 .zip、类型为空的压缩包（云端下载落盘的临时文件）照常恢复', async () => {
        const { bytes, imageInDb } = await buildPackage('v3');
        const file = new File([bytes as BlobPart], 'download-1700000000000-abc123.tmp');
        expect(file.type).toBe('');
        expect(await detectBackupFileKind(file)).toBe('zip');
        await restoreLazily(file);
        expect(await dumpDb()).toEqual(expectedDb(imageInDb));
    });

    it('名字叫 .zip 但内容是 JSON：按压缩包读，报「不是 zip 文件」，数据库不变', async () => {
        const file = new File([JSON.stringify(sampleData(PNG_DATA_URL, 'json'))], 'backup.zip');
        expect(await detectBackupFileKind(file)).toBe('zip');
        const storage = markerStorage();
        await expect(restoreLazily(file, storage)).rejects.toThrow(/损坏的备份包：找不到压缩包目录（不是 zip 文件/);
        expect(await dumpDb()).toEqual(liveData);
        expect(storage.values.size).toBe(0);
    });
});

describe('字段懒加载', () => {
    const openV3 = async (options: AssembleV2Options = {}) => {
        const { bytes } = await buildPackage('v3');
        const zip = await openBackupZip(blobOf(bytes));
        const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
        return { zip, manifest, data: await openLegacyBackup(zip, withVoice(zip, options)) };
    };
    /** data 里此刻完整读进来的分片字段。 */
    const loadedFields = (data: Record<string, any>) => (
        Object.keys(data).filter(key => Array.isArray(data[key]) && data[key].length > 0 && !pendingBackupField(data[key]))
    );

    it('写库全程同时读进内存的字段不超过一个，每个字段只在校验和轮到它时各读一次', async () => {
        const reads: string[] = [];
        let peak = 0;
        let data: Record<string, any> | undefined;
        const sample = () => { if (data) peak = Math.max(peak, loadedFields(data).length); };
        const opened = await openV3({ onFieldRead: field => { reads.push(field); sample(); } });
        data = opened.data;
        const sharded = [...Object.keys(opened.manifest.stores).filter(field => opened.manifest.stores[field].parts > 0), 'memoryVectors'];
        expect(sharded).toEqual(['characters', 'messages', 'galleryImages', 'diaries', 'memoryNodes', 'assets', 'memoryVectors']);

        // 校验时清单里的每个字段读过一遍，但都没留在 data 里。
        const declared = [...Object.keys(opened.manifest.stores), 'memoryVectors'];
        expect(reads).toEqual(declared);
        expect(loadedFields(data)).toEqual([]);
        for (const field of sharded) expect(pendingBackupField(data[field])?.field, field).toBe(field);
        // 没有分片的空数组不用占位。
        expect(data.mediaAssets).toEqual([]);

        const storage = markerStorage();
        await restoreFrom(opened.zip, async () => data!, storage, { onProgress: sample });
        await opened.zip.close();

        expect(peak).toBe(1);
        expect([...reads].sort()).toEqual([...declared, ...sharded].sort());
        expect(loadedFields(data)).toEqual([]);
        expect((await dumpDb()).messages).toHaveLength(122);

        // 反证探针看得见：一次读全（改造前的做法）时，这些字段同时都在内存里。
        const again = await openV3();
        const eager = await assembleV2Backup(again.zip, again.manifest);
        expect(loadedFields(eager).sort()).toEqual([...sharded].sort());
        await again.zip.close();
    });

    it('写库途中某个字段读失败：抛出原错误，这张表和后面的表保持旧数据，前面的表已是新数据', async () => {
        const { bytes } = await buildPackage('v3');
        const reader = await openBackupZip(blobOf(bytes));
        const thrown = new DOMException('file is gone', 'NotReadableError');
        // 校验那一遍照常读，写库轮到日记时文件读不到了。
        let reads = 0;
        const zip: Zip = {
            file: (name: string) => (name === 'stores/diaries.000.json'
                ? { async: (type: any) => (reads++ > 0 ? Promise.reject(thrown) : reader.file(name)!.async(type)) }
                : reader.file(name)),
        };
        const storage = markerStorage();
        await expect(restoreFrom(zip, () => openLegacyBackup(zip, withVoice(zip)), storage)).rejects.toBe(thrown);
        await reader.close();

        const after = await dumpDb();
        expect(after.characters.map(row => row.id)).toEqual(['c1', 'c2']);
        expect(after.messages).toHaveLength(122);
        expect(after.gallery.map(row => row.id)).toEqual(['g1']);
        // 先读到手再清表：读失败时日记还是本机原来那条；排在后面的表没被碰过。
        for (const store of ['diaries', 'memory_nodes', 'memory_vectors', 'user_profile']) expect(after[store], store).toEqual(liveData[store]);
        expect(storage.values.has(IMPORT_IN_PROGRESS_KEY)).toBe(true);
    });

    it('占位只回答「有没有、有多少条」，读内容直接抛错', async () => {
        const { zip, data } = await openV3();
        expect(Array.isArray(data.messages)).toBe(true);
        expect(data.messages.length).toBe(122);
        expect(Object.prototype.hasOwnProperty.call(data, 'characters')).toBe(true);
        expect(() => data.messages[0]).toThrow('尚未读入');
        expect(() => data.messages.map((row: any) => row)).toThrow('尚未读入');
        expect(() => [...data.messages]).toThrow('尚未读入');
        expect(() => Object.keys(data.messages)).toThrow('尚未读入');
        expect(() => JSON.stringify(data)).toThrow('尚未读入');

        // readBackupField 读出真数组但不写回 data；非占位原样返回。
        const messages = await readBackupField(data.messages);
        expect(messages).toHaveLength(122);
        expect(messages[120].content).toBe(TAMPER_TARGET);
        expect(pendingBackupField(data.messages)).toBeDefined();
        expect(await readBackupField(data.userProfile)).toBe(data.userProfile);
        expect(await readBackupField(undefined)).toBeUndefined();

        await loadAllBackupFields(data);
        expect(Object.values(data).some(value => pendingBackupField(value))).toBe(false);
        expect(data.messages).toEqual(messages);
        await zip.close();
    });

    it('assets 每次读出都过一遍 onFieldRead，语音标记在校验和写库前都被换回 Blob', async () => {
        const seen: boolean[] = [];
        const { zip, data } = await openV3({ onFieldRead: (field, rows) => { if (field === 'assets') seen.push(rows.some(row => row.data?.blob instanceof Blob)); } });
        const assets = await readBackupField(data.assets);
        // 测试的钩子排在语音恢复之前，所以两次看到的都还是标记；读出来的结果里已经是 Blob。
        expect(seen).toEqual([false, false]);
        expect(assets.find((row: any) => row.id === 'voice_favorite_audio_1').data.blob).toBeInstanceOf(Blob);
        await zip.close();
    });

    it('v1 的 data.json 整个读入，数组字段同样过 onFieldRead', async () => {
        const { bytes } = await buildPackage('v1');
        const zip = await openBackupZip(blobOf(bytes));
        const fields: string[] = [];
        const data = await openLegacyBackup(zip, { onFieldRead: field => { fields.push(field); } });
        expect(fields).toEqual(['characters', 'mediaAssets', 'messages', 'galleryImages', 'diaries', 'memoryNodes', 'memoryVectors', 'assets']);
        expect(Object.values(data).some(value => pendingBackupField(value))).toBe(false);
        expect(data.messages).toHaveLength(122);
        await zip.close();
    });
});

describe('懒加载与一次读全写出的库完全一致', () => {
    const allStores = async () => Array.from((await openDB()).objectStoreNames).filter(name => name !== 'blob_assets' && name !== 'api_call_log');
    const dumpAll = async () => {
        const dump: Record<string, any[]> = {};
        for (const store of await allStores()) dump[store] = await DB.getRawStoreData(store);
        return dump;
    };
    const clearAll = async () => { for (const store of await allStores()) await seedStore(store, []); };
    const pack = async (data: Record<string, any>) => {
        const zip = new JSZip();
        const manifest = await writeV2Backup(zip as any, data, { limits: { maxLen: 1 << 30, maxItems: 2, hardMaxLen: 1 << 30 } });
        return { bytes: await zip.generateAsync({ type: 'uint8array' }), manifest };
    };
    /** 同一个包分别按两种读法恢复到清空的库里，返回两次的全库快照。 */
    const restoreBothWays = async (bytes: Uint8Array, prepare: () => Promise<void> = async () => {}) => {
        await clearAll(); await prepare();
        await restoreEagerly(bytes);
        const eager = await dumpAll();
        await clearAll(); await prepare();
        await restoreLazily(bytes);
        return { eager, lazy: await dumpAll() };
    };

    it('整合备份：每张表都有记录、每个数组字段都跨分片', async () => {
        const db = await openDB();
        // 每张表按它的主键造三条记录，导出后每个数组字段都是两片。
        for (const name of await allStores()) {
            const store = db.transaction(name).objectStore(name);
            const paths = store.keyPath === null ? [] : Array.isArray(store.keyPath) ? store.keyPath : [store.keyPath];
            if (!paths.length && !store.autoIncrement) continue;
            await seedStore(name, [1, 2, 3].map(n => {
                const row: any = { note: `${name} 第 ${n} 条 🙂` };
                for (const path of paths) {
                    const parts = path.split('.');
                    let target = row;
                    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
                    target[parts.at(-1)!] = name === 'messages' ? n : `${name}-${n}`;
                }
                return row;
            }));
        }
        const exported = await DB.exportFullData() as Record<string, any>;
        const arrayFields = Object.keys(exported).filter(key => Array.isArray(exported[key]) && exported[key].length > 0);
        expect(arrayFields.length).toBeGreaterThan(40);
        const { bytes, manifest } = await pack(exported);
        for (const field of arrayFields) expect(manifest.stores[field].parts, field).toBeGreaterThan(1);

        const { eager, lazy } = await restoreBothWays(bytes);
        expect(lazy).toEqual(eager);
        expect(Object.values(eager).filter(rows => rows.length > 0).length).toBeGreaterThan(40);
    });

    it('媒体补图包：只带角色媒体、图片消息和资源，贴回本机已有的记录', async () => {
        const post = (text: string, images: any[]) => ({ id: 'p1', authorId: 'user', authorName: '小明', text, createdAt: 1, circleId: 'circle', audienceIds: [], comments: [], images });
        const feed = (text: string, images: any[]) => JSON.stringify({ version: 1, circles: [], posts: [post(text, images)] });
        const picture = { url: 'blobref:img_feed', thumbnail: 'blobref:img_feed' };
        const { bytes } = await pack({
            collaborationBackupMode: 'media_only',
            mediaAssets: [{ charId: 'c1', avatar: PNG_DATA_URL }, { charId: 'c2', avatar: PNG_DATA_URL }, { charId: 'ghost', avatar: PNG_DATA_URL }],
            messages: [{ id: 2, charId: 'c1', role: 'user', type: 'image', content: PNG_DATA_URL }, { id: 3, charId: 'c1', role: 'user', type: 'emoji', content: PNG_DATA_URL }, { id: 4, charId: 'c2', role: 'user', type: 'image', content: PNG_DATA_URL }],
            // 旧的媒体包没有 friendFeedMedia，哔哔图片要从 assets 里的整份正文中取。
            assets: [{ id: 'friend_feed_v1', data: feed('备份里的旧正文', [picture]) }, { id: 'wallpaper', data: PNG_DATA_URL }, { id: 'icon_chat', data: PNG_DATA_URL }],
            customThemes: [{ id: 't1', name: '主题一' }, { id: 't2', name: '主题二' }, { id: 't3', name: '主题三' }],
        });
        const { eager, lazy } = await restoreBothWays(bytes, async () => {
            await seedStore('characters', [{ id: 'c1', name: '本机角色甲', systemPrompt: '文字不动' }, { id: 'c2', name: '本机角色乙' }]);
            await seedStore('messages', [{ id: 1, charId: 'c1', role: 'user', type: 'text', content: '本机文字消息' }]);
            await seedStore('assets', [{ id: 'old-asset', data: '本机原有资源' }, { id: 'friend_feed_v1', data: feed('本机更新的正文', []) }]);
        });
        expect(lazy).toEqual(eager);
        expect(lazy.characters).toEqual([{ id: 'c1', name: '本机角色甲', systemPrompt: '文字不动', avatar: PNG_DATA_URL }, { id: 'c2', name: '本机角色乙', avatar: PNG_DATA_URL }]);
        expect(lazy.messages.map(row => row.id)).toEqual([1, 2, 3, 4]);
        expect(lazy.assets.map(row => row.id).sort()).toEqual(['friend_feed_v1', 'icon_chat', 'old-asset', 'wallpaper']);
        expect(lazy.themes).toHaveLength(3);
        // 哔哔只补图片，正文留本机的。
        expect(JSON.parse(lazy.assets.find(row => row.id === 'friend_feed_v1')!.data).posts[0]).toMatchObject({ text: '本机更新的正文', images: [picture] });
    });

    it('文字备份：活动文字、旧版裸数组收藏索引、剧院几张逐条写入的表', async () => {
        const favorites = [1, 2, 3].map(n => ({ id: `fav-${n}`, title: `收藏 ${n} ⭐` }));
        const { bytes, manifest } = await pack({
            collaborationBackupMode: 'text_only',
            characters: [{ id: 'c1', name: '角色甲' }, { id: 'c2', name: '角色乙' }, { id: 'c3', name: '角色丙' }],
            messages: [1, 2, 3].map(id => ({ id, charId: 'c1', role: 'user', type: 'text', content: `${TEXT} #${id}` })),
            activityTextAssets: [1, 2, 3].map(n => ({ id: `home_secrets_v1_c${n}`, data: `秘密 ${n} 🤫` })),
            contentFavoritesIndex: favorites,
            vrScripts: [1, 2, 3].map(n => ({ id: `script-${n}`, title: `剧本 ${n}` })),
            vrStagedPlays: [1, 2, 3].map(n => ({ id: `play-${n}`, title: `舞台剧 ${n}` })),
            vrPresets: [1, 2, 3].map(n => ({ key: `preset-${n}`, name: `预设 ${n}`, prompt: '' })),
            vrSettings: [1, 2, 3].map(n => ({ id: `setting-${n}`, value: n })),
        });
        expect(manifest.stores.contentFavoritesIndex.parts).toBe(2);
        const { eager, lazy } = await restoreBothWays(bytes, async () => {
            await seedStore('assets', [{ id: 'old-asset', data: '本机原有资源' }, { id: 'home_secrets_v1_old', data: '会被这份备份替换' }]);
        });
        expect(lazy).toEqual(eager);
        expect(lazy.assets).toEqual([
            { id: 'content_favorites_index_v1', data: favorites },
            ...[1, 2, 3].map(n => ({ id: `home_secrets_v1_c${n}`, data: `秘密 ${n} 🤫` })),
            { id: 'old-asset', data: '本机原有资源' },
        ]);
        for (const store of ['vr_scripts', 'vr_plays', 'vr_presets', 'vr_settings']) expect(lazy[store], store).toHaveLength(3);
    });
});

describe('单张图片损坏按缺图处理', () => {
    const BROKEN = new TextEncoder().encode('BROKEN-IMAGE-BYTES-0123456789');

    /** v3 包里两张图：一张好的，一张的字节在包里被改过（CRC 对不上）。 */
    const buildWithBrokenImage = async (corrupt = true) => {
        const good = await putImageBlob(new Blob([PNG], { type: 'image/png' }));
        const bad = await putImageBlob(new Blob([BROKEN], { type: 'image/png' }));
        const data = sampleData(good, 'json');
        data.galleryImages.push({ id: 'g2', charId: 'c2', url: bad });
        const zip = new JSZip();
        zip.file(VOICE_PATH, VOICE);
        const tokens = new Set<string>();
        await writeV2Backup(zip as any, data, { mode: 'full', limits: SMALL_SHARDS, onSerialized: text => collectBlobRefs(text, tokens) });
        expect((await writeBlobsToZip(zip as any, tokens, getBlobForRef)).missing).toEqual([]);
        await deleteBlobRef(good); await deleteBlobRef(bad);
        const bytes = await zip.generateAsync({ type: 'uint8array' });
        if (corrupt) {
            const at = Buffer.from(bytes).indexOf('BROKEN-IMAGE-BYTES');
            expect(at).toBeGreaterThan(0);
            bytes[at] ^= 0x01;
        }
        const expected = expectedDb(good);
        expected.gallery.push({ id: 'g2', charId: 'c2', url: bad });
        return { bytes, good, bad, expected };
    };

    it('blobs/* 里一张图被改坏：恢复完成，其余数据一致，这张图上报为损坏、不写进库，不留「导入中」标记', async () => {
        const { bytes, good, bad, expected } = await buildWithBrokenImage();
        const storage = markerStorage();
        const damaged: string[] = [];
        const zip = await openBackupZip(blobOf(bytes));
        await restoreFrom(zip, () => openLegacyBackup(zip, withVoice(zip)), storage, {}, damaged);
        await zip.close();

        expect(damaged).toEqual([bad.slice('blobref:'.length)]);
        expect(await dumpDb()).toEqual(expected);
        expect(await getBlobForRef(bad)).toBeNull();
        expect(new Uint8Array(await (await getBlobForRef(good))!.arrayBuffer())).toEqual(PNG);
        expect(storage.values.size).toBe(0);
    });

    it('同一个包没被改坏时两张图都恢复，没有上报（反证上一条跳过的是坏图）', async () => {
        const { bytes, bad } = await buildWithBrokenImage(false);
        const damaged: string[] = [];
        const zip = await openBackupZip(blobOf(bytes));
        await restoreFrom(zip, () => openLegacyBackup(zip, withVoice(zip)), markerStorage(), {}, damaged);
        await zip.close();
        expect(damaged).toEqual([]);
        expect(new Uint8Array(await (await getBlobForRef(bad))!.arrayBuffer())).toEqual(BROKEN);
    });

    it.each([
        ['读文件失败（DOMException）', () => new DOMException('file is gone', 'NotReadableError')],
        ['内存不足（RangeError）', () => new RangeError('Array buffer allocation failed')],
    ])('读图片时%s：恢复中止并报出原错误，不当成图片损坏，各表没动', async (_name, makeError) => {
        const { bytes, bad } = await buildWithBrokenImage(false);
        const reader = await openBackupZip(blobOf(bytes));
        const thrown = makeError();
        const zip: Zip = { file: (name: string) => (name === `blobs/${bad.slice('blobref:'.length)}` ? { async: () => Promise.reject(thrown) } : reader.file(name)) };
        const damaged: string[] = [];
        await expect(restoreFrom(zip, () => openLegacyBackup(zip, withVoice(zip)), markerStorage(), {}, damaged)).rejects.toBe(thrown);
        await reader.close();
        expect(damaged).toEqual([]);
        expect(await dumpDb()).toEqual(liveData);
    });
});

describe('v1 / v2 的 assets/* 图片', () => {
    /** 把 zip 里那张图的字节改掉一位：内容还在，CRC 对不上。 */
    const breakAsset = (bytes: Uint8Array) => {
        const at = Buffer.from(bytes).indexOf(Buffer.from(PNG));
        expect(at).toBeGreaterThan(0);
        const copy = bytes.slice();
        copy[at + 8] ^= 0x01;
        return copy;
    };

    it.each(['v1', 'v2'] as const)('%s 图片被改坏：跳过并上报一次，引用保留原路径，其余数据照常恢复', async generation => {
        const { bytes } = await buildPackage(generation);
        const storage = markerStorage();
        const damaged: string[] = [];
        const zip = await openBackupZip(blobOf(breakAsset(bytes)));
        await restoreFrom(zip, () => openLegacyBackup(zip, withVoice(zip)), storage, {}, damaged);
        await zip.close();
        expect(damaged).toEqual(['assets/asset_1.png']);
        expect(await dumpDb()).toEqual(expectedDb('assets/asset_1.png'));
        expect(storage.values.size).toBe(0);
    });

    it('包里没有这张图：保留原路径，不算损坏', async () => {
        const { bytes } = await buildPackage('v2', zip => { zip.remove('assets/asset_1.png'); });
        const damaged: string[] = [];
        const zip = await openBackupZip(blobOf(bytes));
        await restoreFrom(zip, () => openLegacyBackup(zip, withVoice(zip)), markerStorage(), {}, damaged);
        await zip.close();
        expect(damaged).toEqual([]);
        expect(await dumpDb()).toEqual(expectedDb('assets/asset_1.png'));
    });

    it.each([
        ['读文件失败（DOMException）', () => new DOMException('file is gone', 'NotReadableError')],
        ['内存不足（RangeError）', () => new RangeError('Invalid string length')],
    ])('读图片时%s：恢复中止并报出原错误，不当成图片损坏', async (_name, makeError) => {
        const { bytes } = await buildPackage('v2');
        const reader = await openBackupZip(blobOf(bytes));
        const thrown = makeError();
        const zip: Zip = { file: (name: string) => (name === 'assets/asset_1.png' ? { async: () => Promise.reject(thrown) } : reader.file(name)) };
        const damaged: string[] = [];
        await expect(restoreFrom(zip, () => openLegacyBackup(zip, withVoice(zip)), markerStorage(), {}, damaged)).rejects.toBe(thrown);
        await reader.close();
        expect(damaged).toEqual([]);
    });
});

describe('文件失效不当成图片损坏', () => {
    /** 文件被系统收回后不报错、只给出全零数据的环境：gone 之后每次读都是零。 */
    class VanishingBlob extends Blob {
        gone = false;
        slice(start?: number, end?: number, contentType?: string): Blob {
            const part = super.slice(start, end, contentType);
            return this.gone ? new Blob([new Uint8Array(part.size)]) : part;
        }
    }
    /** 读到 target 这张图的那一刻文件失效。 */
    const vanishOn = (reader: Awaited<ReturnType<typeof openBackupZip>>, blob: VanishingBlob, target: string): Zip => ({
        file: (name: string) => {
            const entry = reader.file(name);
            return entry && name === target ? { ...entry, async: (type: any) => { blob.gone = true; return entry.async(type); } } : entry;
        },
        verify: () => reader.verify(),
    });

    it('v3：读第一张图时文件失效，清单也读不出来 → 按读文件失败中止，不上报损坏，各表没动', async () => {
        const { bytes, token } = await buildPackage('v3');
        const blob = new VanishingBlob([bytes as BlobPart]);
        const reader = await openBackupZip(blob);
        const damaged: string[] = [];
        const zip = vanishOn(reader, blob, `blobs/${token!.slice('blobref:'.length)}`);
        const error = await restoreFrom(zip, () => openLegacyBackup(zip, withVoice(zip)), markerStorage(), {}, damaged).catch(e => e);
        expect(error).toBeInstanceOf(DOMException);
        expect(error.name).toBe('NotReadableError');
        expect(error.message).toContain('备份文件已经读不出来了');
        expect(damaged).toEqual([]);
        expect(await getBlobForRef(token!)).toBeNull();
        expect(await dumpDb()).toEqual(liveData);
    });

    it('v1（没有清单，重读压缩包目录）：读图片时文件失效 → 按读文件失败中止，不上报损坏', async () => {
        const { bytes } = await buildPackage('v1');
        const blob = new VanishingBlob([bytes as BlobPart]);
        const reader = await openBackupZip(blob);
        const damaged: string[] = [];
        const zip = vanishOn(reader, blob, 'assets/asset_1.png');
        const error = await restoreFrom(zip, () => openLegacyBackup(zip, withVoice(zip)), markerStorage(), {}, damaged).catch(e => e);
        expect(error).toBeInstanceOf(DOMException);
        expect(error.name).toBe('NotReadableError');
        expect(error.message).toContain('备份文件已经读不出来了');
        expect(damaged).toEqual([]);
    });
});

describe('损坏的包在写库前被拒绝', () => {
    /** 条目按 STORE 写入，改一个字节内容仍是合法 JSON，只有 CRC 对不上。 */
    const tamper = (bytes: Uint8Array) => {
        const at = Buffer.from(bytes).indexOf(TAMPER_TARGET);
        expect(at).toBeGreaterThan(0);
        const copy = bytes.slice();
        copy[at] ^= 0x01;
        return copy;
    };
    const expectUntouched = async (storage: ReturnType<typeof markerStorage>) => {
        expect(await dumpDb()).toEqual(liveData);
        expect(storage.values.has(IMPORT_IN_PROGRESS_KEY)).toBe(false);
    };

    it.each(['v1', 'v2', 'v3'] as const)('%s 文字内容 CRC 不符：拒绝，数据库不变，不留「导入中」标记', async generation => {
        const { bytes } = await buildPackage(generation);
        const storage = markerStorage();
        await expect(restoreLazily(tamper(bytes), storage)).rejects.toThrow(/损坏的备份包/);
        await expectUntouched(storage);
    });

    it('改造前的读法不校验 CRC：同一个包会被当成好包写进库（反证上面这条测的是新行为）', async () => {
        const { bytes } = await buildPackage('v3');
        await restoreEagerly(tamper(bytes));
        expect((await dumpDb()).messages[120].content).not.toBe(TAMPER_TARGET);
    });

    it.each(['v2', 'v3'] as const)('%s 缺分片：拒绝，数据库不变，不留标记', async generation => {
        const { bytes } = await buildPackage(generation, zip => { zip.remove('stores/messages.001.json'); });
        const storage = markerStorage();
        await expect(restoreLazily(bytes, storage)).rejects.toThrow('manifest 声明了 stores/messages.001.json 但 zip 里没有');
        await expectUntouched(storage);
    });

    it('分片条数与清单不符：拒绝，数据库不变，不留标记', async () => {
        const { bytes } = await buildPackage('v3', zip => { zip.file('stores/diaries.000.json', '[]'); });
        const storage = markerStorage();
        await expect(restoreLazily(bytes, storage)).rejects.toThrow('diaries 实际拼出 0 条、manifest 声明 1 条');
        await expectUntouched(storage);
    });

    it('语音文件缺失：校验阶段就拒绝，数据库不变，不留标记', async () => {
        const { bytes } = await buildPackage('v3', zip => { zip.remove(VOICE_PATH); });
        const storage = markerStorage();
        await expect(restoreLazily(bytes, storage)).rejects.toThrow('缺少语音文件');
        await expectUntouched(storage);
    });

    it('不是 zip：拒绝，数据库不变，不留标记', async () => {
        const storage = markerStorage();
        await expect(restoreLazily(new Blob(['这不是压缩包，只是一段文字。'.repeat(100)]), storage)).rejects.toThrow(/损坏的备份包/);
        await expectUntouched(storage);
    });

    it('缺 data.json 也缺 manifest.json：拒绝，数据库不变，不留标记', async () => {
        const { bytes } = await buildPackage('v1', zip => { zip.remove('data.json'); });
        const storage = markerStorage();
        await expect(restoreLazily(bytes, storage)).rejects.toThrow('缺少 data.json');
        await expectUntouched(storage);
    });

    it('反证标记看得见：开始写库之后才失败的恢复会留下标记', async () => {
        const { bytes } = await buildPackage('v1', zip => {
            zip.file('data.json', JSON.stringify({ ...sampleData('assets/asset_1.png', 'json'), diaries: [{ content: '没有主键的记录' }] }));
        });
        const storage = markerStorage();
        await expect(restoreLazily(bytes, storage)).rejects.toThrow();
        expect(storage.values.has(IMPORT_IN_PROGRESS_KEY)).toBe(true);
    });
});
