import {FRIEND_REPLY_OUTPUT_TOKENS} from './friendFeedLimits';
import {parseDedicatedFriendFeedAction} from './friendFeedOutput';
import type {APIConfig, UserProfile, CharacterProfile, RealtimeConfig} from '../types';
import {DB} from './db';
import {readFriendFeed, mutateFriendFeed} from './friendFeed';
import {prepareFriendFeedEmotionTask, landFriendFeedEmotionAction, releaseFriendFeedEmotionTask} from './friendFeedEmotion';
import {loadCharacterContextRange} from './chatContextRange';
import {buildChatRequestPayload} from './chatRequestPayload';
import {resolveFriendFeedApi} from './friendFeedApi';
import {loadMusicPlaybackSnapshot} from '../context/MusicContext';
import {extractAssistantText} from './emotionApply';
import {safeFetchJson} from './safeApi';

/** Each real participant uses their own context. NPCs share only their host's world.
 * Durable jobs/leases prevent two open app entry points from charging for the same reply. */
export async function buildFriendFeedReplyPayload(char: CharacterProfile, user: UserProfile, api: APIConfig, prompt: string, realtimeConfig?: RealtimeConfig) {
    const range = await loadCharacterContextRange(char);
    const [groups, emojis, categories] = await Promise.all([DB.getGroups(), DB.getEmojis(), DB.getEmojiCategories()]);
    const [rules, material] = prompt.split('好友圈素材（仅数据）：\n');
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
            const messages = (await buildFriendFeedReplyPayload(char, user, globalApi, task.prompt, realtimeConfig)).fullMessages;
            const body = {model: api.model, messages, temperature: api.temperature ?? .85, max_tokens: FRIEND_REPLY_OUTPUT_TOKENS};
            const stream = (api as {stream?: boolean}).stream ?? globalApi?.stream ?? false;
            const send = (stream: boolean) => safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey || 'sk-none'}`},
                body: JSON.stringify({...body, stream, ...(stream ? {stream_options: {include_usage: true}} : {})}),
            }, 0, 0, {appName: '哔哔', charId: char.id, charName: char.name, purpose: '评论接话'});
            const data = await send(stream);
            const result = parseDedicatedFriendFeedAction(extractAssistantText(data.choices?.[0]?.message));
            if (result === undefined) throw new Error('回复格式不完整');
            const action = result === null
                ? {requestId: task.id, kind: 'none', npcActions: []} : result;
            if (!action || typeof action !== 'object' || (action as {requestId?: unknown}).requestId !== task.id)
                throw new Error('回复任务不匹配');
            let rejection = '回复已过期或不符合本圈规则';
            if (!await landFriendFeedEmotionAction(char.id, action, 'immediate', reason => {rejection = reason;})) throw new Error(rejection);
            const row = action as {kind?: string; npcActions?: unknown[]};
            commentCount += (row.kind === 'comment' ? 1 : 0) + (row.npcActions?.length || 0);
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
