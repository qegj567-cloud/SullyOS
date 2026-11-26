/**
 * 世界书「生效场景」登记表与判定。
 *
 * 条目的 scenes 字段写的是令牌：分类 id（如 'apps'）代表整个分类，包括以后新增的子场景；
 * 子场景 id（如 'apps.trpg'）只代表那一个场景。undefined / null 表示所有场景，[] 表示哪里都不生效。
 * 认不出的令牌直接忽略，不报错（新版本写的令牌被旧版本读到时也不至于出事）。
 *
 * 这份文件只依赖类型，以后可能被打进 Cloudflare worker bundle，不要引入 DOM / IDB / 浏览器模块。
 */
import type { WorldbookEntryConfig } from '../types';

export interface WorldbookSceneSub {
    id: string;
    label: string;
    /** 界面上不单列：同类的隐藏子场景合成一个「其他」开关，一起开关。 */
    hidden?: boolean;
    /** 由 App 自己挑选世界书，场景筛选对它不生效；界面只列出、不给开关。 */
    appManaged?: boolean;
}

export interface WorldbookSceneCategory {
    id: string;
    label: string;
    subs: readonly WorldbookSceneSub[];
}

export const WORLDBOOK_SCENE_APP_MANAGED_HINT = '请在对应应用内勾选调整';
/** 一个开关都没开时的摘要：见面·剧情这类由应用自己选书的场景，手动勾选了仍会用到，所以不说「哪里都不生效」。 */
export const WORLDBOOK_SCENE_NONE_TEXT = '仅应用内勾选时生效';

export const WORLDBOOK_SCENE_CATEGORIES = [
    {
        id: 'chat', label: '线上私聊', subs: [
            { id: 'chat.private', label: '私聊' },
            { id: 'chat.collaboration', label: '协同工作' },
            { id: 'chat.qqBridge', label: 'QQ 桥', hidden: true },
        ],
    },
    {
        id: 'proactive', label: '角色主动找你', subs: [
            { id: 'proactive.scheduled', label: '定时主动消息' },
            { id: 'proactive.self', label: '角色自己约的下一条' },
            { id: 'proactive.away', label: '离开后消息' },
            { id: 'proactive.dateLeave', label: '见面离开提醒' },
        ],
    },
    {
        id: 'group', label: '多人', subs: [
            { id: 'group.groupChat', label: '群聊' },
            { id: 'group.charPrivate', label: '角色间私聊' },
        ],
    },
    {
        id: 'offline', label: '线下在场', subs: [
            { id: 'offline.date', label: '见面' },
            { id: 'offline.call', label: '通话' },
            { id: 'offline.home3d', label: '3D 小屋' },
            { id: 'offline.companion', label: '桌面陪伴' },
            { id: 'offline.room', label: '小小窝' },
        ],
    },
    {
        id: 'apps', label: '其他 App 玩法', subs: [
            { id: 'apps.storyTheater', label: '见面·剧情', appManaged: true },
            { id: 'apps.trpg', label: '跑团' },
            { id: 'apps.spark', label: 'Spark' },
            { id: 'apps.friendFeed', label: '哔哔' },
            { id: 'apps.checkPhone', label: '查手机' },
            { id: 'apps.personaSim', label: '人格模拟' },
            { id: 'apps.dream', label: '梦境' },
            { id: 'apps.schedule', label: '日程' },
            { id: 'apps.scheduleTheater', label: '日程小剧场' },
            { id: 'apps.timeContract', label: '时光契约' },
            { id: 'apps.journal', label: '交换日记' },
            { id: 'apps.study', label: '自习室' },
            { id: 'apps.songwriting', label: '写歌' },
            { id: 'apps.guidebook', label: '攻略本' },
            { id: 'apps.novel', label: '笔友会' },
            { id: 'apps.lifeSim', label: '都市人生' },
            { id: 'apps.freeRoam', label: '自由活动' },
            { id: 'apps.vrFreeRoam', label: '彼方·自由活动' },
            { id: 'apps.vrTheater', label: '彼方·剧院' },
            { id: 'apps.vrChipNote', label: '彼方·芯片随笔' },
            { id: 'apps.worldHome', label: '家园' },
            { id: 'apps.memoryDive', label: '记忆潜行' },
            { id: 'apps.like520', label: '特别时光·520' },
            { id: 'apps.qixi', label: '特别时光·七夕' },
            { id: 'apps.valentine', label: '特别时光·情人节' },
            { id: 'apps.whiteDay', label: '特别时光·白色情人节' },
            { id: 'apps.bank', label: '存钱罐', hidden: true },
            { id: 'apps.handbook', label: '手账', hidden: true },
        ],
    },
    {
        id: 'memory', label: '记忆与整理', subs: [
            { id: 'memory.summary', label: '记忆总结与归档' },
            { id: 'memory.impression', label: '用户印象' },
            { id: 'memory.style', label: '写作风格分析' },
            { id: 'memory.palace', label: '记忆宫殿整理' },
        ],
    },
] as const satisfies readonly WorldbookSceneCategory[];

type SceneCategoryTree = typeof WORLDBOOK_SCENE_CATEGORIES[number];
export type WorldbookSceneCategoryId = SceneCategoryTree['id'];
export type WorldbookSceneId = SceneCategoryTree['subs'][number]['id'];

/** scenes 字段的值：undefined / null = 所有场景，[] = 哪里都不生效。 */
export type WorldbookScenes = WorldbookEntryConfig['scenes'];

const CATEGORIES: readonly WorldbookSceneCategory[] = WORLDBOOK_SCENE_CATEGORIES;
const CATEGORY_BY_ID = new Map(CATEGORIES.map(category => [category.id, category]));
const SUB_BY_ID = new Map(CATEGORIES.flatMap(category => category.subs.map(sub => [sub.id, { sub, category }] as const)));

/** 子场景所属的分类 id（认不出的返回 undefined）。 */
export const worldbookSceneCategoryOf = (sceneId: string): WorldbookSceneCategoryId | undefined =>
    SUB_BY_ID.get(sceneId)?.category.id as WorldbookSceneCategoryId | undefined;

/** 只看 scenes 令牌本身：这个子场景是否被打开（不考虑 appManaged 豁免）。 */
export const isWorldbookSceneEnabled = (scenes: WorldbookScenes, sceneId: WorldbookSceneId): boolean => {
    if (scenes == null) return true;
    return scenes.includes(sceneId) || scenes.includes(worldbookSceneCategoryOf(sceneId) ?? '');
};

/** 外来文件（角色卡、世界书导入）里的 scenes：不是数组按所有场景，元素只留非空字符串，免得判定时报错。 */
export const sanitizeWorldbookScenes = (value: unknown): string[] | undefined => (Array.isArray(value)
    ? value.filter((token): token is string => typeof token === 'string' && token.trim() !== '').map(token => token.trim())
    : undefined);

/** 生成时的判定：这条世界书在这个场景里能不能用。appManaged 场景由 App 自己挑书，一律放行。 */
export const isWorldbookSceneAllowed = (
    book: Pick<WorldbookEntryConfig, 'scenes'>,
    scene: WorldbookSceneId,
): boolean => SUB_BY_ID.get(scene)?.sub.appManaged === true || isWorldbookSceneEnabled(book.scenes, scene);

/** scene 不传时原样返回（不筛）；传了就在关键词 / 概率之前把不属于这个场景的条目去掉。 */
export const filterWorldbooksForScene = <T extends Pick<WorldbookEntryConfig, 'scenes'>>(
    books: T[],
    scene?: WorldbookSceneId,
): T[] => (scene ? books.filter(book => isWorldbookSceneAllowed(book, scene)) : books);

// ─── 界面开关用的小工具：输入旧令牌、输出规整后的新令牌 ───

/** 收拢判定要求打开的子场景：appManaged 不受开关控制，不算在内；hidden 要算。 */
const requiredSubs = (category: WorldbookSceneCategory) => category.subs.filter(sub => !sub.appManaged);

/** 编辑面板里一类下的一行。 */
export interface WorldbookSceneRow {
    key: string;
    label: string;
    /** 摘要里的名字：「其他」单拎出来看不懂，带上分类名。 */
    summaryLabel: string;
    /** 这一行开关管的子场景；全开才算这一行开着。 */
    sceneIds: WorldbookSceneId[];
    /** 只列出、不给开关（见 WorldbookSceneSub.appManaged）。 */
    appManaged: boolean;
}

/**
 * 一类下的行：可见子场景各一行，隐藏子场景合成末尾一行「其他」。
 * 分类状态、摘要和编辑面板都按这份行表算，保证界面显示和实际生效对得上。
 */
export const getWorldbookSceneRows = (categoryId: WorldbookSceneCategoryId): WorldbookSceneRow[] => {
    const category = CATEGORY_BY_ID.get(categoryId)!;
    const rows: WorldbookSceneRow[] = category.subs.filter(sub => !sub.hidden).map(sub => ({
        key: sub.id, label: sub.label, summaryLabel: sub.label, sceneIds: [sub.id as WorldbookSceneId], appManaged: sub.appManaged === true,
    }));
    const hidden = category.subs.filter(sub => sub.hidden);
    if (hidden.length) rows.push({
        key: `${category.id}.other`, label: '其他', summaryLabel: `${category.label}·其他`,
        sceneIds: hidden.map(sub => sub.id as WorldbookSceneId), appManaged: false,
    });
    return rows;
};

export const isWorldbookSceneRowOn = (scenes: WorldbookScenes, row: WorldbookSceneRow): boolean =>
    row.sceneIds.every(id => isWorldbookSceneEnabled(scenes, id));

const switchRows = (categoryId: string) => getWorldbookSceneRows(categoryId as WorldbookSceneCategoryId).filter(row => !row.appManaged);

/**
 * 把令牌集合整理成规范形式：一个分类要求的子场景（含隐藏的）全开就收成分类令牌；
 * 所有分类都开就收成 undefined（= 所有场景）。认不出的令牌原样留着，避免旧版本改一下开关就把新版本写的令牌丢掉。
 */
export const normalizeWorldbookScenes = (tokens: Iterable<string>): string[] | undefined => {
    const set = new Set(tokens);
    const result: string[] = [];
    let allCategoriesOn = true;
    for (const category of CATEGORIES) {
        const required = requiredSubs(category);
        if (set.has(category.id) || required.every(sub => set.has(sub.id))) {
            result.push(category.id);
            continue;
        }
        allCategoriesOn = false;
        result.push(...category.subs.filter(sub => !sub.appManaged && set.has(sub.id)).map(sub => sub.id));
    }
    const unknown = [...set].filter(token => !CATEGORY_BY_ID.has(token) && !SUB_BY_ID.has(token));
    return allCategoriesOn ? undefined : [...result, ...unknown];
};

/** 把令牌展开成「当前登记过的子场景」集合（分类令牌展开成它现有的子场景），认不出的令牌保留。 */
const expandScenes = (scenes: WorldbookScenes): Set<string> => {
    if (scenes == null) return new Set(CATEGORIES.flatMap(category => category.subs.map(sub => sub.id)));
    const expanded = new Set<string>();
    for (const token of scenes) {
        const category = CATEGORY_BY_ID.get(token);
        if (category) category.subs.forEach(sub => expanded.add(sub.id));
        else expanded.add(token);
    }
    return expanded;
};

/** 打开 / 关闭子场景（一行「其他」一次管几个）。 */
export const setWorldbookScene = (
    scenes: WorldbookScenes,
    sceneIds: WorldbookSceneId | readonly WorldbookSceneId[],
    on: boolean,
): string[] | undefined => {
    const expanded = expandScenes(scenes);
    for (const id of ([] as WorldbookSceneId[]).concat(sceneIds)) {
        if (on) expanded.add(id); else expanded.delete(id);
    }
    return normalizeWorldbookScenes(expanded);
};

/** 整个分类全开（写分类令牌，覆盖以后新增的子场景）/ 全关。 */
export const setWorldbookSceneCategory = (
    scenes: WorldbookScenes,
    categoryId: WorldbookSceneCategoryId,
    on: boolean,
): string[] | undefined => {
    const category = CATEGORY_BY_ID.get(categoryId)!;
    const expanded = expandScenes(scenes);
    category.subs.forEach(sub => expanded.delete(sub.id));
    if (on) expanded.add(categoryId);
    return normalizeWorldbookScenes(expanded);
};

/** 顶层「全选开」写 undefined（= 所有场景，含以后新增的），「全选关」写 []。 */
export const setAllWorldbookScenes = (on: boolean): string[] | undefined => (on ? undefined : []);

/** 分类在界面上的状态，按有开关的行算（「其他」也算一行）。 */
export const getWorldbookSceneCategoryState = (
    scenes: WorldbookScenes,
    categoryId: WorldbookSceneCategoryId,
): 'all' | 'some' | 'none' => {
    const rows = switchRows(categoryId);
    const onCount = rows.filter(row => isWorldbookSceneRowOn(scenes, row)).length;
    return onCount === rows.length ? 'all' : onCount === 0 ? 'none' : 'some';
};

/**
 * 界面摘要（编辑页折叠行、条目列表角标用）：all = 所有场景；none = 一个开关都没开，
 * 只剩 appManaged 场景（如见面·剧情）在应用里手动勾选时还会用到；
 * 其余 some。分类整类开着且不多时列分类名，零散开了一两个时列场景名，再多只报个数。
 */
export const summarizeWorldbookScenes = (scenes: WorldbookScenes): { kind: 'all' | 'some' | 'none'; text: string } => {
    if (scenes == null) return { kind: 'all', text: '全部场景' };
    const onRows = CATEGORIES.flatMap(category => switchRows(category.id).filter(row => isWorldbookSceneRowOn(scenes, row)));
    if (onRows.length === 0) return { kind: 'none', text: WORLDBOOK_SCENE_NONE_TEXT };
    const states = CATEGORIES.map(category => ({
        category,
        state: getWorldbookSceneCategoryState(scenes, category.id as WorldbookSceneCategoryId),
    }));
    const fullLabels = states.filter(item => item.state === 'all').map(item => item.category.label);
    if (!states.some(item => item.state === 'some') && fullLabels.length <= 2) return { kind: 'some', text: fullLabels.join('、') };
    if (onRows.length <= 2) return { kind: 'some', text: onRows.map(row => row.summaryLabel).join('、') };
    return { kind: 'some', text: `已选 ${onRows.length} 个场景` };
};
