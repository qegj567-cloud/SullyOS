import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    measureValue,
    measureStoreUsage,
    summarizeUsage,
    categoryOfStore,
    categoryOfAssetKey,
    categoryOfDatabase,
    readStorageOverview,
    requestPersistentStorage,
    formatBytes,
    binaryKindOfMime,
    calibrateBreakdown,
    type DatabaseUsage,
} from './storageStats';

// fake-indexeddb 由 test-setup.ts 注入。

let dbSeq = 0;
function openTestDb(stores: string[]): Promise<IDBDatabase> {
    const name = `storage_stats_test_${dbSeq++}`;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
            for (const s of stores) req.result.createObjectStore(s, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function putAll(db: IDBDatabase, store: string, items: any[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        for (const it of items) os.put(it);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

const usageOf = (stores: DatabaseUsage['stores']): DatabaseUsage => ({ stores, failed: [] });

afterEach(() => { vi.unstubAllGlobals(); });

describe('measureValue', () => {
    it('二进制走 byteLength，不被 JSON 序列化撑爆', () => {
        // 记忆宫殿的向量表：直接 JSON.stringify 会变成 {"0":0.123,"1":...} 那种巨型字符串，
        // 既慢又把数字放大好几倍。守住「按 byteLength 算」这条。
        const vector = new Float32Array(768).fill(0.123456789);
        const m = measureValue({ id: 'v1', vector });
        expect(m.bytes).toBeGreaterThanOrEqual(768 * 4);
        expect(m.bytes).toBeLessThan(768 * 4 + 200);
    });

    it('Blob 按 MIME 分种类记账', () => {
        const m = measureValue({
            id: 'a',
            pic: new Blob(['x'.repeat(1000)], { type: 'image/png' }),
            model: new Blob(['y'.repeat(2000)], { type: 'application/zip' }),
        });
        expect(m.binaryBytes.image).toBe(1000);
        expect(m.binaryBytes.binary).toBe(2000);
        expect(m.bytes).toBeGreaterThanOrEqual(3000);
    });

    it('中文按 UTF-8 算，不是按字符数', () => {
        const m = measureValue('好'.repeat(100));
        expect(m.bytes).toBeGreaterThanOrEqual(300);
    });

    it('循环引用不抛，退化成只算二进制那部分', () => {
        const cyclic: any = { id: 'x', blob: new Blob(['z'.repeat(500)], { type: 'image/png' }) };
        cyclic.self = cyclic;
        const m = measureValue(cyclic);
        expect(m.bytes).toBe(500);
    });
});

describe('binaryKindOfMime', () => {
    it('图 / 声音 / 一坨二进制分得开', () => {
        expect(binaryKindOfMime('image/webp')).toBe('image');
        expect(binaryKindOfMime('audio/mpeg')).toBe('audio');
        expect(binaryKindOfMime('application/zip')).toBe('binary');
        expect(binaryKindOfMime('')).toBe('binary');
        expect(binaryKindOfMime(undefined)).toBe('binary');
    });
});

describe('measureStoreUsage', () => {
    it('小表全量精确，不标「约」', async () => {
        const db = await openTestDb(['messages']);
        const items = Array.from({ length: 50 }, (_, i) => ({ id: i, text: 'hello world' }));
        await putAll(db, 'messages', items);

        const [usage] = await measureStoreUsage(db, 'messages');
        const truth = items.reduce((n, it) => n + measureValue(it).bytes, 0);
        expect(usage.count).toBe(50);
        expect(usage.estimated).toBe(false);
        expect(usage.bytes).toBe(truth);
        db.close();
    });

    it('空表回 0', async () => {
        const db = await openTestDb(['messages']);
        expect(await measureStoreUsage(db, 'messages')).toEqual([]);
        db.close();
    });

    it('一张表里住着几个类别时按 key 分开记，合计不变', async () => {
        const db = await openTestDb(['assets']);
        const items = [
            { id: 'wallpaper', data: 'w'.repeat(100) },
            { id: 'tts_abc', blob: new Blob([new Uint8Array(400)], { type: 'audio/mpeg' }) },
            { id: 'tts_def', blob: new Blob([new Uint8Array(600)], { type: 'audio/mpeg' }) },
            { id: 'voice_msg_42', blob: new Blob([new Uint8Array(300)], { type: 'audio/webm' }) },
        ];
        await putAll(db, 'assets', items);

        const parts = await measureStoreUsage(db, 'assets', categoryOfAssetKey);
        const bytesOf = (key: string) => parts.find(p => p.category === key)?.bytes ?? 0;
        expect(parts.map(p => p.category).sort()).toEqual(['appearance', 'chat', 'ttsCache']);
        expect(bytesOf('ttsCache')).toBeGreaterThanOrEqual(1000);
        expect(bytesOf('chat')).toBeGreaterThanOrEqual(300);
        expect(parts.reduce((n, p) => n + p.bytes, 0)).toBe(items.reduce((n, it) => n + measureValue(it).bytes, 0));
        expect(parts.reduce((n, p) => n + p.count, 0)).toBe(4);
        db.close();
    });

    it('大表是均匀跳采，不会被「前面全是小记录」带偏', async () => {
        // 真实形态：早期全是纯文字短消息，后期混进带图的大消息。
        // 用「取前 N 条」的实现在这里会低估一个数量级 —— 这条就是钉死跳采的守卫。
        const db = await openTestDb(['messages']);
        const items = Array.from({ length: 2000 }, (_, i) => ({
            id: i,
            text: i < 1500 ? 'hi' : 'x'.repeat(2000),
        }));
        await putAll(db, 'messages', items);

        const [usage] = await measureStoreUsage(db, 'messages');
        const truth = items.reduce((n, it) => n + measureValue(it).bytes, 0);

        expect(usage.count).toBe(2000);
        expect(usage.estimated).toBe(true);
        expect(usage.bytes).toBeGreaterThan(truth * 0.8);
        expect(usage.bytes).toBeLessThan(truth * 1.2);
        db.close();
    });
});

describe('summarizeUsage', () => {
    it('blob_assets 按 MIME 拆开：图片算媒体、模型单列', () => {
        const bd = summarizeUsage([{
            usage: usageOf([{
                store: 'blob_assets',
                bytes: 1000,
                count: 2,
                estimated: false,
                binaryBytes: { image: 600, binary: 300 },
            }]),
        }]);
        expect(bd.categories.find(c => c.key === 'models')?.bytes).toBe(300);
        expect(bd.categories.find(c => c.key === 'media')?.bytes).toBe(700);
        expect(bd.totalBytes).toBe(1000);
    });

    it('没登记过的新表落到「其他」，总量不会漏', () => {
        const bd = summarizeUsage([{
            usage: usageOf([
                { store: 'messages', bytes: 500, count: 1, estimated: false, binaryBytes: {} },
                { store: 'brand_new_2027_feature', bytes: 300, count: 1, estimated: false, binaryBytes: {} },
            ]),
        }]);
        expect(bd.categories.find(c => c.key === 'chat')?.bytes).toBe(500);
        expect(bd.categories.find(c => c.key === 'other')?.bytes).toBe(300);
        expect(bd.totalBytes).toBe(800);
    });

    it('按 key 分流出来的类别优先于表名', () => {
        const bd = summarizeUsage([{
            usage: usageOf([
                { store: 'assets', category: 'ttsCache', bytes: 700, count: 2, estimated: false, binaryBytes: { audio: 650 } },
                { store: 'assets', category: 'appearance', bytes: 100, count: 1, estimated: false, binaryBytes: {} },
            ]),
        }]);
        expect(bd.categories.map(c => [c.key, c.bytes])).toEqual([['ttsCache', 700], ['appearance', 100]]);
    });

    it('整库归类的库（主动消息）不按表名拆', () => {
        const bd = summarizeUsage([{
            usage: usageOf([
                { store: 'inbox', bytes: 100, count: 1, estimated: false, binaryBytes: {} },
                { store: 'kv', bytes: 50, count: 1, estimated: false, binaryBytes: {} },
            ]),
            forceCategory: 'activeMsg',
        }]);
        expect(bd.categories).toHaveLength(1);
        expect(bd.categories[0]).toMatchObject({ key: 'activeMsg', bytes: 150 });
    });

    it('任一表带估算，那一类就标「约」', () => {
        const bd = summarizeUsage([{
            usage: usageOf([
                { store: 'messages', bytes: 100, count: 1, estimated: false, binaryBytes: {} },
                { store: 'groups', bytes: 900, count: 9999, estimated: true, binaryBytes: {} },
            ]),
        }]);
        expect(bd.categories.find(c => c.key === 'chat')?.estimated).toBe(true);
    });

    it('「其他」永远排最后，其余按大小降序', () => {
        const bd = summarizeUsage([{
            usage: usageOf([
                { store: 'misc_store', bytes: 9999, count: 1, estimated: false, binaryBytes: {} },
                { store: 'messages', bytes: 100, count: 1, estimated: false, binaryBytes: {} },
                { store: 'characters', bytes: 200, count: 1, estimated: false, binaryBytes: {} },
            ]),
        }]);
        expect(bd.categories.map(c => c.key)).toEqual(['characters', 'chat', 'other']);
    });

    it('读不出来的表只记名字，不打断统计', () => {
        const bd = summarizeUsage([{
            usage: { stores: [{ store: 'messages', bytes: 100, count: 1, estimated: false, binaryBytes: {} }], failed: ['broken_store'] },
        }]);
        expect(bd.totalBytes).toBe(100);
        expect(bd.failedStores).toEqual(['broken_store']);
    });
});

describe('categoryOfStore', () => {
    it('认识的表归位，不认识的进「其他」', () => {
        expect(categoryOfStore('messages')).toBe('chat');
        expect(categoryOfStore('memory_vectors')).toBe('memory');
        expect(categoryOfStore('gallery')).toBe('gallery');
        expect(categoryOfStore('characters')).toBe('characters');
        expect(categoryOfStore('bank_transactions')).toBe('bank');
        expect(categoryOfStore('brand_new_2027_feature')).toBe('other');
    });

    it('主库里每张表都登记了类别', async () => {
        // 没登记的表会悄悄掉进「其他数据」，用户看到的就是一行说不清是什么的大数字。
        // 加新表时在 storageStats.ts 的 STORE_CATEGORY 里补一行，这条才会过。
        const { openDB } = await import('./db');
        const db = await openDB();
        const unregistered = Array.from(db.objectStoreNames).filter(name => categoryOfStore(name) === 'other');
        expect(unregistered).toEqual([]);
    });
});

describe('categoryOfAssetKey', () => {
    it('认识的前缀归到各自的 App，其余算外观与系统素材', () => {
        expect(categoryOfAssetKey('tts_1a2b')).toBe('ttsCache');
        expect(categoryOfAssetKey('voice_msg_123')).toBe('chat');
        expect(categoryOfAssetKey('voice_favorite_audio_x')).toBe('favorites');
        expect(categoryOfAssetKey('friend_feed_v1')).toBe('friendFeed');
        expect(categoryOfAssetKey('mp_hwm_v1_c1')).toBe('memory');
        expect(categoryOfAssetKey('wallpaper')).toBe('appearance');
        expect(categoryOfAssetKey(42)).toBe('appearance');
    });
});

describe('categoryOfDatabase', () => {
    it('只有各用户空间的主库按表名细分', async () => {
        const { spaceDatabaseName } = await import('./userSpaces');
        const { RESOURCE_PACK_DB } = await import('../apps/room3d/resourcePacks');
        expect(categoryOfDatabase('AetherOS_Data')).toBeUndefined();
        expect(categoryOfDatabase(spaceDatabaseName('AetherOS_Data', 'u_abc'))).toBeUndefined();
        // 协同工作库里也有 messages / assets 两张表，按表名判会记到聊天和外观头上
        expect(categoryOfDatabase(spaceDatabaseName('SullyOS_Collaboration', 'u_abc'))).toBe('collaboration');
        expect(categoryOfDatabase('SullyOS_Collaboration')).toBe('collaboration');
        expect(categoryOfDatabase('SullyOS_CharacterSafety')).toBe('characters');
        expect(categoryOfDatabase(RESOURCE_PACK_DB)).toBe('roomPacks');
        expect(categoryOfDatabase('ActiveMsg')).toBe('activeMsg');
        expect(categoryOfDatabase('ActiveMsgSwTrace')).toBe('activeMsg');
        expect(categoryOfDatabase('some_unknown_db')).toBe('other');
    });
});

describe('readStorageOverview', () => {
    it('浏览器不给用量信息时回 null，不拿 0 顶上', async () => {
        // 关键：0 会被界面显示成「你一点数据都没有」，比「读不到」误导得多。
        vi.stubGlobal('navigator', {
            storage: {
                estimate: () => Promise.reject(new Error('SecurityError')),
                persisted: () => Promise.resolve(false),
            },
        });
        const ov = await readStorageOverview();
        expect(ov.supported).toBe(false);
        expect(ov.usageBytes).toBeNull();
        expect(ov.quotaBytes).toBeNull();
        expect(ov.persisted).toBe(false);
    });

    it('完全没有 storage API 时整体降级，不抛', async () => {
        vi.stubGlobal('navigator', {});
        const ov = await readStorageOverview();
        expect(ov).toEqual({ supported: false, usageBytes: null, quotaBytes: null, indexedDbBytes: null, persisted: null });
    });

    it('查不了持久化状态时回 null（≠ 没拿到许可）', async () => {
        vi.stubGlobal('navigator', { storage: { estimate: () => Promise.resolve({ usage: 1024, quota: 4096 }) } });
        const ov = await readStorageOverview();
        expect(ov).toMatchObject({ supported: true, usageBytes: 1024, quotaBytes: 4096, persisted: null });
    });
});

describe('requestPersistentStorage', () => {
    it('申请被拒回 false，不抛', async () => {
        vi.stubGlobal('navigator', { storage: { persist: () => Promise.reject(new Error('denied')) } });
        expect(await requestPersistentStorage()).toBe(false);
    });

    it('浏览器没有 persist 时回 false', async () => {
        vi.stubGlobal('navigator', { storage: {} });
        expect(await requestPersistentStorage()).toBe(false);
    });

    it('拿到许可回 true', async () => {
        vi.stubGlobal('navigator', { storage: { persist: () => Promise.resolve(true) } });
        expect(await requestPersistentStorage()).toBe(true);
    });
});

describe('formatBytes', () => {
    it('读不到的时候显示「—」而不是 0 B', () => {
        expect(formatBytes(null)).toBe('—');
        expect(formatBytes(undefined)).toBe('—');
        expect(formatBytes(NaN)).toBe('—');
        expect(formatBytes(-1)).toBe('—');
    });

    it('按量级换单位', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1536)).toBe('1.5 KB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
        expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
    });
});

describe('computeStorageBreakdown（端到端）', () => {
    it('能把主库里的数据归类，且不会凭空建出别的库', async () => {
        const { openDB } = await import('./db');
        const { computeStorageBreakdown } = await import('./storageStats');

        const db = await openDB();
        await putAll(db, 'messages', [
            { id: 'e2e-1', charId: 'c1', content: '测试消息'.repeat(20) },
            { id: 'e2e-2', charId: 'c1', content: '测试消息'.repeat(20) },
        ]);

        // ActiveMsg 这类库在测试环境里并不存在。统计过程只能「连已有的库」，
        // 绝不能因为去看一眼就把空库建出来 —— 那会给用户平白多出脏数据。
        const namesBefore = (await indexedDB.databases()).map(d => d.name).sort();

        const progressTicks: number[] = [];
        const breakdown = await computeStorageBreakdown(p => progressTicks.push(p.done));

        const namesAfter = (await indexedDB.databases()).map(d => d.name).sort();
        expect(namesAfter).toEqual(namesBefore);

        expect(breakdown.totalBytes).toBeGreaterThan(0);
        expect(breakdown.categories.find(c => c.key === 'chat')?.bytes).toBeGreaterThan(0);
        expect(progressTicks.length).toBeGreaterThan(0);

        db.close();
    });

    it('浏览器不给枚举库列表时走兜底名单，不存在的库看一眼就删干净', async () => {
        // 走兜底路径（Firefox 126 之前没有 databases()）。兜底名单里的 ActiveMsg 在这个
        // 测试环境里并不存在 —— 不带版本号 open 一个不存在的库会把它凭空建出来，
        // 这里钉死「建出来了也要删回去」，别给用户留一堆空库。
        const { computeStorageBreakdown } = await import('./storageStats');
        const spy = vi.spyOn(indexedDB, 'databases').mockRejectedValue(new Error('not supported'));
        try {
            await computeStorageBreakdown();
        } finally {
            spy.mockRestore();
        }
        const names = (await indexedDB.databases()).map(d => d.name);
        expect(names).not.toContain('ActiveMsg');
    });
});

describe('calibrateBreakdown（按浏览器实报折算）', () => {
    // 库里量到 1000（文本 600 + Blob 400），浏览器实报 800。
    // 差的 200 只可能压在文本上——Blob 独立落盘不参与 LevelDB 压缩。
    const raw = () => summarizeUsage([{
        usage: usageOf([
            { store: 'messages', bytes: 600, count: 1, estimated: false, binaryBytes: {} },
            { store: 'blob_assets', bytes: 400, count: 1, estimated: false, binaryBytes: { image: 400 } },
        ]),
    }]);

    it('高估时只缩文本，二进制一个字节不动', () => {
        const bd = calibrateBreakdown(raw(), 800);
        expect(bd.calibrated).toBe(true);
        // 文本能分 800-400=400，原本 600 → 系数 2/3
        expect(bd.categories.find(c => c.key === 'chat')?.bytes).toBe(400);
        expect(bd.categories.find(c => c.key === 'media')?.bytes).toBe(400);
        expect(bd.totalBytes).toBe(800);
    });

    it('合计对齐实报值，不再出现「细分比总量还大」', () => {
        const bd = calibrateBreakdown(raw(), 800);
        expect(bd.totalBytes).toBeLessThanOrEqual(800);
    });

    it('我们没高估时保持原样，差额留给「其他占用」去交代', () => {
        const bd = calibrateBreakdown(raw(), 5000);
        expect(bd.calibrated).toBe(false);
        expect(bd.totalBytes).toBe(1000);
    });

    it('读不到实报值（非 Chrome）就不折算', () => {
        expect(calibrateBreakdown(raw(), null).calibrated).toBe(false);
    });

    it('二进制已经撑满实报值时不硬折（口径对不上，宁可不动）', () => {
        const bd = calibrateBreakdown(raw(), 300);
        expect(bd.calibrated).toBe(false);
        expect(bd.totalBytes).toBe(1000);
    });

    it('纯二进制的库不折算（没有文本可缩）', () => {
        const onlyBinary = summarizeUsage([{
            usage: usageOf([{ store: 'blob_assets', bytes: 400, count: 1, estimated: false, binaryBytes: { image: 400 } }]),
        }]);
        expect(calibrateBreakdown(onlyBinary, 300).calibrated).toBe(false);
    });
});


it('角色安全快照库计入角色资料，不落进其他应用', async () => {
    const {writeCharacterSafetySnapshotNow, resetAllCharacterSafetySnapshots} = await import('./characterSafetySnapshots');
    const {computeStorageBreakdown} = await import('./storageStats');
    await writeCharacterSafetySnapshotNow('default', {id:'stats-safety',name:'快照',avatar:'',description:'',systemPrompt:'测试'.repeat(100),memories:[]});
    try {
        const result = await computeStorageBreakdown();
        expect(result.categories.find(c => c.key === 'characters')?.bytes).toBeGreaterThan(0);
    } finally { await resetAllCharacterSafetySnapshots(); }
});
