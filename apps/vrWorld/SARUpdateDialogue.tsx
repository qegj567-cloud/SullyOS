import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SAR_UPDATE_NOTICES, type SARUpdateNotice } from '../../utils/vrWorld/sarUpdateNotices';
import { SARDialogueCast } from './SARNpcArt';
import { SARDialogueBackdrop } from './SARDialogueBackdrop';
import { SARDialogueMeta } from './SARDialogueMeta';
import './sar-familiarity-dialog.css';

export function SARUpdateDialogue({ notice, onComplete }: { notice: SARUpdateNotice; onComplete: () => void }) {
    const [index, setIndex] = useState(0);
    const dialog = useRef<HTMLDialogElement>(null), complete = useRef(false);
    // Long author notes use consecutive pages with the same expression, like daily dialogue.
    const lines = SAR_UPDATE_NOTICES[notice].flatMap(line =>
        (typeof line.text === 'string' ? [line.text] : line.text).map(text => ({ ...line, text })));
    const line = lines[index];
    useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
    const next = () => {
        if (complete.current) return;
        if (index < lines.length - 1) { setIndex(index + 1); return; }
        complete.current = true;
        dialog.current?.close();
        onComplete();
    };
    const offset = line.emphasis ? line.text.indexOf(line.emphasis) : -1;
    const text = offset < 0 ? line.text : <>{line.text.slice(0, offset)}<strong>{line.emphasis}</strong>{line.text.slice(offset + line.emphasis!.length)}</>;
    return createPortal(<dialog ref={dialog} className="srf-dialog srf-caian" aria-label="凯恩的优化通知" data-sar-update={notice}
        style={{ margin: 0, border: 0, width: '100%', maxWidth: 'none', height: '100%', maxHeight: 'none', boxSizing: 'border-box' }}
        onCancel={event => event.preventDefault()} onKeyDown={event => {
            if (event.key === 'ArrowRight') { event.preventDefault(); if (!event.repeat) next(); }
        }}>
        <SARDialogueBackdrop/>
        <div className="srf-body">
            <div className="srf-stage"><SARDialogueCast speaker="caian" expression={line.expression}/></div>
            <div className="srf-script">
                <SARDialogueMeta npc="caian" speaker="凯恩"/>
                <button autoFocus type="button" className="srf-bubble" aria-label="继续对话" onClick={next}>
                    <span className="srf-line">{line.quoted ? <em>{text}</em> : text}</span>
                    <span className="srf-next">点击继续</span>
                </button>
            </div>
        </div>
    </dialog>, document.body);
}
