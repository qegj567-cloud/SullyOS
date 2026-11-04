import {describe,it,expect} from 'vitest';
import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as T from 'three';
import {approvedGarments,approvedPresets,cleanApprovedWardrobe} from '../apps/room3d/chibi/approvedWardrobe';
import {outfitClothes,applyOutfit,exportOutfit,importOutfit} from '../apps/room3d/chibi/outfitLibrary';
import {createGarmentColorController} from '../apps/room3d/chibi/wardrobeColors';
import {halloweenCoverage} from '../apps/room3d/chibi/halloweenCoverage';
describe('Halloween published wardrobe',()=>{
 it('loads one compressed garment at a time and shares content-addressed textures within an 8 MB budget',()=>{
  const items=approvedGarments.filter(g=>g.collection==='halloween'),files=new Set<string>();
  expect(new Set(items.map(g=>g.asset)).size).toBe(items.length);
  for(const item of items){
   const bytes=readFileSync(`public/room3d/wardrobe/${item.asset}`),json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());files.add(item.asset);
   expect(bytes.length).toBeLessThan(1_000_000);expect(createHash('sha256').update(bytes).digest('hex').slice(0,12)).toBe(item.revision);
   expect(json.extensionsRequired).toContain('EXT_meshopt_compression');
   expect(json.nodes.filter((n:any)=>n.mesh!==undefined).every((n:any)=>n.name.startsWith(item.prefix))).toBe(true);
   for(const image of json.images??[])if(image.uri){expect(image.uri).toMatch(/^halloween-texture-[a-f0-9]{12}\.jpg$/);files.add(image.uri);}
  }
  expect([...files].reduce((sum,file)=>sum+statSync(`public/room3d/wardrobe/${file}`).size,0)).toBeLessThan(8_000_000);
 });
 it('retains every independent piece and all palette choices through saving and sharing',()=>{
  expect(approvedGarments.filter(g=>g.collection==='halloween')).toHaveLength(25);
  const presets=Object.entries(approvedPresets).filter(([,p])=>p.collection==='halloween');expect(presets).toHaveLength(20);
  expect(presets.some(([id])=>id.startsWith('halloween-shorts-'))).toBe(false);
  expect(approvedGarments.find(g=>g.id==='halloween-shorts-shorts')?.slot).toBe('bottom');
  for(const [id,p]of presets){expect(cleanApprovedWardrobe(p.items)).toEqual(p.items);const saved={id,name:p.label,clothes:outfitClothes(p.clothes!)};const restored=importOutfit(exportOutfit(saved));expect(restored.clothes).toEqual(saved.clothes);expect(applyOutfit({layers:{},extras:[],skinColor:'#ab9876'},restored).skinColor).toBe('#ab9876');if(!id.endsWith('-original'))expect(Object.keys(restored.clothes.wardrobeColors)).toHaveLength(Object.keys(p.items).length);}
 });
 it('keeps dye uniforms private and resets each channel without modifying source textures',()=>{
  const source=new T.MeshStandardMaterial({map:new T.Texture()}),a=source.clone(),b=source.clone();const ua=createGarmentColorController(a,'halloween-witch-dress',0),ub=createGarmentColorController(b,'halloween-witch-dress',0);
  const sa={uniforms:{},fragmentShader:'#include <map_fragment>'} as any,sb={uniforms:{},fragmentShader:'#include <map_fragment>'} as any;a.onBeforeCompile(sa,{} as any);b.onBeforeCompile(sb,{} as any);
  ua({orange:'#16151d'});ub({purple:'#711a30'});expect(sa.uniforms.dye_active.value.toArray()).toEqual([1,0,0,0]);expect(sb.uniforms.dye_active.value.toArray()).toEqual([0,1,0,0]);ua();expect(sa.uniforms.dye_active.value.toArray()).toEqual([0,0,0,0]);expect(sb.uniforms.dye_active.value.y).toBe(1);expect(a.map).toBe(source.map);expect(source.map!.version).toBe(0);
 });
 it('does not hide legs or the neck for a standalone hat or collar accessory',()=>{
  for(const part of ['hat','cap','cravat','apron'])for(const y of [.3,1,2,3.4])expect(halloweenCoverage(part,'witch',.2,y)).toBe(false);
  expect(halloweenCoverage('socks','witch',.25,1.1)).toBe(true);expect(halloweenCoverage('socks','witch',.25,1.3)).toBe(false);expect(halloweenCoverage('dress','witch',0,3.5)).toBe(false);
 });
});
