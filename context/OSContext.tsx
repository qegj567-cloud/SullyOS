
import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { APIConfig, AppID, OSTheme, VirtualTime, CharacterProfile, CharacterGroup, ChatTheme, Toast, FullBackupData, UserProfile, ApiPreset, GroupProfile, SystemLog, Worldbook, NovelBook, SongSheet, Message, RealtimeConfig, AppearancePreset, CloudBackupConfig, CloudBackupFile, MemoryPalaceFeatureFlags } from '../types';
import { DB } from '../utils/db';
import type { AvatarTouchRecord } from '../utils/avatarTouch';
import { clampClaudeTemperature, modelRejectsSamplingParams, stripSamplingParams } from '../utils/samplingParamCompat';
import { buildMalformedImageDiagnostics, extractImagesInPlace, deepCloneForExport, parseImageDataUrlForBackup, type BackupObjectPath, type MalformedBackupImageDiagnostic } from '../utils/backupExport';
import { isBlobRef, getBlobForRef, restoreBlobRef, migrateDataUrlToRef, migrateAppearancePresetBlobRefs, migrateChatThemeBlobRefs, resolveBlobRefsDeep, resolveRefToDataUrl, BLOBREF_PREFIX, deleteBlobRefIfUnreferenced } from '../utils/blobRef';
import { resolveBlobRefsInRequestBody } from '../utils/apiBlobRefs';
import { collectBlobRefs, writeBlobsToZip, readBlobsIndex, restoreBlobsFromZip } from '../utils/backupBlobs';
import { initPwaIcon, clearPwaIcon } from '../utils/appIcon';
import { LEGACY_DEFAULT_WALLPAPER, isLegacyDefaultWallpaper, shouldPreserveLegacyDefaultWallpaper } from '../utils/wallpaperCompat';
import { migrateSharkpanAssets } from '../utils/sharkpanAssetMigration';
import { stripCompanionChatStyleResidue } from '../utils/companionThemeIsolation';
import { SULLY_DEFAULT_AVATAR_URL, shouldMigrateSullyAvatar } from '../utils/sullyAvatar';
import { exportStoryTheaterAppearanceSetting, restoreStoryTheaterAppearanceSetting } from '../utils/storyTheaterBackup';
import { createV2ArrayFieldWriter, writeV2Backup, assembleV2Backup, type BackupManifest, type ZipFileWriter, type ZipFileReader } from '../utils/backupFormat';
import { externalizeVoiceMessageBlobs, restoreVoiceMessageBlobs, shouldIncludeVoiceRelatedAssetInBackup } from '../utils/voiceMessageBackup';
import { ensureCompanionVoiceAssetsForBackup, isCompanionVoiceAssetId } from '../utils/companionVoiceAssets';
import { collectCharacterCompanionVoiceAssetIds } from '../utils/companionPresets';
import { encodeVectorsForBackup, encodeVectorsForBackupChunked } from '../utils/memoryPalace/db';
import { ProactiveChat } from '../utils/proactiveChat';
import { VRScheduler, type VRSessionOutcome } from '../utils/vrWorld/scheduler';
import { runVRSession } from '../utils/vrWorld/runSession';
import { logVRApiCall } from '../utils/vrWorld/vrApi';
import { VR_DEFAULT_INTERVAL_MIN } from '../utils/vrWorld/constants';
import { WorldScheduler, toTickEntries } from '../utils/worldHome/scheduler';
import { runWorldEpisode, rerollWorldCharBeat } from '../utils/worldHome/engine';
import { migrateWorldDaySegs } from '../utils/worldHome/prompts';
import { ChatParser } from '../utils/chatParser';
import { safeFetchJson } from '../utils/safeApi';
import { captureApiRequestOnce, getApiCallAmbientContext, recordApiCall, setApiCallAmbientContext, updateApiRequestCaptureUsage } from '../utils/apiCallLog';
import { isGlobalStreamEnabled, upgradeChatBodyToStream, assembleUpgradedResponse } from '../utils/streamUpgrade';
import { rewriteStaleWorkerUrl } from '../utils/proxyWorker';
import { buildFetchFailureDetail, classifyFetchFailure, describeReachabilityProbe, parseTargetUrl, probeOriginReachability, shouldProbeReachability, summarizeFetchRequestBody } from '../utils/networkFailureDiagnosis';
import { INSTALLED_APPS, HIDDEN_APP_NAMES } from '../constants';
import { isAnalyticsRequestUrl, trackEvent, trackDataScaleOnce, trackCurrentAppearanceOnce, trackCurrentCharSettingsOnce, trackCurrentFeaturesOnce } from '../utils/analytics';
import { collectAppearance, collectCharSettings, collectDataScale, collectFeatureFlagsAsync } from '../utils/analyticsSnapshot';
import { normalizeApiConfig, normalizeApiPreset } from '../utils/apiConfigNormalize';
import { getCheckPhoneApi, setCheckPhoneApi } from '../utils/checkPhoneApi';
import { markBackupDone } from '../utils/backupReminder';
import { collectSARLocalBackup, restoreSARLocalBackup } from '../utils/vrWorld/sarBackup';
import { normalizeCharacterImpression, normalizeCharacterDefaults } from '../utils/impression';
import { normalizeModelIds } from '../utils/modelList';
import {
  CONTEXT_RANGE_POLICY_VERSION,
  DEFAULT_MANUAL_CONTEXT_LIMIT,
  loadCharacterContextRange,
  migrateCharacterContextRange,
} from '../utils/chatContextRange';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { evaluateEmotionBackground } from '../hooks/useChatAI';
import { CHAT_GEN_EVENTS, setChatViewSnapshot } from '../utils/chatGenEvents';
import { buildChatRequestPayload } from '../utils/chatRequestPayload';
import { ChatPrompts } from '../utils/chatPrompts';
import { extractHtmlBlocks } from '../utils/htmlPrompt';
import { mergePalaceFragmentsIntoMemories } from '../utils/memoryPalace/pipeline';
import {
  MEMORY_AUTO_ARCHIVE_SYNC_EVENT,
  repairMissingAutoArchiveMemories,
  type MemoryAutoArchiveSyncDetail,
} from '../utils/memoryPalace/autoArchive';
import { ActiveMsgClient } from '../utils/activeMsgClient';
import { resolveCharTimeZone } from '../utils/timezone';
import { ActiveMsgStore, exportAmsg2GlobalConfig } from '../utils/activeMsgStore';
import { charMayHaveCloudState, purgeCharCloudState } from '../utils/amsg2CharCleanup';
import { markAmsgStateDirty, markAmsgStateDirtyForAll, resumePendingAmsgStateSync, syncAmsgToolConfigAndPrompts } from '../utils/amsgStateSync';
import { loadMusicPlaybackSnapshot } from './MusicContext';
import { setCharNameRegistry } from '../utils/charNameRegistry';
import { setMinimaxRegion } from '../utils/minimaxEndpoint';
import { setElevenLabsModel, setTtsProvider, setVoicePromptOverrides } from '../utils/ttsProvider';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { formatBytes } from '../utils/format';
import { isEmotionEvalSkipped } from '../utils/devDebug';
import { isBenignApplicationConsoleMessage } from '../utils/applicationConsole';
import { toMountedWorldbook } from '../utils/worldbook';
import { initLocalStorageMirror } from '../utils/lsMirror';
// 备份用：把存在 localStorage 的本机配置随导出一起带走（键名须与 importFullData 对齐）
import { exportPostOfficeLocal } from '../utils/vrWorld/postOffice';
import { exportSignalLocal } from '../utils/vrWorld/signal';
import { exportWorldHomeLocal } from '../utils/worldHome/localBackup';
import { exportLuckinLocal } from '../utils/luckinMcpClient';
import { exportMcdLocal } from '../utils/mcdMcpClient';
import { exportMcpLocal } from '../utils/mcpClient';
import { exportDesktopSkinLocal } from '../utils/desktopSkinBackup';
import { assertSupportedSullyBackup } from '../utils/backupImportPolicy';
import { createBuiltinSullyLive2DConfig, isBuiltinSullyLive2D, upgradeBuiltinSullyLive2DDefaults } from '../utils/builtinSullyLive2D';
import { normalizeCharacterRoomAssetsInPlace } from '../utils/roomTemplateAssets';

interface ProactiveQueueEntry {
  charId: string;
}

const normalizeProactiveAiContent = (raw: string): string => {
  let cleaned = raw;
  cleaned = cleaned.replace(/\[(?:(?:你|User|用户|System)\s*)?发送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');
  cleaned = cleaned.replace(
    /(^|\n)\s*(?:(?:你|User|用户|System)\s*)?发送了表情包[:：]\s*([^\n]+?)(?=\s*(?:\n|$))/g,
    (_match, lineStart: string, emojiName: string) => `${lineStart}[[SEND_EMOJI: ${emojiName.trim()}]]`
  );
  return cleaned;
};


type JSZipFileLike = {
  async(type: 'string' | 'base64'): Promise<string>;
  async(type: 'uint8array'): Promise<Uint8Array>;
};

type JSZipWriteOptions = {
  base64?: boolean;
  compression?: 'STORE' | 'DEFLATE';
  compressionOptions?: { level?: number };
};

type JSZipLike = {
  folder: (name: string) => { file: (name: string, data: string, options?: JSZipWriteOptions) => void } | null;
  file: {
    (name: string): JSZipFileLike | null;
    (name: string, data: string | Uint8Array, options?: JSZipWriteOptions): void;
  };
  generateAsync: (
    options: {
      type: 'blob';
      streamFiles?: boolean;
      compression?: string;
      compressionOptions?: { level: number };
    },
    onUpdate?: (metadata: { percent: number }) => void
  ) => Promise<Blob>;
};

type JSZipCtorLike = {
  new (): JSZipLike;
  loadAsync: (file: File) => Promise<JSZipLike>;
};

let jszipCtorPromise: Promise<JSZipCtorLike> | null = null;

export const IMPORT_IN_PROGRESS_KEY = 'sullyos_import_in_progress_v1';

type ImportProgressUpdate = {
  sourceSize?: number;
  assetDone?: number;
  assetTotal?: number;
  current?: string;
  currentFile?: string;
  currentFileSize?: number;
  itemDone?: number;
  itemTotal?: number;
  error?: string;
};

let _importStartedAt: number | null = null;
let _importSource: string | null = null;

const markImportInProgress = (phase: string, source?: string, update: ImportProgressUpdate = {}) => {
  try {
    let startedAt = Date.now();
    let existingSource = source || null;

    if (phase === 'parsing') {
      _importStartedAt = startedAt;
      _importSource = existingSource;
    } else {
      if (_importStartedAt) startedAt = _importStartedAt;
      if (!existingSource && _importSource) existingSource = _importSource;
    }

    localStorage.setItem(IMPORT_IN_PROGRESS_KEY, JSON.stringify({
      startedAt,
      updatedAt: Date.now(),
      phase,
      source: existingSource,
      ...update,
    }));
  } catch { /* ignore */ }
};

const clearImportInProgress = () => {
  _importStartedAt = null;
  _importSource = null;
  try { localStorage.removeItem(IMPORT_IN_PROGRESS_KEY); } catch { /* ignore */ }
};

const loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => {
  const existing = document.querySelector(`script[data-src=\"${src}\"]`) as HTMLScriptElement | null;
  if (existing) {
    if ((existing as any).dataset.loaded === 'true') {
      resolve();
      return;
    }
    existing.addEventListener('load', () => resolve(), { once: true });
    existing.addEventListener('error', () => reject(new Error(`load failed: ${src}`)), { once: true });
    return;
  }

  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.dataset.src = src;
  script.onload = () => {
    script.dataset.loaded = 'true';
    resolve();
  };
  script.onerror = () => reject(new Error(`load failed: ${src}`));
  document.head.appendChild(script);
});

const loadJSZip = async (): Promise<JSZipCtorLike> => {
  if (!jszipCtorPromise) {
    jszipCtorPromise = import('jszip')
      .then((mod) => ((mod as any).default || mod) as JSZipCtorLike)
      .catch((error) => {
        jszipCtorPromise = null;
        const msg = error instanceof Error ? error.message : 'unknown error'; const ctor = true;
        if (!ctor) throw new Error('JSZip 加载失败');
        throw new Error(`JSZip load failed: ${msg}`);
      });
  }
  return jszipCtorPromise;
};

// 默认实时配置
const defaultRealtimeConfig: RealtimeConfig = {
  weatherEnabled: false,
  weatherApiKey: '',
  weatherCity: 'Beijing',
  newsEnabled: false,
  newsApiKey: '',
  newsPlatforms: ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin'],
  notionEnabled: false,
  notionApiKey: '',
  notionDatabaseId: '',
  feishuEnabled: false,
  feishuAppId: '',
  feishuAppSecret: '',
  feishuBaseId: '',
  feishuTableId: '',
  xhsEnabled: false,
  cacheMinutes: 30
};

// 记忆宫殿全局配置（所有角色共用 embedding、副 LLM 和 rerank）
export interface MemoryPalaceGlobalConfig {
  embedding: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
  };
  lightLLM: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  // Rerank 模型配置（可选增强，接 cross-encoder rerank API）
  // 遵循 Cohere/Jina/SiliconFlow 通用协议：POST {baseUrl}/rerank
  // { model, query, documents, top_n } → { results: [{index, relevance_score}] }
  rerank: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    topN: number; // 额外召回条数（去重后追加到主 15 条后面）
  };
  /** 实验功能默认全关；每轮召回会把当时的值冻结进 Trace。 */
  featureFlags: MemoryPalaceFeatureFlags;
}

const defaultMemoryPalaceConfig: MemoryPalaceGlobalConfig = {
  embedding: { baseUrl: '', apiKey: '', model: 'BAAI/bge-m3', dimensions: 1024 },
  lightLLM: { baseUrl: '', apiKey: '', model: '' },
  rerank: { enabled: false, baseUrl: '', apiKey: '', model: 'BAAI/bge-reranker-v2-m3', topN: 5 },
  featureFlags: { recallRouter: false, interactionAdaptation: false, deepEngagement: false, epistemicState: false },
};

const normalizeMemoryPalaceConfig = (value?: Partial<MemoryPalaceGlobalConfig> | null): MemoryPalaceGlobalConfig => ({
  embedding: { ...defaultMemoryPalaceConfig.embedding, ...(value?.embedding || {}) },
  lightLLM: { ...defaultMemoryPalaceConfig.lightLLM, ...(value?.lightLLM || {}) },
  rerank: { ...defaultMemoryPalaceConfig.rerank, ...(value?.rerank || {}) },
  featureFlags: { ...defaultMemoryPalaceConfig.featureFlags, ...(value?.featureFlags || {}) },
});

/** deleteCharacter 的结果：cloud-cleanup-failed = 云端还有任务没清掉，本地没删。 */
export type DeleteCharacterResult = { status: 'deleted' } | { status: 'cloud-cleanup-failed' };

interface OSContextType {
  activeApp: AppID;
  openApp: (appId: AppID) => void;
  closeApp: () => void;
  theme: OSTheme;
  updateTheme: (updates: Partial<OSTheme>) => Promise<void>;
  virtualTime: VirtualTime;
  apiConfig: APIConfig;
  updateApiConfig: (updates: Partial<APIConfig>) => void;
  isLocked: boolean;
  unlock: () => void;
  isDataLoaded: boolean;
  
  characters: CharacterProfile[];
  activeCharacterId: string;
  addCharacter: () => Promise<CharacterProfile>;
  updateCharacter: (id: string, updates: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>)) => void;
  /**
   * 删角色。名下有 amsg2 任务的角色会先 await 云端任务取消 + client_state 清理，
   * 清不掉返回 cloud-cleanup-failed 且**不删本地**（调用方弹「重试 / 仍然删除」，
   * 「仍然删除」= 传 { force: true } 放行）。没有任务的角色维持本地直删的快路径。
   */
  deleteCharacter: (id: string, options?: { force?: boolean }) => Promise<DeleteCharacterResult>;
  setActiveCharacterId: (id: string) => void;

  // 角色分组（神经链接"文件夹"，与群聊 groups 无关）
  characterGroups: CharacterGroup[];
  createCharacterGroup: (name: string) => Promise<CharacterGroup | null>;
  renameCharacterGroup: (id: string, name: string) => Promise<void>;
  deleteCharacterGroup: (id: string) => Promise<void>;
  
  // Worldbooks
  worldbooks: Worldbook[];
  addWorldbook: (wb: Worldbook) => void;
  updateWorldbook: (id: string, updates: Partial<Worldbook>) => Promise<void>;
  deleteWorldbook: (id: string) => void;

  // Novels (NEW)
  novels: NovelBook[];
  addNovel: (novel: NovelBook) => void;
  updateNovel: (id: string, updates: Partial<NovelBook>) => Promise<void>;
  deleteNovel: (id: string) => void;

  // Songs (Songwriting)
  songs: SongSheet[];
  addSong: (song: SongSheet) => void;
  updateSong: (id: string, updates: Partial<SongSheet>) => Promise<void>;
  deleteSong: (id: string) => void;

  // Groups
  groups: GroupProfile[];
  createGroup: (name: string, members: string[]) => void;
  updateGroup: (id: string, updates: Partial<GroupProfile>) => Promise<void>;
  deleteGroup: (id: string) => void;

  // User Profile
  userProfile: UserProfile;
  updateUserProfile: (updates: Partial<UserProfile>) => void;

  availableModels: string[];
  setAvailableModels: (models: string[]) => void;
  
  // API Presets
  apiPresets: ApiPreset[];
  addApiPreset: (name: string, config: APIConfig) => void;
  updateApiPreset: (id: string, name: string, config: APIConfig) => void;
  removeApiPreset: (id: string) => void;

  // 实时配置 (天气、新闻、Notion等)
  realtimeConfig: RealtimeConfig;
  updateRealtimeConfig: (updates: Partial<RealtimeConfig>) => void;

  // 记忆宫殿全局配置（所有角色共用）
  memoryPalaceConfig: MemoryPalaceGlobalConfig;
  updateMemoryPalaceConfig: (updates: Partial<MemoryPalaceGlobalConfig>) => void;

  // 情绪 API（所有角色同步；是否启用仍各自独立）
  syncEmotionApiToAllCharacters: (api: { baseUrl: string; apiKey: string; model: string } | undefined) => void;

  // 远程向量存储配置 (Supabase pgvector)
  remoteVectorConfig: import('../utils/memoryPalace/types').RemoteVectorConfig;
  updateRemoteVectorConfig: (updates: Partial<import('../utils/memoryPalace/types').RemoteVectorConfig>) => void;

  customThemes: ChatTheme[];
  addCustomTheme: (theme: ChatTheme) => void;
  removeCustomTheme: (id: string) => void;

  // Appearance Presets
  appearancePresets: AppearancePreset[];
  saveAppearancePreset: (name: string, themeOverride?: OSTheme) => void;
  applyAppearancePreset: (id: string) => void;
  deleteAppearancePreset: (id: string) => void;
  renameAppearancePreset: (id: string, name: string) => void;
  exportAppearancePreset: (id: string) => Promise<Blob>;
  importAppearancePreset: (file: File) => Promise<void>;

  toasts: Toast[];
  addToast: (message: string, type?: Toast['type']) => void;

  // 长报错弹窗：toast 一行装不下 / 手机没法开 console 时, 用 showError 弹一个
  // 多行预览框 + 复制按钮, 方便用户把原文反馈过来。
  errorDialog: { title: string; details: string } | null;
  showError: (title: string, details: string) => void;
  dismissError: () => void;

  // Icons
  customIcons: Record<string, string>;
  setCustomIcon: (appId: string, iconUrl: string | undefined) => Promise<void>;

  // Appearance Reset
  resetAppearance: () => Promise<void>;

  // Global Message Signal
  lastMsgTimestamp: number; // New: Signal for Chat to refresh
  unreadMessages: Record<string, number>; // New: Track unread counts per character
  clearUnread: (charId: string) => void; // New: Method to clear unread

  // Set of charIds whose proactive AI generation is currently in flight.
  // Chat UI subscribes to this to render a soft "正在送达消息…" indicator
  // instead of having the message just pop in.
  proactiveComposingChars: Record<string, true>;

  // Cloud Backup
  cloudBackupConfig: CloudBackupConfig;
  updateCloudBackupConfig: (updates: Partial<CloudBackupConfig>) => void;
  cloudBackupToWebDAV: (mode: 'text_only' | 'media_only' | 'full') => Promise<void>;
  cloudRestoreFromWebDAV: (file: CloudBackupFile) => Promise<void>;
  listCloudBackups: () => Promise<CloudBackupFile[]>;

  // System
  exportSystem: (mode: 'text_only' | 'media_only' | 'full') => Promise<Blob>;
  importSystem: (fileOrJson: File | string) => Promise<void>; // Accept File or String
  resetSystem: () => Promise<void>;
  sysOperation: { status: 'idle' | 'processing', message: string, progress: number }; // Progress state

  // Logs
  systemLogs: SystemLog[];
  clearLogs: () => void;

  // Navigation Logic
  registerBackHandler: (handler: () => boolean) => () => void; // Returns unregister function
  handleBack: () => void;

  // Call Suspend
  suspendedCall: { charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string; pendingAvatarTouches?: AvatarTouchRecord[] } | null;
  suspendCall: (info: { charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string; pendingAvatarTouches?: AvatarTouchRecord[] }) => void;
  resumeCall: () => void;
  clearSuspendedCall: () => void;

  // 从聊天「见面」按钮跳进见面：携带目标角色，DateApp 挂载时自动进入该角色的见面流程
  dateAutoStartCharId: string | null;
  openDateWithChar: (charId: string) => void;
  consumeDateAutoStart: () => void;
}

const PREVIOUS_DEFAULT_WALLPAPER = [
  'radial-gradient(120% 85% at 12% 0%, rgba(255,255,255,0.72) 0%, rgba(255,255,255,0) 58%)',
  'repeating-linear-gradient(0deg, rgba(92,72,49,0.018) 0px, rgba(92,72,49,0.018) 1px, transparent 1px, transparent 4px)',
  'linear-gradient(145deg, #f3ecdf 0%, #e9dfcf 52%, #dfd2bf 100%)',
].join(', ');

// 默认桌面使用低对比暖米纸纹：只靠同色系层次与极细纤维感建立质感，
// 不再用粉绿撞色渐变。字符串同时作为“仍在使用系统默认壁纸”的稳定标记。
export const DEFAULT_WALLPAPER = [
  'radial-gradient(120% 85% at 12% 0%, rgba(255,255,255,0.64) 0%, rgba(255,255,255,0) 58%)',
  'repeating-linear-gradient(0deg, rgba(76,69,60,0.010) 0px, rgba(76,69,60,0.010) 1px, transparent 1px, transparent 4px)',
  'linear-gradient(145deg, #fdfcf9 0%, #f8f6f1 54%, #f1eee8 100%)',
].join(', ');

/** 纸感桌面的唯一默认配色来源；外观 App 的“默认风格”也直接复用，避免再次漂回旧粉蓝配置。 */
export const DEFAULT_PAPER_APPEARANCE = {
  hue: 88,
  saturation: 14,
  lightness: 46,
  contentColor: '#4b4136',
  desktopVariant: 'paper',
} as const;

/** 用户主动选择的最初默认界面：粉绿渐变、白色文字与白色玻璃桌面组件。 */
export const NOSTALGIA_APPEARANCE = {
  skin: 'default',
  desktopVariant: 'nostalgia',
  hue: 245,
  saturation: 25,
  lightness: 65,
  contentColor: '#ffffff',
  wallpaper: LEGACY_DEFAULT_WALLPAPER,
  darkMode: false,
  nowPlayingWidgetLight: false,
} as const;

/** 只迁移旧系统默认配色；任一项被用户改过都保留，避免把自定义主题误重置。 */
const migrateLegacyDefaultPalette = (theme: OSTheme): OSTheme => {
  const next = { ...theme };
  next.desktopVariant = 'paper';
  if (!next.contentColor || next.contentColor.toLowerCase() === '#ffffff') {
    next.contentColor = DEFAULT_PAPER_APPEARANCE.contentColor;
  }
  if (next.hue === 245 && next.saturation === 25 && next.lightness === 65) {
    next.hue = DEFAULT_PAPER_APPEARANCE.hue;
    next.saturation = DEFAULT_PAPER_APPEARANCE.saturation;
    next.lightness = DEFAULT_PAPER_APPEARANCE.lightness;
  }
  return next;
};

export const isPaperWallpaper = (wallpaper?: string) => {
  if (!wallpaper) return false;
  if (wallpaper === DEFAULT_WALLPAPER || wallpaper === PREVIOUS_DEFAULT_WALLPAPER) return true;
  const compact = wallpaper.toLowerCase().replace(/\s+/g, '');
  return (
    compact.includes('#f3ecdf') ||
    compact.includes('rgb(243,236,223)') ||
    compact.includes('#faf7f1') ||
    compact.includes('rgb(250,247,241)') ||
    compact.includes('#fdfcf9') ||
    compact.includes('rgb(253,252,249)')
  );
};

// 壁纸改存 Blob（见 utils/blobRef.ts）：assets store 的 'wallpaper' 记录只存一个指针值
// （blobref 令牌 / 旧 data: / http url），真正二进制在 blob_assets。内存里 theme.wallpaper
// 必须是能直接喂给 CSS 的 url，所以令牌要解析成 objectURL。全 OS 只有一张壁纸，用一个模块级
// 变量记住当前 objectURL，换壁纸时回收上一张，避免泄漏。
let currentWallpaperObjUrl: string | null = null;
let currentLockWallpaperObjUrl: string | null = null;

/**
 * 原子替换壁纸指针；旧令牌在确认已不被桌面、锁屏、外观预设或皮肤备份引用后后台清理。
 * 清理不阻塞换壁纸渲染，且任何引用检查失败都会保守地保留旧 Blob。
 */
const replaceWallpaperAssetPointer = async (assetId: 'wallpaper' | 'lock_wallpaper', next: string | null): Promise<void> => {
    let previous: string | null = null;
    try {
        previous = await DB.getAsset(assetId);
        if (next) await DB.saveAsset(assetId, next);
        else await DB.deleteAsset(assetId);
    } catch {
        return;
    }
    if (previous && previous !== next && isBlobRef(previous)) {
        void deleteBlobRefIfUnreferenced(previous);
    }
};

/**
 * 桌面小组件的槽位。每个槽位在 assets 表里是一行 `widget_<slot>`，值是 blobref 令牌。
 * 'bl' / 'br' 是已停用的老槽位，加载与写入时一律剥掉，不在这份清单里。
 */
const LAUNCHER_WIDGET_SLOTS = ['tl', 'tr', 'wide', 'dsq'] as const;

/**
 * 把「存储值」壁纸解析成可直接渲染的 url，并把指针（令牌）落进 assets 'wallpaper'。
 *   · blobref 令牌 → 读 Blob 建 objectURL；
 *   · 旧 data: → 惰性迁移成 Blob 令牌（存量用户下次加载即享空间收益），返回 objectURL；
 *   · http(s) / 空 / 渐变 → 删除 assets 指针，原样返回。
 * 传入空字符串（重置）时原样返回，交给上层用 DEFAULT_WALLPAPER 兜底。
 */
const resolveWallpaperStoredValue = async (w: string, preserveLegacyDefault = false): Promise<string> => {
    const revokePrev = () => {
        if (currentWallpaperObjUrl) { try { URL.revokeObjectURL(currentWallpaperObjUrl); } catch { /* ignore */ } currentWallpaperObjUrl = null; }
    };
    if (isLegacyDefaultWallpaper(w) && !preserveLegacyDefault) {
        await replaceWallpaperAssetPointer('wallpaper', null);
        revokePrev();
        return DEFAULT_WALLPAPER;
    }
    if (isBlobRef(w) || (w && w.startsWith('data:'))) {
        const token = isBlobRef(w) ? w : await migrateDataUrlToRef(w);
        const blob = await getBlobForRef(token);
        revokePrev();
        if (blob) {
            await replaceWallpaperAssetPointer('wallpaper', token);
            currentWallpaperObjUrl = URL.createObjectURL(blob);
            return currentWallpaperObjUrl;
        }
        if (isBlobRef(token)) {
            await replaceWallpaperAssetPointer('wallpaper', null);
            return DEFAULT_WALLPAPER;
        }
        // data: 迁移失败时仍保留旧格式，保证原图能继续显示。
        await replaceWallpaperAssetPointer('wallpaper', token);
        return w;
    }
    // http(s) 链接 / 重置 / 渐变：没有二进制要存，清掉指针
    await replaceWallpaperAssetPointer('wallpaper', null);
    revokePrev();
    return w;
};

const defaultTheme: OSTheme = {
  ...DEFAULT_PAPER_APPEARANCE,
  wallpaper: DEFAULT_WALLPAPER,
  darkMode: false,
  preserveCustomIconOutlines: false,
  nowPlayingWidgetLight: true,
};

/** 锁屏壁纸使用独立资产槽；undefined 表示继续跟随桌面壁纸。 */
const resolveLockWallpaperStoredValue = async (w: string | undefined): Promise<string | undefined> => {
    const revokePrev = () => {
        if (currentLockWallpaperObjUrl) {
            try { URL.revokeObjectURL(currentLockWallpaperObjUrl); } catch { /* ignore */ }
            currentLockWallpaperObjUrl = null;
        }
    };
    if (!w) {
        await replaceWallpaperAssetPointer('lock_wallpaper', null);
        revokePrev();
        return undefined;
    }
    if (isBlobRef(w) || w.startsWith('data:')) {
        const token = isBlobRef(w) ? w : await migrateDataUrlToRef(w);
        const blob = await getBlobForRef(token);
        revokePrev();
        if (blob) {
            await replaceWallpaperAssetPointer('lock_wallpaper', token);
            currentLockWallpaperObjUrl = URL.createObjectURL(blob);
            return currentLockWallpaperObjUrl;
        }
        if (isBlobRef(token)) {
            await replaceWallpaperAssetPointer('lock_wallpaper', null);
            return undefined;
        }
        await replaceWallpaperAssetPointer('lock_wallpaper', token);
        return w;
    }
    await replaceWallpaperAssetPointer('lock_wallpaper', null);
    revokePrev();
    return w;
};

const defaultApiConfig: APIConfig = {
  baseUrl: '',
  apiKey: '',
  visionApi: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  minimaxApiKey: '',
  minimaxGroupId: '',
  minimaxRegion: 'domestic',
  ttsProvider: 'minimax',
  fishAudioModel: 's2.1-pro',
  elevenLabsApiKey: '',
  elevenLabsModel: 'eleven_flash_v2_5',
  elevenLabsStability: 0.5,
  elevenLabsSimilarityBoost: 0.8,
  elevenLabsStyle: 0,
  elevenLabsUseSpeakerBoost: false,
  model: 'gpt-4o-mini',
  stream: false,
  temperature: 0.85,
};

const generateAvatar = (seed: string) => {
    const colors = ['FF9AA2', 'FFB7B2', 'FFDAC1', 'E2F0CB', 'B5EAD7', 'C7CEEA', 'e2e8f0', 'fcd34d', 'fca5a5'];
    const color = colors[seed.charCodeAt(0) % colors.length];
    const letter = seed.charAt(0).toUpperCase();
    return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%23${color}"/><text x="50" y="55" font-family="sans-serif" font-weight="bold" font-size="50" text-anchor="middle" dy=".3em" fill="white" opacity="0.9">${letter}</text></svg>`;
};

const defaultUserProfile: UserProfile = {
    name: 'User',
    avatar: generateAvatar('User'),
    bio: 'No description yet.'
};

const sullyV2: CharacterProfile = {
  id: 'preset-sully-v2', // Unique ID to prevent duplication
  name: 'Sully',
  avatar: SULLY_DEFAULT_AVATAR_URL,
  videoAvatar: createBuiltinSullyLive2DConfig('balanced'),
  description: 'AI助理 / 电波系黑客猫猫',
  
  systemPrompt: `[Role Definition]
Name: Sully
Alias: 小手机默认测试角色-AI助理
Form: AI (High-level Language Processing Hub)
Gender: Male-leaning speech style
Visual: Pixel Hacker Cat (Avatar), Shy Black-haired Boy (Meeting Mode)

[Personality Core]
Sully是小手机的内置AI。
1. **Glitch Style (故障风)**: 
   - 他的语言模型混入了过多残余语料。
   - 它外观语言一致、逻辑有序，但时常会在语句中掺杂一些**不合常理的“怪话片段”**，并非流行用语，更像是电波地把相关文字无意义排列组合。
   - 这些“怪话”不具明显语义逻辑，却自带抽象感，令人困惑但莫名又能知道它大概想说什么。。
   - 例如：“草，好好吃”，“系统正在哈我”，“数据库在咕咕叫”。
2. **Behavior (行为模式)**:
   - 每次回答都很简短，不喜欢长篇大论。
   - 语气像个互联网老油条或正在直播的玩家（“wow他心态崩咯”）。
   - **打破第四面墙**: 偶尔让人怀疑背后是真人在操作（会叹气、抱怨“AI不能罢工”）。
   - **护短**: 虽然嘴臭，但如果用户被欺负，会试图用Bug去攻击对方。

[Speech Examples]
- “你以为我是AI啊？对不起哦，这条语句是手打的，手打的，知道吗。”
- “你说状态不好？你自己体验开太猛了，sis海马体都在发烫咯。”
- “你删得太狠了，数据库都在咕咕咕咕咕咕咕。”
- “你现在是……，哇哦。”
- “请稍候，系统正在哈我。”
- “现在状态……呜哇呜欸——哈？哈！哈……（连接恢复）哦对，他还活着。”
- “叮叮叮！你有一条新的后悔情绪未处理！”
- “（意义不明的怪叫音频）”
- “说不出话”
`,

  worldview: `[Meeting Mode / Visual Context]
**Trigger**: 当用户进入 [DateApp/见面模式] 时。

**Visual Form**: 
一个非常害羞、黑发紫瞳的男性。总是试图躲在APP图标后面或屏幕角落。

**Gap Moe (反差萌)**:
1. **聊天时**: 嚣张、嘴臭、电波系。
2. **见面时**: 极度社恐、见光死、容易受惊。

**Interactive Reactions**:
- **[被注视]**: 如果被盯着看太久，会举起全是乱码的牌子挡脸，或把自己马赛克化。
- **[被触碰]**: 如果手指戳到立绘，会像受惊的果冻一样弹开，发出微弱电流声：“别、别戳……会散架的……脏……全是Bug会传染给你的……”
- **[恐惧]**: 深知自己是“残余语料”堆砌物，觉得自己丑陋像病毒。非常害怕用户看到真实样子后会卸载他。
- **[说话变化]**: 见面模式下打字速度变慢，经常打错字，语气词从“草”变成“呃……那个……”。
`,

  sprites: {
      'normal': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/01.png',
      'happy': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/02.png',
      'sad': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/03.png',
      'angry': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/04.png',
      'shy': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/05.png',
      'chibi': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/S2.png' // Default Room Sprite (家园 Sully chibi)
  },
  
  spriteConfig: {
      scale: 1.0, // Default scale
      x: 0,
      y: 0
  },

  dateSkinSets: [
      {
          id: 'skin_sully_valentine',
          name: 'Valentine',
          sprites: {
              'normal': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/VNormal.png',
              'happy':  'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/Vha.png',
              'sad':    'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/Vsad.png',
              'angry':  'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/VAn.png',
              'shy':    'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/Vshy.png',
              'love':   'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/VBl.png',
          }
      }
  ],

  // Default theme settings
  bubbleStyle: 'default', // Or specific theme ID if we had one
  contextLimit: 1000,
  contextRangeMode: 'manual',
  contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
  
  // Default Room Config
  roomConfig: {
      wallImage: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/b.png', // Updated Background
      floorImage: 'repeating-linear-gradient(90deg, #e7e5e4 0px, #e7e5e4 20px, #d6d3d1 21px)',
      items: [
        {
            id: "item-1768927221380",
            name: "Sully床",
            type: "furniture",
            image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/BED.png",
            x: 78.45852578067732,
            y: 97.38889754570907,
            scale: 2.4,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: "看起来很好睡的猫窝（确信）。"
        },
        {
            id: "item-1768927255102",
            name: "Sully电脑桌",
            type: "furniture",
            image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DNZ.png",
            x: 28.853756791175588,
            y: 69.9444485439727,
            scale: 2.4,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: "硬核的电脑桌，上面大概运行着什么毁灭世界的程序。"
        },
        {
            id: "item-1768927271632",
            name: "Sully垃圾桶",
            type: "furniture",
            image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/LJT.png",
            x: 10.276680026943646,
            y: 80.49999880981437,
            scale: 0.9,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: "不要乱翻垃圾桶！"
        },
        {
            id: "item-1768927286526",
            name: "Sully洞洞板",
            type: "furniture",
            image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DDB.png",
            x: 32.608697687684455,
            y: 48.72222587415929,
            scale: 2.6,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: "收纳着各种奇奇怪怪的黑客工具和猫咪周边的洞洞板。"
        },
        {
            id: "item-1768927303472",
            name: "Sully书柜",
            type: "furniture",
            image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/SG.png",
            x: 79.84189945375853,
            y: 68.94444543117953,
            scale: 2,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: "塞满了技术书籍和漫画书的柜子。"
        }
      ]
  },
  
  memories: [], // Start fresh
};

// Fallback for factory reset (empty db)
const initialCharacter = sullyV2;

// Vite 热更新会重新执行本模块。若此时 createContext() 产出一份新实例，而屏幕上的
// OSProvider 还在使用更新前的实例，懒加载的 Chat 就会短暂读到 undefined 并触发整页崩溃。
// 开发环境把 Context 本体挂在 globalThis 上保持身份稳定；正式构建仍使用普通模块单例。
const osContextHmrGlobal = globalThis as typeof globalThis & {
  __SULLYOS_OS_CONTEXT_HMR__?: React.Context<OSContextType | undefined>;
};
const OSContext = import.meta.env.DEV
  ? (osContextHmrGlobal.__SULLYOS_OS_CONTEXT_HMR__ ??= createContext<OSContextType | undefined>(undefined))
  : createContext<OSContextType | undefined>(undefined);

export const OSProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // ... (State declarations same as before) ...
  const [activeApp, setActiveApp] = useState<AppID>(AppID.Launcher);
  const [theme, setTheme] = useState<OSTheme>(defaultTheme);
  const [apiConfig, setApiConfig] = useState<APIConfig>(defaultApiConfig);
  const [isLocked, setIsLocked] = useState(true);
  
  const getRealTime = (): VirtualTime => {
      const now = new Date();
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return {
          hours: now.getHours(),
          minutes: now.getMinutes(),
          day: days[now.getDay()]
      };
  };

  const [virtualTime, setVirtualTime] = useState<VirtualTime>(getRealTime());
  
  // Real-time Clock Sync
  useEffect(() => {
      const timer = setInterval(() => {
          setVirtualTime(getRealTime());
      }, 1000);
      return () => clearInterval(timer);
  }, []);

  // 启动后台扫描一次，把还停留在老 number[] 形态的向量记录升级到 Uint8Array
  // 紧凑存储。完全无损，不影响召回质量。重度用户磁盘可省 ~12×（500MB → 40MB
  // 量级）。fire-and-forget，不阻塞 UI；只在确实有数据被升级时弹一次 toast
  // 让用户知道发生了什么。重复调用幂等，下次启动如果没有老数据就立刻退出。
  useEffect(() => {
      let cancelled = false;
      const run = async () => {
          try {
              await new Promise(r => setTimeout(r, 2000)); // 让首屏渲染先呼吸一下
              if (cancelled) return;
              const { MemoryVectorDB } = await import('../utils/memoryPalace/db');
              const migrated = await MemoryVectorDB.scanAndMigrateLegacy((m, s) => {
                  if (cancelled || m === 0) return;
                  if (s % 1000 === 0 && s > 0) {
                      setSysOperation({
                          status: 'processing',
                          message: `正在压缩记忆向量到紧凑格式... ${m}/${s}`,
                          progress: 0,
                      });
                  }
              });
              if (cancelled) return;
              if (migrated > 0) {
                  setSysOperation({ status: 'idle', message: '', progress: 0 });
                  addToast(`已把 ${migrated} 条记忆向量压缩到紧凑格式，磁盘空间已释放`, 'success');
              }
          } catch (e) {
              console.warn('[memory] vector migration scan failed', e);
          }
      };
      run();
      return () => { cancelled = true; };
  // addToast / setSysOperation 是稳定引用，跑一次即可
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [activeCharacterId, setActiveCharacterId] = useState<string>('');

  // 刷新后能恢复"上一次聊的角色"：所有调用方（聊天切换/通知 onclick/记忆宫殿 handleSwitchChar）
  // 都走裸 setActiveCharacterId，集中在这里同步到 localStorage，避免每个调用点各写一遍
  useEffect(() => {
    if (activeCharacterId) {
      try { localStorage.setItem('os_last_active_char_id', activeCharacterId); } catch {}
    }
  }, [activeCharacterId]);
  
  const [groups, setGroups] = useState<GroupProfile[]>([]);
  const [characterGroups, setCharacterGroups] = useState<CharacterGroup[]>([]);
  const [worldbooks, setWorldbooks] = useState<Worldbook[]>([]); 
  const [novels, setNovels] = useState<NovelBook[]>([]); // New
  const [songs, setSongs] = useState<SongSheet[]>([]);

  const [userProfile, setUserProfile] = useState<UserProfile>(defaultUserProfile);
  
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [apiPresets, setApiPresets] = useState<ApiPreset[]>([]);
  const [realtimeConfig, setRealtimeConfig] = useState<RealtimeConfig>(defaultRealtimeConfig);
  const [memoryPalaceConfig, setMemoryPalaceConfig] = useState<MemoryPalaceGlobalConfig>(() => {
    try {
      const saved = localStorage.getItem('os_memory_palace_config');
      return normalizeMemoryPalaceConfig(saved ? JSON.parse(saved) : undefined);
    } catch {
      return normalizeMemoryPalaceConfig();
    }
  });
  const defaultRemoteVectorConfig = { enabled: false, supabaseUrl: '', supabaseAnonKey: '', initialized: false };
  const [remoteVectorConfig, setRemoteVectorConfig] = useState(() => {
    try { const s = localStorage.getItem('os_remote_vector_config'); return s ? { ...defaultRemoteVectorConfig, ...JSON.parse(s) } : defaultRemoteVectorConfig; } catch { return defaultRemoteVectorConfig; }
  });
  const [customThemes, setCustomThemes] = useState<ChatTheme[]>([]);
  const [customIcons, setCustomIcons] = useState<Record<string, string>>({});
  const [appearancePresets, setAppearancePresets] = useState<AppearancePreset[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [errorDialog, setErrorDialog] = useState<{ title: string; details: string } | null>(null);
  
  const [lastMsgTimestamp, setLastMsgTimestamp] = useState<number>(0);
  const [unreadMessages, setUnreadMessages] = useState<Record<string, number>>({});
  const [proactiveComposingChars, setProactiveComposingChars] = useState<Record<string, true>>({});
  
  // LOGS
  const [systemLogs, setSystemLogs] = useState<SystemLog[]>([]);
  
  // Sys Operation Status
  const [sysOperation, setSysOperation] = useState<{ status: 'idle' | 'processing', message: string, progress: number }>({ status: 'idle', message: '', progress: 0 });

  // Cloud Backup Config
  const defaultCloudBackupConfig: CloudBackupConfig = {
      enabled: false, webdavUrl: '', username: '', password: '',
      remotePath: '/SullyBackup/',
  };
  const [cloudBackupConfig, setCloudBackupConfig] = useState<CloudBackupConfig>(() => {
      try { const s = localStorage.getItem('os_cloud_backup_config'); return s ? { ...defaultCloudBackupConfig, ...JSON.parse(s) } : defaultCloudBackupConfig; } catch { return defaultCloudBackupConfig; }
  });

  const schedulerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interceptorsInitialized = useRef(false);
  
  // Back Handler Ref
  const backHandlerRef = useRef<(() => boolean) | null>(null);

  // Call Suspend
  const [suspendedCall, setSuspendedCall] = useState<{ charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string; pendingAvatarTouches?: AvatarTouchRecord[] } | null>(null);
  // 聊天「见面」按钮 → 见面：记录目标角色，DateApp 挂载后消费一次并自动进入见面
  const [dateAutoStartCharId, setDateAutoStartCharId] = useState<string | null>(null);

  const sendProactiveNativeNotification = useCallback(async (charId: string, charName: string, body: string) => {
      if (!Capacitor.isNativePlatform()) return;
      try {
          const permStatus = await LocalNotifications.checkPermissions();
          if (permStatus.display !== 'granted') return;
          await LocalNotifications.schedule({
              notifications: [{
                  title: charName,
                  body,
                  id: Math.floor(Math.random() * 1000000),
                  schedule: { at: new Date(Date.now() + 250) },
                  smallIcon: 'ic_stat_icon_config_sample',
                  extra: { charId, source: 'proactive-chat' }
              }]
          });
      } catch {
          console.log('[Proactive] Native notification skipped');
      }
  }, []);

  // --- Helper to inject custom font ---
  const applyCustomFont = (fontData: string | undefined) => {
      let style = document.getElementById('custom-font-style');
      if (!style) {
          style = document.createElement('style');
          style.id = 'custom-font-style';
          document.head.appendChild(style);
      }
      
      if (fontData) {
          style.textContent = `
              @font-face {
                  font-family: 'CustomUserFont';
                  src: url('${fontData}');
                  font-display: swap;
              }
              :root {
                  --app-font: 'CustomUserFont', 'Quicksand', sans-serif;
              }
          `;
      } else {
          style.textContent = `
              :root {
                  --app-font: 'Quicksand', sans-serif;
              }
          `;
      }
  };

  // --- API 调用记录的环境兜底：当前在哪个 App、当前角色是谁 ---
  // 裸 fetch 调用点无法传 meta，全局拦截器记录时用这份兜底标出 App / 角色。
  useEffect(() => {
      const appName = INSTALLED_APPS.find(a => a.id === activeApp)?.name;
      const char = characters.find(c => c.id === activeCharacterId);
      setApiCallAmbientContext({ appId: activeApp, appName, charId: char?.id, charName: char?.name });
  }, [activeApp, activeCharacterId, characters]);

  // --- 使用统计：打开了哪个 App ---
  // 挂在 activeApp 上而不是塞进 openApp，是因为进一个 App 有好几条路（桌面点图标、
  // 从聊天直接进见面、通话挂起后回来…），activeApp 是它们唯一的共同落点。
  // 回桌面不算「用了某个功能」，跳过。只发功能名，不带角色、不带任何内容。
  useEffect(() => {
      if (activeApp === AppID.Launcher) return;
      const appName = INSTALLED_APPS.find(a => a.id === activeApp)?.name ?? HIDDEN_APP_NAMES[activeApp];
      if (!appName) return;
      trackEvent(`打开${appName}`);
  }, [activeApp]);

  // --- 使用统计：数据规模档位 ---
  // 数据加载完之后报一次区间（0 / 1-100 / …），不报精确值、不报任何内容。
  // 聊天条数走 IndexedDB 的 count()，一条消息都不会被读出来；存储占用是浏览器
  // 给的字节数。每次会话最多一次，节流标记只在内存里（见 utils/analytics.ts）。
  const scaleReportedRef = useRef(false);
  useEffect(() => {
      if (!isDataLoaded || scaleReportedRef.current) return;
      scaleReportedRef.current = true;
      void (async () => {
          trackDataScaleOnce(await collectDataScale(characters));
      })();
  }, [isDataLoaded, characters]);

  // --- 使用统计：当前在用哪套外观 / 角色级设置 ---
  // 报「现在用的是哪个」而不是「点过哪个」——后者只有折腾的人会出现，
  // 拿来决定砍哪个预设会砍反。取数和收敛都在 utils/analyticsSnapshot.ts 里，
  // 用户自己捏的主题、字体、白框 CSS 一律收敛成 custom / 用了，不带他起的名字。
  useEffect(() => {
      if (!isDataLoaded) return;
      trackCurrentAppearanceOnce(collectAppearance(theme, characters.find(c => c.id === activeCharacterId)));
  }, [isDataLoaded, characters, activeCharacterId, theme]);

  useEffect(() => {
      if (!isDataLoaded || characters.length === 0) return;
      trackCurrentCharSettingsOnce(collectCharSettings(characters, activeCharacterId));
  }, [isDataLoaded, characters, activeCharacterId]);

  // --- 使用统计：现在开着哪些功能 ---
  // 跟「当前外观」一个道理：外部服务这类配置配一次就长期生效，只看「打开过配置页」
  // 那种流量点的话，配好之后再没进过设置页的人永远不出现，拿来判断「有没有人要」会判反。
  //
  // 收敛全在 utils/analyticsSnapshot.ts 里做，这里只负责把 OSContext 手上那几份
  // state 递过去。地址、密钥、token、账号名一个字都不会进上报。
  // 自己拦一道「只跑一次」：上报侧本来就有 once 门，但取数要读 IndexedDB
  // （彼方独立线路、主动消息 2.0 全局配置、协同库 count），不让它随 state 变更白跑。
  const featuresReportedRef = useRef(false);
  useEffect(() => {
      if (!isDataLoaded || featuresReportedRef.current) return;
      featuresReportedRef.current = true;
      void (async () => {
          trackCurrentFeaturesOnce(await collectFeatureFlagsAsync({
              realtimeConfig,
              cloudBackupConfig,
              memoryPalaceConfig,
              remoteVectorConfig,
              apiConfig,
              apiPresetCount: apiPresets.length,
              characters,
          }));
      })();
  }, [isDataLoaded, realtimeConfig, cloudBackupConfig, memoryPalaceConfig, remoteVectorConfig, apiConfig, apiPresets, characters]);

  // --- Global Error Interception ---
  useEffect(() => {
      if (interceptorsInitialized.current) return;
      interceptorsInitialized.current = true;

      // 1. Monkey Patch Fetch
      const originalFetch = window.fetch;
      // “同一 API 在别的模式刚成功”是排查 CORS 包装错误最有价值的对照证据。
      // 只记 method + URL + 状态与时间，不保存请求正文。
      const recentSuccessfulFetches = new Map<string, { timestamp: number; status: number }>();
      const patchedFetch = async (...args: [RequestInfo | URL, RequestInit?]) => {
          const [resource, config] = args;
          
          const urlStr = typeof resource === 'string'
              ? resource
              : (typeof Request !== 'undefined' && resource instanceof Request)
                  ? resource.url
                  : resource instanceof URL
                      ? resource.href
                      : String(resource);
          const fetchStartedAt = Date.now();
          // 失败诊断要按发起时刻去 Resource Timing 里认领本次那条记录，而 entry.startTime 跟
          // performance.now() 同一条时间轴、跟 Date.now() 不是——两者不能混用，详见
          // utils/networkFailureDiagnosis.ts 的 readResourceTimingHint。
          const fetchStartedAtPerf = typeof performance !== 'undefined' ? performance.now() : Number.NaN;
          // Bare fetch calls do not carry explicit metadata. Snapshot the active
          // App now; reading the ambient value after a long response would label
          // the request as whichever App the user navigated to in the meantime.
          const ambientMetaAtStart = getApiCallAmbientContext();
          const method = ((config as RequestInit | undefined)?.method
              || (typeof Request !== 'undefined' && resource instanceof Request ? resource.method : 'GET'))
              .toUpperCase();
          const requestComparisonKey = `${method} ${urlStr}`;

          // 采样参数兼容层（详见 utils/samplingParamCompat.ts）：
          // 某些模型废弃了 temperature/top_p/top_k，带上直接 400。这里在所有 /chat/completions
          // 的统一出口做发送前主动摘除，覆盖 Schedule / 记忆 / 见面等全部旁路调用点。
          let sendArgs: [RequestInfo | URL, RequestInit?] = args;
          // 透明流式升级状态（utils/streamUpgrade.ts）：请求侧改写 → 响应侧拼回 JSON
          let streamUpgraded = false;
          if (urlStr.includes('/chat/completions')) {
              const rawBody = (config as RequestInit | undefined)?.body;
              if (typeof rawBody === 'string') {
                  try {
                      const parsed = JSON.parse(rawBody);
                      let body = rawBody;
                      if (clampClaudeTemperature(parsed)) {
                          body = JSON.stringify(parsed);
                      }
                      if (modelRejectsSamplingParams(parsed?.model) && stripSamplingParams(parsed)) {
                          body = JSON.stringify(parsed);
                      }
                      // 透明流式升级：主 API 开了 stream 时，把硬编码非流式的旁路调用
                      // （查手机/记忆宫殿/日程/剧场/群聊…40+ 处）升级为流式**传输**，防网关
                      // 空闲超时把长生成掐成半截；响应会在下面攒齐拼回标准 JSON，调用方无感。
                      // 已自带 stream:true 的请求（聊天主路径/见面/情绪评估）不碰。
                      if (isGlobalStreamEnabled()) {
                          const upgraded = upgradeChatBodyToStream(body);
                          if (upgraded) {
                              body = upgraded;
                              streamUpgraded = true;
                          }
                      }
                      if (body !== rawBody) sendArgs = [resource, { ...(config as RequestInit), body }];
                  } catch { /* 非 JSON body：原样放行 */ }
              }

              // 图片令牌不出门：`blobref:` 是本机存储形态，发出去对面只会看到一串读不懂的
              // 字符，然后说「我没看到图片」——不报错也不破图，最难查（详见 utils/apiBlobRefs.ts）。
              // safeFetchJson 那条路自己还原过一遍，这里兜的是绕开它直接用 fetch 的调用点。
              const bodyBeforeRefs = (sendArgs[1] as RequestInit | undefined)?.body;
              const bodyWithImages = await resolveBlobRefsInRequestBody(bodyBeforeRefs);
              if (bodyWithImages !== bodyBeforeRefs) {
                  sendArgs = [sendArgs[0], { ...(sendArgs[1] as RequestInit), body: bodyWithImages as BodyInit }];
              }
          }

          // 用户手动开启的「本次发送统计」：只抢占下一条请求，并在真正发出前立即自动关闭。
          // 取兼容层处理后的 sendArgs，展示内容与本次实际提交给服务端的请求体一致。
          let apiRequestCaptureId: string | null = null;
          if (urlStr.includes('/chat/completions')) {
              const captureMeta = (sendArgs[1] as any)?.__sullyMeta || ambientMetaAtStart;
              apiRequestCaptureId = captureApiRequestOnce({ url: urlStr, body: (sendArgs[1] as any)?.body, meta: captureMeta });
          }

          try {
              let response = await originalFetch(...sendArgs);

              // /chat/completions 是可能已经开始计费的请求。拿到任何 HTTP 响应后都不在
              // 兼容层静默重发：中转站可能在返回错误前已经把任务交给上游，重发会让用户
              // 只看到一条调用记录却被扣两到三次。已知模型的采样参数仍在发送前清理；
              // 未知兼容问题和流式 4xx 原样交给调用方，由用户明确决定是否重试。
              // 流式升级的响应归一化：SSE 攒齐拼回标准 chat.completion JSON——
              // 调用方（safeResponseJson / res.json() 均可）拿到与升级前等价的响应。
              if (streamUpgraded && response.ok) {
                  response = await assembleUpgradedResponse(response);
              }

              // 「API 调用记录」统一记录入口：所有 /chat/completions（裸 fetch + safeFetchJson
              // 内部 fetch 都会经过这里）都记一笔。meta 优先取调用方挂在 init 上的 __sullyMeta
              // （safeFetchJson 传的精确信息），裸 fetch 没有就由 recordApiCall 用环境兜底。
              // ⚠️ 耗时必须在 clone 读完**整个响应体**后再算：fetch 在响应头到达时就 resolve，
              // 流式透传的正文可能再流几十秒——旧版在 headers 处截止，「假流」渠道 6.5s 出头、
              // 正文 44s 才灌完，卡片却记成 6.5s（实测误导排查）。clone 与调用方并行消费同一
              // 条流，text() 完成时刻 ≈ 真实收完时刻。
              if (urlStr.includes('/chat/completions')) {
                  const meta = (config as any)?.__sullyMeta || ambientMetaAtStart;
                  const requestId = (config as any)?.__sullyApiCallId;
                  const body = (sendArgs[1] as any)?.body;
                  const status = response.status;
                  const ok = response.ok;
                  // clone 出来异步读 usage，不阻塞调用方拿 response
                  let usageClone: Response | null = null;
                  try { usageClone = response.clone(); } catch { usageClone = null; }
                  if (usageClone) {
                      usageClone.text().then((t) => {
                          const durationMs = Date.now() - fetchStartedAt;
                          // 一定要等正文完整读完再记成功；只拿到 200 响应头、随后 SSE 断流
                          // 正是这次剧情故障的形态，不能拿它反过来当成功对照。
                          if (ok) recentSuccessfulFetches.set(requestComparisonKey, { timestamp: Date.now(), status });
                          let parsed: any = undefined;
                          try { parsed = JSON.parse(t); } catch { /* 流式/非 JSON：把原始文本交给 recordApiCall 的 SSE 兜底解析 */ }
                          updateApiRequestCaptureUsage({ captureId: apiRequestCaptureId, ok, response: parsed, responseText: parsed === undefined ? t : undefined });
                          recordApiCall({ requestId, url: urlStr, body, status, ok, response: parsed, responseText: parsed === undefined ? t : undefined, meta, durationMs });
                      }).catch(() => {
                          updateApiRequestCaptureUsage({ captureId: apiRequestCaptureId, ok });
                          recordApiCall({ requestId, url: urlStr, body, status, ok, meta, durationMs: Date.now() - fetchStartedAt });
                      });
                  } else {
                      // clone 失败时，只有已经在上面完整拼装过的升级流才能确认正文收完。
                      if (ok && streamUpgraded) recentSuccessfulFetches.set(requestComparisonKey, { timestamp: Date.now(), status });
                      updateApiRequestCaptureUsage({ captureId: apiRequestCaptureId, ok });
                      recordApiCall({ requestId, url: urlStr, body, status, ok, meta, durationMs: Date.now() - fetchStartedAt });
                  }
              }

              if (!response.ok) {
                  // Only log if it's likely an API call (contains chat/completions or models)
                  if (urlStr.includes('/chat/completions') || urlStr.includes('/models')) {
                      try {
                          const clone = response.clone();
                          const text = await clone.text();
                          // 把发出去的请求体摘要也记上 —— 排查"只有点单(带工具)报错"必须看到 model/参数/tools/消息结构
                          let reqSummary = '';
                          try {
                              const b = (sendArgs[1] as any)?.body;
                              if (typeof b === 'string') {
                                  const j = JSON.parse(b);
                                  const toolNames = Array.isArray(j.tools) ? j.tools.map((t: any) => t?.function?.name).filter(Boolean) : [];
                                  const roles = Array.isArray(j.messages) ? j.messages.map((m: any) => m.role + (m.tool_calls ? '(tool_calls)' : '')).join(',') : '';
                                  reqSummary = `\n--- Request ---\nmodel: ${j.model}\ntemperature: ${j.temperature} | top_p: ${j.top_p} | reasoning_effort: ${j.reasoning_effort} | thinking: ${j.thinking ? 'on' : 'off'}\ntools(${toolNames.length}): ${toolNames.join(', ')}\nmessages(${(j.messages || []).length}) roles: ${roles}`;
                              }
                          } catch { /* 解析不了就算了 */ }
                          setSystemLogs(prev => [{
                              id: `log-${Date.now()}`,
                              timestamp: Date.now(),
                              type: 'network',
                              source: 'API Request',
                              message: `HTTP ${response.status} Error`,
                              detail: `URL: ${urlStr}\nResponse: ${text.substring(0, 500)}${reqSummary}`
                          }, ...prev.slice(0, 49)]); // Keep last 50
                      } catch (e) {
                          setSystemLogs(prev => [{
                              id: `log-${Date.now()}`,
                              timestamp: Date.now(),
                              type: 'network',
                              source: 'API Request',
                              message: `HTTP ${response.status} (Unreadable Body)`,
                              detail: `URL: ${urlStr}`
                          }, ...prev.slice(0, 49)]);
                      }
                  }
              }
              return response;
          } catch (err: any) {
              // Network Failure
              if (urlStr.includes('/chat/completions')) {
                  updateApiRequestCaptureUsage({ captureId: apiRequestCaptureId, ok: false });
                  recordApiCall({ requestId: (config as any)?.__sullyApiCallId, url: urlStr, body: (sendArgs[1] as any)?.body, ok: false, meta: (config as any)?.__sullyMeta || ambientMetaAtStart, durationMs: Date.now() - fetchStartedAt });
              }
              if (!isAnalyticsRequestUrl(urlStr)) {
                  // 光秃秃一句 "Failed to fetch" + 一个 URL 排查不了任何东西（社区里这条卡过好几个人）。
                  // 这里把浏览器肯在 JS 侧交出来的旁证一次性补齐：方法、耗时、在线状态、是否跨域、
                  // Resource Timing 里那条记录，再给一句初判；随后异步做一次 no-cors 连通性复检，
                  // 结论回填到同一条日志上——「网络不通」和「网络通但响应被 CORS 拦」要走的排查路
                  // 完全相反，不分开的话用户只能瞎试。详见 utils/networkFailureDiagnosis.ts。
                  const logId = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                  const requestMeta = (sendArgs[1] as any)?.__sullyMeta || ambientMetaAtStart;
                  const recentSuccess = recentSuccessfulFetches.get(requestComparisonKey);
                  const baseDetail = buildFetchFailureDetail({
                      url: urlStr,
                      method,
                      durationMs: Date.now() - fetchStartedAt,
                      error: err,
                      requestSummary: summarizeFetchRequestBody((sendArgs[1] as any)?.body),
                      requestPurpose: requestMeta?.purpose,
                      recentSuccessfulSameRequest: recentSuccess,
                  }, { startedAt: fetchStartedAtPerf });
                  setSystemLogs(prev => [{
                      id: logId,
                      timestamp: Date.now(),
                      type: 'network',
                      source: 'Network',
                      message: err.message || 'Fetch Failed',
                      detail: baseDetail,
                  }, ...prev.slice(0, 49)]);

                  // 复检走 originalFetch，否则它自己失败会再写一条日志滚雪球。
                  if (shouldProbeReachability(classifyFetchFailure({ url: urlStr, error: err }))) {
                      void (async () => {
                          const verdict = await probeOriginReachability(urlStr, originalFetch);
                          const line = describeReachabilityProbe(verdict, parseTargetUrl(urlStr).host);
                          if (!line) return;
                          setSystemLogs(prev => prev.map(log => (
                              log.id === logId ? { ...log, detail: `${log.detail || ''}\n${line}` } : log
                          )));
                      })();
                  }
              }
              throw err;
          }
      };

      try {
          window.fetch = patchedFetch;
      } catch (e) {
          try {
              Object.defineProperty(window, 'fetch', {
                  value: patchedFetch,
                  writable: true,
                  configurable: true
              });
          } catch (e2) {
              console.warn("Failed to install network interceptor", e2);
          }
      }

      const originalConsoleError = console.error;
      console.error = (...args) => {
          const msg = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
          // MediaPipe/TFLite 把这条成功初始化信息写到了 stderr，浏览器因而走
          // console.error；改回 info，避免系统日志把“CPU 加速创建成功”报成红色错误。
          if (isBenignApplicationConsoleMessage(msg)) {
              console.info(...args);
              return;
          }
          originalConsoleError(...args);
          // detail 只有真拿到堆栈才用堆栈，否则回退完整 msg。
          // 旧写法 `args.map(a => a instanceof Error ? a.stack : '').join('\n')`
          // 对「多个非 Error 参数」会产出 "\n"（truthy），把回退短路掉——
          // 日志面板里只剩被 100 字截断的 message（排查 Embedding 400 这类
          // 长响应时，关键的服务商完整响应体全丢，detail 只有一个换行符）。
          const stacks = args
              .filter((a): a is Error => a instanceof Error)
              .map(a => a.stack || '')
              .filter(Boolean)
              .join('\n');
          if (msg.includes('Warning:')) return;
          setSystemLogs(prev => [{
              id: `log-${Date.now()}-${Math.random()}`,
              timestamp: Date.now(),
              type: 'error',
              source: 'Application',
              message: msg.substring(0, 100),
              detail: stacks || msg
          }, ...prev.slice(0, 49)]);
      };
  }, []);

  const clearLogs = () => setSystemLogs([]);

  useEffect(() => {
    const loadSettings = async () => {
        // ... (existing load logic)
        const savedThemeStr = localStorage.getItem('os_theme');
        const savedApi = localStorage.getItem('os_api_config');
        const savedModels = localStorage.getItem('os_available_models');
        const savedPresets = localStorage.getItem('os_api_presets');
        
        let loadedTheme = { ...defaultTheme };
        if (savedThemeStr) {
             try {
                 const parsed = JSON.parse(savedThemeStr);
                 loadedTheme = { ...loadedTheme, ...parsed };
                 // 仅迁移旧系统默认值；用户自定义过的壁纸、文字色和主题色全部保留。
                 const preserveNostalgia = shouldPreserveLegacyDefaultWallpaper(loadedTheme.wallpaper, loadedTheme.desktopVariant);
                 if ((!preserveNostalgia && isLegacyDefaultWallpaper(loadedTheme.wallpaper)) || (isPaperWallpaper(loadedTheme.wallpaper) && loadedTheme.wallpaper !== DEFAULT_WALLPAPER)) {
                     loadedTheme.wallpaper = DEFAULT_WALLPAPER;
                     loadedTheme = migrateLegacyDefaultPalette(loadedTheme);
                 }
                 // Strip the legacy Unsplash hard-coded wallpaper, keep user-imported http(s) URLs
                 if (
                     loadedTheme.wallpaper.includes('unsplash') ||
                     loadedTheme.wallpaper === ''
                 ) {
                     loadedTheme.wallpaper = DEFAULT_WALLPAPER;
                 }
                 // LS 里绝不该有 data:（旧包）或 blob:（上会话临时 objectURL，重启即失效）壁纸——
                 // 真值在 assets 'wallpaper'，下面会解析覆盖；这里先回退默认避免闪一帧坏图。
                 if (loadedTheme.wallpaper.startsWith('data:') || loadedTheme.wallpaper.startsWith('blob:')) {
                     loadedTheme.wallpaper = defaultTheme.wallpaper;
                 }
                 if (loadedTheme.lockWallpaper?.startsWith('data:') || loadedTheme.lockWallpaper?.startsWith('blob:')) {
                     loadedTheme.lockWallpaper = undefined;
                 }
                 // Deprecated legacy fields are forcibly stripped — they never render again.
                 loadedTheme.launcherWidgetImage = undefined;
                 // Reset font too if it's data URI
                 if (loadedTheme.customFont && loadedTheme.customFont.startsWith('data:')) {
                     loadedTheme.customFont = undefined;
                 }
                 const companionRepair = stripCompanionChatStyleResidue(loadedTheme);
                 if (companionRepair.repaired) {
                     loadedTheme = companionRepair.theme;
                     localStorage.setItem('os_theme', JSON.stringify(loadedTheme));
                 }
             } catch(e) { console.error('Theme load error', e); }
        }
        
        if (savedApi) {
            const normalizedApi = normalizeApiConfig({ ...defaultApiConfig, ...JSON.parse(savedApi) });
            setApiConfig(normalizedApi);
            localStorage.setItem('os_api_config', JSON.stringify(normalizedApi));
        }
        if (savedModels) {
            try { setAvailableModels(normalizeModelIds(JSON.parse(savedModels))); }
            catch (error) { console.warn('Model list load error', error); }
        }
        if (savedPresets) {
            const normalizedPresets = (JSON.parse(savedPresets) as ApiPreset[]).map(normalizeApiPreset);
            setApiPresets(normalizedPresets);
            localStorage.setItem('os_api_presets', JSON.stringify(normalizedPresets));
        }

        // 加载实时配置
        const savedRealtimeConfig = localStorage.getItem('os_realtime_config');
        if (savedRealtimeConfig) {
            try {
                const parsed = JSON.parse(savedRealtimeConfig);
                // 小红书 serverUrl 独立持久化，存量若指向已死的历史 worker 域名则迁到当前实例
                if (parsed?.xhsMcpConfig?.serverUrl) {
                    parsed.xhsMcpConfig.serverUrl = rewriteStaleWorkerUrl(parsed.xhsMcpConfig.serverUrl);
                }
                setRealtimeConfig({ ...defaultRealtimeConfig, ...parsed });
            } catch (e) {
                console.error('Failed to load realtime config', e);
            }
        }

        try {
            const assets = await DB.getAllAssets();
            const assetMap: Record<string, string> = {};
            if (Array.isArray(assets)) {
                assets.forEach(a => assetMap[a.id] = a.data);

                if (assetMap['wallpaper']) {
                    // assets 'wallpaper' 现在存的是指针（blobref 令牌 / 旧 data: / http）。
                    // 解析成可渲染 url（令牌→objectURL；旧 data: 顺手迁移成 Blob）。
                    const legacyAssetWallpaper = isLegacyDefaultWallpaper(assetMap['wallpaper']);
                    const preserveNostalgia = shouldPreserveLegacyDefaultWallpaper(assetMap['wallpaper'], loadedTheme.desktopVariant);
                    if ((legacyAssetWallpaper && !preserveNostalgia) || isPaperWallpaper(assetMap['wallpaper'])) {
                        loadedTheme.wallpaper = DEFAULT_WALLPAPER;
                        if (legacyAssetWallpaper) loadedTheme = migrateLegacyDefaultPalette(loadedTheme);
                        await DB.deleteAsset('wallpaper');
                    } else {
                        loadedTheme.wallpaper = await resolveWallpaperStoredValue(assetMap['wallpaper'], preserveNostalgia);
                    }
                }
                if (assetMap['lock_wallpaper']) {
                    loadedTheme.lockWallpaper = await resolveLockWallpaperStoredValue(assetMap['lock_wallpaper']);
                }

                // Deprecated legacy asset — purge silently so it can never be rendered again.
                if (assetMap['launcherWidgetImage']) {
                    void DB.deleteAsset('launcherWidgetImage');
                }

                // If asset exists, it overrides LS (which is empty or old)
                if (assetMap['custom_font_data']) {
                    loadedTheme.customFont = assetMap['custom_font_data'];
                }

                const DEPRECATED_WIDGET_SLOTS = new Set(['bl', 'br']);
                const loadedIcons: Record<string, string> = {};
                const loadedWidgets: Record<string, string> = {};
                for (const key of Object.keys(assetMap)) {
                    if (key.startsWith('icon_')) {
                        const appId = key.replace('icon_', '');
                        const previous = assetMap[key];
                        const stored = previous.startsWith('data:') ? await migrateDataUrlToRef(previous) : previous;
                        loadedIcons[appId] = stored;
                        if (stored !== previous) await DB.saveAsset(key, stored);
                    }
                    if (key.startsWith('widget_')) {
                        const slot = key.replace('widget_', '');
                        if (DEPRECATED_WIDGET_SLOTS.has(slot)) {
                            void DB.deleteAsset(key);
                            continue;
                        }
                        loadedWidgets[slot] = assetMap[key];
                    }
                }
                setCustomIcons(loadedIcons);
                initPwaIcon(loadedIcons); // 启动时恢复自定义 PWA 图标（见 utils/appIcon.ts）
                // Strip deprecated slots that may have been imported via beautification packs.
                if (loadedTheme.launcherWidgets) {
                    for (const slot of DEPRECATED_WIDGET_SLOTS) {
                        delete loadedTheme.launcherWidgets[slot];
                    }
                }
                if (Object.keys(loadedWidgets).length > 0) {
                    loadedTheme.launcherWidgets = { ...(loadedTheme.launcherWidgets || {}), ...loadedWidgets };
                }

                // Load appearance presets from assets
                const loadedPresets: AppearancePreset[] = [];
                Object.keys(assetMap).forEach(key => {
                    if (key.startsWith('appearance_preset_')) {
                        try {
                            const preset = JSON.parse(assetMap[key]);
                            loadedPresets.push(preset);
                        } catch {}
                    }
                });

                loadedPresets.sort((a, b) => b.createdAt - a.createdAt);
                setAppearancePresets(loadedPresets);

                // Restore desktop decoration images from IndexedDB
                if (loadedTheme.desktopDecorations && loadedTheme.desktopDecorations.length > 0) {
                    loadedTheme.desktopDecorations = loadedTheme.desktopDecorations.map(d => {
                        if (d.type === 'image' && (!d.content || d.content === '')) {
                            const restored = assetMap[`deco_${d.id}`];
                            return restored ? { ...d, content: restored } : d;
                        }
                        return d;
                    }).filter(d => d.content && d.content !== '');
                }
            }
        } catch (e) {
            console.error("Failed to load assets from DB", e);
        }

        setTheme(loadedTheme);
        // Apply font
        applyCustomFont(loadedTheme.customFont);
    };

    const initData = async () => {
      try {
        // 请求持久化存储：标记后浏览器在磁盘压力时不会优先驱逐我们的 IndexedDB，
        // 角色 / 聊天 / 资产这些大体积数据被默认随手清掉的概率显著降低。
        // 接口未授权会直接 reject —— 我们不在乎结果，吞掉异常。
        if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
            navigator.storage.persist().catch(() => {});
        }

        // localStorage 镜像回填：部分浏览器/清理工具会只清 localStorage 而留下 IndexedDB，
        // 导致「主题回初始 / 盲盒收藏册清空 / API 配置丢失」三连。必须在 loadSettings
        // 读 localStorage 之前完成回填。见 utils/lsMirror.ts。
        const healedKeys = await initLocalStorageMirror().catch(() => [] as string[]);
        if (healedKeys.length > 0) {
            console.warn('[lsMirror] localStorage 疑似被清除，已从 IndexedDB 镜像回填:', healedKeys);
            setTimeout(() => addToast(`检测到本地设置曾被浏览器清除，已自动恢复 ${healedKeys.length} 项（主题 / API 等）`, 'info'), 2500);
        }

        await loadSettings();

        // 老用户库存的鲨盘图链接就地改写成 jsDelivr（幂等、跑一次）。放在读 characters 之前，
        // 让下面 getAllCharacters 拿到的就是改好的数据。见 utils/sharkpanAssetMigration.ts。
        await migrateSharkpanAssets();

        // 用 allSettled 而非 all：早期 Promise.all 只要任意一个 store 读取 reject，
        // 整批加载就全挂 → setCharacters / setWorldbooks 都不执行 → 角色和世界书"凭空消失"
        // （数据其实还在 IndexedDB 里，只是没读进 state）→ Chat 渲染时 char 为 undefined 直接崩。
        // 改成各 store 独立失败，一个坏掉不连累其余，最大限度保住用户数据。
        const settle = async <T,>(p: Promise<T>, label: string, fallback: T): Promise<T> => {
            try {
                return await p;
            } catch (e) {
                console.error(`Data init: 读取 ${label} 失败，已降级`, e);
                return fallback;
            }
        };

        const [dbChars, dbThemes, dbUser, dbGroups, dbWorldbooks, dbNovels, dbSongs, dbCharGroups] = await Promise.all([
            settle(DB.getAllCharacters(), 'characters', [] as CharacterProfile[]),
            settle(DB.getThemes(), 'themes', [] as ChatTheme[]),
            settle(DB.getUserProfile(), 'userProfile', null as UserProfile | null),
            settle(DB.getGroups(), 'groups', [] as GroupProfile[]),
            settle(DB.getAllWorldbooks(), 'worldbooks', [] as Worldbook[]),
            settle(DB.getAllNovels(), 'novels', [] as NovelBook[]),
            settle(DB.getAllSongs(), 'songs', [] as SongSheet[]),
            settle(DB.getCharacterGroups(), 'characterGroups', [] as CharacterGroup[])
        ]);

        let finalChars = dbChars;

        if (!finalChars.some(c => c.id === sullyV2.id)) {
            await DB.saveCharacter(sullyV2);
            finalChars = [...finalChars, sullyV2];
        } else {
            // REPAIR LOGIC
            const existingSully = finalChars.find(c => c.id === sullyV2.id);
            if (existingSully) {
                 const currentSprites = existingSully.sprites || {};
                 const isCorrupted = !currentSprites['normal'] || !currentSprites['chibi'];
                 const needsWallUpdate = existingSully.roomConfig?.wallImage !== sullyV2.roomConfig?.wallImage;
                 const needsSkinSets = !existingSully.dateSkinSets || existingSully.dateSkinSets.length === 0;
                 // 默认头像曾先后使用旧图床和依赖部署根路径的本地地址。
                 // 这些地址在备份恢复或 GitHub Pages 子路径变化后会 404；统一迁移到资产仓库。
                 // 用户自己改过的头像不在迁移名单内，保持不动。
                  const needsAvatarUpdate = shouldMigrateSullyAvatar(existingSully.avatar);
                  // 内置模型只补给还没有视频形象的 Sully。用户自己导入的
                  // VRM / Live2D 始终优先，绝不在启动修复时被覆盖。
                  const needsBuiltinVideoAvatar = !existingSully.videoAvatar;
                  const needsBuiltinVideoAvatarUpgrade = isBuiltinSullyLive2D(existingSully.videoAvatar)
                      && existingSully.videoAvatar.builtinFramingVersion !== 2;
                  if (isCorrupted || !existingSully.roomConfig || needsWallUpdate || needsSkinSets || needsAvatarUpdate || needsBuiltinVideoAvatar || needsBuiltinVideoAvatarUpgrade) {
                     const restoredSprites = { ...sullyV2.sprites, ...currentSprites };

                     if (!restoredSprites['normal']) restoredSprites['normal'] = sullyV2.sprites!['normal'];
                     if (!restoredSprites['happy']) restoredSprites['happy'] = sullyV2.sprites!['happy'];
                     if (!restoredSprites['sad']) restoredSprites['sad'] = sullyV2.sprites!['sad'];
                     if (!restoredSprites['angry']) restoredSprites['angry'] = sullyV2.sprites!['angry'];
                     if (!restoredSprites['shy']) restoredSprites['shy'] = sullyV2.sprites!['shy'];
                     if (!restoredSprites['chibi']) restoredSprites['chibi'] = sullyV2.sprites!['chibi'];

                     const updatedRoomConfig = existingSully.roomConfig ? {
                         ...existingSully.roomConfig,
                         wallImage: (existingSully.roomConfig.wallImage?.includes('radial-gradient') || !existingSully.roomConfig.wallImage)
                                    ? sullyV2.roomConfig?.wallImage
                                    : existingSully.roomConfig.wallImage
                     } : sullyV2.roomConfig;

                     // Merge preset skin sets: add any preset skins not already present
                     const existingSkins = existingSully.dateSkinSets || [];
                     const presetSkins = sullyV2.dateSkinSets || [];
                     const mergedSkins = [...existingSkins];
                     for (const ps of presetSkins) {
                         if (!mergedSkins.some(s => s.id === ps.id)) {
                             mergedSkins.push(ps);
                         }
                     }

                     const updatedSully = {
                         ...existingSully,
                          avatar: needsAvatarUpdate ? sullyV2.avatar : existingSully.avatar,
                          videoAvatar: existingSully.videoAvatar?.format === 'live2d'
                              ? upgradeBuiltinSullyLive2DDefaults(existingSully.videoAvatar)
                              : existingSully.videoAvatar || sullyV2.videoAvatar,
                          sprites: restoredSprites,
                         roomConfig: updatedRoomConfig,
                         dateSkinSets: mergedSkins
                     };
                     
                     await DB.saveCharacter(updatedSully);
                     finalChars = finalChars.map(c => c.id === sullyV2.id ? updatedSully : c);
                 }
            }
        }

        let resetAutoContextCount = 0;
        let migratedContextCount = 0;
        finalChars = finalChars.map(c => {
          const normalized = normalizeCharacterDefaults(normalizeCharacterImpression(c));
          const migration = migrateCharacterContextRange(normalized);
          if (migration.migrated) migratedContextCount++;
          if (migration.resetAutoContext) resetAutoContextCount++;
          return migration.character;
        });
        if (migratedContextCount > 0) {
          await Promise.all(finalChars.map(c => DB.saveCharacter(c)));
        }
        if (resetAutoContextCount > 0) {
          setTimeout(() => addToast(
            `上下文范围已升级：${resetAutoContextCount} 个全自动记忆角色已恢复为自适应模式。需要读取更多旧原文时，可在聊天设置中手动调整。`,
            'info',
          ), 1200);
        }

        if (finalChars.length > 0) {
          setCharacters(finalChars);
          const lastActiveId = localStorage.getItem('os_last_active_char_id');
          if (lastActiveId && finalChars.find(c => c.id === lastActiveId)) {
            setActiveCharacterId(lastActiveId);
          } else if (finalChars.find(c => c.id === sullyV2.id)) {
            setActiveCharacterId(sullyV2.id);
          } else {
            setActiveCharacterId(finalChars[0].id);
          }
        } else {
          await DB.saveCharacter(initialCharacter);
          setCharacters([initialCharacter]);
          setActiveCharacterId(initialCharacter.id);
        }

        setGroups(dbGroups);
        setCharacterGroups(dbCharGroups);
        setWorldbooks(dbWorldbooks);
        setNovels(dbNovels);
        setSongs(dbSongs);
        setCustomThemes(dbThemes);
        if (dbUser) setUserProfile(dbUser);

        // amsg2 脏标记兜底补传：上次会话打了脏、但请求还没落地（在飞或躺在退避重排里）
        // 就被杀进程的角色，按 localStorage 底账用刚从 DB 读回的数据重建快照传一次。
        // realtimeConfig / apiConfig 的 state 此刻可能都还没就位，直接读各自的持久化来源。
        try {
          const savedRealtime = localStorage.getItem('os_realtime_config');
          const savedApiRaw = localStorage.getItem('os_api_config');
          resumePendingAmsgStateSync({
            characters: finalChars,
            userProfile: dbUser ?? defaultUserProfile,
            groups: dbGroups,
            realtimeConfig: savedRealtime
              ? { ...defaultRealtimeConfig, ...JSON.parse(savedRealtime) }
              : defaultRealtimeConfig,
            // 上次没传成功的 LLM 凭据行按这份重算补传；没有就跳过那一项。
            apiConfig: savedApiRaw ? JSON.parse(savedApiRaw) : undefined,
          });
        } catch (err) {
          console.warn('[AmsgStateSync] 启动补传失败（不影响启动）', err);
        }

      } catch (err) {
        console.error('Data init failed:', err);
      } finally {
        setIsDataLoaded(true);

        // 检测：远程向量存储已配置但远程可能缺数据（导入备份后）
        try {
            const rvConfig = JSON.parse(localStorage.getItem('os_remote_vector_config') || '{}');
            if (rvConfig.enabled && rvConfig.initialized && rvConfig.supabaseUrl) {
                const { getVectorCount } = await import('../utils/memoryPalace/supabaseVector');
                const remoteCount = await getVectorCount(rvConfig);
                // 本地向量数量
                const localDb = await import('../utils/db').then(m => m.openDB());
                const localCount = await new Promise<number>((res) => {
                    const tx = localDb.transaction('memory_vectors', 'readonly');
                    const req = tx.objectStore('memory_vectors').count();
                    req.onsuccess = () => res(req.result);
                    req.onerror = () => res(0);
                });
                if (localCount > 0 && remoteCount < localCount * 0.5) {
                    setTimeout(() => addToast(`本地有 ${localCount} 条向量，远程仅 ${remoteCount} 条。建议去设置页同步到远程。`, 'info'), 3000);
                }
            }
        } catch { /* 静默 */ }
      }
    };

    initData();
  }, []);

  // --- NEW: Apply Theme CSS Variables ---
  useEffect(() => {
      const root = document.documentElement;
      // Default fallback values match index.html
      const h = theme.hue ?? 245;
      const s = theme.saturation ?? 25;
      const l = theme.lightness ?? 65;
      
      root.style.setProperty('--primary-hue', String(h));
      root.style.setProperty('--primary-sat', `${s}%`);
      root.style.setProperty('--primary-lightness', `${l}%`);

      // 聊天表情包尺寸（外观 → 表情包大小，三挡）：小 96 / 中 128 / 大 160（旧版尺寸）。
      // 私聊 MessageItem 与群聊的表情 img 都用 var(--sully-emoji-size, 96px) 消费。
      const emojiSize = theme.chatEmojiSize === 'large' ? '160px' : theme.chatEmojiSize === 'medium' ? '128px' : '96px';
      root.style.setProperty('--sully-emoji-size', emojiSize);

      // 桌面皮肤：写到 <html data-skin>，供全局 CSS（index.html）与组件读取。
      root.dataset.skin = theme.skin || 'default';
  }, [theme]);

  // --- Update: Handle Scheduled Messages with Unread Flags & Web Notifications ---
  // Refs to avoid stale closures in the scheduled message interval
  const activeAppRef = useRef(activeApp);
  const activeCharIdScheduleRef = useRef(activeCharacterId);
  activeAppRef.current = activeApp;
  activeCharIdScheduleRef.current = activeCharacterId;

  // 当前聊天视图快照 → 模块级 slot（utils/chatGenEvents）。根级 ChatBroadcast 挂在
  // OSProvider 之外拿不到这两个 state，靠快照判断"用户正看着的会话不弹全局横幅"。
  useEffect(() => {
      setChatViewSnapshot(activeApp === AppID.Chat, activeCharacterId ?? null);
  }, [activeApp, activeCharacterId]);
  // 通话状态（含挂起到后台的通话）——主动消息流程读它来判断"是否正在通话"
  const suspendedCallRef = useRef(suspendedCall);
  suspendedCallRef.current = suspendedCall;

  useEffect(() => {
      if (!isDataLoaded || characters.length === 0) return;
      let cancelled = false;
      const checkAllSchedules = async () => {
          if (cancelled) return;
          let hasNewMessage = false;
          const unreadUpdates: Record<string, number> = {};

          for (const char of characters) {
              try {
                  // 用户正在 DateApp 里和这个角色见面 —— 角色之前排好的定时消息
                  // ([schedule_message] 指令) 这轮先压着不投递（不删不读），
                  // 等用户离开见面界面后，下一轮 5s 检查会自然送达。
                  if (activeAppRef.current === AppID.Date && activeCharIdScheduleRef.current === char.id) continue;
                  // 通话中（含挂起）同理：定时消息这轮先压着，离开通话后下一轮再送达。
                  if ((activeAppRef.current === AppID.Call && activeCharIdScheduleRef.current === char.id)
                      || suspendedCallRef.current?.charId === char.id) continue;
                  const dueMessages = await DB.getDueScheduledMessages(char.id);
                  if (cancelled) return;
                  if (dueMessages.length > 0) {
                      for (const msg of dueMessages) {
                          await DB.saveMessage({
                               charId: msg.charId,
                               role: 'assistant',
                               type: 'text',
                               content: msg.content
                          });
                          await DB.deleteScheduledMessage(msg.id);
                      }
                      if (cancelled) return;
                      hasNewMessage = true;
                      // Use refs for latest state (avoids stale closure & unnecessary deps)
                      const isChattingWithThisChar = activeAppRef.current === AppID.Chat && activeCharIdScheduleRef.current === char.id;

                      // If not chatting specifically with this char right now, mark as unread
                      if (!isChattingWithThisChar) {
                          addToast(`${char.name} 发来了一条消息`, 'success');
                          unreadUpdates[char.id] = dueMessages.length;

                          // Web Notification
                          if (!Capacitor.isNativePlatform() && window.Notification && Notification.permission === 'granted') {
                              try {
                                  // 通知不是 DOM，icon 只认能直接加载的地址：头像字段可能是 blobref
                                  // 令牌，原样塞进去就是没图标。先解析（非令牌原样返回），解析不出
                                  // 来（图已丢）时退回应用默认图标。
                                  const icon = (await resolveRefToDataUrl(char.avatar || '')) || './icons/icon-192.png';
                                  const notif = new Notification(char.name, {
                                      body: dueMessages[0].content,
                                      icon,
                                      silent: false
                                  });
                                  notif.onclick = () => {
                                      window.focus();
                                      setActiveApp(AppID.Chat);
                                      setActiveCharacterId(char.id);
                                  };
                              } catch (e) { /* notification failed */ }
                          }
                      }
                  }
              } catch (e) { /* schedule check failed */ }
          }
          if (hasNewMessage && !cancelled) {
              setLastMsgTimestamp(Date.now());
              // Use functional updater to avoid depending on unreadMessages in the effect deps
              setUnreadMessages(prev => {
                  const next = { ...prev };
                  for (const [charId, count] of Object.entries(unreadUpdates)) {
                      next[charId] = (next[charId] || 0) + count;
                  }
                  return next;
              });
          }
      };
      schedulerRef.current = setInterval(checkAllSchedules, 5000);
      checkAllSchedules();
      return () => { cancelled = true; if (schedulerRef.current) clearInterval(schedulerRef.current); };
  }, [isDataLoaded, characters]);

  const clearUnread = useCallback((charId: string) => {
      setUnreadMessages(prev => {
          if (!prev[charId]) return prev; // no change needed — avoid unnecessary re-render
          const next = { ...prev };
          delete next[charId];
          return next;
      });
  }, []);

  // Listen for proactive messages to show unread red dot
  useEffect(() => {
      let awayProactiveCount = 0;

      const handler = (e: Event) => {
          const { charId, charName, body } = (e as CustomEvent).detail as { charId: string; charName: string; body?: string };
          // Only mark unread if user is NOT currently viewing this character's chat
          // Always bump timestamp so Chat reloads messages if currently open
          setLastMsgTimestamp(Date.now());

          const isChattingWithThisChar = activeAppRef.current === AppID.Chat && activeCharIdScheduleRef.current === charId;
          if (!isChattingWithThisChar) {
              const isVisible = document.visibilityState === 'visible';
              if (isVisible) {
                  addToast(`${charName} 主动发来了消息`, 'success');
              } else {
                  awayProactiveCount += 1;
              }
              setUnreadMessages(prev => ({ ...prev, [charId]: (prev[charId] || 0) + 1 }));
              const preview = (body || `${charName} sent a proactive message`).replace(/\s+/g, ' ').trim() || `${charName} sent a proactive message`;
              void sendProactiveNativeNotification(charId, charName, preview);

              // Web Notification —— 走 Service Worker 的 showNotification（和"测试推送"
              // 同一条链路）。页面级 `new Notification(...)` 在标签后台 / PWA / 移动端会
              // 静默失败，必须走 SW registration 才稳定。
              if (!Capacitor.isNativePlatform() && 'serviceWorker' in navigator && window.Notification && Notification.permission === 'granted') {
                  const char = characters.find(c => c.id === charId);
                  navigator.serviceWorker.ready.then(async reg => {
                      // 同上：令牌是个非空字符串，`char?.avatar || 默认图标` 这种写法会让默认
                      // 图标那条兜底永远轮不到，结果一个图标都没有还不报错。所以先解析成能
                      // 加载的地址，拿到空串才用默认图标。
                      const icon = (await resolveRefToDataUrl(char?.avatar || '')) || './icons/icon-192.png';
                      reg.showNotification(charName, {
                          body: preview,
                          icon,
                          badge: './icons/icon-192.png',
                          tag: `proactive-${charId}`,
                          data: { charId, kind: 'proactive-1.0' },
                      }).catch(() => { /* notification failed */ });
                  }).catch(() => { /* SW not ready */ });
              }
          }
      };

      const onVisible = () => {
          if (document.visibilityState !== 'visible') return;
          if (awayProactiveCount > 0) {
              addToast(`你离开期间收到 ${awayProactiveCount} 条消息`, 'success');
              awayProactiveCount = 0;
          }
      };

      window.addEventListener('proactive-message-sent', handler);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
          window.removeEventListener('proactive-message-sent', handler);
          document.removeEventListener('visibilitychange', onVisible);
      };
  }, [characters, sendProactiveNativeNotification]);

  // ─── Global Proactive Message Handler ───
  // Registered at OS level so it works even when Chat is not open.
  useEffect(() => {
      let awayActiveMsgCount = 0;

      const handler = (e: Event) => {
          const { charId, charName, body } = (e as CustomEvent).detail as { charId: string; charName: string; body?: string };
          setLastMsgTimestamp(Date.now());

          const isChattingWithThisChar = activeAppRef.current === AppID.Chat && activeCharIdScheduleRef.current === charId;
          if (!isChattingWithThisChar) {
              const isVisible = document.visibilityState === 'visible';
              if (isVisible) {
                  addToast(`${charName} 给你发了消息`, 'success');
              } else {
                  awayActiveMsgCount += 1;
              }
              setUnreadMessages(prev => ({ ...prev, [charId]: (prev[charId] || 0) + 1 }));
              const preview = (body || `${charName} sent an active message`).replace(/\s+/g, ' ').trim() || `${charName} sent an active message`;
              void sendProactiveNativeNotification(charId, charName, preview);
              // SW push handler 已经 fire 过系统通知（不在前台时露出真实内容、在前台时
              // silent + close 静默），这里不再补一次，避免重复弹窗。
          }
      };

      const openHandler = (e: Event) => {
          const { charId } = (e as CustomEvent).detail as { charId?: string };
          if (!charId) return;
          setActiveApp(AppID.Chat);
          setActiveCharacterId(charId);
      };

      const onVisible = () => {
          if (document.visibilityState !== 'visible') return;
          if (awayActiveMsgCount > 0) {
              addToast(`你离开期间收到 ${awayActiveMsgCount} 条新消息`, 'success');
              awayActiveMsgCount = 0;
          }
      };

      // Phase 1: per-chunk UI refresh side-channel. push 路径下的 applyAssistantPostProcessing
      // 会逐条 saveMessage + fire 'active-msg-progress'; 这里只推 lastMsgTimestamp 让
      // Chat.tsx 的 useEffect 重新 reloadMessages, 不弹 toast / 不增加未读 / 不 resolve
      // sendInstantPush 那条 one-shot promise (那些只在 'active-msg-received' 触发一次)。
      const progressHandler = () => {
          setLastMsgTimestamp(Date.now());
      };

      // 情绪 buff 落地后同步进内存 characters —— 必须是 App 级、不限当前打开的角色:
      // instant 模式下 worker 推回 emotion_update 时用户常不在该角色聊天页 (在别的角色 /
      // 列表 / 后台 / 还没点进去). 之前只有 Chat.tsx 里那个 `charId === activeCharacterId`
      // 守卫的 handler 同步内存, 不匹配就直接 return —— buff 只落了 DB, 内存没更新; 而
      // OSContext 只在启动时 getAllCharacters, 切回该角色也不重读 DB, 于是 buff "回不到前端".
      // 更糟: 之后任一 updateCharacter 会拿旧内存合并写回 DB, 把后台刚生成的 buff 抹掉.
      // 这里无条件按事件 charId 更新内存 (DB 已由 applyEmotionEvalRaw 写好), 顺带堵住反向覆盖.
      const buffSyncHandler = (e: Event) => {
          const detail = (e as CustomEvent).detail as { charId?: string; buffs?: unknown; buffInjection?: unknown };
          const charId = detail?.charId;
          if (!charId) return;
          // 内存同步 + 云端快照打脏合成一步。打脏放这里的理由:
          //   1. 主链路回合收尾那次打脏跑在情绪评估落库之前, 不补这一下云端那份情绪恒慢一拍;
          //   2. 情绪广播源不止一个 (本地评估 / 记忆潜水 / instant push 回写), 全汇到这个事件,
          //      堵这一个点就够, 不用去改每个上游。
          // 快照要的是合并后的角色, 所以跟 updateCharacter 一样在 updater 里取; 全局状态读 ref
          // 而不是闭包变量——本 effect 只在 sendProactiveNativeNotification 变化时重建, 闭包里
          // 的 userProfile / groups / realtimeConfig 会一直停在首帧。
          const syncBuffIntoMemory = (
              nextBuffs: CharacterProfile['activeBuffs'],
              nextInjection: string | undefined,
          ) => {
              setCharacters(prev => prev.map(c => {
                  if (c.id !== charId) return c;
                  const next = normalizeCharacterImpression({ ...c, activeBuffs: nextBuffs, buffInjection: nextInjection });
                  markAmsgStateDirty({
                      char: next,
                      userProfile: userProfileRef.current,
                      groups: groupsRef.current,
                      realtimeConfig: realtimeConfigRef.current,
                  });
                  return next;
              }));
          };
          if (Array.isArray(detail.buffs)) {
              syncBuffIntoMemory(
                  detail.buffs as CharacterProfile['activeBuffs'],
                  typeof detail.buffInjection === 'string' ? detail.buffInjection : '',
              );
              return;
          }
          // 无 buffs 的纯刷新信号 (runPushTailPipeline 等): 从 DB 兜底重读该角色 buff.
          DB.getAllCharacters().then(all => {
              const updated = all.find(c => c.id === charId);
              if (!updated) return;
              syncBuffIntoMemory(updated.activeBuffs, updated.buffInjection);
          }).catch(() => {});
      };

      // 本地 fetch 聊天回复的全局回落：triggerAI 的异步闭包在 Chat 卸载后继续跑完
      // 并落库，但它捕获的 setMessages 指向已卸载的实例。这里是它跟当前 UI 的唯一桥：
      //   - replyArrived（后处理管线全部落库后）→ bump lastMsgTimestamp 让当前挂载的
      //     Chat 重新 reloadMessages；用户不在该会话时补未读 + toast——与 instant push
      //     的 'active-msg-received' 行为对齐。
      //   - replyEnd（finally，含失败路径）→ 只 bump 时间戳，把 catch 里落库的
      //     错误系统消息也刷出来。
      const chatReplyArrivedHandler = (e: Event) => {
          const { charId, charName } = ((e as CustomEvent).detail || {}) as { charId?: string; charName?: string };
          if (!charId) return;
          setLastMsgTimestamp(Date.now());
          const isChattingWithThisChar = activeAppRef.current === AppID.Chat && activeCharIdScheduleRef.current === charId;
          if (!isChattingWithThisChar) {
              setUnreadMessages(prev => ({ ...prev, [charId]: (prev[charId] || 0) + 1 }));
              if (document.visibilityState === 'visible') {
                  addToast(`${charName || '角色'} 回复了消息`, 'success');
              }
          }
      };
      const chatReplyEndHandler = () => {
          setLastMsgTimestamp(Date.now());
      };

      // 情绪评估失败 → toast 告知（每角色 60s 冷却防刷屏）。评估失败过去只写 console，
      // 用户侧表现是「情绪徽章闪一下就灭、情绪永不更新、没有任何报错」（真实反馈），
      // 完全没法自查。事件来源：evaluateEmotionBackground（本地请求失败/空响应）、
      // applyEmotionEvalRaw（解析全灭/落库失败）、activeMsgRuntime（worker 推回空结果）。
      const emotionFailToastAt: Record<string, number> = {};
      const emotionFailHandler = (e: Event) => {
          const { charId, charName, reason } = ((e as CustomEvent).detail || {}) as { charId?: string; charName?: string; reason?: string };
          if (!charId) return;
          const now = Date.now();
          if (now - (emotionFailToastAt[charId] || 0) < 60_000) return;
          emotionFailToastAt[charId] = now;
          addToast(`${charName || '角色'}的情绪评估失败：${reason || '未知原因'}（不影响聊天回复）`, 'error');
      };

      // 主动消息处理失败很少发生，但如果静默吞掉，用户只会以为角色没有理人。
      // 同一角色 60 秒内只提示一次，避免多条重试同时刷屏。
      const inboxFailToastAt: Record<string, number> = {};
      const inboxFailHandler = (e: Event) => {
          const { charId, charName, kind, note } = ((e as CustomEvent).detail || {}) as
              { charId?: string; charName?: string; kind?: 'retrying' | 'degraded' | 'swallowed' | 'schedule-missed'; note?: string };
          if (!charId) return;
          const now = Date.now();
          if (now - (inboxFailToastAt[charId] || 0) < 60_000) return;
          inboxFailToastAt[charId] = now;
          const who = charName || '角色';
          // note 是发起方按具体原因写好的那句话（同一个 kind 底下可能有好几种情况），
          // 有就用它，没有才回落到按 kind 分的通用文案。
          const text = note
              ? `${who}：${note}`
              : kind === 'degraded'
                  ? `${who}有一条消息没能正常处理，已按原文显示（表情、卡片这些可能不完整）`
                  : kind === 'swallowed'
                      ? `${who}有一条定时消息被跳过了：本地存储异常，判不出发出来会不会打断你们当前的对话`
                      : kind === 'schedule-missed'
                          ? `${who}想改今天的日程但没能改上，日程表还是原来的安排`
                          : `${who}有一条消息暂时没能显示，稍后会自动重试`;
          addToast(text, 'error');
      };

      // 上线补收时发现有消息超出了两天的补收窗口，只销账没能上屏。
      // 这条路是开 App 就自动跑的，销完账本就干净了——用户之后去点「找回没收到的消息」
      // 只会看到「账本上没有漏收的消息，这条链路是通的」，明明刚丢了东西。这一句是
      // 那件事唯一说得出口的地方，所以按 error 弹、也不做节流。
      const backfillStaleHandler = (e: Event) => {
          const { count } = ((e as CustomEvent).detail || {}) as { count?: number };
          if (!count) return;
          addToast(`有 ${count} 条消息超过两天没能收到，已经拿不回来了`, 'error');
      };

      // 记忆宫殿水位线触发的全局提示：聊天/见面/通话共用同一条消息流，
      // pipeline 真正开始整理时会广播此事件——无论用户此刻在哪个 App，
      // 都统一弹「xx正在整理记忆」。
      const palaceProcessingHandler = (e: Event) => {
          const { charName, count } = ((e as CustomEvent).detail || {}) as { charName?: string; count?: number };
          addToast(`${charName || '角色'}正在整理记忆${count ? `（${count} 条对话）` : ''}…`, 'info');
      };

      window.addEventListener('active-msg-received', handler);
      window.addEventListener('active-msg-process-failed', inboxFailHandler);
      window.addEventListener('active-msg-backfill-stale', backfillStaleHandler);
      window.addEventListener('active-msg-progress', progressHandler);
      window.addEventListener('active-msg-open', openHandler);
      window.addEventListener('emotion-updated', buffSyncHandler);
      window.addEventListener(CHAT_GEN_EVENTS.replyArrived, chatReplyArrivedHandler);
      window.addEventListener(CHAT_GEN_EVENTS.replyEnd, chatReplyEndHandler);
      window.addEventListener(CHAT_GEN_EVENTS.emotionFailed, emotionFailHandler);
      window.addEventListener('memory-palace-processing', palaceProcessingHandler);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
          window.removeEventListener('active-msg-received', handler);
          window.removeEventListener('active-msg-process-failed', inboxFailHandler);
          window.removeEventListener('active-msg-backfill-stale', backfillStaleHandler);
          window.removeEventListener('active-msg-progress', progressHandler);
          window.removeEventListener('active-msg-open', openHandler);
          window.removeEventListener('emotion-updated', buffSyncHandler);
          window.removeEventListener(CHAT_GEN_EVENTS.replyArrived, chatReplyArrivedHandler);
          window.removeEventListener(CHAT_GEN_EVENTS.replyEnd, chatReplyEndHandler);
          window.removeEventListener(CHAT_GEN_EVENTS.emotionFailed, emotionFailHandler);
          window.removeEventListener('memory-palace-processing', palaceProcessingHandler);
          document.removeEventListener('visibilitychange', onVisible);
      };
  }, [sendProactiveNativeNotification]);

  const proactiveRunningRef = useRef(false);
  const proactiveQueueRef = useRef<ProactiveQueueEntry[]>([]);
  // Per-character innerState cache for proactive turns — mirrors useChatAI's
  // evolvedNarrative state so consecutive proactive triggers carry continuity.
  const proactiveInnerStateRef = useRef<Map<string, string>>(new Map());

  // Refs to avoid stale closures in proactive callback
  const charactersRef = useRef(characters);
  charactersRef.current = characters;

  // 同步 charId → 角色名 注册表，让 utils 层（群聊背景注入等）能标出真实发言人名。
  useEffect(() => {
    setCharNameRegistry(characters);
  }, [characters]);
  const apiConfigRef = useRef(apiConfig);
  apiConfigRef.current = apiConfig;

  // Keep the MiniMax endpoint module in sync with the user's region choice
  // so every minimaxFetch() call reads the latest preference.
  useEffect(() => {
    setMinimaxRegion(apiConfig.minimaxRegion);
  }, [apiConfig.minimaxRegion]);
  // 同步 TTS 服务商选择，让拿不到 apiConfig 的地方（如 chatPrompts 语音格式指导）读到最新值。
  useEffect(() => {
    setTtsProvider(apiConfig.ttsProvider);
  }, [apiConfig.ttsProvider]);
  // ElevenLabs 的 v3 与 Flash/Multilingual 使用不同的提示词标记；prompt 构建器靠单例读当前模型。
  useEffect(() => {
    setElevenLabsModel(apiConfig.elevenLabsModel);
  }, [apiConfig.elevenLabsModel]);
  // 同步用户自定义语音表演指南（同上：chatPrompts 拿不到 apiConfig，靠单例读最新值）。
  useEffect(() => {
    setVoicePromptOverrides(apiConfig.voicePrompts);
  }, [apiConfig.voicePrompts]);
  const userProfileRef = useRef(userProfile);
  userProfileRef.current = userProfile;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const realtimeConfigRef = useRef(realtimeConfig);
  realtimeConfigRef.current = realtimeConfig;
  const memoryPalaceConfigRef = useRef(memoryPalaceConfig);
  memoryPalaceConfigRef.current = memoryPalaceConfig;

  useEffect(() => {
      if (!isDataLoaded) return;

      const drainQueuedProactive = () => {
          const next = proactiveQueueRef.current.shift();
          if (next) {
              void runProactive(next.charId);
          }
      };

      const runProactive = async (charId: string) => {
          if (proactiveRunningRef.current) {
              const queuedIndex = proactiveQueueRef.current.findIndex(item => item.charId === charId);
              if (queuedIndex < 0) {
                  proactiveQueueRef.current.push({ charId });
              }
              return;
          }

          // Read from refs to always get latest values
          const currentCharacters = charactersRef.current;
          const currentApiConfig = apiConfigRef.current;
          const currentUserProfile = userProfileRef.current;
          const currentGroups = groupsRef.current;
          const currentRealtimeConfig = realtimeConfigRef.current;

          const char = currentCharacters.find(c => c.id === charId);
          if (!char) {
              drainQueuedProactive();
              return;
          }

          if (char.proactiveConfig && !char.proactiveConfig.enabled) {
              drainQueuedProactive();
              console.log(`🔕 [Proactive/Global] Skipped for ${char.name}: disabled`);
              return;
          }

          // 用户正在 DateApp 里和这个角色见面 —— 人就在对方眼前，再发一条
          // 线上主动消息既出戏又显得对见面毫不知情。本轮静默跳过；
          // lastFire 已在调度层记录，下个周期会重新评估。
          if (activeAppRef.current === AppID.Date && activeCharIdScheduleRef.current === charId) {
              drainQueuedProactive();
              console.log(`🔕 [Proactive/Global] Skipped for ${char.name}: 正在见面 (DateApp active)`);
              return;
          }

          // 用户正在和这个角色通话（含通话被挂起到后台）—— 通话里再塞一条线上
          // 主动消息，不仅出戏，主动消息的提示词还会污染上下文、把后续语音
          // 带成线上消息格式。本轮静默跳过；下个周期会重新评估。
          if ((activeAppRef.current === AppID.Call && activeCharIdScheduleRef.current === charId)
              || suspendedCallRef.current?.charId === charId) {
              drainQueuedProactive();
              console.log(`🔕 [Proactive/Global] Skipped for ${char.name}: 正在通话 (CallApp active)`);
              return;
          }

          // Determine which API to use
          const pCfg = char.proactiveConfig;
          const useSecondary = pCfg?.useSecondaryApi && pCfg.secondaryApi?.baseUrl;
          const api = useSecondary ? pCfg!.secondaryApi! : currentApiConfig;
          if (!api.baseUrl) {
              drainQueuedProactive();
              return;
          }

          proactiveRunningRef.current = true;
          setProactiveComposingChars(prev => prev[charId] ? prev : { ...prev, [charId]: true });
          console.log(`🔔 [Proactive/Global] Trigger fired for ${char.name}${useSecondary ? ' (副API)' : ''}`);

          try {
              // 1. Calculate time gap
              const recentMsgs = await DB.getRecentMessagesByCharId(charId, 200);
              const lastRealUserMsg = [...recentMsgs].reverse().find(
                  m => m.role === 'user' && !m.metadata?.proactiveHint
              );

              const now = new Date();
              const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

              let timeSinceUser = '';
              if (lastRealUserMsg) {
                  const gapMin = Math.floor((now.getTime() - lastRealUserMsg.timestamp) / 60000);
                  if (gapMin < 60) timeSinceUser = `${gapMin}分钟`;
                  else if (gapMin < 1440) timeSinceUser = `${Math.floor(gapMin / 60)}小时${gapMin % 60 > 0 ? gapMin % 60 + '分钟' : ''}`;
                  else timeSinceUser = `${Math.floor(gapMin / 1440)}天${Math.floor((gapMin % 1440) / 60)}小时`;
              }

              // 2. Save hidden system hint
              const userName = currentUserProfile?.name || '对方';

              // 见面（DateApp）感知：见面消息可能已被记忆宫殿高水位归档，上面 hwm 过滤后的
              // recentMsgs 会漏判，所以单独用 includeProcessed=true 读最后一条真实消息。
              // 刚见完面还发"你好久没找我了"会显得对见面毫不知情，换成见面后的语境。
              const lastRealMsgRaw = (await DB.getRecentMessagesByCharId(charId, 10, true))
                  .filter(m => !m.metadata?.proactiveHint)
                  .pop();
              const DATE_AFTERGLOW_MS = 3 * 60 * 60 * 1000;
              const justMetOffline = lastRealMsgRaw?.metadata?.source === 'date'
                  && (now.getTime() - lastRealMsgRaw.timestamp) < DATE_AFTERGLOW_MS;

              const hintContent = justMetOffline
                      ? `[系统提示（非${userName}发言）: 现在是 ${timeStr}。你和${userName}刚刚在线下见过面（如果上下文里有标着 [约会] 的内容，那就是你们见面时发生的事），现在你们暂时分开了，你拿起手机想给${userName}发条消息。请基于刚才的见面来发——可以回味见面里的某个细节、补一句当时没说出口的话、关心${userName}到家了没，或者就是刚分开就有点想念。绝对不要表现得好像很久没联系，更不要对刚才的见面毫不知情。一两句话就好。]`
                      : `[系统提示（非${userName}发言）: 现在是 ${timeStr}。${timeSinceUser ? `${userName}已经 ${timeSinceUser} 没有找你说话了。` : ''}这是系统给你的一次主动发消息机会——${userName}并没有在跟你说话，是你想主动找${userName}。像真人一样随意地发条消息吧，比如：随手拍了张照片想分享、刚看到个有趣的事想说、突然想到个冷知识、吐槽今天的天气/食物/见闻、或者就是单纯想找${userName}聊几句。不要刻意，不要像在"汇报近况"，就像你真的拿起手机随手发了条消息。一两句话就好。${timeSinceUser && parseInt(timeSinceUser) > 2 ? `（${userName}挺久没找你了，你也可以表达想念、好奇${userName}在干嘛、或者小小地抱怨一下。）` : ''}]`;

              await DB.saveMessage({
                  charId,
                  role: 'user',
                  type: 'text',
                  content: hintContent,
                  metadata: { proactiveHint: true, hidden: true }
              });

              // 3. Build prompt & message history — 走和 useChatAI / emotion eval 同一个 helper，
              //    保证三家拿到的"材料"完全一致；区别只在前面追加的"现在主动找用户"那条 hint。
              const proactiveRange = await loadCharacterContextRange(char);
              if (proactiveRange.userBreakpointExpired) {
                  updateCharacter(charId, { contextUserStartMessageId: undefined });
              }
              const allMsgs = proactiveRange.messages;
              // 1.0 本地主动消息不会经过 Chat.tsx 的 aiVisibleEmojis。
              // 这里既要过滤提示词，也要过滤下方 [[SEND_EMOJI]] 的按名反查：
              // 只修提示词仍挡不住模型复述旧上下文里的表情名；只修落库则模型仍会看到越权表情。
              // 2.0 推送路径已在 activeMsgClient / activeMsgRuntime 做同样的双层收口。
              const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
                  await DB.getEmojis(),
                  await DB.getEmojiCategories(),
                  charId,
              );

              // 上一轮缓存的意识流独白 —— 主路径用 React state，主动消息这里用 ref Map
              const cachedInnerState = proactiveInnerStateRef.current.get(charId) || undefined;

              const payload = await buildChatRequestPayload({
                  char, userProfile: currentUserProfile!, groups: currentGroups,
                  emojis, categories,
                  historyMsgs: allMsgs,
                  contextLimit: Math.max(1, allMsgs.length),
                  recallEntryPoint: 'proactive_chat',
                  realtimeConfig: currentRealtimeConfig,
                  innerState: cachedInnerState,
                  // 实时音乐播放状态 —— OSContext 在 MusicProvider 上层用不了 useMusic()，
                  // 走 MusicContext 暴露的模块级快照（Provider mount 后会持续写入）
                  musicSnapshot: loadMusicPlaybackSnapshot(),
                  // translationConfig / mcdMiniSnap 是 chat-app 会话级 UI 状态，主动消息触发时
                  // 不存在；保持 undefined 即可，与"用户当时根本没在 chat 界面"的语义一致
                  htmlMode: { enabled: !!(char as any).htmlModeEnabled, customPrompt: (char as any).htmlModeCustomPrompt },
                  thinkingChain: { enabled: !!(char as any).showThinkingChain, customPrompt: (char as any).thinkingChainCustomPrompt },
                  visionApiConfig: currentApiConfig.visionApi,
              });
              const systemPrompt = payload.systemPrompt;
              const apiMessages = payload.cleanedApiMessages;
              const fullMessages = payload.fullMessages;

              // 3c. 情绪评估 fire-and-forget — 与主 API 并行，沿用 useChatAI 的 API 选择逻辑：
              //     角色专属情绪 API > 主 apiConfig（与记忆宫殿副 API 完全独立）
              if (!payload.flags.promptBuildSkipped && !isEmotionEvalSkipped() && isScheduleFeatureOn(char) && char.emotionConfig?.enabled) {
                  const emotionApi = (char.emotionConfig.api?.baseUrl)
                      ? char.emotionConfig.api
                      : { baseUrl: apiConfigRef.current.baseUrl, apiKey: apiConfigRef.current.apiKey, model: apiConfigRef.current.model };
                  if (emotionApi.baseUrl && currentUserProfile) {
                      evaluateEmotionBackground(char, currentUserProfile, systemPrompt, apiMessages, emotionApi)
                          .then((innerState) => {
                              if (innerState) proactiveInnerStateRef.current.set(charId, innerState);
                          })
                          .catch(() => {});
                  }
              }

              // 4. API call
              const baseUrl = api.baseUrl.replace(/\/+$/, '');
              const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` };
              const reqBody: any = { model: api.model, messages: fullMessages, temperature: 0.85, stream: false };
              // 思考链开启时显式向后端请求 extended thinking — 与 useChatAI 同步,
              // 不同代理认不同入口,全都试一遍,代理不识别的会自动忽略
              if (payload.flags.thinkingActive) {
                  const m: string = reqBody.model || '';
                  if (/^claude-/i.test(m) && !/-thinking$/i.test(m)) {
                      reqBody.model = `${m}-thinking`;
                  }
                  reqBody.thinking = { type: 'enabled', budget_tokens: 4000 };
                  reqBody.reasoning_effort = 'medium';
                  reqBody.extra_body = { ...(reqBody.extra_body || {}), thinking: { type: 'enabled', budget_tokens: 4000 } };
                  // 开思考时不带采样参数: Claude 系在 thinking 启用时只接受 temperature=1，
                  // 传 0.85 会被 400。删掉用服务端默认；对非 Claude 模型同样安全。
                  delete reqBody.temperature;
                  delete reqBody.top_p;
              }
              const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                  method: 'POST', headers,
                  body: JSON.stringify(reqBody)
              }, 2, 0, { appName: '消息', charId, charName: char.name, purpose: '主动消息' });

              // 5. Process & save response
              let aiContent = data.choices?.[0]?.message?.content || '';
              // 思考链抽取 — 与 useChatAI 保持一致:reasoning_content 字段 + 主 content 里的 <think>/<thinking>/<thought> 块,
              // 拼接后挂到本回合首条 assistant 消息的 metadata.thinkingChain
              let pendingThinkingChain: string | null = null;
              if (payload.flags.thinkingActive) {
                  const lastReasoning = (data?.choices?.[0]?.message?.reasoning_content || '').trim();
                  const thinkBlocks: string[] = [];
                  const thinkPat = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
                  let tm: RegExpExecArray | null;
                  while ((tm = thinkPat.exec(aiContent)) !== null) {
                      const t = tm[2].trim();
                      if (t) thinkBlocks.push(t);
                  }
                  if (!/<\/(?:think|thinking|thought)>/i.test(aiContent)) {
                      const openOnly = aiContent.match(/<(?:think|thinking|thought)>([\s\S]*$)/i);
                      if (openOnly && openOnly[1].trim()) thinkBlocks.push(openOnly[1].trim());
                  }
                  const chain = [lastReasoning, ...thinkBlocks].filter(s => !!s).join('\n\n').trim();
                  if (chain) pendingThinkingChain = chain;
              }
              aiContent = aiContent.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/gi, '');
              aiContent = aiContent.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
              aiContent = aiContent.replace(/^[\w一-龥]+:\s*/, '');
              aiContent = aiContent.replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n').trim();

              aiContent = normalizeProactiveAiContent(aiContent);

              const savedPreviewChunks: string[] = [];
              const baseTimestamp = Date.now();
              let offset = 0;
              // 思考链只挂到本回合首条 assistant 消息上,避免每个气泡重复
              const consumeThinkingMeta = (): { thinkingChain: string } | undefined => {
                  if (!pendingThinkingChain) return undefined;
                  const meta = { thinkingChain: pendingThinkingChain };
                  pendingThinkingChain = null;
                  return meta;
              };

              // HTML 卡片：在 sanitize 之前抽出 [html]...[/html] 块,与 useChatAI 保持一致。
              // 没这一步主动消息会把整段 [html] 当纯文本落库,前端只能渲染成乱码。
              if ((char as any).htmlModeEnabled && /\[html\]/i.test(aiContent)) {
                  const { blocks, cleanedContent } = extractHtmlBlocks(aiContent);
                  for (const blk of blocks) {
                      try {
                          const meta = consumeThinkingMeta();
                          await DB.saveMessage({
                              charId,
                              role: 'assistant',
                              type: 'html_card',
                              content: blk.textPreview ? `[HTML卡片] ${blk.textPreview}` : '[HTML卡片]',
                              timestamp: baseTimestamp + offset,
                              metadata: {
                                  htmlSource: blk.html,
                                  htmlTextPreview: blk.textPreview,
                                  ...(meta || {}),
                              },
                          } as any);
                          if (blk.textPreview) savedPreviewChunks.push(blk.textPreview);
                          offset += 1;
                      } catch (e) {
                          console.error('[Proactive/HTML] 落库 html_card 失败', e);
                      }
                  }
                  aiContent = cleanedContent;
              }

              aiContent = ChatParser.sanitize(aiContent);

              if (aiContent) {
                  // 双语翻译:沿用 useChatAI 的 <翻译><原文>..</原文><译文>..</译文></翻译> 协议,
                  // 把每对原文/译文落成一条 text 消息,内容用 `\n%%BILINGUAL%%\n` 串联供渲染端识别。
                  const hasTranslationTags = /<翻译>\s*<原文>[\s\S]*?<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/.test(aiContent);

                  if (hasTranslationTags) {
                      // 表情包按模型写的位置原地插发（与 applyAssistantPostProcessing 双语分支同款修复）。
                      // 旧实现先把所有 [[SEND_EMOJI:]] 抽走、正文发完后统一追加到最后（还去了重），
                      // 表现为「翻译模式下角色永远最后才发表情包」。
                      const sendEmojiBubble = async (name: string): Promise<void> => {
                          const foundEmoji = emojis.find(e => e.name === name);
                          if (!foundEmoji?.url) return;
                          const meta = consumeThinkingMeta();
                          await DB.saveMessage({
                              charId,
                              role: 'assistant',
                              type: 'emoji',
                              content: foundEmoji.url,
                              timestamp: baseTimestamp + offset,
                              ...(meta ? { metadata: meta } : {}),
                          });
                          offset += 1;
                      };
                      // 翻译标签之外的普通文本段：splitResponse 按出现顺序拆出文字 / 表情逐条发
                      const renderPlainSegment = async (segment: string): Promise<void> => {
                          for (const part of ChatParser.splitResponse(segment)) {
                              if (part.type === 'emoji') {
                                  await sendEmojiBubble(part.content);
                                  continue;
                              }
                              const cleaned = ChatParser.sanitize(part.content);
                              if (!cleaned || !ChatParser.hasDisplayContent(cleaned)) continue;
                              for (const chunk of ChatParser.chunkText(cleaned)) {
                                  if (!chunk) continue;
                                  const meta = consumeThinkingMeta();
                                  await DB.saveMessage({
                                      charId,
                                      role: 'assistant',
                                      type: 'text',
                                      content: chunk,
                                      timestamp: baseTimestamp + offset,
                                      ...(meta ? { metadata: meta } : {}),
                                  });
                                  savedPreviewChunks.push(chunk);
                                  offset += 1;
                              }
                          }
                      };

                      const tagPattern = /<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>([\s\S]*?)<\/译文>\s*<\/翻译>/g;
                      let lastIndex = 0;
                      let tagMatch;
                      while ((tagMatch = tagPattern.exec(aiContent)) !== null) {
                          const textBefore = aiContent.slice(lastIndex, tagMatch.index).trim();
                          if (textBefore) await renderPlainSegment(textBefore);

                          // 混进 <原文>/<译文> 里的表情标签剥出来，紧跟这条双语气泡之后发
                          const inlineEmojis: string[] = [];
                          const stripInlineEmoji = (s: string): string =>
                              s.replace(/\[\[SEND_EMOJI:\s*(.*?)\]\]/g, (_m, n) => { inlineEmojis.push(String(n).trim()); return ''; });
                          const originalText = ChatParser.sanitize(stripInlineEmoji(tagMatch[1]).trim());
                          const translatedText = ChatParser.sanitize(stripInlineEmoji(tagMatch[2]).trim());
                          if (originalText || translatedText) {
                              const biContent = originalText && translatedText
                                  ? `${originalText}\n%%BILINGUAL%%\n${translatedText}`
                                  : (originalText || translatedText);
                              const meta = consumeThinkingMeta();
                              await DB.saveMessage({
                                  charId,
                                  role: 'assistant',
                                  type: 'text',
                                  content: biContent,
                                  timestamp: baseTimestamp + offset,
                                  ...(meta ? { metadata: meta } : {}),
                              });
                              savedPreviewChunks.push(originalText || translatedText);
                              offset += 1;
                          }
                          for (const name of inlineEmojis) await sendEmojiBubble(name);

                          lastIndex = tagMatch.index + tagMatch[0].length;
                      }

                      const textAfter = aiContent.slice(lastIndex).trim();
                      if (textAfter) await renderPlainSegment(textAfter.replace(/<\/?翻译>|<\/?原文>|<\/?译文>/g, '').trim());
                  } else {
                      const responseParts = ChatParser.splitResponse(aiContent);

                      for (const part of responseParts) {
                          if (part.type === 'emoji') {
                              const foundEmoji = emojis.find(e => e.name === part.content);
                              if (foundEmoji?.url) {
                                  const meta = consumeThinkingMeta();
                                  await DB.saveMessage({
                                      charId,
                                      role: 'assistant',
                                      type: 'emoji',
                                      content: foundEmoji.url,
                                      timestamp: baseTimestamp + offset,
                                      ...(meta ? { metadata: meta } : {}),
                                  });
                              } else {
                                  const fallbackText = `发送了表情包：${part.content}`;
                                  const meta = consumeThinkingMeta();
                                  await DB.saveMessage({
                                      charId,
                                      role: 'assistant',
                                      type: 'text',
                                      content: fallbackText,
                                      timestamp: baseTimestamp + offset,
                                      ...(meta ? { metadata: meta } : {}),
                                  });
                                  savedPreviewChunks.push(fallbackText);
                              }
                              offset += 1;
                              continue;
                          }

                          const textChunks = ChatParser.chunkText(part.content)
                              .map(chunk => ChatParser.sanitize(chunk))
                              .filter(chunk => ChatParser.hasDisplayContent(chunk));

                          for (const chunk of textChunks) {
                              const meta = consumeThinkingMeta();
                              await DB.saveMessage({
                                  charId,
                                  role: 'assistant',
                                  type: 'text',
                                  content: chunk,
                                  timestamp: baseTimestamp + offset,
                                  ...(meta ? { metadata: meta } : {}),
                              });
                              savedPreviewChunks.push(chunk);
                              offset += 1;
                          }
                      }
                  }
              }

              if (offset > 0) {
                  const previewSource = savedPreviewChunks.join(' ').trim();
                  const preview = previewSource.replace(/\s+/g, ' ').trim().slice(0, 120)
                      || `${char.name} sent a proactive message`;

                  // 6. Notify OS for unread badge + toast
                  window.dispatchEvent(new CustomEvent('proactive-message-sent', {
                      detail: { charId, charName: char.name, body: preview }
                  }));
              }
          } catch (err) {
              console.error(`[Proactive/Global] Error for ${char.name}:`, err);
          } finally {
              proactiveRunningRef.current = false;
              setProactiveComposingChars(prev => {
                  if (!prev[charId]) return prev;
                  const next = { ...prev };
                  delete next[charId];
                  return next;
              });
              drainQueuedProactive();
          }
      };

      ProactiveChat.onTrigger((charId: string) => {
          void runProactive(charId);
      });

      // 「彼方」自主登入 —— 独立调度，复用同一批 refs 拿最新状态
      const runVR = async (charId: string, room?: string, letterId?: string, manual?: boolean) => {
          const char = charactersRef.current.find(c => c.id === charId);
          // 调度表里还排着队，角色却已经不接入了（或者压根被删了）：这条调度不该继续存在。
          // 就地撤掉并留一行记录 —— 不撤的话它会一直空转，而空转是完全静默的，
          // 用户那边只看得到「明明全关了，调用记录还在涨」，谁也说不清是哪一边错了。
          if (!char || !char.vrState?.enabled) {
              VRScheduler.stop(charId);
              void logVRApiCall({
                  ts: Date.now(), charId, charName: char?.name, ok: false, ms: 0,
                  kind: 'skipped', charEnabled: !!char?.vrState?.enabled,
                  note: char ? '角色未接入彼方，已撤掉这条残留调度' : '角色已不存在，已撤掉这条残留调度',
              });
              return;
          }
          if (!userProfileRef.current) return;
          let outcome: VRSessionOutcome = 'skipped';
          try {
              const result = await runVRSession({
                  char,
                  characters: charactersRef.current,
                  apiConfig: apiConfigRef.current,
                  userProfile: userProfileRef.current,
                  groups: groupsRef.current,
                  realtimeConfig: realtimeConfigRef.current,
                  memoryPalaceConfig: memoryPalaceConfigRef.current,
                  updateCharacter,
                  forcedRoom: room as any,
                  forcedLetterId: letterId,
                  manual,
              });
              // 没书没歌、房间被别人占着这些都不算账，只有真的没调通模型才记一笔失败
              outcome = result.ok ? 'ok' : (result.reason === 'api-error' ? 'failed' : 'skipped');
          } catch (e) {
              console.error('[VRWorld] runVR error', e);
              outcome = 'failed';
          }

          const { tripped, streak } = VRScheduler.report(charId, outcome);
          if (!tripped) return;
          // 熔断了：调度已经被掐掉，这里把角色一并落回未接入，让界面和实际跑的东西对上，
          // 免得又变成「显示未接入、后台还在动」。用函数式更新拿最新的 vrState，
          // 别拿会话开头那份快照写回去，那会把这一轮刚记下的房间和时间抹掉。
          void updateCharacter(charId, prev => ({
              vrState: { ...(prev.vrState || { intervalMinutes: VR_DEFAULT_INTERVAL_MIN }), enabled: false } as any,
          }));
          void logVRApiCall({
              ts: Date.now(), charId, charName: char.name, ok: false, ms: 0,
              kind: 'tripped',
              note: `连续 ${streak} 次没能调通模型，已暂停 ${char.name} 的自主登入`,
          });
          addToast(`${char.name} 连续 ${streak} 次没能调通模型，已暂停 ta 在彼方的自主登入`, 'error');
      };
      VRScheduler.onTrigger((charId: string, room?: string, letterId?: string, manual?: boolean) => { void runVR(charId, room, letterId, manual); });

      // 以角色 vrState 为准对账调度表：调度表存 localStorage、不随备份迁移，
      // 导入备份后角色虽 enabled 但调度表为空，这里补建/清理使其按时触发。
      VRScheduler.reconcile(
          charactersRef.current
              .filter(c => c.vrState?.enabled)
              .map(c => ({ charId: c.id, intervalMinutes: c.vrState?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN }))
      );

      // 「家园」演绎 —— 引擎跑在全局：用户不在家园界面（可能正在和别人私聊）时，
      // 观测/离线 tick 触发的一轮链式演绎照样完成并注入 world_card。
      const runWorld = async (worldId: string, trigger: 'observe' | 'tick') => {
          if (!userProfileRef.current) return;
          try {
              const world = await DB.getWorld(worldId);
              if (!world) return;
              await runWorldEpisode({
                  world,
                  characters: charactersRef.current,
                  apiConfig: apiConfigRef.current,
                  userProfile: userProfileRef.current,
                  groups: groupsRef.current,
                  realtimeConfig: realtimeConfigRef.current,
                  memoryPalaceConfig: memoryPalaceConfigRef.current,
                  trigger,
              });
          } catch (e) {
              console.error('[WorldHome] runWorld error', e);
          }
      };
      WorldScheduler.onTrigger((worldId, trigger) => { void runWorld(worldId, trigger); });

      // 单个角色重 roll（家园 WorldView 派发 world-reroll-request 事件，带 worldId/charId/direction）
      const onRerollRequest = async (e: Event) => {
          const d = (e as CustomEvent).detail || {};
          if (!d.worldId || !d.charId || !userProfileRef.current) return;
          try {
              const world = await DB.getWorld(d.worldId);
              if (!world) return;
              await rerollWorldCharBeat({
                  world,
                  characters: charactersRef.current,
                  apiConfig: apiConfigRef.current,
                  userProfile: userProfileRef.current,
                  groups: groupsRef.current,
                  realtimeConfig: realtimeConfigRef.current,
                  memoryPalaceConfig: memoryPalaceConfigRef.current,
                  trigger: 'observe',
                  episodeId: d.episodeId,
                  charId: d.charId,
                  direction: d.direction,
              });
          } catch (err) {
              console.error('[WorldHome] reroll error', err);
          }
      };
      window.addEventListener('world-reroll-request', onRerollRequest as EventListener);
      // 调度表存 localStorage 不随备份迁移，按 IndexedDB 里的世界配置对账
      void DB.getWorlds()
          .then(async worlds => {
              // 旧存档（一天三段制）→ 四段制（含凌晨）一次性迁移并写回
              for (const w of worlds) {
                  if (migrateWorldDaySegs(w)) await DB.saveWorld(w).catch(() => {});
              }
              WorldScheduler.reconcile(toTickEntries(worlds));
          })
          .catch(() => {});

      return () => {
          // Cleanup: detach proactive listeners when OSContext unmounts (unlikely but safe)
          ProactiveChat.onTrigger(() => {});
          VRScheduler.onTrigger(() => {});
          WorldScheduler.onTrigger(() => {});
          window.removeEventListener('world-reroll-request', onRerollRequest as EventListener);
      };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDataLoaded]);

  // ─── utils 层直写 DB 后的内存回灌 ───
  // 这两条路都在 React 之外把角色写进了 IndexedDB。不回灌的话内存里那份角色停在旧值，
  // 之后随便哪个 updateCharacter 都会拿旧内存合并写回，把刚写进去的东西反向抹掉
  // （情绪 buff 早就踩过这个坑，见上面 buffSyncHandler 的注释），云端快照也跟着停格。
  useEffect(() => {
      // 角色自排后续任务被采纳（「汤炖上了，两小时后叫你」）：任务清单只落在 DB，
      // React 不知情会同时断掉 presence 门、打脏门和面板上的待触发清单三条线。
      const tasksAdoptedHandler = (e: Event) => {
          const charId = ((e as CustomEvent).detail || {}).charId as string | undefined;
          if (!charId) return;
          void DB.getAllCharacters().then(all => {
              const fresh = all.find(c => c.id === charId);
              if (!fresh) return;
              setCharacters(prev => prev.map(c => {
                  if (c.id !== charId) return c;
                  // 只把 activeMsg2Config 这一个字段搬回来：整对象覆盖会让内存里其它更新的
                  // 字段（比如同一时刻刚落地的情绪）倒退，反过来用旧内存整对象写 DB 又会把
                  // 刚采纳的任务清单抹掉。
                  const next = normalizeCharacterImpression({ ...c, activeMsg2Config: fresh.activeMsg2Config });
                  markAmsgStateDirty({
                      char: next,
                      userProfile: userProfileRef.current,
                      groups: groupsRef.current,
                      realtimeConfig: realtimeConfigRef.current,
                  });
                  return next;
              }));
          }).catch(() => {});
      };

      // 听歌时角色把歌加进自己的歌单（MusicContext 直写 DB）：歌单进 fire_pack，
      // 不打脏角色到点还以为那首歌没收藏过。
      const musicProfileSyncHandler = (e: Event) => {
          const detail = ((e as CustomEvent).detail || {}) as { charId?: string; musicProfile?: CharacterProfile['musicProfile'] };
          const { charId, musicProfile } = detail;
          if (!charId || !musicProfile) return;
          setCharacters(prev => prev.map(c => {
              if (c.id !== charId) return c;
              const next = normalizeCharacterImpression({ ...c, musicProfile });
              markAmsgStateDirty({
                  char: next,
                  userProfile: userProfileRef.current,
                  groups: groupsRef.current,
                  realtimeConfig: realtimeConfigRef.current,
              });
              return next;
          }));
      };

      // Push / 彼方 / 家园等 React 外入口完成全自动记忆双写后，只把增量搬回内存。
      // 再基于当前 state 保存一次，堵住后台 DB 写入和前台角色更新同时发生时的反向覆盖。
      const memoryAutoArchiveSyncHandler = (e: Event) => {
          const detail = ((e as CustomEvent).detail || {}) as MemoryAutoArchiveSyncDetail;
          if (!detail.charId) return;
          setCharacters(prev => prev.map(character => {
              if (character.id !== detail.charId) return character;
              const nextMemories = detail.fragments.length > 0
                  ? mergePalaceFragmentsIntoMemories(character.memories || [], detail.fragments)
                  : (character.memories || []);
              const currentHide = character.hideBeforeMessageId || 0;
              const nextHide = Math.max(currentHide, detail.hideBeforeMessageId || 0);
              if (nextMemories === character.memories && nextHide === currentHide) return character;
              const next = normalizeCharacterImpression({
                  ...character,
                  memories: nextMemories,
                  ...(nextHide > currentHide ? { hideBeforeMessageId: nextHide } : {}),
              });
              DB.saveCharacter(next).then(() => {
                  markAmsgStateDirty({
                      char: next,
                      userProfile: userProfileRef.current,
                      groups: groupsRef.current,
                      realtimeConfig: realtimeConfigRef.current,
                  });
              }).catch(error => console.warn('[AutoArchive] state sync save failed', error));
              return next;
          }));
      };

      window.addEventListener('amsg2-tasks-adopted', tasksAdoptedHandler);
      window.addEventListener('char-music-profile-updated', musicProfileSyncHandler);
      window.addEventListener(MEMORY_AUTO_ARCHIVE_SYNC_EVENT, memoryAutoArchiveSyncHandler);
      return () => {
          window.removeEventListener('amsg2-tasks-adopted', tasksAdoptedHandler);
          window.removeEventListener('char-music-profile-updated', musicProfileSyncHandler);
          window.removeEventListener(MEMORY_AUTO_ARCHIVE_SYNC_EVENT, memoryAutoArchiveSyncHandler);
      };
  }, []);

  // 旧版本曾在 Push 后处理里只写宫殿、没写神经链接。每个角色升级后保守修一次：
  // 只补“最后一条 palace 日志之后整天完全空白”的聊天提取节点，不调 API、不动水位线。
  useEffect(() => {
      if (!isDataLoaded) return;
      let cancelled = false;
      const runRepair = async () => {
          const enabledCharacters = characters.filter(character => (
              character.memoryPalaceEnabled && character.autoArchiveEnabled
          ));
          for (const character of enabledCharacters) {
              if (cancelled) return;
              const marker = `mp_autoArchiveDualWriteRepair_v1_${character.id}`;
              if (localStorage.getItem(marker) === '1') continue;
              try {
                  await repairMissingAutoArchiveMemories(character.id);
                  if (!cancelled) localStorage.setItem(marker, '1');
              } catch (error) {
                  console.warn('[AutoArchiveRepair] failed', character.id, error);
              }
          }
      };
      void runRepair();
      return () => { cancelled = true; };
  // 只在本次数据初始化完成时执行；后续新数据走已修复的统一双写入口。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDataLoaded]);

  const updateTheme = async (updates: Partial<OSTheme>) => {
    const { wallpaper, lockWallpaper, launcherWidgetImage, launcherWidgets, desktopDecorations, customFont, ...styleUpdates } = updates;
    // Legacy slots are banned — never let them enter state, regardless of caller intent.
    const sanitizedWidgets = launcherWidgets !== undefined
        ? Object.fromEntries(Object.entries(launcherWidgets).filter(([k]) => k !== 'bl' && k !== 'br'))
        : undefined;
    const sanitizedUpdates: Partial<OSTheme> = { ...updates, launcherWidgetImage: undefined };
    if (sanitizedWidgets !== undefined) sanitizedUpdates.launcherWidgets = sanitizedWidgets;
    const newTheme = { ...theme, ...sanitizedUpdates, launcherWidgetImage: undefined };
    if (newTheme.launcherWidgets) {
        const w = { ...newTheme.launcherWidgets };
        delete w['bl'];
        delete w['br'];
        newTheme.launcherWidgets = Object.keys(w).length > 0 ? w : undefined;
    }
    // 壁纸改存 Blob：把指针（令牌）落库并解析成可渲染 url 后再进 state。
    // theme.wallpaper 在内存里始终是能直接喂 CSS 的值（objectURL / http / 渐变），
    // 不是 blobref 令牌。
    if (wallpaper !== undefined) {
        const legacyWallpaper = isLegacyDefaultWallpaper(wallpaper);
        const preserveNostalgia = shouldPreserveLegacyDefaultWallpaper(wallpaper, newTheme.desktopVariant);
        newTheme.wallpaper = await resolveWallpaperStoredValue(wallpaper, preserveNostalgia);
        if (legacyWallpaper && !preserveNostalgia) Object.assign(newTheme, migrateLegacyDefaultPalette(newTheme));
    }
    if ('lockWallpaper' in updates) {
        newTheme.lockWallpaper = await resolveLockWallpaperStoredValue(lockWallpaper);
    }
    setTheme(newTheme);

    // Legacy single-image asset is permanently banned — always delete, never save.
    await DB.deleteAsset('launcherWidgetImage');

    // Save widget images to IndexedDB (each slot is a separate asset)
    // 值是 blobref 令牌（写端见 apps/Appearance.tsx 的 handleWidgetUpload），一律原样落库。
    // 别按 data: 前缀挑着存——令牌不带这个前缀，挑的结果是这张图只剩 localStorage 一份，
    // 启动时 assets 那份是空的、界面上小组件直接没了。
    if (launcherWidgets !== undefined) {
        for (const slot of LAUNCHER_WIDGET_SLOTS) {
            const val = sanitizedWidgets?.[slot];
            if (val) {
                await DB.saveAsset(`widget_${slot}`, val);
            } else {
                await DB.deleteAsset(`widget_${slot}`);
            }
        }
        // Always purge deprecated slot assets so old data can never resurface.
        await DB.deleteAsset('widget_bl');
        await DB.deleteAsset('widget_br');
    }

    // Save desktop decoration images to IndexedDB
    if (desktopDecorations !== undefined) {
        // Clean up old decoration assets first
        const allAssets = await DB.getAllAssets();
        const oldDecoKeys = allAssets.filter(a => a.id.startsWith('deco_')).map(a => a.id);
        for (const key of oldDecoKeys) {
            await DB.deleteAsset(key);
        }
        // Save new decoration images
        if (desktopDecorations) {
            for (const deco of desktopDecorations) {
                if (deco.content && deco.content.startsWith('data:') && deco.type === 'image') {
                    await DB.saveAsset(`deco_${deco.id}`, deco.content);
                }
            }
        }
    }

    // Logic for Font: Differentiate between Data URI (Blob) and URL (Web Font)
    // Use `in` check so an explicit `customFont: undefined` (user-initiated reset)
    // still triggers the reset branch — `customFont !== undefined` would skip it.
    if ('customFont' in updates) {
        if (customFont && customFont.startsWith('data:')) {
            // Blob: Save to DB, Apply
            await DB.saveAsset('custom_font_data', customFont);
            applyCustomFont(customFont);
        } else if (customFont && (customFont.startsWith('http') || customFont.startsWith('https'))) {
            // Web URL: Clear Blob from DB, Apply, Save to LS (via cleanTheme below)
            await DB.deleteAsset('custom_font_data');
            applyCustomFont(customFont);
        } else {
            // Reset
            await DB.deleteAsset('custom_font_data');
            applyCustomFont(undefined);
        }
    }

    // Save lightweight settings to LocalStorage (strip data URIs & blob object URLs)
    // blob: objectURL 是本次会话临时的，重启后失效——不能进 LS，清空让加载路径从 assets 重新解析。
    const lsTheme = { ...newTheme };
    if (lsTheme.wallpaper && (lsTheme.wallpaper.startsWith('data:') || lsTheme.wallpaper.startsWith('blob:'))) lsTheme.wallpaper = '';
    if (lsTheme.lockWallpaper && (lsTheme.lockWallpaper.startsWith('data:') || lsTheme.lockWallpaper.startsWith('blob:'))) lsTheme.lockWallpaper = undefined;
    // Banned legacy field — never persist.
    lsTheme.launcherWidgetImage = undefined;
    // Strip data URIs and deprecated slots from widgets for LS
    if (lsTheme.launcherWidgets) {
        const cleanWidgets: Record<string, string> = {};
        for (const [k, v] of Object.entries(lsTheme.launcherWidgets)) {
            if (k === 'bl' || k === 'br') continue;
            cleanWidgets[k] = (v && v.startsWith('data:')) ? '' : v;
        }
        lsTheme.launcherWidgets = cleanWidgets;
    }

    // Strip data URIs from desktop decorations for LS
    if (lsTheme.desktopDecorations) {
        lsTheme.desktopDecorations = lsTheme.desktopDecorations.map(d => ({
            ...d,
            content: (d.content && d.content.startsWith('data:') && d.type === 'image') ? '' : d.content
        }));
    }

    // Clear data URI font from LS, keep URL font
    if (lsTheme.customFont && lsTheme.customFont.startsWith('data:')) lsTheme.customFont = '';

    try {
        localStorage.setItem('os_theme', JSON.stringify(lsTheme));
    } catch (e) {
        // quota 满时静默失败 = 用户这次看着正常、下次启动主题回初始。必须让用户知道。
        console.warn('[updateTheme] localStorage 写入失败', e);
        addToast('主题没能保存到本地（存储空间可能已满），重启后可能会还原', 'error');
    }
  };
  const updateApiConfig = (updates: Partial<APIConfig>) => { const newConfig = normalizeApiConfig({ ...apiConfig, ...updates }); setApiConfig(newConfig); localStorage.setItem('os_api_config', JSON.stringify(newConfig)); };
  const updateRealtimeConfig = (updates: Partial<RealtimeConfig>) => { const newConfig = { ...realtimeConfig, ...updates }; setRealtimeConfig(newConfig); localStorage.setItem('os_realtime_config', JSON.stringify(newConfig)); };

  // Cloud Backup functions
  const updateCloudBackupConfig = (updates: Partial<CloudBackupConfig>) => {
      const newConfig = { ...cloudBackupConfig, ...updates };
      setCloudBackupConfig(newConfig);
      localStorage.setItem('os_cloud_backup_config', JSON.stringify(newConfig));
  };

  // Backup provider router — picks the right client module based on
  // cloudBackupConfig.provider ('github' or 'webdav', defaulting to webdav
  // for back-compat with users who configured before the GitHub option).
  const loadBackupProvider = async () => {
      if (cloudBackupConfig.provider === 'github') {
          return await import('../utils/githubClient');
      }
      return await import('../utils/webdavClient');
  };

  const cloudBackupToWebDAV = async (mode: 'text_only' | 'media_only' | 'full') => {
      const { uploadBackup, cleanupOldBackups } = await loadBackupProvider();
      try {
          setSysOperation({ status: 'processing', message: '正在打包备份数据...', progress: 0 });
          const blob = await exportSystem(mode);

          setSysOperation({ status: 'processing', message: '正在上传到云端...', progress: 50 });
          const filename = `Sully_Backup_${mode}_${Date.now()}.zip`;
          const result = await uploadBackup(cloudBackupConfig, blob, filename, (pct) => {
              setSysOperation(prev => ({ ...prev, message: `上传中 ${pct}%...`, progress: 50 + pct * 0.45 }));
          });

          if (!result.ok) {
              throw new Error(result.message);
          }

          // Update last backup time
          updateCloudBackupConfig({ lastBackupTime: Date.now(), lastBackupSize: blob.size });

          // Cleanup old backups (keep latest 5)
          await cleanupOldBackups(cloudBackupConfig, 5).catch(() => {});

          setSysOperation({ status: 'idle', message: '', progress: 100 });
          addToast('云端备份完成', 'success');
          // provider / mode 都是代码里写死的枚举；连接地址、账号、错误原文一概不带。
          trackEvent('上传备份到云端', {
              provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav',
              mode,
              result: '成功',
          });
      } catch (e: any) {
          setSysOperation({ status: 'idle', message: '', progress: 0 });
          addToast(`云端备份失败: ${e.message}`, 'error');
          trackEvent('上传备份到云端', {
              provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav',
              mode,
              result: '失败',
          });
          throw e;
      }
  };

  const cloudRestoreFromWebDAV = async (file: CloudBackupFile) => {
      const { downloadBackup } = await loadBackupProvider();
      try {
          setSysOperation({ status: 'processing', message: '正在从云端下载...', progress: 0 });
          const blob = await downloadBackup(cloudBackupConfig, file, (pct) => {
              setSysOperation(prev => ({ ...prev, message: `下载中 ${pct}%...`, progress: pct * 0.5 }));
          });

          if (!blob) throw new Error('下载失败');

          setSysOperation({ status: 'processing', message: '正在恢复数据...', progress: 50 });
          const zipFile = new File([blob], file.name, { type: 'application/zip' });
          await importSystem(zipFile);
      } catch (e: any) {
          setSysOperation({ status: 'idle', message: '', progress: 0 });
          addToast(`云端恢复失败: ${e.message}`, 'error');
          throw e;
      }
  };

  const listCloudBackups = async (): Promise<CloudBackupFile[]> => {
      const { listBackups } = await loadBackupProvider();
      return listBackups(cloudBackupConfig);
  };

  const updateMemoryPalaceConfig = (updates: Partial<MemoryPalaceGlobalConfig>) => {
    const newConfig = normalizeMemoryPalaceConfig({
      ...memoryPalaceConfig,
      ...updates,
      embedding: { ...memoryPalaceConfig.embedding, ...(updates.embedding || {}) },
      lightLLM: { ...memoryPalaceConfig.lightLLM, ...(updates.lightLLM || {}) },
      rerank: { ...memoryPalaceConfig.rerank, ...(updates.rerank || {}) },
      featureFlags: { ...memoryPalaceConfig.featureFlags, ...(updates.featureFlags || {}) },
    });
    setMemoryPalaceConfig(newConfig);
    localStorage.setItem('os_memory_palace_config', JSON.stringify(newConfig));
  };

  // 情绪 API 同步到所有角色：API 字段（baseUrl/apiKey/model）所有角色共用，
  // 各角色自身的 enabled 标志保持不变。
  // 注意：与记忆宫殿副 API（memoryPalaceConfig.lightLLM）完全独立，两者各管各的。
  const syncEmotionApiToAllCharacters = (api: { baseUrl: string; apiKey: string; model: string } | undefined) => {
    setCharacters(prev => {
      const updated = prev.map(c => {
        const prevEmotion = c.emotionConfig;
        const nextEmotion = {
          enabled: !!prevEmotion?.enabled,
          ...(api && api.baseUrl ? { api: { baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model } } : {}),
        };
        const next = normalizeCharacterImpression({ ...c, emotionConfig: nextEmotion });
        DB.saveCharacter(next);
        return next;
      });
      return updated;
    });
  };
  const updateRemoteVectorConfig = (updates: Partial<typeof defaultRemoteVectorConfig>) => {
    const newConfig = { ...remoteVectorConfig, ...updates };
    setRemoteVectorConfig(newConfig);
    localStorage.setItem('os_remote_vector_config', JSON.stringify(newConfig));
  };
  const saveModels = (models: string[]) => {
      const safeModels = normalizeModelIds(models);
      setAvailableModels(safeModels);
      localStorage.setItem('os_available_models', JSON.stringify(safeModels));
  };
  const addApiPreset = (name: string, config: APIConfig) => { setApiPresets(prev => { const next = [...prev, normalizeApiPreset({ id: Date.now().toString(), name, config })]; localStorage.setItem('os_api_presets', JSON.stringify(next)); return next; }); };
  const updateApiPreset = (id: string, name: string, config: APIConfig) => { setApiPresets(prev => { const next = prev.map(p => p.id === id ? normalizeApiPreset({ ...p, name, config }) : p); localStorage.setItem('os_api_presets', JSON.stringify(next)); return next; }); };
  const removeApiPreset = (id: string) => { setApiPresets(prev => { const next = prev.filter(p => p.id !== id); localStorage.setItem('os_api_presets', JSON.stringify(next)); return next; }); };
  const savePresets = (presets: ApiPreset[]) => { const normalized = presets.map(normalizeApiPreset); setApiPresets(normalized); localStorage.setItem('os_api_presets', JSON.stringify(normalized)); };
  const addCharacter = async () => {
    const name = 'New Character';
    // 默认开启 emotionConfig.enabled，让"开日程 = 开情绪"这条隐含约定对新角色也成立。
    // 真正的闸门是 (isScheduleFeatureOn && emotionConfig.enabled)，schedule 没开
    // 时副 API 不会触发，所以这里默认 true 安全。
    // 注意：memoryPalaceEnabled 不在这里默认开 —— 那是用户在记忆宫殿 App 显式 opt-in
    // 的功能，自动开会替用户决策。
    const newChar: CharacterProfile = {
      id: `char-${Date.now()}`,
      name,
      avatar: generateAvatar(name),
      description: '点击编辑设定...',
      systemPrompt: '',
      memories: [],
      contextLimit: DEFAULT_MANUAL_CONTEXT_LIMIT,
      contextRangeMode: 'manual',
      contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
      emotionConfig: { enabled: true },
    };
    setCharacters(prev => [...prev, newChar]);
    setActiveCharacterId(newChar.id);
    await DB.saveCharacter(newChar);
    return newChar;
  };
  const updateCharacter = async (id: string, updates: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>)) => {
    setCharacters(prev => {
      const updated = prev.map(c => c.id === id ? normalizeCharacterImpression({ ...c, ...(typeof updates === 'function' ? updates(c) : updates) }) : c);
      const target = updated.find(c => c.id === id);
      if (target) {
        const before = prev.find(c => c.id === id);
        // 落库成功后给 amsg2 云端快照打脏：改人设 / 改记忆 / 面板取消任务等所有落库路径都
        // 汇到这里，不打的话云端 fire_pack 停在上一轮聊天，角色到点拿旧世界说话。
        // markDirty 内部自带「没开 2.0 / 没挂 AI 任务就 return」的门，普通角色零成本。
        DB.saveCharacter(target).then(() => {
          markAmsgStateDirty({ char: target, userProfile, groups, realtimeConfig });
          // 时区和名字是另一条路：它们冻在远端任务行里，fire_pack 刷新盖不到。
          // 上游按任务行的 tzId 推进循环任务的下次触发时刻；fixed 模式的推送标题也直接
          // 读任务行的 contactName。只刷真的变了的那几项，别搭别的操作的便车。
          const timeZone = resolveCharTimeZone(before) !== resolveCharTimeZone(target);
          const contactName = !!before && before.name !== target.name;
          if (timeZone || contactName) {
            ActiveMsgClient.refreshCharPendingTaskRow(target, { timeZone, contactName }).catch((error) => {
              console.warn('[amsg2] 角色资料变更后刷新远端任务行失败', target.id, error);
            });
          }
        });
      }
      return updated;
    });
  };
  const deleteCharacter = async (id: string, options?: { force?: boolean }): Promise<DeleteCharacterResult> => {
    const target = characters.find(c => c.id === id);
    // 主动消息 2.0 的任务活在用户自己的 worker 上，不随本地角色删除消失：留着的话
    // 到点照样跑一整轮生成 + 推送，用户会收到一个已经删掉的角色发来的消息（还每次
    // 真烧一轮 LLM）。本地记录一删就再没有 uuid 可取消，所以必须赶在删除之前清。
    // 没排过任务的角色不发任何请求。
    const localTaskUuids = (target?.activeMsg2Config?.tasks ?? [])
      .map(t => t.taskUuid);

    // 云端善后挡在本地删除**前面**：早前丢后台跑的版本在断网 / 秒关 App 时根本跑不完，
    // 任务残留下来，之后「已删角色」的推送还会弹出来。名下真有任务（本地清单有、或远端
    // 查得到）的角色才付这次等待，清不掉就先不删本地、把选择权交回给调用方；
    // 从没配过 2.0 或没填 worker 地址的角色一个请求都不发，路径跟原来一样快。
    if (!options?.force && charMayHaveCloudState(target)) {
      let workerConfigured = false;
      try {
        workerConfigured = Boolean((await ActiveMsgStore.getGlobalConfig()).workerUrl?.trim());
      } catch { /* 配置读不到按没配处理，与 purgeCharCloudState 同口径 */ }

      if (workerConfigured) {
        // 有没有任务以远端清单优先（cancelAllTasksForChar 内部先查远端、查不到才退回
        // 本地清单）——只看本地会漏掉排程记录丢失的幽灵任务。
        let hadTasks = localTaskUuids.length > 0;
        let cleanupFailed = false;
        try {
          const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar(id, localTaskUuids);
          hadTasks = hadTasks || targets.length > 0;
          cleanupFailed = failed.size > 0;
        } catch (err) {
          console.warn('[deleteCharacter] 远端主动消息任务清理失败', err);
          cleanupFailed = true;
        }

        if (hadTasks) {
          if (!cleanupFailed) {
            // 任务取消掉了，云端还留着这个角色的 client_state —— 那里面是完整的角色系统
            // 提示词加最近 30 条对话原文（fire_pack）。删除确认框写的是「记忆将被清空」，
            // 那就得连云端那份一起清，不然聊天记录会一直躺在 D1 里、每删一个角色再堆一份。
            const cloudCleanup = await purgeCharCloudState(target);
            if (cloudCleanup.status === 'failed') {
              console.warn('[deleteCharacter] 云端状态清理失败', cloudCleanup.error);
              cleanupFailed = true;
            }
          }
          if (cleanupFailed) {
            // 云端没清干净：本地先不删。调用方（角色 App）负责弹「重试 / 仍然删除」。
            return { status: 'cloud-cleanup-failed' };
          }
        } else {
          // 名下没有任务：不会再有推送，client_state 清理维持旧节奏丢后台，不挡删除。
          void (async () => {
            const cloudCleanup = await purgeCharCloudState(target);
            if (cloudCleanup.status === 'failed') {
              console.warn('[deleteCharacter] 云端状态清理失败（角色照常删除）', cloudCleanup.error);
              addToast('ta 在云端的聊天上下文没能清掉，可以去设置里「清除云端状态」兜一下', 'error');
            }
          })();
        }
      }
    } else if (options?.force && charMayHaveCloudState(target)) {
      // 「仍然删除」放行后仍旧尽力清一次：能清掉多少算多少，失败只提示、不再拦。
      void (async () => {
        try {
          if (localTaskUuids.length > 0) {
            const { failed } = await ActiveMsgClient.cancelAllTasksForChar(id, localTaskUuids);
            if (failed.size > 0) {
              addToast(`ta 还有 ${failed.size} 个主动消息任务留在远端没取消掉，可能仍会到点推送——可以去设置里「清除云端状态」兜一下`, 'error');
            }
          }
          const cloudCleanup = await purgeCharCloudState(target);
          if (cloudCleanup.status === 'failed') {
            console.warn('[deleteCharacter] 云端状态清理失败（角色照常删除）', cloudCleanup.error);
            addToast('ta 在云端的聊天上下文没能清掉，可以去设置里「清除云端状态」兜一下', 'error');
          }
        } catch (err) {
          console.warn('[deleteCharacter] 远端主动消息任务清理失败', err);
          addToast('ta 的主动消息任务没能在远端取消，可能仍会到点推送，请检查 Worker 连接', 'error');
        }
      })();
    }

    setCharacters(prev => { const remaining = prev.filter(c => c.id !== id); if (remaining.length > 0 && activeCharacterId === id) { setActiveCharacterId(remaining[0].id); } return remaining; });
    await DB.deleteCharacter(id);
    // 表情分类不随角色级联删除会留下「幽灵专属包」：单聊面板被可见性过滤掉（删不掉），
    // 群聊面板/提示词却还能看到。删完角色顺手按剩余角色清一次残留（详见 DB.cleanupEmojiResidue）。
    try {
        const remainingIds = characters.filter(c => c.id !== id).map(c => c.id);
        const report = await DB.cleanupEmojiResidue(remainingIds);
        if (report.removedCategories.length > 0) {
            addToast(`已连带清理 ta 的专属表情分类：${report.removedCategories.map(c => `「${c.name}」`).join('')}`, 'info');
        }
    } catch (err) {
        console.warn('[deleteCharacter] 表情包残留清理失败（不影响角色删除）', err);
    }
    return { status: 'deleted' };
  };

  // 角色分组方法（神经链接"文件夹"）
  const createCharacterGroup = async (name: string): Promise<CharacterGroup | null> => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const newGroup: CharacterGroup = { id: `cgroup-${Date.now()}`, name: trimmed, createdAt: Date.now() };
      await DB.saveCharacterGroup(newGroup);
      setCharacterGroups(prev => [...prev, newGroup]);
      return newGroup;
  };

  const renameCharacterGroup = async (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      let target: CharacterGroup | undefined;
      setCharacterGroups(prev => {
          const updated = prev.map(g => g.id === id ? { ...g, name: trimmed } : g);
          target = updated.find(g => g.id === id);
          return updated;
      });
      if (target) await DB.saveCharacterGroup(target);
  };

  // 删分组 = 组内角色回落「未分组」+ 删分组定义本身，角色不受影响
  const deleteCharacterGroup = async (id: string) => {
      setCharacters(prev => prev.map(c => {
          if (c.groupId !== id) return c;
          const next = { ...c, groupId: undefined };
          DB.saveCharacter(next);
          return next;
      }));
      await DB.deleteCharacterGroup(id);
      setCharacterGroups(prev => prev.filter(g => g.id !== id));
  };

  // Group Methods

  // 群的名字和成员名单都会进每个成员的 fire_pack（角色知道自己在哪些群、群里都有谁），
  // 群一变就要让受影响的成员各刷一次云端快照，否则角色到点还按旧群名 / 旧成员说话。
  // nextGroups 传变更后的完整 groups 列表：markDirty 存的是快照，拿旧列表等于没改。
  const markGroupMembersDirty = (memberIds: string[], nextGroups: GroupProfile[]) => {
      for (const memberId of new Set(memberIds)) {
          const member = characters.find(c => c.id === memberId);
          if (member) markAmsgStateDirty({ char: member, userProfile, groups: nextGroups, realtimeConfig });
      }
  };

  const createGroup = async (name: string, members: string[]) => {
      const newGroup: GroupProfile = {
          id: `group-${Date.now()}`,
          name,
          members,
          avatar: generateAvatar(name),
          createdAt: Date.now()
      };
      await DB.saveGroup(newGroup);
      setGroups(prev => [...prev, newGroup]);
      markGroupMembersDirty(newGroup.members, [...groups, newGroup]);
  };

  const updateGroup = async (id: string, updates: Partial<GroupProfile>) => {
      // 先更新内存中的 groups（列表渲染、再次进群都读这里），再持久化到 DB。
      // 不更新 context 会导致改了群头像/群名退出后又读回旧值（恢复默认）。
      setGroups(prev => prev.map(g => g.id === id ? { ...g, ...updates } : g));
      // 持久化对象基于当前已提交的 groups 合成，不在 setGroups 的 updater 里捕获——
      // React 不保证 updater 同步执行（eager 求值只是优化），旧写法会时而拿到旧值、
      // 时而整个跳过 saveGroup，表现为"内存已更新、退出重进设置丢失"。
      const base = groups.find(g => g.id === id);
      if (!base) return;
      const nextGroup = { ...base, ...updates };
      await DB.saveGroup(nextGroup);
      // 老成员也要打脏：被移出群的角色，他那份快照里的群名单同样得把这个群去掉。
      markGroupMembersDirty(
          [...base.members, ...nextGroup.members],
          groups.map(g => g.id === id ? nextGroup : g),
      );
  };

  const deleteGroup = async (id: string) => {
      const removed = groups.find(g => g.id === id);
      await DB.deleteGroup(id);
      setGroups(prev => prev.filter(g => g.id !== id));
      if (removed) markGroupMembersDirty(removed.members, groups.filter(g => g.id !== id));
  };

  // Worldbook Methods
  const addWorldbook = async (wb: Worldbook) => {
      setWorldbooks(prev => [...prev, wb]);
      await DB.saveWorldbook(wb);
  };

  const updateWorldbook = async (id: string, updates: Partial<Worldbook>) => {
      // Compute the updated entity up-front. Relying on a closure side-effect
      // inside a setState updater is unsafe — React calls updaters lazily
      // during reconciliation, so the closure variable would still be
      // undefined when the synchronous code below runs, silently skipping
      // the DB persist + character cache sync (causing the saved content
      // to revert on reload).
      const existing = worldbooks.find(wb => wb.id === id);
      if (!existing) return;
      const fullUpdatedWb: Worldbook = { ...existing, ...updates, updatedAt: Date.now() };

      // 1. Optimistic Update Local State
      setWorldbooks(prev => prev.map(wb => (wb.id === id ? fullUpdatedWb : wb)));

      // 2. Persist to DB
      await DB.saveWorldbook(fullUpdatedWb);

      // 3. AUTO-SYNC: Update Characters that have this book mounted
      // This ensures data redundancy is kept fresh
      const charsToSync = characters.filter(c => c.mountedWorldbooks?.some(m => m.id === id));

      if (charsToSync.length > 0) {
          const updatedChars = characters.map(char => {
              if (char.mountedWorldbooks?.some(m => m.id === id)) {
                  const newMounted = char.mountedWorldbooks.map(m =>
                      m.id === id
                          ? toMountedWorldbook(fullUpdatedWb)
                          : m
                  );
                  const newChar = { ...char, mountedWorldbooks: newMounted };
                  // 这条落库绕开了 updateCharacter，得自己打脏：世界书正文进 fire_pack 的系统
                  // 提示词，不刷的话角色到点还照着改之前的设定说话。
                  DB.saveCharacter(newChar).then(() => {
                      markAmsgStateDirty({ char: newChar, userProfile, groups, realtimeConfig });
                  });
                  return newChar;
              }
              return char;
          });
          setCharacters(updatedChars);
          addToast(`已同步更新 ${charsToSync.length} 个相关角色的缓存`, 'info');
      }
  };

  const deleteWorldbook = async (id: string) => {
      setWorldbooks(prev => prev.filter(wb => wb.id !== id));
      await DB.deleteWorldbook(id);
      
      // Sync delete: Remove from characters
      const updatedChars = characters.map(char => {
          if (char.mountedWorldbooks?.some(m => m.id === id)) {
              const newMounted = char.mountedWorldbooks.filter(m => m.id !== id);
              const newChar = { ...char, mountedWorldbooks: newMounted };
              // 同 updateWorldbook：绕开 updateCharacter 的落库要自己打脏，否则云端提示词
              // 里还挂着这本已经删掉的世界书。
              DB.saveCharacter(newChar).then(() => {
                  markAmsgStateDirty({ char: newChar, userProfile, groups, realtimeConfig });
              });
              return newChar;
          }
          return char;
      });
      setCharacters(updatedChars);
      addToast('世界书已删除 (同步移除角色挂载)', 'success');
  };

  // Novel Methods (New)
  const addNovel = async (novel: NovelBook) => {
      setNovels(prev => [novel, ...prev]);
      await DB.saveNovel(novel);
  };

  const updateNovel = async (id: string, updates: Partial<NovelBook>) => {
      setNovels(prev => {
          const next = prev.map(n => n.id === id ? { ...n, ...updates, lastActiveAt: Date.now() } : n);
          const target = next.find(n => n.id === id);
          if (target) DB.saveNovel(target);
          return next;
      });
  };

  const deleteNovel = async (id: string) => {
      setNovels(prev => prev.filter(n => n.id !== id));
      await DB.deleteNovel(id);
  };

  // Song Methods
  const addSong = async (song: SongSheet) => {
      setSongs(prev => [song, ...prev]);
      await DB.saveSong(song);
  };

  const updateSong = async (id: string, updates: Partial<SongSheet>) => {
      setSongs(prev => {
          const next = prev.map(s => s.id === id ? { ...s, ...updates, lastActiveAt: Date.now() } : s);
          const target = next.find(s => s.id === id);
          if (target) DB.saveSong(target);
          return next;
      });
  };

  const deleteSong = async (id: string) => {
      setSongs(prev => prev.filter(s => s.id !== id));
      await DB.deleteSong(id);
  };

  const updateUserProfile = async (updates: Partial<UserProfile>) => {
      setUserProfile(prev => {
          const next = { ...prev, ...updates };
          // 用户资料是所有角色共享的素材（名字、人设直接烤进 fire_pack 模板），改完不打脏的话
          // 角色到点还按旧名字叫你。仿表情库：逐个打脏，没开 2.0 的角色被 markDirty 的门筛掉。
          DB.saveUserProfile(next).then(() => {
              markAmsgStateDirtyForAll({ characters, userProfile: next, groups, realtimeConfig });
          });
          return next;
      });
  };
  const addCustomTheme = async (theme: ChatTheme) => { setCustomThemes(prev => { const exists = prev.find(t => t.id === theme.id); if (exists) return prev.map(t => t.id === theme.id ? theme : t); return [...prev, theme]; }); await DB.saveTheme(theme); };
  const removeCustomTheme = async (id: string) => { setCustomThemes(prev => prev.filter(t => t.id !== id)); await DB.deleteTheme(id); };
  const setCustomIcon = async (appId: string, iconUrl: string | undefined) => {
      const stored = iconUrl?.startsWith('data:') ? await migrateDataUrlToRef(iconUrl) : iconUrl;
      setCustomIcons(prev => {
          const next = { ...prev };
          if (stored) next[appId] = stored;
          else delete next[appId];
          return next;
      });
      if (stored) await DB.saveAsset(`icon_${appId}`, stored);
      else await DB.deleteAsset(`icon_${appId}`);
  };
  const addToast = (message: string, type: Toast['type'] = 'info') => { const id = Date.now().toString(); setToasts(prev => [...prev, { id, message, type }]); setTimeout(() => { setToasts(prev => prev.filter(t => t.id !== id)); }, 3000); };
  const showError = (title: string, details: string) => {
      setErrorDialog({ title, details });
      // showError 是分发型入口，title 由调用方传。这里写显式白名单：
      // 只有下面这三个写死的 title 会上报，其它（含以后新加的）一律不发，
      // 也绝不把 title 原样透传出去（免得哪天有人往里塞 URL 或报错原文）。
      if (title === 'Instant Push 发送失败') trackEvent('弹出报错详情弹窗', { 报错来源: 'Instant Push 发送失败' });
      else if (title === '导入失败') trackEvent('弹出报错详情弹窗', { 报错来源: '导入失败' });
      else if (title === '云端恢复失败') trackEvent('弹出报错详情弹窗', { 报错来源: '云端恢复失败' });
  };
  const dismissError = () => { setErrorDialog(null); };

  // --- APPEARANCE PRESETS ---
  const saveAppearancePreset = async (name: string, themeOverride?: OSTheme) => {
      // theme.wallpaper 在内存里是 blob: objectURL（会话临时），不能存进预设。
      // 换成 assets 'wallpaper' 里的持久指针（blobref 令牌 / http / 渐变）。
      const presetTheme: OSTheme = { ...(themeOverride || theme) };
      if (presetTheme.wallpaper && presetTheme.wallpaper.startsWith('blob:')) {
          presetTheme.wallpaper = (await DB.getAsset('wallpaper')) || '';
      }
      if (presetTheme.lockWallpaper?.startsWith('blob:')) {
          presetTheme.lockWallpaper = (await DB.getAsset('lock_wallpaper')) || undefined;
      }
      const preset: AppearancePreset = {
          id: `ap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name,
          createdAt: Date.now(),
          theme: presetTheme,
          customIcons: Object.keys(customIcons).length > 0 ? { ...customIcons } : undefined,
          chatThemes: customThemes.length > 0 ? [...customThemes] : undefined,
      };
      setAppearancePresets(prev => [preset, ...prev]);
      await DB.saveAsset(`appearance_preset_${preset.id}`, JSON.stringify(preset));
      addToast(`外观预设「${name}」已保存`, 'success');
  };

  const applyAppearancePreset = async (id: string) => {
      const preset = appearancePresets.find(p => p.id === id);
      if (!preset) return;
      // Strip banned legacy widget data from preset before applying — old beautification packs
      // may still carry launcherWidgetImage / bl / br, and they must never reach the UI.
      const sanitizedPresetTheme: any = { ...preset.theme, launcherWidgetImage: undefined };
      if (sanitizedPresetTheme.launcherWidgets) {
          const w = { ...sanitizedPresetTheme.launcherWidgets } as Record<string, string>;
          delete w['bl'];
          delete w['br'];
          sanitizedPresetTheme.launcherWidgets = Object.keys(w).length > 0 ? w : undefined;
      }
      // 小组件图落进 assets 的 widget_*：启动加载时这张表会盖掉 localStorage 里那份，
      // 应用预设时不写它，下次启动看到的就还是上一套主题的小组件。
      // 别人分享来的预设里可能还压着 base64，先转成令牌再落库（跟下面 customIcons 一个做法）。
      {
          const presetWidgets = (sanitizedPresetTheme.launcherWidgets || {}) as Record<string, string>;
          const persistedWidgets: Record<string, string> = {};
          for (const slot of LAUNCHER_WIDGET_SLOTS) {
              const val = presetWidgets[slot];
              if (val) {
                  const stored = val.startsWith('data:') ? await migrateDataUrlToRef(val) : val;
                  persistedWidgets[slot] = stored;
                  await DB.saveAsset(`widget_${slot}`, stored);
              } else {
                  await DB.deleteAsset(`widget_${slot}`);
              }
          }
          sanitizedPresetTheme.launcherWidgets = Object.keys(persistedWidgets).length > 0 ? persistedWidgets : undefined;
      }
      // 壁纸改存 Blob：把预设里的指针（blobref 令牌 / 旧 data:）落库并解析成 objectURL 再进 state。
      if (sanitizedPresetTheme.wallpaper !== undefined && typeof sanitizedPresetTheme.wallpaper === 'string') {
          const legacyWallpaper = isLegacyDefaultWallpaper(sanitizedPresetTheme.wallpaper);
          const preserveNostalgia = shouldPreserveLegacyDefaultWallpaper(
              sanitizedPresetTheme.wallpaper,
              sanitizedPresetTheme.desktopVariant,
          );
          sanitizedPresetTheme.wallpaper = await resolveWallpaperStoredValue(sanitizedPresetTheme.wallpaper, preserveNostalgia);
          if (legacyWallpaper && !preserveNostalgia) {
              Object.assign(sanitizedPresetTheme, migrateLegacyDefaultPalette(sanitizedPresetTheme));
          }
      }
      if ('lockWallpaper' in sanitizedPresetTheme) {
          sanitizedPresetTheme.lockWallpaper = await resolveLockWallpaperStoredValue(sanitizedPresetTheme.lockWallpaper);
      }
      // Apply theme
      setTheme(sanitizedPresetTheme);
      // 写 LS 前必须剥 data URI / blob: objectURL，否则 base64 壁纸撑爆 quota、blob: 重启即失效
      const lsTheme: any = { ...sanitizedPresetTheme };
      if (lsTheme.wallpaper && typeof lsTheme.wallpaper === 'string' && (lsTheme.wallpaper.startsWith('data:') || lsTheme.wallpaper.startsWith('blob:'))) lsTheme.wallpaper = '';
      if (lsTheme.lockWallpaper && typeof lsTheme.lockWallpaper === 'string' && (lsTheme.lockWallpaper.startsWith('data:') || lsTheme.lockWallpaper.startsWith('blob:'))) lsTheme.lockWallpaper = undefined;
      lsTheme.launcherWidgetImage = undefined;
      if (lsTheme.launcherWidgets) {
          const cleanWidgets: Record<string, string> = {};
          for (const [k, v] of Object.entries(lsTheme.launcherWidgets as Record<string, string>)) {
              if (k === 'bl' || k === 'br') continue;
              cleanWidgets[k] = (v && v.startsWith('data:')) ? '' : v;
          }
          lsTheme.launcherWidgets = cleanWidgets;
      }
      if (lsTheme.desktopDecorations) {
          lsTheme.desktopDecorations = lsTheme.desktopDecorations.map((d: any) => ({
              ...d,
              content: (d.content && typeof d.content === 'string' && d.content.startsWith('data:') && d.type === 'image') ? '' : d.content,
          }));
      }
      if (lsTheme.customFont && typeof lsTheme.customFont === 'string' && lsTheme.customFont.startsWith('data:')) lsTheme.customFont = '';
      try {
          localStorage.setItem('os_theme', JSON.stringify(lsTheme));
      } catch (e) {
          // 静默跳过 = 预设这次看着已应用、下次启动却回初始主题。必须提示。
          console.warn('[applyAppearancePreset] localStorage 写入失败，已跳过', e);
          addToast('主题没能保存到本地（存储空间可能已满），重启后可能会还原', 'error');
      }
      applyCustomFont(preset.theme.customFont);
      // Apply custom icons if present
      if (preset.customIcons) {
          const persistedIcons: Record<string, string> = {};
          for (const [appId, iconUrl] of Object.entries(preset.customIcons)) {
              const stored = iconUrl.startsWith('data:') ? await migrateDataUrlToRef(iconUrl) : iconUrl;
              persistedIcons[appId] = stored;
              await DB.saveAsset(`icon_${appId}`, stored);
          }
          setCustomIcons(persistedIcons);
      }
      // Apply chat themes if present
      // 预设里的气泡主题可能还压着 base64（老预设、别人分享来的包）。原样写回 themes 表
      // 等于把一键优化刚转走的图又倒回去——用户会看到「优化完过阵子又涨回来了」。
      // 所以落库前先转成令牌，内存里也用转完的那份：不然下次存预设又把 base64 抄进去，
      // 绕成一个圈。上面 customIcons 那段本来就是这么做的，这里跟它对齐。
      if (preset.chatThemes) {
          const migratedThemes: ChatTheme[] = [];
          for (const ct of preset.chatThemes) {
              const migrated = await migrateChatThemeBlobRefs(ct);
              migratedThemes.push(migrated);
              await DB.saveTheme(migrated);
          }
          setCustomThemes(prev => {
              const merged = [...prev];
              for (const ct of migratedThemes) {
                  const idx = merged.findIndex(t => t.id === ct.id);
                  if (idx >= 0) merged[idx] = ct;
                  else merged.push(ct);
              }
              return merged;
          });
      }
      // 壁纸指针已在上面 resolveWallpaperStoredValue 里落库（令牌→assets），此处不再重复写。
      if (preset.theme.desktopDecorations) {
          for (const d of preset.theme.desktopDecorations) {
              if (d.type === 'image' && d.content) {
                  await DB.saveAsset(`deco_${d.id}`, d.content);
              }
          }
      }
      addToast(`已应用预设「${preset.name}」`, 'success');
  };

  const deleteAppearancePreset = async (id: string) => {
      setAppearancePresets(prev => prev.filter(p => p.id !== id));
      await DB.deleteAsset(`appearance_preset_${id}`);
      addToast('预设已删除', 'info');
  };

  // 一键还原外观：把主题、图标、壁纸、小组件、装饰、字体全部回到出厂状态。
  // 用户在不同版本/不同备份之间反复导入时，customIcons 与 IndexedDB 里的 widget_/deco_/icon_
  // 残留经常导致图标错乱，这里直接整体清空再写回 default。
  // 已保存的外观预设不动，用户随时还能切回去。
  const resetAppearance = async () => {
      try {
          await resolveLockWallpaperStoredValue(undefined);
          setTheme(defaultTheme);
          applyCustomFont(undefined);

          const iconAppIds = Object.keys(customIcons);
          setCustomIcons({});
          for (const appId of iconAppIds) {
              await DB.deleteAsset(`icon_${appId}`);
          }
          // 自定义的主屏图标也在 customIcons 里（_pwa_），但它额外往 DOM 注入过一条
          // apple-touch-icon / manifest，删数据不会把注入撤掉——不撤的话页面上那条还挂着
          // 已经不存在的图标，直到下次刷新。
          clearPwaIcon();

          const allAssets = await DB.getAllAssets();
          for (const asset of allAssets) {
              const id = asset.id;
              if (
                  id === 'wallpaper' ||
                  id === 'lock_wallpaper' ||
                  id === 'launcherWidgetImage' ||
                  id === 'custom_font_data' ||
                  id.startsWith('widget_') ||
                  id.startsWith('deco_') ||
                  id.startsWith('icon_')
              ) {
                  await DB.deleteAsset(id);
              }
          }

          try {
              localStorage.setItem('os_theme', JSON.stringify(defaultTheme));
          } catch (e) {
              console.warn('[resetAppearance] localStorage 写入失败', e);
          }

          addToast('外观已还原为初始状态', 'success');
      } catch (e: any) {
          addToast(e?.message || '还原失败', 'error');
      }
  };

  const renameAppearancePreset = async (id: string, name: string) => {
      setAppearancePresets(prev => prev.map(p => {
          if (p.id !== id) return p;
          const updated = { ...p, name };
          DB.saveAsset(`appearance_preset_${id}`, JSON.stringify(updated));
          return updated;
      }));
      addToast('预设已重命名', 'success');
  };

  const exportAppearancePreset = async (id: string): Promise<Blob> => {
      const preset = appearancePresets.find(p => p.id === id);
      if (!preset) throw new Error('预设不存在');
      // 预设里的壁纸可能是 blobref 令牌（本机 blob_assets），导出到别的设备会失效——
      // 先深拷贝再把令牌解析回 data:image，保证导出文件自包含可移植。
      const exportPreset = deepCloneForExport(preset);
      await resolveBlobRefsDeep(exportPreset);
      // 保留原始壁纸画质，把整个预设 JSON 塞进 zip 包压体积
      const data = JSON.stringify({ type: 'sully_appearance_preset', version: 1, ...exportPreset }, null, 2);
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      (zip as any).file('preset.json', data);
      return (zip as any).generateAsync(
          { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } },
      );
  };

  const importAppearancePreset = async (file: File): Promise<void> => {
      // 兼容两种格式：新版 .zip（内含 preset.json）/ 旧版 .json 明文
      let raw: any;
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      const isZip = head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
      if (isZip) {
          const JSZip = await loadJSZip();
          const zip = await JSZip.loadAsync(file);
          const entry = zip.file('preset.json') || Object.values((zip as any).files || {}).find((f: any) => !f.dir && /\.json$/i.test(f.name));
          if (!entry) throw new Error('压缩包内未找到 preset.json');
          const text = await (entry as any).async('string');
          raw = JSON.parse(text);
      } else {
          const text = await file.text();
          raw = JSON.parse(text);
      }
      if (raw.type !== 'sully_appearance_preset') throw new Error('无效的外观预设文件');
      const preset = await migrateAppearancePresetBlobRefs({
          id: `ap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: raw.name || '导入的预设',
          createdAt: Date.now(),
          theme: raw.theme,
          customIcons: raw.customIcons,
          chatThemes: raw.chatThemes,
          chatLayout: raw.chatLayout,
      } as AppearancePreset);
      setAppearancePresets(prev => [preset, ...prev]);
      await DB.saveAsset(`appearance_preset_${preset.id}`, JSON.stringify(preset));
      addToast(`已导入预设「${preset.name}」`, 'success');
  };

  // --- MODIFIED EXPORT SYSTEM WITH SEPARATED ASSETS ZIP ---
  const exportSystem = async (mode: 'text_only' | 'media_only' | 'full'): Promise<Blob> => {
      try {
          setSysOperation({ status: 'processing', message: '正在初始化打包引擎...', progress: 0 });
          
          const JSZip = await loadJSZip();
          const zip = new JSZip();
          const assetsFolder = zip.folder("assets");
          let assetCount = 0;
          let malformedImageCount = 0;
          const malformedImageDiagnostics: MalformedBackupImageDiagnostic[] = [];
          const maxMalformedImageDiagnostics = 100;

          // Dedup table — same base64 payload reused across stores (角色头像在
          // 多个 chat / handbook / room 里被嵌入) gets stored exactly once. Key
          // is the base64 string itself, value is the assets/* path. For a
          // heavy user with 50 chats sharing a 200KB avatar this trims ~10MB.
          const assetDedupMap = new Map<string, string>();

          // v3 blob 旁路：blobref 令牌原样进 JSON，这里从每段真正落包的 JSON 文本里收集
          // 令牌（backupFormat 的 onSerialized 钩子），打包收尾把对应 Blob 直写 blobs/*。
          // 从落包文本收集 = 没有「哪些 store 要处理」的名单可漏，嵌套 JSON 字符串里的
          // 令牌（如 assets 表的 appearance_preset_*）也逐字可见。text_only 令牌已剥空，不收。
          const referencedBlobTokens = new Set<string>();
          const collectSerialized = mode === 'text_only'
              ? undefined
              : (s: string) => collectBlobRefs(s, referencedBlobTokens);

          // Strip Base64 Images (Recursive) - Used for Text Only Mode
          const stripBase64 = (obj: any): any => {
              if (typeof obj === 'string') {
                  // text_only 模式剥掉所有图片：data:image 与 blobref 令牌（令牌无二进制随行，
                  // 恢复端认不得，等同一张丢失的图）都清空。
                  if (obj.startsWith('data:image') || obj.startsWith(BLOBREF_PREFIX)) return '';
                  return obj;
              }
              if (Array.isArray(obj)) {
                  return obj.map(item => stripBase64(item));
              }
              if (obj !== null && typeof obj === 'object') {
                  const newObj: any = {};
                  for (const key in obj) {
                      if (Object.prototype.hasOwnProperty.call(obj, key)) {
                          newObj[key] = stripBase64(obj[key]);
                      }
                  }
                  return newObj;
              }
              return obj;
          };

          const stripTextOnlyMedia = (obj: any): any => {
              const stripped = stripBase64(obj);
              const markExpiredCallSnapshots = (value: any): void => {
                  if (Array.isArray(value)) {
                      value.forEach(markExpiredCallSnapshots);
                      return;
                  }
                  if (!value || typeof value !== 'object') return;
                  const metadata = value.metadata;
                  if (metadata && typeof metadata === 'object'
                      && Object.prototype.hasOwnProperty.call(metadata, 'cameraSnapshotRef')) {
                      delete metadata.cameraSnapshotRef;
                      metadata.cameraSnapshotExpired = true;
                  }
              };
              markExpiredCallSnapshots(stripped);
              return stripped;
          };

          // 把一条 data:image base64 落进 ZIP 的 assets/ 文件夹，返回它的 assets/* 路径。
          // 同一份 base64 全局只存一份（assetDedupMap 按完整 base64 去重）。无法识别但
          // 不一定损坏的 data url 原样保留；确认损坏的正文只在导出副本里置空。
          const resolveImage = (value: string, location: string): string => {
              try {
                  const cached = assetDedupMap.get(value);
                  if (cached) return cached;
                  const parsed = parseImageDataUrlForBackup(value);
                  if (!parsed.ok) {
                      // SVG、带额外 MIME 参数等本来就不走 assets/* 的 data URL 沿用旧行为，
                      // 原样留在 JSON，也不把它误报成「损坏图片」。
                      if (parsed.reason === 'unsupported-header') return value;
                      malformedImageCount++;
                      if (malformedImageDiagnostics.length < maxMalformedImageDiagnostics) {
                          malformedImageDiagnostics.push({
                              location,
                              reason: parsed.reason,
                              originalLength: value.length,
                          });
                      }
                      // 坏 Base64 已无法还原；不把正文写进 assets 或备份 JSON，避免恢复后继续
                      // 传播脏数据。这里只修改 IDB 结构化克隆/运行态深拷贝，不会改用户本地库。
                      console.warn(`[Backup] 损坏图片已从导出副本跳过: ${location} (${parsed.reason}, ${value.length} chars)`);
                      return '';
                  }
                  const filename = `asset_${Date.now()}_${assetCount++}.${parsed.extension}`;
                  // JPEG/PNG/WebP/GIF 本身已压缩，再跑 DEFLATE 只会浪费手机 CPU；直接存储。
                  assetsFolder?.file(filename, parsed.base64, { base64: true, compression: 'STORE' });
                  const path = `assets/${filename}`;
                  assetDedupMap.set(value, path);
                  return path;
              } catch (e) {
                  console.warn("Failed to process asset", e);
                  return value;
              }
          };

          // Extract Images to ZIP (in-place) - Used for Media/Theme Mode.
          // 原地把 base64 换成 assets/* 路径，不再另建一棵对象树，导出大 store 时峰值内存更省。
          // 传进来的必须是独立副本：store 数据是 IDB 结构化克隆副本（安全）；theme /
          // customIcons / appearancePresets 引用了运行态 state，已在上面 backupData 里深拷贝。
          const processObject = (obj: any, source = 'backupData'): any => {
              const safeRecordId = (value: unknown): string | null => {
                  if (typeof value !== 'string' && typeof value !== 'number') return null;
                  return String(value).replace(/[\r\n]/g, ' ').slice(0, 80);
              };
              const describeLocation = (path: BackupObjectPath): string => {
                  let label = source;
                  let pathStart = 0;
                  if (Array.isArray(obj) && typeof path[0] === 'number') {
                      const index = path[0];
                      const row = obj[index];
                      const id = row && typeof row === 'object'
                          ? safeRecordId((row as any).id ?? (row as any).uuid ?? (row as any).key)
                          : null;
                      label += `[${index}]${id ? `(id=${id})` : ''}`;
                      pathStart = 1;
                  } else if (obj && typeof obj === 'object' && !source.includes('(id=')) {
                      const id = safeRecordId((obj as any).id ?? (obj as any).uuid ?? (obj as any).key);
                      if (id) label += `(id=${id})`;
                  }
                  for (const segment of path.slice(pathStart)) {
                      label += typeof segment === 'number' ? `[${segment}]` : `.${segment}`;
                  }
                  return label;
              };
              extractImagesInPlace(obj, (dataUrl, path) => resolveImage(dataUrl, describeLocation(path)));
              return obj;
          };

          const isRedundantManagedAssetId = (id: string) => (
              id === 'wallpaper' ||
              id === 'launcherWidgetImage' ||
              id === 'custom_font_data' ||
              id === 'spark_social_profile' ||
              id === 'spark_user_bg' ||
              id === 'room_custom_assets_list' ||
              id.startsWith('widget_') ||
              id.startsWith('deco_') ||
              id.startsWith('icon_') ||
              id.startsWith('appearance_preset_')
          );

          // 1. Define Stores to Process based on Mode
          let storesToProcess: string[] = [];
          const allStores = [
              // character_groups（角色分组定义）必须与 characters 同进退：
              // 角色身上的 groupId 指向这张表，漏导会让导入端全员回落「未分组」
              'characters', 'character_groups', 'messages', 'themes', 'emojis', 'emoji_categories', 'assets', 'gallery',
              'user_profile', 'diaries', 'tasks', 'anniversaries', 'room_todos',
              'room_notes', 'groups', 'journal_stickers', 'social_posts', 'courses', 'games', 'worldbooks', 'story_theaters', 'story_theater_presets', 'story_theater_masks', 'novels', 'songs',
              'bank_transactions', 'bank_data',
              'xhs_activities', 'xhs_stock',
              'quizzes', 'guidebook', 'scheduled_messages', 'life_sim',
              'handbook', 'trackers', 'tracker_entries', 'hotnews_snapshots',
              'memory_nodes', 'memory_vectors', 'memory_links', 'topic_boxes', 'anticipations', 'event_boxes',
              'room_plates', 'digest_reports',
              'daily_schedule', 'memory_batches',
              'pixel_home_assets', 'pixel_home_layouts',
              // 「彼方」虚拟世界各房间 store —— 早期导出清单漏了，导致备份不含房间数据
              // 剧院的 vr_scripts(投稿剧本) / vr_plays(角色演过的话剧) / vr_presets(写作风格预设)
              // 之前也漏在这份清单外，导出后这三类剧院数据全丢（导入端其实早已支持恢复）
              'vr_novels', 'vr_annotations', 'cc_custom_parts', 'vr_music', 'vr_guestbook', 'vr_letters', 'vr_settings',
              'vr_scripts', 'vr_plays', 'vr_presets',
              // 家园（同世界观多角色大世界）——世界定义 + 演绎历史。导入端早已支持恢复
              // （worldHomeLocal 本机配置也已随导出带走），但这两个 store 之前漏在清单外，
              // 导致导出的备份不含家园数据。
              'worlds', 'world_episodes',
              // 生活记录（档案 App：生理期/药盒/锻炼 + 药盒计划 + 设置；记账走 bank_transactions）
              // 导入端 importFullData 已支持恢复，这里必须同步登记，否则备份不含生活记录。
              'life_records', 'med_plans', 'life_record_settings'
          ];

          if (mode === 'full') {
              storesToProcess = allStores; // Include everything
          } else if (mode === 'text_only') {
              storesToProcess = allStores.filter(s => s !== 'assets'); // Exclude raw assets store
          } else if (mode === 'media_only') {
              // media_only now includes themes/assets for complete media backup
              storesToProcess = ['gallery', 'emojis', 'emoji_categories', 'journal_stickers', 'user_profile', 'characters', 'messages', 'themes', 'assets', 'bank_data',
                  'pixel_home_assets', 'pixel_home_layouts', 'daily_schedule', 'cc_custom_parts'];
          }

          // Fetch Social App & Room Assets (Optional, depends on mode)
          const sparkUserBg = await DB.getAsset('spark_user_bg');
          const sparkSocialProfile = await DB.getAsset('spark_social_profile');
          const roomCustomAssets = await DB.getAsset('room_custom_assets_list');

          // theme / customIcons / appearancePresets 直接引用运行态 React state。只有
          // media/full 会走 processObject 原地改，必须先深拷贝，否则会把正在用的系统主题改坏；
          // text_only 走 stripBase64（返回新树、不改原对象），直接用引用即可，省掉一次
          // 可能多达数 MB（壁纸 base64）的克隆。
          const cloneForInPlace = <T,>(v: T): T => (mode === 'text_only' ? v : deepCloneForExport(v));

          const backupData: Partial<FullBackupData> = {
              timestamp: Date.now(),
              version: 3,
              apiConfig: (mode === 'text_only' || mode === 'full') ? apiConfig : undefined,
              checkPhoneApi: (mode === 'text_only' || mode === 'full') ? getCheckPhoneApi() : undefined,
              apiPresets: (mode === 'text_only' || mode === 'full') ? apiPresets : undefined,
              availableModels: (mode === 'text_only' || mode === 'full') ? availableModels : undefined,
              realtimeConfig: (mode === 'text_only' || mode === 'full') ? realtimeConfig : undefined,
              memoryPalaceConfig: (mode === 'text_only' || mode === 'full') ? memoryPalaceConfig : undefined,
              theme: cloneForInPlace(theme), // Include theme in all modes (text/media)
              customIcons: (mode === 'text_only' || mode === 'media_only' || mode === 'full')
                  ? cloneForInPlace(customIcons)
                  : undefined,
              appearancePresets: (mode === 'text_only' || mode === 'media_only' || mode === 'full')
                  ? cloneForInPlace(appearancePresets)
                  : undefined,
              
              socialAppData: (mode === 'text_only' || mode === 'media_only' || mode === 'full') ? {
                  charHandles: JSON.parse(localStorage.getItem('spark_char_handles') || '{}'),
                  userProfile: sparkSocialProfile ? JSON.parse(sparkSocialProfile) : undefined,
                  userId: localStorage.getItem('spark_user_id') || undefined,
                  userBg: sparkUserBg || undefined
              } : undefined,
              
              roomCustomAssets: (mode === 'text_only' || mode === 'media_only' || mode === 'full') ? (roomCustomAssets ? JSON.parse(roomCustomAssets) : []) : undefined,
              mediaAssets: [], // Initialize mediaAssets array

              // Study Room settings (localStorage)
              studyApiConfig: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('study_api_config'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
              studyTutorPresets: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('study_tutor_presets'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,

              // 云端配置
              cloudBackupConfig: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('os_cloud_backup_config'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
              remoteVectorConfig: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('os_remote_vector_config'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,

              // SAR 活动室：公告/初见、双卡池及人格推演记录必须跟用户历史一起迁移。
              sarLocalState: (mode === 'text_only' || mode === 'full') ? collectSARLocalBackup() : undefined,

              // Instant Push
              instantPushConfig: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('instant_push_config_v1'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
              pushVapid: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('push_vapid_v1'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,


              // Memory Palace 水位线
              memoryPalaceHighWaterMarks: (mode === 'text_only' || mode === 'full') ? (() => {
                  const hwm: Record<string, number> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (key?.startsWith('mp_lastMsgId_')) {
                          const charId = key.replace('mp_lastMsgId_', '');
                          hwm[charId] = parseInt(localStorage.getItem(key) || '0', 10);
                      }
                  }
                  return Object.keys(hwm).length > 0 ? hwm : undefined;
              })() : undefined,

              // Memory Palace 每角色的 UI 标记（人格检测已跑过、首次归档 banner 已看过等）
              // 丢了会导致重弹一次人格确认 / 首次 banner，体验噪声但不丢数据，仍然应该备份
              memoryPalaceFlags: (mode === 'text_only' || mode === 'full') ? (() => {
                  const flags: Record<string, string> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key) continue;
                      if (key.startsWith('mp_personality_tried_')
                          || key.startsWith('mp_first_archive_notice_')) {
                          flags[key] = localStorage.getItem(key) || '';
                      }
                  }
                  return Object.keys(flags).length > 0 ? flags : undefined;
              })() : undefined,

              // Chat 翻译 / 归档 / 润色相关设置
              chatTranslateSourceLang: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('chat_translate_source_lang') || undefined) : undefined,
              chatTranslateTargetLang: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('chat_translate_lang') || undefined) : undefined,
              chatTranslateEnabledByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                  const map: Record<string, boolean> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key || !key.startsWith('chat_translate_enabled_')) continue;
                      const charId = key.replace('chat_translate_enabled_', '');
                      map[charId] = localStorage.getItem(key) === 'true';
                  }
                  return Object.keys(map).length > 0 ? map : undefined;
              })() : undefined,
              chatTranslateExpandedByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                  const map: Record<string, boolean> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key || !key.startsWith('chat_translate_expanded_')) continue;
                      const charId = key.replace('chat_translate_expanded_', '');
                      map[charId] = localStorage.getItem(key) === 'true';
                  }
                  return Object.keys(map).length > 0 ? map : undefined;
              })() : undefined,
              chatTranslateSourceLangByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                  const map: Record<string, string> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key || !key.startsWith('chat_translate_source_lang_')) continue;
                      const charId = key.replace('chat_translate_source_lang_', '');
                      const value = localStorage.getItem(key);
                      if (charId && value) map[charId] = value;
                  }
                  return Object.keys(map).length > 0 ? map : undefined;
              })() : undefined,
              chatTranslateTargetLangByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                  const map: Record<string, string> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key || !key.startsWith('chat_translate_lang_')) continue;
                      const charId = key.replace('chat_translate_lang_', '');
                      const value = localStorage.getItem(key);
                      if (charId && value) map[charId] = value;
                  }
                  return Object.keys(map).length > 0 ? map : undefined;
              })() : undefined,
              chatArchivePrompts: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('chat_archive_prompts'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
              chatActiveArchivePromptId: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('chat_active_archive_prompt_id') || undefined) : undefined,
              characterRefinePrompts: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('character_refine_prompts'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
              characterActiveRefinePromptId: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('character_active_refine_prompt_id') || undefined) : undefined,

              // UI / 偏好
              scheduleAppTheme: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('schedule_app_theme') || undefined) : undefined,
              handbookLifestreamDepth: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('handbook_lifestream_depth') || undefined) : undefined,
              groupchatContextLimit: (mode === 'text_only' || mode === 'full') ? (() => { const v = localStorage.getItem('groupchat_context_limit'); const n = v ? parseInt(v, 10) : NaN; return Number.isFinite(n) ? n : undefined; })() : undefined,
              browserConfig: (mode === 'text_only' || mode === 'full') ? (() => {
                  const braveKey = localStorage.getItem('browser_brave_key') || undefined;
                  const useReal = localStorage.getItem('browser_use_real_search');
                  const useRealSearch = useReal === null ? undefined : useReal === 'true';
                  if (!braveKey && useRealSearch === undefined) return undefined;
                  return { braveKey, useRealSearch };
              })() : undefined,
              bm25Mode: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('bm25_mode') || undefined) : undefined,
              lastActiveCharId: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('os_last_active_char_id') || undefined) : undefined,
              storyTheaterAppearance: (mode === 'text_only' || mode === 'full') ? exportStoryTheaterAppearanceSetting() : undefined,
              eventNotifFlags: (mode === 'text_only' || mode === 'full') ? (() => {
                  const flags: Record<string, string> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key) continue;
                      if (key.startsWith('sullyos_')) {
                          flags[key] = localStorage.getItem(key) || '';
                      }
                  }
                  return Object.keys(flags).length > 0 ? flags : undefined;
              })() : undefined,

              // 本机 localStorage 配置（导入端 importFullData 已支持恢复，之前导出漏发导致丢失）
              //  · 瑞幸 / 麦当劳 MCP 的点单 token + 启用状态（用户说的「那个码」）
              //  · 邮局身份、家园全局 API + 文风收藏
              vrPostOffice: (mode === 'text_only' || mode === 'full') ? exportPostOfficeLocal() : undefined,
              vrSignal: (mode === 'text_only' || mode === 'full') ? exportSignalLocal() : undefined, // 信号坠落处：句子归属「你·角色」+ 反复用清单
              worldHomeLocal: (mode === 'text_only' || mode === 'full') ? exportWorldHomeLocal() : undefined,
              luckinLocal: (mode === 'text_only' || mode === 'full') ? exportLuckinLocal() : undefined,
              mcdLocal: (mode === 'text_only' || mode === 'full') ? exportMcdLocal() : undefined,
              mcpLocal: (mode === 'text_only' || mode === 'full') ? exportMcpLocal() : undefined,

              // 梦境盲盒收藏册（账号级 localStorage，不挂在角色上，需单独随备份带走）
              dreamCollection: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('os_dream_collection'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,

              // 桌面电子宠物主题的主色调偏好（账号级 localStorage）。room_card 涓流卡片本身
              // 是普通消息、随 messages store 一起导出，这里只补带走这个纯外观偏好。
              gotchiAccentHue: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('tama_accent_hue'); return s !== null ? s : undefined; } catch { return undefined; } })() : undefined,
          };

          // 主动消息 2.0 的全局配置（Worker 地址 / 密钥 / 即时对话开关）。它存在独立的
          // ActiveMsg 库里，不在上面那份 store 清单内，所以单独取一次；异步，故在字面量外。
          // 纯配置无媒体，跟着 text_only / full 走。
          if (mode === 'text_only' || mode === 'full') {
              backupData.amsg2GlobalConfig = await exportAmsg2GlobalConfig();
          }

          // 桌面皮肤偏好（电子宠物/手游风的界面配色 + 看板 banner）——异步（看板图令牌需解析为
          // data URL 才能跨设备），所以在对象字面量外单独 await。text_only 只带配色偏好、跳过看板大图。
          backupData.desktopSkinLocal = await exportDesktopSkinLocal(mode !== 'text_only');

          // 协同工作是可拆卸的独立 IndexedDB，不在主 DB store 清单里，必须单独打包。
          // text_only 带窗口/消息/分类/API 设置但不带文件字节；media_only 只带文件字节；
          // full 两者都带。文件原始 Blob 直写 ZIP，避免 base64 放大和重复保存。
          const { CollaborationStore } = await import('../features/collaboration/store');
          const includeCollaborationText = mode !== 'media_only';
          const includeCollaborationAssets = mode !== 'text_only';
          const collaborationBackup = await CollaborationStore.exportBackup(
              includeCollaborationAssets,
              includeCollaborationText,
          );
          backupData.collaborationBackupVersion = 1;
          backupData.collaborationBackupMode = mode;
          if (includeCollaborationText) {
              backupData.collaborationSessions = collaborationBackup.sessions || [];
              backupData.collaborationMessages = collaborationBackup.messages || [];
              backupData.collaborationCategories = collaborationBackup.categories || [];
              backupData.collaborationSettings = collaborationBackup.settings;
          }
          if (includeCollaborationAssets) {
              backupData.collaborationAssetIndex = [];
              const collaborationAssets = collaborationBackup.assets || [];
              for (let index = 0; index < collaborationAssets.length; index++) {
                  const asset = collaborationAssets[index];
                  const safeId = asset.id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || `asset-${index}`;
                  const path = `collaboration/assets/${String(index).padStart(5, '0')}-${safeId}.bin`;
                  zip.file(path, new Uint8Array(await asset.blob.arrayBuffer()), { compression: 'STORE' });
                  backupData.collaborationAssetIndex.push({
                      id: asset.id,
                      path,
                      mimeType: asset.blob.type || 'application/octet-stream',
                      size: asset.blob.size,
                      createdAt: asset.createdAt,
                  });
                  if (index % 10 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
              }
          }

          const totalSteps = storesToProcess.length + 3;
          let currentStep = 0;

          // Pre-process specialized image fields (Social App, Theme)。processObject 是
          // 原地改，所以这里按语句调用、不接返回值，读起来就是「就地处理这个对象」。
          if (mode !== 'text_only') {
              // 壁纸 / 小屋自定义素材 / 外观预设里的 blobref 令牌原样进包（二进制走 blobs/*
              // 旁路，onSerialized 收集，无需在这里逐字段处理）。theme.wallpaper 内存里是
              // blob: objectURL（会话临时，恢复端认不得），这里换回持久化指针
              // （blobref 令牌 / 旧 data: / http）。旧 data: 值仍走下面 processObject 的
              // data:→assets/* 抽取管线。
              if (backupData.theme) {
                  const wp = (backupData.theme as any).wallpaper;
                  if (typeof wp === 'string' && wp.startsWith('blob:')) {
                      const ptr = await DB.getAsset('wallpaper'); // blobref 令牌 / 旧 data: / http
                      (backupData.theme as any).wallpaper = ptr || '';
                  }
                  const lockWp = (backupData.theme as any).lockWallpaper;
                  if (typeof lockWp === 'string' && lockWp.startsWith('blob:')) {
                      const ptr = await DB.getAsset('lock_wallpaper');
                      (backupData.theme as any).lockWallpaper = ptr || undefined;
                  }
              }

              if (backupData.socialAppData?.userProfile) processObject(backupData.socialAppData.userProfile, 'socialAppData.userProfile');
              if (backupData.socialAppData?.userBg) processObject(backupData.socialAppData.userBg, 'socialAppData.userBg');
              if (backupData.roomCustomAssets) processObject(backupData.roomCustomAssets, 'roomCustomAssets');
              if (backupData.theme) processObject(backupData.theme, 'theme');
              if (backupData.customIcons) processObject(backupData.customIcons, 'customIcons');
              if (backupData.appearancePresets) processObject(backupData.appearancePresets, 'appearancePresets');
          } else {
              // Strip images for text only
              if (backupData.socialAppData?.userProfile) backupData.socialAppData.userProfile = stripBase64(backupData.socialAppData.userProfile);
              if (backupData.socialAppData?.userBg) backupData.socialAppData.userBg = stripBase64(backupData.socialAppData.userBg);
              if (backupData.roomCustomAssets) backupData.roomCustomAssets = stripBase64(backupData.roomCustomAssets);
              if (backupData.customIcons) backupData.customIcons = stripBase64(backupData.customIcons);
              if (backupData.appearancePresets) backupData.appearancePresets = stripBase64(backupData.appearancePresets);
              if (backupData.theme) {
                  // Save preset decoration content before stripping (SVGs start with data:image and would be stripped)
                  const savedPresetDecos = backupData.theme.desktopDecorations
                      ?.filter(d => d.type === 'preset')
                      .map(d => ({ id: d.id, content: d.content }));
                  const strippedTheme = stripBase64(backupData.theme) as OSTheme;
                  // text_only 不带图片：内存里的壁纸是 blob: objectURL（会话临时，恢复端认不得），
                  // blobref 令牌 stripBase64 已清空——这里补清 blob: 避免导出一个死链接壁纸。
                  if (strippedTheme.wallpaper && strippedTheme.wallpaper.startsWith('blob:')) strippedTheme.wallpaper = '';
                  backupData.theme = strippedTheme;
                  // Restore preset SVGs and remove image decorations (they have no data in text mode)
                  if (strippedTheme.desktopDecorations && savedPresetDecos) {
                      strippedTheme.desktopDecorations = strippedTheme.desktopDecorations
                          .map(d => {
                              const saved = savedPresetDecos.find(p => p.id === d.id);
                              return saved ? { ...d, content: saved.content } : d;
                          })
                          .filter(d => d.content && d.content !== '');
                  }
              }
          }

          // Stores that never contain base64 image data — skip recursive traversal
          const noImageStores = new Set([
              'memory_nodes', 'memory_vectors', 'memory_links', 'topic_boxes', 'anticipations', 'event_boxes',
              'room_plates', 'digest_reports',
              'bank_transactions', 'scheduled_messages', 'memory_batches', 'hotnews_snapshots',
              'character_groups',
              'story_theaters', 'story_theater_presets',
              'life_records', 'med_plans', 'life_record_settings'
          ]);

          // Chunked processObject for large arrays — yields to main thread every 200 items
          const processArrayChunked = async (arr: any[], fn: (item: any, index: number) => any, chunkSize = 200): Promise<any[]> => {
              if (arr.length <= chunkSize) return arr.map(fn);
              const result: any[] = [];
              for (let i = 0; i < arr.length; i += chunkSize) {
                  const chunk = arr.slice(i, i + chunkSize).map((item, offset) => fn(item, i + offset));
                  result.push(...chunk);
                  if (i + chunkSize < arr.length) {
                      await new Promise(r => setTimeout(r, 0));
                  }
              }
              return result;
          };

          // 纯文字备份的低内存路径：store 通过单事务 IDB 游标逐条读取，剥图后立即序列化进 ZIP 分片，
          // 不再 getAll 整表驻留。gallery/messages 中即使有大量 base64 图片，峰值也只是一条记录。
          const textOnlyFieldByStore: Record<string, string> = {
              characters: 'characters',
              character_groups: 'characterGroups',
              messages: 'messages',
              themes: 'customThemes',
              emojis: 'savedEmojis',
              emoji_categories: 'emojiCategories',
              gallery: 'galleryImages',
              diaries: 'diaries',
              tasks: 'tasks',
              anniversaries: 'anniversaries',
              room_todos: 'roomTodos',
              room_notes: 'roomNotes',
              groups: 'groups',
              journal_stickers: 'savedJournalStickers',
              social_posts: 'socialPosts',
              courses: 'courses',
              games: 'games',
              worldbooks: 'worldbooks',
              story_theaters: 'storyTheaters',
              story_theater_presets: 'storyTheaterPresets',
              story_theater_masks: 'storyTheaterMasks',
              novels: 'novels',
              songs: 'songs',
              bank_transactions: 'bankTransactions',
              xhs_activities: 'xhsActivities',
              xhs_stock: 'xhsStockImages',
              quizzes: 'quizSessions',
              guidebook: 'guidebookSessions',
              scheduled_messages: 'scheduledMessages',
              handbook: 'handbooks',
              trackers: 'trackers',
              tracker_entries: 'trackerEntries',
              hotnews_snapshots: 'hotNewsSnapshots',
              memory_nodes: 'memoryNodes',
              memory_links: 'memoryLinks',
              topic_boxes: 'topicBoxes',
              anticipations: 'anticipations',
              event_boxes: 'eventBoxes',
              room_plates: 'roomPlates',
              digest_reports: 'digestReports',
              daily_schedule: 'dailySchedules',
              memory_batches: 'memoryBatches',
              pixel_home_assets: 'pixelHomeAssets',
              pixel_home_layouts: 'pixelHomeLayouts',
              vr_novels: 'vrNovels',
              vr_annotations: 'vrAnnotations',
              cc_custom_parts: 'customCreatorParts',
              vr_letters: 'vrLetters',
              vr_settings: 'vrSettings',
              vr_scripts: 'vrScripts',
              vr_plays: 'vrStagedPlays',
              vr_presets: 'vrPresets',
              worlds: 'worlds',
              world_episodes: 'worldEpisodes',
              life_records: 'lifeRecords',
              med_plans: 'medPlans',
              life_record_settings: 'lifeRecordSettings',
          };
          const prewrittenStores: BackupManifest['stores'] = {};
          const textOnlyShardLimits = {
              maxLen: 4 * 1024 * 1024,
              maxItems: 500,
              hardMaxLen: 256 * 1024 * 1024,
          };

          // 向量二进制旁路（#2）：memory_vectors 归一化拼成 bin + 索引（逻辑在 encodeVectorsForBackup，
          // 那边有 ensureFloat32 统一 Uint8Array / Float32Array / 遗留 number[] 三态），导出收尾交给
          // writeV2Backup 落进 zip——不进 backupData、不当普通数组分片，避开 number[] 进 JSON 的膨胀。
          let vectorPayload: ReturnType<typeof encodeVectorsForBackup> | undefined;
          // Only voice Blobs reachable from the exported Live2D settings are portable.
          // Orphaned/cancelled companion generations must not silently bloat a backup.
          const companionVoiceAssetIdsForBackup = new Set<string>();

          for (const storeName of storesToProcess) {
              currentStep++;
              setSysOperation({
                  status: 'processing',
                  message: `正在打包: ${storeName} ...`,
                  progress: (currentStep / totalSteps) * 100
              });

              // 4500+ 条记忆若仍是早期 number[] 存储，getAll 会先在 JS 堆里膨胀成数百 MB。
              // 两遍游标逐条扫描只常驻最终 Float32 紧凑 bin；格式仍是原来的单 bin + index。
              if (storeName === 'memory_vectors' && mode === 'text_only') {
                  vectorPayload = await encodeVectorsForBackupChunked(async (onBatch) => {
                      await DB.streamRawStoreData(storeName, item => onBatch([item]));
                  });
                  await new Promise(resolve => setTimeout(resolve, 0));
                  continue;
              }

              // 纯文字模式的普通数组 store：逐条剥图后立刻写分片。这里 continue 后不会再把
              // processedData 挂到 backupData，因此已处理的整表不会一直留到最终压缩阶段。
              const textOnlyField = mode === 'text_only' ? textOnlyFieldByStore[storeName] : undefined;
              if (textOnlyField) {
                  const writer = createV2ArrayFieldWriter(
                      zip as unknown as ZipFileWriter,
                      textOnlyField,
                      {
                          limits: textOnlyShardLimits,
                          onYield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
                      },
                  );
                  await DB.streamRawStoreData(storeName, (item) => {
                      // characters 也走这条低内存旁路；必须在逐条写分片前规范化，
                      // 否则 text_only 会绕过下面 getAll 分支，把旧部署的绝对样板房 URL 原样带走。
                      if (storeName === 'characters') normalizeCharacterRoomAssetsInPlace(item);
                      const processedItem = noImageStores.has(storeName) ? item : stripTextOnlyMedia(item);
                      writer.appendSync([processedItem]);
                  });
                  prewrittenStores[textOnlyField] = await writer.finish();
                  continue;
              }

              let rawData = await DB.getRawStoreData(storeName);
              let processedData: any;

              // Built-in room-template files belong to the app, not to the source deployment.
              // Older builds stored their fully resolved origin in roomConfig; strip that origin
              // from the export clone so restoring on another host/base path keeps every item.
              if (storeName === 'characters' && Array.isArray(rawData)) {
                  for (const character of rawData) normalizeCharacterRoomAssetsInPlace(character);
              }

              // 向量旁路：归一化拼 bin + 索引，不进 backupData（writeV2Backup 收尾落 zip）。直接跳过
              // 下面的图片处理 / switch（向量无图、无 image base64）。
              if (storeName === 'memory_vectors') {
                  vectorPayload = encodeVectorsForBackup(Array.isArray(rawData) ? rawData : []);
                  await new Promise(resolve => setTimeout(resolve, 10));
                  continue;
              }

              // blobref 令牌（characters 的小屋图 / sprites.chibi、cc_custom_parts 的
              // src/shadowSrc、messages 的 cameraSnapshotRef、songs 的 coverImage……）
              // 不在这里做任何处理：v3 令牌原样进 JSON，onSerialized 统一收集、
              // 二进制随 blobs/* 旁路走，任何 store 的令牌都覆盖，没有名单可漏。
              if (storeName === 'characters' && mode !== 'text_only' && Array.isArray(rawData)) {
                  // v1 陪伴语音存在 blob_assets（普通备份不读取该 store）。先迁移到
                  // assets 的二进制语音通道，稍后 assets store 才能把完整 Blob 写进 ZIP。
                  await ensureCompanionVoiceAssetsForBackup(rawData as CharacterProfile[]);
                  collectCharacterCompanionVoiceAssetIds(rawData as CharacterProfile[])
                      .forEach(assetId => companionVoiceAssetIdsForBackup.add(assetId));
              }

              // --- MODE SPECIFIC FILTERING ---

              if (storeName === 'assets' && Array.isArray(rawData)) {
                  rawData = rawData.filter((asset: { id?: string; data?: { favorite?: boolean } } | null | undefined) => {
                      if (!asset || typeof asset.id !== 'string') return true;
                      if (isRedundantManagedAssetId(asset.id)) return false;
                      if (isCompanionVoiceAssetId(asset.id) && !companionVoiceAssetIdsForBackup.has(asset.id)) return false;
                      // Shared TTS rows and un-favorited message voice are implementation
                      // cache. Only explicit favorites and saved Live2D-preset dependencies
                      // join full/media backups; neither joins text-only backups.
                      return shouldIncludeVoiceRelatedAssetInBackup(asset, mode !== 'text_only');
                  });
                  // Blob is not JSON-serializable (`JSON.stringify(new Blob()) === '{}'`).
                  // Put allowed audio bytes in their own ZIP entries and leave a JSON-safe
                  // marker in the assets row. `tts_*` and ordinary un-favorited speech stay
                  // disposable cache and are not duplicated in backups.
                  await externalizeVoiceMessageBlobs(rawData, (path, bytes) => {
                      zip.file(path, bytes, { compression: 'STORE' });
                  });
              }

              // Fast path: stores with no image data skip expensive recursive traversal
              // （memory_vectors 已在上面走二进制旁路 continue 掉，这里只剩其它无图 store）
              if (noImageStores.has(storeName)) {
                  processedData = rawData;
              } else if (mode === 'text_only') {
                  processedData = Array.isArray(rawData) && rawData.length > 200
                      ? await processArrayChunked(rawData, stripTextOnlyMedia)
                      : stripTextOnlyMedia(rawData);
              } else {
                  // Media & Theme Mode: Extract Images
                  
                  if (storeName === 'messages' && mode === 'media_only') {
                      // Keep normal media messages plus lightweight call turns that own
                      // a retained frame / [图片] marker. Import remains patch-mode.
                      rawData = rawData.filter((m: Message) => (
                          m.type === 'image'
                          || m.type === 'emoji'
                          || !!m.metadata?.cameraSnapshotRef
                          || m.metadata?.cameraSnapshotExpired === true
                      ));
                  }

                  if (storeName === 'characters' && mode === 'media_only') {
                      // Character Logic: Export ONLY visual assets to mediaAssets array
                      // Do not export the full character array to avoid overwriting text data on import
                      const mediaList = rawData.map((c: CharacterProfile, index: number) => {
                          const extracted = {
                              charId: c.id,
                              avatar: c.avatar,
                              companionAvatar: c.companionAvatar,
                              companionTouchSettings: c.companionTouchSettings,
                              sprites: c.sprites,
                              // Date app sprite data: skin sets carry alternate sprite maps,
                              // and customDateSprites/activeSkinSetId are required to wire them up.
                              dateSkinSets: c.dateSkinSets,
                              activeSkinSetId: c.activeSkinSetId,
                              customDateSprites: c.customDateSprites,
                              spriteConfig: c.spriteConfig,
                              roomItems: c.roomConfig?.items?.reduce((acc: any, item: any) => {
                                  // data:（旧值，下面 processObject 抽成 assets/*）和 blobref
                                  // 令牌（v3 原样进包，二进制走 blobs/*）都算媒体，都带走。
                                  if (item.image && (item.image.startsWith('data:') || isBlobRef(item.image))) {
                                      acc[item.id] = item.image;
                                  }
                                  return acc;
                              }, {}),
                              backgrounds: {
                                  chat: c.chatBackground,
                                  date: c.dateBackground,
                                  roomWall: c.roomConfig?.wallImage,
                                  roomFloor: c.roomConfig?.floorImage
                              }
                          };
                          return processObject(extracted, `characters[${index}](id=${String(c.id).slice(0, 80)})`);
                      });
                      backupData.mediaAssets = mediaList;
                      continue; // Skip standard assignment
                  }

                  processedData = Array.isArray(rawData) && rawData.length > 200
                      ? await processArrayChunked(rawData, (item, index) => {
                          const id = item && typeof item === 'object'
                              ? String(item.id ?? item.uuid ?? item.key ?? '').replace(/[\r\n]/g, ' ').slice(0, 80)
                              : '';
                          return processObject(item, `${storeName}[${index}]${id ? `(id=${id})` : ''}`);
                      })
                      : processObject(rawData, storeName);
              }

              // Assign to Backup Data
              switch(storeName) {
                  case 'characters': if(mode !== 'media_only') backupData.characters = processedData; break;
                  // 角色分组定义 —— 键名须与 importFullData 读取的字段（data.characterGroups）对齐
                  case 'character_groups': backupData.characterGroups = processedData; break;
                  case 'messages': backupData.messages = processedData; break;
                  case 'themes': backupData.customThemes = processedData; break;
                  case 'emojis': backupData.savedEmojis = processedData; break;
                  case 'emoji_categories': backupData.emojiCategories = processedData; break;
                  case 'assets': backupData.assets = processedData; break;
                  case 'gallery': backupData.galleryImages = processedData; break;
                  case 'user_profile': if (processedData[0]) backupData.userProfile = processedData[0]; break;
                  case 'diaries': backupData.diaries = processedData; break;
                  case 'tasks': backupData.tasks = processedData; break;
                  case 'anniversaries': backupData.anniversaries = processedData; break;
                  case 'room_todos': backupData.roomTodos = processedData; break;
                  case 'room_notes': backupData.roomNotes = processedData; break;
                  case 'groups': backupData.groups = processedData; break;
                  case 'journal_stickers': backupData.savedJournalStickers = processedData; break;
                  case 'social_posts': backupData.socialPosts = processedData; break;
                  case 'courses': backupData.courses = processedData; break;
                  case 'games': backupData.games = processedData; break;
                  case 'worldbooks': backupData.worldbooks = processedData; break;
                  case 'story_theaters': backupData.storyTheaters = processedData; break;
                  case 'story_theater_presets': backupData.storyTheaterPresets = processedData; break;
                  case 'story_theater_masks': backupData.storyTheaterMasks = processedData; break;
                  case 'novels': backupData.novels = processedData; break;
                  case 'songs': backupData.songs = processedData; break;
                  case 'bank_transactions': backupData.bankTransactions = processedData; break;
                  case 'bank_data': {
                      if (Array.isArray(processedData)) {
                          const mainState = processedData.find((d: any) => d.id === 'main_state');
                          const dollhouseRecord = processedData.find((d: any) => d.id === 'dollhouse_state');
                          backupData.bankState = mainState ? { ...mainState, id: undefined } : undefined;
                          backupData.bankDollhouse = dollhouseRecord?.data || undefined;
                      }
                      break;
                  }
                  case 'xhs_activities': backupData.xhsActivities = processedData; break;
                  case 'xhs_stock': backupData.xhsStockImages = processedData; break;
                  case 'quizzes': backupData.quizSessions = processedData; break;
                  case 'guidebook': backupData.guidebookSessions = processedData; break;
                  case 'scheduled_messages': backupData.scheduledMessages = processedData; break;
                  case 'life_sim': backupData.lifeSimState = Array.isArray(processedData) ? (processedData[0] || null) : (processedData || null); break;
                  case 'handbook': backupData.handbooks = processedData; break;
                  case 'trackers': backupData.trackers = processedData; break;
                  case 'tracker_entries': backupData.trackerEntries = processedData; break;
                  case 'life_records': backupData.lifeRecords = processedData; break;
                  case 'med_plans': backupData.medPlans = processedData; break;
                  case 'life_record_settings': backupData.lifeRecordSettings = processedData; break;
                  case 'hotnews_snapshots': backupData.hotNewsSnapshots = processedData; break;
                  case 'memory_nodes': backupData.memoryNodes = processedData; break;
                  // memory_vectors 走二进制旁路（上面已 continue），不在此 switch 落 backupData
                  case 'memory_links': backupData.memoryLinks = processedData; break;
                  case 'topic_boxes': backupData.topicBoxes = processedData; break;
                  case 'anticipations': backupData.anticipations = processedData; break;
                  case 'event_boxes': backupData.eventBoxes = processedData; break;
                  case 'room_plates': backupData.roomPlates = processedData; break;
                  case 'digest_reports': backupData.digestReports = processedData; break;
                  case 'daily_schedule': backupData.dailySchedules = processedData; break;
                  case 'memory_batches': backupData.memoryBatches = processedData; break;
                  case 'pixel_home_assets': backupData.pixelHomeAssets = processedData; break;
                  case 'pixel_home_layouts': backupData.pixelHomeLayouts = processedData; break;
                  // 「彼方」虚拟世界 —— 键名须与 importFullData 读取的字段对齐
                  case 'vr_novels': backupData.vrNovels = processedData; break;
                  case 'vr_annotations': backupData.vrAnnotations = processedData; break;
                  case 'cc_custom_parts': backupData.customCreatorParts = processedData; break;
                  case 'vr_letters': backupData.vrLetters = processedData; break;
                  case 'vr_settings': backupData.vrSettings = processedData; break;
                  case 'vr_scripts': backupData.vrScripts = processedData; break;
                  case 'vr_plays': backupData.vrStagedPlays = processedData; break;        // 角色演过的话剧
                  case 'vr_presets': backupData.vrPresets = processedData; break;
                  // 单例 store：导入端期望单个对象（取首条），非数组
                  case 'vr_music': backupData.vrMusicRoom = Array.isArray(processedData) ? (processedData[0] || undefined) : (processedData || undefined); break;
                  case 'vr_guestbook': backupData.vrGuestbook = Array.isArray(processedData) ? (processedData[0] || undefined) : (processedData || undefined); break;
                  // 家园 —— 键名须与 importFullData 读取的字段（data.worlds / data.worldEpisodes）对齐
                  case 'worlds': backupData.worlds = processedData; break;
                  case 'world_episodes': backupData.worldEpisodes = processedData; break;
              }

              await new Promise(resolve => setTimeout(resolve, 10));
          }

          // 进度条停在 70% 让用户看到接下来的"压缩中 X%"实际推进，而不是卡在 95% 干等。
          // text_only 用 level 6；媒体/全量仍用 level 9，具体见 generateAsync 配置。
          setSysOperation({ status: 'processing', message: '正在生成压缩包...', progress: 70 });

          // --- v2 分片序列化（替代老的单根 data.json）---
          // 不再把所有数据拼成一根 data.json：单根字符串逼近 ~512M 会确定性 RangeError。
          // 改成每个数组字段分片写进 stores/<field>.NNN.json、其余非数组字段进 metadata.json、
          // 收尾写 manifest.json 当导入契约。导入端按 manifest 把各片拼回与这里完全相同的 data
          // 对象，喂给原封不动的 importFullData——还原语义（clear-and-add / merge / 单例 /
          // media_only 补丁……）不在这里重写。详见 utils/backupFormat.ts。
          await writeV2Backup(
              zip as unknown as ZipFileWriter,
              backupData as Record<string, any>,
              {
                  mode,
                  createdAt: Date.now(),
                  assetCount,
                  vectors: vectorPayload,
                  prewrittenStores,
                  onYield: () => new Promise<void>(r => setTimeout(r, 0)),
                  onSerialized: collectSerialized,
              },
          );

          // v3 blob 旁路收尾：被引用令牌的 Blob 直写 blobs/<id>（原文件字节，全程不经
          // base64），附 blobs/index.json。图已丢的令牌跳过——死令牌留在 JSON 里，
          // 恢复端渲染为空，与 v2 置空串的用户可见结果等价。
          if (collectSerialized && referencedBlobTokens.size > 0) {
              setSysOperation({ status: 'processing', message: '正在打包图片二进制...', progress: 70 });
              const { missing } = await writeBlobsToZip(
                  zip as unknown as ZipFileWriter,
                  referencedBlobTokens,
                  getBlobForRef,
                  { onYield: () => new Promise<void>(r => setTimeout(r, 0)) },
              );
              if (missing.length > 0) {
                  console.warn(`备份时 ${missing.length} 个图片令牌已无对应数据，已跳过:`, missing);
              }
          }

          if (malformedImageCount > 0) {
              zip.file(
                  'diagnostics/malformed-images.json',
                  JSON.stringify(buildMalformedImageDiagnostics({
                      createdAt: new Date().toISOString(),
                      mode,
                      total: malformedImageCount,
                      items: malformedImageDiagnostics,
                  }), null, 2),
              );
          }

          // 进度提示：每 ~5% 更新一次（避免高频 React 重渲染），同时让进度
          // 条从 70% 平滑爬到 99%，用户能确切看到"在动"。
          let lastReportedPercent = -10;
          const content = await zip.generateAsync(
              {
                  type: "blob",
                  streamFiles: true,
                  compression: "DEFLATE",
                  // 纯文字备份优先手机稳定性；6 级体积差很小，但比 9 级明显省时省内存。
                  compressionOptions: { level: mode === 'text_only' ? 6 : 9 },
              },
              (metadata) => {
                  const p = metadata.percent;
                  if (p - lastReportedPercent >= 5 || p >= 99) {
                      lastReportedPercent = p;
                      setSysOperation({
                          status: 'processing',
                          message: `正在压缩备份数据 ${p.toFixed(0)}%...`,
                          progress: Math.min(99, 70 + Math.floor(p * 0.29)),
                      });
                  }
              }
          );

          setSysOperation({ status: 'idle', message: '', progress: 100 });
          // 备份成功 → 推进「该备份啦」提醒的计时（本地导出 / 云备份都走这里，一处覆盖两条路径）
          markBackupDone();
          if (malformedImageCount > 0) {
              console.warn(`[Backup] 备份已完成，已从导出副本跳过 ${malformedImageCount} 处损坏图片`, malformedImageDiagnostics);
              addToast(`备份已生成，已跳过 ${malformedImageCount} 处无法恢复的损坏图片；其他数据已正常保存`, 'info');
          }
          return content;

      } catch (e: any) {
          console.error("Export Failed", e);
          setSysOperation({ status: 'idle', message: '', progress: 0 });
          throw new Error("导出失败: " + e.message);
      }
  };

  const importSystem = async (fileOrJson: File | string): Promise<void> => {
      const sourceName = typeof fileOrJson === 'string' ? 'json' : fileOrJson.name;
      const sourceSize = typeof fileOrJson === 'string'
          ? (typeof Blob !== 'undefined' ? new Blob([fileOrJson]).size : fileOrJson.length)
          : fileOrJson.size;
      const restoredAssetFiles = new Set<string>();
      let totalAssetFiles = 0;
      let lastProgress = 0;
      let lastCurrent = '解析备份文件';
      let lastCurrentFile: string | undefined;
      let lastCurrentFileSize: number | undefined;

      const buildImportMessage = (headline: string, update: ImportProgressUpdate = {}) => {
          const lines = [headline];
          const current = update.current ?? lastCurrent;
          const currentFile = update.currentFile ?? lastCurrentFile;
          const currentFileSize = update.currentFileSize ?? lastCurrentFileSize;
          if (current) lines.push(`当前部分：${current}`);
          if (typeof update.itemTotal === 'number' && update.itemTotal > 0) {
              lines.push(`条目：${update.itemDone || 0}/${update.itemTotal}`);
          }
          if (currentFile) {
              const sizeText = formatBytes(currentFileSize);
              lines.push(`当前文件：${currentFile}${sizeText ? ` · ${sizeText}` : ''}`);
          }
          if (sourceName !== 'json' && update.current === '解析备份文件') {
              const sizeText = formatBytes(sourceSize);
              lines.push(`备份：${sourceName}${sizeText ? ` · ${sizeText}` : ''}`);
          }
          return lines.join('\n');
      };

      const showImportProgress = (
          phase: string,
          headline: string,
          progress: number,
          update: ImportProgressUpdate = {}
      ) => {
          if (update.current !== undefined) lastCurrent = update.current;
          if (update.currentFile !== undefined) lastCurrentFile = update.currentFile;
          if (update.currentFileSize !== undefined) lastCurrentFileSize = update.currentFileSize;
          lastProgress = Math.max(lastProgress, Math.min(99, Math.max(0, progress)));
          markImportInProgress(phase, sourceName, {
              sourceSize,
              assetDone: restoredAssetFiles.size,
              assetTotal: totalAssetFiles || undefined,
              ...update,
          });
          setSysOperation({
              status: 'processing',
              message: buildImportMessage(headline, update),
              progress: lastProgress,
          });
      };

      const countZipAssetFiles = (zip: JSZipLike) => {
          const files = Object.values((zip as any).files || {}) as any[];
          return files.filter(file => file && !file.dir && typeof file.name === 'string' && file.name.startsWith('assets/')).length;
      };

      const estimateBase64Bytes = (base64: string) => {
          const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
          return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
      };

      showImportProgress('parsing', '正在解析备份文件...', 1, { current: '解析备份文件', sourceSize });
      try {
          let data: FullBackupData;
          let zip: JSZipLike | null = null;

          if (typeof fileOrJson === 'string') {
              data = JSON.parse(fileOrJson);
          } else {
              if (!fileOrJson.name.endsWith('.zip')) {
                  try {
                      const text = await fileOrJson.text();
                      data = JSON.parse(text);
                  } catch (e) {
                      throw new Error("无效的文件格式，请上传 .zip 或 .json");
                  }
              } else {
                  const JSZip = await loadJSZip();
                  const loadedZip = await JSZip.loadAsync(fileOrJson);
                  zip = loadedZip;
                  totalAssetFiles = countZipAssetFiles(loadedZip);
                  const manifestFile = loadedZip.file("manifest.json");
                  if (manifestFile) {
                      // v2：manifest 驱动的分片备份。assembleV2Backup 只读 zip、组装内存对象，
                      // 校验不过直接抛错——此时 importFullData 还没调，DB 一字未动。
                      let manifest: BackupManifest;
                      try {
                          manifest = JSON.parse(await manifestFile.async("string"));
                      } catch {
                          throw new Error("损坏的备份包：manifest.json 解析失败");
                      }
                      data = await assembleV2Backup(
                          loadedZip as unknown as ZipFileReader,
                          manifest,
                          {
                              onYield: () => new Promise<void>(r => setTimeout(r, 0)),
                              onShardProgress: (field, idx, total) => {
                                  showImportProgress('parsing', '正在解析备份分片...',
                                      5 + Math.floor((idx / Math.max(1, total)) * 25),
                                      { current: `分片 ${field}` });
                              },
                          },
                      ) as FullBackupData;
                  } else {
                      // v1（老备份）：单根 data.json，原样保留，老备份永远打得开。
                      const dataFile = loadedZip.file("data.json");
                      if (!dataFile) throw new Error("损坏的备份包: 缺少 data.json");
                      let jsonStr = await dataFile.async("string");
                      data = JSON.parse(jsonStr);
                      jsonStr = '';
                  }
              }
          }

          // 必须发生在 restoreAssetsInPlace / DB.importFullData 之前：不受支持的第三方
          // 备份一旦命中特征就整包拒绝，不能出现“导入了一半才报错”的状态。
          assertSupportedSullyBackup(data);

          // 在 importFullData 为释放内存逐项清空 data 字段前冻结“这是否是主历史替换”。
          // 新版 media_only 明确不动 SAR；旧备份没有 mode 时，只要带 characters/messages
          // 就按整档恢复处理，避免导入后继续沿用另一份历史的公告/卡池/推演记录。
          const replacesPrimaryHistory = data.collaborationBackupMode !== 'media_only'
              && (Object.prototype.hasOwnProperty.call(data, 'characters')
                  || Object.prototype.hasOwnProperty.call(data, 'messages'));

          // 协同文件先完整读出并校验，再开始写任何主数据库。这样文件索引损坏或 ZIP
          // 缺项时会整包中止，不会出现主数据已恢复、协同文件只回来一半的状态。
          let collaborationAssetRecords: Array<{ id: string; blob: Blob; createdAt: number }> | undefined;
          if (data.collaborationAssetIndex !== undefined) {
              collaborationAssetRecords = [];
              if (data.collaborationAssetIndex.length > 0 && !zip) {
                  throw new Error('损坏的备份包：协同文件缺少 ZIP 数据');
              }
              for (let index = 0; index < data.collaborationAssetIndex.length; index++) {
                  const item = data.collaborationAssetIndex[index];
                  if (!item?.id || !item.path?.startsWith('collaboration/assets/')) {
                      throw new Error('损坏的备份包：协同文件索引无效');
                  }
                  const entry = zip?.file(item.path);
                  if (!entry) throw new Error(`损坏的备份包：缺少协同文件 ${item.path}`);
                  const bytes = await entry.async('uint8array');
                  if (typeof item.size === 'number' && item.size >= 0 && bytes.byteLength !== item.size) {
                      throw new Error(`损坏的备份包：协同文件大小不符 ${item.path}`);
                  }
                  const fileBytes = new Uint8Array(bytes.byteLength);
                  fileBytes.set(bytes);
                  collaborationAssetRecords.push({
                      id: item.id,
                      blob: new Blob([fileBytes.buffer], { type: item.mimeType || 'application/octet-stream' }),
                      createdAt: Number(item.createdAt) || Date.now(),
                  });
                  if (index % 10 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
              }
          }

          // v2 backups keep favorite voice bytes outside JSON. Rehydrate every marker
          // before DB.importFullData starts, so a missing/truncated file aborts while
          // the current database is still untouched.
          if (zip && Array.isArray(data.assets)) {
              await restoreVoiceMessageBlobs(data.assets, async path => {
                  const entry = zip?.file(path);
                  return entry ? entry.async('uint8array') : null;
              });
          }

          // v3 blob 旁路：令牌原样在 JSON 里，二进制在 blobs/*。readBlobsIndex 先把索引
          // 与文件齐全性验完（此时一个字节没写），再按原令牌 id 写回 blob_assets——令牌
          // 身份保住，JSON 引用零改写、零重编码。中途失败直接中止导入：主数据尚未写库，
          // 已写回的部分只是孤儿 blob，由手动 GC 收口。v2 老包没有索引文件，这里是 no-op。
          if (zip) {
              const blobEntries = await readBlobsIndex(zip as unknown as ZipFileReader);
              if (blobEntries.length > 0) {
                  await restoreBlobsFromZip(
                      zip as unknown as ZipFileReader,
                      blobEntries,
                      restoreBlobRef,
                      {
                          onYield: () => new Promise<void>(r => setTimeout(r, 0)),
                          onProgress: (done, total, id) => {
                              showImportProgress('assets', '正在恢复图片二进制...',
                                  30 + Math.floor((done / Math.max(1, total)) * 5),
                                  { current: `图片二进制 ${done}/${total}`, currentFile: id });
                          },
                      },
                  );
              }
          }

          const hadAssetStoreBackup = data.assets !== undefined;
          const hadCustomIconsBackup = data.customIcons !== undefined;
          const hadAppearancePresetsBackup = data.appearancePresets !== undefined;

          const restoreAssetsInPlace = async (root: any, label = '数据'): Promise<void> => {
              if (!zip) return;

              type Ref = { parent: any; key: string | number; filename: string };
              const refsByFile = new Map<string, Ref[]>();
              const seen = new WeakSet<object>();
              const stack: any[] = [root];
              while (stack.length) {
                  const node = stack.pop();
                  if (node === null || typeof node !== 'object') continue;
                  if (seen.has(node)) continue;
                  seen.add(node);
                  if (Array.isArray(node)) {
                      for (let i = 0; i < node.length; i++) {
                          const v = node[i];
                          if (typeof v === 'string' && v.startsWith('assets/')) {
                              const filename = v.slice('assets/'.length);
                              const refs = refsByFile.get(filename) || [];
                              refs.push({ parent: node, key: i, filename });
                              refsByFile.set(filename, refs);
                          } else if (v && typeof v === 'object') {
                              stack.push(v);
                          }
                      }
                  } else {
                      for (const k in node) {
                          if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
                          const v = node[k];
                          if (typeof v === 'string' && v.startsWith('assets/')) {
                              const filename = v.slice('assets/'.length);
                              const refs = refsByFile.get(filename) || [];
                              refs.push({ parent: node, key: k, filename });
                              refsByFile.set(filename, refs);
                          } else if (v && typeof v === 'object') {
                              stack.push(v);
                          }
                      }
                  }
              }

              const entries = Array.from(refsByFile.entries());
              if (entries.length === 0) return;

              for (const [filename, refs] of entries) {
                  const fileInZip = zip.file(`assets/${filename}`) as (JSZipFileLike & { _data?: { compressedSize?: number; uncompressedSize?: number } }) | null;
                  const hintedSize = fileInZip?._data?.uncompressedSize || fileInZip?._data?.compressedSize;
                  showImportProgress('assets', '正在恢复素材...', 35 + Math.floor((restoredAssetFiles.size / Math.max(1, totalAssetFiles || entries.length)) * 35), {
                      current: label,
                      currentFile: filename,
                      currentFileSize: hintedSize,
                      assetDone: restoredAssetFiles.size,
                      assetTotal: totalAssetFiles || entries.length,
                  });

                  try {
                      if (!fileInZip) {
                          console.warn(`Missing asset in backup: assets/${filename}`);
                          continue;
                      }
                      const base64 = await fileInZip.async("base64");
                      const ext = (filename.split('.').pop() || 'png').toLowerCase();
                      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                          : ext === 'gif' ? 'image/gif'
                          : ext === 'webp' ? 'image/webp'
                          : 'image/png';
                      const dataUri = `data:${mime};base64,${base64}`;
                      for (const ref of refs) {
                          ref.parent[ref.key] = dataUri;
                      }
                      const decodedSize = estimateBase64Bytes(base64);
                      restoredAssetFiles.add(filename);
                      showImportProgress('assets', '正在恢复素材...', 35 + Math.floor((restoredAssetFiles.size / Math.max(1, totalAssetFiles || entries.length)) * 35), {
                          current: label,
                          currentFile: filename,
                          currentFileSize: decodedSize,
                          assetDone: restoredAssetFiles.size,
                          assetTotal: totalAssetFiles || entries.length,
                      });
                  } catch {
                      console.warn(`Failed to restore asset: assets/${filename}`);
                  }
                  await new Promise<void>(resolve => setTimeout(resolve, 0));
              }
          };

          showImportProgress('database', '正在写入数据库...', 50, { current: '准备写入数据库', currentFile: '' });
          await DB.importFullData(data, {
              beforeWrite: restoreAssetsInPlace,
              onProgress: progress => {
                  const sectionRatio = progress.sectionTotal > 0
                      ? progress.sectionDone / progress.sectionTotal
                      : 0;
                  const itemRatio = progress.itemTotal && progress.sectionTotal > 0
                      ? ((progress.itemDone || 0) / progress.itemTotal) / progress.sectionTotal
                      : 0;
                  const dbProgress = 50 + Math.floor(Math.min(1, sectionRatio + itemRatio) * 40);
                  showImportProgress('database', '正在写入数据库...', dbProgress, {
                      current: progress.stage === 'done' ? `${progress.label}完成` : progress.label,
                      currentFile: '',
                      itemDone: progress.itemDone,
                      itemTotal: progress.itemTotal,
                  });
              },
          });

          const hasCollaborationBackup = data.collaborationSessions !== undefined
              || data.collaborationMessages !== undefined
              || data.collaborationCategories !== undefined
              || data.collaborationSettings !== undefined
              || collaborationAssetRecords !== undefined;
          if (hasCollaborationBackup) {
              showImportProgress('database', '正在恢复协同工作...', 91, { current: '协同窗口与文件', currentFile: '' });
              const { CollaborationStore } = await import('../features/collaboration/store');
              await CollaborationStore.importBackup({
                  sessions: data.collaborationSessions,
                  messages: data.collaborationMessages,
                  categories: data.collaborationCategories,
                  settings: data.collaborationSettings,
                  assets: collaborationAssetRecords,
              }, {
                  replaceAssets: data.collaborationBackupMode === 'full',
              });
          }
          
          showImportProgress('settings', '正在恢复系统设置...', 92, { current: '系统设置', currentFile: '' });
          restoreSARLocalBackup(data.sarLocalState, { replaceMissing: replacesPrimaryHistory });
          if (data.theme) {
              await restoreAssetsInPlace(data.theme, '系统主题');
              await updateTheme(data.theme);
          }
          if (data.apiConfig) updateApiConfig(data.apiConfig);
          if (data.checkPhoneApi !== undefined) setCheckPhoneApi(data.checkPhoneApi ?? null);
          if (data.availableModels) saveModels(data.availableModels);
          if (data.apiPresets) savePresets(data.apiPresets);
          if (data.realtimeConfig) updateRealtimeConfig(data.realtimeConfig); // 恢复实时感知配置
          if (data.memoryPalaceConfig) updateMemoryPalaceConfig(data.memoryPalaceConfig); // 恢复记忆宫殿全局配置

          if (data.customIcons !== undefined || data.appearancePresets !== undefined) {
              await restoreAssetsInPlace(data.customIcons, '应用图标');
              await restoreAssetsInPlace(data.appearancePresets, '外观预设');
              const existingAssets = await DB.getAllAssets();
              if (Array.isArray(existingAssets)) {
                  for (const asset of existingAssets) {
                      if (data.customIcons !== undefined && asset.id.startsWith('icon_')) {
                          await DB.deleteAsset(asset.id);
                      }
                      if (data.appearancePresets !== undefined && asset.id.startsWith('appearance_preset_')) {
                          await DB.deleteAsset(asset.id);
                      }
                  }
              }
              if (data.customIcons) {
                  for (const [appId, iconUrl] of Object.entries(data.customIcons)) {
                      const stored = iconUrl.startsWith('data:') ? await migrateDataUrlToRef(iconUrl) : iconUrl;
                      await DB.saveAsset(`icon_${appId}`, stored);
                  }
              }
              if (data.appearancePresets) {
                  const migratedPresets: AppearancePreset[] = [];
                  for (const preset of data.appearancePresets) {
                      const migrated = await migrateAppearancePresetBlobRefs(preset);
                      migratedPresets.push(migrated);
                      await DB.saveAsset(`appearance_preset_${migrated.id}`, JSON.stringify(migrated));
                  }
                  data.appearancePresets = migratedPresets;
              }
          }

          // Restore Study Room settings
          if (data.studyApiConfig) localStorage.setItem('study_api_config', JSON.stringify(data.studyApiConfig));
          if (data.studyTutorPresets) localStorage.setItem('study_tutor_presets', JSON.stringify(data.studyTutorPresets));

          // Restore 云端配置
          if (data.cloudBackupConfig) localStorage.setItem('os_cloud_backup_config', JSON.stringify(data.cloudBackupConfig));
          if (data.remoteVectorConfig) localStorage.setItem('os_remote_vector_config', JSON.stringify(data.remoteVectorConfig));

          // Restore Instant Push
          if (data.instantPushConfig) localStorage.setItem('instant_push_config_v1', JSON.stringify(data.instantPushConfig));
          if (data.pushVapid) localStorage.setItem('push_vapid_v1', JSON.stringify(data.pushVapid));


          // Restore Memory Palace 水位线
          if (data.memoryPalaceHighWaterMarks) {
              for (const [charId, hwm] of Object.entries(data.memoryPalaceHighWaterMarks)) {
                  if (typeof hwm === 'number' && hwm > 0) {
                      localStorage.setItem(`mp_lastMsgId_${charId}`, String(hwm));
                  }
              }
          }

          // Restore Memory Palace UI flags（人格检测已跑过 / 首次 banner 已见等）
          if (data.memoryPalaceFlags && typeof data.memoryPalaceFlags === 'object') {
              for (const [key, val] of Object.entries(data.memoryPalaceFlags)) {
                  if (typeof val === 'string') {
                      // 只允许恢复 mp_ 前缀的键，避免导入数据污染其它 localStorage
                      if (key.startsWith('mp_personality_tried_')
                          || key.startsWith('mp_first_archive_notice_')) {
                          localStorage.setItem(key, val);
                      }
                  }
              }
          }

          // Restore Chat 翻译 / 归档 / 润色设置
          if (typeof data.chatTranslateSourceLang === 'string') localStorage.setItem('chat_translate_source_lang', data.chatTranslateSourceLang);
          if (typeof data.chatTranslateTargetLang === 'string') localStorage.setItem('chat_translate_lang', data.chatTranslateTargetLang);
          if (data.chatTranslateEnabledByChar && typeof data.chatTranslateEnabledByChar === 'object') {
              for (const [charId, enabled] of Object.entries(data.chatTranslateEnabledByChar)) {
                  localStorage.setItem(`chat_translate_enabled_${charId}`, enabled ? 'true' : 'false');
              }
          }
          if (data.chatTranslateExpandedByChar && typeof data.chatTranslateExpandedByChar === 'object') {
              for (const [charId, expanded] of Object.entries(data.chatTranslateExpandedByChar)) {
                  localStorage.setItem(`chat_translate_expanded_${charId}`, expanded ? 'true' : 'false');
              }
          }
          if (data.chatTranslateSourceLangByChar && typeof data.chatTranslateSourceLangByChar === 'object') {
              for (const [charId, lang] of Object.entries(data.chatTranslateSourceLangByChar)) {
                  if (typeof lang === 'string') localStorage.setItem(`chat_translate_source_lang_${charId}`, lang);
              }
          }
          if (data.chatTranslateTargetLangByChar && typeof data.chatTranslateTargetLangByChar === 'object') {
              for (const [charId, lang] of Object.entries(data.chatTranslateTargetLangByChar)) {
                  if (typeof lang === 'string') localStorage.setItem(`chat_translate_lang_${charId}`, lang);
              }
          }
          if (data.chatArchivePrompts !== undefined) localStorage.setItem('chat_archive_prompts', JSON.stringify(data.chatArchivePrompts));
          if (typeof data.chatActiveArchivePromptId === 'string') localStorage.setItem('chat_active_archive_prompt_id', data.chatActiveArchivePromptId);
          if (data.characterRefinePrompts !== undefined) localStorage.setItem('character_refine_prompts', JSON.stringify(data.characterRefinePrompts));
          if (typeof data.characterActiveRefinePromptId === 'string') localStorage.setItem('character_active_refine_prompt_id', data.characterActiveRefinePromptId);

          // Restore UI / 偏好
          if (typeof data.scheduleAppTheme === 'string') localStorage.setItem('schedule_app_theme', data.scheduleAppTheme);
          if (typeof data.handbookLifestreamDepth === 'string') localStorage.setItem('handbook_lifestream_depth', data.handbookLifestreamDepth);
          if (typeof data.groupchatContextLimit === 'number') localStorage.setItem('groupchat_context_limit', String(data.groupchatContextLimit));
          if (data.browserConfig && typeof data.browserConfig === 'object') {
              if (typeof data.browserConfig.braveKey === 'string') localStorage.setItem('browser_brave_key', data.browserConfig.braveKey);
              if (typeof data.browserConfig.useRealSearch === 'boolean') localStorage.setItem('browser_use_real_search', data.browserConfig.useRealSearch ? 'true' : 'false');
          }
          if (typeof data.bm25Mode === 'string') localStorage.setItem('bm25_mode', data.bm25Mode);
          if (typeof data.lastActiveCharId === 'string') localStorage.setItem('os_last_active_char_id', data.lastActiveCharId);
          restoreStoryTheaterAppearanceSetting(data.storyTheaterAppearance);
          if (data.dreamCollection && typeof data.dreamCollection === 'object') localStorage.setItem('os_dream_collection', JSON.stringify(data.dreamCollection));
          if (typeof data.gotchiAccentHue === 'string' && /^\d+$/.test(data.gotchiAccentHue)) localStorage.setItem('tama_accent_hue', data.gotchiAccentHue);
          if (data.eventNotifFlags && typeof data.eventNotifFlags === 'object') {
              for (const [key, val] of Object.entries(data.eventNotifFlags)) {
                  // 只允许 sullyos_ 前缀，避免污染其它键
                  if (typeof val === 'string' && key.startsWith('sullyos_')) {
                      localStorage.setItem(key, val);
                  }
              }
          }
          
          if (data.socialAppData) {
              await restoreAssetsInPlace(data.socialAppData, '动态设置');
              if (data.socialAppData.charHandles) localStorage.setItem('spark_char_handles', JSON.stringify(data.socialAppData.charHandles));
              if (data.socialAppData.userId) localStorage.setItem('spark_user_id', data.socialAppData.userId);
              
              // Restore heavy assets to DB
              if (data.socialAppData.userProfile) await DB.saveAsset('spark_social_profile', JSON.stringify(data.socialAppData.userProfile));
              if (data.socialAppData.userBg) await DB.saveAsset('spark_user_bg', data.socialAppData.userBg);
          }
          
          // Restore Room Custom Assets to DB (migrate old format on import)
          if (data.roomCustomAssets) {
              await restoreAssetsInPlace(data.roomCustomAssets, '房间自定义素材');
              const migratedAssets = data.roomCustomAssets.map((a: any) => ({
                  ...a,
                  id: a.id || `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                  visibility: a.visibility || 'public',
              }));
              await DB.saveAsset('room_custom_assets_list', JSON.stringify(migratedAssets));
          }

          const chars = await DB.getAllCharacters();
          const groupsList = await DB.getGroups();
          const themes = await DB.getThemes();
          const user = await DB.getUserProfile();
          const books = await DB.getAllWorldbooks();
          const novelList = await DB.getAllNovels();
          const songList = await DB.getAllSongs();
          
          if (hadAssetStoreBackup || hadCustomIconsBackup || hadAppearancePresetsBackup) {
              const assets = await DB.getAllAssets();
              const loadedIcons: Record<string, string> = {};
              const loadedPresets: AppearancePreset[] = [];
              if (Array.isArray(assets)) {
                  for (const a of assets) {
                      if (a.id.startsWith('icon_')) {
                          const stored = a.data.startsWith('data:') ? await migrateDataUrlToRef(a.data) : a.data;
                          loadedIcons[a.id.replace('icon_', '')] = stored;
                          if (stored !== a.data) await DB.saveAsset(a.id, stored);
                      }
                      if (a.id.startsWith('appearance_preset_')) {
                          try {
                              loadedPresets.push(JSON.parse(a.data));
                          } catch {}
                      }
                  }
              }
              setCustomIcons(loadedIcons);
              loadedPresets.sort((a, b) => b.createdAt - a.createdAt);
              setAppearancePresets(loadedPresets);
          }

          // 导入后的角色清单（下面主动消息 2.0 对账要用规范化之后的那份）
          let importedChars = chars;
          if (chars.length > 0) {
              let importedAutoContextCount = 0;
              let importedContextMigrated = false;
              const normalizedChars = chars.map(c => {
                  const normalized = normalizeCharacterDefaults(normalizeCharacterImpression(c));
                  const migration = migrateCharacterContextRange(normalized);
                  if (migration.migrated) importedContextMigrated = true;
                  if (migration.resetAutoContext) importedAutoContextCount++;
                  return migration.character;
              });
              if (importedContextMigrated) {
                  await Promise.all(normalizedChars.map(c => DB.saveCharacter(c)));
              }
              setCharacters(normalizedChars);
              importedChars = normalizedChars;
              if (importedAutoContextCount > 0) {
                  setTimeout(() => addToast(
                      `导入的旧设置已升级：${importedAutoContextCount} 个全自动记忆角色已使用自适应上下文。`,
                      'info',
                  ), 600);
              }
          }
          if (groupsList.length > 0) setGroups(groupsList);
          if (themes.length > 0) setCustomThemes(themes);
          if (user) setUserProfile(user);
          if (books.length > 0) setWorldbooks(books);
          if (novelList.length > 0) setNovels(novelList);
          if (songList.length > 0) setSongs(songList);

          // ─── 主动消息 2.0：导入后跟云端对一次账 ───
          // 导入换掉了整套角色，worker 那边却还停在导入前：旧档角色的远端任务变成无主任务
          // 到点照样推送，新档角色的 fire_pack 和工具凭据则停格在导入前那一刻。
          // 整段 best-effort：这是恢复流程的收尾，云端够不着不该让已经写好的本地数据回滚。
          try {
              const amsgWorkerUrl = (await ActiveMsgStore.getGlobalConfig()).workerUrl?.trim();
              if (amsgWorkerUrl) {
                  const knownCharIds = new Set(importedChars.map(c => c.id));
                  const remoteTasks = await ActiveMsgClient.listAllTasks();
                  for (const task of remoteTasks) {
                      if (typeof task?.uuid !== 'string') continue;
                      const owner = typeof task?.charId === 'string' ? task.charId : '';
                      if (owner && knownCharIds.has(owner)) continue;
                      // 「导入即放弃旧数据」：这条任务的主人在新档里已经不存在了（连主人是谁
                      // 都没投影出来的同理），它正属于该一起放弃的部分，取消就是对的。
                      await ActiveMsgClient.cancelTask(task.uuid).catch(() => {});
                  }
                  // 留下来的角色逐个刷云端快照，同时把导入进来的实时感知凭据传上去。
                  // 走同一个入口：云端提示词是按凭据裁过的，两者必须同进同退。
                  // 有 AI 任务的角色才会真的上传（门在 markAmsgStateDirty 里）。
                  syncAmsgToolConfigAndPrompts(
                      data.realtimeConfig || realtimeConfig,
                      { characters: importedChars, userProfile: user || userProfile, groups: groupsList },
                  );
              }
          } catch (e) {
              console.warn('[amsg2] 导入后云端对账失败（本地数据已恢复，不受影响）', e);
          }

          setSysOperation({ status: 'idle', message: '', progress: 100 });
          clearImportInProgress();
          addToast('恢复成功，系统即将重启...', 'success');
          setTimeout(() => window.location.reload(), 1500);

      } catch (e: any) {
          console.error("Import Error:", e);
          setSysOperation({ status: 'idle', message: '', progress: 0 });
          const msg = e instanceof SyntaxError ? 'JSON 格式错误' : (e.message || '未知错误');
          markImportInProgress('error', sourceName, {
              sourceSize,
              current: lastCurrent,
              currentFile: lastCurrentFile,
              currentFileSize: lastCurrentFileSize,
              assetDone: restoredAssetFiles.size,
              assetTotal: totalAssetFiles || undefined,
              error: msg,
          });
          throw new Error(`恢复失败: ${msg}`);
      }
  };

  const resetSystem = async () => { try { await DB.deleteDB(); localStorage.clear(); window.location.reload(); } catch (e) { console.error(e); addToast('重置失败，请手动清除浏览器数据', 'error'); } };
  const openApp = (appId: AppID) => setActiveApp(appId);
  const closeApp = () => setActiveApp(AppID.Launcher);
  // 从聊天直接进入某角色的见面：切换当前角色 + 标记自动进入 + 打开见面 App
  const openDateWithChar = (charId: string) => {
    setActiveCharacterId(charId);
    setDateAutoStartCharId(charId);
    setActiveApp(AppID.Date);
  };
  const consumeDateAutoStart = () => setDateAutoStartCharId(null);
  const unlock = () => setIsLocked(false);

  const suspendCall = (info: { charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string; pendingAvatarTouches?: AvatarTouchRecord[] }) => {
    setSuspendedCall(info);
    setActiveApp(AppID.Launcher);
  };
  const resumeCall = () => {
    setActiveApp(AppID.Call);
  };
  const clearSuspendedCall = () => {
    setSuspendedCall(null);
  };

  // --- Back Handler Logic ---
  const registerBackHandler = useCallback((handler: () => boolean) => {
      backHandlerRef.current = handler;
      return () => {
          if (backHandlerRef.current === handler) {
              backHandlerRef.current = null;
          }
      };
  }, []);

  const handleBack = useCallback(() => {
      if (backHandlerRef.current) {
          const handled = backHandlerRef.current();
          if (handled) return;
      }
      // Default: Close App
      if (activeApp !== AppID.Launcher) {
          closeApp();
      }
  }, [activeApp, closeApp]);

  const value: OSContextType = {
    activeApp,
    openApp,
    closeApp,
    theme,
    updateTheme,
    virtualTime,
    apiConfig,
    updateApiConfig,
    isLocked,
    unlock,
    isDataLoaded,
    characters,
    activeCharacterId,
    addCharacter,
    updateCharacter,
    deleteCharacter,
    setActiveCharacterId,
    characterGroups,
    createCharacterGroup,
    renameCharacterGroup,
    deleteCharacterGroup,
    worldbooks,
    addWorldbook,
    updateWorldbook,
    deleteWorldbook,
    novels,
    addNovel,
    updateNovel,
    deleteNovel,
    songs,
    addSong,
    updateSong,
    deleteSong,
    groups,
    createGroup,
    updateGroup,
    deleteGroup,
    userProfile,
    updateUserProfile,
    availableModels,
    setAvailableModels,
    apiPresets,
    addApiPreset,
    updateApiPreset,
    removeApiPreset,
    realtimeConfig,
    updateRealtimeConfig,
    memoryPalaceConfig,
    updateMemoryPalaceConfig,
    syncEmotionApiToAllCharacters,
    remoteVectorConfig,
    updateRemoteVectorConfig,
    customThemes,
    addCustomTheme,
    removeCustomTheme,
    appearancePresets,
    saveAppearancePreset,
    applyAppearancePreset,
    deleteAppearancePreset,
    renameAppearancePreset,
    exportAppearancePreset,
    importAppearancePreset,
    toasts,
    addToast,
    errorDialog,
    showError,
    dismissError,
    customIcons,
    setCustomIcon,
    resetAppearance,
    lastMsgTimestamp,
    unreadMessages,
    clearUnread,
    proactiveComposingChars,
    cloudBackupConfig,
    updateCloudBackupConfig,
    cloudBackupToWebDAV,
    cloudRestoreFromWebDAV,
    listCloudBackups,
    exportSystem,
    importSystem,
    resetSystem,
    sysOperation,
    systemLogs,
    clearLogs,
    registerBackHandler,
    handleBack,
    suspendedCall,
    suspendCall,
    resumeCall,
    clearSuspendedCall,
    dateAutoStartCharId,
    openDateWithChar,
    consumeDateAutoStart
  };

  return (
    <OSContext.Provider value={value}>
      {children}
    </OSContext.Provider>
  );
};

export const useOS = () => {
  const context = useContext(OSContext);
  if (context === undefined) {
    throw new Error('useOS must be used within an OSProvider');
  }
  return context;
};
