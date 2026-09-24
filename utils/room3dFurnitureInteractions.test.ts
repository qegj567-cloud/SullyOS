import {describe,it,expect} from 'vitest';
import catalog from '../public/room3d/catalog.json';
import {createHome} from '../apps/room3d/model.js';
import {furnishShowroom} from '../apps/room3d/showrooms.js';
import {gamingPreset,gamingActivities} from '../apps/room3d/gaming.js';
import {diningPreset,diningActivities} from '../apps/room3d/dining.js';
import {furnitureInteractions,interactionArcLayout} from '../apps/room3d/furnitureInteractions.js';
import {roomPixelRatio} from '../apps/room3d/renderQuality.js';
const bedroom=()=>{const r=createHome(catalog).rooms[0];r.items=[];furnishShowroom(r,'bedroom',catalog,{compact:true});return r;};
describe('furniture-local action menus',()=>{
 it('scales the wheel with its furniture and supersamples only desktop Clear at 1×',()=>{
  const view={x:600,y:400,width:1200,height:900,count:2};
  const far=interactionArcLayout({...view,modelWidth:190}),near=interactionArcLayout({...view,modelWidth:320});
  expect(far.width).toBeLessThan(near.width);expect(far.left+far.width/2).toBe(600);expect(near.left+near.width/2).toBe(600);
  expect(roomPixelRatio('clear',1,false)).toBe(1.5);expect(roomPixelRatio('clear',1,true)).toBe(1);
  expect(roomPixelRatio('balanced',1,false)).toBe(1);expect(roomPixelRatio('eco',3,false)).toBe(.75);expect(roomPixelRatio('clear',3,false)).toBe(1.5);
 });
 it('uses authored bed sides and offers standing up only on the occupied furniture',()=>{
  const r=bedroom(),bed=r.items.find(i=>i.assetId==='show_bed')!,before=structuredClone(r),actions=furnitureInteractions(r,catalog,bed.id);
  expect(actions.map(a=>a.label)).toEqual(['睡左边','睡右边']);expect(actions.map(a=>a.seat)).toEqual(['0','1']);expect(r).toEqual(before);
  expect(furnitureInteractions(r,catalog,bed.id,{seat:{itemId:bed.id}}).at(-1)?.action).toBe('chibi-stand');
  expect(furnitureInteractions(r,catalog,bed.id,{seat:{itemId:'other'}})).toHaveLength(2);
  bed.stored=true;expect(furnitureInteractions(r,catalog,bed.id)).toEqual([]);
 });
 it('offers the mirror actions and distinguishes floor/tabletop plants',()=>{
  const r=bedroom(),actions=(assetId:string)=>furnitureInteractions(r,catalog,r.items.find(i=>i.assetId===assetId)!.id);
  expect(actions('suite_floor_mirror').map(a=>a.kind)).toEqual(['mirror-admire','mirror-outfit']);expect(actions('suite_plant_small')).toEqual([]);
  expect(actions('suite_plant_large')).toMatchObject([{action:'chibi-water',reason:''}]);
  r.items.find(i=>i.assetId==='suite_plant_large')!.x=4.5;r.items.find(i=>i.assetId==='suite_plant_large')!.z=3.8;
  expect(actions('suite_plant_large')[0].reason).not.toBe('');
 });
 it('routes clicking computer parts or chairs to the correct station and preserves unmet requirements',()=>{
  const r={...createHome(catalog).rooms[0],items:gamingPreset('stream',catalog)},activities=gamingActivities(r,catalog);
  for(const id of ['gaming_desk','gaming_monitors','gaming_chair']){
   const i=r.items.find(i=>i.assetId===id)!,actions=furnitureInteractions(r,catalog,i.id,{activities}).filter(a=>a.action==='chibi-game');
   expect(actions.map(a=>a.kind)).toEqual(['computer','stream']);expect(actions.every(a=>a.id===r.items[0].id)).toBe(true);
  }
  r.items=r.items.filter(i=>i.assetId!=='gaming_monitors');const broken=gamingActivities(r,catalog);
  expect(furnitureInteractions(r,catalog,r.items[0].id,{activities:broken}).find(a=>a.kind==='computer')?.reason).toContain('显示器');
 });
 it('keeps both meal positions distinct and exposes existing fridge and plush controls',()=>{
  const r={...createHome(catalog).rooms[0],items:diningPreset(catalog)},activities=diningActivities(r,catalog);
  const options=furnitureInteractions(r,catalog,r.items[0].id,{activities});expect(options).toHaveLength(2);expect(new Set(options.map(a=>a.station)).size).toBe(2);
  for(const [assetId,action]of [['kitchen_fridge','fridge-toggle'],['bedroom_rabbit','chibi-hug']]){
   const item={...r.items[0],id:assetId,assetId};r.items=[item];expect(furnitureInteractions(r,catalog,item.id)[0]?.action).toBe(action);
  }
 });
 it('flips the arc at the right edge and keeps touch targets on portrait and short landscape screens',()=>{
  for(const [width,height,count]of [[390,844,4],[844,390,1],[1200,900,4]])for(const x of [0,width-2]){
   const layout=interactionArcLayout({x,y:height-2,width,height,count});expect(layout.left).toBeGreaterThanOrEqual(0);expect(layout.left+layout.width).toBeLessThanOrEqual(width);
   for(const p of layout.points){expect(layout.top+p.y-29).toBeGreaterThan(0);expect(layout.top+p.y+29).toBeLessThan(height-75);}
   if(x===width-2)expect(layout.side).toBe('left');
  }
 });
});
