import React from 'react';
import type { ChatTranslationMode } from '../../utils/chatTranslationStyle';

export default function TranslationStylePicker({ value, onChange }: {
    value: ChatTranslationMode;
    onChange?: (value: ChatTranslationMode) => void;
}) {
    return <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-1 text-[11px] font-semibold text-slate-500">译文显示</legend>
        <div className="divide-y divide-slate-100">
            {([
                ['collapsed', '点击切换', '默认收起译文，点「译」切换。'],
                ['bubble', '同时展开', '原文、译文都放在气泡里。'],
                ['subtitle', '外挂字幕', '译文贴在原文下方，不撑大气泡。'],
            ] as const).map(([id, label, detail]) => (
                <label key={id} className="flex min-h-11 cursor-pointer items-center gap-2 py-2 text-[11px]">
                    <input type="radio" name="chat-translation-style" value={id} checked={value === id}
                        onChange={() => onChange?.(id)} aria-label={label} className="h-3.5 w-3.5 shrink-0 accent-primary" />
                    <span className="min-w-0"><span className={value === id ? 'font-semibold text-primary' : 'text-slate-700'}>{label}</span>
                        <span className="mt-0.5 block text-[10px] leading-normal text-slate-400">{detail}</span></span>
                </label>
            ))}
        </div>
    </fieldset>;
}
