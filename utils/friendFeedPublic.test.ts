import {beforeEach, expect, it, vi} from 'vitest';
import {DB} from './db';
import {ensurePublicFriendFeed, friendPostsForCharacter, mutateFriendFeed, publishFriendPost, readFriendFeed, saveFriendCircle, saveFriendFeedSettings} from './friendFeed';
import {defaultFriendFeedSettings, resolveFriendFeedSettings} from './friendFeedSettings';
import {prepareFriendFeedEmotionTask, landFriendFeedEmotionAction} from './friendFeedEmotion';
import {refreshFriendFeed, weightedFriendPick} from './friendFeedRefresh';
import {safeFetchJson} from './safeApi';
import {syncWeibo,syncWeiboHome,readWeiboConnection} from './friendFeedWeibo';
import type {CharacterProfile, APIConfig, UserProfile} from '../types';
import {friendCommentPool} from './friendFeedCommunity';
import {saveFriendFeedApi, resolveFriendFeedApi} from './friendFeedApi';

vi.mock('./safeApi', async original => ({...await original<typeof import('./safeApi')>(), safeFetchJson: vi.fn()}));
vi.mock('./friendFeedWeibo', async original => ({...await original<typeof import('./friendFeedWeibo')>(),syncWeibo: vi.fn(),syncWeiboHome:vi.fn(), readWeiboConnection: vi.fn(), syncWeiboComments: vi.fn()}));
const a = {id: 'public-a', name: '阿白', systemPrompt: '只有阿白的设定', memories: [], mountedWorldbooks: [],
    contextRangePolicyVersion: 1, contextRangeMode: 'manual', contextLimit: 20} as unknown as CharacterProfile;
const b = {...a, id: 'public-b', name: '阿绿', systemPrompt: '只有阿绿的设定'};
const user = {name: '小雨'} as UserProfile;
const api = {baseUrl: 'https://example.invalid/v1', model: 'test', apiKey: ''} as APIConfig;
beforeEach(async () => {
    vi.mocked(safeFetchJson).mockReset(); vi.mocked(syncWeibo).mockReset();
    vi.mocked(readWeiboConnection).mockReset();vi.mocked(syncWeiboHome).mockReset();
    await DB.deleteDB(); localStorage.clear();
    await DB.saveCharacter(a); await DB.saveCharacter(b); await DB.saveUserProfile(user);
});
async function publicSettings(patch: Partial<ReturnType<typeof defaultFriendFeedSettings>> = {}) {
    await ensurePublicFriendFeed();
    await saveFriendFeedSettings({...defaultFriendFeedSettings(), characterWeights: {[a.id]: 10, [b.id]: 0},
        contentWeights: {self: 100, related: 0, stranger: 0}, ...patch});
}
function reply(action: object) {return {choices: [{message: {content: JSON.stringify({friendFeedAction: action})}}]};}
function response(action: object) {
    vi.mocked(safeFetchJson).mockImplementation(async (_url, init) => {
        const body = JSON.parse(init!.body as string), text = JSON.stringify(body.messages);
        const id = /\\"requestId\\":\\"([^"\\]+)\\"/.exec(text)![1];
        return reply({requestId: id, ...action});
    });
}
it.each(['main','evening'])('publishes a manual refresh when the model echoes its own public %s account ID',async accountId=>{
    await publicSettings({identities:{[a.id]:{nickname:'白桃汽水',tags:[],accounts:[{id:'evening',name:'晚间茶话',purpose:'日常',tags:[]}]}}});
    const feed=await readFriendFeed(),id=feed.accountGraph!.accounts.find(r=>r.ownerId===a.id&&r.accountId===accountId)!.id;
    response({kind:'post',accountId:id,text:'傍晚把窗台收拾好了'});
    const result=await refreshFriendFeed(user,api,undefined,undefined,()=>0);
    expect(result.message).toBe('新动态已送达');expect(safeFetchJson).toHaveBeenCalledTimes(1);
    expect((await readFriendFeed()).posts[0]).toMatchObject({authorId:a.id,accountId,authorName:accountId==='main'?'白桃汽水':'晚间茶话'});
});
it('uses the saved app API atomically for refresh, honors stream/temperature and keeps credentials out of material',async()=>{
    await publicSettings();
    const charApi={...api,model:'character-model',apiKey:'character-secret'};
    await DB.saveCharacter({...a,dialogueApi:charApi});
    const appApi={baseUrl:'https://bibi.invalid/v1',model:'bibi-model',apiKey:'',stream:true,temperature:.4};
    await saveFriendFeedApi(appApi);
    response({kind:'post',text:'独立接口发来的日常'});
    await refreshFriendFeed(user,api,undefined,undefined,()=>0);
    const [url,init]=vi.mocked(safeFetchJson).mock.calls[0];
    expect(url).toBe('https://bibi.invalid/v1/chat/completions');
    expect(init!.headers).toMatchObject({Authorization:'Bearer sk-none'});
    const body=JSON.parse(String(init!.body));
    expect(body).toMatchObject({model:'bibi-model',stream:true,temperature:.4});
    expect(JSON.stringify(body.messages)).not.toContain('character-secret');
    expect(JSON.stringify(await readFriendFeed())).not.toContain('bibi-model');
    expect((await DB.getMessagesByCharId(a.id,true))[0].type).toBe('friend_feed_card');
    await saveFriendFeedApi(null);
    expect((await resolveFriendFeedApi(api,{...a,dialogueApi:charApi})).model).toBe('character-model');
    expect((await resolveFriendFeedApi(api,a)).model).toBe('test');
});
it.each([{count:2,kind:'self'}, {count:5,kind:'self'}, {count:5,kind:'stranger'}] as const)(
    'refreshes a $count-post $kind batch in one request, keeping NPC posts out of personal cards', async ({count,kind}) => {
        await publicSettings({contentWeights:defaultFriendFeedSettings().contentWeights});
        const rolls=[0,kind==='self'?0:.99,count===2?0:.99];
        const npcCount=count-(kind==='self'?1:0);
        response({kind:kind==='self'?'post':'none',text:kind==='self'?'本人新动态':undefined,
            npcActions:Array.from({length:npcCount},(_,i)=>({kind:'post',name:`新路人${i}`,text:`独立生活${i}`}))});
        await refreshFriendFeed(user,api,undefined,undefined,()=>rolls.shift()??0);
        expect(safeFetchJson).toHaveBeenCalledTimes(1);
        const feed=await readFriendFeed();expect(feed.posts).toHaveLength(count);
        expect(feed.posts.filter(p=>p.authorKind==='npc')).toHaveLength(npcCount);
        expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(kind==='self'?1:0);
        const prompt=JSON.stringify(vi.mocked(safeFetchJson).mock.calls[0]);
        expect(prompt).toContain(`本轮目标生成 ${count}`);
        // The larger homepage batch must not increase the ambient browsing quota.
        const ambient=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
        expect(await landFriendFeedEmotionAction(a.id,{requestId:ambient.id,kind:'none',npcActions:
            Array.from({length:4},(_,i)=>({kind:'post',name:`另路人${i}`,text:'不应出现'}))},'emotion')).toBe(false);
    });
it('keeps a homepage refresh to the author when fictional contacts are disabled',async()=>{
    await publicSettings({contentWeights:defaultFriendFeedSettings().contentWeights});
    await DB.saveCharacter({...a,phoneState:{allowFictionalContacts:false}} as CharacterProfile);
    response({kind:'post',text:'只由本人发帖'});
    await refreshFriendFeed(user,api,undefined,undefined,()=>0);
    expect((await readFriendFeed()).posts).toHaveLength(1);
    expect(JSON.stringify(vi.mocked(safeFetchJson).mock.calls[0])).toContain('本轮目标生成 1 条');
});
it('merges old groups once, preserving posts, tombstones and conservative real-content grants', async () => {
    const left = await saveFriendCircle({name: '古代', description: '旧背景', memberIds: [a.id], realContentEnabled: true});
    const right = await saveFriendCircle({name: '现代', description: '', memberIds: [b.id]});
    const post = await publishFriendPost(left, user.name, '公开动态');
    await publishFriendPost(right, user.name, '另一位的公开动态');
    await mutateFriendFeed(f => {f.hiddenSources = [`${left}:user:123`]; f.weiboStreams = [{circleId: left, enabled: true, since: 20, generation: 'old'}];});
    await ensurePublicFriendFeed(); await ensurePublicFriendFeed();
    const feed = await readFriendFeed();
    expect(feed.circles).toHaveLength(1); expect(feed.archivedCircles).toHaveLength(2);
    expect(feed.posts[0].id).toBe(post); expect(friendPostsForCharacter(feed, b.id)).toHaveLength(2);
    expect(feed.circles[0].realContentEnabled).toBe(false); expect(feed.hiddenSources).toEqual(['public:user:123']);
    expect(feed.weiboStreams?.[0]).toMatchObject({circleId: 'public', enabled: true, initialized: false});
    const c = {...a, id: 'public-new'}; await DB.saveCharacter(c);
    expect(friendPostsForCharacter(await readFriendFeed(), c.id)).toHaveLength(2);
    expect(await DB.getMessagesByCharId(a.id, true)).toHaveLength(0);
});
it('weights exclude zeros and invalid values, and account normalization caps at three unique aliases', () => {
    expect(weightedFriendPick([{value: 'off', weight: 0}], () => 0)).toBeUndefined();
    expect(weightedFriendPick([{value: 'off', weight: 0}, {value: 'a', weight: 1}, {value: 'b', weight: 3}], () => .5)).toBe('b');
    const settings = resolveFriendFeedSettings({identities: {[a.id]: {tags: ['咖啡', '咖啡'], accounts: Array.from({length: 5}, (_, i) => ({id: String(i), name: '号' + i, purpose: '', tags: []}))}}, characterWeights: {[a.id]: -1}});
    expect(settings.identities[a.id].accounts).toHaveLength(3); expect(settings.identities[a.id].tags).toEqual(['咖啡']); expect(settings.characterWeights[a.id]).toBe(0);
});
it('refreshes enabled Weibo first, calls only the rolled character with own context, and remembers its chosen account', async () => {
    await publicSettings({identities: {[a.id]: {tags: ['咖啡师'], accounts: [{id: 'work', name: '今日营业', purpose: '职业号，只发咖啡工作', tags: ['咖啡']}]}}});
    await DB.saveMessage({charId: a.id, role: 'user', type: 'text', content: '只给阿白的秘密原文', timestamp: Date.now()});
    await DB.saveMessage({charId: b.id, role: 'user', type: 'text', content: '只给阿绿的秘密原文', timestamp: Date.now()});
    await mutateFriendFeed(f => {f.weiboBindings = [{ownerId: 'user', uid: '123456', enabled: true, generation: 'g', since: 0}];});
    const order: string[] = [];
    vi.mocked(syncWeibo).mockImplementation(async () => {order.push('weibo'); await publishFriendPost('public', user.name, '微博已到达');return {received:1,added:1,existing:0,hidden:0};});
    response({kind: 'post', accountId: 'work', text: '今天研磨调细了一格。'});
    const result = await refreshFriendFeed(user, api, undefined, status => order.push(status), () => 0);
    expect(order.slice(0, 3)).toEqual(['正在刷新微博…', 'weibo', '已读取 1 条微博，新增 1 条']);
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(JSON.parse(vi.mocked(safeFetchJson).mock.calls[0][1]!.body as string).messages);
    expect(sent).toContain('只给阿白的秘密原文'); expect(sent).not.toContain('只给阿绿的秘密原文');
    expect(sent).toContain('职业号，只发咖啡工作'); expect(sent).toContain('陌生网友'); expect(sent).toContain('微博已到达');
    const feed = await readFriendFeed(), post = feed.posts.at(-1)!;
    expect(post).toMatchObject({authorId: a.id, accountId: 'work', authorName: '今日营业', accountTags: ['咖啡']});
    expect((await DB.getMessagesByCharId(a.id, true)).at(-1)?.content).toContain('使用账号「今日营业」');
    expect(await DB.getMessagesByCharId(b.id, true)).toHaveLength(1);
    expect(feed.refreshLease).toBeUndefined(); expect(result.message).toBe('新动态已送达');
});
it('NPC refresh can publish several strangers but creates no autobiographical cards', async () => {
    await publicSettings({contentWeights: {self: 0, related: 0, stranger: 100}});
    response({kind: 'none', npcActions: [{kind: 'post', name: '雨天跑步', text: '今天只跑了三公里。'}, {kind: 'post', name: '橘猫', text: '新买的杯子很好看。'}]});
    await refreshFriendFeed(user, api, undefined, undefined, () => 0);
    expect((await readFriendFeed()).posts).toHaveLength(2);
    expect(await DB.getMessagesByCharId(a.id, true)).toHaveLength(0);
    expect(await DB.getMessagesByCharId(b.id, true)).toHaveLength(0);
    expect(JSON.stringify(vi.mocked(safeFetchJson).mock.calls[0])).toContain('完全无关的陌生网友');
});
it.each(['missing','offline','busy'] as const)('refreshes real Weibo independently when the character API is %s',async mode=>{
    await publicSettings();
    await mutateFriendFeed(f=>{f.weiboStreams=[{circleId:'public',enabled:true,generation:'home',since:0}];if(mode==='busy')f.refreshLease={id:'pending-ai',until:Date.now()+60000};});
    vi.mocked(syncWeibo).mockImplementation(async()=>{await mutateFriendFeed(f=>{f.posts.push({id:'real-home',circleId:'public',authorId:'weibo:654321',authorName:'真实关注作者',text:'真实微博已读取',createdAt:Date.now(),audienceIds:[],comments:[],synced:true,source:{platform:'weibo',accountId:'654321',externalId:'111111',author:'真实关注作者',text:'真实微博已读取',url:'https://weibo.com/654321/111111',publishedAt:Date.now(),fetchedAt:Date.now(),truncated:false}});});return {received:1,added:1,existing:0,hidden:0};});
    vi.mocked(safeFetchJson).mockRejectedValue(new Error('API offline'));
    const result=await refreshFriendFeed(user,mode==='missing'?{} as APIConfig:api,undefined,undefined,()=>0);
    expect(syncWeibo).toHaveBeenCalledWith('public','following');expect(result.message).toContain('已读取 1 条微博');
    expect(result.warnings.join('；')).toContain('角色 API');
    expect((await readFriendFeed()).posts.map(p=>p.text)).toEqual(['真实微博已读取']);
    if(mode==='busy'){expect(safeFetchJson).not.toHaveBeenCalled();expect((await readFriendFeed()).refreshLease?.id).toBe('pending-ai');}
    else expect((await readFriendFeed()).refreshLease).toBeUndefined();
});
it('starts the home timeline for an existing scanned connection on refresh, but respects an explicitly disabled stream',async()=>{
    await publicSettings();vi.mocked(readWeiboConnection).mockReturnValue({uid:'123456'} as any);
    vi.mocked(syncWeiboHome).mockResolvedValue({received:2,added:2,existing:0,hidden:0,profileError:undefined});
    const result=await refreshFriendFeed(user,{} as APIConfig);
    expect(syncWeiboHome).toHaveBeenCalledWith('public');expect(result.message).toContain('已读取 2 条微博');
    await mutateFriendFeed(f=>{f.weiboStreams=[{circleId:'public',enabled:false,generation:'off',since:0}];});
    vi.mocked(syncWeiboHome).mockClear();await expect(refreshFriendFeed(user,{} as APIConfig)).rejects.toThrow('配置独立 API');
    expect(syncWeiboHome).not.toHaveBeenCalled();
});
it('no enabled pool means no API call; failures preserve synced content and release the refresh lock', async () => {
    await publicSettings({characterWeights: {[a.id]: 0, [b.id]: 0}});
    await refreshFriendFeed(user, api); expect(safeFetchJson).not.toHaveBeenCalled();
    await publicSettings(); await publishFriendPost('public', user.name, '保留这条');
    vi.mocked(safeFetchJson).mockRejectedValue(new Error('offline'));
    await expect(refreshFriendFeed(user, api, undefined, undefined, () => 0)).rejects.toThrow('offline');
    expect((await readFriendFeed()).posts).toHaveLength(1); expect((await readFriendFeed()).refreshLease).toBeUndefined();
});
it('rejects cross-account impersonation and stale refresh leases atomically', async () => {
    await publicSettings({identities: {[b.id]: {tags: [], accounts: [{id: 'other', name: '绿的小号', purpose: '', tags: []}]}}});
    await mutateFriendFeed(f => {f.refreshLease = {id: 'first', until: Date.now() + 100000};});
    const task = (await prepareFriendFeedEmotionTask(a.id, () => 0, undefined, 'refresh', 'self'))!;
    expect(await landFriendFeedEmotionAction(a.id, {requestId: task.id, kind: 'post', accountId: 'other', text: '冒名'}, 'refresh')).toBe(false);
    const next = (await prepareFriendFeedEmotionTask(a.id, () => 0, undefined, 'refresh', 'self'))!;
    await mutateFriendFeed(f => {f.refreshLease = {id: 'next', until: Date.now() + 100000};});
    expect(await landFriendFeedEmotionAction(a.id, {requestId: next.id, kind: 'post', text: '迟到'}, 'refresh')).toBe(false);
    expect((await readFriendFeed()).posts).toHaveLength(0); expect(await DB.getMessagesByCharId(a.id, true)).toHaveLength(0);
});
it('a second entry cannot start a concurrent refresh', async () => {
    await publicSettings();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => {release = resolve;});
    let started!: () => void;
    const ready = new Promise<void>(resolve => {started = resolve;});
    vi.mocked(safeFetchJson).mockImplementation(async () => {started(); await waiting; return {choices: [{message: {content: '{"friendFeedAction":null}'}}]};});
    const first = refreshFriendFeed(user, api, undefined, undefined, () => 0); await ready;
    await expect(refreshFriendFeed(user, api)).rejects.toThrow('请等这次刷新完成');
    release(); await first; expect(safeFetchJson).toHaveBeenCalledTimes(1);
});

it('prioritizes normalized shared topics and real contacts, excluding zero weights and blocked relationships',()=>{
    const c={...a,id:'c',name:'路过的角色'};
    const settings=resolveFriendFeedSettings({identities:{[a.id]:{tags:['#摄影'],accounts:[]},[b.id]:{tags:['＃摄影'],accounts:[]}}});
    const post={authorId:a.id,accountTags:['摄影']} as any;
    expect(friendCommentPool([a,b,c],post,settings).map(c=>c.id)).toEqual([b.id]);
    const blocked={...b,phoneState:{contacts:[{kind:'real',linkedCharId:a.id,status:'blocked'}]}} as CharacterProfile;
    expect(friendCommentPool([a,blocked,c],post,settings).map(c=>c.id)).toEqual([a.id,'c']);
    const related={...a,phoneState:{contacts:[{kind:'real',linkedCharId:'c',status:'friend'}]}} as CharacterProfile;
    settings.characterWeights[b.id]=0;
    expect(friendCommentPool([related,b,c],post,settings).map(c=>c.id)).toEqual(['c']);
});

it('refreshes one post with one related character context, writes its comment card and the owner receipt, never syncs Weibo',async()=>{
    await publicSettings({characterWeights:{[a.id]:10,[b.id]:10},identities:{[a.id]:{tags:['摄影'],accounts:[]},[b.id]:{tags:['摄影'],accounts:[]}}});
    const id=await publishFriendPost('public',user.name,'摄影散步');
    await mutateFriendFeed(f=>{Object.assign(f.posts[0],{authorId:b.id,authorName:b.name,accountTags:['摄影']});});
    await DB.saveMessage({charId:a.id,role:'user',type:'text',content:'仅阿白的上下文',timestamp:Date.now()});
    await DB.saveMessage({charId:b.id,role:'user',type:'text',content:'仅阿绿的秘密',timestamp:Date.now()});
    response({kind:'comment',postId:id,comment:'下次试试傍晚的光线。'});
    await refreshFriendFeed(user,api,undefined,undefined,()=>0,id);
    expect(safeFetchJson).toHaveBeenCalledTimes(1);expect(syncWeibo).not.toHaveBeenCalled();
    const sent=JSON.stringify(vi.mocked(safeFetchJson).mock.calls[0]);expect(sent).toContain('仅阿白的上下文');expect(sent).not.toContain('仅阿绿的秘密');
    expect((await readFriendFeed()).posts[0].comments[0]).toMatchObject({authorId:a.id,text:'下次试试傍晚的光线。'});
    expect((await DB.getMessagesByCharId(a.id,true)).at(-1)?.content).toContain('下次试试');
    expect((await DB.getMessagesByCharId(b.id,true)).at(-1)?.content).toContain('下次试试');
});

it('refreshes related NPC comments with the host contacts, without autobiographical cards or new posts',async()=>{
    await DB.saveCharacter({...a,phoneState:{contacts:[{id:'npc-one',name:'小巷咖啡店员',kind:'npc',status:'friend',note:'不可公开的私事'}]}} as CharacterProfile);
    await publicSettings({contentWeights:{self:0,related:100,stranger:0}});
    const id=await publishFriendPost('public',user.name,'今天喝什么？');
    response({kind:'none',npcActions:[{kind:'comment',name:'小巷咖啡店员',postId:id,text:'来杯拿铁？'}]});
    await refreshFriendFeed(user,api,undefined,undefined,()=>0,id);
    const feed=await readFriendFeed();expect(feed.posts).toHaveLength(1);expect(feed.posts[0].comments).toHaveLength(1);
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
    const sent=JSON.stringify(vi.mocked(safeFetchJson).mock.calls[0]);expect(sent).toContain('小巷咖啡店员');expect(sent).not.toContain('不可公开的私事');
});

it('rejects off-target comments and new posts, and does not read real posts without permission',async()=>{
    await publicSettings();const id=await publishFriendPost('public',user.name,'目标');const other=await publishFriendPost('public',user.name,'另一条');
    response({kind:'comment',postId:other,comment:'不该串到这里'});
    await expect(refreshFriendFeed(user,api,undefined,undefined,()=>0,id)).rejects.toThrow('未发布');
    response({kind:'post',text:'不该新发动态'});
    await expect(refreshFriendFeed(user,api,undefined,undefined,()=>0,id)).rejects.toThrow('未发布');
    expect((await readFriendFeed()).posts).toHaveLength(2);
    await mutateFriendFeed(f=>{f.posts[0].authorKind='external';f.posts[0].source={platform:'weibo',accountId:'123456',externalId:'111111',url:'https://weibo.com/123456/111111',author:'外部',text:'真实材料',fetchedAt:Date.now(),publishedAt:Date.now(),truncated:false};});
    vi.mocked(safeFetchJson).mockClear();await refreshFriendFeed(user,api,undefined,undefined,()=>0,id);expect(safeFetchJson).not.toHaveBeenCalled();
});

it('publishes a complete bare action with alternate fields at the higher output allowance',async()=>{
    await publicSettings();
    vi.mocked(safeFetchJson).mockImplementation(async(_url,init)=>{
        const body=JSON.parse(init!.body as string);
        const match=JSON.stringify(body.messages).match(/\\"requestId\\":\\"([^"\\]+)\\"/)!;
        expect(body.max_tokens).toBe(16000);
        return {choices:[{message:{content:JSON.stringify({request_id:match[1],kind:' POST ',content:'风'.repeat(4000)})}}]};
    });
    await refreshFriendFeed(user,api,undefined,undefined,()=>0);
    expect((await readFriendFeed()).posts[0].text).toHaveLength(4000);expect(safeFetchJson).toHaveBeenCalledOnce();
});
