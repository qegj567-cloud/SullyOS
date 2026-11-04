import {createHalloweenProp} from './halloweenProps';
import * as T from 'three';
import type {ChibiVisitor} from './visitor';
import {furniturePalm} from './furnitureMotion';
import {BLANK_SCALE} from './blankBody';
import {waterGrip} from './waterGrip';
// Reviewed source roles: review-phone holds with L and taps with R; texting
// holds with R while L hangs at the side. Do not choose by handedness alone.
const phoneHands:Record<string,'L'|'R'>={
 'bed-phone':'L',
 'vrma-54a37ca48a1d4ffb':'L',
 'vrma-cae36da2cc8b9845':'R',
};
export interface SocialProp {update(time:number,duration:number,weight:number):void;dispose():void}
/** Transient props belong to an action, never to the furniture save. */
export function createSocialProp(id:string,visitors:ChibiVisitor[],models:Record<string,T.Group>={}):SocialProp|null{
 if(id.startsWith('halloween-'))return createHalloweenProp(id,visitors,models);
 const phoneSide=phoneHands[id],phone=!!phoneSide,drink=id==='cmu-22_13';
 if(!phone&&!drink)return null;
 const root=new T.Group(),materials:T.Material[]=[],geometries:T.BufferGeometry[]=[];
 const mesh=(geometry:T.BufferGeometry,color:string)=>{const material=new T.MeshStandardMaterial({color,roughness:.65});materials.push(material);geometries.push(geometry);const m=new T.Mesh(geometry,material);root.add(m);return m;};
 if(phone){mesh(new T.BoxGeometry(.14,.23,.018),'#222a25');const screen=mesh(new T.PlaneGeometry(.115,.19),'#8cab91');screen.position.z=.010;}
 else{
  root.name='social-water-cup';
  // Closed bottom, rounded lip and an inner wall, rather than a solid top cap.
  const profile=[[0,-.115],[.058,-.115],[.066,-.108],[.073,.105],[.071,.115],[.064,.115],[.062,.103],[.054,-.096],[0,-.096]];
  mesh(new T.LatheGeometry(profile.map(([x,y])=>new T.Vector2(x,y)),24),'#f1f2eb');
  mesh(new T.CylinderGeometry(.0715,.069,.075,24,1,true),'#597b60');
  const water=mesh(new T.CircleGeometry(.061,24),'#a6c6cb');water.rotation.x=-Math.PI/2;water.position.y=.075;
 }
 const parent=visitors[0].root.parent;parent?.add(root);root.scale.setScalar(visitors[0].rig?1:.72);
 if(phone&&visitors[0].rig){
  const side=phoneSide,hand=visitors[0].rig.bones[side+'_hand'];
  root.name='social-phone';
  // The phone belongs to the source's supporting hand. Its top follows the fingers,
  // and its screen faces out from the palm (-Y in the authored hand frame).
  hand.add(root);root.position.copy(furniturePalm(side)).y-=.018;
  const up=new T.Vector3(side==='L'?1:-1,0,0),screen=new T.Vector3(0,-1,0),right=new T.Vector3().crossVectors(up,screen);
  root.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(right,up,screen));
  root.scale.setScalar(BLANK_SCALE/2.8);
 }
 const grip=drink?waterGrip(visitors,root):null;
 return {
  update(time:number,duration:number,weight:number){
   // Reviewed 22_13: A holds in the left hand; B receives with the right.
   // Their source wrists are closest at 2.262 s on the shared capture clock.
   const receiving=drink&&time>2.262,owner=visitors[receiving?1:0],side=phoneSide??(drink&&!receiving?'L':'R');root.visible=weight>.02;
   if(phone&&owner.rig)return; // Bone parenting follows rotation as well as position.
   if(grip?.(time,weight))return;
   const p=owner.rig?owner.rig.bones[side+'_hand'].localToWorld(furniturePalm(side)):owner.classicPoint(side+'_hand');
   root.position.copy(parent?parent.worldToLocal(p):p);root.quaternion.copy(owner.root.getWorldQuaternion(new T.Quaternion()));
   if(parent)root.quaternion.premultiply(parent.getWorldQuaternion(new T.Quaternion()).invert());
   if(phone)root.rotateX(-.55);else if(time>duration*.7)root.rotateZ(-.5);
  },
  dispose(){root.removeFromParent();geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());},
 };
}
