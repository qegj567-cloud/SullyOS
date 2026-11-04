import { useCallback, useLayoutEffect, useRef } from 'react';

type ReadingAnchor = { id: string; offset: number };

function readAnchor(element: HTMLElement): ReadingAnchor | null {
    const viewport = element.getBoundingClientRect();
    for (const row of element.querySelectorAll<HTMLElement>('[data-date-message-id]')) {
        const bounds = row.getBoundingClientRect();
        if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
            return { id: row.dataset.dateMessageId!, offset: bounds.top - viewport.top };
        }
    }
    return null;
}

/** Keep the end or the visible message anchored while deferred rows acquire their real heights. */
export function useDateReadingScroll({ active, messages, layoutKey, onLoadOlder }: {
    active: boolean;
    messages: readonly { id: number }[];
    layoutKey?: unknown;
    onLoadOlder?: () => void;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const position = useRef({ active: false, top: 0, followBottom: true, anchor: null as ReadingAnchor | null });
    const userScrollPending = useRef(false);

    const restorePosition = useCallback(() => {
        const element = scrollRef.current;
        const saved = position.current;
        if (!element || !saved.active) return;
        if (saved.followBottom) {
            element.scrollTop = element.scrollHeight;
        } else if (saved.anchor) {
            const anchor = element.querySelector<HTMLElement>(`[data-date-message-id="${saved.anchor.id}"]`);
            if (anchor) {
                const offset = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top;
                element.scrollTop += offset - saved.anchor.offset;
            } else {
                // An edited/deleted selection may remove the anchor; keep the current viewport.
                saved.anchor = readAnchor(element);
            }
        }
        // A later scroll event from this correction is not a user scrolling away from the end.
        saved.top = element.scrollTop;
    }, []);

    useLayoutEffect(() => {
        const saved = position.current;
        if (!active) {
            saved.active = false;
            return;
        }
        if (!saved.active) {
            saved.active = true;
            saved.followBottom = true;
            saved.anchor = null;
        }
        restorePosition();
    }, [active, messages, layoutKey, restorePosition]);

    useLayoutEffect(() => {
        const element = scrollRef.current;
        const content = contentRef.current;
        if (!active || !element || !content) return;
        let frame: number | undefined;
        let inputFrame: number | undefined;
        const onScrollInput = (event: Event) => {
            if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
            if (event instanceof PointerEvent && !event.buttons) return;
            userScrollPending.current = true;
            if (inputFrame !== undefined) cancelAnimationFrame(inputFrame);
            inputFrame = requestAnimationFrame(() => { inputFrame = undefined; userScrollPending.current = false; });
        };
        const inputEvents = ['wheel', 'touchmove', 'pointermove', 'keydown'];
        inputEvents.forEach(event => element.addEventListener(event, onScrollInput, { passive: true }));
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
            // Do not write scroll/layout inside the ResizeObserver delivery cycle.
            if (frame === undefined) frame = requestAnimationFrame(() => {
                frame = undefined;
                restorePosition();
            });
        });
        observer?.observe(content);
        observer?.observe(element);
        return () => {
            observer?.disconnect();
            inputEvents.forEach(event => element.removeEventListener(event, onScrollInput));
            userScrollPending.current = false;
            if (frame !== undefined) cancelAnimationFrame(frame);
            if (inputFrame !== undefined) cancelAnimationFrame(inputFrame);
        };
    }, [active, restorePosition]);

    const onScroll = useCallback(() => {
        const element = scrollRef.current;
        const saved = position.current;
        if (!element || !saved.active) return;
        const difference = element.scrollTop - saved.top;
        const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
        // Shrinking content can clamp scrollTop and emit scroll before the resize observer.
        // That is not a reader choosing the bottom; retain the message anchor unless an
        // actual wheel/touch/keyboard/scrollbar gesture is in progress.
        if (!saved.followBottom && saved.top > maxTop + 1 && Math.abs(element.scrollTop - maxTop) < 1 && !userScrollPending.current) {
            restorePosition();
            return;
        }
        userScrollPending.current = false;
        // Height changes can emit scroll without moving scrollTop. Keep the existing intent:
        // recalculating "near bottom" here would undo the pending resize correction.
        if (Math.abs(difference) < 1) return;
        saved.top = element.scrollTop;
        saved.followBottom = element.scrollHeight - element.clientHeight - element.scrollTop < 100;
        saved.anchor = saved.followBottom ? null : readAnchor(element);
        if (difference < 0 && element.scrollTop < 80) onLoadOlder?.();
    }, [onLoadOlder, restorePosition]);

    return { scrollRef, contentRef, onScroll };
}
