import { describe, expect, it } from 'vitest';
import {
    WORLDBOOK_SCENE_CATEGORIES,
    getWorldbookSceneCategoryState,
    isWorldbookSceneAllowed,
    isWorldbookSceneEnabled,
    getWorldbookSceneRows,
    normalizeWorldbookScenes,
    sanitizeWorldbookScenes,
    setAllWorldbookScenes,
    setWorldbookScene,
    setWorldbookSceneCategory,
} from './worldbookScenes';

describe('世界书生效场景 · 令牌语义', () => {
    it('undefined / null 表示所有场景，[] 表示哪里都不生效', () => {
        expect(isWorldbookSceneAllowed({}, 'offline.date')).toBe(true);
        expect(isWorldbookSceneAllowed({ scenes: null }, 'apps.trpg')).toBe(true);
        expect(isWorldbookSceneAllowed({ scenes: [] }, 'apps.trpg')).toBe(false);
    });

    it('分类令牌覆盖整个分类（含隐藏子场景），子场景令牌只管那一个', () => {
        expect(isWorldbookSceneAllowed({ scenes: ['chat'] }, 'chat.qqBridge')).toBe(true);
        expect(isWorldbookSceneAllowed({ scenes: ['chat'] }, 'offline.date')).toBe(false);
        expect(isWorldbookSceneAllowed({ scenes: ['apps.trpg'] }, 'apps.trpg')).toBe(true);
        expect(isWorldbookSceneAllowed({ scenes: ['apps.trpg'] }, 'apps.spark')).toBe(false);
    });

    // 回归守卫：外来角色卡里的 scenes 写坏了，生成时判定不能报错。
    it('外来 scenes 清洗：不是数组按所有场景，元素只留非空字符串', () => {
        expect(sanitizeWorldbookScenes({})).toBeUndefined();
        expect(sanitizeWorldbookScenes(3)).toBeUndefined();
        expect(sanitizeWorldbookScenes('chat')).toBeUndefined();
        expect(sanitizeWorldbookScenes(null)).toBeUndefined();
        expect(sanitizeWorldbookScenes(['apps.trpg', 1, {}, ' chat ', ''])).toEqual(['apps.trpg', 'chat']);
        expect(sanitizeWorldbookScenes([])).toEqual([]);
    });

    it('认不出的令牌忽略，不报错', () => {
        expect(isWorldbookSceneAllowed({ scenes: ['apps.notYet', 'bogus'] }, 'apps.trpg')).toBe(false);
        expect(isWorldbookSceneAllowed({ scenes: ['bogus', 'offline.date'] }, 'offline.date')).toBe(true);
    });

    it('appManaged 场景一律放行，开关不管它', () => {
        expect(isWorldbookSceneAllowed({ scenes: [] }, 'apps.storyTheater')).toBe(true);
        expect(isWorldbookSceneEnabled([], 'apps.storyTheater')).toBe(false);
    });

    it('登记表里的子场景 id 都以所属分类为前缀且不重复', () => {
        const ids = WORLDBOOK_SCENE_CATEGORIES.flatMap(c => c.subs.map(s => s.id));
        expect(new Set(ids).size).toBe(ids.length);
        WORLDBOOK_SCENE_CATEGORIES.forEach(c => c.subs.forEach(s => expect(s.id.startsWith(c.id + '.')).toBe(true)));
    });
});

describe('世界书生效场景 · 开关规整', () => {
    it('全选开写 undefined，全选关写 []', () => {
        expect(setAllWorldbookScenes(true)).toBeUndefined();
        expect(setAllWorldbookScenes(false)).toEqual([]);
    });

    it('从所有场景关掉一个子场景：该分类展开成其余子场景，其他分类收成分类令牌', () => {
        const next = setWorldbookScene(undefined, 'apps.trpg', false)!;
        expect(next).toContain('chat');
        expect(next).toContain('memory');
        expect(next).not.toContain('apps');
        expect(next).not.toContain('apps.trpg');
        expect(next).toContain('apps.bank'); // 隐藏的也保留
        expect(next).not.toContain('apps.storyTheater'); // appManaged 不写令牌
        expect(setWorldbookScene(next, 'apps.trpg', true)).toBeUndefined();
    });

    it('隐藏子场景合成末尾一行「其他」，一起开关', () => {
        const rows = getWorldbookSceneRows('apps');
        expect(rows.at(-1)).toMatchObject({ label: '其他', sceneIds: ['apps.bank', 'apps.handbook'] });
        expect(rows.flatMap(row => row.sceneIds)).not.toContain('apps.unknown');
        expect(setWorldbookScene(['apps.trpg'], rows.at(-1)!.sceneIds, true)).toEqual(['apps.trpg', 'apps.bank', 'apps.handbook']);
        expect(getWorldbookSceneRows('memory').some(row => row.label === '其他')).toBe(false);
    });

    // 回归守卫：可见开关全开、「其他」没开时，分类不能显示成全开（实际 QQ 桥不生效）。
    it('可见子场景全开但「其他」没开时显示部分开启、不收拢；分类全开才写分类令牌', () => {
        let scenes = setWorldbookScene([], 'chat.private', true);
        scenes = setWorldbookScene(scenes, 'chat.collaboration', true);
        expect(scenes).toEqual(['chat.private', 'chat.collaboration']);
        expect(getWorldbookSceneCategoryState(scenes, 'chat')).toBe('some');
        expect(getWorldbookSceneCategoryState(setWorldbookScene(scenes, 'chat.qqBridge', true), 'chat')).toBe('all');
        expect(setWorldbookSceneCategory(scenes, 'chat', true)).toEqual(['chat']);
        expect(setWorldbookScene(['chat'], 'chat.private', false)).toEqual(['chat.collaboration', 'chat.qqBridge']);
    });

    it('分类全关去掉该分类全部令牌；所有分类都开时收成 undefined', () => {
        expect(setWorldbookSceneCategory(['chat', 'apps.trpg'], 'apps', false)).toEqual(['chat']);
        const allButOne = WORLDBOOK_SCENE_CATEGORIES.map(c => c.id).filter(id => id !== 'group');
        expect(setWorldbookSceneCategory(allButOne, 'group', true)).toBeUndefined();
        expect(setWorldbookSceneCategory(undefined, 'group', false)).toEqual(allButOne);
    });

    it('认不出的令牌在改开关时原样保留', () => {
        expect(setWorldbookScene(['apps.future'], 'offline.date', true)).toEqual(['offline.date', 'apps.future']);
        expect(normalizeWorldbookScenes([])).toEqual([]);
    });

    it('分类状态按有开关的行算，「其他」也算一行', () => {
        expect(getWorldbookSceneCategoryState(undefined, 'apps')).toBe('all');
        expect(getWorldbookSceneCategoryState([], 'apps')).toBe('none');
        expect(getWorldbookSceneCategoryState(['apps.trpg'], 'apps')).toBe('some');
        expect(getWorldbookSceneCategoryState(['chat.qqBridge'], 'chat')).toBe('some');
        expect(getWorldbookSceneCategoryState(['apps.storyTheater'], 'apps')).toBe('none');
    });
});

describe('世界书生效场景 · 存取', () => {
    it('挂载副本带上 scenes 且是新数组', async () => {
        const { toMountedWorldbook } = await import('./worldbook');
        const scenes = ['apps.trpg'];
        const mounted = toMountedWorldbook({ id: 'x', title: 'x', content: 'c', category: 'g', createdAt: 0, updatedAt: 0, scenes });
        expect(mounted.scenes).toEqual(scenes);
        expect(mounted.scenes).not.toBe(scenes);
        expect(toMountedWorldbook({ id: 'y', title: 'y', content: 'c', category: 'g', createdAt: 0, updatedAt: 0 }).scenes).toBeUndefined();
    });

    it('糯米机导出往返保留 scenes（含 []），酒馆文件不读这个字段', async () => {
        const { serializeSullyWorldbook, parseStandardWorldbook } = await import('./worldbook');
        const base = { title: 't', content: 'c', category: 'g', createdAt: 0, updatedAt: 0 };
        const text = serializeSullyWorldbook([
            { ...base, id: 'a', scenes: ['apps', 'offline.date'] }, { ...base, id: 'b', scenes: [] }, { ...base, id: 'c' },
        ]);
        expect(parseStandardWorldbook(text, 'g').map(b => b.scenes)).toEqual([['apps', 'offline.date'], [], undefined]);
        const tavern = JSON.stringify({ entries: { 0: { content: 'c', scenes: ['apps'] } } });
        expect(parseStandardWorldbook(tavern, 'g')[0].scenes).toBeUndefined();
    });
});
