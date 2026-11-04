import React, {useEffect, useRef, useState} from 'react';
import BeautyPresetPreview, {type BeautyPreviewHandle} from './BeautyPresetPreview';
import {encodeBeautyCatalogCover, readBeautyCatalogCover} from '../../utils/beautyCatalogCover';

/** Capture the same synthetic preview the author sees; never capture their real chat. */
export default function BeautyCatalogConsent({pack,cover,onCover}:{pack:unknown;cover:string;onCover:(cover:string)=>void}){
  const latestPack=useRef(pack);latestPack.current=pack;
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const preview=useRef<BeautyPreviewHandle>(null);
  const upload=useRef<HTMLInputElement>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  return <div className="beauty-catalog-consent">
    <p>审核通过后，作品、署名、联系说明、留言及预览素材会在装扮库公开，可被下载。取消公开后缓存可能短暂保留，已下载的副本无法收回。</p>
    <BeautyPresetPreview ref={preview} data={pack}/>
    <button type="button" disabled={busy} onClick={async()=>{
      const startedPack=pack;
      setBusy(true);setError('');onCover('');
      try{
        if(!preview.current)throw Error('请等待预览载入');
        const source=await preview.current.capture();
        if(alive.current&&latestPack.current===startedPack)onCover(encodeBeautyCatalogCover(source,source.width,source.height));
      }catch(e){setError(e instanceof Error?e.message:'封面生成失败，请重试');}finally{setBusy(false);}
    }}>{busy?'正在生成封面…':cover?'重新生成封面':'生成装扮库封面'}</button>
    <p>图床限制导致生成失败时，可截取上方示例预览，再上传为封面。请只保留作品预览，不要包含真实聊天或个人信息；封面将随作品一起审核。</p>
    <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async event=>{
      const file=event.target.files?.[0];event.target.value='';if(!file||busy)return;
      const startedPack=pack;
      setBusy(true);setError('');onCover('');
      try{const next=await readBeautyCatalogCover(file);if(alive.current&&latestPack.current===startedPack)onCover(next);}
      catch(e){setError(e instanceof Error?e.message:'截图读取失败，请换一张图片');}
      finally{setBusy(false);}
    }}/>
    <button type="button" disabled={busy} onClick={()=>upload.current?.click()}>上传预览截图</button>
    {cover&&<div><img src={cover} alt="即将公开的装扮库封面" style={{maxWidth:120,maxHeight:200,objectFit:'contain'}}/><p>封面已就绪，将随作品一起审核。</p></div>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
