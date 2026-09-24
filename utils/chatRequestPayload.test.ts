import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { buildChatRequestPayload } from './chatRequestPayload';
import type { BuildChatPayloadInput } from './chatRequestPayload';
import { RealtimeContextManager } from './realtimeContext';
import { installSARModuleOnCharacter, installSARModuleOnUser } from './vrWorld/sarModuleRuntime';
import { SAR_MODULE_CATALOG } from './vrWorld/sarModuleShop';
import { ChatPrompts } from './chatPrompts';

// 即时对话（这一轮交给用户自己的 amsg worker 生成）那份 prompt 里，凡是 worker 到点
// 会自己补一遍的时效段，前端就不再烤进去：当前时间块、【真实世界感知系统】（节日 /
// 天气 / 热搜）、MCP 工具说明。两边都写的话，模型在同一份 prompt 里看到两个钟、两份
// 互不重叠的热搜（前端快照版 + worker 现拉版）、两套工具名。
//
// 本地私有的易变段（记忆宫殿召回、情绪 buff、音乐、群聊背景、日程、彼方、小程序）照常
// 保留——它们在发送那一刻是新鲜的，而 worker 拿不到。

const MCP_SERVERS_KEY = 'aetheros.mcp.servers';

const userProfile = { name: '小明' } as any;

const realtimeConfig = { weatherEnabled: true, newsEnabled: true } as any;

const baseInput = (): BuildChatPayloadInput => ({
    char: { id: 'char-timely', name: '阿一' } as any,
    userProfile,
    groups: [],
    emojis: [],
    categories: [],
    historyMsgs: [
        { id: 1, charId: 'char-timely', role: 'user', type: 'text', content: '在吗', timestamp: Date.now() },
    ] as any[],
    contextLimit: 20,
    realtimeConfig,
});

const joinMessages = (messages: Array<{ content: any }>): string =>
    messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

it('keeps this request history when the archive waterline advances during async prompt construction', async () => {
    const input = baseInput();
    input.char = { ...input.char, autoArchiveEnabled: true, contextRangeMode: 'adaptive' };
    const key = `mp_lastMsgId_${input.char.id}`;
    localStorage.setItem(key, '0');
    const original = ChatPrompts.buildSystemPromptParts;
    vi.spyOn(ChatPrompts, 'buildSystemPromptParts').mockImplementation(async (...args) => {
        const result = await original(...args);
        localStorage.setItem(key, '99999');
        return result;
    });
    try {
        const payload = await buildChatRequestPayload(input);
        expect(payload.cleanedApiMessages.some(m => m.role === 'user' && String(m.content).includes('在吗'))).toBe(true);
        // 新请求仍须遵守推进后的水位，不能把快照变成永久绕过。
        const next = await buildChatRequestPayload(input);
        expect(next.cleanedApiMessages).toEqual([]);
    } finally { localStorage.removeItem(key); }
});

beforeEach(() => {
    // 天气/热搜真去联网太慢也不稳定，桩成固定内容；测的是「这一段进没进 prompt」。
    vi.spyOn(RealtimeContextManager, 'fetchWeather').mockResolvedValue({
        city: '上海', description: '晴', temp: 31, feelsLike: 35, humidity: 60,
    } as any);
    vi.spyOn(RealtimeContextManager, 'fetchNews').mockResolvedValue([
        { title: '某某官宣', source: '微博' },
    ] as any);
    // MCP 工具块要有内容才测得出来：塞一台已发现工具的服务器（isMcpChatAvailable 读它）。
    localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify([
        { id: 'mcp-1', name: '天气台', url: 'https://mcp.example.com/sse', enabled: true, tools: [{ name: 'get_weather' }] },
    ]));
});

afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(MCP_SERVERS_KEY);
});

describe('timelyByWorker —— 时效段交给 worker，前端这份不重复烤', () => {
    it('ChatApp 格式以简短 TOP 1 规则置于行为规范最前', async () => {
        const payload = await buildChatRequestPayload({ ...baseInput() });
        const systemPrompt = String(payload.fullMessages[0]?.content || '');
        const topRule = '**TOP 1｜ChatApp 格式（本节最高优先级）**';
        expect(systemPrompt).toContain(topRule);
        expect(systemPrompt.indexOf(topRule)).toBeLessThan(systemPrompt.indexOf('1. **沉浸感**'));
        expect(systemPrompt).toContain('你是发消息的真实存在，以自然短句、短气泡为主；一个气泡一行，气泡间直接另起一行（实际换行，不要输出“\\n”字样）。');
        expect(systemPrompt).toContain('每行渲染为一个气泡；空格和标点不会拆泡');
    });

    it('timelyByWorker: 时钟与真实世界块不进 volatileTail，MCP 块与 tail reminder 不注入', async () => {
        const withMode = await buildChatRequestPayload({ ...baseInput(), timelyByWorker: true });
        const joined = joinMessages(withMode.fullMessages);
        expect(joined).not.toContain('### 当前时间 (Now)');
        expect(joined).not.toContain('【真实世界感知系统】');
        expect(joined).not.toContain('【今日特殊】');
        expect(joined).not.toContain('[外部工具已接入');
        expect(joined).not.toContain('[MCP 工具 ON');
        // 本地私有段仍在（抽一个代表：实时状态框定行本身还在，说明 volatile 段没被整段砍掉）
        expect(joined).toContain('[System: 实时状态 (Live Context)]');
        // 只掐文字注入，不改「这一轮算不算 MCP 模式」——上层还靠它决定要不要带 tools。
        expect(withMode.flags.mcpChatActive).toBe(true);
    });

    it('默认构建（不带 timelyByWorker）行为不变：时间块照常注入', async () => {
        const normal = await buildChatRequestPayload({ ...baseInput() });
        const joined = joinMessages(normal.fullMessages);
        expect(joined).toContain('### 当前时间 (Now)');
        // 上一条的 not.toContain 要有意义，得先确认默认构建里这几段真的在
        expect(joined).toContain('【真实世界感知系统】');
        expect(joined).toContain('[外部工具已接入');
        expect(joined).toContain('[MCP 工具 ON');
        expect(normal.flags.mcpChatActive).toBe(true);
    });

    it('只裁文本不动 flag：mcpChatActive 照实反映有没有 MCP 可用', async () => {
        // 上层还要靠这个 flag 决定请求带不带 tools、出错了要不要按 MCP 那套降级重试。
        // 跟着文字注入一起掐掉的话，这些判断会全部读成「这一轮没有 MCP」。
        const withMcp = await buildChatRequestPayload({ ...baseInput(), timelyByWorker: true });
        expect(withMcp.flags.mcpChatActive).toBe(true);

        localStorage.removeItem(MCP_SERVERS_KEY);
        const withoutMcp = await buildChatRequestPayload({ ...baseInput(), timelyByWorker: true });
        expect(withoutMcp.flags.mcpChatActive).toBe(false);
    });

    it('关掉天气热搜时的「今日特殊」节日兜底同样交给 worker', async () => {
        // 天气/热搜关着时，前端只补一条节日行。worker 的 realtimeWorld 里也有节日
        // （跟着角色的时间感知开关走），两边都写就会看到两遍「今天是七夕」。
        vi.spyOn(RealtimeContextManager, 'checkSpecialDates').mockReturnValue(['七夕'] as any);
        const quietConfig = { weatherEnabled: false, newsEnabled: false } as any;

        const normal = await buildChatRequestPayload({ ...baseInput(), realtimeConfig: quietConfig });
        expect(joinMessages(normal.fullMessages)).toContain('【今日特殊】');

        const withMode = await buildChatRequestPayload({
            ...baseInput(), realtimeConfig: quietConfig, timelyByWorker: true,
        });
        expect(joinMessages(withMode.fullMessages)).not.toContain('【今日特殊】');
    });

    it('M2 只把当下交流节奏注入 ChatApp，不进入其他 App 的写作提示', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { interactionAdaptation: true },
        }));
        const energeticInput = {
            ...baseInput(),
            char: { id: 'char-timely', name: '阿一', memoryPalaceEnabled: false } as any,
            historyMsgs: [
                { id: 1, charId: 'char-timely', role: 'user', type: 'text', content: '我过啦！！！', timestamp: Date.now() },
            ] as any[],
        };

        const chatApp = await buildChatRequestPayload({
            ...energeticInput,
            recallEntryPoint: 'chat_app',
        });
        const anotherApp = await buildChatRequestPayload({
            ...energeticInput,
            recallEntryPoint: 'world_home',
        });

        expect(joinMessages(chatApp.fullMessages)).toContain('### 此刻的交流节奏');
        expect(joinMessages(anotherApp.fullMessages)).not.toContain('### 此刻的交流节奏');
        localStorage.removeItem('os_memory_palace_config');
    });

    it('M3 v2 只把谈话参与策略注入 ChatApp', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        const depthInput = {
            ...baseInput(),
            char: { id: 'char-timely', name: '测试角色', memoryPalaceEnabled: false } as any,
            historyMsgs: [
                {
                    id: 1,
                    charId: 'char-timely',
                    role: 'user',
                    type: 'text',
                    content: '我想认真分析一个虚构规则：它一边要求开放，一边不断增加限制，这背后的逻辑是什么？',
                    timestamp: Date.now(),
                },
            ] as any[],
        };

        const chatApp = await buildChatRequestPayload({ ...depthInput, recallEntryPoint: 'chat_app' });
        const anotherApp = await buildChatRequestPayload({ ...depthInput, recallEntryPoint: 'world_home' });

        expect(joinMessages(chatApp.fullMessages)).toContain('### 当前谈话参与策略');
        expect(joinMessages(chatApp.fullMessages)).toContain('### 谈话参与原则');
        expect(joinMessages(chatApp.fullMessages)).toContain('对方出现负面情绪，不代表当前谈话的目标是消除这种情绪');
        expect(joinMessages(chatApp.fullMessages)).toContain('情绪是谈话的一部分，不应覆盖谈话本身');
        expect(joinMessages(anotherApp.fullMessages)).not.toContain('### 当前谈话参与策略');
        expect(joinMessages(anotherApp.fullMessages)).not.toContain('### 谈话参与原则');
        localStorage.removeItem('os_memory_palace_config');
    });

    it('M3 v2 的核心原则不依赖当轮是否命中 opening', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        const payload = await buildChatRequestPayload({
            ...baseInput(),
            char: { id: 'char-m3-core', name: '测试角色', memoryPalaceEnabled: false } as any,
            historyMsgs: [{
                id: 102,
                charId: 'char-m3-core',
                role: 'user',
                type: 'text',
                content: '这个函数返回什么？',
                timestamp: Date.now(),
            }] as any[],
            recallEntryPoint: 'chat_app',
        });
        const joined = joinMessages(payload.fullMessages);

        expect(joined).toContain('### 谈话参与原则');
        expect(joined).toContain('对方出现负面情绪，不代表当前谈话的目标是消除这种情绪');
        expect(joined).toContain('先听见，再了解，再形成看法');
        expect(joined).not.toContain('### 当前谈话参与策略');
        localStorage.removeItem('os_memory_palace_config');
    });

    it('M3 关闭时不注入核心原则', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: false },
        }));
        const payload = await buildChatRequestPayload({
            ...baseInput(),
            recallEntryPoint: 'chat_app',
        });

        expect(joinMessages(payload.fullMessages)).not.toContain('### 谈话参与原则');
        localStorage.removeItem('os_memory_palace_config');
    });

    it('M3 v2 会把“我很累，事情很多”识别为尚未讲完的 opening', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        const payload = await buildChatRequestPayload({
            ...baseInput(),
            char: { id: 'char-opening', name: '测试角色', memoryPalaceEnabled: false } as any,
            historyMsgs: [{
                id: 101,
                charId: 'char-opening',
                role: 'user',
                type: 'text',
                content: '我很累，事情很多。',
                timestamp: Date.now(),
            }] as any[],
            recallEntryPoint: 'chat_app',
        });
        const joined = joinMessages(payload.fullMessages);

        expect(joined).toContain('### 当前谈话参与策略');
        expect(joined).toContain('对方正在开启一件还没有讲完的事情');
        expect(joined).toContain('不要用“别想了”“回来就好”“一切都会过去”');
        expect(joined).not.toContain('### 此刻的交流深度');
    });

    it('角色和 User 都没有模块时，Chat prompt 不增加 SAR 文本或输出容器', async () => {
        const payload = await buildChatRequestPayload({
            ...baseInput(),
            char: {
                id: 'char-sar-empty',
                name: '测试角色',
                memoryPalaceEnabled: false,
                vrState: { enabled: true, intervalMinutes: 120 },
            } as any,
            userProfile: { ...userProfile, vrState: { enabled: true } } as any,
            recallEntryPoint: 'chat_app',
        });
        const joined = joinMessages(payload.fullMessages);

        expect(payload.flags.sarModuleActive).toBe(false);
        expect(joined).not.toContain('### SAR 临时模块');
        expect(joined).not.toContain('<SAR_MODULE_OUTPUT>');
        expect(joined).not.toContain('[SAR MODULE REMINDER:');
    });

    it('SAR 与内置翻译同时开启时，以 SAR 为外层、翻译标签留在两个内容字段内', async () => {
        const runtime = installSARModuleOnCharacter(SAR_MODULE_CATALOG[0], 1);
        const payload = await buildChatRequestPayload({
            ...baseInput(),
            char: {
                id: 'char-sar-bilingual',
                name: '测试角色',
                memoryPalaceEnabled: false,
                vrState: { enabled: true, intervalMinutes: 120, sarModule: runtime },
            } as any,
            userProfile: { ...userProfile, vrState: { enabled: true } } as any,
            historyMsgs: [{
                id: 201,
                charId: 'char-sar-bilingual',
                role: 'user',
                type: 'text',
                content: '你怎么说话怪怪的？',
                timestamp: Date.now(),
            }] as any[],
            recallEntryPoint: 'chat_app',
            translationConfig: { enabled: true, sourceLang: '日语', targetLang: '中文' },
        });
        const joined = joinMessages(payload.fullMessages);

        expect(payload.flags.sarModuleActive).toBe(true);
        expect(payload.flags.bilingualActive).toBe(true);
        expect(joined).toContain('最外层必须是 <SAR_MODULE_OUTPUT>');
        expect(joined).toContain('CHAR_TRUE 和 CHAR_SURFACE 内的每个气泡');
        expect(joined).toContain('原文/译文语义一致');
    });
});

describe('volatileTailIndex —— 想插在钢印之前的块按它定位', () => {
    it('指向易变尾段那条 system，「回到你自己」在它末尾', async () => {
        const payload = await buildChatRequestPayload({ ...baseInput() });
        // 排程清单这类「有用但不该抢最后一眼」的块插在这个下标前；下标要是错位了，
        // 块会落进历史消息中间（读起来像用户说的话）或者又跑到钢印后面去。
        expect(payload.volatileTailIndex).toBeGreaterThan(0);
        const tail = payload.fullMessages[payload.volatileTailIndex];
        expect(tail?.role).toBe('system');
        expect(String(tail?.content)).toContain('回到你自己');
        // 它前面一条是本轮用户消息（前缀缓存的断点在那儿，插入不影响命中）
        expect(payload.fullMessages[payload.volatileTailIndex - 1]?.role).toBe('user');
    });
});

it('ChatApp user modules explicitly identify the pending messages without changing other callers', async () => {
    const input = baseInput();
    input.userProfile = { ...input.userProfile, vrState: { enabled: true, sarModule: installSARModuleOnUser(SAR_MODULE_CATALOG[0], input.char, 1) } } as any;
    const chat = await buildChatRequestPayload({ ...input, recallEntryPoint: 'chat_app' });
    const request = chat.fullMessages.find(m => typeof m.content === 'string' && m.content.startsWith('USER_SURFACE 的聊天专用格式'));
    expect(request?.content).toContain(JSON.stringify(input.historyMsgs.map(({ id, content }) => ({ id, content }))));
    const other = await buildChatRequestPayload(input);
    expect(joinMessages(other.fullMessages)).not.toContain('USER_SURFACE 的聊天专用格式');
});
