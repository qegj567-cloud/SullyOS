import type {CharacterProfile} from '../types';
import type {FriendComment, FriendFeedState, FriendPost} from './friendFeed';
import {createLocalId} from './localId.js';
import {friendAccounts, resolveFriendFeedSettings} from './friendFeedSettings';

export interface FriendAccountRef {id:string; ownerId:string; accountId:string}
export interface FriendAccountGraph {
    version:1;
    accounts:FriendAccountRef[];
    follows:Record<string,string[]>;
    /** Explicit false hides the association in future material, even for mutual follows. */
    known:Record<string,Record<string,boolean>>;
    learned?:Record<string,Record<string,Array<{evidenceId:string;quote:string}>>>;
}
export function validFriendGraph(value:unknown):value is FriendAccountGraph {
    const g=value as FriendAccountGraph;
    const record=(v:unknown)=>!!v&&typeof v==='object'&&!Array.isArray(v);
    return !!g&&g.version===1&&Array.isArray(g.accounts)&&g.accounts.every(a=>a&&[a.id,a.ownerId,a.accountId].every(s=>typeof s==='string'&&s.length>0))
        &&new Set(g.accounts.map(a=>a.id)).size===g.accounts.length
        &&new Set(g.accounts.map(a=>JSON.stringify([a.ownerId,a.accountId]))).size===g.accounts.length
        &&record(g.follows)&&Object.values(g.follows).every(a=>Array.isArray(a)&&a.every(id=>typeof id==='string'))
        &&record(g.known)&&Object.values(g.known).every(v=>record(v)&&Object.values(v).every(b=>typeof b==='boolean'))
        &&(g.learned===undefined||record(g.learned)&&Object.values(g.learned).every(v=>record(v)&&Object.values(v).every(rows=>Array.isArray(rows)&&rows.every(e=>e&&typeof e.evidenceId==='string'&&typeof e.quote==='string'))));
}
export function friendAccountRef(feed:FriendFeedState, row:Pick<FriendComment,'authorId'|'accountId'>) {
    return feed.accountGraph?.accounts.find(a=>a.ownerId===row.authorId&&a.accountId===(row.accountId||'main'));
}
/** Material exposes opaque public IDs, while old actions use local alias IDs.
 * Resolve either spelling only inside the current actor's active accounts. */
export function resolveFriendActingAccount(feed:FriendFeedState,char:Pick<CharacterProfile,'id'|'name'>,id:unknown){
    if(id!==undefined&&typeof id!=='string')return;
    const accounts=friendAccounts(resolveFriendFeedSettings(feed.settings),char),key=(id as string|undefined)?.trim()||'main';
    const local=accounts.find(a=>a.id===key);
    if(local)return local;
    const ref=feed.accountGraph?.accounts.find(a=>a.id===key&&a.ownerId===char.id);
    return ref&&accounts.find(a=>a.id===ref.accountId);
}
export function activeFriendAccounts(feed:FriendFeedState, characters:Pick<CharacterProfile,'id'>[]) {
    const settings=resolveFriendFeedSettings(feed.settings), owners=new Set(['user',...characters.map(c=>c.id)]);
    return (feed.accountGraph?.accounts||[]).filter(a=>owners.has(a.ownerId)
        &&(a.accountId==='main'||a.ownerId!=='user'&&settings.identities[a.ownerId]?.accounts.some(alias=>alias.id===a.accountId)));
}
/** Called inside the existing feed transaction. Opaque IDs never encode a hidden owner. */
export function normalizeFriendGraph(feed:FriendFeedState, characters:Pick<CharacterProfile,'id'>[]) {
    if(!feed.circles.length&&!feed.publicFeed)return;
    const migrating=!feed.accountGraph;
    const graph=feed.accountGraph ||= {version:1,accounts:[],follows:{},known:{}};
    const settings=resolveFriendFeedSettings(feed.settings);
    const add=(ownerId:string,accountId='main')=>{
        let account=graph.accounts.find(a=>a.ownerId===ownerId&&a.accountId===accountId);
        if(!account){account={id:`account-${createLocalId()}`,ownerId,accountId};graph.accounts.push(account);}
        return account;
    };
    const user=add('user');
    for(const char of characters) {
        const main=add(char.id);
        if(!Object.prototype.hasOwnProperty.call(graph.follows,main.id)) {
            const old=feed.follows?.[char.id] ?? (feed.publicFeed?['user']:['user',...(feed.circles.find(c=>c.memberIds.includes(char.id))?.memberIds||[]).filter(id=>id!==char.id)]);
            graph.follows[main.id]=old.map(id=>add(id).id);
            // A newly created character is followed by the user; explicit unfollows survive.
            graph.follows[user.id]=[...new Set([...(graph.follows[user.id]||[]),main.id])];
        }
        for(const account of settings.identities[char.id]?.accounts||[])add(char.id,account.id);
    }
    for(const post of feed.posts) for(const row of [post,...post.comments])add(row.authorId,row.accountId||'main');
    if(migrating) graph.follows[user.id]=characters.map(c=>add(c.id).id);
    const active=new Set(activeFriendAccounts(feed,characters).map(a=>a.id));
    for(const a of graph.accounts)if(a.ownerId.startsWith('npc:')||a.ownerId.startsWith('weibo:')||a.ownerId.startsWith('external:'))active.add(a.id);
    for(const key of Object.keys(graph.follows))graph.follows[key]=active.has(key)?graph.follows[key].filter(id=>active.has(id)):[];
    rememberMutualIdentities(graph);
}
function rememberMutualIdentities(graph:FriendAccountGraph) {
    for(const source of graph.accounts) for(const targetId of graph.follows[source.id]||[]) {
        if(!graph.follows[targetId]?.includes(source.id))continue;
        const target=graph.accounts.find(a=>a.id===targetId);
        if(!target||source.ownerId===target.ownerId)continue;
        const known=graph.known[source.ownerId] ||= {};
        if(known[targetId]===undefined)known[targetId]=true;
    }
}
export function setFriendAccountFollow(feed:FriendFeedState,sourceId:string,targetId:string,following:boolean) {
    const graph=feed.accountGraph!;
    if(sourceId===targetId||!graph.accounts.some(a=>a.id===sourceId)||!graph.accounts.some(a=>a.id===targetId))throw Error('账号已不存在');
    const next=new Set(graph.follows[sourceId]||[]);
    if(following)next.add(targetId);else next.delete(targetId);
    graph.follows[sourceId]=[...next];
    rememberMutualIdentities(graph);
    const source=graph.accounts.find(a=>a.id===sourceId)!;
    if(source.accountId==='main') {
        feed.follows ||= {};
        feed.follows[source.ownerId]=graph.accounts.filter(a=>a.accountId==='main'&&next.has(a.id)).map(a=>a.ownerId);
    }
}
export function knowsFriendAccount(feed:FriendFeedState,viewerId:string,account:FriendAccountRef) {
    return viewerId===account.ownerId||viewerId==='user'||feed.accountGraph?.known[viewerId]?.[account.id]===true;
}
export function followsFriendPost(feed:FriendFeedState,viewerId:string,post:Pick<FriendPost,'authorId'|'accountId'>) {
    const target=friendAccountRef(feed,post);
    return !!target&&feed.accountGraph?.accounts.some(a=>a.ownerId===viewerId&&feed.accountGraph!.follows[a.id]?.includes(target.id))===true;
}
export function friendAccountName(feed:FriendFeedState,account:FriendAccountRef,characters:Pick<CharacterProfile,'id'|'name'>[],userName='我') {
    const settings=resolveFriendFeedSettings(feed.settings);
    if(account.ownerId==='user')return settings.userNickname||userName;
    const char=characters.find(c=>c.id===account.ownerId);
    const configured=char&&friendAccounts(settings,char).find(a=>a.id===account.accountId);
    return configured?.name||feed.posts.flatMap(p=>[p,...p.comments]).find(c=>c.authorId===account.ownerId&&(c.accountId||'main')===account.accountId)?.authorName||'已停用账号';
}
/** Actor knowledge is separate from routing. No owner key or local alias ID escapes when unknown. */
export function projectFriendComment(feed:FriendFeedState,viewerId:string,row:FriendComment):FriendComment {
    const ref=friendAccountRef(feed,row), known=ref&&knowsFriendAccount(feed,viewerId,ref);
    return {...row,authorId:known?row.authorId:ref?.id||`unmapped-${row.id}`,accountId:ref?.id,
        ...(row.localReply?{localReply:projectFriendQuote(feed,viewerId,row.localReply)}:{})};
}
function projectFriendQuote(feed:FriendFeedState,viewerId:string,quote:NonNullable<FriendComment['localReply']>) {
    const target=feed.posts.flatMap(p=>p.comments).find(c=>c.id===quote.id);
    const projected=target?projectFriendComment(feed,viewerId,{...target,localReply:undefined}):undefined;
    return {...quote,authorId:projected?.authorId||'unknown-account'};
}
export function projectFriendPost(feed:FriendFeedState,viewerId:string,post:FriendPost):FriendPost {
    return {...post,...projectFriendComment(feed,viewerId,post),audienceIds:[],comments:post.comments.map(c=>projectFriendComment(feed,viewerId,c))};
}
export function friendKnownIdentity(feed:FriendFeedState,viewerId:string,row:Pick<FriendComment,'authorId'|'accountId'>,characters:Pick<CharacterProfile,'id'|'name'>[],userName='用户') {
    const account=friendAccountRef(feed,row);
    return account&&knowsFriendAccount(feed,viewerId,account)?row.authorId==='user'?userName:characters.find(c=>c.id===row.authorId)?.name:undefined;
}
export function friendPublicName(feed:FriendFeedState,viewerId:string,row:Pick<FriendComment,'authorId'|'accountId'|'authorName'>,characters:Pick<CharacterProfile,'id'|'name'>[]) {
    const identity=friendKnownIdentity(feed,viewerId,row,characters);
    return row.authorName+(identity&&identity!==row.authorName?`（${identity}）`:'');
}
export function friendGraphStamp(feed:FriendFeedState) {
    const graph=feed.accountGraph,owners=new Set(['user',...feed.circles.flatMap(c=>c.memberIds)]);
    return JSON.stringify([graph&&{...graph,accounts:graph.accounts.filter(a=>owners.has(a.ownerId))},resolveFriendFeedSettings(feed.settings).identities,resolveFriendFeedSettings(feed.settings).userNickname]);
}
