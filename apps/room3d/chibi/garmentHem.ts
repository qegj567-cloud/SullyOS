import * as T from 'three';
import {bodyHeightY} from './bodyHeight';
import {MeshBVH} from 'three-mesh-bvh';

/** Pull the lower portion of an upper garment over the fitted waistband.
 * Move only the original corners supporting a penetrating sample. Do not
 * propagate a waistband correction to an already roomy hem below it.
 * This is bounded waist clearance, not whole-skirt wrapping or cloth physics.
 */
export function fitGarmentHem(upper:T.SkinnedMesh[],under:T.SkinnedMesh[],waist:T.Box3,height=1,center=new T.Vector2()){
 const bounds=new T.Box3();for(const m of upper){m.geometry.computeBoundingBox();bounds.union(m.geometry.boundingBox!);}
 const start=Math.min(bodyHeightY(2.85,height),bounds.min.y+.65*height),span=Math.max(.05*height,start-bounds.min.y);
 if(bounds.isEmpty()||waist.isEmpty()||bounds.min.y>waist.max.y+.025*height||start<waist.max.y-.65*height)return 0;
 const blend=(y:number)=>T.MathUtils.smoothstep((start-y)/(span*.7),0,1)*(1-T.MathUtils.smoothstep(y,waist.max.y,waist.max.y+.14*height));
 const queries:Array<{geometry:T.BufferGeometry;tree:MeshBVH}>=[];
 const surfaces:Array<{mesh:T.SkinnedMesh;geometry:T.BufferGeometry;tree:MeshBVH}>=[];
 const ray=new T.Ray(),direction=new T.Vector3(),point=new T.Vector3();
 type Node={point:T.Vector3;direction:T.Vector3;mobility:number;amount:number};
 const nodes:Node[]=[],byPosition=new Map<string,number>(),meshNodes=new Map<T.SkinnedMesh,number[]>();
 const key=(p:T.Vector3)=>[p.x,p.y,p.z].map(v=>Math.round(v*1e6)).join(',');
 // Weld coincident UV/material seam vertices for displacement only. Indices,
 // vertex count and skin weights remain exactly as authored.
 for(const mesh of upper){const ids:number[]=[],p=mesh.geometry.attributes.position;for(let i=0;i<p.count;i++){
  point.fromBufferAttribute(p,i);const k=key(point);let id=byPosition.get(k);
  if(id===undefined){id=nodes.length;byPosition.set(k,id);nodes.push({point:point.clone(),direction:new T.Vector3(point.x-center.x,0,point.z-center.y).normalize(),mobility:blend(point.y),amount:0});}ids.push(id);
 }meshNodes.set(mesh,ids);}
 const constraints:Array<{terms:Array<{id:number;coefficient:number}>;required:number}>=[];
 try{
  let reach=1;
  for(const m of under){const source=m.geometry;if(!source.index?.count)continue;
   const geometry=new T.BufferGeometry();geometry.setAttribute('position',source.attributes.position);geometry.setIndex(source.index.clone());geometry.computeBoundingBox();
   const b=geometry.boundingBox!;reach=Math.max(reach,Math.hypot(Math.max(Math.abs(b.min.x-center.x),Math.abs(b.max.x-center.x)),Math.max(Math.abs(b.min.z-center.y),Math.abs(b.max.z-center.y)))+.1);
   queries.push({geometry,tree:new MeshBVH(geometry,{indirect:true})});
  }
  if(!queries.length)return 0;
  for(const mesh of upper){const g=mesh.geometry;if(!g.index?.count)continue;
   const geometry=new T.BufferGeometry();geometry.setAttribute('position',g.attributes.position);geometry.setIndex(g.index.clone());surfaces.push({mesh,geometry,tree:new MeshBVH(geometry,{indirect:true})});
  }
  const consider=(point:T.Vector3,supports:Array<{point:T.Vector3;weight:number}>)=>{
    if(blend(point.y)<.06||point.y<waist.max.y-.65*height)return;
    direction.set(point.x-center.x,0,point.z-center.y);const radius=direction.length();if(radius<.025)return;direction.multiplyScalar(1/radius);
    // Query at the sample's actual height. Projecting points above the waist
    // down to it falsely treats the shirt's inner hem/cap as penetrating pants.
    ray.origin.set(center.x,point.y,center.y).addScaledVector(direction,reach);ray.direction.copy(direction).negate();
    let penetration=0;
    for(const q of queries){const hit=q.tree.raycastFirst(ray,T.DoubleSide,0,reach);if(hit)penetration=Math.max(penetration,reach-hit.distance-radius);}
    // Existing positive space is sufficient: clearance is added only after a
    // real overlap, never used as a reason to flare an already separated hem.
    if(penetration<=.0001)return;
    // An inward fold/lining can be inside the lower garment while the visible
    // outer cloth already clears it. Correct only the outermost upper surface;
    // otherwise hidden lining contacts unnecessarily inflate roomy coat panels.
    if(surfaces.some(q=>{
     const hit=q.tree.raycastFirst(ray,T.DoubleSide,0,reach);if(hit&&hit.distance<reach-radius-.002)return true;
     // Radial rays through coincident seam edges can miss both triangles due
     // to floating point rounding. Check infinitesimally beside that edge.
     return [-1,1].some(sign=>{const nearby=ray.clone();nearby.origin.x-=direction.z*sign*.00001;nearby.origin.z+=direction.x*sign*.00001;const h=q.tree.raycastFirst(nearby,T.DoubleSide,0,reach);return h&&h.distance<reach-radius-.002;});
    }))return;
    const required=penetration+.015;
    // A pocket/button can lie beneath a face while missing all its corners.
    // Convert clearance at the sample into the radial movement of its actual
    // corner vertices; no new vertex/weight interpolation is introduced.
    const terms=new Map<number,number>();
    for(const s of supports){const id=byPosition.get(key(s.point));if(id===undefined||s.weight<=0)continue;const n=nodes[id],c=s.weight*Math.max(0,n.direction.dot(direction));if(n.mobility>0&&c>0)terms.set(id,(terms.get(id)??0)+c);}
    const effective=Array.from(terms).reduce((sum,[id,c])=>sum+c*nodes[id].mobility,0);
    if(effective<.06)return;
    constraints.push({terms:Array.from(terms,([id,coefficient])=>({id,coefficient})),required});
  };
  for(const mesh of upper){const g=mesh.geometry;
   for(const i of new Set(Array.from(g.index?.array??[]))){point.fromBufferAttribute(g.attributes.position,i);consider(point,[{point,weight:1}]);}
   for(let t=0;t<(g.index?.count??0);t+=3){const corners=[0,1,2].map(j=>new T.Vector3().fromBufferAttribute(g.attributes.position,g.index!.getX(t+j)));
    for(const weights of [[1/3,1/3,1/3],[.5,.5,0],[0,.5,.5],[.5,0,.5]]){point.set(0,0,0);weights.forEach((w,j)=>point.addScaledVector(corners[j],w));consider(point,corners.map((p,j)=>({point:p,weight:weights[j]})));}
   }
  }
  // Small waist details may fall between the shirt's sparse sample points.
  // Sample their real heights/directions and project back onto an existing
  // upper face; unlike projecting shirt points down, this cannot invent a
  // collision above the lower garment. Keep the original face's skin weights.
  for(const {mesh,tree} of surfaces){const g=mesh.geometry;
    const triangle=new T.Triangle(),bary=new T.Vector3();
    const probe=(p:T.Vector3)=>{
     if(p.y<waist.max.y-.65*height||p.y>waist.max.y||blend(p.y)<.06)return;
     direction.set(p.x-center.x,0,p.z-center.y);if(direction.lengthSq()<.000625)return;direction.normalize();
     ray.origin.set(center.x,p.y,center.y).addScaledVector(direction,reach);ray.direction.copy(direction).negate();
     const hit=tree.raycastFirst(ray,T.DoubleSide,0,reach);if(!hit||hit.faceIndex===undefined)return;
     const corners=[0,1,2].map(j=>new T.Vector3().fromBufferAttribute(g.attributes.position,g.index!.getX(hit.faceIndex!*3+j)));
     triangle.set(corners[0],corners[1],corners[2]);if(!triangle.getBarycoord(hit.point,bary))return;
     consider(hit.point,corners.map((point,j)=>({point,weight:Math.max(0,bary.getComponent(j))})));
    };
    for(const q of queries){const p=q.geometry.attributes.position,index=q.geometry.index!;
     for(const i of new Set(Array.from(index.array)))probe(point.fromBufferAttribute(p,i));
     for(let t=0;t<index.count;t+=3){point.set(0,0,0);for(let j=0;j<3;j++){const i=index.getX(t+j);point.x+=p.getX(i)/3;point.y+=p.getY(i)/3;point.z+=p.getZ(i)/3;}probe(point);}
    }
  }
  if(!constraints.length)return 0;
  // Project each contact constraint onto its actual triangle corners. The
  // least-squares step favours nearby/high-weight corners, not every vertex
  // sharing their angle. Adjacent faces follow through shared original nodes.
  for(let iteration=0;iteration<8;iteration++){
   let changed=false;
   for(const {terms,required} of constraints){
    const remaining=required-terms.reduce((sum,t)=>sum+t.coefficient*nodes[t.id].amount,0);if(remaining<=.00001)continue;
    const movable=terms.filter(t=>nodes[t.id].amount<.30),denominator=movable.reduce((sum,t)=>sum+t.coefficient*t.coefficient*nodes[t.id].mobility,0);if(denominator<1e-8)continue;
    for(const t of movable){const n=nodes[t.id],next=Math.min(.30,n.amount+remaining*t.coefficient*n.mobility/denominator);if(next>n.amount+.000001)changed=true;n.amount=next;}
   }
   if(!changed)break;
  }
  let changed=0;
  for(const mesh of upper){const g=mesh.geometry,p=g.attributes.position,ids=meshNodes.get(mesh)!,moved=new Set<number>();
   for(let i=0;i<p.count;i++){const n=nodes[ids[i]];if(n.amount<=.000001)continue;point.copy(n.point).addScaledVector(n.direction,n.amount);p.setXYZ(i,point.x,point.y,point.z);moved.add(i);}
   if(!moved.size)continue;changed+=moved.size;p.needsUpdate=true;
   // Recompute normals only on faces incident to changed vertices, retaining
   // authored normals everywhere else (including the sleeves and chest).
   const oldNormal=g.attributes.normal?.clone(),affected=new Set<number>();
   for(let t=0;t<(g.index?.count??0);t+=3){const face=[0,1,2].map(j=>g.index!.getX(t+j));if(face.some(i=>moved.has(i)))face.forEach(i=>affected.add(i));}
   g.computeVertexNormals();if(oldNormal){const n=g.attributes.normal;for(let i=0;i<n.count;i++)if(!affected.has(i))n.setXYZ(i,oldNormal.getX(i),oldNormal.getY(i),oldNormal.getZ(i));}
   g.computeBoundingBox();g.computeBoundingSphere();
  }
  return changed;
 }finally{[...queries,...surfaces].forEach(q=>q.geometry.dispose());}
}
