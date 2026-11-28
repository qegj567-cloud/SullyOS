import React, { useEffect, useState } from 'react';
import type { CharacterProfile, DateExperienceConfig } from '../../types';
import { trackEvent } from '../../utils/analytics';
import DatePresetPicker from './DatePresetPicker';
import { savedDatePresetExperience } from '../../utils/dateExperience';

interface Props {
    presets: NonNullable<CharacterProfile['dateExtraPresets']>;
    value: string;
    onApply: (content: string, experience?: DateExperienceConfig) => void;
    experience?: DateExperienceConfig;
    onChange: (presets: NonNullable<CharacterProfile['dateExtraPresets']>) => void;
}

export default function DateExtraPresets({ presets, value, onApply, onChange, experience }: Props) {
    const [selected, setSelected] = useState('');
    const [name, setName] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [confirmUpdate, setConfirmUpdate] = useState(false);
    useEffect(() => { setConfirmUpdate(false); }, [value, experience]);
    const current = presets.find(preset => preset.id === selected);
    return <div className="space-y-2 mb-3">
        <DatePresetPicker label="自定义补充预设" presets={presets} value={current?.id}
            placeholder={experience ? '选择已保存的体验／补充预设' : '选择已保存的补充预设'} onSelect={id => {
            const preset = presets.find(item => item.id === id);
            setSelected(preset?.id || ''); setName(preset?.name || ''); setConfirmDelete(false); setConfirmUpdate(false);
            if (preset) {
                onApply(preset.content, savedDatePresetExperience(preset));
                trackEvent('应用陪伴体验预设', { 来源: preset.experience ? '自定义体验' : '旧补充' });
            }
        }} />
        <div className="flex gap-2">
            <input aria-label="补充预设名称" placeholder="预设名称，如：日常、冒险" value={name}
                onChange={event => { setName(event.target.value); setConfirmUpdate(false); }} className="min-w-0 flex-1 px-3 py-2 bg-slate-100 text-slate-800 placeholder:text-slate-400 rounded-xl text-sm" />
            <button type="button" disabled={!name.trim() || (!experience && !value.trim())} onClick={() => {
                const preset = { id: crypto.randomUUID(), name: name.trim(), content: value.trim(), ...(experience ? { experience: { ...experience, extra: value.trim() } } : {}) };
                onChange([...presets, preset]); setSelected(preset.id); setConfirmDelete(false); setConfirmUpdate(false);
            }} className="shrink-0 px-3 py-2 rounded-xl bg-slate-800 text-white text-xs disabled:opacity-40">存为新预设</button>
        </div>
        {current && <div className="flex flex-wrap gap-3 text-xs text-slate-500">
            <button type="button" disabled={!name.trim() || (!experience && !value.trim())} onClick={() => {
                if (!confirmUpdate) { setConfirmUpdate(true); setConfirmDelete(false); return; }
                onChange(presets.map(preset => preset.id === current.id ? { ...preset, name: name.trim(), content: value.trim(), ...(experience ? { experience: { ...experience, extra: value.trim() } } : {}) } : preset));
                setConfirmUpdate(false); setConfirmDelete(false);
            }} className="disabled:opacity-40">{confirmUpdate ? '确认覆盖所选预设' : '更新所选预设'}</button>
            <button type="button" onClick={() => {
                if (!confirmDelete) { setConfirmDelete(true); setConfirmUpdate(false); return; }
                onChange(presets.filter(preset => preset.id !== current.id)); setSelected(''); setName(''); setConfirmDelete(false); setConfirmUpdate(false);
            }}>{confirmDelete ? '确认删除预设（保留当前补充）' : '删除预设'}</button>
        </div>}
        <p className="text-[10px] text-slate-400">{experience ? '新预设保存文风、基调、深挖、场景与补充；旧预设仍只应用补充。人称等个人偏好不随预设改变。' : '预设保存在当前角色中；选择即应用，修改正文后可更新预设或另存一份。'}</p>
    </div>;
}
