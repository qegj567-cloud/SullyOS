import {beforeEach, expect, it, vi} from 'vitest';
import {DB} from './db';
import {commentOnFriendPost, deleteFriendPost, mutateFriendFeed, parseFriendFeed, publishFriendPost, readFriendFeed, saveFriendCircle} from './friendFeed';
import {prepareFriendFeedEmotionTask,landFriendFeedEmotionAction} from './friendFeedEmotion';
import {prepareFriendFeedMainTask,consumeFriendFeedMainReply} from './friendFeedMain';
import {claimFriendInboxAnnouncements,friendUserInbox,markFriendInboxRead} from './friendFeedInbox';
import type {CharacterProfile} from '../types';

const char={id:'inbox-a',name:'阿白',systemPrompt:'',memories:[],mountedWorldbooks:[]} as unknown as CharacterProfile;
let circle:string,postId:string;
beforeEach(async()=>{await DB.deleteDB();localStorage.clear();await DB.saveCharacter(char);
    circle=await saveFriendCircle({name:'广场',description:'',memberIds:[char.id]});
    postId=await publishFriendPost(circle,'小雨','今天做了咖啡');
});
const npcs=(count=6)=>Array.from({length:count},(_,i)=>({kind:'comment',name:`围观网友${i}`,postId,text:`接梗${i}`}));

it('lands six NPC comments with six durable notices, no host action card and no duplicates on replay',async()=>{
    const task=(await prepareFriendFeedEmotionTask(char.id,()=>0))!;
    expect(task.prompt).toContain('3–6 位');
    const action={requestId:task.id,kind:'none',npcActions:npcs()};
    expect(await landFriendFeedEmotionAction(char.id,action)).toBe(true);
    expect(await landFriendFeedEmotionAction(char.id,action)).toBe(false);
    const feed=await readFriendFeed();expect(feed.posts[0].comments).toHaveLength(6);
    expect(friendUserInbox(feed)).toHaveLength(6);
    expect(await DB.getMessagesByCharId(char.id,true)).toHaveLength(0);
    const claims=await Promise.all([claimFriendInboxAnnouncements(),claimFriendInboxAnnouncements()]);
    expect(claims.map(c=>c.length).sort()).toEqual([0,6]);
    expect(friendUserInbox(await readFriendFeed()).every(r=>!r.notice.read&&r.notice.announced)).toBe(true);
});
it('does not accept seven NPCs or turn the larger comment allowance into extra posts',async()=>{
    const task=(await prepareFriendFeedEmotionTask(char.id,()=>0))!;
    expect(await landFriendFeedEmotionAction(char.id,{requestId:task.id,kind:'none',npcActions:npcs(7)})).toBe(false);
    expect(await landFriendFeedEmotionAction(char.id,{requestId:task.id,kind:'none',npcActions:npcs(4).map(n=>({...n,kind:'post'}))})).toBe(false);
    expect(friendUserInbox(await readFriendFeed())).toHaveLength(0);
});
it('rolls back the user notice with its comment when writing the character memory card fails',async()=>{
    const task=(await prepareFriendFeedEmotionTask(char.id,()=>0))!;
    const action={requestId:task.id,kind:'comment',postId,comment:'我来啦'};
    const add=IDBObjectStore.prototype.add;
    const spy=vi.spyOn(IDBObjectStore.prototype,'add').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['add']>){
        if(this.name==='messages')throw new Error('card failed');return add.apply(this,args);
    });
    try{await expect(landFriendFeedEmotionAction(char.id,action)).rejects.toThrow('card failed');
        const feed=await readFriendFeed();expect(friendUserInbox(feed)).toHaveLength(0);expect(feed.posts[0].comments).toHaveLength(0);
    }finally{spy.mockRestore();}
    expect(await landFriendFeedEmotionAction(char.id,action)).toBe(true);
    expect(friendUserInbox(await readFriendFeed())).toHaveLength(1);
});
it('uses explicit local comment IDs to notify replies on someone else’s post without mistaking ordinary comments',async()=>{
    await mutateFriendFeed(feed=>{feed.posts[0].authorId=char.id;feed.posts[0].authorName=char.name;
        feed.posts[0].comments.push({id:'user-line',authorId:'user',authorName:'小雨',text:'我也要一杯',createdAt:Date.now()},
            {id:'npc-line',authorId:'npc:other',authorName:'路人',text:'巧了',createdAt:Date.now()});});
    const task=(await prepareFriendFeedEmotionTask(char.id,()=>0))!;
    expect(task.prompt).toContain('replyToCommentId');
    const action={requestId:task.id,kind:'none',npcActions:npcs(3).map((n,i)=>({...n,replyToCommentId:i===0?'user-line':i===1?'npc-line':undefined}))};
    expect(await landFriendFeedEmotionAction(char.id,action)).toBe(true);
    const feed=await readFriendFeed(),rows=friendUserInbox(feed);
    expect(rows).toHaveLength(1);expect(rows[0].notice.kind).toBe('reply');
    expect(rows[0].comment.localReply).toMatchObject({id:'user-line',authorId:'user'});
    const notes=await DB.getMessagesByCharId(char.id,true);
    expect(notes).toHaveLength(1);expect(notes[0].content).toContain('收到');
});
it.each(['missing','changed','other-post'])('rejects a %s reply target atomically',async mode=>{
    const other=await publishFriendPost(circle,'小雨','另一条');
    await mutateFriendFeed(feed=>{feed.posts.find(p=>p.id===postId)!.comments.push({id:'u',authorId:'user',authorName:'小雨',text:'评论',createdAt:Date.now()});});
    const task=(await prepareFriendFeedEmotionTask(char.id,()=>0))!;
    if(mode==='changed')await mutateFriendFeed(feed=>{feed.posts.find(p=>p.id===postId)!.comments[0].text='改了';});
    expect(await landFriendFeedEmotionAction(char.id,{requestId:task.id,kind:'comment',postId:mode==='other-post'?other:postId,comment:'回复',replyToCommentId:mode==='missing'?'bad':'u'})).toBe(false);
    expect(friendUserInbox(await readFriendFeed())).toHaveLength(0);
    expect(await DB.getMessagesByCharId(char.id,true)).toHaveLength(0);
});
it('immediate jobs attach the user trigger automatically for both self and NPC replies',async()=>{
    await mutateFriendFeed(feed=>{feed.posts[0].authorId=char.id;feed.posts[0].authorName=char.name;});
    await commentOnFriendPost(postId,'小雨','有人吗','trigger',()=>0);
    const job=(await readFriendFeed()).replyJobs![0];expect(job.npcCount).toBe(3);
    const task=(await prepareFriendFeedEmotionTask(char.id,()=>0,job.id))!;
    expect(await landFriendFeedEmotionAction(char.id,{requestId:task.id,kind:'comment',postId,comment:'在',npcActions:npcs(3)})).toBe(true);
    const rows=friendUserInbox(await readFriendFeed());expect(rows).toHaveLength(4);
    expect(rows.every(r=>r.notice.kind==='reply'&&r.comment.localReply?.id==='trigger')).toBe(true);
});
it('main API text actions share the same inbox and allow lively NPC replies in one result',async()=>{
    const task=(await prepareFriendFeedMainTask(char.id))!;
    expect(task).toBeTruthy();
    const raw='好呀。[[FRIEND_FEED_REPLY:'+JSON.stringify({requestId:task.id,kind:'comment',postId,comment:'来了',npcActions:npcs()})+']]';
    expect(await consumeFriendFeedMainReply(char.id,raw)).toBe('好呀。');
    expect(friendUserInbox(await readFriendFeed())).toHaveLength(7);
    expect(await DB.getMessagesByCharId(char.id,true)).toHaveLength(1);
});
it('read acknowledgement uses a snapshot, deletion clears notices, and old data is not backfilled',async()=>{
    const task=(await prepareFriendFeedEmotionTask(char.id,()=>0))!;
    await landFriendFeedEmotionAction(char.id,{requestId:task.id,kind:'none',npcActions:npcs()});
    const feed=await readFriendFeed(),ids=friendUserInbox(feed).slice(0,2).map(r=>r.notice.id);
    await markFriendInboxRead(ids);
    expect(friendUserInbox(await readFriendFeed()).filter(r=>!r.notice.read)).toHaveLength(4);
    delete feed.userInbox;expect(friendUserInbox(parseFriendFeed(JSON.stringify(feed)))).toHaveLength(0);
    await deleteFriendPost(postId);expect((await readFriendFeed()).userInbox).toEqual([]);
});
