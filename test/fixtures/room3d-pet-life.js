import {mountHomeEditor} from '/apps/room3d/editor.js';
import {createHome} from '/apps/room3d/model.js';
import '/apps/room3d/editor.css';
const catalog=await fetch('/room3d/catalog.json').then(r=>r.json()),home=createHome(catalog),room=home.rooms[0];
room.name='宠物活动室';room.wall='#f3f5e9';room.floor='#dee5cf';room.items=[{id:'preview-mat',assetId:'pet_rest_mat',x:-1.1,y:.15,z:-2.6,rotation:0,color:null,stored:false},{id:'preview-toy',assetId:'pet_toy_ball',x:2.1,y:.15,z:-2.2,rotation:0,color:null,stored:false},{id:'preview-bowls',assetId:'pet_bowls',x:-3,y:.15,z:-2.6,rotation:0,color:null,stored:false}];
const editor=await mountHomeEditor(document.querySelector('#home'),{assetBase:new URL('/room3d/',location.href).href,initialState:localStorage.getItem('test-pet-life')?undefined:home,storageKey:'test-pet-life'});
window.__homeEditor=editor;
const system=editor.getPetSystem();
if(!system.life.data.pets.length){for(const [index,a] of catalog.filter(a=>a.petSpecies).sort((a,b)=>Number(['hamster','jellyfish'].includes(b.petSpecies))-Number(['hamster','jellyfish'].includes(a.petSpecies))).slice(0,7).entries()){const p=system.life.adopt(a.id,a.name,[['playful','independent','clingy','greedy','shy','lazy','playful'][index]]);p.x=(index%3-1)*2.1;p.z=index<3?-1:1.4;if(index===6){p.x=2.6;p.z=2.75;}}system.life.refill('preview-bowls');system.reconcile();system.life.save();}
window.render_game_to_text=()=>JSON.stringify({coordinates:'room-local x right, z front; y up',...system.inspect()});
window.advanceTime=ms=>{editor.advancePets(ms/1000);editor.advanceTime(0);};
if(new URLSearchParams(location.search).has('wardrobe')){const p=system.life.data.pets[0];p.hat='witch';system.reconcile();system.open(p.id);document.querySelector('[data-pet-action="detail-tab"][data-tab="wardrobe"]').click();}
import.meta.hot?.dispose(()=>editor.dispose());
