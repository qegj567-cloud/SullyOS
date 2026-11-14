import React, { useState } from 'react';
import type { CharacterProfile } from '../../types';

interface Props {
    presets: NonNullable<CharacterProfile['dateExtraPresets']>;
    value: string;
    onApply: (content: string) => void;
    onChange: (presets: NonNullable<CharacterProfile['dateExtraPresets']>) => void;
}

export default function DateExtraPresets({ presets, value, onApply, onChange }: Props) {
    const [selected, setSelected] = useState('');
    const [name, setName] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const current = presets.find(preset => preset.id === selected);
    return <div className="space-y-2 mb-3">
        <select aria-label="自定义补充预设" value={current?.id || ''} onChange={event => {
            const preset = presets.find(item => item.id === event.target.value);
            setSelected(preset?.id || ''); setName(preset?.name || ''); setConfirmDelete(false);
            if (preset) onApply(preset.content);
        }} className="w-full min-w-0 px-3 py-2 bg-slate-100 text-slate-800 rounded-xl text-sm">
            <option value="">选择已保存的补充预设</option>
            {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
        <div className="flex gap-2">
            <input aria-label="补充预设名称" placeholder="预设名称，如：日常、冒险" value={name}
                onChange={event => setName(event.target.value)} className="min-w-0 flex-1 px-3 py-2 bg-slate-100 text-slate-800 placeholder:text-slate-400 rounded-xl text-sm" />
            <button type="button" disabled={!name.trim() || !value.trim()} onClick={() => {
                const preset = { id: crypto.randomUUID(), name: name.trim(), content: value.trim() };
                onChange([...presets, preset]); setSelected(preset.id); setConfirmDelete(false);
            }} className="shrink-0 px-3 py-2 rounded-xl bg-slate-800 text-white text-xs disabled:opacity-40">存为新预设</button>
        </div>
        {current && <div className="flex flex-wrap gap-3 text-xs text-slate-500">
            <button type="button" disabled={!name.trim() || !value.trim()} onClick={() => {
                onChange(presets.map(preset => preset.id === current.id ? { ...preset, name: name.trim(), content: value.trim() } : preset));
                setConfirmDelete(false);
            }} className="disabled:opacity-40">更新所选预设</button>
            <button type="button" onClick={() => {
                if (!confirmDelete) { setConfirmDelete(true); return; }
                onChange(presets.filter(preset => preset.id !== current.id)); setSelected(''); setName(''); setConfirmDelete(false);
            }}>{confirmDelete ? '确认删除预设（保留当前补充）' : '删除预设'}</button>
        </div>}
        <p className="text-[10px] text-slate-400">预设保存在当前角色中；选择即应用，修改正文后可更新预设或另存一份。</p>
    </div>;
}
