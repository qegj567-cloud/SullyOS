import React, {createContext, useContext, useMemo, useRef, useState} from 'react';
import {CaretDown} from '@phosphor-icons/react';
import type {CharacterGroup, CharacterProfile} from '../types';
import {useLocalBackHandler} from '../hooks/useLocalBackHandler';
import './friendFeedDirectory.css';

const PAGE_SIZE = 10;
const ALL = '__all__', UNGROUPED = '__ungrouped__';
export interface DirectoryItem {id: string; groupId?: string; searchText: string}
type DirectoryState = {query:string;group:string;page:number};
const DirectoryContext=createContext<Map<string,DirectoryState>|null>(null);
export function FriendFeedDirectoryProvider({children}:{children:React.ReactNode}) {
    const states=useRef(new Map<string,DirectoryState>());
    return <DirectoryContext.Provider value={states.current}>{children}</DirectoryContext.Provider>;
}

/** Filters the entire collection before paging; only the current ten rows mount. */
export function FriendFeedGroupedList<T extends DirectoryItem>({items, groups = [], label, stateKey = label, searchLabel = '搜索角色', showGroups = true, disabled = false, renderItem}: {
    items: T[]; groups?: CharacterGroup[]; label: string; searchLabel?: string; showGroups?: boolean; disabled?: boolean;
    stateKey?: string; renderItem: (item: T) => React.ReactNode;
}) {
    const states=useContext(DirectoryContext);
    const [filter,setFilter]=useState<DirectoryState>(()=>states?.get(stateKey)??{query:'',group:ALL,page:0});
    const {query,group,page}=filter;
    const update=(patch:Partial<DirectoryState>)=>{const next={...filter,...patch};states?.set(stateKey,next);setFilter(next);};
    const top=useRef<HTMLDivElement>(null);
    const orderedGroups=useMemo(()=>[...groups].sort((a,b)=>(a.order??a.createdAt??0)-(b.order??b.createdAt??0)),[groups]);
    const groupMap=useMemo(()=>new Map(orderedGroups.map((g,i)=>[g.id,{...g,index:i}])),[orderedGroups]);
    const groupKey=(item:T)=>item.groupId&&groupMap.has(item.groupId)?item.groupId:UNGROUPED;
    const activeGroup=group===UNGROUPED||groupMap.has(group)?group:ALL;
    const counts=new Map<string,number>();
    for(const item of items){const key=groupKey(item);counts.set(key,(counts.get(key)??0)+1);}
    const needle=query.trim().toLocaleLowerCase();
    const filtered=items.filter(item=>(!showGroups||activeGroup===ALL||groupKey(item)===activeGroup)&&item.searchText.toLocaleLowerCase().includes(needle))
        .sort((a,b)=>showGroups?(groupMap.get(a.groupId??'')?.index??orderedGroups.length)-(groupMap.get(b.groupId??'')?.index??orderedGroups.length):0);
    const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE)), current=Math.min(page,pages-1);
    const visible=filtered.slice(current*PAGE_SIZE,(current+1)*PAGE_SIZE);
    const changePage=(next:number)=>{update({page:next});top.current?.scrollIntoView?.({block:'start'});};
    return <div className="ff-grouped-directory" aria-label={label} ref={top}>
        <div className="ff-directory-filters">
            <input type="search" aria-label={searchLabel} placeholder={searchLabel} value={query} disabled={disabled} onChange={e=>update({query:e.target.value,page:0})}/>
            {showGroups&&<select aria-label={`${label}分组`} value={activeGroup} disabled={disabled} onChange={e=>update({group:e.target.value,page:0})}>
                <option value={ALL}>全部分组 · {items.length}</option>
                {orderedGroups.map(g=><option key={g.id} value={g.id}>{g.name} · {counts.get(g.id)??0}</option>)}
                <option value={UNGROUPED}>未分组 · {counts.get(UNGROUPED)??0}</option>
            </select>}
        </div>
        {!filtered.length&&<p className="ff-directory-empty">没有匹配的结果</p>}
        <div className="ff-directory-rows">{visible.map((item,i)=><React.Fragment key={item.id}>
            {showGroups&&(i===0||groupKey(visible[i-1])!==groupKey(item))&&<h4 className="ff-directory-group">{groupMap.get(item.groupId??'')?.name??'未分组'}</h4>}
            {renderItem(item)}
        </React.Fragment>)}</div>
        <div className="ff-directory-pagination">
            <button type="button" aria-label={`${label}上一页`} disabled={disabled||current===0} onClick={()=>changePage(current-1)}>上一页</button>
            <span role="status">{current+1} / {pages} 页 · {filtered.length} 项</span>
            <button type="button" aria-label={`${label}下一页`} disabled={disabled||current>=pages-1} onClick={()=>changePage(current+1)}>下一页</button>
        </div>
    </div>;
}

export default function FriendFeedCharacterPicker({characters,groups=[],value,onChange,label,includeUser=false,disabled=false}: {
    characters: CharacterProfile[]; groups?: CharacterGroup[]; value: string; onChange: (id:string)=>void;
    label: string; includeUser?: boolean; disabled?: boolean;
}) {
    const details=useRef<HTMLDetailsElement>(null);
    useLocalBackHandler(()=>{const picker=details.current;if(!picker?.open)return false;picker.open=false;picker.querySelector('summary')?.focus();return true;},85);
    const name=value==='user'&&includeUser?'我':characters.find(c=>c.id===value)?.name??'选择角色';
    const select=(id:string)=>{onChange(id);if(details.current){details.current.open=false;details.current.querySelector('summary')?.focus();}};
    return <details className="ff-character-picker" ref={details}>
        <summary aria-label={label} onClick={e=>{if(disabled)e.preventDefault();}}><span>{label}<strong>{name}</strong></span><CaretDown size={16}/></summary>
        {includeUser&&<button className="ff-directory-person" type="button" disabled={disabled} aria-pressed={value==='user'} onClick={()=>select('user')}>我</button>}
        <FriendFeedGroupedList items={characters.map(c=>({...c,searchText:c.name}))} groups={groups} label={`${label}列表`} disabled={disabled}
            renderItem={c=><button className="ff-directory-person" type="button" disabled={disabled} aria-pressed={value===c.id} onClick={()=>select(c.id)}>{c.name}{value===c.id&&<span aria-hidden="true">✓</span>}</button>}/>
    </details>;
}
