import {clone,uid,validateHome,placementError} from './model.js';
import {ROOM_SIZE_VERSION} from './dimensions.js';
import {boundary,neighbor,OPPOSITE} from './topology.js';
import {layoutError} from './layout.js';

const ROOM_KEYS=['name','wall','floor','trim','wallStyle','floorStyle'];
const ITEM_KEYS=['id','assetId','x','y','z','rotation','color','materialColors','length','supportId','dockId','dockSlot','dockDisabled'];
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,clone(value[k])]));
function cleanRoom(source){
 if(!source||!Array.isArray(source.items)||source.items.length>100)throw Error('房间家具列表不正确（最多 100 件）');
 const room={...pick(source,ROOM_KEYS),id:'shared-room',x:0,z:0,level:0,items:source.items.map(i=>{
  if(!i||typeof i!=='object')throw Error('家具参数不正确');return {...pick(i,ITEM_KEYS),stored:false};
 })};
 if(source.boundaries!=null){
  if(typeof source.boundaries!=='object'||Array.isArray(source.boundaries))throw Error('墙体参数不正确');
  room.boundaries=Object.fromEntries(Object.entries(source.boundaries).map(([edge,b])=>{
   if(!b||typeof b!=='object')throw Error('墙体参数不正确');
   return [edge,{kind:b.kind,...b.door?{door:pick(b.door,['kind','at','width'])}:{}}];
  }));
 }
 return room;
}
function checkedRoom(room,catalog){
 const missing=[...new Set(room.items.filter(i=>!catalog.some(a=>a.id===i.assetId)).map(i=>i.assetId))];
 if(missing.length)throw Error('缺少家具素材：'+missing.slice(0,5).join('、')+'。请更新到支持这些素材的版本');
 const valid=validateHome({version:1,assetVersion:2,roomSizeVersion:ROOM_SIZE_VERSION,activeRoomId:room.id,rooms:[room]},catalog).rooms[0];
 for(const i of valid.items){const before=room.items.find(v=>v.id===i.id);
  if(['x','y','z','rotation','stored'].some(k=>i[k]!==before[k]))throw Error('家具位置无法完整还原，请检查墙面与承托关系');
  const error=placementError(i,valid,catalog);if(error)throw Error((catalog.find(a=>a.id===i.assetId)?.name||i.assetId)+'：'+error);
 }
 return valid;
}
export function exportRoomLayout(room,catalog){
 const source=cleanRoom({...room,items:room.items.filter(i=>!i.stored)}),ids=new Map(source.items.map((i,n)=>[i.id,'item-'+(n+1)]));
 for(const i of source.items){for(const key of ['supportId','dockId'])if(i[key]!=null){if(!ids.has(i[key]))throw Error('家具组合跨越房间，暂不能单独分享；可使用整屋备份');i[key]=ids.get(i[key]);}i.id=ids.get(i.id);}
 return {format:'sully-room-layout',version:1,roomSizeVersion:ROOM_SIZE_VERSION,room:checkedRoom(source,catalog)};
}
export function parseRoomLayout(input,catalog){
 if(typeof input==='string'&&input.length>1024*1024)throw Error('房间参数过大（上限 1 MB）');
 let raw;try{raw=typeof input==='string'?JSON.parse(input):input;}catch{throw Error('无法读取参数，请使用完整的房间 JSON 文件或文本');}
 if(raw?.format!=='sully-room-layout'||raw.version!==1)throw Error('不是支持的房间分享格式；整屋存档请用“恢复整屋备份”');
 if(raw.roomSizeVersion!==ROOM_SIZE_VERSION)throw Error('房间尺寸版本不兼容，请更新应用');
 return checkedRoom(cleanRoom(raw.room),catalog);
}
// Work only on copies. Failed imports never mutate the user's home.
export function applyRoomLayout(home,roomId,incoming,catalog){
 const next=clone(home),index=next.rooms.findIndex(r=>r.id===roomId);if(index<0)throw Error('目标房间不存在');
 const target=next.rooms[index],source=checkedRoom(cleanRoom(incoming),catalog),ids=new Map(source.items.map(i=>[i.id,uid()]));
 for(const i of source.items){for(const k of ['supportId','dockId'])if(i[k]!=null)i[k]=ids.get(i[k]);i.id=ids.get(i.id);}
 const room={...source,id:target.id,x:target.x,z:target.z,level:target.level,items:[...source.items,...target.items.filter(i=>i.stored)]};
 // Shared boundaries belong to both rooms: leave neighbors' walls and doors alone.
 for(const edge of ['left','right','front','back']){const other=neighbor(next,target,edge);if(other)room.boundaries={...room.boundaries,[edge]:clone(boundary(other,OPPOSITE[edge]))};}
 next.rooms[index]=room;
 const validated=validateHome(next,catalog),result=validated.rooms[index];
 for(const item of room.items){const actual=result.items.find(i=>i.id===item.id);if(['x','y','z','rotation','stored'].some(k=>actual[k]!==item[k]))throw Error('当前房间的共用墙面不适合这份布局，未修改房间');}
 const error=layoutError(validated,catalog);if(error)throw Error('布局无法应用：'+error);
 return validated;
}
