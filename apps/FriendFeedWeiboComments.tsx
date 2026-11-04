import React, {useEffect, useRef, useState} from 'react';
import {ArrowClockwise} from '@phosphor-icons/react';
import type {FriendPost} from '../utils/friendFeed';
import {readWeiboConnection, syncWeiboComments} from '../utils/friendFeedWeibo';
import FriendFeedAvatar from './FriendFeedAvatar';

export default function FriendFeedWeiboComments({post,onReply,onProfile}:{post:FriendPost;onReply?:(id:string)=>void;onProfile?:(uid:string)=>void}) {
    const [busy,setBusy]=useState(false), [error,setError]=useState('');
    const active=useRef(true), running=useRef(false);
    async function load(older=false) {
        if(running.current)return;running.current=true;setBusy(true);setError('');
        try{await syncWeiboComments(post.id,older);}
        catch(e){if(active.current)setError(e instanceof Error?e.message:'暂时读不到原评论');}
        finally{running.current=false;if(active.current)setBusy(false);}
    }
    useEffect(()=>{active.current=true;
        if(!post.weiboComments && readWeiboConnection())void load();
        return()=>{active.current=false;};
    },[post.id]);
    const page=post.weiboComments;
    return <section className="ff-detail-discussion ff-original-comments" aria-label="微博原评论">
        <header><h2>微博原评论 <small>{page?.rows.length||0}</small></h2>
            <button aria-label="刷新微博原评论" disabled={busy} onClick={()=>void load()}><ArrowClockwise size={18} className={busy?'friend-feed-spinner':''}/></button></header>
        <p className="ff-discussion-hint">按时间 · 角色默认看最近 10 条，接话留在本地讨论。</p>
        {busy&&<p role="status" className="ff-discussion-hint">正在读取微博原评论…</p>}
        {error&&<p role="alert" className="ff-discussion-hint">{error}</p>}
        {!page&&!busy&&!error&&<button className="ff-following-load" onClick={()=>void load()}>读取微博原评论</button>}
        {page&&!page.rows.length&&<p className="ff-comments-empty">暂时没有可读取的原评论。</p>}
        {page?.rows.map(c=><article className="ff-detail-comment" key={c.id}>
            <FriendFeedAvatar name={c.authorName}/><div>{onProfile?<button className="ff-setting-link" onClick={()=>onProfile(c.authorId)}>{c.authorName}</button>:<strong>{c.authorName}</strong>}
                {c.parentId&&<small className="ff-discussion-hint"> · 楼中楼回复</small>}
                <p>{c.text}</p><time>{new Date(c.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time>
                {onReply&&<button type="button" className="ff-comment-reply" aria-label={`在本地回复${c.authorName}的微博评论`} onClick={()=>onReply(c.id)}>在本地回复</button>}
            </div></article>)}
        {page?.cursor&&page.rows.length<200&&<button className="ff-following-load" disabled={busy} onClick={()=>void load(true)}>查看更早的原评论</button>}
    </section>;
}
