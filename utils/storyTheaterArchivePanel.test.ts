// @vitest-environment jsdom
import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {StoryTheaterEntry} from '../types';
import StoryArchivePanel from '../components/date/story/StoryArchivePanel';
import {convertStoryArchiveToMemory} from './storyTheaterMemoryConversion';
import {shareOrDownloadFile} from './shareExport';
import {regenerateStoryArchiveSummary} from './storyTheaterArchive';
vi.mock('@phosphor-icons/react',()=>({Archive:()=>null,ArrowClockwise:()=>null,ArrowLeft:()=>null,DownloadSimple:()=>null,SpinnerGap:()=>null}));
vi.mock('../context/OSContext',()=>({useOS:()=>({characters:[{id:'a',name:'阿泽',memoryPalaceEnabled:true},{id:'b',name:'小北',memoryPalaceEnabled:false}],userProfile:{name:'用户'},apiConfig:{baseUrl:'mock',model:'test'},memoryPalaceConfig:{lightLLM:{baseUrl:'mock',model:'test'},embedding:{}},addToast:vi.fn()})}));
vi.mock('../components/date/story/StoryTheaterTheme',()=>({StoryAppearanceButton:()=>null}));
vi.mock('./storyTheaterMemoryConversion',async original=>({...await original<any>(),convertStoryArchiveToMemory:vi.fn()}));
vi.mock('./shareExport',()=>({shareOrDownloadFile:vi.fn().mockResolvedValue('downloaded')}));
vi.mock('./storyTheaterArchive',()=>({regenerateStoryArchiveSummary:vi.fn()}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let root:ReturnType<typeof createRoot>,host:HTMLDivElement,entry:StoryTheaterEntry;
beforeEach(()=>{
 vi.clearAllMocks();entry={id:'story',title:'车站',characterIds:['a','b'],mask:{type:'user'},archives:[{id:'one',strategy:'summary',summary:'雨夜等待的完整摘要。',fromMessageId:1,toMessageId:5,messageCount:5,createdAt:1},{id:'two',strategy:'summary',summary:'第二幕一起回家。',fromMessageId:6,toMessageId:9,messageCount:4,createdAt:2}]} as StoryTheaterEntry;
 host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();});
const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent?.includes(text))!;
const fill=(label:string,value:string)=>act(()=>{const input=host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
function mount(){function App(){const [value,setValue]=useState(entry);return React.createElement(StoryArchivePanel,{entry:value,masks:[],onUpdated:setValue,onBack:()=>{}});}act(()=>root.render(React.createElement(App)));}
it('requires selecting a box and supplying a date before conversion; exports only checked summaries',async()=>{
 mount();expect(button('一键转为记忆').disabled).toBe(true);expect(host.textContent).toContain('雨夜等待的完整摘要');
 act(()=>host.querySelector<HTMLInputElement>('[aria-label="选择事件盒 1"]')!.click());
 expect(button('一键转为记忆').disabled).toBe(true);expect(convertStoryArchiveToMemory).not.toHaveBeenCalled();
 await act(async()=>button('导出选中').click());
 expect(vi.mocked(shareOrDownloadFile).mock.calls[0][0].content).toContain('雨夜等待');expect(vi.mocked(shareOrDownloadFile).mock.calls[0][0].content).not.toContain('第二幕');
 fill('事件盒 1 记忆日期','2026-09-01');expect(button('一键转为记忆').disabled).toBe(false);
});
it('retains failed selections and completed receipts so retry does not re-convert completed boxes',async()=>{
 vi.mocked(convertStoryArchiveToMemory).mockImplementation(async options=>{
  if(options.archiveId==='two')throw new Error('模型暂时不可用');
  const receipt={date:options.date,convertedAt:4,destination:'palace' as const,memoryIds:['n1'],skipped:0};
  return {entry:{...entry,archives:entry.archives.map(b=>b.id==='one'?{...b,memoryConversions:{a:receipt}}:b)},receipt,alreadyConverted:false};
 });
 mount();act(()=>button('全选').click());fill('事件盒 1 记忆日期','2026-09-01');fill('事件盒 2 记忆日期','2026-09-02');
 await act(async()=>button('一键转为记忆').click());
 expect(host.textContent).toContain('已转化给 阿泽');expect(host.querySelector('[role="alert"]')!.textContent).toContain('已完成 1 个');
 expect(host.querySelector<HTMLInputElement>('[aria-label="选择事件盒 1"]')!.checked).toBe(false);expect(host.querySelector<HTMLInputElement>('[aria-label="选择事件盒 2"]')!.checked).toBe(true);
 await act(async()=>button('一键转为记忆').click());expect(vi.mocked(convertStoryArchiveToMemory).mock.calls.map(([o])=>o.archiveId)).toEqual(['one','two','two']);
});
it('regenerates one box without selection or a memory date, disables actions while pending, and renders the saved summary',async()=>{
 let release!:(value:StoryTheaterEntry)=>void;
 vi.mocked(regenerateStoryArchiveSummary).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 mount();const regenerateButton=host.querySelector<HTMLButtonElement>('[aria-label="重新总结事件盒 1"]')!;
 await act(async()=>regenerateButton.click());
 expect(regenerateStoryArchiveSummary).toHaveBeenCalledWith('story','one',expect.objectContaining({model:'test'}));
 expect(regenerateButton.disabled).toBe(true);expect(button('导出选中').disabled).toBe(true);expect(host.querySelector<HTMLButtonElement>('[aria-label="返回剧情"]')!.disabled).toBe(true);
 expect(convertStoryArchiveToMemory).not.toHaveBeenCalled();
 await act(async()=>release({...entry,archives:entry.archives.map(b=>b.id==='one'?{...b,summary:'已重新整理的剧情正文'}:b)}));
 expect(host.textContent).toContain('已重新整理的剧情正文');expect(host.textContent).toContain('第二幕一起回家');expect(regenerateButton.disabled).toBe(false);
});
it('retains summary after a failed regeneration, and exposes empty boxes for recovery',async()=>{
 entry.archives[1].summary='';vi.mocked(regenerateStoryArchiveSummary).mockRejectedValueOnce(new Error('模型没有返回事件盒正文'));
 mount();expect(host.querySelector('[aria-label="重新总结事件盒 2"]')).not.toBeNull();
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="重新总结事件盒 1"]')!.click());
 expect(host.querySelector('[role="alert"]')!.textContent).toContain('没有返回事件盒正文');expect(host.textContent).toContain('雨夜等待的完整摘要');
 expect(host.querySelector<HTMLButtonElement>('[aria-label="重新总结事件盒 1"]')!.disabled).toBe(false);
});
