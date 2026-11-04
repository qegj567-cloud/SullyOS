// @vitest-environment jsdom
import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it} from 'vitest';
import {HairDyeControls} from '../experiments/chibi/HairDyeControls';
import {HUE_PALETTE,hexForTint} from '../apps/room3d/chibi/creatorHairTint';
import type {HairSettings} from '../apps/room3d/chibi/types';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it('retains source colors until edited, persists Chibi palette parameters and resets gradient overrides together',()=>{
 let latest:HairSettings={layers:{},extras:[]};
 function App(){const [hair,setHair]=useState(latest);latest=hair;return React.createElement(HairDyeControls,{hair,onChange:setHair,onBegin:()=>{},onEnd:()=>{}});}
 const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
 try{
  act(()=>root.render(React.createElement(App)));
  const click=(text:string)=>act(()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===text||b.getAttribute('aria-label')===text)!.click());
  click('纯色');expect(latest.hairColor).toBeUndefined();
  for(const swatch of HUE_PALETTE)expect(host.querySelector(`[aria-label="发色 ${swatch.name}"]`)).not.toBeNull();
  click('发色 奶白银');expect(latest.hairTint).toEqual({hueIdx:6,sat:50,light:0,color:undefined});expect(latest.hairColor).toBe(hexForTint(latest.hairTint!));
  const saved=JSON.parse(JSON.stringify(latest));expect(saved.hairTint).toMatchObject({hueIdx:6,sat:50,light:0});
  click('渐变');expect(latest.hairTipColor).toBe('#ecc5d5');expect(latest.hairTint?.color).toBe(saved.hairColor);
  click('恢复原发根');expect(latest.hairColor).toBeUndefined();expect(latest.hairTint).toBeUndefined();expect(latest.hairTipColor).toBeUndefined();
 }finally{act(()=>root.unmount());host.remove();}
});
