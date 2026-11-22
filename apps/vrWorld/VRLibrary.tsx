import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, Plus, X } from '@phosphor-icons/react';
import type { CharacterProfile, VRLibraryCategory, VRWorldCharState, VRWorldNovelSummary } from '../../types';
import { novelReadingMode, readingPreferenceLabel, type LibraryEdit } from '../../utils/vrWorld/library';
import { getBookmark } from '../../utils/vrWorld/novel';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import './vr-library.css';

export function LibraryView({ novels, categories, characters, onOpen, onAdd, onDelete, onEdit, onPreference }: {
    novels: VRWorldNovelSummary[]; categories: VRLibraryCategory[]; characters: CharacterProfile[];
    onOpen: (book: VRWorldNovelSummary) => void; onAdd: (categoryId?: string) => void; onDelete: (id: string) => Promise<void>;
    onEdit: (edit: LibraryEdit) => Promise<void>; onPreference: (char: CharacterProfile) => void;
}) {
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    const [filter, setFilter] = useState('all'), [query, setQuery] = useState('');
    const [manage, setManage] = useState(false), [organize, setOrganize] = useState(false);
    const [selected, setSelected] = useState<string[]>([]), [target, setTarget] = useState('');
    const [name, setName] = useState(''), [rename, setRename] = useState('');
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [page, setPage] = useState(0);
    const [readerQuery, setReaderQuery] = useState('');
    const categoryMap = useMemo(() => new Map(categories.map(c => [c.id, c.name])), [categories]);
    const filtered = novels.filter(n => (filter === 'all' || (filter === 'uncategorized' ? !categoryMap.has(n.categoryId || '') : n.categoryId === filter)) && `${n.title} ${n.author || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const pages = Math.max(1, Math.ceil(filtered.length / 12)), currentPage = Math.min(page, pages - 1);
    const visible = filtered.slice(currentPage * 12, currentPage * 12 + 12);
    const readers = characters.filter(c => c.name.toLocaleLowerCase().includes(readerQuery.trim().toLocaleLowerCase()));
    async function run(action: () => Promise<void>) {
        if (busy) return;
        setBusy(true); setError('');
        try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试'); }
        finally { setBusy(false); }
    }
    return <section className="vr-library" aria-label="彼方书库">
        <header className="vrl-heading"><div><small>KANATA · LIBRARY</small><h2>把喜欢的书，放在一起</h2><p>{novels.length} 本藏书 · 每个人都有自己的书签与批注</p></div><button className="vrl-primary" onClick={() => onAdd(categoryMap.has(filter) ? filter : undefined)}><Plus size={17}/> 上架</button></header>
        <div className="vrl-tools"><input aria-label="搜索书库" placeholder="搜索书名或作者" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }}/><button aria-pressed={manage} onClick={() => setManage(!manage)}>分类</button><button aria-pressed={organize} onClick={() => { setOrganize(!organize); setSelected([]); }}>整理</button></div>
        <nav className="vrl-categories" aria-label="书籍分类">
            {[{id:'all',name:'全部'}, {id:'uncategorized',name:'未分类'}, ...categories].map(c => <button key={c.id} aria-pressed={filter === c.id} onClick={() => { setFilter(c.id); setPage(0); }}>{c.name}<small>{c.id === 'all' ? novels.length : novels.filter(n => c.id === 'uncategorized' ? !categoryMap.has(n.categoryId || '') : n.categoryId === c.id).length}</small></button>)}
        </nav>
        {manage && <section className="vrl-manage" aria-label="管理书籍分类"><p>重命名不会改变角色的阅读偏好。移除分类会把书放回未分类。</p><form onSubmit={e => { e.preventDefault(); void run(async () => { await onEdit(rename ? {kind:'rename',id:rename,name} : {kind:'create',id:crypto.randomUUID(),name}); setName(''); setRename(''); }); }}><input aria-label="分类名称" placeholder="如：网文、严肃文学" value={name} maxLength={24} onChange={e => setName(e.target.value)}/><button disabled={busy || !name.trim()}>{rename ? '保存名称' : '新建分类'}</button>{rename && <button type="button" onClick={() => {setRename('');setName('');}}>取消</button>}</form>
            {categories.map(c => <div className="vrl-category-row" key={c.id}><span>{c.name}</span><button disabled={busy} onClick={() => {setRename(c.id);setName(c.name);}}>重命名</button><button disabled={busy} onClick={async () => {if (busy) return; if (!await requestConfirm({ title: `移除分类「${c.name}」？`, message: '该分类下的书籍会恢复为未分类。', confirmText: '移除分类' })) return; await run(async () => {await onEdit({kind:'remove',id:c.id}); if(filter === c.id)setFilter('uncategorized'); if(rename === c.id){setRename('');setName('');} if(target === c.id)setTarget('');});}}>移除分类</button></div>)}
        </section>}
        {organize && <section className="vrl-organize" aria-label="批量整理书籍"><div><span>已选 {selected.length} 本</span><button onClick={() => setSelected(s => [...new Set([...s,...visible.map(n => n.id)])])}>选择本页</button><button onClick={() => setSelected([])}>清空</button></div><div><select aria-label="移入分类" value={target} onChange={e => setTarget(e.target.value)}><option value="">未分类</option>{categories.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select><button className="vrl-primary" disabled={busy || !selected.length} onClick={() => void run(async () => {await onEdit({kind:'assign',novelIds:selected,categoryId:target || undefined});setSelected([]);})}>移入分类</button></div></section>}
        {error && <p role="alert" className="vrl-error">{error}</p>}
        <div className="vrl-books">
            {!visible.length && <p className="vrl-empty">{novels.length ? '这里还没有书，换个分类或搜索词试试。' : '上架第一本书，等角色在页边留下批注。'}</p>}
            {visible.map(n => { const reading = characters.filter(c => getBookmark(c.vrState?.novelBookmarks,n.id) > 0); return <article key={n.id} className="vrl-book">
                {organize ? <input type="checkbox" aria-label={`选择《${n.title}》`} checked={selected.includes(n.id)} onChange={e => setSelected(s => e.target.checked ? [...s,n.id] : s.filter(id => id !== n.id))}/> : <BookOpen size={24} weight="light"/>}
                <div className="vrl-book-copy"><button className="vrl-book-title" onClick={() => onOpen(n)}>{n.title}</button><p>{n.author || '佚名'} · {categoryMap.get(n.categoryId || '') || '未分类'}</p><small>{n.totalChars.toLocaleString()} 字{reading.length ? ` · ${reading.map(c => c.name).slice(0,3).join('、')}${reading.length > 3 ? ` 等 ${reading.length} 人` : ''}读过` : ' · 等待翻开'}</small></div>
                {organize ? <button className="vrl-delete" disabled={busy} onClick={async () => {if (busy) return; if (!await requestConfirm({ title: `下架《${n.title}》？`, message: '这本书连同所有批注都会一并删除，无法恢复。', confirmText: '下架' })) return; await run(async () => {await onDelete(n.id);setSelected(s => s.filter(id => id !== n.id));});}}>下架</button> : <button aria-label={`阅读《${n.title}》的批注`} onClick={() => onOpen(n)}>翻开</button>}
            </article>; })}
        </div>
        {pages > 1 && <div className="vrl-pagination"><button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pages}</span><button disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>下一页</button></div>}
        <details className="vrl-readers"><summary>谁来读这些书 <span>角色阅读偏好</span></summary><p>选择分类后，新归入的书也会自动进入 ta 的阅读范围。</p><input aria-label="查找阅读角色" placeholder="查找角色" value={readerQuery} onChange={e => setReaderQuery(e.target.value)}/><div className="vrl-reader-list">{readers.map(c => <button key={c.id} onClick={() => onPreference(c)}><span>{c.name}</span><small>{readingPreferenceLabel(c)} ›</small></button>)}{!readers.length && <p>没有找到角色。</p>}</div></details>
        {confirmDialog}
    </section>;
}

type Preference = Pick<VRWorldCharState,'novelReadingMode'|'preferredNovelIds'|'preferredNovelCategoryIds'>;
export function NovelPreferenceModal({char,novels,categories,onClose,onSave}:{char:CharacterProfile;novels:VRWorldNovelSummary[];categories:VRLibraryCategory[];onClose:()=>void;onSave:(preference:Preference)=>void}) {
    const panel = useRef<HTMLElement>(null);
    useEffect(() => {
        const previous = document.activeElement;
        panel.current?.querySelector<HTMLButtonElement>('header button')?.focus();
        return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({preventScroll:true}); };
    }, []);
    const [mode,setMode] = useState(novelReadingMode(char));
    const [books,setBooks] = useState(char.vrState?.preferredNovelIds || []);
    const [chosen,setChosen] = useState(char.vrState?.preferredNovelCategoryIds || []);
    const [query,setQuery] = useState(''), [page,setPage] = useState(0);
    const list = mode === 'books' ? novels.filter(n => `${n.title} ${n.author || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [];
    const pages = Math.max(1,Math.ceil(list.length / 18)), p = Math.min(page,pages-1);
    const toggle = (id:string,values:string[],setter:(values:string[])=>void) => setter(values.includes(id) ? values.filter(x=>x!==id) : [...values,id]);
    const missing = chosen.filter(id=>!categories.some(c=>c.id===id));
    return <div className="vrl-modal-backdrop" onClick={onClose} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();onClose();}}}><section ref={panel} className="vrl-modal vr-library" role="dialog" aria-modal="true" aria-label={`${char.name}的阅读偏好`} onClick={e=>e.stopPropagation()} onKeyDown={e=>{
        if(e.key!=='Tab')return;
        const items=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select')||[]).filter(el=>el.getClientRects().length);
        const target=e.shiftKey?items.at(-1):items[0];
        if(document.activeElement===(e.shiftKey?items[0]:items.at(-1))){e.preventDefault();target?.focus();}
    }}>
        <header><div><small>READING PREFERENCES</small><h2>{char.name} 的阅读偏好</h2></div><button aria-label="关闭阅读偏好" onClick={onClose}><X size={20}/></button></header>
        <nav className="vrl-modes" aria-label="阅读方式">{(['all','categories','books'] as const).map(value=><button key={value} aria-pressed={mode===value} onClick={()=>setMode(value)}>{{all:'全部轮换',categories:'按分类',books:'逐本优先'}[value]}</button>)}</nav>
        <main>
            <p className="vrl-hint">{mode==='categories' ? '只在所选分类里轮换，新归入的书自动加入。读完后在这些分类内重读；没有书时暂停阅读。' : mode==='books' ? '先读选中的书；读完后再从全书库轮换。' : '在全书库轮换阅读，每本书保留独立书签。'}</p>
            {mode==='categories' && <><div className="vrl-preference-list">{categories.map(c=><button key={c.id} aria-pressed={chosen.includes(c.id)} onClick={()=>toggle(c.id,chosen,setChosen)}><span className="vrl-check">{chosen.includes(c.id)&&<Check size={14}/>}</span><span>{c.name}</span><small>{novels.filter(n=>n.categoryId===c.id).length} 本</small></button>)}</div>{!categories.length && <p className="vrl-empty">先去书库新建分类，再把书整理进去。</p>}{missing.length>0 && <p className="vrl-hint">有 {missing.length} 个已移除的分类。<button onClick={()=>setChosen(chosen.filter(id=>!missing.includes(id)))}>清除失效选择</button></p>}{!chosen.length && <p className="vrl-hint">还没选分类，保存后将暂停阅读，直到你选择分类。</p>}</>}
            {mode==='books' && <><input aria-label="搜索偏好书目" placeholder="搜索书名或作者" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/><div className="vrl-preference-list">{list.slice(p*18,p*18+18).map(n=><button key={n.id} aria-pressed={books.includes(n.id)} onClick={()=>toggle(n.id,books,setBooks)}><span className="vrl-check">{books.includes(n.id)&&<Check size={14}/>}</span><span>{n.title}</span></button>)}</div>{pages>1 && <div className="vrl-pagination"><button disabled={!p} onClick={()=>setPage(p-1)}>上一页</button><span>{p+1} / {pages}</span><button disabled={p===pages-1} onClick={()=>setPage(p+1)}>下一页</button></div>}</>}
        </main>
        <footer><button onClick={()=>setMode('all')}>恢复全部轮换</button><button className="vrl-primary" onClick={()=>onSave({novelReadingMode:mode,preferredNovelIds:books,preferredNovelCategoryIds:chosen})}>保存偏好</button></footer>
    </section></div>;
}
