import React, { useEffect, useRef, useState } from 'react';
import type { CharacterProfile, DateExperienceConfig } from '../../types';
import { CaretLeft, GearSix, SlidersHorizontal } from '@phosphor-icons/react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { trackEvent } from '../../utils/analytics';
import DateExperiencePicker from './DateExperiencePicker';
import DateSettings from './DateSettings';
import Modal from '../os/Modal';
import { DATE_ENTRY_CHOICES, DateFlourish, DateTicketFrame, DateTicketIcon, type DateEntryChoice } from './DateEntryArtwork';
import rainWindow from '../../assets/date/rain-window.jpg';
import './dateEntry.css';

interface Props {
    char: CharacterProfile;
    experience: DateExperienceConfig;
    onExperienceChange: (value: DateExperienceConfig) => void;
    onSaveDefault: () => void | Promise<void>;
    onReset: () => void;
    onBack: () => void;
    onConfirm: (choice: DateEntryChoice) => void | Promise<void>;
}

export default function DateEntryScreen({ char, experience, onExperienceChange, onSaveDefault, onReset, onBack, onConfirm }: Props) {
    const [choice, setChoice] = useState<DateEntryChoice>('approach');
    const [panel, setPanel] = useState<'experience' | 'settings' | null>(null);
    const [entering, setEntering] = useState(false);
    const [error, setError] = useState('');
    const enteringRef = useRef(false);
    const mounted = useRef(true);
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const radios = useRef<(HTMLButtonElement | null)[]>([]);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useLocalBackHandler(() => { if (enteringRef.current) return true; onBack(); return true; }, 20);
    useLocalBackHandler(() => { setPanel(null); return true; }, 60, panel !== null);
    useEffect(() => {
        if (panel !== 'experience') return;
        const dialog = root.current?.querySelector<HTMLElement>('[role="dialog"]');
        const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), select, summary, textarea, input, [tabindex="0"]') || []).filter(el => el.getClientRects().length > 0);
        dialog?.setAttribute('tabindex', '-1'); dialog?.focus();
        const onKey = (e: KeyboardEvent) => {
            // Portaled pickers handle their own keyboard / back navigation.
            if (!(e.target instanceof Node) || !dialog?.contains(e.target)) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPanel(null); }
            if (e.key !== 'Tab') return;
            const items = focusable();
            const first = items[0], last = items[items.length - 1];
            if (!first) { e.preventDefault(); return; }
            if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', onKey, true);
        return () => { document.removeEventListener('keydown', onKey, true); trigger.current?.focus(); };
    }, [panel]);
    const confirm = async () => {
        if (enteringRef.current) return;
        enteringRef.current = true; setEntering(true); setError('');
        try { await onConfirm(choice); }
        catch { if (mounted.current) setError('进入失败，请重试'); }
        finally { if (mounted.current) { enteringRef.current = false; setEntering(false); } }
    };
    const current = DATE_ENTRY_CHOICES.find(item => item.id === choice)!;
    if (panel === 'settings') return <DateSettings char={char} experience={experience} onExperienceChange={onExperienceChange} onBack={() => setPanel(null)} />;
    return <div ref={root} className="date-entry" style={{ '--date-entry-photo': `url("${rainWindow}")` } as React.CSSProperties}>
        <div className="date-entry__photo" aria-hidden="true" />
        <div className="date-entry__scroll">
            <main className={`date-entry__canvas${entering ? ' is-entering' : ''}`}>
                <header className="date-entry__header">
                    <button type="button" aria-label="返回" onClick={onBack} disabled={entering}><CaretLeft size={25} weight="thin" /></button>
                    <div className="date-entry__masthead"><span aria-hidden="true" /><h1>见面</h1><span aria-hidden="true" /></div>
                    <button type="button" aria-label="打开见面设置" disabled={entering} onClick={() => { setPanel('settings'); trackEvent('打开见面设置面板', { from: 'entry' }); }}><GearSix size={25} weight="thin" /></button>
                </header>
                <div className="date-entry__identity"><div className="date-entry__name"><h2 title={char.name}>{char.name}</h2></div><DateFlourish /></div>
                <div className="date-entry__question"><p>这次，怎样见面？</p><DateFlourish /></div>
                <div className="date-entry__tickets" role="radiogroup" aria-label="选择见面方式">
                    {DATE_ENTRY_CHOICES.map((item, index) => <button key={item.id} type="button" role="radio" aria-checked={choice === item.id} aria-label={item.label}
                        tabIndex={choice === item.id ? 0 : -1} ref={el => { radios.current[index] = el; }} disabled={entering}
                        className={`date-ticket${choice === item.id ? ' is-selected' : ''}`}
                        onClick={() => { setChoice(item.id); setError(''); }}
                        onKeyDown={event => {
                            const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
                            if (!direction && event.key !== 'Home' && event.key !== 'End') return;
                            event.preventDefault();
                            const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + direction + 3) % 3;
                            setChoice(DATE_ENTRY_CHOICES[next].id); radios.current[next]?.focus();
                        }}>
                        <DateTicketFrame /><DateTicketIcon choice={item.id} />
                        <span className="date-ticket__title">{item.label}</span>
                        <span className="date-ticket__divider" aria-hidden="true"><i /></span>
                        <span className="date-ticket__detail">{item.detail}</span>
                        <svg className="date-ticket__arrow" viewBox="0 0 18 26" fill="none" aria-hidden="true"><path d="m5 4 9 9-9 9" stroke="currentColor" strokeWidth="1.2" /></svg>
                    </button>)}
                </div>
                <div className="date-entry__confirmation">
                    <button className="date-entry__confirm" type="button" onClick={() => void confirm()} disabled={entering} aria-label="确认进入见面">
                        <span aria-hidden="true">◇</span><span>{entering ? '正在进入…' : '确认进入'}</span><span aria-hidden="true">◇</span>
                    </button>
                    <p aria-live="polite">{error || `已选择 · ${current.label}`}</p>
                </div>
                <footer className="date-entry__controls">
                    <DateExperiencePicker compact dark value={experience} presets={char.dateExtraPresets} onChange={onExperienceChange} />
                    <button ref={trigger} className="date-entry__tune" type="button" onClick={() => { setPanel('experience'); trackEvent('打开陪伴体验设置', { 范围: '本场' }); }}><SlidersHorizontal className="date-entry__control-icon" size={29} weight="thin" aria-hidden="true" /><span className="date-entry__control-divider" aria-hidden="true" /><span className="date-entry__control-label">场景与微调</span><svg className="date-entry__tune-arrow" viewBox="0 0 10 18" fill="none" aria-hidden="true"><path d="m1 1 8 8-8 8" stroke="currentColor" strokeWidth=".8" /></svg></button>
                </footer>
            </main>
        </div>
        <Modal isOpen={panel === 'experience'} title="本次体验 · 场景与微调" onClose={() => setPanel(null)} className="date-entry__dialog">
            <DateExperiencePicker value={experience} presets={char.dateExtraPresets} onChange={onExperienceChange}
                hidePreset onSaveDefault={onSaveDefault} onReset={onReset} />
        </Modal>
    </div>;
}
