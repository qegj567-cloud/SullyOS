import {ROOM_HALF} from './dimensions.js';
import {ROOM_EDGES,buildingEdge} from './building.js';
import {roomBoundarySegments} from './topology.js';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

// Real wall faces, not empty room edges. Low walls and fences cannot hold a
// full window. Window geometry is authored facing +Z; rotation follows normal.
export function wallFaces(room,catalog){
 const faces=[];
 for(const [edge,e] of Object.entries(ROOM_EDGES))for(const s of roomBoundarySegments(room,edge,catalog)){
  if(s.kind!=='wall_high')continue;const normal=-Math.sign(e.at);
  faces.push({id:`shell-${edge}-${s.lo}`,axis:e.axis,at:e.at+normal*.12,normal,rotation:e.axis==='z'?(normal===1?0:180):(normal===1?90:270),lo:s.lo+.02,hi:s.hi-.02,bottom:.15,top:4.8});
 }
 for(const item of room.items){if(item.stored||item.assetId!=='wall_high'||buildingEdge(item))continue;const a=catalog.find(a=>a.id===item.assetId);if(!a)continue;const axis=item.rotation%180===0?'z':'x',along=axis==='z'?'x':'z',length=item.length??a.size[0];
  for(const normal of [1,-1])faces.push({id:item.id+':'+normal,owner:item.id,axis,at:item[axis]+normal*a.size[2]/2,normal,rotation:axis==='z'?(normal===1?0:180):(normal===1?90:270),lo:item[along]-length/2,hi:item[along]+length/2,bottom:item.y,top:item.y+a.size[1]});
 }
 // Adjacent high-wall segments form one usable face for a wider window.
 const merged=[];for(const f of faces.filter(f=>f.hi>f.lo).sort((a,b)=>a.lo-b.lo)){
  const previous=merged.find(p=>p.axis===f.axis&&p.normal===f.normal&&Math.abs(p.at-f.at)<.001&&Math.abs(p.top-f.top)<.001&&Math.abs(p.bottom-f.bottom)<.001&&f.lo<=p.hi+.041&&f.hi>=p.lo-.041);
  if(previous){previous.lo=Math.min(previous.lo,f.lo);previous.hi=Math.max(previous.hi,f.hi);}else merged.push({...f});
 }
 return merged;
}
export function mountOnFace(item,asset,face){
 const half=asset.size[0]/2,along=face.axis==='z'?'x':'z';
 if(face.hi-face.lo<asset.size[0]+.04||face.top-face.bottom<asset.size[1]+.04)return null;
 const inset=asset.wallOpening&&!face.owner?Math.min(.20,asset.wallOpening.inset||0):0;
 const at=face.at+face.normal*(asset.size[2]/2+.012-inset);
 const result={...item,[face.axis]:at,[along]:clamp(item[along],face.lo+half+.02,face.hi-half-.02),y:clamp(item.y,face.bottom+.02,face.top-asset.size[1]-.02),rotation:face.rotation};
 // Do not expose the outside-facing surface of an exterior wall.
 if(Math.abs(result.x)>ROOM_HALF.x-.09||Math.abs(result.z)>ROOM_HALF.z-.10)return null;
 return result;
}
export function wallCandidates(item,asset,room,catalog){
 return wallFaces(room,catalog).flatMap(face=>{const next=mountOnFace(item,asset,face);return next?[{face,item:next,distance:Math.hypot(next.x-item.x,next.y-item.y,next.z-item.z)}]:[];}).sort((a,b)=>a.distance-b.distance||(a.item.rotation===item.rotation?-1:1));
}
export function snapToWall(item,asset,room,catalog){return wallCandidates(item,asset,room,catalog)[0]?.item??null;}
export function wallPlacementError(item,asset,room,catalog){return wallCandidates(item,asset,room,catalog).some(c=>c.item.rotation===item.rotation&&Math.abs(c.item.x-item.x)<.002&&Math.abs(c.item.y-item.y)<.002&&Math.abs(c.item.z-item.z)<.002)?'':'请把挂墙物件贴在足够宽的高墙上';}
