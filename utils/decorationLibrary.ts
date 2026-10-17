import {localizeCssImages} from './cssImageAssets';
import {DB} from './db';
import {decorationSourceKey, rememberBeautySource} from './beautyUsage';
import {validateDecoration, type DecorationPreset} from './chatDecoration';
import type {BeautyShare} from './beautyShareContract';
async function localPreset(preset:DecorationPreset):Promise<DecorationPreset>{
 const next=validateDecoration(preset);
 if(next.parts.collaboration)next.parts.collaboration.customCss=await localizeCssImages(next.parts.collaboration.customCss);
 if(next.parts.css!==undefined)next.parts.css=await localizeCssImages(next.parts.css);
 return next;
}
export const DECORATION_STORE='chat_decoration_presets_v1';
export interface DecorationOrigin {kind:'self'|'imported'|'remix'|'legacy'|'builtin';allowRemix?:boolean;allowRedistribute?:boolean;credit?:string;share?:BeautyShare}
export async function readDecorationOrigin(key:string):Promise<DecorationOrigin>{
 if(!key)return {kind:'builtin'};
 const [source,origin]=await Promise.all([DB.getAsset('beauty_source_'+key),DB.getAsset('decoration_origin_'+key)]);
 if(source){const share=JSON.parse(source) as BeautyShare; if(share?.metadata)return {kind:'imported',allowRemix:share.metadata.allowRemix,allowRedistribute:share.metadata.allowRedistribute,credit:share.metadata.credit,share};}
 if(origin)return JSON.parse(origin);
 return {kind:'legacy'};
}
export const originLabel=(origin:DecorationOrigin)=>origin.kind==='self'?'自制':origin.kind==='remix'?'二改':origin.kind==='imported'?(origin.share?'码导入':'文件导入'):origin.kind==='builtin'?'内置':'旧版预设';
export function canEditDecoration(origin:DecorationOrigin){return origin.allowRemix!==false;}
export function combineDecorationOrigins(origins:DecorationOrigin[]):DecorationOrigin{
 const imported=origins.filter(item=>(item.kind==='imported'||item.kind==='remix'));
 if(!imported.length)return {kind:origins.some(item=>item.kind==='legacy')?'legacy':'self'};
 // Multiple authors keep the most restrictive rule; never claim a remix is a self-authored original.
 return {kind:'imported',allowRemix:imported.every(canEditDecoration),allowRedistribute:imported.some(item=>item.allowRedistribute===false)?false:imported.every(item=>item.allowRedistribute===true)?true:undefined,credit:[...new Set(imported.map(item=>item.credit).filter(Boolean))].join(' · ')};
}
export function originAssets(key:string,origin:DecorationOrigin){return [{id:'decoration_origin_'+key,data:JSON.stringify(origin)},...(origin.share?[{id:'beauty_source_'+key,data:JSON.stringify(origin.share)}]:[])];}
export async function writeDecorationOrigin(key:string,origin:DecorationOrigin){
 await DB.saveAsset('decoration_origin_'+key,JSON.stringify(origin));
 if(origin.share)await rememberBeautySource(key,origin.share);
}
// Local-only identity; validateDecoration strips it from exports.
export type LibraryDecoration=DecorationPreset & {_libraryId:string;_collection?:'outfit'};
let queue:Promise<unknown>=Promise.resolve();
function serialized<T>(work:()=>Promise<T>):Promise<T>{const result=queue.then(work);queue=result.catch(()=>{});return result;}
async function readLibrary():Promise<LibraryDecoration[]>{
 const raw=await DB.getAsset(DECORATION_STORE);const values=raw?JSON.parse(raw):[];
 if(!Array.isArray(values))throw Error('装扮收藏格式无效');
 const ids=new Set<string>();let changed=false;const list:LibraryDecoration[]=[];
 for(const value of values){
  let id=typeof value._libraryId==='string'?value._libraryId:'';
  if(!id||ids.has(id)){id='local-chat-'+crypto.randomUUID();changed=true;await writeDecorationOrigin(id,await readDecorationOrigin(await decorationSourceKey(value)));}
  ids.add(id);list.push({...validateDecoration(value),_libraryId:id,...(value._collection==='outfit'?{_collection:'outfit' as const}:{})});
 }
 if(changed)await DB.saveAsset(DECORATION_STORE,JSON.stringify(list));return list;
}
export const readLibraryDecorations=()=>serialized(readLibrary);
export const deleteLibraryDecoration=(id:string)=>serialized(async()=>{
 const list=await readLibrary();if(!list.some(item=>item._libraryId===id))throw Error('这份装扮已不存在');
 await DB.saveAsset(DECORATION_STORE,JSON.stringify(list.filter(item=>item._libraryId!==id)));
});
export const saveLibraryDecoration=(preset:DecorationPreset,origin:DecorationOrigin,replaceKey?:string,collection?:'outfit')=>serialized(async()=>{
 const list=await readLibrary();let index=-1;
 if(replaceKey){
  const original=await readDecorationOrigin(replaceKey);
  if(!['self','remix'].includes(original.kind)||!canEditDecoration(original))throw Error('仅自制或允许二改的副本可以更新原件，请另存副本');
  index=list.findIndex(item=>item._libraryId===replaceKey);
  if(index<0)throw Error('原预设已不存在，请另存为新预设');
 }
 const id=index<0?'local-chat-'+crypto.randomUUID():list[index]._libraryId;
 const item:LibraryDecoration={...await localPreset(preset),_libraryId:id,...(collection==='outfit'||(index>=0&&list[index]._collection==='outfit')?{_collection:'outfit' as const}:{})};
 if(index<0)list.unshift(item);else list[index]=item;
 const provenance=origin.kind==='builtin'?{kind:'self' as const}:origin;
 await DB.saveAssetBatch([{id:DECORATION_STORE,data:JSON.stringify(list)},...originAssets(id,provenance),...originAssets(await decorationSourceKey(item),provenance)]);return id;
});
export const replaceReceivedDecoration=(id:string,preset:DecorationPreset,share:BeautyShare,expectedRevision:string)=>serialized(async()=>{
 const list=await readLibrary();const index=list.findIndex(item=>item._libraryId===id);
 if(index<0)throw Error('原装扮已删除，请重新领取');
 const origin=await readDecorationOrigin(id);
 if(origin.kind!=='imported'||origin.share?.code!==share.code||origin.share.revision!==expectedRevision)throw Error('本机版本已变化，请重新检查更新');
 const next={...await localPreset(preset),_libraryId:id};
 list[index]=next;const originNext:DecorationOrigin={kind:'imported',share};
 await DB.saveAssetBatch([{id:DECORATION_STORE,data:JSON.stringify(list)},...originAssets(id,originNext),...originAssets(await decorationSourceKey(next),originNext)]);
});
export function remixOrigin(origin:DecorationOrigin):DecorationOrigin{
 return origin.kind==='imported'||origin.kind==='remix'?{kind:'remix',credit:origin.credit,allowRemix:origin.allowRemix,allowRedistribute:origin.allowRedistribute}:origin;
}
export function importedOrigin(value:unknown):DecorationOrigin{
 const data=(value as any)?.beautyOrigin;
 return {kind:'imported',allowRemix:typeof data?.allowRemix==='boolean'?data.allowRemix:undefined,allowRedistribute:typeof data?.allowRedistribute==='boolean'?data.allowRedistribute:undefined,credit:typeof data?.credit==='string'?data.credit:undefined};
}

/** Import a legacy batch atomically so a failed import cannot leave half a collection. */
export const saveLibraryDecorationBatch=(items:{preset:DecorationPreset;origin:DecorationOrigin}[])=>serialized(async()=>{
 const list=await readLibrary();const records:{id:string;data:string}[]=[];const added:LibraryDecoration[]=[];
 for(const {preset,origin} of items){const id='local-chat-'+crypto.randomUUID();const item={...await localPreset(preset),_libraryId:id};added.push(item);records.push(...originAssets(id,origin),...originAssets(await decorationSourceKey(item),origin));}
 await DB.saveAssetBatch([{id:DECORATION_STORE,data:JSON.stringify([...added,...list])},...records]);return added;
});
