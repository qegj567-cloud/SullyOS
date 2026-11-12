import {beforeEach,expect,it,vi} from 'vitest';
import type {CharacterProfile,UserProfile} from '../types';
import {DB} from './db';
import {commentOnFriendPost,ensurePublicFriendFeed,mutateFriendFeed,parseFriendFeed,publishFriendPost,readFriendFeed,saveFriendFeedSettings,updateFriendRelation} from './friendFeed';
import {defaultFriendFeedSettings,resolveFriendFeedSettings} from './friendFeedSettings';
import {activeFriendAccounts,friendAccountName,friendAccountRef,knowsFriendAccount,projectFriendPost} from './friendFeedGraph';
import {landFriendFeedEmotionAction,prepareFriendFeedEmotionTask} from './friendFeedEmotion';
import {prepareFriendFeedMainTask} from './friendFeedMain';
import {shareFriendPost} from './friendFeedShare';

const chars=[{id:'a',name:'阿青',memories:[]},{id:'b',name:'小陈',memories:[]}] as unknown as CharacterProfile[];
const user={name:'小雨'} as UserProfile;
const settings=()=>({...defaultFriendFeedSettings(),userNickname:'雨点',userBio:'主号日常',userAccounts:[
    {id:'secret-rant',name:'不想上班',bio:'每天吐槽打工日常',purpose:'秘密用途不公开',tags:['职场']},
    {id:'secret-photo',name:'猫的相机',bio:'拍猫',purpose:'另一个秘密',tags:[]},
]});
beforeEach(async()=>{vi.restoreAllMocks();await DB.deleteDB();localStorage.clear();await DB.saveUserProfile(user);for(const char of chars)await DB.saveCharacter(char);await ensurePublicFriendFeed();await saveFriendFeedSettings(settings());});
async function ref(ownerId='user',accountId='secret-rant'){return friendAccountRef(await readFriendFeed(),{authorId:ownerId,accountId})!;}
async function post(text='又加班了'){return publishFriendPost('public',user.name,text,undefined,[],'secret-rant');}

it('keeps independent user accounts, historical authors and settings through rename, retirement and backup',async()=>{
    const id=await post(),before=await ref();
    const next=settings();next.userAccounts[0].name='已经下班';await saveFriendFeedSettings(next);
    let feed=await readFriendFeed();expect((await ref()).id).toBe(before.id);expect(friendAccountName(feed,before,chars)).toBe('已经下班');
    expect(feed.posts.find(p=>p.id===id)).toMatchObject({authorId:'user',accountId:'secret-rant',authorName:'不想上班',accountTags:['职场']});
    expect(parseFriendFeed(JSON.stringify(feed)).settings?.userAccounts).toEqual(feed.settings?.userAccounts);
    next.userAccounts=[];await saveFriendFeedSettings(next);feed=await readFriendFeed();
    expect(activeFriendAccounts(feed,chars).some(a=>a.id===before.id)).toBe(false);
    expect(friendAccountName(feed,before,chars)).toBe('不想上班');
    await expect(post('迟到发帖')).rejects.toThrow('账号已停用');
    await expect(commentOnFriendPost(id,user.name,'迟到评论',undefined,()=>0,undefined,'secret-rant')).rejects.toThrow('账号已停用');
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
    expect(resolveFriendFeedSettings({userNickname:'旧网名'}).userAccounts).toEqual([]);
});

it('does not reveal user alts through mutual follows; explicit knowledge is per account and observer',async()=>{
    const alias=await ref(),a=await ref('a','main');
    const before=await readFriendFeed(),main=await ref('user','main');
    expect(knowsFriendAccount(before,'a',main)).toBe(true);
    await updateFriendRelation({kind:'follow',sourceId:a.id,targetId:alias.id,value:true});
    await updateFriendRelation({kind:'follow',sourceId:alias.id,targetId:a.id,value:true});
    expect(knowsFriendAccount(await readFriendFeed(),'a',alias)).toBe(false);
    await updateFriendRelation({kind:'known',viewerId:'a',targetId:alias.id,value:true});
    const feed=await readFriendFeed();expect(knowsFriendAccount(feed,'a',alias)).toBe(true);
    expect(knowsFriendAccount(feed,'b',alias)).toBe(false);expect(knowsFriendAccount(feed,'a',await ref('user','secret-photo'))).toBe(false);
    expect(knowsFriendAccount(feed,'a',main)).toBe(true);
});

it('projects posts, comments, quotes and shared snapshots without user ownership or private account settings',async()=>{
    const id=await post();await commentOnFriendPost(id,user.name,'老板还没走','trigger',()=>0,undefined,'secret-rant');
    await commentOnFriendPost(id,user.name,'拍拍','reply',()=>0,{kind:'local',id:'trigger'},'secret-photo');
    const feed=await readFriendFeed(),projected=projectFriendPost(feed,'a',feed.posts[0]);
    const material=JSON.stringify(projected);expect(projected.accountBio).toBe('每天吐槽打工日常');
    expect(projected.authorId).toBe((await ref()).id);expect(projected.comments[1].localReply?.authorId).toBe((await ref()).id);
    for(const secret of ['"user"','secret-rant','secret-photo','秘密用途','另一个秘密'])expect(material).not.toContain(secret);
    await shareFriendPost(id,'a','share-alt');const messages=await DB.getMessagesByCharId('a',true);
    const snapshot=messages.find(m=>m.type==='friend_feed_share_card')!.metadata!.friendFeedShare!;
    expect(snapshot.authorId).toBe((await ref()).id);expect(snapshot.identity).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('"user"');expect(snapshot.accountBio).toBe('每天吐槽打工日常');
});

it.each(['emotion','immediate','main','comments','refresh'] as const)('keeps anonymous user materials anonymous in %s prompts',async source=>{
    const id=await post();await commentOnFriendPost(id,user.name,'还在办公室','trigger',()=>0,undefined,'secret-rant');
    if(source!=='immediate')await mutateFriendFeed(f=>{f.replyJobs=[];});
    await mutateFriendFeed(f=>{f.refreshLease={id:'lease',until:Date.now()+60000};f.notices=[{id:'notice',charId:'a',postId:id,createdAt:Date.now()}];});
    await updateFriendRelation({kind:'follow',sourceId:(await ref('a','main')).id,targetId:(await ref()).id,value:true});
    const feed=await readFriendFeed(),job=feed.replyJobs?.find(j=>j.charId==='a');
    const task=await prepareFriendFeedEmotionTask('a',()=>0,source==='immediate'?job!.id:undefined,source,source==='refresh'||source==='comments'?'self':undefined,id);
    expect(task).toBeDefined();expect(task!.prompt).toContain('每天吐槽打工日常');
    for(const secret of ['"authorId":"user"','"source":"用户说明"','secret-rant','秘密用途不公开','猫的相机','优先接用户在动态'])expect(task!.prompt).not.toContain(secret);
    // Main notification follow options may still identify the independently known main account.
    const materials=source==='main'?task!.prompt.split('公开材料：')[1]:task!.prompt;
    expect(materials).not.toContain('"identity":"小雨"');
});

it('recognizes a public self-disclosure for only that account and learns a private explicit disclosure',async()=>{
    await post('我是小雨，这个号拿来吐槽。');
    const task=(await prepareFriendFeedEmotionTask('a',()=>0))!,alias=await ref();
    expect(task.prompt).not.toContain('"source":"用户说明"');
    expect(await landFriendFeedEmotionAction('a',{requestId:task.id,kind:'none',learnIdentities:[{accountId:alias.id,personName:user.name,evidenceId:'post:'+(await readFriendFeed()).posts[0].id,quote:'我是小雨，这个号拿来吐槽。'}]},'emotion')).toBe(true);
    expect(knowsFriendAccount(await readFriendFeed(),'a',alias)).toBe(true);
    expect(knowsFriendAccount(await readFriendFeed(),'b',alias)).toBe(false);
    const other=await ref('user','secret-photo'),text='猫的相机是我的账号，我就是用户。';
    const disclosed=(await prepareFriendFeedMainTask('a',{id:'chat:7',text}))!;
    expect(await landFriendFeedEmotionAction('a',{requestId:disclosed.id,kind:'none',learnIdentities:[{accountId:other.id,personName:'用户',evidenceId:'user:chat:7',quote:text}]},'main')).toBe(true);
    expect(knowsFriendAccount(await readFriendFeed(),'a',other)).toBe(true);
});

it('rejects generated impersonation of an unused user alias and responses using stale knowledge',async()=>{
    const task=(await prepareFriendFeedEmotionTask('a',()=>0))!;
    expect(await landFriendFeedEmotionAction('a',{requestId:task.id,kind:'none',npcActions:[{kind:'post',name:'猫的相机',text:'冒名的新发言'}]},'emotion')).toBe(false);
    expect((await readFriendFeed()).posts).toHaveLength(0);
    await post();const pending=(await prepareFriendFeedEmotionTask('a',()=>0))!;
    await updateFriendRelation({kind:'known',viewerId:'a',targetId:(await ref()).id,value:true});
    expect(await landFriendFeedEmotionAction('a',{requestId:pending.id,kind:'post',text:'按旧认知发帖'},'emotion')).toBe(false);
});

it('does not treat an unrecognized user account as a trusted disclosure of someone else',async()=>{
    const next=settings();
    await saveFriendFeedSettings({...next,identities:{b:{tags:[],accounts:[{id:'b-alt',name:'晚风',purpose:'',tags:[]}]}}});
    const postId=await post('晚风是小陈的小号。');
    const task=(await prepareFriendFeedEmotionTask('a',()=>0))!;
    const other=friendAccountRef(await readFriendFeed(),{authorId:'b',accountId:'b-alt'})!;
    expect(await landFriendFeedEmotionAction('a',{requestId:task.id,kind:'none',learnIdentities:[{accountId:other.id,personName:'小陈',evidenceId:'post:'+postId,quote:'晚风是小陈的小号。'}]},'emotion')).toBe(false);
    expect(knowsFriendAccount(await readFriendFeed(),'a',other)).toBe(false);
});
