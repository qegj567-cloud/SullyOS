import catalog from './chibi/selectedMotionCatalog.json';
import type {Home3DState} from './types';

// Close-category actions and these intimate-looking care/play clips require an
// explicit pair. Affinity, nickname, cohabitation and model prose never grant it.
const intimateExtras=new Set(['cmu-20_10','cmu-22_09']);
export function isRomanticMotion(id:string){return catalog.some(m=>m.id===id&&(m.category==='close'||intimateExtras.has(id)));}
export function normalizeRomanticPairs(value:unknown):[string,string][]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>100||value.some(p=>!Array.isArray(p)||p.length!==2||p.some(id=>typeof id!=='string'||!id.trim())||p[0]===p[1]))throw Error('家园浪漫关系格式不正确');
 const unique=new Map<string,[string,string]>();for(const pair of value){const sorted=[...pair].sort() as [string,string];unique.set(JSON.stringify(sorted),sorted);}return [...unique.values()];
}
export function hasRomanticPair(home:Pick<Home3DState,'romanticPairs'>,a:string,b?:string){return !!a&&!!b&&a!==b&&Array.isArray(home.romanticPairs)&&home.romanticPairs.some(p=>Array.isArray(p)&&p.length===2&&(p[0]===a&&p[1]===b||p[1]===a&&p[0]===b));}
export function homeSocialActionAllowed(home:Pick<Home3DState,'romanticPairs'>,action:string,a:string,b?:string){return !!catalog.find(m=>m.id===action)&&(!isRomanticMotion(action)||hasRomanticPair(home,a,b));}
export function updateRomanticPair(home:Pick<Home3DState,'romanticPairs'>,a:string,b:string,enabled:boolean){
 const pairs=normalizeRomanticPairs(home.romanticPairs).filter(p=>!(p.includes(a)&&p.includes(b)));
 return normalizeRomanticPairs(enabled?[...pairs,[a,b]]:pairs);
}
