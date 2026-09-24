import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import catalog from '../public/room3d/catalog.json';
import {createHome,validateHome,moveFurniture} from '../apps/room3d/model.js';
import {addShowroom} from '../apps/room3d/showrooms.js';
import {USE_BY_ID} from '../apps/room3d/furnitureCatalog.js';
import {windowDaylightSources} from '../apps/room3d/windowDaylight.js';
import {exportRoomLayout,parseRoomLayout} from '../apps/room3d/roomSharing.js';

describe('reference living room',()=>{
 it('ships classified geometry without textures, within the furniture budget',()=>{
  const assets=catalog.filter(a=>a.id.startsWith('living_ref_'));expect(assets).toHaveLength(15);
  for(const a of assets){expect(USE_BY_ID[a.id]).toBeTruthy();const b=fs.readFileSync('public/room3d/'+a.url),g=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());
   expect(g.images?.length||0).toBe(0);expect(g.textures?.length||0).toBe(0);let n=0;
   for(const m of g.meshes)for(const p of m.primitives){n+=g.accessors[p.indices].count/3;expect(Object.keys(p.attributes).sort()).toEqual(['NORMAL','POSITION']);}
   expect(n,a.id).toBeLessThan(4000);for(const name of a.paintMaterials)expect(g.materials.some(m=>m.name===name)).toBe(true);
  }
 });
 it('keeps sofa seats, supported television and outward-wall daylight through saves',()=>{
  const h=createHome(catalog),r=addShowroom(h,'living',catalog);expect(validateHome(h,catalog)).toEqual(h);
  const sofa=catalog.find(a=>a.id==='living_ref_sofa')!,base=catalog.find(a=>a.id==='show_living_sofa')!;expect(sofa.seats).toEqual(base.seats);
  const console=r.items.find(i=>i.assetId==='living_ref_console')!,tv=r.items.find(i=>i.assetId==='living_ref_television')!,before=tv.z;
  expect(tv.supportId).toBe(console.id);moveFurniture(r,console.id,{z:console.z+.03},catalog);expect(r.items.find(i=>i.id===tv.id)!.z).toBeCloseTo(before+.03);
  expect(validateHome(h,catalog)).toEqual(h);
  const lights=windowDaylightSources(h,r,catalog,new Set([r.id]));expect(lights).toHaveLength(1);expect(lights[0].target[2]-lights[0].position[2]).toBeCloseTo(5.8);
  expect(()=>parseRoomLayout(JSON.stringify(exportRoomLayout(r,catalog)),catalog)).not.toThrow();
 });
 it('preserves the compact mobile template',()=>{const h=createHome(catalog),r=addShowroom(h,'living',catalog,{compact:true});expect(r.items.length).toBeLessThanOrEqual(15);expect(validateHome(h,catalog)).toEqual(h);});
});
