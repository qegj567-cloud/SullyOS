import { Capacitor } from '@capacitor/core';

/**
 * 跨端取定位: 原生 (Capacitor) 优先用 @capacitor/geolocation 插件 (会弹原生权限申请),
 * 插件取坐标失败时回退到 WebView 的 navigator.geolocation; 浏览器直接走 navigator。
 *
 * 为什么这么绕:
 * - 插件的 requestPermissions 走的是标准 Android 运行时权限 (不依赖 GMS), 用它弹权限框最稳。
 * - 但官方 @capacitor/geolocation 取坐标底层用 Google Play Services 的 Fused Location Provider,
 *   设备没有 GMS (国产 ROM / 纯净系统 / 去谷歌机型) 会抛 "Google Play services unavailable"。
 *   这种情况回退到 navigator.geolocation —— 它在 Capacitor WebView 里走系统 LocationManager,
 *   不碰 GMS, 正是没谷歌的机器一直能用的那条路。
 * - 另外: 原生还需在 AndroidManifest 里声明 ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION,
 *   iOS 需在 Info.plist 加 NSLocationWhenInUseUsageDescription。
 */
export interface GeoResult { longitude: number; latitude: number; accuracy: number; }

export class DevicePositionError extends Error {
    constructor(message: string, public readonly code: number) { super(message); }
}

/** Fixed explanations only: never show the native/browser error's raw message. */
export function describeDevicePositionError(error: unknown): string {
    const code = (error as { code?: number } | undefined)?.code;
    if (code === 0) return '当前浏览器不支持设备定位，请换浏览器或在手机上使用。';
    if (code === 1) return '没有定位权限。请同时检查系统给浏览器的定位权限，以及浏览器「网站设置 → 位置信息」中糯米机的权限。桌面安装版（PWA）也要检查浏览器。';
    if (code === 2) return '设备没有取得坐标。请检查系统定位及定位精度服务；室内可到窗边重试，Wi-Fi／蓝牙扫描是可选的辅助定位。';
    if (code === 3) return '设备定位超时，还没有拿到坐标。请检查浏览器与网站定位权限、系统定位服务，并到窗边或室外重试；更换地图 Key 不能解决这一层的问题。';
    if (code === 4) return '当前页面不是安全连接，无法申请定位权限。请用 HTTPS 打开糯米机（本机 localhost 除外）。';
    if (code === 5) return '当前页面的权限策略禁止定位。请直接在浏览器打开糯米机；仍然出现时，需要检查网站部署的定位权限设置。';
    return '没有取得设备坐标，请检查定位权限和系统定位，或在手机上重试。';
}

const getPositionViaNavigator = (highAccuracy = true, timeout = 8000): Promise<GeoResult> => {
    if (globalThis.isSecureContext === false) throw new DevicePositionError('需要安全连接', 4);
    type LocationPolicy = { allowsFeature: (feature: string) => boolean };
    const page = typeof document === 'undefined' ? undefined : document as Document & { permissionsPolicy?: LocationPolicy; featurePolicy?: LocationPolicy };
    const policy = page?.permissionsPolicy || page?.featurePolicy;
    if (policy?.allowsFeature && !policy.allowsFeature('geolocation')) throw new DevicePositionError('页面禁止定位', 5);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
        throw new DevicePositionError('当前环境不支持定位, 请选城市或手输坐标', 0);
    }
    return new Promise<GeoResult>((resolve, reject) => {
        let settled = false;
        // Some browser providers fail to invoke either callback. Release the
        // app's pending request, and ignore any result arriving after this limit.
        const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); callback(); };
        const timer = setTimeout(() => finish(() => reject(new DevicePositionError('定位超时', 3))), timeout + 1000);
        try {
            navigator.geolocation.getCurrentPosition(
                pos => finish(() => {
                    const coords = pos?.coords;
                    const fix = { longitude: coords?.longitude, latitude: coords?.latitude, accuracy: coords?.accuracy ?? 99999 };
                    if (!Number.isFinite(fix.longitude) || Math.abs(fix.longitude) > 180 || !Number.isFinite(fix.latitude) || Math.abs(fix.latitude) > 90 || !Number.isFinite(fix.accuracy) || fix.accuracy < 0) reject(new DevicePositionError('设备定位无效', 2));
                    else resolve(fix);
                }),
                err => finish(() => reject(new DevicePositionError('设备定位失败', err.code))),
                { enableHighAccuracy: highAccuracy, timeout, maximumAge: 0 }
            );
        } catch (error) {
            finish(() => reject(new DevicePositionError('设备定位失败', (error as Error)?.name === 'SecurityError' ? 1 : 2)));
        }
    });
};

const getFreshBrowserPosition = async (retry: boolean): Promise<GeoResult> => {
    try { return await getPositionViaNavigator(true, retry ? 15000 : 8000); }
    catch (error) {
        if (!retry || !(error instanceof DevicePositionError) || ![2, 3].includes(error.code)) throw error;
        // Let the OS provide fresh network/standard positioning when GPS is
        // slow. This is not an app-side IP lookup and never accepts an old fix.
        return getPositionViaNavigator(false, 8000);
    }
};

export const getCurrentPositionSmart = async (options?: { quiet?: boolean; retry?: boolean }): Promise<GeoResult> => {
    // 原生: 先用插件弹权限, 取坐标失败再回退 navigator
    if (Capacitor.isNativePlatform()) {
        const { Geolocation } = await import('@capacitor/geolocation');
        try {
            const perm = await Geolocation.checkPermissions();
            if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
                const req = await Geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] as any });
                if (req.location !== 'granted' && (req as any).coarseLocation !== 'granted') {
                    throw new Error('定位权限被拒绝。请到 系统设置 → 应用 → 权限 里允许定位, 或直接选城市。');
                }
            }
        } catch (e: any) {
            // checkPermissions/requestPermissions 在个别机型会抛, 不阻塞, 直接尝试取位置
            if (!options?.quiet) console.warn('[geo] 权限检查异常, 继续尝试取位置:', e?.message || e);
        }
        try {
            const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
            return { longitude: pos.coords.longitude, latitude: pos.coords.latitude, accuracy: pos.coords.accuracy ?? 99999 };
        } catch (e: any) {
            // 没 GMS 的机器插件取坐标会抛 "Google Play services unavailable" —— 回退 WebView 定位 (走系统 LocationManager)
            if (!options?.quiet) console.warn('[geo] Capacitor 插件取位置失败, 回退 navigator.geolocation:', e?.message || e);
            return getFreshBrowserPosition(options?.retry === true);
        }
    }

    // 浏览器: navigator.geolocation
    return getFreshBrowserPosition(options?.retry === true);
};
