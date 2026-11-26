import type { CharacterProfile, Emoji, UserProfile } from '../types';
import type { ContextRangeSnapshot } from './chatContextRange';
import { ChatPrompts } from './chatPrompts';
import { ContextBuilder } from './context';
import { readableContextMemories } from './contextMemories';
import { cleanApiMessages, flattenImageContentParts } from './promptMessageCleanup';
import { normalizeUserImpression } from './impression';
import { isScheduleFeatureOn } from './scheduleFeature';

export const countContextCharacters = (text: string) => Array.from(text).length;
/** Local heuristic only, not a provider tokenizer or billing count. */
export function estimateContextTokens(text: string): number {
    let latin = 0, other = 0;
    for (const character of text) {
        if (character.codePointAt(0)! <= 127) latin++;
        else other++;
    }
    return Math.ceil(latin / 4 + other);
}
export const messageSourceLabel = (source?: string): string => {
    if (!source || source === 'chat') return '聊天 · ChatApp / 未标注';
    if (source === 'date') return '见面 · DateApp';
    if (source === 'call' || source === 'call-end-popup') return '通话 · CallApp';
    if (source === 'story_theater' || source === 'story_theater_memory') return '剧情剧场';
    if (source === 'active_msg_2') return '主动消息';
    return `其他 · ${source}`;
};

export function buildCharacterStats(char: CharacterProfile, user: UserProfile, range: ContextRangeSnapshot, emojis: Emoji[] = []) {
    const { apiMessages, historySlice } = ChatPrompts.buildMessageHistory(range.messages, Math.max(1, range.messages.length), char, user, emojis, undefined, { contextHighWaterMark: range.hwm });
    const history = cleanApiMessages(flattenImageContentParts(apiMessages));
    const sources = new Map<string, { name: string; characters: number; count: number }>();
    historySlice.forEach((message, index) => {
        const name = messageSourceLabel(message.metadata?.source);
        const entry = sources.get(name) || { name, characters: 0, count: 0 };
        entry.count++;
        entry.characters += countContextCharacters(String(history[index]?.content || ''));
        sources.set(name, entry);
    });
    const memories = readableContextMemories(char);
    const memoryRows = [
        ...memories.monthly.map(m => ({ title: `${m.date} · 月度总结`, content: m.summary })),
        ...memories.daily.flatMap(group => group.entries.map(m => ({ title: `${m.date} · 日度记忆`, content: m.summary }))),
    ];
    const books = ContextBuilder.inspectWorldbooks(char, user, history, 'chat.private');
    const memoryCharacters = memoryRows.reduce((sum, m) => sum + countContextCharacters(m.content), 0);
    const worldbookCharacters = books.filter(b => b.status === 'readable').reduce((sum, b) => sum + countContextCharacters(b.content), 0);
    const historyCharacters = [...sources.values()].reduce((sum, s) => sum + s.characters, 0);
    const imp = normalizeUserImpression(char.impression);
    const otherRows = [
        { title: '角色身份与核心设定', content: [char.name, char.description || '无', char.systemPrompt || '你是一个温柔、拟人化的AI伴侣。'].join('\n') },
        { title: '世界观', content: char.worldview || '' },
        { title: '内在认知', content: (char.selfInsights || []).join('\n') },
        { title: '用户画像', content: [user.name, user.bio || '无'].join('\n') },
        { title: '印象档案', content: imp ? [imp.personality_core.summary, imp.personality_core.interaction_style, imp.personality_core.observed_traits.join(', '), imp.value_map.likes.join(', '), imp.behavior_profile.emotion_summary, imp.emotion_schema.triggers.positive.join(', '), imp.emotion_schema.triggers.negative.join(', '), imp.emotion_schema.stress_signals.join(', '), imp.emotion_schema.comfort_zone, ...(imp.observed_changes || []).map(c => typeof c === 'string' ? c : JSON.stringify(c))].filter(Boolean).join('\n') : '' },
        { title: '宫殿门牌', content: char.memoryPalaceEnabled ? char.roomPlatesInjection || '' : '' },
        { title: '情绪底色', content: isScheduleFeatureOn(char) && char.emotionConfig?.enabled ? char.buffInjection || '' : '' },
    ].filter(row => row.content.trim());
    const otherCharacters = otherRows.reduce((n, row) => n + countContextCharacters(row.content), 0);
    const texts = [...history.map(m => String(m.content || '')), ...memoryRows.map(m => m.content), ...books.filter(b => b.status === 'readable').map(b => b.content), ...otherRows.map(r => r.content)];
    const estimatedTokens = texts.reduce((n, text) => n + estimateContextTokens(text), 0);
    return { range, memories, memoryRows, books, otherRows, otherCharacters, estimatedTokens, sources: [...sources.values()].sort((a, b) => b.characters - a.characters), memoryCharacters, worldbookCharacters, historyCharacters, total: memoryCharacters + worldbookCharacters + historyCharacters + otherCharacters };
}
