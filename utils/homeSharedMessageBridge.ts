import type {HomeRecord} from '../apps/room3d/types';
import type {Message} from '../types';
import {homeSegmentMessage} from './homeContextSegments';
import {isSharedHomeRecord,sharedHomeEventKey} from './homeSharedEvents';
import {deleteLinkedSecretNotes} from './secretNote';

/** Called inside the same transaction as the owner's journal. Guests get only
 * message projections; their own house, layout and journal are never replaced. */
export function syncHomeSharedMessages(
 tx:IDBTransaction,ownerId:string,previous:HomeRecord[],records:HomeRecord[],
 onInsert:(tx:IDBTransaction,charId:string,id:number)=>void,
 onChange:(charId:string,notesChanged:boolean)=>void,
):void{
 const before=new Map(previous.filter(isSharedHomeRecord).map(r=>[r.id,r]));
 const after=new Map(records.filter(isSharedHomeRecord).map(r=>[r.id,r]));
 const messages=tx.objectStore('messages'),characters=tx.objectStore('characters');
 for(const eventId of new Set([...before.keys(),...after.keys()])){
  const old=before.get(eventId),next=after.get(eventId),event=old||next!;
  if(event.sharedScene!.homeOwnerId!==ownerId||JSON.stringify(old)===JSON.stringify(next))continue;
  const key=sharedHomeEventKey(event);
  for(const charId of event.sharedScene!.participantIds){
   const exists=characters.get(charId);
   exists.onsuccess=()=>{
    if(!exists.result)return; // Deleted characters cannot be recreated by a late save.
    const projected=next?homeSegmentMessage(charId,key,[next]):undefined;
    const lookup=messages.index('charId_homeTurn').openCursor(IDBKeyRange.only([charId,key]));
    let found=false;
    lookup.onsuccess=()=>{
     const cursor=lookup.result;
     if(cursor){
      const row=cursor.value as Message;
      if(row.metadata?.homeSharedOwnerId===ownerId&&row.type!=='secret_note'){
       found=true;
       deleteLinkedSecretNotes(messages,row);
       onChange(charId,!!row.metadata?.secretNoteIds?.length);
       if(projected)cursor.update({...row,...projected,metadata:{...row.metadata,...projected.metadata,secretNoteIds:[]}});
       else cursor.delete();
      }
      cursor.continue();
     }else if(projected&&!found&&!old){
      // If a participant explicitly removed their history, a later edit of the
      // owner's event must not silently restore that participant's deleted row.
      const add=messages.add(projected);
      add.onsuccess=()=>{onInsert(tx,charId,add.result as number);onChange(charId,false);};
     }
    };
   };
  }
 }
}
