import {showroomItems,KITCHEN_MATERIAL_COLORS} from './showroomGroups.js';
import {addRoom,clone,uid,placementError,findResidentSpot} from './model.js';
import {setBoundary} from './topology.js';
import {snapToWall} from './wallMount.js';
import {furnishReferenceBedroom} from './bedroomReference.js';
import {furnishGamingStudy} from './studyShowroom.js';
import {furnishReferenceLiving} from './livingReference.js';
// Whole furniture groups are editable after placement. No room-sized mesh.
export const SHOWROOMS={
 study:{name:'黑绿电竞书房',wall:'#f0e8dc',floor:'#c4b29a',trim:'#393e33',floorStyle:'wood',wallStyle:'solid',items:[],door:'oak'},
 kitchen:{name:'现代黑白厨房',wall:'#f0f0ef',floor:'#e3e4e5',trim:'#34363a',floorStyle:'marble',wallStyle:'tile',door:'oak',},
 living:{name:'暖木绿白客厅',wall:'#f0e6d5',floor:'#c8b295',trim:'#725849',floorStyle:'wood',wallStyle:'solid',items:[['show_living_sofa',.6,-2.45],['show_living_table',.6,.1],['show_living_console',-3.85,-.3,90],['show_living_pouf',2.6,1.7],['show_cat_tree',3.65,-2.2],['monstera',-3,2.7]],door:'ribbon'},
 bedroom:{name:'暖木卧室',wall:'#e8ddcf',floor:'#d6b894',trim:'#eacba8',floorStyle:'wood',wallStyle:'solid',items:[['show_bed',.3,-1.75],['show_wardrobe',-3.35,-2.6],['show_bedroom_low_shelf',-3.85,.6,90],['show_bedroom_dresser',3.85,-1,270],['show_bedroom_bench',.3,1.05],['suite_floor_mirror',-3.85,2.90,90],['suite_plant_large',3.35,2.55]],door:'ribbon'},
};
// The fixed pieces stay coarse; decor is independently selectable. Coordinates
// on a tabletop are local to its owner so rotated cabinets work identically.
const DECOR={
 study:{wall:[['suite_window_study',.7,2.6,-4],['suite_art_abstract',-4.7,2.5,2]],props:[['gaming_monitors','show_study_desk',0,0],['gaming_keyboard','show_study_desk',0,.26],['bedroom_table_lamp','show_study_desk',1.48,0],['suite_tea_tray','show_study_tea_table',-.32,0],['suite_books_plant','show_study_tea_table',.40,0]]},
 kitchen:{wall:[['kitchen_ref_window',-.3,2.35,-4],['kitchen_ref_hood',2.545,2.04,-4],['kitchen_ref_shelves',-4.7,2.25,.85]],props:[['kitchen_ref_prep','show_kitchen_counter',-1.5,0],['kitchenware_spices','show_kitchen_counter',1.6,-.17],['kitchenware_pot','show_kitchen_range',-.4375,.15],['kitchen_ref_breakfast','show_kitchen_island',0,0],['kitchenware_coffee','show_bedroom_dresser',0,0]]},
 living:{wall:[['suite_window_living',.6,2.05,-4],['suite_art_abstract',-4.7,2.8,-.7],['suite_wall_shelf',-4.7,2.3,1.2]],props:[['suite_tea_tray','show_living_table',-.45,0],['daisy_vase','show_living_table',.5,0],['small_television','show_living_console',0,0]]},
 bedroom:{wall:[['suite_window_bedroom',.3,2.15,-4],['suite_art_botanical',-4.7,2.1,.5],['suite_wall_shelf',-4.7,2.8,2]],props:[['bedroom_table_lamp','show_bedroom_dresser',-.8,0],['bedroom_alarm','show_bedroom_dresser',-.10,0],['suite_dressing_mirror','show_bedroom_dresser',.72,-.06],['suite_plant_small','show_bedroom_low_shelf',0,0]]},
};
Object.assign(SHOWROOMS.study,{door:'oak'});Object.assign(SHOWROOMS.kitchen,{door:'oak'});Object.assign(SHOWROOMS.living,{door:'walnut',wallStyle:'framed'});Object.assign(SHOWROOMS.bedroom,{door:'walnut',wallStyle:'framed'});
export function applyShowroomStyle(room,key){
 const t=SHOWROOMS[key];if(!t)throw Error('找不到这套房间配色');
 for(const part of ['wall','trim','floor','floorStyle','wallStyle'])room[part]=t[part];
}
export function furnishShowroom(room,key,catalog,{compact=false}={}){
 const template=SHOWROOMS[key];if(!template)throw Error('找不到这套样板房');
 if(room.items.length)throw Error('样板房需要空房间，原有家具不会被覆盖');
 Object.assign(room,{name:template.name,wall:template.wall,trim:template.trim,floor:template.floor,floorStyle:template.floorStyle,wallStyle:template.wallStyle});
 if(key==='bedroom'&&!compact)return furnishReferenceBedroom(room,catalog);
 if(key==='study')return furnishGamingStudy(room,catalog,{compact});
 if(key==='living'&&!compact)return furnishReferenceLiving(room,catalog);
 for(const [assetId,x,z,rotation=0,color=null]of (key==='kitchen'?showroomItems(key):template.items)){const a=catalog.find(a=>a.id===assetId);if(!a)throw Error('样板房素材未加载：'+assetId);const item={id:uid(),assetId,x,y:.15,z,rotation,color,stored:false};const reason=placementError(item,room,catalog);if(reason)throw Error(template.name+' · '+a.name+'：'+reason);room.items.push(item);}
 const put=item=>{const reason=placementError(item,room,catalog);if(reason)throw Error(template.name+' · '+item.assetId+'：'+reason);room.items.push(item);};
 for(const [assetId,x,y,z]of DECOR[key].wall){const a=catalog.find(a=>a.id===assetId);if(!a)throw Error('缺少装饰：'+assetId);const i=snapToWall({id:uid(),assetId,x,y,z,rotation:0,color:null,stored:false},a,room,catalog);if(!i)throw Error('没有足够的墙面');put(i);}
 for(const [assetId,parentId,x,z]of DECOR[key].props){const parent=room.items.find(i=>i.assetId===parentId),a=catalog.find(a=>a.id===parentId),angle=parent.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);put({id:uid(),assetId,x:parent.x+c*x+s*z,y:parent.y+a.support.height,z:parent.z-s*x+c*z,rotation:parent.rotation,color:null,stored:false,supportId:parent.id});}
 if(['study','living','bedroom'].includes(key))put({id:uid(),assetId:key==='living'?'suite_rug_grid':'suite_rug_border',x:0,y:.15,z:.35,rotation:0,color:null,stored:false});
 for(const i of room.items)if(['show_bed','show_living_sofa'].includes(i.assetId))i.materialColors={'pillow-left':'#82917d','pillow-right':key==='living'?'#bcb28c':'#d9c5b7'};
 if(key==='kitchen')for(const i of room.items)if(KITCHEN_MATERIAL_COLORS[i.assetId])i.materialColors={...KITCHEN_MATERIAL_COLORS[i.assetId]};
 if(!findResidentSpot(room,catalog))throw Error('样板房没有给小人留出空间');
 return room;
}
export function addShowroom(home,key,catalog,options={}){
 if(!SHOWROOMS[key])throw Error('找不到这套样板房');
 // Work on a copy: failed placement/capacity never leaves a partial room.
 const next=clone(home),anchor=next.rooms.find(r=>r.id===next.activeRoomId);
 const direction=[['right',1,0],['front',0,1],['left',-1,0],['back',0,-1]].find(([,dx,dz])=>!next.rooms.some(r=>r.level===anchor.level&&r.x===anchor.x+dx&&r.z===anchor.z+dz)&&(anchor.level===0||next.rooms.some(r=>r.level===anchor.level-1&&r.x===anchor.x+dx&&r.z===anchor.z+dz)));
 if(!direction)throw Error('这间房四周没有可扩建位置，请换到边上的房间');
 const room=addRoom(next,direction[0]);furnishShowroom(room,key,catalog,options);
 // Give each room a clear front entry, without altering furnished neighbors.
 if(!next.rooms.some(r=>r.id!==room.id&&r.level===room.level&&r.x===room.x&&r.z===room.z+1))setBoundary(next,room.id,'front',{kind:'wall_high',door:{kind:SHOWROOMS[key].door,at:0,width:2.2}},catalog);
 Object.assign(home,next);return room;
}
