import {afterEach,expect,it,vi} from 'vitest';
import {buildGeoapifyLocationUrl,GeoapifyLocationError,parseGeoapifyLocation,queryGeoapifyLocation} from './geoapifyUserLocation';
import {isUserLocationLookupUrl,validateUserLocationConfig} from './userLocationPrivacy';
const fix={latitude:51.5,longitude:-.1,accuracy:12},key='sample-key';
afterEach(()=>vi.unstubAllGlobals());
it('builds only the direct WGS84 endpoint and exempts sensitive URLs from diagnostic capture',()=>{
 const url=new URL(buildGeoapifyLocationUrl(fix,key));
 expect(url.origin+url.pathname).toBe('https://api.geoapify.com/v1/geocode/reverse');
 expect(url.searchParams.get('lat')).toBe('51.5');expect(url.searchParams.get('lon')).toBe('-0.1');
 expect(url.searchParams.get('apiKey')).toBe(key);expect(url.searchParams.get('format')).toBe('json');
 expect(isUserLocationLookupUrl(url.href)).toBe(true);
 expect(isUserLocationLookupUrl('https://api.geoapify.com.evil.invalid/v1/geocode/reverse')).toBe(false);
 expect(isUserLocationLookupUrl('https://api.geoapify.com/v1/geocode/search')).toBe(false);
});
it('returns address words in different countries and never forwards raw fields',()=>{
 const result=parseGeoapifyLocation({results:[{country:'United Kingdom',state:'England',city:'London',street:'Oxford Street',housenumber:'12',name:'Library',lat:51.5,lon:-.1,postcode:'SECRET-POSTCODE',formatted:'SECRET-FULL-RESPONSE',place_id:'SECRET-ID',plus_code:'SECRET-CODE',datasource:{raw:{phone:'SECRET-PHONE'}}}]});
 expect(result).toBe('United Kingdom · England · London · Oxford Street · 12 · Library');expect(result).not.toContain('SECRET');expect(result).not.toContain('51.5');
 expect(parseGeoapifyLocation({results:[{country:'日本',state:'東京都',city:'渋谷区',street:'神宮前'}]})).toBe('日本 · 東京都 · 渋谷区 · 神宮前');
 expect(()=>parseGeoapifyLocation({results:[]})).toThrow(GeoapifyLocationError);
 expect(()=>parseGeoapifyLocation({results:[{lat:51.5,lon:-.1}]})).toThrow(GeoapifyLocationError);
});
it('requires a Key when enabled and preserves old configurations',()=>{
 expect(validateUserLocationConfig({enabled:false,regions:[]})).toEqual({enabled:false,regions:[]});
 expect(()=>validateUserLocationConfig({enabled:true,regions:[],provider:'geoapify'})).toThrow('填写 Geoapify Key');
 expect(validateUserLocationConfig({enabled:true,regions:[],provider:'geoapify',geoapifyKey:'  '+key+'  '})).toEqual({enabled:true,regions:[],provider:'geoapify',geoapifyKey:key});
 expect(()=>validateUserLocationConfig({enabled:false,regions:[],provider:'geoapify',geoapifyKey:'https://example.com?key=x'})).toThrow('只粘贴 Key');
});
it('uses a cancellable request without cookies, caching or a proxy',async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({results:[{city:'London'}]})));vi.stubGlobal('fetch',fetch);
 const controller=new AbortController();await queryGeoapifyLocation(fix,key,controller.signal);
 expect(fetch).toHaveBeenCalledWith(buildGeoapifyLocationUrl(fix,key),{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'});
 controller.abort();await expect(queryGeoapifyLocation(fix,key,controller.signal)).rejects.toThrow(GeoapifyLocationError);expect(fetch).toHaveBeenCalledOnce();
});
it.each([[401,'key'],[403,'key'],[429,'quota'],[500,'response']])('sanitizes provider failure %s without reading its raw diagnostics',async(status,kind)=>{
 const response=new Response(JSON.stringify({message:'SECRET:51.5,-.1 API-key'}),{status:status as number});
 const json=vi.spyOn(response,'json');vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response));
 await expect(queryGeoapifyLocation(fix,key,new AbortController().signal)).rejects.toMatchObject({kind});expect(json).not.toHaveBeenCalled();
});
it('sanitizes network and malformed-response failures',async()=>{
 const fetch=vi.fn().mockRejectedValueOnce(new Error('SECRET LAT LON KEY')).mockResolvedValueOnce(new Response('broken'));
 vi.stubGlobal('fetch',fetch);
 await expect(queryGeoapifyLocation(fix,key,new AbortController().signal)).rejects.toThrow('Geoapify 地点查询失败');
 await expect(queryGeoapifyLocation(fix,key,new AbortController().signal)).rejects.toThrow('Geoapify 地点查询失败');
});
