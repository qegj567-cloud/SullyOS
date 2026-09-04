import React, { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { Message, MessageType, MemoryFragment, Emoji, EmojiCategory, DailySchedule, ScheduleSlot } from '../types';
import { processImage, processImageToBlob } from '../utils/file';
import { safeResponseJson, extractContent } from '../utils/safeApi';
import { buildChatFineTuneCss, mergeChatFineTune } from '../utils/chatFineTuneCss';
import ChatFineTunePanel from '../components/chat/ChatFineTunePanel';
import TokenImg from '../components/os/TokenImg';
import { FadersHorizontal } from '@phosphor-icons/react';
import { generateDailyScheduleForChar, isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { getDailyScheduleForChar } from '../utils/dailySchedule';
import { useLocalDateKey } from '../hooks/useLocalDateKey';
import { resolveCharTimeZone } from '../utils/timezone';
import { generateSlotTheater } from '../utils/theaterGenerator';
import TheaterPlayer from '../components/schedule/TheaterPlayer';
import { formatMessageWithTime, normalizeMessageContent } from '../utils/messageFormat';
import { getRoomLabel } from '../utils/memoryPalace/types';
import { XhsMcpClient, extractNotesFromMcpData, normalizeXhsLiteDetail } from '../utils/xhsMcpClient';
import { extractWebpageContent, detectFirstUrl, detectXhsShortUrl, extractXhsShareTitle, isXhsUrl, extractXhsNoteId, expandShortUrl, type ExtractedWebpage } from '../utils/webpageExtractor';
import { isVideoShareUrl, parseVideoShareUrl } from '../utils/videoParser';
import { isDevDebugAvailable } from '../utils/devDebug';
import { isImageValue, migrateDataUrlToRef, putImageBlob, useBlobRefUrl } from '../utils/blobRef';
import { buildReplySnapshotContent } from '../utils/applyAssistantPostProcessing';
import { resolveLifeRecordCard } from '../utils/lifeRecords';
import { isMcdConfigured } from '../utils/mcdMcpClient';
import { isMcdActivatedInMessages, MCD_ACTIVATE_TRIGGER, MCD_DEACTIVATE_TRIGGER } from '../utils/mcdToolBridge';
import { isLuckinConfigured } from '../utils/luckinMcpClient';
import { isLuckinActivatedInMessages, LUCKIN_ACTIVATE_TRIGGER, LUCKIN_DEACTIVATE_TRIGGER } from '../utils/luckinToolBridge';
import MessageItem, { ThinkingChainBlock } from '../components/chat/MessageItem';
import McdMiniApp from '../components/mcd/McdMiniApp';
import LuckinMiniApp from '../components/luckin/LuckinMiniApp';
import LuckinLocationModal from '../components/luckin/LuckinLocationModal';
import LuckinHelpModal from '../components/luckin/LuckinHelpModal';
import { PRESET_THEMES, DEFAULT_ARCHIVE_PROMPTS } from '../components/chat/ChatConstants';
import { resolveChatTheme } from '../utils/groupChat/theme';
import ChatHeader from '../components/chat/ChatHeaderShell';
import CharacterEntryTransition from '../components/chat/CharacterEntryTransition';
import ChromeCssEditor from '../components/chat/ChromeCssEditor';
import ChatInputArea from '../components/chat/ChatInputArea';
import InstantChatRouteNotice from '../components/chat/InstantChatRouteNotice';
import MemoryRepairPortal from '../components/chat/MemoryRepairPortal';
import FavoritesPortal from '../components/chat/VoiceFavoritesPortal';
import ChatModals from '../components/chat/ChatModals';
import Modal from '../components/os/Modal';
import ProactiveSettingsModal from '../components/chat/ProactiveSettingsModal';
import ActiveMsg2SettingsModal from '../components/chat/ActiveMsg2SettingsModal';
import ThinkingChainSettingsModal from '../components/chat/ThinkingChainSettingsModal';
import ScheduleChangeNotice from '../components/chat/ScheduleChangeNotice';
import { useChatAI } from '../hooks/useChatAI';
import { cleanTextForTts, parseVoiceOutput } from '../utils/minimaxTts';
import { collectVoiceBatchSubtitle, isPoisonedVoiceSubtitle } from '../utils/voiceSubtitle';
import {
    canSynthesizeSpeech,
    characterHasVoice,
    cleanTextForTtsProvider,
    providerUsesRawVoiceMarkup,
    stripTtsMarkupForDisplay,
    synthesizeSpeechDetailed,
} from '../utils/ttsRouter';
import { shouldAutoGenerateVoice, shouldAutoPlayGeneratedVoice } from '../utils/voicePlayback';
import { voiceLanguageAnalyticsValue, voiceLanguagePromptLabel } from '../utils/voiceLanguage';
import { fetchBlobForShare, shareOrDownloadBlob } from '../utils/shareExport';
import { CollaborationStore } from '../features/collaboration/store';
import { resolveTtsProvider } from '../utils/ttsProvider';
import { isInstantConfigReady, loadInstantConfig } from '../utils/instantPushClient';
import { resolveActiveSound, playWhiteboxSound, unlockWhiteboxAudio, parseWhiteboxSound, upsertWhiteboxSound, stripWhiteboxSoundDirective, WhiteboxSound } from '../utils/whiteboxSound';
import WhiteboxSoundEditor from '../components/chat/WhiteboxSoundEditor';
import { normalizeTranslationLangLabel, isTranslationLangPreset } from '../utils/translationLang';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trackEvent, noteMessageSent, presetOrCustom } from '../utils/analytics';
import { markAmsgStateDirty, markAmsgStateDirtyForAll } from '../utils/amsgStateSync';
import { AMSG_INSTANT_CHAT_PENDING_EVENT, AMSG_INSTANT_CHAT_PENDING_LS_KEY, getInstantChatPending } from '../utils/amsgInstantChat';
import { formatAmsgToolTrace } from '../utils/amsgToolTrace';
import { formatHours } from '../utils/format';
import { resolveSARModuleSpeechSource } from '../utils/vrWorld/sarModuleRuntime';
import {
    VOICE_FAVORITES_CHANGED_EVENT,
    getVoiceFavorite,
    listVoiceFavorites,
    removeVoiceFavorite,
    saveVoiceFavorite,
} from '../utils/voiceFavorites';
import {
    CONTENT_FAVORITES_CHANGED_EVENT,
    contentFavoriteIdForMessage,
    listContentFavorites,
    removeContentFavoriteById,
    saveMessageContentFavorite,
} from '../utils/contentFavorites';
import { SCHEDULE_CHANGE_EVENT, type ScheduleChangeEventDetail } from '../utils/scheduleChange';
import {
    CONTEXT_RANGE_POLICY_VERSION,
    computeContextRangeSnapshot,
    countMessagesFrom,
    getMemoryPalaceHighWaterMarkForContext,
    loadCharacterContextRange,
    resolveContextRangeMode,
    type ContextRangeMode,
} from '../utils/chatContextRange';
import {
    createChatHistoryWindow,
    expandChatHistoryWindow,
    type ChatHistoryWindowRange,
} from '../utils/chatHistoryWindow';
import type { CollaborationTransferMessage } from '../features/collaboration/types';
import type { CollaborationInstallableArtifact } from '../features/collaboration/types';
import {
    installableToCharacterPatch,
    installableToChatTheme,
    installableToThemePatch,
    installableToWorldbooks,
    validateInstallableArtifact,
} from '../features/collaboration/makers';
import { upsertMountedWorldbooks } from '../utils/worldbook';

const CollaborationWindow = React.lazy(() => import('../features/collaboration/CollaborationWindow'));

const HISTORY_WINDOW_RADIUS = 25;
const HISTORY_WINDOW_BATCH_SIZE = 30;

const isVisibleChatMessage = (message: Message, hideSystemLogs = false) => (
    message.metadata?.source !== 'date'
    && message.metadata?.source !== 'call'
    && message.metadata?.source !== 'story_theater_memory'
    && !message.metadata?.proactiveHint
    && !(hideSystemLogs && message.role === 'system' && message.type !== 'score_card')
);

/** 即时对话那一轮回复「推送陆续到齐」的宽限时间，也就是自动合成的补扫窗口有多长（见下面的 auto-TTS effect）。 */
const INSTANT_VOICE_SCAN_WINDOW_MS = 30_000;
type InstantToolUiStatus = {
    charId: string;
    phase: 'running' | 'continuing' | 'done' | 'failed';
    text: string;
    sessionId?: string;
    updatedAt?: number;
};

const Chat: React.FC = () => {
    const { characters, activeCharacterId, setActiveCharacterId, addCharacter, updateCharacter, updateUserProfile, apiConfig, apiPresets, availableModels, addApiPreset, closeApp, customThemes, addCustomTheme, removeCustomTheme, addWorldbook, updateTheme, saveAppearancePreset, addToast, showError, userProfile, lastMsgTimestamp, groups, characterGroups, clearUnread, unreadMessages, realtimeConfig, memoryPalaceConfig, updateMemoryPalaceConfig, remoteVectorConfig, syncEmotionApiToAllCharacters, theme: osTheme, proactiveComposingChars, openDateWithChar } = useOS();
    const isProactiveComposing = !!(activeCharacterId && proactiveComposingChars[activeCharacterId]);
    const localDateKey = useLocalDateKey();

    // 记忆宫殿高水位（用于清空聊天时的安全检查）
    const getMemoryPalaceHWM = useCallback(async (charId: string): Promise<number> => {
        try {
            const { getMemoryPalaceHighWaterMark } = await import('../utils/memoryPalace/pipeline');
            return getMemoryPalaceHighWaterMark(charId);
        } catch { return 0; }
    }, []);
    const [messages, setMessages] = useState<Message[]>([]);
    // Instant Push 路径："准备中"三个点 = 消息正在拼接+发送; 消失 = SSE POST 已排进
    // 浏览器网络栈. 页面关闭时会主动 abort SSE, 让 worker 尽量走 Web Push fallback。
    const [instantSendingActive, setInstantSendingActive] = useState(false);
    // 即时对话：这一轮已经交给云端、还没等到回复。它跟 isTyping 不一样——生成不在这台
    // 设备上跑，所以要扛得住关页面重开（记录落在 localStorage，见 amsgInstantChat）。
    const [instantChatPending, setInstantChatPending] = useState(false);
    const [instantToolStatus, setInstantToolStatus] = useState<InstantToolUiStatus | null>(null);
    const [totalMsgCount, setTotalMsgCount] = useState(0);
    const [visibleCount, setVisibleCount] = useState(30);
    const [windowedFocusMsgId, setWindowedFocusMsgId] = useState<number | null>(null);
    const [historyWindowRange, setHistoryWindowRange] = useState<ChatHistoryWindowRange | null>(null);
    const [flashMsgId, setFlashMsgId] = useState<number | null>(null);
    // 角色切换/进入时的缓入开关：先 false（透明），下一帧转 true，靠 CSS transition 平滑淡入。
    // 初值 false 让首次打开也是淡入、且不会有"先显示再变透明"的闪烁。
    // 角色切换「登场」过场是否显示。切换/进入角色时由 useLayoutEffect 在绘制前置真，覆盖住加载、避免闪到新聊天。
    const [showEntry, setShowEntry] = useState(false);
    const [input, setInput] = useState('');
    const [showPanel, setShowPanel] = useState<'none' | 'actions' | 'emojis' | 'chars'>('none');
    const [collaborationOpen, setCollaborationOpen] = useState(false);
    const [collaborationPreviewAssetId, setCollaborationPreviewAssetId] = useState<string | null>(null);
    const [memoryRepairOpen, setMemoryRepairOpen] = useState(false);
    const [favoritesOpen, setFavoritesOpen] = useState(false);
    
    // Emoji State
    const [emojis, setEmojis] = useState<Emoji[]>([]);
    const [categories, setCategories] = useState<EmojiCategory[]>([]);
    const [activeCategory, setActiveCategory] = useState<string>('default');
    const [newCategoryName, setNewCategoryName] = useState('');
    const [newEmojiName, setNewEmojiName] = useState(''); // 表情包重命名输入框

    const scrollRef = useRef<HTMLDivElement>(null);
    const lastMsgIdRef = useRef<number | null>(null);
    // 最新图片在移动端异步解码后会把消息列表继续向下撑开。记录这一条，等真实高度
    // 确定后再补一次贴底；用户一旦主动向上翻，就清掉它，绝不抢滚动位置。
    const pendingMediaAutoScrollIdRef = useRef<number | null>(null);
    const scrollThrottleRef = useRef(0);
    const visibleCountRef = useRef(30);
    const pendingFavoriteJumpRef = useRef<{ charId: string; messageId: number } | null>(null);
    const historyWindowRangeRef = useRef<ChatHistoryWindowRange | null>(null);
    const historyWindowTotalRef = useRef(0);
    const historyWindowLoadingRef = useRef(false);
    const historyPrependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
    const historyJumpUnlockTimerRef = useRef<number | null>(null);
    const historyWindowScrollEnabledRef = useRef(false);
    const activeCharIdRef = useRef(activeCharacterId);
    // 流式预览接棒过的正式消息在当前会话内始终跳过入场动画，避免后续 DB 刷新时动画类又被加回来。
    const streamPreviewHandoverIdsRef = useRef<Set<number>>(new Set());
    const registerStreamPreviewHandover = useCallback((charId: string, messageIds: number[]) => {
        if (activeCharIdRef.current !== charId) return;
        messageIds.forEach(id => streamPreviewHandoverIdsRef.current.add(id));
    }, []);
    const charRef = useRef<typeof char>(null as any);
    // 白框提示音：记录当前角色"见过的最大消息 ID" + "上一条气泡到达时刻"，一轮回复只在首条气泡响一次。
    // 用 max-id 基线天然免疫：切角色/进入(先记基线不播)、翻旧历史(末尾 ID 变小不响)、自己发消息(role≠assistant 不响)。
    // lastAt 做回合去重：ta 一轮回复拆成多条气泡逐条下发（间隔 ≤2s），距上一条气泡 >3s 才算新回合、才响。
    const soundSyncRef = useRef<{ charId: string | null; maxId: number | null; lastAt: number | null }>({ charId: null, maxId: null, lastAt: null });
    // 回合去重阈值：气泡间最大间隔 = clamp(字数×50,500,2000)=2s，取 3s 安全合并同一轮，跨轮(LLM 延迟)一般远大于此。
    const SOUND_ROUND_GAP_MS = 3000;

    // Reply Logic
    const [replyTarget, setReplyTarget] = useState<Message | null>(null);

    const [modalType, setModalType] = useState<'none' | 'transfer' | 'emoji-import' | 'chat-settings' | 'message-options' | 'edit-message' | 'delete-emoji' | 'delete-category' | 'add-category' | 'history-manager' | 'archive-settings' | 'prompt-editor' | 'category-options' | 'category-visibility' | 'emoji-options' | 'rename-emoji' | 'schedule' | 'chrome-css' | 'chrome-sound' | 'memory-vectorize-confirm' | 'memory-vectorize-result'>('none');
    // 「聊天装扮」悬浮态：不走全屏 modal——圆气泡挂在聊天上，点开小面板边看真聊天边调。
    const [fineTuneOpen, setFineTuneOpen] = useState(false);          // 圆气泡在场
    const [fineTunePanelOpen, setFineTunePanelOpen] = useState(false); // 小面板展开/收起
    // 切换角色时收掉装扮气泡：定制是 per-character 的，避免误改到下一个角色
    useEffect(() => { setFineTuneOpen(false); setFineTunePanelOpen(false); }, [activeCharacterId]);
    const [scheduleData, setScheduleData] = useState<DailySchedule | null>(null);
    const [scheduleChangeNotice, setScheduleChangeNotice] = useState<ScheduleChangeEventDetail | null>(null);
    const dismissScheduleChangeNotice = useCallback(() => setScheduleChangeNotice(null), []);
    // 小剧场（窥视演出）：正在播放的时段索引（null = 未打开），以及生成中标志
    const [theaterSlotIdx, setTheaterSlotIdx] = useState<number | null>(null);
    const [isTheaterGenerating, setIsTheaterGenerating] = useState(false);
    const [isScheduleGenerating, setIsScheduleGenerating] = useState(false);
    const [allHistoryMessages, setAllHistoryMessages] = useState<Message[]>([]);
    const [transferAmt, setTransferAmt] = useState('');
    const [transferNote, setTransferNote] = useState('');
    const [emojiImportText, setEmojiImportText] = useState('');
    const [settingsContextLimit, setSettingsContextLimit] = useState(500);
    const [settingsContextRangeMode, setSettingsContextRangeMode] = useState<ContextRangeMode>('manual');
    const [settingsHideSysLogs, setSettingsHideSysLogs] = useState(false);
    const [settingsHtmlModeCustomPrompt, setSettingsHtmlModeCustomPrompt] = useState('');
    const contextSuiteAnyEnabled = memoryPalaceConfig.featureFlags?.recallRouter === true
        || memoryPalaceConfig.featureFlags?.interactionAdaptation === true
        || memoryPalaceConfig.featureFlags?.deepEngagement === true;
    const contextSuiteAllEnabled = memoryPalaceConfig.featureFlags?.recallRouter === true
        && memoryPalaceConfig.featureFlags?.interactionAdaptation === true
        && memoryPalaceConfig.featureFlags?.deepEngagement === true;
    const [preserveContext, setPreserveContext] = useState(true);
    const [isVectorizing, setIsVectorizing] = useState(false);
    // 记忆宫殿「一键存入」：打开设置弹窗时算出待处理条数（排除热区的真实口径），处理中显示逐轮进度
    const [vectorizePendingCount, setVectorizePendingCount] = useState<number | null>(null);
    const [vectorizeProgress, setVectorizeProgress] = useState('');
    const [retainRecentForVectorize, setRetainRecentForVectorize] = useState(false);
    const [vectorizeResult, setVectorizeResult] = useState<{
        processedMessages: number;
        storedMemories: number;
        retainedMessages: number;
        waterlineAlreadyAhead: boolean;
    } | null>(null);
    const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
    const [selectedEmoji, setSelectedEmoji] = useState<Emoji | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<EmojiCategory | null>(null); // For deletion modal
    const [editContent, setEditContent] = useState('');
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [archiveProgress, setArchiveProgress] = useState('');
    const [showProactiveModal, setShowProactiveModal] = useState(false);
    const [showActiveMsg2Modal, setShowActiveMsg2Modal] = useState(false);
    const [showThinkingChainModal, setShowThinkingChainModal] = useState(false);

    // Archive Prompts State
    const [archivePrompts, setArchivePrompts] = useState<{id: string, name: string, content: string}[]>(DEFAULT_ARCHIVE_PROMPTS);
    const [selectedPromptId, setSelectedPromptId] = useState<string>('preset_rational');
    const [editingPrompt, setEditingPrompt] = useState<{id: string, name: string, content: string} | null>(null);

    // --- Multi-Select State ---
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedMsgIds, setSelectedMsgIds] = useState<Set<number>>(new Set());
    // 思维链是 metadata.thinkingChain，没有独立 id，所以用宿主消息 id 作为键，
    // 与 selectedMsgIds 并行存在 —— 只勾思维链时只清 metadata，宿主消息保留。
    const [selectedThinkingMsgIds, setSelectedThinkingMsgIds] = useState<Set<number>>(new Set());

    // --- Translation State (per-character) ---
    const [translationEnabled, setTranslationEnabled] = useState(() => {
        try { return JSON.parse(localStorage.getItem(`chat_translate_enabled_${activeCharacterId}`) || 'false'); } catch { return false; }
    });
    const [translateSourceLang, setTranslateSourceLang] = useState(() => {
        // Fallback to legacy global key so existing users don't lose their setting on upgrade.
        return normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_source_lang_${activeCharacterId}`)
            || localStorage.getItem('chat_translate_source_lang')
            || '日本語') || '日本語';
    });
    const [translateTargetLang, setTranslateTargetLang] = useState(() => {
        return normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_lang_${activeCharacterId}`)
            || localStorage.getItem('chat_translate_lang')
            || '中文') || '中文';
    });
    const [translationExpanded, setTranslationExpanded] = useState(() => {
        try { return JSON.parse(localStorage.getItem(`chat_translate_expanded_${activeCharacterId}`) || 'false'); } catch { return false; }
    });
    // Which messages are currently showing "译" version (toggle state only, no API calls)
    const [showingTargetIds, setShowingTargetIds] = useState<Set<number>>(new Set());

    const char = characters.find(c => c.id === activeCharacterId) || characters[0];
    const memoryRepairRound = useMemo(() => {
        let assistantIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
                assistantIndex = i;
                break;
            }
        }
        if (assistantIndex < 0) {
            return { sinceTs: Date.now(), userMessage: '', assistantReply: '' };
        }
        let userIndex = -1;
        for (let i = assistantIndex - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                userIndex = i;
                break;
            }
        }
        const assistantReply = messages
            .slice(userIndex + 1)
            .filter(message => message.role === 'assistant')
            .map(message => message.content)
            .join('\n');
        return {
            // receipt 在用户消息落库之后、助手回复落库之前产生；留 1 秒时钟误差容差。
            sinceTs: userIndex >= 0 ? Math.max(0, messages[userIndex].timestamp - 1000) : messages[assistantIndex].timestamp - 60_000,
            userMessage: userIndex >= 0 ? messages[userIndex].content : '',
            assistantReply,
        };
    }, [messages]);
    const charDateKey = useLocalDateKey(resolveCharTimeZone(char));
    charRef.current = char; // Keep ref in sync for async callbacks
    const historyContextRange = useMemo(() => {
        if (!char) return undefined;
        return computeContextRangeSnapshot(
            allHistoryMessages,
            {
                ...char,
                contextRangeMode: settingsContextRangeMode,
                contextLimit: settingsContextLimit,
            },
            getMemoryPalaceHighWaterMarkForContext(char.id),
        );
    }, [
        allHistoryMessages,
        char,
        settingsContextLimit,
        settingsContextRangeMode,
    ]);
    useEffect(() => {
        if (
            modalType !== 'history-manager'
            || allHistoryMessages.length === 0
            || !char?.contextUserStartMessageId
            || !historyContextRange?.userBreakpointExpired
        ) return;
        // 最大范围已经向前越过用户断点：立即清掉持久化断点，防止以后拉大时旧断点复活。
        updateCharacter(char.id, { contextUserStartMessageId: undefined });
    }, [
        modalType,
        allHistoryMessages.length,
        char?.id,
        char?.contextUserStartMessageId,
        historyContextRange?.userBreakpointExpired,
        updateCharacter,
    ]);
    const currentThemeId = char?.bubbleStyle || 'default';
    // 解析逻辑抽到 utils/groupChat/theme.ts（群聊共用），行为不变
    const activeTheme = useMemo(
        () => resolveChatTheme(currentThemeId, customThemes, PRESET_THEMES),
        [currentThemeId, customThemes],
    );
    const draftKey = `chat_draft_${activeCharacterId}`;

    // Filter categories and emojis by active character's visibility (used for both AI prompt and UI)
    const visibleCategories = useMemo(() => categories.filter(cat => {
        if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) return true;
        return cat.allowedCharacterIds.includes(activeCharacterId);
    }), [categories, activeCharacterId]);

    const aiVisibleEmojis = useMemo(() => {
        const hiddenIds = new Set(categories.filter(c => !visibleCategories.some(vc => vc.id === c.id)).map(c => c.id));
        if (hiddenIds.size === 0) return emojis;
        return emojis.filter(e => !e.categoryId || !hiddenIds.has(e.categoryId));
    }, [emojis, categories, visibleCategories]);




    // 小程序快照 ref: MiniApp 状态变化时塞进来, useChatAI 在 build system prompt 时读取并注入
    const mcdMiniAppRef = useRef<import('../utils/mcdToolBridge').McdMiniAppSnapshot | undefined>(undefined);
    const luckinMiniAppRef = useRef<import('../utils/luckinToolBridge').LuckinMiniAppSnapshot | undefined>(undefined);
    // 瑞幸聊天点单模式 (点"瑞一杯"激活: 角色直接调真实工具, 注入定位)
    const luckinChatRef = useRef<import('../utils/luckinToolBridge').LuckinChatState | undefined>(undefined);

    // 生成闭包的回落守卫：triggerAI 的异步闭包在用户切到别的角色后才完成时（Chat 内
    // 切角色不卸载组件），迟到的 setMessages 会把旧角色的消息灌进当前会话视图。
    // 按消息 charId 丢弃不属于当前会话的回落——DB 已落库，且 OSContext 会因
    // chat-gen-reply-arrived bump lastMsgTimestamp，切回该角色时自然取回。
    const setMessagesFromGen = useCallback((msgs: Message[]) => {
        if (msgs.some(m => m.charId && m.charId !== activeCharIdRef.current)) return;
        setMessages(msgs);
    }, []);

    // 即时对话的「正在输入…」：受理 / 收到回复 / 超时判失败都会广播一次，界面跟着它亮灭。
    // 进这个角色时先读一次落盘记录——上一轮的回复可能是在应用关着的时候还没回来。
    // 这个 CustomEvent 只在本标签页内派发；别的标签页销账走下面那个 storage 监听
    //（搜 AMSG_INSTANT_CHAT_PENDING_LS_KEY）。
    useEffect(() => {
        const sync = () => setInstantChatPending(!!activeCharacterId && !!getInstantChatPending(activeCharacterId));
        sync();
        window.addEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, sync);
        return () => window.removeEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, sync);
    }, [activeCharacterId]);

    // --- Initialize Hook ---
    const { isTyping, streamingBubbles, streamingThinking, recallStatus, searchStatus, diaryStatus, emotionStatus, memoryPalaceStatus, memoryPalaceResult, setMemoryPalaceResult, lastDigestResult, setLastDigestResult, lastTokenUsage, tokenBreakdown, setLastTokenUsage, triggerAI, startProactiveChat, stopProactiveChat, isProactiveActive } = useChatAI({
        char,
        userProfile,
        apiConfig,
        groups,
        emojis: aiVisibleEmojis,
        categories: visibleCategories,
        addToast,
        showError,
        setMessages: setMessagesFromGen,
        onStreamPreviewHandover: registerStreamPreviewHandover,
        realtimeConfig,
        translationConfig: translationEnabled
            ? { enabled: true, sourceLang: translateSourceLang, targetLang: translateTargetLang }
            : undefined,
        memoryPalaceConfig,
        mcdMiniAppRef,
        luckinMiniAppRef,
        luckinChatRef,
        updateCharacter,
        updateUserProfile,
    });

    // --- Voice TTS for chat messages ---
    interface VoiceData { url: string; originalText: string; spokenText?: string; lang?: string; favorite?: boolean; }
    // Persisted shape (IndexedDB assets store). `blob` is the raw audio;
    // `remoteUrl` is the fallback when fetching the MiniMax CDN blob was blocked by CORS.
    interface StoredVoice {
        blob?: Blob;
        remoteUrl?: string;
        favorite?: boolean;
        originalText: string;
        spokenText?: string;
        lang?: string;
    }
    type GeneratedVoiceData = VoiceData & { blob: Blob | null };
    const voiceAssetKey = (msgId: number) => `voice_msg_${msgId}`;
    const chatFavoriteSourceKey = (msg: Pick<Message, 'charId' | 'id'>) => `${msg.charId}:${msg.id}`;
    const [voiceDataMap, setVoiceDataMap] = useState<Record<number, VoiceData>>({});
    const [chatFavoriteKeys, setChatFavoriteKeys] = useState<Set<string>>(new Set());
    const [contentFavoriteIds, setContentFavoriteIds] = useState<Set<string>>(new Set());
    const [voiceLoading, setVoiceLoading] = useState<Set<number>>(new Set());
    const [playingMsgId, setPlayingMsgId] = useState<number | null>(null);
    const chatAudioRef = useRef<HTMLAudioElement | null>(null);
    const prevIsTypingRef = useRef(false);
    // 即时对话那条路的自动合成扫描窗（用法见下面那个 auto-TTS 的 effect）：
    // 「正在输入」灯灭的那一下开窗，窗口内每次消息变化都补扫一遍；角色不对就整个作废。
    const prevInstantPendingRef = useRef(false);
    const instantVoiceScanUntilRef = useRef(0);
    const instantVoiceScanCharRef = useRef<string | undefined>(undefined);
    // 自动合成失败过的消息 id。扫描窗里每来一条新消息都会重扫一遍，不记下来的话同一条失败的
    // 消息会被反复重试、每次再弹一个「语音生成失败」。只挡自动那条路：用户自己点「转换语音」
    // 照样能重试（换了网络/补了 key 之后就该能成）。换角色时清空。
    const voiceFailedRef = useRef<Set<number>>(new Set());
    // Track blob: URLs we created so we can revoke them on character switch / unmount.
    const voiceBlobUrlsRef = useRef<Set<string>>(new Set());
    // We warn the user at most once (per character) that the active TTS provider isn't configured —
    // a character can produce many <语音> messages and we don't want to spam toasts.
    const ttsWarnedRef = useRef(false);

    /** Whether this character can synthesize real voice under the active TTS provider (key + a voice profile). */
    const isTtsReady = useCallback(() => canSynthesizeSpeech(char, apiConfig), [char, apiConfig]);

    const persistVoice = async (msgId: number, url: string, blob: Blob | null, originalText: string, spokenText: string | undefined, lang: string | undefined) => {
        try {
            const stored: StoredVoice = blob
                ? { blob, originalText, spokenText, lang, favorite: false }
                : { remoteUrl: url, originalText, spokenText, lang, favorite: false };
            await DB.saveAssetRaw(voiceAssetKey(msgId), stored);
        } catch (e) {
            console.warn('[Chat] persist voice failed', e);
        }
    };

    /** Drop in-memory + on-disk voice data for the given message ids. */
    const discardVoiceForMessages = (ids: Iterable<number>) => {
        const idList = Array.from(ids);
        if (!idList.length) return;
        setVoiceDataMap(prev => {
            let changed = false;
            const next = { ...prev };
            for (const id of idList) {
                const entry = next[id];
                if (!entry) continue;
                if (entry.url && entry.url.startsWith('blob:')) {
                    try { URL.revokeObjectURL(entry.url); } catch { /* ignore */ }
                    voiceBlobUrlsRef.current.delete(entry.url);
                }
                delete next[id];
                changed = true;
            }
            return changed ? next : prev;
        });
        // Best-effort: remove persisted entries so they don't reappear on next load.
        for (const id of idList) {
            DB.deleteAsset(voiceAssetKey(id)).catch(() => { /* ignore */ });
        }
    };

    const handlePlayVoice = (msgId: number) => {
        const data = voiceDataMap[msgId];
        if (!data) {
            // No voice data yet — trigger TTS generation (e.g. placeholder voice bar clicked)
            const msg = messages.find(m => m.id === msgId);
            if (msg) handleManualTts(msg, false);
            return;
        }
        if (!chatAudioRef.current) chatAudioRef.current = new Audio();
        const audio = chatAudioRef.current;
        if (playingMsgId === msgId) {
            audio.pause();
            setPlayingMsgId(null);
            return;
        }
        audio.src = data.url;
        audio.onended = () => setPlayingMsgId(null);
        audio.play().catch(() => {});
        setPlayingMsgId(msgId);
    };

    // 稳定的播放回调：用 ref 持有最新闭包，引用永不变 —— 避免每条消息每次渲染都新建箭头函数，
    // 否则 MessageItem 的 React.memo 会被击穿（30 条重组件每次都全量重渲染 = 进入聊天卡顿主因之一）。
    const handlePlayVoiceRef = useRef(handlePlayVoice);
    handlePlayVoiceRef.current = handlePlayVoice;
    const onPlayVoiceStable = useCallback((id: number) => handlePlayVoiceRef.current(id), []);

    // LLM 翻译兜底（语音条中外对照用）。查 res.ok + 失败重试一次 ——
    // 以前不查状态码、失败静默吞掉，翻译一次拿不到就永远空着（「外语语音没翻译」主因）。
    const llmTranslate = async (systemPrompt: string, text: string): Promise<string> => {
        const attempt = async (): Promise<string> => {
            const res = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
                    temperature: 0.3,
                }),
            });
            if (!res.ok) throw new Error(`translate http ${res.status}`);
            const data = await res.json();
            return data?.choices?.[0]?.message?.content?.trim() || '';
        };
        try { return await attempt(); }
        catch { try { return await attempt(); } catch { return ''; } }
    };

    const handleManualTts = async (msg: Message, autoTriggered = false): Promise<GeneratedVoiceData | null> => {
        if (voiceLoading.has(msg.id)) return null;
        if (voiceDataMap[msg.id]) {
            if (autoTriggered) return null;
            // 手动点「转换语音」= 用户要求重新生成（典型场景：编辑了消息内容后）。
            // 丢掉这条旧语音再走正常合成；文本没变时会命中共享 TTS 缓存，不会重复请求 API。
            discardVoiceForMessages([msg.id]);
        }

        // SAR 模块改变的是角色真正“发到外面/念出来”的表达。content 仍保存真意供上下文与
        // 总结读取，但 TTS 必须优先读 surface；否则会出现气泡是古风、耳朵听到原台词的穿帮。
        const voiceSourceContent = resolveSARModuleSpeechSource(msg);
        const sarVoiceSurface = voiceSourceContent !== msg.content;
        // Parse the structured voice output: spoken text (sanitized) + per-message emotion.
        const parsedVoice = parseVoiceOutput(voiceSourceContent);
        // Fish / ElevenLabs 的适配器需要看到原始 inline cue；MiniMax 使用已消毒的 speech。
        const ttsProvider = resolveTtsProvider(apiConfig);
        const preserveRawMarkup = providerUsesRawVoiceMarkup(apiConfig);
        const voiceTagContent = parsedVoice.hasVoiceTag ? (preserveRawMarkup ? parsedVoice.rawSpeech : parsedVoice.speech) : '';
        const voiceEmotion = parsedVoice.emotion;

        // Auto-TTS: only generate voice when AI explicitly used <语音> tag
        if (autoTriggered && !parsedVoice.hasVoiceTag) return null;
        // F12 调试：打印 LLM 这条消息的带标签原文，方便核对语音标签写法是否正确。
        // 放在上面那道门之后：即时对话的扫描窗里每来一条消息都要重扫一遍，
        // 搁在门前的话没有语音标签的普通消息会被反复打印，控制台直接刷屏。
        console.log('[voice] LLM 原文(带标签):', { provider: ttsProvider, content: voiceSourceContent, voiceTagContent, emotion: voiceEmotion, sarSurface: sarVoiceSurface });

        // 当前 TTS 引擎未配齐时不尝试合成（否则每条语音、每次点击都会抛错刷屏）。
        // 只提醒一次；<语音> 气泡仍保留「转文字」入口，所以台词不会丢。
        // The <语音> bubble still shows its 转文字 button so the
        // text stays readable, matching real voice messages.
        if (!isTtsReady()) {
            if (!autoTriggered && !ttsWarnedRef.current) {
                ttsWarnedRef.current = true;
                const tip = ttsProvider === 'fishaudio'
                    ? '该角色未配置鱼声音色或缺少 Fish API Key，无法播放真实语音，可点「转文字」查看内容'
                    : ttsProvider === 'elevenlabs'
                        ? '该角色未配置 ElevenLabs Voice ID 或缺少 ElevenLabs Key，无法播放真实语音，可点「转文字」查看内容'
                        : '该角色未配置 MiniMax 语音，无法播放真实语音，可点「转文字」查看内容';
                addToast(tip, 'info');
            }
            return null;
        }

        setVoiceLoading(prev => new Set(prev).add(msg.id));
        try {
            let spokenText: string;
            let originalText: string;
            const voiceLang = char.chatVoiceLang || '';

            if (voiceTagContent) {
                // AI already provided the spoken text (possibly translated) in <语音> tag.
                // parseVoiceOutput already sanitized it (whitelisted sound tags only).
                spokenText = voiceTagContent;
                // 翻译第一优先级: 模型显式给的 <字幕> 标签 —— 确定性, 不用猜也不用调 LLM。
                // 其次是标签外的文字 (老格式 / 模型没写字幕时的兜底)。
                // parseVoiceOutput 已做标签自愈 + 提取, 别再自己 replace 一遍。
                originalText = parsedVoice.subtitle
                    || (parsedVoice.display ? cleanTextForTts(parsedVoice.display) : '');
                // 字幕对齐模式下中文字幕通常被 chunk 成同批次的独立气泡, 语音消息标签外没字。
                // 先从兄弟气泡把字幕收回来当翻译 —— 确定性、零成本、跟用户看到的字幕逐字一致。
                // (内部有结构对齐校验: 模型没守字幕格式、标签外是闲聊短句时返回空, 走下面 LLM)
                if (voiceLang && !originalText) {
                    originalText = collectVoiceBatchSubtitle(messages, msg.id);
                }
                // 收不到 (纯语音回合 / 字幕对不齐) 再让 LLM 把外语翻回中文, 带 ok 检查 + 重试。
                if (voiceLang && !originalText && spokenText) {
                    originalText = await llmTranslate('把以下内容翻译成中文。只输出翻译结果，不要任何解释。', spokenText);
                }
            } else {
                // Manual TTS (long-press): no <语音> tag.
                // Bilingual messages already contain both a target-language side (before
                // %%BILINGUAL%%) and a Chinese side (after). When the char's voice language
                // matches the message's target language we reuse those halves directly —
                // translating again would just echo the target language back and produce
                // two identical foreign-language lines in the expanded voice bar.
                const bilingualIdx = voiceSourceContent.toLowerCase().indexOf('%%bilingual%%');
                const hasBilingual = bilingualIdx !== -1;
                if (hasBilingual && voiceLang) {
                    const langAText = cleanTextForTtsProvider(voiceSourceContent.substring(0, bilingualIdx), apiConfig);
                    const langBText = stripTtsMarkupForDisplay(voiceSourceContent.substring(bilingualIdx + '%%BILINGUAL%%'.length), apiConfig);
                    if (!langAText || langAText.length < 2) return null;
                    spokenText = langAText;
                    originalText = langBText || '';
                } else {
                    spokenText = cleanTextForTtsProvider(voiceSourceContent, apiConfig);
                    if (!spokenText || spokenText.length < 2) return null;
                    originalText = stripTtsMarkupForDisplay(spokenText, apiConfig) || spokenText;
                    if (voiceLang) {
                        const langLabel = voiceLanguagePromptLabel(voiceLang);
                        const translated = await llmTranslate(`Translate the following text to ${langLabel}. Output ONLY the translation, nothing else.`, originalText);
                        if (translated) spokenText = translated;
                    }
                }
            }

            if (!spokenText || spokenText.length < 2) return null;

            const { url: blobUrl, blob } = await synthesizeSpeechDetailed(spokenText, char, apiConfig, {
                languageBoost: voiceLang || undefined,
                groupId: apiConfig.minimaxGroupId || undefined,
                emotion: voiceEmotion,
            });
            if (blobUrl.startsWith('blob:')) voiceBlobUrlsRef.current.add(blobUrl);
            // 转文字面板只展示实际台词，不展示当前引擎的停顿 / 表演标记。
            const displaySpoken = stripTtsMarkupForDisplay(spokenText, apiConfig);
            const storedSpokenText = voiceTagContent ? displaySpoken : (voiceLang ? displaySpoken : undefined);
            const storedLang = voiceLang || undefined;
            setVoiceDataMap(prev => ({ ...prev, [msg.id]: { url: blobUrl, originalText, spokenText: storedSpokenText, lang: storedLang } }));
            // Persist so the voice bar survives leaving and re-entering the chat.
            persistVoice(msg.id, blobUrl, blob, originalText, storedSpokenText, storedLang);
            // 合成完是否立刻播（规则和来由见 shouldAutoPlayGeneratedVoice）：
            // AI 自动发来的默认不响、等用户点；用户自己点着要的一定响。
            if (shouldAutoPlayGeneratedVoice({ autoTriggered, autoPlayEnabled: char.chatVoiceAutoPlay })) {
                if (!chatAudioRef.current) chatAudioRef.current = new Audio();
                chatAudioRef.current.src = blobUrl;
                chatAudioRef.current.onended = () => setPlayingMsgId(null);
                chatAudioRef.current.play().catch(() => {});
                setPlayingMsgId(msg.id);
            }
            return { url: blobUrl, originalText, spokenText: storedSpokenText, lang: storedLang, blob };
        } catch (err: any) {
            // 记一笔失败：自动那条路下次扫到就跳过（见 voiceFailedRef 的说明）。
            voiceFailedRef.current.add(msg.id);
            addToast(`语音生成失败: ${err?.message || '未知错误'}`, 'error');
            return null;
        } finally {
            setVoiceLoading(prev => { const next = new Set(prev); next.delete(msg.id); return next; });
        }
    };

    // 长按语音菜单里的「下载」：移动端优先调系统分享/保存，桌面端才走浏览器下载。
    const handleDownloadVoice = async (msg: Message) => {
        if (!msg?.id) return;
        try {
            const stored = await DB.getAssetRaw(voiceAssetKey(msg.id)) as StoredVoice | null;
            let blob: Blob | null = stored?.blob instanceof Blob ? stored.blob : null;
            if (!blob && stored?.remoteUrl) {
                try { blob = await fetchBlobForShare(stored.remoteUrl, 'audio/mpeg'); } catch { /* 下面给出明确提示 */ }
            }
            const fname = `${(char?.name || '语音').replace(/[\\/:*?"<>|]/g, '_')}_语音_${msg.id}.mp3`;
            if (!blob) {
                addToast('这条还没有可下载的语音', 'error');
                return;
            }
            const result = await shareOrDownloadBlob({ blob, fileName: fname, shareTitle: `${char?.name || '角色'}的语音` });
            if (result === 'cancelled') return;
            addToast(result === 'shared' ? '已打开系统保存/分享' : '语音已开始下载', 'success');
            trackEvent('下载语音条');
        } catch {
            addToast('语音下载失败', 'error');
        }
    };

    const handleToggleVoiceFavorite = async (msg: Message) => {
        if (!msg?.id) return;
        try {
            const sourceKey = chatFavoriteSourceKey(msg);
            if (await getVoiceFavorite('chat', sourceKey)) {
                await removeVoiceFavorite('chat', sourceKey);
                setChatFavoriteKeys(prev => { const next = new Set(prev); next.delete(sourceKey); return next; });
                setVoiceDataMap(prev => prev[msg.id] ? ({ ...prev, [msg.id]: { ...prev[msg.id], favorite: false } }) : prev);
                addToast('已取消收藏语音', 'info');
                return;
            }
            let current: GeneratedVoiceData | VoiceData | undefined = voiceDataMap[msg.id];
            if (!current) current = await handleManualTts(msg, false) || undefined;
            if (!current) return;
            const stored = await DB.getAssetRaw(voiceAssetKey(msg.id)) as StoredVoice | null;

            let blob: Blob | null = 'blob' in current && current.blob instanceof Blob
                ? current.blob
                : stored?.blob instanceof Blob ? stored.blob : null;
            if (!blob) {
                try { blob = await fetchBlobForShare(current.url, 'audio/mpeg'); } catch { /* handled below */ }
            }
            if (!blob) {
                addToast('暂时拿不到这条语音的音频文件，无法收藏', 'error');
                return;
            }
            await saveVoiceFavorite({
                source: 'chat',
                sourceKey,
                charId: msg.charId,
                charName: char?.name || '未知角色',
                sourceTimestamp: msg.timestamp,
                originalText: current.originalText,
                spokenText: current.spokenText,
                language: current.lang,
                blob,
            });
            setChatFavoriteKeys(prev => new Set(prev).add(sourceKey));
            setVoiceDataMap(prev => ({ ...prev, [msg.id]: { ...prev[msg.id], favorite: true } }));
            addToast('已收藏语音，可在“收藏”里查看', 'success');
            trackEvent('收藏语音条');
        } catch (e) {
            console.warn('[Chat] favorite voice failed', e);
            addToast('收藏失败，请检查浏览器存储空间', 'error');
        }
    };

    // --- Auto-TTS: when chatVoiceEnabled, auto-generate voice when AI uses <语音> tag ---
    // Scans ALL recent assistant messages (not just the last one) because chunkText
    // may split a single AI response into multiple messages, and the <语音> tag could
    // end up in any chunk — not necessarily the final one.
    //
    // 两个触发源：
    //   · 本机生成：打字结束的那一下（wasTyping → !isTyping）。
    //   · 即时对话：回复在云端生成、靠推送落库，本机的 isTyping 在 POST 完就灭了，永远等不到
    //     那一下，开了自动播放的角色会一路静音。改看「正在输入」指示灯熄灭（instantChatPending
    //     由真变假），熄灭时开一个 30 秒的扫描窗——一轮回复常被拆成好几条推送陆续到，第一条到
    //     就熄灯，后面几条得靠窗口内每次 messages 变化补扫。只扫窗口内，冷启动和翻历史不会把
    //     旧消息整批合成一遍。
    useEffect(() => {
        const wasTyping = prevIsTypingRef.current;
        prevIsTypingRef.current = isTyping;
        const wasPending = prevInstantPendingRef.current;
        prevInstantPendingRef.current = instantChatPending;
        // 换角色先把窗清零：Chat 里切角色不卸载组件，这几个 ref 会跨角色留着。甲还欠着回复时
        // 切到乙，instantChatPending 会跟着乙的记录变假——那不是「乙的回复到了」，不能拿它开窗，
        // 更不能拿甲的窗去扫乙的历史消息。两个触发源都要先有一次「变化前」才成立，所以这里直接
        // 走人不会漏掉任何一次真的触发。
        if (instantVoiceScanCharRef.current !== char?.id) {
            instantVoiceScanCharRef.current = char?.id;
            instantVoiceScanUntilRef.current = 0;
            return;
        }
        // 覆盖范围就到这儿：销账是在页面里发生的，推送落地时人不在这个聊天页的话没有这次
        // 真→假的转换，那条回复就保持静音（跟「不批量合成历史」是同一个取舍）。
        if (wasPending && !instantChatPending) {
            instantVoiceScanUntilRef.current = Date.now() + INSTANT_VOICE_SCAN_WINDOW_MS;
        }
        // Only trigger when AI just finished typing (wasTyping → !isTyping)，或者还在即时对话的扫描窗里。
        // 这道门也是 messages 进依赖之后本机那条路的保险：不在窗里就仍然只在打字结束那一下扫，
        // 平时每来一条消息不会重扫。
        const typingJustEnded = wasTyping && !isTyping;
        const inInstantWindow = Date.now() < instantVoiceScanUntilRef.current;
        if (!typingJustEnded && !inInstantWindow) return;
        if (!char.chatVoiceEnabled) return;
        // 关着「收到就自动播放」就别提前合成（理由见 shouldAutoGenerateVoice）：
        // 空语音条照常出现，用户点了才合成、合成完直接播。
        if (!shouldAutoGenerateVoice({ autoPlayEnabled: char.chatVoiceAutoPlay })) return;
        if (!characterHasVoice(char, apiConfig)) return;
        // Scan recent assistant messages for unprocessed <语音> tags
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            // Stop scanning once we hit a non-assistant message (end of current AI response batch)
            if (msg.role !== 'assistant') break;
            if (msg.type !== 'text') continue;
            if (voiceDataMap[msg.id] || voiceLoading.has(msg.id)) continue;
            // 合成失败过就别再自动重试了：扫描窗里每来一条消息都重扫一遍，
            // 同一条会一路重试到窗口关闭，还每次弹一个失败提示。用户手点不受影响。
            if (voiceFailedRef.current.has(msg.id)) continue;
            handleManualTts(msg, true);
        }
    }, [isTyping, instantChatPending, messages]); // eslint-disable-line react-hooks/exhaustive-deps

    const canReroll = !isTyping && messages.length > 0 && messages[messages.length - 1].role === 'assistant';

    // --- Translation: pure frontend toggle (no API calls, bilingual data is already in message content) ---
    const handleTranslateToggle = useCallback((msgId: number) => {
        setShowingTargetIds(prev => {
            const next = new Set(prev);
            if (next.has(msgId)) next.delete(msgId);
            else next.add(msgId);
            return next;
        });
    }, []);

    const loadEmojiData = async () => {
        await DB.initializeEmojiData();
        const [es, cats] = await Promise.all([DB.getEmojis(), DB.getEmojiCategories()]);
        setEmojis(es);
        setCategories(cats);
        if (activeCategory !== 'default' && !cats.some(c => c.id === activeCategory)) {
            setActiveCategory('default');
        }
    };

    // Hydrate voice data from IndexedDB for currently visible messages.
    // Voice URLs are stored as blob: URLs that become invalid whenever the
    // component unmounts — persisting the raw blob and rebuilding the URL on
    // mount is what keeps previously-generated voice bars alive across
    // chat entries.
    useEffect(() => {
        if (!messages.length) return;
        const map = voiceDataMap;
        const toFetch = messages.filter(m => m.id && m.type === 'text' && m.role !== 'user' && !map[m.id]);
        if (!toFetch.length) return;
        let cancelled = false;
        (async () => {
            const updates: Record<number, VoiceData> = {};
            const favoriteKeys = new Set(
                (await listVoiceFavorites().catch(() => []))
                    .filter(item => item.source === 'chat')
                    .map(item => item.sourceKey),
            );
            if (!cancelled) setChatFavoriteKeys(favoriteKeys);
            for (const m of toFetch) {
                try {
                    const stored = await DB.getAssetRaw(voiceAssetKey(m.id)) as StoredVoice | null;
                    if (!stored) continue;
                    let url: string | null = null;
                    if (stored.blob instanceof Blob) {
                        url = URL.createObjectURL(stored.blob);
                        voiceBlobUrlsRef.current.add(url);
                    } else if (stored.remoteUrl) {
                        url = stored.remoteUrl;
                    }
                    if (!url) continue;
                    let originalText = stored.originalText || '';
                    // 存量毒数据自愈: 07-02~07-04 的版本曾把同回合的闲聊短句当翻译存进来
                    // (收字幕没做对齐校验)。认出来就清掉并回写, 别让错翻译一直挂在面板上。
                    if (stored.lang && originalText && isPoisonedVoiceSubtitle(messages, m.id, originalText)) {
                        originalText = '';
                        DB.saveAssetRaw(voiceAssetKey(m.id), { ...stored, originalText: '' })
                            .catch(() => { /* 回写失败下次进聊天再试 */ });
                    }
                    let favorited = favoriteKeys.has(chatFavoriteSourceKey(m));
                    // One-time migration for the short-lived per-message favorite shape.
                    // The dedicated archive survives message deletion and is shared by all three apps.
                    if (!favorited && stored.favorite === true && stored.blob instanceof Blob) {
                        try {
                            await saveVoiceFavorite({
                                source: 'chat',
                                sourceKey: chatFavoriteSourceKey(m),
                                charId: m.charId,
                                charName: char?.name || '未知角色',
                                sourceTimestamp: m.timestamp,
                                originalText,
                                spokenText: stored.spokenText,
                                language: stored.lang,
                                blob: stored.blob,
                            });
                            favorited = true;
                            DB.saveAssetRaw(voiceAssetKey(m.id), { ...stored, favorite: undefined }).catch(() => undefined);
                        } catch { /* keep the legacy marker and retry next entry */ }
                    }
                    updates[m.id] = { url, originalText, spokenText: stored.spokenText, lang: stored.lang, favorite: favorited };
                } catch { /* ignore single-message hydration errors */ }
            }
            if (cancelled || !Object.keys(updates).length) return;
            setVoiceDataMap(prev => ({ ...updates, ...prev }));
        })();
        return () => { cancelled = true; };
    }, [messages]);

    // The archive can remove an item while this chat stays mounted. Keep the
    // long-press menu's 收藏/取消收藏 label in sync without touching audio data.
    useEffect(() => {
        const syncFavoriteFlags = async () => {
            const keys = new Set(
                (await listVoiceFavorites().catch(() => []))
                    .filter(item => item.source === 'chat')
                    .map(item => item.sourceKey),
            );
            setChatFavoriteKeys(keys);
            setVoiceDataMap(prev => {
                let changed = false;
                const next = { ...prev };
                for (const message of messages) {
                    const voice = next[message.id];
                    if (!voice) continue;
                    const favorite = keys.has(chatFavoriteSourceKey(message));
                    if (!!voice.favorite !== favorite) {
                        next[message.id] = { ...voice, favorite };
                        changed = true;
                    }
                }
                return changed ? next : prev;
            });
        };
        window.addEventListener(VOICE_FAVORITES_CHANGED_EVENT, syncFavoriteFlags);
        return () => window.removeEventListener(VOICE_FAVORITES_CHANGED_EVENT, syncFavoriteFlags);
    }, [messages]);

    // Revoke blob URLs when switching characters / unmounting to avoid leaks.
    useEffect(() => {
        // Reset the "active TTS not configured" warning so each character gets one reminder.
        ttsWarnedRef.current = false;
        // 自动合成的失败记录也跟着换角色清空：这一位的失败不该拦着下一位。
        voiceFailedRef.current.clear();
        const urls = voiceBlobUrlsRef.current;
        return () => {
            urls.forEach(u => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
            urls.clear();
        };
    }, [activeCharacterId]);

    // How many messages to load per batch (initial load + each "load more" click)
    const LOAD_BATCH_SIZE = 30;

    const reloadMessages = useCallback(async (requestedVisibleCount: number) => {
        if (!activeCharacterId) return;

        const charIdAtStart = activeCharacterId;
        // 只用倒序游标取「最近 N 条」（含少量缓冲，抵消 date/call/系统消息被过滤后条数变少），
        // 不再 getAll 全量反序列化 —— 图片多/消息多的账号原本要把整段历史（含内联图片）一次性读进
        // 内存才显示 30 条，首次打开会卡好几秒。totalCount 走 index.count，不反序列化、极廉价。
        const fetchLimit = requestedVisibleCount >= 100000 ? requestedVisibleCount : requestedVisibleCount + 16;
        const applyResult = (recent: Message[], totalCount: number) => {
            // 用 ref 取当前 char（避免闭包过期）
            const currentChar = charRef.current;
            // 不在视觉层过滤 hideBeforeMessageId —— 用户能往上滚回看，
            // 上下文截断仅作用于发给 LLM 的 prompt（在 chatPrompts.ts 里处理）。
            const chatScopeMsgs = recent
                .filter(m => m.metadata?.source !== 'date' && m.metadata?.source !== 'call' && m.metadata?.source !== 'story_theater_memory')
                .filter(m => !(currentChar?.hideSystemLogs && m.role === 'system' && m.type !== 'score_card'));
            // totalCount 走 charId 索引全量计数，包含群聊消息（以及上面被过滤的约会/通话
            // 消息）——它们永远不会出现在单聊列表里。直接拿它算「加载历史消息」会出现
            // 有计数、点击却加载不出任何东西的幽灵按钮。倒序游标没取满 fetchLimit 条
            // 即说明该角色的单聊消息已全部在手，此时把总数钳到实际可展示的条数。
            const exhausted = recent.length < fetchLimit;
            setTotalMsgCount(exhausted ? chatScopeMsgs.length : totalCount);
            setMessages(chatScopeMsgs.slice(-requestedVisibleCount));
        };
        try {
            const { messages: recent, totalCount } = await DB.getRecentMessagesWithCount(activeCharacterId, fetchLimit);
            // Guard against stale async results: if the user switched characters
            // while the DB query was in flight, discard this result.
            if (activeCharIdRef.current !== charIdAtStart) return;
            applyResult(recent, totalCount);
        } catch (e) {
            // DB read failed — retry once after a short delay
            if (activeCharIdRef.current !== charIdAtStart) return;
            await new Promise(r => setTimeout(r, 200));
            if (activeCharIdRef.current !== charIdAtStart) return;
            try {
                const { messages: recent, totalCount } = await DB.getRecentMessagesWithCount(activeCharacterId, fetchLimit);
                if (activeCharIdRef.current !== charIdAtStart) return;
                applyResult(recent, totalCount);
            } catch { /* give up silently */ }
        }
    }, [activeCharacterId]);

    useEffect(() => {
        if (activeCharacterId) {
            // Update ref BEFORE any async work so stale reloadMessages calls
            // from a previous character can detect the switch and bail out.
            activeCharIdRef.current = activeCharacterId;

            // Clear messages immediately to prevent showing stale chat from previous character
            setMessages([]);
            setAllHistoryMessages([]);
            setTotalMsgCount(0);
            // Reset voice map — stale blob: URLs from the previous char are revoked
            // by the cleanup effect and must not be reused against new messages.
            setVoiceDataMap({});
            setPlayingMsgId(null);
            if (chatAudioRef.current) { try { chatAudioRef.current.pause(); } catch { /* ignore */ } }

            reloadMessages(LOAD_BATCH_SIZE);
            loadEmojiData();
            const savedDraft = localStorage.getItem(draftKey);
            setInput(savedDraft || '');
            if (char) {
                setSettingsContextLimit(char.contextLimit || 500);
                setSettingsContextRangeMode(resolveContextRangeMode(char));
                setSettingsHideSysLogs(char.hideSystemLogs || false);
                setSettingsHtmlModeCustomPrompt((char as any).htmlModeCustomPrompt || '');
                clearUnread(char.id);
            }
            // Per-character translation toggle + language pair
            try {
                setTranslationEnabled(JSON.parse(localStorage.getItem(`chat_translate_enabled_${activeCharacterId}`) || 'false'));
            } catch { setTranslationEnabled(false); }
            setTranslateSourceLang(
                normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_source_lang_${activeCharacterId}`)
                || localStorage.getItem('chat_translate_source_lang')
                || '日本語') || '日本語'
            );
            setTranslateTargetLang(
                normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_lang_${activeCharacterId}`)
                || localStorage.getItem('chat_translate_lang')
                || '中文') || '中文'
            );
            try {
                setTranslationExpanded(JSON.parse(localStorage.getItem(`chat_translate_expanded_${activeCharacterId}`) || 'false'));
            } catch { setTranslationExpanded(false); }
            setVisibleCount(30);
            visibleCountRef.current = 30;
            lastMsgIdRef.current = null;
            scrollThrottleRef.current = 0;
            setLastTokenUsage(null);
            setReplyTarget(null);
            setSelectionMode(false);
            setSelectedMsgIds(new Set());
            setRetainRecentForVectorize(false);
            setVectorizeResult(null);
            setShowingTargetIds(new Set());
            setWindowedFocusMsgId(null);
            setHistoryWindowRange(null);
            historyWindowRangeRef.current = null;
            historyWindowTotalRef.current = 0;
            historyWindowLoadingRef.current = false;
            historyPrependAnchorRef.current = null;
            historyWindowScrollEnabledRef.current = false;
            if (historyJumpUnlockTimerRef.current) {
                window.clearTimeout(historyJumpUnlockTimerRef.current);
                historyJumpUnlockTimerRef.current = null;
            }
            setFlashMsgId(null);
            try {
                const rawToolStatus = localStorage.getItem(`instant_tool_status_${activeCharacterId}`);
                const parsed = rawToolStatus ? JSON.parse(rawToolStatus) as InstantToolUiStatus : null;
                const fresh = parsed?.updatedAt && Date.now() - parsed.updatedAt < 2 * 60_000;
                setInstantToolStatus(fresh && parsed.phase !== 'done' ? parsed : null);
            } catch {
                setInstantToolStatus(null);
            }
        }
    }, [activeCharacterId, reloadMessages]);

    // 进入/切换角色时触发「登场」过场。useLayoutEffect 在浏览器绘制前置真，
    // 让过场层先盖住，避免一帧闪到新角色的空聊天界面。
    useLayoutEffect(() => {
        if (!activeCharacterId || osTheme.chatCharacterSwitchAnimationEnabled === false) {
            setShowEntry(false);
            return;
        }
        setShowEntry(true);
    }, [activeCharacterId, osTheme.chatCharacterSwitchAnimationEnabled]);

    useEffect(() => {
        let clearTimer: ReturnType<typeof setTimeout> | null = null;
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<InstantToolUiStatus>).detail;
            if (!detail?.charId || detail.charId !== activeCharIdRef.current) return;

            setInstantToolStatus(detail);
            if (clearTimer) {
                clearTimeout(clearTimer);
                clearTimer = null;
            }
            if (detail.phase === 'done' || detail.phase === 'failed') {
                clearTimer = setTimeout(() => {
                    setInstantToolStatus((prev) => (
                        prev?.sessionId && detail.sessionId && prev.sessionId !== detail.sessionId ? prev : null
                    ));
                    clearTimer = null;
                }, detail.phase === 'failed' ? 8000 : 5000);
            }
        };
        const receivedHandler = (e: Event) => {
            const detail = (e as CustomEvent<{ charId?: string }>).detail;
            if (detail?.charId && detail.charId !== activeCharIdRef.current) return;
            try {
                const charId = detail?.charId || activeCharIdRef.current;
                if (charId) localStorage.removeItem(`instant_tool_status_${charId}`);
            } catch { /* ignore */ }
            setInstantToolStatus(null);
        };
        window.addEventListener('instant-tool-status', handler);
        window.addEventListener('active-msg-received', receivedHandler);
        return () => {
            window.removeEventListener('instant-tool-status', handler);
            window.removeEventListener('active-msg-received', receivedHandler);
            if (clearTimer) clearTimeout(clearTimer);
        };
    }, []);

    useEffect(() => {
        const onScheduleChange = (event: Event) => {
            const detail = (event as CustomEvent<ScheduleChangeEventDetail>).detail;
            if (!detail || detail.charId !== activeCharIdRef.current) return;
            setScheduleData(detail.schedule);
            setScheduleChangeNotice(detail);
        };
        window.addEventListener(SCHEDULE_CHANGE_EVENT, onScheduleChange);
        return () => window.removeEventListener(SCHEDULE_CHANGE_EVENT, onScheduleChange);
    }, []);

    useEffect(() => setScheduleChangeNotice(null), [activeCharacterId]);

    // Auto-generate daily schedule (fire-and-forget on chat load)
    // 总开关关闭时完全跳过：不查询 DB、不调用副 API、不跑兜底
    useEffect(() => {
        if (!char || !apiConfig.apiKey) return;
        if (!isScheduleFeatureOn(char)) {
            setScheduleData(null);
            return;
        }
        getDailyScheduleForChar(char).then(existing => {
            if (!existing) {
                // Generate in background, don't block chat
                generateDailySchedule(char, false);
            } else {
                setScheduleData(existing);
            }
        }).catch(() => {});
    }, [activeCharacterId, char?.scheduleFeatureEnabled, char?.customTimezoneEnabled, char?.customTimezone, charDateKey]);

    // 每次真正打开聊天设置时从角色持久化值重新初始化；避免用户在记忆宫殿页
    // 切换全自动模式后，隐藏着的 Chat 组件仍带着旧拉杆状态。
    useEffect(() => {
        if (modalType !== 'chat-settings' || !char) return;
        setSettingsContextLimit(char.contextLimit || 500);
        setSettingsContextRangeMode(resolveContextRangeMode(char));
        setSettingsHideSysLogs(char.hideSystemLogs || false);
        setSettingsHtmlModeCustomPrompt((char as any).htmlModeCustomPrompt || '');
    }, [modalType, char?.id]);

    // Load all messages when history-manager modal opens
    useEffect(() => {
        if (modalType === 'history-manager' && activeCharacterId) {
            DB.getMessagesByCharId(activeCharacterId, true).then(allMsgs => {
                // 范围管理必须使用 AI 可能读取的完整私聊序列，不能先按聊天界面显示偏好
                // 隐掉系统/约会/通话消息，否则「最近 N 条」起点会与真实 prompt 发生偏移。
                setAllHistoryMessages(allMsgs);
            });
        }
    }, [modalType, activeCharacterId]);

    useEffect(() => {
        const savedPrompts = localStorage.getItem('chat_archive_prompts');
        if (savedPrompts) {
            try {
                const parsed = JSON.parse(savedPrompts);
                const merged = [...DEFAULT_ARCHIVE_PROMPTS, ...parsed.filter((p: any) => !p.id.startsWith('preset_'))];
                setArchivePrompts(merged);
            } catch(e) {}
        }
        const savedId = localStorage.getItem('chat_active_archive_prompt_id');
        if (savedId && archivePrompts.some(p => p.id === savedId)) setSelectedPromptId(savedId);
    }, []);

    useEffect(() => {
        if (activeCharacterId && lastMsgTimestamp > 0) {
            reloadMessages(visibleCountRef.current);
            clearUnread(activeCharacterId);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearUnread is stable (useCallback with []), omit to prevent stale-dep lint noise
    }, [lastMsgTimestamp, activeCharacterId, reloadMessages, clearUnread]);

    // 即时对话待收记录的跨标签页补听。同一聊天开两个标签页时，回复推送到达后 SW 把
    // 广播发给所有 client，后台标签页的 flush 可能先抢到并落库——销账的 CustomEvent
    // 只在它自己那边派发，这边收不到，「正在输入…」就会无限常亮、回复也不上屏。
    // 待收记录本来就落在 localStorage，而 storage 事件恰好只在「其他」标签页触发，
    // 正好补上这条缝：这个 key 一变，就照上面 CustomEvent 那套处理走——刷新指示灯，
    // 并重载消息把对方标签页落的库带上屏。同标签页内的 CustomEvent 机制保持不动。
    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            // 严格按 key 过滤，别的 localStorage 变动（草稿、翻译开关等）一概不理。
            if (e.key !== AMSG_INSTANT_CHAT_PENDING_LS_KEY) return;
            const charId = activeCharIdRef.current;
            setInstantChatPending(!!charId && !!getInstantChatPending(charId));
            if (charId) reloadMessages(visibleCountRef.current);
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [reloadMessages]);

    useEffect(() => {
        visibleCountRef.current = visibleCount;
    }, [visibleCount]);

    // （旧的"首次自动归档 banner"已移除，自动归档改为用户在神经链接里显式 opt-in）

    // buff 同步已上移到 OSContext 的 App 级 'emotion-updated' 监听 (无条件按事件 charId 更新内存,
    // 不再受"当前是否开着该角色聊天页"限制). 之前这里有个 `charId === activeCharacterId` 守卫的
    // handler, 导致 instant 模式下用户不在该角色页时 buff 回不到前端 (只落 DB), 故移除, 同时
    // 避免和 OSContext 双写.

    const handleInputChange = (val: string) => {
        setInput(val);
        if (val.trim()) localStorage.setItem(draftKey, val);
        else localStorage.removeItem(draftKey);
    };

    useLayoutEffect(() => {
        if (!scrollRef.current || selectionMode) return;
        const currentLastId = messages.length > 0 ? messages[messages.length - 1].id : null;
        // Only auto-scroll when a new message is appended (ID changes),
        // not when loading older history or updating existing messages in-place.
        // windowed 模式下用户在翻旧消息，不要被新消息打断滚走。
        if (currentLastId !== lastMsgIdRef.current) {
            if (windowedFocusMsgId === null) {
                pendingMediaAutoScrollIdRef.current = currentLastId;
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            } else {
                pendingMediaAutoScrollIdRef.current = null;
            }
            lastMsgIdRef.current = currentLastId;
        }
    }, [messages, activeCharacterId, selectionMode, windowedFocusMsgId]);

    const extendHistoryWindow = useCallback((direction: 'older' | 'newer') => {
        const scroller = scrollRef.current;
        const range = historyWindowRangeRef.current;
        if (!scroller || !range || historyWindowLoadingRef.current) return;

        const nextRange = expandChatHistoryWindow(
            range,
            historyWindowTotalRef.current,
            direction,
            HISTORY_WINDOW_BATCH_SIZE,
        );
        if (nextRange.start === range.start && nextRange.end === range.end) return;

        historyWindowLoadingRef.current = true;
        if (direction === 'older') {
            // 前插消息会把当前内容整体向下顶；记录原高度，提交 DOM 后补偿差值，
            // 用户看到的位置就不会突然跳走。
            historyPrependAnchorRef.current = {
                scrollHeight: scroller.scrollHeight,
                scrollTop: scroller.scrollTop,
            };
        }
        historyWindowRangeRef.current = nextRange;
        setHistoryWindowRange(nextRange);
    }, []);

    useLayoutEffect(() => {
        if (!historyWindowRange) return;
        const anchor = historyPrependAnchorRef.current;
        const scroller = scrollRef.current;
        if (anchor && scroller) {
            scroller.scrollTop = anchor.scrollTop + (scroller.scrollHeight - anchor.scrollHeight);
        }
        historyPrependAnchorRef.current = null;
        historyWindowLoadingRef.current = false;
    }, [historyWindowRange]);

    const handleChatScroll = useCallback(() => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (distanceFromBottom > 96) pendingMediaAutoScrollIdRef.current = null;

        if (historyWindowScrollEnabledRef.current && historyWindowRangeRef.current) {
            if (scroller.scrollTop <= 96) extendHistoryWindow('older');
            else if (distanceFromBottom <= 96) extendHistoryWindow('newer');
        }
    }, [extendHistoryWindow]);

    const handleMessageMediaLoad = useCallback((messageId: number) => {
        if (windowedFocusMsgId !== null || pendingMediaAutoScrollIdRef.current !== messageId) return;
        requestAnimationFrame(() => {
            if (pendingMediaAutoScrollIdRef.current !== messageId) return;
            const scroller = scrollRef.current;
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
            pendingMediaAutoScrollIdRef.current = null;
        });
    }, [windowedFocusMsgId]);

    useEffect(() => {
        if (isTyping && scrollRef.current && !selectionMode && windowedFocusMsgId === null) {
            const now = Date.now();
            if (now - scrollThrottleRef.current > 150) {
                scrollThrottleRef.current = now;
                scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
            }
        }
    }, [messages, isTyping, streamingBubbles, streamingThinking, recallStatus, searchStatus, diaryStatus, selectionMode, windowedFocusMsgId]);

    // 白框提示音：当 char 新发的消息成为会话最后一条时播放一次（用户自己/历史/翻旧消息都不响）。
    // 声音配置编码在白框 CSS 注释里（角色 chromeCustomCss 覆盖全局 chatChromeCustomCss），随白框分享一起走。
    useEffect(() => {
        const sync = soundSyncRef.current;
        const last = messages.length > 0 ? messages[messages.length - 1] : null;
        const lastId = last ? last.id : null;
        // 切角色 / 首次进入：只记录基线，不播（避免一打开聊天就响）；回合计时清零。
        if (sync.charId !== activeCharacterId) {
            sync.charId = activeCharacterId ?? null;
            sync.maxId = lastId;
            sync.lastAt = null;
            return;
        }
        if (lastId == null) return;
        const isNew = sync.maxId == null || lastId > sync.maxId;
        if (isNew) {
            // 仅"char 发送的、落到底部的最新一条"才触发：assistant 且非见面/通话等旁路消息。
            const src = last?.metadata?.source;
            if (last?.role === 'assistant' && src !== 'date' && src !== 'call') {
                // 回合首条即响：距上一条气泡 >3s 视为新回合，立刻响一次；同一轮后续气泡只刷新计时、不再响。
                const now = Date.now();
                if (sync.lastAt == null || now - sync.lastAt > SOUND_ROUND_GAP_MS) {
                    playWhiteboxSound(resolveActiveSound(char?.chromeCustomCss, char?.chatSound, osTheme.chatChromeCustomCss, osTheme.chatSound));
                }
                sync.lastAt = now;
            }
        }
        // 基线只增不减：翻旧历史让末尾 ID 变小时不下调，返回底部也不会重复触发。
        sync.maxId = sync.maxId == null ? lastId : Math.max(sync.maxId, lastId);
    }, [messages, activeCharacterId, osTheme.chatChromeCustomCss, osTheme.chatSound, char?.chromeCustomCss, char?.chatSound]);

    const formatTime = (ts: number) => {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    };

    // --- Actions ---

    const handleSendText = async (customContent?: string, customType?: MessageType, metadata?: any) => {
        if (!char || (!input.trim() && !customContent)) return;
        // 只累加内存里的计数，这里不发任何请求；页面切走时才按区间报一次。见 utils/analytics.ts
        noteMessageSent();
        // 借用户"发送"这个手势解锁音频上下文，好让稍后 AI 回复时的白框提示音能顺利播放（移动端自动播放策略）。
        unlockWhiteboxAudio();
        const text = customContent || input.trim();
        const type = customType || 'text';

        // 发消息隐含"回到当前聊天"——退出 windowed 旧消息浏览模式
        if (windowedFocusMsgId !== null) {
            setWindowedFocusMsgId(null);
            setHistoryWindowRange(null);
            historyWindowRangeRef.current = null;
            historyWindowTotalRef.current = 0;
            historyWindowScrollEnabledRef.current = false;
            visibleCountRef.current = LOAD_BATCH_SIZE;
            setVisibleCount(LOAD_BATCH_SIZE);
            setFlashMsgId(null);
        }

        // 用户手打"麦请求"三个字 → 等价于点击麦克风按钮 (拉起麦当劳菜单)
        // 不落库, 跟按钮点击行为完全一致, 避免出现"banner 在但菜单没拉起"的诡异状态
        if (!customContent && type === 'text' && text === MCD_ACTIVATE_TRIGGER) {
            setInput(''); localStorage.removeItem(draftKey);
            if (!isMcdConfigured()) {
                addToast('请先到设置 → 麦当劳 启用并填入 MCP Token', 'info');
                return;
            }
            setMcdAppOpen(true);
            trackEvent('打开麦当劳点单小程序');
            setShowPanel('none');
            return;
        }

        // 用户手打"瑞一杯" → 激活角色瑞幸点单模式 (注入提示词+工具+定位, 角色自己点)
        if (!customContent && type === 'text' && text === LUCKIN_ACTIVATE_TRIGGER) {
            setInput(''); localStorage.removeItem(draftKey);
            activateLuckin();
            return;
        }
        if (!customContent && type === 'text' && text === LUCKIN_DEACTIVATE_TRIGGER) {
            setInput(''); localStorage.removeItem(draftKey);
            deactivateLuckin();
            return;
        }

        if (!customContent) { setInput(''); localStorage.removeItem(draftKey); }
        
        // 图片 / 表情消息存的是短令牌，图片二进制单独躺在 blob_assets 里，省掉 base64 那 ~33%
        // 的膨胀。同一张图之前存过就直接复用它的令牌；转不动时原样还回这条 data URL，图不会丢。
        // http 外链（网络表情）和已经是令牌的值都原样通过。
        // 注意：这条消息和下面存进相册的那条共用同一个令牌（按内容哈希认人，只存一份 Blob），
        // 所以删消息时绝不能顺手删 Blob——那会把相册里的同一张图一起删破。失去引用的 Blob
        // 交给孤儿 GC 收（见 utils/blobGc.ts）。
        const storedContent = (type === 'image' || type === 'emoji') && text.startsWith('data:')
            ? await migrateDataUrlToRef(text)
            : text;

        const imageChatContext = type === 'image'
            ? messages.slice(-10).map(m => {
                const sender = m.role === 'user' ? userProfile.name : char.name;
                const isMedia = m.type === 'image' || m.type === 'emoji' || isImageValue(m.content);
                const preview = isMedia
                    ? buildReplySnapshotContent(m)
                    : m.content.substring(0, 100);
                return `${sender}: ${preview}`;
            })
            : null;

        const msgPayload: any = { charId: char.id, role: 'user', type, content: storedContent, metadata };
        
        if (replyTarget) {
            msgPayload.replyTo = {
                // 引用图片 / 表情时快照存 '[图片]' 之类的占位符，不把令牌原样带进这条消息
                // （跟角色侧的引用快照同一个函数，口径一致）
                id: replyTarget.id,
                content: buildReplySnapshotContent(replyTarget),
                name: replyTarget.role === 'user' ? '我' : char.name
            };
            setReplyTarget(null);
        }

        const savedUserMsgId = await DB.saveMessage(msgPayload);

        if (type === 'image') {
            // 相册是消息的附带记录：保留来源消息引用供收藏/去重使用，但相册写入失败
            // 不能阻断已经落库的聊天消息。
            try {
                await DB.saveGalleryImage({
                    id: `img-${Date.now()}-${Math.random()}`,
                    charId: char.id,
                    url: storedContent,
                    timestamp: Date.now(),
                    sourceMessageId: savedUserMsgId,
                    savedDate: localDateKey,
                    chatContext: imageChatContext || undefined,
                });
                addToast('图片已保存至相册', 'info');
            } catch (err) {
                console.warn('[Chat] 图片存相册失败，消息照常发送', err);
                addToast('图片没能存进相册，消息照常发送', 'error');
            }
        }

        // 小红书链接 → xhs_card。主路径不依赖任何后端：小红书分享文案自带标题（【标题】）
        // 和笔记 id/token，直接解析就能建卡，让「没部署小红书 MCP」的用户也能让角色看到分享了哪篇笔记。
        // 配了 MCP 的话再抓详情补正文/封面/作者（锦上添花，抓失败也不影响基础卡）。
        if (type === 'text') {
            let xhsCardCreated = false;
            let webpageCardCreated = false;
            const xhsFullNoteId = extractXhsNoteId(text);
            // 同时识别桌面/旧版 xhslink.com 与手机版新版 xhslink.cn。
            const xhsShortUrl = detectXhsShortUrl(text);
            if (xhsFullNoteId || xhsShortUrl) {
                let noteId = xhsFullNoteId || '';
                let xsecToken = text.match(/xsec_token=([^&\s]+)/)?.[1];
                let shortLinkError = '';
                // 短链（xhslink.com / xhslink.cn）不含 id/token —— 先经 sfworker 展开成真实链接再提取。
                if (!noteId && xhsShortUrl) {
                    try {
                        const finalUrl = await expandShortUrl(xhsShortUrl);
                        noteId = extractXhsNoteId(finalUrl) || '';
                        xsecToken = xsecToken || finalUrl.match(/xsec_token=([^&\s]+)/)?.[1];
                        if (isDevDebugAvailable()) console.log('[卡片调试] 小红书短链展开 →', finalUrl, '| noteId =', noteId);
                    } catch (e) {
                        console.warn('xhslink 短链展开失败:', e);
                        shortLinkError = e instanceof Error ? e.message : '短链展开失败';
                    }
                }
                // 兼容旧版「【标题 | 小红书】」和新版「标题 ... 短链 打开【小红书】」。
                // 不能直接取第一个【】块：新版唯一的括号内容是应用名，会把卡片标题错误写成“小红书”。
                const titleFromText = extractXhsShareTitle(text);

                // 拿不到 noteId（短链展开失败/被挡）就不建空卡，保留原文给用户，并明确
                // 告诉用户如何排查。此前这里完全静默，表现就是“角色能分享、用户分享不了”。
                if (noteId) {
                    // 基础卡数据来自分享文案，零后端依赖。
                    let note: any = {
                        noteId, title: titleFromText || '', desc: '', author: '',
                        authorId: '', likes: 0, xsecToken,
                    };

                    // 有小红书 MCP/Lite 才抓详情补全（正文/封面/作者/赞数）。
                    const mcpUrl = realtimeConfig?.xhsMcpConfig?.serverUrl;
                    if (mcpUrl && realtimeConfig?.xhsMcpConfig?.enabled) {
                        try {
                            const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}${xsecToken ? `?xsec_token=${xsecToken}&xsec_source=pc_share` : ''}`;
                            // loadAllComments：和角色自己浏览笔记 (XHS_DETAIL) 一致地把评论区也抓回来，
                            // 否则 user 分享的笔记只有标题/正文，角色读不到评论（char 分享给 user 的却能看到）。
                            const result = await XhsMcpClient.getNoteDetail(mcpUrl, noteUrl, xsecToken, { loadAllComments: true });
                            if (isDevDebugAvailable()) console.log('[卡片调试] 小红书抓取 result =', result);
                            if (result.success && result.data) {
                                const fetched = normalizeXhsLiteDetail(result.data);
                                // 抓到的字段补全基础卡；id/标题/token 保底，标题优先文案标题（更完整可读）。
                                note = { ...note, ...fetched, noteId: fetched.noteId || note.noteId, title: titleFromText || fetched.title || note.title, xsecToken: fetched.xsecToken || xsecToken };
                            } else if (!result.success) {
                                // 基础卡仍然可以发送，只提示详情读取失败，避免误以为整次分享失败。
                                addToast(`小红书正文读取失败，已发送基础卡片。请尝试开启/关闭科学上网、切换 Wi‑Fi/流量，或检查 Lite 配置。${result.error ? `（${result.error}）` : ''}`, 'info');
                            }
                        } catch (e) {
                            console.warn('XHS link fetch via MCP failed (已用文案兜底):', e);
                            addToast('小红书正文读取失败，已发送基础卡片。请尝试开启/关闭科学上网、切换 Wi‑Fi/流量，或检查 Lite 配置。', 'info');
                        }
                    }

                    await DB.saveMessage({
                        charId: char.id,
                        role: 'user',
                        type: 'xhs_card',
                        content: note.title || '小红书笔记',
                        metadata: { xhsNote: note }
                    });
                    // F12 调试（仅开发分支）：打印卡片存了啥 + 角色实际会读到的文本。
                    if (isDevDebugAvailable()) {
                        console.log('[卡片调试] 小红书卡片·metadata =', note);
                        console.log('[卡片调试] 小红书卡片·角色将读到 =\n' + normalizeMessageContent(
                            { type: 'xhs_card', role: 'user', content: note.title || '小红书笔记', metadata: { xhsNote: note } } as any,
                            char.name, userProfile.name,
                        ));
                    }
                    xhsCardCreated = true;
                } else {
                    addToast(`小红书链接解析失败，原消息已保留。通常是网络或代理导致短链无法展开：请尝试开启/关闭科学上网、切换 Wi‑Fi/流量，并检查网络代理与小红书 Lite 配置。${shortLinkError ? `（${shortLinkError}）` : ''}`, 'error');
                }
            }

            // 通用网页分享：检测到普通 http(s) 链接 → 抓取正文存成 webpage_card，
            // 让角色"看见"网页内容。跳过 XHS 链接（上面已有专门的 MCP 卡片路径）。
            // 视频平台链接（抖音/B站/快手…）Jina 基本抓不到东西（SPA+登录墙），
            // 优先走 apizero 视频解析拿标题/作者/封面/热度；失败降级回通用网页抓取。
            const sharedUrl = detectFirstUrl(text);
            if (sharedUrl && !isXhsUrl(sharedUrl) && !(xhsFullNoteId || xhsShortUrl)) {
                let webpage: ExtractedWebpage | null = null;
                if (isVideoShareUrl(sharedUrl)) {
                    try {
                        addToast('正在解析视频链接…', 'info');
                        webpage = await parseVideoShareUrl(sharedUrl);
                    } catch (e) {
                        console.warn('Video parse failed, fallback to webpage fetch:', e);
                    }
                }
                if (!webpage) {
                    try {
                        addToast('正在读取网页内容…', 'info');
                        webpage = await extractWebpageContent(sharedUrl);
                    } catch (e: any) {
                        console.warn('Webpage fetch failed:', e);
                        addToast(`网页抓取失败：${e?.message || '可能被这个站点拦截了，换个链接或稍后再试。'}`, 'error');
                    }
                }
                if (webpage) {
                    await DB.saveMessage({
                        charId: char.id,
                        role: 'user',
                        type: 'webpage_card',
                        content: webpage.title,
                        metadata: { webpage },
                    });
                    // F12 调试（仅开发分支）：打印卡片存了啥 + 角色实际会读到的文本。
                    if (isDevDebugAvailable()) {
                        console.log('[卡片调试] 网页卡片·metadata =', webpage);
                        console.log('[卡片调试] 网页卡片·角色将读到 =\n' + normalizeMessageContent(
                            { type: 'webpage_card', role: 'user', content: webpage.title, metadata: { webpage } } as any,
                            char.name, userProfile.name,
                        ));
                    }
                    webpageCardCreated = true;
                }
            }

            // 一段话里出现链接 = 整条就是分享（符合用户习惯）→ 建卡成功就删原文，只留卡片。
            if ((xhsCardCreated || webpageCardCreated) && savedUserMsgId) {
                await DB.deleteMessage(savedUserMsgId);
            }
        }

        await reloadMessages(visibleCountRef.current);
        setShowPanel('none');

        // Instant Push 模式：发完文本自动触发 AI（响应在 worker 端跑、后台 push 回写聊天页）。
        // 本地模式仍维持手动触发以保留现有 UX。triggerAI 内部会从 DB 拉完整历史，
        // 闭包里的 messages 还没包含刚写入的 user msg 也没关系。
        // 仅文本消息触发；image / xhs_card 等卡片消息不触发，与本地手动行为对齐。
        // autoTriggerOnSend gate：instant ready 也只在用户显式开启"发送后自动触发"时才自动回复，
        // 否则保留手动 ⚡（避免"启用 instant = 自动回复"的反直觉强绑定）。
        const instantCfg = loadInstantConfig();
        if (type === 'text' && isInstantConfigReady(instantCfg) && instantCfg.autoTriggerOnSend) {
            // 上一轮还在跑时直接跳过：triggerAI 内部会因 isTyping=true 静默 reject，
            // 提前 guard 避免点亮"准备中"指示灯后没人来清，UI 灯被卡住。
            if (isTyping) return;
            // 标记"准备中"三个点：拼接+发送期间显示，SSE POST 入队 (onInstantPosted) 后清除。
            setInstantSendingActive(true);
            triggerAI(messages, undefined, () => setInstantSendingActive(false));
        }
    };

    // 用户点开「收到的转账」卡（角色发来、待处理）选择接收 / 退回：
    // 标记原转账状态 + 补一张回执小卡（role=user，角色侧 prompt 会看到 [[记录:TRANSFER|to=user|...|status=已收下/已退回]]）。
    const handleResolveTransfer = useCallback(async (msg: Message, action: 'accepted' | 'returned') => {
        if (!char) return;
        // 只处理仍待处理的转账，避免重复点击造成多张回执。
        if (msg.metadata?.receipt) return;
        if (msg.metadata?.status && msg.metadata.status !== 'pending') return;
        await DB.updateMessageMetadata(msg.id, (prev) => ({ ...(prev || {}), status: action, resolvedAt: Date.now() }));
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'transfer',
            content: action === 'accepted' ? '[已收款]' : '[已退回]',
            metadata: { receipt: action, amount: msg.metadata?.amount, ref: msg.id },
        });
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // 用户点「生活记录」代记卡选择确认 / 否决：
    // 否决 → 记录标记 rejected（不再计入注入摘要）+ 回滚银行流水（expense）+
    // 给代记角色挂一条一次性反馈，下一轮 system prompt 会告诉角色它弄错了。
    const handleResolveLifeRecord = useCallback(async (msg: Message, action: 'confirmed' | 'rejected') => {
        if (!char) return;
        // 只处理仍待复核的卡片，避免重复点击。
        if (msg.metadata?.reviewStatus && msg.metadata.reviewStatus !== 'active') return;
        try {
            await resolveLifeRecordCard(msg, action);
            // 否决会把这条记录踢出注入摘要、回滚银行流水，生活记录是注入给所有开了开关的
            // 角色的共享素材，所以逐个打脏（同表情库）。
            markAmsgStateDirtyForAll({ characters, userProfile, groups, realtimeConfig });
            addToast(action === 'confirmed' ? '已确认记录' : '已否决，记录撤销', action === 'confirmed' ? 'success' : 'info');
        } catch (e) {
            console.error('[LifeRecord] resolve failed:', e);
        }
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages, addToast, characters, userProfile, groups, realtimeConfig]);

    // 顶栏 ⚡ 手动触发。instant 模式下给"上一条 assistant 之后的所有 user 消息"打上"准备中"
    // 三个点（从写入 DB 到 SSE POST 入队之间），由 onInstantPosted 清除 ——
    // 与 autoTriggerOnSend 自动路径的指示器行为一致。本地模式无此指示器，直接 triggerAI。
    const handleManualTrigger = () => {
        // 同上：上一轮还在跑时 triggerAI 会静默 reject，提前挡掉避免指示灯卡死。
        if (isTyping) return;
        if (!isInstantConfigReady()) { triggerAI(messages); return; }
        // instantSendingActive 驱动 header "发送中…" 徽章 (拼接+发送窗口). 消息上的三个小圆点
        // 另走纯前端判定 (isTyping && 最后一条消息), 见渲染处.
        setInstantSendingActive(true);
        triggerAI(messages, undefined, () => setInstantSendingActive(false));
    };

    const handleReroll = async () => {
        if (isTyping || messages.length === 0) return;

        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role !== 'assistant') return;

        const toDeleteIds: number[] = [];
        let index = messages.length - 1;
        while (index >= 0 && messages[index].role === 'assistant') {
            toDeleteIds.push(messages[index].id);
            index--;
        }

        if (toDeleteIds.length === 0) return;

        await DB.deleteMessages(toDeleteIds);
        discardVoiceForMessages(toDeleteIds);
        // 重 roll 也删了消息：正常路径下这轮生成结束会再打脏一次，这里先打是兜住
        // 「触发失败没走到生成收尾」的路径，云端 fire_pack 不能停在删除前。
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
        const newHistory = messages.slice(0, index + 1);
        setMessages(newHistory);
        addToast('回溯对话中...', 'info');
        trackEvent('重新生成回复');

        // 重 roll：不注入上一轮残留的情绪 buff 与意识流（innerState），两边独立重新生成。
        triggerAI(newHistory, undefined, undefined, { skipEmotionInjection: true });
    };

    const handleImageSelect = async (file: File) => {
        try {
            const base64 = await processImage(file, { maxWidth: 600, quality: 0.6, forceJpeg: true });
            setShowPanel('none');
            await handleSendText(base64, 'image');
        } catch (err: any) {
            addToast(err.message || '图片处理失败', 'error');
        }
    };

    const handlePanelAction = (type: string, payload?: any) => {
        // 只统计「打开某个面板 / 开关某个能力」这几个固定入口，名单写死在这里；
        // 选表情、选分类之类的动作不上报。
        if ([
            'transfer', 'archive', 'settings', 'chrome-css', 'chrome-sound', 'fine-tune',
            'meetup', 'proactive', 'active-msg-2', 'schedule', 'mcd-request', 'luckin-request',
            'html-mode-toggle', 'html-mode-settings', 'thinking-settings', 'favorites', 'collaboration',
            // 独立小功能：点一下就是用了一次，跟「打开某个面板」同一性质。
            // send-emoji / select-category 这些是「挑哪一个」，不进名单。
            'poke', 'emoji-import', 'add-category', 'mcd-end', 'luckin-end',
        ].includes(type)) {
            trackEvent('打开聊天功能面板项', { action: type });
        }
        switch (type) {
            case 'collaboration': setShowPanel('none'); setCollaborationOpen(true); break;
            case 'memory-link': setShowPanel('none'); setMemoryRepairOpen(true); break;
            case 'favorites': setShowPanel('none'); setFavoritesOpen(true); break;
            case 'transfer': setModalType('transfer'); break;
            case 'poke': handleSendText('[戳一戳]', 'interaction'); break;
            case 'archive': setModalType('archive-settings'); break;
            case 'settings': setModalType('chat-settings'); break;
            case 'chrome-css': setModalType('chrome-css'); break;
            case 'chrome-sound': setModalType('chrome-sound'); break;
            case 'fine-tune': setShowPanel('none'); setFineTuneOpen(true); setFineTunePanelOpen(true); break;
            case 'emoji-import': setModalType('emoji-import'); break;
            case 'send-emoji': if (payload) handleSendText(payload.url, 'emoji'); break;
            case 'delete-emoji-req': setSelectedEmoji(payload); setModalType('delete-emoji'); break;
            case 'emoji-options': setSelectedEmoji(payload); setModalType('emoji-options'); break;
            case 'add-category': setModalType('add-category'); break;
            case 'select-category': setActiveCategory(payload); break;
            case 'category-options': setSelectedCategory(payload); setModalType('category-options'); break;
            case 'delete-category-req': setSelectedCategory(payload); setModalType('delete-category'); break;
            case 'meetup': if (char) { setShowPanel('none'); openDateWithChar(char.id); } break;
            case 'proactive': setShowProactiveModal(true); break;
            case 'active-msg-2': setShowActiveMsg2Modal(true); break;
            case 'emotion': setModalType('schedule'); break; // 情绪已并入日程，打开同一 modal
            case 'schedule': setModalType('schedule'); break;
            case 'mcd-not-configured':
                addToast('请先到设置 → 麦当劳 启用并填入 MCP Token', 'info');
                break;
            case 'mcd-request':
                setMcdAppOpen(true);
                trackEvent('打开麦当劳点单小程序');
                break;
            case 'mcd-end':
                handleSendText(MCD_DEACTIVATE_TRIGGER, 'text', { mcdDeactivate: true });
                break;
            case 'luckin-not-configured':
                addToast('请先到设置 → 瑞幸 启用并填入 MCP Token', 'info');
                break;
            case 'luckin-request':
                activateLuckin();
                break;
            case 'luckin-end':
                deactivateLuckin();
                break;
            case 'html-mode-toggle': {
                if (!char) break;
                const next = !((char as any).htmlModeEnabled);
                updateCharacter(char.id, { htmlModeEnabled: next } as any);
                addToast(next ? 'HTML 模式已开启' : 'HTML 模式已关闭', next ? 'success' : 'info');
                break;
            }
            case 'html-mode-settings': {
                // 长按 → 跳进聊天设置 modal 的 HTML 模块板块 (顺便确保开关已打开, 不然滚下去看不见 textarea)
                if (!char) break;
                if (!(char as any).htmlModeEnabled) {
                    updateCharacter(char.id, { htmlModeEnabled: true } as any);
                }
                setModalType('chat-settings');
                break;
            }
            case 'thinking-settings': {
                // 「展示思考」按钮 → 打开思考链设置 modal（开关 / 卡片风格 / 配色 / 追加提示词）
                if (!char) break;
                setShowThinkingChainModal(true);
                break;
            }
        }
    };

    // 当前会话麦请求是否激活 (从消息历史推导, 无新存储)
    const mcdActivated = useMemo(() => isMcdActivatedInMessages(messages), [messages]);
    const [mcdAppOpen, setMcdAppOpen] = useState(false);
    // mcdMiniAppRef 声明在文件靠前 (传给 useChatAI), 这里仅占位
    const mcdConfiguredFlag = useMemo(() => isMcdConfigured(), [showPanel, mcdActivated]);

    // 瑞幸聊天点单模式: 激活态用 React state (临时会话态, 不落库)
    const [luckinMode, setLuckinMode] = useState(false);
    const [showLuckinLoc, setShowLuckinLoc] = useState(false); // 瑞一杯定位选择弹窗
    const [showLuckinHelp, setShowLuckinHelp] = useState(false); // 瑞一杯使用说明
    const luckinActivated = luckinMode;
    const [luckinAppOpen, setLuckinAppOpen] = useState(false); // 旧小程序壳, 现已不主动开
    const luckinConfiguredFlag = useMemo(() => isLuckinConfigured(), [showPanel, luckinActivated]);

    const activateLuckin = useCallback(() => {
        if (!isLuckinConfigured()) { addToast('请先到设置 → 瑞幸 启用并填入 MCP Token', 'info'); return; }
        setShowPanel('none');
        setShowLuckinLoc(true); // 先选定位 (GPS 常抓到机房位置, 让用户选城市)
    }, [addToast]);

    // 选完定位 → 正式激活角色瑞幸模式, 把坐标注入给角色
    const onLuckinLocationPick = useCallback((lng: number, lat: number, cityName?: string) => {
        luckinChatRef.current = { active: true, longitude: lng, latitude: lat, cityName };
        setLuckinMode(true);
        setShowLuckinLoc(false);
        trackEvent('开启瑞一杯聊天点单');
        addToast(`瑞一杯已开启 ☕ 定位: ${cityName || '已设置'}`, 'info');
        // 首次启动: 自动弹一次使用说明 (之后收在 banner 的 ? 里)
        try {
            if (localStorage.getItem('aetheros.luckin.helpSeen') !== '1') {
                setShowLuckinHelp(true);
                localStorage.setItem('aetheros.luckin.helpSeen', '1');
            }
        } catch { /* ignore */ }
    }, [addToast]);

    const deactivateLuckin = useCallback(() => {
        luckinChatRef.current = { active: false };
        setLuckinMode(false);
    }, []);

    // 用户在菜单卡里点"发送给角色"时, 把购物车作为 user 消息插入
    const handleMcdSendCart = useCallback(async (items: import('../components/chat/McdCard').McdCartItem[]) => {
        if (!char || !items.length) return;
        const summary = items.map(i => `${i.name}×${i.qty}`).join('、');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` 共¥${total.toFixed(2)}` : '';
        const content = `想要下单：${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'mcd_card',
            content,
            metadata: { mcdCardKind: 'cart', mcdCartItems: items },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // 用户在菜单卡某条单品上点 💭 → 立即把这条扔给角色让 ta 评价 (候选状态, 不进购物车)
    const handleMcdCandidate = useCallback(async (item: import('../components/chat/McdCard').McdCartItem) => {
        if (!char || !item) return;
        const priceStr = typeof item.price === 'number' ? ` ¥${item.price}` : (typeof item.price === 'string' && item.price ? ` ¥${item.price}` : '');
        const content = `「${item.name}」${priceStr}—— 这个怎么样？`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'mcd_card',
            content,
            metadata: { mcdCardKind: 'candidate', mcdCandidate: item },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // 小程序内输入 → 直接保存 user 消息 + 立即触发 AI (主聊天 handleSendText 不自动触发,
    // 那是设计上的"手动 ⚡ 触发"流程, 但小程序里用户预期发完就有回复, 跳过那个步骤)。
    // 走完整 pipeline: useChatAI 在 build prompt 时会读 mcdMiniAppRef 注入小程序状态。
    const handleMcdMiniAppSend = useCallback(async (text: string) => {
        if (!char || !text.trim() || isTyping) return;
        const trimmed = text.trim();
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'text',
            content: trimmed,
            metadata: { fromMcdMiniApp: true },
        } as any);
        const recent = await DB.getRecentMessagesByCharId(char.id, 200);
        setMessages(recent);
        triggerAI(recent);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [char, isTyping, triggerAI]);

    // 小程序状态实时同步到 ref, 让下次 send 走主 pipeline 时能注入到 system prompt
    const handleMcdMiniAppStateChange = useCallback((state: import('../utils/mcdToolBridge').McdMiniAppSnapshot) => {
        mcdMiniAppRef.current = state;
    }, []);

    // 小程序里"敲定"购物车 → 把购物车转成 cart 卡 (复用现有渲染), 之后 Phase 2
    // 会在这里挂 calculate-price + create-order。当前先让 char 看到购物车评论。
    const handleMcdAppConfirm = useCallback(async (
        cart: import('../components/mcd/McdMiniApp').CartLine[],
        ctx: import('../components/mcd/McdMiniApp').OrderContext,
    ) => {
        if (!char || !cart.length) return;
        const items: import('../components/chat/McdCard').McdCartItem[] = cart.map(l => ({
            code: l.code,
            name: l.name,
            price: l.price,
            qty: l.qty,
        }));
        const summary = items.map(i => `${i.name}×${i.qty}`).join('、');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` 共¥${total.toFixed(2)}` : '';
        const where = ctx.orderType === 2
            ? `外送至 ${ctx.addressLabel || ctx.addressId}`
            : `到店取餐 (${ctx.storeName || ctx.storeCode})`;
        const content = `${where} · ${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'mcd_card',
            content,
            metadata: {
                mcdCardKind: 'cart',
                mcdCartItems: items,
                mcdOrderContext: ctx,
            },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // ─── 瑞幸 handlers (与麦当劳同构) ───
    const handleLuckinSendCart = useCallback(async (items: import('../components/chat/LuckinCard').LuckinCartItem[]) => {
        if (!char || !items.length) return;
        const summary = items.map(i => `${i.name}×${i.qty}`).join('、');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` 共¥${total.toFixed(2)}` : '';
        const content = `想要下单：${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'luckin_card',
            content,
            metadata: { luckinCardKind: 'cart', luckinCartItems: items },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    const handleLuckinCandidate = useCallback(async (item: import('../components/chat/LuckinCard').LuckinCartItem) => {
        if (!char || !item) return;
        const priceStr = (typeof item.price === 'number' || (typeof item.price === 'string' && item.price)) ? ` ¥${item.price}` : '';
        const content = `「${item.name}」${priceStr}—— 这个怎么样？`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'luckin_card',
            content,
            metadata: { luckinCardKind: 'candidate', luckinCandidate: item },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    const handleLuckinMiniAppSend = useCallback(async (text: string) => {
        if (!char || !text.trim() || isTyping) return;
        const trimmed = text.trim();
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'text',
            content: trimmed,
            metadata: { fromLuckinMiniApp: true },
        } as any);
        const recent = await DB.getRecentMessagesByCharId(char.id, 200);
        setMessages(recent);
        triggerAI(recent);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [char, isTyping, triggerAI]);

    const handleLuckinMiniAppStateChange = useCallback((state: import('../utils/luckinToolBridge').LuckinMiniAppSnapshot) => {
        luckinMiniAppRef.current = state;
    }, []);

    const handleLuckinAppConfirm = useCallback(async (
        cart: import('../components/luckin/LuckinMiniApp').CartLine[],
        ctx: import('../components/luckin/LuckinMiniApp').OrderContext,
    ) => {
        if (!char || !cart.length) return;
        const items: import('../components/chat/LuckinCard').LuckinCartItem[] = cart.map(l => ({
            code: l.code,
            name: l.name,
            price: l.price,
            qty: l.qty,
            spec: l.spec,
        }));
        const summary = items.map(i => `${i.name}×${i.qty}`).join('、');
        const total = items.reduce((s, c) => {
            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
            return s + (isFinite(p) ? p * c.qty : 0);
        }, 0);
        const totalStr = total > 0 ? ` 共¥${total.toFixed(2)}` : '';
        const content = `到店自提 (${ctx.storeName || ctx.deptId}) · ${summary}${totalStr}`;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'luckin_card',
            content,
            metadata: {
                luckinCardKind: 'cart',
                luckinCartItems: items,
                luckinOrderContext: ctx,
            },
        } as any);
        await reloadMessages(visibleCountRef.current);
    }, [char, reloadMessages]);

    // --- Schedule Handlers ---
    const loadSchedule = async () => {
        if (!char) return;
        if (!isScheduleFeatureOn(char)) { setScheduleData(null); return; }
        const s = await getDailyScheduleForChar(char);
        setScheduleData(s);
    };

    // Load schedule when modal opens
    React.useEffect(() => {
        if (modalType === 'schedule') loadSchedule();
    }, [modalType]);

    // 日程表随 fire_pack 一起上云（角色到点按它说自己在干嘛），改完要让云端那份跟上：
    // 用户把「健身」改成「在家养病」，角色晚上还说「刚从健身房回来」就穿帮了。
    const handleScheduleEdit = async (index: number, slot: ScheduleSlot) => {
        if (!scheduleData) return;
        const newSlots = [...scheduleData.slots];
        newSlots[index] = slot;
        const updated = { ...scheduleData, slots: newSlots };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
    };

    const handleScheduleDelete = async (index: number) => {
        if (!scheduleData) return;
        const newSlots = scheduleData.slots.filter((_, i) => i !== index);
        const updated = { ...scheduleData, slots: newSlots };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
    };

    const handleScheduleCoverChange = async (dataUrl: string) => {
        if (!scheduleData) return;
        const updated = { ...scheduleData, coverImage: dataUrl };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
    };

    // 小剧场：点某个时段的播放按钮。有缓存直接放；没有则先生成再放（forceRegenerate=重演）。
    const runTheater = async (index: number, forceRegenerate: boolean) => {
        if (!char || !scheduleData) return;
        const slot = scheduleData.slots[index];
        if (!slot) return;
        trackEvent('打开日程小剧场', { mode: forceRegenerate ? 'replay' : 'play' });
        // 命中缓存且非重演：直接打开，不烧 token
        if (!forceRegenerate && slot.theater && slot.theater.lines.length > 0) {
            setTheaterSlotIdx(index);
            return;
        }
        setTheaterSlotIdx(index);
        setIsTheaterGenerating(true);
        try {
            const updated = await generateSlotTheater(char, userProfile, scheduleData, index, apiConfig, forceRegenerate);
            if (updated) {
                setScheduleData(updated);
            } else {
                addToast('小剧场生成失败，稍后再试', 'error');
                setTheaterSlotIdx(null);
            }
        } catch (e) {
            console.error('[Theater] play failed:', e);
            addToast('小剧场生成失败，稍后再试', 'error');
            setTheaterSlotIdx(null);
        } finally {
            setIsTheaterGenerating(false);
        }
    };

    const handlePlayTheater = (index: number) => { runTheater(index, false); };

    // 把这段小剧场作为卡片发到聊天。两态都「留痕」——角色都知道自己当时干了啥，
    // 区别只在 exposed：是否知道「user 看到了」。
    //   exposed=true  → TA 会发现你在偷看
    //   exposed=false → TA 不知道你看了（但照样记得自己干了啥）
    // 发卡片本身不再自动触发对话——只留痕，下次聊天角色自然带着这份记忆。
    const handleSendTheaterCard = async (index: number, exposed: boolean) => {
        if (!char || !scheduleData) return;
        const slot = scheduleData.slots[index];
        if (!slot?.theater || slot.theater.lines.length === 0) return;
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'theater_card',
            content: `${slot.startTime} · ${slot.activity}`,
            metadata: {
                theater: slot.theater,
                slotTime: slot.startTime,
                activity: slot.activity,
                emoji: slot.emoji,
                date: scheduleData.date,
                exposed,
            },
        });
        // 关掉播放器 + 日程 modal，回到聊天看到卡片（但不强行触发回复）
        setTheaterSlotIdx(null);
        setModalType('none');
        await reloadMessages(visibleCountRef.current);
        addToast(exposed ? '已让 TA 发现你在看 👀' : '已悄悄记下 · TA 不知道你看了 🙈', 'info');
    };

    const generateDailySchedule = async (targetChar: typeof char, forceRegenerate: boolean = false) => {
        if (!targetChar || isScheduleGenerating) return;
        setIsScheduleGenerating(true);
        try {
            const result = await generateDailyScheduleForChar(targetChar, userProfile, apiConfig, forceRegenerate);
            if (result) {
                setScheduleData(result);
                // 跨天后台重新生成也要刷云端：不刷的话角色到点照着昨天的作息表说话
                markAmsgStateDirty({ char: targetChar, userProfile, groups, realtimeConfig });
            }
        } catch (e) {
            console.error('[Schedule] Generation error:', e);
        } finally {
            setIsScheduleGenerating(false);
        }
    };

    const handleScheduleStyleChange = async (style: 'lifestyle' | 'mindful') => {
        if (!char) return;
        // 与情绪/意识流强制同步：启用日程时自动启用情绪感知
        const prevEmotion = char.emotionConfig;
        const nextEmotion = { ...(prevEmotion || {}), enabled: true };
        updateCharacter(char.id, { scheduleStyle: style, emotionConfig: nextEmotion });
        // Force regenerate with new style — use updated char object
        const updatedChar = { ...char, scheduleStyle: style, emotionConfig: nextEmotion };
        if (!isScheduleFeatureOn(updatedChar)) return;
        setIsScheduleGenerating(true);
        try {
            const result = await generateDailyScheduleForChar(updatedChar, userProfile, apiConfig, true);
            if (result) setScheduleData(result);
        } catch (e) {
            console.error('[Schedule] Regeneration after style change failed:', e);
        } finally {
            setIsScheduleGenerating(false);
        }
    };

    // 日程 / 情绪 buff 总开关
    // 关闭：清空前台 scheduleData，同时清空可能已缓存的 buff 注入（防止继续污染下一轮 prompt）
    // 打开：若还没生成今日日程，立即生成一次
    const handleToggleScheduleFeature = async () => {
        if (!char) return;
        const nextEnabled = !isScheduleFeatureOn(char);
        const patch: any = { scheduleFeatureEnabled: nextEnabled };
        if (nextEnabled) {
            // 与 handleScheduleStyleChange 对齐：开日程 = 同步开情绪/意识流。
            // 旧逻辑下，新角色的 emotionConfig 从未初始化（undefined），
            // 仅切总开关而不点风格时，emotionConfig?.enabled 始终落 false，
            // 副 API 闸门 (isScheduleFeatureOn && emotionConfig?.enabled) 永远过不去。
            patch.emotionConfig = { ...(char.emotionConfig || {}), enabled: true };
        } else {
            // 关闭时顺手把 buff 注入清空，避免上一轮残留继续注入
            patch.buffInjection = '';
            patch.activeBuffs = [];
        }
        updateCharacter(char.id, patch);
        if (!nextEnabled) {
            setScheduleData(null);
            addToast('日程与情绪已关闭', 'info');
            return;
        }
        addToast('日程与情绪已开启', 'success');
        // 打开后立刻尝试生成（若今日未生成且已选风格）
        const updatedChar = { ...char, ...patch };
        if (updatedChar.scheduleStyle) {
            const existing = await getDailyScheduleForChar(updatedChar).catch(() => null);
            if (existing) {
                setScheduleData(existing);
            } else {
                generateDailySchedule(updatedChar, false);
            }
        }
    };

    // --- Modal Handlers ---

    /**
     * 表情库是全局的：增删改名、删分类、改分类可见范围，都会让每个角色云端 fire_pack 里
     * 那份表情清单过期。角色到点照旧清单发 [[SEND_EMOJI]]，客户端反查不到就只能落降级
     * 文本气泡——所以这几个入口都要重新打包。
     */
    const markEmojiLibraryChanged = () => markAmsgStateDirtyForAll({ characters, userProfile, groups, realtimeConfig });

    const handleAddCategory = async () => {
        if (!newCategoryName.trim()) {
             addToast('请输入分类名称', 'error');
             return;
        }
        const newCat = { id: `cat-${Date.now()}`, name: newCategoryName.trim() };
        await DB.saveEmojiCategory(newCat);
        await loadEmojiData();
        setActiveCategory(newCat.id);
        setModalType('none');
        setNewCategoryName('');
        addToast('分类创建成功', 'success');
    };

    const handleImportEmoji = async () => {
        if (!emojiImportText.trim()) return;
        const lines = emojiImportText.split('\n');
        const targetCatId = activeCategory === 'default' ? undefined : activeCategory;

        for (const line of lines) {
            const parts = line.split('--');
            if (parts.length >= 2) {
                const name = parts[0].trim();
                const url = parts.slice(1).join('--').trim();
                if (name && url) {
                    // 粘进来的可能是 data: 图（复制粘贴的图片），也可能是图床外链。
                    // 前者转成令牌只留二进制，后者是别人服务器上的地址，原样存。
                    const stored = url.startsWith('data:') ? await migrateDataUrlToRef(url) : url;
                    await DB.saveEmoji(name, stored, targetCatId);
                }
            }
        }
        await loadEmojiData();
        markEmojiLibraryChanged();
        setModalType('none');
        setEmojiImportText('');
        addToast('表情包导入成功', 'success');
    };

    const handleDeleteCategory = async () => {
        if (!selectedCategory) return;
        await DB.deleteEmojiCategory(selectedCategory.id);
        await loadEmojiData();
        markEmojiLibraryChanged();
        setActiveCategory('default');
        setModalType('none');
        setSelectedCategory(null);
        addToast('分类及包含表情已删除', 'success');
    };

    const handleSaveCategoryVisibility = async (categoryId: string, allowedCharacterIds: string[] | undefined) => {
        const cat = categories.find(c => c.id === categoryId);
        if (!cat) return;
        await DB.saveEmojiCategory({ ...cat, allowedCharacterIds });
        await loadEmojiData();
        markEmojiLibraryChanged();
        setSelectedCategory(null);
        addToast(allowedCharacterIds ? `已设置 ${allowedCharacterIds.length} 个角色可见` : '已设为所有角色可见', 'success');
    };

    const handleSavePrompt = () => {
        if (!editingPrompt || !editingPrompt.name.trim() || !editingPrompt.content.trim()) {
            addToast('请填写完整', 'error');
            return;
        }
        setArchivePrompts(prev => {
            let next;
            if (prev.some(p => p.id === editingPrompt.id)) {
                next = prev.map(p => p.id === editingPrompt.id ? editingPrompt : p);
            } else {
                next = [...prev, editingPrompt];
            }
            const customOnly = next.filter(p => !p.id.startsWith('preset_'));
            localStorage.setItem('chat_archive_prompts', JSON.stringify(customOnly));
            return next;
        });
        setSelectedPromptId(editingPrompt.id);
        setModalType('archive-settings');
        setEditingPrompt(null);
    };

    const handleDeletePrompt = (id: string) => {
        if (id.startsWith('preset_')) {
            addToast('默认预设不可删除', 'error');
            return;
        }
        setArchivePrompts(prev => {
            const next = prev.filter(p => p.id !== id);
            const customOnly = next.filter(p => !p.id.startsWith('preset_'));
            localStorage.setItem('chat_archive_prompts', JSON.stringify(customOnly));
            return next;
        });
        if (selectedPromptId === id) setSelectedPromptId('preset_rational');
        addToast('预设已删除', 'success');
    };

    const createNewPrompt = () => {
        setEditingPrompt({ id: `custom_${Date.now()}`, name: '新预设', content: DEFAULT_ARCHIVE_PROMPTS[0].content });
        setModalType('prompt-editor');
    };

    const editSelectedPrompt = () => {
        const p = archivePrompts.find(a => a.id === selectedPromptId);
        if (!p) return;
        if (p.id.startsWith('preset_')) {
            setEditingPrompt({ id: `custom_${Date.now()}`, name: `${p.name} (Copy)`, content: p.content });
        } else {
            setEditingPrompt({ ...p });
        }
        setModalType('prompt-editor');
    };

    const handleBgUpload = async (file: File) => {
        try {
            // 改存 Blob：原画质不重绘，二进制进 blob_assets，字段只存 blobref 令牌
            // （省掉 base64 的 ~33% 膨胀，也不再把整张图常驻在角色行里）。
            const blob = await processImageToBlob(file, { skipCompression: true });
            const ref = await putImageBlob(blob);
            updateCharacter(char.id, { chatBackground: ref });
            addToast('聊天背景已更新', 'success');
        } catch(err: any) {
            addToast(err.message, 'error');
        }
    };

    const saveSettings = async () => {
        const canUseAdaptiveRange = !!(char.autoArchiveEnabled || char.contextFollowsMemoryPalaceHwm);
        const nextMode: ContextRangeMode = canUseAdaptiveRange
            ? settingsContextRangeMode
            : 'manual';
        const nextFollowsOneShotWaterline = nextMode === 'adaptive'
            && !!char.contextFollowsMemoryPalaceHwm;
        const candidate = {
            ...char,
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextRangeMode: nextMode,
            contextLimit: settingsContextLimit,
            contextFollowsMemoryPalaceHwm: nextFollowsOneShotWaterline,
        };
        let nextUserStart = char.contextUserStartMessageId;
        try {
            const range = await loadCharacterContextRange(candidate);
            if (range.userBreakpointExpired) nextUserStart = undefined;
        } catch {
            // 保存其它设置不应被一次范围检查失败阻断；AI 请求时还会再次做同样的安全钳制。
        }
        updateCharacter(char.id, {
            contextLimit: settingsContextLimit,
            contextRangeMode: nextMode,
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextFollowsMemoryPalaceHwm: nextFollowsOneShotWaterline,
            contextUserStartMessageId: nextUserStart,
            hideSystemLogs: settingsHideSysLogs,
            htmlModeCustomPrompt: settingsHtmlModeCustomPrompt,
        } as any);
        setModalType('none');
        addToast('设置已保存', 'success');
    };

    const handleToggleContextSuite = () => {
        const enabled = !contextSuiteAnyEnabled;
        trackEvent('切换智能语境', {
            状态: enabled ? '开' : '关',
            此前: contextSuiteAllEnabled ? '全开' : contextSuiteAnyEnabled ? '部分开' : '全关',
        });
        updateMemoryPalaceConfig({
            featureFlags: {
                ...memoryPalaceConfig.featureFlags,
                recallRouter: enabled,
                interactionAdaptation: enabled,
                deepEngagement: enabled,
            },
        });
        addToast(enabled ? '已开启智能语境' : '已关闭智能语境，回复恢复旧流程', 'success');
    };

    const restoreAdaptiveContext = () => {
        if (!char.autoArchiveEnabled && !char.contextFollowsMemoryPalaceHwm) return;
        trackEvent('恢复自适应上下文', {
            来源: char.autoArchiveEnabled ? '全自动记忆' : '记忆水位线',
        });
        setSettingsContextRangeMode('adaptive');
        setSettingsContextLimit(500);
        updateCharacter(char.id, {
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextRangeMode: 'adaptive',
            contextLimit: 500,
            contextFollowsMemoryPalaceHwm: !!char.contextFollowsMemoryPalaceHwm,
            contextUserStartMessageId: undefined,
        });
        addToast(
            char.autoArchiveEnabled
                ? '已恢复全自动记忆的自适应上下文'
                : '已恢复跟随记忆水位线',
            'success',
        );
    };

    const handleClearHistory = async () => {
        if (!char) return;

        // 记忆宫殿安全检查：如果角色启用了记忆宫殿，检查是否有未被向量化处理的消息
        if (char.memoryPalaceEnabled) {
            const hwm = await getMemoryPalaceHWM(char.id);
            const allMessages = await DB.getMessagesByCharId(char.id, true);
            const textMessages = allMessages.filter(m => m.type === 'text' && m.content?.trim());
            const unprocessedCount = textMessages.filter(m => m.id > hwm).length;

            if (unprocessedCount > 0) {
                // 有未处理的消息，弹出选择对话框
                const processedMsgs = allMessages.filter(m => m.id <= hwm);
                const choice = confirm(
                    `⚠️ 记忆宫殿提醒\n\n` +
                    `当前有 ${unprocessedCount} 条聊天记录尚未被记忆宫殿处理（向量化）。\n` +
                    `直接清空会导致这些记录永久丢失，无法被角色记住。\n\n` +
                    `点击「确定」→ 仅删除已被记忆宫殿处理过的记录（安全）\n` +
                    `点击「取消」→ 取消清空操作\n\n` +
                    `（看不懂在问什么的话就点确定）`
                );

                if (!choice) {
                    return; // 用户取消
                }

                // 安全删除：只删除高水位之前的消息
                if (processedMsgs.length === 0) {
                    addToast('没有已处理的记录可以删除', 'info');
                    return;
                }
                const processedIds = processedMsgs.map(m => m.id);
                await DB.deleteMessages(processedIds);
                discardVoiceForMessages(processedIds);
                // 清历史同样动了云端 fire_pack 的对话快照来源，落库后打脏（下同）。
                markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
                const remaining = allMessages.filter(m => m.id > hwm);
                setMessages(remaining.slice(-200));
                setTotalMsgCount(remaining.length);
                setVisibleCount(LOAD_BATCH_SIZE);
                visibleCountRef.current = LOAD_BATCH_SIZE;
                addToast(`已安全清理 ${processedMsgs.length} 条已处理记录，保留 ${remaining.length} 条未处理记录`, 'success');
                trackEvent('清空聊天记录');
                setModalType('none');
                return;
            }
        }

        // 原有逻辑（无记忆宫殿 or 所有消息已处理）
        if (preserveContext) {
            const allMessages = await DB.getMessagesByCharId(char.id, true);
            const toKeep = allMessages.slice(-10);
            const toKeepIds = new Set(toKeep.map(m => m.id));
            const toDelete = allMessages.filter(m => !toKeepIds.has(m.id));
            if (toDelete.length === 0) {
                addToast('消息太少，无需清理', 'info');
                return;
            }
            const toDeleteIds = toDelete.map(m => m.id);
            await DB.deleteMessages(toDeleteIds);
            discardVoiceForMessages(toDeleteIds);
            setMessages(toKeep);
            setTotalMsgCount(toKeep.length);
            setVisibleCount(LOAD_BATCH_SIZE);
            visibleCountRef.current = LOAD_BATCH_SIZE;
            addToast(`已清理 ${toDelete.length} 条历史，保留最近10条`, 'success');
        } else {
            const allIds = (await DB.getMessagesByCharId(char.id, true)).map(m => m.id);
            await DB.clearMessages(char.id);
            discardVoiceForMessages(allIds);
            setMessages([]);
            setTotalMsgCount(0);
            setVisibleCount(LOAD_BATCH_SIZE);
            visibleCountRef.current = LOAD_BATCH_SIZE;
            addToast('已清空', 'success');
        }
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
        trackEvent('清空聊天记录');
        setModalType('none');
    };

    // 只在打开聊天设置时计算一键存入的待处理量；不开弹窗的用户没有额外 DB 扫描。
    // 这里按按钮的真实语义统计：默认处理到当前末尾，勾选后精确保留最后 10 条原文。
    useEffect(() => {
        if (modalType !== 'chat-settings' || !char?.memoryPalaceEnabled) {
            setVectorizePendingCount(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const { getMemoryPalaceOneShotPendingCount } = await import('../utils/memoryPalace/pipeline');
                const n = await getMemoryPalaceOneShotPendingCount(
                    char.id,
                    retainRecentForVectorize ? 10 : 0,
                );
                if (!cancelled) setVectorizePendingCount(n);
            } catch {
                // 算不出就不显示条数，不影响按钮可用
            }
        })();
        return () => { cancelled = true; };
    }, [modalType, char?.id, char?.memoryPalaceEnabled, retainRecentForVectorize]);

    const handleForceVectorize = async () => {
        if (!char || !char.memoryPalaceEnabled || isVectorizing) return;
        const mpEmb = memoryPalaceConfig?.embedding;
        const mpLLM = memoryPalaceConfig?.lightLLM;
        if (!mpEmb?.baseUrl || !mpEmb?.apiKey || !mpLLM?.baseUrl) {
            addToast('请先在记忆宫殿设置中配置 API', 'error');
            return;
        }

        const retainedCount = retainRecentForVectorize ? 10 : 0;
        const charIdAtStart = char.id;
        setIsVectorizing(true);
        setVectorizeProgress('准备中...');
        addToast(
            retainedCount === 10
                ? '🏰 开始整理聊天，保留最近 10 条原文...'
                : '🏰 开始整理全部聊天记录...',
            'info',
        );

        try {
            const {
                processNewMessages,
                getMemoryPalaceHighWaterMark,
                getMemoryPalaceOneShotPendingCount,
                mergePalaceFragmentsIntoMemories,
            } = await import('../utils/memoryPalace/pipeline');
            const pendingBefore = await getMemoryPalaceOneShotPendingCount(char.id, retainedCount);
            const hwmBefore = getMemoryPalaceHighWaterMark(char.id);
            setVectorizePendingCount(pendingBefore);
            setVectorizeProgress(pendingBefore > 0 ? `待处理 ${pendingBefore} 条` : '正在同步原文边界...');

            const pipelineResult = await processNewMessages(
                [],
                char.id,
                char.name,
                mpEmb,
                mpLLM,
                userProfile?.name || '',
                true,
                setVectorizeProgress,
                {
                    drainBuffer: true,
                    retainRecentMessages: retainedCount,
                    requireAllBatches: true,
                },
            );

            if (charIdAtStart !== activeCharIdRef.current) return;
            if (!pipelineResult) throw new Error('记忆处理没有完成，请检查副 API 与网络');
            if (pipelineResult.skipReason === 'lock') throw new Error('这个角色已有记忆任务在运行，请稍后再试');
            const failedBatches = pipelineResult.batches.filter(batch => !batch.ok);
            if (failedBatches.length > 0) {
                throw new Error(`第 ${failedBatches.map(batch => batch.index).join('、')} 批处理失败，水位线未移动`);
            }

            const rangeMessages = (await DB.getMessagesByCharId(char.id, true))
                .filter(message => !message.groupId)
                .sort((a, b) => a.id - b.id);
            const expectedRetained = Math.min(retainedCount, rangeMessages.length);
            const targetBoundaryIndex = rangeMessages.length - expectedRetained - 1;
            const targetBoundaryId = targetBoundaryIndex >= 0 ? rangeMessages[targetBoundaryIndex].id : 0;
            const hwmAfter = getMemoryPalaceHighWaterMark(char.id);
            if (targetBoundaryId > hwmBefore && hwmAfter < targetBoundaryId) {
                throw new Error('处理未到达预定边界，原文范围保持不变，请重试');
            }

            // 水位线只前进不回退。极少数情况下用户先“保留 0 条”又改选保留 10 条，
            // 这 10 条此前已处理；此时用手动 10 条保证原文仍可读，同时避免重复向量化。
            const waterlineAlreadyAhead = expectedRetained > 0 && hwmBefore > targetBoundaryId;
            const nextMode: ContextRangeMode = waterlineAlreadyAhead ? 'manual' : 'adaptive';
            const nextLimit = expectedRetained > 0 ? 10 : (char.contextLimit || 500);
            const updates: Record<string, any> = {
                contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
                contextRangeMode: nextMode,
                contextLimit: nextLimit,
                contextFollowsMemoryPalaceHwm: !waterlineAlreadyAhead,
                contextUserStartMessageId: undefined,
            };

            if (char.autoArchiveEnabled) {
                updates.hideBeforeMessageId = Math.max(char.hideBeforeMessageId || 0, hwmAfter);
                if (pipelineResult.autoArchive) {
                    updates.memories = mergePalaceFragmentsIntoMemories(
                        char.memories ? [...char.memories] : [],
                        pipelineResult.autoArchive.fragments,
                    );
                }
            }
            updateCharacter(char.id, updates);
            setAllHistoryMessages(rangeMessages);
            setSettingsContextRangeMode(nextMode);
            setSettingsContextLimit(nextLimit);
            setVectorizePendingCount(await getMemoryPalaceOneShotPendingCount(char.id, retainedCount));
            setVectorizeResult({
                processedMessages: pipelineResult.processedMessages || pendingBefore,
                storedMemories: pipelineResult.stored,
                retainedMessages: expectedRetained,
                waterlineAlreadyAhead,
            });
            setModalType('memory-vectorize-result');
            addToast('✅ 记忆处理完成，原文范围已同步', 'success');
        } catch (e: any) {
            addToast(`❌ 向量化失败：${e.message}`, 'error');
            if (charIdAtStart === activeCharIdRef.current) setModalType('chat-settings');
        } finally {
            setIsVectorizing(false);
            setVectorizeProgress('');
        }
    };

    const handleSetHistoryStart = (messageId: number | undefined) => {
        if (!messageId) {
            updateCharacter(char.id, {
                contextUserStartMessageId: undefined,
                contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            });
            setModalType('none');
            addToast('已清除用户断点，原文范围重新跟随拉杆上限', 'success');
            return;
        }

        const range = historyContextRange;
        const maxStart = range?.maxRangeStartMessageId;
        // 不用 Array.prototype.at：tsconfig 的 lib 没开 es2022，tsc 会报错
        const rangeMessages = range?.messages ?? [];
        const latestId = rangeMessages[rangeMessages.length - 1]?.id
            || allHistoryMessages[allHistoryMessages.length - 1]?.id;
        if (maxStart === undefined || latestId === undefined || messageId < maxStart || messageId > latestId) {
            const required = countMessagesFrom(allHistoryMessages, messageId);
            const hint = settingsContextRangeMode === 'adaptive'
                ? `该消息在全自动记忆当前原文范围之外。请先切换为自定义范围，并将拉杆调至至少 ${required} 条。`
                : required > 5000
                    ? '该消息超出上下文拉杆的 5000 条上限，无法设为用户断点。'
                    : `该消息超出当前拉杆范围，请先将上下文调至至少 ${required} 条。`;
            addToast(hint, 'error');
            return;
        }

        updateCharacter(char.id, {
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextRangeMode: (char.autoArchiveEnabled || char.contextFollowsMemoryPalaceHwm)
                ? settingsContextRangeMode
                : 'manual',
            contextLimit: settingsContextLimit,
            contextFollowsMemoryPalaceHwm: settingsContextRangeMode === 'adaptive'
                && !!char.contextFollowsMemoryPalaceHwm,
            contextUserStartMessageId: messageId,
        });
        setModalType('none');
        addToast('已设置 AI 原文读取断点', 'success');
    };

    // 跳转到旧消息：先定位到目标周围的小窗口，再在用户滑到窗口边缘时按批次
    // 向前/向后扩展。这样既不会首次挂载整段超长 DOM，也不会把用户锁死在 51 条里。
    const handleJumpToMessageInChat = async (messageId: number) => {
        if (!activeCharacterId) return;
        setModalType('none');
        const requestCharId = activeCharacterId;
        const LARGE = 999999;
        visibleCountRef.current = LARGE;
        setVisibleCount(LARGE);
        const allMsgs = await DB.getMessagesByCharId(requestCharId, true);
        if (activeCharIdRef.current !== requestCharId) return;
        const browseableMessages = allMsgs.filter(message => isVisibleChatMessage(message, !!char?.hideSystemLogs));
        const targetIndex = browseableMessages.findIndex(message => message.id === messageId);
        if (targetIndex < 0) {
            visibleCountRef.current = LOAD_BATCH_SIZE;
            setVisibleCount(LOAD_BATCH_SIZE);
            addToast('这条记录当前未显示在聊天界面中', 'info');
            await reloadMessages(LOAD_BATCH_SIZE);
            return;
        }

        const nextRange = createChatHistoryWindow(
            browseableMessages.length,
            targetIndex,
            HISTORY_WINDOW_RADIUS,
        );
        setMessages(allMsgs);
        setTotalMsgCount(browseableMessages.length);
        historyWindowTotalRef.current = browseableMessages.length;
        historyWindowRangeRef.current = nextRange;
        historyWindowScrollEnabledRef.current = false;
        setHistoryWindowRange(nextRange);
        setWindowedFocusMsgId(messageId);
        setFlashMsgId(messageId);
        // 等窗口节点挂上 DOM 再定位；定位动画结束后才开放边缘续载，避免滚动动画
        // 自己触发 onScroll，提前改动窗口。
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const el = document.getElementById(`chat-msg-${messageId}`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (historyJumpUnlockTimerRef.current) window.clearTimeout(historyJumpUnlockTimerRef.current);
            historyJumpUnlockTimerRef.current = window.setTimeout(() => {
                historyWindowScrollEnabledRef.current = true;
                historyJumpUnlockTimerRef.current = null;
            }, 450);
        }));
        window.setTimeout(() => setFlashMsgId(null), 2200);
    };

    const refreshContentFavoriteIds = useCallback(async () => {
        const items = await listContentFavorites().catch(() => []);
        setContentFavoriteIds(new Set(items.map(item => item.id)));
    }, []);

    useEffect(() => {
        void refreshContentFavoriteIds();
        window.addEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refreshContentFavoriteIds);
        return () => window.removeEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refreshContentFavoriteIds);
    }, [refreshContentFavoriteIds]);

    const handleToggleContentFavorite = async (msg: Message) => {
        if (!msg?.id) return;
        const favoriteId = contentFavoriteIdForMessage(msg);
        try {
            if (contentFavoriteIds.has(favoriteId)) {
                await removeContentFavoriteById(favoriteId);
                setContentFavoriteIds(previous => {
                    const next = new Set(previous);
                    next.delete(favoriteId);
                    return next;
                });
                addToast(msg.type === 'image' ? '已取消收藏图片' : '已取消收藏聊天消息', 'info');
                return;
            }
            await saveMessageContentFavorite(msg, char?.name || '未知角色');
            setContentFavoriteIds(previous => new Set(previous).add(favoriteId));
            addToast(msg.type === 'image' ? '已收藏图片（仅保存引用）' : '已收藏聊天消息', 'success');
            trackEvent(msg.type === 'image' ? '收藏聊天图片' : '收藏聊天消息');
        } catch (error) {
            console.warn('[Chat] favorite content failed', error);
            addToast('收藏失败，请稍后重试', 'error');
        }
    };

    const handleOpenFavoriteMessage = (charId: string, messageId: number) => {
        setFavoritesOpen(false);
        if (activeCharIdRef.current === charId) {
            void handleJumpToMessageInChat(messageId);
            return;
        }
        pendingFavoriteJumpRef.current = { charId, messageId };
        setActiveCharacterId(charId);
    };

    useEffect(() => {
        const pending = pendingFavoriteJumpRef.current;
        if (!pending || pending.charId !== activeCharacterId) return;
        pendingFavoriteJumpRef.current = null;
        const timer = window.setTimeout(() => void handleJumpToMessageInChat(pending.messageId), 0);
        return () => window.clearTimeout(timer);
    // handleJumpToMessageInChat intentionally uses the freshly rendered character state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCharacterId]);

    const handleBackToCurrent = async () => {
        setWindowedFocusMsgId(null);
        setHistoryWindowRange(null);
        historyWindowRangeRef.current = null;
        historyWindowTotalRef.current = 0;
        historyWindowLoadingRef.current = false;
        historyPrependAnchorRef.current = null;
        historyWindowScrollEnabledRef.current = false;
        if (historyJumpUnlockTimerRef.current) {
            window.clearTimeout(historyJumpUnlockTimerRef.current);
            historyJumpUnlockTimerRef.current = null;
        }
        setFlashMsgId(null);
        visibleCountRef.current = LOAD_BATCH_SIZE;
        setVisibleCount(LOAD_BATCH_SIZE);
        await reloadMessages(LOAD_BATCH_SIZE);
        requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
        });
    };

    const handleFullArchive = async () => {
        if (!apiConfig.apiKey || !char) {
            addToast('请先配置 API Key', 'error');
            return;
        }
        const allMessages = await DB.getMessagesByCharId(char.id, true);
        const msgsByDate: Record<string, Message[]> = {};
        allMessages
        .filter(m => !char.hideBeforeMessageId || m.id >= char.hideBeforeMessageId)
        .forEach(m => {
            const d = new Date(m.timestamp);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (!msgsByDate[dateStr]) msgsByDate[dateStr] = [];
            msgsByDate[dateStr].push(m);
        });

        const datesToProcess = Object.keys(msgsByDate).sort();
        if (datesToProcess.length === 0) {
            addToast('聊天记录为空，无法归档', 'info');
            return;
        }

        setIsSummarizing(true);
        setShowPanel('none');
        setArchiveProgress(`准备归档 ${datesToProcess.length} 天...`);
        addToast(`开始归档 ${datesToProcess.length} 天聊天记录`, 'info');
        trackEvent('归档聊天记录');

        try {
            let processedCount = 0;
            const newMemories: MemoryFragment[] = [];
            const templateObj = archivePrompts.find(p => p.id === selectedPromptId) || DEFAULT_ARCHIVE_PROMPTS[0];
            const template = templateObj.content;

            for (let idx = 0; idx < datesToProcess.length; idx++) {
                const dateStr = datesToProcess[idx];
                setArchiveProgress(`归档中 ${dateStr} (${idx + 1}/${datesToProcess.length})`);
                const dayMsgs = msgsByDate[dateStr];
                const rawLog = dayMsgs
                    .map(m => formatMessageWithTime(m, char.name, userProfile.name, formatTime))
                    .join('\n');
                
                let prompt = template;
                prompt = prompt.replace(/\$\{dateStr\}/g, dateStr);
                prompt = prompt.replace(/\$\{char\.name\}/g, char.name);
                prompt = prompt.replace(/\$\{userProfile\.name\}/g, userProfile.name);
                prompt = prompt.replace(/\$\{rawLog.*?\}/g, rawLog.substring(0, 200000));

                const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                    body: JSON.stringify({
                        model: apiConfig.model,
                        messages: [{ role: "user", content: prompt }],
                        temperature: 0.5,
                        max_tokens: 8000 
                    })
                });

                if (!response.ok) throw new Error(`API Error on ${dateStr}`);
                const data = await safeResponseJson(response);
                let summary = extractContent(data);
                summary = summary.replace(/^["']|["']$/g, '').trim();

                if (summary) {
                    newMemories.push({ id: `mem-${Date.now()}-${idx}`, date: dateStr, summary: summary, mood: 'archive' });
                    processedCount++;
                }
                await new Promise(r => setTimeout(r, 500));
            }

            const total = datesToProcess.length;

            if (processedCount === 0) {
                addToast(`归档失败：${total} 天均未生成摘要（请检查 API/模型）`, 'error');
                setModalType('none');
            } else {
                const finalMemories = [...(char.memories || []), ...newMemories];

                // 关键修复：全量归档成功后把 hideBeforeMessageId 推到"倒数第 reserve 条"的位置。
                // 不推的话下次再点归档，hideBefore 过滤没作用，之前已归档的几天会被重总结一遍，
                // 往 char.memories 里堆重复条目。保留最近 max(100, 15%) 条不隐藏（和 palace
                // auto-archive 的 hot-zone 概念对齐），这样聊天 UI 不会突然空掉。
                //
                // 部分失败时不推 hideBefore —— 那几天的原消息没写进 MemoryFragment，推了
                // 就真的读不到了。用户下次重试归档会把失败的那几天补上。
                let newHideBefore = char.hideBeforeMessageId;
                let reservedCount = 0;
                let hiddenCount = 0;
                if (processedCount === total) {
                    const allArchivedMsgs: Message[] = [];
                    for (const d of datesToProcess) allArchivedMsgs.push(...msgsByDate[d]);
                    allArchivedMsgs.sort((a, b) => a.id - b.id);
                    const RESERVE = Math.max(100, Math.ceil(allArchivedMsgs.length * 0.15));
                    if (allArchivedMsgs.length > RESERVE) {
                        const candidate = allArchivedMsgs[allArchivedMsgs.length - RESERVE].id;
                        // 只前进不后退
                        if (!char.hideBeforeMessageId || candidate > char.hideBeforeMessageId) {
                            newHideBefore = candidate;
                            reservedCount = RESERVE;
                            hiddenCount = allArchivedMsgs.length - RESERVE;
                        }
                    }
                }

                const updates: Partial<typeof char> = { memories: finalMemories };
                if (newHideBefore !== char.hideBeforeMessageId) {
                    (updates as any).hideBeforeMessageId = newHideBefore;
                }
                updateCharacter(char.id, updates as any);

                const hideStr = hiddenCount > 0
                    ? `（已隐藏 ${hiddenCount} 条旧消息，保留最近 ${reservedCount} 条可见）`
                    : '';
                if (processedCount < total) {
                    addToast(`归档完成：${processedCount}/${total} 天成功（部分失败，下次再点会补上）`, 'info');
                } else {
                    addToast(`归档完成：成功归档 ${processedCount} 天${hideStr}`, 'success');
                }
                setModalType('none');
            }

        } catch (e: any) {
            addToast(`归档中断: ${e.message}`, 'error');
        } finally {
            setIsSummarizing(false);
            setArchiveProgress('');
        }
    };

    // --- Message Management ---
    const handleDeleteMessage = async () => {
        if (!selectedMessage) return;
        const deletedId = selectedMessage.id;
        await DB.deleteMessage(deletedId);
        discardVoiceForMessages([deletedId]);
        // 满血主动消息：云端 fire_pack 里带最近对话原文，删了消息不打脏的话，角色到点
        // 还会提起这条已经不存在的消息（快照的消息在 flush 时从 DB 重读，这里只管打脏）。
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
        setMessages(prev => prev.filter(m => m.id !== deletedId));
        setTotalMsgCount(prev => Math.max(0, prev - 1));
        setModalType('none');
        setSelectedMessage(null);
        addToast('消息已删除', 'success');
        trackEvent('删除一条消息');
    };

    const confirmEditMessage = async () => {
        if (!selectedMessage) return;
        const contentChanged = editContent !== selectedMessage.content;
        await DB.updateMessage(selectedMessage.id, editContent);
        // 内容变了旧语音就作废，否则语音条仍会播放编辑前的音频。
        if (contentChanged) discardVoiceForMessages([selectedMessage.id]);
        // 同 handleDeleteMessage：正文改了要让云端 fire_pack 跟上。
        if (contentChanged) markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
        setMessages(prev => prev.map(m => m.id === selectedMessage.id ? { ...m, content: editContent } : m));
        setModalType('none');
        setSelectedMessage(null);
        addToast('消息已修改', 'success');
        trackEvent('编辑一条消息');
    };

    const handleQuickReply = useCallback((message: Message) => {
        setReplyTarget({
            ...message,
            metadata: { ...message.metadata, senderName: message.role === 'user' ? '我' : char.name }
        });
        trackEvent('引用回复一条消息');
    }, [char.name]);

    const handleReplyMessage = () => {
        if (!selectedMessage) return;
        handleQuickReply(selectedMessage);
        setModalType('none');
    };

    const handleCopyMessage = () => {
        if (!selectedMessage) return;
        navigator.clipboard.writeText(selectedMessage.content);
        setModalType('none');
        setSelectedMessage(null);
        addToast('已复制到剪贴板', 'success');
        trackEvent('复制一条消息');
    };

    const handleDeleteEmoji = async () => {
        if (!selectedEmoji) return;
        const emojisToDelete = Array.isArray(selectedEmoji) ? selectedEmoji : [selectedEmoji];
        try {
            await Promise.all(emojisToDelete.map(emoji => DB.deleteEmoji(emoji.name)));
            addToast(Array.isArray(selectedEmoji) ? `已删除 ${selectedEmoji.length} 个表情包` : '表情包已删除', 'success');
        } catch (err) {
            console.error('Failed to delete emojis:', err);
            addToast('删除表情包失败', 'error');
        } finally {
            await loadEmojiData();
            // 放 finally：Promise.all 部分失败时也已经删掉了几个，云端那份照样过期了。
            markEmojiLibraryChanged();
            setModalType('none');
            setSelectedEmoji(null);
        }
    };

    const handleRenameEmoji = async () => {
        if (!selectedEmoji || Array.isArray(selectedEmoji)) return;
        const newName = newEmojiName.trim();
        if (!newName) { addToast('表情包名称不能为空', 'error'); return; }
        if (newName === selectedEmoji.name) { setModalType('none'); setSelectedEmoji(null); return; }
        try {
            await DB.renameEmoji(selectedEmoji.name, newName);
            addToast('表情包名称已修改', 'success');
            await loadEmojiData();
            markEmojiLibraryChanged();
            setModalType('none');
            setSelectedEmoji(null);
            setNewEmojiName('');
        } catch (err: any) {
            console.error('Failed to rename emoji:', err);
            addToast(err?.message || '修改名称失败', 'error');
        }
    };

    // --- Batch Selection ---
    const handleEnterSelectionMode = () => {
        if (selectedMessage) {
            setSelectedMsgIds(new Set([selectedMessage.id]));
            setSelectionMode(true);
            setModalType('none');
            setSelectedMessage(null);
        }
    };

    const toggleMessageSelection = useCallback((id: number) => {
        setSelectedMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleThinkingSelection = useCallback((id: number) => {
        setSelectedThinkingMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    // Memoized callbacks for MessageItem to avoid busting React.memo
    const handleMessageLongPress = useCallback((msg: Message) => {
        setSelectedMessage(msg);
        setModalType('message-options');
    }, []);

    const handleBatchDelete = async () => {
        const msgIdsToDelete = new Set<number>(selectedMsgIds);
        // 思维链单独勾选、但宿主消息没选 -> 只清 metadata.thinkingChain，保留消息
        const thinkingIdsToClear = new Set<number>();
        selectedThinkingMsgIds.forEach(id => {
            if (!msgIdsToDelete.has(id)) thinkingIdsToClear.add(id);
        });
        if (msgIdsToDelete.size === 0 && thinkingIdsToClear.size === 0) return;

        // 删消息时，如果它身上的思维链没被勾选，就尝试迁移到同一轮里下一条 assistant 消息上，
        // 让"只想删第一条输出，但想留思维链"成立
        const sorted = [...messages].sort((a, b) => a.id - b.id);
        const idxById = new Map<number, number>();
        sorted.forEach((m, i) => idxById.set(m.id, i));
        const migrations: { targetId: number; chain: string }[] = [];
        msgIdsToDelete.forEach(id => {
            const msg = messages.find(x => x.id === id);
            const chain = msg?.metadata?.thinkingChain;
            if (!msg || !chain) return;
            if (selectedThinkingMsgIds.has(id)) return; // 用户主动连思维链一起删
            const startIdx = idxById.get(id);
            if (startIdx == null) return;
            for (let i = startIdx + 1; i < sorted.length; i++) {
                const next = sorted[i];
                if (next.role !== 'assistant') break; // 出了这一轮，没法挂靠了
                if (msgIdsToDelete.has(next.id)) continue;
                migrations.push({ targetId: next.id, chain: String(chain) });
                break;
            }
        });

        for (const mig of migrations) {
            await DB.updateMessageMetadata(mig.targetId, (prev) => ({ ...(prev || {}), thinkingChain: mig.chain }));
        }
        for (const id of thinkingIdsToClear) {
            await DB.updateMessageMetadata(id, (prev) => {
                if (!prev || !('thinkingChain' in prev)) return prev;
                const { thinkingChain, ...rest } = prev;
                return rest;
            });
        }
        const ids = Array.from(msgIdsToDelete);
        if (ids.length > 0) {
            await DB.deleteMessages(ids);
            discardVoiceForMessages(ids);
        }

        const migMap = new Map(migrations.map(m => [m.targetId, m.chain]));
        setMessages(prev => prev
            .filter(m => !msgIdsToDelete.has(m.id))
            .map(m => {
                if (migMap.has(m.id)) {
                    return { ...m, metadata: { ...(m.metadata || {}), thinkingChain: migMap.get(m.id) } };
                }
                if (thinkingIdsToClear.has(m.id) && m.metadata?.thinkingChain) {
                    const { thinkingChain, ...rest } = m.metadata;
                    return { ...m, metadata: rest };
                }
                return m;
            })
        );
        setTotalMsgCount(prev => Math.max(0, prev - msgIdsToDelete.size));

        const parts: string[] = [];
        if (msgIdsToDelete.size > 0) parts.push(`已删除 ${msgIdsToDelete.size} 条消息`);
        if (thinkingIdsToClear.size > 0) parts.push(`已清除 ${thinkingIdsToClear.size} 条思维链`);
        addToast(parts.join('，'), 'success');

        setSelectionMode(false);
        setSelectedMsgIds(new Set());
        setSelectedThinkingMsgIds(new Set());
    };

    // --- Forward Chat Records ---
    const [showForwardModal, setShowForwardModal] = useState(false);
    const [forwardGroupId, setForwardGroupId] = useState(GROUP_FILTER_ALL); // 转发弹窗的角色分组筛选

    const handleForwardSelected = () => {
        if (selectedMsgIds.size === 0) return;
        setShowForwardModal(true);
    };

    const handleForwardToCharacter = async (targetCharId: string) => {
        if (!char) return;
        const selectedMsgs = messages
            .filter(m => selectedMsgIds.has(m.id))
            .sort((a, b) => a.id - b.id);

        if (selectedMsgs.length === 0) return;

        // Build preview text (first few messages)
        const previewLines = selectedMsgs.slice(0, 4).map(m => {
            const sender = m.role === 'user' ? userProfile.name : char.name;
            const text = m.type === 'text' ? m.content.slice(0, 30) : `[${m.type === 'image' ? '图片' : m.type === 'emoji' ? '表情' : m.type}]`;
            return `${sender}: ${text}`;
        });
        if (selectedMsgs.length > 4) previewLines.push(`... 共 ${selectedMsgs.length} 条消息`);

        const forwardData = {
            fromUserName: userProfile.name,
            fromCharName: char.name,
            count: selectedMsgs.length,
            preview: previewLines,
            messages: selectedMsgs.map(m => ({
                role: m.role,
                type: m.type,
                content: m.content,
                timestamp: m.timestamp || Date.now()
            }))
        };

        // Save forward card to target character's chat
        await DB.saveMessage({
            charId: targetCharId,
            role: 'user',
            type: 'chat_forward' as MessageType,
            content: JSON.stringify(forwardData),
        });

        // Also save a copy in the current chat so the user can see what they forwarded
        const targetChar = characters.find(c => c.id === targetCharId);
        if (char.id !== targetCharId) {
            await DB.saveMessage({
                charId: char.id,
                role: 'system',
                type: 'text' as MessageType,
                content: `[转发了 ${selectedMsgs.length} 条聊天记录给 ${targetChar?.name || ''}]`,
            });
            // Refresh messages to show the forwarding system message
            reloadMessages(visibleCountRef.current);
        }

        addToast(`已转发 ${selectedMsgs.length} 条记录给 ${targetChar?.name || ''}`, 'success');
        setShowForwardModal(false);
        setSelectionMode(false);
        setSelectedMsgIds(new Set());
    };

    const handleOpenCollaborationFile = useCallback(async (msg: Message) => {
        const assetId = String(msg.metadata?.collaborationAssetId || '');
        const fileName = String(msg.metadata?.fileName || '协同文件');
        if (!assetId) {
            addToast('这条文件消息缺少原始文件引用', 'error');
            return;
        }
        const isInstallable = msg.metadata?.collaborationAttachmentKind === 'installable'
            || String(msg.metadata?.mimeType || '').includes('vnd.sullyos.installable');
        if (isInstallable) {
            setCollaborationPreviewAssetId(assetId);
            setCollaborationOpen(true);
            return;
        }
        try {
            const blob = await CollaborationStore.getAsset(assetId);
            if (!blob) {
                addToast('原始文件已不存在，无法打开', 'error');
                return;
            }
            const result = await shareOrDownloadBlob({
                blob,
                fileName,
                shareTitle: `${char?.name || '角色'}发来的文件`,
                preferDownloadOnWeb: true,
            });
            if (result === 'cancelled') return;
            addToast(result === 'shared' ? '已打开系统保存/分享' : '文件已开始下载', 'success');
        } catch (error: any) {
            addToast(error?.message || '文件打开失败', 'error');
        }
    }, [addToast, char?.name]);

    const handleCollaborationPreviewHandled = useCallback(() => {
        setCollaborationPreviewAssetId(null);
    }, []);

    // 协同工作是独立 sidecar：只有用户点「发送给 ChatApp」时才通过这个窄桥写入主消息表。
    // 其它协同会话、提示词、API 与文件都留在独立数据库，不进入主聊天 pipeline。
    const handleCollaborationTransfer = useCallback(async (
        sessionTitle: string,
        transferredMessages: CollaborationTransferMessage[],
    ) => {
        if (!char || transferredMessages.length === 0) return;
        const preview = transferredMessages.slice(0, 4).map(message => {
            const sender = message.role === 'user' ? userProfile.name : char.name;
            return `${sender}: ${message.content.replace(/\s+/g, ' ').slice(0, 36)}`;
        });
        if (transferredMessages.length > 4) preview.push(`… 共 ${transferredMessages.length} 条消息`);
        const forwardData = {
            fromUserName: userProfile.name,
            fromCharName: `${char.name} · 协同工作`,
            count: transferredMessages.length,
            preview,
            messages: transferredMessages,
            collaborationTitle: sessionTitle,
        };
        await DB.saveMessage({
            charId: char.id,
            role: 'user',
            type: 'chat_forward' as MessageType,
            content: JSON.stringify(forwardData),
            metadata: {
                source: 'collaboration_transfer',
                collaborationTitle: sessionTitle,
            },
        });
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
        await reloadMessages(visibleCountRef.current);
    }, [char, userProfile, groups, realtimeConfig, reloadMessages]);

    const handleCollaborationNotify = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
        addToast(message, type);
    }, [addToast]);

    const handleCollaborationArchiveToMemory = useCallback(async (
        summary: string,
        occurredAt: number,
        sourceId: string,
    ): Promise<string> => {
        if (!char) throw new Error('当前角色不存在');
        const occurred = new Date(occurredAt);
        const date = `${occurred.getFullYear()}-${String(occurred.getMonth() + 1).padStart(2, '0')}-${String(occurred.getDate()).padStart(2, '0')}`;
        const fragmentId = `collab_archive_${sourceId}`;

        if (char.memoryPalaceEnabled) {
            const embedding = memoryPalaceConfig.embedding;
            const lightLLM = memoryPalaceConfig.lightLLM;
            if (!embedding?.baseUrl || !embedding?.apiKey || !embedding?.model || !lightLLM?.baseUrl || !lightLLM?.model) {
                throw new Error('角色已开启记忆宫殿，但宫殿的向量 API 或副 LLM 还没有配置完整');
            }
            const { importExternalMemoryText, mergePalaceFragmentsIntoMemories } = await import('../utils/memoryPalace/pipeline');
            const imported = await importExternalMemoryText(
                summary,
                char.id,
                char.name,
                embedding,
                lightLLM,
                userProfile.name,
            );
            if (imported.error && imported.error !== 'no_memories') {
                throw new Error(`记忆宫殿没有存好：${imported.error}`);
            }
            if (imported.stored === 0 && imported.skipped === 0) {
                throw new Error('记忆宫殿没有提取出可保存的经历');
            }
            const palaceFragment: { id: string; date: string; summary: string; mood: string } = {
                id: fragmentId,
                date,
                summary: `- ${summary}`,
                mood: 'palace',
            };
            await updateCharacter(char.id, current => ({
                memories: (current.memories || []).some(memory => memory.id === fragmentId)
                    ? current.memories
                    : mergePalaceFragmentsIntoMemories(current.memories || [], [palaceFragment]),
            }));
            return `已把这次协作的一条总结同时存入 ${char.name} 的记忆宫殿和神经链接`;
        }

        const archiveFragment: MemoryFragment = {
            id: fragmentId,
            date,
            summary,
            mood: 'collaboration',
        };
        await updateCharacter(char.id, current => ({
            memories: (current.memories || []).some(memory => memory.id === fragmentId)
                ? current.memories
                : [...(current.memories || []), archiveFragment],
        }));
        return `已把这次协作的一条总结存入 ${char.name} 的神经链接`;
    }, [char, memoryPalaceConfig.embedding, memoryPalaceConfig.lightLLM, updateCharacter, userProfile.name]);

    const handleCollaborationInstall = useCallback(async (
        artifact: CollaborationInstallableArtifact,
        targetCharacterId?: string,
    ): Promise<string> => {
        const errors = validateInstallableArtifact(artifact);
        if (errors.length > 0) throw new Error(errors[0]);

        if (artifact.kind === 'bubble-theme') {
            const nextTheme = installableToChatTheme(artifact);
            await addCustomTheme(nextTheme);
            if (targetCharacterId) await updateCharacter(targetCharacterId, { bubbleStyle: nextTheme.id });
            const target = characters.find(item => item.id === targetCharacterId);
            return target ? `气泡主题已保存，并给 ${target.name} 穿上` : '气泡主题已保存到气泡工坊';
        }

        if (artifact.kind === 'whitebox-css') {
            const css = String(artifact.payload.css || '');
            const stored = await DB.getAssetRaw('chrome_css_presets').catch(() => null);
            const presets = Array.isArray(stored) ? stored.filter(item => item && typeof item === 'object') : [];
            const nextPreset = { name: artifact.title.slice(0, 50), code: css, swatch: '#e2e8f0' };
            await DB.saveAssetRaw('chrome_css_presets', [nextPreset, ...presets.filter((item: any) => item.name !== nextPreset.name)].slice(0, 60));
            if (targetCharacterId) await updateCharacter(targetCharacterId, { chromeCustomCss: css });
            const target = characters.find(item => item.id === targetCharacterId);
            return target ? `白框已存入预设，并应用给 ${target.name}` : '白框已保存到预设';
        }

        if (artifact.kind === 'journal-css') {
            await updateTheme({ journalAppearance: { preset: 'original', customCss: String(artifact.payload.css || '') } });
            return '交换日记美化已保存并启用';
        }

        if (artifact.kind === 'schedule-css') {
            await updateTheme({
                scheduleCardAppearance: {
                    ...(osTheme.scheduleCardAppearance || {}),
                    customCss: String(artifact.payload.css || ''),
                },
            });
            return '日程卡美化已保存并启用';
        }

        if (artifact.kind === 'psyche-css') {
            if (!targetCharacterId) throw new Error('请选择使用心象卡美化的角色');
            await updateCharacter(targetCharacterId, { thinkingChainCustomCss: String(artifact.payload.css || '') });
            const target = characters.find(item => item.id === targetCharacterId);
            return `心象卡美化已应用给 ${target?.name || '所选角色'}`;
        }

        if (artifact.kind === 'appearance-preset') {
            const patch = installableToThemePatch(artifact);
            const presetTheme = { ...osTheme, ...patch };
            await saveAppearancePreset(artifact.title.slice(0, 50), presetTheme);
            await updateTheme(patch);
            return '整套界面已存入外观预设并启用';
        }

        if (artifact.kind === 'character-card') {
            const created = await addCharacter();
            await updateCharacter(created.id, installableToCharacterPatch(artifact));
            return `角色「${String(artifact.payload.name || artifact.title)}」已创建`;
        }

        const books = installableToWorldbooks(artifact);
        for (const book of books) await addWorldbook(book);
        if (targetCharacterId) {
            await updateCharacter(targetCharacterId, current => ({
                mountedWorldbooks: upsertMountedWorldbooks(current.mountedWorldbooks || [], books),
            }));
        }
        const target = characters.find(item => item.id === targetCharacterId);
        return target
            ? `世界书「${String(artifact.payload.category || artifact.title)}」的 ${books.length} 条内容已保存并挂载给 ${target.name}`
            : `世界书已保存到世界书库，共 ${books.length} 条`;
    }, [addCharacter, addCustomTheme, addWorldbook, characters, osTheme, saveAppearancePreset, updateCharacter, updateTheme]);

    // hideBeforeMessageId 不在视觉层过滤：用户依旧能往上翻到旧消息，只是 LLM 拉不到。
    // 真正想从聊天记录里抹掉，应该走"删除"。
    // 旧消息定位模式仍然维护一个有限 DOM 窗口，但窗口会随着上下滚动持续扩展。
    const chatDisplayMessages = useMemo(
        () => messages.filter(message => isVisibleChatMessage(message, !!char?.hideSystemLogs)),
        [messages, char?.id, char?.hideSystemLogs],
    );

    useEffect(() => {
        if (windowedFocusMsgId !== null) historyWindowTotalRef.current = chatDisplayMessages.length;
    }, [chatDisplayMessages.length, windowedFocusMsgId]);

    const displayMessages = useMemo(() => {
        if (windowedFocusMsgId !== null) {
            if (historyWindowRange) {
                return chatDisplayMessages.slice(
                    Math.max(0, historyWindowRange.start),
                    Math.min(chatDisplayMessages.length, historyWindowRange.end),
                );
            }
            const idx = chatDisplayMessages.findIndex(m => m.id === windowedFocusMsgId);
            if (idx >= 0) {
                return chatDisplayMessages.slice(
                    Math.max(0, idx - HISTORY_WINDOW_RADIUS),
                    Math.min(chatDisplayMessages.length, idx + HISTORY_WINDOW_RADIUS + 1),
                );
            }
        }
        return chatDisplayMessages.slice(-visibleCount);
    }, [chatDisplayMessages, visibleCount, windowedFocusMsgId, historyWindowRange]);

    const collapsedCount = Math.max(0, totalMsgCount - displayMessages.length);
    const hasOlderHistoryWindow = windowedFocusMsgId !== null && !!historyWindowRange && historyWindowRange.start > 0;
    const hasNewerHistoryWindow = windowedFocusMsgId !== null && !!historyWindowRange && historyWindowRange.end < chatDisplayMessages.length;

    // ── 新消息进入动画 ──────────────────────────────────────────────
    // 只让「刚追加的最新消息」（自己发的 / AI 回的）整条淡入一次。
    // 进聊天首帧、切角色、翻历史（老消息 id 更小）都不播，避免满屏一起闪。
    const animSeenMaxIdRef = useRef<number | null>(null);
    const [animatingIds, setAnimatingIds] = useState<Set<number>>(() => new Set());
    // 切角色 / 首次进入：清基线，下一轮 detect 只记录不播
    useEffect(() => {
        animSeenMaxIdRef.current = null;
        streamPreviewHandoverIdsRef.current.clear();
        setAnimatingIds(new Set());
    }, [activeCharacterId]);
    // 检测新增：id 超过基线的才淡入；首帧只记基线不播
    useEffect(() => {
        if (displayMessages.length === 0) return;
        let maxId = -Infinity;
        for (const m of displayMessages) if (typeof m.id === 'number' && m.id > maxId) maxId = m.id;
        if (animSeenMaxIdRef.current === null) { animSeenMaxIdRef.current = maxId; return; }
        const baseline = animSeenMaxIdRef.current;
        const fresh = displayMessages
            .filter(m => typeof m.id === 'number' && m.id > baseline && !streamPreviewHandoverIdsRef.current.has(m.id))
            .map(m => m.id);
        if (fresh.length > 0) {
            setAnimatingIds(prev => { const next = new Set(prev); fresh.forEach(id => next.add(id)); return next; });
            animSeenMaxIdRef.current = maxId;
        }
    }, [displayMessages]);

    // 稳定的思维链配置对象：只在角色/样式变化时重建，避免每次渲染新建对象击穿 MessageItem.memo。
    const thinkingChainOptions = useMemo(() => ({
        styleId: (char as any)?.thinkingChainStyle || 'echo',
        customColors: (char as any)?.thinkingChainCustomColors,
        onOpenSettings: () => setShowThinkingChainModal(true),
    }), [(char as any)?.thinkingChainStyle, (char as any)?.thinkingChainCustomColors]);

    // 工具痕迹那行灰字要贴着气泡走，所以把气泡自带的组间距（MessageItem 里那组
    // mb-3 / mb-6 / mb-8）抵掉大半。组内的气泡本来就挨着，不用抵。
    const toolTracePullClass = osTheme.chatMessageSpacing === 'compact' ? '-mt-2'
        : osTheme.chatMessageSpacing === 'spacious' ? '-mt-6' : '-mt-5';

    // Reset active category if it becomes invisible for the current character
    useEffect(() => {
        if (activeCategory !== 'default' && visibleCategories.length > 0 && !visibleCategories.some(c => c.id === activeCategory)) {
            setActiveCategory('default');
        }
    }, [visibleCategories, activeCategory]);

    // Build a set of hidden category IDs for quick lookup
    const hiddenCategoryIds = useMemo(() => {
        const visible = new Set(visibleCategories.map(c => c.id));
        return new Set(categories.filter(c => !visible.has(c.id)).map(c => c.id));
    }, [categories, visibleCategories]);

    // Memoize filtered emojis for ChatInputArea
    const filteredEmojis = useMemo(() => emojis.filter(e => {
        // Exclude emojis from hidden categories
        if (e.categoryId && hiddenCategoryIds.has(e.categoryId)) return false;
        if (activeCategory === 'default') return !e.categoryId || e.categoryId === 'default';
        return e.categoryId === activeCategory;
    }), [emojis, activeCategory, hiddenCategoryIds]);

    // Memoize ChatInputArea callbacks
    const handleSendCallback = useCallback(() => handleSendText(), [char, input, replyTarget]);
    const handleCharSelectCallback = useCallback((id: string) => { setActiveCharacterId(id); setShowPanel('none'); }, []);
    // 角色自定义聊天背景：字段值可能是 blobref 令牌（二进制在 IndexedDB），这里解析成能直接
    // 喂进 CSS url() 的地址；data: / http(s) 之类的非令牌值渲染期原样透传。
    // hook 必须在下面的空态早退之前调用，所以用可选链读 char。
    const resolvedChatBackground = useBlobRefUrl(char?.chatBackground);
    // 兜底：正常情况下 OSContext 启动时一定会保底一个角色，char 不该为空。
    // 但若 init 期间某个 store 读取失败（数据其实还在 IndexedDB 里），characters 可能暂时为空，
    // 此时下面读 char 上的字段会直接抛 "undefined is not an object" 把整个 App 崩到错误页。
    // 这里给个温和空态，避免硬崩，也好让用户能退回桌面/重启恢复。
    if (!char) {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-[#f1f5f9] text-center px-8 gap-3">
                <div className="text-4xl">💤</div>
                <div className="text-slate-600 text-sm font-medium">暂时没有可用的角色</div>
                <div className="text-slate-400 text-xs leading-relaxed">数据可能未加载完成。请退回桌面后重新进入；若仍为空，重启应用即可恢复。</div>
                <button onClick={closeApp} className="mt-2 px-4 py-2 rounded-full bg-slate-800 text-white text-xs">返回桌面</button>
            </div>
        );
    }

    // 动森彩蛋模式（受「聊天联动」开关控制：关掉则聊天保持原样式）
    const acnh = osTheme.skin === 'animalcrossing' && osTheme.acnhChatSync !== false;
    const chatChromeStyle = osTheme.chatChromeStyle || 'soft';
    const chatBackgroundStyle = osTheme.chatBackgroundStyle || 'plain';
    const chatRootClass =
        chatChromeStyle === 'pixel'
            ? 'flex flex-col h-full bg-[#efe1cf] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
            : chatChromeStyle === 'flat'
              ? 'flex flex-col h-full bg-white overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
              : chatChromeStyle === 'floating'
                ? 'flex flex-col h-full bg-[#eef2ff] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
                : 'flex flex-col h-full bg-[#f1f5f9] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500';
    // 令牌还在读盘、或者图已经丢了时 resolvedChatBackground 是 undefined，这一帧按「没设背景」
    // 的样式走，免得渲染出一个 url("undefined")。
    const chatRootStyle: React.CSSProperties = resolvedChatBackground
        ? {
            backgroundImage: `url("${resolvedChatBackground}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
        }
        : chatBackgroundStyle === 'grid'
          ? {
              backgroundColor: chatChromeStyle === 'pixel' ? '#efe1cf' : '#f8fafc',
              backgroundImage:
                  'linear-gradient(rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.14) 1px, transparent 1px)',
              backgroundSize: '20px 20px',
            }
          : chatBackgroundStyle === 'paper'
            ? {
                backgroundColor: chatChromeStyle === 'pixel' ? '#f4e8d9' : '#f9f7f2',
                backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.12) 1px, transparent 0)',
                backgroundSize: '16px 16px',
              }
            : chatBackgroundStyle === 'mesh'
              ? {
                  backgroundColor: '#f8fafc',
                  backgroundImage:
                      'radial-gradient(circle at 15% 20%, rgba(59,130,246,0.18), transparent 28%), radial-gradient(circle at 85% 15%, rgba(244,114,182,0.18), transparent 24%), radial-gradient(circle at 60% 75%, rgba(45,212,191,0.18), transparent 26%)',
                }
              : {
                  backgroundImage: 'none',
                };
    // 动森彩蛋：浅奶油米黄中心（上下绿条由 header/输入栏负责），配色参考 Pocket Camp。
    const acnhRootClass = 'flex flex-col h-full overflow-hidden relative font-sans transition-[background-color] duration-500';
    const acnhRootStyle: React.CSSProperties = {
        backgroundColor: '#F6F0D8',
        backgroundImage: 'none',
    };
    const finalRootClass = acnh ? acnhRootClass : chatRootClass;
    // 动森下强制覆盖角色自定义聊天背景，保证整机一致的彩蛋观感
    // 进入/切换的过场由 CharacterEntryTransition 覆盖层负责，根容器不再自己做淡入。
    const finalRootStyle = acnh ? acnhRootStyle : chatRootStyle;
    // 聊天细节微调（外观 → 聊天细节，全局打底；角色开了「聊天装扮」时逐字段覆盖）：
    // CSS 全默认时为空串不注入；chatModuleAlign 不走 CSS，作为布局属性传给 MessageItem。
    const mergedFineTune = useMemo(() => mergeChatFineTune(osTheme, char?.chatFineTune), [osTheme, char?.chatFineTune]);
    const chatFineTuneCss = useMemo(() => buildChatFineTuneCss(mergedFineTune), [mergedFineTune]);
    const chatAvatarSizeClass = osTheme.chatAvatarSize === 'small' ? 'w-7 h-7' : osTheme.chatAvatarSize === 'large' ? 'w-12 h-12' : 'w-9 h-9';
    const chatAvatarRadiusClass = osTheme.chatAvatarShape === 'square' ? 'rounded-sm' : osTheme.chatAvatarShape === 'rounded' ? 'rounded-xl' : 'rounded-full';
    const chatPendingAvatarClass = `${chatAvatarSizeClass} ${chatAvatarRadiusClass} object-cover`;

    return (
        <div
            className={`sully-chat-root ${finalRootClass}`}
            style={finalRootStyle}
        >
             {/* 聊天细节微调（外观 App 可视化设置生成）：排在用户自定义 CSS 之前——
                 同为 !important 时后写的胜，手写美化代码永远可覆盖可视化设置。 */}
             {chatFineTuneCss && <style>{chatFineTuneCss}</style>}
             {/* 白框自定义 CSS：全局默认在前、角色专属在后（后者叠加覆盖）。作用于 .sully-chat-* 各零件。
                 守护样式统一放在气泡主题 customCss 之后（见下），保证对所有用户 CSS 都能兜底。 */}
             {osTheme.chatChromeCustomCss && <style>{osTheme.chatChromeCustomCss}</style>}
             {char.chromeCustomCss && <style>{char.chromeCustomCss}</style>}
             {scheduleChangeNotice && (
               <ScheduleChangeNotice
                 key={scheduleChangeNotice.eventId}
                 detail={scheduleChangeNotice}
                 onDone={dismissScheduleChangeNotice}
               />
             )}
             {/* 角色「登场」过场：切换/进入时以 ta 的头像氛围铺底登场，再推进穿过进入聊天。key 切换即重放。 */}
             {showEntry && char && (
               <CharacterEntryTransition
                 key={activeCharacterId}
                 name={char.name}
                 avatar={char.avatar}
                 onDone={() => setShowEntry(false)}
               />
             )}

             {activeTheme.customCss && <style>{activeTheme.customCss}</style>}
             {/* 气泡工坊的尾巴频率依赖直接挂在气泡上的稳定类。用户 CSS 即使给
                 ::before/::after 写了 !important，中间气泡仍会按“仅组末/隐藏”设置收起尾巴。 */}
             <style>{`
               .sully-bubble-tail-hidden::before,
               .sully-bubble-tail-hidden::after { content: none !important; display: none !important; }
             `}</style>

             {/* 心象卡片自定义 CSS（per-character）：作用于 .sully-psyche-* 各零件，编辑入口在心象设置弹窗 */}
             {(char as any).thinkingChainCustomCss && <style>{(char as any).thinkingChainCustomCss}</style>}

             {/* 守护样式（注在所有用户 CSS —— 白框全局/角色、气泡主题 customCss、心象卡片 CSS —— 之后）：
                 保证返回键和输入栏永远可见可点。坏 CSS（常随备份/分享导入）把它们隐藏/变透明/
                 pointer-events:none 时，用户会遇到「点输入框没反应、键盘唤不起来」或退不出聊天，
                 且重启、重新导入备份都无解。有了兜底，至少能退出去「外观→聊天界面→还原白框」清掉坏 CSS。
                 不锁位置与配色，正常美化不受影响。 */}
             {(osTheme.chatChromeCustomCss || char.chromeCustomCss || activeTheme.customCss || (char as any).thinkingChainCustomCss) && (
               <style>{`
                 .sully-chat-back{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                 .sully-chat-inputbar{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                 .sully-chat-inputbar textarea,.sully-chat-inputbar button{pointer-events:auto!important;visibility:visible!important;}
               `}</style>
             )}

             {/* 动森彩蛋：作用域 CSS 覆盖气泡——奶油 AI 气泡 + 蜜桃用户气泡，暖棕文字，绕开 MessageItem 复杂逻辑 */}
             {acnh && <style>{`
                .sully-bubble-ai {
                    background: #FBF4DE !important;
                    color: #6b5a3e !important;
                    border: 1.5px solid #efe6c8 !important;
                    border-radius: 24px !important;
                    box-shadow: 0 4px 10px -5px rgba(120,95,45,0.28) !important;
                }
                .sully-bubble-user {
                    background: #F5C896 !important;
                    color: #6b4a2f !important;
                    border: 1.5px solid #eeb87f !important;
                    border-radius: 24px !important;
                    box-shadow: 0 4px 10px -5px rgba(150,100,55,0.32) !important;
                }
                /* 仅动森：聊天正文放大一点 */
                .sully-bubble-ai .text-\\[15px\\], .sully-bubble-user .text-\\[15px\\] {
                    font-size: 16.5px !important;
                    line-height: 1.7 !important;
                }
             `}</style>}

             {/* 记忆整理中 — 顶部浮动胶囊（不阻塞交互，轻量无 backdrop-filter） */}
             {memoryPalaceStatus && (
                 <div
                     className="absolute top-[76px] left-1/2 z-[150] animate-fade-in"
                     style={{
                         transform: 'translateX(-50%)',
                         pointerEvents: 'none',
                         willChange: 'transform, opacity',
                     }}
                 >
                     <div
                         className="flex items-center gap-2.5 pl-2.5 pr-3.5 py-2 max-w-[18rem]"
                         style={{
                             background: 'rgba(255,255,255,0.88)',
                             borderRadius: 999,
                             border: '1px solid rgba(99,102,241,0.18)',
                             boxShadow: '0 6px 18px -6px rgba(15,23,42,0.22)',
                         }}
                     >
                         <span
                             className="shrink-0 inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-200 animate-spin"
                             style={{ borderTopColor: '#6366f1', animationDuration: '0.9s' }}
                         />
                         <span className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                             {char?.name || '角色'}正在沉思
                         </span>
                         <span className="text-[10px] text-slate-400 truncate">{memoryPalaceStatus}</span>
                     </div>
                 </div>
             )}


             {/* 记忆整理结果 — 弹窗（高级感） */}
             {memoryPalaceResult && (
                 <div
                     className="absolute inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
                     style={{
                         pointerEvents: 'all',
                         background: 'rgba(15,23,42,0.55)',
                     }}
                     onClick={() => setMemoryPalaceResult(null)}
                 >
                     <div
                         className="w-full max-w-sm max-h-[82vh] overflow-hidden flex flex-col relative"
                         style={{
                             background: 'linear-gradient(160deg, #ffffff 0%, #f8fafc 100%)',
                             borderRadius: 28,
                             border: '1px solid rgba(148,163,184,0.18)',
                             boxShadow: '0 20px 50px -20px rgba(15,23,42,0.35)',
                         }}
                         onClick={(e) => e.stopPropagation()}
                     >
                         <div
                             className="absolute top-0 left-0 right-0 h-[2px] pointer-events-none"
                             style={{ background: 'linear-gradient(90deg, transparent, #6366f1, #a5b4fc, #6366f1, transparent)' }}
                         />
                         <div className="px-6 pt-7 pb-4 text-center">
                             <div
                                 className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-3"
                                 style={{
                                     background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(129,140,248,0.06))',
                                     border: '1px solid rgba(99,102,241,0.15)',
                                 }}
                             >
                                 <span style={{ fontSize: 26 }}>🗂️</span>
                             </div>
                             <div className="text-[10px] tracking-[0.25em] uppercase font-semibold" style={{ color: '#6366f1' }}>Memory Palace</div>
                             <p className="text-[17px] font-bold mt-1" style={{ color: '#0f172a' }}>记忆整理完成</p>
                             <p className="text-[11px] text-slate-400 mt-1">
                                 新增 {memoryPalaceResult.stored} 条 · 去重跳过 {memoryPalaceResult.skipped} 条
                                 {memoryPalaceResult.batches.length > 1 && ` · ${memoryPalaceResult.batches.length} 批`}
                             </p>
                             {memoryPalaceResult.batches.some(b => !b.ok) && (
                                 <p className="text-[10px] text-red-500 mt-1">
                                     {memoryPalaceResult.batches.filter(b => !b.ok).map(b => `batch ${b.index} 失败`).join(', ')}
                                 </p>
                             )}
                         </div>
                         <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-2 no-scrollbar">
                             {memoryPalaceResult.memories.map((m, i) => {
                                 const roomMeta: Record<string, { label: string; color: string }> = {
                                     living_room: { label: '客厅', color: '#f59e0b' },
                                     bedroom: { label: '卧室', color: '#8b5cf6' },
                                     study: { label: '书房', color: '#0ea5e9' },
                                     user_room: { label: '用户房间', color: '#ec4899' },
                                     self_room: { label: '自我房间', color: '#10b981' },
                                     attic: { label: '阁楼', color: '#6366f1' },
                                     windowsill: { label: '窗台', color: '#14b8a6' },
                                 };
                                 const meta = roomMeta[m.room] || { label: m.room, color: '#64748b' };
                                 const roomLabel = getRoomLabel(m.room as any, userProfile?.name) || meta.label;
                                 return (
                                     <div
                                         key={i}
                                         className="p-3 rounded-2xl"
                                         style={{
                                             background: 'rgba(255,255,255,0.75)',
                                             border: `1px solid ${meta.color}22`,
                                             boxShadow: `0 2px 8px ${meta.color}14, inset 0 1px 0 rgba(255,255,255,0.8)`,
                                         }}
                                     >
                                         <div className="flex items-center gap-2 mb-1.5">
                                             <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                                                 style={{ background: `${meta.color}18`, color: meta.color }}
                                             >
                                                 {roomLabel}
                                             </span>
                                             <span className="text-[10px] text-slate-400">{m.mood}</span>
                                             <span className="text-[10px] font-bold ml-auto" style={{ color: '#f59e0b' }}>{'★'.repeat(Math.min(m.importance, 5))}</span>
                                         </div>
                                         <p className="text-[12px] text-slate-700 leading-relaxed">{m.content}</p>
                                         {m.tags.length > 0 && (
                                             <div className="flex gap-1 mt-2 flex-wrap">
                                                 {m.tags.map((t, j) => (
                                                     <span key={j} className="text-[9px] px-1.5 py-0.5 rounded-full"
                                                         style={{ background: 'rgba(148,163,184,0.15)', color: '#64748b' }}
                                                     >{t}</span>
                                                 ))}
                                             </div>
                                         )}
                                     </div>
                                 );
                             })}
                             {memoryPalaceResult.memories.length === 0 && (
                                 <p className="text-center text-xs text-slate-400 py-4">本次未提取到新记忆</p>
                             )}
                         </div>
                         <div className="px-6 pb-6 pt-2">
                             <button
                                 onClick={() => setMemoryPalaceResult(null)}
                                 className="w-full py-3 text-white text-[13px] font-bold rounded-2xl active:scale-[0.98] transition-transform"
                                 style={{
                                     background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                                     boxShadow: '0 6px 18px -6px rgba(79,70,229,0.5)',
                                 }}
                             >
                                 确认
                             </button>
                         </div>
                     </div>
                 </div>
             )}

             <ChatModals
                modalType={modalType} setModalType={setModalType}
                transferAmt={transferAmt} setTransferAmt={setTransferAmt}
                transferNote={transferNote} setTransferNote={setTransferNote}
                emojiImportText={emojiImportText} setEmojiImportText={setEmojiImportText}
                settingsContextLimit={settingsContextLimit} setSettingsContextLimit={setSettingsContextLimit}
                settingsContextRangeMode={settingsContextRangeMode} setSettingsContextRangeMode={setSettingsContextRangeMode}
                settingsHideSysLogs={settingsHideSysLogs} setSettingsHideSysLogs={setSettingsHideSysLogs}
                contextSuiteAnyEnabled={contextSuiteAnyEnabled}
                contextSuiteAllEnabled={contextSuiteAllEnabled}
                onToggleContextSuite={handleToggleContextSuite}
                preserveContext={preserveContext} setPreserveContext={setPreserveContext}
                editContent={editContent} setEditContent={setEditContent}
                archivePrompts={archivePrompts} selectedPromptId={selectedPromptId} setSelectedPromptId={(id: string) => {
                    setSelectedPromptId(id);
                    // 同步写 localStorage，让 palace extraction 的风格追加能读到最新选择
                    try { localStorage.setItem('chat_active_archive_prompt_id', id); } catch {}
                }}
                editingPrompt={editingPrompt} setEditingPrompt={setEditingPrompt} isSummarizing={isSummarizing} archiveProgress={archiveProgress}
                selectedMessage={selectedMessage} selectedEmoji={selectedEmoji} activeCharacter={char} messages={messages}
                allHistoryMessages={allHistoryMessages}
                contextRangeSnapshot={historyContextRange}
                
                newCategoryName={newCategoryName} setNewCategoryName={setNewCategoryName} onAddCategory={handleAddCategory}
                newEmojiName={newEmojiName} setNewEmojiName={setNewEmojiName} onRenameEmoji={handleRenameEmoji}
                selectedCategory={selectedCategory}

                onTransfer={() => { if(transferAmt) handleSendText(`[转账]`, 'transfer', { amount: transferAmt, note: transferNote.trim() || undefined, status: 'pending' }); setTransferNote(''); setModalType('none'); }}
                onImportEmoji={handleImportEmoji}
                onSaveSettings={saveSettings} onBgUpload={handleBgUpload} onRemoveBg={() => updateCharacter(char.id, { chatBackground: undefined })}
                onClearHistory={handleClearHistory} onArchive={handleFullArchive}
                onCreatePrompt={createNewPrompt} onEditPrompt={editSelectedPrompt} onSavePrompt={handleSavePrompt} onDeletePrompt={handleDeletePrompt}
                onSetHistoryStart={handleSetHistoryStart} onRestoreAdaptiveContext={restoreAdaptiveContext} onJumpToMessageInChat={handleJumpToMessageInChat} onEnterSelectionMode={handleEnterSelectionMode}
                onReplyMessage={handleReplyMessage} onEditMessageStart={() => { if (selectedMessage) { setEditContent(selectedMessage.content); setModalType('edit-message'); } }}
                onConfirmEditMessage={confirmEditMessage} onDeleteMessage={handleDeleteMessage} onCopyMessage={handleCopyMessage}
                messageFavorited={!!(selectedMessage && contentFavoriteIds.has(contentFavoriteIdForMessage(selectedMessage)))}
                onToggleMessageFavorite={selectedMessage ? () => handleToggleContentFavorite(selectedMessage) : undefined}
                onDeleteEmoji={handleDeleteEmoji} onDeleteCategory={handleDeleteCategory}
                allCharacters={characters} onSaveCategoryVisibility={handleSaveCategoryVisibility}
                translationEnabled={translationEnabled}
                onToggleTranslation={() => { const next = !translationEnabled; setTranslationEnabled(next); localStorage.setItem(`chat_translate_enabled_${activeCharacterId}`, JSON.stringify(next)); if (next) { trackEvent('开启聊天翻译', { targetLang: isTranslationLangPreset(translateTargetLang) ? translateTargetLang : 'custom' }); } if (!next) { setShowingTargetIds(new Set()); } }}
                translateSourceLang={translateSourceLang}
                translateTargetLang={translateTargetLang}
                translationExpanded={translationExpanded}
                onToggleTranslationExpanded={() => {
                    const next = !translationExpanded;
                    setTranslationExpanded(next);
                    localStorage.setItem(`chat_translate_expanded_${activeCharacterId}`, JSON.stringify(next));
                    setShowingTargetIds(new Set());
                    trackEvent('切换翻译展开模式', { enabled: next ? 'on' : 'off' });
                }}
                onSetTranslateSourceLang={(lang: string) => { const next = normalizeTranslationLangLabel(lang); if (!next) return; setTranslateSourceLang(next); localStorage.setItem(`chat_translate_source_lang_${activeCharacterId}`, next); setShowingTargetIds(new Set()); }}
                onSetTranslateLang={(lang: string) => { const next = normalizeTranslationLangLabel(lang); if (!next) return; setTranslateTargetLang(next); localStorage.setItem(`chat_translate_lang_${activeCharacterId}`, next); setShowingTargetIds(new Set()); }}
                xhsEnabled={!!char.xhsEnabled}
                onToggleXhs={() => updateCharacter(char.id, { xhsEnabled: !char.xhsEnabled })}
                htmlModeEnabled={!!(char as any).htmlModeEnabled}
                onToggleHtmlMode={() => updateCharacter(char.id, { htmlModeEnabled: !((char as any).htmlModeEnabled) } as any)}
                htmlModeCustomPrompt={settingsHtmlModeCustomPrompt}
                setHtmlModeCustomPrompt={setSettingsHtmlModeCustomPrompt}
                chatVoiceEnabled={!!char.chatVoiceEnabled}
                onToggleChatVoice={() => updateCharacter(char.id, { chatVoiceEnabled: !char.chatVoiceEnabled })}
                chatVoiceAutoPlay={!!char.chatVoiceAutoPlay}
                onToggleChatVoiceAutoPlay={() => updateCharacter(char.id, { chatVoiceAutoPlay: !char.chatVoiceAutoPlay })}
                chatVoiceLang={char.chatVoiceLang || ''}
                onSetChatVoiceLang={(lang: string) => {
                    updateCharacter(char.id, { chatVoiceLang: lang });
                    trackEvent('设置聊天语音语种', { 语种: voiceLanguageAnalyticsValue(lang) });
                }}
                voiceAvailable={characterHasVoice(char, apiConfig)}
                onGenerateVoice={selectedMessage ? () => handleManualTts(selectedMessage) : undefined}
                voiceDownloadable={!!(selectedMessage?.id && voiceDataMap[selectedMessage.id])}
                voiceCollectable={!!(selectedMessage?.id && (voiceDataMap[selectedMessage.id] || parseVoiceOutput(selectedMessage.content || '').hasVoiceTag))}
                onDownloadVoice={selectedMessage ? () => handleDownloadVoice(selectedMessage) : undefined}
                voiceFavorited={!!(selectedMessage?.id && chatFavoriteKeys.has(chatFavoriteSourceKey(selectedMessage)))}
                onToggleVoiceFavorite={selectedMessage ? () => handleToggleVoiceFavorite(selectedMessage) : undefined}
                scheduleData={scheduleData}
                isScheduleGenerating={isScheduleGenerating}
                onScheduleEdit={handleScheduleEdit}
                onScheduleDelete={handleScheduleDelete}
                onScheduleReroll={() => generateDailySchedule(char, true)}
                onScheduleCoverChange={handleScheduleCoverChange}
                onScheduleStyleChange={handleScheduleStyleChange}
                onPlayTheater={handlePlayTheater}
                isScheduleFeatureEnabled={isScheduleFeatureOn(char)}
                onToggleScheduleFeature={handleToggleScheduleFeature}
                isMemoryPalaceEnabled={!!char.memoryPalaceEnabled}
                isVectorizing={isVectorizing}
                vectorizePendingCount={vectorizePendingCount}
                vectorizeProgress={vectorizeProgress}
                retainRecentForVectorize={retainRecentForVectorize}
                setRetainRecentForVectorize={setRetainRecentForVectorize}
                vectorizeResult={vectorizeResult}
                onForceVectorize={handleForceVectorize}
                apiPresets={apiPresets}
                onAddApiPreset={addApiPreset}
                onSaveEmotion={(config) => {
                    // API 同步到所有角色，enabled 仅写到当前角色
                    syncEmotionApiToAllCharacters(config.api);
                    updateCharacter(char.id, {
                        emotionConfig: {
                            enabled: config.enabled,
                            ...(config.api && config.api.baseUrl ? { api: config.api } : {}),
                        },
                    });
                }}
                onClearBuffs={() => {
                    updateCharacter(char.id, { activeBuffs: [], buffInjection: '' });
                    addToast('情绪状态已清除', 'info');
                }}
             />

             {/* 小剧场播放器：窥视某个日程时段的角色行为演出 */}
             {theaterSlotIdx !== null && scheduleData && createPortal(
                <TheaterPlayer
                    character={char}
                    slot={scheduleData.slots[theaterSlotIdx] || null}
                    lines={scheduleData.slots[theaterSlotIdx]?.theater?.lines || null}
                    isGenerating={isTheaterGenerating}
                    onReplay={() => runTheater(theaterSlotIdx, true)}
                    onSendCard={(exposed) => handleSendTheaterCard(theaterSlotIdx, exposed)}
                    onClose={() => setTheaterSlotIdx(null)}
                />,
                document.body,
             )}

             <ChatHeader
                selectionMode={selectionMode}
                selectedCount={selectedMsgIds.size + Array.from(selectedThinkingMsgIds).filter(id => !selectedMsgIds.has(id)).length}
                onCancelSelection={() => { setSelectionMode(false); setSelectedMsgIds(new Set()); setSelectedThinkingMsgIds(new Set()); }}
                activeCharacter={char}
                isTyping={isTyping}
                isSummarizing={isSummarizing}
                isEmotionEvaluating={emotionStatus === 'evaluating'}
                isInstantSending={instantSendingActive}
                isMemoryPalaceProcessing={!!memoryPalaceStatus}
                memoryPalaceStatusText={memoryPalaceStatus}
                lastTokenUsage={lastTokenUsage}
                tokenBreakdown={tokenBreakdown}
                onClose={closeApp}
                onTriggerAI={handleManualTrigger}
                onShowCharsPanel={() => setShowPanel('chars')}
                onDeleteBuff={(buffId) => {
                    const currentBuffs = char.activeBuffs || [];
                    const newBuffs = currentBuffs.filter(b => b.id !== buffId);
                    const newInjection = '';
                    updateCharacter(char.id, { activeBuffs: newBuffs, buffInjection: newInjection });
                    addToast('已删除该情绪状态', 'info');
                }}
                headerStyle={osTheme.chatHeaderStyle}
                avatarShape={osTheme.chatAvatarShape}
                headerAlign={osTheme.chatHeaderAlign}
                headerDensity={osTheme.chatHeaderDensity}
                statusStyle={osTheme.chatStatusStyle}
                chromeStyle={osTheme.chatChromeStyle}
                hideBuffs={osTheme.chatHideHeaderBuffs}
                acnh={acnh}
             />

            {/* 认知消化结果弹窗 — 全屏玻璃拟态 */}
            {lastDigestResult && (() => {
                const r = lastDigestResult;
                const groups: Array<{
                    key: string;
                    label: string;
                    icon: string;
                    accent: string;       // base hue for chip/dot
                    items: Array<{ content: string; sub?: string }>;
                }> = [];
                if (r.resolved.length) groups.push({ key: 'resolved', label: '困惑化解', icon: '🕊️', accent: '#10b981', items: r.resolved.map(e => ({ content: e.content })) });
                if (r.deepened.length) groups.push({ key: 'deepened', label: '创伤加深', icon: '💢', accent: '#f43f5e', items: r.deepened.map(e => ({ content: e.content })) });
                if (r.internalized.length) groups.push({ key: 'internalized', label: '知识内化', icon: '🪞', accent: '#8b5cf6', items: r.internalized.map(e => ({ content: e.content })) });
                if (r.selfInsights.length) groups.push({ key: 'insights', label: '自我领悟', icon: '💡', accent: '#f59e0b', items: r.selfInsights.map(t => ({ content: t })) });
                if (r.selfConfused.length) groups.push({ key: 'confused', label: '新的自我困惑', icon: '🌀', accent: '#6366f1', items: r.selfConfused.map(e => ({ content: e.content })) });
                if (r.synthesizedUser.length) groups.push({ key: 'synth', label: '用户认知整合', icon: '👤', accent: '#0ea5e9', items: r.synthesizedUser.map(e => ({ content: e.content, sub: e.category })) });
                if (r.worries?.length) groups.push({ key: 'worries', label: '回看引发的担忧', icon: '😟', accent: '#f97316', items: r.worries.map(e => ({ content: e.content })) });
                if (r.aspirations?.length) groups.push({ key: 'aspirations', label: '新的期盼', icon: '🌟', accent: '#eab308', items: r.aspirations.map(e => ({ content: e.content })) });
                if (r.distilled?.length) groups.push({ key: 'distilled', label: '沉淀到门牌', icon: '🚪', accent: '#a855f7', items: r.distilled.map(e => ({ content: e.content })) });
                if (r.fulfilled.length) groups.push({ key: 'fulfilled', label: '期盼实现', icon: '✨', accent: '#22c55e', items: r.fulfilled.map(e => ({ content: e.content })) });
                if (r.disappointed.length) groups.push({ key: 'disappointed', label: '期盼落空', icon: '🍂', accent: '#94a3b8', items: r.disappointed.map(e => ({ content: e.content })) });
                if (r.faded.length) groups.push({ key: 'faded', label: '淡忘', icon: '🌫️', accent: '#cbd5e1', items: r.faded.map(e => ({ content: e.content })) });
                if (groups.length === 0) return null;
                return (
                    <div
                        className="absolute inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
                        style={{
                            background: 'radial-gradient(ellipse at top, rgba(16,185,129,0.18), rgba(0,0,0,0.55))',
                            backdropFilter: 'blur(10px)',
                            WebkitBackdropFilter: 'blur(10px)',
                        }}
                        onClick={() => setLastDigestResult(null)}
                    >
                        <div
                            className="w-full max-w-sm max-h-[85vh] overflow-hidden flex flex-col relative"
                            style={{
                                background: 'linear-gradient(160deg, rgba(255,255,255,0.98) 0%, rgba(240,253,250,0.96) 100%)',
                                borderRadius: 28,
                                border: '1px solid rgba(255,255,255,0.7)',
                                boxShadow: '0 30px 80px -20px rgba(16,185,129,0.35), 0 10px 40px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.9)',
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* 顶部光晕条 */}
                            <div
                                className="absolute top-0 left-0 right-0 h-1 pointer-events-none"
                                style={{ background: 'linear-gradient(90deg, transparent, #10b981, #6ee7b7, #10b981, transparent)' }}
                            />
                            {/* 头部 */}
                            <div className="px-6 pt-7 pb-4 text-center">
                                <div
                                    className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-3"
                                    style={{
                                        background: 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(52,211,153,0.08))',
                                        boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.9), 0 4px 16px rgba(16,185,129,0.2)',
                                    }}
                                >
                                    <span style={{ fontSize: 28 }}>🧠</span>
                                </div>
                                <div className="text-[11px] tracking-[0.2em] uppercase font-semibold" style={{ color: '#059669' }}>Cognitive Digest</div>
                                <div className="text-[17px] font-bold mt-1" style={{ color: '#0f172a' }}>{char.name} 完成了一次认知消化</div>
                                <div className="text-[11px] text-slate-400 mt-1">内心整理 · {groups.reduce((s, g) => s + g.items.length, 0)} 项变化</div>
                            </div>

                            {/* 内容列表 */}
                            <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-3 no-scrollbar">
                                {groups.map(g => (
                                    <div key={g.key}
                                        className="rounded-2xl overflow-hidden"
                                        style={{
                                            background: 'rgba(255,255,255,0.7)',
                                            border: `1px solid ${g.accent}22`,
                                            boxShadow: `0 2px 8px ${g.accent}14, inset 0 1px 0 rgba(255,255,255,0.8)`,
                                        }}
                                    >
                                        <div className="px-4 py-2.5 flex items-center gap-2"
                                            style={{ background: `linear-gradient(90deg, ${g.accent}18, transparent)` }}
                                        >
                                            <span style={{ fontSize: 14 }}>{g.icon}</span>
                                            <span className="text-[12px] font-bold" style={{ color: g.accent }}>{g.label}</span>
                                            <span className="text-[10px] font-bold ml-auto px-1.5 py-0.5 rounded-full"
                                                style={{ background: `${g.accent}22`, color: g.accent }}
                                            >{g.items.length}</span>
                                        </div>
                                        <div className="px-4 py-2 space-y-1.5">
                                            {g.items.slice(0, 3).map((it, i) => (
                                                <div key={i} className="text-[12px] leading-relaxed text-slate-700 flex gap-2">
                                                    <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full" style={{ background: g.accent }} />
                                                    <span className="flex-1">
                                                        {it.sub && <span className="text-[10px] font-semibold mr-1.5 px-1.5 py-0.5 rounded" style={{ background: `${g.accent}18`, color: g.accent }}>{it.sub}</span>}
                                                        <span>{it.content.length > 80 ? it.content.slice(0, 80) + '…' : it.content}</span>
                                                    </span>
                                                </div>
                                            ))}
                                            {g.items.length > 3 && (
                                                <div className="text-[10px] text-slate-400 pl-3">还有 {g.items.length - 3} 条…</div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* 确认按钮 */}
                            <div className="px-6 pb-6 pt-2">
                                <button
                                    onClick={() => setLastDigestResult(null)}
                                    className="w-full py-3 text-white text-[13px] font-bold rounded-2xl active:scale-[0.98] transition-transform"
                                    style={{
                                        background: 'linear-gradient(135deg, #10b981, #059669)',
                                        boxShadow: '0 8px 24px -4px rgba(16,185,129,0.45), inset 0 1px 0 rgba(255,255,255,0.25)',
                                    }}
                                >
                                    放入心里
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}

            <div ref={scrollRef} onScroll={handleChatScroll} className="flex-1 overflow-y-auto overflow-x-hidden pt-6 pb-6 no-scrollbar" style={{ backgroundImage: activeTheme.type === 'custom' && activeTheme.user.backgroundImage ? 'none' : undefined }}>
                {windowedFocusMsgId !== null && (
                    <div className="sticky top-0 z-20 flex justify-center pb-2 pointer-events-none">
                        <button onClick={handleBackToCurrent} className="pointer-events-auto px-4 py-2 bg-primary text-white rounded-full text-xs font-bold shadow-lg active:scale-95 transition-transform flex items-center gap-1.5">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5 12 21m0 0-7.5-7.5M12 21V3" /></svg>
                            回到当前聊天
                        </button>
                    </div>
                )}
                {collapsedCount > 0 && windowedFocusMsgId === null && (
                    <div className="flex justify-center mb-6">
                        <button onClick={async () => {
                            const nextVisibleCount = visibleCount + LOAD_BATCH_SIZE;
                            visibleCountRef.current = nextVisibleCount;
                            setVisibleCount(nextVisibleCount);
                            await reloadMessages(nextVisibleCount);
                        }} className="px-4 py-2 bg-white/50 backdrop-blur-sm rounded-full text-xs text-slate-500 shadow-sm border border-white hover:bg-white transition-colors">加载历史消息 ({collapsedCount})</button>
                    </div>
                )}
                {windowedFocusMsgId !== null && (
                    <div className="flex justify-center mb-4 px-4">
                        {hasOlderHistoryWindow ? (
                            <button
                                onClick={() => extendHistoryWindow('older')}
                                className="px-3 py-1.5 bg-white/60 backdrop-blur-sm rounded-full text-[11px] text-slate-500 shadow-sm border border-white hover:bg-white transition-colors"
                            >
                                向上滑继续看更早消息
                            </button>
                        ) : (
                            <span className="text-[11px] text-slate-400">已到最早一条消息</span>
                        )}
                    </div>
                )}

                {displayMessages.map((m, i) => {
                    const prevMessage = i > 0 ? displayMessages[i - 1] : null;
                    const nextMessage = i < displayMessages.length - 1 ? displayMessages[i + 1] : null;
                    const messageGroupGapMs = 30 * 60 * 1000;
                    const breaksWithPrevious =
                        !prevMessage ||
                        prevMessage.role !== m.role ||
                        Math.abs(m.timestamp - prevMessage.timestamp) > messageGroupGapMs;
                    const breaksWithNext =
                        !nextMessage ||
                        nextMessage.role !== m.role ||
                        Math.abs(nextMessage.timestamp - m.timestamp) > messageGroupGapMs;
                    const suppressEntranceAnimation = streamPreviewHandoverIdsRef.current.has(m.id);
                    // 这一轮在云端跑过哪些工具（即时对话才有，worker 挂在最后一条推送上）。
                    // 一条推送拆出的每条气泡都继承了同一份（metadata 是整份往下铺的，见
                    // activeMsgRuntime 的 mcdInheritMeta），所以只在这条推送的最后一条底下画，
                    // 不然一句回复底下能排出三行一模一样的字。
                    // 多选状态下不画：跟旁边那两块浮层一样，让位给选择框。
                    const toolTraceText = selectionMode
                        ? '' : formatAmsgToolTrace((m.metadata as any)?.amsgToolTrace);
                    const pushMessageId = (m.metadata as any)?.activeMsg2?.messageId;
                    const showToolTrace = !!toolTraceText
                        && !(pushMessageId && (nextMessage?.metadata as any)?.activeMsg2?.messageId === pushMessageId);
                    return (
                        <div
                            key={m.id || i}
                            id={`chat-msg-${m.id}`}
                            className={[
                                flashMsgId === m.id ? 'ring-2 ring-yellow-300 bg-yellow-50/40 rounded-2xl mx-2' : '',
                                animatingIds.has(m.id) && !suppressEntranceAnimation ? 'animate-fade-in' : '',
                                'transition-all duration-300',
                            ].filter(Boolean).join(' ')}
                            onAnimationEnd={(e) => {
                                if (e.target !== e.currentTarget) return;
                                if (animatingIds.has(m.id)) setAnimatingIds(prev => { const next = new Set(prev); next.delete(m.id); return next; });
                            }}
                        >
                        <MessageItem
                            msg={m}
                            isFirstInGroup={breaksWithPrevious}
                            isLastInGroup={breaksWithNext}
                            activeTheme={activeTheme}
                            charAvatar={char.avatar}
                            charName={char.name}
                            userAvatar={userProfile.perCharAvatars?.[char.id] || userProfile.avatar}
                            isLatestMessage={!nextMessage}
                            onMediaLoad={handleMessageMediaLoad}
                            moduleAlign={mergedFineTune.chatModuleAlign || 'center'}
                            onLongPress={handleMessageLongPress}
                            onReply={handleQuickReply}
                            selectionMode={selectionMode}
                            isSelected={selectedMsgIds.has(m.id)}
                            onToggleSelect={toggleMessageSelection}
                            isThinkingSelected={selectedThinkingMsgIds.has(m.id)}
                            onToggleThinkingSelect={toggleThinkingSelection}
                            translationEnabled={translationEnabled && m.type === 'text' && m.role === 'assistant'}
                            translationExpanded={translationExpanded}
                            isShowingTarget={showingTargetIds.has(m.id)}
                            onTranslateToggle={handleTranslateToggle}
                            voiceData={voiceDataMap[m.id]}
                            voiceLoading={voiceLoading.has(m.id)}
                            isVoicePlaying={playingMsgId === m.id}
                            onPlayVoice={onPlayVoiceStable}
                            avatarShape={osTheme.chatAvatarShape}
                            avatarSize={osTheme.chatAvatarSize}
                            avatarMode={osTheme.chatAvatarMode}
                            bubbleVariant={osTheme.chatBubbleStyle}
                            messageSpacing={osTheme.chatMessageSpacing}
                            showTimestamp={osTheme.chatShowTimestamp}
                            suppressEntranceAnimation={suppressEntranceAnimation}
                            isPending={false}
                            pendingIndicator={osTheme.chatPendingIndicator !== false}
                            onMcdSendCart={handleMcdSendCart}
                            onMcdCandidate={handleMcdCandidate}
                            onResolveTransfer={handleResolveTransfer}
                            onResolveLifeRecord={handleResolveLifeRecord}
                            onOpenCollaborationFile={handleOpenCollaborationFile}
                            thinkingChainOptions={thinkingChainOptions}
                        />
                        {showToolTrace && (
                            <div className={`px-3 mb-4 ${breaksWithNext ? toolTracePullClass : ''}`}>
                                <div className="ml-12 text-[10px] leading-relaxed text-slate-400">
                                    调用了工具：{toolTraceText}
                                </div>
                            </div>
                        )}
                        </div>
                    );
                })}
                {windowedFocusMsgId !== null && (
                    <div className="flex justify-center mt-2 mb-4 px-4">
                        {hasNewerHistoryWindow ? (
                            <button
                                onClick={() => extendHistoryWindow('newer')}
                                className="px-3 py-1.5 bg-white/60 backdrop-blur-sm rounded-full text-[11px] text-slate-500 shadow-sm border border-white hover:bg-white transition-colors"
                            >
                                向下滑继续看较新消息
                            </button>
                        ) : (
                            <span className="text-[11px] text-slate-400">已到当前最新消息</span>
                        )}
                    </div>
                )}

                {/* 纯前端「发送准备中」三个点: 不走 MessageItem (那条逐条路径实测渲染不出来), 直接挂在
                    消息列表末尾、靠右(用户侧). 跟 header「发送中」同源 instantSendingActive 一起亮灭.
                    原版精致观感 = 小号 (w-1) + 轻脉冲. 但原版用的 Tailwind 自定义类 animate-dot-pulse
                    CDN 没生成 (一换就消失), 原版色 slate-400/70 又太淡看不见. 解法: 自己写 inline @keyframes
                    (不依赖 CDN) 还原脉冲, 用实色 slate-400 (峰值满不透明) 保证看得见, 尺寸回到原版 w-1. */}
                {instantSendingActive && !selectionMode && (
                    <div className="flex justify-end px-3 -mt-1 -mb-4">
                        <style>{`@keyframes chatPendingDot{0%,80%,100%{opacity:.35;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}`}</style>
                        <span className="inline-flex items-center gap-[3px] mr-12 select-none pointer-events-none" role="status" aria-label="发送准备中">
                            <span className="w-1 h-1 rounded-full bg-slate-400" style={{ animation: 'chatPendingDot 1.2s ease-in-out infinite' }} />
                            <span className="w-1 h-1 rounded-full bg-slate-400" style={{ animation: 'chatPendingDot 1.2s ease-in-out infinite', animationDelay: '0.2s' }} />
                            <span className="w-1 h-1 rounded-full bg-slate-400" style={{ animation: 'chatPendingDot 1.2s ease-in-out infinite', animationDelay: '0.4s' }} />
                        </span>
                    </div>
                )}

                {instantToolStatus && !selectionMode && (
                    <div className="flex items-end gap-3 px-3 mb-4 animate-fade-in">
                        <TokenImg value={char.avatar} className={chatPendingAvatarClass} />
                        <div className={`max-w-[78%] px-4 py-3 rounded-2xl shadow-sm border ${
                            instantToolStatus.phase === 'failed'
                                ? 'bg-rose-50 border-rose-100 text-rose-700'
                                : 'bg-white/95 border-white/70 text-slate-600'
                        }`}>
                            <div className="flex items-center gap-2 text-xs font-semibold leading-relaxed">
                                {instantToolStatus.phase === 'failed' ? (
                                    <span className="w-2 h-2 rounded-full bg-rose-400 shrink-0" />
                                ) : instantToolStatus.phase === 'done' ? (
                                    <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                                ) : (
                                    <svg className="animate-spin h-3 w-3 shrink-0 text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                )}
                                <span>{instantToolStatus.text}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* 渠道确实发送 reasoning 增量时，先用正式心象卡实时展示；落库后同帧交给正式消息。 */}
                {streamingThinking && !selectionMode && (
                    <div className="group flex items-end justify-start relative px-3 mb-1.5 animate-fade-in">
                        <div className="relative max-w-[72%] min-w-0 ml-12">
                            <ThinkingChainBlock
                                chain={streamingThinking}
                                styleId={thinkingChainOptions.styleId}
                                customColors={thinkingChainOptions.customColors}
                                onOpenSettings={thinkingChainOptions.onOpenSettings}
                            />
                        </div>
                    </div>
                )}

                {/* 流式预览直接复用正式 MessageItem：气泡变体、主题背景图/装饰、头像框、
                    grouped/every_message、消息间距、时间戳、Markdown 与所有自定义 CSS 天然一致。
                    落库时 useChatAI 会登记接棒 id，正式消息首帧不再重播 fade-in。 */}
                {streamingBubbles.length > 0 && !selectionMode && (
                    <>
                        {streamingBubbles.map((bubble, i) => (
                            <div key={`stream-preview-${i}`} className="transition-all duration-300">
                                <MessageItem
                                    msg={{
                                        id: -(i + 1),
                                        charId: char.id,
                                        role: 'assistant',
                                        type: 'text',
                                        content: bubble,
                                        timestamp: Date.now(),
                                    }}
                                    isFirstInGroup={i === 0}
                                    isLastInGroup={i === streamingBubbles.length - 1}
                                    activeTheme={activeTheme}
                                    charAvatar={char.avatar}
                                    charName={char.name}
                                    userAvatar={userProfile.perCharAvatars?.[char.id] || userProfile.avatar}
                                    onLongPress={() => {}}
                                    onReply={() => {}}
                                    selectionMode={false}
                                    isSelected={false}
                                    onToggleSelect={() => {}}
                                    avatarShape={osTheme.chatAvatarShape}
                                    avatarSize={osTheme.chatAvatarSize}
                                    avatarMode={osTheme.chatAvatarMode}
                                    bubbleVariant={osTheme.chatBubbleStyle}
                                    messageSpacing={osTheme.chatMessageSpacing}
                                    showTimestamp={osTheme.chatShowTimestamp}
                                    thinkingChainOptions={thinkingChainOptions}
                                />
                            </div>
                        ))}
                    </>
                )}
                {/* instantChatPending：这一轮在云端跑，本机可以关页面，指示灯靠落盘记录活着。 */}
                {(isTyping || instantChatPending || recallStatus || searchStatus || diaryStatus || isProactiveComposing) && !selectionMode && (
                    <div className="flex items-end gap-3 px-3 mb-6 animate-fade-in">
                        <TokenImg value={char.avatar} className={chatPendingAvatarClass} />
                        <div className="bg-white px-4 py-3 rounded-2xl shadow-sm">
                            {isProactiveComposing && !isTyping && !recallStatus && !searchStatus && !diaryStatus ? (
                                <div className="flex items-center gap-2 text-xs text-teal-600 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    {char.name} 在给你写消息…
                                </div>
                            ) : searchStatus ? (
                                <div className="flex items-center gap-2 text-xs text-emerald-500 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    🔍 {searchStatus}
                                </div>
                            ) : recallStatus ? (
                                <div className="flex items-center gap-2 text-xs text-indigo-500 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    {recallStatus}
                                </div>
                            ) : diaryStatus ? (
                                <div className="flex items-center gap-2 text-xs text-amber-600 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    📖 {diaryStatus}
                                </div>
                            ) : (
                                <div className="flex gap-1"><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"></div><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce delay-75"></div><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce delay-150"></div></div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <div className="relative z-40">
                {mcdActivated && (
                    <div className="flex items-center justify-between px-4 py-1.5 bg-yellow-50 border-b border-yellow-200 text-xs">
                        <div className="flex items-center gap-1.5 text-yellow-700 font-bold">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse"/>
                            🍔 麦请求进行中
                        </div>
                        <button
                          onClick={() => handleSendText(MCD_DEACTIVATE_TRIGGER, 'text', { mcdDeactivate: true })}
                          className="px-2.5 py-0.5 bg-yellow-200/80 text-yellow-800 rounded-full text-[11px] font-bold active:scale-95"
                        >
                          结束
                        </button>
                    </div>
                )}
                {luckinActivated && (
                    <div className="flex items-center justify-between px-4 py-1.5 bg-[#0B1F3A]/5 border-b border-[#0B1F3A]/15 text-xs">
                        <div className="flex items-center gap-1.5 text-[#0B1F3A] font-bold">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#C6A15B] animate-pulse"/>
                            🦌 瑞一杯进行中
                            {luckinChatRef.current?.cityName && <span className="font-normal text-[#0B1F3A]/60">· {luckinChatRef.current.cityName}</span>}
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => setShowLuckinHelp(true)}
                              title="瑞一杯怎么用"
                              className="w-5 h-5 flex items-center justify-center bg-[#0B1F3A]/10 text-[#0B1F3A] rounded-full text-[11px] font-bold active:scale-95"
                            >
                              ?
                            </button>
                            <button
                              onClick={() => setShowLuckinLoc(true)}
                              className="px-2.5 py-0.5 bg-[#0B1F3A]/10 text-[#0B1F3A] rounded-full text-[11px] font-bold active:scale-95"
                            >
                              📍 改定位
                            </button>
                            <button
                              onClick={deactivateLuckin}
                              className="px-2.5 py-0.5 bg-[#0B1F3A]/10 text-[#0B1F3A] rounded-full text-[11px] font-bold active:scale-95"
                            >
                              结束
                            </button>
                        </div>
                    </div>
                )}
                {replyTarget && (
                    <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                        {/* 引用的是图片 / 表情时这里显示占位符，跟落库的快照同一口径 */}
                        <div className="flex items-center gap-2 truncate"><span className="font-bold text-slate-700">正在回复:</span><span className="truncate max-w-[200px]">{buildReplySnapshotContent(replyTarget)}</span></div>
                        <button onClick={() => setReplyTarget(null)} className="p-1 text-slate-400 hover:text-slate-600">×</button>
                    </div>
                )}

                {/* 开关写着「已开启」、这一轮却在本地生成时，把原因说给用户听 */}
                <InstantChatRouteNotice charId={activeCharacterId} />

                <ChatInputArea
                    input={input} setInput={handleInputChange}
                    isTyping={isTyping} selectionMode={selectionMode}
                    showPanel={showPanel} setShowPanel={setShowPanel}
                    onSend={handleSendCallback}
                    onDeleteSelected={handleBatchDelete}
                    onForwardSelected={handleForwardSelected}
                    selectedCount={selectedMsgIds.size + Array.from(selectedThinkingMsgIds).filter(id => !selectedMsgIds.has(id)).length}
                    emojis={filteredEmojis}
                    characters={characters} activeCharacterId={activeCharacterId}
                    onCharSelect={handleCharSelectCallback}
                    unreadMessages={unreadMessages}
                    customThemes={customThemes} onUpdateTheme={(id) => updateCharacter(char.id, { bubbleStyle: id })}
                    onRemoveTheme={removeCustomTheme} activeThemeId={currentThemeId}
                    onPanelAction={handlePanelAction}
                    onImageSelect={handleImageSelect}
                    isSummarizing={isSummarizing}
                    categories={visibleCategories}
                    activeCategory={activeCategory}
                    onReroll={handleReroll}
                    canReroll={canReroll}
                    isProactiveActive={isProactiveActive}
                    mcdConfigured={mcdConfiguredFlag}
                    mcdActivated={mcdActivated}
                    luckinConfigured={luckinConfiguredFlag}
                    luckinActivated={luckinActivated}
                    htmlModeEnabled={!!(char as any).htmlModeEnabled}
                    showThinkingChain={!!(char as any).showThinkingChain}
                    inputStyle={osTheme.chatInputStyle}
                    sendButtonStyle={osTheme.chatSendButtonStyle}
                    chromeStyle={osTheme.chatChromeStyle}
                    acnh={acnh}
                />
            </div>


            {/* Proactive Settings Modal */}
            {char && (
                <ProactiveSettingsModal
                    isOpen={showProactiveModal}
                    onClose={() => setShowProactiveModal(false)}
                    char={char}
                    isProactiveActive={isProactiveActive}
                    onSave={(config) => {
                        updateCharacter(char.id, { proactiveConfig: config });
                        if (config.enabled) {
                            startProactiveChat(config.intervalMinutes);
                            // 界面只给 7 个档，但这个值是从持久化状态读回来的——导入的备份、
                            // 老版本写进去的都可能是任意整数。收敛到写死的档位，其余归 custom。
                            trackEvent('启动主动消息', {
                                intervalMinutes: presetOrCustom(
                                    String(config.intervalMinutes),
                                    ['30', '60', '120', '240', '480', '720', '1440'],
                                    '没设',
                                ),
                            });
                            addToast(`已启动主动消息，每 ${config.intervalMinutes >= 60 ? formatHours(config.intervalMinutes) + ' 小时' : config.intervalMinutes + ' 分钟'}发送一次`, 'success');
                        } else {
                            stopProactiveChat();
                            addToast('已关闭主动消息', 'info');
                        }
                    }}
                    onStop={() => {
                        stopProactiveChat();
                        updateCharacter(char.id, { proactiveConfig: { ...char.proactiveConfig!, enabled: false } });
                        addToast('已停止主动消息', 'info');
                    }}
                />
            )}

            {/* 主动消息 2.0（云端 worker 定时任务）Settings Modal */}
            {char && (
                <ActiveMsg2SettingsModal
                    isOpen={showActiveMsg2Modal}
                    onClose={() => setShowActiveMsg2Modal(false)}
                    char={char}
                    apiConfig={apiConfig}
                    userProfile={userProfile}
                    groups={groups}
                    realtimeConfig={realtimeConfig}
                    // updater 形态：merge 在 setCharacters 的函数式 updater 里发生，
                    // 拿到的 prev 是最新排队后的状态，不会被面板的渲染时快照盖掉
                    // （角色在聊天里用工具排的任务就是这么丢的）。
                    onSave={(updater) => updateCharacter(char.id, (prev) => ({
                        activeMsg2Config: updater(prev.activeMsg2Config),
                    }))}
                    addToast={addToast}
                />
            )}

            {/* 思考链设置 Modal — 入口：聊天加号面板「展示思考」按钮长按 / 思考链卡片右上齿轮 */}
            {char && (
                <ThinkingChainSettingsModal
                    isOpen={showThinkingChainModal}
                    onClose={() => setShowThinkingChainModal(false)}
                    value={{
                        enabled: !!(char as any).showThinkingChain,
                        styleId: ((char as any).thinkingChainStyle as any) || 'echo',
                        customColors: {
                            bg: (char as any).thinkingChainCustomColors?.bg || '#1f2937',
                            accent: (char as any).thinkingChainCustomColors?.accent || '#fbbf24',
                            text: (char as any).thinkingChainCustomColors?.text || '#f1f5f9',
                        },
                        customPrompt: (char as any).thinkingChainCustomPrompt || '',
                        customCss: (char as any).thinkingChainCustomCss || '',
                    }}
                    onChange={(next) => {
                        const patch: any = {};
                        if (next.enabled !== undefined) patch.showThinkingChain = next.enabled;
                        if (next.styleId !== undefined) patch.thinkingChainStyle = next.styleId;
                        if (next.customColors !== undefined) patch.thinkingChainCustomColors = next.customColors;
                        if (next.customPrompt !== undefined) patch.thinkingChainCustomPrompt = next.customPrompt;
                        if (next.customCss !== undefined) patch.thinkingChainCustomCss = next.customCss;
                        if (Object.keys(patch).length) updateCharacter(char.id, patch as any);
                    }}
                />
            )}

            {/* 角色专属「聊天装扮」悬浮气泡 + 小面板 —— 从加号面板「聊天装扮」进入。
                不是全屏 modal：没有遮罩，聊天内容一直可见、就是实时预览。点圆气泡收起/展开面板
                （收起后能看清整个聊天再继续调），点「完成」气泡消失、调试结束。
                全局打底，开了「为 TA 单独定制」后已改动的字段逐个覆盖全局（写到 char.chatFineTune）。 */}
            {char && fineTuneOpen && (() => {
                const override = char.chatFineTune;
                const customized = override?.enabled === true;
                // 控件展示合并后的生效值：未覆盖的字段显示全局当前值，改哪个才覆盖哪个
                const effective = mergeChatFineTune(osTheme, override);
                return (
                    <>
                        {/* 悬浮圆气泡：挂在右侧中部，点击 = 收起/展开小面板 */}
                        <button
                            onClick={() => setFineTunePanelOpen(v => !v)}
                            className={`fixed right-3 z-[106] flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all active:scale-90 ${fineTunePanelOpen ? 'bg-primary text-white ring-4 ring-primary/20' : 'bg-white/95 text-primary ring-1 ring-primary/30 backdrop-blur'}`}
                            style={{ top: 'calc(var(--safe-top) + 35vh)' }}
                            aria-label={fineTunePanelOpen ? '收起聊天装扮面板' : '展开聊天装扮面板'}
                        >
                            <FadersHorizontal className="h-6 w-6" weight="bold" />
                        </button>
                        {/* 小面板：贴在下方但不遮全屏，上半屏聊天照常可见可滚动 */}
                        {fineTunePanelOpen && (
                            <div
                                className="fixed left-1/2 z-[105] w-[94%] max-w-md -translate-x-1/2 overflow-y-auto rounded-3xl border border-white/60 bg-white/95 p-4 shadow-[0_12px_40px_rgba(15,23,42,0.22)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                                style={{ bottom: 'calc(84px + var(--safe-bottom))', maxHeight: '46vh' }}
                            >
                                <div className="mb-3 flex items-start justify-between gap-2">
                                    <div>
                                        <div className="text-[13px] font-bold text-slate-800">聊天装扮 · {char.name}</div>
                                        <div className="mt-0.5 text-[10px] text-slate-400">改动立刻生效在上方聊天里；点右侧圆气泡可收起面板看效果。</div>
                                    </div>
                                    <button
                                        onClick={() => { setFineTuneOpen(false); setFineTunePanelOpen(false); }}
                                        className="shrink-0 rounded-full bg-primary px-4 py-1.5 text-[11px] font-bold text-white shadow-sm transition-all active:scale-95">
                                        完成
                                    </button>
                                </div>
                                <div className="mb-3 flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2.5">
                                    <div className="min-w-0 pr-3">
                                        <div className="text-[11px] font-bold text-slate-700">{customized ? '为 TA 单独定制中' : '跟随全局设置（默认）'}</div>
                                        <div className="mt-0.5 text-[10px] text-slate-400">
                                            {customized
                                                ? '只有你改过的项目覆盖全局，其余仍跟随「外观 → 聊天界面」。关掉开关回到跟随全局，定制内容保留。'
                                                : '当前用的是「外观 → 聊天界面」的全局设置。打开开关即可为这个角色单独定制。'}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateCharacter(char.id, { chatFineTune: { ...override, enabled: !customized } } as any)}
                                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${customized ? 'bg-primary' : 'bg-slate-300'}`}
                                        aria-pressed={customized}
                                    >
                                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${customized ? 'left-[22px]' : 'left-0.5'}`} />
                                    </button>
                                </div>
                                {customized && (
                                    <>
                                        <ChatFineTunePanel
                                            value={effective}
                                            onChange={(patch) => updateCharacter(char.id, { chatFineTune: { ...override, enabled: true, ...patch } } as any)}
                                        />
                                        <button
                                            onClick={() => { updateCharacter(char.id, { chatFineTune: undefined } as any); addToast('已清除该角色的聊天装扮，回到跟随全局', 'success'); }}
                                            className="mt-3 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-bold text-slate-500 transition-all hover:bg-slate-100 active:scale-[0.99]">
                                            清除定制，回到跟随全局
                                        </button>
                                    </>
                                )}
                                <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
                                    只影响私聊界面，群聊不受影响。手写过「白框」自定义 CSS 的话不用担心：<b>自定义 CSS 优先级更高</b>，永远盖得过这里的设置。
                                </p>
                            </div>
                        )}
                    </>
                );
            })()}

            {/* 角色专属「白框自定义」Modal —— 从加号面板「白框」进入；写到 char.chromeCustomCss，叠加在全局之上 */}
            {char && modalType === 'chrome-css' && (
                <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/5" onClick={() => setModalType('none')}>
                    <div
                        className="w-full max-h-[68vh] overflow-y-auto rounded-t-3xl border-t border-white/60 bg-white/95 p-5 shadow-[0_-12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                        style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="mb-2 flex items-start justify-between">
                            <div>
                                <div className="text-sm font-bold text-slate-800">白框自定义 · {char.name}</div>
                                <div className="mt-0.5 text-[10px] text-slate-400">↑ 上方聊天界面即实时预览；仅对该角色生效，叠加在全局设置之上。</div>
                            </div>
                            <button onClick={() => setModalType('none')} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">{'×'}</button>
                        </div>
                        <ChromeCssEditor value={char.chromeCustomCss || ''} onChange={(css) => updateCharacter(char.id, { chromeCustomCss: css } as any)} />
                    </div>
                    {/* 脱离 CSS 控制的救援键：只在「白框」自定义弹窗开着时出现（平时不显示，不丑）。portal 到 body
                        在聊天 DOM 之外 + id 守护(#sully-safe-reset 特异性高于 *)，连 *{display:none!important} 也盖不掉，
                        保证你刚粘进坏 CSS 当场崩掉时，这个还原键一定点得到。 */}
                    {createPortal(
                        <>
                            <style>{`#sully-safe-reset{position:fixed!important;top:calc(var(--safe-top) + 6px)!important;left:50%!important;transform:translateX(-50%)!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;display:flex!important;z-index:2147483647!important;}`}</style>
                            <button
                                id="sully-safe-reset"
                                onClick={() => { updateCharacter(char.id, { chromeCustomCss: '' } as any); addToast('已还原该角色白框', 'success'); }}
                                style={{
                                    position: 'fixed', top: 'calc(var(--safe-top) + 6px)', left: '50%', transform: 'translateX(-50%)',
                                    zIndex: 2147483647, display: 'flex', alignItems: 'center', gap: '4px',
                                    padding: '5px 12px', borderRadius: '999px',
                                    background: 'rgba(15,23,42,0.62)', color: '#fff', fontSize: '11px', fontWeight: 700,
                                    border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
                                }}
                            >⟲ 还原此角色白框</button>
                        </>,
                        document.body,
                    )}
                </div>
            )}

            {/* 白框「提示音」Modal —— 从加号面板「提示音」进入。默认独立存于 char.chatSound；
                打开「绑定到白框」则改存进 char.chromeCustomCss 的 @sully-sound 指令、随白框分享一起走。 */}
            {char && modalType === 'chrome-sound' && (() => {
                const boundSound = parseWhiteboxSound(char.chromeCustomCss);
                const isBound = !!char.chatSoundBound || !!boundSound;
                const curSound: WhiteboxSound | null = isBound ? boundSound : (char.chatSound || null);
                const changeSound = (s: WhiteboxSound | null) => {
                    if (isBound) {
                        updateCharacter(char.id, { chromeCustomCss: upsertWhiteboxSound(char.chromeCustomCss || '', s), chatSound: undefined } as any);
                    } else {
                        updateCharacter(char.id, { chatSound: s || undefined } as any);
                    }
                };
                const changeBound = (b: boolean) => {
                    if (b) {
                        // 绑定：把当前提示音写进白框 CSS 指令，清掉独立字段。
                        updateCharacter(char.id, { chromeCustomCss: upsertWhiteboxSound(char.chromeCustomCss || '', curSound), chatSound: undefined, chatSoundBound: true } as any);
                    } else {
                        // 解绑：从白框 CSS 指令里取出提示音，落回独立字段。
                        updateCharacter(char.id, { chromeCustomCss: stripWhiteboxSoundDirective(char.chromeCustomCss || ''), chatSound: curSound || undefined, chatSoundBound: false } as any);
                    }
                };
                return (
                    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/5" onClick={() => setModalType('none')}>
                        <div
                            className="w-full max-h-[68vh] overflow-y-auto rounded-t-3xl border-t border-white/60 bg-white/95 p-5 shadow-[0_-12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                            style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="mb-3 flex items-start justify-between">
                                <div>
                                    <div className="text-sm font-bold text-slate-800">提示音 · {char.name}</div>
                                    <div className="mt-0.5 text-[10px] text-slate-400">ta 新发的消息成为最新一条时响一次。默认独立于白框，可选绑定一起分享。</div>
                                </div>
                                <button onClick={() => setModalType('none')} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">{'×'}</button>
                            </div>
                            <WhiteboxSoundEditor
                                sound={curSound}
                                bound={isBound}
                                onChangeSound={changeSound}
                                onChangeBound={changeBound}
                                hint={<>🔔 只在 <b>ta 新发的消息成为最新一条</b> 时响一次。这里是<b>该角色专属</b>；不设则用「外观 → 聊天界面」里的全局默认提示音。</>}
                            />
                        </div>
                    </div>
                );
            })()}

            {/* 情绪设置已嵌入日程 Modal（与日程强制同步开/关），不再单独渲染 */}

            {/* 🍔 麦当劳小程序 - MCP 数据流按钮驱动, 协同聊天走主 pipeline (完整人设/记忆/日程) */}
            {memoryRepairOpen && char && (
                <MemoryRepairPortal
                    char={char}
                    user={userProfile}
                    apiConfig={apiConfig}
                    embeddingConfig={memoryPalaceConfig.embedding}
                    remoteVectorConfig={remoteVectorConfig}
                    sinceTs={memoryRepairRound.sinceTs}
                    userMessage={memoryRepairRound.userMessage}
                    assistantReply={memoryRepairRound.assistantReply}
                    onClose={() => {
                        setMemoryRepairOpen(false);
                        setShowPanel('none');
                    }}
                />
            )}

            {favoritesOpen && (
                <FavoritesPortal
                    onClose={() => setFavoritesOpen(false)}
                    onJumpToMessage={handleOpenFavoriteMessage}
                />
            )}

            {char && (
                <React.Suspense fallback={collaborationOpen ? <div className="absolute inset-0 z-[120] grid place-items-center bg-slate-50 text-xs text-slate-400">正在打开协同工作…</div> : null}>
                    <CollaborationWindow
                        open={collaborationOpen}
                        character={char}
                        user={userProfile}
                        theme={activeTheme}
                        backgroundUrl={resolvedChatBackground}
                        chatApi={apiConfig}
                        apiPresets={apiPresets}
                        availableModels={availableModels}
                        characters={characters}
                        groups={groups}
                        emojis={emojis}
                        emojiCategories={categories}
                        recentChatMessages={messages}
                        realtimeConfig={realtimeConfig}
                        chatCollaborationEnabled={!!char.chatCollaborationEnabled}
                        requestedPreviewAssetId={collaborationPreviewAssetId}
                        onRequestedPreviewHandled={handleCollaborationPreviewHandled}
                        onClose={() => { setCollaborationOpen(false); setCollaborationPreviewAssetId(null); }}
                        onSendToChat={handleCollaborationTransfer}
                        onInstallArtifact={handleCollaborationInstall}
                        onArchiveToMemory={handleCollaborationArchiveToMemory}
                        onToggleChatCollaboration={enabled => updateCharacter(char.id, { chatCollaborationEnabled: enabled })}
                        notify={handleCollaborationNotify}
                    />
                </React.Suspense>
            )}

            <McdMiniApp
                open={mcdAppOpen}
                onClose={() => setMcdAppOpen(false)}
                char={char}
                userProfile={userProfile}
                messages={messages}
                isTyping={isTyping}
                onSendMessage={handleMcdMiniAppSend}
                onStateChange={handleMcdMiniAppStateChange}
                onConfirmOrder={handleMcdAppConfirm}
            />

            {/* 🦌 瑞幸小程序 - 与麦当劳同构 */}
            <LuckinMiniApp
                open={luckinAppOpen}
                onClose={() => setLuckinAppOpen(false)}
                char={char}
                userProfile={userProfile}
                messages={messages}
                isTyping={isTyping}
                onSendMessage={handleLuckinMiniAppSend}
                onStateChange={handleLuckinMiniAppStateChange}
                onConfirmOrder={handleLuckinAppConfirm}
            />

            {/* 🦌 瑞一杯定位选择 */}
            <LuckinLocationModal
                open={showLuckinLoc}
                onClose={() => setShowLuckinLoc(false)}
                onPick={onLuckinLocationPick}
            />

            {/* 🦌 瑞一杯使用说明 (首次自动弹 + banner ? 调出) */}
            <LuckinHelpModal
                open={showLuckinHelp}
                onClose={() => setShowLuckinHelp(false)}
            />


            {/* Forward Modal */}
            <Modal isOpen={showForwardModal} title="转发聊天记录" onClose={() => setShowForwardModal(false)}>
                {(() => {
                    const forwardCandidates = characters.filter(c => c.id !== activeCharacterId);
                    const forwardChars = filterCharactersByGroup(forwardCandidates, characterGroups, forwardGroupId);
                    return (
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                            <p className="text-xs text-slate-400 mb-3">选择要转发给的角色 (已选 {selectedMsgIds.size} 条消息)</p>
                            <CharacterGroupFilterBar characters={forwardCandidates} groups={characterGroups} value={forwardGroupId} onChange={setForwardGroupId} className="mb-2 -mx-1 px-1" />
                            {forwardChars.map(c => (
                                <button
                                    key={c.id}
                                    onClick={() => handleForwardToCharacter(c.id)}
                                    className="w-full flex items-center gap-3 p-3 rounded-2xl bg-slate-50 hover:bg-slate-100 active:scale-[0.98] transition-all border border-slate-100"
                                >
                                    <TokenImg value={c.avatar} className="w-10 h-10 rounded-xl object-cover" />
                                    <div className="flex-1 text-left">
                                        <div className="font-bold text-sm text-slate-700">{c.name}</div>
                                        <div className="text-[10px] text-slate-400 truncate">{c.description}</div>
                                    </div>
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-slate-300"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                                </button>
                            ))}
                            {forwardChars.length === 0 && (
                                <div className="text-center text-xs text-slate-400 py-8">{forwardCandidates.length === 0 ? '没有其他角色可以转发' : '该分组下没有角色'}</div>
                            )}
                        </div>
                    );
                })()}
            </Modal>
        </div>
    );
};

export default Chat;
