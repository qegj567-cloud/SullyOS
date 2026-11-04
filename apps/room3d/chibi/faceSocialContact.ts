import * as T from 'three';
import type {ChibiVisitor} from './visitor';
const indices=new WeakMap<T.BufferGeometry,Record<string,number>>();
export const isFaceSocial=(id:string)=>id==='home-kiss'||id==='home-forehead-touch';
/** Find the front skin surface at the default mouth/forehead artwork height.
 * Uses the fitted mesh so body height/head size are retained, never bone stretching. */
export function faceSocialPoint(v:ChibiVisitor,kind:string){
 if(!v.rig){
  const head=v.getHeadWorldPosition();
  return head.add(new T.Vector3(0,kind==='home-kiss'?-.12:.20,.47).applyQuaternion(v.root.getWorldQuaternion(new T.Quaternion())));
 }
 const mesh=v.rig.mesh,g=mesh.geometry,p=g.attributes.position,uv=g.attributes.uv;
 let cached=indices.get(g);if(!cached){cached={};indices.set(g,cached);}
 if(cached[kind]===undefined){
  const targetU=237/472,targetV=1-(kind==='home-kiss'?326:238)/472;let best=Infinity,index=0;
  for(let i=0;i<p.count;i++){
   if(p.getZ(i)<=0)continue;
   const error=(uv.getX(i)-targetU)**2*4+(uv.getY(i)-targetV)**2;
   if(error<best){best=error;index=i;}
  }
  cached[kind]=index;
 }
 v.root.updateWorldMatrix(true,true);v.rig.skeleton.update();
 const index=cached[kind],point=new T.Vector3().fromBufferAttribute(p,index).applyMatrix4(mesh.bindMatrix),world=new T.Vector3();
 // Use bone world matrices directly. SkinnedMesh.bindMatrixInverse is refreshed
 // by the renderer, so applyBoneTransform can otherwise read the previous frame.
 const joints=g.attributes.skinIndex,weights=g.attributes.skinWeight;
 for(let i=0;i<4;i++){
  const joint=joints.getComponent(index,i),weight=weights.getComponent(index,i);
  if(weight)world.add(point.clone().applyMatrix4(v.rig.skeleton.boneInverses[joint]).applyMatrix4(v.rig.skeleton.bones[joint].matrixWorld).multiplyScalar(weight));
 }
 return world;
}
/** Lower the taller partner with bent knees, keeping both soles grounded. */
export function alignFaceHeight(a:ChibiVisitor,b:ChibiVisitor,kind:string,weight:number){
 if(!a.rig||!b.rig||weight<=0)return;
 const pa=faceSocialPoint(a,kind),pb=faceSocialPoint(b,kind),v=pa.y>pb.y?a:b,drop=Math.abs(pa.y-pb.y)*weight;
 if(drop<.002)return;
 const bones=v.rig!.bones,sole=()=>Math.min(...['L_foot','R_foot','L_toe','R_toe'].map(n=>bones[n].getWorldPosition(new T.Vector3()).y));
 const floor=sole(),initial=faceSocialPoint(v,kind).y;
 const base=Object.fromEntries(['L','R'].flatMap(side=>['thigh','shin','foot'].map(n=>[side+'_'+n,bones[side+'_'+n].quaternion.clone()])));
 const pose=(angle:number)=>{
  for(const side of ['L','R'])for(const [n,x] of [['thigh',-angle],['shin',2*angle],['foot',-angle]] as const)bones[side+'_'+n].quaternion.copy(base[side+'_'+n]).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),x));
  v.root.updateWorldMatrix(true,true);
  v.translatePose(new T.Vector3(0,floor-sole(),0));
  return initial-faceSocialPoint(v,kind).y;
 };
 let low=0,high=1.30;
 for(let i=0;i<12;i++){const mid=(low+high)/2;if(pose(mid)<drop)low=mid;else high=mid;}
 pose((low+high)/2);
}
export function closeFaceGap(a:ChibiVisitor,b:ChibiVisitor,kind:string,weight:number){
 const pa=faceSocialPoint(a,kind),pb=faceSocialPoint(b,kind),delta=pb.sub(pa);delta.y=0;
 // Keep a small air gap at the skin; opposing head tilts keep noses apart.
 const gap=delta.length();if(gap<.012)return;
 delta.multiplyScalar(Math.min(.24,(gap-.012)/2)/gap*weight);
 a.translatePose(delta);b.translatePose(delta.clone().negate());
}
