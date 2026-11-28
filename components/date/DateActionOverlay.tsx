import React, { useEffect, useRef } from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { DATE_ACTION_KINDS, type DateActionChoice } from '../../utils/dateActionChoices';
import './dateActions.css';

/** Overlay only: never participates in the dialogue or composer layout. */
export default function DateActionOverlay({ choices, onSelect, onClose, light = false }: {
    choices: DateActionChoice[];
    onSelect: (choice: DateActionChoice) => void;
    onClose: () => void;
    light?: boolean;
}) {
    const panel = useRef<HTMLDivElement>(null);
    const close = useRef(onClose);
    close.current = onClose;
    useLocalBackHandler(() => { close.current(); return true; }, 65);
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        panel.current?.focus({ preventScroll: true });
        return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
    }, []);
    return <div className={`date-actions${light ? ' date-actions--light' : ''}`} onClick={event => { event.stopPropagation(); onClose(); }}>
        <div ref={panel} role="dialog" aria-modal="true" aria-label="行动建议" tabIndex={-1} className="date-dialogue-surface date-actions__panel"
            onClick={event => event.stopPropagation()} onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
                if (event.key !== 'Tab') return;
                const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button') || []);
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                if (event.shiftKey && index <= 0) { event.preventDefault(); buttons.at(-1)?.focus(); }
                else if (!event.shiftKey && (index < 0 || index === buttons.length - 1)) { event.preventDefault(); buttons[0]?.focus(); }
            }}>
            <div className="date-actions__heading"><span>接下来，做些什么？</span><button type="button" onClick={onClose}>收起建议</button></div>
            <div className="date-actions__list">
                {choices.map(choice => <button key={choice.kind} type="button" onClick={() => onSelect(choice)}>
                    <span className="date-actions__copy">
                    <span className="date-actions__kind">{DATE_ACTION_KINDS.find(item => item.id === choice.kind)!.label}</span>
                    <span>{choice.text}</span>
                    </span>
                    <svg className="date-actions__arrow" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m8 5 5 5-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>)}
            </div>
            <p>选一句，补充后再发送</p>
        </div>
    </div>;
}
