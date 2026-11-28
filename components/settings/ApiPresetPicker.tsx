import React, { useEffect, useRef, useState } from 'react';
import type { ApiPreset } from '../../types';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import './apiPresets.css';
import SettingsSelect from './SettingsSelect';

export default function ApiPresetPicker({ presets, activePresetId, children }: {
  presets: ApiPreset[];
  activePresetId?: string | null;
  children: (preset: ApiPreset, close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const active = presets.find(p => p.id === activePresetId);
  const groupOf = (preset: ApiPreset) => preset.group?.trim() || '未分组';
  const groups = [...new Set(presets.map(groupOf))].sort((a, b) =>
    a === b ? 0 : a === '未分组' ? 1 : b === '未分组' ? -1 : a.localeCompare(b, 'zh-CN', { numeric: true }));
  const filtered = presets.filter(p => (!group || groupOf(p) === group) &&
    p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => groups.indexOf(groupOf(a)) - groups.indexOf(groupOf(b)) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  const close = () => setOpen(false);
  const back = () => {
    if (document.activeElement === search.current) { search.current?.blur(); dialog.current?.focus(); }
    else close();
    return true;
  };
  useLocalBackHandler(back, 60, open);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    element.showModal();
    element.focus();
    return () => { element.close(); trigger.current?.focus({ preventScroll: true }); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="api-preset-trigger" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setQuery(''); setGroup(''); setOpen(true); }}>
      <span className="api-preset-trigger-label">当前预设</span>
      <span className="api-preset-trigger-value">{active ? `${groupOf(active)} · ${active.name}` : '自定义配置 · 选择预设'}</span>
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.5" /></svg>
    </button>
    {open && <dialog ref={dialog} tabIndex={-1} autoFocus className="api-preset-dialog api-preset-library" aria-labelledby="api-preset-title"
      onKeyDownCapture={event => { if (event.key === 'Escape' && !(event.target as HTMLElement).closest('[data-settings-select-open]')) { event.preventDefault(); event.stopPropagation(); back(); } }}
      onCancel={event => { event.preventDefault(); back(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="api-preset-sheet" onPointerDown={event => {
        if (document.activeElement === search.current && event.target !== search.current) search.current?.blur();
      }}>
        <header><h3 id="api-preset-title">选择预设 <span>{presets.length}</span></h3><button type="button" onClick={close}>关闭</button></header>
        <p id="api-preset-help" className="api-preset-help">（点选立即引用）（长按进行编辑）</p>
        <div className="api-preset-tools">
          <label className="api-preset-search"><span className="sr-only">搜索全部预设</span>
            <input ref={search} type="search" value={query} placeholder="搜索预设名称" onChange={event => { setQuery(event.target.value); setGroup(''); }}
              onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { search.current?.blur(); dialog.current?.focus(); } }} />
          </label>
          <div className="api-preset-filter">
            <SettingsSelect label="分组" value={group} onChange={setGroup} options={[{ value: '', label: '全部分组' }, ...groups.map(name => ({ value: name, label: name }))]} />
          </div>
        </div>
        <div className="api-preset-results" key={`${query}:${group}`}>
          {filtered.map(preset => <div key={preset.id} className="api-preset-row">{children(preset, close)}</div>)}
          {!filtered.length && <p className="api-preset-empty" role="status">没有匹配的预设</p>}
        </div>
      </div>
    </dialog>}
  </>;
}
