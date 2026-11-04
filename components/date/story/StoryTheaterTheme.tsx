import MeetingAppearanceControl from '../MeetingAppearanceControl';
import {meetingAppearance, MEETING_READING_CSS, meetingCustomCss} from '../../../utils/meetingAppearance';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Moon, Palette, Sparkle, SquaresFour, Sun, X } from '@phosphor-icons/react';
import { STORY_THEATER_APPEARANCE_STORAGE_KEY } from '../../../utils/storyTheaterBackup';
import { useOS } from '../../../context/OSContext';

export type StoryColorMode = 'light' | 'dark';
export type StoryDecorMode = 'plain' | 'cinema';

interface StoryAppearance {
    color: StoryColorMode;
    decor: StoryDecorMode;
}

interface StoryThemeContextValue {
    appearance: StoryAppearance;
    setColor: (value: StoryColorMode) => void;
    setDecor: (value: StoryDecorMode) => void;
}

const STORAGE_KEY = STORY_THEATER_APPEARANCE_STORAGE_KEY;
const STORY_APPEARANCE_HISTORY_KEY = '__sullyStoryAppearance';
const DEFAULT_APPEARANCE: StoryAppearance = { color: 'light', decor: 'plain' };
const StoryThemeContext = createContext<StoryThemeContextValue | null>(null);

function readAppearance(): StoryAppearance {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_APPEARANCE;
        const value = JSON.parse(raw) as Partial<StoryAppearance>;
        return {
            color: value.color === 'dark' ? 'dark' : 'light',
            decor: value.decor === 'cinema' ? 'cinema' : 'plain',
        };
    } catch {
        return DEFAULT_APPEARANCE;
    }
}

const STORY_THEME_CSS = `
.story-theme {
  --story-bg: #f6f4ef;
  --story-surface: #fffdfa;
  --story-raised: #ffffff;
  --story-ink: #243047;
  --story-muted: #728097;
  --story-faint: #aeb7c6;
  --story-line: #dce1e8;
  --story-soft: #e9edf2;
  --story-accent: #7c3aed;
  --story-accent-soft: #ede9fe;
  --story-accent-ink: #6d28d9;
  position: relative;
  isolation: isolate;
  overflow: hidden;
  background: var(--story-bg);
  color: var(--story-ink);
  color-scheme: light;
}
.story-theme-dark {
  --story-bg: #111519;
  --story-surface: #181e24;
  --story-raised: #202831;
  --story-ink: #edf1f5;
  --story-muted: #a3afbe;
  --story-faint: #6f7b89;
  --story-line: #303a45;
  --story-soft: #252e37;
  --story-accent: #ad8bff;
  --story-accent-soft: #2e2548;
  --story-accent-ink: #c8b4ff;
  color-scheme: dark;
}
.story-theme.story-decor-cinema {
  --story-bg: #faf4f0;
  --story-surface: #fffaf4;
  --story-raised: #fffdf9;
  --story-line: #eadbd5;
  --story-accent: #8b5cf6;
  --story-accent-soft: #f0e7ff;
  --story-accent-ink: #7c3aed;
}
.story-theme-dark.story-decor-cinema {
  --story-bg: #0d1020;
  --story-surface: #15182b;
  --story-raised: #1d2037;
  --story-line: #343854;
  --story-accent: #bd9cff;
  --story-accent-soft: #30264d;
  --story-accent-ink: #d5c3ff;
}
.story-theme::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 240ms ease;
}
.story-theme.story-decor-cinema::before {
  opacity: 1;
  background:
    radial-gradient(circle at 10% 4%, color-mix(in srgb, var(--story-accent) 17%, transparent) 0, transparent 28%),
    radial-gradient(circle at 92% 34%, rgba(251, 191, 36, .12) 0, transparent 25%),
    linear-gradient(115deg, transparent 0 47%, rgba(255,255,255,.035) 48% 49%, transparent 50% 100%);
}
.story-theme > * { position: relative; z-index: 1; }
.story-theme .bg-stone-100 { background-color: var(--story-bg) !important; }
.story-theme .bg-stone-100\\/95 { background-color: var(--story-bg) !important; }
.story-theme .bg-white { background-color: var(--story-raised) !important; }
.story-theme .bg-slate-50, .story-theme .bg-slate-100 { background-color: var(--story-surface) !important; }
.story-theme .bg-slate-200 { background-color: var(--story-soft) !important; }
.story-theme .bg-slate-900 { background-color: var(--story-ink) !important; color: var(--story-bg) !important; }
.story-theme .text-slate-900, .story-theme .text-slate-800, .story-theme .text-slate-700, .story-theme .text-slate-600 { color: var(--story-ink) !important; }
.story-theme .text-slate-500, .story-theme .text-slate-400 { color: var(--story-muted) !important; }
.story-theme .text-slate-300 { color: var(--story-faint) !important; }
.story-theme .border-slate-100, .story-theme .border-slate-200, .story-theme .border-slate-300 { border-color: var(--story-line) !important; }
.story-theme .divide-slate-200 > :not([hidden]) ~ :not([hidden]) { border-color: var(--story-line) !important; }
.story-theme .text-violet-500, .story-theme .text-violet-600, .story-theme .text-violet-700 { color: var(--story-accent-ink) !important; }
.story-theme .bg-violet-50, .story-theme .bg-violet-100 { background-color: var(--story-accent-soft) !important; }
.story-theme .bg-violet-500, .story-theme .bg-violet-600 { background-color: var(--story-accent) !important; }
.story-theme .border-violet-100, .story-theme .border-violet-200 { border-color: color-mix(in srgb, var(--story-accent) 34%, var(--story-line)) !important; }
.story-theme-dark .bg-rose-50\\/70 { background-color: rgba(78, 35, 55, .72) !important; }
.story-theme-dark .text-rose-800, .story-theme-dark .text-rose-700, .story-theme-dark .text-rose-600, .story-theme-dark .text-rose-500 { color: #f4a8bd !important; }
.story-theme-dark .border-rose-200, .story-theme-dark .border-rose-200\\/70 { border-color: rgba(244, 168, 189, .28) !important; }
.story-theme .story-safe-header { padding-top: max(1.25rem, var(--safe-top)); }
.story-theme .story-safe-footer { padding-bottom: calc(var(--safe-bottom) + 12px); }
.story-theme .story-safe-sheet { padding-bottom: calc(var(--safe-bottom) + 18px); }
.story-theme .story-quick-preset { bottom: calc(var(--safe-bottom) + 112px); }
.story-theme .story-page-scroll {
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  scrollbar-color: var(--story-line) transparent;
}
.story-theme .story-page-scroll:hover,
.story-theme .story-page-scroll:focus-within { scrollbar-color: var(--story-faint) transparent; }
/* WebKit styling also removes the Windows arrow buttons and opaque track. */
@supports selector(::-webkit-scrollbar) {
  .story-theme .story-page-scroll { scrollbar-width: auto; scrollbar-color: auto; }
  .story-theme .story-page-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
  .story-theme .story-page-scroll::-webkit-scrollbar-track,
  .story-theme .story-page-scroll::-webkit-scrollbar-corner { background: transparent; }
  .story-theme .story-page-scroll::-webkit-scrollbar-thumb { background: var(--story-line); border-radius: 999px; }
  .story-theme .story-page-scroll:hover::-webkit-scrollbar-thumb,
  .story-theme .story-page-scroll:focus-within::-webkit-scrollbar-thumb { background: var(--story-faint); }
  .story-theme .story-page-scroll::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
.story-theme.story-decor-plain .shadow-sm { box-shadow: none !important; }
.story-theme.story-decor-cinema .story-cinema-rule { position: relative; }
.story-theme.story-decor-cinema .story-cinema-rule::after {
  content: '✦  ·  ✦';
  position: absolute;
  right: 0;
  bottom: -5px;
  padding-left: 10px;
  color: var(--story-accent);
  background: var(--story-bg);
  font-size: 8px;
  letter-spacing: .24em;
}
body.ios-keyboard-open .story-theme .story-safe-footer { padding-bottom: 12px !important; }
body.ios-keyboard-open .story-theme .story-safe-sheet { padding-bottom: 18px !important; }
body.ios-keyboard-open .story-theme .story-quick-preset { bottom: 112px !important; }
@media (prefers-reduced-motion: reduce) {
  .story-theme *, .story-theme *::before, .story-theme *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
`;

export const StoryTheaterThemeProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
    const [appearance, setAppearance] = useState<StoryAppearance>(readAppearance);
    const {theme} = useOS();
    const reading = meetingAppearance(theme.storyAppearance);
    const color = reading.id === 'none' ? appearance.color : reading.id === 'night' ? 'dark' : 'light';

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
    }, [appearance]);

    const value = useMemo<StoryThemeContextValue>(() => ({
        appearance,
        setColor: color => setAppearance(current => ({ ...current, color })),
        setDecor: decor => setAppearance(current => ({ ...current, decor })),
    }), [appearance]);

    return <StoryThemeContext.Provider value={value}>
        <div className={`story-theme story-theme-${color} story-decor-${appearance.decor} h-full w-full min-h-0 ${reading.id!=='none'?'meeting-reading':''}`} data-reading-preset={reading.id}>
            <style>{STORY_THEME_CSS + MEETING_READING_CSS + '\n' + meetingCustomCss(theme.storyAppearance)}</style>
            {children}
        </div>
    </StoryThemeContext.Provider>;
};

export const StoryAppearanceButton: React.FC<{ className?: string }> = ({ className = '' }) => {
    const context = useContext(StoryThemeContext);
    const { registerBackHandler, theme } = useOS();
    const [open, setOpen] = useState(false);
    const closePanel = useCallback(() => {
        setOpen(false);
        try {
            if (window.history.state?.[STORY_APPEARANCE_HISTORY_KEY]) window.history.back();
        } catch { /* history 不可用时仍正常关闭 */ }
    }, []);

    useEffect(() => {
        if (!open) return;

        try {
            const previous = window.history.state && typeof window.history.state === 'object'
                ? window.history.state
                : {};
            if (!previous[STORY_APPEARANCE_HISTORY_KEY]) {
                window.history.pushState({ ...previous, [STORY_APPEARANCE_HISTORY_KEY]: true }, '');
            }
        } catch { /* 某些内嵌 WebView 禁用 history，保留其它关闭方式 */ }

        const unregister = registerBackHandler(() => {
            closePanel();
            return true;
        });
        const handlePopState = () => setOpen(false);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closePanel();
        };
        window.addEventListener('popstate', handlePopState);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            unregister();
            window.removeEventListener('popstate', handlePopState);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [closePanel, open, registerBackHandler]);
    if (!context) return null;
    const { appearance, setColor, setDecor } = context;

    return <>
        <button type='button' onClick={() => setOpen(true)} className={`w-9 h-9 rounded-full grid place-items-center ${className}`} title='剧情外观' aria-label='剧情外观'>
            <Palette size={18} weight={appearance.decor === 'cinema' ? 'fill' : 'regular'} />
        </button>
        {open && createPortal(<div
            className={`story-theme story-theme-${appearance.color} story-decor-${appearance.decor} fixed inset-0 z-[90] flex items-end sm:items-center justify-center overflow-y-auto overscroll-contain`}
            style={{ position: 'fixed', paddingTop: 'max(12px, var(--safe-top))', paddingBottom: 'max(0px, var(--safe-bottom))', backgroundColor: 'rgba(2, 6, 23, .35)' }}
            onClick={closePanel}
            role='presentation'
        >
            <div
                className='story-safe-sheet relative flex w-full max-h-full flex-col overflow-hidden sm:max-w-sm rounded-t-[28px] sm:rounded-[28px] bg-stone-100 px-5 pt-5 shadow-2xl'
                onClick={event => event.stopPropagation()}
                role='dialog'
                aria-modal='true'
                aria-labelledby='story-appearance-title'
            >
                <div className='shrink-0 flex items-start gap-4'>
                    <div className='min-w-0 flex-1'><div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>Story appearance</div><h2 id='story-appearance-title' className='mt-1 text-lg font-semibold'>剧情放映厅外观</h2><p className='mt-1 text-[10px] leading-5 text-slate-500'>只影响剧情模式，普通聊天与记忆宫殿保持原样。</p></div>
                    <button type='button' onClick={closePanel} className='w-10 h-10 shrink-0 rounded-full bg-white border border-slate-200 grid place-items-center' aria-label='关闭剧情外观'><X size={17} /></button>
                </div>
                <div className='mt-5 min-h-0 overflow-y-auto overscroll-contain border-t border-slate-200'><MeetingAppearanceControl surface='story' /><div hidden={meetingAppearance(theme.storyAppearance).id !== 'none'}>
                    <div className='py-4 flex items-center gap-3'><span className='text-xs font-semibold w-16'>明暗</span><div className='min-w-0 flex-1 grid grid-cols-2 p-1 rounded-xl bg-slate-200'><button onClick={() => setColor('light')} className={`py-2 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5 ${appearance.color === 'light' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500'}`}><Sun size={14} />浅色</button><button onClick={() => setColor('dark')} className={`py-2 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5 ${appearance.color === 'dark' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500'}`}><Moon size={14} />深色</button></div></div>
                    <div className='py-4 border-t border-slate-200 flex items-center gap-3'><span className='text-xs font-semibold w-16'>装饰</span><div className='min-w-0 flex-1 grid grid-cols-2 p-1 rounded-xl bg-slate-200'><button onClick={() => setDecor('plain')} className={`py-2 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5 ${appearance.decor === 'plain' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500'}`}><SquaresFour size={14} />素雅</button><button onClick={() => setDecor('cinema')} className={`py-2 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5 ${appearance.decor === 'cinema' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500'}`}><Sparkle size={14} />花里胡哨</button></div></div>
                </div></div>
            </div>
        </div>, document.body)}
    </>;
};
