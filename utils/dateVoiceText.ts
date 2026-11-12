import type { APIConfig, CharacterProfile } from '../types';

/** 容忍模型把同一行的译文换行输出，仍把原文与译文作为一个 beat。 */
export const normalizeDateVoiceLines = (text: string): string => text.replace(
    /[ \t]*(?:\r?\n[ \t]*)?<date-voice\b[^>]*>[\s\S]*?<\/date-voice\s*>/gi,
    block => ` ${block.trim().replace(/\s*\r?\n\s*/g, ' ')}`,
);

/** 译文保存在消息正文中，但不进入阅读正文、立绘打字机或原文收藏。 */
export const stripDateVoiceTranslations = (text: string): string => text
    .replace(/[ \t]*<date-voice\b[^>]*>[\s\S]*?(?:<\/date-voice\s*>|$)/gi, '')
    .trim();

/** 提取引号中的台词；v4 的声音指令留在脚本里，立绘和 [v:xxx] 不进入朗读。 */
export const extractDateDialogueText = (text: string, preserveAudioTags = false): string => {
    text = stripDateVoiceTranslations(text);
    const clean = (preserveAudioTags ? text.replace(/\[v:\s*[a-zA-Z]+\s*\]/gi, '') : text.replace(/\[.*?\]/g, '')).trim();
    const matches = clean.match(/["\u201C]([^"\u201D]*)["\u201D]/g)
        || clean.match(/[\u300C]([^\u300D]*)[\u300D]/g);
    if (matches) {
        return matches.map(match => match.replace(/["\u201C\u201D\u300C\u300D]/g, '').trim()).join(' ');
    }
    return clean;
};

/** 只使用随回复保存、语言匹配的译文；旧消息或漏格式直接读原文，不发翻译请求。 */
export const resolveDateSpeechText = (text: string, language = '', preserveAudioTags = false, dialogueOnly = true): string => {
    const translations = text.matchAll(/<date-voice\s+lang\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/date-voice\s*>/gi);
    let spoken = stripDateVoiceTranslations(text).replace(/^\s*\[[a-z_]+\]\s*/i, '');
    let translated = false;
    for (const match of translations) {
        if (language && match[1].toLowerCase() === language.toLowerCase() && match[2].trim()) {
            spoken = match[2].trim();
            translated = true;
            break;
        }
    }
    // 译文不要求包引号，内部的引用词也必须完整朗读，不能只提取引用词。
    if (dialogueOnly && !translated) return extractDateDialogueText(spoken, preserveAudioTags);
    spoken = spoken.replace(/\[v:\s*[a-z]+\s*\]/gi, '');
    return (preserveAudioTags ? spoken : spoken.replace(/\[.*?\]/g, '')).trim();
};

export const buildDateReadingScript = (text: string, language = '', preserveAudioTags = false): string =>
    normalizeDateVoiceLines(text).split('\n')
        .map(line => resolveDateSpeechText(line, language, preserveAudioTags, false))
        .filter(Boolean).join('\n');

/** 页面缓存同样区分语言、音色、模型与参数；修改设置后不能误播旧音频。 */
export const dateVoiceCacheKey = (text: string, char: CharacterProfile, config: APIConfig, emotion?: string): string => JSON.stringify([
    text, char.id, char.dateVoiceLang || '', char.voiceProfile, emotion,
    config.ttsProvider, config.fishAudioModel, config.elevenLabsModel,
    config.elevenLabsStability, config.elevenLabsSimilarityBoost,
    config.elevenLabsStyle, config.elevenLabsUseSpeakerBoost,
]);
