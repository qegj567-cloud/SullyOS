import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DB, openDB } from './db';
import { optimizeResourceStorage, OPTIMIZE_TARGET_STORES } from './storageOptimize';
import { REF_SOURCE_STORES, runBlobGc } from './blobGc';
import { isBlobRef, getBlobForRef, dataUrlToBlob, putImageBlob, clearContentMemo } from './blobRef';
import { blobStore } from './blobStore';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock } from './maintenanceLock';
import { ChatPrompts } from './chatPrompts';
import { buildGroupHistoryBlock } from './groupChat/prompts';

// fake-indexeddb 已通过 test-setup.ts 注入。
// 这组用例钉「优化资源存储」的安全边界：只转已接令牌链路的面、原值失败保留、
// 幂等可重跑、目标表必须在 GC 引用面清单内（否则转出的 Blob 会被 GC 当孤儿删）。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// 字节内容随意（没人校验 jpeg 魔数），要的只是「另一份不同的 data URL」
const TINY_JPEG = 'data:image/jpeg;base64,AQIDBAUG';
// 第三张不同内容的图：气泡主题一侧就有三个图片字段，两张不够摆
const TINY_GIF = 'data:image/gif;base64,BwgJCgsM';

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

beforeEach(async () => {
    // 清库范围跟着覆盖面走：收了新表这里自动跟上，不用手工维护第二份清单
    for (const s of [...new Set([...OPTIMIZE_TARGET_STORES, 'story_theater_masks', 'blob_assets', 'memory_vectors'])]) {
        await clearStore(s);
    }
    localStorage.clear();
    // 内容记忆是模块级的，不清会让上一条用例存的令牌被这条复用，断言全乱
    clearContentMemo();
});

/** 直接往某张表里塞几行（绕开 DB 的各种便捷写入口，形状随便造）。 */
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

async function blobBytes(token: string): Promise<Uint8Array> {
    const blob = await getBlobForRef(token);
    expect(blob).not.toBeNull();
    return new Uint8Array(await blob!.arrayBuffer());
}

describe('优化资源存储（一次性批量迁移）', () => {
    it('壁纸 assets 行转成令牌，Blob 字节与原图逐一致', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        const r = await optimizeResourceStorage();

        const stored = await DB.getAsset('wallpaper');
        expect(isBlobRef(stored)).toBe(true);
        expect(await blobBytes(stored!)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(1);
        expect(r.failed).toBe(0);
        expect(r.bytesBefore).toBe(TINY_PNG.length);
        expect(r.bytesAfter).toBeGreaterThan(0);
    });

    it('同一张图多处引用：全部换成同一令牌，只建一个 Blob', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        await DB.saveCharacter({
            id: 'c1', name: '测试角色',
            roomConfig: { wallImage: TINY_PNG, floorImage: TINY_JPEG, items: [{ id: 'i1', image: TINY_PNG }] },
        } as any);

        const r = await optimizeResourceStorage();
        expect(r.converted).toBe(4);   // wallpaper + wallImage + item + floorImage
        expect(r.uniqueBlobs).toBe(2); // TINY_PNG 一个、TINY_JPEG 一个

        const wallpaperToken = await DB.getAsset('wallpaper');
        const c = (await DB.getAllCharacters()).find(x => x.id === 'c1') as any;
        expect(c.roomConfig.wallImage).toBe(wallpaperToken);
        expect(c.roomConfig.items[0].image).toBe(wallpaperToken);
        expect(isBlobRef(c.roomConfig.floorImage)).toBe(true);
        expect(c.roomConfig.floorImage).not.toBe(wallpaperToken);
    });

    it('songs 封面与捏人器部件（canonical 链路）都转成可解析令牌', async () => {
        await DB.saveSong({ id: 's1', title: '测试曲', coverImage: TINY_JPEG } as any);
        await DB.saveCustomCreatorPart({ id: 'p1', src: TINY_PNG, shadowSrc: TINY_JPEG } as any);

        await optimizeResourceStorage();

        const song = (await DB.getAllSongs()).find(s => s.id === 's1') as any;
        expect(isBlobRef(song.coverImage)).toBe(true);
        expect(await blobBytes(song.coverImage)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_JPEG).arrayBuffer()));

        const part = (await DB.getCustomCreatorParts()).find(p => p.id === 'p1') as any;
        expect(isBlobRef(part.src)).toBe(true);
        expect(isBlobRef(part.shadowSrc)).toBe(true);
        expect(await blobBytes(part.src)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
    });

    it('外观预设 JSON：壁纸/图标转令牌，其余字段原样、JSON 结构完好', async () => {
        const preset = {
            id: 'ap1', name: '我的预设', createdAt: 1,
            theme: { wallpaper: TINY_PNG, darkMode: true },
            customIcons: { chat: TINY_JPEG },
        };
        await DB.saveAsset('appearance_preset_ap1', JSON.stringify(preset));

        const r = await optimizeResourceStorage();
        expect(r.converted).toBe(2);

        const stored = JSON.parse((await DB.getAsset('appearance_preset_ap1'))!);
        expect(isBlobRef(stored.theme.wallpaper)).toBe(true);
        expect(isBlobRef(stored.customIcons.chat)).toBe(true);
        expect(stored.name).toBe('我的预设');
        expect(stored.theme.darkMode).toBe(true);
    });

    it('卡片消息：content 和 metadata.scoreCard 两份副本一起转（读端优先读后者）', async () => {
        await seedStore('messages', [{
            id: 101, charId: 'c1', role: 'assistant', type: 'score_card', timestamp: 1,
            content: JSON.stringify({ type: 'anniv520_card', charAvatar: TINY_PNG, photoDataUrl: TINY_JPEG, title: '心动瞬间' }),
            metadata: { scoreCard: { type: 'anniv520_card', charAvatar: TINY_PNG, photoDataUrl: TINY_JPEG, title: '心动瞬间' } },
        }]);

        await optimizeResourceStorage();

        const [m]: any = (await DB.getStoreRowsPage('messages', null, 10)).rows;
        const card = JSON.parse(m.content);
        expect(isBlobRef(card.charAvatar)).toBe(true);
        expect(isBlobRef(card.photoDataUrl)).toBe(true);
        expect(isBlobRef(m.metadata.scoreCard.charAvatar)).toBe(true);
        expect(isBlobRef(m.metadata.scoreCard.photoDataUrl)).toBe(true);
        expect(card.title).toBe('心动瞬间');
    });

    it('雷区守卫：卡片 JSON 里的 520 手办图不能被顺手转走', async () => {
        await seedStore('messages', [{
            id: 102, charId: 'c1', role: 'assistant', type: 'score_card', timestamp: 1,
            content: JSON.stringify({ charAvatar: TINY_PNG, charChibi: { dataUrl: TINY_JPEG } }),
            metadata: { scoreCard: { charAvatar: TINY_PNG, charChibi: { dataUrl: TINY_JPEG } } },
        }]);

        await optimizeResourceStorage();

        const [m]: any = (await DB.getStoreRowsPage('messages', null, 10)).rows;
        expect(isBlobRef(JSON.parse(m.content).charAvatar)).toBe(true);
        expect(JSON.parse(m.content).charChibi.dataUrl).toBe(TINY_JPEG);
        expect(m.metadata.scoreCard.charChibi.dataUrl).toBe(TINY_JPEG);
    });

    it('通话结束卡的头像、分享帖快照的作者与评论头像都转，帖子配图不碰', async () => {
        await seedStore('messages', [{
            id: 103, charId: 'c1', role: 'assistant', type: 'text', content: '通话结束', timestamp: 1,
            metadata: {
                characterAvatar: TINY_PNG,
                post: {
                    authorName: '甲', authorAvatar: TINY_JPEG, images: [TINY_PNG],
                    comments: [{ authorName: '乙', authorAvatar: TINY_PNG }],
                },
            },
        }]);

        await optimizeResourceStorage();

        const [m]: any = (await DB.getStoreRowsPage('messages', null, 10)).rows;
        expect(isBlobRef(m.metadata.characterAvatar)).toBe(true);
        expect(isBlobRef(m.metadata.post.authorAvatar)).toBe(true);
        expect(isBlobRef(m.metadata.post.comments[0].authorAvatar)).toBe(true);
        expect(m.metadata.post.images[0]).toBe(TINY_PNG);   // 读端把它当可能是 emoji 的文本渲染
    });

    it('引用快照：图片副本换成占位符，不留令牌（留了会让孤儿清理整轮不敢删）', async () => {
        await seedStore('messages', [
            { id: 104, charId: 'c1', role: 'assistant', type: 'text', content: '好可爱', timestamp: 1,
              replyTo: { name: '小明', content: TINY_PNG } },
            { id: 105, charId: 'c1', role: 'assistant', type: 'text', content: '嗯嗯', timestamp: 2,
              replyTo: { name: '小明', content: '今天去看海啦' } },
        ]);

        await optimizeResourceStorage();

        const rows: any[] = (await DB.getStoreRowsPage('messages', null, 10)).rows;
        const withImage = rows.find(r => r.id === 104);
        const withText = rows.find(r => r.id === 105);
        expect(withImage.replyTo.content).toBe('[图片]');
        expect(withImage.replyTo.content).not.toContain('blobref');
        expect(withText.replyTo.content).toBe('今天去看海啦');   // 普通文字原样
    });

    it('引用快照：图片 / 表情行的引用也要归一化，正文转令牌不能顶掉这一步', async () => {
        // 引用一条图片消息后回了张图或一个表情，这两行的 type 就是 image / emoji。
        // 正文和引用快照是一行里的两处改动，得一起写回去：漏掉引用那处的话，正文下一轮
        // 已经是令牌、不会再被处理，快照里那份几 MB 的 dataURL 就永久留在库里了。
        await seedStore('messages', [
            { id: 201, charId: 'c1', role: 'user', type: 'image', content: TINY_PNG, timestamp: 1,
              replyTo: { name: '小明', content: TINY_JPEG } },
            { id: 202, charId: 'c1', role: 'user', type: 'emoji', content: TINY_GIF, timestamp: 2,
              replyTo: { name: '小明', content: TINY_PNG } },
        ]);

        await optimizeResourceStorage();

        const rows: any[] = (await DB.getStoreRowsPage('messages', null, 10)).rows;
        const image = rows.find(r => r.id === 201);
        const emoji = rows.find(r => r.id === 202);
        expect(image.replyTo.content).toBe('[图片]');
        expect(emoji.replyTo.content).toBe('[图片]');
        // 正文照转，两处改动合成一次整行写回
        expect(isBlobRef(image.content)).toBe(true);
        expect(isBlobRef(emoji.content)).toBe(true);
        expect(JSON.stringify(rows)).not.toContain('data:image');
    });

    it('我方的彼方 Q 版形象也转（角色那侧和我方这侧是两段代码，只改一边会漏）', async () => {
        await seedStore('user_profile', [{ id: 'me', name: '小明', vrState: { chibi: { img: TINY_PNG } } }]);

        await optimizeResourceStorage();

        const [me]: any = (await DB.getStoreRowsPage('user_profile', null, 10)).rows;
        expect(isBlobRef(me.vrState.chibi.img)).toBe(true);
    });

    it('聊天背景与见面背景都转（文件头列了就得真的在代码里）', async () => {
        await DB.saveCharacter({
            id: 'c-bg', name: '背景角色',
            chatBackground: TINY_PNG, dateBackground: TINY_JPEG,
        } as any);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c-bg')!;
        expect(isBlobRef(c.chatBackground)).toBe(true);
        expect(isBlobRef(c.dateBackground)).toBe(true);
    });

    it('见面立绘：角色默认那套和每个换装套装都转，换装那侧不漏', async () => {
        await DB.saveCharacter({
            id: 'c-sprite', name: '立绘角色',
            sprites: { normal: TINY_PNG, happy: TINY_JPEG, chibi: TINY_PNG },
            dateSkinSets: [{ id: 'skin1', name: '泳装', sprites: { normal: TINY_JPEG, shy: TINY_PNG } }],
        } as any);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c-sprite')!;
        for (const key of ['normal', 'happy', 'chibi']) expect(isBlobRef(c.sprites[key])).toBe(true);
        for (const key of ['normal', 'shy']) expect(isBlobRef(c.dateSkinSets[0].sprites[key])).toBe(true);
    });

    it('见面存档：currentSprite 整个删掉，情绪键先反查出来补上', async () => {
        // 这个字段是历史残留（新存档只记 currentSpriteKey），存的是整张立绘的 base64 副本。
        // 反查必须发生在立绘转令牌之前，否则值就对不上了。
        await DB.saveCharacter({
            id: 'c-saved', name: '有存档的角色',
            sprites: { normal: TINY_PNG, happy: TINY_JPEG },
            savedDateState: { currentSprite: TINY_JPEG, timestamp: 1 },
        } as any);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c-saved')!;
        expect(c.savedDateState.currentSprite).toBeUndefined();   // 空间归零
        expect(c.savedDateState.currentSpriteKey).toBe('happy');  // 表情没丢
        expect(isBlobRef(c.sprites.happy)).toBe(true);
    });

    it('见面存档：已经记了情绪键的存档，不覆盖它', async () => {
        await DB.saveCharacter({
            id: 'c-saved2', name: '新存档',
            sprites: { normal: TINY_PNG, happy: TINY_JPEG },
            savedDateState: { currentSprite: TINY_JPEG, currentSpriteKey: 'normal', timestamp: 1 },
        } as any);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c-saved2')!;
        expect(c.savedDateState.currentSpriteKey).toBe('normal');
        expect(c.savedDateState.currentSprite).toBeUndefined();
    });

    it('彼方 Q 版形象、查手机通讯录头像、活动卡片头像都转', async () => {
        await DB.saveCharacter({
            id: 'c-misc', name: '杂项角色',
            vrState: { chibi: { img: TINY_PNG } },
            phoneState: { contacts: [{ id: 'ct1', name: '甲', avatar: TINY_JPEG }, { id: 'ct2', name: '乙', avatar: TINY_PNG }] },
            specialMomentRecords: { qixi_2026_x: { customData: { chatCard: { charAvatar: TINY_JPEG } } } },
        } as any);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c-misc')!;
        expect(isBlobRef(c.vrState.chibi.img)).toBe(true);
        expect(isBlobRef(c.phoneState.contacts[0].avatar)).toBe(true);
        expect(isBlobRef(c.phoneState.contacts[1].avatar)).toBe(true);
        expect(isBlobRef(c.specialMomentRecords.qixi_2026_x.customData.chatCard.charAvatar)).toBe(true);
    });

    it('活动留存的大图也转（白色情人节明信片 / 520 定妆照）', async () => {
        await DB.saveCharacter({
            id: 'c-moment', name: '活动角色',
            specialMomentRecords: {
                whiteday_2026: { image: TINY_PNG, timestamp: 1 },
                like520_2026: { image: TINY_JPEG, timestamp: 2 },
            },
        } as any);

        await optimizeResourceStorage();

        const m: any = ((await DB.getAllCharacters()).find(x => x.id === 'c-moment') as any).specialMomentRecords;
        expect(isBlobRef(m.whiteday_2026.image)).toBe(true);
        expect(isBlobRef(m.like520_2026.image)).toBe(true);
    });

    it('雷区守卫：活动记录里的 520 手办图刻意保持 dataURL，绝不能被顺手转走', async () => {
        // 520 活动那边全是裸 <img> + canvas 合成，令牌过不去。谁要是把
        // specialMomentRecords 改成整体深度遍历，这条会挂。
        await DB.saveCharacter({
            id: 'c-520', name: '520 角色',
            specialMomentRecords: {
                like520_2026: {
                    customData: {
                        chatCard: { charAvatar: TINY_PNG },
                        charChibi: { dataUrl: TINY_JPEG },
                        userChibi: { dataUrl: TINY_JPEG },
                    },
                },
            },
        } as any);

        await optimizeResourceStorage();

        const cd: any = ((await DB.getAllCharacters()).find(x => x.id === 'c-520') as any).specialMomentRecords.like520_2026.customData;
        expect(isBlobRef(cd.chatCard.charAvatar)).toBe(true);     // 这个该转
        expect(cd.charChibi.dataUrl).toBe(TINY_JPEG);             // 这两个一个字节都不许动
        expect(cd.userChibi.dataUrl).toBe(TINY_JPEG);
    });

    it('社交帖子：作者头像与评论头像都转，帖子自己的配图不碰', async () => {
        await DB.putStoreRows('social_posts', [{
            id: 'p1', authorName: '小明', authorAvatar: TINY_PNG,
            title: 't', content: 'c', images: [TINY_JPEG],
            comments: [{ id: 'cm1', authorName: '乙', authorAvatar: TINY_JPEG, content: 'hi' }],
            likes: 0, timestamp: 1, tags: [], isCollected: false, isLiked: false,
        }]);

        await optimizeResourceStorage();

        const [post]: any = (await DB.getStoreRowsPage('social_posts', null, 100)).rows;
        expect(isBlobRef(post.authorAvatar)).toBe(true);
        expect(isBlobRef(post.comments[0].authorAvatar)).toBe(true);
        expect(post.images[0]).toBe(TINY_JPEG);   // 读端还没改造，不在收录范围
    });

    it('群头像转令牌，但代码现画的 SVG 占位符跳过（换一条 Blob 行不值几百字节）', async () => {
        const SVG = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><circle r="9"/></svg>';
        await DB.putStoreRows('groups', [
            { id: 'g1', name: '真头像群', avatar: TINY_PNG },
            { id: 'g2', name: '默认头像群', avatar: SVG },
        ]);

        await optimizeResourceStorage();

        const rows: any[] = (await DB.getStoreRowsPage('groups', null, 100)).rows;
        expect(isBlobRef(rows.find(g => g.id === 'g1').avatar)).toBe(true);
        expect(rows.find(g => g.id === 'g2').avatar).toBe(SVG);
    });

    it('雷区守卫：生活模拟只转角色头像副本，剧情插图不碰', async () => {
        // attachments[].imageUrl 是裸 <img> 渲染的（apps/lifesim/StoryAttachments.tsx）。
        // 谁把 life_sim 改成整行深度遍历，这条会挂。
        await DB.putStoreRows('life_sim', [{
            id: 'sim1',
            actionLog: [{
                turnNumber: 1, actor: '甲', actorAvatar: TINY_PNG,
                attachments: [{ id: 'a1', imageUrl: TINY_JPEG }],
            }],
        }]);

        await optimizeResourceStorage();

        const [sim]: any = (await DB.getStoreRowsPage('life_sim', null, 100)).rows;
        expect(isBlobRef(sim.actionLog[0].actorAvatar)).toBe(true);
        expect(sim.actionLog[0].attachments[0].imageUrl).toBe(TINY_JPEG);
    });

    it('社交主页：背景图（裸字符串）和资料 JSON 里的头像都转', async () => {
        await DB.saveAsset('spark_user_bg', TINY_PNG);
        await DB.saveAsset('spark_social_profile', JSON.stringify({ name: '小明', avatar: TINY_JPEG, bio: '你好' }));

        const r = await optimizeResourceStorage();
        expect(r.converted).toBe(2);

        expect(isBlobRef((await DB.getAsset('spark_user_bg'))!)).toBe(true);
        const profile = JSON.parse((await DB.getAsset('spark_social_profile'))!);
        expect(isBlobRef(profile.avatar)).toBe(true);
        expect(profile.name).toBe('小明');   // 非图片字段原样
        expect(profile.bio).toBe('你好');
    });

    it('桌面小组件图：assets 里的 widget_* 行和预设里内嵌的那份都转', async () => {
        await DB.saveAsset('widget_dsq', TINY_PNG);
        await DB.saveAsset('appearance_preset_ap4', JSON.stringify({
            id: 'ap4', name: '带小组件的预设', createdAt: 1,
            theme: {
                wallpaper: 'linear-gradient(#fff,#000)',
                // polaroid_* 是老美化包留下的历史槽位，桌面只认 tl/tr/wide/dsq，
                // 但它一样占着预设 JSON 的体积，一起转
                launcherWidgets: { dsq: TINY_JPEG, wide: TINY_PNG, polaroid_tl: TINY_JPEG },
            },
        }));

        await optimizeResourceStorage();

        expect(isBlobRef((await DB.getAsset('widget_dsq'))!)).toBe(true);
        const stored = JSON.parse((await DB.getAsset('appearance_preset_ap4'))!);
        for (const slot of ['dsq', 'wide', 'polaroid_tl']) {
            expect(isBlobRef(stored.theme.launcherWidgets[slot])).toBe(true);
        }
    });

    it('外观预设内嵌的气泡主题：user / ai 两侧六张图都转，一侧都不漏', async () => {
        // 存预设时 chatThemes 是从 themes 表原样抄过来的。themes 表转了、预设里这份没转，
        // 下次应用预设就把 base64 又灌回 themes 表——两边必须一起转。
        const preset = {
            id: 'ap2', name: '带气泡的预设', createdAt: 1,
            theme: { wallpaper: TINY_PNG },
            chatThemes: [{
                id: 'ct1', name: '主题一', type: 'custom',
                user: { backgroundImage: TINY_PNG, decoration: TINY_JPEG, avatarDecoration: TINY_PNG },
                ai: { backgroundImage: TINY_JPEG, decoration: TINY_PNG, avatarDecoration: TINY_JPEG },
            }],
        };
        await DB.saveAsset('appearance_preset_ap2', JSON.stringify(preset));

        await optimizeResourceStorage();

        const stored = JSON.parse((await DB.getAsset('appearance_preset_ap2'))!);
        for (const side of ['user', 'ai']) {
            for (const key of ['backgroundImage', 'decoration', 'avatarDecoration']) {
                expect(isBlobRef(stored.chatThemes[0][side][key])).toBe(true);
            }
        }
        expect(stored.chatThemes[0].name).toBe('主题一');   // 非图片字段原样
    });

    it('外观预设里的 launcherWidgetImage 直接扔掉，不占位也不转成令牌', async () => {
        // 这个字段 types.ts 标了 DEPRECATED、加载时必被剥离、永远不渲染。
        // 老美化包的预设里压着几百 KB 的 base64，转成令牌只是把死重量换个地方存。
        const preset = {
            id: 'ap3', name: '老美化包', createdAt: 1,
            theme: { wallpaper: 'linear-gradient(#fff,#000)', launcherWidgetImage: TINY_PNG },
        };
        await DB.saveAsset('appearance_preset_ap3', JSON.stringify(preset));

        const r = await optimizeResourceStorage();

        const stored = JSON.parse((await DB.getAsset('appearance_preset_ap3'))!);
        expect(stored.theme.launcherWidgetImage).toBeUndefined();
        expect(stored.theme.wallpaper).toBe('linear-gradient(#fff,#000)');   // 渐变不动
        expect(r.converted).toBe(0);   // 扔掉不算「转换」，不该虚报收益
    });

    it('相册 gallery 行转成令牌，Blob 字节与原图逐字节一致', async () => {
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });

        const r = await optimizeResourceStorage();

        const stored = (await DB.getGalleryImages()).find(g => g.id === 'g1')!;
        expect(isBlobRef(stored.url)).toBe(true);
        expect(await blobBytes(stored.url)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(1);
        expect(r.failed).toBe(0);
    });

    it('相册图和别处引用同一张图：收敛到同一个令牌，只建一个 Blob', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });

        const r = await optimizeResourceStorage();

        const stored = (await DB.getGalleryImages()).find(g => g.id === 'g1')!;
        expect(isBlobRef(stored.url)).toBe(true);
        expect(stored.url).toBe(await DB.getAsset('wallpaper'));
        expect(r.converted).toBe(2);
        expect(r.uniqueBlobs).toBe(1);
    });

    it('相册幂等：第一遍转完，第二遍零转换', async () => {
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });

        const first = await optimizeResourceStorage();
        expect(first.converted).toBe(1);

        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('相册独占引用的图不会被孤儿 GC 删掉（gallery 必须在 GC 的引用面清单里）', async () => {
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });
        await optimizeResourceStorage();
        const token = (await DB.getGalleryImages()).find(g => g.id === 'g1')!.url;
        expect(isBlobRef(token)).toBe(true);

        // 转出来的 Blob 只有相册这一面引用着：GC 看不见这个面就会把它当孤儿删掉，相册全没
        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        expect(await getBlobForRef(token)).not.toBeNull();
    });

    /** 一套气泡主题：两侧各带底纹 / 贴纸 / 头像挂件三张图，外加几个不该被碰的数值字段。 */
    function makeTheme(): any {
        return {
            id: 't1', name: '我的气泡', type: 'custom',
            user: {
                textColor: '#ffffff', backgroundColor: '#6366f1', borderRadius: 20, opacity: 1,
                backgroundImage: TINY_PNG, decoration: TINY_JPEG, avatarDecoration: TINY_GIF,
                decorationX: 88, decorationY: -12, avatarDecorationScale: 1.5,
            },
            ai: {
                textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 16, opacity: 0.9,
                backgroundImage: TINY_GIF, decoration: TINY_PNG, avatarDecoration: TINY_JPEG,
                decorationX: 10, backgroundImageOpacity: 0.35,
            },
        };
    }

    it('气泡主题：两侧六个图片字段都转成令牌，Blob 字节与原图逐字节一致', async () => {
        await DB.saveTheme(makeTheme());

        const r = await optimizeResourceStorage();

        const t = (await DB.getThemes()).find(x => x.id === 't1') as any;
        // 只处理 user 一侧是这一面最容易犯的错，所以两侧逐个字段都要断言
        for (const side of ['user', 'ai']) {
            for (const key of ['backgroundImage', 'decoration', 'avatarDecoration']) {
                expect(isBlobRef(t[side][key])).toBe(true);
            }
        }
        expect(await blobBytes(t.user.backgroundImage)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(await blobBytes(t.user.decoration)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_JPEG).arrayBuffer()));
        expect(await blobBytes(t.user.avatarDecoration)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_GIF).arrayBuffer()));
        expect(await blobBytes(t.ai.backgroundImage)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_GIF).arrayBuffer()));
        expect(r.converted).toBe(6);
        expect(r.uniqueBlobs).toBe(3);   // 三张不同的图，两侧交叉引用只建三份 Blob
        expect(r.failed).toBe(0);
    });

    it('气泡主题的非图片字段一字不动：颜色、圆角、透明度、贴纸坐标全保持原值', async () => {
        const before = makeTheme();
        await DB.saveTheme(before);

        await optimizeResourceStorage();

        const t = (await DB.getThemes()).find(x => x.id === 't1') as any;
        expect(t.name).toBe('我的气泡');
        expect(t.user.textColor).toBe('#ffffff');
        expect(t.user.backgroundColor).toBe('#6366f1');
        expect(t.user.borderRadius).toBe(20);
        expect(t.user.opacity).toBe(1);
        expect(t.user.decorationX).toBe(88);
        expect(t.user.decorationY).toBe(-12);
        expect(t.user.avatarDecorationScale).toBe(1.5);
        expect(t.ai.borderRadius).toBe(16);
        expect(t.ai.opacity).toBe(0.9);
        expect(t.ai.backgroundImageOpacity).toBe(0.35);
    });

    it('气泡主题幂等：第一遍转完，第二遍零转换', async () => {
        await DB.saveTheme(makeTheme());

        const first = await optimizeResourceStorage();
        expect(first.converted).toBe(6);

        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('气泡主题独占引用的图不会被孤儿 GC 删掉（themes 必须在 GC 的引用面清单里）', async () => {
        await DB.saveTheme(makeTheme());
        await optimizeResourceStorage();
        const t = (await DB.getThemes()).find(x => x.id === 't1') as any;
        const tokens = [t.user.backgroundImage, t.user.decoration, t.user.avatarDecoration];
        for (const token of tokens) expect(isBlobRef(token)).toBe(true);

        // 转出来的 Blob 只有主题这一面引用着：GC 看不见这个面就会把它们全当孤儿删掉
        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        for (const token of tokens) expect(await getBlobForRef(token)).not.toBeNull();
    });

    /** 往 messages 表塞一条消息，返回它的自增 id。 */
    async function seedMessage(type: string, content: string, charId = 'c1'): Promise<number> {
        return DB.saveMessage({ charId, role: 'user', type, content } as any);
    }

    async function readMessage(id: number, charId = 'c1'): Promise<any> {
        return (await DB.getMessagesByCharId(charId)).find(m => m.id === id);
    }

    it('聊天图片消息：content 转成令牌，Blob 字节与原图逐字节一致', async () => {
        const id = await seedMessage('image', TINY_PNG);

        const r = await optimizeResourceStorage();

        const msg = await readMessage(id);
        expect(isBlobRef(msg.content)).toBe(true);
        expect(await blobBytes(msg.content)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(1);
        expect(r.failed).toBe(0);
    });

    it('表情消息（type=emoji）也转成令牌', async () => {
        const id = await seedMessage('emoji', TINY_JPEG);

        await optimizeResourceStorage();

        const msg = await readMessage(id);
        expect(isBlobRef(msg.content)).toBe(true);
        expect(await blobBytes(msg.content)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_JPEG).arrayBuffer()));
    });

    it('文本消息一字不动：正文恰好长得像 data URL 也不碰', async () => {
        // messages 表里绝大多数行跟图片无关。少了 type 那道闸，一条正文里粘了 base64 的
        // 文本消息就会被当图片转掉，用户看到的是自己发过的一段话变成了一串令牌。
        const id = await seedMessage('text', TINY_PNG);

        const r = await optimizeResourceStorage();

        const msg = await readMessage(id);
        expect(msg.content).toBe(TINY_PNG);
        expect(r.converted).toBe(0);
        expect(r.uniqueBlobs).toBe(0);
    });

    it('表情库：本地图转成令牌，http 外链原样保留、分类不丢', async () => {
        await DB.saveEmoji('本地表情', TINY_PNG, 'cat-1');
        await DB.saveEmoji('网络表情', 'https://img.host/sticker.png', 'cat-1');

        const r = await optimizeResourceStorage();

        const list = await DB.getEmojis();
        const local = list.find(e => e.name === '本地表情')!;
        const remote = list.find(e => e.name === '网络表情')!;
        expect(isBlobRef(local.url)).toBe(true);
        expect(await blobBytes(local.url)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        // 外链是别人服务器上的地址，本机没有它的二进制，转不了也不该动
        expect(remote.url).toBe('https://img.host/sticker.png');
        // 表情的主键是 name，回写时把分类带丢了的话，这个表情会掉出它原来的分组
        expect(local.categoryId).toBe('cat-1');
        expect(r.converted).toBe(1);
    });

    it('聊天图与表情库独占引用的 Blob 不会被孤儿 GC 删掉（两面都必须在 GC 引用面清单里）', async () => {
        const msgId = await seedMessage('image', TINY_PNG);
        await DB.saveEmoji('本地表情', TINY_JPEG, undefined);
        await optimizeResourceStorage();

        const msgToken = (await readMessage(msgId)).content;
        const emojiToken = (await DB.getEmojis()).find(e => e.name === '本地表情')!.url;
        expect(isBlobRef(msgToken)).toBe(true);
        expect(isBlobRef(emojiToken)).toBe(true);

        // 这两份 Blob 各自只有一处引用：GC 看不见那个面就会把它当孤儿删掉，用户的聊天图 / 表情全没
        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        expect(await getBlobForRef(msgToken)).not.toBeNull();
        expect(await getBlobForRef(emojiToken)).not.toBeNull();
    });

    it('聊天图与表情库幂等：第一遍转完，第二遍零转换', async () => {
        await seedMessage('image', TINY_PNG);
        await seedMessage('emoji', TINY_JPEG);
        await DB.saveEmoji('本地表情', TINY_GIF, undefined);

        const first = await optimizeResourceStorage();
        expect(first.converted).toBe(3);

        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('角色头像：base64 转成令牌，Blob 字节与原图逐字节一致', async () => {
        await DB.saveCharacter({ id: 'c1', name: '角色', avatar: TINY_PNG } as any);

        const r = await optimizeResourceStorage();

        const c = (await DB.getAllCharacters()).find(x => x.id === 'c1')!;
        expect(isBlobRef(c.avatar)).toBe(true);
        expect(await blobBytes(c.avatar)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(1);
        expect(r.failed).toBe(0);
    });

    it('角色头像与小屋图一趟遍历里一起转，互不影响', async () => {
        await DB.saveCharacter({
            id: 'c1', name: '角色', avatar: TINY_PNG,
            roomConfig: { wallImage: TINY_JPEG, items: [] },
        } as any);

        const r = await optimizeResourceStorage();

        const c = (await DB.getAllCharacters()).find(x => x.id === 'c1') as any;
        expect(isBlobRef(c.avatar)).toBe(true);
        expect(isBlobRef(c.roomConfig.wallImage)).toBe(true);
        expect(r.converted).toBe(2);
    });

    it('角色头像：emoji 与 http 外链原样保留，只有 data: 才转', async () => {
        // 头像是两用字段，用户可以只填一个 emoji；外链是别人服务器上的地址，本机没有二进制
        await DB.saveCharacter({ id: 'c1', name: '表情头像', avatar: '🐱' } as any);
        await DB.saveCharacter({ id: 'c2', name: '外链头像', avatar: 'https://img.host/a.png' } as any);

        const r = await optimizeResourceStorage();

        const chars = await DB.getAllCharacters();
        expect(chars.find(c => c.id === 'c1')!.avatar).toBe('🐱');
        expect(chars.find(c => c.id === 'c2')!.avatar).toBe('https://img.host/a.png');
        expect(r.converted).toBe(0);
    });

    it('角色的非头像字段一字不动：刻意留 dataURL 的手办图和文本字段都不碰', async () => {
        await DB.saveCharacter({
            id: 'c1', name: '角色', avatar: TINY_PNG, personality: '话很少',
            chibiStudio: { like520: { img: TINY_JPEG } },
        } as any);

        const r = await optimizeResourceStorage();

        const c = (await DB.getAllCharacters()).find(x => x.id === 'c1') as any;
        expect(isBlobRef(c.avatar)).toBe(true);             // 头像照转
        expect(c.chibiStudio.like520.img).toBe(TINY_JPEG);  // 刻意保持 dataURL，见 docs/chibi-studio.md
        expect(c.personality).toBe('话很少');
        expect(r.converted).toBe(1);
    });

    it('我方头像：整体头像与分角色头像两处都转，外链与文本字段不动', async () => {
        // 只转 avatar、忘了 perCharAvatars 是这一面最容易犯的错——分角色那几张会静默留在 base64
        await DB.saveUserProfile({
            name: '小明', bio: '爱吃辣', avatar: TINY_PNG,
            perCharAvatars: { c1: TINY_JPEG, c2: TINY_GIF, c3: 'https://img.host/me.png' },
        } as any);

        const r = await optimizeResourceStorage();

        const p = (await DB.getUserProfile())!;
        expect(isBlobRef(p.avatar)).toBe(true);
        expect(await blobBytes(p.avatar)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        const per = p.perCharAvatars!;
        expect(isBlobRef(per.c1)).toBe(true);
        expect(isBlobRef(per.c2)).toBe(true);
        expect(await blobBytes(per.c1)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_JPEG).arrayBuffer()));
        expect(await blobBytes(per.c2)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_GIF).arrayBuffer()));
        expect(per.c3).toBe('https://img.host/me.png');
        expect(p.name).toBe('小明');
        expect(p.bio).toBe('爱吃辣');
        expect(r.converted).toBe(3);
        expect(r.uniqueBlobs).toBe(3);
        expect(r.failed).toBe(0);
    });

    it('我方头像独占引用的 Blob 不会被孤儿 GC 删掉（user_profile 必须在 GC 引用面清单里）', async () => {
        await DB.saveUserProfile({ name: '小明', avatar: TINY_PNG, perCharAvatars: { c1: TINY_JPEG } } as any);
        await optimizeResourceStorage();
        const p = (await DB.getUserProfile())!;
        const tokens = [p.avatar, p.perCharAvatars!.c1];
        for (const t of tokens) expect(isBlobRef(t)).toBe(true);

        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        for (const t of tokens) expect(await getBlobForRef(t)).not.toBeNull();
    });

    it('头像被抄进帖子 / 群资料 / 剧场面具后，孤儿清理不会把图删掉', async () => {
        // 头像会被抄进这些面长期留着。用户之后换了头像，characters 那边就不再指着原图，
        // 只剩这些副本还引用它——GC 看不见哪一面，那一面上的头像就会碎成空白，且不可逆。
        await DB.saveCharacter({ id: 'c1', name: '甲', avatar: TINY_PNG } as any);
        await DB.saveCharacter({ id: 'c2', name: '乙', avatar: TINY_JPEG } as any);
        await DB.saveCharacter({ id: 'c3', name: '丙', avatar: TINY_GIF } as any);
        await optimizeResourceStorage();

        const chars = await DB.getAllCharacters();
        const tokenOf = (id: string) => chars.find(c => c.id === id)!.avatar;
        const postToken = tokenOf('c1');
        const groupToken = tokenOf('c2');
        const maskToken = tokenOf('c3');
        for (const t of [postToken, groupToken, maskToken]) expect(isBlobRef(t)).toBe(true);

        await seedStore('social_posts', [{ id: 'p1', charId: 'c1', authorAvatar: postToken, content: '今天天气不错', timestamp: 1 }]);
        await seedStore('groups', [{ id: 'g1', name: '小群', members: ['c1'], avatar: groupToken }]);
        await seedStore('story_theater_masks', [{ id: 'm1', name: '路人甲', avatar: maskToken }]);
        // 三个角色随后都换成了 emoji 头像：这三份 Blob 只剩上面那三处副本引用着
        for (const c of chars) await DB.saveCharacter({ ...c, avatar: '🐱' });

        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        expect(await getBlobForRef(postToken)).not.toBeNull();   // 帖子里的作者头像
        expect(await getBlobForRef(groupToken)).not.toBeNull();  // 群资料里的群头像
        expect(await getBlobForRef(maskToken)).not.toBeNull();   // 剧场面具上的头像
    });

    it('头像幂等：第一遍转完，第二遍零转换', async () => {
        await DB.saveCharacter({ id: 'c1', name: '角色', avatar: TINY_PNG } as any);
        await DB.saveUserProfile({ name: '小明', avatar: TINY_JPEG, perCharAvatars: { c1: TINY_GIF } } as any);

        const first = await optimizeResourceStorage();
        expect(first.converted).toBe(3);

        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('幂等：第二次运行零转换零新建', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        await optimizeResourceStorage();
        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('坏 data:image 转不动：原值保留、计入 failed，不中断其他面', async () => {
        await DB.saveAsset('wallpaper', 'data:image/png;base64,@@@@');
        await DB.saveAsset('lock_wallpaper', TINY_PNG);

        const r = await optimizeResourceStorage();
        expect(r.failed).toBe(1);
        expect(r.converted).toBe(1);
        expect(await DB.getAsset('wallpaper')).toBe('data:image/png;base64,@@@@');
        expect(isBlobRef(await DB.getAsset('lock_wallpaper'))).toBe(true);

        // 失败原因得留下来：只报一个 failed 数字的话，用户那边转不动时无从查起。
        // 键上带着面名（这里是「系统外观」），才知道是哪张表出的事。
        const reasons = Object.keys(r.failureReasons);
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain('系统外观');
        expect(r.failureReasons[reasons[0]]).toBe(1);
    });

    it('行写回失败（配额满）：只丢这一行，整轮跑完不中断，也不虚报省下的量', async () => {
        // 各表的写入口会等事务真的提交完才 resolve，配额满 / 事务 abort 都从那儿抛上来。
        // 整个优化只有 finally 没有 catch，不在行级接住的话，一行写不进去就把后面的面
        // 全掐了——连回收最省的那步「合并重复图片」都轮不到。而存储快满恰恰正是有人来点
        // 这个按钮的时候。
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });
        await DB.saveGalleryImage({ id: 'g2', charId: 'c1', url: TINY_JPEG, timestamp: 2 });
        // 表情包在相册后面，用它看整轮到底有没有跑到头
        await DB.saveEmoji('本地表情', TINY_GIF, undefined);

        const quota = new Error('存储空间不足');
        quota.name = 'QuotaExceededError';
        const spy = vi.spyOn(DB, 'saveGalleryImage').mockRejectedValueOnce(quota);
        let r: Awaited<ReturnType<typeof optimizeResourceStorage>>;
        try {
            r = await optimizeResourceStorage();   // 不许抛
        } finally {
            spy.mockRestore();
        }

        // 挂掉的那一行原值还在（图不丢），后面的行和后面的面照常处理
        const gallery = await DB.getGalleryImages();
        expect(gallery.find(g => g.id === 'g1')!.url).toBe(TINY_PNG);
        expect(isBlobRef(gallery.find(g => g.id === 'g2')!.url)).toBe(true);
        expect(isBlobRef((await DB.getEmojis()).find(e => e.name === '本地表情')!.url)).toBe(true);

        // 口径不许撒谎：没落库的那张算「没省下来」，不算转换、也不算新建的 Blob
        expect(r!.failed).toBe(1);
        expect(r!.converted).toBe(2);     // g2 + 表情
        expect(r!.uniqueBlobs).toBe(2);
        const reasons = Object.keys(r!.failureReasons);
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain('相册');
        expect(reasons[0]).toContain('QuotaExceededError');
        expect(r!.failureReasons[reasons[0]]).toBe(1);
    });

    it('没有失败时 failureReasons 是空的（别拿噪音喂给反馈报告）', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        const r = await optimizeResourceStorage();
        expect(r.failed).toBe(0);
        expect(r.failureReasons).toEqual({});
    });

    it('清单守卫：优化写入的每张表都在 GC 引用面清单里（否则转出的 Blob 会被当孤儿删）', () => {
        for (const store of OPTIMIZE_TARGET_STORES) {
            expect(REF_SOURCE_STORES).toContain(store);
        }
    });

    it('维护互斥：锁被占时优化与孤儿 GC 都干净拒绝', async () => {
        expect(tryAcquireMaintenanceLock('测试占用')).toBe(true);
        try {
            await expect(optimizeResourceStorage()).rejects.toThrow(/正在进行/);
            await expect(runBlobGc()).rejects.toThrow(/正在进行/);
        } finally {
            releaseMaintenanceLock();
        }
        // 释放后可正常运行（锁没被拒绝路径污染）
        const r = await optimizeResourceStorage();
        expect(r.converted).toBe(0);
    });
});

// 「换图即删」字段（清单见 utils/blobDedupe.ts）：换图 / 移除时直接 deleteBlobRef 掉旧
// Blob，前提是那份令牌只归自己。这组用例钉住迁移过来的令牌确实独占，以及衣柜不会裂。
describe('换图即删的字段：令牌独占，衣柜不裂', () => {
    it('桌面静态形象转成令牌，衣柜里那条跟顶层指向同一个', async () => {
        await seedStore('characters', [{
            id: 'c1', name: '小明',
            companionAvatar: {
                version: 1, source: 'upload', imageRef: TINY_PNG,
                imageWardrobe: [
                    { id: TINY_PNG, imageRef: TINY_PNG },
                    { id: TINY_JPEG, imageRef: TINY_JPEG },
                ],
            },
        }]);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c1');
        expect(isBlobRef(c.companionAvatar.imageRef)).toBe(true);
        // 衣柜按 imageRef 认亲。当前穿着这套在衣柜里得还是同一条，两边令牌不一致就会裂成两条
        expect(c.companionAvatar.imageWardrobe[0].imageRef).toBe(c.companionAvatar.imageRef);
        // 另一套是另一张图，令牌自然是另一个
        expect(isBlobRef(c.companionAvatar.imageWardrobe[1].imageRef)).toBe(true);
        expect(c.companionAvatar.imageWardrobe[1].imageRef).not.toBe(c.companionAvatar.imageRef);
        expect(await blobBytes(c.companionAvatar.imageRef))
            .toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
    });

    it('同一张图别处也有时，这个字段拿到的是自己那份令牌', async () => {
        await seedStore('characters', [{
            id: 'c1', name: '小明',
            avatar: TINY_PNG,                                                      // 走去重那条
            companionAvatar: { version: 1, source: 'upload', imageRef: TINY_PNG },  // 走独占那条
        }]);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c1');
        expect(isBlobRef(c.avatar)).toBe(true);
        expect(isBlobRef(c.companionAvatar.imageRef)).toBe(true);
        // 内容一样，令牌必须是两个：换掉桌面形象时它会把自己那份 Blob 直接删掉
        expect(c.companionAvatar.imageRef).not.toBe(c.avatar);
    });

    it('两个背景字段放同一张图，也各拿各的令牌', async () => {
        await seedStore('characters', [{
            id: 'c1', name: '小明',
            videoCallBackground: TINY_JPEG,
            companionBackground: TINY_JPEG,
        }]);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c1');
        expect(isBlobRef(c.videoCallBackground)).toBe(true);
        expect(isBlobRef(c.companionBackground)).toBe(true);
        expect(c.videoCallBackground).not.toBe(c.companionBackground);
    });

    it('再跑一遍，去重阶段也不会把这两份一样的 Blob 并到一起', async () => {
        await seedStore('characters', [{
            id: 'c1', name: '小明',
            avatar: TINY_PNG,
            companionAvatar: { version: 1, source: 'upload', imageRef: TINY_PNG },
        }]);

        await optimizeResourceStorage();
        const first: any = (await DB.getAllCharacters()).find(x => x.id === 'c1');

        // 第二遍的去重阶段这才看得见上一遍转出来的两份同内容 Blob。
        // collectUnmergeableRefs 把裸删字段挡在合并之外，挡漏了这里就会并成一个。
        await optimizeResourceStorage();
        const second: any = (await DB.getAllCharacters()).find(x => x.id === 'c1');

        expect(second.companionAvatar.imageRef).toBe(first.companionAvatar.imageRef);
        expect(second.companionAvatar.imageRef).not.toBe(second.avatar);
    });

    it('源码守卫：这几个字段不许走去重那条 put', () => {
        const src = readFileSync(new URL('./storageOptimize.ts', import.meta.url), 'utf8');
        const start = src.indexOf('const companion = (c as any).companionAvatar;');
        expect(start).toBeGreaterThan(-1);
        const end = src.indexOf('const rc = (c as any).roomConfig;', start);
        expect(end).toBeGreaterThan(start);
        const block = src.slice(start, end);

        expect(block).toContain('convertExclusive');
        // 换成 convert( 就是把令牌交给内容去重，别处一裸删这边的图跟着没
        expect(block).not.toMatch(/\bconvert\(/);
    });
});

describe('去重：同一张图只留一份 Blob', () => {
    it('存量重复：两份一样的 Blob，优化后引用收敛到最老的那个', async () => {
        // 造出历史上两条迁移路径各存各的局面（putImageBlob 本身不去重）
        const older = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const newer = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', older);
        await DB.saveAsset('appearance_preset_1', JSON.stringify({ theme: { wallpaper: newer } }));

        const r = await optimizeResourceStorage();

        expect(await DB.getAsset('wallpaper')).toBe(older);
        expect(JSON.parse((await DB.getAsset('appearance_preset_1'))!).theme.wallpaper).toBe(older);
        expect(r.mergedDuplicates).toBe(1);
        expect(r.reclaimableBytes).toBeGreaterThan(0);
        expect(r.scanUnavailable).toBe(false);
    });

    it('合并只改引用，不删 Blob——多出来那份留给孤儿清理', async () => {
        const older = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const newer = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', older);
        await DB.saveAsset('lock_wallpaper', newer);

        await optimizeResourceStorage();
        expect(await getBlobForRef(newer)).not.toBeNull();

        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.deleted).toBe(1);
        expect(await getBlobForRef(newer)).toBeNull();
        expect(await getBlobForRef(older)).not.toBeNull();
    });

    it('转换时复用库里已有的同内容 Blob，不再存出新的一份', async () => {
        const existing = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('lock_wallpaper', existing);   // 先让它有引用，不是孤儿
        await DB.saveAsset('wallpaper', TINY_PNG);        // 这行还是 base64，等着被转

        const r = await optimizeResourceStorage();

        expect(await DB.getAsset('wallpaper')).toBe(existing);
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(0);   // 一个新 Blob 都没建
        expect(r.bytesAfter).toBe(0);
    });

    it('被「换图即删」字段引用的令牌整组跳过合并（否则对方一删这边就破图）', async () => {
        const wallpaperRef = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const stageRef = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', wallpaperRef);
        // videoCallBackground 换图时是裸删旧 Blob 的
        await DB.saveCharacter({ id: 'c1', name: '测试角色', videoCallBackground: stageRef } as any);

        const r = await optimizeResourceStorage();

        expect(await DB.getAsset('wallpaper')).toBe(wallpaperRef);
        expect(((await DB.getAllCharacters())[0] as any).videoCallBackground).toBe(stageRef);
        expect(r.mergedDuplicates).toBe(0);
        expect(r.skippedGroups).toBe(1);
    });

    /** 造一份扫库结果：scanned 与 skipped 在 SDK 里互斥（算出哈希才 scanned++，
     *  读不出 / 算不动一律 skipped++），所以两个数字分别摆就够描述各种局面。 */
    function stubScan(scanned: number, skipped: number) {
        return vi.spyOn(blobStore, 'scanContent').mockResolvedValue({
            byHash: new Map<string, string[]>(), duplicateGroups: [],
            scanned, skipped, wastedBytes: 0, aborted: false,
        });
    }

    it('一条都没算出哈希（非安全上下文没有 crypto.subtle）：报「这轮没做成去重」', async () => {
        // scanUnavailable 要抓的就是这个场景。判反了的话面板会说「已是最省形态」，
        // 用户完全不知道换个环境还能再省一截。
        await DB.saveAsset('wallpaper', TINY_PNG);
        const spy = stubScan(0, 3);
        try {
            const r = await optimizeResourceStorage();
            expect(r.scanUnavailable).toBe(true);
            expect(r.converted).toBe(1);   // 去重停摆，转换照跑
        } finally {
            spy.mockRestore();
        }
    });

    it('只有几条读坏：去重照跑，不许误报成没做成', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        const spy = stubScan(3, 3);
        try {
            const r = await optimizeResourceStorage();
            expect(r.scanUnavailable).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });

    it('空库：一条都没有也不算「没做成」', async () => {
        const spy = stubScan(0, 0);
        try {
            const r = await optimizeResourceStorage();
            expect(r.scanUnavailable).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });

    it('合并跑完是幂等的：再点一次没有重复可合', async () => {
        const older = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const newer = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', older);
        await DB.saveAsset('lock_wallpaper', newer);

        await optimizeResourceStorage();
        const second = await optimizeResourceStorage();
        expect(second.mergedDuplicates).toBe(0);
        expect(second.converted).toBe(0);
    });
});

describe('记忆向量：压成紧凑形态', () => {
    it('一键优化同时收敛旧连接小数，不删除边，第二次幂等', async () => {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('memory_links', 'readwrite');
            tx.objectStore('memory_links').clear();
            tx.objectStore('memory_links').put({ id: 'old-link', sourceId: 'm1', targetId: 'm2', type: 'emotional', strength: 0.2789476291284245 });
            tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
        });
        const result = await optimizeResourceStorage();
        expect(result.linksCompacted).toBe(1);
        expect(await DB.getRawStoreData('memory_links')).toEqual([{ id: 'old-link', sourceId: 'm1', targetId: 'm2', type: 'emotional', strength: 0.27895 }]);
        expect((await optimizeResourceStorage()).linksCompacted).toBe(0);
    });
    /** 直接塞一条旧 number[] 形态的向量（绕开 MemoryVectorDB.save，它会当场转成紧凑形态）。 */
    async function seedLegacyVector(memoryId: string, charId: string, dims: number): Promise<number[]> {
        const vector = Array.from({ length: dims }, (_, i) => (i % 7) / 7 - 0.5);
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('memory_vectors', 'readwrite');
            tx.objectStore('memory_vectors').put({ memoryId, charId, vector, dimensions: dims });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        return vector;
    }

    async function readRawVector(memoryId: string): Promise<any> {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction('memory_vectors', 'readonly').objectStore('memory_vectors').get(memoryId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    it('一键优化会把旧 number[] 向量压成紧凑字节，数值逐位不变', async () => {
        const original = await seedLegacyVector('m1', 'c1', 16);

        const r = await optimizeResourceStorage();

        expect(r.vectorsCompacted).toBe(1);
        expect(r.vectorError).toBeNull();
        const stored = await readRawVector('m1');
        expect(ArrayBuffer.isView(stored.vector)).toBe(true);
        // Float32 精度内逐位一致：压缩必须是无损的，否则召回质量会静默退化
        const back = new Float32Array(stored.vector.buffer, stored.vector.byteOffset, stored.vector.byteLength >>> 2);
        expect(back.length).toBe(original.length);
        for (let i = 0; i < original.length; i++) {
            expect(back[i]).toBeCloseTo(original[i], 6);
        }
    });

    it('幂等：已是紧凑形态的再点一次不重复计数', async () => {
        await seedLegacyVector('m1', 'c1', 16);
        await optimizeResourceStorage();
        const second = await optimizeResourceStorage();
        expect(second.vectorsCompacted).toBe(0);
        expect(second.vectorError).toBeNull();
    });

    it('向量这步失败不吞、也不连累图片那几步的成果', async () => {
        const mp = await import('./memoryPalace/db');
        const spy = vi.spyOn(mp.MemoryVectorDB, 'scanAndMigrateLegacy')
            .mockRejectedValue(new Error('磁盘满了'));
        try {
            await DB.saveAsset('wallpaper', TINY_PNG);

            const r = await optimizeResourceStorage();

            // 图片照转完，结果照报
            expect(r.converted).toBe(1);
            expect(isBlobRef(await DB.getAsset('wallpaper'))).toBe(true);
            // 向量的失败原样带出来（开机那次后台扫描就是只 console.warn，卡住了没人知道）
            expect(r.vectorsCompacted).toBe(0);
            expect(r.vectorError).toContain('磁盘满了');
        } finally {
            spy.mockRestore();
        }
    });
});

describe('分页读表：跨页不漏行，进度条对得上', () => {
    // 这五面原本是整表 getAll 的，行都在一个数组里，怎么写都不会漏。改成按主键翻页之后，
    // 「只跑了第一批就退出」「翻页起点取错」这类毛病在小库上一条都不会红，而漏掉的行
    // 就是没被转换的存量图。这组用例把跨页和进度口径钉住。
    const PAGE = 200; // 与 storageOptimize.ts 的 PAGE_SIZE 一致

    it('相册行数超过一页：跨页每一行都转到，一条不漏', async () => {
        const count = PAGE + 50;
        await seedStore('gallery', Array.from({ length: count }, (_, i) => ({
            id: `g${String(i + 1).padStart(4, '0')}`, charId: 'c1', url: TINY_PNG, timestamp: i + 1,
        })));

        const r = await optimizeResourceStorage();

        const rows = await DB.getGalleryImages();
        expect(rows.length).toBe(count);
        // 第 2 页起漏掉任何一行，这里就是一堆还留着 data: 的相册图
        expect(rows.filter(g => isBlobRef(g.url)).length).toBe(count);
        expect(r.converted).toBe(count);
        expect(r.uniqueBlobs).toBe(1); // 全是同一张图，去重后只建一份 Blob
    });

    it('聊天消息行数超过一页：跨页每一条图片消息都转到，一条不漏', async () => {
        // messages 是全库最大的表，翻页出问题时漏掉的就是第 2 页往后所有存量聊天图
        const count = PAGE + 50;
        await seedStore('messages', Array.from({ length: count }, (_, i) => ({
            id: i + 1, charId: 'c1', role: 'user', type: 'image', content: TINY_PNG, timestamp: i + 1,
        })));

        const r = await optimizeResourceStorage();

        const rows = await DB.getMessagesByCharId('c1');
        expect(rows.length).toBe(count);
        expect(rows.filter(m => isBlobRef(m.content)).length).toBe(count);
        expect(r.converted).toBe(count);
        expect(r.uniqueBlobs).toBe(1); // 全是同一张图，去重后只建一份 Blob
    });

    it('进度回调：total 就是十二面的真实行数，done 一路递增且正好停在 total', async () => {
        // 十二个面各摆几行、行数互不相同——少数了哪一面都对不上
        await DB.saveAsset('wallpaper', TINY_PNG);
        await DB.saveAsset('lock_wallpaper', TINY_JPEG);
        await seedStore('characters', [
            { id: 'c1', name: '角色一', roomConfig: { wallImage: TINY_PNG, items: [] } },
            { id: 'c2', name: '角色二' },
            { id: 'c3', name: '角色三' },
        ]);
        await seedStore('songs', [{ id: 's1', title: '测试曲', coverImage: TINY_JPEG }]);
        await seedStore('cc_custom_parts', [
            { id: 'p1', src: TINY_PNG, createdAt: 1 },
            { id: 'p2', src: TINY_JPEG, createdAt: 2 },
        ]);
        await seedStore('gallery', [
            { id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 },
            { id: 'g2', charId: 'c1', url: TINY_JPEG, timestamp: 2 },
            { id: 'g3', charId: 'c1', url: TINY_PNG, timestamp: 3 },
            { id: 'g4', charId: 'c1', url: TINY_JPEG, timestamp: 4 },
        ]);
        await seedStore('themes', [
            { id: 't1', name: '气泡一', type: 'custom', user: { backgroundImage: TINY_PNG }, ai: {} },
            { id: 't2', name: '气泡二', type: 'custom', user: {}, ai: { decoration: TINY_GIF } },
            { id: 't3', name: '气泡三', type: 'custom', user: {}, ai: {} },
            { id: 't4', name: '气泡四', type: 'custom', user: {}, ai: {} },
            { id: 't5', name: '气泡五', type: 'custom', user: {}, ai: {} },
        ]);
        await seedStore('messages', [
            { id: 1, charId: 'c1', role: 'user', type: 'image', content: TINY_PNG, timestamp: 1 },
            { id: 2, charId: 'c1', role: 'user', type: 'text', content: '一句话', timestamp: 2 },
            { id: 3, charId: 'c1', role: 'user', type: 'emoji', content: TINY_JPEG, timestamp: 3 },
            { id: 4, charId: 'c1', role: 'assistant', type: 'text', content: '回一句', timestamp: 4 },
            { id: 5, charId: 'c1', role: 'user', type: 'text', content: '再一句', timestamp: 5 },
            { id: 6, charId: 'c1', role: 'user', type: 'text', content: '还有一句', timestamp: 6 },
        ]);
        await seedStore('emojis', [
            { name: '本地表情', url: TINY_GIF },
            { name: '网络表情', url: 'https://img.host/sticker.png' },
        ]);
        await seedStore('user_profile', [{ id: 'me', name: '小明', avatar: TINY_JPEG }]);
        await seedStore('social_posts', [
            { id: 'sp1', authorName: '甲', authorAvatar: TINY_PNG, comments: [], images: [], timestamp: 1 },
            { id: 'sp2', authorName: '乙', authorAvatar: TINY_JPEG, comments: [], images: [], timestamp: 2 },
            { id: 'sp3', authorName: '丙', authorAvatar: '', comments: [], images: [], timestamp: 3 },
            { id: 'sp4', authorName: '丁', authorAvatar: '', comments: [], images: [], timestamp: 4 },
            { id: 'sp5', authorName: '戊', authorAvatar: '', comments: [], images: [], timestamp: 5 },
            { id: 'sp6', authorName: '己', authorAvatar: '', comments: [], images: [], timestamp: 6 },
            { id: 'sp7', authorName: '庚', authorAvatar: '', comments: [], images: [], timestamp: 7 },
        ]);
        await seedStore('groups', [
            { id: 'gp1', name: '群一', avatar: TINY_PNG },
            { id: 'gp2', name: '群二', avatar: '' },
            { id: 'gp3', name: '群三', avatar: '' },
            { id: 'gp4', name: '群四', avatar: '' },
            { id: 'gp5', name: '群五', avatar: '' },
            { id: 'gp6', name: '群六', avatar: '' },
            { id: 'gp7', name: '群七', avatar: '' },
            { id: 'gp8', name: '群八', avatar: '' },
        ]);
        await seedStore('life_sim', [
            { id: 'ls1', actionLog: [{ turnNumber: 1, actor: '甲', actorAvatar: TINY_JPEG }] },
            { id: 'ls2', actionLog: [] },
            { id: 'ls3', actionLog: [] },
            { id: 'ls4', actionLog: [] },
            { id: 'ls5', actionLog: [] },
            { id: 'ls6', actionLog: [] },
            { id: 'ls7', actionLog: [] },
            { id: 'ls8', actionLog: [] },
            { id: 'ls9', actionLog: [] },
        ]);
        const expectedRows = 2 + 3 + 1 + 2 + 4 + 5 + 6 + 2 + 1 + 7 + 8 + 9;

        // 只收十二面自己报的那几档：扫库 / 合并 / 向量三段各有各的进度口径，混进来会算错
        const faceLabels = new Set(['系统外观', '角色头像与小屋', '歌曲封面', '捏人器部件', '相册', '气泡主题', '聊天图片', '表情包', '我的头像', '社交帖子', '群头像', '生活模拟']);
        const events: Array<{ done: number; total: number }> = [];
        await optimizeResourceStorage(p => {
            if (faceLabels.has(p.label)) events.push({ done: p.done, total: p.total });
        });

        expect(events.length).toBe(expectedRows);                   // 每行恰好报一次
        for (const e of events) expect(e.total).toBe(expectedRows); // 总数不是估的
        // done 从 1 数到 total：不倒退、不跳号、不越过
        expect(events.map(e => e.done)).toEqual(Array.from({ length: expectedRows }, (_, i) => i + 1));
    });
});

describe('气泡主题导出：分享文件里不能留令牌', () => {
    // 工坊导出的 .sully-bubble.json 是给别人的，令牌只有本机认得——原样导出，对方导进去
    // 拿到的是一串死字符串，三张图全空，还没有任何报错。所以导出前必须在深拷贝上跑一遍
    // resolveBlobRefsDeep 把令牌换回内嵌 data URL。
    // 真调一次得把整个工坊界面渲染起来，代价太大，这里用源码锚：改坏导出这条就挂。
    const themeMakerSrc = readFileSync(new URL('../components/chat/BubbleMaker.tsx', import.meta.url), 'utf8');

    /** 截出 exportSavedTheme 的函数体（到第一处同缩进的收尾 `};` 为止）。 */
    function exportFnBody(): string {
        const start = themeMakerSrc.indexOf('const exportSavedTheme');
        expect(start).toBeGreaterThan(-1);
        const end = themeMakerSrc.indexOf('\n    };', start);
        expect(end).toBeGreaterThan(start);
        return themeMakerSrc.slice(start, end);
    }

    it('导出前解析令牌，解析的是副本、写进文件的也是那份副本', () => {
        const body = exportFnBody();
        // 一、真的解析了
        const resolved = /await resolveBlobRefsDeep\((\w+)\)/.exec(body);
        expect(resolved).not.toBeNull();
        const copyName = resolved![1];
        // 二、解析的不是库里那份（resolveBlobRefsDeep 原地改对象，喂 theme 等于把用户的主题改空）
        expect(copyName).not.toBe('theme');
        expect(body).toMatch(new RegExp(`const ${copyName} = cloneTheme\\(`));
        // 三、序列化进文件的是解析过的那份，不是原始入参
        expect(body).toMatch(new RegExp(`theme:\\s*${copyName}\\b`));
        expect(body.indexOf('resolveBlobRefsDeep')).toBeLessThan(body.indexOf('JSON.stringify'));
    });

    it('工坊上传的图存的是令牌，不是 base64', () => {
        const start = themeMakerSrc.indexOf('const handleImageUpload');
        expect(start).toBeGreaterThan(-1);
        const body = themeMakerSrc.slice(start, themeMakerSrc.indexOf('\n    };', start));
        // processImage 给的是 data URL，得再过一道 migrateDataUrlToRef 才进主题
        expect(body).toMatch(/await migrateDataUrlToRef\(/);
        expect(body).not.toMatch(/updateStyle\('(backgroundImage|decoration|avatarDecoration)', result\)/);
    });
});

describe('头像上传：新存进去的就是令牌', () => {
    // 存量迁移只管库里已经躺着的那些。写端要是没接上，用户每传一张新头像就又落一份 base64，
    // 一键优化跑完照样长回来，而界面上一点区别都看不出来。真渲染一遍这几个界面代价太大，
    // 这里用源码锚：四个上传点里哪个漏了 migrateDataUrlToRef，这组就红。
    const readSrc = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

    /** 截出某个 handler 的函数体（到最近的一处收尾 `};` 为止；各文件缩进不同，2/4 空格都认）。 */
    function handlerBody(src: string, decl: string): string {
        const start = src.indexOf(decl);
        expect(start).toBeGreaterThan(-1);
        const ends = ['\n  };', '\n    };'].map(m => src.indexOf(m, start)).filter(i => i > start);
        expect(ends.length).toBeGreaterThan(0);
        return src.slice(start, Math.min(...ends));
    }

    it('角色头像（角色资料页）', () => {
        const body = handlerBody(readSrc('../apps/Character.tsx'), 'const handleFileChange');
        expect(body).toMatch(/handleChange\('avatar', await migrateDataUrlToRef\(/);
        expect(body).not.toMatch(/handleChange\('avatar', processedBase64\)/);
    });

    it('我的整体头像（个人档案）', () => {
        const body = handlerBody(readSrc('../apps/UserApp.tsx'), 'const handleAvatarChange');
        expect(body).toMatch(/avatar: await migrateDataUrlToRef\(/);
        expect(body).not.toMatch(/updateUserProfile\(\{ avatar: base64 \}\)/);
    });

    it('群头像（群聊设置）', () => {
        const body = handlerBody(readSrc('../apps/GroupChat.tsx'), 'const handleGroupAvatarUpload');
        expect(body).toMatch(/await migrateDataUrlToRef\(/);
        // 内存那份和落库那份必须是同一个值，否则退出重进会读回令牌、当前界面还挂着 base64
        expect(body).not.toMatch(/avatar: base64/);
    });

    it('分角色聊天头像：本地上传转令牌，图床外链那条路不碰', () => {
        const src = readSrc('../components/user/PerCharAvatarPicker.tsx');
        const upload = handlerBody(src, 'const handleUpload');
        expect(upload).toMatch(/setOverride\(editingId, await migrateDataUrlToRef\(/);
        expect(upload).not.toMatch(/setOverride\(editingId, base64\)/);
        // 外链只是个 http 地址，本机没有它的二进制，转不了也不该转
        const applyUrl = handlerBody(src, 'const applyUrl');
        expect(applyUrl).not.toMatch(/migrateDataUrlToRef/);
    });
});

describe('图片令牌进提示词：靠前缀判图的地方必须认得令牌', () => {
    // 这组守卫跟「一键优化」不是同一件事，但它们钉的是同一次迁移里最难查的那种坏法：
    // 判定认不出 `blobref:` 令牌时，图明明还在库里，模型收到的却是「图片数据已不可用」，
    // 或者干脆没被列进附图名单——不报错、不破图，从界面上一点看不出来。
    // 放在这份文件里是因为它跟聊天图 / 表情包的迁移同批落地，改坏迁移和改坏判定要一起红。

    const TINY_PNG_LOCAL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const char = { id: 'c1', name: '角色', contextRangePolicyVersion: 1 } as any;
    const userProfile = { name: '小明' } as any;

    /** 只有一条图片消息的私聊历史，取转写出来的那一条。 */
    function imageHistoryEntry(content: string): any {
        return ChatPrompts.buildMessageHistory(
            [{ id: 1, charId: 'c1', role: 'user', type: 'image', content, timestamp: Date.now() } as any],
            50,
            char,
            userProfile,
            [],
        ).apiMessages[0];
    }

    it('私聊历史：令牌形态的图片照样走 image_url 结构化字段', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG_LOCAL));

        const entry = imageHistoryEntry(token);

        expect(Array.isArray(entry.content)).toBe(true);
        expect(entry.content.some((p: any) => p.type === 'image_url' && p.image_url?.url === token)).toBe(true);
        // 认不出令牌时这里会变成「图片数据已不可用」的纯文本，图却好端端躺在库里
        expect(JSON.stringify(entry.content)).not.toContain('no longer available');
    });

    it('私聊历史：图真丢了才说不可用（空 content 走占位文本）', () => {
        const entry = imageHistoryEntry('');
        expect(typeof entry.content).toBe('string');
        expect(entry.content).toContain('no longer available');
    });

    it('群历史：令牌形态的图片进最近附图名单，不被当正文内联', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG_LOCAL));

        const block = buildGroupHistoryBlock(
            [{ id: 1, groupId: 'g1', charId: 'user', role: 'user', type: 'image', content: token, timestamp: Date.now() } as any],
            [],
            [],
            '小明',
        );

        expect(block.attachedImages.map(i => i.url)).toEqual([token]);
        expect(block.text).toContain('[图片#1]');
        expect(block.text).not.toContain(token);
    });

    it('群历史兜底：别的类型里躺着令牌也按媒体占位，不内联进正文', async () => {
        // 令牌内联进正文的代价比漏一个 URL 大得多——出门时网络出口那层会把它还原成
        // 整段 data URL，等于把几 MB 的 base64 焊进 prompt。
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG_LOCAL));

        const block = buildGroupHistoryBlock(
            [{ id: 1, groupId: 'g1', charId: 'user', role: 'user', type: 'text', content: token, timestamp: Date.now() } as any],
            [],
            [],
            '小明',
        );

        expect(block.text).toContain('[媒体]');
        expect(block.text).not.toContain(token);
    });
});

describe('主动消息上云：先还原令牌再算体积预算', () => {
    // worker 那边没有 IndexedDB，`blobref:` 令牌到了云端谁也解不开；而令牌只有几十字节，
    // 先算预算再还原的话，一份「看着没超」的包还原后可能是几 MB。所以顺序是死的：
    // 先还原，再交给 toFirePackChatMessages 算预算。
    it('还原发生在副本上：调用方那串消息一个字节都不变，令牌换成了 data URL', async () => {
        const { resolveChatMessagesForUpload } = await import('./activeMsgClient');
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const original = [
            { role: 'user', content: [{ type: 'text', text: '看这张' }, { type: 'image_url', image_url: { url: token } }] },
            { role: 'assistant', content: '好看' },
        ];
        const snapshot = JSON.stringify(original);

        const resolved = await resolveChatMessagesForUpload(original);

        // 一、令牌真的被还原成了可离线阅读的 data URL
        const url = (resolved[0].content as any)[1].image_url.url as string;
        expect(url.startsWith('data:')).toBe(true);
        expect(isBlobRef(url)).toBe(false);
        // 二、原数组没被就地改掉（本地这一轮还要用同一串消息）
        expect(JSON.stringify(original)).toBe(snapshot);
    });

    it('打包点真的用上了它：chat 段是「先还原、再交给体积预算」', () => {
        // 上面那条只证明函数本身好使。真正会静默出事的是「函数写了但没接上」——
        // 那样打上云的还是令牌，worker 解不开，图在云端悄悄消失。
        // 真调一次 sendInstantChat 要把整个 worker 客户端立起来，这里用源码锚。
        const src = readFileSync(new URL('./activeMsgClient.ts', import.meta.url), 'utf8');
        expect(src).toMatch(/messages:\s*toFirePackChatMessages\(await resolveChatMessagesForUpload\(chatMessages\)\)/);
        // 别处不许再把没还原过的那串直接塞进去
        expect(src).not.toMatch(/toFirePackChatMessages\(chatMessages\)/);
    });
});

// ═══ 全库对账（从测试期的诊断卡片迁来，卡片撤了守卫留下） ═══
//
// 上面的用例都是「一个面一个面」地钉；这条反过来从全库视角问一句：收录清单里的
// 每种字段各摆一份，跑完优化后还扫得出 data:image 吗？哪个字段没被收录，它就会
// 按表点名。将来新收字段时往 seed 里补一份，就能立刻知道优化器跟没跟上。
describe('全库对账：收录字段各摆一份，优化后一条 base64 都不剩', () => {
    /** 每张图内容都不同：内容相同的会被去重合并成一份，令牌计数就对不上了。 */
    const tinyImage = (seed: string): string =>
        `data:image/png;base64,${Buffer.from(`sullyos-guard-${seed}`).toString('base64')}`;

    /** 全库逐表 stringify，按表数 data:image 出现次数。跟优化器各算各的，
     *  两边对得上才说明看的是同一批数据。 */
    async function scanBase64ByStore(): Promise<Record<string, number>> {
        const db = await openDB();
        const hits: Record<string, number> = {};
        for (const store of Array.from(db.objectStoreNames)) {
            let count = 0;
            let afterKey: IDBValidKey | null = null;
            for (;;) {
                const { rows, lastKey } = await DB.getStoreRowsPage(store, afterKey, 200);
                for (const row of rows) count += (JSON.stringify(row)?.match(/data:image\//g) ?? []).length;
                if (lastKey === null || rows.length < 200) break;
                afterKey = lastKey;
            }
            if (count > 0) hits[store] = count;
        }
        return hits;
    }

    it('十二个面的收录字段全摆上，优化后全库扫不出一条 data:image', async () => {
        await seedStore('characters', [{
            id: 'c1', name: '角色一',
            chatBackground: tinyImage('chat-bg'),
            dateBackground: tinyImage('date-bg'),
            sprites: { normal: tinyImage('sprite-normal') },
            dateSkinSets: [{ id: 'sk1', name: '泳装', sprites: { happy: tinyImage('skin-happy') } }],
            vrState: { chibi: { img: tinyImage('char-chibi') } },
            phoneState: { contacts: [{ id: 'ct1', name: '甲', avatar: tinyImage('contact') }] },
            companionAvatar: {
                version: 1, source: 'upload', imageRef: tinyImage('companion'),
                imageWardrobe: [{ id: 'w1', imageRef: tinyImage('companion-alt') }],
            },
            videoCallBackground: tinyImage('call-bg'),
            companionBackground: tinyImage('companion-bg'),
            specialMomentRecords: {
                whiteday_2026: {
                    image: tinyImage('moment-img'),
                    customData: { chatCard: { charAvatar: tinyImage('card-avatar') } },
                },
            },
        }]);
        await seedStore('user_profile', [{ id: 'me', name: '小明', vrState: { chibi: { img: tinyImage('my-chibi') } } }]);
        await seedStore('social_posts', [{
            id: 'p1', authorName: '甲', authorAvatar: tinyImage('post-author'), images: [], timestamp: 1,
            comments: [{ id: 'cm1', authorName: '乙', authorAvatar: tinyImage('comment-author') }],
        }]);
        await seedStore('groups', [{ id: 'g1', name: '群一', avatar: tinyImage('group') }]);
        await seedStore('life_sim', [{ id: 'ls1', actionLog: [{ turnNumber: 1, actor: '甲', actorAvatar: tinyImage('actor') }] }]);
        await seedStore('messages', [{
            id: 1, charId: 'c1', role: 'assistant', type: 'score_card', timestamp: 1,
            content: JSON.stringify({ charAvatar: tinyImage('card-content'), photoDataUrl: tinyImage('photo') }),
            metadata: {
                characterAvatar: tinyImage('call-avatar'),
                scoreCard: { charAvatar: tinyImage('card-meta'), photoDataUrl: tinyImage('photo-meta') },
                post: {
                    authorName: '甲', authorAvatar: tinyImage('shared-author'), images: [],
                    comments: [{ authorName: '乙', authorAvatar: tinyImage('shared-comment') }],
                },
            },
        }]);
        await seedStore('assets', [
            { id: 'widget_dsq', data: tinyImage('widget') },
            { id: 'spark_user_bg', data: tinyImage('spark-bg') },
            { id: 'spark_social_profile', data: JSON.stringify({ name: '小明', avatar: tinyImage('spark-avatar') }) },
            { id: 'appearance_preset_ap1', data: JSON.stringify({
                id: 'ap1', name: '预设', createdAt: 1,
                theme: { wallpaper: 'linear-gradient(#fff,#000)', launcherWidgets: { dsq: tinyImage('preset-widget') } },
                chatThemes: [{
                    id: 'ct1', name: '气泡', type: 'custom',
                    user: { decoration: tinyImage('preset-bubble-user') },
                    ai: { avatarDecoration: tinyImage('preset-bubble-ai') },
                }],
            }) },
        ]);

        const before = await scanBase64ByStore();
        const beforeTotal = Object.values(before).reduce((a, b) => a + b, 0);
        expect(beforeTotal).toBeGreaterThan(0); // seed 本身得先被看见，全零 = 摆错了地方

        const r = await optimizeResourceStorage();

        // 哪个字段没被收录，它就留在这里按表点名
        expect(await scanBase64ByStore()).toEqual({});
        expect(r.failed).toBe(0);
        // 优化器报的转换数 == 扫描数出来的张数，两边对得上才说明没有静默漏转
        expect(r.converted).toBe(beforeTotal);
    });
});
