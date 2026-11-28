import React, { useRef, useEffect } from 'react';

export default function PresetNameButton({ onHold, onClick, ...props }: React.ComponentProps<'button'> & { onHold: () => void }) {
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const held = useRef(false);
    const moved = useRef(false);
    const pressed = useRef(false);
    const start = useRef({ x: 0, y: 0 });
    const cancel = () => clearTimeout(timer.current);
    const stopScrollWatch = useRef<(() => void) | undefined>(undefined);
    const finishPress = () => {
        pressed.current = false;
        cancel();
        stopScrollWatch.current?.();
        stopScrollWatch.current = undefined;
    };
    useEffect(() => () => { cancel(); stopScrollWatch.current?.(); }, []);
    return <button {...props} type="button"
        onPointerDown={event => {
            if (event.button !== 0) return;
            finishPress();
            const onScroll = () => { moved.current = true; cancel(); };
            document.addEventListener('scroll', onScroll, { capture: true, passive: true });
            stopScrollWatch.current = () => document.removeEventListener('scroll', onScroll, true);
            held.current = false;
            moved.current = false;
            pressed.current = true;
            start.current = { x: event.clientX, y: event.clientY };
            timer.current = setTimeout(() => { held.current = true; onHold(); }, 550);
        }}
        onPointerMove={event => {
            if (pressed.current && Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 8) { moved.current = true; cancel(); }
        }}
        onPointerUp={finishPress}
        onPointerCancel={() => { moved.current = true; finishPress(); }}
        // Touch dispatches pointerleave after pointerup, before click. It is not a drag.
        onPointerLeave={() => { if (pressed.current) { moved.current = true; finishPress(); } }}
        onContextMenu={event => { event.preventDefault(); cancel(); if (!held.current && !moved.current) onHold(); held.current = true; }}
        onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); onHold(); } }}
        onClick={event => {
            if (!held.current && (!moved.current || event.detail === 0)) onClick?.(event);
            held.current = false;
        }} />;
}
