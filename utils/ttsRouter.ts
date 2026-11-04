/**
 * TTS 服务商路由：按 apiConfig.ttsProvider 分发到 MiniMax、鱼声 Fish Audio 或 ElevenLabs。
 *
 * 聊天语音条（Chat）、约会（DateSession）直接用这里的 synthesizeSpeech(Detailed)，
 * 不必关心底层是哪家。CallApp 因为要做分句流式 + 缓存键对齐，单独在自己内部分支。
 */
import { CharacterProfile, APIConfig } from '../types';
import {
  synthesizeSpeechDetailed as minimaxSynthesizeDetailed,
  type TtsResult,
} from './minimaxTts';
import { synthesizeSpeechFishDetailed } from './fishAudioTts';
import { resolveTtsProvider } from './ttsProvider';
import {
  cleanTextForTtsElevenLabs,
  normalizeElevenLabsVoiceId,
  resolveElevenLabsApiKey,
  resolveElevenLabsModel,
  stripElevenLabsMarkupForDisplay,
  synthesizeSpeechElevenLabsDetailed,
} from './elevenLabsTts';
import { cleanTextForTts, cleanVoiceMarkupForDisplay } from './minimaxTts';
import { cleanTextForTtsFish, resolveFishAudioApiKey, stripFishMarkupForDisplay } from './fishAudioTts';
import { resolveMiniMaxApiKey } from './minimaxApiKey';
import { supportsElevenLabsAudioTags } from './elevenLabsModels';

export type { TtsResult };

type SynthOptions = { languageBoost?: string; groupId?: string; emotion?: string };

/** 粤语并非三家所有模型都支持；在发起计费请求前给出明确错误。 */
export const assertTtsLanguageSupported = (
  char: CharacterProfile,
  apiConfig: APIConfig,
  languageBoost?: string,
): void => {
  if ((languageBoost || '').trim().toLowerCase() !== 'yue') return;
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'elevenlabs' && !supportsElevenLabsAudioTags(resolveElevenLabsModel(apiConfig))) {
    throw new Error('ElevenLabs 粤语需要 Eleven v3 / v4 / v4 Turbo，请先在「设置 → 其他 API」切换模型');
  }
  const fishModel = (char.voiceProfile?.fishModel || apiConfig.fishAudioModel || 's2.1-pro').trim().toLowerCase();
  if (provider === 'fishaudio' && fishModel === 's1') {
    throw new Error('鱼声粤语需要 S2 系列，请先在「设置 → 其他 API」切换到 S2.1 Pro 或 S2 Pro');
  }
};

export async function synthesizeSpeechDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: SynthOptions,
): Promise<TtsResult> {
  assertTtsLanguageSupported(char, apiConfig, options?.languageBoost);
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') {
    return synthesizeSpeechFishDetailed(text, char, apiConfig, options);
  }
  if (provider === 'elevenlabs') {
    return synthesizeSpeechElevenLabsDetailed(text, char, apiConfig, options);
  }
  return minimaxSynthesizeDetailed(text, char, apiConfig, options);
}

export async function synthesizeSpeech(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: SynthOptions,
): Promise<string> {
  const { url } = await synthesizeSpeechDetailed(text, char, apiConfig, options);
  return url;
}

/**
 * 当前 TTS 服务商下，这个角色是否已配好可用音色。
 * 鱼声看 fishReferenceId；MiniMax 看 voiceId / timberWeights。
 * 各处「要不要显示语音按钮 / 要不要触发自动 TTS」的判断统一用它，避免漏掉鱼声分支。
 */
export const characterHasVoice = (char: CharacterProfile, apiConfig: APIConfig): boolean => {
  const vp = char.voiceProfile;
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') {
    return !!vp?.fishReferenceId;
  }
  if (provider === 'elevenlabs') return !!normalizeElevenLabsVoiceId(vp?.elevenLabsVoiceId);
  return !!(vp?.voiceId || (vp?.timberWeights && vp.timberWeights.length > 0));
};

/** 当前服务商的 Key + 当前角色音色是否都已配置。 */
export const canSynthesizeSpeech = (char: CharacterProfile, apiConfig: APIConfig): boolean => {
  if (!characterHasVoice(char, apiConfig)) return false;
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') return !!resolveFishAudioApiKey(apiConfig);
  if (provider === 'elevenlabs') return !!resolveElevenLabsApiKey(apiConfig);
  return !!resolveMiniMaxApiKey(apiConfig);
};

/** 按服务商清洗待朗读文本，调用方不应再自己猜哪种标签该保留。 */
export const cleanTextForTtsProvider = (text: string, apiConfig: APIConfig): string => {
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') return cleanTextForTtsFish(text);
  if (provider === 'elevenlabs') return cleanTextForTtsElevenLabs(text, resolveElevenLabsModel(apiConfig));
  return cleanTextForTts(text);
};

export const stripTtsMarkupForDisplay = (text: string, apiConfig: APIConfig): string => {
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'fishaudio') return stripFishMarkupForDisplay(text);
  if (provider === 'elevenlabs') return stripElevenLabsMarkupForDisplay(text, resolveElevenLabsModel(apiConfig));
  return cleanVoiceMarkupForDisplay(text);
};

/** Fish / ElevenLabs 的清洗器需要看到原始 inline cue；MiniMax 使用已消毒的 speech。 */
export const providerUsesRawVoiceMarkup = (apiConfig: APIConfig): boolean =>
  resolveTtsProvider(apiConfig) !== 'minimax';
