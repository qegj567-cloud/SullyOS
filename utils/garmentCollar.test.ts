import {afterEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshBVH} from 'three-mesh-bvh';
import {createBlankBody} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {dressApprovedWardrobe} from '../apps/room3d/chibi/approvedClothing';
import {fitLayeredUpperGarments} from '../apps/room3d/chibi/garmentCollar';
import {createWardrobePose} from '../test/fixtures/legacyWardrobePose';
import {garmentLayeringAssignments} from '../apps/room3d/chibi/wardrobeLayering';

function fixture(standing:'normal'|'boy'|'cute'='normal'){
 vi.stubGlobal('self',globalThis);vi.stubGlobal('createImageBitmap',async()=>({width:1,height:1,close(){}}));
 vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');});
 const root=new T.Group(),body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial()),hair=new T.Group();root.add(body,hair);
 const rig=bindBlankBody(body,hair,true),mixer=new T.AnimationMixer(root);mixer.clipAction(createWardrobePose(rig,standing)).play();mixer.setTime(.7);
 const snapshot=(meshes:T.SkinnedMesh[])=>{root.updateMatrixWorld(true);rig.skeleton.update();return meshes.filter(m=>m.geometry.index!.count).map(m=>{
  const g=m.geometry.clone(),p=g.attributes.position,v=new T.Vector3();for(let i=0;i<p.count;i++){m.getVertexPosition(i,v).applyMatrix4(m.matrixWorld);p.setXYZ(i,v.x,v.y,v.z);}return {g,tree:new MeshBVH(g,{indirect:true})};
 });};
 return {rig,root,mixer,snapshot,dispose(){mixer.stopAllAction();rig.baseGeometry.dispose();body.material.dispose();rig.skeleton.dispose();}};
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('posed upper-garment layering',()=>{
 it('applies the same posed corrections when new garment IDs reuse existing construction profiles',async()=>{
  const f=fixture(),outfit=await dressApprovedWardrobe(f.rig,{top:'collar-shirt',outer:'belt-coat'});
  const outer=outfit.meshes.filter(m=>m.userData.garmentId==='belt-coat'),inner=outfit.meshes.filter(m=>m.userData.garmentId==='collar-shirt');
  const baseline=fitLayeredUpperGarments(outer,inner,f.rig.skeleton,1,f.rig.baseGeometry);
  garmentLayeringAssignments['new-shirt']='loose-shirt';garmentLayeringAssignments['new-coat']='posed-outer';
  try{
   inner.forEach(m=>m.userData.garmentId='new-shirt');outer.forEach(m=>m.userData.garmentId='new-coat');
   const result=fitLayeredUpperGarments(outer,inner,f.rig.skeleton,1,f.rig.baseGeometry);
   try{
    expect(result.masks.length).toBeGreaterThan(0);
    expect(result.masks.map(m=>Array.from(m.geometry.attributes.position.array))).toEqual(baseline.masks.map(m=>Array.from(m.geometry.attributes.position.array)));
    expect(result.masks.map(m=>Array.from(m.geometry.index!.array))).toEqual(baseline.masks.map(m=>Array.from(m.geometry.index!.array)));
   }finally{result.masks.forEach(m=>m.geometry.dispose());result.bodyMask?.dispose();}
  }finally{
   delete garmentLayeringAssignments['new-shirt'];delete garmentLayeringAssignments['new-coat'];
   baseline.masks.forEach(m=>m.geometry.dispose());baseline.bodyMask?.dispose();outfit.dispose();f.dispose();
  }
 });
 it.each(['sailor-long','sailor-short','collar-shirt','stand-collar'].flatMap(top=>[
  ...['hood-parka','school-blazer','belt-coat'].map(outer=>({top,outer,pose:'normal' as const})),
  ...(['boy','cute'] as const).map(pose=>({top,outer:'belt-coat',pose})),
 ]))('keeps the back of $top inside $outer in $pose after skirt hem clearance',async items=>{
  const f=fixture(items.pose),outfit=await dressApprovedWardrobe(f.rig,{top:items.top,outer:items.outer,bottom:'lower-long-skirt'},{},{},true);
  const inner=f.snapshot(outfit.meshes.filter(m=>m.userData.garmentId===items.top)),outer=f.snapshot(outfit.meshes.filter(m=>m.userData.garmentId===items.outer));
  // Exposed forearm cuffs can move in front of the torso in bent-arm poses;
  // they are intentional visible cloth, not part of this back-panel check.
  for(const q of [...inner]){
   const g=q.g,ids:number[]=[],cuff=(i:number)=>[0,1,2,3].reduce((sum,j)=>sum+(/^[LR]_(forearm|twist|hand)/.test(f.rig.skeleton.bones[g.attributes.skinIndex.getComponent(i,j)].name)?g.attributes.skinWeight.getComponent(i,j):0),0)>.5;
   for(let t=0;t<g.index!.count;t+=3){const face=[0,1,2].map(j=>g.index!.getX(t+j));if(!face.every(cuff))ids.push(...face);}
   if(!ids.length){g.dispose();inner.splice(inner.indexOf(q),1);continue;}
   g.setIndex(ids);g.clearGroups();q.tree=new MeshBVH(g,{indirect:true});
  }
  const ray=new T.Ray(new T.Vector3(),new T.Vector3(0,0,1)),depth=(queries:typeof inner)=>Math.min(Infinity,...queries.map(q=>q.tree.raycastFirst(ray,T.DoubleSide)?.distance??Infinity));
  let leaks=0;
  for(let x=-.60;x<=.60;x+=.012)for(let y=2.38;y<=3.30;y+=.012){
   ray.origin.set(x,y,-8);const a=depth(inner),b=depth(outer);
   // Bent arms bring intentionally exposed cuffs into this torso window.
   // In those poses count penetration through the coat, not empty-space cuffs.
   if((items.pose==='normal'||Number.isFinite(b))&&a<b-.001)leaks++;
  }
  expect(leaks).toBeLessThan(10);
  [...inner,...outer].forEach(q=>q.g.dispose());outfit.dispose();f.dispose();
 });
 it.each(['sailor-long','sailor-short','collar-shirt','stand-collar'].flatMap(top=>['hood-parka','school-blazer','belt-coat'].map(outer=>({top,outer}))))('fits $top under $outer while preserving the front opening and outer shape',async items=>{
  const f=fixture(),base=await dressApprovedWardrobe(f.rig,items),sources=base.meshes.map(m=>m.geometry.clone());base.dispose();
  const outfit=await dressApprovedWardrobe(f.rig,items,{},{},true),inner=f.snapshot(outfit.meshes.filter(m=>m.userData.garmentId===items.top)),outer=f.snapshot(outfit.meshes.filter(m=>m.userData.garmentId===items.outer)),skin=f.snapshot([f.rig.mesh]);
  const ray=new T.Ray(new T.Vector3(),new T.Vector3(0,0,-1)),depth=(queries:typeof inner)=>Math.min(Infinity,...queries.map(q=>q.tree.raycastFirst(ray,T.DoubleSide)?.distance??Infinity));
  let overlaps=0,opening=0;
  for(let x=-.65;x<=.65;x+=.012)for(let y=3.10;y<=3.38;y+=.012){if(Math.abs(x)<.30)continue;ray.origin.set(x,y,8);const a=depth(inner),b=depth(outer);if(Number.isFinite(b)&&a<b-.001)overlaps++;}
  for(let x=-.10;x<=.10;x+=.02)for(let y=3.00;y<=3.25;y+=.02){ray.origin.set(x,y,8);if(depth(inner)<depth(outer))opening++;}
  expect(overlaps).toBeLessThan(20);expect(opening).toBeGreaterThan(50);
  // The exposed middle of the neck remains, independent of the shoulder mask.
  ray.origin.set(0,3.36,8);expect(depth(skin)).toBeLessThan(Infinity);
  outfit.meshes.forEach((m,k)=>{
   const before=sources[k],g=m.geometry;expect(g.attributes.position.count).toBe(before.attributes.position.count);
   for(const key of ['skinIndex','skinWeight','uv'])if(before.attributes[key])expect(Array.from(g.attributes[key].array)).toEqual(Array.from(before.attributes[key].array));
   if(m.userData.garmentId===items.outer)expect(Array.from(g.attributes.position.array)).toEqual(Array.from(before.attributes.position.array));
   else for(let i=0;i<before.attributes.position.count;i++)if(Math.abs(before.attributes.position.getX(i))>1.3)expect(new T.Vector3().fromBufferAttribute(g.attributes.position,i).toArray()).toEqual(new T.Vector3().fromBufferAttribute(before.attributes.position,i).toArray());
  });
  for(let i=f.rig.baseGeometry.attributes.position.count;i<f.rig.mesh.geometry.attributes.position.count;i++)expect(f.rig.mesh.geometry.attributes.position.getY(i)).toBeLessThan(3);
  [...inner,...outer,...skin].forEach(q=>q.g.dispose());outfit.dispose();
  const restored=await dressApprovedWardrobe(f.rig,items);restored.meshes.forEach((m,k)=>expect(Array.from(m.geometry.attributes.position.array)).toEqual(Array.from(sources[k].attributes.position.array)));restored.dispose();sources.forEach(g=>g.dispose());f.dispose();
 });
 it('does not touch the live rig, and leaves transparent outerwear and the approved cardigan alone',async()=>{
  const f=fixture(),outfit=await dressApprovedWardrobe(f.rig,{top:'sailor-long',outer:'hood-parka'}),outer=outfit.meshes.filter(m=>m.userData.garmentId==='hood-parka'),inner=outfit.meshes.filter(m=>m.userData.garmentId==='sailor-long');
  f.mixer.stopAllAction();f.rig.bones.R_upperArm.rotation.set(-.5,.2,.6);f.root.updateMatrixWorld(true);f.rig.skeleton.update();
  const rotations=f.rig.skeleton.bones.map(b=>b.quaternion.toArray()),matrices=Array.from(f.rig.skeleton.boneMatrices!);
  const result=fitLayeredUpperGarments(outer,inner,f.rig.skeleton,1,f.rig.baseGeometry,false);expect(result.masks.length).toBeGreaterThan(0);expect(result.bodyMask).toBeUndefined();
  expect(f.rig.skeleton.bones.map(b=>b.quaternion.toArray())).toEqual(rotations);expect(Array.from(f.rig.skeleton.boneMatrices!)).toEqual(matrices);
  f.rig.bones.R_upperArm.rotation.set(0,0,0);
  const second=fitLayeredUpperGarments(outer,inner,f.rig.skeleton,1,f.rig.baseGeometry,false);
  expect(second.masks.map(m=>Array.from(m.geometry.attributes.position.array))).toEqual(result.masks.map(m=>Array.from(m.geometry.attributes.position.array)));
  [...result.masks,...second.masks].forEach(m=>m.geometry.dispose());
  const material=Array.isArray(outer[0].material)?outer[0].material[0]:outer[0].material;material.transparent=true;
  expect(fitLayeredUpperGarments(outer,inner,f.rig.skeleton,1,f.rig.baseGeometry).masks).toHaveLength(0);material.transparent=false;
  outer.forEach(m=>m.userData.garmentId='slouch-cardigan');expect(fitLayeredUpperGarments(outer,inner,f.rig.skeleton,1,f.rig.baseGeometry).masks).toHaveLength(0);
  outfit.dispose();f.dispose();
 });
});
