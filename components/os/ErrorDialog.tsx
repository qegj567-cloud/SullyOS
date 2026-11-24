import React, { useEffect, useState } from 'react';
import { trackEvent } from '../../utils/analytics';
import { cleanErrorStack } from '../../utils/errorSelfCheck';
import { formatDiagnosticTimestamp, readCompactBuildString, redactRelayTokensInText } from '../../utils/networkRequestSource';

interface ErrorDialogProps {
    isOpen: boolean;
    title: string;
    details: string;
    advice?: import('../../utils/errorSelfCheck').ErrorAdvice;
    onClose: () => void;
}

// 全局错误弹窗：toast 一行装不下的长报错走这里 —— 主说明清晰展示在前，压缩混淆栈默认折叠在后；
// 复制按钮同时附带标题、自检建议与构建版本号，并在剪贴板 API 被拒时自动降级到 execCommand 与手动复制。
const ErrorDialog: React.FC<ErrorDialogProps> = ({ isOpen, title, details, advice, onClose }) => {
    const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');

    useEffect(() => {
        setCopyState('idle');
    }, [isOpen, title, details]);

    if (!isOpen) return null;

    const safeTitle = redactRelayTokensInText(String(advice?.title ?? title));
    const cleanedDetails = cleanErrorStack(redactRelayTokensInText(String(details || '')));
    const lines = cleanedDetails.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const primarySummary = lines[0]?.replace(/^Error:\s*/i, '') || '发生未知错误';
    const hasTechnicalTrace = lines.length > 1 || Boolean(advice);

    const buildCopyPayload = () => {
        const parts = [
            `[${safeTitle}]`,
            ...(advice?.action ? [redactRelayTokensInText(advice.action)] : []),
            `版本: ${readCompactBuildString()} · 时间: ${formatDiagnosticTimestamp(Date.now())}`,
            '',
            cleanedDetails,
        ];
        return parts.join('\n');
    };

    const handleCopy = async () => {
        const textToCopy = buildCopyPayload();
        let ok = false;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(textToCopy);
                ok = true;
            }
        } catch {
            ok = false;
        }
        if (!ok) {
            const ta = document.createElement('textarea');
            ta.value = textToCopy;
            ta.setAttribute('readonly', 'true');
            ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
            document.body.appendChild(ta);
            try {
                ta.focus();
                ta.select();
                ok = document.execCommand('copy');
            } catch {
                ok = false;
            } finally {
                ta.remove();
            }
        }
        if (ok) {
            setCopyState('copied');
            setTimeout(() => setCopyState(prev => (prev === 'copied' ? 'idle' : prev)), 1500);
            trackEvent('复制报错详情', { 复制结果: '成功' });
        } else {
            setCopyState('manual');
            trackEvent('复制报错详情', { 复制结果: '失败' });
        }
    };

    return (
        <div className="sully-system-ui fixed inset-0 z-[110] flex items-center justify-center p-4 animate-fade-in" style={{ zIndex: 10000 }}>
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
                            <h3 className="text-base font-bold text-slate-800 leading-6 break-words">{safeTitle}</h3>
                        </div>
                    </div>
                </div>
                <div className="px-5 pb-3">
                    <p className="mb-3 text-sm text-slate-700 break-words leading-relaxed">
                        {advice ? advice.action : primarySummary}
                    </p>
                    {copyState === 'manual' && (
                        <p role="status" className="mb-2 text-xs text-amber-700">
                            自动复制受限，请长按下方详情框手动全选复制。
                        </p>
                    )}
                    {hasTechnicalTrace && (
                        <details key={`${cleanedDetails}:${copyState === 'manual'}`} open={copyState === 'manual' ? true : undefined}>
                            <summary className="cursor-pointer text-xs text-slate-500">技术详情</summary>
                            <pre className="mt-1.5 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-[11px] leading-relaxed text-slate-700 whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto font-mono select-text">
                                {copyState === 'manual' ? buildCopyPayload() : cleanedDetails}
                            </pre>
                        </details>
                    )}
                </div>
                <div className="bg-slate-50 px-5 py-3 flex gap-2 justify-end border-t border-slate-100">
                    <button
                        onClick={handleCopy}
                        className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-600 active:scale-95 transition-transform"
                    >
                        {copyState === 'copied' ? '已复制' : copyState === 'manual' ? '请手动复制' : '复制'}
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
