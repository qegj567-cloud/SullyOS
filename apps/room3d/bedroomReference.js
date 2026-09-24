import {uid,placementError,findResidentSpot} from './model.js';
import {snapToWall} from './wallMount.js';

// Full desktop arrangement from the supplied reference. Each furnishing stays
// editable; books inside cabinets are geometry, tabletop sets are supported.
export function furnishReferenceBedroom(room,catalog){
 const asset=id=>catalog.find(a=>a.id===id);
 const put=(assetId,x,y,z,rotation=0,supportId)=>{
  let item={id:uid(),assetId,x,y,z,rotation,color:null,stored:false,...supportId?{supportId}:{}};
  const a=asset(assetId);if(!a)throw Error('缺少卧室素材：'+assetId);
  if(a.surface==='wall'){item=snapToWall(item,a,room,catalog);if(!item)throw Error('卧室墙面不足：'+a.name);}
  const why=placementError(item,room,catalog);if(why)throw Error(a.name+'：'+why);
  room.items.push(item);return item;
 };
 const floor=(id,x,z,rotation=0)=>put(id,x,.15,z,rotation);
 const prop=(id,parent,x=0,z=0)=>{
  const a=asset(parent.assetId),s=a.support,angle=parent.rotation*Math.PI/180,c=Math.cos(angle),sn=Math.sin(angle);
  x+=s.center?.[0]??0;z+=s.center?.[1]??0;
  return put(id,parent.x+c*x+sn*z,parent.y+s.height,parent.z-sn*x+c*z,parent.rotation,parent.id);
 };
 const bed=floor('show_bed',.55,-2.00);
 bed.materialColors={'pillow-left':'#82917d','pillow-right':'#d9c5b7'};
 const wardrobe=floor('bedroom_ref_wardrobe',-3.18,-3.10);
 const sideboard=floor('bedroom_ref_sideboard',-4.04,-.24,90);
 const dresser=floor('bedroom_ref_dresser',3.70,.92,90);
 const bench=floor('bedroom_ref_bench',.55,.21);
 floor('suite_floor_mirror',-4.06,2.56,90);
 floor('suite_plant_large',2.74,2.93);
 floor('bedroom_ref_flower_pouf',-1.58,1.93);
 const table=floor('bedroom_ref_tea_table',-1.97,.65);
 const nightstand=floor('bedroom_ref_nightstand',-1.68,-3.17);
 floor('bedroom_ref_floor_lamp',3.93,-1.26);
 floor('bedroom_ref_bin',3.68,2.79);
 const window=put('bedroom_ref_window',.60,1.91,-4);
 put('bedroom_ref_wall_rack',-4.7,2.02,-1.35);
 put('suite_art_botanical',-4.7,2.06,.45);
 put('suite_wall_shelf',-4.7,2.72,1.84);
 put('bedroom_ref_moon_art',3.42,2.45,-4);
 put('bedroom_ref_photo_string',3.37,1.72,-4);
 prop('bedroom_ref_wardrobe_top',wardrobe);
 prop('bedroom_ref_sideboard_top',sideboard);
 prop('bedroom_ref_dresser_top',dresser);
 prop('bedroom_ref_sleeping_cat',bench,.30);
 prop('bedroom_ref_tea',table);
 prop('bedroom_ref_bedside_top',nightstand);
 prop('bedroom_ref_sill_garden',window);
 floor('bedroom_ref_rug',.13,.38);
 floor('bedroom_ref_entry_mat',-.25,3.40);
 if(!findResidentSpot(room,catalog))throw Error('卧室需要留出小人通道');
 return room;
}
