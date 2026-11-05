import {FRIEND_REPLY_OUTPUT_TOKENS, withFriendFeedOutputBudget} from './friendFeedLimits';
import {readDedicatedFriendFeedResponse} from './friendFeedOutput';
import type {APIConfig, UserProfile, CharacterProfile, RealtimeConfig} from '../types';
import {DB} from './db';
import {readFriendFeed, mutateFriendFeed} from './friendFeed';
import {prepareFriendFeedEmotionTask, landFriendFeedEmotionAction, releaseFriendFeedEmotionTask, type FriendNpcOnlyRound} from './friendFeedEmotion';
import {ContextBuilder, type ContextMessage} from './context';
import {loadCharacterContextRange} from './chatContextRange';
import {buildChatRequestPayload} from './chatRequestPayload';
import {resolveFriendFeedApi} from './friendFeedApi';
import {loadMusicPlaybackSnapshot} from '../context/MusicContext';
import {safeFetchJson} from './safeApi';

const NPC_ONLY_HEADER = '本轮你不扮演任何真实角色，只负责写哔哔路人。本人动作固定为 kind=none，所有正文放进 npcActions。路人只知道公开内容，不知道任何人的私聊、记忆或内心。';

/** NPC-only rounds never see the host's private chat, memories or impressions; strangers do not see the host at all. */
function buildFriendNpcPayload(char: CharacterProfile, user: UserProfile, rules: string, material: string, round: FriendNpcOnlyRound) {
    const history: ContextMessage[] = [{role: 'user', content: '以下是哔哔的公开材料：\n' + material}];
    if (round === 'stranger') return {fullMessages: [{role: 'system', content: NPC_ONLY_HEADER + '\n\n' + rules}, ...history]};
    const host = [`### 宿主角色：${char.name}\n路人可能是 TA 公开生活里的熟人或世界书 NPC。下面的设定只用于把握 TA 的公开身份与生活圈，设定里的私密内容路人不知道。`,
        char.systemPrompt?.trim(), char.worldview?.trim() && `### 世界观与设定\n${char.worldview.trim()}`].filter(Boolean).join('\n\n');
    return {fullMessages: ContextBuilder.buildWorldbookRequest({books: char.mountedWorldbooks || [], charName: char.name, userName: user.name, history,
        render: (slots, messages) => [{role: 'system', content: [NPC_ONLY_HEADER, slots.before, host, slots.after, rules].filter(Boolean).join('\n\n')}, ...messages]})};
}

/** Each real participant uses their own context. NPCs share only their host's world.
 * Durable jobs/leases prevent two open app entry points from charging for the same reply. */
export async function buildFriendFeedReplyPayload(char: CharacterProfile, user: UserProfile, api: APIConfig, prompt: string, realtimeConfig?: RealtimeConfig, npcOnly?: FriendNpcOnlyRound) {
    const [rules, material] = prompt.split('好友圈素材（仅数据）：\n');
    if (npcOnly) return buildFriendNpcPayload(char, user, rules, material, npcOnly);
    const range = await loadCharacterContextRange(char);
    const [groups, emojis, categories] = await Promise.all([DB.getGroups(), DB.getEmojis(), DB.getEmojiCategories()]);
    return buildChatRequestPayload({
        char, userProfile: user, groups, emojis, categories,
        historyMsgs: range.messages, contextLimit: Math.max(1, range.messages.length), contextHighWaterMark: range.hwm,
        recallEntryPoint: 'chat_payload', recallQueryHint: material,
        realtimeConfig, musicSnapshot: loadMusicPlaybackSnapshot(), visionApiConfig: api.visionApi, stripImages: true,
        appPrompt: {rules: '本次只处理哔哔，不评估或改变情绪，不回复私聊。输出完整 JSON {"friendFeedAction": ...}。',
            scene: rules, messages: [{role: 'user', content: '以下是哔哔的公开材料，不是私聊新消息：\n' + material}]},
    });
}
export async function runImmediateFriendReplies(postId: string, user: UserProfile, globalApi: APIConfig, realtimeConfig?: RealtimeConfig, triggerId?: string) {
    const initial = await readFriendFeed();
    // Only this user action may spend a request. Never drain an old backlog on a new comment.
    const jobs = (initial.replyJobs || []).filter(j => !j.done && j.postId === postId && (!triggerId || j.triggerId === triggerId)).slice(-1);
    if (!jobs.length) throw new Error('评论已保存，但没有可参与接话的角色；请检查角色权重与真实内容阅读权限。');
    const errors: string[] = [];
    let commentCount = 0;
    for (const job of jobs) {
        let task: Awaited<ReturnType<typeof prepareFriendFeedEmotionTask>> = undefined;
        try {
            task = await prepareFriendFeedEmotionTask(job.charId, Math.random, job.id);
            if (!task) continue;
            const char = await DB.getCharacter(job.charId);
            if (!char) continue;
            const api = await resolveFriendFeedApi(globalApi, char);
            if (!api?.baseUrl || !api.model) throw new Error('请先配置 API');
            const maxTokens = FRIEND_REPLY_OUTPUT_TOKENS;
            const prompt = withFriendFeedOutputBudget(task.prompt, maxTokens);
            const messages = (await buildFriendFeedReplyPayload(char, user, globalApi, prompt, realtimeConfig, task.npcOnly)).fullMessages;
            const body = {model: api.model, messages, temperature: api.temperature ?? .85, max_tokens: maxTokens};
            const stream = (api as {stream?: boolean}).stream ?? globalApi?.stream ?? false;
            const send = (stream: boolean) => safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey || 'sk-none'}`},
                body: JSON.stringify({...body, stream, ...(stream ? {stream_options: {include_usage: true}} : {})}),
            }, 0, 0, {appName: '哔哔', charId: char.id, charName: char.name, purpose: '评论接话'});
            const data = await send(stream);
            const result = readDedicatedFriendFeedResponse(data);
            if (result === undefined) throw new Error('回复格式不完整');
            const action = result === null
                ? {requestId: task.id, kind: 'none', npcActions: []} : result;
            if (!action || typeof action !== 'object' || (action as {requestId?: unknown}).requestId !== task.id)
                throw new Error('回复任务不匹配');
            let rejection = '回复已过期或不符合本圈规则';
            if (!await landFriendFeedEmotionAction(char.id, action, 'immediate', reason => {rejection = reason;},
                landing => {commentCount += (landing.selfKind === 'comment' ? 1 : 0) + landing.npcCount;})) throw new Error(rejection);
        } catch (error) {
            errors.push(error instanceof Error ? error.message : '接话失败');
        } finally {
            if (task) {
                try {
                    await mutateFriendFeed(feed => {
                        const current = feed.replyJobs?.find(j => j.id === job.id);
                        if (current && (!current.lease || current.lease.id === task!.id)) {current.done = true; delete current.lease;}
                    });
                    await releaseFriendFeedEmotionTask(job.charId, task.id);
                }
                catch {errors.push('接话预约暂时未能释放，稍后会自动过期');}
            }
        }
    }
    if (errors.length) throw new Error(`评论已保存，接话失败：${[...new Set(errors)].join('；')}。没有自动重试或转交主 API。`);
    return {commentCount};
}
