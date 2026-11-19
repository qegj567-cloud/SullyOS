export const BROWSER_BACK_GUARD_KEY = '__sullyOSBrowserBackGuardV1';

type HistoryStateRecord = Record<string, unknown>;

const asHistoryStateRecord = (state: unknown): HistoryStateRecord => (
    state !== null && typeof state === 'object' && !Array.isArray(state)
        ? state as HistoryStateRecord
        : {}
);

export const isBrowserBackGuardState = (state: unknown): boolean => (
    asHistoryStateRecord(state)[BROWSER_BACK_GUARD_KEY] === true
);

export const makeBrowserBackGuardState = (state: unknown): HistoryStateRecord => ({
    ...asHistoryStateRecord(state),
    [BROWSER_BACK_GUARD_KEY]: true,
});

/** Reuse the original same-document entry across consecutive system back gestures. */
export function listenForAppBrowserBack(browser: Window, back: () => void) {
    const history = browser.history;
    if (!isBrowserBackGuardState(history.state)) {
        try { history.pushState(makeBrowserBackGuardState(history.state), '', browser.location.href); }
        catch { return; }
    }
    let returningToGuard = false;
    const onPop = (event: PopStateEvent) => {
        if (isBrowserBackGuardState(event.state)) {
            if (returningToGuard) {
                returningToGuard = false;
                back();
            }
            return;
        }
        // A new pushState from popstate lacks a fresh user gesture. Mobile browsers
        // may skip that replacement entry on the next hardware back or edge swipe.
        returningToGuard = true;
        try { history.forward(); } catch { returningToGuard = false; back(); }
    };
    browser.addEventListener('popstate', onPop);
    return () => browser.removeEventListener('popstate', onPop);
}
