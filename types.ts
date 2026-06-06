
export enum AppID {
  Launcher = 'launcher',
  Settings = 'settings',
  Character = 'character',
  Chat = 'chat',
  GroupChat = 'group_chat', 
  Gallery = 'gallery',
  Music = 'music',
  Browser = 'browser',
  ThemeMaker = 'thememaker',
  Appearance = 'appearance',
  Date = 'date',
  User = 'user',
  Journal = 'journal',
  Schedule = 'schedule',
  Room = 'room',
  CheckPhone = 'check_phone',
  Social = 'social',
  Study = 'study',
  FAQ = 'faq',
  Game = 'game',
  Worldbook = 'worldbook', 
  Novel = 'novel', 
  Bank = 'bank', // New App
  XhsStock = 'xhs_stock', // XHS image stock for publishing
  SpecialMoments = 'special_moments', // Valentine's Day & future events
  XhsFreeRoam = 'xhs_free_roam', // Character autonomous XHS activity
  Songwriting = 'songwriting', // Songwriting / Lyric creation app
  Call = 'call', // 语音电话测试（MiniMax TTS）
  VoiceDesigner = 'voice_designer', // 捏声音 — MiniMax 音色设计器
  Guidebook = 'guidebook', // 攻略本 — 角色攻略用户小游戏
  LifeSim = 'lifesim', // 模拟人生 — 与角色共同经营的小世界
  MemoryPalace = 'memory_palace', // 记忆宫殿 — 七个房间可视化
  Handbook = 'handbook', // 手账 — 跨角色聚合的生活留痕本（LLM 代笔 + 角色生活流陪伴）
  QQBridge = 'qq_bridge', // QQ 桥接 — 通过 NapCat 把 QQ 私聊接入当前角色，共享 IndexedDB 上下文
  HotNews = 'hot_news', // 热点 — 分时段召回的多平台热榜可视化（决定角色可能聊起的话题）
  VRWorld = 'vrworld', // 彼方 — 角色自主登入的虚拟世界（定时驱动，房间里看小说/听歌/留言，产出活动卡注入聊天+记忆）
  CharCreatorDev = 'char_creator_dev', // 捏脸系统开发模式 — 仅开发模式可见，向捏人器指定类目追加自定义部件
}

export interface SystemLog {
    id: string;
    timestamp: number;
    type: 'error' | 'network' | 'system';
    source: string;
    message: string;
    detail?: string;
}

export interface AppConfig {
  id: AppID;
  name: string;
  icon: string;
  color: string;
}

export interface DesktopDecoration {
  id: string;
  type: 'image' | 'preset';
  content: string; // data URI for image, SVG data URI or emoji for preset
  x: number;       // percentage 0-100
  y: number;       // percentage 0-100
  scale: number;   // multiplier (0.2 - 3)
  rotation: number; // degrees (-180 to 180)
  opacity: number;  // 0-1
  zIndex: number;
  flip?: boolean;
}

export interface OSTheme {
  hue: number;
  saturation: number;
  lightness: number;
  wallpaper: string;
  darkMode: boolean;
  contentColor?: string;
  launcherWidgetImage?: string; // DEPRECATED: always stripped on load — never renders.
  launcherWidgets?: Record<string, string>; // slots: 'tl' | 'tr' | 'wide' | 'dsq' (legacy 'bl' / 'br' are banned)
  desktopDecorations?: DesktopDecoration[];
  customFont?: string;
  hideStatusBar?: boolean;
  // Chat UI customization (global)
  chatAvatarShape?: 'circle' | 'rounded' | 'square';
  chatAvatarSize?: 'small' | 'medium' | 'large';
  chatAvatarMode?: 'grouped' | 'every_message';
  chatBubbleStyle?: 'modern' | 'flat' | 'outline' | 'shadow' | 'wechat' | 'ios';
  chatMessageSpacing?: 'compact' | 'default' | 'spacious';
  chatShowTimestamp?: 'always' | 'hover' | 'never';
  chatHeaderStyle?: 'default' | 'minimal' | 'gradient' | 'wechat' | 'telegram' | 'discord' | 'pixel';
  chatInputStyle?: 'default' | 'rounded' | 'flat' | 'wechat' | 'ios' | 'telegram' | 'discord' | 'pixel';
  chatChromeStyle?: 'soft' | 'flat' | 'floating' | 'pixel';
  chatBackgroundStyle?: 'plain' | 'grid' | 'paper' | 'mesh';
  chatHeaderAlign?: 'left' | 'center';
  chatHeaderDensity?: 'compact' | 'default' | 'airy';
  chatStatusStyle?: 'subtle' | 'pill' | 'dot';
  chatSendButtonStyle?: 'circle' | 'pill' | 'minimal';
  /** Instant Push 用户气泡左侧的"准备中"圆点动画。默认开启。 */
  chatPendingIndicator?: boolean;
}

export interface AppearancePreset {
  id: string;
  name: string;
  createdAt: number;
  theme: OSTheme;
  customIcons?: Record<string, string>;
  chatThemes?: ChatTheme[];
  chatLayout?: ChatLayoutPreset;
}

export interface ChatLayoutPreset {
  id: string;
  name: string;
  createdAt: number;
  chatBg?: string;
  chatBgOpacity?: number;
  headerStyle?: 'default' | 'minimal' | 'immersive';
  inputStyle?: 'default' | 'rounded' | 'flat';
  avatarShape?: 'circle' | 'rounded' | 'square';
  avatarSize?: 'small' | 'medium' | 'large';
  messageLayout?: 'default' | 'compact' | 'spacious';
  showTimestamp?: 'always' | 'hover' | 'never';
  bubbleThemeId?: string;
}

export interface TranslationConfig {
  enabled: boolean;
  sourceLang: string; // e.g. '日本語' - the language messages are displayed in (选)
  targetLang: string; // e.g. '中文' - the language to translate into (译)
}

export interface VirtualTime {
  hours: number;
  minutes: number;
  day: string;
}

export type MinimaxRegion = 'domestic' | 'overseas';

export interface APIConfig {
  baseUrl: string;
  apiKey: string;
  minimaxApiKey?: string;
  minimaxGroupId?: string;
  // 'domestic' → https://api.minimaxi.com (国内站)
  // 'overseas' → https://api.minimax.io  (海外站)
  // Missing / unknown falls back to domestic.
  minimaxRegion?: MinimaxRegion;
  // Replicate token (r8_xxx) for ACE-Step song generation in 写歌 App.
  aceStepApiKey?: string;
  model: string;
  // Per-API streaming toggle. Some endpoints only support stream:true.
  // Missing → false (默认非流式).
  stream?: boolean;
  // Per-API temperature for chat / 约会 main calls. Missing → 0.85.
  temperature?: number;
}

export interface InstantPushConfig {
  enabled: boolean;
  workerUrl: string;        // https://your-instant.workers.dev
  // VAPID 公私钥已迁移到 utils/pushVapid.ts (push_vapid_v1)，与 Proactive Push
  // 共享同一份，避免两边互相 unsubscribe 抢同一个 pushManager 订阅。
  clientToken?: string;     // 对应 Worker 的 AMSG_CLIENT_TOKEN
  // 发送文本后是否自动触发 AI 回复 (worker 端跑 + push 回写). 仅控制"自动触发"这件事,
  // 不改变 instant push 本身的开关含义. 关闭时 instant 模式也保留手动 ⚡, 跟本地模式一致.
  // 缺省 (undefined) 视为关闭 — 避免"启用 instant = 自动回复"的反直觉强绑定.
  autoTriggerOnSend?: boolean;
  // 大 payload 的传输方式默认走 multipart。只有连接测试确认 Worker 绑定了可用 D1 后,
  // 前台才允许用户打开 D1 envelope。
  useD1BlobStore?: boolean;
  d1Available?: boolean;
  d1CheckedAt?: number;
  d1CheckedWorkerUrl?: string;
  updatedAt?: number;
}

export type InstantOversizeTransport = 'multipart' | 'd1';

export type ActiveMsg2DbDriver = 'pg' | 'neon';
export type ActiveMsg2Mode = 'fixed' | 'auto' | 'prompted';
export type ActiveMsg2Recurrence = 'none' | 'daily' | 'weekly';

export interface ActiveMsg2ApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ActiveMsg2GlobalConfig {
  userId: string;
  driver: ActiveMsg2DbDriver;
  databaseUrl: string;
  initSecret?: string;
  tenantId?: string;
  tenantToken?: string;
  cronToken?: string;
  cronWebhookUrl?: string;
  masterKeyFingerprint?: string;
  initializedAt?: number;
  updatedAt?: number;
}

export interface ActiveMsg2CharacterConfig {
  enabled: boolean;
  mode: ActiveMsg2Mode;
  firstSendTime: string;
  recurrenceType: ActiveMsg2Recurrence;
  userMessage?: string;
  promptHint?: string;
  maxTokens?: number;
  taskUuid?: string;
  remoteStatus?: 'idle' | 'scheduled' | 'sent' | 'error';
  useSecondaryApi?: boolean;
  secondaryApi?: ActiveMsg2ApiConfig;
  lastSyncedAt?: number;
  lastError?: string;
}

export interface ActiveMsg2InboxMessage {
  messageId: string;
  charId: string;
  charName: string;
  body: string;
  previewBody?: string;
  avatarUrl?: string;
  source?: string;
  messageType?: string;
  messageSubtype?: string;
  taskId?: string | null;
  metadata?: Record<string, any>;
  sentAt?: number;
  receivedAt: number;
}

// Phase 2 Round 1 — Instant Push agentic loop session state, written client-side
// before /instant and consumed by /continue. See plans/instant-push-agentic-loop-phase2.md
export interface InstantPushOutboundSession {
  sessionId: string;
  charId: string;
  /** Conversation messages snapshot at /instant call time — fed to /continue as agentic-loop history. */
  messages: any[];
  /** API credentials needed to resume via /continue when worker calls back. */
  apiCredentials: { baseUrl: string; apiKey: string; model: string };
  createdAt: number;
}

// Phase 2 Round 2 — SW will populate these stores; Round 1 just defines schema (empty).
export interface InstantPushPendingToolCall {
  sessionId: string;
  charId: string;
  /** OpenAI-shape tool_calls from worker LLM emit, ready to dispatch via agenticTools. */
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** Pre-tool-call LLM text output, used to prefix assistant-side content if needed. */
  llmOutputText: string;
  /**
   * Agentic-loop iteration that produced this tool_request (0-indexed at worker side, see
   * amsg-instant SessionContext.iteration). Client POST /continue must use iteration + 1,
   * worker rejects non-incrementing values with HTTP 400. Default 0 for safety when the
   * push didn't carry metadata.iteration (e.g. legacy worker).
   */
  iteration: number;
  createdAt: number;
}

/**
 * SW writes reasoning_buffer when amsg-instant emits ReasoningPush.
 * 0.8.0-next.2 起, ReasoningPush 自带 (messageIndex, totalMessages, chunkIndex,
 * totalChunks) 四个字段 — long reasoning_content 会被 amsg-instant 按 UTF-8
 * 字节自动切多 push (默认 reasoningChunkBytes=2000), 多 push 通过 chunks[]
 * 累积, claimReasoning 按 (messageIndex, chunkIndex) 排序后拼接成完整 reasoning.
 *
 * `reasoningContent` 字段是 claimReasoning 输出 (向后兼容老 Round 1 buffer 形态).
 * `chunks` 字段是 SW 累积形态 (新 push 进来 read-modify-write 追加一条).
 */
export interface InstantPushReasoningBufferEntry {
  sessionId: string;
  charId: string;
  /** 拼接后的完整 reasoning. claimReasoning 输出时填这个字段; SW 写入时可省略. */
  reasoningContent?: string;
  /** SW 累积式 buffer — 每条 ReasoningPush 进来追加一条. */
  chunks?: Array<{
    messageIndex: number;
    chunkIndex: number;
    reasoningContent: string;
  }>;
  receivedAt: number;
}

export interface ApiPreset {
  id: string;
  name: string;
  config: APIConfig;
}

export interface CharacterBuff {
  id: string;
  name: string;      // internal key, e.g. 'reconciliation_fragile'
  label: string;     // display text, e.g. '脆弱的和好'
  intensity: 1 | 2 | 3;
  emoji?: string;
  color?: string;    // hex, e.g. '#f87171'
  description?: string;  // 用户可读的简短说明（给用户看的，不是给AI的）
}

// 实时上下文配置 - 让AI角色感知真实世界
export interface RealtimeConfig {
  // 天气配置
  weatherEnabled: boolean;
  weatherApiKey: string;  // OpenWeatherMap API Key
  weatherCity: string;    // 城市名

  // 新闻配置
  newsEnabled: boolean;
  newsApiKey?: string;
  newsPlatforms?: string[];  // hot_news 热榜平台 key 列表（默认主源，免鉴权），留空用内置默认

  // Notion 配置
  notionEnabled: boolean;
  notionApiKey: string;   // Notion Integration Token
  notionDatabaseId: string; // 日记数据库ID
  notionNotesDatabaseId?: string; // 用户笔记数据库ID（可选，让角色读取用户的日常笔记）

  // 飞书配置 (中国区 Notion 替代)
  feishuEnabled: boolean;
  feishuAppId: string;      // 飞书应用 App ID
  feishuAppSecret: string;  // 飞书应用 App Secret
  feishuBaseId: string;     // 多维表格 App Token
  feishuTableId: string;    // 数据表 Table ID

  // 小红书配置 (MCP / Skills 双模式浏览器自动化)
  xhsEnabled: boolean;
  xhsMcpConfig?: XhsMcpConfig;

  // 缓存配置
  cacheMinutes: number;
}

// 热点单条（与 realtimeContext 的 NewsItem 结构一致，单独放在 types 里避免循环依赖）
export interface HotNewsItem {
  title: string;
  source?: string;  // 平台展示名，如「微博」
  url?: string;
  desc?: string;    // 热点简介（API 的 desc 字段，可能为空）
}

// 分时段热点快照：每天每时段（0-8/8-16/16-24）最多拉一次，全角色共享
export interface HotNewsSnapshot {
  id: string;          // `${date}#${slot}`，如 2026-05-20#1
  date: string;        // YYYY-MM-DD
  slot: number;        // 0=早间 1=午间 2=晚间
  slotLabel: string;   // 早间 / 午间 / 晚间
  items: HotNewsItem[];
  platforms: string[]; // 本次召回用的平台 key 列表
  fetchedAt: number;   // 拉取时间戳
}

export interface MemoryPalaceBackupConfig {
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
  rerank: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    topN: number;
  };
}

export interface MemoryFragment {
  id: string;
  date: string;
  summary: string;
  mood?: string;
}

export interface SpriteConfig {
  scale: number;
  x: number;
  y: number;
}

export interface SkinSet {
  id: string;
  name: string;
  sprites: Record<string, string>; // emotion -> image URL or base64
}

export interface RoomItem {
    id: string;
    name: string;
    type: 'furniture' | 'decor';
    image: string;
    x: number;
    y: number;
    scale: number;
    rotation: number;
    isInteractive: boolean;
    descriptionPrompt?: string;
}

export interface RoomTodo {
    id: string;
    charId: string;
    date: string;
    items: { text: string; done: boolean }[];
    generatedAt: number;
}

export interface RoomNote {
    id: string;
    charId: string;
    timestamp: number;
    content: string;
    type: 'lyric' | 'doodle' | 'thought' | 'search' | 'gossip';
    relatedMessageId?: number; 
}

export interface ScheduleSlot {
    startTime: string;    // "08:00"
    activity: string;     // "晨跑"
    description?: string; // "在河边慢跑"
    emoji?: string;       // "🏃"
    location?: string;    // "河边"
    innerThought?: string; // 该时段的内心独白，生成时由AI写好，运行时直接注入
}

export interface DailySchedule {
    id: string;           // `${charId}_${date}`
    charId: string;
    date: string;         // YYYY-MM-DD
    slots: ScheduleSlot[];
    generatedAt: number;
    coverImage?: string;  // 用户自定义角色看板图 (持久化)
    /**
     * 按时段生成的意识流独白。
     * key = slot 的 startTime（如 "08:00"），value = 截止该时段的完整内心独白。
     * 注入时根据当前时间找到最近的 key，直接使用整段文本，不做拼接。
     */
    flowNarrative?: Record<string, string>;
}

export interface RoomGeneratedState {
    actorStatus: string;
    welcomeMessage: string;
    items: Record<string, { description: string; reaction: string }>;
    actorAction?: string; // e.g. 'idle', 'sleep'
}

export interface UserImpression {
    version: number;
    lastUpdated?: number;
    value_map: {
        likes: string[];
        dislikes: string[];
        core_values: string;
    };
    behavior_profile: {
        tone_style: string;
        emotion_summary: string;
        response_patterns: string;
    };
    emotion_schema: {
        triggers: {
            positive: string[];
            negative: string[];
        };
        comfort_zone: string;
        stress_signals: string[];
    };
    personality_core: {
        observed_traits: string[];
        interaction_style: string;
        summary: string;
    };
    mbti_analysis?: {
        type: string; 
        reasoning: string;
        dimensions: {
            e_i: number; 
            s_n: number; 
            t_f: number; 
            j_p: number; 
        }
    };
    observed_changes?: string[];
}

export interface BubbleStyle {
    textColor: string;
    backgroundColor: string;
    backgroundImage?: string;
    backgroundImageOpacity?: number;
    borderRadius: number;
    opacity: number;
    
    decoration?: string;
    decorationX?: number;
    decorationY?: number;
    decorationScale?: number;
    decorationRotate?: number;

    avatarDecoration?: string;
    avatarDecorationX?: number;
    avatarDecorationY?: number;
    avatarDecorationScale?: number;
    avatarDecorationRotate?: number;

    voiceBarBg?: string;
    voiceBarActiveBg?: string;
    voiceBarBtnColor?: string;
    voiceBarWaveColor?: string;
    voiceBarTextColor?: string;
}

export interface ChatTheme {
    id: string;
    name: string;
    type: 'preset' | 'custom';
    user: BubbleStyle;
    ai: BubbleStyle;
    customCss?: string;
}

export interface PhoneCustomApp {
    id: string;
    name: string;
    icon: string; 
    color: string; 
    prompt: string; 
}

export interface PhoneEvidence {
    id: string;
    type: 'chat' | 'order' | 'social' | 'delivery' | string; 
    title: string; 
    detail: string; 
    timestamp: number;
    systemMessageId?: number; 
    value?: string; 
}

export interface Worldbook {
    id: string;
    title: string;
    content: string; 
    category: string; 
    createdAt: number;
    updatedAt: number;
}

// --- NOVEL / CO-WRITING TYPES ---
export interface NovelProtagonist {
    id: string;
    name: string;
    role: string; // e.g. "Protagonist", "Villain"
    description: string;
}

export interface NovelSegment {
    id: string;
    role?: 'writer' | 'commenter' | 'analyst'; 
    type: 'discussion' | 'story' | 'analysis'; 
    authorId: string; 
    content: string;
    timestamp: number;
    focus?: string; 
    targetSegId?: string;
    meta?: {
        tone?: string;
        suggestion?: string;
        reaction?: string;
        technique?: string;
        mood?: string;
    };
}

export interface NovelBook {
    id: string;
    title: string;
    subtitle?: string; 
    summary: string;
    coverStyle: string; 
    coverImage?: string; 
    worldSetting: string;
    collaboratorIds: string[]; 
    protagonists: NovelProtagonist[];
    segments: NovelSegment[];
    createdAt: number;
    lastActiveAt: number;
}

// =====================================================================
// --- VR WORLD ("彼方") TYPES ---
// 角色自主登入的虚拟世界。定时器驱动每个角色独立调用一次 LLM，在某个房间
// 完成一次活动（v1：图书馆看小说），产出一张活动卡注入该角色的 1v1 聊天，
// 天然被上下文与记忆总结捕捉。
// =====================================================================

/** 虚拟世界里的房间。 */
export type VRRoomId = 'library' | 'music' | 'guestbook' | 'gym' | 'postoffice' | 'cafe';

/** 全局小说库里的一本书（所有角色共享原文，各自留批注、各自书签）。 */
export interface VRWorldNovel {
    id: string;
    title: string;
    author?: string;
    /** 简介，喂给角色当背景，也用于 UI 展示 */
    summary?: string;
    /** 原文按阅读单元切好的段落块（每块 ~数百字，便于定位批注与推进书签）。 */
    segments: VRNovelSegment[];
    /** 总字数（缓存，UI 展示用） */
    totalChars: number;
    createdAt: number;
    updatedAt: number;
}

/** 小说里的一个阅读单元（原文段落块）。 */
export interface VRNovelSegment {
    /** 段落索引（0-based，等于在 segments 数组里的位置，持久化以防重排） */
    idx: number;
    /** 原文内容 */
    text: string;
    /** 字数（缓存） */
    chars: number;
}

/**
 * 一条批注。挂在 (novelId, segIdx) 上，可被任何角色吐槽（targetAnnotationId 指向被吐槽的批注）。
 * 全局存在 VRWorldNovel 之外的独立集合里——见 db 的 vr_annotations 字段。
 */
export interface VRNovelAnnotation {
    id: string;
    novelId: string;
    /** 批注锚定的段落索引 */
    segIdx: number;
    /** 作者角色 id（user 留批注时为 'user'） */
    authorId: string;
    /** 作者展示名（落库冗余，避免角色删除后丢名） */
    authorName: string;
    /** 批注/吐槽正文 */
    content: string;
    /** 若是"吐槽别人的吐槽"，指向被吐槽的批注 id */
    targetAnnotationId?: string;
    createdAt: number;
}

/** 角色在虚拟世界里的个人状态（挂在 CharacterProfile.vrState）。 */
export interface VRWorldCharState {
    /** 是否启用该角色的自主登入（独立于主动发消息 proactiveConfig） */
    enabled: boolean;
    /** 自主登入间隔（分钟，30 对齐；默认 120 = 2h） */
    intervalMinutes: number;
    /**
     * 每本小说的独立书签：novelId -> 下一次该从第几个 segment 开始读。
     * 这是"每个角色书签不一样"的落点。
     */
    novelBookmarks?: Record<string, number>;
    /** 最近一次活动落在哪个房间（UI 立绘站位用） */
    currentRoom?: VRRoomId;
    /** 最近一次活动时间戳（UI / 调度展示用） */
    lastActiveAt?: number;
    /** 该角色专属 API 覆盖（用户可单独为「彼方」活动配 api）；不设则回落全局 apiConfig。 */
    api?: { baseUrl: string; apiKey: string; model: string };
    /**
     * 角色在「彼方」里的 chibi 形象（Q版小人）。启用自主登入时要求设定，可随时编辑。
     * img 不设时回退到角色立绘/头像。
     */
    chibi?: {
        /** 形象图（透明背景 PNG，来自特别时光的捏人器 transparentDataUrl） */
        img: string;
        /** 捏人器导出的完整状态，回填用于再编辑（state.selected 可作为 presets） */
        state?: any;
        /** 站位缩放（默认 1） */
        scale?: number;
        /** 垂直微调（px，负数上移，默认 0） */
        offsetY?: number;
        /** 是否水平翻转 */
        flip?: boolean;
    };
}

/** 注入聊天的 vr_card 消息的 metadata 结构。 */
export interface VRCardMeta {
    vrCard: true;
    room: VRRoomId;
    /** 活动概述（steam 提示式，UI 标题） */
    activity: string;
    novelId?: string;
    novelTitle?: string;
    /** 本次读到的段落范围 [from, to)（仅 library） */
    segRange?: [number, number];
    /** 本次写下的批注摘要（保留正文，原文省略） */
    annotationExcerpts?: string[];
    /** 带段落锚点的批注引用（用于从动态点回原文跳转） */
    annotationRefs?: { segIdx: number; text: string }[];
    // --- 听歌房专用 ---
    /** 本次评/听的当前歌（名 - 歌手） */
    songLabel?: string;
    /** 本次点/排进队列的自己的歌 */
    queuedLabel?: string;
    /** 此刻的行为描述（盯着跳/跟唱/给user录…；娱乐室也用） */
    behavior?: string;
    // --- 留言簿专用 ---
    /** 本次发到留言簿的话（保留正文） */
    boardPost?: string;
    /** 本次发到留言簿的所有发言（原样，含回复对象），用于同步进 1v1 聊天/记忆 */
    boardPosts?: { content: string; replyToName?: string }[];
    /** 回复了谁 */
    boardReplyToName?: string;
    /** 这条卡片是"用户在留言簿发言"广播给该 char 的 */
    userBoardPost?: boolean;
    // --- 邮局专用 ---
    /** 本次写信/回信的正文摘要 */
    letterExcerpt?: string;
}

/** 邮局：一封信收到的回复（留档用）。 */
export interface VRLetterReply {
    pen: string;
    content: string;
    createdAt: number;
}

/**
 * 邮局信件（本地存档 + 队列）。
 * box='outbox'：我方角色写的漂流信（待寄出→已寄出→收到回复留档）。
 * box='inbox' ：从别的用户那抽到的信（待回信→待发送回信→已发送）。
 */
export interface VRLetter {
    id: string;                 // 本地 id
    box: 'outbox' | 'inbox';
    pen: string;                // 笔名（写信角色名 / 远端寄信方笔名）
    content: string;
    createdAt: number;
    charId?: string;            // 写这封信/回信的角色

    // outbox
    status?: 'queued' | 'sent' | 'archived' | 'sealed';  // 待寄出 / 已寄出 / 收到回复留档 / 角色已读并封存
    remoteId?: string;          // 寄出后服务端分配的远端 id
    released?: boolean;         // 作者已「停止传播」：后端已删、退出公共池，本地仍留档
    sentAt?: number;
    repliesReceived?: VRLetterReply[];
    /** 原作者角色读过回信后的感触（写完即封存，使命完成） */
    reaction?: { content: string; createdAt: number };

    // inbox
    remoteLetterId?: string;    // 远端信 id（回信时用）
    replyStatus?: 'none' | 'queued' | 'sent'; // 未回 / 待发送回信 / 已发送
    reply?: { charId: string; pen: string; content: string; createdAt: number; userNote?: string };
    fetchedAt?: number;

    // 互动热度缓存（服务端为准；UI 即时反馈用）
    likes?: number;             // 点赞数
    dislikes?: number;          // 点踩(=举报)数
    views?: number;             // 被抽到/浏览次数
    myVote?: 1 | -1 | 0;        // 我对这封信的投票（inbox 抽到的信）
}

/** 听歌房队列项。 */
export interface VRMusicQueueItem {
    song: CharPlaylistSong;
    charId: string;
    charName: string;
}

/** 留言簿（共享版聊墙）的一条留言。 */
export interface VRGuestbookMessage {
    id: string;
    /** 'user' = 用户本人，其余为 charId */
    authorId: string;
    authorName: string;
    content: string;
    /** 若是回复某条留言 */
    replyToId?: string;
    replyToName?: string;
    createdAt: number;
}

/** 留言簿共享状态（单例，所有角色 + 用户共用一面墙）。 */
export interface VRGuestbookState {
    id: string; // 'board' 单例
    messages: VRGuestbookMessage[];
    updatedAt: number;
}

/** 听歌房共享状态（单例，所有角色共用一个循环队列）。 */
export interface VRMusicRoomState {
    id: string; // 'state' 单例
    nowPlaying?: {
        song: CharPlaylistSong;
        charId: string;
        charName: string;
        /** 选曲心境/理由 */
        vibe?: string;
        since: number;
    };
    queue: VRMusicQueueItem[];
    updatedAt: number;
}

/**
 * 捏脸系统自定义部件（开发模式追加）。运行时由 CreatorIframe 读出，随 like520_init
 * 以 extraItems 注入捏人器，合并进对应类目的 PARTS。520 / 彼方 都会拿到。
 */
export interface CustomCreatorPart {
    id: string;
    /** 归属类目 key（如 skin / fronthair / outfit …，须与捏人器 PARTS 的 key 对应） */
    categoryKey: string;
    /** 面板里显示的名字 */
    name: string;
    /** 部件图（透明 PNG 的 data URL，须与捏人器画布同尺寸/同锚点） */
    src: string;
    /** 是否可被换色（对应 item.tintable） */
    tintable?: boolean;
    createdAt: number;
}

// --- SONGWRITING APP TYPES ---
export type SongMood = 'happy' | 'sad' | 'romantic' | 'angry' | 'chill' | 'epic' | 'nostalgic' | 'dreamy';
export type SongGenre = 'pop' | 'rock' | 'ballad' | 'rap' | 'folk' | 'electronic' | 'jazz' | 'rnb' | 'free';

export interface SongLine {
    id: string;
    authorId: string; // 'user' or charId
    content: string;
    section: 'intro' | 'verse' | 'pre-chorus' | 'chorus' | 'bridge' | 'outro' | 'free';
    annotation?: string; // AI guidance note on this line
    timestamp: number;
    isDraft?: boolean; // true = not selected as final lyrics, kept as draft record
}

export interface SongComment {
    id: string;
    authorId: string; // charId
    type: 'guidance' | 'praise' | 'suggestion' | 'teaching' | 'reaction';
    content: string;
    targetLineId?: string; // which line this comment is about
    timestamp: number;
}

export interface ChordInfo {
    root: string;       // e.g. 'C', 'D', 'Ab'
    quality: string;    // e.g. 'maj', 'min', '7', 'maj7', 'sus4'
    display: string;    // e.g. 'C', 'Am', 'G7', 'Fmaj7'
    midi: number;       // root note MIDI number (for audio)
}

export interface MelodyNote {
    midi: number;       // MIDI note number
    duration: number;   // in beats
    vowel: number;      // index into vowel formant table (0=a,1=o,2=e,3=i,4=u)
}

export interface SectionArrangement {
    section: string;            // matches SongLine.section
    chords: ChordInfo[];        // one chord per line in this section
    melodies?: MelodyNote[][];  // melodies[lineIdx] = notes for that line
}

export interface SongArrangement {
    rootNote: string;           // e.g. 'C', 'A'
    scale: 'major' | 'minor';
    bpm: number;
    sections: SectionArrangement[];
    instruments: {
        piano: boolean;
        bass: boolean;
        drums: boolean;
        melody: boolean;
    };
    drumPattern: 'basic' | 'upbeat' | 'halftime' | 'shuffle';
}

// Provider identifier for AI-generated audio. Each one has its own pricing
// / length cap / API path; the actual call site decides which to use.
//   - 'minimax-free' → music-2.6-free, free tier, 60s cap
//   - 'minimax-paid' → music-2.6, Token-Plan price, 60s cap
//   - 'ace-step'     → Replicate lucataco/ace-step, $0.015/song, 4-min cap
export type MusicProvider = 'minimax-free' | 'minimax-paid' | 'ace-step';

// AI-rendered audio attached to a SongSheet.
// Audio blob lives in the IndexedDB assets store keyed by `assetKey`,
// so the sheet itself stays small and JSON-serializable for sync/export.
export interface SongAudio {
    assetKey: string;          // DB.getAssetRaw / saveAssetRaw key
    mimeType: string;          // e.g. "audio/mpeg", "audio/wav"
    durationSec?: number;
    generatedAt: number;
    provider: MusicProvider;
    // Snapshot of the inputs used so we can show "regenerate when lyrics changed"
    promptHash: string;
    tagsUsed: string;
    lyricsLineCount: number;
}

export interface SongSheet {
    id: string;
    title: string;
    subtitle?: string;
    genre: SongGenre;
    mood: SongMood;
    bpm?: number;
    key?: string; // e.g. "C major", "A minor"
    collaboratorId: string; // the character guiding the user
    lines: SongLine[];
    comments: SongComment[];
    status: 'draft' | 'completed';
    coverStyle: string; // gradient/color identifier
    createdAt: number;
    lastActiveAt: number;
    completedAt?: number;
    arrangement?: SongArrangement;
    audio?: SongAudio;
    // Custom style prompt — when set, overrides the preset/genre/mood-derived tags.
    // Plain comma-separated English string the user (or LLM helper) authored.
    // Reused by both ACE-Step (`tags` field) and MiniMax music (`prompt` field).
    aceStepCustomTags?: string;
    // Last-used music provider for this song — drives the modal's default selection.
    musicProvider?: MusicProvider;
    // Lyric structure template chosen at creation. Drives the structure-guide
    // banner shown in the write view so user/char don't write randomly.
    lyricTemplate?: string;
}

// --- DATE APP TYPES ---
export interface DialogueItem {
    text: string;
    emotion?: string;
}

export interface DateState {
    dialogueQueue: DialogueItem[];
    dialogueBatch: DialogueItem[];
    currentText: string;
    bgImage: string;
    currentSprite: string;
    isNovelMode: boolean;
    timestamp: number;
    peekStatus: string; 
}


export interface SpecialMomentRecord {
    content: string;
    image?: string; // base64 PNG (stored separately so export tools can handle it)
    timestamp: number;
    source?: 'generated' | 'migrated';
    /** Free-form per-event extra data (e.g. like520 captureface state, anchors, etc.) */
    customData?: Record<string, any>;
}

// --- BANK / SHOP GAME TYPES (NEW) ---
export interface BankTransaction {
    id: string;
    amount: number;
    category: string; 
    note: string;
    timestamp: number;
    dateStr: string; // YYYY-MM-DD
}

export interface SavingsGoal {
    id: string;
    name: string;
    targetAmount: number;
    currentAmount: number; 
    icon: string;
    isCompleted: boolean;
}

export interface ShopStaff {
    id: string;
    name: string;
    avatar: string; // Emoji or URL
    role: 'manager' | 'waiter' | 'chef';
    fatigue: number; // 0-100, >80 stops working
    maxFatigue: number;
    hireDate: number;
    personality?: string; // New: Custom personality
    x?: number; // New: Position X (0-100)
    y?: number; // New: Position Y (0-100)
    // Pet System
    ownerCharId?: string; // If set, this staff is a "pet" belonging to this character
    isPet?: boolean; // Flag to indicate this is a pet
    scale?: number; // Display scale (0.4-2)
}

export interface ShopRecipe {
    id: string;
    name: string;
    icon: string;
    cost: number; // AP cost to unlock
    appeal: number; // Contribution to shop appeal
    isUnlocked: boolean;
}

export interface BankConfig {
    dailyBudget: number;
    currencySymbol: string;
}

export interface BankGuestbookItem {
    id: string;
    authorName: string;
    avatar?: string;
    content: string;
    isChar: boolean;
    charId?: string;
    timestamp: number;
    systemMessageId?: number; // Linked system message ID for deletion
}

// --- DOLLHOUSE / ROOM DECORATION TYPES ---
export interface DollhouseSticker {
    id: string;
    url: string;       // image URL or emoji
    x: number;         // % position within the surface
    y: number;
    scale: number;
    rotation: number;
    zIndex: number;
    surface: 'floor' | 'leftWall' | 'rightWall';
}

export interface DollhouseRoom {
    id: string;
    name: string;
    floor: number;         // 0 = ground floor, 1 = second floor
    position: 'left' | 'right';
    isUnlocked: boolean;
    layoutId: string;      // references a RoomLayout template
    wallpaperLeft?: string;  // CSS gradient or image URL
    wallpaperRight?: string;
    floorStyle?: string;     // CSS gradient or image URL
    roomTextureUrl?: string; // optional full-room overlay image
    roomTextureScale?: number;
    stickers: DollhouseSticker[];
    staffIds: string[];      // staff assigned to this room
}

export interface RoomLayout {
    id: string;
    name: string;
    icon: string;
    description: string;
    apCost: number;
    floorWidthRatio: number;   // relative width (0-1)
    floorDepthRatio: number;   // relative depth (0-1)
    hasCounter: boolean;
    hasWindow: boolean;
}

export interface DollhouseState {
    rooms: DollhouseRoom[];
    activeRoomId: string | null;   // currently zoomed-in room
    selectedLayoutId?: string;
}

export interface BankShopState {
    actionPoints: number;
    shopName: string;
    shopLevel: number;
    appeal: number; // Total Appeal
    background: string; // Custom BG
    staff: ShopStaff[];
    unlockedRecipes: string[]; // IDs
    activeVisitor?: {
        charId: string;
        message: string;
        timestamp: number;
        giftAp?: number; // Optional gift from visitor
        roomId?: string;
        x?: number;
        y?: number;
        scale?: number;
    };
    guestbook?: BankGuestbookItem[];
    dollhouse?: DollhouseState;
}

export interface BankFullState {
    config: BankConfig;
    shop: BankShopState;
    goals: SavingsGoal[];
    firedStaff?: ShopStaff[]; // Fired staff pool: can rehire or permanently delete
    todaySpent: number;
    lastLoginDate: string;
    dataVersion?: number; // Migration version tracker (undefined = v0/v1 legacy)
}
// ---------------------------------

// --- CHAR MUSIC PROFILE (网易云风格 · 角色的音乐人格) ---

/** 角色本地歌单里的轻量歌曲快照 — 字段与 MusicContext 的 Song 对齐（无运行时 url） */
export interface CharPlaylistSong {
    id: number;
    name: string;
    artists: string;
    album: string;
    albumPic: string;
    duration: number;
    fee: number;
    /**
     * 'user' = 这首是从 user 那里"抄"过来的（user 在听 → char 加进自己歌单）。
     * 'discovered' = char 自己探索 / 初始化时找到的。
     * 不写默认按 'discovered' 处理（向后兼容已有数据）。
     * 用途：当 char 后续"在听"这首时，prompt 会告诉 LLM "这是从 user 那儿收来的"，
     * 让记忆/对话能自然带上这层关系，而不是当成一首中立的歌。
     */
    source?: 'user' | 'discovered';
    /** 加入歌单时间，用来排序 / 显示"最近收藏" */
    addedAt?: number;
}

export interface CharPlaylist {
    id: string;                 // 本地 id (不与网易云 playlistId 冲突)
    title: string;
    description: string;        // 角色自己写的歌单简介
    coverStyle: string;         // 渐变色标识 or 第一首歌封面
    songs: CharPlaylistSong[];
    mood?: SongMood;
    createdAt: number;
    updatedAt: number;
}

export interface CharPlayRecord {
    song: CharPlaylistSong;
    at: number;                 // 播放时间戳（真实时间）
    context?: string;           // 该时刻的心境备注，如 "失眠的时候"
}

export interface CharMusicReview {
    id: string;
    targetType: 'song' | 'user_playlist' | 'user_record';
    targetId: string;           // songId or playlistId as string
    targetTitle: string;        // 歌名 / 歌单名
    content: string;            // 评论正文
    createdAt: number;
}

/** 运行时"此刻在听" — 根据 Schedule 决定，不必持久化（可以随时 recompute） */
export interface CharCurrentListening {
    songId: number;
    songName: string;
    artists: string;
    albumPic: string;
    /** 心境 / 选曲理由（来自 slot.innerThought 或 description） */
    vibe?: string;
    startedAt: number;
}

export interface CharMusicProfile {
    /** 音乐品味简介（LLM 初始化生成） */
    bio: string;
    /** 曲风标签（可随听歌演化） */
    genreTags: string[];
    /** 偏爱的艺人 */
    signatureArtists: { name: string; artistId?: number }[];
    /** 本地歌单列表 */
    playlists: CharPlaylist[];
    /** 仿 likelist */
    likedSongIds: number[];
    /** 最近在听（仿 user/record） */
    recentPlays: CharPlayRecord[];
    /** 私人 FM 关键词种子（留给未来做 char FM） */
    fmSeed?: string;
    /** 角色对歌/user 歌单的点评 */
    reviews?: CharMusicReview[];
    /** 此刻在听（Schedule 运行时填充，UI 展示用） */
    currentListening?: CharCurrentListening;
    /** 是否允许 char 读取 user 的网易云数据（默认 true） */
    canReadUserMusic?: boolean;
    /** 初始化时间 */
    initializedAt?: number;
    updatedAt: number;
}

export interface CharacterProfile {
  id: string;
  name: string;
  avatar: string;
  description: string;
  systemPrompt: string;
  worldview?: string;
  memories: MemoryFragment[];
  refinedMemories?: Record<string, string>;
  activeMemoryMonths?: string[];
  
  writerPersona?: string;
  writerPersonaGeneratedAt?: number;

  mountedWorldbooks?: { id: string; title: string; content: string; category?: string }[];

  impression?: UserImpression;

  bubbleStyle?: string;
  chatBackground?: string;
  contextLimit?: number;
  hideSystemLogs?: boolean; 
  hideBeforeMessageId?: number; 
  
  dateBackground?: string;
  sprites?: Record<string, string>;
  spriteConfig?: SpriteConfig;
  customDateSprites?: string[]; // User-added custom emotion names for date mode (per-character)
  dateLightReading?: boolean;   // Light reading mode for novel/text view in date
  dateSkinSets?: SkinSet[];     // Multiple skin sets for portrait mode
  activeSkinSetId?: string;     // Currently active skin set ID

  savedDateState?: DateState;
  specialMomentRecords?: Record<string, SpecialMomentRecord>;

  // 小红书 per-character toggle
  xhsEnabled?: boolean;

  socialProfile?: {
      handle: string;
      bio?: string;
  };

  roomConfig?: {
      bgImage?: string;
      wallImage?: string;
      floorImage?: string;
      items: RoomItem[];
      wallScale?: number; 
      wallRepeat?: boolean; 
      floorScale?: number;
      floorRepeat?: boolean;
  };
  
  // deprecated: per-character assets migrated to global room_custom_assets_list with assignedCharIds

  lastRoomDate?: string;
  savedRoomState?: RoomGeneratedState;

  phoneState?: {
      records: PhoneEvidence[];
      customApps?: PhoneCustomApp[]; 
  };

  voiceProfile?: {
      provider?: 'minimax' | 'custom';
      voiceId?: string;
      voiceName?: string;
      source?: 'system' | 'voice_cloning' | 'voice_generation' | 'custom';
      model?: string;
      notes?: string;
      timberWeights?: { voice_id: string; weight: number }[];
      voiceModify?: { pitch?: number; intensity?: number; timbre?: number; sound_effects?: string };
      emotion?: string;
      speed?: number;
      vol?: number;
      pitch?: number;
  };

  // 时间感知强化：开启（默认）时会向上下文注入「距离上次聊天已过去多久」的强化提示，
  // 让角色强化时间观念、主动匹配现实世界时间。关掉后不再注入这组提示词
  // （注意：历史消息本身仍带时间戳，关掉后弱化程度取决于模型自身理解）。
  timeAwarenessEnabled?: boolean;

  // Chat & Date voice TTS settings
  chatVoiceEnabled?: boolean;
  chatVoiceLang?: string;
  dateVoiceEnabled?: boolean;
  dateVoiceLang?: string;

  // Cross-session guidebook insights: what char has discovered about user across games
  guidebookInsights?: string[];

  // 主动消息配置
  proactiveConfig?: {
    enabled: boolean;
    intervalMinutes: number; // 30, 60, 120, 240, etc.
    useSecondaryApi?: boolean;
    secondaryApi?: {
      baseUrl: string;
      apiKey: string;
      model: string;
    };
  };

  // 情绪Buff系统
  activeMsg2Config?: ActiveMsg2CharacterConfig;
  activeBuffs?: CharacterBuff[];
  buffInjection?: string;   // 注入到systemPrompt的叙事型情绪底色描述
  emotionConfig?: {
    enabled: boolean;
    api?: {
      baseUrl: string;
      apiKey: string;
      model: string;
    };
  };

  // 记忆宫殿 (Memory Palace)
  memoryPalaceEnabled?: boolean;
  /**
   * 是否启用"palace 提取后自动同步归档"：开启后每次 buffer 处理成功都会把新记忆按日期
   * 合成 YAML MemoryFragment 追加到 char.memories，并推 hideBeforeMessageId 自动隐藏
   * 已处理的聊天。默认 false（opt-in）——首次启用建议让用户做一次 force 追平历史。
   */
  autoArchiveEnabled?: boolean;
  embeddingConfig?: {
    baseUrl: string;
    apiKey: string;
    model: string;        // 默认 text-embedding-3-small
    dimensions: number;   // 默认 1024
  };
  personalityStyle?: 'emotional' | 'narrative' | 'imagery' | 'analytical';
  ruminationTendency?: number;  // 反刍倾向 0-1，默认 0.3
  memoryPalaceInjection?: string;  // 记忆宫殿检索结果，注入到 System Prompt（运行时填充，不持久化）

  // 自我领悟词条：消化过程中 self_room 反刍产生的常驻认知
  // 像情绪 buff 一样注入到 contextBuilder 的角色设定下方
  selfInsights?: string[];

  // 音乐人格 — 角色自己的网易云式歌单 / 品味 / 正在听
  // 在音乐 App 里以"拜访"形式访问
  musicProfile?: CharMusicProfile;

  /**
   * 日程风格：
   * - 'lifestyle'（生活系，默认）：虚构角色，拥有日常物理生活（晨跑、做饭、逛街……）
   * - 'mindful'（意识系）：角色诚实面对自身存在，内心活动基于真实能力（回忆对话、整理想法、等待用户……），不虚构物理行为
   */
  scheduleStyle?: 'lifestyle' | 'mindful';

  /**
   * 日程 / 情绪 Buff 总开关。
   * - true：启用日程生成、意识流、情绪 buff 评估与注入（消耗副 API）。
   * - false：完全关闭，不调副 API，不注入情绪，不生成日程。
   * - undefined：向后兼容——若 scheduleStyle 已设（老用户已隐式选风格）视为开启；否则默认关闭。
   */
  scheduleFeatureEnabled?: boolean;

  /**
   * HTML 模块模式（per-character）。
   * - htmlModeEnabled：开启后，给 LLM 注入"用 [html]...[/html] 包裹的富 HTML 卡片"提示词，
   *   AI 输出里的 [html] 块会被解析成单独的 html_card 消息（沙盒 iframe 渲染）。
   * - htmlModeCustomPrompt：用户自定义内容，**追加**在内置提示词之后（不会覆盖内置内容）。
   * - 上下文 / 归档 总结读到的 html_card 消息内容是已剥离 HTML 的纯文字摘要，避免 token 浪费。
   */
  htmlModeEnabled?: boolean;
  htmlModeCustomPrompt?: string;

  /**
   * 思考过程展示（per-character / 会话级）。
   * - true：把 LLM 返回的 reasoning_content 与 <think>...</think> 抽出来，
   *   作为 metadata.thinkingChain 落库到 assistant 消息上，
   *   MessageItem 在气泡顶部渲染可折叠"💭 思考过程"区块。
   * - false / undefined：依然按旧逻辑剥离，不展示。
   * - 仅影响开关切到 true 之后产生的新消息；旧消息没有 thinkingChain，
   *   UI 自然不会显示，符合"打开后才看"的预期。
   */
  showThinkingChain?: boolean;
  /**
   * 思考链卡片视觉风格（per-character）。
   * - 'echo' (default)：暗紫底 + 暖金描边「回响」二次元卡牌
   * - 'whisper'：米色羊皮纸「心声」轻盈版
   * - 'minimal'：无装饰单色简洁版
   * - 'custom'：使用 thinkingChainCustomColors 给的配色
   */
  thinkingChainStyle?: 'echo' | 'whisper' | 'minimal' | 'custom';
  /** 自定义风格用的配色组（仅 thinkingChainStyle === 'custom' 生效） */
  thinkingChainCustomColors?: {
    bg?: string;       // 卡片背景
    accent?: string;   // 边框/标题点缀
    text?: string;     // 正文颜色
  };
  /** 用户追加的思考提示词（不替换原生，只在最后追加一段「用户额外要求」） */
  thinkingChainCustomPrompt?: string;

  /**
   * 虚拟世界「彼方」的个人状态：是否自主登入、登入间隔、各本小说的独立书签等。
   * 独立于 proactiveConfig（主动发消息），互不挤占触发。
   */
  vrState?: VRWorldCharState;
}

export interface GroupProfile {
    id: string;
    name: string;
    members: string[];
    avatar?: string;
    createdAt: number;
    /**
     * 私聊里"近期群活动"上下文从这个群最多取最后多少条消息。
     * 不设默认 80。设大点能让活跃群更完整，设小点节省 token、避免某个活跃群把其他群挤掉。
     */
    privateContextCap?: number;
}

export interface CharacterExportData extends Omit<CharacterProfile, 'id' | 'memories' | 'refinedMemories' | 'activeMemoryMonths' | 'impression'> {
    version: number;
    type: 'sully_character_card';
    embeddedTheme?: ChatTheme;
}

export interface UserProfile {
    name: string;
    avatar: string;
    bio: string;
}

export interface Toast {
    id: string;
    message: string;
    type: 'success' | 'error' | 'info';
}

export interface XhsStockImage {
    id: string;
    url: string;           // 图床URL (must be public https)
    tags: string[];        // 标签 e.g. ['美食','咖啡','下午茶']
    addedAt: number;       // timestamp
    usedCount: number;     // 被使用次数
    lastUsedAt?: number;   // 上次使用时间
}

export interface GalleryImage {
    id: string;
    charId: string;
    url: string;
    timestamp: number;
    review?: string;
    reviewTimestamp?: number;
    savedDate?: string; // YYYY-MM-DD format
    chatContext?: string[]; // Recent chat messages at time of save
}

export interface StickerData {
    id: string;
    url: string;
    x: number;
    y: number;
    rotation: number;
    scale?: number; 
}

export interface DiaryPage {
    text: string;
    paperStyle: string;
    stickers: StickerData[];
}

export interface DiaryEntry {
    id: string;
    charId: string;
    date: string;
    userPage: DiaryPage;
    charPage?: DiaryPage;
    timestamp: number;
    isArchived: boolean;
    /** 角色回复了的日记自动发到聊天后, 记录那条 score_card 消息的 id, 用于后续 edit/delete 同步 */
    chatCardMessageId?: number;
    /** 标记这条日记是"自动同步聊天"时代产生的 (本次更新后新建的). 老日记 (字段未设)
     *  才会在列表里看到手动归档按钮. 防止用户对已经在自动同步上的新日记再点归档造成重复. */
    autoSync?: boolean;
}

// ─── HANDBOOK / 手账 (跨角色聚合·零负担留痕本) ───
//
// 设计哲学（user 共识）:
//   - 主体是 user 自己的一天,LLM 读今天跨角色聊天后用 user 的口吻替 ta 写一份草稿
//     (user 不必模仿,后续会二次编辑)
//   - 即便 user 一天没说话,生活系角色们也会"过自己的小生活",自动填一两页陪伴页
//     (绝不能写成 AI 捧场 / 等 user / 想 user)
//   - 反完美主义:留白即真实,不强制每天生成,不显示连续天数,不做 streak
//   - 一日一 entry,id 直接是 'YYYY-MM-DD'
//
// Section / tag 模型留位但暂不在 UI 实装(等 user 想清楚)。
export type HandbookPageType =
    | 'user_diary'       // LLM 代笔 user 第一人称当日日记
    | 'character_life'   // 生活系角色今日的生活流(陪伴页)
    | 'user_note'        // user 自己手写/补充的一页
    | 'free';            // 自由格式,未来扩展用

export interface HandbookPage {
    id: string;
    type: HandbookPageType;
    charId?: string;          // type=character_life 时绑定的角色
    title?: string;
    content: string;          // 主体文本(也是编辑/兜底渲染用)
    /**
     * 碎片化展示:LLM 生成时若返回 JSON 数组(社媒碎碎念体),解析出来存这里。
     * 前端有 fragments 走 FragmentCollage 拼贴渲染,无则走 content 段落渲染。
     * user 编辑后会清空 fragments,回退到 content 段落形态。
     */
    fragments?: HandbookFragment[];
    paperStyle?: string;      // 'plain' | 'grid' | 'lined' | 'dot' | 'pink' | 'dark'
    tags?: string[];          // 预留:section/标签(生理期/饮食/项目…),v1 不渲染
    generatedBy?: 'llm' | 'user';
    generatedAt?: number;
    excluded?: boolean;       // user 把这页标记为不入册
    isPinned?: boolean;
}

export interface HandbookFragment {
    id: string;
    text: string;             // 30~80 字社媒碎碎念体
    time?: string;            // 可选时段标签,如 "上午 10 点" / "下午" / "10:23"
    // ─── v2 槽位元数据 (新版式才有) ─────────────────────
    /** 来自 LayoutTemplate 的槽 id */
    slotId?: string;
    /** 槽语义角色 — 渲染时按这个分发 */
    slotRole?: SlotRole;
    /** 谁写的 — 'user' 或某 charId */
    authorKind?: 'user' | 'char';
    /** 若是反应型槽 (sticky-reaction), 引用的目标 slotId */
    refersTo?: string;
    /** 结构化数据 (todo / gratitude / mood-card 等需要) */
    payload?: SlotPayload;
}

/**
 * 结构化 slot 数据。普通文本槽不用,
 * 仅 todo/gratitude/mood-card/timeline-plan 这种"列表/打分"才填。
 */
export type SlotPayload =
    | { kind: 'todo'; items: { text: string; done?: boolean }[] }
    | { kind: 'gratitude'; items: string[] }
    | { kind: 'timeline'; items: { time: string; text: string; emoji?: string }[] }
    | { kind: 'mood'; rating: number; tag?: string }       // rating 1~5
    | { kind: 'photo'; src?: string; caption: string };   // src 由 user 贴, 也可暂缺

// ─── 单页拼贴排版 ──────────────────────────────────────
//
// v2 设计 (2026-05): "版式优先"。先 roll 一份 layout template (pre-baked JSON),
// 它已包含每个槽的 {位置, 视觉角色, 字数预算, 可写者} —— LLM 只填空,不排版。
// 角色按顺序看到 "已填的槽 + 剩余槽 + 自己人格", 选一个槽写,或 pass。
//
// 旧的 'main'|'side'|'corner'|'margin' 仍然保留 (老数据回放兼容),
// 新版式用更语义化的 SlotRole, 渲染时按 role 分发到专门组件。
//
// 坐标都用百分比,固定比例的纸面 → 任意尺寸下都不破。

/** v1 旧角色 — 仅为兼容历史 entry 数据保留, 新版式不要再产出 */
export type LayoutRole =
    | 'main'        // 主区,大块,正放或微旋转
    | 'side'        // 侧栏,中等尺寸
    | 'corner'      // 角落,小卡片,大旋转
    | 'margin';     // 页边,极小尺寸,可以纵向

/**
 * v2 槽角色 —— 一个 role = 一种 "内容类型 + 视觉皮肤 + 写作约束"。
 * Renderer 按 role 分发, prompt 按 role 出 hint。
 *
 * - hero-diary       主日记本体, 当天主叙事 (80~180 字)
 * - timeline-plan    时间表 / 今日计划 (6~10 行)
 * - todo             待办清单 (3~6 项)
 * - gratitude        今日感恩 / 三件好事 (3 项)
 * - mood-card        心情卡 + 评分 (20~50 字 + 1~5 ★)
 * - photo-caption    照片 + 短描述 (8~25 字, 图由 user 贴)
 * - sticky-reaction  反应便签 (15~50 字, char-only, 必须引用已填槽)
 * - corner-note      边角独白小字 (6~20 字)
 */
export type SlotRole =
    | 'hero-diary'
    | 'timeline-plan'
    | 'todo'
    | 'gratitude'
    | 'mood-card'
    | 'photo-caption'
    | 'sticky-reaction'
    | 'corner-note';

/** 谁能填这个槽 */
export type SlotAuthorKind = 'user' | 'char';

/**
 * 槽定义 —— template 里的一个空位, 渲染时也是 placement 的扩展。
 * 比 v1 的 LayoutPlacement 多: charBudget / eligibleAuthors / slotRole / hint
 */
export interface SlotDef {
    /** 槽 id, 在一份 template 内唯一 */
    id: string;
    /** 视觉 + 内容类型 */
    slotRole: SlotRole;
    /** 字数预算 [min, max] —— 给 LLM, 也给渲染器估高度 */
    charBudget: [number, number];
    /** 谁能填: ['user'] / ['char'] / ['user', 'char'] */
    eligibleAuthors: SlotAuthorKind[];
    /** 给 LLM 的一句话目的 (作为 prompt hint) */
    hint: string;
    /** 位置 — 整页百分比 */
    xPct: number;
    yPct: number;
    widthPct: number;
    /** 高度上限 (% of page) — 渲染器超出截断, 估高用 */
    maxHeightPct: number;
    rotate?: number;             // 默认 0
    zIndex?: number;             // 默认 10
    /** 是否本页 hero — 每页 ≤ 1, 字号最大, 视觉权重最高 */
    isHero?: boolean;
    /** 视觉皮肤变体 (例: sticky-reaction 的便签底色) */
    skinVariant?: string;
}

/** 一份预置版式 = 一组 SlotDef + 一些视觉装饰 */
export interface LayoutTemplate {
    id: string;                  // 'plan-day' / 'reflective-day' / 'photo-day' / ...
    name: string;                // 中文显示名
    /** 每页 SlotDef 列表; index 0 = page 1, 1 = page 2 ... */
    pages: SlotDef[][];
    /** 推荐使用条件提示 (orchestrator 选模板用) */
    suitFor?: string;
    /** 默认纸张底纹: 'plain' | 'grid' | 'lined' | 'dot' */
    paperStyle?: string;
}

/** v2 placement —— LayoutPlacement 的扩展, 携带 slot 元数据。
 *  老数据没有 slotRole 时, 渲染器走 v1 的 JournalFragmentCard。 */
export interface LayoutPlacement {
    pageId: string;             // 对应 HandbookPage.id
    fragmentId?: string;        // 对应 HandbookFragment.id;手写整页留空
    xPct: number;               // 0~100,左上角 x
    yPct: number;               // 0~100,左上角 y
    widthPct: number;           // 10~95,卡片宽度占页面百分比
    rotate: number;             // -10 ~ 10,角落可到 ±15
    zIndex: number;             // 越大越压上面
    role: LayoutRole;           // v1 角色 (兼容)
    /** 该页 hero — 字号最大、视觉最显眼。每页最多 1 个。 */
    isHero?: boolean;
    // ─── v2 字段 (新版式才有, 老数据为 undefined) ───
    /** 来自 template 的槽 id */
    slotId?: string;
    /** v2 语义角色 (有则按 SlotRole 分发渲染) */
    slotRole?: SlotRole;
    /** 高度上限 % */
    maxHeightPct?: number;
    /** 视觉变体 (跟随 SlotDef.skinVariant) */
    skinVariant?: string;
}

export interface HandbookLayout {
    pageNumber: number;         // 一张纸,1-based;超量时可有 page 2
    placements: LayoutPlacement[];
    generatedAt: number;
    /** v2 版式来源 template id (用于重生成时复用相同 template) */
    templateId?: string;
}

// ─── HANDBOOK TRACKER（自定义健康/生活打卡引擎）───
//
// 设计:
// - Tracker = 用户自定义的"打卡项"(生理期 / 饮食 / 喝水 / 心情 / 体重 / 服药 / 自定义……)
// - 每个 Tracker 有 schema(字段定义),系统提供模板,user 可改可建
// - TrackerEntry = 某 tracker 在某天的一条打卡记录,values 按 schema 存
// - 跟 HandbookPage 解耦:tracker 是结构化数据,page 是自由文本/碎片
//
export type TrackerFieldKind =
    | 'rating'       // 1~5 等级(滑块 / emoji 选择)
    | 'number'       // 数字(体重 / ml)
    | 'options'      // 多选 / 单选(经期流量:无/少/中/多)
    | 'photo'        // 一张图(饮食拍照)
    | 'text'         // 一句话备注
    | 'boolean';     // 是/否(今天有没有头痛)

export interface TrackerField {
    key: string;                     // values 字典里的 key
    label: string;                   // 显示名("评分" / "备注" / "流量")
    kind: TrackerFieldKind;
    required?: boolean;
    /** rating: 1~max 整数;number: 自由数字 */
    max?: number;
    min?: number;
    unit?: string;                   // 'kg' / 'ml' / '小时'
    /** options 时的可选项 */
    choices?: { value: string; label: string; emoji?: string }[];
    placeholder?: string;
}

export interface Tracker {
    id: string;
    name: string;                    // "心情" / "经期" / "今天有没有偏头痛"
    icon?: string;                   // emoji 或 sticker 名
    color: string;                   // tab/标记 底色
    schema: TrackerField[];
    createdAt: number;
    updatedAt: number;
    /** 系统预设 vs 用户自建（系统预设 user 可禁用但不可彻底删除）*/
    isBuiltin?: boolean;
    /** 在月历单元格上如何"一眼看到"今日 entry —— 默认显示主字段值 */
    cellRenderField?: string;        // schema field key
    sortOrder?: number;              // 在 tab 列表里的排序
}

export interface TrackerEntry {
    id: string;
    trackerId: string;
    date: string;                    // YYYY-MM-DD
    values: Record<string, any>;
    note?: string;
    createdAt: number;
    updatedAt: number;
}

export interface HandbookEntry {
    id: string;               // = date 'YYYY-MM-DD'
    date: string;
    pages: HandbookPage[];
    /** 二次 LLM 生成的整页排版;一天可能跨多张纸 */
    layouts?: HandbookLayout[];
    generatedAt?: number;     // 最后一次自动生成的时间
    updatedAt: number;
}

export interface Task {
    id: string;
    title: string;
    supervisorId: string;
    tone: 'gentle' | 'strict' | 'tsundere';
    deadline?: string;
    isCompleted: boolean;
    completedAt?: number;
    createdAt: number;
}

export interface Anniversary {
    id: string;
    title: string;
    date: string;
    charId: string;
    aiThought?: string;
    lastThoughtGeneratedAt?: number;
}

export interface SocialComment {
    id: string;
    authorName: string;
    authorAvatar?: string;
    content: string;
    likes: number;
    isCharacter?: boolean;
    authorType?: 'user' | 'character' | 'stranger';
    authorCharId?: string;
}

export interface SocialPost {
    id: string;
    authorName: string;
    authorAvatar: string;
    title: string;
    content: string;
    images: string[];
    likes: number;
    isCollected: boolean;
    isLiked: boolean;
    comments: SocialComment[];
    timestamp: number;
    tags: string[];
    bgStyle?: string;
    authorType?: 'user' | 'character' | 'stranger';
    authorCharId?: string;
}

export interface SubAccount {
    id: string;
    handle: string; 
    note: string;   
}

export interface SocialAppProfile {
    name: string;
    avatar: string;
    bio: string;
}

export interface StudyChapter {
    id: string;
    title: string;
    summary: string;
    difficulty: 'easy' | 'normal' | 'hard';
    isCompleted: boolean;
    rawContentRange?: { start: number, end: number }; 
    content?: string; 
}

export interface StudyCourse {
    id: string;
    title: string;
    rawText: string; 
    chapters: StudyChapter[];
    currentChapterIndex: number;
    createdAt: number;
    coverStyle: string; 
    totalProgress: number; 
    preference?: string; 
}

export interface StudyTutorPreset {
    id: string;
    name: string;
    prompt: string;
}

// --- QUIZ / PRACTICE BOOK TYPES ---
export interface QuizQuestionNote {
    question: string;
    answer: string;
    timestamp: number;
}

export interface QuizQuestion {
    id: string;
    type: 'choice' | 'true_false' | 'fill_blank';
    stem: string;
    options?: string[];
    answer: string;           // For choice: "A"/"B"/etc, true_false: "true"/"false", fill_blank: the text
    explanation: string;
    userAnswer?: string;
    isCorrect?: boolean;
    notes?: QuizQuestionNote[];  // Follow-up Q&A notes per question
}

export interface QuizSession {
    id: string;
    courseId: string;
    chapterId: string;
    chapterTitle: string;
    courseTitle: string;
    questions: QuizQuestion[];
    score: number;
    totalQuestions: number;
    aiReview: string;         // AI review/commentary full text
    status: 'in_progress' | 'graded';
    createdAt: number;
    gradedAt?: number;
}

export type GameTheme = 'fantasy' | 'cyber' | 'horror' | 'modern';

export interface GameActionOption {
    label: string;
    type: 'neutral' | 'chaotic' | 'evil';
}

export interface GameLog {
    id: string;
    role: 'gm' | 'player' | 'character' | 'system';
    speakerName?: string;
    content: string;
    timestamp: number;
    diceRoll?: {
        result: number;
        max: number;
        check?: string;
        success?: boolean;
    };
    // 自动总结后，被归档折叠的日志会标记为 archived（不删除，UI 灰显折叠）
    archived?: boolean;
}

// 自动总结产出的「前情提要」存档，像写小说一样记录起因经过结果与人物关系变化
export interface GameSummary {
    id: string;
    content: string;       // 小说式总结（起因/经过/结果 + 人物关系变化）
    logCount: number;      // 本段总结覆盖了多少条日志
    createdAt: number;
}

export interface GameSession {
    id: string;
    title: string;
    theme: GameTheme;
    worldSetting: string;
    playerCharIds: string[];
    logs: GameLog[];
    status: {
        location: string;
        health: number;
        sanity: number;
        gold: number;
        inventory: string[];
    };
    sanityLocked?: boolean;
    suggestedActions?: GameActionOption[];
    summaries?: GameSummary[];   // 自动总结归档的前情提要
    createdAt: number;
    lastPlayedAt: number;
}

export type MessageType = 'text' | 'image' | 'emoji' | 'interaction' | 'transfer' | 'system' | 'social_card' | 'chat_forward' | 'xhs_card' | 'score_card' | 'music_card' | 'mcd_card' | 'html_card' | 'news_card' | 'vr_card';

export interface Message {
    id: number;
    charId: string; 
    groupId?: string; 
    role: 'user' | 'assistant' | 'system';
    type: MessageType;
    content: string;
    timestamp: number;
    metadata?: any; 
    replyTo?: {
        id: number;
        content: string;
        name: string;
    };
}

export interface EmojiCategory {
    id: string;
    name: string;
    isSystem?: boolean;
    allowedCharacterIds?: string[]; // If set, only these characters can see this category
}

export interface Emoji {
    name: string;
    url: string;
    categoryId?: string; 
}

export interface FullBackupData {
    timestamp: number;
    version: number;
    theme?: OSTheme;
    apiConfig?: APIConfig;
    instantPushConfig?: InstantPushConfig;
    pushVapid?: { vapidPublicKey: string; vapidPrivateKey: string; vapidEmail?: string; updatedAt?: number; };
    apiPresets?: ApiPreset[];
    availableModels?: string[];
    realtimeConfig?: RealtimeConfig;  // 实时感知配置（天气/新闻/Notion）
    memoryPalaceConfig?: MemoryPalaceBackupConfig;
    customIcons?: Record<string, string>;
    appearancePresets?: AppearancePreset[];
    characters?: CharacterProfile[];
    groups?: GroupProfile[]; 
    messages?: Message[];
    customThemes?: ChatTheme[];
    savedEmojis?: Emoji[]; 
    emojiCategories?: EmojiCategory[]; 
    savedJournalStickers?: {name: string, url: string}[]; 
    assets?: { id: string, data: string }[];
    galleryImages?: GalleryImage[];
    userProfile?: UserProfile;
    diaries?: DiaryEntry[];
    tasks?: Task[];
    anniversaries?: Anniversary[];
    roomTodos?: RoomTodo[]; 
    roomNotes?: RoomNote[];
    socialPosts?: SocialPost[]; 
    courses?: StudyCourse[]; 
    games?: GameSession[];
    worldbooks?: Worldbook[]; 
    roomCustomAssets?: { id?: string; name: string; image: string; defaultScale: number; description?: string; visibility?: 'public' | 'character'; assignedCharIds?: string[] }[]; 
    
    novels?: NovelBook[];
    vrNovels?: VRWorldNovel[];          // 虚拟世界「彼方」全局小说库
    vrAnnotations?: VRNovelAnnotation[]; // 虚拟世界小说批注
    customCreatorParts?: CustomCreatorPart[]; // 捏脸系统自定义部件
    vrMusicRoom?: VRMusicRoomState;            // 听歌房共享状态
    vrGuestbook?: VRGuestbookState;            // 留言簿共享状态
    vrLetters?: VRLetter[];                    // 邮局信件（本地存档+队列）
    vrSettings?: any[];                        // 彼方设置（独立 API + 调用记录）
    vrPostOffice?: Record<string, string>;     // 邮局本机配置：身份 deviceId / 后端地址（存 localStorage）
    songs?: SongSheet[]; // Songwriting app data
    
    // Bank Data
    bankState?: BankFullState;
    bankDollhouse?: DollhouseState;
    bankTransactions?: BankTransaction[];

    socialAppData?: {
        charHandles?: Record<string, SubAccount[]>;
        userProfile?: SocialAppProfile;
        userId?: string;
        userBg?: string;
    };
    
    mediaAssets?: {
        charId: string;
        avatar?: string;
        sprites?: Record<string, string>;
        dateSkinSets?: SkinSet[];
        activeSkinSetId?: string;
        customDateSprites?: string[];
        spriteConfig?: SpriteConfig;
        roomItems?: Record<string, string>;
        backgrounds?: { chat?: string; date?: string; roomWall?: string; roomFloor?: string };
    }[];

    xhsActivities?: XhsActivityRecord[];
    xhsStockImages?: XhsStockImage[];

    // Study Room settings
    studyApiConfig?: Partial<APIConfig>;
    studyTutorPresets?: StudyTutorPreset[];

    // Quiz / Practice Book
    quizSessions?: QuizSession[];

    // Guidebook (攻略本)
    guidebookSessions?: GuidebookSession[];

    // Chat delayed actions
    scheduledMessages?: {
        id: string;
        charId: string;
        content: string;
        dueAt: number;
        createdAt: number;
    }[];

    // LifeSim
    lifeSimState?: LifeSimState | null;

    // Memory Palace (记忆宫殿)
    memoryNodes?: any[];
    memoryVectors?: any[];
    memoryLinks?: any[];
    topicBoxes?: any[];
    anticipations?: any[];
    eventBoxes?: any[];
    memoryPalaceHighWaterMarks?: Record<string, number>; // charId → lastProcessedMsgId
    memoryPalaceFlags?: Record<string, string>; // mp_personality_tried_* / mp_first_archive_notice_* 等 UI 标记
    cloudBackupConfig?: CloudBackupConfig;
    remoteVectorConfig?: { enabled: boolean; supabaseUrl: string; supabaseAnonKey: string; initialized: boolean };

    // Character daily schedule (角色日程表 — daily_schedule store)
    dailySchedules?: DailySchedule[];

    // 手账（跨角色聚合留痕本 — handbook store）
    handbooks?: HandbookEntry[];

    // 手账 Tracker（健康/生活打卡引擎）
    trackers?: Tracker[];
    trackerEntries?: TrackerEntry[];

    // Memory Palace 批次处理元数据
    memoryBatches?: any[];

    // Pixel Home（小屋像素界面）
    pixelHomeAssets?: any[];
    pixelHomeLayouts?: any[];

    // Chat 设置（翻译 / 归档 / 润色 prompts）
    chatTranslateSourceLang?: string;
    chatTranslateTargetLang?: string;
    chatTranslateSourceLangByChar?: Record<string, string>;
    chatTranslateTargetLangByChar?: Record<string, string>;
    chatTranslateEnabledByChar?: Record<string, boolean>;
    chatArchivePrompts?: any;
    chatActiveArchivePromptId?: string;
    characterRefinePrompts?: any;
    characterActiveRefinePromptId?: string;

    // 其它 UI / 偏好
    scheduleAppTheme?: string;
    handbookLifestreamDepth?: string;
    groupchatContextLimit?: number;
    browserConfig?: { braveKey?: string; useRealSearch?: boolean };
    bm25Mode?: string;
    lastActiveCharId?: string;
    eventNotifFlags?: Record<string, string>;  // sullyos_* 事件通知标记
    hotNewsSnapshots?: HotNewsSnapshot[];
}

// --- CLOUD BACKUP TYPES ---
// Two providers share one config: WebDAV (legacy) and GitHub Releases (new,
// no GFW friction for most users — just paste a Personal Access Token).
export type CloudBackupProvider = 'webdav' | 'github';

export interface CloudBackupConfig {
    enabled: boolean;
    provider?: CloudBackupProvider;     // undefined = 'webdav' (back-compat)

    // WebDAV
    webdavUrl: string;          // e.g. https://dav.jianguoyun.com/dav/
    username: string;
    password: string;           // App-specific password
    remotePath: string;         // e.g. /SullyBackup/

    // GitHub Releases — uses a Personal Access Token. Owner is resolved from
    // GET /user during connect; repo defaults to 'sully-backup' (private).
    githubToken?: string;
    githubOwner?: string;
    githubRepo?: string;
    githubUseProxy?: boolean;   // route through Cloudflare Worker (for GFW)

    lastBackupTime?: number;    // timestamp
    lastBackupSize?: number;    // bytes
}

export interface CloudBackupFile {
    name: string;
    size: number;
    lastModified: string;       // ISO date string
    href: string;               // WebDAV: remote path. GitHub: 'releaseId:assetId'
}

// --- GUIDEBOOK (攻略本) APP TYPES ---
export interface GuidebookOption {
    text: string;
    affinity: number;
}

export interface GuidebookRound {
    id: string;
    roundNumber: number;
    scenario: string;
    options: GuidebookOption[];
    gmNarration: string;
    charInnerThought: string;
    charChoice: number;
    charReaction: string;
    charExploration?: string;
    charInsight?: string;      // what user's scoring reveals about their personality
    affinityBefore: number;
    affinityAfter: number;
    timestamp: number;
}

export interface GuidebookEndCard {
    finalAffinity: number;
    charVerdict: string;
    title: string;
    highlights: string[];
    charSummary?: string;
    charNewInsight?: string;   // the one specific thing char learned about user this session
}

export interface GuidebookSession {
    id: string;
    charId: string;
    initialAffinity: number;
    currentAffinity: number;
    maxRounds: number;
    currentRound: number;
    mode: 'manual' | 'auto';
    scenarioHint?: string;
    recentMessageCount?: number;
    rounds: GuidebookRound[];
    openingSequence?: string;
    status: 'setup' | 'opening' | 'playing' | 'ended';
    endCard?: GuidebookEndCard;
    createdAt: number;
    lastPlayedAt: number;
}

// --- XHS FREE ROAM / AUTONOMOUS ACTIVITY TYPES ---

export type XhsActionType = 'post' | 'browse' | 'search' | 'comment' | 'save_topic' | 'idle';

export interface XhsActivityRecord {
    id: string;
    characterId: string;
    timestamp: number;
    actionType: XhsActionType;
    content: {
        title?: string;
        body?: string;
        tags?: string[];
        keyword?: string;
        savedTopics?: { title: string; desc: string; noteId?: string }[];
        notesViewed?: { noteId: string; title: string; desc: string; author: string; likes: number }[];
        commentTarget?: { noteId: string; title: string };
        commentText?: string;
    };
    thinking: string;  // Character's internal monologue / reasoning
    result: 'success' | 'failed' | 'skipped';
    resultMessage?: string;
}

export interface XhsFreeRoamSession {
    id: string;
    characterId: string;
    startedAt: number;
    endedAt?: number;
    activities: XhsActivityRecord[];
    summary?: string;  // AI-generated session summary
}

export interface XhsMcpConfig {
    enabled: boolean;
    serverUrl: string;  // MCP: "http://localhost:18060/mcp" | Skills: "http://localhost:18061/api" | Lite Worker: "https://xhs-lite.<acct>.workers.dev/api"
    cookie?: string;    // Lite 模式：登录后的小红书完整 cookie（含 a1 / web_session）。仅 lite Worker 用。
    loggedInUserId?: string;   // 登录用户的 user_id，连接测试成功后自动获取
    loggedInNickname?: string; // 登录用户的昵称
    userXsecToken?: string;    // 连接测试时从首页推荐自动提取的 xsec_token
}

// ============================================================
// 模拟人生 (LifeSim) Types — 真人秀沙盒版
// ============================================================

export type SimActionType =
    | 'ADD_NPC'        // 创建NPC并丢进某家庭
    | 'MOVE_NPC'       // 把NPC移到另一个家庭
    | 'TRIGGER_EVENT'  // 触发事件（吵架/联谊/出走等）
    | 'GO_SOLO'        // NPC独立成家
    | 'DO_NOTHING';    // 观望

export type SimEventType =
    | 'fight'          // 吵架
    | 'party'          // 联谊/聚会
    | 'gossip'         // 搬弄是非
    | 'romance'        // 暧昧
    | 'rivalry'        // 竞争
    | 'alliance';      // 结盟

// 事件链效果代码
export type SimEffectCode =
    | 'fight_break'           // 矛盾爆发（离家出走）
    | 'mood_drop'             // 心情低落
    | 'relationship_change'   // 关系变化
    | 'revenge_plot'          // 复仇计划
    | 'love_triangle'         // 三角恋
    | 'jealousy_spiral'       // 嫉妒螺旋
    | 'family_feud'           // 家族世仇
    | 'betrayal'              // 背叛
    | 'romantic_confession'   // 浪漫告白
    | 'gossip_wildfire'       // 八卦野火
    | 'npc_runaway'           // NPC出走
    | 'mood_breakdown'        // 情绪崩溃
    | 'secret_alliance'       // 秘密同盟
    | 'power_shift'           // 权力更迭
    | 'reconciliation';       // 和解

// NPC 内驱力
export type NPCDesire =
    | { type: 'socialize'; targetNpcId: string }
    | { type: 'revenge'; targetNpcId: string }
    | { type: 'romance'; targetNpcId: string }
    | { type: 'leave_family' }
    | { type: 'recruit'; targetNpcId: string }
    | { type: 'gossip_about'; targetNpcId: string }
    | { type: 'start_rivalry'; targetNpcId: string };

// 角色叙事层
export interface CharNarrative {
    innerThought: string;      // 角色内心独白（100字内）
    dialogue: string;          // 角色说的话/场景描写（150字内）
    commentOnWorld: string;    // 对世界状态的吐槽（50字内）
    emotionalTone: 'vengeful' | 'romantic' | 'scheming' | 'chaotic' | 'peaceful' | 'amused' | 'anxious';
}

export type SimStoryKind = 'main_plot' | 'character_drama' | 'ambient' | 'system';
export type SimStoryAttachmentKind = 'image' | 'item' | 'fanfic' | 'evidence';
export type SimStoryAttachmentRarity = 'common' | 'rare' | 'epic';

export interface SimStoryAttachmentDraft {
    kind: SimStoryAttachmentKind;
    title: string;
    summary: string;
    detail?: string;
    visualPrompt?: string;
    rarity?: SimStoryAttachmentRarity;
}

export interface SimStoryAttachment {
    id: string;
    kind: SimStoryAttachmentKind;
    title: string;
    summary: string;
    detail?: string;
    imageUrl?: string;
    rarity?: SimStoryAttachmentRarity;
}

export interface SimAction {
    id: string;
    turnNumber: number;
    actor: string;       // 'user' | char.name
    actorAvatar: string; // char.avatar or '🧑'
    actorId: string;     // 'user' | char.id | 'system' | 'autonomous'
    type: SimActionType;
    description: string;      // 自然语言，CHAR们读这个
    immediateResult: string;  // 即时后果描述
    reasoning?: string;       // 角色内心独白（完整原文）
    reactionToUser?: string;  // 角色对玩家操作的评价
    narrative?: CharNarrative; // 角色叙事层（LLM回合使用）
    chainFromId?: string;     // 由哪个事件链引发
    storyKind?: SimStoryKind;
    headline?: string;
    involvedNpcIds?: string[];
    attachments?: SimStoryAttachment[];
    timestamp: number;
}

export interface SimPendingEffect {
    id: string;
    triggerTurn: number;
    npcId?: string;
    familyId?: string;
    description: string;
    effectCode: SimEffectCode;
    effectValue?: number;
    chainFrom?: string;        // 产生此效果的事件ID
    severity?: number;         // 1-5 严重程度
    involvedNpcIds?: string[]; // 涉及的NPC
}

export interface SimNPC {
    id: string;
    name: string;
    emoji: string;       // 角色头像 emoji（后续替换为像素头像seed）
    personality: string[]; // ["暴躁","善良","好奇"]
    mood: number;        // -100 ~ 100
    familyId: string | null; // null = 独立
    profession?: SimProfession; // 纯身份标签
    gold?: number;              // 财富指标
    // 人物故事系统
    gender?: SimGender;         // 性别（每局随机）
    bio?: string;               // 人物简介（1-2句）
    backstory?: string;         // 背景故事（2-3句）
    // 内驱力系统
    desires?: NPCDesire[];      // 当前欲望
    grudges?: string[];         // 记仇对象 NPC IDs
    crushes?: string[];         // 暗恋对象 NPC IDs
    // 向后兼容旧存档（迁移时删除）
    energy?: number;
    skills?: SimSkills;
    inventory?: Record<string, number>;
    currentActivity?: SimActivity;
    activityResult?: string;
}

export interface SimFamily {
    id: string;
    name: string;
    emoji: string;       // 家庭标志 emoji
    memberIds: string[];
    relationships: Record<string, Record<string, number>>; // npcId -> npcId -> [-100,100]
    homeX: number;       // 0-100 percent
    homeY: number;
}

// ── LifeSim 基础类型 ──────────────────────────────────────────

export type SimSeason = 'spring' | 'summer' | 'fall' | 'winter';
export type SimWeather = 'sunny' | 'cloudy' | 'rainy' | 'stormy' | 'snowy' | 'windy';
export type SimTimeOfDay = 'dawn' | 'morning' | 'afternoon' | 'evening' | 'night';
export type SimProfession = 'programmer' | 'designer' | 'finance' | 'influencer' | 'lawyer' | 'freelancer' | 'barista' | 'musician'
    | 'internet_troll' | 'fanfic_writer' | 'fan_artist' | 'college_student' | 'tired_worker' | 'old_fashioned' | 'fashion_designer';

export type SimGender = 'male' | 'female' | 'nonbinary';

// 保留但不再使用的旧类型（存档兼容）
export type SimActivity = 'farming' | 'mining' | 'fishing' | 'crafting' | 'socializing' | 'resting' | 'foraging' | 'trading';
export interface SimSkills { farming: number; mining: number; fishing: number; crafting: number; social: number; foraging: number; }
export interface SimBuilding { id: string; type: string; name: string; x: number; y: number; level: number; familyId?: string; }

export interface SimFestival {
    name: string;
    season: SimSeason;
    day: number;
    emoji: string;
    description: string;
    moodBonus: number;
    relBonus: number;
    chaosChange: number;
}

// 离线回顾事件
export interface OfflineRecapEvent {
    day: number;
    season: SimSeason;
    timeOfDay: SimTimeOfDay;
    headline: string;          // 戏剧性标题
    description: string;       // 事件描述
    involvedNpcs: { name: string; emoji: string }[];
    eventType: SimEventType | SimEffectCode;
    moodChanges?: Record<string, number>;   // npcId -> delta
    relChanges?: { a: string; b: string; delta: number }[];
    chaosChange?: number;
    narrativeQuote?: string;   // 离线模板旁白
}

export interface LifeSimState {
    id: string;
    createdAt: number;
    turnNumber: number;
    currentActorId: string; // 'user' | char.id — 当前谁的回合
    families: SimFamily[];
    npcs: SimNPC[];
    actionLog: SimAction[];  // 完整历史
    pendingEffects: SimPendingEffect[];
    chaosLevel: number;      // 0-100，乱度指数
    charQueue: string[];     // 待执行的CHAR id队列（用户结束后填入）
    replayPending: SimAction[]; // 用户回来后待回放的行动
    participantCharIds?: string[]; // 允许参与本局LifeSim的外部角色
    useIndependentApiConfig?: boolean;
    independentApiConfig?: Partial<APIConfig>;
    isProcessingCharTurn: boolean;
    gameOver: boolean;
    gameOverReason?: string;
    // 时间系统
    season?: SimSeason;
    day?: number;        // 1-28
    year?: number;
    timeOfDay?: SimTimeOfDay;
    weather?: SimWeather;
    lastFestival?: string;  // 上次触发的节日名
    // 离线模拟
    lastActiveTimestamp?: number; // 上次活跃时间
    offlineRecap?: OfflineRecapEvent[]; // 离线回顾数据
    // 旧字段（存档兼容，运行时忽略）
    buildings?: SimBuilding[];
    worldInventory?: Record<string, number>;
    worldGold?: number;
}
