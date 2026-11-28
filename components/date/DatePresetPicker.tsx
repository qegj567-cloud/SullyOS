import React, { useId, useRef, useState } from 'react';
import type { DateExperiencePreset } from '../../types';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

/** 同一份角色预设在设置与入口使用相同的选择面板。 */
export default function DatePresetPicker({ presets, value, onSelect, label, placeholder, dark = false }: {
    presets: DateExperiencePreset[]; value?: string; onSelect: (id: string) => void;
    label: string; placeholder: string; dark?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const id = useId();
    const trigger = useRef<HTMLButtonElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const selected = presets.find(preset => preset.id === value);
    const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
    useLocalBackHandler(() => { close(); return true; }, 70, open);
    return <div onKeyDown={event => {
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
        <button ref={trigger} type="button" aria-label={label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox"
            className={`w-full min-h-12 flex items-center gap-3 px-3 py-3 rounded-xl border text-sm text-left ${dark ? 'bg-neutral-900 text-white border-white/20' : 'bg-slate-100 text-slate-800 border-slate-200'}`}
            onClick={() => {
                if (open) close(); else { setOpen(true); requestAnimationFrame(() => (list.current?.querySelector<HTMLElement>('[aria-selected="true"]') || list.current?.querySelector<HTMLElement>('[role="option"]'))?.focus()); }
            }}>
            <span className="min-w-0 flex-1 break-words">{selected?.name || placeholder}</span>
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className={`w-4 h-4 shrink-0 ${open ? 'rotate-180' : ''}`}><path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.3" /></svg>
        </button>
        {open && <div id={id} ref={list} role="listbox" aria-label={`${label}列表`}
            className={`mt-2 max-h-64 overflow-y-auto rounded-xl border p-1 ${dark ? 'bg-neutral-900 text-white border-white/20' : 'bg-white text-slate-800 border-slate-200'}`}
            onKeyDown={event => {
                if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
                const index = options.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
                options[next]?.focus();
            }}>
            {presets.length ? presets.map(preset => <button type="button" role="option" key={preset.id} data-preset-id={preset.id} aria-label={preset.name} aria-selected={preset.id === selected?.id}
                onClick={() => { onSelect(preset.id); close(); }}
                className={`w-full min-h-12 flex items-center gap-3 rounded-lg px-3 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400 ${preset.id === selected?.id ? dark ? 'bg-white/10' : 'bg-slate-100' : dark ? 'hover:bg-white/5' : 'hover:bg-slate-50'}`}>
                <span className="flex-1 min-w-0"><span className="block text-sm break-words">{preset.name}</span><span className={`block mt-1 text-[11px] ${dark ? 'text-white/60' : 'text-slate-500'}`}>{preset.experience ? '完整体验预设' : '仅补充要求'}</span></span>
                {preset.id === selected?.id && <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="w-4 h-4 shrink-0"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </button>) : <p className={`px-3 py-4 text-xs leading-relaxed ${dark ? 'text-white/60' : 'text-slate-500'}`}>还没有预设，可在下方命名并存为新预设。</p>}
        </div>}
    </div>;
}
