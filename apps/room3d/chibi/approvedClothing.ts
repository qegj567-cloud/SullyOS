import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {approvedGarments,cleanApprovedWardrobe,type ApprovedWardrobe} from './approvedWardrobe';
import type {bindBlankBody} from './blankRig';
import {createClothingMask} from './clothingMask';
import {fitForGarment,deformGarment,garmentTransform,manualCoverage,type WardrobeFits} from './garmentFit';
import {cleanWardrobeColors,createGarmentColorController,type WardrobeColors} from './wardrobeColors';
import {layeringForGarment,usesPosedInnerFit} from './wardrobeLayering';
import type {LayeringReport} from './garmentLayering';
import {bodyHeightY,bodyBaseY,bodyHeightSlope} from './bodyHeight';
import {fitSockSurface} from './fitSockSurface';
const assets=new Map<string,Promise<T.Group>>();
function load(asset:string){let task=assets.get(asset);if(!task){task=new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}room3d/wardrobe/${asset}`).then(g=>{g.scene.traverse(o=>{if(o instanceof T.Mesh)for(const m of Array.isArray(o.material)?o.material:[o.material])m.userData.wardrobeMaterialIndex=g.parser.associations.get(m)?.materials;});g.scene.updateMatrixWorld(true);return g.scene;}).catch(e=>{assets.delete(asset);throw e;});assets.set(asset,task);}return task;}
type Rig=ReturnType<typeof bindBlankBody>;
/** Attach authored primitives by bone name; retain UVs, materials and authored weights. */
export async function prepareApprovedWardrobe(rig:Rig,value:ApprovedWardrobe,fits:WardrobeFits={},colors:WardrobeColors={},layering=false){
 const wardrobe=cleanApprovedWardrobe(value),defs=Object.values(wardrobe).map(id=>approvedGarments.find(g=>g.id===id)!),loaded=await Promise.all(defs.map(d=>load(`${d.asset}?v=${d.revision??'1'}`)));
 const fitById=new Map(defs.map(d=>[d.id,fitForGarment(d.id,fits[d.id],wardrobe.bottom??wardrobe.onepiece)]));
 const meshes:T.SkinnedMesh[]=[],resources:Array<{dispose():void}>=[],original=rig.baseGeometry;
 const colorControllers:Array<{id:string;update:(colors?:Record<string,string>)=>void}>=[];
 const targetIds=new Map(rig.skeleton.bones.map((b,i)=>[b.name,i]));
 const targetRest=rig.skeleton.boneInverses.map(m=>new T.Vector3().setFromMatrixPosition(m.clone().invert()));
 try{for(let k=0;k<defs.length;k++){
  const d=defs[k];let found=0;
  loaded[k].traverse(o=>{if(!(o instanceof T.SkinnedMesh)||!o.name.startsWith(d.prefix))return;found++;
   const g=o.geometry.clone(),p=g.attributes.position,n=g.attributes.normal,si=g.attributes.skinIndex,sw=g.attributes.skinWeight;
   const morphIndex=o.morphTargetDictionary?.VNeck;
   if(morphIndex!==undefined){const amount=fitById.get(d.id)!.neckline/100;for(const name of ['position','normal']){const base=g.attributes[name],target=g.morphAttributes[name]?.[morphIndex];if(!base||!target)continue;for(let i=0;i<base.count;i++)for(let axis=0;axis<3;axis++){const v=base.getComponent(i,axis),t=target.getComponent(i,axis);base.setComponent(i,axis,g.morphTargetsRelative?v+t*amount:T.MathUtils.lerp(v,t,amount));}}g.normalizeNormals();g.morphAttributes={};}
   const remap=o.skeleton.bones.map(b=>targetIds.get(b.name)??targetIds.get(b.name.replace(/twist[123]/,'forearm')));
   if(remap.some((id,i)=>id===undefined&&Array.from(si.array).includes(i)))throw Error(`${d.label}的骨骼与当前素体不匹配`);
   const sourceRest=o.skeleton.boneInverses.map(m=>new T.Vector3().setFromMatrixPosition(m.clone().invert()));
   // The mesh's scene placement can include a preview-only floor lift (geta).
   // Bind space matches the inverse-bind matrices; importing matrixWorld here
   // would bake that lift into the vertices before we lift the target rig again.
   const normalMatrix=new T.Matrix3().getNormalMatrix(o.bindMatrix),q=new T.Vector3(),normal=new T.Vector3(),delta=new T.Vector3();
   for(let i=0;i<p.count;i++){
    q.fromBufferAttribute(p,i).applyMatrix4(o.bindMatrix);const ySlope=bodyHeightSlope(q.y,rig.bodyHeight);q.y=bodyHeightY(q.y,rig.bodyHeight);
    delta.set(0,0,0);
    for(let j=0;j<4;j++){const old=si.getComponent(i,j),id=remap[old]??0,w=sw.getComponent(i,j),src=sourceRest[old];if(w&&src){delta.x+=(targetRest[id].x-src.x)*w;delta.y+=(targetRest[id].y-bodyHeightY(src.y,rig.bodyHeight))*w;delta.z+=(targetRest[id].z-src.z)*w;}si.setComponent(i,j,id);}
    q.add(delta);p.setXYZ(i,q.x,q.y,q.z);
    if(n){normal.fromBufferAttribute(n,i).applyMatrix3(normalMatrix);normal.y/=ySlope;normal.normalize();n.setXYZ(i,normal.x,normal.y,normal.z);}
   }
   const materials=(Array.isArray(o.material)?o.material:[o.material]).map(m=>{const copy=m.clone();copy.side=T.DoubleSide;if(copy instanceof T.MeshStandardMaterial)colorControllers.push({id:d.id,update:createGarmentColorController(copy,d.id,m.userData.wardrobeMaterialIndex)});resources.push(copy);return copy;});
   const mesh=new T.SkinnedMesh(g,Array.isArray(o.material)?materials:materials[0]);mesh.name=`wardrobe:${d.id}:${found}`;mesh.userData.garmentId=d.id;mesh.frustumCulled=false;
   mesh.bind(rig.skeleton,rig.mesh.bindMatrix);meshes.push(mesh);resources.push(g);
  });if(!found)throw Error(`服装资源缺少部件：${d.label}`);
 }
 const originalBounds=new Map<string,T.Box3>();
 for(const mesh of meshes){mesh.geometry.computeBoundingBox();const id=mesh.userData.garmentId;const box=originalBounds.get(id)??new T.Box3();box.union(mesh.geometry.boundingBox!);originalBounds.set(id,box);}
 // Paired hand sleeves share materials across both arms. Scale each sleeve
 // around its own center, retaining their spacing and all material alignment.
 const sleeveCenters=new Map<string,{left:T.Vector3;right:T.Vector3}>();
 for(const d of defs.filter(d=>d.sleeveOnly)){
  const left=new T.Box3(),right=new T.Box3(),p=new T.Vector3();
  for(const mesh of meshes.filter(m=>m.userData.garmentId===d.id)){const positions=mesh.geometry.attributes.position;for(let i=0;i<positions.count;i++){p.fromBufferAttribute(positions,i);(p.x<0?left:right).expandByPoint(p);}}
  if(!left.isEmpty()&&!right.isEmpty())sleeveCenters.set(d.id,{left:left.getCenter(new T.Vector3()),right:right.getCenter(new T.Vector3())});
 }
 for(const mesh of meshes){const d=defs.find(d=>d.id===mesh.userData.garmentId)!;deformGarment(mesh.geometry,garmentTransform(d.sleeveOnly?'top':d.slot,fitById.get(d.id)!,rig.bodyHeight,originalBounds.get(d.id)!,sleeveCenters.get(d.id)));}
 for(const mesh of meshes)if(mesh.userData.garmentId==='school-socks')fitSockSurface(mesh.geometry,rig);
 // Actual loaded hems can differ from the original manifest after fitting edits.
 const hems=new Map<string,number>(),tops=new Map<string,number>();for(const mesh of meshes){mesh.geometry.computeBoundingBox();const id=mesh.userData.garmentId;hems.set(id,Math.min(hems.get(id)??Infinity,bodyBaseY(mesh.geometry.boundingBox!.min.y,rig.bodyHeight)));tops.set(id,Math.max(tops.get(id)??-Infinity,bodyBaseY(mesh.geometry.boundingBox!.max.y,rig.bodyHeight)));}
 // Use the actual authored opening, not the highest tongue, bow or cuff vertex.
 // An opening of zero is open footwear: its foot must remain visible.
 const shoe=defs.find(d=>d.slot==='shoes');
 const shoeOpening=shoe&&shoe.opening!==undefined&&shoe.opening>0
  ?bodyBaseY(garmentTransform('shoes',fitById.get(shoe.id)!,rig.bodyHeight,originalBounds.get(shoe.id)!)(new T.Vector3(0,bodyHeightY(shoe.opening,rig.bodyHeight),0)).y,rig.bodyHeight):0;
 const clipMesh=(mesh:T.SkinnedMesh,covers:(p:T.Vector3)=>boolean)=>{if(!mesh.geometry.groups.length)mesh.geometry.addGroup(0,mesh.geometry.index!.count,0);const clipped=createClothingMask(mesh.geometry,covers,-Infinity);mesh.geometry=clipped;resources.push(clipped);};
 // Socks stay complete as an asset; only their buried section is clipped while shoes are worn.
 if(shoeOpening>0)for(const mesh of meshes.filter(m=>defs.find(d=>d.id===m.userData.garmentId)?.slot==='socks')){
  // These two pieces were split along their existing shared triangle seam;
  // clipping that seam again would cut holes and add interpolated vertices.
  const unchangedSeam=['original-shoes','original-socks'].every(id=>{const f=fitById.get(id);return f&&f.width===100&&f.depth===100&&f.length===100&&f.clearance===0&&f.offsetX===0&&f.offsetY===0&&f.offsetZ===0;});
  if(shoe?.id==='original-shoes'&&mesh.userData.garmentId==='original-socks'&&unchangedSeam)continue;
  clipMesh(mesh,p=>bodyBaseY(p.y,rig.bodyHeight)<shoeOpening-.055);
 }
 // These trouser legs are worn over the boot shaft. A fitted boot may be wider
 // than a trouser's folded shin: keep only the shaft below the trouser cuff,
 // with overlap hidden inside it. The cached/source boot remains complete.
 const trousers=defs.find(d=>d.slot==='bottom'&&d.bootCover!==undefined);
 if(shoe&&trousers){
  // Authored from the highest point of the actual leg opening plus overlap;
  // a hanging fold can lie much lower than that opening (cargo trousers).
  const buriedAbove=bodyBaseY(garmentTransform('bottom',fitById.get(trousers.id)!,rig.bodyHeight,originalBounds.get(trousers.id)!)(new T.Vector3(0,bodyHeightY(trousers.bootCover!,rig.bodyHeight),0)).y,rig.bodyHeight);
  if(shoeOpening>buriedAbove)for(const mesh of meshes.filter(m=>m.userData.garmentId===shoe.id))clipMesh(mesh,p=>bodyBaseY(p.y,rig.bodyHeight)>buriedAbove);
 }
 let layeringReport:LayeringReport|undefined,layeredBody:T.BufferGeometry|undefined;
 const layeredIds=new Set<string>(),beforeLayering=new Map<T.SkinnedMesh,T.BufferGeometry>();
 if(layering===true&&wardrobe.outer){
  const outer=meshes.filter(m=>m.userData.garmentId===wardrobe.outer);
  const inner=meshes.filter(m=>[wardrobe.top,wardrobe.onepiece,wardrobe.bottom].includes(m.userData.garmentId));
  inner.forEach(m=>beforeLayering.set(m,m.geometry));
  const {createLayeredClothingMasks}=await import('./garmentLayering');
  // Keep skin hidden by the original inner garment when that cloth is tucked.
  // Use whole original body faces: never subdivide/interpolate thin-shell skin.
  const opaque=meshes.filter(m=>fitById.get(m.userData.garmentId)!.autoHide);
  const skin=createLayeredClothingMasks(opaque,[new T.SkinnedMesh(original,rig.mesh.material)],rig.skeleton,rig.bodyHeight,true);
  layeredBody=skin.masks[0]?.geometry;if(layeredBody)resources.push(layeredBody);
  // These basics follow the body's surface triangles; keep their whole faces
  // above exposed skin. Stiff/loose garments retain their existing tuck rule.
  const surfaceShells=new Set(inner.filter(m=>layeringForGarment(m.userData.garmentId).inner==='surface-shell'));
  const result=createLayeredClothingMasks(outer,inner,rig.skeleton,rig.bodyHeight,false,layeredBody??original,surfaceShells);layeringReport=result.report;
  for(const {mesh,geometry} of result.masks){mesh.geometry=geometry;resources.push(geometry);layeredIds.add(mesh.userData.garmentId);}

 }
 if(layering===true&&wardrobe.bottom&&(wardrobe.top||wardrobe.outer)){
  const {fitGarmentHem}=await import('./garmentHem');
  const bottom=meshes.filter(m=>m.userData.garmentId===wardrobe.bottom),waist=new T.Box3();
  for(const m of bottom){m.geometry.computeBoundingBox();waist.union(m.geometry.boundingBox!);}
  const lowerFit=fitById.get(wardrobe.bottom)!,center=new T.Vector2(lowerFit.offsetX*.01,lowerFit.offsetZ*.01);let adjusted=0;
  // Fit the top first, then let the outer hem clear both top and lowerwear.
  for(const id of [wardrobe.top,wardrobe.outer])if(id){
   const upper=meshes.filter(m=>m.userData.garmentId===id),under=id===wardrobe.outer?[...bottom,...meshes.filter(m=>m.userData.garmentId===wardrobe.top)]:bottom;
   if(fitGarmentHem(upper,under,waist,rig.bodyHeight,center)){adjusted++;layeredIds.add(id);}
  }
  layeringReport??={affectedGarments:0,hiddenTriangles:0,inspectedTriangles:0,skippedMaterials:0,tuckedVertices:0};
  layeringReport.affectedGarments=layeredIds.size;layeringReport.hemAdjustedGarments=adjusted;
 }
 // Finish the tucked profile after hem clearance, which can otherwise push
 // covered shirt corners back outside the coat at the skirt waistband.
 if(layering===true&&wardrobe.outer){
  const outer=meshes.filter(m=>m.userData.garmentId===wardrobe.outer);
  const inner=meshes.filter(m=>beforeLayering.has(m));
  const {fitLayeredUpperGarments}=await import('./garmentCollar');
  const collar=fitLayeredUpperGarments(outer,inner,rig.skeleton,rig.bodyHeight,layeredBody??original,fitById.get(wardrobe.outer)!.autoHide);
  if(collar.bodyMask){layeredBody=collar.bodyMask;resources.push(layeredBody);}
  for(const {mesh,geometry} of collar.masks){mesh.geometry=geometry;resources.push(geometry);layeredIds.add(mesh.userData.garmentId);}
  // Report unique retained vertices and total removed faces across both passes.
  layeringReport!.hiddenTriangles=0;layeringReport!.tuckedVertices=0;layeringReport!.inspectedTriangles=0;
  for(const m of inner){
   const before=beforeLayering.get(m)!,after=m.geometry,p=before.attributes.position,q=after.attributes.position;
   layeringReport!.inspectedTriangles+=before.index!.count/3;
   layeringReport!.hiddenTriangles+=(before.index!.count-after.index!.count)/3;
   for(const i of new Set(Array.from(after.index!.array)))if(Math.abs(p.getX(i)-q.getX(i))+Math.abs(p.getY(i)-q.getY(i))+Math.abs(p.getZ(i)-q.getZ(i))>1e-6)layeringReport!.tuckedVertices++;
  }
  layeringReport!.affectedGarments=layeredIds.size;
 }
 const covered=(p:T.Vector3)=>{const x=Math.abs(p.x),y=bodyBaseY(p.y,rig.bodyHeight),z=p.z;
  return defs.some(d=>{
   const fit=fitById.get(d.id)!;
   if(manualCoverage(p,fit.hide,rig.bodyHeight))return true;
   if(!fit.autoHide)return false;
   // These shells follow the original body triangles. Mask boundary subdivision
   // interpolates rest positions and weights, which does not preserve their
   // posed surface under LBS (especially at shoulders); keep that body intact.
   // This also preserves the authored necklines, armholes and qipao slit.
   if(layeringForGarment(d.id).skin==='whole-surface'||d.sleeveOnly)return false;
   if(d.slot==='shoes')return shoeOpening>0&&y<shoeOpening-.055;
   if(d.slot==='socks')return y<(tops.get(d.id)??1.0)-.06&&(d.id!=='original-socks'||y>(hems.get(d.id)??.32)+.055);
   if(d.slot==='bottom')return y>Math.max(.05,(hems.get(d.id)??d.hem??1.82)+.12)&&y<Math.min(2.48,(tops.get(d.id)??2.48)-.04);
   if(d.slot!=='top'&&d.slot!=='outer'&&d.slot!=='onepiece')return false;
   if(d.id==='slouch-cardigan')return y>2.45&&y<3.0&&z<-.04&&x<.37;
   const hem=(hems.get(d.id)??2.42)+.10;
   const sourceBox=originalBounds.get(d.id)!;
   const sleeve=Math.min(1.44,.30+(Math.max(Math.abs(sourceBox.min.x),Math.abs(sourceBox.max.x))-.30)*fit.sleeveLength/100-.10);
   if(d.id==='hood-parka')return x>.46&&x<sleeve&&y>2.84&&y<3.40;
   if(x>.34&&y>2.84&&y<3.40)return !d.sleeveless&&x<sleeve;
   if(y<Math.max(2.12,hem)||y>3.24)return false;
   if(d.open&&z>-.025&&x<.22)return false;
   return x<.43;
  });
 };
 // A skinned edge cannot be split by averaging rest positions and weights:
 // its new midpoint does not stay on the original posed edge. Preserve whole
 // boundary faces for legs as well as shoulders, keeping skin under openings.
 const masked=createClothingMask(layeredBody??original,covered,-Infinity);resources.push(masked);
 let motionFit:import('./garmentMotionFit').GarmentMotionFit|undefined;
 if(layering&&wardrobe.outer){
  const inner=meshes.filter(m=>[wardrobe.top,wardrobe.onepiece].includes(m.userData.garmentId)&&usesPosedInnerFit(m.userData.garmentId));
  if(inner.length){const {createGarmentMotionFit}=await import('./garmentMotionFit');motionFit=createGarmentMotionFit(rig,meshes.filter(m=>m.userData.garmentId===wardrobe.outer),inner);if(motionFit)resources.push(motionFit);}
 }
 const lift=Math.max(0,...defs.map(d=>bodyHeightY(d.groundOffset??0,rig.bodyHeight))),parent=rig.mesh.parent!;
 // Motion writes this same group's position. Keep the footwear contribution
 // explicit so walking cannot erase it and seated removal restores only what
 // is still applied, rather than subtracting the original standing lift.
 const support={height:lift,applied:lift};
 let disposed=false,attached=false;const result={meshes,layeringReport,updatePose(){if(attached&&!disposed)motionFit?.update();},attach(){if(disposed||attached)return;attached=true;meshes.forEach(m=>parent.add(m));rig.mesh.geometry=masked;parent.userData.wardrobeLift=support;parent.position.y+=lift;},updateColors(value:WardrobeColors={}){if(disposed)return;const clean=cleanWardrobeColors(value);colorControllers.forEach(c=>c.update(clean[c.id]));},dispose(){if(disposed)return;disposed=true;if(rig.mesh.geometry===masked)rig.mesh.geometry=original;if(parent.userData.wardrobeLift===support){parent.position.y-=support.applied;delete parent.userData.wardrobeLift;}meshes.forEach(m=>m.removeFromParent());resources.forEach(r=>r.dispose());}};

 result.updateColors(colors);
 return result;
 }catch(e){meshes.forEach(m=>m.removeFromParent());resources.forEach(r=>r.dispose());throw e;}
}
/** Convenience entry for a newly created visitor; the preview stages swaps first. */
export async function dressApprovedWardrobe(...args:Parameters<typeof prepareApprovedWardrobe>){const outfit=await prepareApprovedWardrobe(...args);outfit.attach();return outfit;}
