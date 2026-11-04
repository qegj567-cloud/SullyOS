import React,{useEffect,useRef,useState} from 'react';
import {readWeiboOriginalComments,readWeiboConnection,WEIBO_CONNECTION_CHANGED} from '../utils/friendFeedWeibo';
import type {FriendFeedSource} from '../utils/friendFeedSource';
import type {WeiboOriginalComment} from '../utils/friendFeedSourceComments';
import type {FriendFeedSettings} from '../utils/friendFeedSettings';
import type {UserProfile} from '../types';
import FriendFeedAvatar from './FriendFeedAvatar';
import {WeiboPostCard,openWeiboOriginalProfile} from './FriendFeedWeiboHome';

/** Unsaved home-feed posts can still read original comments; author profiles open on Weibo. */
export default function FriendFeedWeiboBrowser({post,theme,user,onConnect}:{post:FriendFeedSource;theme:FriendFeedSettings['theme'];user:UserProfile;onConnect:()=>void}) {
    const [comments,setComments]=useState<WeiboOriginalComment[]>([]),[cursor,setCursor]=useState<string|null>('0');
    const [busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
    const controller=useRef<AbortController>(),running=useRef(false),commentSection=useRef<HTMLElement>(null);
    const load=async(more=false)=>{
        if(running.current)return;
        running.current=true;const abort=new AbortController();controller.current=abort;setBusy(true);setError('');
        try{
            const result=await readWeiboOriginalComments(post.accountId!,post.externalId,more?cursor||'0':'0',abort.signal);
            if(abort.signal.aborted)return;
            setComments(current=>[...new Map([...(more?current:[]),...result.rows].map(c=>[c.id,c])).values()].slice(0,200));
            setCursor(result.cursor===cursor&&more?null:result.cursor);setLoaded(true);
        }catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'微博原评论读取失败');}
        finally{if(!abort.signal.aborted){running.current=false;setBusy(false);}}
    };
    useEffect(()=>{
        void load();
        const changed=()=>{controller.current?.abort();running.current=false;setBusy(false);setComments([]);setLoaded(false);setCursor('0');setError('微博连接已变化，请重新读取');};
        window.addEventListener(WEIBO_CONNECTION_CHANGED,changed);
        return()=>{controller.current?.abort();running.current=false;window.removeEventListener(WEIBO_CONNECTION_CHANGED,changed);};
    },[post.externalId]);
    return <div className="ff-post-detail" aria-label="真实微博详情">
        <WeiboPostCard source={post} theme={theme} user={user} onComment={()=>commentSection.current?.scrollIntoView?.({block:'start'})}/>
        <section ref={commentSection} className="ff-detail-discussion ff-original-comments" aria-label="微博原评论"><h2>微博原评论 <small>{comments.length}</small></h2>
            {comments.map(c=><article key={c.id} className="ff-detail-comment"><FriendFeedAvatar name={c.authorName}/><div><button className="ff-setting-link" onClick={()=>openWeiboOriginalProfile(c.authorId)}>{c.authorName}</button>
                {c.parentId&&<small> · 楼中楼回复</small>}<p>{c.text}</p><time>{new Date(c.createdAt).toLocaleString('zh-CN')}</time></div></article>)}
        </section>
        {busy&&<p role="status">正在读取微博原评论…</p>}{error&&<p role="alert">{error}</p>}
        {loaded&&!comments.length&&<p>微博本次返回 0 条可见评论。</p>}
        <div className="ff-setting-actions"><button className="ff-setting-button ff-setting-secondary" disabled={busy} onClick={()=>void load()}>{error?'重试读取':'刷新微博原评论'}</button>
            {loaded&&cursor&&comments.length<200&&<button className="ff-setting-link" disabled={busy} onClick={()=>void load(true)}>查看更早的原评论</button>}
            {!readWeiboConnection()&&<button className="ff-setting-link" onClick={onConnect}>连接微博</button>}</div>
    </div>;
}
