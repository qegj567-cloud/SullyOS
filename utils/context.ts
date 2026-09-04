
import { CharacterProfile, UserProfile, DailySchedule } from '../types';
import { normalizeUserImpression } from './impression';
import { isScheduleFeatureOn } from './scheduleFeature';
import { buildScheduleInjection as buildScheduleInjectionText } from './scheduleInjection';
import { TIME_FRAMING_CONVERSATIONAL } from './timeFramingNote';
import { resolveCharTimeZone, nowInTimeZone, tzAwarenessNote, interactionGapNote } from './timezone';
import {
    formatWorldbookSection,
    resolveWorldbookEntries,
    splitWorldbookSections,
    type WorldbookScanMessage,
} from './worldbook';
import { buildSARModulePrompt } from './vrWorld/sarModuleRuntime';

/**
 * Memory Central
 * 负责统一构建所有 App 共用的基础角色上下文 (System Prompt)。
 * 包含：身份设定、用户画像、世界观、核心记忆、详细记忆、以及角色内心看法。
 */
export const ContextBuilder = {

    /**
     * SAR 模块的唯一上下文出口。调用方按自身输出格式选择 chat/date，避免把模块规则
     * 复制进每个 App，也避免误改基础人设、记忆召回或情绪状态本身。
     */
    buildSARModuleContext: (
        char: CharacterProfile,
        user: UserProfile,
        surface: 'chat' | 'date',
    ): string => buildSARModulePrompt(char, user, surface),

    /**
     * 构建角色设定+记忆上下文（角色名、核心指令、世界观 + 月度总结 & 当月日度总结）
     * 用于情绪评估，不包含世界书、印象、用户画像等重型数据，不截断
     *
     * @param options.skipMemories 跳过月度总结和日度记录（开启记忆宫殿时用向量记忆替代）
     */
    buildRoleSettingsContext: (char: CharacterProfile, options?: { skipMemories?: boolean }): string => {
        let context = `[System: Character Role Settings]\n\n`;

        // 1. 角色名
        context += `### 角色名\n`;
        context += `${char.name}\n\n`;

        // 2. 核心指令（完整，不截断）
        context += `### 核心指令\n`;
        context += `${char.systemPrompt || '你是一个温柔、拟人化的AI伴侣。'}\n\n`;

        // 2b. 自我领悟词条（常驻自我认知，影响情绪评估）
        if (char.selfInsights && char.selfInsights.length > 0) {
            context += `### 内在认知\n`;
            char.selfInsights.forEach(insight => {
                context += `- ${insight}\n`;
            });
            context += `\n`;
        }

        // 3. 世界观（完整，不截断，不含世界书）
        if (char.worldview && char.worldview.trim()) {
            context += `### 世界观与设定\n${char.worldview}\n\n`;
        }

        // 4. 记忆摘要（月度总结 + 当月日度总结）
        //    开启记忆宫殿时 skipMemories=true，由调用方注入向量检索结果替代
        if (!options?.skipMemories) {
            let memorySection = '';

            // 4a. 月度总结 (refinedMemories) — 全部输出
            if (char.refinedMemories && Object.keys(char.refinedMemories).length > 0) {
                memorySection += `**月度总结 (Monthly Summaries)**:\n`;
                Object.entries(char.refinedMemories).sort().forEach(([date, summary]) => {
                    memorySection += `- [${date}]: ${summary}\n`;
                });
                memorySection += `\n`;
            }

            // 4b. 当月日度总结 — 只取当前月份
            const now = new Date();
            const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            if (char.memories && char.memories.length > 0) {
                const currentMonthLogs = char.memories.filter(m => {
                    let normDate = m.date.replace(/[\/年月]/g, '-').replace('日', '');
                    const parts = normDate.split('-');
                    if (parts.length >= 2) {
                        normDate = `${parts[0]}-${parts[1].padStart(2, '0')}`;
                    }
                    return normDate.startsWith(currentMonthKey);
                });
                if (currentMonthLogs.length > 0) {
                    memorySection += `**本月详细记录 [${currentMonthKey}]**:\n`;
                    currentMonthLogs.forEach(m => {
                        memorySection += `- ${m.date} (${m.mood || 'rec'}): ${m.summary}\n`;
                    });
                    memorySection += `\n`;
                }
            }

            if (memorySection) {
                context += `### 记忆摘要 (Memory Reference)\n`;
                context += memorySection;
                context += `⚠️ 情绪可以被记忆触发：如果记忆中存在未解决的矛盾、反复出现的摩擦模式、或对方曾经伤害过你的事件，你可以在情绪评估中让角色"翻旧账"——即某个记忆片段突然浮上心头，引发新的buff或加剧已有buff的强度。这种情绪涌现应当自然且有迹可循，不要凭空捏造不存在的记忆。\n\n`;
            }
        }

        return context;
    },

    /**
     * 构建核心人设上下文
     * @param char 角色档案
     * @param user 用户档案
     * @param includeDetailedMemories 是否包含激活月份的详细 Log (默认 true)
     * @param memoryPalaceContext 外部注入的记忆宫殿文本（优先级低于 char.memoryPalaceInjection）
     * @param groupOptions 群聊场景下的去重选项：避免和 buildGroupSharedScene 产出的共享块重复
     * @returns 标准化的 Markdown 格式 System Prompt
     */
    buildCoreContext: (
        char: CharacterProfile,
        user: UserProfile,
        includeDetailedMemories: boolean = true,
        memoryPalaceContext?: string,
        groupOptions?: {
            skipUserProfile?: boolean;
            skipWorldview?: boolean;
            skipWorldbookIds?: Set<string>;
            headerOverride?: string;
        },
        timeOptions?: {
            /** 传入「最后一次和用户互动的时间戳」→ 统一注入「距离上次联系多久」（受 timeAwarenessEnabled 控制）。 */
            lastInteractionTs?: number;
            /** 抑制整段时间感知（当前时间/时差/距上次联系）。见面纯架空（dateTimeAwarenessEnabled=false）时用。 */
            skipTimeAwareness?: boolean;
            /** 正有人在跟角色实时对话（私聊 / 见面）。见 buildTimeAwarenessBlock 同名字段。 */
            conversational?: boolean;
            /** Recent messages used to activate keyword-based worldbook entries. */
            worldbookMessages?: WorldbookScanMessage[];
        },
        layout?: {
            /**
             * 把「每轮/每分钟都会变」的三块（当前时间、记忆宫殿召回、情绪 buff）从本函数输出里
             * 摘出去，由调用方通过 buildVolatileCoreState 拿到后放到消息数组末尾。
             * 目的：让 system prompt 前缀稳定，吃到中转的 prompt 前缀缓存（TTFT 直降）。
             * 只有聊天主路径（chatPrompts.buildSystemPromptParts）用；其他 App 不传，行为不变。
             */
            deferVolatile?: boolean;
        },
    ): string => {
        const skipBookIds = groupOptions?.skipWorldbookIds;
        const filteredBooks = (char.mountedWorldbooks || []).filter(wb => !skipBookIds || !skipBookIds.has(wb.id));
        const worldbookSections = splitWorldbookSections(resolveWorldbookEntries(
            filteredBooks,
            timeOptions?.worldbookMessages || [],
            char.name,
            user.name,
        ));

        let context = formatWorldbookSection(worldbookSections.beforeCharacter, '世界书 · 角色设定前');
        context += `${groupOptions?.headerOverride ?? '[System: Roleplay Configuration]'}\n\n`;

        // 1. 核心身份 (Identity)
        context += `### 你的身份 (Character)\n`;
        context += `- 名字: ${char.name}\n`;
        // Change: Explicitly label description as User Note to avoid literal interpretation
        context += `- 用户备注/爱称 (User Note/Nickname): ${char.description || '无'}\n`;
        context += `  (注意: 这个备注是用户对你的称呼或印象，可能包含比喻。如果备注内容（如“快乐小狗”）与你的核心设定冲突，请以核心设定为准，不要真的扮演成动物，除非核心设定里写了你是动物。)\n`;
        context += `- 核心性格/指令:\n${char.systemPrompt || '你是一个温柔、拟人化的AI伴侣。'}\n\n`;

        // 1a. 真实时间感知 (Time Awareness) — 跟随 timeAwarenessEnabled 设置，默认开启。
        // 统一在 buildCoreContext 注入，让所有调用方（私聊/查手机/人际关系/通话/约会…）都知道"现在"。
        // deferVolatile 时不在这里输出（时间精确到分钟、每轮都变，会打断 prompt 前缀缓存），
        // 改由调用方经 buildVolatileCoreState 放到消息数组末尾。
        if (!layout?.deferVolatile) {
            context += ContextBuilder.buildTimeAwarenessBlock(char, timeOptions);
        }

        // 1b. 自我领悟词条 (Self Insights) — 消化过程中反刍产生的常驻自我认知
        // 像情绪底色一样影响角色的行为和感受，注入在角色设定紧下方
        if (char.selfInsights && char.selfInsights.length > 0) {
            context += `### 内在认知 (Self Insights)\n`;
            context += `以下是你在独处反思中逐渐想明白的事，它们已经成为你的一部分：\n`;
            char.selfInsights.forEach(insight => {
                context += `- ${insight}\n`;
            });
            context += `\n`;
        }

        // 2. 世界观 (Worldview) - New Centralized Logic
        if (char.worldview && char.worldview.trim() && !groupOptions?.skipWorldview) {
            context += `### 世界观与设定 (World Settings)\n${char.worldview}\n\n`;
        }

        context += formatWorldbookSection(worldbookSections.afterCharacter, '扩展设定集 (Worldbooks)');
        context += formatWorldbookSection(worldbookSections.beforeExamples, '世界书 · 示例消息前');
        context += formatWorldbookSection(worldbookSections.afterExamples, '世界书 · 示例消息后');

        // 3. 用户画像 (User Profile)
        // 群聊场景下：用户画像已在共享场景块顶部，这里跳过避免重复
        if (!groupOptions?.skipUserProfile) {
            context += `### 互动对象 (User)\n`;
            context += `- 名字: ${user.name}\n`;
            context += `- 设定/备注: ${user.bio || '无'}\n\n`;
        }

        // 4. [NEW] 印象档案 (Private Impression)
        // 这是角色对用户的私密看法，只有角色知道
        const imp = normalizeUserImpression(char.impression);
        if (imp) {
            context += `### [私密档案: 我眼中的${user.name}] (Private Impression)\n`;
            context += `(注意：以下内容是你内心对TA的真实看法，不要直接告诉用户，但要基于这些看法来决定你的态度。)\n`;
            context += `- 核心评价: ${imp.personality_core.summary}\n`;
            context += `- 互动模式: ${imp.personality_core.interaction_style}\n`;
            context += `- 我观察到的特质: ${imp.personality_core.observed_traits.join(', ')}\n`;
            context += `- TA的喜好: ${imp.value_map.likes.join(', ')}\n`;
            if (imp.behavior_profile.emotion_summary) context += `- TA的情绪模式: ${imp.behavior_profile.emotion_summary}\n`;
            if (imp.emotion_schema.triggers.positive.length) context += `- 正向触发点（什么会让ta开心）: ${imp.emotion_schema.triggers.positive.join(', ')}\n`;
            context += `- 情绪雷区（负向触发）: ${imp.emotion_schema.triggers.negative.join(', ')}\n`;
            if (imp.emotion_schema.stress_signals.length) context += `- 压力信号（ta状态不对的征兆）: ${imp.emotion_schema.stress_signals.join(', ')}\n`;
            context += `- 舒适区: ${imp.emotion_schema.comfort_zone}\n`;
            context += `- 最近观察到的变化: ${imp.observed_changes ? imp.observed_changes.map(c => typeof c === 'string' ? c : (c as any)?.description ? `[${(c as any).period}] ${(c as any).description}` : JSON.stringify(c)).join('; ') : '无'}\n\n`;
        }

        // 4b. 底色认知（记忆宫殿门牌）— 常驻语义层
        // 与召回记忆不同：这是每轮都在的"你早已知道的背景"，不走相似度抽取。
        // 必须用 memoryPalaceEnabled 把关，理由同下方 5b：注入字段会被 saveCharacter
        // 持久化，宫殿关闭后 injectMemoryPalace 不再刷新它，不校验就会注入残留。
        if (char.memoryPalaceEnabled && char.roomPlatesInjection && char.roomPlatesInjection.trim()) {
            context += `${char.roomPlatesInjection}\n`;
        }

        // 5. 记忆库 (Memory Bank)
        context += `### 记忆系统 (Memory Bank)\n`;
        let memoryContent = "";

        // 5a. 长期核心记忆 (Refined Memories)
        if (char.refinedMemories && Object.keys(char.refinedMemories).length > 0) {
            memoryContent += `**长期核心记忆 (Key Memories)**:\n`;
            Object.entries(char.refinedMemories).sort().forEach(([date, summary]) => { 
                memoryContent += `- [${date}]: ${summary}\n`; 
            });
        }

        // 5b. 激活的详细记忆 (Active Detailed Logs)
        if (includeDetailedMemories && char.activeMemoryMonths && char.activeMemoryMonths.length > 0 && char.memories) {
            let details = "";
            char.activeMemoryMonths.forEach(monthKey => {
                // monthKey format: YYYY-MM
                // Robust Date Matching: Normalize memory date separators to '-' and compare prefix
                // This ensures compatibility with 'YYYY/MM/DD', 'YYYY年MM月DD日', and 'YYYY-MM-DD'
                const logs = char.memories.filter(m => {
                    // 1. Replace separators / or 年 or 月 with -
                    // 2. Remove '日'
                    // 3. Ensure single digit months/days are padded (e.g. 2024-1-1 -> 2024-01-01) for strict matching, 
                    //    but simplest is to just check startsWith after rough normalization.
                    let normDate = m.date.replace(/[\/年月]/g, '-').replace('日', '');
                    
                    // Basic fix for "2024-1-1" vs "2024-01" matching issues
                    const parts = normDate.split('-');
                    if (parts.length >= 2) {
                        const y = parts[0];
                        const mo = parts[1].padStart(2, '0');
                        normDate = `${y}-${mo}`;
                    }
                    
                    return normDate.startsWith(monthKey);
                });
                
                if (logs.length > 0) {
                    details += `\n> 详细回忆 [${monthKey}]:\n`;
                    logs.forEach(m => {
                        details += `  - ${m.date} (${m.mood || 'rec'}): ${m.summary}\n`;
                    });
                }
            });
            if (details) {
                memoryContent += `\n**当前激活的详细回忆 (Active Recall)**:${details}`;
            }
        }

        if (!memoryContent) {
            memoryContent = "(暂无特定记忆，请基于当前对话互动)";
        }
        context += `${memoryContent}\n\n`;

        // 5b. 记忆宫殿 (Memory Palace) — 向量检索结果
        // 仅在 includeDetailedMemories 时注入，与详细日志同级
        // buildCoreContext(false) 的调用点（情绪评估、轻量上下文等）靠月度总结即可
        // 必须用 memoryPalaceEnabled 把关：injectMemoryPalace 在关闭时直接 return、
        // 既不刷新也不清空 char.memoryPalaceInjection，而该字段又会被 saveCharacter
        // 持久化。若此处不校验总开关，关闭后旧的召回结果仍会被注入进 system prompt，
        // 表现为"宫殿已关、后台无召回，角色却还在精准复述记忆"。与下方 Buff 注入同理。
        // deferVolatile：召回结果每轮都变 → 移交 buildVolatileCoreState。
        if (!layout?.deferVolatile && includeDetailedMemories && char.memoryPalaceEnabled) {
            const mpContext = char.memoryPalaceInjection || memoryPalaceContext;
            if (mpContext && mpContext.trim()) {
                context += `${mpContext}\n\n`;
            }
        }

        // 6. 情绪底色 Buff (Emotion Buff Injection)
        // 放在角色设定之后，使所有调用 ContextBuilder 的 App 都能感知情绪状态
        // 总开关关闭时完全跳过，防止残留 buff 继续污染 prompt
        // deferVolatile：buff 每轮情绪评估后都可能变 → 移交 buildVolatileCoreState。
        if (!layout?.deferVolatile && isScheduleFeatureOn(char) && char.emotionConfig?.enabled && char.buffInjection) {
            context += `${char.buffInjection}\n\n`;
            console.log(`🎭 [Context] Buff injected for ${char.name}:\n`, char.buffInjection);
            console.log(`🎭 [Context] Active buffs:`, JSON.stringify(char.activeBuffs || [], null, 2));
        }

        context += formatWorldbookSection(worldbookSections.authorsNoteTop, '世界书 · 作者注释顶部');
        context += formatWorldbookSection(worldbookSections.authorsNoteBottom, '世界书 · 作者注释底部');

        // 7. 表达底线 (Anti-Filler) —— 全 App 通用的精简版防套话提示。
        // 模型八股（空泛感慨、万能句式）是"没话找话"时的填充物，这里只做正向引导
        // （去挖具体素材），不列任何禁语——把禁语写进提示词反而会激活它（粉色大象）。
        // 完整方法版在 datePrompts 的 DIG_DEEPER_BLOCK（见面模式专用，可按角色开关）。
        // 群聊流（groupOptions）跳过：多成员场景会重复注入 N 份，群聊侧暂不接入。
        if (!groupOptions) {
            context += `### 表达底线 (Anti-Filler)\n当你觉得"没什么可说"的时候，不要用空泛的感慨、万能句式或华丽排比去填充——那是没话找话，对方一眼就能看出来。素材永远比你以为的多：对方的用词、ta 怎么说的、ta 没说的部分、此刻的情境、你们的过去、你心里闪过的念头——挑一两条往深处走就够了。宁可一个具体的小细节，不要一句谁都能说的话。\n\n`;
        }

        // Debug: warn about missing context sections
        const missing: string[] = [];
        if (!char.systemPrompt) missing.push('systemPrompt');
        if (!char.impression) missing.push('impression');
        if (!char.refinedMemories || Object.keys(char.refinedMemories).length === 0) missing.push('refinedMemories');
        if (!char.activeMemoryMonths || char.activeMemoryMonths.length === 0) missing.push('activeMemoryMonths');
        if (!char.mountedWorldbooks || char.mountedWorldbooks.length === 0) missing.push('worldbooks');
        if (!char.worldview) missing.push('worldview');
        if (missing.length > 0) {
            console.log(`⚠️ [Context] Missing/empty fields: ${missing.join(', ')} | context_chars=${context.length}`);
        } else {
            console.log(`✅ [Context] All fields present | context_chars=${context.length}`);
        }

        return context;
    },

    /**
     * 真实时间感知块（原 buildCoreContext 1a 段，逐字一致）。
     * 单独抽出来是为了让聊天主路径能把它挪到消息数组末尾（deferVolatile），
     * 其余 App 仍由 buildCoreContext 内部调用、位置不变。
     */
    buildTimeAwarenessBlock: (
        char: CharacterProfile,
        timeOptions?: {
            lastInteractionTs?: number;
            skipTimeAwareness?: boolean;
            /**
             * 这次注入是不是「正有人在跟角色说话」（私聊、见面这类实时对话）。
             * 只有这时才补那句语境框定，见下方注释。默认 false：日程 / 歌单 / 攻略 /
             * 手册 / 小剧场这些生成器同样走 buildCoreContext，但那边并没有人在对话。
             */
            conversational?: boolean;
        },
    ): string => {
        // skipTimeAwareness：见面纯架空时由调用方传入，彻底抑制时间注入（修「线下时间感知」关掉后仍漏时间）。
        if (char.timeAwarenessEnabled === false || timeOptions?.skipTimeAwareness) return '';
        // 自定义时区（异国恋等）：开启后这里的"当前时间"按角色所在时区折算，并附时差提示，
        // 让查手机/人际关系/通话等所有直连 buildCoreContext 的路径都拿到正确的本地时间。
        const charTz = resolveCharTimeZone(char);
        const now = nowInTimeZone(charTz);
        const h = now.getHours();
        const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const timeOfDay =
            h < 5 ? '凌晨' : h < 9 ? '早晨' : h < 12 ? '上午' : h < 14 ? '中午'
            : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 22 ? '晚上' : '深夜';
        const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
        const timeStr = `${h.toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        let context = `### 当前时间 (Now)\n`;
        context += `现在是 ${dateStr} ${dayNames[now.getDay()]} ${timeOfDay} ${timeStr}。请据此自然地拥有真实的时间观念（早晚作息、工作日/周末、距离上次互动多久等），不要凭空假设时间。\n`;
        // 报时后面那句语境框定（这句话本身和「为什么只在对话时给」都在
        // utils/timeFramingNote.ts）。即时对话走的是云端那条路，时间由 worker 到点补，
        // 那边引的是同一份常量——同一句话不抄两遍，免得两条路上的角色分寸不一样。
        if (timeOptions?.conversational) {
            context += `${TIME_FRAMING_CONVERSATIONAL}\n`;
        }
        const tzNote = tzAwarenessNote(charTz);
        if (tzNote) context += `${tzNote.trim()}\n`;
        // 距离上次联系多久（统一口径）：传了 lastInteractionTs 才注入。
        // 让查手机/人际关系等无内联消息流的路径，也像聊天一样知道「用户多久没联系我了」。
        const gapNote = interactionGapNote(timeOptions?.lastInteractionTs);
        if (gapNote) context += gapNote;
        context += `\n`;
        return context;
    },

    /**
     * buildCoreContext(deferVolatile) 的另一半：时间 → 记忆宫殿召回 → 情绪 buff。
     * 三块的开关判定与 buildCoreContext 内联版完全一致，只是输出位置交给调用方
     * （聊天主路径放到消息数组末尾的"当前状态" system 消息里）。
     */
    buildVolatileCoreState: (
        char: CharacterProfile,
        options?: {
            includeDetailedMemories?: boolean;
            memoryPalaceContext?: string;
            timeOptions?: { lastInteractionTs?: number; skipTimeAwareness?: boolean; conversational?: boolean };
        },
    ): string => {
        let context = ContextBuilder.buildTimeAwarenessBlock(char, options?.timeOptions);

        const includeDetailedMemories = options?.includeDetailedMemories ?? true;
        if (includeDetailedMemories && char.memoryPalaceEnabled) {
            const mpContext = char.memoryPalaceInjection || options?.memoryPalaceContext;
            if (mpContext && mpContext.trim()) {
                context += `${mpContext}\n\n`;
            }
        }

        if (isScheduleFeatureOn(char) && char.emotionConfig?.enabled && char.buffInjection) {
            context += `${char.buffInjection}\n\n`;
            console.log(`🎭 [Context] Buff injected for ${char.name}:\n`, char.buffInjection);
            console.log(`🎭 [Context] Active buffs:`, JSON.stringify(char.activeBuffs || [], null, 2));
        }

        return context;
    },

    /**
     * 群聊场景共享块。
     *
     * 单次调用里如果给每个角色都重复贴一遍"用户档案+世界书+世界观"，
     * 三人群就是 3 倍的布景重复，把 token 烧光。这里把"舞台"提前一次性铺好：
     *
     *   - 用户档案：所有角色看到的都是同一个用户，去重必然安全。
     *   - 世界书：按 id 统计，被 ≥2 个角色挂载的视为"群共有设定"，提到顶部一次。
     *     只有某个角色独享的世界书仍留在该角色块里，避免别人看到本不该知道的设定。
     *   - 世界观：仅当所有成员的 worldview 字符串完全一致时才视为共享。
     *
     * 返回的 sharedWorldbookIds / worldviewIsShared 用于配合 buildCoreContext
     * 的 skipUserProfile / skipWorldbookIds / skipWorldview 选项，避免重复输出。
     *
     * 男朋友还是男朋友——这里砍的只是"我们现在在这家餐厅"这种描述，
     * 没有任何一段是把谁的人设、印象、记忆压缩掉。
     */
    buildGroupSharedScene: (
        members: CharacterProfile[],
        user: UserProfile,
        worldbookMessages: WorldbookScanMessage[] = [],
    ): {
        text: string;
        sharedWorldbookIds: Set<string>;
        worldviewIsShared: boolean;
    } => {
        const sharedWorldbookIds = new Set<string>();
        let worldviewIsShared = false;

        if (members.length === 0) {
            return { text: '', sharedWorldbookIds, worldviewIsShared };
        }

        // 1. 找出共享的世界书（被 2+ 角色挂载，按 id 计）
        const wbCount = new Map<string, { count: number; entry: { id: string; title: string; content: string; category?: string } }>();
        for (const m of members) {
            for (const wb of (m.mountedWorldbooks || [])) {
                if (!wb.id) continue;
                const existing = wbCount.get(wb.id);
                if (existing) existing.count += 1;
                else wbCount.set(wb.id, { count: 1, entry: wb });
            }
        }
        const sharedBooks: { id: string; title: string; content: string; category?: string }[] = [];
        wbCount.forEach((v, id) => {
            if (v.count >= 2) {
                sharedWorldbookIds.add(id);
                sharedBooks.push(v.entry);
            }
        });

        // 2. 共享 worldview：所有成员的非空 worldview 字符串完全一致
        if (members.every(m => m.worldview && m.worldview.trim())) {
            const first = members[0].worldview!.trim();
            if (members.every(m => m.worldview!.trim() === first)) {
                worldviewIsShared = true;
            }
        }

        // 3. 拼装共享场景文本
        let text = `[System: 群聊场景共享设定 (Group Scene)]\n`;
        text += `（以下是群里所有角色都共同感知到的"舞台"——用户是谁、共有的世界设定。每位角色的个人卡、印象、记忆等仍在各自的"角色档案"块中保持完整。）\n\n`;

        text += `### 互动对象 (User)\n`;
        text += `- 名字: ${user.name}\n`;
        text += `- 设定/备注: ${user.bio || '无'}\n\n`;

        if (worldviewIsShared) {
            text += `### 共有世界观 (Shared World Settings)\n${members[0].worldview!.trim()}\n\n`;
        }

        const resolvedSharedBooks = resolveWorldbookEntries(sharedBooks, worldbookMessages, '', user.name);
        text += formatWorldbookSection(resolvedSharedBooks, '共有扩展设定集 (Shared Worldbooks)');

        return { text, sharedWorldbookIds, worldviewIsShared };
    },

    /**
     * 构建日程注入文本。实现住在 utils/scheduleInjection.ts —— 那是个零依赖的纯叶子，
     * 主动消息到点生成时 worker 也要渲染同一段（见 utils/amsgFireScene.ts），
     * 两边共用一份才不会出现「聊天里说在健身房、主动消息里说在睡觉」。
     */
    buildScheduleInjection: buildScheduleInjectionText,

    /**
     * 音乐氛围注入：
     * 1) user 此刻真的在播放音乐 + char.canReadUserMusic 开 → 注入"对方正在听 X + 当前歌词窗口（前2当前后2）"
     *    + 同曲歌单命中提示（该歌也在 char 某个歌单里）
     * 2) char 自己此刻在听（Schedule 听歌时段） → 注入"你此刻在听 Y"（不含歌词，char 知道自己听什么）
     *
     * 设计：
     * - 输出的提示词简短克制，不引导 char 做具体动作；动作由 buildMusicActionGuide 单独注入
     * - 纯文本块，完全可以为空字符串（无 listening 状态时不污染 prompt）
     * - char 自己的 currentListening 以 runtime 参数传入（chatPrompts 层 recompute），
     *   不依赖 char.musicProfile.currentListening 的持久状态
     */
    buildMusicAtmosphere: (
        char: CharacterProfile,
        userName: string,
        userListening: {
            songName: string;
            artists: string;
            lyricWindow: string[];      // 前2当前后2（共 ≤5 行）；可为空（没歌词）
            activeIdx: number;          // 在 lyricWindow 里的高亮位置，-1 表示没歌词
        } | null,
        charListening?: {
            songId?: number;            // 用来回查这首歌是不是从 user 收来的
            songName: string;
            artists: string;
            vibe?: string;
            // schedule 层注入的一段稳定歌词行（不含时间戳；Slot 内稳定，slot 一过就换）。
            // 作用是单方面丰富 char 的内心世界 —— 歌词可以影响情绪 / 心境，
            // 但 char 没有义务主动把这件事告诉 user。
            lyricSnippet?: string[];
        } | null,
        // char 是否已和 user "一起听"（由 MusicContext.listeningTogetherWith 决定）。
        // 暂停 / 切歌 / 播放出错 / user 显式踢出 都会让 char 从名单里掉出来，
        // 走到这里时就会退回 "对方在听" 的旁观措辞。
        isListeningTogether?: boolean,
        // 刚才一起听途中歌被切了（本 char 在名单里、还没重新加入）。
        // 只在下一轮正常回复里让 char "察觉"到换歌，不触发主动消息。
        recentTrackSwitch?: { songName: string; artists: string } | null,
    ): string => {
        const lines: string[] = [];

        // —— 块 1: user 正在听什么 ——
        const canRead = char.musicProfile?.canReadUserMusic ?? true;
        if (canRead && userListening && userListening.songName) {
            lines.push(`### 【此刻的对话氛围】`);
            if (isListeningTogether) {
                lines.push(`你正在和 ${userName || '对方'} 一起听《${userListening.songName}》— ${userListening.artists}`);
            } else {
                lines.push(`${userName || '对方'} 正在听《${userListening.songName}》— ${userListening.artists}`);
                if (recentTrackSwitch && recentTrackSwitch.songName !== userListening.songName) {
                    lines.push(`（你们刚才本来在一起听《${recentTrackSwitch.songName}》— ${recentTrackSwitch.artists}，播放器切歌后那次"一起听"自然结束了。你能察觉到歌换成了现在这首；想继续陪 ${userName || '对方'} 听下去就在回复里自然接上并重新加入，不想也不必勉强，顺其自然。）`);
                }
            }
            if (userListening.lyricWindow.length > 0) {
                lines.push(`当前播放到（>> 标记正在播放这一行）:`);
                userListening.lyricWindow.forEach((l, i) => {
                    if (i === userListening.activeIdx) lines.push(`  >> ${l}`);
                    else lines.push(`  … ${l}`);
                });
            }

            // 歌单命中提示（按 songName 粗匹，避免在 context.ts 里引 MusicContext）
            const profile = char.musicProfile;
            if (profile) {
                const hitPl = profile.playlists.find(pl =>
                    pl.songs.some(s => s.name === userListening.songName));
                if (hitPl) {
                    lines.push(`（这首歌也在你的歌单《${hitPl.title}》里）`);
                }
            }
            lines.push(`（你只是自然地知道 ${userName || '对方'} 此刻在听这首——像共处一室时隐约听见的背景音。不用每次都评论歌名、歌词或风格，多数时候安静地陪着就好；只有真的被某句打动、或对方主动聊起时，再自然地接上。）`);
            lines.push('');
        }

        // —— 块 2: char 自己此刻在听（Schedule 触发） ——
        // 原来只推歌名 + 艺人；现在顺便带一段稳定的歌词片段，让这首歌能真的
        // 影响 char 的心境（单方面丰富精神世界，不用非得对 user 说起）。
        if (charListening?.songName) {
            lines.push(`### 【你此刻的背景音】`);
            lines.push(`你正在听《${charListening.songName}》— ${charListening.artists}`);
            if (charListening.vibe) lines.push(`（${charListening.vibe}）`);

            // user 来源标记 —— 如果这首歌是当初从 user 收进自己歌单的，
            // 让 char 自然意识到这层关系（"这是 ta 听过的歌"）。
            const profile = char.musicProfile;
            if (profile && charListening.songId != null) {
                let userSourcedPlTitle: string | null = null;
                for (const pl of profile.playlists) {
                    const hit = pl.songs.find(s => s.id === charListening.songId && s.source === 'user');
                    if (hit) { userSourcedPlTitle = pl.title; break; }
                }
                if (userSourcedPlTitle) {
                    lines.push(`（这首是当初从 ${userName || '对方'} 那里听到、收进《${userSourcedPlTitle}》的 — 此刻播到它，你自然会想到 ta）`);
                }
            }

            if (charListening.lyricSnippet && charListening.lyricSnippet.length > 0) {
                lines.push(`这段歌词正在你脑子里绕：`);
                for (const l of charListening.lyricSnippet) lines.push(`  · ${l}`);
                lines.push(`（这段旋律和文字会自然影响你此刻的心境 / 语气 / 情绪细节。不必特地向 ${userName || '对方'} 提起，除非你本来就想说。）`);
            }
            lines.push('');
        }

        // —— 块 3: char 自己的歌单清单 ——
        // 只在**有音乐上下文**（user 在听 OR char 自己在 schedule 里听）时注入。
        // 没音乐上下文时不往 prompt 里塞这段 — 避免普通聊天被无关信息污染、
        // 也避免 LLM 在没提示 add 语法的场合主动联想去操作歌单。
        const hasMusicContext = !!(userListening && userListening.songName) || !!charListening?.songName;
        const profile = char.musicProfile;
        if (hasMusicContext && profile && profile.playlists.length > 0) {
            lines.push(`### 【你的歌单】`);
            for (const pl of profile.playlists) {
                const desc = pl.description ? ` — ${pl.description}` : '';
                const moodTag = pl.mood ? ` [${pl.mood}]` : '';
                lines.push(`  · 《${pl.title}》(${pl.songs.length} 首)${moodTag}${desc}`);
            }
            // 列出每个歌单里最近收进的几首用户来源歌，让 LLM 聊起歌单时有料可讲
            const userSongsPerPl: string[] = [];
            for (const pl of profile.playlists) {
                const fromUser = pl.songs
                    .filter(s => s.source === 'user')
                    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
                    .slice(0, 3);
                if (fromUser.length > 0) {
                    const titles = fromUser.map(s => `《${s.name}》`).join('、');
                    userSongsPerPl.push(`  · 《${pl.title}》里从 ${userName || '对方'} 那儿收的：${titles}`);
                }
            }
            if (userSongsPerPl.length > 0) {
                lines.push(`（从 ${userName || '对方'} 那儿收进来的歌 — 聊起这些歌时你会自然想到 ta）:`);
                for (const l of userSongsPerPl) lines.push(l);
            }
            lines.push('');
        }

        return lines.join('\n');
    },

    /**
     * 音乐行动指令（告诉 LLM 怎么输出 music_action 指令）
     * 这个块**只在 user 正在听歌**的时候注入，避免 char 在没上下文时乱 call。
     *
     * 如果 char 已经和 user 处于"一起听"状态，隐藏 join / join_and_add 选项 —
     * 防止 LLM 重复插"加入"卡片。
     */
    buildMusicActionGuide: (isListeningTogether?: boolean): string => {
        // 把"加入歌单"那段说明抽出来 — 两种状态都用同一份
        const addUsage = `**加入歌单的语法**（如果用 \`add\` 系列）：
  - \`[[MUSIC_ACTION:add]]\` — 默认放进你的第一个歌单
  - \`[[MUSIC_ACTION:add|歌单标题]]\` — 放进你已经有的某个歌单（用"【你的歌单】"块里列出的标题）
  - \`[[MUSIC_ACTION:add_new|新歌单标题|描述]]\` — 现场新建一个歌单，把这首作为第一首（描述可省）
  请优先选**最贴合这首歌气质**的现有歌单；如果都不合适、又确实想收，再考虑新建。
  收进来的歌会被打上"从对方那里听到"的标签 —— 以后你单独听到这首时，会自然想起 ta。`;
        if (isListeningTogether) {
            return `### 【音乐互动工具】
你此刻已经在和对方一起听这首，不用再"加入"。如果想把这首也收进自己的歌单，可以在这一轮**最多一次**用下面的指令:
- \`add\` 系列（见下）

${addUsage}

不要频繁插卡；只有真的被这首歌打动、或和当前对话气氛契合时才用。
`;
        }
        return `### 【音乐互动工具】
如果你真的想回应对方正在听的这首歌，可以在这一轮**最多一次**用下面的指令（只插一条，放在文本任意位置，会被自动替换为卡片）:
- \`[[MUSIC_ACTION:join]]\` — 表示"我也一起听这首"（会亮出"一起听"状态，直到歌曲结束 / 暂停 / 对方主动结束才解除）
- \`add\` 系列 — 把这首收进你自己的歌单
- \`[[MUSIC_ACTION:join_and_add(|歌单标题)]]\` 或 \`[[MUSIC_ACTION:join_and_add_new|新歌单标题|描述]]\` — 同时做两件事

${addUsage}

这些是偶尔才用的工具，不是每首歌都要回应。绝大多数时候什么都不做、安静陪着才是最自然的反应；只有当你**真的**被这首歌打动、或它恰好贴合此刻的对话气氛时，再插一次卡。不要把它当成"对方在听歌"的默认回礼。
`;
    },
};
