// @vitest-environment jsdom
import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {FaceControls} from '../experiments/chibi/FaceControls';
import {cleanFace} from '../apps/room3d/chibi/faceAppearance';
import type {HairSettings} from '../apps/room3d/chibi/types';
import {HUE_PALETTE,hexForTint} from '../apps/room3d/chibi/creatorHairTint';
vi.mock('../apps/room3d/chibi/faceAppearance',async importOriginal=>({...await importOriginal<any>(),loadFaceImages:()=>Promise.reject(new Error('No canvas in UI test'))}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let root:ReturnType<typeof createRoot>,host:HTMLDivElement;
afterEach(()=>{act(()=>root.unmount());host.remove();});
it('inherits both colors, edits one eye, preserves the other across eye presets and joins back to one color',()=>{
 let latest:HairSettings;
 function App(){const [hair,setHair]=useState<HairSettings>({layers:{},extras:[],face:cleanFace({useBaseEyes:true})});latest=hair;return React.createElement(FaceControls,{section:'eyes',hair,sourceEyeColors:{L:'#ff0000',R:'#0000ff'},onChange:setHair,onBegin:()=>{},onEnd:()=>{},mouthUse:'closed',onMouthUse:()=>{}});}
 host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);act(()=>root.render(React.createElement(App)));
 const click=(name:string)=>act(()=>host.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!.click());
 const value=(name:string)=>host.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!.value;
 expect(value('画面右眼颜色值')).toBe('#0000ff');
 const green={hueIdx:15,sat:50,light:0},brown={hueIdx:2,sat:50,light:0};
 for(const color of HUE_PALETTE)expect(host.querySelector(`[aria-label="画面左眼 ${color.name}"]`)).not.toBeNull();
 click('画面左眼 薄荷绿');expect(latest!.face!.useBaseEyes).toBe(true);expect(value('画面右眼颜色值')).toBe('#0000ff');
 click('眼型 02');expect(latest!.face).toMatchObject({useBaseEyes:false,upper:'02',irisColors:{L:hexForTint(green),R:'#0000ff'},irisTints:{L:green}});
 click('画面右眼 栗棕');expect(latest!.face!.irisColors).toEqual({L:hexForTint(green),R:hexForTint(brown)});
 act(()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='同色')!.click());
 expect(latest!.face).toMatchObject({heterochromia:false,irisColor:hexForTint(green),baseIrisColor:hexForTint(green),irisTint:green});expect(latest!.face!.irisColors).toBeUndefined();expect(latest!.face!.irisTints).toBeUndefined();
 click('恢复原眼睛颜色');expect(latest!.face!.irisTint).toBeUndefined();expect(latest!.face!.baseIrisColor).toBeUndefined();
});
it('keeps inherited preset lightness when changing eye style and leaves old hex-only choices intact',()=>{
 const tint={hueIdx:6,sat:50,light:50},hex=hexForTint(tint);let latest:HairSettings;
 function App(){const [hair,setHair]=useState<HairSettings>({layers:{},extras:[],face:cleanFace({useBaseEyes:true,irisColors:{R:'#6b9b83'}})});latest=hair;return React.createElement(FaceControls,{section:'eyes',hair,sourceEyeColors:{L:hex,R:hex},sourceEyeTints:{L:tint,R:tint},onChange:setHair,onBegin:()=>{},onEnd:()=>{},mouthUse:'closed',onMouthUse:()=>{}});}
 host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);act(()=>root.render(React.createElement(App)));
 act(()=>host.querySelector<HTMLButtonElement>('[aria-label="眼型 02"]')!.click());
 expect(latest!.face!.irisTints).toEqual({L:tint,R:undefined});expect(latest!.face!.irisColors).toEqual({L:hex,R:'#6b9b83'});
 expect(cleanFace(JSON.parse(JSON.stringify(latest!.face))).irisTints?.L).toEqual(tint);
});
