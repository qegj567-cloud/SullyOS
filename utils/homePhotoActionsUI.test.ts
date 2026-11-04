// @vitest-environment jsdom
import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {PhotoActions} from '../apps/room3d/PhotoActions';
vi.mock('../apps/room3d/photoLibrary',()=>({photoLibrary:[
 {id:'wave',label:'挥手',kind:'motion',duration:3,participants:1},
 {id:'smile',label:'微笑',kind:'motion',duration:2,participants:1},
 {id:'home-hug',label:'拥抱',kind:'pair',duration:4,participants:2},
]}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const host=document.createElement('div');document.body.append(host);
let root:ReturnType<typeof createRoot>;
afterEach(()=>{act(()=>root.unmount());vi.restoreAllMocks();});
function setup(pose=vi.fn().mockResolvedValue(undefined),romantic=true){
 const interaction=vi.fn().mockResolvedValue(undefined),refresh=vi.fn();
 function Harness(){const [compact,setCompact]=useState(false);return React.createElement(PhotoActions,{editor:{canPlaySocial:()=>romantic,setPhotoPose:pose,setPhotoInteraction:interaction} as any,actors:[{id:'a',label:'小栗'},{id:'b',label:'你'}],refresh,compact,onPreview:()=>setCompact(true),onExpand:()=>setCompact(false)});}
 root=createRoot(host);act(()=>root.render(React.createElement(Harness)));return {pose,interaction,refresh};
}
async function click(name:string){const button=Array.from(host.querySelectorAll('button')).find(b=>(b.getAttribute('aria-label')||b.textContent)===name)!;expect(button).toBeTruthy();await act(async()=>button.click());}
const browser=()=>host.querySelector<HTMLElement>('.photo-action-browser')!;
it('collapses after a loaded action, switches in preview, and preserves selection on reopening',async()=>{
 const {pose}=setup();await click('挥手');expect(pose).toHaveBeenLastCalledWith('a','wave',1);expect(browser().hidden).toBe(true);
 await click('下一个拍照动作');expect(pose).toHaveBeenLastCalledWith('a','smile',1);expect(host.querySelector('.photo-action-preview strong')?.textContent).toBe('微笑');
 await click('选择动作');expect(browser().hidden).toBe(false);expect(host.querySelector('.photo-action-grid [aria-pressed=true]')?.textContent).toBe('微笑');
});
it('keeps the list open while loading and after failure, allowing retry',async()=>{
 let reject!:(error:Error)=>void;const pose=vi.fn().mockImplementation(()=>new Promise((_,r)=>{reject=r;}));setup(pose);await click('挥手');expect(browser().hidden).toBe(false);
 await act(async()=>reject(new Error('动作加载失败')));expect(host.querySelector('[role=alert]')?.textContent).toBe('动作加载失败');expect(browser().hidden).toBe(false);
 pose.mockResolvedValue(undefined);await click('挥手');expect(browser().hidden).toBe(true);
});
it('previews both residents together and retains the selected category',async()=>{
 const {interaction}=setup();await click('双人互动 · 1');await click('拥抱');expect(interaction).toHaveBeenCalledWith('home-hug','a','b',1);expect(browser().hidden).toBe(true);
 await click('选择动作');expect(host.querySelector('.photo-options [aria-pressed=true]')?.textContent).toBe('双人互动 · 1');
});
it('hides intimate photo poses for an unconfirmed pair',async()=>{const {interaction}=setup(undefined,false);await click('双人互动 · 0');expect(host.querySelector('.photo-action-grid')?.textContent).not.toContain('拥抱');expect(interaction).not.toHaveBeenCalled();});
