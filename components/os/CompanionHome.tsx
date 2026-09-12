import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  ArrowsOutCardinal,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  Crop,
  Gear,
  HandTap,
  Minus,
  Plus,
  Sparkle,
  SpeakerHigh,
  TShirt,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { AppID, type AvatarTouchRegion, type CompanionStartupSettings, type CompanionTouchReaction, type CompanionTouchSettings, type DailySchedule } from '../../types';
import { Icons, INSTALLED_APPS } from '../../constants';
import VRMVideoCallStage from '../call/VRMVideoCallStage';
import { ScheduleFullscreenViewer } from '../schedule/ScheduleHomeWidget';
import type { AvatarMotionState } from '../call/VRMAvatarCanvas';
import type { Live2DActionTrigger } from '../call/Live2DAvatarCanvas';
import {
  applyAvatarTouchForce,
  avatarTouchZoneLabel,
  avatarTouchTargetLabel,
  buildImmediateTouchPerformance,
  DEFAULT_COMPANION_TOUCH_ZONES,
  normalizeCompanionDialogue,
  requestAvatarTouchReactionPack,
  resolveAvatarTouchForce,
  type AvatarTouchHit,
  type AvatarTouchModelAction,
  type AvatarTouchZone,
} from '../../utils/avatarTouch';
import {
  AVATAR_EMOTIONS,
  AVATAR_FACES,
  AVATAR_GESTURES,
  clampStageCrop,
  DEFAULT_AVATAR_PERFORMANCE,
  DEFAULT_STAGE_CROP,
  DEFAULT_STAGE_FRAMING,
  expandAvatarPerformanceCueBeats,
  type AvatarPerformanceCue,
  type AvatarPerformanceDirection,
  type AvatarPerformancePrecision,
  type AvatarStageCrop,
  type AvatarStageFraming,
} from '../../utils/avatarPerformance';
import { deleteBlobRef, deleteBlobRefIfUnreferenced, isBlobRef, putImageBlob, useBlobRefUrl } from '../../utils/blobRef';
import TokenImg from './TokenImg';
import { hslToHex, hueFromGradient, hueFromImage, normalizeHue } from '../../utils/dominantHue';
import { characterHasVoice } from '../../utils/ttsRouter';
import { CallAudioFeed } from '../../utils/callAudioFeed';
import { VOICE_LANGUAGE_OPTIONS, voiceLanguageAnalyticsValue, voiceLanguageLabel } from '../../utils/voiceLanguage';
import {
  generateCompanionStartupVoice,
  createAvatarTouchVoiceUrl,
  generateAvatarTouchVoicePack,
} from '../../utils/avatarTouchVoice';
import { DB } from '../../utils/db';
import { isChatPreviewMessage } from '../../utils/chatMessageVisibility';
import { getLastInnerState } from '../../utils/emotionApply';
import { getFlowNarrativeKey } from '../../utils/scheduleFeature';
import { getDailyScheduleForChar } from '../../utils/dailySchedule';
import { useLocalDateKey } from '../../hooks/useLocalDateKey';
import { resolveCharTimeZone } from '../../utils/timezone';
import { getCurrentScheduleSlotIndex, getScheduleWallClock } from '../../utils/scheduleTime';
import {
  COMPANION_FRAME_STYLE_EVENT,
  COMPANION_FRAME_STYLE_KEY,
  COMPANION_FRAME_STYLES,
  loadCompanionFrameStyle,
  saveCompanionFrameStyle,
  type CompanionFrameStyleId,
} from './companionFrameStyles';
import OtomeCompanionChrome from './OtomeCompanionChrome';
import CatCompanionChrome from './CatCompanionChrome';
import MagazineCompanionChrome from './MagazineCompanionChrome';
import CardbookCompanionChrome from './CardbookCompanionChrome';
import IdolCompanionChrome from './IdolCompanionChrome';
import CompanionWardrobeDrawer from './CompanionWardrobeDrawer';
import CompanionStageLoadingCurtain, { type CompanionStageCurtainPhase } from './CompanionStageLoadingCurtain';
import StaticCompanionPortrait from './StaticCompanionPortrait';
import Live2DActionSettings from '../call/Live2DActionSettings';
import {
  getLive2DAIActions,
  getLive2DWardrobeActions,
  removeLive2DWardrobeAction,
  saveLive2DModelFromZip,
  type Live2DAction,
  type Live2DAvatarConfig,
} from '../../utils/live2dModelStore';
import { deleteAvatarModel, saveAvatarModel } from '../../utils/avatarModelStore';
import {
  addUploadedCompanionOutfit,
  listCompanionModelOutfits,
  listUploadedCompanionOutfits,
  removeCompanionModelOutfit,
  removeUploadedCompanionOutfit,
  selectCompanionModelOutfit,
  selectUploadedCompanionOutfit,
  storeCompanionModelOutfit,
} from '../../utils/companionWardrobe';
import {
  DEFAULT_COMPANION_STARTUP_PERFORMANCE,
  normalizeCompanionStartupPerformance,
} from '../../utils/companionStartup';
import {
  requestCompanionPerformanceCues,
  splitCompanionPerformanceSentences,
} from '../../utils/companionPerformanceDirector';
import {
  BUILTIN_SULLY_DEFAULT_FRAMING,
  isBuiltinSullyLive2D,
  setBuiltinSullyLive2DQuality,
  type BuiltinSullyLive2DQuality,
} from '../../utils/builtinSullyLive2D';
import {
  companionAvatarSource,
  companionSkinSetPatchValue,
  listCompanionDateOutfits,
  normalizeCompanionSkinSetId,
  resolveCompanionPortrait,
} from '../../utils/companionAvatar';
import { trackEvent } from '../../utils/analytics';
import {
  activateCompanionStartupPreset,
  activateCompanionTouchPreset,
  collectCompanionVoiceAssetIds,
  removeCompanionStartupPreset,
  removeCompanionTouchPreset,
  saveCompanionStartupPreset,
  saveCompanionTouchPreset,
} from '../../utils/companionPresets';
import { deleteCompanionVoiceBlob } from '../../utils/companionVoiceAssets';

// ── 时段氛围：陪伴桌面按虚拟时间换天色（晨曦 / 白日 / 黄昏 / 夜晚）──
interface DayPeriod {
  key: 'dawn' | 'morning' | 'day' | 'dusk' | 'evening' | 'night';
  /** 时钟下方的小字时段标签。 */
  label: string;
  /** 顶部天光颜色（渐变入夜色底）。 */
  skyGlow: string;
  /** 氛围主色：粒子、点缀发光用。 */
  tint: string;
}

const DAY_PERIODS: DayPeriod[] = [
  {
    key: 'dawn',
    label: '夜半独处',
    skyGlow: 'rgba(96,104,182,0.34)',
    tint: '#8d9bea',
  },
  {
    key: 'morning',
    label: '清晨',
    skyGlow: 'rgba(255,196,138,0.4)',
    tint: '#ffcf9b',
  },
  {
    key: 'day',
    label: '午后',
    skyGlow: 'rgba(168,214,255,0.36)',
    tint: '#b4dcff',
  },
  {
    key: 'dusk',
    label: '黄昏',
    skyGlow: 'rgba(255,158,120,0.4)',
    tint: '#ffb08d',
  },
  {
    key: 'evening',
    label: '夜晚',
    skyGlow: 'rgba(178,150,255,0.38)',
    tint: '#c6adff',
  },
  {
    key: 'night',
    label: '深夜',
    skyGlow: 'rgba(112,118,196,0.34)',
    tint: '#96a2f2',
  },
];

const periodForHour = (hours: number): DayPeriod => {
  if (hours < 5) return DAY_PERIODS[0];
  if (hours < 11) return DAY_PERIODS[1];
  if (hours < 17) return DAY_PERIODS[2];
  if (hours < 19) return DAY_PERIODS[3];
  if (hours < 23) return DAY_PERIODS[4];
  return DAY_PERIODS[5];
};

const STARTUP_POSE_CONTROLS: Array<{
  key: 'eyeX' | 'eyeY' | 'bodyX' | 'bodyY' | 'bodyZ';
  label: string;
  hint: string;
}> = [
  { key: 'eyeX', label: '眼睛左右', hint: '左 − / 右 +' },
  { key: 'eyeY', label: '眼睛高低', hint: '低 − / 高 +' },
  { key: 'bodyX', label: '身体左右', hint: '左 − / 右 +' },
  { key: 'bodyY', label: '身体俯仰', hint: '后 − / 前 +' },
  { key: 'bodyZ', label: '身体侧倾', hint: '右 − / 左 +' },
];

const STARTUP_EMOTION_LABELS: Record<string, string> = {
  neutral: '自然', happy: '开心', sad: '低落', angry: '生气', fearful: '害怕',
  disgusted: '嫌弃', surprised: '惊讶', calm: '平静', relaxed: '放松',
};

const STARTUP_GESTURE_LABELS: Record<string, string> = {
  idle: '静止入场', talk: '自然说话', nod: '点头', shake: '摇头', tilt: '歪头',
  explain: '解释', wave: '挥手', shy: '害羞', 'lean-in': '靠近', 'lean-back': '后退',
};

const STARTUP_FACE_LABELS: Record<string, string> = {
  wink: '眨眼', grin: '咧嘴', pout: '撅嘴', blush: '脸红', 'eyes-closed': '闭眼',
  'smile-eyes': '笑眼', 'brow-up': '挑眉', 'brow-sad': '忧眉', 'brow-angry': '压眉',
};
// ── 背景预设：华丽渐变场景（companionBackground = `preset:<id>`）──
interface CompanionBgPreset {
  id: string;
  name: string;
  css: string;
  /** 该场景的氛围主色（粒子/地面辉光跟着走）。 */
  tint: string;
}

const COMPANION_BG_PRESETS: CompanionBgPreset[] = [
  {
    id: 'galaxy',
    name: '星河',
    tint: '#b9a6ff',
    css: [
      'radial-gradient(1.4px 1.4px at 18% 22%, rgba(255,255,255,.9), transparent 55%)',
      'radial-gradient(1px 1px at 66% 12%, rgba(255,255,255,.8), transparent 55%)',
      'radial-gradient(1.6px 1.6px at 82% 34%, rgba(255,255,255,.75), transparent 55%)',
      'radial-gradient(1px 1px at 38% 8%, rgba(255,255,255,.65), transparent 55%)',
      'radial-gradient(1.2px 1.2px at 8% 48%, rgba(255,255,255,.5), transparent 55%)',
      'radial-gradient(1px 1px at 52% 30%, rgba(255,255,255,.6), transparent 55%)',
      'radial-gradient(90% 60% at 70% 8%, rgba(128,90,213,.4), transparent 65%)',
      'radial-gradient(70% 55% at 22% 30%, rgba(64,76,180,.42), transparent 70%)',
      'linear-gradient(180deg, #171238 0%, #1d1345 40%, #0b0a22 100%)',
    ].join(', '),
  },
  {
    id: 'aurora',
    name: '极光',
    tint: '#8ef0d0',
    css: [
      'radial-gradient(60% 42% at 32% 18%, rgba(84,230,180,.34), transparent 68%)',
      'radial-gradient(55% 38% at 66% 10%, rgba(90,170,255,.3), transparent 66%)',
      'radial-gradient(40% 30% at 82% 30%, rgba(150,110,255,.24), transparent 70%)',
      'linear-gradient(180deg, #0a1c2e 0%, #0c2237 46%, #061018 100%)',
    ].join(', '),
  },
  {
    id: 'sakura',
    name: '樱夜',
    tint: '#ffb7cf',
    css: [
      'radial-gradient(2px 2px at 24% 26%, rgba(255,183,207,.85), transparent 60%)',
      'radial-gradient(1.6px 1.6px at 70% 16%, rgba(255,205,222,.75), transparent 60%)',
      'radial-gradient(2.2px 2.2px at 84% 44%, rgba(255,183,207,.6), transparent 60%)',
      'radial-gradient(1.4px 1.4px at 12% 52%, rgba(255,205,222,.55), transparent 60%)',
      'radial-gradient(90% 55% at 50% 0%, rgba(255,140,180,.32), transparent 66%)',
      'linear-gradient(180deg, #2c1630 0%, #33182f 46%, #120a18 100%)',
    ].join(', '),
  },
  {
    id: 'sunset',
    name: '落日海',
    tint: '#ffb98a',
    css: [
      'radial-gradient(70% 46% at 50% 14%, rgba(255,166,98,.5), transparent 66%)',
      'radial-gradient(90% 32% at 50% 44%, rgba(255,104,110,.3), transparent 72%)',
      'linear-gradient(180deg, #3c1a3e 0%, #6a2846 38%, #2a1030 74%, #100818 100%)',
    ].join(', '),
  },
  {
    id: 'moonsea',
    name: '月海',
    tint: '#a9c8ff',
    css: [
      'radial-gradient(18% 12% at 72% 16%, rgba(235,242,255,.85), rgba(235,242,255,.12) 60%, transparent 72%)',
      'radial-gradient(60% 30% at 72% 62%, rgba(150,190,255,.22), transparent 70%)',
      'linear-gradient(180deg, #0d1730 0%, #12204a 48%, #060b18 100%)',
    ].join(', '),
  },
  {
    id: 'velvet',
    name: '丝绒',
    tint: '#e0b8ff',
    css: [
      'radial-gradient(80% 55% at 50% 0%, rgba(190,120,255,.35), transparent 66%)',
      'radial-gradient(60% 46% at 88% 60%, rgba(255,120,200,.18), transparent 70%)',
      'linear-gradient(180deg, #291238 0%, #1d0d33 52%, #0d0618 100%)',
    ].join(', '),
  },
];

const compactCompanionHudText = (value: string | undefined, fallback: string, limit = 54): string => {
  const clean = (value || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return fallback;
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
};

// ── 打字机：台词逐字浮现（按真实流逝时间推进；用 interval 而不是 rAF，
// 页面暂时不合成帧（后台/锁屏）也能走完，回到前台不会卡在半截）──
const useTypewriter = (text: string, charsPerSecond = 24): { shown: string; done: boolean } => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    if (!text) return;
    const startedAt = window.performance.now();
    const timer = window.setInterval(() => {
      const chars = 1 + Math.floor((window.performance.now() - startedAt) / (1000 / charsPerSecond));
      setCount(Math.min(text.length, chars));
      if (chars >= text.length) window.clearInterval(timer);
    }, 42);
    return () => window.clearInterval(timer);
  }, [text, charsPerSecond]);
  return { shown: text.slice(0, count), done: count >= text.length };
};

interface CompanionLine {
  text: string;
  translation?: string;
  label: string;
  kind: 'startup' | 'touch';
}

const companionPerformanceCueText = (line: string, translation = '') => (
  `${line.trim()}\u0000${translation.trim()}`
);

const companionPerformanceCuePackMatches = (
  line: string,
  translation: string,
  cueText: string | undefined,
  cues: readonly AvatarPerformanceCue[] | undefined,
): boolean => {
  const expected = splitCompanionPerformanceSentences(translation.trim() || line.trim()).length;
  return expected > 0
    && cueText === companionPerformanceCueText(line, translation)
    && cues?.length === expected;
};

const companionLineFallbackDuration = (textLength: number) => (
  Math.max(2_400, Math.min(12_000, textLength * 115))
);

// A desktop navigation round trip remounts Launcher. Startup is a boot moment,
// not an App-return transition, so remember which character already performed
// it for the lifetime of this page session.
const companionStartupPlayedThisSession = new Set<string>();
const COMPANION_WARDROBE_DISCOVERY_KEY = 'sully-companion-wardrobe-discovery-v1';

const COMPANION_BOOT_LOCK_PERFORMANCE: AvatarPerformanceDirection = {
  emotion: 'calm',
  gesture: 'idle',
  camera: 'medium',
  gaze: 'viewer',
  intensity: 0.4,
  precision: {
    lockAutonomy: true,
    lockHead: true,
    headX: 0,
    headY: 0,
    headZ: 0,
    eyeX: 0,
    eyeY: 0,
    bodyX: 0,
    bodyY: 0,
    bodyZ: 0,
    overshoot: 0,
    settleMs: 320,
  },
};

const COMPANION_STAR_APPS: Array<{
  id: AppID;
  label: string;
  icon: keyof typeof Icons;
}> = INSTALLED_APPS
  .filter(app => app.id !== AppID.CharCreatorDev || import.meta.env.DEV)
  .map(app => ({ id: app.id, label: app.name, icon: app.icon as keyof typeof Icons }));

const CompanionHome: React.FC = () => {
  const {
    characters,
    activeCharacterId,
    setActiveCharacterId,
    apiConfig,
    userProfile,
    openApp,
    addToast,
    theme,
    virtualTime,
    updateCharacter,
    isDataLoaded,
    lastMsgTimestamp,
  } = useOS();
  const character = useMemo(
    () => characters.find(item => item.id === activeCharacterId) || characters[0] || null,
    [characters, activeCharacterId],
  );
  const activeCompanionSource = companionAvatarSource(character);
  const staticCompanionActive = activeCompanionSource === 'upload' || activeCompanionSource === 'date';
  const [motionState, setMotionState] = useState<AvatarMotionState>('idle');
  const startupAlreadyPlayed = Boolean(character && companionStartupPlayedThisSession.has(character.id));
  const [performance, setPerformance] = useState<AvatarPerformanceDirection>(() => (
    startupAlreadyPlayed ? DEFAULT_AVATAR_PERFORMANCE : COMPANION_BOOT_LOCK_PERFORMANCE
  ));
  const [startupHeadLocked, setStartupHeadLocked] = useState(() => !startupAlreadyPlayed);
  const [line, setLine] = useState<CompanionLine | null>(null);
  const [lastHit, setLastHit] = useState<AvatarTouchHit | null>(null);
  const [ripple, setRipple] = useState<{ nonce: number; x: number; y: number; force: number } | null>(null);
  const [touchBanner, setTouchBanner] = useState<{ nonce: number; text: string; x: number; y: number } | null>(null);
  const [touchSettingsOpen, setTouchSettingsOpen] = useState(false);
  const [appStarOpen, setAppStarOpen] = useState(false);
  const [scheduleViewerOpen, setScheduleViewerOpen] = useState(false);
  const [wardrobeOpen, setWardrobeOpen] = useState(false);
  const [wardrobeDiscoveryActive, setWardrobeDiscoveryActive] = useState(() => {
    try { return localStorage.getItem(COMPANION_WARDROBE_DISCOVERY_KEY) !== 'seen'; }
    catch { return true; }
  });
  const [wardrobeDiscoveryOpened, setWardrobeDiscoveryOpened] = useState(false);
  const [wardrobeTrigger, setWardrobeTrigger] = useState<Live2DActionTrigger | null>(null);
  const [wardrobeImportBusy, setWardrobeImportBusy] = useState(false);
  const [wardrobeLive2DSettings, setWardrobeLive2DSettings] = useState<Live2DAvatarConfig | null>(null);
  const [touchGenerating, setTouchGenerating] = useState(false);
  const [touchGenerateVoice, setTouchGenerateVoice] = useState(false);
  const [startupEnabled, setStartupEnabled] = useState(false);
  const [startupSettingsExpanded, setStartupSettingsExpanded] = useState(false);
  const [startupLine, setStartupLine] = useState('');
  const [startupTranslation, setStartupTranslation] = useState('');
  const [startupVoiceLanguage, setStartupVoiceLanguage] = useState('');
  const [touchVoiceLanguage, setTouchVoiceLanguage] = useState('');
  const [startupPerformance, setStartupPerformance] = useState<AvatarPerformanceDirection>(DEFAULT_COMPANION_STARTUP_PERFORMANCE);
  const [startupPerformanceCues, setStartupPerformanceCues] = useState<AvatarPerformanceCue[]>([]);
  const [startupPerformanceCueText, setStartupPerformanceCueText] = useState('');
  const [startupPerformanceCueIndex, setStartupPerformanceCueIndex] = useState(0);
  const [startupPerformanceCuePhase, setStartupPerformanceCuePhase] = useState<'start' | 'end'>('start');
  const [startupActionGenerating, setStartupActionGenerating] = useState(false);
  const [startupVoiceGenerating, setStartupVoiceGenerating] = useState(false);
  const [startupPresetName, setStartupPresetName] = useState('');
  const [touchPresetName, setTouchPresetName] = useState('');
  const [selectedStartupPresetId, setSelectedStartupPresetId] = useState('');
  const [selectedTouchPresetId, setSelectedTouchPresetId] = useState('');
  const [stageReady, setStageReady] = useState(() => staticCompanionActive || !character?.videoAvatar);
  const [stageCurtainPhase, setStageCurtainPhase] = useState<CompanionStageCurtainPhase>(() => (
    !staticCompanionActive && character?.videoAvatar ? 'covered' : 'hidden'
  ));
  const [touchVoiceProgress, setTouchVoiceProgress] = useState<{ completed: number; total: number } | null>(null);
  const settingsGenerating = startupActionGenerating || startupVoiceGenerating || touchGenerating;
  const [touchDraftZones, setTouchDraftZones] = useState<AvatarTouchZone[]>(DEFAULT_COMPANION_TOUCH_ZONES);
  const [vrmExpressions, setVrmExpressions] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [editingPanel, setEditingPanel] = useState<'character' | 'stage'>('character');
  const [compositionEditorCollapsed, setCompositionEditorCollapsed] = useState(false);
  const [compositionFramingMode, setCompositionFramingMode] = useState<'base' | 'face' | 'touch'>('base');
  const [framingDraft, setFramingDraft] = useState<AvatarStageFraming>(() => character?.videoAvatar?.companionFraming || DEFAULT_STAGE_FRAMING);
  const [faceFramingDraft, setFaceFramingDraft] = useState<AvatarStageFraming>(() => character?.videoAvatar?.faceFraming || { scale: 1.8, offsetX: 0, offsetY: 0 });
  const [faceAnchorDraftEnabled, setFaceAnchorDraftEnabled] = useState(() => Boolean(character?.videoAvatar?.faceFraming));
  const [touchRegionsDraft, setTouchRegionsDraft] = useState<AvatarTouchRegion[]>(() => character?.videoAvatar?.format === 'live2d' ? character.videoAvatar.touchRegions || [] : []);
  const [touchRegionEditingZone, setTouchRegionEditingZone] = useState<AvatarTouchZone>('face');
  const [cropDraft, setCropDraft] = useState<AvatarStageCrop>(() => character?.videoAvatar?.companionCrop || DEFAULT_STAGE_CROP);
  const [frameStyle, setFrameStyle] = useState<CompanionFrameStyleId>(loadCompanionFrameStyle);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const busyRef = useRef(false);
  const lastTouchAtRef = useRef(0);
  const requestTokenRef = useRef(0);
  const touchCursorRef = useRef<Partial<Record<AvatarTouchZone, number>>>({});
  const mountedRef = useRef(true);
  const settleTimerRef = useRef<number | null>(null);
  const performanceCueTimersRef = useRef<number[]>([]);
  const touchBannerTimerRef = useRef<number | null>(null);
  const touchDialogueTimerRef = useRef<number | null>(null);
  const touchVoiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const touchVoiceUrlRef = useRef<string | null>(null);
  const touchVoiceNonceRef = useRef(0);
  const restoredWardrobeKeyRef = useRef('');
  const companionAudioFeedRef = useRef<CallAudioFeed | null>(null);
  const stageCurtainStartedAtRef = useRef(typeof window !== 'undefined' ? window.performance.now() : 0);
  const stageCurtainOpenTimerRef = useRef<number | null>(null);
  const stageCurtainHideTimerRef = useRef<number | null>(null);
  const stageCurtainGenerationRef = useRef(0);
  const stageCurtainPhaseRef = useRef<CompanionStageCurtainPhase>(stageCurtainPhase);
  stageCurtainPhaseRef.current = stageCurtainPhase;
  const getCompanionAudioFeed = () => {
    if (!companionAudioFeedRef.current) companionAudioFeedRef.current = new CallAudioFeed();
    return companionAudioFeedRef.current;
  };

  useEffect(() => {
    const avatar = character?.videoAvatar;
    if (!stageReady || avatar?.format !== 'live2d' || !avatar.activeWardrobeActionId) return;
    const action = avatar.actions.find(item => item.id === avatar.activeWardrobeActionId && item.wardrobe);
    if (!action) return;
    const restoreKey = `${character.id}:${avatar.assetId}:${action.id}`;
    if (restoredWardrobeKeyRef.current === restoreKey) return;
    restoredWardrobeKeyRef.current = restoreKey;
    setWardrobeTrigger({ id: action.id, nonce: Date.now() + Math.random() });
  }, [character, stageReady]);

  useEffect(() => {
    const handleFrameStyle = (event: Event) => {
      setFrameStyle((event as CustomEvent<CompanionFrameStyleId>).detail || loadCompanionFrameStyle());
    };
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === COMPANION_FRAME_STYLE_KEY) setFrameStyle(loadCompanionFrameStyle());
    };
    window.addEventListener(COMPANION_FRAME_STYLE_EVENT, handleFrameStyle);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(COMPANION_FRAME_STYLE_EVENT, handleFrameStyle);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const period = periodForHour(virtualTime.hours);
  const characterDateKey = useLocalDateKey(resolveCharTimeZone(character));
  const [hudContent, setHudContent] = useState<{ thought: string; recentChat: string; schedule: DailySchedule | null }>({
    thought: '',
    recentChat: '',
    schedule: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!isDataLoaded || !character) {
      setHudContent({ thought: '', recentChat: '', schedule: null });
      return () => { cancelled = true; };
    }
    void Promise.all([
      DB.getRecentMessagesWithCount(character.id, 1, message =>
        isChatPreviewMessage(message)
        && message.role === 'assistant'
        && (!message.type || message.type === 'text')
        && typeof message.content === 'string'
        && !!message.content.trim(),
      ),
      getDailyScheduleForChar(character),
    ]).then(([recent, schedule]) => {
      if (cancelled) return;
      const latestAssistant = recent.messages[0];
      const scheduleThought = schedule?.flowNarrative?.[
        getFlowNarrativeKey(getScheduleWallClock(character).getHours())
      ];
      setHudContent({
        thought: compactCompanionHudText(getLastInnerState(character.id) || scheduleThought, '尚未记录心声'),
        recentChat: compactCompanionHudText(latestAssistant?.content, '还没有聊天记录'),
        schedule,
      });
    }).catch(() => {
      if (!cancelled) {
        setHudContent({ thought: '', recentChat: '还没有聊天记录', schedule: null });
      }
    });
    return () => { cancelled = true; };
  }, [character?.id, character?.customTimezoneEnabled, character?.customTimezone, characterDateKey, isDataLoaded, lastMsgTimestamp, period.key]);

  const currentScheduleSlot = useMemo(() => {
    const slots = hudContent.schedule?.slots || [];
    if (!slots.length) return null;
    const index = getCurrentScheduleSlotIndex(slots, character);
    return slots[index >= 0 ? index : 0] || null;
  }, [character, hudContent.schedule, virtualTime.hours, virtualTime.minutes]);

  const todayEventProgress = useMemo(() => {
    const wallClock = getScheduleWallClock(character);
    const elapsedMinutes = wallClock.getHours() * 60 + wallClock.getMinutes();
    return Math.max(0, Math.min(100, Math.round((elapsedMinutes / (24 * 60)) * 100)));
  }, [character, virtualTime.hours, virtualTime.minutes]);

  const stopTouchVoice = () => {
    companionAudioFeedRef.current?.setActive(false);
    if (touchVoiceAudioRef.current) {
      touchVoiceAudioRef.current.onplay = null;
      touchVoiceAudioRef.current.onpause = null;
      touchVoiceAudioRef.current.onended = null;
      touchVoiceAudioRef.current.onerror = null;
      touchVoiceAudioRef.current.onloadedmetadata = null;
      touchVoiceAudioRef.current.pause();
      touchVoiceAudioRef.current.src = '';
    }
    if (touchVoiceUrlRef.current) {
      URL.revokeObjectURL(touchVoiceUrlRef.current);
      touchVoiceUrlRef.current = null;
    }
  };

  // ── 主色跟角色走：从头像提取主色相（跟电子宠物小窝同一套提取器）──
  // 头像存的是 blobref 令牌，令牌喂给 new Image() 只会静默加载失败（取色器 onerror → null），
  // 所以先解析成可加载的 URL 再取色（跟下面背景取色同一套路）。令牌没解析完时是 undefined，跳过。
  const avatarImageUrl = useBlobRefUrl(character?.avatar);
  const [charHue, setCharHue] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCharHue(null);
    if (!avatarImageUrl) return;
    void hueFromImage(avatarImageUrl).then(hue => {
      if (!cancelled && hue !== null) setCharHue(((Math.round(hue) % 360) + 360) % 360);
    });
    return () => { cancelled = true; };
  }, [avatarImageUrl]);

  // ── 背景：preset:<id> / blobref / http 直链；空 = 时段天光 ──
  const background = character?.companionBackground;
  const backgroundPreset = background?.startsWith('preset:')
    ? COMPANION_BG_PRESETS.find(preset => `preset:${preset.id}` === background) || null
    : null;
  const backgroundImageUrl = useBlobRefUrl(background && !background.startsWith('preset:') ? background : undefined);

  // UI 铬件主色：角色色优先，提不出来再落到场景/时段色。
  const [backgroundHue, setBackgroundHue] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setBackgroundHue(null);
    if (!backgroundImageUrl) return;
    void hueFromImage(backgroundImageUrl).then(hue => {
      if (!cancelled && hue !== null) setBackgroundHue(normalizeHue(Math.round(hue)));
    });
    return () => { cancelled = true; };
  }, [backgroundImageUrl]);

  const presetHue = useMemo(
    () => backgroundPreset ? hueFromGradient(backgroundPreset.css) : null,
    [backgroundPreset],
  );
  const palette = useMemo(() => {
    const baseHue = normalizeHue(theme.hue ?? 267);
    const saturation = Math.min(74, Math.max(32, theme.saturation ?? 46));
    const sceneHue = backgroundHue ?? presetHue ?? baseHue;
    const accentHue = charHue ?? sceneHue;
    const accentLightness = Math.min(78, Math.max(68, (theme.lightness ?? 64) + 7));
    return {
      accent: hslToHex(accentHue, Math.max(52, saturation), accentLightness),
      ambient: backgroundPreset?.tint || hslToHex(sceneHue, Math.max(44, saturation), 64),
      baseTop: hslToHex(baseHue, Math.max(34, saturation - 5), 16),
      baseMid: hslToHex(baseHue, Math.max(28, saturation - 11), 9),
      baseBottom: hslToHex(baseHue, Math.max(24, saturation - 15), 4),
      panelTop: hslToHex(accentHue, Math.max(28, saturation - 17), 16),
      panelBottom: hslToHex(accentHue, Math.max(25, saturation - 20), 8),
      shadow: hslToHex(accentHue, Math.max(18, saturation - 27), 4),
    };
  }, [
    backgroundHue,
    backgroundPreset?.tint,
    charHue,
    presetHue,
    theme.hue,
    theme.lightness,
    theme.saturation,
  ]);

  // Keep these as hex because stage/chrome effects append an alpha suffix.
  const uiTint = palette.accent;
  // 氛围色（粒子/地面辉光）：预设场景用场景色，否则时段色。
  const ambientTint = palette.ambient;

  const clearStageCurtainTimers = () => {
    if (stageCurtainOpenTimerRef.current !== null) window.clearTimeout(stageCurtainOpenTimerRef.current);
    if (stageCurtainHideTimerRef.current !== null) window.clearTimeout(stageCurtainHideTimerRef.current);
    stageCurtainOpenTimerRef.current = null;
    stageCurtainHideTimerRef.current = null;
  };

  const handleStageModelReady = () => {
    if (stageCurtainPhaseRef.current === 'hidden') {
      setStageReady(true);
      return;
    }
    clearStageCurtainTimers();
    const generation = ++stageCurtainGenerationRef.current;
    const elapsed = window.performance.now() - stageCurtainStartedAtRef.current;
    // onReady happens after the renderer has its model, but the browser can still
    // present one stale oversized frame. Keep two visual beats of quiet before opening.
    const settleDelay = Math.max(180, 720 - elapsed);
    stageCurtainOpenTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current || generation !== stageCurtainGenerationRef.current) return;
      stageCurtainPhaseRef.current = 'opening';
      setStageCurtainPhase('opening');
      stageCurtainHideTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current || generation !== stageCurtainGenerationRef.current) return;
        stageCurtainPhaseRef.current = 'hidden';
        setStageCurtainPhase('hidden');
        setStageReady(true);
        stageCurtainHideTimerRef.current = null;
      }, 640);
      stageCurtainOpenTimerRef.current = null;
    }, settleDelay);
  };

  const handleStageModelError = () => {
    clearStageCurtainTimers();
    stageCurtainGenerationRef.current += 1;
    stageCurtainPhaseRef.current = 'hidden';
    setStageCurtainPhase('hidden');
    setStageReady(false);
  };

  useEffect(() => {
    // StrictMode 会「装载→卸载→再装载」跑一遍 effect：cleanup 把 mounted 打成
    // false 后必须在 effect 体里设回 true，否则 dev 下开场演出和触碰回应全被吞。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      performanceCueTimersRef.current.forEach(timer => window.clearTimeout(timer));
      performanceCueTimersRef.current = [];
      if (touchBannerTimerRef.current !== null) window.clearTimeout(touchBannerTimerRef.current);
      if (touchDialogueTimerRef.current !== null) window.clearTimeout(touchDialogueTimerRef.current);
      clearStageCurtainTimers();
      touchVoiceNonceRef.current = 0;
      stopTouchVoice();
      companionAudioFeedRef.current?.dispose();
      companionAudioFeedRef.current = null;
      touchVoiceAudioRef.current = null;
    };
  }, []);
  useEffect(() => {
    requestTokenRef.current += 1;
    busyRef.current = false;
    setLine(null);
    setLastHit(null);
    setTouchBanner(null);
    setTouchSettingsOpen(false);
    setStartupSettingsExpanded(false);
    setAppStarOpen(false);
    if (touchDialogueTimerRef.current !== null) window.clearTimeout(touchDialogueTimerRef.current);
    performanceCueTimersRef.current.forEach(timer => window.clearTimeout(timer));
    performanceCueTimersRef.current = [];
    setTouchGenerating(false);
    setTouchVoiceProgress(null);
    setTouchGenerateVoice(Boolean(character?.companionTouchSettings?.voiceEnabled));
    setTouchVoiceLanguage(character?.companionTouchSettings?.voiceLanguage || '');
    const activeStartupPreset = character?.companionTouchSettings?.startupPresets?.find(
      preset => preset.id === character.companionTouchSettings?.activeStartupPresetId,
    );
    const activeTouchPreset = character?.companionTouchSettings?.touchPresets?.find(
      preset => preset.id === character.companionTouchSettings?.activeTouchPresetId,
    );
    setSelectedStartupPresetId(activeStartupPreset?.id || '');
    setStartupPresetName(activeStartupPreset?.name || '');
    setSelectedTouchPresetId(activeTouchPreset?.id || '');
    setTouchPresetName(activeTouchPreset?.name || '');
    const startup = character?.companionTouchSettings?.startup;
    setStartupEnabled(Boolean(startup?.enabled));
    setStartupLine(startup?.line || '');
    setStartupTranslation(startup?.translation || '');
    setStartupVoiceLanguage(startup?.voiceLanguage || '');
    setStartupPerformance(normalizeCompanionStartupPerformance(startup?.performance));
    setStartupPerformanceCues((startup?.performanceCues || []) as AvatarPerformanceCue[]);
    setStartupPerformanceCueText(startup?.performanceCueText || '');
    setStartupPerformanceCueIndex(0);
    setStartupActionGenerating(false);
    setStartupVoiceGenerating(false);
    const shouldPrepareStartup = Boolean(character && !companionStartupPlayedThisSession.has(character.id));
    setStartupHeadLocked(shouldPrepareStartup);
    setTouchDraftZones((character?.companionTouchSettings?.enabledZones as AvatarTouchZone[] | undefined) || DEFAULT_COMPANION_TOUCH_ZONES);
    touchVoiceNonceRef.current = 0;
    stopTouchVoice();
    touchCursorRef.current = {};
    setVrmExpressions([]);
    setEditing(false);
    setEditingPanel('character');
    setCompositionFramingMode('base');
    setFramingDraft(character?.videoAvatar?.companionFraming || (isBuiltinSullyLive2D(character?.videoAvatar) ? { ...BUILTIN_SULLY_DEFAULT_FRAMING } : DEFAULT_STAGE_FRAMING));
    setFaceFramingDraft(character?.videoAvatar?.faceFraming || { scale: 1.8, offsetX: 0, offsetY: 0 });
    setFaceAnchorDraftEnabled(Boolean(character?.videoAvatar?.faceFraming));
    setTouchRegionsDraft(character?.videoAvatar?.format === 'live2d' ? character.videoAvatar.touchRegions || [] : []);
    setTouchRegionEditingZone('face');
    setCropDraft(character?.videoAvatar?.companionCrop || DEFAULT_STAGE_CROP);
    setPerformance(shouldPrepareStartup
      ? (startup?.enabled && normalizeCompanionDialogue(startup.line, character?.name || '')
        ? normalizeCompanionStartupPerformance(startup.performance)
        : COMPANION_BOOT_LOCK_PERFORMANCE)
      : DEFAULT_AVATAR_PERFORMANCE);
    setMotionState('idle');
  }, [character?.id]);

  useEffect(() => {
    clearStageCurtainTimers();
    stageCurtainGenerationRef.current += 1;
    const hasModel = Boolean(!staticCompanionActive && character?.videoAvatar);
    const nextPhase: CompanionStageCurtainPhase = hasModel ? 'covered' : 'hidden';
    stageCurtainStartedAtRef.current = window.performance.now();
    stageCurtainPhaseRef.current = nextPhase;
    setStageCurtainPhase(nextPhase);
    setStageReady(!hasModel);
    return clearStageCurtainTimers;
  }, [character?.id, character?.videoAvatar?.assetId, character?.videoAvatar?.format, activeCompanionSource, staticCompanionActive]);

  const clearCompanionPerformanceCues = () => {
    performanceCueTimersRef.current.forEach(timer => window.clearTimeout(timer));
    performanceCueTimersRef.current = [];
  };

  const scheduleCompanionPerformanceCues = (
    cues: AvatarPerformanceCue[] | undefined,
    durationMs: number,
  ) => {
    clearCompanionPerformanceCues();
    if (!cues?.length) return;
    expandAvatarPerformanceCueBeats(cues, durationMs).forEach(beat => {
      const direction = normalizeCompanionStartupPerformance(beat.direction);
      if (beat.delayMs <= 40) {
        setPerformance(direction);
        return;
      }
      performanceCueTimersRef.current.push(window.setTimeout(() => {
        setPerformance(direction);
      }, beat.delayMs));
    });
  };

  const settleAfter = (textLength: number, releaseStartupHeadLock = false) => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      clearCompanionPerformanceCues();
      setMotionState('idle');
      setPerformance(DEFAULT_AVATAR_PERFORMANCE);
      if (releaseStartupHeadLock) setStartupHeadLocked(false);
    }, companionLineFallbackDuration(textLength));
  };

  // Keep the centered boot lock until the actual model is ready. This also
  // overrides head turns authored inside a Live2D Idle motion.
  useEffect(() => {
    if (!character || !stageReady) return;
    if (companionStartupPlayedThisSession.has(character.id)) {
      clearCompanionPerformanceCues();
      setStartupHeadLocked(false);
      setPerformance(DEFAULT_AVATAR_PERFORMANCE);
      setMotionState('idle');
      return;
    }
    companionStartupPlayedThisSession.add(character.id);
    const startup = character?.companionTouchSettings?.startup;
    const text = normalizeCompanionDialogue(startup?.line || '', character?.name || '');
    const translation = normalizeCompanionDialogue(startup?.translation || '', character?.name || '');
    const spokenText = translation || text;
    const cues = companionPerformanceCuePackMatches(text, translation, startup?.performanceCueText, startup?.performanceCues as AvatarPerformanceCue[] | undefined)
      ? startup.performanceCues as AvatarPerformanceCue[] | undefined
      : undefined;
    const timer = window.setTimeout(() => {
      if (!mountedRef.current || busyRef.current || editingRef.current) return;
      if (!startup?.enabled || !text) {
        clearCompanionPerformanceCues();
        setStartupHeadLocked(false);
        setPerformance(DEFAULT_AVATAR_PERFORMANCE);
        setMotionState('idle');
        return;
      }
      setStartupHeadLocked(true);
      setLine({ text, translation: translation || undefined, label: '开场演出', kind: 'startup' });
      setPerformance(normalizeCompanionStartupPerformance(cues?.[0]?.direction || startup.performance));
      setMotionState('speaking');
      scheduleCompanionPerformanceCues(cues, companionLineFallbackDuration(text.length));
      const voiceText = normalizeCompanionDialogue(startup.voiceText || '', character.name);
      const voiceLanguageMatches = (startup.voiceGeneratedLanguage || '') === (startup.voiceLanguage || '');
      if (startup.voiceAssetId && voiceText === spokenText && voiceLanguageMatches) {
        const nonce = Date.now();
        touchVoiceNonceRef.current = nonce;
        void playPersistedCompanionVoice(startup, nonce, 'startup', cues);
      }
      settleAfter(text.length, true);
    }, 320);
    return () => window.clearTimeout(timer);
  }, [character?.id, stageReady]);

  const accentColor = palette.accent;
  const staticPortraitValue = useMemo(
    () => character ? resolveCompanionPortrait(character, performance.emotion, performance.faces || []) : undefined,
    [character, performance.emotion, performance.faces],
  );
  const touchPackContentLabel = activeCompanionSource === 'upload'
    ? '台词'
    : activeCompanionSource === 'date' ? '台词与表情' : '台词与动作';
  const modelActions = useMemo<AvatarTouchModelAction[]>(() => {
    if (staticCompanionActive) return [];
    if (character?.videoAvatar?.format === 'live2d') {
      return getLive2DAIActions(character.videoAvatar)
        .map(action => ({
          id: action.id,
          name: action.name,
          kind: action.kind,
          tags: action.tags,
        }));
    }
    return vrmExpressions.map(name => ({ id: name, name: `自定义表情：${name}` }));
  }, [character?.videoAvatar, staticCompanionActive, vrmExpressions]);
  const wardrobeActions = useMemo(
    () => !staticCompanionActive && character?.videoAvatar?.format === 'live2d' ? getLive2DWardrobeActions(character.videoAvatar) : [],
    [character?.videoAvatar, staticCompanionActive],
  );
  const modelOutfits = useMemo(
    () => !staticCompanionActive ? listCompanionModelOutfits(character) : [],
    [character?.videoAvatar, character?.videoAvatarWardrobe, staticCompanionActive],
  );
  const staticOutfits = useMemo(
    () => activeCompanionSource === 'date'
      ? listCompanionDateOutfits(character)
      : activeCompanionSource === 'upload'
        ? listUploadedCompanionOutfits(character?.companionAvatar).map(outfit => ({
            id: outfit.imageRef,
            name: outfit.fileName || '图片 / GIF',
            preview: outfit.imageRef,
            expressionCount: 1,
          }))
        : [],
    [activeCompanionSource, character],
  );
  const activeStaticOutfitId = activeCompanionSource === 'upload'
    ? character?.companionAvatar?.imageRef
    : normalizeCompanionSkinSetId(character?.companionAvatar?.skinSetId);

  const selectWardrobeAction = (action: Live2DAction) => {
    if (!character || character.videoAvatar?.format !== 'live2d' || !action.wardrobe) return;
    setWardrobeTrigger({ id: action.id, nonce: Date.now() + Math.random() });
    updateCharacter(character.id, {
      videoAvatar: { ...character.videoAvatar, activeWardrobeActionId: action.id },
    });
    addToast(`已手动切换：${action.name}`, 'success');
  };

  const selectStaticOutfit = (outfitId: string) => {
    if (!character) return;
    if (activeCompanionSource === 'upload') {
      const companionAvatar = selectUploadedCompanionOutfit(character.companionAvatar, outfitId);
      if (!companionAvatar) return;
      updateCharacter(character.id, { companionAvatar });
      addToast('静态衣服已切换', 'success');
      return;
    }
    if (activeCompanionSource !== 'date') return;
    updateCharacter(character.id, {
      companionAvatar: {
        version: 1,
        ...character.companionAvatar,
        source: 'date',
        skinSetId: companionSkinSetPatchValue(outfitId),
      },
    });
    trackEvent('切换桌面见面立绘衣服');
    addToast('桌面衣服已切换', 'success');
  };

  const selectModelOutfit = (assetId: string) => {
    if (!character) return;
    const patch = selectCompanionModelOutfit(character, assetId);
    if (!patch) return;
    closeWardrobe();
    setWardrobeTrigger(null);
    updateCharacter(character.id, {
      ...patch,
      companionAvatar: { version: 1, ...character.companionAvatar, source: 'model' },
    });
    addToast(`已切换模型：${patch.videoAvatar?.fileName || '当前外观'}`, 'success');
  };

  const deleteModelOutfit = async (assetId: string) => {
    if (!character) return;
    const removed = listCompanionModelOutfits(character).find(model => model.assetId === assetId);
    if (!removed || (removed.format === 'live2d' && removed.builtIn)) return;
    const patch = removeCompanionModelOutfit(character, assetId);
    if (!patch) return;
    const removingActive = character.videoAvatar?.assetId === assetId;
    const fallbackSource = patch.videoAvatar
      ? 'model'
      : character.companionAvatar?.imageRef
        ? 'upload'
        : listCompanionDateOutfits(character).length
          ? 'date'
          : 'model';
    const companionAvatar = character.companionAvatar?.source === 'model'
      ? { ...character.companionAvatar, version: 1 as const, source: fallbackSource as 'model' | 'upload' | 'date' }
      : character.companionAvatar;
    const nextCharacter = { ...character, ...patch, companionAvatar };
    if (removingActive) {
      closeWardrobe();
      setWardrobeTrigger(null);
    }
    updateCharacter(character.id, { ...patch, companionAvatar });
    // Persist the pointer removal before reclaiming the binary package.
    await DB.saveCharacter(nextCharacter);
    const usedElsewhere = characters.some(item => item.id !== character.id && (
      item.videoAvatar?.assetId === assetId
      || (item.videoAvatarWardrobe || []).some(model => model.assetId === assetId)
    ));
    if (!usedElsewhere) await deleteAvatarModel(removed);
    addToast(`${removed.fileName} 已从衣橱删除${usedElsewhere ? '（共享模型文件仍保留）' : ''}`, 'success');
  };

  const deleteStaticOutfit = async (imageRef: string) => {
    if (!character || activeCompanionSource !== 'upload') return;
    const removed = listUploadedCompanionOutfits(character.companionAvatar).find(item => item.imageRef === imageRef);
    const companionAvatar = removeUploadedCompanionOutfit(character.companionAvatar, imageRef);
    if (!removed || !companionAvatar) return;
    const nextCharacter = { ...character, companionAvatar };
    updateCharacter(character.id, { companionAvatar });
    await DB.saveCharacter(nextCharacter);
    const usedElsewhere = characters.some(item => item.id !== character.id && (
      item.avatar === imageRef
      || item.companionAvatar?.imageRef === imageRef
      || (item.companionAvatar?.imageWardrobe || []).some(outfit => outfit.imageRef === imageRef)
      || Object.values(item.sprites || {}).includes(imageRef)
      || (item.dateSkinSets || []).some(skin => Object.values(skin.sprites).includes(imageRef))
    ));
    if (!usedElsewhere) await deleteBlobRefIfUnreferenced(imageRef);
    addToast(`${removed.fileName || '图片 / GIF'} 已从衣橱删除${usedElsewhere ? '（共享图片文件仍保留）' : ''}`, 'success');
  };

  const deleteWardrobeAction = async (actionId: string) => {
    if (!character || character.videoAvatar?.format !== 'live2d') return;
    const action = character.videoAvatar.actions.find(item => item.id === actionId && item.wardrobe);
    if (!action) return;
    const videoAvatar = removeLive2DWardrobeAction(character.videoAvatar, actionId);
    setWardrobeTrigger(videoAvatar.activeWardrobeActionId
      ? { id: videoAvatar.activeWardrobeActionId, nonce: Date.now() + Math.random() }
      : null);
    updateCharacter(character.id, { videoAvatar });
    addToast(`${action.name} 已从衣橱移除；动作库仍保留`, 'success');
  };

  const importWardrobeOutfit = () => {
    if (!character || wardrobeImportBusy || activeCompanionSource === 'date') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    input.accept = activeCompanionSource === 'upload'
      ? '.png,.gif,image/png,image/gif'
      : character.videoAvatar?.format === 'vrm'
        ? '.vrm,model/gltf-binary'
        : '.zip,application/zip';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      setWardrobeImportBusy(true);
      try {
        if (activeCompanionSource === 'upload') {
          const extension = file.name.split('.').pop()?.toLowerCase();
          if (!['png', 'gif'].includes(extension || '') || !['image/png', 'image/gif'].includes(file.type)) {
            throw new Error('图片衣橱只支持 PNG / GIF');
          }
          if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请压缩后再导入');
          const imageRef = await putImageBlob(file);
          updateCharacter(character.id, {
            companionAvatar: addUploadedCompanionOutfit(character.companionAvatar, {
              id: imageRef,
              imageRef,
              fileName: file.name,
              mimeType: file.type,
              importedAt: Date.now(),
            }),
          });
          addToast(`${file.name} 已加入图片衣橱`, 'success');
          return;
        }

        const currentModel = character.videoAvatar;
        if (!currentModel) throw new Error('请先设置一个动态模型');
        if (currentModel.format === 'live2d') {
          if (!/\.zip$/i.test(file.name)) throw new Error('Live2D 衣橱只能继续导入 Live2D ZIP');
          if (file.size > 200 * 1024 * 1024) throw new Error('Live2D ZIP 超过 200 MB');
          const model = await saveLive2DModelFromZip(file);
          const patch = storeCompanionModelOutfit(character, model);
          updateCharacter(character.id, {
            ...patch,
            companionAvatar: { version: 1, ...character.companionAvatar, source: 'model' },
          });
          closeWardrobe();
          setWardrobeLive2DSettings(model);
          addToast(`${file.name} 已加入 Live2D 衣橱，请设置它的换装按键`, 'success');
          return;
        }

        if (!/\.vrm$/i.test(file.name)) throw new Error('VRM 衣橱只能继续导入 VRM');
        if (file.size > 80 * 1024 * 1024) throw new Error('VRM 超过 80 MB，请降低纹理尺寸后再导入');
        const model = await saveAvatarModel(file);
        const patch = storeCompanionModelOutfit(character, model);
        updateCharacter(character.id, {
          ...patch,
          companionAvatar: { version: 1, ...character.companionAvatar, source: 'model' },
        });
        closeWardrobe();
        addToast(`${file.name} 已加入 VRM 衣橱`, 'success');
      } catch (error: any) {
        addToast(error?.message || '衣橱导入失败', 'error');
      } finally {
        setWardrobeImportBusy(false);
        removeInput();
      }
    };
    input.click();
  };

  const openWardrobe = () => {
    setAppStarOpen(false);
    if (wardrobeDiscoveryActive) {
      try { localStorage.setItem(COMPANION_WARDROBE_DISCOVERY_KEY, 'seen'); } catch { /* private WebView */ }
      setWardrobeDiscoveryActive(false);
      setWardrobeDiscoveryOpened(true);
    } else {
      setWardrobeDiscoveryOpened(false);
    }
    setWardrobeOpen(true);
  };
  const closeWardrobe = () => {
    setWardrobeOpen(false);
    setWardrobeDiscoveryOpened(false);
  };

  // ── 布置模式：构图在草稿里实时预览，只有点“保存”才写回角色。 ──
  const companionFraming = character?.videoAvatar?.companionFraming;
  const companionCrop = character?.videoAvatar?.companionCrop;
  const builtinSullyAvatar = isBuiltinSullyLive2D(character?.videoAvatar) ? character.videoAvatar : null;
  const defaultCompanionFraming: AvatarStageFraming = builtinSullyAvatar
    ? { ...BUILTIN_SULLY_DEFAULT_FRAMING }
    : DEFAULT_STAGE_FRAMING;
  const framingIsDefault = (framing: AvatarStageFraming) => (
    Math.abs(framing.scale - 1) <= 0.02
    && Math.abs(framing.offsetX) <= 0.01
    && Math.abs(framing.offsetY) <= 0.01
  );
  const cropIsDefault = (crop: AvatarStageCrop) => (
    crop.top <= 0.001 && crop.right <= 0.001 && crop.bottom <= 0.001 && crop.left <= 0.001
  );
  const makeFaceFramingSeed = (): AvatarStageFraming => {
    const base = companionFraming || defaultCompanionFraming;
    const maxScale = character?.videoAvatar?.format === 'live2d' ? 6 : 4;
    return character?.videoAvatar?.faceFraming || {
      ...base,
      scale: Math.min(maxScale, Math.max(1.8, base.scale * 1.8)),
    };
  };
  const openCompositionEditor = () => {
    closeWardrobe();
    setAppStarOpen(false);
    setLine(null);
    setPerformance(DEFAULT_AVATAR_PERFORMANCE);
    setMotionState('idle');
    setEditingPanel(staticCompanionActive ? 'stage' : 'character');
    setCompositionFramingMode('base');
    setFramingDraft(companionFraming || defaultCompanionFraming);
    setFaceFramingDraft(makeFaceFramingSeed());
    setFaceAnchorDraftEnabled(Boolean(character?.videoAvatar?.faceFraming));
    setTouchRegionsDraft(character?.videoAvatar?.format === 'live2d' ? character.videoAvatar.touchRegions || [] : []);
    setTouchRegionEditingZone('face');
    setCropDraft(companionCrop || DEFAULT_STAGE_CROP);
    setCompositionEditorCollapsed(false);
    setEditing(true);
  };
  const cancelCompositionEditor = () => {
    setFramingDraft(companionFraming || defaultCompanionFraming);
    setFaceFramingDraft(makeFaceFramingSeed());
    setFaceAnchorDraftEnabled(Boolean(character?.videoAvatar?.faceFraming));
    setTouchRegionsDraft(character?.videoAvatar?.format === 'live2d' ? character.videoAvatar.touchRegions || [] : []);
    setTouchRegionEditingZone('face');
    setCompositionFramingMode('base');
    setCropDraft(companionCrop || DEFAULT_STAGE_CROP);
    setCompositionEditorCollapsed(false);
    setEditing(false);
  };
  const saveCompositionEditor = () => {
    if (!character) return;
    updateCharacter(character.id, prev => (
      prev.videoAvatar ? {
        videoAvatar: {
          ...prev.videoAvatar,
          companionFraming: builtinSullyAvatar || !framingIsDefault(framingDraft) ? framingDraft : undefined,
          faceFraming: faceAnchorDraftEnabled ? faceFramingDraft : undefined,
          companionCrop: cropIsDefault(cropDraft) ? undefined : clampStageCrop(cropDraft),
          ...(prev.videoAvatar.format === 'live2d' ? { touchRegions: touchRegionsDraft.length ? touchRegionsDraft : undefined } : {}),
        },
      } : {}
    ));
    setCompositionFramingMode('base');
    setCompositionEditorCollapsed(false);
    setEditing(false);
    addToast(
      touchRegionsDraft.length
        ? `角色构图与 ${touchRegionsDraft.length} 个触摸圈已保存`
        : faceAnchorDraftEnabled ? '角色构图与面部特写锚点已保存' : '角色构图已保存',
      'success',
    );
  };
  const chooseBuiltinSullyQuality = (quality: BuiltinSullyLive2DQuality) => {
    if (!character || !builtinSullyAvatar || builtinSullyAvatar.builtinQuality === quality) return;
    updateCharacter(character.id, { videoAvatar: setBuiltinSullyLive2DQuality(builtinSullyAvatar, quality) });
    addToast(quality === 'hd' ? 'Sully 已切到高清 4K；低端设备建议使用 2K' : 'Sully 已切回轻量 2K', quality === 'hd' ? 'info' : 'success');
  };
  const chooseImportedLive2DTextureQuality = (quality: 'balanced' | 'hd') => {
    if (!character?.videoAvatar || character.videoAvatar.format !== 'live2d' || character.videoAvatar.builtIn) return;
    const current = character.videoAvatar.textureQuality === 'hd' ? 'hd' : 'balanced';
    if (current === quality) return;
    updateCharacter(character.id, prev => (
      prev.videoAvatar?.format === 'live2d' && !prev.videoAvatar.builtIn
        ? { videoAvatar: { ...prev.videoAvatar, textureQuality: quality } }
        : {}
    ));
    setStageReady(false);
    setStageCurtainPhase('covered');
    addToast(
      quality === 'hd'
        ? '模型已切到高清 4K；首次切换会建立独立运行缓存'
        : '模型已切回默认轻量 2K；更省内存、更不易闪退',
      quality === 'hd' ? 'info' : 'success',
    );
  };

  const chooseCompanionFrameStyle = (nextStyle: CompanionFrameStyleId) => {
    setFrameStyle(nextStyle);
    saveCompanionFrameStyle(nextStyle);
  };
  const applyCompanionBackground = async (value?: string) => {
    if (!character) return;
    const previous = character.companionBackground;
    updateCharacter(character.id, { companionBackground: value });
    // 背景令牌只被这个字段引用，替换/清除后旧 Blob 直接删掉，不留孤儿
    if (previous && isBlobRef(previous) && previous !== value) await deleteBlobRef(previous);
  };
  const chooseBackgroundImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      try {
        if (file.size > 20 * 1024 * 1024) {
          addToast('图片超过 20 MB，请压缩后再用作背景', 'error');
          return;
        }
        await applyCompanionBackground(await putImageBlob(file));
        addToast('桌面背景已更新', 'success');
      } catch (error: any) {
        addToast(error?.message || '背景导入失败', 'error');
      } finally {
        removeInput();
      }
    };
    input.click();
  };

  const showTouchBanner = (hit: AvatarTouchHit, text: string) => {
    setTouchBanner({ nonce: hit.nonce, text, x: hit.normalizedX, y: hit.normalizedY });
    if (touchBannerTimerRef.current !== null) window.clearTimeout(touchBannerTimerRef.current);
    touchBannerTimerRef.current = window.setTimeout(() => setTouchBanner(null), 1_650);
  };

  const openTouchSettings = () => {
    setAppStarOpen(false);
    setStartupSettingsExpanded(false);
    setTouchDraftZones(
      (character?.companionTouchSettings?.enabledZones as AvatarTouchZone[] | undefined)
      || DEFAULT_COMPANION_TOUCH_ZONES,
    );
    setTouchGenerateVoice(Boolean(character?.companionTouchSettings?.voiceEnabled));
    setTouchVoiceLanguage(character?.companionTouchSettings?.voiceLanguage || '');
    const activeStartupPreset = character?.companionTouchSettings?.startupPresets?.find(
      preset => preset.id === character.companionTouchSettings?.activeStartupPresetId,
    );
    const activeTouchPreset = character?.companionTouchSettings?.touchPresets?.find(
      preset => preset.id === character.companionTouchSettings?.activeTouchPresetId,
    );
    setSelectedStartupPresetId(activeStartupPreset?.id || '');
    setStartupPresetName(activeStartupPreset?.name || '');
    setSelectedTouchPresetId(activeTouchPreset?.id || '');
    setTouchPresetName(activeTouchPreset?.name || '');
    const startup = character?.companionTouchSettings?.startup;
    setStartupEnabled(Boolean(startup?.enabled));
    setStartupLine(startup?.line || '');
    setStartupTranslation(startup?.translation || '');
    setStartupVoiceLanguage(startup?.voiceLanguage || '');
    setStartupPerformance(normalizeCompanionStartupPerformance(startup?.performance));
    setStartupPerformanceCues((startup?.performanceCues || []) as AvatarPerformanceCue[]);
    setStartupPerformanceCueText(startup?.performanceCueText || '');
    setStartupPerformanceCueIndex(0);
    setTouchVoiceProgress(null);
    setTouchSettingsOpen(true);
  };

  const toggleTouchZone = (zone: AvatarTouchZone) => {
    setSelectedTouchPresetId('');
    setTouchDraftZones(current => (
      current.includes(zone)
        ? current.filter(item => item !== zone)
        : [...current, zone]
    ));
  };

  const companionTouchSettingsBase = (): CompanionTouchSettings => ({
    enabledZones: character?.companionTouchSettings?.enabledZones || DEFAULT_COMPANION_TOUCH_ZONES,
    reactions: character?.companionTouchSettings?.reactions || {},
    ...character?.companionTouchSettings,
  });

  const cleanupUnreferencedCompanionVoices = (
    before: CompanionTouchSettings | undefined,
    after: CompanionTouchSettings | undefined,
  ) => {
    const keep = collectCompanionVoiceAssetIds(after);
    collectCompanionVoiceAssetIds(before).forEach(assetId => {
      if (!keep.has(assetId)) {
        void deleteCompanionVoiceBlob(assetId).catch(error => {
          console.warn('[companion] unused preset voice cleanup skipped:', error);
        });
      }
    });
  };

  const loadStartupDraft = (startup?: CompanionStartupSettings) => {
    setStartupEnabled(Boolean(startup?.enabled));
    setStartupLine(startup?.line || '');
    setStartupTranslation(startup?.translation || '');
    setStartupVoiceLanguage(startup?.voiceLanguage || '');
    setStartupPerformance(normalizeCompanionStartupPerformance(startup?.performance));
    setStartupPerformanceCues((startup?.performanceCues || []) as AvatarPerformanceCue[]);
    setStartupPerformanceCueText(startup?.performanceCueText || '');
    setStartupPerformanceCueIndex(0);
    setStartupPerformanceCuePhase('start');
  };

  const selectStartupPreset = (presetId: string) => {
    if (!character || settingsGenerating) return;
    if (!presetId) {
      setSelectedStartupPresetId('');
      setStartupPresetName('');
      return;
    }
    const preset = character.companionTouchSettings?.startupPresets?.find(item => item.id === presetId);
    if (!preset) return;
    const before = companionTouchSettingsBase();
    const settings = activateCompanionStartupPreset(before, presetId);
    updateCharacter(character.id, { companionTouchSettings: settings });
    cleanupUnreferencedCompanionVoices(before, settings);
    loadStartupDraft(preset.startup);
    setSelectedStartupPresetId(preset.id);
    setStartupPresetName(preset.name);
    addToast(`已切换开场预设「${preset.name}」`, 'success');
  };

  const selectTouchPreset = (presetId: string) => {
    if (!character || settingsGenerating) return;
    if (!presetId) {
      setSelectedTouchPresetId('');
      setTouchPresetName('');
      return;
    }
    const preset = character.companionTouchSettings?.touchPresets?.find(item => item.id === presetId);
    if (!preset) return;
    const before = companionTouchSettingsBase();
    const settings = activateCompanionTouchPreset(before, presetId);
    updateCharacter(character.id, { companionTouchSettings: settings });
    cleanupUnreferencedCompanionVoices(before, settings);
    setTouchDraftZones(preset.enabledZones as AvatarTouchZone[]);
    setTouchVoiceLanguage(preset.voiceLanguage || '');
    setTouchGenerateVoice(Boolean(preset.voiceEnabled));
    setSelectedTouchPresetId(preset.id);
    setTouchPresetName(preset.name);
    touchCursorRef.current = {};
    addToast(`已切换触摸预设「${preset.name}」`, 'success');
  };

  const deleteStartupPreset = () => {
    if (!character || !selectedStartupPresetId || settingsGenerating) return;
    const preset = character.companionTouchSettings?.startupPresets?.find(item => item.id === selectedStartupPresetId);
    if (!preset || !window.confirm(`删除开场预设「${preset.name}」？`)) return;
    const before = companionTouchSettingsBase();
    const after = removeCompanionStartupPreset(before, selectedStartupPresetId);
    updateCharacter(character.id, { companionTouchSettings: after });
    cleanupUnreferencedCompanionVoices(before, after);
    setSelectedStartupPresetId('');
    setStartupPresetName('');
    addToast('开场预设已删除；当前草稿仍保留', 'success');
  };

  const deleteTouchPreset = () => {
    if (!character || !selectedTouchPresetId || settingsGenerating) return;
    const preset = character.companionTouchSettings?.touchPresets?.find(item => item.id === selectedTouchPresetId);
    if (!preset || !window.confirm(`删除触摸预设「${preset.name}」？`)) return;
    const before = companionTouchSettingsBase();
    const after = removeCompanionTouchPreset(before, selectedTouchPresetId);
    updateCharacter(character.id, { companionTouchSettings: after });
    cleanupUnreferencedCompanionVoices(before, after);
    setSelectedTouchPresetId('');
    setTouchPresetName('');
    addToast('触摸预设已删除；当前反馈仍保留', 'success');
  };

  const patchStartupPerformance = (patch: Partial<AvatarPerformanceDirection>) => {
    setSelectedStartupPresetId('');
    const editsTimeline = companionPerformanceCuePackMatches(
      normalizeCompanionDialogue(startupLine, character?.name || ''),
      normalizeCompanionDialogue(startupTranslation, character?.name || ''),
      startupPerformanceCueText,
      startupPerformanceCues,
    );
    const cueIndex = Math.min(startupPerformanceCueIndex, Math.max(0, startupPerformanceCues.length - 1));
    const current = editsTimeline
      ? startupPerformanceCuePhase === 'end'
        ? startupPerformanceCues[cueIndex].endDirection || DEFAULT_AVATAR_PERFORMANCE
        : startupPerformanceCues[cueIndex].direction
      : startupPerformance;
    const next = normalizeCompanionStartupPerformance({ ...current, ...patch });
    if (editsTimeline) {
      setStartupPerformanceCues(cues => cues.map((cue, index) => (
        index === cueIndex
          ? startupPerformanceCuePhase === 'end'
            ? { ...cue, endDirection: next }
            : { ...cue, direction: next }
          : cue
      )));
      if (cueIndex === 0 && startupPerformanceCuePhase === 'start') setStartupPerformance(next);
      return;
    }
    setStartupPerformanceCues([]);
    setStartupPerformanceCueText('');
    setStartupPerformance(next);
  };

  const patchStartupPrecision = (patch: Partial<AvatarPerformancePrecision>) => {
    setSelectedStartupPresetId('');
    const editsTimeline = companionPerformanceCuePackMatches(
      normalizeCompanionDialogue(startupLine, character?.name || ''),
      normalizeCompanionDialogue(startupTranslation, character?.name || ''),
      startupPerformanceCueText,
      startupPerformanceCues,
    );
    const cueIndex = Math.min(startupPerformanceCueIndex, Math.max(0, startupPerformanceCues.length - 1));
    const current = editsTimeline
      ? startupPerformanceCuePhase === 'end'
        ? startupPerformanceCues[cueIndex].endDirection || DEFAULT_AVATAR_PERFORMANCE
        : startupPerformanceCues[cueIndex].direction
      : startupPerformance;
    const next = normalizeCompanionStartupPerformance(current, {
      ...(current.precision || {}),
      ...patch,
      lockAutonomy: true,
    });
    if (editsTimeline) {
      setStartupPerformanceCues(cues => cues.map((cue, index) => (
        index === cueIndex
          ? startupPerformanceCuePhase === 'end'
            ? { ...cue, endDirection: next }
            : { ...cue, direction: next }
          : cue
      )));
      if (cueIndex === 0 && startupPerformanceCuePhase === 'start') setStartupPerformance(next);
      return;
    }
    setStartupPerformanceCues([]);
    setStartupPerformanceCueText('');
    setStartupPerformance(next);
  };

  const makeStartupSettings = (): CompanionStartupSettings => {
    const line = normalizeCompanionDialogue(startupLine, character?.name || '');
    const translation = normalizeCompanionDialogue(startupTranslation, character?.name || '');
    const cueText = companionPerformanceCueText(line, translation);
    const cuesMatch = companionPerformanceCuePackMatches(
      line,
      translation,
      startupPerformanceCueText,
      startupPerformanceCues,
    );
    return {
      enabled: startupEnabled,
      line,
      translation,
      voiceLanguage: startupVoiceLanguage,
      performance: normalizeCompanionStartupPerformance(
        cuesMatch ? startupPerformanceCues[0].direction : startupPerformance,
      ),
      performanceCues: cuesMatch ? startupPerformanceCues : undefined,
      performanceCueText: cuesMatch ? cueText : undefined,
      performanceGeneratedAt: cuesMatch ? Date.now() : undefined,
      generatedAt: character?.companionTouchSettings?.startup?.generatedAt,
      voiceAssetId: character?.companionTouchSettings?.startup?.voiceAssetId,
      voiceMimeType: character?.companionTouchSettings?.startup?.voiceMimeType,
      voiceText: character?.companionTouchSettings?.startup?.voiceText,
      voiceGeneratedLanguage: character?.companionTouchSettings?.startup?.voiceGeneratedLanguage,
      voiceGeneratedAt: character?.companionTouchSettings?.startup?.voiceGeneratedAt,
      updatedAt: Date.now(),
    };
  };

  const saveStartupSettings = () => {
    if (!character || settingsGenerating) return;
    const startup = makeStartupSettings();
    if (startup.enabled && !startup.line) {
      addToast('开启开场演出前，请先填写中文原文', 'error');
      return;
    }
    if (startup.enabled && startup.voiceLanguage && !startup.translation) {
      addToast(`已选择 ${voiceLanguageLabel(startup.voiceLanguage)}，请填写对应的语音译文`, 'error');
      return;
    }
    const saved = saveCompanionStartupPreset(
      companionTouchSettingsBase(),
      startup,
      startupPresetName,
    );
    updateCharacter(character.id, { companionTouchSettings: saved.settings });
    setStartupLine(startup.line);
    setStartupTranslation(startup.translation || '');
    setStartupPerformance(normalizeCompanionStartupPerformance(startup.performance));
    setSelectedStartupPresetId(saved.preset.id);
    setStartupPresetName(saved.preset.name);
    addToast(`已保存新的开场预设「${saved.preset.name}」`, 'success');
  };

  const previewStartup = () => {
    if (!character) return;
    const text = normalizeCompanionDialogue(startupLine, character.name);
    const translation = normalizeCompanionDialogue(startupTranslation, character.name);
    const spokenText = translation || text;
    if (!text) {
      addToast('请先填写中文原文', 'error');
      return;
    }
    if (startupVoiceLanguage && !translation) {
      addToast(`请填写 ${voiceLanguageLabel(startupVoiceLanguage)} 语音译文`, 'error');
      return;
    }
    setTouchSettingsOpen(false);
    setStartupHeadLocked(true);
    setLine({ text, translation: translation || undefined, label: '开场预演', kind: 'startup' });
    const cues = companionPerformanceCuePackMatches(
      text,
      translation,
      startupPerformanceCueText,
      startupPerformanceCues,
    ) ? startupPerformanceCues : [];
    setPerformance(normalizeCompanionStartupPerformance(cues[0]?.direction || startupPerformance));
    setMotionState('speaking');
    scheduleCompanionPerformanceCues(cues, companionLineFallbackDuration(text.length));
    settleAfter(text.length, true);
    const startup = character.companionTouchSettings?.startup;
    const voiceText = normalizeCompanionDialogue(startup?.voiceText || '', character.name);
    const voiceLanguageMatches = (startup?.voiceGeneratedLanguage || '') === startupVoiceLanguage;
    if (startup?.voiceAssetId && voiceText === spokenText && voiceLanguageMatches) {
      const nonce = Date.now();
      touchVoiceNonceRef.current = nonce;
      void playPersistedCompanionVoice(startup, nonce, 'startup', cues);
    }
  };

  const generateStartupPerformancePack = async () => {
    if (!character || settingsGenerating) return;
    const originalText = normalizeCompanionDialogue(startupLine, character.name);
    const translation = normalizeCompanionDialogue(startupTranslation, character.name);
    if (!originalText) {
      addToast('请先填写开场中文原文', 'error');
      return;
    }
    if (startupVoiceLanguage && !translation) {
      addToast(`请填写 ${voiceLanguageLabel(startupVoiceLanguage)} 语音译文`, 'error');
      return;
    }
    const requestToken = ++requestTokenRef.current;
    busyRef.current = true;
    setStartupActionGenerating(true);
    try {
      const directed = await requestCompanionPerformanceCues({
        character,
        apiConfig,
        line: originalText,
        translation,
        modelActions,
      });
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
      const cues = directed.map(cue => ({
        at: cue.at,
        direction: normalizeCompanionStartupPerformance(cue.direction),
        endDirection: cue.endDirection
          ? normalizeCompanionStartupPerformance(cue.endDirection)
          : undefined,
        holdMs: cue.holdMs,
      }));
      setStartupPerformanceCues(cues);
      setStartupPerformanceCueText(companionPerformanceCueText(originalText, translation));
      setStartupPerformanceCueIndex(0);
      setStartupPerformanceCuePhase('start');
      setStartupPerformance(cues[0].direction);
      setSelectedStartupPresetId('');
      addToast(`已按台词编排 ${cues.length} 个动作拍点；点击“保存为新预设”后永久复用`, 'success');
    } catch (error: any) {
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
      console.warn('[companion] startup performance direction failed:', error);
      addToast(error?.message || '开场动作编排失败；未保存，也不会重试', 'error');
    } finally {
      if (requestToken === requestTokenRef.current) {
        busyRef.current = false;
        setStartupActionGenerating(false);
      }
    }
  };

  const generateStartupVoicePack = async () => {
    if (!character || settingsGenerating) return;
    const originalText = normalizeCompanionDialogue(startupLine, character.name);
    const translation = normalizeCompanionDialogue(startupTranslation, character.name);
    if (!originalText) {
      addToast('先填写开场中文原文，再生成语音包', 'error');
      return;
    }
    if (startupVoiceLanguage && !translation) {
      addToast(`请填写 ${voiceLanguageLabel(startupVoiceLanguage)} 语音译文`, 'error');
      return;
    }
    const spokenText = translation || originalText;
    if (!characterHasVoice(character, apiConfig)) {
      addToast('这个角色还没有配置可用音色，请先去语音设置配置', 'error');
      return;
    }
    const requestToken = ++requestTokenRef.current;
    busyRef.current = true;
    setStartupVoiceGenerating(true);
    try {
      const performance = normalizeCompanionStartupPerformance(
        companionPerformanceCuePackMatches(
          originalText,
          translation,
          startupPerformanceCueText,
          startupPerformanceCues,
        )
          ? startupPerformanceCues[0].direction
          : startupPerformance,
      );
      const voice = await generateCompanionStartupVoice({
        text: spokenText,
        voiceLanguage: startupVoiceLanguage,
        performance,
        character,
        apiConfig,
      });
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
      const startup: CompanionStartupSettings = {
        ...makeStartupSettings(),
        line: originalText,
        translation,
        voiceLanguage: startupVoiceLanguage,
        performance,
        ...voice,
        updatedAt: Date.now(),
      };
      const before = companionTouchSettingsBase();
      const after: CompanionTouchSettings = {
        ...before,
        startup,
        activeStartupPresetId: undefined,
      };
      updateCharacter(character.id, { companionTouchSettings: after });
      cleanupUnreferencedCompanionVoices(before, after);
      setStartupLine(originalText);
      setStartupTranslation(translation);
      setSelectedStartupPresetId('');
      addToast('开场语音包已生成并永久保存在本地；保存为预设后可随时切换', 'success');
    } catch (error: any) {
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
      console.warn('[companion] startup voice pack generation failed:', error);
      addToast(error?.message || '开场语音包生成失败', 'error');
    } finally {
      if (requestToken === requestTokenRef.current) {
        busyRef.current = false;
        setStartupVoiceGenerating(false);
      }
    }
  };

  const generateTouchReactionPack = async () => {
    if (!character || settingsGenerating) return;
    if (!touchDraftZones.length) {
      addToast('请至少选择一个可触摸部位', 'error');
      return;
    }
    if (touchGenerateVoice && !characterHasVoice(character, apiConfig)) {
      addToast('这个角色还没有配置可用音色，先关闭语音勾选或去语音设置配置', 'error');
      return;
    }
    const requestToken = ++requestTokenRef.current;
    busyRef.current = true;
    setTouchGenerating(true);
    setTouchVoiceProgress(null);
    setMotionState('thinking');
    setLine(null);
    try {
      let reactions = await requestAvatarTouchReactionPack({
        character,
        user: userProfile,
        apiConfig,
        zones: touchDraftZones,
        modelActions,
        voiceLanguage: touchVoiceLanguage,
        outputMode: activeCompanionSource === 'upload'
          ? 'text'
          : activeCompanionSource === 'date' ? 'expression' : 'full',
      });
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;

      let voiceGenerated = 0;
      let voiceTotal = 0;
      let voiceFailures = 0;
      if (touchGenerateVoice) {
        voiceTotal = Object.values(reactions).reduce((total, items) => total + (items?.length || 0), 0);
        setTouchVoiceProgress({ completed: 0, total: voiceTotal });
        const voiceResult = await generateAvatarTouchVoicePack({
          reactions,
          character,
          apiConfig,
          voiceLanguage: touchVoiceLanguage,
          onProgress: (completed, total) => {
            if (mountedRef.current && requestToken === requestTokenRef.current) {
              setTouchVoiceProgress({ completed, total });
            }
          },
        });
        if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
        reactions = voiceResult.reactions;
        voiceGenerated = voiceResult.generated;
        voiceTotal = voiceResult.total;
        voiceFailures = voiceResult.failures.length;
      }

      const before = companionTouchSettingsBase();
      const saved = saveCompanionTouchPreset(before, {
        enabledZones: touchDraftZones,
        reactions,
        voiceLanguage: touchVoiceLanguage,
        voiceEnabled: touchGenerateVoice,
        voiceGeneratedCount: voiceGenerated,
        generatedAt: Date.now(),
      }, touchPresetName);
      updateCharacter(character.id, { companionTouchSettings: saved.settings });
      cleanupUnreferencedCompanionVoices(before, saved.settings);
      setSelectedTouchPresetId(saved.preset.id);
      setTouchPresetName(saved.preset.name);
      touchCursorRef.current = {};
      trackEvent('生成桌面触碰反馈', {
        形象: activeCompanionSource === 'upload'
          ? '图片 / GIF'
          : activeCompanionSource === 'date' ? '见面立绘' : '动态模型',
        语音: touchGenerateVoice,
      });
      const voiceSummary = touchGenerateVoice ? ` · 本地语音 ${voiceGenerated}/${voiceTotal}` : '';
      addToast(`已保存新的触摸预设「${saved.preset.name}」${voiceSummary}`, 'success');
      if (voiceFailures) {
        addToast(`${voiceFailures} 条语音未能保存，触摸时只演动作与台词，不会临时调用 TTS`, 'info');
      }
    } catch (error: any) {
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
      console.warn('[companion] touch reaction pack failed:', error);
      addToast(error?.message || '触摸反馈包生成失败', 'error');
    } finally {
      if (requestToken === requestTokenRef.current) {
        busyRef.current = false;
        setTouchGenerating(false);
        setTouchVoiceProgress(null);
        setMotionState('idle');
        setPerformance(DEFAULT_AVATAR_PERFORMANCE);
      }
    }
  };

  const playPersistedCompanionVoice = async (
    voice: Pick<CompanionTouchReaction, 'voiceAssetId'>,
    nonce: number,
    kind: 'startup' | 'touch',
    performanceCues: AvatarPerformanceCue[] = [],
  ) => {
    if (!voice.voiceAssetId) return;
    const url = await createAvatarTouchVoiceUrl(voice);
    if (!url) return;
    if (!mountedRef.current || touchVoiceNonceRef.current !== nonce) {
      URL.revokeObjectURL(url);
      return;
    }
    stopTouchVoice();
    const audio = touchVoiceAudioRef.current || new Audio();
    touchVoiceAudioRef.current = audio;
    touchVoiceUrlRef.current = url;
    audio.src = url;
    const feed = getCompanionAudioFeed();
    feed.attach(audio);
    let playbackStarted = false;
    const release = () => {
      feed.setActive(false);
      if (touchVoiceUrlRef.current === url) {
        URL.revokeObjectURL(url);
        touchVoiceUrlRef.current = null;
      }
    };
    const scheduleAgainstAudio = () => {
      if (kind !== 'startup' || !performanceCues.length) return;
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      scheduleCompanionPerformanceCues(performanceCues, audio.duration * 1000);
    };
    audio.onloadedmetadata = scheduleAgainstAudio;
    audio.onplay = () => {
      playbackStarted = true;
      feed.setActive(true);
      scheduleAgainstAudio();
      // Real audio duration owns the speaking window. The text-length timer is
      // only a fallback for muted/missing/blocked audio.
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      setMotionState('speaking');
    };
    audio.onpause = () => feed.setActive(false);
    audio.onended = () => {
      release();
      clearCompanionPerformanceCues();
      if (kind === 'startup') setStartupHeadLocked(false);
      setMotionState('idle');
      setPerformance(DEFAULT_AVATAR_PERFORMANCE);
    };
    audio.onerror = () => {
      release();
      // Before playback starts, the text-length fallback continues to own the
      // startup lock. If a playing stream fails, its real speaking window ended.
      if (playbackStarted) {
        clearCompanionPerformanceCues();
        if (kind === 'startup') setStartupHeadLocked(false);
        setMotionState('idle');
        setPerformance(DEFAULT_AVATAR_PERFORMANCE);
      }
    };
    try {
      await audio.play();
    } catch (error) {
      console.warn(`[companion] local ${kind} voice playback skipped:`, error);
      release();
    }
  };

  const respondToTouch = (hit: AvatarTouchHit, force = false) => {
    if (!character || touchGenerating || editingRef.current) return;
    clearCompanionPerformanceCues();
    setStartupHeadLocked(false);
    const now = Date.now();
    if (!force && now - lastTouchAtRef.current < 420) return;
    lastTouchAtRef.current = now;
    if (touchDialogueTimerRef.current !== null) window.clearTimeout(touchDialogueTimerRef.current);
    setAppStarOpen(false);
    setLine(null);
    touchVoiceNonceRef.current = hit.nonce;
    stopTouchVoice();
    setLastHit(hit);
    const touchForce = resolveAvatarTouchForce(hit);
    const keepBuiltinSullyHeadClose = (direction: AvatarPerformanceDirection): AvatarPerformanceDirection => (
      isBuiltinSullyLive2D(character.videoAvatar) && (hit.zone === 'head' || hit.zone === 'face')
        ? { ...direction, camera: 'close' }
        : direction
    );
    setRipple({ nonce: hit.nonce, x: hit.normalizedX, y: hit.normalizedY, force: touchForce });
    showTouchBanner(hit, `你戳了戳${character.name}的${avatarTouchTargetLabel(hit)}`);
    setPerformance(applyAvatarTouchForce(keepBuiltinSullyHeadClose(buildImmediateTouchPerformance(hit.zone)), hit));
    setMotionState('speaking');

    const settings = character.companionTouchSettings;
    const enabled = settings?.enabledZones?.includes(hit.zone);
    const reactions = settings?.reactions?.[hit.zone] || [];
    if (!enabled || !reactions.length) {
      settleAfter(18);
      addToast(`“${avatarTouchZoneLabel(hit.zone)}”还没有本地反馈，点右侧触摸设置生成一次即可`, 'info');
      return;
    }

    const cursor = touchCursorRef.current[hit.zone] || 0;
    const reaction = reactions[cursor % reactions.length];
    touchCursorRef.current[hit.zone] = (cursor + 1) % reactions.length;
    const text = normalizeCompanionDialogue(reaction.text, character.name);
    const translation = normalizeCompanionDialogue(reaction.translation || '', character.name);
    const spokenText = translation || text;
    if (!text) {
      settleAfter(18);
      addToast('这条缓存台词为空，请在触摸设置中补生成反馈包', 'error');
      return;
    }

    // Let the fast local touch impulse land before the cached dialogue takes
    // over. This timer never calls the API; repeated taps simply replace it.
    touchDialogueTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current) return;
      setLine({ text, translation: translation || undefined, label: `触摸 · ${avatarTouchZoneLabel(hit.zone)}`, kind: 'touch' });
      setPerformance(applyAvatarTouchForce(
        keepBuiltinSullyHeadClose(reaction.performance || buildImmediateTouchPerformance(hit.zone)),
        hit,
      ));
      setMotionState('speaking');
      const voiceTextMatches = !reaction.voiceText
        || normalizeCompanionDialogue(reaction.voiceText, character.name) === spokenText;
      const voiceLanguageMatches = (reaction.voiceLanguage || '') === (settings?.voiceLanguage || '');
      if (settings?.voiceEnabled && reaction.voiceAssetId && voiceTextMatches && voiceLanguageMatches) {
        void playPersistedCompanionVoice(reaction, hit.nonce, 'touch');
      }
      settleAfter(text.length);
    }, 420);
  };
  const thinking = motionState === 'thinking';
  const displayLineText = normalizeCompanionDialogue(line?.text || '', character?.name || '');
  const typed = useTypewriter(displayLineText);
  const independentChrome = frameStyle === 'otome' || frameStyle === 'cat' || frameStyle === 'magazine' || frameStyle === 'archive' || frameStyle === 'idol';
  const dialogVisible = (independentChrome
    ? line?.kind === 'touch' || (thinking && Boolean(lastHit))
    : Boolean(line) || thinking)
    && !editing && !touchSettingsOpen && !appStarOpen && !wardrobeOpen;

  if (!character) {
    return (
      <div className="flex h-full w-full items-center justify-center px-8 text-center text-white/70">
        <div>
          <Sparkle size={28} className="mx-auto mb-3" />
          <div className="text-sm">先创建并选择一个角色，再来使用触感陪伴桌面。</div>
          <button onClick={() => openApp(AppID.Character)} className="mt-4 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-xs">去选择角色</button>
        </div>
      </div>
    );
  }

  const hh = String(virtualTime.hours).padStart(2, '0');
  const mm = String(virtualTime.minutes).padStart(2, '0');

  const compositionFramingDraft = compositionFramingMode === 'face' ? faceFramingDraft : framingDraft;
  const setCompositionFramingDraft = compositionFramingMode === 'face' ? setFaceFramingDraft : setFramingDraft;
  const activeCompanionFraming = editing ? compositionFramingDraft : (companionFraming || defaultCompanionFraming);
  const activeCompanionCrop = editing ? cropDraft : (companionCrop || DEFAULT_STAGE_CROP);
  const cropAdjusted = !cropIsDefault(activeCompanionCrop);
  const framingScaleMin = character.videoAvatar?.format === 'live2d' ? 0.55 : 0.5;
  const framingScaleMax = character.videoAvatar?.format === 'live2d' ? 6 : 4;
  const framingOffsetXMax = character.videoAvatar?.format === 'live2d' ? 1.4 : 0.9;
  const framingOffsetYMax = character.videoAvatar?.format === 'live2d' ? 3.2 : 0.9;
  const savedTouchSettings = character.companionTouchSettings;
  const startupPresets = savedTouchSettings?.startupPresets || [];
  const touchPresets = savedTouchSettings?.touchPresets || [];
  const preparedReactionCount = Object.values(savedTouchSettings?.reactions || {})
    .reduce((total, reactions) => total + (reactions?.length || 0), 0);
  const preparedVoiceCount = Object.values(savedTouchSettings?.reactions || {})
    .reduce((total, reactions) => total + (reactions?.filter(item => item.voiceAssetId).length || 0), 0);
  const touchVoiceAvailable = characterHasVoice(character, apiConfig);
  const savedStartup = savedTouchSettings?.startup;
  const startupSpokenDraft = normalizeCompanionDialogue(startupTranslation, character.name)
    || normalizeCompanionDialogue(startupLine, character.name);
  const startupVoiceMatchesDraft = Boolean(savedStartup?.voiceAssetId)
    && normalizeCompanionDialogue(savedStartup?.voiceText || '', character.name)
      === startupSpokenDraft
    && (savedStartup?.voiceGeneratedLanguage || '') === startupVoiceLanguage;
  const startupCuesMatchDraft = companionPerformanceCuePackMatches(
    normalizeCompanionDialogue(startupLine, character.name),
    normalizeCompanionDialogue(startupTranslation, character.name),
    startupPerformanceCueText,
    startupPerformanceCues,
  );
  const selectedStartupCueIndex = Math.min(
    startupPerformanceCueIndex,
    Math.max(0, startupPerformanceCues.length - 1),
  );
  const selectedStartupCue = startupCuesMatchDraft
    ? startupPerformanceCues[selectedStartupCueIndex]
    : undefined;
  const startupEditorPerformance = selectedStartupCue
    ? startupPerformanceCuePhase === 'end'
      ? selectedStartupCue.endDirection || DEFAULT_AVATAR_PERFORMANCE
      : selectedStartupCue.direction
    : startupPerformance;
  const startupCueSentences = splitCompanionPerformanceSentences(startupSpokenDraft);

  const launchCompanionApp = (id: AppID) => {
    setAppStarOpen(false);
    openApp(id);
  };

  return (
    <div className="relative h-full w-full overflow-hidden select-none" data-companion-frame={frameStyle} data-companion-layout="stage" data-wardrobe-hint-active={wardrobeDiscoveryActive ? 'true' : 'false'}>
      <style>{`
        @keyframes companion-ripple {
          from { opacity:.8; transform:translate(-50%,-50%) scale(.25); }
          to { opacity:0; transform:translate(-50%,-50%) scale(2.8); }
        }
        @keyframes companion-dialog-in {
          from { opacity:0; transform:translateY(10px); }
          to { opacity:1; transform:translateY(0); }
        }
        @keyframes companion-cursor { 0%,100% { opacity:.85; } 50% { opacity:.1; } }
        @keyframes companion-thinking-dot {
          0%,80%,100% { opacity:.25; transform:translateY(0); }
          40% { opacity:1; transform:translateY(-3px); }
        }
        @keyframes companion-clock-in {
          from { opacity:0; transform:translateY(-6px); }
          to { opacity:1; transform:translateY(0); }
        }
        @keyframes companion-hud-in {
          from { opacity:0; transform:translateY(-10px) scale(.98); }
          to { opacity:1; transform:translateY(0) scale(1); }
        }
        @keyframes companion-touch-banner {
          0% { opacity:0; transform:translate(-50%, 4px); }
          18% { opacity:1; transform:translate(-50%, -8px); }
          78% { opacity:1; transform:translate(-50%, -30px); }
          100% { opacity:0; transform:translate(-50%, -46px); }
        }
        @keyframes companion-heart-pop {
          0% { opacity:0; transform:translate(-50%,-50%) scale(.2) rotate(-10deg); }
          35% { opacity:1; transform:translate(-50%,-90%) scale(1.12) rotate(6deg); }
          100% { opacity:0; transform:translate(-50%,-180%) scale(.76) rotate(16deg); }
        }
        @keyframes companion-star-open {
          from { opacity:0; transform:translateY(18px) scale(.94); }
          to { opacity:1; transform:translateY(0) scale(1); }
        }
        @keyframes companion-drawer-up {
          from { opacity:0; transform:translateY(28px); }
          to { opacity:1; transform:translateY(0); }
        }
        @keyframes companion-inspector-in {
          from { opacity:0; transform:translateX(28px); }
          to { opacity:1; transform:translateX(0); }
        }
        @keyframes companion-wardrobe-beacon {
          0%,100% { filter:drop-shadow(0 0 4px rgba(255,255,255,.25)); }
          50% { filter:drop-shadow(0 0 13px ${uiTint}) drop-shadow(0 0 24px ${uiTint}); }
        }
        [data-wardrobe-hint-active='true'] [data-companion-wardrobe-trigger='true'] {
          position:relative;
          z-index:48;
          outline:1px solid ${uiTint};
          outline-offset:3px;
          animation:companion-wardrobe-beacon 1.35s ease-in-out infinite;
        }

        /* The content grid and control sizes stay fixed; only the frame language changes. */
        [data-companion-frame] .companion-context-frame,
        [data-companion-frame] .companion-side-rail,
        [data-companion-frame] .companion-dock-surface,
        [data-companion-frame] .companion-dialogue-backdrop { transition: border-radius 220ms ease, background 220ms ease, border-color 220ms ease, box-shadow 220ms ease, clip-path 220ms ease; }

        .companion-hud-shell,
        .companion-side-rail,
        .companion-bottom-dock { transition: opacity 180ms ease, transform 240ms cubic-bezier(.2,.8,.2,1); }
        .companion-stage-canvas { width:100%; height:100%; }
        [data-companion-frame='otome'] {
          background:radial-gradient(circle at 50% 34%,#edf2eb 0,#d9e3dc 54%,#c6d2ca 100%);
        }
        [data-companion-frame='cat'] {
          background:radial-gradient(circle at 50% 32%,#28133c 0,#100b18 58%,#060609 100%);
        }
        [data-companion-frame='otome'] .companion-stage-canvas,
        [data-companion-frame='cat'] .companion-stage-canvas,
        [data-companion-frame='magazine'] .companion-stage-canvas,
        [data-companion-frame='archive'] .companion-stage-canvas,
        [data-companion-frame='idol'] .companion-stage-canvas {
          inset:0;
          width:100%;
          height:100%;
          transform:none;
          box-shadow:none;
        }
        @media (orientation:landscape) and (min-width:720px) {
          [data-companion-frame='otome'] .companion-stage-canvas,
          [data-companion-frame='cat'] .companion-stage-canvas,
          [data-companion-frame='magazine'] .companion-stage-canvas,
          [data-companion-frame='archive'] .companion-stage-canvas,
          [data-companion-frame='idol'] .companion-stage-canvas {
            inset:50% auto auto 50%;
            width:min(100%,56.25vh);
            height:100%;
            transform:translate(-50%,-50%);
            box-shadow:0 0 60px rgba(7,16,24,.2);
          }
        }
        .companion-dock-primary-frame,
        .companion-dock-primary-outline,
        .companion-dock-primary-core,
        .companion-dock-primary-glyph,
        .companion-dock-primary-mark { transition: transform 150ms ease, background 180ms ease, border-color 180ms ease, border-radius 180ms ease, color 180ms ease, box-shadow 180ms ease, clip-path 180ms ease; }
        .companion-dock-primary:active .companion-dock-primary-frame { transform:translateY(2px) scale(.97); }

        /* Night magazine: a high-contrast editorial cover, not a reskinned game HUD. */
        [data-companion-frame='magazine']::before {
          content:'SULLY / NIGHT ISSUE 01';
          position:absolute; left:10px; top:31%; z-index:22; pointer-events:none;
          color:rgba(247,241,232,.78); font-size:7px; font-weight:800; letter-spacing:.28em;
          writing-mode:vertical-rl; border-left:2px solid #ee655d; padding-left:5px;
          text-shadow:0 1px 8px rgba(0,0,0,.35);
        }
        [data-companion-frame='magazine']::after {
          content:'COVER STORY · AUG 2026';
          position:absolute; right:12px; bottom:6.45rem; z-index:22; pointer-events:none;
          color:#171519; background:#f3eee5; border-left:5px solid #ee655d;
          padding:4px 7px; font-size:6px; font-weight:900; letter-spacing:.16em;
        }
        [data-companion-frame='magazine'] .companion-context-frame {
          color:#171519 !important; background:rgba(244,239,230,.94) !important;
          border:0 !important; border-top:3px solid #171519 !important; border-bottom:1px solid rgba(23,21,25,.72) !important;
          border-radius:0 !important; clip-path:none !important; box-shadow:8px 8px 0 rgba(238,101,93,.82) !important;
        }
        [data-companion-frame='magazine'] .companion-context-frame button,
        [data-companion-frame='magazine'] .companion-context-frame span { color:#171519 !important; }
        [data-companion-frame='magazine'] .companion-context-frame header { border-bottom:1px solid rgba(23,21,25,.24); }
        [data-companion-frame='magazine'] .companion-avatar-frame { border-radius:0 !important; clip-path:none !important; border:2px solid #171519 !important; }
        [data-companion-frame='magazine'] .companion-hud-gear { border-radius:0; border:1px solid #171519 !important; background:#ee655d !important; color:#171519 !important; }
        [data-companion-frame='magazine'] .companion-hud-grid { border-color:rgba(23,21,25,.3) !important; }
        [data-companion-frame='magazine'] .companion-hud-grid button { border-color:rgba(23,21,25,.22) !important; }
        [data-companion-frame='magazine'] .companion-hud-grid button > span:first-child { color:#c53e39 !important; }
        [data-companion-frame='magazine'] .companion-side-rail {
          color:#171519 !important; background:rgba(244,239,230,.94); border-left:4px solid #ee655d; border-right:1px solid #171519;
          padding-left:3px; box-shadow:7px 8px 0 rgba(23,21,25,.18);
        }
        [data-companion-frame='magazine'] .companion-rail-frame-art,
        [data-companion-frame='magazine'] .companion-side-rail > span[aria-hidden] { display:none; }
        [data-companion-frame='magazine'] .companion-rail-shape,
        [data-companion-frame='magazine'] .companion-dock-shape { transform:none !important; border-radius:0 !important; background:#f6f1e8 !important; border-color:#171519 !important; }
        [data-companion-frame='magazine'] .companion-rail-shape-inner { border-radius:0 !important; border-color:rgba(23,21,25,.24) !important; }
        [data-companion-frame='magazine'] .companion-rail-icon,
        [data-companion-frame='magazine'] .companion-dock-icon { transform:none !important; color:#171519 !important; }
        [data-companion-frame='magazine'] .companion-rail-button > span:last-child,
        [data-companion-frame='magazine'] .companion-dock-item,
        [data-companion-frame='magazine'] .companion-bottom-dock button { color:#171519 !important; }
        [data-companion-frame='magazine'] .companion-dock-surface {
          background:rgba(244,239,230,.96) !important; border:0 !important; border-top:3px solid #171519 !important;
          border-radius:0 !important; clip-path:none !important; box-shadow:0 -5px 0 rgba(238,101,93,.88);
        }
        [data-companion-frame='magazine'] .companion-dock-primary-frame {
          width:4.25rem !important; height:3.35rem !important; border:2px solid #171519 !important; border-radius:0 !important;
          background:#f6f1e8 !important; box-shadow:6px 6px 0 #ee655d; transform:translateY(-4px);
        }
        [data-companion-frame='magazine'] .companion-dock-primary-outline {
          inset:4px !important; border:1px solid rgba(23,21,25,.34) !important; border-radius:0 !important;
        }
        [data-companion-frame='magazine'] .companion-dock-primary-core {
          width:3rem !important; height:2.15rem !important; border:0 !important; border-radius:0 !important;
          color:#f6f1e8 !important; background:#171519 !important;
        }
        [data-companion-frame='magazine'] .companion-dock-primary-mark { display:none; }
        [data-companion-frame='magazine'] .companion-dock-primary-label {
          color:#171519 !important; font-weight:900; letter-spacing:.08em !important; transform:translateY(-1px);
        }
        [data-companion-frame='magazine'] .companion-dock-primary:active .companion-dock-primary-frame { transform:translate(2px,-2px) scale(.98); box-shadow:3px 3px 0 #ee655d; }
        [data-companion-frame='magazine'] .companion-dialogue-backdrop {
          background:rgba(246,241,232,.97) !important; border:2px solid #171519 !important; border-radius:0 !important;
          clip-path:none !important; box-shadow:7px 7px 0 rgba(238,101,93,.82) !important;
        }
        [data-companion-frame='magazine'] [data-testid='companion-dialogue-surface'] { color:#171519 !important; }
        [data-companion-frame='magazine'] [data-testid='companion-dialogue-surface'] div { color:#171519; }
        [data-companion-frame='magazine'] .companion-dialogue-label { color:#fff !important; background:#171519 !important; border-radius:0 !important; clip-path:none !important; }

        /* Archive: warm ink, chapter tabs and faceted collection framing. */
        [data-companion-frame='archive']::before {
          content:'ARCHIVE / 001'; position:absolute; left:12px; top:30%; z-index:22; pointer-events:none;
          color:#d6b879; border-top:1px solid rgba(214,184,121,.8); border-bottom:1px solid rgba(214,184,121,.45);
          padding:5px 0; font-family:Georgia,serif; font-size:7px; letter-spacing:.22em;
        }
        [data-companion-frame='archive'] .companion-context-frame {
          background:linear-gradient(145deg,rgba(28,20,22,.95),rgba(63,43,40,.96)) !important;
          border:1px solid #c7a566 !important; outline:1px solid rgba(199,165,102,.28); outline-offset:-5px;
          clip-path:polygon(0 14px,14px 0,calc(100% - 28px) 0,100% 28px,100% 100%,20px 100%,0 calc(100% - 20px)) !important;
          box-shadow:0 14px 38px rgba(17,10,12,.62) !important; font-family:Georgia,'Noto Serif SC',serif;
        }
        [data-companion-frame='archive'] .companion-avatar-frame { border-color:#d6b879 !important; clip-path:polygon(50% 0,100% 22%,92% 88%,50% 100%,8% 88%,0 22%) !important; }
        [data-companion-frame='archive'] .companion-hud-gear { border-color:#c7a566 !important; border-radius:50%; background:rgba(199,165,102,.12) !important; color:#e5cc99 !important; }
        [data-companion-frame='archive'] .companion-side-rail {
          background:linear-gradient(180deg,rgba(31,21,23,.96),rgba(69,45,40,.92));
          border:1px solid rgba(199,165,102,.72); clip-path:polygon(0 16px,16px 0,100% 0,100% calc(100% - 20px),calc(100% - 20px) 100%,0 100%);
          box-shadow:0 14px 34px rgba(17,10,12,.48); font-family:Georgia,'Noto Serif SC',serif;
        }
        [data-companion-frame='archive'] .companion-rail-frame-art path { stroke:#d6b879 !important; }
        [data-companion-frame='archive'] .companion-rail-shape,
        [data-companion-frame='archive'] .companion-dock-shape {
          transform:none !important; border-radius:0 !important; background:rgba(77,50,43,.82) !important; border-color:#c7a566 !important;
          clip-path:polygon(50% 0,100% 24%,88% 100%,12% 100%,0 24%);
        }
        [data-companion-frame='archive'] .companion-rail-shape-inner { display:none; }
        [data-companion-frame='archive'] .companion-rail-icon,
        [data-companion-frame='archive'] .companion-dock-icon { transform:none !important; color:#ead6ac !important; }
        [data-companion-frame='archive'] .companion-dock-surface {
          background:linear-gradient(180deg,rgba(42,28,29,.97),rgba(72,47,41,.98)) !important;
          border-color:#c7a566 !important; clip-path:polygon(0 18px,18px 0,34% 0,40% 10px,60% 10px,66% 0,calc(100% - 18px) 0,100% 18px,100% 100%,0 100%) !important;
          box-shadow:inset 0 0 0 4px rgba(199,165,102,.12);
        }
        [data-companion-frame='archive'] .companion-dock-primary-frame {
          width:4.1rem !important; height:4.35rem !important; border:0 !important; border-radius:0 !important;
          background:#c7a566 !important; clip-path:polygon(50% 0,91% 18%,100% 70%,50% 100%,0 70%,9% 18%);
          transform:translateY(-5px); box-shadow:none !important;
        }
        [data-companion-frame='archive'] .companion-dock-primary-outline {
          inset:3px !important; border:0 !important; border-radius:0 !important; background:#2b1d1e;
          clip-path:polygon(50% 0,91% 18%,100% 70%,50% 100%,0 70%,9% 18%);
        }
        [data-companion-frame='archive'] .companion-dock-primary-core {
          width:2.75rem !important; height:2.9rem !important; border:1px solid rgba(215,185,124,.62) !important;
          border-radius:0 !important; color:#ead6ac !important; background:linear-gradient(180deg,#5a3b34,#332224) !important;
          clip-path:polygon(50% 0,88% 20%,100% 72%,50% 100%,0 72%,12% 20%);
          font-family:Georgia,'Noto Serif SC',serif;
        }
        [data-companion-frame='archive'] .companion-dock-primary-mark {
          left:50% !important; right:auto !important; top:4px !important; transform:translateX(-50%); color:#d6b879 !important; font-size:5px !important;
        }
        [data-companion-frame='archive'] .companion-dock-primary-label {
          color:#e0c58e !important; font-family:Georgia,'Noto Serif SC',serif; letter-spacing:.16em !important; transform:translateY(-4px);
        }
        [data-companion-frame='archive'] .companion-dock-primary:active .companion-dock-primary-frame { transform:translateY(-2px) scale(.97); }
        [data-companion-frame='archive'] .companion-dialogue-backdrop {
          background:linear-gradient(145deg,rgba(35,23,25,.97),rgba(70,46,40,.98)) !important; border-color:#c7a566 !important;
          clip-path:polygon(0 16px,16px 0,calc(100% - 32px) 0,100% 32px,100% 100%,20px 100%,0 calc(100% - 20px)) !important;
        }
        [data-companion-frame='archive'] .companion-dialogue-label { background:#8b6840 !important; clip-path:polygon(0 8px,8px 0,100% 0,100% 100%,0 100%) !important; font-family:Georgia,'Noto Serif SC',serif; }

        /* Idol live: floating glass capsules and soft circular controls. */
        [data-companion-frame='idol']::before {
          content:'ON STAGE'; position:absolute; left:12px; top:30%; z-index:22; pointer-events:none;
          color:white; background:#ff8fa7; border-radius:999px; padding:4px 8px;
          font-size:7px; font-weight:800; letter-spacing:.2em; box-shadow:0 6px 16px rgba(40,25,60,.24);
        }
        [data-companion-frame='idol'] .companion-context-frame {
          background:linear-gradient(145deg,rgba(27,39,72,.82),rgba(60,79,137,.72)) !important;
          border:1px solid rgba(255,255,255,.44) !important; border-radius:1.6rem !important; clip-path:none !important;
          box-shadow:0 16px 42px rgba(20,27,55,.35),inset 0 1px 0 rgba(255,255,255,.35) !important; backdrop-filter:blur(16px);
        }
        [data-companion-frame='idol'] .companion-avatar-frame { border-radius:50% !important; clip-path:none !important; border:2px solid #ff9db0 !important; }
        [data-companion-frame='idol'] .companion-hud-gear { border-radius:50%; border-color:rgba(255,255,255,.42) !important; background:rgba(255,143,167,.24) !important; }
        [data-companion-frame='idol'] .companion-side-rail {
          background:linear-gradient(180deg,rgba(31,46,84,.72),rgba(50,68,119,.64)); border:1px solid rgba(255,255,255,.34);
          border-radius:2rem; box-shadow:0 18px 40px rgba(22,30,62,.35); backdrop-filter:blur(14px);
        }
        [data-companion-frame='idol'] .companion-rail-frame-art,
        [data-companion-frame='idol'] .companion-side-rail > span[aria-hidden] { display:none; }
        [data-companion-frame='idol'] .companion-rail-shape,
        [data-companion-frame='idol'] .companion-dock-shape {
          transform:none !important; border-radius:50% !important; background:rgba(255,255,255,.1) !important; border-color:rgba(255,255,255,.42) !important;
          box-shadow:inset 0 1px 0 rgba(255,255,255,.22);
        }
        [data-companion-frame='idol'] .companion-rail-shape-inner { border-radius:50% !important; border-color:rgba(255,143,167,.48) !important; }
        [data-companion-frame='idol'] .companion-rail-icon,
        [data-companion-frame='idol'] .companion-dock-icon { transform:none !important; color:#fff !important; }
        [data-companion-frame='idol'] .companion-dock-surface {
          background:linear-gradient(180deg,rgba(27,40,76,.76),rgba(52,70,123,.78)) !important;
          border-color:rgba(255,255,255,.36) !important; border-radius:2.25rem !important; clip-path:none !important;
          box-shadow:0 18px 42px rgba(19,27,58,.38),inset 0 1px 0 rgba(255,255,255,.3); backdrop-filter:blur(16px);
        }
        [data-companion-frame='idol'] .companion-dock-primary-frame {
          width:4.55rem !important; height:3.7rem !important; border:1px solid rgba(255,255,255,.5) !important; border-radius:1.65rem !important;
          background:linear-gradient(145deg,rgba(255,255,255,.2),rgba(255,143,167,.2)) !important;
          box-shadow:0 8px 22px rgba(16,24,54,.38),inset 0 1px 0 rgba(255,255,255,.45) !important; transform:translateY(-3px);
        }
        [data-companion-frame='idol'] .companion-dock-primary-outline {
          inset:4px !important; border:1px solid rgba(255,159,179,.68) !important; border-radius:1.35rem !important;
        }
        [data-companion-frame='idol'] .companion-dock-primary-core {
          width:3rem !important; height:3rem !important; border:1px solid rgba(255,255,255,.58) !important; border-radius:50% !important;
          color:white !important; background:linear-gradient(145deg,#ff9bb1,#de6f98) !important;
          box-shadow:0 6px 16px rgba(255,104,145,.24),inset 0 1px 0 rgba(255,255,255,.45);
        }
        [data-companion-frame='idol'] .companion-dock-primary-mark {
          right:-8px !important; top:-5px !important; border:1px solid rgba(255,255,255,.7); border-radius:999px;
          background:#fff; color:#d85f87 !important; padding:2px 3px; font-size:4px !important; font-weight:900; letter-spacing:.08em;
        }
        [data-companion-frame='idol'] .companion-dock-primary-label { color:#ffafbf !important; transform:translateY(-2px); }
        [data-companion-frame='idol'] .companion-dock-primary:active .companion-dock-primary-frame { transform:translateY(0) scale(.97); box-shadow:0 3px 10px rgba(16,24,54,.28) !important; }
        [data-companion-frame='idol'] .companion-dialogue-backdrop {
          background:linear-gradient(145deg,rgba(29,43,82,.9),rgba(58,76,132,.9)) !important;
          border-color:rgba(255,255,255,.4) !important; border-radius:1.5rem !important; clip-path:none !important;
        }
        [data-companion-frame='idol'] .companion-dialogue-label { background:#ff8fa7 !important; border-radius:999px !important; clip-path:none !important; }

        @media (prefers-reduced-motion: reduce) {
          [data-companion-frame] *, [data-companion-layout] * { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .01ms !important; }
        }

      `}</style>

      <div className="companion-stage-canvas absolute inset-0 overflow-hidden">

      {wardrobeDiscoveryActive && !editing && !touchSettingsOpen && !appStarOpen && !wardrobeOpen && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[6.9rem] z-[47] flex justify-center px-5" data-testid="companion-wardrobe-discovery-nudge">
          <div className="rounded-full border border-white/20 bg-black/60 px-4 py-2 text-[10px] font-medium text-white/90 shadow-[0_10px_34px_rgba(0,0,0,.35)] backdrop-blur-xl">
            想换场景？衣橱入口正在发光 ✦
          </div>
        </div>
      )}

      {/* ── 背景：自定义图片 > 华丽预设场景 > 时段天光 ── */}
      {backgroundImageUrl ? (
        <>
          <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${backgroundImageUrl})` }} />
          {/* 自定义图上压暗色渐变，保住时钟/台词可读性 */}
          <div className="absolute inset-0" style={{ background: `linear-gradient(to bottom, ${palette.shadow}70, ${palette.shadow}1a 34%, ${palette.shadow}33 68%, ${palette.shadow}8c)` }} />
        </>
      ) : backgroundPreset ? (
        <div className="absolute inset-0" style={{ background: backgroundPreset.css }} />
      ) : (
        <>
          <div className="absolute inset-0 transition-[background] duration-500" style={{ background: `linear-gradient(180deg, ${palette.baseTop} 0%, ${palette.baseMid} 52%, ${palette.baseBottom} 100%)` }} />
          <div
            className="absolute inset-0 transition-[background] duration-[2400ms]"
            style={{ background: `radial-gradient(120% 62% at 50% -12%, ${period.skyGlow}, transparent 68%), radial-gradient(85% 40% at 82% 24%, ${period.skyGlow.replace(/[\d.]+\)$/, '0.12)')}, transparent 70%)` }}
          />
        </>
      )}
      {/* 地面辉光：让角色像站在光里而不是贴在墙纸上 */}
      {!backgroundImageUrl && (
        <div className="absolute inset-x-0 bottom-0 h-[38%]" style={{ background: `linear-gradient(to top, ${ambientTint}14, transparent)` }} />
      )}
      {frameStyle === 'otome' && (
        <div className="otome-scene-backdrop pointer-events-none absolute inset-0" aria-hidden>
          <span className="otome-backdrop-arch otome-backdrop-arch--left" />
          <span className="otome-backdrop-arch otome-backdrop-arch--right" />
          <span className="otome-backdrop-planter otome-backdrop-planter--left" />
          <span className="otome-backdrop-planter otome-backdrop-planter--right" />
        </div>
      )}
      {frameStyle === 'cat' && (
        <div className="cat-scene-backdrop pointer-events-none absolute inset-0" aria-hidden>
          <span className="cat-backdrop-ear cat-backdrop-ear--left" />
          <span className="cat-backdrop-ear cat-backdrop-ear--right" />
        </div>
      )}
      {frameStyle === 'magazine' && <div className="magazine-scene-backdrop pointer-events-none absolute inset-0" aria-hidden />}
      {frameStyle === 'archive' && <div className="cardbook-scene-backdrop pointer-events-none absolute inset-0" aria-hidden />}
      {frameStyle === 'idol' && <div className="idol-scene-backdrop pointer-events-none absolute inset-0" aria-hidden />}

      {/* ── 角色全出血舞台 ── */}
      <div className="absolute inset-0">
        {staticCompanionActive ? (
          <StaticCompanionPortrait
            value={staticPortraitValue}
            characterName={character.name}
            spriteConfig={character.spriteConfig}
            touchEnabled={!editing && !touchSettingsOpen && !wardrobeOpen}
            onAvatarTouch={hit => { void respondToTouch(hit); }}
          />
        ) : (
          /* Wardrobe onboarding owns its own WebGL preview; suspend this one. */
          <VRMVideoCallStage
            characterName={character.name}
            fallbackAvatar={character.avatar}
            model={wardrobeLive2DSettings ? undefined : character.videoAvatar}
            motionState={motionState}
            audioFeed={getCompanionAudioFeed()}
            headMotionLocked={startupHeadLocked}
            emotion={performance.emotion}
            performance={performance}
            performanceQuality="high"
            accentColor={accentColor}
            baseFraming={activeCompanionFraming}
            framingEditable={editing}
            onFramingChange={editing && compositionFramingMode !== 'touch' ? setCompositionFramingDraft : undefined}
            stageCrop={activeCompanionCrop}
            showCropGuide={editing && editingPanel === 'character' && compositionFramingMode === 'base'}
            touchRegions={editing && character.videoAvatar?.format === 'live2d' ? touchRegionsDraft : undefined}
            touchRegionEditingZone={editing && editingPanel === 'character' && compositionFramingMode === 'touch' && character.videoAvatar?.format === 'live2d' ? touchRegionEditingZone : undefined}
            onTouchRegionsChange={editing ? setTouchRegionsDraft : undefined}
            onChooseModel={() => openApp(AppID.Call)}
            onExpressionsDiscovered={setVrmExpressions}
            onAvatarTouch={editing ? undefined : hit => { void respondToTouch(hit); }}
            onModelReady={handleStageModelReady}
            onModelError={handleStageModelError}
            touchImpulseNonce={lastHit?.nonce}
            externalManualAction={wardrobeTrigger}
            companionMode
            maxFps={30}
          />
        )}
        {!staticCompanionActive && (
          <CompanionStageLoadingCurtain
            phase={stageCurtainPhase}
            characterName={character.name}
            accentColor={uiTint}
            surfaceColor={palette.shadow}
            lightSurface={frameStyle === 'otome' || frameStyle === 'magazine' || frameStyle === 'archive'}
          />
        )}
        {ripple && !editing && (
          <span
            key={ripple.nonce}
            className="pointer-events-none absolute z-40 h-12 w-12 rounded-full border border-white/75"
            style={{
              left: `${ripple.x * 100}%`,
              top: `${ripple.y * 100}%`,
              width: `${38 + ripple.force * 18}px`,
              height: `${38 + ripple.force * 18}px`,
              boxShadow: `0 0 ${10 + ripple.force * 22}px ${uiTint}`,
              animation: `companion-ripple ${580 + ripple.force * 260}ms ease-out forwards`,
            }}
          />
        )}
        {touchBanner && !editing && (
          <div
            key={touchBanner.nonce}
            className="pointer-events-none absolute z-50 whitespace-nowrap rounded-full border border-white/40 bg-[#120d25]/88 px-3 py-1.5 text-[11px] font-medium tracking-wide text-white shadow-2xl"
            style={{
              left: `${touchBanner.x * 100}%`,
              top: `${touchBanner.y * 100}%`,
              animation: 'companion-touch-banner 1.65s ease-out forwards',
              boxShadow: `0 8px 26px ${palette.shadow}99, 0 0 20px ${uiTint}45`,
            }}
          >
            <span className="mr-1 text-pink-200">~❤</span>{touchBanner.text}<span className="ml-1 text-pink-200">❤~</span>
          </div>
        )}
        {touchBanner && !editing && [0, 1, 2].map(index => (
          <span
            key={`${touchBanner.nonce}-heart-${index}`}
            className="pointer-events-none absolute z-50 text-[15px] text-pink-200 drop-shadow"
            style={{
              left: `calc(${touchBanner.x * 100}% + ${(index - 1) * 18}px)`,
              top: `calc(${touchBanner.y * 100}% - ${index % 2 ? 2 : 12}px)`,
              animation: `companion-heart-pop 1.15s ease-out ${index * 90}ms forwards`,
            }}
          >♡</span>
        ))}
      </div>

      {/* 底部暗角：保证对话框和台词在亮色模型上仍可读（不挡触摸） */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[34%]"
        style={{ background: frameStyle === 'otome' ? 'linear-gradient(to top,rgba(241,233,214,.64),rgba(241,233,214,.08) 56%,transparent)' : frameStyle === 'cat' ? 'linear-gradient(to top,rgba(6,6,9,.9),rgba(19,12,28,.3) 54%,transparent)' : frameStyle === 'magazine' ? 'linear-gradient(to top,rgba(217,210,202,.74),rgba(241,237,229,.08) 54%,transparent)' : frameStyle === 'archive' ? 'linear-gradient(to top,rgba(255,250,242,.82),rgba(236,145,173,.08) 55%,transparent)' : `linear-gradient(to top, ${palette.shadow}c7, ${palette.shadow}47 55%, transparent)` }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-28"
        style={{ background: frameStyle === 'otome' ? 'linear-gradient(to bottom,rgba(255,252,241,.48),transparent)' : frameStyle === 'cat' ? 'linear-gradient(to bottom,rgba(8,7,13,.76),transparent)' : frameStyle === 'magazine' ? 'linear-gradient(to bottom,rgba(241,237,229,.76),transparent)' : frameStyle === 'archive' ? 'linear-gradient(to bottom,rgba(255,250,242,.66),transparent)' : `linear-gradient(to bottom, ${palette.shadow}80, transparent)` }}
      />

      {!editing && frameStyle === 'otome' && !touchSettingsOpen && !appStarOpen && (
        <OtomeCompanionChrome
          character={character}
          currentScheduleSlot={currentScheduleSlot}
          dayProgress={todayEventProgress}
          openApp={openApp}
          openCharacterSchedule={() => setScheduleViewerOpen(true)}
          openWardrobe={openWardrobe}
          openTouchSettings={openTouchSettings}
          openAllApps={() => setAppStarOpen(open => !open)}
          onHome={() => addToast('已经在月庭主页了', 'info')}
        />
      )}

      {!editing && frameStyle === 'cat' && !touchSettingsOpen && !appStarOpen && (
        <CatCompanionChrome
          character={character}
          currentScheduleSlot={currentScheduleSlot}
          dayProgress={todayEventProgress}
          openApp={openApp}
          openCharacterSchedule={() => setScheduleViewerOpen(true)}
          openWardrobe={openWardrobe}
          openTouchSettings={openTouchSettings}
          openAllApps={() => setAppStarOpen(open => !open)}
          onHome={() => addToast('已经在夜巡主页了', 'info')}
        />
      )}

      {!editing && frameStyle === 'magazine' && !touchSettingsOpen && !appStarOpen && (
        <MagazineCompanionChrome
          character={character}
          currentScheduleSlot={currentScheduleSlot}
          openApp={openApp}
          openCharacterSchedule={() => setScheduleViewerOpen(true)}
          openWardrobe={openWardrobe}
          openTouchSettings={openTouchSettings}
          openAllApps={() => setAppStarOpen(open => !open)}
        />
      )}

      {!editing && frameStyle === 'archive' && !touchSettingsOpen && !appStarOpen && (
        <CardbookCompanionChrome
          character={character}
          currentScheduleSlot={currentScheduleSlot}
          dayProgress={todayEventProgress}
          openApp={openApp}
          openCharacterSchedule={() => setScheduleViewerOpen(true)}
          openWardrobe={openWardrobe}
          openTouchSettings={openTouchSettings}
          openAllApps={() => setAppStarOpen(open => !open)}
        />
      )}

      {!editing && frameStyle === 'idol' && !touchSettingsOpen && !appStarOpen && (
        <IdolCompanionChrome
          character={character}
          currentScheduleSlot={currentScheduleSlot}
          dayProgress={todayEventProgress}
          hours={virtualTime.hours}
          minutes={virtualTime.minutes}
          openApp={openApp}
          openCharacterSchedule={() => setScheduleViewerOpen(true)}
          openWardrobe={openWardrobe}
          openTouchSettings={openTouchSettings}
          openAllApps={() => setAppStarOpen(open => !open)}
        />
      )}

      <CompanionWardrobeDrawer
        open={wardrobeOpen}
        styleId={frameStyle}
        characterName={character.name}
        wardrobeActions={wardrobeActions}
        activeActionId={character.videoAvatar?.format === 'live2d' ? character.videoAvatar.activeWardrobeActionId : undefined}
        onSelect={selectWardrobeAction}
        modelOutfits={modelOutfits}
        activeModelAssetId={character.videoAvatar?.assetId}
        onSelectModel={selectModelOutfit}
        onDeleteModel={deleteModelOutfit}
        staticOutfits={staticOutfits}
        activeStaticOutfitId={activeStaticOutfitId}
        onSelectStaticOutfit={selectStaticOutfit}
        onDeleteStaticOutfit={deleteStaticOutfit}
        onDeleteWardrobeAction={deleteWardrobeAction}
        staticMode={staticCompanionActive}
        staticSource={staticCompanionActive ? activeCompanionSource : undefined}
        discoveryHint={wardrobeDiscoveryOpened}
        onOpenComposition={openCompositionEditor}
        onImportOutfit={importWardrobeOutfit}
        importBusy={wardrobeImportBusy}
        onManageActions={() => {
          closeWardrobe();
          openApp(activeCompanionSource === 'date' ? AppID.Date : activeCompanionSource === 'upload' ? AppID.Appearance : AppID.Call);
        }}
        onClose={closeWardrobe}
      />

      {wardrobeLive2DSettings && (
        <Live2DActionSettings
          config={wardrobeLive2DSettings}
          characterName={character.name}
          accentColor={uiTint}
          setupMode="import"
          onClose={() => setWardrobeLive2DSettings(null)}
          onSave={config => {
            updateCharacter(character.id, prev => ({
              videoAvatar: prev.videoAvatar?.assetId === config.assetId ? config : prev.videoAvatar,
              videoAvatarWardrobe: (prev.videoAvatarWardrobe || []).map(model => (
                model.assetId === config.assetId ? config : model
              )),
            }));
            setWardrobeLive2DSettings(null);
            addToast('Live2D 衣橱模型已保存', 'success');
          }}
        />
      )}

      <ScheduleFullscreenViewer
        open={scheduleViewerOpen}
        onClose={() => setScheduleViewerOpen(false)}
        characters={characters}
        activeCharId={character.id}
        onSwitchCharacter={setActiveCharacterId}
        schedule={hudContent.schedule}
        activeCharacter={character}
      />

      {/* ── 顶部：统一尺寸的角色内容 HUD。真实心声、聊天和日程直接出现在桌面。 ── */}
      {!editing && !independentChrome && (
        <div
          className="companion-hud-shell absolute inset-x-3 z-30"
          style={{ top: 'max(2rem, calc(var(--safe-top, 0px) + 0.55rem))', animation: 'companion-hud-in 520ms ease-out both' }}
          data-testid="companion-game-hud"
        >
          <section
            className="companion-context-frame overflow-hidden border border-white/20 text-white"
            style={{ background: `linear-gradient(135deg, ${palette.panelTop}ef, ${palette.panelBottom}f4)`, boxShadow: `0 10px 30px ${palette.shadow}73, inset 0 1px 0 ${uiTint}35`, clipPath: 'polygon(0 10px, 10px 0, calc(100% - 10px) 0, 100% 10px, 100% calc(100% - 10px), calc(100% - 10px) 100%, 10px 100%, 0 calc(100% - 10px))' }}
            data-testid="companion-context-hud"
            data-ui-scale="medium"
          >
            <header className="flex h-12 items-center justify-between gap-3 px-3 sm:h-14 sm:px-4">
              <button onClick={() => openApp(AppID.Character)} className="flex min-w-0 items-center gap-2 text-left active:scale-[.98]">
                <span className="companion-avatar-frame relative h-8 w-8 shrink-0 overflow-hidden border bg-black/20 p-0.5 sm:h-10 sm:w-10" style={{ borderColor: `${uiTint}c9`, clipPath: 'polygon(20% 0, 80% 0, 100% 20%, 100% 80%, 80% 100%, 20% 100%, 0 80%, 0 20%)' }}>
                  <TokenImg value={character.avatar} alt="" className="h-full w-full object-cover" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold tracking-wide sm:text-[15px]">{character.name}</span>
                  <span className="block text-[8px] tracking-[0.14em] text-white/50 sm:text-[9px]">{period.label} · {activeCompanionSource === 'upload' ? '图片 / GIF' : activeCompanionSource === 'date' ? '见面表情同步' : character.videoAvatar ? '动作同步中' : '等待形象'}</span>
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-[11px] tabular-nums tracking-[0.14em] text-white/75 sm:text-[13px]">{hh}:{mm}</span>
                <button onClick={() => openApp(AppID.Appearance)} className="companion-hud-gear flex h-9 w-9 items-center justify-center border bg-black/20 text-white/80 active:scale-[.96] sm:h-11 sm:w-11" style={{ borderColor: `${uiTint}70` }} aria-label="外观设置">
                  <Gear size={18} />
                </button>
              </div>
            </header>
            <div className="companion-hud-grid grid grid-cols-3 border-t border-white/10">
              <button onClick={() => openApp(AppID.CheckPhone)} className="min-w-0 border-r border-white/10 px-3 py-2 text-left active:bg-white/5 sm:px-4 sm:py-2.5" data-testid="companion-hud-thought">
                <span className="flex items-center gap-1 text-[8px] font-semibold tracking-[0.14em] sm:text-[9px]" style={{ color: uiTint }}><Sparkle size={11} weight="fill" />当前心声</span>
                <span className="mt-1 block h-8 overflow-hidden text-[9px] leading-4 text-white/80 sm:h-9 sm:text-[11px]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{hudContent.thought || '尚未记录心声'}</span>
              </button>
              <button onClick={() => openApp(AppID.Chat)} className="min-w-0 border-r border-white/10 px-3 py-2 text-left active:bg-white/5 sm:px-4 sm:py-2.5" data-testid="companion-hud-chat">
                <span className="flex items-center gap-1 text-[8px] font-semibold tracking-[0.14em] sm:text-[9px]" style={{ color: uiTint }}><Icons.Chat className="h-[11px] w-[11px] sm:h-[13px] sm:w-[13px]" />最近聊天</span>
                <span className="mt-1 block h-8 overflow-hidden text-[9px] leading-4 text-white/80 sm:h-9 sm:text-[11px]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{hudContent.recentChat || '还没有聊天记录'}</span>
              </button>
              <button onClick={() => openApp(AppID.Schedule)} className="min-w-0 px-3 py-2 text-left active:bg-white/5 sm:px-4 sm:py-2.5" data-testid="companion-hud-schedule">
                <span className="flex items-center gap-1 text-[8px] font-semibold tracking-[0.14em] sm:text-[9px]" style={{ color: uiTint }}><Icons.Schedule className="h-[11px] w-[11px] sm:h-[13px] sm:w-[13px]" />此刻日程</span>
                <span className="mt-1 block h-8 overflow-hidden text-[9px] leading-4 text-white/80 sm:h-9 sm:text-[11px]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {currentScheduleSlot ? `${currentScheduleSlot.emoji || '◌'} ${currentScheduleSlot.startTime} ${currentScheduleSlot.activity}` : '今天还没有日程'}
                </span>
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── 角色旁边的手游快捷入口。与底栏共用 40px 控制尺寸。 ── */}
      {!editing && !independentChrome && !touchSettingsOpen && !appStarOpen && (
        <aside
          className="companion-side-rail absolute right-1 top-[28%] z-30 flex w-16 flex-col items-center gap-1.5 pb-3 pt-3 text-white sm:w-20"
          aria-label="角色快捷轨道"
          data-testid="companion-ornate-action-rail"
          data-visual-style="ornate-flat"
          data-ui-scale="medium"
        >
          <svg className="companion-rail-frame-art pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 82 356" preserveAspectRatio="none" aria-hidden>
            <path d="M14 1H67L80 14V338L69 355H13L2 340V13Z" fill={`${palette.panelBottom}9e`} stroke={`${uiTint}68`} strokeWidth="1" />
            <path d="M8 24V326M74 21V329" fill="none" stroke={`${uiTint}48`} strokeWidth="0.7" />
            <path d="M13 1H34M48 1H67M13 355H33M49 355H69" fill="none" stroke={`${uiTint}b8`} strokeWidth="0.8" />
            <path d="M41 39V319" fill="none" stroke={`${uiTint}58`} strokeWidth="0.7" strokeDasharray="2 5" />
            <path d="M3 78H10M72 63H79M3 274H9M73 292H80" fill="none" stroke={`${uiTint}94`} strokeWidth="0.8" />
          </svg>
          <span className="pointer-events-none absolute right-1 top-0 text-[8px] leading-none" style={{ color: uiTint }} aria-hidden>✦</span>

          <button onClick={openTouchSettings} className="companion-rail-button group relative z-10 flex flex-col items-center gap-1 active:scale-[.97]" data-testid="companion-touch-settings-button">
            {!preparedReactionCount && <span className="absolute right-0 top-0 z-20 h-1.5 w-1.5 rounded-full bg-[#ff5d9e] ring-2 ring-[#1a1028]" aria-label="尚未生成触摸反馈" />}
            <span className="companion-rail-shape relative flex h-10 w-10 rotate-45 items-center justify-center rounded-[0.72rem] border sm:h-12 sm:w-12" style={{ background: `${uiTint}50`, borderColor: `${uiTint}ec` }}>
              <span className="companion-rail-shape-inner absolute inset-[3px] rounded-[0.55rem] border" style={{ borderColor: `${uiTint}78` }} />
              <HandTap className="companion-rail-icon relative h-[18px] w-[18px] -rotate-45 text-white sm:h-[21px] sm:w-[21px]" weight="bold" />
            </span>
            <span className="text-[8px] tracking-[0.08em] text-white/95 sm:text-[9px]">触摸</span>
          </button>

          <button
            onClick={() => openApp(AppID.Appearance)}
            className="companion-rail-button group relative z-10 flex flex-col items-center gap-1 active:scale-[.97]"
            data-testid="companion-appearance-rail-button"
          >
            <span className="companion-rail-shape relative flex h-10 w-10 rotate-45 items-center justify-center rounded-[0.72rem] border bg-[#171023]/64 sm:h-12 sm:w-12" style={{ borderColor: `${uiTint}88` }}>
              <span className="companion-rail-shape-inner absolute inset-[3px] rounded-[0.55rem] border" style={{ borderColor: `${uiTint}2f` }} />
              <Icons.Appearance className="companion-rail-icon relative h-[17px] w-[17px] -rotate-45 text-white/95 sm:h-5 sm:w-5" />
            </span>
            <span className="text-[8px] tracking-[0.08em] text-white/90 sm:text-[9px]">外观</span>
          </button>

          <button onClick={openWardrobe} className="companion-rail-button group relative z-10 flex flex-col items-center gap-1 active:scale-[.97]" data-testid="companion-real-wardrobe-button" data-companion-wardrobe-trigger="true">
            <span className="companion-rail-shape relative flex h-10 w-10 rotate-45 items-center justify-center rounded-[0.72rem] border bg-[#171023]/64 sm:h-12 sm:w-12" style={{ borderColor: `${uiTint}88` }}>
              <span className="companion-rail-shape-inner absolute inset-[3px] rounded-[0.55rem] border" style={{ borderColor: `${uiTint}2f` }} />
              <TShirt className="companion-rail-icon relative h-[17px] w-[17px] -rotate-45 text-white/95 sm:h-5 sm:w-5" weight="bold" />
            </span>
            <span className="text-[8px] tracking-[0.08em] text-white/90 sm:text-[9px]">衣橱</span>
          </button>

          {[
            { id: AppID.Call, icon: 'Call' as const, label: '通话' },
            { id: AppID.Character, icon: 'Character' as const, label: '角色' },
          ].map(item => {
            const Icon = Icons[item.icon];
            return (
              <button key={item.id} onClick={() => openApp(item.id)} className="companion-rail-button group relative z-10 flex flex-col items-center gap-1 active:scale-[.97]">
                <span className="companion-rail-shape relative flex h-10 w-10 rotate-45 items-center justify-center rounded-[0.72rem] border bg-[#171023]/64 sm:h-12 sm:w-12" style={{ borderColor: `${uiTint}88` }}>
                  <span className="companion-rail-shape-inner absolute inset-[3px] rounded-[0.55rem] border" style={{ borderColor: `${uiTint}2f` }} />
                  <Icon className="companion-rail-icon relative h-[17px] w-[17px] -rotate-45 text-white/95 sm:h-5 sm:w-5" />
                </span>
                <span className="text-[8px] tracking-[0.08em] text-white/90 sm:text-[9px]">{item.label}</span>
              </button>
            );
          })}
        </aside>
      )}

      {/* ── 触摸设置抽屉：选部位，一次生成，之后只本地轮播。 ── */}
      {touchSettingsOpen && !editing && (
        <div
          className="absolute inset-0 z-[70] flex items-end bg-black/45 backdrop-blur-[2px]"
          onClick={() => { if (!settingsGenerating) setTouchSettingsOpen(false); }}
          data-testid="companion-touch-settings"
        >
          <section
            className="max-h-[88vh] w-full overflow-y-auto rounded-t-[2rem] border-t border-white/20 px-4 pb-5 pt-3 text-white shadow-[0_-24px_60px_rgba(0,0,0,.5)] backdrop-blur-2xl"
            style={{ background: `linear-gradient(165deg, ${palette.panelTop}f7, ${palette.panelBottom}fc)`, animation: 'companion-drawer-up 260ms ease-out both', paddingBottom: 'max(1.25rem, calc(var(--safe-bottom, 0px) + 1rem))' }}
            onClick={event => event.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" />
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <HandTap size={20} weight="bold" style={{ color: uiTint }} />
                  <h2 className="text-[15px] font-semibold tracking-wide text-white">触摸设置</h2>
                </div>
                <p className="mt-1 max-w-[24rem] text-[10px] leading-relaxed text-white/50">
                  先选可触摸部位，再一次生成整包反馈。以后每次戳戳只轮播本地台词和动作，不会逐次调用 API。
                </p>
              </div>
              <button
                onClick={() => setTouchSettingsOpen(false)}
                disabled={settingsGenerating}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white/[0.06] text-white/70 disabled:opacity-30"
                aria-label="关闭触摸设置"
              ><Check size={15} /></button>
            </div>

            <div
              className="mt-4 border border-white/14 bg-white/[0.035] p-3"
              style={{ clipPath: 'polygon(0 9px, 9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%)' }}
              data-testid="companion-startup-settings"
            >
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  aria-expanded={startupSettingsExpanded}
                  aria-controls="companion-startup-settings-body"
                  data-testid="companion-startup-settings-toggle"
                  onClick={() => setStartupSettingsExpanded(current => !current)}
                  className="min-w-0 flex-1 text-left outline-none"
                >
                  <div className="flex items-center gap-2">
                    <Sparkle size={14} weight="fill" style={{ color: uiTint }} />
                    <h3 className="text-[12px] font-semibold tracking-wide text-white">开场演出</h3>
                    <span className="border border-white/12 px-1.5 py-0.5 text-[7px] tracking-[0.16em] text-white/45">HOME INTRO</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[9px] text-white/48">
                    <span>{startupEnabled ? '已开启' : '未开启'} · {startupLine.trim() ? '已填写开场演出' : '点击展开设置'}</span>
                    <CaretDown
                      size={11}
                      className={`shrink-0 transition-transform ${startupSettingsExpanded ? 'rotate-180' : ''}`}
                      aria-hidden
                    />
                  </div>
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={startupEnabled}
                  data-testid="companion-startup-enabled"
                  disabled={settingsGenerating}
                  onClick={() => {
                    setSelectedStartupPresetId('');
                    setStartupEnabled(current => !current);
                  }}
                  className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition disabled:opacity-45"
                  style={{
                    borderColor: startupEnabled ? uiTint : 'rgba(255,255,255,.24)',
                    background: startupEnabled ? `${uiTint}45` : 'rgba(255,255,255,.05)',
                  }}
                >
                  <span
                    className="absolute top-[2px] h-3.5 w-3.5 rounded-full transition-all"
                    style={{ left: startupEnabled ? 18 : 2, background: startupEnabled ? uiTint : 'rgba(255,255,255,.45)' }}
                  />
                </button>
              </div>

              {startupSettingsExpanded && (
              <div id="companion-startup-settings-body" data-testid="companion-startup-settings-body">
              <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <select
                  value={selectedStartupPresetId}
                  disabled={settingsGenerating || !startupPresets.length}
                  onChange={event => selectStartupPreset(event.target.value)}
                  data-testid="companion-startup-preset-select"
                  aria-label="选择开场预设"
                  className="min-w-0 border border-white/12 bg-[#151021] px-3 py-2 text-[10px] text-white/82 outline-none disabled:opacity-45"
                >
                  <option value="">{startupPresets.length ? `选择已保存预设（${startupPresets.length}）` : '还没有开场预设'}</option>
                  {startupPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                </select>
                <button
                  type="button"
                  disabled={settingsGenerating || !selectedStartupPresetId}
                  onClick={deleteStartupPreset}
                  data-testid="companion-delete-startup-preset"
                  aria-label="删除所选开场预设"
                  className="flex h-9 w-9 items-center justify-center border border-white/12 text-white/58 disabled:opacity-30"
                ><Trash size={14} /></button>
              </div>
              <p className="mt-3 text-[9px] leading-relaxed text-white/48">
                中文原文、语音译文和动作都由你手动填写。每次刷新或重启后演一次；从 App 返回桌面不会重复播放。演出期间暂停随机转头。
              </p>
              <label className="mt-3 block text-[8px] tracking-[0.12em] text-white/48" htmlFor="companion-startup-line">
                中文原文（界面显示）
              </label>
              <textarea
                id="companion-startup-line"
                data-testid="companion-startup-line"
                value={startupLine}
                maxLength={180}
                disabled={settingsGenerating}
                onChange={event => {
                  setSelectedStartupPresetId('');
                  setStartupLine(event.target.value);
                }}
                placeholder="手动填写一句只有这个角色会说的话。"
                className="mt-1 min-h-[72px] w-full resize-y border border-white/12 bg-black/15 px-3 py-2 text-[11px] leading-relaxed text-white outline-none placeholder:text-white/24 focus:border-white/30 disabled:opacity-45"
              />
              <label className="mt-3 block text-[8px] tracking-[0.12em] text-white/48" htmlFor="companion-startup-voice-language">
                语音语言
              </label>
              <select
                id="companion-startup-voice-language"
                data-testid="companion-startup-voice-language"
                value={startupVoiceLanguage}
                disabled={settingsGenerating}
                onChange={event => {
                  setSelectedStartupPresetId('');
                  setStartupVoiceLanguage(event.target.value);
                  trackEvent('设置桌面陪伴语音语种', { 用途: '开机', 语种: voiceLanguageAnalyticsValue(event.target.value) });
                }}
                className="mt-1 w-full border border-white/12 bg-[#151021] px-3 py-2 text-[10px] text-white/82 outline-none disabled:opacity-45"
              >
                {VOICE_LANGUAGE_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.value ? option.label : '中文原文（不翻译）'}</option>
                ))}
              </select>

              <label className="mt-3 block text-[8px] tracking-[0.12em] text-white/48" htmlFor="companion-startup-translation">
                语音译文（实际朗读）
              </label>
              <textarea
                id="companion-startup-translation"
                data-testid="companion-startup-translation"
                value={startupTranslation}
                maxLength={240}
                disabled={settingsGenerating}
                onChange={event => {
                  setSelectedStartupPresetId('');
                  setStartupTranslation(event.target.value);
                }}
                placeholder={startupVoiceLanguage ? `手动填写 ${voiceLanguageLabel(startupVoiceLanguage)} 译文。` : '默认中文时可留空，将直接朗读上面的中文原文。'}
                className="mt-1 min-h-[64px] w-full resize-y border border-white/12 bg-black/15 px-3 py-2 text-[11px] leading-relaxed text-white outline-none placeholder:text-white/24 focus:border-white/30 disabled:opacity-45"
              />

              <button
                type="button"
                data-testid="companion-preview-startup"
                disabled={settingsGenerating || !startupLine.trim() || Boolean(startupVoiceLanguage && !startupTranslation.trim())}
                onClick={previewStartup}
                className="mt-2 w-full border border-white/14 bg-white/[0.025] py-2 text-[9px] font-medium text-white/76 transition active:scale-[.98] disabled:opacity-35"
              >
                预演一次
              </button>

              <button
                type="button"
                data-testid="companion-generate-startup-performance"
                disabled={settingsGenerating || !startupLine.trim() || Boolean(startupVoiceLanguage && !startupTranslation.trim())}
                onClick={() => { void generateStartupPerformancePack(); }}
                className="mt-2 flex w-full items-center justify-center gap-1.5 border border-white/14 bg-white/[0.035] py-2 text-[9px] font-medium text-white/78 transition active:scale-[.98] disabled:opacity-35"
              >
                <Sparkle size={12} style={{ color: uiTint }} />
                {startupActionGenerating
                  ? '动作导演正在编排（只请求一次）…'
                  : startupCuesMatchDraft
                    ? `重新编排动作 · 当前 ${startupPerformanceCues.length} 拍`
                    : '让动作导演按台词编排'}
              </button>
              <div className="mt-1 text-center text-[7px] leading-relaxed text-white/30">
                一次 LLM 回复严格为每句话生成一个动作；失败不重试、不兜底。锁头只禁止头部转动，表情、手臂、身体与专属动作照常演出。
              </div>

              {startupCuesMatchDraft && (
                <div className="mt-3" data-testid="companion-startup-cue-editor">
                  <div className="mb-1.5 text-[8px] tracking-[0.1em] text-white/46">逐句动作</div>
                  <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
                    {startupPerformanceCues.map((cue, index) => {
                      const selected = index === selectedStartupCueIndex;
                      const sentence = startupCueSentences[index]?.text || `动作 ${index + 1}`;
                      return (
                        <button
                          key={`${cue.at}-${index}`}
                          type="button"
                          data-testid={`companion-startup-cue-${index}`}
                          aria-pressed={selected}
                          disabled={settingsGenerating}
                          onClick={() => { setStartupPerformanceCueIndex(index); setStartupPerformanceCuePhase('start'); }}
                          className="max-w-[148px] shrink-0 border px-2.5 py-2 text-left transition disabled:opacity-45"
                          style={{
                            borderColor: selected ? `${uiTint}aa` : 'rgba(255,255,255,.12)',
                            background: selected ? `${uiTint}1e` : 'rgba(255,255,255,.025)',
                            color: selected ? uiTint : 'rgba(255,255,255,.58)',
                          }}
                        >
                          <span className="block text-[8px] font-semibold">第 {index + 1} 句 · {Math.round(cue.at * 100)}%</span>
                          <span className="mt-0.5 block truncate text-[7px] opacity-70">{sentence}</span>
                          <span className="mt-1 block text-[7px] opacity-55">起始 → {cue.holdMs || 900}ms → {cue.endDirection ? '收尾' : '未设收尾'}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1" data-testid="companion-startup-cue-phase">
                    <button
                      type="button"
                      aria-pressed={startupPerformanceCuePhase === 'start'}
                      onClick={() => setStartupPerformanceCuePhase('start')}
                      className="border px-2 py-1.5 text-[8px]"
                      style={{ borderColor: startupPerformanceCuePhase === 'start' ? `${uiTint}aa` : 'rgba(255,255,255,.12)', color: startupPerformanceCuePhase === 'start' ? uiTint : 'rgba(255,255,255,.5)' }}
                    >1 · 起始动作</button>
                    <button
                      type="button"
                      aria-pressed={startupPerformanceCuePhase === 'end'}
                      onClick={() => setStartupPerformanceCuePhase('end')}
                      className="border px-2 py-1.5 text-[8px]"
                      style={{ borderColor: startupPerformanceCuePhase === 'end' ? `${uiTint}aa` : 'rgba(255,255,255,.12)', color: startupPerformanceCuePhase === 'end' ? uiTint : 'rgba(255,255,255,.5)' }}
                    >2 · 收尾动作</button>
                  </div>
                  <label className="mt-2 block text-[8px] text-white/46">
                    <span className="flex justify-between"><span>中段保持时长</span><span className="font-mono">{selectedStartupCue?.holdMs || 900}ms</span></span>
                    <input
                      type="range"
                      min={120}
                      max={5000}
                      step={40}
                      value={selectedStartupCue?.holdMs || 900}
                      disabled={settingsGenerating}
                      data-testid="companion-startup-cue-hold"
                      onChange={event => {
                        setSelectedStartupPresetId('');
                        setStartupPerformanceCues(cues => cues.map((cue, index) => index === selectedStartupCueIndex ? { ...cue, holdMs: Number(event.target.value) } : cue));
                      }}
                      className="mt-1 h-1 w-full"
                      style={{ accentColor: uiTint }}
                    />
                  </label>
                </div>
              )}

              <label className="mt-3 block text-[8px] tracking-[0.12em] text-white/48" htmlFor="companion-startup-preset-name">
                新预设名称
              </label>
              <input
                id="companion-startup-preset-name"
                data-testid="companion-startup-preset-name"
                value={startupPresetName}
                maxLength={40}
                disabled={settingsGenerating}
                onChange={event => setStartupPresetName(event.target.value)}
                placeholder={`开场演出 ${startupPresets.length + 1}`}
                className="mt-1 w-full border border-white/12 bg-black/15 px-3 py-2 text-[10px] text-white outline-none placeholder:text-white/24 disabled:opacity-45"
              />
              <div className="mt-1 text-[7px] leading-relaxed text-white/30">
                保存始终新建一套，不会覆盖下拉菜单里的旧预设；已生成语音也随各自预设独立保留。
              </div>

              <button
                type="button"
                data-testid="companion-generate-startup-voice"
                disabled={settingsGenerating || !startupLine.trim() || Boolean(startupVoiceLanguage && !startupTranslation.trim()) || !touchVoiceAvailable}
                onClick={() => { void generateStartupVoicePack(); }}
                className="mt-2 flex w-full items-center justify-center gap-1.5 border border-white/14 bg-white/[0.035] py-2 text-[9px] font-medium text-white/78 transition active:scale-[.98] disabled:opacity-35"
              >
                <SpeakerHigh size={12} style={{ color: uiTint }} />
                {startupVoiceGenerating
                  ? '正在生成并永久保存语音包…'
                  : startupVoiceMatchesDraft ? '重新生成开场语音包' : '生成并永久保存开场语音包'}
              </button>
              <div className="mt-1 text-center text-[7px] leading-relaxed text-white/30">
                {!touchVoiceAvailable
                  ? '角色尚未配置可用音色'
                  : startupVoiceMatchesDraft
                    ? `已保存${savedStartup?.voiceGeneratedAt ? ` · ${new Date(savedStartup.voiceGeneratedAt).toLocaleString()}` : ''}，以后开场直接复用`
                    : savedStartup?.voiceAssetId
                      ? '当前台词已变化；旧语音仍保存在本地，重新生成后才会播放'
                      : '生成一次后写入本地语音资产，刷新或重启不会重新调用 TTS'}
              </div>

              <details className="mt-3 border-t border-white/10 pt-2" data-testid="companion-startup-precision">
                <summary className="cursor-pointer select-none text-[9px] font-medium tracking-wide text-white/62">
                  {startupCuesMatchDraft ? `精调第 ${selectedStartupCueIndex + 1} 句` : '精调默认动作'} · 眼 / 身体 / 过冲回正
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="text-[8px] text-white/46">
                    情绪
                    <select
                      value={startupEditorPerformance.emotion}
                      disabled={settingsGenerating}
                      onChange={event => patchStartupPerformance({ emotion: event.target.value as AvatarPerformanceDirection['emotion'] })}
                      className="mt-1 w-full border border-white/12 bg-[#151021] px-2 py-2 text-[9px] text-white/82 outline-none"
                    >
                      {AVATAR_EMOTIONS.map(emotion => <option key={emotion} value={emotion}>{STARTUP_EMOTION_LABELS[emotion]}</option>)}
                    </select>
                  </label>
                  <label className="text-[8px] text-white/46">
                    主动作
                    <select
                      value={startupEditorPerformance.gesture}
                      disabled={settingsGenerating}
                      onChange={event => patchStartupPerformance({ gesture: event.target.value as AvatarPerformanceDirection['gesture'] })}
                      className="mt-1 w-full border border-white/12 bg-[#151021] px-2 py-2 text-[9px] text-white/82 outline-none"
                    >
                      {AVATAR_GESTURES.map(gesture => <option key={gesture} value={gesture}>{STARTUP_GESTURE_LABELS[gesture]}</option>)}
                    </select>
                  </label>
                </div>

                <div className="mt-3">
                  <div className="text-[8px] text-white/46">微表情（最多 4 个）</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {AVATAR_FACES.map(face => {
                      const selected = startupEditorPerformance.faces?.includes(face) || false;
                      return (
                        <button
                          key={face}
                          type="button"
                          aria-pressed={selected}
                          disabled={settingsGenerating}
                          onClick={() => patchStartupPerformance({
                            faces: selected
                              ? (startupEditorPerformance.faces || []).filter(item => item !== face)
                              : [...(startupEditorPerformance.faces || []), face].slice(0, 4),
                          })}
                          className="border px-2 py-1 text-[8px] transition disabled:opacity-45"
                          style={{
                            borderColor: selected ? `${uiTint}aa` : 'rgba(255,255,255,.12)',
                            background: selected ? `${uiTint}1e` : 'rgba(255,255,255,.025)',
                            color: selected ? uiTint : 'rgba(255,255,255,.54)',
                          }}
                        >
                          {STARTUP_FACE_LABELS[face]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {modelActions.length > 0 && (
                  <label className="mt-3 block text-[8px] text-white/46">
                    模型专属动作（可选）
                    <select
                      value={startupEditorPerformance.modelAction || ''}
                      disabled={settingsGenerating}
                      onChange={event => patchStartupPerformance({
                        modelAction: event.target.value || undefined,
                        modelActions: event.target.value ? [event.target.value] : [],
                      })}
                      className="mt-1 w-full border border-white/12 bg-[#151021] px-2 py-2 text-[9px] text-white/82 outline-none"
                    >
                      <option value="">不指定</option>
                      {modelActions.map(action => <option key={action.id} value={action.id}>{action.name}</option>)}
                    </select>
                  </label>
                )}

                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
                  {STARTUP_POSE_CONTROLS.map(control => {
                    const value = startupEditorPerformance.precision?.[control.key] ?? 0;
                    return (
                      <label key={control.key} className="min-w-0 text-[8px] text-white/46">
                        <span className="flex items-center justify-between gap-2">
                          <span>{control.label}</span>
                          <span className="font-mono text-white/66">{Math.round(value * 100)}</span>
                        </span>
                        <input
                          type="range"
                          min={-100}
                          max={100}
                          step={1}
                          value={Math.round(value * 100)}
                          disabled={settingsGenerating}
                          data-testid={`companion-startup-${control.key}`}
                          onChange={event => patchStartupPrecision({ [control.key]: Number(event.target.value) / 100 } as Partial<AvatarPerformancePrecision>)}
                          className="mt-1 h-1 w-full cursor-pointer"
                          style={{ accentColor: uiTint }}
                        />
                        <span className="mt-0.5 block text-[7px] text-white/25">{control.hint}</span>
                      </label>
                    );
                  })}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-4">
                  <label className="text-[8px] text-white/46">
                    <span className="flex justify-between"><span>轻微过冲</span><span className="font-mono">{Math.round((startupEditorPerformance.precision?.overshoot || 0) * 100)}%</span></span>
                    <input
                      type="range"
                      min={0}
                      max={20}
                      step={1}
                      value={Math.round((startupEditorPerformance.precision?.overshoot || 0) * 100)}
                      disabled={settingsGenerating}
                      onChange={event => patchStartupPrecision({ overshoot: Number(event.target.value) / 100 })}
                      className="mt-1 h-1 w-full"
                      style={{ accentColor: uiTint }}
                    />
                  </label>
                  <label className="text-[8px] text-white/46">
                    <span className="flex justify-between"><span>回正时长</span><span className="font-mono">{startupEditorPerformance.precision?.settleMs || 920}ms</span></span>
                    <input
                      type="range"
                      min={320}
                      max={2400}
                      step={40}
                      value={startupEditorPerformance.precision?.settleMs || 920}
                      disabled={settingsGenerating}
                      onChange={event => patchStartupPrecision({ settleMs: Number(event.target.value) })}
                      className="mt-1 h-1 w-full"
                      style={{ accentColor: uiTint }}
                    />
                  </label>
                </div>
                <div className="mt-2 text-[7px] leading-relaxed text-white/30">
                  精调只修改当前这一句，不会清空动作编排。开场台词播放完之前头部固定正中；身体、手臂、表情和模型专属动作保持独立。
                </div>
              </details>

              <button
                type="button"
                data-testid="companion-save-startup"
                disabled={settingsGenerating}
                onClick={saveStartupSettings}
                className="mt-3 w-full border py-2.5 text-[10px] font-semibold tracking-wide transition active:scale-[.99] disabled:opacity-45"
                style={{ borderColor: `${uiTint}9c`, background: `${uiTint}18`, color: uiTint }}
              >
                保存为新预设
              </button>
              </div>
              )}
            </div>

            <div className="mb-2 mt-5 flex items-center gap-2 text-[8px] tracking-[0.16em] text-white/42">
              <span className="h-px flex-1 bg-white/10" />
              触摸反馈包
              <span className="h-px flex-1 bg-white/10" />
            </div>
            <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <select
                value={selectedTouchPresetId}
                disabled={settingsGenerating || !touchPresets.length}
                onChange={event => selectTouchPreset(event.target.value)}
                data-testid="companion-touch-preset-select"
                aria-label="选择触摸预设"
                className="min-w-0 border border-white/12 bg-[#151021] px-3 py-2 text-[10px] text-white/82 outline-none disabled:opacity-45"
              >
                <option value="">{touchPresets.length ? `选择已保存预设（${touchPresets.length}）` : '还没有触摸预设'}</option>
                {touchPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
              <button
                type="button"
                disabled={settingsGenerating || !selectedTouchPresetId}
                onClick={deleteTouchPreset}
                data-testid="companion-delete-touch-preset"
                aria-label="删除所选触摸预设"
                className="flex h-9 w-9 items-center justify-center border border-white/12 text-white/58 disabled:opacity-30"
              ><Trash size={14} /></button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {(['head', 'face', 'hand', 'body', 'other'] as AvatarTouchZone[]).map(zone => {
                const selected = touchDraftZones.includes(zone);
                const count = savedTouchSettings?.reactions?.[zone]?.length || 0;
                return (
                  <button
                    key={zone}
                    onClick={() => toggleTouchZone(zone)}
                    disabled={settingsGenerating}
                    aria-pressed={selected}
                    data-testid={`companion-touch-zone-${zone}`}
                    className="flex items-center justify-between rounded-2xl border px-3 py-2.5 text-left transition active:scale-[.98] disabled:opacity-50"
                    style={{
                      background: selected ? `${uiTint}20` : 'rgba(255,255,255,.035)',
                      borderColor: selected ? `${uiTint}8c` : 'rgba(255,255,255,.11)',
                    }}
                  >
                    <span>
                      <span className="block text-[11px] font-medium text-white/90">{avatarTouchZoneLabel(zone)}</span>
                      <span className="mt-0.5 block text-[8px] text-white/40">{count ? `已有 ${count} 条` : '尚未生成'}</span>
                    </span>
                    <span
                      className="flex h-5 w-5 items-center justify-center rounded-full border text-[10px]"
                      style={{ borderColor: selected ? uiTint : 'rgba(255,255,255,.18)', background: selected ? uiTint : 'transparent', color: selected ? '#151023' : 'transparent' }}
                    >✓</span>
                  </button>
                );
              })}
            </div>

            <label className="mt-3 block text-[8px] tracking-[0.12em] text-white/48" htmlFor="companion-touch-voice-language">
              触摸语音语言
            </label>
            <select
              id="companion-touch-voice-language"
              data-testid="companion-touch-voice-language"
              value={touchVoiceLanguage}
              disabled={settingsGenerating}
              onChange={event => {
                setSelectedTouchPresetId('');
                setTouchVoiceLanguage(event.target.value);
                trackEvent('设置桌面陪伴语音语种', { 用途: '触摸', 语种: voiceLanguageAnalyticsValue(event.target.value) });
              }}
              className="mt-1 w-full border border-white/12 bg-[#151021] px-3 py-2 text-[10px] text-white/82 outline-none disabled:opacity-45"
            >
              {VOICE_LANGUAGE_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.value ? option.label : '中文原文（不翻译）'}</option>
              ))}
            </select>
            <div className="mt-1 text-[7px] leading-relaxed text-white/30">
              反馈包会把中文原文与{touchVoiceLanguage ? ` ${voiceLanguageLabel(touchVoiceLanguage)} ` : '中文'}语音文本分开保存；界面显示原文，语音只朗读译文。
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={touchGenerateVoice}
              disabled={settingsGenerating || !touchVoiceAvailable}
              data-testid="companion-touch-generate-voice"
              onClick={() => {
                setSelectedTouchPresetId('');
                setTouchGenerateVoice(current => !current);
              }}
              className="mt-3 flex w-full items-center gap-3 border px-3 py-2.5 text-left transition active:scale-[.99] disabled:opacity-45"
              style={{
                borderColor: touchGenerateVoice ? `${uiTint}9f` : 'rgba(255,255,255,.12)',
                background: touchGenerateVoice ? `${uiTint}12` : 'rgba(255,255,255,.025)',
                clipPath: 'polygon(0 7px, 7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%)',
              }}
            >
              <SpeakerHigh size={17} style={{ color: touchGenerateVoice ? uiTint : 'rgba(255,255,255,.55)' }} />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-medium text-white/90">同时生成语音</span>
                <span className="mt-0.5 block text-[8px] leading-relaxed text-white/42">
                  {touchVoiceAvailable
                    ? '勾选后预先合成并保存在本地；触摸时不会临时调用 TTS'
                    : `角色尚未配置可用音色，当前只生成${touchPackContentLabel}`}
                </span>
              </span>
              <span
                className="flex h-[18px] w-[18px] shrink-0 items-center justify-center border"
                style={{
                  borderColor: touchGenerateVoice ? uiTint : 'rgba(255,255,255,.25)',
                  background: touchGenerateVoice ? uiTint : 'transparent',
                  color: touchGenerateVoice ? palette.panelBottom : 'transparent',
                }}
              >
                <Check size={12} weight="bold" />
              </span>
            </button>

            <label className="mt-3 block text-[8px] tracking-[0.12em] text-white/48" htmlFor="companion-touch-preset-name">
              新预设名称
            </label>
            <input
              id="companion-touch-preset-name"
              data-testid="companion-touch-preset-name"
              value={touchPresetName}
              maxLength={40}
              disabled={settingsGenerating}
              onChange={event => setTouchPresetName(event.target.value)}
              placeholder={`触摸反馈 ${touchPresets.length + 1}`}
              className="mt-1 w-full border border-white/12 bg-black/15 px-3 py-2 text-[10px] text-white outline-none placeholder:text-white/24 disabled:opacity-45"
            />
            <div className="mt-1 text-[7px] leading-relaxed text-white/30">
              每次生成都会保存为新预设；旧反馈包和它引用的本地语音不会被覆盖。
            </div>

            <button
              onClick={() => { void generateTouchReactionPack(); }}
              disabled={settingsGenerating || !touchDraftZones.length}
              data-testid="companion-generate-touch-pack"
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-[12px] font-semibold tracking-wide text-[#171126] shadow-lg transition active:scale-[.98] disabled:opacity-45"
              style={{ background: `linear-gradient(110deg, ${uiTint}, #ffd8ef 58%, #ffffff)` }}
            >
              <Sparkle size={15} weight="fill" />
              {touchGenerating
                ? touchVoiceProgress
                  ? `正在合成本地语音 ${touchVoiceProgress.completed}/${touchVoiceProgress.total}…`
                  : `正在生成${touchPackContentLabel}…`
                : '生成并保存新预设'}
            </button>
            <div className="mt-2 text-center text-[8px] tracking-wide text-white/30">
              {savedTouchSettings?.generatedAt
                ? `上次生成 ${new Date(savedTouchSettings.generatedAt).toLocaleString()} · 台词 ${preparedReactionCount} 条 · 语音 ${preparedVoiceCount} 条`
                : `${touchPackContentLabel}正常只请求一次；语音仅在勾选时批量预生成`}
            </div>
          </section>
        </div>
      )}
      {/* ── galgame 对话框：亮色台词板，不再像聊天消息卡。 ── */}
      {dialogVisible && (
        <div
          className="companion-dialogue-shell absolute inset-x-4 z-40"
          style={{ bottom: 'max(6.5rem, calc(var(--safe-bottom, 0px) + 6.3rem))', animation: 'companion-dialog-in 280ms ease-out both' }}
          data-testid="companion-dialogue"
        >
          <div className="relative isolate overflow-visible px-4 pb-3 pt-4 text-white" data-testid="companion-dialogue-surface">
            <div
              className="companion-dialogue-backdrop pointer-events-none absolute inset-0 -z-10 border shadow-2xl"
              style={{
                background: `linear-gradient(145deg, ${palette.panelTop}f0, ${palette.panelBottom}f7)`,
                borderColor: `${uiTint}9c`,
                boxShadow: `0 18px 44px ${palette.shadow}b8, inset 0 1px 0 ${uiTint}36`,
                clipPath: 'polygon(0 12px, 12px 0, calc(100% - 14px) 0, 100% 14px, 100% calc(100% - 10px), calc(100% - 10px) 100%, 16px 100%, 0 calc(100% - 16px))',
              }}
            />
            <div className="absolute inset-x-5 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${uiTint}, transparent)` }} />
            <div className="pointer-events-none absolute bottom-3 right-4 flex h-4 items-end gap-[2px] opacity-35" aria-hidden>
              {[5, 9, 4, 12, 7, 14, 8, 5, 10, 4].map((height, index) => (
                <span key={index} className="w-px" style={{ height, background: uiTint }} />
              ))}
            </div>
            <div
              className="companion-dialogue-label absolute -top-3 left-4 flex items-center gap-1.5 border border-white/20 px-3 py-1 text-[10px] font-semibold tracking-wide text-white shadow-lg"
              style={{ background: `linear-gradient(120deg, ${palette.panelTop}, ${uiTint}c9)`, boxShadow: `0 5px 16px ${palette.shadow}66`, clipPath: 'polygon(0 6px, 7px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 7px) 100%, 0 100%)' }}
            >
              {character.name}
              {line?.label && <span className="text-[8px] font-normal text-white/60">· {line.label}</span>}
            </div>

            {thinking && !line ? (
              <div className="flex items-center gap-1.5 py-1.5 pl-1">
                {[0, 1, 2].map(index => (
                  <span
                    key={index}
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: uiTint, animation: `companion-thinking-dot 1.1s ease-in-out ${index * 0.18}s infinite` }}
                  />
                ))}
              </div>
            ) : (
              <>
                <div className="min-h-[2.5rem] whitespace-pre-line text-[13px] font-medium leading-[1.72] text-white/90">
                  {typed.shown}
                  {!typed.done && (
                    <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px]" style={{ background: uiTint, animation: 'companion-cursor 800ms step-end infinite' }} />
                  )}
                </div>
                {typed.done && line?.translation && line.translation !== displayLineText && (
                  <div className="mt-1.5 whitespace-pre-line border-t border-white/8 pt-1.5 text-[10px] leading-relaxed text-white/48" data-testid="companion-dialogue-translation">
                    {line.translation}
                  </div>
                )}
              </>
            )}

            {line?.kind === 'touch' && lastHit && !thinking && typed.done && (
              <button
                onClick={() => respondToTouch({ ...lastHit, nonce: Date.now() + Math.random() }, true)}
                className="mt-1.5 inline-flex items-center gap-1 text-[9px] font-medium active:scale-95"
                style={{ color: uiTint }}
                data-testid="companion-next-cached-reaction"
              >
                <ArrowClockwise size={11} /> 换一句 · 本地轮播
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── 手游底部主导航：角色仍是主页主体，功能入口只占一条短栏。 ── */}
      {!editing && !touchSettingsOpen && appStarOpen && (
        <>
          <button
            className="absolute inset-0 z-[35] bg-black/25 backdrop-blur-[1px]"
            onClick={() => setAppStarOpen(false)}
            aria-label="关闭功能星盘"
          />
          <section
            className="absolute inset-x-3 z-40 max-h-[52vh] overflow-hidden border border-white/20 shadow-2xl backdrop-blur-2xl"
            style={{
              bottom: 'max(6.4rem, calc(var(--safe-bottom, 0px) + 6.2rem))',
              background: `linear-gradient(155deg, ${palette.panelTop}f4, ${palette.panelBottom}fa)`,
              boxShadow: `0 24px 64px ${palette.shadow}d9, inset 0 1px 0 ${uiTint}45`,
              clipPath: 'polygon(0 12px, 12px 0, calc(100% - 12px) 0, 100% 12px, 100% calc(100% - 12px), calc(100% - 12px) 100%, 12px 100%, 0 calc(100% - 12px))',
              animation: 'companion-star-open 240ms ease-out both',
            }}
            data-testid="companion-app-star-panel"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <div className="flex items-center gap-2 text-[13px] font-semibold tracking-[0.16em] text-white">
                  <Sparkle size={15} weight="fill" style={{ color: uiTint }} /> 功能星盘
                </div>
                <div className="mt-0.5 text-[8px] tracking-[0.18em] text-white/35">SULLYOS · 全部真实功能</div>
              </div>
              <button onClick={() => setAppStarOpen(false)} className="h-7 w-7 border border-white/15 text-[12px] text-white/60 active:scale-90">×</button>
            </div>
            <div className="max-h-[calc(52vh-3.4rem)] overflow-y-auto px-3 py-3 no-scrollbar">
              <div className="grid grid-cols-4 gap-x-2 gap-y-3">
                {COMPANION_STAR_APPS.map(item => {
                  const Icon = Icons[item.icon];
                  return (
                    <button
                      key={item.id}
                      onClick={() => launchCompanionApp(item.id)}
                      className="group flex min-w-0 flex-col items-center gap-1.5 text-white/70 active:scale-90"
                    >
                      <span
                        className="relative flex h-10 w-10 items-center justify-center border border-white/15 bg-white/[0.055] transition group-active:bg-white/15"
                        style={{ color: uiTint, boxShadow: `inset 0 0 16px ${uiTint}12, 0 0 14px ${uiTint}0d`, clipPath: 'polygon(0 8px, 8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%)' }}
                      >
                        <Icon className="h-[19px] w-[19px]" />
                      </span>
                      <span className="max-w-full truncate text-[9px] tracking-wide">{item.label}</span>
                    </button>
                  );
                })}
                <button onClick={openTouchSettings} className="flex min-w-0 flex-col items-center gap-1.5 text-white/70 active:scale-90">
                  <span className="flex h-10 w-10 items-center justify-center border border-white/15 bg-white/[0.055]" style={{ color: uiTint }}><HandTap size={19} weight="bold" /></span>
                  <span className="text-[9px] tracking-wide">触摸设置</span>
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      {!editing && !independentChrome && !touchSettingsOpen && (
        <nav
          className="companion-bottom-dock absolute inset-x-3 z-40 h-[5.65rem] overflow-visible"
          style={{ bottom: 'max(0.5rem, calc(var(--safe-bottom, 0px) + 0.35rem))' }}
          aria-label="陪伴桌面导航"
          data-testid="companion-ornate-dock"
          data-visual-style="ornate-flat"
        >
          <div
            className="companion-dock-surface pointer-events-none absolute inset-0 border"
            style={{
              background: `linear-gradient(180deg, ${palette.panelTop}e8 0%, ${palette.panelBottom}f6 100%)`,
              borderColor: `${uiTint}70`,
              clipPath: 'polygon(0 12px, 12px 0, 37% 0, 42% 9px, 58% 9px, 63% 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 0 100%)',
            }}
          />
          <div className="pointer-events-none absolute inset-x-[7%] top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${uiTint}b8 24%, ${uiTint}b8 76%, transparent)` }} />
          <div className="pointer-events-none absolute inset-x-[12%] bottom-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${uiTint}52, transparent)` }} />
          <span className="pointer-events-none absolute left-[7%] top-2 text-[6px]" style={{ color: uiTint }} aria-hidden>✦</span>
          <span className="pointer-events-none absolute right-[7%] top-2 text-[5px] text-white/60" aria-hidden>✦</span>
          <div className="relative z-10 grid h-full grid-cols-5 items-center gap-1 px-2">
            {[
              { id: AppID.Chat, icon: Icons.Chat, label: '聊天' },
              { id: AppID.Schedule, icon: Icons.Schedule, label: '日程' },
            ].map(item => (
              <button key={item.id} onClick={() => launchCompanionApp(item.id)} className="companion-dock-item flex h-full flex-col items-center justify-center gap-1 text-white/90 active:scale-[.97]">
                <span className="companion-dock-shape flex h-10 w-10 rotate-45 items-center justify-center rounded-[0.7rem] border bg-black/15 sm:h-12 sm:w-12" style={{ borderColor: `${uiTint}72` }}>
                  <item.icon className="companion-dock-icon h-5 w-5 -rotate-45 sm:h-6 sm:w-6" />
                </span>
                <span className="text-[9px] tracking-[0.12em] sm:text-[10px]">{item.label}</span>
              </button>
            ))}
            <button
              onClick={() => setAppStarOpen(open => !open)}
              className="companion-dock-primary group relative flex h-full flex-col items-center justify-center gap-0.5 text-white"
              aria-expanded={appStarOpen}
              aria-label="打开全部功能"
              data-testid="companion-app-star-button"
            >
              <span className="companion-dock-primary-frame relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full border sm:h-[4.25rem] sm:w-[4.25rem]" style={{ borderColor: `${uiTint}c4`, background: `${palette.panelBottom}f5` }}>
                <span className="companion-dock-primary-outline absolute inset-[5px] rounded-full border" style={{ borderColor: `${uiTint}60` }} />
                <span className="companion-dock-primary-core relative flex h-10 w-10 items-center justify-center rounded-full border sm:h-12 sm:w-12" style={{ borderColor: `${uiTint}df`, background: `${uiTint}36` }}>
                  {frameStyle === 'magazine' ? (
                    <span className="companion-dock-primary-glyph flex flex-col items-center font-black leading-none">
                      <span className="text-[13px] tracking-[-0.08em]">ALL</span>
                      <span className="mt-0.5 text-[5px] tracking-[0.18em]">INDEX</span>
                    </span>
                  ) : frameStyle === 'archive' ? (
                    <span className="companion-dock-primary-glyph font-serif text-[21px] leading-none">集</span>
                  ) : (
                    <Sparkle className="companion-dock-primary-glyph relative" size={23} weight="fill" />
                  )}
                  <span className="companion-dock-primary-mark absolute right-0.5 top-0.5 text-[6px] text-white/90">{frameStyle === 'idol' ? 'LIVE' : '✦'}</span>
                </span>
              </span>
              <span className="companion-dock-primary-label text-[9px] font-semibold tracking-[0.18em] sm:text-[10px]" style={{ color: uiTint }}>功能</span>
            </button>
            {[
              { id: AppID.VRWorld, icon: Icons.VRWorld, label: '彼方' },
              { id: AppID.Settings, icon: Icons.Settings, label: '设置' },
            ].map(item => (
              <button key={item.id} onClick={() => launchCompanionApp(item.id)} className="companion-dock-item flex h-full flex-col items-center justify-center gap-1 text-white/90 active:scale-[.97]">
                <span className="companion-dock-shape flex h-10 w-10 rotate-45 items-center justify-center rounded-[0.7rem] border bg-black/15 sm:h-12 sm:w-12" style={{ borderColor: `${uiTint}72` }}>
                  <item.icon className="companion-dock-icon h-5 w-5 -rotate-45 sm:h-6 sm:w-6" />
                </span>
                <span className="text-[9px] tracking-[0.12em] sm:text-[10px]">{item.label}</span>
              </button>
            ))}
          </div>
        </nav>
      )}
      {/* ── 右侧角色检查器：构图、裁剪与舞台视觉共用同一个可撤销编辑流程。 ── */}
      {editing && (
        <>
          {character.videoAvatar && editingPanel === 'character' && (
            <div
              className="pointer-events-none absolute left-4 z-40 border-l px-3 py-2 text-left backdrop-blur-md"
              style={{ top: 'max(2.4rem, calc(var(--safe-top, 0px) + .8rem))', right: compositionEditorCollapsed ? '3rem' : 'min(84vw, 22rem)', borderColor: `${uiTint}90`, background: `${palette.panelBottom}a8`, transition: 'right 200ms ease' }}
            >
              <span className="text-[9px] leading-relaxed text-white/78">拖动角色 · 双指缩放 · 虚线框为可视区</span>
            </div>
          )}
          <div
            className={`absolute bottom-0 right-0 top-0 z-50 w-[min(82vw,21rem)] transition-transform duration-200 ease-out ${compositionEditorCollapsed ? 'pointer-events-none translate-x-full' : 'translate-x-0'}`}
            data-testid="companion-composition-editor"
            data-placement="right-inspector"
            data-collapsed={compositionEditorCollapsed ? 'true' : 'false'}
          >
            <section
              className="h-full overflow-y-auto border-l border-white/20 px-4 pb-5 text-white shadow-2xl backdrop-blur-2xl no-scrollbar"
              style={{ paddingTop: 'max(1rem, calc(var(--safe-top, 0px) + .75rem))', paddingBottom: 'max(1.25rem, calc(var(--safe-bottom, 0px) + 1rem))', background: `linear-gradient(165deg, ${palette.panelTop}fa, ${palette.panelBottom}fd)`, boxShadow: `-24px 0 64px ${palette.shadow}bd, inset 1px 0 0 ${uiTint}28`, animation: 'companion-inspector-in 240ms cubic-bezier(.2,.8,.2,1) both' }}
            >
              <header className="flex items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold tracking-[0.12em]"><Crop size={14} weight="bold" style={{ color: uiTint }} />角色构图</div>
                  <div className="mt-0.5 text-[8px] tracking-[0.13em] text-white/36">CHARACTER INSPECTOR</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCompositionEditorCollapsed(true)}
                    className="flex h-7 w-7 items-center justify-center rounded-full border border-white/15 text-white/55 transition active:scale-90"
                    aria-label="暂时折叠角色构图面板"
                    title="暂时折叠"
                    data-testid="companion-collapse-composition"
                  ><CaretRight size={12} weight="bold" /></button>
                  <button onClick={cancelCompositionEditor} className="rounded-full border border-white/15 px-3 py-1.5 text-[10px] text-white/60 active:scale-95">取消</button>
                  <button
                    onClick={saveCompositionEditor}
                    className="inline-flex items-center gap-1 rounded-full px-3.5 py-1.5 text-[10px] font-semibold text-[#171126] shadow active:scale-95"
                    style={{ background: `linear-gradient(120deg, ${uiTint}, #fff)` }}
                    data-testid="companion-save-composition"
                  >
                    <Check size={12} weight="bold" /> 保存
                  </button>
                </div>
              </header>

              <div className="relative mt-4 grid grid-cols-2 border-b border-white/10">
                {([
                  ['character', '角色'],
                  ['stage', '舞台'],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setEditingPanel(id)}
                    className={`relative py-2 text-[10px] font-medium transition active:opacity-70 ${editingPanel === id ? 'text-white' : 'text-white/38'}`}
                  >{label}</button>
                ))}
                <span className={`pointer-events-none absolute bottom-0 left-0 h-px w-1/2 transition-transform duration-200 ${editingPanel === 'stage' ? 'translate-x-full' : ''}`} style={{ background: uiTint }} />
              </div>

              {editingPanel === 'character' && (
                <div className="mt-3" data-testid="companion-character-crop-editor">
                  {!character.videoAvatar ? (
                    <div className="rounded-2xl border border-dashed border-white/15 px-4 py-5 text-center">
                      <div className="text-[11px] text-white/70">还没有可裁剪的视频角色</div>
                      <button onClick={() => openApp(AppID.Call)} className="mt-2 rounded-full border border-white/15 px-3 py-1.5 text-[10px] text-white/55">去导入 VRM / Live2D</button>
                    </div>
                  ) : (
                    <>
                      {builtinSullyAvatar && (
                        <div className="mb-3 rounded-2xl border border-white/10 bg-black/15 p-2.5" data-testid="companion-builtin-quality-picker">
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="text-[9px] font-semibold tracking-[0.16em] text-white/48">内置模型画质</div>
                              <div className="mt-0.5 text-[8px] text-white/32">2K 默认更稳；4K 仅在高性能设备使用</div>
                            </div>
                            <span className="text-[8px] text-white/35">{builtinSullyAvatar.builtinQuality === 'hd' ? '≈85 MB' : '≈21 MB'}</span>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-1.5">
                            {([
                              { value: 'balanced' as const, label: '轻量 2K' },
                              { value: 'hd' as const, label: '高清 4K' },
                            ]).map(option => {
                              const active = builtinSullyAvatar.builtinQuality === option.value;
                              return (
                                <button
                                  key={option.value}
                                  onClick={() => chooseBuiltinSullyQuality(option.value)}
                                  className={`rounded-xl border py-2 text-[9px] font-medium transition active:scale-[.98] ${active ? 'bg-white/14 text-white' : 'border-white/8 bg-white/[.025] text-white/42'}`}
                                  style={active ? { borderColor: `${uiTint}88` } : undefined}
                                >{active && <Check size={10} weight="bold" className="mr-1 inline" />}{option.label}</button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {character.videoAvatar.format === 'live2d' && !builtinSullyAvatar && (
                        <div className="mb-3 rounded-2xl border border-white/10 bg-black/15 p-2.5" data-testid="companion-live2d-texture-quality-picker">
                          <div>
                            <div className="text-[9px] font-semibold tracking-[0.16em] text-white/48">运行纹理画质</div>
                            <div className="mt-0.5 text-[8px] leading-relaxed text-white/32">默认 2K 更稳；4K 会占用更多内存，并单独建立运行缓存</div>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-1.5">
                            {([
                              { value: 'balanced' as const, label: '轻量 2K' },
                              { value: 'hd' as const, label: '高清 4K' },
                            ]).map(option => {
                              const currentQuality = character.videoAvatar?.format === 'live2d' && character.videoAvatar.textureQuality === 'hd' ? 'hd' : 'balanced';
                              const active = currentQuality === option.value;
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  onClick={() => chooseImportedLive2DTextureQuality(option.value)}
                                  className={`rounded-xl border py-2 text-[9px] font-medium transition active:scale-[.98] ${active ? 'bg-white/14 text-white' : 'border-white/8 bg-white/[.025] text-white/42'}`}
                                  style={active ? { borderColor: `${uiTint}88` } : undefined}
                                  data-testid={`companion-live2d-texture-quality-${option.value}`}
                                >{active && <Check size={10} weight="bold" className="mr-1 inline" />}{option.label}</button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      <div className={`mb-3 grid gap-1.5 ${character.videoAvatar.format === 'live2d' ? 'grid-cols-3' : 'grid-cols-2'}`} data-testid="companion-framing-mode-picker">
                        <button
                          type="button"
                          aria-pressed={compositionFramingMode === 'base'}
                          onClick={() => setCompositionFramingMode('base')}
                          className={`border px-2 py-2 text-[9px] transition ${compositionFramingMode === 'base' ? 'bg-white/12 text-white' : 'border-white/10 text-white/42'}`}
                          style={compositionFramingMode === 'base' ? { borderColor: `${uiTint}88` } : undefined}
                        >日常构图</button>
                        <button
                          type="button"
                          aria-pressed={compositionFramingMode === 'face'}
                          data-testid="companion-face-anchor-mode"
                          onClick={() => {
                            setCompositionFramingMode('face');
                            setFaceAnchorDraftEnabled(true);
                          }}
                          className={`border px-2 py-2 text-[9px] transition ${compositionFramingMode === 'face' ? 'bg-white/12 text-white' : 'border-white/10 text-white/42'}`}
                          style={compositionFramingMode === 'face' ? { borderColor: `${uiTint}88` } : undefined}
                        >面部特写锚点{faceAnchorDraftEnabled ? ' · 已设' : ''}</button>
                        {character.videoAvatar.format === 'live2d' && (
                          <button
                            type="button"
                            aria-pressed={compositionFramingMode === 'touch'}
                            data-testid="companion-touch-region-mode"
                            onClick={() => setCompositionFramingMode('touch')}
                            className={`border px-2 py-2 text-[9px] transition ${compositionFramingMode === 'touch' ? 'bg-white/12 text-white' : 'border-white/10 text-white/42'}`}
                            style={compositionFramingMode === 'touch' ? { borderColor: `${uiTint}88` } : undefined}
                          >触摸圈选{touchRegionsDraft.length ? ` · ${touchRegionsDraft.length}` : ''}</button>
                        )}
                      </div>
                      {compositionFramingMode === 'face' && (
                        <div className="mb-3 border-l px-2.5 py-2 text-[8px] leading-relaxed text-white/48" style={{ borderColor: `${uiTint}88`, background: `${uiTint}0f` }}>
                          把脸拖到画面中心并调整到理想大小。保存后，摸脸或 AI 使用「拉近」镜头只会落到这个位置，不再按全身比例猜。
                        </div>
                      )}
                      {compositionFramingMode === 'touch' && character.videoAvatar.format === 'live2d' && (
                        <div className="mb-3 rounded-2xl border border-white/10 bg-black/15 p-2.5" data-testid="companion-touch-region-editor-panel">
                          <div className="text-[8px] leading-relaxed text-white/55">
                            先选部位，再在左侧模型上按住拖动，圈出椭圆区域。同一部位可画多个圈；圈会跟随这个模型，不受半身、全身或构图缩放影响。
                          </div>
                          <div className="mt-2 grid grid-cols-5 gap-1">
                            {([
                              { zone: 'head', label: '头', color: '#f5c86a' },
                              { zone: 'face', label: '脸', color: '#ff8fb7' },
                              { zone: 'hand', label: '手', color: '#77d9dd' },
                              { zone: 'body', label: '身体', color: '#9ba8ff' },
                              { zone: 'other', label: '其他', color: '#c6cbd5' },
                            ] as const).map(item => {
                              const count = touchRegionsDraft.filter(region => region.zone === item.zone).length;
                              const active = touchRegionEditingZone === item.zone;
                              return (
                                <button
                                  key={item.zone}
                                  type="button"
                                  onClick={() => setTouchRegionEditingZone(item.zone)}
                                  className={`min-w-0 rounded-xl border px-1 py-2 text-[8px] transition active:scale-95 ${active ? 'bg-white/12 text-white' : 'border-white/8 text-white/42'}`}
                                  style={active ? { borderColor: item.color, boxShadow: `inset 0 0 14px ${item.color}18` } : undefined}
                                  data-testid={`companion-touch-region-zone-${item.zone}`}
                                >
                                  <span className="mx-auto mb-1 block h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />
                                  {item.label}{count ? ` ${count}` : ''}
                                </button>
                              );
                            })}
                          </div>
                          <div className="mt-2 flex items-center justify-between border-t border-white/8 pt-2">
                            <span className="text-[8px] text-white/35">重叠时优先较小的圈</span>
                            <span className="flex gap-1">
                              <button
                                type="button"
                                disabled={!touchRegionsDraft.some(region => region.zone === touchRegionEditingZone)}
                                onClick={() => setTouchRegionsDraft(current => current.filter(region => region.zone !== touchRegionEditingZone))}
                                className="rounded-full px-2 py-1 text-[8px] text-rose-200/65 disabled:opacity-25"
                              >清除此部位</button>
                              <button
                                type="button"
                                disabled={!touchRegionsDraft.length}
                                onClick={() => setTouchRegionsDraft([])}
                                className="rounded-full px-2 py-1 text-[8px] text-rose-200/65 disabled:opacity-25"
                              >全部清除</button>
                            </span>
                          </div>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <div className="text-[9px] font-semibold tracking-[0.16em] text-white/48">{compositionFramingMode === 'face' ? '面部锚点大小与位置' : compositionFramingMode === 'touch' ? '圈选时的模型位置' : '大小与位置'}</div>
                        <button
                          onClick={() => {
                            if (compositionFramingMode === 'face') setFaceFramingDraft(makeFaceFramingSeed());
                            else { setFramingDraft(defaultCompanionFraming); setCropDraft(DEFAULT_STAGE_CROP); }
                          }}
                          className="inline-flex items-center gap-1 rounded-full border border-white/12 px-2 py-1 text-[9px] text-white/50 active:scale-95"
                        >
                          <ArrowClockwise size={10} weight="bold" /> {compositionFramingMode === 'face' ? '重置锚点' : compositionFramingMode === 'touch' ? '重置构图' : '全部重置'}
                        </button>
                      </div>

                      <label className="mt-2.5 block">
                        <span className="flex items-center justify-between text-[9px] text-white/58"><span>{compositionFramingMode === 'face' ? '特写大小' : '角色大小'}</span><b className="font-mono text-white/82">{compositionFramingDraft.scale.toFixed(2)}×</b></span>
                        <span className="mt-1.5 flex items-center gap-2">
                          <button onClick={() => setCompositionFramingDraft(current => ({ ...current, scale: Math.max(framingScaleMin, current.scale - .1) }))} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[.04] active:scale-90"><Minus size={11} /></button>
                          <input type="range" min={framingScaleMin} max={framingScaleMax} step="0.01" value={compositionFramingDraft.scale} onChange={event => setCompositionFramingDraft(current => ({ ...current, scale: Number(event.target.value) }))} className="h-1.5 min-w-0 flex-1 cursor-pointer accent-fuchsia-300" data-testid={compositionFramingMode === 'face' ? 'companion-face-framing-scale' : 'companion-framing-scale'} />
                          <button onClick={() => setCompositionFramingDraft(current => ({ ...current, scale: Math.min(framingScaleMax, current.scale + .1) }))} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[.04] active:scale-90"><Plus size={11} /></button>
                        </span>
                      </label>

                      {([
                        ['offsetX', '左右位置', framingOffsetXMax],
                        ['offsetY', '上下位置', framingOffsetYMax],
                      ] as const).map(([key, label, limit]) => (
                        <label key={key} className="mt-2.5 block">
                          <span className="flex items-center justify-between text-[9px] text-white/58"><span>{label}</span><b className="font-mono text-white/82">{Math.round(compositionFramingDraft[key] * 100)}%</b></span>
                          <input type="range" min={-limit} max={limit} step="0.01" value={compositionFramingDraft[key]} onChange={event => setCompositionFramingDraft(current => ({ ...current, [key]: Number(event.target.value) }))} className="mt-1.5 h-1.5 w-full cursor-pointer accent-fuchsia-300" data-testid={`companion-${compositionFramingMode === 'face' ? 'face-' : ''}framing-${key}`} />
                        </label>
                      ))}
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => setCompositionFramingDraft(current => ({ ...current, offsetX: 0, offsetY: 0 }))} className="flex-1 rounded-xl border border-white/12 bg-white/[.045] py-2 text-[9px] text-white/58 active:scale-[.98]"><ArrowsOutCardinal className="mr-1 inline" size={11} />角色居中</button>
                        {compositionFramingMode === 'face' ? (
                          <button onClick={() => { setFaceAnchorDraftEnabled(false); setCompositionFramingMode('base'); }} className="flex-1 rounded-xl border border-rose-300/20 bg-rose-950/20 py-2 text-[9px] text-rose-200/65 active:scale-[.98]">清除锚点</button>
                        ) : (
                          <button onClick={() => setFramingDraft(defaultCompanionFraming)} className="flex-1 rounded-xl border border-white/12 bg-white/[.045] py-2 text-[9px] text-white/58 active:scale-[.98]">适配舞台</button>
                        )}
                      </div>

                      {compositionFramingMode === 'base' && <div className="mt-3 border-t border-white/10 pt-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-[9px] font-semibold tracking-[0.16em] text-white/48">自定义裁剪</div>
                            <div className="mt-0.5 text-[8px] text-white/32">收紧虚线框，隐藏角色画布的多余边缘</div>
                          </div>
                          {cropAdjusted && <button onClick={() => setCropDraft(DEFAULT_STAGE_CROP)} className="rounded-full px-2 py-1 text-[9px] text-white/45 active:scale-95">清空裁剪</button>}
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
                          {([
                            ['top', '上边'], ['bottom', '下边'], ['left', '左边'], ['right', '右边'],
                          ] as const).map(([edge, label]) => (
                            <label key={edge} className="block">
                              <span className="flex justify-between text-[8px] text-white/52"><span>{label}</span><b className="font-mono text-white/75">{Math.round(cropDraft[edge] * 100)}%</b></span>
                              <input type="range" min="0" max="0.42" step="0.005" value={cropDraft[edge]} onChange={event => setCropDraft(current => clampStageCrop({ ...current, [edge]: Number(event.target.value) }))} className="mt-1 h-1.5 w-full cursor-pointer accent-pink-300" data-testid={`companion-crop-${edge}`} />
                            </label>
                          ))}
                        </div>
                      </div>}
                    </>
                  )}
                </div>
              )}

              {editingPanel === 'stage' && (
                <div className="mt-3">
                  <div className="text-[9px] tracking-[0.2em] text-white/40">舞台背景</div>
                  <div className="mt-2 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
                    <button onClick={() => { void applyCompanionBackground(undefined); }} className={`flex shrink-0 flex-col items-center gap-1 active:scale-95 ${!background ? '' : 'opacity-70'}`}>
                      <span className="h-14 w-[4.5rem] rounded-xl border" style={{ borderColor: !background ? uiTint : 'rgba(255,255,255,.14)', borderWidth: !background ? 2 : 1, background: `radial-gradient(120% 70% at 50% -12%, ${period.skyGlow}, transparent 70%), linear-gradient(180deg, ${palette.baseTop}, ${palette.baseBottom})` }} />
                      <span className="text-[9px] text-white/60">时段天光</span>
                    </button>
                    {COMPANION_BG_PRESETS.map(preset => {
                      const active = background === `preset:${preset.id}`;
                      return (
                        <button key={preset.id} onClick={() => { void applyCompanionBackground(`preset:${preset.id}`); }} className={`flex shrink-0 flex-col items-center gap-1 active:scale-95 ${active ? '' : 'opacity-70'}`}>
                          <span className="h-14 w-[4.5rem] rounded-xl border" style={{ borderColor: active ? uiTint : 'rgba(255,255,255,.14)', borderWidth: active ? 2 : 1, background: preset.css }} />
                          <span className="text-[9px] text-white/60">{preset.name}</span>
                        </button>
                      );
                    })}
                    <button onClick={chooseBackgroundImage} className="flex shrink-0 flex-col items-center gap-1 active:scale-95">
                      <span className="flex h-14 w-[4.5rem] items-center justify-center rounded-xl border bg-white/[0.06] text-white/60" style={{ borderColor: backgroundImageUrl ? uiTint : 'rgba(255,255,255,.14)', borderWidth: backgroundImageUrl ? 2 : 1, ...(backgroundImageUrl ? { backgroundImage: `url(${backgroundImageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}) }}>
                        {!backgroundImageUrl && <UploadSimple size={16} weight="bold" />}
                      </span>
                      <span className="text-[9px] text-white/60">{backgroundImageUrl ? '换一张' : '自定义'}</span>
                    </button>
                    {backgroundImageUrl && (
                      <button onClick={() => { void applyCompanionBackground(undefined); }} className="flex shrink-0 flex-col items-center gap-1 active:scale-95">
                        <span className="flex h-14 w-[4.5rem] items-center justify-center rounded-xl border border-rose-300/30 bg-rose-950/40 text-rose-200/80"><Trash size={15} weight="bold" /></span>
                        <span className="text-[9px] text-rose-200/60">移除</span>
                      </button>
                    )}
                  </div>
                  <div className="mt-4 border-t border-white/10 pt-3" data-testid="companion-frame-style-picker">
                    <div className="text-[9px] tracking-[0.2em] text-white/40">舞台视觉语言</div>
                    <div className="mt-2 divide-y divide-white/8 border-y border-white/8">
                      {COMPANION_FRAME_STYLES.map(style => {
                        const active = frameStyle === style.id;
                        return (
                          <button
                            key={style.id}
                            type="button"
                            onClick={() => chooseCompanionFrameStyle(style.id)}
                            className="flex w-full items-center gap-3 py-2.5 text-left transition active:bg-white/[.04]"
                            data-testid={`companion-frame-style-${style.id}`}
                          >
                            <span className="relative h-12 w-[4.25rem] shrink-0 overflow-hidden border" style={{ background: style.swatch, borderColor: active ? uiTint : 'rgba(255,255,255,.14)' }}>
                              <span className={`absolute left-2 right-2 top-2 h-2 border ${style.id === 'magazine' ? 'rounded-none border-black/55 bg-white/65' : style.id === 'otome' ? 'rounded-t-full border-amber-200/80 bg-[#fff8e8]' : style.id === 'cat' ? 'rounded-full border-[#b9f36a]/55 bg-black/55' : style.id === 'idol' ? 'rounded-full border-white/45 bg-white/14' : 'border-white/45 bg-black/15'}`} />
                              <span className={`absolute bottom-2 right-2 h-4 w-4 border border-white/55 bg-white/10 ${style.id === 'tech' ? 'rotate-45' : style.id === 'otome' ? 'rounded-full bg-[#df82a8]' : style.id === 'cat' ? 'rounded-[45%] border-[#b9f36a]/70 bg-[#7137a6]' : style.id === 'archive' ? '[clip-path:polygon(50%_0,100%_30%,82%_100%,18%_100%,0_30%)]' : style.id === 'idol' ? 'rounded-full' : ''}`} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[11px] font-semibold text-white/88">{style.name}</span>
                              <span className="mt-0.5 block text-[8px] leading-relaxed text-white/38">{style.description}</span>
                            </span>
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center border border-white/10 text-white/18" style={active ? { borderColor: `${uiTint}88`, color: uiTint, background: `${uiTint}12` } : undefined}>
                              {active && <Check size={12} weight="bold" aria-label="当前框架" />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>
          {compositionEditorCollapsed && (
            <button
              type="button"
              onClick={() => setCompositionEditorCollapsed(false)}
              className="absolute right-0 z-[51] flex items-center gap-1 rounded-l-2xl border border-r-0 border-white/20 px-2 py-3 text-[9px] font-medium tracking-[0.08em] text-white/75 shadow-2xl backdrop-blur-xl transition active:translate-x-0.5"
              style={{ top: 'max(4.5rem, calc(var(--safe-top, 0px) + 3rem))', background: `linear-gradient(165deg, ${palette.panelTop}ee, ${palette.panelBottom}f8)`, boxShadow: `-12px 0 32px ${palette.shadow}a8` }}
              aria-label="展开角色构图面板"
              data-testid="companion-expand-composition"
            >
              <CaretLeft size={12} weight="bold" style={{ color: uiTint }} />
              <span className="[writing-mode:vertical-rl]">展开构图</span>
            </button>
          )}
        </>
      )}
      </div>
    </div>
  );
};

export default CompanionHome;
