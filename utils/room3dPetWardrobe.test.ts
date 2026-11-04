import {describe,it,expect} from 'vitest';
import * as T from 'three';
import fs from 'node:fs';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import catalog from '../public/room3d/catalog.json';
import {createHome} from '../apps/room3d/model.js';
import {createPetLife,normalizePetLife} from '../apps/room3d/petLife.js';
import {attachPetHat} from '../apps/room3d/petHatModel.js';
describe('pet wardrobe',()=>{
 it('keeps hats independent, persists through restore/undo, and rejects unknown imported hats',()=>{
  const home=createHome(catalog),life=createPetLife({home:()=>home,catalog}),a=life.adopt('pet_hamster','圆圆'),b=life.adopt('pet_jellyfish','啵啵');
  a.hat='witch';b.hat='pumpkin';life.save();const saved=JSON.parse(JSON.stringify(home.petLife));life.restore(saved);expect(life.data.pets.map(p=>p.hat)).toEqual(['witch','pumpkin']);
  life.remove(a.id);expect(life.undoRemove().hat).toBe('witch');saved.pets[0].hat='remote-url';expect(normalizePetLife(saved,home,catalog).pets[0].hat).toBeNull();delete saved.pets[1].hat;expect(normalizePetLife(saved,home,catalog).pets[1].hat).toBeNull();
 });
 it('fits both hats above every real pet face and follows parent motion without altering source geometry',async()=>{
  for(const a of catalog.filter(a=>'petSpecies' in a))for(const id of ['witch','pumpkin']){
   const bytes=fs.readFileSync('public/room3d/'+a.url),{scene}=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
   scene.scale.setScalar(.75);const hat=attachPetHat(scene,id,a)!;expect(scene.scale.x).toBe(.75);expect(hat.parent).toBe(scene);
   const bounds=new T.Box3().setFromObject(hat),eyes=new T.Box3();scene.traverse((o:any)=>{if(o.isMesh&&o.material.name==='pet-eyes')eyes.union(new T.Box3().setFromObject(o));});
   expect(bounds.min.y,a.id+' '+id).toBeGreaterThan(eyes.max.y-.04);
   const before=hat.getWorldPosition(new T.Vector3());scene.position.set(2,3,4);scene.updateMatrixWorld(true);expect(hat.getWorldPosition(new T.Vector3()).sub(before).distanceTo(new T.Vector3(2,3,4))).toBeLessThan(1e-6);
   hat.traverse((o:any)=>{if(o.isMesh){expect(o.userData.petHat).toBe(true);expect(o.geometry.attributes.uv).toBeUndefined();}});
  }
 });
});
