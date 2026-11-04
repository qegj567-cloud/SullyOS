import type {Message} from '../types';
import type {HomeRecord} from '../apps/room3d/types';
import {assignHomeTurns,isRoutineHomeWalk} from './homeTurns';
import {isSharedHomeRecord,sharedHomeEventKey,homeSharedEventText} from './homeSharedEvents';

/** Pure persistence plan. Existing records keep their segment even if the editor
 * snapshot predates the last save. New records never join old legacy/archived rows.
 */
export function assignHomeContextSegments(previous:HomeRecord[],input:HomeRecord[],last:Message|undefined,hwm:number,legacy:Message[]=[]):HomeRecord[]{
 const old=new Map(previous.map(record=>[record.id,record.contextSegmentId]));
 const inherited=new Map<string,string>();
 const assigned=assignHomeTurns(input);
 for(const row of legacy){
  const key=row.metadata?.homeTurnId||row.metadata?.homeRecordId;
  if(!key)continue;
  const ids:string[]=row.metadata.homeRecordIds||[row.metadata.homeRecordId].filter(Boolean);
  for(const record of assigned)if(ids.includes(record.id)||(!ids.length&&record.turnId===key))inherited.set(record.id,key);
 }
 const extendable=last?.metadata?.source==='home'&&last.metadata.homeContextVersion===3&&!last.metadata.homeLegacy&&!last.metadata.homeContextSealed
  &&last.metadata.homeContextKind==='actions'&&last.id>hwm?last:undefined;
 let open:string|undefined,end=-Infinity;
 return [...assigned].sort((a,b)=>a.at-b.at).map(record=>{
  const existing=old.get(record.id)||inherited.get(record.id);
  if(isSharedHomeRecord(record)){open=undefined;end=record.at;return {...record,contextSegmentId:sharedHomeEventKey(record)};}
  if(isRoutineHomeWalk(record))return {...record,contextSegmentId:existing||record.id};
  if(existing){
   open=extendable&&existing===extendable.metadata.homeTurnId&&record.id===extendable.metadata.homeRecordIds.at(-1)?existing:undefined;
   end=record.at;
   return {...record,contextSegmentId:existing};
  }
  const action=isHomeActionRecord(record);
  const key=action&&open&&record.at>=end?open:record.id;
  open=action?key:undefined;end=record.at;
  return {...record,contextSegmentId:key};
 });
}

export const isHomeActionRecord=(record:HomeRecord)=>record.kind!=='message'&&!record.initiative;

/** Speech is independent. Only consecutive scene events may share a segment. */
export function homeSegmentMessages(charId:string,records:HomeRecord[]):Omit<Message,'id'>[]{
 const groups=new Map<string,HomeRecord[]>();let actions:string|undefined;
 for(const record of [...records].sort((a,b)=>a.at-b.at)){
  if(isSharedHomeRecord(record)){actions=undefined;groups.set(sharedHomeEventKey(record),[record]);continue;}
  if(isRoutineHomeWalk(record))continue;
  const action=isHomeActionRecord(record);
  const key=record.contextSegmentId||(action?actions:undefined)||record.id;
  actions=action?key:undefined;
  const group=groups.get(key)||[];group.push(record);groups.set(key,group);
 }
 return [...groups].map(([key,events])=>homeSegmentMessage(charId,key,events));
}

export function homeSegmentMessage(charId:string,key:string,events:HomeRecord[]):Omit<Message,'id'>{
 const shared=events.length===1&&isSharedHomeRecord(events[0])?events[0]:undefined;
 if(shared){
  const speech=shared.kind==='message',ownSpeech=speech&&shared.actor==='character'&&shared.actorId===charId;
  return {
   charId,role:ownSpeech?'assistant':'user',type:'text',timestamp:shared.at,
   content:(speech?'家园共同发言（按姓名区分说话者）：\n':'家园实际行为（场景记录，不是发言；开始不代表完成）：\n')+homeSharedEventText(shared),
   metadata:{source:'home',homeTurnId:sharedHomeEventKey(shared),homeRecordIds:[shared.id],homeTurnEndAt:shared.at,
    homeContextVersion:3,homeContextKind:speech?'speech':'actions',homeContextSealed:true,homeEvents:[shared],
    homeSharedOwnerId:shared.sharedScene!.homeOwnerId,homeParticipantIds:shared.sharedScene!.participantIds,
    homeActorId:shared.actorId,homeActorName:shared.actorName,homeSceneRecord:!speech||shared.actorId!=='user'&&!ownSpeech},
  };
 }
 const speech=events.length===1&&events[0].kind==='message';
 const actions=events.every(isHomeActionRecord);
 return {
  charId,role:speech&&events[0].actor==='character'?'assistant':'user',type:'text',timestamp:events[0].at,
  content:speech?'['+events[0].roomName+'] '+events[0].text:
   (actions?'家园实际行为（场景记录，不是发言；开始不代表完成）：\n':'家园经历（场景记录）：\n')+events.map(e=>
    '['+e.roomName+'] '+(e.kind==='message'?(e.actor==='user'?'用户说：':'角色说：'):('实际行为（'+({user:'用户操作',local:'本地自主',model:'模型执行'}[e.source])+'）：'))+e.text).join('\n'),
  metadata:{source:'home',homeTurnId:key,homeRecordIds:events.map(e=>e.id),homeTurnEndAt:events.at(-1)!.at,
   homeContextVersion:3,homeContextKind:actions?'actions':speech?'speech':'scene',homeEvents:events},
 };
}

/** AFTER range selection: keep legacy IDs/watermarks in storage while restoring
 * individual speakers/times in requests. Split actions around interleaved chat too. */
export function expandHomeContextHistory(messages:Message[]):Message[]{
 const events=messages.flatMap(message=>{
  const home=message.metadata?.source==='home'&&message.metadata?.homeEvents;
  if(!Array.isArray(home)||!home.length)return [message];
  return (home as HomeRecord[]).map(event=>({...message,...homeSegmentMessage(message.charId,message.metadata.homeTurnId,[event]),
   metadata:{...message.metadata,homeEvents:[event],homeContextKind:isHomeActionRecord(event)?'actions':event.kind==='message'?'speech':'scene'}} as Message));
 }).sort((a,b)=>a.timestamp-b.timestamp||a.id-b.id);
 const result:Message[]=[];
 for(const event of events){
  const last=result.at(-1);
  if(last&&last.id===event.id&&last.metadata?.homeContextKind==='actions'&&event.metadata?.homeContextKind==='actions'){
   const joined=[...last.metadata.homeEvents,...event.metadata.homeEvents];
   result[result.length-1]={...last,...homeSegmentMessage(last.charId,last.metadata.homeTurnId,joined)};
  }else result.push(event);
 }
 return result;
}
