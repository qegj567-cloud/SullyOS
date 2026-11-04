import {expect,it,vi} from 'vitest';
import {cameraZoomRange,applyCameraZoom} from './cameraZoom';
it('uses hardware capabilities and resets an accidentally zoomed sensor to 1x',async()=>{
 const track={getCapabilities:()=>({zoom:{min:.5,max:5,step:.1}}),applyConstraints:vi.fn().mockResolvedValue(undefined)} as unknown as MediaStreamTrack;
 expect(cameraZoomRange(track)).toEqual({min:.5,max:5,step:.1,value:1,hardware:true});
 await applyCameraZoom(track,1);expect(track.applyConstraints).toHaveBeenCalledWith({advanced:[{zoom:1}]});
});
it('offers digital zoom when hardware zoom is unavailable or fixed',()=>{
 expect(cameraZoomRange({} as MediaStreamTrack).hardware).toBe(false);
 expect(cameraZoomRange({getCapabilities:()=>({zoom:{min:1,max:1}})} as unknown as MediaStreamTrack).hardware).toBe(false);
});
it('keeps portrait resolution and the chosen lens when changing hardware zoom',async()=>{
 const existing={width:{ideal:1080},height:{ideal:1440},facingMode:{ideal:'environment'},deviceId:{exact:'main'}};
 const track={getConstraints:()=>existing,applyConstraints:vi.fn().mockResolvedValue(undefined)} as unknown as MediaStreamTrack;
 await applyCameraZoom(track,2);expect(track.applyConstraints).toHaveBeenCalledWith({...existing,advanced:[{zoom:2}]});
});
