import type {CharacterProfile} from '../types';
import type {FriendFeedState, FriendPost} from './friendFeed';
import {friendAccountRef, followsFriendPost, knowsFriendAccount} from './friendFeedGraph';
import {friendAccounts, type FriendFeedSettings} from './friendFeedSettings';

export function weightedFriendPick<T>(entries:{value:T;weight:number}[],random=Math.random):T|undefined {
    const eligible=entries.filter(e=>Number.isFinite(e.weight)&&e.weight>0),total=eligible.reduce((n,e)=>n+e.weight,0);
    if(!total)return;
    let roll=Math.max(0,Math.min(1-Number.EPSILON,random()))*total;
    return eligible.find(e=>(roll-=e.weight)<0)?.value;
}

const norm = (tag:string) => tag.normalize('NFKC').trim().replace(/^#+/, '').trim().toLocaleLowerCase();
export const friendCommunityTags = (settings:FriendFeedSettings, char:CharacterProfile) =>
    [...new Set(friendAccounts(settings,char).flatMap(a=>a.tags).map(norm).filter(Boolean))];
export function friendRelationshipBlocked(a:CharacterProfile, b?:CharacterProfile) {
    const blocked=(from:CharacterProfile,to?:CharacterProfile)=>!!to&&from.phoneState?.contacts?.some(c=>c.kind==='real'&&c.linkedCharId===to.id&&['blocked','deleted'].includes(c.status));
    return blocked(a,b)||!!b&&blocked(b,a);
}
/** Only public tags and contact IDs determine the pool; another person's private history is never assembled. */
export function friendCommentPool(characters:CharacterProfile[],post:FriendPost,settings:FriendFeedSettings,feed?:FriendFeedState) {
    const owner=characters.find(c=>c.id===post.authorId);
    const topics=new Set((post.accountTags|| (owner?friendAccounts(settings,owner).find(a=>a.id===(post.accountId||'main'))?.tags:[])||[]).map(norm));
    const account=feed&&friendAccountRef(feed,post);
    const eligible=characters.filter(c=>(settings.characterWeights[c.id]??10)>0&&!friendRelationshipBlocked(c,owner));
    const related=eligible.filter(c=>c.id!==post.authorId&&(
        ((!feed||!!account&&knowsFriendAccount(feed,c.id,account))&&(owner?.phoneState?.contacts?.some(r=>r.kind==='real'&&r.linkedCharId===c.id&&r.status==='friend') ||
        c.phoneState?.contacts?.some(r=>r.kind==='real'&&r.linkedCharId===post.authorId&&r.status==='friend'))) ||
        friendCommunityTags(settings,c).some(t=>topics.has(t))));
    if(related.length)return related;
    const followers=feed?eligible.filter(c=>followsFriendPost(feed,c.id,post)):[];
    return followers.length?[...new Set([...(owner&&eligible.includes(owner)?[owner]:[]),...followers])]:eligible;
}
export function friendCommunityPrompt(settings:FriendFeedSettings,char:CharacterProfile) {
    const contacts=(char.phoneState?.contacts||[]).filter(c=>c.kind==='npc'&&c.status==='friend').slice(0,12);
    const known=(char.phoneState?.contacts||[]).filter(c=>c.kind==='real'&&c.status==='friend').slice(0,30);
    return '共同话题像开放的兴趣俱乐部，不是隔离的群。同话题不等于已经认识，不编造共同经历。你参与的话题：'+JSON.stringify(friendCommunityTags(settings,char))+
        '\n你自己的既有关系（按角色 ID 识人，仅影响你自己的态度，不主动公开关系隐私）：'+JSON.stringify(known.map(c=>({authorId:c.linkedCharId,name:c.name,identity:c.identity,affinity:c.affinity})))+
        '\n你自己的 NPC 联系人（名字沿用，只有公开身份可用于互动，不泄露私聊或备注）：'+JSON.stringify(contacts.map(c=>({name:c.name,identity:c.identity})))+
        '\n相关路人优先从这些联系人、已加载世界书与本人公开生活中衍生；纯路人与这些关系无关。';
}
