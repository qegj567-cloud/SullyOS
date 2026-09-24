import {wallCandidates} from './wallMount.js';
import {ROOM_EDGES} from './building.js';

// Apertures derive from placed windows, so moving/storing/undoing a window
// rebuilds both the structural wall and its decorative surface together.
export function windowOpenings(room,edge,catalog){
 const e=ROOM_EDGES[edge],along=e.axis==='z'?'x':'z';
 return room.items.flatMap(i=>{
  const a=catalog.find(a=>a.id===i.assetId),o=a?.wallOpening;
  if(i.stored||!o)return [];
  const mount=wallCandidates(i,a,room,catalog).find(c=>c.face.id.startsWith('shell-'+edge+'-')&&Math.hypot(c.item.x-i.x,c.item.y-i.y,c.item.z-i.z)<.003);
  return mount?[{lo:i[along]-o.width/2,hi:i[along]+o.width/2,bottom:i.y+o.bottom,top:i.y+o.top}]:[];
 });
}
export function subtractOpenings(panel,openings){
 return openings.reduce((panels,o)=>panels.flatMap(p=>{
  const l=Math.max(p.lo,o.lo),r=Math.min(p.hi,o.hi),b=Math.max(p.bottom,o.bottom),t=Math.min(p.top,o.top);
  if(l>=r||b>=t)return [p];
  return [{...p,hi:l},{...p,lo:r},{...p,lo:l,hi:r,top:b},{...p,lo:l,hi:r,bottom:t}].filter(p=>p.hi-p.lo>.001&&p.top-p.bottom>.001);
 }),[panel]);
}
