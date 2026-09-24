import {uid,placementError,findResidentSpot} from './model.js';
import {snapToWall} from './wallMount.js';

export function furnishReferenceLiving(room,catalog){
 const asset=id=>catalog.find(a=>a.id===id);
 const put=(assetId,x,z,rotation=0,y=.15,color=null,supportId)=>{
  const a=asset(assetId);if(!a)throw Error('缺少客厅素材：'+assetId);
  let i={id:uid(),assetId,x,y,z,rotation,color,stored:false,...supportId?{supportId}:{}};
  if(a.surface==='wall')i=snapToWall(i,a,room,catalog);
  if(!i)throw Error('客厅墙面空间不足：'+assetId);room.items.push(i);return i;
 };
 const prop=(id,parent,x=0,z=0,color=null)=>{const a=asset(parent.assetId),t=parent.rotation*Math.PI/180;return put(id,parent.x+Math.cos(t)*x+Math.sin(t)*z,parent.z-Math.sin(t)*x+Math.cos(t)*z,parent.rotation,parent.y+a.support.height,color,parent.id);};
 // Window-side seating and the media wall share one lounge, with an open front aisle.
 const sofa=put('living_ref_sofa',.95,-2.58,0,.15,'#eee3ce');
 sofa.materialColors={'pillow-left':'#858d67','pillow-right':'#a6ac89'};
 const table=put('show_living_table',.55,-.05,0);
 const console=put('living_ref_console',-4.03,-.50,90);
 prop('living_ref_television',console,0,-.04);
 prop('living_ref_console_plant',console,-1.48,.04);
 prop('living_ref_console_plant',console,1.48,.04);
 const bookcase=put('living_ref_bookcase',-4.1,2.12,90);prop('living_ref_bookcase_top',bookcase);
 put('living_ref_record_cabinet',3.97,3.10,270);
 put('living_ref_cat_tree',3.83,1.40,0,.15);
 put('living_ref_tree',-3.6,-3.16);
 put('monstera',-3.85,3.22);
 put('bedroom_ref_flower_pouf',-.30,1.62,0,.15,'#858d67');
 const side=put('bedroom_ref_tea_table',-1.72,-2.55);prop('bedroom_ref_tea',side);
 put('bedroom_ref_floor_lamp',-2.60,-2.35);
 put('living_ref_window',.88,-4,0,.45);
 put('living_ref_wall_shelf',-4.7,1.90,0,2.20);
 put('living_ref_clock',-4.7,3.16,0,2.18);
 put('suite_art_abstract',-4.7,-.55,0,3.03,'#795c46');
 put('suite_art_botanical',-2.48,-4,0,2.55,'#b7a080');
 put('living_ref_rug',.2,.1);
 put('study_ref_entry_mat',0,3.40);
 prop('living_ref_books',table,-.57);
 prop('living_ref_tea_tray',table,.27);
 for(const i of room.items){const why=placementError(i,room,catalog);if(why)throw Error(i.assetId+'：'+why);}
 if(!findResidentSpot(room,catalog))throw Error('客厅没有留出通道');
 return room;
}
