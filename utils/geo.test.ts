import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { describeDevicePositionError, getCurrentPositionSmart } from './geo';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));
vi.mock('@capacitor/geolocation', () => ({ Geolocation: { checkPermissions: vi.fn(), getCurrentPosition: vi.fn() } }));
const position = vi.fn();
beforeEach(() => {
    vi.clearAllMocks(); position.mockReset(); vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: position } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('preserves browser error codes but translates them without the raw message', async () => {
    position.mockImplementationOnce((_success, failure) => failure({ code: 1, message: 'RAW-SENSITIVE-DETAIL' }));
    let failure: unknown;
    try { await getCurrentPositionSmart({ quiet: true }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 1 });
    expect(describeDevicePositionError(failure)).toContain('没有定位权限');
    expect(describeDevicePositionError(failure)).not.toContain('RAW');
});
it('reports an unsupported environment separately', async () => {
    vi.stubGlobal('navigator', {});
    await expect(getCurrentPositionSmart()).rejects.toMatchObject({ code: 0 });
});
it('retains native-to-browser fallback with quiet mode and does not log a native error', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Geolocation.checkPermissions).mockResolvedValue({ location: 'granted', coarseLocation: 'granted' });
    vi.mocked(Geolocation.getCurrentPosition).mockRejectedValue(new Error('RAW-SENSITIVE-NATIVE-ERROR'));
    position.mockImplementationOnce(success => success({ coords: { latitude: 31, longitude: 121, accuracy: 10 } }));
    const warn = vi.spyOn(console, 'warn');
    await expect(getCurrentPositionSmart({ quiet: true })).resolves.toEqual({ latitude: 31, longitude: 121, accuracy: 10 });
    expect(warn).not.toHaveBeenCalled();
});
it.each([2, 3])('retries device error %s using fresh standard positioning without accepting a cached fix', async code => {
    position.mockImplementationOnce((_success, failure) => failure({ code }));
    position.mockImplementationOnce(success => success({ coords: { latitude: 31, longitude: 121, accuracy: 100 } }));
    await expect(getCurrentPositionSmart({ quiet: true, retry: true })).resolves.toMatchObject({ accuracy: 100 });
    expect(position.mock.calls.map(call => call[2])).toEqual([
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 0 },
    ]);
});
it('does not retry a permission denial', async () => {
    position.mockImplementationOnce((_success, failure) => failure({ code: 1 }));
    await expect(getCurrentPositionSmart({ retry: true })).rejects.toMatchObject({ code: 1 });
    expect(position).toHaveBeenCalledOnce();
});
it('keeps the existing single eight-second attempt for other consumers', async () => {
    position.mockImplementationOnce((_success, failure) => failure({ code: 3 }));
    await expect(getCurrentPositionSmart()).rejects.toMatchObject({ code: 3 });
    expect(position).toHaveBeenCalledOnce();
    expect(position.mock.calls[0][2]).toEqual({ enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
});
it('releases a stuck browser request, ignores late callbacks and allows a subsequent fresh request', async () => {
    vi.useFakeTimers();
    const request = getCurrentPositionSmart({ retry: true });
    const checked = expect(request).rejects.toMatchObject({ code: 3 });
    await vi.advanceTimersByTimeAsync(16000);
    expect(position).toHaveBeenCalledTimes(2);
    position.mock.calls[0][0]({ coords: { latitude: 31, longitude: 121, accuracy: 10 } });
    await vi.advanceTimersByTimeAsync(9000);
    await checked;
    position.mock.calls[1][0]({ coords: { latitude: 31, longitude: 121, accuracy: 10 } });
    position.mockImplementationOnce(success => success({ coords: { latitude: 32, longitude: 122, accuracy: 10 } }));
    await expect(getCurrentPositionSmart({ retry: true })).resolves.toMatchObject({ latitude: 32 });
    expect(vi.getTimerCount()).toBe(0);
});
it('explains an insecure page without attempting browser positioning', async () => {
    vi.stubGlobal('isSecureContext', false);
    await expect(getCurrentPositionSmart({ retry: true })).rejects.toMatchObject({ code: 4 });
    expect(position).not.toHaveBeenCalled();
});
it('explains a denied page policy separately from site permission', async () => {
    const allowsFeature = vi.fn(() => false);
    vi.stubGlobal('document', { permissionsPolicy: { allowsFeature } });
    await expect(getCurrentPositionSmart({ retry: true })).rejects.toMatchObject({ code: 5 });
    expect(allowsFeature).toHaveBeenCalledWith('geolocation'); expect(position).not.toHaveBeenCalled();
});
it('rejects invalid coordinates without returning or logging the raw result', async () => {
    position.mockImplementationOnce(success => success({ coords: { latitude: 999, longitude: 121, accuracy: 10 } }));
    const warn = vi.spyOn(console, 'warn');
    await expect(getCurrentPositionSmart({ quiet: true })).rejects.toMatchObject({ code: 2, message: '设备定位无效' });
    expect(warn).not.toHaveBeenCalled();
});
