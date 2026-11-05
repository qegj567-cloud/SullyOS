import * as T from 'three';
import {sampleSelected,type SelectedClip} from './selectedMotions';
import type {ChibiVisitor} from './visitor';
import {contactSolver} from './socialContact';
import {furniturePalm} from './furnitureMotion';
import catalog from './photoPairCatalog.json';

export const photoPairs=catalog;
export function createPhotoPairPose(id:string,people:ChibiVisitor[],clip:SelectedClip){
 const entry=catalog.find(e=>e.id===id);if(!entry||people.length!==2)throw Error('合照需要两位居民');
 const style=entry.style;
 const origin=people[0].root.position.clone().lerp(people[1].root.position,.5);
 const solvers=people.map(contactSolver),yAxis=new T.Vector3(0,1,0);
 // Use the posed head skin and attached hair, not a fixed human shoulder gap.
 const radii=people.map(p=>{
  const before=p.root.quaternion.clone();p.root.quaternion.identity();p.animate(0,'idle');p.finishPose();p.root.updateWorldMatrix(true,true);
  if(!p.rig){p.root.quaternion.copy(before);return .72*p.seatScale/.7;}
  const {mesh,bones,skeleton}=p.rig,index=skeleton.bones.indexOf(bones.head),g=mesh.geometry,skin=g.attributes.skinIndex,weights=g.attributes.skinWeight;skeleton.update();
  const box=new T.Box3(),v=new T.Vector3();
  // Rest-space width is independent of the previous render's bindMatrixInverse.
  // A newly staged root has not yet gone through SkinnedMesh.updateMatrixWorld.
  for(let i=0;i<g.attributes.position.count;i++)if([0,1,2,3].some(k=>skin.getComponent(i,k)===index&&weights.getComponent(i,k)>.5))box.expandByPoint(v.fromBufferAttribute(g.attributes.position,i));
  const skinRadius=box.getSize(v).x/2*mesh.getWorldScale(new T.Vector3()).x;
  const hairBox=new T.Box3().setFromObject(bones.head,true),hairRadius=hairBox.isEmpty()?0:hairBox.getSize(v).x/2;
  p.root.quaternion.copy(before);return Math.max(.34,Math.min(1.5,Math.max(skinRadius,hairRadius)));
 });
 const gap=radii[0]+radii[1]+.08;
 const point=(p:ChibiVisitor,name:string)=>p.rig?p.rig.bones[name].getWorldPosition(new T.Vector3()):p.classicPoint(name);
 const hand=(p:ChibiVisitor,side:'L'|'R')=>p.rig?p.rig.bones[side+'_hand'].localToWorld(furniturePalm(side)):p.classicPoint(side+'_hand');
 function pose(time:number,yaw:number){
  const q=new T.Quaternion().setFromAxisAngle(yAxis,yaw),right=new T.Vector3(1,0,0).applyQuaternion(q),front=new T.Vector3(0,0,1).applyQuaternion(q);
  const at=(x:number,y:number,z:number)=>new T.Vector3(x,y,z).applyQuaternion(q).add(origin);
  people.forEach((p,i)=>{
   p.root.position.copy(at((i-.5)*gap,0,style==='peek'?(i===1?-.36:.20):0));p.root.quaternion.copy(q);
   const frame=sampleSelected(clip.actors[i],time);
   // Keep the generated limb acting and breathing; compress human torso lean
   // so the oversized faces remain separated and front-facing.
   for(const n of ['hips','spine','chest','neck','head']){
    const e=new T.Euler().setFromQuaternion(frame.rotations[n],'YXZ');
    e.x=.07*Math.tanh(e.x/.3);e.y=0;e.z=.08*Math.tanh(e.z/.3);frame.rotations[n].setFromEuler(e);
   }
   if(['heart','shoulder','peek'].includes(style)&&p.rig&&people[1-i].rig){
    // The taller partner lowers themself for contact, as in an actual photo.
    // Change knee angles only; the approved skeleton/limb lengths stay intact.
    const difference=p.rig.bodyHeight-people[1-i].rig!.bodyHeight,bend=T.MathUtils.clamp((difference-.10)*2,0,.6);
    if(bend){for(const side of ['L','R'])for(const [joint,angle] of [['thigh',-bend],['shin',bend*2],['foot',-bend]] as const)frame.rotations[`${side}_${joint}`].multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),angle));frame.position.y-=frame.hipHeight*(1-Math.cos(bend));}
   }
   p.applySelectedFrame(frame);p.root.updateWorldMatrix(true,true);
   if(p.rig){
    const head=p.rig.bones.head,roll=(i===0?-.08:.08)*(style==='peace'?.4:1);
    const desired=q.clone().multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),roll));
    head.quaternion.copy(head.parent!.getWorldQuaternion(new T.Quaternion()).invert().multiply(desired));
    p.root.updateWorldMatrix(true,true);
   }
  });
  const contact=(i:number,side:'L'|'R',target:T.Vector3,direction:T.Vector3,normal=front,curl=.08)=>{
   if(solvers[i])solvers[i]!({side,point:target,direction,normal,curl},1);
   else people[i].classicContact(side,target,1);
  };
  const shapeV=(p:ChibiVisitor,side:'L'|'R')=>{
   if(!p.rig)return;p.rig.setHandCurl(side,.95);
   for(const finger of ['index','middle'])for(const suffix of ['', '_tip'])p.rig.bones[`${side}_${finger}${suffix}`]?.quaternion.identity();
   p.rig.bones[side+'_index']?.rotateY(side==='L'?-.16:.16);p.rig.bones[side+'_middle']?.rotateY(side==='L'?.12:-.12);
  };
  const shoulders=people.map((p,i)=>point(p,i===0?'L_upperArm':'R_upperArm'));
  if(style==='heart'){
   // Human overhead hearts disappear behind chibi heads. Bring the paired
   // finger heart into the gap below the chins without lengthening any bones.
   const target=shoulders[0].clone().lerp(shoulders[1],.5).addScaledVector(front,.22);target.y-=.06;
   people.forEach((p,i)=>{
    const side=i===0?'L':'R',sign=i===0?1:-1;
    contact(i,side,target.clone().addScaledVector(right,-sign*.065),right.clone().multiplyScalar(sign*.65).add(new T.Vector3(0,.75,0)).normalize(),front,.55);
    if(p.rig){for(const suffix of ['','_tip'])p.rig.bones[`${side}_thumb${suffix}`]?.quaternion.identity();}
   });
  }else if(style==='linked'){
   const target=shoulders[0].clone().lerp(shoulders[1],.5).addScaledVector(front,.12);target.y-=.28;
   contact(0,'L',target.clone().addScaledVector(front,.04),right,front,.45);
   contact(1,'R',target.clone().addScaledVector(front,-.04),right.clone().negate(),front,.45);
   people.forEach((p,i)=>{const side=i===0?'R':'L',target=point(p,side+'_thigh').addScaledVector(front,.15).addScaledVector(right,i===0?-.18:.18);target.y+=.16;contact(i,side,target,new T.Vector3(0,-1,0),front,.25);});
  }else if(style==='shoulder'){
   const target=point(people[1],'R_upperArm').addScaledVector(front,-.10);target.y+=.04;
   contact(0,'L',target,right,front,.15);
  }else if(style==='peek'){
   for(const side of ['L','R'] as const){const target=point(people[0],side+'_upperArm');target.y-=.32;target.addScaledVector(front,.07);contact(1,side,target,right.clone().multiplyScalar(side==='L'?1:-1),front,.35);}
  }
  // Camera-facing gestures live outside the measured head silhouette. Preserve
  // the source's changing hand height, then limit it to the short arm's reach.
  if(['peace','bunny','shoulder'].includes(style))people.forEach((p,i)=>{
   if(style==='shoulder'&&i===0)return;
   const sides:('L'|'R')[]=style==='bunny'?['L','R']:[i===0?'R':'L'];
   for(const side of sides){
    const sign=side==='L'?1:-1,target=hand(p,side),center=p.getHeadWorldPosition();
    const x=target.clone().sub(center).dot(right);
    target.addScaledVector(right,sign*Math.max(radii[i]+.06,Math.abs(x))-x);
    target.y=Math.min(target.y,point(p,side+'_upperArm').y+.45);
    contact(i,side,target,new T.Vector3(0,1,0),front,0);shapeV(p,side);
   }
  });
  for(const p of people)p.finishPose();
 }
 return {pose};
}
