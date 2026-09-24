import {uid,placementError,findResidentSpot,snapToSupport} from './model.js';
import {gamingPreset,gamingActivities} from './gaming.js';
import {snapToWall} from './wallMount.js';

export function furnishGamingStudy(room,catalog,{compact=false}={}){
 const put=(assetId,x,z,rotation=0,color=null,y=.15)=>{
  const a=catalog.find(a=>a.id===assetId);if(!a)throw Error('书房素材未加载：'+assetId);
  let item={id:uid(),assetId,x,y,z,rotation,color,stored:false};
  if(a.surface==='wall')item=snapToWall(item,a,room,catalog);
  if(!item)throw Error('书房墙面空间不足');room.items.push(item);return item;
 };
 // A complete calibrated desk/chair bundle, translated together to the back wall.
 for(const item of gamingPreset('stream',catalog)){
  item.x+=.4;item.z-=2.1;item.color='#858d67';room.items.push(item);
 }
 put('gaming_pc',-1.6,-3,270,'#858d67');
 const tower=put('show_study_tower',-3.65,-3.35);
 const shelf=put('show_study_shelf',-4.12,-.4,90);
 put('gaming_organizer',3.2,-2.8,0,'#858d67');
 put('study_ref_floor_light',-2.2,-3.4);
 put(compact?'suite_window_study':'study_ref_window',.4,-4,0,'#eee3cf',compact?2.85:2.28);
 put('suite_art_botanical',-4.7,-1.6,0,'#343b36',2.25);
 put('study_ref_rug',.4,-.35);
 if(!compact){
  const prop=(id,parent,x=0,z=0)=>{
   const a=catalog.find(a=>a.id===parent.assetId),angle=parent.rotation*Math.PI/180;
   const item=put(id,parent.x+Math.cos(angle)*x+Math.sin(angle)*z,parent.z-Math.sin(angle)*x+Math.cos(angle)*z,parent.rotation,null,parent.y+a.support.height);
   item.supportId=parent.id;return item;
  };
  prop('study_ref_printer_set',shelf);
  prop('study_ref_cabinet_plants',tower);
  put('study_ref_memo',-4.7,.58,0,null,1.83);
  put('study_ref_wall_shelves',3.15,-4,0,null,2.63);
  put('study_ref_headphone_board',3.2,-4,0,null,1.83);
  put('bedroom_ref_photo_string',-4.7,-2.5,0,null,1.7);
  put('study_ref_cart',-4,1.8,270);
  put('monstera',-4,3.2);
  put('suite_plant_large',3.6,3.2);
  put('bedroom_ref_flower_pouf',-1.1,1.15,0,'#eee3cf');
  put('study_ref_entry_mat',0,3.40);
  const desk=room.items.find(i=>i.assetId==='gaming_desk');
  const lamp=prop('study_ref_task_lamp',desk,-1.43,.26);lamp.color='#858d67';
  Object.assign(lamp,snapToSupport(lamp,room,catalog));
 }
 for(const item of room.items){if(item.assetId.startsWith('gaming_'))item.materialColors=Object.fromEntries((catalog.find(a=>a.id===item.assetId).colorParts||[]).filter(p=>p.material!=='gaming-accent').map(p=>[p.material,p.color]));const error=placementError(item,room,catalog);if(error)throw Error(item.assetId+'：'+error);}
 if(!findResidentSpot(room,catalog))throw Error('书房没有留下通道');
 for(const a of gamingActivities(room,catalog,{headWidth:1.8}))if(a.reason)throw Error(a.label+'：'+a.reason);
 return room;
}
