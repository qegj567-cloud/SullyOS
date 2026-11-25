import type { APIConfig, ApiPreset, DialogueApiConfig } from '../../types';
import { computeSlotPresetFp, resolveGlobalMainApi, slotFromPreset } from '../../utils/apiSlots';
import { extractModelIds } from '../../utils/modelList';
import { safeResponseJson } from '../../utils/safeApi';
import type { CollaborationApiProfile, CollaborationSettings } from './types';

const hasConnection = (profile: CollaborationApiProfile): boolean => Boolean(
  profile.baseUrl.trim() || profile.apiKey.trim() || profile.model.trim(),
);

export const collaborationProfileFromApi = (
  config: APIConfig | DialogueApiConfig,
  source: 'chat' | 'preset' | 'custom',
  sourceName: string,
  sourceId?: string,
): CollaborationApiProfile => {
  const base: CollaborationApiProfile = {
    ...(config.apiType ? { apiType: config.apiType } : {}),
    baseUrl: config.baseUrl || '',
    apiKey: config.apiKey || '',
    model: config.model || '',
    ...(typeof config.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
    stream: config.stream ?? true,
    temperature: config.temperature ?? 0.7,
    source,
    sourceId,
    sourceName,
  };
  if (source === 'preset' && sourceId) {
    base.presetId = sourceId;
    base.presetFp = computeSlotPresetFp(base);
  }
  return base;
};

const refreshLinkedProfile = (
  profile: CollaborationApiProfile,
  config: APIConfig | DialogueApiConfig,
  source: 'chat' | 'preset',
  sourceName: string,
  presetId?: string,
): CollaborationApiProfile => {
  const next: CollaborationApiProfile = {
    ...profile,
    apiType: config.apiType,
    baseUrl: config.baseUrl || '',
    apiKey: config.apiKey || '',
    model: config.model || '',
    maxTokens: config.maxTokens,
    source,
    sourceId: presetId,
    sourceName,
    presetId: undefined,
    presetFp: undefined,
  };
  if (!next.apiType) delete next.apiType;
  if (next.maxTokens === undefined) delete next.maxTokens;
  if (source === 'preset' && presetId) {
    next.presetId = presetId;
    next.presetFp = computeSlotPresetFp(next);
  } else {
    delete next.presetId;
    delete next.presetFp;
    if (source === 'chat') delete next.sourceId;
  }
  return next;
};

/**
 * 将协同模式配置映射为 `<ApiSlotEditor>` 使用的 `DialogueApiConfig | undefined`：
 * - `source === 'chat'`（或空白未配置）→ `undefined`（跟随当前聊天 API）
 * - `source === 'preset'`（或带有有效 `presetId`）→ 携带 `presetId` / `presetFp` 的槽位
 * - `source === 'custom'` → 不带 `presetId` 的独立自定义槽位
 */
export const collaborationProfileToSlot = (
  profile: CollaborationApiProfile,
): DialogueApiConfig | undefined => {
  if (profile.source === 'chat') return undefined;
  if (!profile.source && !profile.presetId && !hasConnection(profile)) return undefined;

  const slot: DialogueApiConfig = {
    baseUrl: profile.baseUrl || '',
    ...(profile.apiType ? { apiType: profile.apiType } : {}),
    apiKey: profile.apiKey || '',
    model: profile.model || '',
    ...(typeof profile.maxTokens === 'number' ? { maxTokens: profile.maxTokens } : {}),
    stream: profile.stream,
    temperature: profile.temperature,
  };

  const presetId = (profile.presetId || (profile.source === 'preset' ? profile.sourceId : '') || '').trim();
  if (presetId) {
    slot.presetId = presetId;
    slot.presetFp = profile.presetFp || computeSlotPresetFp(slot);
  }
  return slot;
};

/**
 * 将 `<ApiSlotEditor>` 提交的结果写回 `CollaborationApiProfile`，同时保留协同专属的
 * `temperature` 与 `stream`（除非单独填写面板内显式切换了 `stream`）。
 */
export const collaborationProfileFromSlot = (
  slot: DialogueApiConfig | undefined,
  prevProfile: CollaborationApiProfile,
  chatApi: APIConfig,
  presets: readonly ApiPreset[],
): CollaborationApiProfile => {
  if (!slot) {
    const resolvedChat = resolveGlobalMainApi(chatApi, presets);
    return refreshLinkedProfile(prevProfile, resolvedChat, 'chat', '当前 ChatApp');
  }
  const presetId = slot.presetId?.trim();
  if (presetId) {
    const preset = presets.find((item) => item.id === presetId);
    const effective = preset ? slotFromPreset(preset) : slot;
    return refreshLinkedProfile(
      prevProfile,
      effective,
      'preset',
      preset?.name || prevProfile.sourceName || '预设连接',
      presetId,
    );
  }
  const custom: CollaborationApiProfile = {
    ...prevProfile,
    apiType: slot.apiType,
    baseUrl: slot.baseUrl || '',
    apiKey: slot.apiKey || '',
    model: slot.model || '',
    maxTokens: slot.maxTokens,
    stream: typeof slot.stream === 'boolean' ? slot.stream : prevProfile.stream,
    temperature: prevProfile.temperature,
    source: 'custom',
    sourceId: undefined,
    sourceName: '协同专用配置',
    presetId: undefined,
    presetFp: undefined,
  };
  if (!custom.apiType) delete custom.apiType;
  if (custom.maxTokens === undefined) delete custom.maxTokens;
  delete custom.sourceId;
  delete custom.presetId;
  delete custom.presetFp;
  return custom;
};

/**
 * Old blank collaboration settings become a live copy of the current Chat API.
 * Existing hand-written settings remain custom; linked sources refresh their
 * credentials/model while retaining collaboration-specific stream/temperature.
 */
export const hydrateCollaborationApiSettings = (
  settings: CollaborationSettings,
  chatApi: APIConfig,
  presets: ApiPreset[],
): CollaborationSettings => {
  const resolvedChatApi = resolveGlobalMainApi(chatApi, presets);

  const hydrateProfile = (profile: CollaborationApiProfile): CollaborationApiProfile => {
    // 若存有 presetFp 但内联四件套被旧入口直接改过，自动脱离预设转为 custom。
    if (profile.presetId && profile.presetFp && profile.presetFp !== computeSlotPresetFp(profile)) {
      if (!hasConnection(profile)) {
        return collaborationProfileFromApi(resolvedChatApi, 'chat', '当前 ChatApp');
      }
      const detached: CollaborationApiProfile = {
        ...profile,
        source: 'custom',
        sourceId: undefined,
        sourceName: '协同专用配置',
        presetId: undefined,
        presetFp: undefined,
      };
      delete detached.sourceId;
      delete detached.presetId;
      delete detached.presetFp;
      return detached;
    }

    const targetPresetId = (profile.presetId || (profile.source === 'preset' ? profile.sourceId : '') || '').trim();
    if (targetPresetId) {
      const preset = presets.find(item => item.id === targetPresetId);
      if (preset) {
        const fromPreset = slotFromPreset(preset);
        return refreshLinkedProfile(profile, fromPreset, 'preset', preset.name, preset.id);
      }
      const fallbackCustom: CollaborationApiProfile = {
        ...profile,
        source: 'custom',
        sourceId: undefined,
        sourceName: `${profile.sourceName || '已删除预设'} · 副本`,
        presetId: undefined,
        presetFp: undefined,
      };
      delete fallbackCustom.sourceId;
      delete fallbackCustom.presetId;
      delete fallbackCustom.presetFp;
      return fallbackCustom;
    }

    if (!profile.source) {
      if (hasConnection(profile)) return { ...profile, source: 'custom', sourceName: '协同专用配置' };
      return collaborationProfileFromApi(resolvedChatApi, 'chat', '当前 ChatApp');
    }
    if (profile.source === 'chat') {
      return refreshLinkedProfile(profile, resolvedChatApi, 'chat', '当前 ChatApp');
    }
    return profile;
  };

  return {
    ...settings,
    immersive: hydrateProfile(settings.immersive),
    focused: hydrateProfile(settings.focused),
  };
};

export const collaborationProfileMatches = (
  profile: CollaborationApiProfile,
  config: APIConfig,
): boolean => profile.baseUrl.trim().replace(/\/+$/, '') === (config.baseUrl || '').trim().replace(/\/+$/, '')
  && profile.apiKey === (config.apiKey || '')
  && profile.model === (config.model || '');

export const fetchCollaborationModels = async (
  profile: Pick<CollaborationApiProfile, 'baseUrl' | 'apiKey'>,
  request: typeof fetch = fetch,
): Promise<string[]> => {
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('请先选择一个已保存的连接');
  const response = await request(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${profile.apiKey || 'sk-none'}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const models = extractModelIds(await safeResponseJson(response));
  if (models.length === 0) throw new Error('模型列表为空或格式不兼容');
  return models;
};
