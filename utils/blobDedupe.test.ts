import { describe, it, expect, beforeEach } from 'vitest';
import { DB, openDB } from './db';
import { rewriteBlobRefs, rewriteRefsInText, rewriteRefsDeep, collectUnmergeableRefs, buildMergePlan } from './blobDedupe';
import { REF_SOURCE_STORES, runBlobGc } from './blobGc';
import { getBlobForRef, BLOBREF_PREFIX } from './blobRef';
import { blobStore } from './blobStore';
// Deliberately create distinct legacy aliases. Normal uploads now reuse a content hash.
const putImageBlob = (blob: Blob) => blobStore.put(blob);
import { tryAcquireMaintenanceLock, releaseMaintenanceLock } from './maintenanceLock';

// fake-indexeddb 已由 test-setup.ts 注入。
// 这组用例钉住令牌合并（引用搬家）的几条生死线：
//   1. 边界：令牌 A 是令牌 B 的前缀时，改 A 不能伤到 B（裸字符串 replaceAll 会踩）；
//   2. 行的完整性：Blob / Date 这类非 JSON 值必须原样留着（stringify→parse 往返会毁）；
//   3. 覆盖面：嵌套 JSON 字符串、localStorage、各引用面表都要改到，且与 GC 同源；
//   4. 入参体检：自指 / 链式 / 保留方没有 Blob 一律拒绝（改错不可逆）；
//   5. 端到端：改写后跑 GC，重复的 Blob 被回收、保留方与图都还在。

const tinyBlob = (byte: string) => new Blob([byte], { type: 'image/png' });

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function seedStore(name: string, records: any[]): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        for (const r of records) store.put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function readRow(name: string, key: IDBValidKey): Promise<any> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

beforeEach(async () => {
    for (const s of ['blob_assets', 'characters', 'messages', 'songs', 'assets', 'cc_custom_parts']) {
        await clearStore(s);
    }
    localStorage.clear();
});

describe('文本改写的边界', () => {
    it('令牌 A 是令牌 B 的前缀时，改 A 不伤 B', () => {
        const a = `${BLOBREF_PREFIX}b_aaa`;
        const b = `${BLOBREF_PREFIX}b_aaa_bbb`;
        const keep = `${BLOBREF_PREFIX}b_keep`;
        const text = `前 ${a} 中 ${b} 后`;

        expect(rewriteRefsInText(text, new Map([[a, keep]])))
            .toBe(`前 ${keep} 中 ${b} 后`);
    });

    it('表里没有的令牌原样留下', () => {
        const other = `${BLOBREF_PREFIX}b_other`;
        expect(rewriteRefsInText(`x ${other} y`, new Map([[`${BLOBREF_PREFIX}b_zzz`, `${BLOBREF_PREFIX}b_keep`]])))
            .toBe(`x ${other} y`);
    });

    it('紧贴在 JSON 引号 / 逗号之间的令牌照样命中', () => {
        const from = `${BLOBREF_PREFIX}b_1`;
        const to = `${BLOBREF_PREFIX}b_2`;
        const json = JSON.stringify({ wallpaper: from, list: [from] });
        expect(rewriteRefsInText(json, new Map([[from, to]])))
            .toBe(JSON.stringify({ wallpaper: to, list: [to] }));
    });
});

describe('对象树改写：只碰 string，别的原样', () => {
    it('Blob / Date / 数字 / null 一律不动，令牌照改', () => {
        const from = `${BLOBREF_PREFIX}b_1`;
        const to = `${BLOBREF_PREFIX}b_2`;
        const when = new Date('2020-01-01T00:00:00.000Z');
        const binary = tinyBlob('x');
        const row: any = { avatar: from, when, binary, count: 3, nothing: null, nested: { img: from } };

        expect(rewriteRefsDeep(row, new Map([[from, to]]))).toBe(true);
        expect(row.avatar).toBe(to);
        expect(row.nested.img).toBe(to);
        // 这三条钉的是「别 JSON.stringify 整行再 parse 回来」——那样 Date 会变字符串、Blob 变 {}
        expect(row.when).toBeInstanceOf(Date);
        expect(row.binary).toBeInstanceOf(Blob);
        expect(row.count).toBe(3);
        expect(row.nothing).toBeNull();
    });

    it('没命中任何令牌时返回 false（调用方据此跳过写回）', () => {
        const row = { avatar: `${BLOBREF_PREFIX}b_other`, text: '普通文字' };
        expect(rewriteRefsDeep(row, new Map([[`${BLOBREF_PREFIX}b_1`, `${BLOBREF_PREFIX}b_2`]]))).toBe(false);
    });

    it('循环引用不死循环', () => {
        const from = `${BLOBREF_PREFIX}b_1`;
        const to = `${BLOBREF_PREFIX}b_2`;
        const a: any = { img: from };
        a.self = a;
        expect(rewriteRefsDeep(a, new Map([[from, to]]))).toBe(true);
        expect(a.img).toBe(to);
    });
});

describe('全引用面改写', () => {
    it('表行、嵌套 JSON 字符串、localStorage 一起改到', async () => {
        const keep = await putImageBlob(tinyBlob('a'));
        const dup = await putImageBlob(tinyBlob('a'));

        // 顺手在行里塞 Date / Blob：写回路径也不许把非 JSON 值弄丢
        const when = new Date('2020-01-01T00:00:00.000Z');
        await seedStore('characters', [{
            id: 'c1', avatar: dup, createdAt: when, voiceClip: tinyBlob('v'),
            roomConfig: { items: [{ id: 'i1', image: dup }] },
        }]);
        await seedStore('songs', [{ id: 's1', coverImage: dup }]);
        // assets 的外观预设：令牌藏在一段 JSON 文本里
        await DB.saveAsset('appearance_preset_1', JSON.stringify({ theme: { wallpaper: dup } }));
        localStorage.setItem('acnh_wallpaper_backup', dup);

        const r = await rewriteBlobRefs(new Map([[dup, keep]]));

        expect((await readRow('characters', 'c1')).avatar).toBe(keep);
        expect((await readRow('characters', 'c1')).roomConfig.items[0].image).toBe(keep);
        expect((await readRow('characters', 'c1')).createdAt).toBeInstanceOf(Date);
        expect((await readRow('characters', 'c1')).voiceClip).toBeInstanceOf(Blob);
        expect((await readRow('songs', 's1')).coverImage).toBe(keep);
        expect(JSON.parse((await DB.getAsset('appearance_preset_1'))!).theme.wallpaper).toBe(keep);
        expect(localStorage.getItem('acnh_wallpaper_backup')).toBe(keep);
        expect(r.rewrittenRows).toBe(3);
        expect(r.rewrittenLocalKeys).toBe(1);
    });

    it('没有任何引用命中时一行都不写回，也不报「合并了几份」', async () => {
        const keep = await putImageBlob(tinyBlob('a'));
        const dup = await putImageBlob(tinyBlob('a'));
        await seedStore('characters', [{ id: 'c1', avatar: '普通头像' }]);

        const r = await rewriteBlobRefs(new Map([[dup, keep]]));
        expect(r.rewrittenRows).toBe(0);
        expect(r.scannedRows).toBeGreaterThan(0);
        // 映射里有它、库里也确实有两份一样的 Blob，但没人引用 dup —— 这一轮什么都没合并成。
        // 按映射条数报账就会虚报出一笔并不存在的收益（合并后的孤儿 Blob 会一直被重复扫出来）。
        expect(r.mergedRefs.size).toBe(0);
    });

    it('只统计真改掉的那些令牌', async () => {
        const keep = await putImageBlob(tinyBlob('a'));
        const usedDup = await putImageBlob(tinyBlob('a'));
        const orphanDup = await putImageBlob(tinyBlob('a'));
        await seedStore('characters', [{ id: 'c1', avatar: usedDup }]);

        const r = await rewriteBlobRefs(new Map([[usedDup, keep], [orphanDup, keep]]));
        expect([...r.mergedRefs]).toEqual([usedDup]);
    });

    it('空映射直接返回，不扫库', async () => {
        const r = await rewriteBlobRefs(new Map());
        expect(r).toEqual({ rewrittenRows: 0, rewrittenLocalKeys: 0, scannedRows: 0, mergedRefs: new Set() });
    });
});

describe('入参体检（改错不可逆，一律拒绝）', () => {
    it('令牌指向自己 → 抛', async () => {
        const t = await putImageBlob(tinyBlob('a'));
        await expect(rewriteBlobRefs(new Map([[t, t]]))).rejects.toThrow(/指向自己/);
    });

    it('链式映射（A→B 同时 B→C）→ 抛', async () => {
        const a = await putImageBlob(tinyBlob('a'));
        const b = await putImageBlob(tinyBlob('a'));
        const c = await putImageBlob(tinyBlob('a'));
        await expect(rewriteBlobRefs(new Map([[a, b], [b, c]]))).rejects.toThrow(/一跳/);
    });

    it('保留方读不到 Blob → 抛，且一行都没改', async () => {
        const dup = await putImageBlob(tinyBlob('a'));
        const ghost = `${BLOBREF_PREFIX}b_ghost`;
        await seedStore('characters', [{ id: 'c1', avatar: dup }]);

        await expect(rewriteBlobRefs(new Map([[dup, ghost]]))).rejects.toThrow(/读不到 Blob/);
        expect((await readRow('characters', 'c1')).avatar).toBe(dup);
    });
});

describe('与孤儿 GC 的配合', () => {
    it('清单守卫：改写走的引用面就是 GC 的那一份', () => {
        // 两边共用同一个常量——GC 能 mark 到的面，改写就能改到。
        // 换成各自维护的清单时，这条会红。
        expect(REF_SOURCE_STORES.length).toBeGreaterThan(0);
        expect([...REF_SOURCE_STORES]).toEqual(
            [
                'daily_schedule', 'characters', 'messages', 'cc_custom_parts', 'songs', 'gallery', 'assets', 'themes', 'emojis',
                'user_profile', 'social_posts', 'groups', 'character_groups', 'story_theater_masks',
                'bank_data', 'guidebook', 'life_sim', 'pixel_home_assets',
            ],
        );
    });

    it('端到端：合并引用后跑 GC，重复 Blob 被回收，保留方与图都还在', async () => {
        const keep = await putImageBlob(tinyBlob('a'));
        const dup = await putImageBlob(tinyBlob('a'));
        await seedStore('characters', [{ id: 'c1', avatar: dup }, { id: 'c2', avatar: keep }]);

        await rewriteBlobRefs(new Map([[dup, keep]]));
        // minAgeMs: 0 关掉新鲜豁免——刚 put 的 Blob 否则会被豁免窗口保住
        const gc = await runBlobGc({ minAgeMs: 0 });

        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(1);
        expect(await getBlobForRef(dup)).toBeNull();
        expect(await getBlobForRef(keep)).not.toBeNull();
        expect((await readRow('characters', 'c1')).avatar).toBe(keep);
    });

    it('维护互斥：改写由调用方持锁，锁被占时 GC 干净拒绝', async () => {
        expect(tryAcquireMaintenanceLock('测试占用')).toBe(true);
        try {
            await expect(runBlobGc()).rejects.toThrow(/正在进行/);
        } finally {
            releaseMaintenanceLock();
        }
    });
});

describe('不参与合并的令牌（裸删字段）', () => {
    it('五个裸删字段的令牌全被捞出来', async () => {
        const avatar = `${BLOBREF_PREFIX}b_avatar`;
        const stage = `${BLOBREF_PREFIX}b_stage`;
        const deskBg = `${BLOBREF_PREFIX}b_deskbg`;
        const snapshot = `${BLOBREF_PREFIX}b_snap`;
        const fakeCam = `${BLOBREF_PREFIX}b_fakecam`;
        // 同一行里的安全字段：不该被捞进来
        const roomWall = `${BLOBREF_PREFIX}b_wall`;

        await seedStore('characters', [{
            id: 'c1',
            companionAvatar: { imageRef: avatar },
            videoCallBackground: stage,
            companionBackground: deskBg,
            roomConfig: { wallImage: roomWall },
        }]);
        await seedStore('messages', [{ id: 1, metadata: { cameraSnapshotRef: snapshot } }]);
        localStorage.setItem('sully-call-fake-camera-image-v1', fakeCam);

        const refs = await collectUnmergeableRefs();
        expect([...refs].sort()).toEqual([avatar, deskBg, fakeCam, snapshot, stage].sort());
        expect(refs.has(roomWall)).toBe(false);
    });

    it('衣柜条目的令牌也被捞出来（跟顶层 imageRef 共用令牌，换图时会跟着一起删）', async () => {
        const active = `${BLOBREF_PREFIX}b_active`;
        const spare = `${BLOBREF_PREFIX}b_spare`;

        await seedStore('characters', [{
            id: 'c1',
            companionAvatar: {
                imageRef: active,
                imageWardrobe: [
                    { id: active, imageRef: active, fileName: '现在穿的.png' },
                    { id: spare, imageRef: spare, fileName: '备用.png' },
                ],
            },
        }]);

        const refs = await collectUnmergeableRefs();
        expect([...refs].sort()).toEqual([active, spare].sort());
    });

    it('imageWardrobe 不是数组时照常收顶层，不炸', async () => {
        const active = `${BLOBREF_PREFIX}b_active`;
        await seedStore('characters', [
            { id: 'c1', companionAvatar: { imageRef: active, imageWardrobe: '坏数据' } },
            { id: 'c2', companionAvatar: { imageWardrobe: null } },
        ]);
        expect([...await collectUnmergeableRefs()]).toEqual([active]);
    });

    it('字段是普通图片地址 / 空值时不误收', async () => {
        await seedStore('characters', [{
            id: 'c1',
            companionAvatar: { imageRef: 'https://example.com/a.png' },
            videoCallBackground: '',
            companionBackground: undefined,
        }]);
        expect((await collectUnmergeableRefs()).size).toBe(0);
    });
});

describe('合并计划', () => {
    const g = (canonical: string, duplicates: string[], wastedBytes = 100) => ({
        canonical, duplicates, wastedBytes, size: duplicates.length ? wastedBytes / duplicates.length : wastedBytes,
    });

    it('普通重复组收敛成一跳映射', () => {
        const plan = buildMergePlan([g('t_a', ['t_b', 't_c'])], new Set());
        expect([...plan.mapping]).toEqual([['t_b', 't_a'], ['t_c', 't_a']]);
        expect(plan.skippedGroups).toBe(0);
        expect(plan.reclaimableBytes).toBe(100);
    });

    it('保留方被裸删字段引用 → 整组跳过', () => {
        const plan = buildMergePlan([g('t_a', ['t_b'])], new Set(['t_a']));
        expect(plan.mapping.size).toBe(0);
        expect(plan.skippedGroups).toBe(1);
        expect(plan.reclaimableBytes).toBe(0);
    });

    it('被合并方被裸删字段引用 → 同样整组跳过（只剔掉它并不能让剩下的变安全）', () => {
        const plan = buildMergePlan([g('t_a', ['t_b', 't_c'])], new Set(['t_c']));
        expect(plan.mapping.size).toBe(0);
        expect(plan.skippedGroups).toBe(1);
    });

    it('安全组照常合并，跳过的组不计入可回收字节', () => {
        const plan = buildMergePlan(
            [g('t_a', ['t_b'], 100), g('t_x', ['t_y'], 500)],
            new Set(['t_y']),
        );
        expect([...plan.mapping]).toEqual([['t_b', 't_a']]);
        expect(plan.skippedGroups).toBe(1);
        expect(plan.reclaimableBytes).toBe(100);
    });

    it('空 duplicates 的组直接忽略', () => {
        const plan = buildMergePlan([g('t_a', [])], new Set());
        expect(plan.mapping.size).toBe(0);
        expect(plan.skippedGroups).toBe(0);
    });
});
