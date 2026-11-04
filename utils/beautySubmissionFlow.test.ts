// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi,beforeEach} from 'vitest';
import BeautySharePanel from '../components/share/BeautySharePanel';
const mocks=vi.hoisted(()=>({assets:new Map<string,string>(),request:vi.fn(),session:{token:'test-token',authorCode:'test-author'} as any}));
vi.mock('./beautyShareClient',()=>({beautyRequest:mocks.request,readBeautySession:()=>mocks.session,saveBeautySession:vi.fn(),normalizeBeautyPackage:(v:unknown)=>v,readBeautyPackage:vi.fn(),downloadBeauty:vi.fn()}));
vi.mock('./db',()=>({DB:{getAsset:async(key:string)=>mocks.assets.get(key)||null,saveAsset:async(key:string,data:string)=>{mocks.assets.set(key,data);}}}));
vi.mock('./exportGuard',()=>({confirmExportSafety:async()=>true}));
vi.mock('../components/share/BeautyPresetPreview',()=>({default:({data}:any)=>React.createElement('p',{'data-preview':true},data.name)}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
HTMLDialogElement.prototype.showModal=vi.fn();HTMLDialogElement.prototype.close=vi.fn();
beforeEach(()=>{mocks.assets.clear();mocks.request.mockReset();mocks.session={token:'test-token',authorCode:'test-author'};localStorage.clear();localStorage.setItem('sully-beauty-author-notice-v1','seen');localStorage.setItem('sully-beauty-author-defaults-v1',JSON.stringify({credit:'测试作者',platforms:['糯米机美化群']}));});
const pack=()=>({name:'奶油气泡',format:'sullyos-chat-decoration',version:1,parts:{css:'.sully-chat-header{color:red}'}});
async function mount(read:()=>Promise<unknown>,bindingId?:string,readCurrent?:()=>Promise<unknown>){
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 await act(async()=>root.render(React.createElement(BeautySharePanel,{kind:'chat-decoration',surface:'author',defaultOpen:true,initialTab:'submit',sources:[{id:'one',bindingId,kind:'chat-decoration',name:'奶油气泡',read,readCurrent}],onReceive:async()=>{}})));
 // Opening the author surface reads its inventory; the assertions below track submission actions.
 mocks.request.mockClear();
 const click=async(label:string)=>act(async()=>{const button=Array.from(host.querySelectorAll('button')).find(b=>b.textContent?.startsWith(label));expect(button).toBeTruthy();button!.click();});
 return {host,click,close:async()=>{await act(async()=>root.unmount());host.remove();}};
}
it('confirms a preview before identity or metadata, and allows choosing again',async()=>{
 mocks.session=null;const ui=await mount(async()=>pack());
 try{expect(ui.host.textContent).toContain('先看看');expect(ui.host.querySelector('input[type=password]')).toBeNull();await ui.click('就是这份');expect(ui.host.textContent).toContain('已确认');expect(ui.host.querySelector('input[type=password]')).not.toBeNull();expect(mocks.request).not.toHaveBeenCalled();await ui.click('重新选择');expect(ui.host.textContent).toContain('就是这份');expect(ui.host.querySelector('input[type=password]')).toBeNull();}finally{await ui.close();}
});
it('does not allow confirmation when preview loading fails',async()=>{
 const ui=await mount(async()=>{throw Error('素材已丢失');});
 try{expect(ui.host.textContent).toContain('素材已丢失');const next=Array.from(ui.host.querySelectorAll('button')).find(b=>b.textContent?.startsWith('就是这份'));expect(next?.disabled).toBe(true);expect(mocks.request).not.toHaveBeenCalled();}finally{await ui.close();}
});
it('submits the confirmed snapshot and preserves it for retry after a failed upload',async()=>{
 const value=pack();const read=vi.fn(async()=>value);const ui=await mount(read);
 try{
  await ui.click('就是这份');value.name='changed-after-confirmation';
  mocks.request.mockRejectedValueOnce(Error('暂时无法上传'));
  await ui.click('送交审核');expect(ui.host.textContent).toContain('暂时无法上传');expect(ui.host.textContent).toContain('已确认');
  mocks.request.mockResolvedValueOnce({}).mockResolvedValueOnce({submissions:[],offset:0,total:0,pageSize:12,nextOffset:null});
  await ui.click('送交审核');
  expect(mocks.request.mock.calls[1][1].body.package.name).toBe('奶油气泡');expect(read).toHaveBeenCalledTimes(1);expect(ui.host.textContent).toContain('作品已送达');
 }finally{await ui.close();}
});

it('binds the submitted snapshot and sends a changed original only after confirmation',async()=>{
 const value={...pack(),parts:{...pack().parts,sound:{src:'https://example.com/private.mp3'}}};const ui=await mount(async()=>structuredClone(value),'stable-original',async()=>structuredClone(value));
 const item={id:'work',kind:'chat-decoration',status:'approved',metadata:{name:'奶油气泡',credit:'测试作者',platforms:['糯米机美化群'],contact:'',allowRemix:true,allowRedistribute:true,bugFeedback:'welcome',message:'',exportVersion:'test'},latestRevision:'r1',pendingRevision:null};
 const listing={submissions:[item],offset:0,total:1,pageSize:12,nextOffset:null};
 try{
  mocks.request.mockResolvedValueOnce({id:'work',revision:'r1'}).mockResolvedValueOnce(listing);
  await ui.click('就是这份');
  await act(async()=>{const label=Array.from(ui.host.querySelectorAll('label')).find(x=>x.textContent?.includes('包含聊天提示音'));expect(label).toBeTruthy();label!.querySelector('input')!.click();});
  await ui.click('送交审核');
  expect(mocks.request.mock.calls[0][1].body.package.parts.sound).toBeUndefined();
  expect(value.parts.sound.src).toContain('private');
  const key='beauty_binding_test-author_work';expect(JSON.parse(mocks.assets.get(key)!)).toMatchObject({sourceId:'stable-original',revision:'r1',selection:{sound:false}});
  value.parts.sound.src='https://example.com/new-private.mp3';
  await ui.click('一键更新');await vi.waitFor(async()=>{await act(async()=>{});expect(ui.host.textContent).toContain('没有变化');});expect(mocks.request).toHaveBeenCalledTimes(2);
  value.parts.css='.sully-chat-header{color:blue}';await ui.click('一键更新');await vi.waitFor(async()=>{await act(async()=>{});expect(document.querySelector('dialog')).not.toBeNull();});
  expect(document.querySelector('dialog')?.textContent).toContain('原始装扮已经更新');expect(mocks.request).toHaveBeenCalledTimes(2);
  value.parts.css='.sully-chat-header{color:green}';
  mocks.request.mockResolvedValueOnce({id:'work',revision:'r2'}).mockResolvedValueOnce({...listing,submissions:[{...item,latestRevision:'r2',pendingRevision:'r2',status:'pending'}]});
  await act(async()=>{Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='提交审核')!.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
  const post=mocks.request.mock.calls[2];expect(post[0]).toBe('/submissions/work');expect(post[1].body.expectedRevision).toBe('r1');expect(post[1].body.package.parts.css).toContain('blue');expect(post[1].body.package.parts.sound).toBeUndefined();
  expect(JSON.parse(mocks.assets.get(key)!)).toMatchObject({revision:'r2'});
  expect(Array.from(ui.host.querySelectorAll('button')).find(b=>b.textContent==='一键更新')?.disabled).toBe(true);
 }finally{await ui.close();}
});
it('does not guess an original for old submissions with no binding',async()=>{
 const ui=await mount(async()=>pack(),'stable');
 try{mocks.request.mockResolvedValueOnce({submissions:[{id:'old',kind:'chat-decoration',metadata:{name:'旧投稿'},latestRevision:'r1',status:'approved'}],offset:0,total:1,pageSize:12,nextOffset:null});await ui.click('我的提交');await ui.click('一键更新');expect(ui.host.textContent).toContain('本机没有关联');expect(mocks.request).toHaveBeenCalledTimes(1);expect(document.querySelector('dialog')).toBeNull();}finally{await ui.close();}
});

it('shows every structured section checked by default and submits only the author selection',async()=>{
 const value={...pack(),parts:{...pack().parts,layout:{chatAvatarShape:'square'},background:{image:'https://example.com/bg.png',style:'plain'},psyche:{styleId:'echo'},sound:{src:'bell'},bubbles:{name:'粉'}}};
 const original=structuredClone(value);const ui=await mount(async()=>value);
 try{
  await ui.click('就是这份');
  const checks=Array.from(ui.host.querySelectorAll<HTMLInputElement>('.beauty-share-contents input'));
  expect(checks).toHaveLength(6);expect(checks.every(input=>input.checked)).toBe(true);
  for(const text of ['包含聊天布局','包含聊天背景','包含心象'])await act(async()=>{Array.from(ui.host.querySelectorAll('label')).find(label=>label.textContent?.includes(text))!.querySelector('input')!.click();});
  mocks.request.mockResolvedValueOnce({}).mockResolvedValueOnce({submissions:[],offset:0,total:0,pageSize:12,nextOffset:null});
  await ui.click('送交审核');
  expect(Object.keys(mocks.request.mock.calls[0][1].body.package.parts).sort()).toEqual(['bubbles','css','sound']);expect(value).toEqual(original);
 }finally{await ui.close();}
});
