import * as T from 'three';
import {CCDIKSolver} from 'three/examples/jsm/animation/CCDIKSolver.js';
import type {bindBlankBody} from './blankRig';

export function bedSurfaceHeight(z:number,flat:number,profile?:[number,number][]){
 if(!profile?.length)return flat;
 if(z<=profile[0][0])return profile[0][1];
 for(let i=1;i<profile.length;i++)if(z<=profile[i][0]){
  const [a,b]=[profile[i-1],profile[i]];return T.MathUtils.lerp(a[1],b[1],(z-a[0])/(b[0]-a[0]));
 }
 return profile.at(-1)![1];
}

/** Let the heels settle onto the mattress after head/back support, using the
 * existing leg bones. No bone translation, skin stretching or new animation. */
export function createBedLegContact(rig:ReturnType<typeof bindBlankBody>,body:T.Group){
 const targets=[new T.Bone(),new T.Bone()],bones=[...rig.skeleton.bones,...targets];
 const index=(name:string)=>bones.indexOf(rig.bones[name]);
 const chains=['L','R'].map((side,i)=>({target:rig.skeleton.bones.length+i,effector:index(side+'_foot'),iteration:40,maxAngle:.08,links:[{index:index(side+'_shin')},{index:index(side+'_thigh')}]}));
 const solver=new CCDIKSolver({skeleton:{bones}} as T.SkinnedMesh,chains),point=new T.Vector3(),ankle=new T.Vector3(),q=new T.Quaternion(),parentQ=new T.Quaternion();
 const inverse=new T.Matrix4(),toParent=new T.Matrix4();
 const vertices=[[],[]] as number[][],g=rig.mesh.geometry.attributes;
 for(let i=0;i<g.position.count;i++)for(let side=0;side<2;side++){
  const prefix=side?'R':'L';let weight=0;
  for(let j=0;j<4;j++)if([prefix+'_foot',prefix+'_toe'].includes(bones[g.skinIndex.getComponent(i,j)].name))weight+=g.skinWeight.getComponent(i,j);
  if(weight>.5)vertices[side].push(i);
 }
 return (height:number,weight:number,profile?:[number,number][])=>{
  if(weight<=0)return;
  body.updateWorldMatrix(true,true);body.updateMatrixWorld(true);rig.skeleton.update();
  inverse.copy(body.parent?.matrixWorld??new T.Matrix4()).invert();toParent.multiplyMatrices(inverse,rig.mesh.matrixWorld);
  for(let i=0;i<2;i++){
   const foot=rig.bones[i?'R_foot':'L_foot'];let gap=Infinity;
   for(const v of vertices[i]){rig.mesh.getVertexPosition(v,point).applyMatrix4(toParent);gap=Math.min(gap,point.y-bedSurfaceHeight(point.z,height,profile));}
   if(!Number.isFinite(gap)||Math.abs(gap)<.002)continue;
   foot.getWorldPosition(ankle).applyMatrix4(inverse);ankle.y-=gap*weight;
   if(body.parent)body.parent.localToWorld(ankle);
   foot.getWorldQuaternion(q);targets[i].matrixWorld.makeTranslation(ankle.x,ankle.y,ankle.z);solver.updateOne(chains[i]);
   foot.parent!.getWorldQuaternion(parentQ);foot.quaternion.copy(parentQ.invert().multiply(q));foot.updateWorldMatrix(false,true);rig.skeleton.update();
  }
 };
}
