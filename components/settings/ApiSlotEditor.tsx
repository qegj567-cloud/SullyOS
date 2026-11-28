import React, { useEffect, useRef, useState } from 'react';
import type { ApiPreset, DialogueApiConfig } from '../../types';
import { useOS } from '../../context/OSContext';
import { fetchLlm } from '../../utils/anthropicApi';
import { normalizeApiBaseUrl } from '../../utils/apiConfigNormalize';
import {
  classifyApiTestError,
  trackApiConnectionTest,
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
import ApiPresetEditorModal from './ApiPresetEditorModal';
import ApiPresetPicker from './ApiPresetPicker';
import PresetNameButton from './PresetNameButton';
import DialogueApiFields from './DialogueApiFields';
import ApiSaveFeedback from './ApiSaveFeedback';

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
  const [manualCustomOpen, setManualCustomOpen] = useState<boolean>(() => !allowFollow && binding.status !== 'bound');
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
  const [saveRevision, setSaveRevision] = useState(0);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState('');
  const [testTone, setTestTone] = useState<'success' | 'error' | null>(null);
  const [autoSaveHint, setAutoSaveHint] = useState('');

  const [presetModal, setPresetModal] = useState<{
    open: boolean;
    mode: 'create' | 'edit';
    preset?: ApiPreset | null;
    seedConfig?: DialogueApiConfig | null;
  }>({ open: false, mode: 'create' });

  const requestVersionRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    setStatus(''); setTestTone(null);
    setAutoSaveHint('');
    setManualCustomOpen(false);
    const nextSlot = slotFromPreset(preset);
    lastCommittedSerializedRef.current = serializeComparableSlot(nextSlot);
    void Promise.resolve(onCommit(nextSlot)).then(() => setSaveRevision(value => value + 1)).catch(() => addToast('修改未成功，请重试', 'error'));
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
    setStatus(''); setTestTone(null);
    setAutoSaveHint('');
    setManualCustomOpen(false);
    setCustomDraft({ baseUrl: '', apiKey: '', model: '' });
    lastCommittedSerializedRef.current = '';
    void onCommit(undefined);
    trackApiSlotCommit({ slot: slotName, mode: '恢复跟随', result: '已生效' });
  };

  const handleOpenManualCustomFromFollow = (prefillFromMain = false) => {
    requestVersionRef.current += 1;
    setStatus(''); setTestTone(null);
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
    setStatus(''); setTestTone(null);
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
    setStatus(''); setTestTone(null);
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
    setStatus(''); setTestTone(null);
    let httpStatus: number | undefined;
    try {
      if (customTestRunner) {
        const message = await customTestRunner(target);
        if (version !== requestVersionRef.current) return;
        setStatus(message || '连接成功'); setTestTone('success');
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
      setStatus(ok ? '连接成功' : '接口已响应，但回复为空'); setTestTone(ok ? 'success' : 'error');
      trackApiConnectionTest({
        slot: slotName,
        ok,
        failureCategory: ok ? undefined : classifyApiTestError(httpStatus, false, true),
      });
    } catch (err) {
      if (version !== requestVersionRef.current) return;
      setStatus(`连接失败：${err instanceof Error ? err.message : '请检查配置'}`); setTestTone('error');
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
  const needsFirstPreset = slotName === '主对话' && apiPresets.length === 0;
  const showCustomForm = manualCustomOpen || binding.status === 'custom' || binding.status === 'deleted_preset' || !allowFollow;

  return (
    <div className="api-connection-compact text-slate-800" data-api-slot={slotName}>
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
              API 预设
            </h4>
            {showCreatePresetHeaderButton && !needsFirstPreset && (
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
            <div className="api-preset-library">
              <ApiPresetPicker presets={apiPresets} activePresetId={activePresetId}>{(preset, close) => (
                <PresetNameButton key={preset.id} className="api-preset-option" aria-pressed={activePresetId === preset.id}
                  aria-describedby="api-preset-help" aria-keyshortcuts="F2" title={`${preset.name}：点选立即引用，长按进行编辑`}
                  onHold={() => { close(); setPresetModal({ open: true, mode: 'edit', preset }); }}
                  onClick={() => { handleSelectPreset(preset); close(); }}>
                  <span className="api-preset-name">{preset.name}</span>
                  {activePresetId === preset.id && <span className="api-preset-selected">✓<span className="sr-only">使用中</span></span>}
                </PresetNameButton>
              )}</ApiPresetPicker>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
              您还没有 API 预设，请先
              <button type="button" data-guide="api-create-preset" onClick={() => setPresetModal({ open: true, mode: 'create', seedConfig: value ?? undefined })}
                className="inline-flex min-h-11 items-center px-1 font-bold text-primary underline underline-offset-4">新建预设</button>
            </div>
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

      {/* 选中预设后直接显示紧凑可编辑字段，复用相同的预设保存路径。 */}
      {binding.status === 'bound' && !manualCustomOpen && <>
        {allowFollow && <button type="button" onClick={handleSwitchToFollow} className="text-xs text-slate-500 py-2">{followButtonLabel}</button>}
        <ApiPresetEditorModal key={binding.preset.id} inline isOpen mode="edit" preset={binding.preset} source={source} customTestRunner={customTestRunner} testSlotName={slotName} testMeta={meta} onClose={() => {}} />
      </>}

      {/* 状态 2b：原绑定预设已被删除的提示条 */}
      {binding.status === 'deleted_preset' && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-800 leading-relaxed">
          原绑定的预设已被删除，当前保留删除前的连接配置正常运行；可直接选其它预设，或在下方修改后自动保存为独立配置。
        </div>
      )}

      {/* 状态 3：单独填写表单 */}
      {!needsFirstPreset && showCustomForm && !(binding.status === 'bound' && !manualCustomOpen) && (
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[11px] font-bold text-slate-500 pl-1">
              {allowFollow ? '单独填写（仅当前位置生效 · 自动保存）' : '单独填写连接（自动保存）'}
            </span>
            <div className="flex items-center gap-2">
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
            models={models}
            onSelectModel={model => updateCustomFields({ model }, true)}
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
            <p role="status" data-api-test-tone={testTone || undefined} className="api-connection-status">
              {status}
            </p>
          )}
        </div>
      )}



      <ApiSaveFeedback revision={saveRevision} />
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
