
import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { APIConfig, AppID, OSTheme, VirtualTime, CharacterProfile, ChatTheme, Toast, FullBackupData, UserProfile, ApiPreset, GroupProfile, SystemLog, Worldbook, NovelBook, SongSheet, Message, RealtimeConfig, AppearancePreset, CloudBackupConfig, CloudBackupFile } from '../types';
import { DB } from '../utils/db';
import { ProactiveChat } from '../utils/proactiveChat';
import { VRScheduler } from '../utils/vrWorld/scheduler';
import { runVRSession } from '../utils/vrWorld/runSession';
import { VR_DEFAULT_INTERVAL_MIN } from '../utils/vrWorld/constants';
import { ChatParser } from '../utils/chatParser';
import { safeFetchJson } from '../utils/safeApi';
import { recordApiCall, setApiCallAmbientContext } from '../utils/apiCallLog';
import { INSTALLED_APPS } from '../constants';
import { normalizeCharacterImpression, normalizeCharacterDefaults } from '../utils/impression';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { evaluateEmotionBackground } from '../hooks/useChatAI';
import { buildChatRequestPayload } from '../utils/chatRequestPayload';
import { extractHtmlBlocks } from '../utils/htmlPrompt';
import { loadMusicPlaybackSnapshot } from './MusicContext';
import { setMinimaxRegion } from '../utils/minimaxEndpoint';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { formatBytes } from '../utils/format';
import { isEmotionEvalSkipped } from '../utils/devDebug';

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
  async: (type: 'string' | 'base64') => Promise<string>;
};

type JSZipLike = {
  folder: (name: string) => { file: (name: string, data: string, options?: { base64?: boolean }) => void } | null;
  file: {
    (name: string): JSZipFileLike | null;
    (name: string, data: string, options?: { base64?: boolean }): void;
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
}

const defaultMemoryPalaceConfig: MemoryPalaceGlobalConfig = {
  embedding: { baseUrl: '', apiKey: '', model: 'BAAI/bge-m3', dimensions: 1024 },
  lightLLM: { baseUrl: '', apiKey: '', model: '' },
  rerank: { enabled: false, baseUrl: '', apiKey: '', model: 'BAAI/bge-reranker-v2-m3', topN: 5 },
};

interface OSContextType {
  activeApp: AppID;
  openApp: (appId: AppID) => void;
  closeApp: () => void;
  theme: OSTheme;
  updateTheme: (updates: Partial<OSTheme>) => void;
  virtualTime: VirtualTime;
  apiConfig: APIConfig;
  updateApiConfig: (updates: Partial<APIConfig>) => void;
  isLocked: boolean;
  unlock: () => void;
  isDataLoaded: boolean;
  
  characters: CharacterProfile[];
  activeCharacterId: string;
  addCharacter: () => void;
  updateCharacter: (id: string, updates: Partial<CharacterProfile>) => void;
  deleteCharacter: (id: string) => void;
  setActiveCharacterId: (id: string) => void;
  
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
  deleteGroup: (id: string) => void;

  // User Profile
  userProfile: UserProfile;
  updateUserProfile: (updates: Partial<UserProfile>) => void;

  availableModels: string[];
  setAvailableModels: (models: string[]) => void;
  
  // API Presets
  apiPresets: ApiPreset[];
  addApiPreset: (name: string, config: APIConfig) => void;
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
  saveAppearancePreset: (name: string) => void;
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
  setCustomIcon: (appId: string, iconUrl: string | undefined) => void;

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
  suspendedCall: { charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string } | null;
  suspendCall: (info: { charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string }) => void;
  resumeCall: () => void;
  clearSuspendedCall: () => void;
}

export const DEFAULT_WALLPAPER = 'linear-gradient(135deg, #FFDEE9 0%, #B5FFFC 100%)';

const defaultTheme: OSTheme = {
  hue: 245, // Default Indigo-ish
  saturation: 25,
  lightness: 65,
  wallpaper: DEFAULT_WALLPAPER,
  darkMode: false,
  contentColor: '#ffffff', // Default white text
};

const defaultApiConfig: APIConfig = {
  baseUrl: '',
  apiKey: '',
  minimaxApiKey: '',
  minimaxGroupId: '',
  minimaxRegion: 'domestic',
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
  avatar: 'https://sharkpan.xyz/f/BZ3VSa/head.png',
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
      'normal': 'https://sharkpan.xyz/f/w3QQFq/01.png',
      'happy': 'https://sharkpan.xyz/f/MKg7ta/02.png',
      'sad': 'https://sharkpan.xyz/f/3WnMce/03.png',
      'angry': 'https://sharkpan.xyz/f/5n1xSj/04.png',
      'shy': 'https://sharkpan.xyz/f/kdwet6/05.png',
      'chibi': 'https://sharkpan.xyz/f/oWZQF4/S2.png' // Default Room Sprite (家园 Sully chibi)
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
              'normal': 'https://sharkpan.xyz/f/4rzdtj/VNormal.png',
              'happy':  'https://sharkpan.xyz/f/m3adhW/Vha.png',
              'sad':    'https://sharkpan.xyz/f/BZgDfa/Vsad.png',
              'angry':  'https://sharkpan.xyz/f/NdlVfv/VAn.png',
              'shy':    'https://sharkpan.xyz/f/VyontY/Vshy.png',
              'love':   'https://sharkpan.xyz/f/xl8muX/VBl.png',
          }
      }
  ],

  // Default theme settings
  bubbleStyle: 'default', // Or specific theme ID if we had one
  contextLimit: 1000,
  
  // Default Room Config
  roomConfig: {
      wallImage: 'https://sharkpan.xyz/f/NdJyhv/b.png', // Updated Background
      floorImage: 'repeating-linear-gradient(90deg, #e7e5e4 0px, #e7e5e4 20px, #d6d3d1 21px)',
      items: [
        {
            id: "item-1768927221380",
            name: "Sully床",
            type: "furniture",
            image: "https://sharkpan.xyz/f/A3XeUZ/BED.png",
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
            image: "https://sharkpan.xyz/f/G5n3Ul/DNZ.png",
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
            image: "https://sharkpan.xyz/f/75Nvsj/LJT.png",
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
            image: "https://sharkpan.xyz/f/85K5ij/DDB.png",
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
            image: "https://sharkpan.xyz/f/zlpWS5/SG.png",
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

const OSContext = createContext<OSContextType | undefined>(undefined);

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
  const [worldbooks, setWorldbooks] = useState<Worldbook[]>([]); 
  const [novels, setNovels] = useState<NovelBook[]>([]); // New
  const [songs, setSongs] = useState<SongSheet[]>([]);

  const [userProfile, setUserProfile] = useState<UserProfile>(defaultUserProfile);
  
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [apiPresets, setApiPresets] = useState<ApiPreset[]>([]);
  const [realtimeConfig, setRealtimeConfig] = useState<RealtimeConfig>(defaultRealtimeConfig);
  const [memoryPalaceConfig, setMemoryPalaceConfig] = useState<MemoryPalaceGlobalConfig>(() => {
    try { const s = localStorage.getItem('os_memory_palace_config'); return s ? { ...defaultMemoryPalaceConfig, ...JSON.parse(s) } : defaultMemoryPalaceConfig; } catch { return defaultMemoryPalaceConfig; }
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
  const [suspendedCall, setSuspendedCall] = useState<{ charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string } | null>(null);

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

  // --- Global Error Interception ---
  useEffect(() => {
      if (interceptorsInitialized.current) return;
      interceptorsInitialized.current = true;

      // 1. Monkey Patch Fetch
      const originalFetch = window.fetch;
      const patchedFetch = async (...args: [RequestInfo | URL, RequestInit?]) => {
          const [resource, config] = args;
          
          const urlStr = String(resource);
          
          try {
              const response = await originalFetch(...args);

              // 「API 调用记录」统一记录入口：所有 /chat/completions（裸 fetch + safeFetchJson
              // 内部 fetch 都会经过这里）都记一笔。meta 优先取调用方挂在 init 上的 __sullyMeta
              // （safeFetchJson 传的精确信息），裸 fetch 没有就由 recordApiCall 用环境兜底。
              if (urlStr.includes('/chat/completions')) {
                  const meta = (config as any)?.__sullyMeta;
                  const body = (config as any)?.body;
                  const status = response.status;
                  const ok = response.ok;
                  // clone 出来异步读 usage，不阻塞调用方拿 response
                  let usageClone: Response | null = null;
                  try { usageClone = response.clone(); } catch { usageClone = null; }
                  if (usageClone) {
                      usageClone.text().then((t) => {
                          let parsed: any = undefined;
                          try { parsed = JSON.parse(t); } catch { /* 流式/非 JSON：无 usage，照样记 */ }
                          recordApiCall({ url: urlStr, body, status, ok, response: parsed, meta });
                      }).catch(() => recordApiCall({ url: urlStr, body, status, ok, meta }));
                  } else {
                      recordApiCall({ url: urlStr, body, status, ok, meta });
                  }
              }

              if (!response.ok) {
                  // Only log if it's likely an API call (contains chat/completions or models)
                  if (urlStr.includes('/chat/completions') || urlStr.includes('/models')) {
                      try {
                          const clone = response.clone();
                          const text = await clone.text();
                          setSystemLogs(prev => [{
                              id: `log-${Date.now()}`,
                              timestamp: Date.now(),
                              type: 'network',
                              source: 'API Request',
                              message: `HTTP ${response.status} Error`,
                              detail: `URL: ${urlStr}\nResponse: ${text.substring(0, 500)}`
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
                  recordApiCall({ url: urlStr, body: (config as any)?.body, ok: false, meta: (config as any)?.__sullyMeta });
              }
              setSystemLogs(prev => [{
                  id: `log-${Date.now()}`,
                  timestamp: Date.now(),
                  type: 'network',
                  source: 'Network',
                  message: err.message || 'Fetch Failed',
                  detail: `URL: ${urlStr}`
              }, ...prev.slice(0, 49)]);
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
          originalConsoleError(...args);
          const msg = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
          const detail = args.map(a => (a instanceof Error ? a.stack : '')).join('\n');
          if (msg.includes('Warning:')) return;
          setSystemLogs(prev => [{
              id: `log-${Date.now()}-${Math.random()}`,
              timestamp: Date.now(),
              type: 'error',
              source: 'Application',
              message: msg.substring(0, 100),
              detail: detail || msg
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
                 // Strip the legacy Unsplash hard-coded wallpaper, keep user-imported http(s) URLs
                 if (
                     loadedTheme.wallpaper.includes('unsplash') ||
                     loadedTheme.wallpaper === ''
                 ) {
                     loadedTheme.wallpaper = DEFAULT_WALLPAPER;
                 }
                 if (loadedTheme.wallpaper.startsWith('data:')) {
                     loadedTheme.wallpaper = defaultTheme.wallpaper;
                 }
                 // Deprecated legacy fields are forcibly stripped — they never render again.
                 loadedTheme.launcherWidgetImage = undefined;
                 // Reset font too if it's data URI
                 if (loadedTheme.customFont && loadedTheme.customFont.startsWith('data:')) {
                     loadedTheme.customFont = undefined;
                 }
             } catch(e) { console.error('Theme load error', e); }
        }
        
        if (savedApi) setApiConfig(JSON.parse(savedApi));
        if (savedModels) setAvailableModels(JSON.parse(savedModels));
        if (savedPresets) setApiPresets(JSON.parse(savedPresets));

        // 加载实时配置
        const savedRealtimeConfig = localStorage.getItem('os_realtime_config');
        if (savedRealtimeConfig) {
            try {
                setRealtimeConfig({ ...defaultRealtimeConfig, ...JSON.parse(savedRealtimeConfig) });
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
                    loadedTheme.wallpaper = assetMap['wallpaper'];
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
                Object.keys(assetMap).forEach(key => {
                    if (key.startsWith('icon_')) {
                        const appId = key.replace('icon_', '');
                        loadedIcons[appId] = assetMap[key];
                    }
                    if (key.startsWith('widget_')) {
                        const slot = key.replace('widget_', '');
                        if (DEPRECATED_WIDGET_SLOTS.has(slot)) {
                            void DB.deleteAsset(key);
                            return;
                        }
                        loadedWidgets[slot] = assetMap[key];
                    }
                });
                setCustomIcons(loadedIcons);
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

        await loadSettings();

        const [dbChars, dbThemes, dbUser, dbGroups, dbWorldbooks, dbNovels, dbSongs] = await Promise.all([
            DB.getAllCharacters(),
            DB.getThemes(),
            DB.getUserProfile(),
            DB.getGroups(),
            DB.getAllWorldbooks(),
            DB.getAllNovels(),
            DB.getAllSongs()
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
                 // 之前误把家园 chibi 替换成了像素小屋的像素立绘 → 还原为原版 sharkpan 立绘
                 const hasMisplacedPixelChibi = typeof currentSprites['chibi'] === 'string'
                     && currentSprites['chibi'].startsWith('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADUAAAA4CAYAAABdeLCu');

                 if (isCorrupted || !existingSully.roomConfig || needsWallUpdate || needsSkinSets || hasMisplacedPixelChibi) {
                     const restoredSprites = { ...sullyV2.sprites, ...currentSprites };

                     if (!restoredSprites['normal']) restoredSprites['normal'] = sullyV2.sprites!['normal'];
                     if (!restoredSprites['happy']) restoredSprites['happy'] = sullyV2.sprites!['happy'];
                     if (!restoredSprites['sad']) restoredSprites['sad'] = sullyV2.sprites!['sad'];
                     if (!restoredSprites['angry']) restoredSprites['angry'] = sullyV2.sprites!['angry'];
                     if (!restoredSprites['shy']) restoredSprites['shy'] = sullyV2.sprites!['shy'];
                     if (!restoredSprites['chibi']) restoredSprites['chibi'] = sullyV2.sprites!['chibi'];
                     if (hasMisplacedPixelChibi) restoredSprites['chibi'] = sullyV2.sprites!['chibi'];

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
                         sprites: restoredSprites,
                         roomConfig: updatedRoomConfig,
                         dateSkinSets: mergedSkins
                     };
                     
                     await DB.saveCharacter(updatedSully);
                     finalChars = finalChars.map(c => c.id === sullyV2.id ? updatedSully : c);
                 }
            }
        }

        finalChars = finalChars.map(c => normalizeCharacterDefaults(normalizeCharacterImpression(c)));

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
        setWorldbooks(dbWorldbooks);
        setNovels(dbNovels);
        setSongs(dbSongs);
        setCustomThemes(dbThemes);
        if (dbUser) setUserProfile(dbUser);

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
  }, [theme]);

  // --- Update: Handle Scheduled Messages with Unread Flags & Web Notifications ---
  // Refs to avoid stale closures in the scheduled message interval
  const activeAppRef = useRef(activeApp);
  const activeCharIdScheduleRef = useRef(activeCharacterId);
  activeAppRef.current = activeApp;
  activeCharIdScheduleRef.current = activeCharacterId;

  useEffect(() => {
      if (!isDataLoaded || characters.length === 0) return;
      let cancelled = false;
      const checkAllSchedules = async () => {
          if (cancelled) return;
          let hasNewMessage = false;
          const unreadUpdates: Record<string, number> = {};

          for (const char of characters) {
              try {
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
                                  const notif = new Notification(char.name, {
                                      body: dueMessages[0].content,
                                      icon: char.avatar,
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
                  navigator.serviceWorker.ready.then(reg => {
                      reg.showNotification(charName, {
                          body: preview,
                          icon: char?.avatar || './icons/icon-192.png',
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
          if (Array.isArray(detail.buffs)) {
              const nextBuffs = detail.buffs as CharacterProfile['activeBuffs'];
              const nextInjection = typeof detail.buffInjection === 'string' ? detail.buffInjection : '';
              setCharacters(prev => prev.map(c => c.id === charId
                  ? normalizeCharacterImpression({ ...c, activeBuffs: nextBuffs, buffInjection: nextInjection })
                  : c));
              return;
          }
          // 无 buffs 的纯刷新信号 (runPushTailPipeline 等): 从 DB 兜底重读该角色 buff.
          DB.getAllCharacters().then(all => {
              const updated = all.find(c => c.id === charId);
              if (!updated) return;
              setCharacters(prev => prev.map(c => c.id === charId
                  ? normalizeCharacterImpression({ ...c, activeBuffs: updated.activeBuffs, buffInjection: updated.buffInjection })
                  : c));
          }).catch(() => {});
      };

      window.addEventListener('active-msg-received', handler);
      window.addEventListener('active-msg-progress', progressHandler);
      window.addEventListener('active-msg-open', openHandler);
      window.addEventListener('emotion-updated', buffSyncHandler);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
          window.removeEventListener('active-msg-received', handler);
          window.removeEventListener('active-msg-progress', progressHandler);
          window.removeEventListener('active-msg-open', openHandler);
          window.removeEventListener('emotion-updated', buffSyncHandler);
          document.removeEventListener('visibilitychange', onVisible);
      };
  }, [sendProactiveNativeNotification]);

  const proactiveRunningRef = useRef(false);
  const proactiveQueueRef = useRef<string[]>([]);
  // Per-character innerState cache for proactive turns — mirrors useChatAI's
  // evolvedNarrative state so consecutive proactive triggers carry continuity.
  const proactiveInnerStateRef = useRef<Map<string, string>>(new Map());

  // Refs to avoid stale closures in proactive callback
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const apiConfigRef = useRef(apiConfig);
  apiConfigRef.current = apiConfig;

  // Keep the MiniMax endpoint module in sync with the user's region choice
  // so every minimaxFetch() call reads the latest preference.
  useEffect(() => {
    setMinimaxRegion(apiConfig.minimaxRegion);
  }, [apiConfig.minimaxRegion]);
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
          const nextQueuedCharId = proactiveQueueRef.current.shift();
          if (nextQueuedCharId) {
              void runProactive(nextQueuedCharId);
          }
      };

      const runProactive = async (charId: string) => {
          if (proactiveRunningRef.current) {
              if (!proactiveQueueRef.current.includes(charId)) {
                  proactiveQueueRef.current.push(charId);
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

          // Respect per-character proactive config
          if (char.proactiveConfig && !char.proactiveConfig.enabled) {
              drainQueuedProactive();
              console.log(`🔕 [Proactive/Global] Skipped for ${char.name}: disabled`);
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
              await DB.saveMessage({
                  charId,
                  role: 'user',
                  type: 'text',
                  content: `[系统提示（非${userName}发言）: 现在是 ${timeStr}。${timeSinceUser ? `${userName}已经 ${timeSinceUser} 没有找你说话了。` : ''}这是系统给你的一次主动发消息机会——${userName}并没有在跟你说话，是你想主动找${userName}。像真人一样随意地发条消息吧，比如：随手拍了张照片想分享、刚看到个有趣的事想说、突然想到个冷知识、吐槽今天的天气/食物/见闻、或者就是单纯想找${userName}聊几句。不要刻意，不要像在"汇报近况"，就像你真的拿起手机随手发了条消息。一两句话就好。${timeSinceUser && parseInt(timeSinceUser) > 2 ? `（${userName}挺久没找你了，你也可以表达想念、好奇${userName}在干嘛、或者小小地抱怨一下。）` : ''}]`,
                  metadata: { proactiveHint: true, hidden: true }
              });

              // 3. Build prompt & message history — 走和 useChatAI / emotion eval 同一个 helper，
              //    保证三家拿到的"材料"完全一致；区别只在前面追加的"现在主动找用户"那条 hint。
              const allMsgs = await DB.getRecentMessagesByCharId(charId, char.contextLimit || 500);
              const emojis = await DB.getEmojis();
              const categories = await DB.getEmojiCategories();

              // 上一轮缓存的意识流独白 —— 主路径用 React state，主动消息这里用 ref Map
              const cachedInnerState = proactiveInnerStateRef.current.get(charId) || undefined;

              const payload = await buildChatRequestPayload({
                  char, userProfile: currentUserProfile!, groups: currentGroups,
                  emojis, categories,
                  historyMsgs: allMsgs,
                  contextLimit: char.contextLimit || 500,
                  realtimeConfig: currentRealtimeConfig,
                  innerState: cachedInnerState,
                  // 实时音乐播放状态 —— OSContext 在 MusicProvider 上层用不了 useMusic()，
                  // 走 MusicContext 暴露的模块级快照（Provider mount 后会持续写入）
                  musicSnapshot: loadMusicPlaybackSnapshot(),
                  // translationConfig / mcdMiniSnap 是 chat-app 会话级 UI 状态，主动消息触发时
                  // 不存在；保持 undefined 即可，与"用户当时根本没在 chat 界面"的语义一致
                  htmlMode: { enabled: !!(char as any).htmlModeEnabled, customPrompt: (char as any).htmlModeCustomPrompt },
                  thinkingChain: { enabled: !!(char as any).showThinkingChain, customPrompt: (char as any).thinkingChainCustomPrompt },
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
                      // 表情独立抽出,放在文本之后发送
                      const bilingualEmojis: string[] = [];
                      let bEm;
                      const bEmojiPat = /\[\[SEND_EMOJI:\s*(.*?)\]\]/g;
                      while ((bEm = bEmojiPat.exec(aiContent)) !== null) {
                          const name = bEm[1].trim();
                          if (!bilingualEmojis.includes(name)) bilingualEmojis.push(name);
                      }
                      aiContent = aiContent.replace(/\[\[SEND_EMOJI:\s*.*?\]\]/g, '').trim();

                      const tagPattern = /<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>([\s\S]*?)<\/译文>\s*<\/翻译>/g;
                      let lastIndex = 0;
                      let tagMatch;
                      while ((tagMatch = tagPattern.exec(aiContent)) !== null) {
                          const textBefore = aiContent.slice(lastIndex, tagMatch.index).trim();
                          if (textBefore) {
                              const cleaned = ChatParser.sanitize(textBefore);
                              if (cleaned && ChatParser.hasDisplayContent(cleaned)) {
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
                          }

                          const originalText = ChatParser.sanitize(tagMatch[1].trim());
                          const translatedText = ChatParser.sanitize(tagMatch[2].trim());
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

                          lastIndex = tagMatch.index + tagMatch[0].length;
                      }

                      const textAfter = aiContent.slice(lastIndex).trim();
                      if (textAfter) {
                          const cleaned = ChatParser.sanitize(textAfter.replace(/<\/?翻译>|<\/?原文>|<\/?译文>/g, '').trim());
                          if (cleaned && ChatParser.hasDisplayContent(cleaned)) {
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
                      }

                      for (const emojiName of bilingualEmojis) {
                          const foundEmoji = emojis.find(e => e.name === emojiName);
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
                              offset += 1;
                          }
                      }
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
                  const preview = previewSource.replace(/\s+/g, ' ').trim().slice(0, 120) || `${char.name} sent a proactive message`;

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
      const runVR = async (charId: string, room?: string, letterId?: string) => {
          const char = charactersRef.current.find(c => c.id === charId);
          if (!char || !char.vrState?.enabled) return;
          if (!userProfileRef.current) return;
          try {
              await runVRSession({
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
              });
          } catch (e) {
              console.error('[VRWorld] runVR error', e);
          }
      };
      VRScheduler.onTrigger((charId: string, room?: string, letterId?: string) => { void runVR(charId, room, letterId); });

      // 以角色 vrState 为准对账调度表：调度表存 localStorage、不随备份迁移，
      // 导入备份后角色虽 enabled 但调度表为空，这里补建/清理使其按时触发。
      VRScheduler.reconcile(
          charactersRef.current
              .filter(c => c.vrState?.enabled)
              .map(c => ({ charId: c.id, intervalMinutes: c.vrState?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN }))
      );

      return () => {
          // Cleanup: detach proactive listeners when OSContext unmounts (unlikely but safe)
          ProactiveChat.onTrigger(() => {});
          VRScheduler.onTrigger(() => {});
      };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDataLoaded]);

  const updateTheme = async (updates: Partial<OSTheme>) => {
    const { wallpaper, launcherWidgetImage, launcherWidgets, desktopDecorations, customFont, ...styleUpdates } = updates;
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
    setTheme(newTheme);

    // Persist large assets to IndexedDB
    if (wallpaper !== undefined) {
        if (wallpaper && wallpaper.startsWith('data:')) {
            await DB.saveAsset('wallpaper', wallpaper);
        } else {
            await DB.deleteAsset('wallpaper');
        }
    }

    // Legacy single-image asset is permanently banned — always delete, never save.
    await DB.deleteAsset('launcherWidgetImage');

    // Save widget images to IndexedDB (each slot is a separate asset)
    if (launcherWidgets !== undefined) {
        const slots = ['tl', 'tr', 'wide', 'dsq'];
        for (const slot of slots) {
            const val = sanitizedWidgets?.[slot];
            if (val && val.startsWith('data:')) {
                await DB.saveAsset(`widget_${slot}`, val);
            } else if (!val) {
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

    // Save lightweight settings to LocalStorage (strip data URIs)
    const lsTheme = { ...newTheme };
    if (lsTheme.wallpaper && lsTheme.wallpaper.startsWith('data:')) lsTheme.wallpaper = '';
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

    localStorage.setItem('os_theme', JSON.stringify(lsTheme));
  };
  const updateApiConfig = (updates: Partial<APIConfig>) => { const newConfig = { ...apiConfig, ...updates }; setApiConfig(newConfig); localStorage.setItem('os_api_config', JSON.stringify(newConfig)); };
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
      } catch (e: any) {
          setSysOperation({ status: 'idle', message: '', progress: 0 });
          addToast(`云端备份失败: ${e.message}`, 'error');
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
    const newConfig: MemoryPalaceGlobalConfig = {
      embedding: { ...memoryPalaceConfig.embedding, ...(updates.embedding || {}) },
      lightLLM: { ...memoryPalaceConfig.lightLLM, ...(updates.lightLLM || {}) },
      rerank: { ...memoryPalaceConfig.rerank, ...(updates.rerank || {}) },
    };
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
  const saveModels = (models: string[]) => { setAvailableModels(models); localStorage.setItem('os_available_models', JSON.stringify(models)); };
  const addApiPreset = (name: string, config: APIConfig) => { setApiPresets(prev => { const next = [...prev, { id: Date.now().toString(), name, config }]; localStorage.setItem('os_api_presets', JSON.stringify(next)); return next; }); };
  const removeApiPreset = (id: string) => { setApiPresets(prev => { const next = prev.filter(p => p.id !== id); localStorage.setItem('os_api_presets', JSON.stringify(next)); return next; }); };
  const savePresets = (presets: ApiPreset[]) => { setApiPresets(presets); localStorage.setItem('os_api_presets', JSON.stringify(presets)); };
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
      contextLimit: 500,
      emotionConfig: { enabled: true },
    };
    setCharacters(prev => [...prev, newChar]);
    setActiveCharacterId(newChar.id);
    await DB.saveCharacter(newChar);
  };
  const updateCharacter = async (id: string, updates: Partial<CharacterProfile>) => { setCharacters(prev => { const updated = prev.map(c => c.id === id ? normalizeCharacterImpression({ ...c, ...updates }) : c); const target = updated.find(c => c.id === id); if (target) DB.saveCharacter(target); return updated; }); };
  const deleteCharacter = async (id: string) => { setCharacters(prev => { const remaining = prev.filter(c => c.id !== id); if (remaining.length > 0 && activeCharacterId === id) { setActiveCharacterId(remaining[0].id); } return remaining; }); await DB.deleteCharacter(id); };
  
  // Group Methods
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
  };

  const deleteGroup = async (id: string) => {
      await DB.deleteGroup(id);
      setGroups(prev => prev.filter(g => g.id !== id));
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
                          ? {
                              id: fullUpdatedWb.id,
                              title: fullUpdatedWb.title,
                              content: fullUpdatedWb.content,
                              category: fullUpdatedWb.category,
                            }
                          : m
                  );
                  const newChar = { ...char, mountedWorldbooks: newMounted };
                  DB.saveCharacter(newChar);
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
              DB.saveCharacter(newChar);
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

  const updateUserProfile = async (updates: Partial<UserProfile>) => { setUserProfile(prev => { const next = { ...prev, ...updates }; DB.saveUserProfile(next); return next; }); };
  const addCustomTheme = async (theme: ChatTheme) => { setCustomThemes(prev => { const exists = prev.find(t => t.id === theme.id); if (exists) return prev.map(t => t.id === theme.id ? theme : t); return [...prev, theme]; }); await DB.saveTheme(theme); };
  const removeCustomTheme = async (id: string) => { setCustomThemes(prev => prev.filter(t => t.id !== id)); await DB.deleteTheme(id); };
  const setCustomIcon = async (appId: string, iconUrl: string | undefined) => { setCustomIcons(prev => { const next = { ...prev }; if (iconUrl) next[appId] = iconUrl; else delete next[appId]; return next; }); if (iconUrl) { await DB.saveAsset(`icon_${appId}`, iconUrl); } else { await DB.deleteAsset(`icon_${appId}`); } };
  const addToast = (message: string, type: Toast['type'] = 'info') => { const id = Date.now().toString(); setToasts(prev => [...prev, { id, message, type }]); setTimeout(() => { setToasts(prev => prev.filter(t => t.id !== id)); }, 3000); };
  const showError = (title: string, details: string) => { setErrorDialog({ title, details }); };
  const dismissError = () => { setErrorDialog(null); };

  // --- APPEARANCE PRESETS ---
  const saveAppearancePreset = async (name: string) => {
      const preset: AppearancePreset = {
          id: `ap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name,
          createdAt: Date.now(),
          theme: { ...theme },
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
      // Apply theme
      setTheme(sanitizedPresetTheme);
      // 写 LS 前必须剥 data URI，否则 base64 壁纸会撑爆 5MB quota
      const lsTheme: any = { ...sanitizedPresetTheme };
      if (lsTheme.wallpaper && typeof lsTheme.wallpaper === 'string' && lsTheme.wallpaper.startsWith('data:')) lsTheme.wallpaper = '';
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
          console.warn('[applyAppearancePreset] localStorage 写入失败，已跳过', e);
      }
      applyCustomFont(preset.theme.customFont);
      // Apply custom icons if present
      if (preset.customIcons) {
          setCustomIcons(preset.customIcons);
          for (const [appId, iconUrl] of Object.entries(preset.customIcons)) {
              await DB.saveAsset(`icon_${appId}`, iconUrl);
          }
      }
      // Apply chat themes if present
      if (preset.chatThemes) {
          for (const ct of preset.chatThemes) {
              await DB.saveTheme(ct);
          }
          setCustomThemes(prev => {
              const merged = [...prev];
              for (const ct of preset.chatThemes!) {
                  const idx = merged.findIndex(t => t.id === ct.id);
                  if (idx >= 0) merged[idx] = ct;
                  else merged.push(ct);
              }
              return merged;
          });
      }
      // Save wallpaper/widgets/decos to assets
      if (preset.theme.wallpaper && preset.theme.wallpaper.startsWith('data:')) {
          await DB.saveAsset('wallpaper', preset.theme.wallpaper);
      }
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
          setTheme(defaultTheme);
          applyCustomFont(undefined);

          const iconAppIds = Object.keys(customIcons);
          setCustomIcons({});
          for (const appId of iconAppIds) {
              await DB.deleteAsset(`icon_${appId}`);
          }

          const allAssets = await DB.getAllAssets();
          for (const asset of allAssets) {
              const id = asset.id;
              if (
                  id === 'wallpaper' ||
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
      // 保留原始壁纸画质，把整个预设 JSON 塞进 zip 包压体积
      const data = JSON.stringify({ type: 'sully_appearance_preset', version: 1, ...preset }, null, 2);
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
      const preset: AppearancePreset = {
          id: `ap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: raw.name || '导入的预设',
          createdAt: Date.now(),
          theme: raw.theme,
          customIcons: raw.customIcons,
          chatThemes: raw.chatThemes,
          chatLayout: raw.chatLayout,
      };
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

          // Dedup table — same base64 payload reused across stores (角色头像在
          // 多个 chat / handbook / room 里被嵌入) gets stored exactly once. Key
          // is the base64 string itself, value is the assets/* path. For a
          // heavy user with 50 chats sharing a 200KB avatar this trims ~10MB.
          const assetDedupMap = new Map<string, string>();

          // Strip Base64 Images (Recursive) - Used for Text Only Mode
          const stripBase64 = (obj: any): any => {
              if (typeof obj === 'string') {
                  if (obj.startsWith('data:image')) return '';
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

          // Extract Images to ZIP (Recursive) - Used for Media/Theme Mode
          const processObject = (obj: any): any => {
              if (obj === null || typeof obj !== 'object') return obj;
              
              if (Array.isArray(obj)) {
                  return obj.map(item => processObject(item));
              }

              const newObj: any = {};
              for (const key in obj) {
                  if (Object.prototype.hasOwnProperty.call(obj, key)) {
                      let value = obj[key];
                      if (typeof value === 'string' && value.startsWith('data:image/')) {
                          try {
                              const cached = assetDedupMap.get(value);
                              if (cached) {
                                  value = cached;
                              } else {
                                  const extMatch = value.match(/data:image\/([a-zA-Z0-9]+);base64,/);
                                  if (extMatch) {
                                      const ext = extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1];
                                      const filename = `asset_${Date.now()}_${assetCount++}.${ext}`;
                                      const base64Data = value.split(',')[1];
                                      assetsFolder?.file(filename, base64Data, { base64: true });
                                      const path = `assets/${filename}`;
                                      assetDedupMap.set(value, path);
                                      value = path;
                                  }
                              }
                          } catch (e) {
                              console.warn("Failed to process asset", e);
                          }
                      } else {
                          value = processObject(value);
                      }
                      newObj[key] = value;
                  }
              }
              return newObj;
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
              'characters', 'messages', 'themes', 'emojis', 'emoji_categories', 'assets', 'gallery',
              'user_profile', 'diaries', 'tasks', 'anniversaries', 'room_todos',
              'room_notes', 'groups', 'journal_stickers', 'social_posts', 'courses', 'games', 'worldbooks', 'novels', 'songs',
              'bank_transactions', 'bank_data',
              'xhs_activities', 'xhs_stock',
              'quizzes', 'guidebook', 'scheduled_messages', 'life_sim',
              'handbook', 'trackers', 'tracker_entries', 'hotnews_snapshots',
              'memory_nodes', 'memory_vectors', 'memory_links', 'topic_boxes', 'anticipations', 'event_boxes',
              'daily_schedule', 'memory_batches',
              'pixel_home_assets', 'pixel_home_layouts',
              // 「彼方」虚拟世界各房间 store —— 早期导出清单漏了，导致备份不含房间数据
              'vr_novels', 'vr_annotations', 'cc_custom_parts', 'vr_music', 'vr_guestbook', 'vr_letters', 'vr_settings'
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

          const backupData: Partial<FullBackupData> = {
              timestamp: Date.now(),
              version: 3,
              apiConfig: (mode === 'text_only' || mode === 'full') ? apiConfig : undefined,
              apiPresets: (mode === 'text_only' || mode === 'full') ? apiPresets : undefined,
              availableModels: (mode === 'text_only' || mode === 'full') ? availableModels : undefined,
              realtimeConfig: (mode === 'text_only' || mode === 'full') ? realtimeConfig : undefined,
              memoryPalaceConfig: (mode === 'text_only' || mode === 'full') ? memoryPalaceConfig : undefined,
              theme: theme, // Include theme in all modes (text/media)
              customIcons: (mode === 'text_only' || mode === 'media_only' || mode === 'full')
                  ? { ...customIcons }
                  : undefined,
              appearancePresets: (mode === 'text_only' || mode === 'media_only' || mode === 'full')
                  ? appearancePresets.map(p => ({ ...p }))
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
          };

          const totalSteps = storesToProcess.length + 3;
          let currentStep = 0;

          // Pre-process specialized image fields (Social App, Theme)
          if (mode !== 'text_only') {
              if (backupData.socialAppData?.userProfile) backupData.socialAppData.userProfile = processObject(backupData.socialAppData.userProfile);
              if (backupData.socialAppData?.userBg) backupData.socialAppData.userBg = processObject(backupData.socialAppData.userBg);
              if (backupData.roomCustomAssets) backupData.roomCustomAssets = processObject(backupData.roomCustomAssets);
              if (backupData.theme) backupData.theme = processObject(backupData.theme);
              if (backupData.customIcons) backupData.customIcons = processObject(backupData.customIcons);
              if (backupData.appearancePresets) backupData.appearancePresets = processObject(backupData.appearancePresets);
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
              'bank_transactions', 'scheduled_messages', 'memory_batches', 'hotnews_snapshots'
          ]);

          // Chunked processObject for large arrays — yields to main thread every 200 items
          const processArrayChunked = async (arr: any[], fn: (item: any) => any, chunkSize = 200): Promise<any[]> => {
              if (arr.length <= chunkSize) return arr.map(fn);
              const result: any[] = [];
              for (let i = 0; i < arr.length; i += chunkSize) {
                  const chunk = arr.slice(i, i + chunkSize).map(fn);
                  result.push(...chunk);
                  if (i + chunkSize < arr.length) {
                      await new Promise(r => setTimeout(r, 0));
                  }
              }
              return result;
          };

          for (const storeName of storesToProcess) {
              currentStep++;
              setSysOperation({
                  status: 'processing',
                  message: `正在打包: ${storeName} ...`,
                  progress: (currentStep / totalSteps) * 100
              });

              let rawData = await DB.getRawStoreData(storeName);
              let processedData: any;

              // --- MODE SPECIFIC FILTERING ---

              if (storeName === 'assets' && Array.isArray(rawData)) {
                  rawData = rawData.filter((asset: { id?: string } | null | undefined) => {
                      if (!asset || typeof asset.id !== 'string') return true;
                      return !isRedundantManagedAssetId(asset.id);
                  });
              }

              // Fast path: stores with no image data skip expensive recursive traversal
              if (noImageStores.has(storeName)) {
                  if (storeName === 'memory_vectors' && Array.isArray(rawData)) {
                      // 向量在 IndexedDB 里是 Uint8Array（Float32 原始字节）或老
                      // number[]，JSON.stringify 没法序列化 Uint8Array（结果是 {}）
                      // 所以这里统一解码成 plain number[]，让备份能 JSON 圆规一周。
                      // 重做时 MemoryVectorDB.saveMany 会把 number[] 重新压回
                      // Uint8Array，磁盘还是省的。
                      processedData = rawData.map((v: any) => {
                          if (!v || !v.vector) return v;
                          let arr: number[];
                          if (v.vector instanceof Uint8Array) {
                              const f32 = new Float32Array(v.vector.buffer, v.vector.byteOffset, v.vector.byteLength >>> 2);
                              arr = Array.from(f32);
                          } else if (v.vector instanceof Float32Array) {
                              arr = Array.from(v.vector);
                          } else {
                              arr = v.vector;
                          }
                          return { ...v, vector: arr };
                      });
                  } else {
                      processedData = rawData;
                  }
              } else if (mode === 'text_only') {
                  processedData = Array.isArray(rawData) && rawData.length > 200
                      ? await processArrayChunked(rawData, stripBase64)
                      : stripBase64(rawData);
              } else {
                  // Media & Theme Mode: Extract Images
                  
                  if (storeName === 'messages' && mode === 'media_only') {
                      // Filter messages: Only keep image/emoji types
                      rawData = rawData.filter((m: Message) => m.type === 'image' || m.type === 'emoji');
                  }

                  if (storeName === 'characters' && mode === 'media_only') {
                      // Character Logic: Export ONLY visual assets to mediaAssets array
                      // Do not export the full character array to avoid overwriting text data on import
                      const mediaList = rawData.map((c: CharacterProfile) => {
                          const extracted = {
                              charId: c.id,
                              avatar: c.avatar,
                              sprites: c.sprites,
                              // Date app sprite data: skin sets carry alternate sprite maps,
                              // and customDateSprites/activeSkinSetId are required to wire them up.
                              dateSkinSets: c.dateSkinSets,
                              activeSkinSetId: c.activeSkinSetId,
                              customDateSprites: c.customDateSprites,
                              spriteConfig: c.spriteConfig,
                              roomItems: c.roomConfig?.items?.reduce((acc: any, item: any) => {
                                  if (item.image && item.image.startsWith('data:')) {
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
                          return processObject(extracted);
                      });
                      backupData.mediaAssets = mediaList;
                      continue; // Skip standard assignment
                  }

                  processedData = Array.isArray(rawData) && rawData.length > 200
                      ? await processArrayChunked(rawData, processObject)
                      : processObject(rawData);
              }

              // Assign to Backup Data
              switch(storeName) {
                  case 'characters': if(mode !== 'media_only') backupData.characters = processedData; break;
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
                  case 'hotnews_snapshots': backupData.hotNewsSnapshots = processedData; break;
                  case 'memory_nodes': backupData.memoryNodes = processedData; break;
                  case 'memory_vectors': backupData.memoryVectors = processedData; break;
                  case 'memory_links': backupData.memoryLinks = processedData; break;
                  case 'topic_boxes': backupData.topicBoxes = processedData; break;
                  case 'anticipations': backupData.anticipations = processedData; break;
                  case 'event_boxes': backupData.eventBoxes = processedData; break;
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
                  // 单例 store：导入端期望单个对象（取首条），非数组
                  case 'vr_music': backupData.vrMusicRoom = Array.isArray(processedData) ? (processedData[0] || undefined) : (processedData || undefined); break;
                  case 'vr_guestbook': backupData.vrGuestbook = Array.isArray(processedData) ? (processedData[0] || undefined) : (processedData || undefined); break;
              }

              await new Promise(resolve => setTimeout(resolve, 10));
          }

          // 进度条停在 70% 让用户看到接下来的"压缩中 X%"实际推进，而不是
          // 卡在 95% 干等。level 9 压几十 MB 数据可能要好几秒。
          setSysOperation({ status: 'processing', message: '正在生成压缩包（最高压缩级别）...', progress: 70 });

          // --- MEMORY-OPTIMIZED INCREMENTAL SERIALIZATION ---
          // Instead of JSON.stringify(entire backupData) which doubles peak memory,
          // we serialize large arrays separately and build the JSON incrementally.
          const largeArrayKeys = ['characters', 'messages', 'assets', 'galleryImages',
              'savedEmojis', 'memoryNodes', 'memoryVectors', 'memoryLinks',
              'socialPosts', 'diaries', 'worldbooks', 'novels', 'xhsActivities',
              'bankTransactions', 'quizSessions', 'guidebookSessions',
              'topicBoxes', 'anticipations', 'eventBoxes', 'roomCustomAssets', 'mediaAssets',
              'customThemes', 'appearancePresets', 'courses', 'games', 'songs',
              'roomTodos', 'roomNotes', 'tasks', 'anniversaries', 'groups',
              'savedJournalStickers', 'emojiCategories', 'xhsStockImages',
              'scheduledMessages', 'handbooks', 'trackers', 'trackerEntries', 'hotNewsSnapshots',
              'dailySchedules', 'memoryBatches', 'pixelHomeAssets', 'pixelHomeLayouts'] as const;

          // Build metadata (small fields) separately
          const metadata: Record<string, any> = {};
          const largeKeySet = new Set(largeArrayKeys as readonly string[]);
          for (const key of Object.keys(backupData)) {
              if (!largeKeySet.has(key)) {
                  metadata[key] = (backupData as any)[key];
              }
          }

          // Build JSON string incrementally: "{metadata..., largeKey1:[...], largeKey2:[...]}"
          const metaStr = JSON.stringify(metadata);
          const jsonParts: string[] = [metaStr.slice(0, -1)]; // Remove trailing '}'

          let addedLarge = false;
          for (const key of largeArrayKeys) {
              const value = (backupData as any)[key];
              if (value === undefined || value === null) continue;
              jsonParts.push(`${addedLarge || metaStr.length > 2 ? ',' : ''}"${key}":${JSON.stringify(value)}`);
              addedLarge = true;
              // Release reference immediately to allow GC
              (backupData as any)[key] = undefined;
              // Yield to let GC run
              await new Promise(r => setTimeout(r, 0));
          }
          jsonParts.push('}');

          zip.file("data.json", jsonParts.join(''));
          // Release parts
          jsonParts.length = 0;

          // 进度提示：每 ~5% 更新一次（避免高频 React 重渲染），同时让进度
          // 条从 70% 平滑爬到 99%，用户能确切看到"在动"。
          let lastReportedPercent = -10;
          const content = await zip.generateAsync(
              { type: "blob", streamFiles: true, compression: "DEFLATE", compressionOptions: { level: 9 } },
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
                  const dataFile = loadedZip.file("data.json");
                  if (!dataFile) throw new Error("损坏的备份包: 缺少 data.json");
                  let jsonStr = await dataFile.async("string");
                  totalAssetFiles = countZipAssetFiles(loadedZip);
                  data = JSON.parse(jsonStr);
                  jsonStr = '';
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
          
          showImportProgress('settings', '正在恢复系统设置...', 92, { current: '系统设置', currentFile: '' });
          if (data.theme) {
              await restoreAssetsInPlace(data.theme, '系统主题');
              await updateTheme(data.theme);
          }
          if (data.apiConfig) updateApiConfig(data.apiConfig);
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
                      await DB.saveAsset(`icon_${appId}`, iconUrl);
                  }
              }
              if (data.appearancePresets) {
                  for (const preset of data.appearancePresets) {
                      await DB.saveAsset(`appearance_preset_${preset.id}`, JSON.stringify(preset));
                  }
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
                  assets.forEach(a => {
                      if (a.id.startsWith('icon_')) loadedIcons[a.id.replace('icon_', '')] = a.data;
                      if (a.id.startsWith('appearance_preset_')) {
                          try {
                              loadedPresets.push(JSON.parse(a.data));
                          } catch {}
                      }
                  });
              }
              setCustomIcons(loadedIcons);
              loadedPresets.sort((a, b) => b.createdAt - a.createdAt);
              setAppearancePresets(loadedPresets);
          }

          if (chars.length > 0) setCharacters(chars.map(c => normalizeCharacterDefaults(normalizeCharacterImpression(c))));
          if (groupsList.length > 0) setGroups(groupsList);
          if (themes.length > 0) setCustomThemes(themes);
          if (user) setUserProfile(user);
          if (books.length > 0) setWorldbooks(books);
          if (novelList.length > 0) setNovels(novelList);
          if (songList.length > 0) setSongs(songList);
          
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
  const unlock = () => setIsLocked(false);

  const suspendCall = (info: { charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string }) => {
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
    deleteGroup,
    userProfile,
    updateUserProfile,
    availableModels,
    setAvailableModels,
    apiPresets,
    addApiPreset,
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
    clearSuspendedCall
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
