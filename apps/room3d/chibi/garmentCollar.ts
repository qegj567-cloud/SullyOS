import * as T from 'three';
import pose from './approvedStandingPose.json';
import {MeshBVH} from 'three-mesh-bvh';
import {createLayeredClothingMasks} from './garmentLayering';

import {layeringForGarment,usesPosedInnerFit} from './wardrobeLayering';

/** Shared posed shoulder/back fit for loose shirts inside close outerwear.
 * Only sailor collars receive the authored fold; shirt collars retain their
 * construction. Central placket and the approved cardigan are preserved.
 * Queries use the shared fitting pose; inverse weighted skin matrices return
 * each correction to bind space without changing any skin weights or rig pose.
 */
export function fitLayeredUpperGarments(outer:T.SkinnedMesh[],inner:T.SkinnedMesh[],skeleton:T.Skeleton,height:number,body:T.BufferGeometry,hideCoveredSkin=true){
 if(!outer.some(m=>layeringForGarment(m.userData.garmentId).outer==='posed')||!inner.some(m=>usesPosedInnerFit(m.userData.garmentId)))return {masks:[],bodyMask:undefined};
 // An alpha/lace neckline needs authored opacity coverage. Fail open instead
 // of treating its entire triangle as solid cloth.
 if(!outer.every(m=>(Array.isArray(m.material)?m.material:[m.material]).every(material=>{
  const a=material as T.MeshStandardMaterial;return a.visible&&!a.transparent&&a.opacity===1&&!a.alphaTest&&!a.alphaMap&&!a.map;
 })))return {masks:[],bodyMask:undefined};
 const worlds=new Map<T.Bone,T.Matrix4>(),rest=skeleton.boneInverses.map(m=>m.clone().invert());
 const world=(bone:T.Bone):T.Matrix4=>{
  if(worlds.has(bone))return worlds.get(bone)!;
  const i=skeleton.bones.indexOf(bone),parent=bone.parent as T.Bone,parentIndex=skeleton.bones.indexOf(parent);
  const local=parentIndex<0?rest[i].clone():rest[parentIndex].clone().invert().multiply(rest[i]);
  const p=new T.Vector3(),q=new T.Quaternion(),s=new T.Vector3();local.decompose(p,q,s);
  const angles=pose.state[bone.name as keyof typeof pose.state];
  if(angles){const sign=bone.name.startsWith('L')?1:-1;q.setFromEuler(new T.Euler(T.MathUtils.degToRad(angles[2]),-sign*T.MathUtils.degToRad(angles[1]),-sign*T.MathUtils.degToRad(angles[0])));}
  local.compose(p,q,s);const w=parentIndex<0?local:world(parent).clone().multiply(local);worlds.set(bone,w);return w;
 };
 const matrices=skeleton.bones.map((b,i)=>world(b).clone().multiply(skeleton.boneInverses[i]));
 const weighted=(g:T.BufferGeometry,i:number)=>{
  const m=new T.Matrix4();m.elements.fill(0);
  for(let j=0;j<4;j++){const w=g.attributes.skinWeight.getComponent(i,j),b=matrices[g.attributes.skinIndex.getComponent(i,j)];if(w)for(let k=0;k<16;k++)m.elements[k]+=b.elements[k]*w;}
  return m;
 };
 const transform=(g:T.BufferGeometry)=>{const c=g.clone(),p=c.attributes.position,v=new T.Vector3();for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).applyMatrix4(weighted(g,i));p.setXYZ(i,v.x,v.y,v.z);}return c;};
 const pairs=[...outer,...inner].map(m=>{const copy=new T.SkinnedMesh(transform(m.geometry),m.material);copy.userData=m.userData;return {m,copy};});
 const queries=pairs.slice(0,outer.length).map(p=>({g:p.copy.geometry,tree:new MeshBVH(p.copy.geometry,{indirect:true})}));
 const chest=world(skeleton.bones.find(b=>b.name==='chest')!).elements[13],masks:Array<{mesh:T.SkinnedMesh;geometry:T.BufferGeometry}>=[];
 const posedBody=transform(body);
 let bodyMask:T.BufferGeometry|undefined;
 const sleeveMasks:T.BufferGeometry[]=[];
 try{
  const posedSkeleton=new T.Skeleton(skeleton.bones,skeleton.bones.map(b=>world(b).clone().invert()));
  const sleeves=createLayeredClothingMasks(pairs.slice(0,outer.length).map(p=>p.copy),pairs.slice(outer.length).map(p=>p.copy),posedSkeleton,height,false,posedBody,new Set());
  sleeveMasks.push(...sleeves.masks.map(m=>m.geometry));
  const p=posedBody.attributes.position,ray=new T.Ray(),visible:number[]=[];
  const covered=(v:T.Vector3)=>{
   if(Math.abs(v.x)<.12||Math.abs(v.x)>.65||v.y<chest-.12*height||v.y>chest+.32*height)return false;
   const sign=v.z<0?-1:1;ray.origin.set(v.x,v.y,sign*3);ray.direction.set(0,0,-sign);
   return queries.some(q=>{const h=q.tree.raycastFirst(ray,T.DoubleSide,.001,3.35);return h&&Math.abs(h.point.z-v.z)<.35;});
  };
  // Keep the central neck and all head faces. Covered shoulder faces stay whole:
  // interpolated boundary weights would create a different bent skin surface.
  const groups:typeof body.groups=[];
  for(const group of body.groups.length?body.groups:[{start:0,count:posedBody.index!.count,materialIndex:0}]){
  const start=visible.length;
  for(let t=group.start;t<group.start+group.count;t+=3){
   const ids=[0,1,2].map(j=>posedBody.index!.getX(t+j)),ps=ids.map(i=>new T.Vector3().fromBufferAttribute(p,i));
   const protectedFace=ids.some(i=>Array.from({length:4},(_,j)=>skeleton.bones[posedBody.attributes.skinIndex.getComponent(i,j)].name==='head'?posedBody.attributes.skinWeight.getComponent(i,j):0).reduce((a,b)=>a+b,0)>.2);
   if(!hideCoveredSkin||protectedFace||ps.some(v=>Math.abs(v.x)<.10)||!covered(ps[0].clone().add(ps[1]).add(ps[2]).multiplyScalar(1/3)))visible.push(...ids);
  }
  groups.push({...group,start,count:visible.length-start});
  }
  if(visible.length<body.index!.count){bodyMask=body.clone();bodyMask.setIndex(visible);bodyMask.groups=groups;}
  for(const {m,copy} of pairs.slice(outer.length)){
   if(!usesPosedInnerFit(m.userData.garmentId))continue;
   const sailor=layeringForGarment(m.userData.garmentId).inner==='sailor';
   const g=m.geometry.clone(),p=copy.geometry.attributes.position,out=g.attributes.position;let moved=0;
   const sleeve=sleeves.masks.find(q=>q.mesh===copy)?.geometry;
   const armWeight=(i:number)=>Array.from({length:4},(_,j)=>/^[LR]_(clavicle|upperArm|forearm|twist|hand)/.test(skeleton.bones[g.attributes.skinIndex.getComponent(i,j)].name)?g.attributes.skinWeight.getComponent(i,j):0).reduce((a,b)=>a+b,0);
   if(sleeve){
    const kept=new Set<string>();for(let t=0;t<sleeve.index!.count;t+=3)kept.add([0,1,2].map(j=>sleeve.index!.getX(t+j)).join(','));
    const indices:number[]=[],groups:typeof g.groups=[];
    for(const group of g.groups.length?g.groups:[{start:0,count:g.index!.count,materialIndex:0}]){const start=indices.length;for(let t=group.start;t<group.start+group.count;t+=3){const ids=[0,1,2].map(j=>g.index!.getX(t+j));if(!ids.every(id=>armWeight(id)>.02)||kept.has(ids.join(',')))indices.push(...ids);}groups.push({...group,start,count:indices.length-start});}
    g.setIndex(indices);g.groups=groups;moved++;
   }
   for(let i=0;i<p.count;i++){
    const source=new T.Vector3().fromBufferAttribute(m.geometry.attributes.position,i);
    const chestWeight=Array.from({length:4},(_,j)=>skeleton.bones[g.attributes.skinIndex.getComponent(i,j)].name==='chest'?g.attributes.skinWeight.getComponent(i,j):0).reduce((a,b)=>a+b,0);
    if(sailor&&chestWeight>.95&&source.y>chest+.10*height&&Math.abs(source.x)>.18){
     // Fold the wide back/side collar toward the current body's neck. These
     // chest-bound panels are distinct from the arm-weighted white sleeve root.
     const blend=T.MathUtils.smoothstep(source.y,chest+.10*height,chest+.25*height);
     source.x=T.MathUtils.lerp(source.x,Math.sign(source.x)*Math.min(Math.abs(source.x),.205),blend);
     out.setXYZ(i,source.x,source.y,source.z);moved++;
    }
    if(sleeve&&armWeight(i)>.02){
     const point=new T.Vector3().fromBufferAttribute(sleeve.attributes.position,i);
     if(point.distanceToSquared(new T.Vector3().fromBufferAttribute(p,i))>1e-12){point.applyMatrix4(weighted(m.geometry,i).invert());out.setXYZ(i,point.x,point.y,point.z);moved++;}
    }
    const v=new T.Vector3().fromBufferAttribute(out,i).applyMatrix4(weighted(m.geometry,i));
    // The tucked shirt also follows the closed rear torso. A shoulder-only
    // correction leaves the wide back flap and waist corners outside the coat.
    // Fade before the front placket; wrists and sleeves keep their own fit.
    const rear=(1-T.MathUtils.smoothstep(v.z,.08*height,.24*height))
     *T.MathUtils.smoothstep(v.y,chest-1.05*height,chest-.85*height)
     *(1-T.MathUtils.smoothstep(Math.abs(v.x),.65*height,.85*height))
     *(1-T.MathUtils.smoothstep(Math.abs(source.x),.9*height,1.2*height));
    if(rear>0){
     const origin=new T.Vector3(0,v.y,0),direction=v.clone().sub(origin),radius=direction.length();direction.normalize();
     const radial=new T.Ray(origin,direction);
     const hits=queries.map(q=>q.tree.raycastFirst(radial,T.DoubleSide,.05*height,1.2*height)).filter(h=>h!==null).sort((a,b)=>a.distance-b.distance);
     const hit=hits[0];
     if(hit&&radius>hit.distance-.075*height&&radius-hit.distance<.4*height){
      v.lerp(origin.addScaledVector(direction,Math.max(.05*height,hit.distance-.075*height)),rear);
      const bind=v.clone().applyMatrix4(weighted(m.geometry,i).invert());out.setXYZ(i,bind.x,bind.y,bind.z);moved++;
     }
    }
    const backCollar=chestWeight>.95?rear*T.MathUtils.smoothstep(v.y,chest,chest+.10*height):0;
    const blend=Math.max(backCollar,T.MathUtils.smoothstep(Math.abs(v.x),.16,.30)*T.MathUtils.smoothstep(v.y,chest-.10*height,chest+.10*height));
    if(!blend||Math.abs(v.x)>.75*height)continue;
    let closest:ReturnType<MeshBVH['closestPointToPoint']>=null,geometry:T.BufferGeometry|undefined;
    for(const q of queries){const hit=q.tree.closestPointToPoint(v,undefined,0,.4);if(hit&&(!closest||hit.distance<closest.distance)){closest=hit;geometry=q.g;}}
    if(!closest||!geometry)continue;
    const ids=[0,1,2].map(j=>geometry!.index!.getX(closest!.faceIndex*3+j)),ps=ids.map(id=>new T.Vector3().fromBufferAttribute(geometry!.attributes.position,id));
    const normal=new T.Triangle(...ps as [T.Vector3,T.Vector3,T.Vector3]).getNormal(new T.Vector3()),origin=new T.Vector3(0,Math.min(chest,v.y),0);
    if(normal.dot(closest.point.clone().sub(origin))<0)normal.negate();
    const protrusion=v.clone().sub(closest.point).dot(normal);if(protrusion<-.008)continue;
    v.lerp(closest.point.clone().addScaledVector(normal,-.08),blend).applyMatrix4(weighted(m.geometry,i).invert());
    out.setXYZ(i,v.x,v.y,v.z);moved++;
   }
   // Arm/chest boundaries do not have one bone-region classification. Once the
   // retained back panels are tucked, check their actual projected coverage as
   // whole faces as well; otherwise a covered seam can reappear when arms bend.
   const rearPoints=Array.from({length:out.count},(_,i)=>new T.Vector3().fromBufferAttribute(out,i).applyMatrix4(weighted(m.geometry,i)));
   const rearCovered=(v:T.Vector3)=>{
    if(v.z>.18*height||(v.z>0&&Math.abs(v.x)<.12*height)||Math.abs(v.x)>.70*height||v.y<chest-.90*height||v.y>chest+.30*height)return false;
    ray.origin.set(v.x,v.y,-3*height);ray.direction.set(0,0,1);
    return queries.some(q=>{const hit=q.tree.raycastFirst(ray,T.DoubleSide,.001,3.4*height);return hit&&hit.point.z<v.z+.10*height&&Math.abs(hit.point.z-v.z)<.45*height;});
   };
   const rearIndices:number[]=[],rearGroups:typeof g.groups=[];
   for(const group of g.groups.length?g.groups:[{start:0,count:g.index!.count,materialIndex:0}]){
    const start=rearIndices.length;
    for(let t=group.start;t<group.start+group.count;t+=3){
     const ids=[0,1,2].map(j=>g.index!.getX(t+j)),ps=ids.map(i=>rearPoints[i]);
     const samples=[...ps,...ps.map((v,j)=>v.clone().lerp(ps[(j+1)%3],.5)),ps[0].clone().add(ps[1]).add(ps[2]).multiplyScalar(1/3)];
     if(samples.every(rearCovered))moved++;else rearIndices.push(...ids);
    }
    rearGroups.push({...group,start,count:rearIndices.length-start});
   }
   g.setIndex(rearIndices);g.groups=rearGroups;
   if(moved){g.computeVertexNormals();masks.push({mesh:m,geometry:g});}else g.dispose();
  }
  return {masks,bodyMask};
 }catch(error){masks.forEach(m=>m.geometry.dispose());bodyMask?.dispose();throw error;}
 finally{sleeveMasks.forEach(g=>g.dispose());pairs.forEach(p=>p.copy.geometry.dispose());posedBody.dispose();}
}
