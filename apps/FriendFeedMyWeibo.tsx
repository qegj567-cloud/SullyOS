import React,{useEffect,useRef,useState,type RefObject} from 'react';
import type {FriendFeedState} from '../utils/friendFeed';
import {readWeiboConnection,syncWeiboOwnPosts,weiboSyncMessage,WEIBO_CONNECTION_CHANGED} from '../utils/friendFeedWeibo';
import {useFriendFeedPullRefresh} from './useFriendFeedPullRefresh';

export default function FriendFeedMyWeibo({feed,circleId,scroller,onSettings}:{feed:FriendFeedState;circleId:string;scroller:RefObject<HTMLDivElement>;onSettings:()=>void}) {
    const binding=feed.weiboBindings?.find(b=>b.ownerId==='user');
    const [connection,setConnection]=useState(readWeiboConnection),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('');
    const controller=useRef<AbortController>(),running=useRef(false);
    const load=async(older=false)=>{
        if(running.current||!connection||binding?.enabled===false)return;
        running.current=true;const abort=new AbortController();controller.current=abort;setBusy(true);setError('');setStatus('正在读取我的微博…');
        try{const result=await syncWeiboOwnPosts(circleId,older,abort.signal);if(!abort.signal.aborted)setStatus(weiboSyncMessage(result));}
        catch(e){if(!abort.signal.aborted){setError(e instanceof Error?e.message:'我的微博读取失败');setStatus('');}}
        finally{if(controller.current===abort){running.current=false;setBusy(false);}}
    };
    useEffect(()=>{void load();return()=>{controller.current?.abort();running.current=false;};},[circleId,connection?.id]);
    useEffect(()=>{const changed=()=>{controller.current?.abort();running.current=false;setBusy(false);setStatus('');setError('');setConnection(readWeiboConnection());};window.addEventListener(WEIBO_CONNECTION_CHANGED,changed);return()=>window.removeEventListener(WEIBO_CONNECTION_CHANGED,changed);},[]);
    const pull=useFriendFeedPullRefresh(scroller,!busy&&!!connection&&binding?.enabled!==false,()=>void load());
    return <section className="ff-my-weibo" aria-label="我的微博同步">
        <div className="ff-setting-actions">{connection&&binding?.enabled!==false?<><button className="ff-setting-link" disabled={busy} onClick={()=>void load()}>刷新我的微博</button>
            {binding?.page!==null&&<button className="ff-setting-link" disabled={busy||!binding?.initialized} onClick={()=>void load(true)}>加载我更早的微博</button>}</>:<button className="ff-setting-link" onClick={onSettings}>{connection?'开启我的微博来源':'连接微博，读取我的微博'}</button>}</div>
        {(pull>0||status)&&<p className="ff-setting-status" role="status">{pull?(pull>=42?'松开刷新我的微博':'下拉刷新我的微博'):status}</p>}{error&&<p role="alert">{error}；可点「刷新我的微博」重试。</p>}
    </section>;
}
