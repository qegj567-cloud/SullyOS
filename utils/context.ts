
import { CharacterProfile, UserProfile, DailySchedule } from '../types';
import { normalizeUserImpression } from './impression';
import { getFlowNarrativeKey, isScheduleFeatureOn } from './scheduleGenerator';

/**
 * Memory Central
 * 负责统一构建所有 App 共用的基础角色上下文 (System Prompt)。
 * 包含：身份设定、用户画像、世界观、核心记忆、详细记忆、以及角色内心看法。
 */
export const ContextBuilder = {

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
     * @returns 标准化的 Markdown 格式 System Prompt
     */
    buildCoreContext: (char: CharacterProfile, user: UserProfile, includeDetailedMemories: boolean = true, memoryPalaceContext?: string): string => {
        let context = `[System: Roleplay Configuration]\n\n`;

        // 1. 核心身份 (Identity)
        context += `### 你的身份 (Character)\n`;
        context += `- 名字: ${char.name}\n`;
        // Change: Explicitly label description as User Note to avoid literal interpretation
        context += `- 用户备注/爱称 (User Note/Nickname): ${char.description || '无'}\n`;
        context += `  (注意: 这个备注是用户对你的称呼或印象，可能包含比喻。如果备注内容（如“快乐小狗”）与你的核心设定冲突，请以核心设定为准，不要真的扮演成动物，除非核心设定里写了你是动物。)\n`;
        context += `- 核心性格/指令:\n${char.systemPrompt || '你是一个温柔、拟人化的AI伴侣。'}\n\n`;

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
        if (char.worldview && char.worldview.trim()) {
            context += `### 世界观与设定 (World Settings)\n${char.worldview}\n\n`;
        }

        // [NEW] 挂载的世界书 (Mounted Worldbooks) - GROUPED BY CATEGORY
        if (char.mountedWorldbooks && char.mountedWorldbooks.length > 0) {
            context += `### 扩展设定集 (Worldbooks)\n`;
            
            // Group books by category
            const groupedBooks: Record<string, typeof char.mountedWorldbooks> = {};
            char.mountedWorldbooks.forEach(wb => {
                const cat = wb.category || '通用设定 (General)';
                if (!groupedBooks[cat]) groupedBooks[cat] = [];
                groupedBooks[cat].push(wb);
            });

            // Output grouped content
            Object.entries(groupedBooks).forEach(([category, books]) => {
                context += `#### [${category}]\n`;
                books.forEach(wb => {
                    context += `**Title: ${wb.title}**\n${wb.content}\n---\n`;
                });
                context += `\n`;
            });
        }

        // 3. 用户画像 (User Profile)
        context += `### 互动对象 (User)\n`;
        context += `- 名字: ${user.name}\n`;
        context += `- 设定/备注: ${user.bio || '无'}\n\n`;

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
        if (includeDetailedMemories) {
            const mpContext = char.memoryPalaceInjection || memoryPalaceContext;
            if (mpContext && mpContext.trim()) {
                context += `${mpContext}\n\n`;
            }
        }

        // 6. 情绪底色 Buff (Emotion Buff Injection)
        // 放在角色设定之后，使所有调用 ContextBuilder 的 App 都能感知情绪状态
        // 总开关关闭时完全跳过，防止残留 buff 继续污染 prompt
        if (isScheduleFeatureOn(char) && char.emotionConfig?.enabled && char.buffInjection) {
            context += `${char.buffInjection}\n\n`;
            console.log(`🎭 [Context] Buff injected for ${char.name}:\n`, char.buffInjection);
            console.log(`🎭 [Context] Active buffs:`, JSON.stringify(char.activeBuffs || [], null, 2));
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
     * 构建日程注入文本
     *
     * 两段式，独立叠加：
     * 1) 当前时段硬事实——每轮都注入，不受 evolvedNarrative 影响
     * 2) 意识流独白——evolvedNarrative > flowNarrative > 当前 slot innerThought
     */
    buildScheduleInjection: (schedule: DailySchedule | null, evolvedNarrative?: string): string => {
        if (!schedule || !schedule.slots || schedule.slots.length === 0) return '';

        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        // 1. 计算当前 / 下一个时段
        let currentSlot: typeof schedule.slots[0] | null = null;
        let nextSlot: typeof schedule.slots[0] | null = null;
        for (let i = schedule.slots.length - 1; i >= 0; i--) {
            const [h, m] = schedule.slots[i].startTime.split(':').map(Number);
            if (currentMinutes >= h * 60 + m) {
                currentSlot = schedule.slots[i];
                nextSlot = i < schedule.slots.length - 1 ? schedule.slots[i + 1] : null;
                break;
            }
        }
        if (!currentSlot) {
            nextSlot = schedule.slots[0];
        }

        // 2. 当前时段硬事实（每轮独立注入）
        let slotHeader = '';
        if (currentSlot) {
            slotHeader = `当前时段：${currentSlot.startTime} 你正在${currentSlot.activity}`;
            if (currentSlot.location) slotHeader += `（${currentSlot.location}）`;
            if (nextSlot) slotHeader += `\n之后安排：${nextSlot.startTime} ${nextSlot.activity}`;
            slotHeader += '\n';
        } else if (nextSlot) {
            slotHeader = `今天还没开始活动，稍后先${nextSlot.activity}（${nextSlot.startTime}）\n`;
        }

        // 3. 意识流独白
        let narrative = '';
        if (evolvedNarrative) {
            narrative = evolvedNarrative;
        } else if (schedule.flowNarrative && Object.keys(schedule.flowNarrative).length > 0) {
            const key = getFlowNarrativeKey(now.getHours());
            narrative = schedule.flowNarrative[key]
                || schedule.flowNarrative['evening']
                || schedule.flowNarrative['afternoon']
                || schedule.flowNarrative['morning']
                || '';
        } else if (currentSlot?.innerThought) {
            narrative = currentSlot.innerThought;
        }

        // 4. 拼接：硬事实 → 意识流（可选）
        const preamble = `此刻你的心中盘旋着这些想法……\n`;
        const footnote = `\n（不是台词，不用说出口——让它自然地染进语气和情绪里就好。）`;

        let out = slotHeader;
        if (narrative) {
            out += preamble + narrative + footnote;
        }
        out += '\n';
        return out;
    },

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

        // —— 块 3: char 自己的歌单清单（独立于 user 听歌状态）——
        // 之前这段塞在块 1 里，只有 user 在听歌时 char 才"记得"自己有什么歌单 ——
        // 但 char 平时聊天里也可能被问到 / 主动提起自己的歌单，这份自我认知应该是常驻的。
        // 只要 char 已初始化音乐人格就注入；内容保持克制（标题 + 数量 + mood + 一句描述）。
        const profile = char.musicProfile;
        if (profile && profile.playlists.length > 0) {
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
