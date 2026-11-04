import {mutateFriendFeed, type FriendComment, type FriendFeedState, type FriendPost} from './friendFeed';
import {syncedPostEnabled} from './friendFeedActivity';
import {resolveFriendFeedSettings} from './friendFeedSettings';

export interface FriendUserNotice {
    id:string;postId:string;commentId:string;createdAt:number;
    kind:'post'|'reply';read?:boolean;announced?:boolean;
}
/** Called inside the same transaction as publication and memory cards. No historical backfill. */
export function enqueueFriendUserNotice(feed:FriendFeedState, post:FriendPost, comment:FriendComment) {
    if(comment.authorId==='user')return;
    const reply=comment.localReply?.authorId==='user';
    if(post.authorId!=='user'&&!reply)return;
    feed.userInbox ||= [];
    if(feed.userInbox.some(n=>n.id===comment.id))return;
    feed.userInbox.push({id:comment.id,postId:post.id,commentId:comment.id,createdAt:comment.createdAt,kind:reply?'reply':'post'});
    // Read history is expendable; never discard an unread reply just because traffic is busy.
    const history=feed.userInbox.filter(n=>n.read).slice(-200);
    const keep=new Set(history.map(n=>n.id));
    feed.userInbox=feed.userInbox.filter(n=>!n.read||keep.has(n.id));
}
export function friendUserInbox(feed:FriendFeedState) {
    const hideReal=resolveFriendFeedSettings(feed.settings).hideRealPosts;
    return (feed.userInbox||[]).flatMap(notice=>{
        const post=feed.posts.find(p=>p.id===notice.postId&&syncedPostEnabled(feed,p)&&(!hideReal||!(p.synced||p.authorKind==='external')));
        const comment=post?.comments.find(c=>c.id===notice.commentId);
        return post&&comment?[{notice,post,comment}]:[];
    }).sort((a,b)=>b.notice.createdAt-a.notice.createdAt||b.notice.id.localeCompare(a.notice.id));
}
export async function markFriendInboxRead(ids:string[]) {
    const wanted=new Set(ids);
    await mutateFriendFeed(feed=>{for(const n of feed.userInbox||[])if(wanted.has(n.id))n.read=true;});
}
/** Transactional claim makes two open tabs and replayed events produce only one banner. */
export async function claimFriendInboxAnnouncements() {
    let result:ReturnType<typeof friendUserInbox>=[];
    await mutateFriendFeed(feed=>{
        result=friendUserInbox(feed).filter(row=>!row.notice.read&&!row.notice.announced);
        for(const row of result)row.notice.announced=true;
    });
    return result;
}
type InboxTarget={postId?:string;commentId?:string};
let pending:InboxTarget|undefined;
const OPEN='friend-feed-open-inbox';
export function requestFriendInbox(target:InboxTarget={}){pending=target;window.dispatchEvent(new Event(OPEN));}
export function consumeFriendInbox(){const target=pending;pending=undefined;return target;}
export function subscribeFriendInboxOpen(fn:()=>void){window.addEventListener(OPEN,fn);return()=>window.removeEventListener(OPEN,fn);}
