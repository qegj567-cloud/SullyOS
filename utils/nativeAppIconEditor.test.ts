// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const mocks = vi.hoisted(() => ({get:vi.fn(),set:vi.fn()}));
vi.mock('./nativeAppIcon',()=>({getNativeAppIcon:mocks.get,setNativeAppIcon:mocks.set}));
vi.mock('./appIcon',()=>({PWA_DEFAULT_ICON_URL:'/jellyfish.png',PWA_CLASSIC_ICON_URL:'/classic.png'}));
import NativeAppIconEditor from '../components/appearance/NativeAppIconEditor';
let root:Root, node:HTMLDivElement;
beforeEach(async()=>{
    vi.resetAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
    mocks.get.mockResolvedValue({icon:'jellyfish'}); mocks.set.mockResolvedValue({icon:'classic'});
    node=document.createElement('div'); document.body.append(node); root=createRoot(node);
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();});
const mount=()=>act(async()=>root.render(React.createElement(NativeAppIconEditor)));
const button=(name:string)=>Array.from(node.querySelectorAll('button')).find(b=>b.textContent?.startsWith(name))!;
it('uses actual native selection, has two choices and no upload/reinstall instructions',async()=>{
    mocks.get.mockResolvedValue({icon:'classic'}); await mount();
    expect(button('经典').getAttribute('aria-pressed')).toBe('true'); expect(node.querySelector('input[type=file]')).toBeNull();
    expect(node.textContent).toContain('不需要卸载'); expect(mocks.set).not.toHaveBeenCalled();
});
it('updates selection only after native success and prevents double submission',async()=>{
    let resolve!:(value:any)=>void; mocks.set.mockReturnValue(new Promise(r=>resolve=r)); await mount();
    await act(async()=>{button('经典').click();button('经典').click();});
    expect(mocks.set).toHaveBeenCalledTimes(1); expect(button('水母').getAttribute('aria-pressed')).toBe('true');
    await act(async()=>resolve({icon:'classic'})); expect(button('经典').getAttribute('aria-pressed')).toBe('true');
});
it('shows failure and re-reads system state without a false success notice',async()=>{
    await mount(); mocks.set.mockRejectedValue(new Error('系统拒绝')); await act(async()=>button('经典').click());
    expect(node.querySelector('[role=alert]')?.textContent).toContain('系统拒绝');
    expect(button('水母').getAttribute('aria-pressed')).toBe('true'); expect(node.textContent).not.toContain('已请求切换');
});
it('disables choices on old APK and supports retry',async()=>{
    mocks.get.mockRejectedValue(new Error('请先更新 APK')); await mount(); expect(button('经典').disabled).toBe(true);
    mocks.get.mockResolvedValue({icon:'jellyfish'}); await act(async()=>button('重新读取').click()); expect(button('经典').disabled).toBe(false);
});
it('unknown native state can be repaired by a deliberate choice',async()=>{
    mocks.get.mockResolvedValue({icon:null}); await mount(); expect(button('经典').getAttribute('aria-pressed')).toBe('false');
    await act(async()=>button('经典').click()); expect(mocks.set).toHaveBeenCalledWith('classic');
});
it('routes only Android APKs to native controls without changing PWA storage',()=>{
    const source=readFileSync(resolve('components/appearance/AppIconEditor.tsx'),'utf8');
    expect(source).toContain('isAndroidAppIcon()'); expect(source).toContain('<NativeAppIconEditor'); expect(source).toContain('<PwaAppIconEditor');
    const native=readFileSync(resolve('components/appearance/NativeAppIconEditor.tsx'),'utf8');
    expect(native).not.toContain('setCustomIcon'); expect(native).not.toContain('localStorage');
});
