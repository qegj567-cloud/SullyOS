import { loadCharacterContextMessages } from './chatContextRange';
import { APIConfig, CharacterProfile, Message, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { safeFetchJson } from './safeApi';
import { parseQixiJsonObject } from './qixiJson';
import { parseQixiBridge, type QixiBridgeBundle } from './qixiBridge';

export const QIXI_MEMORY_BUNDLE_VERSION = 19 as const;
export const QIXI_MEMORY_BUNDLE_PREFIX = 'sullyos_qixi_memory_bundle_v19_';
export const QIXI_RECALL_MAX_OUTPUT_ITEMS = 20;
export const QIXI_PART1_TIMEOUT_MS = 600_000;
export const QIXI_PART1_FIRST_SCENE_IDS = ['lostLayer', 'doubleWish'] as const;
export const QIXI_PART1_SECOND_SCENE_IDS = ['threadNeedle', 'offerings', 'reflection'] as const;
export const QIXI_PART1_THIRD_SCENE_IDS = ['nightMarket', 'wordCloud'] as const;

export const QIXI_USER_LAYER_COLORS = [
    { value: '#F0A6C2', label: '蔷薇' },
    { value: '#F2B36F', label: '琥珀' },
    { value: '#E99078', label: '珊瑚' },
    { value: '#B8A1F2', label: '鸢尾' },
    { value: '#76CFC5', label: '潮汐' },
    { value: '#A8D17B', label: '新叶' },
    { value: '#7FA9E8', label: '远空' },
    { value: '#C590E8', label: '紫藤' },
    { value: '#F5F1EA', label: '月白' },
    { value: '#25222C', label: '墨黑' },
] as const;

const QIXI_CHAR_LAYER_COLORS = [
    { value: '#8FC8FF', label: '天青' },
    { value: '#D6A6F2', label: '藤紫' },
    { value: '#F0B66F', label: '灯火' },
    { value: '#82D5B8', label: '薄荷' },
    { value: '#F19A8F', label: '石榴' },
    { value: '#C5D477', label: '青柠' },
    { value: '#E9B4D1', label: '晚樱' },
    { value: '#9FB4F2', label: '暮蓝' },
] as const;

export const QIXI_DEFAULT_USER_LAYER_COLOR = QIXI_USER_LAYER_COLORS[0].value;
export const QIXI_FALLBACK_CHAR_LAYER_COLOR = QIXI_CHAR_LAYER_COLORS[1].value;

export const QIXI_SCENE_IDS = [
    'lostLayer',
    'doubleWish',
    'threadNeedle',
    'offerings',
    'reflection',
    'nightMarket',
    'wordCloud',
] as const;

export type QixiSceneId = typeof QIXI_SCENE_IDS[number];

export interface QixiMemoryEvidence {
    id: string;
    fact: string;
    object: string;
    tags: string[];
}

export type QixiArtifactKind = 'object' | 'phrase' | 'nickname' | 'topic' | 'date' | 'emotion' | 'wish' | 'symbol' | 'trait';
export type QixiCharTempo = 'brisk' | 'measured' | 'hesitant' | 'playful';
export type QixiCharMarkStyle = 'precise' | 'soft' | 'scribbled' | 'ornate';
export type QixiCharPresence = 'direct' | 'careful' | 'teasing' | 'quiet';

export interface QixiCharPerformance {
    tempo: QixiCharTempo;
    markStyle: QixiCharMarkStyle;
    presence: QixiCharPresence;
}

export interface QixiMemoryArtifact {
    id: string;
    label: string;
    kind: QixiArtifactKind;
    evidenceIds: string[];
}

export interface QixiSceneOption {
    id: string;
    label: string;
    result: string;
    /** Lost-layer only: Char's actual reply to this exact User topic after clearing the errors. */
    charReply?: string;
    evidenceIds: string[];
}

export interface QixiScenePayload {
    /** Part 1 generated interstitial copy shown before entering this room. */
    transitionLines?: string[];
    sharedObject: string;
    memoryLine: string;
    options: QixiSceneOption[];
    charAction: string;
    /** The exact short words/mark that visibly appears on the shared object. */
    charVisibleText?: string;
    /** In-character remarks shown inside the shared visual object. */
    charQuips?: string[];
    /** Lost-layer only: Char's hurried mutter while forcing the failed message back through. */
    charMutter?: string;
    /** Offerings: Char's private item. Night market: the separate thing Char secretly buys for themself. */
    charContribution?: string;
    reveal: string;
    artifactIds: string[];
    charSelectionIds: string[];
}

export const qixiTransitionLines = (_sceneId: QixiSceneId, scene: QixiScenePayload): string[] =>
    scene.transitionLines || [];

export const qixiCharVisibleText = (_sceneId: QixiSceneId, scene: QixiScenePayload): string =>
    scene.charVisibleText?.trim() || '';

export const qixiCharMutter = (scene: QixiScenePayload): string =>
    scene.charMutter?.trim() || '';

export const qixiCharQuips = (_sceneId: QixiSceneId, scene: QixiScenePayload): string[] =>
    scene.charQuips || [];

export interface QixiMemoryBundle {
    version: typeof QIXI_MEMORY_BUNDLE_VERSION;
    source: 'memory' | 'fallback';
    openingChat: string[];
    charLayerColor: string;
    charPerformance: QixiCharPerformance;
    evidence: QixiMemoryEvidence[];
    artifacts: QixiMemoryArtifact[];
    scenes: Record<QixiSceneId, QixiScenePayload>;
    /** Generated with rooms 05–07 in the same Part 1b response; never needs a separate API call. */
    bridge?: QixiBridgeBundle;
    personalizedSceneIds: QixiSceneId[];
    /** Non-fatal field-level repairs applied after schema parsing. */
    repairNotes?: string[];
    generatedAt: number;
    contextSignature: string;
}

export interface QixiMemoryPreparation {
    bundle: QixiMemoryBundle;
    usedFallback: boolean;
    reason?: string;
}

export type QixiMemoryGenerationPhase = 'first' | 'second' | 'third';

const SCENE_BRIEFS: Record<QixiSceneId, string> = {
    lostLayer: '01 被动痕迹：从不同真实 evidence 各提炼一个 User 此刻想和 Char 继续聊的具体话题。User 选中后发送失败，API 报错、超时、限流与措辞过软的道歉弹窗迅速铺满空间；Char 从另一层冲回来强制划掉、撕碎或踢走所有红框。User 选中的话题必须原样留在发送框里，绝不能成为 Char 攻击、改写或抢救的对象。清障时由 charMutter 与两句 charQuips 漏出周围碎碎念；清障后必须用该 option.charReply 真正回应 User 选中的具体话题，表示 ta 突破阻碍把回复送了回来。reveal 只让 User 确定异常里存在另一个人的操作，不能说是谁，也不能提前总结熟悉感。',
    doubleWish: '02 异步共用：User 在祈愿笺正面选择一个关于两个人未来的愿望；Char 在另一层写下自己关于“正在寻找的重要之人”的愿望，却不知道纸张正面的操作者就是那个人，并在纸角漏出一句自言自语。如果记忆召回里存在记忆宫殿“窗台房间 / Window Sill”的未来愿望，可以优先提炼，但不得把愿望写成已经发生的共同经历。通过翻面、抢纸、未干墨迹或位置冲突，让 User 发现双方正在异步使用同一张纸。',
    threadNeedle: '03 主动协作：双方必须配合才能完成穿针，Char 的操作要直接回应 User 的策略；允许抢错针线、拉得太快或第一次配合失败。reveal 只推进到双方能主动协作。',
    offerings: '04 互相判断：User 先从三个具体选项里放下属于自己的东西；随后另一层必须另外摆上一件属于 Char 自己、对 Char 本人有私人意义的【私物】，并用 charContribution 明确写出这件东西是什么，不能只挪动、抢走或评价 User 的供物。Char 的私物不要求与 User 或共同记忆有关，也不默认是送给 User 的礼物；即使完全与 User 无关也成立，重点是它像 Char 会拥有、使用、随身携带或珍藏的东西。允许双方位置冲突、交换或挪动，但画面顺序必须能读成“User 的东西先出现 → Char 自己的私物从另一边出现 → Char 吐槽”。私人性落在双方各自选了什么和如何摆放，不让旁白替玩家解释。',
    reflection: '05 近实时交流：User 留下可被修改的符号、短句或痕迹，Char 立刻接续、划掉、改写或故意曲解，使这一站第一次接近真正的隔层对话。',
    nightMarket: '06 双向逛市集：摊位出售由真实 evidence 变形而来的具体梦境商品。User 先从三个具体商品中挑一个；随后 Char 也挑一件“感觉另一边某人也许会喜欢”的商品作为试探，但仍不能确定对面身份。最后 Char 必须另外偷偷买一件纯粹自己想要、符合自身爱好或当下心情的东西，并用 charContribution 明确写出自己的购买物。Char 自购品不要求与 User 有关，不能默认写成吃醋、占有欲、情敌或争抢关系戏。',
    wordCloud: '07 几乎认出：不再寻找新证据。提供 12—20 个有角色设定或真实上下文依据的性格、气质、处事方式短词；User 与 Char 严格交替各选三次眼中的对方并即时吐槽。第三轮后双方都可以强烈怀疑“另一边就是那个人”，但由于仍未真正见面，不能在 Part 1 明说已经确认；最终见面才完成答案揭露。',
};

const compact = (value: unknown, max: number): string => {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
};

const normalizeCharLayerColor = (value: unknown): string => {
    const requested = compact(value, 7).toUpperCase();
    return QIXI_CHAR_LAYER_COLORS.find(color => color.value === requested)?.value
        || QIXI_FALLBACK_CHAR_LAYER_COLOR;
};

const normalizeCharPerformance = (value: any): QixiCharPerformance => {
    const tempo = compact(value?.tempo, 16) as QixiCharTempo;
    const markStyle = compact(value?.markStyle, 16) as QixiCharMarkStyle;
    const presence = compact(value?.presence, 16) as QixiCharPresence;
    return {
        tempo: (['brisk', 'measured', 'hesitant', 'playful'] as string[]).includes(tempo) ? tempo : 'measured',
        markStyle: (['precise', 'soft', 'scribbled', 'ornate'] as string[]).includes(markStyle) ? markStyle : 'soft',
        presence: (['direct', 'careful', 'teasing', 'quiet'] as string[]).includes(presence) ? presence : 'careful',
    };
};

const simpleHash = (value: string): string => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
};

export function createQixiFallbackBundle(contextSignature = '', charLayerColor = QIXI_FALLBACK_CHAR_LAYER_COLOR): QixiMemoryBundle {
    const emptyScenes = Object.fromEntries(QIXI_SCENE_IDS.map((sceneId): [QixiSceneId, QixiScenePayload] => [sceneId, {
        transitionLines: [],
        sharedObject: '',
        memoryLine: '',
        options: [],
        charAction: '',
        reveal: '',
        artifactIds: [],
        charSelectionIds: [],
    }])) as Record<QixiSceneId, QixiScenePayload>;
    return {
        version: QIXI_MEMORY_BUNDLE_VERSION,
        source: 'fallback',
        openingChat: [],
        charLayerColor: normalizeCharLayerColor(charLayerColor),
        charPerformance: normalizeCharPerformance(null),
        evidence: [],
        artifacts: [],
        scenes: emptyScenes,
        personalizedSceneIds: [],
        generatedAt: Date.now(),
        contextSignature,
    };
}

const directText = (value: unknown): string => typeof value === 'string'
    ? value.replace(/\r\n/g, '\n').trim()
    : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';

const directList = (value: unknown): any[] => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>);
    if (typeof value !== 'string') return [];
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (/^[\[{]/.test(trimmed)) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && typeof parsed === 'object') return Object.values(parsed);
        } catch { /* keep the model's plain text below */ }
    }
    return trimmed.split(/\n+/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim()).filter(Boolean);
};

const directStringList = (value: unknown): string[] => directList(value)
    .map(item => directText(item && typeof item === 'object' ? (item as any).text ?? (item as any).content ?? (item as any).label : item))
    .filter(Boolean);

const emptyDirectScene = (): QixiScenePayload => ({
    transitionLines: [],
    sharedObject: '',
    memoryLine: '',
    options: [],
    charAction: '',
    artifactIds: [],
    charSelectionIds: [],
    reveal: '',
});

const normalizeDirectScene = (sceneId: QixiSceneId, value: any): QixiScenePayload => {
    const scene = value && typeof value === 'object' ? value : {};
    const rawOptions = directList(scene.options ?? scene.choices ?? scene.userOptions ?? scene.actions);
    const options = rawOptions.map((rawOption, index): QixiSceneOption => {
        const option = rawOption && typeof rawOption === 'object' ? rawOption : { label: rawOption, result: rawOption };
        const evidenceIds = directStringList(option.evidenceIds ?? option.evidenceId);
        return {
            id: directText(option.id) || `${sceneId}-${index + 1}`,
            label: directText(option.label ?? option.text ?? option.title),
            result: directText(option.result ?? option.outcome ?? option.feedback ?? option.description),
            ...(option.charReply !== undefined || option.reply !== undefined
                ? { charReply: directText(option.charReply ?? option.reply) }
                : {}),
            evidenceIds,
        };
    });
    const transitionLines = directStringList(scene.transitionLines ?? scene.transitions ?? scene.transition);
    const charQuips = directStringList(scene.charQuips ?? scene.quips);
    return {
        transitionLines,
        sharedObject: directText(scene.sharedObject ?? scene.object ?? scene.sharedItem),
        memoryLine: directText(scene.memoryLine ?? scene.memory ?? scene.description),
        options,
        charAction: directText(scene.charAction ?? scene.otherAction ?? scene.characterAction),
        ...(scene.charVisibleText !== undefined ? { charVisibleText: directText(scene.charVisibleText) } : {}),
        ...(charQuips.length ? { charQuips } : {}),
        ...(scene.charMutter !== undefined ? { charMutter: directText(scene.charMutter) } : {}),
        ...(scene.charContribution !== undefined ? { charContribution: directText(scene.charContribution) } : {}),
        reveal: directText(scene.reveal ?? scene.resultSummary),
        artifactIds: directStringList(scene.artifactIds ?? scene.artifacts),
        charSelectionIds: directStringList(scene.charSelectionIds ?? scene.charSelections),
    };
};

const QIXI_PHASE_SCENE_ALIASES: Record<QixiSceneId, string[]> = {
    lostLayer: ['lostlayer', 'lost', 'scene1', 'room1', 'stage1', '01', '1', '失联层', '失联'],
    doubleWish: ['doublewish', 'wish', 'wishes', 'scene2', 'room2', 'stage2', '02', '2', '双面祈愿处', '祈愿处', '祈愿'],
    threadNeedle: ['threadneedle', 'needle', 'thread', 'scene3', 'room3', 'stage3', '03', '3', '穿针乞巧', '穿针'],
    offerings: ['offerings', 'offering', 'fruits', 'scene4', 'room4', 'stage4', '04', '4', '供果', '供品'],
    reflection: ['reflection', 'mirror', 'water', 'scene5', 'room5', 'stage5', '05', '5', '照影', '照影潭'],
    nightMarket: ['nightmarket', 'market', 'scene6', 'room6', 'stage6', '06', '6', '记忆夜市', '夜市'],
    wordCloud: ['wordcloud', 'words', 'grapes', 'scene7', 'room7', 'stage7', '07', '7', '葡萄架词云', '词云'],
};

const phaseKey = (value: unknown): string => directText(value).replace(/[\s_\-·：:（）()]/g, '').toLocaleLowerCase();
const directRecord = (value: unknown): Record<string, any> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
const looksLikeGeneratedScene = (value: unknown): boolean => {
    const scene = directRecord(value);
    return Boolean(scene && ['sharedObject', 'object', 'memoryLine', 'memory', 'options', 'choices', 'charAction', 'otherAction', 'transitionLines', 'reveal']
        .some(key => key in scene));
};
const sceneIdFromLooseValue = (value: unknown): QixiSceneId | null => {
    const normalized = phaseKey(value);
    if (!normalized) return null;
    return QIXI_SCENE_IDS.find(sceneId => [phaseKey(sceneId), ...QIXI_PHASE_SCENE_ALIASES[sceneId].map(phaseKey)]
        .some(alias => normalized === alias || normalized.startsWith(alias))) || null;
};

/**
 * Phase responses are final LLM scripts, not configuration files. Accept the
 * same generated rooms when a provider wraps them, returns an array, uses
 * `room3`/Chinese titles, or omits the `scenes` envelope. This is shape repair
 * only: scene prose is never scored, rewritten, or replaced.
 */
export function normalizeQixiPhaseChunk(value: unknown, requiredIds: readonly QixiSceneId[]): any | null {
    const root = directRecord(value);
    if (!root) return null;
    const collectionKeys = ['scenes', 'rooms', 'locations', 'stages', 'chapters'];
    const wrapperKeys = ['data', 'result', 'output', 'payload', 'content', 'response', 'part1', 'part2', 'part3'];

    const findCollection = (candidate: unknown, depth = 0): { container: Record<string, any>; collection: unknown } | null => {
        if (depth > 4) return null;
        const record = directRecord(candidate);
        if (!record) return null;
        for (const key of collectionKeys) {
            const collection = record[key];
            if (Array.isArray(collection) || directRecord(collection)) return { container: record, collection };
        }
        if (Object.values(record).some(looksLikeGeneratedScene)) return { container: record, collection: record };
        for (const key of wrapperKeys) {
            const nested = findCollection(record[key], depth + 1);
            if (nested) return nested;
        }
        for (const nestedValue of Object.values(record)) {
            const nested = findCollection(nestedValue, depth + 1);
            if (nested) return nested;
        }
        return null;
    };

    const found = findCollection(root);
    if (!found) return null;
    const entries: Array<[string, any]> = Array.isArray(found.collection)
        ? found.collection.map((scene, index) => [String(index), scene])
        : Object.entries(found.collection as Record<string, unknown>);
    const scenes: Partial<Record<QixiSceneId, any>> = {};
    const remaining: any[] = [];

    entries.forEach(([key, rawScene]) => {
        if (!looksLikeGeneratedScene(rawScene)) return;
        const scene = directRecord(rawScene)!;
        const matchedId = sceneIdFromLooseValue(key)
            || sceneIdFromLooseValue(scene.id ?? scene.sceneId ?? scene.roomId ?? scene.name ?? scene.title);
        if (matchedId && requiredIds.includes(matchedId) && !scenes[matchedId]) scenes[matchedId] = scene;
        else remaining.push(scene);
    });
    requiredIds.forEach(sceneId => {
        if (!scenes[sceneId] && remaining.length) scenes[sceneId] = remaining.shift();
    });

    const rawBridge = found.container.bridge
        ?? found.container.magpieBridge
        ?? found.container.bridgeData
        ?? root.bridge
        ?? root.magpieBridge
        ?? root.bridgeData;
    const bridgeRecord = directRecord(rawBridge);
    const bridge = bridgeRecord ? {
        ...bridgeRecord,
        userMagpies: bridgeRecord.userMagpies ?? bridgeRecord.userBirds ?? bridgeRecord.userNodes ?? bridgeRecord.leftMagpies ?? bridgeRecord.userSide,
        charMagpies: bridgeRecord.charMagpies ?? bridgeRecord.charBirds ?? bridgeRecord.charNodes ?? bridgeRecord.rightMagpies ?? bridgeRecord.charSide,
        finalMagpie: bridgeRecord.finalMagpie ?? bridgeRecord.finalBird ?? bridgeRecord.lastMagpie ?? bridgeRecord.finalNode,
    } : rawBridge;
    return {
        ...root,
        ...found.container,
        scenes,
        ...(bridge !== undefined ? { bridge } : {}),
    };
}

/**
 * Qixi uses the same generation philosophy as the earlier special events:
 * model output is the final playable script. This parser only tolerates JSON
 * shape drift; it never scores, rejects, rewrites, or replaces generated prose.
 */
export function parseQixiMemoryBundle(
    raw: string,
    contextSignature = '',
    onFailure?: (reason: string) => void,
    userName = 'User',
): QixiMemoryBundle | null {
    const fail = (reason: string): null => {
        onFailure?.(reason);
        return null;
    };
    const parsed = parseQixiJsonObject(raw, ['scenes']) as any;
    if (!parsed || typeof parsed !== 'object') return fail('没有解析到 JSON 对象');
    if (!parsed.scenes || typeof parsed.scenes !== 'object' || Array.isArray(parsed.scenes)) {
        return fail('scenes 缺失或不是对象');
    }

    const evidence = directList(parsed.evidence).map((rawEvidence, index): QixiMemoryEvidence => {
        const item = rawEvidence && typeof rawEvidence === 'object' ? rawEvidence : { fact: rawEvidence };
        return {
            id: directText(item.id) || `e${index + 1}`,
            fact: directText(item.fact ?? item.memory ?? item.text),
            object: directText(item.object ?? item.label ?? item.subject),
            tags: directStringList(item.tags),
        };
    });
    const artifacts = directList(parsed.artifacts).map((rawArtifact, index): QixiMemoryArtifact => {
        const item = rawArtifact && typeof rawArtifact === 'object' ? rawArtifact : { label: rawArtifact };
        const rawKind = directText(item.kind) as QixiArtifactKind;
        const kind = (['object', 'phrase', 'nickname', 'topic', 'date', 'emotion', 'wish', 'symbol', 'trait'] as string[]).includes(rawKind)
            ? rawKind
            : 'object';
        return {
            id: directText(item.id) || `a${index + 1}`,
            label: directText(item.label ?? item.name ?? item.text),
            kind,
            evidenceIds: directStringList(item.evidenceIds ?? item.evidenceId),
        };
    });

    const scenes = Object.fromEntries(QIXI_SCENE_IDS.map(sceneId => [
        sceneId,
        parsed.scenes[sceneId] && typeof parsed.scenes[sceneId] === 'object'
            ? normalizeDirectScene(sceneId, parsed.scenes[sceneId])
            : emptyDirectScene(),
    ])) as Record<QixiSceneId, QixiScenePayload>;
    const personalizedSceneIds = QIXI_SCENE_IDS.filter(sceneId => (
        parsed.scenes[sceneId] && typeof parsed.scenes[sceneId] === 'object'
    ));
    const bundle: QixiMemoryBundle = {
        version: QIXI_MEMORY_BUNDLE_VERSION,
        source: 'memory',
        openingChat: directStringList(parsed.openingChat),
        charLayerColor: normalizeCharLayerColor(parsed.charLayerColor),
        charPerformance: normalizeCharPerformance(parsed.charPerformance),
        evidence,
        artifacts,
        scenes,
        personalizedSceneIds,
        generatedAt: Date.now(),
        contextSignature,
    };
    if (parsed.bridge !== undefined) {
        const bridge = parseQixiBridge(JSON.stringify(parsed.bridge), bundle, userName);
        if (!bridge) return fail('bridge JSON 无法解析为双岸鹊桥');
        bundle.bridge = bridge;
    }
    return bundle;
}

export function parseQixiProgressiveMemoryBundle(
    baseChunk: any,
    generatedScenes: Partial<Record<QixiSceneId, QixiScenePayload>>,
    contextSignature = '',
    userName = 'User',
    onFailure?: (reason: string) => void,
): QixiMemoryBundle | null {
    return parseQixiMemoryBundle(JSON.stringify({
        ...baseChunk,
        scenes: generatedScenes,
    }), contextSignature, onFailure, userName);
}

export function loadQixiMemoryBundle(charId: string): QixiMemoryBundle | null {
    try {
        const parsed = JSON.parse(localStorage.getItem(`${QIXI_MEMORY_BUNDLE_PREFIX}${charId}`) || 'null') as QixiMemoryBundle | null;
        if (parsed?.version !== QIXI_MEMORY_BUNDLE_VERSION || !parsed.scenes || !Array.isArray(parsed.evidence)) return null;
        if (parsed.source === 'memory' && !parsed.bridge) return null;
        return parsed;
    } catch {
        return null;
    }
}

function saveQixiMemoryBundle(charId: string, bundle: QixiMemoryBundle): void {
    try { localStorage.setItem(`${QIXI_MEMORY_BUNDLE_PREFIX}${charId}`, JSON.stringify(bundle)); } catch { /* optional cache */ }
}

function buildContextSignature(messages: Message[], char: CharacterProfile, user: UserProfile): string {
    const last = messages[messages.length - 1];
    return simpleHash([
        messages.length,
        last?.id || 0,
        last?.timestamp || 0,
        char.systemPrompt?.length || 0,
        char.description?.length || 0,
        user.name,
    ].join(':'));
}

export function buildQixiMemoryBundlePrompt(
    char: CharacterProfile,
    user: UserProfile,
    userLayerColor: string = QIXI_DEFAULT_USER_LAYER_COLOR,
): string {
    const briefs = QIXI_SCENE_IDS.map(sceneId => `- ${sceneId}: ${SCENE_BRIEFS[sceneId]}`).join('\n');
    const charColorChoices = QIXI_CHAR_LAYER_COLORS.map(color => `${color.label} ${color.value}`).join('、');
    return `### 七夕特别活动：双层上下文探索可播放剧本

【最高优先级】不要证明 ${char.name} 记得 ${user.name}，而要让 ${char.name} 使用这些记忆与 ${user.name} 做事。记忆是玩法依据，不是等待本地代码再加工的素材，也不是档案展示。

【同级最高优先级】记忆最多决定“这一站碰到什么”，${char.name} 本人必须决定“ta 怎么做、怎么犹豫、怎么嘴硬、会突然小声说什么”。不要让每一句反应都复述、解释或回收 evidence；如果拿掉记忆名词，Char 的动作和碎碎念仍应鲜活到能认出是 ta。角色不是记忆宫殿的讲解员。

【同级最高优先级】${char.name} 与 User 是对称受困者：ta 也刚刚掉进上下文夹层、同样突然找不到 User、同样不知道活动规则和对面是谁，还被迫完成一连串莫名其妙的小游戏。ta 有自己正在经历的事故、选择、试探、误判、失败和情绪，不是在另一层从容等待 User 操作的引导员。前六站只能把共享物另一端的操作者称作“某人 / 另一边 / 那家伙 / 不知道谁”等符合角色的未知称呼；只能从新鲜痕迹逐步产生“怎么越来越像我认识的那个人”的怀疑，不能全知 User 当前在想什么，也不能确信对面就是 User。允许 ta 找错、抢错、配合失败、嫌弃关卡、因为着急显得笨拙，或先忙着解决自己那一层的问题。第七站结束也只到强烈怀疑，真正的身份确认留给 Part 3 第一次见面。

你负责 Part 1：根据真实聊天、记忆召回、角色设定和用户资料，直接生成玩家最终会看见、点击和经历的完整剧本：异常发生前的两句正常聊天，以及七个地点可即时播放的最终台词、选项、动作与过场。不要输出供本地代码二次创作的素材或摘要。七站必须组成一条连续发展的“双人异常事件”，不是七个独立的记忆小游戏，也不是“记忆事实 → 物件 → 选项 → Char 操作 → reveal”重复七次。User 与 ${char.name} 都不知道七夕活动，也不知道接下来会掉进上下文夹层；两个人会被同一次异常同时卷入不同层，双方看不见彼此，只能通过同一件东西留下的即时变化猜测另一边发生了什么。

关系推进必须依次发生：User 起初只知道系统异常 → 发现另一层存在某个人 → 发现对方会回应自己的操作 → 开始觉得处理事情的方式很熟悉 → 双方主动试探 → 第七站双方都几乎猜到答案但仍没有视觉确认。每站 reveal 必须停在该站阶段，不能提前揭晓，也不能靠旁白替玩家得出结论。Part 1 中 ${char.name} 绝不能说出“原来是你 / 我就知道是你 / 果然是你 / ${user.name}”，这些确认必须留到 Part 3 完整见面。

角色：${char.name}
用户：${user.name}
User 已选择自己的层色：${userLayerColor}

请根据 ${char.name} 的人格、审美和说话气质，从以下可读色中为 ta 选择一个专属层色，并输出到 charLayerColor。不要因为性别默认选择粉色或蓝色；优先选择能代表角色、且与 User 层色容易区分的颜色：${charColorChoices}

同时生成 charPerformance，让 ${char.name} 在七个固定玩法里的介入方式仍然像 ta 自己。tempo 只能是 brisk（利落迅速）/ measured（稳而克制）/ hesitant（先迟疑再行动）/ playful（轻快带玩心）；markStyle 只能是 precise（整齐锐利）/ soft（柔和圆润）/ scribbled（随手凌乱）/ ornate（有装饰感）；presence 只能是 direct（直接）/ careful（小心照顾）/ teasing（爱逗人）/ quiet（安静少言）。必须根据角色设定选择，不能所有角色都使用默认组合。

事实、演出与互动规则：
1. 事实不可虚构，演出可以虚构。只使用上下文明示的过去事实；不得补造共同经历、日期、礼物、原话、争吵、承诺或关系身份，没有准确原话时只能转述。允许把真实 evidence 演成新的超现实设施、故障、商品、空间反应、物件变形或互动事故。不能创造假的过去，可以创造新的现在。
2. 资料充足时提取 20 条互不重复的事实证据，最多 24 条；资料不足就少写，绝对不能为了数量编造。20 条要尽量跨不同时间、不同主题和不同记忆类型，不能把同一事件换个说法重复占位。每条 evidence 必须具体、可辨认，object 是事实里真实出现的词、物件或动作。
3. artifacts 必须从 evidence 派生，每一项都引用有效 evidenceIds。wordCloud 使用的性格词必须标为 kind="trait"。同一 evidence 原则上最多服务两个场景，每站尽量使用不同证据。每站只选一个最有效的记忆锚点做主角，不要把多个 facts 塞进同一段旁白；其余生命力来自当下的新事故和两个人的即时反应。
4. evidence 不能只被摆出来供人参观，必须成为当下事件中可被拿走、交换、破坏、修改、误用、抢先购买或用来试探身份的玩法材料。目标不是“游戏记得这件事”，而是“这种东西居然也被这里拿来玩了”。
5. 禁止连续使用低信息量陈列演出，例如“某个熟悉的东西浮现 / 某段记忆出现在眼前 / 水面泛起涟漪 / 纸面微微发亮 / 线轻轻颤动”。transitionLines、memoryLine、result、charAction 必须写具体发生了什么。
6. 前六站必须各提供恰好 3 个完整 options，不能少于或多于 3 个；wordCloud 的 options 必须为空。每个 option 都必须包含 id、label、result、evidenceIds，并且每个 option 自己都必须引用至少一个有效 evidence；不能只让整个场景笼统引用 evidence。
7. lostLayer 的每一个 option.label 都必须直接从它自己的 evidenceIds 所指向的具体事实、物件或未完话题提炼，让 User 选择“接着和 ${char.name} 聊哪段真实记忆”。禁止脱离 evidence 的泛泛问候，也不能生成开发、运维、代码或故障处理任务。可以让态度不同，例如不信邪重发、只丢一个问号试探、故意换个说法，但选项中必须看得出在聊哪条真实记忆。lostLayer 每个 option 还必须额外提供 charReply：这是清掉满屏报错之后，${char.name} 针对这个选项所代表话题真正送回来的 4—48 字回复；必须回应具体话题并像角色本人，不能继续谈报错、只写动作说明或泛泛说“我在”。所有玩家可见文案绝不能出现 e1、e2、evidenceId 等内部编号。
8. 选项要表现 User 的策略、态度或意图，减少只有“拿起 / 放下 / 点击 / 查看 / 写下 / 等待”的机械动作。即使前端最终仍是按钮，七站文本也不能像连续做七次同一种选择题。
9. result 不能只是“发光、颤动、出现反馈”，必须让 User 的具体选择改变这一轮互动：东西被抽走、位置被占、内容被改、双方撞车、配合失败后重来、某件商品提前售出等。
10. charAction 必须通过 ${char.name} 处理事情的方式暴露人格，至少体现一种具体特征：动作习惯、耐心、抢先、嘴硬、故意逗人、临时改主意、无意识的小动作、怪比喻、歪理或冷幽默。charPerformance 只是辅助参数，不能代替具体人格演出。遮掉角色名字和所有记忆名词后，仍应能凭动作与吐槽猜出是谁。Char 的动作必须同时像“ta 正在处理自己那一层的遭遇”，不能全部写成专程过来帮助 User；至少三站先写出 Char 自己的目的，再让双方动作意外相撞或接上。
11. 七站中至少四站要出现一次意外、失败、抢夺、擅自修改、互相妨碍或故意不配合；两层不能永远温柔顺利地用另一色光芒回应。
12. 前六站禁止频繁写“对方似乎很了解你 / 你感到熟悉 / 某种默契形成 / 你意识到彼此存在联系”这类爱情或关系总结。展示动作证据，不替玩家解释证据。
13. 七站玩法职责必须不同：lostLayer 是话题发送失败后报错红框铺满空间，Char 只攻击并毁掉报错，再真正回复所选话题；doubleWish 是异步共用同一张纸并分别写下各自的愿望；threadNeedle 是被迫摸索动作顺序并与未知另一层协作；offerings 是双方先后各自放下一件东西；reflection 是能被实时修改的痕迹；nightMarket 是双方各自逛摊、选购和试探；wordCloud 是双方严格交替选词并把身份怀疑推到最高，但不完成最终确认。
14. wordCloud 的 artifactIds 必须提供 12—20 个短小、好选择的性格/气质/处事方式词，用来回答“你想到的那个人是什么性格”；User 会从中选 3 个最像 ${char.name} 的词。不要放物件、日期、话题、称呼、愿望或“开心/难过”这类瞬时情绪。charSelectionIds 选择 3—6 个 ${char.name} 眼里“最像 User”的性格词。
15. openingChat 必须恰好两句，完全使用 ${char.name} 的说话方式。语义是：${char.name} 怀疑 ${user.name} 刚刚回复过，但自己没有收到。不能提活动、七夕、梦境、夹层、邀请、准备惊喜或“点击输入框”。
16. 每个场景必须提供 transitionLines 1—2 句，把上一站真实发生的具体结果变成下一站入口，让七站保持因果连续。每句用 12—38 个中文字符，只写 User 能直接看到、听到或碰到的普通感官变化，不能总结主题、解释身份或写成任务说明。严禁“数据流 / 字符化 / 上下文 / 协议 / 接口 / 系统指令”等技术隐喻，严禁输出世界书标签、英文品牌名或“【CYBERORDER】”这类方括号设定名。
17. lostLayer 与 doubleWish 必须提供 charVisibleText，其他五站填空字符串。lostLayer 的 charVisibleText 是 ${char.name} 毁掉报错时留在原地的 2—36 字短句，矛头必须指向报错、弹窗或挡路的错误，不能评价、改写或抢救 User 的话题；doubleWish 的 charVisibleText 必须直接写成 Char 第一人称许下的完整愿望句（例如“希望我正在找的那个人平安，也希望以后还能一起期待明天”），不能回应 User 正面的愿望，也不能暗示已经知道纸张另一面是谁。
18. lostLayer 必须提供 charMutter：2—18 字，是 ${char.name} 冲回来毁掉报错时脱口而出的短促碎念。既有演出顺序不可改：“User 选择记忆相关话题 → 尝试发送 → DELIVERY FAILED、API 限流、超时与软道歉红框铺满空间 → Char 从另一层冲回来划掉、撕碎或踢走全部报错 → 对应 option.charReply 穿过清出的空隙出现 → User 的话题原样留在发送框”。Char 的视觉动作、charVisibleText、charMutter 与 charQuips 只能攻击报错，绝不能攻击、改写、删除、划掉或抢救 User 的话题；真正回应话题只写在 option.charReply。
19. lostLayer 恰好提供 2 句环绕报错墙出现的 charQuips；doubleWish、threadNeedle、offerings、reflection、nightMarket 各提供 1—2 句 charQuips，wordCloud 恰好 3 句。它们是 ${char.name} 在当下漏出来的私人碎碎念，不是动作说明、记忆总结或系统旁白；每句 4—26 字，可以暴露一瞬间的私心、害羞、嫌弃、得意、犹豫、被迫玩奇怪小游戏的不耐烦、想藏起来的小愿望、对失踪之人的担心、对另一层身份的迟疑，或只有 ta 才会冒出的怪念头。Part 1 全程不能直接叫 User 名字，前六站不能把另一层称作已知的“你”，只能用“某人 / 另一边 / 那家伙 / 不知道谁”等未知称呼；第七站可以写“不会真是……”这种猜测，但不能确认。可爱来自受困时具体的小别扭、误会和意外，不来自统一卖萌、网络梗或随机发疯。在不违背设定时把电波感开到约 7/10。至少三站的碎碎念不直接提 evidence，而是只回应眼前正在发生的事。wordCloud 严格执行 User 选一个 → Char 立刻选一个并吐槽，共三轮，不能最后一次性揭晓。
20. doubleWish 的 User 三个愿望可以是对“两个人以后”的真实期盼。${char.name} 的 charVisibleText 则是 ta 在自己那一层写给“正在寻找的重要之人”的私人愿望，并不知道共享同一张纸的操作者就是那个人；不能直接对另一层说“你”，不能写成回应 User 正面的愿望。若记忆宫殿召回内容中出现“窗台房间 / Window Sill”里的未来愿望、计划或期盼，可以从中提炼，但不得把愿望写成已经发生的共同经历。charQuips 是纸角漏出来的自言自语，可以嫌弃这关奇怪、想遮住自己写得太认真，或担心那个人现在在哪里。
21. offerings 必须提供 charContribution：2—24 字，只写 ${char.name} 从自己那一层放上供桌的具体【私物】。它必须是属于 ${char.name}、对 ${char.name} 本人有意义、像 ta 会拥有/使用/随身携带/珍藏的东西；不要求来自共同记忆，不要求与 User 有关，也绝不能默认写成特意送给 User 的礼物。可以让 charQuips 用角色自己的口吻极短暴露为什么舍不得、常用或看重它，但不要写档案式说明。charContribution 不能是动作、旁白、对 User 供物的评价或“另一样东西”这种占位语。演出顺序固定为“User 选择并放下自己的东西 → 另一侧空位出现变化 → charContribution 对应的 Char 私物滑入 → charQuips 在私物旁出现”。charAction 可以描述随后发生的挪动、交换、抢位或碰撞，但不能替代 Char 自己的私物。
22. nightMarket 的三个 option.label 必须分别是 User 真能挑选购买的具体梦境商品，并由有效 evidence 变形而来；不要再写“试探一下 / 抢先 / 等待”这种抽象策略。User 选中后，charAction 必须按顺序写清：${char.name} 也挑了一件“某人也许会喜欢”的不同商品作为身份试探 → 随后避开另一层视线，偷偷把纯粹自己想买的 charContribution 塞进纸袋。charContribution 为 2—24 字具体商品，体现角色自己的喜好，不要求与 User 有关。charQuips 可以嘴硬掩饰自购品，但默认禁止吃醋、嫉妒、情敌、占有欲宣言和围绕 User 争抢商品；除非真实设定与 evidence 明确支持，否则不要生成这类内容。
23. 叙事视角必须分开。系统旁白、transitionLines、memoryLine、options.label、options.result 面向玩家时，用第二人称“你 / 你的”，禁止写“User / 用户 / 玩家 / 该用户 / ta / 他 / 她”。但 ${char.name} 自己说出或漏出的 charVisibleText、charMutter、charQuips、charReply，以及描述 ta 主观判断的 charAction，在 Part 1 不能知道另一层就是 User：应按场景使用“某人 / 另一边 / 那家伙 / 不知道谁”，不能叫 ${user.name}，也不能用带有身份确认含义的“你”。内部 evidence 与 artifact 的事实字段不受这条叙述人称限制。

场景要求：
${briefs}

只输出一个 JSON 对象，不要 Markdown，不要解释：
{
  "openingChat": ["角色察觉可能漏收消息", "角色困惑地确认异常"],
  "charLayerColor": "从允许色表中选择的十六进制颜色",
  "charPerformance": { "tempo": "brisk|measured|hesitant|playful", "markStyle": "precise|soft|scribbled|ornate", "presence": "direct|careful|teasing|quiet" },
  "evidence": [
    { "id": "e1", "fact": "一条具体可核对的事实", "object": "真实物件或词", "tags": ["日常", "饮料"] }
  ],
  "artifacts": [
    { "id": "a1", "label": "一个短词或物件", "kind": "object|phrase|nickname|topic|date|emotion|wish|symbol|trait", "evidenceIds": ["e1"] }
  ],
  "scenes": {
    "lostLayer": {
      "transitionLines": ["上一空间留下的痕迹开始变化", "下一空间从痕迹中浮现"],
      "sharedObject": "一个停在发送前的话题框",
      "memoryLine": "两个真实的未完话题卡在发送框里",
      "options": [{ "id": "topic-1", "label": "把那件只说了一半的小事继续说完", "result": "这句追问尝试发送后变成 DELIVERY FAILED。", "charReply": "针对这件小事真正送回来的角色回复", "evidenceIds": ["e1"] }, { "id": "topic-2", "label": "问问那个真实目标后来到了没有", "result": "这个话题离开发送框后被退回。", "charReply": "针对那个真实目标的角色回复", "evidenceIds": ["e2"] }, { "id": "topic-3", "label": "拿另一个真实记忆细节重新发一次", "result": "第三个话题被超时弹窗拦住。", "charReply": "针对第三个记忆话题的角色回复", "evidenceIds": ["e3"] }],
      "charAction": "API 报错、限流、超时和软道歉红框铺满空间；另一色字迹从另一层冲来，把所有红框划掉、撕碎并踢走，你选中的话题原样留在原处",
      "charMutter": "角色毁掉报错时脱口而出的短促碎念",
      "charVisibleText": "挡路的，删掉。",
      "charQuips": ["道歉留着自己看。", "这次不许再吞。"],
      "reveal": "只推进到：报错后面确实有另一个人在操作",
      "artifactIds": ["a1"],
      "charSelectionIds": []
    },
    "doubleWish": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "doubleWish-1", "label": "关于两个人未来的愿望一", "result": "愿望写上正面的即时反馈", "evidenceIds": ["e4"] }, { "id": "doubleWish-2", "label": "关于两个人未来的愿望二", "result": "愿望写上正面的即时反馈", "evidenceIds": ["e5"] }, { "id": "doubleWish-3", "label": "关于两个人未来的愿望三", "result": "第三个愿望改变纸面的具体反馈", "evidenceIds": ["e6"] }], "charAction": "纸笺被另一边翻到背面，某人写下关于正在寻找之人的愿望", "charVisibleText": "希望我正在找的那个人平安，也希望以后还能一起期待明天。", "charQuips": ["这关为什么非要看别人写愿望……"], "reveal": "...", "artifactIds": [], "charSelectionIds": [] },
    "threadNeedle": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "threadNeedle-1", "label": "先把线头压低，等另一边稳住针孔", "result": "会改变配合过程的具体结果", "evidenceIds": ["e7"] }, { "id": "threadNeedle-2", "label": "故意停半拍，让另一边先选", "result": "不同的碰撞或配合结果", "evidenceIds": ["e8"] }, { "id": "threadNeedle-3", "label": "同时松手，看另一边会不会接住", "result": "第三种失败或配合结果", "evidenceIds": ["e9"] }], "charAction": "带角色人格的直接回应", "charVisibleText": "", "charQuips": ["角色即时吐槽"], "reveal": "只推进到主动协作", "artifactIds": [], "charSelectionIds": [] },
    "offerings": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "offerings-1", "label": "放下属于你的第一件东西", "result": "你的供物落在左侧空位", "evidenceIds": ["e10"] }, { "id": "offerings-2", "label": "把自己的东西先放在正中间", "result": "你的供物占住最显眼的位置", "evidenceIds": ["e11"] }, { "id": "offerings-3", "label": "故意把自己的东西贴着边缘放", "result": "你的供物为另一侧留出空位", "evidenceIds": ["e12"] }], "charAction": "另一层自己的私物滑入空位，随后发生带私人判断的挪动或碰撞", "charContribution": "属于 Char 且对 Char 本人有意义的具体私物", "charVisibleText": "", "charQuips": ["用角色口吻泄露这件私物为何被看重"], "reveal": "只展示双方各自放下东西与互相判断的证据", "artifactIds": [], "charSelectionIds": [] },
    "reflection": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "reflection-1", "label": "留半句话，故意不写完", "result": "另一层可以立即接续的具体结果", "evidenceIds": ["e13"] }, { "id": "reflection-2", "label": "画一个会被另一边改坏的符号", "result": "另一层修改或曲解后的结果", "evidenceIds": ["e14"] }, { "id": "reflection-3", "label": "先擦掉一笔再看另一边怎么补", "result": "第三种实时接续结果", "evidenceIds": ["e15"] }], "charAction": "另一层近实时修改你留下的内容", "charVisibleText": "", "charQuips": ["角色即时吐槽"], "reveal": "只推进到近实时交流", "artifactIds": [], "charSelectionIds": [] },
    "nightMarket": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "nightMarket-1", "label": "由 e16 变形成的具体可买商品", "result": "你把商品放进自己的纸袋", "evidenceIds": ["e16"] }, { "id": "nightMarket-2", "label": "由 e17 变形成的另一件具体商品", "result": "摊主把你选的东西包起来", "evidenceIds": ["e17"] }, { "id": "nightMarket-3", "label": "由 e18 变形成的第三件具体商品", "result": "你的购买券落到对应商品前", "evidenceIds": ["e18"] }], "charAction": "另一边先挑走一件觉得某人可能喜欢的商品，停顿后又偷偷把自己的东西塞进纸袋", "charContribution": "Char 单纯为自己买的具体商品", "charVisibleText": "", "charQuips": ["只是我自己想要，别乱猜。"], "reveal": "双方都觉得购物习惯异常熟悉，但谁也没有确认身份", "artifactIds": [], "charSelectionIds": [] },
    "wordCloud": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [], "charAction": "...", "charVisibleText": "", "charQuips": ["第一轮吐槽", "第二轮吐槽", "第三轮吐槽"], "reveal": "...", "artifactIds": ["a1"], "charSelectionIds": ["a1"] }
  }
}`;
}

export function buildQixiMemoryBundlePhasePrompt(
    char: CharacterProfile,
    user: UserProfile,
    userLayerColor: string = QIXI_DEFAULT_USER_LAYER_COLOR,
    phase: 'first' | 'second' | 'third',
    continuationSeed = '',
): string {
    const basePrompt = buildQixiMemoryBundlePrompt(char, user, userLayerColor);
    if (phase === 'first') {
        return `${basePrompt}

【本轮输出范围覆盖上面的完整示例】
这是 Part 1 的第一段生成。只生成公共上下文与前两站的最终可播放内容，降低一次性输出负担。
最终 JSON 顶层必须包含 openingChat、charLayerColor、charPerformance、evidence、artifacts、scenes；scenes 必须且只能包含 lostLayer、doubleWish 两个 key。
不要输出其余五站，也不要用省略号代替任何字段。后续两段会接在本轮结果后面。`;
    }

    if (phase === 'second') {
        return `${basePrompt}

【上一段已通过基础结构检查的唯一底稿】
${continuationSeed}

【本轮输出范围覆盖上面的完整示例】
这是 Part 1 的第二段生成。不要重写 openingChat、charLayerColor、charPerformance、evidence 或 artifacts，也不要改写前两站。
只输出一个 JSON 对象，唯一顶层 key 为 scenes；scenes 必须且只能包含 threadNeedle、offerings、reflection 三个完整场景。
这三站必须沿用上面底稿的 evidence id、artifact id、角色行为方式与前两站事件结果，形成同一条连续事件；不得发明底稿之外的过去事实。不要输出 Markdown，不要解释，不要使用省略号。`;
    }

    return `${basePrompt}

【上一段已通过基础结构检查的唯一底稿】
${continuationSeed}

【本轮输出范围覆盖上面的完整示例】
这是 Part 1 的第三段生成。不要重写 openingChat、charLayerColor、charPerformance、evidence 或 artifacts，也不要改写前五站。
只输出一个 JSON 对象，顶层必须且只能有 scenes 与 bridge 两个 key。scenes 必须且只能包含 nightMarket、wordCloud 两个完整场景。
最后两站必须沿用上面底稿的 evidence id、artifact id、角色行为方式与前五站事件结果，形成同一条连续事件；不得发明底稿之外的过去事实。

同一次响应中的 bridge 负责八地点结束后的鹊桥最终可播放内容。它必须复用上面底稿中已经召回的真实 evidence，不重新发明共同经历：
- userMagpies：选择 User 会由此想到 Char 的记忆；charMagpies：选择 Char 会由此想到 User 的记忆。
- 每侧根据有效证据选择 1—6 只，宁可少而准确；同一侧 evidenceId 不得重复，两侧允许从不同角度引用同一条证据。
- 每只鹊必须包含 evidenceId、极短 name、一句私人具体的 memory、只做视觉抽象且不新增事实的 visualHint。
- finalMagpie.name 固定为“${user.name}”，代表系统把 Char 一路怀疑的名字带向中央；line 只能表达“越来越像某人 / 希望没有认错”的近乎确定，不能说已经亲眼确认身份。真正的“果然是你”留给 Part 3 见面。visualHint 是极短视觉意象。
- 禁止直接解释“思念就是鹊桥”“记忆让我们相见”等中心思想，交给后续动画表达。

输出结构必须是：
{
  "scenes": {
    "nightMarket": { "完整字段": "按上方场景规范生成" },
    "wordCloud": { "完整字段": "按上方场景规范生成" }
  },
  "bridge": {
    "userMagpies": [{ "evidenceId": "e1", "name": "记忆名称", "memory": "一句极短真实记忆", "visualHint": "极短视觉意象" }],
    "charMagpies": [{ "evidenceId": "e2", "name": "记忆名称", "memory": "一句极短真实记忆", "visualHint": "极短视觉意象" }],
    "finalMagpie": { "name": "${user.name}", "line": "Char 几乎猜到但还不敢确认的极短反应", "visualHint": "从对岸飞来的名字" }
  }
}
不要输出 Markdown，不要解释，不要使用省略号。`;
}

const formatRecentMessages = (messages: Message[]): string => messages
    .slice(-160)
    .map(message => {
        const content = message.type === 'image' ? '[图片]' : message.content;
        return `${message.role}: ${content}`;
    })
    .join('\n')
    .slice(-24000);

export async function prepareQixiMemoryBundle(
    char: CharacterProfile,
    user: UserProfile,
    apiConfig: APIConfig,
    options: {
        forceRegenerate?: boolean;
        strict?: boolean;
        onRecallComplete?: () => void;
        onPhaseReady?: (phase: QixiMemoryGenerationPhase, bundle: QixiMemoryBundle) => void;
        userLayerColor?: string;
    } = {},
): Promise<QixiMemoryPreparation> {

    let messages: Message[] = [];
    try { messages = await loadCharacterContextMessages(char); } catch { /* fallback below */ }
    const contextSignature = buildContextSignature(messages, char, user);
    const cached = loadQixiMemoryBundle(char.id);
    if (!options.forceRegenerate && cached?.contextSignature === contextSignature) {
        options.onRecallComplete?.();
        options.onPhaseReady?.('third', cached);
        return { bundle: cached, usedFallback: cached.source === 'fallback' };
    }

    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) {
        throw new Error('Part 1 无法生成：请先配置可用的模型 API。');
    }

    try {
        const recallQuery = [
            `七夕活动专用跨主题召回：目标返回 ${QIXI_RECALL_MAX_OUTPUT_ITEMS} 条互不重复、真实可核对的共同记忆。`,
            '想念、寻找对方、联系、分享、没说完的话、撤回、沉默、等待、失联；',
            '礼物、食物、饮料、日常物件、日期时间、称呼昵称、口头禅、截图图片、梗；',
            '学习、工作、创作、为对方做成的事、愿望目标、未来、彼此印象；',
            '记忆宫殿的窗台房间 / Window Sill / 窗边记录里的未来愿望、未完成计划、想去的地方、对以后生活的期盼；若存在，优先保留至少两条；',
            '安慰、害怕、难过、烦恼、负面情绪、陪伴、和好、需要、喜欢、自由、休息。',
            '尽量跨不同时间、主题和记忆类型；不要让同一事件换说法重复占位。优先返回私人、具体、可核对的记忆。',
        ].join('\n');
        const recallChar = { ...char, memoryPalaceInjection: '', roomPlatesInjection: '' };
        // 七夕召回只用活动 query 扩散；聊天上下文留给后面的生成器作事实来源，
        // 不参与检索打分，避免最近话题把 20 条记忆挤成同一类。
        await injectMemoryPalace(recallChar, [], recallQuery, user.name, {
            entryPoint: 'direct',
            formatterMaxOutputItems: QIXI_RECALL_MAX_OUTPUT_ITEMS,
        });
        options.onRecallComplete?.();
        const memoryChar = {
            ...char,
            memoryPalaceInjection: (recallChar.memoryPalaceInjection || '').slice(0, 40000),
            roomPlatesInjection: recallChar.roomPlatesInjection || '',
        };
        const recent = formatRecentMessages(messages);

        const endpoint = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        const requestPhase = async (phase: 'first' | 'second' | 'third', userContent: string) => {
            const data = await safeFetchJson(
                endpoint,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                    body: JSON.stringify({
                        model: apiConfig.model,
                        messages: (await ContextBuilder.buildCharacterRequest({ char: memoryChar, user }, [
                            { role: 'user', content: userContent },
                        ])),
                        temperature: 0.68,
                        max_tokens: 32000,
                        // 七夕首轮内容较长。强制使用流式传输，让上游尽早返回响应头/数据片段，
                        // 避免 Claude 在完整生成结束前触发 Cloudflare 524。
                        stream: true,
                    }),
                },
                0,
                QIXI_PART1_TIMEOUT_MS,
                {
                    appId: 'special-moments',
                    appName: '七夕特别时刻',
                    charId: char.id,
                    charName: char.name,
                    purpose: phase === 'first'
                        ? '七夕双层记忆·上篇'
                        : phase === 'second'
                            ? '七夕双层记忆·中篇'
                            : '七夕双层记忆·下篇与鹊桥',
                },
                {}, // Incremental SSE reader stops on [DONE] even if the proxy keeps the socket open.
            );
            const content = data?.choices?.[0]?.message?.content;
            const finishReason = data?.choices?.[0]?.finish_reason || 'unknown';
            if (typeof content !== 'string') {
                throw new Error(`Part 1 ${phase === 'first' ? '前两站' : phase === 'second' ? '中三站' : '后两站与鹊桥'}响应正文不是字符串（finish_reason=${finishReason}, output_chars=0）`);
            }
            return { content, finishReason };
        };
        const hasPlayablePhaseScenes = (value: any, requiredIds: readonly QixiSceneId[]) => (
            directRecord(value?.scenes)
            && requiredIds.every(sceneId => looksLikeGeneratedScene(value.scenes[sceneId]))
        );
        const firstResponse = await requestPhase(
            'first',
            `[最近聊天片段，仅作事实来源]\n${recent || '（没有可用的最近聊天片段）'}\n\n${buildQixiMemoryBundlePhasePrompt(char, user, options.userLayerColor, 'first')}`,
        );
        const firstChunk = normalizeQixiPhaseChunk(
            parseQixiJsonObject(firstResponse.content),
            QIXI_PART1_FIRST_SCENE_IDS,
        );
        if (!firstChunk || !hasPlayablePhaseScenes(firstChunk, QIXI_PART1_FIRST_SCENE_IDS)) {
            throw new Error(`Part 1 前两站正文无法读取（finish_reason=${firstResponse.finishReason}, output_chars=${firstResponse.content.length}）`);
        }
        let firstParseFailure = '未知结构错误';
        const firstBundle = parseQixiProgressiveMemoryBundle(firstChunk, firstChunk.scenes, contextSignature, user.name, reason => { firstParseFailure = reason; });
        if (!firstBundle) {
            throw new Error(`Part 1 前两站内容无效（finish_reason=${firstResponse.finishReason}, output_chars=${firstResponse.content.length}, schema=${firstParseFailure}）`);
        }
        // The first playable slice is ready. Deliver it before opening the next
        // serial request so Flappy never waits for all three generations.
        options.onPhaseReady?.('first', firstBundle);

        const continuationSeed = JSON.stringify({
            openingChat: firstChunk.openingChat,
            charLayerColor: firstChunk.charLayerColor,
            charPerformance: firstChunk.charPerformance,
            evidence: firstChunk.evidence,
            artifacts: firstChunk.artifacts,
            completedScenes: firstChunk.scenes,
        });
        const secondResponse = await requestPhase(
            'second',
            buildQixiMemoryBundlePhasePrompt(char, user, options.userLayerColor, 'second', continuationSeed),
        );
        const secondChunk = normalizeQixiPhaseChunk(
            parseQixiJsonObject(secondResponse.content),
            QIXI_PART1_SECOND_SCENE_IDS,
        );
        if (!secondChunk || !hasPlayablePhaseScenes(secondChunk, QIXI_PART1_SECOND_SCENE_IDS)) {
            throw new Error(`Part 1 中三站正文无法读取（finish_reason=${secondResponse.finishReason}, output_chars=${secondResponse.content.length}）`);
        }
        const secondScenes = { ...firstChunk.scenes, ...secondChunk.scenes };
        let secondParseFailure = '未知结构错误';
        const secondBundle = parseQixiProgressiveMemoryBundle(firstChunk, secondScenes, contextSignature, user.name, reason => { secondParseFailure = reason; });
        if (!secondBundle) {
            throw new Error(`Part 1 中三站内容无效（finish_reason=${secondResponse.finishReason}, output_chars=${secondResponse.content.length}, schema=${secondParseFailure}）`);
        }
        // Call 3 is still strictly downstream of Call 2, but React receives the
        // accepted middle rooms before the third request starts.
        options.onPhaseReady?.('second', secondBundle);

        const finalContinuationSeed = JSON.stringify({
            openingChat: firstChunk.openingChat,
            charLayerColor: firstChunk.charLayerColor,
            charPerformance: firstChunk.charPerformance,
            evidence: firstChunk.evidence,
            artifacts: firstChunk.artifacts,
            completedScenes: { ...firstChunk.scenes, ...secondChunk.scenes },
        });
        const thirdResponse = await requestPhase(
            'third',
            buildQixiMemoryBundlePhasePrompt(char, user, options.userLayerColor, 'third', finalContinuationSeed),
        );
        const thirdChunk = normalizeQixiPhaseChunk(
            parseQixiJsonObject(thirdResponse.content),
            QIXI_PART1_THIRD_SCENE_IDS,
        );
        const hasCollection = (value: unknown) => Array.isArray(value)
            ? value.length > 0
            : Boolean(value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length);
        if (!thirdChunk || !hasPlayablePhaseScenes(thirdChunk, QIXI_PART1_THIRD_SCENE_IDS)
            || !hasCollection(thirdChunk.bridge?.userMagpies)
            || !hasCollection(thirdChunk.bridge?.charMagpies)
            || !thirdChunk.bridge?.finalMagpie) {
            throw new Error(`Part 1 后两站与鹊桥结构无效（finish_reason=${thirdResponse.finishReason}, output_chars=${thirdResponse.content.length}）`);
        }

        const mergedContent = JSON.stringify({
            ...firstChunk,
            scenes: { ...firstChunk.scenes, ...secondChunk.scenes, ...thirdChunk.scenes },
            bridge: thirdChunk.bridge,
        });
        let parseFailureReason = '未知结构错误';
        const bundle = parseQixiMemoryBundle(mergedContent, contextSignature, reason => { parseFailureReason = reason; }, user.name);
        if (!bundle?.bridge) {
            throw new Error(`模型返回的七夕可播放剧本无法读取（phase=merge, finish_reason=${firstResponse.finishReason}+${secondResponse.finishReason}+${thirdResponse.finishReason}, output_chars=${firstResponse.content.length}+${secondResponse.content.length}+${thirdResponse.content.length}, schema=${parseFailureReason}）`);
        }
        options.onPhaseReady?.('third', bundle);
        saveQixiMemoryBundle(char.id, bundle);
        return { bundle, usedFallback: false };
    } catch (error: any) {
        console.warn('[Qixi] direct script generation failed:', error?.message || error);
        throw new Error(error?.message || 'Part 1 生成失败，请手动重新生成。');
    }
}
