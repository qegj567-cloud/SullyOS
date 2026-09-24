import type { CharacterProfile, Message } from '../types';
import { DB } from './db';

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

const chronologicalPrivateMessages = (messages: Message[]): Message[] =>
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
export const computeContextRangeSnapshot = (
    sourceMessages: Message[],
    char: CharacterProfile,
    hwm: number,
): ContextRangeSnapshot => {
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

/**
 * AI 上下文读取：
 * - adaptive 读取水位线后的完整原文（全自动记忆或一键存入后的水位跟随）；
 * - manual 忽略水位线，读取完整库最近 N 条；
 * - 随后再用用户断点收窄。
 */
export const loadCharacterContextRange = async (
    char: CharacterProfile,
): Promise<ContextRangeSnapshot> => {
    const hwm = getMemoryPalaceHighWaterMarkForContext(char.id);
    const mode = resolveContextRangeMode(char);
    const sourceMessages = mode === 'adaptive'
        ? (await DB.getMessagesFromId(char.id, hwm + 1)).messages
        : await DB.getRecentMessagesByCharId(
            char.id,
            clampManualContextLimit(char.contextLimit),
            true,
        );
    return computeContextRangeSnapshot(sourceMessages, char, hwm);
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

/** 已有消息快照的入口也遵守同一边界，不能用残留的手动条数截断自适应范围。 */
export const selectCharacterContextMessages = (messages: Message[], char: CharacterProfile, hwm = getMemoryPalaceHighWaterMarkForContext(char.id)): Message[] =>
    computeContextRangeSnapshot(messages, (char.contextRangePolicyVersion || 0) >= 1 ? char : {
        ...char, contextUserStartMessageId: char.contextUserStartMessageId ?? char.hideBeforeMessageId,
    }, hwm).messages;
