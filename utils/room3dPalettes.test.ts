import {it,expect} from 'vitest';
import fs from 'node:fs';
import catalog from '../public/room3d/catalog.json';
import {ROOM_PALETTES,applyRoomPalette} from '../apps/room3d/roomPalettes.js';
import {SHOWROOMS,addShowroom} from '../apps/room3d/showrooms.js';
import {createHome,validateHome} from '../apps/room3d/model.js';
import {exportRoomLayout,parseRoomLayout} from '../apps/room3d/roomSharing.js';
it('applies each theme without moving furniture or changing other rooms, and preserves it in sharing',()=>{
 for(const roomKey of Object.keys(SHOWROOMS))for(const key of Object.keys(ROOM_PALETTES)){
  const h=createHome(catalog),r=addShowroom(h,roomKey,catalog),before=structuredClone(h.rooms[0]);
  const poses=r.items.map(({color,materialColors,...i})=>i);applyRoomPalette(r,key,catalog);
  expect(r.items.map(({color,materialColors,...i})=>i)).toEqual(poses);expect(h.rooms[0]).toEqual(before);
  expect(validateHome(h,catalog)).toEqual(h);const shared=exportRoomLayout(r,catalog);expect(parseRoomLayout(JSON.stringify(shared),catalog).items.map(i=>i.materialColors)).toEqual(r.items.map(i=>i.materialColors));
 }
});
it('uses neutral furniture instead of wood in cyber, and restores wood in pastel themes',()=>{
 const h=createHome(catalog),r=addShowroom(h,'living',catalog),cab=r.items.find(i=>i.assetId==='living_ref_console')!;
 applyRoomPalette(r,'cyber',catalog);expect(cab.materialColors.woodLight).toBe('#f0eff4');expect(r.wall).toBe('#eeedf2');
 applyRoomPalette(r,'blush',catalog);expect(cab.materialColors.woodLight).toBeUndefined();
});
it('only registers real material names, leaving foliage unchanged',()=>{
 for(const a of catalog.filter(a=>a.paletteMaterials?.length)){
  const b=fs.readFileSync('public/room3d/'+a.url),g=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)));
  for(const name of a.paletteMaterials!){expect(g.materials.some(m=>m.name===name),a.id+' '+name).toBe(true);expect(/leaf|earth|glass/i.test(name)).toBe(false);expect(a.colorParts?.some(p=>p.material===name)).toBe(true);}
 }
});

it('includes restored kitchen appliances, coffee props and fabric accents in every palette',()=>{
 for(const key of Object.keys(ROOM_PALETTES)){
  const h=createHome(catalog),r=addShowroom(h,'kitchen',catalog),p=ROOM_PALETTES[key];
  applyRoomPalette(r,key,catalog);
  const colors=(id:string)=>r.items.find(i=>i.assetId===id)!.materialColors;
  expect(colors('kitchenware_coffee').porcelain).toBe(p.body);
  expect(colors('kitchenware_coffee').charcoal).toBe(p.dark);
  expect(colors('kitchen_fridge')['kitchen-cream']).toBe(p.body);
  expect(colors('kitchen_fridge')['kitchen-accent']).toBe(p.accent);
  expect(colors('kitchen_ref_runner').charcoal).toBe(p.accent);
  expect(colors('show_kitchen_bench')['showroom-cream']).toBe(p.accent);
  expect(colors('kitchen_ref_shelves').leaf).toBeUndefined();
  expect(colors('kitchen_ref_shelves').soil).toBeUndefined();
  expect(colors('kitchenware_coffee').steel).toBeUndefined();
  expect(validateHome(h,catalog)).toEqual(h);
 }
});

