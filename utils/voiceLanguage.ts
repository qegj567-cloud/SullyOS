export const VOICE_LANGUAGE_OPTIONS = [
  { value: '', label: '默认' },
  { value: 'yue', label: '粤语 / 廣東話' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'de', label: 'Deutsch' },
  { value: 'ru', label: 'Русский' },
] as const;

export const CANTONESE_VOICE_SUPPORT_NOTE = 'MiniMax 与 Fish S2 系列可直接使用；ElevenLabs 需选择 Eleven v3、v4 或 v4 Turbo。';

export const voiceLanguageLabel = (value?: string): string => (
  VOICE_LANGUAGE_OPTIONS.find(option => option.value === (value || ''))?.label
  || value
  || '默认'
);

/**
 * 统计只允许发送源码里写死的语种枚举。角色数据可能来自旧备份或手工编辑，
 * 所以不能把未知值直接交给 Umami；空值也换成可读的固定代号。
 */
export const voiceLanguageAnalyticsValue = (value?: string): string => {
  const normalized = value || '';
  return VOICE_LANGUAGE_OPTIONS.some(option => option.value === normalized)
    ? (normalized || 'default')
    : 'custom';
};

/**
 * 给 LLM 的目标语种说明要比界面标签更精确。只写“粤语”时，一些模型仍会产出
 * 普通书面中文，TTS 最后只能按普通话念；这里明确要求粤语口语和粤语用字。
 */
export const voiceLanguagePromptLabel = (value?: string): string => {
  if ((value || '').trim().toLowerCase() === 'yue') {
    return '地道、自然的粤语口语（粵語／廣東話），使用繁体粤语用字，不要写成普通话书面语';
  }
  return voiceLanguageLabel(value);
};
