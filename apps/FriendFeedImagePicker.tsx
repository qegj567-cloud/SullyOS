import React, {useEffect, useRef, useState} from 'react';
import {ImageSquare, X} from '@phosphor-icons/react';
import {processImageToBlob} from '../utils/file';
import {FRIEND_POST_IMAGE_LIMIT} from '../utils/friendFeedImages';

function DraftPhoto({blob}: {blob: Blob}) {
    const [url,setUrl] = useState('');
    useEffect(() => {const value=URL.createObjectURL(blob);setUrl(value);return()=>URL.revokeObjectURL(value);},[blob]);
    return <img src={url || undefined} alt="待发布配图"/>;
}
export default function FriendFeedImagePicker({value,onChange,disabled,onBusy,onError}: {
    value:Blob[];onChange:(next:Blob[])=>void;disabled:boolean;onBusy:(busy:boolean)=>void;onError:(error:string)=>void;
}) {
    const [processing,setProcessing]=useState(false), working=useRef(false), alive=useRef(true);
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
    const select=async(event:React.ChangeEvent<HTMLInputElement>)=>{
        const files=Array.from(event.target.files||[]);event.target.value='';
        if(!files.length||working.current)return;
        if(value.length+files.length>FRIEND_POST_IMAGE_LIMIT){onError('一条动态最多添加 9 张图片');return;}
        if(files.some(f=>!['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(f.type)||f.size>10*1024*1024)){
            onError('请选择 JPG、PNG、WebP、GIF 或 AVIF 图片，每张不超过 10 MB');return;
        }
        working.current=true;setProcessing(true);onBusy(true);onError('');
        try {
            const next:Blob[]=[];
            for(const file of files)next.push(await processImageToBlob(file,{maxWidth:1600,quality:.85}));
            if([...value,...next].reduce((sum,b)=>sum+b.size,0)>24*1024*1024)throw Error('配图合计不能超过 24 MB，请减少图片');
            if(alive.current)onChange([...value,...next]);
        }catch(e){if(alive.current)onError(e instanceof Error?e.message:'图片读取失败');}
        finally{working.current=false;if(alive.current){setProcessing(false);onBusy(false);}}
    };
    return <div className="ff-compose-images">
        {!!value.length&&<div className="ff-compose-thumbnails">{value.map((blob,i)=><div key={i}><DraftPhoto blob={blob}/>
            <button type="button" aria-label={`移除配图 ${i+1}`} disabled={disabled||processing} onClick={()=>onChange(value.filter((_,n)=>n!==i))}><X size={16}/></button></div>)}</div>}
        <label className="ff-add-photos"><ImageSquare size={22}/>{processing?'正在处理图片…':`添加图片 · ${value.length}/9`}
            <input type="file" aria-label="添加动态配图" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/avif" disabled={disabled||processing||value.length>=9} onChange={select}/></label>
        <small>图片保存在本机，不会发布到微博。可以只发图片。</small>
    </div>;
}
