import React, { useState } from 'react';
import { trackEvent } from '../../utils/analytics';

interface ErrorDialogProps {
    isOpen: boolean;
    title: string;
    details: string;
    onClose: () => void;
}

// 全局错误弹窗：toast 一行装不下的长报错走这里 —— 多行 monospace 预览框 + 复制按钮,
// 手机上没法开 console 时, 用户能直接看清、长按复制原文反馈过来。
const ErrorDialog: React.FC<ErrorDialogProps> = ({ isOpen, title, details, onClose }) => {
    const [copied, setCopied] = useState(false);

    if (!isOpen) return null;

    const handleCopy = async () => {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(details);
            } else {
                // iOS 旧版 PWA / 非 HTTPS 场景 clipboard API 可能缺失, fallback 到 execCommand
                const ta = document.createElement('textarea');
                ta.value = details;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
            trackEvent('复制报错详情', { 复制结果: '成功' });
        } catch {
            setCopied(false);
            trackEvent('复制报错详情', { 复制结果: '失败' });
        }
    };

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 animate-fade-in" style={{ zIndex: 10000 }}>
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
            <div className="relative bg-white text-slate-800 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden animate-pop-in">
                <div className="p-5 pb-3">
                    <div className="flex gap-3 items-start">
                        <div className="w-10 h-10 rounded-full bg-red-50 text-red-500 flex items-center justify-center shrink-0">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                            </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 className="text-base font-bold text-slate-800 leading-6 break-words">{title}</h3>
                        </div>
                    </div>
                </div>
                <div className="px-5 pb-3">
                    <pre className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-[11px] leading-relaxed text-slate-700 whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto font-mono select-text">
{details}
                    </pre>
                </div>
                <div className="bg-slate-50 px-5 py-3 flex gap-2 justify-end border-t border-slate-100">
                    <button
                        onClick={handleCopy}
                        className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-600 active:scale-95 transition-transform"
                    >
                        {copied ? '已复制' : '复制'}
                    </button>
                    <button
                        onClick={onClose}
                        className="px-4 py-2 bg-red-500 rounded-xl text-sm font-bold text-white shadow-lg shadow-red-200 active:scale-95 transition-transform"
                    >
                        关闭
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ErrorDialog;
