import {beforeEach,expect,it,vi} from 'vitest';
import type {CharacterProfile,UserProfile} from '../types';
import {DB} from './db';
import {ensurePublicFriendFeed,readFriendFeed,parseFriendFeed,mutateFriendFeed} from './friendFeed';
import {prepareFriendFeedEmotionTask,landFriendFeedEmotionAction} from './friendFeedEmotion';
import {prepareFriendFeedMainTask} from './friendFeedMain';
import {shareFriendPost} from './friendFeedShare';
import {friendPostImages,friendPostImageHint,friendPostMediaCount} from './friendFeedImages';
import {stripBackupImages} from './backupExport';
const a={id:'photo-a',name:'阿青',memories:[]} as unknown as CharacterProfile;
const b={id:'photo-b',name:'顾夏',memories:[]} as unknown as CharacterProfile;
const cards=[{caption:'杯子里的下午',description:'半杯冰水放在窗台上，杯壁凝着水珠。阳光在木桌上留下一个晃动的光圈。'}];
beforeEach(async()=>{vi.restoreAllMocks();await DB.deleteDB();localStorage.clear();await DB.saveCharacter(a);await DB.saveCharacter(b);await DB.saveUserProfile({name:'小雨'} as UserProfile);await ensurePublicFriendFeed();});
async function publish(text=''){
 const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
 expect(task.prompt).toContain('imageCards');
 expect(await landFriendFeedEmotionAction(a.id,{requestId:task.id,kind:'post',text,imageCards:cards},'emotion')).toBe(true);
 return (await readFriendFeed()).posts[0];
}
it('publishes image-only descriptions, persists own memory and includes them in other characters browsing',async()=>{
 const post=await publish();expect(post.imageCards).toEqual(cards);expect(friendPostImages(post)).toEqual([]);expect(friendPostMediaCount(post)).toBe(1);
 const notes=await DB.getMessagesByCharId(a.id,true);expect(notes).toHaveLength(1);expect(notes[0].content).toContain(cards[0].description);
 expect(notes[0].content).toContain('无真实图片像素');expect(await DB.getMessagesByCharId(b.id,true)).toHaveLength(0);
 const task=(await prepareFriendFeedEmotionTask(b.id,()=>0))!;expect(task.prompt).toContain(cards[0].description);
 expect(friendPostImageHint(post)).toContain('作者描述');
 expect(await landFriendFeedEmotionAction(b.id,{requestId:task.id,kind:'comment',postId:post.id,comment:'猫耳朵呢'},'emotion')).toBe(true);
 expect((await DB.getMessagesByCharId(b.id,true))[0].content).toContain(cards[0].description);
});
it('preserves cards in text backups and shared chat without downloading or sending images to vision',async()=>{
 const post=await publish('今天的光很好');
 const feed=await readFriendFeed();expect(parseFriendFeed(JSON.stringify(stripBackupImages(feed))).posts[0].imageCards).toEqual(cards);
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 try{await shareFriendPost(post.id,b.id,'image-card-share');
 const note=(await DB.getMessagesByCharId(b.id,true))[0];expect(note.metadata.friendFeedShare.imageCards).toEqual(cards);
 expect(note.metadata.friendFeedShare.imageRefs).toEqual([]);expect(note.content).toContain(cards[0].description);expect(fetcher).not.toHaveBeenCalled();
 }finally{vi.unstubAllGlobals();}
});
it('supports NPC image cards without NPC memory and supplies the format to main publication notices',async()=>{
 const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
 expect(await landFriendFeedEmotionAction(a.id,{requestId:task.id,kind:'none',npcActions:[{kind:'post',name:'隔壁吃面',text:'',imageCards:cards}]},'emotion')).toBe(true);
 expect((await readFriendFeed()).posts[0].imageCards).toEqual(cards);expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
 await mutateFriendFeed(f=>{f.notices=[{id:'photo-notice',postId:f.posts[0].id,charId:a.id,createdAt:Date.now()}];f.posts[0].authorId=a.id;delete f.posts[0].authorKind;});
 expect((await prepareFriendFeedMainTask(a.id))!.prompt).toContain('imageCards');
});
it('rejects URLs, oversized descriptions, comment images and malformed backups atomically',async()=>{
 for(const imageCards of [[{...cards[0],url:'https://example.com/p.png'}],Array(4).fill(cards[0]),[{caption:'标题',description:'字'.repeat(601)}]]){
 const task=(await prepareFriendFeedEmotionTask(a.id,()=>0))!;
 expect(await landFriendFeedEmotionAction(a.id,{requestId:task.id,kind:'post',text:'不能留下',imageCards},'emotion')).toBe(false);
 // Malformed outer actions never consume the request; release for the next independent attempt.
 const {releaseFriendFeedEmotionTask}=await import('./friendFeedEmotion');await releaseFriendFeedEmotionTask(a.id,task.id);
 }
 expect((await readFriendFeed()).posts).toHaveLength(0);expect(await DB.getMessagesByCharId(a.id,true)).toHaveLength(0);
 const post=await publish();const task=(await prepareFriendFeedEmotionTask(b.id,()=>0))!;
 expect(await landFriendFeedEmotionAction(b.id,{requestId:task.id,kind:'comment',postId:post.id,comment:'嘿',imageCards:cards},'emotion')).toBe(false);
 const feed=await readFriendFeed();(feed.posts[0] as any).imageCards=[{description:4}];expect(()=>parseFriendFeed(JSON.stringify(feed))).toThrow();
});
it('invalidates stale descriptions and allows distinct image-only posts after the cooldown',async()=>{
 await publish();const task=(await prepareFriendFeedEmotionTask(b.id,()=>0))!;
 await mutateFriendFeed(f=>{f.posts[0].imageCards![0].description='画面已经变成一盆花';f.posts[0].createdAt=1;});
 expect(await landFriendFeedEmotionAction(b.id,{requestId:task.id,kind:'comment',postId:(await readFriendFeed()).posts[0].id,comment:'过期图片'},'emotion')).toBe(false);
 await publish();expect((await readFriendFeed()).posts).toHaveLength(2);
});
