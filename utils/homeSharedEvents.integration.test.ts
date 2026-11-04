import {afterEach,expect,it,vi} from 'vitest';
import {DB} from './db';
import {loadCharacterContextRange} from './chatContextRange';
import {buildChatRequestPayload} from './chatRequestPayload';
import {ContextBuilder} from './context';
import {formatMessageForPrompt,isMessageSemanticallyRelevant} from './messageFormat';
import {hasUnansweredUserTurn} from './chatContinuation';
import {stampHomeSceneRecords} from './homeSharedEvents';
import {petHomeRecord} from './homePetRecords';
import {waitForHomeSecretOrigin} from './homeSecrets';
import type {CharacterProfile,MountedWorldbook} from '../types';
import type {HomeRecord} from '../apps/room3d/types';

let serial=0;
async function scene(){
 const suffix=++serial;
 const chars=['A','B','C','D'].map(name=>({
  id:`shared-home-${suffix}-${name}`,name,avatar:'',description:'',memories:[],systemPrompt:`${name}自己的设定`,
  contextRangePolicyVersion:1,contextRangeMode:'adaptive',autoArchiveEnabled:true,
  home3D:{version:1,activeRoomId:name,rooms:[],records:[]},
 } as CharacterProfile));
 for(const char of chars)await DB.saveCharacter(char);
 const [a,b,c,d]=chars;
 const record=(id:string,who:CharacterProfile,kind:HomeRecord['kind'],text:string,at:number,roomId:string):HomeRecord=>({
  id:`${suffix}-${id}`,at,kind,actor:'character',actorId:who.id,actorName:who.name,
  source:kind==='message'?'model':'local',text,roomId,roomName:roomId,
  sharedScene:{homeOwnerId:b.id,participantIds:[a.id,b.id,c.id]},
 });
 const records=[
  record('speech',a,'message','草',1,'客厅'),
  {...record('touch',b,'action','摸了A',2,'客厅'),targetIds:[a.id]},
  record('water',c,'action','浇水',3,'阳台'),
 ];
 const save=async(next=records)=>{b.home3D={...b.home3D!,records:next};await DB.saveCharacter(b);};
 return {a,b,c,d,records,save,record};
}
afterEach(()=>{vi.restoreAllMocks();localStorage.clear();});
it('resolves a shared home origin separately for each participant after persistence',async()=>{
 const {a,b,c,records,save}=await scene();await save();
 const origins=await Promise.all([a,b,c].map(char=>waitForHomeSecretOrigin(char.id,records.slice(0,2),new AbortController().signal)));
 expect(origins.every(origin=>origin?.messageIds.length===2)).toBe(true);
 expect(new Set(origins.flatMap(origin=>origin!.messageIds)).size).toBe(6);
});

it('keeps pet scene actions attributed to the pet instead of the house owner',async()=>{
 const {a,b,c,save}=await scene();
 const record=petHomeRecord({petId:'cat',petName:'年糕',text:'回到窝里睡下了',roomId:'room',source:'local'},
  {...b.home3D!,rooms:[{id:'room',name:'客厅'} as any]})!;
 const stamped=stampHomeSceneRecords([record],new Map(),b,[a,c]);
 await save(stamped);
 for(const char of [a,b,c]){
  const [row]=await loadCharacterContextRange(char).then(result=>result.messages);
  expect(row.content).toContain('[客厅] 宠物「年糕」回到窝里睡下了');
  expect(row.metadata.homeActorId).toBe('pet:cat');
  expect(row.content).not.toContain('B：');
 }
});

it('projects the complete A/B/C event stream to each participant through the existing request and memory formats',async()=>{
 const {a,b,c,d,save}=await scene();await save();
 const beforeIds:number[][]=[];
 for(const char of [a,b,c]){
  const rows=(await loadCharacterContextRange(char)).messages;
  beforeIds.push(rows.map(row=>row.id));
  expect(rows).toHaveLength(3);
  expect(rows.every(isMessageSemanticallyRelevant)).toBe(true);
  expect(rows.map(row=>row.content).join('\n')).toContain('A说：草');
  expect(rows.map(row=>row.content).join('\n')).toContain('B：摸了A');
  expect(rows.map(row=>row.content).join('\n')).toContain('C：浇水');
  expect(rows[0].role).toBe(char.id===a.id?'assistant':'user');
  expect(formatMessageForPrompt(rows[0],char.name,'用户')).toMatch(/^\[A\]:/);
  expect(formatMessageForPrompt(rows[1],char.name,'用户')).toMatch(/^\[家园记录\]:/);
  const payload=await buildChatRequestPayload({
   char,userProfile:{name:'用户'} as any,groups:[],emojis:[],categories:[],
   historyMsgs:rows,contextLimit:rows.length,contextHighWaterMark:0,recallEntryPoint:'home_3d',
   realtimeConfig:{weatherEnabled:false,newsEnabled:false} as any,
  });
  const history=JSON.stringify(payload.cleanedApiMessages);
  expect(history.match(/A说：草/g)).toHaveLength(1);
  expect(history.match(/B：摸了A/g)).toHaveLength(1);
  expect(history.match(/C：浇水/g)).toHaveLength(1);
 }
 expect(new Set(beforeIds.flat()).size).toBe(9);
 expect((await loadCharacterContextRange(d)).messages).toHaveLength(0);
 expect((await DB.getCharacter(a.id))?.home3D).toEqual(a.home3D);
 expect((await DB.getCharacter(c.id))?.home3D).toEqual(c.home3D);
 await Promise.all([save(),save()]);
 for(const [index,char] of [a,b,c].entries())
  expect((await loadCharacterContextRange(char)).messages.map(row=>row.id)).toEqual(beforeIds[index]);
});

it('keeps independent waterlines and never appends new events into another participant’s archived message',async()=>{
 const {a,b,c,records,save,record}=await scene();await save();
 const ar=(await loadCharacterContextRange(a)).messages,br=(await loadCharacterContextRange(b)).messages;
 localStorage.setItem('mp_lastMsgId_'+a.id,String(ar[0].id));
 localStorage.setItem('mp_lastMsgId_'+b.id,String(br[1].id));
 expect((await loadCharacterContextRange(a)).messages).toHaveLength(2);
 expect((await loadCharacterContextRange(b)).messages).toHaveLength(1);
 expect((await loadCharacterContextRange(c)).messages).toHaveLength(3);
 await save([...records,record('later',c,'action','坐下',4,'卧室')]);
 expect((await loadCharacterContextRange(a)).messages).toHaveLength(3);
 expect((await loadCharacterContextRange(b)).messages).toHaveLength(2);
 expect((await loadCharacterContextRange(c)).messages).toHaveLength(4);
 expect((await DB.getMessageById(ar[0].id))?.content).not.toContain('坐下');
 expect(localStorage.getItem('mp_lastMsgId_'+a.id)).toBe(String(ar[0].id));
 expect(localStorage.getItem('mp_lastMsgId_'+b.id)).toBe(String(br[1].id));
});

it('captures membership once, keeps old solo history private, and distributes only future events to new members',async()=>{
 const {a,b,c,d,record,save}=await scene();
 const old={...record('old',a,'message','旧经历',1,'客厅'),sharedScene:undefined};
 const known=new Map([[old.id,old]]);
 const first=stampHomeSceneRecords([old,{...record('new',b,'action','浇水',2,'阳台'),sharedScene:undefined}],known,
  {id:b.id,name:b.name},[{id:a.id,name:a.name},{id:c.id,name:c.name},{id:'user',name:'用户'}]);
 await save(first);
 const second=stampHomeSceneRecords([...first,{...record('joined',d,'message','新到场',3,'卧室'),sharedScene:undefined}],known,
  {id:b.id,name:b.name},[{id:a.id,name:a.name},{id:c.id,name:c.name},{id:d.id,name:d.name}]);
 await save(second);
 expect((await loadCharacterContextRange(a)).messages).toHaveLength(2);
 expect((await loadCharacterContextRange(d)).messages).toHaveLength(1);
 expect((await loadCharacterContextRange(d)).messages[0].content).toContain('新到场');
 // Even a stale UI which rewrites old membership cannot expand it.
 await save(second.map(r=>({...r,sharedScene:{homeOwnerId:b.id,participantIds:[a.id,b.id,c.id,d.id]}})));
 expect((await loadCharacterContextRange(d)).messages).toHaveLength(1);
});

it('edits/deletes every existing projection but does not resurrect a participant’s locally deleted history',async()=>{
 const {a,b,c,records,save}=await scene();await save();
 const row=(await loadCharacterContextRange(a)).messages[0];
 await DB.deleteMessage(row.id);
 await save(records.map((r,i)=>i===0?{...r,text:'改过的发言'}:r));
 expect((await loadCharacterContextRange(a)).messages).toHaveLength(2);
 for(const char of [b,c])expect((await loadCharacterContextRange(char)).messages[0].content).toContain('改过的发言');
 await save(records.slice(1));
 for(const char of [a,b,c])expect((await loadCharacterContextRange(char)).messages).toHaveLength(2);
});

it('rolls back the journal and all projections together when one participant write fails, then retries once',async()=>{
 const {a,b,c,save}=await scene();
 const add=IDBObjectStore.prototype.add;
 vi.spyOn(IDBObjectStore.prototype,'add').mockImplementation(function(this:IDBObjectStore,...values:any[]){
  if(this.name==='messages'&&values[0]?.charId===c.id){this.transaction.abort();return {} as IDBRequest;}
  return add.apply(this,values as any);
 });
 await expect(save()).rejects.toThrow();
 vi.restoreAllMocks();
 expect((await DB.getCharacter(b.id))?.home3D?.records).toHaveLength(0);
 for(const char of [a,b,c])expect((await loadCharacterContextRange(char)).messages).toHaveLength(0);
 await save();
 for(const char of [a,b,c])expect((await loadCharacterContextRange(char)).messages).toHaveLength(3);
});

it('ignores deleted participants without recreating their character or messages',async()=>{
 const {a,b,c,save}=await scene();
 await DB.deleteCharacter(c.id);await save();
 expect(await DB.getCharacter(c.id)).toBeUndefined();
 expect(await DB.getMessagesByCharId(c.id,true)).toHaveLength(0);
 for(const char of [a,b])expect((await loadCharacterContextRange(char)).messages).toHaveLength(3);
});

it('does not treat someone else’s scene speech as an unanswered private user turn',async()=>{
 const {a,b,save}=await scene();await save();
 const sceneSpeech=(await loadCharacterContextRange(b)).messages[0];
 expect(hasUnansweredUserTurn([sceneSpeech],[sceneSpeech,{
  role:'assistant',metadata:{activeMsg2:{taskId:'background'}},
 }])).toBe(false);
 expect((await loadCharacterContextRange(a)).messages[0].metadata.homeActorId).toBe(a.id);
});

it('reuses group worldbook ID deduplication without dropping attribution or merging different IDs with identical text',async()=>{
 const {a,b,c}=await scene();
 const book=(id:string):MountedWorldbook=>({id,title:'同名',content:'相同正文',constant:true,position:4});
 a.mountedWorldbooks=[book('shared'),book('a-only')];b.mountedWorldbooks=[book('shared')];c.mountedWorldbooks=[book('c-only')];
 const result=ContextBuilder.buildGroupWorldbookRequest({
  members:[a,b,c],user:{name:'用户'} as any,history:[{role:'user',content:'A说草，B摸了A，C浇水'}],
  render:({before,after},history)=>[{role:'system',content:before+after},...history],
 });
 const text=JSON.stringify(result);
 expect(text.match(/相同正文/g)).toHaveLength(3);
 expect(text).toContain('世界书归属：A、B；仅用于这些角色');
 expect(text).toContain('世界书归属：C；仅用于这些角色');
});
