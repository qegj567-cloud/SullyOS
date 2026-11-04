// @vitest-environment jsdom
import React, {act} from 'react';
import {Simulate} from 'react-dom/test-utils';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import BeautyShareChannel from '../components/appearance/BeautyShareChannel';
import {PRESET_THEMES} from '../components/chat/ChatConstants';
import { handleLocalBack } from './localBackHandlers';
const mocks=vi.hoisted(()=>({update:vi.fn(),open:vi.fn(),active:vi.fn(),done:vi.fn(),read:vi.fn<(...args:any[])=>Promise<any>>(async()=>null),share:vi.fn(),wardrobe:vi.fn(),theme:vi.fn()}));
vi.mock('../context/OSContext',()=>({useOS:()=>({characters:[{id:'a',name:'甲'},{id:'b',name:'乙'}],activeCharacterId:'b',theme:{},updateTheme:mocks.theme,updateCharacter:mocks.update,addCustomTheme:vi.fn(),setActiveCharacterId:mocks.active,openApp:mocks.open,closeApp:vi.fn(),applyAppearancePreset:vi.fn()})}));
vi.mock('./db',()=>({DB:{getAsset:mocks.read,getAssetRaw:mocks.read,saveAsset:vi.fn()}}));
vi.mock('./chatDecoration',()=>({validateDecoration:(v:unknown)=>v,decorationPatches:vi.fn(async()=>({character:{thinkingChainStyle:'echo'}}))}));
vi.mock('./beautyUsage',()=>({startBeautyUsage:vi.fn(),decorationSourceKey:async()=>'test',rememberBeautySource:vi.fn()}));
vi.mock('../components/share/BeautyRepoInvitation',()=>({BeautyRepoLibrary:()=>null}));
vi.mock('../components/share/BeautySharePanel',()=>({default:(props:any)=>{mocks.share(props);return null;}}));
vi.mock('../components/appearance/BeautyWardrobe',()=>({default:({onApply,entries,title}:any)=>{mocks.wardrobe(entries,title);return React.createElement('button',{onClick:()=>onApply({kind:'chat-decoration',read:async()=>({name:'测试心象',parts:{psyche:{styleId:'echo'}}})})},'测试应用');}}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it('returns through application confirmation and import page before leaving decorations', async()=>{
 const host=document.createElement('div'), root=createRoot(host), back=vi.fn();
 try{
  await act(async()=>root.render(React.createElement(BeautyShareChannel,{presets:[],onExport:vi.fn(),onImport:vi.fn(),onBusyChange:vi.fn(),targetCharacterId:'a',onBack:back})));
  await act(async()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='测试应用')!.click());
  expect(host.querySelector('[role=dialog]')).not.toBeNull();
  await act(async()=>{expect(handleLocalBack()).toBe(true);});
  expect(host.querySelector('[role=dialog]')).toBeNull();expect(back).not.toHaveBeenCalled();
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-dress-guide=import]')!.click());
  expect(host.querySelector('h2')?.textContent).toBe('导入装扮');
  await act(async()=>{handleLocalBack();});expect(host.querySelector('h2')?.textContent).toBe('聊天装扮');expect(back).not.toHaveBeenCalled();
  await act(async()=>{handleLocalBack();});expect(back).toHaveBeenCalledOnce();
 }finally{await act(async()=>root.unmount());}
 expect(handleLocalBack()).toBe(false);
});
it('opens the story category as chat decorations without requiring an entry character',async()=>{
 mocks.wardrobe.mockClear();
 const host=document.createElement('div');const root=createRoot(host);
 try{
  await act(async()=>root.render(React.createElement(BeautyShareChannel,{presets:[],onExport:vi.fn(),onImport:vi.fn(),onBusyChange:vi.fn(),initialCategory:'story'})));
  expect(host.querySelector('h2')?.textContent).toBe('聊天装扮');
  const tabs=host.querySelector('.wardrobe-categories')!.textContent!;
  expect(tabs).toContain('提示音见面界面剧情界面');
  expect(tabs).not.toContain('桌面主题');
  const entries=mocks.wardrobe.mock.calls.filter(call=>call[1]==='内置剧情美化').at(-1)![0];
  expect(entries.map((entry:any)=>entry.name)).toEqual(['纯小说','旧书纸页','静夜阅读']);
  expect((await entries[0].read()).parts).toEqual({story:{preset:'novel'}});
 }finally{await act(async()=>root.unmount());}
});
it('defaults to the entry character, supports switching and explicit apply to all without navigating',async()=>{
 mocks.update.mockClear();
 const host=document.createElement('div');const root=createRoot(host);
 try{
  await act(async()=>root.render(React.createElement(BeautyShareChannel,{presets:[{id:'desktop',name:'桌面'} as any],onExport:vi.fn(),onImport:vi.fn(),onBusyChange:vi.fn(),targetCharacterId:'a',onApplied:mocks.done})));
  expect((host.querySelector('[aria-label="当前角色"]') as HTMLSelectElement).value).toBe('a');
  expect(host.textContent).not.toContain('自定义');
  expect(host.querySelector('.wardrobe-categories')?.textContent).not.toContain('桌面主题');
  const builtin=mocks.wardrobe.mock.calls.filter(call=>call[1]==='内置气泡').at(-1)![0];
  expect(builtin.map((entry:any)=>entry.name)).toEqual(Object.values(PRESET_THEMES).map(p=>p.name));
  for(const entry of builtin){expect(await entry.attributionKey()).toBe('');expect((await entry.read()).parts.bubbles).toEqual(PRESET_THEMES[entry.id.replace('builtin-bubble-','')]);}
  const click=async(text:string)=>act(async()=>{Array.from(host.querySelectorAll('button')).find(b=>b.textContent===text)!.click();});
  await click('测试应用');
  expect((host.querySelector('[role=dialog] select') as HTMLSelectElement).value).toBe('a');
  await click('立即应用');
  expect(mocks.update).toHaveBeenCalledWith('a',{thinkingChainStyle:'echo'});
  expect(mocks.active).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.done).not.toHaveBeenCalled();
  expect(host.textContent).toContain('已应用给 甲');
  await act(async()=>Simulate.change(host.querySelector('[aria-label="当前角色"]')!,{target:{value:'b'}} as any));
  await click('测试应用');await click('立即应用');
  expect(mocks.update).toHaveBeenLastCalledWith('b',{thinkingChainStyle:'echo'});
  mocks.update.mockClear();await click('测试应用');
  await act(async()=>Simulate.change(host.querySelector('[role=dialog] input[type=checkbox]')!,{target:{checked:true}} as any));
  await click('立即应用');expect(mocks.update).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('已应用到全部 2 个角色');
 }finally{await act(async()=>root.unmount());}
});

it.each([undefined,'a'])('separates browsing but supplies every category to the unified author page (%s)',async targetCharacterId=>{
 const entries=[{_libraryId:'local-chat-outfit',_collection:'outfit',name:'整套搭配',parts:{css:'body {color:blue}'}},{_libraryId:'local-chat-box',name:'我的白框',parts:{css:'.sully-chat-root {color:red}'}},{_libraryId:'local-chat-schedule',name:'我的日程',parts:{schedule:{preset:'original'}}},{_libraryId:'local-chat-journal',name:'我的日记',parts:{journal:{preset:'original'}}}].map(p=>({...p,format:'sullyos-chat-decoration',version:1}));
 mocks.read.mockImplementation(async(key:string)=>key==='chat_decoration_presets_v1'?JSON.stringify(entries):null);
 mocks.wardrobe.mockClear();mocks.share.mockClear();
 const host=document.createElement('div');const root=createRoot(host);
 try{
  await act(async()=>root.render(React.createElement(BeautyShareChannel,{presets:[{id:'desktop',name:'桌面'} as any],onExport:vi.fn(),onImport:vi.fn(),onBusyChange:vi.fn(),targetCharacterId})));
  const visible=mocks.wardrobe.mock.calls.filter(call=>call[1]==='我的收藏').at(-1)![0].map((item:any)=>item.name);
  expect(visible).toEqual(targetCharacterId?['我的白框']:['桌面','我的日程','我的日记']);
  const tabs=host.querySelector('.wardrobe-categories')!.textContent!;
  expect(tabs.includes('心象')).toBe(!!targetCharacterId);expect(tabs.includes('日程表')).toBe(!targetCharacterId);
  const click=async(text:string)=>act(async()=>{Array.from(host.querySelectorAll('button')).find(b=>b.textContent?.includes(text))!.click();});
  await click('分享装扮');await click('码分享');
  const author=mocks.share.mock.lastCall![0];expect(author.surface).toBe('author');expect(author.unified).toBe(true);
  expect(author.sources.map((item:any)=>item.name)).toEqual(['桌面','整套搭配','我的白框','我的日程','我的日记']);
 }finally{await act(async()=>root.unmount());mocks.read.mockImplementation(async()=>null);}
});
