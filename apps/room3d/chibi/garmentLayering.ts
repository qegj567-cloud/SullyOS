import * as T from 'three';
import {layeringForGarment} from './wardrobeLayering';
import {MeshBVH} from 'three-mesh-bvh';

export interface LayeringReport {
 affectedGarments:number;
 hiddenTriangles:number;
 inspectedTriangles:number;
 skippedMaterials:number;
 tuckedVertices:number;
 hemAdjustedGarments?:number;
}
type Region='body'|'L_arm'|'R_arm';
interface Sample {point:T.Vector3;origin:T.Vector3;region:Region;protected:boolean;sleeveEligible:boolean}
interface Occluder {geometry:T.BufferGeometry;tree:MeshBVH;source:T.BufferGeometry}

/** Bone-directed inner mesh hiding, following the documented CC Auto Hide
 * approach. BVH queries use three-mesh-bvh; we do not implement a ray engine.
 * Work in the shared fitted bind space, never in a transient animation pose.
 * See docs/chibi-layering.md for sources, limits and the opening guard.
 */
export function createLayeredClothingMasks(outer:T.SkinnedMesh[],inner:T.SkinnedMesh[],skeleton:T.Skeleton,height=1,skin=false,visibleBody?:T.BufferGeometry,surfaceShells?:ReadonlySet<T.SkinnedMesh>){
 const report:LayeringReport={affectedGarments:0,hiddenTriangles:0,inspectedTriangles:0,skippedMaterials:0,tuckedVertices:0};
 const masks:Array<{mesh:T.SkinnedMesh;geometry:T.BufferGeometry}>=[];
 const occluders:Occluder[]=[];
 let bodyQuery:T.BufferGeometry|undefined,bodyTree:MeshBVH|undefined;
 const rest=new Map(skeleton.bones.map((bone,i)=>[bone.name,new T.Vector3().setFromMatrixPosition(skeleton.boneInverses[i].clone().invert())]));
 const torso=rest.get('chest')??new T.Vector3(0,3*height,0);
 const margin=.045*Math.min(1,height),maxProtrusion=.65,maxGap=.65;
 const ray=new T.Ray(),direction=new T.Vector3(),offsetPoint=new T.Vector3(),u=new T.Vector3(),v=new T.Vector3();
 const weightsAt=(g:T.BufferGeometry,index:number)=>{
  const ids=g.attributes.skinIndex,weights=g.attributes.skinWeight;
  const result:{L:number;R:number;protected:number;wrist:number}={L:0,R:0,protected:0,wrist:0};
  if(!ids||!weights)return result;
  for(let j=0;j<4;j++){
   const name=skeleton.bones[ids.getComponent(index,j)]?.name??'',w=weights.getComponent(index,j);
   if(/^(neck|head)$|_(hand|thumb|index|middle|ring|pinky)/.test(name))result.protected+=w;
   if(/^[LR]_hand$/.test(name))result.wrist+=w;
   if(/^[LR]_(clavicle|upperArm|forearm|twist|hand)/.test(name))result[name[0] as 'L'|'R']+=w;
  }
  return result;
 };
 const sampleAt=(g:T.BufferGeometry,index:number):Sample=>{
  const point=new T.Vector3().fromBufferAttribute(g.attributes.position,index),weights=weightsAt(g,index);
  const side=weights.L>weights.R?'L':'R',arm=weights[side]>.55;
  const origin=new T.Vector3(torso.x,point.y,torso.z);
  if(arm){
   const shoulder=rest.get(`${side}_upperArm`),hand=rest.get(`${side}_hand`);
   if(shoulder&&hand)new T.Line3(shoulder,hand).closestPointToPoint(point,true,origin);
  }
  return {point,origin,region:arm?`${side}_arm`:'body',protected:weights.protected>.2,sleeveEligible:weights.protected-weights.wrist<=.2};
 };
 const sameRegion=(hit:T.Intersection,occluder:Occluder,region:Region)=>{
  if(!hit.face)return false;
  const weights=[hit.face.a,hit.face.b,hit.face.c].map(i=>weightsAt(occluder.source,i));
  const l=weights.reduce((sum,w)=>sum+w.L,0)/3,r=weights.reduce((sum,w)=>sum+w.R,0)/3;
  return region==='L_arm'?l>.35:region==='R_arm'?r>.35:Math.max(l,r)<.65;
 };
 const hitsCloth=(point:T.Vector3,origin:T.Vector3,region:Region)=>{
  direction.copy(point).sub(origin);const distance=direction.length();
  if(distance<.015)return false;
  ray.set(origin,direction.multiplyScalar(1/distance));
  for(const occluder of occluders){
   const hit=occluder.tree.raycastFirst(ray,T.DoubleSide,.005,distance+maxGap);
   // A protruding inner layer may be hidden according to layer order. A far-away
   // garment, opposite limb or near-tangent surface is not reliable coverage.
   if(hit&&hit.distance>=distance-maxProtrusion&&hit.face&&Math.abs(hit.face.normal.dot(direction))>.25&&sameRegion(hit,occluder,region))return true;
  }
  return false;
 };
 const sleeveVolumes:Array<{start:T.Vector3;axis:T.Vector3;step:number;radii:number[];region:Region}>=[];
 const inSleeve=(sample:Sample)=>{
  if(sample.region==='body'||!sample.sleeveEligible)return false;
  for(const sleeve of sleeveVolumes){
   if(sleeve.region!==sample.region)continue;
   const delta=sample.point.clone().sub(sleeve.start),along=delta.dot(sleeve.axis);
   // Both neighbouring sections and the opening buffer must be closed. Never
   // bridge an opening or extrapolate beyond an actual cuff, including when
   // the user shortens the outer sleeve. The inner cuff remains intact there.
   const from=Math.floor((along-margin)/sleeve.step),to=Math.ceil((along+margin)/sleeve.step);
   if(from<0||to>=sleeve.radii.length)continue;
   let radius=Infinity;for(let i=from;i<=to;i++)radius=Math.min(radius,sleeve.radii[i]);
   if(radius>0&&Number.isFinite(radius)&&delta.addScaledVector(sleeve.axis,-along).length()<radius+maxProtrusion)return true;
  }
  return false;
 };
 const covered=(sample:Sample,preserveOutline=false)=>{
  if(skin&&sample.protected)return false;
  // A continuous opaque tube covers an inner sleeve even where a deep fold
  // makes individual surface rays tangent. This is cloth-to-cloth coverage,
  // not a skin/hand mask; it may include wrist-weighted cloth inside the tube.
  if(inSleeve(sample))return true;
  if(sample.protected||!hitsCloth(sample.point,sample.origin,sample.region))return false;
  if(preserveOutline&&sample.region==='body'&&!hitsCloth(sample.point,new T.Vector3(sample.point.x,sample.point.y,sample.origin.z),sample.region))return false;
  direction.copy(sample.point).sub(sample.origin).normalize();
  u.crossVectors(direction,Math.abs(direction.y)<.8?T.Object3D.DEFAULT_UP:new T.Vector3(1,0,0)).normalize().multiplyScalar(margin);
  v.crossVectors(direction,u).normalize().multiplyScalar(margin);
  // Keep a collar/cuff/hem/placket buffer. All four neighbouring rays must
  // find real opaque cloth, so a single ray across an opening cannot erase it.
  const offsets=[u.clone(),u.clone().negate(),v.clone(),v.clone().negate()];
  return offsets.every(offset=>hitsCloth(offsetPoint.copy(sample.point).add(offset),sample.origin,sample.region));
 };
 const interpolate=(a:Sample,b:Sample,c?:Sample):Sample=>({
  point:c?a.point.clone().add(b.point).add(c.point).multiplyScalar(1/3):a.point.clone().lerp(b.point,.5),
  origin:c?a.origin.clone().add(b.origin).add(c.origin).multiplyScalar(1/3):a.origin.clone().lerp(b.origin,.5),
  region:a.region,protected:a.protected||b.protected||!!c?.protected||a.region!==b.region||(!!c&&a.region!==c.region),
  sleeveEligible:a.sleeveEligible&&b.sleeveEligible&&(!c||c.sleeveEligible)&&a.region===b.region&&(!c||a.region===c.region),
 });
 try{
  if(visibleBody){bodyQuery=new T.BufferGeometry();bodyQuery.setAttribute('position',visibleBody.attributes.position);bodyQuery.setIndex(visibleBody.index!.clone());bodyTree=new MeshBVH(bodyQuery,{indirect:true});}
  for(const mesh of outer){
   const source=mesh.geometry,materials=Array.isArray(mesh.material)?mesh.material:[mesh.material],index:number[]=[];
   const groups=source.groups.length?source.groups:[{start:0,count:source.index?.count??source.attributes.position.count,materialIndex:0}];
   for(const group of groups){
    const material=materials[group.materialIndex??0] as T.MeshStandardMaterial|undefined;
    // Fail open for authored transparency. Current outerwear is untextured;
    // future lace/alpha textures need per-pixel opacity sampling, not guessing.
    if(!material||!material.visible||material.transparent||material.opacity<1||material.alphaTest>0||material.alphaMap||material.map){report.skippedMaterials++;continue;}
    for(let i=group.start;i<group.start+group.count;i++)index.push(source.index?source.index.getX(i):i);
   }
   if(!index.length)continue;
   const geometry=new T.BufferGeometry();geometry.setAttribute('position',source.attributes.position);geometry.setIndex(index);
   // Indirect mode also keeps this private query index in authored order.
   occluders.push({geometry,source,tree:new MeshBVH(geometry,{indirect:true})});
  }
  if(!occluders.length)return {masks,report};
  for(const side of ['L','R'] as const){
   const start=rest.get(`${side}_upperArm`),hand=rest.get(`${side}_hand`);if(!start||!hand)continue;
   const axis=hand.clone().sub(start).normalize(),up=new T.Vector3(0,1,0).addScaledVector(axis,-axis.y).normalize(),front=new T.Vector3().crossVectors(axis,up);
   const region:Region=`${side}_arm`,step=.025,radii:number[]=[];
   let extent=0;
   for(const o of occluders)for(let i=0;i<o.geometry.index!.count;i++){
    const id=o.geometry.index!.getX(i);if(weightsAt(o.source,id)[side]>.55)extent=Math.max(extent,new T.Vector3().fromBufferAttribute(o.source.attributes.position,id).sub(start).dot(axis));
   }
   for(let s=0;s<=Math.ceil(extent/step);s++){
    const center=start.clone().addScaledVector(axis,s*step);let radius=0;
    for(let a=0;a<32;a++){
     const angle=a*Math.PI*2/32,radial=up.clone().multiplyScalar(Math.cos(angle)).addScaledVector(front,Math.sin(angle));ray.set(center,radial);
     let distance=Infinity;
     for(const o of occluders){const hit=o.tree.raycastFirst(ray,T.DoubleSide,.005,1.25);if(hit&&sameRegion(hit,o,region))distance=Math.min(distance,hit.distance);}
     if(!Number.isFinite(distance)){radius=0;break;}radius=Math.max(radius,distance);
    }
    radii.push(radius);
   }
   sleeveVolumes.push({start,axis,step,radii,region});
  }
  const affected=new Set<string>();
  for(const mesh of inner){
   const source=mesh.geometry,index=source.index;
   // A flared long skirt can extend beyond a short coat's front silhouette
   // while a diagonal radial ray still hits the coat. Keep those skirt faces.
   const preserveSkirtOutline=!skin&&layeringForGarment(mesh.userData.garmentId).preserveSkirtOutline===true;
   const coveredSample=(s:Sample)=>covered(s,preserveSkirtOutline);
   const samples=Array.from({length:source.attributes.position.count},(_,i)=>sampleAt(source,i));
   const states=new Map<number,boolean>(),visible:number[]=[],groups:typeof source.groups=[];
   const isCovered=(i:number)=>{if(!states.has(i))states.set(i,coveredSample(samples[i]));return states.get(i)!;};
   let hidden=0;
   for(const group of source.groups.length?source.groups:[{start:0,count:index?.count??samples.length,materialIndex:0}]){
    const start=visible.length;
    for(let i=group.start;i<group.start+group.count;i+=3){
     const a=index?index.getX(i):i,b=index?index.getX(i+1):i+1,c=index?index.getX(i+2):i+2;
     report.inspectedTriangles++;
     const remove=isCovered(a)&&isCovered(b)&&isCovered(c)&&coveredSample(interpolate(samples[a],samples[b],samples[c]))&&coveredSample(interpolate(samples[a],samples[b]))&&coveredSample(interpolate(samples[b],samples[c]))&&coveredSample(interpolate(samples[c],samples[a]));
     if(remove)hidden++;else visible.push(a,b,c);
    }
    groups.push({...group,start,count:visible.length-start});
   }
   // A face crossing an open placket must remain, but its covered corners can
   // still protrude. Tuck those corners just inside the actual outer surface.
   // Preserve topology/weights, and leave rays through the opening untouched.
   const positions=source.attributes.position.clone(),tuckedIds=new Set<number>();let tucked=0;
   for(const i of skin?[]:new Set(visible)){
    const sample=samples[i];if(sample.protected)continue;
    // Tuck only the torso/shoulder transition. The continuous sleeve mask
    // handles the arm; projecting a visible cuff would crush its opening.
    if(sample.region!=='body'){
     const side=sample.region[0],shoulder=rest.get(`${side}_upperArm`),hand=rest.get(`${side}_hand`);
     if(!shoulder||!hand||sample.origin.distanceTo(shoulder)>.4*shoulder.distanceTo(hand))continue;
    }
    const origin=new T.Vector3(sample.point.x,sample.point.y,sample.origin.z);
    direction.copy(sample.point).sub(origin);const distance=direction.length();if(distance<.015)continue;
    ray.set(origin,direction.multiplyScalar(1/distance));let limit=distance;
    for(const o of occluders){const hit=o.tree.raycastFirst(ray,T.DoubleSide,.005,distance+.07);
     if(hit&&hit.distance>=distance-maxProtrusion&&sameRegion(hit,o,sample.region))limit=Math.min(limit,Math.max(.015,hit.distance-.12));
    }
    // At a collar/armhole, protected skin may still be visible. Never tuck
    // the shirt underneath it; keep a thin clearance above that body face.
    if(limit<distance&&bodyTree){const hit=bodyTree.raycastFirst(ray,T.DoubleSide,.005,distance+.04);if(hit)limit=Math.min(distance,Math.max(limit,hit.distance+.018));}
    if(limit<distance-.0001){const point=origin.clone().addScaledVector(direction,limit);positions.setXYZ(i,point.x,point.y,point.z);tuckedIds.add(i);}
   }
   // Vertex clearance alone misses skin through a cloth face's interior.
   // Limit that face's tuck as a whole, retaining as much correction as fits.
   // Only original vertices move; skin weights/topology remain untouched.
   if(bodyTree&&(!surfaceShells||surfaceShells.has(mesh))){
    let restored=true;
    const barycentrics=[[1,0,0],[0,1,0],[0,0,1],[.5,.5,0],[0,.5,.5],[.5,0,.5],[1/3,1/3,1/3]];
    for(let pass=0;restored&&pass<12;pass++){restored=false;
     for(let t=0;t<visible.length;t+=3){
      const ids=visible.slice(t,t+3);if(!ids.some(id=>tuckedIds.has(id)))continue;
      const points=ids.map(id=>new T.Vector3().fromBufferAttribute(positions,id));
      let restore=0;
      for(const weights of barycentrics){
       const point=new T.Vector3(),originalPoint=new T.Vector3();let z=0;
       weights.forEach((weight,j)=>{point.addScaledVector(points[j],weight);originalPoint.addScaledVector(samples[ids[j]].point,weight);z+=samples[ids[j]].origin.z*weight;});
       const origin=new T.Vector3(point.x,point.y,z),distance=Math.abs(point.z-z),originalDistance=Math.abs(originalPoint.z-z);if(distance<.015||originalDistance-distance<.00001)continue;
       ray.set(origin,new T.Vector3(0,0,Math.sign(point.z-z)));
       const hit=bodyTree!.raycastFirst(ray,T.DoubleSide,.005,originalDistance+.04);
       if(hit){const required=Math.min(originalDistance,hit.distance+.018);restore=Math.max(restore,(required-distance)/(originalDistance-distance));}
      }
      if(restore>.0001)for(const id of ids)if(tuckedIds.has(id)){
       const p=new T.Vector3().fromBufferAttribute(positions,id).lerp(samples[id].point,Math.min(1,restore));positions.setXYZ(id,p.x,p.y,p.z);restored=true;
       if(p.distanceToSquared(samples[id].point)<1e-8)tuckedIds.delete(id);
      }
     }
    }
   }
   tucked=tuckedIds.size;
   if(hidden||tucked){
    // Whole triangles only: do not interpolate weights or generate vertices at
    // the mask boundary (that previously deformed this project's thin shells).
    const geometry=source.clone();geometry.setIndex(visible);geometry.groups=groups;
    if(tucked){geometry.setAttribute('position',positions);geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();}
    masks.push({mesh,geometry});affected.add(mesh.userData.garmentId??mesh.uuid);report.hiddenTriangles+=hidden;
    report.tuckedVertices+=tucked;
   }
  }
  report.affectedGarments=affected.size;
  return {masks,report};
 }catch(error){masks.forEach(m=>m.geometry.dispose());throw error;}
 finally{bodyQuery?.dispose();occluders.forEach(o=>o.geometry.dispose());}
}


