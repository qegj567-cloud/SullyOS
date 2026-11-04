// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import * as T from 'three';
import {createPhotoRenderer} from '../apps/room3d/photoRenderer';
import {photoFrames,photoSize,photoDrag} from '../apps/room3d/photoFrame';
vi.mock('../apps/room3d/photoEffects',()=>({paintPhoto:vi.fn()}));
afterEach(()=>vi.restoreAllMocks());
function setup(){
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn()} as any);
 const canvas=document.createElement('canvas'),size=new T.Vector2(390,844);let ratio=2;
 const renderer={domElement:canvas,getSize:(out:T.Vector2)=>out.copy(size),getPixelRatio:()=>ratio,setPixelRatio:(v:number)=>{ratio=v;},setSize:(w:number,h:number)=>{size.set(w,h);canvas.width=w*ratio;canvas.height=h*ratio;}};
 renderer.setSize(390,844);const camera=new T.OrthographicCamera(-2,2,4,-4);camera.zoom=1.6;
 camera.setViewOffset(1000,1000,5,10,800,900);const view={...camera.view};
 const capture=vi.fn(),pipeline=createPhotoRenderer(renderer as any,camera,capture),out=document.createElement('canvas');
 const look={preset:'daylight' as const,glow:.55,fringe:.6,vignette:.12,exposure:1.02};
 return {pipeline,renderer,camera,capture,out,look,view,size};
}
it('reuses the frozen scene for filter-only changes and invalidates for camera/pose changes',()=>{
 const s=setup();s.pipeline.render(s.out,s.look,{aspect:16/9});
 for(let i=0;i<10;i++)s.pipeline.render(s.out,{...s.look,exposure:.8+i*.03},{aspect:16/9});
 expect(s.capture).toHaveBeenCalledTimes(1);expect(s.pipeline.inspect()).toMatchObject({width:1280,height:720});
 s.pipeline.invalidate();s.pipeline.render(s.out,s.look,{aspect:16/9});expect(s.capture).toHaveBeenCalledTimes(2);
 s.pipeline.dispose();
});
it('uses the same framing at preview/export resolution, then restores renderer and view offset',()=>{
 const s=setup();s.pipeline.render(s.out,s.look,{aspect:16/9,quality:'moving'});expect(s.pipeline.inspect().width).toBe(768);
 const bounds=[s.camera.left,s.camera.right,s.camera.top,s.camera.bottom];
 s.pipeline.render(s.out,s.look,{aspect:16/9,quality:'export'});expect(s.pipeline.inspect()).toMatchObject({width:2560,height:1440});
 expect([s.camera.left,s.camera.right,s.camera.top,s.camera.bottom]).toEqual(bounds);expect(s.camera.zoom).toBe(1.6);
 s.pipeline.dispose();expect(s.renderer.getPixelRatio()).toBe(2);expect(s.size.toArray()).toEqual([390,844]);expect(s.camera.view).toEqual(s.view);expect([s.camera.left,s.camera.right]).toEqual([-2,2]);
});
it('does not cache a failed capture and can retry',()=>{
 const s=setup();s.capture.mockImplementationOnce(()=>{throw Error('temporary');});
 expect(()=>s.pipeline.render(s.out,s.look)).toThrow('temporary');s.pipeline.render(s.out,s.look);expect(s.capture).toHaveBeenCalledTimes(2);s.pipeline.dispose();
});
it('keeps every export aspect within a pixel of its preview and maps sideways gestures',()=>{
 for(const {aspect}of Object.values(photoFrames)){for(const quality of ['moving','preview','export']as const){const {width,height}=photoSize(aspect,quality);expect(Math.abs(width-height*aspect)).toBeLessThan(1.3);expect(Math.max(width,height)).toBeLessThanOrEqual(2560);}}
 expect(photoDrag(0,40,true)).toEqual({dx:40,dy:-0});expect(photoDrag(40,0,true)).toEqual({dx:0,dy:-40});expect(photoDrag(10,20,false)).toEqual({dx:10,dy:20});
});
