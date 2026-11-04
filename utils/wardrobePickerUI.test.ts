// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,it,expect,vi} from 'vitest';
import {WardrobePicker} from '../experiments/chibi/WardrobePicker';
import {approvedPresets} from '../apps/room3d/chibi/approvedWardrobe';
import builtinOutfits from '../apps/room3d/chibi/builtinOutfits.json';
vi.mock('../apps/room3d/ResourcePackPanel',async importOriginal=>({...await importOriginal<any>(),confirmResourcePack:vi.fn(async()=>true),useResourcePackInstalled:()=>true}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const host=document.createElement('div');document.body.appendChild(host);let root:ReturnType<typeof createRoot>;
afterEach(()=>act(()=>root.unmount()));
it('adds animal accessories without stripping the legacy initial outfit',()=>{
 const change=vi.fn();root=createRoot(host);act(()=>root.render(React.createElement(WardrobePicker,{hair:{layers:{},extras:[],bodyShape:'blank'},onChange:change})));
 act(()=>[...host.querySelectorAll<HTMLButtonElement>('nav button')].find(b=>b.textContent==='兽耳')!.click());
 act(()=>host.querySelector<HTMLButtonElement>('[aria-label="猫耳"]')!.click());
 expect(change.mock.lastCall![0].wardrobe).toEqual({...approvedPresets.original.items,ears:'cat-ears'});
});
it('offers image tiles for every outfit and applies its complete items',async()=>{
 const change=vi.fn();root=createRoot(host);act(()=>root.render(React.createElement(WardrobePicker,{hair:{layers:{},extras:[],bodyShape:'blank'},onChange:change})));
 for(const seasonal of [false,true]){
 act(()=>[...host.querySelectorAll<HTMLButtonElement>('nav button')].find(b=>b.textContent===(seasonal?'万圣节专属衣柜':'套装'))!.click());
 const grid=host.querySelector('[aria-label="套装款式"]')!;
 const presets=Object.entries(approvedPresets).filter(([,p])=>(p.collection==='halloween')===seasonal);
 expect(grid.querySelectorAll('button')).toHaveLength(presets.length);
 for(const [id,p] of presets){
  const tile=grid.querySelector<HTMLButtonElement>(`[aria-label="${p.label}"]`)!;
  expect(tile.querySelector(`[aria-label="${p.label}整套穿着预览"]`)).not.toBeNull();
  await act(async()=>tile.click());expect(change.mock.lastCall![0].wardrobe).toEqual(p.items);
 }
 }
});
it('keeps advanced clothing controls collapsed below the image choices',()=>{
 root=createRoot(host);act(()=>root.render(React.createElement(WardrobePicker,{hair:{layers:{},extras:[],wardrobe:approvedPresets.summer.items},onChange:vi.fn()})));
 act(()=>[...host.querySelectorAll<HTMLButtonElement>('nav button')].find(b=>b.textContent?.startsWith('上衣'))!.click());
 expect(host.querySelector('[aria-label="上衣款式"] img')).not.toBeNull();
 expect(host.querySelector<HTMLDetailsElement>('[aria-label="衣服调整"]')!.open).toBe(false);
 expect(host.querySelector<HTMLDetailsElement>('[aria-label="叠穿辅助整理"]')!.open).toBe(false);
});
it('applies all six authored outfits without losing fits, colors or layering to the previous outfit',()=>{
 const change=vi.fn(),hair={layers:{},extras:[],headSize:1.2,wardrobe:{top:'original-hoodie'},wardrobeFits:{'original-hoodie':{width:125}},wardrobeColors:{'original-hoodie':{fur:'#ff0000'}},wardrobeLayering:false};
 root=createRoot(host);act(()=>root.render(React.createElement(WardrobePicker,{hair,onChange:change})));
 expect(host.querySelector('[aria-label="开衫搭配"]')).toBeNull();
 expect(host.querySelector('[aria-label="学院搭配"]')).toBeNull();
 for(const outfit of builtinOutfits){
  act(()=>host.querySelector<HTMLButtonElement>(`[aria-label="${outfit.name}"]`)!.click());
  const applied=change.mock.lastCall![0];
  expect(applied).toMatchObject({headSize:1.2,...outfit.clothes});
  expect(applied.wardrobeFits).toEqual(outfit.clothes.wardrobeFits);
  expect(applied.wardrobeColors).toEqual(outfit.clothes.wardrobeColors);
 }
});
