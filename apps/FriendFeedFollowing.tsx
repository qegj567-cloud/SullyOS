import React, {useEffect, useRef, useState} from 'react';
import {CaretRight} from '@phosphor-icons/react';
import type {CharacterGroup,CharacterProfile,UserProfile} from '../types';
import {FriendFeedGroupedList} from './FriendFeedGroupedList';
import type {FriendFeedState} from '../utils/friendFeed';
import {activeFriendAccounts,friendAccountName,friendAccountRef} from '../utils/friendFeedGraph';
import {fetchWeibo, readWeiboConnection, WEIBO_CONNECTION_CHANGED, type WeiboFollowAccount} from '../utils/friendFeedWeibo';
import FriendFeedAvatar from './FriendFeedAvatar';
import {isWeiboImageUrl} from '../utils/friendFeedSource';

/** Session-only UI data; never added to character subscriptions, memory or model context. */
export function useWeiboFollowing() {
    const [connection, setConnection] = useState(readWeiboConnection);
    const [accounts, setAccounts] = useState<WeiboFollowAccount[]>([]);
    const [next, setNext] = useState<{page:number;cursor:string}>(), [loaded,setLoaded] = useState(false);
    const [busy,setBusy] = useState(false), [error,setError] = useState(''), [filtered,setFiltered] = useState(false);
    const generation = useRef(0), running = useRef(false);
    useEffect(() => {
        const changed = () => {generation.current++; running.current=false; setConnection(readWeiboConnection()); setAccounts([]);setNext(undefined);setLoaded(false);setBusy(false);setError('');setFiltered(false);};
        window.addEventListener(WEIBO_CONNECTION_CHANGED,changed);
        return () => {generation.current++;window.removeEventListener(WEIBO_CONNECTION_CHANGED,changed);};
    }, []);
    const load = async (more=false) => {
        if(running.current || more&&!next)return;
        const current=readWeiboConnection(); if(!current){setConnection(undefined);setError('请先连接微博');return;}
        const version=generation.current; running.current=true;setBusy(true);setError('');
        try {
            const data=await fetchWeibo('followingAccounts',more?next:{page:1,cursor:''});
            if(version!==generation.current || readWeiboConnection()?.id!==current.id)return;
            if(!Array.isArray(data.accounts))throw Error('当前连接服务尚未支持关注名单，请更新 Worker');
            const rows=data.accounts.filter(a=>a&&/^\d{4,25}$/.test(a.uid)&&typeof a.name==='string'&&typeof a.description==='string');
            const old=more?accounts:[], merged=[...new Map([...old,...rows].map(a=>[a.uid,a])).values()];
            setAccounts(merged);setLoaded(true);setFiltered(data.filtered===true || more&&filtered);
            setNext(data.nextPage&&data.nextCursor&&(!more||merged.length>old.length)?{page:data.nextPage,cursor:data.nextCursor}:undefined);
        } catch(e) {if(version===generation.current)setError(e instanceof Error?e.message:'关注名单读取失败');}
        finally {if(version===generation.current){running.current=false;setBusy(false);}}
    };
    return {connection,accounts,next,loaded,busy,error,filtered,load};
}

export default function FriendFeedFollowing({characters, groups=[], weibo, onProfile, onConnect,feed,user,onManage}: {
    feed:FriendFeedState;user:UserProfile;onManage:()=>void;
    characters:CharacterProfile[];groups?:CharacterGroup[];weibo:ReturnType<typeof useWeiboFollowing>;onProfile:(id:string)=>void;onConnect:()=>void;
}) {
    const source=friendAccountRef(feed,{authorId:'user'});
    const accounts=activeFriendAccounts(feed,characters).filter(a=>source&&feed.accountGraph?.follows[source.id]?.includes(a.id));
    const characterMap=new Map(characters.map(c=>[c.id,c]));
    return <div className="ff-following-directory">
        <section aria-label="关注的角色"><header><h2>账号 <small>{accounts.length}</small></h2><button className="ff-setting-link" onClick={onManage}>管理关注与身份</button></header>
            {!accounts.length&&<p>还没有关注的账号，可以在关系设置里添加。</p>}
            {!!accounts.length&&<FriendFeedGroupedList items={accounts.map(a=>({...a,groupId:characterMap.get(a.ownerId)?.groupId,searchText:`${friendAccountName(feed,a,characters,user.name)} ${characterMap.get(a.ownerId)?.name??''}`}))} groups={groups} label="关注账号" searchLabel="搜索关注账号" renderItem={account=>{const name=friendAccountName(feed,account,characters,user.name);return <button className="ff-following-person" key={account.id} onClick={()=>onProfile(account.id)}>
                <FriendFeedAvatar name={name} avatar={account.accountId==='main'?characters.find(c=>c.id===account.ownerId)?.avatar:undefined}/><span><strong>{name}</strong><small>查看这个账号的主页</small></span><CaretRight size={16}/>
            </button>;}}/>}
        </section>
        <section aria-label="真实微博关注"><header><h2>微博关注</h2>{weibo.loaded&&<span>已读取 {weibo.accounts.length} 人</span>}</header>
            <p>来自你登录的微博账号，与角色关注分开展示。</p>
            {!weibo.connection?<button className="ff-following-load" onClick={onConnect}>连接微博</button>:<>
                <button className="ff-following-load" disabled={weibo.busy} onClick={()=>void weibo.load()}>{weibo.busy?'正在读取…':weibo.loaded?'刷新微博关注':'读取微博关注'}</button>
                {weibo.accounts.map(account=><button className="ff-following-person" key={account.uid} onClick={()=>onProfile('weibo:'+account.uid)}>
                    <FriendFeedAvatar name={account.name} avatar={isWeiboImageUrl(account.avatar)?account.avatar:undefined}/><span><strong>{account.name}</strong><small>{account.description||'在微博打开主页 ↗'}</small></span><CaretRight size={16}/>
                </button>)}
                {weibo.next&&<button className="ff-following-load" disabled={weibo.busy} onClick={()=>void weibo.load(true)}>更多微博关注</button>}
                {weibo.loaded&&!weibo.accounts.length&&<p>微博暂未返回可见的关注账号。</p>}
                {weibo.filtered&&<p>微博隐藏了部分账号，这里只能展示接口返回的可见名单。</p>}
            </>}
            {weibo.error&&<p role="alert">{weibo.error}</p>}
        </section>
    </div>;
}
