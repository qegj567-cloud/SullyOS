
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
  MemoryPalace = 'memory_palace', // 记忆宫殿 — 记忆管理 + 向量化配置
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
  launcherWidgetImage?: string; // kept for backward compat, migrated to launcherWidgets['wide']
  launcherWidgets?: Record<string, string>; // slots: 'tl' | 'tr' | 'wide'
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

export interface APIConfig {
  baseUrl: string;
  apiKey: string;
  minimaxApiKey?: string;
  minimaxGroupId?: string;
  model: string;
}

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
  avatarUrl?: string;
  source?: string;
  messageType?: string;
  messageSubtype?: string;
  taskId?: string | null;
  metadata?: Record<string, any>;
  sentAt?: number;
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

export interface MemoryFragment {
  id: string;
  date: string;
  summary: string;
  mood?: string;
}

// ============ Dynamic Prompt System (动态预设) ============

/** Prompt 块的系统类型 ID — 内置块，引擎知道如何生成内容 */
export type SystemBlockId =
    | 'char_identity'       // 角色身份（名字、systemPrompt）
    | 'worldview'           // 世界观
    | 'worldbooks'          // 世界书
    | 'user_profile'        // 用户画像
    | 'impression'          // 私密印象
    | 'memory_bank'         // 记忆库（月度总结 + 详细日志）
    | 'memory_palace'       // 记忆宫殿（向量检索注入）
    | 'emotion_buff'        // 情绪 Buff
    | 'realtime_context'    // 实时信息（天气/新闻/时间）
    | 'group_context'       // 群聊上下文
    | 'notion_diaries'      // Notion 日记
    | 'feishu_diaries'      // 飞书日记
    | 'user_notes'          // 用户笔记
    | 'chat_rules'          // 聊天行为规范
    | 'voice_config'        // 语音消息配置
    | 'mode_switch'         // 模式切换提示
    // ── Cognitive Architecture Blocks ──
    | 'emotion_dynamics'         // 情绪动力学（替代 emotion_buff）
    | 'personality_crystals'     // 涌现人格
    | 'user_cognitive_model'     // 用户认知模型
    | 'unresolved_tensions'      // 未解决张力
    | 'cross_event_patterns';    // 跨事件模式

/** 单个 Prompt Block */
export interface PromptBlock {
    id: string;                        // 唯一标识 (系统块 = SystemBlockId, 自定义块 = uuid)
    type: 'system' | 'custom';         // system = 内置自动生成, custom = 用户自定义文本
    name: string;                      // 显示名称
    enabled: boolean;                  // 是否启用
    content?: string;                  // custom 块的用户自定义内容（支持 {{char}} {{user}} 模板变量）
    systemBlockId?: SystemBlockId;     // system 块的类型 ID
    // UI hints
    icon?: string;                     // 显示图标
    color?: string;                    // 标签颜色 (tailwind class)
    description?: string;              // 鼠标悬停说明
    locked?: boolean;                  // 是否锁定不可删除（系统块默认 true）
}

/** Prompt 预设 — 全局模板，可挂载到任意角色 */
export interface PromptPreset {
    id: string;
    name: string;
    description?: string;
    blocks: PromptBlock[];             // 按顺序排列的块列表
    isDefault?: boolean;               // 是否为默认预设（不可删除）
    createdAt: number;
    updatedAt: number;
}

// ============ Memory Palace (记忆宫殿) ============

/** 记忆房间类型 */
export type MemoryRoom =
  | 'living_room'   // 客厅 — 日常互动、闲聊
  | 'bedroom'       // 卧室 — 亲密关系、情感
  | 'study'         // 书房 — 工作、学习、成长
  | 'user_room'     // TA的房间 — 关于用户的一切
  | 'self_room'     // 自己的房间 — 角色的自我认知
  | 'attic';        // 阁楼 — 杂项、低频、待归类

/** 记忆节点 — 从聊天中提取的结构化记忆片段 */
export interface MemoryNode {
  id: string;
  charId: string;

  // 内容
  content: string;          // 第三人称陈述句
  source: 'chat' | 'reflection' | 'user_pin';
  sourceMessageIds?: number[];

  // 分类
  room: MemoryRoom;
  tags: string[];

  // 权重三因子
  importance: number;       // 1-10
  lastAccessedAt: number;   // 上次被检索引用的时间戳
  createdAt: number;

  // 向量状态
  embedded: boolean;
  embeddingVersion: number; // 模型变了可以重新生成

  // 元数据
  mood?: string;
  processBatch?: string;    // 哪次整理批次产生的
  linkedMemoryIds?: string[]; // 关联的其他记忆（相似度 0.7-0.9）
}

/** 向量记录 — 与 MemoryNode 分开存储，避免大对象拖慢查询 */
export interface MemoryVector {
  memoryId: string;
  charId: string;
  vector: number[];         // Float32 序列化为普通数组（IndexedDB 不支持 TypedArray 作 key）
  dimensions: number;
  version: number;
}

/** Embedding API 配置 */
export interface EmbeddingApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;      // 可选降维（Matryoshka）
}

/** 记忆整理批次记录 */
export interface MemoryProcessBatch {
  id: string;
  charId: string;
  processedAt: number;
  lastMessageId: number;    // 处理到哪条消息
  extractedCount: number;   // 提取了多少条记忆
  mergedCount: number;      // 合并了多少条
  log: string[];            // 整理日志（用户可见）
}

// ============ Cognitive Architecture (认知架构) ============

/** 情绪层 — 三层栈中的单个情绪 */
export interface EmotionLayer {
    id: string;
    ontologyId: string;           // 映射到 EmotionOntology 的 ID
    depth: 'surface' | 'middle' | 'deep';
    intensity: number;            // 0-1
    nuance?: string;              // 修饰语，如 "隐隐的"
    sourceTimestamp: number;      // 产生时间
    sourceContext?: string;       // 来源上下文描述
}

/** 情绪状态 — 三层栈的完整快照 */
export interface EmotionState {
    layers: EmotionLayer[];
    lastUpdatedAt: number;
}

/** 情绪标签 — 杏仁核或规则引擎输出，用于喂给 EmotionDynamicsEngine */
export interface EmotionalTag {
    ontologyId: string;
    depth: 'surface' | 'middle' | 'deep';
    intensity: number;            // 0-1
    nuance?: string;
    sourceContext?: string;
}

/** 感知数据包 — 感官输入层的输出 */
export interface PerceptionPacket {
    timestamp: number;
    timeOfDay: 'early_morning' | 'morning' | 'afternoon' | 'evening' | 'night' | 'late_night';
    timeSinceLastMessage: number;     // ms
    isFirstMessageToday: boolean;
    gapFromLastSessionHours: number;  // 距离上次 session 的小时数

    messageText: string;
    messageLength: number;
    messageLengthDelta: number;       // 相对于用户平均消息长度的偏差比

    punctuation: {
        ellipsisCount: number;
        exclamationCount: number;
        questionCount: number;
        hasMultiplePunctuation: boolean;
    };
    emotionKeywordHits: string[];     // 命中的 ontologyId 列表
    emotionKeywordCount: number;
    isRapidFire: boolean;             // 连续短间隔消息检测
}

/** 情绪历史快照 — 用于时间线可视化 */
export interface EmotionHistorySnapshot {
    id: string;
    charId: string;
    timestamp: number;
    state: EmotionState;
    trigger?: string;                 // 什么事件触发的快照
}

/** 跨事件关联 — 三级升级系统 */
export interface CrossEventLink {
    id: string;
    charId: string;
    memoryA: string;                  // 记忆 A 的 ID 或描述
    memoryB: string;                  // 记忆 B 的 ID 或描述
    pattern: string;                  // 发现的关联模式描述
    confidence: number;               // 0-1
    level: 'L1_observation' | 'L2_hypothesis' | 'L3_stable';
    observationCount: number;
    firstSeen: number;
    lastSeen: number;
    promotedAt?: number;
}

/** 未解决张力 */
export interface Tension {
    id: string;
    charId: string;
    description: string;
    relatedMemories: string[];
    intensity: number;                // 0-1
    createdAt: number;
    lastRevisited: number;
    revisitCount: number;
    status: 'active' | 'resolving' | 'resolved' | 'dormant';
    resolutionAttempts: string[];
}

/** 人格结晶 */
export interface PersonalityCrystal {
    id: string;
    charId: string;
    trait: string;                    // 涌现特质描述
    evidence: string[];               // 支撑证据
    strength: number;                 // 0-1
    reinforcementCount: number;
    status: 'provisional' | 'active' | 'rejected';
    createdAt: number;
    lastReinforcedAt: number;
    periodsSurvived: number;
}

/** 内心独白日志 */
export interface InnerMonologueEntry {
    id: string;
    charId: string;
    timestamp: number;
    content: string;
    type: 'realtime' | 'daily_review' | 'reflection';
    relatedMessageIds?: number[];
}

/** 用户认知模型 — UserRoom 中对用户的理解 */
export interface UserCognitiveModel {
    charId: string;
    personality: {
        traits: { trait: string; confidence: number; evidence: string[]; lastUpdated: number }[];
        attachmentStyle?: { style: string; confidence: number; evidence: string[] };
    };
    relationships: {
        people: { name: string; relation: string; sentimentToward: number; mentions: number }[];
    };
    triggers: {
        topics: { topic: string; reaction: string; intensity: number; evidence: string[] }[];
    };
    communicationPatterns: {
        patterns: { pattern: string; confidence: number; examples: string[] }[];
        averageMessageLength: number;
        activeHours: { hour: number; frequency: number }[];
    };
    lastUpdatedAt: number;
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
    /** 认知架构开关 — 开启后使用三层情绪栈 + 杏仁核 + 海马体 + 人格结晶 */
    cognitiveArchEnabled?: boolean;
    api?: {
      baseUrl: string;
      apiKey: string;
      model: string;
    };
  };
}

export interface GroupProfile {
    id: string;
    name: string;
    members: string[]; 
    avatar?: string; 
    createdAt: number;
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
    createdAt: number;
    lastPlayedAt: number;
}

export type MessageType = 'text' | 'image' | 'emoji' | 'interaction' | 'transfer' | 'system' | 'social_card' | 'chat_forward' | 'xhs_card' | 'score_card';

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
    apiPresets?: ApiPreset[];
    availableModels?: string[];
    realtimeConfig?: RealtimeConfig;  // 实时感知配置（天气/新闻/Notion）
    customIcons?: Record<string, string>;
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
    serverUrl: string;  // MCP: "http://localhost:18060/mcp" | Skills: "http://localhost:18061/api"
    loggedInUserId?: string;   // 登录用户的 user_id，连接测试成功后自动获取
    loggedInNickname?: string; // 登录用户的昵称
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
    chainFromId?: string;
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
