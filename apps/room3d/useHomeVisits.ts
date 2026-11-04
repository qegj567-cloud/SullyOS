import {useEffect,useRef,useState} from 'react';
import type {HomeEditor} from './editor.js';
import {claimHomeVisit,reconcileHomeVisits,releaseHomeVisit,HOME_VISITS_EVENT,type HomeVisit} from '../../utils/homeVisits';
import {homeRecords,makeHomeRecord} from '../../utils/homeRecords';
import {createLocalId} from '../../utils/localId.js';

/** Only a visible, successfully loaded scene records an arrival. Leases expire after crashes. */
export function useHomeVisits(editor:HomeEditor,ownerId:string,ready:boolean,manualIds:string[],availableIds:string[],onError:(message:string)=>void){
 const [rows,setRows]=useState<HomeVisit[]>([]),[guestIds,setGuestIds]=useState<string[]>([]);
 const session=useRef(createLocalId()),live=useRef(new Map<string,HomeVisit>()),latest=useRef({ready,manualIds,availableIds,onError});
 latest.current={ready,manualIds,availableIds,onError};
 useEffect(()=>{let disposed=false,running=false;
  const record=(v:HomeVisit,arrival:boolean)=>{
   const scene=editor.getHomeScene(),members=editor.getPresentResidents();if(!scene.present||!members.some(p=>p.id===v.guestId))return;
   const records=homeRecords(editor.getState()),id=`visit:${v.id}:${arrival?'arrival':'departure'}`;if(records.some(r=>r.id===id))return;
   const person=members.find(p=>p.id===v.guestId)!;
   editor.updateRecords([...records,{...makeHomeRecord({kind:'presence',source:'local',actor:'character',actorId:v.guestId,actorName:person.name,text:arrival?'按约来到小屋串门':'结束串门，离开了小屋',roomId:scene.roomId,roomName:scene.roomName,sharedScene:{homeOwnerId:ownerId,participantIds:members.filter(p=>p.id!=='user').map(p=>p.id)}}),id}]);
  };
  const tick=async()=>{if(running||disposed)return;running=true;
   try{
    const visits=await reconcileHomeVisits();if(disposed)return;setRows(visits);
    const config=latest.current,now=Date.now(),active=config.ready&&!document.hidden&&editor.getHomeScene().present;
    const candidates=active?visits.filter(v=>v.hostId===ownerId&&['accepted','arrived'].includes(v.status)&&v.startsAt<=now&&v.endsAt>now&&config.availableIds.includes(v.guestId)):[];
    const capacity=new Set(config.manualIds);const desired:HomeVisit[]=[];
    for(const v of candidates){if(!capacity.has(v.guestId)&&capacity.size>=3)continue;capacity.add(v.guestId);desired.push(v);}
    for(const [id,v] of live.current){if(desired.some(next=>next.id===id))continue;if(visits.some(r=>r.id===id&&['done','cancelled','declined'].includes(r.status)))record(v,false);await releaseHomeVisit(id,session.current);live.current.delete(id);}
    const next:string[]=[];
    for(const v of desired){const visible=editor.getPresentResidents().some(p=>p.id===v.guestId);if(!await claimHomeVisit(v.id,session.current,visible))continue;if(disposed){await releaseHomeVisit(v.id,session.current);break;}live.current.set(v.id,v);next.push(v.guestId);if(visible)record(v,true);}
    if(!disposed)setGuestIds(previous=>previous.join('|')===next.join('|')?previous:next);
   }catch(error){if(!disposed)latest.current.onError(error instanceof Error?error.message:'串门读取失败');}finally{running=false;}
  };
  const refresh=()=>void tick();refresh();const timer=setInterval(refresh,3000);window.addEventListener(HOME_VISITS_EVENT,refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{disposed=true;clearInterval(timer);window.removeEventListener(HOME_VISITS_EVENT,refresh);document.removeEventListener('visibilitychange',refresh);for(const id of live.current.keys())void releaseHomeVisit(id,session.current).catch(error=>console.error('[Home visit] release',error));live.current.clear();};
 },[editor,ownerId]);
 return {rows,guestIds};
}
