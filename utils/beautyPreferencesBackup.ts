import {validateBeautyMetadata,type BeautyShare} from './beautyShareContract';
// Personal backup only. Deliberately exclude sessions, passwords and device identifiers.
const USAGE='sully-beauty-usage-v1',REPO='sully-beauty-repo-status-v1',DEFAULTS='sully-beauty-author-defaults-v1';
const FLAGS=['sullyos_chat_wardrobe_update_v2_seen','sullyos_chat_wardrobe_guide_v2_done','sully-beauty-catalog-notice-v1','sully-beauty-author-notice-v1'];
export interface BeautyPreferencesBackup {version:1;values:Record<string,unknown>}
const record=(value:any):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const code=(value:unknown):value is string=>typeof value==='string'&&/^S-[A-F0-9]{12}$/.test(value);
function clean(key:string,value:any):unknown{
 if(FLAGS.includes(key)){if(typeof value!=='string')throw Error('美化引导记录无效');return value.slice(0,40);}
 if(!record(value))throw Error('美化偏好格式无效');
 if(key===REPO)return Object.fromEntries(Object.entries(value).filter(([id,status])=>code(id)&&(status==='manual'||status==='submitted')));
 if(key===DEFAULTS){const metadata=validateBeautyMetadata({...value,name:'备份默认信息'});return {...metadata,name:''};}
 if(key===USAGE){
  if(!Array.isArray(value.uses)||!Array.isArray(value.reminded))throw Error('美化使用记录无效');
  const uses=value.uses.flatMap((item:any)=>{try{
   if(!record(item)||typeof item.target!=='string'||item.target.length>200||!Number.isFinite(item.startedAt)||item.startedAt<0)throw Error();
   const s=item.share;if(!record(s)||!code(s.code)||!['appearance','chat-decoration'].includes(s.kind)||typeof s.revision!=='string'||s.revision.length>200||typeof s.sha256!=='string'||!Number.isFinite(s.bytes))throw Error();
   const share:BeautyShare={code:s.code,kind:s.kind,revision:s.revision,metadata:validateBeautyMetadata(s.metadata),bytes:s.bytes,sha256:s.sha256};
   return [{target:item.target,startedAt:item.startedAt,share}];
  }catch{return [];}});
  return {uses,reminded:[...new Set(value.reminded.filter(code))],disabled:value.disabled===true,lastPromptAt:Number.isFinite(value.lastPromptAt)&&value.lastPromptAt>=0?value.lastPromptAt:0};
 }
 throw Error('未知美化偏好');
}
export function exportBeautyPreferences():BeautyPreferencesBackup{
 const values:Record<string,unknown>={};for(const key of [USAGE,REPO,DEFAULTS,...FLAGS])try{const raw=localStorage.getItem(key);if(raw!==null)values[key]=clean(key,FLAGS.includes(key)?raw:JSON.parse(raw));}catch{/* A broken optional setting must not block a personal backup. */}
 return {version:1,values};
}
export function importBeautyPreferences(value:unknown){
 if(value===undefined)return;if(!record(value)||value.version!==1||!record(value.values))throw Error('美化偏好备份版本无效');
 const entries=[USAGE,REPO,DEFAULTS,...FLAGS].filter(key=>Object.prototype.hasOwnProperty.call(value.values,key)).map(key=>[key,clean(key,value.values[key])] as const);
 for(const [key,data] of entries)localStorage.setItem(key,FLAGS.includes(key)?data as string:JSON.stringify(data));
 if(typeof window!=='undefined')for(const name of ['sully-beauty-usage-change','sully-beauty-repo-status-change'])window.dispatchEvent(new Event(name));
}
