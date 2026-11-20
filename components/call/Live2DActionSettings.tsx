import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, FadersHorizontal, HandTap, PencilSimple, Play, Plus, Prohibit, Robot, Trash, TShirt, X } from '@phosphor-icons/react';
import { inferLive2DActionTags, type Live2DAction, type Live2DActionPermission, type Live2DAvatarConfig } from '../../utils/live2dModelStore';
import {
  describeLive2DParameter,
  groupLive2DParameters,
  live2DParameterPosition,
} from '../../utils/live2dParameterSemantics';
import Live2DAvatarCanvas, { type Live2DActionTrigger, type Live2DParameterInfo } from './Live2DAvatarCanvas';
import { BUILTIN_SULLY_DEFAULT_FRAMING, isBuiltinSullyLive2D } from '../../utils/builtinSullyLive2D';

interface Live2DActionSettingsProps {
  config: Live2DAvatarConfig;
  characterName: string;
  accentColor: string;
  setupMode?: 'import' | 'advanced';
  onSave: (config: Live2DAvatarConfig) => void;
  onClose: () => void;
}

const permissionOptions: Array<{
  value: Live2DActionPermission;
  label: string;
  Icon: typeof Robot;
}> = [
  { value: 'ai', label: 'AI 可用', Icon: Robot },
  { value: 'manual', label: '仅手动', Icon: HandTap },
  { value: 'blocked', label: '禁用', Icon: Prohibit },
];

const Live2DActionSettings: React.FC<Live2DActionSettingsProps> = ({
  config,
  characterName,
  accentColor,
  setupMode = 'advanced',
  onSave,
  onClose,
}) => {
  const defaultFraming = isBuiltinSullyLive2D(config)
    ? { ...BUILTIN_SULLY_DEFAULT_FRAMING }
    : { scale: 1, offsetX: 0, offsetY: 0 };
  const [actions, setActions] = useState(() => config.actions.map(action => action.wardrobe ? { ...action, permission: 'manual' as const } : action));
  const [activeWardrobeActionId, setActiveWardrobeActionId] = useState(() => (
    config.actions.some(action => action.id === config.activeWardrobeActionId && action.wardrobe)
      ? config.activeWardrobeActionId
      : config.actions.find(action => action.wardrobe)?.id
  ));
  const [previewAction, setPreviewAction] = useState<Live2DActionTrigger | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState('正在准备预览…');
  const [framing, setFraming] = useState(config.framing || { scale: 1, offsetX: 0, offsetY: 0 });
  // VTS 风格自定义参数动作：模型参数表由预览画布加载完成后回传。
  const [modelParameters, setModelParameters] = useState<Live2DParameterInfo[]>([]);
  const [customDraft, setCustomDraft] = useState<null | { id: string; name: string; params: Array<{ id: string; value: number }> }>(null);
  const [showTargetPreview, setShowTargetPreview] = useState(true);
  const [focusedParamId, setFocusedParamId] = useState('');
  const [previewRetryKey, setPreviewRetryKey] = useState(0);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(true);
  const [settingsPage, setSettingsPage] = useState<'actions' | 'framing'>('actions');
  const [settingsBubblePos, setSettingsBubblePos] = useState<{ x: number; y: number } | null>(null);
  const settingsBubbleDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const previewThrottleRef = useRef(0);
  const previewReturnTimerRef = useRef<number | null>(null);
  const settingsBubbleSize = 48;
  const clampSettingsBubble = (x: number, y: number) => ({
    x: Math.max(8, Math.min(window.innerWidth - settingsBubbleSize - 8, x)),
    y: Math.max(56, Math.min(window.innerHeight - settingsBubbleSize - 24, y)),
  });
  const onSettingsBubblePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    settingsBubbleDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onSettingsBubblePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = settingsBubbleDragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    setSettingsBubblePos(clampSettingsBubble(drag.originX + dx, drag.originY + dy));
  };
  const onSettingsBubblePointerUp = () => {
    const drag = settingsBubbleDragRef.current;
    settingsBubbleDragRef.current = null;
    if (drag && !drag.moved) setSettingsPanelOpen(open => !open);
  };

  useEffect(() => {
    setActions(config.actions.map(action => action.wardrobe ? { ...action, permission: 'manual' as const } : action));
    setActiveWardrobeActionId(
      config.actions.some(action => action.id === config.activeWardrobeActionId && action.wardrobe)
        ? config.activeWardrobeActionId
        : config.actions.find(action => action.wardrobe)?.id,
    );
    setFraming(config.framing || { scale: 1, offsetX: 0, offsetY: 0 });
  }, [config.assetId, config.actions, config.framing]);

  useEffect(() => () => {
    if (previewReturnTimerRef.current !== null) window.clearTimeout(previewReturnTimerRef.current);
  }, []);

  // Settings preview may play every discovered item so the user can decide whether to ban it.
  // framing 走单独的 prop 实时预览，不揉进 config，避免滑杆每动一下都重建 config。
  // 正在编辑的参数动作草稿也临时塞进预览配置，让「试一下」能直接播。
  const previewConfig = useMemo<Live2DAvatarConfig>(() => ({
    ...config,
    actions: [
      ...actions
        .filter(action => action.id !== customDraft?.id)
        .map(action => ({ ...action, permission: 'manual' as const })),
      ...(customDraft?.params.length ? [{
        id: customDraft.id,
        kind: 'params' as const,
        name: customDraft.name || '参数动作',
        file: '',
        source: 'custom' as const,
        params: customDraft.params,
        tags: [],
        permission: 'manual' as const,
      }] : []),
    ],
  }), [actions, config, customDraft]);

  const groupedParameters = useMemo(
    () => groupLive2DParameters(modelParameters),
    [modelParameters],
  );
  const focusedParameter = customDraft?.params.find(param => param.id === focusedParamId)
    || customDraft?.params[customDraft.params.length - 1];
  const focusedSemantics = focusedParameter
    ? describeLive2DParameter(focusedParameter.id)
    : null;

  const setPermission = (id: string, permission: Live2DActionPermission) => {
    setActions(current => current.map(action => {
      if (action.id !== id) return action;
      if (action.wardrobe && permission !== 'manual') return action;
      return { ...action, permission };
    }));
  };

  const toggleWardrobe = (id: string) => {
    setActions(current => {
      const selected = current.find(action => action.id === id);
      const enabling = !selected?.wardrobe;
      const next = current.map(action => action.id === id
        ? { ...action, wardrobe: enabling, permission: 'manual' as const }
        : action);
      if (enabling) setActiveWardrobeActionId(id);
      else if (activeWardrobeActionId === id) setActiveWardrobeActionId(next.find(action => action.wardrobe)?.id);
      return next;
    });
  };

  const previewDraft = (force = false) => {
    if (!customDraft?.params.length) return;
    const now = Date.now();
    if (!force && now - previewThrottleRef.current < 250) return;
    previewThrottleRef.current = now;
    if (previewReturnTimerRef.current !== null) window.clearTimeout(previewReturnTimerRef.current);
    setShowTargetPreview(false);
    setPreviewAction({ id: customDraft.id, nonce: now + Math.random() });
    previewReturnTimerRef.current = window.setTimeout(() => {
      setShowTargetPreview(true);
      previewReturnTimerRef.current = null;
    }, 4_150);
  };
  const updateDraftParam = (index: number, patch: Partial<{ id: string; value: number }>) => {
    setCustomDraft(current => current ? {
      ...current,
      params: current.params.map((item, i) => i === index ? { ...item, ...patch } : item),
    } : current);
  };
  const openCustomDraft = (draft?: { id: string; name: string; params: Array<{ id: string; value: number }> }) => {
    if (draft) {
      setCustomDraft(draft);
      setFocusedParamId(draft.params[0]?.id || '');
    } else {
      const starter = modelParameters.find(parameter => describeLive2DParameter(parameter.id).area !== 'tracking')
        || modelParameters[0];
      setCustomDraft({
        id: `custom-params-${Date.now().toString(36)}`,
        name: '',
        params: starter ? [{ id: starter.id, value: starter.max }] : [],
      });
      setFocusedParamId(starter?.id || '');
    }
    setShowTargetPreview(true);
    setPreviewAction(null);
  };
  const addDraftParam = () => {
    if (!customDraft) return;
    const used = new Set(customDraft.params.map(item => item.id));
    const nextParam = modelParameters.find(param => !used.has(param.id)) || modelParameters[0];
    if (!nextParam) return;
    setCustomDraft({ ...customDraft, params: [...customDraft.params, { id: nextParam.id, value: nextParam.max }] });
    setFocusedParamId(nextParam.id);
    setShowTargetPreview(true);
  };
  const saveCustomDraft = () => {
    if (!customDraft || !customDraft.params.length) return;
    const name = customDraft.name.trim() || '自定义动作';
    // 名字里带"生气/微笑/wink"等词时自动打上情绪标签，AI 的 emotion/gesture 也能匹配到它
    const tags = inferLive2DActionTags(name);
    setActions(current => {
      const index = current.findIndex(action => action.id === customDraft.id);
      if (index >= 0) {
        const copy = [...current];
        copy[index] = { ...copy[index], name, params: customDraft.params, tags };
        return copy;
      }
      const entry: Live2DAction = {
        id: customDraft.id,
        kind: 'params',
        name,
        file: '',
        source: 'custom',
        params: customDraft.params,
        tags,
        permission: 'manual',
      };
      return [...current, entry];
    });
    setCustomDraft(null);
  };

  const counts = useMemo(() => ({
    ai: actions.filter(action => action.permission === 'ai' && !action.wardrobe).length,
    manual: actions.filter(action => action.permission === 'manual').length,
    blocked: actions.filter(action => action.permission === 'blocked').length,
    wardrobe: actions.filter(action => action.wardrobe).length,
  }), [actions]);

  return (
    <div className="sully-stage-dark [color-scheme:dark] absolute inset-0 z-[90] flex flex-col bg-[#08070d]/95 text-white backdrop-blur-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 pb-3" style={{ paddingTop: 'max(1.25rem, var(--safe-top))' }}>
        <div className="min-w-0">
          <div className="text-[10px] tracking-[0.2em] text-white/35">{setupMode === 'import' ? 'LIVE2D IMPORT · WARDROBE SETUP' : 'LIVE2D ACTION LIBRARY · ADVANCED'}</div>
          <h2 className="mt-1 truncate text-lg font-semibold">{characterName} · {setupMode === 'import' ? '标记服装动作' : '动作库'}</h2>
        </div>
        <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/65 active:scale-90" aria-label="关闭">
          <X size={17} weight="bold" />
        </button>
      </div>

      {setupMode === 'import' && (
        <div className="mx-4 mt-3 shrink-0 border-l-4 border-fuchsia-300 bg-fuchsia-300/10 px-3 py-2.5" data-testid="live2d-wardrobe-onboarding">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-fuchsia-100"><TShirt size={15} weight="fill" /> 哪些按键会切换服装？</div>
          <p className="mt-1 text-[9px] leading-relaxed text-white/48">先点左侧播放确认效果，再勾选「加入衣橱」。服装动作会强制设为仅手动，AI 永远看不到也不能私自替换。</p>
        </div>
      )}

      <div className="min-h-0 flex-1 px-4 pb-3 pt-3">
        <div className="relative h-full min-h-[260px] overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-[#171322] to-[#090810]">
          <div className="absolute inset-0 opacity-60" style={{ background: `radial-gradient(circle at 50% 55%, ${accentColor}38, transparent 64%)` }} />
          <Live2DAvatarCanvas
            key={`${config.assetId}-${previewRetryKey}`}
            config={previewConfig}
            framing={framing}
            motionState="idle"
            manualAction={previewAction}
            onLoadingChange={(nextLoading, stage) => {
              setLoading(nextLoading);
              if (stage) setLoadingStage(stage);
            }}
            onError={setPreviewError}
            onParametersDiscovered={setModelParameters}
            parameterPreview={customDraft && showTargetPreview ? customDraft.params : null}
          />
          <div className="absolute left-3 top-3 rounded-full border border-white/10 bg-black/35 px-2.5 py-1 text-[9px] text-white/55 backdrop-blur-md">
            {loading
              ? loadingStage
              : customDraft
                ? showTargetPreview ? '正在显示目标姿势' : '正在播放动作过渡'
                : '点击动作左侧 ▶ 预览'}
          </div>
          {customDraft && !loading && (
            <div className="absolute inset-x-3 bottom-3 flex items-end justify-between gap-3">
              <div className="min-w-0 rounded-2xl border border-white/10 bg-black/55 px-3 py-2 backdrop-blur-md">
                <div className="text-[9px] font-medium text-emerald-200/80">
                  {focusedSemantics ? `${focusedSemantics.areaLabel} · ${focusedSemantics.label}` : '动作预览'}
                </div>
                <div className="mt-0.5 max-w-[52vw] truncate text-[9px] text-white/45">
                  {focusedSemantics?.description || '添加参数后，拖动滑杆即可观察模型变化。'}
                </div>
              </div>
              <div className="flex shrink-0 rounded-full border border-white/10 bg-black/55 p-1 backdrop-blur-md">
                <button
                  onClick={() => setShowTargetPreview(false)}
                  className={`rounded-full px-2.5 py-1 text-[9px] transition ${showTargetPreview ? 'text-white/40' : 'bg-white/15 text-white'}`}
                >
                  原始
                </button>
                <button
                  onClick={() => setShowTargetPreview(true)}
                  className={`rounded-full px-2.5 py-1 text-[9px] transition ${showTargetPreview ? 'bg-emerald-400/20 text-emerald-100' : 'text-white/40'}`}
                >
                  目标
                </button>
              </div>
            </div>
          )}
          {previewError && (
            <div className="absolute inset-x-3 bottom-3 rounded-xl border border-rose-300/20 bg-rose-950/85 px-3 py-2 text-[10px] text-rose-100">
              <span className="line-clamp-3 break-all">{previewError}</span>
              <button
                onClick={() => { setPreviewError(''); setLoading(true); setLoadingStage('正在重新加载模型…'); setPreviewRetryKey(key => key + 1); }}
                className="mt-1.5 rounded-full border border-rose-200/30 bg-rose-400/15 px-2.5 py-1 text-[10px] font-medium text-rose-50 active:scale-95"
              >
                重新加载
              </button>
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        onPointerDown={onSettingsBubblePointerDown}
        onPointerMove={onSettingsBubblePointerMove}
        onPointerUp={onSettingsBubblePointerUp}
        onPointerCancel={() => { settingsBubbleDragRef.current = null; }}
        className={`fixed z-[94] flex h-12 w-12 items-center justify-center rounded-full shadow-[0_12px_34px_rgba(0,0,0,.48)] transition-colors active:scale-90 ${settingsPanelOpen ? 'bg-violet-500 text-white ring-4 ring-violet-300/20' : 'border border-violet-300/35 bg-[#16111f]/95 text-violet-200 backdrop-blur-xl'}`}
        style={settingsBubblePos
          ? { left: settingsBubblePos.x, top: settingsBubblePos.y, touchAction: 'none' }
          : { right: 12, top: 'calc(max(1.25rem, var(--safe-top)) + 34vh)', touchAction: 'none' }}
        aria-label={settingsPanelOpen ? '收起动作与参数设置' : '展开动作与参数设置'}
        aria-expanded={settingsPanelOpen}
        data-testid="live2d-floating-settings-toggle"
      >
        <FadersHorizontal size={22} weight="bold" />
      </button>

      {settingsPanelOpen && (
      <section
        className="absolute inset-x-3 z-[70] flex max-h-[54vh] flex-col overflow-hidden rounded-3xl border border-white/12 bg-[#100d18]/95 shadow-[0_18px_60px_rgba(0,0,0,.58)] backdrop-blur-2xl"
        style={{ bottom: 'calc(max(1rem, var(--safe-bottom)) + 6.25rem)' }}
        data-testid="live2d-floating-settings-panel"
      >
        <div className="grid shrink-0 grid-cols-2 border-b border-white/10 p-1.5">
          <button
            type="button"
            onClick={() => setSettingsPage('actions')}
            className={`rounded-2xl px-3 py-2 text-[11px] font-medium transition ${settingsPage === 'actions' ? 'bg-white/10 text-white' : 'text-white/40'}`}
          >
            动作按键 · {actions.length}
          </button>
          <button
            type="button"
            onClick={() => setSettingsPage('framing')}
            className={`rounded-2xl px-3 py-2 text-[11px] font-medium transition ${settingsPage === 'framing' ? 'bg-white/10 text-white' : 'text-white/40'}`}
          >
            镜头构图
          </button>
        </div>

        {settingsPage === 'framing' ? (
        <div className="min-h-0 overflow-y-auto p-3 no-scrollbar">
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-medium text-white/65">镜头构图</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setFraming({ scale: 3.4, offsetX: 0, offsetY: 1.12 })}
              className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-1 text-[9px] text-white/55"
            >近景</button>
            <button
              onClick={() => setFraming({ scale: 5.4, offsetX: 0, offsetY: 2.15 })}
              className="rounded-full border border-violet-300/20 bg-violet-400/10 px-2 py-1 text-[9px] text-violet-200"
            >贴脸</button>
            <button onClick={() => setFraming(defaultFraming)} className="px-1 text-[9px] text-white/35">恢复默认</button>
          </div>
        </div>
        {([
          { key: 'scale' as const, label: '大小', min: 0.55, max: 6, step: 0.01, display: `${Math.round(framing.scale * 100)}%` },
          { key: 'offsetX' as const, label: '左右', min: -1.4, max: 1.4, step: 0.01, display: `${Math.round(framing.offsetX * 100)}` },
          { key: 'offsetY' as const, label: '上下', min: -3.2, max: 3.2, step: 0.01, display: `${Math.round(framing.offsetY * 100)}` },
        ]).map(control => (
          <label key={control.key} className="grid grid-cols-[2.2rem_1fr_2.8rem] items-center gap-2 py-1 text-[9px] text-white/40">
            <span>{control.label}</span>
            <input
              type="range"
              aria-label={control.label}
              min={control.min}
              max={control.max}
              step={control.step}
              value={framing[control.key]}
              onChange={event => setFraming(current => ({ ...current, [control.key]: Number(event.target.value) }))}
              className="h-1 w-full accent-violet-400"
            />
            <span className="text-right tabular-nums text-white/55">{control.display}</span>
          </label>
        ))}
      </div>
        </div>
        ) : (
        <div className="min-h-0 flex flex-1 flex-col">

      <div className="flex shrink-0 items-center gap-2 overflow-x-auto px-3 py-3 no-scrollbar">
        <span className="shrink-0 rounded-full bg-violet-400/15 px-2.5 py-1 text-[10px] text-violet-200">AI {counts.ai}</span>
        <span className="shrink-0 rounded-full bg-sky-400/15 px-2.5 py-1 text-[10px] text-sky-200">手动 {counts.manual}</span>
        <span className="shrink-0 rounded-full bg-rose-400/15 px-2.5 py-1 text-[10px] text-rose-200">禁用 {counts.blocked}</span>
        <span className="shrink-0 rounded-full bg-fuchsia-400/15 px-2.5 py-1 text-[10px] text-fuchsia-100">衣橱 {counts.wardrobe}</span>
        <button
          onClick={() => openCustomDraft()}
          disabled={!modelParameters.length}
          className="shrink-0 inline-flex items-center gap-1 rounded-full border border-emerald-300/25 bg-emerald-400/10 px-2.5 py-1 text-[10px] text-emerald-200 disabled:opacity-35"
          title={modelParameters.length ? '像 VTube Studio 那样自建一组参数动作' : '等模型加载完成后可用'}
        >
          <Plus size={10} weight="bold" /> 参数动作
        </button>
        <span className="min-w-4 flex-1" />
        <button onClick={() => setActions(current => current.map(action => ({ ...action, permission: 'manual' })))} className="shrink-0 text-[10px] text-white/45">全部仅手动</button>
        <button onClick={() => setActions(current => current.map(action => action.wardrobe ? { ...action, permission: 'manual' } : { ...action, permission: 'blocked' }))} className="shrink-0 text-[10px] text-rose-300/65">其余禁用</button>
      </div>

      <p className="shrink-0 px-3 pb-2 text-[9px] leading-relaxed text-white/35">
        衣橱动作始终只允许用户手动切换；其余模型表情和非待机动作可按权限交给 AI。
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 no-scrollbar">
        {!actions.length ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-8 text-center text-sm text-white/45">
            model3.json 没有声明 Motions 或 Expressions；基础眼神、呼吸和口型仍可使用。
          </div>
        ) : (
          <div className="space-y-2">
            {actions.map(action => (
              <div key={action.id} data-live2d-action-id={action.id} data-live2d-wardrobe={action.wardrobe ? 'true' : 'false'} className={`rounded-2xl border p-3 ${action.wardrobe ? 'border-fuchsia-300/35 bg-fuchsia-300/[0.07]' : 'border-white/10 bg-white/[0.045]'}`}>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setPreviewAction({ id: action.id, nonce: Date.now() + Math.random() })}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.07] text-white/70 active:scale-90"
                    aria-label={`预览 ${action.name}`}
                  >
                    <Play size={13} weight="fill" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-white/85">{action.name}</div>
                    <div className="mt-0.5 truncate text-[9px] text-white/30">
                      {action.kind === 'motion'
                        ? `动作 · ${action.group || 'Motion'} #${(action.index ?? 0) + 1}`
                        : action.kind === 'params'
                          ? `参数动作 · ${(action.params || []).length} 项参数`
                          : `表情 · ${action.expressionId || action.id}`}
                      {action.hotkey ? ` · 热键 ${action.hotkey}` : ''}
                      {action.source === 'vtube' ? ' · VTube Studio' : action.source === 'discovered' ? ' · 自动扫描' : action.source === 'custom' ? ' · 自建' : ''}
                      {action.tags.length ? ` · ${action.tags.join(' / ')}` : ''}
                    </div>
                  </div>
                  {action.kind === 'params' && (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => openCustomDraft({ id: action.id, name: action.name, params: [...(action.params || [])] })}
                        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-white/55 active:scale-90"
                        aria-label={`编辑 ${action.name}`}
                      >
                        <PencilSimple size={12} weight="bold" />
                      </button>
                      <button
                        onClick={() => setActions(current => current.filter(item => item.id !== action.id))}
                        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-rose-300/70 active:scale-90"
                        aria-label={`删除 ${action.name}`}
                      >
                        <Trash size={12} weight="bold" />
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => toggleWardrobe(action.id)}
                  className={`mt-2.5 flex w-full items-center justify-between border px-3 py-2 text-left text-[10px] transition active:scale-[.99] ${action.wardrobe ? 'border-fuchsia-300/35 bg-fuchsia-300/15 text-fuchsia-100' : 'border-white/8 bg-black/15 text-white/42'}`}
                >
                  <span className="flex items-center gap-2"><TShirt size={13} weight={action.wardrobe ? 'fill' : 'regular'} /> {action.wardrobe ? '已加入真·衣橱' : '这是服装切换动作'}</span>
                  <span>{action.wardrobe ? '仅手动' : '加入'}</span>
                </button>
                {action.wardrobe && (
                  <button
                    type="button"
                    onClick={() => setActiveWardrobeActionId(action.id)}
                    className={`mt-1.5 flex w-full items-center justify-between border px-3 py-2 text-left text-[10px] ${activeWardrobeActionId === action.id ? 'border-emerald-300/35 bg-emerald-300/15 text-emerald-100' : 'border-white/8 bg-black/15 text-white/42'}`}
                  >
                    <span>导入完成后默认穿这套</span>
                    <span>{activeWardrobeActionId === action.id ? '当前默认' : '设为默认'}</span>
                  </button>
                )}
                <div className="mt-2.5 grid grid-cols-3 gap-1 rounded-xl bg-black/20 p-1">
                  {permissionOptions.map(({ value, label, Icon }) => {
                    const selected = action.permission === value;
                    return (
                      <button
                        key={value}
                        data-live2d-permission={value}
                        onClick={() => setPermission(action.id, value)}
                        disabled={Boolean(action.wardrobe && value !== 'manual')}
                        className={`flex items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] transition disabled:cursor-not-allowed disabled:opacity-20 ${selected ? 'text-white' : 'text-white/35'}`}
                        style={selected ? { background: value === 'blocked' ? 'rgba(244,63,94,.24)' : `${accentColor}44`, boxShadow: `inset 0 0 0 1px ${value === 'blocked' ? 'rgba(251,113,133,.32)' : `${accentColor}66`}` } : undefined}
                      >
                        <Icon size={11} weight={selected ? 'fill' : 'regular'} /> {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
        </div>
        )}
      </section>
      )}

      {customDraft && (
        <div
          className="absolute inset-x-0 bottom-0 z-[95] flex flex-col overflow-hidden rounded-t-[2rem] border-t border-white/10 bg-[#0b0a11]/[0.98] shadow-[0_-24px_70px_rgba(0,0,0,0.6)] backdrop-blur-xl"
          style={{ top: 'min(46vh, calc(max(1.25rem, var(--safe-top)) + max(min(31vh, 250px), 180px) + 4.25rem))' }}
        >
          <div className="shrink-0 border-b border-white/10 px-4 pb-3 pt-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[9px] font-medium tracking-[0.18em] text-emerald-200/55">动作实验台</div>
                <input
                  value={customDraft.name}
                  onChange={event => setCustomDraft(current => current ? { ...current, name: event.target.value } : current)}
                  placeholder="给动作起名，例如：坏笑眨眼"
                  className="mt-1 w-full border-0 bg-transparent p-0 text-base font-semibold text-white outline-none placeholder:text-white/25"
                />
              </div>
              <button
                onClick={() => previewDraft(true)}
                disabled={!customDraft.params.length}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3 text-[10px] text-white/70 transition active:scale-95 disabled:opacity-35"
              >
                <Play size={11} weight="fill" /> 播放过渡
              </button>
              <button
                onClick={() => setCustomDraft(null)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-white/55 active:scale-90"
                aria-label="退出动作实验台"
              >
                <X size={15} weight="bold" />
              </button>
            </div>
            <div className="mt-2 flex items-center justify-between text-[9px] text-white/35">
              <span>拖动后直接看上方模型；原始 ID 仅作模型定位。</span>
              <span className="tabular-nums">{customDraft.params.length} 项参数</span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 no-scrollbar">
            {!customDraft.params.length ? (
              <div className="flex h-full min-h-32 flex-col items-center justify-center text-center">
                <div className="text-sm font-medium text-white/70">这个动作还没有变化</div>
                <div className="mt-1 max-w-64 text-[10px] leading-relaxed text-white/35">添加一个参数，角色会立即停在目标姿势供你观察。</div>
                <button
                  onClick={addDraftParam}
                  disabled={!modelParameters.length}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-emerald-300/20 bg-emerald-400/10 px-4 py-2 text-[11px] text-emerald-100 disabled:opacity-35"
                >
                  <Plus size={12} weight="bold" /> 添加第一个变化
                </button>
              </div>
            ) : customDraft.params.map((param, index) => {
              const meta = modelParameters.find(item => item.id === param.id);
              const min = meta?.min ?? -1;
              const max = meta?.max ?? 1;
              const defaultValue = meta?.defaultValue ?? 0;
              const semantics = describeLive2DParameter(param.id);
              const defaultPosition = live2DParameterPosition(defaultValue, min, max);
              const isFocused = focusedParameter?.id === param.id;
              return (
                <section
                  key={`${param.id}-${index}`}
                  data-live2d-parameter-id={param.id}
                  onPointerDown={() => setFocusedParamId(param.id)}
                  className={`border-b py-4 transition-colors ${isFocused ? 'border-emerald-300/20' : 'border-white/[0.07]'}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[9px] font-medium text-emerald-200/80">
                          {semantics.areaLabel}
                        </span>
                        <span className="text-[13px] font-medium text-white/90">{semantics.label}</span>
                      </div>
                      <p className="mt-1 text-[10px] leading-relaxed text-white/40">{semantics.description}</p>
                    </div>
                    <span className="shrink-0 rounded-md bg-black/25 px-2 py-1 font-mono text-[8px] text-white/28">
                      {param.id}
                    </span>
                    <button
                      onClick={() => setCustomDraft(current => current ? { ...current, params: current.params.filter((_, i) => i !== index) } : current)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center text-rose-300/55 active:scale-90"
                      aria-label={`移除${semantics.label}`}
                    >
                      <Trash size={12} weight="bold" />
                    </button>
                  </div>

                  <select
                    value={param.id}
                    aria-label={`${semantics.label}参数`}
                    onChange={event => {
                      const nextMeta = modelParameters.find(item => item.id === event.target.value);
                      updateDraftParam(index, {
                        id: event.target.value,
                        value: nextMeta ? nextMeta.max : param.value,
                      });
                      setFocusedParamId(event.target.value);
                      setShowTargetPreview(true);
                    }}
                    className="mt-3 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[10px] text-white/65 [color-scheme:dark] [&_option]:bg-[#12101b] [&_option]:text-white [&>optgroup]:bg-[#12101b] [&>optgroup]:text-white/70 outline-none"
                  >
                    {!meta && <option value={param.id}>{param.id}</option>}
                    {groupedParameters.map(group => (
                      <optgroup key={group.area} label={group.label}>
                        {group.parameters.map(item => {
                          const itemSemantics = describeLive2DParameter(item.id);
                          return (
                            <option key={item.id} value={item.id}>
                              {itemSemantics.label} · {item.id}
                            </option>
                          );
                        })}
                      </optgroup>
                    ))}
                  </select>

                  <div className="mt-4">
                    <div className="relative">
                      <div
                        className="pointer-events-none absolute -top-1 h-3 w-px bg-white/30"
                        style={{ left: `${defaultPosition}%` }}
                        title={`默认值 ${defaultValue.toFixed(2)}`}
                      />
                      <input
                        type="range"
                        aria-label={`${semantics.label}目标值`}
                        min={min}
                        max={max}
                        step={0.01}
                        value={param.value}
                        onChange={event => {
                          updateDraftParam(index, { value: Number(event.target.value) });
                          setFocusedParamId(param.id);
                          setShowTargetPreview(true);
                        }}
                        className="relative z-10 h-1 w-full accent-emerald-400"
                      />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[9px]">
                      <span className="text-white/38">{semantics.negativeLabel} · {min.toFixed(2)}</span>
                      <span className="text-white/38">{semantics.positiveLabel} · {max.toFixed(2)}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[10px] tabular-nums text-emerald-100/75">
                        目标 {param.value.toFixed(2)}
                        <span className="ml-2 text-white/28">默认 {defaultValue.toFixed(2)}</span>
                      </span>
                      <button
                        onClick={() => {
                          updateDraftParam(index, { value: defaultValue });
                          setFocusedParamId(param.id);
                          setShowTargetPreview(true);
                        }}
                        className="text-[9px] text-white/38 active:text-white/70"
                      >
                        回到默认
                      </button>
                    </div>
                  </div>
                </section>
              );
            })}

            {!!customDraft.params.length && (
              <button
                onClick={addDraftParam}
                disabled={!modelParameters.length}
                className="my-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/12 py-2.5 text-[10px] text-white/45 disabled:opacity-35"
              >
                <Plus size={11} weight="bold" /> 再添加一个部位
              </button>
            )}
          </div>

          <div className="flex shrink-0 gap-2 border-t border-white/10 bg-black/25 px-4 pt-3" style={{ paddingBottom: 'max(1rem, var(--safe-bottom))' }}>
            <button
              onClick={() => setCustomDraft(null)}
              className="rounded-2xl border border-white/10 px-5 py-3 text-sm text-white/55 transition active:scale-[0.98]"
            >
              取消
            </button>
            <button
              onClick={saveCustomDraft}
              disabled={!customDraft.params.length}
              className="flex-1 rounded-2xl py-3 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-35"
              style={{ background: `linear-gradient(90deg, ${accentColor}aa, ${accentColor})` }}
            >
              保存这个动作
            </button>
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-white/10 bg-black/30 px-4 pt-3" style={{ paddingBottom: 'max(1rem, var(--safe-bottom))' }}>
        <p className="mb-3 text-[10px] leading-relaxed text-white/35">衣橱项目只允许用户手动切换，并从所有 AI 动作白名单中强制排除；“禁用”不会播放。</p>
        <button
          onClick={() => {
            const normalizedActions = actions.map(action => action.wardrobe ? { ...action, permission: 'manual' as const } : action);
            const selectedWardrobeId = normalizedActions.some(action => action.id === activeWardrobeActionId && action.wardrobe)
              ? activeWardrobeActionId
              : normalizedActions.find(action => action.wardrobe)?.id;
            onSave({ ...config, actionPolicyVersion: 2, framing, actions: normalizedActions, activeWardrobeActionId: selectedWardrobeId });
          }}
          className="flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm font-semibold text-white active:scale-[0.98]"
          style={{ background: `linear-gradient(90deg, ${accentColor}aa, ${accentColor})`, boxShadow: `0 0 20px ${accentColor}44` }}
        >
          <Check size={16} weight="bold" /> {setupMode === 'import' ? '保存并完成导入' : '保存权限'}
        </button>
      </div>
    </div>
  );
};

export default Live2DActionSettings;
