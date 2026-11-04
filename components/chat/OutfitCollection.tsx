import type {WardrobeUsageReader} from '../../utils/wardrobeUsage';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import type {WardrobeEntry} from '../appearance/BeautyWardrobe';
import DecorationPresetThumb from './DecorationPresetThumb';
import './OutfitCollection.css';
const PAGE_SIZE=6;
export default function OutfitCollection({getUsage,entries,busy,error,onClose,onChoose,onDelete,onSave}:{getUsage?:WardrobeUsageReader;entries:WardrobeEntry[];busy:boolean;error:string;onClose:()=>void;onChoose:(entry:WardrobeEntry)=>void;onDelete:(entry:WardrobeEntry)=>void;onSave:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),results=useRef<HTMLDivElement>(null);const [query,setQuery]=useState('');const [page,setPage]=useState(0);
 const matches=useMemo(()=>entries.filter(entry=>entry.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),[entries,query]);
 const pages=Math.max(1,Math.ceil(matches.length/PAGE_SIZE));const current=Math.min(page,pages-1);
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 useEffect(()=>{setPage(current);if(results.current)results.current.scrollTop=0;},[current,query]);
 return <dialog ref={dialog} className="outfit-collection" aria-labelledby="outfit-collection-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
  <header><div><h2 id="outfit-collection-title">搭配收藏</h2><p>选中后先预览，喜欢再应用。</p></div><button disabled={busy} aria-label="关闭搭配收藏" onClick={onClose}>×</button></header>
  <div className="outfit-collection-tools"><input type="search" aria-label="搜索搭配收藏" placeholder="搜索搭配名称" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/><button disabled={busy} onClick={onSave}>保存当前搭配</button></div>
  <div className="outfit-collection-count" role="status">{query.trim()?`找到 ${matches.length} 套`:`共 ${entries.length} 套`} · 每页 {PAGE_SIZE} 套</div>
  <div className="outfit-collection-results" ref={results}>{matches.slice(current*PAGE_SIZE,(current+1)*PAGE_SIZE).map(entry=><article key={entry.id}><DecorationPresetThumb getUsage={getUsage} entry={entry} category="whitebox" disabled={busy} onChoose={()=>onChoose(entry)}/><button className="outfit-collection-delete" disabled={busy} aria-label={`删除搭配 ${entry.name}`} onClick={()=>onDelete(entry)}>删除</button></article>)}{!matches.length&&<p className="outfit-collection-empty">{query.trim()?'没有找到这套搭配，换个名称试试。':'还没有收藏。把当前喜欢的组合保存下来吧。'}</p>}</div>
  {error&&<p role="alert">{error}</p>}
  <footer><button disabled={busy||current===0} onClick={()=>setPage(current-1)}>上一页</button><label><select aria-label="跳转到搭配页" disabled={busy||pages===1} value={current} onChange={event=>setPage(Number(event.target.value))}>{Array.from({length:pages},(_,index)=><option key={index} value={index}>第 {index+1} / {pages} 页</option>)}</select></label><button disabled={busy||current===pages-1} onClick={()=>setPage(current+1)}>下一页</button></footer>
 </dialog>;
}
