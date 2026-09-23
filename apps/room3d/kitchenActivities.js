import {gamingPoint} from './gaming.js';
import {walkingMap,findWalkPath} from './navigation.js';
import {ROOM_STEP} from './dimensions.js';

// Explicit capabilities: decorative jars and appliances never gain actions by name.
export const KITCHEN_CAPABILITIES={
 kitchenware_coffee:'coffee',
 kitchenware_plates:'wash',kitchen_ref_prep:'wash',kitchenware_settings:'wash',kitchen_ref_breakfast:'wash',
 show_kitchen_range:'cook',kitchen_range:'cook',
 show_kitchen_counter:'sink',kitchen_sink:'sink',
};
export const KITCHEN_LABELS={coffee:'做咖啡',wash:'端去水槽洗碗',cook:'煮饭'};
export function kitchenActions(room,catalog,itemId){
 const item=room.items.find(i=>i.id===itemId&&!i.stored),kind=KITCHEN_CAPABILITIES[item?.assetId];
 if(!KITCHEN_LABELS[kind])return [];
 const sink=room.items.some(i=>!i.stored&&KITCHEN_CAPABILITIES[i.assetId]==='sink');
 return [{action:'chibi-kitchen',id:itemId,kind,label:KITCHEN_LABELS[kind],reason:kind==='wash'&&!sink?'同一个房间需要摆放水槽':''}];
}
export function kitchenFingerprint(room,ids){return JSON.stringify(ids.map(id=>{const i=room?.items.find(i=>i.id===id);return i?[i.id,i.assetId,i.x,i.y,i.z,i.rotation,!!i.stored,i.supportId]:null;}));}
export function planKitchenAction(home,room,catalog,itemId,start,headWidth=1.5){
 const item=room.items.find(i=>i.id===itemId&&!i.stored),kind=KITCHEN_CAPABILITIES[item?.assetId];
 if(!KITCHEN_LABELS[kind])return {reason:'这件家具没有这个动作'};
 const map=walkingMap(home,room.level,catalog,{headWidth}),offset=[room.x*ROOM_STEP.x,room.z*ROOM_STEP.z];
 function station(i,from){
  const parent=room.items.find(p=>p.id===i.supportId&&!p.stored)||i,a=catalog.find(a=>a.id===parent.assetId);
  // Counter fronts remain the approach side; never walk through a cupboard.
  const ia=catalog.find(a=>a.id===i.assetId),cap=KITCHEN_CAPABILITIES[i.assetId];
  const anchor=cap==='coffee'?[-.525,.08,.19]:cap==='cook'?[ia.size[0]*.25,ia.support?.height||ia.size[1],ia.size[2]*.23]:[0,ia.support?.height||.1,0];
  const point=gamingPoint(i,anchor),angle=parent.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),dx=point[0]-parent.x,dz=point[2]-parent.z;
  const along=Math.max(-a.size[0]/2+.3,Math.min(a.size[0]/2-.3,c*dx-s*dz));
  const sides=['show_kitchen_island','kitchen_island','dining_table'].includes(parent.assetId)?[1,-1]:[1];
  for(const side of sides)for(const slide of [0,-.2,.2,-.4,.4]){
   const p=gamingPoint(parent,[along+slide,0,side*(a.size[2]/2+Math.max(.75,headWidth/2)+.08)]);
   const target=[p[0]+offset[0],p[2]+offset[1]],path=findWalkPath(map,from,target);
   if(path)return {id:i.id,parentId:parent.id,target,path,rotation:(parent.rotation+(side===1?180:0))*Math.PI/180,point,tap:cap==='sink'?gamingPoint(i,[0,anchor[1]+.18,-ia.size[2]*.19]):null};
  }
  return null;
 }
 const source=station(item,start);if(!source)return {reason:'家具前方走不过去，请给小人留出通道'};
 let sink=null;
 if(kind==='wash'){
  const sinks=room.items.filter(i=>!i.stored&&KITCHEN_CAPABILITIES[i.assetId]==='sink');
  if(!sinks.length)return {reason:'同一个房间需要摆放水槽'};
  sink=sinks.map(i=>station(i,source.target)).filter(Boolean).sort((a,b)=>a.path.length-b.path.length)[0];
  if(!sink||!findWalkPath(map,sink.target,source.target))return {reason:'盘子到水槽之间没有可走的通道'};
 }
 const dependencies=[...new Set([source.id,source.parentId,sink?.id,sink?.parentId].filter(Boolean))];
 return {kind,itemId,roomId:room.id,source,sink,dependencies,layoutFingerprint:kitchenFingerprint(room,room.items.map(i=>i.id)),fingerprint:kitchenFingerprint(room,dependencies)};
}

// Legacy round hands move rigidly; the new skeleton uses its own FK arm poses.
export function kitchenHands(kind,time,carrying=false){
 const hands=[[-.29,.72,carrying?.43:.90],[.29,.72,carrying?.43:.90]];
 if(!carrying){
  if(kind==='wash'){hands[1][0]=.10+Math.sin(time*7)*.10;hands[1][2]+=.07*Math.cos(time*7);}
  if(kind==='coffee')hands[1][1]+=.10*Math.max(0,Math.sin(time*2));
  if(kind==='cook'){hands[1][0]=.13+Math.cos(time*3)*.10;hands[1][2]+=.10*Math.sin(time*3);}
 }
 return hands;
}
