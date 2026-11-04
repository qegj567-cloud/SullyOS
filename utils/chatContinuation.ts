type Speaker = { role: string; id?: number; metadata?: any };

const isSpeaker = (message: Speaker): boolean =>
    !message.metadata?.homeSceneRecord && (message.role === 'user' || message.role === 'assistant');

const lastSpeakerRole = (messages: Speaker[]): string | undefined =>
    [...messages].reverse().find(isSpeaker)?.role;

/** 定时主动消息落库的气泡带非空的 activeMsg2.taskId；即时对话的回复那里是 null。 */
const isScheduledProactive = (message: Speaker): boolean =>
    message.role === 'assistant' && message.metadata?.activeMsg2?.taskId != null;

/**
 * 点发送时最后说话的是用户，读历史时那句话后面却多了角色的定时主动消息：它们是生成前
 * 刚收下的，用户那句话还没人回。后面跟的若是别的东西（比如上一轮迟到的回复）不算。
 */
export function hasUnansweredUserTurn(messagesAtSend: Speaker[], historyForRequest: Speaker[]): boolean {
    if (lastSpeakerRole(messagesAtSend) !== 'user') return false;
    const pendingUser = [...messagesAtSend].reverse().find(message => message.role === 'user');
    const speakers = historyForRequest.filter(message => isSpeaker(message)
        // 旧剧情的虚拟时间可能排在输入后；它早已落库，不是对当前输入的回复。
        && !(message.metadata?.source === 'story_theater_memory' && message.id != null
            && pendingUser?.id != null && message.id < pendingUser.id));
    const lastUserAt = speakers.map(message => message.role).lastIndexOf('user');
    const tail = speakers.slice(lastUserAt + 1);
    return lastUserAt >= 0 && tail.length > 0 && tail.every(isScheduledProactive);
}

/**
 * 历史以角色发言结尾时补一条仅本次请求可见的提示，不伪造或持久化用户聊天记录。
 * 平时是续说；unansweredUserTurn 为真时末尾那几条是角色先前主动发出、刚送达的消息，
 * 提示改成回应用户刚说的话。
 */
export function withChatContinuation<T extends { role: string; content: any }>(
    messages: T[],
    userName?: string,
    options: { unansweredUserTurn?: boolean } = {},
): Array<T | { role: string; content: string }> {
    if (lastSpeakerRole(messages) !== 'assistant') return messages;
    const name = userName?.trim() || '对方';
    return [...messages, {
        role: 'user',
        content: options.unansweredUserTurn
            ? `[上面最后这几句是你先前主动发给${name}的消息，刚刚才送达，不是对${name}那句话的回应。${name}刚才说的话还没有人回，现在回应它；不要重复或续写那几句。]`
            : `[${name}还想听你接着说。顺着刚才的话自然继续，只写你自己的话，说完就等${name}回应。]`,
    }];
}
