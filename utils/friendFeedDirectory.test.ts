// @vitest-environment jsdom
import React, {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import FriendFeedAccounts from '../apps/FriendFeedAccounts';
import FriendFeedRelations from '../apps/FriendFeedRelations';
import FriendFeedCharacterPicker, {FriendFeedDirectoryProvider,FriendFeedGroupedList} from '../apps/FriendFeedGroupedList';
import {defaultFriendFeedSettings} from './friendFeedSettings';
import {emptyFriendFeed} from './friendFeed';
import {normalizeFriendGraph} from './friendFeedGraph';
import type {CharacterGroup,CharacterProfile} from '../types';

const groups:CharacterGroup[]=[{id:'b',name:'第二组',order:2},{id:'a',name:'第一组',order:1}];
const characters=Array.from({length:125},(_,i)=>({id:`c${i}`,name:`角色${String(i).padStart(3,'0')}`,groupId:i<60?'a':i<120?'b':undefined}) as CharacterProfile);
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function render(node:React.ReactNode){await act(async()=>{root.render(node);});}
async function click(label:string){const button=host.querySelector(`[aria-label="${label}"]`) as HTMLElement;expect(button,label).not.toBeNull();await act(async()=>button.click());}
async function change(label:string,value:string){const input=host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement|HTMLSelectElement;expect(input,label).not.toBeNull();await act(async()=>{
    if(input instanceof HTMLSelectElement){input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));}
    else{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}
});}

it('pages 125 character weights by existing group, searches across every page and preserves edits by ID',async()=>{
    let draft=defaultFriendFeedSettings();
    function Editor(){const [value,setValue]=useState(draft);return React.createElement(FriendFeedAccounts,{section:'weights',characters,groups,value,disabled:false,onChange:next=>{draft=next;setValue(next);}});}
    await render(React.createElement(Editor));
    const list=()=>host.querySelector('[aria-label="角色权重"]')!;
    expect(list().querySelectorAll('input[type=number]')).toHaveLength(10);
    expect(list().textContent).toContain('1 / 13 页 · 125 项');
    await change('角色000的抽取权重','0');await click('角色权重下一页');
    expect(list().querySelector('[aria-label="角色000的抽取权重"]')).toBeNull();
    await change('角色010的抽取权重','88');await click('角色权重上一页');
    expect((list().querySelector('[aria-label="角色000的抽取权重"]') as HTMLInputElement).value).toBe('0');
    await change('角色权重分组','b');
    expect(list().textContent).toContain('1 / 6 页 · 60 项');
    expect(list().querySelector('[aria-label="角色060的抽取权重"]')).not.toBeNull();
    await change('搜索角色','角色119');
    expect(list().querySelectorAll('input[type=number]')).toHaveLength(1);
    await change('角色119的抽取权重','27');
    await change('搜索角色','不存在');expect(list().textContent).toContain('没有匹配');
    await change('搜索角色','');await change('角色权重分组','__ungrouped__');
    expect(list().querySelectorAll('input[type=number]')).toHaveLength(5);
    expect(draft.characterWeights).toMatchObject({c0:0,c10:88,c119:27});
});

it('selects a character on a later page without changing selection when filtering',async()=>{
    const changed=vi.fn();
    await render(React.createElement(FriendFeedCharacterPicker,{label:'编辑角色账号',characters,groups,value:'c0',onChange:changed}));
    await click('编辑角色账号');await change('编辑角色账号列表分组','b');await click('编辑角色账号列表下一页');
    expect(changed).not.toHaveBeenCalled();
    const row=[...host.querySelectorAll('button')].find(b=>b.textContent==='角色070')!;
    await act(async()=>row.click());
    expect(changed).toHaveBeenCalledWith('c70');
    expect(host.querySelector('details')?.open).toBe(false);
});

it('clamps a deleted last page and keeps orphaned group members under ungrouped',async()=>{
    const draw=(rows:CharacterProfile[],gs=groups)=>React.createElement(FriendFeedGroupedList,{label:'测试角色',items:rows.map(c=>({...c,searchText:c.name})),groups:gs,renderItem:c=>React.createElement('p',{'data-character':c.id},c.searchText)});
    await render(draw(characters));
    for(let i=0;i<12;i++)await click('测试角色下一页');
    expect(host.textContent).toContain('13 / 13 页');
    await render(draw(characters.slice(0,12),[]));
    expect(host.textContent).toContain('2 / 2 页');expect(host.querySelectorAll('[data-character]')).toHaveLength(2);
    await change('测试角色分组','__ungrouped__');expect(host.textContent).toContain('1 / 2 页 · 12 项');
});

it('restores the group and page when returning from a child page in the same app',async()=>{
    const draw=(visible:boolean)=>React.createElement(FriendFeedDirectoryProvider,{children:visible?React.createElement(FriendFeedGroupedList,{label:'返回列表',items:characters.map(c=>({...c,searchText:c.name})),groups,renderItem:c=>React.createElement('p',null,c.searchText)}):null});
    await render(draw(true));await change('返回列表分组','b');await click('返回列表下一页');
    await render(draw(false));await render(draw(true));
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('b');
    expect(host.textContent).toContain('2 / 6 页');expect(host.textContent).toContain('角色070');
});

it('paginates relationship accounts without exposing private owner groups in character preview',async()=>{
    const feed={...emptyFriendFeed(),publicFeed:true,settings:defaultFriendFeedSettings()};
    for(const c of characters)feed.settings.identities[c.id]={nickname:`网名${c.id}`,tags:[],accounts:[]};
    normalizeFriendGraph(feed,characters);
    await render(React.createElement(FriendFeedRelations,{feed,characters,groups,user:{name:'我'} as any,initialOwner:'c0'}));
    expect(host.querySelectorAll('.ff-relation-item')).toHaveLength(10);
    await change('关系账号分组','b');expect(host.querySelector('[aria-label="关系账号"]')?.textContent).toContain('第二组');
    const preview=[...host.querySelectorAll('button')].find(b=>b.textContent==='以 角色000 视角查看')!;
    await act(async()=>preview.click());
    const visible=host.querySelector('[aria-label="角色可见账号"]')!;
    expect(visible.querySelector('select')).toBeNull();expect(visible.querySelectorAll('.ff-relation-item')).toHaveLength(10);
    expect(visible.textContent).not.toContain('第二组');expect(visible.querySelector('input[type=checkbox]')).toBeNull();
    await change('搜索账号','角色119');expect(visible.querySelectorAll('.ff-relation-item')).toHaveLength(0);
    await change('搜索账号','网名c119');expect(visible.querySelectorAll('.ff-relation-item')).toHaveLength(1);
});
