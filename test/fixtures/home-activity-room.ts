import {mountHomeEditor} from '../../apps/room3d/editor.js';
import {createStarterHome} from '../../apps/room3d/starterHome.js';
import '../../apps/room3d/editor.css';
import '../../apps/room3d/homeHud.css';
const catalog=await fetch('/room3d/catalog.json').then(r=>r.json());
const key='home-activity-room-qa';
const initialState=JSON.parse(localStorage.getItem(key)||'null')||createStarterHome(catalog);
const editor=await mountHomeEditor(document.querySelector('#home')!,{assetBase:new URL('/room3d/',location.href).href,initialState,onMenu:()=>{},onChange:state=>localStorage.setItem(key,JSON.stringify(state))});
(window as any).__homeEditor=editor;
