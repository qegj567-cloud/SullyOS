import React, { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface DateDialogueTextHandle { finish: () => void }

/** Keep character-by-character updates inside the text, not the whole session. */
const DateDialogueText = memo(forwardRef<DateDialogueTextHandle, {
    text: string;
    overrideText?: string;
    onAnimatingChange: (animating: boolean) => void;
}>(function DateDialogueText({ text, overrideText, onAnimatingChange }, ref) {
    const [visible, setVisible] = useState('');
    const [animating, setAnimating] = useState(false);
    const timer = useRef<ReturnType<typeof setInterval> | null>(null);
    const paragraph = useRef<HTMLParagraphElement>(null);
    const stop = () => { if (timer.current !== null) clearInterval(timer.current); timer.current = null; };
    useImperativeHandle(ref, () => ({ finish() {
        stop(); setVisible(text); setAnimating(false); onAnimatingChange(false);
    } }), [text, onAnimatingChange]);
    useEffect(() => {
        if (paragraph.current) paragraph.current.scrollTop = 0;
        if (!text || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            setVisible(text); setAnimating(false); onAnimatingChange(false);
            return;
        }
        setVisible(''); setAnimating(true); onAnimatingChange(true);
        let index = 0;
        timer.current = setInterval(() => {
            index++;
            setVisible(text.slice(0, index));
            if (index >= text.length) { stop(); setAnimating(false); onAnimatingChange(false); }
        }, 20);
        return stop;
    }, [text, onAnimatingChange]);
    useEffect(() => () => onAnimatingChange(false), [onAnimatingChange]);
    return <p ref={paragraph} className="text-white/90 text-[16px] leading-relaxed font-light tracking-wide mt-2 whitespace-pre-wrap max-h-[35dvh] overflow-y-auto overscroll-contain touch-pan-y break-words pr-1" data-sar-gal-text>
        {overrideText ?? visible}
        {animating && overrideText === undefined && <span className="inline-block w-2 h-4 bg-white/70 ml-1 animate-pulse align-middle" />}
    </p>;
}));

export default DateDialogueText;
