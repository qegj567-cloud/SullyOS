import {wallCandidates} from './wallMount.js';
import {neighbor,roomOffset} from './topology.js';
import {ROOM_EDGES} from './building.js';

export function daylightPose(item,size,settings={}){
 const reach=Number.isFinite(settings.reach)?Math.max(1,Math.min(6,settings.reach)):2.4;
 const angle=item.rotation*Math.PI/180,n=[Math.sin(angle),Math.cos(angle)],front=size[2]/2+.06;
 const position=[item.x+n[0]*front,item.y+size[1]*.53,item.z+n[1]*front],target=[position[0]+n[0]*reach,.18,position[2]+n[1]*reach];
 return {position,target,angle:Math.atan2(size[0]*.7,Math.hypot(position[1]-.18,reach))};
}
export function windowDaylightSources(home,anchor,catalog,detailedRoomIds){
 const windows=new Map(catalog.filter(a=>a.id==='wooden_window'||a.daylight===true).map(a=>[a.id,a]));
 const result=[];
 for(const room of home.rooms){if(room.level!==anchor.level||!detailedRoomIds.has(room.id))continue;
  for(const item of room.items){const a=windows.get(item.assetId);if(item.stored||!a)continue;
   const face=wallCandidates(item,a,room,catalog).find(c=>c.item.rotation===item.rotation&&Math.hypot(c.item.x-item.x,c.item.z-item.z,c.item.y-item.y)<.003)?.face;
   const edge=face&&Object.keys(ROOM_EDGES).find(e=>face.id.startsWith('shell-'+e+'-'));
   if(!edge||neighbor(home,room,edge))continue; // Internal partitions do not invent outdoor sunshine.
   const [x,z]=roomOffset(room,anchor),renderItem={...item,x:item.x+x,z:item.z+z};
   result.push({id:item.id,roomId:room.id,size:a.size,item:renderItem,settings:a.daylightSettings||{},...daylightPose(renderItem,a.size,a.daylightSettings)});
  }
 }
 return result.sort((a,b)=>(a.roomId===anchor.id?0:1)-(b.roomId===anchor.id?0:1)||Math.hypot(a.position[0],a.position[2])-Math.hypot(b.position[0],b.position[2])||a.id.localeCompare(b.id));
}
