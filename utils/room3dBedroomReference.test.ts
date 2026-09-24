import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import catalog from '../public/room3d/catalog.json';
import {addShowroom} from '../apps/room3d/showrooms.js';
import {createHome,placementError,validateHome,moveFurniture,findResidentSpot} from '../apps/room3d/model.js';
import {walkingMap,findWalkPath,doorTarget} from '../apps/room3d/navigation.js';
import {phoneBudgetError} from '../apps/room3d/deviceBudget.js';
import {USE_BY_ID} from '../apps/room3d/furnitureCatalog.js';
import {roomPlants} from '../apps/room3d/watering.js';
import {windowDaylightSources,daylightPose} from '../apps/room3d/windowDaylight.js';

describe('reference bedroom',()=>{
 it('ships complete pure-geometry assets below the per-furniture triangle budget',()=>{
  const assets=catalog.filter(a=>a.id.startsWith('bedroom_ref_'));expect(assets.length).toBe(22);
  for(const a of assets){
   const bytes=fs.readFileSync('public/room3d/'+a.url),g=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
   expect(g.images?.length||0,a.id).toBe(0);expect(g.textures?.length||0,a.id).toBe(0);
   let triangles=0;for(const m of g.meshes)for(const p of m.primitives){triangles+=g.accessors[p.indices].count/3;expect(Object.keys(p.attributes).sort(),a.id).toEqual(['NORMAL','POSITION']);}
   expect(triangles,a.id).toBeLessThan(4000);expect(USE_BY_ID[a.id],a.id).toBeTruthy();
   for(const name of a.paintMaterials)expect(g.materials.some(m=>m.name===name),a.id).toBe(true);
  }
 });
 it('keeps a valid entry, reachable floor plant and supported tabletop arrangements',()=>{
  const h=createHome(catalog),original=structuredClone(h.rooms[0]),room=addShowroom(h,'bedroom',catalog);
  expect(room.items).toHaveLength(27);expect(h.rooms[0]).toEqual(original);
  for(const i of room.items)expect(placementError(i,room,catalog),i.assetId).toBe('');
  expect(validateHome(h,catalog)).toEqual(h);
  const spot=findResidentSpot(room,catalog),map=walkingMap(h,0,catalog,{headWidth:1.8});
  expect(findWalkPath(map,[room.x*9.3+spot[0],room.z*7.95+spot[2]],doorTarget(h,room,'front'))).toBeTruthy();
  expect(roomPlants(room,catalog)[0].spot).toBeTruthy();
  expect(room.items.filter(i=>i.supportId)).toHaveLength(7);
  expect(room.trim).toBe('#eacba8');
  const bed=room.items.find(i=>i.assetId==='show_bed')!,bedAsset=catalog.find(a=>a.id===bed.assetId)!;
  expect(bed.z-bedAsset.size[2]/2).toBeCloseTo(-3.825);
  const [light]=windowDaylightSources(h,room,catalog,new Set([room.id]));
  expect(light.settings).toEqual({reach:4.8,intensity:80});
  expect(light.target[2]-light.position[2]).toBeCloseTo(4.8);
  expect(light.target[2]).toBeGreaterThan(bed.z+bedAsset.size[2]/2);
  expect(daylightPose(light.item,light.size,light.settings).target).toEqual(light.target);
 });
 it('moves dresser ornaments together and preserves the existing compact mobile option',()=>{
  const h=createHome(catalog),room=addShowroom(h,'bedroom',catalog),dresser=room.items.find(i=>i.assetId==='bedroom_ref_dresser')!,top=room.items.find(i=>i.supportId===dresser.id)!;
  const before={...top};moveFurniture(room,dresser.id,{z:dresser.z+.08},catalog);
  expect(room.items.find(i=>i.id===top.id)!.z).toBeCloseTo(before.z+.08);expect(validateHome(h,catalog)).toEqual(h);
  const mobile=createHome(catalog),compact=addShowroom(mobile,'bedroom',catalog,{compact:true});expect(compact.items).toHaveLength(15);expect(phoneBudgetError(null,mobile,catalog)).toBe('');
 });
});
