import React,{useEffect,useRef,useState,type MutableRefObject,type RefObject} from 'react';
import {ArrowClockwise} from '@phosphor-icons/react';
import type {UserProfile} from '../types';
import type {FriendPost} from '../utils/friendFeed';
import type {FriendFeedSource} from '../utils/friendFeedSource';
import type {FriendFeedSettings,WeiboHomeMode} from '../utils/friendFeedSettings';
import {readWeiboConnection,readWeiboHomePage,WEIBO_CONNECTION_CHANGED} from '../utils/friendFeedWeibo';
import {SocialPost} from './FriendFeedSocialUI';
import {ClassicPost} from './FriendFeedClassicUI';
import {useFriendFeedPullRefresh} from './useFriendFeedPullRefresh';

export function openWeiboOriginalProfile(uid:string) {
    if(/^\d{4,25}$/.test(uid))window.open(`https://weibo.com/u/${uid}`,'_blank','noopener,noreferrer');
}
export function WeiboPostCard({source,theme,user,onComment,index=0}:{source:FriendFeedSource;theme:FriendFeedSettings['theme'];user:UserProfile;onComment:()=>void;index?:number}) {
    const post:FriendPost={id:source.externalId,circleId:'public',authorId:`weibo:${source.accountId}`,authorName:source.author,
        text:source.text,source,synced:true,createdAt:source.publishedAt!,audienceIds:[],comments:[]};
    const props={post,user,characters:[],onProfile:()=>openWeiboOriginalProfile(source.accountId!),onComment};
    return theme==='weibo'||theme==='twitter'?<SocialPost theme={theme} {...props}/>:<ClassicPost theme={theme} index={index} {...props}/>;
}
export interface WeiboHomeBatch {mode:WeiboHomeMode;connectionId:string;circleId:string;posts:FriendFeedSource[];cursor:string|null}
export default function FriendFeedWeiboHome({circleId,mode,theme,user,cache,scroller,hiddenIds,onPost,onSettings}:{circleId:string;mode:WeiboHomeMode;theme:FriendFeedSettings['theme'];user:UserProfile;cache:MutableRefObject<WeiboHomeBatch|undefined>;scroller:RefObject<HTMLDivElement>;hiddenIds:string[];onPost:(post:FriendFeedSource)=>void;onSettings:()=>void}) {
    const saved=()=>{const value=cache.current;return value?.mode===mode&&value.circleId===circleId&&value.connectionId===readWeiboConnection()?.id?value:undefined;};
    const [batch,setBatch]=useState(saved),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('');
    const running=useRef(false),controller=useRef<AbortController>();
    const load=async(more=false)=>{
        if(running.current)return;
        const connection=readWeiboConnection();if(!connection){setError('请先连接微博');return;}
        const old=saved();if(more&&!old?.cursor)return;
        running.current=true;const abort=new AbortController();controller.current=abort;setBusy(true);setError('');setStatus('正在读取微博首页…');
        try{
            const result=await readWeiboHomePage(circleId,mode,more?old!.cursor!:'0',abort.signal);
            if(abort.signal.aborted||connection.id!==readWeiboConnection()?.id)return;
            const fresh=result.posts.some(p=>!old?.posts.some(before=>before.externalId===p.externalId));
            const posts=[...new Map([...(more?old?.posts||[]:[]),...result.posts].map(p=>[p.externalId,p])).values()].slice(0,200);
            const next={mode,connectionId:connection.id,circleId,posts,cursor:more&&(!fresh||result.nextCursor===old?.cursor)?null:result.nextCursor};
            cache.current=next;setBatch(next);
            setStatus(!result.posts.length?'微博本次返回 0 条动态':!more&&old&&!fresh?'已刷新，微博本次未返回新的内容':`已读取 ${result.posts.length} 条微博`);
            if(!more&&scroller.current)scroller.current.scrollTop=0;
        }catch(e){if(!abort.signal.aborted){setError((e instanceof Error?e.message:'微博首页读取失败')+'；可以重试，已读取内容保留');setStatus('');}}
        finally{if(controller.current===abort){running.current=false;setBusy(false);}}
    };
    useEffect(()=>{
        const current=saved();setBatch(current);if(!current)void load();
        const changed=()=>{controller.current?.abort();cache.current=undefined;setBatch(undefined);running.current=false;setBusy(false);setStatus('');setError('微博连接已变化，请重新读取');};
        window.addEventListener(WEIBO_CONNECTION_CHANGED,changed);
        return()=>{controller.current?.abort();running.current=false;window.removeEventListener(WEIBO_CONNECTION_CHANGED,changed);};
    },[circleId,mode]);
    const pull=useFriendFeedPullRefresh(scroller,!busy,()=>void load());
    return <section aria-label="微博首页" className="ff-weibo-home">
        <div className="ff-weibo-home-toolbar"><div><strong>{mode==='default'?'默认关注':'最新关注'}</strong><small>{mode==='default'?'按微博推荐顺序展示':'按发布时间展示'}</small></div>
            <button className="ff-setting-link" onClick={onSettings}>首页设置</button><button className="ff-setting-link" disabled={busy} onClick={()=>void load()}><ArrowClockwise size={18}/>刷新微博首页</button></div>
        {(pull>0||status)&&<p className="ff-setting-status" role="status">{pull?(pull>=42?'松开刷新':'下拉刷新'):status}</p>}
        {error&&<p className="friend-feed-error" role="alert">{error}</p>}
        <div className="friend-feed-posts">{batch?.posts.filter(source=>!hiddenIds.includes(source.externalId)).map((source,index)=><WeiboPostCard key={source.externalId} source={source} index={index} theme={theme} user={user} onComment={()=>onPost(source)}/>)}</div>
        {!!batch?.cursor&&batch.posts.length<200&&<button className="friend-feed-more" disabled={busy} onClick={()=>void load(true)}>继续看微博</button>}
        {!readWeiboConnection()&&<button className="ff-setting-button" onClick={onSettings}>连接微博</button>}
    </section>;
}
