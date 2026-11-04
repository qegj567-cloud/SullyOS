import React, { useEffect, useRef, useState } from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import type { BeautyKind } from '../../utils/beautyShareContract';
import { normalizeBeautyPackage, readBeautyPackage } from '../../utils/beautyShareClient';
import BeautyPresetPreview from './BeautyPresetPreview';
import type { BeautySource } from './BeautySharePanel';
import { BEAUTY_CATEGORIES, type BeautyCategory } from '../../utils/beautyCategories';
import './BeautyPresetPicker.css';

interface Props { sources: BeautySource[]; source: string; file: File | null; kind: BeautyKind; onSource: (id: string) => void; onFile: (file: File | null) => void; allowFile?:boolean; onPreview?: (pack:unknown|null)=>void }
export default function BeautyPresetPicker({ sources, source, file, kind, onSource, onFile,allowFile=true,onPreview }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [category, setCategory] = useState<BeautyCategory>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const categoriesOf = (item: BeautySource) => item.categories || [item.kind === 'appearance' || !item.kind && kind === 'appearance' ? 'appearance' : 'chat'];
  const categories = BEAUTY_CATEGORIES.filter(([id]) => id === 'all' || sources.some(item => categoriesOf(item).includes(id)));
  const matches = sources.filter(item => (category === 'all' || categoriesOf(item).includes(category)) && item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pageCount = Math.max(1, Math.ceil(matches.length / 12));
  const currentPage = Math.min(page, pageCount - 1);
  const close = () => { dialog.current?.close(); opener.current?.focus(); };
  useLocalBackHandler(() => { if (!dialog.current?.open) return false; close(); return true; }, 60);
  const choose = (id: string) => { onSource(id); close(); };
  const [pack, setPack] = useState<unknown>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const selected = sources.find(s => s.id === source);
  const reader = useRef(selected?.read);
  reader.current = selected?.read;
  const previewListener=useRef(onPreview);
  previewListener.current=onPreview;
  const [refresh, setRefresh] = useState(0);
  // A stable selection key avoids re-exporting 20 MB on every metadata keystroke.
  useEffect(() => {
    let alive = true; setPack(null); setError(''); previewListener.current?.(null);
    if (source === 'file' && !file || source !== 'file' && !reader.current) { setLoading(false); return; }
    setLoading(true);
    const read = reader.current;
    const load = source === 'file' ? readBeautyPackage(file!, kind) : Promise.resolve().then(() => read!());
    load.then(value => { if (alive) {const normalized=normalizeBeautyPackage(value, kind);setPack(normalized);previewListener.current?.(normalized);} }).catch(e => { if (alive) setError(e instanceof Error ? e.message : '预览读取失败'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [source, file, kind, selected?.id, selected?.revision, refresh]);
  return <section>
    <div className="beauty-preset-source"><span>分享的作品</span><button ref={opener} type="button" onClick={() => dialog.current?.showModal()}><span>{selected?.name || '选择已保存的预设'}</span><span aria-hidden="true">›</span></button>{allowFile&&<button type="button" onClick={() => onSource('file')}>上传预设文件</button>}</div>
    <dialog ref={dialog} className="beauty-preset-dialog" aria-labelledby="beauty-preset-dialog-title" onCancel={event => { event.preventDefault(); close(); }}>
      <header><div><h2 id="beauty-preset-dialog-title">选择预设</h2><p>从本机收藏中选一份作品</p></div><button className="beauty-preset-close" type="button" aria-label="关闭预设选择" onClick={close}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      <input className="beauty-preset-search" autoFocus type="search" aria-label="搜索已保存的预设" placeholder="搜索预设名称" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}/>
      <nav aria-label="预设分类">{categories.map(([id,label]) => <button type="button" key={id} aria-pressed={category === id} onClick={() => { setCategory(id); setPage(0); }}>{label}</button>)}</nav>
      <div className="beauty-preset-results"><p className="beauty-preset-count">共 {matches.length} 份预设 · 选择后查看完整预览</p>
        {matches.slice(currentPage * 12, currentPage * 12 + 12).map(item => <button type="button" className="beauty-preset-row" key={item.id} onClick={() => choose(item.id)}><span className="beauty-preset-symbol" aria-hidden="true">{categoriesOf(item).includes('appearance') ? '◈' : '◇'}</span><span><strong>{item.name}</strong><small>{categoriesOf(item).filter(id => id !== 'chat' || categoriesOf(item).length === 1).map(id => BEAUTY_CATEGORIES.find(([key]) => key === id)?.[1]).filter(Boolean).join(' · ')}</small></span><span className="beauty-preset-select">{item.id === source ? '已选' : '选择'}</span></button>)}
        {!matches.length && <p className="beauty-preset-empty">{query ? '没有找到这个名字，试试其他关键词。' : '这里还没有保存的预设。'}</p>}
      </div>
      <footer><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span aria-live="polite">{currentPage + 1} / {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></footer>
    </dialog>
    {source === 'file' && <label>预设文件（JSON / ZIP / PNG）<input type="file" accept=".json,.zip,.png" onChange={e => onFile(e.target.files?.[0] || null)}/></label>}
    {selected && <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新预览</button>}
    {loading && <p role="status">正在载入预设预览…</p>}{error && <p role="alert">{error}</p>}{!!pack && <BeautyPresetPreview data={pack}/>}
  </section>;
}
