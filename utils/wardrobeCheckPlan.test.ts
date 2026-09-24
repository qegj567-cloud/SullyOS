import {describe,it,expect} from 'vitest';
import {approvedGarments} from '../apps/room3d/chibi/approvedWardrobe';
import {garmentLayeringAssignments,layeringForGarment,usesPosedInnerFit} from '../apps/room3d/chibi/wardrobeLayering';
import {planWardrobeChecks,validateLayeringCatalog} from '../apps/room3d/chibi/wardrobeCheckPlan';

describe('garment onboarding',()=>{
 it('requires every shipped garment to declare compatible construction',()=>{
  expect(validateLayeringCatalog()).toEqual([]);
  expect(Object.keys(garmentLayeringAssignments).sort()).toEqual(approvedGarments.map(g=>g.id).sort());
  expect(validateLayeringCatalog([...approvedGarments,{id:'new-shirt',slot:'top'}])).toContain('new-shirt: 缺少有效叠穿配置');
  expect(()=>planWardrobeChecks(['typo'])).toThrow('未知服装');
 });
 it('reuses a profile for a newly registered ID without adding algorithm branches',()=>{
  garmentLayeringAssignments['new-shirt']='loose-shirt';
  try{
   expect(usesPosedInnerFit('new-shirt')).toBe(true);
   expect(layeringForGarment('new-shirt')).toEqual(layeringForGarment('collar-shirt'));
   expect(validateLayeringCatalog([{id:'new-shirt',slot:'outer'}]).length).toBeGreaterThan(0);
  }finally{delete garmentLayeringAssignments['new-shirt'];}
  expect(usesPosedInnerFit('unknown')).toBe(false);
 });
 it('checks a new top against every outer and representative lowerwear only',()=>{
  const plan=planWardrobeChecks(['collar-shirt']);
  expect(plan.every(w=>w.top==='collar-shirt')).toBe(true);
  expect([...new Set(plan.filter(w=>w.outer).map(w=>w.outer))].sort()).toEqual(approvedGarments.filter(g=>g.slot==='outer').map(g=>g.id).sort());
  expect(plan.some(w=>w.outer==='belt-coat'&&w.bottom==='lower-long-skirt')).toBe(true);
  expect(new Set(plan.filter(w=>w.bottom).map(w=>layeringForGarment(w.bottom!).lower)).size).toBe(3);
 });
 it('includes all inner structures, skirts, onepieces and footwear interactions',()=>{
  const outer=planWardrobeChecks(['belt-coat']);
  expect(new Set(outer.filter(w=>w.top).map(w=>layeringForGarment(w.top!).inner)).size).toBe(4);
  expect(outer.some(w=>w.bottom==='lower-long-skirt')).toBe(true);
  expect(outer.some(w=>w.onepiece==='qipao')).toBe(true);
  expect(planWardrobeChecks(['original-shoes']).some(w=>w.socks==='original-socks')).toBe(true);
  expect(planWardrobeChecks(['lower-straight']).some(w=>w.shoes==='tall-boots')).toBe(true);
  const all=planWardrobeChecks(approvedGarments.map(g=>g.id));
  expect(new Set(all.map(w=>JSON.stringify(w))).size).toBe(all.length);
 });
});
