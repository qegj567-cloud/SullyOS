// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import DateApp from '../apps/DateApp';
import BankAnalytics from '../components/bank/BankAnalytics';
import DecorationDraftEditor from '../components/chat/DecorationDraftEditor';
import {appShortcutLaunch} from './appShortcutLaunch';
import {AppID, type Message, type BankTransaction} from '../types';
import {DB} from './db';
import {makeWorkshopPreset} from './decorationWorkshop';
import {shareOrDownloadFile} from './shareExport';
import {saveLibraryDecoration} from './decorationLibrary';

const os = vi.hoisted(() => ({theme:{},apiConfig:{},characters:[{id:'date-ui',name:'示例角色',avatar:''}],characterGroups:[],groups:[],activeCharacterId:'date-ui',setActiveCharacterId:vi.fn(),userProfile:{name:'我'},virtualTime:{hours:10,minutes:0},registerBackHandler:()=>()=>{},addToast:vi.fn(),updateCharacter:vi.fn(),updateUserProfile:vi.fn(),closeApp:vi.fn(),openApp:vi.fn(),consumeDateAutoStart:vi.fn()}));
vi.mock('../context/OSContext',()=>({useOS:()=>os}));
vi.mock('../components/date/DateSession',()=>({default:()=>null}));
vi.mock('../components/date/DateSettings',()=>({default:()=>React.createElement('p',null,'见面设置测试页')}));
vi.mock('../components/date/story/StoryTheater',()=>({default:()=>null}));
vi.mock('../components/share/BeautyPresetPreview',()=>({default:()=>null}));
vi.mock('./shareExport',()=>({shareOrDownloadFile:vi.fn(async()=> 'downloaded')}));
vi.mock('./decorationLibrary',async importOriginal=>({...await importOriginal<any>(),saveLibraryDecoration:vi.fn(async()=>{})}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement, root:Root;
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);vi.clearAllMocks();});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.restoreAllMocks();});
const click=async(text:string)=>{
 const button=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);
 expect(button,text).toBeTruthy();await act(async()=>button!.click());
};
const change=async(element:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement,value:string)=>{
 const prototype=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
 await act(async()=>{Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));});
};

it('shows oldest date beyond 500 records, filters by day, and mounts text only after expansion',async()=>{
 const messages=Array.from({length:530},(_,i)=>({id:i+1,charId:'date-ui',role:'assistant',type:'text',content:`记录正文 ${i+1}`,timestamp:new Date(2025,0,i+1,10).getTime(),metadata:{source:'date',dateEncounterId:`e-${i}`}} as Message));
 const read=vi.spyOn(DB,'getRecentMessagesByCharIdAndSource').mockResolvedValue(messages);
 appShortcutLaunch.request({appId:AppID.Date,entryId:'history',characterId:'date-ui'});
 await act(async()=>root.render(React.createElement(DateApp)));
 expect(read).toHaveBeenCalledWith('date-ui','date',Number.MAX_SAFE_INTEGER);
 expect(host.textContent).toContain('530 组');
 expect(host.textContent).not.toContain('记录正文');
 await click('新 → 旧');
 const first=host.querySelector('button[aria-expanded]')!;
 expect(first.textContent).toContain('2025-01-01');
 await change(host.querySelector('input[type="date"]')!, '2025-01-01');
 expect(host.querySelectorAll('button[aria-expanded]')).toHaveLength(1);
 await act(async()=> (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click());
 expect(host.textContent).toContain('记录正文 1');
 await click('导出当天');
 expect(vi.mocked(shareOrDownloadFile).mock.calls.at(-1)![0].content).toContain('记录正文 1');
});

it('does not reopen history after a slow read and a newer settings shortcut',async()=>{
 let resolve!:(messages:Message[])=>void;
 vi.spyOn(DB,'getRecentMessagesByCharIdAndSource').mockImplementation(()=>new Promise(done=>{resolve=done;}));
 appShortcutLaunch.request({appId:AppID.Date,entryId:'history',characterId:'date-ui'});
 await act(async()=>root.render(React.createElement(DateApp)));
 await act(async()=>appShortcutLaunch.request({appId:AppID.Date,entryId:'settings',characterId:'date-ui'}));
 await act(async()=>resolve([]));
 expect(host.textContent).toContain('见面设置测试页');
 expect(host.textContent).not.toContain('这个范围暂无见面记录');
});

it('finds an encounter in either month when its messages cross a month boundary',async()=>{
 const messages=[new Date(2025,11,31,23,59),new Date(2026,0,1,0,1)].map((date,i)=>({id:i+1,charId:'date-ui',role:'assistant',type:'text',content:`跨年 ${i}`,timestamp:date.getTime(),metadata:{source:'date',dateEncounterId:'same-encounter'}} as Message));
 vi.spyOn(DB,'getRecentMessagesByCharIdAndSource').mockResolvedValue(messages);
 appShortcutLaunch.request({appId:AppID.Date,entryId:'history',characterId:'date-ui'});
 await act(async()=>root.render(React.createElement(DateApp)));
 const months=host.querySelector('select')!;
 expect([...months.options].map(option=>option.value)).toEqual(['','2026-01','2025-12']);
 await change(months,'2026-01');
 expect(host.querySelectorAll('button[aria-expanded]')).toHaveLength(1);
 await act(async()=> (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click());
 expect(host.textContent).toContain('跨年 0');expect(host.textContent).toContain('跨年 1');
});

it('ledger all-history and month views separate income and export their actual scopes',async()=>{
 const txs:BankTransaction[]=[{id:'old',amount:12.35,note:'去年午餐',category:'food',dateStr:'2025-01-02',timestamp:1},{id:'new',amount:3000,type:'income',note:'稿费',category:'general',dateStr:'2026-10-27',timestamp:2}];
 vi.spyOn(DB,'getAllTransactions').mockResolvedValue(txs);
 await act(async()=>root.render(React.createElement(BankAnalytics,{transactions:txs,goals:[],currency:'¥',onDeleteTx:()=>{}})));
 await click('全部'); expect(host.textContent).toContain('收入 ¥3000 · 结余 ¥2987.65');
 await click('按月');await change(host.querySelector('input[type="month"]')!,'2025-01');
 expect(host.textContent).toContain('去年午餐');expect(host.textContent).not.toContain('稿费');
 await click('导出当前范围 CSV');
 expect(vi.mocked(shareOrDownloadFile).mock.calls.at(-1)![0].content).not.toContain('稿费');
 await click('导出全部CSV');
 expect(vi.mocked(shareOrDownloadFile).mock.calls.at(-1)![0].content).toContain('稿费');
});

it('story maker edits CSS and keeps it when changing the base preset before saving',async()=>{
 await act(async()=>root.render(React.createElement(DecorationDraftEditor,{preset:makeWorkshopPreset('story'),origin:{kind:'self'} as any,theme:{} as any,sources:[],maker:'story',onOpenWorkshop:()=>{},onClose:()=>{},onSaved:()=>{}})));
 const css='.meeting-reading { --meeting-paper: #ffeedd; }';
 await change(document.querySelector('textarea[aria-label="剧情界面 CSS"]')!,css);
 await change(document.querySelector('select')!,'night');
 expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(css);
 await click('保存预设');
 expect(saveLibraryDecoration).toHaveBeenCalledWith(expect.objectContaining({parts:{story:{preset:'night',customCss:css}}}),expect.anything(),undefined,undefined);
});
