// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import FriendFeedApp from '../apps/FriendFeedApp';
import HomePhone from '../apps/room3d/HomePhone';
import FriendFeedNotification from '../components/os/FriendFeedNotification';
import {enqueueFriendUserNotice,friendUserInbox,requestFriendInbox} from './friendFeedInbox';
import {DB} from './db';
import {FRIEND_FEED_KEY, importFriendSource, emptyFriendFeed, publishFriendPost, saveFriendCircle, readFriendFeed} from './friendFeed';
import {handleLocalBack} from './localBackHandlers';
import {INSTALLED_APPS} from '../constants';
import {AppID} from '../types';
import {runImmediateFriendReplies} from './friendFeedReplies';
import {saveFriendFeedSettings} from './friendFeed';
import {friendAccountRef,knowsFriendAccount} from './friendFeedGraph';
import {defaultFriendFeedSettings} from './friendFeedSettings';
import {saveTikHubKey, readTikHubKey} from './tikhub';
import {mutateFriendFeed} from './friendFeed';
import {saveWeiboBinding} from './friendFeedWeibo';
import {FriendFeedWeiboTimeline,FriendFeedWeiboConnection} from '../apps/FriendFeedWeibo';
import FriendFeedImages from '../apps/FriendFeedImages';
import FriendFeedWeiboBrowser from '../apps/FriendFeedWeiboBrowser';
import {setProxyWorkerUrl} from './proxyWorker';
import {refreshFriendFeed,refreshFriendWeibo} from './friendFeedRefresh';
import * as imageFiles from './file';
import {FRIEND_FEED_API_KEY, readFriendFeedApi} from './friendFeedApi';

const m = vi.hoisted(() => ({close: vi.fn(), open:vi.fn(), chars: [
    {id: 'feed-ui-b', name: '小白', avatar: '', description: '', systemPrompt: '', memories: []},
    {id: 'feed-ui-c', name: '小绿', avatar: '', description: '', systemPrompt: '', memories: []},
]}));
vi.mock('../context/OSContext', () => ({useOS: () => ({characters: m.chars, userProfile: {name: '小雨'}, closeApp: m.close, openApp:m.open,
    apiPresets:[{id:'bibi-test',name:'哔哔测试预设',config:{baseUrl:'https://bibi.invalid/v1',apiKey:'test-only',model:'test-bibi'}}]})}));
vi.mock('../utils/homeAnalytics', () => ({trackHomeFeature: vi.fn()}));
vi.mock('./friendFeedReplies', () => ({runImmediateFriendReplies: vi.fn()}));
vi.mock('./friendFeedRefresh', () => ({refreshFriendFeed: vi.fn(async()=>({message:'刷新完成',warnings:[]})),refreshFriendWeibo:vi.fn(async()=>({message:'已读取 1 条微博',warnings:[],attempted:1,completed:1}))}));
vi.mock('../apps/Chat', () => ({default: () => React.createElement('div', null, '原有信息页面')}));
vi.mock('../apps/room3d/HomePhotoMode', () => ({default: () => React.createElement('div', null, '原有相机页面')}));
const editor = {setPhoneReply: vi.fn(), getHomeScene: () => ({present: true, roomName: '客厅'})};
let hosts: HTMLElement[], roots: ReturnType<typeof createRoot>[];
async function settle(host: HTMLElement) {
    for (let attempt = 0; attempt < 100; attempt++) {
        await act(async () => {await new Promise(resolve => setTimeout(resolve, 10));});
        if (!host.querySelector('.friend-feed-loading,.home-phone-loading')) return;
    }
    throw new Error('哔哔未完成读取');
}
async function render(component: React.ReactNode) {
    const host = document.createElement('div'); document.body.append(host); hosts.push(host);
    const root = createRoot(host); roots.push(root);
    await act(async () => {root.render(component);});
    await settle(host);
    return host;
}
async function click(host: HTMLElement, text: string) {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text) || b.getAttribute('aria-label') === text);
    expect(button, text).toBeTruthy();
    await act(async () => {button!.click(); await new Promise(resolve => setTimeout(resolve, 15));});
    await settle(host);
}
beforeEach(async () => {
    hosts = []; roots = []; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();sessionStorage.clear();
    await DB.saveAsset(FRIEND_FEED_KEY, JSON.stringify(emptyFriendFeed()));
    await DB.saveAsset(FRIEND_FEED_API_KEY, 'null');
    for (const char of m.chars) await DB.saveCharacter(char);
});

it.each(['island','moments','insta','journal','weibo','twitter'] as const)('keeps text-only image cards interactive in %s posts and details',async theme=>{
    const circle=await saveFriendCircle({name:'预览',description:'',memberIds:m.chars.map(c=>c.id)});
    await publishFriendPost(circle,'小雨','无配图的文字');
    await mutateFriendFeed(feed=>{feed.posts.push({id:'image-card',circleId:circle,authorId:m.chars[0].id,authorName:'小白',text:'',createdAt:Date.now(),audienceIds:m.chars.map(c=>c.id),comments:[],imageCards:[{caption:'窗边',description:'阳光穿过玻璃水杯，猫的耳朵挤进画面。'}]});});
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),theme});
    const host=await render(React.createElement(FriendFeedApp));
    const card=host.querySelector('.ff-image-card') as HTMLDetailsElement;
    expect(card).not.toBeNull();expect(card.querySelector('img')).toBeNull();
    await act(async()=>{card.querySelector('summary')!.click();});
    expect(card.open).toBe(true);expect(host.querySelector('.ff-post-detail')).toBeNull();
    await act(async()=>{card.querySelector('summary')!.click();});expect(card.open).toBe(false);
    if(theme==='weibo'||theme==='twitter') {await click(host,'图片');expect(host.textContent).not.toContain('无配图的文字');expect(host.querySelector('.ff-image-card')).not.toBeNull();}
    const post=host.querySelector('.ff-image-card')!.closest('article')!;
    await act(async()=>{post.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
    expect(host.querySelector('.ff-post-detail .ff-image-card')?.textContent).toContain('猫的耳朵');
    expect(runImmediateFriendReplies).not.toHaveBeenCalled();expect(refreshFriendFeed).not.toHaveBeenCalled();
});

it('separates preference pages and returns through sources and connection without exiting the app',async()=>{
    await mutateFriendFeed(feed=>{feed.setupSeen=true;});
    const host=await render(React.createElement(FriendFeedApp));
    await click(host,'哔哔设置');
    expect(host.querySelector('[aria-label="设置目录"]')).not.toBeNull();
    expect(host.querySelector('input,textarea')).toBeNull();
    for (const [name,selector] of [
        ['外观与阅读','.friend-feed-theme-options'], ['互动方式','[aria-label="互动与提示词"]'],
        ['我的网名','[aria-label="我的哔哔网名"]'],
        ['角色与小号','[aria-label="角色账号"]'], ['角色与内容权重','[aria-label="刷新与抽取"]'],
    ]) {
        await click(host,name);
        expect(host.querySelector(selector)).not.toBeNull();
        expect(host.querySelectorAll('.ff-preferences-section')).toHaveLength(1);
        await act(async()=>{expect(handleLocalBack()).toBe(true);});
        expect(host.querySelector('[aria-label="设置目录"]')).not.toBeNull();
        expect(m.close).not.toHaveBeenCalled();
    }
    const scroll=host.querySelector('.friend-feed-scroll')!;scroll.scrollTop=143;
    await click(host,'微博与真实内容');
    expect(host.querySelector('.friend-feed-header h1')?.textContent).toBe('微博与真实内容');
    expect(host.querySelector('[aria-label="真实内容权限"]')).not.toBeNull();
    expect(host.textContent).toContain('连接微博');expect(host.textContent).toContain('同步最新动态');expect(host.textContent).toContain('主页绑定');
    await click(host,'返回上一级');
    expect(host.querySelector('[aria-label="设置目录"]')).not.toBeNull();expect(scroll.scrollTop).toBe(143);
    await click(host,'重新查看入门引导');await click(host,'选择 API');await click(host,'取消');
    expect(host.querySelector('[aria-label="哔哔入门引导"]')).not.toBeNull();
    await act(async()=>{expect(handleLocalBack()).toBe(true);});
    expect(host.querySelector('[aria-label="设置目录"]')).not.toBeNull();
    await click(host,'返回上一级');expect(host.querySelector('[aria-label="设置目录"]')).toBeNull();
    expect(m.close).not.toHaveBeenCalled();
    await act(async()=>{expect(handleLocalBack()).toBe(false);});
});

it('does not report a successful sync when no Weibo sources are enabled',async()=>{
    const circleId=await saveFriendCircle({name:'空来源',description:'',memberIds:m.chars.map(c=>c.id)});
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const host=await render(React.createElement(FriendFeedWeiboTimeline,{feed:await readFriendFeed(),circleId,onConnect:()=>{}}));
    await click(host,'同步最新动态');
    expect(host.textContent).toContain('尚未开启微博来源');
    expect(host.textContent).not.toContain('同步完成');
    expect(fetcher).not.toHaveBeenCalled();
    expect((await readFriendFeed()).posts).toHaveLength(0);
});
it('an already connected account reads its real home timeline and displays its own nickname and avatar',async()=>{
    const {getProxyWorkerUrl}=await import('./proxyWorker');
    const session={version:2,origin:window.location.origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]};
    sessionStorage.setItem('sully:weibo-session:v2',JSON.stringify({id:'home-session',proxy:getProxyWorkerUrl(),uid:'123456',session,expires:session.expires}));
    const avatar='https://tvax1.sinaimg.cn/crop/avatar.jpg';
    const fetcher=vi.fn(async(_url,options)=>Response.json(JSON.parse(options.body).action==='profile'
        ?{session,profile:{uid:'123456',name:'我的真实微博名',avatar,description:''}}
        :JSON.parse(options.body).action==='posts'?{session,posts:[{platform:'weibo',accountId:'123456',externalId:'888888',url:'https://weibo.com/123456/888888',author:'我',text:'我自己发的微博',publishedAt:Date.now()-1000,fetchedAt:Date.now(),truncated:false}],nextPage:null}
        :{session,posts:[{platform:'weibo',accountId:'654321',externalId:'111111',url:'https://weibo.com/654321/111111',author:'关注的人',text:'关注的人发的真实内容',publishedAt:Date.now()-1000,fetchedAt:Date.now(),truncated:false}],nextCursor:null}));vi.stubGlobal('fetch',fetcher);
    const host=await render(React.createElement(FriendFeedApp));
    await click(host,'哔哔设置');await click(host,'微博与真实内容');
    await click(host,'同步微博首页');
    await act(async()=>{await vi.waitFor(()=>expect(host.textContent).toContain('已读取 1 条微博，新增 1 条'));});
    expect(fetcher.mock.calls.map(([,o])=>JSON.parse(o.body).action).sort()).toEqual(['home','posts','profile']);
    await click(host,'查看动态');
    expect(host.textContent).toContain('关注的人发的真实内容');expect(host.textContent).toContain('我的真实微博名');
    expect(host.querySelector(`img[src="${avatar}"]`)).not.toBeNull();
    expect(refreshFriendFeed).not.toHaveBeenCalled();
    expect((await readFriendFeed()).weiboBindings).toEqual([expect.objectContaining({ownerId:'user',uid:'123456'})]);
    await click(host,'我的主页');
    expect(host.textContent).not.toContain('关注的人发的真实内容');expect(host.textContent).toContain('我自己发的微博');
    expect(host.querySelector(`img[src="${avatar}"]`)).not.toBeNull();
});
it('automatically reads identity and the home timeline immediately after QR confirmation',async()=>{
    const circleId=await saveFriendCircle({name:'扫码圈',description:'',memberIds:m.chars.map(c=>c.id)});
    const account={version:2,origin:window.location.origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]};
    const qr={...account,kind:'qr',uid:undefined,qrid:'qr-auto'};
    const fetcher=vi.fn(async(_url,options)=>{
        const {action}=JSON.parse(options.body);
        return Response.json(action==='start'?{phase:'waiting',image:'https://v2.qr.weibo.cn/test',session:qr}
            :action==='poll'?{phase:'connected',uid:account.uid,expires:account.expires,session:account}
            :action==='profile'?{session:account,profile:{uid:account.uid,name:'真实登录者',description:''}}
            :{session:account,posts:[],nextCursor:null});
    });vi.stubGlobal('fetch',fetcher);
    const host=await render(React.createElement(FriendFeedWeiboConnection,{circleId}));
    await act(async()=>{host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();});await click(host,'扫码连接微博');
    await act(async()=>{await new Promise(r=>setTimeout(r,2650));});
    expect(fetcher.mock.calls.map(([,o])=>JSON.parse(o.body).action).sort()).toEqual(['home','poll','posts','profile','start']);
    expect(host.textContent).toContain('返回 0 条');expect((await readFriendFeed()).weiboStreams?.[0].enabled).toBe(true);
});
it('opens real author profiles on Weibo without mounting or fetching an in-app profile',async()=>{
    const circle=await saveFriendCircle({name:'圈',description:'',memberIds:m.chars.map(c=>c.id)});
    await importFriendSource(circle,{platform:'weibo',accountId:'654321',externalId:'111111',url:'https://weibo.com/654321/111111',author:'真实作者',text:'真实原帖',publishedAt:Date.now(),fetchedAt:Date.now(),truncated:false});
    const opened=vi.spyOn(window,'open').mockImplementation(()=>null),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const host=await render(React.createElement(FriendFeedApp));await click(host,'查看真实作者的主页');
    expect(opened).toHaveBeenCalledWith('https://weibo.com/u/654321','_blank','noopener,noreferrer');
    expect(host.querySelector('[aria-label="真实微博主页"]')).toBeNull();expect(fetcher).not.toHaveBeenCalled();
});
it('refreshes ranked batches, retains them on return, changes endpoint through settings and preserves errors without AI calls',async()=>{
    const {getProxyWorkerUrl}=await import('./proxyWorker');
    const session={version:2,origin:window.location.origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]};
    sessionStorage.setItem('sully:weibo-session:v2',JSON.stringify({id:'ranked-home',proxy:getProxyWorkerUrl(),uid:session.uid,session,expires:session.expires}));
    const circle=await saveFriendCircle({name:'圈',description:'',memberIds:m.chars.map(c=>c.id),realContentEnabled:true});
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),realContentEnabled:true,theme:'weibo'});
    const source=(id:string,text:string,time:number)=>({platform:'weibo',accountId:'654321',externalId:id,url:`https://weibo.com/654321/${id}`,author:'真实作者',text,publishedAt:time,fetchedAt:Date.now(),truncated:false});
    const older=source('111111','推荐在前的旧微博',Date.now()-20000),newer=source('222222','排在后的新微博',Date.now()-1000),third=source('333333','刷新后的另一批',Date.now()-10000);
    let reads=0,fail=false;
    const fetcher=vi.fn(async(_url,options)=>{const body=JSON.parse(options.body);
        if(body.action==='comments')return Response.json({session,comments:[],nextCursor:null});
        if(fail)return Response.json({error:'微博读取测试错误'},{status:502});
        return Response.json({session,posts:reads++===0?[older,newer]:[third],nextCursor:null});});vi.stubGlobal('fetch',fetcher);
    const host=await render(React.createElement(React.StrictMode,null,React.createElement(FriendFeedApp)));await click(host,'微博首页');
    await act(async()=>{await vi.waitFor(()=>expect(host.textContent).toContain('推荐在前的旧微博'));});
    expect([...host.querySelectorAll('.ff-post-text')].map(p=>p.textContent)).toEqual(['推荐在前的旧微博','排在后的新微博']);
    expect((await readFriendFeed()).posts.map(p=>p.source?.externalId).sort()).toEqual(['111111','222222']);
    await act(async()=>{host.querySelector<HTMLElement>('[aria-label="查看动态评论区：推荐在前的旧微博"]')!.click();await new Promise(r=>setTimeout(r,20));});await click(host,'返回上一级');
    expect(reads).toBe(1);expect(host.textContent).toContain('推荐在前的旧微博');
    await click(host,'刷新微博首页');expect(host.textContent).toContain('刷新后的另一批');expect(host.textContent).not.toContain('推荐在前的旧微博');
    expect(JSON.parse(fetcher.mock.calls.filter(([,o])=>JSON.parse(o.body).action==='home').at(-1)![1].body).cursor).toBe('0');
    fail=true;await click(host,'刷新微博首页');expect(host.textContent).toContain('微博读取测试错误');expect(host.textContent).toContain('刷新后的另一批');fail=false;
    await click(host,'首页设置');const select=host.querySelector<HTMLSelectElement>('[aria-label="微博首页模式"]')!;
    await act(async()=>{select.value='latest';select.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,20));});
    await click(host,'返回上一级');await act(async()=>{await vi.waitFor(()=>expect(fetcher.mock.calls.some(([,o])=>JSON.parse(o.body).action==='following')).toBe(true));});
    expect(host.textContent).toContain('最新关注');expect((await readFriendFeed()).settings?.realContentEnabled).toBe(true);expect(refreshFriendFeed).not.toHaveBeenCalled();
});
it('automatically restores my own posts on entry and retries a failed read without requiring an AI API',async()=>{
    const {getProxyWorkerUrl}=await import('./proxyWorker');
    const session={version:2,origin:window.location.origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]};
    sessionStorage.setItem('sully:weibo-session:v2',JSON.stringify({id:'own-profile',proxy:getProxyWorkerUrl(),uid:session.uid,session,expires:session.expires}));
    const own={platform:'weibo',accountId:'123456',externalId:'999999',url:'https://weibo.com/123456/999999',author:'我',text:'找回我的真实微博',publishedAt:Date.now(),fetchedAt:Date.now(),truncated:false};
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({error:'我的微博暂时不可读取'},{status:502})).mockImplementation(async()=>Response.json({session,posts:[own],nextPage:null}));vi.stubGlobal('fetch',fetcher);
    const host=await render(React.createElement(React.StrictMode,null,React.createElement(FriendFeedApp)));await click(host,'我的主页');
    await act(async()=>{await vi.waitFor(()=>expect(host.textContent).toContain('我的微博暂时不可读取'));});
    await click(host,'刷新我的微博');expect(host.textContent).toContain('找回我的真实微博');
    const scroll=host.querySelector('.friend-feed-scroll')!;
    await act(async()=>{for(const [type,y] of [['touchstart',0],['touchmove',120],['touchend',120]] as const){const e=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:[{clientX:0,clientY:y}]});scroll.dispatchEvent(e);}await new Promise(r=>setTimeout(r,25));});
    expect(fetcher).toHaveBeenCalledTimes(3);expect(host.textContent).toContain('找回我的真实微博');
    expect(fetcher.mock.calls.every(([,o])=>JSON.parse(o.body).action==='posts')).toBe(true);expect(refreshFriendFeed).not.toHaveBeenCalled();
});
it('reads original comments after StrictMode remounts and opens their authors on the original site',async()=>{
    const {getProxyWorkerUrl}=await import('./proxyWorker');
    const session={version:2,origin:window.location.origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]};
    sessionStorage.setItem('sully:weibo-session:v2',JSON.stringify({id:'strict-comments',proxy:getProxyWorkerUrl(),uid:session.uid,session,expires:session.expires}));
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({session,comments:[{id:'888888',authorId:'654321',authorName:'原评论作者',text:'真实接口评论',createdAt:Date.now()}],nextCursor:null})));
    const opened=vi.spyOn(window,'open').mockImplementation(()=>null);
    const post={platform:'weibo' as const,accountId:'123456',externalId:'999999',url:'https://weibo.com/123456/999999',author:'我',text:'原帖',publishedAt:Date.now(),fetchedAt:Date.now(),truncated:false};
    const host=await render(React.createElement(React.StrictMode,null,React.createElement(FriendFeedWeiboBrowser,{post,theme:'weibo',user:{name:'我'} as any,onConnect:()=>{}})));
    await act(async()=>{await vi.waitFor(()=>expect(host.textContent).toContain('真实接口评论'));});
    await click(host,'原评论作者');expect(opened).toHaveBeenCalledWith('https://weibo.com/u/654321','_blank','noopener,noreferrer');
});
it('continues syncing followed posts when a personal source fails',async()=>{
    const {getProxyWorkerUrl}=await import('./proxyWorker');
    const session={version:2,origin:window.location.origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]};
    sessionStorage.setItem('sully:weibo-session:v2',JSON.stringify({id:'partial-sync',proxy:getProxyWorkerUrl(),uid:session.uid,session,expires:session.expires}));
    const circle=await saveFriendCircle({name:'圈',description:'',memberIds:m.chars.map(c=>c.id)});
    await saveWeiboBinding('user','123456');await mutateFriendFeed(f=>{f.weiboStreams=[{circleId:circle,enabled:true,generation:'partial',since:Date.now(),cursor:'0'}];});
    const fetcher=vi.fn(async(_url,options)=>JSON.parse(options.body).action==='posts'?Response.json({error:'本人来源测试失败'},{status:502}):Response.json({session,posts:[{platform:'weibo',accountId:'654321',externalId:'111111',url:'https://weibo.com/654321/111111',author:'关注的人',text:'其他来源仍然成功',publishedAt:Date.now(),fetchedAt:Date.now(),truncated:false}],nextCursor:null}));vi.stubGlobal('fetch',fetcher);
    const host=await render(React.createElement(FriendFeedWeiboTimeline,{feed:await readFriendFeed(),circleId:circle,onConnect:()=>{}}));await click(host,'同步最新动态');
    expect(host.textContent).toContain('本人来源测试失败');expect(host.textContent).toContain('新增 1 条');expect((await readFriendFeed()).posts[0].text).toBe('其他来源仍然成功');
});
it('filters real and local posts visually without changing either model context or source permissions',async()=>{
    const {friendPostsForCharacter}=await import('./friendFeed');
    const circle=await saveFriendCircle({name:'显示筛选',description:'',memberIds:m.chars.map(c=>c.id),realContentEnabled:true});
    await publishFriendPost(circle,'小雨','本地生活动态');
    await importFriendSource(circle,{platform:'weibo',accountId:'654321',externalId:'111111',url:'https://weibo.com/654321/111111',author:'真实作者',text:'真实平台原帖',publishedAt:Date.now(),fetchedAt:Date.now(),truncated:false});
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),realContentEnabled:true});
    const host=await render(React.createElement(FriendFeedApp));
    const before=await readFriendFeed(),contextBefore=friendPostsForCharacter(before,m.chars[0].id);
    expect(contextBefore).toHaveLength(2);
    await click(host,'真实微博');expect(host.querySelector('.friend-feed-posts')?.textContent).toContain('真实平台原帖');expect(host.querySelector('.friend-feed-posts')?.textContent).not.toContain('本地生活动态');
    await click(host,'本地动态');expect(host.querySelector('.friend-feed-posts')?.textContent).toContain('本地生活动态');expect(host.querySelector('.friend-feed-posts')?.textContent).not.toContain('真实平台原帖');
    const after=await readFriendFeed();expect(after.settings).toEqual(before.settings);expect(after.weiboBindings).toEqual(before.weiboBindings);expect(friendPostsForCharacter(after,m.chars[0].id)).toEqual(contextBefore);
    await click(host,'全部');expect(host.querySelectorAll('.ff-classic-post')).toHaveLength(2);
});
it('allows another real Weibo refresh while the character API is still pending',async()=>{
    await mutateFriendFeed(f=>{f.weiboStreams=[{circleId:'public',enabled:true,generation:'g',since:0}];});
    let finish!:(result:{message:string;warnings:string[]})=>void;
    vi.mocked(refreshFriendFeed).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const host=await render(React.createElement(FriendFeedApp));
    await click(host,'朋友动态');await click(host,'朋友动态');
    expect(refreshFriendFeed).toHaveBeenCalledTimes(1);expect(refreshFriendWeibo).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('已读取 1 条微博');
    await act(async()=>{finish({message:'已读取 1 条微博',warnings:['角色 API：offline']});});
    expect(host.textContent).toContain('角色 API：offline');
});

it('keeps nickname edits local to their page and returns from relations to the settings directory',async()=>{
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),userNickname:'橘子汽水',identities:{[m.chars[1].id]:{nickname:'绿灯',tags:[],accounts:[{id:'private-id',name:'半夜吃面',purpose:'匿名日常',tags:[]}]}}});
    const host=await render(React.createElement(FriendFeedApp));
    await click(host,'哔哔设置');await click(host,'我的网名');
    const nickname=host.querySelector('[aria-label="我的哔哔网名"]') as HTMLInputElement;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(nickname,'新汽水');nickname.dispatchEvent(new Event('input',{bubbles:true}));});
    await click(host,'取消');
    await click(host,'关注与身份关系');
    await act(async()=>{(host.querySelector('[aria-label="关系所属人物"]') as HTMLElement).click();});
    await click(host,'小白');
    await act(async()=>{(host.querySelector('[aria-label="关注 半夜吃面"]') as HTMLInputElement).click();await new Promise(r=>setTimeout(r,30));});
    let feed=await readFriendFeed();const source=friendAccountRef(feed,{authorId:m.chars[0].id})!,alias=friendAccountRef(feed,{authorId:m.chars[1].id,accountId:'private-id'})!;
    expect(feed.accountGraph?.follows[source.id]).toContain(alias.id);
    expect(knowsFriendAccount(feed,m.chars[0].id,alias)).toBe(false);
    await click(host,'以 小白 视角查看');
    expect(host.querySelector('.ff-relation-list')?.textContent).toContain('半夜吃面');
    expect(host.querySelector('.ff-relation-list')?.textContent).toContain('身份未知');
    expect(host.querySelector('.ff-relation-list')?.textContent).not.toContain('小绿');
    expect(host.querySelector('.ff-relation-list input[type=checkbox]')).toBeNull();
    await click(host,'管理关系');
    await act(async()=>{(host.querySelector('[aria-label="知道 半夜吃面 是谁"]') as HTMLInputElement).click();await new Promise(r=>setTimeout(r,30));});
    feed=await readFriendFeed();expect(knowsFriendAccount(feed,m.chars[0].id,alias)).toBe(true);
    await click(host,'返回上一级');
    expect(host.querySelector('[aria-label="设置目录"]')).not.toBeNull();
    await click(host,'我的网名');
    expect((host.querySelector('[aria-label="我的哔哔网名"]') as HTMLInputElement).value).toBe('橘子汽水');
    await click(host,'取消');expect((await readFriendFeed()).settings?.userNickname).toBe('橘子汽水');
    expect(runImmediateFriendReplies).not.toHaveBeenCalled();expect(refreshFriendFeed).not.toHaveBeenCalled();
});

it('opens an alias profile without mixing the owner main posts and retains accounts when resetting appearance',async()=>{
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),identities:{[m.chars[1].id]:{nickname:'绿灯',tags:[],accounts:[{id:'night',name:'半夜吃面',purpose:'匿名',tags:[]}]}}});
    const host=await render(React.createElement(FriendFeedApp));
    await act(async()=>{await mutateFriendFeed(feed=>{feed.posts=[
        {id:'night-post',circleId:'public',authorId:m.chars[1].id,accountId:'night',authorName:'半夜吃面',text:'深夜的面',createdAt:Date.now(),audienceIds:m.chars.map(c=>c.id),comments:[]},
        {id:'main-post',circleId:'public',authorId:m.chars[1].id,authorName:'绿灯',text:'白天的工作',createdAt:Date.now()-1,audienceIds:m.chars.map(c=>c.id),comments:[]},
    ];});await new Promise(r=>setTimeout(r,30));});
    await click(host,'查看半夜吃面的主页');
    expect(host.querySelector('.friend-feed-posts')?.textContent).toContain('深夜的面');expect(host.querySelector('.friend-feed-posts')?.textContent).not.toContain('白天的工作');
    await click(host,'哔哔设置');await click(host,'更多设置');await click(host,'恢复默认设置');await click(host,'保存设置');
    expect((await readFriendFeed()).settings?.identities[m.chars[1].id].accounts[0].name).toBe('半夜吃面');
});
afterEach(() => {act(() => roots.forEach(r => r.unmount())); hosts.forEach(h => h.remove()); vi.unstubAllGlobals(); vi.clearAllMocks();});
async function seedUserNotices(){
    const circle=await saveFriendCircle({name:'广场',description:'',memberIds:m.chars.map(c=>c.id)});
    const id=await publishFriendPost(circle,'小雨','我的咖啡动态');
    await mutateFriendFeed(feed=>{const post=feed.posts.find(p=>p.id===id)!;feed.setupSeen=true;
        for(let i=0;i<3;i++){const comment={id:`notice-${i}`,authorId:`npc:${i}`,authorName:`网友${i}`,text:`一起来聊${i}`,createdAt:Date.now()};
            post.comments.push(comment);enqueueFriendUserNotice(feed,post,comment);}});
    return id;
}
it('collapses long threads to three replies and opens a notification at its exact hidden reply',async()=>{
    const visible=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
    const scroll=vi.fn(),original=HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView=scroll;
    try{
        const id=await seedUserNotices();
        await mutateFriendFeed(feed=>{const post=feed.posts.find(p=>p.id===id)!;const root=post.comments[0];
            post.comments=[root];feed.userInbox=[];
            for(let i=0;i<7;i++){const c={id:`nested-${i}`,authorId:`npc:n${i}`,authorName:`楼内网友${i}`,text:`楼内留言${i}`,createdAt:Date.now()+i,
                localReply:{id:root.id,authorId:root.authorId,authorName:root.authorName,text:root.text}};
                post.comments.push(c);enqueueFriendUserNotice(feed,post,c);}});
        const host=await render(React.createElement(FriendFeedApp));
        await act(async()=>{requestFriendInbox({postId:id});});await settle(host);
        expect(host.querySelectorAll('.ff-thread-replies [data-comment-id]')).toHaveLength(3);
        expect(friendUserInbox(await readFriendFeed()).filter(r=>!r.notice.read)).toHaveLength(4);
        await click(host,'查看全部 7 条回复');expect(host.querySelectorAll('.ff-thread-replies [data-comment-id]')).toHaveLength(7);
        await click(host,'收起回复');expect(host.querySelectorAll('.ff-thread-replies [data-comment-id]')).toHaveLength(3);
        await click(host,'互动提醒');await click(host,'楼内留言6');
        await act(async()=>{await new Promise(resolve=>setTimeout(resolve,45));});
        const target=host.querySelector('[data-comment-id="nested-6"]');
        expect(target?.getAttribute('data-highlighted')).toBe('true');expect(document.activeElement).toBe(target);
        expect(scroll).toHaveBeenCalledWith({block:'center',behavior:'auto'});
        expect(scroll.mock.contexts).toContain(target);
        await click(host,'收起回复');expect(host.querySelector('[data-comment-id="nested-6"]')).toBeNull();
        // The same target can be opened again while the detail page is already mounted.
        await act(async()=>{requestFriendInbox({postId:id,commentId:'nested-6'});await new Promise(resolve=>setTimeout(resolve,45));});
        await settle(host);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,45));});
        expect(document.activeElement).toBe(host.querySelector('[data-comment-id="nested-6"]'));
        expect(runImmediateFriendReplies).not.toHaveBeenCalled();expect(refreshFriendFeed).not.toHaveBeenCalled();
    }finally{visible.mockRestore();HTMLElement.prototype.scrollIntoView=original;}
});
it.each(['island','moments','insta','journal','weibo','twitter'] as const)('lets the user reply to a comment in %s, cancel safely and submit into its thread',async theme=>{
    vi.mocked(runImmediateFriendReplies).mockResolvedValue({commentCount:0} as any);
    const id=await seedUserNotices();await saveFriendFeedSettings({...defaultFriendFeedSettings(),theme});
    const host=await render(React.createElement(FriendFeedApp));
    await act(async()=>{requestFriendInbox({postId:id});});await settle(host);
    await click(host,'回复网友0的评论');expect(host.querySelector('blockquote')?.textContent).toContain('一起来聊0');
    await click(host,'取消');expect(runImmediateFriendReplies).not.toHaveBeenCalled();
    await click(host,'回复网友0的评论');
    await act(async()=>{const textarea=host.querySelector('textarea')!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'你说的是哪种咖啡');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
    await click(host,'发表评论');
    expect(runImmediateFriendReplies).toHaveBeenCalledTimes(1);
    const reply=(await readFriendFeed()).posts.find(p=>p.id===id)!.comments.at(-1)!;
    expect(reply.localReply?.id).toBe('notice-0');
    expect(host.querySelector('[aria-label="网友0的评论下的回复"]')?.textContent).toContain('你说的是哪种咖啡');
    expect(host.querySelector('form')).toBeNull();
});
it('keeps the separate NPC prompt as a settings draft until saved',async()=>{
    const host=await render(React.createElement(FriendFeedApp));await click(host,'哔哔设置');await click(host,'互动方式');
    const textarea=[...host.querySelectorAll('textarea')].find(t=>t.closest('label')?.textContent?.includes('路人怎么说话'))!;
    const old=textarea.value;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'只聊公开的烘焙细节');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
    await click(host,'取消');await click(host,'互动方式');
    const again=[...host.querySelectorAll('textarea')].find(t=>t.closest('label')?.textContent?.includes('路人怎么说话'))!;
    expect(again.value).toBe(old);
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(again,'只聊公开的烘焙细节');again.dispatchEvent(new Event('input',{bubbles:true}));});
    await click(host,'保存设置');expect((await readFriendFeed()).settings?.npcPrompt).toBe('只聊公开的烘焙细节');
    expect(runImmediateFriendReplies).not.toHaveBeenCalled();
});
it.each(['island','moments','insta','journal','weibo','twitter'] as const)('shows a compact unread inbox in %s and reads only after opening the post',async theme=>{
    const visible=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
    try{
        await seedUserNotices();await saveFriendFeedSettings({...defaultFriendFeedSettings(),theme});
        const host=await render(React.createElement(FriendFeedApp));
        await click(host,'互动提醒，3 条未读');
        expect(host.querySelectorAll('.ff-inbox-item')).toHaveLength(3);
        expect(friendUserInbox(await readFriendFeed()).filter(r=>!r.notice.read)).toHaveLength(3);
        await click(host,'一起来聊0');
        expect(host.textContent).toContain('我的咖啡动态');
        expect(friendUserInbox(await readFriendFeed()).filter(r=>!r.notice.read)).toHaveLength(0);
        await click(host,'返回上一级');expect(host.querySelector('[aria-label="哔哔互动提醒"]')).not.toBeNull();
        expect(runImmediateFriendReplies).not.toHaveBeenCalled();expect(refreshFriendFeed).not.toHaveBeenCalled();
    }finally{visible.mockRestore();}
});
it('aggregates global replies into one clickable banner and opens the target after launching Bibi',async()=>{
    const visible=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
    try{
        await seedUserNotices();const banner=await render(React.createElement(FriendFeedNotification));
        await vi.waitFor(()=>expect(banner.textContent).toContain('收到了 3 条新互动'));
        expect(banner.querySelectorAll('[aria-label="哔哔新互动提醒"]')).toHaveLength(1);
        expect(friendUserInbox(await readFriendFeed()).every(r=>r.notice.announced&&!r.notice.read)).toBe(true);
        await click(banner,'哔哔 · 新回复');expect(m.open).toHaveBeenCalledWith(AppID.FriendFeed);
        const host=await render(React.createElement(FriendFeedApp));
        expect(host.textContent).toContain('我的咖啡动态');expect(host.textContent).toContain('一起来聊0');
        expect(host.querySelector('[data-highlighted=true]')?.textContent).toContain('一起来聊');
        await click(host,'返回上一级');expect(host.querySelector('[aria-label="哔哔互动提醒"]')).not.toBeNull();
        await act(async()=>{requestFriendInbox();});expect(host.querySelector('[aria-label="哔哔互动提醒"]')).not.toBeNull();
        expect(runImmediateFriendReplies).not.toHaveBeenCalled();expect(refreshFriendFeed).not.toHaveBeenCalled();
    }finally{visible.mockRestore();}
});
it('shows setup once without calling a model, persists dismissal and reopens it from settings',async()=>{
    const clock=vi.spyOn(performance,'now').mockReturnValue(0);
    try{
    const host=await render(React.createElement(FriendFeedApp));
    expect(host.querySelector('[aria-label="哔哔入门引导"]')).not.toBeNull();
    expect(host.textContent).toContain('0/2 位参与角色');
    expect(runImmediateFriendReplies).not.toHaveBeenCalled();expect(refreshFriendFeed).not.toHaveBeenCalled();
    const confirm=host.querySelector('.ff-setup > button') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);expect(confirm.textContent).toContain('10s');
    await click(host,'请先阅读');expect((await readFriendFeed()).setupSeen).not.toBe(true);
    clock.mockReturnValue(10_000);
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,300));});
    await click(host,'知道了，开始逛');expect((await readFriendFeed()).setupSeen).toBe(true);
    expect(host.querySelector('[aria-label="哔哔入门引导"]')).toBeNull();
    await click(host,'哔哔设置');await click(host,'重新查看入门引导');
    expect(host.querySelector('[aria-label="哔哔入门引导"]')).not.toBeNull();
    expect((host.querySelector('.ff-setup > button') as HTMLButtonElement).disabled).toBe(true);
    }finally{clock.mockRestore();}
});
it('keeps API setup inside Bibi, cancels drafts and targets the relevant preference section',async()=>{
    const host=await render(React.createElement(FriendFeedApp));
    await click(host,'选择 API');
    expect(host.querySelector('[aria-label="哔哔 API 配置"]')).not.toBeNull();
    const toggle=host.querySelector('input[type=checkbox]') as HTMLInputElement;
    await act(async()=>{toggle.click();});
    await click(host,'取消');
    expect(await readFriendFeedApi()).toBeNull();
    expect(host.querySelector('[aria-label="哔哔入门引导"]')).not.toBeNull();
    await click(host,'调整朋友');
    expect(document.activeElement).toBe(host.querySelector('[data-setup-section="accounts"]'));
    await click(host,'取消');await click(host,'设置互动');
    expect(document.activeElement).toBe(host.querySelector('[data-setup-section="interaction"]'));
    expect(runImmediateFriendReplies).not.toHaveBeenCalled();expect(refreshFriendFeed).not.toHaveBeenCalled();
});
it('saves an independent preset only on explicit save and retains it when appearance settings change',async()=>{
    const host=await render(React.createElement(FriendFeedApp));
    await click(host,'选择 API');
    await act(async()=>{(host.querySelector('input[type=checkbox]') as HTMLInputElement).click();});
    await click(host,'哔哔测试预设');expect(await readFriendFeedApi()).toBeNull();
    await click(host,'保存 API 设置');expect(await readFriendFeedApi()).toMatchObject({model:'test-bibi',apiKey:'test-only'});
    expect(host.textContent).toContain('已使用哔哔独立 API');
    await click(host,'哔哔设置');await click(host,'外观与阅读');await click(host,'保存设置');
    expect(await readFriendFeedApi()).toMatchObject({model:'test-bibi'});
    expect(JSON.stringify(await readFriendFeed())).not.toContain('test-only');
});
it('selects, removes and publishes local photos without text, then finds the post in the media tab',async()=>{
    vi.stubGlobal('URL',class extends URL {static createObjectURL=vi.fn(()=> 'blob:preview');static revokeObjectURL=vi.fn();});
    const compression=vi.spyOn(imageFiles,'processImageToBlob').mockResolvedValue(new Blob(['photo'],{type:'image/jpeg'}));
    try {
        await saveFriendFeedSettings({...defaultFriendFeedSettings(),theme:'twitter'});
        const host=await render(React.createElement(FriendFeedApp));await click(host,'发布新动态');
        const input=host.querySelector('input[type=file]') as HTMLInputElement;
        Object.defineProperty(input,'files',{configurable:true,value:[new File(['one'],'one.jpg',{type:'image/jpeg'}),new File(['two'],'two.jpg',{type:'image/jpeg'})]});
        await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,20));});
        expect(host.querySelectorAll('.ff-compose-thumbnails img')).toHaveLength(2);
        await click(host,'移除配图 1');expect(host.querySelector('textarea')?.required).toBe(false);
        await click(host,'发布动态');
        const state=await readFriendFeed();expect(state.posts).toHaveLength(1);expect(state.posts[0].text).toBe('');expect(state.posts[0].images).toHaveLength(1);
        await click(host,'图片');expect(host.querySelectorAll('.ff-social-post')).toHaveLength(1);
        expect(runImmediateFriendReplies).not.toHaveBeenCalled();expect(refreshFriendFeed).not.toHaveBeenCalled();
    } finally {compression.mockRestore();}
});
it('opens ordered photo previews, changes images and handles local back before leaving the app',async()=>{
    HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
    HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
    const images=['one','two'].map(id=>({url:`https://wx1.sinaimg.cn/large/${id}.jpg`,thumbnail:`https://wx1.sinaimg.cn/bmiddle/${id}.jpg`}));
    const host=await render(React.createElement(FriendFeedImages,{images}));
    const thumbnails=host.querySelectorAll('img');expect(thumbnails).toHaveLength(2);
    expect(thumbnails[0].getAttribute('loading')).toBe('lazy');expect(thumbnails[0].getAttribute('referrerpolicy')).toBe('no-referrer');
    await click(host,'查看配图 1，共 2 张');expect(host.querySelector('dialog[open] img')?.getAttribute('src')).toBe(images[0].url);
    await click(host,'下一张配图');expect(host.querySelector('dialog[open] img')?.getAttribute('src')).toBe(images[1].url);
    await act(async()=>{expect(handleLocalBack()).toBe(true);});expect(host.querySelector('dialog')).toBeNull();
    await act(async()=>{thumbnails[0].dispatchEvent(new Event('error'));});expect(thumbnails[0].getAttribute('src')).toContain('/weibo-image?url=');
    await act(async()=>{thumbnails[0].dispatchEvent(new Event('error'));});expect(host.textContent).toContain('图片暂时无法加载');
    await act(async()=>{setProxyWorkerUrl('https://my-proxy.test');});
    await act(async()=>{host.querySelector('img')!.dispatchEvent(new Event('error'));});
    expect(host.querySelector('img')!.getAttribute('src')).toContain('https://my-proxy.test/weibo-image?url=');
});
it('shares a post to the selected character, keeps the full snapshot and returns to the same detail without generating',async()=>{
    const circle=await saveFriendCircle({name:'分享预览',description:'',memberIds:m.chars.map(c=>c.id)});
    const id=await publishFriendPost(circle,'小雨','一条想分享的日常');
    const host=await render(React.createElement(FriendFeedApp));await click(host,'评论');await click(host,'分享给角色');
    expect(host.textContent).toContain('最近 10 条');await click(host,'小绿');await click(host,'发送到私聊');
    expect(host.textContent).toContain('已分享到 小绿 的私聊');
    const msg=(await DB.getMessagesByCharId(m.chars[1].id,true)).find(m=>m.type==='friend_feed_share_card');
    expect(msg?.metadata?.friendFeedShare.postId).toBe(id);expect(refreshFriendFeed).not.toHaveBeenCalled();expect(runImmediateFriendReplies).not.toHaveBeenCalled();
    await click(host,'完成');expect(host.querySelector('.ff-post-detail')).not.toBeNull();
});
it('registers a standalone app and shows the same persisted circle inside the home phone', async () => {
    expect(INSTALLED_APPS.find(a => a.id === AppID.FriendFeed)?.name).toBe('哔哔');
    const circleId = await saveFriendCircle({name: '下班后的客厅', description: '', memberIds: [m.chars[0].id]});
    await publishFriendPost(circleId, '小雨', '咖啡好了');
    const desktop = await render(React.createElement(FriendFeedApp));
    const phone = await render(React.createElement(HomePhone, {editor: editor as any, characterId: m.chars[0].id, onOpenChange: vi.fn()}));
    await click(phone, '打开小手机');
    expect(phone.textContent).toContain('信息'); expect(phone.textContent).toContain('拍照');
    await click(phone, '哔哔');
    expect(phone.textContent).toContain('咖啡好了');
    expect(desktop.textContent).toContain('咖啡好了');
    expect(desktop.textContent).not.toContain('和你');
    expect(desktop.querySelector('.friend-feed-member-faces')).toBeNull();
    expect(desktop.textContent).not.toContain('管理生活圈');
    await click(desktop, '哔哔设置');
    expect(desktop.textContent).toContain('角色与小号');
    await click(desktop, '返回上一级');
    await act(async () => {await publishFriendPost(circleId, '小雨', '新的一条'); await new Promise(resolve => setTimeout(resolve, 15));});
    expect(phone.textContent).toContain('新的一条'); expect(desktop.textContent).toContain('新的一条');
    await click(phone, '评论');
    await act(async () => {expect(handleLocalBack()).toBe(true);});
    expect(phone.querySelector('form')).toBeNull(); expect(phone.textContent).toContain('咖啡好了');
    await act(async () => {expect(handleLocalBack()).toBe(true);});
    expect(phone.textContent).toContain('今天，也想靠近你');
    await click(phone, '拍照'); expect(phone.textContent).toContain('原有相机页面');
});
it('shows the unified public feed in the embedded phone without choosing groups', async () => {
    const circleId = await saveFriendCircle({name: '另一个世界', description: '', memberIds: [m.chars[1].id]});
    await publishFriendPost(circleId, '小雨', '另一个圈的内容');
    const host = await render(React.createElement(FriendFeedApp, {embedded: true, initialCharacterId: m.chars[0].id}));
    expect(host.textContent).not.toContain('创建生活圈');
    expect(host.textContent).toContain('另一个圈的内容');
});
it('publishes as the user and requires confirmation before deleting a post', async () => {
    await saveFriendCircle({name: '客厅', description: '', memberIds: [m.chars[0].id]});
    const host = await render(React.createElement(FriendFeedApp));
    await click(host, '发布新动态');
    const textarea = host.querySelector('textarea')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '你好，朋友们');
        textarea.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await click(host, '发布动态');
    expect((await readFriendFeed()).posts[0]).toMatchObject({authorId: 'user', authorName: '小雨', text: '你好，朋友们'});
    await click(host, '删除动态：你好，朋友们');
    expect((await readFriendFeed()).posts).toHaveLength(1);
    await click(host, '确认删除');
    expect((await readFriendFeed()).posts).toHaveLength(0);
});
it('previews settings locally, discards cancelled edits and shares saved preferences with the embedded entry', async () => {
    await saveFriendCircle({name: '客厅', description: '', memberIds: [m.chars[0].id]});
    const desktop = await render(React.createElement(FriendFeedApp));
    const embedded = await render(React.createElement(FriendFeedApp, {embedded: true, initialCharacterId: m.chars[0].id}));
    await click(desktop, '哔哔设置');await click(desktop, '外观与阅读');
    expect(desktop.textContent).toContain('微信朋友圈');
    expect(desktop.textContent).toContain('Ins 风格');
    expect(desktop.textContent).toContain('蓝墨杂志');
    expect(desktop.textContent).toContain('微博风格');
    expect(desktop.textContent).toContain('推特风格');
    await act(async () => {(desktop.querySelector('input[value=insta]') as HTMLInputElement).click();});
    expect(desktop.querySelector('.friend-feed')?.getAttribute('data-theme')).toBe('insta');
    expect(embedded.querySelector('.friend-feed')?.getAttribute('data-theme')).toBe('island');
    await act(async () => {(desktop.querySelector('input[value=timeline]') as HTMLInputElement).click();});
    expect(desktop.querySelector('.friend-feed')?.getAttribute('data-layout')).toBe('timeline');
    expect(embedded.querySelector('.friend-feed')?.getAttribute('data-layout')).toBe('paper');
    await click(desktop, '取消');
    expect(desktop.querySelector('.friend-feed')?.getAttribute('data-layout')).toBe('paper');
    expect(desktop.querySelector('.friend-feed')?.getAttribute('data-theme')).toBe('moments');
    await click(desktop, '外观与阅读');
    await act(async () => {(desktop.querySelector('input[value=moments]') as HTMLInputElement).click();});
    await act(async () => {(desktop.querySelector('input[value=compact]') as HTMLInputElement).click();});
    await click(desktop, '保存设置');
    await settle(embedded);
    expect(embedded.querySelector('.friend-feed')?.getAttribute('data-layout')).toBe('compact');
    expect(embedded.querySelector('.friend-feed')?.getAttribute('data-theme')).toBe('island');
    expect((await readFriendFeed()).settings?.theme).toBe('moments');
    await click(embedded, '哔哔设置');await click(embedded, '外观与阅读');
    expect(embedded.querySelector('input[name=feed-theme]')).toBeNull();
    await click(embedded, '取消');await click(embedded, '更多设置');await click(embedded, '恢复默认设置');
    await click(embedded, '保存设置');
    expect((await readFriendFeed()).settings?.theme).toBe('moments');
    expect(desktop.querySelector('.friend-feed')?.getAttribute('data-theme')).toBe('moments');
    await click(desktop, '更多设置'); await click(desktop, '恢复默认设置'); await click(desktop, '保存设置');
    await settle(embedded);
    expect((await readFriendFeed()).settings?.layout).toBe('paper');
    expect(embedded.querySelector('.friend-feed')?.getAttribute('data-layout')).toBe('paper');
    expect(embedded.querySelector('.friend-feed')?.getAttribute('data-theme')).toBe('island');
});
it.each(['weibo','twitter'] as const)('keeps %s media, profiles, source settings and back navigation functional',async(theme)=>{
    const circleId=await saveFriendCircle({name:'客厅',description:'',memberIds:[m.chars[0].id]});
    await publishFriendPost(circleId,'小雨','本地文字日常');await saveWeiboBinding(m.chars[0].id,'123456');
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),theme});
    await mutateFriendFeed(feed=>{const time=Date.now()-10000;feed.posts.push({id:'social-photo',circleId,authorId:m.chars[0].id,authorName:'小白',text:'配图日常',createdAt:time,audienceIds:[m.chars[0].id],comments:[],synced:true,
        source:{platform:'weibo',accountId:'123456',externalId:'111111',url:'https://weibo.com/123456/111111',author:'现实账号',text:'配图日常',publishedAt:time,fetchedAt:time,truncated:false,
            images:Array.from({length:5},(_,i)=>({url:`https://wx1.sinaimg.cn/large/${i}.jpg`,thumbnail:`https://wx1.sinaimg.cn/bmiddle/${i}.jpg`}))}});});
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const host=await render(React.createElement(FriendFeedApp));
    expect(host.querySelectorAll('.ff-social-post')).toHaveLength(2);
    await click(host,'图片');
    expect(host.querySelectorAll('.ff-social-post')).toHaveLength(1);expect(host.textContent).not.toContain('本地文字日常');
    expect(host.querySelectorAll('.ff-photo-grid button')).toHaveLength(theme==='twitter'?4:5);
    await click(host,'查看小白的主页');expect(host.querySelector('.ff-social-profile')?.textContent).toContain('小白');
    await click(host,'主页设置');expect(host.textContent).toContain('微博与真实内容');
    await click(host,'管理微博连接');expect(host.textContent).toContain('连接微博');
    expect(host.querySelector('[aria-label="微博与真实内容设置"]')).not.toBeNull();
    await act(async()=>{expect(handleLocalBack()).toBe(true);});expect(host.querySelector('.ff-social-profile')).not.toBeNull();
    await act(async()=>{expect(handleLocalBack()).toBe(true);});expect(host.querySelectorAll('.ff-social-post')).toHaveLength(2);
    await click(host,'发布新动态');expect(host.querySelector('textarea')).not.toBeNull();await click(host,'取消');
    expect(fetcher).not.toHaveBeenCalled();
});
it('always starts immediate replies and retains their saved comment when the API fails', async () => {
    vi.mocked(runImmediateFriendReplies).mockRejectedValue(new Error('评论已保存，接话失败，可重试'));
    await saveFriendFeedSettings({...defaultFriendFeedSettings(), replyMode: 'immediate'});
    const circleId = await saveFriendCircle({name: '客厅', description: '', memberIds: [m.chars[0].id]});
    await publishFriendPost(circleId, '小雨', '咖啡好了');
    const host = await render(React.createElement(FriendFeedApp));
    await click(host, '评论');
    await click(host, '写评论');
    expect(host.textContent).toContain('立即调用一次 API');
    await act(async () => {
        const textarea = host.querySelector('textarea')!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '一起喝呀');
        textarea.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await click(host, '发表评论');
    expect(runImmediateFriendReplies).toHaveBeenCalledTimes(1);
    expect((await readFriendFeed()).posts[0].comments.map(c => c.text)).toEqual(['一起喝呀']);
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).toContain('评论已保存');
    expect(host.textContent).not.toContain('现在接话');
    expect(host.textContent).not.toContain('搭主 API 便车');
    await click(host,'返回上一级');
    await click(host, '哔哔设置');
    await click(host,'互动方式');expect(host.textContent).toContain('立即调用一次对话 API'); expect(host.textContent).toContain('让路人也来串场');
});

it('hides paid import controls while keeping imported sources readable and old keys removable', async () => {
    const circleId = await saveFriendCircle({name: '客厅', description: '', memberIds: [m.chars[0].id]});
    await importFriendSource(circleId, {platform: 'x', externalId: '1808168603721650364',
        url: 'https://x.com/i/status/1808168603721650364', author: '外部作者', text: '真实咖啡帖子', fetchedAt: Date.now(), truncated: false});
    saveTikHubKey('test-only-key'); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const host = await render(React.createElement(FriendFeedApp));
    await click(host, '朋友动态');
    expect(host.textContent).toContain('真实咖啡帖子'); expect(host.textContent).not.toContain('粘贴链接导入');
    await click(host, '哔哔设置');
    await click(host, '更多设置');
    expect(host.querySelector('input[type=password]')).toBeNull();
    expect(host.textContent).not.toContain('注册 TikHub');
    await click(host, '移除旧 Key'); expect(readTikHubKey()).toBe('');
    expect(fetcher).not.toHaveBeenCalled(); expect((await readFriendFeed()).posts).toHaveLength(1);
});
it('mixes bound Weibo and local posts chronologically and filters the same entries into profiles',async()=>{
    const circleId=await saveFriendCircle({name:'客厅',description:'',memberIds:[m.chars[0].id]});
    await publishFriendPost(circleId,'小雨','本地新日常');await saveWeiboBinding(m.chars[0].id,'123456');
    await mutateFriendFeed(feed=>{const time=Date.now()-10000;feed.posts.push({id:'synced-preview',circleId,authorId:m.chars[0].id,authorName:'小白',
        text:'微博里的咖啡',createdAt:time,audienceIds:[m.chars[0].id],comments:[],synced:true,
        source:{platform:'weibo',accountId:'123456',externalId:'111111',url:'https://weibo.com/123456/111111',author:'现实账号',text:'微博里的咖啡',publishedAt:time,fetchedAt:Date.now(),truncated:false}});});
    const host=await render(React.createElement(FriendFeedApp));
    expect([...host.querySelectorAll('.ff-classic-text')].map(p=>p.textContent)).toEqual(['本地新日常','微博里的咖啡']);
    expect(host.querySelector('.ff-classic-post.is-real .friend-feed-source-hint')?.textContent).toContain('来自真实微博');
    await click(host,'小白');expect(host.textContent).toContain('微博里的咖啡');expect(host.textContent).not.toContain('本地新日常');
    await click(host,'主页设置');expect(host.textContent).toContain('RP 角色自己发过');expect(host.querySelector<HTMLSelectElement>('[aria-label="微博主页绑定对象"]')?.value).toBe(m.chars[0].id);
    await act(async()=>{expect(handleLocalBack()).toBe(true);});
    await act(async()=>{expect(handleLocalBack()).toBe(true);});expect(host.textContent).toContain('本地新日常');
    await click(host,'我的主页');expect(host.textContent).toContain('本地新日常');expect(host.textContent).not.toContain('微博里的咖啡');
});

it.each(['island','moments','insta','journal','weibo','twitter'] as const)('hides real originals reversibly in %s while retaining local reposts and AI permissions',async(theme)=>{
    const circleId=await saveFriendCircle({name:'旧圈',description:'',memberIds:m.chars.map(c=>c.id),realContentEnabled:true});
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),theme,realContentEnabled:true});
    await saveWeiboBinding(m.chars[0].id,'123456');
    await mutateFriendFeed(feed=>{const source={platform:'weibo' as const,accountId:'123456',externalId:'111111',url:'https://weibo.com/123456/111111',author:'原作者',text:'原文',publishedAt:Date.now(),fetchedAt:Date.now(),truncated:false};
        feed.posts.push({id:'original',circleId,authorId:m.chars[0].id,authorName:'小白',text:'同步的原帖',createdAt:Date.now(),audienceIds:m.chars.map(c=>c.id),comments:[],synced:true,source},
            {id:'repost',circleId,authorId:m.chars[1].id,authorName:'小绿',text:'自己的转发感想',createdAt:Date.now(),audienceIds:m.chars.map(c=>c.id),comments:[],source});});
    const host=await render(React.createElement(FriendFeedApp));
    expect(host.textContent).toContain('同步的原帖');
    const toggleReal=async()=>{await click(host,'哔哔设置');await click(host,'微博与真实内容');await act(async()=>{(Array.from(host.querySelectorAll('label')).find(l=>l.textContent?.startsWith('隐藏真实微博帖子'))!.querySelector('input') as HTMLInputElement).click();await new Promise(r=>setTimeout(r,30));});await click(host,'返回上一级');await click(host,'返回上一级');};
    expect(host.querySelector('[aria-label="更多动态选项"]')).toBeNull();
    await toggleReal();expect(host.textContent).not.toContain('同步的原帖');expect(host.textContent).toContain('自己的转发感想');
    const feed=await readFriendFeed();expect(feed.posts).toHaveLength(2);expect(feed.settings?.realContentEnabled).toBe(true);
    await toggleReal();expect(host.textContent).toContain('同步的原帖');
});
it('saves three aliases and per-character refresh weights without a model request',async()=>{
    const host=await render(React.createElement(FriendFeedApp));await click(host,'哔哔设置');await click(host,'角色与小号');
    for(let i=0;i<3;i++)await click(host,'添加小号');
    const add=[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('添加小号'))!;expect(add.disabled).toBe(true);
    await click(host,'保存设置');await click(host,'角色与内容权重');
    const weight=host.querySelector('input[aria-label="小白的抽取权重"]')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(weight,'0');weight.dispatchEvent(new Event('input',{bubbles:true}));});
    await click(host,'保存设置');const feed=await readFriendFeed();
    expect(feed.settings?.identities[m.chars[0].id].accounts).toHaveLength(3);expect(feed.settings?.characterWeights[m.chars[0].id]).toBe(0);
});

it.each(['island','moments','insta','journal','weibo','twitter'] as const)('navigates through my following in %s and refreshes only when home is reselected',async(theme)=>{
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),theme});
    const host=await render(React.createElement(FriendFeedApp));
    expect(host.querySelector('[aria-label="选择角色主页"]')).toBeNull();expect(host.querySelector('.ff-home-tools')).toBeNull();
    await click(host,'我的主页');await click(host,'我的关注');
    const directory=host.querySelector('[aria-label="关注的角色"]')!;
    for(const char of m.chars)expect(directory.textContent).toContain(char.name);
    expect(host.querySelector('[aria-label="真实微博关注"]')?.textContent).toContain('连接微博');
    await click(host,'小白');expect(host.querySelector('.ff-classic-profile,.ff-social-profile')?.textContent).toContain('小白');
    await act(async()=>{expect(handleLocalBack()).toBe(true);});expect(host.querySelector('.ff-following-directory')).not.toBeNull();
    await act(async()=>{expect(handleLocalBack()).toBe(true);});expect(host.querySelector('.ff-classic-profile,.ff-social-profile')?.textContent).toContain('小雨');
    await click(host,'朋友动态');expect(refreshFriendFeed).not.toHaveBeenCalled();
    await click(host,'朋友动态');expect(refreshFriendFeed).toHaveBeenCalledTimes(1);
});

it('refreshes on a released top pull, ignoring short, horizontal, cancelled and scrolled gestures',async()=>{
    const host=await render(React.createElement(FriendFeedApp)), scroll=host.querySelector('.friend-feed-scroll') as HTMLDivElement;
    const touch=(type:string,x:number,y:number)=>{const e=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:[{clientX:x,clientY:y}]});scroll.dispatchEvent(e);};
    const gesture=async(x:number,y:number,end='touchend')=>{await act(async()=>{touch('touchstart',0,0);touch('touchmove',x,y);touch(end,x,y);await new Promise(r=>setTimeout(r,20));});};
    await gesture(0,40);await gesture(160,100);await gesture(0,120,'touchcancel');scroll.scrollTop=10;await gesture(0,120);
    scroll.scrollTop=0;await act(async()=>{touch('touchstart',0,0);touch('touchmove',0,120);touch('touchmove',0,2);touch('touchend',0,2);});
    expect(refreshFriendFeed).not.toHaveBeenCalled();scroll.scrollTop=0;
    await gesture(0,120);expect(refreshFriendFeed).toHaveBeenCalledTimes(1);
    await click(host,'我的主页');await gesture(0,120);expect(refreshFriendFeed).toHaveBeenCalledTimes(1);
});

it('ignores repeated home taps during refresh and respects another entry refresh lease',async()=>{
    let finish!:(result:{message:string;warnings:string[]})=>void;
    vi.mocked(refreshFriendFeed).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const host=await render(React.createElement(FriendFeedApp));await click(host,'朋友动态');await click(host,'朋友动态');
    expect(refreshFriendFeed).toHaveBeenCalledTimes(1);
    await act(async()=>{finish({message:'刷新完成',warnings:[]});});
    await act(async()=>{await mutateFriendFeed(feed=>{feed.refreshLease={id:'another-window',until:Date.now()+60000};});await new Promise(r=>setTimeout(r,20));});
    await click(host,'朋友动态');expect(refreshFriendFeed).toHaveBeenCalledTimes(1);
});

it('deduplicates the real following list separately and discards it on disconnect, without changing character subscriptions',async()=>{
    const {getProxyWorkerUrl}=await import('./proxyWorker');
    const {disconnectWeibo}=await import('./friendFeedWeibo');
    const session={version:2,origin:window.location.origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]};
    sessionStorage.setItem('sully:weibo-session:v2',JSON.stringify({id:'directory-session',proxy:getProxyWorkerUrl(),uid:'123456',session,expires:session.expires}));
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({session,accounts:[{uid:'222222',name:'真实甲',description:'简介'}],nextPage:2,nextCursor:'20'}))
        .mockResolvedValueOnce(Response.json({session,accounts:[{uid:'222222',name:'真实甲',description:'简介'},{uid:'333333',name:'真实乙',description:''}],nextPage:null,nextCursor:null}));
    vi.stubGlobal('fetch',fetcher);
    await saveWeiboBinding('user','123456',false);
    const host=await render(React.createElement(FriendFeedApp));await click(host,'我的主页');await click(host,'我的关注');expect(fetcher).not.toHaveBeenCalled();
    await click(host,'读取微博关注');await click(host,'更多微博关注');
    const real=host.querySelector('[aria-label="真实微博关注"]')!;expect(real.querySelectorAll('.ff-following-person')).toHaveLength(2);
    expect(real.textContent).not.toContain('小白');expect(host.querySelector('[aria-label="关注的角色"]')?.textContent).not.toContain('真实甲');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({action:'followingAccounts',page:2,cursor:'20'});
    expect((await readFriendFeed()).follows||{}).toEqual({});
    await act(async()=>{disconnectWeibo();});expect(real.querySelectorAll('.ff-following-person')).toHaveLength(0);expect(real.textContent).toContain('连接微博');
});

it.each(['island','moments','insta','journal','weibo','twitter'] as const)('opens local and real posts into full comment threads in %s without generating on navigation',async(theme)=>{
    const circle=await saveFriendCircle({name:'旧圈',description:'',memberIds:m.chars.map(c=>c.id)});
    await publishFriendPost(circle,'小雨','本地帖子');
    await importFriendSource(circle,{platform:'weibo',accountId:'123456',externalId:'111111',url:'https://weibo.com/123456/111111',author:'外部作者',text:'真实帖子',fetchedAt:Date.now(),publishedAt:Date.now(),truncated:false});
    await mutateFriendFeed(feed=>{
        const real=feed.posts.find(p=>p.source)!;
        real.weiboComments={rows:[{id:'777777',authorId:'654321',authorName:'真实网友',text:'原站上的原话',createdAt:Date.now()}],cursor:null,fetchedAt:Date.now()};
        real.comments.push({id:'local-reply',authorId:m.chars[0].id,authorName:'小白',text:'本地的接话',createdAt:Date.now(),sourceReply:{id:'777777',authorName:'真实网友',text:'原站上的原话'}});
    });
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),theme});
    const host=await render(React.createElement(FriendFeedApp));
    for(const text of ['本地帖子','真实帖子']) {
        const post=host.querySelector(`article[aria-label="查看动态评论区：${text}"]`)!;
        await act(async()=>{post.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
        expect(host.querySelector('[aria-label="动态评论区"]')).not.toBeNull();expect(host.querySelector('.ff-detail-original')?.textContent).toContain(text);
        if(text==='真实帖子'){
            const original=host.querySelector('[aria-label="微博原评论"]')!, local=host.querySelector('[aria-label="动态评论区"]')!;
            expect(original.textContent).toContain('原站上的原话');expect(original.textContent).not.toContain('本地的接话');
            expect(local.textContent).toContain('本地的接话');expect(local.querySelector('.ff-source-reply')?.textContent).toContain('真实网友');
            expect(original.textContent).toContain('最近 10 条');
        }
        expect(refreshFriendFeed).not.toHaveBeenCalled();
        await click(host,'写评论');expect(host.querySelector('textarea')).not.toBeNull();await click(host,'取消');
        expect(host.querySelector('.ff-post-detail')).not.toBeNull();await click(host,'返回上一级');
    }
    await click(host,theme==='twitter'?'回复':'评论');await click(host,'刷新评论区');expect(refreshFriendFeed).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refreshFriendFeed).mock.calls[0][5]).toBeTruthy();
});

it.each(['island','moments','insta','journal','weibo','twitter'] as const)('edits and deletes a character comment from %s discussion without a generation call',async theme=>{
    const circle=await saveFriendCircle({name:'预览',description:'',memberIds:m.chars.map(c=>c.id)});
    const postId=await publishFriendPost(circle,'小雨','讨论电影');
    await mutateFriendFeed(feed=>{feed.setupSeen=true;feed.posts[0].comments=[{id:'editable',authorId:m.chars[0].id,authorName:'小白',text:'原来的评论',createdAt:1}];});
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),theme});
    const host=await render(React.createElement(FriendFeedApp));
    await act(async()=>requestFriendInbox({postId,commentId:'editable'}));await settle(host);
    vi.mocked(runImmediateFriendReplies).mockClear();
    await click(host,'编辑小白的评论');
    const input=host.querySelector('textarea')!;expect(input.value).toBe('原来的评论');expect(input.maxLength).toBe(2000);
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'修改后的评论');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await click(host,'保存修改');expect(host.querySelector('.ff-post-detail')?.textContent).toContain('修改后的评论');
    await click(host,'删除小白的评论');await click(host,'取消');expect((await readFriendFeed()).posts[0].comments).toHaveLength(1);
    await click(host,'删除小白的评论');await click(host,'确认删除');expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
    expect(host.querySelector('.ff-post-detail')).not.toBeNull();expect(runImmediateFriendReplies).not.toHaveBeenCalled();
});
