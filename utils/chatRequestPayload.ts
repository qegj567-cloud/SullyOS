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

import type { CharacterProfile, UserProfile, GroupProfile, Emoji, EmojiCategory, Message, RealtimeConfig, TranslationConfig } from '../types';
import { ChatPrompts } from './chatPrompts';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { buildHtmlPrompt } from './htmlPrompt';
import { buildThinkingChainPrompt } from './thinkingChainPrompt';
import { buildMcdMiniAppContextBlock } from './mcdToolBridge';
import type { McdMiniAppSnapshot } from './mcdToolBridge';
import { buildLuckinMiniAppContextBlock, buildLuckinChatSystemBlock } from './luckinToolBridge';
import type { LuckinMiniAppSnapshot, LuckinChatState } from './luckinToolBridge';
import { buildWereadChatSystemBlock, WEREAD_TAIL_REMINDER } from './wereadToolBridge';
import type { WereadSnapshot, WereadSessionState } from './wereadToolBridge';
import { isMcpChatAvailable } from './mcpClient';
import { buildMcpSystemBlock, MCP_TAIL_REMINDER } from './mcpToolBridge';
import type { MusicCfg, Song, LyricLine, MusicPlaybackSnapshot, RecentTrackChange } from '../context/MusicContext';
import { isPromptBuildSkipped, isSystemMessageMergeEnabled } from './devDebug';
import { mergeSystemMessages } from './systemMessageMerge';
import { injectWorldbookDepthEntries, resolveWorldbookEntries } from './worldbook';
import { normalizeTranslationLangLabel } from './translationLang';

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
    mcdMiniSnap?: McdMiniAppSnapshot;
    luckinMiniSnap?: LuckinMiniAppSnapshot;
    /** 瑞幸聊天点单模式 (点"瑞一杯"激活, 角色直接调真实工具) */
    luckinChat?: LuckinChatState;
    /** 微信读书搭子 (用户发"读书搭子"激活, 或设置里全局开启 + 有有效鉴权) */
    wereadActive?: boolean;
    wereadSnapshot?: WereadSnapshot;
    wereadSessionState?: WereadSessionState;
    /**
     * 把历史里的多模态图片消息（content 数组 + image_url）压平成纯文本占位。
     * 彼方/小小窝等复用聊天历史、但配了独立 API 的场景必须开：目标模型可能不支持
     * 视觉输入（DeepSeek 等对 image_url 直接 400），且这些纯文本情景里 base64 图片
     * 只是把上下文撑爆的噪声（与群聊注入"不要把媒体当文本塞"同一约定）。
     */
    stripImages?: boolean;
}

export interface BuildChatPayloadResult {
    /** 完整 system prompt（含所有可选块） */
    systemPrompt: string;
    /** 已剥离双语标签的历史消息（emotion eval 也吃这份） */
    cleanedApiMessages: Array<{ role: string; content: any }>;
    /** [system, ...cleanedApiMessages, 末尾 bilingual reminder?] —— 主 API 直接发这个 */
    fullMessages: Array<{ role: string; content: any }>;
    /** 调试用：bilingual / mcd 是否实际注入 */
    flags: {
        bilingualActive: boolean;
        mcdActive: boolean;
        luckinActive: boolean;
        luckinChatActive: boolean;
        wereadActive: boolean;
        mcpChatActive: boolean;
        htmlActive: boolean;
        thinkingActive: boolean;
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
 * 剥离历史里旧的双语标签: `%%BILINGUAL%%` 形态整条在标记处截断 (只留原文侧),
 * `<翻译>` XML 形态只留 <原文>。导出仅为单测 — 引用头绝不能混入 %%BILINGUAL%%
 * (见 chatPrompts.buildMessageHistory 的引用摘要清洗), 否则截断会吃掉用户的实际回复。
 */
export function cleanApiMessages(apiMessages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
    return apiMessages.map((msg: any) => {
        if (typeof msg.content !== 'string') return msg;
        let c: string = msg.content;
        if (c.toLowerCase().includes('%%bilingual%%')) {
            const idx = c.toLowerCase().indexOf('%%bilingual%%');
            c = c.substring(0, idx).trim();
        }
        if (c.includes('<翻译>')) {
            c = c.replace(/<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/g, '$1').trim();
        }
        return { ...msg, content: c };
    });
}

/**
 * 把 buildMessageHistory 产出的多模态图片消息压平成纯文本：保留 text 部分
 * （里面已带 `[User sent an image]` 占位与时间戳），丢弃 image_url 部分。
 * 与 buildMessageHistory 的"图片数据已丢失"分支产出完全同形。
 * 导出仅为单测。
 */
export function flattenImageContentParts(apiMessages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
    return apiMessages.map((msg) => {
        if (!Array.isArray(msg.content)) return msg;
        const text = msg.content
            .filter((part: any) => part?.type === 'text')
            .map((part: any) => part.text || '')
            .join('\n')
            .trim();
        return { ...msg, content: text || '[图片]' };
    });
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
        wereadActive: wereadActiveInput, wereadSnapshot, wereadSessionState,
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
    const recentMsgsHint = input.recentMsgsHint ?? historyMsgs;

    if (isPromptBuildSkipped()) {
        const { apiMessages } = ChatPrompts.buildMessageHistory(historyMsgs, contextLimit, char, userProfile, emojis);
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
                wereadActive: false,
                mcpChatActive: false,
                htmlActive: false,
                thinkingActive: false,
                promptBuildSkipped: true,
            },
        };
    }

    // ── 1. Memory Palace 向量召回 ─────────────────────────
    await injectMemoryPalace(char, recentMsgsHint, input.recallQueryHint, userProfile?.name);

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
    const parts = await ChatPrompts.buildSystemPromptParts(
        char, userProfile, groups, emojis, categories, recentMsgsHint,
        realtimeConfig, innerState || undefined,
        userListeningContext ?? null,
        !!isListeningTogether,
        musicCfg,
        recentTrackSwitch,
    );
    let systemPrompt = parts.stable;
    let volatileTail = parts.volatileState;

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
- <翻译>标签外不要写任何文字
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
    const { apiMessages } = ChatPrompts.buildMessageHistory(historyMsgs, contextLimit, char, userProfile, emojis);

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
    const mcpChatActive = isMcpChatAvailable(char.id);
    if (mcpChatActive) {
        const block = buildMcpSystemBlock(userProfile?.name || '用户', char.id);
        if (block) {
            systemPrompt += block;
        }
    }

    // ── 9e. 微信读书搭子 (用户开 wereadEnabled + 有有效配置, 或会话里手动激活) ──
    // 详细的 system prompt 放易变尾段，因为 snapshot/sessionState 每轮可能变。
    const wereadActive = !!wereadActiveInput && (!!wereadSnapshot || !!wereadSessionState || true);
    if (wereadActive) {
        const block = buildWereadChatSystemBlock({
            active: true,
            snapshot: wereadSnapshot,
            sessionState: wereadSessionState,
            userName: userProfile?.name || '用户',
        });
        if (block) {
            volatileTail += block;
        }
    }

    // ── 10. recency 钢印归位 + 组装 fullMessages ─────────
    // 「关于对方的表达」+「回到你自己」必须是易变尾段的最后内容：修复旧版把双语/HTML/
    // 思考链/点单块拼在钢印之后、模型开口前最后读到的是格式说明书的问题。
    volatileTail += parts.recencyTail;

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
            content: `[Reminder: 每句话必须用 <翻译><原文>...</原文><译文>...</译文></翻译> 标签包裹。一句一个标签。绝对不能省略。]`,
        });
    }
    if (mcpChatActive) {
        fullMessages.push({ role: 'system', content: MCP_TAIL_REMINDER });
    }
    if (wereadActive) {
        fullMessages.push({ role: 'system', content: WEREAD_TAIL_REMINDER });
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
        flags: { bilingualActive, mcdActive, luckinActive, luckinChatActive, wereadActive, mcpChatActive, htmlActive, thinkingActive, promptBuildSkipped: false },
    };
}
