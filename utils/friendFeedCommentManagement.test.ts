import {beforeEach,expect,it} from 'vitest';
import {DB} from './db';
import {commentOnFriendPost,editFriendComment,deleteFriendComment,mutateFriendFeed,publishFriendPost,readFriendFeed,saveFriendCircle} from './friendFeed';
import {prepareFriendFeedEmotionTask,landFriendFeedEmotionAction} from './friendFeedEmotion';
const char={id:'manage-a',name:'小白',memories:[],mountedWorldbooks:[]} as any;
let postId:string;
beforeEach(async()=>{
    await DB.deleteDB();localStorage.clear();await DB.saveCharacter(char);
    const circle=await saveFriendCircle({name:'评论',description:'',memberIds:[char.id]});postId=await publishFriendPost(circle,'小雨','今天看了电影');
    await mutateFriendFeed(feed=>{feed.posts[0].comments=[{id:'c',authorId:char.id,authorName:char.name,text:'我也看了',createdAt:1},
        {id:'n',authorId:'npc:test',authorName:'路人',authorKind:'npc',text:'好看吗',createdAt:2,localReply:{id:'c',authorId:char.id,authorName:char.name,text:'我也看了'}}];});
});
it('edits character and NPC comments, updates quotes and protects another window’s edit',async()=>{
    await editFriendComment(postId,'c','昨天看的','我也看了');
    let post=(await readFriendFeed()).posts[0];
    expect(post.comments[0]).toMatchObject({text:'昨天看的',editedAt:expect.any(Number)});
    expect(post.comments[1].localReply?.text).toBe('昨天看的');
    await expect(editFriendComment(postId,'c','覆盖','我也看了')).rejects.toThrow('其他窗口');
    await expect(deleteFriendComment(postId,'c','我也看了')).rejects.toThrow('其他窗口');
    await editFriendComment(postId,'n','我打算明天去看','好看吗');
    expect((await readFriendFeed()).posts[0].comments[1].text).toBe('我打算明天去看');
});
it('deletes only the chosen comment and removes its quote/notice without deleting replies',async()=>{
    await mutateFriendFeed(f=>{f.userInbox=[{id:'notice',postId,commentId:'c',createdAt:2,kind:'post'}];});
    await deleteFriendComment(postId,'c','我也看了');
    const feed=await readFriendFeed();expect(feed.posts[0].comments).toHaveLength(1);
    expect(feed.posts[0].comments[0]).toMatchObject({id:'n',text:'好看吗'});
    expect(feed.posts[0].comments[0].localReply).toBeUndefined();expect(feed.userInbox).toEqual([]);
    await deleteFriendComment(postId,'c','我也看了');
});
it.each(['edit','delete'])('cancels pending immediate replies after %s, so stale output cannot reappear',async kind=>{
    const id=await commentOnFriendPost(postId,'小雨','要一起看吗','u',()=>0);
    const feed=await readFriendFeed(),job=feed.replyJobs![0];
    const task=(await prepareFriendFeedEmotionTask(char.id,()=>0,job.id))!;
    if(kind==='edit')await editFriendComment(postId,id,'我改天再看','要一起看吗');else await deleteFriendComment(postId,id,'要一起看吗');
    expect(await landFriendFeedEmotionAction(char.id,{requestId:task.id,kind:'comment',postId,comment:'一起吧'},'immediate')).toBe(false);
    expect((await readFriendFeed()).posts[0].comments.some(c=>c.text==='一起吧')).toBe(false);
});
it('invalidates a browsing snapshot after an unrelated comment was edited',async()=>{
    const task=(await prepareFriendFeedEmotionTask(char.id,()=>0))!;
    await editFriendComment(postId,'n','改过的讨论','好看吗');
    expect(await landFriendFeedEmotionAction(char.id,{requestId:task.id,postId,kind:'comment',comment:'根据旧评论接话'})).toBe(false);
});
