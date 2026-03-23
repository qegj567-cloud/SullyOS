
import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { APIConfig, AppID, OSTheme, VirtualTime, CharacterProfile, ChatTheme, Toast, FullBackupData, UserProfile, ApiPreset, GroupProfile, SystemLog, Worldbook, NovelBook, SongSheet, Message, RealtimeConfig, AppearancePreset, EmbeddingApiConfig } from '../types';
import { DB } from '../utils/db';
import { ProactiveChat } from '../utils/proactiveChat';
import { ChatPrompts } from '../utils/chatPrompts';
import { ChatParser } from '../utils/chatParser';
import { safeFetchJson } from '../utils/safeApi';
import { normalizeCharacterImpression } from '../utils/impression';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';

const normalizeProactiveAiContent = (raw: string): string => {
  let cleaned = raw;
  cleaned = cleaned.replace(/\[(?:(?:你|User|用户|System)\s*)?发送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');
  cleaned = cleaned.replace(
    /(^|\n)\s*(?:(?:你|User|用户|System)\s*)?发送了表情包[:：]\s*([^\n]+?)(?=\s*(?:\n|$))/g,
    (_match, lineStart: string, emojiName: string) => `${lineStart}[[SEND_EMOJI: ${emojiName.trim()}]]`
  );
  return cleaned;
};


type JSZipLike = {
  folder: (name: string) => { file: (name: string, data: string, options?: { base64?: boolean }) => void } | null;
  file: (name: string) => { async: (type: 'string') => Promise<string> } | null;
  generateAsync: (options: { type: 'blob' }, onUpdate?: (metadata: { percent: number }) => void) => Promise<Blob>;
};

type JSZipCtorLike = {
  new (): JSZipLike;
  loadAsync: (file: File) => Promise<JSZipLike>;
};

let jszipCtorPromise: Promise<JSZipCtorLike> | null = null;

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
  notionEnabled: false,
  notionApiKey: '',
  notionDatabaseId: '',
  feishuEnabled: false,
  feishuAppId: '',
  feishuAppSecret: '',
  feishuBaseId: '',
  feishuTableId: '',
  cacheMinutes: 30
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

  // Embedding API 配置（记忆宫殿向量化）
  embeddingConfig: EmbeddingApiConfig;
  updateEmbeddingConfig: (updates: Partial<EmbeddingApiConfig>) => void;

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

  // Icons
  customIcons: Record<string, string>;
  setCustomIcon: (appId: string, iconUrl: string | undefined) => void;

  // Global Message Signal
  lastMsgTimestamp: number; // New: Signal for Chat to refresh
  unreadMessages: Record<string, number>; // New: Track unread counts per character
  clearUnread: (charId: string) => void; // New: Method to clear unread

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

const defaultTheme: OSTheme = {
  hue: 245, // Default Indigo-ish
  saturation: 25,
  lightness: 65, 
  wallpaper: 'linear-gradient(135deg, #FFDEE9 0%, #B5FFFC 100%)', 
  darkMode: false,
  contentColor: '#ffffff', // Default white text
};

const defaultApiConfig: APIConfig = {
  baseUrl: '', 
  apiKey: '',
  minimaxApiKey: '',
  minimaxGroupId: '',
  model: 'gpt-4o-mini',
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
      'chibi': 'https://sharkpan.xyz/f/oWZQF4/S2.png' // Default Room Sprite
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
  const [embeddingConfig, setEmbeddingConfig] = useState<EmbeddingApiConfig>(() => {
    try { const saved = localStorage.getItem('os_embedding_config'); return saved ? JSON.parse(saved) : { baseUrl: '', apiKey: '', model: '', dimensions: 1024 }; } catch { return { baseUrl: '', apiKey: '', model: '', dimensions: 1024 }; }
  });
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

  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [activeCharacterId, setActiveCharacterId] = useState<string>('');
  
  const [groups, setGroups] = useState<GroupProfile[]>([]); 
  const [worldbooks, setWorldbooks] = useState<Worldbook[]>([]); 
  const [novels, setNovels] = useState<NovelBook[]>([]); // New
  const [songs, setSongs] = useState<SongSheet[]>([]);

  const [userProfile, setUserProfile] = useState<UserProfile>(defaultUserProfile);
  
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [apiPresets, setApiPresets] = useState<ApiPreset[]>([]);
  const [realtimeConfig, setRealtimeConfig] = useState<RealtimeConfig>(defaultRealtimeConfig);
  const [customThemes, setCustomThemes] = useState<ChatTheme[]>([]);
  const [customIcons, setCustomIcons] = useState<Record<string, string>>({});
  const [appearancePresets, setAppearancePresets] = useState<AppearancePreset[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  
  const [lastMsgTimestamp, setLastMsgTimestamp] = useState<number>(0);
  const [unreadMessages, setUnreadMessages] = useState<Record<string, number>>({});
  
  // LOGS
  const [systemLogs, setSystemLogs] = useState<SystemLog[]>([]);
  
  // Sys Operation Status
  const [sysOperation, setSysOperation] = useState<{ status: 'idle' | 'processing', message: string, progress: number }>({ status: 'idle', message: '', progress: 0 });

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
                 if (
                     loadedTheme.wallpaper.includes('unsplash') || 
                     loadedTheme.wallpaper === '' || 
                     loadedTheme.wallpaper.startsWith('http') && !loadedTheme.wallpaper.includes('data:')
                 ) {
                     loadedTheme.wallpaper = 'linear-gradient(120deg, #e0c3fc 0%, #8ec5fc 100%)';
                 }
                 if (loadedTheme.wallpaper.startsWith('data:')) {
                     loadedTheme.wallpaper = defaultTheme.wallpaper;
                 }
                 // Reset large data URI if loaded from legacy storage, we fetch from DB below
                 if (loadedTheme.launcherWidgetImage && loadedTheme.launcherWidgetImage.startsWith('data:')) {
                     loadedTheme.launcherWidgetImage = undefined;
                 }
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
                
                if (assetMap['launcherWidgetImage']) {
                    loadedTheme.launcherWidgetImage = assetMap['launcherWidgetImage'];
                }

                // If asset exists, it overrides LS (which is empty or old)
                if (assetMap['custom_font_data']) {
                    loadedTheme.customFont = assetMap['custom_font_data'];
                }
                
                const loadedIcons: Record<string, string> = {};
                const loadedWidgets: Record<string, string> = {};
                Object.keys(assetMap).forEach(key => {
                    if (key.startsWith('icon_')) {
                        const appId = key.replace('icon_', '');
                        loadedIcons[appId] = assetMap[key];
                    }
                    if (key.startsWith('widget_')) {
                        const slot = key.replace('widget_', '');
                        loadedWidgets[slot] = assetMap[key];
                    }
                });
                setCustomIcons(loadedIcons);
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

                 if (isCorrupted || !existingSully.roomConfig || needsWallUpdate || needsSkinSets) {
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
                         sprites: restoredSprites,
                         roomConfig: updatedRoomConfig,
                         dateSkinSets: mergedSkins
                     };
                     
                     await DB.saveCharacter(updatedSully);
                     finalChars = finalChars.map(c => c.id === sullyV2.id ? updatedSully : c);
                 }
            }
        }

        finalChars = finalChars.map(normalizeCharacterImpression);

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

              // Web Notification
              if (!Capacitor.isNativePlatform() && window.Notification && Notification.permission === 'granted') {
                  const char = characters.find(c => c.id === charId);
                  try {
                      const notif = new Notification(charName, {
                          body: preview,
                          icon: char?.avatar,
                          silent: false
                      });
                      notif.onclick = () => { window.focus(); setActiveApp(AppID.Chat); setActiveCharacterId(charId); };
                  } catch (e) { /* notification failed */ }
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
                  addToast(`${charName} 发来了一条主动消息 2.0`, 'success');
              } else {
                  awayActiveMsgCount += 1;
              }
              setUnreadMessages(prev => ({ ...prev, [charId]: (prev[charId] || 0) + 1 }));
              const preview = (body || `${charName} sent an active message`).replace(/\s+/g, ' ').trim() || `${charName} sent an active message`;
              void sendProactiveNativeNotification(charId, charName, preview);

              if (!Capacitor.isNativePlatform() && window.Notification && Notification.permission === 'granted') {
                  const char = characters.find(c => c.id === charId);
                  try {
                      const notif = new Notification(charName, {
                          body: preview,
                          icon: char?.avatar,
                          silent: false
                      });
                      notif.onclick = () => { window.focus(); setActiveApp(AppID.Chat); setActiveCharacterId(charId); };
                  } catch (e) { /* notification failed */ }
              }
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
              addToast(`你离开期间收到 ${awayActiveMsgCount} 条主动消息 2.0`, 'success');
              awayActiveMsgCount = 0;
          }
      };

      window.addEventListener('active-msg-received', handler);
      window.addEventListener('active-msg-open', openHandler);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
          window.removeEventListener('active-msg-received', handler);
          window.removeEventListener('active-msg-open', openHandler);
          document.removeEventListener('visibilitychange', onVisible);
      };
  }, [characters, sendProactiveNativeNotification]);

  const proactiveRunningRef = useRef(false);
  const proactiveQueueRef = useRef<string[]>([]);
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

          const char = characters.find(c => c.id === charId);
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
          const api = useSecondary ? pCfg!.secondaryApi! : apiConfig;
          if (!api.baseUrl) {
              drainQueuedProactive();
              return;
          }

          proactiveRunningRef.current = true;
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
              const userName = userProfile?.name || '对方';
              await DB.saveMessage({
                  charId,
                  role: 'user',
                  type: 'text',
                  content: `[系统提示（非${userName}发言）: 现在是 ${timeStr}。${timeSinceUser ? `${userName}已经 ${timeSinceUser} 没有找你说话了。` : ''}这是系统给你的一次主动发消息机会——${userName}并没有在跟你说话，是你想主动找${userName}。像真人一样随意地发条消息吧，比如：随手拍了张照片想分享、刚看到个有趣的事想说、突然想到个冷知识、吐槽今天的天气/食物/见闻、或者就是单纯想找${userName}聊几句。不要刻意，不要像在"汇报近况"，就像你真的拿起手机随手发了条消息。一两句话就好。${timeSinceUser && parseInt(timeSinceUser) > 2 ? `（${userName}挺久没找你了，你也可以表达想念、好奇${userName}在干嘛、或者小小地抱怨一下。）` : ''}]`,
                  metadata: { proactiveHint: true, hidden: true }
              });

              // 3. Build prompt & message history
              const allMsgs = await DB.getRecentMessagesByCharId(charId, char.contextLimit || 500);
              const emojis = await DB.getEmojis();
              const categories = await DB.getEmojiCategories();
              const systemPrompt = await ChatPrompts.buildSystemPrompt(char, userProfile, groups, emojis, categories, allMsgs, realtimeConfig);
              const { apiMessages } = ChatPrompts.buildMessageHistory(allMsgs, char.contextLimit || 500, char, userProfile, emojis);
              const fullMessages = [{ role: 'system', content: systemPrompt }, ...apiMessages];

              // 4. API call
              const baseUrl = api.baseUrl.replace(/\/+$/, '');
              const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` };
              const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                  method: 'POST', headers,
                  body: JSON.stringify({ model: api.model, messages: fullMessages, temperature: 0.85, stream: false })
              });

              // 5. Process & save response
              let aiContent = data.choices?.[0]?.message?.content || '';
              aiContent = aiContent.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/gi, '');
              aiContent = aiContent.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
              aiContent = aiContent.replace(/^[\w一-龥]+:\s*/, '');
              aiContent = aiContent.replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n').trim();

              aiContent = normalizeProactiveAiContent(aiContent);
              aiContent = ChatParser.sanitize(aiContent);

              if (aiContent) {
                  const responseParts = ChatParser.splitResponse(aiContent);
                  const savedPreviewChunks: string[] = [];
                  const baseTimestamp = Date.now();
                  let offset = 0;

                  for (const part of responseParts) {
                      if (part.type === 'emoji') {
                          const foundEmoji = emojis.find(e => e.name === part.content);
                          if (foundEmoji?.url) {
                              await DB.saveMessage({
                                  charId,
                                  role: 'assistant',
                                  type: 'emoji',
                                  content: foundEmoji.url,
                                  timestamp: baseTimestamp + offset,
                              });
                          } else {
                              const fallbackText = `发送了表情包：${part.content}`;
                              await DB.saveMessage({
                                  charId,
                                  role: 'assistant',
                                  type: 'text',
                                  content: fallbackText,
                                  timestamp: baseTimestamp + offset,
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
                          await DB.saveMessage({
                              charId,
                              role: 'assistant',
                              type: 'text',
                              content: chunk,
                              timestamp: baseTimestamp + offset,
                          });
                          savedPreviewChunks.push(chunk);
                          offset += 1;
                      }
                  }

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
              drainQueuedProactive();
          }
      };

      ProactiveChat.onTrigger((charId: string) => {
          void runProactive(charId);
      });

      return () => {
          // Cleanup: detach proactive listeners when OSContext unmounts (unlikely but safe)
          ProactiveChat.onTrigger(() => {});
      };
  }, [isDataLoaded, characters, apiConfig, userProfile, groups, realtimeConfig]);

  const updateTheme = async (updates: Partial<OSTheme>) => {
    const { wallpaper, launcherWidgetImage, launcherWidgets, desktopDecorations, customFont, ...styleUpdates } = updates;
    const newTheme = { ...theme, ...updates };
    setTheme(newTheme);

    // Persist large assets to IndexedDB
    if (wallpaper !== undefined) {
        if (wallpaper && wallpaper.startsWith('data:')) {
            await DB.saveAsset('wallpaper', wallpaper);
        } else {
            await DB.deleteAsset('wallpaper');
        }
    }

    if (launcherWidgetImage !== undefined) {
        if (launcherWidgetImage && launcherWidgetImage.startsWith('data:')) {
            await DB.saveAsset('launcherWidgetImage', launcherWidgetImage);
        } else {
            await DB.deleteAsset('launcherWidgetImage');
        }
    }

    // Save widget images to IndexedDB (each slot is a separate asset)
    if (launcherWidgets !== undefined) {
        const slots = ['tl', 'tr', 'wide', 'bl', 'br'];
        for (const slot of slots) {
            const val = launcherWidgets[slot];
            if (val && val.startsWith('data:')) {
                await DB.saveAsset(`widget_${slot}`, val);
            } else if (!val) {
                await DB.deleteAsset(`widget_${slot}`);
            }
        }
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
    if (customFont !== undefined) {
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
    if (lsTheme.launcherWidgetImage && lsTheme.launcherWidgetImage.startsWith('data:')) lsTheme.launcherWidgetImage = '';
    // Strip data URIs from widget slots for LS
    if (lsTheme.launcherWidgets) {
        const cleanWidgets: Record<string, string> = {};
        for (const [k, v] of Object.entries(lsTheme.launcherWidgets)) {
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
  const updateEmbeddingConfig = (updates: Partial<EmbeddingApiConfig>) => { const newConfig = { ...embeddingConfig, ...updates }; setEmbeddingConfig(newConfig); localStorage.setItem('os_embedding_config', JSON.stringify(newConfig)); };
  const updateRealtimeConfig = (updates: Partial<RealtimeConfig>) => { const newConfig = { ...realtimeConfig, ...updates }; setRealtimeConfig(newConfig); localStorage.setItem('os_realtime_config', JSON.stringify(newConfig)); };
  const saveModels = (models: string[]) => { setAvailableModels(models); localStorage.setItem('os_available_models', JSON.stringify(models)); };
  const addApiPreset = (name: string, config: APIConfig) => { setApiPresets(prev => { const next = [...prev, { id: Date.now().toString(), name, config }]; localStorage.setItem('os_api_presets', JSON.stringify(next)); return next; }); };
  const removeApiPreset = (id: string) => { setApiPresets(prev => { const next = prev.filter(p => p.id !== id); localStorage.setItem('os_api_presets', JSON.stringify(next)); return next; }); };
  const savePresets = (presets: ApiPreset[]) => { setApiPresets(presets); localStorage.setItem('os_api_presets', JSON.stringify(presets)); };
  const addCharacter = async () => { const name = 'New Character'; const newChar: CharacterProfile = { id: `char-${Date.now()}`, name: name, avatar: generateAvatar(name), description: '点击编辑设定...', systemPrompt: '', memories: [], contextLimit: 500 }; setCharacters(prev => [...prev, newChar]); setActiveCharacterId(newChar.id); await DB.saveCharacter(newChar); };
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
      // 1. Optimistic Update Local State
      let fullUpdatedWb: Worldbook | undefined;
      setWorldbooks(prev => {
          const next = prev.map(wb => {
              if (wb.id === id) {
                  fullUpdatedWb = { ...wb, ...updates, updatedAt: Date.now() };
                  return fullUpdatedWb;
              }
              return wb;
          });
          return next;
      });

      // 2. Persist to DB
      if (fullUpdatedWb) {
          await DB.saveWorldbook(fullUpdatedWb);

          // 3. AUTO-SYNC: Update Characters that have this book mounted
          // This ensures data redundancy is kept fresh
          const charsToSync = characters.filter(c => c.mountedWorldbooks?.some(m => m.id === id));
          
          if (charsToSync.length > 0) {
              const updatedChars = characters.map(char => {
                  if (char.mountedWorldbooks?.some(m => m.id === id)) {
                      const newMounted = char.mountedWorldbooks.map(m => 
                          m.id === id 
                              // Updated to sync category as well
                              ? { 
                                  id: fullUpdatedWb!.id, 
                                  title: fullUpdatedWb!.title, 
                                  content: fullUpdatedWb!.content,
                                  category: fullUpdatedWb!.category
                                } 
                              : m
                      );
                      // Side effect: Save individual char to DB
                      const newChar = { ...char, mountedWorldbooks: newMounted };
                      DB.saveCharacter(newChar); 
                      return newChar;
                  }
                  return char;
              });
              setCharacters(updatedChars);
              addToast(`已同步更新 ${charsToSync.length} 个相关角色的缓存`, 'info');
          }
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
  const handleSetActiveCharacter = (id: string) => { setActiveCharacterId(id); localStorage.setItem('os_last_active_char_id', id); };
  const addToast = (message: string, type: Toast['type'] = 'info') => { const id = Date.now().toString(); setToasts(prev => [...prev, { id, message, type }]); setTimeout(() => { setToasts(prev => prev.filter(t => t.id !== id)); }, 3000); };

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
      // Apply theme
      setTheme(preset.theme);
      localStorage.setItem('os_theme', JSON.stringify(preset.theme));
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
      const data = JSON.stringify({ type: 'sully_appearance_preset', version: 1, ...preset }, null, 2);
      return new Blob([data], { type: 'application/json' });
  };

  const importAppearancePreset = async (file: File): Promise<void> => {
      const text = await file.text();
      const raw = JSON.parse(text);
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
                              const extMatch = value.match(/data:image\/([a-zA-Z0-9]+);base64,/);
                              if (extMatch) {
                                  const ext = extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1];
                                  const filename = `asset_${Date.now()}_${assetCount++}.${ext}`;
                                  const base64Data = value.split(',')[1];
                                  assetsFolder?.file(filename, base64Data, { base64: true });
                                  value = `assets/${filename}`;
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
              'quizzes', 'guidebook', 'scheduled_messages', 'life_sim'
          ];

          if (mode === 'full') {
              storesToProcess = allStores; // Include everything
          } else if (mode === 'text_only') {
              storesToProcess = allStores.filter(s => s !== 'assets'); // Exclude raw assets store
          } else if (mode === 'media_only') {
              // media_only now includes themes/assets for complete media backup
              storesToProcess = ['gallery', 'emojis', 'emoji_categories', 'journal_stickers', 'user_profile', 'characters', 'messages', 'themes', 'assets', 'bank_data'];
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
                  backupData.theme = stripBase64(backupData.theme);
                  // Restore preset SVGs and remove image decorations (they have no data in text mode)
                  if (backupData.theme.desktopDecorations && savedPresetDecos) {
                      backupData.theme.desktopDecorations = backupData.theme.desktopDecorations
                          .map(d => {
                              const saved = savedPresetDecos.find(p => p.id === d.id);
                              return saved ? { ...d, content: saved.content } : d;
                          })
                          .filter(d => d.content && d.content !== '');
                  }
              }
          }

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

              if (mode === 'text_only') {
                  processedData = stripBase64(rawData);
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

                  processedData = processObject(rawData);
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
              }

              await new Promise(resolve => setTimeout(resolve, 10));
          }

          setSysOperation({ status: 'processing', message: '正在生成压缩包...', progress: 95 });
          
          zip.file("data.json", JSON.stringify(backupData));
          
          const content = await zip.generateAsync({ type: "blob" }, (metadata) => {
              if (Math.random() > 0.8) {
                  setSysOperation(prev => ({ ...prev, message: `压缩中 ${metadata.percent.toFixed(0)}%...` }));
              }
          });

          setSysOperation({ status: 'idle', message: '', progress: 100 });
          return content;

      } catch (e: any) {
          console.error("Export Failed", e);
          setSysOperation({ status: 'idle', message: '', progress: 0 });
          throw new Error("导出失败: " + e.message);
      }
  };

  const importSystem = async (fileOrJson: File | string): Promise<void> => {
      try {
          setSysOperation({ status: 'processing', message: '正在解析备份文件...', progress: 0 });
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
                  const jsonStr = await dataFile.async("string");
                  data = JSON.parse(jsonStr);
              }
          }

          const restoreAssets = async (obj: any): Promise<any> => {
              if (obj === null || typeof obj !== 'object') return obj;
              
              if (Array.isArray(obj)) {
                  const arr = [];
                  for (const item of obj) {
                      arr.push(await restoreAssets(item));
                  }
                  return arr;
              }

              const newObj: any = {};
              for (const key in obj) {
                  if (Object.prototype.hasOwnProperty.call(obj, key)) {
                      let value = obj[key];
                      if (typeof value === 'string' && value.startsWith('assets/') && zip) {
                          try {
                              const filename = value.split('/')[1];
                              const fileInZip = zip.file(`assets/${filename}`);
                              if (fileInZip) {
                                  const base64 = await fileInZip.async("base64");
                                  const ext = filename.split('.').pop() || 'png';
                                  let mime = 'image/png';
                                  if (ext === 'jpg' || ext === 'jpeg') mime = 'image/jpeg';
                                  if (ext === 'gif') mime = 'image/gif';
                                  if (ext === 'webp') mime = 'image/webp';
                                  
                                  value = `data:${mime};base64,${base64}`;
                              }
                          } catch (e) {
                              console.warn(`Failed to restore asset: ${value}`);
                          }
                      } else {
                          value = await restoreAssets(value);
                      }
                      newObj[key] = value;
                  }
              }
              return newObj;
          };

          setSysOperation({ status: 'processing', message: '正在恢复数据与素材...', progress: 50 });
          
          if (zip) {
              data = await restoreAssets(data);
          }

          await DB.importFullData(data);
          
          if (data.theme) {
              await updateTheme(data.theme);
          }
          if (data.apiConfig) updateApiConfig(data.apiConfig);
          if (data.availableModels) saveModels(data.availableModels);
          if (data.apiPresets) savePresets(data.apiPresets);
          if (data.realtimeConfig) updateRealtimeConfig(data.realtimeConfig); // 恢复实时感知配置

          if (data.customIcons !== undefined || data.appearancePresets !== undefined) {
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
          
          if (data.socialAppData) {
              if (data.socialAppData.charHandles) localStorage.setItem('spark_char_handles', JSON.stringify(data.socialAppData.charHandles));
              if (data.socialAppData.userId) localStorage.setItem('spark_user_id', data.socialAppData.userId);
              
              // Restore heavy assets to DB
              if (data.socialAppData.userProfile) await DB.saveAsset('spark_social_profile', JSON.stringify(data.socialAppData.userProfile));
              if (data.socialAppData.userBg) await DB.saveAsset('spark_user_bg', data.socialAppData.userBg);
          }
          
          // Restore Room Custom Assets to DB (migrate old format on import)
          if (data.roomCustomAssets) {
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
          
          if (data.assets || data.customIcons !== undefined || data.appearancePresets !== undefined) {
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

          if (chars.length > 0) setCharacters(chars.map(normalizeCharacterImpression));
          if (groupsList.length > 0) setGroups(groupsList);
          if (themes.length > 0) setCustomThemes(themes);
          if (user) setUserProfile(user);
          if (books.length > 0) setWorldbooks(books);
          if (novelList.length > 0) setNovels(novelList);
          if (songList.length > 0) setSongs(songList);
          
          setSysOperation({ status: 'idle', message: '', progress: 100 });
          addToast('恢复成功，系统即将重启...', 'success');
          setTimeout(() => window.location.reload(), 1500);

      } catch (e: any) {
          console.error("Import Error:", e);
          setSysOperation({ status: 'idle', message: '', progress: 0 });
          const msg = e instanceof SyntaxError ? 'JSON 格式错误' : (e.message || '未知错误');
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
    embeddingConfig,
    updateEmbeddingConfig,
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
    customIcons,
    setCustomIcon,
    lastMsgTimestamp,
    unreadMessages,
    clearUnread,
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
