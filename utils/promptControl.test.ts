import { afterEach, describe, expect, it } from 'vitest';
import { buildChatRequestPayload } from './chatRequestPayload';
import { ChatPrompts } from './chatPrompts';
import {
    DEFAULT_PROMPT_CONTROL_CONFIG,
    PROMPT_CONTROL_STORAGE_KEY,
    makePromptControlSnapshot,
    writePromptControlConfig,
} from './promptControl';
import { recordApiCall } from './apiCallLog';
import { DB } from './db';

const makeChar = () => ({
    id: 'prompt-control-char',
    name: '测试小乖',
    description: 'USER_NOTE_MARKER',
    systemPrompt: 'CORE_PROMPT_MARKER',
    worldview: 'WORLDVIEW_MARKER',
    memories: [{ date: '2026-07-30', mood: 'rec', summary: 'NATIVE_ACTIVE_MEMORY_MARKER' }],
    refinedMemories: { '2026-07': 'NATIVE_MEMORY_SUMMARY_MARKER' },
    activeMemoryMonths: ['2026-07'],
    impression: {
        personality_core: {
            summary: 'PRIVATE_IMPRESSION_MARKER',
            interaction_style: 'PRIVATE_INTERACTION_STYLE_MARKER',
            observed_traits: ['PRIVATE_TRAIT_MARKER'],
        },
        value_map: { likes: ['PRIVATE_LIKE_MARKER'] },
        behavior_profile: { emotion_summary: 'PRIVATE_EMOTION_MARKER' },
        emotion_schema: {
            triggers: { positive: ['PRIVATE_POSITIVE_MARKER'], negative: ['PRIVATE_NEGATIVE_MARKER'] },
            stress_signals: ['PRIVATE_STRESS_MARKER'],
            comfort_zone: 'PRIVATE_COMFORT_MARKER',
        },
        observed_changes: ['PRIVATE_CHANGE_MARKER'],
    },
    memoryPalaceEnabled: true,
    memoryPalaceInjection: 'MEMORY_PALACE_MARKER',
    roomPlatesInjection: 'ROOM_PLATE_MARKER',
    timeAwarenessEnabled: false,
    scheduleFeatureEnabled: false,
    emotionConfig: { enabled: false },
    mountedWorldbooks: [],
} as any);

const baseInput = () => ({
    char: makeChar(),
    userProfile: { name: '测试用户', bio: 'USER_BIO_MARKER' } as any,
    groups: [] as any[],
    emojis: [] as any[],
    categories: [] as any[],
    historyMsgs: [
        { id: 'm1', role: 'user', content: '你好', timestamp: Date.now(), charId: 'prompt-control-char' },
    ] as any[],
    recentMsgsHint: [] as any[],
    contextLimit: 10,
    htmlMode: { enabled: true, customPrompt: 'HTML_CUSTOM_MARKER' },
    thinkingChain: { enabled: true, customPrompt: 'THINKING_CUSTOM_MARKER' },
});

afterEach(() => {
    localStorage.removeItem(PROMPT_CONTROL_STORAGE_KEY);
    return DB.clearApiCallLog();
});

describe('prompt control config', () => {
    it('keeps all main chat prompt modules enabled by default', async () => {
        const payload = await buildChatRequestPayload(baseInput());
        const text = payload.fullMessages.map(m => String(m.content)).join('\n');

        expect(text).toContain('CORE_PROMPT_MARKER');
        expect(text).toContain('MEMORY_PALACE_MARKER');
        expect(text).toContain('HTML_CUSTOM_MARKER');
        expect(text).toContain('THINKING_CUSTOM_MARKER');
        expect(payload.promptControl.modules.find(m => m.key === 'memoryPalace')?.included).toBe(true);
        expect(payload.promptControl.modules.find(m => m.key === 'htmlMode')?.included).toBe(true);
        expect(payload.promptControl.modules.find(m => m.key === 'thinkingChain')?.included).toBe(true);
    });

    it('removes disabled main chat modules from final messages and audit snapshot', async () => {
        writePromptControlConfig({
            ...DEFAULT_PROMPT_CONTROL_CONFIG,
            modules: {
                ...DEFAULT_PROMPT_CONTROL_CONFIG.modules,
                memoryPalace: false,
                htmlMode: false,
                thinkingChain: false,
            },
        });

        const payload = await buildChatRequestPayload(baseInput());
        const text = payload.fullMessages.map(m => String(m.content)).join('\n');

        expect(text).toContain('CORE_PROMPT_MARKER');
        expect(text).not.toContain('MEMORY_PALACE_MARKER');
        expect(text).not.toContain('ROOM_PLATE_MARKER');
        expect(text).not.toContain('HTML_CUSTOM_MARKER');
        expect(text).not.toContain('THINKING_CUSTOM_MARKER');
        expect(payload.flags.htmlActive).toBe(false);
        expect(payload.flags.thinkingActive).toBe(false);
        expect(payload.promptControl.modules.find(m => m.key === 'memoryPalace')).toMatchObject({
            enabled: false,
            included: false,
        });
        expect(payload.promptControl.modules.find(m => m.key === 'htmlMode')).toMatchObject({
            enabled: false,
            included: false,
        });
        expect(payload.promptControl.modules.find(m => m.key === 'thinkingChain')).toMatchObject({
            enabled: false,
            included: false,
        });
    });

    it('removes disabled core context modules from final messages and audit snapshot', async () => {
        writePromptControlConfig({
            ...DEFAULT_PROMPT_CONTROL_CONFIG,
            modules: {
                ...(DEFAULT_PROMPT_CONTROL_CONFIG.modules as any),
                coreIdentity: false,
                worldview: false,
                userProfile: false,
                privateImpression: false,
                nativeMemorySummary: false,
                nativeActiveMemory: false,
                fixedBehaviorRules: false,
            },
        } as any);

        const payload = await buildChatRequestPayload(baseInput());
        const text = payload.fullMessages.map(m => String(m.content)).join('\n');

        expect(text).not.toContain('CORE_PROMPT_MARKER');
        expect(text).not.toContain('USER_NOTE_MARKER');
        expect(text).not.toContain('WORLDVIEW_MARKER');
        expect(text).not.toContain('USER_BIO_MARKER');
        expect(text).not.toContain('PRIVATE_IMPRESSION_MARKER');
        expect(text).not.toContain('PRIVATE_TRAIT_MARKER');
        expect(text).not.toContain('NATIVE_MEMORY_SUMMARY_MARKER');
        expect(text).not.toContain('NATIVE_ACTIVE_MEMORY_MARKER');
        expect(text).not.toContain('聊天 App 行为规范');
        expect(text).not.toContain('表达底线');
        expect(text).not.toContain('回到你自己');
        expect(payload.promptControl.modules.find(m => m.key === 'coreIdentity')).toMatchObject({
            enabled: false,
            included: false,
        });
        expect(payload.promptControl.modules.find(m => m.key === 'worldview')).toMatchObject({
            enabled: false,
            included: false,
        });
        expect(payload.promptControl.modules.find(m => m.key === 'nativeMemorySummary')).toMatchObject({
            enabled: false,
            included: false,
        });
    });

    it('removes empty prompt scaffolds when their controlling modules are disabled', async () => {
        writePromptControlConfig({
            ...DEFAULT_PROMPT_CONTROL_CONFIG,
            modules: {
                ...(DEFAULT_PROMPT_CONTROL_CONFIG.modules as any),
                fixedBehaviorRules: false,
                memoryPalace: false,
                nativeMemorySummary: false,
                nativeActiveMemory: false,
                realtimeState: false,
            },
        } as any);

        const payload = await buildChatRequestPayload(baseInput());
        const text = payload.fullMessages.map(m => String(m.content)).join('\n');

        expect(text).not.toContain('[System: Roleplay Configuration]');
        expect(text).not.toContain('### 记忆系统 (Memory Bank)');
        expect(text).not.toContain('(暂无特定记忆，请基于当前对话互动)');
        expect(text).not.toContain('[System: 实时状态 (Live Context)]');
        expect(payload.promptControl.modules.find(m => m.key === 'fixedBehaviorRules')).toMatchObject({
            enabled: false,
            included: false,
        });
        expect(payload.promptControl.modules.find(m => m.key === 'realtimeState')).toMatchObject({
            enabled: false,
            included: false,
        });
    });

    it('removes mounted worldbook content when the worldbook module is disabled', async () => {
        writePromptControlConfig({
            ...DEFAULT_PROMPT_CONTROL_CONFIG,
            modules: {
                ...(DEFAULT_PROMPT_CONTROL_CONFIG.modules as any),
                worldbook: false,
            },
        } as any);

        const input = baseInput();
        input.char = {
            ...input.char,
            mountedWorldbooks: [{
                id: 'wb-1',
                title: '世界书测试条目',
                content: 'WORLDBOOK_MARKER',
                category: '测试',
            }],
        };
        const payload = await buildChatRequestPayload(input);
        const text = payload.fullMessages.map(m => String(m.content)).join('\n');

        expect(text).not.toContain('WORLDBOOK_MARKER');
        expect(payload.promptControl.modules.find(m => m.key === 'worldbook')).toMatchObject({
            enabled: false,
            included: false,
        });
    });

    it('marks mounted worldbooks as not injected when no entry is triggered this round', async () => {
        const input = baseInput();
        input.char = {
            ...input.char,
            mountedWorldbooks: [{
                id: 'wb-2',
                title: '需要关键词的世界书',
                content: 'WORLDBOOK_SHOULD_NOT_APPEAR',
                category: '测试',
                key: ['TRIGGER_ONLY_WHEN_THIS_WORD_APPEARS'],
                constant: false,
                scanDepth: 4,
            }],
        };

        const payload = await buildChatRequestPayload(input);
        const text = payload.fullMessages.map(m => String(m.content)).join('\n');

        expect(text).not.toContain('WORLDBOOK_SHOULD_NOT_APPEAR');
        expect(payload.promptControl.modules.find(m => m.key === 'worldbook')).toMatchObject({
            enabled: true,
            included: false,
        });
    });

    it('keeps chat voice instructions available when fixed behavior rules are disabled', async () => {
        writePromptControlConfig({
            ...DEFAULT_PROMPT_CONTROL_CONFIG,
            modules: {
                ...(DEFAULT_PROMPT_CONTROL_CONFIG.modules as any),
                fixedBehaviorRules: false,
            },
        } as any);

        const input = baseInput();
        input.char = {
            ...input.char,
            chatVoiceEnabled: true,
            chatVoiceLang: '',
        };
        const payload = await buildChatRequestPayload(input);
        const text = payload.fullMessages.map(m => String(m.content)).join('\n');

        expect(text).toContain('语音消息功能');
        expect(text).not.toContain('聊天 App 行为规范');
        expect(text).not.toContain('表达底线');
        expect(payload.promptControl.modules.find(m => m.key === 'fixedBehaviorRules')).toMatchObject({
            enabled: false,
            included: false,
        });
        expect(payload.promptControl.modules.find(m => m.key === 'voiceMessages')).toMatchObject({
            enabled: true,
            included: true,
        });
    });

    it('keeps time awareness injected when realtime state is disabled', async () => {
        writePromptControlConfig({
            ...DEFAULT_PROMPT_CONTROL_CONFIG,
            modules: {
                ...(DEFAULT_PROMPT_CONTROL_CONFIG.modules as any),
                realtimeState: false,
            },
        } as any);

        const input = baseInput();
        input.char = {
            ...input.char,
            timeAwarenessEnabled: true,
        };
        const payload = await buildChatRequestPayload(input);
        const text = payload.fullMessages.map(m => String(m.content)).join('\n');

        expect(text).toContain('### 当前时间 (Now)');
        expect(text).not.toContain('[System: 实时状态 (Live Context)]');
        expect(payload.promptControl.modules.find((m: any) => m.key === 'timeAwareness')).toMatchObject({
            enabled: true,
            included: true,
        });
        expect(payload.promptControl.modules.find(m => m.key === 'realtimeState')).toMatchObject({
            enabled: false,
            included: false,
        });
    });

    it('removes current time and time-gap hints when time awareness is disabled', async () => {
        writePromptControlConfig({
            ...DEFAULT_PROMPT_CONTROL_CONFIG,
            modules: {
                ...(DEFAULT_PROMPT_CONTROL_CONFIG.modules as any),
                timeAwareness: false,
            },
        } as any);

        const startedAt = Date.UTC(2026, 7, 1, 13, 50);
        const input = baseInput();
        input.char = {
            ...input.char,
            timeAwarenessEnabled: true,
        };
        input.historyMsgs = [
            { id: 'm1', role: 'assistant', content: '晚点见', timestamp: startedAt, charId: 'prompt-control-char' },
            { id: 'm2', role: 'user', content: '早呀', timestamp: startedAt + 10 * 60 * 60 * 1000, charId: 'prompt-control-char' },
        ] as any[];
        const payload = await buildChatRequestPayload(input);
        const text = payload.fullMessages.map(m => String(m.content)).join('\n');

        expect(text).not.toContain('### 当前时间 (Now)');
        expect(text).not.toContain('距离上一条消息');
        expect(payload.promptControl.modules.find((m: any) => m.key === 'timeAwareness')).toMatchObject({
            enabled: false,
            included: false,
        });
    });

    it('uses the previous conversation turn for a user burst time-gap hint', () => {
        const startedAt = Date.UTC(2026, 7, 1, 13, 50);
        const char = {
            ...makeChar(),
            timeAwarenessEnabled: true,
        };
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            [
                { id: 'm1', role: 'assistant', content: '晚点见', timestamp: startedAt, charId: 'prompt-control-char' },
                { id: 'm2', role: 'user', content: '早呀', timestamp: startedAt + 10 * 60 * 60 * 1000, charId: 'prompt-control-char' },
                { id: 'm3', role: 'user', content: '菜长得怎么样', timestamp: startedAt + 10 * 60 * 60 * 1000 + 60 * 1000, charId: 'prompt-control-char' },
            ] as any[],
            10,
            char,
            { name: '测试用户', bio: '' } as any,
            [],
        );

        expect(String(apiMessages[apiMessages.length - 1].content)).toContain('距离上一条消息');
        expect(String(apiMessages[apiMessages.length - 1].content)).toContain('10 小时');
    });
});

describe('prompt control API log snapshot', () => {
    it('persists the per-request prompt module snapshot in API call log entries', async () => {
        await DB.clearApiCallLog();
        const snapshot = makePromptControlSnapshot(
            {
                ...DEFAULT_PROMPT_CONTROL_CONFIG,
                modules: {
                    ...DEFAULT_PROMPT_CONTROL_CONFIG.modules,
                    htmlMode: false,
                },
            },
            { htmlMode: { included: false, note: '已关闭' } },
        );

        recordApiCall({
            url: 'https://api.deepseek.com/v1/chat/completions',
            body: { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] },
            ok: true,
            response: { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
            meta: { appName: '消息', purpose: '聊天回复', promptControl: snapshot } as any,
        });

        await new Promise(resolve => setTimeout(resolve, 20));
        const stored = await DB.getApiCallLog();

        expect(stored[0].promptControl.disabledKeys).toEqual(['htmlMode']);
        expect(stored[0].promptControl.modules.find((m: any) => m.key === 'htmlMode')).toMatchObject({
            enabled: false,
            included: false,
            note: '已关闭',
        });
    });
});
