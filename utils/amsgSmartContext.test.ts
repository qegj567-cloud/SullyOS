import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, Message } from '../types';

vi.mock('./memoryPalace/embedding', async importOriginal => ({
    ...(await importOriginal<typeof import('./memoryPalace/embedding')>()),
    getEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
}));
// 故意让基础语义检索无命中，验证主动消息确实运行实体精确召回，而非仅挂了开关。
vi.mock('./memoryPalace/hybridSearch', () => ({ hybridSearch: vi.fn(async () => []) }));

import { DB } from './db';
import { loadCharacterContextMessages } from './chatContextRange';
import { buildChatRequestPayload, type BuildChatPayloadInput } from './chatRequestPayload';
import { buildFirePack } from './activeMsgClient';
import { getEmbeddings } from './memoryPalace/embedding';
import { MemoryNodeDB } from './memoryPalace/db';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { renderSmartContextGuidance } from './memoryPalace/smartContext';
import { CONVERSATION_ENGAGEMENT_STORAGE_PREFIX } from './memoryPalace/conversationEngagement';

const user = { name: '小明' } as any;
const realtime = { weatherEnabled: false, newsEnabled: false } as any;
const emojis = { all: [], categories: [] };
let serial = 0;
const configure = (enabled: boolean) => localStorage.setItem('os_memory_palace_config', JSON.stringify({
    embedding: { baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test', dimensions: 2 },
    featureFlags: { recallRouter: enabled, interactionAdaptation: enabled, deepEngagement: enabled },
}));

async function fixture(palace = true, texts = ['你还记得雾岚吗？', '我今天又遇到他了！！！']) {
    const char = {
        id: `smart-context-${++serial}`, name: '阿一', memories: [], memoryPalaceEnabled: palace,
        ruminationTendency: 0, timeAwarenessEnabled: false,
        contextRangeMode: 'manual', contextLimit: 200,
        activeMsg2Config: { enabled: true, tasks: [] },
    } as unknown as CharacterProfile;
    await DB.saveCharacter(char);
    for (const content of texts) await DB.saveMessage({
        charId: char.id, role: 'user', type: 'text', content, timestamp: Date.now(),
    } as Message);
    if (palace) await MemoryNodeDB.save({
        id: `${char.id}-memory`, charId: char.id, content: '雾岚陪小明准备过面试。EXACT_ENTITY_MEMORY',
        room: 'user_room', tags: ['雾岚'], entities: [{ name: '雾岚', type: 'person' }],
        importance: 8, mood: 'neutral', embedded: true, createdAt: Date.now() - 86400000,
        lastAccessedAt: Date.now(), accessCount: 0, eventBoxId: null,
    });
    const historyMsgs = await loadCharacterContextMessages(char);
    const input: BuildChatPayloadInput = {
        char, userProfile: user, groups: [], emojis: [], categories: [], historyMsgs,
        contextLimit: 200, recallEntryPoint: 'chat_app', realtimeConfig: realtime,
    };
    return { char, input };
}

beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    configure(true);
    for (const method of ['log', 'groupCollapsed', 'groupEnd'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('主动消息智能语境与普通消息、即时对话的一致性', () => {
    it('相同上下文的两条打包路径包含相同增强记忆和提示词，复用时不重复向量请求', async () => {
        const { char, input } = await fixture();
        const chat = await buildChatRequestPayload(input);
        const chatGuidance = renderSmartContextGuidance(chat.recallTrace);
        expect(chat.palaceRecall?.memoryPalaceInjection).toContain('EXACT_ENTITY_MEMORY');
        expect(chatGuidance).toContain('### 谈话参与原则');
        expect(chatGuidance).toContain('### 此刻的交流节奏');
        expect(chat.fullMessages.some(m => String(m.content).includes(chatGuidance))).toBe(true);

        const fresh = await buildFirePack(char, user, [], realtime, emojis);
        const requests = vi.mocked(getEmbeddings).mock.calls.length;
        const reused = await buildFirePack(char, user, [], realtime, emojis, { palaceRecall: chat.palaceRecall });
        expect(vi.mocked(getEmbeddings).mock.calls.length).toBe(requests);
        expect(reused.template).toBe(fresh.template);
        expect(fresh.template).toContain('EXACT_ENTITY_MEMORY');
        expect(fresh.template).toContain(chatGuidance);
        expect(fresh.template).toContain('已经回应过的不再当作新问题重答');
        expect(fresh.template).toContain('其中“此刻”“这轮”“刚刚”均指那次对话');
        expect(JSON.stringify(fresh)).not.toContain('configSnapshotHash');
        expect(char).not.toHaveProperty('memoryPalaceInjection');
    });

    it('角色已回复后仍分析上一轮用户发言、执行增强检索，保留角色回复且不改谈话状态', async () => {
        const { char, input } = await fixture();
        const chat = await buildChatRequestPayload(input);
        const stateKey = `${CONVERSATION_ENGAGEMENT_STORAGE_PREFIX}${char.id}`;
        const state = localStorage.getItem(stateKey);
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text',
            content: '已经回复过这一轮。ASSISTANT_ALREADY_REPLIED', timestamp: Date.now(),
        } as Message);
        const fresh = await buildFirePack(char, user, [], realtime, emojis);
        const changed = await buildFirePack(char, user, [], realtime, emojis, { palaceRecall: chat.palaceRecall });
        expect(changed.template).toBe(fresh.template);
        expect(fresh.template).toContain('EXACT_ENTITY_MEMORY');
        expect(fresh.template).toContain('ASSISTANT_ALREADY_REPLIED');
        expect(fresh.template).toContain('### 此刻的交流节奏');
        expect(localStorage.getItem(stateKey)).toBe(state);
    });

    it('关闭宫殿仍可分析语境，重复打包不会生成或推进谈话状态', async () => {
        const { char } = await fixture(false, ['之前那件事又有后续了！！！']);
        const first = await buildFirePack(char, user, [], realtime, emojis);
        const second = await buildFirePack(char, user, [], realtime, emojis);
        expect(second.template).toBe(first.template);
        expect(first.template).toContain('### 此刻这句话怎么接');
        expect(first.template).toContain('### 谈话参与原则');
        expect(getEmbeddings).not.toHaveBeenCalled();
        expect(localStorage.getItem(`${CONVERSATION_ENGAGEMENT_STORAGE_PREFIX}${char.id}`)).toBeNull();
    });

    it.each(['image', 'emoji'] as const)('最后一轮只有 %s 时两种构建方式一致，不跨回已经答过的文字轮做实体召回', async type => {
        const { char, input } = await fixture();
        await buildChatRequestPayload(input);
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: '记得，之前一起准备过面试。' } as Message);
        await DB.saveMessage({ charId: char.id, role: 'user', type, content: 'data:image/png;base64,AAAA' } as Message);
        const chat = await buildChatRequestPayload({ ...input, historyMsgs: await loadCharacterContextMessages(char) });
        const fresh = await buildFirePack(char, user, [], realtime, emojis);
        const requests = vi.mocked(getEmbeddings).mock.calls.length;
        const reused = await buildFirePack(char, user, [], realtime, emojis, { palaceRecall: chat.palaceRecall });
        expect(vi.mocked(getEmbeddings).mock.calls.length).toBe(requests);
        expect(reused.template).toBe(fresh.template);
        expect(fresh.template).not.toContain('EXACT_ENTITY_MEMORY');
    });

    it('请求在角色回复之后才构建时，主动消息重新分析上一轮用户发言', async () => {
        const { char, input } = await fixture();
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: '记得雾岚。' } as Message);
        const chat = await buildChatRequestPayload({ ...input, historyMsgs: await loadCharacterContextMessages(char) });
        expect(chat.palaceRecall?.memoryPalaceInjection).not.toContain('EXACT_ENTITY_MEMORY');
        const fresh = await buildFirePack(char, user, [], realtime, emojis);
        const reused = await buildFirePack(char, user, [], realtime, emojis, { palaceRecall: chat.palaceRecall });
        expect(reused.template).toBe(fresh.template);
        expect(reused.template).toContain('EXACT_ENTITY_MEMORY');
    });

    it('关闭智能语境后不复用开启时的增强结果和提示词', async () => {
        const { char, input } = await fixture();
        const chat = await buildChatRequestPayload(input);
        configure(false);
        const fresh = await buildFirePack(char, user, [], realtime, emojis);
        const reused = await buildFirePack(char, user, [], realtime, emojis, { palaceRecall: chat.palaceRecall });
        expect(reused.template).toBe(fresh.template);
        expect(reused.template).not.toContain('EXACT_ENTITY_MEMORY');
        expect(reused.template).not.toContain('【智能语境');
        expect(reused.template).not.toContain('### 谈话参与原则');
    });

    it('关闭时生成的召回不能绕过后来开启的智能语境', async () => {
        configure(false);
        const { char, input } = await fixture();
        const chat = await buildChatRequestPayload(input);
        configure(true);
        const pack = await buildFirePack(char, user, [], realtime, emojis, { palaceRecall: chat.palaceRecall });
        expect(pack.template).toContain('EXACT_ENTITY_MEMORY');
        expect(pack.template).toContain('### 谈话参与原则');
    });

    it('缩小可见范围后不复用范围外召回，也不回读已隐藏用户发言做分析', async () => {
        const { char, input } = await fixture();
        const chat = await buildChatRequestPayload(input);
        const latestId = await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: '晚安。', timestamp: Date.now() } as Message);
        const narrowed = { ...char, contextUserStartMessageId: latestId };
        const pack = await buildFirePack(narrowed, user, [], realtime, emojis, { palaceRecall: chat.palaceRecall });
        expect(pack.template).not.toContain('EXACT_ENTITY_MEMORY');
        expect(pack.template).not.toContain('你还记得雾岚');
        expect(pack.template).not.toContain('### 此刻的交流节奏');
        expect(pack.template).toContain('晚安。');
    });

    it('占位模板不召回、不分析、不注入', async () => {
        const { char } = await fixture();
        const pack = await buildFirePack(char, user, [], realtime, emojis, { templateStub: true });
        expect(pack.template).not.toContain('【智能语境');
        expect(getEmbeddings).not.toHaveBeenCalled();
        expect(localStorage.getItem(`${CONVERSATION_ENGAGEMENT_STORAGE_PREFIX}${char.id}`)).toBeNull();
    });

    it('主动消息开放增强，不扩大其他生成入口范围', async () => {
        const { char, input } = await fixture(false);
        const proactive = await injectMemoryPalace({ ...char }, input.historyMsgs, undefined, user.name, { entryPoint: 'proactive_chat' });
        const other = await injectMemoryPalace({ ...char }, input.historyMsgs, undefined, user.name, { entryPoint: 'world_home' });
        expect(proactive.explicitEntityRecall?.status).toBe('signaled');
        expect(proactive.interactionAdaptation?.status).toBe('observed');
        expect(proactive.deepEngagement?.status).toBe('observed');
        expect(other.explicitEntityRecall?.status).toBe('out_of_scope');
        expect(other.deepEngagement?.status).toBe('out_of_scope');
    });
});
