import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, StoryTheaterEntry } from '../types';
import { DB } from './db';
import { createStoryTheaterDraft, storyTheaterThreadId } from './storyTheater';
import { archiveStoryManually, generateStoryArchiveSummary, parseStoryArchiveSummary, regenerateStoryArchiveSummary } from './storyTheaterArchive';

const api = { baseUrl: 'https://llm.invalid/v1/', apiKey: 'test', model: 'test' };
const completion = (content: unknown, finish_reason = 'stop', reasoning_content = '思考过程') => ({ choices: [{ finish_reason, message: { content, reasoning_content } }] });
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
let entry: StoryTheaterEntry, messages: Message[], serial = 0;
const fetchMock = vi.fn();
const fresh = async () => (await DB.getStoryTheaters()).find(item => item.id === entry.id)!;
const regenerate = () => regenerateStoryArchiveSummary(entry.id, 'box', api);

beforeEach(async () => {
    serial++;
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset().mockResolvedValue(response(completion('两人在车站等雨停，一起走回家。')));
    entry = { ...createStoryTheaterDraft(), id: `archive-qa-${serial}`, title: '雨夜车站', writesToCharacterMemory: false };
    messages = [];
    for (const [role, content] of [['user', '我们先在车站等雨停。'], ['assistant', '<think>先计划情节</think>阿泽答应陪小雨走回家。']] as const) {
        const row = { charId: storyTheaterThreadId(entry.id), role, type: 'text' as const, content, timestamp: 10, metadata: { source: 'story_theater', theaterId: entry.id, theaterArchived: true } };
        messages.push({ ...row, id: await DB.saveMessage(row) });
    }
    entry.archives = [{ id: 'box', strategy: 'summary', fromMessageId: messages[0].id, toMessageId: messages[1].id, messageCount: 2, summary: '旧摘要里只有思考过程', createdAt: 10,
        memoryConversions: { actor: { date: '2026-10-01', convertedAt: 12, destination: 'neural', memoryIds: ['kept'], skipped: 0 } } }];
    await DB.saveStoryTheater(entry);
});
afterEach(() => vi.unstubAllGlobals());

describe('story summary final channel', () => {
    it('strips inline thinking and ignores native or typed reasoning, while retaining final text', () => {
        expect(parseStoryArchiveSummary(completion('<thinking>计划</thinking>回家途中他们约定下周再见。'))).toBe('回家途中他们约定下周再见。');
        expect(parseStoryArchiveSummary(completion([{ type: 'thinking', text: '计划' }, { type: 'text', text: '正文' }]))).toBe('正文');
        for (const content of ['', null, '<think>只有推理</think>', '<thought>未闭合推理', [{ type: 'reasoning', text: '只有推理' }]]) {
            expect(() => parseStoryArchiveSummary(completion(content))).toThrow('没有返回事件盒正文');
        }
    });
    it('rejects incomplete, filtered and recognizable untagged reasoning instead of overwriting summaries', () => {
        expect(() => parseStoryArchiveSummary(completion('部分摘要', 'length'))).toThrow('上限');
        expect(() => parseStoryArchiveSummary(completion('摘要', 'content_filter'))).toThrow('拦截');
        expect(() => parseStoryArchiveSummary(completion('Paragraph 1: 31 chars\nStill too long'))).toThrow('推理过程');
        expect(parseStoryArchiveSummary(completion('他说「Let’s count together」，两人一起数星星。'))).toContain('数星星');
    });
    it('does not retry automatically and rejects upstream errors', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: '服务不可用' } }), { status: 503 }));
        await expect(generateStoryArchiveSummary(entry.title, messages, api)).rejects.toThrow('服务不可用');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('story archive regeneration', () => {
    it('regenerates only the exact archived source, saves in place and preserves concurrent unrelated edits/receipts', async () => {
        const { id: _id, ...newMessage } = messages[0];
        await DB.saveMessage({ ...newMessage, content: '盒外的新剧情' });
        fetchMock.mockImplementationOnce(async () => {
            await DB.saveStoryTheater({ ...entry, premise: '另一个窗口编辑的介绍', archives: [...entry.archives, { ...entry.archives[0], id: 'later' }] });
            return response(completion('新摘要'));
        });
        const result = await regenerate();
        const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(payload.messages[0].content).toContain('严格保留故事内已确立的时间线');
        expect(payload.messages[0].content).toContain('当前场景的时间与地点落点');
        expect(payload.messages[1].content).toContain('阿泽答应陪小雨走回家');
        expect(payload.messages[1].content).not.toContain('先计划情节');
        expect(payload.messages[1].content).not.toContain('盒外');
        expect(payload.messages[1].content).not.toContain('旧摘要');
        expect(payload).toMatchObject({ model: 'test', stream: false, max_tokens: 4096 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.archives[0]).toEqual({ ...entry.archives[0], summary: '新摘要' });
        expect(result.archives).toHaveLength(2);
        expect(result.premise).toBe('另一个窗口编辑的介绍');
        expect((await fresh()).archives[0].summary).toBe('新摘要');
        expect((await DB.getMessagesByCharId(storyTheaterThreadId(entry.id), true)).slice(0, 2)).toEqual(messages);
    });
    it('keeps the old summary on reasoning-only response and unlocks for an explicit retry', async () => {
        fetchMock.mockResolvedValueOnce(response(completion('', 'stop', '只有推理')));
        await expect(regenerate()).rejects.toThrow('思维链');
        expect((await fresh()).archives[0]).toEqual(entry.archives[0]);
        await expect(regenerate()).resolves.toMatchObject({ archives: [{ summary: '两人在车站等雨停，一起走回家。' }] });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('allows recovery of an empty summary but refuses incomplete source before making a request', async () => {
        entry.archives[0].summary = '';
        await DB.saveStoryTheater(entry);
        await expect(regenerate()).resolves.toBeDefined();
        await DB.deleteMessage(messages[0].id);
        await expect(regenerate()).rejects.toThrow('原文不完整');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it.each(['summary', 'message', 'delete'] as const)('rejects stale %s while the request is running', async change => {
        fetchMock.mockImplementationOnce(async () => {
            if (change === 'summary') await DB.saveStoryTheater({ ...entry, archives: [{ ...entry.archives[0], summary: '其他窗口的新摘要' }] });
            if (change === 'message') await DB.updateMessage(messages[1].id, '已编辑的原文');
            if (change === 'delete') await DB.deleteStoryTheater(entry.id);
            return response(completion('本次旧请求结果'));
        });
        await expect(regenerate()).rejects.toThrow('已变更');
        if (change !== 'delete') expect((await fresh()).archives[0].summary).toBe(change === 'summary' ? '其他窗口的新摘要' : entry.archives[0].summary);
        else expect(await fresh()).toBeUndefined();
    });
    it('guards duplicate clicks while a request is pending', async () => {
        let release!: (result: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
        const pending = regenerate();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await expect(regenerate()).rejects.toThrow('正在重新总结');
        release(response(completion('新摘要')));
        await pending;
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('preserves the saved box if the replacement cannot be written', async () => {
        const original = IDBObjectStore.prototype.put;
        const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
            if (this.name === 'story_theaters') throw new Error('磁盘写入失败');
            return original.apply(this, args);
        });
        try { await expect(regenerate()).rejects.toThrow('磁盘写入失败'); }
        finally { spy.mockRestore(); }
        expect((await fresh()).archives[0]).toEqual(entry.archives[0]);
    });
});

async function addPending(role: 'user' | 'assistant', content: string) {
 return DB.saveMessage({ charId: storyTheaterThreadId(entry.id), role, type: 'text', content, metadata: { source: 'story_theater', theaterId: entry.id } });
}
describe('manual story archive', () => {
 it('includes the latest completed pair, preserves old boxes/originals and does not touch character memory', async () => {
  await addPending('user', '本段最后的输入'); await addPending('assistant', '本段最后的回复');
  const before = await DB.getAllCharacters();
  const result = await archiveStoryManually(entry, api);
  expect(result).toMatchObject({ archiveMode: 'manual', archiveStrategy: 'summary' });
  expect(result.archives).toHaveLength(2); expect(result.archives[0]).toEqual(entry.archives[0]);
  expect(result.archives[1].messageCount).toBe(2);
  const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content;
  expect(prompt).toContain('本段最后的回复'); expect(prompt).not.toContain('我们先在车站等雨停');
  const rows = await DB.getMessagesByCharId(storyTheaterThreadId(entry.id), true);
  expect(rows).toHaveLength(4); expect(rows.every(row => row.metadata.theaterArchived)).toBe(true);
  expect(await DB.getAllCharacters()).toEqual(before);
  await expect(archiveStoryManually(result, api)).rejects.toThrow('没有待总结');
 });
 it('leaves text unarchived on model failure and permits retry', async () => {
  await addPending('assistant', '完整的一段');
  fetchMock.mockResolvedValueOnce(response(completion('', 'stop', '只有思考')));
  await expect(archiveStoryManually(entry, api)).rejects.toThrow();
  expect((await fresh()).archives).toHaveLength(1);
  expect((await DB.getMessagesByCharId(storyTheaterThreadId(entry.id), true)).at(-1)?.metadata.theaterArchived).not.toBe(true);
  await expect(archiveStoryManually(entry, api)).resolves.toMatchObject({ archiveMode: 'manual' });
 });
 it('refuses unfinished replies and real-time companion stories', async () => {
  await addPending('user', '等待回复');
  await expect(archiveStoryManually(entry, api)).rejects.toThrow('回复完成');
  await expect(archiveStoryManually({...entry, writesToCharacterMemory:true}, api)).rejects.toThrow('虚构剧场');
  expect(fetchMock).not.toHaveBeenCalled();
 });
 it('rejects duplicate clicks and discards a summary when the source changes during generation', async () => {
  await addPending('assistant', '原剧情');
  fetchMock.mockImplementationOnce(async () => {
   await expect(archiveStoryManually(entry, api)).rejects.toThrow('正在总结');
   await addPending('user', '新增输入');
   return response(completion('已过期的摘要'));
  });
  await expect(archiveStoryManually(entry, api)).rejects.toThrow('剧情已变更');
  expect((await fresh()).archives).toHaveLength(1);
  const rows=await DB.getMessagesByCharId(storyTheaterThreadId(entry.id),true);
  expect(rows.slice(-2).every(row=>!row.metadata.theaterArchived)).toBe(true);
 });
});

it('manual archive rolls back message flags and the box together when commit fails', async () => {
 await addPending('assistant', '事务失败时仍保留原文');
 const put = IDBObjectStore.prototype.put;
 const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof put>) {
  const request = put.apply(this, args);
  if (this.name === 'story_theaters') request.addEventListener('success', () => this.transaction.abort());
  return request;
 });
 try { await expect(archiveStoryManually(entry, api)).rejects.toThrow(); } finally { spy.mockRestore(); }
 expect((await fresh()).archives).toHaveLength(1);
 expect((await DB.getMessagesByCharId(storyTheaterThreadId(entry.id), true)).at(-1)?.metadata.theaterArchived).not.toBe(true);
});
