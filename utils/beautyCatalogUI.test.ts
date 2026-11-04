// @vitest-environment jsdom
import React from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {act} from 'react-dom/test-utils';
import {afterEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({catalog:vi.fn(),preview:vi.fn(),request:vi.fn(),download:vi.fn(),paint:vi.fn()}));
vi.mock('./beautyCatalogClient',async()=>({...await vi.importActual('./beautyCatalogClient'),loadBeautyCatalog:mocks.catalog,loadCatalogPreview:mocks.preview}));
vi.mock('./beautyShareClient',()=>({beautyRequest:mocks.request,downloadBeauty:mocks.download}));
vi.mock('./beautySourceBinding',()=>({readBeautyBinding:async()=>null,bindBeautySource:vi.fn()}));
vi.mock('../components/share/BeautyPresetPreview',()=>({default:()=>{mocks.paint();return React.createElement('div',{'data-test-preview':true});}}));
import BeautyCatalog from '../components/appearance/BeautyCatalog';
import BeautyTermsEditor from '../components/share/BeautyTermsEditor';
import { handleLocalBack } from './localBackHandlers';
const metadata={name:'月光',credit:'作者',platforms:['糯米机美化群'],contact:'',allowRemix:false,allowRedistribute:false,exportVersion:'test',bugFeedback:'welcome' as const,message:'',allowPublicListing:true};
const entries=Array.from({length:13},(_,i)=>({code:'S-'+i.toString(16).padStart(12,'0').toUpperCase(),revision:'a'.repeat(32),sha256:'b'.repeat(64),bytes:100,kind:'chat-decoration' as const,metadata:{...metadata,name:'月光 '+i},categories:['chat','whitebox'],file:'unused.json',cover:'unused.webp'}));
let root:Root|undefined;
afterEach(async()=>{await act(async()=>root?.unmount());document.body.innerHTML='';vi.clearAllMocks();});
async function mount(element:React.ReactNode){
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  const host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(element));
}
const button=(text:string)=>[...document.querySelectorAll('button')].find(el=>el.textContent?.includes(text))!;
const click=async(el:HTMLElement)=>act(async()=>{el.click();});
describe('装扮库与批量协议交互',()=>{
  it('returns from the preview to the catalog before exiting the catalog',async()=>{
    mocks.catalog.mockResolvedValue({version:1,generatedAt:1,entries});
    const back=vi.fn();await mount(React.createElement(BeautyCatalog,{onBack:back,onReceive:vi.fn()}));
    await click(document.querySelector('.wardrobe-tile')!);expect(document.querySelector('dialog')).not.toBeNull();
    await act(async()=>{expect(handleLocalBack()).toBe(true);});expect(document.querySelector('dialog')).toBeNull();expect(back).not.toHaveBeenCalled();
    await act(async()=>{handleLocalBack();});expect(back).toHaveBeenCalledOnce();
  });
  it('列表只显示当页静态图，详情按需预览，更新协议后必须重新勾选才能领取',async()=>{
    mocks.catalog.mockResolvedValue({version:1,generatedAt:1,entries});mocks.preview.mockResolvedValue({parts:{}});
    const receive=vi.fn().mockResolvedValue(undefined);
    await mount(React.createElement(BeautyCatalog,{onBack:vi.fn(),onReceive:receive}));
    expect(document.querySelectorAll('.wardrobe-cover img')).toHaveLength(12);expect(mocks.paint).not.toHaveBeenCalled();expect(mocks.request).not.toHaveBeenCalled();
    await click(document.querySelector('.wardrobe-tile')!);
    expect(mocks.preview).not.toHaveBeenCalled();expect(mocks.paint).not.toHaveBeenCalled();
    await click(button('交互预览'));expect(mocks.preview).toHaveBeenCalledTimes(1);expect(mocks.paint).toHaveBeenCalled();
    const entry=mocks.preview.mock.calls[0][0],latest={...entry,revision:'c'.repeat(32),metadata:{...entry.metadata,allowRemix:true}};
    mocks.request.mockResolvedValue(latest);mocks.download.mockResolvedValue({parts:{}});
    await click(document.querySelector('.catalog-accept input')!);await click(button('领取装扮'));
    expect(receive).not.toHaveBeenCalled();expect((document.querySelector('.catalog-accept input') as HTMLInputElement).checked).toBe(false);
    expect(document.body.textContent).toContain('请重新阅读并确认');
    await click(document.querySelector('.catalog-accept input')!);await click(button('领取装扮'));
    expect(receive).toHaveBeenCalledTimes(1);expect(mocks.download).toHaveBeenCalledWith(latest,latest.kind);expect(mocks.catalog).toHaveBeenCalledTimes(1);
  });
  it('批量默认保持协议，只提交选择字段，重试不重复提交成功项',async()=>{
    const items=entries.slice(0,2).map((entry,i)=>({id:String(i),kind:entry.kind,metadata:entry.metadata,shareCode:entry.code,latestRevision:entry.revision,publishedRevision:entry.revision,pendingRevision:null,status:'approved' as const,reviewNote:'',updatedAt:1}));
    const done=vi.fn().mockResolvedValue(undefined);
    mocks.request.mockResolvedValueOnce({revision:'d'.repeat(32)}).mockRejectedValueOnce(Error('暂时失败')).mockResolvedValueOnce({revision:'e'.repeat(32)});
    await mount(React.createElement(BeautyTermsEditor,{items,session:{authorCode:'test',token:'test',expiresAt:1},onClose:vi.fn(),onDone:done}));
    expect([...document.querySelectorAll('select')].every(el=>el.value==='keep')).toBe(true);
    await click(button('提交协议修改'));expect(mocks.request).not.toHaveBeenCalled();
    await act(async()=>{const select=document.querySelector('select')!;select.value='true';select.dispatchEvent(new Event('change',{bubbles:true}));});
    await click(button('提交协议修改'));
    expect(mocks.request).toHaveBeenCalledTimes(2);expect(mocks.request.mock.calls[0][1].body.terms).toEqual({allowRemix:true});
    expect(document.body.textContent).toContain('暂时失败');await click(button('重试未成功'));
    expect(mocks.request).toHaveBeenCalledTimes(3);expect(mocks.request.mock.calls[2][0]).toBe('/submissions/1/terms');expect(done).toHaveBeenCalledTimes(2);
  });
});
