import {beforeEach,expect,it,vi} from 'vitest';
import type {CharacterProfile,UserProfile} from '../types';
import {DB} from './db';
import {ensurePublicFriendFeed,saveFriendFeedSettings,mutateFriendFeed,readFriendFeed,updateFriendRelation,parseFriendFeed} from './friendFeed';
import {defaultFriendFeedSettings} from './friendFeedSettings';
import {friendAccountRef,knowsFriendAccount} from './friendFeedGraph';
import {prepareFriendFeedEmotionTask,landFriendFeedEmotionAction,releaseFriendFeedEmotionTask,acknowledgeFriendFeedNotices} from './friendFeedEmotion';
import {prepareFriendFeedMainTask,consumeFriendFeedMainReply,friendFeedUserDisclosure} from './friendFeedMain';

const a={id:'a',name:'阿青',memories:[]} as unknown as CharacterProfile;
const b={id:'secret-b',name:'顾夏',memories:[]} as unknown as CharacterProfile;
const c={id:'c',name:'小陈',memories:[]} as unknown as CharacterProfile;
const user={name:'小雨'} as UserProfile;
beforeEach(async()=>{
    vi.restoreAllMocks();await DB.deleteDB();localStorage.clear();
    for(const char of [a,b,c])await DB.saveCharacter(char);
    await DB.saveUserProfile(user);await ensurePublicFriendFeed();
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),identities:{[b.id]:{nickname:'下班再说',tags:[],accounts:[
        {id:'rant',name:'半夜吃面',purpose:'秘密吐槽',tags:[]},{id:'photo',name:'慢半拍',purpose:'秘密摄影',tags:[]},
    ]}}});
});
async function account(owner=b.id,alias='rant'){return friendAccountRef(await readFriendFeed(),{authorId:owner,accountId:alias})!;}
async function seed(text='不藏了，我是顾夏。'){
    await mutateFriendFeed(f=>f.posts.push({id:'reveal',circleId:'public',authorId:b.id,accountId:'rant',authorName:'半夜吃面',text,createdAt:Date.now(),audienceIds:[a.id,b.id,c.id],comments:[]}));
}
async function action(id:string,evidenceId='post:reveal',quote='不藏了，我是顾夏。'){
    return {requestId:id,kind:'none',learnIdentities:[{accountId:(await account()).id,personName:b.name,evidenceId,quote}]};
}
it('remembers a read self-reveal only for the observer, with one quiet card and no public action',async()=>{
    await seed();const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    expect(task.prompt).toContain('learnIdentities');expect(task.prompt).toContain('post:reveal');
    expect(task.prompt).not.toContain('秘密摄影');expect(task.prompt).not.toContain(b.id);
    const command=await action(task.id);
    expect(await landFriendFeedEmotionAction(a.id,command,'emotion')).toBe(true);
    const feed=await readFriendFeed();expect(knowsFriendAccount(feed,a.id,await account())).toBe(true);
    expect(knowsFriendAccount(feed,c.id,await account())).toBe(false);
    expect(knowsFriendAccount(feed,a.id,await account(b.id,'photo'))).toBe(false);
    expect(feed.posts).toHaveLength(1);expect(feed.posts[0].comments).toHaveLength(0);
    const cards=await DB.getMessagesByCharId(a.id,true);expect(cards).toHaveLength(1);
    expect(cards[0].metadata.friendFeedComment.kind).toBe('identity');expect(cards[0].content).toContain('半夜吃面');
    expect(await DB.getMessagesByCharId(b.id,true)).toHaveLength(0);
    expect(await landFriendFeedEmotionAction(a.id,command,'emotion')).toBe(false);
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(1);
    expect(parseFriendFeed(JSON.stringify(feed)).accountGraph?.learned).toEqual(feed.accountGraph?.learned);
});
it('accepts a direct user disclosure on the next main reply without pending posts or an emotion roll',async()=>{
    const text='半夜吃面是顾夏的小号。';vi.spyOn(Math,'random').mockReturnValue(.99);
    const task=(await prepareFriendFeedMainTask(a.id,{id:'chat:7',text}))!;
    expect(task.prompt).toContain(text);expect(task.prompt).not.toContain('慢半拍');
    const command=await action(task.id,'user:chat:7',text);
    expect(await consumeFriendFeedMainReply(a.id,'原来是他。\n[[FRIEND_FEED_REPLY:'+JSON.stringify(command)+']]',[],task.id)).toBe('原来是他。\n');
    expect(knowsFriendAccount(await readFriendFeed(),a.id,await account())).toBe(true);
    const recall=(await prepareFriendFeedMainTask(a.id,{id:'chat:8',text:'半夜吃面是谁来着？'}))!;
    expect(recall.prompt).toContain('你已经认得');expect(recall.prompt).toContain(b.name);
    await acknowledgeFriendFeedNotices(a.id,recall.id);
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(1);
});
it('uses only the supplied user turn and excludes cards, assistant statements and unrelated chat',async()=>{
    expect(friendFeedUserDisclosure([{id:1,role:'assistant',type:'text',content:'半夜吃面是顾夏'}])).toBeUndefined();
    expect(friendFeedUserDisclosure([{id:1,role:'user',type:'friend_feed_share_card',content:'半夜吃面是顾夏'}])).toBeUndefined();
    expect(friendFeedUserDisclosure([{id:2,role:'user',type:'text',content:'半夜吃面是顾夏'}])).toEqual({id:'chat:2',text:'半夜吃面是顾夏'});
    expect(await prepareFriendFeedMainTask(a.id,{id:'chat:3',text:'晚上吃什么'})).toBeUndefined();
    expect(await prepareFriendFeedMainTask(a.id)).toBeUndefined();
});
it('does not relearn from old evidence after a manual correction; new user disclosure can teach again',async()=>{
    await seed();const first=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    await landFriendFeedEmotionAction(a.id,await action(first.id),'emotion');
    await updateFriendRelation({kind:'known',viewerId:a.id,targetId:(await account()).id,value:false});
    const again=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    expect(again.prompt).not.toContain('"evidenceId":"post:reveal"');
    await releaseFriendFeedEmotionTask(a.id,again.id);
    const text='半夜吃面就是顾夏的小号。';const task=(await prepareFriendFeedMainTask(a.id,{id:'chat:9',text}))!;
    expect(await landFriendFeedEmotionAction(a.id,await action(task.id,'user:chat:9',text),'main')).toBe(true);
    expect(knowsFriendAccount(await readFriendFeed(),a.id,await account())).toBe(true);
});
it('rejects forged quotes, wrong identities, guesses and unseen sibling accounts without partial actions',async()=>{
    await seed('我可能是顾夏？');
    for(const override of [
        {quote:'我是顾夏'}, {quote:'是顾夏'}, {personName:'小陈',quote:'我可能是顾夏？'},
        {quote:'我可能是顾夏？'}, {accountId:(await account(b.id,'photo')).id,quote:'我可能是顾夏？'},
        {evidenceId:'post:unread',quote:'我可能是顾夏？'},
    ]) {
        const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!,cmd=await action(task.id);
        Object.assign(cmd.learnIdentities[0],override);
        expect(await landFriendFeedEmotionAction(a.id,{...cmd,kind:'post',text:'不能先把这条发出去'},'emotion')).toBe(false);
    }
    expect((await readFriendFeed()).posts).toHaveLength(1);expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
});
it('requires the actual owner or user as source, not a passerby revealing someone else',async()=>{
    await seed('半夜吃面是顾夏的小号。');
    await mutateFriendFeed(f=>{f.posts[0].authorId=c.id;f.posts[0].accountId='main';f.posts[0].authorName=c.name;});
    const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    expect(await landFriendFeedEmotionAction(a.id,await action(task.id,'post:reveal','半夜吃面是顾夏的小号。'),'emotion')).toBe(false);
    expect(knowsFriendAccount(await readFriendFeed(),a.id,await account())).toBe(false);
});
it('accepts a comment self-reveal and rejects content edited during the request',async()=>{
    await seed('今天吃面');await mutateFriendFeed(f=>{f.posts[0].comments.push({id:'reveal-comment',authorId:b.id,accountId:'rant',authorName:'半夜吃面',text:'我叫顾夏。',createdAt:Date.now()});});
    const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    await mutateFriendFeed(f=>{f.posts[0].comments[0].text='换了个说法';});
    expect(await landFriendFeedEmotionAction(a.id,await action(task.id,'comment:reveal-comment','我叫顾夏。'),'emotion')).toBe(false);
    await mutateFriendFeed(f=>{f.posts[0].comments[0].text='我叫顾夏。';});
    const fresh=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    expect(await landFriendFeedEmotionAction(a.id,await action(fresh.id,'comment:reveal-comment','我叫顾夏。'),'emotion')).toBe(true);
});
it('respects a relation change while the model is running',async()=>{
    await seed();const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    await updateFriendRelation({kind:'known',viewerId:a.id,targetId:(await account()).id,value:false});
    expect(await landFriendFeedEmotionAction(a.id,await action(task.id),'emotion')).toBe(false);
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
});
it('reads a user-shared self-reveal without enabling ambient reading or importing later comments',async()=>{
    await seed();const post=(await readFriendFeed()).posts[0];
    const disclosure=friendFeedUserDisclosure([{id:44,role:'user',type:'friend_feed_share_card',content:'分享卡',metadata:{friendFeedShare:{version:1,postId:post.id,text:post.text,comments:[]}}}])!;
    await mutateFriendFeed(f=>{f.posts[0].comments.push({id:'later',authorId:b.id,accountId:'photo',authorName:'慢半拍',text:'我也是顾夏的号。',createdAt:Date.now()});});
    const task=(await prepareFriendFeedMainTask(a.id,disclosure))!;
    expect(task.prompt).toContain('post:reveal');expect(task.prompt).not.toContain('comment:later');
    expect(await landFriendFeedEmotionAction(a.id,await action(task.id),'main')).toBe(true);
    expect(knowsFriendAccount(await readFriendFeed(),a.id,await account())).toBe(true);
    expect(knowsFriendAccount(await readFriendFeed(),a.id,await account(b.id,'photo'))).toBe(false);
});
it('can resolve an already-known public main nickname without revealing sibling accounts',async()=>{
    await updateFriendRelation({kind:'known',viewerId:a.id,targetId:(await account(b.id,'main')).id,value:true});
    const text='半夜吃面是下班再说的小号。',task=(await prepareFriendFeedMainTask(a.id,{id:'chat:22',text}))!;
    const cmd=await action(task.id,'user:chat:22',text);cmd.learnIdentities[0].personName='下班再说';
    expect(await landFriendFeedEmotionAction(a.id,cmd,'main')).toBe(true);
    expect(knowsFriendAccount(await readFriendFeed(),a.id,await account())).toBe(true);
});
