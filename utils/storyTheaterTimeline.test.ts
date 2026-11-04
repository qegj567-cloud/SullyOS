import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, FullBackupData, Message } from '../types';
import { DB, openDB } from './db';
import * as StoryTheater from './storyTheater';
import { loadCharacterContextRange } from './chatContextRange';
import { buildChatRequestPayload } from './chatRequestPayload';
import { hasUnansweredUserTurn, withChatContinuation } from './chatContinuation';
import { protectPendingChatTurn } from './storyTheaterTimeline';

const realTime = new Date('2026-10-10T18:48:00Z').getTime();
const futureTime = new Date('2026-10-22T18:48:00Z').getTime();
const char = (id: string): CharacterProfile => ({
    id, name: '角色', avatar: '', description: '', systemPrompt: '你是角色。', memories: [],
    contextRangePolicyVersion: 1, contextRangeMode: 'manual', contextLimit: 500,
    timeAwarenessEnabled: true, scheduleFeatureEnabled: false, memoryPalaceEnabled: false,
});
const seedLegacy = async (id: string, timestamp = futureTime) => {
    const centralId = await DB.saveMessage({
        charId: `story-theater:${id}`, role: 'assistant', type: 'text', content: '<scene_header>旧剧情</scene_header>',
        timestamp: realTime, metadata: { source: 'story_theater', theaterId: id },
    });
    const mirrorId = await DB.saveMessage({
        charId: id, role: 'assistant', type: 'text', content: '<scene_header>旧剧情</scene_header>', timestamp,
        metadata: { source: 'story_theater_memory', theaterId: id, theaterTitle: '日常', theaterCentralId: centralId },
    });
    return { centralId, mirrorId };
};
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('剧情与现实收发时间分离', () => {
    it('真实陪伴的角色副本使用中央记录的实际时间，设定时间只保存在元数据', () => {
        const createdAt = new Date('2026-09-28T06:30:00').getTime();
        const entry = { ...StoryTheater.createStoryTheaterDraft(createdAt), writesToCharacterMemory: true,
            title: '日常', characterMemoryDates: { actor: '2026-10-10T06:30' } };
        const central = { id: 101, role: 'assistant', content: '正文', timestamp: realTime } as Message;
        const mirror = StoryTheater.createStoryTheaterMirrorMessage(entry, 'actor', central);
        expect(mirror.timestamp).toBe(realTime);
        expect(mirror.metadata).toMatchObject({ source: 'story_theater_memory', theaterCentralId: 101,
            theaterTimestampVersion: 1, theaterReceivedAt: realTime });
        expect(mirror.metadata.theaterTimelineTimestamp).toBeGreaterThan(realTime);
    });

    it.each([futureTime, new Date('2020-01-01T00:00:00Z').getTime()])('旧副本时间 %s 按中央记录修复，保留正文、ID和其他元数据', async timestamp => {
        const id = `repair-${timestamp}`;
        const { mirrorId, centralId } = await seedLegacy(id, timestamp);
        await DB.updateMessageMetadata(mirrorId, previous => ({ ...previous, custom: '保留' }));
        const messages = await DB.getMessagesByCharId(id, true);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ id: mirrorId, timestamp: realTime, content: '<scene_header>旧剧情</scene_header>',
            metadata: { custom: '保留', theaterCentralId: centralId, theaterTimelineTimestamp: timestamp,
                theaterTimestampVersion: 1, theaterReceivedAt: realTime } });
        expect((await DB.getMessagesByCharId(id, true))[0]).toEqual(messages[0]);
    });

    it('跨剧情的错误中央引用不会被拿来编造收发时间', async () => {
        const { centralId } = await seedLegacy('other-theater');
        const id = await DB.saveMessage({ charId: 'invalid-ref', role: 'assistant', type: 'text', content: '孤立记录',
            timestamp: futureTime, metadata: { source: 'story_theater_memory', theaterId: 'invalid-ref', theaterCentralId: centralId } });
        const row = (await DB.getMessagesByCharId('invalid-ref', true))[0];
        expect(row).toMatchObject({ id, timestamp: futureTime, content: '孤立记录' });
        expect(row.metadata?.theaterReceivedAt).toBeUndefined();
    });

    it('导入旧备份后即使已做过修复，也会重新校正相同ID的错误副本', async () => {
        const { mirrorId, centralId } = await seedLegacy('restored-story');
        const saved = await DB.getMessagesByCharId('restored-story', true);
        const oldBackup = { messages: [{ ...saved[0], timestamp: futureTime,
            metadata: { source: 'story_theater_memory', theaterId: 'restored-story', theaterCentralId: centralId } }] };
        await DB.importFullData(oldBackup as FullBackupData);
        expect((await DB.getMessagesByCharId('restored-story', true))[0]).toMatchObject({ id: mirrorId, timestamp: realTime });
    });

    it('导入中读取过历史、随后其他备份项目失败时，已导入的旧时间仍能在读取时校正', async () => {
        const { mirrorId, centralId } = await seedLegacy('partial-restored');
        const saved = (await DB.getMessagesByCharId('partial-restored', true))[0];
        const backup = { messages: [{ ...saved, timestamp: futureTime,
            metadata: { source: 'story_theater_memory', theaterId: 'partial-restored', theaterCentralId: centralId } }],
            worldbooks: [{ id: 'fail-after-messages' }] } as unknown as FullBackupData;
        await expect(DB.importFullData(backup, {
            beforeWrite: async (_root, label) => {
                if (label === '聊天记录') await DB.getMessagesByCharId('partial-restored', true);
            },
            onProgress: progress => {
                if (progress.label === '世界书' && progress.stage === 'start') throw new Error('模拟后续项目导入失败');
            },
        })).rejects.toThrow('模拟后续项目导入失败');
        expect((await DB.getMessagesByCharId('partial-restored', true))[0]).toMatchObject({ id: mirrorId, timestamp: realTime });
    });

    it('修复事务中途失败时全部回滚，下次读取能重试', async () => {
        const first = await seedLegacy('rollback-first');
        const second = await seedLegacy('rollback-second');
        const originalPut = IDBObjectStore.prototype.put;
        const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: any, key?: IDBValidKey) {
            if (this.name === 'messages' && value.id === second.mirrorId && value.timestamp === realTime) {
                this.transaction.abort();
                throw new Error('模拟存储失败');
            }
            return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
        });
        await expect(DB.getMessagesByCharId('rollback-first', true)).rejects.toThrow();
        spy.mockRestore();
        const db = await openDB();
        const raw = await new Promise<Message[]>((resolve, reject) => {
            const request = db.transaction('messages').objectStore('messages').getAll();
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        expect(raw.find(message => message.id === first.mirrorId)?.timestamp).toBe(futureTime);
        expect(raw.find(message => message.id === second.mirrorId)?.timestamp).toBe(futureTime);
        expect((await DB.getMessagesByCharId('rollback-first', true))[0].timestamp).toBe(realTime);
    });
});

describe('线上回复不被剧情抢走', () => {
    it('剧情后已有线上回复时，孤立旧剧情回到原来的轮次，不重复触发模式切换', async () => {
        const history = [
            { id: 1, charId: 'answered', role: 'assistant', type: 'text', content: '旧剧情', timestamp: futureTime,
                metadata: { source: 'story_theater_memory' } },
            { id: 2, charId: 'answered', role: 'user', type: 'text', content: '上一轮线上输入', timestamp: realTime },
            { id: 3, charId: 'answered', role: 'assistant', type: 'text', content: '上一轮线上回复', timestamp: realTime + 1 },
            { id: 4, charId: 'answered', role: 'user', type: 'text', content: '这一轮线上输入', timestamp: realTime + 2 },
        ] as Message[];
        const payload = await buildChatRequestPayload({ char: char('answered'), userProfile: { name: '用户' } as any,
            groups: [], emojis: [], categories: [], historyMsgs: history, contextLimit: 20, recallEntryPoint: 'chat_app' });
        expect(payload.cleanedApiMessages[0].content).toContain('旧剧情');
        expect(payload.systemPrompt).not.toContain('现在已经回到 ChatApp 的文字聊天界面');
    });

    it('保留晚到的真实线上回复与主动消息的顺序，也不抢走较新的剧情输入', async () => {
        const make = (id: number, role: Message['role'], source?: string): Message => ({
            id, charId: 'order', role, type: 'text', content: String(id), timestamp: id, metadata: { source },
        });
        const answered = [make(1, 'user'), make(3, 'assistant'), make(2, 'assistant', 'story_theater_memory')];
        expect(protectPendingChatTurn(answered)).toBe(answered);
        const newStory = [make(1, 'user'), make(2, 'assistant', 'story_theater_memory')];
        expect(protectPendingChatTurn(newStory)).toBe(newStory);
        const scheduled = { ...make(4, 'assistant'), metadata: { activeMsg2: { taskId: 'scheduled' } } };
        const withProactive = [make(2, 'user'), scheduled, make(1, 'assistant', 'story_theater_memory')];
        expect(protectPendingChatTurn(withProactive).map(message => message.id)).toEqual([1, 2, 4]);
        expect(hasUnansweredUserTurn([withProactive[0]], withProactive)).toBe(true);
        const payload = await buildChatRequestPayload({ char: char('order'), userProfile: { name: '用户' } as any,
            groups: [], emojis: [], categories: [], historyMsgs: withProactive, contextLimit: 20, recallEntryPoint: 'chat_app' });
        expect(payload.systemPrompt).toContain('现在已经回到 ChatApp 的文字聊天界面');
        expect(withChatContinuation(payload.fullMessages, '用户', {
            unansweredUserTurn: hasUnansweredUserTurn([withProactive[0]], withProactive),
        }).at(-1)?.content).toContain('刚才说的话还没有人回');
    });

    it('旧记录修复后，连续重掷仍以新线上输入收尾并注入模式切换', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-11T10:01:00Z'));
        await seedLegacy('chat-story');
        const userId = await DB.saveMessage({ charId: 'chat-story', role: 'user', type: 'text', content: '今天线上新消息' });
        for (let roll = 0; roll < 3; roll++) {
            const range = await loadCharacterContextRange(char('chat-story'));
            expect(range.messages.at(-1)?.id).toBe(userId);
            const payload = await buildChatRequestPayload({ char: char('chat-story'), userProfile: { name: '用户' } as any,
                groups: [], emojis: [], categories: [], historyMsgs: range.messages, contextLimit: range.messages.length,
                recallEntryPoint: 'chat_app' });
            expect(payload.cleanedApiMessages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('今天线上新消息') });
            expect(payload.systemPrompt).toContain('现在已经回到 ChatApp 的文字聊天界面');
            expect(withChatContinuation(payload.fullMessages, '用户')).toEqual(payload.fullMessages);
            const replyId = await DB.saveMessage({ charId: 'chat-story', role: 'assistant', type: 'text', content: '线上回复' });
            await DB.deleteMessages([replyId]);
        }
    });

    it.each([false, true])('缺少中央记录的旧副本不会挡住当前输入（worker=%s），也不冒充现实日期', async timelyByWorker => {
        const history = [
            { id: 1, charId: 'orphan', role: 'assistant', type: 'text', content: '旧线下正文', timestamp: futureTime,
                metadata: { source: 'story_theater_memory', theaterTitle: '日常', theaterCentralId: 999 } },
            { id: 2, charId: 'orphan', role: 'user', type: 'text', content: '今天线上新消息', timestamp: realTime + 86400000 },
        ] as Message[];
        const payload = await buildChatRequestPayload({ char: char('orphan'), userProfile: { name: '用户' } as any,
            groups: [], emojis: [], categories: [], historyMsgs: history, contextLimit: 20,
            recallEntryPoint: 'chat_app', timelyByWorker });
        expect(payload.cleanedApiMessages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('今天线上新消息') });
        expect(payload.systemPrompt).toContain('现在已经回到 ChatApp 的文字聊天界面');
        const story = payload.cleanedApiMessages.find(message => String(message.content).includes('旧线下正文'))!;
        expect(String(story.content)).toContain('[剧情：日常]');
        expect(String(story.content)).not.toContain('2026-10-22');
        expect(withChatContinuation(payload.fullMessages, '用户')).toEqual(payload.fullMessages);
    });
});
