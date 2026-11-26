import type { APIConfig, ApiPreset, DialogueApiConfig, VisionApiConfig } from '../types';
import { normalizeLlmBaseUrl } from './llmEndpoint';

// Clipboard contents can carry zero-width characters that String.trim() does not
// remove. They are never valid at the edges of an API URL, token, or model id.
const EDGE_INVISIBLE_CHARS = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

const cleanEdgeCharacters = (value: unknown): string =>
  String(value ?? '').replace(EDGE_INVISIBLE_CHARS, '');

export const normalizeApiBaseUrl = (value: unknown): string =>
  cleanEdgeCharacters(value).replace(/\/+$/, '');

export const normalizeApiCredential = (value: unknown): string =>
  cleanEdgeCharacters(value);

export const normalizeApiModel = (value: unknown): string =>
  cleanEdgeCharacters(value);

const normalizePositiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const normalizePresetMeta = (slot: { presetId?: unknown; presetFp?: unknown }) => {
  const presetId = typeof slot.presetId === 'string' ? cleanEdgeCharacters(slot.presetId) : '';
  const presetFp = typeof slot.presetFp === 'string' ? cleanEdgeCharacters(slot.presetFp) : '';
  return {
    ...(presetId ? { presetId } : {}),
    ...(presetId && presetFp ? { presetFp } : {}),
  };
};

export function normalizeDialogueSlot(slot: DialogueApiConfig): DialogueApiConfig {
  const apiType = slot.apiType === 'anthropic' || slot.apiType === 'openai' ? slot.apiType : undefined;
  const maxTokens = normalizePositiveInt(slot.maxTokens);
  return {
    baseUrl: normalizeLlmBaseUrl(normalizeApiBaseUrl(slot.baseUrl), apiType),
    ...(apiType ? { apiType } : {}),
    apiKey: normalizeApiCredential(slot.apiKey),
    model: normalizeApiModel(slot.model),
    ...(typeof slot.stream === 'boolean' ? { stream: slot.stream } : {}),
    ...(typeof slot.temperature === 'number' && Number.isFinite(slot.temperature) ? { temperature: slot.temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...normalizePresetMeta(slot),
  };
}

const normalizeOptionalDialogueSlot = (slot: DialogueApiConfig | undefined): DialogueApiConfig | undefined => {
  if (!slot || typeof slot !== 'object') return undefined;
  const normalized = normalizeDialogueSlot(slot);
  if (!normalized.presetId && !normalized.baseUrl && !normalized.apiKey && !normalized.model) {
    return undefined;
  }
  return normalized;
};

function normalizeVisionSlot(visionApi: VisionApiConfig): VisionApiConfig {
  const apiType = visionApi.apiType === 'anthropic' || visionApi.apiType === 'openai' ? visionApi.apiType : undefined;
  const maxTokens = normalizePositiveInt(visionApi.maxTokens);
  return {
    enabled: visionApi.enabled === true,
    ...(apiType ? { apiType } : {}),
    baseUrl: normalizeLlmBaseUrl(normalizeApiBaseUrl(visionApi.baseUrl), apiType),
    apiKey: normalizeApiCredential(visionApi.apiKey),
    model: normalizeApiModel(visionApi.model),
    ...(typeof visionApi.stream === 'boolean' ? { stream: visionApi.stream } : {}),
    ...(typeof visionApi.temperature === 'number' && Number.isFinite(visionApi.temperature) ? { temperature: visionApi.temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...normalizePresetMeta(visionApi),
  };
}

export function normalizeApiConfig(config: APIConfig): APIConfig {
  const visionApi = config.visionApi;
  const emotionApi = normalizeOptionalDialogueSlot(config.emotionApi);
  const thinkingTranslationApi = normalizeOptionalDialogueSlot(config.thinkingTranslationApi);
  const meta = normalizePresetMeta(config);
  const next: APIConfig = {
    ...config,
    baseUrl: normalizeLlmBaseUrl(normalizeApiBaseUrl(config.baseUrl), config.apiType),
    apiKey: normalizeApiCredential(config.apiKey),
    model: normalizeApiModel(config.model),
    presetId: meta.presetId,
    presetFp: meta.presetFp,
    emotionApi,
    thinkingTranslationApi,
    ...(visionApi ? { visionApi: normalizeVisionSlot(visionApi) } : {}),
    ...(config.minimaxApiKey !== undefined ? { minimaxApiKey: normalizeApiCredential(config.minimaxApiKey) } : {}),
    ...(config.minimaxGroupId !== undefined ? { minimaxGroupId: normalizeApiCredential(config.minimaxGroupId) } : {}),
    ...(config.fishAudioApiKey !== undefined ? { fishAudioApiKey: normalizeApiCredential(config.fishAudioApiKey) } : {}),
    ...(config.elevenLabsApiKey !== undefined ? { elevenLabsApiKey: normalizeApiCredential(config.elevenLabsApiKey) } : {}),
    ...(config.aceStepApiKey !== undefined ? { aceStepApiKey: normalizeApiCredential(config.aceStepApiKey) } : {}),
  };
  if (!next.presetId) delete next.presetId;
  if (!next.presetFp) delete next.presetFp;
  if (!next.emotionApi) delete next.emotionApi;
  if (!next.thinkingTranslationApi) delete next.thinkingTranslationApi;
  return next;
}

/**
 * 主对话配置的一次保存：合并、脱离预设、规范化。OSContext.updateApiConfig 与它的测试共用这一份。
 * 改了连接字段却没显式传 presetId，就是转成单独填写，旧的预设引用要一起去掉。
 */
export function mergeApiConfigUpdate(prev: APIConfig, updates: Partial<APIConfig>): APIConfig {
  const merged: APIConfig = { ...prev, ...updates };
  const touchedMainConn = 'baseUrl' in updates || 'apiKey' in updates || 'model' in updates || 'apiType' in updates;
  if (touchedMainConn && !('presetId' in updates)) {
    delete merged.presetId;
    delete merged.presetFp;
  }
  return normalizeApiConfig(merged);
}

export function normalizeApiPreset(preset: ApiPreset): ApiPreset {
  const normalizedConfig = normalizeApiConfig(preset.config);
  // 预设本身是引用源头，不嵌套指向其他预设，也不携带识图/副 API 等全局附带块。
  delete normalizedConfig.presetId;
  delete normalizedConfig.presetFp;
  delete normalizedConfig.visionApi;
  delete normalizedConfig.emotionApi;
  delete normalizedConfig.thinkingTranslationApi;
  return {
    ...preset,
    name: String(preset.name ?? '').trim(),
    ...(preset.group?.trim() ? { group: preset.group.trim() } : { group: undefined }),
    config: normalizedConfig,
  };
}
