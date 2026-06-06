let hasInstalledIOSStandaloneWorkaround = false;
let stableStandaloneHeight = 0;
// 安全区只在旋转 / 窗口尺寸变化时才变，缓存探测结果，避免 visualViewport 滚动、聚焦时反复同步重排。
// 上下各自独立缓存：某边读到非 0 才锁定；iOS 启动早期某边可能瞬时为 0，此时该边不锁、下次继续探测，
// 避免「一边真值、一边瞬时 0」被整体锁死（否则 home 条避让会失效，直到旋转/尺寸变化才恢复）。
let cachedTopInset: number | null = null;
let cachedBottomInset: number | null = null;

// 用一个隐藏探针同时读取上下安全区：单次插入 + 单次 getComputedStyle（一次 reflow）。
// env() 在本项目 iOS 全屏 PWA 下偶发返回 0，故需 JS 探测兜底。
const readSafeAreaInsets = (): { top: number; bottom: number } => {
    if (typeof document === 'undefined' || !document.body) {
        return { top: cachedTopInset ?? 0, bottom: cachedBottomInset ?? 0 };
    }
    // 两边都已锁定有效值，直接用缓存，不再插探针重排。
    if (cachedTopInset !== null && cachedBottomInset !== null) {
        return { top: cachedTopInset, bottom: cachedBottomInset };
    }

    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.opacity = '0';
    probe.style.paddingTop = 'env(safe-area-inset-top)';
    probe.style.paddingBottom = 'env(safe-area-inset-bottom)';
    document.body.appendChild(probe);

    const computed = window.getComputedStyle(probe);
    const top = Math.round(parseFloat(computed.paddingTop) || 0);
    const bottom = Math.round(parseFloat(computed.paddingBottom) || 0);

    document.body.removeChild(probe);

    // 各边只在读到非 0 时锁定；仍为 0 的边保持未缓存，下次事件继续探测，读到真值再锁。
    if (cachedTopInset === null && top > 0) cachedTopInset = top;
    if (cachedBottomInset === null && bottom > 0) cachedBottomInset = bottom;

    return { top: cachedTopInset ?? top, bottom: cachedBottomInset ?? bottom };
};

export const isIOSDevice = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

export const isStandaloneDisplayMode = (): boolean => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(display-mode: standalone)').matches || !!(window.navigator as Navigator & { standalone?: boolean }).standalone;
};

export const isIOSStandaloneWebApp = (): boolean => isIOSDevice() && isStandaloneDisplayMode();

const isTextEntryElement = (target: EventTarget | null): target is HTMLElement => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
};

const setViewportVars = () => {
    if (typeof document === 'undefined') return;
    const shouldStabilizeHeight = isIOSStandaloneWebApp();
    const innerHeight = Math.round(window.innerHeight);
    const viewportHeight = Math.round(window.visualViewport?.height || innerHeight);
    const viewportOffsetTop = Math.round(window.visualViewport?.offsetTop || 0);
    // 单次探针读取上下安全区。顶部 env 偶发返回 0，探测不到时退回 44px（约状态栏/刘海高度），避免顶栏内容怼进刘海。
    const safeInsets = shouldStabilizeHeight ? readSafeAreaInsets() : { top: 0, bottom: 0 };
    const bottomSafeInset = safeInsets.bottom;
    const topSafeInset = shouldStabilizeHeight ? (safeInsets.top > 0 ? safeInsets.top : 44) : 0;
    const obscuredHeight = Math.max(0, innerHeight - viewportHeight - viewportOffsetTop);
    const keyboardInset = obscuredHeight > 120 ? obscuredHeight : 0;
    const nextViewportHeight = Math.max(innerHeight, viewportHeight + viewportOffsetTop);

    if (shouldStabilizeHeight) {
        if (!keyboardInset || !stableStandaloneHeight) {
            stableStandaloneHeight = nextViewportHeight;
        }
    } else {
        stableStandaloneHeight = 0;
    }

    const appHeight = shouldStabilizeHeight
        ? (stableStandaloneHeight || nextViewportHeight)
        : nextViewportHeight;
    const fullAppHeight = shouldStabilizeHeight
        ? appHeight + bottomSafeInset
        : appHeight;

    document.documentElement.style.setProperty('--app-height', `${fullAppHeight}px`);
    document.documentElement.style.setProperty('--visual-viewport-height', `${viewportHeight}px`);
    document.documentElement.style.setProperty('--keyboard-inset', `${keyboardInset}px`);
    document.documentElement.style.setProperty('--standalone-safe-area-bottom', `${bottomSafeInset}px`);
    document.documentElement.style.setProperty('--standalone-safe-area-top', `${topSafeInset}px`);
};

export const installIOSStandaloneWorkaround = () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (hasInstalledIOSStandaloneWorkaround) return;

    hasInstalledIOSStandaloneWorkaround = true;
    const useStandaloneFixes = isIOSStandaloneWebApp();
    if (useStandaloneFixes) {
        document.documentElement.classList.add('ios-standalone');
        document.body.classList.add('ios-standalone');
    }

    const handleViewportChange = () => {
        setViewportVars();
    };

    // 只有旋转 / 窗口尺寸变化才真的改变安全区：让缓存失效后重新探测（滚动、聚焦走缓存，不再重排）。
    const handleSafeAreaChange = () => {
        cachedTopInset = null;
        cachedBottomInset = null;
        setViewportVars();
    };

    const handleFocusIn = (event: FocusEvent) => {
        if (!isTextEntryElement(event.target)) return;
        document.body.classList.add('ios-keyboard-open');
        setViewportVars();

        const target = event.target;
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                if (document.activeElement !== target) return;
                try {
                    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                } catch {
                    // Ignore scroll failures on older iOS builds.
                }
            });
        });
    };

    const handleFocusOut = () => {
        window.setTimeout(() => {
            if (!isTextEntryElement(document.activeElement)) {
                document.body.classList.remove('ios-keyboard-open');
            }
            setViewportVars();
        }, 180);
    };

    window.addEventListener('resize', handleSafeAreaChange);
    window.addEventListener('orientationchange', handleSafeAreaChange);
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);
    if (useStandaloneFixes) {
        document.addEventListener('focusin', handleFocusIn);
        document.addEventListener('focusout', handleFocusOut);
    }
    setViewportVars();
};
