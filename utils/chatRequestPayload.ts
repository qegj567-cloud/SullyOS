/**
 * 聊天请求载荷统一构造器
 *
 * 设计目标：让"正常聊天"、"主动消息"、"emotion 副 API 评估"三条路径吃到的
 * 上下文材料完全一致——区别只在末尾各自追加的"现在你要做什么"指令。
 *
 * 三条路径过去各拼一遍 system prompt + 消息历史，导致主动消息缺音乐共听 /
 * HTML 模式 / 双语模式 / 麦当劳小程序等块；emotion eval 也容易跟主路径分叉。
 * 现在统一从这里走，避免再分叉。
 *
 * 顺序严格对齐 useChatAI.ts 的现有实现（line 629–793），保证现有行为字节级
 * 等价。新增 caller（runProactive）只是补齐了过去缺的字段。
 */

import type { CharacterProfile, UserProfile, GroupProfile, Emoji, EmojiCategory, Message, RealtimeConfig, TranslationConfig, VisionApiConfig } from '../types';
import { ChatPrompts, detectChatModeTransition } from './chatPrompts';
import { ContextBuilder } from './context';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { renderLocalContextGuidance } from './memoryPalace/recallRouter';
import { renderInteractionAdaptationGuidance } from './memoryPalace/interactionAdaptation';
import { renderDeepEngagementGuidance } from './memoryPalace/deepEngagement';
import { renderConversationEngagementGuidance } from './memoryPalace/conversationEngagement';
import type { ConversationEngagementAnalysis } from './memoryPalace/conversationEngagement';
import type { DeepEngagementAnalysis } from './memoryPalace/deepEngagement';
import { buildHtmlPrompt } from './htmlPrompt';
import { buildThinkingChainPrompt } from './thinkingChainPrompt';
import { buildMcdMiniAppContextBlock } from './mcdToolBridge';
import type { McdMiniAppSnapshot } from './mcdToolBridge';
import { buildLuckinMiniAppContextBlock, buildLuckinChatSystemBlock } from './luckinToolBridge';
import type { LuckinMiniAppSnapshot, LuckinChatState } from './luckinToolBridge';
import { isMcpChatAvailable } from './mcpClient';
import { buildMcpSystemBlock, MCP_TAIL_REMINDER } from './mcpToolBridge';
import type { MusicCfg, Song, LyricLine, MusicPlaybackSnapshot, RecentTrackChange } from '../context/MusicContext';
import { isPromptBuildSkipped, isSystemMessageMergeEnabled } from './devDebug';
import { mergeSystemMessages } from './systemMessageMerge';
import { injectWorldbookDepthEntries, resolveWorldbookEntries } from './worldbook';
import { normalizeTranslationLangLabel } from './translationLang';
import { cleanApiMessages, flattenImageContentParts } from './promptMessageCleanup';
import { materializeVisionDescriptions } from './visionApi';
import type { RecallEntryPoint, RecallTrace } from './memoryPalace/trace';
import { loadCollaborationFileCabinetBlock } from '../features/collaboration/chatLibrary';
import { getSARModuleRuntimePlan } from './vrWorld/sarModuleRuntime';

export { cleanApiMessages, flattenImageContentParts } from './promptMessageCleanup';

export interface UserListeningContext {
    songName: string;
    artists: string;
    lyricWindow: string[];
    activeIdx: number;
}

export interface BuildChatPayloadInput {
    char: CharacterProfile;
    userProfile: UserProfile;
    groups: GroupProfile[];
    emojis: Emoji[];
    categories: EmojiCategory[];
    /** 给 buildMessageHistory 用的完整历史（≤ contextLimit） */
    historyMsgs: Message[];
    /**
     * 给 buildSystemPrompt + memoryPalace 召回用的"较短近窗"。不传则等于 historyMsgs。
     * useChatAI 主路径里 React state 上限 200 条，DB 历史可能更长——保留这个区分。
     */
    recentMsgsHint?: Message[];
    contextLimit: number;
    /**
     * 额外的记忆召回提示词（拼进向量/BM25 检索的 context query）。
     * 用途：彼方等场景下，把"此刻在场的其他玩家名字 / 房间上下文"塞进召回 query，
     * 让角色能回忆起自己跟对面这些人的关系，而不是只按聊天历史召回。
     */
    recallQueryHint?: string;
    /** 只用于 Trace 和后续功能的作用域判断，不参与当前召回排序。 */
    recallEntryPoint?: RecallEntryPoint;

    // 实时世界 / 角色情绪
    realtimeConfig?: RealtimeConfig;
    /** 上一轮 emotion eval 产出的内心独白 */
    innerState?: string;

    // user 共听上下文（非 React 调用方可传 musicSnapshot 让 helper 自动算）
    userListeningContext?: UserListeningContext | null;
    isListeningTogether?: boolean;
    musicCfg?: MusicCfg;
    /** 备选：传一份原始播放快照，helper 内部按主路径同样的逻辑算 listening 三件套 */
    musicSnapshot?: MusicPlaybackSnapshot | null;
    /** 最近一次一起听途中换歌的记录（React 主路径显式传；snapshot 路径从快照里取） */
    recentTrackChange?: RecentTrackChange | null;

    // 模式开关
    translationConfig?: TranslationConfig | { enabled: boolean; sourceLang: string; targetLang: string };
    htmlMode?: { enabled: boolean; customPrompt?: string };
    thinkingChain?: { enabled: boolean; customPrompt?: string };
    /** 可选识图 API：开启后先把图片持久化转写为 [图片：描述]，主模型只接收文字。 */
    visionApiConfig?: VisionApiConfig;
    mcdMiniSnap?: McdMiniAppSnapshot;
    luckinMiniSnap?: LuckinMiniAppSnapshot;
    /** 瑞幸聊天点单模式 (点"瑞一杯"激活, 角色直接调真实工具) */
    luckinChat?: LuckinChatState;
    /**
     * 把历史里的多模态图片消息（content 数组 + image_url）压平成纯文本占位。
     * 彼方/小小窝等复用聊天历史、但配了独立 API 的场景必须开：目标模型可能不支持
     * 视觉输入（DeepSeek 等对 image_url 直接 400），且这些纯文本情景里 base64 图片
     * 只是把上下文撑爆的噪声（与群聊注入"不要把媒体当文本塞"同一约定）。
     */
    stripImages?: boolean;
    /**
     * 这一轮交给 amsg worker 在 fire 时刻生成（即时对话）。时钟 / 真实世界块 /
     * MCP 说明由 worker 那边独家供给，前端这份就不再烤进去，免得一份 prompt 里
     * 出现两个钟、两份热搜、两套工具名。
     */
    timelyByWorker?: boolean;
}

export interface BuildChatPayloadResult {
    /** 完整 system prompt（含所有可选块） */
    systemPrompt: string;
    /** 已剥离双语标签的历史消息（emotion eval 也吃这份） */
    cleanedApiMessages: Array<{ role: string; content: any }>;
    /** [system, ...cleanedApiMessages, 末尾 bilingual reminder?] —— 主 API 直接发这个 */
    fullMessages: Array<{ role: string; content: any }>;
    /** 本轮记忆召回的脱敏 Trace；Prompt Build 被整体跳过时不存在。 */
    recallTrace?: RecallTrace;
    /** 调试用：bilingual / mcd 是否实际注入 */
    flags: {
        bilingualActive: boolean;
        mcdActive: boolean;
        luckinActive: boolean;
        luckinChatActive: boolean;
        mcpChatActive: boolean;
        htmlActive: boolean;
        thinkingActive: boolean;
        sarModuleActive: boolean;
        promptBuildSkipped: boolean;
    };
}

/**
 * 用 MusicPlaybackSnapshot 算 user 共听上下文 —— 与 useChatAI.ts:636–666 行为一致。
 */
function deriveListeningFromSnapshot(
    snap: MusicPlaybackSnapshot | null | undefined,
    charId: string,
): { userListeningContext: UserListeningContext | null; isListeningTogether: boolean; musicCfg?: MusicCfg } {
    if (!snap) return { userListeningContext: null, isListeningTogether: false };
    const { current, playing, lyric, activeLyricIdx, listeningTogetherWith, cfg } = snap;
    let userListeningContext: UserListeningContext | null = null;
    if (current && playing && lyric.length > 0) {
        const idx = activeLyricIdx;
        if (idx >= 0) {
            const from = Math.max(0, idx - 2);
            const to = Math.min(lyric.length, idx + 2 + 1);
            const window = lyric.slice(from, to).map((l: LyricLine) => l.text);
            const activeIdx = idx - from;
            userListeningContext = {
                songName: current.name,
                artists: current.artists,
                lyricWindow: window,
                activeIdx,
            };
        }
    } else if (current && playing) {
        userListeningContext = {
            songName: current.name,
            artists: current.artists,
            lyricWindow: [],
            activeIdx: -1,
        };
    }
    const isListeningTogether = !!(userListeningContext && listeningTogetherWith.includes(charId));
    return { userListeningContext, isListeningTogether, musicCfg: cfg };
}

/** 换歌记录多久内算"刚刚"——超过就不再向 char 提起（一首歌的量级） */
const TRACK_CHANGE_FRESH_MS = 10 * 60 * 1000;

/**
 * 把原始换歌记录折算成"该 char 这一轮是否需要察觉换歌"。
 * 命中条件：char 换歌那刻在一起听名单里、还没重新加入、且换歌发生在刚才。
 * 导出仅为单测。
 */
export function deriveRecentTrackSwitchForChar(
    record: RecentTrackChange | null | undefined,
    charId: string,
    isListeningTogether: boolean,
): { songName: string; artists: string } | null {
    if (!record || isListeningTogether) return null;
    if (!record.charIds.includes(charId)) return null;
    if (Date.now() - record.at > TRACK_CHANGE_FRESH_MS) return null;
    return { songName: record.previousSong.name, artists: record.previousSong.artists };
}

/**
 * 构造完整 chat 请求载荷。三段式结构（稳定前缀 / 历史 / 易变尾段）：
 *
 *   1. injectMemoryPalace（向量召回挂到 char.memoryPalaceInjection）
 *   2. ChatPrompts.buildSystemPromptParts → { stable, volatileState, recencyTail }
 *   3. stable += 双语指令 / HTML 模式 / 思考链（按角色配置，变化慢）
 *   4. ChatPrompts.buildMessageHistory → apiMessages → 剥离旧双语标签 → cleanedApiMessages
 *   5. volatileTail = volatileState + 麦当劳/瑞幸/瑞一杯实时快照块
 *   6. stable += 通用 MCP 工具块（工具清单持久化，变化慢）
 *   7. volatileTail += recencyTail（总纲+「回到你自己」钢印，永远最后）
 *   8. fullMessages = [stable system, ...cleanedApiMessages, volatileTail system]
 *   9. fullMessages.push（末尾双语 reminder / MCP reminder）
 *
 * 设计动机：稳定前缀不含分钟级时间戳/召回/buff → 中转的 prompt 前缀缓存能跨轮命中
 * （TTFT 直降）；易变状态贴着生成点，时间/情绪拿到最强 recency 注意力。
 *
 * emotion eval 吃 (systemPrompt=stable+volatileTail 拼接, cleanedApiMessages) ——
 * 信息与主 API 完全一致，仅易变段的位置不同（主 API 在历史后，eval 拼在 system 文本里）。
 */
export async function buildChatRequestPayload(input: BuildChatPayloadInput): Promise<BuildChatPayloadResult> {
    const {
        char, userProfile, groups, historyMsgs, contextLimit,
        realtimeConfig, innerState,
        translationConfig, htmlMode, thinkingChain, mcdMiniSnap, luckinMiniSnap, luckinChat,
    } = input;
    // 角色可见性必须在统一载荷层再次收口。UI 聊天、1.0 本地主动消息、2.0 推送、
    // 彼方/小小窝等调用方各自维护筛选很容易漏掉一条路径；一旦把全量表情传进来，
    // 模型既会看到其他角色的专属表情，历史里的同名表情也可能反查到错误 URL。
    // 即使调用方已经过滤过，重复过滤仍是幂等的。
    const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
        input.emojis,
        input.categories,
        char.id,
    );
    const rawRecentMsgsHint = input.recentMsgsHint ?? historyMsgs;
    const useVisionDescriptions = input.visionApiConfig?.enabled === true;
    let historyMsgsForPrompt = historyMsgs;
    let recentMsgsHint = rawRecentMsgsHint;

    if (useVisionDescriptions) {
        // historyMsgs 通常来自 DB、recentMsgsHint 通常来自 React state；按 id 合并后只识别一次，
        // 再把写回 metadata 的新快照映射回两套窗口，避免同一轮的 system/history 各跑一次识图。
        const uniqueMessages = new Map<number, Message>();
        for (const message of rawRecentMsgsHint) uniqueMessages.set(message.id, message);
        for (const message of historyMsgs) uniqueMessages.set(message.id, message);
        const prepared = await materializeVisionDescriptions(
            [...uniqueMessages.values()],
            input.visionApiConfig,
        );
        const preparedById = new Map(prepared.map(message => [message.id, message]));
        historyMsgsForPrompt = historyMsgs.map(message => preparedById.get(message.id) || message);
        recentMsgsHint = rawRecentMsgsHint.map(message => preparedById.get(message.id) || message);
    }

    if (isPromptBuildSkipped()) {
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            historyMsgsForPrompt,
            contextLimit,
            char,
            userProfile,
            emojis,
            undefined,
            { useVisionDescriptions },
        );
        const cleanedApiMessages = cleanApiMessages(input.stripImages ? flattenImageContentParts(apiMessages) : apiMessages);
        console.warn('[DevDebug] Prompt Build skipped: sending chat history without system prompt injection.');
        return {
            systemPrompt: '',
            cleanedApiMessages,
            fullMessages: [...cleanedApiMessages],
            flags: {
                bilingualActive: false,
                mcdActive: false,
                luckinActive: false,
                luckinChatActive: false,
                mcpChatActive: false,
                htmlActive: false,
                thinkingActive: false,
                sarModuleActive: false,
                promptBuildSkipped: true,
            },
        };
    }

    // ── 1. Memory Palace 向量召回 ─────────────────────────
    const recallTrace = await injectMemoryPalace(
        char,
        recentMsgsHint,
        input.recallQueryHint,
        userProfile?.name,
        { entryPoint: input.recallEntryPoint ?? 'chat_payload' },
    );

    // ── 2. 解析音乐共听（如果 caller 没显式给，就从 snapshot 推） ──
    let userListeningContext = input.userListeningContext;
    let isListeningTogether = input.isListeningTogether;
    let musicCfg = input.musicCfg;
    let recentTrackChange = input.recentTrackChange;
    if (userListeningContext === undefined && input.musicSnapshot !== undefined) {
        const derived = deriveListeningFromSnapshot(input.musicSnapshot, char.id);
        userListeningContext = derived.userListeningContext;
        isListeningTogether = derived.isListeningTogether;
        musicCfg = derived.musicCfg ?? musicCfg;
        if (recentTrackChange === undefined) recentTrackChange = input.musicSnapshot?.recentTrackChange ?? null;
    }
    // 换歌察觉：char 换歌那刻在一起听、还没重新加入 → 下一轮回复里注入"歌切了"的提示
    const recentTrackSwitch = deriveRecentTrackSwitchForChar(recentTrackChange, char.id, !!isListeningTogether);

    // ── 3. buildSystemPromptParts 核心（三段式） ──────────
    // stable → 消息数组第一条 system（前缀稳定，吃 prompt cache）；
    // volatileTail → 历史消息之后的 system（时间/召回/buff/日程/音乐等实时状态 + 点单类模式块）；
    // recencyTail（总纲+「回到你自己」钢印）最后拼进 volatileTail 末尾，保证它是模型
    // 开口前读到的最后内容 —— 双语/HTML/思考链等格式块都只能拼在 stable 里、排它前面。
    // UI 为了不把通话/见面/剧情正文画进 ChatApp，会把这些 source 从 React state 过滤掉；
    // 但主 API 的 historyMsgsForPrompt 来自完整 DB，仍然会看到它们。模式切换必须以 API
    // 真正要发送的历史为准，否则模型会收到特殊模式正文，却收不到「切回聊天格式」的提示。
    const returningFromMode = detectChatModeTransition(historyMsgsForPrompt);
    const parts = await ChatPrompts.buildSystemPromptParts(
        char, userProfile, groups, emojis, categories, recentMsgsHint,
        realtimeConfig, innerState || undefined,
        userListeningContext ?? null,
        !!isListeningTogether,
        musicCfg,
        recentTrackSwitch,
        (input.timelyByWorker || returningFromMode) ? {
            timelyByWorker: input.timelyByWorker === true,
            returningFromMode: returningFromMode || undefined,
        } : undefined,
    );
    let systemPrompt = parts.stable;
    let volatileTail = parts.volatileState;
    const sarModulePlan = input.recallEntryPoint === 'chat_app'
        ? getSARModuleRuntimePlan(char, userProfile)
        : undefined;
    const sarModuleBlock = input.recallEntryPoint === 'chat_app'
        ? ContextBuilder.buildSARModuleContext(char, userProfile, 'chat')
        : '';
    const sarEnvelopeActive = sarModulePlan?.requiresEnvelope === true;

    // ── 4. 双语指令注入 ───────────────────────────────────
    const sourceLang = normalizeTranslationLangLabel(translationConfig?.sourceLang);
    const targetLang = normalizeTranslationLangLabel(translationConfig?.targetLang);
    const bilingualActive = !!(translationConfig?.enabled && sourceLang && targetLang);
    if (bilingualActive && translationConfig) {
        systemPrompt += `\n\n[CRITICAL: 双语输出模式 - 必须严格遵守]
你的每句话都必须用以下XML标签格式输出双语内容：
<翻译>
<原文>${sourceLang}内容</原文>
<译文>${targetLang}内容</译文>
</翻译>

规则：
- 每句话单独包裹一个<翻译>标签
- 多句话就输出多个<翻译>标签，一句一个
- ${sarEnvelopeActive
            ? 'SAR 模块生效中：最外层必须是 <SAR_MODULE_OUTPUT>；在 CHAR_TRUE 与 CHAR_SURFACE 字段内部，各自用完整的 <翻译> 标签包裹每句话。除这个 SAR 容器与字段标签外，不写散落文字'
            : '<翻译>标签外不要写任何文字'}
- 表情包命令 [[SEND_EMOJI: ...]] 放在所有<翻译>标签外面
- 引用命令 [[QUOTE: ...]] 也放在所有<翻译>标签外面；引用内容请原样照抄用户说过的原文（不要翻译、不要包<翻译>标签）

示例（${sourceLang}→${targetLang}）：
<翻译>
<原文>こんにちは！</原文>
<译文>你好！</译文>
</翻译>
<翻译>
<原文>今日は何する？</原文>
<译文>今天做什么？</译文>
</翻译>`;
    }

    // ── 5. HTML 卡片模式 ─────────────────────────────────
    const htmlActive = !!htmlMode?.enabled;
    if (htmlActive) {
        systemPrompt += `\n\n${buildHtmlPrompt(htmlMode?.customPrompt)}`;
    }

    // ── 6. 思考链提示词 ───────────────────────────────────
    const thinkingActive = !!thinkingChain?.enabled;
    if (thinkingActive) {
        const userName = (userProfile?.name && userProfile.name.trim()) || '用户';
        systemPrompt += `\n\n${buildThinkingChainPrompt(char.name, userName)}`;
        const extra = (thinkingChain?.customPrompt || '').trim();
        if (extra) {
            systemPrompt += `\n\n## 用户对内心独白的额外要求\n${extra}`;
        }
    }

    // ── 7. 历史消息构造 ───────────────────────────────────
    const { apiMessages } = ChatPrompts.buildMessageHistory(
        historyMsgsForPrompt,
        contextLimit,
        char,
        userProfile,
        emojis,
        undefined,
        { useVisionDescriptions },
    );

    // ── 8. 剥离历史里旧的双语标签（stripImages 时先压平 image_url → 纯文本占位） ──
    const cleanedApiMessages = cleanApiMessages(input.stripImages ? flattenImageContentParts(apiMessages) : apiMessages);
    const resolvedWorldbookEntries = resolveWorldbookEntries(
        char.mountedWorldbooks || [],
        cleanedApiMessages,
        char.name,
        userProfile.name,
    );
    const messagesWithWorldbookDepth = injectWorldbookDepthEntries(
        cleanedApiMessages,
        resolvedWorldbookEntries.filter(entry => entry.position === 4),
    );

    // ── 9. 麦当劳小程序上下文（购物车/菜单实时快照 → 易变尾段） ──
    const mcdActive = !!mcdMiniSnap?.open;
    if (mcdActive) {
        const block = buildMcdMiniAppContextBlock(mcdMiniSnap, userProfile?.name || '用户');
        if (block) {
            volatileTail += block;
        }
    }

    // ── 9b. 瑞幸小程序上下文（同上，易变尾段） ──
    const luckinActive = !!luckinMiniSnap?.open;
    if (luckinActive) {
        const block = buildLuckinMiniAppContextBlock(luckinMiniSnap, userProfile?.name || '用户');
        if (block) {
            volatileTail += block;
        }
    }

    // ── 9c. 瑞幸聊天点单模式 (角色直接调真实工具；含实时定位/会话状态 → 易变尾段) ──
    const luckinChatActive = !!luckinChat?.active;
    if (luckinChatActive) {
        const block = buildLuckinChatSystemBlock(luckinChat, recentMsgsHint, userProfile?.name || '用户');
        if (block) {
            volatileTail += block;
        }
    }

    // ── 9d. 通用 MCP 工具模式 (用户自配的远程 MCP 服务器, 见 docs/mcp-client.md) ──
    // 工具清单来自持久化的发现结果，变化很慢 → 稳定段。
    //
    // 即时对话路径：MCP 说明由 worker 的 buildMcpFireBlock 独家供给（与凭据同源同拍），
    // 前端这份不注入——两份工具说明两套工具名，模型会两种都写一遍。
    // mcpChatActive 的取值不受影响：它还要告诉上层「这一轮算不算 MCP 模式」。
    const mcpChatActive = isMcpChatAvailable(char.id);
    if (mcpChatActive && !input.timelyByWorker) {
        const block = buildMcpSystemBlock(userProfile?.name || '用户', char.id);
        if (block) {
            systemPrompt += block;
        }
    }

    // ── 10. recency 钢印归位 + 组装 fullMessages ─────────
    // 本地语境分析只在 ChatApp 主回复使用：它告诉主模型“这句话此刻在做什么”，
    // 不指定具体记忆答案、不改变角色人格，也不进入其他 App 的专属写作提示。
    if (input.recallEntryPoint === 'chat_app') {
        volatileTail += renderLocalContextGuidance(recallTrace.contextAnalyzer);
        volatileTail += renderInteractionAdaptationGuidance(recallTrace.interactionAdaptation?.analysis);
        const engagementTrace = recallTrace.deepEngagement;
        if (engagementTrace?.engine === 'legacy_depth') {
            volatileTail += renderDeepEngagementGuidance(engagementTrace.analysis as DeepEngagementAnalysis | undefined);
        } else if (engagementTrace?.engine === 'conversation_v2') {
            // M3 核心原则常驻；分析结果只决定是否在后面追加当轮状态策略。
            volatileTail += renderConversationEngagementGuidance(
                engagementTrace.analysis as ConversationEngagementAnalysis | undefined,
            );
        }
        if (char.chatCollaborationEnabled) {
            volatileTail += await loadCollaborationFileCabinetBlock(
                char.id,
                historyMsgsForPrompt,
                userProfile?.name || '用户',
            );
        }
    }

    // 「关于对方的表达」+「回到你自己」必须是易变尾段的最后内容：修复旧版把双语/HTML/
    // 思考链/点单块拼在钢印之后、模型开口前最后读到的是格式说明书的问题。
    volatileTail += parts.recencyTail;
    if (sarModuleBlock) volatileTail += sarModuleBlock;

    // 结构：[稳定 system] + [历史消息] + [易变状态 system] (+ 末尾 reminder)。
    // 稳定前缀不再包含分钟级时间戳等易变内容 → 支持前缀缓存的中转能跨轮命中；
    // 易变状态贴着生成点注入，时间/情绪/日程反而拿到最强 recency 注意力。
    // 注意：instant push 的 worker 端情绪评估把 messages[0] 当 system、messages[1..]
    // 展平为对话历史 —— 易变尾段会以「[系统]: …」行出现在历史末尾，信息不丢。
    const fullMessages: Array<{ role: string; content: any }> = [
        { role: 'system', content: systemPrompt },
        ...messagesWithWorldbookDepth,
        { role: 'system', content: volatileTail },
    ];
    if (bilingualActive) {
        fullMessages.push({
            role: 'system',
            content: sarEnvelopeActive
                ? `[Reminder: 最外层输出 <SAR_MODULE_OUTPUT>；CHAR_TRUE 和 CHAR_SURFACE 内的每个气泡都分别使用完整的 <翻译><原文>...</原文><译文>...</译文></翻译>，原文/译文语义一致，一句一个标签。]`
                : `[Reminder: 每句话必须用 <翻译><原文>...</原文><译文>...</译文></翻译> 标签包裹。一句一个标签。绝对不能省略。]`,
        });
    }
    if (mcpChatActive && !input.timelyByWorker) {
        fullMessages.push({ role: 'system', content: MCP_TAIL_REMINDER });
    }
    if (sarModuleBlock) {
        fullMessages.push({
            role: 'system',
            content: '[SAR MODULE REMINDER: 模块是角色在彼方能感知、能记得的外来装置，不是幕后文风要求；CHAR_TRUE 必须包含角色对异常的当下反应，不能若无其事。生效时最终只输出 <SAR_MODULE_OUTPUT> 容器。聊天的 CHAR_TRUE / CHAR_SURFACE 必须逐气泡对齐；纯括号动作原位逐字复制，禁止删泡、合并或新增气泡。内置翻译要在两字段中分别保留完整翻译标签；语音要保留 <语音>/<字幕> 结构并同步改写口播与字幕；“日文（中文翻译）”一类同泡格式不可把括号译文误判成动作。真实语义写 CHAR_TRUE，临时外显写 CHAR_SURFACE，用户外显写 USER_SURFACE，不得把外显当作内心。]',
        });
    }

    // Dev 开关：多条 system 合并成开头一条，A/B 对照中转适配层对多 system 的计量行为。
    let finalMessages = fullMessages;
    if (isSystemMessageMergeEnabled()) {
        finalMessages = mergeSystemMessages(fullMessages);
        console.warn(`[DevDebug] Merge system messages: ${fullMessages.length} → ${finalMessages.length} messages (system ${fullMessages.length - finalMessages.length + 1} → 1).`);
    }

    return {
        // 返回给情绪评估 / 调试查看器的仍是"完整拼接"——信息与主 API 完全一致，
        // 只是主 API 的实际消息结构把易变尾段放在历史之后（见上）。
        systemPrompt: systemPrompt + volatileTail,
        cleanedApiMessages: messagesWithWorldbookDepth,
        fullMessages: finalMessages,
        recallTrace,
        flags: { bilingualActive, mcdActive, luckinActive, luckinChatActive, mcpChatActive, htmlActive, thinkingActive, sarModuleActive: !!sarModuleBlock, promptBuildSkipped: false },
    };
}
