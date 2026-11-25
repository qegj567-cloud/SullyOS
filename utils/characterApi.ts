import type { APIConfig, ApiPreset, CharacterProfile, DialogueApiConfig } from '../types';
import { llmApiType } from './llmEndpoint';
import { normalizeDialogueSlot } from './apiConfigNormalize';
import { readStoredPresets, resolveEffectiveSlot, resolveGlobalMainApi } from './apiSlots';

export function normalizeDialogueMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function dialogueMaxTokens(api: Pick<APIConfig, 'maxTokens'>): number {
  return normalizeDialogueMaxTokens(api.maxTokens) ?? 8000;
}

/**
 * 单角色对话请求的统一路由入口：App 独立 API → 角色独立 API → 全局主对话 API。
 * 每一层若绑定了有效预设（presetId 且指纹吻合），实时解析预设最新配置；
 * 凭据整套采用，绝不逐字段从不同层级补齐。
 */
export function resolveDialogueApi(
  globalApi: APIConfig,
  character?: Pick<CharacterProfile, 'dialogueApi'> | null,
  appApi?: DialogueApiConfig | null,
  presets: readonly ApiPreset[] = readStoredPresets(),
): APIConfig {
  const resolvedGlobal = resolveGlobalMainApi(globalApi, presets);
  const resolvedApp = resolveEffectiveSlot(appApi, presets);
  const resolvedChar = resolveEffectiveSlot(character?.dialogueApi, presets);
  const source = resolvedApp ?? resolvedChar;
  if (!source) return resolvedGlobal;
  return {
    ...resolvedGlobal,
    ...pickDialogueApi(source),
    apiType: llmApiType(source),
  };
}

/** 提取并归一化对话接口字段（保留 presetId 与 presetFp 引用元数据，避免落盘时洗掉绑定关系）。 */
export function pickDialogueApi(api: DialogueApiConfig): DialogueApiConfig {
  return normalizeDialogueSlot(api);
}

export function describeDialogueApi(
  api: DialogueApiConfig | null | undefined,
  presets: readonly ApiPreset[] = readStoredPresets(),
): string {
  if (!api) return '未设置模型';
  const effective = resolveEffectiveSlot(api, presets) ?? api;
  const bound = api.presetId ? presets.find((p) => p.id === api.presetId) : undefined;
  let host = '';
  try { host = new URL(effective.baseUrl).host; } catch { /* Unconfigured/invalid URL. Never display credentials. */ }
  const detail = [host, effective.model || '未设置模型'].filter(Boolean).join(' · ');
  return bound ? `预设「${bound.name}」 · ${detail}` : detail;
}
