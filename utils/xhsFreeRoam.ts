import { loadCharacterContextMessages } from './chatContextRange';

/**
 * XHS Free Roam Engine — 角色自主小红书活动
 *
 * 流程:
 * 1. 构建角色上下文（身份、最近聊天摘要、上次活动记录）
 * 2. 调用 LLM 让角色决策（我想做什么）
 * 3. 根据决策调用 XHS Client (xiaohongshu-skills) 执行
 * 4. 把结果交给 LLM 让角色反应 / 选择保留的话题
 * 5. 返回完整的活动记录
 */

import { CharacterProfile, UserProfile, XhsActivityRecord, XhsFreeRoamSession, XhsOwnedPost, APIConfig, RealtimeConfig } from '../types';
import { ContextBuilder } from './context';
import { nowInTimeZone, resolveCharTimeZone } from './timezone';
import {
    XhsMcpClient,
    McpToolResult,
    extractNotesFromMcpData,
    normalizeNote,
    normalizeXhsLiteDetail,
} from './xhsMcpClient';
import { DB } from './db';
import {
    collectOwnedPostsFromActivities,
    extractPublishedNoteId,
    mergeOwnedNotes,
    ownedPostToNote,
} from './xhsFreeRoamOwnership';

// ==================== Types ====================

export interface FreeRoamCallbacks {
    onStatus: (status: string) => void;
    onThinking: (text: string) => void;
    onActivity: (activity: XhsActivityRecord) => void;
    onComplete: (session: XhsFreeRoamSession) => void;
    onError: (error: string) => void;
}

interface LlmDecision {
    action: 'post' | 'browse' | 'search' | 'idle' | 'check_profile';
    thinking: string;
    // For post
    title?: string;
    content?: string;
    tags?: string[];
    // For search
    keyword?: string;
}

interface LlmReaction {
    thinking: string;
    savedTopics?: { title: string; desc: string; noteId?: string }[];
    wantToViewDetail?: { noteId: string; title: string };
}

interface LlmDetailReaction {
    thinking: string;
    wantToReply?: { commentId: string; authorName: string; reply: string };
    wantToComment?: { comment: string };
}

type FreeRoamPrompt = { char: CharacterProfile; user: UserProfile; instructions: string };

// ==================== LLM Helpers ====================

const callLlm = async (
    apiConfig: APIConfig,
    systemPrompt: FreeRoamPrompt,
    userMessage: string,
): Promise<string> => {
    const baseUrl = apiConfig.baseUrl.replace(/\/+$/, '');
    const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiConfig.apiKey || 'sk-none'}`,
        },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: (await ContextBuilder.buildCharacterRequest(systemPrompt, [
                { role: 'user', content: userMessage },
            ])),
            temperature: 0.85,
            stream: false,
        }),
        // API 调用记录标签：自由活动是后台任务，不标会被兜底成「用户当时打开的 App」
        __sullyMeta: { appId: 'xhs_free_roam', appName: '自由活动', charId: systemPrompt.char.id, charName: systemPrompt.char.name, purpose: '自由活动生成' },
    } as RequestInit);

    if (!resp.ok) throw new Error(`LLM API ${resp.status}: ${await resp.text().catch(() => '')}`);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
};

const parseJson = <T>(text: string): T | null => {
    // Try to extract JSON from markdown code blocks or raw text
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) return null;
    try {
        return JSON.parse(jsonMatch[1]);
    } catch {
        return null;
    }
};

// ==================== Prompt Builders ====================

export const buildFreeRoamSystemPrompt = (
    char: CharacterProfile,
    user: UserProfile,
    recentChatSummary: string,
    pastActivities: XhsActivityRecord[],
): FreeRoamPrompt => {
    // 加载完整上下文（含详细记忆和心情标签），让角色在自由活动时保持情感连贯

    // 自由活动是角色自己在刷手机，「现在几点」得跟 ta 那边的钟——
    // coreContext 顶部注入的当前时间已按角色时区折算，这里再用设备时间就会自相矛盾。
    const charTz = resolveCharTimeZone(char);
    const now = nowInTimeZone(charTz);
    const timeStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-${now.getDate().toString().padStart(2,'0')} ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
    const hour = now.getHours();
    const timeOfDay = hour < 6 ? '深夜' : hour < 9 ? '清晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';

    let pastStr = '暂无活动记录。';
    if (pastActivities.length > 0) {
        pastStr = pastActivities.slice(-5).map(a => {
            // 历史活动也报角色当地的钟点，跟上面的「现在」同一把尺子
            const d = nowInTimeZone(charTz, new Date(a.timestamp));
            const ts = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${d.getMinutes().toString().padStart(2,'0')}`;
            const actionLabel = { post: '发帖', browse: '刷首页', search: '搜索', comment: '评论', save_topic: '收藏话题', idle: '休息' }[a.actionType];
            return `[${ts}] ${actionLabel}: ${a.content.title || a.content.keyword || a.content.body || '无'} (${a.result})`;
        }).join('\n');
    }

    return { char, user, instructions: `

### 🕐 当前状态
- 现在是: ${timeStr} (${timeOfDay})
- 这是你的"自由活动时间"——你不在和用户聊天，而是在自主使用小红书。
- 像一个真实的人使用社交媒体一样行动。你的行为应该符合你的性格。

### 💬 最近与用户的对话摘要
${recentChatSummary || '最近没有对话记录。'}

### 📕 你之前的小红书活动
${pastStr}

### 📋 重要规则
- 你是一个有自己想法和审美的人。根据你的性格、兴趣和**最近与用户的对话内容**来决定做什么。
- 重要：你的想法和行动应该反映你**当下**的心情和最近的经历，不要沉浸在遥远的回忆里。
- 你可以：
  - **发帖**（分享生活/感想/见闻）
  - **搜索**（感兴趣的话题）
  - **刷首页**（看看有什么有趣的）
  - **查看自己的主页**（看看自己发过的帖子有多少赞了、有没有新评论）
  - **什么都不做**（也完全OK）
- 刷到或搜索到帖子后，你还可以：
  - 查看感兴趣帖子的**详细内容和评论区**
  - 保存有趣的话题
  - **只回复自己帖子评论区的人**
- **⚠️ 评论限制（非常重要）**: 不要在陌生人的帖子下面评论或回复！你只能在**自己发的帖子**的评论区里回复别人。在别人帖子下留言会很奇怪，而且会让真实用户困惑。浏览别人的帖子时，只看不评论。
- **搜索自己的帖子**: 你可以用自己的名字作为关键词搜索，看看自己发过的帖子现在怎么样了。
- 不要每次都发帖，真实的人有时候只是刷刷看看。
- 发的帖子要像你自己会发的东西——符合人设，不要写得太正式或像AI。
- 你可以选择保存一些有趣的帖子内容作为话题，下次和用户聊天时可以提起。` };
};

const buildDecisionPrompt = (): string => {
    return `现在是你的自由活动时间。你想在小红书上做什么？

请用以下JSON格式回答（只返回JSON，不要其他内容）:
\`\`\`json
{
    "action": "post" | "browse" | "search" | "check_profile" | "idle",
    "thinking": "你的内心想法（用第一人称，符合你的性格）",
    "title": "帖子标题（仅 action=post 时）",
    "content": "帖子正文（仅 action=post 时）",
    "tags": ["标签1", "标签2"],
    "keyword": "搜索关键词（仅 action=search 时）"
}
\`\`\`

示例:
- 想发帖: {"action":"post","thinking":"今天天气好好，想分享一下我的心情","title":"阳光真好","content":"窗外的光打在桌上，觉得活着真好。","tags":["日常","心情"]}
- 想搜索: {"action":"search","thinking":"昨天和主人聊到了咖啡，我也想看看","keyword":"手冲咖啡推荐"}
- 想搜索自己的帖子: {"action":"search","thinking":"想看看我之前发的帖子怎么样了","keyword":"你自己的名字或帖子关键词"}
- 想刷首页: {"action":"browse","thinking":"没什么特别想做的，刷刷看有什么好玩的"}
- 想看自己主页: {"action":"check_profile","thinking":"好久没看我的小红书了，不知道之前发的帖子有多少赞了"}
- 不想动: {"action":"idle","thinking":"有点累了，不想刷手机"}`;
};

const buildReactionPrompt = (notes: any[]): string => {
    const notesList = notes.slice(0, 8).map((n: any, i: number) => {
        const noteId = n.noteId || n.note_id || n.id || '';
        return `${i+1}. [noteId=${noteId}]「${n.title || '无标题'}」by ${n.author || n.nickname || '匿名'} — ${(n.desc || n.content || '').slice(0, 150)} (❤️${n.likes || 0})`;
    }).join('\n');

    return `你刚才刷了小红书，看到了这些帖子:

${notesList}

你怎么看这些帖子？有没有你感兴趣的？想留几个作为下次聊天话题吗？想看某个帖子的完整内容和评论区吗？

⚠️ 注意：这些是别人的帖子，不要在别人帖子下评论（会打扰真实用户）。只看、只保存话题就好。如果想查看完整内容可以用 wantToViewDetail。

用JSON回答:
\`\`\`json
{
    "thinking": "你看完之后的想法（第一人称，详细写，包括你对看到的内容的感受和评价）",
    "savedTopics": [{"title": "帖子标题", "desc": "你记住的要点", "noteId": "如果有的话"}],
    "wantToViewDetail": {"noteId": "xxx", "title": "帖子标题"}
}
\`\`\`

如果没什么感兴趣的，savedTopics 可以为空数组。
如果你对某篇帖子特别感兴趣，想看它的完整正文和评论区，可以填 wantToViewDetail。`;
};

const buildDetailReactionPrompt = (
    noteTitle: string,
    noteContent: string,
    comments: any[],
    commentsUnavailable = false,
    canInteract = false,
): string => {
    const commentsList = comments.slice(0, 15).map((c: any, i: number) => {
        const commentId = c.commentId || c.comment_id || c.id || '';
        const author = c.authorName || c.author_name || c.nickname || c.user?.nickname || '匿名';
        const content = c.content || c.text || '';
        const likes = c.likes || c.liked_count || c.likedCount || 0;
        return `${i+1}. [commentId=${commentId}] ${author}: ${content} (${likes}赞)`;
    }).join('\n');

    return `你刚才查看了帖子「${noteTitle}」的详情:

正文: ${noteContent.slice(0, 500)}${noteContent.length > 500 ? '...' : ''}

${comments.length > 0
        ? `真实评论区:\n${commentsList}`
        : commentsUnavailable
            ? '真实评论区本次读取失败。不能据此判断帖子没有评论；不要编造、模拟或回复评论。'
            : '这条帖子还没有评论。'}

你怎么看这条帖子和评论区？

${canInteract
        ? '✅ 系统已通过唯一 note_id 确认：这是你自己发的帖子。你可以回复评论区的人。'
        : '⛔ 系统无法确认这是你自己的帖子。只看不评论，不要填写 wantToReply 或 wantToComment。'}

用JSON回答:
\`\`\`json
{
    "thinking": "你看完详情和评论区后的想法（第一人称）",
    "wantToReply": {"commentId": "xxx", "authorName": "对方昵称", "reply": "你想回复的内容（仅限自己的帖子）"},
    "wantToComment": {"comment": "你想对这条帖子说的评论（仅限自己的帖子）"}
}
\`\`\`

${canInteract
        ? '只回复上方真实评论区里存在的 commentId；不要编造 commentId。'
        : 'wantToReply 和 wantToComment 都不要填。'} `;
};

const buildProfileReactionPrompt = (profileInfo: string, notes: any[]): string => {
    const notesList = notes.slice(0, 8).map((n: any, i: number) => {
        const noteId = n.noteId || n.note_id || n.id || '';
        return `${i+1}. [noteId=${noteId}]「${n.title || '无标题'}」❤️${n.likes || 0} 💬${n.comments || n.comment_count || 0}`;
    }).join('\n');

    return `你刚才查看了自己的小红书主页:

${profileInfo}

${notes.length > 0 ? `你发过的帖子:\n${notesList}` : '你还没有发过帖子。'}

你怎么看自己的主页？有没有想去看看哪条帖子的评论区？

用JSON回答:
\`\`\`json
{
    "thinking": "你看完自己主页后的想法（第一人称，比如对粉丝数/赞数的反应）",
    "wantToViewDetail": {"noteId": "xxx", "title": "帖子标题"}
}
\`\`\`

不想看详情就不填 wantToViewDetail。`;
};

// ==================== Core Engine ====================

const getRecentChatContext = async (char: CharacterProfile): Promise<string> => {
    try {
        const msgs = await loadCharacterContextMessages(char);
        if (msgs.length === 0) return '还没有和用户聊过天。';

        // Return raw messages — no summarization, no truncation
        return msgs.map(m => {
            const role = m.role === 'user' ? '用户' : '角色';
            const text = m.type === 'text' ? m.content : `[${m.type}]`;
            return `${role}: ${text}`;
        }).join('\n');
    } catch {
        return '无法获取最近对话。';
    }
};

/**
 * 查看笔记详情 + 评论区，并让角色反应（回复评论等）
 */
const handleViewDetail = async (mcpUrl: string,
    apiConfig: APIConfig,
    systemPrompt: FreeRoamPrompt,
    noteId: string,
    noteTitle: string,
    contextNotes: any[],
    char: CharacterProfile,
    session: XhsFreeRoamSession,
    callbacks: FreeRoamCallbacks,
    canInteract: boolean,
): Promise<void> => {
    callbacks.onStatus(`${char.name}在查看帖子「${noteTitle}」的详情...`);

    // Find xsecToken from context notes
    const contextNote = contextNotes.find(n =>
        (n.noteId || n.note_id || n.id) === noteId
    );
    const xsecToken = contextNote?.xsecToken || contextNote?.xsec_token || contextNote?.noteCard?.xsec_token || undefined;

    const detailResult = await XhsMcpClient.getNoteDetail(mcpUrl, noteId, xsecToken, { loadAllComments: true });
    if (!detailResult.success) {
        console.log(`[FreeRoam] 查看详情失败: ${detailResult.error}`);
        return;
    }

    // Extract note content and comments
    const data = detailResult.data;
    let noteContent = '';
    let comments: any[] = [];
    let commentsUnavailable = false;
    if (typeof data === 'string') {
        noteContent = data.slice(0, 1000);
    } else if (data) {
        // MCP 服务器返回数据可能嵌套在 data 层: { data: { note: {...}, comments: { list: [...] } } }
        const innerData = data.data && typeof data.data === 'object' ? data.data : null;
        const noteObj = innerData?.note || data.note;
        noteContent = innerData?.note?.content || innerData?.note?.desc || data.content || data.desc || data.note?.content || data.note?.desc || '';
        // 兼容多种 MCP 返回格式（包括 MCP 服务器的 data.comments.list 嵌套）
        comments = innerData?.comments?.list || innerData?.comments
            || data.comments?.list || data.comments
            || data.comment_list || data.commentList
            || noteObj?.comments?.list || noteObj?.comments || [];
        if (!Array.isArray(comments)) comments = [];
        const normalized = normalizeXhsLiteDetail(data);
        comments = normalized.comments || [];
        commentsUnavailable = normalized.commentReadStatus === 'unavailable';
    }

    // Let character react to detail + comments
    callbacks.onStatus(commentsUnavailable
        ? `${char.name}看完了正文，评论区暂时读取失败`
        : `${char.name}在看评论区...`);
    const reactionRaw = await callLlm(apiConfig,
        systemPrompt,
        buildDetailReactionPrompt(noteTitle, noteContent, comments, commentsUnavailable, canInteract),
    );
    const reaction = parseJson<LlmDetailReaction>(reactionRaw);

    if (reaction?.thinking) {
        callbacks.onThinking(reaction.thinking);
    }

    // Record the detail viewing
    const detailRecord: XhsActivityRecord = {
        id: `xa_${Date.now()}_d`,
        characterId: char.id,
        timestamp: Date.now(),
        actionType: 'browse',
        content: {
            keyword: `查看详情: ${noteTitle}`,
            notesViewed: [normalizeNote(contextNote || { noteId, title: noteTitle })],
        },
        thinking: reaction?.thinking || (commentsUnavailable
            ? `看了「${noteTitle}」的正文，但评论区读取失败`
            : `看了「${noteTitle}」的详情和评论区`),
        result: 'success',
        resultMessage: commentsUnavailable
            ? `查看了「${noteTitle}」的详情；真实评论读取失败`
            : `查看了「${noteTitle}」的详情，${comments.length} 条评论`,
    };
    session.activities.push(detailRecord);
    callbacks.onActivity(detailRecord);

    // If character wants to reply to a comment
    const requestedReplyCommentId = reaction?.wantToReply?.commentId;
    const replyTargetExists = !!requestedReplyCommentId && comments.some((comment: any) =>
        (comment.commentId || comment.comment_id || comment.id) === requestedReplyCommentId
    );
    if (canInteract && replyTargetExists && reaction?.wantToReply?.reply) {
        // XHS 反爬: get-feed-detail 刚用过 xsec_token 打开笔记页，
        // 紧接着 post-comment 再次打开同一页面会被临时封锁("笔记不可访问")。
        // 等几秒让 xsec_token 冷却，避免触发反爬。
        callbacks.onStatus(`${char.name}在思考回复...`);
        await new Promise(r => setTimeout(r, 5000));
        callbacks.onStatus(`${char.name}在回复评论...`);
        const replyResult = await XhsMcpClient.replyComment(
            mcpUrl, noteId, xsecToken || '',
            reaction.wantToReply.reply,
            reaction.wantToReply.commentId,
        );

        const replyRecord: XhsActivityRecord = {
            id: `xa_${Date.now()}_r`,
            characterId: char.id,
            timestamp: Date.now(),
            actionType: 'comment',
            content: {
                commentTarget: { noteId, title: noteTitle, commentId: reaction.wantToReply.commentId },
                commentText: `回复${reaction.wantToReply.authorName}: ${reaction.wantToReply.reply}`,
            },
            thinking: `想回复${reaction.wantToReply.authorName}的评论`,
            result: replyResult.success ? 'success' : 'failed',
            resultMessage: replyResult.success ? '回复评论成功' : (replyResult.error || '回复失败'),
        };
        session.activities.push(replyRecord);
        callbacks.onActivity(replyRecord);
    }

    // If character wants to leave a new comment on the note
    if (canInteract && reaction?.wantToComment?.comment) {
        // 同上: 避免 xsec_token 重复访问触发反爬
        callbacks.onStatus(`${char.name}在想怎么评论...`);
        await new Promise(r => setTimeout(r, 5000));
        callbacks.onStatus(`${char.name}在评论帖子...`);
        const commentResult = await XhsMcpClient.comment(mcpUrl, noteId, reaction.wantToComment.comment, xsecToken);

        const commentRecord: XhsActivityRecord = {
            id: `xa_${Date.now()}_c2`,
            characterId: char.id,
            timestamp: Date.now(),
            actionType: 'comment',
            content: {
                commentTarget: { noteId, title: noteTitle },
                commentText: reaction.wantToComment.comment,
            },
            thinking: `想对「${noteTitle}」说点什么`,
            result: commentResult.success ? 'success' : 'failed',
            resultMessage: commentResult.success ? '评论成功' : (commentResult.error || '评论失败'),
        };
        session.activities.push(commentRecord);
        callbacks.onActivity(commentRecord);
    }
};

export const XhsFreeRoamEngine = {

    /**
     * 执行一次角色自由活动
     */
    run: async (
        char: CharacterProfile,
        user: UserProfile,
        apiConfig: APIConfig,
        realtimeConfig: RealtimeConfig,
        callbacks: FreeRoamCallbacks,
    ): Promise<XhsFreeRoamSession> => {

        const mcpUrl = realtimeConfig.xhsMcpConfig?.serverUrl;
        if (!mcpUrl) throw new Error('MCP Server URL 未配置');
        XhsMcpClient.setCookie(realtimeConfig.xhsMcpConfig?.cookie); // lite Worker auth (no-op for local backends)

        const sessionId = `xfr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const session: XhsFreeRoamSession = {
            id: sessionId,
            characterId: char.id,
            startedAt: Date.now(),
            activities: [],
        };

        try {
            // 0. Reset & initialize MCP session (fresh handshake each run)
            callbacks.onStatus('连接小红书 MCP Server...');
            XhsMcpClient.resetSession();
            await XhsMcpClient.ensureInitialized(mcpUrl);
            callbacks.onStatus('MCP 已连接');

            // 1. Build context
            callbacks.onStatus(`${char.name}正在思考...`);
            const pastActivities = await DB.getXhsActivities(char.id, 10);
            const chatSummary = await getRecentChatContext(char);
            const systemPrompt = (await buildFreeRoamSystemPrompt(char, user, chatSummary, pastActivities));

            // 4. Character decides
            callbacks.onStatus(`${char.name}在决定做什么...`);
            const decisionRaw = await callLlm(apiConfig, systemPrompt, buildDecisionPrompt());
            const decision = parseJson<LlmDecision>(decisionRaw);

            if (!decision) {
                throw new Error('角色决策解析失败');
            }

            callbacks.onThinking(decision.thinking);

            // 5. Execute based on decision
            if (decision.action === 'idle') {
                const idleRecord: XhsActivityRecord = {
                    id: `xa_${Date.now()}`,
                    characterId: char.id,
                    timestamp: Date.now(),
                    actionType: 'idle',
                    content: {},
                    thinking: decision.thinking,
                    result: 'success',
                    resultMessage: `${char.name}决定休息一下`,
                };
                session.activities.push(idleRecord);
                callbacks.onActivity(idleRecord);
            }
            else if (decision.action === 'post') {
                callbacks.onStatus(`${char.name}正在发帖: ${decision.title}...`);

                // Try to get images from XHS stock
                let images: string[] = [];
                try {
                    const stockImgs = await DB.getXhsStockImages();
                    if (stockImgs.length > 0) {
                        const keywords = [decision.title, decision.content, ...(decision.tags || [])].join(' ').toLowerCase();
                        const scored = stockImgs.map(img => ({
                            img,
                            score: img.tags.reduce((s, t) => s + (keywords.includes(t.toLowerCase()) ? 10 : 0), 0) + Math.max(0, 5 - (img.usedCount || 0))
                        })).sort((a, b) => b.score - a.score);
                        if (scored[0]?.img.url) {
                            images = [scored[0].img.url];
                            DB.updateXhsStockImageUsage(scored[0].img.id).catch(() => {});
                        }
                    }
                } catch { /* ignore stock failures */ }

                const postResult = await XhsMcpClient.publishNote(mcpUrl, {
                    title: decision.title || '无题',
                    content: decision.content || '',
                    images: images.length > 0 ? images : undefined,
                    tags: decision.tags,
                });
                const publishedNoteId = postResult.success ? extractPublishedNoteId(postResult) : '';
                if (publishedNoteId) {
                    const now = Date.now();
                    const ownedPost: XhsOwnedPost = {
                        id: `${char.id}:${publishedNoteId}`,
                        characterId: char.id,
                        noteId: publishedNoteId,
                        title: decision.title || '无题',
                        body: decision.content || '',
                        tags: decision.tags,
                        publishedAt: now,
                        updatedAt: now,
                    };
                    try {
                        // 立即保存，避免后续 LLM/日志步骤失败时丢失已经发布成功的帖子归属。
                        await DB.saveXhsOwnedPost(ownedPost);
                    } catch (error) {
                        console.warn('[FreeRoam] 保存角色小红书主页失败:', error);
                    }
                }

                const postRecord: XhsActivityRecord = {
                    id: `xa_${Date.now()}`,
                    characterId: char.id,
                    timestamp: Date.now(),
                    actionType: 'post',
                    content: {
                        noteId: publishedNoteId || undefined,
                        title: decision.title,
                        body: decision.content,
                        tags: decision.tags,
                    },
                    thinking: decision.thinking,
                    result: postResult.success ? 'success' : 'failed',
                    resultMessage: postResult.success ? '发帖成功' : (postResult.error || '发帖失败'),
                };
                session.activities.push(postRecord);
                callbacks.onActivity(postRecord);
            }
            else if (decision.action === 'search' || decision.action === 'browse') {
                const isSearch = decision.action === 'search';
                const keyword = decision.keyword || '';

                callbacks.onStatus(isSearch
                    ? `${char.name}在搜索: ${keyword}...`
                    : `${char.name}在刷小红书首页...`
                );

                const mcpResult: McpToolResult = isSearch
                    ? await XhsMcpClient.search(mcpUrl, keyword)
                    : await XhsMcpClient.getRecommend(mcpUrl);

                if (!mcpResult.success) {
                    const failRecord: XhsActivityRecord = {
                        id: `xa_${Date.now()}`,
                        characterId: char.id,
                        timestamp: Date.now(),
                        actionType: isSearch ? 'search' : 'browse',
                        content: { keyword: isSearch ? keyword : undefined },
                        thinking: decision.thinking,
                        result: 'failed',
                        resultMessage: mcpResult.error || '操作失败',
                    };
                    session.activities.push(failRecord);
                    callbacks.onActivity(failRecord);
                } else {
                    // Parse notes from result (robust extraction) + normalize
                    const rawNotes: any[] = extractNotesFromMcpData(mcpResult.data);
                    const notes = rawNotes.map(normalizeNote);
                    console.log(`[FreeRoam] ${decision.action} 提取到 ${notes.length} 条笔记`);

                    // Let character react to what they saw (normalized notes have proper title/author)
                    callbacks.onStatus(`${char.name}在看搜索结果...`);
                    const reactionRaw = await callLlm(apiConfig, systemPrompt, buildReactionPrompt(notes));
                    const reaction = parseJson<LlmReaction>(reactionRaw);

                    if (reaction?.thinking) {
                        callbacks.onThinking(reaction.thinking);
                    }

                    const browseRecord: XhsActivityRecord = {
                        id: `xa_${Date.now()}`,
                        characterId: char.id,
                        timestamp: Date.now(),
                        actionType: isSearch ? 'search' : 'browse',
                        content: {
                            keyword: isSearch ? keyword : undefined,
                            notesViewed: notes.slice(0, 8),
                            savedTopics: reaction?.savedTopics || [],
                        },
                        thinking: reaction?.thinking || decision.thinking,
                        result: 'success',
                        resultMessage: `看了 ${notes.length} 条笔记${reaction?.savedTopics?.length ? `，保存了 ${reaction.savedTopics.length} 个话题` : ''}`,
                    };
                    session.activities.push(browseRecord);
                    callbacks.onActivity(browseRecord);

                    // If character wants to view note detail (comments section)
                    // 注意：浏览/搜索看到的是别人的帖子，不执行评论（wantToComment 已从 prompt 中移除）
                    if (reaction?.wantToViewDetail?.noteId) {
                        await handleViewDetail(mcpUrl, apiConfig, systemPrompt,
                            reaction.wantToViewDetail.noteId,
                            reaction.wantToViewDetail.title || '',
                            notes, char, session, callbacks,
                            false,
                        );
                    }
                }
            }
            else if (decision.action === 'check_profile') {
                // 角色伪主页以独立的 owned-posts 表为准；真实账号主页只刷新已归属帖子的互动数据。
                // 同一个真实账号可以被多个角色共用，绝不能把账号下全部笔记自动认领给当前角色。
                callbacks.onStatus(`${char.name}在查看自己的主页...`);
                const loggedInUserId = realtimeConfig.xhsMcpConfig?.loggedInUserId;
                const userXsecToken = realtimeConfig.xhsMcpConfig?.userXsecToken;
                const allActivities = await DB.getXhsActivities(char.id);
                let ownedPosts = await DB.getXhsOwnedPosts(char.id);

                // v71 首次运行时，把旧活动里已记录过 note_id 的帖子迁移进独立主页。
                const knownPostIds = new Set(ownedPosts.map(post => post.noteId));
                const migratedPosts = collectOwnedPostsFromActivities(allActivities)
                    .filter(post => !knownPostIds.has(post.noteId));
                for (const post of migratedPosts) await DB.saveXhsOwnedPost(post);
                if (migratedPosts.length > 0) {
                    ownedPosts = [...ownedPosts, ...migratedPosts]
                        .sort((a, b) => b.publishedAt - a.publishedAt);
                }

                let ownedNotes: any[] = ownedPosts.map(post => ownedPostToNote(post, char.name));
                let profileRefreshError = '';

                if (loggedInUserId && ownedNotes.length > 0) {
                    console.log(`[FreeRoam] check_profile: 用 getUserProfile(${loggedInUserId})...`);
                    try {
                        const profileResult = await XhsMcpClient.getUserProfile(mcpUrl, loggedInUserId, userXsecToken);
                        if (profileResult.success && profileResult.data) {
                            const remoteNotes = extractNotesFromMcpData(profileResult.data).map(normalizeNote);
                            const notesStatus = profileResult.data?.notes_status || profileResult.data?.data?.notes_status;
                            console.log(`[FreeRoam] check_profile: getUserProfile 提取到 ${remoteNotes.length} 条笔记`);
                            if (notesStatus === 'unavailable') {
                                profileRefreshError = profileResult.data?.notes_error || profileResult.data?.data?.notes_error || '';
                            } else {
                                // 只更新当前角色已经拥有的 note_id，忽略共享账号下其他角色的帖子。
                                ownedNotes = mergeOwnedNotes(ownedNotes, remoteNotes, false);
                                const ownedPostById = new Map(ownedPosts.map(post => [post.noteId, post]));
                                await Promise.all(ownedNotes.map(async note => {
                                    const current = ownedPostById.get(note.noteId);
                                    if (!current) return;
                                    await DB.saveXhsOwnedPost({
                                        ...current,
                                        title: note.title || current.title,
                                        body: note.desc || current.body,
                                        xsecToken: note.xsecToken || current.xsecToken,
                                        likes: note.likes,
                                        collects: note.collects,
                                        commentCount: note.commentCount,
                                        shareCount: note.shareCount,
                                        updatedAt: Date.now(),
                                    });
                                }));
                            }
                        }
                        if (!profileResult.success) profileRefreshError = profileResult.error || '';
                    } catch (e: any) {
                        console.warn(`[FreeRoam] check_profile: getUserProfile 失败:`, e.message);
                        profileRefreshError = e.message;
                    }
                }

                const notes = ownedNotes.map(normalizeNote);
                const trustedOwnedNoteIds = new Set(
                    ownedNotes.map(note => normalizeNote(note).noteId).filter(Boolean)
                );

                const profileRecord: XhsActivityRecord = {
                    id: `xa_${Date.now()}`,
                    characterId: char.id,
                    timestamp: Date.now(),
                    actionType: 'browse',
                    content: {
                        keyword: `查看主页（${char.name}）`,
                        notesViewed: notes.slice(0, 8),
                    },
                    thinking: decision.thinking,
                    result: 'success',
                    resultMessage: `查看角色主页，找到 ${notes.length} 条帖子${profileRefreshError ? '（真实账号互动数据刷新失败，已使用本地记录）' : ''}`,
                };
                session.activities.push(profileRecord);
                callbacks.onActivity(profileRecord);

                // Let character react if we found notes
                if (notes.length > 0) {
                    callbacks.onStatus(`${char.name}在看自己的帖子...`);
                    const reactionRaw = await callLlm(apiConfig, systemPrompt, buildProfileReactionPrompt(
                        '这是按角色独立保存的个人主页；真实小红书账号可能与其他角色共用',
                        notes
                    ));
                    const reaction = parseJson<LlmReaction & { wantToViewDetail?: { noteId: string; title: string } }>(reactionRaw);
                    if (reaction?.thinking) {
                        callbacks.onThinking(reaction.thinking);
                        profileRecord.thinking = reaction.thinking;
                    }
                    if (reaction?.wantToViewDetail?.noteId) {
                        await handleViewDetail(mcpUrl, apiConfig, systemPrompt,
                            reaction.wantToViewDetail.noteId,
                            reaction.wantToViewDetail.title || '',
                            notes, char, session, callbacks,
                            trustedOwnedNoteIds.has(reaction.wantToViewDetail.noteId),
                        );
                    }
                }
            }

            // 6. Finalize session
            session.endedAt = Date.now();
            session.summary = session.activities.map(a => {
                const label: Record<string, string> = { post: '发帖', browse: '刷首页', search: '搜索', comment: '评论', save_topic: '收藏', idle: '休息' };
                return `${label[a.actionType] || a.actionType}: ${a.content.title || a.content.keyword || a.thinking.slice(0, 50)} [${a.result}]`;
            }).join(' → ');

            // Save all activities to DB + sync to chat context
            for (const activity of session.activities) {
                await DB.saveXhsActivity(activity);

                // 写入聊天记录作为系统消息（🔔），让私聊时 AI 知道自由活动做了什么
                // 包含完整的思考和内容，确保角色在后续聊天中能记住自由活动的细节
                if (activity.result === 'success' && activity.actionType !== 'idle') {
                    let msgContent = '';
                    const thinkingLine = activity.thinking ? `\n💭 内心想法: ${activity.thinking}` : '';
                    switch (activity.actionType) {
                        case 'post': {
                            const tagsStr = activity.content.tags?.length ? ` #${activity.content.tags.join(' #')}` : '';
                            msgContent = `📕 ${char.name}的自由活动: 发了一条小红书「${activity.content.title}」\n${activity.content.body || ''}${tagsStr}${thinkingLine}`;
                            break;
                        }
                        case 'search': {
                            msgContent = `📕 ${char.name}的自由活动: 搜索了「${activity.content.keyword}」`;
                            if (activity.content.notesViewed?.length) {
                                msgContent += `\n看到的帖子: ${activity.content.notesViewed.map(n => `「${n.title}」by ${n.author}`).join('、')}`;
                            }
                            if (activity.content.savedTopics?.length) {
                                msgContent += `\n保存的话题: ${activity.content.savedTopics.map(t => `「${t.title}」${t.desc ? ` - ${t.desc}` : ''}`).join('、')}`;
                            }
                            msgContent += thinkingLine;
                            break;
                        }
                        case 'browse': {
                            msgContent = `📕 ${char.name}的自由活动: 刷了小红书首页`;
                            if (activity.content.notesViewed?.length) {
                                msgContent += `\n看到的帖子: ${activity.content.notesViewed.map(n => `「${n.title}」by ${n.author}`).join('、')}`;
                            }
                            if (activity.content.savedTopics?.length) {
                                msgContent += `\n保存的话题: ${activity.content.savedTopics.map(t => `「${t.title}」${t.desc ? ` - ${t.desc}` : ''}`).join('、')}`;
                            }
                            msgContent += thinkingLine;
                            break;
                        }
                        case 'comment':
                            msgContent = `📕 ${char.name}的自由活动: 评论了「${activity.content.commentTarget?.title || '某条笔记'}」: "${activity.content.commentText || ''}"${thinkingLine}`;
                            break;
                    }
                    if (msgContent) {
                        await DB.saveMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: msgContent,
                        });
                    }

                    // Inject saved topics as xhs_card shared posts in chat
                    if (activity.content.savedTopics?.length && activity.content.notesViewed?.length) {
                        for (const topic of activity.content.savedTopics) {
                            const matchedNote = topic.noteId
                                ? activity.content.notesViewed.find(n => n.noteId === topic.noteId)
                                : null;
                            await DB.saveMessage({
                                charId: char.id,
                                role: 'assistant',
                                type: 'xhs_card' as any,
                                content: topic.title || '小红书笔记',
                                metadata: {
                                    xhsNote: {
                                        noteId: topic.noteId || matchedNote?.noteId || '',
                                        title: topic.title || matchedNote?.title || '',
                                        desc: topic.desc || matchedNote?.desc || '',
                                        author: matchedNote?.author || '',
                                        authorId: '',
                                        likes: matchedNote?.likes || 0,
                                    },
                                    fromFreeRoam: true,
                                },
                            });
                        }
                    }
                }
            }

            callbacks.onComplete(session);
            return session;

        } catch (e: any) {
            session.endedAt = Date.now();
            callbacks.onError(e.message);
            return session;
        }
    },
};
