import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import * as database from './db';
import { DB } from './db';
import { safeFetchJson } from './safeApi';
import { readThinkingTranslation, translateThinkingMessage, parseThinkingTranslation, thinkingTranslationPairs, splitThinkingTranslationSource } from './thinkingTranslation';
import { exportUserSpaces, importUserSpaces } from './userSpaceBackup';
import { saveUserSpaces } from './userSpaces';
import type { Message } from '../types';

vi.mock('./safeApi', () => ({ safeFetchJson: vi.fn(), extractContent: (response: any) => response.choices?.[0]?.message?.content || '' }));
const api = { baseUrl: 'https://translate.invalid/v1', apiKey: 'translation-key', model: 'cheap-translator' };
const completion = (text = '我想邀请她一起散步。') => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
let message: Message;
beforeEach(async () => {
    vi.mocked(safeFetchJson).mockReset().mockResolvedValue(completion());
    const id = await DB.saveMessage({ charId: 'thinking-qa', role: 'assistant', type: 'text', content: '今晚一起散步吗？', metadata: { thinkingChain: 'I want to invite her for a walk.', untouched: true } });
    message = (await DB.getMessageById(id))!;
});
afterEach(() => vi.restoreAllMocks());

it('requires an explicit translation API without falling back to chat credentials', async () => {
    await expect(translateThinkingMessage(message, undefined)).rejects.toThrow('配置翻译 API');
    expect(safeFetchJson).not.toHaveBeenCalled();
});
it('translates only this visible thinking text and records explicit purpose/character', async () => {
    await translateThinkingMessage(message, api, '小秋');
    const [url, options, retry, timeout, meta] = vi.mocked(safeFetchJson).mock.calls[0];
    const payload = JSON.parse(options.body as string);
    expect(url).toBe('https://translate.invalid/v1/chat/completions');
    expect(payload.model).toBe('cheap-translator');
    expect(payload.messages).toHaveLength(2);
    expect(JSON.parse(payload.messages[1].content).segments).toEqual([{ id: 0, source: message.metadata.thinkingChain }]);
    expect(JSON.stringify(payload)).not.toContain(message.content);
    expect(payload).not.toHaveProperty('tools');
    expect(payload).not.toHaveProperty('thinking');
    expect(retry).toBe(0);
    expect(meta).toMatchObject({ charId: message.charId, charName: '小秋', purpose: '心象翻译' });
    const saved = (await DB.getMessageById(message.id))!;
    expect(saved.content).toBe(message.content);
    expect(saved.metadata.thinkingChain).toBe(message.metadata.thinkingChain);
    expect(saved.metadata.untouched).toBe(true);
});
it('deduplicates simultaneous taps and reuses saved text even after API removal', async () => {
    const first = translateThinkingMessage(message, api);
    expect(translateThinkingMessage(message, api)).toBe(first);
    const text = await first;
    expect(await translateThinkingMessage(message, undefined)).toEqual(text);
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
});
it('does not write a stale translation after the source changes', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(safeFetchJson).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const task = translateThinkingMessage(message, api);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await DB.updateMessageMetadata(message.id, prev => ({ ...prev, thinkingChain: 'Changed source.' }));
    finish(completion());
    await expect(task).rejects.toThrow('修改或删除');
    expect((await DB.getMessageById(message.id))!.metadata.thinkingChainTranslation).toBeUndefined();
});
it('preserves metadata changed while the model is responding', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(safeFetchJson).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const task = translateThinkingMessage(message, api);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await DB.updateMessageMetadata(message.id, prev => ({ ...prev, concurrentFlag: 'keep' }));
    finish(completion()); await task;
    expect((await DB.getMessageById(message.id))!.metadata.concurrentFlag).toBe('keep');
});
it('keeps a successful model result for retry when local saving fails', async () => {
    const open = vi.spyOn(database, 'openDB').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(translateThinkingMessage(message, api)).rejects.toThrow('storage unavailable');
    open.mockRestore();
    await expect(translateThinkingMessage(message, api)).resolves.toMatchObject({ text: '我想邀请她一起散步。' });
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
});
it('does not automatically retry network errors or save an empty/truncated result', async () => {
    vi.mocked(safeFetchJson).mockRejectedValueOnce(new Error('HTTP 429'));
    await expect(translateThinkingMessage(message, api)).rejects.toThrow('429');
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
    vi.mocked(safeFetchJson).mockResolvedValueOnce(completion(''));
    await expect(translateThinkingMessage(message, api)).rejects.toThrow('未返回正文');
    vi.mocked(safeFetchJson).mockResolvedValueOnce({ choices: [{ message: { content: '半段' }, finish_reason: 'length' }] });
    await expect(translateThinkingMessage(message, api)).rejects.toThrow('未完成');
    expect((await DB.getMessageById(message.id))!.metadata.thinkingChainTranslation).toBeUndefined();
});
it('requires the exact source for cache reuse', () => {
    expect(readThinkingTranslation('new', { source: 'old', text: '旧译文' })).toBeUndefined();
    expect(readThinkingTranslation('new', { source: 'new', text: '' })).toBeUndefined();
});
it('pairs each translated unit with its unchanged local source, including reordered model output', () => {
    const source = 'She has had a long day. I should keep the invitation gentle.\nAlready home?';
    const parts = splitThinkingTranslationSource(source);
    expect(parts).toEqual(['She has had a long day.', 'I should keep the invitation gentle.', 'Already home?']);
    const result = parseThinkingTranslation(source, '```json\n' + JSON.stringify({ translations: [{ id: 2, text: '已经到家了吗？', source: 'Model rewrote this incorrectly' }, { id: 0, text: '她今天很累。' }, { id: 1, text: '我应该温柔地邀请她。' }] }) + '\n```');
    expect(result.segments?.map(row => row.source)).toEqual(parts);
    expect(result.segments?.map(row => row.text)).toEqual(['她今天很累。', '我应该温柔地邀请她。', '已经到家了吗？']);
    expect(thinkingTranslationPairs(source, result)).toEqual(result.segments);
});
it('rejects missing or duplicate translation units rather than showing false pairs', () => {
    const source = 'One. Two.';
    for (const translations of [[{ id: 0, text: '一。' }], [{ id: 0, text: '一。' }, { id: 0, text: '二。' }], [{ id: 0, text: '一。' }, { id: 1, text: '' }]]) {
        expect(() => parseThinkingTranslation(source, JSON.stringify({ translations }))).toThrow('未完整对应');
    }
});
it('keeps old/free-text translations as one honest whole-text comparison without another call', () => {
    const source = 'One.\nTwo.';
    expect(thinkingTranslationPairs(source, { source, text: '一。二。' })).toEqual([{ source, text: '一。二。' }]);
    expect(thinkingTranslationPairs(source, { source, text: '一。二。', segments: [{ source: 'wrong', text: '一。二。' }] })).toEqual([{ source, text: '一。二。' }]);
});
it.each(['text_only', 'full'] as const)('restores translation settings and message translations through %s backups', async mode => {
    saveUserSpaces([{ id: 'default', name: '测试用户' }]);
    const config = { baseUrl: 'https://chat.invalid/v1', apiKey: 'chat-key', model: 'chat', thinkingTranslationApi: api };
    localStorage.setItem('os_api_config', JSON.stringify(config));
    vi.mocked(safeFetchJson).mockResolvedValueOnce(completion(JSON.stringify({ translations: [{ id: 0, text: '我想邀请她一起散步。' }] })));
    await translateThinkingMessage(message, api);
    const zip = await JSZip.loadAsync(await (await exportUserSpaces(mode, 'current')).arrayBuffer());
    localStorage.removeItem('os_api_config');
    await DB.updateMessageMetadata(message.id, prev => ({ ...prev, thinkingChainTranslation: undefined }));
    await importUserSpaces(zip);
    expect(JSON.parse(localStorage.getItem('os_api_config')!).thinkingTranslationApi).toEqual(api);
    const restored = (await DB.getMessageById(message.id))!;
    expect(readThinkingTranslation(restored.metadata.thinkingChain, restored.metadata.thinkingChainTranslation)).toBe('我想邀请她一起散步。');
    expect(thinkingTranslationPairs(restored.metadata.thinkingChain, restored.metadata.thinkingChainTranslation)).toEqual([{ source: message.metadata.thinkingChain, text: '我想邀请她一起散步。' }]);
});
