import React,{useEffect,useRef,useState} from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import {createPortal} from 'react-dom';
import './BeautyConfirmDialog.css';
export default function BeautyConfirmDialog({title,children,confirm='确认',danger=false,onConfirm,onClose}:{title:string;children:React.ReactNode;confirm?:string;danger?:boolean;onConfirm:()=>Promise<void>;onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const inFlight=useRef(false);
 useLocalBackHandler(()=>{if(!inFlight.current)onClose();return true;}, 60);
 useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close();},[]);
 return createPortal(<dialog ref={ref} className="beauty-confirm-dialog" aria-label={title} onCancel={e=>{e.preventDefault();if(!inFlight.current)onClose();}}><h3>{title}</h3><div className="beauty-confirm-body">{children}</div>{error&&<p role="alert">{error}</p>}<footer><button disabled={busy} onClick={onClose}>取消</button><button className={danger?'is-danger':''} disabled={busy} onClick={async()=>{if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');try{await onConfirm();onClose();}catch(e){setError(e instanceof Error?e.message:'操作失败，请重试');}finally{inFlight.current=false;setBusy(false);}}}>{busy?'处理中…':confirm}</button></footer></dialog>,document.body);
}
