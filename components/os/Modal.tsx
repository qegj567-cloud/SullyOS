
import React from 'react';

interface ModalProps {
    isOpen: boolean;
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    footer?: React.ReactNode;
}

const Modal: React.FC<ModalProps> = ({ isOpen, title, onClose, children, footer }) => {
    if (!isOpen) return null;

    return (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-[100] flex items-center justify-center p-6 animate-fade-in" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 1rem)', paddingBottom: 'calc(var(--safe-bottom, 0px) + 1rem)', maxHeight: 'var(--visual-viewport-height, 100dvh)' }}>
            <div className="absolute inset-0 bg-black/40" onClick={onClose} />
            <div className="relative w-full max-w-sm max-h-full flex flex-col min-h-0 bg-white text-slate-800 rounded-[2.5rem] shadow-2xl border border-white/20 overflow-hidden animate-slide-up">
                <div className="px-6 pt-6 pb-2 shrink-0">
                    <h3 className="text-lg font-bold text-slate-800 text-center">{title}</h3>
                </div>
                <div className="px-6 py-4 min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain no-scrollbar">
                    {children}
                </div>
                {footer ? (
                    <div className="px-6 pb-6 flex gap-3 shrink-0">
                        {footer}
                    </div>
                ) : (
                    <div className="px-6 pb-6 shrink-0">
                        <button 
                            onClick={onClose}
                            className="w-full py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            关闭
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Modal;
