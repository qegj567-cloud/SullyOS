import {FRIEND_POST_TEXT_LIMIT, FRIEND_COMMENT_TEXT_LIMIT} from './friendFeedLimits';
import {DB, openDB} from './db';
import {createLocalId} from './localId.js';
import {activeFriendAccounts, friendAccountRef, normalizeFriendGraph, setFriendAccountFollow, validFriendGraph, type FriendAccountGraph} from './friendFeedGraph';
import {normalizeFriendIdentityName} from './friendFeedIdentity';
import {friendFeedExcerpt} from './friendFeedMaterial';
import {FRIEND_POST_IMAGE_LIMIT, isLocalFriendImage, validFriendImageCards,friendPostText,type FriendImageCard} from './friendFeedImages';
import type {FriendFeedImage} from './friendFeedSource';
import type {CharacterProfile} from '../types';
import {resolveFriendFeedSettings, type FriendFeedSettings} from './friendFeedSettings';
import {friendCommentPool, friendRelationshipBlocked, weightedFriendPick} from './friendFeedCommunity';
import {addFriendFeedNote, announceFriendFeedHistory} from './friendFeedNotes';
import type {FriendUserNotice} from './friendFeedInbox';
import {isFriendFeedSource, type FriendFeedSource} from './friendFeedSource';
import {isWeiboCommentPage, isFriendSourceReply, type WeiboCommentPage, type FriendSourceReply} from './friendFeedSourceComments';
import {enqueueFriendNotices, followedAuthors, syncedPostEnabled, type FriendNotice, type FriendWeiboBinding, type FriendWeiboStream} from './friendFeedActivity';

export const FRIEND_FEED_KEY = 'friend_feed_v1';
export const FRIEND_FEED_CHANGED = 'friend-feed-changed';
export type FriendReplyTarget = {kind:'local'|'source';id:string};
export interface FriendCircle {
    id: string;
    name: string;
    description: string;
    memberIds: string[];
    createdAt: number;
    interactionPrompt?: string;
    realContentEnabled?: boolean;
}
export interface FriendComment {
    id: string;
    authorId: string;
    authorName: string;
    text: string;
    createdAt: number;
    editedAt?: number;
    authorKind?: 'npc' | 'external';
    accountId?: string;
    accountTags?: string[];
    sourceReply?: FriendSourceReply;
    localReply?: {id:string;authorId:string;authorName:string;text:string};
}
export interface FriendPost extends FriendComment {
    discussionRevision?: number;
    imageCards?:FriendImageCard[];
    images?: FriendFeedImage[];
    circleId: string;
    audienceIds: string[];
    comments: FriendComment[];
    source?: FriendFeedSource;
    weiboComments?: WeiboCommentPage;
    /** Synced RP author identity; never an autobiographical memory event. */
    synced?: boolean;
}
export interface FriendReplyJob {
    id: string; postId: string; triggerId: string; charId: string;
    createdAt?: number;
    delivery?: 'immediate';
    replySelf: boolean; npcCount: number; done?: boolean;
    lease?: {id: string; until: number};
}
export const FRIEND_REPLY_JOB_TTL = 24 * 60 * 60 * 1000;
/** Expiry uses elapsed time, including when the page was closed. Old saves use the triggering comment. */
function normalizeReplyJobs(state: FriendFeedState) {
    for (const job of state.replyJobs || []) {
        if (job.done) continue;
        const post = state.posts.find(p => p.id === job.postId);
        const trigger = post?.comments.find(c => c.id === job.triggerId);
        const createdAt = trigger?.createdAt ?? job.createdAt;
        if (job.delivery !== 'immediate' || !createdAt || Date.now() - createdAt >= FRIEND_REPLY_JOB_TTL) {
            job.done = true;
            delete job.lease;
            continue;
        }
        job.createdAt = createdAt;
    }
}
export interface FriendFeedState {version: 1; setupSeen?: boolean; publicFeed?: boolean; archivedCircles?: FriendCircle[];
    accountGraph?:FriendAccountGraph;
    userInbox?:FriendUserNotice[];
    refreshLease?: {id: string; until: number}; circles: FriendCircle[]; posts: FriendPost[]; settings?: FriendFeedSettings; replyJobs?: FriendReplyJob[];
    follows?:Record<string,string[]>; notices?:FriendNotice[]; weiboBindings?:FriendWeiboBinding[]; weiboStreams?:FriendWeiboStream[]; syncLimit?:number; hiddenSources?:string[]}
export const PUBLIC_FRIEND_FEED = 'public';
/** Keep the legacy groups as archive metadata; post IDs, comments and memories never change. */
export function normalizePublicFriendFeed(state: FriendFeedState, characters: Pick<CharacterProfile, 'id'>[]) {
    normalizeFriendGraph(state,characters);
    if (!state.publicFeed) return;
    const members = characters.map(c => c.id);
    const settings = resolveFriendFeedSettings(state.settings);
    const old = state.circles[0];
    state.circles = [{id: PUBLIC_FRIEND_FEED, name: '公共广场', description: '熟悉的人，偶遇的新朋友。',
        memberIds: members, createdAt: old?.createdAt || Date.now(), realContentEnabled: settings.realContentEnabled}];
    for (const post of state.posts) {post.circleId = PUBLIC_FRIEND_FEED; post.audienceIds = members;}
}
export async function ensurePublicFriendFeed() {
    await mutateFriendFeed((state, chars) => {
        if (!state.publicFeed) {
            const previous = state.circles;
            state.archivedCircles = previous;
            // Old per-circle grants are not broadened by merging. Mixed grants require a new global opt-in.
            state.settings = {...resolveFriendFeedSettings(state.settings), realContentEnabled: previous.length > 0 && previous.every(c => c.realContentEnabled === true) && chars.every(char => previous.some(c => c.memberIds.includes(char.id)))};
            state.hiddenSources = state.hiddenSources?.map(key => {
                const c = previous.find(c => key.startsWith(c.id + ':'));
                return c ? PUBLIC_FRIEND_FEED + key.slice(c.id.length) : key;
            });
            const streams = state.weiboStreams || [];
            if (streams.length) state.weiboStreams = [{circleId: PUBLIC_FRIEND_FEED, enabled: streams.some(s => s.enabled),
                generation: createLocalId(), since: Math.max(...streams.map(s => s.since)), initialized: streams.every(s => s.initialized === true), cursor: '0'}];
            state.publicFeed = true;
        }
        normalizePublicFriendFeed(state, chars);
    });
}
export const emptyFriendFeed = (): FriendFeedState => ({version: 1, circles: [], posts: []});

export function parseFriendFeed(raw: string | null): FriendFeedState {
    if (!raw) return emptyFriendFeed();
    const data = JSON.parse(raw);
    if(data.accountGraph!==undefined&&!validFriendGraph(data.accountGraph))throw new Error('哔哔账号关系无法读取，请保留备份');
    const text = (s: unknown) => typeof s === 'string';
    const time = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 8.64e15;
    const ids = (a: unknown): a is string[] => Array.isArray(a) && a.every(text);
    const comment = (p: any) => p && text(p.id) && text(p.authorId) && !!p.authorId && text(p.authorName)
        && text(p.text) && time(p.createdAt) && (p.editedAt === undefined || time(p.editedAt)) && (p.accountId === undefined || text(p.accountId))
        && (p.accountTags === undefined || ids(p.accountTags))
        && (p.sourceReply === undefined || isFriendSourceReply(p.sourceReply))
        && (p.localReply === undefined || p.localReply && text(p.localReply.id) && text(p.localReply.authorId) && text(p.localReply.authorName) && text(p.localReply.text));
    if (data?.version !== 1 || !Array.isArray(data.circles) || !Array.isArray(data.posts)
        || !data.circles.every((c: any) => c && text(c.id) && text(c.name) && text(c.description)
            && ids(c.memberIds) && time(c.createdAt) && (c.interactionPrompt === undefined || text(c.interactionPrompt))
            && (c.realContentEnabled === undefined || typeof c.realContentEnabled === 'boolean'))
        || !data.posts.every((p: any) => comment(p) && text(p.circleId) && ids(p.audienceIds)
            &&(p.imageCards===undefined||validFriendImageCards(p.imageCards))
            && (p.images === undefined || Array.isArray(p.images) && p.images.length <= FRIEND_POST_IMAGE_LIMIT
                && p.images.every((i: any) => i && (isLocalFriendImage(i.url) || i.url === '') && i.thumbnail === i.url))
            && (p.discussionRevision === undefined || Number.isSafeInteger(p.discussionRevision) && p.discussionRevision >= 0)
            && Array.isArray(p.comments) && p.comments.every(comment)
            && (p.source === undefined || isFriendFeedSource(p.source))
            && (p.weiboComments === undefined || p.source?.platform === 'weibo' && isWeiboCommentPage(p.weiboComments))
            && (p.synced === undefined || typeof p.synced === 'boolean')
            && (p.authorKind !== 'external' || isFriendFeedSource(p.source)))
        || (data.replyJobs !== undefined && (!Array.isArray(data.replyJobs) || !data.replyJobs.every((j: any) =>
            j && text(j.id) && text(j.postId) && text(j.triggerId) && text(j.charId) && typeof j.replySelf === 'boolean'
            && Number.isInteger(j.npcCount) && j.npcCount >= 0 && j.npcCount <= 6
            && (j.createdAt === undefined || time(j.createdAt))
            && (j.delivery === undefined || j.delivery === 'immediate')
            && (j.done === undefined || typeof j.done === 'boolean')
            && (j.lease === undefined || (text(j.lease.id) && time(j.lease.until))))))) {
        throw new Error('哔哔数据无法读取，请保留备份后重试');
    }
    if (data.publicFeed !== undefined && typeof data.publicFeed !== 'boolean' || data.refreshLease !== undefined && (!text(data.refreshLease?.id) || !time(data.refreshLease?.until))) throw new Error('哔哔刷新状态无法读取');
    if (data.follows !== undefined && (!data.follows || typeof data.follows !== 'object' || Array.isArray(data.follows) || !Object.values(data.follows).every(ids))) throw new Error('哔哔关注数据无法读取');
    if (data.notices !== undefined && (!Array.isArray(data.notices) || !data.notices.every((n:any)=>n && text(n.id) && text(n.charId) && text(n.postId) && time(n.createdAt)
        && (n.done===undefined || typeof n.done==='boolean') && (n.lease===undefined || text(n.lease.id) && time(n.lease.until))))) throw new Error('哔哔通知数据无法读取');
    if (data.weiboBindings !== undefined && (!Array.isArray(data.weiboBindings) || !data.weiboBindings.every((b:any)=>b && text(b.ownerId) && /^\d{4,25}$/.test(b.uid)
        && typeof b.enabled==='boolean' && text(b.generation) && time(b.since)))) throw new Error('哔哔微博绑定无法读取');
    if (data.weiboStreams !== undefined && (!Array.isArray(data.weiboStreams) || !data.weiboStreams.every((b:any)=>b && text(b.circleId) && typeof b.enabled==='boolean' && text(b.generation) && time(b.since)))) throw new Error('哔哔微博关注流无法读取');
    if (data.hiddenSources!==undefined && !ids(data.hiddenSources)) throw new Error('哔哔来源屏蔽数据无法读取');
    if(data.userInbox!==undefined&&(!Array.isArray(data.userInbox)||!data.userInbox.every((n:any)=>n&&text(n.id)&&text(n.postId)&&text(n.commentId)&&time(n.createdAt)
        &&['post','reply'].includes(n.kind)&&(n.read===undefined||typeof n.read==='boolean')&&(n.announced===undefined||typeof n.announced==='boolean'))))throw new Error('哔哔收件提醒无法读取');
    normalizeReplyJobs(data);
    return data;
}

export async function saveFriendFeedSettings(settings: FriendFeedSettings) {
    if (typeof settings.interactionPrompt !== 'string' || settings.interactionPrompt.length > 3000)
        throw new Error('哔哔提示词最多 3000 字');
    if(settings.npcPrompt!==undefined&&(typeof settings.npcPrompt!=='string'||settings.npcPrompt.length>3000))throw new Error('路人提示词最多 3000 字');
    const user=await DB.getUserProfile();
    await mutate(state => {
        const next=resolveFriendFeedSettings(settings);
        const reserved=new Set(['user','用户','我',user?.name||'',next.userNickname||'',
            ...state.posts.flatMap(p=>[p,...p.comments]).filter(c=>c.authorId==='user').map(c=>c.authorName)].map(normalizeFriendIdentityName).filter(Boolean));
        if(Object.values(next.identities).some(i=>[i.nickname,...i.accounts.map(a=>a.name)].some(n=>!!n&&reserved.has(normalizeFriendIdentityName(n)))))
            throw Error('角色账号不能使用你的姓名或网名，请换一个名字');
        state.settings = next;
    });
}

export async function updateFriendRelation(change:{kind:'follow';sourceId:string;targetId:string;value:boolean}|{kind:'known';viewerId:string;targetId:string;value:boolean}) {
    await mutate((feed,characters)=>{
        const accounts=activeFriendAccounts(feed,characters),target=accounts.find(a=>a.id===change.targetId);
        if(!target)throw Error('这个账号已停用，请重新打开关系列表');
        if(change.kind==='follow') {
            if(!accounts.some(a=>a.id===change.sourceId))throw Error('当前账号已停用');
            setFriendAccountFollow(feed,change.sourceId,change.targetId,change.value);
        } else {
            if(!characters.some(c=>c.id===change.viewerId)||target.ownerId===change.viewerId)throw Error('请选择其他账号的身份认知');
            (feed.accountGraph!.known[change.viewerId] ||= {})[change.targetId]=change.value;
        }
    });
}

export const readFriendFeed = async () => {
    const state = parseFriendFeed(await DB.getAsset(FRIEND_FEED_KEY));
    normalizePublicFriendFeed(state, await DB.getAllCharacters());
    return state;
};

export function announceFriendFeedChanged() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new Event(FRIEND_FEED_CHANGED));
    if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel(FRIEND_FEED_CHANGED);
        channel.postMessage('changed');
        channel.close();
    }
}
export function subscribeFriendFeed(refresh: () => void) {
    window.addEventListener(FRIEND_FEED_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(FRIEND_FEED_CHANGED) : null;
    if (channel) channel.onmessage = refresh;
    return () => {
        window.removeEventListener(FRIEND_FEED_CHANGED, refresh);
        window.removeEventListener('focus', refresh);
        channel?.close();
    };
}

/** Both entry points mutate the same latest state in one transaction. No stale
 * component snapshot may replace another window's new post or comment. */
export async function mutateFriendFeed(update: (state: FriendFeedState, characters: CharacterProfile[], tx: IDBTransaction) => void) {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['assets', 'characters', 'messages'], 'readwrite');
        const assets = tx.objectStore('assets');
        const request = assets.get(FRIEND_FEED_KEY);
        let failure: unknown;
        request.onsuccess = () => {
            const chars = tx.objectStore('characters').getAll();
            chars.onsuccess = () => {
                try {
                    const state = parseFriendFeed(request.result?.data ?? null);
                    normalizePublicFriendFeed(state, chars.result);
                    update(state, chars.result, tx);
                    normalizePublicFriendFeed(state, chars.result);
                    assets.put({id: FRIEND_FEED_KEY, data: JSON.stringify(state)});
                } catch (error) { failure = error; tx.abort(); }
            };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('哔哔保存失败，请重试'));
    });
    announceFriendFeedChanged();
}
const mutate = mutateFriendFeed;

function cleanText(value: string, max: number, label: string) {
    const text = value.trim();
    if (!text || text.length > max) throw new Error(`${label}请填写 1–${max} 个字`);
    return text;
}
export async function saveFriendCircle(input: Pick<FriendCircle, 'name' | 'description' | 'memberIds' | 'interactionPrompt' | 'realContentEnabled'> & {id?: string}) {
    const id = input.id || createLocalId();
    await mutate((state, characters) => {
        if (state.publicFeed) throw new Error('已使用公共广场，请在设置中调整互动风格与角色账号');
        const known = new Set(characters.map(c => c.id));
        const memberIds = [...new Set(input.memberIds)];
        if ((!input.id && !memberIds.length) || memberIds.some(id => !known.has(id))) throw new Error('请选择仍然存在的角色加入生活圈');
        if (state.circles.some(c => c.id !== id && c.memberIds.some(m => memberIds.includes(m))))
            throw new Error('角色已在其他生活圈，请先从原圈移出');
        const old = state.circles.find(c => c.id === id);
        if (input.id && !old) throw new Error('这个生活圈已不存在');
        if (input.description.length > 1000) throw new Error('共同背景最多 1000 字');
        if (input.interactionPrompt !== undefined && (typeof input.interactionPrompt !== 'string' || input.interactionPrompt.length > 1500))
            throw new Error('本圈互动提示词最多 1500 字');
        const circle = {id, name: cleanText(input.name, 30, '圈名'), description: input.description.trim(),
            interactionPrompt: input.interactionPrompt?.trim() ?? old?.interactionPrompt,
            realContentEnabled: input.realContentEnabled ?? old?.realContentEnabled ?? false,
            memberIds, createdAt: old?.createdAt ?? Date.now()};
        state.circles = old ? state.circles.map(c => c.id === id ? circle : c) : [...state.circles, circle];
    });
    return id;
}
/** Import is discovery material, not an authored action: no character memory on import. */
export async function importFriendSource(circleId: string, source: FriendFeedSource) {
    if (!isFriendFeedSource(source)) throw new Error('真实帖子来源信息不完整');
    let id = '';
    await mutate((state, characters) => {
        circleId = state.publicFeed ? PUBLIC_FRIEND_FEED : circleId;
        const circle = state.circles.find(c => c.id === circleId);
        if (!circle) throw new Error('生活圈已不存在');
        const existing = state.posts.find(p => p.circleId === circleId && p.authorKind === 'external'
            && p.source?.platform === source.platform && p.source.externalId === source.externalId);
        if (existing) {id = existing.id; return;}
        const audienceIds = circle.memberIds.filter(id => characters.some(c => c.id === id));
        if (!audienceIds.length) throw new Error('请先给生活圈添加角色');
        id = createLocalId();
        state.posts.push({id, circleId: circle.id, audienceIds, authorId: `external:${source.platform}:${source.externalId}`,
            authorName: source.author, authorKind: 'external', text: source.text, createdAt: Date.now(), comments: [], source});
    });
    return id;
}
export async function publishFriendPost(circleId: string, authorName: string, body: string, id = createLocalId(), images: FriendFeedImage[] = []) {
    if (images.length > FRIEND_POST_IMAGE_LIMIT || !images.every(i => i && isLocalFriendImage(i.url) && i.thumbnail === i.url)) throw new Error('动态最多添加 9 张本地图片');
    if (!body.trim() && !images.length) throw new Error('请写点什么或添加图片');
    await mutate((state, characters) => {
        if (state.posts.some(p => p.id === id)) return;
        circleId = state.publicFeed ? PUBLIC_FRIEND_FEED : circleId;
        const circle = state.circles.find(c => c.id === circleId);
        if (!circle) throw new Error('生活圈已不存在，请重新选择');
        const live = new Set(characters.map(c => c.id));
        const audienceIds = circle.memberIds.filter(id => live.has(id));
        if (!state.publicFeed && !audienceIds.length) throw new Error('圈内已没有角色，请先调整成员');
        state.posts.push({id, circleId: circle.id, authorId: 'user', accountId:'main', authorName: cleanText(resolveFriendFeedSettings(state.settings).userNickname||authorName, 100, '名字'),
            text: body.trim() ? cleanText(body, FRIEND_POST_TEXT_LIMIT, '动态') : '', createdAt: Date.now(), audienceIds, comments: [],
            ...(images.length ? {images: images.map(i => ({...i}))} : {})});
        enqueueFriendNotices(state, state.posts.at(-1)!);
    });
    return id;
}
export async function commentOnFriendPost(postId: string, authorName: string, body: string, id = createLocalId(), random = Math.random, replyTarget?:FriendReplyTarget) {
    const changed: string[] = [];
    await mutate((state, characters, tx) => {
        const post = state.posts.find(p => p.id === postId);
        if (!post) throw new Error('这条动态已被删除');
        if (post.comments.some(c => c.id === id)) return;
        if(!syncedPostEnabled(state,post))throw new Error('这条动态的来源已停用');
        const local=replyTarget?.kind==='local'?post.comments.find(c=>c.id===replyTarget.id):undefined;
        const original=replyTarget?.kind==='source'?post.weiboComments?.rows.find(c=>c.id===replyTarget.id):undefined;
        if(replyTarget&&!local&&!original)throw new Error('要回复的评论已不存在，请返回评论区重新选择');
        const replyTo=local?{localReply:{id:local.id,authorId:local.authorId,authorName:local.authorName,text:friendFeedExcerpt(local.text)}}
            :original?{sourceReply:{id:original.id,authorName:original.authorName,text:original.text.slice(0,1200)}}:{};
        authorName=resolveFriendFeedSettings(state.settings).userNickname||authorName;
        post.comments.push({id, authorId: 'user', accountId:'main', authorName: cleanText(authorName, 100, '名字'),
            text: cleanText(body, FRIEND_COMMENT_TEXT_LIMIT, '评论'), createdAt: Date.now(),...replyTo});
        const eligible = characters.filter(c => friendPostsForCharacter(state, c.id).some(p => p.id === postId));
        const owner = eligible.find(c => c.id === post.authorId && post.authorKind !== 'npc');
        if (owner) {
            addFriendFeedNote(tx, owner.id, {kind: 'received', postId, commentId: id, postAuthor: post.authorName,
                accountName: post.accountId && post.accountId !== 'main' ? post.authorName : undefined,
                postExcerpt: friendFeedExcerpt(friendPostText(post)), comment: `${authorName}：${body.trim()}${local||original?`（回复 @${(local||original)!.authorName}）`:''}`, source: post.source});
            changed.push(owner.id);
        }
        // Roll once at publication, then persist the cast; retries never reroll it.
        const settings=resolveFriendFeedSettings(state.settings);
        const addressed=local&&eligible.find(c=>c.id===local.authorId);
        if(addressed&&addressed.id!==owner?.id){
            addFriendFeedNote(tx,addressed.id,{kind:'replied',postId,commentId:id,postAuthor:post.authorName,postExcerpt:friendFeedExcerpt(friendPostText(post)),
                replyTo:local.text,comment:`${authorName}：${body.trim()}`,source:post.source});changed.push(addressed.id);
        }
        const pool=friendCommentPool(eligible,post,settings,state);
        const ordered=owner&&pool.includes(owner)?[owner,...pool.filter(c=>c.id!==owner.id)]:pool;
        const executor=addressed&&(settings.characterWeights[addressed.id]??10)>0&&!friendRelationshipBlocked(addressed,owner)?addressed
            :weightedFriendPick(ordered.map(c=>({value:c,weight:settings.characterWeights[c.id]??10})),random);
        const npcCount=settings.npcEnabled&&executor?.phoneState?.allowFictionalContacts!==false?3+Math.min(3,Math.max(0,Math.floor(random()*4))):0;
        const replySelf=random()<.8||!npcCount;
        const jobs=executor?[{id:`${id}:${executor.id}`,postId,triggerId:id,charId:executor.id,replySelf,npcCount,createdAt:post.comments.at(-1)!.createdAt,delivery:'immediate' as const}]:[];
        // Completed jobs aren't needed for replay: the user comment ID is the idempotency key.
        state.replyJobs = [...(state.replyJobs || []).filter(j => !j.done), ...jobs];
    });
    announceFriendFeedHistory(changed);
    return id;
}
/** Local discussion edits preserve existing historical memory cards. */
export async function editFriendComment(postId: string, commentId: string, body: string, expectedText: string) {
    const text = cleanText(body, FRIEND_COMMENT_TEXT_LIMIT, '评论');
    await mutate(state => {
        const post = state.posts.find(p => p.id === postId);
        const comment = post?.comments.find(c => c.id === commentId);
        if (!post || !comment) throw new Error('这条评论已被删除');
        if (comment.text !== expectedText) throw new Error('评论已在其他窗口修改，请返回后重新编辑');
        if (comment.text === text) return;
        comment.text = text;
        comment.editedAt = Date.now();
        post.discussionRevision = (post.discussionRevision || 0) + 1;
        for (const reply of post.comments) if (reply.localReply?.id === commentId) reply.localReply.text = friendFeedExcerpt(text);
        state.replyJobs = state.replyJobs?.filter(j => j.postId !== postId || j.triggerId !== commentId);
    });
}
export async function deleteFriendComment(postId: string, commentId: string, expectedText: string) {
    await mutate(state => {
        const post = state.posts.find(p => p.id === postId);
        const comment = post?.comments.find(c => c.id === commentId);
        if (!post || !comment) return;
        if (comment.text !== expectedText) throw new Error('评论已在其他窗口修改，请返回后重新确认');
        post.comments = post.comments.filter(c => c.id !== commentId);
        post.discussionRevision = (post.discussionRevision || 0) + 1;
        // Keep replies, but never keep the deleted text in their quotes.
        const detached = new Set<string>();
        for (const reply of post.comments) if (reply.localReply?.id === commentId) { delete reply.localReply; detached.add(reply.id); }
        state.userInbox = state.userInbox?.filter(n => n.postId !== postId || n.commentId !== commentId && !(n.kind === 'reply' && detached.has(n.commentId)));
        state.replyJobs = state.replyJobs?.filter(j => j.postId !== postId || j.triggerId !== commentId);
    });
}
export async function deleteFriendPost(postId: string) {
    await mutate(state => {const post=state.posts.find(p=>p.id===postId);
        if(post?.synced && post.source) state.hiddenSources=[...new Set([...(state.hiddenSources||[]),`${post.circleId}:${post.authorId}:${post.source.externalId}`])];
        state.posts = state.posts.filter(p => p.id !== postId);
        state.notices=state.notices?.filter(n=>n.postId!==postId);
        state.userInbox=state.userInbox?.filter(n=>n.postId!==postId);
        state.replyJobs = state.replyJobs?.filter(j => j.postId !== postId);});
}
export async function saveFriendFollows(charId:string, authors:string[]) {
    await mutate((feed,chars)=>{
        if(!chars.some(c=>c.id===charId)) throw Error('角色已不存在');
        const circle=feed.circles.find(c=>c.memberIds.includes(charId));
        const known=new Set(['user',...(circle?.memberIds||[]),...feed.posts.filter(p=>p.circleId===circle?.id).map(p=>p.authorId)]);
        feed.follows ||= {}; feed.follows[charId]=[...new Set(authors)].filter(id=>id!==charId && known.has(id)).slice(0,200);
        const source=friendAccountRef(feed,{authorId:charId})!;
        const targets=feed.follows[charId].map(authorId=>friendAccountRef(feed,{authorId})).filter(a=>!!a);
        for(const target of feed.accountGraph!.accounts.filter(a=>a.accountId==='main'&&a.id!==source.id))setFriendAccountFollow(feed,source.id,target.id,targets.some(a=>a.id===target.id));
        feed.notices=feed.notices?.filter(n=>n.charId!==charId || feed.posts.some(p=>p.id===n.postId && (p.authorId===charId || followedAuthors(feed,charId).includes(p.authorId))));
    });
}
/** For future character browsing: audience at publication AND current membership.
 * Opening the user's feed does not mean a character has read any of these posts. */
export function friendPostsForCharacter(state: FriendFeedState, charId: string) {
    const circles = new Set(state.circles.filter(c => c.memberIds.includes(charId)).map(c => c.id));
    return state.posts.filter(p => (state.publicFeed || circles.has(p.circleId) && p.audienceIds.includes(charId))
        && syncedPostEnabled(state,p)
        && (!p.source || (state.publicFeed ? resolveFriendFeedSettings(state.settings).realContentEnabled : state.circles.find(c => c.id === p.circleId)?.realContentEnabled === true)));
}
