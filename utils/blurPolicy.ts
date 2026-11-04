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

export const shouldUseReducedBlur = (options?: {
    ua?: string;
    prefersReducedTransparency?: boolean;
}): boolean => {
    if (options?.prefersReducedTransparency) return true;
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
    return shouldUseReducedBlur({ prefersReducedTransparency });
};

/**
 * 在根节点同步 `data-reduced-blur` 标记，供全局样式与组件按需收敛实时模糊与阴影滤镜。
 * 同时监听系统「减弱透明度」无障碍偏好的动态切换。
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
        const active = shouldUseReducedBlur({
            ua: win.navigator?.userAgent ?? '',
            prefersReducedTransparency: Boolean(mql?.matches),
        });
        doc.documentElement.toggleAttribute(REDUCED_BLUR_ATTR, active);
    };

    sync();

    if (!mql) return () => {};
    if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', sync);
        return () => mql.removeEventListener('change', sync);
    }
    if (typeof mql.addListener === 'function') {
        mql.addListener(sync);
        return () => mql.removeListener(sync);
    }
    return () => {};
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
        if (!mql) return;
        if (typeof mql.addEventListener === 'function') {
            mql.addEventListener('change', update);
            return () => mql.removeEventListener('change', update);
        }
        if (typeof mql.addListener === 'function') {
            mql.addListener(update);
            return () => mql.removeListener(update);
        }
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
