import {FRIEND_FEED_OUTPUT_TOKENS, FRIEND_REPLY_OUTPUT_TOKENS} from './friendFeedLimits';
import {parseDedicatedFriendFeedAction} from './friendFeedOutput';
import type {APIConfig, RealtimeConfig, UserProfile} from '../types';
import {DB} from './db';
import {createLocalId} from './localId.js';
import {mutateFriendFeed, readFriendFeed, PUBLIC_FRIEND_FEED, friendPostsForCharacter} from './friendFeed';
import {friendCommentPool, weightedFriendPick} from './friendFeedCommunity';
export {weightedFriendPick} from './friendFeedCommunity';
import {resolveFriendFeedSettings, type FriendRefreshKind} from './friendFeedSettings';
import {syncWeibo,syncWeiboHome,readWeiboConnection,weiboSyncMessage,type WeiboSyncResult} from './friendFeedWeibo';
import {prepareFriendFeedEmotionTask, landFriendFeedEmotionAction, releaseFriendFeedEmotionTask} from './friendFeedEmotion';
import {buildFriendFeedReplyPayload} from './friendFeedReplies';
import {resolveFriendFeedApi} from './friendFeedApi';
import {extractAssistantText} from './emotionApply';
import {safeFetchJson} from './safeApi';

/** Independent from model configuration and the AI generation lease. */
export async function refreshFriendWeibo(onStatus:(status:string)=>void=()=>{}) {
    const feed=await readFriendFeed(),warnings:string[]=[];
    const owners=(feed.weiboBindings||[]).filter(b=>b.enabled&&(b.ownerId==='user'||feed.circles.some(c=>c.memberIds.includes(b.ownerId)))).map(b=>b.ownerId);
    if(feed.weiboStreams?.some(s=>s.enabled&&s.circleId===PUBLIC_FRIEND_FEED))owners.push('following');
    const summary:WeiboSyncResult={received:0,added:0,existing:0,hidden:0};let completed=0;
    // Upgrade existing scanned connections on the next explicit refresh; respect an explicit off switch.
    const initializeHome=!!readWeiboConnection()&&!feed.weiboStreams?.some(s=>s.circleId===PUBLIC_FRIEND_FEED);
    const attempted=owners.length+(initializeHome?1:0);
    if(attempted)onStatus('正在刷新微博…');
    if(initializeHome){try{const result=await syncWeiboHome(PUBLIC_FRIEND_FEED);completed++;
        for(const key of ['received','added','existing','hidden'] as const)summary[key]+=result[key];
        if(result.profileError)warnings.push('账号资料：'+result.profileError);
    }catch(e){warnings.push(e instanceof Error?e.message:'微博刷新失败');}}
    for(const owner of owners){
        try{const result=await syncWeibo(PUBLIC_FRIEND_FEED,owner);completed++;
            for(const key of ['received','added','existing','hidden'] as const)summary[key]+=result[key];}
        catch(e){warnings.push(e instanceof Error?e.message:'微博刷新失败');}
    }
    const message=completed?weiboSyncMessage(summary):attempted?'微博读取失败，已有内容已保留':'';
    if(message)onStatus(message);
    return {warnings,message,attempted,completed};
}

/** Manual refresh: imported content becomes visible before a single character request begins. */
export async function refreshFriendFeed(user: UserProfile, globalApi: APIConfig, realtimeConfig?: RealtimeConfig,
    onStatus: (status: string) => void = () => {}, random = Math.random, commentPostId?: string) {
    const source=commentPostId?'comments':'refresh';
    const lease = createLocalId(), warnings: string[] = [];
    const weibo=commentPostId?undefined:await refreshFriendWeibo(onStatus);
    if(weibo)warnings.push(...weibo.warnings);
    let acquired=false;
    await mutateFriendFeed(feed => {
        if (feed.refreshLease && feed.refreshLease.until > Date.now()) {
            if(weibo?.attempted)return;
            throw Error('朋友们正在赶来，请等这次刷新完成');
        }
        feed.refreshLease = {id: lease, until: Date.now() + 10 * 60 * 1000};
        acquired=true;
    });
    if(!acquired)return {warnings:[...warnings,'角色 API 仍在处理，本次只刷新微博'],message:weibo!.message};
    let task: Awaited<ReturnType<typeof prepareFriendFeedEmotionTask>>, charId = '';
    try {
        onStatus(commentPostId?'朋友们正在翻看评论…':(weibo?.message?weibo.message+'；':'')+'朋友们正在赶来发动态…');
        const current = await readFriendFeed(), settings = resolveFriendFeedSettings(current.settings);
        const characters = await DB.getAllCharacters();
        const post=commentPostId?current.posts.find(p=>p.id===commentPostId):undefined;
        if(commentPostId&&!post)throw Error('这条动态已经不存在');
        const pool=post?friendCommentPool(characters.filter(c=>friendPostsForCharacter(current,c.id).some(p=>p.id===post.id)),post,settings,current):characters;
        const char = weightedFriendPick(pool.map(c => ({value: c, weight: settings.characterWeights[c.id] ?? 10})), random);
        const kind = weightedFriendPick((['self', 'related', 'stranger'] as FriendRefreshKind[]).map(value => ({value,
            weight: value !== 'self' && (!settings.npcEnabled||char?.phoneState?.allowFictionalContacts===false) ? 0 : settings.contentWeights[value]})), random);
        if (!char || !kind) return {warnings, message: weibo?.message||(post?.source&&!settings.realContentEnabled?'尚未允许角色阅读真实内容，可在设置中开启':'没有可抽取的角色或内容类型，请在设置中调整权重')};
        charId = char.id;
        const api = await resolveFriendFeedApi(globalApi, char);
        if (!api?.baseUrl || !api.model) throw Error('请在哔哔的 API 设置中配置独立 API，或检查角色 / 全局 API；已有内容已保留');
        task = await prepareFriendFeedEmotionTask(charId, random, undefined, source, kind, commentPostId);
        if (!task) return {warnings, message: '已刷新，这位朋友刚刚参与过，稍后再试'};
        const messages = (await buildFriendFeedReplyPayload(char, user, globalApi, task.prompt, realtimeConfig)).fullMessages;
        const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey || 'sk-none'}`},
            body: JSON.stringify({model: api.model, messages, temperature: api.temperature ?? .85, max_tokens: commentPostId ? FRIEND_REPLY_OUTPUT_TOKENS : FRIEND_FEED_OUTPUT_TOKENS, stream: api.stream ?? false,
                ...(api.stream ? {stream_options: {include_usage: true}} : {})}),
        }, 0, 0, {appName: '哔哔', charId, charName: char.name, purpose: commentPostId?'刷新评论':'刷新动态'});
        const result = parseDedicatedFriendFeedAction(extractAssistantText(data.choices?.[0]?.message));
        if (result === undefined) throw Error('动态生成格式不完整，请重试');
        const action = result === null ? {requestId: task.id, kind: 'none'} : result;
        if (!action || typeof action !== 'object' || (action as {requestId?: string}).requestId !== task.id)
            throw Error('动态生成任务不匹配，请重试');
        let rejection='模型返回的动作不符合本轮要求，内容未保存';
        if (!await landFriendFeedEmotionAction(charId, action, source,reason=>{rejection=reason;})) throw Error('内容未发布：'+rejection);
        const row = action as {kind?: string; npcActions?: unknown[]};
        return {warnings, message: row.kind === 'none' && !row.npcActions?.length ? '刷新完成，这次朋友们没有新回应' : commentPostId?'新评论已送达':'新动态已送达'};
    } catch(e) {
        if(!weibo?.attempted)throw e;
        warnings.push('角色 API：'+(e instanceof Error?e.message:'生成失败'));
        return {warnings,message:weibo.message};
    } finally {
        try {if (task) await releaseFriendFeedEmotionTask(charId, task.id);}
        finally {await mutateFriendFeed(feed => {if (feed.refreshLease?.id === lease) delete feed.refreshLease;});}
    }
}
