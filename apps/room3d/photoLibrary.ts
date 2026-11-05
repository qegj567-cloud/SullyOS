import poses from './chibi/photoPoseCatalog.json';
import {selectedMotions,loadSelectedMotion,type SelectedClip} from './chibi/selectedMotions';
import photoPairs from './chibi/photoPairCatalog.json';
export interface PhotoEntry {id:string;label:string;kind:'pose'|'motion'|'pair';category:string;duration:number;participants:number;thumbnail?:string;defaultTime?:number;photoOnly?:boolean}
export const photoLibrary:PhotoEntry[]=[
 ...photoPairs.map(p=>({...p,kind:'pair' as const,participants:2,photoOnly:true})),
 ...poses.map(p=>({...p,kind:'pose' as const})),
 ...selectedMotions.map(p=>({...p,kind:p.participants===2?'pair' as const:'motion' as const,thumbnail:undefined})),
];
const cache=new Map<string,Promise<SelectedClip>>();
export function loadPhotoClip(id:string){
 const pair=photoPairs.find(p=>p.id===id),p=poses.find(p=>p.id===id);if(!p&&!pair)return loadSelectedMotion(id);
 const path=pair?`photo-pairs/${id}.json`:`photo/${p!.file}`;
 if(!cache.has(id))cache.set(id,fetch(`${import.meta.env.BASE_URL}room3d/motions/${path}`).then(async r=>{if(!r.ok)throw Error('姿势加载失败');const clip=await r.json();if(clip.version!==1||clip.id!==id||clip.actors?.length!==(pair?2:1))throw Error('姿势数据不匹配');return clip;}).catch(e=>{cache.delete(id);throw e;}));
 return cache.get(id)!;
}
