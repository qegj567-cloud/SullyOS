import {afterEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshBVH} from 'three-mesh-bvh';
import {createBlankBody} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {createBlankMotion} from '../apps/room3d/chibi/blankMotion';
import {dressApprovedWardrobe} from '../apps/room3d/chibi/approvedClothing';

// Load the shipped geometry, skin and scene placement in Node. Image decoding
// is irrelevant to this regression; replace materials, not the real mesh data.
function loadLocalAssets(){
 vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{
  const file=String(url).split('/').pop()!.split('?')[0];
  const bytes=readFileSync(`public/room3d/wardrobe/${file}`),oldLength=bytes.readUInt32LE(12);
  const doc=JSON.parse(bytes.subarray(20,20+oldLength).toString()),binary=bytes.subarray(28+oldLength);
  doc.images=[];doc.textures=[];doc.materials=[{pbrMetallicRoughness:{baseColorFactor:[1,1,1,1]}}];
  for(const mesh of doc.meshes)for(const primitive of mesh.primitives)primitive.material=0;
  const json=Buffer.from(JSON.stringify(doc)),length=Math.ceil(json.length/4)*4,out=Buffer.alloc(28+length+binary.length);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(length,12);out.writeUInt32LE(0x4e4f534a,16);out.fill(32,20,20+length);json.copy(out,20);out.writeUInt32LE(binary.length,20+length);out.writeUInt32LE(0x004e4942,24+length);binary.copy(out,28+length);
  return new GLTFLoader().parseAsync(out.buffer.slice(out.byteOffset,out.byteOffset+out.length),'');
 });
}
function makeRig(height=1){
 const root=new T.Group(),hair=new T.Group(),body=new T.Mesh(createBlankBody('skin',{bodyHeight:height,headSize:1.04}),Array(6).fill(new T.MeshBasicMaterial()));root.add(body,hair);
 return {root,rig:bindBlankBody(body,hair,true)};
}
const referenced=(g:T.BufferGeometry)=>new Set(Array.from(g.index!.array));
afterEach(()=>vi.restoreAllMocks());

describe('footwear on the current body',()=>{
 it.each([.8,1,1.25])('keeps the school sock rim outside skin after lengthening at height %s',async height=>{
  loadLocalAssets();const {rig}=makeRig(height);
  const query=rig.baseGeometry.clone(),tree=new MeshBVH(query),ray=new T.Ray();
  try{for(const length of [100,117,135]){
   const outfit=await dressApprovedWardrobe(rig,{socks:'school-socks'},{'school-socks':{length}}),sock=outfit.meshes[0],p=sock.geometry.attributes.position;
   const top=Math.max(...Array.from({length:p.count},(_,i)=>p.getY(i))),rim=Array.from({length:p.count},(_,i)=>i).filter(i=>Math.abs(p.getY(i)-top)<1e-5);
   expect(rim.length).toBeGreaterThan(40);
   // Test rim edge interiors as well: clearing vertices alone left little
   // rectangular exposed patches where the coarse sock chords cut the calf.
   const rimSet=new Set(rim),ix=sock.geometry.index!;
   for(let k=0;k<ix.count;k+=3)for(let j=0;j<3;j++){
    const a=ix.getX(k+j),b=ix.getX(k+(j+1)%3);if(!rimSet.has(a)||!rimSet.has(b))continue;
    const v=new T.Vector3().fromBufferAttribute(p,a).lerp(new T.Vector3().fromBufferAttribute(p,b),.5),idx=rig.skeleton.bones.indexOf(rig.bones[(v.x>0?'L':'R')+'_shin']);
    const center=new T.Vector3().setFromMatrixPosition(rig.skeleton.boneInverses[idx].clone().invert());center.y=v.y;ray.origin.copy(center);ray.direction.copy(v).sub(center).normalize();
    const hit=tree.raycastFirst(ray,T.DoubleSide,0,.6);expect(hit).not.toBeNull();expect(v.distanceTo(center)-hit!.distance).toBeGreaterThan(.008);
   }
   for(const i of rim){const v=new T.Vector3().fromBufferAttribute(p,i),side=v.x>0?'L':'R',bone=rig.bones[side+'_shin'],idx=rig.skeleton.bones.indexOf(bone),center=new T.Vector3().setFromMatrixPosition(rig.skeleton.boneInverses[idx].clone().invert());center.y=v.y;
    ray.origin.copy(center);ray.direction.copy(v).sub(center).normalize();const hit=tree.raycastFirst(ray,T.DoubleSide,0,.6);expect(hit).not.toBeNull();expect(v.distanceTo(center)-hit!.distance).toBeGreaterThan(.016);
    const w=sock.geometry.attributes.skinWeight;expect([0,1,2,3].reduce((n,k)=>n+w.getComponent(i,k),0)).toBeCloseTo(1,5);
   }
   outfit.dispose();
  }}finally{query.dispose();}
 });

 it('plants geta once, preserves the open foot, and restores the body on removal',async()=>{
  loadLocalAssets();
  for(const height of [.8,1,1.25]){
   const {root,rig}=makeRig(height),original=rig.mesh.geometry;
   const outfit=await dressApprovedWardrobe(rig,{shoes:'shoe-geta'});
   root.updateMatrixWorld(true);rig.skeleton.update();
   expect(Array.from(rig.mesh.geometry.index!.array)).toEqual(Array.from(original.index!.array));
   const box=new T.Box3();for(const mesh of outfit.meshes){mesh.computeBoundingBox();box.union(new T.Box3().setFromObject(mesh));}
   expect(box.min.y).toBeCloseTo(0,4);
   const point=new T.Vector3();let minFoot=Infinity;
   for(const i of referenced(original)){point.fromBufferAttribute(original.attributes.position,i);rig.mesh.applyBoneTransform(i,point).applyMatrix4(rig.mesh.matrixWorld);minFoot=Math.min(minFoot,point.y);}
   // Height now grows the legs; feet and platform thickness stay unchanged.
   expect(minFoot).toBeGreaterThan(.17);expect(minFoot).toBeLessThan(.20);
   outfit.dispose();expect(root.position.y).toBeCloseTo(0,8);expect(rig.mesh.geometry).toBe(original);
  }
 });
 it('keeps the ankle above a loafer opening even when the tongue is higher',async()=>{
  loadLocalAssets();const {rig}=makeRig(),original=rig.mesh.geometry;
  const outfit=await dressApprovedWardrobe(rig,{shoes:'school-loafers'}),used=referenced(rig.mesh.geometry);
  const ankle=[...referenced(original)].filter(i=>{const y=original.attributes.position.getY(i);return y>.34&&y<.46;});
  expect(ankle.length).toBeGreaterThan(4);for(const i of ankle)expect(used.has(i),`visible ankle vertex ${i}`).toBe(true);
  outfit.dispose();
 });
 it('retains geta support while the real motion system writes the body position',async()=>{
  loadLocalAssets();const {root,rig}=makeRig(),animate=createBlankMotion(rig,root);
  const outfit=await dressApprovedWardrobe(rig,{shoes:'shoe-geta'});
  animate(0,'walk','standing');for(let t=1;t<=60;t++)animate(t/30,'walk','standing');
  expect(root.position.y).toBeCloseTo(.18,5);
  animate(3,'sit','seated');for(let t=1;t<=60;t++)animate(3+t/30,'sit','seated');
  expect(root.userData.wardrobeLift.applied).toBeLessThan(.001);
  const seatedY=root.position.y;outfit.dispose();expect(root.position.y).toBeCloseTo(seatedY,3);
 });
 it('does not cut a sock up to the loafer tongue or remove it on open sandals',async()=>{
  loadLocalAssets();
  for(const shoes of ['school-loafers','shoe-geta']){
   const {rig}=makeRig(),bare=await dressApprovedWardrobe(rig,{socks:'school-socks'});
   const source=bare.meshes[0].geometry.clone();bare.dispose();
   const outfit=await dressApprovedWardrobe(rig,{shoes,socks:'school-socks'});
   const sock=outfit.meshes.find(m=>m.userData.garmentId==='school-socks')!,used=referenced(sock.geometry);
   const min=Math.min(...[...used].map(i=>sock.geometry.attributes.position.getY(i)));
   expect(min).toBeLessThan(shoes==='shoe-geta'?.02:.30);
   // Keep complete original boundary faces below the opening; splitting them
   // would invent weights and can open cracks in motion. Entire buried faces still go.
   expect(sock.geometry.attributes.position.count).toBe(source.attributes.position.count);
   expect(Array.from(sock.geometry.attributes.skinWeight.array)).toEqual(Array.from(source.attributes.skinWeight.array));
   if(shoes==='shoe-geta')expect(Array.from(sock.geometry.index!.array)).toEqual(Array.from(source.index!.array));
   else expect(sock.geometry.index!.count).toBeLessThan(source.index!.count);
   const faces=new Set(Array.from({length:source.index!.count/3},(_,t)=>[0,1,2].map(j=>source.index!.getX(t*3+j)).join(',')));
   for(let t=0;t<sock.geometry.index!.count;t+=3)expect(faces.has([0,1,2].map(j=>sock.geometry.index!.getX(t+j)).join(','))).toBe(true);
   source.dispose();
   outfit.dispose();
  }
 });
 it('hides boot shafts buried in long trousers and restores them when trousers are removed',async()=>{
  loadLocalAssets();const {rig}=makeRig();
  const withTrousers=await dressApprovedWardrobe(rig,{shoes:'tall-boots',bottom:'lower-cargo'});
  const shoe=withTrousers.meshes.find(m=>m.userData.garmentId==='tall-boots')!;
  const top=Math.max(...[...referenced(shoe.geometry)].map(i=>shoe.geometry.attributes.position.getY(i)));
  // The cargo cuff rises to .55; its low hanging folds reach .30 and must not
  // be mistaken for the opening, or the remaining boot ends visibly too low.
  expect(top).toBeLessThan(.64);expect(top).toBeGreaterThan(.55);
  withTrousers.dispose();const bareBoot=await dressApprovedWardrobe(rig,{shoes:'tall-boots'});
  const restored=bareBoot.meshes.find(m=>m.userData.garmentId==='tall-boots')!;
  expect(Math.max(...[...referenced(restored.geometry)].map(i=>restored.geometry.attributes.position.getY(i)))).toBeGreaterThan(1.2);
  bareBoot.dispose();
 });
});
