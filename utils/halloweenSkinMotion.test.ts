import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {splitHalloweenShoeSeam} from '../apps/room3d/chibi/halloweenShoeSkin';
afterEach(()=>vi.unstubAllGlobals());
it.each(['witch-boots','count-boots','apprentice-boots','ghost-shoes','pumpkin-boots'])('%s never stretches a triangle between two moving feet',async id=>{
 vi.stubGlobal('ProgressEvent',class{constructor(type:string,init:object){Object.assign(this,{type},init);}});
 const bytes=readFileSync(`public/room3d/wardrobe/halloween-${id}.glb`),json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
 delete json.images;delete json.textures;delete json.materials;for(const m of json.meshes)for(const p of m.primitives)delete p.material;
 json.buffers[0].uri='data:application/octet-stream;base64,'+bytes.subarray(28+bytes.readUInt32LE(12)).toString('base64');
 const {scene}=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(JSON.stringify(json),'');
 scene.traverse(o=>{if(!(o instanceof T.SkinnedMesh))return;
  const source=o.geometry,g=source.clone(),original=Array.from(source.getAttribute('skinWeight').array);
  splitHalloweenShoeSeam(g,o.skeleton.bones);
  const p=g.getAttribute('position'),si=g.getAttribute('skinIndex'),sw=g.getAttribute('skinWeight'),ix=g.index!,uv=g.getAttribute('uv');
  expect(uv.count).toBe(p.count);expect(Array.from(source.getAttribute('skinWeight').array)).toEqual(original);
  const travel=(i:number)=>{let delta=0,sum=0;for(let k=0;k<4;k++){const w=sw.getComponent(i,k);sum+=w;delta+=(o.skeleton.bones[si.getComponent(i,k)].name.startsWith('L_')?1:-1)*w;}expect(sum).toBeCloseTo(1,4);return delta;};
  for(let t=0;t<ix.count;t+=3){const ids=[0,1,2].map(k=>ix.getX(t+k)),movement=ids.map(travel);expect(Math.max(...movement)-Math.min(...movement)).toBeLessThan(.001);}
  if(id==='ghost-shoes')expect(ix.count).toBeGreaterThan(source.index!.count);
  const count=p.count;splitHalloweenShoeSeam(g,o.skeleton.bones);expect(g.getAttribute('position').count).toBe(count);g.dispose();
 });
});
