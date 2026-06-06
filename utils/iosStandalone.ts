let hasInstalledIOSStandaloneWorkaround = false;
let stableStandaloneHeight = 0;

const readSafeAreaInset = (edge: 'top' | 'right' | 'bottom' | 'left'): number => {
    if (typeof document === 'undefined') return 0;

    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.opacity = '0';
    probe.style.setProperty(`padding-${edge}`, `env(safe-area-inset-${edge})`);
    document.body.appendChild(probe);

    const computed = window.getComputedStyle(probe);
    const inset = parseFloat(computed.getPropertyValue(`padding-${edge}`)) || 0;

    document.body.removeChild(probe);
    return Math.round(inset);
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
    const bottomSafeInset = shouldStabilizeHeight ? readSafeAreaInset('bottom') : 0;
    // 顶部安全区：iOS 全屏 PWA 下原生 env(safe-area-inset-top) 偶发返回 0，
    // 探测不到时退回 44px（约状态栏/刘海高度），避免顶栏内容怼进刘海。
    const probedTopInset = shouldStabilizeHeight ? readSafeAreaInset('top') : 0;
    const topSafeInset = shouldStabilizeHeight ? (probedTopInset > 0 ? probedTopInset : 44) : 0;
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

    window.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);
    if (useStandaloneFixes) {
        document.addEventListener('focusin', handleFocusIn);
        document.addEventListener('focusout', handleFocusOut);
    }
    setViewportVars();
};
