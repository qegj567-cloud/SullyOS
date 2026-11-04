import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ native:vi.fn(), platform:vi.fn(), available:vi.fn(), get:vi.fn(), set:vi.fn() }));
vi.mock('@capacitor/core', () => ({
    Capacitor:{isNativePlatform:mocks.native,getPlatform:mocks.platform,isPluginAvailable:mocks.available},
    registerPlugin:()=>({getIcon:mocks.get,setIcon:mocks.set}),
}));
import { getNativeAppIcon, setNativeAppIcon, isAndroidAppIcon } from './nativeAppIcon';
beforeEach(() => {
    vi.resetAllMocks(); mocks.native.mockReturnValue(true); mocks.platform.mockReturnValue('android'); mocks.available.mockReturnValue(true);
    mocks.get.mockResolvedValue({icon:'jellyfish'}); mocks.set.mockResolvedValue({icon:'classic'});
});
describe('native launcher icon bridge', () => {
    it('does not call native APIs from a browser', async () => {
        mocks.native.mockReturnValue(false); expect(isAndroidAppIcon()).toBe(false);
        await expect(getNativeAppIcon()).rejects.toThrow('更新 APK'); expect(mocks.get).not.toHaveBeenCalled();
    });
    it('does not enable Android UI on iOS', () => { mocks.platform.mockReturnValue('ios'); expect(isAndroidAppIcon()).toBe(false); });
    it('reports an older APK without the plugin instead of pretending success', async () => {
        mocks.available.mockReturnValue(false); await expect(setNativeAppIcon('classic')).rejects.toThrow('更新 APK'); expect(mocks.set).not.toHaveBeenCalled();
    });
    it('reads actual native selection and switches the requested builtin', async () => {
        expect(await getNativeAppIcon()).toEqual({icon:'jellyfish'});
        expect(await setNativeAppIcon('classic')).toEqual({icon:'classic'}); expect(mocks.set).toHaveBeenCalledWith({icon:'classic'});
    });
    it('rejects arbitrary component or image values', async () => {
        await expect(setNativeAppIcon('MainActivity' as any)).rejects.toThrow('只支持'); expect(mocks.set).not.toHaveBeenCalled();
    });
    it('does not claim success on inconsistent or malformed state', async () => {
        mocks.set.mockResolvedValue({icon:'jellyfish'}); await expect(setNativeAppIcon('classic')).rejects.toThrow('未完成');
        mocks.get.mockResolvedValue({icon:'other'}); await expect(getNativeAppIcon()).rejects.toThrow('无法确认');
    });
    it('allows unknown selection to be repaired and propagates native failure', async () => {
        mocks.get.mockResolvedValue({icon:null}); expect(await getNativeAppIcon()).toEqual({icon:null});
        mocks.set.mockRejectedValue(new Error('系统拒绝')); await expect(setNativeAppIcon('classic')).rejects.toThrow('系统拒绝');
    });
});
