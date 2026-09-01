export type SARModulePool = 'variant' | 'story';
export type SARModuleAccent = 'blue' | 'red' | 'olive' | 'violet' | 'ivory' | 'graphite' | 'rose' | 'teal';

export type SARModuleDefinition = {
    id: string;
    pool: SARModulePool;
    title: string;
    group: string;
    summary: string;
    accent: SARModuleAccent;
    sigil: 'compass' | 'chain' | 'branch' | 'rose' | 'sun' | 'blade' | 'heart' | 'web';
    memory: string;
    routeTags?: string[];
};

export type SARGachaHistoryEntry = {
    id: string;
    moduleId: string;
    pool: SARModulePool;
    drawnAt: number;
};

export type SARGachaState = {
    version: 1;
    freeDrawDate: Partial<Record<SARModulePool, string>>;
    collection: Record<string, number>;
    history: SARGachaHistoryEntry[];
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const SAR_GACHA_STORAGE_KEY = 'vr_sar_gacha_state_v1';

export const DEFAULT_SAR_GACHA_STATE: SARGachaState = {
    version: 1,
    freeDrawDate: {},
    collection: {},
    history: [],
};

const ACCENTS: SARModuleAccent[] = ['blue', 'red', 'olive', 'violet', 'ivory', 'graphite', 'rose', 'teal'];
const SIGILS: SARModuleDefinition['sigil'][] = ['compass', 'chain', 'branch', 'rose', 'sun', 'blade', 'heart', 'web'];

const makeModule = (
    pool: SARModulePool,
    index: number,
    title: string,
    group: string,
    summary: string,
    memory: string,
    routeTags?: string[],
): SARModuleDefinition => ({
    id: `${pool}-${String(index + 1).padStart(2, '0')}`,
    pool,
    title,
    group,
    summary,
    memory,
    routeTags,
    accent: ACCENTS[index % ACCENTS.length],
    sigil: SIGILS[index % SIGILS.length],
});

const VARIANT_SOURCE: Array<[string, string, string]> = [
    ['未曾被你改变', '关系偏移', '一切照常发生，唯独你从未进入过 TA 的生命。'],
    ['记忆之外', '认知缺口', 'TA 记得世界，却找不到任何与你有关的证据。'],
    ['被你改变得太多', '关系偏移', '你留下的影响已经压过了 TA 原本的性格。'],
    ['不再需要你', '关系偏移', 'TA 已经学会独自完成过去只能与你一起完成的事。'],
    ['被你遗弃过', '关系偏移', '在这条分歧里，等待确实以你的缺席告终。'],
    ['没有伤口的人', '经历改写', '那件塑造 TA 的坏事从来没有发生。'],
    ['伤口从未愈合', '经历改写', '时间向前走了，伤口却留在最初的形状。'],
    ['已经得到一切', '欲望终点', 'TA 曾经追逐的东西都已握在手中。'],
    ['主动放弃', '欲望终点', 'TA 清醒地放下了曾经绝不肯让步的目标。'],
    ['成为了自己最讨厌的人', '信念断面', '为了抵达终点，TA 接受了曾经最厌恶的方式。'],
    ['最正确的 TA', '信念断面', '每次选择都符合原则，但正确没有让 TA 更幸福。'],
    ['被所有人喜欢的 TA', '社会投影', 'TA 成为了所有人期待的样子，只剩你看得出违和。'],
    ['信念尽头', '信念断面', '那套曾支撑 TA 的信念已经走到无法继续的地方。'],
    ['越过底线', '信念断面', 'TA 已经做过那件原本坚信自己永远不会做的事。'],
    ['不允许被定义', '自我认知', 'TA 拒绝接受设定、他人和过去给出的任何结论。'],
    ['最后一次相信', '关系偏移', 'TA 愿意再相信一次，但不会有下一次。'],
    ['只剩核心', '人格剥离', '身份、习惯与经历被逐层剥离，只留下不可让渡的部分。'],
    ['第二个自己', '人格映照', '另一个同样确信自己是本体的 TA 出现了。'],
    ['我只是模拟', '自我认知', 'TA 接受自己是一次推演，并重新衡量所有感受。'],
    ['我就是我', '自我认知', '无论诞生方式如何，TA 拒绝把自我交给外部证明。'],
    ['共享意识', '人格边界', 'TA 与另一个意识共享记忆，却无法共享全部意愿。'],
    ['已经知道结局', '因果知情', 'TA 知道这段关系会怎样结束，仍然抵达了你面前。'],
    ['很久以后的 TA', '时间切片', '漫长岁月之后，TA 带着你尚未经历的历史回来。'],
    ['回到很久以前', '时间切片', 'TA 回到了尚未成为如今自己的时期。'],
    ['走完结局之后', '时间切片', '故事已经结束，TA 却还要处理结局之后的生活。'],
];

export const SAR_VARIANT_MODULES: SARModuleDefinition[] = VARIANT_SOURCE.map(([title, group, summary], index) =>
    makeModule('variant', index, title, group, summary, '导演层保留关系记忆；是否承认、遗忘或隐瞒由人格推演决定。'),
);

const STORY_SOURCE: Array<[string, string, string, string[]]> = [
    ['敌对阵营', '阵营与冲突', '你们被世界分到冲突的两侧，公开立场无法调和。', ['对立', '跨世界']],
    ['追捕者', '阵营与冲突', '一方必须追捕另一方，而任务理由会随角色世界观翻译。', ['追逐', '身份']],
    ['监视任务', '阵营与冲突', '接近本身就是任务，真诚与观察逐渐纠缠。', ['潜伏', '秘密']],
    ['强制同盟', '阵营与冲突', '互不信任的两人只有合作才能离开当前危机。', ['合作', '危机']],
    ['学院 AU', '世界身份', '所有身份被映射进同一所学院，关系从新的秩序开始。', ['日常', '身份映射']],
    ['企业战争', '世界身份', '你们分别属于彼此竞争的组织，选择会改变资源与立场。', ['职场', '博弈']],
    ['MMO 公会战争', '世界身份', '现实关系被投射进大型线上世界的公会冲突。', ['游戏世界', '群像']],
    ['末日聚落', '世界身份', '资源稀缺的聚落迫使每段关系都承担生存成本。', ['末日', '生存']],
    ['被困孤岛', '封闭空间', '有限环境放大日常习惯、分工与无法回避的矛盾。', ['孤岛', '生存']],
    ['暴雪旅馆', '封闭空间', '道路封闭，旅馆里的人和秘密都暂时无处可去。', ['暴雪', '悬疑']],
    ['循环末班车', '封闭空间', '末班车不断返回起点，只有你们察觉到重复。', ['循环', '都市怪谈']],
    ['封锁空间站', '封闭空间', '故障与封锁切断退路，每次修复都暴露新的异常。', ['科幻', '封锁']],
    ['无法说谎', '世界规则', '所有表达必须真实，但沉默、误解和自欺仍然存在。', ['规则', '真相']],
    ['真名契约', '世界规则', '知晓真名会形成约束，交换称呼等同交换信任。', ['契约', '身份']],
    ['关系到期', '世界规则', '你们的关系拥有明确倒计时，到期后的结果未知。', ['倒计时', '关系']],
    ['情绪显形', '世界规则', '无法说出口的情绪会在环境中留下可见痕迹。', ['情绪', '可视化']],
    ['同日循环', '时间与因果', '同一天不断重置，只有关系变化会留下微弱残响。', ['时间循环', '残响']],
    ['未来来信', '时间与因果', '来自未来的信件持续抵达，却未必来自同一条结局。', ['书信', '未来']],
    ['时间流速差', '时间与因果', '一次短暂离开，对另一方可能已经过去很多年。', ['时间差', '重逢']],
    ['被删除的一天', '时间与因果', '所有记录都缺失同一天，身体与关系却保留后果。', ['失忆', '调查']],
    ['临时伴侣', '任务与关系', '制度或任务要求你们暂时扮演亲密关系。', ['伪装', '关系']],
    ['护送任务', '任务与关系', '一方负责让另一方安全抵达，而目的地会改变一切。', ['旅途', '保护']],
    ['共同盗取', '任务与关系', '你们必须从严密秩序中取走同一件东西。', ['潜入', '共犯']],
    ['只能离开一个', '任务与关系', '出口只承认一个人，规则逼迫你们定义谁该留下。', ['抉择', '封闭结局']],
];

export const SAR_STORY_MODULES: SARModuleDefinition[] = STORY_SOURCE.map(([title, group, summary, routeTags], index) =>
    makeModule('story', index, title, group, summary, '导演层保留完整关系记忆；剧情世界决定角色如何表现自己知道这些事。', routeTags),
);

export const SAR_ALL_MODULES = [...SAR_VARIANT_MODULES, ...SAR_STORY_MODULES];

export const getSARModules = (pool: SARModulePool) => pool === 'variant' ? SAR_VARIANT_MODULES : SAR_STORY_MODULES;

export const getSARModuleById = (id: string) => SAR_ALL_MODULES.find(module => module.id === id);

export const getSARLocalDayKey = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

export const readSARGachaState = (storage?: StorageLike): SARGachaState => {
    try {
        const raw = (storage || localStorage).getItem(SAR_GACHA_STORAGE_KEY);
        if (!raw) return { ...DEFAULT_SAR_GACHA_STATE, freeDrawDate: {}, collection: {}, history: [] };
        const parsed = JSON.parse(raw) as Partial<SARGachaState>;
        const collection = parsed.collection && typeof parsed.collection === 'object'
            ? Object.fromEntries(Object.entries(parsed.collection).filter(([, count]) => Number.isFinite(count) && Number(count) > 0).map(([id, count]) => [id, Math.floor(Number(count))]))
            : {};
        return {
            version: 1,
            freeDrawDate: parsed.freeDrawDate && typeof parsed.freeDrawDate === 'object' ? parsed.freeDrawDate : {},
            collection,
            history: Array.isArray(parsed.history)
                ? parsed.history.filter(entry => entry && typeof entry.moduleId === 'string' && (entry.pool === 'variant' || entry.pool === 'story')).slice(0, 60)
                : [],
        };
    } catch {
        return { ...DEFAULT_SAR_GACHA_STATE, freeDrawDate: {}, collection: {}, history: [] };
    }
};

export const writeSARGachaState = (state: SARGachaState, storage?: StorageLike) => {
    try { (storage || localStorage).setItem(SAR_GACHA_STORAGE_KEY, JSON.stringify(state)); } catch { /* 私密浏览或存储已满时仅保留当前会话 */ }
    return state;
};

export const isSARFreeDrawAvailable = (pool: SARModulePool, state: SARGachaState, date = new Date()) =>
    state.freeDrawDate[pool] !== getSARLocalDayKey(date);

export type SARGachaDrawResult =
    | { ok: true; module: SARModuleDefinition; state: SARGachaState; firstCopy: boolean }
    | { ok: false; reason: 'daily-used'; state: SARGachaState };

export const drawSARModule = (
    pool: SARModulePool,
    storage?: StorageLike,
    date = new Date(),
    random: () => number = Math.random,
): SARGachaDrawResult => {
    const current = readSARGachaState(storage);
    if (!isSARFreeDrawAvailable(pool, current, date)) return { ok: false, reason: 'daily-used', state: current };

    const modules = getSARModules(pool);
    const roll = Math.min(Math.max(random(), 0), 0.999999999);
    const module = modules[Math.floor(roll * modules.length)];
    const previousCount = current.collection[module.id] || 0;
    const next: SARGachaState = {
        version: 1,
        freeDrawDate: { ...current.freeDrawDate, [pool]: getSARLocalDayKey(date) },
        collection: { ...current.collection, [module.id]: previousCount + 1 },
        history: [{
            id: `draw_${date.getTime().toString(36)}_${module.id}`,
            moduleId: module.id,
            pool,
            drawnAt: date.getTime(),
        }, ...current.history].slice(0, 60),
    };
    writeSARGachaState(next, storage);
    return { ok: true, module, state: next, firstCopy: previousCount === 0 };
};

