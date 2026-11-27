import { useEffect, useState } from 'react';
import { AppID } from '../types';

export const REDUCED_BLUR_ATTR = 'data-reduced-blur';
const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)';

/**
 * 识别基于 Gecko 渲染引擎的浏览器（如 Android / 鸿蒙容器版 Firefox、桌面版 Firefox）。
 * iOS 版 Firefox (FxiOS) 底层为 WebKit，UA 含 "like Gecko" 而非 "Gecko/<version>"，不命中此分支。
 */
export const isGeckoEngine = (ua: string): boolean =>
    /\bGecko\/\d/i.test(ua) && !/\blike Gecko\b/i.test(ua);

/**
 * 「外观 → 动画与过场 → 减弱模糊」的本机开关：值为 '1' 是开，没有这个键是关（默认）。
 * index.html 的内联脚本在首屏画出来之前按同一个键名直接读 localStorage，
 * 所以它在 userSpaces.ts 里登记为各用户空间共用的键；改键名要三处一起改。
 */
export const REDUCED_BLUR_PREF_KEY = 'sullyos_reduced_blur_v1';

// installReducedBlurPolicy 在入口最先登记，根节点标记因此先于各组件更新。
const prefListeners = new Set<() => void>();

export const getReducedBlurPreference = (): boolean => {
    try {
        return localStorage.getItem(REDUCED_BLUR_PREF_KEY) === '1';
    } catch {
        return false;
    }
};

export const setReducedBlurPreference = (enabled: boolean): void => {
    try {
        if (enabled) localStorage.setItem(REDUCED_BLUR_PREF_KEY, '1');
        else localStorage.removeItem(REDUCED_BLUR_PREF_KEY);
    } catch {
        // 存储不可写时读回来仍是关，界面保持原样。
    }
    prefListeners.forEach((notify) => notify());
};

export const shouldUseReducedBlur = (options?: {
    ua?: string;
    prefersReducedTransparency?: boolean;
    userEnabled?: boolean;
}): boolean => {
    // 三个来源只做「或」：手动开关只能把模糊关掉。它关着（默认）时，Gecko 与系统「减弱透明度」照旧自动生效；
    // 这两种情况下实时模糊要么掉帧、要么违背系统无障碍设置，所以不提供把模糊强行开回来的选项。
    if (options?.userEnabled || options?.prefersReducedTransparency) return true;
    const ua = options?.ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
    return isGeckoEngine(ua);
};

export const isReducedBlurActive = (doc?: Document): boolean => {
    const targetDoc = doc ?? (typeof document !== 'undefined' ? document : undefined);
    if (targetDoc?.documentElement?.hasAttribute(REDUCED_BLUR_ATTR)) {
        return true;
    }
    const prefersReducedTransparency =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches;
    return shouldUseReducedBlur({ prefersReducedTransparency, userEnabled: getReducedBlurPreference() });
};

/**
 * 给使用统计和答疑摘要用的三态：`自动` = 没手动打开，但浏览器或系统设置已经让减弱样式生效。
 */
export const reducedBlurSetting = (): '开' | '自动' | '关' =>
    getReducedBlurPreference() ? '开' : isReducedBlurActive() ? '自动' : '关';

/**
 * 在根节点同步 `data-reduced-blur` 标记，供全局样式与组件按需收敛实时模糊与阴影滤镜。
 * 同时监听系统「减弱透明度」无障碍偏好的动态切换，以及「减弱模糊」开关的切换。
 */
export const installReducedBlurPolicy = (
    doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
    win: Window | undefined = typeof window !== 'undefined' ? window : undefined,
): (() => void) => {
    if (!doc?.documentElement || !win) return () => {};

    const mql = typeof win.matchMedia === 'function'
        ? win.matchMedia(REDUCED_TRANSPARENCY_QUERY)
        : null;

    const sync = () => {
        // 每次同步都把开关算进去：系统偏好切回「不减弱」时，手动打开的开关仍然生效。
        const active = shouldUseReducedBlur({
            ua: win.navigator?.userAgent ?? '',
            prefersReducedTransparency: Boolean(mql?.matches),
            userEnabled: getReducedBlurPreference(),
        });
        doc.documentElement.toggleAttribute(REDUCED_BLUR_ATTR, active);
    };

    sync();
    prefListeners.add(sync);
    const offPref = () => {
        prefListeners.delete(sync);
    };

    if (!mql) return offPref;
    if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', sync);
        return () => {
            offPref();
            mql.removeEventListener('change', sync);
        };
    }
    if (typeof mql.addListener === 'function') {
        mql.addListener(sync);
        return () => {
            offPref();
            mql.removeListener(sync);
        };
    }
    return offPref;
};

export const useReducedBlur = (): boolean => {
    const [reduced, setReduced] = useState<boolean>(() => isReducedBlurActive());

    useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        const mql = typeof window.matchMedia === 'function'
            ? window.matchMedia(REDUCED_TRANSPARENCY_QUERY)
            : null;
        const update = () => setReduced(isReducedBlurActive());
        update();
        prefListeners.add(update);
        const offPref = () => {
            prefListeners.delete(update);
        };
        if (!mql) return offPref;
        if (typeof mql.addEventListener === 'function') {
            mql.addEventListener('change', update);
            return () => {
                offPref();
                mql.removeEventListener('change', update);
            };
        }
        if (typeof mql.addListener === 'function') {
            mql.addListener(update);
            return () => {
                offPref();
                mql.removeListener(update);
            };
        }
        return offPref;
    }, []);

    return reduced;
};

const parseHexLuminance = (color: string): number | null => {
    const hex = color.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
    if (!hex) return null;
    const full = hex.length === 3
        ? hex.split('').map((c) => c + c).join('')
        : hex;
    const r = parseInt(full.slice(0, 2), 16) / 255;
    const g = parseInt(full.slice(2, 4), 16) / 255;
    const b = parseInt(full.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/**
 * 无实时毛玻璃时的桌面卡片底色：根据桌面前景色明暗选择深色烟熏半透或浅色磨砂半透，保证文字可读。
 */
export const resolveReducedGlassCardStyle = (contentColor = '#ffffff') => {
    const luminance = parseHexLuminance(contentColor);
    const isDarkText = luminance !== null && luminance < 0.45;
    return isDarkText
        ? {
              background: 'rgba(255, 255, 255, 0.78)',
              border: '1px solid rgba(255, 255, 255, 0.62)',
              boxShadow: '0 8px 24px rgba(15, 23, 42, 0.10)',
          }
        : {
              background: 'rgba(24, 28, 40, 0.56)',
              border: '1px solid rgba(255, 255, 255, 0.22)',
              boxShadow: '0 8px 28px rgba(0, 0, 0, 0.22)',
          };
};

/**
 * 根节点始终 100% 不透明铺满全屏的 App 名单。
 * 入场淡入动画完成后，外壳底层壁纸虚化层可安全隐藏，避免在不可见的底层保留全屏模糊纹理。
 * （依赖外壳壁纸透出的 MemoryPalace / QQBridge / Character 详情页 / ThemeMaker / Music 等不在此集合中。）
 */
const OPAQUE_FULLSCREEN_APPS: ReadonlySet<AppID> = new Set<AppID>([
    AppID.Settings,
    AppID.Appearance,
    AppID.Gallery,
    AppID.User,
    AppID.Schedule,
    AppID.Room,
    AppID.CheckPhone,
    AppID.FriendFeed,
    AppID.Social,
    AppID.Study,
    AppID.FAQ,
    AppID.Worldbook,
    AppID.Bank,
    AppID.XhsStock,
    AppID.XhsFreeRoam,
    AppID.Browser,
    AppID.Call,
    AppID.VoiceDesigner,
    AppID.Guidebook,
    AppID.Handbook,
    AppID.HotNews,
    AppID.SpecialMoments,
    AppID.VRWorld,
    AppID.WorldHome,
    AppID.CharCreatorDev,
]);

export const canHideShellBackdropWhenSettled = (
    activeApp: AppID,
    options?: {
        hasCustomChatChromeCss?: boolean;
        iosStandalone?: boolean;
    },
): boolean => {
    if (options?.iosStandalone) return false;
    if (activeApp === AppID.Chat || activeApp === AppID.GroupChat) {
        return !options?.hasCustomChatChromeCss;
    }
    return OPAQUE_FULLSCREEN_APPS.has(activeApp);
};

export const updateVirtualTimeIfChanged = <
    T extends { hours: number; minutes: number; day: string },
>(
    prev: T,
    next: T,
): T => (prev.hours === next.hours && prev.minutes === next.minutes && prev.day === next.day ? prev : next);
