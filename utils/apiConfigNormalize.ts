import type { APIConfig, ApiPreset } from '../types';
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

export function normalizeApiConfig(config: APIConfig): APIConfig {
  const visionApi = config.visionApi;
  const videoApi = config.companionVideoApi;
  const stt = config.companionStt;
  return {
    ...config,
    baseUrl: normalizeLlmBaseUrl(normalizeApiBaseUrl(config.baseUrl), config.apiType),
    apiKey: normalizeApiCredential(config.apiKey),
    model: normalizeApiModel(config.model),
    ...(stt ? { companionStt: {
      provider: stt.provider === 'doubao' ? 'doubao' as const : 'browser' as const,
      apiKey: normalizeApiCredential(stt.apiKey),
      resourceId: stt.resourceId === 'volc.seedasr.sauc.concurrent' ? 'volc.seedasr.sauc.concurrent' as const : 'volc.seedasr.sauc.duration' as const,
    } } : {}),
    // Whitelist current video settings: retired upload addresses/tokens never survive load/import/save.
    ...(videoApi ? { companionVideoApi: {
      ...(videoApi.provider ? { provider: videoApi.provider } : {}),
      baseUrl: normalizeApiBaseUrl(videoApi.baseUrl),
      apiKey: normalizeApiCredential(videoApi.apiKey),
      model: normalizeApiModel(videoApi.model),
    } } : {}),
    ...(visionApi ? {
      visionApi: {
        enabled: visionApi.enabled === true,
        baseUrl: normalizeApiBaseUrl(visionApi.baseUrl),
        apiKey: normalizeApiCredential(visionApi.apiKey),
        model: normalizeApiModel(visionApi.model),
      },
    } : {}),
  };
}

export function normalizeApiPreset(preset: ApiPreset): ApiPreset {
  return {
    ...preset,
    name: String(preset.name ?? '').trim(),
    config: normalizeApiConfig(preset.config),
  };
}
