/** 模型默认值和能力门禁共用同一处，避免提示词与实际请求选到不同模型。 */
export const DEFAULT_ELEVENLABS_MODEL = 'eleven_v4';

export const ELEVENLABS_MODEL_OPTIONS = [
  { value: 'eleven_v4', label: 'Eleven v4 —— 音质与表现力优先，默认推荐' },
  { value: 'eleven_v4_turbo', label: 'Eleven v4 Turbo —— 低延迟、丰富表现力' },
  { value: 'eleven_flash_v2_5', label: 'Flash v2.5 —— 低延迟、用量更省' },
  { value: 'eleven_v3', label: 'Eleven v3 —— 支持 Audio Tags 的旧版模型' },
  { value: 'eleven_multilingual_v2', label: 'Multilingual v2 —— 长文本稳定' },
] as const;

export const normalizeElevenLabsModel = (raw?: string | null): string =>
  (raw || '').trim() || DEFAULT_ELEVENLABS_MODEL;

export const isElevenLabsV3Model = (raw?: string | null): boolean =>
  normalizeElevenLabsModel(raw) === 'eleven_v3';

export const isElevenLabsV4Model = (raw?: string | null): boolean =>
  ['eleven_v4', 'eleven_v4_turbo'].includes(normalizeElevenLabsModel(raw));

export const supportsElevenLabsAudioTags = (raw?: string | null): boolean =>
  isElevenLabsV3Model(raw) || isElevenLabsV4Model(raw);
