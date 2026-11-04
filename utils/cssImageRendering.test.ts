// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import BlobRefStyle from '../components/chat/BlobRefStyle';
import BeautyPresetPreview from '../components/share/BeautyPresetPreview';

const read = vi.hoisted(() => vi.fn());
vi.mock('./blobRef', () => ({getBlobForRef:read}));
vi.mock('../components/chat/ChatDecorationSample', () => ({renderChatDecorationSample:(data:any) => ({markup:'<main class="sully-chat-root">preview</main>',css:data.parts.css})}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const source = (id:string) => `.sully-chat-avatar-wrap::after{background:url("blobref:${id}")}`;
let created:string[]; let revoked:string[];
beforeEach(() => {
    created=[]; revoked=[]; read.mockReset().mockResolvedValue(new Blob(['frame'],{type:'image/webp'}));
    Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(() => {const url='blob:test-'+created.length; created.push(url); return url;})});
    Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn((url:string) => revoked.push(url))});
    vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
});
afterEach(() => {vi.unstubAllGlobals(); document.body.replaceChildren();});

it('renders local frames in chat CSS, releases replaced URLs, and discards late loads after unmount', async () => {
    const host=document.createElement('div'); document.body.appendChild(host); const root=createRoot(host);
    await act(async () => root.render(React.createElement(BlobRefStyle,{css:source('first')})));
    expect(host.querySelector('style')!.sheet!.cssRules[0].cssText).toContain('blob:test-0');
    await act(async () => root.render(React.createElement(BlobRefStyle,{css:source('second')})));
    expect(host.querySelector('style')!.sheet!.cssRules[0].cssText).toContain('blob:test-1'); expect(revoked).toEqual(['blob:test-0']);
    let finish!:(blob:Blob)=>void;
    read.mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
    await act(async () => root.render(React.createElement(BlobRefStyle,{css:source('late')})));
    await act(async () => root.unmount());
    await act(async () => finish(new Blob(['late'])));
    expect(revoked).toEqual(created);
});

it('renders preview CSS through object URLs and releases all resources when closed', async () => {
    const host=document.createElement('div'); document.body.appendChild(host); const root=createRoot(host);
    const data={format:'sullyos-chat-decoration',version:1,name:'头像框',parts:{css:source('preview')}};
    await act(async () => root.render(React.createElement(BeautyPresetPreview,{data})));
    const shadow=host.querySelector('[data-beauty-preview-source]')!.shadowRoot!;
    expect(shadow.querySelector('style')!.textContent).toContain('blob:test-0');
    expect(host.querySelector('[role=alert]')).toBeNull();
    await act(async () => root.unmount()); expect(revoked).toEqual(created);
});

it('releases a preview asset that finishes loading after the preview was closed', async () => {
    let finish!:(blob:Blob)=>void;
    read.mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
    const host=document.createElement('div'); document.body.appendChild(host); const root=createRoot(host);
    const data={format:'sullyos-chat-decoration',version:1,name:'头像框',parts:{css:source('late-preview')}};
    await act(async () => root.render(React.createElement(BeautyPresetPreview,{data})));
    expect(read).toHaveBeenCalled();
    await act(async () => root.unmount());
    await act(async () => finish(new Blob(['late'])));
    expect(created).toHaveLength(1); expect(revoked).toEqual(created);
});

// Slow image reads must not tear down the font declaration already being used.
it('patches only local image properties, retaining font rule identity and nested priorities', async () => {
    let finish!:(blob:Blob)=>void;
    read.mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
    const host=document.createElement('div'); document.body.appendChild(host); const root=createRoot(host);
    const css = '@font-face{font-family:Beauty;src:url(https://example.com/font.woff2)}'
        + '@media(min-width:0px){.sully-chat-inputbar{background:url("blobref:frame") !important;color:pink;content:"blobref:frame"}}';
    await act(async () => root.render(React.createElement(BlobRefStyle,{css})));
    const style=host.querySelector('style')!; const sheet=style.sheet!; const font=sheet.cssRules[0];
    const changes=vi.fn(); const observer=new MutationObserver(changes); observer.observe(style,{childList:true,subtree:true,characterData:true});
    await act(async () => finish(new Blob(['image'])));
    expect(style.sheet).toBe(sheet); expect(sheet.cssRules[0]).toBe(font);
    const declaration=(sheet.cssRules[1] as CSSMediaRule).cssRules[0] as CSSStyleRule;
    expect(declaration.style.background).toContain('blob:test-0');
    expect(declaration.style.getPropertyPriority('background')).toBe('important');
    expect(declaration.style.color).toBe('pink'); expect(declaration.style.content).toBe('"blobref:frame"');
    expect(changes).not.toHaveBeenCalled();
    observer.disconnect(); await act(async () => root.unmount()); expect(revoked).toEqual(created);
});

it('starts at most four image reads and disposes every URL if a concurrent read fails', async () => {
    const pending:Array<{resolve:(blob:Blob)=>void;reject:(error:Error)=>void}>=[];
    read.mockImplementation(() => new Promise((resolve,reject) => {pending.push({resolve,reject});}));
    const {resolveCssImageUrls}=await import('./cssImageAssets');
    const css=Array.from({length:5},(_,i)=>source('parallel-'+i)).join('');
    const result=resolveCssImageUrls(css);
    const rejected=expect(result).rejects.toThrow('read failed');
    expect(read).toHaveBeenCalledTimes(4);
    pending[0].resolve(new Blob(['first'])); await Promise.resolve(); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(5);
    pending[1].reject(new Error('read failed')); pending[2].resolve(new Blob(['third']));
    pending[3].resolve(new Blob(['fourth'])); pending[4].resolve(new Blob(['fifth']));
    await rejected; expect(created).toHaveLength(4); expect(revoked).toEqual(created);
});
