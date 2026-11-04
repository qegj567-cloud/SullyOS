import React from 'react';
import {createRoot} from 'react-dom/client';
import Home3DView from '../../apps/room3d/Home3DView';
import {createHome,addRoom} from '../../apps/room3d/model.js';
import {setBoundary} from '../../apps/room3d/topology.js';
import {furnishShowroom,SHOWROOMS} from '../../apps/room3d/showrooms.js';
import {testCharacter} from './room3d-test-character';
const catalog=await fetch('/room3d/catalog.json').then(r=>r.json()),home=createHome(catalog);home.rooms[0].items=[];
const query=new URLSearchParams(location.search),showroom=query.get('room');
const chromeTop=Number(query.get('chromeTop'));if(Number.isFinite(chromeTop)&&chromeTop>=0&&chromeTop<=120)document.documentElement.style.setProperty('--chrome-top',`${chromeTop}px`);
if(showroom&&showroom in SHOWROOMS)furnishShowroom(home.rooms[0],showroom,catalog);
if(showroom==='halloween')setBoundary(home,home.rooms[0].id,'front',{kind:'wall_high',door:{kind:'walnut',at:0,width:2.2}},catalog);
if(query.has('multi')){const original=home.rooms[0];addRoom(home,'right');setBoundary(home,original.id,'right',{kind:'wall_high',door:{kind:'oak',at:0,width:2.6}},catalog);home.activeRoomId=original.id;}
const hair={bodyShape:query.get('body')==='blank'?'blank' as const:'classic' as const};
const character={id:'test-main',name:'小栗',chibiStudio:{room:{state:testCharacter.state}}} as any;
const residents=[{id:'user',label:'你',state:testCharacter.state},...query.has('pair')?[]:[{id:'guest',label:'来访角色',state:testCharacter.state}]];
createRoot(document.getElementById('root')!).render(<Home3DView value={home} hair={hair} character={character} residents={residents} onEditor={editor=>{const w=window as any;w.__homeEditor=editor;w.advanceTime=(ms:number)=>editor.advanceTime?.(ms);w.render_game_to_text=()=>JSON.stringify(editor.inspect?.());}} onChange={()=>{}} onBack={()=>{}}/>);
