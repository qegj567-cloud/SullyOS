import {useEffect, useRef, useState, type RefObject} from 'react';

/** A downward touch starting at the top; horizontal galleries keep their native gestures. */
export function useFriendFeedPullRefresh(scroller: RefObject<HTMLDivElement>, enabled: boolean, refresh: () => void) {
    const [distance, setDistance] = useState(0);
    const callback = useRef(refresh); callback.current = refresh;
    useEffect(() => {
        const node = scroller.current;
        if (!node || !enabled) {setDistance(0); return;}
        let start: {x: number; y: number} | undefined, delta = 0;
        const cancel = () => {start = undefined; delta = 0; setDistance(0);};
        const begin = (e: TouchEvent) => {
            cancel();
            if (node.scrollTop > 0 || e.touches.length !== 1 || (e.target as Element).closest('input,textarea,select,button,a,dialog,.ff-photo-carousel')) return;
            start = {x: e.touches[0].clientX, y: e.touches[0].clientY};
        };
        const move = (e: TouchEvent) => {
            if (!start) return;
            if (e.touches.length !== 1 || node.scrollTop > 0) {cancel(); return;}
            const dx = e.touches[0].clientX - start.x, dy = e.touches[0].clientY - start.y;
            if (Math.abs(dx) > Math.max(10, Math.abs(dy)) || dy < -8) {cancel(); return;}
            delta = Math.max(0,dy); setDistance(Math.min(64,delta / 2));
            if (dy > 8) e.preventDefault();
        };
        const end = () => {const ready = delta >= 84; cancel(); if (ready) callback.current();};
        node.addEventListener('touchstart', begin, {passive: true});
        node.addEventListener('touchmove', move, {passive: false});
        node.addEventListener('touchend', end); node.addEventListener('touchcancel', cancel);
        return () => {node.removeEventListener('touchstart', begin); node.removeEventListener('touchmove', move); node.removeEventListener('touchend', end); node.removeEventListener('touchcancel', cancel);};
    }, [scroller, enabled]);
    return distance;
}
