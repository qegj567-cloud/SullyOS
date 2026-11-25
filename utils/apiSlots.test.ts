import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIConfig, ApiPreset, DialogueApiConfig } from '../types';
import { pickDialogueApi, resolveDialogueApi } from './characterApi';
import {
  autoBindUniquePreset,
  computeSlotPresetFp,
  detachSlotFromPreset,
  inspectSlotPresetBinding,
  PRESETS_STORAGE_KEY,
  readCachedModelsForEndpoint,
  resolveAuxiliaryApi,
  resolveEffectiveSlot,
  slotFromPreset,
  validateApiSlotDraft,
  writeCachedModelsForEndpoint,
} from './apiSlots';
import * as analyticsMod from './analytics';
import { pickMigratedGlobalEmotionApi } from './apiSlotSync';
import { trackApiConnectionTest, trackApiSlotCommit } from './apiSlotAnalytics';

const makePreset = (overrides: Partial<ApiPreset> & { config?: Partial<APIConfig> } = {}): ApiPreset => ({
  id: overrides.id ?? 'preset-claude',
  name: overrides.name ?? 'Claude 主力',
  group: overrides.group ?? '常用',
  config: {
    apiType: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    apiKey: 'sk-ant-111',
    model: 'claude-sonnet-4-5',
    stream: true,
    temperature: 0.7,
    maxTokens: 4096,
    ...overrides.config,
  },
});

const baseGlobalApi: APIConfig = {
  apiType: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-main-global',
  model: 'gpt-4o',
  stream: false,
  temperature: 0.85,
};

describe('apiSlots 预设引用、快照指纹与自动保存校验', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('绑定预设后实时读取预设最新修改，哪怕内联快照仍是旧值', () => {
    const originalPreset = makePreset();
    const boundSlot = slotFromPreset(originalPreset);
    expect(boundSlot.presetId).toBe('preset-claude');
    expect(boundSlot.presetFp).toBeTruthy();

    // 用户后来在设置页或其它面板把同一条预设改成了新 Key 和新模型（甚至还没刷新到离线空间快照时）
    const updatedPreset = makePreset({
      config: {
        apiType: 'anthropic',
        baseUrl: 'https://proxy.example.com',
        apiKey: 'sk-ant-new-999',
        model: 'claude-opus-4-6',
        temperature: 0.5,
      },
    });

    const resolved = resolveDialogueApi(baseGlobalApi, { dialogueApi: boundSlot }, null, [updatedPreset]);
    expect(resolved.baseUrl).toBe('https://proxy.example.com/v1/messages');
    expect(resolved.apiKey).toBe('sk-ant-new-999');
    expect(resolved.model).toBe('claude-opus-4-6');
    expect(resolved.temperature).toBe(0.5);
    expect(resolved.apiType).toBe('anthropic');
  });

  it('pickDialogueApi 完整保留 presetId 与 presetFp，不会在保存时洗掉引用', () => {
    const preset = makePreset();
    const slot = slotFromPreset(preset);
    const picked = pickDialogueApi(slot);
    expect(picked.presetId).toBe(preset.id);
    expect(picked.presetFp).toBe(slot.presetFp);
  });

  it('外部旧代码直接修改了内联字段但带着旧 presetId 时，指纹失配自动脱离预设', () => {
    const preset = makePreset();
    const slot = slotFromPreset(preset);

    // 模拟正式版或未升级入口通过 { ...slot, model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiType: 'openai' } 覆写
    const externallyMutated: DialogueApiConfig = {
      ...slot,
      apiType: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds-222',
      model: 'deepseek-chat',
    };

    const binding = inspectSlotPresetBinding(externallyMutated, [preset]);
    expect(binding.status).toBe('custom');

    const effective = resolveEffectiveSlot(externallyMutated, [preset]);
    expect(effective?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(effective?.model).toBe('deepseek-chat');
    expect(effective?.presetId).toBeUndefined();
  });

  it('预设被删除后，原引用处自动退化使用删除前的内联快照继续工作，不断网也不串回错误主配置', () => {
    const preset = makePreset();
    const slot = slotFromPreset(preset);

    // 预设列表已空（被删）
    const binding = inspectSlotPresetBinding(slot, []);
    expect(binding).toEqual({ status: 'deleted_preset', presetId: 'preset-claude' });

    const resolved = resolveDialogueApi(baseGlobalApi, { dialogueApi: slot }, null, []);
    expect(resolved.baseUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(resolved.apiKey).toBe('sk-ant-111');
    expect(resolved.model).toBe('claude-sonnet-4-5');
    expect(resolved.apiType).toBe('anthropic');
  });

  it('detachSlotFromPreset 用当前有效预设值预填自定义表单并彻底剥离 presetId', () => {
    const preset = makePreset();
    const slot = slotFromPreset(preset);
    const updatedPreset = makePreset({ config: { model: 'claude-haiku-4-5' } });
    const detached = detachSlotFromPreset(slot, [updatedPreset]);
    expect(detached.presetId).toBeUndefined();
    expect(detached.presetFp).toBeUndefined();
    expect(detached.model).toBe('claude-haiku-4-5');
  });

  it('自动保存校验：三项全空视为恢复跟随（blank），填一半视为未完成（incomplete）绝不放行，免 Key 本地地址允许通过', () => {
    expect(validateApiSlotDraft({ baseUrl: '  ', apiKey: '\u200B', model: '' })).toEqual({ kind: 'blank' });

    const halfTyped = validateApiSlotDraft({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-half', model: '' });
    expect(halfTyped.kind).toBe('incomplete');
    if (halfTyped.kind === 'incomplete') {
      expect(halfTyped.reason).toBe('missing_model');
    }

    const badUrl = validateApiSlotDraft({ baseUrl: 'not-a-url', apiKey: 'sk-1', model: 'gpt-4o' });
    expect(badUrl.kind).toBe('incomplete');
    if (badUrl.kind === 'incomplete') {
      expect(badUrl.reason).toBe('invalid_url');
    }

    const keylessLocal = validateApiSlotDraft({
      apiType: 'openai',
      baseUrl: 'http://localhost:11434/v1/',
      apiKey: '',
      model: 'qwen2.5:14b',
    });
    expect(keylessLocal.kind).toBe('valid');
    if (keylessLocal.kind === 'valid') {
      expect(keylessLocal.normalized.baseUrl).toBe('http://localhost:11434/v1');
      expect(keylessLocal.normalized.apiKey).toBe('');
      expect(keylessLocal.normalized.model).toBe('qwen2.5:14b');
    }
  });

  it('resolveAuxiliaryApi：留空时整套回退主 API（含主 API 绑定的预设），单独填写免 Key 地址时绝不泄露主 API 的 Key', () => {
    const mainPreset = makePreset({
      id: 'p-main',
      config: {
        apiType: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-secret',
        model: 'deepseek/deepseek-r1',
      },
    });
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify([mainPreset]));
    const globalWithPreset: APIConfig = {
      ...baseGlobalApi,
      ...slotFromPreset(mainPreset),
    };

    // 1. 副 API 留空 → 回退到解析后的主 API
    const fallback = resolveAuxiliaryApi(undefined, globalWithPreset, [mainPreset]);
    expect(fallback.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(fallback.apiKey).toBe('sk-or-secret');
    expect(fallback.model).toBe('deepseek/deepseek-r1');

    // 2. 自习室 / 模拟人生单独填了本地免密地址、Key 留空 → 保持空 Key，绝不把 sk-or-secret 拼进去！
    const localOverride = resolveAuxiliaryApi(
      { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'llama3' },
      globalWithPreset,
      [mainPreset],
    );
    expect(localOverride.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(localOverride.apiKey).toBe('');
    expect(localOverride.model).toBe('llama3');
  });

  it('存量自动绑定：唯一严格匹配时自动挂载 presetId，存在多条重复预设时保持不绑', () => {
    const p1 = makePreset({ id: 'p1', name: '预设一' });
    const legacyCopy: DialogueApiConfig = {
      apiType: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-111',
      model: 'claude-sonnet-4-5',
      stream: true,
      temperature: 0.7,
      maxTokens: 4096,
    };

    const single = autoBindUniquePreset(legacyCopy, [p1]);
    expect(single?.boundPresetId).toBe('p1');
    expect(single?.slot.presetId).toBe('p1');
    expect(single?.slot.presetFp).toBe(computeSlotPresetFp(legacyCopy));

    const p2Duplicate = makePreset({ id: 'p2', name: '预设一副本' });
    const ambiguous = autoBindUniquePreset(legacyCopy, [p1, p2Duplicate]);
    expect(ambiguous?.boundPresetId).toBeNull();
    expect(ambiguous?.slot.presetId).toBeUndefined();
  });

  it('模型列表缓存按 apiType + 规范化地址隔离分桶，且不存储 apiKey', () => {
    writeCachedModelsForEndpoint(
      { apiType: 'openai', baseUrl: 'https://api.a.com/v1/' },
      ['gpt-4o-mini', 'gpt-4o'],
    );
    writeCachedModelsForEndpoint(
      { apiType: 'anthropic', baseUrl: 'https://api.b.com' },
      ['claude-sonnet-4-5'],
    );

    expect(readCachedModelsForEndpoint({ apiType: 'openai', baseUrl: 'https://api.a.com/v1' })).toEqual(['gpt-4o-mini', 'gpt-4o']);
    expect(readCachedModelsForEndpoint({ apiType: 'anthropic', baseUrl: 'https://api.b.com/v1/messages' })).toEqual(['claude-sonnet-4-5']);
    expect(localStorage.getItem('sullyos_endpoint_models_v1')).not.toContain('sk-');
  });

  it('情绪副 API 迁移：自动取存量角色里出现最多的非空配置并尝试绑定唯一预设', () => {
    const pSub = makePreset({
      id: 'p-sub',
      config: { apiType: 'openai', baseUrl: 'https://sub.example.com/v1', apiKey: 'sk-sub', model: 'haiku' },
    });
    const migrated = pickMigratedGlobalEmotionApi(
      [
        { id: 'c1', name: 'A', emotionConfig: { enabled: true, api: { baseUrl: 'https://sub.example.com/v1', apiKey: 'sk-sub', model: 'haiku' } } } as any,
        { id: 'c2', name: 'B', emotionConfig: { enabled: true, api: { baseUrl: 'https://sub.example.com/v1', apiKey: 'sk-sub', model: 'haiku' } } } as any,
        { id: 'c3', name: 'C', emotionConfig: { enabled: true, api: { baseUrl: 'https://other.example.com/v1', apiKey: 'sk-o', model: 'other' } } } as any,
      ],
      [pSub],
    );
    expect(migrated?.baseUrl).toBe('https://sub.example.com/v1');
    expect(migrated?.presetId).toBe('p-sub');
  });

  it('统计埋点白名单防泄漏：任何毒药字符串均无法进入上报载荷', () => {
    const spy = vi.spyOn(analyticsMod, 'trackEvent').mockImplementation(() => {});
    const poison = 'sk-poison-secret-https://private.host.internal/char-name';
    trackApiSlotCommit({
      slot: poison as any,
      mode: '绑定预设',
      result: '已生效',
    });
    trackApiConnectionTest({
      slot: '记忆副API',
      ok: false,
      failureCategory: poison as any,
    });
    const serialized = JSON.stringify(spy.mock.calls);
    expect(serialized).not.toContain('poison');
    expect(serialized).not.toContain('private.host');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('测试API连接', { 槽位: '记忆副API', 结果: '失败', 原因: '其他' });
    spy.mockRestore();
  });
});
