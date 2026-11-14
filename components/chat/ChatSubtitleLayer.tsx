import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import subtitleFontUrl from '../../assets/fonts/subtitle-rounded-bold.woff2?url';

type RegisterSubtitle = (source: HTMLElement, subtitle: HTMLElement) => () => void;
const SubtitleContext = createContext<{ target: ShadowRoot; register: RegisterSubtitle } | null>(null);

// Font faces live in the document (not the shadow root, for WebKit compatibility).
// Only subtitle mode mounts this rule; the font ships locally and is cached with the app.
const subtitleFontCss = `@font-face {
    font-family: "Sully Subtitle Rounded"; src: url("${subtitleFontUrl}") format("woff2");
    font-style: normal; font-weight: 700; font-display: swap;
}`;

// A separate, scrolling layer escapes bubble overflow / masks / stacking contexts.
// Shadow DOM keeps broad community selectors (div, span, *) off the subtitle text.
const subtitleCss = `
:host { all: initial !important; display: block !important; position: relative !important; height: 0 !important;
    width: 100% !important; overflow: visible !important; pointer-events: none !important; z-index: 20 !important; }
.subtitle { position: absolute; display: block; box-sizing: border-box; margin: 0; padding: 0 0 4px;
    color: white; font-family: "Sully Subtitle Rounded", ui-rounded, "PingFang SC", "Microsoft YaHei", sans-serif; font-weight: 700; font-size: 16px;
    line-height: 1.35; letter-spacing: 0; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere;
    -webkit-text-stroke: 3px #111; paint-order: stroke fill;
    text-shadow: 0 1px 1px #111; pointer-events: none; }
.subtitle * { font: inherit; color: inherit; margin: 0; padding: 0; border: 0; background: none; }
`;

/** Last visible text fragment, including Markdown's nested inline elements. */
function lastTextRect(source: HTMLElement): DOMRect | undefined {
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) nodes.push(walker.currentNode as Text);
    const range = document.createRange();
    for (let i = nodes.length - 1; i >= 0; i--) {
        range.selectNodeContents(nodes[i]);
        const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
        if (rects.length) return rects[rects.length - 1];
    }
}

export function ChatSubtitleLayer({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const [target, setTarget] = useState<ShadowRoot | null>(null);
    const entries = useRef(new Map<HTMLElement, HTMLElement>());
    const requestMeasure = useRef(() => {});
    const observeSource = useRef((_source: HTMLElement) => {});
    const unobserveSource = useRef((_source: HTMLElement) => {});

    const register = useCallback<RegisterSubtitle>((source, subtitle) => {
        entries.current.set(source, subtitle);
        observeSource.current(source);
        requestMeasure.current();
        return () => {
            entries.current.delete(source);
            unobserveSource.current(source);
            requestMeasure.current();
        };
    }, []);

    useLayoutEffect(() => {
        if (!enabled) { setTarget(null); return; }
        const host = hostRef.current!;
        const scroll = host.parentElement!;
        const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
        setTarget(shadow);
        let frame = 0;
        let followUntil = 0;
        const measure = () => {
            frame = 0;
            // Chat first pins a newly appended message before the subtitle is measured.
            // Keep that exact bottom position when the floating text extends the scroll area.
            const pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2;
            const origin = host.getBoundingClientRect();
            const scale = origin.width / host.clientWidth || 1;
            for (const [source, subtitle] of entries.current) {
                const last = lastTextRect(source);
                const rect = source.getBoundingClientRect();
                if (!last || !rect.width) { subtitle.style.visibility = 'hidden'; continue; }
                const left = Math.max(8, (rect.left - origin.left) / scale);
                const available = Math.max(0, host.clientWidth - left - 8);
                subtitle.style.left = `${left}px`;
                subtitle.style.top = `${(last.bottom - origin.top) / scale}px`;
                subtitle.style.width = `${Math.min(available, Math.max(rect.width / scale, Math.min(280, host.clientWidth * .72)))}px`;
                subtitle.style.visibility = 'visible';
            }
            if (pinned) scroll.scrollTop = scroll.scrollHeight;
            if (entries.current.size && performance.now() < followUntil) schedule();
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
        requestMeasure.current = schedule;
        const resize = new ResizeObserver(schedule);
        observeSource.current = source => resize.observe(source);
        unobserveSource.current = source => resize.unobserve(source);
        const observedRows = new Set<Element>();
        const observeRows = () => {
            for (const row of observedRows) if (row.parentElement !== scroll) { resize.unobserve(row); observedRows.delete(row); }
            for (const row of Array.from(scroll.children)) if (row !== host && !observedRows.has(row)) {
                resize.observe(row); observedRows.add(row);
            }
        };
        resize.observe(scroll);
        for (const source of entries.current.keys()) resize.observe(source);
        observeRows();
        const mutations = new MutationObserver(() => { observeRows(); schedule(); });
        mutations.observe(scroll, { childList: true, subtree: true, characterData: true, attributes: true });
        // Swiping a bubble and entrance transitions move it without changing its size.
        const followMotion = () => { followUntil = performance.now() + 600; schedule(); };
        scroll.addEventListener('transitionrun', followMotion, true);
        scroll.addEventListener('animationstart', followMotion, true);
        scroll.addEventListener('transitionend', schedule, true);
        scroll.addEventListener('animationend', schedule, true);
        document.fonts?.addEventListener('loadingdone', schedule);
        schedule();
        return () => {
            cancelAnimationFrame(frame);
            resize.disconnect(); mutations.disconnect();
            requestMeasure.current = () => {};
            observeSource.current = unobserveSource.current = () => {};
            scroll.removeEventListener('transitionrun', followMotion, true);
            scroll.removeEventListener('animationstart', followMotion, true);
            scroll.removeEventListener('transitionend', schedule, true);
            scroll.removeEventListener('animationend', schedule, true);
            document.fonts?.removeEventListener('loadingdone', schedule);
        };
    }, [enabled]);
    useLayoutEffect(() => { requestMeasure.current(); });
    const context = useMemo(() => enabled && target ? { target, register } : null, [enabled, target, register]);
    return <SubtitleContext.Provider value={context}>
        {enabled && <style>{subtitleFontCss}</style>}
        {enabled && <div ref={hostRef} data-chat-subtitle-layer="" style={{ height: 0, position: 'relative', pointerEvents: 'none', zIndex: 20 }} />}
        {enabled && target && createPortal(<style>{subtitleCss}</style>, target)}
        {children}
    </SubtitleContext.Provider>;
}

type TranslationTextProps = React.HTMLAttributes<HTMLDivElement> & { subtitle?: React.ReactNode };

/** Default bubbles and static decoration renders keep the original DOM and need no layout effects. */
export function ChatTranslationText(props: TranslationTextProps) {
    if (props.subtitle) return <AnchoredTranslationText {...props} />;
    const { subtitle: _subtitle, ...textProps } = props;
    return <div {...textProps} />;
}

function AnchoredTranslationText({ children, subtitle, ...props }: TranslationTextProps) {
    const layer = useContext(SubtitleContext);
    const sourceRef = useRef<HTMLDivElement>(null);
    const subtitleRef = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        if (layer && subtitle && sourceRef.current && subtitleRef.current) return layer.register(sourceRef.current, subtitleRef.current);
    }, [layer, subtitle, children]);
    return <>
        <div {...props} ref={sourceRef} data-chat-translation-source={subtitle ? '' : undefined}>{children}</div>
        {subtitle && layer && createPortal(<span ref={subtitleRef} className="subtitle" data-chat-subtitle="" style={{ visibility: 'hidden' }}>{subtitle}</span>, layer.target)}
        {/* Standalone message previews without a layer retain a readable translation. */}
        {subtitle && !layer && <div>{subtitle}</div>}
    </>;
}
