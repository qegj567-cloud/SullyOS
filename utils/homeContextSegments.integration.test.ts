import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DB,openDB} from './db';
import {loadCharacterContextRange} from './chatContextRange';
import {buildChatRequestPayload} from './chatRequestPayload';
import {buildHomeConversationPayload} from './homeConversation';
import {ChatPrompts} from './chatPrompts';
import {withChatContinuation,hasUnansweredUserTurn} from './chatContinuation';
import * as palace from './memoryPalace/pipeline';
import type {CharacterProfile,Message} from '../types';
import type {HomeRecord} from '../apps/room3d/types';
const inbox=vi.hoisted(()=>vi.fn());
vi.mock('./activeMsgRuntime',()=>({prepareInboxBeforeChat:inbox}));
const event=(id:string,at:number,kind:HomeRecord['kind']='action',actor:HomeRecord['actor']='character',replyTo?:string):HomeRecord=>({id,at,kind,actor,replyTo,source:actor==='user'?'user':'model',text:id,roomId:'r',roomName:'客厅'});
let seq=0;
const character=(records:HomeRecord[]):CharacterProfile=>({id:'segment-integration-'+(++seq),name:'C',contextRangePolicyVersion:1,contextRangeMode:'adaptive',autoArchiveEnabled:true,home3D:{records}} as CharacterProfile);
const user:any={name:'U'},scene:any={roomId:'r',roomName:'客厅',present:true,busy:false,actions:[]};
const args=(char:CharacterProfile,records=char.home3D!.records)=>({char,user,api:{} as any,scene,records,signal:new AbortController().signal,context:{groups:[],emojis:[],categories:[],realtimeConfig:{weatherEnabled:false,newsEnabled:false} as any}});
const range=(char:CharacterProfile)=>loadCharacterContextRange(char);
const body=(rows:Message[],char:CharacterProfile)=>ChatPrompts.buildMessageHistory(rows,rows.length,char,user,[],undefined,{contextHighWaterMark:0}).apiMessages;
beforeEach(()=>{localStorage.clear();inbox.mockReset();inbox.mockResolvedValue('completed');});
afterEach(()=>{vi.restoreAllMocks();localStorage.clear();});

it('persists the user example as six segments with independent speaker roles',async()=>{
 const records=[event('事1',1),event('事2',2),event('事3',3),event('用户发言',4,'message','user'),event('角色回复',5,'message'),event('事4',6),event('事5',7,'action','user'),event('角色主动开口',8,'message'),event('用户接话',9,'message','user')];
 const char=character([]);await DB.saveCharacter(char);
 for(const record of records){char.home3D!.records.push(record);await DB.saveCharacter(char);}
 const rows=(await range(char)).messages;
 expect(rows.map(row=>row.metadata.homeRecordIds)).toEqual([['事1','事2','事3'],['用户发言'],['角色回复'],['事4','事5'],['角色主动开口'],['用户接话']]);
 expect(rows.map(row=>row.role)).toEqual(['user','user','assistant','user','assistant','user']);
 const home=await buildHomeConversationPayload(args(char));
 const chat=await buildChatRequestPayload({ scene: 'chat.private',char,userProfile:user,groups:[],emojis:[],categories:[],historyMsgs:rows,contextLimit:rows.length,contextHighWaterMark:0,recallEntryPoint:'chat_app'});
 expect(home.slice(1,-1)).toEqual(chat.cleanedApiMessages);
});
it('a private-chat message seals the action span, and delayed replies retain their actual time',async()=>{
 const char=character([event('动作1',1)]);await DB.saveCharacter(char);
 await DB.saveMessage({charId:char.id,role:'user',type:'text',timestamp:2,content:'私聊2'});
 char.home3D!.records.push(event('动作3',3),event('家园回复4',4,'message','character','old-user'));
 await DB.saveCharacter(char);
 const rows=(await range(char)).messages;
 expect(rows.map(row=>row.timestamp)).toEqual([1,2,3,4]);
 expect(rows.map(row=>row.role)).toEqual(['user','user','user','assistant']);
});
it.each(['watermark','snapshot'])('new actions stay outside the %s archive boundary',async boundary=>{
 const char=character([event('旧动作',1)]);await DB.saveCharacter(char);
 const old=(await range(char)).messages[0];
 if(boundary==='snapshot')await DB.getMessagesByCharId(char.id,true,true);
 else localStorage.setItem('mp_lastMsgId_'+char.id,String(old.id));
 char.home3D!.records.push(event('新动作',2));await DB.saveCharacter(char);
 // Simulate the in-flight archive committing its original snapshot afterward.
 localStorage.setItem('mp_lastMsgId_'+char.id,String(old.id));
 const rows=(await range(char)).messages;
 expect(rows).toHaveLength(1);expect(rows[0].content).toContain('新动作');expect(rows[0].content).not.toContain('旧动作');
 expect(rows[0].id).toBeGreaterThan(old.id);
 expect((await DB.getMessageById(old.id))?.content).not.toContain('新动作');
});
it('new model replies no longer inherit the archived user message ID',async()=>{
 const char=character([event('旧问题',1,'message','user')]);await DB.saveCharacter(char);
 const old=(await range(char)).messages[0];localStorage.setItem('mp_lastMsgId_'+char.id,String(old.id));
 char.home3D!.records.push(event('新回复',2,'message','character','旧问题'));await DB.saveCharacter(char);
 const rows=(await range(char)).messages;
 expect(rows).toHaveLength(1);expect(rows[0].role).toBe('assistant');expect(rows[0].content).toContain('新回复');
});
it.each(['archive','breakpoint'])('old reply retries cannot bypass the %s range',async boundary=>{
 const char=character([event('范围外问题',1,'message','user')]);await DB.saveCharacter(char);
 const old=(await range(char)).messages[0];
 if(boundary==='archive')localStorage.setItem('mp_lastMsgId_'+char.id,String(old.id));
 else char.contextUserStartMessageId=await DB.saveMessage({charId:char.id,role:'user',type:'text',timestamp:2,content:'范围起点'});
 await expect(buildHomeConversationPayload(args(char))).rejects.toThrow('已不在当前上下文范围内');
});
async function legacyCharacter(){
 const records=[event('旧用户',1,'message','user'),event('旧角色',3,'message','character','旧用户')];
 const char=character(records),db=await openDB();
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('characters','readwrite');tx.objectStore('characters').put({...char,homeContextBridgeVersion:2});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
 const id=await DB.saveMessage({charId:char.id,role:'user',type:'text',timestamp:1,content:'旧用户\n旧角色',metadata:{source:'home',homeTurnId:'旧用户',homeRecordIds:records.map(r=>r.id)}});
 await DB.saveMessage({charId:char.id,role:'assistant',type:'text',timestamp:2,content:'中途私聊'});
 return {char,id};
}
it('legacy migration preserves IDs, archive boundaries, original events, and cross-app ordering',async()=>{
 const {char,id}=await legacyCharacter();localStorage.setItem('mp_lastMsgId_'+char.id,String(id));
 const filtered=(await range(char)).messages;
 expect(filtered.some(row=>row.metadata?.source==='home')).toBe(false);
 const raw=await DB.getMessagesByCharId(char.id,true);
 expect(raw).toHaveLength(2);expect(raw.find(row=>row.metadata?.source==='home')?.id).toBe(id);
 expect(localStorage.getItem('mp_lastMsgId_'+char.id)).toBe(String(id));
 const manual={...char,contextRangeMode:'manual' as const,contextLimit:50};
 const messages=body((await range(manual)).messages,manual);
 expect(messages.map(row=>row.role)).toEqual(['user','assistant','assistant']);
 expect(messages[0].content).toContain('旧用户');expect(messages[1].content).toContain('中途私聊');expect(messages[2].content).toContain('旧角色');
 char.home3D!.records.push(event('新的回复',4,'message','character','旧用户'));await DB.saveCharacter(char);
 expect((await range(char)).messages.at(-1)?.content).toContain('新的回复');
 expect((await DB.getMessageById(id))?.content).not.toContain('新的回复');
});
it('migration rollback preserves both old character and messages, then retry is idempotent',async()=>{
 const {char,id}=await legacyCharacter();const put=IDBObjectStore.prototype.put;
 const fail=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...values:any[]){
  if(this.name==='messages'){this.transaction.abort();return {} as IDBRequest;}
  return put.apply(this,values as any);
 });
 await expect(DB.ensureHomeContextMessages(char.id)).rejects.toThrow();fail.mockRestore();
 expect((await DB.getCharacter(char.id))?.homeContextBridgeVersion).toBe(2);
 expect((await DB.getMessageById(id))?.metadata.homeEvents).toBeUndefined();
 await Promise.all([DB.ensureHomeContextMessages(char.id),DB.ensureHomeContextMessages(char.id)]);
 expect((await DB.getCharacter(char.id))?.homeContextBridgeVersion).toBe(3);
 expect(await DB.getMessagesByCharId(char.id,true)).toHaveLength(2);
});
it('recall consumes the same expanded speakers and chronological events as outgoing history',async()=>{
 const {char}=await legacyCharacter();
 const input=event('新问题',4,'message','user');
 char.home3D!.records.push(input);
 await DB.ensureHomeContextMessages(char.id);
 await DB.saveCharacter(char);
 const recall=vi.spyOn(palace,'injectMemoryPalace').mockResolvedValue({stages:[]} as any);
 const rows=(await range(char)).messages;
 const chat=await buildChatRequestPayload({ scene: 'chat.private',char,userProfile:user,groups:[],emojis:[],categories:[],historyMsgs:rows,contextLimit:rows.length,recallEntryPoint:'chat_app'});
 const home=await buildHomeConversationPayload(args(char));
 for(const call of recall.mock.calls){
  expect(call[1]!.map(m=>m.timestamp)).toEqual([1,2,3,4]);
  expect(call[1]!.map(m=>m.role)).toEqual(['user','assistant','assistant','user']);
 }
 expect(recall.mock.calls[0][1]).toEqual(recall.mock.calls[1][1]);
 expect(home.slice(1,-1)).toEqual(chat.cleanedApiMessages);
});
it('deleting or editing the first action retains the segment ID and remaining originals',async()=>{
 const char=character([event('a',1),event('b',2)]);await DB.saveCharacter(char);
 const original=(await range(char)).messages[0];
 char.home3D!.records=[{...event('b',2),text:'修改后的动作'}];await DB.saveCharacter(char);
 const rows=(await range(char)).messages;
 expect(rows).toHaveLength(1);expect(rows[0].id).toBe(original.id);expect(rows[0].metadata.homeRecordIds).toEqual(['b']);
 expect(rows[0].content).toContain('修改后的动作');
});
it('flushes already-arrived inbox messages before reading shared history',async()=>{
 const char=character([event('家园问题',1,'message','user')]);await DB.saveCharacter(char);
 inbox.mockImplementationOnce(async()=>{await DB.saveMessage({charId:char.id,role:'assistant',type:'text',timestamp:2,content:'刚收到的主动消息',metadata:{activeMsg2:{taskId:'scheduled-task'}}});});
 const messages=await buildHomeConversationPayload(args(char));
 expect(inbox).toHaveBeenCalledWith(char.id);expect(JSON.stringify(messages)).toContain('刚收到的主动消息');
 const rows=(await range(char)).messages;
 const chat=await buildChatRequestPayload({ scene: 'chat.private',char,userProfile:user,groups:[],emojis:[],categories:[],historyMsgs:rows,contextLimit:rows.length,recallEntryPoint:'chat_app'});
 const finalChat=withChatContinuation(chat.fullMessages,user.name,{unansweredUserTurn:hasUnansweredUserTurn([{role:'user'}],rows)});
 expect(messages.at(-1)).toEqual(finalChat.at(-1));expect(messages.at(-1)?.content).toContain('刚才说的话还没有人回');
});
