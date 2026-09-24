import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {createBlankBody} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {prepareHoodie} from '../apps/room3d/chibi/hoodieClothes';
import {dressApprovedWardrobe} from '../apps/room3d/chibi/approvedClothing';
import {approvedPresets} from '../apps/room3d/chibi/approvedWardrobe';
import {garmentColorRegions} from '../apps/room3d/chibi/wardrobeColors';
function setup(){
 vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');});
 const root=new T.Group(),body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial()),hair=new T.Group();root.add(body,hair);return bindBlankBody(body,hair,true);
}
afterEach(()=>vi.restoreAllMocks());
it('publishes exactly the original hoodie and two shoe/sock groups with the original skinning',async()=>{
 const rig=setup(),legacy=prepareHoodie(rig),outfit=await dressApprovedWardrobe(rig,approvedPresets.original.items);
 for(const [id,part,group] of [['original-hoodie',0,-1],['original-socks',1,0],['original-shoes',1,1]] as const){
  const old=legacy.meshes[part].geometry,next=outfit.meshes.find(m=>m.userData.garmentId===id)!.geometry,range=group<0?{start:0,count:old.index!.count}:old.groups[group];
  expect(next.index!.count).toBe(range.count);
  for(let k=0;k<range.count;k++){const a=old.index!.getX(range.start+k),b=next.index!.getX(k);
   for(const key of ['position','skinWeight','skinIndex']){const x=old.attributes[key],y=next.attributes[key];for(let j=0;j<x.itemSize;j++)expect(y.getComponent(b,j)).toBeCloseTo(x.getComponent(a,j),5);}
  }
 }
 expect(outfit.meshes).toHaveLength(3);outfit.dispose();legacy.dispose();
});
it('wears shoes and socks independently, supports recoloring, and restores the bare body',async()=>{
 const rig=setup();
 for(const [slot,id] of [['top','original-hoodie'],['socks','original-socks'],['shoes','original-shoes']] as const){
  const region=garmentColorRegions[id][0].id,outfit=await dressApprovedWardrobe(rig,{[slot]:id},{},{[id]:{[region]:'#1266aa'}});
  expect(outfit.meshes).toHaveLength(1);expect(outfit.meshes[0].userData.garmentId).toBe(id);
  const mat=outfit.meshes[0].material as T.MeshStandardMaterial;expect(mat.color.getHexString()).toBe('1266aa');
  outfit.dispose();expect(rig.mesh.geometry).toBe(rig.baseGeometry);
 }
});
it('adjusts and restores the hoodie independently of its shoes and socks',async()=>{
 const rig=setup(),items=approvedPresets.original.items,base=await dressApprovedWardrobe(rig,items),source=base.meshes.map(m=>Array.from(m.geometry.attributes.position.array));base.dispose();
 const changed=await dressApprovedWardrobe(rig,items,{'original-hoodie':{sleeveOpening:35,width:110}});
 changed.meshes.forEach((m,i)=>{if(m.userData.garmentId==='original-hoodie')expect(Array.from(m.geometry.attributes.position.array)).not.toEqual(source[i]);else expect(Array.from(m.geometry.attributes.position.array)).toEqual(source[i]);});changed.dispose();
 const restored=await dressApprovedWardrobe(rig,items);restored.meshes.forEach((m,i)=>expect(Array.from(m.geometry.attributes.position.array)).toEqual(source[i]));restored.dispose();
});
it('keeps bare feet visible when the original open-foot socks are worn without shoes',async()=>{
 const rig=setup(),outfit=await dressApprovedWardrobe(rig,{socks:'original-socks'}),g=rig.mesh.geometry;
 const feet=Array.from(new Set(Array.from(g.index!.array))).filter(i=>g.attributes.position.getY(i)<.2);
 expect(feet.length).toBeGreaterThan(30);outfit.dispose();
});
