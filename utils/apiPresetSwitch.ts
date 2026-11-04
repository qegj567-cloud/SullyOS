/**
 * API 预设的「切过去」和「现在用的是哪条」。
 *
 * 预设点一下就直接生效——不存在「载入了但还没保存」的中间状态，所以这里只做几件
 * 纯粹的事，Settings 面板和测试共用同一份口径：
 *
 *   1. configFromPreset  切到这条预设时，要写进全局配置的字段
 *   2. findActivePresetId 反过来，认出当前生效的配置对应哪条预设（界面上打勾用）
 *   3. presetDiffersFromConfig 保存之后这条预设是不是跟当前配置对不上了（要不要问一句存回去）
 *
 * 不碰 React、不碰存储。
 */

import type { APIConfig, ApiPreset } from '../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from './apiConfigNormalize';
import { normalizeLlmBaseUrl, llmApiType } from './llmEndpoint';

/**
 * 切换预设时覆盖的字段。
 *
 * stream / temperature 是**可选**的：从聊天面板存下来的预设只有 URL / Key / Model
 * 三件套（见 EmotionSettingsPanel），预设里没存的字段一律保持原样，不能拿默认值
 * 把用户手调过的温度、流式开关顺手重置掉。
 */
export type PresetSwitchPatch =
  Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'> & Partial<Pick<APIConfig, 'stream' | 'temperature' | 'maxTokens' | 'apiType'>>;

export function configFromPreset(preset: ApiPreset): PresetSwitchPatch {
  const patch: PresetSwitchPatch = {
    baseUrl: normalizeLlmBaseUrl(normalizeApiBaseUrl(preset.config.baseUrl), preset.config.apiType),
    apiType: preset.config.apiType,
    apiKey: normalizeApiCredential(preset.config.apiKey),
    model: normalizeApiModel(preset.config.model),
  };
  if (typeof preset.config.stream === 'boolean') patch.stream = preset.config.stream;
  if (typeof preset.config.temperature === 'number') patch.temperature = preset.config.temperature;
  if (Number.isSafeInteger(preset.config.maxTokens) && preset.config.maxTokens! > 0) patch.maxTokens = preset.config.maxTokens;
  return patch;
}

/** 接口类型及三件套一致才算同一预设；归一化后比较，避免末尾斜杠或空格造成假不一致。 */
export function presetMatchesConfig(
  preset: ApiPreset,
  config: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model' | 'apiType'>,
): boolean {
  return llmApiType(preset.config) === llmApiType(config)
    && normalizeLlmBaseUrl(normalizeApiBaseUrl(preset.config.baseUrl), preset.config.apiType) === normalizeLlmBaseUrl(normalizeApiBaseUrl(config.baseUrl), config.apiType)
    && normalizeApiCredential(preset.config.apiKey) === normalizeApiCredential(config.apiKey)
    && normalizeApiModel(preset.config.model) === normalizeApiModel(config.model);
}

/**
 * 这份配置保存下去以后，预设里存的值是不是已经跟它对不上了。
 *
 * 比 presetMatchesConfig 多看流式和温度：只调了温度，「使用中」照样亮着，但预设里
 * 存的还是旧温度。预设没存这两项（老预设）就不算差异——它本来就不管这两项。
 */
export function presetDiffersFromConfig(
  preset: ApiPreset,
  config: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'> & Partial<Pick<APIConfig, 'stream' | 'temperature' | 'maxTokens'>>,
): boolean {
  if (!presetMatchesConfig(preset, config)) return true;
  if ((preset.config.maxTokens ?? 8000) !== (config.maxTokens ?? 8000)) return true;
  if (typeof preset.config.stream === 'boolean' && preset.config.stream !== (config.stream === true)) return true;
  if (typeof preset.config.temperature === 'number' && typeof config.temperature === 'number'
    && preset.config.temperature !== config.temperature) return true;
  return false;
}

/**
 * 当前生效的是哪条预设；手填的配置（不等于任何一条）返回 null。
 *
 * 用值比对而不是记一个「上次点的是谁」：刷新、手改表单、导入备份之后它都不会说谎，
 * 界面上的高亮永远等于「请求真的会发去哪」。URL 和 Model 都空 = 还没配过，不打勾。
 */
export function findActivePresetId(
  presets: ApiPreset[],
  config: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>,
): string | null {
  if (!normalizeApiBaseUrl(config.baseUrl) && !normalizeApiModel(config.model)) return null;
  return presets.find(preset => presetMatchesConfig(preset, config))?.id ?? null;
}
