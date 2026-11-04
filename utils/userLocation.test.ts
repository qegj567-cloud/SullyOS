import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentPositionSmart } from './geo';
import { queryAmapLocation } from './amapUserLocation';
import { getBackgroundUserLocationContext, getUserLocationContext, getUserLocationPreview, refreshUserLocation, saveUserLocationConfig } from './userLocation';
import { AmapLocationError } from './amapUserLocation';
import {
    isUserLocationLookupUrl, locationDistanceMeters, matchUserPrivacyRegion, userLocationPlaceName,
    validateUserLocationConfig, USER_LOCATION_STORAGE_KEY, type UserLocationConfig,
} from './userLocationPrivacy';

vi.mock('./geo', async original => ({ ...await original<typeof import('./geo')>(), getCurrentPositionSmart: vi.fn() }));
vi.mock('./amapUserLocation', async original => ({ ...await original<any>(), queryAmapLocation: vi.fn() }));
const region = { id: 'home', name: '家', latitude: 31.2304, longitude: 121.4737, radiusKm: 3 };
const fix = { latitude: region.latitude, longitude: region.longitude, accuracy: 10 };
const outside = { latitude: 30, longitude: 120, accuracy: 15 };
const config: UserLocationConfig = { enabled: true, regions: [region] };
const place = { lookupSource: 'coordinates', latitude: outside.latitude, longitude: outside.longitude,
    countryName: '中国', principalSubdivision: '浙江省', city: '演示市', locality: '演示镇', postcode: 'PRIVATE-POSTCODE', plusCode: 'PRIVATE-PLUS-CODE' };
const fetchMock = vi.fn();
const response = () => new Response(JSON.stringify(place), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
    saveUserLocationConfig(config);
    vi.mocked(getCurrentPositionSmart).mockResolvedValue(fix);
    fetchMock.mockReset().mockResolvedValue(response());
});
afterEach(() => vi.unstubAllGlobals());

describe('private region matching', () => {
    it('matches inside, protects uncertain edges, and uses first circle when overlapping', () => {
        expect(locationDistanceMeters(region, region)).toBe(0);
        expect(matchUserPrivacyRegion(fix, [region])).toEqual({ region, uncertain: false });
        const edge = { ...fix, latitude: region.latitude + 3.1 / 111.195, accuracy: 200 };
        expect(matchUserPrivacyRegion(edge, [region])).toEqual({ region, uncertain: true });
        expect(matchUserPrivacyRegion({ ...edge, accuracy: 1 }, [region])).toBeUndefined();
        expect(matchUserPrivacyRegion(fix, [region, { ...region, name: '公司' }])?.region.name).toBe('家');
    });
    it('fails closed for invalid regions and strips sensitive response fields', () => {
        expect(() => validateUserLocationConfig({ ...config, regions: [{ ...region, radiusKm: NaN }] })).toThrow();
        expect(() => validateUserLocationConfig({ ...config, regions: [{ ...region, latitude: 100 }] })).toThrow();
        expect(() => validateUserLocationConfig({ ...config, regions: [region, region] })).toThrow();
        const label = userLocationPlaceName(place);
        expect(label).toBe('中国 · 浙江省 · 演示市 · 演示镇');
        expect(label).not.toContain('PRIVATE');
        expect(() => userLocationPlaceName({ ...place, lookupSource: 'ipGeolocation' })).toThrow();
        expect(isUserLocationLookupUrl('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=1')).toBe(true);
        expect(isUserLocationLookupUrl('https://api.bigdatacloud.net.evil.invalid/data/reverse-geocode-client')).toBe(false);
    });
});

describe('device location privacy boundary', () => {
    it.each(['key', 'quota', 'network', 'empty'] as const)('keeps the selected AMap API after a %s failure and exposes its reason', async reason => {
        saveUserLocationConfig({ ...config, provider: 'amap', amapKey: 'test-amap-key' });
        vi.mocked(getCurrentPositionSmart).mockResolvedValue(outside);
        const failure = new AmapLocationError(reason);
        vi.mocked(queryAmapLocation).mockRejectedValueOnce(failure);
        const preview = await getUserLocationPreview('小雨');
        expect(preview.failureHint).toBe(failure.message);
        expect(preview.context).toContain('定位未知');
        expect(queryAmapLocation).toHaveBeenCalledOnce();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem(USER_LOCATION_STORAGE_KEY)!)).toMatchObject({ provider: 'amap' });
    });
    it.each([401, 429, 503, 200])('keeps Geoapify selected when its API rejects or returns no address (HTTP %s)', async status => {
        saveUserLocationConfig({ ...config, provider: 'geoapify', geoapifyKey: 'test-geo-key' });
        vi.mocked(getCurrentPositionSmart).mockResolvedValue(outside);
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status }));
        const preview = await getUserLocationPreview('小雨');
        expect(preview.failureHint).toContain('Geoapify');
        expect(preview.context).toContain('定位未知'); expect(preview.attribution).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledOnce(); expect(new URL(fetchMock.mock.calls[0][0]).hostname).toBe('api.geoapify.com');
        expect(queryAmapLocation).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem(USER_LOCATION_STORAGE_KEY)!)).toMatchObject({ provider: 'geoapify' });
    });
    it('does not hide a current AMap API failure with a previously successful address', async () => {
        saveUserLocationConfig({ ...config, provider: 'amap', amapKey: 'test-amap-key' });
        vi.mocked(getCurrentPositionSmart).mockResolvedValue(outside);
        vi.mocked(queryAmapLocation).mockResolvedValueOnce({ status: '1', regeocode: { formatted_address: 'PREVIOUS-ADDRESS' } });
        expect((await getUserLocationPreview('小雨')).context).toContain('PREVIOUS-ADDRESS');
        vi.mocked(getCurrentPositionSmart).mockResolvedValueOnce({ ...outside, latitude: outside.latitude + 0.01 });
        vi.mocked(queryAmapLocation).mockRejectedValueOnce(new AmapLocationError('network'));
        const failed = await getUserLocationPreview('小雨');
        expect(failed.failureHint).toContain('高德地点查询失败');
        expect(failed.context).toContain('定位未知'); expect(failed.context).not.toContain('PREVIOUS-ADDRESS');
        expect(queryAmapLocation).toHaveBeenCalledTimes(2); expect(fetchMock).not.toHaveBeenCalled();
    });
    it('Geoapify makes zero requests inside hidden regions, including uncertain boundary fixes', async () => {
        saveUserLocationConfig({...config,provider:'geoapify',geoapifyKey:'test-geo-key'});
        expect(await getUserLocationContext('小雨')).toContain('在家附近');
        vi.mocked(getCurrentPositionSmart).mockResolvedValueOnce({...fix,latitude:region.latitude+3.1/111.195,accuracy:200});
        expect(await getUserLocationContext('小雨')).toContain('可能在家附近');
        expect(fetchMock).not.toHaveBeenCalled();expect(queryAmapLocation).not.toHaveBeenCalled();
    });
    it('Geoapify delivers overseas street words with attribution, not coordinates, Key, postcode or raw diagnostics',async()=>{
        saveUserLocationConfig({...config,provider:'geoapify',geoapifyKey:'test-geo-key'});
        vi.mocked(getCurrentPositionSmart).mockResolvedValue({...outside,latitude:51.5,longitude:-.1});
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({results:[{country:'United Kingdom',city:'London',street:'Oxford Street',lat:51.5,lon:-.1,postcode:'SECRET-POSTCODE',datasource:{raw:{phone:'SECRET-PHONE'}}}]})));
        const preview=await getUserLocationPreview('小雨');expect(preview.context).toContain('Oxford Street');expect(preview.attribution).toBe('geoapify');expect(preview.context).toContain('Geoapify / OpenStreetMap');
        expect(preview.context).not.toMatch(/51\.5|test-geo-key|SECRET/);expect(queryAmapLocation).not.toHaveBeenCalled();
        saveUserLocationConfig({...config,provider:'geoapify',geoapifyKey:'test-geo-key'});
        fetchMock.mockResolvedValueOnce(new Response('SECRET',{status:403}));
        const failed=await getUserLocationPreview('小雨');expect(failed.context).toContain('定位未知');expect(failed.failureHint).toContain('Key');expect(failed.failureHint).not.toContain('SECRET');expect(failed.attribution).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);expect(new URL(fetchMock.mock.calls[1][0]).hostname).toBe('api.geoapify.com');
    });
    it('does not reuse cached regions after switching to Geoapify, and rechecks privacy before reusing overseas addresses',async()=>{
        vi.mocked(getCurrentPositionSmart).mockResolvedValue(outside);await getUserLocationContext('小雨');
        saveUserLocationConfig({...config,provider:'geoapify',geoapifyKey:'test-geo-key'});
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({results:[{country:'日本',city:'東京都',street:'神宮前'}]})));
        expect(await getUserLocationContext('小雨')).toContain('神宮前');expect(fetchMock).toHaveBeenCalledTimes(2);
        vi.mocked(getCurrentPositionSmart).mockResolvedValueOnce(fix);const hidden=await getUserLocationContext('小雨');expect(hidden).toContain('在家附近');expect(hidden).not.toContain('神宮前');expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('aborts and discards a pending Geoapify response when a new hidden region covers the device',async()=>{
        saveUserLocationConfig({...config,provider:'geoapify',geoapifyKey:'test-geo-key'});vi.mocked(getCurrentPositionSmart).mockResolvedValue(outside);
        let resolve!:(response:Response)=>void;fetchMock.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
        const request=getUserLocationContext('小雨');await vi.waitFor(()=>expect(fetchMock).toHaveBeenCalledOnce());
        saveUserLocationConfig({...config,provider:'geoapify',geoapifyKey:'test-geo-key',regions:[{...region,...outside}]});expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        resolve(new Response(JSON.stringify({results:[{city:'SHOULD-NOT-APPEAR'}]})));expect(await request).toBe('');
    });
    it.each([[1, '没有定位权限'], [2, '设备没有取得坐标'], [3, '设备定位超时']])('explains device failure %s without querying a provider or sending diagnostics to the role', async (code, hint) => {
        vi.mocked(getCurrentPositionSmart).mockRejectedValueOnce(Object.assign(new Error('SECRET-COORDINATES-AND-KEY'), { code }));
        const preview = await getUserLocationPreview('小雨');
        expect(preview.failureHint).toContain(hint);
        expect(preview.failureHint).toContain('还没有查询地图');
        expect(preview.failureHint).not.toContain('SECRET');
        expect(preview.context).toContain('定位未知');
        expect(preview.context).not.toContain(hint); expect(preview.context).not.toContain('SECRET');
        expect(getCurrentPositionSmart).toHaveBeenCalledWith({ quiet: true, retry: true });
        expect(fetchMock).not.toHaveBeenCalled(); expect(queryAmapLocation).not.toHaveBeenCalled();
    });
    it('shows AMap platform errors only in preview, and never switches provider after a rejection', async () => {
        saveUserLocationConfig({ ...config, provider: 'amap', amapKey: 'test-amap-key' });
        vi.mocked(getCurrentPositionSmart).mockResolvedValue(outside);
        vi.mocked(queryAmapLocation).mockRejectedValueOnce(new AmapLocationError('platform'));
        const preview = await getUserLocationPreview('小雨');
        expect(preview.failureHint).toContain('Key 类型不匹配');
        expect(preview.context).toContain('定位未知'); expect(preview.context).not.toContain('Key');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('default-off and background do not request location or a map', async () => {
        localStorage.removeItem(USER_LOCATION_STORAGE_KEY);
        expect(await getUserLocationContext('小雨')).toBe('');
        saveUserLocationConfig(config);
        (document as any).visibilityState = 'hidden';
        expect(await getUserLocationContext('小雨')).toBe('');
        expect(getCurrentPositionSmart).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('inside a private circle sends no coordinates anywhere and renders only the named range', async () => {
        const context = await getUserLocationContext('小雨');
        expect(context).toContain('小雨现在的定位在家附近');
        expect(context).not.toContain('3 公里');
        expect(context).not.toContain(String(fix.latitude));
        expect(context).not.toContain(String(fix.longitude));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(localStorage.getItem('os_realtime_config')).toBeNull();
    });
    it('ambiguous boundary and poor accuracy do not query a real place', async () => {
        vi.mocked(getCurrentPositionSmart).mockResolvedValueOnce({ ...fix, latitude: region.latitude + 3.1 / 111.195, accuracy: 200 });
        expect(await getUserLocationContext('小雨')).toContain('可能在家附近');
        vi.mocked(getCurrentPositionSmart).mockResolvedValueOnce({ ...outside, accuracy: 2000 });
        const preview = await getUserLocationPreview('小雨');
        expect(preview.context).toContain('定位未知');
        expect(preview.failureHint).toContain('精度不足');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('queries only the fixed direct endpoint, exposes only allowed place text, and never persists the current fix', async () => {
        vi.mocked(getCurrentPositionSmart).mockResolvedValue(outside);
        const context = await getUserLocationContext('小雨');
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=30&longitude=120&localityLanguage=zh');
        expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
        expect(context).toContain('演示镇');
        expect(context).not.toContain('latitude');
        expect(context).not.toContain('PRIVATE');
        expect(JSON.parse(localStorage.getItem(USER_LOCATION_STORAGE_KEY)!)).toEqual(config);
        expect(localStorage.getItem('os_realtime_config')).toBeNull();
    });
    it('rechecks private circles on each fresh fix, even after a successful outside lookup was cached', async () => {
        vi.mocked(getCurrentPositionSmart).mockResolvedValueOnce(outside).mockResolvedValueOnce(fix);
        expect(await getUserLocationContext('小雨')).toContain('演示镇');
        expect(await getUserLocationContext('小雨')).toContain('定位在家附近');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getCurrentPositionSmart).toHaveBeenCalledTimes(2);
    });
    it('keeps permission/lookup failures unknown instead of falling back to IP, cached address or logging raw errors', async () => {
        const log = vi.spyOn(console, 'error');
        vi.mocked(getCurrentPositionSmart).mockResolvedValueOnce(outside).mockRejectedValueOnce(new Error('denied 31.2304 121.4737'));
        expect(await getUserLocationContext('小雨')).toContain('演示镇');
        const context = await getUserLocationContext('小雨');
        expect(context).toContain('定位未知');
        expect(context).not.toContain('演示镇');
        expect(context).not.toContain('31.2304');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(log).not.toHaveBeenCalled(); log.mockRestore();
    });
    it('corrupt protection settings prevent GPS and external queries', async () => {
        localStorage.setItem(USER_LOCATION_STORAGE_KEY, '{broken');
        const preview = await getUserLocationPreview('小雨');
        expect(preview.context).toContain('定位未知');
        expect(preview.failureHint).toContain('配置不可读取');
        expect(getCurrentPositionSmart).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('suppresses pending results when switched off before the device fix arrives', async () => {
        let release!: (fix: typeof outside) => void;
        vi.mocked(getCurrentPositionSmart).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const request = getUserLocationContext('小雨');
        saveUserLocationConfig({ ...config, enabled: false });
        release(outside);
        expect(await request).toBe('');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('does not release an outside lookup result after a new private circle covers it', async () => {
        vi.mocked(getCurrentPositionSmart).mockResolvedValueOnce(outside);
        let release!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const request = getUserLocationContext('小雨');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        saveUserLocationConfig({ enabled: true, regions: [{ ...region, ...outside, id: 'new-home' }] });
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        release(response());
        expect(await request).toBe('');
    });
    it('concurrent preparations share one request, then obtain a fresh fix on the next request', async () => {
        vi.mocked(getCurrentPositionSmart).mockResolvedValue(outside);
        const [a, b] = await Promise.all([refreshUserLocation(), refreshUserLocation()]);
        expect(a).toEqual(b); expect(fetchMock).toHaveBeenCalledTimes(1);
        await refreshUserLocation();
        expect(getCurrentPositionSmart).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AMap also skips every map request at home and does not disclose radius or Key', async () => {
        saveUserLocationConfig({ ...config, provider: 'amap', amapKey: 'test-amap-key' });
        const context = await getUserLocationContext('小雨');
        expect(context).toContain('小雨现在的定位在家附近');
        expect(context).not.toContain('3 公里'); expect(context).not.toContain('test-amap-key');
        expect(queryAmapLocation).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
    });
    it('AMap returns street/nearby place text without raw coordinates, contact fields, Key or another provider fallback', async () => {
        saveUserLocationConfig({ ...config, provider: 'amap', amapKey: 'test-amap-key' });
        vi.mocked(getCurrentPositionSmart).mockResolvedValue(outside);
        vi.mocked(queryAmapLocation).mockResolvedValueOnce({ status: '1', regeocode: { formatted_address: '演示市演示路123号', pois: [{ name: '演示广场', distance: '20', location: '120,30', tel: 'SECRET-PHONE' }] } });
        const context = await getUserLocationContext('小雨');
        expect(context).toContain('演示路123号'); expect(context).toContain('附近地点：演示广场');
        expect(context).not.toContain('test-amap-key'); expect(context).not.toContain('120,30'); expect(context).not.toContain('SECRET-PHONE');
        expect(fetchMock).not.toHaveBeenCalled();
        saveUserLocationConfig({ ...config, provider: 'amap', amapKey: 'test-amap-key' });
        vi.mocked(queryAmapLocation).mockRejectedValueOnce(new Error('CORS key=test-amap-key&location=120,30'));
        const failed = await getUserLocationContext('小雨');
        expect(failed).toContain('定位未知'); expect(failed).not.toContain('test-amap-key');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

it('requires a selected recipient and refuses malformed scopes without looking up location',async()=>{
    saveUserLocationConfig({...config,characterIds:[]});
    expect(await getUserLocationContext('小雨','a')).toBe('');expect(await getUserLocationContext('小雨')).toBe('');
    expect(getBackgroundUserLocationContext('小雨','a')).toBe('');
    expect(getCurrentPositionSmart).not.toHaveBeenCalled();
    expect(()=>validateUserLocationConfig({...config,characterIds:null})).toThrow();
    saveUserLocationConfig({...config,characterIds:['a']});
    expect(getBackgroundUserLocationContext('小雨','a')).toContain('未知');expect(getBackgroundUserLocationContext('小雨','b')).toBe('');
});
it('rechecks audience while a device lookup is in flight',async()=>{
    saveUserLocationConfig({...config,characterIds:['a']});
    let resolve!:(value:any)=>void;
    vi.mocked(getCurrentPositionSmart).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const request=getUserLocationContext('小雨','a');
    saveUserLocationConfig({...config,characterIds:[]});resolve(fix);
    expect(await request).toBe('');expect(fetchMock).not.toHaveBeenCalled();
});
