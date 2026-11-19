import {useRef, type TouchEvent} from 'react';

/** Only arm on a new gesture that starts at the end of this conversation. */
export function useChatTailProfileGesture(characterId: string | undefined, enabled: boolean, open: () => void) {
    const start = useRef<{id: number; characterId: string; x: number; y: number; peak: number} | null>(null);
    const atEnd = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop <= 3;
    return {
        onTouchStartCapture(event: TouchEvent<HTMLDivElement>) {
            start.current = null;
            const el = event.currentTarget, target = event.target;
            if (!enabled || !characterId || event.touches.length !== 1 || !atEnd(el) || !(target instanceof Element)) return;
            if (target.closest('button,a,input,textarea,select,summary,[role="button"],[contenteditable="true"]')) return;
            for (let node: Element | null = target; node && node !== el; node = node.parentElement) {
                if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
            }
            const touch = event.touches[0];
            if (el.getBoundingClientRect().bottom - touch.clientY > Math.min(180, el.clientHeight / 3)) return;
            start.current = {id: touch.identifier, characterId, x: touch.clientX, y: touch.clientY, peak: 0};
        },
        onTouchMoveCapture(event: TouchEvent<HTMLDivElement>) {
            const origin = start.current;
            if (!origin) return;
            const touch = event.touches[0];
            if (event.touches.length !== 1 || touch.identifier !== origin.id) { start.current = null; return; }
            const dy = origin.y - touch.clientY;
            if (origin.peak - dy > 18 || Math.abs(origin.x - touch.clientX) > Math.max(24, dy * .45)) {
                start.current = null;
                return;
            }
            origin.peak = Math.max(origin.peak, dy);
        },
        onTouchCancelCapture() { start.current = null; },
        onTouchEndCapture(event: TouchEvent<HTMLDivElement>) {
            const origin = start.current;
            start.current = null;
            if (!origin || !enabled || origin.characterId !== characterId || event.touches.length || !atEnd(event.currentTarget)) return;
            const touch = event.changedTouches[0];
            if (!touch || touch.identifier !== origin.id) return;
            const dy = origin.y - touch.clientY;
            const distance = Math.max(96, Math.min(128, event.currentTarget.clientHeight * .18));
            if (dy >= distance && origin.peak - dy <= 18 && dy > 2.2 * Math.abs(origin.x - touch.clientX) && !window.getSelection()?.toString()) open();
        },
    };
}
