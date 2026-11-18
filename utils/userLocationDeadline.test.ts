import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getCurrentPositionSmart } from './geo';
import { queryAmapLocation } from './amapUserLocation';
import { refreshChatLocation, getUserLocationContext, getUserLocationPreview, invalidateUserLocationContext, saveUserLocationConfig } from './userLocation';

vi.mock('./geo', async original => ({ ...await original<typeof import('./geo')>(), getCurrentPositionSmart: vi.fn() }));
vi.mock('./amapUserLocation', async original => ({ ...await original<typeof import('./amapUserLocation')>(), queryAmapLocation: vi.fn() }));

const fix = { latitude: 30, longitude: 120, accuracy: 15 };
const config = { enabled: true, provider: 'amap' as const, amapKey: 'test-key', regions: [] };
const address = (text: string) => ({ status: '1', regeocode: { formatted_address: text } });
const fetchMock = vi.fn();
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('fetch', fetchMock);
    saveUserLocationConfig(config);
    vi.mocked(getCurrentPositionSmart).mockResolvedValue(fix);
    vi.mocked(queryAmapLocation).mockResolvedValue(address('CURRENT-ADDRESS'));
});

afterEach(async () => {
    invalidateUserLocationContext();
    await Promise.resolve();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('releases a stuck device at five seconds and never queries a map for its late fix', async () => {
    const device = deferred<typeof fix>();
    vi.mocked(getCurrentPositionSmart).mockReturnValueOnce(device.promise);
    const settled = vi.fn();
    const request = getUserLocationContext('用户').then(settled);
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await request;
    expect(settled).toHaveBeenCalledWith('');
    expect(vi.mocked(getCurrentPositionSmart).mock.calls[0][0]?.signal?.aborted).toBe(true);
    device.resolve(fix);
    await vi.advanceTimersByTimeAsync(0);
    expect(queryAmapLocation).not.toHaveBeenCalled();
    expect(await getUserLocationContext('用户')).toContain('CURRENT-ADDRESS');
    expect(getCurrentPositionSmart).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
});

it.each(['amap', 'basic', 'geoapify'] as const)('device and %s lookup share one five-second budget, even when the provider ignores abort', async provider => {
    saveUserLocationConfig({ ...config, provider, geoapifyKey: 'test-geo-key' });
    const device = deferred<typeof fix>();
    const map = deferred<any>();
    vi.mocked(getCurrentPositionSmart).mockReturnValueOnce(device.promise);
    vi.mocked(queryAmapLocation).mockReturnValueOnce(map.promise);
    fetchMock.mockReturnValueOnce(map.promise);
    const request = getUserLocationContext('用户');
    await vi.advanceTimersByTimeAsync(3000);
    device.resolve(fix);
    await vi.advanceTimersByTimeAsync(0);
    const signal = provider === 'amap' ? vi.mocked(queryAmapLocation).mock.calls[0][2] : fetchMock.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await request).toBe('');
    expect(signal.aborted).toBe(true);
    const late = provider === 'amap' ? address('LATE-ADDRESS') : new Response(JSON.stringify(provider === 'geoapify'
        ? { results: [{ city: 'LATE-ADDRESS' }] } : { lookupSource: 'coordinates', city: 'LATE-ADDRESS' }));
    map.resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockResolvedValue(new Response(JSON.stringify(provider === 'geoapify'
        ? { results: [{ city: 'CURRENT-ADDRESS' }] } : { lookupSource: 'coordinates', city: 'CURRENT-ADDRESS' })));
    expect(await getUserLocationContext('用户')).toContain('CURRENT-ADDRESS');
    expect(provider === 'amap' ? queryAmapLocation : fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
});

it('accepts an address within the budget and reuses it only after another fresh device fix', async () => {
    const map = deferred<any>();
    vi.mocked(queryAmapLocation).mockReturnValueOnce(map.promise);
    const request = getUserLocationContext('用户');
    await vi.advanceTimersByTimeAsync(4999);
    map.resolve(address('IN-TIME'));
    expect(await request).toContain('IN-TIME');
    expect(await getUserLocationContext('用户')).toContain('IN-TIME');
    expect(getCurrentPositionSmart).toHaveBeenCalledTimes(2);
    expect(queryAmapLocation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

it('concurrent conversation callers share a deadline and do not extend the first wait', async () => {
    const device = deferred<typeof fix>();
    vi.mocked(getCurrentPositionSmart).mockReturnValueOnce(device.promise);
    const first = getUserLocationContext('甲');
    await vi.advanceTimersByTimeAsync(2000);
    const second = getUserLocationContext('乙');
    expect(getCurrentPositionSmart).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await Promise.all([first, second])).toEqual(['', '']);
    expect(await getUserLocationContext('丙')).toContain('CURRENT-ADDRESS');
    device.resolve(fix);
    await vi.advanceTimersByTimeAsync(0);
    expect(queryAmapLocation).toHaveBeenCalledOnce();
});

it('a slow explicit preview neither blocks conversation nor gets cancelled by its deadline', async () => {
    const previewDevice = deferred<typeof fix>(), chatDevice = deferred<typeof fix>();
    vi.mocked(getCurrentPositionSmart).mockReturnValueOnce(previewDevice.promise).mockReturnValueOnce(chatDevice.promise);
    const preview = getUserLocationPreview('用户');
    const chat = getUserLocationContext('用户');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await chat).toBe('');
    expect(vi.mocked(getCurrentPositionSmart).mock.calls[0][0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    previewDevice.resolve(fix);
    expect((await preview).context).toContain('CURRENT-ADDRESS');
    chatDevice.resolve(fix);
    await vi.advanceTimersByTimeAsync(0);
    expect(queryAmapLocation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

it('changing privacy settings cancels old work and allows a new request immediately', async () => {
    const oldDevice = deferred<typeof fix>();
    vi.mocked(getCurrentPositionSmart).mockReturnValueOnce(oldDevice.promise);
    const old = getUserLocationContext('用户');
    saveUserLocationConfig({ ...config, regions: [{ id: 'home', name: '家', ...fix, radiusKm: 1 }] });
    expect(await old).toBe('');
    expect(await getUserLocationContext('用户')).toContain('在家附近');
    oldDevice.resolve(fix);
    await vi.advanceTimersByTimeAsync(0);
    expect(queryAmapLocation).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
});

it('leaving the foreground releases the wait and discards a late fix', async () => {
    const device = deferred<typeof fix>();
    vi.mocked(getCurrentPositionSmart).mockReturnValueOnce(device.promise);
    const request = getUserLocationContext('用户');
    (document as any).visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await request).toBe('');
    device.resolve(fix);
    await vi.advanceTimersByTimeAsync(0);
    expect(queryAmapLocation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});

it('uses a manually refreshed address once for the intended character even with caching off', async () => {
    saveUserLocationConfig({...config, cacheMinutes: 0});
    await refreshChatLocation('a');
    await getUserLocationContext('用户','b',true);
    expect(getCurrentPositionSmart).toHaveBeenCalledTimes(2);
    expect(await getUserLocationContext('用户','a',true)).toContain('CURRENT-ADDRESS');
    expect(getCurrentPositionSmart).toHaveBeenCalledTimes(2);
    await getUserLocationContext('用户','a',true);
    expect(queryAmapLocation).toHaveBeenCalledTimes(3);
});
it.each([10,30,180,360,720])('expires an unmoved address after %i minutes', async minutes => {
    saveUserLocationConfig({...config,cacheMinutes:minutes});
    await getUserLocationContext();
    await vi.advanceTimersByTimeAsync(minutes * 60000 - 1);
    await getUserLocationContext();
    expect(queryAmapLocation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await getUserLocationContext();
    expect(queryAmapLocation).toHaveBeenCalledTimes(2);
});
