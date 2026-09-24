import * as T from 'three';
import {bodyHeightY} from './bodyHeight';
import {MeshBVH,StaticGeometryGenerator,SAH} from 'three-mesh-bvh';
import type {bindBlankBody} from './blankRig';
export type GarmentMotionFit={update():void;dispose():void};
const bary=[[1/3,1/3,1/3],[.5,.5,0],[0,.5,.5],[.5,0,.5],[.75,.25,0],[.25,.75,0],[0,.75,.25],[0,.25,.75],[.75,0,.25],[.25,0,.75],[.6,.2,.2],[.2,.6,.2],[.2,.2,.6]];
type Sample={ids:number[];weights:number[];active:number[];norm:number;sign:number;target:number;group?:{refine:boolean};fine?:boolean};

/** Bounded pose-space tuck for loose shirts. Queries the opaque outer in the
 * moving chest frame; never enlarges the coat or changes skin weights. */
export function createGarmentMotionFit(rig:ReturnType<typeof bindBlankBody>,outer:T.SkinnedMesh[],inner:T.SkinnedMesh[]):GarmentMotionFit|undefined{
 const opaque=outer.filter(m=>(Array.isArray(m.material)?m.material:[m.material]).every(mat=>{
  const a=mat as T.MeshStandardMaterial;return a.visible&&!a.transparent&&a.opacity===1&&!a.alphaTest&&!a.alphaMap&&!a.map;
 }));
 const chestIndex=rig.skeleton.bones.findIndex(b=>b.name==='chest');
 if(!opaque.length||!inner.length||chestIndex<0)return;
 const h=rig.bodyHeight,margin=.025*h,maxMove=.32*h;
 const source=inner.map(mesh=>{
  const g=mesh.geometry,base=Float32Array.from(g.attributes.position.array),used=[...new Set(Array.from(g.index!.array))];
  const eligible=new Set(used.filter(id=>Math.abs(base[id*3])<.85*h&&base[id*3+1]>bodyHeightY(2.05,h)&&base[id*3+1]<bodyHeightY(3.4,h)));
  const samples:Sample[]=[];
  for(const id of eligible)samples.push({ids:[id],weights:[1],active:[1],norm:1,sign:1,target:NaN});
  for(let t=0;t<g.index!.count;t+=3){
   const ids=[0,1,2].map(j=>g.index!.getX(t+j));if(!ids.some(id=>eligible.has(id)))continue;
   const group={refine:false};for(let j=0;j<bary.length;j++)samples.push({ids,weights:bary[j],active:[0,0,0],norm:0,sign:1,target:NaN,group,fine:j>=1});
  }
  return {mesh,base,normal:Float32Array.from(g.attributes.normal.array),used,eligible,samples,points:Array.from({length:base.length/3},()=>new T.Vector3()),originalZ:new Float64Array(base.length/3),touched:new Set<number>()};
 });
 const generator=new StaticGeometryGenerator(opaque);generator.attributes=['position'];generator.applyWorldTransforms=false;generator.useGroups=false;
 // The generator caches unchanged meshes; transform a separate copy, never its output.
 const rawSurface=new T.BufferGeometry(),surface=new T.BufferGeometry();
 const frame=new T.Matrix4(),inverseFrame=new T.Matrix4(),weighted=new T.Matrix4(),skin=new T.Matrix4(),inverse=new T.Matrix4(),p=new T.Vector3();
 const ray=new T.Ray(),point=new T.Vector3();let previous=new Float32Array(0),tree:MeshBVH|undefined,disposed=false,initialized=false;
 function update(){
  if(disposed)return;
  rig.mesh.parent!.updateWorldMatrix(true,true);rig.skeleton.update();
  const matrices=rig.skeleton.boneMatrices!;
  if(initialized&&previous.length===matrices.length&&previous.every((v,i)=>Math.abs(v-matrices[i])<1e-7))return;
  initialized=true;if(previous.length!==matrices.length)previous=new Float32Array(matrices.length);previous.set(matrices);
  frame.copy(rig.mesh.bindMatrixInverse).multiply(skin.fromArray(matrices,chestIndex*16)).multiply(rig.mesh.bindMatrix);inverseFrame.copy(frame).invert();
  generator.generate(rawSurface);
  if(!surface.index)surface.copy(rawSurface);
  const op=surface.attributes.position;
  for(let i=0;i<op.count;i++){p.fromBufferAttribute(rawSurface.attributes.position,i).applyMatrix4(inverseFrame);op.setXYZ(i,p.x,p.y,p.z);}
  if(tree)tree.refit();else tree=new MeshBVH(surface,{indirect:true,strategy:SAH,targetLeafSize:4});
  for(const {mesh,base,normal,used,eligible,samples,points,originalZ,touched} of source){
   const g=mesh.geometry,out=g.attributes.position;touched.clear();(out.array as Float32Array).set(base);
   for(const id of used){mesh.getVertexPosition(id,points[id]).applyMatrix4(inverseFrame);originalZ[id]=points[id].z;}
   // XY remains fixed during the tuck. Query each constraint only once per pose,
   // then solve its depth numerically without repeated BVH traversal/allocation.
   for(const s of samples){
    if(s.group&&s.weights===bary[0])s.group.refine=false;
    s.target=NaN;if(s.fine&&!s.group!.refine)continue;
    point.set(0,0,0);s.norm=0;
    for(let j=0;j<s.ids.length;j++){
     const id=s.ids[j],w=s.weights[j];point.addScaledVector(points[id],w);
     // Keep exposed center vertices of crossing triangles at the open front.
     s.active[j]=eligible.has(id)&&(s.ids.length===1||Math.abs(points[id].x)>.12*h)?w:0;s.norm+=s.active[j]**2;
    }
    s.target=NaN;if(s.norm<.01)continue;s.sign=point.z<0?-1:1;
    const originDepth=Math.abs(point.z)+maxMove;
    ray.origin.set(point.x,point.y,s.sign*originDepth);ray.direction.set(0,0,-s.sign);
    // Stop before the torso plane: a ray through the opening must not hit the back.
    const hit=tree!.raycastFirst(ray,T.DoubleSide,.001,Math.min(originDepth-.015*h,maxMove*2));
    if(hit&&Math.abs(hit.face!.normal.z)>=.15){
     s.target=hit.point.z-s.sign*margin;const depth=s.sign*(point.z-s.target);
     if(s.group&&depth>-.05*h&&depth<maxMove)s.group.refine=true;
    }
   }
   for(let pass=0;pass<6;pass++)for(const s of samples){
    if(!Number.isFinite(s.target))continue;
    let z=0;for(let j=0;j<s.ids.length;j++)z+=points[s.ids[j]].z*s.weights[j];
    const depth=s.sign*(z-s.target);if(depth<=0||depth>=maxMove)continue;
    const dz=s.target-z;
    for(let j=0;j<s.ids.length;j++){
     if(!s.active[j])continue;const id=s.ids[j],v=points[id],next=v.z+dz*s.active[j]/s.norm;
     if(Math.abs(next-originalZ[id])<=maxMove){v.z=next;touched.add(id);}
    }
   }
   for(const id of touched){
    weighted.elements.fill(0);
    for(let j=0;j<4;j++){const b=g.attributes.skinIndex.getComponent(id,j),w=g.attributes.skinWeight.getComponent(id,j);if(w)for(let k=0;k<16;k++)weighted.elements[k]+=matrices[b*16+k]*w;}
    inverse.copy(inverseFrame).multiply(mesh.bindMatrixInverse).multiply(weighted).multiply(mesh.bindMatrix).invert();
    p.copy(points[id]).applyMatrix4(inverse);out.setXYZ(id,p.x,p.y,p.z);
   }
      out.needsUpdate=true;
   if(touched.size){
    g.computeVertexNormals();const affected=new Set<number>();
    for(let t=0;t<g.index!.count;t+=3){const a=g.index!.getX(t),b=g.index!.getX(t+1),c=g.index!.getX(t+2);if(touched.has(a)||touched.has(b)||touched.has(c)){affected.add(a);affected.add(b);affected.add(c);}}
    for(let i=0;i<g.attributes.normal.count;i++)if(!affected.has(i))g.attributes.normal.setXYZ(i,normal[i*3],normal[i*3+1],normal[i*3+2]);
   }else (g.attributes.normal.array as Float32Array).set(normal);
   g.attributes.normal.needsUpdate=true;
  }
 }
 return {update,dispose(){if(disposed)return;disposed=true;rawSurface.dispose();surface.dispose();}};
}
