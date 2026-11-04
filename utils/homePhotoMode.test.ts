// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import HomePhotoMode from '../apps/room3d/HomePhotoMode';
import {PHOTO_LETTERING_KEY} from '../apps/room3d/photoLettering';
vi.mock('../apps/room3d/PhotoActions',()=>({PhotoActions:()=>null}));
vi.mock('../apps/room3d/PhotoFilterPresets',()=>({default:()=>null}));
vi.mock('../utils/shareExport',()=>({shareOrDownloadBlob:vi.fn()}));
vi.mock('@phosphor-icons/react',()=>({Camera:()=>null,X:()=>null,DownloadSimple:()=>null,ArrowCounterClockwise:()=>null}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const host=document.createElement('div');document.body.append(host);let root:ReturnType<typeof createRoot>;
beforeEach(()=>{
 localStorage.clear();
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(390);vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(844);
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>setTimeout(()=>fn(0),0));vi.stubGlobal('cancelAnimationFrame',clearTimeout);
 vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn(()=>'blob:photo'),revokeObjectURL:vi.fn()}));
 HTMLCanvasElement.prototype.setPointerCapture=vi.fn();
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({fillRect:vi.fn(),drawImage:vi.fn(),save:vi.fn(),restore:vi.fn(),translate:vi.fn(),scale:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),bezierCurveTo:vi.fn(),closePath:vi.fn(),fill:vi.fn(),fillText:vi.fn(),measureText:vi.fn(()=>({width:100}))} as any);
 vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(cb=>cb(new Blob(['png'],{type:'image/png'})));
 root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();});
async function setup(actors:Array<{id:string;label:string}>=[]){const editor={beginPhotoMode:vi.fn(()=>actors),endPhotoMode:vi.fn(),setPhotoCamera:vi.fn(),setPhotoTogether:vi.fn(),renderPhoto:vi.fn(),subscribePhoto:vi.fn(()=>()=>{})};const close=vi.fn();await act(async()=>{root.render(React.createElement(HomePhotoMode,{editor:editor as any,onClose:close}));});await act(async()=>{await new Promise(r=>setTimeout(r,10));});return {editor,close};}
async function click(label:string){const button=[...host.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent)===label)!;expect(button).toBeTruthy();await act(async()=>button.click());}
it('opens the lens controls in portrait and exports the chosen aspect',async()=>{
 const {editor}=await setup();expect(editor.renderPhoto.mock.calls.at(-1)?.[2]).toMatchObject({aspect:3/4,quality:'preview'});
 await click('镜头');await click('电影 2.39:1');await click('拍下合影');
 const call=editor.renderPhoto.mock.calls.find(c=>c[2]?.quality==='export')!;expect(call[2].aspect).toBe(2.39);expect(call[0]).not.toBe(host.querySelector('.photo-view'));expect(host.querySelector('img[alt="拍好的合影"]')).toBeTruthy();
});
it.each(['奶油拍立得','爱心大头贴','四格贴纸'])('exports %s with the same photo windows as its preview',async label=>{
 const {editor}=await setup();await click(label);await click('拍下合影');
 const call=editor.renderPhoto.mock.calls.find(c=>c[2]?.quality==='export')!;expect(call[2].aspect).toBe(1);
 expect(host.querySelector('img[alt="拍好的合影"]')).toBeTruthy();
});
it('stages a close-up only when selected and restores full-body framing when leaving the sticker layout',async()=>{
 const {editor}=await setup([{id:'a',label:'小白'},{id:'b',label:'小绿'}]);expect(editor.setPhotoTogether).not.toHaveBeenCalled();
 await click('爱心大头贴');expect(editor.setPhotoTogether).toHaveBeenCalledWith(.85);expect(editor.setPhotoCamera).toHaveBeenLastCalledWith(expect.objectContaining({zoom:1.65,height:1.75}));
 await click('全身 9:16');expect(editor.setPhotoCamera).toHaveBeenLastCalledWith(expect.objectContaining({zoom:1,height:1.2}));
});
it('maps sideways drags into camera coordinates and leaves the shared application unrotated',async()=>{
 const {editor}=await setup();await click('横屏取景');expect(host.querySelector('.home-photo-mode')?.getAttribute('data-sideways')).toBe('true');expect(host.style.transform).toBe('');
 const canvas=host.querySelector('canvas')!;const send=(type:string,x:number,y:number)=>canvas.dispatchEvent(Object.assign(new MouseEvent(type,{bubbles:true,clientX:x,clientY:y}),{pointerId:1}));
 act(()=>{send('pointerdown',50,50);send('pointermove',50,90);send('pointerup',50,90);});
 expect(editor.setPhotoCamera).toHaveBeenLastCalledWith(expect.objectContaining({yaw:-14,pitch:4}));await click('回到竖屏');expect(host.querySelector('.home-photo-mode')?.getAttribute('data-sideways')).toBe('false');
});
it('requests real negative space through camera pan and preserves the existing exit path',async()=>{
 const {editor,close}=await setup();await click('镜头');await click('左侧留白');expect(editor.setPhotoCamera).toHaveBeenLastCalledWith(expect.objectContaining({pan:-2,zoom:.78}));expect(host.querySelector('.photo-format-label')?.textContent).toBe('竖幅 3:4');await click('退出拍照');expect(close).toHaveBeenCalledOnce();
});
async function edit(label:string,value:string){
 const input=host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement|HTMLSelectElement;
 const prototype=input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
 await act(async()=>{Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));await new Promise(r=>setTimeout(r,10));});
 await act(async()=>{await new Promise(r=>setTimeout(r,10));});
}
it('uses edited text in preview and export, remembers each paper, and permits a blank footer',async()=>{
 await setup();await click('奶油拍立得');
 await edit('相纸主文案','和你一起过万圣节 ♡');await edit('相纸底部小字','');await edit('相纸字体','handwritten');
 const context=host.querySelector('canvas')!.getContext('2d')!;
 expect(context.fillText).toHaveBeenCalledWith('和你一起过万圣节 ♡',expect.any(Number),expect.any(Number),expect.any(Number));
 expect(context.font).toContain('KaiTi');
 await click('爱心大头贴');expect((host.querySelector('[aria-label="相纸主文案"]') as HTMLInputElement).value).toBe('you make me smile');
 await click('奶油拍立得');expect((host.querySelector('[aria-label="相纸主文案"]') as HTMLInputElement).value).toBe('和你一起过万圣节 ♡');
 vi.mocked(context.fillText).mockClear();await click('拍下合影');
 expect(context.fillText).toHaveBeenCalledWith('和你一起过万圣节 ♡',1024,2560*.87,2048*.58);
 expect(context.fillText).not.toHaveBeenCalledWith('S U L L Y  ·  H O M E',expect.anything(),expect.anything(),expect.anything());
 expect(JSON.parse(localStorage.getItem(PHOTO_LETTERING_KEY)!)).toMatchObject({polaroid:{title:'和你一起过万圣节 ♡',footer:'',font:'handwritten'}});
 act(()=>root.unmount());root=createRoot(host);await setup();await click('奶油拍立得');
 expect((host.querySelector('[aria-label="相纸主文案"]') as HTMLInputElement).value).toBe('和你一起过万圣节 ♡');
 await click('恢复这款相纸的文字');expect((host.querySelector('[aria-label="相纸主文案"]') as HTMLInputElement).value).toBe('a little moment');
});
it('waits for the chosen font before rendering the saved photo',async()=>{
 const {editor}=await setup();await click('奶油拍立得');
 let loaded!:()=>void;
 const pending=new Promise<void>(resolve=>{loaded=resolve;});
 const original=Object.getOwnPropertyDescriptor(document,'fonts');
 Object.defineProperty(document,'fonts',{configurable:true,value:{load:vi.fn(()=>pending)}});
 try{
  await click('拍下合影');expect(editor.renderPhoto.mock.calls.some(c=>c[2]?.quality==='export')).toBe(false);
  expect((host.querySelector('[aria-label="拍下合影"]') as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>loaded());expect(editor.renderPhoto.mock.calls.some(c=>c[2]?.quality==='export')).toBe(true);
 }finally{if(original)Object.defineProperty(document,'fonts',original);else Reflect.deleteProperty(document,'fonts');}
});
