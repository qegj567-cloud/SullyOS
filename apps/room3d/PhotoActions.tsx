import React,{useEffect,useRef,useState} from 'react';
import {photoLibrary} from './photoLibrary';
import {isRomanticMotion} from './homeRomance';
import type {HomeEditor} from './editor';
export function PhotoActions({editor,actors,refresh,compact=false,onPreview,onExpand}:{editor:HomeEditor;actors:Array<{id:string;label:string}>;refresh:()=>void;compact?:boolean;onPreview?:()=>void;onExpand?:()=>void}){
 const [kind,setKind]=useState('motion'),[query,setQuery]=useState(''),[a,setA]=useState(actors[0]?.id||''),[b,setB]=useState(actors[1]?.id||''),[selected,setSelected]=useState(''),[time,setTime]=useState(1),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{if(!actors.some(e=>e.id===a))setA(actors[0]?.id||'');if(!actors.some(e=>e.id===b)||a===b)setB(actors.find(e=>e.id!==a)?.id||'');},[actors,a,b]);
 const request=useRef(0);useEffect(()=>()=>{request.current++;},[]);
 const entry=photoLibrary.find(e=>e.id===selected);
 const apply=async(id:string,t:number,preview=false,actor=a,partner=b)=>{const version=++request.current;setSelected(id);setTime(t);setBusy(true);setError('');try{const e=photoLibrary.find(e=>e.id===id);if(e?.participants===2)await editor.setPhotoInteraction(id,actor,partner,t);else await editor.setPhotoPose(actor,id,t);if(version===request.current){refresh();if(preview)onPreview?.();}}catch(e){if(version===request.current)setError(e instanceof Error?e.message:'动作加载失败');}finally{if(version===request.current)setBusy(false);}};
 const permitted=photoLibrary.filter(e=>!isRomanticMotion(e.id)||editor.canPlaySocial?.(e.id,a,b)===true);
 const results=permitted.filter(e=>e.kind===kind&&e.label.toLowerCase().includes(query.trim().toLowerCase()));
 const step=(direction:number)=>{if(!results.length)return;const index=results.findIndex(e=>e.id===selected),next=results[(Math.max(0,index)+direction+results.length)%results.length];void apply(next.id,next.kind==='pose'?0:Math.min(1,next.duration),true);};
 return <div className="photo-action-library">
  {compact&&entry&&<div className="photo-action-preview" aria-label="当前动作预览"><button aria-label="上一个拍照动作" disabled={busy||results.length<2} onClick={()=>step(-1)}>‹</button><div><strong>{entry.label}</strong><span>{actors.find(e=>e.id===a)?.label}</span></div><button aria-label="下一个拍照动作" disabled={busy||results.length<2} onClick={()=>step(1)}>›</button><button onClick={onExpand}>选择动作</button></div>}
  <div className="photo-action-browser" hidden={compact}>
  <div className="photo-actor-select"><label>动作发起者<select aria-label="动作发起者" value={a} onChange={e=>{const next=e.target.value;setA(next);if(next===b)setB(actors.find(x=>x.id!==next)?.id||'');}}>{actors.map(e=><option key={e.id} value={e.id}>{e.label}</option>)}</select></label>{kind==='pair'&&<label>互动对象<select aria-label="互动对象" value={b} onChange={e=>setB(e.target.value)}>{actors.filter(e=>e.id!==a).map(e=><option key={e.id} value={e.id}>{e.label}</option>)}</select></label>}</div>
  <div className="photo-options">{[['motion','单人动作'],['pair','双人互动']].map(([id,name])=><button key={id} aria-pressed={kind===id} onClick={()=>setKind(id)}>{name} · {permitted.filter(e=>e.kind===id).length}</button>)}</div>
  {kind==='pair'&&actors.length<2&&<p role="status">当前只有一位居民入镜，请让两个人都在同一房间、形象加载完成后重新进入拍照。</p>}
  <input className="photo-search" aria-label="搜索拍照动作" placeholder="搜索动作" value={query} onChange={e=>setQuery(e.target.value)}/>
  <div className="photo-action-grid">{results.map(e=><button key={e.id} aria-pressed={selected===e.id} disabled={!a||(e.participants===2&&(!b||a===b))} onClick={()=>void apply(e.id,e.kind==='pose'?0:Math.min(1,e.duration),true)}>{e.thumbnail&&<img loading="lazy" src={`${import.meta.env.BASE_URL}room3d/motions/photo/${e.thumbnail}`} alt="源姿势示意"/>}<span>{e.label}</span></button>)}</div>
  {!results.length&&<p>没有匹配动作</p>}
  </div>
  {entry&&<label className="photo-slider">{entry.kind==='pose'?'静态定格':'动作时刻'}<input aria-label="动作时刻" type="range" disabled={entry.kind==='pose'||busy} min={0} max={Math.max(.1,entry.duration)} step={.05} value={time} onChange={e=>void apply(entry.id,Number(e.target.value))}/><output>{time.toFixed(2)}</output></label>}
  {busy&&<p role="status">加载动作…</p>}{error&&<p role="alert">{error}</p>}
 </div>;
}
