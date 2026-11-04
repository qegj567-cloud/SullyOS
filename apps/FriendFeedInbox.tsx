import React from 'react';
import {Bell} from '@phosphor-icons/react';
import type {FriendFeedState} from '../utils/friendFeed';
import {friendUserInbox} from '../utils/friendFeedInbox';

export function FriendFeedInboxButton({unread,onClick}:{unread:number;onClick:()=>void}){
    return <button type="button" className="ff-inbox-button" aria-label={`互动提醒${unread?`，${unread} 条未读`:''}`} onClick={onClick}><Bell size={21}/>{unread>0&&<span>{unread>99?'99+':unread}</span>}</button>;
}
export default function FriendFeedInbox({feed,onOpen,onReadAll}:{feed:FriendFeedState;onOpen:(postId:string,commentId:string)=>void;onReadAll:(ids:string[])=>void}){
    const rows=friendUserInbox(feed),unread=rows.filter(r=>!r.notice.read);
    return <section className="ff-inbox" aria-label="哔哔互动提醒"><header><h2>有人接你的话啦</h2><button type="button" disabled={!unread.length} onClick={()=>onReadAll(unread.map(r=>r.notice.id))}>全部已读</button></header>
        <p>评论你的动态，或回复你的评论，都会留在这里。只看提醒不会调用 API。</p>
        {!rows.length&&<p className="friend-feed-empty">还没有新互动，先去广场逛逛吧。</p>}
        {rows.map(({notice,post,comment})=><button key={notice.id} type="button" className="ff-inbox-item" data-unread={!notice.read} onClick={()=>onOpen(post.id,comment.id)}>
            <strong>{comment.authorName}<span>{notice.kind==='reply'?'回复了你的评论':'评论了你的动态'}</span>{!notice.read&&<i aria-label="未读"/>}</strong>
            <p>{comment.text}</p><blockquote>{notice.kind==='reply'?comment.localReply?.text:post.text||'图片动态'}</blockquote>
            <time>{new Date(notice.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time>
        </button>)}
    </section>;
}
