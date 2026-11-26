import {afterEach,expect,it,vi} from 'vitest';
import {DB,openDB} from './db';
import {loadCharacterContextMessages} from './chatContextRange';
import {buildChatRequestPayload} from './chatRequestPayload';
import {DatePrompts} from './datePrompts';
import {isVisibleChatMessage} from './chatMessageVisibility';
import type {CharacterProfile,UserProfile} from '../types';
import type {HomeRecord} from '../apps/room3d/types';
const user={name:'用户'} as UserProfile;
let seq=0;
const record=(id:string,text:string,kind:HomeRecord['kind']='message'):HomeRecord=>({id,text,kind,actor:kind==='message'?'user':'character',source:kind==='message'?'user':'model',at:1000,roomId:'living',roomName:'客厅'});
const character=(records:HomeRecord[])=>({id:'home-bridge-'+(++seq),name:'Sully',contextRangePolicyVersion:1,contextRangeMode:'manual',contextLimit:50,home3D:{records}} as CharacterProfile);
afterEach(()=>{vi.restoreAllMocks();localStorage.clear();});
it('home dialogue and actual actions reach the real private-chat payload alongside date history, once',async()=>{
 const char=character([record('m','家园约好看海'),record('a','Sully对用户开始拥抱','action')]);
 await DB.saveCharacter(char);
 await DB.saveMessage({charId:char.id,role:'assistant',type:'text',content:'见面一起吃饭',metadata:{source:'date'}});
 await DB.saveMessage({charId:char.id,role:'user',type:'text',content:'刚才我们做了什么？'});
 const rows=await loadCharacterContextMessages(char);
 const result=await buildChatRequestPayload({ scene: 'chat.private',char,userProfile:user,groups:[],emojis:[],categories:[],historyMsgs:rows,contextLimit:50,realtimeConfig:{weatherEnabled:false,newsEnabled:false} as any});
 const sent=JSON.stringify(result.fullMessages);
 expect(sent.match(/家园约好看海/g)).toHaveLength(1);
 expect(sent).toContain('[家园]');expect(sent).toContain('Sully对用户开始拥抱');expect(sent).toContain('[约会]');
 expect(rows.filter(m=>m.metadata?.source==='home').every(m=>!isVisibleChatMessage(m))).toBe(true);
 const date=(await DatePrompts.buildPeekPayload({char,userProfile:user,allMsgs:rows,emojis:[]}));
 expect(JSON.stringify(date.messages)).toContain('家园约好看海');
});
it('edits/deletes are mirrored, repeated saves preserve ids, and other characters are isolated',async()=>{
 const char=character([record('m','旧文字'),record('a','开始坐下','action')]);
 const other=character([record('m','别人家园')]);await DB.saveCharacter(other);await DB.saveCharacter(char);
 const before=await loadCharacterContextMessages(char);
 await DB.saveCharacter(char);expect((await loadCharacterContextMessages(char)).map(m=>m.id)).toEqual(before.map(m=>m.id));
 char.home3D!.records=[record('m','改后的文字')];await DB.saveCharacter(char);
 const after=await loadCharacterContextMessages(char);expect(after).toHaveLength(1);expect(after[0].id).toBe(before[0].id);expect(after[0].content).toContain('改后的文字');
 expect((await loadCharacterContextMessages(other))[0].content).toContain('别人家园');
 char.home3D!.records=[];await DB.saveCharacter(char);expect(await loadCharacterContextMessages(char)).toEqual([]);
});
it('migrates persisted pre-bridge journals once even when the caller has stale character data',async()=>{
 const char=character([record('old','以前的家园对话')]);const db=await openDB();
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('characters','readwrite');tx.objectStore('characters').put(char);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
 const stale={...char,home3D:undefined};const first=await loadCharacterContextMessages(stale);
 expect(first).toHaveLength(1);expect(first[0].content).toContain('以前的家园对话');
 expect((await loadCharacterContextMessages(stale)).map(m=>m.id)).toEqual(first.map(m=>m.id));
});
it('shared context breakpoints exclude home rows without a core-context bypass',async()=>{
 const char=character([record('m','范围外家园文字')]);await DB.saveCharacter(char);
 const id=await DB.saveMessage({charId:char.id,role:'user',type:'text',content:'新问题'});char.contextUserStartMessageId=id;
 const rows=await loadCharacterContextMessages(char);expect(rows).toHaveLength(1);
 const result=await buildChatRequestPayload({ scene: 'chat.private',char,userProfile:user,groups:[],emojis:[],categories:[],historyMsgs:rows,contextLimit:50,realtimeConfig:{weatherEnabled:false,newsEnabled:false} as any});
 expect(JSON.stringify(result.fullMessages)).not.toContain('范围外家园文字');
});
it('aborting message projection also rolls back the room journal',async()=>{
 const char=character([]);await DB.saveCharacter(char);const add=IDBObjectStore.prototype.add;
 vi.spyOn(IDBObjectStore.prototype,'add').mockImplementation(function(this:IDBObjectStore,...args:any[]){
  if(this.name==='messages'){this.transaction.abort();return {} as IDBRequest;}
  return add.apply(this,args as any);
 });
 char.home3D!.records=[record('m','不能只保存一半')];await expect(DB.saveCharacter(char)).rejects.toThrow();
 expect((await DB.getCharacter(char.id))?.home3D?.records).toEqual([]);
});

it('concurrent retries serialize without duplicating a journal event',async()=>{
 const char=character([record('m','同一条家园消息')]);
 await Promise.all([DB.saveCharacter(char),DB.saveCharacter(char),DB.ensureHomeContextMessages(char.id)]);
 expect(await loadCharacterContextMessages(char)).toHaveLength(1);
});
it('adaptive context watermarks also cover home messages',async()=>{
 const char=character([record('m','已归档的家园原文')]);await DB.saveCharacter(char);
 const rows=await loadCharacterContextMessages(char);localStorage.setItem('mp_lastMsgId_'+char.id,String(rows[0].id));
 expect(await loadCharacterContextMessages({...char,contextRangeMode:'adaptive',autoArchiveEnabled:true})).toEqual([]);
});

it('updates only the changed home turn and makes it visible to the next queued context read',async()=>{
 const char=character([record('m','旧内容')]);await DB.saveCharacter(char);
 await DB.saveMessage({charId:char.id,role:'user',type:'text',content:'普通私聊保留'});
 const scan=vi.spyOn(IDBIndex.prototype,'openCursor');
 char.home3D!.records=[record('m','刚改好的内容')];
 const saving=DB.saveCharacter(char);
 const reading=loadCharacterContextMessages(char);
 await saving;const rows=await reading;
 expect(rows.some(m=>m.content.includes('刚改好的内容'))).toBe(true);
 expect(rows.some(m=>m.content.includes('旧内容'))).toBe(false);
 expect(rows.some(m=>m.content==='普通私聊保留')).toBe(true);
 const writes=scan.mock.contexts.filter(index=>index.objectStore.transaction.mode==='readwrite');
 expect(writes.map(index=>index.name)).toEqual(['charId','charId_homeTurn']);
});
