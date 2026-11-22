import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Star, X } from '@phosphor-icons/react';

interface VoiceFavoriteActionSheetProps {
    open: boolean;
    favorited: boolean;
    busy?: boolean;
    title?: string;
    preview?: string;
    onToggle: () => void;
    onClose: () => void;
}

const VoiceFavoriteActionSheet: React.FC<VoiceFavoriteActionSheetProps> = ({
    open,
    favorited,
    busy = false,
    title = '语音消息',
    preview,
    onToggle,
    onClose,
}) => {
    const [confirmingUnfavorite, setConfirmingUnfavorite] = useState(false);

    useEffect(() => {
        setConfirmingUnfavorite(false);
    }, [open, favorited, title, preview]);

    if (!open) return null;
    return createPortal(
        <div className="fixed inset-0 z-[1800] flex items-end justify-center bg-black/45 px-3 pb-[max(12px,env(safe-area-inset-bottom))]" onClick={onClose}>
            <div className="w-full max-w-md rounded-[26px] border border-white/60 bg-[#f8f6f1] p-3 text-slate-800 shadow-2xl animate-slide-up" onClick={event => event.stopPropagation()}>
                <div className="flex items-start gap-3 px-2 pt-1 pb-3">
                    <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-bold tracking-[.12em] text-slate-400">{title}</p>
                        {preview && <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-slate-600">{preview}</p>}
                    </div>
                    <button type="button" onClick={onClose} className="w-8 h-8 grid place-items-center rounded-full text-slate-400 active:bg-black/5" aria-label="关闭"><X size={17} /></button>
                </div>
                {favorited && confirmingUnfavorite ? (
                    <div className="space-y-2">
                        <p className="px-2 text-center text-[11px] text-slate-500">取消后若原音频已清理，收藏记录将一并移除。</p>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => setConfirmingUnfavorite(false)}
                                className="flex-1 min-h-12 rounded-2xl bg-slate-200/80 text-slate-700 text-sm font-bold transition-colors disabled:opacity-50"
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                    setConfirmingUnfavorite(false);
                                    onToggle();
                                }}
                                className="flex-1 min-h-12 rounded-2xl flex items-center justify-center gap-2 bg-rose-500 text-white text-sm font-bold transition-colors disabled:opacity-50"
                            >
                                <Star size={18} weight="fill" />
                                确认取消收藏语音
                            </button>
                        </div>
                    </div>
                ) : (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                            if (favorited) {
                                setConfirmingUnfavorite(true);
                                return;
                            }
                            onToggle();
                        }}
                        className={`w-full min-h-12 rounded-2xl flex items-center justify-center gap-2 text-sm font-bold transition-colors disabled:opacity-50 ${favorited ? 'bg-amber-100 text-amber-800' : 'bg-slate-800 text-white'}`}
                    >
                        <Star size={18} weight={favorited ? 'fill' : 'regular'} />
                        {busy ? '正在保存音频…' : favorited ? '取消收藏语音' : '收藏语音'}
                    </button>
                )}
            </div>
        </div>,
        document.body,
    );
};

export default VoiceFavoriteActionSheet;
