import {describe,it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {createLayeredClothingMasks} from '../apps/room3d/chibi/garmentLayering';
import {createBlankBody} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {dressApprovedWardrobe} from '../apps/room3d/chibi/approvedClothing';
import {createWardrobePose} from '../experiments/chibi/wardrobePose';
import {MeshBVH} from 'three-mesh-bvh';

function plane(x=0,z=.4,width=1.2,material=new T.MeshStandardMaterial()){
 const geometry=new T.PlaneGeometry(width,1.2,12,12);geometry.translate(x,2.8,z);
 const count=geometry.attributes.position.count;
 geometry.setAttribute('skinIndex',new T.Uint16BufferAttribute(new Uint16Array(count*4),4));
 const weights=new Float32Array(count*4);for(let i=0;i<count;i++)weights[i*4]=1;
 geometry.setAttribute('skinWeight',new T.Float32BufferAttribute(weights,4));
 const mesh=new T.SkinnedMesh(geometry,material);mesh.userData.garmentId='inner';return mesh;
}
function skeleton(name='chest'){const bone=new T.Bone();bone.name=name;bone.position.set(0,3,0);bone.updateMatrixWorld();return new T.Skeleton([bone]);}
function sleeveRig(){
 const upper=new T.Bone(),hand=new T.Bone();upper.name='L_upperArm';hand.name='L_hand';upper.position.set(.3,3,0);hand.position.set(1.6,3,0);upper.updateMatrixWorld();hand.updateMatrixWorld();return new T.Skeleton([upper,hand]);
}
function tube(length:number,radius:number,wristWeighted=false,openSide=false){
 const g=new T.CylinderGeometry(radius,radius,length,32,32,true,0,openSide?Math.PI:Math.PI*2);g.rotateZ(-Math.PI/2);g.translate(.95,3,0);
 const count=g.attributes.position.count,ids=new Uint16Array(count*4),weights=new Float32Array(count*4);
 for(let i=0;i<count;i++){ids[i*4]=wristWeighted?1:0;weights[i*4]=1;}
 g.setAttribute('skinIndex',new T.Uint16BufferAttribute(ids,4));g.setAttribute('skinWeight',new T.Float32BufferAttribute(weights,4));
 return new T.SkinnedMesh(g,new T.MeshStandardMaterial());
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('bone-directed layering masks',()=>{
 it('preserves the long skirt silhouette outside a narrower coat instead of deleting it along diagonal rays',()=>{
  const skirt=plane(0,.6,1.4),outer=plane(0,.25,.6);skirt.userData.garmentId='lower-long-skirt';const source=skirt.geometry;
  const result=createLayeredClothingMasks([outer],[skirt],skeleton());expect(result.report.hiddenTriangles).toBeGreaterThan(0);
  const fitted=result.masks[0].geometry,visible=new Set<string>();for(let i=0;i<fitted.index!.count;i+=3)visible.add([0,1,2].map(j=>fitted.index!.getX(i+j)).join(','));
  let exposedFaces=0;
  for(let i=0;i<source.index!.count;i+=3){const ids=[0,1,2].map(j=>source.index!.getX(i+j));if(ids.some(id=>Math.abs(source.attributes.position.getX(id))>.38)){expect(visible.has(ids.join(','))).toBe(true);exposedFaces++;}}
  for(let i=0;i<source.attributes.position.count;i++)if(Math.abs(source.attributes.position.getX(i))>.38)expect(fitted.attributes.position.getZ(i)).toBe(source.attributes.position.getZ(i));
  expect(exposedFaces).toBeGreaterThan(50);expect(fitted.attributes.position.count).toBe(source.attributes.position.count);
  for(const key of ['skinIndex','skinWeight','uv'])expect(Array.from(fitted.attributes[key].array)).toEqual(Array.from(source.attributes[key].array));
 });
 it('removes covered and mildly protruding inner faces without modifying source vertices, skinning, UVs or outer indices',()=>{
  const inner=plane(0,.43),outer=plane(),originalIndex=Array.from(inner.geometry.index!.array),outerIndex=Array.from(outer.geometry.index!.array);
  const attributes=Object.fromEntries(Object.entries(inner.geometry.attributes).map(([key,value])=>[key,Array.from(value.array)]));
  const result=createLayeredClothingMasks([outer],[inner],skeleton());
  expect(result.report.hiddenTriangles).toBeGreaterThan(50);expect(result.report.affectedGarments).toBe(1);
  expect(Array.from(inner.geometry.index!.array)).toEqual(originalIndex);expect(Array.from(outer.geometry.index!.array)).toEqual(outerIndex);
  const masked=result.masks[0].geometry;
  for(const [key,data] of Object.entries(attributes)){if(!['position','normal'].includes(key))expect(Array.from(masked.attributes[key].array)).toEqual(data);expect(Array.from(inner.geometry.attributes[key].array)).toEqual(data);}
  expect(masked.attributes.position.count).toBe(inner.geometry.attributes.position.count);
  expect(masked.index!.count).toBeLessThan(originalIndex.length);expect(masked.index!.count).toBeGreaterThan(0);
 });
 it('keeps the exposed inner shirt in an open placket, and retains triangles crossing its edge',()=>{
  const inner=plane(0,.43),outer=[plane(-.37,.4,.42),plane(.37,.4,.42)],source=inner.geometry;
  const result=createLayeredClothingMasks(outer,[inner],skeleton());expect(result.report.hiddenTriangles).toBeGreaterThan(0);
  const visible=Array.from(result.masks[0].geometry.index!.array),positions=source.attributes.position;
  for(let i=0;i<source.index!.count;i+=3){const ids=[0,1,2].map(j=>source.index!.getX(i+j));if(ids.some(id=>Math.abs(positions.getX(id))<.16))expect(visible.join(',' )).toContain(ids.join(','));}
  const fitted=result.masks[0].geometry.attributes.position;
  expect(result.report.tuckedVertices).toBeGreaterThan(0);
  for(const id of new Set(visible)){
   expect(fitted.getX(id)).toBe(positions.getX(id));expect(fitted.getY(id)).toBe(positions.getY(id));
   if(Math.abs(positions.getX(id))<.16)expect(fitted.getZ(id)).toBe(positions.getZ(id));
   else if(Math.abs(positions.getX(id))<.55)expect(fitted.getZ(id)).toBeLessThan(.4);
  }
 });
 it('masks skin using original whole faces without moving it or hiding hand-weighted vertices',()=>{
  const skin=plane(0,.39),source=skin.geometry,result=createLayeredClothingMasks([plane()],[skin],skeleton(),1,true);
  expect(result.report.hiddenTriangles).toBeGreaterThan(0);expect(result.report.tuckedVertices).toBe(0);
  for(const key of Object.keys(source.attributes))expect(Array.from(result.masks[0].geometry.attributes[key].array)).toEqual(Array.from(source.attributes[key].array));
  expect(createLayeredClothingMasks([tube(1,.3)],[tube(1.5,.25,true)],sleeveRig(),1,true).masks).toHaveLength(0);
 });
 it('keeps tucked corners above skin that remains visible at an opening',()=>{
  const inner=plane(0,.43),skin=plane(0,.38).geometry,result=createLayeredClothingMasks([plane()],[inner],skeleton(),1,false,skin);
  const g=result.masks[0].geometry;expect(result.report.tuckedVertices).toBeGreaterThan(0);
  for(const i of new Set(Array.from(g.index!.array)))expect(g.attributes.position.getZ(i)).toBeGreaterThan(.39);
 });
 it.each([1,-1])('protects skin between cloth corners on depth side %s without undoing the entire tuck',sign=>{
  const inner=plane(),g=inner.geometry;
  g.setAttribute('position',new T.Float32BufferAttribute([-.4,2.5,.5*sign,.4,2.5,.5*sign,.8,3.2,.5*sign],3));g.setIndex([0,1,2]);
  const skin=new T.PlaneGeometry(.10,.10);skin.translate(.8/3,(2.5+2.5+3.2)/3,.42*sign);
  const before=Array.from(skin.attributes.position.array),result=createLayeredClothingMasks([plane(0,.4*sign)],[inner],skeleton(),1,false,skin);
  const p=result.masks[0].geometry.attributes.position;
  expect((p.getZ(0)+p.getZ(1)+p.getZ(2))/3*sign).toBeGreaterThanOrEqual(.4379);
  expect(p.getZ(0)*sign).toBeLessThan(.49);expect(p.getZ(2)).toBeCloseTo(.5*sign);
  expect(result.masks[0].geometry.index!.count).toBe(3);expect(Array.from(skin.attributes.position.array)).toEqual(before);
 });
 it('does not hide neck/hand vertices, transparent outerwear or distant overlaps',()=>{
  for(const [outer,rig] of [[plane(),skeleton('neck')],[plane(),skeleton('L_hand')],[plane(0,.4,1.2,new T.MeshStandardMaterial({transparent:true,opacity:.5})),skeleton()],[plane(0,.4,1.2,new T.MeshStandardMaterial({map:new T.Texture()})),skeleton()],[plane(0,1.5),skeleton()]] as const){
   const result=createLayeredClothingMasks([outer],[plane(0,.43)],rig);expect(result.report.hiddenTriangles).toBe(0);expect(result.masks).toHaveLength(0);
  }
 });
 it('is independent of the current animated bone pose and retains material groups',()=>{
  const inner=plane(0,.43),rig=skeleton();inner.geometry.clearGroups();inner.geometry.addGroup(0,216,0);inner.geometry.addGroup(216,648,1);
  const a=createLayeredClothingMasks([plane()],[inner],rig);
  rig.bones[0].rotation.x=.8;rig.bones[0].updateMatrixWorld();rig.update();
  const b=createLayeredClothingMasks([plane()],[inner],rig);
  expect(Array.from(a.masks[0].geometry.index!.array)).toEqual(Array.from(b.masks[0].geometry.index!.array));
  expect(a.masks[0].geometry.groups.map(g=>g.materialIndex)).toEqual([0,1]);
  expect(a.masks[0].geometry.groups.reduce((n,g)=>n+g.count,0)).toBe(a.masks[0].geometry.index!.count);
 });
 it('hides a continuous inner sleeve through deep folds, including wrist-weighted cloth, while preserving exposed cuffs',()=>{
  const inner=tube(1.5,.45,true),outer=tube(1,.3),p=outer.geometry.attributes.position;
  for(let i=0;i<p.count;i++){const fold=1+.30*Math.sin(p.getX(i)*90);p.setY(i,3+(p.getY(i)-3)*fold);p.setZ(i,p.getZ(i)*fold);}
  const result=createLayeredClothingMasks([outer],[inner],sleeveRig());
  expect(result.masks).toHaveLength(1);
  const visible=Array.from(result.masks[0].geometry.index!.array),g=inner.geometry;
  let buried=0,cuffs=0;
  for(let i=0;i<g.index!.count;i+=3){
   const ids=[0,1,2].map(j=>g.index!.getX(i+j)),xs=ids.map(id=>g.attributes.position.getX(id)),present=visible.join(',').includes(ids.join(','));
   if(xs.every(x=>x>.65&&x<1.25)){expect(present).toBe(false);buried++;}
   if(xs.every(x=>x>1.5)){expect(present).toBe(true);cuffs++;}
  }
  expect(buried).toBeGreaterThan(100);expect(cuffs).toBeGreaterThan(50);
 });
 it('does not infer a closed sleeve across a slit or transparent cloth',()=>{
  for(const outer of [tube(1,.3,false,true),tube(1,.3)]){
   if(!outer.geometry.parameters.thetaLength||(outer.geometry.parameters.thetaLength===Math.PI*2))outer.material.transparent=true;
   expect(createLayeredClothingMasks([outer],[tube(1.5,.45,true)],sleeveRig()).masks).toHaveLength(0);
  }
 });
 it('follows a shortened outer cuff instead of hiding the exposed inner forearm',()=>{
  const inner=tube(1.5,.45,true),result=createLayeredClothingMasks([tube(.5,.3)],[inner],sleeveRig());
  const visible=new Set(Array.from(result.masks[0].geometry.index!.array)),p=inner.geometry.attributes.position;
  for(let i=0;i<p.count;i++)if(p.getX(i)>1.3)expect(visible.has(i)).toBe(true);
 });
});

describe('shipped wardrobe layering integration',()=>{
 it('keeps the actual long skirt continuous outside the cardigan silhouette in the standing pose',async()=>{
  vi.stubGlobal('self',globalThis);vi.stubGlobal('createImageBitmap',async()=>({width:1,height:1,close(){}}));
  vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');});
  const body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial()),hair=new T.Group(),root=new T.Group();root.add(body,hair);const rig=bindBlankBody(body,hair,true),items={top:'sailor-short',outer:'slouch-cardigan',bottom:'lower-long-skirt'};
  const mixer=new T.AnimationMixer(root);mixer.clipAction(createWardrobePose(rig,'normal')).play();mixer.setTime(.7);
  const snapshot=(meshes:T.SkinnedMesh[])=>{root.updateMatrixWorld(true);rig.skeleton.update();return meshes.map(m=>{const g=m.geometry.clone(),p=g.attributes.position,v=new T.Vector3();for(let i=0;i<p.count;i++){m.applyBoneTransform(i,v.fromBufferAttribute(p,i));p.setXYZ(i,v.x,v.y,v.z);}return {g,tree:new MeshBVH(g,{indirect:true})};});};
  const original=await dressApprovedWardrobe(rig,items),skirt=snapshot(original.meshes.filter(m=>m.userData.garmentId===items.bottom)),coat=snapshot(original.meshes.filter(m=>m.userData.garmentId===items.outer));original.dispose();
  const next=await dressApprovedWardrobe(rig,items,{},{},true),after=snapshot(next.meshes.filter(m=>m.userData.garmentId===items.bottom));
  const ray=new T.Ray(new T.Vector3(),new T.Vector3(0,0,-1)),hit=(trees:typeof skirt)=>trees.some(q=>q.tree.raycastFirst(ray,T.DoubleSide));let inspected=0,holes=0;
  for(let x=-.65;x<=.65;x+=.01)for(let y=1.7;y<=2.2;y+=.01){if(Math.abs(x)<.4)continue;ray.origin.set(x,y,8);if(!hit(skirt)||hit(coat))continue;inspected++;if(!hit(after))holes++;}
  expect(inspected).toBeGreaterThan(100);expect(holes).toBe(0);
  [...skirt,...coat,...after].forEach(q=>q.g.dispose());next.dispose();mixer.stopAllAction();
 });
 it.each(['basic-tee','fitted-sweater','fitted-turtleneck'])('does not expose new shoulder/chest skin through %s in the approved standing pose',async top=>{
  vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');});
  const body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial()),hair=new T.Group(),root=new T.Group();root.add(body,hair);const rig=bindBlankBody(body,hair,true);
  const mixer=new T.AnimationMixer(root);mixer.clipAction(createWardrobePose(rig,'normal')).play();mixer.setTime(.7);
  const snapshot=(meshes:T.SkinnedMesh[])=>{root.updateMatrixWorld(true);rig.skeleton.update();return meshes.filter(m=>m.geometry.index!.count>0).map(mesh=>{const g=mesh.geometry.clone(),p=g.attributes.position,v=new T.Vector3();for(let i=0;i<p.count;i++){mesh.getVertexPosition(i,v).applyMatrix4(mesh.matrixWorld);p.setXYZ(i,v.x,v.y,v.z);}return {g,tree:new MeshBVH(g,{indirect:true})};});};
  const original=await dressApprovedWardrobe(rig,{top,outer:'slouch-cardigan'}),before=snapshot(original.meshes);original.dispose();
  const layered=await dressApprovedWardrobe(rig,{top,outer:'slouch-cardigan'},{},{},true),after=snapshot(layered.meshes),skin=snapshot([rig.mesh])[0];
  let exposed=0,inspected=0;const ray=new T.Ray(new T.Vector3(),new T.Vector3(0,0,-1));
  const depth=(trees:typeof before)=>Math.min(Infinity,...trees.map(t=>t.tree.raycastFirst(ray,T.DoubleSide)?.distance??Infinity));
  for(let x=-.45;x<=.45;x+=.015)for(let y=2.85;y<=3.45;y+=.015){ray.origin.set(x,y,8);const skinDepth=depth([skin]);if(!Number.isFinite(skinDepth)||depth(before)>=skinDepth-.003)continue;inspected++;if(depth(after)>skinDepth+.001)exposed++;}
  expect(inspected).toBeGreaterThan(20);expect(exposed).toBe(0);
  [...before,...after,skin].forEach(t=>t.g.dispose());layered.dispose();mixer.stopAllAction();
 });
 it('tucks the stand-collar torso without changing its cuff, the outer shell or cached source, and restores it exactly',async()=>{
  vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');});
  const body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial()),hair=new T.Group(),root=new T.Group();root.add(body,hair);const rig=bindBlankBody(body,hair,true);
  const items={top:'stand-collar',outer:'slouch-cardigan'},base=await dressApprovedWardrobe(rig,items),source=base.meshes.map(m=>m.geometry.clone());base.dispose();
  const next=await dressApprovedWardrobe(rig,items,{},{},true);expect(next.layeringReport!.tuckedVertices).toBeGreaterThan(20);
  next.meshes.forEach((m,k)=>{
   const original=source[k],p=m.geometry.attributes.position;
   for(const key of ['skinIndex','skinWeight','uv'])if(original.attributes[key])expect(Array.from(m.geometry.attributes[key].array)).toEqual(Array.from(original.attributes[key].array));
   for(let i=0;i<p.count;i++)if(m.userData.garmentId===items.outer||Math.abs(original.attributes.position.getX(i))>1.5)expect([p.getX(i),p.getY(i),p.getZ(i)]).toEqual([original.attributes.position.getX(i),original.attributes.position.getY(i),original.attributes.position.getZ(i)]);
  });
  next.dispose();expect(rig.mesh.geometry).toBe(rig.baseGeometry);
  const restored=await dressApprovedWardrobe(rig,items);restored.meshes.forEach((m,k)=>{expect(Array.from(m.geometry.attributes.position.array)).toEqual(Array.from(source[k].attributes.position.array));expect(Array.from(m.geometry.index!.array)).toEqual(Array.from(source[k].index!.array));});restored.dispose();source.forEach(g=>g.dispose());
 });
 it('keeps the sailor cuffs and clears the middle of both sleeves under the folded cardigan',async()=>{
  vi.stubGlobal('self',globalThis);vi.stubGlobal('createImageBitmap',async()=>({width:1,height:1,close(){}}));
  vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async function(url){
   const file=String(url).split('/').pop()!.split('?')[0],bytes=readFileSync(`public/room3d/wardrobe/${file}`);
   return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  });
  const body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial()),hair=new T.Group(),root=new T.Group();root.add(body,hair);const rig=bindBlankBody(body,hair,true);
  const items={top:'sailor-long',outer:'slouch-cardigan'},base=await dressApprovedWardrobe(rig,items);
  const inner=base.meshes.filter(m=>m.userData.garmentId===items.top),outer=base.meshes.filter(m=>m.userData.garmentId===items.outer);
  const bodyPositions=Array.from(rig.mesh.geometry.attributes.position.array),result=createLayeredClothingMasks(outer,inner,rig.skeleton);
  let buried=0,cuffs=0;
  for(const mesh of inner){
   const g=mesh.geometry,masked=result.masks.find(m=>m.mesh===mesh)?.geometry??g,faces=new Set<string>();
   for(let i=0;i<masked.index!.count;i+=3)faces.add([0,1,2].map(j=>masked.index!.getX(i+j)).join(','));
   for(let i=0;i<g.index!.count;i+=3){
    const ids=[0,1,2].map(j=>g.index!.getX(i+j)),xs=ids.map(id=>Math.abs(g.attributes.position.getX(id)));
    if(xs.every(x=>x>.7&&x<1.45)){expect(faces.has(ids.join(','))).toBe(false);buried++;}
    if(xs.every(x=>x>1.6)){expect(faces.has(ids.join(','))).toBe(true);cuffs++;}
   }
  }
  expect(buried).toBeGreaterThan(50);expect(cuffs).toBeGreaterThan(100);
  expect(result.report.hiddenTriangles).toBeGreaterThan(0);expect(Array.from(rig.mesh.geometry.attributes.position.array)).toEqual(bodyPositions);
  result.masks.forEach(m=>m.geometry.dispose());base.dispose();
 });
 it.each(['school-blazer','hood-parka','slouch-cardigan','belt-coat'])('masks a real shirt under %s, restores on removal, and preserves every outer vertex',async outerId=>{
  vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async function(url){
   const file=String(url).split('/').pop()!.split('?')[0],bytes=readFileSync(`public/room3d/wardrobe/${file}`);
   return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  });
  const body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial()),hair=new T.Group(),root=new T.Group();root.add(body,hair);const rig=bindBlankBody(body,hair,true);
  const items={top:'fitted-sweater',outer:outerId},base=await dressApprovedWardrobe(rig,items);
  const counts=base.meshes.filter(m=>m.userData.garmentId===items.top).map(m=>m.geometry.index!.count);
  const outer=base.meshes.filter(m=>m.userData.garmentId===items.outer).map(m=>Array.from(m.geometry.attributes.position.array));base.dispose();
  const layered=await dressApprovedWardrobe(rig,items,{}, {},true);
  expect(layered.layeringReport!.hiddenTriangles).toBeGreaterThan(0);
  expect(layered.meshes.filter(m=>m.userData.garmentId===items.outer).map(m=>Array.from(m.geometry.attributes.position.array))).toEqual(outer);
  layered.dispose();
  const restored=await dressApprovedWardrobe(rig,{top:items.top},{},{},true);
  expect(restored.meshes.map(m=>m.geometry.index!.count)).toEqual(counts);expect(restored.layeringReport).toBeUndefined();restored.dispose();
  const again=await dressApprovedWardrobe(rig,items);expect(again.meshes.filter(m=>m.userData.garmentId===items.top).map(m=>m.geometry.index!.count)).toEqual(counts);again.dispose();
 });
});
