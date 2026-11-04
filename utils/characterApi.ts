import type { APIConfig, CharacterProfile, DialogueApiConfig } from '../types';
import { normalizeLlmBaseUrl, llmApiType } from './llmEndpoint';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from './apiConfigNormalize';

export function normalizeDialogueMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function dialogueMaxTokens(api: Pick<APIConfig, 'maxTokens'>): number {
  return normalizeDialogueMaxTokens(api.maxTokens) ?? 8000;
}

/** Only dialogue calls opt in. Directors, memory, vision and TTS keep their own routes. */
export function resolveDialogueApi(
  globalApi: APIConfig,
  character?: Pick<CharacterProfile, 'dialogueApi'> | null,
  appApi?: DialogueApiConfig | null,
): APIConfig {
  const source = appApi ?? character?.dialogueApi;
  if (!source) return globalApi;
  // Credentials are atomic; never fill a missing key/model from a different provider.
  return { ...globalApi, ...pickDialogueApi(source), apiType: llmApiType(source) };
}

export function pickDialogueApi(api: DialogueApiConfig): DialogueApiConfig {
  return {
    baseUrl: normalizeLlmBaseUrl(normalizeApiBaseUrl(api.baseUrl), api.apiType),
    ...(api.apiType ? {apiType: api.apiType} : {}),
    apiKey: normalizeApiCredential(api.apiKey),
    model: normalizeApiModel(api.model),
    ...(typeof api.stream === 'boolean' ? { stream: api.stream } : {}),
    ...(typeof api.temperature === 'number' ? { temperature: api.temperature } : {}),
    ...(normalizeDialogueMaxTokens(api.maxTokens) !== undefined ? { maxTokens: api.maxTokens } : {}),
  };
}

export function describeDialogueApi(api: DialogueApiConfig): string {
  let host = '';
  try { host = new URL(api.baseUrl).host; } catch { /* Unconfigured/invalid URL. Never display credentials. */ }
  return [host, api.model || '未设置模型'].filter(Boolean).join(' · ');
}
