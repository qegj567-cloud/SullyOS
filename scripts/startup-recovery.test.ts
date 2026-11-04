import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
// @ts-expect-error jsdom is installed for tests without its separate declaration package.
import {JSDOM} from 'jsdom';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const source=readFileSync(new URL('../public/startup-recovery.js',import.meta.url),'utf8');
let dom:JSDOM;
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{dom?.window.close();vi.useRealTimers();});
function boot(manual=false,serviceWorker?:any,saved:Record<string,string>={}){
 dom?.window.close();
 dom=new JSDOM('<!doctype html><head></head><body><div id="root"></div></body>',{url:'https://app.invalid/SullyOS/'+(manual?'recover.html':'?private=secret')});
 const {window}=dom,document=window.document;
 for(const [key,value] of Object.entries(saved))window.localStorage.setItem(key,value);
 const script=document.createElement('script');script.setAttribute('data-base','./');script.setAttribute('data-build','test-build');
 if(manual)script.setAttribute('data-mode','recovery');
 Object.defineProperty(document,'currentScript',{get:()=>script});
 const location={origin:window.location.origin,pathname:window.location.pathname,reload:vi.fn(),replace:vi.fn()};
 const navigator={serviceWorker,onLine:true,userAgent:'Test browser'};
 const channels:any[]=[];
 class MessageChannel{
  port1={onmessage:null as any,close:vi.fn()};
  port2={postMessage:(data:any)=>queueMicrotask(()=>this.port1.onmessage?.({data})),close:vi.fn()};
  constructor(){channels.push(this);}
 }
 runInNewContext(source,{window,document,navigator,location,URL,Date,MessageChannel,MutationObserver:window.MutationObserver,setTimeout,clearTimeout,setInterval,clearInterval});
 document.dispatchEvent(new window.Event('DOMContentLoaded'));
 return {window,document,location,navigator,channels};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const click=(d:Document,label:string)=>{const button=[...d.querySelectorAll('button')].find(b=>b.textContent===label)!;expect(button).toBeTruthy();button.click();};
const snapshot=(window:any):Record<string,string>=>Object.fromEntries(
 Array.from({length:window.localStorage.length},(_,i)=>window.localStorage.key(i)).map(key=>[key,window.localStorage.getItem(key)]));
const report=(window:any):string=>window.__sullyStartupDiagnosticReport();
const prefix='sully_startup_diagnostics_v1_';
function cachedWorker(){return {state:'installed',postMessage:vi.fn((message:any,ports?:any[])=>{
 if(message.type==='SULLY_CACHE_PREPARE')ports![0].postMessage({offlineReady:true});
})};}
describe('startup recovery independent of application modules',()=>{
 it('shows module-evaluation errors even when React never loads, without query strings',()=>{
  const {window,document}=boot();
  window.dispatchEvent(new window.ErrorEvent('error',{message:'createBlobStore: prefix must be a non-empty string',filename:'https://app.invalid/assets/vendor.js?private=secret',lineno:40}));
  vi.advanceTimersByTime(1);
  expect(document.querySelector('h1')?.textContent).toBe('启动遇到问题');
  expect(document.querySelector('textarea')?.value).toContain('createBlobStore');
  expect(document.querySelector('textarea')?.value).not.toContain('private=secret');
 });
 it('offers recovery for a stalled startup, then disappears if the app finishes loading',async()=>{
  const {document}=boot();vi.advanceTimersByTime(11999);expect(document.querySelector('section')).toBeNull();
  vi.advanceTimersByTime(1);expect(document.querySelector('h1')?.textContent).toBe('启动尚未完成');
  document.getElementById('root')!.appendChild(document.createElement('main'));await flush();
  expect(document.querySelector('section')).toBeNull();
 });
 it('does not cover a healthy app or reload it for unrelated async errors',()=>{
  const {window,document,location}=boot();document.getElementById('root')!.innerHTML='<main>用户正在聊天</main>';
  window.dispatchEvent(new window.ErrorEvent('error',{message:'optional feature failed'}));vi.advanceTimersByTime(15000);
  expect(document.querySelector('section')).toBeNull();expect(location.reload).not.toHaveBeenCalled();
 });
 it('reuses the scoped registration, activates a waiting update and navigates only once controlled',async()=>{
  const container=new EventTarget() as any,waiting=cachedWorker();
  const registration={scope:'https://app.invalid/SullyOS/',waiting,update:vi.fn().mockResolvedValue(undefined),unregister:vi.fn()};
  container.getRegistration=vi.fn().mockResolvedValue(registration);container.register=vi.fn();
  const {document,location}=boot(true,container);click(document,'检查更新并重试');await flush();
  expect(registration.update).toHaveBeenCalledOnce();expect(container.register).not.toHaveBeenCalled();expect(registration.unregister).not.toHaveBeenCalled();
  expect(waiting.postMessage).toHaveBeenCalledWith({type:'SULLY_ACTIVATE_UPDATE'});expect(location.replace).not.toHaveBeenCalled();
  container.controller=waiting;container.dispatchEvent(new Event('controllerchange'));
  expect(location.replace).toHaveBeenCalledOnce();expect(location.replace).toHaveBeenCalledWith('https://app.invalid/SullyOS/');
 });
 it('shows a bounded failure when offline instead of a reload loop or deleting data',async()=>{
  const container=new EventTarget() as any;container.getRegistration=vi.fn().mockRejectedValue(Error('offline'));
  const {document,location}=boot(true,container);click(document,'检查更新并重试');await flush();
  expect(document.body.textContent).toContain('更新尚未完成');expect(location.replace).not.toHaveBeenCalled();
  expect(document.querySelector('button')?.disabled).toBe(false);
 });
 it('leaves slow installation retryable after the timeout',async()=>{
  const container=new EventTarget() as any;
  container.getRegistration=vi.fn().mockResolvedValue({scope:'https://app.invalid/SullyOS/',installing:{},update:vi.fn().mockResolvedValue(undefined)});
  const {document,location}=boot(true,container);click(document,'检查更新并重试');await flush();vi.advanceTimersByTime(120000);
  expect(document.body.textContent).toContain('更新尚未完成');expect(location.replace).not.toHaveBeenCalled();expect(document.querySelector('button')?.disabled).toBe(false);
 });
 it('cancels a pending recovery if the main app becomes usable',async()=>{
  const container=new EventTarget() as any,waiting=cachedWorker();
  container.getRegistration=vi.fn().mockResolvedValue({scope:'https://app.invalid/SullyOS/',waiting,update:vi.fn().mockResolvedValue(undefined)});
  const {window,document,location}=boot(false,container);
  window.dispatchEvent(new window.ErrorEvent('error',{message:'temporary error'}));vi.advanceTimersByTime(1);
  click(document,'检查更新并重试');await flush();document.getElementById('root')!.innerHTML='<main>聊天</main>';await flush();
  container.controller=waiting;container.dispatchEvent(new Event('controllerchange'));
  expect(document.querySelector('section')).toBeNull();expect(location.reload).not.toHaveBeenCalled();
 });
});

describe('repairing the current startup cache before reopening',()=>{
 it('prepares the already-current worker even when update finds no new release',async()=>{
  const container=new EventTarget() as any,active=cachedWorker();active.state='activated';
  container.getRegistration=vi.fn().mockResolvedValue({scope:'https://app.invalid/SullyOS/',active,update:vi.fn().mockResolvedValue(undefined)});
  const {document,location,channels}=boot(true,container);
  click(document,'检查更新并重试');await flush();
  expect(active.postMessage).toHaveBeenCalledWith({type:'SULLY_CACHE_PREPARE'},[channels[0].port2]);
  expect(location.replace).toHaveBeenCalledOnce();expect(location.replace).toHaveBeenCalledWith('https://app.invalid/SullyOS/');
  expect(channels[0].port1.close).toHaveBeenCalled();expect(channels[0].port2.close).toHaveBeenCalled();
 });
 it('waits for resources instead of refreshing again into the same incomplete cache',async()=>{
  const container=new EventTarget() as any,active={postMessage:vi.fn()};
  container.getRegistration=vi.fn().mockResolvedValue({scope:'https://app.invalid/SullyOS/',active,update:vi.fn().mockResolvedValue(undefined)});
  const {document,location,channels}=boot(true,container);
  click(document,'检查更新并重试');await flush();vi.advanceTimersByTime(3000);
  expect(active.postMessage).toHaveBeenCalledOnce();expect(location.replace).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('校验并补齐启动资源');
  channels[0].port2.postMessage({offlineReady:true});await flush();
  expect(location.replace).toHaveBeenCalledOnce();
 });
 it('keeps failed preparation retryable and does not activate an incomplete update',async()=>{
  const container=new EventTarget() as any,waiting={state:'installed',postMessage:vi.fn()};
  container.getRegistration=vi.fn().mockResolvedValue({scope:'https://app.invalid/SullyOS/',waiting,update:vi.fn().mockResolvedValue(undefined)});
  const {document,location,channels}=boot(true,container);
  click(document,'检查更新并重试');await flush();channels[0].port2.postMessage({error:'download failed'});await flush();
  expect(location.replace).not.toHaveBeenCalled();expect(document.querySelector('button')!.disabled).toBe(false);
  expect(waiting.postMessage).not.toHaveBeenCalledWith({type:'SULLY_ACTIVATE_UPDATE'});
  click(document,'检查更新并重试');await flush();channels[1].port2.postMessage({offlineReady:true});await flush();
  expect(waiting.postMessage).toHaveBeenCalledWith({type:'SULLY_ACTIVATE_UPDATE'});
  container.controller=waiting;container.dispatchEvent(new Event('controllerchange'));
  expect(location.replace).toHaveBeenCalledOnce();
 });
 it('closes timed-out preparation and ignores late replies until the user retries',async()=>{
  const container=new EventTarget() as any,active={postMessage:vi.fn()};
  container.getRegistration=vi.fn().mockResolvedValue({scope:'https://app.invalid/SullyOS/',active,update:vi.fn().mockResolvedValue(undefined)});
  const {document,location,channels}=boot(true,container);
  click(document,'检查更新并重试');await flush();vi.advanceTimersByTime(120000);
  expect(document.querySelector('button')!.disabled).toBe(false);expect(channels[0].port1.close).toHaveBeenCalled();
  channels[0].port2.postMessage({offlineReady:true});await flush();
  expect(location.replace).not.toHaveBeenCalled();
 });
});

describe('local startup failure history',()=>{
 it('retains the first download failure across reload and recovery, without arbitrary text or queries',()=>{
  const first=boot(false,{controller:{}});
  const script=first.document.createElement('script');
  script.src='https://app.invalid/SullyOS/assets/build/main-abc.js?key=secret#private';
  first.document.head.appendChild(script);script.dispatchEvent(new first.window.Event('error'));
  first.window.dispatchEvent(new first.window.ErrorEvent('error',{message:'tailwind is not defined',filename:'https://app.invalid/SullyOS/?key=secret',lineno:4}));
  first.window.dispatchEvent(new first.window.ErrorEvent('error',{message:'private chat and API secret',filename:'https://api.invalid/private/key-secret.js',lineno:6}));
  vi.advanceTimersByTime(1000);
  expect(first.document.querySelector('textarea')!.value).toContain('本页报错：启动脚本加载失败');
  const saved=snapshot(first.window),raw=Object.values(saved).join('');
  expect(raw).toContain('assets/build/main-abc.js');
  expect(raw).not.toMatch(/private|secret|key=|tailwind is not defined|api.invalid/);
  const recovered=boot(true,undefined,saved);
  expect(report(recovered.window)).toContain('script-load 在线 SW=控制中 assets/build/main-abc.js');
  expect(report(recovered.window)).toContain('missing-global');
  expect(report(recovered.window)).not.toContain('private chat');
  // Opening the repair page must not manufacture a new startup failure.
  vi.advanceTimersByTime(15000);
  expect(snapshot(recovered.window)).toEqual(saved);
 });
 it('makes past failures available after a later healthy load without automatic storage access',()=>{
  const first=boot();
  first.window.dispatchEvent(new first.window.ErrorEvent('error',{message:'Unexpected EOF',filename:'https://app.invalid/SullyOS/assets/build/vendor-react-abc.js',lineno:40}));
  first.window.dispatchEvent(new first.window.Event('pagehide'));
  const second=boot(false,undefined,snapshot(first.window));
  const read=vi.spyOn(second.window.Storage.prototype,'getItem'),write=vi.spyOn(second.window.Storage.prototype,'setItem');
  second.document.getElementById('root')!.innerHTML='<main>桌面</main>';
  vi.advanceTimersByTime(15000);
  expect(read).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
  expect(report(second.window)).toContain('unexpected-eof');
  expect(report(second.window)).toContain('vendor-react-abc.js:40');
  read.mockRestore();write.mockRestore();
 });
 it('records slow startup and distinguishes a later mount without claiming application health',async()=>{
  const {window,document}=boot();vi.advanceTimersByTime(12000);
  document.getElementById('root')!.innerHTML='<div hidden data-database-pending aria-busy="true"></div>';await flush();
  vi.advanceTimersByTime(1000);
  const record=JSON.parse(Object.values(snapshot(window))[0]);
  expect(record.events[0].kind).toBe('startup-waiting');expect(record.mountedAfterFailure).toBe(true);
  expect(report(window)).toContain('同页随后挂载；不代表全部功能正常');
  expect(document.querySelector('#sully-startup-recovery')).toBeNull();
 });
 it('preserves independent failing sessions, bounds records and never removes application data',()=>{
  const saved:Record<string,string>={'user-settings':'preserved'};
  for(let i=1;i<=12;i++)saved[prefix+i]=JSON.stringify({at:i,build:'old-build',events:[{kind:'script-load',elapsedMs:1,resource:'assets/build/old.js',line:0}],mountedAfterFailure:false});
  const {window}=boot(false,undefined,saved);
  for(let i=0;i<20;i++)window.dispatchEvent(new window.ErrorEvent('error',{message:'Unexpected EOF',filename:'https://app.invalid/SullyOS/assets/build/file-'+i+'.js',lineno:i}));
  vi.advanceTimersByTime(1000);
  const stored=snapshot(window),keys=Object.keys(stored).filter(key=>key.startsWith(prefix));
  expect(keys).toHaveLength(8);expect(stored['user-settings']).toBe('preserved');
  expect(stored[prefix+'12']).toBe(saved[prefix+'12']);expect(stored[prefix+'1']).toBeUndefined();
  const current=JSON.parse(stored[keys.find(key=>!saved[key])!]);
  expect(current.events).toHaveLength(8);expect(current.events[0].resource).toContain('file-0.js');
 });
 it('keeps recovery and copying usable when localStorage is denied',()=>{
  const {window,document,location}=boot();
  Object.defineProperty(window,'localStorage',{get(){throw Error('denied');}});
  window.dispatchEvent(new window.ErrorEvent('error',{message:'Unexpected EOF',filename:'https://app.invalid/SullyOS/assets/build/main-abc.js'}));
  vi.advanceTimersByTime(15000);
  expect(report(window)).toContain('unexpected-eof');expect(report(window)).toContain('无法访问或写入');
  click(document,'重新打开');expect(location.reload).toHaveBeenCalledOnce();
 });
 it('ignores malformed history and unapproved fields when exporting',()=>{
  const saved={
   [prefix+'invalid']:'{',
   [prefix+'poisoned']:JSON.stringify({at:1,build:'old-build',secret:'private',events:[{kind:'script-load',elapsedMs:1,resource:'https://api.invalid/key-secret',line:1,message:'private'}]}),
   [prefix+'infinite']:JSON.stringify({at:1e20,build:'old-build',events:[]}),
  };
  const {window}=boot(true,undefined,saved);
  expect(report(window)).toContain('script-load');expect(report(window)).not.toMatch(/api.invalid|key-secret|private/);
 });
 it('classifies a rejected module import and records only its approved static path',()=>{
  const {window}=boot();
  const event=new window.Event('unhandledrejection');
  Object.defineProperty(event,'reason',{value:new Error('Failed to fetch dynamically imported module: https://app.invalid/SullyOS/assets/build/chunk-abc.js?key=secret')});
  window.dispatchEvent(event);window.dispatchEvent(new window.Event('pagehide'));
  const raw=Object.values(snapshot(window)).join('');
  expect(raw).toContain('module-load');expect(raw).toContain('assets/build/chunk-abc.js');expect(raw).not.toContain('secret');
 });
});
