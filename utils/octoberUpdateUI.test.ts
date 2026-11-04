// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OctoberUpdatePopup from '../components/os/OctoberUpdatePopup';
import { OCTOBER_CHANGELOG, OCTOBER_UPDATE_KEY } from './octoberUpdate';
import { trackEvent } from './analytics';
import { handleLocalBack } from './localBackHandlers';
vi.mock('./analytics',()=>({trackEvent:vi.fn()}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let root:ReturnType<typeof createRoot>;
const host=document.createElement('div'); document.body.append(host);
beforeEach(()=>{
    localStorage.removeItem(OCTOBER_UPDATE_KEY); vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
    HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
});
afterEach(()=>{act(()=>root.unmount());vi.restoreAllMocks();});
function setup(preview=false){
    const done=vi.fn(); root=createRoot(host);
    act(()=>root.render(React.createElement(StrictMode,null,React.createElement(OctoberUpdatePopup,{onDone:done,preview}))));
    return {done};
}
function click(text:string){const button=[...host.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent?.trim())===text)!;expect(button).toBeTruthy();act(()=>button.click());}
it('shows once in StrictMode and does not mark read until explicitly closed',()=>{
    const {done}=setup(); expect(trackEvent).toHaveBeenCalledTimes(1);expect(localStorage.getItem(OCTOBER_UPDATE_KEY)).toBeNull();
    click('关闭十月更新介绍');click('关闭十月更新介绍');expect(done).toHaveBeenCalledOnce();expect(localStorage.getItem(OCTOBER_UPDATE_KEY)).toBe('1');
});
it('turns through three themes without closing or marking read, and can go back',()=>{
    const {done}=setup();
    expect(host.querySelector('h2')?.textContent).toBe('彼方也要万圣节！');
    expect(host.querySelector<HTMLButtonElement>('.october-release-actions button')?.disabled).toBe(true);
    click('下一页');expect(host.querySelector('h2')?.textContent).toBe('家里也要过万圣！');
    expect(document.activeElement).toBe(host.querySelector('h2'));
    click('下一页');expect(host.querySelector('h2')?.textContent).toBe('来哔哔，聊点日常');
    click('上一页');expect(host.querySelector('h2')?.textContent).toBe('家里也要过万圣！');
    expect(done).not.toHaveBeenCalled();expect(localStorage.getItem(OCTOBER_UPDATE_KEY)).toBeNull();expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(host.querySelector('a')).toBeNull();
});
it('acknowledges the last page once without a destination event',()=>{
    const {done}=setup();click('下一页');click('下一页');click('知道啦');click('知道啦');
    expect(done).toHaveBeenCalledOnce();expect(localStorage.getItem(OCTOBER_UPDATE_KEY)).toBe('1');
    expect(trackEvent).toHaveBeenLastCalledWith('查看更新说明',{版本:OCTOBER_CHANGELOG});expect(trackEvent).toHaveBeenCalledTimes(2);
});
it('preview neither writes a receipt nor sends analytics',()=>{
    const {done}=setup(true);click('下一页');click('下一页');click('知道啦');expect(done).toHaveBeenCalledOnce();expect(trackEvent).not.toHaveBeenCalled();expect(localStorage.getItem(OCTOBER_UPDATE_KEY)).toBeNull();
});
it('global back turns to the previous page before closing the introduction',()=>{
    const {done}=setup();click('下一页');click('下一页');
    act(()=>{expect(handleLocalBack()).toBe(true);});expect(host.querySelector('h2')?.textContent).toBe('家里也要过万圣！');
    act(()=>{handleLocalBack();});expect(host.querySelector('h2')?.textContent).toBe('彼方也要万圣节！');expect(done).not.toHaveBeenCalled();
    act(()=>{handleLocalBack();});expect(done).toHaveBeenCalledOnce();
});
it('Escape still closes when storage is unavailable',()=>{
    const {done}=setup();vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('full');});
    act(()=>host.querySelector('dialog')!.dispatchEvent(new Event('cancel',{cancelable:true})));
    expect(done).toHaveBeenCalledOnce();
});
