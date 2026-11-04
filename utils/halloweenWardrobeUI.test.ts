// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,it,expect,vi} from 'vitest';
import {HalloweenWardrobe} from '../experiments/chibi/HalloweenWardrobe';
import {approvedPresets} from '../apps/room3d/chibi/approvedWardrobe';
import {applyOutfit} from '../apps/room3d/chibi/outfitLibrary';
vi.mock('../experiments/chibi/OutfitPreview',()=>({OutfitPreview:()=>null}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let root:ReturnType<typeof createRoot>;
afterEach(()=>act(()=>root?.unmount()));
it('shows one tile per style, then changes color without resetting tailoring or the face',async()=>{
 const host=document.createElement('div');root=createRoot(host);
 const preset=approvedPresets['halloween-witch-crimson'];
 let hair=applyOutfit({layers:{},extras:[],skinColor:'#abcdef'},{id:'old',name:'旧搭配',clothes:preset.clothes!});
 hair.wardrobeFits={'halloween-witch-hat':{scale:135}};
 const render=()=>root.render(React.createElement(HalloweenWardrobe,{hair,installed:true,onSelect:next=>{hair=next;render();}}));
 await act(async()=>render());
 expect(host.querySelectorAll('[aria-label="万圣节套装款式"] button')).toHaveLength(5);
 const color=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!;
 expect(color('绯红夜宴').getAttribute('aria-pressed')).toBe('true');
 await act(async()=>color('月光蓝').click());
 expect(hair.wardrobeColors['halloween-witch-dress']).toEqual(approvedPresets['halloween-witch-moonlight'].clothes!.wardrobeColors['halloween-witch-dress']);
 expect(hair.wardrobeFits['halloween-witch-hat'].scale).toBe(135);expect(hair.skinColor).toBe('#abcdef');
 await act(async()=>color('经典万圣节').click());expect(hair.wardrobeColors).toEqual({});
});
