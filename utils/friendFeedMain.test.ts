import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {DB} from './db';
import {commentOnFriendPost, mutateFriendFeed, readFriendFeed, saveFriendCircle, saveFriendFeedSettings} from './friendFeed';
import {defaultFriendFeedSettings} from './friendFeedSettings';
import {prepareFriendFeedEmotionTask, landFriendFeedEmotionAction, releaseFriendFeedEmotionTask} from './friendFeedEmotion';
import {prepareFriendFeedMainTask, consumeFriendFeedMainReply} from './friendFeedMain';
import {extractFriendFeedReplyTags} from './friendFeedReplyFormat';
import {computeStreamPreviewBubbles as computeStreamPreview} from './streamPreview';
import {sanitizeForBubble} from './sanitize';
import {classifyLLMOutput} from '../worker/amsg/src/classifier';
import {applyAssistantPostProcessing, type PostProcessCtx} from './applyAssistantPostProcessing';
import {generateHomeReply} from './homeConversation';
import {parseSARModuleReply} from './vrWorld/sarEnvelopeCore';
import type {CharacterProfile} from '../types';

const char = {id: 'feed-main-a', name: '小白', systemPrompt: '喜欢咖啡', memories: [],
    contextRangePolicyVersion: 1, contextRangeMode: 'manual', contextLimit: 20,
    emotionConfig: {enabled: false}} as unknown as CharacterProfile;
beforeEach(async () => {
    vi.restoreAllMocks(); localStorage.clear(); await DB.deleteDB();
    await DB.saveCharacter(char); await DB.saveUserProfile({name: '小雨'} as any);
    await saveFriendCircle({name: '客厅', description: '现代城市', memberIds: [char.id]});
});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function queued(notice = true) {
    const task = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    await landFriendFeedEmotionAction(char.id, {requestId: task.id, kind: 'post', text: '咖啡做好了'}, 'emotion');
    const postId = (await readFriendFeed()).posts[0].id;
    await commentOnFriendPost(postId, '小雨', '给我留一杯', 'user-comment', () => 0);
    if (notice) await mutateFriendFeed(feed => {feed.replyJobs!.forEach(j=>j.done=true);feed.notices=[{id:'notice',charId:char.id,postId,createdAt:Date.now()}];});
    return postId;
}
const tag = (action: unknown) => '[[FRIEND_FEED_REPLY:' + JSON.stringify(action) + ']]';
function context(): PostProcessCtx {
    return {char, userProfile: {name: '小雨'} as any, emojis: [], contextMsgs: [], fullMessages: [],
        initialData: {}, historyMsgCount: 0, xhsCaches: {xsecTokenCache: new Map(), noteTitleCache: new Map(),
            commentUserIdCache: new Map(), commentAuthorNameCache: new Map(), commentParentIdCache: new Map()},
        api: {baseUrl: 'https://test.invalid', headers: {}, effectiveApi: {baseUrl: 'https://test.invalid', model: 'test', apiKey: ''}},
        hooks: {setMessages: vi.fn(), addToast: vi.fn()}} as PostProcessCtx;
}

it('main publication notices bypass the emotion toggle and probability, lease once, and never run in emotion', async () => {
    const postId = await queued();
    vi.spyOn(Math, 'random').mockReturnValue(.99);
    const task = (await prepareFriendFeedMainTask(char.id))!;
    expect(task.prompt).toContain('给我留一杯');
    expect(task.prompt).toContain('咖啡做好了');
    expect(task.prompt).toContain('FRIEND_FEED_REPLY');
    expect(task.prompt).not.toContain('命中 20%');
    expect(await prepareFriendFeedMainTask(char.id)).toBeUndefined();
    const emotion = (await prepareFriendFeedEmotionTask(char.id, () => 0))!;
    expect(JSON.parse(emotion.prompt.split('好友圈素材（仅数据）：\n')[1]).posts).toEqual([]);
    const action = {requestId: task.id, kind: 'comment', postId, comment: '给你留好了'};
    expect(await landFriendFeedEmotionAction(char.id, action, 'emotion')).toBe(false);
    expect(await consumeFriendFeedMainReply(char.id, '晚安\n' + tag(action))).toBe('晚安\n');
    expect((await readFriendFeed()).posts[0].comments.map(c => c.text)).toEqual(['给我留一杯', '给你留好了']);
    expect((await DB.getMessagesByCharId(char.id, true)).some(m => m.content.includes('你评论：给你留好了'))).toBe(true);
    await consumeFriendFeedMainReply(char.id, tag(action));
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(2);
});

it('leaves omitted/malformed replies pending and retries the same cast; explicit none completes it', async () => {
    await queued();
    const task = (await prepareFriendFeedMainTask(char.id))!;
    await consumeFriendFeedMainReply(char.id, '先聊天');
    await consumeFriendFeedMainReply(char.id, '[[FRIEND_FEED_REPLY:{"requestId":"' + task.id + '"');
    expect((await readFriendFeed()).notices![0].done).toBeFalsy();
    const cast = (await readFriendFeed()).replyJobs!.map(j => [j.id, j.charId, j.npcCount]);
    await releaseFriendFeedEmotionTask(char.id, task.id);
    const retry = (await prepareFriendFeedMainTask(char.id))!;
    expect(retry.id).not.toBe(task.id);
    expect((await readFriendFeed()).replyJobs!.map(j => [j.id, j.charId, j.npcCount])).toEqual(cast);
    await consumeFriendFeedMainReply(char.id, tag({requestId: retry.id, kind: 'none'}));
    expect((await readFriendFeed()).notices![0].done).toBe(true);
});

it('immediate mode leaves queued work for its explicit API call', async () => {
    await queued(false);
    await saveFriendFeedSettings({...defaultFriendFeedSettings(), replyMode: 'immediate'});
    expect(await prepareFriendFeedMainTask(char.id)).toBeUndefined();
    expect((await readFriendFeed()).replyJobs![0].lease).toBeUndefined();
});

it('hides complete/multiline/truncated control JSON, including brackets inside quoted text', () => {
    const action = {requestId: 'test', kind: 'comment', comment: '有个 ]] 符号和 "引号"'};
    const raw = '正常说话\n' + tag(action) + '\n继续聊天';
    expect(extractFriendFeedReplyTags(raw)).toEqual({text: '正常说话\n\n继续聊天', actions: [action]});
    expect(sanitizeForBubble(raw)).not.toContain('requestId');
    const truncated = '正常说话\n[[FRIEND_FEED_REPLY:{\n"comment":"有个 ]] 符号\n尚未完成';
    expect(extractFriendFeedReplyTags(truncated)).toEqual({text: '正常说话\n', actions: []});
    expect(JSON.stringify(computeStreamPreview(truncated))).not.toContain('尚未完成');
    expect(JSON.stringify(computeStreamPreview(raw))).not.toContain('requestId');
});

it('does not execute tags inside reasoning or a mismatched request envelope', async () => {
    const postId = await queued();
    const task = (await prepareFriendFeedMainTask(char.id))!;
    const action = {requestId: task.id, kind: 'comment', postId, comment: '还没发'};
    await consumeFriendFeedMainReply(char.id, '<think>' + tag(action) + '</think>晚安');
    await consumeFriendFeedMainReply(char.id, tag(action), [], 'another-request');
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(1);
});

it('public comment text is data to the cloud tool scanner and survives a real tool round', () => {
    const action = {requestId: 'test', kind: 'comment', postId: 'post', comment: '看到 [[SEARCH:咖啡]] 这几个字'};
    const plain = classifyLLMOutput('晚安\n' + tag(action));
    expect(plain.kind).toBe('finish');
    if (plain.kind === 'finish') expect(plain.directives).toEqual([{type: 'friend_feed_reply', action}]);
    const round = classifyLLMOutput('查一下[[SEARCH:天气]]\n' + tag(action));
    expect(round.kind).toBe('tool-request');
    if (round.kind !== 'tool-request') throw Error('expected tools');
    expect(round.toolCalls).toHaveLength(1);
    expect(round.sanitizedPrefix).not.toContain('requestId');
    const finish = classifyLLMOutput(round.prefix + '\n查到了');
    if (finish.kind !== 'finish') throw Error('expected finish');
    expect(finish.directives).toEqual([{type: 'friend_feed_reply', action}]);
});

it('SAR replies consume only the canonical comment and never a surface imitation', async () => {
    const postId = await queued(), task = (await prepareFriendFeedMainTask(char.id))!;
    const action = {requestId: task.id, kind: 'comment', postId, comment: '真的留好了'};
    const parsed = parseSARModuleReply('<SAR_MODULE_OUTPUT><CHAR_TRUE>好的\n' + tag(action)
        + '</CHAR_TRUE><CHAR_SURFACE>喵\n' + tag({...action, comment: '不应执行'})
        + '</CHAR_SURFACE></SAR_MODULE_OUTPUT>', {requiresEnvelope: true, hasActiveEffect: true,
            hasAfterglow: false, character: {phase: 'active'} as any});
    await applyAssistantPostProcessing(parsed.canonical, context());
    expect((await readFriendFeed()).posts[0].comments.at(-1)?.text).toBe('真的留好了');
});

it('local ChatApp post-processing persists the public comment and quiet card without a control bubble', async () => {
    const postId = await queued();
    const task = (await prepareFriendFeedMainTask(char.id))!;
    await applyAssistantPostProcessing('今晚想吃什么\n' + tag({requestId: task.id, kind: 'comment', postId, comment: '留好了'}), context());
    const messages = await DB.getMessagesByCharId(char.id, true);
    expect(messages.filter(m => m.role === 'assistant').map(m => m.content)).toEqual(['今晚想吃什么']);
    expect(messages.filter(m => m.type === 'friend_feed_card').some(m => m.content.includes('留好了'))).toBe(true);
    expect((await readFriendFeed()).notices![0].done).toBe(true);
});

it('cloud classifier carries the action to the same client post-processor without notification leakage', async () => {
    const postId = await queued();
    const task = (await prepareFriendFeedMainTask(char.id))!;
    const result = classifyLLMOutput('我回来了\n' + tag({requestId: task.id, kind: 'comment', postId, comment: '给你留着'}));
    expect(result.kind).toBe('finish');
    if (result.kind !== 'finish') throw Error('expected finish');
    expect(result.sanitizedBody).not.toContain('FRIEND_FEED');
    expect(result.cleanedText).not.toContain('requestId');
    expect(result.directives).toHaveLength(1);
    await applyAssistantPostProcessing(result.cleanedText, {...context(), directives: result.directives as any});
    expect((await readFriendFeed()).posts[0].comments.at(-1)?.text).toBe('给你留着');
});

it('home main API carries and consumes the JSON side action, preserving the home reply and own context', async () => {
    const postId = await queued();
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body), prompt = body.messages.map((m: any) => m.content).join('\n');
        expect(prompt).toContain('你发布：咖啡做好了');
        expect(prompt).toContain('给我留一杯');
        const requestId = prompt.match(/"requestId":"([^"]+)"/)![1];
        return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify({
            text: '一起坐会儿', actionIds: [], friendFeedAction: {requestId, kind: 'comment', postId, comment: '留了一杯'}
        })}}]}));
    }));
    const reply = await generateHomeReply({char, user: {name: '小雨'} as any,
        api: {baseUrl: 'https://test.invalid', model: 'test'} as any, signal: new AbortController().signal,
        scene: {roomId: 'room', roomName: '客厅', present: true, busy: false, actions: []} as any,
        records: [{id: 'input', turnId: 'input', at: Date.now(), actor: 'user', kind: 'message', source: 'user',
            text: '一起坐会儿', roomId: 'room', roomName: '客厅'}] as any});
    expect(reply.text).toBe('一起坐会儿');
    expect((await readFriendFeed()).posts[0].comments.at(-1)?.text).toBe('留了一杯');
    expect((await readFriendFeed()).notices![0].done).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
});
