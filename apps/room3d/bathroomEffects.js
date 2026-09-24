import * as T from 'three';
import {isBathAction} from './bathroom.js';
export function createBathroomEffects(){
 const root=new T.Group(),bubbleGeo=new T.SphereGeometry(1,8,6),dropGeo=new T.SphereGeometry(1,6,4);
 const foam=new T.MeshStandardMaterial({color:'#fffdf2',roughness:.45}),water=new T.MeshStandardMaterial({color:'#bad7ce',transparent:true,opacity:.7});
 const bubbles=Array.from({length:30},()=>{const m=new T.Mesh(bubbleGeo,foam);root.add(m);return m;});
 const drops=Array.from({length:24},()=>{const m=new T.Mesh(dropGeo,water);root.add(m);return m;});
 let washer=null,original=null;
 function clear(){if(washer&&original)washer.position.copy(original);washer=null;original=null;root.removeFromParent();root.visible=false;}
 function update(objects,activity,time,reduced=false){
  const obj=isBathAction(activity?.kind)&&objects.find(o=>o.userData.itemId===activity.itemId);
  if(!obj){clear();return;}
  if(washer&&washer!==obj){washer.position.copy(original);washer=null;original=null;}
  if(root.parent!==obj){root.removeFromParent();obj.add(root);}root.visible=true;
  const soak=activity.kind==='bath-soak',shower=activity.kind==='bath-shower';
  bubbles.forEach((m,i)=>{m.visible=soak||shower;if(!m.visible)return;const a=i*2.399,s=.10+(i%4)*.018;m.scale.setScalar(s);m.position.set(Math.cos(a)*(soak?.96:.36),soak?.97:1.30+Math.sin(a)*.20,Math.sin(a)*(soak?.40:.31));if(!reduced)m.position.y+=Math.sin(time*1.8+i)*.025;});
  drops.forEach((m,i)=>{m.visible=shower;m.scale.set(.018,.09,.018);m.position.set(Math.sin(i*2.4)*.35,2.65-(reduced?.4:(time*1.5+i/24)%1)*2.3,Math.cos(i*2.4)*.30);});
  if(activity.kind==='bath-laundry'){
   if(!washer){washer=obj;original=obj.position.clone();}
   obj.position.copy(original);if(!reduced){obj.position.x+=Math.sin(time*37)*.022;obj.position.z+=Math.cos(time*31)*.012;}
  }else if(washer){washer.position.copy(original);washer=null;original=null;}
 }
 return {update,clear,dispose(){clear();bubbleGeo.dispose();dropGeo.dispose();foam.dispose();water.dispose();}};
}
