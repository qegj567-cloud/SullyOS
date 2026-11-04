import React,{useEffect,useId,useRef,useState} from 'react';
import {ArrowRight,CaretDown,CheckCircle,QrCode,LinkSimple,ArrowClockwise} from '@phosphor-icons/react';
import {getProxyWorkerUrl,PROXY_WORKER_CHANGED_EVENT} from '../utils/proxyWorker';
import {disconnectWeibo,readWeiboConnection,startWeiboLogin,pollWeiboLogin,WEIBO_CONNECTION_CHANGED,
    saveWeiboBinding,setWeiboStream,syncWeibo,syncWeiboHome,syncWeiboOwnPosts,weiboSyncMessage,saveWeiboHomeMode,saveWeiboSyncLimit,type WeiboSyncResult} from '../utils/friendFeedWeibo';
import {resolveFriendFeedSettings} from '../utils/friendFeedSettings';
import {saveFriendFollows,type FriendFeedState} from '../utils/friendFeed';
import {followedAuthors} from '../utils/friendFeedActivity';
import type {CharacterGroup,CharacterProfile} from '../types';
import {FriendFeedGroupedList} from './FriendFeedGroupedList';

export function FriendFeedWeiboConnection({circleId,onTimeline}:{circleId?:string;onTimeline?:()=>void}={}) {
    const [connection,setConnection]=useState(readWeiboConnection),[proxy,setProxy]=useState(getProxyWorkerUrl);
    const [accepted,setAccepted]=useState(false),[image,setImage]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
    const controller=useRef<AbortController>(), timer=useRef<ReturnType<typeof setTimeout>>();
    useEffect(()=>{
        const clear=()=>{controller.current?.abort();clearTimeout(timer.current);setImage('');setBusy(false);};
        const changed=()=>{clear();setProxy(getProxyWorkerUrl());setConnection(readWeiboConnection());setAccepted(false);};
        const connected=()=>setConnection(readWeiboConnection());
        window.addEventListener(PROXY_WORKER_CHANGED_EVENT,changed);window.addEventListener(WEIBO_CONNECTION_CHANGED,connected);
        return ()=>{controller.current?.abort();clearTimeout(timer.current);window.removeEventListener(PROXY_WORKER_CHANGED_EVENT,changed);window.removeEventListener(WEIBO_CONNECTION_CHANGED,connected);};
    },[]);
    const readMine=async(abort:AbortController)=>{
        if(!circleId){setStatus('已登录，请先选择生活圈再同步');setBusy(false);return;}
        setBusy(true);setStatus('正在读取账号资料、我的微博和关注动态…');
        try{const results=await Promise.allSettled([syncWeiboHome(circleId,abort.signal),syncWeiboOwnPosts(circleId,false,abort.signal)]);
            if(!abort.signal.aborted)setStatus(results.map((result,index)=>result.status==='rejected'
                ?`${index?'我的微博':'首页关注'}：${result.reason instanceof Error?result.reason.message:'读取失败'}`
                :(index?'我的微博：':('profileError' in result.value&&result.value.profileError?'账号资料读取失败：'+result.value.profileError+'；':'账号资料已更新；')+'首页关注：')+weiboSyncMessage(result.value)).join('；'));}
        catch(e){if(!abort.signal.aborted)setStatus(e instanceof Error?e.message:'微博读取失败，请重试');}
        finally{if(!abort.signal.aborted)setBusy(false);}
    };
    const connect=async()=>{
        controller.current?.abort();clearTimeout(timer.current);const abort=new AbortController();controller.current=abort;
        setBusy(true);setStatus('正在准备二维码…');
        try {
            let ticket=await startWeiboLogin(abort.signal);if(abort.signal.aborted)return;setImage(ticket.image!);setStatus('用微博 App 扫码，并在手机上确认');
            const poll=async()=>{try{const next=await pollWeiboLogin(ticket,abort.signal);if(abort.signal.aborted)return;ticket={...ticket,...next};
                if(next.phase==='connected'){setImage('');setConnection(readWeiboConnection());await readMine(abort);return;}
                setStatus(next.phase==='scanned'?'已扫码，请在微博 App 确认':'等待扫码');timer.current=setTimeout(poll,2500);
            }catch(e){if(!abort.signal.aborted){setStatus(e instanceof Error?e.message:'连接失败');setBusy(false);setImage('');}}};
            timer.current=setTimeout(poll,2500);
        }catch(e){if(!abort.signal.aborted){setStatus(e instanceof Error?e.message:'连接失败');setBusy(false);}}
    };
    return <section className="friend-feed-weibo-connection">
        <header className="ff-settings-intro"><span className="ff-settings-kicker">账号与来源</span><h2>连接微博</h2><p>扫码后，同步我的微博和首页关注动态。</p></header>
        <div className="ff-connection-route"><LinkSimple size={20} aria-hidden="true"/><div><span>当前连接服务</span><code className="friend-feed-proxy">{proxy}</code><small>跟随系统「网络代理」设置</small></div><span className="ff-connection-state" data-connected={!!connection}>{connection?'已连接':'未连接'}</span></div>
        <details className="friend-feed-privacy ff-disclosure"><summary><span>这会涉及哪些隐私？</span><CaretDown size={16} aria-hidden="true"/></summary>
            <p>扫码会产生微博登录凭据，相当于登录状态，属于敏感信息。当前代理会处理这份凭据，以及读取到的主页、关注动态、原评论和你主动读取的关注名单；代理运营者在技术上能够接触这些数据。</p>
            <p>登录凭据只保存在本机当前浏览器会话，读取时通过 HTTPS 发送给上述代理转发。公共代理不保存账号或凭据，不需要每位用户配置服务器；同步内容保存在本机。本项目没有查看账号的管理后台，部署者仍需避免记录敏感请求日志。</p>
            <p>功能只读取，不替你在微博发帖、评论、点赞或关注。你可在网络代理设置中使用自己的 Worker。只有允许角色阅读后，选中的内容才会发送给你配置的 AI 服务；登录凭据不会发送。</p>
            <p>断开会清除本机连接；若需撤销微博端登录，请在微博的账号安全设置中管理登录设备。</p>
            <p>配图优先直连微博图片服务器；加载失败时由当前代理转发图片地址，不携带微博登录凭据。图片仅用于展示，不自动发送给 AI。</p>
        </details>
        <div className="ff-scan-stage" aria-live="polite">
            {image?<img className="friend-feed-qr" src={image} alt="微博登录二维码" referrerPolicy="no-referrer"/>:connection?<CheckCircle size={52} weight="light" aria-hidden="true"/>:<QrCode size={68} weight="light" aria-hidden="true"/>}
            <strong>{connection?'微博已连接':image?'用微博 App 扫一扫':busy?'正在准备二维码':'扫码连接你的账号'}</strong>
            <p>{connection?`UID ${connection.uid}`:image?'请在手机上确认登录':'确认登录后，读取昵称、头像、我的微博和首页关注动态。'}</p>
        </div>
        {connection?<>
            <button type="button" className="ff-setting-button ff-setting-primary ff-full-width" disabled={busy||!circleId} onClick={()=>{controller.current?.abort();const abort=new AbortController();controller.current=abort;void readMine(abort);}}>{busy?'正在读取微博…':'同步微博首页'}</button>
            {onTimeline&&<button type="button" className="ff-setting-link ff-full-width" onClick={onTimeline}>查看动态<ArrowRight size={17} aria-hidden="true"/></button>}
            <button type="button" className="ff-setting-button ff-setting-secondary ff-full-width" onClick={()=>{controller.current?.abort();clearTimeout(timer.current);setBusy(false);disconnectWeibo();setStatus('已断开，已同步内容保留');}}>断开连接</button>
        </>:<>
            <label className="friend-feed-cover-option ff-consent"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)} disabled={busy}/>
                <span>我了解登录凭据和读取内容会经过上述代理，愿意连接</span></label>
            {!busy&&<button type="button" className="ff-setting-button ff-setting-primary ff-full-width" disabled={!accepted} onClick={()=>void connect()}>扫码连接微博<ArrowRight size={17} aria-hidden="true"/></button>}
            {busy&&<button type="button" className="ff-setting-button ff-setting-secondary ff-full-width" onClick={()=>{controller.current?.abort();clearTimeout(timer.current);setBusy(false);setImage('');setStatus('已取消扫码');}}>取消扫码</button>}
        </>}
        {status&&<p className="ff-setting-status" role="status">{status}</p>}
    </section>;
}

export function FriendFeedProfileControls({feed,ownerId,circleId,characters,groups=[],onConnect}:{feed:FriendFeedState;ownerId:string;circleId:string;characters:CharacterProfile[];groups?:CharacterGroup[];onConnect:()=>void}) {
    const binding=feed.weiboBindings?.find(b=>b.ownerId===ownerId);
    const [uid,setUid]=useState(binding?.uid||''),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
    useEffect(()=>{setUid(binding?.uid||'');setStatus('');},[ownerId,binding?.uid]);
    const run=async(action:()=>Promise<void|WeiboSyncResult>)=>{if(busy)return;setBusy(true);setStatus('');try{const result=await action();setStatus(result?weiboSyncMessage(result):'设置已保存');}catch(e){setStatus(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}};
    const authors=[{id:'user',name:'我',groupId:'__bibi_user__'},...characters.filter(c=>feed.circles.find(c=>c.id===circleId)?.memberIds.includes(c.id)).map(c=>({id:c.id,name:c.name,groupId:c.groupId})),
        ...feed.posts.filter(p=>p.circleId===circleId&&p.authorId.startsWith('weibo:')).map(p=>({id:p.authorId,name:p.authorName,groupId:'__bibi_weibo__'}))]
        .filter((a,i,all)=>a.id!==ownerId&&all.findIndex(b=>b.id===a.id)===i);
    return <details open className="friend-feed-profile-controls ff-disclosure"><summary><span>主页设置 · 微博与关注</span><small>{binding?.enabled?'已绑定':'未绑定'}</small><CaretDown size={16} aria-hidden="true"/></summary>
        <div className="ff-disclosure-body"><div className="ff-settings-section">
        <label className="ff-setting-field">绑定微博主页<input value={uid} onChange={e=>setUid(e.target.value)} placeholder="微博 UID 或 /u/数字 主页链接" disabled={busy}/></label>
        <p>{ownerId==='user'?'同步到我的动态，按发布时间混排。':'绑定内容视为这个 RP 角色自己发过的动态；不会登录或操作被绑定的账号。'}</p>
        {ownerId==='user'&&<button className="ff-setting-link" type="button" disabled={busy} onClick={()=>{const c=readWeiboConnection();if(c)setUid(c.uid);else onConnect();}}>使用登录账号<ArrowRight size={14} aria-hidden="true"/></button>}
        <div className="ff-setting-actions"><button className="ff-setting-button ff-setting-primary" type="button" disabled={busy||!uid.trim()} onClick={()=>void run(()=>saveWeiboBinding(ownerId,uid))}>保存绑定并开启</button>
            {binding?.enabled&&<button className="ff-setting-link" type="button" disabled={busy} onClick={()=>void run(()=>saveWeiboBinding(ownerId,binding.uid,false))}>关闭这个来源</button>}
        </div>
        {binding?.enabled&&<div className="ff-setting-actions"><button className="ff-setting-button ff-setting-secondary" type="button" disabled={busy} onClick={()=>void run(()=>ownerId==='user'?syncWeiboOwnPosts(circleId):syncWeibo(circleId,ownerId))}><ArrowClockwise size={16} aria-hidden="true"/>同步最新微博</button>
            <button className="ff-setting-link" type="button" disabled={busy||binding.page===null} onClick={()=>void run(()=>syncWeibo(circleId,ownerId,true))}>加载更早微博</button></div>}
        </div>
        <button className="ff-settings-navigation" type="button" onClick={onConnect}><LinkSimple size={18} aria-hidden="true"/><span>管理微博连接<small>扫码、连接状态与隐私</small></span><ArrowRight size={17} aria-hidden="true"/></button>
        {ownerId!=='user'&&<fieldset className="ff-follow-options" disabled={busy}><legend>TA 关注谁</legend><p>只订阅哔哔的新动态，不会修改微博关注列表。</p>
            <FriendFeedGroupedList items={authors.map(a=>({...a,searchText:a.name}))} groups={[{id:'__bibi_user__',name:'我',order:-1},...groups,{id:'__bibi_weibo__',name:'微博账号',order:Number.MAX_SAFE_INTEGER}]} label="主页关注" disabled={busy} renderItem={a=><label className="ff-toggle-row" key={a.id}>
            <span>{a.name}</span><input type="checkbox" checked={followedAuthors(feed,ownerId).includes(a.id)} onChange={e=>void run(()=>saveFriendFollows(ownerId,e.target.checked?[...followedAuthors(feed,ownerId),a.id]:followedAuthors(feed,ownerId).filter(id=>id!==a.id)))}/></label>}/></fieldset>}
        {status&&<p className="ff-setting-status" role="status">{status}</p>}</div>
    </details>;
}

export function FriendFeedWeiboTimeline({feed,circleId,onConnect,showConnectionLink=true}:{feed:FriendFeedState;circleId:string;onConnect:()=>void;showConnectionLink?:boolean}) {
    const syncGroup=useId();
    const stream=feed.weiboStreams?.find(s=>s.circleId===circleId);
    const [busy,setBusy]=useState(false),[status,setStatus]=useState('');
    const run=async(action:()=>Promise<void|WeiboSyncResult>)=>{if(busy)return;setBusy(true);setStatus('');try{const result=await action();setStatus(result?weiboSyncMessage(result):'设置已保存');}catch(e){setStatus(e instanceof Error?e.message:'同步失败');}finally{setBusy(false);}};
    return <details open className="friend-feed-profile-controls ff-disclosure"><summary><span>微博同步</span><small>{feed.syncLimit||50} 条</small><CaretDown size={16} aria-hidden="true"/></summary>
        <div className="ff-disclosure-body">
        <label className="ff-setting-field">微博首页模式<select aria-label="微博首页模式" value={resolveFriendFeedSettings(feed.settings).weiboHomeMode} disabled={busy} onChange={e=>void run(()=>saveWeiboHomeMode(e.target.value==='latest'?'latest':'default'))}>
            <option value="default">默认关注 · 刷新换一批</option><option value="latest">最新关注 · 按时间排序</option></select></label>
        <p>默认关注保留微博推荐顺序，刷新重新读取一批；最新关注读取按时间排列的关注动态。独立「微博首页」保留所选顺序，混合动态仍按发布时间展示。</p>
        <p>模式只影响微博读取与展示，不改变角色阅读授权。第一次同步和翻历史不会通知角色。</p>
        {showConnectionLink&&<button className="ff-settings-navigation" type="button" onClick={onConnect}><LinkSimple size={18} aria-hidden="true"/><span>管理微博连接<small>使用系统设置中的网络代理</small></span><ArrowRight size={17} aria-hidden="true"/></button>}
        <fieldset className="ff-sync-limit" disabled={busy}><legend>同步保留上限</legend><div>{[25,50,100,200].map(n=><label key={n}><input type="radio" name={syncGroup} checked={(feed.syncLimit||50)===n} onChange={()=>void run(()=>saveWeiboSyncLimit(n))}/><span>{n}<small> 条</small></span></label>)}</div></fieldset>
        <label className="ff-toggle-row"><span>加入微博关注流<small>同步我登录账号关注的人</small></span><input aria-label="加入我登录账号的微博关注流" type="checkbox" checked={!!stream?.enabled} disabled={busy} onChange={e=>void run(()=>setWeiboStream(circleId,e.target.checked))}/></label>
        <div className="ff-setting-actions"><button className="ff-setting-button ff-setting-primary" type="button" disabled={busy} onClick={()=>void run(async()=>{
            const bindings=(feed.weiboBindings||[]).filter(binding=>binding.enabled&&(binding.ownerId==='user'||feed.circles.find(c=>c.id===circleId)?.memberIds.includes(binding.ownerId)));
            if(!bindings.length&&!stream?.enabled)throw Error('尚未开启微博来源，请在「管理微博连接」同步微博首页，或绑定一个主页');
            const total:WeiboSyncResult={received:0,added:0,existing:0,hidden:0};
            const failures:string[]=[];
            for(const ownerId of [...bindings.map(b=>b.ownerId),...(stream?.enabled?['following']:[])]){
                try{const result=await syncWeibo(circleId,ownerId);
                    for(const key of ['received','added','existing','hidden'] as const)total[key]+=result[key];}
                catch(e){failures.push(`${ownerId==='user'?'我的微博':ownerId==='following'?'关注首页':'绑定主页'}：${e instanceof Error?e.message:'读取失败'}`);}
            }
            if(failures.length)throw Error(weiboSyncMessage(total)+'；'+failures.join('；'));
            return total;
        })}><ArrowClockwise size={16} aria-hidden="true"/>同步最新动态</button>{stream?.enabled&&<button className="ff-setting-link" type="button" disabled={busy||stream.cursor===null} onClick={()=>void run(()=>syncWeibo(circleId,'following',true))}>加载更早关注动态</button>}</div>
        {status&&<p className="ff-setting-status" role="status">{status}</p>}</div>
    </details>;
}
