import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ native: vi.fn(), platform: vi.fn(), available: vi.fn(), status: vi.fn(), create: vi.fn() }));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: mocks.native, getPlatform: mocks.platform, isPluginAvailable: mocks.available },
    registerPlugin: () => ({ getStatus: mocks.status, createAlarm: mocks.create }),
}));
import { checkNativeAlarm, createNativeAlarm, isAndroidAlarm } from './nativeAlarm';

beforeEach(() => {
    vi.resetAllMocks(); mocks.native.mockReturnValue(true); mocks.platform.mockReturnValue('android'); mocks.available.mockReturnValue(true);
    mocks.status.mockResolvedValue({ available: true }); mocks.create.mockResolvedValue({ opened: true });
});
describe('native system clock handoff', () => {
    it.each(['web', 'ios'])('does not invoke an Android clock from %s', async platform => {
        mocks.platform.mockReturnValue(platform); mocks.native.mockReturnValue(platform !== 'web');
        expect(isAndroidAlarm()).toBe(false);
        await expect(createNativeAlarm('09:00', 'test')).rejects.toThrow('安卓 APK');
        expect(mocks.create).not.toHaveBeenCalled();
    });
    it('reports an old shell and missing clock without claiming that an alarm was created', async () => {
        mocks.available.mockReturnValue(false);
        await expect(checkNativeAlarm()).rejects.toThrow('更新 APK');
        expect(mocks.status).not.toHaveBeenCalled();
        mocks.available.mockReturnValue(true); mocks.status.mockResolvedValue({ available: false });
        await expect(checkNativeAlarm()).rejects.toThrow('时钟应用');
    });
    it.each(['24:00', '9:00', '12:60', '', '2026-11-27T09:00'])('rejects invalid times without contacting native code: %s', async value => {
        await expect(createNativeAlarm(value, 'test')).rejects.toThrow('有效');
        expect(mocks.create).not.toHaveBeenCalled();
    });
    it('sends only hour, minutes and title, never an invented calendar date or repeat rule', async () => {
        await createNativeAlarm('09:05', ' 买菜 ');
        expect(mocks.create).toHaveBeenCalledWith({ hour: 9, minutes: 5, message: '买菜' });
        await createNativeAlarm('00:00', '');
        expect(mocks.create).toHaveBeenLastCalledWith({ hour: 0, minutes: 0, message: '时光契约' });
    });
    it('propagates rejection and malformed handoffs, allowing a user retry', async () => {
        mocks.create.mockResolvedValue({ opened: false });
        await expect(createNativeAlarm('12:00', 'test')).rejects.toThrow('未能打开');
        mocks.create.mockRejectedValue(new Error('系统拒绝'));
        await expect(createNativeAlarm('12:00', 'test')).rejects.toThrow('系统拒绝');
    });
});
