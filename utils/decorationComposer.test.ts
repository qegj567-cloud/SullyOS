// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {Simulate} from 'react-dom/test-utils';
import DecorationDraftEditor from '../components/chat/DecorationDraftEditor';
const mocks=vi.hoisted(()=>({save:vi.fn(),origin:vi.fn()}));
vi.mock('./decorationLibrary',async()=>({...await vi.importActual<any>('./decorationLibrary'),readDecorationOrigin:mocks.origin,saveLibraryDecoration:mocks.save}));
vi.mock('../components/share/BeautyPresetPreview',()=>({default:({data,sceneScope}:any)=>React.createElement('div',{'data-testid':'preview','data-scope':sceneScope},JSON.stringify(data.parts))}));
vi.mock('../components/chat/ChatLayoutSettings',()=>({default:()=>null}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it('recovers the current legacy psyche CSS without a matching library preset and saves only that part',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const applied=vi.fn(), refreshed=vi.fn(async()=>{});mocks.save.mockClear();
 const css='.sully-psyche-card { color: purple; }';
 const click=async(label:string)=>act(async()=>{const buttons=Array.from(document.querySelectorAll('button')).filter(b=>b.textContent===label);expect(buttons.length).toBeGreaterThan(0);buttons[buttons.length-1].click();});
 try{
  await act(async()=>root.render(React.createElement(DecorationDraftEditor,{preset:{format:'sullyos-chat-decoration',version:1,name:'当前搭配',parts:{css:'.sully-chat-root{color:red}',psyche:{styleId:'custom',customColors:{bg:'#123456'},customCss:css}}},origin:{kind:'legacy'},theme:{} as any,sources:[],onClose:()=>{},onOpenWorkshop:()=>{},onSaved:()=>{},onApply:applied,onOutfitsChange:refreshed})));
  await act(async()=>{Array.from(document.querySelectorAll('.decoration-current-grid button')).find(b=>b.textContent?.includes('心象'))!.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
  await click('编辑并另存当前心象');
  const editor=document.querySelector<HTMLTextAreaElement>('[aria-label="心象 CSS"]')!;
  expect(editor.value).toBe(css);
  await act(async()=>Simulate.change(editor,{target:{value:css.replace('purple','green')}} as any));
  await click('保存预设');
  expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({parts:{psyche:{styleId:'custom',customColors:{bg:'#123456'},customCss:css.replace('purple','green')}}}),expect.anything(),undefined,undefined);
  expect(refreshed).toHaveBeenCalledOnce();expect(applied).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="心象 CSS"]')).toBeNull();
 }finally{await act(async()=>root.unmount());host.remove();}
});
it('keeps the preview mounted, combines a permitted preset, and rejects a locked one',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const source=(id:string,name:string)=>({id,name,kind:'chat-decoration' as const,categories:['psyche' as const],attributionKey:async()=>id,read:async()=>({format:'sullyos-chat-decoration',version:1,name,parts:{psyche:{styleId:'echo'}}})});
 mocks.origin.mockImplementation(async(key:string)=>({kind:'imported',allowRemix:key!=='locked',credit:key}));
 const click=async(label:string)=>act(async()=>{const button=Array.from(document.querySelectorAll('button')).find(item=>item.textContent?.includes(label));expect(button).toBeDefined();button!.click();});
 try{
  await act(async()=>root.render(React.createElement(DecorationDraftEditor,{preset:{format:'sullyos-chat-decoration',version:1,name:'测试组合',parts:{css:''}},origin:{kind:'self'},theme:{} as any,sources:[source('allowed','允许作品'),source('locked','锁定作品')],onClose:()=>{},onOpenWorkshop:()=>{},onSaved:()=>{}})));
  expect(document.querySelector('textarea')).toBeNull();
  expect(Array.from(document.querySelectorAll('.decoration-current-grid>button strong'), el=>el.textContent)).toEqual(['白框','气泡','头像框','聊天背景','心象','角色名片','提示音']);
  const preview=document.querySelector('[data-testid=preview]');
  expect(preview?.getAttribute('data-scope')).toBe('all');
  await click('心象');await click('锁定作品');
  expect(document.body.textContent).toContain('作者禁止二改');expect(preview?.textContent).not.toContain('psyche');
  await click('允许作品');expect(preview?.textContent).toContain('echo');
  expect(document.querySelector('textarea')).toBeNull();
  expect(document.querySelector('[data-testid=preview]')).toBe(preview);
  await click('应用搭配');
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({parts:expect.objectContaining({psyche:expect.objectContaining({styleId:'echo'})})}),expect.objectContaining({kind:'remix',credit:'allowed'}),undefined,'outfit');
 }finally{await act(async()=>root.unmount());host.remove();}
});

it('saves the current outfit as a new local preset without applying it',async()=>{
 HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const applied=vi.fn();const saved=vi.fn();const refreshed=vi.fn(async()=>{});mocks.save.mockClear();
 const click=async(label:string)=>act(async()=>{Array.from(document.querySelectorAll('button')).find(b=>b.textContent===label)!.click();});
 try{await act(async()=>root.render(React.createElement(DecorationDraftEditor,{preset:{format:'sullyos-chat-decoration',version:1,name:'Sully的搭配',parts:{css:'.sully-chat-root {color:red}'}},origin:{kind:'self'},theme:{} as any,sources:[],onClose:()=>{},onOpenWorkshop:()=>{},onSaved:saved,onApply:applied,onOutfitsChange:refreshed})));
 await click('保存当前搭配');expect(document.querySelector('dialog')?.textContent).toContain('保存这次组合');await click('保存到搭配栏');expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({name:'Sully的搭配'}),expect.objectContaining({kind:'self'}),undefined,'outfit');expect(applied).not.toHaveBeenCalled();expect(saved).not.toHaveBeenCalled();expect(refreshed).toHaveBeenCalledTimes(1);
 }finally{await act(async()=>root.unmount());host.remove();}
});

it('coalesces rapid CSS edits for preview but saves the latest text immediately',async()=>{
 vi.useFakeTimers();mocks.save.mockClear();
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(React.createElement(DecorationDraftEditor,{maker:'whitebox',preset:{format:'sullyos-chat-decoration',version:1,name:'旧白框',parts:{css:'.flex{color:red}'}},origin:{kind:'self'},theme:{} as any,sources:[],onClose:()=>{},onOpenWorkshop:()=>{},onSaved:()=>{}})));
  const preview=document.querySelector('[data-testid=preview]')!;
  const textarea=document.querySelector('textarea[aria-label="白框 CSS"]') as HTMLTextAreaElement;
  const initial=preview.textContent;
  for(let i=0;i<20;i++){
   await act(async()=>{Simulate.change(textarea,{target:{value:`.flex{padding:${i}px}`} } as any);vi.advanceTimersByTime(10);});
   expect(preview.textContent).toBe(initial);
  }
  await act(async()=>{Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='保存预设')!.click();});
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({parts:{css:'.flex{padding:19px}'}}),expect.anything(),undefined,undefined);
  await act(async()=>vi.advanceTimersByTime(300));
  expect(preview.textContent).toContain('.flex{padding:19px}');
 }finally{await act(async()=>root.unmount());host.remove();vi.useRealTimers();}
});
