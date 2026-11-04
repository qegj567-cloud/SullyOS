import {getProxyWorkerUrl, PROXY_WORKER_CHANGED_EVENT} from './proxyWorker';
import {createLocalId} from './localId.js';
import {DB} from './db';
import {mutateFriendFeed, readFriendFeed} from './friendFeed';
import {enqueueFriendNotices, syncedPostEnabled} from './friendFeedActivity';
import {isWeiboOriginalComment, type WeiboOriginalComment} from './friendFeedSourceComments';
import {isFriendFeedSource, isWeiboImageUrl, type FriendFeedSource} from './friendFeedSource';
import {friendAccounts, resolveFriendFeedSettings,type WeiboHomeMode} from './friendFeedSettings';
const KEY='sully:weibo-session:v2', LEGACY_KEY='sully:weibo-session:v1';
const CONNECTION_LIFETIME=24*60*60*1000;
export const WEIBO_CONNECTION_CHANGED='sully:weibo-connection-changed';
export interface WeiboSession {
    version:2;origin:string;kind:'qr'|'account';expires:number;uid?:string;qrid?:string;
    cookies:{name:string;value:string;domain:string;path:string;hostOnly:boolean}[];
}
// expires is the browser's retention deadline; session.expires belongs to the proxy clock.
export interface WeiboConnection {proxy:string; session:WeiboSession; uid:string; expires:number; id:string}
export interface WeiboFollowAccount {uid:string;name:string;description:string;avatar?:string}
export interface WeiboProfile {uid:string;name:string;description:string;avatar?:string}
export interface WeiboSyncResult {received:number;added:number;existing:number;hidden:number;posts?:FriendFeedSource[];nextCursor?:string|null}
export function weiboSyncMessage(result:WeiboSyncResult) {
    if(!result.received)return '微博本次返回 0 条动态，没有新增内容';
    return `已读取 ${result.received} 条微博，新增 ${result.added} 条`
        +(result.existing?`，已有 ${result.existing} 条`:'')+(result.hidden?`，${result.hidden} 条此前已删除，未恢复`:'');
}
interface WeiboResponse {session:WeiboSession; phase?:string; image?:string; uid?:string; expires?:number;
    profile?:WeiboProfile; posts?:FriendFeedSource[];nextPage?:number|null;nextCursor?:string|null;
    accounts?:WeiboFollowAccount[];filtered?:boolean; comments?:WeiboOriginalComment[]}
let epoch=0;
function validSession(s:WeiboSession):boolean {
    return !!s && s.version===2 && s.origin===window.location.origin && ['qr','account'].includes(s.kind)
        // The proxy validates its own deadline on every request. Comparing it with the
        // device clock rejects successful QR logins even with a few seconds of skew.
        && Number.isSafeInteger(s.expires) && s.expires>0
        && (s.kind==='account'?/^\d{4,25}$/.test(s.uid||''):typeof s.qrid==='string'&&/^[\w.-]{1,512}$/.test(s.qrid))
        && Array.isArray(s.cookies) && s.cookies.length<=40 && JSON.stringify(s.cookies).length<=14000
        && s.cookies.every(c=>c&&typeof c.name==='string'&&typeof c.value==='string'&&typeof c.domain==='string'&&typeof c.path==='string'&&typeof c.hostOnly==='boolean');
}
export function disconnectWeibo() {epoch++; try {sessionStorage.removeItem(KEY);sessionStorage.removeItem(LEGACY_KEY);} catch {} if(typeof window!=='undefined') window.dispatchEvent(new Event(WEIBO_CONNECTION_CHANGED));}
if(typeof window!=='undefined') {window.addEventListener(PROXY_WORKER_CHANGED_EVENT,disconnectWeibo);
    window.addEventListener('storage',e=>{if(e.key==='sully_proxy_worker_url_v1' || e.key===null) disconnectWeibo();});}
export function readWeiboConnection():WeiboConnection|undefined {
    try {sessionStorage.removeItem(LEGACY_KEY);const c=JSON.parse(sessionStorage.getItem(KEY)||'null');
        const now=Date.now();
        if(c && c.proxy===getProxyWorkerUrl() && validSession(c.session) && c.session.kind==='account' && c.uid===c.session.uid
            && Number.isSafeInteger(c.expires) && c.expires>now && c.expires<=now+CONNECTION_LIFETIME)return c;
        if(c)disconnectWeibo();
    }catch{} return undefined;
}
export function parseWeiboUid(value:string) {
    const trimmed=value.trim(); if(/^\d{4,25}$/.test(trimmed))return trimmed;
    try {const url=new URL(trimmed); if(url.protocol==='https:' && ['weibo.com','www.weibo.com'].includes(url.hostname) && !url.username && !url.password && !url.port) {
        const match=/^\/(?:u\/)?(\d{4,25})\/?$/.exec(url.pathname); if(match)return match[1];
    }}catch{} throw Error('请填写微博 UID，或 https://weibo.com/u/数字 形式的主页链接');
}
async function requestWeibo(proxy:string, payload:object, signal?:AbortSignal):Promise<WeiboResponse> {
    const controller=new AbortController();let timedOut=false;
    const abort=()=>controller.abort(signal?.reason);
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},60000);
    try{
    // Always the currently selected proxy, including development; never fall back to a public instance.
    const response=await fetch(proxy.replace(/\/+$/,'')+'/weibo',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload),signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
    if(!response.ok) {
        // Preserve the bridge's explicit reason: upstream rejection is not an expired local login.
        let reason='';try{const data=await response.json();if(typeof data?.error==='string')reason=data.error.slice(0,200);}catch{}
        if(reason)throw Error(reason);
        if(response.status===401)throw Error('微博连接已失效，请重新扫码');
        if(response.status===503)throw Error('微博连接服务暂不可用；若代理尚未启用微博，请联系代理维护者完成配置');
        if(response.status===404||response.status===405)throw Error('当前代理可能尚未支持微博连接，请联系代理维护者检查接口版本');
        throw Error(`微博读取失败（${response.status}），旧内容已保留`);}
    const result=await response.json();
    if(result?.session?.version!==2)throw Error('微博连接格式不兼容，请更新当前代理后重新扫码');
    if(!validSession(result.session))throw Error('微博返回的会话信息不完整或与当前页面不符，请重新扫码');
    return result;
    }catch(e){if(timedOut)throw Error('微博读取超时，请重试；已保存的动态仍保留');throw e;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function startWeiboLogin(signal?:AbortSignal) {
    const proxy=getProxyWorkerUrl(), generation=epoch;
    const data=await requestWeibo(proxy,{action:'start'},signal);
    if(proxy!==getProxyWorkerUrl() || generation!==epoch)throw Error('连接设置已变化，请重新扫码');
    if(!data.image || !/^https:\/\/v2\.qr\.weibo\.cn\//.test(data.image))throw Error('二维码来源不正确');
    return {...data,proxy,generation};
}
export async function pollWeiboLogin(ticket:{proxy:string;session:WeiboSession;generation:number},signal?:AbortSignal) {
    if(ticket.proxy!==getProxyWorkerUrl() || ticket.generation!==epoch)throw Error('连接设置已变化，请重新扫码');
    const data=await requestWeibo(ticket.proxy,{action:'poll',session:ticket.session},signal);
    if(ticket.proxy!==getProxyWorkerUrl() || ticket.generation!==epoch)throw Error('连接设置已变化，请重新扫码');
    if(data.phase==='connected') {
        if(data.session.kind!=='account'||data.uid!==data.session.uid||data.expires!==data.session.expires)throw Error('微博会话格式不正确');
        sessionStorage.setItem(KEY,JSON.stringify({proxy:ticket.proxy,session:data.session,uid:data.uid,expires:Date.now()+CONNECTION_LIFETIME,id:createLocalId()}));
        window.dispatchEvent(new Event(WEIBO_CONNECTION_CHANGED));
    }
    return {...ticket,...data};
}
export async function fetchWeibo(action:'profile'|'posts'|'following'|'home'|'followingAccounts'|'comments',options:{uid?:string;page?:number;cursor?:string;mid?:string}={},signal?:AbortSignal) {
    const connection=readWeiboConnection(), generation=epoch;
    if(!connection)throw Error('请先连接微博');
    const data=await requestWeibo(connection.proxy,{action,session:connection.session,...options},signal);
    if(generation!==epoch || readWeiboConnection()?.id!==connection.id)throw Error('微博连接已切换，已丢弃旧响应');
    if(data.session.kind!=='account'||data.session.uid!==connection.uid)throw Error('微博账号不匹配，请重新扫码');
    // Reads may refresh cookies, but must never renew the browser's retention window.
    sessionStorage.setItem(KEY,JSON.stringify({...connection,session:data.session}));
    return data;
}
export async function saveWeiboBinding(ownerId:string,value:string,enabled=true) {
    const uid=parseWeiboUid(value);
    await mutateFriendFeed((feed,chars)=>{
        if(ownerId!=='user' && !chars.some(c=>c.id===ownerId))throw Error('角色已不存在');
        const old=feed.weiboBindings?.find(b=>b.ownerId===ownerId);
        const same=old?.uid===uid && old.enabled===enabled;
        const binding={ownerId,uid,enabled,generation:same?old.generation:createLocalId(),since:same?old.since:Date.now(),
            initialized:same?old.initialized:false,page:same?old.page:1};
        feed.weiboBindings=[...(feed.weiboBindings||[]).filter(b=>b.ownerId!==ownerId),binding];
    });
}
export async function setWeiboStream(circleId:string,enabled:boolean) {
    await mutateFriendFeed(feed=>{if(!feed.circles.some(c=>c.id===circleId))throw Error('生活圈已不存在');
        const old=feed.weiboStreams?.find(s=>s.circleId===circleId);
        feed.weiboStreams=[...(feed.weiboStreams||[]).filter(s=>s.circleId!==circleId),old?.enabled===enabled ? old :
            {circleId,enabled,generation:createLocalId(),since:Date.now(),cursor:'0',initialized:false}];});
}
export async function saveWeiboSyncLimit(limit:number) {
    if(![25,50,100,200].includes(limit))throw Error('请选择同步上限'); await mutateFriendFeed(feed=>{feed.syncLimit=limit;});
}
const running=new Set<string>();
export async function readWeiboProfile(uid:string,signal?:AbortSignal):Promise<WeiboProfile> {
    uid=parseWeiboUid(uid);
    const {profile}=await fetchWeibo('profile',{uid},signal);
    if(!profile || profile.uid!==uid || typeof profile.name!=='string' || !profile.name.trim()
        || profile.avatar!==undefined && profile.avatar!=='' && !isWeiboImageUrl(profile.avatar))throw Error('微博个人资料不完整，未使用默认资料替代');
    return {...profile,description:typeof profile.description==='string'?profile.description:''};
}
export async function saveWeiboHomeMode(mode:WeiboHomeMode) {
    if(mode!=='default'&&mode!=='latest')throw Error('请选择微博首页模式');
    await mutateFriendFeed(feed=>{
        if(resolveFriendFeedSettings(feed.settings).weiboHomeMode===mode)return;
        feed.settings={...resolveFriendFeedSettings(feed.settings),weiboHomeMode:mode};
        // Modes use different cursors. Invalidate in-flight imports from the previous mode.
        for(const stream of feed.weiboStreams||[]){stream.cursor='0';stream.generation=createLocalId();stream.initialized=false;}
    });
}
export async function readWeiboHome(mode:WeiboHomeMode,cursor='0',signal?:AbortSignal) {
    const result=await fetchWeibo(mode==='latest'?'following':'home',{cursor},signal);
    if(!Array.isArray(result.posts)||result.posts.length>50||!result.posts.every(p=>isFriendFeedSource(p)&&p.platform==='weibo'))throw Error('微博首页内容格式不正确');
    if(result.nextCursor!==null&&!(typeof result.nextCursor==='string'&&(mode==='latest'?/^\d{1,25}$/:/^[\w,.:=-]{1,512}$/).test(result.nextCursor)))throw Error('微博首页分页格式不正确');
    return {posts:result.posts,nextCursor:result.nextCursor!};
}
/** The displayed batch keeps upstream order; enabled imports retain the normal context permissions. */
export async function readWeiboHomePage(circleId:string,mode:WeiboHomeMode,cursor='0',signal?:AbortSignal) {
    const feed=await readFriendFeed();
    if(signal?.aborted)throw signal.reason;
    if(resolveFriendFeedSettings(feed.settings).weiboHomeMode!==mode)throw Error('首页模式已变化，请重新读取');
    const stream=feed.weiboStreams?.find(s=>s.circleId===circleId);
    if(!stream)await setWeiboStream(circleId,true);
    if(signal?.aborted)throw signal.reason;
    if(stream?.enabled===false)return readWeiboHome(mode,cursor,signal);
    const result=await syncWeibo(circleId,'following',cursor!=='0',signal,{cursor,browse:true});
    return {posts:result.posts!,nextCursor:result.nextCursor!};
}
/** Entering My profile restores own posts without replacing a user-selected binding or re-enabling a disabled source. */
export async function syncWeiboOwnPosts(circleId:string,older=false,signal?:AbortSignal) {
    const connection=readWeiboConnection();if(!connection)throw Error('请先连接微博');
    await mutateFriendFeed(feed=>{
        if(signal?.aborted)throw signal.reason;
        if(readWeiboConnection()?.id!==connection.id)throw Error('微博连接已切换');
        if(!feed.weiboBindings?.some(b=>b.ownerId==='user'))feed.weiboBindings=[...(feed.weiboBindings||[]),
            {ownerId:'user',uid:connection.uid,enabled:true,generation:createLocalId(),since:Date.now(),initialized:false,page:1}];
    });
    return syncWeibo(circleId,'user',older,signal);
}
/** Browse real profiles without importing their entire history into the home feed. */
export async function readWeiboProfilePosts(uid:string,page=1,signal?:AbortSignal) {
    uid=parseWeiboUid(uid);const result=await fetchWeibo('posts',{uid,page},signal);
    if(!Array.isArray(result.posts)||result.posts.length>50||!result.posts.every(p=>isFriendFeedSource(p)&&p.platform==='weibo'&&p.accountId===uid))throw Error('微博主页内容格式不正确');
    if(result.nextPage!==null&&(!Number.isInteger(result.nextPage)||result.nextPage!<=page||result.nextPage!>200))throw Error('微博主页分页格式不正确');
    return {posts:result.posts,nextPage:result.nextPage!};
}
export async function readWeiboOriginalComments(uid:string,mid:string,cursor='0',signal?:AbortSignal) {
    const result=await fetchWeibo('comments',{uid:parseWeiboUid(uid),mid,cursor},signal);
    if(!Array.isArray(result.comments)||result.comments.length>120||!result.comments.every(isWeiboOriginalComment)
        ||!(result.nextCursor===null||typeof result.nextCursor==='string'&&/^\d{1,25}$/.test(result.nextCursor)))throw Error('微博原评论格式不正确');
    return {rows:result.comments,cursor:result.nextCursor};
}
/** Read the scanned identity without changing any RP homepage binding. */
async function syncWeiboIdentity(signal?:AbortSignal) {
    const connection=readWeiboConnection();if(!connection)throw Error('请先连接微博');
    if(signal?.aborted)throw signal.reason;
    const profile=await readWeiboProfile(connection.uid,signal);
    await mutateFriendFeed(feed=>{
        if(signal?.aborted)throw signal.reason;
        if(readWeiboConnection()?.id!==connection.id)throw Error('微博连接已切换，请重新同步');
        feed.settings={...resolveFriendFeedSettings(feed.settings),weiboProfile:{uid:profile.uid,name:profile.name,avatar:profile.avatar}};
    });
    if(signal?.aborted)throw signal.reason;
    if(readWeiboConnection()?.id!==connection.id)throw Error('微博连接已切换，请重新同步');
    return connection;
}
/** Default after login: the real home timeline from accounts the user follows. */
export async function syncWeiboHome(circleId:string,signal?:AbortSignal) {
    const connection=readWeiboConnection();if(!connection)throw Error('请先连接微博');
    let profileError:string|undefined;
    try{await syncWeiboIdentity(signal);}catch(e){if(signal?.aborted)throw e;profileError=e instanceof Error?e.message:'账号资料读取失败';}
    if(readWeiboConnection()?.id!==connection.id)throw Error('微博连接已切换，请重新同步');
    await setWeiboStream(circleId,true);
    if(signal?.aborted)throw signal.reason;
    if(readWeiboConnection()?.id!==connection.id)throw Error('微博连接已切换，请重新同步');
    return {...await syncWeibo(circleId,'following',false,signal),profileError};
}
/** Only the explicit own-profile control binds and reads the user's own posts. */
export async function syncMyWeibo(circleId:string,signal?:AbortSignal) {
    const connection=await syncWeiboIdentity(signal);
    await saveWeiboBinding('user',connection.uid);
    if(signal?.aborted)throw signal.reason;
    if(readWeiboConnection()?.id!==connection.id)throw Error('微博连接已切换，请重新同步');
    return syncWeibo(circleId,'user',false,signal);
}
const commentReads = new Map<string,Promise<void>>();
/** Read-only import; no reply jobs, activity notices, or memory cards. */
export async function syncWeiboComments(postId:string,older=false):Promise<void> {
    const pending=commentReads.get(postId); if(pending){await pending;if(older)return syncWeiboComments(postId,true);return;}
    const run=async()=>{
        const feed=await readFriendFeed(), post=feed.posts.find(p=>p.id===postId), connection=readWeiboConnection(), generation=epoch;
        if(!post || post.source?.platform!=='weibo' || !syncedPostEnabled(feed,post))throw Error('微博来源已关闭或动态已删除');
        if(older && post.weiboComments?.cursor===null)return;
        if(older && (post.weiboComments?.rows.length||0)>=200)throw Error('已显示最近 200 条原评论');
        const identity=JSON.stringify([post.authorId,post.source.accountId,post.source.externalId]);
        const bindingStamp=(s:typeof feed)=>JSON.stringify(post.synced ? post.authorId.startsWith('weibo:')
            ? s.weiboStreams?.find(b=>b.circleId===post.circleId)?.generation
            : s.weiboBindings?.find(b=>b.ownerId===post.authorId)?.generation : null);
        const stamp=bindingStamp(feed);
        const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),10000);
        let result:WeiboResponse;
        try{result=await fetchWeibo('comments',{uid:post.source.accountId,mid:post.source.externalId,cursor:older?post.weiboComments?.cursor||'0':'0'},controller.signal);}
        catch(e){if(controller.signal.aborted)throw Error('微博原评论读取超时，已保留旧内容');throw e;}
        finally{clearTimeout(timer);}
        if(!Array.isArray(result.comments) || result.comments.length>120 || !result.comments.every(isWeiboOriginalComment)
            || !(result.nextCursor===null || typeof result.nextCursor==='string' && /^\d{1,25}$/.test(result.nextCursor)))throw Error('微博评论格式不正确，已保留旧内容');
        await mutateFriendFeed(state=>{
            const current=state.posts.find(p=>p.id===postId);
            if(generation!==epoch || !connection || readWeiboConnection()?.id!==connection.id)throw Error('连接已变化，未写入旧评论');
            if(!current || !syncedPostEnabled(state,current) || bindingStamp(state)!==stamp
                || JSON.stringify([current.authorId,current.source?.accountId,current.source?.externalId])!==identity)throw Error('微博来源已变化，未写入旧评论');
            const rows=new Map((older?current.weiboComments?.rows||[]:[]).map(c=>[c.id,c]));
            for(const c of result.comments!)rows.set(c.id,c);
            current.weiboComments={rows:[...rows.values()].sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id)).slice(0,200),
                cursor:result.nextCursor!,fetchedAt:Date.now()};
        });
    };
    const promise=run();commentReads.set(postId,promise);
    try{await promise;}finally{if(commentReads.get(postId)===promise)commentReads.delete(postId);}
}
/** One upstream page per user action. Old pages never emit new-activity notifications. */
export async function syncWeibo(circleId:string,ownerId:string|'following',older=false,signal?:AbortSignal,browse?:{cursor:string;browse:true}):Promise<WeiboSyncResult> {
    if(signal?.aborted)throw signal.reason;
    const lock=`${circleId}:${ownerId}`;if(running.has(lock))throw Error('正在同步该微博，请等待本次读取完成');running.add(lock);
    try {
        const feed=await readFriendFeed(), connection=readWeiboConnection(), generation=epoch;
        if(signal?.aborted)throw signal.reason;
        const target=ownerId==='following'?feed.weiboStreams?.find(b=>b.circleId===circleId):feed.weiboBindings?.find(b=>b.ownerId===ownerId);
        if(!target?.enabled)throw Error('请先开启微博来源');
        const page='page' in target ? target.page : undefined, cursor='cursor' in target ? target.cursor : undefined;
        if(older && !browse && (ownerId==='following'?cursor===null:page===null))throw Error('没有更早的微博可读取');
        const isOwned=(p:typeof feed.posts[number])=>p.circleId===circleId && p.synced && (ownerId==='following'?p.authorId.startsWith('weibo:'):p.authorId===ownerId);
        const limit=[25,50,100,200].includes(feed.syncLimit||0)?feed.syncLimit!:50;
        if(older && !browse && feed.posts.filter(isOwned).length>=limit)throw Error('已达到同步保留上限，可在首页「微博同步」提高上限后继续');
        const result:Pick<WeiboResponse,'posts'|'nextCursor'|'nextPage'>=ownerId==='following'
            ?await readWeiboHome(resolveFriendFeedSettings(feed.settings).weiboHomeMode,browse?.cursor??(older?cursor||'0':'0'),signal)
            :await fetchWeibo('posts',{uid:'uid' in target?target.uid:undefined,page:older?page||1:1},signal);
        if(!Array.isArray(result.posts) || !result.posts.every(p=>p.platform==='weibo' && isFriendFeedSource(p)))throw Error('微博内容格式不正确');
        if(ownerId!=='following' && 'uid' in target && result.posts.some(p=>p.accountId!==target.uid))throw Error('微博返回的账号与绑定主页不符，未导入内容');
        const summary:WeiboSyncResult={received:result.posts.length,added:0,existing:0,hidden:0};
        if(browse){summary.posts=[];summary.nextCursor=result.nextCursor??null;}
        const userName=(await DB.getUserProfile())?.name||'我';
        await mutateFriendFeed((state,chars)=>{
            if(signal?.aborted)throw signal.reason;
            if(generation!==epoch || !connection || readWeiboConnection()?.id!==connection.id)throw Error('连接已变化，未写入旧响应');
            const current=ownerId==='following'?state.weiboStreams?.find(b=>b.circleId===circleId):state.weiboBindings?.find(b=>b.ownerId===ownerId);
            if(!current?.enabled || current.generation!==target.generation)throw Error('来源绑定已变化，请重新同步');
            const circle=state.circles.find(c=>c.id===circleId); if(!circle)throw Error('生活圈已不存在');
            if(ownerId!=='user' && ownerId!=='following' && !circle.memberIds.includes(ownerId))throw Error('角色已离开生活圈');
            const cap=[25,50,100,200].includes(state.syncLimit||0)?state.syncLimit!:50;
            let added=0, capped=false;
            for(const source of result.posts!) {
                if(ownerId!=='following' && 'uid' in current && source.accountId!==current.uid)continue;
                const mapped=state.weiboBindings?.find(b=>b.enabled && b.uid===source.accountId && (b.ownerId==='user'||circle.memberIds.includes(b.ownerId)));
                const authorId=ownerId==='following'?mapped?.ownerId||`weibo:${source.accountId}`:ownerId;
                const settings=resolveFriendFeedSettings(state.settings), char=chars.find(c=>c.id===authorId);
                const name=authorId==='user'?settings.userNickname||settings.weiboProfile?.name||userName:char?friendAccounts(settings,char)[0].name:source.author;
                const hidden=`${circleId}:${authorId}:${source.externalId}`;
                if(state.hiddenSources?.includes(hidden)){summary.hidden++;continue;}
                summary.posts?.push(source);
                const existingPost=state.posts.find(p=>p.circleId===circleId && p.synced && p.source?.externalId===source.externalId
                    && (p.authorId===authorId || p.authorId===`weibo:${source.accountId}`));
                if(existingPost){
                    summary.existing++;
                    // Enrich old text-only entries without moving them, notifying again or losing comments.
                    if(source.images?.length) existingPost.source={...existingPost.source!,images:source.images};
                    if(source.authorAvatar)existingPost.source={...existingPost.source!,authorAvatar:source.authorAvatar};
                    // Binding an account after reading its following stream preserves one timeline entry and its comments.
                    if(existingPost.authorId!==authorId){existingPost.authorId=authorId;existingPost.accountId='main';}
                    existingPost.authorName=name;
                    continue;
                }
                if(older && !browse && state.posts.filter(isOwned).length>=cap){capped=true;continue;}
                const post={id:createLocalId(),circleId,authorId,accountId:'main',authorName:name,text:source.text,createdAt:source.publishedAt!,source,synced:true,
                    audienceIds:circle.memberIds.filter(id=>chars.some(c=>c.id===id)),comments:[]};
                state.posts.push(post);added++;summary.added++;
                if(current.initialized && !older && source.publishedAt!>current.since)enqueueFriendNotices(state,post,true);
            }
            if((older || !current.initialized || ownerId==='following') && !capped){
                if('uid' in current) current.page=result.nextPage ?? null;else current.cursor=result.nextCursor ?? null;
            }
            if(older && !added && !capped) {if('uid' in current)current.page=null;else current.cursor=null;}
            if(!older)current.since=Math.max(current.since,...result.posts!.map(p=>p.publishedAt||0));
            current.initialized=true;
            // Keep at most the configured number of untouched imported posts per source/author.
            const owned=state.posts.filter(isOwned)
                .sort((a,b)=>b.createdAt-a.createdAt);
            const remove=new Set(owned.slice(cap).filter(p=>!p.comments.length && !state.notices?.some(n=>!n.done && n.postId===p.id)).map(p=>p.id));
            state.posts=state.posts.filter(p=>!remove.has(p.id));
        });
        return summary;
    }finally{running.delete(lock);}
}
