import React, { useEffect, useId, useRef, useState } from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import './settingsSelect.css';

export default function SettingsSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string; description?: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const gesture = useRef({ x: 0, y: 0, moved: false });
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [position, setPosition] = useState<React.CSSProperties>({});
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useLocalBackHandler(() => { close(); return true; }, 70, open);
  const show = () => {
    const rect = trigger.current!.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop || 0;
    const bottom = top + (viewport?.height || window.innerHeight);
    const width = Math.min(Math.max(rect.width, 224), window.innerWidth - 24);
    const below = bottom - rect.bottom - 12;
    const above = rect.top - top - 12;
    const down = below >= Math.min(260, options.length * 52 + 12) || below >= above;
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width,
      top: down ? rect.bottom + 6 : undefined,
      bottom: down ? undefined : window.innerHeight - rect.top + 6,
      maxHeight: Math.max(80, Math.min(300, down ? below : above)) });
    setIndex(Math.max(0, options.findIndex(option => option.value === value)));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    menu.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(false); };
    const resize = () => close();
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize); };
  }, [open]);
  useEffect(() => {
    if (open) menu.current?.children[index]?.scrollIntoView?.({ block: 'nearest' });
  }, [index, open]);
  const choose = (next: string) => { onChange(next); close(); };
  return <div ref={root} className="settings-select" data-settings-select-open={open || undefined}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button ref={trigger} type="button" className="settings-select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : show()} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); } }}>
      <span>{options.find(option => option.value === value)?.label || '请选择'}</span>
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="m6 8 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && <div ref={menu} id={id} role="listbox" aria-label={label} aria-activedescendant={`${id}-${index}`} tabIndex={0}
      className="settings-select-menu" style={position}
      onPointerDown={event => { gesture.current = { x: event.clientX, y: event.clientY, moved: false }; }}
      onPointerMove={event => { if (Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 8) gesture.current.moved = true; }}
      onPointerCancel={() => { gesture.current.moved = true; }}
      onScroll={() => { gesture.current.moved = true; }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          setIndex(current => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
        } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (options[index]) choose(options[index].value); }
      }}>
      {options.map((option, i) => <div key={option.value} id={`${id}-${i}`} role="option" aria-selected={value === option.value}
        data-focused={index === i || undefined} className="settings-select-option" onPointerMove={() => setIndex(i)}
        onPointerDown={event => { if (event.pointerType === 'mouse') event.preventDefault(); }} onClick={event => { if (!gesture.current.moved || event.detail === 0) choose(option.value); }}>
        <span><span className="settings-select-name">{option.label}</span>{option.description && <span className="settings-select-description">{option.description}</span>}</span>
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" style={{ visibility: value === option.value ? 'visible' : 'hidden' }}><path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>)}
    </div>}
  </div>;
}
