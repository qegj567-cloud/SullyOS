import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DATE_STYLE_PRESETS } from '../../utils/dateStylePresets';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import './dateWriting.css';

const DESCRIPTIONS: Record<string, string> = {
    cinematic: '像电影镜头一样，用动作、光影和现场声响带出情绪。',
    plain: '干净克制、少修饰，把没说出口的心意留在日常小事里。',
    lyrical: '细写流动的心绪，温柔有余韵，酸涩时也不过分煽情。',
    playful: '吐槽、互怼和意外笑点接连出现，轻快中带着护短。',
    intense: '情绪浓烈、心理贴近，让欲言又止和失态更有分量。',
    syrup: '从熟稔的日常、笨拙的郑重和不自觉的偏爱里透出甜意。',
    dark_comedy: '用一本正经的语气写荒诞事，黑暗与好笑并存。',
    suspense: '阴冷气氛、细节疑点和悬念慢慢积累，平静里藏着不安。',
    drama: '对白里有试探和较量，选择有代价，关系与局势一起变化。',
    slice_of_life: '想到哪儿聊到哪儿，有碎碎念、有接话，像熟人在身边闲聊。',
};

export default function DateStylePicker({ value, onChange, compact = false, dark = false }: {
    value?: string; onChange: (id: string) => void; compact?: boolean; dark?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const selected = DATE_STYLE_PRESETS.find(style => style.id === value) || DATE_STYLE_PRESETS[0];
    const trigger = useRef<HTMLButtonElement>(null);
    return <>
        <button ref={trigger} type="button" aria-label={compact ? '选择陪伴文风' : '本次写作风格'} aria-haspopup="dialog" aria-expanded={open}
            data-style-value={selected.id} className={compact ? 'date-entry__style-trigger' : 'date-writing__style-trigger'} onClick={() => setOpen(true)}>
            {compact ? selected.label : <span><strong>{selected.label}</strong><small>{selected.title.split(' · ').slice(1).join(' · ')}</small></span>}
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m8 5 5 5-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {open && <StyleDialog selectedId={selected.id} dark={dark} onSelect={id => { onChange(id); setOpen(false); }} onClose={() => setOpen(false)} restoreFocus={() => trigger.current?.focus({ preventScroll: true })} />}
    </>;
}

function StyleDialog({ selectedId, dark, onSelect, onClose, restoreFocus }: {
    selectedId: string; dark: boolean; onSelect: (id: string) => void; onClose: () => void; restoreFocus: () => void;
}) {
    const panel = useRef<HTMLDivElement>(null);
    const restore = useRef(restoreFocus);
    const [query, setQuery] = useState('');
    const searchable = (text: string) => text.toLowerCase().replace(/日式/g, '日系').replace(/文学|文风|风格/g, '').trim();
    const styles = DATE_STYLE_PRESETS.filter(style => searchable(`${style.title} ${style.hint}`).includes(searchable(query)));
    useLocalBackHandler(() => { onClose(); return true; }, 70);
    useEffect(() => {
        panel.current?.focus({ preventScroll: true });
        const selected = panel.current?.querySelector<HTMLElement>('[aria-selected="true"]');
        selected?.scrollIntoView?.({ block: 'nearest' });
        return () => restore.current();
    }, []);
    return createPortal(<div className={`date-style-overlay${dark ? ' date-style-overlay--dark' : ''}`} onClick={event => { event.stopPropagation(); onClose(); }}>
        <div ref={panel} role="dialog" aria-modal="true" aria-label="选择写作风格" tabIndex={-1} className="date-style-panel" onClick={event => event.stopPropagation()} onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
            if (event.key !== 'Tab') return;
            const fields = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input'));
            const index = fields.indexOf(document.activeElement as HTMLElement);
            if (event.shiftKey && index <= 0) { event.preventDefault(); fields.at(-1)?.focus(); }
            else if (!event.shiftKey && (index < 0 || index === fields.length - 1)) { event.preventDefault(); fields[0]?.focus(); }
        }}>
            <header className="date-style-header"><div><h3>写作风格</h3><p>十套文风，按文学偏好选择</p></div><button type="button" aria-label="关闭文风选择" onClick={onClose}><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg></button></header>
            <input aria-label="搜索文风" className="date-style-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索日式、哥特、日常……" />
            <div role="listbox" aria-label="文风列表" className="date-style-list" onKeyDown={event => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
                const index = options.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
                options[next]?.focus();
            }}>
                {styles.map(style => <button key={style.id} type="button" role="option" aria-selected={style.id === selectedId} aria-label={style.title} data-style-id={style.id} className="date-style-option" onClick={() => onSelect(style.id)}>
                    <span className="date-style-option__title"><strong>{style.label}</strong><span aria-hidden="true">{style.id === selectedId ? '✓' : ''}</span></span>
                    <span className="date-style-option__literature">{style.title.split(' · ').slice(1).join(' · ')}</span>
                    <span className="date-style-option__description">{DESCRIPTIONS[style.id]}</span>
                </button>)}
                {styles.length === 0 && <p role="status" className="date-style-empty">没有匹配的文风，试试其他关键词。</p>}
            </div>
            <p className="date-style-footer">选择即应用，角色设定与人称保持不变。</p>
        </div>
    </div>, document.body);
}
