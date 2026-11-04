import {friendPostImages,friendPostMediaCount} from '../utils/friendFeedImages';
import React, {useEffect,useRef,useState} from 'react';
import {ArrowClockwise, PencilSimple,ShareNetwork} from '@phosphor-icons/react';
import type {CharacterProfile, UserProfile} from '../types';
import type {FriendPost,FriendComment,FriendReplyTarget} from '../utils/friendFeed';
import {friendCommentThreads} from '../utils/friendFeedThreads';
import FriendFeedAvatar from './FriendFeedAvatar';
import FriendFeedImages from './FriendFeedImages';
import FriendFeedWeiboComments from './FriendFeedWeiboComments';
import {sourceLabel} from '../utils/friendFeedSource';

export default function FriendFeedPostDetail({post,characters,user,onComment,onProfile,onRefresh,busy,status,replying,onShare,onReply,focusComment,onReadVisible,onEdit,onDelete}: {
    onEdit?:(comment:FriendComment)=>void;onDelete?:(comment:FriendComment)=>void;
    post?:FriendPost;characters:CharacterProfile[];user:UserProfile;onComment:()=>void;onProfile:(id:string,accountId?:string)=>void;onRefresh:()=>void;busy:boolean;status:string;replying:boolean;onShare?:()=>void;onReply?:(target:FriendReplyTarget)=>void;focusComment?:{id:string};onReadVisible?:(ids:string[])=>void;
}) {
    const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
    const container=useRef<HTMLDivElement>(null),located=useRef<typeof focusComment>();
    const threads=friendCommentThreads(post?.comments||[]);
    useEffect(()=>{
        if(!focusComment||located.current===focusComment)return;
        const thread=threads.find(t=>t.replies.some(c=>c.id===focusComment.id));
        if(thread)setExpanded(current=>current.has(thread.root.id)?current:new Set([...current,thread.root.id]));
    },[focusComment,post?.comments]);
    useEffect(()=>{
        if(!focusComment||located.current===focusComment)return;
        const target=Array.from(container.current?.querySelectorAll<HTMLElement>('[data-comment-id]')||[]).find(el=>el.dataset.commentId===focusComment.id);
        if(!target)return;
        const frame=requestAnimationFrame(()=>{
            target.scrollIntoView?.({block:'center',behavior:'auto'});target.focus({preventScroll:true});located.current=focusComment;
        });
        return()=>cancelAnimationFrame(frame);
    },[focusComment,expanded,post?.comments]);
    useEffect(()=>{
        const read=()=>{if(document.visibilityState==='hidden')return;
            onReadVisible?.(threads.flatMap(t=>[t.root,...(expanded.has(t.root.id)?t.replies:t.replies.slice(0,3))]).map(c=>c.id));
        };
        read();document.addEventListener('visibilitychange',read);return()=>document.removeEventListener('visibilitychange',read);
    },[post?.comments,expanded,onReadVisible]);
    if(!post)return <p className="friend-feed-empty">这条动态已删除或已隐藏。</p>;
    const author=characters.find(c=>c.id===post.authorId);
    const name=post.accountId&&post.accountId!=='main'?post.authorName:post.authorId==='user'?user.name||'我':author?.name||post.authorName;
    const renderComment=(c:FriendComment,nested=false)=><article className="ff-detail-comment" key={c.id} data-comment-id={c.id} tabIndex={-1} data-highlighted={focusComment?.id===c.id||undefined}>
        <FriendFeedAvatar name={c.authorName} avatar={c.accountId&&c.accountId!=='main'?undefined:c.authorId==='user'?user.avatar:characters.find(char=>char.id===c.authorId)?.avatar}/>
        <div><button type="button" className="ff-setting-link" onClick={()=>onProfile(c.authorId,c.accountId)}>{c.authorName}</button>{c.localReply&&(nested?<small className="ff-comment-to"> 回复 @{c.localReply.authorName}</small>:<blockquote className="ff-source-reply"><small>回复 {c.localReply.authorName}</small><p>{c.localReply.text}</p></blockquote>)}
            {c.sourceReply&&<blockquote className="ff-source-reply"><small>回复微博原评论 · {c.sourceReply.authorName}</small><p>{c.sourceReply.text}</p></blockquote>}<p>{c.text}</p>
            <footer><span className="ff-comment-meta"><time>{new Date(c.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time>
                {c.editedAt&&<small>已编辑</small>}</span><span className="ff-comment-actions">
                {onReply&&<button type="button" className="ff-comment-reply" aria-label={`回复${c.authorName}的评论`} onClick={()=>onReply({kind:'local',id:c.id})}>回复</button>}
                {onEdit&&<button type="button" className="ff-comment-reply" aria-label={`编辑${c.authorName}的评论`} onClick={()=>onEdit(c)}>编辑</button>}
                {onDelete&&<button type="button" className="ff-comment-reply" aria-label={`删除${c.authorName}的评论`} onClick={()=>onDelete(c)}>删除</button>}</span></footer>
        </div>
    </article>;
    return <div className="ff-post-detail" ref={container}>
        <article className="ff-detail-original"><header><button onClick={()=>onProfile(post.authorId,post.accountId)} aria-label={`查看${name}的主页`}>
            <FriendFeedAvatar name={name} avatar={post.accountId&&post.accountId!=='main'?undefined:post.authorId==='user'?user.avatar:author?.avatar||(post.authorId.startsWith('weibo:')||post.authorKind==='external'?post.source?.authorAvatar:undefined)}/><strong>{name}</strong></button>
            <time>{new Date(post.createdAt).toLocaleString('zh-CN')}</time></header>
            {!!post.accountTags?.length&&<small className="ff-account-tags">{post.accountTags.map(t=>'#'+t).join(' · ')}</small>}
            <p>{post.text}</p>
            {post.source&&!post.synced&&post.source.text!==post.text&&<blockquote><strong>{post.source.author}</strong><p>{post.source.text}</p></blockquote>}
            {!!friendPostMediaCount(post)&&<FriendFeedImages images={friendPostImages(post)} imageCards={post.imageCards}/>}
            {post.source&&<a href={post.source.url} target="_blank" rel="noopener noreferrer">来自真实{sourceLabel(post.source)} · 查看原帖 ↗</a>}
            {onShare&&<button className="ff-share-post" onClick={onShare}><ShareNetwork size={17}/>分享给角色</button>}
        </article>
        <section className="ff-detail-discussion" aria-label="动态评论区"><header><h2>{post.source?'本地讨论':'评论'} <small>{post.comments.length}</small></h2>
            <button aria-label="刷新评论区" title="抽一位角色回应，使用一次 API；也可在顶部下拉刷新" disabled={busy} onClick={onRefresh}><ArrowClockwise size={19} className={busy?'friend-feed-spinner':''}/></button></header>
            {post.source&&<p className="ff-discussion-hint">哔哔内的讨论，不会发布到原平台。</p>}
            {status&&<p role="status" className="ff-discussion-hint">{status}</p>}
            {replying&&<p role="status">朋友们正在接话…</p>}
            {!post.comments.length&&<p className="ff-comments-empty">还没有评论，留句话吧。</p>}
            {threads.map(({root,replies})=><div className="ff-comment-thread" key={root.id}>
                {renderComment(root)}{!!replies.length&&<div className="ff-thread-replies" aria-label={`${root.authorName}的评论下的回复`}>
                    {(expanded.has(root.id)?replies:replies.slice(0,3)).map(c=>renderComment(c,true))}
                    {replies.length>3&&<button type="button" className="ff-thread-toggle" aria-expanded={expanded.has(root.id)} onClick={()=>setExpanded(current=>{
                        const next=new Set(current);if(next.has(root.id))next.delete(root.id);else next.add(root.id);return next;
                    })}>{expanded.has(root.id)?'收起回复':`查看全部 ${replies.length} 条回复`}</button>}
                </div>}
            </div>)}
        </section>
        <button className="ff-detail-compose" onClick={onComment}><PencilSimple size={18}/>写评论…</button>
        {post.source?.platform==='weibo'&&<FriendFeedWeiboComments key={post.id} post={post} onProfile={uid=>onProfile('weibo:'+uid)} onReply={onReply?id=>onReply({kind:'source',id}):undefined}/>}
    </div>;
}
