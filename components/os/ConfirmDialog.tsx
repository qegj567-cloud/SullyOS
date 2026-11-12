
import React from 'react';

interface ConfirmDialogProps {
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'warning' | 'info';
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
    onConfirm, 
    onCancel 
}) => {
    if (!isOpen) return null;

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

    return (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fade-in" style={{ zIndex: 9999 }}>
            <div className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity" onClick={onCancel}></div>
            <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden animate-pop-in transform transition-all">
                <div className="p-6">
                    <div className="flex gap-4">
                        {getIcon()}
                        <div className="flex-1">
                            <h3 className="text-lg font-bold text-slate-800 leading-6 mb-2">{title}</h3>
                            <p className="text-sm text-slate-500 leading-relaxed">{message}</p>
                        </div>
                    </div>
                </div>
                <div className="bg-slate-50 px-6 py-4 flex gap-3 justify-end border-t border-slate-100">
                    <button 
                        onClick={onCancel}
                        className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-50 transition-colors"
                    >
                        {cancelText}
                    </button>
                    <button 
                        onClick={onConfirm}
                        className={`px-4 py-2 rounded-xl text-sm font-bold shadow-lg transition-transform active:scale-95 ${getBtnColor()}`}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ConfirmDialog;
