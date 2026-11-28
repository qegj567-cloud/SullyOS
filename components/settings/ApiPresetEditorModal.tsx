import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { APIConfig, ApiPreset, DialogueApiConfig } from '../../types';
import { useOS } from '../../context/OSContext';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { fetchLlm } from '../../utils/anthropicApi';
import { normalizeApiBaseUrl } from '../../utils/apiConfigNormalize';
import {
  classifyApiTestError,
  trackApiConnectionTest,
  trackApiPresetAction,
  type ApiSlotAnalyticsName,
} from '../../utils/apiSlotAnalytics';
import {
  readCachedModelsForEndpoint,
  validateApiSlotDraft,
  writeCachedModelsForEndpoint,
} from '../../utils/apiSlots';
import { collectPresetUsageSummary, type PresetUsageSummary } from '../../utils/apiSlotSync';
import { pickDialogueApi } from '../../utils/characterApi';
import { llmApiType, normalizeLlmBaseUrl } from '../../utils/llmEndpoint';
import { extractModelIds } from '../../utils/modelList';
import { extractContent, safeResponseJson } from '../../utils/safeApi';
import Modal from '../os/Modal';
import DialogueApiFields from './DialogueApiFields';
import ApiSaveFeedback from './ApiSaveFeedback';
import ApiPresetPicker from './ApiPresetPicker';

export interface ApiPresetEditorModalProps {
  isOpen: boolean;
  inline?: boolean;
  customTestRunner?: (api: DialogueApiConfig) => Promise<string>;
  testSlotName?: ApiSlotAnalyticsName;
  testMeta?: { appId?: string; appName?: string; charId?: string; charName?: string };
  mode: 'create' | 'edit';
  preset?: ApiPreset | null;
  initialConfig?: DialogueApiConfig | null;
  initialName?: string;
  initialGroup?: string;
  source?: '设置页' | '业务面板';
  onClose: () => void;
  /** 新建或复制产生新预设时回调，供当前槽位立即绑定到该新预设。 */
  onCreatedPreset?: (preset: ApiPreset) => void;
}

function EditorFrame({ inline, children, ...props }: React.ComponentProps<typeof Modal> & { inline: boolean }) {
  return inline ? <div data-testid="inline-preset-fields">{children}</div> : <Modal {...props}>{children}</Modal>;
}

export default function ApiPresetEditorModal({
  isOpen,
  inline = false,
  customTestRunner,
  testSlotName = '主对话',
  testMeta,
  mode,
  preset,
  initialConfig,
  initialName = '',
  initialGroup = '',
  source = '业务面板',
  onClose,
  onCreatedPreset,
}: ApiPresetEditorModalProps) {
  const os = useOS();
  const apiConfig = os?.apiConfig ?? { baseUrl: '', apiKey: '', model: '' };
  const apiPresets = os?.apiPresets ?? [];
  const characters = os?.characters ?? [];
  const memoryPalaceConfig = os?.memoryPalaceConfig;
  const addApiPreset = os?.addApiPreset;
  const updateApiPreset = os?.updateApiPreset;
  const removeApiPreset = os?.removeApiPreset;
  const addToast = os?.addToast ?? (() => {});
  const { requestConfirm, confirmDialog } = useConfirmDialog();

  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [draft, setDraft] = useState<DialogueApiConfig>({ baseUrl: '', apiKey: '', model: '' });
  const [models, setModels] = useState<string[]>([]);
  const [saveRevision, setSaveRevision] = useState(0);
  const [seedPresetId, setSeedPresetId] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState('');
  const [testTone, setTestTone] = useState<'success' | 'error' | null>(null);
  const [hint, setHint] = useState('');
  const [usage, setUsage] = useState<PresetUsageSummary | null>(null);
  const [copying, setCopying] = useState(false);

  const requestVersionRef = useRef(0);
  const lastCommittedJsonRef = useRef('');
  const dirtyRef = useRef(false);
  const latestStateRef = useRef({ name, group, draft, mode, preset, copying });
  latestStateRef.current = { name, group, draft, mode, preset, copying };

  const existingGroups = useMemo(
    () => [...new Set(apiPresets.map((p) => p.group?.trim()).filter((g): g is string => Boolean(g)))],
    [apiPresets],
  );

  useEffect(() => {
    setSaveRevision(0);
    if (!isOpen) {
      setCopying(false);
      return;
    }
    requestVersionRef.current += 1;
    dirtyRef.current = false;
    setSeedPresetId(null);
    setCopying(false);
    setStatus(''); setTestTone(null);
    setHint('');
    if (mode === 'edit' && preset) {
      const picked = pickDialogueApi(preset.config);
      delete picked.presetId;
      delete picked.presetFp;
      setName(preset.name);
      setGroup(preset.group || '');
      setDraft(picked);
      setModels(readCachedModelsForEndpoint(picked));
      lastCommittedJsonRef.current = JSON.stringify({
        name: preset.name.trim(),
        group: (preset.group || '').trim(),
        config: picked,
      });
      if (!inline) void collectPresetUsageSummary(preset.id, {
        apiConfig,
        memoryLightLlm: memoryPalaceConfig?.lightLLM,
        characters,
      }).then(setUsage).catch(() => setUsage(null));
    } else {
      const seed = initialConfig ? pickDialogueApi(initialConfig) : pickDialogueApi(apiConfig);
      delete seed.presetId;
      delete seed.presetFp;
      setName(initialName);
      setGroup(initialGroup);
      setDraft(seed);
      setModels(readCachedModelsForEndpoint(seed));
      lastCommittedJsonRef.current = '';
      setUsage(null);
    }
  }, [isOpen, mode, preset?.id]);

  useEffect(() => {
    if (!inline || !isOpen || !preset || dirtyRef.current) return;
    const next = pickDialogueApi(preset.config);
    delete next.presetId; delete next.presetFp;
    const json = JSON.stringify({ name: preset.name.trim(), group: (preset.group || '').trim(), config: next });
    if (json === lastCommittedJsonRef.current) return;
    setDraft(next); setName(preset.name); setGroup(preset.group || '');
    setModels(readCachedModelsForEndpoint(next));
    lastCommittedJsonRef.current = json;
  }, [inline, isOpen, preset]);

  const flushEditCommit = (
    override?: { name?: string; group?: string; draft?: DialogueApiConfig },
    silentIncomplete = false,
  ): 'saved' | 'unchanged' | 'incomplete' => {
    if (mode !== 'edit' || latestStateRef.current.copying || !preset) return 'unchanged';
    const nextName = (override?.name ?? latestStateRef.current.name).trim();
    const nextGroup = (override?.group ?? latestStateRef.current.group).trim();
    const nextDraft = override?.draft ?? latestStateRef.current.draft;
    if (!nextName) {
      if (!silentIncomplete) setHint('还缺：预设名称');
      return 'incomplete';
    }
    const check = validateApiSlotDraft(nextDraft);
    if (check.kind !== 'valid') {
      if (!silentIncomplete) {
        setHint(check.kind === 'blank' ? '还缺：API 地址与模型' : check.message);
      }
      return 'incomplete';
    }
    const nextJson = JSON.stringify({ name: nextName, group: nextGroup, config: check.normalized });
    if (nextJson === lastCommittedJsonRef.current) {
      setHint('');
      dirtyRef.current = false;
      return 'unchanged';
    }
    lastCommittedJsonRef.current = nextJson;
    dirtyRef.current = false;
    setHint('');
    updateApiPreset(preset.id, nextName, check.normalized as APIConfig, nextGroup);
    setSaveRevision(value => value + 1);
    trackApiPresetAction({ source, action: '修改同步' });
    return 'saved';
  };

  const markEditDirty = (nextState?: { name?: string; group?: string; draft?: DialogueApiConfig }) => {
    if (mode !== 'edit' || latestStateRef.current.copying || !preset) return;
    latestStateRef.current = { ...latestStateRef.current, ...nextState };
    dirtyRef.current = true;
  };

  const handleClose = () => {
    if (mode === 'edit' && !latestStateRef.current.copying && dirtyRef.current) {
      const outcome = flushEditCommit(undefined, true);
      if (outcome === 'incomplete') {
        addToast('预设还有必填项未填完，未完成的修改未生效', 'info');
      }
    }
    requestVersionRef.current += 1;
    onClose();
  };

  useEffect(() => () => {
    if (!inline) return;
    requestVersionRef.current += 1;
    if (dirtyRef.current) flushEditCommit(undefined, true);
  }, [inline, preset?.id]);

  useLocalBackHandler(() => {
    handleClose();
    return true;
  }, 88, isOpen && !inline);

  const updateDraft = (patch: Partial<DialogueApiConfig>, immediate = false) => {
    requestVersionRef.current += 1;
    setLoadingModels(false); setTesting(false); setStatus(''); setTestTone(null);
    const merged: DialogueApiConfig = { ...latestStateRef.current.draft, ...patch };
    if (patch.apiType !== undefined && merged.baseUrl.trim()) {
      merged.baseUrl = normalizeLlmBaseUrl(normalizeApiBaseUrl(merged.baseUrl), patch.apiType);
      setModels(readCachedModelsForEndpoint(merged));
    }
    latestStateRef.current = { ...latestStateRef.current, draft: merged };
    setDraft(merged);
    if (mode === 'edit' && !latestStateRef.current.copying) {
      if (immediate) flushEditCommit({ draft: merged });
      else markEditDirty({ draft: merged });
    }
  };

  const handleUrlBlur = () => {
    const prev = latestStateRef.current.draft;
    const next = { ...prev, baseUrl: normalizeLlmBaseUrl(normalizeApiBaseUrl(prev.baseUrl), llmApiType(prev)) };
    latestStateRef.current = { ...latestStateRef.current, draft: next };
    if (next.baseUrl !== prev.baseUrl) setDraft(next);
    setModels(readCachedModelsForEndpoint(next));
  };

  const fetchModels = async () => {
    const apiType = llmApiType(draft);
    const normalizedUrl = normalizeLlmBaseUrl(normalizeApiBaseUrl(draft.baseUrl), apiType);
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
        headers: { Authorization: `Bearer ${draft.apiKey.trim() || 'sk-none'}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = extractModelIds(await safeResponseJson(res));
      if (version !== requestVersionRef.current) return;
      const saved = writeCachedModelsForEndpoint({ baseUrl: normalizedUrl, apiType }, list);
      setModels(saved);
      setStatus(saved.length ? `获取到 ${saved.length} 个模型` : '模型列表为空，可手动输入');
    } catch (err) {
      if (version === requestVersionRef.current) {
        setStatus(`获取失败：${err instanceof Error ? err.message : '请检查地址或密钥'}`);
      }
    } finally {
      if (version === requestVersionRef.current) setLoadingModels(false);
    }
  };

  const testConnection = async () => {
    const check = validateApiSlotDraft(draft);
    if (check.kind !== 'valid') {
      setStatus(check.kind === 'blank' ? '请先填写 API 地址和模型' : check.message);
      return;
    }
    const api = check.normalized;
    const version = ++requestVersionRef.current;
    setTesting(true);
    setStatus(''); setTestTone(null);
    let httpStatus: number | undefined;
    try {
      if (customTestRunner) {
        const message = await customTestRunner(api);
        if (version !== requestVersionRef.current) return;
        setStatus(message || '连接成功'); setTestTone('success');
        trackApiConnectionTest({ slot: testSlotName, ok: true });
        return;
      }
      const res = await fetchLlm(`${api.baseUrl}/chat/completions`, {
        __sullySettingsModelBase: api.baseUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${api.apiKey || 'sk-none'}`,
        },
        body: JSON.stringify({
          model: api.model,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5,
          stream: api.stream ?? false,
        }),
        __sullyMeta: { appId: 'settings', appName: '设置', ...testMeta, purpose: '测试预设连接', slotStream: api.stream },
      } as RequestInit);
      httpStatus = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = extractContent(await safeResponseJson(res));
      if (version !== requestVersionRef.current) return;
      const ok = Boolean(content);
      setStatus(ok ? '连接成功' : '接口已响应，但回复内容为空'); setTestTone(ok ? 'success' : 'error');
      trackApiConnectionTest({
        slot: testSlotName,
        ok,
        failureCategory: ok ? undefined : classifyApiTestError(httpStatus, false, true),
      });
    } catch (err) {
      if (version !== requestVersionRef.current) return;
      setStatus(`连接失败：${err instanceof Error ? err.message : '请检查配置'}`); setTestTone('error');
      trackApiConnectionTest({
        slot: testSlotName,
        ok: false,
        failureCategory: classifyApiTestError(httpStatus),
      });
    } finally {
      if (version === requestVersionRef.current) setTesting(false);
    }
  };

  const createUniqueCopyName = (baseName: string): string => {
    const existing = new Set(apiPresets.map((p) => p.name.trim()));
    const first = `${baseName.trim() || '预设'} 副本`;
    if (!existing.has(first)) return first;
    let idx = 2;
    while (existing.has(`${baseName.trim() || '预设'} 副本 ${idx}`)) idx += 1;
    return `${baseName.trim() || '预设'} 副本 ${idx}`;
  };

  const startCopyMode = () => {
    if (dirtyRef.current) {
      flushEditCommit(undefined, true);
      dirtyRef.current = false;
    }
    setCopying(true);
    setName((prev) => createUniqueCopyName(prev));
    setHint('正在复制为新预设，调整参数后点「保存副本」生成');
  };

  const handleCreateOrDuplicate = (asDuplicate = false) => {
    const targetName = name.trim();
    if (!targetName) {
      setHint('请填写预设名称');
      return;
    }
    const check = validateApiSlotDraft(draft);
    if (check.kind !== 'valid') {
      setHint(check.kind === 'blank' ? '请先填写有效的 API 地址与模型' : check.message);
      return;
    }
    const trimmedGroup = group.trim() || undefined;
    const created = addApiPreset?.(targetName, check.normalized as APIConfig, trimmedGroup);
    trackApiPresetAction({ source, action: asDuplicate ? '复制副本' : '新建' });
    if (!asDuplicate && created && onCreatedPreset) {
      onCreatedPreset(created);
    }
    addToast(asDuplicate ? `已另存副本「${targetName}」` : `已保存预设「${targetName}」`, 'success');
    onClose();
  };

  const handleDelete = async () => {
    if (!preset) return;
    const count = usage?.totalCount ?? 0;
    const scopeLine = count > 0
      ? `当前有 ${count} 处正在使用「${preset.name}」（${[
        ...usage!.currentSpaceLabels,
        ...(usage!.otherSpacesCount > 0 ? [`其他用户空间 ${usage!.otherSpacesCount} 处`] : []),
      ].join('、')}）。删除后这些位置不会断网，会自动保留删除前的连接配置继续运行。`
      : `确定要删除预设「${preset.name}」吗？`;
    const confirmed = await requestConfirm({
      title: '删除预设',
      message: scopeLine,
      confirmText: '确认删除',
      variant: 'danger',
    });
    if (!confirmed) return;
    dirtyRef.current = false;
    removeApiPreset?.(preset.id);
    trackApiPresetAction({ source, action: '删除' });
    addToast(`已删除预设「${preset.name}」`, 'info');
    onClose();
  };

  const datalistId = `api-preset-groups-${preset?.id || 'new'}`;

  return (
    <>
      <EditorFrame inline={inline}
        isOpen={isOpen}
        title={copying ? '复制 API 预设' : mode === 'edit' ? '编辑 API 预设' : '新建 API 预设'}
        onClose={handleClose}
        footer={
          mode === 'create' || copying ? (
            <>
              <button
                type="button"
                onClick={handleClose}
                className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-sm"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleCreateOrDuplicate(copying)}
                className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl text-sm active:scale-95 transition-transform"
              >
                {copying ? '保存副本' : '创建并选用'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleClose}
              className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-sm active:scale-95 transition-transform"
            >
              完成
            </button>
          )
        }
      >
        <ApiSaveFeedback revision={saveRevision} />
        <div className="space-y-4 text-slate-800" data-api-preset-editor>
          {!inline && mode === 'edit' && !copying && preset && (
            <div className="rounded-2xl bg-amber-50 border border-amber-200/80 px-3.5 py-2.5 text-[11px] text-amber-900 leading-relaxed space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold">修改会同时更新所有使用此预设的位置</span>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={startCopyMode}
                    className="text-[11px] font-bold text-primary hover:underline"
                  >
                    复制预设
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="text-[11px] font-bold text-red-500 hover:underline"
                  >
                    删除预设
                  </button>
                </div>
              </div>
              {usage && usage.totalCount > 0 ? (
                <p className="text-[10.5px] text-amber-800/90 break-words">
                  正在使用（共 {usage.totalCount} 处）：
                  {[
                    ...usage.currentSpaceLabels,
                    ...(usage.otherSpacesCount > 0 ? [`其他用户空间 ${usage.otherSpacesCount} 处`] : []),
                  ].join('、')}
                </p>
              ) : (
                <p className="text-[10.5px] text-amber-700/80">当前暂无位置绑定此预设；修改会自动保存。</p>
              )}
            </div>
          )}

          {mode === 'create' && apiPresets.length > 0 && <div className="api-preset-library">
            <ApiPresetPicker presets={apiPresets} activePresetId={seedPresetId} label="沿用已有预设" emptyLabel="选择已有预设"
              helpText="选中后填入当前表单，修改不会影响原预设。">
              {(sourcePreset, close) => <button type="button" className="api-preset-option" onClick={() => {
                const next = pickDialogueApi(sourcePreset.config);
                delete next.presetId; delete next.presetFp;
                requestVersionRef.current += 1;
                setLoadingModels(false); setTesting(false); setStatus(''); setTestTone(null);
                setDraft(next); setModels(readCachedModelsForEndpoint(next));
                setName(current => current.trim() || createUniqueCopyName(sourcePreset.name));
                setGroup(sourcePreset.group || ''); setSeedPresetId(sourcePreset.id);
                setHint('已填入所选预设的配置，确认名称后创建即可。');
                close();
              }}><span className="api-preset-name">{sourcePreset.name}</span></button>}
            </ApiPresetPicker>
          </div>}

          {!inline && <>
          <div className="grid grid-cols-1 gap-3">
            <label className="block text-xs text-slate-500">
              预设名称
              <input
                aria-label="预设名称"
                type="text"
                value={name}
                onChange={(e) => {
                  const next = e.target.value;
                  setName(next);
                  markEditDirty({ name: next });
                }}
                onBlur={() => flushEditCommit()}
                placeholder="预设名称"
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800"
              />
            </label>
            <label className="block text-xs text-slate-500">
              分组（选填）
              <input
                aria-label="预设分组"
                type="text"
                list={datalistId}
                value={group}
                onChange={(e) => {
                  const next = e.target.value;
                  setGroup(next);
                  markEditDirty({ group: next });
                }}
                onBlur={() => flushEditCommit()}
                placeholder="例如：主力对话 / 轻量后台"
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800"
              />
              {existingGroups.length > 0 && (
                <datalist id={datalistId}>
                  {existingGroups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              )}
            </label>
          </div>

          </>}
          <DialogueApiFields
            value={draft}
            modelPlaceholder="模型名称"
            onChange={(patch) => {
              const immediate = patch.apiType !== undefined || patch.stream !== undefined;
              updateDraft(patch, immediate);
            }}
            onUrlBlur={handleUrlBlur}
            onFieldBlur={() => flushEditCommit()}
            fetchModels={fetchModels}
            isLoadingModels={loadingModels}
            models={models}
            onSelectModel={model => updateDraft({ model }, true)}
          />

          <button
            type="button"
            onClick={testConnection}
            disabled={testing || !draft.baseUrl.trim() || !draft.model.trim()}
            className="w-full py-2.5 rounded-xl border border-primary/30 text-primary text-xs font-bold disabled:opacity-40"
          >
            {testing ? '测试中…' : '测试连接'}
          </button>

          {hint && (
            <p className="text-[11px] text-slate-500" data-testid="preset-editor-hint">
              {hint}
            </p>
          )}
          {status && (
            <p role="status" data-api-test-tone={testTone || undefined} className="api-connection-status">
              {status}
            </p>
          )}
        </div>
      </EditorFrame>



      {confirmDialog}
    </>
  );
}
