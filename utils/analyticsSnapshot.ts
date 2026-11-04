import { loadChatInputPreferences } from './chatInputPreferences';
import { readSARClubState, sarRoomView } from './vrWorld/sarClub';
import { ANNIVERSARY_SEEN_KEY } from './anniversaryGifts';
import { readFishingMarketState } from './vrWorld/fishingMarket';
/**
 * 使用统计 · 会话级快照的收集层。
 *
 * 这里装的是四条**存量**事件的取数逻辑：数据规模、当前外观、当前角色设置、当前功能启用。
 * 它们的共同点是每次会话只发一次，报的是「我现在是什么样」，不是「我刚点了什么」。
 *
 * 存量和流量的区别别混：「应用了某个预设」是流量，只在有人点那一下才响，
 * 半年前设好之后再没动过的人永远不出现。拿流量表决定砍哪个功能会砍反——
 * 表里全是爱折腾的人，最稳定的长期用户隐形。存量事件补的就是这一块。
 *
 * ── 这个文件为什么单独存在 ──
 *
 * 一是 `utils/analytics.ts` 是跟 worker 共用的零依赖叶子，不能往里塞 MCP / 瑞幸 /
 * 推送这些浏览器侧客户端的 import；二是这些取数逻辑原本铺在 OSContext 的 useEffect
 * 里，混在渲染逻辑中间既没法单测，也没法一眼看全「到底发了什么」。
 * 收集和收敛全放这里，analytics.ts 只管往外发，OSContext 只管递自己手上的 state。
 *
 * ── 边界（改之前先读 docs/analytics.md 的「永远不会收集」一节）──
 *
 * 只出枚举和档位。用户自己填的东西一个字都不出去：主题名、字体、白框 CSS、提示音
 * 直链、API 地址、密钥、token、账号名、服务器名、城市名、数据库 ID 全部不碰。
 * 判断标准是**这个值是不是我在源码里写死的**——命中内置清单就报那个 key，
 * 否则一律收敛成 'custom' / '用了' / '调过'。
 *
 * 模型名也不报，不是漏了：那是用户自己填的自由文本，撞「属性只能是固定枚举」
 * 这条硬约束。想知道大家在用什么模型是真的，但收不了。
 */

import type { APIConfig, CloudBackupConfig, CharacterProfile, OSTheme, RealtimeConfig } from '../types';
import { PRESET_THEMES } from '../components/chat/ChatConstants';
import { anyCharToggle, bucketFewCount, presetOrCustom, tweakedOrDefault } from './analytics';
import { readStorageOverview } from './storageStats';
import { BUILTIN_SOUNDS } from './whiteboxSound';
import { DB } from './db';
import { isStandaloneDisplayMode } from './iosStandalone';
import { loadMcpServers, getMcpUseNativeTools } from './mcpClient';
import { getLuckinToken, isLuckinEnabled } from './luckinMcpClient';
import { getMcdToken, isMcdEnabled } from './mcdMcpClient';
import { getPendingTasks, isAmsg2EnabledForChar } from './amsg2Tasks';
import { ActiveMsgStore } from './activeMsgStore';
import { getVRApi } from './vrWorld/vrApi';
import { isBuiltinSullyLive2D } from './builtinSullyLive2D';
import { loadUserLocationConfig } from './userLocationPrivacy';

/** 布尔开关转「开 / 关」，带默认值。 */
const onOff = (v: boolean | undefined, dflt = false) => ((v ?? dflt) ? '开' : '关');

/** Only the saved switch. Never locate, or report a Key, region or provider response. */
function realLocationEnabled(): string {
    try { return onOff(loadUserLocationConfig().enabled); }
    catch { return '读取失败'; }
}

/**
 * 收集数据规模。全部是数出来的计数，没有一项来自内容本身——
 * 聊天条数问 IndexedDB 要 count()（一条消息都不会被读出来），
 * 存储占用是浏览器给的字节数。分档在 trackDataScaleOnce 里做。
 */
export async function collectDataScale(characters: CharacterProfile[]): Promise<{
    characterCount: number;
    memoryCount: number;
    maxMemoryCount: number;
    maxMessageCount: number;
    storageBytes: number | null;
    storageQuotaBytes: number | null;
    persistedStorage: boolean | null;
    standalone: boolean;
}> {
    const messageCounts = await Promise.all(
        characters.map(c => DB.countMessagesByCharId(c.id).catch(() => 0)),
    );
    const memoryCounts = characters.map(c => c.memories?.length ?? 0);
    // 用量和持久化许可一次取回：两者都出自同一个 StorageManager，分两次问纯属浪费。
    const storage = await readStorageOverview();
    return {
        characterCount: characters.length,
        memoryCount: memoryCounts.reduce((a, b) => a + b, 0),
        maxMemoryCount: Math.max(0, ...memoryCounts),
        maxMessageCount: Math.max(0, ...messageCounts),
        storageBytes: storage.usageBytes,
        storageQuotaBytes: storage.quotaBytes,
        persistedStorage: storage.persisted,
        // 用通用的「装成 PWA 独立窗口」判定，不只认 iOS——配合 umami 自带的
        // 系统字段，查询时就能分出 iOS 全屏、安卓全屏还是桌面装机。
        standalone: isStandaloneDisplayMode(),
    };
}

/**
 * 收集「当前在用的是哪套外观」。
 *
 * 报的是**现在用的是哪个**，不是**点过哪个**——后者只有折腾的人会出现，
 * 拿来决定砍哪个预设会砍反。所有取值都必须是内置预设的 id，
 * 用户自己捏的一律 'custom'，绝不能带他起的名字。
 */
export function collectAppearance(
    theme: OSTheme,
    activeChar: CharacterProfile | undefined,
): Record<string, string> {
    return {
        // ── 桌面 ──
        桌面皮肤: presetOrCustom(theme.skin ?? 'default', ['default','animalcrossing','mobilegame','tamagotchi','companion','homely']),
        居家配色: theme.skin === 'homely' ? presetOrCustom(theme.homelyPalette ?? 'apricot', ['apricot','blue','rose','lilac','oat']) : '未使用',
        居家锁定角色: theme.skin === 'homely' ? onOff(!!theme.homelyLockedCharacterId) : '未使用',
        桌面版本: theme.desktopVariant ?? 'paper',
        深色模式: onOff(theme.darkMode),
        隐藏状态栏: onOff(theme.hideStatusBar),
        保留图标原轮廓: onOff(theme.preserveCustomIconOutlines),
        播放卡片浅色: onOff(theme.nowPlayingWidgetLight, true),
        动森聊天同步: onOff(theme.acnhChatSync, true),
        // 自定义字体是用户上传的文件或自填 URL，只报用没用，绝不报是什么
        自定义字体: theme.customFont ? '用了' : '没用',
        // ── 聊天外观 ──
        气泡主题: presetOrCustom(activeChar?.bubbleStyle, Object.keys(PRESET_THEMES)),
        气泡样式: theme.chatBubbleStyle ?? 'modern',
        聊天壳样式: theme.chatChromeStyle ?? 'soft',
        顶栏样式: theme.chatHeaderStyle ?? 'default',
        输入栏样式: theme.chatInputStyle ?? 'default',
        聊天背景: theme.chatBackgroundStyle ?? 'plain',
        消息间距: theme.chatMessageSpacing ?? 'default',
        时间戳显示: theme.chatShowTimestamp ?? 'always',
        顶栏对齐: theme.chatHeaderAlign ?? 'left',
        顶栏密度: theme.chatHeaderDensity ?? 'default',
        状态样式: theme.chatStatusStyle ?? 'subtle',
        发送键样式: theme.chatSendButtonStyle ?? 'circle',
        卡片对齐: theme.chatModuleAlign ?? 'center',
        // ── 头像与表情 ──
        头像形状: theme.chatAvatarShape ?? 'circle',
        头像尺寸: theme.chatAvatarSize ?? 'medium',
        头像显示: theme.chatAvatarVisibility ?? 'both',
        头像对齐: theme.chatAvatarAlign ?? 'bottom',
        头像模式: theme.chatAvatarMode ?? 'grouped',
        表情尺寸: theme.chatEmojiSize ?? 'small',
        隐藏侧贴边: onOff(theme.chatSnapToEdge),
        // ── 开关 ──
        隐藏情绪栏: onOff(theme.chatHideHeaderBuffs),
        // 白框自定义 CSS 是用户写的代码，只报用没用
        自定义白框CSS: theme.chatChromeCustomCss ? '用了' : '没用',
        // ── 提示音：内置音效报 key，用户填的直链或上传的音频一律 custom ──
        提示音: presetOrCustom(theme.chatSound?.src, Object.keys(BUILTIN_SOUNDS), '没设'),
        // ── 微调数值只报调没调过，不报具体数字 ──
        气泡字号: tweakedOrDefault(theme.chatBubbleFontSize),
        气泡行距: tweakedOrDefault(theme.chatBubbleLineHeight),
        气泡缩进: tweakedOrDefault(theme.chatBubbleIndent),
        头像微调: tweakedOrDefault(theme.chatAvatarOffsetY),
    };
}

/** 桌面陪伴形象来源的中文标签，跟「切换桌面陪伴形象来源」事件的取值一致，方便两张表对照着看。 */
const COMPANION_SOURCE_LABELS: Record<string, string> = {
    model: '动态模型',
    upload: '静态图片',
    date: '见面立绘',
};

/**
 * 用户自己导入的通话形象。内置 Sully 那份不算——预置角色开箱就绑着它，
 * 数进去的话人人至少 1，真正想知道的「有多少人自己导过模型」会被这个底噪盖住。
 */
const importedAvatars = (characters: CharacterProfile[]) =>
    characters.filter(c => c.videoAvatar && !isBuiltinSullyLive2D(c.videoAvatar));

/** 自己导入的是哪种格式。两种都导过的人单独占一档，不然会被算进先判断的那一边。 */
function importedAvatarFormat(characters: CharacterProfile[]): string {
    const formats = new Set(importedAvatars(characters).map(c => c.videoAvatar?.format));
    if (formats.has('live2d') && formats.has('vrm')) return '都有';
    if (formats.has('live2d')) return 'live2d';
    if (formats.has('vrm')) return 'vrm';
    return '没导入';
}

/**
 * 用内置 Sully 的人选了哪档纹理。2K 和 4K 差一倍多的下载量和显存，
 * 「有多少人切到 4K 了」直接关系到要不要继续维护两份贴图。
 */
function builtinSullyQuality(characters: CharacterProfile[]): string {
    const builtin = characters.map(c => c.videoAvatar).filter(isBuiltinSullyLive2D);
    if (!builtin.length) return '没用内置';
    return builtin.some(cfg => cfg.builtinQuality === 'hd') ? '4K' : '2K';
}

/**
 * 收集角色级设置。两种问法，别混：
 *   · 开关类 → 问「有没有人开过 / 有没有人特意关掉」，看的是这个功能有没有人要
 *   · 选择类 → 报当前活跃角色选的那个，看的是各选项的占比
 *
 * 全程只有枚举值和「有/无」，不带角色名、不带任何设定内容。
 * 形象这一族尤其要注意：`videoAvatar.fileName` 是用户自己的文件名，
 * 只能拿来判断格式，一个字都不许进上报。
 *
 * 刻意没报的：每个世界一份（家园）、每局一份（跑团）的那些设置。一个用户能有十几个
 * 世界，报哪个都不代表他，而且这些选择本来就有「选择世界时间模式」这类事件在记。
 */
export function collectCharSettings(
    characters: CharacterProfile[],
    activeCharacterId: string | null | undefined,
): Record<string, string> {
    const c = characters.find(x => x.id === activeCharacterId) ?? characters[0];
    const anyOn = (pick: (ch: CharacterProfile) => boolean | undefined, defaultOn = false) =>
        anyCharToggle(characters.map(pick), defaultOn);
    const now = Date.now();
    return {
        // ── 开关：默认关的，问有没有人开过 ──
        '3D家园角色数': bucketFewCount(characters.filter(x => x.home3D?.rooms?.length).length),
        记忆宫殿: anyOn(x => x.memoryPalaceEnabled),
        聊天显示备注: anyOn(x => x.chatShowRemark === true),
        自动归档: anyOn(x => x.autoArchiveEnabled),
        思考过程: anyOn(x => x.showThinkingChain),
        日程与情绪: anyOn(x => x.scheduleFeatureEnabled),
        HTML卡片: anyOn(x => x.htmlModeEnabled),
        角色级聊天装扮: anyOn(x => x.chatFineTune?.enabled),
        日常聊天协同: anyOn(x => x.chatCollaborationEnabled),
        自定义时区: anyOn(x => x.customTimezoneEnabled),
        生活记录注入: anyOn(x => x.lifeRecordEnabled),
        // 叫「角色小红书」而不是「小红书」：功能启用那条里已经有一个「小红书」，问的是
        // 全局桥接配没配、开没开。同名不同义会在查询侧混成一个 key，两条事件的数字叠在
        // 一起，谁也说不清看到的是哪个。角色级的加「角色」前缀，跟角色提示音一个路子。
        角色小红书: anyOn(x => x.xhsEnabled),
        隐藏系统日志: anyOn(x => x.hideSystemLogs),
        见面轻阅读: anyOn(x => x.dateLightReading),
        观测协议: anyOn(x => x.dateObserve?.enabled),
        彼方自主登入: anyOn(x => x.vrState?.enabled),
        提示音绑白框: anyOn(x => x.chatSoundBound),
        // ── 开关：默认开的，问有没有人特意关掉 ──
        时间感知: anyOn(x => x.timeAwarenessEnabled, true),
        见面时间感知: anyOn(x => x.dateTimeAwarenessEnabled, true),
        查手机同步聊天: anyOn(x => x.phoneState?.sendToChat, true),
        允许虚构NPC: anyOn(x => x.phoneState?.allowFictionalContacts, true),
        可读我的音乐: anyOn(x => x.musicProfile?.canReadUserMusic, true),
        见面深挖引导: anyOn(x => x.dateStyleConfig?.digDeeper, true),
        // ── 选择：当前活跃角色选了哪个 ──
        思考链风格: c.thinkingChainStyle ?? 'echo',
        日程风格: c.scheduleStyle ?? 'lifestyle',
        认知风格: c.personalityStyle ?? '没设',
        原文读取策略: c.contextRangeMode ?? 'manual',
        见面写作风格: c.dateStyleConfig?.style ?? 'cinematic',
        见面叙事人称: c.dateStyleConfig?.pov ?? '没设',
        观测HUD样式: c.dateObserve?.style ?? 'hologram',
        // 定时消息是多任务清单（一个角色可以同时挂多个不同模式的任务），没有角色级的
        // 单一模式/频率可报；这里报任务规模，模式/频率构成在「排程定时消息」事件里按次记录。
        //
        // 这一项数的是**全部角色合计**，不是当前活跃角色——主动消息 2.0 是全局功能，
        // 一个人挂十几个角色时，活跃角色恰好是没排任务的那个的概率很大，
        // 只看它会把「排了一堆任务的重度用户」报成 0。
        定时消息任务数: bucketFewCount(
            characters.reduce((sum, ch) => sum + getPendingTasks(ch.activeMsg2Config, now).length, 0),
        ),
        // 角色专属提示音同样只分「内置哪个 / 自己弄的」
        角色提示音: presetOrCustom(c.chatSound?.src, Object.keys(BUILTIN_SOUNDS), '没设'),
        // 只问有没有角色选过粤语；不报角色名，也不拆成可关联的逐角色记录。
        粤语语音: characters.some(x => [
            x.chatVoiceLang,
            x.dateVoiceLang,
            x.callVoiceLang,
            x.companionTouchSettings?.voiceLanguage,
            x.companionTouchSettings?.startup?.voiceLanguage,
        ].includes('yue')) ? '有人选' : '没人选',

        // ── 桌面陪伴与通话形象 ──
        // 「有多少人在用桌面陪伴」不在这里问：「当前外观」的桌面皮肤已经回答了
        // （skin === 'companion'）。这几格问的是用起来的人手上是什么形象。
        //
        // 都数全部角色，不是当前活跃角色：一个人挂十几个角色时，导了模型的
        // 恰好不是当前这个的概率很大，只看活跃角色会把重度用户报成没导过。
        自己导入形象的角色数: bucketFewCount(importedAvatars(characters).length),
        导入的形象格式: importedAvatarFormat(characters),
        内置Sully画质: builtinSullyQuality(characters),
        // 缺省就是「动态模型」，所以这一格里的「动态模型」含从没设过的人；
        // 有信息量的是另外两档，只有主动换过的人才会落进去。
        // 认不出的取值一并算「动态模型」，跟界面的渲染回落同口径（见 companionAvatarSource）。
        桌面陪伴形象来源: COMPANION_SOURCE_LABELS[c.companionAvatar?.source || 'model'] ?? '动态模型',
        换掉动态模型的角色数: bucketFewCount(
            characters.filter(x => x.companionAvatar?.source && x.companionAvatar.source !== 'model').length,
        ),
    };
}

/**
 * 记忆宫殿全局配置里我们要看的那几个字段。
 * 刻意不从 context/OSContext 引类型——utils 反向依赖 context 会把渲染层拖进来，
 * 跟 activeMsgRuntime.ts 的处理方式一致。
 */
interface MemoryPalaceConfigShape {
    embedding?: { apiKey?: string };
    lightLLM?: { apiKey?: string };
    rerank?: { enabled?: boolean; apiKey?: string };
    featureFlags?: {
        recallRouter?: boolean;
        interactionAdaptation?: boolean;
        deepEngagement?: boolean;
    };
}

/** 远程向量（记忆云端同步）配置里我们要看的字段。 */
interface RemoteVectorConfigShape {
    enabled?: boolean;
    supabaseUrl?: string;
    supabaseAnonKey?: string;
}

/** 三态：配了并开着 / 配了但关着 / 压根没配。 */
export type FeatureTriState = '开' | '配了没开' | '没配';

/**
 * 「配了但关着」是最值钱的那一档：那是试过之后放弃了，跟「压根没配」是两码事。
 * 前者说明引导哪一步劝退了该修，后者说明没人要这功能、可以考虑砍。
 * 只报「开/关」二态就把这两种情况混成一格了。
 */
export function triState(configured: boolean, enabled: boolean): FeatureTriState {
    if (!configured) return '没配';
    return enabled ? '开' : '配了没开';
}

/** 主动消息 2.0 配到哪一步了。 */
export type Amsg2Stage = '没配' | '填了没连上' | '连上没开角色' | '开';

/**
 * 主动消息 2.0 要连过三关才真的会响：填 Worker 地址 → 连接成功（在用户自己的 D1 里
 * 建表）→ 至少给一个角色开。所以它报四态，比别处的三态多一档。
 *
 * 多出来的那一档是有用的，因为两种半途而废要修的地方完全不同：
 *   · 填了没连上   —— 卡在那 15 分钟的部署流程里（地址填错、密钥对不上、D1 没绑）
 *   · 连上没开角色 —— 后端已经弄好了，卡在「不知道还要去聊天里逐个角色打开」
 * 塞进 triState 的话这两种会混成同一个「配了没开」，看不出该修哪一段引导。
 *
 * 地址被删了但连接记录还在（或者导入的备份里带着开着的角色配置）一律算「没配」：
 * 没有地址就不可能工作，报成后面几档是虚高。
 */
export function amsg2Stage(
    workerConfigured: boolean,
    connected: boolean,
    activeCharCount: number,
): Amsg2Stage {
    if (!workerConfigured) return '没配';
    if (!connected) return '填了没连上';
    return activeCharCount > 0 ? '开' : '连上没开角色';
}

/** 云端备份服务商白名单。用户装了别的（或数据被改过）一律 custom。 */
const BACKUP_PROVIDERS = ['webdav', 'github'] as const;

/** 语音合成服务商白名单。 */
const TTS_PROVIDERS = ['minimax', 'fishaudio', 'elevenlabs'] as const;

/** 命中白名单就报那个值，否则报 custom；空值报 fallback。 */
function enumOrCustom(
    value: string | undefined | null,
    allowed: readonly string[],
    fallback: string,
): string {
    if (!value) return fallback;
    return allowed.includes(value) ? value : 'custom';
}

/** localStorage 里某个键有没有非空值。读不出来（隐私模式）按「没有」算。 */
function hasLocalValue(key: string): boolean {
    try {
        return (localStorage.getItem(key) ?? '').trim().length > 0;
    } catch {
        return false;
    }
}

/**
 * localStorage 里某个开关是不是打开的。
 * 存的是 '1'/'0' 这类字面量，不能拿「有没有值」代替——'0' 也是有值的。
 */
function isLocalFlagOn(key: string, onValue: string): boolean {
    try {
        return localStorage.getItem(key) === onValue;
    } catch {
        return false;
    }
}

/** localStorage 里存的是不是一份非空 JSON 对象（用来判断「另配了独立线路」）。 */
function hasLocalJsonConfig(key: string): boolean {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        return Boolean(parsed) && typeof parsed === 'object' && Object.keys(parsed).length > 0;
    } catch {
        return false;
    }
}

/** 存档内已完成 + 当前未完成的剧情去重；回顾不会增加数量，不收剧情 ID。 */
function collectSARDialogueCounts(): Record<string, string> {
    try {
        const npcs = readFishingMarketState().sarFamiliarity?.npcs;
        const count = (npc: 'caian' | 'aiven'): string => {
            const progress = npcs?.[npc];
            const ids = new Set(Object.keys(progress?.completed || {}));
            if (progress?.pending?.sceneId) ids.add(progress.pending.sceneId);
            const n = ids.size;
            return n === 0 ? '0' : n <= 5 ? '1–5' : n <= 10 ? '6–10' : n <= 20 ? '11–20'
                : n <= 30 ? '21–30' : n <= 40 ? '31–40' : '41+';
        };
        return { 凯恩已触发对话数: count('caian'), 艾文已触发对话数: count('aiven') };
    } catch {
        // 坏档或存储不可读不应变成「没玩过」，也不能阻断其他快照。
        return { 凯恩已触发对话数: '读取失败', 艾文已触发对话数: '读取失败' };
    }
}

/** SAR 发布功能单独参与冷启动轮转，不加宽原有功能快照。 */
export function collectSARFeatureFlags(): Record<string, string> {
    const input = loadChatInputPreferences();
    const sar = readSARClubState();
    return {
        // ── SAR / 输入习惯 / 周年赠礼：只上报固定状态 ──
        发送键生成: onOff(input.sendButtonGenerates),
        回车发送: onOff(input.enterToSend),
        自动回复: onOff(input.autoReply),
        SAR角色: sar.npcPreference === 'show' ? '开' : sar.npcPreference === 'hide' ? '关' : '未选择',
        SAR房间显示: sarRoomView(sar) === 'names-hidden' ? '隐藏名字' : sarRoomView(sar) === 'text-hidden' ? '隐藏文字' : sarRoomView(sar) === 'characters-hidden' ? '隐藏角色' : '全部显示',
        SAR简易钓鱼: isLocalFlagOn('vr_fishing_simple_mode', 'true') ? '开' : '关',
        SAR对话配色: isLocalFlagOn('vr_sar_session_theme_v1', 'dark') ? '深色' : '浅色',
        周年赠礼已阅: isLocalFlagOn(ANNIVERSARY_SEEN_KEY, '1') ? '是' : '否',
        ...collectSARDialogueCounts(),
    };
}

/** OSContext 手上有、这里读不到的那部分状态。 */
export interface FeatureSources {
    realtimeConfig: RealtimeConfig;
    cloudBackupConfig: CloudBackupConfig;
    memoryPalaceConfig: MemoryPalaceConfigShape;
    remoteVectorConfig: RemoteVectorConfigShape;
    apiConfig: APIConfig;
    /** 用户存了几条 API 线路预设。只用条数，一条内容都不看。 */
    apiPresetCount: number;
    /** 彼方有没有另配独立线路。存在 IndexedDB，得由调用方 await 出来。 */
    vrIndependentApi: boolean;
    /** 全部角色。只数「开了主动消息 2.0 的有几个」，角色内容一个字都不碰。 */
    characters: CharacterProfile[];
    /**
     * 主动消息 2.0 的全局配置，存 IndexedDB，得由调用方 await 出来。
     * 只看「地址填没填」「连接成功过没有」「即时对话开没开」三位，
     * Worker 地址和共享密钥本身不进上报。
     */
    amsg2Global: { workerUrl?: string; initializedAt?: number; instantChatEnabled?: boolean };
    /** 协同 sidecar 只用 count() 取出的行数，不读取窗口标题、消息、文件名或 Blob。 */
    collaborationUsage: { sessions: number; messages: number; assets: number };
}

/**
 * 把「现在开着哪些功能」收敛成一份可上报的枚举表。
 *
 * 纯函数 + 直接读 localStorage 两种来源都有：能同步读到的（MCP、点单、QQ 桥、
 * 自习室）在这里自己读，OSContext 只需要传它 state 里那几份。
 */
export function collectFeatureFlags(src: FeatureSources): Record<string, string> {
    const rt = src.realtimeConfig;
    const mcpServers = loadMcpServers();
    const luckinToken = getLuckinToken().length > 0;
    const mcdToken = getMcdToken().length > 0;
    // 「用起来了的角色」= 在面板里把开关打开过的（enabled:true 是用户表过态的真痕迹），
    // 与工具注入门同一个判定。
    const amsg2ActiveChars = src.characters.filter(isAmsg2EnabledForChar);
    const contextFlags = src.memoryPalaceConfig.featureFlags;
    const contextEnabledCount = [
        contextFlags?.recallRouter,
        contextFlags?.interactionAdaptation,
        contextFlags?.deepEngagement,
    ].filter(value => value === true).length;

    return {
        // ── 外部服务接入 ──
        // 天气和热点走免鉴权的公共源，没有「配了」这一态，只有开没开。
        天气: rt.weatherEnabled ? '开' : '关',
        节假日感知: rt.userHolidays?.enabled && rt.userHolidays.countryCode ? '开' : '关',
        真实定位: realLocationEnabled(),
        // 自备 key 的人走 OpenWeatherMap，留空走 Open-Meteo。只报有没有，不报 key。
        天气自备key: rt.weatherApiKey?.trim() ? '有' : '无',
        热点: rt.newsEnabled ? '开' : '关',
        Notion: triState(
            Boolean(rt.notionApiKey?.trim() && rt.notionDatabaseId?.trim()),
            rt.notionEnabled,
        ),
        飞书: triState(
            Boolean(rt.feishuAppId?.trim() && rt.feishuAppSecret?.trim() && rt.feishuBaseId?.trim()),
            rt.feishuEnabled,
        ),
        小红书: triState(Boolean(rt.xhsMcpConfig?.serverUrl?.trim()), rt.xhsEnabled),
        // 点单这两家的 token 是用户自己抓的，判长度而已，值不出去。
        瑞幸点单: triState(luckinToken, isLuckinEnabled()),
        麦当劳点单: triState(mcdToken, isMcdEnabled()),

        // ── 用户自配 MCP ──
        // 三个数分开报，因为它们各自对应一段不同的卡壳：
        // 配了几个 → 有多少人愿意折腾；启用几个 → 折腾完留下几个；
        // 连通几个 → 有多少人卡在「加了但根本连不上」。
        自配MCP服务器: bucketFewCount(mcpServers.length),
        启用中的MCP服务器: bucketFewCount(mcpServers.filter(s => s.enabled).length),
        连通的MCP服务器: bucketFewCount(mcpServers.filter(s => (s.tools?.length ?? 0) > 0).length),
        // 关掉了就是退回文字兼容模式，本身是「模型不支持 function calling」的信号。
        MCP原生工具调用: getMcpUseNativeTools() ? '开' : '关',
        QQ桥接: triState(hasLocalValue('qqBridge:wsUrl'), isLocalFlagOn('qqBridge:enabled', '1')),

        // ── 数据与备份 ──
        云端备份: triState(
            Boolean(src.cloudBackupConfig.webdavUrl?.trim() || src.cloudBackupConfig.githubToken?.trim()),
            src.cloudBackupConfig.enabled,
        ),
        云端备份服务商: enumOrCustom(src.cloudBackupConfig.provider, BACKUP_PROVIDERS, '没配'),
        记忆向量模型: src.memoryPalaceConfig.embedding?.apiKey?.trim() ? '配了' : '没配',
        记忆副LLM: src.memoryPalaceConfig.lightLLM?.apiKey?.trim() ? '配了' : '没配',
        记忆重排序: triState(
            Boolean(src.memoryPalaceConfig.rerank?.apiKey?.trim()),
            Boolean(src.memoryPalaceConfig.rerank?.enabled),
        ),
        记忆云端同步: triState(
            Boolean(src.remoteVectorConfig.supabaseUrl?.trim() && src.remoteVectorConfig.supabaseAnonKey?.trim()),
            Boolean(src.remoteVectorConfig.enabled),
        ),
        智能语境: contextEnabledCount === 3 ? '全开' : contextEnabledCount > 0 ? '部分开' : '全关',

        // ── 协同工作 ──
        // 三个数字都来自 IndexedDB.count()，不会把窗口标题、对话正文或文件名读进统计层。
        协同工作: src.collaborationUsage.sessions > 0 || src.collaborationUsage.messages > 0 || src.collaborationUsage.assets > 0
            ? '用过'
            : '没用过',
        协同窗口数: bucketFewCount(src.collaborationUsage.sessions),
        协同消息数: bucketFewCount(src.collaborationUsage.messages),
        协同文件数: bucketFewCount(src.collaborationUsage.assets),

        // ── 模型线路 ──
        // 服务商是枚举，可以报；baseUrl / key / 模型名一律不报。
        语音合成: src.apiConfig.apiKey || src.apiConfig.minimaxApiKey || src.apiConfig.fishAudioApiKey || src.apiConfig.elevenLabsApiKey
            ? enumOrCustom(src.apiConfig.ttsProvider, TTS_PROVIDERS, 'minimax')
            : '没配',
        API线路预设数: bucketFewCount(src.apiPresetCount),
        自习室独立线路: hasLocalJsonConfig('study_api_config') ? '配了' : '没配',
        彼方独立线路: src.vrIndependentApi ? '配了' : '没配',

        // ── 主动消息 2.0 ──
        // 没报「主动消息 Push 加速」：那一层已经全局下线（proactivePushConfig.ts 的
        // FORCE_DISABLED，设置面板也藏了），loadPushConfig() 恒返回 enabled=false。
        // 报出来只会是一片「关」，看着像没人用，其实是被下掉了——这种数据比没有更坏。
        //
        // 四态（见 amsg2Stage）：三关里卡在哪一关，要修的引导完全不是一回事。
        '主动消息2.0': amsg2Stage(
            Boolean(src.amsg2Global.workerUrl?.trim()),
            Boolean(src.amsg2Global.initializedAt),
            amsg2ActiveChars.length,
        ),
        // 上面那一档只分「有没有角色在用」，这里补深度：只开了一个是尝鲜，
        // 好几个才说明真的用起来了。
        '开了2.0的角色数': bucketFewCount(amsg2ActiveChars.length),
        // 聊天主路径搬没搬上云端。只有开/关：配置到哪一步由上面那格四态回答，
        // 这一格问的是「配好了的人里有多少真把聊天切过去了」。
        即时对话: onOff(src.amsg2Global.instantChatEnabled),
        // 全局开着、却在某几个角色上单独关掉的有多少。角色级开关是「跟随全局」缺省，
        // 只有显式关才落 false——这一格数的就是这种显式关，回答「按角色区分有没有人用」。
        // 一个都没有的话这个开关可以从角色面板收掉。
        单独关了即时对话的角色数: bucketFewCount(
            amsg2ActiveChars.filter((ch) => ch.activeMsg2Config?.instantChatEnabled === false).length,
        ),
    };
}

/**
 * collectFeatureFlags 的异步外壳：把要去 IndexedDB 取的那一项先取回来。
 * 调用方（OSContext）只管把自己 state 里那几份递进来，不必知道彼方的独立线路
 * 存在哪、要不要 await。
 */
export async function collectFeatureFlagsAsync(
    src: Omit<FeatureSources, 'vrIndependentApi' | 'amsg2Global' | 'collaborationUsage'>,
): Promise<Record<string, string>> {
    // 读不出来就当没配。为一条统计去打断启动流程不值得。
    const [vrIndependentApi, amsg2Global, collaborationUsage] = await Promise.all([
        getVRApi().then(cfg => Boolean(cfg)).catch(() => false),
        ActiveMsgStore.getGlobalConfig().catch(() => ({ workerUrl: '' })),
        import('../features/collaboration/store')
            .then(module => module.CollaborationStore.getUsageCounts())
            .catch(() => ({ sessions: 0, messages: 0, assets: 0 })),
    ]);
    return collectFeatureFlags({ ...src, vrIndependentApi, amsg2Global, collaborationUsage });
}
