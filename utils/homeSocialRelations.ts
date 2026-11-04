import type {CharacterProfile} from '../types';

export interface HomeRelation {known:boolean;blocked:boolean;affinity:number}
/** Directional, ID-only, read-only. Nicknames and NPC names never resolve identities. */
export function homeRelation(from:CharacterProfile,toId:string):HomeRelation {
 const matches=(from.phoneState?.contacts||[]).filter(c=>c.kind==='real'&&c.linkedCharId===toId);
 if(matches.some(c=>c.status==='blocked'))return {known:true,blocked:true,affinity:-100};
 const contact=matches.find(c=>c.status==='friend');
 return contact?{known:true,blocked:false,affinity:Math.max(-100,Math.min(100,Number.isFinite(contact.affinity)?contact.affinity:0))}:{known:false,blocked:false,affinity:0};
}
export function homeSocialPair(a:CharacterProfile,b:CharacterProfile){
 const forward=homeRelation(a,b.id),backward=homeRelation(b,a.id);
 return {forward,backward,blocked:forward.blocked||backward.blocked,
  approach:forward.blocked||backward.blocked?0:forward.known?Math.max(.05,Math.min(.85,.35+forward.affinity/200)):.15,
  receptive:backward.known&&backward.affinity>=20&&!forward.blocked&&!backward.blocked};
}
/** Only the speaker's own structured view is available to their request. */
export function homeSocialRelationPrompt(char:CharacterProfile,others:Array<{id:string;name:string}>){
 return others.filter(p=>p.id!==char.id&&p.id!=='user').map(p=>{
  const r=homeRelation(char,p.id);return {id:p.id,name:p.name,relationship:r.blocked?'你已拉黑此人':r.known?'你通讯录中的熟人':'尚无明确熟人关系',...(r.known?{yourAffinity:r.affinity}:{})};
 });
}
