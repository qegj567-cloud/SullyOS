import React, {useEffect, useRef, useState} from 'react';
import {ImageSquare} from '@phosphor-icons/react';
import {putImageBlob,useBlobRefUrl} from '../utils/blobRef';
import {processImageToBlob} from '../utils/file';
import {saveFriendFeedCover} from '../utils/friendFeedCover';
import './friendFeedCover.css';

export function FriendFeedCoverLayer({value,onEdit}:{value?:string;onEdit?:()=>void}) {
    const src=useBlobRefUrl(value),[failed,setFailed]=useState(false);
    useEffect(()=>setFailed(false),[src]);
    return <div className="ff-cover-layer">
        {src&&!failed&&<img className="ff-cover-image" src={src} alt="主页封面" onError={()=>setFailed(true)}/>}
        {onEdit&&<button type="button" className="ff-cover-edit" aria-label="更换主页封面" title="点击更换封面" onClick={onEdit}/>}
    </div>;
}

export default function FriendFeedCoverEditor({ownerId,value,onBack,onSaved,onBusy}:{ownerId:string;value?:string;onBack:()=>void;onSaved:()=>void;onBusy:(value:boolean)=>void}) {
    const [blob,setBlob]=useState<Blob>(),[reset,setReset]=useState(false),[preview,setPreview]=useState('');
    const saved=useBlobRefUrl(value),[busy,setBusy]=useState(false),[error,setError]=useState('');
    const alive=useRef(true),working=useRef(false);
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
    useEffect(()=>{if(!blob){setPreview('');return;}const url=URL.createObjectURL(blob);setPreview(url);return()=>URL.revokeObjectURL(url);},[blob]);
    const run=async(action:()=>Promise<void>)=>{if(working.current)return;working.current=true;setBusy(true);onBusy(true);setError('');
        try{await action();}catch(e){if(alive.current)setError(e instanceof Error?e.message:'封面保存失败');}
        finally{working.current=false;onBusy(false);if(alive.current)setBusy(false);}
    };
    const select=(event:React.ChangeEvent<HTMLInputElement>)=>{
        const file=event.target.files?.[0];event.target.value='';if(!file)return;
        if(!['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(file.type)||file.size>10*1024*1024){setError('请选择 10 MB 以内的图片');return;}
        void run(async()=>{const next=await processImageToBlob(file,{maxWidth:1600,quality:.85});if(alive.current){setBlob(next);setReset(false);}});
    };
    const save=()=>void run(async()=>{
        const image=reset?undefined:blob?await putImageBlob(blob):value;
        if(!alive.current)return;
        await saveFriendFeedCover(ownerId,image);
        // Release the navigation guard before returning to the parent page.
        onBusy(false);if(alive.current)onSaved();
    });
    const image=reset?'':preview||saved;
    return <div className="friend-feed-form ff-settings-page ff-cover-editor">
        <div className="ff-cover-preview">{image?<img src={image} alt="封面预览"/>:<span>使用主题默认封面</span>}</div>
        <label className="ff-cover-upload"><ImageSquare size={20}/>{busy?'正在处理…':'选择本地图片'}<input type="file" aria-label="选择主页封面" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" disabled={busy} onChange={select}/></label>
        <p className="ff-setting-status">图片保存在本机，居中裁切显示。横向图片更适合作封面。</p>
        <button type="button" className="ff-setting-link" disabled={busy} onClick={()=>{setReset(true);setBlob(undefined);}}>恢复默认封面</button>
        {error&&<p role="alert" className="friend-feed-error">{error}</p>}
        <div className="friend-feed-form-actions"><button type="button" disabled={busy} onClick={onBack}>取消</button><button type="button" disabled={busy} className="friend-feed-primary" onClick={save}>{busy?'正在保存…':'保存封面'}</button></div>
    </div>;
}
