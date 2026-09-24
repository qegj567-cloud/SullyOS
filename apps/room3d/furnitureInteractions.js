import {bathroomActivities,isBathAction} from './bathroom.js';
import {roomBeds,roomSeats} from './seating.js';
import {roomPlants} from './watering.js';
import {roomPlush} from './plush.js';
import {kitchenActions} from './kitchenActivities.js';
import {mirrorActivities,isMirrorAction} from './mirror.js';

// Describe real, existing actions. No name-based guesses and no saved UI state.
export function furnitureInteractions(room,catalog,itemId,{activities=[],seat=null,held=null,active=null,fridgeOpen=false}={}){
 const item=room.items.find(i=>i.id===itemId&&!i.stored),a=catalog.find(a=>a.id===item?.assetId);if(!a)return [];
 const result=kitchenActions(room,catalog,itemId),add=(action,label,extra={},reason='')=>result.push({action,label,id:itemId,...extra,reason});
 for(const b of roomBeds(room,catalog).filter(b=>b.itemId===itemId)){
  const label=a.beds.find(s=>s.id===b.seatId)?.label||'';
  add('chibi-bed',a.beds.length===1?'躺下':/左|右/.test(label)?'睡'+label.replace('床位','').replace('侧','边'):label+'躺下',{seat:b.seatId});
 }
 for(const s of roomSeats(room,catalog).filter(s=>s.itemId===itemId))add('chibi-sit',a.seats.length===1?'坐下':(a.seats.find(v=>v.id===s.seatId)?.label||'这里')+'坐下',{seat:s.seatId});
 const plant=roomPlants(room,catalog).find(p=>p.itemId===itemId);if(plant)add('chibi-water','浇水',{},plant.spot?'':'周围太挤啦，先留一点空位');
 if(roomPlush(room,catalog).some(p=>p.itemId===itemId))add(held?.itemId===itemId?'plush-put-back':'chibi-hug',held?.itemId===itemId?'放回原位':'抱抱');
 const allActivities=[...activities,...[...mirrorActivities(room,catalog),...bathroomActivities(room,catalog)].filter(v=>!activities.some(a=>a.itemId===v.itemId&&a.kind===v.kind))];
 const matched=allActivities.filter(v=>v.itemId===itemId||!isMirrorAction(v.kind)&&(v.seat?.itemId===itemId||v.dependencies?.includes(itemId)));
 for(const v of matched){
  const chair=room.items.find(i=>i.id===v.seat?.itemId),side={left:'左边',right:'右边',front:'前边',back:'后边'}[chair?.dockSlot];
  const label=v.kind==='eat'?(side?side+'吃饭':'吃饭 · '+(activities.filter(a=>a.kind==='eat'&&a.itemId===v.itemId).indexOf(v)+1)+'号位'):v.label;
  add(isBathAction(v.kind)?'chibi-bath':isMirrorAction(v.kind)?'chibi-mirror':'chibi-game',label,{id:v.itemId,kind:v.kind,station:v.stationId||''},v.reason||'');
 }
 if(a.appliance==='fridge')add('fridge-toggle',fridgeOpen?'关上冰箱':'打开冰箱');
 if(active&&!isMirrorAction(active.kind)&&(active.itemId===itemId||active.seat?.itemId===itemId||active.dependencies?.includes(itemId)))add('chibi-game-stop',isBathAction(active.kind)?'结束':'休息一下');
 if(seat?.itemId===itemId)add('chibi-stand','起身');
 return result;
}

// A semicircle over the furniture; constrain the whole wheel, not each button.
export function interactionArcLayout({x,y,width,height,count,modelWidth=440}){
 const n=Math.min(3,count),w=Math.min(width-24,Math.max(176,Math.min(420,modelWidth*1.08))),h=Math.min(height<500?160:270,Math.max(140,w*.64)),side=x+w/2>width?'left':'right';
 const left=Math.max(12,Math.min(width-w-12,x-w/2));
 const top=Math.max(height<500?70:135,Math.min(height-h-96,y-h*.77));
 const points=Array.from({length:n},(_,i)=>{const angle=(n===1?-90:-142+i/(n-1)*104)*Math.PI/180;return {x:w/2+Math.cos(angle)*w*.40,y:h*.77+Math.sin(angle)*h*.56};});
 return {left,top,width:w,height:h,side,points};
}
