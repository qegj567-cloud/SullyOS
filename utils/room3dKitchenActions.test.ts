import {describe,it,expect} from 'vitest';
import * as T from 'three';
import catalog from '../public/room3d/catalog.json';
import {createHome} from '../apps/room3d/model.js';
import {furnishShowroom} from '../apps/room3d/showrooms.js';
import {planKitchenAction,kitchenActions,kitchenFingerprint} from '../apps/room3d/kitchenActivities.js';
import {createKitchenWorkEffects} from '../apps/room3d/kitchenWorkEffects.js';
function setup(){const h=createHome(catalog),r=h.rooms[0];r.items=[];furnishShowroom(r,'kitchen',catalog);return {h,r,get:(id:string)=>r.items.find(i=>i.assetId===id)!};}
describe('kitchen work routes and lifecycle',()=>{
 it.each(['kitchenware_coffee','kitchen_ref_prep','kitchen_ref_breakfast','show_kitchen_range'])('plans a reachable activity for %s',id=>{
  const {h,r,get}=setup(),plan=planKitchenAction(h,r,catalog,get(id).id,[0,2.9],1.8);
  expect(plan.reason).toBeUndefined();expect(plan.source.path.length).toBeGreaterThan(0);
  if(plan.kind==='wash'){expect(plan.sink.id).toBe(get('show_kitchen_counter').id);expect(plan.sink.path.length).toBeGreaterThan(0);}
 });
 it('requires a present sink in the same room and detects changed dependencies',()=>{
  const {h,r,get}=setup(),item=get('kitchen_ref_prep'),p=planKitchenAction(h,r,catalog,item.id,[0,2.9]);
  h.rooms.push({...r,id:'other',x:1,items:[{...get('show_kitchen_counter'),id:'other-sink'}]});
  get('show_kitchen_counter').stored=true;
  expect(kitchenFingerprint(r,p.dependencies)).not.toBe(p.fingerprint);
  expect(kitchenActions(r,catalog,item.id)[0].reason).toContain('同一个房间');
  expect(kitchenActions(r,catalog,get('suite_plant_large').id)).toEqual([]);
 });
 it('does not plan a route through blocking furniture',()=>{
  const {h,r,get}=setup();const blocker={id:'block',assetId:'block',x:0,y:.15,z:0,rotation:0,stored:false};r.items.push(blocker as any);
  const assets=[...catalog,{id:'block',surface:'floor',size:[9,3,6],boxes:[[-4.5,0,-3,4.5,3,3]]}];
  expect(planKitchenAction(h,r,assets,get('kitchenware_coffee').id,[0,2.9]).reason).toBeTruthy();
 });
 it('reuses temporary geometry and clears props when interrupted',()=>{
  const resident=new T.Group(),fx=createKitchenWorkEffects(resident),count=fx.root.children.length;
  const task={kind:'wash',stage:'work',carrying:true,sink:{point:[0,1,0]}};
  for(let i=0;i<100;i++)fx.update(task,i/10,[[-.2,.7,.3],[.2,.7,.3]]);
  expect(fx.root.children.length).toBe(count);expect(fx.root.visible).toBe(true);
  fx.clear();expect(fx.root.visible).toBe(false);fx.dispose();expect(resident.children).toHaveLength(0);
 });
});
