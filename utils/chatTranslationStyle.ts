import { isSavedFontId } from './fontLibrary';
export type ChatTranslationStyle = 'bubble' | 'subtitle';
export type ChatTranslationMode = 'collapsed' | ChatTranslationStyle;

export const SUBTITLE_FONTS = {
    rounded: { label: '圆体', family: '"Sully Subtitle Rounded", ui-rounded, "PingFang SC", sans-serif' },
    system: { label: '系统黑体', family: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif' },
    serif: { label: '宋体', family: '"Noto Serif SC", "Songti SC", SimSun, serif' },
    app: { label: '跟随应用', family: '"CustomUserFont", system-ui, sans-serif' },
} as const;
export interface ChatSubtitleSettings {
    fontSize: number;
    color: string;
    outlineColor: string;
    font: keyof typeof SUBTITLE_FONTS | 'custom';
    fontId?: string;
}
export const DEFAULT_SUBTITLE_SETTINGS: ChatSubtitleSettings = { fontSize: 16, color: '#ffffff', outlineColor: '#111111', font: 'rounded' };
const SUBTITLE_KEY_PREFIX = 'chat_translate_subtitle_';
export function normalizeSubtitleSettings(value: unknown): ChatSubtitleSettings {
    const input = value as Partial<ChatSubtitleSettings> | null;
    const color = (value: unknown, fallback: string) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
    return {
        fontSize: typeof input?.fontSize === 'number' && Number.isFinite(input.fontSize) ? Math.max(12, Math.min(28, Math.round(input.fontSize))) : 16,
        color: color(input?.color, '#ffffff'), outlineColor: color(input?.outlineColor, '#111111'),
        font: input?.font === 'custom' && isSavedFontId(input.fontId) ? 'custom' : input?.font && Object.hasOwn(SUBTITLE_FONTS, input.font) ? input.font : 'rounded',
        ...(isSavedFontId(input?.fontId) ? { fontId: input.fontId } : {}),
    };
}
export function readSubtitleSettings(charId: string | null | undefined): ChatSubtitleSettings {
    try { return normalizeSubtitleSettings(JSON.parse(localStorage.getItem(SUBTITLE_KEY_PREFIX + charId) || 'null')); }
    catch { return { ...DEFAULT_SUBTITLE_SETTINGS }; }
}
export function saveSubtitleSettings(charId: string, value: ChatSubtitleSettings): void {
    localStorage.setItem(SUBTITLE_KEY_PREFIX + charId, JSON.stringify(normalizeSubtitleSettings(value)));
}
export function exportSubtitleSettings(): Record<string, ChatSubtitleSettings> {
    const result: Record<string, ChatSubtitleSettings> = Object.create(null);
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(SUBTITLE_KEY_PREFIX) && key.length > SUBTITLE_KEY_PREFIX.length) {
            const id = key.slice(SUBTITLE_KEY_PREFIX.length);
            result[id] = readSubtitleSettings(id);
        }
    }
    return result;
}
export function importSubtitleSettings(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [id, settings] of Object.entries(value)) if (id) saveSubtitleSettings(id, normalizeSubtitleSettings(settings));
}

export function normalizeChatTranslationStyle(value: unknown): ChatTranslationStyle {
    return value === 'subtitle' ? 'subtitle' : 'bubble';
}

export function readChatTranslationStyle(charId: string | null | undefined): ChatTranslationStyle {
    try { return normalizeChatTranslationStyle(localStorage.getItem(`chat_translate_style_${charId}`)); }
    catch { return 'bubble'; }
}
