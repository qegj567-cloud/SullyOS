import {makeHomeRecord} from './homeRecords';
import type {Home3DState} from '../apps/room3d/types';
export function petHomeRecord(event:{petId?:string;petName:string;text:string;roomId:string;source:'user'|'local';actorName?:string},home:Home3DState,userName='用户'){
 const room=home.rooms.find(r=>r.id===event.roomId);if(!room)return null;
 return makeHomeRecord({kind:'action',source:event.source,actor:event.source==='user'?'user':'character',
  ...(event.petId&&event.petName?{actorId:'pet:'+event.petId,actorName:'宠物「'+event.petName+'」'}:{}),
  text:(event.petName?'宠物「'+event.petName+'」':'')+(event.actorName?event.text:event.text.replaceAll('你',userName==='你'?'用户':userName)),roomId:room.id,roomName:room.name});
}
