import {normalizePetHat} from './petWardrobe.js';
export const PET_CAPACITY=7;
export const PET_TRAITS={clingy:'黏人',independent:'独立',greedy:'贪吃',playful:'爱玩',shy:'胆小',lazy:'慵懒'};
export const PET_NEEDS={food:'饱食',energy:'精力',social:'亲近',fun:'趣味'};
export const PET_ACTIONS={idle:'发呆',wander:'四处看看',eat:'吃东西',sleep:'睡觉',play:'玩耍',approach:'靠近',attention:'撒娇',carry:'抱在怀里',pet:'被摸摸',feed:'吃零食',rest:'休息'};
const clamp=v=>Math.max(0,Math.min(100,v));
const number=(v,f)=>Number.isFinite(v)?v:f;
export function normalizePetLife(raw,home,catalog){
 const ids=new Set(),assets=new Set(catalog.filter(a=>a.petSpecies).map(a=>a.id));
 const pets=(Array.isArray(raw?.pets)?raw.pets:[]).slice(0,PET_CAPACITY).filter(p=>p&&typeof p.id==='string'&&!ids.has(p.id)&&ids.add(p.id)&&assets.has(p.assetId)).map(p=>({
  id:p.id,name:String(p.name||'小伙伴').slice(0,24),assetId:p.assetId,roomId:home.rooms.some(r=>r.id===p.roomId)?p.roomId:home.activeRoomId,
  x:Math.max(-4,Math.min(4,number(p.x,0))),z:Math.max(-3.3,Math.min(3.3,number(p.z,0))),rotation:number(p.rotation,0),color:/^#[\da-f]{6}$/i.test(p.color)?p.color:null,
  materialColors:Object.fromEntries((catalog.find(a=>a.id===p.assetId)?.colorParts||[]).filter(part=>/^#[\da-f]{6}$/i.test(p.materialColors?.[part.material])).map(part=>[part.material,p.materialColors[part.material]])),
  hat:normalizePetHat(p.hat),
  traits:[...new Set(Array.isArray(p.traits)?p.traits:[])].filter(t=>Object.hasOwn(PET_TRAITS,t)).slice(0,2),
  needs:Object.fromEntries(Object.keys(PET_NEEDS).map(k=>[k,clamp(number(p.needs?.[k],75))])),
  relations:Object.fromEntries(Object.entries(p.relations||{}).filter(([id,v])=>id.length<100&&Number.isFinite(v)).slice(0,30).map(([id,v])=>[id,clamp(v)])),
  memory:{lastFedBy:typeof p.memory?.lastFedBy==='string'?p.memory.lastFedBy:null,lastPlayedBy:typeof p.memory?.lastPlayedBy==='string'?p.memory.lastPlayedBy:null,favoriteSpot:typeof p.memory?.favoriteSpot==='string'?p.memory.favoriteSpot:null,recentAction:Object.hasOwn(PET_ACTIONS,p.memory?.recentAction)?p.memory.recentAction:null},
  bondCooldown:Math.max(0,Math.min(30,number(p.bondCooldown,0))),
  sourceFurnitureId:typeof p.sourceFurnitureId==='string'?p.sourceFurnitureId:null,
 }));
 return {version:1,autonomy:raw?.autonomy!==false,pets,supplies:Object.fromEntries(Object.entries(raw?.supplies||{}).filter(([id,v])=>home.rooms.some(r=>r.items.some(i=>i.id===id&&i.assetId==='pet_bowls'))&&Number.isFinite(v)).map(([id,v])=>[id,Math.max(0,Math.min(5,Math.floor(v)))])),events:(Array.isArray(raw?.events)?raw.events:[]).filter(e=>e&&typeof e.text==='string'&&typeof e.petId==='string'&&Number.isFinite(e.at)).slice(-80).map(e=>({petId:e.petId.slice(0,100),petName:String(e.petName||'小伙伴').slice(0,24),at:e.at,text:e.text.slice(0,160)}))};
}
