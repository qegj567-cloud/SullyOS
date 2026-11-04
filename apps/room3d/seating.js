// Reviewed body-2 poses. Keep them separate from the generated asset catalog;
// low height alone does not make a stool suitable for a floor-rest pose.
const body2SeatProfiles={bedroom_ref_flower_pouf:{pose:'floor',forward:.20}};
// Reviewed mattress surface, not the wider draped blanket/bed-frame bounds.
const body2BedProfiles={
 show_bed:{headEnd:-1.27,edgeX:1.30,edgeY:.85,
  // Measured at both sleeping lanes on show_bed.glb; the duvet rolls down
  // toward the foot of the bed. Heights are furniture-local, not world Y.
  footSurface:[[.6,.887],[.8,.900],[1,.898],[1.2,.882],[1.4,.788],[1.6,.627]]},
 bedroom_single_bed:{headEnd:-1.38,edgeX:.82,edgeY:1.10},
 bedroom_double_bed:{headEnd:-1.55,edgeX:1.48,edgeY:1.08},
 // Keep the existing direct entry for raised/railed beds; no invented ladder animation.
 bedroom_bunk:{headEnd:-1.65,entry:false},
 bedroom_loft:{headEnd:-1.45,entry:false},
};
// Seat coordinates are in the normalized furniture's local frame: +Y up, +Z front.
export function seatTransform(room,catalog,selection,body2=false){
 if(!selection||selection.roomId!==room.id)return null;
 const item=room.items.find(i=>i.id===selection.itemId&&!i.stored);
 const a=catalog.find(a=>a.id===item?.assetId);
 const seat=(selection.bed?a?.beds:a?.seats)?.find(s=>s.id===selection.seatId);
 if(!item||!seat)return null;
 const angle=item.rotation*Math.PI/180,[x,y,z]=seat.position,rotation=angle+(seat.rotation??0)*Math.PI/180;
 const bedPlacement=selection.bed&&a.id==='show_bed'?{across:.70,forward:.35}:null;
 const profile=body2&&!selection.bed?body2SeatProfiles[a.id]:null,forward=bedPlacement?.forward??(selection.dining&&a.id==='show_kitchen_bench'?.15:profile?.forward??0);
 const bedProfile=body2&&selection.bed?body2BedProfiles[a.id]:null;
 const localAngle=(seat.rotation??0)*Math.PI/180,along=x*Math.sin(localAngle)+z*Math.cos(localAngle),across=x*Math.cos(localAngle)-z*Math.sin(localAngle);
 const inward=bedPlacement?(Math.sign(across)||1)*bedPlacement.across-across:0;
 return {position:[item.x+x*Math.cos(angle)+z*Math.sin(angle)+Math.sin(rotation)*forward+Math.cos(rotation)*inward,item.y+y,item.z-x*Math.sin(angle)+z*Math.cos(angle)+Math.cos(rotation)*forward-Math.sin(rotation)*inward],rotation,pose:profile?.pose??'chair',height:item.y+y-.18,...bedProfile?{bed:{...bedProfile,anchorZ:along+forward,center:[item.x,item.y,item.z],halfWidth:(Math.abs(Math.cos(localAngle))*a.size[0]+Math.abs(Math.sin(localAngle))*a.size[2])/2,side:Math.sign(across)||1,itemRotation:rotation}}:{}};
}
export function roomBeds(room,catalog){
 return room.items.filter(i=>!i.stored).flatMap(item=>{
  const a=catalog.find(a=>a.id===item.assetId);
  return (a?.beds??[]).map(b=>({roomId:room.id,itemId:item.id,seatId:b.id,bed:true,label:a.name+' · '+b.label}));
 });
}
export function roomSeats(room,catalog){
 return room.items.filter(i=>!i.stored).flatMap(item=>{
  const asset=catalog.find(a=>a.id===item.assetId);
  return (asset?.seats??[]).map(seat=>({roomId:room.id,itemId:item.id,seatId:seat.id,label:asset.name+(asset.seats.length>1?' · '+seat.label:'')}));
 });
}
