import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import type {ChibiVisitor} from './visitor';
import {furniturePalm} from './furnitureMotion';
import {seasonalPhase} from './seasonalSocial';
import type {SocialProp} from './socialProps';
const needed:Record<string,string[]>={
 'halloween-trick-or-treat':['pumpkin-pail','wrapped-candy'],
 'halloween-candy-shower':['wrapped-candy'],
 'halloween-ghost-tease':['little-ghost'],
};
const templates=new Map<string,Promise<T.Group>>();
export async function loadHalloweenProps(action:string){
 return Object.fromEntries(await Promise.all((needed[action]??[]).map(async id=>{
  if(!templates.has(id))templates.set(id,new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}room3d/props/halloween/${id}.glb`).then(g=>g.scene).catch(e=>{templates.delete(id);throw e;}));
  return [id,await templates.get(id)!] as const;
 })));
}
export function createHalloweenProp(action:string,visitors:ChibiVisitor[],models:Record<string,T.Group>):SocialProp|null{
 if(!needed[action])return null;
 const parent=visitors[0].root.parent,root=new T.Group();root.name='halloween-social-props';root.visible=false;
 parent?.add(root);
 const factor=visitors[0].rig?1:.52;
 const add=(id:string)=>{if(!models[id])throw Error('互动道具未准备好');const m=models[id].clone(true);m.name=id;m.scale.setScalar(factor);root.add(m);return m;};
 const bucket=action==='halloween-trick-or-treat'?add('pumpkin-pail'):null;
 const ghost=action==='halloween-ghost-tease'?add('little-ghost'):null;
 const candies=action==='halloween-candy-shower'?Array.from({length:7},()=>add('wrapped-candy')):action==='halloween-trick-or-treat'?[add('wrapped-candy')]:[];
 const palm=(v:ChibiVisitor,side:'L'|'R')=>v.rig?v.rig.bones[side+'_hand'].localToWorld(furniturePalm(side)):v.classicPoint(side+'_hand');
 const place=(m:T.Object3D,p:T.Vector3,q?:T.Quaternion)=>{m.position.copy(root.worldToLocal(p));m.quaternion.copy(q??new T.Quaternion()).premultiply(root.getWorldQuaternion(new T.Quaternion()).invert());};
 return {
  update(time:number,_duration:number,weight:number){
   root.visible=weight>.02&&time>.35&&time<7.55;root.updateWorldMatrix(true,false);
   const [a,b]=visitors,p=seasonalPhase(action,time);
   if(bucket){
    const handle=palm(a,'L');place(bucket,handle,a.root.getWorldQuaternion(new T.Quaternion()));
    const candy=candies[0],drop=T.MathUtils.smootherstep(time,3,3.65);
    const target=handle.clone().add(new T.Vector3(0,-.17*factor,0));
    const position=palm(b,'R').lerp(target,drop);position.y+=Math.sin(drop*Math.PI)*.08*factor;
    place(candy,position);candy.visible=time<3.72;
   }
   if(ghost){place(ghost,palm(a,'R'),a.root.getWorldQuaternion(new T.Quaternion()));ghost.rotateZ(Math.sin(time*4)*.16*p.ghost);}
   if(action==='halloween-candy-shower')for(let i=0;i<candies.length;i++){
    const candy=candies[i],launch=2.65+i*.15,u=T.MathUtils.clamp((time-launch)/1.15,0,1);
    const start=palm(a,'R'),end=palm(b,i%2?'L':'R');
    const position=start.lerp(end,u);position.y+=Math.sin(Math.PI*u)*(.4+(i%3)*.08)*factor;
    position.x+=Math.sin(Math.PI*u)*(i-3)*.035*factor;
    place(candy,position);candy.rotateY(i+u*4);candy.rotateZ(i*.8+u*3);candy.visible=time>=launch&&time<launch+1.15;
   }
  },
  // Geometry/materials belong to the three bounded shared templates, never a session.
  dispose(){root.removeFromParent();root.clear();},
 };
}
