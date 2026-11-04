import type {APIConfig,CharacterProfile,UserProfile} from '../types';
import type {HomeEditor} from '../apps/room3d/editor.js';
import type {HomeRecord} from '../apps/room3d/types';
import {DB} from './db';
import {generateHomeReply,type HomeConversationContext} from './homeConversation';
import {makeHomeRecord,homeRecords} from './homeRecords';
import {waitForHomeSecretOrigin} from './homeSecrets';
import type {SecretNoteOrigin} from './secretNote';

/** One bounded round, current speaker's context only. Retry skips committed speakers. */
export async function runHomeSocialRound(args:{editor:HomeEditor;owner:CharacterProfile;user:UserProfile;api:APIConfig;inputId:string;signal:AbortSignal;context?:HomeConversationContext;onStage:(text:string)=>void;commit:(records:HomeRecord[])=>void}){
 const {editor,owner,user,api,inputId,signal,context,onStage,commit}=args;
 const records=()=>homeRecords(editor.getState());
 const input=records().find(r=>r.id===inputId);if(!input)throw Error('本轮输入已删除');
 const people=editor.getPresentResidents().filter(p=>p.id!=='user');
 const ids=people.map(p=>p.id),signature=[...ids].sort().join('|'),room=editor.getHomeScene().roomId;
 const valid=()=>{signal.throwIfAborted();if(editor.getHomeScene().roomId!==room||editor.getPresentResidents().filter(p=>p.id!=='user').map(p=>p.id).sort().join('|')!==signature)throw Error('在场成员或房间已变化，本轮交流已停止');if(records().find(r=>r.id===inputId)?.text!==input.text)throw Error('用户发言已修改，本轮交流已停止');};
 // No private history is read for anyone except the next speaker.
 for(const person of people){valid();if(records().some(r=>r.replyTo===inputId&&r.actorId===person.id&&r.source==='model'))continue;
  const char=await DB.getCharacter(person.id);valid();if(!char)throw Error('角色已删除，本轮交流已停止');
  const scene=editor.getResidentScene(person.id),all=records(),roundIds=new Set([inputId]);for(const r of all)if(r.replyTo&&roundIds.has(r.replyTo))roundIds.add(r.id);const live=all.filter(r=>roundIds.has(r.id));
  const requestRecords=[...live];if(!requestRecords.length)throw Error('缺少本轮现场记录');
  onStage(person.name+' · 准备回复');
  let resolveOrigin!:(origin:SecretNoteOrigin|undefined)=>void;
  const secretOrigin=new Promise<SecretNoteOrigin|undefined>(resolve=>{resolveOrigin=resolve;});
  let saved=false;
  try{
  const result=await generateHomeReply({secretOrigin,char:person.id===owner.id?{...char,home3D:editor.getState()}:char,user,api,scene,records:requestRecords,liveSceneEvents:live,signal,context,onStage:stage=>onStage(person.name+' · '+stage)});
  valid();if(records().some(r=>r.replyTo===inputId&&r.actorId===person.id&&r.source==='model'))continue;
  const reply=makeHomeRecord({kind:result.silent?'presence':'message',source:'model',actor:'character',actorId:person.id,actorName:char.name,text:result.silent?'保持安静，没有开口。':result.text,roomId:scene.roomId,roomName:scene.roomName,replyTo:inputId,sharedScene:{homeOwnerId:owner.id,participantIds:ids}});
  commit([...records(),reply]);
  saved=true;void waitForHomeSecretOrigin(person.id,[input,reply],signal).then(resolveOrigin);
  if(!result.silent)editor.showHomeBubble?.(person.id,result.text);
  const actions=result.actionIds??(result.actionId?[result.actionId]:[]);
  if(actions.length){if(editor.getHomeScene().manualRevision!==scene.manualRevision)throw Error('回复已保存，但现场被手动改变，动作未执行');const outcome=await editor.performResidentActions(person.id,actions,reply.id,signal);if(outcome!=='completed')throw Error(person.name+'的回复已保存，但动作未完成，交流已停止');}
  }finally{if(!saved)resolveOrigin(undefined);}
 }
}
