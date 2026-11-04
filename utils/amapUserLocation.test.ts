// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildAmapLocationUrl, parseAmapLocation, queryAmapLocation } from './amapUserLocation';
import { wgs84ToAmap } from './amapCoordinates';

const fix = { latitude: 30, longitude: 120, accuracy: 10 };
describe('AMap location adapter', () => {
    it.each([['10001', 'Key 无效'], ['10009', 'Key 类型不匹配'], ['10005', '访问限制'], ['10003', '已超限'], ['unexpected', '没有返回有效地点']])('turns error %s into safe guidance without echoing the provider response', (infocode, hint) => {
        try { parseAmapLocation({ status: '0', infocode, info: 'SECRET-KEY-AND-COORDINATES' }); }
        catch (error: any) { expect(error.message).toContain(hint); expect(error.message).not.toContain('SECRET'); return; }
        throw new Error('must reject failed geocoding');
    });
    it('converts device coordinates on the client and constructs only the fixed callback endpoint', () => {
        const [lng, lat] = wgs84ToAmap(120, 30);
        expect(lng).toBeCloseTo(120.00466044559735, 8); expect(lat).toBeCloseTo(29.997534331696095, 8);
        expect(wgs84ToAmap(103.8198, 1.3521)).toEqual([103.8198, 1.3521]);
        const url = new URL(buildAmapLocationUrl(fix, 'test-key'));
        expect(url.origin + url.pathname).toBe('https://restapi.amap.com/v3/geocode/regeo');
        expect(url.searchParams.get('location')).toBe('120.004660,29.997534');
        expect(url.searchParams.get('callback')).toBe('__sullyUserLocation');
        expect(() => buildAmapLocationUrl(fix, '<script>')).toThrow();
    });
    it('returns only useful address text and nearby POI, handles absent arrays and rejects provider failures', () => {
        const result = parseAmapLocation({ status: '1', regeocode: { formatted_address: '演示市演示路123号', pois: [{ name: '错误零距离', distance: null }, { name: '演示广场', distance: '25', location: 'secret-coordinate', tel: 'secret-phone' }, { name: '远处公园', distance: 500 }] } });
        expect(result).toBe('演示市演示路123号；附近地点：演示广场');
        expect(parseAmapLocation({ status: '1', regeocode: { addressComponent: { province: '北京市', city: [], district: '演示区', streetNumber: { street: '演示路', number: '123号' } } } })).toBe('北京市演示区演示路123号');
        expect(() => parseAmapLocation({ status: '0', info: 'INVALID_USER_KEY' })).toThrow();
        expect(() => parseAmapLocation({ status: '1', regeocode: {} })).toThrow();
    });
    it('isolates provider scripts from app storage, accepts only its own frame and token, and removes the frame on success', async () => {
        const controller = new AbortController();
        const pending = queryAmapLocation(fix, 'test-key', controller.signal);
        const frame = document.querySelector('iframe')!;
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame.hidden).toBe(true);
        expect(frame.srcdoc).toContain("connect-src 'none'");
        const token = JSON.parse(frame.srcdoc.match(/const token=("[^"]+");/)![1]);
        window.dispatchEvent(new MessageEvent('message', { source: window, data: { token, result: 'forged' } }));
        window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { token: 'wrong-token', result: 'forged' } }));
        expect(frame.isConnected).toBe(true);
        window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { token, result: { status: '1' } } }));
        await expect(pending).resolves.toEqual({ status: '1' });
        expect(frame.isConnected).toBe(false);
    });
    it('cleans up on abort or load error; cancelled calls do not create a frame', async () => {
        const controller = new AbortController();
        const pending = queryAmapLocation(fix, 'test-key', controller.signal);
        controller.abort(); await expect(pending).rejects.toThrow('取消');
        expect(document.querySelector('iframe')).toBeNull();
        await expect(queryAmapLocation(fix, 'test-key', controller.signal)).rejects.toThrow('取消');
        const next = queryAmapLocation(fix, 'test-key', new AbortController().signal);
        const frame = document.querySelector('iframe')!;
        const token = JSON.parse(frame.srcdoc.match(/const token=("[^"]+");/)![1]);
        window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { token, error: true } }));
        await expect(next).rejects.toThrow('失败');
        expect(document.querySelector('iframe')).toBeNull();
    });
});
