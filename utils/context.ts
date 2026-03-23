
import { CharacterProfile, UserProfile } from '../types';
import { normalizeUserImpression } from './impression';

/** 记忆宫殿检索结果的注入占位符（由 memoryRetrieval.ts 生成，在对话时动态填充） */
let _pendingMemoryInjection: string = '';

/**
 * Memory Central
 * 负责统一构建所有 App 共用的基础角色上下文 (System Prompt)。
 * 包含：身份设定、用户画像、世界观、核心记忆、详细记忆、以及角色内心看法。
 */
export const ContextBuilder = {

    /**
     * 构建角色设定+记忆上下文（角色名、核心指令、世界观 + 月度总结 & 当月日度总结）
     * 用于情绪评估，不包含世界书、印象、用户画像等重型数据，不截断
     */
    buildRoleSettingsContext: (char: CharacterProfile): string => {
        let context = `[System: Character Role Settings]\n\n`;

        // 1. 角色名
        context += `### 角色名\n`;
        context += `${char.name}\n\n`;

        // 2. 核心指令（完整，不截断）
        context += `### 核心指令\n`;
        context += `${char.systemPrompt || '你是一个温柔、拟人化的AI伴侣。'}\n\n`;

        // 3. 世界观（完整，不截断，不含世界书）
        if (char.worldview && char.worldview.trim()) {
            context += `### 世界观与设定\n${char.worldview}\n\n`;
        }

        // 4. 记忆摘要（月度总结 + 当月日度总结）
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

        return context;
    },

    /**
     * 构建核心人设上下文
     * @param char 角色档案
     * @param user 用户档案
     * @param includeDetailedMemories 是否包含激活月份的详细 Log (默认 true)
     * @returns 标准化的 Markdown 格式 System Prompt
     */
    buildCoreContext: (char: CharacterProfile, user: UserProfile, includeDetailedMemories: boolean = true): string => {
        let context = `[System: Roleplay Configuration]\n\n`;

        // 1. 核心身份 (Identity)
        context += `### 你的身份 (Character)\n`;
        context += `- 名字: ${char.name}\n`;
        // Change: Explicitly label description as User Note to avoid literal interpretation
        context += `- 用户备注/爱称 (User Note/Nickname): ${char.description || '无'}\n`;
        context += `  (注意: 这个备注是用户对你的称呼或印象，可能包含比喻。如果备注内容（如“快乐小狗”）与你的核心设定冲突，请以核心设定为准，不要真的扮演成动物，除非核心设定里写了你是动物。)\n`;
        context += `- 核心性格/指令:\n${char.systemPrompt || '你是一个温柔、拟人化的AI伴侣。'}\n\n`;

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
            context += `- 情绪雷区: ${imp.emotion_schema.triggers.negative.join(', ')}\n`;
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

        // 6. 记忆宫殿注入 (Memory Palace — 向量检索结果)
        // 由 memoryRetrieval.retrieveRelevantMemories() 在对话前填充
        if (_pendingMemoryInjection) {
            context += _pendingMemoryInjection + '\n';
        }

        // 7. 情绪底色 Buff (Emotion Buff Injection)
        // 放在角色设定之后，使所有调用 ContextBuilder 的 App 都能感知情绪状态
        if (char.emotionConfig?.enabled && char.buffInjection) {
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
     * 设置记忆宫殿注入内容（在对话前由 memoryRetrieval 调用）
     * 每次 buildCoreContext 后自动清空，避免重复注入
     */
    setMemoryInjection: (text: string) => {
        _pendingMemoryInjection = text;
    },

    /** 清除记忆宫殿注入 */
    clearMemoryInjection: () => {
        _pendingMemoryInjection = '';
    },
};
