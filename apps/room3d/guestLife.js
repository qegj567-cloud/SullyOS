import {Vector3} from 'three';
import {roomSeats,seatTransform} from './seating.js';
import {seatEntry} from './seatChange.js';
import {findWalkPath} from './navigation.js';
import {ROOM_HALF} from './dimensions.js';

/** Each guest owns a task and a seat reservation. No model, no owner/body swapping. */
export function createGuestLife(get){
 const tasks=new Map(),outcomes=new Map();
 const key=s=>s?`${s.roomId}:${s.itemId}:${s.seatId}`:'';
 const reserved=(s,except)=>{const c=get();return key(c.seat)===key(s)||c.entries.some(e=>e.id!==except&&key(e.parkedSeat)===key(s))||[...tasks].some(([id,t])=>id!==except&&t.seat&&key(t.seat)===key(s));};
 const entry=id=>get().entries.find(e=>e.id===id&&e.id!=='user'&&e.id!==get().ownerId);
 const free=(point,id)=>{const c=get();return [...c.entries.filter(e=>e.id!==id&&e.group.visible),...(c.main?[c.main]:[])].every(e=>Math.hypot(e.group.position.x-point[0],e.group.position.z-point[2])>Math.max(.65,((e.width||1)+(entry(id)?.width||1))*.4))&&[...tasks].every(([other,t])=>other===id||!t.destination||Math.hypot(t.destination[0]-point[0],t.destination[2]-point[2])>.8);};
 function cancel(id){const t=tasks.get(id),e=entry(id);if(e&&t?.seat&&e.parkedSeat){if(t.roomId===get().room.id)e.group.position.fromArray(t.front);e.parkedSeat=null;e.parkedPose=null;}tasks.delete(id);}
 function clear(){for(const id of [...tasks.keys()])cancel(id);}
 function record(e,text,t){outcomes.set(e.id,'completed');get().record(e.id,e.label,text,t.source,t.replyTo);}
 function actions(id){const c=get(),e=entry(id);if(!e?.group.visible||c.blocked||tasks.get(id)?.phase==='walk'||tasks.get(id)?.phase==='transition')return [];
  if(e.parkedSeat)return [{id:'guest:stand',kind:'stand',label:'起身',roomId:c.room.id}];
  return [{id:'guest:wander',kind:'wander',label:'在屋里走走',roomId:c.room.id},{id:'guest:look',kind:'look',label:'看看周围',roomId:c.room.id},
   ...roomSeats(c.room,c.catalog).filter(s=>!reserved(s,id)).map(s=>({id:'guest:sit:'+s.itemId+':'+s.seatId,kind:'sit',label:'坐下休息 · '+s.label,roomId:c.room.id}))];
 }
 function start(id,action,source='local',replyTo){const c=get(),e=entry(id);if(!e||!actions(id).some(a=>a.id===action)||source==='local'&&!c.autonomy)return false;
  outcomes.set(id,'unavailable');const base={source,replyTo,roomId:c.room.id,last:c.time,start:c.time};
  if(action==='guest:stand'){const old=tasks.get(id);if(!old?.front||!free(old.front,id))return false;tasks.set(id,{...base,phase:'transition',rising:true,front:old.front,seat:old.seat,from:e.group.position.toArray(),destination:old.front});return true;}
  if(action==='guest:look'){tasks.set(id,{...base,phase:'look',until:c.time+4});record(e,'看看周围',base);return true;}
  const offset=c.offset,map=c.map(id),from=[e.group.position.x+offset[0],e.group.position.z+offset[1]];
  let destinations=[];
  if(action.startsWith('guest:sit:')){const seat=roomSeats(c.room,c.catalog).find(s=>action==='guest:sit:'+s.itemId+':'+s.seatId);if(!seat||reserved(seat,id))return false;const pose=seatTransform(c.room,c.catalog,seat,!!e.visitor.rig),front=pose&&seatEntry(pose,map,offset);if(!front||!free(front,id))return false;destinations=[{point:front,seat,pose}];}
  else {for(let i=0;i<16;i++){const angle=Math.random()*Math.PI*2,distance=1+Math.random()*2;destinations.push({point:[e.group.position.x+Math.sin(angle)*distance,.18,e.group.position.z+Math.cos(angle)*distance]});}}
  const inside=p=>Math.abs(p[0])<ROOM_HALF.x-.2&&Math.abs(p[2])<ROOM_HALF.z-.2;
  for(const d of destinations){if(!inside(d.point)||!free(d.point,id))continue;const path=findWalkPath(map,from,[d.point[0]+offset[0],d.point[2]+offset[1]]);if(!path?.length)continue;
   const points=path.map(p=>[p[0]-offset[0],.18,p[1]-offset[1]]);if(points.some(p=>!inside(p)||!free(p,id)))continue;
   tasks.set(id,{...base,phase:'walk',points,index:0,destination:d.point,seat:d.seat,pose:d.pose,front:d.point});c.wake();return true;
  }return false;
 }
 function animate(e){let t=tasks.get(e.id);if(!t)return false;const c=get();if(t.roomId!==c.room.id||!e.group.visible){cancel(e.id);return false;}if(c.blocked){const delta=c.time-t.last;t.start+=delta;if(t.until)t.until+=delta;t.last=c.time;return true;}
  if(t.phase==='walk'){
   const p=t.points[t.index];if(!p){if(t.seat){if(reserved(t.seat,e.id)){cancel(e.id);return false;}t.phase='transition';t.start=c.time;t.from=e.group.position.toArray();t.destination=t.pose.position;}else{record(e,'在屋里走了一会儿',t);tasks.delete(e.id);}return true;}
   if(!free(p,e.id)){cancel(e.id);return false;}const destination=new Vector3(...p),delta=destination.clone().sub(e.group.position),step=Math.min(.08,Math.max(0,c.time-t.last))*1.1;
   if(delta.length()<=step){e.group.position.copy(destination);t.index++;}else{e.group.rotation.y=Math.atan2(delta.x,delta.z);e.group.position.add(delta.normalize().multiplyScalar(step));}e.visitor.animate(c.time-t.start,'walk','standing');
  }else if(t.phase==='transition'){
   const weight=Math.min(1,(c.time-t.start)/.9);e.group.position.fromArray(t.from).lerp(new Vector3(...t.destination),weight);if(!t.rising)e.group.rotation.y=t.pose.rotation;
   if(weight===1){if(t.rising){e.parkedSeat=null;e.parkedPose=null;record(e,'起身离开座位',t);tasks.delete(e.id);}else{e.parkedSeat=t.seat;e.parkedPose={kind:'seat-rest',hands:[],seatPose:t.pose.pose,seatHeight:t.pose.height/(e.visitor.seatScale||1)};t.phase='seated';record(e,'坐在'+t.seat.label+'休息',t);}}
   e.visitor.animate(c.time-t.start,'idle',t.rising?'standing':'seated',e.parkedPose);
  }else if(t.phase==='seated')e.visitor.animate(c.time-t.start,'idle','seated',e.parkedPose);
  else {e.visitor.animate(c.time-t.start,'idle','standing');if(c.time>=t.until)tasks.delete(e.id);}
  t.last=c.time;return true;
 }
 return {actions,start,animate,cancel,clear,reserved,result:id=>outcomes.get(id)||'unavailable',busy:id=>['walk','transition'].includes(tasks.get(id)?.phase),has:id=>tasks.has(id)};
}
