import type {FriendFeedState, FriendPost} from './friendFeed';
import {followsFriendPost} from './friendFeedGraph';
export interface FriendNotice {id:string; charId:string; postId:string; createdAt:number; done?:boolean; lease?:{id:string;until:number}}
export interface FriendWeiboBinding {ownerId:string; uid:string; enabled:boolean; generation:string; since:number; initialized?:boolean; page?:number|null}
export interface FriendWeiboStream {circleId:string; since:number; initialized?:boolean; cursor?:string|null; enabled:boolean; generation:string}
export function syncedPostEnabled(feed:FriendFeedState,post:FriendPost) {
    if(!post.synced)return true;
    return post.authorId.startsWith('weibo:') ? feed.weiboStreams?.some(s=>s.circleId===post.circleId && s.enabled)===true
        : feed.weiboBindings?.some(b=>b.ownerId===post.authorId && b.uid===post.source?.accountId && b.enabled)===true;
}
export function followedAuthors(feed:FriendFeedState, charId:string):string[] {
    if(feed.accountGraph) {
        const targets=new Set(feed.accountGraph.accounts.filter(a=>a.ownerId===charId).flatMap(a=>feed.accountGraph!.follows[a.id]||[]));
        return [...new Set(feed.accountGraph.accounts.filter(a=>targets.has(a.id)).map(a=>a.ownerId))];
    }
    return feed.follows?.[charId] ?? (feed.publicFeed ? ['user'] : ['user', ...feed.circles.find(c=>c.memberIds.includes(charId))?.memberIds.filter(id=>id!==charId) || []]);
}
/** No model calls, memory cards or private data. Only publication creates notices. */
export function enqueueFriendNotices(feed:FriendFeedState, post:FriendPost, includeSelf=false) {
    const circle = feed.circles.find(c=>c.id===post.circleId);
    if (!circle || post.source && !circle.realContentEnabled) return;
    feed.notices ||= [];
    for (const charId of post.audienceIds) {
        if (!circle.memberIds.includes(charId) || (charId===post.authorId ? !includeSelf : !followsFriendPost(feed,charId,post))) continue;
        const id = `${post.id}:${charId}`;
        if (!feed.notices.some(n=>n.id===id)) feed.notices.push({id,charId,postId:post.id,createdAt:Date.now()});
    }
    // Bound pending notifications per character without replaying old syncs.
    const counts = new Map<string,number>();
    feed.notices = feed.notices.filter(n=>!n.done).reverse().filter(n=>{
        const count = (counts.get(n.charId)||0)+1; counts.set(n.charId,count);return count<=50;
    }).reverse();
}
