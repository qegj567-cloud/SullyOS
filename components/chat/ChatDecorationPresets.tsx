import React,{useEffect,useRef,useState} from 'react';
import {DB} from '../../utils/db';
import {shareOrDownloadFile} from '../../utils/shareExport';
import {safeShareFileName} from '../../utils/pngShare';
import {readDecorationFile,validateDecoration,PART_LABELS,DecorationPart,DecorationPreset,DecorationImport} from '../../utils/chatDecoration';
import type {ChatTheme} from '../../types';
const STORE='chat_decoration_presets_v1';
interface Props{onBusyChange:(busy:boolean)=>void;target:string;scope:'character'|'global';currentBubble:ChatTheme;exportCurrent:(name:string)=>Promise<DecorationPreset>;onApply:(preset:DecorationPreset,parts:DecorationPart[])=>Promise<void>}
export default function ChatDecorationPresets({target,scope,currentBubble,exportCurrent,onApply,onBusyChange}:Props){
 const [name,setName]=useState('我的聊天装扮');const [saved,setSaved]=useState<DecorationPreset[]>([]);const [pending,setPending]=useState<DecorationImport|null>(null);const [parts,setParts]=useState<DecorationPart[]>([]);const [imageUse,setImageUse]=useState<'background'|'user'|'ai'>('background');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const fileRef=useRef<HTMLInputElement>(null);const saveReady=useRef(false);
 useEffect(()=>{let alive=true;DB.getAsset(STORE).then(raw=>{if(!alive)return;const list=raw?JSON.parse(raw):[];setSaved(Array.isArray(list)?list.map(validateDecoration):[]);saveReady.current=true;}).catch(()=>{if(alive)setError('预设列表读取失败，请重新打开后再保存。');});return()=>{alive=false;};},[]);
 const run=async(work:()=>Promise<void>)=>{setBusy(true);onBusyChange(true);setError('');setNotice('');try{await work();}catch(e){setError(e instanceof Error?e.message:'操作失败，请重试');}finally{setBusy(false);onBusyChange(false);}};
 const stage=(item:DecorationImport)=>{setPending(item);setError('');setNotice('');if(item.kind==='preset')setParts(Object.keys(item.preset.parts) as DecorationPart[]);else setImageUse('background');};
 const save=()=>run(async()=>{if(!saveReady.current)throw Error('预设列表尚未加载，请稍后再试');const preset=await exportCurrent(name.trim()||'我的聊天装扮');const next=[preset,...saved];await DB.saveAsset(STORE,JSON.stringify(next));setSaved(next);setNotice('整套装扮已存入我的预设。');});
 const share=()=>run(async()=>{const preset=await exportCurrent(name.trim()||'我的聊天装扮');await shareOrDownloadFile({content:JSON.stringify(preset,null,2),fileName:safeShareFileName(preset.name)+'.json',mimeType:'application/json',card:{kind:'chat-decoration',title:preset.name}});setNotice('装扮文件已交给系统分享或下载。');});
 const apply=()=>run(async()=>{
  if(!pending)return;
  let preset:DecorationPreset;let selected=parts;
  if(pending.kind==='preset')preset=pending.preset;
  else if(imageUse==='background'){preset={format:'sullyos-chat-decoration',version:1,name:pending.name,parts:{background:{image:pending.image,style:'plain'}}};selected=['background'];}
  else{const bubble=(await exportCurrent(name)).parts.bubbles!;bubble.name=pending.name;bubble[imageUse].backgroundImage=pending.image;bubble[imageUse].backgroundImageOpacity=1;preset={format:'sullyos-chat-decoration',version:1,name:pending.name,parts:{bubbles:bubble}};selected=['bubbles'];}
  if(!selected.length)throw Error('请至少选择一项内容');await onApply(preset,selected);setPending(null);setNotice(`已应用到${target}。可以继续调整，或点「看效果」。`);
 });
 return <div className="chat-decoration-presets">
  <h3>预设</h3><p className="chat-decoration-note">把布局、气泡、背景、声音和进阶样式存成一套，随时换上或导出分享。CSS、TXT 和图片也能从这里导入，再选择用途。</p><p className="chat-decoration-note">确认后才会应用到 <b>{target}</b>，没有勾选的部分保持原样。</p>
  <button className="chat-decoration-import" disabled={busy} onClick={()=>fileRef.current?.click()}>导入文件 <small>整套装扮、CSS / TXT、气泡、提示音或图片</small></button>
  <input ref={fileRef} hidden type="file" aria-label="统一导入装扮" accept=".json,.txt,.css,.png,.jpg,.jpeg,.webp,.gif,.avif,.bmp" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void run(async()=>stage(await readDecorationFile(file)));}}/>
  {error&&<p role="alert" className="chat-decoration-error">{error}</p>}{notice&&<p role="status" className="chat-decoration-note">{notice}</p>}
  {pending&&<section className="chat-decoration-import-review">
   <h3>{pending.kind==='image'?'这张图片用在哪里？':pending.preset.name}</h3>
   {pending.kind==='image'?<><img src={pending.image} className="chat-decoration-background" alt="待导入图片"/><div className="chat-decoration-image-choices">{([['background','聊天背景'],['user','我的气泡贴图'],['ai','角色气泡贴图']] as const).map(([id,label])=><button disabled={busy} key={id} aria-pressed={imageUse===id} onClick={()=>setImageUse(id)}>{label}</button>)}</div></>:<>
    {(Object.keys(pending.preset.parts) as DecorationPart[]).map(key=><label key={key} className="chat-decoration-part"><input disabled={busy} type="checkbox" checked={parts.includes(key)} onChange={()=>setParts(value=>value.includes(key)?value.filter(k=>k!==key):[...value,key])}/><span>{PART_LABELS[key]} <small>{pending.preset.parts[key]===null?'清除 / 静音':key==='css'&&!pending.preset.parts.css?'清空 CSS':'替换这一项'}</small></span></label>)}
    <details className="chat-decoration-sources"><summary>查看导入内容</summary>{pending.preset.parts.background?.image&&<img className="chat-decoration-background" alt="预设背景" src={pending.preset.parts.background.image}/>}<p>布局：{pending.preset.parts.layout?Object.keys(pending.preset.parts.layout).length+' 项':'未包含'}<br/>气泡：{pending.preset.parts.bubbles?.name||'未包含'}<br/>提示音：{pending.preset.parts.sound?.src?.startsWith('data:')?'内嵌音频':pending.preset.parts.sound?.src||'未包含或静音'}</p>{pending.preset.parts.css!==undefined&&<pre className="chat-decoration-code-preview">{pending.preset.parts.css||'（空）'}</pre>}</details>
   </>}
   <p className="chat-decoration-note">应用范围：{target}{scope==='global'?'，已有专属设置的角色仍保留自己的选择。':''}</p>
   <div className="chat-decoration-preset-actions"><button disabled={busy||(pending.kind==='preset'&&!parts.length)} onClick={apply}>{busy?'处理中…':'确认应用'}</button><button disabled={busy} onClick={()=>setPending(null)}>取消</button></div>
  </section>}
  <section className="chat-decoration-preset-save"><h3>保存当前整套装扮</h3><label className="chat-decoration-field">预设名称<input value={name} maxLength={60} onChange={e=>setName(e.target.value)} aria-label="装扮预设名称"/></label><p className="chat-decoration-note">包含当前布局、气泡、背景、声音和 CSS。本地图片会打包进文件，外链素材仍需联网。</p><div className="chat-decoration-preset-actions"><button disabled={busy} onClick={save}>存为预设</button><button disabled={busy} onClick={share}>导出分享</button></div></section>
  <section className="chat-decoration-preset-save"><h3>我的预设</h3>{saved.length?saved.map((preset,index)=><div key={index} className="chat-decoration-saved"><button disabled={busy} onClick={()=>stage({kind:'preset',preset})}>{preset.name}<small>查看并应用 →</small></button><button aria-label={`删除预设 ${preset.name}`} disabled={busy} onClick={()=>run(async()=>{const next=saved.filter((_,i)=>i!==index);await DB.saveAsset(STORE,JSON.stringify(next));setSaved(next);})}>删除</button></div>):<p className="chat-decoration-note">保存喜欢的搭配，下次可以整套换上。</p>}</section>
 </div>;
}
