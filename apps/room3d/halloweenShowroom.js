import {uid,placementError,findResidentSpot} from './model.js';
import {snapToWall} from './wallMount.js';

export function furnishHalloween(room,catalog){
 room.fixedPalette='halloween';
 const asset=id=>catalog.find(a=>a.id===id);
 const put=(name,x,z,rotation=0,y=.15)=>{
  const assetId='halloween_'+name,a=asset(assetId);if(!a)throw Error('缺少万圣节家具：'+assetId);
  let item={id:uid(),assetId,x,y,z,rotation,color:null,stored:false};
  if(a.surface==='wall')item=snapToWall(item,a,room,catalog);
  if(!item)throw Error('万圣节墙饰没有可用墙面');room.items.push(item);return item;
 };
 // Rear lounge, left fireplace nook and a continuous front-to-right entry aisle.
 put('bat_sofa',.6,-2.62);
 put('coffin_coffee_table',.6,.4);
 put('pumpkin_armchair',-2.15,1.3,0);
 put('potion_bookcase',-3.35,-3.15);
 const fireplace=put('haunted_fireplace',-3.99,-.6,90);
 put('ghost_floor_lamp',3.45,-2.8);
 put('gothic_curtain_window',.6,-4,0,1.84);
 put('bat_rug',.55,.55,0,.18);
 put('cauldron_planter',-3.9,1.45);
 put('cat_ear_mirror',-3.85,2.85,90);
 put('bat_pumpkin_clock',-4.7,-.6,0,3.02);
 const lantern=put('pumpkin_lantern',fireplace.x-.08,fireplace.z,90,fireplace.y+asset(fireplace.assetId).support.height);lantern.supportId=fireplace.id;
 for(const item of room.items){const reason=placementError(item,room,catalog);if(reason)throw Error(asset(item.assetId).name+'：'+reason);}
 if(!findResidentSpot(room,catalog))throw Error('万圣节样板房没有留下通道');
 return room;
}
