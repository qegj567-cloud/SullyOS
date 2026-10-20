import React,{useMemo,useRef,useState} from 'react';
import {Archive,ArrowClockwise,ArrowLeft,DownloadSimple,SpinnerGap} from '@phosphor-icons/react';
import type {StoryTheaterEntry,StoryTheaterMask} from '../../../types';
import {useOS} from '../../../context/OSContext';
import {resolveStoryTheaterMask} from '../../../utils/storyTheater';
import {convertStoryArchiveToMemory,storyMemoryDate} from '../../../utils/storyTheaterMemoryConversion';
import {shareOrDownloadFile} from '../../../utils/shareExport';
import {StoryAppearanceButton} from './StoryTheaterTheme';
import {regenerateStoryArchiveSummary} from '../../../utils/storyTheaterArchive';

export default function StoryArchivePanel({entry,masks,onBack,onUpdated}:{entry:StoryTheaterEntry;masks:StoryTheaterMask[];onBack:()=>void;onUpdated:(entry:StoryTheaterEntry)=>void}){
 const {characters,userProfile,apiConfig,memoryPalaceConfig,remoteVectorConfig,addToast}=useOS();
 const actors=characters.filter(char=>entry.characterIds.includes(char.id));
 const [charId,setCharId]=useState(actors[0]?.id??'');
 const [selected,setSelected]=useState<string[]>([]),[dates,setDates]=useState<Record<string,string>>({});
 const [busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('');
 const [regeneratingId,setRegeneratingId]=useState<string|null>(null);
 const running=useRef(false);
 const boxes=useMemo(()=>entry.archives.filter(a=>a.strategy==='summary'),[entry.archives]);
 const char=actors.find(c=>c.id===charId);
 const available=boxes.filter(box=>!box.memoryConversions?.[charId]);
 const chosen=boxes.filter(box=>selected.includes(box.id)&&!box.memoryConversions?.[charId]);
 const dateValid=(date?:string)=>{try{storyMemoryDate(date??'');return true;}catch{return false;}};
 const toggle=(id:string)=>setSelected(current=>current.includes(id)?current.filter(x=>x!==id):[...current,id]);
 const regenerate=async(id:string)=>{
  if(running.current)return;
  running.current=true;setBusy(true);setRegeneratingId(id);setError('');setStatus('正在从这个事件盒的原文重新总结…');
  try{
   const updated=await regenerateStoryArchiveSummary(entry.id,id,apiConfig);
   onUpdated(updated);setStatus('事件盒已重新总结，续写将使用新摘要。');addToast('事件盒已重新总结','success');
  }catch(e:any){setError(e?.message||'重新总结失败，旧摘要已保留，请重试');setStatus('');}
  finally{running.current=false;setBusy(false);setRegeneratingId(null);}
 };
 const convert=async()=>{
  if(running.current||!char||!chosen.length)return;
  if(chosen.some(box=>!dateValid(dates[box.id]))){setError('请为每个选中的事件盒填写记忆日期');return;}
  running.current=true;setBusy(true);setError('');
  let completed=0;
  try{
   const llm=memoryPalaceConfig.lightLLM?.baseUrl?memoryPalaceConfig.lightLLM:apiConfig;
   const identity=resolveStoryTheaterMask(entry.mask,userProfile,characters,masks);
   for(const box of chosen){
    const result=await convertStoryArchiveToMemory({entryId:entry.id,archiveId:box.id,charId:char.id,date:dates[box.id],userName:userProfile.name||'用户',identityName:identity.name,llm,embedding:memoryPalaceConfig.embedding,remote:remoteVectorConfig,onProgress:text=>setStatus(`${completed+1}/${chosen.length} · ${text}`)});
    onUpdated(result.entry);completed++;
    setSelected(current=>current.filter(id=>id!==box.id));
   }
   setStatus(`已完成 ${completed} 个事件盒；可以在${char.memoryPalaceEnabled?'记忆宫殿和神经链接':'神经链接'}查看。`);
   addToast('所选事件盒已转化为角色记忆','success');
  }catch(e:any){setError(`${completed?`已完成 ${completed} 个，未完成的仍保留选中。`:''}${e?.message||'转化失败，请重试'}`);setStatus('');}
  finally{running.current=false;setBusy(false);}
 };
 const exportSelected=async()=>{
  const rows=boxes.filter(b=>selected.includes(b.id));if(!rows.length)return;
  try{
   const content=[`剧情事件盒 · ${entry.title}`,...rows.map(box=>`\n===== 事件盒 ${boxes.indexOf(box)+1} · ${box.messageCount} 条原文 =====\n${box.summary}`)].join('\n');
   await shareOrDownloadFile({content,fileName:`${entry.title.replace(/[\\/:*?"<>|]/g,'_').slice(0,80)||'剧情'}-事件盒.txt`,mimeType:'text/plain;charset=utf-8',shareTitle:'剧情事件盒'});
  }catch(e:any){setError(e?.message||'导出失败，请重试');}
 };
 return <div className='h-full w-full flex flex-col bg-stone-100 text-slate-800'>
  <header className='story-safe-header shrink-0 border-b border-slate-200'><div className='h-16 px-4 flex items-center gap-3'>
   <button disabled={busy} onClick={onBack} aria-label='返回剧情' className='w-9 h-9 grid place-items-center disabled:opacity-30'><ArrowLeft size={20}/></button>
   <div className='min-w-0 flex-1'><div className='text-[9px] tracking-[.2em] text-violet-500'>剧情事件盒</div><h1 className='font-semibold truncate'>{entry.title}</h1></div><StoryAppearanceButton/>
  </div></header>
  <main className='story-page-scroll flex-1 overflow-y-auto px-5 py-6'><div className='max-w-2xl mx-auto space-y-5'>
   <section className='pb-5 border-b border-slate-200'><Archive size={30} className='text-violet-500'/><h2 className='mt-3 font-semibold'>查看事件盒，转为角色记忆</h2>
    <p className='mt-2 text-xs leading-6 text-slate-500'>这些摘要帮助本剧情接着写。总结有误时，可用主 API 从该盒原文重新总结；成功后替换摘要，失败保留原内容。也可以勾选导出，或转为角色记忆。</p>
   </section>
   {!boxes.length?<p className='text-sm leading-7 text-slate-500'>这条剧情还没有事件盒摘要。虚构剧场选择「事件盒」归档后，达到设置的归档条数才会生成；独立向量记忆请从剧情的向量入口查看。已有原文可在剧情页展开或导出。</p>:<>
    <label className='block text-xs font-semibold'>接收记忆的角色<select aria-label='接收记忆的角色' disabled={busy} value={charId} onChange={e=>{setCharId(e.target.value);setSelected([]);setError('');setStatus('');}} className='mt-2 w-full p-3 rounded-xl bg-white border border-slate-200'>{actors.map(actor=><option key={actor.id} value={actor.id}>{actor.name}</option>)}</select></label>
    <p className='text-xs leading-6 text-slate-500'>{char?.memoryPalaceEnabled?'已开启记忆宫殿：自动提炼整理后写入记忆宫殿，同时关联到神经链接。':'未开启记忆宫殿：自动提炼整理后写入神经链接记忆。'}记忆会保留「剧情经历」的说明。请填写希望这段记忆归属的日期；跨多日的盒子暂统一归到所填日期。</p>
    <p className='text-[11px] leading-5 text-slate-500'>转化不会改变剧情模式、原文时间或聊天的记忆整理进度。每个事件盒对同一角色只转化一次；之前转化的记忆不会随删除剧情一起删除。</p>
    <div className='flex items-center justify-between gap-2'><span className='text-xs text-slate-500'>共 {boxes.length} 个 · 选中 {selected.length} 个</span><button disabled={busy} onClick={()=>setSelected(selected.length?[]:boxes.map(b=>b.id))} className='text-xs text-violet-700 disabled:opacity-30'>{selected.length?'取消全选':'全选'}</button><button disabled={busy||!available.length} onClick={()=>setSelected(available.map(b=>b.id))} className='text-xs text-violet-700 disabled:opacity-30'>选择未转化</button></div>
    <div className='divide-y divide-slate-200'>{boxes.map((box,index)=>{
     const receipt=box.memoryConversions?.[charId],checked=selected.includes(box.id);
     return <section key={box.id} className='py-4 space-y-3'>
      <label className='flex gap-3 items-start cursor-pointer'><input type='checkbox' aria-label={`选择事件盒 ${index+1}`} checked={checked} disabled={busy} onChange={()=>toggle(box.id)} className='mt-1 accent-violet-600'/><span><strong className='text-sm'>事件盒 {index+1}</strong><span className='block mt-1 text-[11px] text-slate-500'>{box.messageCount} 条原文{receipt?` · 已转化给 ${char?.name} · ${receipt.date} · ${receipt.memoryIds.length} 条记忆${receipt.skipped?`，去重跳过 ${receipt.skipped} 条`:''}`:''}</span></span></label>
      <details className='ml-6'><summary className='cursor-pointer text-xs text-violet-700 py-2'>查看摘要</summary><p className='whitespace-pre-wrap text-sm leading-7'>{box.summary||'暂无摘要，可从原文重新总结。'}</p></details>
      <div className='ml-6'><button disabled={busy} onClick={()=>void regenerate(box.id)} aria-label={`重新总结事件盒 ${index+1}`} className='min-h-[44px] px-3 rounded-xl border border-violet-200 text-violet-700 inline-flex items-center gap-2 text-xs disabled:opacity-30'>{regeneratingId===box.id?<SpinnerGap size={15} className='animate-spin'/>:<ArrowClockwise size={15}/>} {regeneratingId===box.id?'正在重新总结…':'重新总结'}</button>
       {!!Object.keys(box.memoryConversions||{}).length&&<p className='mt-2 text-[11px] leading-5 text-slate-500'>只更新本剧情的摘要；已转为角色记忆的内容需到神经链接或记忆宫殿单独修改。</p>}
      </div>
      {checked&&!receipt&&<label className='block ml-6 text-xs text-slate-600'>记忆日期<input type='date' aria-label={`事件盒 ${index+1} 记忆日期`} required disabled={busy} value={dates[box.id]??''} onChange={e=>setDates(current=>({...current,[box.id]:e.target.value}))} className='block mt-2 p-3 max-w-full rounded-xl border border-slate-200 bg-white'/></label>}
     </section>;
    })}</div>
   </>}
   {error&&<p role='alert' className='text-xs leading-6 text-rose-600'>{error}</p>}
   {status&&<p role='status' className='flex gap-2 text-xs leading-6 text-violet-700'>{busy&&<SpinnerGap size={16} className='shrink-0 animate-spin mt-1'/>}{status}</p>}
  </div></main>
  {!!boxes.length&&<footer className='shrink-0 px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] border-t border-slate-200 flex gap-3'>
   <button disabled={busy||!selected.length} onClick={()=>void exportSelected()} className='min-h-[44px] px-4 rounded-xl border border-slate-300 flex items-center gap-2 text-xs disabled:opacity-30'><DownloadSimple size={17}/>导出选中</button>
   <button disabled={busy||!char||!chosen.length||chosen.some(box=>!dateValid(dates[box.id]))} onClick={()=>void convert()} className='min-h-[44px] flex-1 px-4 rounded-xl bg-violet-700 text-white text-xs font-semibold disabled:opacity-30'>{busy?(regeneratingId?'正在重新总结…':'正在转化…'):`一键转为记忆${chosen.length?`（${chosen.length} 个）`:''}`}</button>
  </footer>}
 </div>;
}
