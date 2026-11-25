/**
 * 全站统一的 API 槽位（ApiSlot）、预设引用（presetId + presetFp）与非 React 配置中心。
 *
 * 设计约束（详见 docs/api-slots.md）：
 * 1. Canary 与正式版共用同一份本地数据库（IndexedDB + localStorage），因此每个槽位保留内联
 *    baseUrl / apiKey / model 作为最新快照，在此之上附加 presetId 与 presetFp。
 * 2. presetFp 对归一化后的核心连接四件套（协议类型、地址、密钥、模型名）算指纹。任何不认识
 *    presetId 的旧代码直接改了内联值，指纹失配后自动识别为「已脱离预设转为单独填写」。
 * 3. 自动保存仅在「必填完整合法」或「三项全空（恢复跟随）」时落盘，半成品只停留在面板草稿。
 */

import type { APIConfig, ApiPreset, DialogueApiConfig } from '../types';
import {
  normalizeApiBaseUrl,
  normalizeApiCredential,
  normalizeApiModel,
  normalizeApiPreset,
  normalizeDialogueSlot,
} from './apiConfigNormalize';
import { presetMatchesConfig } from './apiPresetSwitch';
import { llmApiType, normalizeLlmBaseUrl, type LlmApiType } from './llmEndpoint';
import { normalizeModelIds } from './modelList';

export const PRESETS_STORAGE_KEY = 'os_api_presets';
export const MAIN_API_STORAGE_KEY = 'os_api_config';
export const MEMORY_PALACE_STORAGE_KEY = 'os_memory_palace_config';
export const ENDPOINT_MODELS_CACHE_KEY = 'sullyos_endpoint_models_v1';
const MAX_ENDPOINT_MODEL_BUCKETS = 24;

/** FNV-1a 32 位哈希：只用来判断内联连接字段是否被外部改过，不做任何安全用途。 */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(36)}.${text.length.toString(36)}`;
}

/**
 * 计算槽位核心连接四件套的指纹。
 * 不纳入 temperature / stream：部分历史预设未保存这两项，主配置或协同窗口合并自己的默认参数时
 * 不应破坏预设绑定指纹。
 */
export function computeSlotPresetFp(
  slot: Pick<DialogueApiConfig, 'baseUrl' | 'apiKey' | 'model' | 'apiType'>,
): string {
  const apiType = llmApiType(slot);
  const baseUrl = normalizeLlmBaseUrl(normalizeApiBaseUrl(slot.baseUrl), apiType);
  const apiKey = normalizeApiCredential(slot.apiKey);
  const model = normalizeApiModel(slot.model);
  return fnv1a32(`${apiType}\0${baseUrl}\0${apiKey}\0${model}`);
}

/** 从预设生成带引用 ID 与快照指纹的标准槽位。 */
export function slotFromPreset(preset: ApiPreset): DialogueApiConfig {
  const normalized = normalizeApiPreset(preset);
  const c = normalized.config;
  const base: DialogueApiConfig = {
    baseUrl: c.baseUrl,
    ...(c.apiType ? { apiType: c.apiType } : {}),
    apiKey: c.apiKey,
    model: c.model,
    ...(typeof c.stream === 'boolean' ? { stream: c.stream } : {}),
    ...(typeof c.temperature === 'number' && Number.isFinite(c.temperature) ? { temperature: c.temperature } : {}),
    ...(typeof c.maxTokens === 'number' && Number.isSafeInteger(c.maxTokens) && c.maxTokens > 0
      ? { maxTokens: c.maxTokens }
      : {}),
  };
  return {
    ...base,
    presetId: normalized.id,
    presetFp: computeSlotPresetFp(base),
  };
}

/** 剥离预设引用标记，保留当前有效连接参数作为独立自定义配置。 */
export function detachSlotFromPreset(
  slot: DialogueApiConfig,
  presets: readonly ApiPreset[] = readStoredPresets(),
): DialogueApiConfig {
  const effective = resolveEffectiveSlot(slot, presets) ?? normalizeDialogueSlot(slot);
  const copy: DialogueApiConfig = { ...effective };
  delete copy.presetId;
  delete copy.presetFp;
  return copy;
}

export function isBlankApiSlot(
  slot: Partial<Pick<DialogueApiConfig, 'baseUrl' | 'apiKey' | 'model'>> | null | undefined,
): boolean {
  if (!slot) return true;
  return !normalizeApiBaseUrl(slot.baseUrl)
    && !normalizeApiCredential(slot.apiKey)
    && !normalizeApiModel(slot.model);
}

export type SlotPresetBindingState =
  | { status: 'empty' }
  | { status: 'bound'; preset: ApiPreset }
  | { status: 'deleted_preset'; presetId: string }
  | { status: 'custom' };

/** 判断一个槽位当前是跟随默认（空）、正常绑定预设、原预设已删、还是单独填写。 */
export function inspectSlotPresetBinding(
  slot: Partial<DialogueApiConfig> | null | undefined,
  presets: readonly ApiPreset[] = readStoredPresets(),
): SlotPresetBindingState {
  if (!slot) return { status: 'empty' };
  const presetId = typeof slot.presetId === 'string' ? slot.presetId.trim() : '';
  if (presetId) {
    const inlineCandidate: Pick<DialogueApiConfig, 'baseUrl' | 'apiKey' | 'model' | 'apiType'> = {
      baseUrl: String(slot.baseUrl ?? ''),
      apiKey: String(slot.apiKey ?? ''),
      model: String(slot.model ?? ''),
      apiType: slot.apiType,
    };
    // 若存有指纹但当前内联值指纹对不上，说明被不认识 presetId 的入口直接改过内联值，自动脱离预设。
    if (slot.presetFp && slot.presetFp !== computeSlotPresetFp(inlineCandidate)) {
      return isBlankApiSlot(inlineCandidate) ? { status: 'empty' } : { status: 'custom' };
    }
    const found = presets.find((p) => p.id === presetId);
    if (found) return { status: 'bound', preset: found };
    return isBlankApiSlot(inlineCandidate)
      ? { status: 'empty' }
      : { status: 'deleted_preset', presetId };
  }
  return isBlankApiSlot(slot) ? { status: 'empty' } : { status: 'custom' };
}

export type ApiSlotValidationFailureReason = 'missing_url' | 'invalid_url' | 'missing_model';

export type ApiSlotDraftValidation =
  | { kind: 'blank' }
  | { kind: 'valid'; normalized: DialogueApiConfig }
  | { kind: 'incomplete'; reason: ApiSlotValidationFailureReason; message: string };

export function isValidHttpApiUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 所见即所得自动保存的提交校验：
 * - blank：地址、密钥、模型三项全空 → 提交为恢复跟随（undefined）
 * - valid：地址为合法 http(s) 且模型非空（密钥允许留空以兼容本地免密模型）→ 可安全落盘与同步
 * - incomplete：填了一半或地址格式错误 → 仅保留在面板内提示，绝不写入存储或同步云端
 */
export function validateApiSlotDraft(draft: Partial<DialogueApiConfig> | null | undefined): ApiSlotDraftValidation {
  if (isBlankApiSlot(draft)) return { kind: 'blank' };
  const apiType: LlmApiType = draft?.apiType === 'anthropic' ? 'anthropic'
    : draft?.apiType === 'openai' ? 'openai'
    : llmApiType({ baseUrl: String(draft?.baseUrl ?? '') });
  const rawBaseUrl = normalizeApiBaseUrl(draft?.baseUrl);
  if (!rawBaseUrl) {
    return { kind: 'incomplete', reason: 'missing_url', message: '还缺：API 地址' };
  }
  if (!isValidHttpApiUrl(rawBaseUrl)) {
    return { kind: 'incomplete', reason: 'invalid_url', message: 'API 地址需以 http:// 或 https:// 开头' };
  }
  const model = normalizeApiModel(draft?.model);
  if (!model) {
    return { kind: 'incomplete', reason: 'missing_model', message: '还缺：模型名称' };
  }
  const normalized = normalizeDialogueSlot({
    baseUrl: rawBaseUrl,
    apiType,
    apiKey: String(draft?.apiKey ?? ''),
    model,
    stream: draft?.stream,
    temperature: draft?.temperature,
    maxTokens: draft?.maxTokens,
  });
  delete normalized.presetId;
  delete normalized.presetFp;
  return { kind: 'valid', normalized };
}

/**
 * 解析单个槽位此刻真正生效的配置：
 * - 绑定预设且预设存在 → 实时取预设最新值（附带 presetId / presetFp）
 * - 单独填写或原预设已删除 → 取归一化后的内联快照（剥掉已失效的 presetId）
 * - 未配置（空） → 返回 null，由调用方走各自的默认回退链
 */
export function resolveEffectiveSlot(
  slot: Partial<DialogueApiConfig> | null | undefined,
  presets: readonly ApiPreset[] = readStoredPresets(),
): DialogueApiConfig | null {
  const state = inspectSlotPresetBinding(slot, presets);
  if (state.status === 'empty') return null;
  if (state.status === 'bound') {
    return slotFromPreset(state.preset);
  }
  const normalized = normalizeDialogueSlot({
    baseUrl: String(slot?.baseUrl ?? ''),
    apiType: slot?.apiType,
    apiKey: String(slot?.apiKey ?? ''),
    model: String(slot?.model ?? ''),
    stream: slot?.stream,
    temperature: slot?.temperature,
    maxTokens: slot?.maxTokens,
  });
  delete normalized.presetId;
  delete normalized.presetFp;
  return normalized;
}

/** 解析全局主对话 API：若主对话绑定了有效预设，实时合入预设最新连接与生成参数；否则保持原对象引用。 */
export function resolveGlobalMainApi(
  globalApi: APIConfig,
  presets: readonly ApiPreset[] = readStoredPresets(),
): APIConfig {
  const state = inspectSlotPresetBinding(globalApi, presets);
  if (state.status !== 'bound') {
    return globalApi;
  }
  const fromPreset = slotFromPreset(state.preset);
  return {
    ...globalApi,
    ...fromPreset,
    apiType: llmApiType(fromPreset),
  };
}

/**
 * 解析副 API / 专用应用独立 API（记忆宫殿、情绪、心象翻译、自习室、模拟人生、家园等）：
 * - 未配置（空）→ 整套回退到解析后的全局主对话 API
 * - 已配置 → 整套采用该槽位自身的凭据（严禁逐字段拿全局主 API 补齐，防止跨服务商泄漏 Key）
 */
export function resolveAuxiliaryApi(
  slot: Partial<DialogueApiConfig> | null | undefined,
  globalApi: APIConfig,
  presets: readonly ApiPreset[] = readStoredPresets(),
): APIConfig {
  const main = resolveGlobalMainApi(globalApi, presets);
  const resolved = resolveEffectiveSlot(slot, presets);
  if (!resolved) return main;
  return {
    ...main,
    baseUrl: resolved.baseUrl,
    apiType: llmApiType(resolved),
    apiKey: resolved.apiKey,
    model: resolved.model,
    ...(typeof resolved.stream === 'boolean' ? { stream: resolved.stream } : {}),
    ...(typeof resolved.temperature === 'number' ? { temperature: resolved.temperature } : {}),
    ...(typeof resolved.maxTokens === 'number' ? { maxTokens: resolved.maxTokens } : {}),
    presetId: resolved.presetId,
    presetFp: resolved.presetFp,
  };
}

/** 判断配置是否具备发起对话/生成请求的最小必填项（地址与模型均非空）。 */
export function isRunnableLlmApi(
  api: Partial<Pick<DialogueApiConfig, 'baseUrl' | 'model'>> | null | undefined,
): api is { baseUrl: string; model: string; apiKey?: string; apiType?: LlmApiType } {
  if (!api) return false;
  const baseUrl = normalizeApiBaseUrl(api.baseUrl);
  const model = normalizeApiModel(api.model);
  return Boolean(baseUrl && isValidHttpApiUrl(baseUrl) && model);
}

/**
 * 存量配置唯一匹配自动绑预设：
 * 仅当槽位尚未携带 presetId，且与 presets 中**唯一一条**预设严格匹配时才自动挂载引用。
 * 若有多条完全相同的重复预设，保持不绑，避免替用户猜错目标。
 */
export function autoBindUniquePreset<T extends DialogueApiConfig>(
  slot: T | null | undefined,
  presets: readonly ApiPreset[],
  options: { credentialsOnly?: boolean } = {},
): { slot: T; boundPresetId: string | null } | null {
  if (!slot || isBlankApiSlot(slot)) return null;
  if (typeof slot.presetId === 'string' && slot.presetId.trim()) {
    return { slot, boundPresetId: null };
  }
  const matches = presets.filter((preset) => {
    if (!presetMatchesConfig(preset, slot)) return false;
    if (options.credentialsOnly) return true;
    if (typeof slot.stream === 'boolean' && typeof preset.config.stream === 'boolean' && slot.stream !== preset.config.stream) {
      return false;
    }
    if (typeof slot.temperature === 'number' && typeof preset.config.temperature === 'number' && slot.temperature !== preset.config.temperature) {
      return false;
    }
    if (typeof slot.maxTokens === 'number' && typeof preset.config.maxTokens === 'number' && slot.maxTokens !== preset.config.maxTokens) {
      return false;
    }
    return true;
  });
  if (matches.length !== 1) return { slot, boundPresetId: null };
  const matched = matches[0];
  const next: T = {
    ...slot,
    presetId: matched.id,
    presetFp: computeSlotPresetFp(slot),
  };
  return { slot: next, boundPresetId: matched.id };
}

// ─── 非 React 共享存储读取与版本号通知（供云端凭据同步与非组件调用链直接读取最新值） ───

let configVersion = 1;
const listeners = new Set<() => void>();

export function getApiConfigVersion(): number {
  return configVersion;
}

export function bumpApiConfigVersion(): number {
  configVersion += 1;
  for (const listener of listeners) {
    try { listener(); } catch (err) { console.warn('[apiSlots] listener error', err); }
  }
  return configVersion;
}

export function subscribeApiSlotChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readStoredPresets(): ApiPreset[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PRESETS_STORAGE_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ApiPreset => Boolean(item && typeof item === 'object' && typeof item.id === 'string' && item.config))
      .map(normalizeApiPreset);
  } catch {
    return [];
  }
}

export function readStoredMainApi(): APIConfig | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(MAIN_API_STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as APIConfig;
  } catch {
    return null;
  }
}

export function readStoredMemoryLightLlm(): DialogueApiConfig | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(MEMORY_PALACE_STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.lightLLM || typeof parsed.lightLLM !== 'object') return null;
    return parsed.lightLLM as DialogueApiConfig;
  } catch {
    return null;
  }
}

// ─── 按渠道（协议类型 + 规范化地址，不含密钥）隔离的模型列表缓存 ───

interface EndpointModelBucket {
  models: string[];
  updatedAt: number;
}

export function endpointModelBucketKey(
  slot: Pick<DialogueApiConfig, 'baseUrl' | 'apiType'> | null | undefined,
): string | null {
  if (!slot) return null;
  const apiType = llmApiType({ baseUrl: String(slot.baseUrl ?? ''), apiType: slot.apiType });
  const normalizedUrl = normalizeLlmBaseUrl(normalizeApiBaseUrl(slot.baseUrl), apiType);
  if (!normalizedUrl || !isValidHttpApiUrl(normalizedUrl)) return null;
  return `${apiType}:${normalizedUrl}`;
}

export function readCachedModelsForEndpoint(
  slot: Pick<DialogueApiConfig, 'baseUrl' | 'apiType'> | null | undefined,
): string[] {
  const key = endpointModelBucketKey(slot);
  if (!key) return [];
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(ENDPOINT_MODELS_CACHE_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, EndpointModelBucket> | null;
    const entry = parsed && typeof parsed === 'object' ? parsed[key] : undefined;
    return entry && Array.isArray(entry.models) ? normalizeModelIds(entry.models) : [];
  } catch {
    return [];
  }
}

export function writeCachedModelsForEndpoint(
  slot: Pick<DialogueApiConfig, 'baseUrl' | 'apiType'> | null | undefined,
  models: string[],
): string[] {
  const safeModels = normalizeModelIds(models);
  const key = endpointModelBucketKey(slot);
  if (!key || safeModels.length === 0) return safeModels;
  try {
    if (typeof localStorage === 'undefined') return safeModels;
    const raw = localStorage.getItem(ENDPOINT_MODELS_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const table: Record<string, EndpointModelBucket> = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...parsed }
      : {};
    table[key] = { models: safeModels, updatedAt: Date.now() };
    const keys = Object.keys(table);
    if (keys.length > MAX_ENDPOINT_MODEL_BUCKETS) {
      keys
        .sort((a, b) => (table[a]?.updatedAt ?? 0) - (table[b]?.updatedAt ?? 0))
        .slice(0, keys.length - MAX_ENDPOINT_MODEL_BUCKETS)
        .forEach((k) => { delete table[k]; });
    }
    localStorage.setItem(ENDPOINT_MODELS_CACHE_KEY, JSON.stringify(table));
  } catch {
    // 缓存写失败不影响主流程。
  }
  return safeModels;
}
