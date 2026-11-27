import { canPlayLive2DAction, installLive2DIdlePolicy, live2DPermissionSignature, live2DProceduralRestrictions } from '../../utils/live2dActionPolicy';
import { revealLive2DAfterPaint } from '../../utils/live2DReveal';
import React, { useEffect, useRef, useState } from 'react';
import { ModelPlacement } from './RolePlacement';
import type { CallRolePlacement } from '../../types';
import { Application, Assets, Cache, extensions } from 'pixi.js';
import { AvatarAutonomy, getViewerEyeContactCompensation } from '../../utils/avatarAutonomy';
import { DEFAULT_AVATAR_PERFORMANCE, type AvatarPerformanceDirection, type AvatarStageFraming } from '../../utils/avatarPerformance';
import type { CallAudioFeed } from '../../utils/callAudioFeed';
import { isDevDebugAvailable } from '../../utils/devDebug';
import {
  combineLive2DMouthForm,
  DEFAULT_LIVE2D_MOUTH_FORM_PARAMETER,
  DEFAULT_LIVE2D_MOUTH_OPEN_PARAMETER,
  resolveLive2DMouthFrame,
  splitLive2DLipSyncParameters,
} from '../../utils/live2dLipSync';
import {
  bridgeCubism6RenderOrders,
  enableCubism5HighPrecisionMasks,
  ensureLive2DCubismCore,
  preloadLive2DRuntime,
} from '../../utils/live2dCore';
import {
  buildLive2DPerformanceMix,
  findLive2DActionsForPerformance,
  getActiveLive2DWardrobeParameters,
  loadLive2DModelSource,
  type Live2DAction,
  type Live2DActionParameterValue,
  type Live2DAvatarConfig,
} from '../../utils/live2dModelStore';
import type { AvatarMotionState } from './VRMAvatarCanvas';
import {
  avatarTouchZoneToastLabel,
  resolveAvatarTouchRegion,
  resolveAvatarTouchTarget,
  type AvatarTouchHit,
  type AvatarTouchRequest,
  type AvatarTouchZone,
} from '../../utils/avatarTouch';
import type { AvatarTouchRegion } from '../../types';

export interface Live2DActionTrigger {
  id: string;
  nonce: number;
}

/** 模型的可调参数元数据（VTS 风格自定义参数动作编辑器用）。 */
export interface Live2DParameterInfo {
  id: string;
  min: number;
  max: number;
  defaultValue: number;
}

interface Live2DAvatarCanvasProps {
  config: Live2DAvatarConfig;
  motionState: AvatarMotionState;
  audioFeed?: CallAudioFeed;
  /** Absolute runtime lock; used for the whole companion startup utterance. */
  headMotionLocked?: boolean;
  /** Companion desktop must not inherit the video-call random pose generator. */
  ambientAutonomyDisabled?: boolean;
  /** 优先于 config.framing 的实时构图（舞台拖拽/设置面板滑杆的即时预览）。 */
  framing?: AvatarStageFraming;
  /** 用户锚定的脸部特写构图；close/push-in 时镜头直接落到这里。 */
  faceFraming?: AvatarStageFraming;
  performance?: AvatarPerformanceDirection;
  /** 高质量模式才启用保守的多层动作混合；基础/手动播放路径保持原样。 */
  performanceQuality?: 'basic' | 'high';
  manualAction?: Live2DActionTrigger | null;
  /** Keep the user's selected wardrobe expression as a persistent parameter layer. */
  preserveActiveWardrobe?: boolean;
  onLoadingChange?: (loading: boolean, stage?: string) => void;
  onError?: (message: string) => void;
  onReady?: () => void;
  /** 提供透明背景的当前姿态快照；卸载时清空，供相机贴纸使用。 */
  onSnapshotReady?: (capture: (() => HTMLCanvasElement) | null) => void;
  touchRequest?: AvatarTouchRequest | null;
  touchImpulseNonce?: number;
  onAvatarTouch?: (hit: AvatarTouchHit) => void;
  /** Optional draft override while editing; otherwise config.touchRegions is used. */
  touchRegions?: AvatarTouchRegion[];
  /** Enables model-local ellipse drawing for one reaction zone. */
  touchRegionEditingZone?: AvatarTouchZone;
  onTouchRegionsChange?: (regions: AvatarTouchRegion[]) => void;
  /** Desktop companion mode caps rendering work while preserving interaction. */
  maxFps?: number;
  /** Pins parameters to target values while the advanced editor shows its target state. */
  parameterPreview?: Array<{ id: string; value: number }> | null;
  /** 模型加载完成后回传参数列表（id / 范围 / 默认值），供设置面板做参数动作编辑。 */
  onParametersDiscovered?: (parameters: Live2DParameterInfo[]) => void;
}

let live2DPluginRegistered = false;
const registerLive2DPlugin = (plugin: Parameters<typeof extensions.add>[0]) => {
  if (live2DPluginRegistered) return;
  extensions.add(plugin);
  live2DPluginRegistered = true;
};

const clamp = (value: number, min = -1, max = 1): number => Math.max(min, Math.min(max, value));
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const TOUCH_REGION_COLORS: Record<AvatarTouchZone, string> = {
  head: '#f5c86a',
  face: '#ff8fb7',
  hand: '#77d9dd',
  body: '#9ba8ff',
  other: '#c6cbd5',
};
const HEAD_LOCK_PARAMETER_IDS = [
  'xin', 'yin', 'zin',
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
] as const;
const LIVE2D_HEAD_AXIS_SCALE = { x: 22, y: 16, z: 14 } as const;
const LIVE2D_BODY_AXIS_SCALE = { x: 12, y: 14, z: 12 } as const;
const LIVE2D_VTUBE_BODY_GAIN = 1.18;
const isHeadLockParameter = (id: string): boolean => (
  /^(?:x|y|z)in$/i.test(id)
  || /^(?:Param)?(?:Head)?Angle[XYZ]$/i.test(id)
  || /^ParamHead[XYZ]$/i.test(id)
);

type DirectedHeadControl = {
  enabled: boolean;
  authoredEnabled: boolean;
  motionOwnsHead: boolean;
  paramsOwnHead: boolean;
};

/**
 * Companion mode suppresses ambient head autonomy, but authored directions are
 * still allowed to move the head. Explicit model motions own their head curves;
 * precision/gaze/head gestures remain deterministic through AvatarAutonomy.
 */
const getDirectedHeadControl = (
  direction: AvatarPerformanceDirection | undefined,
  config: Live2DAvatarConfig,
): DirectedHeadControl => {
  if (!direction) return {
    enabled: false,
    authoredEnabled: false,
    motionOwnsHead: false,
    paramsOwnHead: false,
  };
  const requestedIds = new Set([
    ...(direction.modelActions || []),
    direction.modelAction,
  ].filter((id): id is string => Boolean(id)));
  const requestedActions = config.actions.filter(action => requestedIds.has(action.id));
  const motionOwnsHead = requestedActions.some(action => action.kind === 'motion');
  const paramsOwnHead = requestedActions.some(action => (
    action.kind === 'params'
    && (action.params || []).some(param => isHeadLockParameter(param.id))
  ));
  // Saved startup poses commonly contain explicit zeroes. Zero means "stay
  // centered", not "release the head lock for the entire sentence".
  const precisionOwnsHead = [
    direction.precision?.headX,
    direction.precision?.headY,
    direction.precision?.headZ,
  ].some(value => typeof value === 'number' && Math.abs(value) > 0.001);
  const gestureOwnsHead = direction.gesture === 'nod'
    || direction.gesture === 'shake'
    || direction.gesture === 'tilt';
  const gazeOwnsHead = direction.gaze !== 'viewer';
  const authoredEnabled = precisionOwnsHead || gestureOwnsHead || gazeOwnsHead;
  return {
    enabled: motionOwnsHead || paramsOwnHead || authoredEnabled,
    authoredEnabled,
    motionOwnsHead,
    paramsOwnHead,
  };
};

type DirectedHeadMotionLease = {
  channel: 'pending' | 'parallel' | 'main';
  startedAt: number;
  expiresAt: number;
};

type Live2DModelLike = {
  expression: (id?: number | string) => Promise<boolean>;
  motion: (group: string, index?: number, priority?: number, options?: { loop?: boolean }) => Promise<boolean>;
  parallelMotion?: (motions: Array<{
    group: string;
    index: number;
    priority?: number;
    ignoreParamIds?: string[];
    loop?: boolean;
  }>) => Promise<boolean[]>;
  internalModel?: {
    motionManager?: { expressionManager?: { resetExpression?: () => void } };
  };
};

const playAction = async (model: Live2DModelLike, action: Live2DAction): Promise<void> => {
  if (action.kind === 'expression') {
    if (action.resetExpression) {
      model.internalModel?.motionManager?.expressionManager?.resetExpression?.();
      return;
    }
    await model.expression(action.expressionId || action.name);
    return;
  }
  if (!action.group || action.index === undefined) return;
  await model.motion(action.group, action.index, 3, { loop: false });
};

interface TextureLease {
  users: number;
  cleanupTimer: number | null;
}

const textureLeases = new Map<string, TextureLease>();

export const isMobileLive2DRuntime = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (nav.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)) return true;
  return nav.maxTouchPoints > 1
    && typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches;
};

export const getLive2DCubismMemorySizeMB = (mobile = isMobileLive2DRuntime()): number => mobile ? 32 : 64;
export const getLive2DTextureReleaseDelayMs = (mobile = isMobileLive2DRuntime()): number => mobile ? 1_000 : 8_000;

const isUsableLive2DTexture = (texture: any): boolean => Boolean(
  texture?.source
  && !texture.destroyed
  && !texture.source.destroyed,
);

const resetInvalidLive2DTextureAsset = async (url: string): Promise<void> => {
  try {
    await Assets.unload(url);
  } catch {
    if (Cache.has(url)) Cache.remove(url);
  }
  if (Assets.resolver.hasKey(url)) Assets.resolver.removeAlias(url);
};

export const prepareLive2DTextureAssets = async (urls: string[]): Promise<void> => {
  await Promise.all(urls.map(async (url, index) => {
    const cached = Cache.has(url) ? Cache.get<any>(url) : null;
    if (isUsableLive2DTexture(cached)) return;
    if (Cache.has(url) || Assets.resolver.hasKey(url)) {
      await resetInvalidLive2DTextureAsset(url);
    }

    // Blob URLs have no path extension. Pixi's automatic parser detection
    // therefore returns null even when a filename is placed in the fragment,
    // because its path helper strips `#...` first. Pin the parser explicitly.
    Assets.add({
      alias: url,
      src: url,
      parser: 'texture',
      data: { autoGenerateMipmaps: false },
    });
    const texture = await Assets.load<any>(url);
    if (isUsableLive2DTexture(texture)) return;

    await resetInvalidLive2DTextureAsset(url);
    throw new Error(`Live2D 贴图 ${index + 1} 解码失败，渲染器未返回有效纹理。`);
  }));
};

const acquireTextureLeases = (urls: string[]) => {
  urls.forEach(url => {
    const lease = textureLeases.get(url) || { users: 0, cleanupTimer: null };
    if (lease.users === 0 && Cache.has(url)) {
      const cached = Cache.get<any>(url);
      if (cached?.destroyed || cached?.source?.destroyed) Cache.remove(url);
    }
    lease.users += 1;
    if (lease.cleanupTimer !== null) {
      window.clearTimeout(lease.cleanupTimer);
      lease.cleanupTimer = null;
    }
    textureLeases.set(url, lease);
  });
};

const releaseTextureLeases = (urls: string[]) => {
  urls.forEach(url => {
    const lease = textureLeases.get(url);
    if (!lease) return;
    lease.users = Math.max(0, lease.users - 1);
    if (lease.users > 0 || lease.cleanupTimer !== null) return;
    // Keep the decoded texture only briefly across preview -> stage transitions.
    // A 30-second grace period used to retain every recently opened atlas and
    // could exhaust a mobile WebView after switching models a few times. Must go through
    // Assets.unload：手动 destroy 只清 Cache，Assets 的 promise 缓存还留着，
    // 下次同一 URL 会拿到已销毁的贴图。
    lease.cleanupTimer = window.setTimeout(() => {
      if (lease.users > 0) return;
      void Assets.unload(url).catch(() => {
        if (Cache.has(url)) {
          const texture = Cache.get<any>(url);
          Cache.remove(url);
          texture?.destroy?.(true);
        }
      });
      textureLeases.delete(url);
    }, getLive2DTextureReleaseDelayMs());
  });
};

const Live2DAvatarCanvas: React.FC<Live2DAvatarCanvasProps> = ({
  config,
  motionState,
  audioFeed,
  headMotionLocked = false,
  ambientAutonomyDisabled = false,
  framing,
  faceFraming,
  performance,
  performanceQuality = 'basic',
  manualAction,
  preserveActiveWardrobe = false,
  onLoadingChange,
  onError,
  onReady,
  onSnapshotReady,
  touchRequest,
  touchImpulseNonce,
  onAvatarTouch,
  touchRegions,
  touchRegionEditingZone,
  onTouchRegionsChange,
  maxFps,
  parameterPreview,
  onParametersDiscovered,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const placement = React.useContext(ModelPlacement);
  const modelRef = useRef<(Live2DModelLike & any) | null>(null);
  const motionStateRef = useRef(motionState);
  const audioFeedRef = useRef(audioFeed);
  const headMotionLockedRef = useRef(headMotionLocked);
  const ambientAutonomyDisabledRef = useRef(ambientAutonomyDisabled);
  const configRef = useRef(config);
  const performanceRef = useRef(performance);
  const touchImpulseNonceRef = useRef(touchImpulseNonce);
  const performanceQualityRef = useRef(performanceQuality);
  const actionParameterIdsRef = useRef<Record<string, string[]>>({});
  const actionParameterValuesRef = useRef<Record<string, Live2DActionParameterValue[]>>({});
  const proceduralRestrictionsRef = useRef(live2DProceduralRestrictions(config));
  const preserveActiveWardrobeRef = useRef(preserveActiveWardrobe);
  const onLoadingChangeRef = useRef(onLoadingChange);
  const onErrorRef = useRef(onError);
  const onReadyRef = useRef(onReady);
  const onSnapshotReadyRef = useRef(onSnapshotReady);
  const onAvatarTouchRef = useRef(onAvatarTouch);
  const touchRegionsRef = useRef<AvatarTouchRegion[]>(touchRegions ?? config.touchRegions ?? []);
  const onTouchRegionsChangeRef = useRef(onTouchRegionsChange);
  const onParametersDiscoveredRef = useRef(onParametersDiscovered);
  const parameterPreviewRef = useRef(parameterPreview);
  // 进行中的参数动作叠加（kind='params'）：短暂把一组参数推到目标值再淡出。
  const paramOverlaysRef = useRef<Array<{ params: Array<{ id: string; value: number }>; startedAt: number }>>([]);
  const directedHeadMotionLeaseRef = useRef<DirectedHeadMotionLease | null>(null);
  const directedHeadPoseRef = useRef<{ headX: number; headY: number; headZ: number } | null>(null);
  const framingRef = useRef(framing || config.framing || { scale: 1, offsetX: 0, offsetY: 0 });
  const faceFramingRef = useRef<AvatarStageFraming | undefined>(faceFraming || config.faceFraming);
  const [touchRegionBounds, setTouchRegionBounds] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const touchRegionBoundsRef = useRef<typeof touchRegionBounds>(null);
  const [drawingTouchRegion, setDrawingTouchRegion] = useState<AvatarTouchRegion | null>(null);
  const touchRegionPointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const aiExpressionActiveRef = useRef(false);
  const pointerRef = useRef({ x: 0, y: 0, active: false, lastMoved: 0 });
  const lipSyncKey = config.lipSyncParameterIds.join('\u0000');

  const isDirectedHeadMotionActive = (now: number): boolean => {
    const lease = directedHeadMotionLeaseRef.current;
    if (!lease) return false;
    if (now >= lease.expiresAt) {
      directedHeadMotionLeaseRef.current = null;
      return false;
    }
    // Give a freshly requested motion a brief setup window before its manager
    // publishes running state.
    if (lease.channel === 'pending' || now - lease.startedAt < 120) return true;
    const internal = (modelRef.current as any)?.internalModel;
    const managers = lease.channel === 'parallel'
      ? (Array.isArray(internal?.parallelMotionManager) ? internal.parallelMotionManager : [])
      : internal?.motionManager ? [internal.motionManager] : [];
    const inspectable = managers.filter((manager: any) => typeof manager?.isFinished === 'function');
    if (!inspectable.length) return true;
    const active = inspectable.some((manager: any) => !manager.isFinished());
    if (!active) directedHeadMotionLeaseRef.current = null;
    return active;
  };

  const plannedHead = useRef<{ direction?: AvatarPerformanceDirection; config: Live2DAvatarConfig; result: DirectedHeadControl }>();
  const getRuntimeDirectedHeadControl = (
    direction: AvatarPerformanceDirection | undefined,
    now: number,
  ): DirectedHeadControl => {
    if (!plannedHead.current || plannedHead.current.direction !== direction || plannedHead.current.config !== configRef.current) {
      plannedHead.current = { direction, config: configRef.current, result: getDirectedHeadControl(direction, configRef.current) };
    }
    const planned = plannedHead.current.result;
    const motionOwnsHead = isDirectedHeadMotionActive(now);
    const paramsOwnHead = paramOverlaysRef.current.some(overlay => (
      now - overlay.startedAt < 4_100
      && overlay.params.some(param => isHeadLockParameter(param.id))
    ));
    return {
      enabled: planned.authoredEnabled || motionOwnsHead || paramsOwnHead,
      authoredEnabled: planned.authoredEnabled,
      motionOwnsHead,
      paramsOwnHead,
    };
  };

  useEffect(() => { motionStateRef.current = motionState; }, [motionState]);
  useEffect(() => { audioFeedRef.current = audioFeed; }, [audioFeed]);
  useEffect(() => { headMotionLockedRef.current = headMotionLocked; }, [headMotionLocked]);
  useEffect(() => { ambientAutonomyDisabledRef.current = ambientAutonomyDisabled; }, [ambientAutonomyDisabled]);
  useEffect(() => {
    const changed = live2DPermissionSignature(configRef.current.actions) !== live2DPermissionSignature(config.actions);
    configRef.current = config;
    proceduralRestrictionsRef.current = live2DProceduralRestrictions(config, actionParameterIdsRef.current);
    if (changed) {
      stopPerformanceMotions();
      modelRef.current?.internalModel?.motionManager?.expressionManager?.resetExpression?.();
      aiExpressionActiveRef.current = false;
    }
  }, [config]);
  useEffect(() => { performanceRef.current = performance; }, [performance]);
  useEffect(() => { touchImpulseNonceRef.current = touchImpulseNonce; }, [touchImpulseNonce]);
  useEffect(() => { performanceQualityRef.current = performanceQuality; }, [performanceQuality]);
  useEffect(() => { preserveActiveWardrobeRef.current = preserveActiveWardrobe; }, [preserveActiveWardrobe]);
  useEffect(() => { onLoadingChangeRef.current = onLoadingChange; }, [onLoadingChange]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onSnapshotReadyRef.current = onSnapshotReady; }, [onSnapshotReady]);
  useEffect(() => { onAvatarTouchRef.current = onAvatarTouch; }, [onAvatarTouch]);
  useEffect(() => { touchRegionsRef.current = touchRegions ?? config.touchRegions ?? []; }, [touchRegions, config.touchRegions]);
  useEffect(() => { onTouchRegionsChangeRef.current = onTouchRegionsChange; }, [onTouchRegionsChange]);
  useEffect(() => { onParametersDiscoveredRef.current = onParametersDiscovered; }, [onParametersDiscovered]);
  useEffect(() => { parameterPreviewRef.current = parameterPreview; }, [parameterPreview]);
  useEffect(() => {
    framingRef.current = framing || config.framing || { scale: 1, offsetX: 0, offsetY: 0 };
    if (hostRef.current) hostRef.current.dataset.live2dFraming = JSON.stringify(framingRef.current);
  }, [framing, config.framing]);
  useEffect(() => {
    faceFramingRef.current = faceFraming || config.faceFraming;
  }, [faceFraming, config.faceFraming]);

  useEffect(() => {
    if (!touchRegionEditingZone) {
      touchRegionBoundsRef.current = null;
      setTouchRegionBounds(null);
      setDrawingTouchRegion(null);
      touchRegionPointerRef.current = null;
      return;
    }
    let frame = 0;
    const updateBounds = () => {
      const bounds = (modelRef.current as any)?.getBounds?.();
      if (bounds?.width > 0 && bounds?.height > 0) {
        const next = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        const previous = touchRegionBoundsRef.current;
        if (
          !previous
          || Math.abs(previous.x - next.x) > 0.5
          || Math.abs(previous.y - next.y) > 0.5
          || Math.abs(previous.width - next.width) > 0.5
          || Math.abs(previous.height - next.height) > 0.5
        ) {
          touchRegionBoundsRef.current = next;
          setTouchRegionBounds(next);
        }
      }
      frame = window.requestAnimationFrame(updateBounds);
    };
    frame = window.requestAnimationFrame(updateBounds);
    return () => window.cancelAnimationFrame(frame);
  }, [touchRegionEditingZone, config.assetId]);

  const touchRegionPoint = (event: React.PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const host = hostRef.current;
    const bounds = touchRegionBoundsRef.current;
    if (!host || !bounds?.width || !bounds.height) return null;
    const rect = host.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left - bounds.x) / bounds.width),
      y: clamp01((event.clientY - rect.top - bounds.y) / bounds.height),
    };
  };

  const draftTouchRegion = (
    zone: AvatarTouchZone,
    startX: number,
    startY: number,
    currentX: number,
    currentY: number,
  ): AvatarTouchRegion => ({
    id: '__drawing__',
    zone,
    shape: 'ellipse',
    x: (Math.min(startX, currentX) + Math.max(startX, currentX)) / 2,
    y: (Math.min(startY, currentY) + Math.max(startY, currentY)) / 2,
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY),
  });

  const handleTouchRegionPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!touchRegionEditingZone || (event.button !== 0 && event.pointerType === 'mouse')) return;
    const point = touchRegionPoint(event);
    const bounds = touchRegionBoundsRef.current;
    const host = hostRef.current?.getBoundingClientRect();
    if (!point || !bounds || !host) return;
    const localX = event.clientX - host.left;
    const localY = event.clientY - host.top;
    if (localX < bounds.x || localX > bounds.x + bounds.width || localY < bounds.y || localY > bounds.y + bounds.height) return;
    touchRegionPointerRef.current = {
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
    };
    setDrawingTouchRegion(draftTouchRegion(touchRegionEditingZone, point.x, point.y, point.x, point.y));
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleTouchRegionPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const pointer = touchRegionPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId || !touchRegionEditingZone) return;
    const point = touchRegionPoint(event);
    if (!point) return;
    pointer.currentX = point.x;
    pointer.currentY = point.y;
    setDrawingTouchRegion(draftTouchRegion(
      touchRegionEditingZone,
      pointer.startX,
      pointer.startY,
      pointer.currentX,
      pointer.currentY,
    ));
  };

  const finishTouchRegion = (event: React.PointerEvent<HTMLDivElement>, save: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    const pointer = touchRegionPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId || !touchRegionEditingZone) return;
    const point = touchRegionPoint(event);
    if (point) {
      pointer.currentX = point.x;
      pointer.currentY = point.y;
    }
    const draft = draftTouchRegion(
      touchRegionEditingZone,
      pointer.startX,
      pointer.startY,
      pointer.currentX,
      pointer.currentY,
    );
    touchRegionPointerRef.current = null;
    setDrawingTouchRegion(null);
    if (!save || draft.width < 0.025 || draft.height < 0.025) return;
    const region: AvatarTouchRegion = {
      ...draft,
      id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `touch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    };
    const next = [...touchRegionsRef.current, region];
    touchRegionsRef.current = next;
    onTouchRegionsChangeRef.current?.(next);
  };

  useEffect(() => {
    if (!touchRequest) return;
    const model = modelRef.current as any;
    if (!model) return;
    let rawAreas: string[] = [];
    try {
      const hits = model.hitTest?.(touchRequest.x, touchRequest.y);
      if (Array.isArray(hits)) rawAreas = hits.filter((item: unknown): item is string => typeof item === 'string');
    } catch { /* bounds fallback below */ }
    let fallbackX = touchRequest.normalizedX;
    let fallbackY = touchRequest.normalizedY;
    let insideBounds = rawAreas.length > 0;
    try {
      const bounds = model.getBounds?.();
      if (bounds?.width > 0 && bounds?.height > 0) {
        insideBounds = insideBounds || (
          touchRequest.x >= bounds.x
          && touchRequest.x <= bounds.x + bounds.width
          && touchRequest.y >= bounds.y
          && touchRequest.y <= bounds.y + bounds.height
        );
        fallbackX = (touchRequest.x - bounds.x) / bounds.width;
        fallbackY = (touchRequest.y - bounds.y) / bounds.height;
      }
    } catch { /* ignore invalid first-frame bounds */ }
    if (!insideBounds) return;
    const customTarget = resolveAvatarTouchRegion(touchRegionsRef.current, fallbackX, fallbackY);
    const target = customTarget
      ? { zone: customTarget.zone, part: customTarget.part }
      : resolveAvatarTouchTarget(rawAreas, fallbackY, fallbackX);
    onAvatarTouchRef.current?.({
      ...touchRequest,
      ...target,
      source: customTarget ? 'live2d-custom-region' : rawAreas.length ? 'live2d-hit-area' : 'live2d-bounds',
      rawAreas: customTarget ? [`custom:${customTarget.regionId}`, ...rawAreas] : rawAreas,
    });
  }, [touchRequest]);

  // kind='params' 的自定义参数动作不走引擎的 motion/expression 通道，
  // 而是推进叠加队列，由 applyControls 按攻击-保持-衰减包络逐帧写参数。
  const triggerAction = (action: Live2DAction, allowDirectedHead = false, manual = false): Promise<void> => {
    if (!canPlayLive2DAction(configRef.current, action.id, manual)) return Promise.resolve();
    if (action.kind === 'params') {
      const params = headMotionLockedRef.current && !allowDirectedHead
        ? action.params?.filter(param => !isHeadLockParameter(param.id))
        : action.params;
      if (params?.length) {
        paramOverlaysRef.current.push({ params, startedAt: window.performance.now() });
      }
      return Promise.resolve();
    }
    const model = modelRef.current;
    return model ? playAction(model, action) : Promise.resolve();
  };

  const stopPerformanceMotions = () => {
    const model = modelRef.current as any;
    if (!model) return;
    try { model.stopMotions?.(); } catch { /* optional runtime API */ }
    const parallelManagers = model.internalModel?.parallelMotionManager;
    if (Array.isArray(parallelManagers)) {
      parallelManagers.forEach((manager: any) => {
        try { manager?.stopAllMotions?.(); } catch { /* optional layer */ }
      });
    }
    paramOverlaysRef.current = [];
    directedHeadMotionLeaseRef.current = null;
  };

  const triggerPerformance = async (direction: AvatarPerformanceDirection): Promise<void> => {
    if (ambientAutonomyDisabledRef.current && motionStateRef.current === 'idle') {
      stopPerformanceMotions();
      return;
    }
    const model = modelRef.current;
    if (!model) return;
    const host = hostRef.current;
    const directedHead = getDirectedHeadControl(direction, configRef.current);
    if (performanceQualityRef.current !== 'high') {
      const actions = findLive2DActionsForPerformance(configRef.current, direction);
      host?.setAttribute('data-live2d-mix-mode', 'basic');
      actions.forEach(action => {
        if (host) host.dataset.live2dLastAction = action.id;
        if (action.kind === 'expression') aiExpressionActiveRef.current = true;
        if (directedHead.motionOwnsHead && action.kind === 'motion') {
          const now = window.performance.now();
          directedHeadMotionLeaseRef.current = {
            channel: 'main',
            startedAt: now,
            expiresAt: now + 5_000,
          };
        }
        void triggerAction(action, directedHead.enabled).catch(() => { /* optional actions stay non-fatal */ });
      });
      return;
    }

    const mix = buildLive2DPerformanceMix(
      configRef.current,
      direction,
      actionParameterIdsRef.current,
    );
    const planned = [mix.expression, ...mix.motions, ...mix.params]
      .filter((action): action is Live2DAction => Boolean(action));
    if (host) {
      host.dataset.live2dMixMode = 'layered';
      host.dataset.live2dLastAction = planned.map(action => action.id).join(',');
      host.dataset.live2dMotionLayers = String(mix.motions.length);
    }

    if (mix.motions.length) {
      const motionLeaseStartedAt = window.performance.now();
      if (directedHead.motionOwnsHead) {
        directedHeadMotionLeaseRef.current = {
          channel: 'pending',
          startedAt: motionLeaseStartedAt,
          expiresAt: motionLeaseStartedAt + 5_000,
        };
      }
      const motionItems = mix.motions
        .filter(action => action.group && action.index !== undefined)
        .map(action => ({
          group: action.group!,
          index: action.index!,
          priority: 3,
          loop: false,
          // The call stage owns gaze and lip sync. Keeping motion files away from
          // these channels prevents parallel managers from fighting the audio and
          // pointer controllers while leaving head/body/physics animation intact.
          ignoreParamIds: [...new Set([
            ...configRef.current.lipSyncParameterIds,
            DEFAULT_LIVE2D_MOUTH_OPEN_PARAMETER,
            DEFAULT_LIVE2D_MOUTH_FORM_PARAMETER,
            'ParamEyeBallX',
            'ParamEyeBallY',
            ...(headMotionLockedRef.current && !directedHead.enabled ? HEAD_LOCK_PARAMETER_IDS : []),
          ])],
        }));
      let started = false;
      if (motionItems.length && typeof model.parallelMotion === 'function') {
        try {
          const results = await model.parallelMotion(motionItems);
          started = results.some(Boolean);
          if (started && directedHead.motionOwnsHead && directedHeadMotionLeaseRef.current) {
            directedHeadMotionLeaseRef.current.channel = 'parallel';
          }
        } catch {
          // Older/partial runtimes take the single-motion fallback below.
        }
      }
      if (!started && mix.motions[0]) {
        if (directedHead.motionOwnsHead && directedHeadMotionLeaseRef.current) {
          directedHeadMotionLeaseRef.current.channel = 'main';
        }
        await triggerAction(mix.motions[0], directedHead.enabled);
      }
      if (!started && !mix.motions[0]) directedHeadMotionLeaseRef.current = null;
    }

    // Apply the expression after starting motions: model files are allowed to
    // reset expressions on start, so this order keeps the director's face layer.
    if (mix.expression) {
      aiExpressionActiveRef.current = true;
      await triggerAction(mix.expression, directedHead.enabled);
    }
    await Promise.all(mix.params.map(action => triggerAction(action, directedHead.enabled)));
  };

  // 只跟随导演指令（performance）触发动作，不依赖 config 对象身份——否则保存
  // 构图等任何 config 更新都会把上一条指令的动作原地重放一遍。
  useEffect(() => {
    const model = modelRef.current;
    if (!model || !performance) return;
    if (ambientAutonomyDisabled && motionState === 'idle') {
      stopPerformanceMotions();
      return;
    }
    void triggerPerformance(performance).catch(() => { /* invalid optional actions stay non-fatal */ });
  }, [performance, performanceQuality, headMotionLocked, ambientAutonomyDisabled, motionState]);

  useEffect(() => {
    if (ambientAutonomyDisabled && motionState === 'idle') stopPerformanceMotions();
  }, [ambientAutonomyDisabled, motionState]);

  useEffect(() => {
    if (motionState === 'speaking' || !aiExpressionActiveRef.current) return;
    const timer = window.setTimeout(() => {
      const manager = modelRef.current?.internalModel?.motionManager?.expressionManager;
      manager?.resetExpression?.();
      aiExpressionActiveRef.current = false;
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [motionState]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || !manualAction) return;
    const action = configRef.current.actions.find(item => item.id === manualAction.id && item.permission !== 'blocked');
    if (action) {
      if (hostRef.current) hostRef.current.dataset.live2dLastAction = action.id;
      void triggerAction(action, true, true).catch(error => onErrorRef.current?.(error instanceof Error ? error.message : '动作播放失败'));
    }
  }, [manualAction]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cancelReveal: (() => void) | undefined;
    let revealed = false;
    host.dataset.live2dReady = 'false';
    let app: Application | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let internal: any = null;
    let applyControls: (() => void) | null = null;
    let applyFinalHeadLock: (() => void) | null = null;
    let intersectionObserver: IntersectionObserver | null = null;
    let stageVisible = true;
    let cleanupPackage: (() => void) | null = null;
    let packageTextureUrls: string[] = [];
    let texturesLeased = false;
    let bootSettled = false;
    let deferredCleanupTimer: number | null = null;

    const releasePackage = () => {
      if (deferredCleanupTimer !== null) {
        window.clearTimeout(deferredCleanupTimer);
        deferredCleanupTimer = null;
      }
      const cleanup = cleanupPackage;
      cleanupPackage = null;
      cleanup?.();
    };

    const syncTickerVisibility = () => {
      if (!app) return;
      const shouldRun = document.visibilityState !== 'hidden' && stageVisible;
      if (shouldRun) app.ticker.start();
      else app.ticker.stop();
      host.dataset.live2dTicker = shouldRun ? 'running' : 'paused';
    };
    const onDocumentVisibilityChange = () => syncTickerVisibility();

    onLoadingChangeRef.current?.(true, '正在启动 Cubism 引擎…');
    onErrorRef.current?.('');

    const boot = async () => {
      const bootStartedAt = window.performance.now();
      const mobileRuntime = isMobileLive2DRuntime();
      // 模型包读取/解包/贴图转码只碰 IndexedDB 和 FileReader，与引擎完全无关。
      // 提前并行发起，引擎脚本加载 + Pixi 初始化期间磁盘 IO 与解码同时进行，
      // 首屏耗时从「两段相加」变成「取较慢的一段」。
      let sourceAdopted = false;
      const sourcePromise = loadLive2DModelSource(config, stage => onLoadingChangeRef.current?.(true, stage));
      // 真正的错误处理在下方 await 处；这里只防 boot 半路退场时的 unhandledrejection。
      sourcePromise.catch(() => {});
      try {
        await ensureLive2DCubismCore();
        if (disposed) return;
        onLoadingChangeRef.current?.(true, '引擎已就绪，正在准备 Live2D 渲染器…');
        const { configureCubismSDK, Live2DModel, Live2DPlugin } = await preloadLive2DRuntime();
        registerLive2DPlugin(Live2DPlugin as Parameters<typeof extensions.add>[0]);
        // The stage renders a single model. Reserving 128 MB for Cubism's
        // internal update heap before textures were even uploaded was wasteful
        // on phones; 32 MB keeps a 2x safety margin over the SDK minimum.
        configureCubismSDK({ memorySizeMB: getLive2DCubismMemorySizeMB(mobileRuntime) });

        const pixelRatio = (width: number, height: number) => {
          const ratio = Math.min(window.devicePixelRatio || 1, 2);
          if (!placement) return ratio;
          const pixelBudget = mobileRuntime ? 1_600_000 : 2_500_000;
          return Math.min(ratio, Math.sqrt(pixelBudget / Math.max(1, width * height)));
        };
        app = new Application();
        await app.init({
          resizeTo: host,
          backgroundAlpha: 0,
          // Live2D atlas edges are already alpha-antialiased. Disabling WebGL
          // MSAA on mobile avoids an extra multisampled framebuffer without
          // reducing atlas resolution.
          antialias: !mobileRuntime,
          autoDensity: true,
          resolution: pixelRatio(host.clientWidth, host.clientHeight),
          preference: 'webgl',
          // Pointer tracking is handled on the DOM host below. Keeping Pixi's
          // hit-testing enabled makes it walk Live2D's custom render node as if
          // it were a regular Pixi v8 Container, which can throw from
          // EventBoundary on pointermove for some models/runtime combinations.
          eventMode: 'none',
          eventFeatures: {
            move: false,
            globalMove: false,
            click: false,
            wheel: false,
          },
        });
        if (maxFps && maxFps > 0) app.ticker.maxFPS = Math.max(15, Math.min(60, maxFps));
        if (disposed || !app) return;
        app.canvas.className = 'h-full w-full touch-none';
        app.canvas.style.opacity = '0';
        app.canvas.style.transition = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'none' : 'opacity 220ms ease-out';
        host.appendChild(app.canvas);
        document.addEventListener('visibilitychange', onDocumentVisibilityChange);
        if (typeof IntersectionObserver !== 'undefined') {
          intersectionObserver = new IntersectionObserver(entries => {
            const entry = entries[entries.length - 1];
            stageVisible = Boolean(entry?.isIntersecting && entry.intersectionRatio > 0.01);
            syncTickerVisibility();
          }, { threshold: [0, 0.01] });
          intersectionObserver.observe(host);
        }
        syncTickerVisibility();

        onLoadingChangeRef.current?.(true, '正在准备模型缓存…');
        const source = await sourcePromise;
        sourceAdopted = true;
        cleanupPackage = source.cleanup;
        packageTextureUrls = source.textureUrls;
        actionParameterIdsRef.current = source.actionParameterIds;
        proceduralRestrictionsRef.current = live2DProceduralRestrictions(configRef.current, source.actionParameterIds);
        actionParameterValuesRef.current = source.actionParameterValues;
        if (disposed) {
          releasePackage();
          return;
        }
        acquireTextureLeases(packageTextureUrls);
        texturesLeased = true;

        onLoadingChangeRef.current?.(true, '正在解码 Live2D 贴图…');
        await prepareLive2DTextureAssets(packageTextureUrls);
        if (disposed) return;

        onLoadingChangeRef.current?.(true, '缓存已就绪，正在创建 Cubism 角色…');
        const cubismStartedAt = window.performance.now();
        const model = await Live2DModel.from(source.settings as any, {
          idleMotionGroup: '__sully_permission_idle__',
          // Full mip chains add another ~33% GPU allocation per atlas. The
          // model already uses the selected source resolution, so linear
          // sampling without generated mipmaps preserves detail and memory.
          // Texture sources are Blob URLs now, allowing Pixi's bitmap loader
          // instead of the old main-thread Base64 <img> path.
          textureOptions: { lod: false } as any,
          ticker: app.ticker,
          autoUpdate: true,
          // We provide our own DOM pointer-to-gaze controller and action chips,
          // so the engine's pointer hit-test/focus automation is unnecessary.
          autoHitTest: false,
          autoFocus: false,
        });
        const cubismMs = window.performance.now() - cubismStartedAt;
        const invalidTextureIndex = ((model as any).textures as any[] | undefined)
          ?.findIndex(texture => !isUsableLive2DTexture(texture)) ?? -1;
        if (invalidTextureIndex >= 0) {
          model.destroy({ children: true, texture: false });
          throw new Error(`Live2D 贴图 ${invalidTextureIndex + 1} 加载为空，已阻止进入渲染阶段。`);
        }
        const cubismCoreCompatibility = bridgeCubism6RenderOrders(model);
        const cubismMaskCompatibility = enableCubism5HighPrecisionMasks(model);
        if (disposed || !app) {
          model.destroy({ children: true, texture: true });
          return;
        }
        modelRef.current = model;
        installLive2DIdlePolicy(model.internalModel.motionManager, () => configRef.current);
        model.eventMode = 'none';
        model.interactiveChildren = false;
        app.stage.eventMode = 'none';
        app.stage.interactiveChildren = false;
        model.anchor.set(0.5, 0.5);
        app.stage.addChild(model);

        // Before the first WebGL draw Pixi may report container width/height as 0.
        // Cubism's canvas dimensions are available immediately and avoid a one-frame
        // 200x zoom that leaves only the character's torso on screen.
        const naturalWidth = Math.max(1, (model as any).internalModel?.originalWidth || model.width);
        const naturalHeight = Math.max(1, (model as any).internalModel?.originalHeight || model.height);
        const base = { scale: 1, x: 0, y: 0 };
        const fitModel = () => {
          if (!app) return;
          const width = host.clientWidth, height = host.clientHeight;
          const resolution = pixelRatio(width, height);
          if (width && height && (width !== app.screen.width || height !== app.screen.height || app.renderer.resolution !== resolution)) {
            app.renderer.resize(width, height, resolution);
          }
          base.scale = Math.min((app.screen.width * 0.96) / naturalWidth, (app.screen.height * (placement ? 0.96 : 1.06)) / naturalHeight);
          base.x = app.screen.width * 0.5;
          base.y = app.screen.height * (placement ? 0.5 : 0.53);
        };
        fitModel();
        resizeObserver = new ResizeObserver(fitModel);
        resizeObserver.observe(host);

        const onPointerMove = (event: PointerEvent) => {
          const rect = host.getBoundingClientRect();
          pointerRef.current = {
            x: clamp(((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1),
            y: clamp(1 - ((event.clientY - rect.top) / Math.max(1, rect.height)) * 2),
            active: true,
            lastMoved: window.performance.now(),
          };
        };
        const onPointerLeave = () => { pointerRef.current.active = false; };
        host.addEventListener('pointermove', onPointerMove);
        host.addEventListener('pointerleave', onPointerLeave);

        internal = (model as any).internalModel;
        const core = internal?.coreModel;
        if (!internal || !core || typeof internal.getIdSafe !== 'function') {
          throw new Error('无法取得 Live2D 参数控制器。');
        }
        const idCache = new Map<string, unknown>();
        const current: Record<string, number> = {};
        // additive 参数的底值剥离记录：上一帧我们写入后的最终值与叠加量。
        const lastApplied: Record<string, number> = {};
        const lastFinal: Record<string, number> = {};
        const resolveId = (id: string) => {
          if (!idCache.has(id)) idCache.set(id, internal.getIdSafe(id));
          return idCache.get(id);
        };
        const smooth = (id: string, target: number, speed: number, additive = false) => {
          const next = (current[id] ?? 0) + (target - (current[id] ?? 0)) * speed;
          current[id] = next;
          const resolved = resolveId(id);
          if (!additive) {
            core.setParameterValueById(resolved, next);
            return;
          }
          // 这个回调挂在 afterMotionUpdate 上，写入发生在引擎 saveParameters 之前，
          // 会被存进参数底值、下一帧 loadParameters 原样带回。若直接
          // addParameterValueById，凡是动作没有驱动的参数就会逐帧累加——最典型是
          // 眨眼的 ParamEyeLOpen：多数模型的 Idle 动作不带眼皮曲线，第一次眨眼后
          // 负值越积越深，眼睛永久闭死。所以叠加改为“剥底值再设置”：本帧参数值
          // 若仍等于我们上帧写入的最终值，说明动作没碰它，剥掉上帧叠加量得到真实
          // 底值；否则以动作刚写入的值为底值。
          const currentValue = core.getParameterValueById(resolved);
          const prevFinal = lastFinal[id];
          const base = prevFinal !== undefined && Math.abs(currentValue - prevFinal) < 1e-4
            ? currentValue - (lastApplied[id] ?? 0)
            : currentValue;
          core.setParameterValueById(resolved, base + next);
          lastApplied[id] = next;
          lastFinal[id] = core.getParameterValueById(resolved);
        };
        const hasParameter = (id: string) => {
          try {
            for (let index = 0; index < core.getParameterCount(); index += 1) {
              const parameterId = core.getParameterId(index);
              if (parameterId === resolveId(id) || parameterId?.isEqual?.(id)) return true;
            }
          } catch { /* malformed optional parameters stay absent */ }
          return false;
        };
        const readParameter = (id: string): number | undefined => {
          if (!hasParameter(id)) return undefined;
          try {
            const value = Number(core.getParameterValueById(resolveId(id)));
            return Number.isFinite(value) ? value : undefined;
          } catch {
            return undefined;
          }
        };
        const lipSyncParameters = splitLive2DLipSyncParameters(configRef.current.lipSyncParameterIds);
        const mouthOpenParameterIds = lipSyncParameters.mouthOpen.filter(hasParameter);
        if (!mouthOpenParameterIds.length && hasParameter(DEFAULT_LIVE2D_MOUTH_OPEN_PARAMETER)) {
          mouthOpenParameterIds.push(DEFAULT_LIVE2D_MOUTH_OPEN_PARAMETER);
        }
        const mouthFormParameterIds = lipSyncParameters.mouthForm.filter(hasParameter);
        if (
          hasParameter(DEFAULT_LIVE2D_MOUTH_FORM_PARAMETER)
          && !mouthFormParameterIds.includes(DEFAULT_LIVE2D_MOUTH_FORM_PARAMETER)
        ) {
          mouthFormParameterIds.push(DEFAULT_LIVE2D_MOUTH_FORM_PARAMETER);
        }
        // VTube exports are not always all-or-nothing. Some nine-axis rigs keep
        // only a subset of xin/yin/zin + xinb/yinb/zinb, so detect each channel
        // independently instead of disabling the entire tracking path when one
        // optional parameter is absent.
        const vtubeHeadTrackingInputs = {
          x: hasParameter('xin'),
          y: hasParameter('yin'),
          z: hasParameter('zin'),
        };
        const vtubeBodyTrackingInputs = {
          x: hasParameter('xinb'),
          y: hasParameter('yinb'),
          z: hasParameter('zinb'),
        };
        const hasVTubeHeadTrackingInputs = Object.values(vtubeHeadTrackingInputs).some(Boolean);
        const hasVTubeBodyTrackingInputs = Object.values(vtubeBodyTrackingInputs).some(Boolean);
        const usesVTubeTrackingInputs = hasVTubeHeadTrackingInputs || hasVTubeBodyTrackingInputs;
        const autonomy = new AvatarAutonomy(window.performance.now());
        // 微表情包络的计时基准：导演指令一换就重新起算。
        let handledTouchImpulseNonce = touchImpulseNonceRef.current;
        let lastDirectionForFaces: AvatarPerformanceDirection | undefined;
        let directionChangedAt = window.performance.now();
        // 自定义参数动作的底值记录：叠加淡出后参数要精确回到模型自身的值。
        const overlayBases: Record<string, { base: number; lastFinal: number }> = {};
        const pinnedPreviewBases: Record<string, { base: number; lastFinal: number }> = {};
        const wardrobeBases: Record<string, { base: number; lastFinal: number }> = {};
        const overlayBlend = (id: string, target: number, weight: number) => {
          const resolved = resolveId(id);
          const currentValue = core.getParameterValueById(resolved);
          const st = overlayBases[id];
          const base = st && Math.abs(currentValue - st.lastFinal) < 1e-4 ? st.base : currentValue;
          core.setParameterValueById(resolved, base + (target - base) * weight);
          overlayBases[id] = { base, lastFinal: core.getParameterValueById(resolved) };
        };
        const applyPinnedPreview = (targets: Array<{ id: string; value: number }>) => {
          const activeIds = new Set(targets.map(target => target.id));
          targets.forEach(({ id, value }) => {
            const resolved = resolveId(id);
            const currentValue = core.getParameterValueById(resolved);
            const previous = pinnedPreviewBases[id];
            const base = previous && Math.abs(currentValue - previous.lastFinal) < 1e-4
              ? previous.base
              : currentValue;
            core.setParameterValueById(resolved, value);
            pinnedPreviewBases[id] = { base, lastFinal: core.getParameterValueById(resolved) };
          });
          Object.keys(pinnedPreviewBases).forEach(id => {
            if (activeIds.has(id)) return;
            const resolved = resolveId(id);
            const previous = pinnedPreviewBases[id];
            const currentValue = core.getParameterValueById(resolved);
            if (Math.abs(currentValue - previous.lastFinal) < 1e-4) {
              core.setParameterValueById(resolved, previous.base);
            }
            delete pinnedPreviewBases[id];
          });
        };
        const applyPersistentWardrobe = () => {
          const targets = preserveActiveWardrobeRef.current
            ? getActiveLive2DWardrobeParameters(configRef.current, actionParameterValuesRef.current)
            : [];
          const activeIds = new Set<string>();
          targets.forEach(({ id, value, blend = 'Add' }) => {
            if (!hasParameter(id) || !Number.isFinite(value)) return;
            activeIds.add(id);
            const resolved = resolveId(id);
            const currentValue = core.getParameterValueById(resolved);
            const previous = wardrobeBases[id];
            const base = previous && Math.abs(currentValue - previous.lastFinal) < 1e-4
              ? previous.base
              : currentValue;
            const next = blend === 'Overwrite'
              ? value
              : blend === 'Multiply' ? base * value : base + value;
            core.setParameterValueById(resolved, next);
            wardrobeBases[id] = { base, lastFinal: core.getParameterValueById(resolved) };
          });
          Object.keys(wardrobeBases).forEach(id => {
            if (activeIds.has(id)) return;
            const resolved = resolveId(id);
            const previous = wardrobeBases[id];
            const currentValue = core.getParameterValueById(resolved);
            if (Math.abs(currentValue - previous.lastFinal) < 1e-4) {
              core.setParameterValueById(resolved, previous.base);
            }
            delete wardrobeBases[id];
          });
          if (host.dataset.live2dWardrobe !== (configRef.current.activeWardrobeActionId || '')) {
            host.dataset.live2dWardrobe = configRef.current.activeWardrobeActionId || '';
          }
        };

        // 把模型全部参数（id/范围/默认值）回传给设置面板，驱动 VTS 风格的
        // 自定义参数动作编辑器。枚举失败不影响通话本身。
        try {
          const parameters: Live2DParameterInfo[] = [];
          for (let index = 0; index < core.getParameterCount(); index += 1) {
            const handle = core.getParameterId(index);
            const parameterId = handle?.getString?.()?.s ?? String(handle);
            parameters.push({
              id: parameterId,
              min: core.getParameterMinimumValue?.(index) ?? -1,
              max: core.getParameterMaximumValue?.(index) ?? 1,
              defaultValue: core.getParameterDefaultValue?.(index) ?? 0,
            });
          }
          onParametersDiscoveredRef.current?.(parameters);
        } catch { /* 参数枚举失败不影响通话 */ }

        // 逐帧变化的调试值（眨眼/口型）只在 dev 面板可用时写 DOM——prod 下每帧
        // 两次 setAttribute 纯属白扔主线程；姿态/动作组这类低频值改成变了才写。
        const debugFrameDatasets = isDevDebugAvailable();
        let lastPoseDataset = '';
        let lastActiveMotionDataset: string | null = null;
        let lastAutonomyEyes = { eyeX: 0, eyeY: 0 };
        let finalEyeX = 0;
        let finalEyeY = 0;
        let lastMouthLevel = 0;
        applyControls = () => {
          const now = window.performance.now();
          const t = now / 1000;
          const speaking = motionStateRef.current === 'speaking';
          const headLocked = headMotionLockedRef.current;
          const suppressesAmbientAutonomy = ambientAutonomyDisabledRef.current;
          const authoredDirection = performanceRef.current || DEFAULT_AVATAR_PERFORMANCE;
          const directedHead = getRuntimeDirectedHeadControl(authoredDirection, now);
          const authoredPrecision = authoredDirection.precision || {};
          const authoredIntensity = clamp(authoredDirection.intensity, 0.2, 1);
          const gazeHeadX = authoredDirection.gaze === 'left' ? -0.22 * authoredIntensity
            : authoredDirection.gaze === 'right' ? 0.22 * authoredIntensity : 0;
          const gazeHeadY = authoredDirection.gaze === 'down' ? -0.18 * authoredIntensity : 0;
          const gazeEyeX = authoredDirection.gaze === 'left' ? -0.78 * authoredIntensity
            : authoredDirection.gaze === 'right' ? 0.78 * authoredIntensity : 0;
          const gazeEyeY = authoredDirection.gaze === 'down' ? -0.62 * authoredIntensity : 0;
          const directed = String(directedHead.enabled);
          if (host.dataset.live2dDirectedHead !== directed) host.dataset.live2dDirectedHead = directed;
          const direction = headLocked || suppressesAmbientAutonomy ? {
            ...authoredDirection,
            precision: {
              ...authoredPrecision,
              lockAutonomy: true,
              lockHead: directedHead.enabled ? authoredPrecision.lockHead : true,
              headX: authoredPrecision.headX ?? gazeHeadX,
              headY: authoredPrecision.headY ?? gazeHeadY,
              headZ: authoredPrecision.headZ ?? 0,
              eyeX: authoredPrecision.eyeX ?? gazeEyeX,
              eyeY: authoredPrecision.eyeY ?? gazeEyeY,
              bodyX: authoredPrecision.bodyX ?? 0,
              bodyY: authoredPrecision.bodyY ?? 0,
              bodyZ: authoredPrecision.bodyZ ?? 0,
              overshoot: authoredPrecision.overshoot ?? 0,
            },
          } : authoredDirection;
          const touchNonce = touchImpulseNonceRef.current;
          if (touchNonce !== undefined && touchNonce !== handledTouchImpulseNonce && direction) {
            handledTouchImpulseNonce = touchNonce;
            autonomy.triggerTouchReaction(direction, motionStateRef.current, now);
            host.dataset.live2dTouchImpulse = String(touchNonce);
          }
          // One WebAudio sample drives both mouth shapes and body emphasis, so a
          // loud syllable lands as a synchronized nod/gesture instead of random motion.
          const lip = audioFeedRef.current?.sample(now);
          const autonomyFrame = autonomy.step(
            now,
            direction,
            motionStateRef.current,
            pointerRef.current,
            speaking && lip?.active ? lip.level : undefined,
          );
          // Do not merely ask the springs to settle. A previously active call
          // pose can retain momentum for seconds, and downstream physics sees
          // that intermediate frame. Startup publishes a literal still pose.
          const frame = headLocked && !directedHead.enabled ? {
            ...autonomyFrame,
            headX: 0,
            headY: 0,
            headZ: 0,
            rotation: 0,
            speechAccent: 0,
          } : autonomyFrame;
          lastAutonomyEyes = { eyeX: frame.eyeX, eyeY: frame.eyeY };
          directedHeadPoseRef.current = directedHead.authoredEnabled && !directedHead.motionOwnsHead
            ? { headX: frame.headX, headY: frame.headY, headZ: frame.headZ }
            : null;
          if (frame.pose !== lastPoseDataset) {
            lastPoseDataset = frame.pose;
            host.dataset.live2dAutonomyPose = frame.pose;
          }
          if (debugFrameDatasets) host.dataset.live2dBlink = frame.blink.toFixed(3);
          // 优先用逐帧音频信号驱动口型；只有拿不到实时信号（未配语音 / CORS
          // 音频接不进 WebAudio）才退回节奏型假口型，绝不在两者之间逐帧横跳。
          // MouthOpenY receives amplitude only; MouthForm receives the independent
          // round-to-wide vowel axis. Without analyser data, both signals remain
          // synthetic instead of reducing a capable rig to simple open/close flaps.
          const mouthFrame = resolveLive2DMouthFrame(speaking, lip, t);
          const mouth = mouthFrame.open;
          lastMouthLevel = mouth;
          if (debugFrameDatasets) {
            host.dataset.live2dMouthLevel = mouth.toFixed(3);
            host.dataset.live2dMouthForm = mouthFrame.form.toFixed(3);
            host.dataset.live2dMouthSource = mouthFrame.source;
          }

          const pinsAutonomyPose = Boolean(direction?.precision?.lockAutonomy);
          if (usesVTubeTrackingInputs) {
            // Models exported for VTube Studio often route these normalized
            // tracker inputs through their own physics. Feeding them preserves
            // the artist's hair/body setup instead of guessing output params.
            if (!directedHead.motionOwnsHead) {
              if (vtubeHeadTrackingInputs.x) smooth('xin', frame.headX, 0.36);
              if (vtubeHeadTrackingInputs.y) smooth('yin', frame.headY, 0.36);
              if (vtubeHeadTrackingInputs.z) smooth('zin', frame.headZ, 0.34);
            }
            // Body springs are already damped in AvatarAutonomy. A second slow
            // filter used to erase most short gestures before they reached a
            // detailed rig, so this layer now only removes frame-level jitter.
            if (vtubeBodyTrackingInputs.x) smooth('xinb', clamp(frame.bodyX * LIVE2D_VTUBE_BODY_GAIN), 0.34);
            if (vtubeBodyTrackingInputs.y) smooth('yinb', clamp(frame.bodyY * LIVE2D_VTUBE_BODY_GAIN), 0.32);
            if (vtubeBodyTrackingInputs.z) smooth('zinb', clamp(frame.bodyZ * LIVE2D_VTUBE_BODY_GAIN), 0.32);
          }
          // A rig can mix VTube head inputs with standard Cubism body angles (or
          // the reverse). Fall back per channel family, not per whole model.
          // Authored precision additionally pins the output parameters so later
          // focus/physics passes cannot pull the pose away from its target.
          if (!directedHead.motionOwnsHead) {
            if ((!vtubeHeadTrackingInputs.x || pinsAutonomyPose) && hasParameter('ParamAngleX')) {
              smooth('ParamAngleX', frame.headX * LIVE2D_HEAD_AXIS_SCALE.x, 0.24, !pinsAutonomyPose);
            }
            if ((!vtubeHeadTrackingInputs.y || pinsAutonomyPose) && hasParameter('ParamAngleY')) {
              smooth('ParamAngleY', frame.headY * LIVE2D_HEAD_AXIS_SCALE.y, 0.24, !pinsAutonomyPose);
            }
            if ((!vtubeHeadTrackingInputs.z || pinsAutonomyPose) && hasParameter('ParamAngleZ')) {
              smooth('ParamAngleZ', frame.headZ * LIVE2D_HEAD_AXIS_SCALE.z, 0.22, !pinsAutonomyPose);
            }
          }
          // Standard Cubism nine-axis rigs expose all three body angles. The
          // old renderer wrote only X, leaving body pitch and roll frozen.
          if ((!vtubeBodyTrackingInputs.x || pinsAutonomyPose) && hasParameter('ParamBodyAngleX')) {
            smooth('ParamBodyAngleX', frame.bodyX * LIVE2D_BODY_AXIS_SCALE.x, 0.22, !pinsAutonomyPose);
          }
          if ((!vtubeBodyTrackingInputs.y || pinsAutonomyPose) && hasParameter('ParamBodyAngleY')) {
            smooth('ParamBodyAngleY', frame.bodyY * LIVE2D_BODY_AXIS_SCALE.y, 0.22, !pinsAutonomyPose);
          }
          if ((!vtubeBodyTrackingInputs.z || pinsAutonomyPose) && hasParameter('ParamBodyAngleZ')) {
            smooth('ParamBodyAngleZ', frame.bodyZ * LIVE2D_BODY_AXIS_SCALE.z, 0.22, !pinsAutonomyPose);
          }
          smooth('ParamEyeBallX', frame.eyeX, 0.42);
          smooth('ParamEyeBallY', frame.eyeY, 0.42);
          // Keep breathing subtle because many models already include it in Idle.
          smooth('ParamBreath', 0.5 + (frame.breath - 0.5) * 0.2, 0.16);

          // 微表情叠加层（face=wink,grin…）：说话期间保持，说完停留片刻再衰减。
          if (direction !== lastDirectionForFaces) {
            lastDirectionForFaces = direction;
            directionChangedAt = now;
          }
          const sinceDirection = (now - directionChangedAt) / 1000;
          const faceSet = new Set(direction?.faces || []);
          const faceIntensity = clamp(direction?.intensity ?? 0.7, 0.2, 1);
          const faceHold = Math.min(1, 0.55 + faceIntensity * 0.45)
            * (speaking ? 1 : Math.exp(-Math.max(0, sinceDirection - 2.8) / 2.6));
          const restrictions = proceduralRestrictionsRef.current;
          const faceW = (name: string) => (!restrictions.faces.has(name) && faceSet.has(name as never) ? faceHold : 0);
          const expressionMouthForm = faceW('grin') - faceW('pout');
          const combinedMouthForm = combineLive2DMouthForm(mouthFrame.form, expressionMouthForm);
          const mouthFormSpeed = mouthFrame.source === 'synthetic' ? 0.12 : 0.22;
          for (const id of mouthFormParameterIds) {
            // Add to the expression/motion-authored base. Writing an absolute
            // vowel value here would erase the model's smile or pout.
            const restricted = restrictions.parameters.has(id)
              || (restrictions.faces.has('pout') && combinedMouthForm < 0)
              || (restrictions.faces.has('grin') && combinedMouthForm > 0);
            smooth(id, restricted ? 0 : combinedMouthForm, mouthFormSpeed, true);
          }
          smooth('ParamCheek', faceW('blush'), 0.18, true);
          // 眉眼系：眯眯笑眼走标准笑眼参数；眉毛用高度/形状/角度组合近似
          // 挑眉、八字眉、皱眉（各模型绑法不同，追求"方向对"而非像素级精确）。
          const smileEyes = faceW('smile-eyes');
          smooth('ParamEyeLSmile', smileEyes, 0.25, true);
          smooth('ParamEyeRSmile', smileEyes, 0.25, true);
          const browShift = faceW('brow-up') * 0.9 - faceW('brow-sad') * 0.45 - faceW('brow-angry') * 0.5;
          smooth('ParamBrowLY', browShift, 0.2, true);
          smooth('ParamBrowRY', browShift, 0.2, true);
          const browForm = faceW('brow-sad') * -0.85 + faceW('brow-angry') * 0.35;
          smooth('ParamBrowLForm', browForm, 0.2, true);
          smooth('ParamBrowRForm', browForm, 0.2, true);
          const browAngle = faceW('brow-angry') * -0.6 + faceW('brow-sad') * 0.35;
          smooth('ParamBrowLAngle', browAngle, 0.2, true);
          smooth('ParamBrowRAngle', browAngle, 0.2, true);
          // Add on top of the model's own eye-open values, so expressions and
          // motion files remain authoritative while autonomous blinks still work.
          const eyesClosed = faceW('eyes-closed');
          smooth('ParamEyeLOpen', -clamp(frame.blink + eyesClosed + smileEyes * 0.35, 0, 1), 0.62, true);
          smooth('ParamEyeROpen', -clamp(frame.blink + eyesClosed + smileEyes * 0.35 + faceW('wink'), 0, 1), 0.62, true);
          for (const id of mouthOpenParameterIds) {
            smooth(id, mouth, speaking ? 0.42 : 0.25);
          }

          // 自定义参数动作叠加：攻击 200ms → 保持到 3.2s → 800ms 淡出。
          const overlays = paramOverlaysRef.current;
          if (overlays.length) {
            const activeTargets = new Map<string, { target: number; weight: number }>();
            for (const overlay of overlays) {
              const age = now - overlay.startedAt;
              const weight = age < 200 ? age / 200 : age < 3_200 ? 1 : Math.max(0, 1 - (age - 3_200) / 800);
              if (weight <= 0) continue;
              for (const { id, value } of overlay.params) {
                const previous = activeTargets.get(id);
                if (!previous || weight >= previous.weight) activeTargets.set(id, { target: value, weight });
              }
            }
            paramOverlaysRef.current = overlays.filter(overlay => now - overlay.startedAt < 4_100);
            activeTargets.forEach(({ target, weight }, id) => overlayBlend(id, target, weight));
            Object.keys(overlayBases).forEach(id => { if (!activeTargets.has(id)) delete overlayBases[id]; });
          }
          // A playable action fades by design; the editor instead needs a
          // sustained before/after state so every slider movement is visible.
          applyPinnedPreview(parameterPreviewRef.current || []);
          // Wardrobe is a user-owned persistent layer. It runs after motions,
          // AI expressions and touch overlays so none of them can expose the
          // model's watermarked/default art by resetting the expression manager.
          applyPersistentWardrobe();
          // Final writer wins: our call-style autonomy, audio accents and custom
          // parameter overlays have all run by this point. During companion
          // startup, erase every head output we own on every frame.
          if (headLocked && !directedHead.enabled) {
            for (const id of ['xin', 'yin', 'zin', 'ParamAngleX', 'ParamAngleY', 'ParamAngleZ']) {
              if (hasParameter(id)) core.setParameterValueById(resolveId(id), 0);
            }
          }
        };
        internal.on('afterMotionUpdate', applyControls);

        // `afterMotionUpdate` is not the end of this engine's frame. It still
        // runs focus, breath, physics and pose after that event, so clamping the
        // head there can be overwritten before Cubism evaluates the drawable.
        // `beforeModelUpdate` is the last writable point. Both the startup lock
        // and call gaze must win here: even with autoFocus=false, a model motion
        // can write head/eye curves after our afterMotionUpdate controls.
        applyFinalHeadLock = () => {
          const locked = headMotionLockedRef.current || ambientAutonomyDisabledRef.current;
          const authoredDirection = performanceRef.current || DEFAULT_AVATAR_PERFORMANCE;
          const directedHead = getRuntimeDirectedHeadControl(authoredDirection, window.performance.now());
          const headLock = String(headMotionLockedRef.current), ambientLock = String(locked);
          if (host.dataset.live2dHeadLocked !== headLock) host.dataset.live2dHeadLocked = headLock;
          if (host.dataset.live2dAmbientHeadSuppressed !== ambientLock) host.dataset.live2dAmbientHeadSuppressed = ambientLock;

          let targetEyeX = lastAutonomyEyes.eyeX;
          let targetEyeY = lastAutonomyEyes.eyeY;
          const maintainsViewerEyeContact = motionStateRef.current === 'speaking'
            && authoredDirection.gaze === 'viewer'
            && !authoredDirection.precision?.lockAutonomy;
          let normalizedHeadX = 0;
          let normalizedHeadY = 0;
          if (maintainsViewerEyeContact) {
            // Read the actual final model pose, not AvatarAutonomy's requested
            // pose. Imported Live2D motions can own the head and never expose
            // their angle back to the shared frame.
            const angleX = readParameter('ParamAngleX');
            const angleY = readParameter('ParamAngleY');
            normalizedHeadX = angleX !== undefined ? angleX / LIVE2D_HEAD_AXIS_SCALE.x : (readParameter('xin') ?? 0);
            normalizedHeadY = angleY !== undefined ? angleY / LIVE2D_HEAD_AXIS_SCALE.y : (readParameter('yin') ?? 0);
            const correction = getViewerEyeContactCompensation(normalizedHeadX, normalizedHeadY);
            targetEyeX = correction.eyeX;
            targetEyeY = correction.eyeY;
          }
          const eyeSpeed = maintainsViewerEyeContact ? 0.48 : 0.38;
          finalEyeX += (targetEyeX - finalEyeX) * eyeSpeed;
          finalEyeY += (targetEyeY - finalEyeY) * eyeSpeed;
          if (hasParameter('ParamEyeBallX')) core.setParameterValueById(resolveId('ParamEyeBallX'), finalEyeX);
          if (hasParameter('ParamEyeBallY')) core.setParameterValueById(resolveId('ParamEyeBallY'), finalEyeY);
          // Motions, focus and physics can all run after afterMotionUpdate and
          // overwrite the synthetic no-audio opening. The final layer therefore
          // pins opening parameters only. MouthForm must retain the additive
          // vowel + expression result written above.
          const finalMouth = motionStateRef.current === 'speaking' ? lastMouthLevel : 0;
          for (const id of mouthOpenParameterIds) {
            if (hasParameter(id)) core.setParameterValueById(resolveId(id), finalMouth);
          }
          if (debugFrameDatasets) {
            host.dataset.live2dFinalHead = `${normalizedHeadX.toFixed(3)},${normalizedHeadY.toFixed(3)}`;
            host.dataset.live2dFinalEyes = `${finalEyeX.toFixed(3)},${finalEyeY.toFixed(3)}`;
            host.dataset.live2dFinalMouth = finalMouth.toFixed(3);
          }

          if (!locked || directedHead.motionOwnsHead || directedHead.paramsOwnHead) return;
          const authoredPose = directedHead.authoredEnabled ? directedHeadPoseRef.current : null;
          if (authoredPose) {
            const values: Array<[string, number]> = [
              ['xin', authoredPose.headX],
              ['yin', authoredPose.headY],
              ['zin', authoredPose.headZ],
              ['ParamAngleX', authoredPose.headX * LIVE2D_HEAD_AXIS_SCALE.x],
              ['ParamAngleY', authoredPose.headY * LIVE2D_HEAD_AXIS_SCALE.y],
              ['ParamAngleZ', authoredPose.headZ * LIVE2D_HEAD_AXIS_SCALE.z],
            ];
            values.forEach(([id, value]) => {
              if (hasParameter(id)) core.setParameterValueById(resolveId(id), value);
            });
            return;
          }
          for (const id of HEAD_LOCK_PARAMETER_IDS) {
            if (hasParameter(id)) core.setParameterValueById(resolveId(id), 0);
          }
        };
        internal.on('beforeModelUpdate', applyFinalHeadLock);

        const updateStage = (instant = false) => {
          if (!app) return;
          if (ambientAutonomyDisabledRef.current && motionStateRef.current === 'idle') {
            const mainManager = internal?.motionManager;
            if (mainManager && !mainManager.isFinished?.()) mainManager.stopAllMotions?.();
            const parallelManagers = internal?.parallelMotionManager;
            if (Array.isArray(parallelManagers)) {
              parallelManagers.forEach((manager: any) => {
                if (!manager?.isFinished?.()) manager?.stopAllMotions?.();
              });
            }
          }
          const direction = performanceRef.current;
          const motionManagerState = internal?.motionManager?.state;
          const activeMotionGroup = String(motionManagerState?.currentGroup || motionManagerState?.reservedIdleGroup || '');
          if (activeMotionGroup !== lastActiveMotionDataset) {
            lastActiveMotionDataset = activeMotionGroup;
            host.dataset.live2dActiveMotion = activeMotionGroup;
          }
          const closeShot = direction?.camera === 'close' || direction?.camera === 'push-in';
          // 用户锚定过脸部时，特写镜头直接落到锚点构图，不再用启发式偏移猜脸的位置。
          const anchored = closeShot && faceFramingRef.current ? faceFramingRef.current : null;
          const framing = anchored || framingRef.current;
          // On the always-on desktop, a generic full-body heuristic is more
          // dangerous than useful: one face tap used to enlarge the model and
          // push it down by 10% of the screen, which can move tall imports
          // completely offstage. Until the user saves a face anchor, keep the
          // desktop's calibrated composition perfectly still.
          const suppressUnanchoredCloseShot = closeShot
            && ambientAutonomyDisabledRef.current
            && !anchored
            && !configRef.current.builtIn;
          // 导演机位只在用户构图基础上做温和加减：medium 必须是 1.0，
          // 否则用户校准好的构图会被默认镜头永久放大。锚定后特写倍率交给锚点本身。
          const cameraScale = anchored
            ? 1
            : suppressUnanchoredCloseShot
              ? 1
            : closeShot
              ? 1.22
              : direction?.camera === 'wide' || direction?.camera === 'pull-out' ? 0.88 : 1;
          const cameraYOffset = anchored || suppressUnanchoredCloseShot ? 0 : closeShot ? 0.1 : 0;
          const cameraX = base.x + app.screen.width * framing.offsetX;
          const cameraY = base.y + app.screen.height * (framing.offsetY + cameraYOffset);
          const frame = autonomy.frame;
          const targetScale = base.scale * framing.scale * cameraScale * (1 + frame.lean * 0.45);
          // 呼吸 / lift / lean 的位移必须并进目标位置再做平滑。旧写法把它们
          // 加在 lerp 之后，相当于每帧注入增量、平衡点被放大 1/0.08 ≈ 12.5 倍，
          // 模型在手机小舞台上大幅上下漂移。振幅也按小屏收敛：呼吸 ±2px 级，
          // 前倾最多抬 ~28px（外加 targetScale 里的轻微放大）。
          const bobY = (frame.breath * 2 - 1) * 2.2
            + frame.lift * app.screen.height * 0.35
            - frame.lean * Math.min(app.screen.height * 0.08, 28);
          const targetY = cameraY + bobY;
          const currentScale = model.scale.x || targetScale;
          const currentY = model.position.y || targetY;
          const blend = instant ? 1 : 0.08;
          model.scale.set(currentScale + (targetScale - currentScale) * blend);
          model.position.set(
            cameraX + frame.bodyX * 5,
            currentY + (targetY - currentY) * blend,
          );
          // `frame.rotation` is also produced by AvatarAutonomy and rotates the
          // entire Live2D display, which visually turns the head even when all
          // head parameters are zero.
          model.rotation = headMotionLockedRef.current || ambientAutonomyDisabledRef.current ? 0 : frame.rotation;
        };
        // First placement must snap to saved framing, never lerp down from Pixi scale=1.
        let lastPose: CallRolePlacement | undefined;
        let lastCorner = false, lastWidth = 0, lastHeight = 0;
        app.ticker.add(() => {
          if (placement && app) {
            const { pose, corner } = placement.current;
            const { width, height } = app.screen;
            if (pose !== lastPose || corner !== lastCorner || width !== lastWidth || height !== lastHeight) {
              app.stage.pivot.set(width / 2, height / 2);
              app.stage.position.set(width * ((corner ? .7 : .5) + pose.x / 100), height * ((corner ? .65 : .5) + pose.y / 100));
              app.stage.scale.set(pose.scale * (corner ? .65 : 1));
              app.stage.angle = pose.angle;
              lastPose = pose; lastCorner = corner; lastWidth = width; lastHeight = height;
            }
          }
          updateStage(!revealed);
        });
        updateStage(true);

        const initialPerformance = performanceRef.current;
        if (initialPerformance) {
          void triggerPerformance(initialPerformance).catch(() => { /* optional */ });
        }
        onLoadingChangeRef.current?.(true, '正在准备角色画面…');
        console.info('[live2d] renderer ready', {
          assetId: config.assetId,
          offscreenCount: cubismCoreCompatibility.offscreenCount,
          ...cubismMaskCompatibility,
          ...source.timings,
          cubismMs: Math.round(cubismMs),
          bootTotalMs: Math.round(window.performance.now() - bootStartedAt),
        });
        cancelReveal = revealLive2DAfterPaint(() => {
          if (disposed || !app || host.clientWidth <= 0 || host.clientHeight <= 0) return false;
          // Resize and render while still hidden, including saved full-body composition.
          app.resize();
          fitModel();
          updateStage(true);
          app.render();
          return true;
        }, () => {
          if (disposed || !app) return;
          revealed = true;
          app.canvas.style.opacity = '1';
          host.dataset.live2dReady = 'true';
          onLoadingChangeRef.current?.(false, '角色已就绪');
          onReadyRef.current?.();
        }, error => {
          if (disposed) return;
          onLoadingChangeRef.current?.(false);
          onErrorRef.current?.(error instanceof Error ? error.message : '角色画面准备失败，请重新加载');
        });
        onSnapshotReadyRef.current?.(() => {
          if (disposed || !app) throw new Error('Live2D 舞台已关闭');
          updateStage(true);
          const width = app.screen.width, height = app.screen.height, resolution = app.renderer.resolution;
          // Only the still capture renders at higher density; the small live preview stays cheap.
          try {
            app.renderer.resize(width, height, 1024 / Math.max(1, width, height));
            app.render();
            const snapshot = document.createElement('canvas');
            snapshot.width = app.canvas.width; snapshot.height = app.canvas.height;
            const context = snapshot.getContext('2d');
            if (!context) throw new Error('无法生成 Live2D 快照');
            context.drawImage(app.canvas as HTMLCanvasElement, 0, 0);
            return snapshot;
          } finally { app.renderer.resize(width, height, resolution); }
        });

        model.once('destroy', () => {
          host.removeEventListener('pointermove', onPointerMove);
          host.removeEventListener('pointerleave', onPointerLeave);
        });
      } catch (error) {
        if (!disposed) {
          onLoadingChangeRef.current?.(false);
          const rawMessage = error instanceof Error ? error.message : 'Live2D 模型加载失败';
          // Pixi 的贴图加载失败原文只有一句 [Loader.load] Failed to load <url>，
          // 翻译成用户能行动的提示，同时保留前缀方便排查。
          const message = /\[Loader\.load\]/.test(rawMessage)
            ? `贴图加载失败（${rawMessage.replace(/\s+/g, ' ').slice(0, 120)}…）。请点击重新加载再试；若仍失败，多半是贴图过大或格式异常，建议把纹理导出为 4096 以下的 PNG 后重新导入。`
            : rawMessage;
          onErrorRef.current?.(message);
        }
      } finally {
        bootSettled = true;
        // boot 半路退场（引擎报错 / 组件卸载）时，晚到的模型包资源就地释放，
        // 否则并行发起的 blob URL / 贴图缓存会一直挂到页面刷新。cleanup 幂等。
        if (!sourceAdopted) {
          void sourcePromise.then(source => { if (!sourceAdopted) source.cleanup(); }, () => {});
        }
        if (disposed) releasePackage();
      }
    };

    void boot();
    return () => {
      disposed = true;
      cancelReveal?.();
      host.dataset.live2dReady = 'false';
      onSnapshotReadyRef.current?.(null);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener('visibilitychange', onDocumentVisibilityChange);
      if (internal && applyControls) internal.off('afterMotionUpdate', applyControls);
      if (internal && applyFinalHeadLock) internal.off('beforeModelUpdate', applyFinalHeadLock);
      const model = modelRef.current;
      modelRef.current = null;
      if (model) {
        try {
          app?.stage.removeChild(model);
          model.destroy({ children: true, texture: false });
        } catch { /* cleanup must never break React unmount */ }
      }
      if (app) {
        try { app.destroy(true, { children: true, texture: false }); } catch { /* cleanup must never break React unmount */ }
      }
      if (texturesLeased) releaseTextureLeases(packageTextureUrls);
      texturesLeased = false;
      packageTextureUrls = [];
      // Live2DModel.from may resolve before its optional physics/pose requests
      // finish. Revoking blob URLs during a remount/HMR update turns those
      // requests into ERR_FILE_NOT_FOUND. Let the boot promise settle first;
      // the long fallback only covers a loader that never settles.
      if (bootSettled) releasePackage();
      else deferredCleanupTimer = window.setTimeout(releasePackage, 120_000);
    };
  }, [config.assetId, lipSyncKey, maxFps]);

  const displayedTouchRegions = touchRegionEditingZone
    ? [...(touchRegions ?? config.touchRegions ?? []), ...(drawingTouchRegion ? [drawingTouchRegion] : [])]
    : [];

  return (
    <div ref={hostRef} className="absolute inset-0 overflow-hidden" aria-label="Live2D 角色舞台">
      {touchRegionEditingZone && touchRegionBounds && (
        <div
          className="absolute inset-0 z-10 touch-none cursor-crosshair"
          onPointerDown={handleTouchRegionPointerDown}
          onPointerMove={handleTouchRegionPointerMove}
          onPointerUp={event => finishTouchRegion(event, true)}
          onPointerCancel={event => finishTouchRegion(event, false)}
          data-testid="live2d-touch-region-editor"
          aria-label={`正在圈选${avatarTouchZoneToastLabel(touchRegionEditingZone)}触摸区域`}
        >
          <div
            className="pointer-events-none absolute border border-dashed border-white/30"
            style={{
              left: touchRegionBounds.x,
              top: touchRegionBounds.y,
              width: touchRegionBounds.width,
              height: touchRegionBounds.height,
            }}
            aria-hidden
          />
          {displayedTouchRegions.map(region => {
            const color = TOUCH_REGION_COLORS[region.zone];
            const drawing = region.id === '__drawing__';
            const active = region.zone === touchRegionEditingZone;
            return (
              <div
                key={region.id}
                className="pointer-events-none absolute flex items-center justify-center rounded-[50%] border"
                style={{
                  left: touchRegionBounds.x + (region.x - region.width / 2) * touchRegionBounds.width,
                  top: touchRegionBounds.y + (region.y - region.height / 2) * touchRegionBounds.height,
                  width: region.width * touchRegionBounds.width,
                  height: region.height * touchRegionBounds.height,
                  borderColor: color,
                  borderStyle: drawing ? 'dashed' : 'solid',
                  borderWidth: active ? 2 : 1,
                  background: `${color}${active ? '28' : '12'}`,
                  boxShadow: active ? `0 0 18px ${color}55` : undefined,
                }}
                data-touch-region-zone={region.zone}
                aria-hidden
              >
                {region.width > 0.08 && region.height > 0.05 && (
                  <span className="rounded-full bg-black/55 px-1.5 py-0.5 text-[8px] font-semibold text-white/90 backdrop-blur">
                    {avatarTouchZoneToastLabel(region.zone)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default Live2DAvatarCanvas;
