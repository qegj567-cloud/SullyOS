import React from 'react';
import type { ChatTranslationStyle } from '../../utils/chatTranslationStyle';

export default function TranslationStylePicker({ value, onChange }: {
    value: ChatTranslationStyle;
    onChange?: (value: ChatTranslationStyle) => void;
}) {
    return <fieldset className="m-0 min-w-0 border-0 p-0 space-y-2">
        <legend className="text-[11px] font-bold text-slate-600">译文样式</legend>
        <div className="flex gap-2">
            {([['bubble', '气泡内'], ['subtitle', '外挂字幕']] as const).map(([id, label]) => (
                <label key={id} className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${value === id ? 'border-primary text-primary bg-primary-light' : 'border-slate-200 text-slate-500'}`}>
                    <input type="radio" name="chat-translation-style" value={id} checked={value === id}
                        onChange={() => onChange?.(id)} className="accent-primary" />
                    {label}
                </label>
            ))}
        </div>
        <p className="text-[10px] leading-relaxed text-slate-400">
            {value === 'subtitle' ? '白字黑描边，贴着原文末行，可越出气泡并覆盖装饰。' : '译文显示在原文下方，沿用当前气泡样式。'}
        </p>
    </fieldset>;
}
