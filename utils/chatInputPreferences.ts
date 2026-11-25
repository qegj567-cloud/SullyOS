/** 当前设备上的私聊与群聊共用的输入习惯。 */
export interface ChatInputPreferences {
    sendButtonGenerates: boolean;
    enterToSend: boolean;
    autoReply: boolean;
    emojiSuggestions: boolean;
    skipRerollConfirm?: boolean;
    linkCards?: boolean;
    xhsCards?: boolean;
    linkCardNoticeSeen?: boolean;
    xhsCardNoticeSeen?: boolean;
}

export const CHAT_INPUT_PREFERENCES_KEY = 'sully-chat-input-preferences-v1';

export const DEFAULT_CHAT_INPUT_PREFERENCES: ChatInputPreferences = {
    sendButtonGenerates: false,
    enterToSend: true,
    autoReply: false,
    emojiSuggestions: false,
    linkCards: true,
    xhsCards: true,
    linkCardNoticeSeen: false,
    xhsCardNoticeSeen: false,
};

/** 导入与读取共用：只接收已知布尔字段；链接解析沿用旧行为，其余新功能对旧存档默认关闭。 */
export const normalizeChatInputPreferences = (value: unknown): ChatInputPreferences => {
    const saved = value && typeof value === 'object' ? value as Partial<ChatInputPreferences> : {};
    return {
        ...(saved.skipRerollConfirm === true ? { skipRerollConfirm: true } : {}),
        sendButtonGenerates: saved.sendButtonGenerates === true,
        enterToSend: saved.enterToSend !== false,
        autoReply: saved.autoReply === true,
        emojiSuggestions: saved.emojiSuggestions === true,
        // Existing automatic link conversion stays enabled until explicitly disabled.
        linkCards: saved.linkCards !== false,
        xhsCards: saved.xhsCards !== false,
        linkCardNoticeSeen: saved.linkCardNoticeSeen === true,
        xhsCardNoticeSeen: saved.xhsCardNoticeSeen === true,
    };
};

export const loadChatInputPreferences = (): ChatInputPreferences => {
    try {
        const saved = JSON.parse(localStorage.getItem(CHAT_INPUT_PREFERENCES_KEY) || 'null');
        return normalizeChatInputPreferences(saved);
    } catch {
        return { ...DEFAULT_CHAT_INPUT_PREFERENCES };
    }
};

export const saveChatInputPreferences = (preferences: ChatInputPreferences): void => {
    try {
        localStorage.setItem(CHAT_INPUT_PREFERENCES_KEY, JSON.stringify(normalizeChatInputPreferences(preferences)));
    } catch {
        // 存储不可用的 WebView 中仍允许在当前会话使用。
    }
};
