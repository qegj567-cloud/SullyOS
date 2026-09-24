import {describe,it,expect} from 'vitest';
import * as T from 'three';
import {createBlankBody} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {createBlankMotion} from '../apps/room3d/chibi/blankMotion';
import {dressHoodie} from '../apps/room3d/chibi/hoodieClothes';

function setup(){
 const body=new T.Group(),material=new T.MeshBasicMaterial(),mesh=new T.Mesh(createBlankBody('skin'),material),hair=new T.Group();
 body.add(mesh,hair);const rig=bindBlankBody(mesh,hair),animate=createBlankMotion(rig,body);
 return {body,rig,animate,dispose(){mesh.geometry.dispose();material.dispose();rig.skeleton.dispose()}};
}
describe('new body home motion',()=>{
 it('opens the waving hand, curls angry hands, and relaxes them again',()=>{
  const {rig,animate,dispose}=setup();try{
   animate(0,'angry','standing');expect(rig.bones.L_index.quaternion.angleTo(new T.Quaternion())).toBeGreaterThan(.5);
   animate(1,'wave-calm','seated');expect(rig.bones.L_index.quaternion.angleTo(new T.Quaternion())).toBeLessThan(.00001);
   expect(rig.bones.R_index.quaternion.angleTo(new T.Quaternion())).toBeGreaterThan(.05);
   animate(2,'idle','seated');expect(rig.bones.L_index.quaternion.angleTo(rig.bones.R_index.quaternion.clone().invert())).toBeLessThan(.1);
  }finally{dispose();}
 });
 it('keeps the raised arm nearly straight and the wrist outside the bare head',()=>{
  const {rig,animate,dispose}=setup();try{
   const shoulder=new T.Vector3(),elbow=new T.Vector3(),wrist=new T.Vector3(),v=new T.Vector3();
   for(let i=0;i<40;i++){
    animate(i/20,'wave-calm','standing');
    rig.bones.L_upperArm.getWorldPosition(shoulder);rig.bones.L_forearm.getWorldPosition(elbow);rig.bones.L_hand.getWorldPosition(wrist);
    expect(elbow.clone().sub(shoulder).angleTo(wrist.clone().sub(elbow))).toBeLessThan(.2);
    let headRight=-Infinity;const p=rig.mesh.geometry.attributes.position;
    for(let k=0;k<p.count;k++)if(p.getY(k)>3.6){rig.mesh.getVertexPosition(k,v);rig.mesh.localToWorld(v);headRight=Math.max(headRight,v.x)}
    expect(wrist.x-headRight).toBeGreaterThan(.15);
   }
  }finally{dispose()}
 });
 it('waves with real joints while keeping standing feet and every bone length unchanged',()=>{
  const {rig,animate,dispose}=setup();try{
   const rest=Object.values(rig.bones).map(b=>b.position.clone()),p=rig.mesh.geometry.attributes.position,v=new T.Vector3();
   animate(0,'idle','standing');animate(1,'wave-calm','standing');const hand=rig.bones.L_hand.getWorldPosition(new T.Vector3());
   animate(1.3,'wave-calm','standing');expect(rig.bones.L_hand.getWorldPosition(new T.Vector3()).distanceTo(hand)).toBeGreaterThan(.02);
   Object.values(rig.bones).forEach((b,i)=>{expect(b.position.distanceTo(rest[i])).toBe(0);expect(b.scale.toArray()).toEqual([1,1,1])});
   for(let i=0;i<p.count;i++)if(p.getY(i)<.25){rig.mesh.getVertexPosition(i,v);expect(v.distanceTo(new T.Vector3().fromBufferAttribute(p,i))).toBeLessThan(.00001)}
  }finally{dispose()}
 });
 it('keeps the seated pelvis on its contact plane when waving and restores standing without drift',()=>{
  const {rig,body,animate,dispose}=setup();try{
   animate(0,'idle','standing');const initial=body.position.clone();
   animate(0,'idle','seated');const contact=rig.bones.hips.getWorldPosition(new T.Vector3()),legs=rig.bones.L_thigh.quaternion.clone();
   for(let i=0;i<60;i++)animate(i/30,'wave-cute','seated');
   expect(rig.bones.hips.getWorldPosition(new T.Vector3()).distanceTo(contact)).toBeLessThan(.00001);
   expect(rig.bones.L_thigh.quaternion.angleTo(legs)).toBeLessThan(.00001);
   animate(0,'idle','standing');expect(body.position.distanceTo(initial)).toBeLessThan(.00001);
   expect(rig.bones.L_thigh.rotation.x).toBeCloseTo(0);
   animate(0,'idle','seated');expect(rig.bones.hips.getWorldPosition(new T.Vector3()).distanceTo(contact)).toBeLessThan(.00001);
  }finally{dispose()}
 });
 it('keeps skinned body and clothing finite through seated, walking and resting poses without rebuilding geometry',()=>{
  const {rig,animate,dispose}=setup(),outfit=dressHoodie(rig);
  try{
   const meshes=[rig.mesh,...outfit.meshes],original=meshes.map(m=>Array.from(m.geometry.attributes.position.array)),v=new T.Vector3();
   for(const [motion,posture] of [['idle','seated'],['wave-calm','seated'],['walk','standing'],['mirror-admire','standing'],['mirror-outfit','standing'],['bath-shower','standing'],['bath-soak','seated'],['bath-laundry','standing'],['bath-toilet','seated'],['sleep','lying'],['idle','standing']] as const){
    for(let i=0;i<20;i++)animate(i/30,motion,posture);
    for(const mesh of meshes){mesh.updateWorldMatrix(true,false);for(let i=0;i<mesh.geometry.attributes.position.count;i++){mesh.getVertexPosition(i,v);expect(Number.isFinite(v.lengthSq())).toBe(true)}}
   }
   meshes.forEach((m,i)=>expect(Array.from(m.geometry.attributes.position.array)).toEqual(original[i]));
  }finally{outfit.resources.forEach(r=>r.dispose());dispose()}
 });
});
