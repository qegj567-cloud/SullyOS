import manifest from './resourcePacks.generated.json';

export interface PackFile {path:string;bytes:number;sha256:string;dependencies:string[]}
export interface ResourcePack {id:string;name:string;description:string;revision:string;bytes:number;files:PackFile[]}
interface PackRecord {id:string;active?:ResourcePack;operation?:string}
export interface PackStatus {installed:boolean;update:boolean;savedBytes:number;totalBytes:number}
export const resourcePacks:ResourcePack[]=manifest;
export const RESOURCE_PACK_DB='sully-home-resource-packs';
const byPath=new Map(resourcePacks.flatMap(pack=>pack.files.map(file=>[file.path,pack] as const)));
let database:Promise<IDBDatabase>|undefined;
const listeners=new Set<()=>void>();
export function subscribeResourcePacks(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
function changed(){for(const listener of listeners)listener();}
function open(){
 if(!database)database=new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open(RESOURCE_PACK_DB,1);
  request.onupgradeneeded=()=>{request.result.createObjectStore('files');request.result.createObjectStore('packs',{keyPath:'id'});};
  request.onerror=()=>{database=undefined;reject(request.error);};
  request.onblocked=()=>{database=undefined;reject(new Error('资源包正在另一个页面中使用，请关闭后重试'));};
  request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();database=undefined;};resolve(db);};
 });
 return database;
}
function result<T>(request:IDBRequest<T>):Promise<T>{return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function completed(tx:IDBTransaction){const promise=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('资源包保存已中止'));tx.onerror=()=>{};});void promise.catch(()=>{});return promise;}
const fileKey=(id:string,file:PackFile)=>`${id}/${file.sha256}`;
const aborted=()=>new DOMException('下载已暂停','AbortError');
function check(signal?:AbortSignal){if(signal?.aborted)throw aborted();}
export function resourcePath(url:string){
 const base=new URL(import.meta.env.BASE_URL,typeof location==='undefined'?'https://local.invalid/':location.href);
 const parsed=new URL(url,base);
 return parsed.origin===base.origin&&parsed.pathname.startsWith(base.pathname)?decodeURIComponent(parsed.pathname.slice(base.pathname.length)):'';
}
export function isPackResource(url:string){return byPath.has(resourcePath(url));}
function assetURL(path:string){return `${import.meta.env.BASE_URL}${path}`;}

export async function resourcePackStatus(pack:ResourcePack):Promise<PackStatus>{
 const db=await open(),tx=db.transaction(['packs','files'],'readonly');
 const record=await result<PackRecord|undefined>(tx.objectStore('packs').get(pack.id));
 const store=tx.objectStore('files');
 const current=await Promise.all(pack.files.map(async file=>(await result(store.getKey(fileKey(pack.id,file))))!==undefined?file.bytes:0));
 // Re-open because awaiting the preceding requests may finish the transaction in WebKit.
 const active=record?.active;
 let installed=false;
 if(active){const read=db.transaction('files','readonly').objectStore('files');installed=(await Promise.all(active.files.map(file=>result(read.getKey(fileKey(pack.id,file)))))).every(key=>key!==undefined);}
 return {installed,update:installed&&active?.revision!==pack.revision,savedBytes:current.reduce((a,b)=>a+b,0),totalBytes:pack.bytes};
}

/** A model and its dependencies are read from one active generation in one transaction. */
export async function readPackAsset(url:string):Promise<{blob:Blob;revision:string;dependencies:Map<string,Blob>}|undefined>{
 const path=resourcePath(url),pack=byPath.get(path);if(!pack)return;
 const db=await open(),tx=db.transaction(['packs','files'],'readonly');
 const record=await result<PackRecord|undefined>(tx.objectStore('packs').get(pack.id));
 if(!record?.active)return;
 const file=record.active.files.find(file=>file.path===path);if(!file)return;
 const files=[file,...file.dependencies.map(path=>record.active!.files.find(f=>f.path===path)!)];
 if(files.some(f=>!f))throw new Error('资源包依赖缺失，请重新下载');
 const blobs=await Promise.all(files.map(f=>result<Blob|undefined>(tx.objectStore('files').get(fileKey(pack.id,f)))));
 if(blobs.some(blob=>!blob))throw new Error('本地资源不完整，请在资源包中补齐下载');
 return {blob:blobs[0]!,revision:record.active.revision,dependencies:new Map(files.slice(1).map((f,i)=>[f.path,blobs[i+1]!]))};
}
export async function packImageURL(url:string):Promise<{url:string;release:()=>void}>{
 const asset=await readPackAsset(url);
 if(!asset)return {url,release:()=>{}};
 const objectURL=URL.createObjectURL(asset.blob);
 return {url:objectURL,release:()=>URL.revokeObjectURL(objectURL)};
}

/** The editor rebuilds its DOM; release object URLs with that DOM, not on every frame. */
export function hydratePackImages(container:HTMLElement){
 let stopped=false;const releases:Array<()=>void>=[];
 for(const img of container.querySelectorAll<HTMLImageElement>('img[data-pack-src]')){
  const src=img.dataset.packSrc!;
  if(!isPackResource(src)){img.src=src;continue;}
  packImageURL(src).then(value=>{if(stopped)value.release();else{releases.push(value.release);img.src=value.url;}}).catch(()=>{img.alt='预览暂不可用';});
 }
 return()=>{stopped=true;releases.forEach(release=>release());};
}

async function digest(bytes:ArrayBuffer){
 const hash=await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
const running=new Map<string,{controller:AbortController;task:Promise<void>;bytes:number}>();
const transferListeners=new Set<()=>void>();
export function subscribePackTransfers(listener:()=>void){transferListeners.add(listener);return()=>{transferListeners.delete(listener);};}
export function resourcePackTransfers(){return Object.fromEntries([...running].map(([id,job])=>[id,job.bytes]));}
function transferChanged(){for(const listener of transferListeners)listener();}
export function pauseResourcePack(id:string){running.get(id)?.controller.abort();}
export function downloadResourcePack(pack:ResourcePack,onProgress?:(bytes:number)=>void):Promise<void>{
 const existing=running.get(pack.id);if(existing)return existing.task;
 const controller=new AbortController();
 const task=install(pack,controller.signal,bytes=>{const job=running.get(pack.id);if(job)job.bytes=bytes;onProgress?.(bytes);transferChanged();}).finally(()=>{running.delete(pack.id);transferChanged();changed();});
 running.set(pack.id,{controller,task,bytes:0});transferChanged();return task;
}
async function install(pack:ResourcePack,signal:AbortSignal,onProgress?:(bytes:number)=>void){
 const db=await open();check(signal);
 // Operation identity also prevents a paused/removed pack from being resurrected by another tab.
 const operation=Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
 const start=db.transaction('packs','readwrite'),startDone=completed(start),packs=start.objectStore('packs');
 const old=await result<PackRecord|undefined>(packs.get(pack.id));
 packs.put({...old,id:pack.id,operation});await startDone;
 let progress=0;
 // Two file transfers at a time; no GLTF parsing, image decoding or scene construction here.
 let index=0,stopped=false;
 const worker=async()=>{
  while(!stopped&&index<pack.files.length){
   check(signal);const file=pack.files[index++];
   const saved=await result<Blob|undefined>(db.transaction('files','readonly').objectStore('files').get(fileKey(pack.id,file)));
   if(saved&&saved.size===file.bytes){progress+=file.bytes;onProgress?.(progress);continue;}
   const timeout=new AbortController(),cancel=()=>timeout.abort();signal.addEventListener('abort',cancel,{once:true});
   const timer=setTimeout(cancel,45000);
   let bytes:ArrayBuffer;
   try{
    const response=await fetch(assetURL(file.path),{signal:timeout.signal,cache:'no-store'});
    if(!response.ok)throw new Error(`下载失败（${response.status}），可继续下载`);
    bytes=await response.arrayBuffer();
   }catch(error){if(signal.aborted)throw aborted();if(timeout.signal.aborted)throw new Error('下载超时，点击继续下载');throw error;}
   finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
   check(signal);
   if(bytes.byteLength!==file.bytes||await digest(bytes)!==file.sha256)throw new Error('文件校验未通过，请重试下载');
   const tx=db.transaction(['packs','files'],'readwrite'),done=completed(tx);
   const current=await result<PackRecord|undefined>(tx.objectStore('packs').get(pack.id));
   if(current?.operation!==operation){await done;throw aborted();}
   check(signal);
   const type=file.path.endsWith('.png')?'image/png':file.path.endsWith('.jpg')?'image/jpeg':'model/gltf-binary';
   tx.objectStore('files').put(new Blob([bytes],{type}),fileKey(pack.id,file));await done;
   progress+=file.bytes;onProgress?.(progress);
  }
 };
 // Wait for both workers to finish before permitting retries or deletion.
 const run=()=>worker().catch(error=>{stopped=true;throw error;});
 const workers=await Promise.allSettled([run(),run()]);
 const failed=workers.find((r):r is PromiseRejectedResult=>r.status==='rejected');if(failed)throw failed.reason;
 check(signal);
 const tx=db.transaction(['packs','files'],'readwrite'),done=completed(tx);
 const current=await result<PackRecord|undefined>(tx.objectStore('packs').get(pack.id));
 if(current?.operation!==operation){await done;throw aborted();}
 const keys=await Promise.all(pack.files.map(file=>result(tx.objectStore('files').getKey(fileKey(pack.id,file)))));
 if(keys.some(key=>key===undefined)){await done;throw new Error('下载尚未完整，请继续下载');}
 check(signal);tx.objectStore('packs').put({id:pack.id,active:pack} satisfies PackRecord);
 // Commit the new pointer and remove obsolete bytes atomically. Readers already holding the old
 // generation finish before this transaction; a failed update never reaches this point.
 const keep=new Set(pack.files.map(file=>fileKey(pack.id,file)));
 const cursor=tx.objectStore('files').openKeyCursor(IDBKeyRange.bound(`${pack.id}/`,`${pack.id}/\uffff`));
 cursor.onsuccess=()=>{const entry=cursor.result;if(entry){if(!keep.has(String(entry.key)))tx.objectStore('files').delete(entry.primaryKey);entry.continue();}};
 await done;changed();
}
export async function removeResourcePack(id:string){
 const job=running.get(id);if(job){job.controller.abort();await job.task.catch(()=>{});}
 const db=await open(),tx=db.transaction(['packs','files'],'readwrite'),done=completed(tx);
 tx.objectStore('packs').delete(id);
 tx.objectStore('files').delete(IDBKeyRange.bound(`${id}/`,`${id}/\uffff`));
 await done;changed();
}
