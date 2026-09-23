import {describe,it,expect} from 'vitest';
import catalog from '../public/room3d/catalog.json';
import {createHome,boxes} from '../apps/room3d/model.js';
import {furnishShowroom} from '../apps/room3d/showrooms.js';
import {setBoundary} from '../apps/room3d/topology.js';
import {walkingMap,findWalkPath,doorTarget} from '../apps/room3d/navigation.js';

function setup(key:string){const home=createHome(catalog),room=home.rooms[0];room.items=[];furnishShowroom(room,key,catalog);setBoundary(home,room.id,'front',{kind:'wall_high',door:{kind:'oak',at:0,width:2.2}},catalog);return {home,room,get:(id:string)=>room.items.find(i=>i.assetId===id)!};}
const bounds=(item:any)=>boxes(item,catalog.find(a=>a.id===item.assetId))[0];
const front=(item:any)=>[Math.sin(item.rotation*Math.PI/180),Math.cos(item.rotation*Math.PI/180)];
function faces(a:any,b:any){const f=front(a),dx=b.x-a.x,dz=b.z-a.z;return (f[0]*dx+f[1]*dz)/Math.hypot(dx,dz);}

describe('showroom activity groups and real use routes',()=>{
 it('keeps fridge, sink/worktop and hob together on one wall, with a parallel island and outside seating',()=>{
  const {get}=setup('kitchen'),run=['kitchen_fridge','show_kitchen_counter','show_kitchen_range'].map(get);
  for(const item of run){expect(item.rotation).toBe(0);expect(item.z).toBeLessThan(-2.5);expect(Math.abs(item.z-run[0].z)).toBeLessThan(.15);}
  for(let i=1;i<run.length;i++){const gap=bounds(run[i])[0]-bounds(run[i-1])[3];expect(gap).toBeGreaterThanOrEqual(0);expect(gap).toBeLessThan(.3);}
  const island=get('show_kitchen_island'),counter=get('show_kitchen_counter'),seat=get('show_kitchen_bench');
  expect(island.rotation).toBe(counter.rotation);const aisle=bounds(island)[2]-bounds(counter)[5];
  expect(aisle).toBeGreaterThanOrEqual(1.9);expect(aisle).toBeLessThan(2.4);
  expect(seat.z).toBeGreaterThan(bounds(island)[5]);expect(faces(seat,island)).toBeGreaterThan(.99);
 });
 it('allows a large-headed resident to reach and move between all three kitchen workstations from the entry',()=>{
  const {home,room,get}=setup('kitchen'),map=walkingMap(home,0,catalog,{headWidth:1.8}),door=doorTarget(home,room,'front');
  const targets=['kitchen_fridge','show_kitchen_counter','show_kitchen_range'].map(id=>[get(id).x,-1.65]);
  for(const target of targets)expect(findWalkPath(map,door,target),'entry to '+target).toBeTruthy();
  for(let i=1;i<targets.length;i++)expect(findWalkPath(map,targets[i-1],targets[i])).toBeTruthy();
 });
 it('keeps the storage rack and trolley against the same side with reachable fronts',()=>{
  const {home,room,get}=setup('kitchen'),map=walkingMap(home,0,catalog,{headWidth:1.8});
  for(const id of ['kitchen_ref_rack','kitchen_ref_trolley']){const i=get(id);expect(i.x).toBeGreaterThan(3.5);expect(i.rotation).toBe(270);expect(findWalkPath(map,doorTarget(home,room,'front'),[2.4,i.z]),id).toBeTruthy();}
  expect(bounds(get('kitchen_ref_rack'))[5]).toBeLessThan(bounds(get('kitchen_ref_trolley'))[2]);
 });

 it('keeps the coffee station outside the work aisle and reachable from the entrance',()=>{
  const {home,room,get}=setup('kitchen'),cabinet=get('show_bedroom_dresser');
  expect(get('kitchenware_coffee').supportId).toBe(cabinet.id);
  const map=walkingMap(home,0,catalog,{headWidth:1.8}),target=[cabinet.x+1.35,cabinet.z];
  expect(findWalkPath(map,doorTarget(home,room,'front'),target)).toBeTruthy();
  expect(bounds(cabinet)[2]).toBeGreaterThan(-.75);
 });


});
