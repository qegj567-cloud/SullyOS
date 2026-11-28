import React, { useEffect, useState } from 'react';
import { FilmSlate } from '@phosphor-icons/react';
import type { DateExperienceConfig, DateExperiencePreset } from '../../types';
import DateStylePicker from './DateStylePicker';
import DatePresetPicker from './DatePresetPicker';
import { trackEvent } from '../../utils/analytics';
import { applyDateExperiencePreset, DATE_TONE_PRESETS, savedDatePresetExperience } from '../../utils/dateExperience';

interface Props {
    value: DateExperienceConfig;
    presets?: DateExperiencePreset[];
    onChange: (value: DateExperienceConfig) => void;
    onSaveDefault?: () => void | Promise<void>;
    onReset?: () => void;
    dark?: boolean;
    detailed?: boolean;
    compact?: boolean;
    hidePreset?: boolean;
    hideExtras?: boolean;
    children?: React.ReactNode;
}

/** 入口与设置复用；这里只改体验字段，不接管人称、语音或显示偏好。 */
export default function DateExperiencePicker({ value, presets = [], onChange, onSaveDefault, onReset, dark = false, detailed = true, compact = false, hidePreset = false, hideExtras = false, children }: Props) {
    const sceneId = React.useId();
    const extraId = React.useId();
    const [confirmDefault, setConfirmDefault] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const field = `w-full min-w-0 rounded-xl px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-violet-400 ${dark ? 'bg-neutral-900 text-white [color-scheme:dark] [&_option]:bg-neutral-900 [&_option]:text-white' : 'bg-slate-100 text-slate-800 [color-scheme:light]'}`;
    const patch = (part: Partial<DateExperienceConfig>) => { setConfirmDefault(false); onChange({ ...value, ...part }); };
    useEffect(() => setConfirmDefault(false), [value]);
    const tone = DATE_TONE_PRESETS.find(p => p.id === value.tone) || DATE_TONE_PRESETS[0];
    const applyPreset = (selected: string) => {
        const preset = presets.find(p => p.id === selected);
        if (preset) {
            setConfirmDefault(false); onChange(applyDateExperiencePreset(value, { ...preset, experience: savedDatePresetExperience(preset) }));
            trackEvent('应用陪伴体验预设', { 来源: preset.experience ? '自定义体验' : '旧补充' });
        }
    };
    if (compact) {
        return <div className="date-entry__preset"><FilmSlate className="date-entry__control-icon" size={29} weight="thin" aria-hidden="true" /><span className="date-entry__control-divider" aria-hidden="true" /><span className="date-entry__control-label">本次文风</span><span className="date-entry__select-wrap">
            <svg className="date-entry__select-frame" viewBox="0 0 180 32" preserveAspectRatio="none" fill="none" aria-hidden="true"><path d="M12 1H169L179 16L169 31H12C-2 31-2 1 12 1Z" fill="currentColor" fillOpacity=".12" stroke="currentColor" strokeOpacity=".7" strokeWidth=".7" /></svg>
            <DateStylePicker value={value.style} onChange={style => patch({ style })} compact dark={dark} />
        </span></div>;
    }
    return <div className={`date-writing${dark ? ' date-writing--dark' : ''}`}>
        <section className="date-writing__group">
            <label className="date-writing__heading" htmlFor={sceneId}>场景 · 在哪里，做什么</label>
            <textarea id={sceneId} aria-label="陪伴场景描述" value={value.sceneSeed || ''} onChange={e => patch({ sceneSeed: e.target.value })} placeholder="例如：雨夜，在书房一起挑一部电影。" rows={3} className={`${field} resize-y`} />
            <p className="date-writing__hint">留空沿用当前场景，不替你预设行动。</p>
        </section>
        <section className="date-writing__group" aria-label="陪伴互动基调">
            <h4 className="date-writing__heading">相处氛围 · 怎样相处</h4>
            <div className="date-writing__choices">{DATE_TONE_PRESETS.map(p => <button type="button" key={p.id} className="date-writing__choice" aria-pressed={tone.id === p.id} onClick={() => patch({ tone: p.id })}>{p.label}</button>)}</div>
            <p className="date-writing__hint">{tone.hint}</p>
        </section>
        {detailed && <section className="date-writing__group"><h4 className="date-writing__heading">文风 · 怎样写</h4><DateStylePicker value={value.style} onChange={style => patch({ style })} dark={dark} /></section>}
        {detailed && !hideExtras && <section className="date-writing__group">
            <label className="date-writing__heading" htmlFor={extraId}>补充要求 · 还有什么偏好</label>
            <textarea id={extraId} aria-label="本次陪伴补充" value={value.extra || ''} onChange={e => patch({ extra: e.target.value })} rows={3} className={`${field} resize-y`} placeholder="例如：多些对白，少写心理活动。" />
            <label className="flex items-center gap-2 text-xs py-3"><input type="checkbox" checked={value.digDeeper !== false} onChange={e => patch({ digDeeper: e.target.checked })} />细节深挖引导</label>
        </section>}
        {children}
        {!hidePreset && presets.length > 0 && <details className="py-3"><summary className="cursor-pointer text-xs">应用我的预设</summary>
            <DatePresetPicker label="选择陪伴体验" presets={presets} onSelect={applyPreset} placeholder="选择已保存的预设…" dark={dark} />
        </details>}
        {onSaveDefault && <div className="space-y-2 border-t border-current/10 pt-3">
            <p className="text-[11px] opacity-60 leading-relaxed">只用于这一场；人称、语音与观测保持原设置。</p>
            <div className="flex flex-wrap gap-3 text-xs">
                {onReset && <button type="button" disabled={saving} onClick={() => { setConfirmDefault(false); onReset(); }} className="min-h-10 underline underline-offset-4">恢复角色默认</button>}
                <button type="button" disabled={saving} className="min-h-10 underline underline-offset-4 disabled:opacity-40" onClick={async () => {
                    if (!confirmDefault) { setConfirmDefault(true); return; }
                    setSaving(true); setError('');
                    try { await onSaveDefault(); setConfirmDefault(false); } catch { setError('保存失败，请重试'); } finally { setSaving(false); }
                }}>{saving ? '正在保存…' : confirmDefault ? '确认覆盖角色默认体验' : '设为角色默认'}</button>
            </div>
            {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        </div>}
    </div>;
}
