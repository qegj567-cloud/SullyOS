import React, { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, ArrowsOutCardinal, CaretDown, FileZip, FolderOpen, ImageSquare, Play, SlidersHorizontal, UploadSimple, WarningCircle } from '@phosphor-icons/react';
import type { AvatarTouchRegion, CharacterProfile } from '../../types';
import { getAvatarModelBlob } from '../../utils/avatarModelStore';
import {
  clampStageFraming,
  DEFAULT_STAGE_CROP,
  DEFAULT_STAGE_FRAMING,
  type AvatarPerformanceDirection,
  type AvatarStageCrop,
  type AvatarStageFraming,
} from '../../utils/avatarPerformance';
import type { CallAudioFeed } from '../../utils/callAudioFeed';
import VRMAvatarCanvas, { type AvatarMotionState } from './VRMAvatarCanvas';
import Live2DAvatarCanvas, { type Live2DActionTrigger } from './Live2DAvatarCanvas';
import {
  isAvatarTouchGesture,
  type AvatarTouchHit,
  type AvatarTouchRequest,
  type AvatarTouchZone,
} from '../../utils/avatarTouch';
import StaticCompanionPortrait from '../os/StaticCompanionPortrait';
import TokenImg from '../os/TokenImg';

interface VRMVideoCallStageProps {
  characterName: string;
  fallbackAvatar?: string;
  model?: CharacterProfile['videoAvatar'];
  /** Flat PNG/GIF or Date sprite selected for the shared desktop/video avatar. */
  staticAvatarSource?: 'upload' | 'date';
  staticPortraitValue?: string;
  staticExpressionKey?: string;
  staticSpriteConfig?: CharacterProfile['spriteConfig'];
  motionState: AvatarMotionState;
  emotion?: string;
  audioFeed?: CallAudioFeed;
  /** External hard lock used by companion startup; independent from performance cues. */
  headMotionLocked?: boolean;
  performance?: AvatarPerformanceDirection;
  performanceQuality?: 'basic' | 'high';
  accentColor: string;
  /** 已解析成可渲染 URL 的自定义背景（blobref → objectURL 在 CallApp 完成）。 */
  backgroundUrl?: string;
  onChooseModel: () => void;
  onChooseLive2DFolder?: () => void;
  onConfigureActions?: () => void;
  onConfigureBackground?: () => void;
  /** 用户在舞台上拖拽/缩放后的构图提交（手势结束时触发，用于持久化）。 */
  onFramingChange?: (framing: AvatarStageFraming) => void;
  /** 脸部锚点保存/清除（null = 清除），持久化到 videoAvatar.faceFraming。 */
  onFaceAnchorChange?: (framing: AvatarStageFraming | null) => void;
  /** VRM 模型加载后回传自定义表情名，供 LLM 的 model_action 白名单使用。 */
  onExpressionsDiscovered?: (names: string[]) => void;
  /** Fired only after the renderable model has completed loading. */
  onModelReady?: () => void;
  /** Lets the companion desktop uncover the stage instead of trapping an error behind its loading curtain. */
  onModelError?: (message: string) => void;
  onAvatarTouch?: (hit: AvatarTouchHit) => void;
  /** Changes only for explicit companion touches; call ambience never sets it. */
  touchImpulseNonce?: number;
  /** Explicit user-only Live2D action, used by the companion wardrobe. */
  externalManualAction?: Live2DActionTrigger | null;
  /** Minimal chrome for the always-on launcher companion. */
  companionMode?: boolean;
  /** 基准构图覆盖：陪伴桌面传 companionFraming，优先于 model.framing 作为静息构图。 */
  baseFraming?: AvatarStageFraming;
  /** 布置模式：companionMode 下重新启用拖拽/捏合/滚轮调构图（默认 = !companionMode）。 */
  framingEditable?: boolean;
  /** Optional companion-only mask. Insets are percentages of the full stage. */
  stageCrop?: AvatarStageCrop;
  /** Shows the exact crop window while the desktop composition editor is open. */
  showCropGuide?: boolean;
  /** Live2D-only model-local touch-region draft and editor controls. */
  touchRegions?: AvatarTouchRegion[];
  touchRegionEditingZone?: AvatarTouchZone;
  onTouchRegionsChange?: (regions: AvatarTouchRegion[]) => void;
  maxFps?: number;
}

// 两种渲染器的构图范围：Live2D 与设置面板滑杆一致，VRM 是相机距离/视野平移的安全区。
const FRAMING_LIMITS = {
  vrm: { scale: [0.5, 4] as [number, number], offsetX: [-0.9, 0.9] as [number, number], offsetY: [-0.9, 0.9] as [number, number] },
  live2d: { scale: [0.55, 6] as [number, number], offsetX: [-1.4, 1.4] as [number, number], offsetY: [-3.2, 3.2] as [number, number] },
};

const stateLabel = (state: AvatarMotionState): string => {
  if (state === 'speaking') return '正在说话';
  if (state === 'thinking') return '正在想';
  if (state === 'connecting') return '正在接通';
  if (state === 'error') return '连接波动';
  return '看着你';
};

const VRMVideoCallStage: React.FC<VRMVideoCallStageProps> = ({
  characterName,
  fallbackAvatar,
  model,
  staticAvatarSource,
  staticPortraitValue,
  staticExpressionKey = 'normal',
  staticSpriteConfig,
  motionState,
  emotion,
  audioFeed,
  headMotionLocked = false,
  performance,
  performanceQuality = 'basic',
  accentColor,
  backgroundUrl,
  onChooseModel,
  onChooseLive2DFolder,
  onConfigureActions,
  onConfigureBackground,
  onFramingChange,
  onFaceAnchorChange,
  onExpressionsDiscovered,
  onAvatarTouch,
  onModelReady,
  onModelError,
  touchImpulseNonce,
  externalManualAction,
  companionMode = false,
  baseFraming,
  framingEditable,
  stageCrop = DEFAULT_STAGE_CROP,
  showCropGuide = false,
  touchRegions,
  touchRegionEditingZone,
  onTouchRegionsChange,
  maxFps,
}) => {
  const canAdjustFraming = !touchRegionEditingZone && (framingEditable ?? !companionMode);
  // 动作/表情快捷按钮默认收起——一排药丸浮在模型上视觉太吵，想用再展开。
  const [actionChipsOpen, setActionChipsOpen] = useState(() => {
    try { return localStorage.getItem('sully-call-action-chips-v1') === 'open'; } catch { return false; }
  });
  const toggleActionChips = () => setActionChipsOpen(prev => {
    const next = !prev;
    try { localStorage.setItem('sully-call-action-chips-v1', next ? 'open' : 'closed'); } catch { /* ignore */ }
    return next;
  });
  const [modelUrl, setModelUrl] = useState('');
  const [modelMissing, setModelMissing] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoadingStage, setModelLoadingStage] = useState('正在准备角色…');
  const [modelError, setModelError] = useState('');
  const [live2DRetryKey, setLive2DRetryKey] = useState(0);
  const [stageToolsOpen, setStageToolsOpen] = useState(false);
  const [manualAction, setManualAction] = useState<Live2DActionTrigger | null>(null);
  const [touchRequest, setTouchRequest] = useState<AvatarTouchRequest | null>(null);

  // ── 舞台构图：拖拽移动、双指捏合/滚轮缩放，手势结束时统一提交持久化 ──
  const [framing, setFraming] = useState<AvatarStageFraming>(baseFraming || model?.framing || DEFAULT_STAGE_FRAMING);
  const framingRef = useRef(framing);
  const framingDirtyRef = useRef(false);
  const stageBoxRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<{
    pointers: Map<number, {
      x: number;
      y: number;
      startX: number;
      startY: number;
      startedAt: number;
      maxDistance: number;
      maxPressure: number;
      pointerType: AvatarTouchRequest['pointerType'];
    }>;
    pinchDist: number;
  }>({ pointers: new Map(), pinchDist: 0 });
  const wheelCommitTimerRef = useRef<number | null>(null);
  const framingLimits = model?.format === 'live2d' ? FRAMING_LIMITS.live2d : FRAMING_LIMITS.vrm;

  // 跟随外部构图变化（换模型、设置面板滑杆保存）。舞台自己提交的构图写回
  // 角色后也会流回这里，值相同因此不会造成抖动或循环。
  useEffect(() => {
    if (gestureRef.current.pointers.size) return; // 手势进行中以本地为准
    if (calibratingFaceRef.current) return; // 脸部校准中以本地为准
    const next = baseFraming || model?.framing || DEFAULT_STAGE_FRAMING;
    framingRef.current = next;
    setFraming(next);
  }, [model?.assetId, model?.framing, baseFraming]);
  useEffect(() => () => {
    if (wheelCommitTimerRef.current !== null) window.clearTimeout(wheelCommitTimerRef.current);
  }, []);

  // ── 脸部锚定校准模式：拖/缩到理想特写后保存；校准中的构图不写回 base ──
  const [calibratingFace, setCalibratingFace] = useState(false);
  const calibratingFaceRef = useRef(false);
  const preCalibrationFramingRef = useRef<AvatarStageFraming>(DEFAULT_STAGE_FRAMING);

  const applyFraming = (updater: (current: AvatarStageFraming) => AvatarStageFraming) => {
    const next = clampStageFraming(updater(framingRef.current), framingLimits);
    framingRef.current = next;
    framingDirtyRef.current = true;
    setFraming(next);
  };
  const commitFraming = () => {
    if (!framingDirtyRef.current) return;
    framingDirtyRef.current = false;
    // 校准脸部时的拖拽只属于锚点，不写回日常构图
    if (calibratingFaceRef.current) return;
    onFramingChange?.(framingRef.current);
  };
  const resetFraming = () => {
    applyFraming(() => DEFAULT_STAGE_FRAMING);
    commitFraming();
  };
  const setFramingLocal = (next: AvatarStageFraming) => {
    framingRef.current = next;
    framingDirtyRef.current = false;
    setFraming(next);
  };
  const beginFaceCalibration = () => {
    preCalibrationFramingRef.current = framingRef.current;
    calibratingFaceRef.current = true;
    setCalibratingFace(true);
    // 已有锚点就从锚点起步微调；没有就从当前构图放大一点作为起手式
    const existing = model?.faceFraming;
    setFramingLocal(clampStageFraming(
      existing || { ...framingRef.current, scale: Math.max(framingRef.current.scale * 1.8, 1.8) },
      framingLimits,
    ));
  };
  const endFaceCalibration = (save: boolean, clear = false) => {
    if (clear) onFaceAnchorChange?.(null);
    else if (save) onFaceAnchorChange?.(framingRef.current);
    calibratingFaceRef.current = false;
    setCalibratingFace(false);
    setFramingLocal(preCalibrationFramingRef.current);
  };
  const framingAdjusted = Math.abs(framing.scale - 1) > 0.02
    || Math.abs(framing.offsetX) > 0.01
    || Math.abs(framing.offsetY) > 0.01;
  const cropAdjusted = stageCrop.top > 0.001
    || stageCrop.right > 0.001
    || stageCrop.bottom > 0.001
    || stageCrop.left > 0.001;
  const cropInset = `${stageCrop.top * 100}% ${stageCrop.right * 100}% ${stageCrop.bottom * 100}% ${stageCrop.left * 100}%`;

  const handleStagePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, video')) return;
    const gesture = gestureRef.current;
    gesture.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: window.performance.now(),
      maxDistance: 0,
      maxPressure: Math.max(0, Math.min(1, event.pressure || 0)),
      pointerType: event.pointerType === 'mouse' || event.pointerType === 'touch' || event.pointerType === 'pen'
        ? event.pointerType
        : 'unknown',
    });
    if (gesture.pointers.size === 2) {
      const [a, b] = [...gesture.pointers.values()];
      gesture.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      gesture.pointers.forEach(pointer => { pointer.maxDistance = Number.POSITIVE_INFINITY; });
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handleStagePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    const previous = gesture.pointers.get(event.pointerId);
    if (!previous) return;
    const moved = Math.hypot(event.clientX - previous.startX, event.clientY - previous.startY);
    gesture.pointers.set(event.pointerId, {
      ...previous,
      x: event.clientX,
      y: event.clientY,
      maxDistance: Math.max(previous.maxDistance, moved),
      maxPressure: Math.max(previous.maxPressure, Math.max(0, Math.min(1, event.pressure || 0))),
    });
    const rect = stageBoxRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    if (gesture.pointers.size === 1 && canAdjustFraming) {
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      if (dx || dy) applyFraming(current => ({ ...current, offsetX: current.offsetX + dx / rect.width, offsetY: current.offsetY + dy / rect.height }));
    } else if (gesture.pointers.size === 2 && canAdjustFraming) {
      const [a, b] = [...gesture.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.pinchDist > 1 && dist > 1) {
        const ratio = dist / gesture.pinchDist;
        applyFraming(current => ({ ...current, scale: current.scale * ratio }));
      }
      gesture.pinchDist = dist;
    }
  };
  const handleStagePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    const pointer = gesture.pointers.get(event.pointerId);
    const wasSinglePointer = gesture.pointers.size === 1;
    if (!gesture.pointers.delete(event.pointerId)) return;
    if (gesture.pointers.size < 2) gesture.pinchDist = 0;
    if (!gesture.pointers.size && canAdjustFraming) commitFraming();
    if (
      event.type === 'pointerup'
      && pointer
      && isAvatarTouchGesture(
        pointer.maxDistance,
        window.performance.now() - pointer.startedAt,
        wasSinglePointer,
      )
      && !calibratingFaceRef.current
    ) {
      const rect = stageBoxRef.current?.getBoundingClientRect();
      if (!rect?.width || !rect.height) return;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const durationMs = Math.max(0, window.performance.now() - pointer.startedAt);
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
      setTouchRequest({
        nonce: Date.now() + Math.random(),
        x,
        y,
        normalizedX: x / rect.width,
        normalizedY: y / rect.height,
        pressure: Math.max(pointer.maxPressure, Math.max(0, Math.min(1, event.pressure || 0))),
        durationMs,
        pointerType: pointer.pointerType,
      });
    }
  };
  const handleStageWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!canAdjustFraming) return;
    applyFraming(current => ({ ...current, scale: current.scale * Math.exp(-event.deltaY * 0.0012) }));
    if (wheelCommitTimerRef.current !== null) window.clearTimeout(wheelCommitTimerRef.current);
    wheelCommitTimerRef.current = window.setTimeout(() => {
      wheelCommitTimerRef.current = null;
      commitFraming();
    }, 500);
  };

  useEffect(() => {
    let cancelled = false;
    let url = '';
    setModelMissing(false);
    setModelError('');
    setLive2DRetryKey(0);
    setModelLoading(false);
    setModelUrl('');
    if (!model || model.format !== 'vrm') return;

    void getAvatarModelBlob(model).then(blob => {
      if (cancelled) return;
      if (!blob) {
        setModelMissing(true);
        onModelError?.('模型文件已丢失，请重新导入');
        return;
      }
      url = URL.createObjectURL(blob);
      setModelUrl(url);
    }).catch(error => {
      if (!cancelled) {
        const message = error instanceof Error ? error.message : '模型读取失败';
        setModelError(message);
        onModelError?.(message);
      }
    });

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [model?.assetId]);

  const retryLive2D = () => {
    setModelMissing(false);
    setModelError('');
    setModelLoading(true);
    setModelLoadingStage('正在重新建立 Live2D 渲染资源…');
    setLive2DRetryKey(current => current + 1);
  };

  const handleLive2DError = (message: string) => {
    if (!message) {
      setModelError('');
      return;
    }
    const missing = /文件已丢失|找不到 model3\.json|模型包内找不到/i.test(message);
    setModelMissing(missing);
    // The first failure is commonly a stale Pixi texture left by the settings
    // preview. Recreate the renderer once with an isolated texture identity
    // before surfacing an error or asking the user to re-import anything.
    if (!missing && live2DRetryKey === 0) {
      setModelLoading(true);
      setModelLoadingStage('检测到贴图缓存切换，正在自动恢复…');
      setLive2DRetryKey(1);
      return;
    }
    setModelError(message);
    onModelError?.(message);
  };

  const staticAvatarActive = staticAvatarSource === 'upload' || staticAvatarSource === 'date';
  const hasRenderableModel = Boolean(model && !modelError && (model.format === 'live2d' || modelUrl));
  const hasRenderableAvatar = staticAvatarActive || hasRenderableModel;

  return (
    <div
      className={`relative h-full w-full overflow-hidden ${companionMode ? '' : 'rounded-[1.9rem] border border-white/15 bg-[#080a10]'}`}
      style={companionMode ? undefined : { boxShadow: `inset 0 1px 0 ${accentColor}48, inset 0 -1px 0 ${accentColor}24, 0 18px 50px rgba(0,0,0,.36), 0 0 28px ${accentColor}12` }}
      data-avatar-emotion={performance?.emotion || emotion || 'calm'}
      data-avatar-gesture={performance?.gesture || 'talk'}
      data-avatar-camera={performance?.camera || 'medium'}
      data-avatar-gaze={performance?.gaze || 'viewer'}
      data-avatar-format={staticAvatarActive ? `static-${staticAvatarSource}` : model?.format || 'none'}
    >
      <style>{`
        @keyframes vrm-stage-drift { 0%,100% { transform: translate3d(0,0,0) scale(1.02) } 50% { transform: translate3d(0,-5px,0) scale(1.025) } }
        @keyframes vrm-stage-arrive { from { opacity:0; transform:scale(1.035) } to { opacity:1; transform:scale(1) } }
        @keyframes companion-stage-fade { from { opacity:0 } to { opacity:1 } }
        @keyframes companion-static-expression-in { from { opacity:.35; filter:brightness(1.08) } to { opacity:1; filter:brightness(1) } }
      `}</style>
      {!companionMode && (
        <>
          <div className="pointer-events-none absolute inset-x-[18%] top-0 z-20 h-px" style={{ background: `linear-gradient(90deg, transparent, ${accentColor}cc, transparent)` }} />
          <span className="pointer-events-none absolute left-4 top-12 z-20 text-[7px]" style={{ color: `${accentColor}c9` }} aria-hidden>✦</span>
          <span className="pointer-events-none absolute bottom-4 right-4 z-20 text-[6px] text-white/55" aria-hidden>✦</span>
        </>
      )}
      {backgroundUrl ? (
        <>
          <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${backgroundUrl})` }} />
          {/* 自定义背景上压一层暗色渐变，保证状态文字和模型轮廓仍然可读 */}
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(3,4,7,0.5), rgba(3,4,7,0.08) 42%, rgba(3,4,7,0.28))' }} />
        </>
      ) : companionMode ? null : ( /* 陪伴桌面自己画时段氛围背景，舞台保持透明 */
        <>
          <div className="absolute inset-0" style={{ background: `radial-gradient(80% 70% at 50% 45%, ${accentColor}2e, transparent 72%), linear-gradient(160deg, #111522 0%, #07090f 58%, #030407 100%)` }} />
          <div className="absolute inset-x-0 bottom-0 h-1/2 opacity-60" style={{ background: `linear-gradient(to top, ${accentColor}1f, transparent)` }} />
        </>
      )}
      <div className="absolute left-1/2 bottom-[7%] h-[12%] w-[52%] -translate-x-1/2 rounded-[50%] blur-xl" style={{ background: `${accentColor}31` }} />

      {hasRenderableAvatar ? (
        <div
          ref={stageBoxRef}
          className="absolute inset-0 touch-none"
          style={{
            animation: companionMode
              ? 'companion-stage-fade 180ms ease-out both'
              : 'vrm-stage-arrive 520ms ease-out both',
            clipPath: cropAdjusted ? `inset(${cropInset} round 1.4rem)` : undefined,
          }}
          onPointerDown={staticAvatarActive ? undefined : handleStagePointerDown}
          onPointerMove={staticAvatarActive ? undefined : handleStagePointerMove}
          onPointerUp={staticAvatarActive ? undefined : handleStagePointerEnd}
          onPointerCancel={staticAvatarActive ? undefined : handleStagePointerEnd}
          onWheel={staticAvatarActive ? undefined : handleStageWheel}
        >
          {staticAvatarActive ? (
            <StaticCompanionPortrait
              value={staticPortraitValue}
              characterName={characterName}
              spriteConfig={staticSpriteConfig}
              expressionKey={staticExpressionKey}
              touchEnabled={Boolean(onAvatarTouch)}
              onAvatarTouch={onAvatarTouch}
              surfaceLabel="视频形象"
              testId="video-call-static-portrait-stage"
            />
          ) : model?.format === 'live2d' ? (
            <Live2DAvatarCanvas
              key={`${model.assetId}-${model.textureQuality === 'hd' ? 'hd' : 'balanced'}-${live2DRetryKey}`}
              config={model}
              motionState={motionState}
              audioFeed={audioFeed}
              headMotionLocked={headMotionLocked}
              ambientAutonomyDisabled={companionMode}
              framing={framing}
              faceFraming={calibratingFace ? undefined : model.faceFraming}
              performance={performance}
              performanceQuality={performanceQuality}
              manualAction={externalManualAction || manualAction}
              preserveActiveWardrobe
              touchRequest={touchRequest}
              touchImpulseNonce={touchImpulseNonce}
              onAvatarTouch={onAvatarTouch}
              touchRegions={touchRegions}
              touchRegionEditingZone={touchRegionEditingZone}
              onTouchRegionsChange={onTouchRegionsChange}
              maxFps={maxFps}
              onReady={onModelReady}
              onLoadingChange={(loading, stage) => {
                setModelLoading(loading);
                if (stage) setModelLoadingStage(stage);
              }}
              onError={handleLive2DError}
            />
          ) : (
            <VRMAvatarCanvas
              modelUrl={modelUrl}
              motionState={motionState}
              emotion={emotion}
              audioFeed={audioFeed}
              headMotionLocked={headMotionLocked}
              ambientAutonomyDisabled={companionMode}
              framing={framing}
              faceFraming={calibratingFace ? undefined : model?.faceFraming}
              performance={performance}
              touchImpulseNonce={touchImpulseNonce}
              touchRequest={touchRequest}
              onAvatarTouch={onAvatarTouch}
              maxFps={maxFps}
              onLoadingChange={setModelLoading}
              onError={message => {
                setModelError(message);
                if (message) onModelError?.(message);
              }}
              onExpressionsDiscovered={onExpressionsDiscovered}
              onReady={onModelReady}
            />
          )}
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
          {fallbackAvatar ? (
            <div className={`relative overflow-hidden rounded-full border border-white/15 ${companionMode ? 'h-36 w-36' : 'h-20 w-20'}`} style={{ animation: 'vrm-stage-drift 5.5s ease-in-out infinite', boxShadow: `0 0 55px ${accentColor}4d` }}>
              {/* 兜底头像来自 char.avatar：上传的头像存的是 blobref 令牌，裸 <img> 会裂图，
                  交给 TokenImg 统一解析（旧的 data: / http 外链原样透传） */}
              <TokenImg value={fallbackAvatar} alt={characterName} className="h-full w-full object-cover" />
            </div>
          ) : (
            <div className="flex h-28 w-28 items-center justify-center rounded-full border border-white/15 text-5xl font-light" style={{ background: `${accentColor}22`, color: accentColor }}>{characterName[0] || '角'}</div>
          )}
          <div className={`${companionMode ? 'mt-5' : 'mt-3'} text-sm font-medium text-white/85`}>
            {modelMissing ? '模型文件已丢失，需要重新导入' : modelError ? '模型暂时加载失败' : companionMode ? '给 ta 换上陪伴形象' : '给这个角色装上视频模型'}
          </div>
          <p className="mt-1.5 max-w-[17rem] text-xs leading-relaxed text-white/45">
            {modelError && !modelMissing ? '模型仍保存在本地，可以直接重新建立渲染，不必重复导入。' : companionMode && !modelMissing ? '图片或 GIF 可以在「外观」中设置，也能沿用见面立绘。想使用动态模型，可以在这里导入。' : '支持 VRM 0.x / 1.0，以及 Cubism model3.json 文件夹或 ZIP。'}
          </p>
          {model?.format === 'live2d' && modelError && !modelMissing ? (
            <div className={`${companionMode ? 'mt-4' : 'mt-2.5'} flex items-center gap-2`}>
              <button onClick={retryLive2D} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-4 py-2.5 text-[11px] font-medium text-white transition active:scale-95">
                <ArrowClockwise size={15} weight="bold" /> 重新加载模型
              </button>
              <button onClick={onChooseModel} className="px-2 py-2 text-[10px] text-white/40">重新导入</button>
            </div>
          ) : onChooseLive2DFolder ? (
            <div className={`${companionMode ? 'mt-4' : 'mt-2.5'} grid w-full max-w-[18rem] grid-cols-1 gap-2 sm:grid-cols-2`}>
              <button onClick={onChooseModel} className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-[11px] font-medium text-white transition active:scale-95">
                <FileZip size={15} weight="bold" /> VRM / L2D ZIP
              </button>
              <button onClick={onChooseLive2DFolder} className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-[11px] font-medium text-white transition active:scale-95">
                <FolderOpen size={15} weight="bold" /> L2D 整个文件夹
              </button>
              <p className="col-span-full text-[9px] leading-relaxed text-white/35">文件夹导入要选择包含 model3.json 的整个文件夹，不要只点 model3.json。</p>
            </div>
          ) : (
            <button onClick={onChooseModel} className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-medium text-white transition active:scale-95">
              <UploadSimple size={15} weight="bold" /> 导入模型
            </button>
          )}
        </div>
      )}

      {showCropGuide && hasRenderableModel && (
        <div
          className="pointer-events-none absolute z-[26] border border-dashed border-white/70"
          style={{
            inset: cropInset,
            borderRadius: '1.4rem',
            boxShadow: `0 0 0 999px rgba(3,4,9,.34), inset 0 0 0 1px ${accentColor}88`,
          }}
          data-testid="companion-crop-guide"
          aria-hidden
        >
          <span className="absolute -left-px -top-px h-5 w-5 rounded-tl-[1.4rem] border-l-2 border-t-2" style={{ borderColor: accentColor }} />
          <span className="absolute -right-px -top-px h-5 w-5 rounded-tr-[1.4rem] border-r-2 border-t-2" style={{ borderColor: accentColor }} />
          <span className="absolute -bottom-px -left-px h-5 w-5 rounded-bl-[1.4rem] border-b-2 border-l-2" style={{ borderColor: accentColor }} />
          <span className="absolute -bottom-px -right-px h-5 w-5 rounded-br-[1.4rem] border-b-2 border-r-2" style={{ borderColor: accentColor }} />
          <span className="absolute left-3 top-3 rounded-full border border-white/20 bg-black/55 px-2 py-1 text-[8px] tracking-[0.14em] text-white/75 backdrop-blur">角色可视区</span>
        </div>
      )}

      {modelLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="max-w-[19rem] px-5 text-center text-white/70">
            <span className="mx-auto mb-3 block h-7 w-7 animate-spin rounded-full border-2 border-white/15 border-t-white/80" />
            <div className="text-xs leading-relaxed">{modelLoadingStage}</div>
            <div className="mt-2 text-[9px] leading-relaxed text-white/35">大模型第一次读取会比较慢。看到这个提示时请继续等待，不要重复点击导入或退出通话。</div>
          </div>
        </div>
      )}

      {!companionMode && <div className="absolute left-3 top-3 z-30 flex items-center gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 backdrop-blur-md">
        <span className={`h-1.5 w-1.5 rounded-full ${motionState === 'speaking' ? 'animate-pulse' : ''}`} style={{ background: accentColor, boxShadow: `0 0 8px ${accentColor}` }} />
        <span className="text-[10px] tracking-[0.14em] text-white/65">{stateLabel(motionState)}</span>
      </div>}

      {!companionMode && hasRenderableModel && !modelLoading && calibratingFace && (
        <div className="absolute inset-x-3 top-12 z-40 rounded-2xl border border-amber-200/25 bg-black/55 px-3 py-2 backdrop-blur-md">
          <div className="text-[10px] leading-relaxed text-amber-100/90">
            锚定脸部：拖动 / 缩放，把<b>脸</b>摆到画面中心的理想特写位置，之后 AI 拉近镜头都会精确落到这里。
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button onClick={() => endFaceCalibration(true)} className="rounded-full bg-amber-300/25 border border-amber-200/40 px-3 py-1 text-[10px] font-medium text-amber-50 active:scale-95">
              保存锚点
            </button>
            <button onClick={() => endFaceCalibration(false)} className="rounded-full border border-white/15 px-3 py-1 text-[10px] text-white/60 active:scale-95">
              取消
            </button>
            {model?.faceFraming && (
              <button onClick={() => endFaceCalibration(false, true)} className="ml-auto px-2 py-1 text-[10px] text-rose-300/75 active:scale-95">
                清除锚点
              </button>
            )}
          </div>
        </div>
      )}

      {!companionMode && hasRenderableAvatar && !modelLoading && !calibratingFace && (
        <div className="absolute right-3 top-3 z-40 flex flex-col items-end">
          <button
            onClick={() => setStageToolsOpen(open => !open)}
            className={`flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur-md transition active:scale-90 ${stageToolsOpen ? 'border-white/20 bg-white/15 text-white' : 'border-white/10 bg-black/35 text-white/65'}`}
            title={stageToolsOpen ? '收起舞台工具' : '舞台工具'}
            aria-expanded={stageToolsOpen}
          >
            <SlidersHorizontal size={16} weight="bold" />
          </button>

          {stageToolsOpen && (
            <div className="mt-2 w-[13.5rem] overflow-hidden rounded-2xl border border-white/10 bg-[#090a10]/90 px-3 py-2.5 shadow-2xl backdrop-blur-xl">
              <div className="flex items-center justify-between border-b border-white/[0.07] pb-2">
                <div>
                  <div className="text-[10px] font-medium text-white/75">舞台工具</div>
                  <div className="mt-0.5 max-w-[10rem] truncate text-[8px] text-white/28">{model?.fileName}</div>
                </div>
                <span className="text-[8px] text-white/25">直接拖动角色可调构图</span>
              </div>

              <div className="divide-y divide-white/[0.06]">
                {onConfigureBackground && (
                  <button
                    onClick={() => { setStageToolsOpen(false); onConfigureBackground(); }}
                    className="flex w-full items-center gap-2.5 py-2.5 text-left text-[10px] text-white/62 active:text-white"
                  >
                    <ImageSquare size={14} weight="fill" className="text-white/35" />
                    <span className="flex-1">更换舞台背景</span>
                  </button>
                )}
                {!staticAvatarActive && (
                  <button
                    onClick={() => { setStageToolsOpen(false); beginFaceCalibration(); }}
                    className="flex w-full items-center gap-2.5 py-2.5 text-left text-[10px] text-white/62 active:text-white"
                  >
                    <span className={`flex w-3.5 justify-center text-xs ${model?.faceFraming ? 'text-amber-200' : 'text-white/35'}`}>◎</span>
                    <span className="flex-1">{model?.faceFraming ? '重新锚定脸部' : '锚定脸部特写'}</span>
                    {model?.faceFraming && <span className="text-[8px] text-amber-200/55">已设置</span>}
                  </button>
                )}
                {!staticAvatarActive && framingAdjusted && (
                  <button
                    onClick={() => { resetFraming(); setStageToolsOpen(false); }}
                    className="flex w-full items-center gap-2.5 py-2.5 text-left text-[10px] text-white/62 active:text-white"
                  >
                    <ArrowsOutCardinal size={14} weight="bold" className="text-white/35" />
                    <span className="flex-1">恢复默认构图</span>
                  </button>
                )}
                {model?.format === 'live2d' && onConfigureActions && (
                  <button
                    onClick={() => { setStageToolsOpen(false); onConfigureActions(); }}
                    className="flex w-full items-center gap-2.5 py-2.5 text-left text-[10px] text-white/62 active:text-white"
                  >
                    <SlidersHorizontal size={14} weight="bold" className="text-white/35" />
                    <span className="flex-1">动作与参数</span>
                    <span className="text-[8px] text-white/25">高级</span>
                  </button>
                )}
                {model?.format === 'live2d' && model.actions.some(action => action.permission !== 'blocked' && !action.wardrobe) && (
                  <button
                    onClick={() => { toggleActionChips(); setStageToolsOpen(false); }}
                    data-live2d-chips-toggle
                    className="flex w-full items-center gap-2.5 py-2.5 text-left text-[10px] text-white/62 active:text-white"
                  >
                    <Play size={13} weight="fill" className="text-white/35" />
                    <span className="flex-1">{actionChipsOpen ? '收起手动动作' : '展开手动动作'}</span>
                    <span className="text-[8px] text-white/25">{model.actions.filter(action => action.permission !== 'blocked' && !action.wardrobe).length}</span>
                  </button>
                )}
                <button
                  onClick={() => { setStageToolsOpen(false); onChooseModel(); }}
                  className="flex w-full items-center gap-2.5 py-2.5 text-left text-[10px] text-white/62 active:text-white"
                >
                  <UploadSimple size={14} weight="bold" className="text-white/35" />
                  <span className="flex-1">更换角色形象</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {!companionMode && actionChipsOpen && model?.format === 'live2d' && model.actions.some(action => action.permission !== 'blocked' && !action.wardrobe) && (
        <div className="absolute inset-x-3 bottom-3 z-30 flex items-center gap-1.5">
          <button
            onClick={toggleActionChips}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white/55 backdrop-blur-md active:scale-95"
            title="收起手动动作"
          >
            <CaretDown size={10} weight="bold" />
          </button>
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
            {model.actions.filter(action => action.permission !== 'blocked' && !action.wardrobe).map(action => (
              <button
                key={action.id}
                data-live2d-manual-action={action.id}
                onClick={() => setManualAction({ id: action.id, nonce: Date.now() + Math.random() })}
                className="flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[9px] text-white/65 backdrop-blur-md transition active:scale-95"
                title={`${action.permission === 'ai' ? 'AI 可用 / ' : '仅手动 / '}${action.kind === 'motion' ? '动作' : action.kind === 'params' ? '参数动作' : '表情'}`}
              >
                <Play size={9} weight="fill" /> {action.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {modelError && (
        <div className="absolute inset-x-3 bottom-3 z-40 flex items-center gap-2 rounded-xl border border-rose-300/20 bg-rose-950/80 px-3 py-2 text-[10px] text-rose-100 backdrop-blur-md">
          <WarningCircle size={14} weight="fill" className="shrink-0" />
          <span className="line-clamp-2">{modelError}</span>
        </div>
      )}
    </div>
  );
};

export default VRMVideoCallStage;
