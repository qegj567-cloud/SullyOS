import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import catalog from '../public/room3d/catalog.json';
import {createHome,validateHome,moveFurniture} from '../apps/room3d/model.js';
import {addShowroom} from '../apps/room3d/showrooms.js';
import {gamingActivities} from '../apps/room3d/gaming.js';
import {USE_BY_ID} from '../apps/room3d/furnitureCatalog.js';

describe('reference study',()=>{
 it('retains working computer and streaming stations with full and compact furnishings',()=>{
  for(const compact of [false,true]){const h=createHome(catalog),r=addShowroom(h,'study',catalog,{compact});
   expect(r.items).toHaveLength(compact?15:27);expect(validateHome(h,catalog)).toEqual(h);
   const actions=gamingActivities(r,catalog,{headWidth:1.8});expect(actions.map(a=>a.kind)).toEqual(['computer','stream']);
   expect(actions.every(a=>!a.reason)).toBe(true);expect(r.items.some(i=>/cat|sleeping/.test(i.assetId))).toBe(false);
  }
 });
 it('keeps cabinet-top printer and plants attached through movement and save validation',()=>{
  const h=createHome(catalog),r=addShowroom(h,'study',catalog),s=r.items.find(i=>i.assetId==='show_study_shelf')!;
  const p=r.items.find(i=>i.assetId==='study_ref_printer_set')!,before=p.z;expect(p.supportId).toBe(s.id);
  moveFurniture(r,s.id,{z:s.z+.06},catalog);expect(r.items.find(i=>i.id===p.id)!.z).toBeCloseTo(before+.06);expect(validateHome(h,catalog)).toEqual(h);
 });
 it('ships classified texture-free geometry within the per-item budget',()=>{
  const assets=catalog.filter(a=>a.id.startsWith('study_ref_'));expect(assets).toHaveLength(11);
  for(const a of assets){expect(USE_BY_ID[a.id]).toBeTruthy();const b=fs.readFileSync('public/room3d/'+a.url),g=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());
   expect(g.images?.length||0).toBe(0);expect(g.textures?.length||0).toBe(0);let n=0;
   for(const m of g.meshes)for(const p of m.primitives){n+=g.accessors[p.indices].count/3;expect(Object.keys(p.attributes).sort()).toEqual(['NORMAL','POSITION']);}
   expect(n).toBeLessThan(4000);for(const name of a.paintMaterials)expect(g.materials.some(m=>m.name===name)).toBe(true);
  }
 });
});
