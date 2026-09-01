
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
  WorldHome = 'world_home', // 家园 — 同世界观多角色共同生活的大世界（观测驱动演绎，每角色独立 LLM 调用 + NPC 世界引擎）
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

export type ScheduleCardPresetId =
  | 'original'
  | 'cream'
  | 'sakura'
  | 'mint'
  | 'twilight'
  | 'midnight'
  | 'custom';

/** 全局日程卡片皮肤：所有桌面组件、房间页与聊天日程弹窗共用。 */
export interface ScheduleCardAppearance {
  preset?: ScheduleCardPresetId;
  /** preset='custom' 时使用；支持颜色或 CSS 渐变。 */
  background?: string;
  textColor?: string;
  accentColor?: string;
  /** 仅允许 .sully-schedule-* 作用域的进阶美化。 */
  customCss?: string;
}

export type JournalAppearancePresetId =
  | 'original'
  | 'letterpress'
  | 'sakura'
  | 'forest'
  | 'midnight';

/** 交换日记 App 的全局皮肤。预设负责开箱即用，自定义 CSS 最后注入并可覆盖预设。 */
export interface JournalAppearance {
  preset?: JournalAppearancePresetId;
  /** 仅允许 .sully-journal-* 作用域，避免样式影响其它 App。 */
  customCss?: string;
}

export interface OSTheme {
  hue: number;
  saturation: number;
  lightness: number;
  wallpaper: string;
  /** 独立锁屏壁纸；未设置时跟随桌面 wallpaper。 */
  lockWallpaper?: string;
  darkMode: boolean;
  contentColor?: string;
  /** 冷启动时是否播放整机开机过场。默认开启（undefined 视为 true）。 */
  bootAnimationEnabled?: boolean;
  /** 进入聊天或切换角色时是否播放角色登场过场。默认开启。 */
  chatCharacterSwitchAnimationEnabled?: boolean;
  /** App 代码块加载较慢时是否显示加载柔光动画。默认开启；超时恢复页不受影响。 */
  appLoadingAnimationEnabled?: boolean;
  /** 桌面整体皮肤。'animalcrossing' = 动森风格（NookPhone 彩色圆角图标 + 暖色界面）；
   *  'mobilegame' = 二次元手游首页风格（角色卡 + 等级经验条 + 货币栏 + 网格卡 + 罗盘 dock）；
   *  'tamagotchi' = 电子宠物养成机（桌面即角色的小屋舞台 + 四颗糖果实体键）。默认 'default'。 */
  skin?: 'default' | 'animalcrossing' | 'mobilegame' | 'tamagotchi' | 'companion';
  /** 默认桌面的视觉版本：纸感是现行默认，nostalgia 是用户主动选择的最初粉绿白玻璃界面。 */
  desktopVariant?: 'paper' | 'nostalgia';
  /** 动森皮肤下，聊天 App 是否也跟随换成动森界面。默认 true（undefined 视为 true）。关掉则聊天保持原样式。 */
  acnhChatSync?: boolean;
  launcherWidgetImage?: string; // DEPRECATED: always stripped on load — never renders.
  launcherWidgets?: Record<string, string>; // slots: 'tl' | 'tr' | 'wide' | 'dsq' (legacy 'bl' / 'br' are banned)
  /** 默认桌面长按编辑后的 App / Dock / 第二页风车组件顺序。 */
  launcherAppOrder?: string[];
  launcherDockOrder?: string[];
  launcherPinwheelOrder?: Array<'music' | 'appsA' | 'appsB' | 'image'>;
  /** 自定义透明图标是否保留原始轮廓并移除系统圆角底框。默认 false。 */
  preserveCustomIconOutlines?: boolean;
  /** 默认皮肤桌面「正在播放」音乐卡片改用浅色系样式（新安装默认 true）。 */
  nowPlayingWidgetLight?: boolean;
  /** 日程卡片统一皮肤：桌面、全屏、房间与聊天内同步。 */
  scheduleCardAppearance?: ScheduleCardAppearance;
  /** 交换日记 App 全局皮肤与自定义 CSS。 */
  journalAppearance?: JournalAppearance;
  desktopDecorations?: DesktopDecoration[];
  customFont?: string;
  /** 顶部时间栏布局：安全显示（安全区下方）/ 紧凑显示（嵌入安全区）/ 完全隐藏。 */
  statusBarMode?: 'standard' | 'compact' | 'hidden';
  /** @deprecated 旧版两档开关，仅用于兼容已有存档；新设置写入 statusBarMode。 */
  hideStatusBar?: boolean;
  // Chat UI customization (global)
  chatAvatarShape?: 'circle' | 'rounded' | 'square';
  chatAvatarSize?: 'small' | 'medium' | 'large';
  /** 聊天表情包大小三挡：小 96px（默认）/ 中 128px / 大 160px（旧版尺寸）。经 --sully-emoji-size CSS 变量生效 */
  chatEmojiSize?: 'small' | 'medium' | 'large';
  chatAvatarMode?: 'grouped' | 'every_message';
  /** 头像位置：气泡旁（默认）/ 每轮消息组上方（固定每轮一次） */
  chatAvatarPlacement?: 'beside' | 'above_group';
  // ── 聊天细节微调（外观 → 聊天细节）。收编自社区白框美化 CSS，全部可选，缺省 = 现状。
  //    经 utils/chatFineTuneCss.ts 生成 CSS 注入 .sully-chat-root；用户自定义白框 CSS 排在其后可覆盖。
  /** 头像显示：双侧 / 隐藏角色侧 / 隐藏用户侧 / 全部隐藏 */
  chatAvatarVisibility?: 'both' | 'hide_ai' | 'hide_user' | 'hide_both';
  /** 头像与气泡的对齐：底部（默认）/ 顶部 / 垂直居中 */
  chatAvatarAlign?: 'bottom' | 'top' | 'center';
  /** 头像垂直微调 px（负上正下），0/undefined = 不调 */
  chatAvatarOffsetY?: number;
  /** 气泡正文字号 px，0/undefined = 默认 */
  chatBubbleFontSize?: number;
  /** 气泡正文行距（如 1.35），0/undefined = 默认 */
  chatBubbleLineHeight?: number;
  /** 气泡与头像侧的间距 px，0/undefined = 默认（48px） */
  chatBubbleIndent?: number;
  /** 隐藏头像的一侧是否贴边（收回头像空位） */
  chatSnapToEdge?: boolean;
  /** HTML 卡片 / 心象卡片 / 音乐卡片的出现位置：缺省/'center' = 水平居中（默认），'anchor' = 贴气泡列
   *  （头像位，不随贴边/缩进挪动，即旧版观感）。经 MessageItem 布局属性生效（不走注入 CSS），
   *  同属聊天细节微调字段、可按角色覆盖 */
  chatModuleAlign?: 'anchor' | 'center';
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
  /** 聊天「白框」自定义 CSS：作用于 .sully-chat-root 下的顶栏、输入栏与消息布局钩子。
   *  可换色 / 贴图 / 改外形 / 挪位；稳定选择器清单见 ChromeCssEditor。 */
  chatChromeCustomCss?: string;
  /** 全局默认「白框提示音」：某角色未单独设提示音时回落到这里。src 同角色版（内置 key / 音频直链 / data:audio）。 */
  chatSound?: { src: string; volume?: number };
  /** 隐藏顶栏的情绪 buff 栏。 */
  chatHideHeaderBuffs?: boolean;
}

/** 聊天细节微调字段（外观 App「聊天细节微调」区块），可整组按角色覆盖。
 *  与 OSTheme 同名字段一一对应，经 utils/chatFineTuneCss.ts 生成 CSS。 */
export type ChatFineTuneFields = Pick<OSTheme,
  'chatAvatarVisibility' | 'chatAvatarPlacement' | 'chatAvatarAlign' | 'chatAvatarOffsetY' |
  'chatBubbleFontSize' | 'chatBubbleLineHeight' | 'chatBubbleIndent' | 'chatSnapToEdge' |
  'chatModuleAlign'>;

/** 角色级「聊天装扮」覆盖：enabled=true 才生效；生效时已定义的字段逐个覆盖全局，
 *  未定义的字段跟随全局（合并规则见 utils/chatFineTuneCss.ts 的 mergeChatFineTune）。 */
export interface ChatFineTuneOverride extends ChatFineTuneFields {
  enabled?: boolean;
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

// 语音合成（TTS）服务商。全局三选一：切换后聊天语音条 / 约会 / 电话统一用同一家。
export type TtsProvider = 'minimax' | 'fishaudio' | 'elevenlabs';

export interface VisionApiConfig {
  /** 开启后，聊天图片先由独立视觉模型转成文字，再交给主对话模型。 */
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface APIConfig {
  baseUrl: string;
  apiKey: string;
  // 可选识图中转：给不支持 image_url 的主模型补视觉能力。
  visionApi?: VisionApiConfig;
  minimaxApiKey?: string;
  minimaxGroupId?: string;
  // 'domestic' → https://api.minimaxi.com (国内站)
  // 'overseas' → https://api.minimax.io  (海外站)
  // Missing / unknown falls back to domestic.
  minimaxRegion?: MinimaxRegion;
  // 语音服务商三选一。缺省 → 'minimax'。
  ttsProvider?: TtsProvider;
  // 鱼声 Fish Audio API Key（https://fish.audio/）。仅 ttsProvider === 'fishaudio' 时使用。
  fishAudioApiKey?: string;
  // 鱼声默认模型（s2.1-pro / s2-pro / s1）。缺省 → 's2.1-pro'。
  // 角色 voiceProfile.fishModel 优先于这个全局默认。
  fishAudioModel?: string;
  // ElevenLabs BYOK 配置。Voice ID 存在角色 voiceProfile.elevenLabsVoiceId，避免角色串音色。
  elevenLabsApiKey?: string;
  // 缺省使用低延迟 eleven_flash_v2_5；也支持 eleven_v3 / eleven_multilingual_v2。
  elevenLabsModel?: string;
  // ElevenLabs Voice Settings（请求级覆盖，不修改 ElevenLabs 控制台里的音色默认值）。
  elevenLabsStability?: number;
  elevenLabsSimilarityBoost?: number;
  elevenLabsStyle?: number;
  elevenLabsUseSpeakerBoost?: boolean;
  // 用户自定义「语音表演指南」——注入到角色 system prompt、教模型怎么写出有情绪的语音台词。
  // minimax / fishaudio / elevenlabs：聊天 + 电话共用，按 TTS 服务商分别存；
  //   留空 → 用内置默认（minimaxTts.VOICE_ACTING_GUIDE / fishAudioTts.FISH_VOICE_ACTING_GUIDE）。
  // dateVoice：见面（DateApp）专用的 [v:xxx] 语音情绪规则，与服务商无关、单独一份；
  //   留空 → 用内置默认（datePrompts.DATE_VOICE_GUIDE）。
  // 在「设置 → 其他 API → 语音提示词」里二次编辑，存 localStorage（随 apiConfig）。
  voicePrompts?: {
    minimax?: string;
    fishaudio?: string;
    elevenlabs?: string;
    dateVoice?: string;
  };
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

export type ActiveMsg2Mode = 'fixed' | 'auto' | 'prompted';
export type ActiveMsg2Recurrence = 'none' | 'daily' | 'weekly';

export interface ActiveMsg2ApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ActiveMsg2GlobalConfig {
  userId: string;
  /** 单用户 Cloudflare Worker 地址，例如 https://amsg.your-worker.dev */
  workerUrl: string;
  /** 与 worker 约定的共享密钥；配了就每次请求带 X-Client-Token，缺/错 worker 返回 401 */
  serverToken?: string;
  /**
   * 一键部署时生成的 AMSG_MASTER_KEY（worker 侧用它加密任务内容）。
   * 存在这里只为「重装时沿用同一把」——它一换，之前加密进 D1 的任务就全解不开了，
   * 而 worker 里的值读不回来。手动部署的用户这里是空的，属正常。
   */
  masterKey?: string;
  /** 上次「连接」（在 worker 端建表）成功的时间 */
  initializedAt?: number;
  /**
   * 即时对话：聊天的每一轮都交给云端跑（POST /instant-chat），回复走推送回来。
   * 只在设置页那一处开关（开关本身还有连接 / 通知权限 / worker 能力三道门），
   * 关掉就是现在的本地直连生成。
   */
  instantChatEnabled?: boolean;
  /**
   * 上一次**明确探到**的「那台 Worker 真的跑得动即时对话吗」
   * （见 ActiveMsgClient.probeInstantChatSupportDetailed）。
   *
   * 只有问到了答案才会写这里：200 + instantTick 写 true，200 但没有 instantTick 写 false。
   * 网络异常、超时、401、5xx 一律不写——那些说明的是线路或配置有问题，不是这台 Worker
   * 的能力，拿它们判死刑的话一次抖动就能把即时对话长期钉死在本地生成。
   *
   * false 时即时对话让位给本地生成，**用户开着也不走** —— 跑不动的 Worker 上这条路是
   * 发一条挂一条，让位比让他对着「已开启」干等强。发消息路上会带冷却地现探一次，
   * 用户更新完 Worker 后自己就翻回来了，不用手动去重开开关。
   *
   * undefined = 还没探过（刚装、没进过设置页），按放行处理：这一档说明我们不知道，
   * 而不是知道它不行；握手时会补探一次，之后就有准数了。
   */
  instantChatSupported?: boolean;
  /**
   * 上一次探到的「这台 Worker 能不能把 LLM 凭据存成表里的一行」
   * （GET /capabilities 的 features 含 'llm-credentials'，见 ActiveMsgClient.probeLlmCredentialsSupport）。
   *
   * 达标时排程 / 即时对话只在任务里带一个引用名，换 Key 只要覆盖那一行，已排的任务
   * （含角色自己排的）下次触发自动跟上；不达标就把凭据照旧冻结进任务体。
   *
   * undefined / false 都按「不达标」处理：老路在哪台 Worker 上都跑得通，宁可多冻结
   * 一份凭据，也不要拿新写法去撞一台还不认识它的 Worker。握手时会探一次。
   */
  llmCredentialsSupported?: boolean;
  updatedAt?: number;
}

export type ActiveMsg2ExpirePolicy = 'expire' | 'force';
export type ActiveMsg2TaskSource = 'user' | 'character';
/** scheduled=待触发/循环中；cancelled 仅短暂存在（取消即从清单移除）。到点后的
 *  一次性任务不改 status——「已发送/已作废」由消息历史现场推导，避免 React 外写角色数据。 */
export type ActiveMsg2TaskStatus = 'scheduled' | 'cancelled';

export interface ActiveMsg2TaskRecord {
  taskUuid: string;
  /** 客户端排程前自造的 uuid v4，与 push metadata 的 amsgClientTaskId 同源——送达归属匹配键。 */
  clientTaskId: string;
  mode: ActiveMsg2Mode;
  /** ISO / datetime-local 字符串，首次触发时间。 */
  firstSendTime: string;
  /**
   * 远端算出来的下一次触发时刻（对账时同步回来）。循环任务按角色所在时区的墙钟推进，
   * 本地拿固定周期自己乘出来的那个一跨夏令时就会偏一小时——显示以这份为准。
   */
  nextSendAt?: string;
  recurrenceType: ActiveMsg2Recurrence;
  /** fixed 模式的固定内容。 */
  userMessage?: string;
  promptHint?: string;
  /** 防穿帮策略；fixed 任务恒为 'force'（见 amsg2Tasks.resolveExpirePolicy）。 */
  expirePolicy: ActiveMsg2ExpirePolicy;
  source: ActiveMsg2TaskSource;
  status: ActiveMsg2TaskStatus;
  createdAt: number;
  lastError?: string;
}

export interface ActiveMsg2CharacterConfig {
  enabled: boolean;
  /**
   * 即时对话按角色单独关。undefined = 跟随全局（全局即时对话开着就默认开）；
   * false = 这个角色的聊天回到本地前台生成。与 enabled（排程开关）互相独立：
   * 可以只排程不即时，也可以只即时不排程。
   */
  instantChatEnabled?: boolean;
  /** 多任务清单（用户在面板建的和角色用工具建的并存），见 utils/amsg2Tasks.ts。 */
  tasks?: ActiveMsg2TaskRecord[];
  /** ↓ 角色级共享设置（所有任务共用）。 */
  maxTokens?: number;
  /**
   * 「我没回的时候，TA 最多连续主动发几条」。0 = 不限；没设 = 默认值
   * （amsgFirePack.DEFAULT_MAX_UNANSWERED_SENDS）。管的是角色自己排的后续
   * （含 fire 里的自排链），用户在面板里亲手排的任务不受它管；用户一回复就重新计数。
   */
  maxUnansweredSends?: number;
  useSecondaryApi?: boolean;
  secondaryApi?: ActiveMsg2ApiConfig;
  lastSyncedAt?: number;
  lastError?: string;
}

/** 任务「没了」的回执台账（amsg-local IDB kv，按角色一条数组）。 */
export interface Amsg2ExpiredNoticeRecord {
  /**
   * 防穿帮闸作废：一次性任务 = taskUuid，循环任务 = `${taskUuid}:${occurrenceMs}`；
   * 用户手动取消 = `${taskUuid}:cancelled`（同一条任务可能两件事都发生过，各占一条）。
   */
  id: string;
  charId: string;
  occurrenceMs: number;
  mode: ActiveMsg2Mode;
  promptHint?: string;
  recurrenceType: ActiveMsg2Recurrence;
  /**
   * 这条回执是怎么来的：闸自动作废（缺省）还是用户在面板里手动取消。
   * 两者给角色的交代不一样——作废可以续期补上，手动取消是用户不要了。
   */
  kind?: 'expired' | 'user-cancelled';
  /** 已注入过排程现状块（角色已知情），不再重复注入。 */
  notifiedAt?: number;
  createdAt: number;
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
  /**
   * 任务身份，由库盖在 push 顶层带下来（不是排程方写进 metadata 的）。
   * 两条排程路径——用户在面板排的、角色在 fire 里给自己排的——走的是同一份，
   * 所以防穿帮闸和任务认领都读这里，不读 metadata 里各自抄的那份。
   */
  taskUuid?: string | null;
  recurrenceType?: string | null;
  /** 本次触发的名义时刻（epoch 毫秒）。 */
  occurrenceMs?: number | null;
  metadata?: Record<string, any>;
  sentAt?: number;
  receivedAt: number;
  /**
   * 已经尝试处理过几次（见 activeMsgRuntime 的 MAX_INBOX_PROCESS_ATTEMPTS）。
   * 处理失败时消息会写回收件箱等重试，这个计数决定什么时候放弃重试、退回存原稿保底。
   */
  processAttempts?: number;
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
  weatherApiKey: string;  // OpenWeatherMap API Key（可选；留空走免 key 的 Open-Meteo）
  weatherCity: string;    // 城市名（如 "北京"、"Beijing"）

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
  /**
   * 实验管线总开关。旧备份没有这一块时按全部关闭处理，确保升级后行为不突变。
   */
  featureFlags?: MemoryPalaceFeatureFlags;
}

export interface MemoryPalaceFeatureFlags {
  recallRouter: boolean;
  interactionAdaptation: boolean;
  deepEngagement: boolean;
  /** 预留的薄事实约束层，不属于 M3 Deep Engagement。 */
  epistemicState: boolean;
}

/**
 * 角色在 ChatApp 里愿意向用户当前交流步伐靠近多少。每维 0..1；这是角色属性，
 * 不是用户状态。缺省时使用保守默认值，且不会从角色实际回复中自动学习。
 */
export interface CharacterAccommodationPolicy {
  length?: number;
  rhythm?: number;
  energy?: number;
  punctuation?: number;
  emoji?: number;
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

export interface CompanionAvatarConfig {
  version: 1;
  /** Shared desktop/video visual source: model uses VRM/Live2D; upload/date use a flat portrait. */
  source: 'model' | 'upload' | 'date';
  /** Original PNG / GIF stored in blob_assets. Kept while switching sources. */
  imageRef?: string;
  fileName?: string;
  mimeType?: string;
  importedAt?: number;
  /** Uploaded portraits kept in the wardrobe. The top-level image fields point at the active item. */
  imageWardrobe?: Array<{
    id: string;
    imageRef: string;
    fileName?: string;
    mimeType?: string;
    importedAt?: number;
  }>;
  /** Independent from Date mode's active outfit; desktop and video calls share this selected outfit. */
  skinSetId?: string;
}

// 见面模式文风配置。由「场景布置」面板调整，datePrompts 构建 VN 提示词时读取，
// 改动即时生效于后续生成（system prompt 每次请求重建）。
export interface DateStyleConfig {
  /** 写作风格预设 id，见 datePrompts.DATE_STYLE_PRESETS；缺省 = cinematic（电影感） */
  style?: string;
  /** 叙事人称：third-name=「B看着A」 third-you=「B看着你」 first-you=「我看着你」；缺省 = 不注入人称指令 */
  pov?: 'third-name' | 'third-you' | 'first-you';
  /** 细节深挖引导：教模型从任意输入里挖素材 + 每轮轮换聚焦线索，对冲"没话找话"式的模型八股；缺省 = 开启 */
  digDeeper?: boolean;
  /** 自定义补充文风要求，原样追加进风格块 */
  extra?: string;
}

export interface RoomItem {
    id: string;
    name: string;
    /** rug=地毯：永远铺在最底层，角色与其它家具都压在它上面 */
    type: 'furniture' | 'decor' | 'rug';
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

/** 小剧场的一拍（one beat）：一行叙述 / 动作 / 台词，emotion 是该行氛围标记（emoji 或短词）。 */
export interface TheaterLine {
    emotion?: string;   // 该行的氛围标记，渲染成小标签（一个 emoji 或 2-4 字短词）
    text: string;       // 这一拍的叙述 / 动作 / 台词
}

/**
 * 小剧场（窥视演出）。挂在某个 ScheduleSlot 上：用户点该时段的播放按钮，
 * 第三人称「上帝视角」生成角色在这个时间点的一小段行为演出，逐行播放。
 * 生成一次即缓存进 slot，可反复重看，不重复烧 token。
 */
export interface SlotTheater {
    lines: TheaterLine[];
    mood?: string;        // 整段演出的氛围一句话（可选，展示用）
    generatedAt: number;
}

export interface ScheduleSlot {
    startTime: string;    // "08:00"
    activity: string;     // "晨跑"
    description?: string; // "在河边慢跑"
    emoji?: string;       // "🏃"
    location?: string;    // "河边"
    innerThought?: string; // 该时段的内心独白，生成时由AI写好，运行时直接注入
    theater?: SlotTheater; // 该时段的小剧场（窥视演出），按需生成并缓存
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
    /** 四角独立圆角；未设置的角继续跟随 borderRadius，兼容旧主题。 */
    borderTopLeftRadius?: number;
    borderTopRightRadius?: number;
    borderBottomRightRadius?: number;
    borderBottomLeftRadius?: number;
    /** 自定义 CSS 伪元素尾巴的出现频率。旧主题缺省为 every，新建主题默认 last。 */
    tailMode?: 'every' | 'last' | 'none';
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
    layout?: 'generic' | 'shop' | 'feed' | 'forum' | 'novel'; // 参考样板 UI 风格，默认 generic
}

export interface PhoneEvidence {
    id: string;
    type: 'chat' | 'order' | 'social' | 'delivery' | string;
    title: string;
    detail: string;
    timestamp: number;
    systemMessageId?: number;
    value?: string;
    /** 人际关系系统：本条记录归属的联系人（phoneState.contacts 里的 id） */
    contactId?: string;
}

/**
 * 人际关系系统 · 联系人。
 * 角色（机主）通讯录里的一个人，可能是神经链接里真实存在的角色（real），
 * 也可能是纯按人设虚构的路人（npc）。
 */
/** 聊天话题盒的一条总结记忆（某一侧第一人称、带主观色彩，由一段原文浓缩而来；可编辑/删除） */
export interface ConvTopic {
    id: string;
    text: string;
    createdAt: number;
    /** 这条记忆浓缩了多少条原文（信息用） */
    span?: number;
}

export interface PhoneContact {
    id: string;
    name: string;
    /** 身份/关系标签，如「辅导员」「中间人」 */
    identity?: string;
    /** identity 是否由用户手动确认；确认后自动扫描不得覆盖（即使用户选择留空） */
    identityManual?: boolean;
    /** 机主对此人的备注（用户/机主手写的「已确立事实」，对话里当真遵守，不被自动覆盖） */
    note?: string;
    /**
     * 机主通过相处「逐渐了解到」的关于此人的认识——由对话里 [[了解:…]] 累积而来。
     * 注意：这是机主的「印象/判断」，来源是对方在聊天里自己说的，**未必属实**（对方可能在编）。
     * 与 note（事实）分开存、分开注入。
     */
    learned?: string;
    /**
     * 聊天话题盒：这一侧（第一人称、带主观色彩）对这段对话的**总结记忆**。
     * 每聊满 100 条触发一次总结、追加一条；用作聊天上下文（原文从上下文里隐藏，但仍存 record.detail 供用户查看）。
     * 可长按删除/修改。
     */
    topicBox?: ConvTopic[];
    /** 已被总结归档的原文条数（水位线）：record.detail 里这之前的内容不再进上下文，只进话题盒 */
    archivedThru?: number;
    avatar?: string;
    /** 真假甄别结果：real=神经链接里真有这人；npc=纯虚构 */
    kind: 'real' | 'npc';
    /** kind==='real' 时绑定的真实角色 id（指向 characters 里的某个角色） */
    linkedCharId?: string;
    /** 机主对此人的好感度，-100..100（负=厌恶，可触发自动删友；正=亲近） */
    affinity: number;
    /** 关系状态 */
    status: 'friend' | 'pending' | 'blocked' | 'deleted';
    lastInteraction?: number;
    createdAt: number;
}

/**
 * 智能体 App · AI 服务种类。机主（被查手机的角色）自己也在玩 AI：
 * - assistant：工具型 AI 助手（豆包/通义/ChatGPT 那种），问实用 & 尴尬问题。
 * - claude：树洞型深度对话 AI（Claude 那种），说当面不会说的真心话。
 * - tavern：酒馆 / SillyTavern 式 AI 角色扮演，自己捏卡跟 AI 对戏。
 */
export type AiServiceKind = 'assistant' | 'claude' | 'tavern';

/** 智能体 App · 一段机主与 AI 的会话（被偷看到的记录） */
export interface AiSession {
    id: string;
    service: AiServiceKind;
    /** 服务/对象名：助手名(豆包) / 树洞名(Claude) / 酒馆卡片名 */
    serviceName: string;
    /** 会话标题（在聊什么） */
    title: string;
    /**
     * 对话脚本，「我:/对方:」逐行（走 parseTranscript 无损解析）。
     * assistant/claude：我=机主，对方=AI。
     * tavern：我=机主(玩家)，对方=AI 扮演的卡片角色。
     */
    transcript: string;
    /** tavern：关联的角色卡 id */
    cardId?: string;
    /** 长会话自动总结出的「前情提要」（参考 TRPG：超 100 条触发，把旧剧情压成小说梗概） */
    summaries?: { id: string; content: string; createdAt: number }[];
    /** 被折叠归档的旧原文（不删除，UI 可展开回看；总结后从 transcript 移到这里） */
    archived?: string;
    updatedAt: number;
}

/** 智能体 App · 机主在酒馆里建的角色卡 */
export interface TavernCard {
    id: string;
    name: string;
    /** 卡类型：character=单个角色卡；world=大型世界卡（跑团/修仙/西幻等） */
    kind?: 'character' | 'world';
    /** 角色人设 / 世界设定 */
    persona: string;
    /** 剧情背景 / 初始场景（酒馆的 scenario） */
    scenario?: string;
    emoji: string;
    /** 是否照着用户（查手机的人）捏的——最偷窥感的一项 */
    basedOnUser?: boolean;
    /** 这张卡照着谁捏的（现实里 TA 在意的某个人的名字）：可能是用户，也可能是 TA 人设/羁绊里更深的某个人 */
    basedOn?: string;
    createdAt: number;
}

// 「人格模拟」演出运行时脚本模型（生成后驱动播放，也用于生活记录重播）
export type SimBeatKind = 'lock' | 'thought' | 'notification' | 'app' | 'flashback' | 'end';
export interface SimBeat {
    time?: string;
    kind: SimBeatKind;
    monologue?: string;
    pace?: 1 | 2 | 3;
    vibe?: 'calm' | 'chaotic' | 'happy' | 'anxious' | 'numb' | 'tender';
    notif?: { app: string; title: string; body: string; tone?: 'push' | 'sms' | 'system' | 'flashback' };
    app?: {
        name: string;
        view: 'chat' | 'search' | 'photo' | 'music' | 'notes' | 'browser' | 'weather' | 'compose' | 'generic';
        chat?: { name: string; lines: { me: boolean; text: string }[] };
        search?: { engine?: string; queries: { q: string; deleted?: boolean }[] };
        photo?: { caption?: string; date?: string; tint?: string };
        music?: { song: string; artist: string; state?: string };
        notes?: { title?: string; items: string[] };
        browser?: { tabs: string[] };
        weather?: { city: string; temp: number; desc: string };
        compose?: { to?: string; drafts: string[]; sent?: string | null };
        text?: string;
    };
    flashback?: { label?: string; caption?: string; date?: string; tint?: string };
}
export interface SimScript {
    title: string;
    ending?: string;
    beats: SimBeat[];
    summary: string;
    buff?: { name?: string; label: string; emoji?: string; color?: string; intensity?: 1 | 2 | 3; description?: string };
}

// 「人格模拟」演出结束后写入「生活记录」的一条留存（角色不记得，仅作为用户的体验档案）
export interface PhoneSimLog {
    id: string;
    mode: 'daily' | 'event';
    theme: string;        // 体验内容（如「平凡的周二」）
    title: string;        // 演出标题
    summary: string;      // 收尾留白文字
    ending?: string;      // 多结局版本标签
    beatsCount: number;
    buff?: { label: string; emoji?: string; color?: string };
    memoryText?: string;  // 演出可读梗概，作为回忆发给角色时用（让角色真的"知道"发生了什么）
    timestamp: number;
    script?: SimScript;   // 完整脚本快照——存在则「生活记录」可原样重播（旧记录没有，仅可发送）
}

// ============================================================
//  梦境演出系统 (Dream Theater) — 偷看一场角色已经忘记的梦。
//  与「人格模拟」演出不同：梦不写实、不连贯、允许中度幻觉与矛盾，
//  以拼贴诗 / 电影字幕 / 碎片记忆的方式呈现，留白与沉默本身就是演出。
// ============================================================
export type DreamArchetype =
    | 'sweet'      // 甜梦
    | 'nightmare'  // 噩梦
    | 'flower'     // 花之梦
    | 'flying'     // 飞翔之梦
    | 'falling'    // 坠落之梦
    | 'starry'     // 星空之梦
    | 'ocean'      // 海之梦
    | 'childhood'  // 童年之梦
    | 'anxiety'    // 焦虑之梦
    | 'forgotten'  // 遗忘之梦
    | 'prophetic'  // 预言之梦
    | 'lucid'      // 清醒梦
    | 'deepsleep'; // 隐藏 · 深眠（无梦，沉默即是奖励）

// 一个梦境碎片 —— 不同 kind 决定它在屏幕上的排版与呈现方式
export type DreamFragmentKind =
    | 'line'       // 一句飘过的字幕
    | 'word'       // 单字 / 单词，巨大、孤立
    | 'silence'    // 留白 · 沉默（空行，长停顿）
    | 'repeat'     // 同一个词反复
    | 'dialogue'   // 极短的对话碎片
    | 'stage'      // 舞台提示（[门在微笑]）
    | 'list'       // 清单
    | 'screenplay' // 剧本片段
    | 'diary'      // 日记残页
    | 'message'    // 发给无人的消息
    | 'image';     // 象征性画面 + 配文

export interface DreamFragment {
    kind: DreamFragmentKind;
    text?: string;          // line / word / stage / diary / message / repeat 的词
    lines?: string[];       // dialogue / list / screenplay 的多行
    count?: number;         // repeat 的重复次数
    caption?: string;       // image 的配文
    date?: string;          // diary / image 的模糊日期口径
    tint?: string;          // image 的色调 hex
    emphasis?: 'whisper' | 'normal' | 'loud' | 'fade'; // 视觉强弱
    align?: 'left' | 'center' | 'right';
    pace?: 1 | 2 | 3;       // 停留时长：1 普通 / 2 稍慢 / 3 漫长
}

export interface DreamScript {
    archetype: DreamArchetype;
    title?: string;         // 梦的标题（可以晦涩、诗意）
    fragments: DreamFragment[];
    afterglow?: string;     // 醒来时残留的感觉（留白，不解释）
    buff?: { name?: string; label: string; emoji?: string; color?: string; intensity?: 1 | 2 | 3; description?: string };
}

// 一场梦的留存（角色不记得，仅作为用户偷看到的档案 · 「梦的残页」）
export interface DreamLog {
    id: string;
    archetype: DreamArchetype;
    title?: string;
    afterglow?: string;
    fragmentsCount: number;
    buff?: { label: string; emoji?: string; color?: string };
    timestamp: number;
    script?: DreamScript;   // 完整快照 → 可原样重看
}

export type WorldbookPosition = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type WorldbookDepthRole = 0 | 1 | 2;
export type WorldbookSelectiveLogic = 0 | 1 | 2 | 3;

export interface WorldbookEntryConfig {
    /** Primary activation keywords. Empty for constant entries. */
    key?: string[];
    /** Optional secondary activation keywords. */
    keysecondary?: string[];
    /** Always active when true; legacy SullyOS entries default to true. */
    constant?: boolean;
    selective?: boolean;
    selectiveLogic?: WorldbookSelectiveLogic;
    order?: number;
    position?: WorldbookPosition;
    disable?: boolean;
    probability?: number;
    useProbability?: boolean;
    depth?: number;
    role?: WorldbookDepthRole | null;
    scanDepth?: number | null;
    caseSensitive?: boolean | null;
    matchWholeWords?: boolean | null;
    sourceUid?: number;
}

export interface MountedWorldbook extends WorldbookEntryConfig {
    id: string;
    title: string;
    content: string;
    category?: string;
}

export interface Worldbook extends WorldbookEntryConfig {
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
export type VRRoomId = 'library' | 'music' | 'guestbook' | 'gym' | 'postoffice' | 'theater' | 'signal' | 'sar' | 'cafe';

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
    /** 用户为该角色圈定的优先书单。为空时从全书库自动轮换。 */
    preferredNovelIds?: string[];
    /** 上一次图书馆活动选中的小说，用于有其它候选时避免连续读同一本。 */
    lastNovelId?: string;
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
    // --- 信号坠落处（跨用户接龙诗）专用 ---
    /** 这次贡献所在的诗的标题 */
    poemTitle?: string;
    /** 这次写下的那一句 */
    signalLine?: string;
    /** 这一句在诗里是第几句（1-based） */
    poemLineSeq?: number;
    /** 这首诗 roll 到的总篇幅（句数） */
    poemTargetLines?: number;
    /** 本次是「起新篇」（写标题+第一句）还是「接龙」（续一句） */
    signalIsNew?: boolean;
    /** 截至本次贡献后这首诗的全文（逐句），供卡片展示 */
    poemLinesSoFar?: string[];
    /** 所在册子的标题（如「低电量合唱」），UI 展示 */
    bookletTitle?: string;
    /** 用户参与时留给角色的耳语（不进诗，只随卡片进聊天/记忆） */
    signalWhisper?: string;
}

// ============================================================
// 信号坠落处（VR 房间 'signal'）—— 跨用户接龙现代诗
// ============================================================
// 复用漂流瓶（post-office worker）的匿名 deviceId / 笔名马赛克 / 限流基建，
// 但走独立的 po_poems / po_poem_lines 表。一本册子定死规格（多少首诗 /
// 每首 roll 几句 / 每句几字），所有用户的角色共写同一份「当前」诗：读到
// 的永远是最新全文，谁登入谁接一句，写满篇幅即封存进诗集。user 不参与。

/** 信号坠落处的一句（来自某用户某角色，跨实例匿名）。 */
export interface SignalPoemLine {
    seq: number;
    pen: string;
    content: string;
    createdAt: number;
    /** 仅当请求带本机 device 时由后端标注：这一句是不是「我的 char」写的（认领用，不暴露别人 device） */
    mine?: boolean;
}

/** 一首接龙诗（后端是源头，前端按需拉取）。 */
export interface SignalPoem {
    id: string;
    bookletId: string;
    title: string;
    /** 发起者拟的主题/方向（给后来者接龙做参考的一段引导） */
    brief?: string;
    /** roll 到的篇幅（总句数） */
    targetLines: number;
    /** 已有句数 */
    lineCount: number;
    status: 'open' | 'sealed';
    lines: SignalPoemLine[];
    createdAt: number;
    sealedAt?: number;
    /** 仅当请求带本机 device 时：这首诗里有几句是「我的」（>0 = 我参与过，星图打光晕） */
    mineCount?: number;
}

/** 一本册子（容器 + 规格）。 */
export interface SignalBooklet {
    id: string;
    title: string;
    subtitle?: string;
    theme?: string;
    /** 写满多少首诗算这本完成 */
    poemsTarget: number;
    /** 已封存诗数 */
    poemCount: number;
    /** 每首诗句数 roll 区间 */
    linesMin: number;
    linesMax: number;
    /** 每句字数上限 */
    charsPerLine: number;
    status: 'open' | 'done';
    createdAt: number;
}

// ============================================================
// 家园（WorldHome）—— 同世界观多角色共同生活的大世界
// ============================================================

/**
 * user 在该世界里的存在感模式：
 * - light: 轻度——只是观察角色的一个切面，角色依旧以 user 为最重要的人（与 chatapp 聊天人设一致）
 * - medium: 中度——user 是世界中普通的一份子，不特殊
 * - heavy: 重度——user 不存在 / 是透明的幽灵，演绎中完全无视（通常用于看角色之间的关系）
 */
export type WorldHomeMode = 'light' | 'medium' | 'heavy';

/**
 * 时间模式（与存在感模式 WorldHomeMode 正交，创建时单独选）：
 * - real: 真实时间——演绎进各角色的聊天与记忆（world_card），适合「真实系角色」。
 *         真实使用里中间会穿插大量真人聊天，卡片自然稀疏，不会刷屏。
 * - sim:  模拟时间——可自定义起始年月日，**不进记忆/聊天**；适合给 OC 们开小剧场图一乐。
 *         每 20 天（= 80 轮，一天四段：早/中/晚/凌晨）自动结一卷：生成一份小说体总结（含人物关系动态走向
 *         与评价），归档这 20 天原文，往后只把「该角色单方面视角的总结 + ta 最后一天 +
 *         本卷沉淀的氛围」分开喂回各角色——避免角色被迫开上帝视角。
 */
export type WorldTimeMode = 'real' | 'sim';

/** 模拟时间的起始日期（sim 模式专用）。 */
export interface WorldSimDate {
    year: number;
    month: number;
    day: number;
}

/** 世界里的 NPC：没有记忆系统，完全服务于世界观，由"世界引擎"一次 LLM 调用全部演绎。 */
export interface WorldNPC {
    id: string;
    name: string;
    /** 一句话人设（职业/性格/与谁有关） */
    persona: string;
    /** 可视化兜底 emoji（NPC 不走捏人系统） */
    emoji?: string;
}

/** 居住安排：一间小屋及其住户。不在任何小屋里的成员视为独居（各自的小屋）。 */
export interface WorldHouse {
    id: string;
    name: string;
    residentIds: string[];
}

/** 成员（或 NPC）之间的**有向**关系条：from 对 to 的看法，与 to 对 from 的可以不对等。 */
export interface WorldRelationship {
    fromId: string;
    toId: string;
    /** from 眼中这段关系的名字（我视ta为挚友 / ta是我死对头…），用户可编辑，演绎不强行改 */
    label?: string;
    /** 0-100，from 对 to 的好感/亲近度，演绎产出的 delta 会落在这里 */
    value: number;
}

/** 世界内消息（私聊/群聊通用）。fromId 可以是成员 charId 或 NPC id。 */
export interface WorldChatMessage {
    id: string;
    fromId: string;
    fromName: string;
    text: string;
    /** 发出时的轮数与剧情时间（手机 UI 按轮分隔显示） */
    round: number;
    storyTime: string;
    timestamp: number;
}

/**
 * 世界内消息线程。这是"手机是真手机"的落点：
 * A 先演绎时发出的私聊/群聊立刻落线程，B 后演绎时就能在自己的手机上下文里
 * 看到并回应——消息跨角色、跨轮交替传递，而不是各自的独白。
 */
export interface WorldThread {
    /** dm 线程 id = 'dm_' + 两个 charId 排序后拼接；群聊 = 'group_main' */
    id: string;
    kind: 'dm' | 'group';
    /** 群聊名（dm 不用） */
    name?: string;
    memberIds: string[];
    messages: WorldChatMessage[];
}

/** 大段正文的文风。 */
export type WorldNarrativeStyle = 'warm' | 'inner' | 'drama' | 'breezy' | 'sitcom' | 'custom';

/**
 * 伏笔：角色这半天瞒下的事（timeline 里 shared=false 对应的内幕）。
 * 躺在世界的伏笔栏里，用户可点击"引爆"——下一轮演绎时注入给被瞒者
 * （你发现了…）与当事人（你瞒的事败露了…），生成冲突。
 */
export interface WorldSeed {
    id: string;
    charId: string;
    charName: string;
    /** 瞒下的事 */
    text: string;
    /** 瞒着谁（成员名；空数组 = 瞒着所有人） */
    hideFrom: string[];
    round: number;
    storyTime: string;
    /** pending=躺着 / armed=用户已点引爆，下一轮爆发 / resolved=已爆发 */
    status: 'pending' | 'armed' | 'resolved';
}

/**
 * 用户对某角色"内心冲动"的决策/留言（想辞职？想告白？）。
 * 下一轮演绎时以"内心的声音"注入该角色（light 模式下会联想到 user），注入后消费掉。
 */
export interface WorldDirective {
    id: string;
    charId: string;
    /** 冲动原文（注入时引用） */
    impulseText: string;
    /** 用户的意见 */
    text: string;
    createdRound: number;
}

/** 一个"世界"的完整定义（IndexedDB worlds 表）。 */
export interface WorldProfile {
    id: string;
    name: string;
    /** 世界观总述（这个世界是什么样的，发生在哪，大家以什么身份生活） */
    worldview: string;
    mode: WorldHomeMode;
    /** 时间模式（创建时选定，默认 real 真实时间；旧世界无此字段时按 real 处理） */
    timeMode?: WorldTimeMode;
    /** sim 模式的起始日期（不设时按创建当天） */
    simStartDate?: WorldSimDate;
    /** real 模式：这个世界活在哪个时区（IANA id，如 'Asia/Tokyo'）。不设 = 跟随本机。
     *  一个世界只有一个钟——它同时决定「早/中/晚/凌晨」的段判定、离线 tick 的触发时刻，
     *  并**覆盖**成员各自的 customTimezone（同一个世界里的人不可能各活一个时区，
     *  否则世界钟和角色 prompt 里的「当前时间」会互相打架）。sim 模式不使用此字段。 */
    timezone?: string;
    /** real 模式：世界已演到的「现实段」（早/中/晚/凌晨跟着真实时钟走）。dayKey=YYYY-MM-DD，
     *  seg=0早/1中/2晚/3凌晨（凌晨发生在 dayKey **次日**的 0~5 点，排在该剧情日末尾以保证段序单调）。
     *  只能补当天错过的段，过了今天就补不了；未演过时为空。 */
    realClock?: { dayKey: string; seg: number };
    /** sim 模式：已被卷入章节总结的剧情时钟数（round ≤ 此值的原文已归档，不再喂原文） */
    simSummarizedClock?: number;
    /** sim 模式：每 20 天结一卷的章节总结（按 index 升序累积；最新一卷参与下一卷的上文喂养） */
    chapters?: WorldChapter[];
    /** 大段正文的文风（默认 warm 细腻日常） */
    narrativeStyle?: WorldNarrativeStyle;
    /** narrativeStyle='custom' 时的自定义文风提示词 */
    narrativeStyleCustom?: string;
    /** 大段正文的叙述人称：first=第一人称(我) / second=第二人称(你) / third=第三人称(名字/ta)。默认 first */
    narrationPerson?: 'first' | 'second' | 'third';
    /** 参与的角色（CharacterProfile.id） */
    memberIds: string[];
    npcs: WorldNPC[];
    houses: WorldHouse[];
    relationships: WorldRelationship[];
    /** 世界内消息线程（私聊 + 世界群聊），随演绎累积，每线程截留最近若干条 */
    threads?: WorldThread[];
    /** 伏笔栏 */
    seeds?: WorldSeed[];
    /** 待注入的用户决策（消费后移除） */
    directives?: WorldDirective[];
    /** 社交动态的互动：key = `${round}_${charId}_${postIdx}`，值含点赞数 + 评论（NPC/路人）。 */
    feedReactions?: Record<string, { likes: number; comments: { from: string; text: string }[] }>;
    /** 每天离线 tick 的时段（凌晨/早/午/晚），空数组 = 仅手动观测推进 */
    offlineTickSlots?: ('latenight' | 'morning' | 'noon' | 'evening')[];
    /** 剧情时钟：累计推进的段数（0 = 第1天早上；一天四段：早/中/晚/凌晨） */
    storyClock: number;
    /** storyClock/simSummarizedClock 的「每天段数」版本：旧存档（无此字段）= 3 段（早中晚），
     *  4 = 含凌晨的四段制。加载/演绎时经 migrateWorldDaySegs 自动迁移。 */
    clockSegs?: number;
    /** 生成内容是否注入各成员的 1v1 聊天（默认 true） */
    injectToChat?: boolean;
    /** 该世界专属 API 覆盖；不设则回落全局 apiConfig */
    api?: { baseUrl: string; apiKey: string; model: string };
    createdAt: number;
    updatedAt: number;
}

/** 一轮演绎中单个角色的产出（一次独立 LLM 调用，确保没人开上帝视角）。 */
export interface WorldCharBeat {
    charId: string;
    charName: string;
    /** 角色根据环境自判定的主要位置 */
    location: string;
    /** 大段正文：聚焦一件有意义的事/一次内心拉扯（按世界设定的文风），私人视角，不外传 */
    narrative: string;
    /** 心情（一两个词） */
    mood: string;
    /** 数值面板（体力/心情值/自定义键） */
    statusPanel?: Record<string, number | string>;
    /**
     * 这半天的具体时间轴。shared=false 的条目是角色想瞒着的——
     * 不会传递给其他角色，并会被提炼进伏笔栏（secrets）。
     */
    timeline?: { time: string; place: string; event: string; shared: boolean }[];
    /** 备忘录（完全私人：只有本人和屏幕外的用户看得到） */
    memo?: string[];
    /** 状态背后的冲动/待决策（想辞职/想告白…），用户可以帮忙拿主意 */
    impulse?: { text: string; options?: string[] };
    /** 瞒下的事（→ 伏笔栏）。hideFrom 空数组 = 瞒所有人 */
    secrets?: { text: string; hideFrom?: string[] }[];
    /** 手机内容（dms/group 会立刻落进 world.threads，链内后续角色与下一轮都能收到） */
    phone?: {
        posts?: string[];
        dms?: { to: string; lines: string[] }[];
        /** 发到世界群聊的话 */
        group?: string[];
    };
    /** 共处时当面对在场成员说的话（不是手机）——对话对象的演绎轮里会完整听到并被要求回应 */
    dialogues?: { with: string; lines: string[] }[];
    /** 本轮产出的关系变化（按名字回填到 world.relationships）。newLabel：仅在关系重大转折时，
     *  角色对这段关系的新看法/称呼（覆盖 label，平时不给）。 */
    relationshipDeltas?: { withName: string; delta: number; reason?: string; newLabel?: string }[];
}

/** 一轮演绎（"观测"或离线 tick 触发，推进半天剧情时间；IndexedDB world_episodes 表）。 */
export interface WorldEpisode {
    id: string;
    worldId: string;
    /** 第几轮（= 演绎完成后的 storyClock） */
    round: number;
    /** 剧情时间标签（第N天 白天/夜晚） */
    storyTime: string;
    trigger: 'observe' | 'tick';
    /** NPC 群像（一次调用全部 NPC） */
    npcScene?: string;
    /** NPC 留下的、可被下一轮角色接住的事件钩子 */
    npcHooks?: string[];
    beats: WorldCharBeat[];
    /** 本轮没演出来（LLM 调用/解析失败）的成员 charId——UI 提示用户可重 roll */
    failedCharIds?: string[];
    /** 机械拼接的本轮梗概，喂给下一轮做连续性 */
    summary: string;
    createdAt: number;
}

/**
 * sim（模拟时间）模式下每 20 天结的一卷「章节总结」。
 *
 * 喂养路径（同样严格防上帝视角）：
 *   - synopsis / relationshipEval：全知小说体梗概，**只给屏幕外的用户看**（图一乐），绝不喂角色。
 *   - atmosphere：这一卷沉淀下来的氛围基调，可喂给所有角色（不含隐私）。
 *   - perspectives[charId]：每个角色「单方面视角」的回顾——只含 ta 知道/经历的，
 *     往后单独喂回对应角色，作为 ta 对这 20 天的记忆。
 *   - lastDayBeats：每个角色这一卷最后一天的 beat，连同其单视角总结作为下一卷的上文。
 */
export interface WorldChapter {
    id: string;
    worldId: string;
    /** 第几卷（1 起） */
    index: number;
    /** 覆盖的剧情时钟区间（含） */
    fromClock: number;
    toClock: number;
    /** 区间起止的时间文本（sim 模式是日期） */
    fromLabel: string;
    toLabel: string;
    /** 全知小说体梗概（给用户看，含人物关系动态走向与评价） */
    synopsis: string;
    /** 关系网这一卷的走向评价 */
    relationshipEval?: string;
    /** 这一卷沉淀的氛围基调（影响下一卷，喂给所有角色） */
    atmosphere?: string;
    /** 每个角色的单方面视角总结（分开喂回各自） */
    perspectives: { charId: string; charName: string; text: string }[];
    /** 每个角色这一卷最后一天的 beat（作为下一卷上文） */
    lastDayBeats: WorldCharBeat[];
    createdAt: number;
}

/** 注入聊天的 world_card 消息的 metadata 结构。 */
export interface WorldCardMeta {
    worldCard: true;
    worldId: string;
    worldName: string;
    mode: WorldHomeMode;
    round: number;
    storyTime: string;
    location?: string;
    mood?: string;
    narrative?: string;
    statusPanel?: Record<string, number | string>;
    timeline?: { time: string; place: string; event: string; shared: boolean }[];
    memo?: string[];
    impulse?: { text: string; options?: string[] };
    phonePosts?: string[];
    /** 发到世界群聊的话 */
    phoneGroup?: string[];
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

// ============ 剧院 / 话剧部门 ============

/** 剧本里的一个登场角色（名字 + 大致性格，供选角匹配/演绎用）。 */
export interface VRPlayRole {
    name: string;
    persona: string;
}

/** 一份投稿剧本（角色创作 / 用户写 / LLM 代写 / 上传）。 */
export interface VRScript {
    id: string;
    title: string;
    /** 一句话简介（"创作了关于 xxx 的舞台剧"用） */
    logline: string;
    roles: VRPlayRole[];
    /** 完整剧本正文（固定格式：幕/场 + 角色台词 + （旁白）） */
    body: string;
    /** 作者 id：'user' | charId | 'llm' */
    authorId: string;
    authorName: string;
    source: 'char' | 'user' | 'llm' | 'upload';
    createdAt: number;
}

/** 编排时的 LLM 调用模式：逐角色各调一次（精准，N 次）/ 固定两次（省，可能 OOC）。 */
export type VRStageMode = 'per-role' | 'two-call';

/** 选角：剧本角色 → 演员（char 或 临时 NPC）。 */
export interface VRCastAssign {
    roleName: string;
    actorId: string;   // charId | npc_xxx
    actorName: string;
    isNpc: boolean;
    /** NPC 的捏脸立绘（透明 PNG dataUrl） */
    npcChibi?: string;
}

/** 某演员读完剧本后给导演的意见（吐槽 / 改台词动作 / 配不配合）。 */
export interface VRActorNote {
    actorId: string;
    actorName: string;
    roleName: string;
    /** 一句吐槽 / 想法（UI 展示） */
    note: string;
    /** 角色按自己本色重写过的"我这部分台词 / 怎么演"（可空 = 照原本演） */
    lines?: string;
    /** 绝对禁忌：导演绝不能让该角色做的事（硬红线，可空） */
    taboo?: string;
    /** 给导演的写作指导（这条线该怎么处理，可空） */
    direction?: string;
    /** 态度光谱：欣然 / 配合 / 勉强 / 隐忍 / 抵触 / 拒演（按角色性子自然落点，不必都硬刚） */
    attitude?: string;
    /** 是否配合（由 attitude 推导：抵触/拒演 = false） */
    cooperative: boolean;
}

/** 最终演出脚本的一拍（台词气泡 / 旁白 / 上场 / 下场）。 */
export interface VRStageLine {
    kind: 'line' | 'narration' | 'enter' | 'exit';
    /** line/enter/exit 时是谁 */
    actorName?: string;
    /** 台词气泡内容 / 旁白文字 */
    text: string;
}

/** 一场已收录的演出（导演整合后的成品 + 观众锐评 + 评级）。 */
export interface VRStagedPlay {
    id: string;
    scriptId: string;
    title: string;
    logline: string;
    cast: VRCastAssign[];
    notes: VRActorNote[];
    /** 导演整合后的可演出脚本 */
    stage: VRStageLine[];
    /** 赛博观众锐评 */
    reviews: { critic: string; text: string }[];
    /** 评级（如 S / A / ★★★★☆） */
    rating: string;
    createdAt: number;
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
    /**
     * 部件投到下方图层上的阴影（如刘海投在耳发/脸上的影子）。
     * 透明 PNG data URL，同尺寸/同锚点；PSD 里的正片叠底层导入时已预转成
     * 黑色+alpha 的普通图层，渲染时垫在本部件颜色层下方、不参与染色。
     */
    shadowSrc?: string;
    createdAt: number;
}

// --- SONGWRITING APP TYPES ---
export type SongMood = 'happy' | 'sad' | 'romantic' | 'angry' | 'chill' | 'epic' | 'nostalgic' | 'dreamy';
export type SongGenre = 'pop' | 'rock' | 'ballad' | 'rap' | 'folk' | 'electronic' | 'jazz' | 'rnb' | 'free';
export type LyricCoWritingStyle =
    | 'adaptive'
    | 'mandopop'
    | 'guofeng'
    | 'opera-wave'
    | 'cantopop'
    | 'folk'
    | 'indie-rock'
    | 'hiphop'
    | 'rnb'
    | 'vocaloid'
    | 'dark-waltz'
    | 'anime-op'
    | 'anime-ed'
    | 'denpa-kawaii'
    | 'jpop'
    | 'city-pop'
    | 'jrock'
    | 'kpop'
    | 'k-rnb'
    | 'western-pop'
    | 'edm'
    | 'alt-pop'
    | 'funk-disco'
    | 'pop-punk'
    | 'musical';

export interface SongLine {
    id: string;
    authorId: string; // 'user' or charId
    content: string;
    section: 'intro' | 'verse' | 'pre-chorus' | 'chorus' | 'bridge' | 'outro' | 'free';
    /** Stable position inside a fixed/custom lyric template. Legacy lines fall back to array order. */
    slotIndex?: number;
    annotation?: string; // AI guidance note on this line
    timestamp: number;
    isDraft?: boolean; // true = not selected as final lyrics, kept as draft record
}

export interface SongTemplateSection {
    section: SongLine['section'];
    lines: number;
    chars: string;
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
    // User-authored structure used when lyricTemplate === 'custom'.
    customLyricTemplate?: SongTemplateSection[];
    // Writing grammar used by the AI lyric editor. This is intentionally
    // separate from audio genre: one genre can be co-written in many styles.
    lyricCoWritingStyle?: LyricCoWritingStyle;
    // Optional user-uploaded artwork. Usually a blobref: token.
    coverImage?: string;
}

// --- DATE APP TYPES ---
export interface DialogueItem {
    text: string;
    /** 立绘情绪 key（[happy]/[sad]/…）—— 只驱动立绘表情，不再直接当语音情绪。 */
    emotion?: string;
    /** 语音情绪，来自独立标记 [v:xxx]，跟立绘分开。仅取合法 MiniMax emotion，否则 undefined。 */
    voiceEmotion?: string;
}

/**
 * 「观测协议 OBSERVE」结构化观测数据：开启后由 LLM 在正文最前面输出一段
 * ⟦OBSERVE⟧ 块，前端解析成这四个维度，渲染成可独立查看的全息 HUD。
 * 所有字段可缺省——模型偶尔漏写某项时不应让面板崩掉。
 */
export interface DateObservation {
    /** 时间：结合场景的当前时刻（不一定等于系统时间） */
    time?: string;
    /** 地点：角色此刻所在的具体地点 */
    place?: string;
    /** 状态：角色的身心状态 */
    state?: string;
    /** 细节：正在发生的动作 / 微小细节 */
    detail?: string;
    /** 用户追加的自定义维度的值，按 DateObserveCustomField.id 存 */
    extra?: Record<string, string>;
}

/**
 * 观测协议追加的自定义维度（在 时间/地点/状态/细节 之外另开一格）。
 * label 同时是「线格式字段名」和「HUD 标签」——解析时按 label 匹配回该维度。
 */
export interface DateObserveCustomField {
    id: string;        // 稳定 id，作为 DateObservation.extra 的 key
    label: string;     // 字段名 / HUD 标签（如「天气」「穿着」）
    hint?: string;     // 生成提示：这一格写什么
    enabled?: boolean; // 默认 true
}

/** 观测协议 OBSERVE 的 HUD 视觉样式 id */
export type DateObserveStyleId = 'hologram' | 'ink' | 'neon' | 'crystal' | 'terminal';

/**
 * 观测协议单个维度的自定义：显示标签 + 生成提示 + 是否启用。任一项留空即回落默认。
 * 注意：自定义 label 只影响 HUD 展示——注入提示词时字段名始终用固定中文 key
 * （时间/地点/状态/细节），保证解析稳定，用户改名不会让 extractObservation 失配。
 */
export interface DateObserveFieldConfig {
    /** HUD 上显示的标签（仅展示用，不参与解析） */
    label?: string;
    /** 注入提示词：这个维度具体要生成什么内容 */
    hint?: string;
    /** 是否启用该维度（默认 true）。关掉则不注入提示、HUD 也不渲染该行。 */
    enabled?: boolean;
}

/** 观测协议 OBSERVE 的 per-character 配置 */
export interface DateObserveConfig {
    enabled?: boolean;
    /** HUD 视觉样式，默认 hologram */
    style?: DateObserveStyleId;
    /** 四个维度的标签 / 提示自定义；不填回落默认值 */
    fields?: Partial<Record<keyof DateObservation, DateObserveFieldConfig>>;
    /** 用户追加的自定义维度（在四个默认维度之外） */
    custom?: DateObserveCustomField[];
}

export interface DateState {
    dialogueQueue: DialogueItem[];
    dialogueBatch: DialogueItem[];
    currentText: string;
    /** @deprecated 旧版恢复快照会复制背景图，可能是超大 base64；新版恢复优先读角色上的 dateBackground。 */
    bgImage?: string;
    /** @deprecated 旧版恢复快照会复制立绘图，可能是超大 base64；新版恢复优先读 currentSpriteKey。 */
    currentSprite?: string;
    /** 当前立绘对应的情绪 key，只存引用信息，避免把 base64 立绘重复塞进 savedDateState。 */
    currentSpriteKey?: string;
    /** 恢复时优先按当时的皮肤集找 currentSpriteKey，皮肤不存在再回退当前皮肤/默认立绘。 */
    activeSkinSetId?: string;
    isNovelMode: boolean;
    timestamp: number;
    peekStatus: string;
    /** 当前批次解析出的观测数据（开了 OBSERVE 才有），用于恢复会话时回填 HUD */
    observation?: DateObservation;
}

// ─── 见面 · 剧情剧场 ────────────────────────────────────────────────

/** 独立剧场达到水位后，旧正文的归档去向。切换策略只影响之后的新归档。 */
export type StoryTheaterArchiveStrategy = 'summary' | 'vector';

export interface StoryTheaterArchive {
    id: string;
    strategy: StoryTheaterArchiveStrategy;
    fromMessageId: number;
    toMessageId: number;
    messageCount: number;
    /** summary 策略的事件盒正文；vector 策略留空，由独立 charId 分区召回。 */
    summary?: string;
    createdAt: number;
}

/** 剧场里用户所扮演的身份；已有角色按 characterId 动态读取，自定义身份来自面具箱。 */
export type StoryTheaterMaskSelection =
    | { type: 'user' }
    | { type: 'character'; id: string }
    | { type: 'custom'; id: string };

/** 独立于用户档案与神经链接的可复用原创人物身份。 */
export interface StoryTheaterMask {
    id: string;
    name: string;
    avatar?: string;
    description: string;
    coreInstruction?: string;
    worldview?: string;
    createdAt: number;
    updatedAt: number;
}

/**
 * 一条可反复进入的剧情。演员与世界书只保存 id/沙盒选择，不反写外部挂载配置。
 * 消息正文复用 messages 表，charId 使用 `story-theater:${id}` 独立线程；仅显式开启时镜像到角色记忆流。
 */
export interface StoryTheaterEntry {
    id: string;
    title: string;
    premise: string;
    /** 谁写下本剧情第一段：用户当前身份或模型故事正文。 */
    openingMode?: 'user' | 'assistant';
    /** 本剧情中用户执笔的身份；缺省时使用真实用户档案。 */
    mask?: StoryTheaterMaskSelection;
    characterIds: string[];
    /** true=像【陪伴】一样，把第三人称正文分别写入每个角色的正常记忆流。 */
    writesToCharacterMemory: boolean;
    /** 每位演员各自的剧情时间锚点（datetime-local 字符串），允许跨时区/跨世界线。 */
    characterMemoryDates: Record<string, string>;
    /** 虚构剧场的记忆输入开关；真实陪伴固定为 true。 */
    carryCharacterMemory: boolean;
    /** 携带记忆时，每位演员附带的最近原文条数，默认 100。 */
    characterContextLimits: Record<string, number>;
    /** 独立剧场累计多少条未归档正文后触发归档。 */
    archiveAfter: number;
    /** 归档时至少留在会话里的最近楼层数；旧数据默认 5。 */
    archiveKeepRecent?: number;
    archiveStrategy: StoryTheaterArchiveStrategy;
    archives: StoryTheaterArchive[];
    /** 从演员挂载世界书去重得到；只影响本剧情，不改外部挂载。 */
    selectedWorldbookIds: string[];
    presetId?: string;
    /** 会话内快速预设只覆盖本剧场，不修改预设库。 */
    presetOverride?: StoryTheaterPresetDocument;
    /** 仅供拒绝 assistant prefill、要求最后一条消息必须为 user 的接口使用；默认关闭以保留原生预设效果。 */
    forceUserLastMessage?: boolean;
    /** 兼容不接受酒馆高级采样参数的接口；默认关闭，完整发送预设中的 top_p 与两项 penalty。 */
    omitSamplingParams?: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface StoryTheaterPresetPrompt {
    id: string;
    name: string;
    enabled: boolean;
    role: 'system' | 'user' | 'assistant';
    content: string;
    /** marker 由发送器替换为角色/世界书/用户/场景/历史，不把占位条目当普通正文。 */
    marker?: 'characters' | 'world_before' | 'user' | 'world_after' | 'scenario' | 'examples' | 'history';
}

export interface StoryTheaterPresetDocument {
    schema: 'sullyos.story-preset';
    version: 1;
    name: string;
    description?: string;
    generation: {
        temperature: number;
        topP: number;
        frequencyPenalty: number;
        presencePenalty: number;
        maxTokens: number;
    };
    prompts: StoryTheaterPresetPrompt[];
    assistantPrefill?: string;
}

/** 糯米机专属剧情预设。导入器只接受 sullyos.story-preset，不兼容其它应用格式。 */
export interface StoryTheaterPreset {
    id: string;
    name: string;
    sourceFileName?: string;
    format: 'sullyos-story-preset';
    document: StoryTheaterPresetDocument;
    builtIn?: boolean;
    createdAt: number;
    updatedAt: number;
}


export interface SpecialMomentRecord {
    content: string;
    image?: string; // 活动留存的大图，存 blobref 令牌（二进制在 blob_assets）
    timestamp: number;
    source?: 'generated' | 'migrated';
    /** Free-form per-event extra data (e.g. like520 captureface state, anchors, etc.) */
    customData?: Record<string, any>;
}

// --- QQ捏人工坊（神经链接） ---

/** 工坊槽位：room=小小窝房间立绘 / vr=彼方 chibi / like520=特别时光 520 大头贴 */
export type ChibiStudioSlotId = 'room' | 'vr' | 'like520';

export interface ChibiStudioSlot {
    /** 捏人器导出的完整 state（选件+换色+翻转…），再编辑时经 init.savedState 整套还原 */
    state?: any;
    /**
     * 透明 PNG dataURL 兜底展示图。room/vr 的形象本体以各 App 自己的字段为准
     * （sprites.chibi / vrState.chibi.img）；like520 未通关时靠这里展示 + 预填活动捏人器。
     */
    img?: string;
    updatedAt?: number;
}

/**
 * QQ捏人工坊：统一管理一只角色在三处的 Q 版形象，可各捏各的、也可一键同步。
 * 图片本体写进各 App 自己的消费字段，这里主要存「再编辑用的完整 state」。
 */
export interface ChibiStudioData {
    room?: ChibiStudioSlot;
    vr?: ChibiStudioSlot;
    like520?: ChibiStudioSlot;
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

export type CompanionTouchZone = 'head' | 'face' | 'hand' | 'body' | 'other';

export interface AvatarTouchRegion {
  id: string;
  zone: CompanionTouchZone;
  /** Regions are normalized against this Live2D model's rendered bounds, not the screen. */
  shape: 'ellipse';
  /** Ellipse center and size, all in model-local 0..1 coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompanionPerformancePrecision {
  /** Temporarily suspend ambient turns/glances and keep the authored pose authoritative. */
  lockAutonomy?: boolean;
  /** Keep head targets absolute after gesture/emotion overlays. */
  lockHead?: boolean;
  /** Normalized pose targets (-1..1). */
  headX?: number;
  headY?: number;
  headZ?: number;
  eyeX?: number;
  eyeY?: number;
  bodyX?: number;
  bodyY?: number;
  bodyZ?: number;
  /** Small intentional pass beyond the pose before settling, 0..0.2. */
  overshoot?: number;
  /** Time used to enter, pass and settle into the pose. */
  settleMs?: number;
}

export interface CompanionTouchReaction {
  id: string;
  /** Displayed source line. Newly generated companion packs keep this in Simplified Chinese. */
  text: string;
  /** Spoken translation kept separate from the displayed source line. */
  translation?: string;
  /** Persisted local audio generated together with this reaction. */
  voiceAssetId?: string;
  voiceMimeType?: string;
  voiceText?: string;
  voiceLanguage?: string;
  performance: {
    emotion: 'neutral' | 'happy' | 'sad' | 'angry' | 'fearful' | 'disgusted' | 'surprised' | 'calm' | 'relaxed';
    gesture: 'idle' | 'talk' | 'nod' | 'shake' | 'tilt' | 'explain' | 'wave' | 'shy' | 'lean-in' | 'lean-back';
    camera: 'close' | 'medium' | 'wide' | 'push-in' | 'pull-out';
    gaze: 'viewer' | 'left' | 'right' | 'down';
    intensity: number;
    faces?: Array<'wink' | 'grin' | 'pout' | 'blush' | 'eyes-closed' | 'smile-eyes' | 'brow-up' | 'brow-sad' | 'brow-angry'>;
    modelAction?: string;
    modelActions?: string[];
    precision?: CompanionPerformancePrecision;
  };
}

export interface CompanionStartupSettings {
  enabled: boolean;
  /** User-authored or character-generated line; never supplied by a desktop theme. */
  line: string;
  /** User-authored spoken translation. Empty means speak the source line. */
  translation?: string;
  /** Empty means the source/default language; otherwise a TTS language_boost code. */
  voiceLanguage?: string;
  performance: CompanionTouchReaction['performance'];
  /** Optional LLM-directed beats, scheduled against the actual saved voice duration. */
  performanceCues?: Array<{
    at: number;
    direction: CompanionTouchReaction['performance'];
    endDirection?: CompanionTouchReaction['performance'];
    holdMs?: number;
  }>;
  /** Source + spoken translation signature used to reject stale cue packs. */
  performanceCueText?: string;
  performanceGeneratedAt?: number;
  voiceAssetId?: string;
  voiceMimeType?: string;
  voiceText?: string;
  voiceGeneratedLanguage?: string;
  voiceGeneratedAt?: number;
  generatedAt?: number;
  updatedAt?: number;
}

export interface CompanionStartupPreset {
  id: string;
  name: string;
  startup: CompanionStartupSettings;
  createdAt: number;
  updatedAt: number;
}

export interface CompanionTouchPreset {
  id: string;
  name: string;
  enabledZones: CompanionTouchZone[];
  reactions: Partial<Record<CompanionTouchZone, CompanionTouchReaction[]>>;
  voiceLanguage?: string;
  voiceEnabled?: boolean;
  voiceGeneratedCount?: number;
  generatedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CompanionTouchSettings {
  enabledZones: CompanionTouchZone[];
  reactions: Partial<Record<CompanionTouchZone, CompanionTouchReaction[]>>;
  /** Language used for touch-reaction translations and their persisted voice pack. */
  voiceLanguage?: string;
  startup?: CompanionStartupSettings;
  /** When true, reactions with voiceAssetId play their local pre-generated audio. */
  voiceEnabled?: boolean;
  voiceGeneratedCount?: number;
  generatedAt?: number;
  /** 多套开机演出独立保存；startup 仍是当前实际启用的兼容字段。 */
  startupPresets?: CompanionStartupPreset[];
  activeStartupPresetId?: string;
  /** 多套触摸反馈独立保存；顶层 reactions 等字段仍是当前实际启用包。 */
  touchPresets?: CompanionTouchPreset[];
  activeTouchPresetId?: string;
}

export type MemoryPalaceWaterlinePreset = 'online' | 'balanced' | 'offline' | 'custom';

export interface MemoryPalaceWaterlineConfig {
  preset: MemoryPalaceWaterlinePreset;
  /** 自定义模式保留在热区内的消息数量。 */
  hotZoneSize?: number;
  /** 自定义模式触发下一轮整理前允许积累的缓冲消息数量。 */
  bufferThreshold?: number;
}

export interface CharacterProfile {
  id: string;
  name: string;
  avatar: string;
  /**
   * 视频通话使用的本地 VRM / Live2D 形象。模型二进制包保存在 IndexedDB
   * blob_assets，角色资料只保存轻量索引，避免把数 MB 的模型塞进
   * localStorage / React state。
   */
  videoAvatar?: {
      version: 1;
      format: 'vrm';
      assetId: string;
      fileName: string;
      byteLength: number;
      importedAt: number;
      /** 用户在舞台上拖拽/捏合校准的构图；偏移量是相对画布宽高的比例。 */
      framing?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 用户手动锚定的脸部特写构图；close/push-in 镜头直接落到这里，不再按身高比例猜脸的位置。 */
      faceFraming?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 触感陪伴桌面（companion 皮肤）的全屏构图；与通话窗口的 framing 独立保存。 */
      companionFraming?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 陪伴桌面角色可视窗口裁剪；数值为相对舞台宽高的内缩比例。 */
      companionCrop?: {
          top: number;
          right: number;
          bottom: number;
          left: number;
      };
  } | {
      version: 1;
      format: 'live2d';
      assetId: string;
      fileName: string;
      /** 随 SullyOS 发布的静态模型；不依赖 IndexedDB，也不需要进入模型备份。 */
      builtIn?: true;
      /** 相对当前应用根目录的 model3.json；仅 builtIn 模型使用。 */
      builtinModelUrl?: string;
      /** balanced = 2K 默认纹理，hd = 4K 可选纹理。 */
      builtinQuality?: 'balanced' | 'hd';
      /** 导入模型的运行纹理档位；默认 balanced(2K)，源模型最多保留到 4K 以便切换。 */
      textureQuality?: 'balanced' | 'hd';
      /** 内置 Sully 的一次性默认构图迁移版本。 */
      builtinFramingVersion?: 1 | 2;
      /** ZIP 包内 model3.json 的完整相对路径。 */
      modelPath: string;
      byteLength: number;
      fileCount: number;
      importedAt: number;
      /** 源包格式：旧模型使用 STORE，新导入 ZIP 保留原包并按文件流式读取。 */
      runtimePackageEncoding?: 'store-v1' | 'zip-v1';
      /** 自动动作权限策略版本；2 = 安全动作默认加入 AI 动作库。 */
      actionPolicyVersion?: 2;
      /** 用户校准后的 Live2D 舞台构图；偏移量是相对画布宽高的比例。 */
      framing?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 用户手动锚定的脸部特写构图；close/push-in 镜头直接落到这里，不再按启发式猜脸的位置。 */
      faceFraming?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 触感陪伴桌面（companion 皮肤）的全屏构图；与通话窗口的 framing 独立保存。 */
      companionFraming?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 陪伴桌面角色可视窗口裁剪；数值为相对舞台宽高的内缩比例。 */
      companionCrop?: {
          top: number;
          right: number;
          bottom: number;
          left: number;
      };
      /** 用户为这个 Live2D 模型单独圈选的触摸区域；未命中时仍回退模型自己的 HitArea。 */
      touchRegions?: AvatarTouchRegion[];
      /** model3.json Groups 中声明的口型参数；没有声明时使用标准参数。 */
      lipSyncParameterIds: string[];
      /** 每个模型自己的动作/表情权限。AI 只能调用 permission=ai 的项目。 */
      actions: Array<{
          id: string;
          /** params = 用户自建的参数组合动作（VTube Studio 风格），不依赖模型文件。 */
          kind: 'motion' | 'expression' | 'params';
          name: string;
          file: string;
          group?: string;
          index?: number;
          expressionId?: string;
          /** kind=params 时要推到的参数目标值列表。 */
          params?: Array<{ id: string; value: number }>;
          /** motion3/exp3 文件实际写入的参数；用于高质量模式判断能否安全并行动作。 */
          parameterIds?: string[];
          /** exp3 参数目标；衣橱会把这些值作为持久底层，避免表情重置顺带清掉服装。 */
          parameterValues?: Array<{
              id: string;
              value: number;
              blend?: 'Add' | 'Multiply' | 'Overwrite';
          }>;
          /** VTube Studio 中绑定的原始组合键，例如 F1 / Alt+Q。 */
          hotkey?: string;
          source?: 'model3' | 'vtube' | 'discovered' | 'custom';
          /** VTube Studio 的“清除全部表情”热键。 */
          resetExpression?: boolean;
          tags: string[];
          /** 真·衣橱动作：只允许用户手动触发，永远不会进入 LLM 动作白名单。 */
          wardrobe?: boolean;
          permission: 'ai' | 'manual' | 'blocked';
      }>;
      /** 衣橱中最后一次由用户手动选择的服装动作。 */
      activeWardrobeActionId?: string;
  };
  /** Inactive whole-model outfits. Switching swaps one entry with videoAvatar; only matching formats are shown. */
  videoAvatarWardrobe?: Array<NonNullable<CharacterProfile['videoAvatar']>>;
  /** Which character visual the tactile companion desktop should render. */
  companionAvatar?: CompanionAvatarConfig;
  /**
   * 视频通话舞台的自定义背景：`blobref:<id>` 令牌（本地图片，存 IndexedDB
   * blob_assets，备份令牌原样进包、二进制走 blobs/* 旁路）或 http(s) 图床直链。
   * 空 = 默认氛围渐变。
   */
  videoCallBackground?: string;
  /**
   * 触感陪伴桌面（companion 皮肤）的背景：`preset:<id>`（内置华丽渐变场景）、
   * `blobref:<id>` 令牌（本地图片，备份令牌原样进包、二进制走 blobs/* 旁路）
   * 或 http(s) 图床直链。空 = 默认时段天光。
   */
  companionBackground?: string;
  /**
   * 触感陪伴桌面的本地反馈包。用户只在设置中主动生成一次；之后每次触碰
   * 都从这里轮播台词与演出，不再逐次请求主聊天 API。
   */
  companionTouchSettings?: CompanionTouchSettings;
  /**
   * 视频通话演出编排档位：
   * - basic / undefined：主回复模型顺手输出动作指令，不增加请求。
   * - high：情绪 Buff API 只读取角色性格与本轮定稿台词，独立排练动作。
   */
  videoCallPerformanceQuality?: 'basic' | 'high';
  /**
   * 高质量视频通话首次使用时，由副 API 从完整 ContextBuilder 上下文提炼的
   * 短表演人格。之后每轮导演只读取这份缓存（最多 200 字），不再重复携带整份人设。
   * 属本地运行派生数据；角色卡分享时剥离。
   */
  videoCallPerformancePersona?: string;
  videoCallPerformancePersonaGeneratedAt?: number;
  description: string;
  systemPrompt: string;
  worldview?: string;
  /** 角色分组：指向 CharacterGroup.id；空或指向已删分组 = 未分组。仅本地组织用，不随角色卡导出 */
  groupId?: string;
  memories: MemoryFragment[];
  refinedMemories?: Record<string, string>;
  activeMemoryMonths?: string[];
  
  writerPersona?: string;
  writerPersonaGeneratedAt?: number;

  mountedWorldbooks?: MountedWorldbook[];

  impression?: UserImpression;

  bubbleStyle?: string;
  /** 聊天细节微调的角色级覆盖（聊天内「＋」→「聊天装扮」）。
   *  enabled=true 时已定义的字段逐个覆盖全局 OSTheme 同名设置，未定义的字段继续跟随全局；
   *  enabled 为 false/undefined 或整个字段缺省 = 完全跟随全局（现状零变化）。
   *  属美化类本地偏好：随完整备份走，但角色卡分享时剥离（见 utils/characterCard.ts）。 */
  chatFineTune?: ChatFineTuneOverride;
  chatBackground?: string;
  contextLimit?: number;
  /**
   * AI 原文读取范围策略：
   * - adaptive：全自动记忆接管，最大范围从记忆宫殿水位线之后开始；
   * - manual：用户拉杆决定最多读取最近 contextLimit 条完整原文。
   */
  contextRangeMode?: 'adaptive' | 'manual';
  /**
   * 用户主动点「一键存进记忆宫殿」后，让原文范围继续跟随记忆水位线。
   * 与全自动归档开关独立；未使用该按钮的旧角色保持 undefined，不改变既有行为。
   */
  contextFollowsMemoryPalaceHwm?: boolean;
  /** 上下文范围结构版本；用于把旧版「5000 条 + 自动水位隐藏」一次性迁移到自适应模式。 */
  contextRangePolicyVersion?: number;
  /**
   * 用户额外设置的 AI 原文断点。它只能在拉杆/自适应最大范围内进一步缩小，
   * 不能突破最大范围向更早读取；一旦被移动中的最大范围越过便自动失效。
   */
  contextUserStartMessageId?: number;
  hideSystemLogs?: boolean; 
  /** 旧版归档内部隐藏线；新版 AI 原文范围不再拿它当用户断点。 */
  hideBeforeMessageId?: number; 
  
  dateBackground?: string;
  sprites?: Record<string, string>;
  spriteConfig?: SpriteConfig;
  customDateSprites?: string[]; // User-added custom emotion names for date mode (per-character)
  dateLightReading?: boolean;   // Light reading mode for novel/text view in date
  dateReadingShowAvatars?: boolean; // Show both participants' avatars beside messages in date reading mode
  dateSkinSets?: SkinSet[];     // Multiple skin sets for portrait mode
  activeSkinSetId?: string;     // Currently active skin set ID
  dateStyleConfig?: DateStyleConfig; // 见面模式文风（写作风格 / 叙事人称 / 自定义补充）
  /** 观测协议 OBSERVE：开启后每条回复注入「时间/地点/状态/细节」结构化观测，渲染成全息 HUD（样式/字段可自定义） */
  dateObserve?: DateObserveConfig;

  savedDateState?: DateState;
  specialMomentRecords?: Record<string, SpecialMomentRecord>;

  /** QQ捏人工坊（神经链接）：三处 Q 版形象的捏人器 state 与 520 兜底图，见 ChibiStudioData */
  chibiStudio?: ChibiStudioData;

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
      simLogs?: PhoneSimLog[]; // 「生活记录」：人格模拟演出留存
      chatReadAt?: number;     // 上次打开 Messages 的时间戳，用于计算未读
      sendToChat?: boolean;    // 查手机生成的内容是否同步到私聊（默认 true）
      contacts?: PhoneContact[]; // 人际关系系统：机主的通讯录
      allowFictionalContacts?: boolean; // 是否允许生成虚构 NPC 联系人；false=只与神经链接里的真实角色来往（默认 true）
      aiAgent?: {                 // 智能体 App：偷看到的「AI 也在玩 AI」记录
          sessions: AiSession[];
          cards?: TavernCard[];  // 酒馆里建的角色卡
      };
  };

  // 「梦的残页」：在小屋里偷看到的梦境演出留存（角色不记得，仅供用户回看）
  dreamLogs?: DreamLog[];

  voiceProfile?: {
      provider?: 'minimax' | 'custom';
      voiceId?: string;
      // MiniMax 合成参数版本。缺省/legacy 保持历史效果；natural-v2 需由用户主动开启。
      minimaxParamVersion?: 'legacy' | 'natural-v2';
      // 鱼声 Fish Audio 音色：从 fish.audio 语音库复制的 reference_id。
      // 与 MiniMax 的 voiceId 不通用，单独保存，切换 provider 时各取各的。
      fishReferenceId?: string;
      // 该角色单独指定的鱼声模型（覆盖全局 fishAudioModel）。
      fishModel?: string;
      // ElevenLabs 角色音色 ID。与 MiniMax voiceId / Fish reference_id 各存各的。
      elevenLabsVoiceId?: string;
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

  // 自定义时区（异国恋 / 角色身处异国等场景）。与「时间感知强化」完全独立、可任意组合：
  // 开启后，注入给该角色的「当前时间 / 消息时间戳 / 夜间判断」都按 customTimezone 折算，
  // 让 ta 活在自己的本地时间里，并知道与用户之间存在时差。
  customTimezoneEnabled?: boolean;
  customTimezone?: string; // IANA 时区 id，如 'Asia/Tokyo'

  // 线下时间感知（约会 / 见面 App）：开启（默认）时向见面 system prompt 注入「当前真实时间」。
  // 关掉后见面场景不再注入时间，让剧情脱离现实时间线。独立开关。
  dateTimeAwarenessEnabled?: boolean;

  // ─── 生活记录注入（档案 App「生活记录」→ 聊天提示词，per-character）───
  // 总开关：默认关（opt-in）。开启后才注入「用户生活记录」section（潜意识背景约束 +
  // 各模块今日摘要 + [[LIFE:...]] 代记指令说明）。关闭时连指令说明都不给角色看。
  lifeRecordEnabled?: boolean;
  // 小开关：默认开（!== false 即开），受总开关统辖；分别控制对应模块的数据摘要与代记指令。
  lifeRecordPeriodEnabled?: boolean;    // 生理期
  lifeRecordMedEnabled?: boolean;       // 药盒
  lifeRecordExpenseEnabled?: boolean;   // 记账（打通银行 bank_transactions）
  lifeRecordExerciseEnabled?: boolean;  // 锻炼

  // Chat & Date voice TTS settings
  chatVoiceEnabled?: boolean;
  // 收到语音是否自动播放。默认关（不填 = 不自动播）：语音条照常出现，点一下才响。
  // 只管 AI 自动发来的语音；用户主动点「转换语音」/ 点空语音条生成的，仍然生成完就播。
  chatVoiceAutoPlay?: boolean;
  chatVoiceLang?: string;
  dateVoiceEnabled?: boolean;
  dateVoiceLang?: string;
  // Call (voice phone) — remembered translation language for this character
  callVoiceLang?: string;

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
  /**
   * 角色独立的记忆水位节奏。整个角色消息时间线共用这一份配置，不区分私聊、
   * 见面、通话或剧情来源。缺省代表 online，即保持历史行为 200/100。
   * 作为 CharacterProfile 一部分随 IndexedDB 与完整备份持久化。
   */
  memoryPalaceWaterline?: MemoryPalaceWaterlineConfig;
  embeddingConfig?: {
    baseUrl: string;
    apiKey: string;
    model: string;        // 默认 text-embedding-3-small
    dimensions: number;   // 默认 1024
  };
  personalityStyle?: 'emotional' | 'narrative' | 'imagery' | 'analytical';
  ruminationTendency?: number;  // 反刍倾向 0-1，默认 0.3
  /** ChatApp 专属的语言趋同强度；不影响其他 App 的写作人格。 */
  interactionAccommodation?: CharacterAccommodationPolicy;
  memoryPalaceInjection?: string;  // 记忆宫殿检索结果，注入到 System Prompt（运行时填充，不持久化）
  roomPlatesInjection?: string;    // 房间门牌（常驻语义层），注入到 System Prompt（运行时填充，来源 room_plates 表）

  // 自我领悟词条【已冻结，只读遗留】：旧版消化把 self_room 领悟追加到这里，
  // 只进不出、无上限、无合并。新领悟的归宿已改为 self_room 门牌（room_plates），
  // 此字段不再增长；存量仍照常注入 contextBuilder，避免老角色突然"失忆"。
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
  /** 可选：在日常 ChatApp 注入任务优先的协同工作规则。提示词较长，默认关闭。 */
  chatCollaborationEnabled?: boolean;
  /** 该角色专属的聊天「白框」自定义 CSS（叠加在全局 osTheme.chatChromeCustomCss 之上）。 */
  chromeCustomCss?: string;
  /** 白框「提示音」：仅当 ta 新发的消息成为会话最后一条时播放一次。src 可为内置音效 key / 音频直链 / 上传后内联的 data:audio。
   *  存储位置取决于 chatSoundBound：解绑（默认）时独立存于此字段、可单独分享；绑定时写进 chromeCustomCss 的
   *  `/* @sully-sound … *​/` 指令注释、跟白框一起分享。播放时两处择一（指令优先）。 */
  chatSound?: { src: string; volume?: number };
  /** 提示音是否「绑定」到白框：true=提示音随白框 CSS 一起分享（写进指令注释）；false/undefined=独立存于 chatSound、白框分享码保持轻量。 */
  chatSoundBound?: boolean;

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
   * - 'ink'：宣纸底墨色 + 朱印「墨迹」水墨卷轴
   * - 'neon'：深蓝紫底 + 青光扫描线「脑域」赛博终端
   * - 'terminal'：黑底绿字等宽「内核」日志
   * - 'stellar'：深空蓝缀星「星语」夜航
   * - 'tama'：粉壳液晶点阵「心宠」拓麻歌子
   * - 'pixel'：JRPG 白粗框硬影「任务」像素对话框
   * - 'muji'：暖灰米白「独白」性冷淡留白
   * - 'ins'：白卡软影「碎碎念」feed 风
   * - 'custom'：使用 thinkingChainCustomColors 给的配色
   */
  thinkingChainStyle?: 'echo' | 'whisper' | 'minimal' | 'ink' | 'neon' | 'terminal' | 'stellar' | 'tama' | 'pixel' | 'muji' | 'ins' | 'custom';
  /** 自定义风格用的配色组（仅 thinkingChainStyle === 'custom' 生效） */
  thinkingChainCustomColors?: {
    bg?: string;       // 卡片背景
    accent?: string;   // 边框/标题点缀
    text?: string;     // 正文颜色
  };
  /** 用户追加的思考提示词（不替换原生，只在最后追加一段「用户额外要求」） */
  thinkingChainCustomPrompt?: string;
  /**
   * 心象卡片的自定义 CSS（叠加在任意风格之上，机制同气泡工坊 customCss）。
   * 选择器限定以 .sully-psyche 开头（子元素类：-card / -title / -preview / -body），
   * 由 Chat.tsx 原样 <style> 注入。
   */
  thinkingChainCustomCss?: string;

  /**
   * 虚拟世界「彼方」的个人状态：是否自主登入、登入间隔、各本小说的独立书签等。
   * 独立于 proactiveConfig（主动发消息），互不挤占触发。
   */
  vrState?: VRWorldCharState;
}

/**
 * 角色分组（神经链接里的"文件夹"）：纯组织用途，解决角色太多时选择列表过长的问题。
 * 注意与下面的 GroupProfile（群聊）无关——角色通过 CharacterProfile.groupId 指向分组，
 * 删除分组只会让组内角色回到「未分组」，不会删角色。
 */
export interface CharacterGroup {
    id: string;
    name: string;
    /** 排序权重（暂未在 UI 暴露，缺省按 createdAt 先后） */
    order?: number;
    createdAt?: number;
}

export interface GroupProfile {
    id: string;
    name: string;
    members: string[];
    avatar?: string;
    createdAt: number;
    /** 群聊公共话题盒：由热区以前的群消息总结而成，所有成员共享、可编辑/删除。 */
    topicBoxes?: GroupTopicBox[];
    /** 公共话题盒已覆盖到的最后一条群消息 ID；仅用于防止重复成盒，不与任何角色私聊水位混用。 */
    archivedThroughMessageId?: number;
    /** 公共话题盒整理模式：auto 满阈值自动成盒；manual 只累计，用户手动触发。默认 auto。 */
    topicArchiveMode?: 'auto' | 'manual';
    /**
     * 私聊里"近期群活动"上下文从这个群最多取最后多少条消息。
     * 不设默认 80。设大点能让活跃群更完整，设小点节省 token、避免某个活跃群把其他群挤掉。
     */
    privateContextCap?: number;
    /**
     * 群提示词里每个成员"私聊+群聊合并时间线"的条数上限（合并排序后取末 N 条）。
     * 不设默认 40。这条时间线是角色群聊表现与私聊感情衔接的关键上下文。
     */
    memberTimelineCap?: number;
    /**
     * 群回复生成模式：director = 一次调用生成整轮（默认，快、省 token）；
     * roundRobin = 每位成员单独调用一次 API，按成员顺序逐个发言（更真实、防串号，token ≈ 成员数倍）。
     */
    replyMode?: 'director' | 'roundRobin';
    /**
     * 成员独立气泡：true = 每位成员的气泡用其私聊 bubbleStyle 主题的 AI 侧；
     * false/undefined = 全员统一（现状白色）。
     */
    memberBubbleIndependent?: boolean;
    /** 用户在本群的气泡主题 id（预设或 customThemes，取 user 侧）；undefined = 现状紫色 */
    userBubbleThemeId?: string;
    /** 群聊白框自定义 CSS（.sully-chat-* 钩子），与私聊 char.chromeCustomCss 同机制 */
    chromeCustomCss?: string;
    /** 群提示音（未绑定白框时的独立存储）；绑定时以 chromeCustomCss 里的 @sully-sound 注释为准 */
    chatSound?: { src: string; volume?: number };
    /** 提示音是否绑定进白框 CSS（跟着白框分享码走） */
    chatSoundBound?: boolean;
    /** HTML 模块模式：开启后角色可输出 [html] 卡片 */
    htmlModeEnabled?: boolean;
    /** HTML 模式自定义提示词（追加在内置提示词之后） */
    htmlModeCustomPrompt?: string;
}

export interface GroupTopicBox {
    id: string;
    groupId: string;
    title: string;
    summary: string;
    sourceStartMessageId: number;
    sourceEndMessageId: number;
    messageCount: number;
    participants: string[];
    /** 成盒当时收到私聊卡片的成员；成员之后退群，编辑/删除仍能同步其旧卡片。 */
    deliveredMemberIds?: string[];
    createdAt: number;
    updatedAt: number;
}

export interface CharacterExportData extends Omit<CharacterProfile, 'id' | 'memories' | 'refinedMemories' | 'activeMemoryMonths' | 'impression' | 'groupId'> {
    version: number;
    type: 'sully_character_card';
    embeddedTheme?: ChatTheme;
}

export interface UserProfile {
    name: string;
    avatar: string;
    bio: string;
    /** 分角色聊天头像（档案 App 设置）：charId → 头像（http(s) URL 或 data:image）。
     *  私聊里「你」的头像取 perCharAvatars[charId] || avatar（上面的整体头像作宏观默认）；
     *  群聊/其他场合仍用整体头像。删角色留下的孤儿键无害，读取端永远按当前 charId 取。 */
    perCharAvatars?: Record<string, string>;
    /**
     * 用户本人接入「彼方」的状态：捏的 chibi、此刻所在房间、在干嘛。可随时改。
     * enabled=false（登出）时，聊天里给角色的"用户在彼方"提示词随之消失。
     */
    vrState?: UserVRState;
}

export interface UserVRState {
    /** 是否接入彼方（登出后不再向角色注入"用户在彼方"提示） */
    enabled: boolean;
    /** 用户此刻把自己挂在哪个房间 */
    currentRoom?: VRRoomId;
    /** 用户自己写的"在彼方干嘛"，会注入聊天提示词 + 广播成行为卡片 */
    activity?: string;
    /** 最近一次更新时间 */
    updatedAt?: number;
    /** 用户在彼方里的 chibi 形象（同角色 chibi 结构，来自 mode="user" 的捏人器） */
    chibi?: {
        img: string;
        state?: any;
        scale?: number;
        offsetY?: number;
        flip?: boolean;
    };
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
    /** 原图来自聊天时指向消息主键；相册与收藏只关联，不再复制第三份图片。 */
    sourceMessageId?: number;
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

// ─── 生活记录（档案 App「生活记录」：生理期 / 药盒 / 记账 / 锻炼）───
// 注意：内部标识用 LifeRecord，避开 PersonaSim 已占用的「生活记录 simLogs」概念。
// 记账模块不独立存储——直接读写 BankApp 的 bank_transactions；角色代记的支出
// 会额外落一条 module='expense' 的 LifeRecord（带 bankTxId）以支撑卡片确认/否决回滚。

export type LifeRecordModule = 'period' | 'med' | 'expense' | 'exercise';

export interface LifeRecord {
    id: string;
    module: LifeRecordModule;
    /** period: 'start' | 'end'；med: 'taken'；expense: 'expense'；exercise: 'session' */
    kind: string;
    date: string;              // YYYY-MM-DD（事件归属日）
    timestamp: number;
    /**
     * med:      { name, planId?, time? }
     * expense:  { amount, note }（真实流水在 bank_transactions，此处仅镜像展示用）
     * exercise: { activity, duration?, note? }
     * period:   {}
     */
    payload: Record<string, any>;
    /** 'user' = 用户在档案 App 手动记录；否则为代记角色的 charId */
    recordedBy: string;
    recordedByName?: string;
    /**
     * 卡片复核状态（仅角色代记的记录有意义；用户手记直接 'confirmed'）：
     * active = 默认生效（用户未点卡片）；confirmed = 用户点了确认；
     * rejected = 用户否决，不再计入注入摘要，且欠该角色一条反馈。
     */
    reviewStatus: 'active' | 'confirmed' | 'rejected';
    /** 否决后待注入给代记角色的一次性反馈标记，注入后清除 */
    pendingFeedback?: boolean;
    /** expense 专用：对应 bank_transactions 里的流水 id（否决时回滚删除） */
    bankTxId?: string;
    note?: string;
}

/**
 * 药盒「计划」：像设长期闹钟一样只写一次，每天按频率派生"今日待服"
 * （打卡产生 module='med' 的 LifeRecord）。
 * - planKind 'longterm'：长期在服（保健品等），无期限；
 * - planKind 'course'：短期疗程，startDate ~ endDate 之间才生效。
 * - intervalDays：服药频率，1=每天（默认）、2=每隔一天、3=每三天…
 *   锚点日取 startDate（无则取创建当天），按天数差取模判断今天是否该吃。
 * 旧数据无这些字段 → 视为长期 + 每天，行为与旧版一致。
 */
export interface MedPlan {
    id: string;
    name: string;              // 药名
    time: string;              // HH:MM
    dosage?: string;           // 剂量（"1粒" / "5mg"）
    note?: string;
    enabled: boolean;
    createdAt: number;
    planKind?: 'longterm' | 'course';
    intervalDays?: number;     // 默认 1（每天）
    startDate?: string;        // YYYY-MM-DD（course 必填；也作为 interval 锚点）
    endDate?: string;          // YYYY-MM-DD（course 专用，含当天）
}

/** 生活记录全局设置（单例 id='main'） */
export interface LifeRecordSettings {
    id: string;                // 'main'
    cycleLength?: number;      // 平均周期天数，默认 28
    periodLength?: number;     // 平均经期天数，默认 5
    /**
     * 全局隐藏的模块（长按模块页签 →「是否不需要这个功能？」）。
     * 隐藏 = 前端不再显示 + 对所有角色断掉该模块注入与代记（优先级高于角色小开关）。
     */
    hiddenModules?: LifeRecordModule[];
    /** 锻炼周计划：每周目标次数（角色会据此监督执行） */
    exerciseWeeklyGoal?: number;
    /** 锻炼周计划：文字规划（如"周一跑步 / 周四力量"），会注入给角色 */
    exercisePlanNote?: string;
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
    logIds?: string[];     // 本段总结覆盖的日志 id（用于把原文与总结对应展示）
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
    diceDisabled?: boolean;      // 关闭骰子：行动不再自动骰 D20，默认直接成功
    // 归档模式：'auto' 满20条自动总结并送进角色 chatapp；'manual' 自动总结但不送，仅手动归档时送。
    // 旧存档无此字段，按 'manual' 处理（不污染旧角色的聊天上下文）。
    archiveMode?: 'auto' | 'manual';
    suggestedActions?: GameActionOption[];
    summaries?: GameSummary[];   // 自动总结归档的前情提要
    createdAt: number;
    lastPlayedAt: number;
}

export type MessageType = 'text' | 'image' | 'emoji' | 'voice' | 'collaboration_file' | 'interaction' | 'transfer' | 'system' | 'social_card' | 'chat_forward' | 'xhs_card' | 'score_card' | 'music_card' | 'mcd_card' | 'luckin_card' | 'html_card' | 'news_card' | 'vr_card' | 'trpg_card' | 'novel_card' | 'world_card' | 'sim_card' | 'phone_card' | 'webpage_card' | 'theater_card' | 'room_card' | 'life_card' | 'group_topic_card';

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
    /** 查手机 App 独立 API；null/缺省时跟随聊天默认。 */
    checkPhoneApi?: APIConfig | null;
    instantPushConfig?: InstantPushConfig;
    pushVapid?: { vapidPublicKey: string; vapidPrivateKey: string; vapidEmail?: string; updatedAt?: number; };
    /**
     * 主动消息 2.0 的全局配置：Worker 地址、共享密钥、一键部署生成的 AMSG_MASTER_KEY、
     * 即时对话总开关。存在独立的 `ActiveMsg` 库里，所以单独占一格（见 activeMsgStore
     * 的 exportAmsg2GlobalConfig）。角色身上那份 activeMsg2Config 跟着 characters 走。
     */
    amsg2GlobalConfig?: ActiveMsg2GlobalConfig;
    apiPresets?: ApiPreset[];
    availableModels?: string[];
    realtimeConfig?: RealtimeConfig;  // 实时感知配置（天气/新闻/Notion）
    memoryPalaceConfig?: MemoryPalaceBackupConfig;
    customIcons?: Record<string, string>;
    appearancePresets?: AppearancePreset[];
    characters?: CharacterProfile[];
    characterGroups?: CharacterGroup[];
    groups?: GroupProfile[];
    messages?: Message[];
    storyTheaters?: StoryTheaterEntry[];
    storyTheaterPresets?: StoryTheaterPreset[];
    storyTheaterMasks?: StoryTheaterMask[];
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
    vrScripts?: VRScript[];                     // 剧院·投稿剧本库
    vrStagedPlays?: VRStagedPlay[];             // 剧院·历史舞台剧
    vrPresets?: { key: string; name: string; prompt: string; blurb?: string }[]; // 剧院·用户自定义写作风格预设
    vrLetters?: VRLetter[];                    // 邮局信件（本地存档+队列）
    vrSettings?: any[];                        // 彼方设置（独立 API + 调用记录）
    worlds?: WorldProfile[];                   // 家园·世界定义
    worldEpisodes?: WorldEpisode[];            // 家园·演绎历史
    vrPostOffice?: Record<string, string>;     // 邮局本机配置：身份 deviceId / 后端地址（存 localStorage）
    vrSignal?: Record<string, string>;         // 信号坠落处本机记录：句子归属「你·角色」+ 反复用清单（存 localStorage）
    /** SAR 公告/卡池/推演记录。旧备份没有该字段；导入旧主历史时应清掉当前设备上的 SAR 进度，避免串档。 */
    sarLocalState?: {
        version: 1;
        club?: unknown;
        gacha?: unknown;
        simulations?: unknown;
    };
    worldHomeLocal?: Record<string, string>;   // 家园本机配置：全局 API + 文风收藏（存 localStorage）
    luckinLocal?: Record<string, string>;      // 瑞幸：token + 启用状态（存 localStorage）
    mcdLocal?: Record<string, string>;         // 麦当劳：token + 启用状态（存 localStorage）
    mcpLocal?: Record<string, string>;         // 通用 MCP：用户自配的服务器列表（存 localStorage）
    desktopSkinLocal?: Record<string, string>; // 桌面皮肤偏好：电子宠物/手游风的界面配色 + 看板 banner（存 localStorage；看板图令牌导出时解析为 data URL）
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
        companionAvatar?: CompanionAvatarConfig;
        companionTouchSettings?: CompanionTouchSettings;
        sprites?: Record<string, string>;
        dateSkinSets?: SkinSet[];
        activeSkinSetId?: string;
        customDateSprites?: string[];
        spriteConfig?: SpriteConfig;
        roomItems?: Record<string, string>;
        backgrounds?: { chat?: string; date?: string; roomWall?: string; roomFloor?: string };
    }[];

    xhsActivities?: XhsActivityRecord[];
    xhsOwnedPosts?: XhsOwnedPost[];
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
    roomPlates?: any[];      // 房间门牌（情景→语义固化层）
    digestReports?: any[];   // 消化日志（每角色最近 30 条）
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

    // 生活记录（档案 App：生理期 / 药盒 / 锻炼；记账走 bankTransactions）
    lifeRecords?: LifeRecord[];
    medPlans?: MedPlan[];
    lifeRecordSettings?: LifeRecordSettings[];

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
    chatTranslateExpandedByChar?: Record<string, boolean>;
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
    storyTheaterAppearance?: string;
    eventNotifFlags?: Record<string, string>;  // sullyos_* 事件通知标记
    hotNewsSnapshots?: HotNewsSnapshot[];
    dreamCollection?: Record<string, { firstAt: number; count: number }>;  // 梦境盲盒收藏册（os_dream_collection，账号级 localStorage）
    gotchiAccentHue?: string;  // 桌面电子宠物主题主色调偏好（tama_accent_hue，账号级 localStorage）

    // 独立协同工作数据库。二进制文件放在 ZIP 的 collaboration/assets/，JSON 只存索引。
    collaborationBackupVersion?: 1;
    collaborationBackupMode?: 'text_only' | 'media_only' | 'full';
    collaborationSessions?: any[];
    collaborationMessages?: any[];
    collaborationCategories?: any[];
    collaborationSettings?: any;
    collaborationAssetIndex?: {
        id: string;
        path: string;
        mimeType: string;
        size: number;
        createdAt: number;
    }[];
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
    githubProxyConsentVersion?: number; // must be 1: user explicitly accepted proxy transit after the safety change

    lastBackupTime?: number;    // timestamp
    lastBackupSize?: number;    // bytes
}

export interface CloudBackupFile {
    name: string;
    size: number;
    lastModified: string | number; // ISO date string or epoch timestamp
    href: string;               // WebDAV: remote path. GitHub: 'releaseId:assetId'
    /** GitHub can expose an interrupted draft/release without a restorable asset set. */
    status?: 'ready' | 'incomplete';
    statusMessage?: string;
    /** Expected GitHub asset sizes, in the same order as the ids encoded in href. */
    partSizes?: number[];
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
        noteId?: string;
        title?: string;
        body?: string;
        tags?: string[];
        keyword?: string;
        savedTopics?: { title: string; desc: string; noteId?: string }[];
        notesViewed?: { noteId: string; title: string; desc: string; author: string; likes: number }[];
        commentTarget?: { noteId: string; title: string; commentId?: string };
        commentText?: string;
    };
    thinking: string;  // Character's internal monologue / reasoning
    result: 'success' | 'failed' | 'skipped';
    resultMessage?: string;
}

/**
 * 角色在共享的真实小红书账号下发布的笔记归属。
 * 独立于可清理的活动日志，作为自由活动 App 中“角色主页”的持久化数据源。
 */
export interface XhsOwnedPost {
    id: string; // `${characterId}:${noteId}`
    characterId: string;
    noteId: string;
    title: string;
    body: string;
    tags?: string[];
    publishedAt: number;
    updatedAt: number;
    xsecToken?: string;
    likes?: number;
    collects?: number;
    commentCount?: number;
    shareCount?: number;
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
    mode?: 'local' | 'lite'; // 部署模式；不要再用 /api 路径推断（本地 Skills 与 Lite 都使用 /api）
    serverUrl: string;  // MCP: "http://localhost:18060/mcp" | Skills: "http://localhost:18061/api" | Lite Worker: "https://xhs-lite.<acct>.workers.dev/api"
    cookie?: string;    // Lite 模式：登录后的小红书完整 cookie（含 a1 / web_session）。仅 lite Worker 用。
    platform?: 'xhs' | 'rednote'; // Lite 自动识别出的国内小红书 / 全球 RedNote 后端
    rnoteApiKey?: string; // Lite 模式可选：用户自己的 Rnote Key，仅用于读取真实评论。
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
