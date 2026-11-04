// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {DB} from './db';
import {saveFriendCircle,publishFriendPost,readFriendFeed,mutateFriendFeed,saveFriendFeedSettings} from './friendFeed';
import {defaultFriendFeedSettings} from './friendFeedSettings';
import {shareFriendPost} from './friendFeedShare';
import {ChatPrompts} from './chatPrompts';
import {normalizeMessageContent} from './messageFormat';
import {materializeVisionDescriptions} from './visionApi';
import {safeFetchJson} from './safeApi';
import {isBlobRef} from './blobRef';
import {restoreBlobRef} from './blobRef';
import type {CharacterProfile,UserProfile,Message} from '../types';
vi.mock('./blobRef',async original=>({...await original<typeof import('./blobRef')>(),putImageBlob:vi.fn(async()=> 'blobref:b_sharetest')}));
vi.mock('./safeApi',async original=>({...await original<typeof import('./safeApi')>(),safeFetchJson:vi.fn()}));
const char={id:'share-recipient',name:'小白',memories:[],contextRangePolicyVersion:1,contextRangeMode:'manual',contextLimit:50} as unknown as CharacterProfile;
const user={name:'小雨'} as UserProfile;
let id:string;
beforeEach(async()=>{
    vi.restoreAllMocks();vi.mocked(safeFetchJson).mockReset();localStorage.clear();sessionStorage.clear();await DB.deleteDB();await DB.saveCharacter(char);
    const circle=await saveFriendCircle({name:'圈',description:'',memberIds:[char.id],realContentEnabled:false});
    id=await publishFriendPost(circle,user.name,'很长的帖子正文'.repeat(150));
    await mutateFriendFeed(f=>{const p=f.posts[0];p.authorId=char.id;p.authorName=char.name;
        p.source={platform:'weibo',accountId:'123456',externalId:'111111',author:'绑定账号',text:p.text,url:'https://weibo.com/123456/111111',publishedAt:Date.now(),fetchedAt:Date.now(),truncated:false,
            images:[{url:'https://wx1.sinaimg.cn/large/test.jpg',thumbnail:'https://wx1.sinaimg.cn/bmiddle/test.jpg'}]};
        p.comments=Array.from({length:35},(_,n)=>({id:`local-${n}`,authorId:'npc:someone',authorName:'路人',text:`完整本地评论${n}`,createdAt:Date.now()}));
        p.weiboComments={rows:Array.from({length:12},(_,n)=>({id:String(777770+n),authorId:'654321',authorName:'原网友',text:`原评论${n}`,createdAt:Date.now()+n})),cursor:null,fetchedAt:Date.now()};
    });
});
afterEach(()=>vi.unstubAllGlobals());
it('keeps local photos visible in shares without sending them to the model until opted in, and never proxies local photos',async()=>{
    const ref='blobref:b_localsharephoto';
    await restoreBlobRef(ref,new Blob(['photo'],{type:'image/jpeg'}));
    await mutateFriendFeed(f=>{const p=f.posts[0];delete p.source;delete p.weiboComments;p.images=[{url:ref,thumbnail:ref}];});
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await shareFriendPost(id,char.id,'local-off');
    let messages=await DB.getMessagesByCharId(char.id,true);
    expect(messages[0].metadata?.friendFeedShare).toMatchObject({images:[{url:ref,thumbnail:ref}],imageRefs:[],imageCount:1});
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),shareImagesEnabled:true});
    await shareFriendPost(id,char.id,'local-on');
    messages=await DB.getMessagesByCharId(char.id,true);
    expect(messages[1].metadata?.friendFeedShare.imageRefs).toEqual([ref]);
    expect(fetcher).not.toHaveBeenCalled();
});
it('shares full public text, all local comments and ten originals once without granting ambient reading or auto-calling a model',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await shareFriendPost(id,char.id,'delivery');await shareFriendPost(id,char.id,'delivery');
    const messages=await DB.getMessagesByCharId(char.id,true);expect(messages).toHaveLength(1);
    const message=messages[0],share=message.metadata!.friendFeedShare;
    expect(message).toMatchObject({role:'user',type:'friend_feed_share_card'});expect(share.comments).toHaveLength(35);expect(share.originalComments).toHaveLength(10);
    expect(share.originalComments[0].text).toBe('原评论11');expect(share.text).toBe('很长的帖子正文'.repeat(150));
    expect(share.imageRefs).toEqual([]);expect(fetcher).not.toHaveBeenCalled();expect(safeFetchJson).not.toHaveBeenCalled();
    expect((await readFriendFeed()).circles[0].realContentEnabled).toBe(false);
    await mutateFriendFeed(f=>{f.posts[0].comments.push({id:'later',authorId:'user',authorName:'小雨',text:'分享之后的评论',createdAt:Date.now()});});
    const context=normalizeMessageContent((await DB.getMessagesByCharId(char.id,true))[0],char.name,user.name);
    expect(context).toContain('完整本地评论34');expect(context).not.toContain('分享之后的评论');expect(context).toContain('你自己的账号');
    const api=ChatPrompts.buildMessageHistory(messages,50,char,user,[]).apiMessages;
    expect(api[0].role).toBe('user');expect(typeof api[0].content).toBe('string');expect(api[0].content).not.toContain('image_url');
    expect(ChatPrompts.buildMessageHistory(messages,50,char,user,[],new Set([message.id])).apiMessages).toHaveLength(0);
});
it('stores opted-in images locally and uses the normal image request or cached independent vision descriptions',async()=>{
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),shareImagesEnabled:true});
    const fetcher=vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg'}}));vi.stubGlobal('fetch',fetcher);
    await shareFriendPost(id,char.id,'with-image');const messages=await DB.getMessagesByCharId(char.id,true);
    expect(fetcher.mock.calls[0][0]).toContain('/weibo-image?url=');expect(fetcher.mock.calls[0][1]).toMatchObject({credentials:'omit',redirect:'error'});
    expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
    const api=ChatPrompts.buildMessageHistory(messages,50,char,user,[]).apiMessages;
    expect(Array.isArray(api[0].content)).toBe(true);expect(isBlobRef((api[0].content as any)[1].image_url.url)).toBe(true);
    vi.mocked(safeFetchJson).mockResolvedValue({choices:[{message:{content:'一只猫坐在窗边。'}}]});
    const config={enabled:true,baseUrl:'https://vision.test',model:'vision',apiKey:'test'};
    const described=await materializeVisionDescriptions(messages,config);
    const textApi=ChatPrompts.buildMessageHistory(described,50,char,user,[],undefined,{useVisionDescriptions:true}).apiMessages;
    expect(textApi[0].content).toContain('一只猫坐在窗边');expect(textApi[0].content).not.toContain('blobref:');
    await materializeVisionDescriptions(described,config);expect(safeFetchJson).toHaveBeenCalledTimes(1);
});
it('keeps text share usable when an image fails, and rejects a removed recipient',async()=>{
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),shareImagesEnabled:true});vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('bad',{status:403})));
    const result=await shareFriendPost(id,char.id,'failed-image');expect(result.warning).toContain('0/1');
    const msg=(await DB.getMessagesByCharId(char.id,true))[0];expect(msg.metadata?.friendFeedShare.imageRefs).toEqual([]);
    await expect(shareFriendPost(id,'missing','missing')).rejects.toThrow('角色已不存在');
});
it('does not deliver images after the user turns the image setting off during preparation',async()=>{
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),shareImagesEnabled:true});
    let finish!:(r:Response)=>void;const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetcher);
    const pending=shareFriendPost(id,char.id,'cancelled-image-grant');
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalled());await saveFriendFeedSettings(defaultFriendFeedSettings());
    finish(new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg'}}));
    await expect(pending).rejects.toThrow('分享设置已变化');expect(await DB.getMessagesByCharId(char.id,true)).toHaveLength(0);
});
