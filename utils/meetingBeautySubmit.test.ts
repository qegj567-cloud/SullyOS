// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {describe,it,expect,vi} from 'vitest';
import {readLibraryDecorations,readDecorationOrigin} from './decorationLibrary';
import {makeWorkshopPreset} from './decorationWorkshop';

vi.mock('../hooks/useLocalBackHandler',()=>({useLocalBackHandler:()=>{}}));
vi.mock('../components/share/BeautyPresetPreview',()=>({default:()=>null}));
vi.mock('../components/chat/DecorationPresetThumb',()=>({default:()=>null,DecorationMiniPreview:()=>null}));
vi.mock('../components/chat/ChatLayoutSettings',()=>({default:()=>null}));
vi.mock('../components/chat/AvatarFrameImageEditor',()=>({default:()=>null}));
vi.mock('../components/chat/CssCodeEditor',()=>({default:()=>null}));
import DecorationDraftEditor from '../components/chat/DecorationDraftEditor';
import BeautyShareChannel from '../components/appearance/BeautyShareChannel';
import {OSPreviewProvider} from '../context/OSContext';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
async function waitForUi(ready:()=>boolean){
 for(let attempt=0;attempt<50&&!ready();attempt++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
 expect(ready()).toBe(true);
}

describe('reading appearance cloud handoff',()=>{
 it('opens unified submission with the just-saved story selected and waits for confirmation before upload',async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No network during handoff'));
  vi.stubGlobal('IntersectionObserver',class {observe(){}disconnect(){}});
  const os={theme:{},characters:[],customThemes:[],customIcons:{},appearancePresets:[],registerBackHandler:()=>()=>{},closeApp:()=>{},exportAppearancePreset:async()=>new Blob(),importAppearancePreset:async()=>'',updateTheme:async()=>{}} as any;
  const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(item=>item.textContent?.includes(text))!;
  try{
   await act(async()=>root.render(React.createElement(OSPreviewProvider,{value:os},React.createElement(BeautyShareChannel,{presets:[],onExport:os.exportAppearancePreset,onImport:os.importAppearancePreset,onBusyChange:()=>{},initialCategory:'story',initialMaker:'story'}))));
   await act(async()=>button('保存并投稿云端').click());
   await waitForUi(()=>!!host.querySelector('.beauty-preset-source')?.textContent?.includes('我的剧情界面'));
   await waitForUi(()=>button('就是这份，继续')?.disabled===false);
   expect(host.textContent).toContain('这一步只确认作品，还不会上传');
   await act(async()=>button('就是这份，继续').click());
   expect(host.querySelector('.beauty-confirmed-work')?.textContent).toContain('我的剧情界面');
   expect(host.textContent).toContain('署名与规范');
   expect(network).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());host.remove();network.mockRestore();vi.unstubAllGlobals();}
 });
 it.each(['date','story'] as const)('%s saves a stable local original before opening submission, without applying it',async maker=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const onSaved=vi.fn(),onApply=vi.fn();let id='';
  const preset=makeWorkshopPreset(maker);preset.name='投稿书页';preset.parts[maker]={preset:'night',customCss:'.meeting-reading { --meeting-ink: pink; }'};
  const onShareSaved=vi.fn(async(value:string)=>{id=value;expect((await readLibraryDecorations()).find(item=>item._libraryId===id)?.parts).toEqual(preset.parts);});
  try{
   await act(async()=>root.render(React.createElement(DecorationDraftEditor,{preset,origin:{kind:'self'},theme:{} as any,sources:[],maker,onSaved,onApply,onShareSaved,onOpenWorkshop:()=>{},onClose:()=>{}})));
   const button=Array.from(document.querySelectorAll('button')).find(item=>item.textContent==='保存并投稿云端')!;
   expect(button.disabled).toBe(false);
   await act(async()=>button.click());
   await act(async()=>vi.waitFor(()=>{
    const error=document.querySelector('[role="alert"]')?.textContent;
    expect(error).toBeFalsy();expect(onShareSaved).toHaveBeenCalledTimes(1);
   }));
   expect(onShareSaved).toHaveBeenCalledTimes(1);expect(id).toMatch(/^local-chat-/);
   expect(await readDecorationOrigin(id)).toMatchObject({kind:'self'});
   expect(onSaved).not.toHaveBeenCalled();expect(onApply).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());host.remove();}
 });
 it('keeps cloud sharing unavailable when the author forbids redistribution',async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const onShareSaved=vi.fn();
  try{
   await act(async()=>root.render(React.createElement(DecorationDraftEditor,{preset:makeWorkshopPreset('story'),origin:{kind:'imported',allowRemix:true,allowRedistribute:false},theme:{} as any,sources:[],maker:'story',onSaved:()=>{},onShareSaved,onOpenWorkshop:()=>{},onClose:()=>{}})));
   const button=Array.from(document.querySelectorAll('button')).find(item=>item.textContent==='保存并投稿云端')!;
   expect(button.disabled).toBe(true);await act(async()=>button.click());expect(onShareSaved).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());host.remove();}
 });
});
