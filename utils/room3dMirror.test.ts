import {describe,it,expect} from 'vitest';
import catalog from '../public/room3d/catalog.json';
import {createHome} from '../apps/room3d/model.js';
import {furnishShowroom} from '../apps/room3d/showrooms.js';
import {mirrorActivities} from '../apps/room3d/mirror.js';
import {furnitureInteractions} from '../apps/room3d/furnitureInteractions.js';
import {mirrorFrame} from '../apps/room3d/mirrorMotion.js';

function setup(){const r=createHome(catalog).rooms[0];r.items=[];furnishShowroom(r,'bedroom',catalog);return {r,mirror:r.items.find(i=>i.assetId==='suite_floor_mirror')!,wardrobe:r.items.find(i=>i.assetId==='bedroom_ref_wardrobe')!};}
describe('mirror activities',()=>{
 it('offers admire alone, and outfit only with a placed wardrobe in the same room',()=>{
  const {r,mirror,wardrobe}=setup(),before=structuredClone(r),labels=()=>furnitureInteractions(r,catalog,mirror.id).map(a=>a.label);
  expect(labels()).toEqual(['臭美','穿搭']);expect(r).toEqual(before);
  wardrobe.stored=true;expect(labels()).toEqual(['臭美']);
  wardrobe.stored=false;wardrobe.ownerRoomId='other-room';mirror.ownerRoomId=r.id;
  expect(labels()).toEqual(['臭美']);
  wardrobe.ownerRoomId=r.id;expect(labels()).toHaveLength(2);
  wardrobe.assetId='bedroom_ref_sideboard';expect(labels()).toEqual(['臭美']);
  mirror.stored=true;expect(labels()).toEqual([]);
 });
 it('faces the real mirror for every rotation and refuses blocked front space',()=>{
  const {r,mirror}=setup();r.items=[mirror];mirror.x=mirror.z=0;
  for(const rotation of [0,90,180,270]){
   mirror.rotation=rotation;const [a]=mirrorActivities(r,catalog,{headWidth:1.8});expect(a.reason).toBe('');
   const dx=mirror.x-a.position[0],dz=mirror.z-a.position[2],toward=[Math.sin(a.rotation),Math.cos(a.rotation)];
   expect((dx*toward[0]+dz*toward[1])/Math.hypot(dx,dz)).toBeGreaterThan(.97);
  }
  mirror.rotation=0;r.items.push({...mirror,id:'blocker',assetId:'show_bed',x:0,z:1.4});
  expect(mirrorActivities(r,catalog)[0].reason).toContain('太挤');
 });
 it('retains owner and support dependencies, without putting mirror actions on a wardrobe',()=>{
  const {r,mirror,wardrobe}=setup();const acts=mirrorActivities(r,catalog,{headWidth:1.8});
  expect(acts.find(a=>a.itemId===mirror.id&&a.kind==='mirror-outfit')!.dependencies).toContain(wardrobe.id);
  expect(furnitureInteractions(r,catalog,wardrobe.id,{activities:acts})).toEqual([]);
  const top=r.items.find(i=>i.assetId==='bedroom_ref_dresser_top')!;
  expect(acts.find(a=>a.itemId===top.id)!.dependencies).toContain(top.supportId);
  r.items.find(i=>i.id===top.supportId)!.stored=true;
  expect(mirrorActivities(r,catalog).some(a=>a.itemId===top.id)).toBe(false);
 });
 it('keeps both gestures distinct, finite and inside rigid hand reach',()=>{
  expect(mirrorFrame('mirror-admire',1)).not.toEqual(mirrorFrame('mirror-outfit',1));
  for(const kind of ['mirror-admire','mirror-outfit'])for(let t=0;t<=12;t+=.25){
   const f=mirrorFrame(kind,t);expect(Math.abs(f.yaw)).toBeLessThanOrEqual(.16);
   for(const p of f.hands){expect(p.every(Number.isFinite)).toBe(true);expect(Math.abs(p[0])).toBeLessThan(.5);expect(p[1]).toBeLessThan(.8);}
  }
 });
});
