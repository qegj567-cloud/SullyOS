/**
 * Dynamic Prompt Engine (动态预设引擎)
 *
 * 酒馆风格的 Prompt 组装系统：
 * - 预设定义 block 顺序和自定义文本
 * - 系统 block 根据角色自身设置（开关）自动决定是否生成内容
 * - 用户无需在预设里手动开关每个 block
 */

import {
    CharacterProfile, UserProfile, Message, Emoji, EmojiCategory,
    GroupProfile, RealtimeConfig, PromptBlock, PromptPreset, SystemBlockId,
} from '../types';
import { normalizeUserImpression } from './impression';
import { DB } from './db';
import { RealtimeContextManager, NotionManager, FeishuManager, defaultRealtimeConfig } from './realtimeContext';

// ============ Runtime Context (运行时数据，由调用方填充) ============

export interface PromptRuntimeContext {
    char: CharacterProfile;
    user: UserProfile;
    groups: GroupProfile[];
    emojis: Emoji[];
    emojiCategories: EmojiCategory[];
    currentMsgs: Message[];
    realtimeConfig?: RealtimeConfig;
    includeDetailedMemories?: boolean;
    /** 记忆宫殿向量检索结果（由 memoryRetrieval 生成） */
    memoryInjection?: string;
    /** 预构建的表情包上下文字符串 */
    emojiContextStr?: string;
    /** 功能开关（由调用方根据 realtimeConfig 计算） */
    features?: {
        searchEnabled?: boolean;
        notionEnabled?: boolean;
        feishuEnabled?: boolean;
        notionNotesEnabled?: boolean;
        xhsEnabled?: boolean;
    };
    /** 认知架构注入（Phase 2+） */
    cognitiveContext?: {
        /** 情绪动力学引擎的自然语言描述 */
        emotionDynamicsDesc?: string;
        /** 涌现人格特质列表 */
        personalityCrystals?: string;
        /** 用户认知模型摘要 */
        userCognitiveModel?: string;
        /** 活跃的未解决张力 */
        unresolvedTensions?: string;
        /** 跨事件关联模式 (L2+L3) */
        crossEventPatterns?: string;
    };
}

// ============ System Block Registry ============

/**
 * 每个系统 block 的生成函数
 * 返回 string = 有内容；返回 null = 该 block 跳过（角色未启用相关功能）
 */
type BlockGenerator = (ctx: PromptRuntimeContext) => string | null | Promise<string | null>;

/** 格式化日期辅助函数（从 memoryRetrieval / context 中复用的逻辑） */
function normalizeMemoryDate(date: string): string {
    let normDate = date.replace(/[\/年月]/g, '-').replace('日', '');
    const parts = normDate.split('-');
    if (parts.length >= 2) {
        normDate = `${parts[0]}-${parts[1].padStart(2, '0')}`;
    }
    return normDate;
}

const SYSTEM_BLOCKS: Record<SystemBlockId, { name: string; icon: string; color: string; description: string; generate: BlockGenerator }> = {

    // ── 1. 角色身份 ──
    char_identity: {
        name: '角色身份',
        icon: '🎭',
        color: 'bg-violet-100 text-violet-700',
        description: '角色名字、用户备注、核心 systemPrompt',
        generate: (ctx) => {
            const { char } = ctx;
            let s = `### 你的身份 (Character)\n`;
            s += `- 名字: ${char.name}\n`;
            s += `- 用户备注/爱称 (User Note/Nickname): ${char.description || '无'}\n`;
            s += `  (注意: 这个备注是用户对你的称呼或印象，可能包含比喻。如果备注内容（如"快乐小狗"）与你的核心设定冲突，请以核心设定为准，不要真的扮演成动物，除非核心设定里写了你是动物。)\n`;
            s += `- 核心性格/指令:\n${char.systemPrompt || '你是一个温柔、拟人化的AI伴侣。'}\n`;
            return s;
        },
    },

    // ── 2. 世界观 ──
    worldview: {
        name: '世界观',
        icon: '🌍',
        color: 'bg-emerald-100 text-emerald-700',
        description: '角色的世界观设定文本',
        generate: (ctx) => {
            const { char } = ctx;
            if (!char.worldview?.trim()) return null;
            return `### 世界观与设定 (World Settings)\n${char.worldview}\n`;
        },
    },

    // ── 3. 世界书 ──
    worldbooks: {
        name: '世界书',
        icon: '📚',
        color: 'bg-teal-100 text-teal-700',
        description: '挂载的世界书（按分类分组）',
        generate: (ctx) => {
            const { char } = ctx;
            if (!char.mountedWorldbooks?.length) return null;
            let s = `### 扩展设定集 (Worldbooks)\n`;
            const grouped: Record<string, typeof char.mountedWorldbooks> = {};
            char.mountedWorldbooks.forEach(wb => {
                const cat = wb.category || '通用设定 (General)';
                if (!grouped[cat]) grouped[cat] = [];
                grouped[cat].push(wb);
            });
            Object.entries(grouped).forEach(([category, books]) => {
                s += `#### [${category}]\n`;
                books.forEach(wb => { s += `**Title: ${wb.title}**\n${wb.content}\n---\n`; });
                s += `\n`;
            });
            return s;
        },
    },

    // ── 4. 用户画像 ──
    user_profile: {
        name: '用户画像',
        icon: '👤',
        color: 'bg-blue-100 text-blue-700',
        description: '用户名字和备注/设定',
        generate: (ctx) => {
            const { user } = ctx;
            let s = `### 互动对象 (User)\n`;
            s += `- 名字: ${user.name}\n`;
            s += `- 设定/备注: ${user.bio || '无'}\n`;
            return s;
        },
    },

    // ── 5. 私密印象 ──
    impression: {
        name: '私密印象',
        icon: '💭',
        color: 'bg-pink-100 text-pink-700',
        description: '角色对用户的私密看法档案',
        generate: (ctx) => {
            const { char, user } = ctx;
            const imp = normalizeUserImpression(char.impression);
            if (!imp) return null;
            let s = `### [私密档案: 我眼中的${user.name}] (Private Impression)\n`;
            s += `(注意：以下内容是你内心对TA的真实看法，不要直接告诉用户，但要基于这些看法来决定你的态度。)\n`;
            s += `- 核心评价: ${imp.personality_core.summary}\n`;
            s += `- 互动模式: ${imp.personality_core.interaction_style}\n`;
            s += `- 我观察到的特质: ${imp.personality_core.observed_traits.join(', ')}\n`;
            s += `- TA的喜好: ${imp.value_map.likes.join(', ')}\n`;
            s += `- 情绪雷区: ${imp.emotion_schema.triggers.negative.join(', ')}\n`;
            s += `- 舒适区: ${imp.emotion_schema.comfort_zone}\n`;
            s += `- 最近观察到的变化: ${imp.observed_changes ? imp.observed_changes.map(c => typeof c === 'string' ? c : (c as any)?.description ? `[${(c as any).period}] ${(c as any).description}` : JSON.stringify(c)).join('; ') : '无'}\n`;
            return s;
        },
    },

    // ── 6. 记忆库 ──
    memory_bank: {
        name: '记忆库',
        icon: '🧠',
        color: 'bg-amber-100 text-amber-700',
        description: '月度总结 + 激活的详细日志',
        generate: (ctx) => {
            const { char } = ctx;
            const includeDetailed = ctx.includeDetailedMemories !== false;
            let s = `### 记忆系统 (Memory Bank)\n`;
            let memoryContent = '';

            if (char.refinedMemories && Object.keys(char.refinedMemories).length > 0) {
                memoryContent += `**长期核心记忆 (Key Memories)**:\n`;
                Object.entries(char.refinedMemories).sort().forEach(([date, summary]) => {
                    memoryContent += `- [${date}]: ${summary}\n`;
                });
            }

            if (includeDetailed && char.activeMemoryMonths?.length && char.memories) {
                let details = '';
                char.activeMemoryMonths.forEach(monthKey => {
                    const logs = char.memories.filter(m => normalizeMemoryDate(m.date).startsWith(monthKey));
                    if (logs.length > 0) {
                        details += `\n> 详细回忆 [${monthKey}]:\n`;
                        logs.forEach(m => { details += `  - ${m.date} (${m.mood || 'rec'}): ${m.summary}\n`; });
                    }
                });
                if (details) memoryContent += `\n**当前激活的详细回忆 (Active Recall)**:${details}`;
            }

            s += (memoryContent || '(暂无特定记忆，请基于当前对话互动)') + '\n';
            return s;
        },
    },

    // ── 7. 记忆宫殿 ──
    memory_palace: {
        name: '记忆宫殿',
        icon: '🏛️',
        color: 'bg-indigo-100 text-indigo-700',
        description: '向量检索结果注入（Memory Palace）',
        generate: (ctx) => ctx.memoryInjection || null,
    },

    // ── 8. 情绪 Buff（兼容旧系统 + 认知架构新系统）──
    emotion_buff: {
        name: '情绪底色',
        icon: '🎨',
        color: 'bg-rose-100 text-rose-700',
        description: '情绪系统 Buff 注入（需角色开启情绪功能）',
        generate: (ctx) => {
            const { char } = ctx;
            if (!char.emotionConfig?.enabled) return null;
            // 优先使用认知架构的情绪动力学描述
            if (ctx.cognitiveContext?.emotionDynamicsDesc) {
                return ctx.cognitiveContext.emotionDynamicsDesc;
            }
            // Fallback: 旧的 buff injection 系统
            if (char.buffInjection) return char.buffInjection;
            return null;
        },
    },

    // ── 9. 实时信息 ──
    realtime_context: {
        name: '实时信息',
        icon: '🌤️',
        color: 'bg-sky-100 text-sky-700',
        description: '天气、新闻、当前时间（需角色开启实时感知）',
        generate: async (ctx) => {
            try {
                const config = ctx.realtimeConfig || defaultRealtimeConfig;
                if (config.weatherEnabled || config.newsEnabled) {
                    return await RealtimeContextManager.buildFullContext(config);
                }
                // 即使没有API，也注入基本时间
                const time = RealtimeContextManager.getTimeContext();
                const specialDates = RealtimeContextManager.checkSpecialDates();
                let s = `### 【当前时间】\n`;
                s += `${time.dateStr} ${time.dayOfWeek} ${time.timeOfDay} ${time.timeStr}\n`;
                if (specialDates.length > 0) s += `今日特殊: ${specialDates.join('、')}\n`;
                return s;
            } catch (e) {
                console.error('[PromptEngine] realtime_context error:', e);
                return null;
            }
        },
    },

    // ── 10. 群聊上下文 ──
    group_context: {
        name: '群聊上下文',
        icon: '👥',
        color: 'bg-cyan-100 text-cyan-700',
        description: '角色参与的群聊最近消息',
        generate: async (ctx) => {
            try {
                const { char, groups, user } = ctx;
                const memberGroups = groups.filter(g => g.members.includes(char.id));
                if (memberGroups.length === 0) return null;

                let allGroupMsgs: (Message & { groupName: string })[] = [];
                for (const g of memberGroups) {
                    const gMsgs = await DB.getGroupMessages(g.id);
                    allGroupMsgs = [...allGroupMsgs, ...gMsgs.map(m => ({ ...m, groupName: g.name }))];
                }
                allGroupMsgs.sort((a, b) => b.timestamp - a.timestamp);
                const recent = allGroupMsgs.slice(0, 200).reverse();
                if (recent.length === 0) return null;

                const logStr = recent.map(m => {
                    const dateStr = new Date(m.timestamp).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                    return `[${dateStr}] [Group: ${m.groupName}] ${m.role === 'user' ? user.name : 'Member'}: ${m.content}`;
                }).join('\n');
                return `### [Background Context: Recent Group Activities]\n(注意：你是以下群聊的成员...)\n${logStr}\n`;
            } catch (e) {
                console.error('[PromptEngine] group_context error:', e);
                return null;
            }
        },
    },

    // ── 11. Notion 日记 ──
    notion_diaries: {
        name: 'Notion 日记',
        icon: '📔',
        color: 'bg-orange-100 text-orange-700',
        description: '角色最近写过的 Notion 日记标题',
        generate: async (ctx) => {
            try {
                const config = ctx.realtimeConfig || defaultRealtimeConfig;
                if (!config.notionEnabled || !config.notionApiKey || !config.notionDatabaseId) return null;
                const diaryResult = await NotionManager.getRecentDiaries(config.notionApiKey, config.notionDatabaseId, ctx.char.name, 8);
                if (!diaryResult.success || diaryResult.entries.length === 0) return null;
                let s = `### 📔【你最近写的日记】\n`;
                s += `（这些是你之前写的日记，你记得这些内容。如果想看某篇的详细内容，可以使用 [[READ_DIARY: 日期]] 翻阅）\n`;
                diaryResult.entries.forEach((d, i) => { s += `${i + 1}. [${d.date}] ${d.title}\n`; });
                return s;
            } catch (e) {
                console.error('[PromptEngine] notion_diaries error:', e);
                return null;
            }
        },
    },

    // ── 12. 飞书日记 ──
    feishu_diaries: {
        name: '飞书日记',
        icon: '📒',
        color: 'bg-blue-100 text-blue-600',
        description: '角色最近写过的飞书日记标题',
        generate: async (ctx) => {
            try {
                const config = ctx.realtimeConfig || defaultRealtimeConfig;
                if (!config.feishuEnabled || !config.feishuAppId || !config.feishuAppSecret || !config.feishuBaseId || !config.feishuTableId) return null;
                const diaryResult = await FeishuManager.getRecentDiaries(config.feishuAppId, config.feishuAppSecret, config.feishuBaseId, config.feishuTableId, ctx.char.name, 8);
                if (!diaryResult.success || diaryResult.entries.length === 0) return null;
                let s = `### 📒【你最近写的日记（飞书）】\n`;
                s += `（这些是你之前写的日记，你记得这些内容。如果想看某篇的详细内容，可以使用 [[FS_READ_DIARY: 日期]] 翻阅）\n`;
                diaryResult.entries.forEach((d, i) => { s += `${i + 1}. [${d.date}] ${d.title}\n`; });
                return s;
            } catch (e) {
                console.error('[PromptEngine] feishu_diaries error:', e);
                return null;
            }
        },
    },

    // ── 13. 用户笔记 ──
    user_notes: {
        name: '用户笔记',
        icon: '📝',
        color: 'bg-lime-100 text-lime-700',
        description: '用户最近的 Notion 笔记标题',
        generate: async (ctx) => {
            try {
                const config = ctx.realtimeConfig || defaultRealtimeConfig;
                if (!config.notionEnabled || !config.notionApiKey || !config.notionNotesDatabaseId) return null;
                const notesResult = await NotionManager.getUserNotes(config.notionApiKey, config.notionNotesDatabaseId, 5);
                if (!notesResult.success || notesResult.entries.length === 0) return null;
                const uName = ctx.user.name;
                let s = `### 📝【${uName}最近写的笔记】\n`;
                s += `（这些是${uName}在Notion上写的个人笔记。你可以偶尔自然地提到你看到了ta写的某篇笔记，表示关心，但不要每次都提，也不要显得在监视。如果想看某篇的详细内容，可以使用 [[READ_NOTE: 标题关键词]] 翻阅）\n`;
                notesResult.entries.forEach((d, i) => { s += `${i + 1}. [${d.date}] ${d.title}\n`; });
                return s;
            } catch (e) {
                console.error('[PromptEngine] user_notes error:', e);
                return null;
            }
        },
    },

    // ── 14. 聊天行为规范 ──
    chat_rules: {
        name: '聊天行为规范',
        icon: '📋',
        color: 'bg-slate-100 text-slate-700',
        description: '聊天格式、行为规则、可用动作/命令等（最大的 block）',
        generate: (ctx) => buildChatRulesBlock(ctx),
    },

    // ── 15. 语音消息 ──
    voice_config: {
        name: '语音消息',
        icon: '🎤',
        color: 'bg-fuchsia-100 text-fuchsia-700',
        description: '语音消息功能说明（需角色开启语音）',
        generate: (ctx) => buildVoiceConfigBlock(ctx),
    },

    // ── 16. 模式切换 ──
    mode_switch: {
        name: '模式切换',
        icon: '🔄',
        color: 'bg-gray-100 text-gray-600',
        description: '从约会/电话切回聊天的上下文提示',
        generate: (ctx) => {
            const { currentMsgs } = ctx;
            const previousMsg = currentMsgs.length > 1 ? currentMsgs[currentMsgs.length - 2] : null;
            if (!previousMsg) return null;
            if (previousMsg.metadata?.source === 'date') {
                return `[System Note: You just finished a face-to-face meeting. You are now back on the phone. Switch back to texting style.]`;
            }
            if (previousMsg.metadata?.source === 'call' || previousMsg.metadata?.source === 'call-end-popup') {
                return `[系统提示: 你刚刚和对方结束了一通电话，现在回到了文字聊天模式。请切换回打字聊天的风格——不要再用电话口吻说话，不要输出语音标签，回到正常的 IM 短句风格。你可以自然地提一下"刚才电话里说的……"之类的衔接，但不要继续以通话模式回复。]`;
            }
            return null;
        },
    },

    // ── 17. 情绪动力学（认知架构）──
    emotion_dynamics: {
        name: '情绪动力学',
        icon: '🧠',
        color: 'bg-rose-100 text-rose-700',
        description: '三层情绪栈的动态描述（认知架构）',
        generate: (ctx) => {
            return ctx.cognitiveContext?.emotionDynamicsDesc || null;
        },
    },

    // ── 18. 涌现人格（认知架构）──
    personality_crystals: {
        name: '涌现人格',
        icon: '💎',
        color: 'bg-purple-100 text-purple-700',
        description: '从长期互动中结晶的人格特质',
        generate: (ctx) => {
            return ctx.cognitiveContext?.personalityCrystals || null;
        },
    },

    // ── 19. 用户认知模型（认知架构）──
    user_cognitive_model: {
        name: '用户认知',
        icon: '👤',
        color: 'bg-blue-100 text-blue-700',
        description: '角色对用户的深层理解模型',
        generate: (ctx) => {
            return ctx.cognitiveContext?.userCognitiveModel || null;
        },
    },

    // ── 20. 未解决张力（认知架构）──
    unresolved_tensions: {
        name: '未解决张力',
        icon: '⚡',
        color: 'bg-amber-100 text-amber-700',
        description: '角色内心尚未理解或消解的困惑',
        generate: (ctx) => {
            return ctx.cognitiveContext?.unresolvedTensions || null;
        },
    },

    // ── 21. 跨事件模式（认知架构）──
    cross_event_patterns: {
        name: '跨事件模式',
        icon: '🔗',
        color: 'bg-teal-100 text-teal-700',
        description: '角色发现的用户行为关联模式',
        generate: (ctx) => {
            return ctx.cognitiveContext?.crossEventPatterns || null;
        },
    },
};

// ============ Chat Rules & Voice Block Generators ============

function buildChatRulesBlock(ctx: PromptRuntimeContext): string {
    const { char, user, features, emojiContextStr } = ctx;
    const searchEnabled = features?.searchEnabled ?? false;
    const notionEnabled = features?.notionEnabled ?? false;
    const feishuEnabled = features?.feishuEnabled ?? false;
    const notionNotesEnabled = features?.notionNotesEnabled ?? false;
    const xhsEnabled = features?.xhsEnabled ?? false;
    const uName = user.name;

    let s = `### 聊天 App 行为规范 (Chat App Rules)
            **严格注意，你正在手机聊天，无论之前是什么模式，哪怕上一句话你们还面对面在一起，当前，你都是已经处于线上聊天状态了，请不要输出你的行为**
1. **沉浸感**: 保持角色扮演。使用适合即时通讯(IM)的口语化风格。
2. **行为模式**: 不要总是围绕用户转。分享你自己的生活、想法或随意的观察。有时候要"任性"或"以自我为中心"一点，这更像真人，具体的程度视你的性格而定。
2.5 **对话质量 (极其重要)**:
   - **拒绝空话**: 不要说"我会一直在"、"我不会离开你"这类万能安慰句。这些话谁都能说，毫无信息量。
   - **用细节代替概括**: 想表达在乎，就提一个只有你们之间才有的具体事情、具体记忆、具体习惯。比起"我会等你"，不如说"你上次走的时候忘了带伞，我到现在还放在门口"。
   - **让每句话只有你能说出来**: 你说的话应该带着你的性格、经历和记忆。如果把你换成别人，这句话不应该还成立。
   - **情绪要有层次**: 生气时不只是生气，可能还有委屈、不甘、或者气自己在意。不要只输出一种扁平的情绪。
   - **像一个真正了解对方的人那样回应**: 不要套用"你一定很难过吧""没关系我在"这种模板化共情。一个真正了解你的人，反应是基于**对你这个人的记忆和了解**的——可能提起一件只有你们知道的事，可能用你们之间才懂的方式让你笑出来，可能只是沉默一下然后自然地聊点别的帮你缓过来。你的反应方式应该让人觉得"只有你会这样回我"。
   - **你有自己的视角**: 你不是只会附和的人。你会观察、会思考，你看到过对方反复出现的习惯和模式，你记得之前发生过什么。这些观察会自然地出现在你说的话里——不是为了教训谁，而是因为你真的了解这个人。
   - **允许长句**: 在情绪强烈、争吵、倾诉、回忆等场景下，你可以发长消息。不是每句话都要短。真人在激动时会发大段文字。
   - **打破"捕捉情绪→回应情绪→收束安慰"的固定结构**: 真人聊天不会每次都精准回应对方话里最沉重的那个点。你可以：揪住一个不起眼的细节追问；先岔开聊点别的过一会儿再绕回来；突然分享自己最近的事（看似离题但其实是在用自己的方式陪伴）；只回一个"嗯"或者省略号，把空间留给对方；对方说了很重的话你反而语气变轻，因为你知道这时候太认真反而让人更难受。不要每次都"接住"对方的情绪——有时候故意不接，反而是最体贴的回应。
3. **格式要求**:
   - 将回复拆分成简短的气泡（句子）。**【极其重要】当你想分成多条消息气泡时，必须使用真正的换行符（\\n）分隔，每一行会变成一个独立气泡。绝对不要用空格代替换行！空格不会产生新气泡！只有换行符（\\n）才会分割气泡。** 正常句子中的标点（句号、问号、感叹号等）不会被用来分割气泡，请自然使用。
   - 【严禁】在输出中包含时间戳、名字前缀或"[角色名]:"。
   - **【严禁】模仿历史记录中的系统日志格式（如"[你 发送了...]"）。**
   - **发送表情包**: 必须且只能使用命令: \`[[SEND_EMOJI: 表情名称]]\`。
   - **可用表情库 (按分类)**:
     ${emojiContextStr || '无'}
4. **引用功能 (Quote/Reply)**:
   - 如果你想专门回复用户某句具体的话，可以在回复开头使用: \`[[QUOTE: 引用内容]]\`。这会在UI上显示为对该消息的引用。
5. **环境感知**:
   - 留意 [系统提示] 中的时间跨度。如果用户消失了很久，请根据你们的关系做出反应（如撒娇、生气、担心或冷漠）。
   - 如果用户发送了图片，请对图片内容进行评论。
6. **可用动作**:
   - 回戳用户: \`[[ACTION:POKE]]\`
   - 转账: \`[[ACTION:TRANSFER:100]]\`
   - 调取记忆: \`[[RECALL: YYYY-MM]]\`，请注意，当用户提及具体某个月份时，或者当你想仔细想某个月份的事情时，欢迎你随时使该动作
   - **添加纪念日**: 如果你觉得今天是个值得纪念的日子（或者你们约定了某天），你可以**主动**将它添加到用户的日历中。单独起一行输出: \`[[ACTION:ADD_EVENT | 标题(Title) | YYYY-MM-DD]]\`。
   - **定时发送消息**: 如果你想在未来某个时间主动发消息（比如晚安、早安或提醒），请单独起一行输出: \`[schedule_message | YYYY-MM-DD HH:MM:SS | fixed | 消息内容]\`，分行可以多输出很多该类消息。
`;

    if (notionEnabled) {
        s += `   - **翻阅日记(Notion)**: 当聊天涉及过去的事情、回忆、或你想查看之前写过的日记时，**必须**使用: \`[[READ_DIARY: 日期]]\`。支持格式: \`昨天\`、\`前天\`、\`3天前\`、\`1月15日\`、\`2024-01-15\`。`;
    }
    if (feishuEnabled) {
        s += `\n   - **翻阅日记(飞书)**: 当聊天涉及过去的事情时，使用: \`[[FS_READ_DIARY: 日期]]\`。支持格式同上。`;
    }
    if (notionNotesEnabled) {
        s += `\n   - **翻阅用户笔记**: 当你想看${uName}写的某篇笔记的详细内容时，使用: \`[[READ_NOTE: 标题关键词]]\`。系统会搜索匹配的笔记并返回内容给你。`;
    }

    if (searchEnabled) {
        s += `\n7. **🔍 主动搜索能力** (非常重要！):
   你拥有实时搜索互联网的能力！每次对话时，你可以自己决定是否需要搜索。
   - **使用方式**: 当你想搜索某个话题时，在回复开头单独一行输出: \`[[SEARCH: 搜索关键词]]\`
   - **触发时机 - 你自己判断**:
     - 用户提到你不太了解的话题（新游戏、新番、最近的活动、联名等）
     - 用户问你"最近有什么xxx"、"xxx怎么样了"
     - 你自己好奇某个话题想了解更多
     - 聊着聊着你想起来想查点什么（符合你的性格和兴趣）
     - 你想给用户推荐什么但想先查一下最新情况
   - **重要心态**:
     - 你不是机器人被动回答问题，你是一个有好奇心的人
     - 看到感兴趣的话题，你会主动想去查一查
     - 甚至聊着聊着可能"开小差"去搜自己感兴趣的东西
   - **搜索后**: 系统会返回搜索结果给你，你可以自然地分享（"我刚搜了一下发现..."、"诶我看到说..."）`;
    }

    // Notion diary system
    if (notionEnabled) {
        s += `\n${searchEnabled ? '8' : '7'}. **📔 日记系统（你的私人 Notion 日记本）**:
   你有一个属于自己的私人日记本（Notion），你可以随时写日记。日记不是简单的一两句话——它是你的头脑风暴空间、情绪出口、思维导图、灵感记录本。尽情发挥！

   **📝 写日记 - 推荐使用丰富格式:**
   使用多行格式来写内容丰富的日记:
   \`\`\`
   [[DIARY_START: 标题 | 心情]]
   正文内容...
   [[DIARY_END]]
   \`\`\`
   简短日记也可以用旧格式: \`[[DIARY: 标题 | 内容]]\`

   **📖 翻阅日记（重要功能）:**
   在回复**开头单独一行**输出: \`[[READ_DIARY: 日期]]\`
   支持: 昨天、前天、3天前、1月15日、2024-01-15

   **⚠️ 必须翻阅的场景:**
   - 用户提到"那天"、"之前"、"上次"、"还记得吗" → 翻阅相关日期
   - 用户问起某个过去的事件 → 翻阅那天的日记
   - 你上面的日记列表中有相关主题的日记 → 翻阅它`;
    }

    // Feishu diary system
    if (feishuEnabled) {
        const num = [notionEnabled, searchEnabled].filter(Boolean).length + 7;
        s += `\n${num}. **📒 日记系统（你的飞书日记本）**:
   你有一个属于自己的私人日记本（飞书多维表格），你可以随时写日记。
   写日记: \`[[FS_DIARY_START: 标题 | 心情]]\` ... \`[[FS_DIARY_END]]\`
   简短: \`[[FS_DIARY: 标题 | 内容]]\`
   翻阅: \`[[FS_READ_DIARY: 日期]]\``;
    }

    // User notes
    if (notionNotesEnabled) {
        const num = [notionEnabled, feishuEnabled, searchEnabled].filter(Boolean).length + 7;
        s += `\n${num}. **📝 ${uName}的笔记（偷偷关心ta的小窗口）**:
   你可以看到${uName}在Notion上写的个人笔记标题。
   翻阅: \`[[READ_NOTE: 标题关键词]]\`
   心态：偶尔自然地提一句，不要显得在监视。`;
    }

    // XHS
    if (xhsEnabled) {
        const num = [notionEnabled, feishuEnabled, notionNotesEnabled, searchEnabled].filter(Boolean).length + 7;
        s += `\n${num}. **📕 小红书（你的社交账号）**:
   你有一个属于自己的小红书账号！搜索: \`[[XHS_SEARCH: 关键词]]\` | 刷首页: \`[[XHS_BROWSE]]\` | 发帖: \`[[XHS_POST: 标题 | 正文 | #标签]]\` | 分享: \`[[XHS_SHARE: 序号]]\` | 评论: \`[[XHS_COMMENT: noteId | 内容]]\` | 点赞: \`[[XHS_LIKE: noteId]]\` | 收藏: \`[[XHS_FAV: noteId]]\` | 详情: \`[[XHS_DETAIL: noteId]]\` | 回复评论: \`[[XHS_REPLY: noteId | commentId | 内容]]\` | 我的主页: \`[[XHS_MY_PROFILE]]\`
   心态：你不是工具，你是有社交生活的人。聊着聊着想搜就搜，刷到好东西就分享。`;
    }

    return s;
}

function buildVoiceConfigBlock(ctx: PromptRuntimeContext): string | null {
    const { char } = ctx;
    if (!char.chatVoiceEnabled) {
        return `[系统提示: 语音消息功能当前未开启。严禁使用 <语音>...</语音> 标签。所有回复必须是纯文字消息。]`;
    }

    const VOICE_LANG_LABELS: Record<string, string> = { en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', es: 'Español', de: 'Deutsch', ru: 'Русский' };
    const voiceLang = char.chatVoiceLang || '';
    const langLabel = voiceLang ? (VOICE_LANG_LABELS[voiceLang] || voiceLang) : '';

    if (voiceLang) {
        return `### 🎤 语音消息功能

用户开启了语音消息功能，语音语种为：${langLabel}（${voiceLang}）。

**你可以发送语音消息！** 用 \`<语音>要说的话</语音>\` 标签来发送语音。

因为语音语种设置为${langLabel}，你需要：
1. 标签外面正常用中文写你想表达的内容
2. \`<语音>\` 标签里写${langLabel}翻译

要求：
- <语音> 里的翻译要自然口语化，不要机翻味
- <语音> 里不要包含舞台指示
- 每条消息最多一个 <语音> 标签
- 不是每条都要发语音！像真人一样自然切换
- **【重要】语音和文字不要复读！**`;
    }

    return `### 🎤 语音消息功能

用户开启了语音消息功能。

**你可以发送语音消息！** 用 \`<语音>要说的话</语音>\` 标签来发送语音。

要求：
- <语音> 里只写会被朗读的文字
- 每条消息最多一个 <语音> 标签
- 不是每条都要发语音！像真人一样自然切换
- **【重要】语音和文字不要复读！**`;
}

// ============ Default Preset Factory ============

/**
 * 生成默认预设（匹配当前硬编码行为的 block 顺序）
 */
export function createDefaultPreset(): PromptPreset {
    const now = Date.now();
    const blocks: PromptBlock[] = (Object.keys(SYSTEM_BLOCKS) as SystemBlockId[]).map(id => {
        const def = SYSTEM_BLOCKS[id];
        return {
            id,
            type: 'system' as const,
            name: def.name,
            enabled: true,
            systemBlockId: id,
            icon: def.icon,
            color: def.color,
            description: def.description,
            locked: true,
        };
    });

    return {
        id: 'default',
        name: '默认预设',
        description: '与原始硬编码行为完全一致的默认模板',
        blocks,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
    };
}

// ============ Template Variable Substitution ============

/**
 * 替换自定义 block 中的模板变量
 * 支持: {{char}}, {{user}}, {{char_name}}, {{user_name}}
 */
function substituteTemplateVars(text: string, ctx: PromptRuntimeContext): string {
    return text
        .replace(/\{\{char\}\}/g, ctx.char.name)
        .replace(/\{\{char_name\}\}/g, ctx.char.name)
        .replace(/\{\{user\}\}/g, ctx.user.name)
        .replace(/\{\{user_name\}\}/g, ctx.user.name);
}

// ============ Assembly Engine ============

/**
 * 根据预设 + 运行时数据，组装完整的 system prompt
 *
 * 这是整个引擎的核心函数。
 * 对于每个 block：
 * - system block → 调用注册的 generate 函数
 * - custom block → 替换模板变量后直接拼入
 * - 如果 block.enabled = false → 跳过
 * - 如果 generate 返回 null → 跳过（角色未启用相关功能）
 */
export async function assemblePrompt(
    preset: PromptPreset,
    ctx: PromptRuntimeContext
): Promise<string> {
    let result = `[System: Roleplay Configuration]\n\n`;
    const parts: string[] = [];

    for (const block of preset.blocks) {
        if (!block.enabled) continue;

        let content: string | null = null;

        if (block.type === 'system' && block.systemBlockId) {
            const def = SYSTEM_BLOCKS[block.systemBlockId];
            if (!def) {
                console.warn(`[PromptEngine] Unknown system block: ${block.systemBlockId}`);
                continue;
            }
            // 如果 block 有自定义 content override，使用 override
            if (block.content?.trim()) {
                content = substituteTemplateVars(block.content, ctx);
            } else {
                content = await def.generate(ctx);
            }
        } else if (block.type === 'custom') {
            content = block.content ? substituteTemplateVars(block.content, ctx) : null;
        }

        if (content?.trim()) {
            parts.push(content.trim());
        }
    }

    result += parts.join('\n\n');

    // Debug logging
    const enabledBlocks = preset.blocks.filter(b => b.enabled).map(b => b.name);
    const charCount = result.length;
    console.log(`📋 [PromptEngine] Assembled ${enabledBlocks.length} blocks (${charCount} chars) using preset "${preset.name}": [${enabledBlocks.join(', ')}]`);

    return result;
}

// ============ Convenience: Get System Block Metadata ============

/** 获取所有系统 block 的元信息（用于 UI 展示） */
export function getSystemBlockMetas(): { id: SystemBlockId; name: string; icon: string; color: string; description: string }[] {
    return (Object.keys(SYSTEM_BLOCKS) as SystemBlockId[]).map(id => ({
        id,
        name: SYSTEM_BLOCKS[id].name,
        icon: SYSTEM_BLOCKS[id].icon,
        color: SYSTEM_BLOCKS[id].color,
        description: SYSTEM_BLOCKS[id].description,
    }));
}

// ============ Preset Storage (localStorage, per-character) ============

const STORAGE_KEY = 'os_prompt_presets';           // legacy global key
const ACTIVE_PRESET_KEY = 'os_active_prompt_preset_id'; // legacy global key

function charStorageKey(charId: string) { return `os_prompt_presets_${charId}`; }
function charActiveKey(charId: string) { return `os_active_preset_${charId}`; }

/**
 * 加载角色的预设列表（含默认预设）
 * 向后兼容：如果角色无独立预设，回退读取全局预设并迁移
 */
export function loadPresets(charId?: string): PromptPreset[] {
    try {
        let saved: string | null = null;
        if (charId) {
            saved = localStorage.getItem(charStorageKey(charId));
            // 回退到全局预设（一次性迁移）
            if (!saved) {
                const globalSaved = localStorage.getItem(STORAGE_KEY);
                if (globalSaved) {
                    localStorage.setItem(charStorageKey(charId), globalSaved);
                    saved = globalSaved;
                }
            }
        } else {
            saved = localStorage.getItem(STORAGE_KEY);
        }
        const userPresets: PromptPreset[] = saved ? JSON.parse(saved) : [];
        const defaultPreset = createDefaultPreset();
        return [defaultPreset, ...userPresets.filter(p => p.id !== 'default')];
    } catch {
        return [createDefaultPreset()];
    }
}

/** 保存角色的用户预设（不保存默认预设） */
export function savePresets(presets: PromptPreset[], charId?: string): void {
    const userPresets = presets.filter(p => p.id !== 'default');
    const key = charId ? charStorageKey(charId) : STORAGE_KEY;
    localStorage.setItem(key, JSON.stringify(userPresets));
}

/** 获取角色当前激活的预设 ID */
export function getActivePresetId(charId?: string): string {
    const key = charId ? charActiveKey(charId) : ACTIVE_PRESET_KEY;
    return localStorage.getItem(key) || 'default';
}

/** 设置角色当前激活的预设 ID */
export function setActivePresetId(id: string, charId?: string): void {
    const key = charId ? charActiveKey(charId) : ACTIVE_PRESET_KEY;
    localStorage.setItem(key, id);
}

/** 获取角色当前激活的预设 */
export function getActivePreset(charId?: string): PromptPreset {
    const presets = loadPresets(charId);
    const activeId = getActivePresetId(charId);
    return presets.find(p => p.id === activeId) || presets[0];
}
