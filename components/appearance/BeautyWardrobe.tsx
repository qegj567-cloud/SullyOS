import type {WardrobeUsage, WardrobeUsageReader} from '../../utils/wardrobeUsage';
import React, { useEffect, useRef, useState } from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { createPortal } from 'react-dom';
import { DB } from '../../utils/db';
import type { BeautyShare } from '../../utils/beautyShareContract';
import BeautyPresetPreview from '../share/BeautyPresetPreview';
import type { BeautySource } from '../share/BeautySharePanel';
import './BeautyWardrobe.css';
import { BeautyRepoBadge } from '../share/BeautyRepoInvitation';
import {readDecorationOrigin,originLabel,canEditDecoration,type DecorationOrigin} from '../../utils/decorationLibrary';

export interface WardrobeEntry extends BeautySource { attributionKey: () => Promise<string>; contents?: string; readLocal?: () => Promise<unknown> }
interface WardrobeActions {getUsage?:WardrobeUsageReader;onEdit?:(entry:WardrobeEntry)=>void;onExport?:(entry:WardrobeEntry)=>void;onShare?:(entry:WardrobeEntry)=>void;onDelete?:(entry:WardrobeEntry)=>void;onUpdate?:(entry:WardrobeEntry)=>void|Promise<void>}
interface Loaded { pack: unknown; share: BeautyShare | null; origin:DecorationOrigin }

function WardrobeTile({ entry, onOpen, getUsage, ...actions }: WardrobeActions & { entry: WardrobeEntry; onOpen: (entry: WardrobeEntry, loaded?: Loaded) => void }) {
  const tile = useRef<HTMLButtonElement>(null);
  const latest = useRef(entry); latest.current = entry;
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState('');
  useEffect(() => {
    const observer = new IntersectionObserver(items => {
      if (items.some(item => item.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '100px' });
    if (tile.current) observer.observe(tile.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let alive = true; setLoaded(undefined); setError('');
    loadEntry(latest.current).then(value => { if (alive) setLoaded(value); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : '装扮读取失败'); });
    return () => { alive = false; };
  }, [visible, entry.id, entry.revision]);
  const [usage,setUsage]=useState<WardrobeUsage>('');
  useEffect(()=>{let alive=true;setUsage('');if(loaded&&getUsage)void getUsage(loaded.pack).then(value=>{if(alive)setUsage(value);});return()=>{alive=false;};},[loaded,getUsage]);
  return <article className="wardrobe-item"><button ref={tile} type="button" className="wardrobe-tile" onClick={() => onOpen(entry, loaded)} aria-label={`预览 ${entry.name}`}>
    <div className="wardrobe-cover" aria-hidden="true">
      {loaded ? <BeautyPresetPreview data={loaded.pack} compact/> : <span className="wardrobe-placeholder">{error ? '点按重试预览' : '预览载入中'}</span>}
    </div>
    <strong>{entry.name}</strong>{usage&&<span className="wardrobe-usage">{usage}</span>}<span className="wardrobe-credit">{loaded ? `${originLabel(loaded.origin)}${loaded.origin.credit?' · '+loaded.origin.credit:''}${!canEditDecoration(loaded.origin)?' · 禁止二改':''}` : error ? '读取失败 · 可重试或删除' : '正在读取来源'}</span>
  </button>{error&&<p className="wardrobe-credit" role="alert">{error}</p>}<CardActions entry={entry} origin={loaded?.origin} {...actions}/ >{loaded?.share && <BeautyRepoBadge share={loaded.share}/>}</article>;
}

function CardActions({entry,origin,onEdit,onShare,onDelete,onUpdate}:WardrobeActions & {entry:WardrobeEntry;origin?:DecorationOrigin}){
 const [checking,setChecking]=useState(false);
 // Removal only needs the local identity, never a readable preview or author metadata.
 // Unknown permissions must not unlock editing or sharing.
 if(!origin)return onDelete?<div className="wardrobe-card-actions" aria-label={`${entry.name}的操作`}><button className="is-danger" onClick={()=>onDelete(entry)}>删除</button></div>:null;
 if(origin.kind==='builtin')return null;
 return <div className="wardrobe-card-actions" aria-label={`${entry.name}的操作`}>
  {origin.kind==='imported'&&origin.share&&onUpdate&&<button disabled={checking} onClick={async()=>{setChecking(true);try{await onUpdate(entry);}finally{setChecking(false);}}}>{checking?'检查中…':'检查更新'}</button>}
  {onEdit&&<button disabled={!canEditDecoration(origin)} title={!canEditDecoration(origin)?'作者禁止二改':undefined} onClick={()=>onEdit(entry)}>编辑</button>}
  {origin.kind==='self'&&onShare&&<button onClick={()=>onShare(entry)}>分享</button>}
  {onDelete&&<button className="is-danger" onClick={()=>onDelete(entry)}>删除</button>}
 </div>;
}

async function loadEntry(entry: WardrobeEntry): Promise<Loaded> {
  const pack = await (entry.readLocal || entry.read)();
  let share: BeautyShare | null = null;
  try {
    const raw = await DB.getAsset('beauty_source_' + await entry.attributionKey());
    const value = raw ? JSON.parse(raw) : null;
    if (value?.metadata && /^S-[A-F0-9]{12}$/.test(value.code)) share = value;
  } catch { /* An ordinary local preset does not need attribution to work. */ }
  return { pack, share,origin:await readDecorationOrigin(await entry.attributionKey()) };
}

function WardrobeDetail({ entry, initial, onClose, onApply,onEdit,onExport,onShare,onDelete,onUpdate }: WardrobeActions & { entry: WardrobeEntry; initial?: Loaded; onClose: () => void; onApply: (entry: WardrobeEntry) => void;onEdit?:(entry:WardrobeEntry)=>void;onExport?:(entry:WardrobeEntry)=>void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [loaded, setLoaded] = useState(initial);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useLocalBackHandler(() => { onClose(); return true; }, 40);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    if (initial) return;
    let alive = true; setError('');
    loadEntry(entry).then(value => { if (alive) setLoaded(value); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : '预览读取失败'); });
    return () => { alive = false; };
  }, [entry, initial, attempt]);
  const metadata = loaded?.share?.metadata;
  return createPortal(<dialog ref={dialog} className="wardrobe-detail" aria-labelledby="wardrobe-detail-title" onCancel={onClose}>
    <header><button type="button" onClick={onClose} aria-label="返回我的装扮">‹</button><span>装扮预览</span>{loaded?.share ? <BeautyRepoBadge share={loaded.share}/> : <span className="wardrobe-detail-label">本机</span>}</header>
    <div className="wardrobe-detail-scroll">
      <div className="wardrobe-detail-stage">{loaded ? <BeautyPresetPreview data={loaded.pack}/> : error ? <div role="alert"><p>{error}</p><button onClick={() => setAttempt(v => v + 1)}>重新载入</button></div> : <p role="status">正在载入预览…</p>}</div>
      <div className="wardrobe-detail-info"><h2 id="wardrobe-detail-title">{entry.name}</h2><p>{metadata ? `作者 · ${metadata.credit}` : '保存在这台设备上的装扮'}</p>
        {loaded&&<p>{originLabel(loaded.origin)}{!canEditDecoration(loaded.origin)?' · 作者禁止二改，编辑已锁定':''}</p>}
        <CardActions entry={entry} origin={loaded?.origin} onEdit={onEdit?item=>{onClose();onEdit(item);}:undefined} onShare={onShare?item=>{onClose();onShare(item);}:undefined} onUpdate={onUpdate?item=>{onClose();onUpdate(item);}:undefined} onDelete={onDelete?item=>{onClose();onDelete(item);}:undefined}/>
        {entry.contents && <p>会应用：{entry.contents}。按作者提供的完整作品应用。</p>}
        {metadata && <details><summary>作者留言与使用规范</summary>
          {metadata.message && <p className="wardrobe-message">{metadata.message}</p>}
          <p>{metadata.allowRemix ? '允许二改' : '不允许二改'} · {metadata.allowRedistribute ? '允许二次传播' : '不允许二次传播'}</p>
          <p>导出版本：{metadata.exportVersion}</p><p>Repo：{metadata.platforms.join('、')}{metadata.contact && ` · ${metadata.contact}`}</p>
          <p>{metadata.bugFeedback === 'welcome' ? '欢迎反馈 Bug' : 'Bug 请自行修复处理'}</p>
        </details>}
      </div>
    </div>
    <footer><span>应用后查看实际效果</span><button type="button" disabled={!loaded} onClick={() => { onClose(); onApply(entry); }}>立即应用</button></footer>
  </dialog>, document.body);
}

export default function BeautyWardrobe({ entries, getUsage, onApply,onEdit,onExport,onShare,onDelete,onUpdate, searchOpen = false, title = '我的收藏' }: WardrobeActions & { entries: WardrobeEntry[]; onApply: (entry: WardrobeEntry) => void;onEdit?:(entry:WardrobeEntry)=>void;onExport?:(entry:WardrobeEntry)=>void; searchOpen?: boolean; title?: string }) {
  const [query, setQuery] = useState('');
  useEffect(() => { if (!searchOpen) { setQuery(''); setPage(0); } }, [searchOpen]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<{ entry: WardrobeEntry; loaded?: Loaded }>();
  const filtered = entries.filter(entry => entry.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const current = Math.min(page, pages - 1);
  const list = useRef<HTMLDivElement>(null);
  const turnPage = (value: number) => { setPage(value); list.current?.scrollIntoView({ block: 'start' }); };
  return <div ref={list} className="wardrobe-library">
    {searchOpen && <input autoFocus className="wardrobe-search" aria-label="查找本机装扮" placeholder="搜索已收藏的装扮" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }}/ >}
    <div className="wardrobe-list-caption"><h3>{title}</h3><span>本机 · {filtered.length} 款</span></div>
    <div className="wardrobe-grid">{filtered.slice(current * 12, current * 12 + 12).map(entry => <WardrobeTile getUsage={getUsage} key={entry.id} entry={entry} onEdit={onEdit} onShare={onShare} onDelete={onDelete} onUpdate={onUpdate} onOpen={(item, loaded) => setSelected({ entry: item, loaded })}/>)}</div>
    {!filtered.length && <div className="wardrobe-empty"><span>✧</span><h3>{query ? '没有找到这款装扮' : '把喜欢的装扮留在这里'}</h3><p>{query ? '换个名称试试。' : '保存预设、导入文件或用分享码领取后，就能在这里预览和应用。'}</p></div>}
    {pages > 1 && <nav className="wardrobe-pagination" aria-label="本机装扮分页"><button disabled={current === 0} onClick={() => turnPage(current - 1)}>上一页</button><span>{current + 1} / {pages}</span><button disabled={current + 1 === pages} onClick={() => turnPage(current + 1)}>下一页</button></nav>}
    {selected && <WardrobeDetail entry={selected.entry} initial={selected.loaded} onClose={() => setSelected(undefined)} onApply={onApply} onEdit={onEdit} onExport={onExport} onShare={onShare} onDelete={onDelete} onUpdate={onUpdate}/>}
  </div>;
}
