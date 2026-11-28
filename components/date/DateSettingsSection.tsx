import React from 'react';

/** 可折叠分区卡片：标题常驻，内容默认收起，点标题展开。用原生 <details> 省状态。 */
const DateSettingsSection: React.FC<{ title: string; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void; children: React.ReactNode }> = ({ title, defaultOpen, onOpenChange, children }) => (
    <details open={defaultOpen} onToggle={event => onOpenChange?.(event.currentTarget.open)} className="group bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <summary className="list-none cursor-pointer select-none flex items-center justify-between gap-2 px-4 py-3.5 active:bg-slate-50 [&::-webkit-details-marker]:hidden">
            <h3 className="text-xs font-bold text-slate-400 uppercase">{title}</h3>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-slate-300 transition-transform group-open:rotate-180 shrink-0"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" /></svg>
        </summary>
        <div className="px-4 pb-4 pt-1">{children}</div>
    </details>
);

export default DateSettingsSection;
