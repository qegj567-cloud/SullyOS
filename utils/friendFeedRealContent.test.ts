import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {DB} from './db';
import {saveFriendCircle, importFriendSource, readFriendFeed, friendPostsForCharacter, deleteFriendPost, commentOnFriendPost} from './friendFeed';
import {prepareFriendFeedEmotionTask, landFriendFeedEmotionAction} from './friendFeedEmotion';
import {applyEmotionEvalRaw} from './emotionApply';
import {loadCharacterContextMessages, selectCharacterContextMessages} from './chatContextRange';
import type {CharacterProfile} from '../types';
import type {FriendFeedSource} from './friendFeedSource';

const a = {id: 'real-a', name: '小白', systemPrompt: '喜欢咖啡', memories: [], contextRangePolicyVersion: 1,
    contextRangeMode: 'manual', contextLimit: 50} as unknown as CharacterProfile;
const b = {...a, id: 'real-b', name: '小绿'};
const source: FriendFeedSource = {platform: 'x', externalId: '1808168603721650364', url: 'https://x.com/i/status/1808168603721650364',
    author: '真实原作者', text: '今天试了一种手冲咖啡方法。', fetchedAt: 1792500000000, truncated: false};
let circleId: string;
beforeEach(async () => {
    await DB.deleteDB(); await DB.saveCharacter(a); await DB.saveCharacter(b);
    circleId = await saveFriendCircle({name: '客厅', description: '', memberIds: [a.id]});
});
afterEach(() => vi.restoreAllMocks());
const enable = (enabled = true) => saveFriendCircle({id: circleId, name: '客厅', description: '', memberIds: [a.id], realContentEnabled: enabled});
it('deduplicates concurrent imports, writes no memory, and gates browsing by circle and audience', async () => {
    const ids = await Promise.all([importFriendSource(circleId, source), importFriendSource(circleId, source)]);
    expect(ids[0]).toBe(ids[1]); expect((await readFriendFeed()).posts).toHaveLength(1);
    expect(await DB.getMessagesByCharId(a.id, true)).toHaveLength(0);
    expect(friendPostsForCharacter(await readFriendFeed(), a.id)).toHaveLength(0);
    await enable(); expect(friendPostsForCharacter(await readFriendFeed(), a.id)).toHaveLength(1);
    await saveFriendCircle({id: circleId, name: '客厅', description: '', memberIds: [a.id, b.id]});
    expect(friendPostsForCharacter(await readFriendFeed(), b.id)).toHaveLength(0);
});
it('lands changed=false repost once, retains original author, and feeds only the actor memory through normal waterlines', async () => {
    await enable(); const id = await importFriendSource(circleId, source);
    const task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    expect(task.prompt).toContain('kind=repost'); expect(task.prompt).toContain('真实原作者');
    const raw = JSON.stringify({changed: false, friendFeedAction: {requestId: task.id, kind: 'repost', postId: id, text: '这个方法我想试试。'}});
    await applyEmotionEvalRaw(raw, a); await applyEmotionEvalRaw(raw, a);
    const feed = await readFriendFeed();
    expect(feed.posts).toHaveLength(2); expect(feed.posts[1]).toMatchObject({authorId: a.id, text: '这个方法我想试试。', source});
    const messages = await loadCharacterContextMessages(a);
    expect(messages).toHaveLength(1); expect(messages[0]).toMatchObject({type: 'friend_feed_card', metadata: {friendFeedComment: {kind: 'repost'}}});
    expect(messages[0].content).toContain(source.author); expect(messages[0].content).toContain(source.url);
    expect(await DB.getMessagesByCharId(b.id, true)).toHaveLength(0);
    expect(selectCharacterContextMessages(messages, {...a, contextRangeMode: 'adaptive', memoryPalaceEnabled: true, autoArchiveEnabled: true}, messages[0].id)).toEqual([]);
    await commentOnFriendPost(feed.posts[1].id, '用户', '我也想试试', 'user-comment', () => 0);
    expect((await DB.getMessagesByCharId(a.id, true)).at(-1)?.content).toContain('我也想试试');
    const job = (await readFriendFeed()).replyJobs![0];
    const main = (await prepareFriendFeedEmotionTask(job.charId, () => 0, job.id))!;
    expect(main.prompt).toContain(source.url);
    await landFriendFeedEmotionAction(job.charId, {requestId: main.id,
        kind: 'comment', postId: feed.posts[1].id, comment: '那就一起试试。'}, 'immediate');
    expect((await readFriendFeed()).posts[1].comments.at(-1)?.text).toBe('那就一起试试。');
    expect((await DB.getMessagesByCharId(a.id, true)).at(-1)?.content).toContain('你评论：那就一起试试。');
});
it('records a local comment with attribution but never invents a memory for the external author', async () => {
    await enable(); const id = await importFriendSource(circleId, source);
    const task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    expect(await landFriendFeedEmotionAction(a.id, {requestId: task.id, kind: 'comment', postId: id, comment: '试试低一点的水温。'}, 'emotion')).toBe(true);
    const feed = await readFriendFeed(); expect(feed.posts[0].comments).toHaveLength(1);
    const messages = await DB.getMessagesByCharId(a.id, true); expect(messages).toHaveLength(1); expect(messages[0].content).toContain(source.url);
    expect(await DB.getMessagesByCharId(feed.posts[0].authorId, true)).toHaveLength(0);
});
it('rejects invented sources, disabled or deleted in-flight materials, and NPC impersonation of a real author', async () => {
    await enable(); const id = await importFriendSource(circleId, source);
    let task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    expect(await landFriendFeedEmotionAction(a.id, {requestId: task.id, kind: 'repost', postId: 'invented', text: '假的'})).toBe(false);
    task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    expect(await landFriendFeedEmotionAction(a.id, {requestId: task.id, kind: 'none', npcActions: [{kind: 'comment', name: source.author, text: '假冒作者', postId: id}]})).toBe(false);
    task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!; await enable(false);
    expect(await landFriendFeedEmotionAction(a.id, {requestId: task.id, kind: 'repost', postId: id, text: '迟到'})).toBe(false);
    await enable(); task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!; await deleteFriendPost(id);
    expect(await landFriendFeedEmotionAction(a.id, {requestId: task.id, kind: 'repost', postId: id, text: '已删除'})).toBe(false);
    expect(await DB.getMessagesByCharId(a.id, true)).toHaveLength(0);
});
it('rolls back repost and reservation together when memory writing fails, then safely retries the same result', async () => {
    await enable(); const id = await importFriendSource(circleId, source);
    const task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    const action = {requestId: task.id, kind: 'repost', postId: id, text: '值得试试'};
    const add = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
        if (this.name === 'messages') throw new Error('memory failed');
        return add.apply(this, args);
    });
    await expect(landFriendFeedEmotionAction(a.id, action, 'emotion')).rejects.toThrow('memory failed');
    expect((await readFriendFeed()).posts).toHaveLength(1);
    spy.mockRestore(); expect(await landFriendFeedEmotionAction(a.id, action, 'emotion')).toBe(true);
    expect((await readFriendFeed()).posts).toHaveLength(2); expect(await DB.getMessagesByCharId(a.id, true)).toHaveLength(1);
});
