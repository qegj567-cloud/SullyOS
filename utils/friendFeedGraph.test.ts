import {beforeEach,it,expect,vi} from 'vitest';
import type {CharacterProfile,UserProfile} from '../types';
import {DB} from './db';
import {ensurePublicFriendFeed,readFriendFeed,mutateFriendFeed,saveFriendFeedSettings,updateFriendRelation,publishFriendPost,parseFriendFeed,FRIEND_FEED_KEY} from './friendFeed';
import {defaultFriendFeedSettings} from './friendFeedSettings';
import {friendAccountRef,knowsFriendAccount,followsFriendPost,projectFriendPost,friendAccountName,activeFriendAccounts} from './friendFeedGraph';
import {prepareFriendFeedEmotionTask,landFriendFeedEmotionAction,releaseFriendFeedEmotionTask} from './friendFeedEmotion';
import {enqueueFriendNotices} from './friendFeedActivity';
import {shareFriendPost} from './friendFeedShare';
import {friendFeedShareContext} from './friendFeedShareContext';
import {friendCommentPool} from './friendFeedCommunity';

const a={id:'person-a',name:'阿青',memories:[]} as unknown as CharacterProfile;
const b={id:'secret-owner-b',name:'乙的真名',memories:[]} as unknown as CharacterProfile;
const c={id:'person-c',name:'小陈',memories:[]} as unknown as CharacterProfile;
const chars=[a,b,c],user={name:'用户真名'} as UserProfile;
const settings=()=>({...defaultFriendFeedSettings(),userNickname:'橘子汽水',identities:{
    [a.id]:{nickname:'青柠',tags:[],accounts:[{id:'a-work',name:'今天上班了吗',purpose:'职业号',tags:[]}]},
    [b.id]:{nickname:'咖啡主号',tags:['咖啡'],accounts:[
        {id:'secret-coffee',name:'每天一杯',purpose:'不能公开的用途一',tags:['咖啡']},
        {id:'secret-rant',name:'半夜吃面',purpose:'不能公开的用途二',tags:[]},
        {id:'secret-photo',name:'慢半拍',purpose:'不能公开的用途三',tags:['摄影']},
    ]},
}});
beforeEach(async()=>{
    vi.restoreAllMocks();await DB.deleteDB();localStorage.clear();
    for(const char of chars)await DB.saveCharacter(char);
    await DB.saveUserProfile(user);await ensurePublicFriendFeed();await saveFriendFeedSettings(settings());
});
async function ref(ownerId:string,accountId='main'){return friendAccountRef(await readFriendFeed(),{authorId:ownerId,accountId})!;}
async function follow(sourceOwner:string,sourceAccount:string,targetOwner:string,targetAccount:string,value=true){
    await updateFriendRelation({kind:'follow',sourceId:(await ref(sourceOwner,sourceAccount)).id,targetId:(await ref(targetOwner,targetAccount)).id,value});
}
async function seed(){
    await mutateFriendFeed(feed=>{
        feed.posts.push({id:'b-rant-post',circleId:'public',authorId:b.id,authorName:'半夜吃面',accountId:'secret-rant',text:'面又煮多了',createdAt:Date.now(),audienceIds:chars.map(c=>c.id),comments:[
            {id:'b-rant-comment',authorId:b.id,accountId:'secret-rant',authorName:'半夜吃面',text:'分你一碗',createdAt:Date.now()},
            {id:'quoted',authorId:c.id,authorName:c.name,text:'好啊',createdAt:Date.now(),localReply:{id:'b-rant-comment',authorId:b.id,authorName:'半夜吃面',text:'分你一碗'}},
        ]});
    });
}
it.each(['main','a-work'])('accepts the current actor public account ID for %s and stores the local identity',async accountId=>{
    const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    const publicId=(await ref(a.id,accountId)).id;
    expect(await landFriendFeedEmotionAction(a.id,{requestId:task.id,kind:'post',accountId:publicId,text:'今日一杯热茶'})).toBe(true);
    const post=(await readFriendFeed()).posts[0];expect(post.authorId).toBe(a.id);expect(post.accountId).toBe(accountId);
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(1);
});
it('rejects another actor public account and a retired own alias',async()=>{
    const old=(await ref(a.id,'a-work')).id;
    const next=settings();next.identities[a.id].accounts=[];await saveFriendFeedSettings(next);
    for(const accountId of [(await ref(b.id)).id,old]){
        const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;const rejected=vi.fn();
        expect(await landFriendFeedEmotionAction(a.id,{requestId:task.id,kind:'post',accountId,text:'不能冒名'},'emotion',rejected)).toBe(false);
        expect(rejected).toHaveBeenCalledWith('模型选择的账号不属于本角色，或该小号已停用');
    }
    expect((await readFriendFeed()).posts).toHaveLength(0);
});
it('defaults the user to main accounts only; renaming does not change IDs or relationships',async()=>{
    const before=await readFriendFeed(),main=await ref(b.id),alias=await ref(b.id,'secret-rant');
    expect(followsFriendPost(before,'user',{authorId:b.id})).toBe(true);
    expect(followsFriendPost(before,'user',{authorId:b.id,accountId:'secret-rant'})).toBe(false);
    await follow(a.id,'main',b.id,'secret-rant');
    const next=settings();next.identities[b.id].accounts[1].name='醒来再吃';await saveFriendFeedSettings(next);
    const after=await readFriendFeed();expect((await ref(b.id)).id).toBe(main.id);expect((await ref(b.id,'secret-rant')).id).toBe(alias.id);
    expect(followsFriendPost(after,a.id,{authorId:b.id,accountId:'secret-rant'})).toBe(true);
    expect(friendAccountName(after,alias,chars)).toBe('醒来再吃');
    expect(knowsFriendAccount(after,a.id,alias)).toBe(false);
});
it('mutual following reveals exactly the participating accounts, never siblings or other observers',async()=>{
    await follow(a.id,'a-work',b.id,'secret-coffee');await follow(b.id,'secret-coffee',a.id,'a-work');
    let feed=await readFriendFeed();
    expect(knowsFriendAccount(feed,a.id,await ref(b.id,'secret-coffee'))).toBe(true);
    expect(knowsFriendAccount(feed,b.id,await ref(a.id,'a-work'))).toBe(true);
    expect(knowsFriendAccount(feed,a.id,await ref(b.id))).toBe(false);
    expect(knowsFriendAccount(feed,a.id,await ref(b.id,'secret-rant'))).toBe(false);
    expect(knowsFriendAccount(feed,c.id,await ref(b.id,'secret-coffee'))).toBe(false);
    await follow(a.id,'a-work',b.id,'secret-coffee',false);feed=await readFriendFeed();
    expect(knowsFriendAccount(feed,a.id,await ref(b.id,'secret-coffee'))).toBe(true);
    await updateFriendRelation({kind:'known',viewerId:a.id,targetId:(await ref(b.id,'secret-coffee')).id,value:false});
    await follow(a.id,'a-work',b.id,'secret-coffee');
    expect(knowsFriendAccount(await readFriendFeed(),a.id,await ref(b.id,'secret-coffee'))).toBe(false);
});
it('independent tabs update different edges without overwriting each other',async()=>{
    const source=(await ref(a.id)).id,one=(await ref(b.id,'secret-coffee')).id,two=(await ref(b.id,'secret-rant')).id;
    await Promise.all([updateFriendRelation({kind:'follow',sourceId:source,targetId:one,value:true}),updateFriendRelation({kind:'follow',sourceId:source,targetId:two,value:true})]);
    expect((await readFriendFeed()).accountGraph?.follows[source]).toEqual(expect.arrayContaining([one,two]));
});
it('projection conceals owner and private alias IDs in posts, comments and quoted replies',async()=>{
    await seed();const feed=await readFriendFeed(),projected=projectFriendPost(feed,a.id,feed.posts[0]);
    const json=JSON.stringify(projected);
    for(const secret of [b.id,'secret-rant','不能公开的用途二'])expect(json).not.toContain(secret);
    expect(projected.comments[1].localReply?.authorId).toBe((await ref(b.id,'secret-rant')).id);
    expect(projected.authorId).toBe((await ref(b.id,'secret-rant')).id);
});
it('all prompt branches use projected material; identity changes invalidate an in-flight response',async()=>{
    await seed();const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    for(const secret of [b.id,b.name,'secret-rant','不能公开的用途','慢半拍'])expect(task.prompt).not.toContain(secret);
    await updateFriendRelation({kind:'known',viewerId:a.id,targetId:(await ref(b.id,'secret-rant')).id,value:true});
    expect(await landFriendFeedEmotionAction(a.id,{requestId:task.id,kind:'comment',postId:'b-rant-post',comment:'过期回复'})).toBe(false);
    const next=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    expect(next.prompt).toContain(b.name);expect(next.prompt).not.toContain('不能公开的用途二');
    expect(await landFriendFeedEmotionAction(a.id,{requestId:next.id,kind:'comment',postId:'b-rant-post',accountId:'a-work',comment:'那我来吃一碗'})).toBe(true);
    const own=await DB.getMessagesByCharId(a.id,true);expect(own).toHaveLength(1);expect(own[0].content).toContain('今天上班了吗');expect(own[0].content).toContain(b.name);
    const received=await DB.getMessagesByCharId(b.id,true);expect(received).toHaveLength(1);expect(received[0].content).toContain('今天上班了吗');expect(received[0].content).not.toContain(a.name);
});
it('main API follows the precise public account using the chosen alias; sibling posts do not notify',async()=>{
    await seed();await publishFriendPost('public',user.name,'来了');
    const task=(await prepareFriendFeedEmotionTask(a.id,()=>0,undefined,'main'))!;
    const target=(await ref(b.id,'secret-rant')).id;
    expect(task.prompt).toContain(target);expect(task.prompt).not.toContain('不能公开的用途二');
    expect(await landFriendFeedEmotionAction(a.id,{requestId:task.id,kind:'follow',accountId:'a-work',authorId:target},'main')).toBe(true);
    const feed=await readFriendFeed();
    expect(feed.accountGraph?.follows[(await ref(a.id,'a-work')).id]).toContain(target);
    await mutateFriendFeed(f=>{f.notices=[];enqueueFriendNotices(f,{...f.posts[0],id:'wanted'});enqueueFriendNotices(f,{...f.posts[0],id:'sibling',accountId:'secret-photo'});});
    expect((await readFriendFeed()).notices?.filter(n=>n.charId===a.id).map(n=>n.postId)).toEqual(['wanted']);
});
it('shares recipient-specific snapshots without leaking identity through metadata or quotes',async()=>{
    await seed();await shareFriendPost('b-rant-post',a.id,'anonymous');
    const message=(await DB.getMessagesByCharId(a.id,true))[0];
    for(const secret of [b.id,b.name,'secret-rant'])expect(JSON.stringify(message)).not.toContain(secret);
    await updateFriendRelation({kind:'known',viewerId:c.id,targetId:(await ref(b.id,'secret-rant')).id,value:true});
    await shareFriendPost('b-rant-post',c.id,'known');
    const known=(await DB.getMessagesByCharId(c.id,true))[0];expect(known.content).toContain(b.name);
    expect(friendFeedShareContext(message.metadata!.friendFeedShare,a.id)).not.toContain(b.name);
});
it('nicknames are used for new user posts and comments; reserved names are rejected in settings',async()=>{
    await publishFriendPost('public',user.name,'你好');expect((await readFriendFeed()).posts[0].authorName).toBe('橘子汽水');
    const next=settings();next.identities[b.id].accounts[1].name='橘\u200b子汽水';
    await expect(saveFriendFeedSettings(next)).rejects.toThrow('不能使用你的姓名或网名');
});
it('removing an alias keeps historical attribution and knowledge but retires its follows and publishing access',async()=>{
    await seed();await follow(a.id,'main',b.id,'secret-rant');
    const old=await ref(b.id,'secret-rant');
    const next=settings();next.identities[b.id].accounts=next.identities[b.id].accounts.filter(a=>a.id!=='secret-rant');await saveFriendFeedSettings(next);
    const feed=await readFriendFeed();expect(friendAccountRef(feed,feed.posts[0])?.id).toBe(old.id);
    expect(activeFriendAccounts(feed,chars).some(a=>a.id===old.id)).toBe(false);
    expect(followsFriendPost(feed,a.id,feed.posts[0])).toBe(false);
    await expect(updateFriendRelation({kind:'follow',sourceId:(await ref(a.id)).id,targetId:old.id,value:true})).rejects.toThrow('停用');
});
it('legacy owner follows migrate to main accounts and persist through backup round trips',async()=>{
    await mutateFriendFeed(feed=>{delete feed.accountGraph;feed.follows={[a.id]:[b.id]};});
    const feed=await readFriendFeed();expect(followsFriendPost(feed,a.id,{authorId:b.id})).toBe(true);
    expect(followsFriendPost(feed,a.id,{authorId:b.id,accountId:'secret-rant'})).toBe(false);
    const restored=parseFriendFeed(JSON.stringify(feed));expect(restored.accountGraph).toEqual(feed.accountGraph);
    await DB.saveAsset(FRIEND_FEED_KEY,JSON.stringify(restored));expect((await ref(b.id)).id).toBe(friendAccountRef(feed,{authorId:b.id})?.id);
});
it('hidden aliases do not inherit the main account topics or multiply character lottery entries',async()=>{
    await seed();const feed=await readFriendFeed(),configured=settings();
    configured.identities[a.id].tags=['咖啡'];
    const pool=friendCommentPool(chars,feed.posts[0],configured,feed);
    expect(pool.map(c=>c.id)).toEqual(chars.map(c=>c.id));expect(new Set(pool.map(c=>c.id)).size).toBe(pool.length);
});
