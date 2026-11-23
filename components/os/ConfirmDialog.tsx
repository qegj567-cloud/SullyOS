
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

interface ConfirmDialogProps {
    isOpen: boolean;
    title: string;
    message: React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'warning' | 'info';
    /** 打开后确认按钮要等这么多秒才能点，用于必须读完的提醒 */
    confirmDelaySeconds?: number;
    /** 是否挂载到 document.body，用于在带 transform 的弹窗或抽屉内突破裁切 */
    portal?: boolean;
    /** 弹窗层级，默认 10000（高于活动浮层与各类全屏抽屉） */
    zIndex?: number;
    onConfirm: () => void;
    onCancel: () => void;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
    isOpen,
    title,
    message,
    confirmText = '确认',
    cancelText = '取消',
    variant = 'info',
    confirmDelaySeconds = 0,
    portal = false,
    zIndex = 10000,
    onConfirm,
    onCancel
}) => {
    const [remaining, setRemaining] = useState(confirmDelaySeconds);
    const topLayerRef = useRef<HTMLDialogElement | null>(null);
    const onCancelRef = useRef(onCancel);
    onCancelRef.current = onCancel;
    const needsTopLayer = Boolean(
        portal && isOpen && typeof document !== 'undefined'
        && document.querySelector('dialog[open]:not([data-sully-confirm-top-layer])'),
    );
    // 每次打开都从头倒数；用 layout effect 赶在绘制前重置，免得上次的 0 让按钮闪一帧可点
    useLayoutEffect(() => {
        setRemaining(isOpen ? confirmDelaySeconds : 0);
    }, [isOpen, confirmDelaySeconds]);
    useLayoutEffect(() => {
        const el = topLayerRef.current;
        if (!el || !isOpen || !needsTopLayer) return;
        if (!el.open) {
            if (typeof el.showModal === 'function') {
                try { el.showModal(); } catch { el.setAttribute('open', ''); }
            } else {
                el.setAttribute('open', '');
            }
        }
        return () => {
            try {
                if (el.open && typeof el.close === 'function') el.close();
                else el.removeAttribute('open');
            } catch {}
        };
    }, [isOpen, needsTopLayer]);
    useEffect(() => {
        if (!isOpen || remaining <= 0) return;
        const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
        return () => clearTimeout(timer);
    }, [isOpen, remaining]);
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            onCancelRef.current();
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [isOpen]);
    useLocalBackHandler(() => {
        onCancel();
        return true;
    }, 120, isOpen);

    if (!isOpen) return null;
    const locked = remaining > 0;

    const getBtnColor = () => {
        switch (variant) {
            case 'danger': return 'bg-red-500 hover:bg-red-600 text-white shadow-red-200';
            case 'warning': return 'bg-orange-500 hover:bg-orange-600 text-white shadow-orange-200';
            default: return 'bg-indigo-500 hover:bg-indigo-600 text-white shadow-indigo-200';
        }
    };

    const getIcon = () => {
        switch (variant) {
            case 'danger': 
                return (
                    <div className="w-10 h-10 rounded-full bg-red-50 text-red-500 flex items-center justify-center shrink-0">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                        </svg>
                    </div>
                );
            case 'warning':
                return (
                    <div className="w-10 h-10 rounded-full bg-orange-50 text-orange-500 flex items-center justify-center shrink-0">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
                        </svg>
                    </div>
                );
            default:
                return (
                    <div className="w-10 h-10 rounded-full bg-indigo-50 text-indigo-500 flex items-center justify-center shrink-0">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                        </svg>
                    </div>
                );
        }
    };

    const dialogNode = (
        <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fade-in"
            style={{ zIndex }}
        >
            <div className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity" onClick={onCancel}></div>
            {/* 限高 + 正文内滚：长提醒在小屏上也看得到底部按钮 */}
            <div className="sully-system-ui relative bg-white text-slate-800 rounded-2xl shadow-2xl w-full max-w-sm max-h-full flex flex-col overflow-hidden animate-pop-in transform transition-all">
                <div className="p-6 min-h-0 overflow-y-auto">
                    <div className="flex gap-4">
                        {getIcon()}
                        <div className="flex-1">
                            <h3 className="text-lg font-bold text-slate-800 leading-6 mb-2">{title}</h3>
                            <div className="text-sm text-slate-500 leading-relaxed">{message}</div>
                        </div>
                    </div>
                </div>
                {/* 按钮文字不折行；窄屏放不下两个时整颗换到下一行，而不是把「先不开」劈成两行 */}
                <div className="shrink-0 bg-slate-50 px-6 py-4 flex flex-wrap gap-3 justify-end border-t border-slate-100">
                    <button 
                        onClick={onCancel}
                        className="px-4 py-2 whitespace-nowrap bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-50 transition-colors"
                    >
                        {cancelText}
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={locked}
                        className={`px-4 py-2 whitespace-nowrap rounded-xl text-sm font-bold shadow-lg transition-transform active:scale-95 disabled:opacity-50 disabled:active:scale-100 ${getBtnColor()}`}
                    >
                        {locked ? `${confirmText}（${remaining}）` : confirmText}
                    </button>
                </div>
            </div>
        </div>
    );

    if (portal && typeof document !== 'undefined' && document.body) {
        if (needsTopLayer) {
            return createPortal(
                <dialog
                    ref={topLayerRef}
                    data-sully-confirm-top-layer="true"
                    role="presentation"
                    onCancel={(e) => { e.preventDefault(); onCancel(); }}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                        margin: 0,
                        padding: 0,
                        border: 0,
                        background: 'transparent',
                        maxWidth: 'none',
                        maxHeight: 'none',
                        width: '100vw',
                        height: '100dvh',
                        inset: 0,
                        overflow: 'visible',
                    }}
                >
                    <style>{'dialog[data-sully-confirm-top-layer]::backdrop{background:transparent;}'}</style>
                    {dialogNode}
                </dialog>,
                document.body,
            );
        }
        return createPortal(dialogNode, document.body);
    }
    return dialogNode;
};

export default ConfirmDialog;
