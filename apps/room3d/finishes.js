import {ROOM_HALF} from './dimensions.js';
import {ROOM_EDGES} from './building.js';
import {boundary,neighbor,OPPOSITE,roomBoundarySegments,subtractIntervals} from './topology.js';
export const FLOOR_STYLES={original:'原木拼板',wood:'细木地板',tile:'方砖',marble:'黑白石材拼花',checker:'双色格',stone:'错缝石砖',parquet:'拼花木地板',solid:'素色'};
export const WALL_STYLES={solid:'素色墙',stripe:'细条纹',dot:'小圆点',panel:'半墙护板',timber:'竖木护墙',tile:'厨房小方砖',spa:'温泉石裙墙',framed:'木框奶油墙'};
export function validateFinishes(room){
 if(room.floorStyle!=null&&!Object.hasOwn(FLOOR_STYLES,room.floorStyle)||room.wallStyle!=null&&!Object.hasOwn(WALL_STYLES,room.wallStyle))throw Error('地板或壁纸样式不正确');
}
// Each room owns the finish on its inward-facing surface, even when the wall
// structure is shared. Door openings and replaceable perimeter segments survive.
export function wallFinishPanels(home,room,catalog){
 const panels=[];
 for(const edge of Object.keys(ROOM_EDGES)){
  const other=neighbor(home,room,edge);let segments=roomBoundarySegments(room,edge,catalog);
  if(other)for(const extra of roomBoundarySegments(other,OPPOSITE[edge],catalog).filter(s=>s.itemId)){
   segments=segments.flatMap(s=>subtractIntervals([[s.lo,s.hi]],extra.lo,extra.hi).map(([lo,hi])=>({...s,lo,hi})));segments.push(extra);
  }
  for(const s of segments)if(s.kind!=='wall_fence')panels.push({...s,edge,internal:!!other,bottom:.18,top:s.kind==='wall_high'?4.53:.82});
  const b=boundary(room,edge);if(b.kind==='wall_high'&&b.door)panels.push({edge,internal:!!other,lo:b.door.at-b.door.width/2,hi:b.door.at+b.door.width/2,bottom:b.door.kind==='arch'?2.2:2.47,top:4.53,arch:b.door.kind==='arch'});
 }
 return panels;
}
export const floorFinishBounds=[-ROOM_HALF.x+.13,-ROOM_HALF.z+.13,ROOM_HALF.x-.13,ROOM_HALF.z-.13];
