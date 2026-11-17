import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import './thinkingActions.css';

export default function ThinkingActionsMenu({ onCopy, onTranslate, translated, parallel, hasTranslation, onSettings, onClose, busy }: {
    onCopy: () => void; onTranslate?: () => void; translated: boolean; parallel: boolean; hasTranslation: boolean;
    onSettings?: () => void; onClose: () => void; busy: boolean;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    useLocalBackHandler(() => { onClose(); return true; }, 60);
    useLayoutEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const element = dialog.current;
        element?.showModal();
        return () => { element?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
    }, []);
    return createPortal(<dialog ref={dialog} className="thinking-actions" aria-label="心象操作"
        onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
        onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}>
        <p>心象</p>
        <button type="button" onClick={onCopy}>复制全文{parallel ? '（对照）' : translated ? '（译文）' : ''}</button>
        {onTranslate && <button type="button" disabled={busy} onClick={onTranslate}>{busy ? '翻译中…' : translated ? '查看原文' : hasTranslation ? '查看译文' : '翻译成中文'}</button>}
        {onSettings && <button type="button" onClick={onSettings}>心象设置</button>}
        <button type="button" className="thinking-actions-cancel" onClick={onClose}>取消</button>
    </dialog>, document.body);
}
