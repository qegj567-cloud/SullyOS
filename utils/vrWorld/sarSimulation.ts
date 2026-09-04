import type { APIConfig, CharacterProfile, GroupProfile, Message, RealtimeConfig, UserProfile } from '../../types';
import { DB } from '../db';
import { RoomPlateDB } from '../memoryPalace/db';
import { formatRoomPlatesSection } from '../memoryPalace/roomPlates';
import { safeFetchJson } from '../safeApi';
import { getSARModuleById, readSARGachaState, type SARModuleDefinition } from './sarGacha';
import { getVRApi, logVRApiCall } from './vrApi';

export const SAR_SIMULATION_STORAGE_KEY = 'vr_sar_simulations_v1';
export const SAR_SIMULATION_MAX_INTERACTIONS = 50;
export const SAR_SIMULATION_MESSAGE_SOURCE = 'sar_simulation';

export type SARInteractionMode = 'online' | 'offline';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** 一次铸造后永久收藏的角色专属异格身份。 */
export type SARIdentityProfile = {
    title: string;
    logline: string;
    identity: string;
    lifePatch: string;
    relationship: string;
    /** 旧卡兼容字段；新卡不再携带具体现实记忆。 */
    memoryStance?: string;
    steelSeal: string;
    patchCost: string;
    behaviorShift: string;
    /** User 在这条异界坐标中佩戴的身份面具；旧卡读取时自动补齐。 */
    userMaskTitle?: string;
    userIdentity?: string;
    userLifePatch?: string;
    openingScene: string;
    openingLine: string;
    playerPrompt: string;
    /** v3 异界坐标字段；旧卡读取时由 resolveSARWorldlineProfile 补铸。 */
    worldName?: string;
    worldPremise?: string;
    arrivalPoint?: string;
    activeCrisis?: string;
    sharedObjective?: string;
    countdown?: string;
    hiddenTruth?: string;
    climaxChoice?: string;
    memoryFuse?: string;
};

export type SARWorldlineProfile = {
    worldName: string;
    worldPremise: string;
    arrivalPoint: string;
    activeCrisis: string;
    sharedObjective: string;
    countdown: string;
    hiddenTruth: string;
    climaxChoice: string;
    relationshipAnchor: string;
    retrofitted: boolean;
};

export type SARUserMaskProfile = {
    title: string;
    identity: string;
    lifePatch: string;
    retrofitted: boolean;
};

export type SARIdentityCard = {
    id: string;
    charId: string;
    charName: string;
    charAvatar?: string;
    variantId: string;
    storyId: string;
    createdAt: number;
    updatedAt: number;
    profile: SARIdentityProfile;
    /** v1 推演蓝图迁移而来，原始资料没有独立钢印/代价字段。 */
    legacy?: boolean;
};

/** 身份卡可以长期收藏；每一次五十轮生命则是独立实例。 */
export type SARSimulationRun = {
    id: string;
    cardId: string;
    createdAt: number;
    updatedAt: number;
    status: 'active' | 'archived';
    interactionsUsed: number;
    maxInteractions: 50;
    archivedAt?: number;
    archiveReason?: 'completed' | 'emergency';
    /** 已把返航简报投递到原角色私聊；避免重复分享。 */
    sharedAt?: number;
};

export type SARSimulationState = {
    version: 2;
    cards: SARIdentityCard[];
    runs: SARSimulationRun[];
};

export const DEFAULT_SAR_SIMULATION_STATE: SARSimulationState = { version: 2, cards: [], runs: [] };

const browserStorage = (): StorageLike | undefined => {
    try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
    catch { return undefined; }
};

const cleanText = (value: unknown, max: number) => typeof value === 'string'
    ? value.trim().replace(/\s{3,}/g, '\n\n').slice(0, max)
    : '';

const parseJsonCandidates = (raw: string) => {
    const withoutThinking = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const candidates = [withoutThinking];
    const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) candidates.push(fenced.trim());
    const firstBrace = withoutThinking.indexOf('{');
    const lastBrace = withoutThinking.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(withoutThinking.slice(firstBrace, lastBrace + 1));
    return candidates;
};

export type SARSimulationReply = {
    /** 世界意志旁白层：只调度世界、时间、代价与返航节奏。 */
    worldNarration: string;
    /** 角色层：只演出角色能够感知、说出和做出的部分。 */
    character: string;
};

/**
 * 正式推演使用双层响应。保留纯文本回退是为了兼容不稳定模型与旧 API，
 * 新请求使用 worldNarration / character；旧 gm 字段仍可读取。
 */
export const parseSARSimulationReply = (raw: string): SARSimulationReply | null => {
    for (const candidate of parseJsonCandidates(raw)) {
        try {
            const parsed = JSON.parse(candidate);
            const worldNarration = cleanText(parsed?.worldNarration ?? parsed?.world ?? parsed?.narrator ?? parsed?.gm ?? parsed?.director, 2400);
            const character = cleanText(parsed?.character ?? parsed?.char ?? parsed?.reply, 12000);
            if (worldNarration && character) return { worldNarration, character };
        } catch { /* 尝试下一个候选 JSON */ }
    }
    const withoutThinking = cleanText((raw || '').replace(/<think>[\s\S]*?<\/think>/gi, ''), 12000);
    return withoutThinking ? { worldNarration: '', character: withoutThinking } : null;
};

/** 新记录使用 sarWorldNarration；旧 sarGM 元数据仅作无损迁移兼容。 */
export const getSARWorldNarration = (message: Pick<Message, 'metadata'>) =>
    cleanText(message.metadata?.sarWorldNarration ?? message.metadata?.sarGM, 2400);

export const parseSARIdentityProfile = (raw: string): SARIdentityProfile | null => {
    for (const candidate of parseJsonCandidates(raw)) {
        try {
            const parsed = JSON.parse(candidate);
            const result: SARIdentityProfile = {
                title: cleanText(parsed?.title, 80),
                logline: cleanText(parsed?.logline, 240),
                identity: cleanText(parsed?.identity, 900),
                lifePatch: cleanText(parsed?.lifePatch, 800),
                relationship: cleanText(parsed?.relationship, 700),
                memoryStance: cleanText(parsed?.memoryStance, 600),
                steelSeal: cleanText(parsed?.steelSeal, 360),
                patchCost: cleanText(parsed?.patchCost, 600),
                behaviorShift: cleanText(parsed?.behaviorShift, 700),
                userMaskTitle: cleanText(parsed?.userMaskTitle, 80),
                userIdentity: cleanText(parsed?.userIdentity, 900),
                userLifePatch: cleanText(parsed?.userLifePatch, 800),
                openingScene: cleanText(parsed?.openingScene, 1800),
                openingLine: cleanText(parsed?.openingLine, 500),
                playerPrompt: cleanText(parsed?.playerPrompt, 300),
                worldName: cleanText(parsed?.worldName, 100),
                worldPremise: cleanText(parsed?.worldPremise, 700),
                arrivalPoint: cleanText(parsed?.arrivalPoint, 900),
                activeCrisis: cleanText(parsed?.activeCrisis, 700),
                sharedObjective: cleanText(parsed?.sharedObjective, 600),
                countdown: cleanText(parsed?.countdown, 400),
                hiddenTruth: cleanText(parsed?.hiddenTruth, 700),
                climaxChoice: cleanText(parsed?.climaxChoice, 600),
                memoryFuse: cleanText(parsed?.memoryFuse, 600),
            };
            const { memoryStance: _legacyMemoryStance, memoryFuse: _legacyMemoryFuse, ...required } = result;
            if (Object.values(required).every(Boolean)) return result;
        } catch { /* 尝试下一个候选 JSON */ }
    }
    return null;
};

const isIdentityCard = (card: any): card is SARIdentityCard => card
    && typeof card.id === 'string'
    && typeof card.charId === 'string'
    && typeof card.variantId === 'string'
    && typeof card.storyId === 'string'
    && card.profile && typeof card.profile === 'object'
    && typeof card.profile.title === 'string'
    && typeof card.profile.steelSeal === 'string';

const isSimulationRun = (run: any): run is SARSimulationRun => run
    && typeof run.id === 'string'
    && typeof run.cardId === 'string'
    && (run.status === 'active' || run.status === 'archived');

const migrateLegacyRecord = (record: any): { card: SARIdentityCard; run: SARSimulationRun } | null => {
    if (!record || typeof record.id !== 'string' || typeof record.charId !== 'string'
        || typeof record.variantId !== 'string' || typeof record.storyId !== 'string'
        || !record.blueprint || typeof record.blueprint !== 'object') return null;
    const blueprint = record.blueprint;
    const now = Number(record.createdAt) || Date.now();
    const updatedAt = Number(record.updatedAt) || now;
    const variantTitle = getSARModuleById(record.variantId)?.title || '旧版人格异格';
    const cardId = `sar_card_legacy_${record.id}`;
    return {
        card: {
            id: cardId,
            charId: record.charId,
            charName: cleanText(record.charName, 100) || '未命名角色',
            charAvatar: typeof record.charAvatar === 'string' ? record.charAvatar : undefined,
            variantId: record.variantId,
            storyId: record.storyId,
            createdAt: now,
            updatedAt,
            legacy: true,
            profile: {
                title: cleanText(blueprint.title, 80) || '旧版异格档案',
                logline: cleanText(blueprint.logline, 240) || '由旧版推演蓝图迁移而来的异格身份。',
                identity: cleanText(blueprint.characterState, 900) || '旧版档案未记录完整身份信息。',
                lifePatch: cleanText(blueprint.characterState, 800) || '旧版档案未单独记录人生补丁。',
                relationship: cleanText(blueprint.memoryPerformance, 700) || '沿用旧版关系记忆表现。',
                memoryStance: cleanText(blueprint.memoryPerformance, 600) || '沿用旧版关系记忆表现。',
                steelSeal: `旧版档案未单独铸造钢印；继续推演时以「${variantTitle}」作为不可绕过的人格约束。`,
                patchCost: '旧版档案未单独记录补丁代价。',
                behaviorShift: cleanText(blueprint.characterState, 700) || '沿用旧版角色偏移。',
                openingScene: cleanText(blueprint.openingScene, 1800) || '旧版档案没有可恢复的开场。',
                openingLine: cleanText(blueprint.openingLine, 500) || '……',
                playerPrompt: cleanText(blueprint.playerPrompt, 300) || '回应眼前的异格。',
            },
        },
        run: {
            id: record.id,
            cardId,
            createdAt: now,
            updatedAt,
            status: record.status === 'archived' ? 'archived' : 'active',
            interactionsUsed: Math.max(0, Math.min(50, Number(record.interactionsUsed) || 0)),
            maxInteractions: SAR_SIMULATION_MAX_INTERACTIONS,
        },
    };
};

export const readSARSimulationState = (storage: StorageLike | undefined = browserStorage()): SARSimulationState => {
    if (!storage) return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
    try {
        const parsed = JSON.parse(storage.getItem(SAR_SIMULATION_STORAGE_KEY) || 'null');
        if (!parsed) return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
        if (Array.isArray(parsed.cards) || Array.isArray(parsed.runs)) {
            return {
                version: 2,
                cards: (Array.isArray(parsed.cards) ? parsed.cards : []).filter(isIdentityCard).slice(0, 100),
                runs: (Array.isArray(parsed.runs) ? parsed.runs : []).filter(isSimulationRun).slice(0, 160),
            };
        }
        if (Array.isArray(parsed.records)) {
            const migrated = parsed.records.map(migrateLegacyRecord).filter(Boolean) as Array<{ card: SARIdentityCard; run: SARSimulationRun }>;
            return { version: 2, cards: migrated.map(item => item.card).slice(0, 100), runs: migrated.map(item => item.run).slice(0, 160) };
        }
        return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
    } catch {
        return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
    }
};

export const writeSARSimulationState = (state: SARSimulationState, storage: StorageLike | undefined = browserStorage()) => {
    const normalized: SARSimulationState = { version: 2, cards: state.cards.slice(0, 100), runs: state.runs.slice(0, 160) };
    try { storage?.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify(normalized)); } catch { /* ignore */ }
    return normalized;
};

export const saveSARIdentityCard = (card: SARIdentityCard, storage: StorageLike | undefined = browserStorage()) => {
    const current = readSARSimulationState(storage);
    return writeSARSimulationState({ ...current, cards: [card, ...current.cards.filter(item => item.id !== card.id)] }, storage);
};

export const startSARSimulationRun = (cardId: string, storage: StorageLike | undefined = browserStorage()) => {
    const current = readSARSimulationState(storage);
    if (!current.cards.some(card => card.id === cardId)) throw new Error('异格身份卡不存在');
    const active = current.runs.find(run => run.cardId === cardId && run.status === 'active');
    if (active) return active;
    const now = Date.now();
    const run: SARSimulationRun = {
        id: `sar_run_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        cardId,
        createdAt: now,
        updatedAt: now,
        status: 'active',
        interactionsUsed: 0,
        maxInteractions: SAR_SIMULATION_MAX_INTERACTIONS,
    };
    writeSARSimulationState({ ...current, runs: [run, ...current.runs] }, storage);
    return run;
};

export const completeSARSimulationTurn = (
    runId: string,
    expectedInteractions: number,
    storage: StorageLike | undefined = browserStorage(),
) => {
    const current = readSARSimulationState(storage);
    const run = current.runs.find(item => item.id === runId);
    if (!run) throw new Error('推演实例不存在');
    if (run.status !== 'active') throw new Error('这段推演已经封存');
    if (run.interactionsUsed !== expectedInteractions) throw new Error('推演进度已变化，请重新进入');
    const now = Date.now();
    const interactionsUsed = Math.min(SAR_SIMULATION_MAX_INTERACTIONS, run.interactionsUsed + 1);
    const completed = interactionsUsed >= SAR_SIMULATION_MAX_INTERACTIONS;
    const updated: SARSimulationRun = {
        ...run,
        interactionsUsed,
        updatedAt: now,
        status: completed ? 'archived' : 'active',
        ...(completed ? { archivedAt: now, archiveReason: 'completed' as const } : {}),
    };
    writeSARSimulationState({
        ...current,
        runs: current.runs.map(item => item.id === runId ? updated : item),
    }, storage);
    return updated;
};

export const archiveSARSimulationRun = (
    runId: string,
    storage: StorageLike | undefined = browserStorage(),
) => {
    const current = readSARSimulationState(storage);
    const run = current.runs.find(item => item.id === runId);
    if (!run) throw new Error('推演实例不存在');
    if (run.status === 'archived') return run;
    const now = Date.now();
    const archived: SARSimulationRun = {
        ...run,
        status: 'archived',
        updatedAt: now,
        archivedAt: now,
        archiveReason: 'emergency',
    };
    writeSARSimulationState({
        ...current,
        runs: current.runs.map(item => item.id === runId ? archived : item),
    }, storage);
    return archived;
};

/** 推演正文借用 messages 表，但使用实例专属伪角色 ID，永远不会进入原角色私聊。 */
export const getSARSimulationThreadId = (runId: string) => `sar-simulation:${runId}`;

export const loadSARSimulationMessages = async (runId: string) => {
    const threadId = getSARSimulationThreadId(runId);
    const messages = await DB.getMessagesByCharId(threadId, true);
    return messages.filter(message => (
        message.metadata?.source === SAR_SIMULATION_MESSAGE_SOURCE
        && message.metadata?.sarRunId === runId
    ));
};

const archiveDate = (timestamp?: number) => timestamp
    ? new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    : '未记录';

const archiveMode = (message: Message) => message.metadata?.sarMode === 'online' ? '线上文字' : '线下同场';

const archiveTurn = (message: Message) => String(Number(message.metadata?.sarTurn) || 0).padStart(2, '0');

export const getSARArchiveFilename = (card: SARIdentityCard, run: SARSimulationRun) => {
    const safe = `${card.profile.title}-${card.charName}`
        .replace(/[\\/:*?"<>|\s]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 72) || 'SAR-异界档案';
    return `${safe}-${run.interactionsUsed}of${run.maxInteractions}.md`;
};

/** 可重复下载的完整人类可读档案；世界意志旁白与角色层保持分离。 */
export const buildSARArchiveMarkdown = (
    card: SARIdentityCard,
    run: SARSimulationRun,
    messages: Message[],
    userName: string,
) => {
    const worldline = resolveSARWorldlineProfile(card);
    const userMask = resolveSARUserMaskProfile(card);
    const outcome = run.archiveReason === 'completed' ? '完成五十轮并返航' : '提前紧急封存';
    const transcript = messages.map(message => {
        const turn = archiveTurn(message);
        const mode = archiveMode(message);
        if (message.role === 'user') return `### ${turn}/50 · ${mode} · ${userName}\n\n${message.content}`;
        const worldNarration = getSARWorldNarration(message);
        return [
            `### ${turn}/50 · ${mode} · 世界意志`,
            worldNarration || '（该轮为旧版记录，没有独立的世界旁白。）',
            `### ${turn}/50 · ${mode} · ${card.charName}`,
            message.content,
        ].join('\n\n');
    }).join('\n\n---\n\n');

    return `# SAR 异界坐标封存档案

> 档案编号：${run.id}
> 封存状态：${outcome}
> 启动时间：${archiveDate(run.createdAt)}
> 封存时间：${archiveDate(run.archivedAt || run.updatedAt)}
> 推演寿命：${run.interactionsUsed}/${run.maxInteractions}

## 双身份

- 角色：${card.charName} / ${card.profile.title}
- 角色异界身份：${card.profile.identity}
- 人格钢印：${card.profile.steelSeal}
- User：${userName} / ${userMask.title}
- User 异界身份：${userMask.identity}

## 异界坐标

- 世界：${worldline.worldName}
- 世界规则：${worldline.worldPremise}
- 共同任务：${worldline.sharedObjective}
- 倒计时：${worldline.countdown}
- 高潮抉择：${worldline.climaxChoice}

## 第 0 幕

**世界意志**

${card.profile.openingScene}

**${card.charName}**

${card.profile.openingLine}

## 完整推演记录

${transcript || '（没有已保存的互动记录。）'}

---

本档案由彼方 SAR 活动室封存。异界经历不会自动写入现实角色记忆；只有用户主动分享的返航简报会进入原角色私聊。
`;
};

/** 分享到原角色私聊的是克制的返航简报，完整逐字档案仍留在下载文件里。 */
export const buildSARCharacterShareText = (
    card: SARIdentityCard,
    run: SARSimulationRun,
    messages: Message[],
    userName: string,
) => {
    const worldline = resolveSARWorldlineProfile(card);
    const userMask = resolveSARUserMaskProfile(card);
    const recent = messages.slice(-6).map(message => {
        const speaker = message.role === 'user' ? userName : card.charName;
        const worldNarration = message.role === 'assistant' ? cleanText(getSARWorldNarration(message), 600) : '';
        return `${worldNarration ? `世界意志：${worldNarration}\n` : ''}${speaker}：${cleanText(message.content, 1000)}`;
    }).join('\n\n');
    return `【SAR 返航简报｜${worldline.worldName}】
我从一条封存的异界坐标回来，选择把这份简报分享给你。

你在那里的异格：${card.profile.title}——${card.profile.identity}
我在那里的面具：${userMask.title}——${userMask.identity}
共同任务：${worldline.sharedObjective}
封存结果：${run.archiveReason === 'completed' ? `完成 ${run.interactionsUsed}/50 轮并返回现实` : `在 ${run.interactionsUsed}/50 轮执行紧急回收`}

【返航前的最后记录】
${recent || '没有留下可读取的对话。'}

这是一份由我主动交给你的推演档案，不是你在现实中原本拥有的记忆。你可以按自己的理解回应它。`.slice(0, 9000);
};

export const shareSARArchiveWithCharacter = async (input: {
    card: SARIdentityCard;
    run: SARSimulationRun;
    messages: Message[];
    userName: string;
}) => {
    const { card, run, messages, userName } = input;
    if (run.status !== 'archived') throw new Error('只有封存档案可以分享给角色');
    const current = readSARSimulationState();
    const persisted = current.runs.find(item => item.id === run.id);
    if (!persisted) throw new Error('封存实例不存在');
    if (persisted.sharedAt) return persisted;
    const sharedAt = Date.now();
    await DB.saveMessage({
        charId: card.charId,
        role: 'user',
        type: 'text',
        content: buildSARCharacterShareText(card, persisted, messages, userName),
        metadata: {
            source: 'sar_archive_share',
            sarArchiveRunId: run.id,
            sarArchiveCardId: card.id,
            sarArchiveSharedAt: sharedAt,
        },
    });
    const updated: SARSimulationRun = { ...persisted, sharedAt, updatedAt: sharedAt };
    writeSARSimulationState({
        ...current,
        runs: current.runs.map(item => item.id === run.id ? updated : item),
    });
    return updated;
};

export type ForgeSARIdentityInput = {
    char: CharacterProfile;
    variant: SARModuleDefinition;
    story: SARModuleDefinition;
    apiConfig: APIConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
};

/**
 * SAR 只继承角色本体、User 基础身份和关系门牌。
 * 这里故意不走 ContextBuilder：世界观、世界书、印象档案、长期摘要、详细记录、
 * 记忆宫殿召回、实时状态和情绪 Buff 都不应进入异界推演。
 */
export const buildSARLongTermContext = (
    char: CharacterProfile,
    userProfile: UserProfile,
    _legacyRecallContext = '',
    _legacyWorldbookQuery = '',
    includeRealityUserProfile = true,
) => {
    const roomPlate = char.memoryPalaceEnabled ? char.roomPlatesInjection?.trim() : '';
    return `【SAR 异界角色底稿】
角色名：${char.name}
用户备注：${char.description?.trim() || '无'}
核心人设：
${char.systemPrompt?.trim() || '保持角色原有且稳定的表达、价值判断与行动逻辑。'}

【互动对象】
名字：${userProfile.name}
${includeRealityUserProfile
        ? `现实基础设定（仅供铸造 User 面具）：${userProfile.bio?.trim() || '无'}`
        : '现实 User 设定已被异界面具替代；不得调用原 bio。'}

【现实关系门牌】
${roomPlate || '没有可用门牌；不要自行补写双方在现实中发生过的具体事件。'}

门牌只用于判断双方关系的形状、距离、信任与相处温度。不得引用、复述、猜测或补写现实聊天、日期、地点与共同事件；进入异界后，只让这份关系底色影响选择。`;
};

async function prepareSARDoorplateContext(
    char: CharacterProfile,
    userProfile: UserProfile,
    includeRealityUserProfile: boolean,
) {
    let freshRoomPlate = '';
    if (char.memoryPalaceEnabled) {
        try {
            const relationshipPlate = await RoomPlateDB.get(char.id, 'bedroom');
            freshRoomPlate = relationshipPlate
                ? formatRoomPlatesSection([relationshipPlate], userProfile.name)
                : '';
        } catch { /* 门牌不可用时宁可不给关系背景，也不回退到完整记忆上下文。 */ }
    }
    return buildSARLongTermContext({
        ...char,
        roomPlatesInjection: freshRoomPlate,
    }, userProfile, '', '', includeRealityUserProfile);
}

/**
 * 旧版身份卡没有独立的世界线剧情引擎。读取时按原卡、原模块补铸一份，
 * 不写回存档，也不要求用户重新抽卡；新卡则完整使用模型铸造的字段。
 */
export const resolveSARWorldlineProfile = (card: SARIdentityCard): SARWorldlineProfile => {
    const profile = card.profile;
    const story = getSARModuleById(card.storyId);
    const storyTitle = story?.title || '失控异世界';
    const storySummary = story?.summary || '陌生世界正在崩塌，你们已经被卷入无法旁观的事件。';
    const explicit = [
        profile.worldName,
        profile.worldPremise,
        profile.arrivalPoint,
        profile.activeCrisis,
        profile.sharedObjective,
        profile.countdown,
        profile.hiddenTruth,
        profile.climaxChoice,
    ].every(value => Boolean(value?.trim()));
    return {
        worldName: profile.worldName?.trim() || storyTitle,
        worldPremise: profile.worldPremise?.trim() || `${storySummary} ${card.charName}以「${profile.identity}」的身份活在这里，而你也已经成为这条世界线的一部分。`,
        arrivalPoint: profile.arrivalPoint?.trim() || `解释、试探和最初的相遇都已经结束。你与${card.charName}带着尚未说开的关系闯到了事件中后段；此刻的第 0 幕就是局势第一次彻底失控。`,
        activeCrisis: profile.activeCrisis?.trim() || `${storySummary} 危机已经发生，下一次迟疑就会产生不可撤回的后果。`,
        sharedObjective: profile.sharedObjective?.trim() || profile.playerPrompt || `与${card.charName}共同处理眼前危机，并在世界线封存前抵达唯一可行的出口。`,
        countdown: profile.countdown?.trim() || '不可逆条件已经启动；它会在这段五十轮生命结束以前兑现。',
        hiddenTruth: profile.hiddenTruth?.trim() || `你们对彼此在这条世界线中的身份与立场掌握着不完全相同的版本。`,
        climaxChoice: profile.climaxChoice?.trim() || `保住彼此当前的关系，或避开「${profile.patchCost}」带来的最终代价，两者无法同时完整实现。`,
        relationshipAnchor: `现实层只保留关系门牌「${profile.relationship}」。它可以影响信任、距离与选择的重量，但不得引用或补写任何现实具体事件。`,
        retrofitted: !explicit,
    };
};

/** 旧卡没有 User 面具时补一张中性身份；不把现实 User bio 带进异界。 */
export const resolveSARUserMaskProfile = (card: SARIdentityCard): SARUserMaskProfile => {
    const explicit = Boolean(
        card.profile.userMaskTitle?.trim()
        && card.profile.userIdentity?.trim()
        && card.profile.userLifePatch?.trim(),
    );
    const worldline = resolveSARWorldlineProfile(card);
    return {
        title: card.profile.userMaskTitle?.trim() || '无名越界者',
        identity: card.profile.userIdentity?.trim()
            || `你是被卷入「${worldline.worldName}」的越界者，与${card.charName}被同一项危机和共同任务绑定。你的能力、阵营与公开身份可以在行动中逐步确定。`,
        lifePatch: card.profile.userLifePatch?.trim()
            || '现实中的 User 设定不在这里生效；只保留双方原有的关系距离，所有异界经历从本世界线内部成立。',
        retrofitted: !explicit,
    };
};

export type SARSimulationPhase = {
    id: 'hot-drop' | 'cascade' | 'reversal' | 'climax' | 'cost' | 'return' | 'ending' | 'arrival';
    label: string;
    directive: string;
};

/** 50 次是一趟有明确返航窗口的异界航程，而不是被额度唐突截断的慢聊。 */
export const getSARSimulationPhase = (interactionsUsed: number): SARSimulationPhase => {
    const turn = Math.max(1, Math.min(SAR_SIMULATION_MAX_INTERACTIONS, interactionsUsed + 1));
    if (turn <= 3) return { id: 'hot-drop', label: '坠入高潮', directive: '从已经发生的动作或事故正中央继续；先让危险落地，再通过角色反应泄露必要信息。禁止从认识、寒暄、解释世界观开始。' };
    if (turn <= 12) return { id: 'cascade', label: '危机连锁', directive: '让上一轮选择产生具体后果，并加入新的阻碍、追兵、规则代价或被迫合作；关系必须在共同行动中变化。' };
    if (turn <= 24) return { id: 'reversal', label: '真相反转', directive: '逐步兑现隐藏真相，让旧判断失效；本阶段至少让阵营、任务、身份或关系中的一项发生不可逆反转。' };
    if (turn <= 38) return { id: 'climax', label: '高潮决断', directive: '进入连续高潮。主动逼近核心目标，让角色做高成本决定，并把用户放在清晰、具体、不能无限拖延的选择前。' };
    if (turn <= 44) return { id: 'cost', label: '代价兑现', directive: '让异格补丁的代价和此前选择真正落地；不撤销伤口，不用突发奇迹抹平后果，并把所有仍存活的主线推向同一个出口。' };
    if (turn <= 47) return { id: 'return', label: '返航征兆', directive: '明确显现异界坐标即将关闭的征兆，让 User 和角色都知道相处时间正在结束；清掉旁支、确认未竟事项，并把最终抉择放到触手可及的位置。' };
    if (turn <= 49) return { id: 'ending', label: '结局落定', directive: '完成最终抉择并兑现后果。不得再新增反派或主线；第 49 轮结束时返航入口必须已经出现，角色也必须有机会对即将分别或共同返航作出主动回应。' };
    return { id: 'arrival', label: '现实归还', directive: '这是唯一的第 50 轮。完成最后动作与最后一句真正需要说的话，然后让 User 明确穿过返航入口、回到现实，并让世界意志以客观旁白完成坐标闭合。禁止以悬念、提问、战斗中断或“未完待续”收尾。' };
};

export const buildSARIdentityForgeRequest = (
    char: Pick<CharacterProfile, 'name'>,
    variant: SARModuleDefinition,
    story: SARModuleDefinition,
) => `你现在是 SAR 活动室的异世界异格铸造设备。请读取角色「${char.name}」的核心人设、User 的基础设定与双方关系门牌，把两枚模块编译成一张角色专属异格身份卡、一张 User 异界面具，以及一条已经冲到中后段的高压异界世界线。

【异界异格母体】${variant.title}｜${variant.group}
${variant.summary}
【异界坐标模块】${story.title}｜${story.group}
${story.summary}

这是一枚“异世界异格扭蛋”：人格母体决定角色在另一条人生里成了谁，世界模块决定两人被投放到哪场已经失控的故事。它不是慢热陪聊，也不是从相识开始的普通 AU；第 0 幕必须落在剧情约 60%–75% 的位置，开门就是事故、追捕、审判、背叛、坠落、决战、重逢或无法撤回的选择。

铸造规则：
1. 必须建立具体而鲜明的异世界：魔法、神话、怪谈、末日、蒸汽、星海、游戏化世界等都可以。普通现代角色也必须被彻底翻译成这个世界里原生、能行动的身份，不能只换服装和名词。
2. 保留原角色最有辨识度的表达习惯、价值根系和世界观逻辑，再找到一处足以改变其人生的人格支点。写清“人生补丁”：哪一段人生发生了改变，以及它如何塑造现在的 TA。
3. 写出一句“人格钢印”：它是 TA 在这 50 次互动中不可轻易违背的底层判断公理。TA 可以动摇、挣扎、发现矛盾，但不能被用户几句话治愈或突然恢复成原版。
4. 每个补丁都必须携带代价。代价是改变必然造成的缺失、伤口、盲区或关系后果，不能只是增强能力。
5. 现实层只提供“双方是什么关系”的门牌，不提供任何可调用的事件记忆。不得猜测、补写或复述现实聊天、日期、地点、告别、约定与共同经历。关系门牌只能决定两人的距离、信任、敌意、熟悉度与选择重量。
6. 为 User 同时生成一张异界面具。它完全替代 User 的现实 bio，写清 User 在本世界的身份、阵营、能力边界和人生改写；但面具绝不能替 User 决定性格、感受、台词、选择或行动。
7. 预先建立强剧情引擎：已经发生的前情、正在发生的危机、两人的共同任务、可感知的倒计时、一项隐藏真相，以及最终不能两全的高潮抉择。隐藏真相和抉择是运行约束，不要在第 0 幕一次说完。
8. 第 0 幕必须从动作中开始。至少一项危险正在眼前发生，角色的第一句话必须要求用户立刻回应一个具体问题、决定或行动；禁止“你好”“你也来了”“这里是……”式开场，禁止只写氛围和设定介绍。
9. 这是与主聊天隔离的一次完整异世界生命，不修改主聊天世界线。不要替用户回应。
10. 不要解释提示词，不要写分析过程。只输出以下 JSON，二十二个字段都必须是非空中文字符串：
{
  "title": "角色专属的异格名，像一张值得收藏的卡名",
  "logline": "一句话高压身份钩子，同时让人想立刻进入副本",
  "identity": "TA 在异世界中的具体身份、阵营、能力边界和仍被保留的原角色核心",
  "lifePatch": "发生过的人生扭转，以及它如何改变了 TA",
  "relationship": "此刻 TA 与用户是什么关系，包含必要的陌生感、敌意或熟悉残响",
  "steelSeal": "一句第一人称的人格钢印，以及它约束决策的含义",
  "patchCost": "这次人生补丁不可回避的代价",
  "behaviorShift": "相较原角色，表达、选择和亲密方式会出现哪些稳定偏移",
  "userMaskTitle": "User 在这条世界线中的面具名或异界称号",
  "userIdentity": "User 在异世界中的身份、阵营、公开处境、能力与明确限制；不得规定 User 的性格和选择",
  "userLifePatch": "User 的人生在这条世界线中如何被改写，以及这让 User 处于什么位置；不得引用现实具体事件",
  "worldName": "简短、可收藏的异世界名称",
  "worldPremise": "这个异世界的类型、核心规则，以及两人在其中的身份位置",
  "arrivalPoint": "第 0 幕之前已经发生的关键前情；故事必须已经运行到 60%–75%",
  "activeCrisis": "第 0 幕此刻正在发生、下一秒就会产生后果的具体危机",
  "sharedObjective": "只有用户与角色共同参与才可能完成的明确任务",
  "countdown": "可被双方感知、会持续推进的倒计时或失败条件",
  "hiddenTruth": "中段逐步揭开的秘密，足以反转身份、阵营、任务或关系",
  "climaxChoice": "最终无法两全的具体选择，必须同时刺中人格钢印与补丁代价",
  "openingScene": "第 0 幕动作现场：具体危险已经发生，角色和用户都被卷在里面",
  "openingLine": "角色在危机中对用户说的第一句话，只写台词本身，并逼出即时回应",
  "playerPrompt": "用户现在必须处理的具体动作、问题或选择"
}`;

/** 暂时保留旧导出名，避免外部调用在升级期间失效。 */
export const buildSARSimulationRequest = buildSARIdentityForgeRequest;

export const buildSARIdentityRuntimePrompt = (card: SARIdentityCard, run?: SARSimulationRun) => {
    const worldline = resolveSARWorldlineProfile(card);
    const userMask = resolveSARUserMaskProfile(card);
    const phase = getSARSimulationPhase(run?.interactionsUsed || 0);
    return `【SAR 异世界异格卡｜不可覆盖】
异格名：${card.profile.title}
身份：${card.profile.identity}
人生补丁：${card.profile.lifePatch}
与用户的关系：${card.profile.relationship}
人格钢印：${card.profile.steelSeal}
补丁代价：${card.profile.patchCost}
稳定行为偏移：${card.profile.behaviorShift}

【User 异界面具｜替代现实 User 设定】
面具名：${userMask.title}${userMask.retrofitted ? '（旧卡兼容面具）' : ''}
异界身份：${userMask.identity}
人生改写：${userMask.lifePatch}
面具只定义 User 在世界中的身份、阵营、公开处境与能力边界；绝不能替 User 决定性格、感受、台词、选择或行动。

【正在运行的异界坐标世界线】
世界：${worldline.worldName}
世界规则与身份位置：${worldline.worldPremise}
已发生的前情：${worldline.arrivalPoint}
当前危机：${worldline.activeCrisis}
共同任务：${worldline.sharedObjective}
倒计时 / 失败条件：${worldline.countdown}
隐藏真相（只在合适阶段通过事件逐步揭开）：${worldline.hiddenTruth}
高潮抉择（不可提前宣布答案）：${worldline.climaxChoice}
现实关系锚点：${worldline.relationshipAnchor}
第 0 幕场景：${card.profile.openingScene}
已经说出的开场台词：${card.profile.openingLine}
最初留给用户的回应入口：${card.profile.playerPrompt}

运行规则：
- 这是与主聊天隔离的固定 50 次互动实例，当前进度 ${run?.interactionsUsed || 0}/${run?.maxInteractions || SAR_SIMULATION_MAX_INTERACTIONS}。
- 下一轮所处阶段：${phase.label}。${phase.directive}
- User 是被投放到异界坐标的现实来访者；异界身份由面具成立。第 45 轮开始必须让坐标关闭变得可感知，第 48–49 轮落定结局，第 50 轮必须让 User 真正回到现实并完成封存，绝不能被额度唐突截断。
- 故事从约 60%–75% 的位置开始，不进行相识、日常铺垫或慢热预热。每次回应都必须让世界线继续发生，而不是解释模块、复述档案或停下来陪聊。
- 人格钢印必须持续参与判断。允许动摇、挣扎和产生矛盾，禁止突然治愈、撤销人生补丁或无理由恢复成原角色。
- 第 0 幕和开场台词已经发生；只有在 0/50 的第一轮承接它，后续不得重演开场。
- 每轮至少完成一项可观察推进：局势改变、线索揭露、倒计时前进、关系转折、代价落地或迫使具体选择。连续两轮只有情绪确认、闲聊、回忆或气氛描写属于失败。
- 现实层没有可调用的事件记忆。不得引用、复述、猜测或补写现实聊天、日期、地点与共同经历；只允许关系门牌影响双方的距离、信任和选择重量。
- 角色必须拥有自己的任务、误判、私心和主动行动，不能永远等待用户提问。结尾留下迫近钩子：新的事实、危险、要求、决定或已发生的动作，而不是泛泛询问“你想怎么办”。
- 不得替用户决定行动、感受或台词。${worldline.retrofitted ? '\n- 这是旧版卡的补铸世界线：从本轮起让异世界危机直接闯入现有记录，不解释升级，也不要求重新认识。' : ''}`;
};

export const buildSARSimulationTurnPrompt = (
    card: SARIdentityCard,
    run: SARSimulationRun,
    mode: SARInteractionMode,
) => `${buildSARIdentityRuntimePrompt(card, run)}

【本轮交互方式】${mode === 'online' ? '线上文字' : '线下同场'}
${mode === 'online'
        ? `- 你和用户此刻通过符合世界观的远程方式保持文字联系。character 字段只写角色真正发出的消息；允许自然分段，但不要写小说旁白、镜头说明、说话人标签或消息气泡编号。`
        : `- 你与用户此刻处于同一个可感知的场景。character 字段可以写角色能够感知的环境变化、动作、停顿与台词，但必须从角色能感知和做出的范围出发，不替用户行动。`}
- 线上与线下属于同一条连续世界线，切换方式不会重置关系、记忆、场景后果或人格钢印。
- 如果上一轮交互方式不同，只承接已经发生或当下能够成立的分离、会合与通讯，不凭空传送，也不要解释界面模式。
- 用户的选择可以改变路径、阵营与结局，但世界不会停下来等待。只演出这一轮真正发生的片段；除最后三轮外，不要总结未来、提前宣布结局或一次跨越很长时间。
- 不要用设定说明代替戏剧，不要在危险中进行百科介绍。需要解释的信息应通过角色的即时行动、误判、受伤、隐瞒、命令或被迫选择自然暴露。

【世界意志｜旁白与航向】
- 世界意志是客观的叙事与节奏层，不是角色、系统主持人或可互动 NPC。它负责世界反应、场景切换、敌人/规则行动、倒计时、阶段推进与返航窗口，让玩家不必自己承担剧本规划。
- worldNarration 字段写 1–3 个短段落，以自然的小说旁白呈现本轮真正发生的外部变化。它可以制造压力和抛出可回应局面，但不能用第一人称和 User 对话，不能替 User 或角色决定动作、心理、台词与选择，也不能泄露未到阶段的隐藏真相。
- character 字段专属于角色。角色仍有自己的目标、判断、误判与主动行动；世界意志不能夺走角色的戏份，也不能把角色降格成讲解员。
- 两层必须彼此接续：世界意志先让世界发生，角色再在同一事件中行动或说话。不要重复同一句信息。

只输出一个合法 JSON 对象，不要代码围栏、分析或额外文字：
{"worldNarration":"本轮自然发生的世界、场景、倒计时或返航旁白","character":"本轮角色真正呈现给 User 的动作与台词"}`;

export const resolveSARSimulationApi = (char: CharacterProfile, vrGlobalApi: APIConfig | null, chatApi: APIConfig): APIConfig =>
    char.vrState?.api?.baseUrl ? { ...chatApi, ...char.vrState.api } : (vrGlobalApi?.baseUrl ? vrGlobalApi : chatApi);

export async function forgeSARIdentityCard(input: ForgeSARIdentityInput): Promise<SARIdentityCard> {
    const { char, variant, story, apiConfig, userProfile } = input;
    if (variant.pool !== 'variant' || story.pool !== 'story') throw new Error('模块槽位类型不匹配');
    const collection = readSARGachaState().collection;
    if (!collection[variant.id] || !collection[story.id]) throw new Error('装入的模块不在陈列收藏中');

    const vrGlobalApi = await getVRApi();
    const api = resolveSARSimulationApi(char, vrGlobalApi, apiConfig);
    if (!api?.baseUrl || !api.model) throw new Error('请先在「彼方 → API」配置可用模型');

    const longTermContext = await prepareSARDoorplateContext(char, userProfile, true);
    const systemPrompt = `${longTermContext}\n\n【SAR 异世界异格铸造】\n你必须理解角色本人，并把现实 User 基础设定改写成一张异界面具。现实关系只读取门牌，不存在可调用的事件记忆；当前输出是供设备保存的结构化异界身份卡，不是主聊天回复。禁止调用工具、发送 HTML、替用户说话或夹带 JSON 之外的文字。`;
    const baseUrl = api.baseUrl.replace(/\/+$/, '');
    const callStart = Date.now();
    let data: any;
    try {
        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
            body: JSON.stringify({
                model: api.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: buildSARIdentityForgeRequest(char, variant, story) },
                ],
                temperature: 0.88,
                max_tokens: 8000,
                stream: false,
            }),
        }, 2, 0, { appName: '彼方', charId: char.id, charName: char.name, purpose: 'SAR 异世界异格铸造' });
        void logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, room: 'sar-cabinet', model: api.model, baseUrl, ok: true, ms: Date.now() - callStart });
    } catch (error: any) {
        void logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, room: 'sar-cabinet', model: api.model, baseUrl, ok: false, ms: Date.now() - callStart, error: (error?.message || String(error)).slice(0, 160) });
        throw error;
    }

    const raw = data?.choices?.[0]?.message?.content || '';
    const profile = parseSARIdentityProfile(raw);
    if (!profile) throw new Error('模型没有返回完整的异格身份卡，请重试');
    const now = Date.now();
    const card: SARIdentityCard = {
        id: `sar_card_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        charId: char.id,
        charName: char.name,
        charAvatar: char.avatar || undefined,
        variantId: variant.id,
        storyId: story.id,
        createdAt: now,
        updatedAt: now,
        profile,
    };
    saveSARIdentityCard(card);
    return card;
}

export type RunSARSimulationTurnInput = {
    card: SARIdentityCard;
    run: SARSimulationRun;
    char: CharacterProfile;
    userProfile: UserProfile;
    apiConfig: APIConfig;
    mode: SARInteractionMode;
    userText: string;
    onDelta?: (fullText: string) => void;
};

const modeLabel = (mode: SARInteractionMode) => mode === 'online' ? '线上文字' : '线下同场';

const extractSARAssistantRaw = (data: any) => {
    const content = data?.choices?.[0]?.message?.content;
    const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
            ? content.map(part => typeof part === 'string' ? part : (part?.text || '')).join('')
            : '';
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().slice(0, 16000);
};

export async function runSARSimulationTurn(input: RunSARSimulationTurnInput) {
    const { card, run, char, userProfile, apiConfig, mode, onDelta } = input;
    const userText = input.userText.trim().slice(0, 4000);
    if (!userText) throw new Error('先写下这一轮想说的话');
    if (card.id !== run.cardId || card.charId !== char.id) throw new Error('异格身份与推演实例不匹配');
    if (run.status !== 'active') throw new Error('这段推演已经封存');
    if (run.interactionsUsed >= SAR_SIMULATION_MAX_INTERACTIONS) throw new Error('这段推演已经完成五十次互动');

    const persisted = readSARSimulationState().runs.find(item => item.id === run.id);
    if (!persisted || persisted.status !== 'active') throw new Error('这段推演已经封存');
    if (persisted.interactionsUsed !== run.interactionsUsed) throw new Error('推演进度已变化，请重新进入');

    const history = await loadSARSimulationMessages(run.id);
    const threadId = getSARSimulationThreadId(run.id);
    const longTermContext = await prepareSARDoorplateContext(char, userProfile, false);
    const systemPrompt = `${longTermContext}\n\n${buildSARSimulationTurnPrompt(card, run, mode)}`;

    const vrGlobalApi = await getVRApi();
    const api = resolveSARSimulationApi(char, vrGlobalApi, apiConfig);
    if (!api?.baseUrl || !api.model) throw new Error('请先在「彼方 → API」配置可用模型');
    const baseUrl = api.baseUrl.replace(/\/+$/, '');
    const apiMessages = history
        .filter(message => message.role === 'user' || message.role === 'assistant')
        .map(message => ({
            role: message.role,
            content: message.role === 'assistant'
                ? `【交互记录：${modeLabel(message.metadata?.sarMode === 'offline' ? 'offline' : 'online')}】\n${getSARWorldNarration(message) ? `【世界意志】\n${getSARWorldNarration(message)}\n` : ''}【${card.charName}】\n${message.content}`
                : `【交互记录：${modeLabel(message.metadata?.sarMode === 'offline' ? 'offline' : 'online')}】\n${message.content}`,
        }));
    apiMessages.push({ role: 'user', content: `【本轮：${modeLabel(mode)}】\n${userText}` });

    const callStart = Date.now();
    let data: any;
    try {
        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
            body: JSON.stringify({
                model: api.model,
                messages: [{ role: 'system', content: systemPrompt }, ...apiMessages],
                temperature: api.temperature ?? 0.88,
                max_tokens: 3200,
                stream: api.stream === true,
            }),
        }, 0, 0, {
            appName: '彼方',
            charId: char.id,
            charName: char.name,
            purpose: `SAR 正式推演 ${run.interactionsUsed + 1}/${run.maxInteractions}`,
        }, api.stream === true && onDelta ? {
            // 双层 JSON 在完整闭合前不直接显示，避免把半截引号/转义符泄露给玩家。
            onDelta: () => onDelta(''),
        } : undefined);
        void logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, room: 'sar-simulation', model: api.model, baseUrl, ok: true, ms: Date.now() - callStart });
    } catch (error: any) {
        void logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, room: 'sar-simulation', model: api.model, baseUrl, ok: false, ms: Date.now() - callStart, error: (error?.message || String(error)).slice(0, 160) });
        throw error;
    }

    const parsedReply = parseSARSimulationReply(extractSARAssistantRaw(data));
    if (!parsedReply?.character) throw new Error('模型没有返回可保存的推演正文，请重试');
    const reply = parsedReply.character;

    const turn = run.interactionsUsed + 1;
    let userMessageId: number | null = null;
    try {
        userMessageId = await DB.saveMessage({
            charId: threadId,
            role: 'user',
            type: 'text',
            content: userText,
            metadata: { source: SAR_SIMULATION_MESSAGE_SOURCE, sarRunId: run.id, sarCardId: card.id, sarMode: mode, sarTurn: turn },
        });
        await DB.saveMessage({
            charId: threadId,
            role: 'assistant',
            type: 'text',
            content: reply,
            metadata: { source: SAR_SIMULATION_MESSAGE_SOURCE, sarRunId: run.id, sarCardId: card.id, sarMode: mode, sarTurn: turn, sarWorldNarration: parsedReply.worldNarration },
        });
    } catch (error) {
        if (userMessageId !== null) await DB.deleteMessages([userMessageId]).catch(() => undefined);
        throw error;
    }
    const updatedRun = completeSARSimulationTurn(run.id, run.interactionsUsed);
    return { reply, run: updatedRun, messages: await loadSARSimulationMessages(run.id) };
}

export const resolveSARSimulationModules = (source: Pick<SARIdentityCard, 'variantId' | 'storyId'>) => ({
    variant: getSARModuleById(source.variantId),
    story: getSARModuleById(source.storyId),
});
