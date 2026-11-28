import React, { useId } from 'react';
import './dateSettingsControls.css';

export function DateSettingSwitch({ label, checked, onChange, small = false }: {
    label: string; checked: boolean; onChange: (checked: boolean) => void; small?: boolean;
}) {
    return <button type="button" role="switch" aria-label={label} aria-checked={checked}
        className={`date-setting-switch${small ? ' date-setting-switch--small' : ''}`} onClick={() => onChange(!checked)}>
        <span className="date-setting-switch__track" aria-hidden="true"><span className="date-setting-switch__thumb" /></span>
    </button>;
}

/** 标题展开详情，右侧开关独立启停，避免展开设置时误触开关。 */
export function DateFeatureHeader({ title, description, open, onExpand, checked, onChange, switchLabel }: {
    title: string; description: string; open: boolean; onExpand: () => void;
    checked: boolean; onChange: (checked: boolean) => void; switchLabel: string;
}) {
    const descriptionId = useId();
    return <div className="date-feature__header">
        <button type="button" className="date-feature__expand" aria-label={`${open ? '收起' : '展开'}${title}`} aria-expanded={open} aria-describedby={descriptionId} onClick={onExpand}>
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className={`date-feature__chevron${open ? ' is-open' : ''}`}><path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="date-feature__text"><span className="date-feature__title">{title}</span><span id={descriptionId} className="date-feature__description">{description}</span></span>
        </button>
        <DateSettingSwitch label={switchLabel} checked={checked} onChange={onChange} />
    </div>;
}
