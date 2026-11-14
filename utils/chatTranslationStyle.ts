export type ChatTranslationStyle = 'bubble' | 'subtitle';

export function normalizeChatTranslationStyle(value: unknown): ChatTranslationStyle {
    return value === 'subtitle' ? 'subtitle' : 'bubble';
}

export function readChatTranslationStyle(charId: string | null | undefined): ChatTranslationStyle {
    try { return normalizeChatTranslationStyle(localStorage.getItem(`chat_translate_style_${charId}`)); }
    catch { return 'bubble'; }
}
