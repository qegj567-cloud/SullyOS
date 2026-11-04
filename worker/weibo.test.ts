import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
// @ts-expect-error Worker runtime JavaScript.
import {handleWeibo,readWeiboSession,weiboPageUid,normalizeWeiboPost,weiboImages,handleWeiboImage} from './weibo.js';
const origin='https://app.test';
const env={};
it('reads newest comments through a fixed GET, preserves large cursor IDs and rejects write actions',async()=>{

    const session=readWeiboSession({version:2,origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]},origin);
    const fetcher=vi.fn().mockResolvedValue(new Response('{"ok":1,"max_id":99999999999999999,"data":[{"id":88888888888888888,"created_at":"2026-10-20T12:00:00Z","text":"<b>原评论</b>","user":{"idstr":"654321","screen_name":"作者","private":"secret"},"comments":[{"idstr":"77777777","created_at":"2026-10-20T13:00:00Z","text_raw":"楼中楼","user":{"idstr":"654322","screen_name":"另一位"}}]}]}'));
    vi.stubGlobal('fetch',fetcher);
    const response=await handleWeibo(request({action:'comments',session,uid:'123456',mid:'11111111'}),env);
    expect(response.status).toBe(200);const data=await response.json();
    expect(data.nextCursor).toBe('99999999999999999');
    expect(data.comments).toHaveLength(2);expect(data.comments[0]).toMatchObject({id:'88888888888888888',text:'原评论'});
    expect(data.comments[1].parentId).toBe('88888888888888888');expect(JSON.stringify(data)).not.toContain('secret');
    const url=new URL(fetcher.mock.calls[0][0]);expect(url.pathname).toBe('/ajax/statuses/buildComments');expect(url.searchParams.get('flow')).toBe('1');
    expect(fetcher.mock.calls[0][1].method).toBeUndefined();fetcher.mockClear();
    for(const body of [{action:'replyComment'},{action:'comments',mid:'https://evil.test',uid:'123456'},{action:'comments',mid:'11111111',uid:'123456',cursor:'evil'}])
        expect((await handleWeibo(request({...body,session}),env)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
});
const request=(body:object,source=origin)=>new Request('https://proxy.test/weibo',{method:'POST',headers:{Origin:source,'Content-Type':'application/json'},body:JSON.stringify(body)});
it('reads ranked followed batches with account-owned list IDs, exact cursors and no chronological fallback',async()=>{
    const session={version:2,origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]};
    const row=(id:string,time:string)=>({idstr:id,user:{idstr:'654321',screen_name:'关注的人'},text_raw:id,created_at:time});
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ok:1,statuses:[row('111111','2026-10-20T12:00:00Z'),row('222222','2026-10-21T12:00:00Z')]}).replace('"ok":1','"since_id":99999999999999999,"ok":1')))
        .mockResolvedValueOnce(Response.json({ok:1,since_id:'part:2=-a',statuses:[row('333333','2026-10-19T12:00:00Z')]}))
        .mockResolvedValueOnce(Response.json({ok:0,msg:'upstream rejected'}));vi.stubGlobal('fetch',fetcher);
    const first=await (await handleWeibo(request({action:'home',session}),{})).json();
    expect(first.posts.map((p:any)=>p.externalId)).toEqual(['111111','222222']);expect(first.nextCursor).toBe('99999999999999999');
    const url=new URL(fetcher.mock.calls[0][0]);expect(url.pathname).toBe('/ajax/feed/unreadfriendstimeline');
    expect(Object.fromEntries(url.searchParams)).toEqual({list_id:'10001123456',refresh:'4',since_id:'0',count:'25'});
    const next=await (await handleWeibo(request({action:'home',session,cursor:first.nextCursor}),{})).json();expect(next.nextCursor).toBe('part:2=-a');
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('since_id')).toBe(first.nextCursor);
    expect((await handleWeibo(request({action:'home',session}),{})).status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for(const extra of [{uid:'654321'},{cursor:'x&target=evil'},{cursor:'x'.repeat(513)}])expect((await handleWeibo(request({action:'home',session,...extra}),{})).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(3);
});
afterEach(()=>vi.unstubAllGlobals());
it('relays only public raster images without forwarding credentials and blocks redirects and oversized responses',async()=>{
    const req=(url:string)=>new Request('https://proxy.test/weibo-image?url='+encodeURIComponent(url),{headers:{Cookie:'private',Authorization:'secret'}});
    const fetcher=vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg'}}));vi.stubGlobal('fetch',fetcher);
    const response=await handleWeiboImage(req('https://wx1.sinaimg.cn/large/test.jpg'));
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1,2,3]);
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Cookie');expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    expect((await handleWeiboImage(req('https://127.0.0.1/private'))).status).toBe(400);
    fetcher.mockResolvedValueOnce(new Response('',{status:302,headers:{Location:'https://evil.test/pixel'}}));
    expect((await handleWeiboImage(req('https://wx1.sinaimg.cn/a.jpg'))).status).toBe(400);
    expect(fetcher.mock.calls.some(([url])=>url.includes('evil.test'))).toBe(false);
    fetcher.mockResolvedValueOnce(new Response('<svg/>',{headers:{'Content-Type':'image/svg+xml'}}));
    expect((await handleWeiboImage(req('https://wx1.sinaimg.cn/a.jpg'))).status).toBe(502);
    fetcher.mockResolvedValueOnce(new Response('x',{headers:{'Content-Type':'image/jpeg','Content-Length':String(13*1024*1024)}}));
    expect((await handleWeiboImage(req('https://wx1.sinaimg.cn/a.jpg'))).status).toBe(413);
});
it('extracts ordered photos including quoted posts, excludes video and unsafe image hosts, and caps the result',()=>{
    const pic=(id:string)=>({largest:{url:`https://wx1.sinaimg.cn/large/${id}.jpg`},bmiddle:{url:`http://wx1.sinaimg.cn/bmiddle/${id}.jpg`}});
    expect(weiboImages({pic_ids:['b','a'],pic_infos:{a:pic('a'),b:pic('b')},mix_media_info:{items:[{type:'pic',data:pic('a')},{type:'video',data:pic('v')}]},
        retweeted_status:{pics:[pic('c'),{url:'https://wx1.sinaimg.cn.evil.test/1.jpg'},{url:'https://user:secret@wx1.sinaimg.cn/1.jpg'},{url:'data:image/png,test'}]}}))
        .toEqual(['b','a','c'].map(id=>({url:`https://wx1.sinaimg.cn/large/${id}.jpg`,thumbnail:`https://wx1.sinaimg.cn/bmiddle/${id}.jpg`})));
    expect(weiboImages({pics:Array.from({length:30},(_,i)=>pic(String(i)))})).toHaveLength(18);
});
it('reads only fixed endpoints with client-owned account credentials and preserves pagination without putting credentials in post data',async()=>{

    const session=readWeiboSession({version:2,origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[{name:'SUB',value:'private-test-cookie',domain:'weibo.com',path:'/',hostOnly:false}]},origin);
    const fetcher=vi.fn().mockResolvedValue(Response.json({ok:1,max_id:'999999',statuses:[{idstr:'11111111',mblogid:'ABCdef',user:{idstr:'123456',screen_name:'作者'},text_raw:'公开文字',created_at:'2026-10-20T12:00:00Z'}]}));
    vi.stubGlobal('fetch',fetcher);
    const response=await handleWeibo(request({action:'following',cursor:'888888',session}),env);
    expect(response.status).toBe(200);const result=await response.json();expect(result.nextCursor).toBe('999999');
    expect(result.session.cookies[0].value).toBe('private-test-cookie');expect(JSON.stringify(result.posts)).not.toContain('private-test-cookie');expect(result.posts[0]).toMatchObject({platform:'weibo',accountId:'123456'});
    expect(fetcher.mock.calls[0][0]).toBe('https://weibo.com/ajax/feed/friendstimeline?count=25&max_id=888888');
    expect(fetcher.mock.calls[0][1].headers.Cookie).toBe('SUB=private-test-cookie');
    expect(response.headers.get('cache-control')).toBe('no-store');
    fetcher.mockClear();
    expect((await handleWeibo(request({action:'publish',session}),env)).status).toBe(400);
    expect((await handleWeibo(request({action:'posts',uid:'https://evil.test',session}),env)).status).toBe(400);
    expect((await handleWeibo(request({action:'posts',session},'https://other.test'),env)).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
});
it('parses only JSON from the homepage',()=>{
    expect(weiboPageUid('<script>window.$CONFIG={"uid":"123456","user":{"name":"a } b"}};window.next=1;</script>')).toBe('123456');
    expect(weiboPageUid('<script>window.$CONFIG={uid:evil()};</script>')).toBe('');
    expect(normalizeWeiboPost({text:'error'})).toBeNull();
});
it('returns the requested real profile and a safe avatar, rejecting another account response',async()=>{
    const session={version:2,origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]};
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({ok:1,data:{user:{idstr:'123456',screen_name:'真实昵称',avatar_hd:'http://tvax1.sinaimg.cn/crop/avatar.jpg',description:'简介',private:'do-not-return'}}}))
        .mockResolvedValueOnce(Response.json({ok:1,data:{user:{idstr:'999999',screen_name:'另一人'}}}));vi.stubGlobal('fetch',fetcher);
    const response=await handleWeibo(request({action:'profile',session}),{});
    expect(response.status).toBe(200);expect((await response.json()).profile).toEqual({uid:'123456',name:'真实昵称',avatar:'https://tvax1.sinaimg.cn/crop/avatar.jpg',description:'简介'});
    expect((await handleWeibo(request({action:'profile',session}),{})).status).toBe(502);
});
it('rejects malformed credentials, injected cookie headers and old encrypted tickets before networking',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const valid={version:2,origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]};
    const cookie={name:'SUB',value:'private-cookie',domain:'weibo.com',path:'/',hostOnly:false};
    for(const session of [null,'old-encrypted-ticket',{...valid,version:1},{...valid,expires:1},
        {...valid,cookies:[{...cookie,value:'a; ADMIN=1'}]}, {...valid,cookies:[{...cookie,name:'SUB\r\nInjected'}]},
        {...valid,cookies:[{...cookie,domain:'evil.test'}]},{...valid,cookies:Array(41).fill(cookie)},
        {...valid,kind:'qr',qrid:'https://evil.test'}]) {
        expect((await handleWeibo(request({action:'posts',session}),{})).status).toBe(401);
    }
    expect((await handleWeibo(request({action:'posts',token:'old-ticket'}),{})).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
});
it('keeps concurrent callers isolated and never retains cookies for a later credential-free request',async()=>{
    const input=(value:string)=>({version:2,origin,kind:'account',uid:'123456',expires:Date.now()+60000,
        cookies:[{name:'SUB',value,domain:'weibo.com',path:'/',hostOnly:false}]});
    const fetcher=vi.fn(async()=>Response.json({ok:1,data:{user:{idstr:'123456',screen_name:'test',description:''}}}));vi.stubGlobal('fetch',fetcher);
    const results=await Promise.all(['user-a','user-b'].map(value=>handleWeibo(request({action:'profile',session:input(value)}),{})));
    expect(results.map(r=>r.status)).toEqual([200,200]);
    expect(fetcher.mock.calls.map((call:any)=>call[1].headers.Cookie).sort()).toEqual(['SUB=user-a','SUB=user-b']);
    expect((await results[0].json()).session.cookies[0].value).toBe('user-a');
    expect((await results[1].json()).session.cookies[0].value).toBe('user-b');
    expect((await handleWeibo(request({action:'profile'}),{})).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(2);
});
it('ships a standalone index with no imports or secrets and accepts QR startup with empty env',async()=>{
    const source=readFileSync(new URL('./index.js',import.meta.url),'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toContain('WEIBO_SESSION_SECRET');
    // Load only the copied file's contents: relative dependencies cannot resolve from a data URL.
    const standalone=await import(/* @vite-ignore */ 'data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('signin'))
        .mockResolvedValueOnce(Response.json({retcode:20000000,data:{qrid:'qr-standalone.with-dot',image:'https://v2.qr.weibo.cn/test'}})));
    const response=await standalone.default.fetch(request({action:'start'}),{},{});
    expect(response.status).toBe(200);expect((await response.json()).session).toMatchObject({version:2,kind:'qr',qrid:'qr-standalone.with-dot'});
});

it('reads the logged-in following directory with bounded cursor pagination, never writes or infers accounts from posts',async()=>{

    const session=readWeiboSession({version:2,origin,kind:'account',uid:'123456',expires:Date.now()+60000,cookies:[]},origin);
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({ok:1,data:{follows:{users:[{idstr:'222222',screen_name:'<b>真实账号</b>',description:'简介',private_field:'never-return'}, {idstr:'not-a-uid'}],next_cursor:'20',has_filtered_attentions:true}}}))
        .mockResolvedValueOnce(Response.json({ok:1,data:{follows:{users:[],next_cursor:'20'}}}));vi.stubGlobal('fetch',fetcher);
    const response=await handleWeibo(request({action:'followingAccounts',session,page:1,cursor:''}),env);
    expect(response.status).toBe(200);const result=await response.json();
    expect(result).toMatchObject({accounts:[{uid:'222222',name:'真实账号',description:'简介'}],nextPage:2,nextCursor:'20',filtered:true});expect(JSON.stringify(result)).not.toContain('never-return');
    expect(fetcher.mock.calls[0][0]).toBe('https://weibo.com/ajax/profile/followContent?page=1&next_cursor=&sortType=all');
    const end=await (await handleWeibo(request({action:'followingAccounts',session,page:2,cursor:'20'}),env)).json();expect(end.nextPage).toBeNull();
    fetcher.mockClear();
    for(const params of [{uid:'987654'},{page:201},{cursor:'https://evil.test/?cookie='}])expect((await handleWeibo(request({action:'followingAccounts',session,...params}),env)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
});
it('completes QR login without secrets and never sends cross-domain cookies to unrelated hosts',async()=>{

    const fetcher=vi.fn().mockResolvedValueOnce(new Response('signin',{headers:{'Set-Cookie':'X-CSRF-TOKEN=csrf-test; Path=/; Domain=passport.weibo.com'}}))
        .mockResolvedValueOnce(Response.json({retcode:20000000,data:{qrid:'test-qr',image:'https://v2.qr.weibo.cn/test'}}))
        .mockResolvedValueOnce(Response.json({retcode:20000000,data:{url:'https://weibo.com/login-test'}}))
        .mockResolvedValueOnce(new Response('ok',{headers:{'Set-Cookie':'SUB=private-test-cookie; Path=/; Domain=.weibo.com'}}))
        .mockResolvedValueOnce(new Response('<script>window.$CONFIG={"uid":"123456"};</script>'));
    vi.stubGlobal('fetch',fetcher);
    const start=await (await handleWeibo(request({action:'start'}),env)).json();expect(start.phase).toBe('waiting');
    const login=await (await handleWeibo(request({action:'poll',session:start.session}),env)).json();
    expect(login).toMatchObject({phase:'connected',uid:'123456'});expect(login.session.cookies.some((c:any)=>c.value==='private-test-cookie')).toBe(true);
    expect(fetcher.mock.calls[3][1].headers.Cookie).toBeUndefined();
    expect(fetcher.mock.calls[4][1].headers.Cookie).toBe('SUB=private-test-cookie');
    const sealed=readWeiboSession(login.session,origin);expect(sealed.kind).toBe('account');
    fetcher.mockResolvedValueOnce(new Response('',{status:302,headers:{Location:'https://evil.test/steal'}}));
    const blocked=await handleWeibo(request({action:'profile',session:login.session}),env);expect(blocked.status).toBe(502);
    expect(fetcher.mock.calls.some(([url])=>String(url).includes('evil.test'))).toBe(false);
    expect((await handleWeibo(request({action:'start',padding:'x'.repeat(30000)}),env)).status).toBe(413);
});
