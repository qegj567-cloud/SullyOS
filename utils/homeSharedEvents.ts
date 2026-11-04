import type {HomeRecord} from '../apps/room3d/types';

/** Membership is captured when an event happens, never inferred from room names
 * or from the set of characters currently loaded in OSContext. */
export function isSharedHomeRecord(record:HomeRecord):boolean {
 const scene=record.sharedScene;
 return !!scene&&typeof scene.homeOwnerId==='string'&&!!scene.homeOwnerId
  &&Array.isArray(scene.participantIds)&&scene.participantIds.length>1
  &&scene.participantIds.every(id=>typeof id==='string'&&!!id&&id!=='user')
  &&new Set(scene.participantIds).size===scene.participantIds.length
  &&scene.participantIds.includes(scene.homeOwnerId)
  &&typeof record.actorId==='string'&&!!record.actorId
  &&typeof record.actorName==='string'&&!!record.actorName;
}

export const sharedHomeEventKey=(record:HomeRecord)=>
 `home-shared:${JSON.stringify([record.sharedScene!.homeOwnerId,record.id])}`;

/** Stamp only new events. Inviting someone later or changing camera rooms must
 * not grant them old events. An edited record keeps its original membership. */
export function stampHomeSceneRecords(
 records:HomeRecord[], known:Map<string,HomeRecord>,
 owner:{id:string;name:string}, participants:Array<{id:string;name:string}>,
):HomeRecord[] {
 const ids=[...new Set([owner.id,...participants.map(p=>p.id)].filter(id=>id&&id!=='user'))];
 return records.map(record=>{
  const old=known.get(record.id);
  if(old)return {...record,actorId:old.actorId,actorName:old.actorName,targetIds:old.targetIds,sharedScene:old.sharedScene};
  const actorId=record.actorId||(record.actor==='user'?'user':owner.id);
  const actorName=record.actorName||(actorId===owner.id?owner.name:participants.find(p=>p.id===actorId)?.name)
   ||(record.actor==='user'?'用户':actorId);
  const next={...record,actorId,actorName,...(ids.length>1&&owner.id!=='resident'?{
   sharedScene:{homeOwnerId:owner.id,participantIds:ids},
  }:{})};
  known.set(record.id,next);
  return next;
 });
}

/** Preserve the event's original identity/recipients through stale UI saves. */
export function preserveHomeSharedIdentity(previous:HomeRecord[],records:HomeRecord[]):HomeRecord[]{
 const old=new Map(previous.map(record=>[record.id,record]));
 return records.map(record=>{
  const original=old.get(record.id);
  if(!original)return record;
  return {...record,actorId:original.actorId,actorName:original.actorName,targetIds:original.targetIds,sharedScene:original.sharedScene};
 });
}

export function homeSharedRecipients(records:HomeRecord[]):string[]{
 return [...new Set(records.filter(isSharedHomeRecord).flatMap(record=>record.sharedScene!.participantIds))];
}

/** One common event per message: later events never mutate a message which one
 * participant may already have archived. Private/single-resident spans retain
 * the existing action-compaction rules. */
export function homeSharedEventText(record:HomeRecord):string{
 const who=record.actorName||record.actorId||'角色';
 if(record.kind==='message')return `[${record.roomName}] ${who}说：${record.text}`;
 return `[${record.roomName}] ${record.text.startsWith(who)?record.text:who+'：'+record.text}`;
}
