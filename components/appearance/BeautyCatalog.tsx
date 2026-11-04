import React,{useEffect,useRef,useState} from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import {createPortal} from 'react-dom';
import {BEAUTY_CATEGORIES,belongsInBeautyLibrary,type BeautyCategory} from '../../utils/beautyCategories';
import {shuffleCatalog,type BeautyCatalogEntry} from '../../utils/beautyCatalogContract';
import {BEAUTY_CATALOG_URL,loadBeautyCatalog,loadCatalogPreview,sameCatalogTerms} from '../../utils/beautyCatalogClient';
import {beautyRequest,downloadBeauty} from '../../utils/beautyShareClient';
import type {BeautyShare} from '../../utils/beautyShareContract';
import BeautyPresetPreview from '../share/BeautyPresetPreview';
import './BeautyWardrobe.css';
import './BeautyCatalog.css';

function CatalogDetail({entry,onClose,onReceive}:{entry:BeautyCatalogEntry;onClose:()=>void;onReceive:(pack:unknown,share:BeautyShare)=>Promise<void>}){
  const dialog=useRef<HTMLDialogElement>(null);
  const [pack,setPack]=useState<unknown>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [terms,setTerms]=useState<BeautyShare>(entry),[accepted,setAccepted]=useState(false);
  useLocalBackHandler(()=>{if(!busy)onClose();return true;}, 40);
  useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
  const run=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'操作失败，请重试');}finally{setBusy(false);}};
  return createPortal(<dialog ref={dialog} className="wardrobe-detail" aria-label={entry.metadata.name+'装扮详情'} onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
    <header><button disabled={busy} aria-label="返回装扮库" onClick={onClose}>‹</button><span>装扮预览</span><span className="wardrobe-detail-label">公开作品</span></header>
    <div className="wardrobe-detail-scroll">
      <div className="wardrobe-detail-stage">{pack?<BeautyPresetPreview data={pack}/>:<><img className="catalog-detail-cover" src={BEAUTY_CATALOG_URL+'/'+entry.cover} alt={entry.metadata.name+'封面'}/><button className="catalog-preview-button" disabled={busy} onClick={()=>void run(async()=>setPack(await loadCatalogPreview(entry)))}>交互预览</button></>}</div>
      <div className="wardrobe-detail-info"><h2>{terms.metadata.name}</h2><p>作者 · {terms.metadata.credit}</p>
        <p>{terms.metadata.allowRemix?'允许二改':'禁止二改'} · {terms.metadata.allowRedistribute?'允许二次传播':'禁止二次传播'}</p>
        <p className="wardrobe-message">{terms.metadata.message}</p><p>Repo：{terms.metadata.platforms.join('、')}{terms.metadata.contact&&' · '+terms.metadata.contact}</p>
        <p>导出版本：{terms.metadata.exportVersion}</p><p>{terms.metadata.bugFeedback==='welcome'?'欢迎反馈 Bug':'Bug 请自行修复处理'}</p>
        <label className="catalog-accept"><input type="checkbox" disabled={busy} checked={accepted} onChange={e=>setAccepted(e.target.checked)}/>我已阅读作者的使用规范</label>
        {error&&<p role="alert">{error}</p>}
      </div>
    </div>
    <footer><span>先收藏，再选择角色应用</span><button disabled={busy||!accepted} onClick={()=>void run(async()=>{
      const latest=await beautyRequest<BeautyShare>(`/shares/${entry.code}`);
      if(!sameCatalogTerms(terms,latest)){setTerms(latest);setAccepted(false);throw Error('作者已更新作品或使用规范，请重新阅读并确认。封面与预览仍为目录版本。');}
      // Never import a cached public preview: fresh retrieval enforces withdrawal/version checks.
      const data=await downloadBeauty(latest,latest.kind);await onReceive(data,latest);onClose();
    })}>{busy?'正在加载…':'领取装扮'}</button></footer>
  </dialog>,document.body);
}

export default function BeautyCatalog({onBack,onReceive}:{onBack:()=>void;onReceive:(pack:unknown,share:BeautyShare)=>Promise<void>}){
  const [entries,setEntries]=useState<BeautyCatalogEntry[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const [category,setCategory]=useState<BeautyCategory>('all'),[query,setQuery]=useState(''),[search,setSearch]=useState(false),[page,setPage]=useState(0);
  const [selected,setSelected]=useState<BeautyCatalogEntry>();const list=useRef<HTMLDivElement>(null);
  useLocalBackHandler(()=>{if(search){setSearch(false);setQuery('');}else onBack();return true;}, 30);
  useEffect(()=>{let alive=true;setLoading(true);setError('');loadBeautyCatalog().then(c=>{if(alive)setEntries(shuffleCatalog(c.entries.filter(e=>belongsInBeautyLibrary(e.categories as BeautyCategory[],'chat'))));}).catch(e=>{if(alive)setError(e instanceof Error?e.message:'装扮库加载失败');}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[attempt]);
  const needle=query.trim().toLocaleLowerCase();
  const filtered=entries.filter(e=>(category==='all'||e.categories.includes(category))&&`${e.metadata.name}\n${e.metadata.credit}`.toLocaleLowerCase().includes(needle));
  const pages=Math.max(1,Math.ceil(filtered.length/12)),current=Math.min(page,pages-1);
  return <div className="beauty-wardrobe beauty-catalog">
    <div className="wardrobe-navigation"><header className="wardrobe-topline"><button className="wardrobe-back" aria-label="返回聊天装扮" onClick={onBack}>‹</button><h2>装扮库 <small>测试版</small></h2><div className="wardrobe-header-actions"><button aria-label="搜索装扮库" onClick={()=>setSearch(v=>!v)}><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/></svg></button></div></header>
      <nav className="wardrobe-categories" aria-label="装扮库分类">{BEAUTY_CATEGORIES.filter(([id])=>id==='all'||(id!=='chat'&&belongsInBeautyLibrary([id],'chat'))).map(([id,label])=><button key={id} aria-pressed={category===id} onClick={()=>{setCategory(id);setPage(0);}}>{label}</button>)}</nav>
    </div>
    <div className="wardrobe-content" ref={list}>
      {search&&<input autoFocus className="wardrobe-search" aria-label="搜索作品或作者" placeholder="搜索作品名或作者" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/>}
      <div className="wardrobe-list-caption"><h3>发现装扮</h3><span>{filtered.length} 款 <button disabled={loading} onClick={()=>{setPage(0);setAttempt(v=>v+1);}}>刷新目录</button> <button onClick={()=>{setEntries(v=>shuffleCatalog(v));setPage(0);}}>换一批</button></span></div>
      {loading?<p role="status">正在打开装扮库…</p>:error?<div role="alert"><p>{error}</p><button onClick={()=>setAttempt(v=>v+1)}>重试</button></div>:<>
        <div className="wardrobe-grid">{filtered.slice(current*12,current*12+12).map(entry=><article className="wardrobe-item" key={entry.code}><button className="wardrobe-tile" aria-label={'预览 '+entry.metadata.name} onClick={()=>setSelected(entry)}><div className="wardrobe-cover"><img loading="lazy" decoding="async" src={BEAUTY_CATALOG_URL+'/'+entry.cover} alt={entry.metadata.name} onError={e=>{e.currentTarget.style.visibility='hidden';}}/></div><strong>{entry.metadata.name}</strong><span className="wardrobe-credit">{entry.metadata.credit}</span></button></article>)}</div>
        {!filtered.length&&<div className="wardrobe-empty"><span>✧</span><h3>{needle?'没有找到这款装扮':'这里还在慢慢添新装'}</h3><p>{needle?'换个作品名或作者试试。':'作者同意公开、审核通过的作品会出现在这里。'}</p></div>}
        {pages>1&&<nav className="wardrobe-pagination" aria-label="装扮库分页"><button disabled={current===0} onClick={()=>{setPage(current-1);list.current?.scrollIntoView({block:'start'});}}>上一页</button><span>{current+1} / {pages}</span><button disabled={current+1===pages} onClick={()=>{setPage(current+1);list.current?.scrollIntoView({block:'start'});}}>下一页</button></nav>}
      </>}
    </div>
    {selected&&<CatalogDetail key={selected.revision} entry={selected} onClose={()=>setSelected(undefined)} onReceive={onReceive}/>}
  </div>;
}
