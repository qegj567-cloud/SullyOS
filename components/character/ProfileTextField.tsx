import React, { useLayoutEffect, useRef, useState } from 'react';
import { ArrowsOutSimple, Check } from '@phosphor-icons/react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { trackEvent } from '../../utils/analytics';

type Props = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { expandable: boolean; label: string };

export default function ProfileTextField({ expandable, label, className, ...field }: Props) {
    const [expanded, setExpanded] = useState(false);
    const inline = useRef<HTMLTextAreaElement>(null);
    const editor = useRef<HTMLTextAreaElement>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const selection = useRef([0, 0]);

    function close() {
        if (editor.current) selection.current = [editor.current.selectionStart, editor.current.selectionEnd];
        dialog.current?.close();
        setExpanded(false);
        inline.current?.setSelectionRange(selection.current[0], selection.current[1]);
        trigger.current?.focus({ preventScroll: true });
    }
    useLocalBackHandler(() => { close(); return true; }, 55, expanded);
    useLayoutEffect(() => {
        if (!expanded) return;
        dialog.current?.showModal();
        editor.current?.focus({ preventScroll: true });
        editor.current?.setSelectionRange(selection.current[0], selection.current[1]);
    }, [expanded]);
    if (!expandable) return <textarea aria-label={label} className={className} {...field} />;
    return <div className="chat-profile-text-field">
        <textarea aria-label={label} ref={inline} className={className} {...field} />
        <button type="button" ref={trigger} className="chat-profile-expand" aria-label={'展开编辑' + label} onClick={() => {
            if (inline.current) selection.current = [inline.current.selectionStart, inline.current.selectionEnd];
            setExpanded(true);
            trackEvent('展开角色设定编辑');
        }}><ArrowsOutSimple size={15} />展开</button>
        {expanded && <dialog className="chat-profile-text-dialog" ref={dialog} aria-label={'全屏编辑' + label}
            onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}>
            <header><h2>{label}</h2><button type="button" onClick={close}><Check size={17} />完成</button></header>
            <textarea ref={editor} aria-label={'编辑' + label} {...field} />
        </dialog>}
    </div>;
}
