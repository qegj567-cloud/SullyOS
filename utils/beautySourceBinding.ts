import type {BeautyShareSelection} from './beautyShareContents';
import {DB} from './db';
import {normalizeBeautyPackage} from './beautyShareClient';
import type {BeautyKind} from './beautyShareContract';
export interface BeautySourceBinding {sourceId:string;kind:BeautyKind;fingerprint:string;revision:string;selection?:BeautyShareSelection}
const key=(author:string,id:string)=>'beauty_binding_'+author+'_'+id;
function canonical(value:any):any {return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])])):value;}
export async function beautyFingerprint(pack:unknown,kind:BeautyKind){
 const normalized=normalizeBeautyPackage(pack,kind) as any;
 // Export timestamps and local IDs are not an appearance change.
 const {exportedAt,createdAt,id,...content}=normalized;
 const bytes=new TextEncoder().encode(JSON.stringify(canonical(content)));
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export async function readBeautyBinding(author:string,id:string):Promise<BeautySourceBinding|null>{const raw=await DB.getAsset(key(author,id));return raw?JSON.parse(raw):null;}
export async function bindBeautySource(author:string,id:string,binding:BeautySourceBinding){await DB.saveAsset(key(author,id),JSON.stringify(binding));}
