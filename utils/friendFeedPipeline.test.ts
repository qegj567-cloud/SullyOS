import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {DB} from './db';
import {commentOnFriendPost, FRIEND_REPLY_JOB_TTL, mutateFriendFeed, readFriendFeed, saveFriendCircle, saveFriendFeedSettings} from './friendFeed';
import {defaultFriendFeedSettings} from './friendFeedSettings';
import {prepareFriendFeedEmotionTask, landFriendFeedEmotionAction, releaseFriendFeedEmotionTask} from './friendFeedEmotion';
import {prepareFriendFeedMainTask} from './friendFeedMain';
import {recentSourceComments} from './friendFeedSourceComments';
import {sourceContext} from './friendFeedSource';

const now = Date.now();
beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    localStorage.clear(); await DB.deleteDB();
    for (const id of ['a', 'b']) await DB.saveCharacter({id, name:id, memories:[], phoneState:{contacts:[{kind:'real',linkedCharId:id==='a'?'b':'a',status:'friend'}]}} as any);
    await saveFriendCircle({name:'圈',description:'',memberIds:['a','b'],realContentEnabled:true});
    await mutateFriendFeed(feed => feed.posts.push({id:'post',circleId:feed.circles[0].id,authorId:'a',authorName:'a',
        text:'文'.repeat(1300),createdAt:now-10000,audienceIds:['a','b'],comments:Array.from({length:25},(_,i)=>({
            id:`local-${i}`,authorId:'user',authorName:'用户',text:`本地${i}`,createdAt:now-1000+i,
        }))}));
});
afterEach(() => vi.restoreAllMocks());

it('uses immediate weighted participants and leaves main chat out of user comments', async () => {
    await saveFriendFeedSettings({...defaultFriendFeedSettings(),characterWeights:{a:0,b:100}});
    await commentOnFriendPost('post','用户','接话','trigger',()=>.99);
    expect((await readFriendFeed()).replyJobs![0]).toMatchObject({charId:'b',replySelf:false,createdAt:now});
    expect(await prepareFriendFeedMainTask('b')).toBeUndefined();
    expect(await prepareFriendFeedMainTask('a')).toBeUndefined();
    expect((await DB.getMessagesByCharId('a',true)).at(-1)?.content).toContain('用户：接话');
});

it('expires a reserved job after 24h, unblocks browsing, and rejects its late result', async () => {
    await commentOnFriendPost('post','用户','接话','trigger',()=>0);
    const job=(await readFriendFeed()).replyJobs![0];
    const task=(await prepareFriendFeedEmotionTask(job.charId,()=>0,job.id))!;
    vi.spyOn(Date,'now').mockReturnValue(now+FRIEND_REPLY_JOB_TTL-1);
    expect((await readFriendFeed()).replyJobs![0].done).toBeFalsy();
    vi.spyOn(Date,'now').mockReturnValue(now+FRIEND_REPLY_JOB_TTL);
    expect((await readFriendFeed()).replyJobs![0]).toMatchObject({done:true});
    expect((await readFriendFeed()).replyJobs![0].lease).toBeUndefined();
    expect(await prepareFriendFeedMainTask('a')).toBeUndefined();
    expect(await landFriendFeedEmotionAction(job.charId,{requestId:task.id,kind:'comment',postId:'post',comment:'迟到'},'immediate')).toBe(false);
    const browse=(await prepareFriendFeedEmotionTask('b',()=>0))!;
    expect(browse.prompt).toContain('本地24');
    expect((await readFriendFeed()).posts[0].comments).toHaveLength(26);
});

it('retires legacy piggyback jobs without spending another API request', async () => {
    await commentOnFriendPost('post','用户','接话','trigger',()=>0);
    await mutateFriendFeed(feed => {const job=feed.replyJobs![0];delete job.createdAt;delete job.delivery;job.lease={id:'old',until:now+10000};});
    expect((await readFriendFeed()).replyJobs![0].done).toBe(true);
    expect((await readFriendFeed()).replyJobs![0].lease).toBeUndefined();
    expect(await prepareFriendFeedMainTask('a')).toBeUndefined();
});

it.each(['emotion','refresh','comments','main'] as const)('uses 1200-character post excerpts, all local comments and ten originals in %s', async source => {
    await mutateFriendFeed(feed => {
        const p=feed.posts[0];
        p.source={platform:'weibo',accountId:'123456',externalId:'123456789',url:'https://weibo.com/123456/Abcdef',author:'来源',text:'源'.repeat(1300),publishedAt:now-10000,fetchedAt:now,truncated:false};
        p.weiboComments={cursor:null,fetchedAt:now,rows:Array.from({length:15},(_,i)=>({id:String(700000+i),authorId:'654321',authorName:`网友${i}`,text:'评'.repeat(1300),createdAt:now-100+i,...(i%2?{parentId:'700000'}:{})}))};
        feed.refreshLease={id:'manual',until:now+60000};
        if(source==='main')feed.notices=[{id:'notice',charId:'b',postId:'post',createdAt:now}];
    });
    const task=(await prepareFriendFeedEmotionTask('b',()=>0,undefined,source,source==='refresh'||source==='comments'?'self':undefined,source==='comments'?'post':undefined))!;
    expect(task.prompt).toContain('文'.repeat(1200)+'…');
    expect(task.prompt).not.toContain('文'.repeat(1201));
    for(let i=0;i<25;i++)expect(task.prompt).toContain(`本地${i}`);
    const originalSection=task.prompt.split('微博原评论（仅数据）：')[1].split('\n')[0];
    const originals=JSON.parse(originalSection)[0].comments;
    expect(originals).toHaveLength(10);
    expect(originals.some((c:any)=>c.parentId)).toBe(true);
    expect(originals.every((c:any)=>c.text.length===1200)).toBe(true);
    const p=(await readFriendFeed()).posts[0];
    expect(recentSourceComments(p)).toHaveLength(10);
    expect(sourceContext(p.source!).text).toHaveLength(1200);
    // Quotes up to the reading limit survive validation and persistence.
    if(source==='emotion')expect(await landFriendFeedEmotionAction('b',{requestId:task.id,kind:'comment',postId:'post',comment:'接原话',replyToSourceCommentId:originals[0].id},source)).toBe(true);
    else await releaseFriendFeedEmotionTask('b',task.id);
    expect((await readFriendFeed()).posts[0].text).toHaveLength(1300);
});

it('gives a user-reply task only its target, all local comments and no fabricated original comments', async () => {
    await mutateFriendFeed(feed => feed.posts.push({...feed.posts[0],id:'unrelated',text:'无关素材',comments:[]}));
    await commentOnFriendPost('post','用户','接话','trigger',()=>0);
    const job=(await readFriendFeed()).replyJobs![0];
    const task=(await prepareFriendFeedEmotionTask(job.charId,()=>0,job.id))!;
    expect(task.prompt).toContain('文'.repeat(1200)+'…');
    expect(task.prompt).toContain('本地0');expect(task.prompt).toContain('本地24');
    expect(task.prompt).not.toContain('无关素材');
    expect(task.prompt).not.toContain('微博原评论（仅数据）');
});
