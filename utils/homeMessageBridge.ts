import type {CharacterProfile, Message} from '../types';
import {assignHomeTurns} from './homeTurns';
import {assignHomeContextSegments,homeSegmentMessages as homeTurnMessages} from './homeContextSegments';
import {homeRecords} from './homeRecords';
import {deleteLinkedSecretNotes, announceSecretNotesChanged, HOME_HISTORY_COMMITTED} from './secretNote';
import {isSharedHomeRecord,preserveHomeSharedIdentity} from './homeSharedEvents';
import {syncHomeSharedMessages} from './homeSharedMessageBridge';

/** Persist the room journal and its shared-history projection atomically, as DateApp does for messages.
 * String input migrates only the stored character, never a stale React snapshot.
 */
export function persistCharacterWithHomeMessages(db:IDBDatabase,input:CharacterProfile|string,onInsert:(tx:IDBTransaction,charId:string,id:number)=>void):Promise<void>{
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(['characters','messages','assets'],'readwrite');
  const characters=tx.objectStore('characters'),messages=tx.objectStore('messages');
  const id=typeof input==='string'?input:input.id;
  const firstInserted=new Map<string,number>(),changedCharacters=new Set([id]),changedNotes=new Set<string>();
  const inserted=(tx:IDBTransaction,charId:string,key:number)=>{
   firstInserted.set(charId,Math.min(firstInserted.get(charId)??Infinity,key));onInsert(tx,charId,key);
  };
  let notesChanged=false;
  const request=characters.get(id);
  request.onsuccess=()=>{
   const previous=request.result as CharacterProfile|undefined;
   if(typeof input==='string'&&(!previous||previous.homeContextBridgeVersion===3))return;
   const character=typeof input==='string'?previous!:input;
   const oldRecords=homeRecords(previous?.home3D),inputRecords=preserveHomeSharedIdentity(oldRecords,homeRecords(character.home3D));
   if(!oldRecords.length&&!inputRecords.length){characters.put({...character,homeContextBridgeVersion:3});return;}
   const persist=(last:Message|undefined,hwm:number,legacy:Message[])=>{
   const records=assignHomeContextSegments(oldRecords,inputRecords,last,hwm,legacy);
   const unchanged=previous?.homeContextBridgeVersion===3&&JSON.stringify(oldRecords)===JSON.stringify(records);
   characters.put({...character,...(character.home3D?{home3D:{...character.home3D,records}}:{}),homeContextBridgeVersion:3});
   if(unchanged)return;
   syncHomeSharedMessages(tx,id,oldRecords,records,inserted,(charId,notes)=>{
    changedCharacters.add(charId);if(notes)changedNotes.add(charId);
   });
   const turns=homeTurnMessages(id,records.filter(record=>!isSharedHomeRecord(record)));
   const pending=new Map(turns.map(turn=>[turn.metadata.homeTurnId as string,turn]));
   const insert=(turn:typeof turns[number])=>{const add=messages.add(turn);add.onsuccess=()=>inserted(tx,id,add.result as number);};
   if(previous?.homeContextBridgeVersion===3){
    // Normal writes touch only changed turns. No history scan on each local action.
    const before=new Map(homeTurnMessages(id,assignHomeTurns(oldRecords.filter(record=>!isSharedHomeRecord(record)))).map(turn=>[turn.metadata.homeTurnId as string,turn]));
    for(const key of new Set([...before.keys(),...pending.keys()])){
     const next=pending.get(key);if(JSON.stringify(before.get(key))===JSON.stringify(next))continue;
     const lookup=messages.index('charId_homeTurn').openCursor(IDBKeyRange.only([id,key]));let found=false;
     lookup.onsuccess=()=>{const cursor=lookup.result;
      if(cursor){const row=cursor.value as Message;if(row.metadata?.source==='home' && row.type!=='secret_note'){if(row.metadata?.secretNoteIds?.length)notesChanged=true;deleteLinkedSecretNotes(messages,row);if(next){cursor.update({...row,...next,metadata:{...row.metadata,...next.metadata,secretNoteIds:[]}});found=true;}else cursor.delete();}cursor.continue();}
      else if(next&&!found)insert(next);
     };
    }
    return;
   }
   // Preserve legacy IDs/watermarks. Requests expand attached events only after
   // shared range selection. Unmatched old history remains untouched.
   for(const row of legacy){
     const key=row.metadata.homeTurnId||row.metadata.homeRecordId;
     const projected=pending.get(key);
     const ids:string[]=row.metadata.homeRecordIds||[row.metadata.homeRecordId].filter(Boolean);
     if(projected&&ids.every(recordId=>projected.metadata.homeRecordIds.includes(recordId)))
      messages.put({...row,...projected,metadata:{...row.metadata,...projected.metadata,homeLegacy:true}});
     pending.delete(key);
   }
   for(const turn of [...pending.values()].sort((a,b)=>a.timestamp-b.timestamp))insert(turn);
   };
   // IndexedDB request callbacks keep the transaction active; no async waits.
   const latest=messages.index('charId').openCursor(IDBKeyRange.only(id),'prev');
   latest.onsuccess=()=>{
    const cursor=latest.result;
    if(cursor?.value.groupId){cursor.continue();return;}
    const last=cursor?.value as Message|undefined;
    const mirror=tx.objectStore('assets').get(`mp_hwm_v1_${id}`);
    mirror.onsuccess=()=>{
     let hwm=Number(typeof mirror.result?.data==='number'?mirror.result.data:mirror.result?.data?.msgId)||0;
     try{hwm=Math.max(hwm,Number(localStorage.getItem(`mp_lastMsgId_${id}`))||0);}catch{/* Use mirror. */}
     if(previous?.homeContextBridgeVersion===3){persist(last,hwm,[]);return;}
     const legacy:Message[]=[];
     const scan=messages.index('charId_source').openCursor(IDBKeyRange.only([id,'home']));
     scan.onsuccess=()=>{const item=scan.result;if(item){legacy.push(item.value);item.continue();}else persist(last,hwm,legacy);};
    };
   };
  };
  tx.oncomplete=()=>{
   if(notesChanged)changedNotes.add(id);
   for(const charId of changedNotes)announceSecretNotesChanged(charId);
   for(const charId of changedCharacters)if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(HOME_HISTORY_COMMITTED,{detail:{charId}}));
   for(const [charId,first] of firstInserted)try{
    const key=`mp_lastMsgId_${charId}`;
    if(Number(localStorage.getItem(key))>=first)localStorage.removeItem(key);
   }catch{/* The transaction is committed even when localStorage is unavailable. */}
   resolve();
  };
  tx.onerror=()=>reject(tx.error);
  tx.onabort=()=>reject(tx.error||new Error('家园记录未能保存'));
 });
}
