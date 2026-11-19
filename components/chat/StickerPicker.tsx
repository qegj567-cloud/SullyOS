import React, { useId, useMemo, useRef, useState } from 'react';
import { CaretDown, Check, MagnifyingGlass } from '@phosphor-icons/react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

type Option = { id: string; name: string; detail?: string; groupId?: string };
type Props = {
    label: string;
    searchLabel: string;
    options: Option[];
    groups?: Option[];
    value: string;
    disabled?: boolean;
    onChange: (id: string) => void;
};

const pageSize = 30;

/** Both directories use vertical, searchable pages, including the role-group filter. */
export default function StickerPicker({ label, searchLabel, options, groups, value, disabled, onChange }: Props) {
    const [view, setView] = useState<'closed' | 'items' | 'groups'>('closed');
    const [query, setQuery] = useState(''), [groupQuery, setGroupQuery] = useState('');
    const [filter, setFilter] = useState(''), [page, setPage] = useState(0);
    const trigger = useRef<HTMLButtonElement>(null), listId = useId();
    const choosingGroup = view === 'groups';
    const search = choosingGroup ? groupQuery : query;
    const matches = useMemo(() => {
        const term = search.trim().toLocaleLowerCase();
        const candidates = choosingGroup ? (groups || []) : options;
        return candidates.filter(item =>
            (choosingGroup || !filter || item.groupId === filter) &&
            (item.name.toLocaleLowerCase().includes(term) || !!item.detail?.toLocaleLowerCase().includes(term))
        );
    }, [options, groups, search, filter, choosingGroup]);
    const pages = Math.max(1, Math.ceil(matches.length / pageSize));
    const current = Math.min(page, pages - 1);
    const selected = options.find(item => item.id === value);
    function close() {
        setView('closed');
        trigger.current?.focus();
    }
    function back() {
        if (choosingGroup) { setView('items'); setPage(0); }
        else close();
        return true;
    }
    useLocalBackHandler(back, 46, view !== 'closed');
    return <div className="st-picker" onKeyDown={event => {
        if (event.key === 'Escape' && view !== 'closed' && !event.nativeEvent.isComposing) {
            event.stopPropagation(); event.preventDefault(); back();
        }
    }}>
        <button type="button" ref={trigger} className="st-picker-trigger" disabled={disabled}
            aria-label={label + '，' + (selected?.name || '请选择')} aria-controls={view !== 'closed' ? listId : undefined}
            aria-expanded={view !== 'closed'} onClick={() => {
                if (view !== 'closed') { close(); return; }
                setQuery(''); setGroupQuery(''); setFilter(''); setPage(0); setView('items');
            }}>
            <span><small>{label}</small><strong>{selected?.name || '请选择'}</strong></span><CaretDown />
        </button>
        {view !== 'closed' && <div className="st-picker-panel" id={listId}>
            <label className="st-search">
                <MagnifyingGlass aria-hidden="true" />
                <input key={view} autoFocus type="search" aria-label={choosingGroup ? '搜索角色分组' : searchLabel}
                    placeholder={choosingGroup ? '搜索角色分组' : searchLabel} value={search}
                    onChange={event => { (choosingGroup ? setGroupQuery : setQuery)(event.target.value); setPage(0); }} />
            </label>
            {groups && <button className="st-picker-filter" type="button" onClick={() => {
                setGroupQuery(''); setPage(0); setView(choosingGroup ? 'items' : 'groups');
            }}>{choosingGroup ? '返回角色列表' : '按分组筛选 · ' + (groups.find(g => g.id === filter)?.name || '全部角色')}</button>}
            <div className="st-picker-list" key={view + current + search + filter} aria-label={choosingGroup ? '角色分组' : label}>
                {matches.slice(current * pageSize, (current + 1) * pageSize).map(item => {
                    const active = item.id === (choosingGroup ? filter : value);
                    return <button key={item.id} type="button" aria-pressed={active} onClick={() => {
                        if (choosingGroup) { setFilter(item.id); setPage(0); setQuery(''); setView('items'); }
                        else { onChange(item.id); close(); }
                    }}>
                        <span>{item.name}</span>{item.detail && <small>{item.detail}</small>}{active && <Check aria-hidden="true" />}
                    </button>;
                })}
                {!matches.length && <p role="status">没有找到匹配项</p>}
            </div>
            {pages > 1 && <div className="st-foot">
                <button type="button" disabled={!current} onClick={() => setPage(current - 1)}>上一页</button>
                <span>{current + 1} / {pages}</span>
                <button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页</button>
            </div>}
        </div>}
    </div>;
}
