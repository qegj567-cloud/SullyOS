import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import catalog from '../public/room3d/catalog.json';
import {applyFurnitureColorPreset,setFurniturePrimaryColor,resetFurnitureColors,furniturePartColor} from '../apps/room3d/furniturePaint.js';
import {createHome,validateHome} from '../apps/room3d/model.js';
import {paintPanel} from '../apps/room3d/paintPanel.js';
const pets=catalog.filter(a=>'petSpecies' in a);
const read=(a:any)=>{const b=fs.readFileSync('public/room3d/'+a.url);return JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());};
describe('nine solid-color pet assets',()=>{
 it('ships a compact round hamster and a jellyfish without a mouth material',()=>{
  const hamster=pets.find(p=>p.id==='pet_hamster')!,jelly=pets.find(p=>p.id==='pet_jellyfish')!;
  expect(hamster.size[2]/hamster.size[0]).toBeLessThan(1);expect(hamster.size[1]/hamster.size[0]).toBeGreaterThan(.8);
  expect(read(jelly).materials.some((m:any)=>m.name==='pet-mouth')).toBe(false);expect(jelly.colorParts!.some(p=>p.material==='pet-mouth')).toBe(false);
 });
 it('ships each entire pet below 4000 triangles without images, UVs or vertex colors',()=>{
  expect(pets).toHaveLength(9);
  for(const a of pets){
   const g=read(a),primitives=g.meshes.flatMap((m:any)=>m.primitives);
   expect(primitives.reduce((sum:number,p:any)=>sum+g.accessors[p.indices].count/3,0),a.id).toBeLessThan(4000);
   expect(g.images||[]).toHaveLength(0);expect(g.textures||[]).toHaveLength(0);
   for(const p of primitives){expect(Object.keys(p.attributes).sort()).toEqual(['NORMAL','POSITION']);expect(g.accessors[p.indices].count%3).toBe(0);}
   const materials=g.materials.map((m:any)=>m.name);
   for(const p of a.colorParts!)expect(materials,a.id).toContain(p.material);
   expect(a.colorPresets).toHaveLength(8);
   for(const preset of a.colorPresets!){expect(Object.keys(preset.colors).sort()).toEqual(a.colorParts!.map(p=>p.material).sort());expect(Object.values(preset.colors).every(c=>/^#[0-9a-f]{6}$/i.test(c))).toBe(true);}
  }
 });
 it('authors exactly two named eyes on the repaired turtle',()=>{
  const g=read(pets.find(p=>p.id==='pet_turtle'));
  expect(g.nodes.filter((n:any)=>/^Eye /.test(n.name)).map((n:any)=>n.name).sort()).toEqual(['Eye left','Eye right']);
 });
 it('preserves per-instance colors through save/import and keeps cloned palettes independent',()=>{
  const a=pets.find(p=>p.id==='pet_cat')!,home=createHome(catalog),room=home.rooms[0];
  const item={id:'pet-instance',assetId:a.id,x:0,y:.15,z:0,rotation:0,color:null,stored:false};
  room.items=[item];expect(applyFurnitureColorPreset(item,a,a.colorPresets![1].id)).toBe(true);
  const loaded=validateHome(JSON.parse(JSON.stringify(home)),catalog).rooms[0].items[0];expect(loaded).toEqual(item);
  const other=structuredClone(loaded);setFurniturePrimaryColor(other,a,'#123456');
  expect(loaded.materialColors['pet-body']).toBe('#383b40');expect(other.materialColors['pet-body']).toBeUndefined();
  expect(other.materialColors['pet-eyes']).toBe(loaded.materialColors['pet-eyes']);
  expect(furniturePartColor(other,a,a.colorParts![0])).toBe('#123456');
  expect(a.colorPresets![1].colors['pet-body']).toBe('#383b40');
  resetFurnitureColors(other);expect(other.color).toBeNull();expect(other.materialColors).toBeUndefined();
 });
 it('rejects foreign preset colors and exposes accurate controls after a preset',()=>{
  const a=pets[0],item={color:null};
  expect(applyFurnitureColorPreset(item,a,'no-such-preset')).toBe(false);
  const bad={...a,colorPresets:[{id:'bad',colors:{'not-a-material':'#aabbcc'}}]};
  expect(applyFurnitureColorPreset(item,bad,'bad')).toBe(false);expect(item).toEqual({color:null});
  applyFurnitureColorPreset(item,a,a.colorPresets![1].id);
  const html=paintPanel(item,a,'#ffffff');expect(html).toContain('value="#a6a9ad"');expect(html).toContain('全部恢复原色');expect(html).not.toContain('枕头');
 });
});
