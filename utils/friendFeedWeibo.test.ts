// @vitest-environment jsdom
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {DB} from './db';
import {saveFriendCircle,readFriendFeed,publishFriendPost,saveFriendFollows,friendPostsForCharacter,mutateFriendFeed} from './friendFeed';
import {saveWeiboBinding,syncWeibo,syncMyWeibo,syncWeiboOwnPosts,syncWeiboHome,saveWeiboHomeMode,readWeiboHomePage,weiboSyncMessage,syncWeiboComments,disconnectWeibo,readWeiboConnection,fetchWeibo,parseWeiboUid,setWeiboStream,saveWeiboSyncLimit,startWeiboLogin,pollWeiboLogin} from './friendFeedWeibo';
import {recentSourceComments} from './friendFeedSourceComments';
import {setProxyWorkerUrlOverride} from './proxyWorker';
import {prepareFriendFeedMainTask,consumeFriendFeedMainReply} from './friendFeedMain';
import {acknowledgeFriendFeedNotices,releaseFriendFeedEmotionTask,prepareFriendFeedEmotionTask,landFriendFeedEmotionAction,stageFriendFeedCloudTask,settleFriendFeedCloudTask} from './friendFeedEmotion';
import type {CharacterProfile} from '../types';
import {isFriendFeedSource,sourceContext} from './friendFeedSource';
const a={id:'wb-a',name:'小白',memories:[]} as unknown as CharacterProfile;
const b={id:'wb-b',name:'小绿',memories:[]} as unknown as CharacterProfile;
let circle:string;
const session=()=>({version:2,origin:window.location.origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[{name:'SUB',value:'private-browser-cookie',domain:'weibo.com',path:'/',hostOnly:false}]});
const connection=()=>{const local=session();sessionStorage.setItem('sully:weibo-session:v2',JSON.stringify({id:'test-connection',proxy:'https://proxy.test',uid:'123456',session:local,expires:local.expires}));};
const post=(id:string,at=Date.now()-10000)=>({platform:'weibo',accountId:'123456',externalId:id,url:`https://weibo.com/123456/${id}`,author:'原账号',text:'今天的咖啡',publishedAt:at,fetchedAt:Date.now(),truncated:false});
beforeEach(async()=>{vi.restoreAllMocks();localStorage.clear();sessionStorage.clear();setProxyWorkerUrlOverride('https://proxy.test');
    await DB.deleteDB();await DB.saveCharacter(a);await DB.saveCharacter(b);await DB.saveUserProfile({name:'小雨'} as any);
    circle=await saveFriendCircle({name:'客厅',description:'',memberIds:[a.id,b.id],realContentEnabled:true});connection();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();setProxyWorkerUrlOverride(null);});
it('keeps scanned credentials only in browser session storage, sends them in POST bodies and clears them on disconnect',async()=>{
    disconnectWeibo();const account=session(),qr={...account,kind:'qr',uid:undefined,qrid:'test-qr.with-dot',expires:Date.now()+240000};
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({phase:'waiting',image:'https://v2.qr.weibo.cn/test',session:qr}))
        .mockResolvedValueOnce(Response.json({phase:'connected',uid:account.uid,expires:account.expires,session:account}))
        .mockResolvedValueOnce(Response.json({session:account,profile:{uid:account.uid,name:'我',description:''}}));
    vi.stubGlobal('fetch',fetcher);
    const pending=await startWeiboLogin();expect(readWeiboConnection()).toBeUndefined();
    await pollWeiboLogin(pending);expect(readWeiboConnection()?.session.cookies[0].value).toBe('private-browser-cookie');
    await fetchWeibo('profile');
    expect(JSON.parse(fetcher.mock.calls[2][1].body).session).toEqual(account);
    for(const [url,options] of fetcher.mock.calls){
        expect(url).toBe('https://proxy.test/weibo');expect(options).toMatchObject({method:'POST',credentials:'omit',cache:'no-store',redirect:'error'});
    }
    expect(JSON.stringify(await readFriendFeed())).not.toContain('private-browser-cookie');
    expect(Object.values(localStorage).join('')).not.toContain('private-browser-cookie');
    disconnectWeibo();expect(sessionStorage.getItem('sully:weibo-session:v2')).toBeNull();
    expect(readWeiboConnection()).toBeUndefined();
});
it('retires encrypted v1 sessions and rejects old proxies without leaking old tickets',async()=>{
    disconnectWeibo();sessionStorage.setItem('sully:weibo-session:v1',JSON.stringify({token:'old-private-ticket'}));
    const fetcher=vi.fn().mockResolvedValue(Response.json({phase:'waiting',image:'https://v2.qr.weibo.cn/test',token:'old-returned-ticket'}));vi.stubGlobal('fetch',fetcher);
    expect(readWeiboConnection()).toBeUndefined();expect(sessionStorage.getItem('sully:weibo-session:v1')).toBeNull();
    await expect(fetchWeibo('profile')).rejects.toThrow('先连接');expect(fetcher).not.toHaveBeenCalled();
    await expect(startWeiboLogin()).rejects.toThrow('更新当前代理');
    expect(fetcher.mock.calls[0][1].body).toBe(JSON.stringify({action:'start'}));
});
it.each([10000,-600000])('accepts QR login with proxy clock skew %i ms and expires locally without extending on reads',async skew=>{
    disconnectWeibo();const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
    const day=24*60*60*1000,account={...session(),expires:now+day+skew};
    const qr={...account,kind:'qr',uid:undefined,qrid:'clock-skew-qr',expires:now+240000+skew};
    const fetcher=vi.fn()
        .mockResolvedValueOnce(Response.json({phase:'waiting',image:'https://v2.qr.weibo.cn/test',session:qr}))
        .mockResolvedValueOnce(Response.json({phase:'connected',uid:account.uid,expires:account.expires,session:account}))
        .mockResolvedValueOnce(Response.json({session:account,profile:{uid:account.uid,name:'我',description:''}}));
    vi.stubGlobal('fetch',fetcher);
    const pending=await startWeiboLogin();
    await pollWeiboLogin(pending);
    expect(readWeiboConnection()).toMatchObject({uid:account.uid,expires:now+day,session:{expires:account.expires}});
    vi.mocked(Date.now).mockReturnValue(now+60000);
    await fetchWeibo('profile');
    expect(JSON.parse(fetcher.mock.calls[2][1].body).session.expires).toBe(account.expires);
    expect(readWeiboConnection()?.expires).toBe(now+day);
    vi.mocked(Date.now).mockReturnValue(now+day);
    expect(readWeiboConnection()).toBeUndefined();
    expect(sessionStorage.getItem('sully:weibo-session:v2')).toBeNull();
    await expect(fetchWeibo('profile')).rejects.toThrow('先连接');
    expect(fetcher).toHaveBeenCalledTimes(3);
});
it('rejects malformed v2 sessions without incorrectly asking for a proxy update',async()=>{
    disconnectWeibo();
    for(const change of [{origin:'https://another.test'},{uid:'invalid'},{expires:0},{cookies:[{name:'SUB',value:'private-browser-cookie'}]}]){
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({session:{...session(),...change}})));
        await expect(startWeiboLogin()).rejects.toThrow('会话信息不完整或与当前页面不符');
        expect(readWeiboConnection()).toBeUndefined();
    }
});
it('keeps existing v2 retention deadlines and rejects expired or unbounded local credentials',()=>{
    const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);connection();
    expect(readWeiboConnection()?.expires).toBe(now+60000);
    const stored=JSON.parse(sessionStorage.getItem('sully:weibo-session:v2')!);
    for(const expires of [now,now-1,now+24*60*60*1000+1,null,'forever']){
        sessionStorage.setItem('sully:weibo-session:v2',JSON.stringify({...stored,expires}));
        expect(readWeiboConnection()).toBeUndefined();
        expect(sessionStorage.getItem('sully:weibo-session:v2')).toBeNull();
    }
});
it('does not accept a late QR confirmation after disconnect or a different account returned by a read',async()=>{
    disconnectWeibo();const account=session(),qr={...account,kind:'qr',uid:undefined,qrid:'test-qr',expires:Date.now()+240000};
    let finish!:(response:Response)=>void;
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({phase:'waiting',image:'https://v2.qr.weibo.cn/test',session:qr}))
        .mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetcher);
    const login=await startWeiboLogin(),pending=pollWeiboLogin(login);disconnectWeibo();
    finish(Response.json({phase:'connected',uid:account.uid,expires:account.expires,session:account}));
    await expect(pending).rejects.toThrow('变化');expect(readWeiboConnection()).toBeUndefined();
    connection();fetcher.mockResolvedValueOnce(Response.json({session:{...session(),uid:'987654'}}));
    await expect(fetchWeibo('profile')).rejects.toThrow('账号不匹配');expect(readWeiboConnection()?.uid).toBe('123456');
});
const original=(n:number)=>({id:String(700000+n),authorId:'987654',authorName:'原评论者',text:`原话${n}`,createdAt:Date.now()-60000+n});
it('keeps recommended order, resets refresh cursors and invalidates late imports when switching modes',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({session:session(),posts:[{...post('111111'),publishedAt:Date.now()-20000},post('222222')],nextCursor:'rank:2'}));vi.stubGlobal('fetch',fetcher);
    const first=await readWeiboHomePage(circle,'default');
    expect(first.posts.map(p=>p.externalId)).toEqual(['111111','222222']);
    expect((await readFriendFeed()).weiboStreams?.[0].cursor).toBe('rank:2');
    let finish!:(r:Response)=>void;fetcher.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
    const pending=readWeiboHomePage(circle,'default');
    const rejected=expect(pending).rejects.toThrow('来源绑定已变化');
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));await saveWeiboHomeMode('latest');
    finish(Response.json({session:session(),posts:[post('333333')],nextCursor:'rank:3'}));await rejected;
    expect((await readFriendFeed()).posts.some(p=>p.source?.externalId==='333333')).toBe(false);
    expect((await readFriendFeed()).weiboStreams?.[0].cursor).toBe('0');
    fetcher.mockResolvedValueOnce(Response.json({session:session(),posts:[post('444444')],nextCursor:'555555'}));
    await readWeiboHomePage(circle,'latest');expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toMatchObject({action:'following',cursor:'0'});
    await saveWeiboHomeMode('default');fetcher.mockResolvedValueOnce(Response.json({session:session(),posts:[],nextCursor:null}));
    await readWeiboHomePage(circle,'default');expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toMatchObject({action:'home',cursor:'0'});
});
it('restores own posts without a profile API dependency and preserves custom or disabled bindings',async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({session:session(),posts:[post('111111')],nextPage:null}));vi.stubGlobal('fetch',fetcher);
    await syncWeiboOwnPosts(circle);expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({action:'posts',uid:'123456'});
    expect((await readFriendFeed()).posts[0].authorId).toBe('user');
    await saveWeiboBinding('user','777777',false);fetcher.mockClear();
    await expect(syncWeiboOwnPosts(circle)).rejects.toThrow('先开启');expect(fetcher).not.toHaveBeenCalled();
    await saveWeiboBinding('user','777777');fetcher.mockResolvedValueOnce(Response.json({session:session(),posts:[],nextPage:null}));
    await syncWeiboOwnPosts(circle);expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({action:'posts',uid:'777777'});
});
it('keeps disabled streams disabled while browsing and never restores deleted imports',async()=>{
    await setWeiboStream(circle,false);
    const fetcher=vi.fn(async()=>Response.json({session:session(),posts:[post('111111')],nextCursor:null}));vi.stubGlobal('fetch',fetcher);
    expect((await readWeiboHomePage(circle,'default')).posts).toHaveLength(1);expect((await readFriendFeed()).posts).toHaveLength(0);
    await setWeiboStream(circle,true);await mutateFriendFeed(f=>{f.hiddenSources=[`${circle}:weibo:123456:111111`];});
    expect((await readWeiboHomePage(circle,'default')).posts).toHaveLength(0);expect((await readFriendFeed()).posts).toHaveLength(0);
});
it('defaults to the followed home timeline and leaves personal and RP homepage bindings untouched',async()=>{
    await saveWeiboBinding(a.id,'777777');
    const fetcher=vi.fn(async(_url,options)=>Response.json(JSON.parse(options.body).action==='profile'
        ?{session:session(),profile:{uid:'123456',name:'真实微博名',avatar:'https://tvax1.sinaimg.cn/crop/avatar.jpg',description:''}}
        :{session:session(),posts:[{...post('111111'),accountId:'654321',author:'关注的人',url:'https://weibo.com/654321/111111'}],nextCursor:'888888'}));vi.stubGlobal('fetch',fetcher);
    expect(await syncWeiboHome(circle)).toMatchObject({received:1,added:1});
    const feed=await readFriendFeed();
    expect(fetcher.mock.calls.map(([,o])=>JSON.parse(o.body).action)).toEqual(['profile','home']);
    expect(feed.settings?.weiboProfile?.name).toBe('真实微博名');
    expect(feed.weiboStreams).toEqual([expect.objectContaining({circleId:circle,enabled:true,cursor:'888888'})]);
    expect(feed.weiboBindings).toEqual([expect.objectContaining({ownerId:a.id,uid:'777777'})]);
    expect(feed.posts[0]).toMatchObject({authorId:'weibo:654321',authorName:'关注的人'});
});
it('still reads the home timeline when profile retrieval fails, and reports the partial failure',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({error:'该微博主页不可读取'},{status:502}))
        .mockResolvedValueOnce(Response.json({session:session(),posts:[post('111111')],nextCursor:null}));vi.stubGlobal('fetch',fetcher);
    expect(await syncWeiboHome(circle)).toMatchObject({received:1,added:1,profileError:'该微博主页不可读取'});
    expect((await readFriendFeed()).settings?.weiboProfile).toBeUndefined();
    expect(fetcher.mock.calls.map(([,o])=>JSON.parse(o.body).action)).toEqual(['profile','home']);
});
it('reads the scanned profile and own posts, stores no credentials and reports deduplication and empty upstream pages',async()=>{
    let posts=[post('111111')];
    const fetcher=vi.fn(async(_url,options)=>Response.json(JSON.parse(options.body).action==='profile'
        ?{session:session(),profile:{uid:'123456',name:'真实微博名',avatar:'https://tvax1.sinaimg.cn/crop/avatar.jpg',description:''}}
        :{session:session(),posts,nextPage:null}));vi.stubGlobal('fetch',fetcher);
    expect(await syncMyWeibo(circle)).toEqual({received:1,added:1,existing:0,hidden:0});
    const feed=await readFriendFeed();
    expect(feed.settings?.weiboProfile).toEqual({uid:'123456',name:'真实微博名',avatar:'https://tvax1.sinaimg.cn/crop/avatar.jpg'});
    expect(feed.weiboBindings).toEqual([expect.objectContaining({ownerId:'user',uid:'123456',enabled:true})]);
    expect(feed.posts[0]).toMatchObject({authorId:'user',authorName:'真实微博名',text:'今天的咖啡'});
    expect(JSON.stringify(feed)).not.toContain('private-browser-cookie');
    expect((await DB.getUserProfile())?.name).toBe('小雨');
    expect(weiboSyncMessage(await syncMyWeibo(circle))).toContain('新增 0 条，已有 1 条');
    posts=[];expect(weiboSyncMessage(await syncMyWeibo(circle))).toContain('返回 0 条');
    expect((await readFriendFeed()).posts).toHaveLength(1);
});
it('surfaces profile and posts failures without importing placeholders or losing the scanned login',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({error:'微博要求重新验证'},{status:502}));vi.stubGlobal('fetch',fetcher);
    await expect(syncMyWeibo(circle)).rejects.toThrow('微博要求重新验证');
    expect((await readFriendFeed()).settings?.weiboProfile).toBeUndefined();
    fetcher.mockResolvedValueOnce(Response.json({session:session(),profile:{uid:'123456',name:'真实微博名',description:''}}))
        .mockResolvedValueOnce(Response.json({error:'微博列表暂时不可读取'},{status:502}));
    await expect(syncMyWeibo(circle)).rejects.toThrow('微博列表暂时不可读取');
    expect((await readFriendFeed()).posts).toHaveLength(0);expect(readWeiboConnection()?.uid).toBe('123456');
    expect((await readFriendFeed()).settings?.weiboProfile?.name).toBe('真实微博名');
});
it('rejects another account profile instead of overwriting my identity',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({session:session(),profile:{uid:'999999',name:'另一人'}})));
    await expect(syncMyWeibo(circle)).rejects.toThrow('个人资料不完整');
    expect((await readFriendFeed()).settings?.weiboProfile).toBeUndefined();
    expect((await readFriendFeed()).posts).toHaveLength(0);
});
async function importedPost(){
    await saveWeiboBinding(a.id,'123456');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({session:session(),posts:[post('111111')],nextPage:null})));
    await syncWeibo(circle,a.id);return (await readFriendFeed()).posts[0].id;
}
it('syncs bound sources under the public main-account nickname and preserves identity after renaming',async()=>{
    await mutateFriendFeed(f=>{f.settings={...f.settings!,userNickname:'雨点',identities:{[a.id]:{nickname:'白汽水',tags:[],accounts:[]}}};});
    const id=await importedPost();
    expect((await readFriendFeed()).posts[0]).toMatchObject({id,authorId:a.id,accountId:'main',authorName:'白汽水'});
    await mutateFriendFeed(f=>{f.settings!.identities[a.id].nickname='白桃汽水';});
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>Response.json({session:session(),posts:[post('111111')],nextPage:null})));
    await syncWeibo(circle,a.id);
    expect((await readFriendFeed()).posts).toHaveLength(1);
    expect((await readFriendFeed()).posts[0]).toMatchObject({id,authorId:a.id,authorName:'白桃汽水'});
    await saveWeiboBinding('user','123456');
    await syncWeibo(circle,'user');
    expect((await readFriendFeed()).posts.find(p=>p.authorId==='user')).toMatchObject({accountId:'main',authorName:'雨点'});
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
});
it('paginates original comments separately without cards, deduplicates and gives the model only the newest ten',async()=>{
    const id=await importedPost(), rows=Array.from({length:20},(_,i)=>original(i));
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({session:session(),comments:rows,nextCursor:'777777'}))
        .mockResolvedValueOnce(Response.json({session:session(),comments:[rows[0],{...original(21),createdAt:1}],nextCursor:null}));
    vi.stubGlobal('fetch',fetcher);await syncWeiboComments(id);await syncWeiboComments(id,true);
    let target=(await readFriendFeed()).posts[0];expect(target.weiboComments?.rows).toHaveLength(21);expect(target.comments).toHaveLength(0);
    expect(recentSourceComments(target).map(c=>c.id)).toEqual(rows.slice(10).reverse().map(c=>c.id));
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({action:'comments',mid:'111111',cursor:'777777'});
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
    const task=(await prepareFriendFeedEmotionTask(b.id,()=>0))!;
    expect(task.prompt).toContain('replyToSourceCommentId');expect(task.prompt).toContain('原话19');expect(task.prompt).not.toContain('原话9"');
    expect(await landFriendFeedEmotionAction(b.id,{requestId:task.id,kind:'comment',postId:id,comment:'这句说得有趣',replyToSourceCommentId:rows[19].id},'emotion')).toBe(true);
    target=(await readFriendFeed()).posts[0];expect(target.comments[0].sourceReply).toMatchObject({id:rows[19].id,text:'原话19',authorName:'原评论者'});
    const cards=await DB.getMessagesByCharId(b.id,true);expect(cards).toHaveLength(1);expect(cards[0].content).toContain('微博原评论 @原评论者');
    expect(fetcher).toHaveBeenCalledTimes(2);
});
it('rejects forged or changed quote targets and never fetches comments without the real-content grant',async()=>{
    const id=await importedPost();await mutateFriendFeed(f=>{f.posts[0].weiboComments={rows:[original(1)],cursor:null,fetchedAt:Date.now()};});
    const task=(await prepareFriendFeedEmotionTask(b.id,()=>0))!;
    expect(await landFriendFeedEmotionAction(b.id,{requestId:task.id,kind:'comment',postId:id,comment:'伪造引用',replyToSourceCommentId:'700099'},'emotion')).toBe(false);
    const second=(await prepareFriendFeedEmotionTask(b.id,()=>0))!;
    await mutateFriendFeed(f=>{f.posts[0].weiboComments!.rows[0].text='改过的原话';});
    expect(await landFriendFeedEmotionAction(b.id,{requestId:second.id,kind:'comment',postId:id,comment:'迟到回复',replyToSourceCommentId:'700001'},'emotion')).toBe(false);
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await mutateFriendFeed(f=>{f.circles[0].realContentEnabled=false;delete f.posts[0].weiboComments;});
    const closed=await prepareFriendFeedEmotionTask(b.id,()=>0);expect(closed?.prompt).not.toContain('改过的原话');expect(closed?.prompt).not.toContain('"authorName":"原评论者"');expect(fetcher).not.toHaveBeenCalled();
    expect(await DB.getMessagesByCharId(b.id,true)).toHaveLength(0);
});
it('discards original-comment responses after the binding changes or the connection is removed',async()=>{
    const id=await importedPost();
    for(const change of [()=>saveWeiboBinding(a.id,'123456',false),async()=>{disconnectWeibo();}]){
        await saveWeiboBinding(a.id,'123456',true);connection();
        let finish!:(r:Response)=>void;const wait=new Promise<Response>(resolve=>{finish=resolve;});
        const fetcher=vi.fn().mockReturnValue(wait);vi.stubGlobal('fetch',fetcher);
        const pending=syncWeiboComments(id);await vi.waitFor(()=>expect(fetcher).toHaveBeenCalled());await change();
        finish(Response.json({session:session(),comments:[original(1)],nextCursor:null}));
        await expect(pending).rejects.toThrow();expect((await readFriendFeed()).posts[0].weiboComments).toBeUndefined();
    }
});
it('backfills photos without duplicating or notifying and keeps image URLs out of model context',async()=>{
    await saveWeiboBinding(a.id,'123456');
    const source=post('111111'),images=[{url:'https://wx1.sinaimg.cn/large/test.jpg',thumbnail:'https://wx1.sinaimg.cn/bmiddle/test.jpg'}];
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({session:session(),posts:[source],nextPage:2}))
        .mockResolvedValueOnce(Response.json({session:session(),posts:[{...source,images}],nextPage:2})));
    await syncWeibo(circle,a.id);const old=(await readFriendFeed()).posts[0];
    await syncWeibo(circle,a.id);const feed=await readFriendFeed();
    expect(feed.posts).toHaveLength(1);expect(feed.posts[0]).toMatchObject({id:old.id,createdAt:old.createdAt,source:{images}});
    expect(feed.notices||[]).toHaveLength(0);expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
    expect(sourceContext(feed.posts[0].source!)).not.toHaveProperty('images');
    expect(isFriendFeedSource({...source,images:[{url:'https://evil.test/a.jpg',thumbnail:images[0].thumbnail}]})).toBe(false);
});
it('merges a bound RP account as its owner, paginates, deduplicates, and writes no cards on sync',async()=>{
    await saveWeiboBinding(a.id,'https://weibo.com/u/123456');
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({session:session(),posts:[post('111111')],nextPage:2}))
        .mockResolvedValueOnce(Response.json({session:session(),posts:[post('111111'),post('222222')],nextPage:3}));vi.stubGlobal('fetch',fetcher);
    await syncWeibo(circle,a.id);await syncWeibo(circle,a.id,true);
    const feed=await readFriendFeed();expect(feed.posts).toHaveLength(2);expect(feed.posts[0]).toMatchObject({authorId:a.id,authorName:a.name,synced:true});
    expect(feed.notices||[]).toHaveLength(0);expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).page).toBe(2);
    expect(JSON.stringify(feed)).not.toContain('private-browser-cookie');
});
it('new synced posts notify self and followers once, history stays silent and source disable blocks queued actions',async()=>{
    await saveWeiboBinding(a.id,'123456');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({session:session(),posts:[post('111111')],nextPage:2}))
        .mockResolvedValueOnce(Response.json({session:session(),posts:[post('222222',Date.now()+1000)],nextPage:2})));
    await syncWeibo(circle,a.id);await syncWeibo(circle,a.id);
    const task=(await prepareFriendFeedMainTask(a.id))!;expect(task.prompt).toContain('own');expect(task.prompt).toContain('你自己发过');expect(task.prompt).toContain('kind=follow');
    expect(await prepareFriendFeedMainTask(a.id)).toBeUndefined();
    const target=(await readFriendFeed()).posts.find(p=>p.source?.externalId==='222222')!;
    await saveWeiboBinding(a.id,'123456',false);
    expect(friendPostsForCharacter(await readFriendFeed(),a.id)).toHaveLength(0);
    expect(await landFriendFeedEmotionAction(a.id,{requestId:task.id,kind:'comment',postId:target.id,comment:'不错'},'main')).toBe(false);
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
});
it('ordinary new posts use main text operations, own activity cards commit once, and following is local',async()=>{
    const id=await publishFriendPost(circle,'小雨','新日常');
    const task=(await prepareFriendFeedMainTask(a.id))!;
    expect(task.prompt).toContain('FRIEND_FEED_REPLY');expect(task.prompt).toContain('新日常');
    const action={requestId:task.id,kind:'comment',postId:id,comment:'我看到了',followAuthorId:'user',follow:false};
    await consumeFriendFeedMainReply(a.id,'好的\n[[FRIEND_FEED_REPLY:'+JSON.stringify(action)+']]');
    await consumeFriendFeedMainReply(a.id,'[[FRIEND_FEED_REPLY:'+JSON.stringify(action)+']]');
    const feed=await readFriendFeed();expect(feed.posts[0].comments).toHaveLength(1);expect(feed.follows?.[a.id]).not.toContain('user');
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(1);
    await publishFriendPost(circle,'小雨','再发一条');expect(await prepareFriendFeedMainTask(a.id)).toBeUndefined();
});
it('failure releases a notice for retry, success without an action consumes it, and main/emotion do not race',async()=>{
    await publishFriendPost(circle,'小雨','新日常');const task=(await prepareFriendFeedMainTask(a.id))!;
    const emotion=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;expect(emotion.prompt).not.toContain('"text":"新日常"');
    await releaseFriendFeedEmotionTask(a.id,task.id);const retry=(await prepareFriendFeedMainTask(a.id))!;
    expect(retry.id).not.toBe(task.id);await acknowledgeFriendFeedNotices(a.id,retry.id);
    expect(await prepareFriendFeedMainTask(a.id)).toBeUndefined();expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
});
it('does not send the session to a changed proxy or accept a response after disconnect',async()=>{
    let finish!:(response:Response)=>void;const fetcher=vi.fn(()=>new Promise<Response>(r=>{finish=r;}));vi.stubGlobal('fetch',fetcher);
    const pending=fetchWeibo('profile');disconnectWeibo();finish(Response.json({session:session(),profile:{uid:'123456',name:'test'}}));
    await expect(pending).rejects.toThrow('切换');expect(readWeiboConnection()).toBeUndefined();
    connection();setProxyWorkerUrlOverride('https://other.test');await expect(fetchWeibo('profile')).rejects.toThrow('先连接');expect(fetcher).toHaveBeenCalledTimes(1);
    expect(()=>parseWeiboUid('https://weibo.com.evil.test/u/123456')).toThrow();
});
it('keeps the history cursor across refresh and allows increasing the retention limit',async()=>{
    await saveWeiboBinding(a.id,'123456');await saveWeiboSyncLimit(25);
    const fetcher=vi.fn().mockImplementation(async(_url,options)=>{
        const page=JSON.parse(options.body).page;
        return Response.json({session:session(),posts:Array.from({length:10},(_,i)=>post(String(100000+page*10+i))),nextPage:page+1});
    });vi.stubGlobal('fetch',fetcher);
    await syncWeibo(circle,a.id);await syncWeibo(circle,a.id,true);await syncWeibo(circle,a.id);
    expect((await readFriendFeed()).weiboBindings?.[0].page).toBe(3);
    await syncWeibo(circle,a.id,true);expect((await readFriendFeed()).posts).toHaveLength(25);
    await expect(syncWeibo(circle,a.id,true)).rejects.toThrow('保留上限');
    await saveWeiboSyncLimit(50);await syncWeibo(circle,a.id,true);
    expect((await readFriendFeed()).posts).toHaveLength(30);expect((await readFriendFeed()).weiboBindings?.[0].page).toBe(4);
});
it('remaps a previously synchronized following post without duplicating its entry',async()=>{
    await setWeiboStream(circle,true);
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>Response.json({session:session(),posts:[post('111111')],nextPage:2,nextCursor:'222222'})));
    await syncWeibo(circle,'following');const before=(await readFriendFeed()).posts[0];
    expect(before.authorId).toBe('weibo:123456');await saveWeiboBinding(a.id,'123456');await syncWeibo(circle,a.id);
    const feed=await readFriendFeed();expect(feed.posts).toHaveLength(1);expect(feed.posts[0]).toMatchObject({id:before.id,authorId:a.id,authorName:a.name});
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
});
it('settles cloud notifications only for the matching task and retries failed tasks',async()=>{
    await publishFriendPost(circle,'小雨','新日常');const task=(await prepareFriendFeedMainTask(a.id))!;
    await stageFriendFeedCloudTask(a.id,task.id,'cloud-one');await settleFriendFeedCloudTask(a.id,'wrong-task',true);
    expect((await readFriendFeed()).notices?.find(n=>n.charId===a.id)?.lease?.id).toBe(task.id);
    await settleFriendFeedCloudTask(a.id,'cloud-one',false);const retry=(await prepareFriendFeedMainTask(a.id))!;
    expect(retry.id).not.toBe(task.id);await stageFriendFeedCloudTask(a.id,retry.id,'cloud-two');
    await settleFriendFeedCloudTask(a.id,'cloud-one',true);expect(await prepareFriendFeedMainTask(a.id)).toBeUndefined();
    await settleFriendFeedCloudTask(a.id,'cloud-two',true);expect(await prepareFriendFeedMainTask(a.id)).toBeUndefined();
    expect((await readFriendFeed()).notices?.find(n=>n.charId===a.id)?.done).toBe(true);
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
});
it('rejects malformed source dates without damaging saved feed data',async()=>{
    await saveWeiboBinding('user','123456');const malformed={...post('111111'),publishedAt:undefined};
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({session:session(),posts:[malformed]}))
        .mockResolvedValueOnce(Response.json({session:session(),posts:[post('111111')],nextPage:2}));vi.stubGlobal('fetch',fetcher);
    await expect(syncWeibo(circle,'user')).rejects.toThrow('格式');expect((await readFriendFeed()).posts).toHaveLength(0);
    await syncWeibo(circle,'user');expect((await readFriendFeed()).posts[0].authorName).toBe('小雨');
});
