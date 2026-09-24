type ChatRequestMessage = { role: string; content?: unknown };

/** 只验证本轮可见消息，不扩张用户范围，也不伪造用于绕过上游校验的用户消息。 */
export function assertChatHasDialogue(messages: readonly ChatRequestMessage[]): void {
    const hasDialogue = messages.some(message => {
        if (message.role !== 'user' && message.role !== 'assistant') return false;
        if (typeof message.content === 'string') return message.content.trim().length > 0;
        if (!Array.isArray(message.content)) return false;
        return message.content.some(part => {
            if (!part || typeof part !== 'object') return false;
            if (part.type === 'text') return typeof part.text === 'string' && !!part.text.trim();
            if (part.type === 'image_url') return typeof part.image_url?.url === 'string' && !!part.image_url.url.trim();
            return false;
        });
    });
    if (!hasDialogue) {
        throw new Error('暂时没有找到可以回复的聊天内容，请再发一条消息。已有聊天和记忆均保留。');
    }
}
