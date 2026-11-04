// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {readBeautyCatalogCover,encodeBeautyCatalogCover} from './beautyCatalogCover';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const encoded='data:image/png;base64,iVBORw0KGgo=';
function mocks(){
 const NativeURL=URL;vi.stubGlobal('URL',class extends NativeURL{static createObjectURL=vi.fn(()=> 'blob:local-cover');static revokeObjectURL=vi.fn();});
 Object.defineProperty(HTMLImageElement.prototype,'decode',{configurable:true,value:vi.fn().mockResolvedValue(undefined)});
 vi.spyOn(HTMLImageElement.prototype,'naturalWidth','get').mockReturnValue(1080);
 vi.spyOn(HTMLImageElement.prototype,'naturalHeight','get').mockReturnValue(2400);
 const draw=vi.fn();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw} as any);
 vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue(encoded);
 return draw;
}
it('reads local screenshots without remote requests, fits the whole frame and releases the URL',async()=>{
 const draw=mocks();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 expect(await readBeautyCatalogCover(new File(['image'],'cover.jpg',{type:'image/jpeg'}))).toBe(encoded);
 expect(draw).toHaveBeenCalledWith(expect.any(HTMLImageElement),0,0,270,600);
 expect(fetch).not.toHaveBeenCalled();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-cover');
});
it('rejects scripts and oversized screenshots before decoding',async()=>{
 mocks();await expect(readBeautyCatalogCover(new File(['<svg/>'],'cover.svg',{type:'image/svg+xml'}))).rejects.toThrow('PNG');
 const big=new File(['x'],'cover.png',{type:'image/png'});Object.defineProperty(big,'size',{value:11*1024*1024});
 await expect(readBeautyCatalogCover(big)).rejects.toThrow('10 MB');expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('releases a corrupt file and rejects excessive decoded dimensions',async()=>{
 mocks();const file=new File(['x'],'cover.png',{type:'image/png'});
 vi.mocked(HTMLImageElement.prototype.decode).mockRejectedValueOnce(Error('bad image'));
 await expect(readBeautyCatalogCover(file)).rejects.toThrow();expect(URL.revokeObjectURL).toHaveBeenCalled();
 vi.spyOn(HTMLImageElement.prototype,'naturalWidth','get').mockReturnValue(20000);
 await expect(readBeautyCatalogCover(file)).rejects.toThrow('尺寸过大');
});
it('normalizes generated covers with the same bounded encoder and keeps server validation',()=>{
 mocks();expect(encodeBeautyCatalogCover(document.createElement('canvas'),360,600)).toBe(encoded);
 vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue('data:text/html;base64,eA==');
 expect(()=>encodeBeautyCatalogCover(document.createElement('canvas'),360,600)).toThrow();
});
