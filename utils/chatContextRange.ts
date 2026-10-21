import type { CharacterProfile, Message } from '../types';
import { DB } from './db';
import { getReliableMemoryPalaceHighWaterMark } from './memoryPalace/highWaterMark';

export const CONTEXT_RANGE_POLICY_VERSION = 1;
export const DEFAULT_MANUAL_CONTEXT_LIMIT = 500;
export const MIN_MANUAL_CONTEXT_LIMIT = 10;
export const MAX_MANUAL_CONTEXT_LIMIT = 5000;

export type ContextRangeMode = 'adaptive' | 'manual';

export interface ContextRangeSnapshot {
    mode: ContextRangeMode;
    hwm: number;
    maxRangeStartMessageId?: number;
    effectiveStartMessageId?: number;
    userStartMessageId?: number;
    userBreakpointExpired: boolean;
    messages: Message[];
}

export interface CharacterContextRangeMigration {
    character: CharacterProfile;
    migrated: boolean;
    resetAutoContext: boolean;
}

const positiveMessageId = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;

export const clampManualContextLimit = (value: unknown): number => {
    const parsed = typeof value === 'number' && Number.isFinite(value)
        ? Math.floor(value)
        : DEFAULT_MANUAL_CONTEXT_LIMIT;
    return Math.max(MIN_MANUAL_CONTEXT_LIMIT, Math.min(MAX_MANUAL_CONTEXT_LIMIT, parsed));
};

/**
 * adaptive 只在有明确来源时接管范围：全自动记忆，或用户主动执行过一键存入。
 * 单独残留一个 adaptive 旧字段仍按 manual 处理，避免不存在的自动模式限制用户。
 */
export const resolveContextRangeMode = (char: CharacterProfile): ContextRangeMode =>
    char.contextRangeMode === 'adaptive'
    && (char.autoArchiveEnabled || char.contextFollowsMemoryPalaceHwm)
        ? 'adaptive'
        : 'manual';

export const getMemoryPalaceHighWaterMarkForContext = (charId: string): number => {
    try {
        const value = parseInt(localStorage.getItem(`mp_lastMsgId_${charId}`) || '0', 10);
        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
        return 0;
    }
};

/**
 * 一次性迁移旧角色：
 * - 已开全自动记忆：无论旧拉杆是否为 5000，都回到 adaptive + 默认 500；
 * - 未开全自动：保留旧拉杆，并把旧版手动断点迁成用户断点。
 *
 * hideBeforeMessageId 仍保留给旧归档内部使用，但新版 prompt 不再把它当用户范围。
 */
export const migrateCharacterContextRange = (
    char: CharacterProfile,
): CharacterContextRangeMigration => {
    if ((char.contextRangePolicyVersion || 0) >= CONTEXT_RANGE_POLICY_VERSION) {
        return { character: char, migrated: false, resetAutoContext: false };
    }

    const resetAutoContext = !!char.autoArchiveEnabled;
    const next: CharacterProfile = {
        ...char,
        contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
        contextRangeMode: resetAutoContext ? 'adaptive' : 'manual',
        contextLimit: resetAutoContext
            ? DEFAULT_MANUAL_CONTEXT_LIMIT
            : clampManualContextLimit(char.contextLimit),
        contextUserStartMessageId: resetAutoContext
            ? undefined
            : positiveMessageId(char.hideBeforeMessageId),
    };

    return { character: next, migrated: true, resetAutoContext };
};

const chronologicalPrivateMessages = <T extends Pick<Message, 'id' | 'groupId'>>(messages: T[]): T[] =>
    messages
        .filter(message => !message.groupId)
        .slice()
        .sort((a, b) => a.id - b.id);

/**
 * 纯边界计算。方向不变式（Message.id 越大越新）：
 * - 最大范围起点越大，可读范围越小；
 * - 用户断点只能 >= 最大范围起点；
 * - 最终起点永远取两者中更大的 id，绝不会越过最大范围向旧消息扩张。
 */
const computeContextRangeFromRefs = <T extends Pick<Message, 'id' | 'groupId'>>(
    sourceMessages: T[],
    char: CharacterProfile,
    hwm: number,
): Omit<ContextRangeSnapshot, 'messages'> & { messages: T[] } => {
    const allMessages = chronologicalPrivateMessages(sourceMessages);
    const mode = resolveContextRangeMode(char);
    const maxRangeMessages = mode === 'adaptive'
        ? allMessages.filter(message => message.id > hwm)
        : allMessages.slice(-clampManualContextLimit(char.contextLimit));

    const maxRangeStartMessageId = maxRangeMessages[0]?.id;
    const latestMessageId = maxRangeMessages[maxRangeMessages.length - 1]?.id;
    const requestedUserStart = positiveMessageId(char.contextUserStartMessageId);
    const requestedMessageStillExists = requestedUserStart === undefined
        || maxRangeMessages.some(message => message.id === requestedUserStart);
    const userBreakpointExpired = !!requestedUserStart && (
        maxRangeStartMessageId === undefined
        || latestMessageId === undefined
        || requestedUserStart < maxRangeStartMessageId
        || requestedUserStart > latestMessageId
        || !requestedMessageStillExists
    );
    const userStartMessageId = userBreakpointExpired ? undefined : requestedUserStart;
    const effectiveStartMessageId = maxRangeStartMessageId === undefined
        ? undefined
        : Math.max(maxRangeStartMessageId, userStartMessageId || maxRangeStartMessageId);
    const messages = effectiveStartMessageId === undefined
        ? []
        : maxRangeMessages.filter(message => message.id >= effectiveStartMessageId);

    return {
        mode,
        hwm,
        maxRangeStartMessageId,
        effectiveStartMessageId,
        userStartMessageId,
        userBreakpointExpired,
        messages,
    };
};

export const computeContextRangeSnapshot = (
    sourceMessages: Message[], char: CharacterProfile, hwm: number,
): ContextRangeSnapshot => {
    const snapshot = computeContextRangeFromRefs(sourceMessages, char, hwm);
    // Boundary-only references have no timestamp. Sort actual dialogue after ID filtering.
    snapshot.messages.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
    return snapshot;
};

/**
 * AI 上下文读取：
 * - adaptive 读取水位线后的完整原文（全自动记忆或一键存入后的水位跟随）；
 * - manual 忽略水位线，读取完整库最近 N 条；
 * - 随后再用用户断点收窄。
 */
export const loadCharacterContextRange = async (
    char: CharacterProfile,
    onTiming?: (stage: string, ms: number) => void,
): Promise<ContextRangeSnapshot> => {
    let started = performance.now();
    await DB.ensureHomeContextMessages(char.id);
    onTiming?.("家园历史同步检查", Math.round(performance.now()-started));
    started = performance.now();
    const mode = resolveContextRangeMode(char);
    const localHwm = getMemoryPalaceHighWaterMarkForContext(char.id);
    const hwm = mode === 'adaptive' && localHwm === 0
        ? await getReliableMemoryPalaceHighWaterMark(char.id)
        : localHwm;
    const sourceMessages = mode === 'adaptive'
        ? (await DB.getMessagesFromId(char.id, hwm + 1)).messages
        : await DB.getRecentMessagesByCharId(
            char.id,
            clampManualContextLimit(char.contextLimit),
            true,
        );
    onTiming?.('读取范围内原文', Math.round(performance.now()-started));
    started = performance.now();
    const snapshot = computeContextRangeSnapshot(sourceMessages, char, hwm);
    onTiming?.('计算上下文边界', Math.round(performance.now()-started));
    return snapshot;
};

export const countMessagesFrom = (messages: Message[], messageId: number): number =>
    chronologicalPrivateMessages(messages).filter(message => message.id >= messageId).length;

/** 所有 AI 入口共用的原文范围。UI 浏览、导出、记忆整理仍直接使用 DB。 */
export const loadCharacterContextMessages = async (
    character: CharacterProfile | string,
): Promise<Message[]> => {
    const char = typeof character === 'string' ? await DB.getCharacter(character) : character;
    if (!char) return [];
    return (await loadCharacterContextRange(char)).messages;
};

/** 浏览界面只判断可见性，不加载聊天正文；沿用同一断点失效与范围规则。 */
export const loadCharacterContextMessageIds = async (char: CharacterProfile, candidates: Pick<Message, 'id'>[]): Promise<Set<number>> => {
    const mode = resolveContextRangeMode(char);
    const localHwm = getMemoryPalaceHighWaterMarkForContext(char.id);
    const hwm = mode === 'adaptive' && localHwm === 0
        ? await getReliableMemoryPalaceHighWaterMark(char.id)
        : localHwm;
    if (mode === 'adaptive') {
        // 自适应没有条数窗口：只验证断点是否仍是该角色水位线后的私聊消息。
        // 不为几十条动态扫描几万条原文。
        const requested = positiveMessageId(char.contextUserStartMessageId);
        const breakpoint = requested && requested > hwm ? await DB.getMessageById(requested) : null;
        const start = breakpoint && breakpoint.charId === char.id && !breakpoint.groupId ? breakpoint.id : hwm + 1;
        return new Set(candidates.filter(message => message.id >= start).map(message => message.id));
    }
    const refs = await DB.getPrivateMessageRefs(char.id, clampManualContextLimit(char.contextLimit));
    return new Set(computeContextRangeFromRefs(refs, char, hwm).messages.map(message => message.id));
};

/** 已有消息快照的入口也遵守同一边界，不能用残留的手动条数截断自适应范围。 */
export const selectCharacterContextMessages = (messages: Message[], char: CharacterProfile, hwm = getMemoryPalaceHighWaterMarkForContext(char.id)): Message[] =>
    computeContextRangeSnapshot(messages, (char.contextRangePolicyVersion || 0) >= 1 ? char : {
        ...char, contextUserStartMessageId: char.contextUserStartMessageId ?? char.hideBeforeMessageId,
    }, hwm).messages;
