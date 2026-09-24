import {snapToWall} from '../../apps/room3d/wallMount.js';
import {createHome,findPlace} from '../../apps/room3d/model.js';
export function bathroomHome(catalog){
 const home=createHome(catalog),r=home.rooms[0];Object.assign(r,{name:'黑白绿浴室',wall:'#eee8dc',floor:'#9ba591',trim:'#343b36',floorStyle:'tile',wallStyle:'solid'});r.items=[];
 // Wet zone along the left wall; vanity/storage on the back wall.
 // Toilet is on the rear wall; the laundry group faces inward from the front.
 const green='#81916b',black='#343b36',white='#f2f3ed';
 for(const [assetId,x,z,rotation,color]of [
  ['bath_tub',-3.55,-1.7,90,green],['bath_shower',-3.55,1.8,90,green],
  ['bath_towel_rack',-3.5,-3.5,0,white],['bath_stool',-3.55,.3,0,green],
  ['bath_vanity',-.85,-3.25,0,black],['bath_linen_cabinet',1.0,-3.48,0,green],
  ['bath_toilet',3.45,-2.95,0,white],
  ['bath_washer',3.82,.6,270,black],['bath_cart',3.85,2.05,270,green],['bath_hamper',3.95,3.20,270,white],
 ])r.items.push({id:assetId,assetId,x,y:.15,z,rotation,color,stored:false});
 for(const [id,parent]of [['bath_folded_towels','bath_washer'],['bath_detergent','bath_washer'],['bath_tray','bath_tub'],['bath_soap','bath_tray']]){const support=r.items.find(i=>i.id===parent),subset={...r,items:[support,...r.items.filter(i=>i.supportId===parent)]};r.items.push(findPlace(catalog.find(a=>a.id===id),subset,catalog,id));}
 const put=(assetId,x,y,z,rotation=0)=>{const a=catalog.find(a=>a.id===assetId);let i={id:assetId,assetId,x,y,z,rotation,color:null,stored:false};if(a.surface==='wall')i=snapToWall(i,a,r,catalog);if(!i)throw Error(assetId+' wall unavailable');r.items.push(i);return i;};
 put('bathroom_ref_shower_plant',-4.7,3.33,2.13);
 put('bathroom_ref_botanical',-4.7,3.62,-1.65).id='bathroom_ref_botanical_left';
 put('bathroom_ref_towel_shelf',-4.7,2.53,-1.65);
 put('bathroom_ref_towel_hooks',-4.7,1.76,-1.8);
 put('bathroom_ref_botanical',3.40,2.74,-4);
 put('bathroom_ref_toilet_shelf',3.42,2.17,-4);
 put('bathroom_ref_window',-.85,3.62,-4);
 put('bathroom_ref_hanging_plant',-3.10,2.55,-4);
 put('bathroom_ref_robe',-4.7,.90,3.12);
 put('bathroom_ref_shower_mat',-2.20,.15,1.8,90);
 put('bathroom_ref_bath_mat',-1.72,.15,-.8,90);
 put('bathroom_ref_flower_mat',3.40,.15,-1.43);
 put('bathroom_ref_slippers',-1.7,.15,1.0);
 put('bathroom_ref_basket',4.20,.15,-2.85);
 put('bathroom_ref_trailing_plant',1.94,1.78,-4);
 const washer=r.items.find(i=>i.id==='bath_washer');
 r.items=r.items.filter(i=>!['bath_folded_towels','bath_detergent'].includes(i.id));
 r.items.push(findPlace(catalog.find(a=>a.id==='bathroom_ref_laundry_top'),{...r,items:[washer]},catalog,'bathroom_ref_laundry_top'));
 return home;
}
