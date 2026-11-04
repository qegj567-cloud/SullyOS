// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,it,expect,vi} from 'vitest';
import {HomeSocialWheel} from '../apps/room3d/HomeSocialWheel';
import {selectedMotions} from '../apps/room3d/chibi/selectedMotions';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const host=document.createElement('div');document.body.append(host);let root:ReturnType<typeof createRoot>;
const onPlay=vi.fn(),onClose=vi.fn(),onSettings=vi.fn();
async function render(available=()=>true,selfOnly=false,seated=false,body:'classic'|'blank'='classic',romantic=true){root=createRoot(host);await act(async()=>root.render(React.createElement(HomeSocialWheel,{editor:{canPlaySocial:()=>romantic,getResidentPosture:()=>seated?'seated':'standing',getResidentAnchor:()=>({x:195,y:380,width:390,height:844})} as any,actor:'c',name:'Sully',body,selfOnly,busy:false,status:'',available,onPlay,onClose,onSettings,onStop:vi.fn()})));}
async function click(name:string){await act(async()=>{const b=[...host.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===name);expect(b).toBeTruthy();b!.click();});}
afterEach(()=>{act(()=>root.unmount());vi.clearAllMocks();});
it('does not offer an intimacy category to an unrelated pair even when all actions are otherwise available',async()=>{await render(()=>true,false,false,'blank',false);for(let i=0;i<2;i++){expect(host.textContent).not.toContain('亲密');expect(host.textContent).not.toContain('公主抱');const next=host.querySelector<HTMLButtonElement>('[aria-label="下一组互动"]');if(next)await act(async()=>next.click());}expect(onPlay).not.toHaveBeenCalled();});
it('opens a category, delegates the selected action, and returns without closing',async()=>{await render();await click('招呼');await click('招手');expect(onPlay).toHaveBeenCalledWith(selectedMotions.find(m=>m.label==='招手')!.id);await click('返回互动分类');expect(host.textContent).toContain('亲密');expect(onClose).not.toHaveBeenCalled();});
it('makes remaining categories reachable and routes unavailable actions to member settings',async()=>{await render(()=>false);await click('亲密');const disabled=host.querySelector<HTMLButtonElement>('.social-petal[aria-disabled=true]')!;await act(async()=>disabled.click());expect(onSettings).toHaveBeenCalledOnce();expect(onPlay).not.toHaveBeenCalled();});
it('Escape backs out of actions before closing the menu',async()=>{await render();await click('招呼');const escape=()=>act(()=>host.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));escape();expect(onClose).not.toHaveBeenCalled();escape();expect(onClose).toHaveBeenCalledOnce();});

it('clicking yourself offers only solo actions',async()=>{await render(()=>true,true);for(let page=0;page<2;page++){expect(host.textContent).not.toContain('亲密');const next=host.querySelector<HTMLButtonElement>('[aria-label="下一组互动"]');if(next)await act(async()=>next.click());}expect(host.textContent).toContain('我要做什么');});

it('hides the seated startle reaction while standing, and exposes it only while seated',async()=>{
 await render(()=>true,true);await click('小动作');expect(host.textContent).not.toContain('吓了一跳');
 await act(async()=>root.unmount());await render(()=>true,true,true);await click('小动作');
 let found=false;for(let page=0;page<8;page++){if(host.textContent?.includes('吓了一跳')){found=true;break;}const next=host.querySelector<HTMLButtonElement>('[aria-label="下一组互动"]');if(!next)break;await act(async()=>next.click());}expect(found).toBe(true);
});
it('keeps pagination next to the wheel rather than in the bottom toolbar',async()=>{await render();expect(host.querySelector('.social-wheel-near-pages')).toBeTruthy();expect(host.querySelector('.social-wheel-footer [aria-label="下一组互动"]')).toBeNull();});
it('offers a named summon on the self wheel and closes after summoning',async()=>{
 const summonOwner=vi.fn(()=>true);root=createRoot(host);
 await act(async()=>root.render(React.createElement(HomeSocialWheel,{editor:{summonOwner,getOwnerName:()=> 'Sully',getResidentAnchor:()=>({x:195,y:380,width:390,height:844})} as any,actor:'user',name:'自己',selfOnly:true,busy:false,status:'',available:()=>true,onPlay,onClose,onSettings,onStop:()=>{}})));
 await click('把大家叫过来');expect(summonOwner).toHaveBeenCalledOnce();expect(onClose).toHaveBeenCalledOnce();expect(onPlay).not.toHaveBeenCalled();
});
it('backs up a page beside the ring, then closes only at the root',async()=>{await render();await click('下一组互动');expect(host.querySelector('.social-wheel-navigation [aria-label="上一组互动"]')).toBeTruthy();await click('上一组互动');expect(host.textContent).toContain('亲密');expect(onClose).not.toHaveBeenCalled();await click('返回家园');expect(onClose).toHaveBeenCalledOnce();expect(onPlay).not.toHaveBeenCalled();});
it('places category back beside the ring, not in the footer',async()=>{await render();await click('亲密');expect(host.querySelector('.social-wheel-navigation [aria-label="返回互动分类"]')).toBeTruthy();expect(host.querySelector('.social-wheel-footer [aria-label="返回互动分类"]')).toBeNull();await click('返回互动分类');expect(onClose).not.toHaveBeenCalled();});

it('offers hug, carry and be carried first in the existing intimacy wheel',async()=>{await render(()=>true,false,false,'blank');await click('亲密');expect([...host.querySelectorAll('.social-petal')].slice(0,3).map(b=>b.getAttribute('aria-label'))).toEqual(['拥抱','公主抱','被公主抱']);await click('被公主抱');expect(onPlay).toHaveBeenCalledWith('home-princess-carried');});
it('keeps both carry directions out of the classic body menu',async()=>{await render();await click('亲密');for(let i=0;i<2;i++){expect(host.textContent).not.toContain('公主抱');const next=host.querySelector<HTMLButtonElement>('[aria-label="下一组互动"]');if(next)await act(async()=>next.click());}});

it('lying self has only get-up as its action',async()=>{const standResident=vi.fn();root=createRoot(host);await act(async()=>root.render(React.createElement(HomeSocialWheel,{editor:{getResidentPosture:()=> 'lying',standResident,getResidentAnchor:()=>({x:195,y:380,width:390,height:844})} as any,actor:'user',name:'自己',selfOnly:true,busy:false,status:'',available:()=>true,onPlay,onClose,onSettings,onStop:()=>{}})));expect([...host.querySelectorAll('.social-petal')].map(b=>b.getAttribute('aria-label'))).toEqual(['起身']);await click('起身');expect(standResident).toHaveBeenCalledWith('user');});

it('offers lying activities on the user wheel without getting up',async()=>{
 const setResidentBedMode=vi.fn(()=>true),standResident=vi.fn();root=createRoot(host);
 await act(async()=>root.render(React.createElement(HomeSocialWheel,{editor:{getResidentPosture:()=> 'lying',standResident,setResidentBedMode,getResidentAnchor:()=>({x:195,y:380,width:390,height:844})} as any,body:'blank',actor:'user',name:'自己',selfOnly:true,busy:false,status:'',available:()=>true,onPlay,onClose,onSettings,onStop:()=>{}})));
 expect(host.textContent).toContain('躺着说话');expect(host.textContent).toContain('侧躺');await click('躺着玩手机');expect(setResidentBedMode).toHaveBeenCalledWith('user','bed-phone');expect(standResident).not.toHaveBeenCalled();expect(onPlay).not.toHaveBeenCalled();
});
