
import { CharacterProfile, UserProfile } from '../types';
import { assemblePromptSync, getActivePreset, PromptRuntimeContext } from './promptEngine';

/** 记忆宫殿检索结果的注入占位符（由 memoryRetrieval.ts 生成，在对话时动态填充） */
let _pendingMemoryInjection: string = '';

/**
 * Memory Central — 现在是预设引擎 (promptEngine) 的薄封装
 *
 * 所有 App（约会、打电话、游戏、群聊等）都通过这里获取角色上下文。
 * 内部走的是和主聊天一样的预设 block 系统，用户在预设里的排序/开关全局生效。
 *
 * async block（实时上下文、Notion/飞书日记等）在同步调用中自动跳过，
 * 因为功能 App 不需要这些仅限主聊天的实时数据。
 */
export const ContextBuilder = {

    /**
     * 构建角色设定+记忆上下文（轻量版，用于情绪评估）
     * 只包含：角色名、核心指令、世界观、月度总结 & 当月日度总结
     * 不走预设系统——情绪评估不需要完整预设，只需最小上下文
     */
    buildRoleSettingsContext: (char: CharacterProfile): string => {
        let context = `[System: Character Role Settings]\n\n`;

        context += `### 角色名\n`;
        context += `${char.name}\n\n`;

        context += `### 核心指令\n`;
        context += `${char.systemPrompt || '你是一个温柔、拟人化的AI伴侣。'}\n\n`;

        if (char.worldview && char.worldview.trim()) {
            context += `### 世界观与设定\n${char.worldview}\n\n`;
        }

        let memorySection = '';
        if (char.refinedMemories && Object.keys(char.refinedMemories).length > 0) {
            memorySection += `**月度总结 (Monthly Summaries)**:\n`;
            Object.entries(char.refinedMemories).sort().forEach(([date, summary]) => {
                memorySection += `- [${date}]: ${summary}\n`;
            });
            memorySection += `\n`;
        }

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
     * 构建核心人设上下文 — 走预设引擎
     *
     * 内部调用 assemblePromptSync()，使用角色当前激活的预设。
     * 用户在预设编辑器里调整的 block 顺序、开关、自定义内容，全部生效。
     *
     * @param char 角色档案
     * @param user 用户档案
     * @param includeDetailedMemories 是否包含激活月份的详细 Log (默认 true)
     * @returns 标准化的 System Prompt 文本
     */
    buildCoreContext: (char: CharacterProfile, user: UserProfile, includeDetailedMemories: boolean = true): string => {
        const preset = getActivePreset(char.id);

        const ctx: PromptRuntimeContext = {
            char,
            user,
            groups: [],
            emojis: [],
            emojiCategories: [],
            currentMsgs: [],
            includeDetailedMemories,
            memoryInjection: _pendingMemoryInjection || undefined,
        };

        const result = assemblePromptSync(preset, ctx);

        console.log(`📋 [ContextBuilder] Delegated to preset "${preset.name}" for ${char.name} | chars=${result.length}`);

        return result;
    },

    /**
     * 设置记忆宫殿注入内容（在对话前由 memoryRetrieval 调用）
     */
    setMemoryInjection: (text: string) => {
        _pendingMemoryInjection = text;
    },

    /** 清除记忆宫殿注入 */
    clearMemoryInjection: () => {
        _pendingMemoryInjection = '';
    },
};
