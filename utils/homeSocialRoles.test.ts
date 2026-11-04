// @vitest-environment jsdom
import React,{act,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,it,expect,vi} from 'vitest';
import {HomeSocialPanel} from '../apps/room3d/HomeSocialPanel';
import {selectedMotions} from '../apps/room3d/chibi/selectedMotions';
vi.mock('../utils/creatorPartsBlob',()=>({loadCreatorPartsForRender:async()=>[]}));
vi.mock('../apps/room3d/chibi/visitor',()=>({decodeParts:async()=>({}),createVisitor:async()=>({dispose:()=>{}})}));
vi.mock('../apps/room3d/chibi/CreatorRollBridge',()=>({CreatorRollBridge:({request,onReady,onResult}:any)=>{useEffect(()=>onReady(),[]);useEffect(()=>{if(request)onResult({state:{}});},[request]);return null;}}));
vi.mock('../apps/room3d/HomeSocialWheel',()=>({HomeSocialWheel:({actor,available,onPlay}:any)=>React.createElement('div',{'data-target':actor},...[1,2].map(n=>{const motion=selectedMotions.find(m=>m.participants===n)!;return React.createElement('button',{key:n,disabled:!available(motion),onClick:()=>onPlay(motion.id)},String(n));}))}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const host=document.createElement('div');document.body.append(host);let root:ReturnType<typeof createRoot>;
const editor={getState:()=>({}),getHomeScene:()=>({present:true}),getPresentResidents:()=>[],setPrimaryResidentId:vi.fn(),cancelSocial:vi.fn(),setSocialResident:vi.fn(),removeSocialResident:vi.fn(),playSocial:vi.fn(async()=>true)};
async function render(targetId='char',withUser=true){root=createRoot(host);await act(async()=>root.render(React.createElement(HomeSocialPanel,{editor:editor as any,primary:{id:'char',label:'Sully'},options:withUser?[{id:'user',label:'我',state:{}}]:[],body:'classic',onBody:()=>{},mainReady:true,hair:{} as any,externalOpen:true,targetId})));}
afterEach(()=>{act(()=>root.unmount());vi.clearAllMocks();});
it.each([1,2])('always executes %s-person actions as the user when clicking the character',async n=>{await render();expect(host.querySelector('[data-target]')!.getAttribute('data-target')).toBe('char');await act(async()=>host.querySelectorAll('button')[n-1].click());expect(editor.playSocial).toHaveBeenCalledWith(selectedMotions.find(m=>m.participants===n)!.id,'user','char');});
it('clicking yourself anchors to yourself and does not supply another actor',async()=>{await render('user');await act(async()=>host.querySelector('button')!.click());expect(editor.playSocial).toHaveBeenCalledWith(selectedMotions.find(m=>m.participants===1)!.id,'user','');expect(host.querySelector('[data-target]')!.getAttribute('data-target')).toBe('user');});
it('never falls back to controlling the character when the user has no avatar',async()=>{await render('char',false);expect(host.querySelector('button')!.disabled).toBe(true);await act(async()=>host.querySelector('button')!.click());expect(editor.playSocial).not.toHaveBeenCalled();});
