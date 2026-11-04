import * as T from 'three';
import type {bindBlankBody} from './blankRig';
import {createBedLegContact} from './bedLegContact';

// A joint is not the skin surface: the large head/back extend below the hips.
// Measure the posed mesh only when the supported pose changes. The held sleep
// frame reuses its clearance, independently of room position/heading/scale.
export function createBedSurface(rig:ReturnType<typeof bindBlankBody>,body:T.Group){
 const point=new T.Vector3(),toParent=new T.Matrix4(),fromParent=new T.Matrix4(),inverseParent=new T.Matrix4();
 const previous=new Float64Array(rig.skeleton.bones.length*4+10);let ready=false,lift=0,hairChanged=false,profileKey='';
 const legContact=createBedLegContact(rig,body),legBones=['L_thigh','L_shin','L_foot','R_thigh','R_shin','R_foot'].map(name=>rig.bones[name]),supportedLegs=legBones.map(()=>new T.Quaternion());
 const hair:Array<{mesh:T.Mesh;position:T.BufferAttribute;normal?:T.BufferAttribute}>=[];
 rig.bones.head.traverse(o=>{if(o instanceof T.Mesh&&!(o instanceof T.SkinnedMesh))hair.push({mesh:o,position:(o.geometry.attributes.position as T.BufferAttribute).clone(),normal:(o.geometry.attributes.normal as T.BufferAttribute)?.clone()});});
 const support=(height:number,weight=1,legWeight=0,profile?:[number,number][])=>{
  let changed=!ready,index=0;
  const key=JSON.stringify(profile??[]);if(key!==profileKey){changed=true;profileKey=key;}
  const compare=(v:number)=>{if(Math.abs(v-previous[index])>1e-6)changed=true;previous[index++]=v;};
  const compareRotation=(q:T.Quaternion)=>{compare(q.x);compare(q.y);compare(q.z);compare(q.w);};
  compareRotation(body.quaternion);for(const bone of rig.skeleton.bones)compareRotation(bone.quaternion);
  for(const v of [body.position.x,body.position.y,body.position.z,height,weight,legWeight]){if(Math.abs(v-previous[index])>1e-6)changed=true;previous[index++]=v;}
  if(changed){
   // updateMatrixWorld also refreshes SkinnedMesh.bindMatrixInverse; the generic
   // updateWorldMatrix alone leaves skin coordinates stale after parent motion.
   body.updateWorldMatrix(true,true);body.updateMatrixWorld(true);rig.skeleton.update();
   inverseParent.copy(body.parent?.matrixWorld??new T.Matrix4()).invert();
   toParent.multiplyMatrices(inverseParent,rig.mesh.matrixWorld);
   let lowest=Infinity;
   const position=rig.mesh.geometry.attributes.position;
   // Include the head skin as well as the back, palms and feet. Long rear hair
   // rests on the mattress separately; it must not suspend the entire body.
   for(let i=0;i<position.count;i++){rig.mesh.getVertexPosition(i,point).applyMatrix4(toParent);lowest=Math.min(lowest,point.y);}
   lift=Math.max(0,height-lowest);ready=true;
  }
  body.position.y+=lift*weight;body.updateMatrixWorld(true);rig.skeleton.update();
  if(changed){legContact(height,legWeight,profile);legBones.forEach((bone,i)=>supportedLegs[i].copy(bone.quaternion));}
  else{legBones.forEach((bone,i)=>bone.quaternion.copy(supportedLegs[i]));body.updateMatrixWorld(true);rig.skeleton.update();}
  if(changed){
   inverseParent.copy(body.parent?.matrixWorld??new T.Matrix4()).invert();
   for(const {mesh,position} of hair){
    if(!mesh.visible)continue;
    toParent.multiplyMatrices(inverseParent,mesh.matrixWorld);fromParent.copy(toParent).invert();
    const vertices=mesh.geometry.attributes.position as T.BufferAttribute;
    for(let i=0;i<position.count;i++){
     point.fromBufferAttribute(position,i).applyMatrix4(toParent);
     if(point.y<height)point.y=T.MathUtils.lerp(point.y,height,weight);
     point.applyMatrix4(fromParent);vertices.setXYZ(i,point.x,point.y,point.z);
    }
    vertices.needsUpdate=true;mesh.geometry.computeVertexNormals();mesh.geometry.computeBoundingBox();mesh.geometry.computeBoundingSphere();
   }
   hairChanged=true;
  }
 };
 return Object.assign(support,{reset(){
  if(!hairChanged)return;
  for(const {mesh,position,normal} of hair){
   const g=mesh.geometry,vertices=g.attributes.position as T.BufferAttribute;
   vertices.copy(position);vertices.needsUpdate=true;
   if(normal){const normals=g.attributes.normal as T.BufferAttribute;normals.copy(normal);normals.needsUpdate=true;}
   g.computeBoundingBox();g.computeBoundingSphere();
  }
  hairChanged=false;ready=false;
 }});
}
