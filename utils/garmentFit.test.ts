import {describe,it,expect} from 'vitest';
import * as T from 'three';
import {cleanGarmentFit,fitForGarment,updateGarmentFit,scopeLegacyHemFits,garmentTransform,deformGarment,manualCoverage} from '../apps/room3d/chibi/garmentFit';
const box=new T.Box3(new T.Vector3(-1.4,2.3,-.3),new T.Vector3(1.4,3.4,.3));
describe('per-garment rest-space fitting',()=>{
 it('remembers skirt and trouser hem values independently, including an explicit zero',()=>{
  let saved=updateGarmentFit('basic-tee',undefined,{hemOpening:60},'sailor-skirt');
  expect(fitForGarment('basic-tee',saved,'lower-cargo').hemOpening).toBe(0);
  saved=updateGarmentFit('basic-tee',saved,{hemOpening:15},'lower-cargo');
  expect(fitForGarment('basic-tee',saved,'sailor-skirt').hemOpening).toBe(60);
  expect(fitForGarment('basic-tee',saved,'lower-cargo').hemOpening).toBe(15);
  saved=updateGarmentFit('basic-tee',saved,{hemOpening:0},'sailor-skirt');
  expect(fitForGarment('basic-tee',saved,'sailor-skirt').hemOpening).toBe(0);
  expect(fitForGarment('basic-tee',saved).hemOpening).toBe(0);
 });
 it('keeps shared edits and a reset from erasing other pairings',()=>{
  const first=updateGarmentFit('basic-tee',undefined,{hemOpening:60},'sailor-skirt');
  const second=updateGarmentFit('basic-tee',first,{hemOpening:15},'lower-cargo');
  const wider=updateGarmentFit('basic-tee',second,{width:120},'sailor-skirt');
  expect(fitForGarment('basic-tee',wider,'lower-cargo')).toMatchObject({width:120,hemOpening:15});
  const reset=updateGarmentFit('basic-tee',wider,cleanGarmentFit(),'sailor-skirt');
  expect(fitForGarment('basic-tee',reset,'sailor-skirt')).toMatchObject({width:100,hemOpening:0});
  expect(fitForGarment('basic-tee',reset,'lower-cargo').hemOpening).toBe(15);
  expect(first.hemOpeningByBottom).toEqual({'sailor-skirt':60});
 });
 it('binds a legacy hem to the saved pairing before changing clothes without mutating the draft',()=>{
  const original={'basic-tee':{hemOpening:40,width:110},'slouch-cardigan':{hemOpening:25}};
  const migrated=scopeLegacyHemFits(original,{top:'basic-tee',outer:'slouch-cardigan',bottom:'lower-long-skirt'});
  expect(fitForGarment('basic-tee',migrated['basic-tee'],'lower-long-skirt')).toMatchObject({hemOpening:40,width:110});
  expect(fitForGarment('basic-tee',migrated['basic-tee'],'lower-straight').hemOpening).toBe(0);
  expect(fitForGarment('slouch-cardigan',migrated['slouch-cardigan'],'lower-long-skirt').hemOpening).toBe(25);
  expect(original['basic-tee']).toEqual({hemOpening:40,width:110});
  expect(scopeLegacyHemFits(migrated,{top:'basic-tee',bottom:'lower-straight'})).toEqual(migrated);
 });
 it('sanitizes pairing values and distinguishes a onepiece from no lower garment',()=>{
  const saved=cleanGarmentFit({hemOpeningByBottom:{'lower-cargo':500,'sailor-skirt':NaN,bogus:50,none:-5}});
  expect(saved.hemOpeningByBottom).toEqual({'lower-cargo':100,none:0});
  const first=updateGarmentFit('slouch-cardigan',undefined,{hemOpening:25},'qipao');
  const second=updateGarmentFit('slouch-cardigan',first,{hemOpening:70});
  expect(fitForGarment('slouch-cardigan',second,'qipao').hemOpening).toBe(25);
  expect(fitForGarment('slouch-cardigan',second).hemOpening).toBe(70);
 });
 it('opens only a top or outer hem, preserving the chest, sleeves and old drafts',()=>{
  expect(cleanGarmentFit().hemOpening).toBe(0);expect(cleanGarmentFit({hemOpening:500}).hemOpening).toBe(100);
  for(const slot of ['top','outer'] as const){const open=garmentTransform(slot,cleanGarmentFit({hemOpening:100}),1,box),hem=new T.Vector3(.35,2.3,.25);
   expect(open(hem.clone()).x).toBeCloseTo(hem.x*1.45);expect(open(hem.clone()).z).toBeCloseTo(hem.z*1.45);expect(open(hem.clone()).y).toBe(hem.y);
   for(const p of [new T.Vector3(.25,2.9,.2),new T.Vector3(1.1,3.1,.2)])expect(open(p.clone()).distanceTo(p)).toBeLessThan(1e-6);
  }
  const p=new T.Vector3(.35,2.3,.25);expect(garmentTransform('bottom',cleanGarmentFit({hemOpening:100}),1,box)(p.clone()).distanceTo(p)).toBeLessThan(1e-6);
 });
 it('migrates old sleeve width without changing saved outfits',()=>{const fit=cleanGarmentFit({sleeveWidth:128});expect(fit.sleeveUpperWidth).toBe(128);expect(fit.sleeveLowerWidth).toBe(128);expect(fit.sleeveOpening).toBe(0);expect(cleanGarmentFit({sleeveWidth:128,sleeveUpperWidth:90}).sleeveLowerWidth).toBe(128);});
 it('adjusts sleeve halves independently and flares only the opening, for long and short sleeves',()=>{
  for(const end of [1.4,.85]){
   const bounds=new T.Box3(new T.Vector3(-end,2.3,-.3),new T.Vector3(end,3.4,.3));
   const start=.3,span=end-start,point=(t:number)=>new T.Vector3(start+span*t,3.325,-.0106);
   const upper=garmentTransform('top',cleanGarmentFit({sleeveUpperWidth:150}),1,bounds),lower=garmentTransform('top',cleanGarmentFit({sleeveLowerWidth:150}),1,bounds),open=garmentTransform('top',cleanGarmentFit({sleeveOpening:100}),1,bounds);
   expect(upper(point(.25)).y).toBeGreaterThan(point(.25).y);
   expect(upper(point(.9)).y).toBeCloseTo(point(.9).y);
   expect(lower(point(.25)).y).toBeCloseTo(point(.25).y);
   expect(lower(point(.9)).y).toBeGreaterThan(point(.9).y);
   expect(open(point(.5)).y).toBeCloseTo(point(.5).y);
   expect(open(point(1)).y-3.125).toBeCloseTo(.4);
   expect(open(new T.Vector3(.1,3.3,.1)).toArray()).toEqual([.1,3.3,.1]);
  }
 });
 it('defaults preserve authored positions and normals',()=>{const g=new T.BoxGeometry(.8,1,.4);g.translate(0,2.8,0);const p=Array.from(g.attributes.position.array),n=Array.from(g.attributes.normal.array);deformGarment(g,garmentTransform('top',cleanGarmentFit(),1,box));Array.from(g.attributes.position.array).forEach((v,i)=>expect(v).toBeCloseTo(p[i],6));Array.from(g.attributes.normal.array).forEach((v,i)=>expect(v).toBeCloseTo(n[i],6));});
 it('sleeve length extends arms symmetrically without moving the neckline; lower length anchors waist',()=>{const top=garmentTransform('top',cleanGarmentFit({sleeveLength:120}),1,box);expect(top(new T.Vector3(.1,3.3,0)).x).toBeCloseTo(.1);expect(top(new T.Vector3(1,3.125,0)).x).toBeCloseTo(1.14);expect(top(new T.Vector3(-1,3.125,0)).x).toBeCloseTo(-1.14);const bottom=garmentTransform('bottom',cleanGarmentFit({length:130}),1,box);expect(bottom(new T.Vector3(0,box.max.y,0)).y).toBe(box.max.y);expect(bottom(new T.Vector3(0,box.min.y,0)).y).toBeLessThan(box.min.y);});
 it('rejects invalid stored values and leaves unselected skin regions visible',()=>{const fit=cleanGarmentFit({width:Infinity,depth:800,offsetY:NaN,hide:['torso','bogus'] as never});expect(fit.width).toBe(100);expect(fit.depth).toBe(150);expect(fit.offsetY).toBe(0);expect(fit.hide).toEqual(['torso']);expect(manualCoverage(new T.Vector3(0,2.8,0),fit.hide,1)).toBe(true);expect(manualCoverage(new T.Vector3(1.5,3.1,0),fit.hide,1)).toBe(false);});
 it('sleeve ease accepts inward values and leaves the torso unchanged',()=>{const fit=cleanGarmentFit({clearance:0,sleeveClearance:-4}),transform=garmentTransform('top',fit,1,box),torso=new T.Vector3(.1,2.8,.2),sleeve=new T.Vector3(1,3.325,-.0106);expect(transform(torso.clone()).distanceTo(torso)).toBeLessThan(1e-6);expect(transform(sleeve.clone()).y).toBeCloseTo(sleeve.y-.04);const bodyOnly=garmentTransform('top',cleanGarmentFit({clearance:4,sleeveClearance:0}),1,box);expect(bodyOnly(sleeve.clone()).distanceTo(sleeve)).toBeLessThan(1e-6);expect(cleanGarmentFit({clearance:3}).sleeveClearance).toBe(3);expect(cleanGarmentFit({clearance:-3}).clearance).toBe(-3);});
 it('positions and rotates headwear around its own center',()=>{const headBox=new T.Box3(new T.Vector3(.1,4.4,-.1),new T.Vector3(.5,4.6,.1)),center=headBox.getCenter(new T.Vector3()),p=center.clone().add(new T.Vector3(.2,0,0));const transform=garmentTransform('headwear',cleanGarmentFit({rotateZ:90,offsetX:-10,offsetY:5,offsetZ:-8}),1,headBox);expect(transform(p).distanceTo(center.clone().add(new T.Vector3(-.1,.25,-.08)))).toBeLessThan(1e-6);});
});
