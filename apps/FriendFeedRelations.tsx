import React,{useState} from 'react';
import type {CharacterGroup,CharacterProfile,UserProfile} from '../types';
import FriendFeedCharacterPicker, {FriendFeedGroupedList} from './FriendFeedGroupedList';
import type {FriendFeedState} from '../utils/friendFeed';
import {updateFriendRelation} from '../utils/friendFeed';
import {activeFriendAccounts,friendAccountName,friendAccountRef,knowsFriendAccount} from '../utils/friendFeedGraph';
import './friendFeedRelations.css';

export default function FriendFeedRelations({feed,characters,groups=[],user,onProfile,onChange=updateFriendRelation,initialOwner='user',onOwnerChange}:{feed:FriendFeedState;characters:CharacterProfile[];groups?:CharacterGroup[];user:UserProfile;onProfile?:(id:string)=>void;onChange?:typeof updateFriendRelation;initialOwner?:string;onOwnerChange?:(id:string)=>void}) {
    const [selectedOwner,setOwner]=useState(initialOwner),[selected,setSelected]=useState(''),[preview,setPreview]=useState(false);
    const owner=selectedOwner==='user'||characters.some(c=>c.id===selectedOwner)?selectedOwner:'user';
    const [busy,setBusy]=useState(false),[error,setError]=useState('');
    const accounts=activeFriendAccounts(feed,characters),own=accounts.filter(a=>a.ownerId===owner);
    const source=own.find(a=>a.id===selected)||own[0],graph=feed.accountGraph;
    const name=(a:typeof accounts[number])=>friendAccountName(feed,a,characters,user.name);
    const ownerName=(id:string)=>id==='user'?'用户':characters.find(c=>c.id===id)?.name||'已移除角色';
    const published=new Set(feed.posts.flatMap(p=>[p,...p.comments]).map(p=>friendAccountRef(feed,p)?.id));
    const targets=accounts.filter(a=>a.ownerId!==owner&&(!preview||a.accountId==='main'||published.has(a.id)||knowsFriendAccount(feed,owner,a)||!!source&&graph?.follows[source.id]?.includes(a.id)))
        .sort((a,b)=>name(a).localeCompare(name(b),'zh-CN'));
    const characterMap=new Map(characters.map(c=>[c.id,c]));
    const targetRows=targets.map(a=>({...a,groupId:a.ownerId==='user'?'__bibi_user__':characterMap.get(a.ownerId)?.groupId,
        searchText:name(a)+(!preview?` ${ownerName(a.ownerId)}`:'')}));
    const change=async(value:Parameters<typeof updateFriendRelation>[0])=>{
        if(busy)return;setBusy(true);setError('');
        try{await onChange(value);}catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}
    };
    return <div className="ff-relations">
        <FriendFeedCharacterPicker label="关系所属人物" characters={characters} groups={groups} value={owner} includeUser disabled={busy}
            onChange={id=>{setOwner(id);onOwnerChange?.(id);setSelected('');setPreview(false);}}/>
        {own.length>1&&<label className="ff-setting-field">使用哪个账号<select aria-label="发起关注的账号" value={source?.id||''} onChange={e=>setSelected(e.target.value)}>
            {own.map(a=><option value={a.id} key={a.id}>{name(a)}{a.accountId==='main'?' · 主号':''}</option>)}
        </select></label>}
        {owner!=='user'&&<div className="ff-relation-modes" role="group" aria-label="关系查看模式">
            <button type="button" aria-pressed={!preview} onClick={()=>setPreview(false)}>管理关系</button>
            <button type="button" aria-pressed={preview} onClick={()=>setPreview(true)}>以 {ownerName(owner)} 视角查看</button>
        </div>}
        <p className="ff-relation-caption">{preview?'只显示 TA 能知道的身份。未认出的账号不会按主人归组。':'修改立即保存。互关会认出参与互关的两个账号，不会顺带认出其他小号。'}</p>
        {error&&<p role="alert" className="friend-feed-error">{error}</p>}
        <div className="ff-relation-list" aria-label={preview?'角色可见账号':'账号关系列表'}>
            {source&&<FriendFeedGroupedList key={`${owner}:${preview}`} stateKey={`relations:${owner}:${preview}`} items={targetRows} groups={[{id:'__bibi_user__',name:'我',order:-1},...groups]}
                label="关系账号" searchLabel="搜索账号" showGroups={!preview} disabled={busy} renderItem={a=>{
                const following=graph?.follows[source.id]?.includes(a.id)===true,back=graph?.follows[a.id]?.includes(source.id)===true,known=knowsFriendAccount(feed,owner,a);
                return <article className="ff-relation-item" key={a.id}>
                    <div className="ff-relation-person"><span className="ff-relation-face" aria-hidden="true">{name(a).slice(0,1)}</span>
                        <div><strong>{name(a)}</strong><small>{preview?(known?`你知道是 ${ownerName(a.ownerId)}`:'身份未知'):`${ownerName(a.ownerId)} · ${a.accountId==='main'?'主号':'小号'}`}</small></div>
                        {onProfile&&!preview&&<button type="button" className="ff-setting-link" onClick={()=>onProfile(a.id)}>主页 ↗</button>}
                    </div>
                    <div className="ff-relation-edges">
                        {preview?<><span>{following?'已关注':'未关注'}{following&&back?' · 互关':''}</span><span>{known?'认得身份':'只认网名'}</span></>:<>
                            <label><input type="checkbox" aria-label={`关注 ${name(a)}`} checked={following} disabled={busy} onChange={e=>void change({kind:'follow',sourceId:source.id,targetId:a.id,value:e.target.checked})}/>{following&&back?'互相关注':'关注这个号'}</label>
                            {owner!=='user'&&<label><input type="checkbox" aria-label={`知道 ${name(a)} 是谁`} checked={known} disabled={busy} onChange={e=>void change({kind:'known',viewerId:owner,targetId:a.id,value:e.target.checked})}/>知道是 {ownerName(a.ownerId)}</label>}
                        </>}
                    </div>
                </article>;
            }}/>}
        </div>
        {!targets.length&&<p className="ff-relation-caption">没有匹配的账号。</p>}
        {owner!=='user'&&<p className="ff-relation-caption">身份认知由这个角色的所有账号共用。取关不会忘记身份；取消“知道是谁”不会删除已有私聊、世界书或记忆中的信息。之后看到新的明确掉马说明，或你重新告诉 TA，仍可再次认出。</p>}
    </div>;
}
