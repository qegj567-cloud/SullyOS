import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import Home3DView from '../../apps/room3d/Home3DView';
import {testCharacter} from './room3d-test-character';
import {createStarterHome} from '../../apps/room3d/starterHome.js';
import {createPetLife} from '../../apps/room3d/petLife.js';
const catalog=await fetch('/room3d/catalog.json').then(r=>r.json());
const initial=createStarterHome(catalog,'sage'),room=initial.rooms[5];initial.activeRoomId=room.id;initial.residentRoomId=room.id;room.name='宠物活动室';
room.items=[{id:'preview-bowls',assetId:'pet_bowls',x:-3,y:.15,z:-2.6,rotation:0,color:null,stored:false},{id:'preview-mat',assetId:'pet_rest_mat',x:-1.1,y:.15,z:-2.6,rotation:0,color:null,stored:false},{id:'preview-ball',assetId:'pet_toy_ball',x:2.4,y:.15,z:-2.3,rotation:0,color:null,stored:false}];
const life=createPetLife({home:()=>initial,catalog});
for(const [index,a] of catalog.filter(a=>a.petSpecies).sort((a,b)=>Number(['hamster','jellyfish'].includes(b.petSpecies))-Number(['hamster','jellyfish'].includes(a.petSpecies))).slice(0,7).entries()){const p=life.adopt(a.id,a.name,[['playful','independent','clingy','greedy','shy','lazy','playful'][index]]);p.x=(index%3-1)*2;p.z=index<3?-1:1.6;if(index===6){p.x=2.6;p.z=2.75;}}
life.refill('preview-bowls');life.reconcile();
const character={id:'qa-pet-owner',name:'Sully',chibiStudio:{home3D:{state:testCharacter.state,hair:{bodyShape:'blank'}}}} as any;
const residents=[{id:'user',label:'你',state:testCharacter.state}];
function App(){const [home,setHome]=useState(initial);return <Home3DView value={home} character={character} residents={residents} onChange={setHome} onBack={()=>{}} onEditor={(editor:any)=>{const w=window as any;w.__homeEditor=editor;w.advanceTime=(ms:number)=>editor.advancePets(ms/1000);w.render_game_to_text=()=>JSON.stringify({coordinates:'room-local x right, z front, y up',...editor.getPetSystem().inspect(),scene:editor.getHomeScene()});}}/>;}
const root=createRoot(document.getElementById('root')!);root.render(<App/>);import.meta.hot?.dispose(()=>root.unmount());
