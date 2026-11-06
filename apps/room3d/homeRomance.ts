import catalog from './chibi/selectedMotionCatalog.json';
import photoPairs from './chibi/photoPairCatalog.json';
import type {Home3DState} from './types';

// User–character intimacy defaults on; character–character pairs remain opt-in.
type RomanceState = Pick<Home3DState,'romanticPairs'|'userRomanceDisabledIds'>;
const intimateExtras=new Set(['cmu-20_10','cmu-22_09']);
export function isRomanticMotion(id:string){return catalog.some(m=>m.id===id&&(m.category==='close'||intimateExtras.has(id)))||photoPairs.some(m=>m.id===id&&m.romantic);}
export function normalizeRomanticPairs(value:unknown):[string,string][]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>100||value.some(p=>!Array.isArray(p)||p.length!==2||p.some(id=>typeof id!=='string'||!id.trim())||p[0]===p[1]))throw Error('家园浪漫关系格式不正确');
 const unique=new Map<string,[string,string]>();for(const pair of value){const sorted=[...pair].sort() as [string,string];unique.set(JSON.stringify(sorted),sorted);}return [...unique.values()];
}
export function normalizeUserRomanceDisabledIds(value:unknown):string[]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!id.trim()||id==='user'))throw Error('家园亲密互动设置格式不正确');
 return [...new Set(value)];
}
export function hasRomanticPair(home:RomanceState,a:string,b?:string){
 if(!a||!b||a===b)return false;
 if(a==='user'||b==='user')return !home.userRomanceDisabledIds?.includes(a==='user'?b:a);
 return Array.isArray(home.romanticPairs)&&home.romanticPairs.some(p=>Array.isArray(p)&&p.length===2&&(p[0]===a&&p[1]===b||p[1]===a&&p[0]===b));
}
export function homeSocialActionAllowed(home:RomanceState,action:string,a:string,b?:string){return !!catalog.find(m=>m.id===action)&&(!isRomanticMotion(action)||hasRomanticPair(home,a,b));}
export function homePhotoActionAllowed(home:RomanceState,action:string,a:string,b?:string){return photoPairs.some(m=>m.id===action)?(!isRomanticMotion(action)||hasRomanticPair(home,a,b)):homeSocialActionAllowed(home,action,a,b);}
export function updateRomanticPair(home:Pick<Home3DState,'romanticPairs'>,a:string,b:string,enabled:boolean){
 const pairs=normalizeRomanticPairs(home.romanticPairs).filter(p=>!(p.includes(a)&&p.includes(b)));
 return normalizeRomanticPairs(enabled?[...pairs,[a,b]]:pairs);
}
export function updateHomeRomanticRelation(home:RomanceState,a:string,b:string,enabled:boolean):RomanceState{
 const romanticPairs=updateRomanticPair(home,a,b,enabled);
 const disabled=new Set(normalizeUserRomanceDisabledIds(home.userRomanceDisabledIds));
 if(a==='user'||b==='user'){const id=a==='user'?b:a;if(enabled)disabled.delete(id);else disabled.add(id);}
 return {romanticPairs,userRomanceDisabledIds:[...disabled]};
}
