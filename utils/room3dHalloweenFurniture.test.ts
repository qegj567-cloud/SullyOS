import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import catalog from '../public/room3d/catalog.json';
import {createHome,placementError,validateHome} from '../apps/room3d/model.js';
import {addShowroom} from '../apps/room3d/showrooms.js';
import {USE_BY_ID} from '../apps/room3d/furnitureCatalog.js';
import {roomSeats,seatTransform} from '../apps/room3d/seating.js';
import {seatEntry} from '../apps/room3d/seatChange.js';
import {walkingMap} from '../apps/room3d/navigation.js';
describe('Halloween furniture',()=>{
 it('ships 12 reference-textured assets within the approved 8k budget without atlas mip bleeding',()=>{
  const assets=catalog.filter(a=>a.id.startsWith('halloween_'));expect(assets).toHaveLength(12);
  let totalBytes=0;
  for(const a of assets){const bytes=fs.readFileSync('public/room3d/'+a.url),g=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());let triangles=0;
   totalBytes+=bytes.length;expect(bytes.length,a.id).toBeLessThan(650_000);
   expect(createHash('sha256').update(bytes).digest('hex').slice(0,12)).toBe(a.revision);
   expect(g.extensionsRequired).toEqual(expect.arrayContaining(['EXT_meshopt_compression','EXT_texture_webp']));
   expect(g.images.every((image:any)=>image.mimeType==='image/webp')).toBe(true);
   if(a.id==='halloween_gothic_curtain_window')expect(g.meshes.flatMap((m:any)=>m.primitives).some((p:any)=>p.extras?.repair==='window-left-glass-clean-uv')).toBe(true);
   expect(g.images?.length||0,a.id).toBeGreaterThan(0);expect(USE_BY_ID[a.id],a.id).toBeTruthy();
   expect(a.textureSource).toBe('meshy-reference');expect(a.materialStyle).toBe('pbr');
   for(const sampler of g.samplers)expect(sampler.minFilter,a.id).toBe(9729);
   for(const mesh of g.meshes)for(const p of mesh.primitives){triangles+=g.accessors[p.indices].count/3;expect(p.attributes.TEXCOORD_0,a.id).toBeDefined();expect(p.attributes.COLOR_0,a.id).toBeUndefined();expect(g.materials[p.material].pbrMetallicRoughness.baseColorTexture,a.id).toBeDefined();}
   expect(triangles,a.id).toBeLessThanOrEqual(8000);for(const name of a.paintMaterials)expect(g.materials.some(m=>m.name===name),a.id+name).toBe(true);
  }
  expect(totalBytes).toBeLessThan(5_000_000);
 });
 it('adds a complete room atomically and preserves independent lantern support through save/load',()=>{
  const home=createHome(catalog),before=structuredClone(home.rooms[0]),room=addShowroom(home,'halloween',catalog);expect(home.rooms[0]).toEqual(before);expect(room.items).toHaveLength(12);
  for(const i of room.items)expect(placementError(i,room,catalog),i.assetId).toBe('');
  const lamp=room.items.find(i=>i.assetId==='halloween_pumpkin_lantern');expect(room.items.find(i=>i.id===lamp.supportId)?.assetId).toBe('halloween_haunted_fireplace');
  expect(validateHome(JSON.parse(JSON.stringify(home)),catalog)).toEqual(home);
 });
 it('leaves a standing entry in front of every seat for the large body',()=>{
  const home=createHome(catalog),room=addShowroom(home,'halloween',catalog),map=walkingMap(home,room.level,catalog,{headWidth:1.8,walkClearance:true});
  const seats=roomSeats(room,catalog);expect(seats).toHaveLength(3);
  for(const seat of seats)expect(seatEntry(seatTransform(room,catalog,seat,true),map,[room.x*9.3,room.z*7.95]),seat.label).toBeTruthy();
 });
});
