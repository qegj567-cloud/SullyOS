import {beforeEach,expect,it} from 'vitest';
import {DB} from './db';
import {commentOnFriendPost,mutateFriendFeed,publishFriendPost,readFriendFeed,saveFriendCircle,saveFriendFeedSettings,type FriendComment} from './friendFeed';
import {defaultFriendFeedSettings,DEFAULT_FRIEND_NPC_PROMPT,resolveFriendFeedSettings} from './friendFeedSettings';
import {prepareFriendFeedEmotionTask,landFriendFeedEmotionAction} from './friendFeedEmotion';
import {friendCommentThreads} from './friendFeedThreads';
import {friendUserInbox} from './friendFeedInbox';
import type {CharacterProfile} from '../types';

const a={id:'thread-a',name:'阿白',memories:[],mountedWorldbooks:[]} as unknown as CharacterProfile;
const b={...a,id:'thread-b',name:'阿绿'};
let postId:string;
beforeEach(async()=>{await DB.deleteDB();localStorage.clear();await DB.saveCharacter(a);await DB.saveCharacter(b);
    const circle=await saveFriendCircle({name:'广场',description:'',memberIds:[a.id,b.id]});postId=await publishFriendPost(circle,'用户','讨论做饭');
});
const comment=(id:string,parent?:string):FriendComment=>({id,authorId:'npc:'+id,authorName:id,text:id,createdAt:1,
    ...(parent?{localReply:{id:parent,authorId:'npc:'+parent,authorName:parent,text:parent}}:{})});
it('groups deep and out-of-order replies once, retaining orphaned and cyclic imports',()=>{
    const groups=friendCommentThreads([comment('c','b'),comment('a'),comment('b','a'),comment('unrelated'),comment('orphan','gone'),comment('x','y'),comment('y','x')]);
    expect(groups.find(g=>g.root.id==='a')?.replies.map(c=>c.id)).toEqual(['c','b']);
    expect(groups.flatMap(g=>[g.root,...g.replies]).map(c=>c.id).sort()).toEqual(['a','b','c','orphan','unrelated','x','y']);
});
it('persists a user reply to a specific character and chooses that character’s context',async()=>{
    await mutateFriendFeed(f=>{f.posts[0].authorId=a.id;f.posts[0].authorName=a.name;
        f.posts[0].comments.push({...comment('root'),authorId:b.id,authorName:b.name});});
    await commentOnFriendPost(postId,'用户','说的这个什么意思','u',()=>0,{kind:'local',id:'root'});
    const feed=await readFriendFeed();expect(feed.posts[0].comments.at(-1)?.localReply).toMatchObject({id:'root',authorId:b.id});
    expect(feed.replyJobs![0].charId).toBe(b.id);
    expect((await DB.getMessagesByCharId(a.id,true))[0].content).toContain('自己'+ '的动态收到评论');
    expect((await DB.getMessagesByCharId(b.id,true))[0].content).toContain('自己的评论收到回复');
    const task=(await prepareFriendFeedEmotionTask(b.id,()=>0,feed.replyJobs![0].id))!;
    expect(task.prompt).toContain('说的这个什么意思');
    await landFriendFeedEmotionAction(b.id,{requestId:task.id,kind:'comment',postId,comment:'说的是火候'});
    const result=await readFriendFeed();expect(friendCommentThreads(result.posts[0].comments)).toHaveLength(1);
    expect(friendUserInbox(result)).toHaveLength(1);
});
it('rejects missing user reply targets without saving a top-level comment or memory',async()=>{
    await expect(commentOnFriendPost(postId,'用户','你好','u',()=>0,{kind:'local',id:'missing'})).rejects.toThrow('已不存在');
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
});
it('quotes a cached Weibo original locally, without mistaking its author for a local character',async()=>{
    await mutateFriendFeed(f=>{const post=f.posts[0];post.source={platform:'weibo',accountId:'123456',externalId:'111111',author:'原帖作者',text:post.text,
        url:'https://weibo.com/123456/111111',publishedAt:Date.now(),fetchedAt:Date.now(),truncated:false,images:[]};
        post.weiboComments={rows:[{id:'777777',authorId:'654321',authorName:'原评论者',text:'原站的一句话',createdAt:Date.now()}],cursor:null,fetchedAt:Date.now()};});
    await commentOnFriendPost(postId,'用户','在这里回复','u',()=>0,{kind:'source',id:'777777'});
    const feed=await readFriendFeed();expect(feed.posts[0].comments[0].sourceReply).toMatchObject({id:'777777',text:'原站的一句话'});
    expect(feed.posts[0].comments[0].localReply).toBeUndefined();expect(feed.posts[0].weiboComments!.rows).toHaveLength(1);
});
it('accepts emojis, long expert comments and same-batch NPC replies as one nested conversation',async()=>{
    const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    expect(task.prompt).toContain(DEFAULT_FRIEND_NPC_PROMPT);expect(task.prompt).toContain('replyToNpcIndex');
    const action={requestId:task.id,kind:'none',npcActions:[
        {kind:'comment',name:'不知道',postId,text:'？'},
        {kind:'comment',name:'锅盖',postId,text:'具体解释。'.repeat(60),replyToNpcIndex:0},
        {kind:'comment',name:'小狗头像',postId,text:'🫠',replyToNpcIndex:1},
    ]};
    expect(await landFriendFeedEmotionAction(a.id,action)).toBe(true);
    const feed=await readFriendFeed(),threads=friendCommentThreads(feed.posts[0].comments);
    expect(threads).toHaveLength(1);expect(threads[0].replies).toHaveLength(2);
    expect(threads[0].replies[1].localReply?.id).toBe(threads[0].replies[0].id);
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
});
it.each([-1,1,2,.5,'0'])('rejects invalid same-batch reference %s without partial publication',async index=>{
    const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    expect(await landFriendFeedEmotionAction(a.id,{requestId:task.id,kind:'none',npcActions:[
        {kind:'comment',name:'一号',postId,text:'啊'},
        {kind:'comment',name:'二号',postId,text:'嗯',replyToNpcIndex:index},
    ]})).toBe(false);
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(0);
});
it('delivers a reply receipt to the actual character commenter on someone else’s post',async()=>{
    await mutateFriendFeed(f=>{f.posts[0].comments.push({...comment('root'),authorId:b.id,authorName:b.name});});
    const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
    expect(await landFriendFeedEmotionAction(a.id,{requestId:task.id,kind:'none',npcActions:[{kind:'comment',name:'路过',postId,text:'真的假的',replyToCommentId:'root'}]})).toBe(true);
    const notes=await DB.getMessagesByCharId(b.id,true);expect(notes).toHaveLength(1);expect(notes[0].content).toContain('自己的评论收到回复');
    expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
});
it('keeps a separate custom NPC prompt, upgrades old settings and treats empty as the natural default',async()=>{
    expect(resolveFriendFeedSettings({interactionPrompt:'总风格'}).npcPrompt).toBe(DEFAULT_FRIEND_NPC_PROMPT);
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),npcPrompt:'网友爱聊烤箱温度'});
    expect((await prepareFriendFeedEmotionTask(a.id,()=>0))!.prompt).toContain('网友爱聊烤箱温度');
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),npcPrompt:''});
    expect((await prepareFriendFeedEmotionTask(a.id,()=>0))!.prompt).toContain(DEFAULT_FRIEND_NPC_PROMPT);
});
