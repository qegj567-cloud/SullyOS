import { VALID_EMOTIONS } from './minimaxTts';
import { normalizeVoiceTags } from './sanitize';
import { voiceLanguagePromptLabel } from './voiceLanguage';

/** 从 AI 回复中提取 <语音 emotion="…">…</语音> 标签内容 + emotion（兼容繁体 語音、无属性）
 *  先跑 normalizeVoiceTags 自愈（未闭合/孤儿闭合/全角符号/属性写歪）——通话是 LLM 原文直达，
 *  没有落库 sanitize 兜底，掉格式的标签会直接被念出来。 */
export const extractVoiceTag = (text: string): { display: string; speech: string; voiceText: string; emotion?: string } => {
  text = normalizeVoiceTags(text);
  const match = text.match(/<[语語]音(?:[^>]*?emotion\s*=\s*["']?([a-zA-Z]+)["']?)?[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>/);
  if (!match) return { display: text, speech: '', voiceText: '', emotion: undefined };
  const rawEmotion = (match[1] || '').trim().toLowerCase();
  const emotion = VALID_EMOTIONS.has(rawEmotion) ? rawEmotion : undefined;
  const voiceText = match[2].trim();
  const display = text.replace(/<[语語]音[^>]*>[\s\S]*?<\/\s*[语語]音\s*>/g, '').trim();
  return { display, speech: voiceText, voiceText, emotion };
};

export function callVoiceTranslationPrompt(voiceLang?: string, compact = false) {
  const langLabel = voiceLang ? voiceLanguagePromptLabel(voiceLang) : '';
  if (compact && voiceLang) return `先写中文台词，再用 <语音>…</语音> 写同一句话的${langLabel}口语译文。只朗读译文。`;
  return voiceLang ? `### 语音语种翻译

用户开启了语音语种功能，选择的语种是：${langLabel}（${voiceLang}）。

你的回复格式必须是：
1. 先用中文自然地写出你要说的话（给对方看的文字，中文舞台指示写在这里没关系）
2. 然后换行，在 <语音> 标签里写出这句话的${langLabel}翻译——这才是真正会被读出来的部分。可选地用 emotion 属性标整句情绪：\`<语音 emotion="happy">…</语音>\`（情绪只能取 happy/sad/angry/fearful/disgusted/surprised/calm/fluent）

示例：
啊，我知道了
<语音 emotion="happy">Okay, I get it now!</语音>

你说真的？那也太离谱了吧。
<语音 emotion="surprised">Wait... are you serious? That's insane.</语音>

要求：
- <语音> 里的翻译要自然口语化，不要机翻味，要符合你的角色性格
- <语音> 里只写会被朗读的文字；演出标记继续遵守上方「当前引擎规则」，不要混用其它引擎语法，也不要写中文舞台旁白
- 每条消息只有一个 <语音> 标签，emotion 属性可选；情绪不强就别加
- 中文部分和 <语音> 部分表达的意思要一致` : '';
}
