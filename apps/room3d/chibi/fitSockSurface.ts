import * as T from 'three';
import {MeshBVH} from 'three-mesh-bvh';
import type {bindBlankBody} from './blankRig';
import {bodyHeightY} from './bodyHeight';

/** A lengthened fitted sock must follow the leg at its NEW height. Keep the
 * authored rim level and transfer local skin weights so it follows the knee.
 * No topology edits or extra skin hiding at the visible opening. */
export function fitSockSurface(geometry:T.BufferGeometry,rig:ReturnType<typeof bindBlankBody>){
 const body=rig.baseGeometry.clone(),tree=new MeshBVH(body),p=geometry.attributes.position,si=geometry.attributes.skinIndex,sw=geometry.attributes.skinWeight;
 const bp=body.attributes.position,bi=body.attributes.skinIndex,bw=body.attributes.skinWeight;
 const rest=new Map(rig.skeleton.bones.map((b,i)=>[b.name,new T.Vector3().setFromMatrixPosition(rig.skeleton.boneInverses[i].clone().invert())]));
 const ray=new T.Ray(),point=new T.Vector3(),direction=new T.Vector3(),bary=new T.Vector3(),triangle=new T.Triangle();
 const shaft=new Set<number>();
 try{for(let i=0;i<p.count;i++){
  point.fromBufferAttribute(p,i);if(point.y<bodyHeightY(.40,rig.bodyHeight))continue;shaft.add(i);
  const side=point.x>=0?'L':'R',knee=rest.get(`${side}_shin`)!,ankle=rest.get(`${side}_foot`)!;
  const t=T.MathUtils.clamp((point.y-ankle.y)/(knee.y-ankle.y),0,1);
  ray.origin.copy(ankle).lerp(knee,t);ray.origin.y=point.y;
  direction.copy(point).sub(ray.origin);direction.y=0;const radius=direction.length();if(radius<1e-6)continue;
  ray.direction.copy(direction).multiplyScalar(1/radius);
  const hit=tree.raycastFirst(ray,T.DoubleSide,0,.6);if(!hit?.face||Math.sign(hit.point.x)!==Math.sign(point.x))continue;
  // Leave loose parts loose; only resolve actual skin penetration. A small
  // shell allowance also clears the chord between neighboring rim vertices.
  const distance=Math.max(radius,hit.distance+.018);
  point.copy(ray.origin).addScaledVector(ray.direction,distance);p.setXYZ(i,point.x,point.y,point.z);
  const ids=[hit.face.a,hit.face.b,hit.face.c];triangle.setFromAttributeAndIndices(bp,hit.face.a,hit.face.b,hit.face.c);if(!triangle.getBarycoord(hit.point,bary))continue;
  const weights=new Map<number,number>();ids.forEach((id,j)=>{for(let k=0;k<4;k++){const bone=bi.getComponent(id,k),w=bw.getComponent(id,k)*bary.getComponent(j);if(w>0)weights.set(bone,(weights.get(bone)??0)+w);}});
  const sorted=[...weights].sort((a,b)=>b[1]-a[1]).slice(0,4),sum=sorted.reduce((s,[,w])=>s+w,0);
  if(sum<1e-8)continue;
  for(let k=0;k<4;k++){si.setComponent(i,k,sorted[k]?.[0]??0);sw.setComponent(i,k,(sorted[k]?.[1]??0)/sum);}
 }
 // A vertex can clear skin while a coarse edge cuts through the calf. Check
 // the original faces too; move only their existing shaft vertices, in XZ.
 const samples=[[.5,.5,0],[0,.5,.5],[.5,0,.5],[1/3,1/3,1/3]],index=geometry.index!,v=new T.Vector3();
 for(let pass=0;pass<4;pass++){
  const moves=new Map<number,number>();
  for(let f=0;f<index.count;f+=3){const ids=[index.getX(f),index.getX(f+1),index.getX(f+2)];if(!ids.every(id=>shaft.has(id)))continue;
   for(const weights of samples){point.set(0,0,0);ids.forEach((id,j)=>point.addScaledVector(v.fromBufferAttribute(p,id),weights[j]));
    const side=point.x>=0?'L':'R',knee=rest.get(`${side}_shin`)!,ankle=rest.get(`${side}_foot`)!;
    ray.origin.copy(ankle).lerp(knee,T.MathUtils.clamp((point.y-ankle.y)/(knee.y-ankle.y),0,1));ray.origin.y=point.y;
    direction.copy(point).sub(ray.origin);direction.y=0;const radius=direction.length();if(radius<1e-6)continue;ray.direction.copy(direction).multiplyScalar(1/radius);
    const hit=tree.raycastFirst(ray,T.DoubleSide,0,.6);if(!hit||Math.sign(hit.point.x)!==Math.sign(point.x))continue;
    const gap=hit.distance+.012-radius;if(gap<=.0001)continue;
    ids.forEach((id,j)=>{if(weights[j])moves.set(id,Math.max(moves.get(id)??0,gap*1.1));});
   }
  }
  if(!moves.size)break;
  for(const [id,move] of moves){v.fromBufferAttribute(p,id);const knee=rest.get(`${v.x>=0?'L':'R'}_shin`)!;direction.set(v.x-knee.x,0,v.z-knee.z).normalize();v.addScaledVector(direction,move);p.setXYZ(id,v.x,v.y,v.z);}
 }
 }finally{body.dispose();}
 p.needsUpdate=true;si.needsUpdate=true;sw.needsUpdate=true;geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
}
