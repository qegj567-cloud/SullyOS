// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {composePhoto,photoCaptureAspect,photoWindows} from '../apps/room3d/photoComposition';
import {photoFrames,type PhotoFrame} from '../apps/room3d/photoFrame';
import {PHOTO_LETTERING_KEY,readPhotoLettering} from '../apps/room3d/photoLettering';
it.each(Object.keys(photoFrames) as PhotoFrame[])('%s keeps its framing and all photo windows inside the exported paper',format=>{
 const source=document.createElement('canvas'),output=document.createElement('canvas');
 const ctx={fillRect:vi.fn(),drawImage:vi.fn(),save:vi.fn(),restore:vi.fn(),translate:vi.fn(),scale:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),bezierCurveTo:vi.fn(),closePath:vi.fn(),fill:vi.fn(),fillText:vi.fn(),measureText:vi.fn(()=>({width:100}))};
 vi.spyOn(output,'getContext').mockReturnValue(ctx as any);
 for(const quality of ['preview','export'] as const){composePhoto(source,output,format,quality);expect(output.width/output.height).toBeCloseTo(photoFrames[format].aspect,2);}
 for(const r of photoWindows(format)){expect(r.x+r.w).toBeLessThanOrEqual(1);expect(r.y+r.h).toBeLessThanOrEqual(1);expect(photoFrames[format].aspect*r.w/r.h).toBeCloseTo(photoCaptureAspect(format),5);}
 expect(Math.max(output.width,output.height)).toBe(2560);
 expect(ctx.drawImage).toHaveBeenCalledTimes(photoWindows(format).length*2);
});
it('fits long custom captions within decorations and follows the uploaded system font',()=>{
 const source=document.createElement('canvas'),output=document.createElement('canvas'),draws:Array<{font:string;text:string;width:number}>=[];
 const ctx={font:'',fillRect:vi.fn(),drawImage:vi.fn(),save:vi.fn(),restore:vi.fn(),translate:vi.fn(),scale:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),bezierCurveTo:vi.fn(),closePath:vi.fn(),fill:vi.fn(),measureText:(text:string)=>({width:parseFloat(ctx.font)*text.length}),fillText:(text:string,_x:number,_y:number,width:number)=>{draws.push({font:ctx.font,text,width});}};
 vi.spyOn(output,'getContext').mockReturnValue(ctx as any);
 document.documentElement.style.setProperty('--app-font','"CustomUserFont", sans-serif');
 try{
  const title='想把和你在一起的每一个可爱瞬间都收藏起来';
  for(const quality of ['preview','export'] as const)composePhoto(source,output,'polaroid',quality,{title,footer:'',font:'system'});
  expect(draws).toHaveLength(2);
  for(const draw of draws){expect(draw.text).toBe(title);expect(draw.font).toContain('CustomUserFont');expect(parseFloat(draw.font)*title.length).toBeCloseTo(draw.width);}
  expect(parseFloat(draws[1].font)/parseFloat(draws[0].font)).toBeCloseTo(2);
 }finally{document.documentElement.style.removeProperty('--app-font');}
});
it('ignores damaged lettering settings without losing other saved papers',()=>{
 localStorage.setItem(PHOTO_LETTERING_KEY,JSON.stringify({polaroid:{title:'我们的合影',footer:'',font:'system'},sticker:{title:42,font:'missing'},collage:null}));
 expect(readPhotoLettering()).toEqual({polaroid:{title:'我们的合影',footer:'',font:'system'}});
 localStorage.setItem(PHOTO_LETTERING_KEY,'broken');expect(readPhotoLettering()).toEqual({});localStorage.clear();
});
