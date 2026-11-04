// @vitest-environment jsdom
import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {CharacterLocationAudience,CharacterWeatherCities} from '../components/settings/CharacterAwarenessSettings';
const chars=[{id:'a',name:'小白',avatar:'☁️'},{id:'b',name:'小绿',avatar:'🌿'}];
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const click=(text:string)=>act(()=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!.click());
const fill=(input:HTMLInputElement,value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
it('starts an explicit allowlist empty and keeps selections through filtering',()=>{
    let result:string[]|undefined;
    function App(){const [value,setValue]=useState<string[]>();return React.createElement(CharacterLocationAudience,{characters:chars,value,onChange:v=>{result=v;setValue(v);}});}
    act(()=>root.render(React.createElement(App)));click('仅选中的角色');expect(result).toEqual([]);
    act(()=>host.querySelector<HTMLInputElement>('[aria-label="向小白分享定位"]')!.click());expect(result).toEqual(['a']);
    fill(host.querySelector('input[type=search]')!,'小绿');expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(1);
    fill(host.querySelector('input[type=search]')!,'');expect(host.querySelector<HTMLInputElement>('[aria-label="向小白分享定位"]')!.checked).toBe(true);
    click('清空');expect(result).toEqual([]);click('所有角色');expect(result).toBeUndefined();
});
it('edits one city and can restore inheritance without changing another role',()=>{
    let result:Record<string,string>={};
    function App(){const [value,setValue]=useState({b:'上海'});return React.createElement(CharacterWeatherCities,{characters:chars,value,defaultCity:'北京',onChange:v=>{result=v;setValue(v as any);}});}
    act(()=>root.render(React.createElement(App)));act(()=>host.querySelector('summary')!.click());
    act(()=>host.querySelector<HTMLButtonElement>('[aria-label="设置小白的天气城市"]')!.click());
    fill(host.querySelector('[aria-label="小白的天气城市"]')!,'London');expect(result).toEqual({a:'London',b:'上海'});
    click('恢复默认');expect(result).toEqual({b:'上海'});expect(host.textContent).toContain('默认 · 北京');
});
