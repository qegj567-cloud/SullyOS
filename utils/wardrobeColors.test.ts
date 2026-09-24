import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {approvedGarments} from '../apps/room3d/chibi/approvedWardrobe';
import {cleanWardrobeColors,createGarmentColorController,garmentColorRegions} from '../apps/room3d/chibi/wardrobeColors';

describe('wardrobe colors',()=>{
 it('keeps matching coat and lapel defaults independently editable with an authored mask',()=>{
  const bytes=readFileSync('public/room3d/wardrobe/belt-coat-rig.glb'),gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  const cloth=gltf.nodes.find((n:any)=>n.name==='Apparel_belt-coat_0'),primitive=gltf.meshes[cloth.mesh].primitives[0];
  expect(primitive.attributes._LAPEL).toBeDefined();
  const material=new T.MeshStandardMaterial({color:'#ffffff',vertexColors:true});material.userData=gltf.materials[primitive.material].extras;
  const regions=garmentColorRegions['belt-coat'];expect(regions.find(r=>r.id==='body')!.color).toBe(regions.find(r=>r.id==='lapel')!.color);
  const update=createGarmentColorController(material,'belt-coat',primitive.material),shader={uniforms:{},vertexShader:'#include <begin_vertex>',fragmentShader:'#include <color_fragment>'} as any;
  material.onBeforeCompile(shader,{} as T.WebGLRenderer);update({lapel:'#ffffff'});
  expect(shader.vertexShader).toContain('wardrobeLapel = _lapel');
  expect(shader.fragmentShader).toContain('mix(wardrobeDeltas[0], wardrobeDeltas[1]');
  expect(shader.uniforms.wardrobeDeltas.value[0].toArray()).toEqual([0,0,0]);expect(shader.uniforms.wardrobeDeltas.value[1].r).toBeGreaterThan(.9);
  update();expect(shader.uniforms.wardrobeDeltas.value[1].toArray()).toEqual([0,0,0]);
 });
 it('covers every shipped garment material without coloring the attached reference body',()=>{
  for(const garment of approvedGarments){
   const bytes=readFileSync(`public/room3d/wardrobe/${garment.asset}`),gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
   const indices=new Set(gltf.nodes.filter((n:any)=>n.mesh!==undefined&&n.name.startsWith(garment.prefix)).flatMap((n:any)=>gltf.meshes[n.mesh].primitives.map((p:any)=>p.material)));
   const regions=garmentColorRegions[garment.id];expect(regions,garment.id).toBeDefined();
   expect(new Set(regions.map(r=>r.id)).size,garment.id).toBe(regions.length);
   expect(new Set(regions.flatMap(r=>r.targets.map(t=>t.material))),garment.id).toEqual(indices);
   for(const region of regions)expect(region.color).toMatch(/^#[0-9a-f]{6}$/);
  }
 });
 it('normalizes saved colors and ignores unknown garments, regions and invalid values',()=>{
  expect(cleanWardrobeColors(JSON.parse(JSON.stringify({
   'basic-tee':{'material-1':' #ABC ','material-2':'url(bad)',unknown:'#ffffff'},
   'hood-parka':{body:'#12zz34',metal:'#123456'},unknown:{body:'#123456'},
  })))).toEqual({'basic-tee':{'material-1':'#aabbcc'},'hood-parka':{metal:'#123456'}});
  expect(cleanWardrobeColors(null)).toEqual({});expect(cleanWardrobeColors({__proto__:{}})).toEqual({});
 });
 it('isolates per-garment colors and restores exact original materials including authored maps',()=>{
  const source=new T.MeshStandardMaterial({color:new T.Color(.137,.329,.672),roughness:.83,metalness:.17,map:new T.Texture()});
  const a=source.clone(),b=source.clone();
  const updateA=createGarmentColorController(a,'basic-tee',1),updateB=createGarmentColorController(b,'basic-tee',1);
  updateA({'material-1':'#f3ede2'});updateB({'material-1':'#303039'});
  expect(a.color.getHexString()).toBe('f3ede2');expect(b.color.getHexString()).toBe('303039');
  expect(source.color.toArray()).toEqual([.137,.329,.672]);
  expect(a.map).toBe(source.map);expect(a.roughness).toBe(.83);expect(a.metalness).toBe(.17);
  updateA();expect(a.color.equals(source.color)).toBe(true);expect(b.color.getHexString()).toBe('303039');
 });
 it('supports both lightening vertex-painted black and darkening the light trim, with zero-delta reset',()=>{
  const material=new T.MeshStandardMaterial({color:'#ffffff',vertexColors:true});
  const update=createGarmentColorController(material,'hood-parka',1);
  const shader={uniforms:{},fragmentShader:'#include <color_fragment>'} as any;
  material.onBeforeCompile(shader,{} as T.WebGLRenderer);
  update({body:'#f3ede2',lining:'#000000'});
  const deltas=shader.uniforms.wardrobeDeltas.value as T.Color[];
  expect(deltas[0].r).toBeGreaterThan(.7);expect(deltas[1].r).toBeLessThan(0);
  expect(deltas[2].toArray()).toEqual([0,0,0]);
  update();for(const delta of deltas)expect(delta.toArray()).toEqual([0,0,0]);
  expect(material.color.getHexString()).toBe('ffffff');expect(material.vertexColors).toBe(true);
 });
 it('keeps the sailor texture shared and read-only while separating light cloth from dark cloth',()=>{
  const texture=new T.Texture(),material=new T.MeshStandardMaterial({color:'#ffffff',map:texture});
  const update=createGarmentColorController(material,'sailor-long',1);
  const shader={uniforms:{},fragmentShader:'#include <color_fragment>'} as any;
  update({navy:'#b85d72'});material.onBeforeCompile(shader,{} as T.WebGLRenderer);
  expect(shader.uniforms.wardrobeDeltas.value[0].r).toBeGreaterThan(0);
  expect(shader.uniforms.wardrobeDeltas.value[1].toArray()).toEqual([0,0,0]);
  expect(material.map).toBe(texture);expect(texture.version).toBe(0);
  expect(shader.fragmentShader).toContain('#include <color_fragment>');
 });
});
