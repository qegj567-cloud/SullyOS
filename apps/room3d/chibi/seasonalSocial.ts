import * as T from 'three';
import type {ChibiVisitor} from './visitor';
import type {contactSolver} from './socialContact';
import type {ActionExpression} from './actionExpression';
import {alignFaceHeight,closeFaceGap,isFaceSocial} from './faceSocialContact';
import {furniturePalm} from './furnitureMotion';

export const seasonalActions=['halloween-boo','halloween-trick-or-treat','halloween-candy-shower','halloween-ghost-tease','home-forehead-touch','home-kiss'] as const;
export const isSeasonalSocial=(id:string)=>seasonalActions.includes(id as typeof seasonalActions[number]);
const smooth=T.MathUtils.smootherstep;
const windowAt=(t:number,a:number,b:number,c:number,d:number)=>smooth(t,a,b)*(1-smooth(t,c,d));
type Resident={visitor:ChibiVisitor;solver:ReturnType<typeof contactSolver>};
export function seasonalPhase(id:string,t:number){
 return {reach:windowAt(t,.3,1.6,6.1,7.8),offer:windowAt(t,1.7,2.8,4.3,5.6),
  surprise:windowAt(t,1.65,1.88,2.35,3.2),settle:windowAt(t,1.2,2.6,5.5,7.4),
  sway:Math.sin((t-2)*2.4)*windowAt(t,2,2.6,5.4,6.4),
  transfer:smooth(t,3,3.65),ghost:windowAt(t,1.2,2.2,5.4,6.5)};
}
/** Offsets are in scene units, rotated with the resident, scaled for classic. */
export function socialAnchor(v:ChibiVisitor,x:number,y:number,z:number){
 const base=v.rig?v.rig.bones.chest.getWorldPosition(new T.Vector3()):v.classicPoint('L_upperArm').lerp(v.classicPoint('R_upperArm'),.5);
 // Classic's head is much deeper than its tiny torso: keep held props in
 // front of that silhouette instead of scaling all three axes uniformly.
 const offset=v.rig?new T.Vector3(x,y,z):new T.Vector3(x*.73,y*.52,z*1.10);
 return base.add(offset.applyQuaternion(v.root.getWorldQuaternion(new T.Quaternion())));
}
export function seasonalExpression(id:string,t:number,role:number):ActionExpression{
 if(t<.3||t>7.8)return 'neutral';
 if(id==='home-kiss'&&t>2.5&&t<4.3)return 'tender';
 if(role===1&&((id==='halloween-boo'&&t>1.7&&t<3)||(id==='halloween-ghost-tease'&&t>2.2&&t<3)))return 'surprised';
 if(id==='halloween-trick-or-treat'&&role===0&&t<2.7)return 'speaking';
 return 'smiling';
}
/** Generated clips supply full body motion; only contacts are corrected. */
export function poseSeasonalSocial(id:string,both:Resident[],time:number){
 const p=seasonalPhase(id,time),[a,b]=both.map(r=>r.visitor);
 const faceWeight=id==='home-kiss'?windowAt(time,1.3,2.7,4.2,5.8):p.settle;
 const hand=(i:number,side:'L'|'R',target:T.Vector3,w=p.reach,curl=.2)=>{
  const v=both[i].visitor,q=v.root.getWorldQuaternion(new T.Quaternion());
  // Joined hands meet with thumbs up. Forcing palms upward over-rotates the
  // shorter partner's wrist and crosses the forearm twist's ±180° seam.
  const normal=isFaceSocial(id)?new T.Vector3(side==='L'?1:-1,0,0).applyQuaternion(q):new T.Vector3(0,1,0);
  if(both[i].solver)both[i].solver!({side,point:target,direction:new T.Vector3(0,0,1).applyQuaternion(q),normal,curl},w);
  else v.classicContact(side,target,w);
 };
 if(isFaceSocial(id)){alignFaceHeight(a,b,id,faceWeight);closeFaceGap(a,b,id,faceWeight);}

 const palm=(v:ChibiVisitor,side:'L'|'R')=>v.rig?v.rig.bones[side+'_hand'].localToWorld(furniturePalm(side)):v.classicPoint(side+'_hand');
 if(id==='halloween-trick-or-treat'){
  hand(0,'L',socialAnchor(a,.40,-.28,.52),p.reach*.65);
  a.root.updateWorldMatrix(true,true);
  hand(1,'R',palm(a,'L').add(new T.Vector3(0,.09,0)),p.offer,.4);
 }else if(id==='halloween-ghost-tease'&&!a.rig){
  hand(0,'R',socialAnchor(a,-.95,.03,.48),p.reach*.8);
 }else if(isFaceSocial(id)){
  const joined=palm(a,'L').lerp(palm(b,'R'),.5);
  hand(0,'L',joined,p.reach,.35);hand(1,'R',joined,p.reach,.35);
  if(isFaceSocial(id)){
   hand(0,'R',socialAnchor(b,.19,.04,.06),p.settle*.8,.12);
   hand(1,'L',socialAnchor(a,-.19,.02,.06),p.settle*.8,.12);
  }
 }
}
