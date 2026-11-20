// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
    BROWSER_BACK_GUARD_KEY,
    isBrowserBackGuardState,
    makeBrowserBackGuardState,
    listenForAppBrowserBack,
} from './browserBackGuard';

describe('browser back guard history state', () => {
    it('reuses one browser entry for post → feed → launcher, including a nested entry above it', async () => {
        const pages = ['桌面','哔哔','帖子'];
        const stop = listenForAppBrowserBack(window, () => {pages.pop();});
        const depth = history.length;
        try {
            history.pushState({...history.state, sheet:true}, '');
            history.back();
            await vi.waitFor(() => expect(history.state.sheet).toBeUndefined());
            expect(pages.at(-1)).toBe('帖子');
            for (const destination of ['哔哔','桌面']) {
                history.back();
                await vi.waitFor(() => expect(pages.at(-1)).toBe(destination));
                expect(isBrowserBackGuardState(history.state)).toBe(true);
                expect(history.length).toBe(depth+1);
            }
        } finally { stop?.(); }
    });
    it('preserves existing nested-view history markers', () => {
        const state = makeBrowserBackGuardState({ storyAppearancePanel: true });

        expect(state).toEqual({
            storyAppearancePanel: true,
            [BROWSER_BACK_GUARD_KEY]: true,
        });
        expect(isBrowserBackGuardState(state)).toBe(true);
    });

    it('normalizes unusable history states before adding the guard', () => {
        expect(makeBrowserBackGuardState(null)).toEqual({ [BROWSER_BACK_GUARD_KEY]: true });
        expect(makeBrowserBackGuardState('legacy-state')).toEqual({ [BROWSER_BACK_GUARD_KEY]: true });
        expect(isBrowserBackGuardState({ [BROWSER_BACK_GUARD_KEY]: false })).toBe(false);
    });
});
