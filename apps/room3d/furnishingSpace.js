import {walkingMap} from './navigation.js';
import {ROOM_HALF,ROOM_STEP} from './dimensions.js';

// Compare connected walking space, allowing a small toy or tabletop prop to use
// a little space without treating it like a sofa. Existing blocked layouts can
// still be improved; only newly separated usable areas are rejected.
function roomSpace(home,room,catalog,options){
 const map=walkingMap(home,room.level,catalog,{walkClearance:true,...options}),points=new Map(),step=.4;
 const ox=room.x*ROOM_STEP.x,oz=room.z*ROOM_STEP.z;
 for(let x=0;x*step<ROOM_HALF.x*2-.56;x++)for(let z=0;z*step<ROOM_HALF.z*2-.56;z++){
  const p=[ox-ROOM_HALF.x+.28+x*step,oz-ROOM_HALF.z+.28+z*step];
  if(map.free(...p))points.set(x+','+z,p);
 }
 const groups=[],visited=new Set();
 for(const key of points.keys()){
  if(visited.has(key))continue;
  const group=[],queue=[key];visited.add(key);
  for(let n=0;n<queue.length;n++){
   const k=queue[n];group.push(k);const [x,z]=k.split(',').map(Number);
   for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
    const next=(x+dx)+','+(z+dz);if(visited.has(next)||!points.has(next))continue;
    const a=points.get(k),b=points.get(next);
    if(!map.free((a[0]+b[0])/2,(a[1]+b[1])/2))continue;
    visited.add(next);queue.push(next);
   }
  }
  groups.push(group);
 }
 return {points,groups};
}
export function furnishingSpaceError(before,after,catalog,options={}){
 const shape=r=>JSON.stringify([r.x,r.z,r.level,r.boundaries,r.items.filter(i=>!i.stored).map(i=>[i.id,i.assetId,i.x,i.y,i.z,i.rotation,i.length])]);
 const changedLevels=new Set(after.rooms.filter(r=>{const old=before?.rooms.find(o=>o.id===r.id);return !old||shape(old)!==shape(r);}).map(r=>r.level));
 for(const r of before?.rooms||[])if(!after.rooms.some(n=>n.id===r.id))changedLevels.add(r.level);
 for(const room of after.rooms){
  const oldRoom=before?.rooms.find(r=>r.id===room.id);
  if(!changedLevels.has(room.level))continue;
  const next=roomSpace(after,room,catalog,options);
  const old=oldRoom?roomSpace(before,oldRoom,catalog,options):null;
  if(next.points.size<4&&(!old||old.points.size>=4))return `「${room.name}」需要给小人留出站立和互动空间，请挪开一些落地家具`;
  if(!old)continue;
  const membership=new Map(next.groups.flatMap((g,n)=>g.map(k=>[k,n])));
  for(const group of old.groups){
   const counts=new Map();for(const key of group){const id=membership.get(key);if(id!==undefined)counts.set(id,(counts.get(id)||0)+1);}
   if([...counts.values()].filter(n=>n>=4).length>1)return `「${room.name}」的走路通道被挡住了，请换个位置，给走动和互动留出空间`;
  }
 }
 return '';
}
