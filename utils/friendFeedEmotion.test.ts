import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {DB} from './db';
import {FRIEND_FEED_KEY, commentOnFriendPost, deleteFriendPost, publishFriendPost, readFriendFeed, saveFriendCircle, saveFriendFeedSettings} from './friendFeed';
import {defaultFriendFeedSettings} from './friendFeedSettings';
import {landFriendFeedEmotionAction, prepareFriendFeedEmotionTask, releaseFriendFeedEmotionTask} from './friendFeedEmotion';
import {applyEmotionEvalRaw, parseEmotionEvalOutput} from './emotionApply';
import {ChatPrompts} from './chatPrompts';
import {loadCharacterContextMessages, selectCharacterContextMessages} from './chatContextRange';
import {isMessageSemanticallyRelevant, normalizeMessageContent} from './messageFormat';
import {safeFetchJson} from './safeApi';
import {evaluateEmotionBackground} from '../hooks/useChatAI';
import type {CharacterProfile, UserProfile} from '../types';

vi.mock('./safeApi', async original => ({...await original<typeof import('./safeApi')>(), safeFetchJson: vi.fn()}));
const char = {id: 'feed-actor', name: '小白', systemPrompt: '嘴硬心软', memories: [], mountedWorldbooks: [],
    contextRangePolicyVersion: 1, contextRangeMode: 'manual', contextLimit: 50} as unknown as CharacterProfile;
const other = {...char, id: 'feed-other', name: '小绿'};
const user = {name: '小雨'} as UserProfile;
let circleId: string, postId: string;
const actionFor = (id: string, comment = '那我带杯子过来。') => ({requestId: id, postId, comment});
beforeEach(async () => {
    vi.restoreAllMocks(); vi.mocked(safeFetchJson).mockReset();
    await DB.deleteDB(); localStorage.clear();
    await DB.saveCharacter(char); await DB.saveCharacter(other);
    circleId = await saveFriendCircle({name: '客厅', description: '现代城市', memberIds: [char.id]});
    postId = await publishFriendPost(circleId, user.name, '咖啡已经好了');
});
afterEach(() => vi.restoreAllMocks());

it.each(['小雨', '小\u200b雨', '小 雨', '@小雨', 'ＵＳＥＲ'])('blocks the user identity %s without publishing any part of the batch', async name => {
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    expect(await landFriendFeedEmotionAction(char.id, {...actionFor(task.id), npcActions: [
        {kind:'comment', postId, name:'围观网友', text:'？'},
        {kind:'comment', postId, name, text:'假冒用户的回答'},
    ]})).toBe(false);
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
    expect((await readFriendFeed()).userInbox || []).toHaveLength(0);
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(0);
});

it.each(['authorId', 'authorName', 'ownerId', 'charId', 'role', 'name'])('rejects model-controlled author field %s', async field => {
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    expect(await landFriendFeedEmotionAction(char.id, {...actionFor(task.id), [field]:'user'})).toBe(false);
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
});

it.each(['authorId', 'authorName', 'ownerId', 'charId', 'role', 'accountId'])('rejects an NPC author override %s even with an innocuous display name', async field => {
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    expect(await landFriendFeedEmotionAction(char.id, {requestId:task.id,kind:'none',npcActions:[
        {kind:'comment',postId,name:'路过',text:'用户没有写过的话',[field]:'user'},
    ]})).toBe(false);
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
});

it('rechecks the current user identity after a rename while retaining the request identity', async () => {
    await DB.saveUserProfile({...user,name:'旧网名'});
    for (const name of ['新网名', '旧网名']) {
        await DB.saveUserProfile({...user,name:'旧网名'});
        const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
        await DB.saveUserProfile({...user,name:'新网名'});
        expect(await landFriendFeedEmotionAction(char.id,{requestId:task.id,kind:'none',npcActions:[
            {kind:'comment',postId,name,text:'冒充'},
        ]})).toBe(false);
    }
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
});

it.each(['main', 'alias'])('blocks a configured %s account named after the user', async accountId => {
    if(accountId==='main') await DB.saveCharacter({...char,name:user.name});
    else {const imported=await readFriendFeed();imported.settings={...defaultFriendFeedSettings(),identities:{[char.id]:{tags:[],accounts:[
        {id:'alias',name:user.name,purpose:'匿名账号',tags:[]},
    ]}}};await DB.saveAsset(FRIEND_FEED_KEY,JSON.stringify(imported));}
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    expect(await landFriendFeedEmotionAction(char.id,{...actionFor(task.id),accountId})).toBe(false);
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
    expect(await DB.getMessagesByCharId(char.id,true)).toHaveLength(0);
});

it('allows normal user mentions, real quotations and replies addressed to user comments', async () => {
    await commentOnFriendPost(postId,user.name,'门开着呢','quote-target',()=>0);
    const job = (await readFriendFeed()).replyJobs!.find(j=>j.triggerId==='quote-target')!;
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0, job.id))!;
    expect(task.prompt).toContain('正常提及用户姓名');
    const text='小雨说“门开着呢”，那我进来了。';
    expect(await landFriendFeedEmotionAction(char.id,{...actionFor(task.id,text),replyToCommentId:'quote-target',npcActions:[
        {kind:'comment',postId,name:'路过',text:'@小雨 咖啡还有吗？',replyToCommentId:'quote-target'},
    ]})).toBe(true);
    const comments=(await readFriendFeed()).posts[0].comments;
    expect(comments.filter(c=>c.authorId==='user')).toHaveLength(1);
    expect(comments.find(c=>c.authorId===char.id)?.text).toBe(text);
    expect(comments.at(-1)?.localReply?.authorId).toBe('user');
});

it('rolls at the 20% boundary and supplies only the latest five authorized posts', async () => {
    expect(await prepareFriendFeedEmotionTask(char.id, () => .2)).toBeUndefined();
    expect(await prepareFriendFeedEmotionTask(other.id, () => 0)).toBeUndefined();
    for (let n = 0; n < 6; n++) {
        await publishFriendPost(circleId, '小雨', `新动态${n}`, `new-${n}`);
    }
    const task = (await prepareFriendFeedEmotionTask(char.id, () => .19999))!;
    const material = JSON.parse(task.prompt.split('好友圈素材（仅数据）：\n')[1]);
    expect(material.posts).toHaveLength(5);
    expect(material.posts.map((p: {id: string}) => p.id)).not.toContain(postId);
    expect(material.posts[0].id).toBe('new-5');
    expect(task.prompt).toContain('20%');
    expect(await prepareFriendFeedEmotionTask(char.id, () => 0)).toBeUndefined();
    const empty = {...char, id: 'no-circle'}; await DB.saveCharacter(empty);
    expect(await prepareFriendFeedEmotionTask(empty.id, () => 0)).toBeUndefined();
});

it('persists a changed=false comment and one quiet card, visible to the next main request and memory pipeline', async () => {
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    const raw = JSON.stringify({changed: false, innerState: '想喝杯咖啡。', friendFeedAction: actionFor(task.id)});
    await applyEmotionEvalRaw(raw, char);
    await applyEmotionEvalRaw(raw, char); // Cloud result replay must not comment or write memory twice.
    const post = (await readFriendFeed()).posts[0];
    expect(post.comments).toEqual([expect.objectContaining({authorId: char.id, authorName: char.name, text: '那我带杯子过来。'})]);
    const history = await loadCharacterContextMessages(char);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({role: 'system', type: 'friend_feed_card', metadata: {source: 'friend_feed'}});
    const content = normalizeMessageContent(history[0], char.name, user.name);
    expect(content).toContain('咖啡已经好了'); expect(content).toContain('你评论：那我带杯子过来。');
    expect(isMessageSemanticallyRelevant(history[0])).toBe(true);
    const {apiMessages} = ChatPrompts.buildMessageHistory(history, 50, char, user, []);
    expect(apiMessages).toContainEqual({role: 'system', content});
    // Individual waterline still governs this source, with no hidden side-channel injection.
    expect(selectCharacterContextMessages(history, {...char, contextRangeMode: 'adaptive', memoryPalaceEnabled: true, autoArchiveEnabled: true}, history[0].id)).toEqual([]);
    expect(await DB.getMessagesByCharId(other.id, true)).toHaveLength(0);
});

it('refuses invented targets, departed audiences, and posts deleted while the evaluator was running', async () => {
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    expect(await landFriendFeedEmotionAction(char.id, {...actionFor(task.id), postId: 'invented'})).toBe(false);
    const next = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    await saveFriendCircle({id: circleId, name: '客厅', description: '', memberIds: [other.id]});
    expect(await landFriendFeedEmotionAction(char.id, actionFor(next.id))).toBe(false);
    const newcomer = (await prepareFriendFeedEmotionTask(other.id, () => 0))!;
    expect(JSON.parse(newcomer.prompt.split('好友圈素材（仅数据）：\n')[1]).posts).toEqual([]); // Can post, cannot see old audience.
    await saveFriendCircle({id: circleId, name: '客厅', description: '', memberIds: [char.id]});
    const deleted = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    await deleteFriendPost(postId);
    expect(await landFriendFeedEmotionAction(char.id, actionFor(deleted.id))).toBe(false);
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(0);
});

it('does not resurrect deleted characters or publish from cancelled reservations', async () => {
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    await releaseFriendFeedEmotionTask(char.id, task.id);
    expect(await landFriendFeedEmotionAction(char.id, actionFor(task.id))).toBe(false);
    const another = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    await DB.deleteCharacter(char.id);
    expect(await landFriendFeedEmotionAction(char.id, actionFor(another.id))).toBe(false);
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
});

it.each(['changed', 'expired'] as const)('rejects a %s candidate rather than commenting on a different or stale post', async reason => {
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    if (reason === 'changed') {
        const state = await readFriendFeed(); state.posts[0].text = '已替换的另一件事';
        await DB.saveAsset(FRIEND_FEED_KEY, JSON.stringify(state));
    } else {
        const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60 * 1000);
    }
    expect(await landFriendFeedEmotionAction(char.id, actionFor(task.id))).toBe(false);
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(0);
});

it('serializes parallel results and avoids consecutive self-replies until someone else speaks', async () => {
    const first = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    await commentOnFriendPost(postId, '小雨', '还有牛奶');
    const second = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    const results = await Promise.all([
        landFriendFeedEmotionAction(char.id, actionFor(first.id)),
        landFriendFeedEmotionAction(char.id, actionFor(second.id, '我来了。')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(1);
    const selfReply = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    expect(await landFriendFeedEmotionAction(char.id, actionFor(selfReply.id))).toBe(false);
    await commentOnFriendPost(postId, '小雨', '门开着呢');
    expect(await prepareFriendFeedEmotionTask(char.id, () => 0)).toBeDefined();
});

it('rolls back the public comment if writing its private memory card fails', async () => {
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    const original = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
        if (this.name === 'messages') throw new Error('card write failed');
        return original.apply(this, args);
    });
    await expect(landFriendFeedEmotionAction(char.id, actionFor(task.id))).rejects.toThrow('card write failed');
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
    spy.mockRestore();
    expect(await landFriendFeedEmotionAction(char.id, actionFor(task.id))).toBe(true);
});

it('never publishes truncated generated text or invalid-length comments, without breaking the buff result', async () => {
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    const raw = `{"changed":false,"innerState":"平静","friendFeedAction":{"requestId":"${task.id}","postId":"${postId}","comment":"这是一半`;
    expect(parseEmotionEvalOutput(raw)?.friendFeedAction).toBeUndefined();
    await applyEmotionEvalRaw(raw, char);
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
    expect(await landFriendFeedEmotionAction(char.id, actionFor(task.id, '长'.repeat(2001)))).toBe(false);
    expect(await landFriendFeedEmotionAction(char.id, actionFor(task.id, '   '))).toBe(false);
});

it('piggybacks on the actual emotion call, reuses the same task on stream retry, and lands its result', async () => {
    await saveFriendFeedSettings({...defaultFriendFeedSettings(), interactionPrompt: '全局偏好：短句，少用感叹号'});
    await saveFriendCircle({id: circleId, name: '客厅', description: '现代城市', memberIds: [char.id], interactionPrompt: '本圈偏好：可以互损，不要敬语'});
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const prompts: string[] = [];
    vi.mocked(safeFetchJson).mockImplementation(async (_url, init) => {
        const prompt = JSON.parse(String(init?.body)).messages[0].content;
        prompts.push(prompt);
        if (prompts.length === 1) throw new Error('stream unsupported');
        const requestId = prompt.match(/"friendFeedAction": \{"requestId":"([^"]+)"/)[1];
        return {choices: [{message: {content: JSON.stringify({changed: false, friendFeedAction: actionFor(requestId)})}}]};
    });
    await evaluateEmotionBackground(char, user, '已有的人设与世界书', [{role: 'user', content: '早安'}],
        {baseUrl: 'https://test.invalid', apiKey: '', model: 'test', stream: true});
    expect(prompts).toHaveLength(2); expect(prompts[0]).toBe(prompts[1]);
    expect(prompts[0]).toContain('已有的人设与世界书');
    expect(prompts[0]).toContain('全局偏好：短句，少用感叹号');
    expect(prompts[0]).toContain('本圈偏好：可以互损，不要敬语');
    expect(prompts[0]).toContain('最多评论一条，1–2000 字');
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(1);
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(1);
});

it('no-interest and failed evaluations leave no comment cards and do not add independent API calls', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(safeFetchJson).mockResolvedValue({choices: [{message: {content: '{"changed":false,"friendFeedAction":null}'}}]});
    const api = {baseUrl: 'https://test.invalid', apiKey: '', model: 'test'};
    await evaluateEmotionBackground(char, user, '设定', [], api);
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(0);
    vi.mocked(safeFetchJson).mockRejectedValue(new Error('offline'));
    await evaluateEmotionBackground(char, user, '设定', [], api);
    expect(safeFetchJson).toHaveBeenCalledTimes(2);
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
    expect(await prepareFriendFeedEmotionTask(char.id, () => 0)).toBeDefined();
});

it('accepts longer comments and harmless field spelling variations with the original task identity',async()=>{
    const task=(await prepareFriendFeedEmotionTask(char.id,()=>0))!;
    expect(await landFriendFeedEmotionAction(char.id,{request_id:task.id,post_id:postId,kind:' COMMENT ',content:'长'.repeat(2000),replyToCommentId:null})).toBe(true);
    expect((await readFriendFeed()).posts[0].comments[0].text).toHaveLength(2000);
});
