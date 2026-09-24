import {mountHomeEditor} from '../../apps/room3d/editor.js';
import {createHome} from '../../apps/room3d/model.js';
import {furnishShowroom,SHOWROOMS} from '../../apps/room3d/showrooms.js';
import {ROOM_PALETTES,applyRoomPalette} from '../../apps/room3d/roomPalettes.js';
import {bathroomHome} from './bathroom-layout.js';
import {setBoundary} from '../../apps/room3d/topology.js';
import '../../apps/room3d/editor.css';
const types=[['living','客厅','沙发 · 电视 · 猫爬架'],['bedroom','卧室','床铺 · 衣柜 · 梳妆镜'],['study','书房','电竞桌椅 · 主机 · 收纳'],['kitchen','厨房','橱柜 · 水槽灶台 · 中岛'],['bathroom','浴室','淋浴 · 泡泡浴 · 洗衣']];
const catalog=await fetch('/room3d/catalog.json').then(r=>r.json()),cache=new Map(),homes=new Map();let palette='original',busy=false,detailEditor=null,detailVersion=0;
const nav=document.querySelector('nav'),rooms=document.querySelector('#rooms'),status=document.querySelector('#status'),stage=document.querySelector('#render');
function homeFor(kind,key){const home=kind==='bathroom'?bathroomHome(catalog):createHome(catalog),r=home.rooms[0];if(kind!=='bathroom'){r.items=[];furnishShowroom(r,kind,catalog);setBoundary(home,r.id,'front',{kind:'wall_high',door:{kind:SHOWROOMS[kind].door,at:0,width:2.2}},catalog);}if(key!=='original')applyRoomPalette(r,key,catalog);return home;}
const themes=[['original','原木黑白绿 · 原版'],...Object.entries(ROOM_PALETTES).filter(([k])=>k!=='sage').map(([k,p])=>[k,p.name])];
nav.innerHTML=themes.map(([k,name])=>`<button data-theme="${k}" aria-pressed="${k===palette}">${name}</button>`).join('');
async function show(){if(busy)return;busy=true;nav.querySelectorAll('button').forEach(b=>{b.disabled=true;b.setAttribute('aria-pressed',String(b.dataset.theme===palette));});rooms.innerHTML=types.map(([k,name,desc],i)=>`<article data-room="${k}"><div class="preview">正在准备预览…</div><footer><div><h2>${String(i+1).padStart(2,'0')}　${name}</h2><p>${desc}</p></div><button data-open="${k}" disabled>进去看看</button></footer></article>`).join('');
 try{for(const [kind,name]of types){const key=kind+'/'+palette;status.textContent='正在排列 '+name+'…';if(!cache.has(key)){const home=homeFor(kind,palette);homes.set(key,home);const editor=await mountHomeEditor(stage,{assetBase:new URL('/room3d/',location.href).href,initialState:home});try{editor.advanceTime(0);cache.set(key,stage.querySelector('canvas').toDataURL('image/png'));}finally{editor.dispose();}}
 const card=rooms.querySelector(`[data-room="${kind}"]`),img=document.createElement('img');img.alt=name+' · '+themes.find(([k])=>k===palette)[1];img.src=cache.get(key);card.querySelector('.preview').replaceWith(img);card.querySelector('button').disabled=false;
 }status.textContent='已排列好 5 间精装房。切换配色可比较，点击房间可放大查看。';}catch(e){status.textContent='预览未完成：'+e.message;console.error(e);}finally{busy=false;nav.querySelectorAll('button').forEach(b=>b.disabled=false);window.__homeEditor={ready:true};}
}
nav.addEventListener('click',e=>{const b=e.target.closest('[data-theme]');if(b&&!busy){palette=b.dataset.theme;show();}});
rooms.addEventListener('click',async e=>{const b=e.target.closest('[data-open]');if(!b||busy)return;const key=b.dataset.open+'/'+palette,version=++detailVersion;document.querySelector('#detail').hidden=false;try{const editor=await mountHomeEditor(document.querySelector('#detailHost'),{assetBase:new URL('/room3d/',location.href).href,initialState:structuredClone(homes.get(key))});if(version!==detailVersion)editor.dispose();else detailEditor=editor;}catch(e){document.querySelector('#detail').hidden=true;status.textContent='房间加载失败：'+e.message;}});
document.querySelector('.back').onclick=()=>{detailVersion++;detailEditor?.dispose();detailEditor=null;document.querySelector('#detail').hidden=true;};
window.render_game_to_text=()=>JSON.stringify({palette,busy,rooms:types.map(([id,name])=>({id,name,ready:cache.has(id+'/'+palette)}))});window.advanceTime=()=>{};
await show();
