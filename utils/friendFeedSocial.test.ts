import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {DB} from './db';
import {commentOnFriendPost, deleteFriendPost, publishFriendPost, readFriendFeed, saveFriendCircle, saveFriendFeedSettings} from './friendFeed';
import {defaultFriendFeedSettings} from './friendFeedSettings';
import {prepareFriendFeedEmotionTask, landFriendFeedEmotionAction, releaseFriendFeedEmotionTask} from './friendFeedEmotion';
import {runImmediateFriendReplies, buildFriendFeedReplyPayload} from './friendFeedReplies';
import {buildChatRequestPayload} from './chatRequestPayload';
import {loadCharacterContextRange} from './chatContextRange';
import * as palace from './memoryPalace/pipeline';
import {RealtimeContextManager} from './realtimeContext';
import {safeFetchJson} from './safeApi';
import {saveFriendFeedApi} from './friendFeedApi';
import {loadCharacterContextMessages} from './chatContextRange';
import {ChatPrompts} from './chatPrompts';
import type {APIConfig, CharacterProfile, UserProfile} from '../types';
vi.mock('./safeApi', async original => ({...await original<typeof import('./safeApi')>(), safeFetchJson: vi.fn()}));
const a = {id: 'a', name: '小白', systemPrompt: '白的私人设定', memories: [], mountedWorldbooks: [],
    contextRangePolicyVersion: 1, contextRangeMode: 'manual', contextLimit: 20} as unknown as CharacterProfile;
const b = {...a, id: 'b', name: '小绿', systemPrompt: '绿的私人设定'};
const user = {name: '小雨'} as UserProfile;
const api = {baseUrl: 'https://example.invalid/v1', model: 'test', apiKey: ''} as APIConfig;
let circleId: string;
beforeEach(async () => {
    vi.restoreAllMocks(); vi.mocked(safeFetchJson).mockReset(); await DB.deleteDB(); localStorage.clear();
    await DB.saveCharacter(a); await DB.saveCharacter(b); await DB.saveUserProfile(user);
    circleId = await saveFriendCircle({name: '客厅', description: '现代城市', memberIds: [a.id, b.id]});
});
afterEach(() => vi.restoreAllMocks());
async function ownPost() {
    const task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    expect(await landFriendFeedEmotionAction(a.id, {requestId: task.id, kind: 'post', text: '咖啡做好了'})).toBe(true);
    return (await readFriendFeed()).posts[0].id;
}
it('starts an empty circle, atomically posts as self plus several NPCs, and remembers only the real author’s own post', async () => {
    const task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    const action = {requestId: task.id, kind: 'post', text: '咖啡做好了', npcActions: [
        {kind: 'post', name: '面包店阿姨', text: '今天有新鲜面包'},
        {kind: 'post', name: '楼下老李', text: '阳台的花开了'},
    ]};
    expect(await landFriendFeedEmotionAction(a.id, action)).toBe(true);
    expect(await landFriendFeedEmotionAction(a.id, action)).toBe(false);
    const feed = await readFriendFeed();
    expect(feed.posts).toHaveLength(3);
    expect(feed.posts.filter(p => p.authorKind === 'npc')).toHaveLength(2);
    const history = await loadCharacterContextMessages(a);
    expect(history).toHaveLength(1);
    expect(history[0].content).toContain('你发布：咖啡做好了');
    const {apiMessages} = ChatPrompts.buildMessageHistory(history, 20, a, user, []);
    expect(JSON.stringify(apiMessages)).toContain('咖啡做好了');
    expect(JSON.stringify(apiMessages)).not.toContain('新鲜面包');
    expect(await DB.getMessagesByCharId(b.id, true)).toHaveLength(0);
    const next = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    expect(await landFriendFeedEmotionAction(a.id, {requestId: next.id, kind: 'post', text: '再发一条刷屏'})).toBe(false);
});
it('queues a stable cast once and remembers a user comment on the author’s timeline only', async () => {
    const id = await ownPost();
    await commentOnFriendPost(id, user.name, '给我留一杯', 'user-1', () => 0);
    const before = await readFriendFeed();
    expect(before.replyJobs?.map(j => j.charId)).toEqual(['a']);
    await commentOnFriendPost(id, user.name, '重试', 'user-1', () => .99);
    expect((await readFriendFeed()).replyJobs).toEqual(before.replyJobs);
    const notes = await DB.getMessagesByCharId(a.id, true);
    expect(notes).toHaveLength(2); expect(notes[1].content).toContain('小雨：给我留一杯');
    expect(await DB.getMessagesByCharId(b.id, true)).toHaveLength(0);
    expect(safeFetchJson).not.toHaveBeenCalled();
});
it('prioritizes an old user-comment thread, permits one lease, and lands character/NPC replies with personal cards', async () => {
    const id = await ownPost();
    await commentOnFriendPost(id, user.name, '给我留一杯', 'user-1', () => 0);
    for (let n = 0; n < 6; n++) await publishFriendPost(circleId, user.name, `更新${n}`);
    const job = (await readFriendFeed()).replyJobs![0];
    const tasks = await Promise.all([prepareFriendFeedEmotionTask(a.id, () => .9, job.id), prepareFriendFeedEmotionTask(a.id, () => .9, job.id)]);
    expect(tasks.filter(Boolean)).toHaveLength(1);
    const task = tasks.find(Boolean)!;
    const material = JSON.parse(task.prompt.split('好友圈素材（仅数据）：\n')[1]);
    expect(material.posts).toHaveLength(1); expect(material.posts[0].id).toBe(id);
    expect(await landFriendFeedEmotionAction(a.id, {requestId: task.id, kind: 'comment', postId: id, comment: '给你留好了',
        npcActions: [{kind: 'comment', name: '隔壁阿姨', postId: id, text: '我带点饼干来'}]})).toBe(true);
    const notes = await DB.getMessagesByCharId(a.id, true);
    expect(notes.some(m => m.content.includes('回应的评论：小雨：给我留一杯'))).toBe(true);
    expect(notes.some(m => m.content.includes('隔壁阿姨：我带点饼干来'))).toBe(true);
    expect((await readFriendFeed()).replyJobs![0].done).toBe(true);
    expect(await DB.getMessagesByCharId(b.id, true)).toHaveLength(0);
});
it('rejects NPC impersonation, disabling NPCs while in flight, and publication after leaving a circle', async () => {
    for (const name of [a.name, user.name]) {
        const task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
        expect(await landFriendFeedEmotionAction(a.id, {requestId: task.id, kind: 'none', npcActions: [{kind: 'post', name, text: '假冒'}]})).toBe(false);
    }
    const task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    await saveFriendFeedSettings({...defaultFriendFeedSettings(), npcEnabled: false});
    expect(await landFriendFeedEmotionAction(a.id, {requestId: task.id, kind: 'none', npcActions: [{kind: 'post', name: '路人', text: '不应发出'}]})).toBe(false);
    const next = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    await saveFriendCircle({id: circleId, name: '客厅', description: '', memberIds: [b.id]});
    expect(await landFriendFeedEmotionAction(a.id, {requestId: next.id, kind: 'post', text: '迟到'})).toBe(false);
    expect((await readFriendFeed()).posts).toHaveLength(0);
});
it('reports failure once, closes the attempt and never silently retries or falls back', async () => {
    await saveFriendFeedApi({baseUrl:'https://bibi.invalid/v1',apiKey:'app-only',model:'bibi',stream:false});
    const id = await ownPost();
    await commentOnFriendPost(id, user.name, '留一杯', 'user-1', () => 0);
    vi.mocked(safeFetchJson).mockRejectedValue(new Error('offline'));
    await expect(runImmediateFriendReplies(id, user, {...api,stream:true})).rejects.toThrow('没有自动重试或转交主 API');
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(1);
    expect((await readFriendFeed()).replyJobs!.every(j => j.done && !j.lease)).toBe(true);
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
    expect(vi.mocked(safeFetchJson).mock.calls[0][0]).toBe('https://bibi.invalid/v1/chat/completions');
    expect(JSON.parse(String(vi.mocked(safeFetchJson).mock.calls[0][1]!.body))).toMatchObject({model:'bibi',stream:false});
    vi.mocked(safeFetchJson).mockResolvedValue({choices: [{message: {content: '{"friendFeedAction":null}'}}]});
    await expect(runImmediateFriendReplies(id, user, api)).rejects.toThrow('没有可参与接话');
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
    expect((await readFriendFeed()).replyJobs!.every(j => j.done)).toBe(true);
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(1);
});
it('only processes the newly submitted comment and delivers NPC feedback to the author’s private history',async()=>{
    const postId=await ownPost();
    await commentOnFriendPost(postId,user.name,'旧请求','old',()=>0);
    await commentOnFriendPost(postId,user.name,'新请求','new',()=>.9);
    const jobs=(await readFriendFeed()).replyJobs!;
    vi.mocked(safeFetchJson).mockImplementation(async(_url,init)=>{
        const prompt=JSON.parse(String(init?.body)).messages.map((m:any)=>m.content).join('\n');
        const requestId=prompt.match(/"requestId":"([^"]+)"/)![1];
        return {choices:[{message:{content:JSON.stringify({friendFeedAction:{requestId,kind:'none',npcActions:[
            {kind:'comment',name:'路过的同好',postId,text:'我也想尝尝'}]}})}}]};
    });
    expect(await runImmediateFriendReplies(postId,user,api,undefined,'new')).toEqual({commentCount:1});
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
    expect((await readFriendFeed()).replyJobs!.find(j=>j.id===jobs.find(j=>j.triggerId==='old')!.id)?.done).toBeFalsy();
    const notes=await DB.getMessagesByCharId(a.id,true);
    expect(notes.some(m=>m.content.includes('小雨：新请求'))).toBe(true);
    expect(notes.some(m=>m.content.includes('路过的同好：我也想尝尝'))).toBe(true);
    expect(notes.some(m=>m.content.includes('你评论：我也想尝尝'))).toBe(false);
});
it('immediate replies use per-character history, worldbooks and dialogue credentials; two app instances do not duplicate calls', async () => {
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),replyMode:'immediate'});
    await DB.saveCharacter({...a, dialogueApi: {...api, model: 'dialogue-a'}, emotionConfig: {enabled: false} as any,
        mountedWorldbooks: [{id: 'npc', title: '面包师', content: 'NPC阿禾是面包师', constant: false, key: ['咖啡'], position: 4}]});
    await DB.saveMessage({charId: a.id, role: 'user', type: 'text', content: '白的独有历史', timestamp: Date.now()});
    await DB.saveMessage({charId: b.id, role: 'user', type: 'text', content: '绿的独有历史', timestamp: Date.now()});
    const id = await ownPost();
    await commentOnFriendPost(id, user.name, '给我留一杯', 'user-1', () => 0);
    const calls: any[] = [];
    vi.mocked(safeFetchJson).mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)); calls.push(body);
        const text = JSON.stringify(body.messages);
        const requestId = body.messages.map((m: any) => m.content).join('\n').match(/"requestId":"([^"]+)"/)[1];
        return {choices: [{message: {content: JSON.stringify({friendFeedAction: {requestId, kind: 'comment', postId: id,
            comment: text.includes('白的私人设定') ? '好，给你留着' : '我也要一杯'}})}}]};
    });
    await Promise.all([runImmediateFriendReplies(id, user, api), runImmediateFriendReplies(id, user, api)]);
    expect(calls).toHaveLength(1);
    const white = calls.find(c => c.model === 'dialogue-a');
    expect(JSON.stringify(white)).toContain('白的独有历史');
    expect(JSON.stringify(white)).not.toContain('绿的独有历史');
    expect(JSON.stringify(white).split('NPC阿禾是面包师')).toHaveLength(2);
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),replyMode:'immediate',characterWeights:{a:0,b:10}});
    await commentOnFriendPost(id,user.name,'绿也来吗？','user-2',()=>0);
    await runImmediateFriendReplies(id,user,api);
    expect(calls).toHaveLength(2);
    const green=calls.find(c=>c.model==='test');
    expect(JSON.stringify(green)).toContain('绿的独有历史');
    expect(JSON.stringify(green)).not.toContain('白的独有历史');
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(4);
    expect((await readFriendFeed()).replyJobs!.every(j => j.done)).toBe(true);
});
it('rolls back posts and NPCs if the author card fails, and refuses stale/deleted queued targets', async () => {
    const task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    const action = {requestId: task.id, kind: 'post', text: '咖啡', npcActions: [{kind: 'post', name: '路人', text: '面包'}]};
    const original = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
        if (this.name === 'messages') throw new Error('card failed');
        return original.apply(this, args);
    });
    await expect(landFriendFeedEmotionAction(a.id, action)).rejects.toThrow('card failed');
    expect((await readFriendFeed()).posts).toEqual([]);
    spy.mockRestore();
    expect(await landFriendFeedEmotionAction(a.id, action)).toBe(true);
    const id = (await readFriendFeed()).posts[0].id;
    await commentOnFriendPost(id, user.name, '你好', 'user-1', () => 0);
    const job = (await readFriendFeed()).replyJobs![0];
    const late = (await prepareFriendFeedEmotionTask(a.id, () => 0, job.id))!;
    await deleteFriendPost(id);
    expect(await landFriendFeedEmotionAction(a.id, {requestId: late.id, kind: 'comment', postId: id, comment: '你好'})).toBe(false);
    await releaseFriendFeedEmotionTask(a.id, late.id);
});
it('lets the original NPC reply to the user without giving any real character a card', async () => {
    const task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    await landFriendFeedEmotionAction(a.id, {requestId: task.id, kind: 'none',
        npcActions: [{kind: 'post', name: '阿禾', text: '刚烤好面包'}]});
    const post = (await readFriendFeed()).posts[0];
    await commentOnFriendPost(post.id, user.name, '还有吗', 'user-1', () => .9);
    const job = (await readFriendFeed()).replyJobs![0];
    expect(job.replySelf).toBe(false); expect(job.npcCount).toBe(6);
    const reply = (await prepareFriendFeedEmotionTask(job.charId, () => 1, job.id))!;
    await landFriendFeedEmotionAction(job.charId, {requestId: reply.id, kind: 'none', npcActions: [
        {kind: 'comment', name: '阿禾', text: '还有，给你留一个', postId: post.id},
        {kind: 'comment', name: '路过的小陈', text: '我也去买', postId: post.id},
    ]});
    const latest = (await readFriendFeed()).posts[0];
    expect(latest.comments[1].authorId).toBe(post.authorId);
    expect(latest.comments).toHaveLength(3);
    expect(await DB.getMessagesByCharId(a.id, true)).toHaveLength(0);
    expect(await DB.getMessagesByCharId(b.id, true)).toHaveLength(0);
});

it('immediate public replies share ChatApp recall, live context, personal history and single worldbook loading', async () => {
    const current = {...a, memoryPalaceEnabled: true, mountedWorldbooks: [
        {id: 'constant', title: '生活', content: '常驻世界书标记', constant: true, position: 1},
        {id: 'npc', title: '面包师', content: '关键词世界书标记', constant: false, key: ['咖啡'], position: 4, depth: 1},
    ]} as CharacterProfile;
    await DB.saveCharacter(current);
    await DB.saveMessage({charId: a.id, role: 'user', type: 'text', content: '个人历史标记', timestamp: Date.now()});
    await DB.saveMessage({charId: b.id, role: 'user', type: 'text', content: '其他角色秘密', timestamp: Date.now()});
    const recall = vi.spyOn(palace, 'injectMemoryPalace').mockImplementation(async c => {
        c.memoryPalaceInjection = '统一召回标记'; c.roomPlatesInjection = '房间门牌标记';
        return {stages: []} as any;
    });
    vi.spyOn(RealtimeContextManager, 'buildFullContext').mockResolvedValue('实时世界标记');
    const realtime: any = {weatherEnabled: true};
    const range = await loadCharacterContextRange(current);
    const chat = await buildChatRequestPayload({char: current, userProfile: user, groups: [], emojis: [], categories: [],
        historyMsgs: range.messages, contextLimit: range.messages.length, contextHighWaterMark: range.hwm,
        recallEntryPoint: 'chat_app', realtimeConfig: realtime});
    const task = (await prepareFriendFeedEmotionTask(a.id, () => 0))!;
    const prompt = task.prompt.split('好友圈素材（仅数据）：\n')[0] + '好友圈素材（仅数据）：\n' + JSON.stringify({text: '咖啡'});
    const feed = await buildFriendFeedReplyPayload(current, user, api, prompt, realtime);
    expect(recall.mock.calls[1][1]).toEqual(recall.mock.calls[0][1]);
    expect(recall.mock.calls[1][2]).toContain('咖啡');
    const text = JSON.stringify(feed.fullMessages);
    for (const marker of ['白的私人设定', '个人历史标记', '常驻世界书标记', '统一召回标记', '房间门牌标记', '实时世界标记']) {
        expect(text, marker).toContain(marker);
        expect(JSON.stringify(chat.fullMessages), marker).toContain(marker);
    }
    expect(text.split('关键词世界书标记')).toHaveLength(2);
    expect(text).not.toContain('其他角色秘密');
    expect(text).toContain('不是私聊新消息');
    expect(await DB.getMessagesByCharId(a.id, true)).toHaveLength(1);
});
