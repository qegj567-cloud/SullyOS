import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import catalog from '../public/room3d/catalog.json';
import {createHome,placementError,moveFurniture,validateHome} from '../apps/room3d/model.js';
import {furnishShowroom} from '../apps/room3d/showrooms.js';
describe('kitchenware source parts and dry worktops',()=>{
 it('ships complete tiny geometry assets without image channels',()=>{
  const assets=catalog.filter(a=>a.id.startsWith('kitchenware_')||a.id.startsWith('kitchen_ref_'));expect(assets).toHaveLength(17);
  for(const a of assets){const b=fs.readFileSync('public/room3d/'+a.url),g=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());
   expect(g.images?.length||0).toBe(0);expect(g.textures?.length||0).toBe(0);let triangles=0;
   for(const m of g.meshes)for(const p of m.primitives){expect(p.attributes.TEXCOORD_0).toBeUndefined();expect(p.attributes.COLOR_0).toBeUndefined();triangles+=g.accessors[p.indices].count/3;}
   if(a.surface==='rug'){expect(triangles).toBe(2);expect(b.length).toBeLessThan(1400);}
   expect(triangles).toBeLessThan(4000);expect(b.length).toBeLessThan(a.id.startsWith('kitchen_ref_')?80000:20000);
   for(const name of a.paintMaterials)expect(g.materials.some(m=>m.name===name)).toBe(true);
  }
 });
 it('attaches prep/cook/meal props to the right stations and rejects the sink as a shelf',()=>{
  const h=createHome(catalog),r=h.rooms[0];r.items=[];furnishShowroom(r,'kitchen',catalog);
  const get=(id:string)=>r.items.find(i=>i.assetId===id)!;
  for(const [child,parent] of [['kitchen_ref_prep','show_kitchen_counter'],['kitchenware_spices','show_kitchen_counter'],['kitchenware_pot','show_kitchen_range'],['kitchen_ref_breakfast','show_kitchen_island']])expect(get(child).supportId).toBe(get(parent).id);
  const counter=get('show_kitchen_counter'),board=get('kitchen_ref_prep');
  expect(placementError({...board,x:counter.x,z:counter.z},r,catalog)).toContain('台面');
  expect(r.items).toHaveLength(19);expect(validateHome(h,catalog)).toEqual(h);
  const old=structuredClone(board);moveFurniture(r,counter.id,{x:counter.x+.03},catalog);
  expect(get('kitchen_ref_prep').x).toBeCloseTo(old.x+.03);expect(get('kitchen_ref_prep').supportId).toBe(counter.id);
 });
});
