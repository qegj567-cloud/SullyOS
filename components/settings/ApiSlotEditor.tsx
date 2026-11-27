import React, { useEffect, useRef, useState } from 'react';
import type { ApiPreset, DialogueApiConfig } from '../../types';
import { useOS } from '../../context/OSContext';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { fetchLlm } from '../../utils/anthropicApi';
import { normalizeApiBaseUrl } from '../../utils/apiConfigNormalize';
import {
  classifyApiTestError,
  trackApiConnectionTest,
  trackApiPresetAction,
  trackApiSlotCommit,
  type ApiSlotAnalyticsName,
  type ApiSlotDiscardReason,
} from '../../utils/apiSlotAnalytics';
import {
  detachSlotFromPreset,
  inspectSlotPresetBinding,
  readCachedModelsForEndpoint,
  resolveEffectiveSlot,
  slotFromPreset,
  validateApiSlotDraft,
  writeCachedModelsForEndpoint,
} from '../../utils/apiSlots';
import { describeDialogueApi, pickDialogueApi } from '../../utils/characterApi';
import { llmApiType, normalizeLlmBaseUrl } from '../../utils/llmEndpoint';
import { extractModelIds } from '../../utils/modelList';
import { extractContent, safeResponseJson } from '../../utils/safeApi';
import Modal from '../os/Modal';
import ApiPresetEditorModal from './ApiPresetEditorModal';
import ApiPresetGroups from './ApiPresetGroups';
import DialogueApiFields from './DialogueApiFields';
import ModelPicker from './ModelPicker';

export interface ApiSlotEditorProps {
  /** 用于统计枚举与诊断标识的固定槽位名。 */
  slotName: ApiSlotAnalyticsName;
  /** 当前已持久化的槽位配置；undefined / null 表示跟随默认。 */
  value: DialogueApiConfig | null | undefined;
  /** 当配置合法完成、切换预设或恢复跟随时自动触发落盘。 */
  onCommit: (next: DialogueApiConfig | undefined) => void | Promise<void>;
  /** 是否允许「未单独设置（跟随默认）」状态；全局主对话 API 传 false。 */
  allowFollow?: boolean;
  /** 跟随默认按钮与状态文案，例如「跟随设置中的主 API」。 */
  followButtonLabel?: string;
  /** 当前处于跟随默认时展示的实际生效目标摘要。 */
  followSummary?: string;
  /** 全局共用提示条，例如「全局共用 · 修改后对所有角色生效」。 */
  globalScopeNotice?: string;
  /** 额外的业务提示文字。 */
  helperText?: string;
  /** 自定义连接测试器（例如独立识图发送测试图片）；不传则默认发 5 tokens 对话探针。 */
  customTestRunner?: (api: DialogueApiConfig) => Promise<string>;
  /** 调用日志归属元数据。 */
  meta?: { appId?: string; appName?: string; charId?: string; charName?: string };
  /** 埋点来源区分。 */
  source?: '设置页' | '业务面板';
  /** 是否允许在预设列表旁展示「新建预设」入口（设置页主卡片常用）。 */
  showCreatePresetHeaderButton?: boolean;
}

const AUTO_SAVE_DELAY_MS = 600;

const mapDiscardReason = (reason: 'missing_url' | 'invalid_url' | 'missing_model'): ApiSlotDiscardReason =>
  reason === 'missing_url' ? '缺地址' : reason === 'invalid_url' ? '地址不合法' : '缺模型';

function serializeComparableSlot(slot: DialogueApiConfig | null | undefined): string {
  if (!slot) return '';
  const picked = pickDialogueApi(slot);
  return JSON.stringify({
    apiType: llmApiType(picked),
    baseUrl: picked.baseUrl,
    apiKey: picked.apiKey,
    model: picked.model,
    stream: picked.stream ?? false,
    temperature: picked.temperature ?? 0.85,
    maxTokens: picked.maxTokens ?? null,
    presetId: picked.presetId ?? null,
  });
}

export default function ApiSlotEditor({
  slotName,
  value,
  onCommit,
  allowFollow = true,
  followButtonLabel = '恢复跟随主 API',
  followSummary,
  globalScopeNotice,
  helperText,
  customTestRunner,
  meta,
  source = '业务面板',
  showCreatePresetHeaderButton = false,
}: ApiSlotEditorProps) {
  const os = useOS();
  const apiConfig = os?.apiConfig ?? { baseUrl: '', apiKey: '', model: '' };
  const apiPresets = os?.apiPresets ?? [];
  const availableModels = os?.availableModels ?? [];
  const saveModels = os?.saveModels ?? (() => {});
  const addToast = os?.addToast ?? (() => {});

  const binding = inspectSlotPresetBinding(value, apiPresets);

  // 当 allowFollow=true 且 value 为空时，默认展示跟随态；用户点「单独填写」后展开空白/预填表单。
  const [manualCustomOpen, setManualCustomOpen] = useState<boolean>(() => !allowFollow);
  const [customDraft, setCustomDraft] = useState<DialogueApiConfig>(() => {
    if (value && binding.status !== 'bound') return pickDialogueApi(value);
    if (!allowFollow && value) return pickDialogueApi(value);
    return { baseUrl: '', apiKey: '', model: '' };
  });

  const resolveModelsForSlot = (slot: DialogueApiConfig | null | undefined): string[] => {
    if (!slot) return [];
    const cached = readCachedModelsForEndpoint(slot);
    if (cached.length > 0) return cached;
    return slot.baseUrl && slot.baseUrl === apiConfig.baseUrl ? availableModels : [];
  };

  const [models, setModels] = useState<string[]>(() =>
    resolveModelsForSlot(value ?? (!allowFollow ? apiConfig : null)),
  );
  const [showPicker, setShowPicker] = useState(false);
  const [pickerModel, setPickerModel] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState('');
  const [autoSaveHint, setAutoSaveHint] = useState('');

  const [presetModal, setPresetModal] = useState<{
    open: boolean;
    mode: 'create' | 'edit';
    preset?: ApiPreset | null;
    seedConfig?: DialogueApiConfig | null;
  }>({ open: false, mode: 'create' });

  const requestVersionRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredIdRef = useRef<string | null>(null);
  const dirtyCustomRef = useRef(false);
  const lastCommittedSerializedRef = useRef(serializeComparableSlot(value));
  const prevExternalSerializedRef = useRef(lastCommittedSerializedRef.current);
  const latestPropsRef = useRef({ customDraft, onCommit, allowFollow, addToast, slotName });
  latestPropsRef.current = { customDraft, onCommit, allowFollow, addToast, slotName };

  // 外部 value 变化（如切角色、预设刷新、跨标签同步）且本地没有正在敲字的未提交草稿时，对齐面板显示
  useEffect(() => {
    const incomingSerialized = serializeComparableSlot(value);
    const externalValueChanged = incomingSerialized !== prevExternalSerializedRef.current;
    prevExternalSerializedRef.current = incomingSerialized;
    lastCommittedSerializedRef.current = incomingSerialized;
    if (dirtyCustomRef.current) return;
    const nextBinding = inspectSlotPresetBinding(value, apiPresets);
    if (nextBinding.status === 'empty') {
      if (externalValueChanged) {
        setManualCustomOpen(!allowFollow);
        setCustomDraft({ baseUrl: '', apiKey: '', model: '' });
      }
    } else if (nextBinding.status === 'custom' || nextBinding.status === 'deleted_preset') {
      setManualCustomOpen(true);
      if (value && externalValueChanged) {
        const cleaned = pickDialogueApi(value);
        delete cleaned.presetId;
        delete cleaned.presetFp;
        setCustomDraft(cleaned);
        const nextModels = resolveModelsForSlot(cleaned);
        if (nextModels.length > 0) setModels(nextModels);
      }
    } else if (nextBinding.status === 'bound') {
      if (externalValueChanged) {
        setManualCustomOpen(false);
      }
    }
  }, [value, apiPresets, allowFollow]);

  const flushCustomDraft = (
    draftToValidate: DialogueApiConfig,
    options: { onUnmount?: boolean } = {},
  ): 'saved' | 'blank_cleared' | 'unchanged' | 'incomplete' => {
    const { onCommit: commitFn, allowFollow: canFollow, addToast: toastFn, slotName: sName } = latestPropsRef.current;
    const result = validateApiSlotDraft(draftToValidate);

    if (result.kind === 'blank') {
      dirtyCustomRef.current = false;
      setAutoSaveHint('');
      if (canFollow) {
        if (lastCommittedSerializedRef.current !== '') {
          lastCommittedSerializedRef.current = '';
          void commitFn(undefined);
          trackApiSlotCommit({ slot: sName, mode: '恢复跟随', result: '已生效' });
        }
        return 'blank_cleared';
      }
      // 主对话 API 允许清空保存为空串
      const emptyMain: DialogueApiConfig = { baseUrl: '', apiKey: '', model: '' };
      const serialized = serializeComparableSlot(emptyMain);
      if (serialized !== lastCommittedSerializedRef.current) {
        lastCommittedSerializedRef.current = serialized;
        void commitFn(emptyMain);
      }
      return 'saved';
    }

    if (result.kind === 'incomplete') {
      if (options.onUnmount) {
        dirtyCustomRef.current = false;
        toastFn('API 还有必填项未填完，未完成的修改没有生效', 'info');
        trackApiSlotCommit({
          slot: sName,
          mode: '单独填写',
          result: '未填完丢弃',
          discardReason: mapDiscardReason(result.reason),
        });
      } else {
        setAutoSaveHint(result.message);
      }
      return 'incomplete';
    }

    const serialized = serializeComparableSlot(result.normalized);
    dirtyCustomRef.current = false;
    if (serialized === lastCommittedSerializedRef.current) {
      setAutoSaveHint('');
      return 'unchanged';
    }
    lastCommittedSerializedRef.current = serialized;
    setAutoSaveHint('已自动保存');
    void commitFn(result.normalized);
    trackApiSlotCommit({ slot: sName, mode: '单独填写', result: '已生效' });
    return 'saved';
  };

  // 卸载或页面隐藏时兜底冲刷合法草稿 / 提示半成品丢弃
  useEffect(() => {
    const onPageHide = () => {
      if (!dirtyCustomRef.current) return;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      flushCustomDraft(latestPropsRef.current.customDraft, { onUnmount: true });
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', onPageHide);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPageHide);
      }
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (dirtyCustomRef.current) {
        flushCustomDraft(latestPropsRef.current.customDraft, { onUnmount: true });
      }
    };
  }, []);

  useLocalBackHandler(() => {
    if (showPicker) {
      setShowPicker(false);
      return true;
    }
    return false;
  }, 85, showPicker);

  const scheduleCustomCommit = (nextDraft: DialogueApiConfig) => {
    dirtyCustomRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      flushCustomDraft(nextDraft);
    }, AUTO_SAVE_DELAY_MS);
  };

  const handleSelectPreset = (preset: ApiPreset) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    dirtyCustomRef.current = false;
    requestVersionRef.current += 1;
    setLoadingModels(false);
    setTesting(false);
    setStatus('');
    setAutoSaveHint('');
    setManualCustomOpen(false);
    const nextSlot = slotFromPreset(preset);
    lastCommittedSerializedRef.current = serializeComparableSlot(nextSlot);
    void onCommit(nextSlot);
    trackApiSlotCommit({ slot: slotName, mode: '绑定预设', result: '已生效' });
  };

  const handleSwitchToFollow = () => {
    if (!allowFollow) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    dirtyCustomRef.current = false;
    requestVersionRef.current += 1;
    setLoadingModels(false);
    setTesting(false);
    setStatus('');
    setAutoSaveHint('');
    setManualCustomOpen(false);
    setCustomDraft({ baseUrl: '', apiKey: '', model: '' });
    lastCommittedSerializedRef.current = '';
    void onCommit(undefined);
    trackApiSlotCommit({ slot: slotName, mode: '恢复跟随', result: '已生效' });
  };

  const handleDetachFromPreset = () => {
    if (!value) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    dirtyCustomRef.current = false;
    requestVersionRef.current += 1;
    const detached = detachSlotFromPreset(value, apiPresets);
    setCustomDraft(detached);
    setModels(resolveModelsForSlot(detached));
    setManualCustomOpen(true);
    setStatus('');
    setAutoSaveHint('已转为单独填写，后续修改仅作用于此处');
    lastCommittedSerializedRef.current = serializeComparableSlot(detached);
    void onCommit(detached);
    trackApiPresetAction({ source, action: '转为单独填写' });
  };

  const handleOpenManualCustomFromFollow = (prefillFromMain = false) => {
    requestVersionRef.current += 1;
    setStatus('');
    setAutoSaveHint('');
    if (prefillFromMain && apiConfig.baseUrl && apiConfig.model) {
      const seed = detachSlotFromPreset(pickDialogueApi(apiConfig), apiPresets);
      setCustomDraft(seed);
      setModels(resolveModelsForSlot(seed));
      setManualCustomOpen(true);
      lastCommittedSerializedRef.current = serializeComparableSlot(seed);
      void onCommit(seed);
      trackApiSlotCommit({ slot: slotName, mode: '单独填写', result: '已生效' });
      return;
    }
    setCustomDraft({ baseUrl: '', apiKey: '', model: '' });
    setModels([]);
    setManualCustomOpen(true);
  };

  const updateCustomFields = (patch: Partial<DialogueApiConfig>, immediate = false) => {
    requestVersionRef.current += 1;
    setLoadingModels(false);
    setTesting(false);
    setStatus('');
    setCustomDraft((prev) => {
      const next: DialogueApiConfig = { ...prev, ...patch };
      delete next.presetId;
      delete next.presetFp;
      if (patch.apiType !== undefined && next.baseUrl.trim()) {
        next.baseUrl = normalizeLlmBaseUrl(normalizeApiBaseUrl(next.baseUrl), patch.apiType);
      }
      if (patch.baseUrl !== undefined || patch.apiType !== undefined || patch.apiKey !== undefined) {
        setModels(readCachedModelsForEndpoint(next));
      }
      if (immediate) {
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        flushCustomDraft(next);
      } else {
        scheduleCustomCommit(next);
      }
      return next;
    });
  };

  const handleUrlBlur = () => {
    setCustomDraft((prev) => {
      const normalizedUrl = normalizeLlmBaseUrl(normalizeApiBaseUrl(prev.baseUrl), llmApiType(prev));
      if (normalizedUrl === prev.baseUrl) return prev;
      const next = { ...prev, baseUrl: normalizedUrl };
      setModels(readCachedModelsForEndpoint(next));
      return next;
    });
  };

  const fetchModelsForCustom = async () => {
    const apiType = llmApiType(customDraft);
    const normalizedUrl = normalizeLlmBaseUrl(normalizeApiBaseUrl(customDraft.baseUrl), apiType);
    if (!normalizedUrl) {
      setStatus('请先填写 API URL');
      return;
    }
    const version = ++requestVersionRef.current;
    setLoadingModels(true);
    setStatus('');
    try {
      const res = await fetchLlm(`${normalizedUrl}/models`, {
        __sullySettingsModelBase: normalizedUrl,
        headers: { Authorization: `Bearer ${customDraft.apiKey.trim() || 'sk-none'}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = extractModelIds(await safeResponseJson(res));
      if (version !== requestVersionRef.current) return;
      const saved = writeCachedModelsForEndpoint({ baseUrl: normalizedUrl, apiType }, list);
      if (slotName === '主对话' && saved.length > 0) {
        saveModels?.(saved);
      }
      setModels(saved);
      setStatus(saved.length ? `获取到 ${saved.length} 个模型` : '模型列表为空，可手动输入');
      const chosenModel = customDraft.model || saved[0] || '';
      setPickerModel(chosenModel);
      setShowPicker(true);
    } catch (err) {
      if (version === requestVersionRef.current) {
        setStatus(`获取失败：${err instanceof Error ? err.message : '请检查配置'}`);
      }
    } finally {
      if (version === requestVersionRef.current) setLoadingModels(false);
    }
  };

  const getTestableSlot = (): DialogueApiConfig | null => {
    if (binding.status === 'bound' && !manualCustomOpen) {
      return resolveEffectiveSlot(value, apiPresets);
    }
    const check = validateApiSlotDraft(customDraft);
    if (check.kind === 'valid') return check.normalized;
    setStatus(check.kind === 'blank' ? '请先填写 API 地址和模型' : check.message);
    return null;
  };

  const handleTestConnection = async () => {
    const target = getTestableSlot();
    if (!target) return;
    const version = ++requestVersionRef.current;
    setTesting(true);
    setStatus('');
    let httpStatus: number | undefined;
    try {
      if (customTestRunner) {
        const message = await customTestRunner(target);
        if (version !== requestVersionRef.current) return;
        setStatus(message || '连接成功');
        trackApiConnectionTest({ slot: slotName, ok: true });
        return;
      }
      const res = await fetchLlm(`${target.baseUrl}/chat/completions`, {
        __sullySettingsModelBase: target.baseUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.apiKey || 'sk-none'}`,
        },
        body: JSON.stringify({
          model: target.model,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5,
          stream: target.stream ?? false,
        }),
        __sullyMeta: {
          appId: meta?.appId ?? 'settings',
          appName: meta?.appName ?? slotName,
          charId: meta?.charId,
          charName: meta?.charName,
          purpose: '测试连接',
          slotStream: target.stream,
        },
      } as RequestInit);
      httpStatus = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = extractContent(await safeResponseJson(res));
      if (version !== requestVersionRef.current) return;
      const ok = Boolean(content);
      setStatus(ok ? '连接成功' : '接口已响应，但回复为空');
      trackApiConnectionTest({
        slot: slotName,
        ok,
        failureCategory: ok ? undefined : classifyApiTestError(httpStatus, false, true),
      });
    } catch (err) {
      if (version !== requestVersionRef.current) return;
      setStatus(`连接失败：${err instanceof Error ? err.message : '请检查配置'}`);
      trackApiConnectionTest({
        slot: slotName,
        ok: false,
        failureCategory: classifyApiTestError(httpStatus),
      });
    } finally {
      if (version === requestVersionRef.current) setTesting(false);
    }
  };

  const activePresetId = binding.status === 'bound' && !manualCustomOpen ? binding.preset.id : null;
  const showCustomForm = manualCustomOpen || binding.status === 'custom' || binding.status === 'deleted_preset' || !allowFollow;
  const canSaveCustomAsPreset = validateApiSlotDraft(customDraft).kind === 'valid';

  return (
    <div className="space-y-4 text-slate-800" data-api-slot={slotName}>
      {globalScopeNotice && (
        <div className="rounded-xl bg-sky-50 border border-sky-200/80 px-3 py-2 text-[11px] font-medium text-sky-800 leading-relaxed">
          {globalScopeNotice}
        </div>
      )}

      {helperText && (
        <p className="text-[11px] text-slate-500 leading-relaxed">{helperText}</p>
      )}

      {/* 预设快速绑定区 */}
      {(apiPresets.length > 0 || showCreatePresetHeaderButton) && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">
              API 预设（点选立即引用）
            </h4>
            {showCreatePresetHeaderButton && (
              <button
                type="button"
                onClick={() =>
                  setPresetModal({
                    open: true,
                    mode: 'create',
                    seedConfig: binding.status === 'bound' ? binding.preset.config : customDraft,
                  })
                }
                className="text-[11px] font-bold text-primary px-2.5 py-1 rounded-lg bg-primary/10 active:scale-95 transition-transform"
              >
                新建预设
              </button>
            )}
          </div>

          {apiPresets.length > 0 ? (
            <ApiPresetGroups presets={apiPresets}>
              {(preset) => {
                const isSelected = activePresetId === preset.id;
                const clearLongPress = () => {
                  if (longPressTimerRef.current) {
                    clearTimeout(longPressTimerRef.current);
                    longPressTimerRef.current = null;
                  }
                };
                return (
                  <div key={preset.id} className="inline-flex items-center gap-0.5">
                    <button
                      type="button"
                      title={`切换到 ${preset.name}`}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        clearLongPress();
                        longPressFiredIdRef.current = null;
                        longPressTimerRef.current = setTimeout(() => {
                          longPressTimerRef.current = null;
                          longPressFiredIdRef.current = preset.id;
                          setPresetModal({ open: true, mode: 'edit', preset });
                        }, 500);
                      }}
                      onPointerUp={clearLongPress}
                      onPointerCancel={clearLongPress}
                      onPointerLeave={clearLongPress}
                      onClick={() => {
                        if (longPressFiredIdRef.current === preset.id) {
                          longPressFiredIdRef.current = null;
                          return;
                        }
                        handleSelectPreset(preset);
                      }}
                      className={`rounded-xl px-3 py-1.5 text-xs font-medium border transition-all active:scale-95 ${
                        isSelected
                          ? 'bg-primary text-white border-primary shadow-sm font-bold'
                          : 'bg-white border-slate-200 text-slate-700 hover:border-primary/40'
                      }`}
                    >
                      {preset.name}
                      {isSelected ? ' · 使用中' : ''}
                    </button>
                    <button
                      type="button"
                      aria-label={`编辑预设 ${preset.name}`}
                      title={`编辑预设 ${preset.name}`}
                      onClick={() => setPresetModal({ open: true, mode: 'edit', preset })}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" />
                        <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" />
                      </svg>
                    </button>
                  </div>
                );
              }}
            </ApiPresetGroups>
          ) : (
            <p className="text-[11px] text-slate-400 pl-1">暂无已保存的预设，可在填写连接后点「存为新预设」。</p>
          )}
        </div>
      )}

      {/* 状态 1：跟随默认（未单独配置） */}
      {allowFollow && binding.status === 'empty' && !manualCustomOpen && (
        <div className="rounded-2xl bg-slate-50 border border-slate-200/80 p-3.5 space-y-2.5">
          <div className="text-xs font-bold text-slate-700">当前状态：跟随默认配置</div>
          <div className="text-[11px] text-slate-500 font-mono break-all">
            {followSummary ?? describeDialogueApi(apiConfig, apiPresets)}
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => handleOpenManualCustomFromFollow(false)}
              className="px-3 py-1.5 rounded-xl bg-white border border-slate-200 text-xs font-bold text-slate-700 active:scale-95 transition-transform"
            >
              单独填写配置
            </button>
            {Boolean(apiConfig.baseUrl && apiConfig.model) && (
              <button
                type="button"
                onClick={() => handleOpenManualCustomFromFollow(true)}
                className="px-3 py-1.5 rounded-xl bg-white border border-slate-200 text-xs text-slate-500 active:scale-95 transition-transform"
              >
                复制主 API 参数微调
              </button>
            )}
          </div>
        </div>
      )}

      {/* 状态 2：已绑定某条预设（展示预设引用卡片 + 显式动作） */}
      {binding.status === 'bound' && !manualCustomOpen && (
        <div
          className="rounded-2xl bg-slate-50/90 border border-slate-200/90 p-4 space-y-3"
          data-testid="bound-preset-card"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-bold text-slate-800">{binding.preset.name}</span>
                {binding.preset.group && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200/70 text-slate-600">
                    {binding.preset.group}
                  </span>
                )}
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                  引用同步中
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-mono mt-1 break-all">
                {llmApiType(binding.preset.config) === 'anthropic' ? 'Anthropic 原生 · ' : 'OpenAI 兼容 · '}
                {describeDialogueApi(binding.preset.config, [])}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setPresetModal({ open: true, mode: 'edit', preset: binding.preset })}
              className="px-3 py-2 rounded-xl bg-primary/10 text-primary text-xs font-bold active:scale-95 transition-transform"
            >
              编辑此预设
            </button>
            <button
              type="button"
              onClick={handleDetachFromPreset}
              className="px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-xs font-bold active:scale-95 transition-transform"
            >
              改为单独填写
            </button>
            {allowFollow && (
              <button
                type="button"
                onClick={handleSwitchToFollow}
                className="px-3 py-2 rounded-xl bg-slate-200/70 text-slate-600 text-xs font-medium active:scale-95 transition-transform"
              >
                {followButtonLabel}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testing}
            className="w-full py-2.5 rounded-xl border border-primary/30 bg-white text-primary text-xs font-bold disabled:opacity-40"
          >
            {testing ? '测试中…' : '测试连接'}
          </button>

          {status && (
            <p role="status" className="text-xs text-slate-600 break-words">
              {status}
            </p>
          )}
        </div>
      )}

      {/* 状态 2b：原绑定预设已被删除的提示条 */}
      {binding.status === 'deleted_preset' && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-800 leading-relaxed">
          原绑定的预设已被删除，当前保留删除前的连接配置正常运行；可直接选其它预设，或在下方修改后自动保存为独立配置。
        </div>
      )}

      {/* 状态 3：单独填写表单 */}
      {showCustomForm && !(binding.status === 'bound' && !manualCustomOpen) && (
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[11px] font-bold text-slate-500 pl-1">
              {allowFollow ? '单独填写（仅当前位置生效 · 自动保存）' : '单独填写连接（自动保存）'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!canSaveCustomAsPreset}
                onClick={() =>
                  setPresetModal({
                    open: true,
                    mode: 'create',
                    seedConfig: customDraft,
                  })
                }
                className="text-[11px] font-bold text-primary px-2.5 py-1 rounded-lg bg-primary/10 disabled:opacity-40 active:scale-95 transition-transform"
              >
                存为新预设
              </button>
              {allowFollow && (
                <button
                  type="button"
                  onClick={handleSwitchToFollow}
                  className="text-[11px] text-slate-500 px-2.5 py-1 rounded-lg bg-slate-100 active:scale-95 transition-transform"
                >
                  {followButtonLabel}
                </button>
              )}
            </div>
          </div>

          <DialogueApiFields
            value={customDraft}
            onChange={(patch) => {
              const immediate = patch.apiType !== undefined || patch.stream !== undefined;
              updateCustomFields(patch, immediate);
            }}
            onUrlBlur={handleUrlBlur}
            onFieldBlur={() => {
              if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
              }
              flushCustomDraft(latestPropsRef.current.customDraft);
            }}
            fetchModels={fetchModelsForCustom}
            isLoadingModels={loadingModels}
            openModelPicker={() => {
              setPickerModel(customDraft.model);
              setShowPicker(true);
            }}
          />

          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testing || !customDraft.baseUrl.trim() || !customDraft.model.trim()}
            className="w-full py-2.5 rounded-xl border border-primary/30 text-primary text-xs font-bold disabled:opacity-40"
          >
            {testing ? '测试中…' : '测试连接'}
          </button>

          {autoSaveHint && (
            <p className="text-[11px] text-slate-500 pl-1" data-testid="slot-autosave-hint">
              {autoSaveHint}
            </p>
          )}
          {status && (
            <p role="status" className="text-xs text-slate-600 break-words pl-1">
              {status}
            </p>
          )}
        </div>
      )}

      <Modal isOpen={showPicker} title="选择模型" onClose={() => setShowPicker(false)}>
        <ModelPicker
          availableModels={models}
          localModel={pickerModel}
          setLocalModel={setPickerModel}
          confirmModelPicker={(model) => {
            setShowPicker(false);
            updateCustomFields({ model }, true);
          }}
        />
      </Modal>

      <ApiPresetEditorModal
        isOpen={presetModal.open}
        mode={presetModal.mode}
        preset={presetModal.preset}
        initialConfig={presetModal.seedConfig}
        source={source}
        onClose={() => setPresetModal({ open: false, mode: 'create' })}
        onCreatedPreset={(created) => {
          handleSelectPreset(created);
        }}
      />
    </div>
  );
}
