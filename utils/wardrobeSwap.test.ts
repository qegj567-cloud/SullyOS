import {afterEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {createBlankBody} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {dressApprovedWardrobe,prepareApprovedWardrobe} from '../apps/room3d/chibi/approvedClothing';
import {prepareHoodie} from '../apps/room3d/chibi/hoodieClothes';

function setup(){
 vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{
  const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 });
 const root=new T.Group(),body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial()),hair=new T.Group();root.add(body,hair);
 return {root,rig:bindBlankBody(body,hair,true)};
}
afterEach(()=>vi.restoreAllMocks());
describe('wardrobe preparation on a live body',()=>{
 it('keeps the visible outfit, pose, skin and shoe support until an explicit swap',async()=>{
  const {rig,root}=setup(),base=rig.baseGeometry,index=Array.from(base.index!.array);
  const old=await dressApprovedWardrobe(rig,{top:'stand-collar',shoes:'shoe-geta'}),skin=rig.mesh.geometry,children=[...root.children],lift=root.position.y;
  rig.bones.L_upperArm.rotation.z=-.7;root.updateMatrixWorld(true);
  const pose=rig.skeleton.bones.map(b=>b.quaternion.toArray()),binds=rig.skeleton.boneInverses.map(m=>m.toArray());
  const next=await prepareApprovedWardrobe(rig,{top:'fitted-sweater',outer:'slouch-cardigan'},{},{},true);
  expect(root.children).toEqual(children);expect(rig.mesh.geometry).toBe(skin);expect(root.position.y).toBe(lift);
  expect(next.meshes.every(m=>m.parent===null&&m.skeleton===rig.skeleton)).toBe(true);
  expect(rig.skeleton.bones.map(b=>b.quaternion.toArray())).toEqual(pose);expect(rig.skeleton.boneInverses.map(m=>m.toArray())).toEqual(binds);
  old.dispose();next.attach();next.attach();expect(root.position.y).toBeCloseTo(0,8);
  expect(old.meshes.every(m=>m.parent===null)).toBe(true);expect(next.meshes.every(m=>m.parent===root)).toBe(true);
  next.dispose();expect(rig.mesh.geometry).toBe(base);expect(Array.from(base.index!.array)).toEqual(index);
 });
 it('discards a superseded preparation without disturbing the outfit already displayed',async()=>{
  const {rig,root}=setup(),old=await dressApprovedWardrobe(rig,{shoes:'shoe-geta'}),skin=rig.mesh.geometry,lift=root.position.y;
  const pending=await prepareApprovedWardrobe(rig,{top:'fitted-sweater'}),disposed=vi.fn();pending.meshes[0].geometry.addEventListener('dispose',disposed);
  pending.dispose();pending.dispose();pending.attach();
  expect(disposed).toHaveBeenCalledOnce();expect(rig.mesh.geometry).toBe(skin);expect(root.position.y).toBe(lift);expect(old.meshes.every(m=>m.parent===root)).toBe(true);
  old.dispose();
 });
 it('restores the complete body after switching through the legacy hoodie and an empty outfit',async()=>{
  const {rig,root}=setup(),base=rig.baseGeometry,index=Array.from(base.index!.array),old=await dressApprovedWardrobe(rig,{top:'stand-collar'}),skin=rig.mesh.geometry;
  const hoodie=prepareHoodie(rig);expect(rig.mesh.geometry).toBe(skin);expect(hoodie.meshes.every(m=>m.parent===null)).toBe(true);
  old.dispose();hoodie.attach();expect(rig.mesh.geometry).not.toBe(base);expect(Array.from(base.index!.array)).toEqual(index);
  const empty=await prepareApprovedWardrobe(rig,{});hoodie.dispose();empty.attach();
  expect(Array.from(rig.mesh.geometry.index!.array)).toEqual(index);expect(root.children.some(o=>o.name.startsWith('hoodie-'))).toBe(false);
  empty.dispose();expect(rig.mesh.geometry).toBe(base);
 });
 it('leaves the live outfit intact when a new asset fails to load',async()=>{
  const {rig,root}=setup(),old=await dressApprovedWardrobe(rig,{top:'stand-collar'}),skin=rig.mesh.geometry,children=[...root.children];
  vi.mocked(GLTFLoader.prototype.loadAsync).mockRejectedValueOnce(new Error('asset unavailable'));
  await expect(prepareApprovedWardrobe(rig,{top:'basic-tee'})).rejects.toThrow('asset unavailable');
  expect(rig.mesh.geometry).toBe(skin);expect(root.children).toEqual(children);old.dispose();
 });
});
