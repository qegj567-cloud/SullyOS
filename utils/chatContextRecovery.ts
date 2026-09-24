import type { CharacterProfile, Message } from '../types';
import { resolveContextRangeMode } from './chatContextRange';
import { isVisibleChatMessage } from './chatMessageVisibility';

/**
 * 自动归档把本轮待回复消息一起挡住时，只为这次请求恢复最后一轮用户输入。
 * 候选必须来自 DB；不修改角色配置/水位，不恢复已获回复的旧轮次，不跨用户断点。
 */
export function recoverPendingChatTurn(
    selected: Message[],
    recentPersisted: Message[],
    char: CharacterProfile,
): { messages: Message[]; character: CharacterProfile; recovered: boolean } {
    const unchanged = { messages: selected, character: char, recovered: false };
    if (resolveContextRangeMode(char) !== 'adaptive'
        || selected.some(message => message.role === 'user' || message.role === 'assistant')) return unchanged;

    const userStart = char.contextUserStartMessageId
        ?? ((char.contextRangePolicyVersion || 0) < 1 ? char.hideBeforeMessageId : undefined);
    const dialogue = recentPersisted
        .filter(message => message.charId === char.id && isVisibleChatMessage(message)
            && (message.role === 'user' || message.role === 'assistant'))
        .slice().sort((a, b) => a.id - b.id);
    let lastAssistant = dialogue.length - 1;
    while (lastAssistant >= 0 && dialogue[lastAssistant].role !== 'assistant') lastAssistant--;
    const pending = dialogue.slice(lastAssistant + 1)
        .filter(message => (!userStart || message.id >= userStart)
            && (message.type !== 'text' || !!message.content?.trim()));
    if (!pending.length) return unchanged;

    return {
        messages: pending,
        // 请求内的投影：后面的两次范围校验不能又用归档水位删掉恢复的这一轮。
        character: {
            ...char,
            contextRangePolicyVersion: 1,
            contextRangeMode: 'manual',
            contextLimit: Math.max(10, pending.length),
            contextUserStartMessageId: pending[0].id,
        },
        recovered: true,
    };
}
