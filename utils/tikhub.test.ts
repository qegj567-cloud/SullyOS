import {afterEach, expect, it, vi} from 'vitest';
import {fetchTikHubPost, normalizeTikHubPost, parseTikHubLink, readTikHubKey, saveTikHubKey} from './tikhub';

afterEach(() => {vi.unstubAllGlobals(); localStorage.clear();});
it('accepts canonical links and share text, but rejects arbitrary hosts, credentials and multiple URLs', () => {
    expect(parseTikHubLink('https://x.com/someone/status/1808168603721650364?s=20')).toEqual({platform: 'x', id: '1808168603721650364'});
    expect(parseTikHubLink('一篇笔记 http://xhslink.com/o/8GqargIxrko 复制打开')).toEqual({platform: 'xiaohongshu', shareUrl: 'https://xhslink.com/o/8GqargIxrko'});
    for (const url of ['https://x.com.evil.test/u/status/12345', 'https://x.com@evil.test/u/status/12345',
        'https://x.com:8443/u/status/12345', 'https://127.0.0.1/private', 'https://x.com/u/status/12345 https://x.com/u/status/12346'])
        expect(() => parseTikHubLink(url)).toThrow();
});
const tweet = {rest_id: '1808168603721650364', legacy: {full_text: '真的正文', created_at: '2026-06-01T12:00:00Z'},
    core: {user_results: {result: {legacy: {name: '原作者'}}}}, quoted_status_result: {result: {rest_id: '11111', legacy: {full_text: '不能误取的引用'}}}};
it('normalizes a nested tweet with matching ID, keeps attribution, and discards provider diagnostics', () => {
    const source = normalizeTikHubPost({code: 200, cache_url: 'secret', data: {tweetResult: {result: tweet}}}, {platform: 'x', id: tweet.rest_id});
    expect(source).toMatchObject({author: '原作者', text: '真的正文', url: `https://x.com/i/status/${tweet.rest_id}`, publishedAt: Date.parse('2026-06-01T12:00:00Z')});
    expect(JSON.stringify(source)).not.toContain('secret');
    expect(() => normalizeTikHubPost({code: 200, data: tweet}, {platform: 'x', id: '99999'})).toThrow();
    expect(() => normalizeTikHubPost({code: 200, data: {message: '服务异常'}}, {platform: 'x', id: tweet.rest_id})).toThrow();
});
it('normalizes XHS shortlink results and marks truncation, without fabricating missing authors', () => {
    const note = {id: '697c0eee000000000a03c308', title: '标题', desc: '内容'.repeat(7000), user: {nickname: '原作者'}, time: 1760000000};
    const source = normalizeTikHubPost({code: 200, data: {data: [{note_list: [note]}]}}, {platform: 'xiaohongshu'});
    expect(source.text).toHaveLength(12000); expect(source.truncated).toBe(true); expect(source.publishedAt).toBe(1760000000000);
    expect(() => normalizeTikHubPost({code: 200, data: {...note, user: {}}}, {platform: 'xiaohongshu'})).toThrow('原作者');
});
it('blocks the retired paid provider before accessing the network, even with a saved key', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    saveTikHubKey('test-only-key');
    await expect(fetchTikHubPost('https://x.com/u/status/12345', readTikHubKey())).rejects.toThrow('已停用');
    expect(fetcher).not.toHaveBeenCalled();
    saveTikHubKey(''); expect(readTikHubKey()).toBe('');
});
