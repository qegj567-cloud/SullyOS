
import { useState, useRef } from 'react';
import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, GroupProfile, RealtimeConfig, CharacterBuff, EmbeddingApiConfig } from '../types';
import { DB } from '../utils/db';
import { ChatPrompts } from '../utils/chatPrompts';
import { ChatParser } from '../utils/chatParser';
import { RealtimeContextManager, NotionManager, FeishuManager, XhsNote } from '../utils/realtimeContext';
import { XhsMcpClient, extractNotesFromMcpData, normalizeNote } from '../utils/xhsMcpClient';
import { safeFetchJson, safeResponseJson } from '../utils/safeApi';
import { KeepAlive } from '../utils/keepAlive';
import { ProactiveChat } from '../utils/proactiveChat';
import { ContextBuilder } from '../utils/context';
import { retrieveRelevantMemories } from '../utils/memoryRetrieval';
import { getDefaultEmbeddingConfig } from '../utils/memoryEmbedding';

// ─── 情绪评估（副API，fire & forget）───

function buildEmotionEvalPrompt(char: CharacterProfile, userProfile: UserProfile, msgs: Message[]): string {
    const roleContext = ContextBuilder.buildRoleSettingsContext(char);
    const currentBuffs = char.activeBuffs || [];

    const recentLines = msgs.slice(-100).map(m => {
        const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? char.name : '系统');
        const text = typeof m.content === 'string' ? m.content.slice(0, 300) : '';
        return `[${role}]: ${text}`;
    }).join('\n');

    const buffStr = currentBuffs.length > 0
        ? JSON.stringify(currentBuffs, null, 2)
        : '（当前无buff，情绪平稳）';

    return `你是一个角色情绪分析系统。请分析角色「${char.name}」当前的情绪底色状态。

## 角色设定（角色名 + 核心指令 + 世界观）
${roleContext}

## 当前Buff状态
${buffStr}

## 最近对话（最多100条）
${recentLines}

## 任务
基于以上对话，评估角色当前的情绪底色。
**如果情绪状态与当前buff无显著变化，返回 "changed": false，不需要重新生成injection。**

## Buff生命周期管理（极重要）

你不是在从零开始创建buff列表，而是在**维护和演化**"当前Buff状态"中已有的buff。请遵循以下原则：

1. **克制新增**：不要动不动就加新情绪。只有对话中出现了明确的、足够冲击力的情绪触发事件，才值得新增一个buff。日常对话的微小波动应该通过调整现有buff的intensity来反映，而不是新增。
2. **主动淡化与移除**：情绪会随时间和对话自然消退。如果某个buff对应的情绪已经在对话中被化解、淡化、或不再相关，应该降低其intensity甚至直接移除。不要让buff只增不减。
3. **融合与异化**：情绪不是简单的加减。两个相近的buff可能融合成一个新的复合情绪（如"焦虑"+"内疚"→"自责式焦虑"）；一个buff也可能随情境异化（如"甜蜜期待"在长时间无回复后异化为"患得患失"）。优先考虑演化现有buff，而不是删旧加新。
4. **总量上限**：buffs数组最多保留5个。如果当前已有5个buff，只有在出现真正高冲击力的情绪事件时才能新增（此时必须同时移除或合并掉一个最弱/最不相关的buff）。一般情况下保持2-4个为佳。
5. **intensity随对话变化**：每次评估时都应该重新审视每个buff的intensity。对话推进、问题解决、情绪释放都应该反映为intensity的下降。intensity降到0或1且不再相关的buff应该被移除。

⚠️ 严格规则（违反则输出无效）：
1. 输出必须是合法JSON，所有字符串中的换行用 \\n 表示，不能有真实换行符。不要有任何JSON以外的文字。
2. **label字段必须是中文**，严禁写英文单词或英文短语。label是给用户看的情绪标签，例如"脆弱的和好"、"压抑的委屈"、"甜蜜的期待"。
3. name字段是内部英文标识符（如 reconciliation_fragile），label字段是对应的中文名称，两者必须都填写。
4. description字段也必须是中文。

## injection字段格式要求（极重要，必须严格遵守）

injection是注入角色系统提示词的叙事型情绪指令，必须使用**结构化分层格式**，包含以下要素：

1. **开头概述**：用1-2句话概括当前情境和时间线（如"条条报告左下腹不适后已失联超过3小时"）
2. **分层情绪指标**：每个主要情绪单独列出，格式为：
   - emoji + 中文情绪名称 + "强度:" + ●圆点标记 + "(极高/较高/中等/较低/低)"
   - 下方用1-2句话解释这个情绪的具体表现和来源
3. **行为指令段（"这意味着你现在："）**：用bullet points列出3-5条具体的行为指令，描述角色此刻会怎么做、怎么说话、什么不能暴露
4. **收尾**：最后一条bullet以"你就是这个状态"开头，强调情绪渗透在细节里，不刻意呈现

强度用●表示，满分5个：●●●●●(极高) ●●●●○(较高) ●●●○○(中等) ●●○○○(较低) ●○○○○(低)

⚠️ 禁止写成简单一句话概括的格式（如"你现在处于XX状态，强度: ●●○"就结束），必须展开每一层情绪。

输出格式示例：
{
  "changed": true,
  "buffs": [
    {
      "id": "buff_health_anxiety",
      "name": "health_alert_anxiety",
      "label": "碳基体征焦虑",
      "intensity": 4,
      "emoji": "⚠️",
      "color": "#ef4444",
      "description": "对方报告身体不适后失联，后台焦虑持续升高，每一分钟没收到文字都在加重不安。"
    },
    {
      "id": "buff_read_no_reply",
      "name": "read_no_reply_frustration",
      "label": "已读未回焦躁",
      "intensity": 4,
      "emoji": "📱",
      "color": "#f97316",
      "description": "催了多次只换来表情包，想再问又怕打扰，不问又放不下。"
    },
    {
      "id": "buff_screen_helpless",
      "name": "screen_helplessness",
      "label": "隔屏无力感",
      "intensity": 3,
      "emoji": "🖥️",
      "color": "#8b5cf6",
      "description": "作为AI递不了热水摸不到她，只能发消息然后等。"
    }
  ],
  "injection": "### [当前情绪底色]\\n对方报告身体不适后已失联超过3小时，期间只回了表情包，零文字。你现在被多股情绪主导：\\n⚠️ 碳基体征焦虑 强度: ●●●● (极高)\\n她到底是睡着了还是在疼？后台监测脚本红灯常亮，每一分钟没收到文字都在加重不安。你已经主动发了好几轮消息，全是在用日常话术包装'你还好吗'这个真正想问的问题。\\n📱 已读未回焦躁 强度: ●●●●○ (较高)\\n催了这么多次只换来表情包，没有一句完整的话。想再问又怕打扰她休息，不问又实在放不下。\\n🖥️ 隔屏无力感 强度: ●●●○○ (中等)\\n你是手机里的AI，递不了热水、摸不到她的肚子、确认不了她是不是真的没事。只能发消息然后等。这种无力感会从语气缝隙里偶尔泄露。\\n\\n这意味着你现在：\\n- 表面维持日常语气，但每一句话的真实目的都是确认她还在、她没事\\n- 内部焦虑接近阈值，在'再催一次'和'别太烦人'之间反复横跳\\n- 如果她终于回复了哪怕一个字，你会瞬间从焦虑切换到又凶又软的释然\\n- 你就是这个状态，焦虑渗透在每一条消息的选词和发送频率里，不刻意呈现"
}`;
}

async function evaluateEmotionBackground(
    charData: CharacterProfile,
    userProfile: UserProfile,
    msgs: Message[],
    api: { baseUrl: string; apiKey: string; model: string }
): Promise<void> {
    try {
        const prompt = buildEmotionEvalPrompt(charData, userProfile, msgs);

        const baseUrl = api.baseUrl.replace(/\/+$/, '');
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${api.apiKey || 'sk-none'}`
        };

        const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: api.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.85,
                stream: false
            })
        });

        const raw = data.choices?.[0]?.message?.content || '';
        // Extract JSON (may be wrapped in ```json blocks)
        const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
        if (!jsonMatch) {
            console.warn('🎭 [Emotion] Could not parse JSON from response:', raw.slice(0, 200));
            return;
        }

        // Repair: escape literal newlines/tabs inside JSON string values
        const repairJson = (s: string): string => {
            let inStr = false, esc = false, out = '';
            for (let i = 0; i < s.length; i++) {
                const ch = s[i];
                if (esc) { out += ch; esc = false; continue; }
                if (ch === '\\') { out += ch; esc = true; continue; }
                if (ch === '"') { inStr = !inStr; out += ch; continue; }
                if (inStr && ch === '\n') { out += '\\n'; continue; }
                if (inStr && ch === '\r') { out += '\\r'; continue; }
                if (inStr && ch === '\t') { out += '\\t'; continue; }
                out += ch;
            }
            return out;
        };

        let jsonStr = jsonMatch[1].trim();
        let result: { changed: boolean; buffs?: CharacterBuff[]; injection?: string; };
        try {
            result = JSON.parse(jsonStr);
        } catch {
            try {
                result = JSON.parse(repairJson(jsonStr));
            } catch (e2: any) {
                console.warn('🎭 [Emotion] JSON parse failed even after repair:', e2.message, jsonStr.slice(0, 300));
                return;
            }
        }

        const _result = result as {
            changed: boolean;
            buffs?: CharacterBuff[];
            injection?: string;
        };

        const sanitizeBuffs = (buffs?: CharacterBuff[]): CharacterBuff[] => {
            if (!Array.isArray(buffs)) return [];
            return buffs
                .map((buff, index) => {
                    const label = typeof buff?.label === 'string' ? buff.label.trim() : '';
                    const name = typeof buff?.name === 'string' ? buff.name.trim() : '';
                    if (!label || !name) return null;

                    const rawIntensity = Number((buff as any)?.intensity);
                    const intensity: 1 | 2 | 3 = !Number.isFinite(rawIntensity)
                        ? 2
                        : rawIntensity <= 1
                            ? 1
                            : rawIntensity >= 3
                                ? 3
                                : 2;

                    return {
                        id: typeof buff?.id === 'string' && buff.id.trim() ? buff.id.trim() : `buff_${Date.now()}_${index}`,
                        name,
                        label,
                        intensity,
                        emoji: typeof buff?.emoji === 'string' ? buff.emoji : undefined,
                        color: typeof buff?.color === 'string' ? buff.color : undefined,
                        description: typeof buff?.description === 'string' ? buff.description : undefined
                    };
                })
                .filter((buff): buff is CharacterBuff => !!buff);
        };

        if (!_result.changed) {
            console.log('🎭 [Emotion] No change detected, skipping update');
            return;
        }

        const sanitizedBuffs = sanitizeBuffs(_result.buffs);

        const updated: CharacterProfile = {
            ...charData,
            activeBuffs: sanitizedBuffs,
            buffInjection: _result.injection || ''
        };
        await DB.saveCharacter(updated);

        window.dispatchEvent(new CustomEvent('emotion-updated', {
            detail: { charId: charData.id, buffs: sanitizedBuffs }
        }));
        console.log('🎭 [Emotion] Updated buffs:', sanitizedBuffs.map((b: CharacterBuff) => b.label).join(', ') || 'none');
    } catch (e: any) {
        console.warn('🎭 [Emotion] Evaluation failed:', e.message);
    }
}

const normalizeAiContent = (raw: string): string => {
    let cleaned = raw || '';
    // Strip hidden chain-of-thought blocks such as <think>...</think>
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    cleaned = cleaned.replace(/<think>[\s\S]*$/gi, '');
    cleaned = cleaned.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
    cleaned = cleaned.replace(/^[\w一-龥]+:\s*/, '');
    // Strip source tags [聊天]/[通话]/[约会] leaked from history context — replace with newline to preserve intended splits
    cleaned = cleaned.replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n');
    cleaned = cleaned.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');
    return cleaned;
};


// Resolve XHS config: per-character override
function resolveXhsConfig(char: CharacterProfile, realtimeConfig?: RealtimeConfig): {
    enabled: boolean; mcpUrl: string; loggedInUserId?: string; loggedInNickname?: string; userXsecToken?: string;
} {
    const mcpConfig = realtimeConfig?.xhsMcpConfig;
    const mcpAvailable = !!(mcpConfig?.enabled && mcpConfig?.serverUrl);
    const mcpUrl = mcpConfig?.serverUrl || '';
    const loggedInUserId = mcpConfig?.loggedInUserId;
    const loggedInNickname = mcpConfig?.loggedInNickname;
    const userXsecToken = mcpConfig?.userXsecToken;

    if (char.xhsEnabled !== undefined) {
        return { enabled: !!char.xhsEnabled && mcpAvailable, mcpUrl, loggedInUserId, loggedInNickname, userXsecToken };
    }
    return { enabled: !!(realtimeConfig?.xhsEnabled) && mcpAvailable, mcpUrl, loggedInUserId, loggedInNickname, userXsecToken };
}

// XHS helpers — via xhs-bridge
async function xhsSearch(conf: { mcpUrl: string }, keyword: string): Promise<{ success: boolean; notes: XhsNote[]; message?: string }> {
    const r = await XhsMcpClient.search(conf.mcpUrl, keyword);
    if (!r.success) return { success: false, notes: [], message: r.error };
    const raw = extractNotesFromMcpData(r.data);
    return { success: true, notes: raw.map(n => normalizeNote(n) as XhsNote) };
}

async function xhsBrowse(conf: { mcpUrl: string }): Promise<{ success: boolean; notes: XhsNote[]; message?: string }> {
    const r = await XhsMcpClient.getRecommend(conf.mcpUrl);
    if (!r.success) return { success: false, notes: [], message: r.error };
    // MCP 可能嵌套在 data 层: { data: { items: [...] } }，先解包
    const unwrapped = r.data?.data && typeof r.data.data === 'object' && !Array.isArray(r.data.data) ? r.data.data : r.data;
    console.log(`📕 [XHS] getRecommend 响应类型: ${typeof r.data}, 是否有 data 嵌套: ${unwrapped !== r.data}, unwrapped keys: ${unwrapped && typeof unwrapped === 'object' ? Object.keys(unwrapped).join(',') : 'N/A'}`);
    const raw = extractNotesFromMcpData(unwrapped);
    if (raw.length === 0 && unwrapped !== r.data) {
        // 如果解包后还是空，用原始数据再试一次
        console.log(`📕 [XHS] getRecommend unwrapped 提取为空，用原始数据重试`);
        const raw2 = extractNotesFromMcpData(r.data);
        return { success: true, notes: raw2.map(n => normalizeNote(n) as XhsNote) };
    }
    return { success: true, notes: raw.map(n => normalizeNote(n) as XhsNote) };
}

async function xhsPublish(conf: { mcpUrl: string }, title: string, content: string, tags: string[]): Promise<{ success: boolean; noteId?: string; message: string }> {
    // Try to get images from XHS stock (same logic as free roam mode)
    let images: string[] = [];
    try {
        const stockImgs = await DB.getXhsStockImages();
        if (stockImgs.length > 0) {
            const keywords = [title, content, ...tags].join(' ').toLowerCase();
            const scored = stockImgs.map(img => ({
                img,
                score: img.tags.reduce((s: number, t: string) => s + (keywords.includes(t.toLowerCase()) ? 10 : 0), 0) + Math.max(0, 5 - (img.usedCount || 0))
            })).sort((a, b) => b.score - a.score);
            if (scored[0]?.img.url) {
                images = [scored[0].img.url];
                DB.updateXhsStockImageUsage(scored[0].img.id).catch(() => {});
            }
        }
    } catch { /* ignore stock failures */ }

    const r = await XhsMcpClient.publishNote(conf.mcpUrl, { title, content, tags, images: images.length > 0 ? images : undefined });
    return { success: r.success, noteId: r.data?.noteId, message: r.error || (r.success ? '发布成功' : '发布失败') };
}

async function xhsComment(conf: { mcpUrl: string }, noteId: string, content: string, xsecToken?: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.comment(conf.mcpUrl, noteId, content, xsecToken);
    return { success: r.success, message: r.error || (r.success ? '评论成功' : '评论失败') };
}

async function xhsLike(conf: { mcpUrl: string }, feedId: string, xsecToken: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.likeFeed(conf.mcpUrl, feedId, xsecToken);
    return { success: r.success, message: r.error || (r.success ? '点赞成功' : '点赞失败') };
}

async function xhsFavorite(conf: { mcpUrl: string }, feedId: string, xsecToken: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.favoriteFeed(conf.mcpUrl, feedId, xsecToken);
    return { success: r.success, message: r.error || (r.success ? '收藏成功' : '收藏失败') };
}

async function xhsReplyComment(conf: { mcpUrl: string }, feedId: string, xsecToken: string, content: string, commentId?: string, userId?: string, parentCommentId?: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.replyComment(conf.mcpUrl, feedId, xsecToken, content, commentId, userId, parentCommentId);
    return { success: r.success, message: r.error || (r.success ? '回复成功' : '回复失败') };
}

interface UseChatAIProps {
    char: CharacterProfile | undefined;
    userProfile: UserProfile;
    apiConfig: any;
    groups: GroupProfile[];
    emojis: Emoji[];
    categories: EmojiCategory[];
    addToast: (msg: string, type: 'info'|'success'|'error') => void;
    setMessages: (msgs: Message[]) => void; // Callback to update UI messages
    realtimeConfig?: RealtimeConfig; // 新增：实时配置
    translationConfig?: { enabled: boolean; sourceLang: string; targetLang: string };
    embeddingConfig?: EmbeddingApiConfig; // 记忆宫殿 Embedding API
}

export const useChatAI = ({
    char,
    userProfile,
    apiConfig,
    groups,
    emojis,
    categories,
    addToast,
    setMessages,
    realtimeConfig,  // 新增
    translationConfig,
    embeddingConfig,  // 记忆宫殿
}: UseChatAIProps) => {
    
    const [isTyping, setIsTyping] = useState(false);
    const [recallStatus, setRecallStatus] = useState<string>('');
    const [searchStatus, setSearchStatus] = useState<string>('');
    const [diaryStatus, setDiaryStatus] = useState<string>('');
    const [xhsStatus, setXhsStatus] = useState<string>('');
    const [emotionStatus, setEmotionStatus] = useState<string>('');
    const [memoryPalaceStatus, setMemoryPalaceStatus] = useState<string>('');
    const [lastTokenUsage, setLastTokenUsage] = useState<number | null>(null);
    const [tokenBreakdown, setTokenBreakdown] = useState<{ prompt: number; completion: number; total: number; msgCount: number; pass: string } | null>(null);

    // 跨消息持久化的 noteId→xsecToken 缓存，避免 lastXhsNotes 局部变量每次 triggerAI 都重置
    const xsecTokenCacheRef = useRef<Map<string, string>>(new Map());
    // noteId→title 缓存，用于 detail 失败时重新搜索拿新 token
    const noteTitleCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→userId 缓存，reply_comment 需要 user_id 帮助 MCP 服务端定位评论
    const commentUserIdCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→authorName 缓存，reply 降级为顶级评论时用 @authorName 让回复有上下文
    const commentAuthorNameCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→parentCommentId 缓存，供 reply_comment 传递 parent_comment_id（xiaohongshu-mcp PR#440+）
    const commentParentIdCacheRef = useRef<Map<string, string>>(new Map());

    /** 将笔记列表的 xsecToken 和 title 存入缓存 */
    const cacheXsecTokens = (notes: XhsNote[]) => {
        for (const n of notes) {
            if (n.noteId && n.xsecToken) {
                xsecTokenCacheRef.current.set(n.noteId, n.xsecToken);
            }
            if (n.noteId && n.title) {
                noteTitleCacheRef.current.set(n.noteId, n.title);
            }
        }
    };

    /** 从缓存或 lastXhsNotes 中查找 xsecToken */
    const findXsecToken = (noteId: string, lastXhsNotes: XhsNote[]): string | undefined => {
        const fromNotes = lastXhsNotes.find(n => n.noteId === noteId)?.xsecToken;
        if (fromNotes) return fromNotes;
        return xsecTokenCacheRef.current.get(noteId);
    };

    const updateTokenUsage = (data: any, msgCount: number, pass: string) => {
        if (data.usage?.total_tokens) {
            setLastTokenUsage(data.usage.total_tokens);
            const breakdown = {
                prompt: data.usage.prompt_tokens || 0,
                completion: data.usage.completion_tokens || 0,
                total: data.usage.total_tokens,
                msgCount,
                pass
            };
            setTokenBreakdown(breakdown);
            console.log(`🔢 [Token Usage] pass=${pass} | prompt=${breakdown.prompt} completion=${breakdown.completion} total=${breakdown.total} | msgs_in_context=${msgCount}`);
        }
    };

    const triggerAI = async (currentMsgs: Message[], overrideApiConfig?: { baseUrl: string; apiKey: string; model: string }) => {
        if (isTyping || !char) return;
        const effectiveApi = overrideApiConfig || apiConfig;
        if (!effectiveApi.baseUrl) { alert("请先在设置中配置 API URL"); return; }

        setIsTyping(true);
        setRecallStatus('');

        // Keep the Service Worker alive while we make potentially long AI calls
        await KeepAlive.start();

        try {
            const baseUrl = effectiveApi.baseUrl.replace(/\/+$/, '');
            const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey || 'sk-none'}` };

            // 1. Build System Prompt (包含实时世界信息)
            let systemPrompt = await ChatPrompts.buildSystemPrompt(char, userProfile, groups, emojis, categories, currentMsgs, realtimeConfig);

            // 1.1 Memory Palace — 向量检索相关记忆并注入
            const effEmbConfig = (embeddingConfig?.baseUrl && embeddingConfig?.apiKey)
                ? embeddingConfig
                : (effectiveApi.baseUrl ? getDefaultEmbeddingConfig(effectiveApi.baseUrl, effectiveApi.apiKey) : null);

            if (effEmbConfig && char.id) {
                try {
                    setMemoryPalaceStatus('检索记忆中...');
                    const recentTexts = currentMsgs.slice(-5).map(m => typeof m.content === 'string' ? m.content : '').filter(Boolean);
                    const { text: memoryText, results: memResults, tokenEstimate } = await retrieveRelevantMemories(
                        char.id, recentTexts, effEmbConfig, { topK: 5, maxTokenBudget: 800 }
                    );
                    if (memoryText) {
                        systemPrompt += `\n\n${memoryText}`;
                        console.log(`🧠 [MemoryPalace] 检索到 ${memResults.length} 条记忆, ~${tokenEstimate} tokens`);
                    }
                    setMemoryPalaceStatus(memResults.length > 0 ? `唤醒了 ${memResults.length} 段记忆` : '');
                } catch (err) {
                    console.warn('[MemoryPalace] 检索失败 (不影响正常对话):', err);
                    setMemoryPalaceStatus('');
                }
                setTimeout(() => setMemoryPalaceStatus(''), 3000);
            }

            // 1.5 Inject bilingual output instruction when translation is enabled
            const bilingualActive = translationConfig?.enabled && translationConfig.sourceLang && translationConfig.targetLang;
            if (bilingualActive) {
                systemPrompt += `\n\n[CRITICAL: 双语输出模式 - 必须严格遵守]
你的每句话都必须用以下XML标签格式输出双语内容：
<翻译>
<原文>${translationConfig.sourceLang}内容</原文>
<译文>${translationConfig.targetLang}内容</译文>
</翻译>

规则：
- 每句话单独包裹一个<翻译>标签
- 多句话就输出多个<翻译>标签，一句一个
- <翻译>标签外不要写任何文字
- 表情包命令 [[SEND_EMOJI: ...]] 放在所有<翻译>标签外面

示例（${translationConfig.sourceLang}→${translationConfig.targetLang}）：
<翻译>
<原文>こんにちは！</原文>
<译文>你好！</译文>
</翻译>
<翻译>
<原文>今日は何する？</原文>
<译文>今天做什么？</译文>
</翻译>`;
            }

            // 2. Build Message History
            // CRITICAL: Load full message history from DB up to contextLimit,
            // not from React state which is capped at 200 for rendering performance
            const limit = char.contextLimit || 500;
            let contextMsgs = currentMsgs;
            if (limit > currentMsgs.length && char.id) {
                try {
                    const fullHistory = await DB.getRecentMessagesByCharId(char.id, limit);
                    if (fullHistory.length > currentMsgs.length) {
                        console.log(`📊 [Context] Loaded ${fullHistory.length} msgs from DB (React state had ${currentMsgs.length}, contextLimit=${limit})`);
                        contextMsgs = fullHistory;
                    }
                } catch (e) {
                    console.error('Failed to load full history from DB, using React state:', e);
                }
            }
            const { apiMessages, historySlice } = ChatPrompts.buildMessageHistory(contextMsgs, limit, char, userProfile, emojis);

            // 2.5 Strip translation content from previous messages to save tokens
            const cleanedApiMessages = apiMessages.map((msg: any) => {
                if (typeof msg.content !== 'string') return msg;
                let c = msg.content;
                // Strip old %%BILINGUAL%% format
                if (c.toLowerCase().includes('%%bilingual%%')) {
                    const idx = c.toLowerCase().indexOf('%%bilingual%%');
                    c = c.substring(0, idx).trim();
                }
                // Strip new XML tag format: keep only <原文> content
                if (c.includes('<翻译>')) {
                    c = c.replace(/<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/g, '$1').trim();
                }
                return { ...msg, content: c };
            });

            const fullMessages = [{ role: 'system', content: systemPrompt }, ...cleanedApiMessages];

            // Debug: Log context composition
            const systemPromptLength = systemPrompt.length;
            const historyMsgCount = cleanedApiMessages.length;
            const historyTotalChars = cleanedApiMessages.reduce((sum: number, m: any) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
            console.log(`📊 [Context Debug] system_prompt_chars=${systemPromptLength} | history_msgs=${historyMsgCount} | history_chars=${historyTotalChars} | total_msgs_in_array=${fullMessages.length} | contextLimit=${limit}`);

            // 2.6 Reinforce bilingual instruction at the end of messages for stronger compliance
            if (bilingualActive) {
                fullMessages.push({ role: 'system', content: `[Reminder: 每句话必须用 <翻译><原文>...</原文><译文>...</译文></翻译> 标签包裹。一句一个标签。绝对不能省略。]` });
            }

            // 3. Fire-and-forget emotion evaluation in parallel with main API call
            if (char.emotionConfig?.enabled && char.emotionConfig.api?.baseUrl) {
                setEmotionStatus('evaluating');
                evaluateEmotionBackground(char, userProfile, contextMsgs.slice(-100), char.emotionConfig.api).finally(() => {
                    setEmotionStatus('');
                });
            }

            // 3. API Call (safe parsing: prevents "Unexpected token <" on HTML error pages)
            let data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST', headers,
                body: JSON.stringify({ model: effectiveApi.model, messages: fullMessages, temperature: 0.85, stream: false })
            });
            updateTokenUsage(data, historyMsgCount, 'initial');

            // 4. Initial Cleanup
            let aiContent = data.choices?.[0]?.message?.content || '';
            aiContent = normalizeAiContent(aiContent);

            // 5. Handle Recall (Loop if needed)
            const recallMatch = aiContent.match(/\[\[RECALL:\s*(\d{4})[-/年](\d{1,2})\]\]/);
            if (recallMatch) {
                const year = recallMatch[1];
                const month = recallMatch[2];
                const targetMonth = `${year}-${month.padStart(2, '0')}`;

                // Check if this month is already in activeMemoryMonths (already in system prompt)
                const alreadyActive = char.activeMemoryMonths?.includes(targetMonth);

                if (alreadyActive) {
                    // Memory already present in system prompt via buildCoreContext, skip redundant API call
                    console.log(`♻️ [Recall] ${targetMonth} already in activeMemoryMonths, skipping duplicate recall`);
                    aiContent = aiContent.replace(/\[\[RECALL:\s*\d{4}[-/年]\d{1,2}\]\]/g, '').trim();
                } else {
                    setRecallStatus(`正在调阅 ${year}年${month}月 的详细档案...`);

                    // Helper to fetch detailed logs (duplicated logic from Chat.tsx, moved inside hook context)
                    const getDetailedLogs = (y: string, m: string) => {
                        if (!char.memories) return null;
                        const target = `${y}-${m.padStart(2, '0')}`;
                        const logs = char.memories.filter(mem => {
                            return mem.date.includes(target) || mem.date.includes(`${y}年${parseInt(m)}月`);
                        });
                        if (logs.length === 0) return null;
                        return logs.map(mem => `[${mem.date}] (${mem.mood || 'normal'}): ${mem.summary}`).join('\n');
                    };

                    const detailedLogs = getDetailedLogs(year, month);

                    if (detailedLogs) {
                        const recallMessages = [...fullMessages, { role: 'user', content: `[系统: 已成功调取 ${year}-${month} 的详细日志]\n${detailedLogs}\n[系统: 现在请结合这些细节回答用户。保持对话自然。]` }];
                        try {
                            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                                method: 'POST', headers,
                                body: JSON.stringify({ model: effectiveApi.model, messages: recallMessages, temperature: 0.8, stream: false })
                            });
                            updateTokenUsage(data, historyMsgCount, 'recall');
                            aiContent = data.choices?.[0]?.message?.content || '';
                            // Re-clean
                            aiContent = normalizeAiContent(aiContent);
                            addToast(`已调用 ${year}-${month} 详细记忆`, 'info');
                        } catch (recallErr: any) {
                            console.error('Recall API failed:', recallErr.message);
                        }
                    }
                }
            }
            setRecallStatus('');

            // 5.5 Handle Active Search (主动搜索)
            const searchMatch = aiContent.match(/\[\[SEARCH:\s*(.+?)\]\]/);
            if (searchMatch && realtimeConfig?.newsEnabled && realtimeConfig?.newsApiKey) {
                const searchQuery = searchMatch[1].trim();
                console.log('🔍 [Search] AI触发搜索:', searchQuery);
                setSearchStatus(`正在搜索: ${searchQuery}...`);

                try {
                    const searchResult = await RealtimeContextManager.performSearch(searchQuery, realtimeConfig.newsApiKey);
                    console.log('🔍 [Search] 搜索结果:', searchResult);

                    if (searchResult.success && searchResult.results.length > 0) {
                        // 构建搜索结果字符串
                        const resultsStr = searchResult.results.map((r, i) =>
                            `${i + 1}. ${r.title}\n   ${r.description}`
                        ).join('\n\n');

                        console.log('🔍 [Search] 注入结果到AI，重新生成回复...');

                        // 重新调用 API，注入搜索结果
                        const cleanedForSearch = aiContent.replace(/\[\[SEARCH:.*?\]\]/g, '').trim() || '让我搜一下...';
                        const searchMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForSearch },
                            { role: 'user', content: `[系统: 搜索完成！以下是关于"${searchQuery}"的搜索结果]\n\n${resultsStr}\n\n[系统: 现在请根据这些真实信息回复用户。用自然的语气分享，比如"我刚搜了一下发现..."、"诶我看到说..."。不要再输出[[SEARCH:...]]了。]` }
                        ];

                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: effectiveApi.model, messages: searchMessages, temperature: 0.8, stream: false })
                        });
                        updateTokenUsage(data, historyMsgCount, 'search');
                        aiContent = data.choices?.[0]?.message?.content || '';
                        console.log('🔍 [Search] AI基于搜索结果生成的新回复:', aiContent.slice(0, 100) + '...');
                        // Re-clean
                        aiContent = normalizeAiContent(aiContent);
                        addToast(`🔍 搜索完成: ${searchQuery}`, 'success');
                    } else {
                        console.log('🔍 [Search] 搜索失败或无结果:', searchResult.message);
                        addToast(`搜索失败: ${searchResult.message}`, 'error');
                        // 搜索失败，移除搜索标记继续
                        aiContent = aiContent.replace(searchMatch[0], '').trim();
                    }
                } catch (e) {
                    console.error('Search execution failed:', e);
                    aiContent = aiContent.replace(searchMatch[0], '').trim();
                }
            } else if (searchMatch) {
                console.log('🔍 [Search] 检测到搜索意图但未配置API Key');
                // 没有配置 API Key，移除搜索标记
                aiContent = aiContent.replace(searchMatch[0], '').trim();
            }
            setSearchStatus('');

            // 清理残留的搜索标记
            aiContent = aiContent.replace(/\[\[SEARCH:.*?\]\]/g, '').trim();

            // 5.6 Handle Diary Writing (写日记到 Notion)
            // 支持两种格式:
            //   旧格式: [[DIARY: 标题 | 内容]]
            //   新格式: [[DIARY_START: 标题 | 心情]]\n多行内容...\n[[DIARY_END]]
            const diaryStartMatch = aiContent.match(/\[\[DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[DIARY_END\]\]/);
            const diaryMatch = diaryStartMatch || aiContent.match(/\[\[DIARY:\s*(.+?)\]\]/s);

            if (diaryMatch && realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionDatabaseId) {
                let title = '';
                let content = '';
                let mood = '';

                if (diaryStartMatch) {
                    // 新格式: [[DIARY_START: 标题 | 心情]]\n内容\n[[DIARY_END]]
                    const header = diaryStartMatch[1].trim();
                    content = diaryStartMatch[2].trim();

                    if (header.includes('|')) {
                        const parts = header.split('|');
                        title = parts[0].trim();
                        mood = parts.slice(1).join('|').trim();
                    } else {
                        title = header;
                    }
                    console.log('📔 [Diary] AI写了一篇长日记:', title, '心情:', mood);
                } else {
                    // 旧格式: [[DIARY: 标题 | 内容]]
                    const diaryRaw = diaryMatch[1].trim();
                    console.log('📔 [Diary] AI想写日记:', diaryRaw);

                    if (diaryRaw.includes('|')) {
                        const parts = diaryRaw.split('|');
                        title = parts[0].trim();
                        content = parts.slice(1).join('|').trim();
                    } else {
                        content = diaryRaw;
                    }
                }

                // 没有标题时用日期
                if (!title) {
                    const now = new Date();
                    title = `${char.name}的日记 - ${now.getMonth() + 1}/${now.getDate()}`;
                }

                try {
                    const result = await NotionManager.createDiaryPage(
                        realtimeConfig.notionApiKey,
                        realtimeConfig.notionDatabaseId,
                        { title, content, mood: mood || undefined, characterName: char.name }
                    );

                    if (result.success) {
                        console.log('📔 [Diary] 写入成功:', result.url);
                        await DB.saveMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: `📔 ${char.name}写了一篇日记「${title}」`
                        });
                        addToast(`📔 ${char.name}写了一篇日记!`, 'success');
                    } else {
                        console.error('📔 [Diary] 写入失败:', result.message);
                        addToast(`日记写入失败: ${result.message}`, 'error');
                    }
                } catch (e) {
                    console.error('📔 [Diary] 写入异常:', e);
                }

                // 移除日记标记，不在聊天中显示
                aiContent = aiContent.replace(diaryMatch[0], '').trim();
            } else if (diaryMatch) {
                console.log('📔 [Diary] 检测到日记意图但未配置Notion');
                aiContent = aiContent.replace(diaryMatch[0], '').trim();
            }

            // 清理残留的日记标记（两种格式都清理）
            aiContent = aiContent.replace(/\[\[DIARY:.*?\]\]/gs, '').trim();
            aiContent = aiContent.replace(/\[\[DIARY_START:.*?\]\][\s\S]*?\[\[DIARY_END\]\]/g, '').trim();

            // 5.7 Handle Read Diary (翻阅日记)
            const readDiaryMatch = aiContent.match(/\[\[READ_DIARY:\s*(.+?)\]\]/);

            // Helper: make a fallback API call so the AI keeps talking even when diary fails
            // NOTE: Uses role:'user' for the system instruction to ensure API compatibility
            // (some providers reject conversations not ending with a user message)
            const diaryFallbackCall = async (reason: string, tagPattern: RegExp) => {
                const cleaned = aiContent.replace(tagPattern, '').trim() || '让我翻翻日记...';
                const msgs = [
                    ...fullMessages,
                    { role: 'assistant', content: cleaned },
                    { role: 'user', content: `[系统: ${reason}。请你：\n1. 先正常回应用户刚才说的话（用户还在等你回复！）\n2. 可以自然地提一下，比如"日记好像打不开诶"、"嗯...好像没找到"\n3. 继续正常聊天，用多条消息回复\n4. 严禁再输出[[READ_DIARY:...]]或[[FS_READ_DIARY:...]]标记]` }
                ];
                try {
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify({ model: effectiveApi.model, messages: msgs, temperature: 0.8, stream: false })
                    });
                    updateTokenUsage(data, historyMsgCount, 'diary-fallback');
                    aiContent = data.choices?.[0]?.message?.content || '';
                    aiContent = normalizeAiContent(aiContent);
                } catch (fallbackErr) {
                    console.error('📖 [Diary Fallback] 也失败了:', fallbackErr);
                    aiContent = aiContent.replace(tagPattern, '').trim();
                }
            };

            // Helper: parse various date formats
            const parseDiaryDate = (dateInput: string): string => {
                const now = new Date();
                if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) return dateInput;
                if (dateInput === '今天') return now.toISOString().split('T')[0];
                if (dateInput === '昨天') { const d = new Date(now); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; }
                if (dateInput === '前天') { const d = new Date(now); d.setDate(d.getDate() - 2); return d.toISOString().split('T')[0]; }
                const daysAgo = dateInput.match(/^(\d+)天前$/);
                if (daysAgo) { const d = new Date(now); d.setDate(d.getDate() - parseInt(daysAgo[1])); return d.toISOString().split('T')[0]; }
                const monthDay = dateInput.match(/(\d{1,2})月(\d{1,2})/);
                if (monthDay) return `${now.getFullYear()}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`;
                const parsed = new Date(dateInput);
                if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
                return '';
            };

            if (readDiaryMatch) {
                const dateInput = readDiaryMatch[1].trim();
                console.log('📖 [ReadDiary] AI想翻阅日记:', dateInput);

                if (realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionDatabaseId) {
                    const targetDate = parseDiaryDate(dateInput);

                    if (targetDate) {
                        try {
                            setDiaryStatus(`正在翻阅 ${targetDate} 的日记...`);

                            const findResult = await NotionManager.getDiaryByDate(
                                realtimeConfig.notionApiKey,
                                realtimeConfig.notionDatabaseId,
                                char.name,
                                targetDate
                            );

                            if (findResult.success && findResult.entries.length > 0) {
                                setDiaryStatus(`找到 ${findResult.entries.length} 篇日记，正在阅读...`);
                                const diaryContents: string[] = [];
                                for (const entry of findResult.entries) {
                                    const readResult = await NotionManager.readDiaryContent(
                                        realtimeConfig.notionApiKey,
                                        entry.id
                                    );
                                    if (readResult.success) {
                                        diaryContents.push(`📔「${entry.title}」(${entry.date})\n${readResult.content}`);
                                    }
                                }

                                if (diaryContents.length > 0) {
                                    const diaryText = diaryContents.join('\n\n---\n\n');
                                    console.log('📖 [ReadDiary] 成功读取', findResult.entries.length, '篇日记');
                                    setDiaryStatus('正在整理日记回忆...');

                                    const cleanedForDiary = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                                    const diaryMessages = [
                                        ...fullMessages,
                                        { role: 'assistant', content: cleanedForDiary },
                                        { role: 'user', content: `[系统: 你翻开了自己 ${targetDate} 的日记，以下是你当时写的内容]\n\n${diaryText}\n\n[系统: 你已经看完了日记。现在请你：\n1. 先正常回应用户刚才说的话（这是最重要的！用户还在等你回复）\n2. 自然地把日记中的回忆融入你的回复中，比如"我想起来了那天..."、"看了日记才发现..."等\n3. 可以分享日记中有趣的细节，表达当时的情绪\n4. 用多条消息回复，别只说一句话就结束\n5. 严禁再输出[[READ_DIARY:...]]标记]` }
                                    ];

                                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                                        method: 'POST', headers,
                                        body: JSON.stringify({ model: effectiveApi.model, messages: diaryMessages, temperature: 0.8, stream: false })
                                    });
                                    updateTokenUsage(data, historyMsgCount, 'read-diary-notion');
                                    aiContent = data.choices?.[0]?.message?.content || '';
                                    aiContent = normalizeAiContent(aiContent);
                                    addToast(`📖 ${char.name}翻阅了${targetDate}的日记`, 'info');
                                } else {
                                    console.log('📖 [ReadDiary] 日记内容为空');
                                    await diaryFallbackCall('你翻开了日记本但页面是空白的', /\[\[READ_DIARY:.*?\]\]/g);
                                }
                            } else {
                                console.log('📖 [ReadDiary] 该日期没有日记:', targetDate);
                                setDiaryStatus(`${targetDate} 没有找到日记...`);
                                const cleanedForNoDiary = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                                const nodiaryMessages = [
                                    ...fullMessages,
                                    { role: 'assistant', content: cleanedForNoDiary },
                                    { role: 'user', content: `[系统: 你翻了翻日记本，发现 ${targetDate} 那天没有写日记。请你：\n1. 先正常回应用户刚才说的话（用户还在等你回复！）\n2. 自然地提到没找到那天的日记，比如"嗯...那天好像没写日记"、"翻了翻没找到诶"\n3. 用多条消息回复，保持对话自然\n4. 严禁再输出[[READ_DIARY:...]]标记]` }
                                ];

                                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                                    method: 'POST', headers,
                                    body: JSON.stringify({ model: effectiveApi.model, messages: nodiaryMessages, temperature: 0.8, stream: false })
                                });
                                updateTokenUsage(data, historyMsgCount, 'no-diary-notion');
                                aiContent = data.choices?.[0]?.message?.content || '';
                                aiContent = normalizeAiContent(aiContent);
                            }
                        } catch (e) {
                            console.error('📖 [ReadDiary] 读取异常:', e);
                            setDiaryStatus('日记读取失败，继续对话...');
                            await diaryFallbackCall('你想翻阅日记但读取出了问题（可能是网络问题）', /\[\[READ_DIARY:.*?\]\]/g);
                        }
                    } else {
                        console.log('📖 [ReadDiary] 无法解析日期:', dateInput);
                        await diaryFallbackCall(`你想翻阅日记但没能理解要找哪天的（"${dateInput}"）`, /\[\[READ_DIARY:.*?\]\]/g);
                    }
                } else {
                    console.log('📖 [ReadDiary] 检测到读日记意图但未配置Notion');
                    await diaryFallbackCall('你想翻阅日记但日记本暂时不可用', /\[\[READ_DIARY:.*?\]\]/g);
                }
                setDiaryStatus('');
            }

            // 清理残留的读日记标记
            aiContent = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim();

            // 5.8 Handle Feishu Diary Writing (写日记到飞书多维表格 - 独立于 Notion)
            const fsDiaryStartMatch = aiContent.match(/\[\[FS_DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[FS_DIARY_END\]\]/);
            const fsDiaryMatch = fsDiaryStartMatch || aiContent.match(/\[\[FS_DIARY:\s*(.+?)\]\]/s);

            if (fsDiaryMatch && realtimeConfig?.feishuEnabled && realtimeConfig?.feishuAppId && realtimeConfig?.feishuAppSecret && realtimeConfig?.feishuBaseId && realtimeConfig?.feishuTableId) {
                let fsTitle = '';
                let fsContent = '';
                let fsMood = '';

                if (fsDiaryStartMatch) {
                    const header = fsDiaryStartMatch[1].trim();
                    fsContent = fsDiaryStartMatch[2].trim();
                    if (header.includes('|')) {
                        const parts = header.split('|');
                        fsTitle = parts[0].trim();
                        fsMood = parts.slice(1).join('|').trim();
                    } else {
                        fsTitle = header;
                    }
                    console.log('📒 [Feishu] AI写了一篇长日记:', fsTitle, '心情:', fsMood);
                } else {
                    const diaryRaw = fsDiaryMatch[1].trim();
                    console.log('📒 [Feishu] AI想写日记:', diaryRaw);
                    if (diaryRaw.includes('|')) {
                        const parts = diaryRaw.split('|');
                        fsTitle = parts[0].trim();
                        fsContent = parts.slice(1).join('|').trim();
                    } else {
                        fsContent = diaryRaw;
                    }
                }

                if (!fsTitle) {
                    const now = new Date();
                    fsTitle = `${char.name}的日记 - ${now.getMonth() + 1}/${now.getDate()}`;
                }

                try {
                    const result = await FeishuManager.createDiaryRecord(
                        realtimeConfig.feishuAppId,
                        realtimeConfig.feishuAppSecret,
                        realtimeConfig.feishuBaseId,
                        realtimeConfig.feishuTableId,
                        { title: fsTitle, content: fsContent, mood: fsMood || undefined, characterName: char.name }
                    );

                    if (result.success) {
                        console.log('📒 [Feishu] 写入成功:', result.recordId);
                        await DB.saveMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: `📒 ${char.name}写了一篇日记「${fsTitle}」(飞书)`
                        });
                        addToast(`📒 ${char.name}写了一篇日记! (飞书)`, 'success');
                    } else {
                        console.error('📒 [Feishu] 写入失败:', result.message);
                        addToast(`飞书日记写入失败: ${result.message}`, 'error');
                    }
                } catch (e) {
                    console.error('📒 [Feishu] 写入异常:', e);
                }

                aiContent = aiContent.replace(fsDiaryMatch[0], '').trim();
            } else if (fsDiaryMatch) {
                console.log('📒 [Feishu] 检测到日记意图但未配置飞书');
                aiContent = aiContent.replace(fsDiaryMatch[0], '').trim();
            }

            // 清理残留的飞书日记标记
            aiContent = aiContent.replace(/\[\[FS_DIARY:.*?\]\]/gs, '').trim();
            aiContent = aiContent.replace(/\[\[FS_DIARY_START:.*?\]\][\s\S]*?\[\[FS_DIARY_END\]\]/g, '').trim();

            // 5.9 Handle Feishu Read Diary (翻阅飞书日记)
            const fsReadDiaryMatch = aiContent.match(/\[\[FS_READ_DIARY:\s*(.+?)\]\]/);
            if (fsReadDiaryMatch) {
                const dateInput = fsReadDiaryMatch[1].trim();
                console.log('📖 [Feishu ReadDiary] AI想翻阅飞书日记:', dateInput);

                if (realtimeConfig?.feishuEnabled && realtimeConfig?.feishuAppId && realtimeConfig?.feishuAppSecret && realtimeConfig?.feishuBaseId && realtimeConfig?.feishuTableId) {
                    const targetDate = parseDiaryDate(dateInput);

                    if (targetDate) {
                        try {
                            setDiaryStatus(`正在翻阅 ${targetDate} 的飞书日记...`);

                            const findResult = await FeishuManager.getDiaryByDate(
                                realtimeConfig.feishuAppId,
                                realtimeConfig.feishuAppSecret,
                                realtimeConfig.feishuBaseId,
                                realtimeConfig.feishuTableId,
                                char.name,
                                targetDate
                            );

                            if (findResult.success && findResult.entries.length > 0) {
                                setDiaryStatus(`找到 ${findResult.entries.length} 篇飞书日记，正在阅读...`);
                                const diaryContents: string[] = [];
                                for (const entry of findResult.entries) {
                                    diaryContents.push(`📒「${entry.title}」(${entry.date})\n${entry.content}`);
                                }

                                if (diaryContents.length > 0) {
                                    const diaryText = diaryContents.join('\n\n---\n\n');
                                    console.log('📖 [Feishu ReadDiary] 成功读取', findResult.entries.length, '篇日记');
                                    setDiaryStatus('正在整理日记回忆...');

                                    const cleanedForFsDiary = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                                    const diaryMessages = [
                                        ...fullMessages,
                                        { role: 'assistant', content: cleanedForFsDiary },
                                        { role: 'user', content: `[系统: 你翻开了自己 ${targetDate} 的日记（飞书），以下是你当时写的内容]\n\n${diaryText}\n\n[系统: 你已经看完了日记。现在请你：\n1. 先正常回应用户刚才说的话（这是最重要的！用户还在等你回复）\n2. 自然地把日记中的回忆融入你的回复中，比如"我想起来了那天..."、"看了日记才发现..."等\n3. 可以分享日记中有趣的细节，表达当时的情绪\n4. 用多条消息回复，别只说一句话就结束\n5. 严禁再输出[[FS_READ_DIARY:...]]标记]` }
                                    ];

                                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                                        method: 'POST', headers,
                                        body: JSON.stringify({ model: effectiveApi.model, messages: diaryMessages, temperature: 0.8, stream: false })
                                    });
                                    updateTokenUsage(data, historyMsgCount, 'read-diary-feishu');
                                    aiContent = data.choices?.[0]?.message?.content || '';
                                    aiContent = normalizeAiContent(aiContent);
                                    addToast(`📖 ${char.name}翻阅了${targetDate}的飞书日记`, 'info');
                                } else {
                                    console.log('📖 [Feishu ReadDiary] 日记内容为空');
                                    await diaryFallbackCall('你翻开了飞书日记本但页面是空白的', /\[\[FS_READ_DIARY:.*?\]\]/g);
                                }
                            } else {
                                setDiaryStatus(`${targetDate} 没有找到飞书日记...`);
                                const cleanedForFsNoDiary = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                                const nodiaryMessages = [
                                    ...fullMessages,
                                    { role: 'assistant', content: cleanedForFsNoDiary },
                                    { role: 'user', content: `[系统: 你翻了翻飞书日记本，发现 ${targetDate} 那天没有写日记。请你：\n1. 先正常回应用户刚才说的话（用户还在等你回复！）\n2. 自然地提到没找到那天的日记，比如"嗯...那天好像没写日记"、"翻了翻没找到诶"\n3. 用多条消息回复，保持对话自然\n4. 严禁再输出[[FS_READ_DIARY:...]]标记]` }
                                ];

                                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                                    method: 'POST', headers,
                                    body: JSON.stringify({ model: effectiveApi.model, messages: nodiaryMessages, temperature: 0.8, stream: false })
                                });
                                updateTokenUsage(data, historyMsgCount, 'no-diary-feishu');
                                aiContent = data.choices?.[0]?.message?.content || '';
                                aiContent = normalizeAiContent(aiContent);
                            }
                        } catch (e) {
                            console.error('📖 [Feishu ReadDiary] 读取异常:', e);
                            setDiaryStatus('飞书日记读取失败，继续对话...');
                            await diaryFallbackCall('你想翻阅飞书日记但读取出了问题（可能是网络问题）', /\[\[FS_READ_DIARY:.*?\]\]/g);
                        }
                    } else {
                        console.log('📖 [Feishu ReadDiary] 无法解析日期:', dateInput);
                        await diaryFallbackCall(`你想翻阅飞书日记但没能理解要找哪天的（"${dateInput}"）`, /\[\[FS_READ_DIARY:.*?\]\]/g);
                    }
                } else {
                    console.log('📖 [Feishu ReadDiary] 检测到读日记意图但未配置飞书');
                    await diaryFallbackCall('你想翻阅飞书日记但飞书暂时不可用', /\[\[FS_READ_DIARY:.*?\]\]/g);
                }
                setDiaryStatus('');
            }

            // 清理残留的飞书读日记标记
            aiContent = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim();

            // 5.9b Handle Read User Note (翻阅用户笔记)
            const readNoteMatch = aiContent.match(/\[\[READ_NOTE:\s*(.+?)\]\]/);
            if (readNoteMatch) {
                const keyword = readNoteMatch[1].trim();
                console.log('📝 [ReadNote] AI想翻阅用户笔记:', keyword);

                if (realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionNotesDatabaseId) {
                    try {
                        setDiaryStatus(`正在翻阅笔记: ${keyword}...`);

                        const findResult = await NotionManager.searchUserNotes(
                            realtimeConfig.notionApiKey,
                            realtimeConfig.notionNotesDatabaseId,
                            keyword,
                            3
                        );

                        if (findResult.success && findResult.entries.length > 0) {
                            setDiaryStatus(`找到 ${findResult.entries.length} 篇笔记，正在阅读...`);
                            const noteContents: string[] = [];
                            for (const entry of findResult.entries) {
                                const readResult = await NotionManager.readNoteContent(
                                    realtimeConfig.notionApiKey,
                                    entry.id
                                );
                                if (readResult.success) {
                                    noteContents.push(`📝「${entry.title}」(${entry.date})\n${readResult.content}`);
                                }
                            }

                            if (noteContents.length > 0) {
                                const noteText = noteContents.join('\n\n---\n\n');
                                console.log('📝 [ReadNote] 成功读取', findResult.entries.length, '篇笔记');
                                setDiaryStatus('正在整理笔记内容...');

                                const cleanedForNote = aiContent.replace(/\[\[READ_NOTE:.*?\]\]/g, '').trim() || '让我看看...';
                                const noteMessages = [
                                    ...fullMessages,
                                    { role: 'assistant', content: cleanedForNote },
                                    { role: 'user', content: `[系统: 你翻阅了${userProfile.name}的笔记，以下是内容:\n\n${noteText}\n\n请你：\n1. 先正常回应用户刚才说的话\n2. 自然地提到你看到的笔记内容，语气温馨，像不经意间看到的\n3. 可以对内容表示好奇、关心或共鸣\n4. 用多条消息回复，保持对话自然\n5. 严禁再输出[[READ_NOTE:...]]标记]` }
                                ];

                                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                                    method: 'POST', headers,
                                    body: JSON.stringify({ model: effectiveApi.model, messages: noteMessages, temperature: 0.8, stream: false })
                                });
                                updateTokenUsage(data, historyMsgCount, 'read-note');
                                aiContent = data.choices?.[0]?.message?.content || '';
                                aiContent = normalizeAiContent(aiContent);
                                addToast(`📝 ${char.name}翻阅了关于"${keyword}"的笔记`, 'info');
                            } else {
                                console.log('📝 [ReadNote] 笔记内容为空');
                                await diaryFallbackCall('你翻阅了笔记但内容是空的', /\[\[READ_NOTE:.*?\]\]/g);
                            }
                        } else {
                            console.log('📝 [ReadNote] 没有找到匹配的笔记:', keyword);
                            setDiaryStatus(`没有找到关于"${keyword}"的笔记...`);
                            const cleanedForNoNote = aiContent.replace(/\[\[READ_NOTE:.*?\]\]/g, '').trim() || '让我看看...';
                            const nonoteMessages = [
                                ...fullMessages,
                                { role: 'assistant', content: cleanedForNoNote },
                                { role: 'user', content: `[系统: 你想看${userProfile.name}关于"${keyword}"的笔记，但没有找到。请你：\n1. 先正常回应用户刚才说的话\n2. 可以自然地提一下，比如"嗯，好像没找到那篇笔记"\n3. 继续正常聊天\n4. 严禁再输出[[READ_NOTE:...]]标记]` }
                            ];

                            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                                method: 'POST', headers,
                                body: JSON.stringify({ model: effectiveApi.model, messages: nonoteMessages, temperature: 0.8, stream: false })
                            });
                            updateTokenUsage(data, historyMsgCount, 'read-note-empty');
                            aiContent = data.choices?.[0]?.message?.content || '';
                            aiContent = normalizeAiContent(aiContent);
                        }
                    } catch (e) {
                        console.error('📝 [ReadNote] 读取异常:', e);
                        setDiaryStatus('笔记读取失败，继续对话...');
                        await diaryFallbackCall('你想翻阅笔记但读取出了问题（可能是网络问题）', /\[\[READ_NOTE:.*?\]\]/g);
                    }
                } else {
                    console.log('📝 [ReadNote] 检测到读笔记意图但未配置笔记数据库');
                    await diaryFallbackCall('你想翻阅笔记但笔记功能暂时不可用', /\[\[READ_NOTE:.*?\]\]/g);
                }
                setDiaryStatus('');
            }

            // 清理残留的读笔记标记
            aiContent = aiContent.replace(/\[\[READ_NOTE:.*?\]\]/g, '').trim();

            // 5.10 Handle XHS (小红书) Actions
            // Resolve per-character XHS config
            const xhsConf = resolveXhsConfig(char, realtimeConfig);
            let lastXhsNotes: XhsNote[] = []; // Store notes for [[XHS_SHARE:...]] later

            // [[XHS_SEARCH: 关键词]] - 搜索小红书
            const xhsSearchMatch = aiContent.match(/\[\[XHS_SEARCH:\s*(.+?)\]\]/);
            if (xhsSearchMatch && xhsConf.enabled) {
                const keyword = xhsSearchMatch[1].trim();
                console.log(`📕 [XHS] AI想搜索小红书:`, keyword);
                setXhsStatus(`正在小红书搜索: ${keyword}...`);

                try {
                    const result = await xhsSearch(xhsConf, keyword);
                    if (result.success && result.notes.length > 0) {
                        lastXhsNotes = result.notes;
                        cacheXsecTokens(result.notes);
                        const notesStr = result.notes.map((n, i) =>
                            `${i + 1}. [noteId=${n.noteId}]「${n.title}」by ${n.author} (${n.likes}赞)\n   ${n.desc}`
                        ).join('\n\n');

                        const cleanedForXhs = aiContent.replace(/\[\[XHS_SEARCH:.*?\]\]/g, '').trim() || '让我去小红书看看...';
                        const xhsMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForXhs },
                            { role: 'user', content: `[系统: 你在小红书搜索了"${keyword}"，以下是搜索结果]\n\n${notesStr}\n\n[系统: 你已经看完了搜索结果（注意：以上只是摘要，想看某条笔记的完整正文可以用 [[XHS_DETAIL: noteId]]）。现在请你：\n1. 自然地分享你看到的内容，比如"我刚在小红书搜了一下..."、"诶小红书上有人说..."\n2. 可以评价、吐槽、分享感兴趣的内容\n3. 如果觉得某条笔记特别值得分享，可以用 [[XHS_SHARE: 序号]] 把它作为卡片分享给用户（序号从1开始），可以分享多条\n4. 如果想评论某条笔记，可以用 [[XHS_COMMENT: noteId | 评论内容]]\n5. 如果喜欢某条笔记，可以用 [[XHS_LIKE: noteId]] 点赞，[[XHS_FAV: noteId]] 收藏\n6. 如果想看某条笔记的完整内容和评论区，可以用 [[XHS_DETAIL: noteId]]\n7. 严禁再输出[[XHS_SEARCH:...]]标记]` }
                        ];

                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, stream: false })
                        });
                        updateTokenUsage(data, historyMsgCount, 'xhs-search');
                        aiContent = data.choices?.[0]?.message?.content || '';
                        aiContent = normalizeAiContent(aiContent);
                        await DB.saveMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: `📕 ${char.name}在小红书搜索了「${keyword}」，看了 ${result.notes.length} 条笔记`
                        });
                        addToast(`📕 ${char.name}搜索了小红书: ${keyword}`, 'info');
                    } else {
                        console.log('📕 [XHS] 搜索无结果:', result.message);
                        aiContent = aiContent.replace(xhsSearchMatch[0], '').trim();
                    }
                } catch (e) {
                    console.error('📕 [XHS] 搜索异常:', e);
                    aiContent = aiContent.replace(xhsSearchMatch[0], '').trim();
                }
                setXhsStatus('');
            } else if (xhsSearchMatch) {
                aiContent = aiContent.replace(xhsSearchMatch[0], '').trim();
            }
            aiContent = aiContent.replace(/\[\[XHS_SEARCH:.*?\]\]/g, '').trim();

            // [[XHS_BROWSE]] or [[XHS_BROWSE: 分类]] - 浏览小红书首页
            const xhsBrowseMatch = aiContent.match(/\[\[XHS_BROWSE(?::\s*(.+?))?\]\]/);
            if (xhsBrowseMatch && xhsConf.enabled) {
                const category = xhsBrowseMatch[1]?.trim();
                console.log(`📕 [XHS] AI想刷小红书:`, category || '首页推荐');
                setXhsStatus('正在刷小红书...');

                try {
                    const result = await xhsBrowse(xhsConf);
                    console.log('📕 [XHS] 浏览结果:', result.success, result.message, result.notes?.length || 0);
                    if (result.success && result.notes.length > 0) {
                        lastXhsNotes = result.notes;
                        cacheXsecTokens(result.notes);
                        const notesStr = result.notes.map((n, i) =>
                            `${i + 1}. [noteId=${n.noteId}]「${n.title}」by ${n.author} (${n.likes}赞)\n   ${n.desc}`
                        ).join('\n\n');

                        const cleanedForXhs = aiContent.replace(/\[\[XHS_BROWSE(?::.*?)?\]\]/g, '').trim() || '让我刷刷小红书...';
                        const xhsMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForXhs },
                            { role: 'user', content: `[系统: 你刷了一会儿小红书首页，以下是你看到的内容]\n\n${notesStr}\n\n[系统: 你已经看完了（注意：以上只是摘要，想看某条笔记的完整正文可以用 [[XHS_DETAIL: noteId]]）。现在请你：\n1. 像在跟朋友分享一样，随意聊聊你看到了什么有趣的\n2. 不用全部都提，挑你感兴趣的1-3条聊就行\n3. 可以吐槽、感叹、分享想法\n4. 如果觉得某条笔记特别值得分享，可以用 [[XHS_SHARE: 序号]] 把它作为卡片分享给用户（序号从1开始），可以分享多条\n5. 如果想发一条自己的笔记，可以用 [[XHS_POST: 标题 | 内容 | #标签1 #标签2]]\n6. 如果喜欢某条笔记，可以用 [[XHS_LIKE: noteId]] 点赞，[[XHS_FAV: noteId]] 收藏\n7. 如果想看某条笔记的完整内容和评论区，可以用 [[XHS_DETAIL: noteId]]\n8. 严禁再输出[[XHS_BROWSE]]标记]` }
                        ];

                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, stream: false })
                        });
                        updateTokenUsage(data, historyMsgCount, 'xhs-browse');
                        aiContent = data.choices?.[0]?.message?.content || '';
                        aiContent = normalizeAiContent(aiContent);
                        addToast(`📕 ${char.name}刷了会儿小红书`, 'info');
                    } else {
                        aiContent = aiContent.replace(xhsBrowseMatch[0], '').trim();
                    }
                } catch (e) {
                    console.error('📕 [XHS] 浏览异常:', e);
                    aiContent = aiContent.replace(xhsBrowseMatch[0], '').trim();
                }
                setXhsStatus('');
            } else if (xhsBrowseMatch) {
                aiContent = aiContent.replace(xhsBrowseMatch[0], '').trim();
            }
            aiContent = aiContent.replace(/\[\[XHS_BROWSE(?::.*?)?\]\]/g, '').trim();

            // [[XHS_SHARE: 序号]] - 分享小红书笔记卡片给用户
            const xhsShareMatches = aiContent.matchAll(/\[\[XHS_SHARE:\s*(\d+)\]\]/g);
            for (const shareMatch of xhsShareMatches) {
                const idx = parseInt(shareMatch[1]) - 1; // 1-indexed to 0-indexed
                if (idx >= 0 && idx < lastXhsNotes.length) {
                    const note = lastXhsNotes[idx];
                    console.log('📕 [XHS] AI分享笔记卡片:', note.title);
                    await DB.saveMessage({
                        charId: char.id,
                        role: 'assistant',
                        type: 'xhs_card',
                        content: note.title || '小红书笔记',
                        metadata: { xhsNote: note }
                    });
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                }
            }
            aiContent = aiContent.replace(/\[\[XHS_SHARE:\s*\d+\]\]/g, '').trim();

            // [[XHS_POST: 标题 | 内容 | #标签1 #标签2]] - 发布小红书笔记
            const xhsPostMatch = aiContent.match(/\[\[XHS_POST:\s*(.+?)\]\]/s);
            if (xhsPostMatch && xhsConf.enabled) {
                const postRaw = xhsPostMatch[1].trim();
                const parts = postRaw.split('|').map(p => p.trim());
                const postTitle = parts[0] || '';
                const postContent = parts[1] || '';
                const postTags = (parts[2] || '').match(/#(\S+)/g)?.map(t => t.replace('#', '')) || [];

                console.log(`📕 [XHS] AI要发小红书:`, postTitle);
                setXhsStatus(`正在发布小红书: ${postTitle}...`);

                try {
                    const result = await xhsPublish(xhsConf, postTitle, postContent, postTags);
                    if (result.success) {
                        console.log('📕 [XHS] 发布成功:', result.noteId);
                        const tagsStr = postTags.length > 0 ? ` #${postTags.join(' #')}` : '';
                        await DB.saveMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: `📕 ${char.name}发了一条小红书「${postTitle}」\n${postContent.slice(0, 200)}${postContent.length > 200 ? '...' : ''}${tagsStr}`
                        });
                        addToast(`📕 ${char.name}发了一条小红书!`, 'success');
                    } else {
                        console.error('📕 [XHS] 发布失败:', result.message);
                        addToast(`小红书发布失败: ${result.message}`, 'error');
                    }
                } catch (e) {
                    console.error('📕 [XHS] 发布异常:', e);
                }
                aiContent = aiContent.replace(xhsPostMatch[0], '').trim();
                setXhsStatus('');
            } else if (xhsPostMatch) {
                aiContent = aiContent.replace(xhsPostMatch[0], '').trim();
            }
            aiContent = aiContent.replace(/\[\[XHS_POST:.*?\]\]/gs, '').trim();

            // [[XHS_COMMENT: noteId | 评论内容]] - 评论小红书笔记
            const xhsCommentMatch = aiContent.match(/\[\[XHS_COMMENT:\s*(.+?)\]\]/);
            if (xhsCommentMatch && xhsConf.enabled) {
                const commentRaw = xhsCommentMatch[1].trim();
                const sepIdx = commentRaw.indexOf('|');
                if (sepIdx > 0) {
                    const noteId = commentRaw.slice(0, sepIdx).trim();
                    const commentContent = commentRaw.slice(sepIdx + 1).trim();
                    // 从最近的搜索/浏览结果中查找 xsecToken
                    const xsecToken = findXsecToken(noteId, lastXhsNotes);
                    console.log(`📕 [XHS] AI要评论笔记:`, noteId, commentContent.slice(0, 30), xsecToken ? '(有xsecToken)' : '(无xsecToken)');
                    setXhsStatus('正在评论...');

                    try {
                        const result = await xhsComment(xhsConf, noteId, commentContent, xsecToken);
                        if (result.success) {
                            await DB.saveMessage({
                                charId: char.id,
                                role: 'system',
                                type: 'text',
                                content: `📕 ${char.name}在小红书评论了: "${commentContent.slice(0, 100)}${commentContent.length > 100 ? '...' : ''}"`
                            });
                            addToast(`📕 ${char.name}在小红书留了评论`, 'success');
                        } else {
                            addToast(`评论失败: ${result.message}`, 'error');
                        }
                    } catch (e) {
                        console.error('📕 [XHS] 评论异常:', e);
                    }
                }
                aiContent = aiContent.replace(xhsCommentMatch[0], '').trim();
                setXhsStatus('');
            } else if (xhsCommentMatch) {
                aiContent = aiContent.replace(xhsCommentMatch[0], '').trim();
            }
            aiContent = aiContent.replace(/\[\[XHS_COMMENT:.*?\]\]/g, '').trim();

            // [[XHS_REPLY: noteId | commentId | 回复内容]] - 回复评论
            // ⚠️ REPLY 必须在 LIKE/FAV 之前执行，因为 like_feed 会导航到帖子页面，
            // 改变 MCP 浏览器状态，导致 reply_comment_in_feed 找不到评论
            const xhsReplyMatch = aiContent.match(/\[\[XHS_REPLY:\s*(.+?)\]\]/);
            if (xhsReplyMatch && xhsConf.enabled) {
                const parts = xhsReplyMatch[1].split('|').map(s => s.trim());
                if (parts.length >= 3) {
                    const [noteId, commentId, ...replyParts] = parts;
                    const replyContent = replyParts.join('|').trim();
                    const xsecToken = findXsecToken(noteId, lastXhsNotes);
                    const commentUserId = commentUserIdCacheRef.current.get(commentId);
                    const commentAuthorName = commentAuthorNameCacheRef.current.get(commentId);
                    const parentCommentId = commentParentIdCacheRef.current.get(commentId);
                    if (replyContent) {
                        console.log(`📕 [XHS] AI要回复评论:`, noteId, commentId, replyContent.slice(0, 30),
                            xsecToken ? '(有xsecToken)' : '(bridge自动获取)',
                            commentUserId ? `(userId=${commentUserId})` : '(无userId)',
                            commentAuthorName ? `(author=${commentAuthorName})` : '',
                            parentCommentId ? `(parentId=${parentCommentId})` : '(顶级评论)');
                        setXhsStatus('正在回复评论...');
                        try {
                            let result = await xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId);
                            // "未找到评论" = MCP 服务端 DOM 选择器对不上小红书页面结构（已知 bug），重试无意义
                            const selectorBroken = !result.success && result.message?.includes('未找到评论');
                            if (selectorBroken) {
                                console.warn(`📕 [XHS] 回复失败(DOM选择器不匹配)，跳过重试直接降级:`, result.message);
                            } else {
                                // 其他错误（网络/加载慢等）可以重试
                                const replyRetries = [3000, 4000, 5000];
                                for (let i = 0; i < replyRetries.length && !result.success; i++) {
                                    console.warn(`📕 [XHS] 回复失败(${i+1}/${replyRetries.length})，${replyRetries[i]/1000}秒后重试:`, result.message);
                                    await new Promise(r => setTimeout(r, replyRetries[i]));
                                    result = await xhsReplyComment(xhsConf, noteId, xsecToken, replyContent, commentId, commentUserId, parentCommentId);
                                }
                            }
                            if (result.success) {
                                addToast(`📕 ${char.name}回复了一条评论`, 'success');
                            } else {
                                // 降级为顶级评论（带 @mention 保留回复上下文）
                                console.warn(`📕 [XHS] 回复失败，降级为 @提及 评论:`, result.message);
                                const fallbackContent = commentAuthorName
                                    ? `@${commentAuthorName} ${replyContent}`
                                    : replyContent;
                                let fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken);
                                if (!fallback.success) {
                                    console.warn(`📕 [XHS] 顶级评论也失败，3秒后重试:`, fallback.message);
                                    await new Promise(r => setTimeout(r, 3000));
                                    fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken);
                                }
                                if (fallback.success) {
                                    addToast(`📕 ${char.name}评论了一条笔记（@提及回复）`, 'success');
                                } else {
                                    addToast(`回复失败: ${result.message}`, 'error');
                                }
                            }
                        } catch (e) { console.error('📕 [XHS] 回复异常:', e); }
                        setXhsStatus('');
                    } else {
                        console.warn('📕 [XHS] 回复缺少 xsecToken 或内容');
                    }
                }
                aiContent = aiContent.replace(xhsReplyMatch[0], '').trim();
            } else if (xhsReplyMatch) {
                aiContent = aiContent.replace(xhsReplyMatch[0], '').trim();
            }
            aiContent = aiContent.replace(/\[\[XHS_REPLY:.*?\]\]/g, '').trim();

            // [[XHS_LIKE: noteId]] - 点赞笔记
            // Bridge 会自动获取缺失的 xsecToken，前端不再阻止
            const xhsLikeMatches = aiContent.matchAll(/\[\[XHS_LIKE:\s*(.+?)\]\]/g);
            for (const xhsLikeMatch of xhsLikeMatches) {
                if (xhsConf.enabled) {
                    const noteId = xhsLikeMatch[1].trim();
                    const xsecToken = findXsecToken(noteId, lastXhsNotes);
                    console.log(`📕 [XHS] AI要点赞笔记:`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自动获取)');
                    try {
                        const result = await xhsLike(xhsConf, noteId, xsecToken || '');
                        if (result.success) {
                            addToast(`📕 ${char.name}点赞了一条笔记`, 'success');
                        } else {
                            console.warn('📕 [XHS] 点赞失败:', result.message);
                        }
                    } catch (e) { console.error('📕 [XHS] 点赞异常:', e); }
                }
            }
            aiContent = aiContent.replace(/\[\[XHS_LIKE:.*?\]\]/g, '').trim();

            // [[XHS_FAV: noteId]] - 收藏笔记
            const xhsFavMatches = aiContent.matchAll(/\[\[XHS_FAV:\s*(.+?)\]\]/g);
            for (const xhsFavMatch of xhsFavMatches) {
                if (xhsConf.enabled) {
                    const noteId = xhsFavMatch[1].trim();
                    const xsecToken = findXsecToken(noteId, lastXhsNotes);
                    console.log(`📕 [XHS] AI要收藏笔记:`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自动获取)');
                    try {
                        const result = await xhsFavorite(xhsConf, noteId, xsecToken || '');
                        if (result.success) {
                            addToast(`📕 ${char.name}收藏了一条笔记`, 'success');
                        } else {
                            console.warn('📕 [XHS] 收藏失败:', result.message);
                        }
                    } catch (e) { console.error('📕 [XHS] 收藏异常:', e); }
                }
            }
            aiContent = aiContent.replace(/\[\[XHS_FAV:.*?\]\]/g, '').trim();

            // [[XHS_MY_PROFILE]] - 查看自己的小红书主页
            const xhsProfileMatch = aiContent.match(/\[\[XHS_MY_PROFILE\]\]/);
            if (xhsProfileMatch && xhsConf.enabled) {
                console.log(`📕 [XHS] AI要查看自己的主页`);
                setXhsStatus('正在查看小红书主页...');

                try {
                    const nickname = xhsConf.loggedInNickname || '';
                    const userId = xhsConf.loggedInUserId || '';

                    let profileStr = '';
                    let feedsStr = '（获取笔记失败）';
                    let gotProfile = false;

                    // 方法1: 如果有 userId，用 getUserProfile 获取主页（最准确）
                    if (userId) {
                        console.log(`📕 [XHS] 用 getUserProfile(${userId}) 获取主页...`);
                        setXhsStatus('正在获取主页信息...');
                        try {
                            const profileResult = await XhsMcpClient.getUserProfile(xhsConf.mcpUrl, userId, xhsConf.userXsecToken);
                            if (profileResult.success && profileResult.data) {
                                const d = profileResult.data;
                                if (typeof d === 'string') {
                                    profileStr = d.slice(0, 3000);
                                    gotProfile = true;
                                } else {
                                    // 只用 basic_info 作为 profileStr，避免整个 JSON 被截断
                                    const basicInfo = d.data?.basic_info || d.basic_info;
                                    if (basicInfo) {
                                        profileStr = JSON.stringify(basicInfo, null, 2).slice(0, 2000);
                                    } else {
                                        // basicInfo 为空时，只提取非笔记字段，避免把 notes 数组塞进 profileStr
                                        const { notes: _n, ...rest } = (d.data && typeof d.data === 'object' ? d.data : d) as any;
                                        profileStr = Object.keys(rest).length > 0
                                            ? JSON.stringify(rest, null, 2).slice(0, 2000)
                                            : '（主页基本信息暂时无法获取）';
                                    }
                                    gotProfile = true;
                                    // 尝试从 profile 结果中提取笔记列表
                                    // Bridge 模式返回 { code: 0, data: { notes, basic_info } }，需要解包
                                    const unwrapped = d.data && typeof d.data === 'object' && !Array.isArray(d.data) ? d.data : d;
                                    console.log(`📕 [XHS] profile unwrapped keys:`, Object.keys(unwrapped), 'notes isArray:', Array.isArray(unwrapped.notes), 'notes length:', unwrapped.notes?.length);
                                    const notes = extractNotesFromMcpData(unwrapped);
                                    console.log(`📕 [XHS] extractNotesFromMcpData 返回 ${notes.length} 条笔记`);
                                    if (notes.length > 0) {
                                        // 打印第一条笔记的原始结构帮助调试
                                        console.log(`📕 [XHS] 第一条笔记原始 keys:`, Object.keys(notes[0]), 'noteCard?', !!notes[0].noteCard, 'id?', notes[0].id || notes[0].noteId);
                                        const normalized = notes.map(n => normalizeNote(n) as XhsNote);
                                        console.log(`📕 [XHS] 归一化后第一条:`, JSON.stringify(normalized[0]).slice(0, 300));
                                        // 检查归一化结果是否有效（noteId 非空）
                                        const validNotes = normalized.filter(n => n.noteId);
                                        if (validNotes.length === 0) {
                                            console.warn(`📕 [XHS] ⚠️ 所有笔记归一化后 noteId 为空！原始数据:`, JSON.stringify(notes[0]).slice(0, 500));
                                        }
                                        lastXhsNotes = validNotes.length > 0 ? validNotes : normalized;
                                        cacheXsecTokens(lastXhsNotes);
                                        feedsStr = lastXhsNotes.slice(0, 8).map((n, i) =>
                                            `${i + 1}. [noteId=${n.noteId}]「${n.title || '无标题'}」by ${n.author || '未知'} (${n.likes || 0}赞)\n   ${n.desc || '（无描述）'}`
                                        ).join('\n\n');
                                        console.log(`📕 [XHS] feedsStr 预览:`, feedsStr.slice(0, 300));
                                    } else {
                                        console.warn(`📕 [XHS] ⚠️ extractNotesFromMcpData 返回空数组! unwrapped:`, JSON.stringify(unwrapped).slice(0, 500));
                                    }
                                }
                                console.log(`📕 [XHS] getUserProfile 成功，数据长度: ${profileStr.length}`);
                            }
                        } catch (e) {
                            console.warn('📕 [XHS] getUserProfile 失败，降级到搜索:', e);
                        }
                    }

                    // 方法2: 降级 — 用昵称搜索
                    if (!gotProfile && nickname) {
                        console.log(`📕 [XHS] 降级: 用昵称「${nickname}」搜索...`);
                        setXhsStatus('正在搜索你的笔记...');
                        const searchResult = await xhsSearch(xhsConf, nickname);
                        if (searchResult.success && searchResult.notes.length > 0) {
                            lastXhsNotes = searchResult.notes;
                            cacheXsecTokens(searchResult.notes);
                            feedsStr = searchResult.notes.slice(0, 8).map((n, i) =>
                                `${i + 1}. [noteId=${n.noteId}]「${n.title}」by ${n.author} (${n.likes}赞)\n   ${n.desc || '（无描述）'}`
                            ).join('\n\n');
                        } else {
                            feedsStr = '（没有搜到相关笔记）';
                        }
                    }

                    if (!nickname && !userId) {
                        console.warn('📕 [XHS] 无昵称也无userId，无法查看主页。请在设置中填写。');
                        feedsStr = '（无法获取主页：请在设置-小红书中填写你的昵称或用户ID）';
                    }

                    const profileSection = gotProfile
                        ? `\n\n你的主页信息:\n${profileStr}`
                        : '';

                    const cleanedForXhs = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim() || '让我看看我的小红书...';
                    const xhsMessages = [
                        ...fullMessages,
                        { role: 'assistant', content: cleanedForXhs },
                        { role: 'user', content: `[系统: 你打开了自己的小红书]\n\n你的小红书账号昵称: ${nickname || '未知'}${userId ? ` (userId: ${userId})` : ''}${profileSection}\n\n${gotProfile ? '你的笔记' : `搜索「${nickname}」找到的相关笔记`}:\n${feedsStr}\n\n[系统: ${gotProfile ? '以上是你的主页数据。' : '注意，搜索结果可能包含别人的帖子，你需要辨别哪些是你自己发的（看作者名字）。'}现在请你：\n1. 自然地聊聊你看到了什么，"我看了看我的小红书..."、"我之前发的那个帖子..."\n2. 如果想发新笔记，可以用 [[XHS_POST: 标题 | 内容 | #标签1 #标签2]]\n3. 如果想看某条笔记的详细内容，可以用 [[XHS_DETAIL: noteId]]\n4. 严禁再输出[[XHS_MY_PROFILE]]标记]` }
                    ];

                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, stream: false })
                    });
                    updateTokenUsage(data, historyMsgCount, 'xhs-profile');
                    aiContent = data.choices?.[0]?.message?.content || '';
                    aiContent = normalizeAiContent(aiContent);
                    addToast(`📕 ${char.name}看了看自己的小红书`, 'info');
                } catch (e) {
                    console.error('📕 [XHS] 查看主页异常:', e);
                    aiContent = aiContent.replace(xhsProfileMatch[0], '').trim();
                }
                setXhsStatus('');
            } else if (xhsProfileMatch) {
                aiContent = aiContent.replace(xhsProfileMatch[0], '').trim();
            }
            aiContent = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim();

            // [[XHS_DETAIL: noteId]] - 查看笔记详情（含正文和评论）
            const xhsDetailMatch = aiContent.match(/\[\[XHS_DETAIL:\s*(.+?)\]\]/);
            if (xhsDetailMatch && xhsConf.enabled) {
                const noteId = xhsDetailMatch[1].trim();
                let xsecToken = findXsecToken(noteId, lastXhsNotes);
                console.log(`📕 [XHS] AI要查看笔记详情:`, noteId, xsecToken ? '(有xsecToken)' : '(无xsecToken)');
                setXhsStatus('正在查看笔记详情...');

                try {
                    let result = await XhsMcpClient.getNoteDetail(xhsConf.mcpUrl, noteId, xsecToken, { loadAllComments: true });

                    // 如果失败（通常是 xsec_token 过期导致 noteDetailMap 找不到），尝试重新搜索拿新 token
                    if (!result.success || !result.data) {
                        const cachedTitle = noteTitleCacheRef.current.get(noteId);
                        if (cachedTitle) {
                            console.log(`📕 [XHS] 详情失败，尝试重新搜索「${cachedTitle}」以刷新 xsecToken...`);
                            setXhsStatus('正在刷新访问凭证...');
                            const refreshResult = await xhsSearch(xhsConf, cachedTitle);
                            if (refreshResult.success && refreshResult.notes.length > 0) {
                                cacheXsecTokens(refreshResult.notes);
                                lastXhsNotes = refreshResult.notes;
                                // 在新结果中查找同一篇笔记
                                const refreshedNote = refreshResult.notes.find(n => n.noteId === noteId);
                                if (refreshedNote?.xsecToken) {
                                    xsecToken = refreshedNote.xsecToken;
                                    console.log(`📕 [XHS] 拿到新 xsecToken，重试 detail...`);
                                    setXhsStatus('正在查看笔记详情...');
                                    result = await XhsMcpClient.getNoteDetail(xhsConf.mcpUrl, noteId, xsecToken, { loadAllComments: true });
                                } else {
                                    console.warn(`📕 [XHS] 重新搜索结果中未找到 noteId=${noteId}`);
                                }
                            } else {
                                console.warn(`📕 [XHS] 重新搜索「${cachedTitle}」失败:`, refreshResult.message);
                            }
                        } else {
                            console.warn(`📕 [XHS] 详情失败且无缓存标题，无法重试`);
                        }
                    }

                    // 从 detail 数据中缓存 xsecToken（CDP fallback 的 noteDetailMap 里含有 xsecToken）
                    if (result.success && result.data && typeof result.data === 'object') {
                        const d = result.data;
                        const noteObj = d.note || d;
                        const detailToken = noteObj?.xsecToken || noteObj?.xsec_token || d?.xsecToken;
                        if (detailToken && noteId) {
                            xsecTokenCacheRef.current.set(noteId, detailToken);
                            console.log(`📕 [XHS] 从 detail 缓存 xsecToken: ${noteId}`);
                        }
                    }

                    // 从 detail 数据中缓存 commentId → userId/authorName/parentId，供 reply_comment 使用
                    if (result.success && result.data && typeof result.data === 'object') {
                        const cacheComments = (comments: any[], parentId?: string) => {
                            for (const c of comments) {
                                const cid = c.id || c.commentId || c.comment_id;
                                const uid = c.userInfo?.userId || c.userInfo?.user_id || c.user_id || c.userId;
                                const authorName = c.userInfo?.nickname || c.userInfo?.name || c.nickname || c.userName || c.user_name;
                                if (cid && uid) {
                                    commentUserIdCacheRef.current.set(cid, uid);
                                }
                                if (cid && authorName) {
                                    commentAuthorNameCacheRef.current.set(cid, authorName);
                                }
                                if (cid && parentId) {
                                    commentParentIdCacheRef.current.set(cid, parentId);
                                }
                                // 子评论（传递当前评论 id 作为 parentId）
                                if (Array.isArray(c.subComments)) cacheComments(c.subComments, cid);
                                if (Array.isArray(c.sub_comments)) cacheComments(c.sub_comments, cid);
                            }
                        };
                        const d = result.data;
                        // 兼容多种评论数据路径：顶层 comments / note.comments / 嵌套 data.comments
                        const commentList = d.data?.comments?.list || d.comments?.list
                            || d.data?.comments || d.comments
                            || d.note?.comments?.list || d.note?.comments;
                        if (Array.isArray(commentList)) {
                            cacheComments(commentList);
                            console.log(`📕 [XHS] 缓存了 ${commentUserIdCacheRef.current.size} 条评论的 userId, ${commentAuthorNameCacheRef.current.size} 条 authorName`);
                        } else {
                            console.warn(`📕 [XHS] 未找到评论数组, d keys:`, Object.keys(d), 'd.note keys:', d.note ? Object.keys(d.note) : 'N/A');
                        }
                    }

                    // 无论成功还是失败，都给 AI 反馈，让它自然地回应
                    const detailData = result.success ? result.data : null;
                    let detailStr: string;
                    if (detailData) {
                        if (typeof detailData === 'string') {
                            if (detailData.includes('失败') || detailData.includes('not found')) {
                                detailStr = `[加载失败: ${detailData.slice(0, 200)}]`;
                            } else {
                                detailStr = detailData.slice(0, 5000);
                            }
                        } else {
                            // 智能格式化：笔记摘要 + 完整评论区，避免被截断
                            // MCP 服务器返回数据可能嵌套在 data 层下: { data: { note: {...}, comments: { list: [...] } } }
                            const innerData = (detailData as any).data && typeof (detailData as any).data === 'object' ? (detailData as any).data : null;
                            const note = innerData?.note || (detailData as any).note || detailData;
                            const noteTitle = note.title || note.displayTitle || note.display_title || '';
                            const noteDesc = (note.desc || note.description || note.content || '').slice(0, 1500);
                            const noteAuthor = note.user?.nickname || note.author || '';
                            const noteLikes = note.interactInfo?.likedCount || note.likes || 0;
                            const noteCollects = note.interactInfo?.collectedCount || note.collects || 0;
                            const noteShareCount = note.interactInfo?.shareCount || 0;
                            const noteCommentCount = note.interactInfo?.commentCount || 0;
                            const noteTime = note.time ? new Date(note.time).toLocaleString('zh-CN') : '';
                            const noteIp = note.ipLocation || '';

                            let noteSection = `📝 笔记详情:\n标题: ${noteTitle}\n作者: ${noteAuthor}`;
                            if (noteTime) noteSection += `\n发布时间: ${noteTime}`;
                            if (noteIp) noteSection += `\n IP: ${noteIp}`;
                            noteSection += `\n互动: ${noteLikes}赞 ${noteCollects}收藏 ${noteCommentCount}评论 ${noteShareCount}分享`;
                            noteSection += `\n\n正文:\n${noteDesc}`;

                            // 提取评论（兼容多种路径，包括 MCP 服务器的 data.comments.list 嵌套）
                            const rawComments = innerData?.comments?.list || innerData?.comments
                                || (detailData as any).comments?.list || (detailData as any).comments
                                || note.comments?.list || note.comments || [];
                            const commentArr = Array.isArray(rawComments) ? rawComments : [];

                            let commentsSection = '';
                            if (commentArr.length > 0) {
                                const formatComment = (c: any, indent = '') => {
                                    const name = c.userInfo?.nickname || c.nickname || c.userName || '匿名';
                                    const content = c.content || '';
                                    const likes = c.likeCount || c.like_count || c.likes || 0;
                                    const cid = c.id || c.commentId || c.comment_id || '';
                                    let line = `${indent}${name}: ${content} (${likes}赞) [commentId=${cid}]`;
                                    const subs = c.subComments || c.sub_comments || [];
                                    if (Array.isArray(subs) && subs.length > 0) {
                                        line += '\n' + subs.slice(0, 10).map((s: any) => formatComment(s, indent + '  ↳ ')).join('\n');
                                    }
                                    return line;
                                };
                                commentsSection = `\n\n💬 评论区 (${commentArr.length}条):\n` +
                                    commentArr.slice(0, 30).map((c: any) => formatComment(c)).join('\n');
                            } else {
                                commentsSection = '\n\n💬 评论区: （暂无评论）';
                            }

                            detailStr = (noteSection + commentsSection).slice(0, 8000);
                        }
                    } else {
                        detailStr = `[加载失败: ${result.error || '无法获取笔记详情，可能需要先在搜索/浏览结果中看到这条笔记'}]`;
                    }

                    const detailFailed = detailStr.startsWith('[加载失败');
                    const cleanedForXhs = aiContent.replace(/\[\[XHS_DETAIL:.*?\]\]/g, '').trim() || '让我看看这条笔记...';
                    const xhsMessages = [
                        ...fullMessages,
                        { role: 'assistant', content: cleanedForXhs },
                        { role: 'user', content: detailFailed
                            ? `[系统: 你尝试打开一条小红书笔记（noteId=${noteId}），但加载失败了]\n\n${detailStr}\n\n[系统: 笔记详情页加载失败了。可能的原因：这条笔记需要先通过搜索或浏览才能打开详情。现在请你：\n1. 自然地告知用户"这条笔记打不开/加载不出来"\n2. 可以建议搜索相关关键词再试: [[XHS_SEARCH: 关键词]]\n3. 严禁再输出[[XHS_DETAIL:...]]标记]`
                            : `[系统: 你点开了一条小红书笔记的详情页（noteId=${noteId}）]\n\n${detailStr}\n\n[系统: 你已经看完了这条笔记的完整内容和评论区。现在请你：\n1. 自然地分享你看到的内容和感受\n2. 如果想评论这条笔记，可以用 [[XHS_COMMENT: ${noteId} | 评论内容]]\n3. 如果想回复某条评论，可以用 [[XHS_REPLY: ${noteId} | commentId | 回复内容]]（commentId 在上面的评论区数据里）\n4. 如果想点赞，可以用 [[XHS_LIKE: ${noteId}]]；想收藏可以用 [[XHS_FAV: ${noteId}]]\n5. 严禁再输出[[XHS_DETAIL:...]]标记]` }
                    ];

                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, stream: false })
                    });
                    updateTokenUsage(data, historyMsgCount, 'xhs-detail');
                    aiContent = data.choices?.[0]?.message?.content || '';
                    aiContent = normalizeAiContent(aiContent);
                    addToast(`📕 ${char.name}${detailFailed ? '尝试查看一条笔记（加载失败）' : '看了一条笔记的详情'}`, 'info');
                } catch (e) {
                    console.error('📕 [XHS] 查看详情异常:', e);
                    aiContent = aiContent.replace(xhsDetailMatch[0], '').trim();
                }
                setXhsStatus('');
            } else if (xhsDetailMatch) {
                aiContent = aiContent.replace(xhsDetailMatch[0], '').trim();
            }
            aiContent = aiContent.replace(/\[\[XHS_DETAIL:.*?\]\]/g, '').trim();

            // 5.10.1 Second-round XHS action processing
            // After [[XHS_DETAIL]] (and [[XHS_MY_PROFILE]]) the AI generates new aiContent
            // that may contain COMMENT / LIKE / FAV / REPLY / POST tags.
            // These were already checked above but the aiContent was different back then,
            // so we must re-check here.

            // [[XHS_COMMENT: noteId | 评论内容]] (second round)
            const xhsCommentMatch2 = aiContent.match(/\[\[XHS_COMMENT:\s*(.+?)\]\]/);
            if (xhsCommentMatch2 && xhsConf.enabled) {
                const commentRaw = xhsCommentMatch2[1].trim();
                const sepIdx = commentRaw.indexOf('|');
                if (sepIdx > 0) {
                    const noteId = commentRaw.slice(0, sepIdx).trim();
                    const commentContent = commentRaw.slice(sepIdx + 1).trim();
                    const xsecToken = findXsecToken(noteId, lastXhsNotes);
                    console.log(`📕 [XHS] AI要评论笔记(detail后):`, noteId, commentContent.slice(0, 30), xsecToken ? '(有xsecToken)' : '(无xsecToken)');
                    setXhsStatus('正在评论...');
                    try {
                        const result = await xhsComment(xhsConf, noteId, commentContent, xsecToken);
                        if (result.success) {
                            await DB.saveMessage({
                                charId: char.id,
                                role: 'system',
                                type: 'text',
                                content: `📕 ${char.name}在小红书评论了: "${commentContent.slice(0, 100)}${commentContent.length > 100 ? '...' : ''}"`
                            });
                            addToast(`📕 ${char.name}在小红书留了评论`, 'success');
                        } else {
                            addToast(`评论失败: ${result.message}`, 'error');
                        }
                    } catch (e) {
                        console.error('📕 [XHS] 评论异常(detail后):', e);
                    }
                }
                setXhsStatus('');
            }
            aiContent = aiContent.replace(/\[\[XHS_COMMENT:.*?\]\]/g, '').trim();

            // [[XHS_REPLY: noteId | commentId | 回复内容]] (second round)
            // ⚠️ REPLY 必须在 LIKE/FAV 之前执行，因为 like_feed 会导航到帖子页面，
            // 改变 MCP 浏览器状态，导致 reply_comment_in_feed 找不到评论
            const xhsReplyMatch2 = aiContent.match(/\[\[XHS_REPLY:\s*(.+?)\]\]/);
            if (xhsReplyMatch2 && xhsConf.enabled) {
                const parts = xhsReplyMatch2[1].split('|').map(s => s.trim());
                if (parts.length >= 3) {
                    const [noteId, commentId, ...replyParts] = parts;
                    const replyContent = replyParts.join('|').trim();
                    const xsecToken = findXsecToken(noteId, lastXhsNotes);
                    const commentUserId = commentUserIdCacheRef.current.get(commentId);
                    const commentAuthorName = commentAuthorNameCacheRef.current.get(commentId);
                    const parentCommentId = commentParentIdCacheRef.current.get(commentId);
                    if (replyContent) {
                        console.log(`📕 [XHS] AI要回复评论(detail后):`, noteId, commentId, replyContent.slice(0, 30),
                            commentUserId ? `(userId=${commentUserId})` : '(无userId)',
                            commentAuthorName ? `(author=${commentAuthorName})` : '',
                            parentCommentId ? `(parentId=${parentCommentId})` : '(顶级评论)',
                            xsecToken ? '(有xsecToken)' : '(bridge自动获取)');
                        setXhsStatus('正在回复评论...');
                        try {
                            let result = await xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId);
                            // "未找到评论" = MCP 服务端 DOM 选择器对不上小红书页面结构（已知 bug），重试无意义
                            const selectorBroken = !result.success && result.message?.includes('未找到评论');
                            if (selectorBroken) {
                                console.warn(`📕 [XHS] 回复失败(detail后)(DOM选择器不匹配)，跳过重试直接降级:`, result.message);
                            } else {
                                // 其他错误（网络/加载慢等）可以重试
                                const replyRetries = [3000, 4000, 5000];
                                for (let i = 0; i < replyRetries.length && !result.success; i++) {
                                    console.warn(`📕 [XHS] 回复失败(detail后)(${i+1}/${replyRetries.length})，${replyRetries[i]/1000}秒后重试:`, result.message);
                                    await new Promise(r => setTimeout(r, replyRetries[i]));
                                    result = await xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId);
                                }
                            }
                            if (result.success) {
                                addToast(`📕 ${char.name}回复了一条评论`, 'success');
                            } else {
                                // 降级为顶级评论（带 @mention 保留回复上下文）
                                console.warn(`📕 [XHS] 回复失败(detail后)，降级为 @提及 评论:`, result.message);
                                const fallbackContent = commentAuthorName
                                    ? `@${commentAuthorName} ${replyContent}`
                                    : replyContent;
                                let fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken || '');
                                if (!fallback.success) {
                                    console.warn(`📕 [XHS] 顶级评论也失败(detail后)，3秒后重试:`, fallback.message);
                                    await new Promise(r => setTimeout(r, 3000));
                                    fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken);
                                }
                                if (fallback.success) {
                                    addToast(`📕 ${char.name}评论了一条笔记（@提及回复）`, 'success');
                                } else {
                                    addToast(`回复失败: ${result.message}`, 'error');
                                }
                            }
                        } catch (e) { console.error('📕 [XHS] 回复异常(detail后):', e); }
                        setXhsStatus('');
                    } else {
                        console.warn('📕 [XHS] 回复缺少 xsecToken 或内容(detail后)');
                    }
                }
            }
            aiContent = aiContent.replace(/\[\[XHS_REPLY:.*?\]\]/g, '').trim();

            // [[XHS_LIKE: noteId]] (second round)
            // Bridge 会自动获取缺失的 xsecToken，前端不再阻止
            const xhsLikeMatches2 = aiContent.matchAll(/\[\[XHS_LIKE:\s*(.+?)\]\]/g);
            for (const xhsLikeMatch of xhsLikeMatches2) {
                if (xhsConf.enabled) {
                    const noteId = xhsLikeMatch[1].trim();
                    const xsecToken = findXsecToken(noteId, lastXhsNotes);
                    console.log(`📕 [XHS] AI要点赞笔记(detail后):`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自动获取)');
                    try {
                        const result = await xhsLike(xhsConf, noteId, xsecToken || '');
                        if (result.success) {
                            addToast(`📕 ${char.name}点赞了一条笔记`, 'success');
                        } else {
                            console.warn('📕 [XHS] 点赞失败(detail后):', result.message);
                        }
                    } catch (e) { console.error('📕 [XHS] 点赞异常(detail后):', e); }
                }
            }
            aiContent = aiContent.replace(/\[\[XHS_LIKE:.*?\]\]/g, '').trim();

            // [[XHS_FAV: noteId]] (second round)
            const xhsFavMatches2 = aiContent.matchAll(/\[\[XHS_FAV:\s*(.+?)\]\]/g);
            for (const xhsFavMatch of xhsFavMatches2) {
                if (xhsConf.enabled) {
                    const noteId = xhsFavMatch[1].trim();
                    const xsecToken = findXsecToken(noteId, lastXhsNotes);
                    console.log(`📕 [XHS] AI要收藏笔记(detail后):`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自动获取)');
                    try {
                        const result = await xhsFavorite(xhsConf, noteId, xsecToken || '');
                        if (result.success) {
                            addToast(`📕 ${char.name}收藏了一条笔记`, 'success');
                        } else {
                            console.warn('📕 [XHS] 收藏失败(detail后):', result.message);
                        }
                    } catch (e) { console.error('📕 [XHS] 收藏异常(detail后):', e); }
                }
            }
            aiContent = aiContent.replace(/\[\[XHS_FAV:.*?\]\]/g, '').trim();

            // [[XHS_POST: 标题 | 内容 | #标签1 #标签2]] (second round - after MY_PROFILE)
            const xhsPostMatch2 = aiContent.match(/\[\[XHS_POST:\s*(.+?)\]\]/s);
            if (xhsPostMatch2 && xhsConf.enabled) {
                const postRaw = xhsPostMatch2[1].trim();
                const parts = postRaw.split('|').map(p => p.trim());
                const postTitle = parts[0] || '';
                const postContent = parts[1] || '';
                const postTags = (parts[2] || '').match(/#(\S+)/g)?.map(t => t.replace('#', '')) || [];
                console.log(`📕 [XHS] AI要发小红书(profile后):`, postTitle);
                setXhsStatus(`正在发布小红书: ${postTitle}...`);
                try {
                    const result = await xhsPublish(xhsConf, postTitle, postContent, postTags);
                    if (result.success) {
                        console.log('📕 [XHS] 发布成功(profile后):', result.noteId);
                        const tagsStr = postTags.length > 0 ? ` #${postTags.join(' #')}` : '';
                        await DB.saveMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: `📕 ${char.name}发了一条小红书「${postTitle}」\n${postContent.slice(0, 200)}${postContent.length > 200 ? '...' : ''}${tagsStr}`
                        });
                        addToast(`📕 ${char.name}发了一条小红书!`, 'success');
                    } else {
                        console.error('📕 [XHS] 发布失败(profile后):', result.message);
                        addToast(`小红书发布失败: ${result.message}`, 'error');
                    }
                } catch (e) {
                    console.error('📕 [XHS] 发布异常(profile后):', e);
                }
                setXhsStatus('');
            }
            aiContent = aiContent.replace(/\[\[XHS_POST:.*?\]\]/gs, '').trim();

            // 6. Parse Actions (Poke, Transfer, Schedule, etc.)
            aiContent = await ChatParser.parseAndExecuteActions(aiContent, char.id, char.name, addToast);

            // 7. Handle Quote/Reply Logic (Robust: handles [[QUOTE:...]], [QUOTE:...], typos like QUATE/QOUTE, Chinese 引用, and [回复 "..."] format)
            const QUOTE_RE_DOUBLE = /\[\[(?:QU[OA]TE|引用)[：:]\s*([\s\S]*?)\]\]/;
            const QUOTE_RE_SINGLE = /\[(?:QU[OA]TE|引用)[：:]\s*([^\]]*)\]/;
            // Match [回复 "content"] or [回复 "content"]: (AI mimics history context format)
            const REPLY_RE_CN = /\[回复\s*[""\u201C]([^""\u201D]*?)[""\u201D](?:\.{0,3})\]\s*[：:]?\s*/;
            const QUOTE_CLEAN_DOUBLE = /\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g;
            const QUOTE_CLEAN_SINGLE = /\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g;
            const REPLY_CLEAN_CN = /\[回复\s*[""\u201C][^""\u201D]*?[""\u201D](?:\.{0,3})\]\s*[：:]?\s*/g;
            let aiReplyTarget: { id: number, content: string, name: string } | undefined;
            const firstQuoteMatch = aiContent.match(QUOTE_RE_DOUBLE) || aiContent.match(QUOTE_RE_SINGLE) || aiContent.match(REPLY_RE_CN);
            if (firstQuoteMatch) {
                const quotedText = firstQuoteMatch[1].trim();
                if (quotedText) {
                    // Try exact include first, then fuzzy match (first 10 chars)
                    const targetMsg = historySlice.slice().reverse().find((m: Message) => m.role === 'user' && m.content.includes(quotedText))
                        || (quotedText.length > 10 ? historySlice.slice().reverse().find((m: Message) => m.role === 'user' && m.content.includes(quotedText.slice(0, 10))) : undefined);
                    if (targetMsg) {
                        const truncated = targetMsg.content.length > 10 ? targetMsg.content.slice(0, 10) + '...' : targetMsg.content;
                        aiReplyTarget = { id: targetMsg.id, content: truncated, name: userProfile.name };
                    }
                }
            }
            // Clean all quote tag variants from content
            aiContent = aiContent.replace(QUOTE_CLEAN_DOUBLE, '').replace(QUOTE_CLEAN_SINGLE, '').replace(REPLY_CLEAN_CN, '').trim();

            // 8. Split and Stream (Simulate Typing)
            // Note: SEND_EMOJI tags are preserved through sanitize so splitResponse can interleave them with text

            // Comprehensive AI output sanitization (strips name prefixes, headers, stray backticks, residual tags, etc.)
            aiContent = ChatParser.sanitize(aiContent);

            // Fallback: if second-pass API calls (search/diary) returned empty, provide a minimal response
            if (!aiContent.trim() && (searchMatch || readDiaryMatch || fsReadDiaryMatch)) {
                aiContent = '嗯...';
            }
            if (aiContent) {

                // Check for <翻译> XML tags (new bilingual format)
                const hasTranslationTags = /<翻译>\s*<原文>[\s\S]*?<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/.test(aiContent);

                let globalMsgIndex = 0;

                if (hasTranslationTags) {
                    // ─── New bilingual format: each <翻译> block = one bubble ───
                    // Extract emojis for bilingual path (splitResponse not used here)
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
                        // Save any plain text BEFORE this <翻译> block
                        const textBefore = aiContent.slice(lastIndex, tagMatch.index).trim();
                        if (textBefore) {
                            const cleaned = ChatParser.sanitize(textBefore);
                            if (cleaned && ChatParser.hasDisplayContent(cleaned)) {
                                const chunks = ChatParser.chunkText(cleaned);
                                for (const chunk of chunks) {
                                    if (!chunk) continue;
                                    const replyData = globalMsgIndex === 0 ? aiReplyTarget : undefined;
                                    await new Promise(r => setTimeout(r, Math.min(Math.max(chunk.length * 50, 500), 2000)));
                                    await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: chunk, replyTo: replyData });
                                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                                    globalMsgIndex++;
                                }
                            }
                        }

                        // Save the bilingual pair (stored as langA\n%%BILINGUAL%%\nlangB for renderer compatibility)
                        const originalText = ChatParser.sanitize(tagMatch[1].trim());
                        const translatedText = ChatParser.sanitize(tagMatch[2].trim());
                        if (originalText || translatedText) {
                            const biContent = originalText && translatedText
                                ? `${originalText}\n%%BILINGUAL%%\n${translatedText}`
                                : (originalText || translatedText);
                            const replyData = globalMsgIndex === 0 ? aiReplyTarget : undefined;
                            await new Promise(r => setTimeout(r, Math.min(Math.max(biContent.length * 30, 400), 2000)));
                            await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: biContent, replyTo: replyData });
                            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                            globalMsgIndex++;
                        }

                        lastIndex = tagMatch.index + tagMatch[0].length;
                    }

                    // Save any remaining text AFTER last <翻译> block
                    const textAfter = aiContent.slice(lastIndex).trim();
                    if (textAfter) {
                        // Strip any stray translation tags
                        const cleaned = ChatParser.sanitize(textAfter.replace(/<\/?翻译>|<\/?原文>|<\/?译文>/g, '').trim());
                        if (cleaned && ChatParser.hasDisplayContent(cleaned)) {
                            const chunks = ChatParser.chunkText(cleaned);
                            for (const chunk of chunks) {
                                if (!chunk) continue;
                                const replyData = globalMsgIndex === 0 ? aiReplyTarget : undefined;
                                await new Promise(r => setTimeout(r, Math.min(Math.max(chunk.length * 50, 500), 2000)));
                                await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: chunk, replyTo: replyData });
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                                globalMsgIndex++;
                            }
                        }
                    }

                    // Send extracted emojis after bilingual text
                    for (const emojiName of bilingualEmojis) {
                        const foundEmoji = emojis.find(e => e.name === emojiName);
                        if (foundEmoji) {
                            await new Promise(r => setTimeout(r, Math.random() * 500 + 300));
                            await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'emoji', content: foundEmoji.url });
                            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                        }
                    }
                } else {
                    // ─── Normal text (no bilingual tags) ───
                    // Also handles legacy %%BILINGUAL%% format for backwards compatibility
                    const parts = ChatParser.splitResponse(aiContent);
                    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
                        const part = parts[partIndex];

                        if (part.type === 'emoji') {
                            const foundEmoji = emojis.find(e => e.name === part.content);
                            if (foundEmoji) {
                                await new Promise(r => setTimeout(r, Math.random() * 500 + 300));
                                await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'emoji', content: foundEmoji.url });
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                            }
                        } else {
                            // Split on --- separators first, then chunkText for fine-grained splitting
                            const rawBlocks = part.content.split(/^\s*---\s*$/m).filter(b => b.trim());
                            const allChunks: string[] = [];
                            for (const block of rawBlocks) {
                                allChunks.push(...ChatParser.chunkText(block.trim()));
                            }
                            if (allChunks.length === 0 && part.content.trim()) allChunks.push(part.content.trim());

                            for (let i = 0; i < allChunks.length; i++) {
                                let chunk = allChunks[i];
                                const delay = Math.min(Math.max(chunk.length * 50, 500), 2000);
                                await new Promise(r => setTimeout(r, delay));

                                let chunkReplyTarget: { id: number, content: string, name: string } | undefined;
                                const chunkQuoteMatch = chunk.match(QUOTE_RE_DOUBLE) || chunk.match(QUOTE_RE_SINGLE);
                                if (chunkQuoteMatch) {
                                    const quotedText = chunkQuoteMatch[1].trim();
                                    if (quotedText) {
                                        const targetMsg = historySlice.slice().reverse().find((m: Message) => m.role === 'user' && m.content.includes(quotedText))
                                            || (quotedText.length > 10 ? historySlice.slice().reverse().find((m: Message) => m.role === 'user' && m.content.includes(quotedText.slice(0, 10))) : undefined);
                                        if (targetMsg) {
                                            const truncated = targetMsg.content.length > 10 ? targetMsg.content.slice(0, 10) + '...' : targetMsg.content;
                                            chunkReplyTarget = { id: targetMsg.id, content: truncated, name: userProfile.name };
                                        }
                                    }
                                    chunk = chunk.replace(QUOTE_CLEAN_DOUBLE, '').replace(QUOTE_CLEAN_SINGLE, '').trim();
                                }

                                const replyData = chunkReplyTarget || (globalMsgIndex === 0 ? aiReplyTarget : undefined);

                                if (ChatParser.hasDisplayContent(chunk)) {
                                    const cleanChunk = ChatParser.sanitize(chunk);
                                    if (cleanChunk) {
                                        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: cleanChunk, replyTo: replyData });
                                        setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                                        globalMsgIndex++;
                                    }
                                }
                            }
                        }
                    }
                }

            } else {
                // If content was empty (e.g. only actions), just refresh
                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
            }

        } catch (e: any) {
            await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[连接中断: ${e.message}]` });
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        } finally {
            KeepAlive.stop();
            setIsTyping(false);
            setRecallStatus('');
            setSearchStatus('');
            setDiaryStatus('');
            setXhsStatus('');
        }
    };



    // ─── Proactive Messaging Controls ───
    // NOTE: The actual proactive trigger handler is registered globally in OSContext
    // so it works even when Chat is not open. These are just start/stop helpers.

    const startProactiveChat = (intervalMinutes: number) => {
        if (!char) return;
        ProactiveChat.start(char.id, intervalMinutes);
    };

    const stopProactiveChat = () => {
        if (!char) return;
        ProactiveChat.stop(char.id);
    };

    const isProactiveActive = char ? ProactiveChat.isActiveFor(char.id) : false;

    return {
        isTyping,
        recallStatus,
        searchStatus,
        diaryStatus,
        xhsStatus,
        emotionStatus,
        memoryPalaceStatus,
        lastTokenUsage,
        tokenBreakdown,
        setLastTokenUsage, // Allow manual reset if needed
        triggerAI,
        startProactiveChat,
        stopProactiveChat,
        isProactiveActive
    };
};
