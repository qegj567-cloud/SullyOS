import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useLocalBackHandler} from '../../hooks/useLocalBackHandler';
import {downloadResourcePack,pauseResourcePack,resourcePacks,resourcePackStatus,subscribeResourcePacks,packImageURL,isPackResource,resourcePackTransfers,subscribePackTransfers,type ResourcePack} from './resourcePacks';
import './resourcePacks.css';

const statusReads=new Map<string,Promise<boolean>>();
function installedStatus(id:string){
 let read=statusReads.get(id);if(!read){read=resourcePackStatus(resourcePacks.find(p=>p.id===id)!).then(status=>status.installed).finally(()=>statusReads.delete(id));statusReads.set(id,read);}return read;
}
export function useResourcePackInstalled(id:string){
 const [installed,setInstalled]=useState(false);
 useEffect(()=>{let stopped=false;const refresh=()=>{installedStatus(id).then(value=>{if(!stopped)setInstalled(value);}).catch(()=>{});};refresh();const off=subscribeResourcePacks(refresh);window.addEventListener('focus',refresh);return()=>{stopped=true;off();window.removeEventListener('focus',refresh);};},[id]);
 return installed;
}

function DownloadDialog({pack,update,onClose}:{pack:ResourcePack;update:boolean;onClose:(use:boolean)=>void}){
 const dialog=useRef<HTMLDialogElement>(null),alive=useRef(true);
 const [progress,setProgress]=useState(resourcePackTransfers),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const downloading=progress[pack.id]!==undefined;
 const cancel=()=>{pauseResourcePack(pack.id);onClose(update);};
 useLocalBackHandler(()=>{cancel();return true;},70);
 useEffect(()=>{alive.current=true;dialog.current?.showModal();const off=subscribePackTransfers(()=>setProgress(resourcePackTransfers()));return()=>{alive.current=false;off();};},[]);
 const confirm=async()=>{
  setBusy(true);setError('');
  try{await downloadResourcePack(pack);if(alive.current)onClose(true);}
  catch(e){if(alive.current)setError(e instanceof DOMException&&e.name==='QuotaExceededError'?'本机空间不足，已下载的部分会保留。':e instanceof DOMException&&e.name==='AbortError'?'已暂停，点击确定继续下载。':e instanceof Error?e.message:'下载失败，点击确定继续下载。');}
  finally{if(alive.current)setBusy(false);}
 };
 return <dialog ref={dialog} className="home-resource-dialog" aria-label="下载万圣节资源包" onCancel={event=>{event.preventDefault();cancel();}}>
  <h2>{update?'是否更新万圣节资源包？':'是否下载万圣节资源包？'}</h2>
  <p>{pack.name} · {(pack.bytes/1_000_000).toFixed(2)} MB</p>
  <p>下载后即可使用，刷新后无需重新下载。</p>
  {downloading&&<><progress aria-label="下载进度" value={progress[pack.id]} max={pack.bytes}/><p role="status">正在下载 {Math.floor(progress[pack.id]/pack.bytes*100)}%</p></>}
  {error&&<p role="alert">{error}</p>}
  <div className="home-resource-actions"><button onClick={cancel}>{downloading?'取消下载':update?'稍后':'取消'}</button><button disabled={busy} onClick={()=>void confirm()}>{busy?'下载中…':'确定'}</button></div>
 </dialog>;
}

let dismiss:(()=>void)|undefined;
/** A gray asset tile resumes its requested action only after a complete download. */
export async function confirmResourcePack(id:string,signal?:AbortSignal):Promise<boolean>{
 const pack=resourcePacks.find(p=>p.id===id);if(!pack||signal?.aborted)return false;
 const status=await resourcePackStatus(pack).catch(()=>({installed:false,update:false}));if(signal?.aborted)return false;
 if(status.installed&&!status.update)return true;
 dismiss?.();
 return new Promise(resolve=>{
  const previous=document.activeElement as HTMLElement|null,host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  let closed=false;
  const close=(use:boolean)=>{if(closed)return;closed=true;signal?.removeEventListener('abort',abort);if(dismiss===abort)dismiss=undefined;root.unmount();host.remove();if(previous?.isConnected)previous.focus();resolve(use&&!signal?.aborted);};
  const abort=()=>{pauseResourcePack(id);close(false);};
  dismiss=abort;signal?.addEventListener('abort',abort,{once:true});root.render(<DownloadDialog pack={pack} update={status.installed} onClose={close}/>);
 });
}

export function PackImage({src,...props}:React.ImgHTMLAttributes<HTMLImageElement>&{src:string}){
 const [url,setURL]=useState('');
 useEffect(()=>{if(!isPackResource(src))return;let stopped=false,release=()=>{};setURL('');packImageURL(src).then(value=>{if(stopped)value.release();else{release=value.release;setURL(value.url);}}).catch(()=>{});return()=>{stopped=true;release();};},[src]);
 return <img {...props} src={isPackResource(src)?url||undefined:src}/>;
}
