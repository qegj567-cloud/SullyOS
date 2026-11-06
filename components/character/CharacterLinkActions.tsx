import React, { useEffect, useState } from 'react';
import { listUserSpaces, SESSION_SPACE_ID, isUserSpaceDeleting } from '../../utils/userSpaces';
import { readSpaceStore, inheritSpaceCharacters } from '../../utils/userSpaceData';
import { openSpaceDB } from '../../utils/db';
import type { CharacterProfile, CharacterGroup } from '../../types';
import { useOS } from '../../context/OSContext';
import { sortCharacterGroups, filterCharactersByGroup, GROUP_FILTER_UNGROUPED } from './CharacterGroupFilter';
import TokenImg from '../os/TokenImg';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

export default function CharacterLinkActions({ onCreate }: { onCreate: () => void }) {
    const { addToast } = useOS();
    const spaces = listUserSpaces().filter(s => s.id !== SESSION_SPACE_ID && !isUserSpaceDeleting(s.id));
    const [open, setOpen] = useState(false), [source, setSource] = useState(spaces[0]?.id || '');
    const [chars, setChars] = useState<CharacterProfile[]>([]), [selected, setSelected] = useState<string[]>([]);
    const [groups, setGroups] = useState<CharacterGroup[]>([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    useLocalBackHandler(() => { if (!busy) setOpen(false); return true; }, 60, open);
    useEffect(() => {
        if (!open || !source) return;
        let cancelled = false; setChars([]); setGroups([]); setSelected([]); setError(''); setLoading(true);
        openSpaceDB(source).then(db => Promise.all([readSpaceStore<CharacterProfile>(db, 'characters'), readSpaceStore<CharacterGroup>(db, 'character_groups')])).then(([rows, folders]) => { if (!cancelled) { setChars(rows); setGroups(folders); } }).catch(e => { if (!cancelled) setError(String(e)); }).finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [open, source]);
    const sections = [...sortCharacterGroups(groups).map(g => ({ id: g.id, name: g.name })), { id: GROUP_FILTER_UNGROUPED, name: '未分组' }]
        .map(g => ({ ...g, characters: filterCharactersByGroup(chars, groups, g.id) })).filter(g => g.characters.length);
    const toggle = (ids: string[], checked: boolean) => setSelected(old => checked ? [...new Set([...old, ...ids])] : old.filter(id => !ids.includes(id)));
    return <><div className="shrink-0"><button onClick={onCreate} className="w-full py-4 rounded-3xl border border-dashed border-violet-300/70 text-violet-400 text-sm bg-white/50 hover:bg-white transition-colors flex items-center justify-center gap-2">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>新建链接
    </button>
        {spaces.length > 0 && <div className="text-center mt-1"><button onClick={() => setOpen(true)} className="px-3 py-2 text-xs text-violet-400 hover:text-violet-600 transition-colors">从其他用户载入角色</button></div>}
        </div>
        {open && <div role="dialog" aria-modal="true" aria-label="从其他用户继承角色" className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center p-5">
            <div className="w-full max-w-md bg-white rounded-2xl p-5 space-y-4 max-h-[80vh] overflow-y-auto">
                <h2 className="font-bold">从其他用户继承角色</h2>
                <p className="text-xs text-slate-500 leading-relaxed">继承设定、外观及配置，不继承聊天、记忆和与原用户的相处记录。原角色不受影响，素材共用。</p>
                <select aria-label="来源用户" disabled={busy} value={source} onChange={e => { setSource(e.target.value); setSelected([]); setChars([]); setLoading(true); }} className="w-full p-2 border rounded-xl">{spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                {loading && <p className="text-sm text-slate-400">正在读取角色…</p>}
                {!loading && chars.length > 0 && <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" disabled={busy} checked={selected.length === chars.length} ref={el => { if (el) el.indeterminate = selected.length > 0 && selected.length < chars.length; }} onChange={e => toggle(chars.map(c => c.id), e.target.checked)} />全部选择 <span className="ml-auto text-xs text-slate-400">已选 {selected.length} / {chars.length}</span></label>}
                {sections.map(section => {
                    const count = section.characters.filter(c => selected.includes(c.id)).length;
                    return <section key={section.id} className="border-t border-slate-100 pt-3">
                        <label className="flex items-center gap-2 text-xs font-medium text-slate-500"><input type="checkbox" aria-label={`全选${section.name}`} disabled={busy} checked={count === section.characters.length} ref={el => { if (el) el.indeterminate = count > 0 && count < section.characters.length; }} onChange={e => toggle(section.characters.map(c => c.id), e.target.checked)} />{section.name}<span className="ml-auto">{count} / {section.characters.length}</span></label>
                        {section.characters.map(c => <label key={c.id} className="flex gap-3 items-center py-2 pl-4"><input type="checkbox" disabled={busy} checked={selected.includes(c.id)} onChange={e => toggle([c.id], e.target.checked)} /><TokenImg value={c.avatar} className="w-9 h-9 rounded-full object-cover" /><span>{c.name}</span></label>)}
                    </section>;
                })}
                {!loading && !error && !chars.length && <p className="text-sm text-slate-400">这个空间暂时没有可继承的角色。</p>}
                {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
                <div className="flex gap-3"><button disabled={busy} onClick={() => setOpen(false)} className="flex-1 py-2 rounded-xl bg-slate-100">取消</button><button disabled={busy || loading || !selected.length} className="flex-1 py-2 rounded-xl bg-primary text-white disabled:opacity-40" onClick={async () => {
                    setBusy(true); setError('');
                    try { await inheritSpaceCharacters(source, selected); addToast('角色已继承', 'success'); window.location.reload(); }
                    catch (e) { setError(e instanceof Error ? e.message : '继承失败'); setBusy(false); }
                }}>{busy ? '正在继承…' : `继承 ${selected.length} 位`}</button></div>
            </div>
        </div>}</>;
}
