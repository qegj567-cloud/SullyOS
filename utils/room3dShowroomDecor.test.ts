import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import catalog from '../public/room3d/catalog.json';
import {createHome,validateHome,moveFurniture} from '../apps/room3d/model.js';
import {SHOWROOMS,addShowroom,applyShowroomStyle} from '../apps/room3d/showrooms.js';
import {createDoor} from '../apps/room3d/doorMeshes.js';
import {snapToWall} from '../apps/room3d/wallMount.js';
import {windowDaylightSources} from '../apps/room3d/windowDaylight.js';
import {roomPlants} from '../apps/room3d/watering.js';

describe('finished showroom architecture and decor',()=>{
 it('furnishes the widened bedroom with supported mirrors and a reachable floor plant',()=>{
  const h=createHome(catalog),r=addShowroom(h,'bedroom',catalog),asset=(id:string)=>catalog.find(a=>a.id===id)!,item=(id:string)=>r.items.find(a=>a.assetId===id)!;
  expect(r.items).toHaveLength(15);expect(asset('show_wardrobe').size[0]).toBeCloseTo(2.2);
  expect(item('suite_dressing_mirror').supportId).toBe(item('show_bedroom_dresser').id);
  expect(item('suite_plant_small').supportId).toBe(item('show_bedroom_low_shelf').id);
  expect(asset('suite_floor_mirror').surface).toBe('floor');
  const plants=roomPlants(r,catalog);expect(plants).toHaveLength(1);expect(plants[0].itemId).toBe(item('suite_plant_large').id);expect(plants[0].spot).toBeTruthy();
  const dresser=item('show_bedroom_dresser'),mirror=item('suite_dressing_mirror'),before=mirror.z;
  moveFurniture(r,dresser.id,{z:dresser.z+.1},catalog);expect(item('suite_dressing_mirror').z).toBeCloseTo(before+.1);expect(validateHome(h,catalog)).toEqual(h);
 });
 it('ships seventeen small geometry-only decor pieces and three animated door styles',()=>{
  const assets=catalog.filter(a=>a.id.startsWith('suite_'));expect(assets).toHaveLength(17);
  for(const a of assets){const b=fs.readFileSync('public/room3d/'+a.url),g=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());expect(g.images?.length||0).toBe(0);expect(g.textures?.length||0).toBe(0);let n=0;for(const m of g.meshes)for(const p of m.primitives){n+=g.accessors[p.indices].count/3;expect(Object.keys(p.attributes).sort()).toEqual(['NORMAL','POSITION']);}expect(n,a.id).toBeLessThan(4000);for(const m of a.paintMaterials)expect(g.materials.some(v=>v.name===m),a.id).toBe(true);}
  for(const kind of ['oak','walnut','lattice']){const root=createDoor({kind,width:2.2});let n=0;root.traverse(o=>{if(o.isMesh){n+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;expect(o.material.map).toBeNull();}});expect(n).toBeLessThan(4000);expect(root.userData.doorLeaf.children.length).toBeGreaterThan(0);expect(root.userData.doorKind).toBe(kind==='lattice'?'sliding':'door');}
 });
 it('gives every showroom walls, a window and attached tabletop decor within phone capacity',()=>{
  for(const key of Object.keys(SHOWROOMS)){const h=createHome(catalog),r=addShowroom(h,key,catalog);expect(r.items.length).toBeLessThanOrEqual(20);expect(r.items.some(i=>catalog.find(a=>a.id===i.assetId)?.daylight===true)).toBe(true);expect(r.items.some(i=>i.assetId.startsWith('suite_art_')||i.assetId==='suite_wall_shelf'||i.assetId==='kitchen_ref_hood')).toBe(true);expect(r.items.filter(i=>i.supportId).length).toBeGreaterThan(0);expect(validateHome(h,catalog)).toEqual(h);}
 });
 it('all five windows give daylight on each of the four exterior wall faces',()=>{
  for(const a of catalog.filter(a=>a.id.startsWith('suite_window_')))for(const [x,z]of [[0,-4],[-4.7,0],[0,4],[4.7,0]]){const h=createHome(catalog),r=h.rooms[0];r.items=[];r.items.push(snapToWall({id:'w',assetId:a.id,x,y:2,z,rotation:0,color:null,stored:false},a,r,catalog));const sources=windowDaylightSources(h,r,catalog,new Set([r.id]));expect(sources,a.id).toHaveLength(1);expect(sources[0].target[1]).toBeLessThan(sources[0].position[1]);}
 });
 it('style-only changes preserve furniture and custom cushion colors survive validation',()=>{
  const h=createHome(catalog),r=addShowroom(h,'bedroom',catalog),items=structuredClone(r.items),name=r.name;
  applyShowroomStyle(r,'spa');expect(r.items).toEqual(items);expect(r.name).toBe(name);expect(r.wallStyle).toBe('spa');expect(validateHome(h,catalog)).toEqual(h);
  const bed=r.items.find(i=>i.assetId==='show_bed')!;bed.materialColors={'pillow-left':'#91c9f4','pillow-right':'#f2b8d5'};expect(validateHome(h,catalog).rooms.find(v=>v.id===r.id)!.items.find(i=>i.id===bed.id)!.materialColors).toEqual(bed.materialColors);
  bed.materialColors={'woodLight':'#ffffff'};expect(()=>validateHome(h,catalog)).toThrow('局部配色');
 });
 it('moves and rotates the actual decorated coffee table with its supported props',()=>{
  const h=createHome(catalog),r=addShowroom(h,'living',catalog),table=r.items.find(i=>i.assetId==='show_living_table')!,props=r.items.filter(i=>i.supportId===table.id),before=structuredClone(props);
  moveFurniture(r,table.id,{x:table.x+.2,rotation:90},catalog);
  for(const p of before){const after=r.items.find(i=>i.id===p.id)!;expect(after.supportId).toBe(table.id);expect(after.x).toBeCloseTo(table.x+.2+p.z-table.z);expect(after.z).toBeCloseTo(table.z-(p.x-table.x));expect(after.y).toBeCloseTo(p.y);}
  expect(validateHome(h,catalog)).toEqual(h);
 });
});
