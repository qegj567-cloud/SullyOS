/**
 * Shared MiniMax TTS utility — used by ChatApp, DateApp, and CallApp
 */
import { CharacterProfile, APIConfig } from '../types';
import { resolveMiniMaxApiKey } from './minimaxApiKey';
import { minimaxFetch } from './minimaxEndpoint';
import { hashTtsParams, getCachedTts, saveCachedTts } from './ttsCache';
import { normalizeVoiceTags } from './sanitize';
import { formatUnknownError } from './errorSelfCheck';
import { summarizeHtmlErrorBody } from './networkFailureDiagnosis';

const DEFAULT_MODEL = 'speech-2.8-hd';
export type MiniMaxParamVersion = 'legacy' | 'natural-v2';

/** 老角色没有该字段时必须继续使用历史参数，避免升级后声音突然变化。 */
export const getMiniMaxParamVersion = (vp: CharacterProfile['voiceProfile']): MiniMaxParamVersion =>
  vp?.minimaxParamVersion === 'natural-v2' ? 'natural-v2' : 'legacy';

const MINIMAX_LANGUAGE_BOOST_ALIASES: Record<string, string> = {
  zh: 'Chinese',
  'zh-cn': 'Chinese',
  'zh-hans': 'Chinese',
  'zh-tw': 'Chinese',
  'zh-hant': 'Chinese',
  yue: 'Chinese,Yue',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  ru: 'Russian',
  ar: 'Arabic',
  it: 'Italian',
  pt: 'Portuguese',
  hi: 'Hindi',
  id: 'Indonesian',
  tr: 'Turkish',
  vi: 'Vietnamese',
};

/** 将项目内使用的 ISO 语种码转换成 MiniMax language_boost 的官方枚举。 */
export const normalizeMiniMaxLanguageBoost = (languageBoost?: string): string | undefined => {
  const value = (languageBoost || '').trim();
  if (!value) return undefined;
  return MINIMAX_LANGUAGE_BOOST_ALIASES[value.toLowerCase()] || value;
};

// MiniMax 支持的语气标签 — 这些在 TTS 中会被正确演绎，必须保留
export const VALID_INTERJECTION_TAGS = new Set([
  'chuckle', 'laughs', 'sighs', 'coughs', 'clear-throat', 'groans',
  'breath', 'pant', 'inhale', 'exhale', 'gasps', 'sniffs', 'snorts',
  'lip-smacking', 'humming', 'hissing', 'emm',
]);

// MiniMax voice_setting.emotion 合法取值（整条一个值）。其余/未知一律丢弃不传。
export const VALID_EMOTIONS = new Set([
  'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent',
]);

/**
 * 共享的「语音演出规范」——教 LLM 把台词写成能被 MiniMax 自然念出来的对白。
 * 聊天语音条 / 电话 / 约会复用同一份，避免各处各写一套、规则互相打架。
 *
 * 注意定位：这里只讲「怎么把字写得有呼吸、有情绪节奏」。具体的标签机制
 * （<语音> 标签怎么用、[emotion] 放哪、动作词白名单）由各调用点自己的
 * prompt 负责，本块不重复。经典参数会按标点自动补停顿；新版自然参数只保留
 * LLM 明确写出的 <#x#>，让 MiniMax 自己处理普通标点韵律。因此指南只要求在
 * 真正的情绪节点使用停顿标签，两种模式都不会把标签当普通标点来滥用。
 */
export const VOICE_ACTING_GUIDE = `### 让它听起来像活人在说话（重要）

你写的字会被原样念出来。目标不是"写一段通顺的话"，而是"写一段读出来有呼吸、有情绪起伏的对白"。读稿感、客服腔、新闻播报腔一旦出现就重写。

**1. 段与段之间要换气，别无缝冲。**
同一条语音里换行或停顿之后，如果还是你在继续说，第二段开头别一上来就冲进正题——加一个停顿、一个语气词或一次叹气当缓冲。
✅ 我知道你不是故意的。<#0.6#>只是……我还是会有点难过。
✅ (sighs) 算了。<#0.5#>听你的。
❌ 我知道你不是故意的。只是我还是会有点难过。（两句贴死，像棒读）
这些地方下一句开头尤其要缓一下：解释原因、情绪转折（吐槽转温柔 / 强硬转示弱 / 玩笑转认真）、沉默后再开口、安抚对方、委屈撒娇别扭的时候。

**2. 句子长短交错。** 一连串等长的句子是棒读的头号来源。让短句砸下来，让长句铺开。想强调某个词就拆开念："我。没。拿。"

**3. <#秒#> 停顿放在情绪节点，不要每句都塞。**
0.2 极短换气 / 0.3 轻顿 / 0.5 普通停顿 / 0.7 犹豫·叹息后停一下 / 1.0 明显沉默·震惊·压抑。
标记必须夹在能念的字之间（✅ 我没事。<#0.5#>只是有点累。）；别放在句首，也别两个标记连写（<#0.5#><#0.4#> 这种一定删一个）。

**4. 情绪不同，节奏不同：**
- 温柔安抚：慢、稳、短句多。"没事。<#0.6#>先别急着吓自己。"
- 委屈撒娇：语气软、停顿多一点但别太戏剧。"嗯……<#0.5#>你刚刚是不是又不理我。"
- 别扭傲娇：前半句嘴硬后半句放软，中间停一下。"哈。<#0.4#>你还真会折腾我。算了，<#0.5#>我帮你就是了。"
- 难过压抑：更慢、更多省略号、少用长句。"……我知道。<#0.8#>只是有点难受。"
- 紧张犹豫：断裂感，短停顿多。"等等。<#0.4#>我好像……<#0.5#>有点不确定。"
- 吐槽轻松：别太慢，轻微停顿即可。"行吧。<#0.3#>人类又发明了新的折磨方式。"

**5. 密度别失控。** 每 100 字里 <#x#> 大约 1–4 个、动作词 0–2 个。普通对话 2–4 句缓冲一次，强情绪 1–2 句一次。别整段全是同一个停顿值（会像坏掉的导航在念稿），也别连着堆同一个动作词。

（朗读语种不是中文时，上面示例里的中文语气词换成该语言里自然的叹词 / 填充词即可，呼吸和节奏的原理不变。）`;

// [happy]/【angry】… 这类情绪标签是给系统读取/设定 emotion 用的，绝不能被朗读或显示出来。
const EMOTION_TAG_RE = /[\[【]\s*(?:happy|sad|angry|fearful|disgusted|surprised|calm|fluent)\s*[\]】]/gi;
/** 移除文本里所有 [emotion] / 【emotion】 标记（任意位置），避免被朗读或显示。 */
export const stripEmotionTags = (text: string): string => (text || '').replace(EMOTION_TAG_RE, '');

/**
 * 把「只给 TTS 用」的演出标记从要显示给用户的文本里清掉。
 * <#秒#> 停顿标记和 (sighs)/(chuckle) 这类动作词是写给语音合成的，
 * 不应该原样出现在聊天气泡 / 转文字面板里（否则用户看到一堆 <#0.4#>）。
 * 只删白名单内的动作词；普通括号内容（比如正常的西文括注）保持不动。
 */
export const cleanVoiceMarkupForDisplay = (text?: string | null): string => {
  if (!text) return '';
  return text
    .replace(/<#\s*[\d.]+\s*#>/g, '')                 // 停顿标记 <#0.4#>
    .replace(/\(([^)]{1,40})\)/g, (m, inner: string) =>
      VALID_INTERJECTION_TAGS.has(inner.trim().toLowerCase()) ? '' : m) // 动作词，仅删白名单
    .replace(/[ \t]{2,}/g, ' ')                        // 合并多余空格
    .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')    // 标点前残留空格
    .replace(/([，、；：,])\s*\1+/g, '$1')               // 删标记后留下的连续重复标点
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

// 设计：不再做「中文舞台指示 → 语气标签」的猜测式映射（体验差、不可预测、有损）。
// 改为「教 LLM 直接写官方 sound tag」+「客户端只做白名单消毒」。
// 因此这里只保留一个合法标签白名单（上方 VALID_INTERJECTION_TAGS），不保留任何中→英映射表。

/**
 * 消毒括号内容（不做任何映射，只做白名单）：
 * - 中文舞台指示（……）一律删除，绝不读出来；
 * - 西文括号仅保留合法 sound tag（如 (laughs)），其余删除。
 * LLM 现在被要求直接写官方英文 sound tag，所以这里不再翻译中文提示词。
 */
const stripParensPreservingTags = (text: string): string => {
  return stripEmotionTags(text)
    // 中文括号舞台指示：一律删除
    .replace(/（[^）]{0,48}）/g, '')
    // 西文括号：仅保留白名单 sound tag，其余删除
    .replace(/\(([^)]{1,80})\)/g, (_m, inner: string) => {
      const tag = inner.trim().toLowerCase();
      return VALID_INTERJECTION_TAGS.has(tag) ? `(${tag})` : '';
    });
};

/**
 * Clean text for TTS — strip stage directions, system tags, and voice markup.
 * If <语音>...</语音> tag exists, use its content (already translated for TTS).
 * Otherwise, strip（parenthetical cues）so they aren't read aloud.
 * Known interjection tags like (chuckle) / (sighs) are preserved.
 */
export const cleanTextForTts = (raw: string): string => {
  // 0. 语音标签自愈 — 历史坏数据 (未闭合/孤儿闭合/全角符号) 也要能解析出来
  raw = normalizeVoiceTags(raw);
  // 1. If <语音> tag exists (with or without emotion attribute), extract & use its content only
  const voiceTagMatch = raw.match(/<[语語]音[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>/);
  if (voiceTagMatch) {
    return stripParensPreservingTags(voiceTagMatch[1]).replace(/\s+/g, ' ').trim();
  }

  let text = raw;
  // 2. Strip [[...]] system markers
  text = text.replace(/\[\[.*?\]\]/g, '');
  // 3. Strip %%BILINGUAL%% and everything after
  text = text.replace(/%%BILINGUAL%%[\s\S]*/i, '');
  // 4. Strip parenthetical cues (preserving valid interjection tags only)
  text = stripParensPreservingTags(text);
  // 5. Strip <语音>...</语音> / <字幕>...</字幕> tags if they somehow remain
  //    (字幕是显示用的中文对照, 绝不能被朗读)
  text = text.replace(/<[语語]音[^>]*>[\s\S]*?<\/\s*[语語]音\s*>/g, '');
  text = text.replace(/<字幕>[\s\S]*?<\/字幕>/g, '');
  // 6. Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
};

export interface ParsedVoiceOutput {
  /** Text OUTSIDE the <语音> tag — what shows in the chat bubble. */
  display: string;
  /** TTS-ready spoken text (sanitized: only whitelisted MiniMax sound tags kept). */
  speech: string;
  /**
   * Raw <语音> inner content, whitespace-collapsed only — square-bracket cues and
   * parens are PRESERVED. Fish Audio needs this so its native inline cues
   * ([happy]/[whispering]/[break]…) survive to the API; cleanTextForTtsFish does
   * the provider-appropriate cleaning downstream. Empty when no <语音> tag.
   */
  rawSpeech: string;
  /** Validated MiniMax emotion from the tag's emotion="…" attribute, or undefined. */
  emotion?: string;
  /** Whether a <语音> tag was present at all. */
  hasVoiceTag: boolean;
  /**
   * <字幕>…</字幕> 里的中文对照（外语语音模式下模型显式给出的翻译）。
   * 语音条「转文字」面板的翻译第一优先级用它 —— 有显式字幕就不用猜、不用调 LLM。
   */
  subtitle?: string;
}

// <语音 emotion="happy">…</语音> — emotion attribute optional, single/double/no quotes tolerated.
// 属性前空格可省 (<语音emotion=…> 也认), 闭合标签容许空格 / 简繁互换。
const VOICE_TAG_RE = /<[语語]音(?:[^>]*?emotion\s*=\s*["']?([a-zA-Z]+)["']?)?[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>/;

/**
 * Parse an assistant message into display text + spoken text + emotion.
 * The single source of truth for the structured voice-output format that the
 * LLM is taught to emit. Invalid emotions are dropped (returns undefined) so a
 * malformed attribute can never reach the API.
 */
const SUBTITLE_BLOCK_RE = /<字幕>([\s\S]*?)<\/字幕>/;

export const parseVoiceOutput = (raw: string): ParsedVoiceOutput => {
  if (!raw) return { display: '', speech: '', rawSpeech: '', hasVoiceTag: false };
  // 语音标签自愈: 未闭合 / 孤儿闭合 / 全角符号 / 属性写歪, 先修再配对。
  // 新消息落库前 sanitize 已经修过, 这里主要救历史坏数据 + 非落库调用点 (电话/见面)。
  raw = normalizeVoiceTags(raw);
  const m = raw.match(VOICE_TAG_RE);
  if (!m) {
    // 没有语音标签: 落单的字幕标签剥掉留内文, 别把原始标签当正文
    return { display: raw.replace(/<\/?字幕>/g, '').trim(), speech: '', rawSpeech: '', hasVoiceTag: false };
  }
  const rawEmotion = (m[1] || '').trim().toLowerCase();
  const emotion = VALID_EMOTIONS.has(rawEmotion) ? rawEmotion : undefined;
  const speech = stripParensPreservingTags(m[2]).replace(/\s+/g, ' ').trim();
  // 不做 MiniMax 的括号/情绪标剥离，留给 cleanTextForTtsFish 按鱼声规则处理。
  const rawSpeech = m[2].replace(/\s+/g, ' ').trim();
  const subtitle = raw.match(SUBTITLE_BLOCK_RE)?.[1]?.trim() || undefined;
  // display = 语音块和字幕块之外的文字 (普通闲聊); 字幕单独走 subtitle 字段
  const display = raw
    .replace(/<[语語]音[^>]*>[\s\S]*?<\/\s*[语語]音\s*>/g, '')
    .replace(/<字幕>[\s\S]*?<\/字幕>/g, '')
    .trim();
  return { display, speech, rawSpeech, emotion, hasVoiceTag: true, subtitle };
};

/** 为 TTS 文本插入 MiniMax 原生停顿标签 <#秒数#>，让语音有自然停顿
 * 停顿层次（从短到长）:
 *   ，、；  →  0.06s  微停（换气级）
 *   。！？  →  0.12s  句末停顿
 *   ——     →  0.18s  话题转折 / 拖长
 *   ……     →  0.35s  欲言又止 / 沉默感
 *   \n     →  0.25s  段落换气
 */
export const insertSpeechBreaks = (text: string): string => {
  if (!text) return '';
  return text
    // 省略号：欲言又止 / 犹豫
    .replace(/[…]{2,}/g, '……<#0.45#>')          // 多个省略号连用，更长
    .replace(/[…]/g, '…<#0.35#>')               // 单个省略号
    .replace(/\.{3,}/g, '...<#0.35#>')           // 英文省略号
    // 破折号：话题转折、语气拉长
    .replace(/——/g, '——<#0.22#>')
    .replace(/--/g, '--<#0.22#>')
    // 句末标点：句子之间留出真实呼吸（别让角色一口气赶完）
    .replace(/([。])/g, '$1<#0.22#>')
    .replace(/([！？!?])/g, '$1<#0.26#>')        // 感叹/疑问停顿更明显
    // 句中标点：换气
    .replace(/([，,])/g, '$1<#0.10#>')
    .replace(/([、；;：:])/g, '$1<#0.07#>')
    // 换行：段落间停顿
    .replace(/\n/g, '\n<#0.30#>')
    // 去重：相邻多个停顿标签只保留最长的那个（封顶 0.6s）
    .replace(/(<#[\d.]+#>[\s]*){2,}/g, (match) => {
      const times = [...match.matchAll(/<#([\d.]+)#>/g)].map(m => parseFloat(m[1]));
      const maxTime = Math.min(Math.max(...times), 0.6);
      return `<#${maxTime.toFixed(2)}#>`;
    })
    .trim();
};

/**
 * Soft-clamp a numeric value to keep it within a safe range.
 * Preserves direction and feel but prevents extreme spikes that sound unnatural.
 */
const softClamp = (value: number, limit: number): number => {
  if (Math.abs(value) <= limit) return value;
  // Beyond the limit, compress logarithmically — still moves in the same direction but tapers off
  const sign = value > 0 ? 1 : -1;
  const excess = Math.abs(value) - limit;
  return sign * (limit + Math.log1p(excess) * (limit * 0.15));
};

/** Build timber_weights & voice_modify extras from a voiceProfile. */
export const buildTtsExtras = (
  vp: CharacterProfile['voiceProfile'],
  paramVersion: MiniMaxParamVersion = 'legacy',
) => {
  if (!vp) return {};
  const extras: any = {};
  const tw = vp.timberWeights;
  if (tw && tw.length > 1) {
    extras.timber_weights = (() => {
      const totalWeight = tw.reduce((sum: number, t: any) => sum + (t.weight || 0), 0);
      if (totalWeight === 0) return tw.map((t: any) => ({ voice_id: t.voice_id, weight: Math.round(100 / tw.length) }));
      const raw = tw.map((t: any) => ({ voice_id: t.voice_id, weight: Math.round((t.weight / totalWeight) * 100) }));
      const diff = 100 - raw.reduce((s: number, r: any) => s + r.weight, 0);
      if (diff !== 0) raw[0].weight += diff;
      return raw;
    })();
  }
  if (vp.voiceModify) {
    const vm: any = {};
    if (paramVersion === 'natural-v2') {
      // 新版只按接口的硬边界保护，确保捏声音试听与实际播放采用相同数值。
      const officialClamp = (value: number) => Math.max(-100, Math.min(100, Math.round(value)));
      if (vp.voiceModify.pitch) vm.pitch = officialClamp(vp.voiceModify.pitch);
      if (vp.voiceModify.intensity) vm.intensity = officialClamp(vp.voiceModify.intensity);
      if (vp.voiceModify.timbre) vm.timbre = officialClamp(vp.voiceModify.timbre);
    } else {
      // 经典参数原样保留历史的柔性限幅，防止老角色升级后声音突变。
      if (vp.voiceModify.pitch) vm.pitch = Math.round(softClamp(vp.voiceModify.pitch, 40));
      if (vp.voiceModify.intensity) vm.intensity = Math.round(softClamp(vp.voiceModify.intensity, 30));
      if (vp.voiceModify.timbre) vm.timbre = Math.round(softClamp(vp.voiceModify.timbre, 40));
    }
    if (vp.voiceModify.sound_effects) vm.sound_effects = vp.voiceModify.sound_effects;
    if (Object.keys(vm).length) extras.voice_modify = vm;
  }
  return extras;
};

/**
 * Build voice_setting fields (speed, vol, pitch, emotion) with safe ranges.
 * `emotionOverride` (validated MiniMax emotion, e.g. from a <语音 emotion="…"> tag)
 * wins over the character's static voiceProfile.emotion. Invalid values are ignored.
 */
export const buildVoiceSettings = (
  vp: CharacterProfile['voiceProfile'],
  emotionOverride?: string,
  paramVersion: MiniMaxParamVersion = 'legacy',
) => {
  if (paramVersion === 'natural-v2') {
    const savedEmotion = (vp?.emotion || '').trim().toLowerCase();
    const dynamicEmotion = (emotionOverride || '').trim().toLowerCase();
    // 用户手选的固定情感优先；选择“自动”时才采用每条语音的动态情感。
    const emotion = VALID_EMOTIONS.has(savedEmotion)
      ? savedEmotion
      : (VALID_EMOTIONS.has(dynamicEmotion) ? dynamicEmotion : '');
    return {
      speed: Math.max(0.5, Math.min(2, vp?.speed ?? 1)),
      vol: Math.max(0.01, Math.min(10, vp?.vol ?? 1)),
      pitch: Math.max(-12, Math.min(12, vp?.pitch ?? 0)),
      ...(emotion ? { emotion } : {}),
    };
  }

  const emotion = (emotionOverride && VALID_EMOTIONS.has(emotionOverride))
    ? emotionOverride
    : (vp?.emotion || '');
  return {
    // Clamp speed to 0.75–1.4 for natural human feel (API allows 0.5–2)
    speed: Math.max(0.75, Math.min(1.4, vp?.speed ?? 1)),
    vol: Math.max(0.3, Math.min(2, vp?.vol ?? 1)),
    // Clamp base pitch to ±8 semitones (API allows ±12) to avoid alien sound
    pitch: Math.max(-8, Math.min(8, vp?.pitch ?? 0)),
    // Normalize numbers/English so "2.8" etc. are read naturally
    english_normalization: true,
    ...(emotion ? { emotion } : {}),
  };
};

/**
 * 经典参数会自动在标点后补停顿；新版保留模型原生韵律，只尊重文本中明确写出的停顿标签。
 */
export const prepareMiniMaxSpeechText = (
  text: string,
  vp: CharacterProfile['voiceProfile'],
): string => getMiniMaxParamVersion(vp) === 'natural-v2' ? (text || '').trim() : insertSpeechBreaks(text);

export interface MiniMaxTtsPayloadOptions {
  languageBoost?: string;
  emotion?: string;
  voiceId?: string;
  model?: string;
  groupId?: string;
  /** 电话经典模式保留 32k/128k 单声道音频设置。传输格式统一使用 HEX。 */
  legacyTransport?: 'shared' | 'call';
  /** 电话先处理整段再切块；切块后不能二次插入停顿。 */
  textAlreadyPrepared?: boolean;
}

/** 构建版本化 MiniMax 请求；聊天、约会和电话的新版参数共用这一处。 */
export const buildMiniMaxTtsPayload = (
  text: string,
  vp: CharacterProfile['voiceProfile'],
  options: MiniMaxTtsPayloadOptions = {},
): any => {
  const paramVersion = getMiniMaxParamVersion(vp);
  const payloadText = options.textAlreadyPrepared ? (text || '').trim() : prepareMiniMaxSpeechText(text, vp);
  const isLegacyCall = paramVersion === 'legacy' && options.legacyTransport === 'call';
  const payload: any = {
    model: options.model || vp?.model || DEFAULT_MODEL,
    text: payloadText,
    // Inline audio avoids a second, CORS-protected GET to MiniMax's regional OSS.
    // Transport format does not change the voice/acoustic settings or cache key.
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: options.voiceId ?? vp?.voiceId ?? '',
      ...buildVoiceSettings(vp, options.emotion, paramVersion),
    },
    audio_setting: paramVersion === 'natural-v2' || isLegacyCall
      ? { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 }
      : { format: 'mp3' },
    ...buildTtsExtras(vp, paramVersion),
  };

  // 旧版参数路径继续保留原始 ISO 短码，唯独粤语必须发送 MiniMax 官方枚举
  // `Chinese,Yue`；`yue` 本身不是 language_boost 的合法值。
  const languageBoost = paramVersion === 'natural-v2' || options.languageBoost?.trim().toLowerCase() === 'yue'
    ? normalizeMiniMaxLanguageBoost(options.languageBoost)
    : options.languageBoost || undefined;
  if (languageBoost) payload.language_boost = languageBoost;
  if (options.groupId) payload.group_id = options.groupId;
  return payload;
};

/** 新版使用独立缓存命名空间，绝不复用经典参数生成的旧音频。 */
export const buildMiniMaxTtsCacheKey = (
  payload: any,
  paramVersion: MiniMaxParamVersion = 'legacy',
): string => hashTtsParams({
  kind: paramVersion === 'natural-v2' ? 'minimax-t2a-natural-v2' : 'minimax-t2a',
  text: payload.text,
  model: payload.model,
  voice_setting: payload.voice_setting,
  timber_weights: payload.timber_weights,
  voice_modify: payload.voice_modify,
  language_boost: payload.language_boost,
  audio_setting: payload.audio_setting,
});

/** Convert hex audio from MiniMax to a playable Blob */
export const convertHexAudioToBlob = (hexAudio: string, mimeType = 'audio/mpeg'): Blob => {
  const cleanHex = hexAudio.trim().replace(/^0x/i, '');
  if (!cleanHex || cleanHex.length % 2 !== 0 || /[^\da-f]/i.test(cleanHex)) {
    throw new Error('MiniMax 返回的 HEX 音频数据格式异常');
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return new Blob([bytes], { type: mimeType });
};

/** Fetch remote audio URL and return as Blob */
export const fetchRemoteAudioBlob = async (sourceUrl: string): Promise<Blob> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Preserve signed URLs exactly; their signature/cache identity belongs to the upstream.
    const response = await fetch(sourceUrl, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`音频下载失败（HTTP ${response.status}）`);
    const type = response.headers.get('content-type') || '';
    if (/text\/html|application\/(?:json|xml)/i.test(type)) throw new Error('音频地址返回了错误页面');
    const blob = await response.blob();
    if (!blob.size) throw new Error('音频下载为空文件');
    return blob;
  } finally {
    clearTimeout(timer);
  }
};

export interface TtsResult {
  /** Playable URL for <audio> — a blob: URL when `blob` is present, otherwise a remote MiniMax CDN URL */
  url: string;
  /** Raw audio blob when available. Null when we fell back to the remote URL (CORS / network). */
  blob: Blob | null;
}

/**
 * Call MiniMax TTS and return both the raw blob (if available) and a playable URL.
 * Prefer this variant when you need to persist audio to storage — the blob can be
 * written to IndexedDB so the audio survives page/component reloads.
 */
export async function synthesizeSpeechDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string }
): Promise<TtsResult> {
  const apiKey = resolveMiniMaxApiKey(apiConfig);
  if (!apiKey) throw new Error('缺少 MiniMax API Key');
  const vp = char.voiceProfile;
  if (!vp?.voiceId && (!vp?.timberWeights || vp.timberWeights.length === 0)) {
    throw new Error('角色未配置语音');
  }

  const paramVersion = getMiniMaxParamVersion(vp);
  const payload = buildMiniMaxTtsPayload(text, vp, {
    languageBoost: options?.languageBoost,
    emotion: options?.emotion,
  });

  // Check the shared cache before hitting the network. Two call sites that
  // build the same payload get the same hash and reuse whichever one synthesized
  // the audio first — across sessions, across apps.
  const cacheKey = buildMiniMaxTtsCacheKey(payload, paramVersion);
  const cached = await getCachedTts(cacheKey);
  if (cached) {
    return { url: URL.createObjectURL(cached), blob: cached };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-MiniMax-API-Key': apiKey,
  };
  if (options?.groupId) headers['X-MiniMax-Group-Id'] = options.groupId;

  const res = await minimaxFetch('/api/minimax/t2a', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    const rawStr = typeof data === 'string' ? data : (typeof data?.error === 'string' ? data.error : '');
    const errMsg = /^\s*<(?:!doctype|html|head|body)\b/i.test(rawStr)
      ? summarizeHtmlErrorBody(rawStr).headline
      : formatUnknownError(data, '');
    throw new Error(errMsg || `TTS 失败 (HTTP ${res.status})`);
  }

  // Check MiniMax business-level error (can return HTTP 200 with status_code != 0)
  const baseResp = data?.base_resp;
  if (baseResp && baseResp.status_code !== 0 && baseResp.status_code !== undefined) {
    throw new Error(`TTS 业务错误: ${baseResp.status_msg || `status_code=${baseResp.status_code}`}`);
  }

  const audio = data?.data?.audio;
  if (typeof audio !== 'string' || !audio.trim()) {
    // Log full response for debugging
    console.error('[TTS] No audio in response:', JSON.stringify(data).slice(0, 500));
    throw new Error('TTS 返回无音频数据');
  }

  let blob: Blob;
  if (/^https?:\/\//i.test(audio.trim())) {
    try {
      blob = await fetchRemoteAudioBlob(audio.trim());
    } catch (e) {
      // fetch() may fail due to CORS when hitting MiniMax CDN directly;
      // return the raw URL so <audio src=...> can load it without CORS.
      console.warn('[TTS] fetchRemoteAudioBlob failed, returning remote URL directly', (e as any)?.message || e);
      return { url: audio.trim(), blob: null };
    }
  } else {
    blob = convertHexAudioToBlob(audio);
  }
  // Persist to the shared cache in the background — the next identical request
  // (same text + voice settings) will be served locally.
  saveCachedTts(cacheKey, blob).catch(() => { /* ignore */ });
  return { url: URL.createObjectURL(blob), blob };
}

/**
 * Call MiniMax TTS and return a playable URL. Thin wrapper around
 * `synthesizeSpeechDetailed` — use that variant when you also need the raw blob.
 */
export async function synthesizeSpeech(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string }
): Promise<string> {
  const { url } = await synthesizeSpeechDetailed(text, char, apiConfig, options);
  return url;
}
