/**
 * ElevenLabs TTS 适配器。
 *
 * 第一阶段沿用 SullyOS 现有的「拿到完整 Blob 后播放 + IndexedDB 缓存」契约，
 * 因而聊天、见面、电话无需引入第二套 PCM 播放器。浏览器走同源 /api 或主代理
 * Worker，Capacitor 原生端直连官方接口；三条路径的请求体完全一致。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { APIConfig, CharacterProfile } from '../types';
import { normalizeApiKey } from './minimaxApiKey';
import { hashTtsParams, getCachedTts, saveCachedTts } from './ttsCache';
import type { TtsResult } from './minimaxTts';
import { normalizeVoiceTags } from './sanitize';
import { getProxyWorkerUrl } from './proxyWorker';
import { isStaticWebDeployment } from './staticWebDeployment';
import {
  normalizeElevenLabsModel,
  isElevenLabsV3Model,
  isElevenLabsV4Model,
  supportsElevenLabsAudioTags,
} from './elevenLabsModels';

export {
  DEFAULT_ELEVENLABS_MODEL,
  ELEVENLABS_MODEL_OPTIONS,
  normalizeElevenLabsModel,
  isElevenLabsV3Model,
  isElevenLabsV4Model,
} from './elevenLabsModels';

export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';

export const ELEVENLABS_V4_VOICE_ACTING_GUIDE = `### ElevenLabs v4 语音表演规则

你写的是马上会被角色亲口说出来的台词。保留自然口语、呼吸、句子长短和段落；不要把“她轻声说道”一类叙述混进要朗读的正文。

Eleven v4 / v4 Turbo 支持开放式英文方括号 Audio Tags。根据角色和场景选择情绪、声音质感与演出指令：\`[whispers]\`、\`[laughs]\`、\`[curious]\`、\`[crying]\`、\`[low, gravelly voice]\`、\`[Warm, conversational tone, faint amusement]\`。可组合标签，也可写更具体的英文声音描述，不限于这些示例。放在对应台词附近，随表达变化使用，避免无意义重复。

停顿和节奏可用 \`[short pause]\`、\`[long pause]\`、\`[measured]\`、\`[Quick, light, playful pace]\`，并配合标点、省略号、大小写强调和自然换行。v4 不支持 SSML 或数值语速；不要输出 XML / SSML 标签或 <#秒数#>。

场景需要时也可使用声音事件和特殊演出：\`[sighs]\`、\`[clears throat]\`、\`[swallows]\`、\`[door slams]\`、\`[applause]\`、\`[sings]\`、\`[strong French accent]\`。声音事件可能真的生成音效，别把纯视觉动作（转头、看向窗外）写成标签。需要纠正专名发音时，可在正文用 /IPA音标/；不确定音标就保留原词。

这些能力默认可用，但只在内容需要时使用。标签跟随角色的情绪和说话习惯，不要为了展示能力擅自改台词或场景。跨语言合成默认使用目标语言的自然发音，不能保证保留参考音色的外语口音。`;

export const ELEVENLABS_V3_VOICE_ACTING_GUIDE = `### ElevenLabs v3 语音表演规则

你写的是马上会被角色亲口说出来的台词，不是小说旁白。句子要口语化、有呼吸、有长短变化；不要写“她轻声说道”之类会被念出来的叙述。

Eleven v3 支持方括号 Audio Tags。只在情绪真正变化的位置少量使用：\`[laughs]\`、\`[chuckles]\`、\`[whispers]\`、\`[sighs]\`、\`[excited]\`、\`[curious]\`、\`[sarcastic]\`、\`[crying]\`、\`[hesitates]\`、\`[softly]\`、\`[pause]\`。标签用半角英文方括号，通常一段 0–2 个；不要每句开头都塞标签，不要自造中文标签。

停顿优先靠逗号、句号、省略号、破折号和自然换行；确实需要明显沉默才用 \`[pause]\`。标签是演出指令，不要在标签外再复述动作。`;

export const ELEVENLABS_STANDARD_VOICE_ACTING_GUIDE = `### ElevenLabs 语音表演规则

你写的是马上会被角色亲口说出来的台词，不是小说旁白。只写会说出口的话，保持口语化、自然、有长短句变化；不要写“她轻声说道”一类叙述。

当前模型不支持 Audio Tags，**不要输出方括号 Audio Tags、圆括号动作词或 SSML**，否则它们可能被原样念出来。情绪和停顿只靠措辞、语气词、逗号、句号、省略号、破折号与自然换行表达。强情绪也要克制，避免播音腔和每句同一种节奏。`;

export const getElevenLabsVoiceActingGuide = (model?: string | null): string =>
  isElevenLabsV4Model(model)
    ? ELEVENLABS_V4_VOICE_ACTING_GUIDE
    : isElevenLabsV3Model(model)
      ? ELEVENLABS_V3_VOICE_ACTING_GUIDE
      : ELEVENLABS_STANDARD_VOICE_ACTING_GUIDE;

const V3_CUE_ALIASES: Record<string, string> = {
  laugh: 'laughs', laughing: 'laughs', laughs: 'laughs', giggle: 'chuckles', giggles: 'chuckles',
  chuckle: 'chuckles', chuckling: 'chuckles', chuckles: 'chuckles',
  whisper: 'whispers', whispering: 'whispers', whispers: 'whispers',
  sigh: 'sighs', sighing: 'sighs', sighs: 'sighs', exhale: 'exhales', exhales: 'exhales',
  excited: 'excited', happy: 'excited', playful: 'mischievously', mischievous: 'mischievously',
  mischievously: 'mischievously', curious: 'curious', sarcastic: 'sarcastic',
  crying: 'crying', sobbing: 'crying', snort: 'snorts', snorts: 'snorts',
  pause: 'pause', 'short pause': 'pause', 'long pause': 'pause', break: 'pause',
  hesitate: 'hesitates', hesitates: 'hesitates', hesitant: 'hesitates',
  softly: 'softly', soft: 'softly', calm: 'softly', breathy: 'softly',
  angry: 'angry', sad: 'sad', nervous: 'nervously', nervously: 'nervously',
};

const normalizeV3Cue = (raw: string): string => {
  const key = (raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return V3_CUE_ALIASES[key] || '';
};

// v4 支持自由描述，不能套 v3 的小白名单。中文方括号标题仍作为正文保留在字幕里。
const isV4AudioDirection = (raw: string): boolean => /[A-Za-z]/.test(raw);

/** 支持粘贴纯 ID，也支持从常见 ElevenLabs 页面链接提取 voiceId。 */
export const normalizeElevenLabsVoiceId = (raw?: string | null): string => {
  const value = (raw || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const queryId = parsed.searchParams.get('voiceId') || parsed.searchParams.get('voice_id');
    if (queryId) return queryId.trim();
    const voicePath = parsed.pathname.match(/\/(?:voices?|voice-library)\/([A-Za-z0-9_-]{8,64})(?:\/|$)/i);
    if (voicePath) return voicePath[1];
    return '';
  } catch {
    // 纯 ID 不是 URL，继续走下面的容错提取。
  }
  const embedded = value.match(/(?:voiceId|voice_id)[=/:]([A-Za-z0-9_-]{8,64})/i);
  if (embedded) return embedded[1];
  return value.split(/[?#\s]/)[0];
};

export const resolveElevenLabsApiKey = (apiConfig: APIConfig): string =>
  normalizeApiKey(apiConfig.elevenLabsApiKey || '');

export const resolveElevenLabsModel = (apiConfig: APIConfig): string =>
  normalizeElevenLabsModel(apiConfig.elevenLabsModel);

const extractVoiceBody = (raw: string): string => {
  const normalized = normalizeVoiceTags(raw || '');
  const voiceTag = normalized.match(/<[语語]音[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>/);
  return voiceTag ? voiceTag[1] : normalized;
};

/**
 * v4 保留开放式 Audio Tags 和段落；v3 兼容旧标签映射；其他模型剥掉演出指令。
 */
export const cleanTextForTtsElevenLabs = (raw: string, model?: string | null): string => {
  const isV3 = isElevenLabsV3Model(model);
  const isV4 = isElevenLabsV4Model(model);
  let text = extractVoiceBody(raw)
    .replace(/\[\[.*?\]\]/g, '')
    .replace(/%%BILINGUAL%%[\s\S]*/i, '')
    .replace(/<字幕>[\s\S]*?<\/字幕>/g, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/<#\s*[\d.]+\s*#>/g, '')
    .replace(/（[^）]{0,80}）/g, '')
    .replace(/\(([^)]{1,60})\)/g, (_match, inner: string) => {
      const cue = normalizeV3Cue(inner);
      return (isV3 || isV4) && cue ? `[${cue}]` : '';
    })
    .replace(/\[([^\[\]\r\n]+)\]/g, (_match, inner: string) => {
      if (isV4 && isV4AudioDirection(inner)) return `[${inner.trim()}]`;
      const cue = normalizeV3Cue(inner);
      if (!cue) return /[A-Za-z]/.test(inner) || /[\u4e00-\u9fff]/.test(inner) ? '' : _match;
      return isV3 ? `[${cue}]` : '';
    });

  if (isV4) {
    // 换行本身参与 v4 的表演与节奏，不擅自压平或插入固定停顿。
    return text.replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .trim();
  }
  text = text
    .replace(/\n{2,}/g, isV3 ? ' [pause] ' : '……')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。！？、；：,.!?…])/g, '$1')
    .trim();
  return text;
};

export const stripElevenLabsMarkupForDisplay = (text?: string | null, model?: string | null): string => {
  if (!text) return '';
  return text
    .replace(/<#\s*[\d.]+\s*#>/g, '')
    .replace(/\[([^\[\]\r\n]+)\]/g, (match, inner: string) =>
      normalizeV3Cue(inner) || (isElevenLabsV4Model(model) && isV4AudioDirection(inner)) ? '' : match)
    .replace(/\(([^)]{1,60})\)/g, (match, inner: string) => normalizeV3Cue(inner) ? '' : match)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
};

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
};

const EMOTION_TO_AUDIO_CUE: Record<string, string> = {
  happy: 'excited', sad: 'sad', angry: 'angry', fearful: 'nervously',
  disgusted: 'sarcastic', surprised: 'curious', calm: 'softly', fluent: 'softly',
};

export interface ElevenLabsRequestBody {
  text: string;
  model_id: string;
  language_code?: string;
  voice_settings: {
    stability: number;
    similarity_boost: number;
    style?: number;
    speed?: number;
    use_speaker_boost?: boolean;
  };
}

export const buildElevenLabsRequestBody = (
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; emotion?: string },
): ElevenLabsRequestBody => {
  const model = resolveElevenLabsModel(apiConfig);
  const rawStability = clamp(apiConfig.elevenLabsStability, 0.5, 0, 1);
  // Eleven v3 官方只定义 Creative / Natural / Robust 三档稳定度。
  const stability = isElevenLabsV3Model(model)
    ? [0, 0.5, 1].reduce((nearest, candidate) =>
        Math.abs(candidate - rawStability) < Math.abs(nearest - rawStability) ? candidate : nearest, 0.5)
    : rawStability;
  const languageCode = (options?.languageBoost || '').trim().toLowerCase();
  let spoken = cleanTextForTtsElevenLabs(text, model);
  const emotionCue = options?.emotion ? EMOTION_TO_AUDIO_CUE[options.emotion.toLowerCase()] : '';
  if (supportsElevenLabsAudioTags(model) && emotionCue && !/\[[^\]]+\]/.test(spoken)) {
    spoken = `[${emotionCue}] ${spoken}`;
  }
  return {
    text: spoken,
    model_id: model,
    ...(/^[a-z]{2}$/.test(languageCode) ? { language_code: languageCode } : {}),
    voice_settings: {
      stability,
      similarity_boost: clamp(apiConfig.elevenLabsSimilarityBoost, 0.8, 0, 1),
      ...(!isElevenLabsV4Model(model) ? {
        style: clamp(apiConfig.elevenLabsStyle, 0, 0, 1),
        speed: clamp(char.voiceProfile?.speed, 1, 0.7, 1.2),
        use_speaker_boost: apiConfig.elevenLabsUseSpeakerBoost === true,
      } : {}),
    },
  };
};

const isNative = (): boolean => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};

const useStaticWorker = (): boolean => {
  if (typeof window === 'undefined') return false;
  return isStaticWebDeployment(window.location.protocol, window.location.hostname);
};

const base64ToBlob = (base64: string, mime = 'audio/mpeg'): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

export const friendlyElevenLabsError = (status: number, detail: string): string => {
  const normalized = detail.toLowerCase();
  if (status === 401 || normalized.includes('invalid api key')) return 'ElevenLabs API Key 无效或已过期';
  if (status === 402 || normalized.includes('quota') || normalized.includes('credits')) return 'ElevenLabs 额度不足';
  if (status === 403) return 'ElevenLabs 拒绝访问，请检查 Key 权限或 IP 限制';
  if (status === 404) return 'ElevenLabs Voice ID 或模型不存在';
  if (status === 429) return 'ElevenLabs 请求过于频繁，请稍后再试';
  return `ElevenLabs TTS 失败 (HTTP ${status})${detail ? `：${detail.slice(0, 240)}` : ''}`;
};

const elevenLabsFetchAudio = async (
  voiceId: string,
  apiKey: string,
  payload: ElevenLabsRequestBody,
): Promise<Blob> => {
  const query = `voice_id=${encodeURIComponent(voiceId)}&output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}`;
  if (isNative()) {
    const response = await CapacitorHttp.request({
      url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      data: payload,
      responseType: 'blob',
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(friendlyElevenLabsError(response.status, String(response.data || '')));
    }
    const blob = base64ToBlob(String(response.data || ''));
    if (!blob.size) throw new Error('ElevenLabs 返回了空音频');
    return blob;
  }

  const url = useStaticWorker()
    ? `${getProxyWorkerUrl()}/elevenlabs/tts?${query}`
    : `/api/elevenlabs/tts?${query}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch { /* ignore */ }
    throw new Error(friendlyElevenLabsError(response.status, detail));
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('ElevenLabs 返回了空音频');
  return blob;
};

export async function synthesizeSpeechElevenLabsDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<TtsResult> {
  const apiKey = resolveElevenLabsApiKey(apiConfig);
  if (!apiKey) throw new Error('缺少 ElevenLabs API Key');
  const voiceId = normalizeElevenLabsVoiceId(char.voiceProfile?.elevenLabsVoiceId);
  if (!voiceId) throw new Error('角色未配置 ElevenLabs Voice ID');

  const payload = buildElevenLabsRequestBody(text, char, apiConfig, options);
  if (!payload.text) throw new Error('ElevenLabs TTS 文本为空');
  // v4 官方单次上限：明确报错，不能截掉用户台词或悄悄换模型。
  if (payload.model_id === 'eleven_v4' && Array.from(payload.text).length > 10000) {
    throw new Error('ElevenLabs v4 单次最多 10000 个字符，请将台词分成多段后再合成');
  }

  const cacheKey = hashTtsParams({
    kind: 'elevenlabs-tts',
    voice_id: voiceId,
    output_format: ELEVENLABS_OUTPUT_FORMAT,
    ...payload,
  });
  const cached = await getCachedTts(cacheKey);
  if (cached) return { url: URL.createObjectURL(cached), blob: cached };

  console.log('[elevenlabs] TTS', {
    model: payload.model_id,
    voice_id_suffix: voiceId.slice(-4),
    text_length: payload.text.length,
    language_code: payload.language_code || 'auto',
  });
  const blob = await elevenLabsFetchAudio(voiceId, apiKey, payload);
  saveCachedTts(cacheKey, blob).catch(() => { /* cache failure must not block playback */ });
  return { url: URL.createObjectURL(blob), blob };
}

export async function synthesizeSpeechElevenLabs(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<string> {
  const { url } = await synthesizeSpeechElevenLabsDetailed(text, char, apiConfig, options);
  return url;
}
