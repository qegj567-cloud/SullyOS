// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GuidebookApp from '../apps/GuidebookApp';
import { DB } from './db';

const state = vi.hoisted(() => ({ characters:[{id:'guide-char',name:'角色',avatar:''}],userProfile:{name:'小明'},apiConfig:{},addToast:vi.fn(),closeApp:vi.fn(),updateCharacter:vi.fn() }));
vi.mock('../context/OSContext', () => ({useOS:()=>state}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(async () => {
    state.characters=[{id:'guide-char',name:'角色',avatar:''}];state.addToast.mockClear();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('回放发送不应调用模型'); }));
    await DB.saveGuidebookSession({id:'replay-fixture',charId:'guide-char',status:'ended',initialAffinity:20,currentAffinity:35,currentRound:1,maxRounds:1,
        rounds:[],createdAt:1,lastPlayedAt:1,endCard:{title:'旧存档结局',finalAffinity:35,charVerdict:'很开心',highlights:[]}} as any);
    host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function button(text:string) {
    const node=[...host.querySelectorAll('button')].find(item=>item.textContent?.trim()===text);
    expect(node,text).toBeDefined();await act(async()=>node!.click());
}
async function replay() {
    await act(async()=>root.render(createElement(GuidebookApp)));
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
    const label=[...host.querySelectorAll('span')].find(item=>item.textContent==='「旧存档结局」');
    expect(label).toBeDefined();await act(async()=>(label!.closest('.cursor-pointer') as HTMLElement).click());
}
it('重开旧存档可以查看结算再补发，只写入原角色聊天且不重新生成',async()=>{
    const save=vi.spyOn(DB,'saveMessage');
    await replay();await button('查看结算 · 发送到聊天');await button('发送到聊天');
    expect(save).toHaveBeenCalledOnce();
    await act(async()=>{await save.mock.results[0].value;});
    expect(save.mock.calls[0][0]).toMatchObject({charId:'guide-char',role:'system',type:'score_card',metadata:{scoreCard:{type:'guidebook_card',title:'旧存档结局',initialAffinity:20,finalAffinity:35}}});
    expect(fetch).not.toHaveBeenCalled();
    expect(state.addToast).toHaveBeenCalledWith('已发送到聊天','success');
});
it('角色已删除的存档仍可回顾，补发不会误发给其他角色',async()=>{
    state.characters=[];
    const save=vi.spyOn(DB,'saveMessage');
    await replay();await button('查看结算 · 发送到聊天');
    expect(save).not.toHaveBeenCalled();
    expect(state.addToast).toHaveBeenCalledWith(expect.stringContaining('角色已不存在'),'error');
});
