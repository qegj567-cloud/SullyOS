import {describe,it,expect} from 'vitest';
import * as T from 'three';
import catalog from '../public/room3d/catalog.json';
import {bathroomHome} from '../test/fixtures/bathroom-layout.js';
import {bathroomActivities} from '../apps/room3d/bathroom.js';
import {furnitureInteractions} from '../apps/room3d/furnitureInteractions.js';
import {createBathroomEffects} from '../apps/room3d/bathroomEffects.js';
describe('bathroom actions',()=>{
 it('offers four usable actions in the furnished room without changing its saved layout',()=>{
  const r=bathroomHome(catalog).rooms[0],before=structuredClone(r),actions=bathroomActivities(r,catalog,{headWidth:1.8});
  expect(actions.map(a=>a.label).sort()).toEqual(['坐','泡泡浴','洗澡','洗衣'].sort());
  for(const a of actions){expect(a.reason,a.kind).toBe('');expect(furnitureInteractions(r,catalog,a.itemId).some(v=>v.label===a.label)).toBe(true);}
  expect(actions.find(a=>a.kind==='bath-toilet')?.posture).toBe('seated');expect(r).toEqual(before);
  r.items.find(i=>i.assetId==='bath_washer')!.stored=true;expect(bathroomActivities(r,catalog).some(a=>a.kind==='bath-laundry')).toBe(false);
 });
 it('restores washer position on stop/switch and suppresses vibration with reduced motion',()=>{
  const effects=createBathroomEffects(),obj=new T.Group();obj.userData.itemId='washer';obj.position.set(4,.15,1);const start=obj.position.clone(),a={itemId:'washer',kind:'bath-laundry'};
  effects.update([obj],a,1);expect(obj.position.equals(start)).toBe(false);
  effects.update([obj],a,2,true);expect(obj.position.equals(start)).toBe(true);
  effects.update([obj],a,3);effects.update([obj],null,0);expect(obj.position.equals(start)).toBe(true);expect(obj.children).toHaveLength(0);
  effects.dispose();
 });
 it('reuses shower and bubble meshes and removes them when stopped',()=>{
  const effects=createBathroomEffects(),obj=new T.Group();obj.userData.itemId='tub';
  effects.update([obj],{itemId:'tub',kind:'bath-soak'},1);const meshes=[...obj.children[0].children];
  effects.update([obj],{itemId:'tub',kind:'bath-shower'},2);expect(obj.children[0].children).toEqual(meshes);
  expect(meshes.every(m=>m.position.toArray().every(Number.isFinite))).toBe(true);effects.clear();expect(obj.children).toHaveLength(0);effects.dispose();
 });
});
