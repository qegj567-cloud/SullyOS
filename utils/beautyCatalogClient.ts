import {BEAUTY_MAX_BYTES, validateBeautyMetadata, type BeautyShare} from './beautyShareContract';
import {parseBeautyCatalog, type BeautyCatalog, type BeautyCatalogEntry} from './beautyCatalogContract';
import {normalizeBeautyPackage} from './beautyShareClient';

// This origin serves only public static snapshots. Never point it at the private bucket.
export const BEAUTY_CATALOG_URL=(import.meta.env.VITE_BEAUTY_CATALOG_URL||'https://beauty-library.friedsully.com').replace(/\/$/,'');
let pending:{base:string;value:Promise<BeautyCatalog>}|undefined;
async function readStatic(url:string,maxBytes:number,cache:RequestCache='default'){
  const controller=new AbortController();
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},30000);
  try{
    const response=await fetch(url,{signal:controller.signal,credentials:'omit',cache});
    if(!response.ok)throw Error(`装扮库暂时无法加载 (HTTP ${response.status})，请稍后重试`);
    const reader=response.body?.getReader();if(!reader)throw Error('装扮库内容为空');
    const chunks:Uint8Array[]=[];let size=0;
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw Error('装扮库文件超过大小限制');}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return bytes;
  }catch(err){
    if(timedOut)throw Error('装扮库加载超时（30 秒），请检查网络后重试');
    throw err;
  }finally{clearTimeout(timer);}
}
export function loadBeautyCatalog(base=BEAUTY_CATALOG_URL):Promise<BeautyCatalog>{
  if(pending&&pending.base===base)return pending.value;
  // Revalidate the static manifest on entry; the browser can reuse its ETag body.
  // Only concurrent entry requests are shared. Search/paging do not call this.
  const value=readStatic(base+'/catalog.json',8*1024*1024,'no-cache').then(bytes=>parseBeautyCatalog(JSON.parse(new TextDecoder().decode(bytes))));
  const entry={base,value};pending=entry;
  const clear=()=>{if(pending===entry)pending=undefined;};
  void value.then(clear,clear);
  return value;
}
export async function loadCatalogPreview(entry:BeautyCatalogEntry,base=BEAUTY_CATALOG_URL){
  const bytes=await readStatic(base+'/'+entry.file,BEAUTY_MAX_BYTES);
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.buffer))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(bytes.length!==entry.bytes||digest!==entry.sha256)throw Error('预览文件校验失败，请稍后重试');
  return normalizeBeautyPackage(JSON.parse(new TextDecoder().decode(bytes)),entry.kind);
}
export function sameCatalogTerms(a:BeautyShare,b:BeautyShare){
  return a.code===b.code&&a.kind===b.kind&&a.revision===b.revision&&a.sha256===b.sha256&&JSON.stringify(validateBeautyMetadata(a.metadata))===JSON.stringify(validateBeautyMetadata(b.metadata));
}
