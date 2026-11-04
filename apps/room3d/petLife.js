import {boxes,uid} from './model.js';
import {petBedtime,petSleepCandidates,petSleepPose} from './petSleep.js';
import {ROOM_HALF} from './dimensions.js';
import {findWalkPath} from './navigation.js';

import {PET_CAPACITY,PET_TRAITS,PET_NEEDS,PET_ACTIONS,normalizePetLife} from './petState.js';
export {PET_TRAITS,PET_NEEDS,PET_ACTIONS,normalizePetLife} from './petState.js';
const clamp=v=>Math.max(0,Math.min(100,v));
const copy=v=>structuredClone(v);

export function petMap(room,catalog,pet,others=[]){
 const asset=catalog.find(a=>a.id===pet.assetId),radius=Math.hypot(asset.size[0],asset.size[2])*.375+.025,height=asset.size[1]*.75+.2;
 const obstacles=room.items.filter(i=>!i.stored&&!['rug','ceiling'].includes(catalog.find(a=>a.id===i.assetId)?.surface)).flatMap(i=>{const a=catalog.find(a=>a.id===i.assetId);return a?boxes(i,a):[];});
 return {radius,free:(x,z)=>Math.abs(x)<ROOM_HALF.x-radius-.15&&Math.abs(z)<ROOM_HALF.z-radius-.15&&!obstacles.some(b=>b[1]<height+.18&&b[4]>.2&&x+radius>b[0]&&x-radius<b[3]&&z+radius>b[2]&&z-radius<b[5])&&!others.some(p=>p.id!==pet.id&&p.roomId===pet.roomId&&Math.hypot(x-p.x,z-p.z)<(radius+Math.hypot(...[0,2].map(i=>catalog.find(a=>a.id===p.assetId).size[i]))*.375+.025))};
}
export function choosePetAction(candidates,pet,random=Math.random){
 const weighted=candidates.map(c=>{
  const need={eat:'food',sleep:'energy',play:'fun',attention:'social',approach:'social'}[c.kind];
  let score=need?8+(100-pet.needs[need])*1.3:12;
  for(const trait of pet.traits){if(trait==='greedy'&&c.kind==='eat'||trait==='lazy'&&c.kind==='sleep'||trait==='playful'&&c.kind==='play'||trait==='clingy'&&['attention','approach'].includes(c.kind)||trait==='independent'&&c.kind==='wander')score*=1.8;if((trait==='independent'||trait==='shy')&&['attention','approach'].includes(c.kind))score*=.55;}
  if(need&&pet.needs[need]<15)score*=4;
  if(pet.memory.recentAction===c.kind)score*=.55;
  if(c.actorId)score*=1+(pet.relations[c.actorId]||0)/150;
  if(c.itemId&&c.itemId===pet.memory.favoriteSpot)score*=1.4;
  score/=1+(c.distance||0)*.15;
  return {...c,score};
 }).sort((a,b)=>b.score-a.score).slice(0,3);
 let ticket=random()*weighted.reduce((n,c)=>n+c.score,0);return weighted.find(c=>(ticket-=c.score)<=0)||weighted.at(-1);
}

export function createPetLife({home,catalog,changed=()=>{},random=Math.random,actors=()=>[],onEvent=()=>{},getHour=()=>new Date().getHours()}){
 const sleepCooldown=new Map(),removedPets=[];
 const data=normalizePetLife(home().petLife,home(),catalog),runtime=new Map(),maps=new Map();let clock=0,lastSave=0;
 const roomFor=p=>home().rooms.find(r=>r.id===p.roomId);
 const mapFor=p=>{if(!maps.has(p.id)){const map=petMap(roomFor(p),catalog,p,data.pets),free=map.free;map.free=(x,z)=>free(x,z)&&!actors().some(a=>a.roomId===p.roomId&&Math.hypot(a.x-x,a.z-z)<map.radius+.3);maps.set(p.id,map);}return maps.get(p.id);};
 function event(p,text,source='user',actorName){const entry={petId:p.id,petName:p.name,at:Date.now(),text};data.events.push(entry);data.events=data.events.slice(-80);onEvent({...entry,roomId:p.roomId,source,actorName});}
 function save(){home().petLife=data;changed();}
 function freeSpot(p,preferred=[p.x,p.z]){const map=mapFor(p);if(map.free(...preferred))return preferred;for(let ring=.4;ring<10;ring+=.4)for(let i=0;i<24;i++){const a=i*Math.PI/12,point=[preferred[0]+Math.sin(a)*ring,preferred[1]+Math.cos(a)*ring];if(map.free(...point))return point;}return null;}
 function attach(){for(const p of data.pets){if(!roomFor(p))p.roomId=home().activeRoomId;for(const r of home().rooms)r.items=r.items.filter(i=>i.id!==p.sourceFurnitureId||i.assetId!==p.assetId);}home().petLife=data;}
 function restore(raw){
  const next=normalizePetLife(raw,home(),catalog);
  for(const key of Object.keys(data))delete data[key];
  Object.assign(data,next);runtime.clear();maps.clear();sleepCooldown.clear();removedPets.length=0;clock=0;lastSave=0;attach();
 }
 function reconcile(){
  maps.clear();attach();for(const p of data.pets){if(!roomFor(p))p.roomId=home().activeRoomId;for(const r of home().rooms)r.items=r.items.filter(i=>i.id!==p.sourceFurnitureId||i.assetId!==p.assetId);if(runtime.get(p.id)?.external||runtime.get(p.id)?.sleepSpot)continue;const spot=freeSpot(p);if(spot&&(p.x!==spot[0]||p.z!==spot[1])){p.x=spot[0];p.z=spot[1];runtime.delete(p.id);}}
  home().petLife=data;
 }
 function remove(id){
  const index=data.pets.findIndex(p=>p.id===id);if(index<0)throw Error('这位小伙伴已经不在家园了');
  const pet=copy(data.pets[index]);removedPets.push({pet,index});
  data.pets.splice(index,1);runtime.delete(id);maps.clear();sleepCooldown.delete(id);save();return pet;
 }
 function undoRemove(){
  const entry=removedPets.at(-1);if(!entry)throw Error('没有可以撤回的移出操作');
  if(data.pets.length>=PET_CAPACITY)throw Error(`家园最多养 ${PET_CAPACITY} 只宠物，先腾出一个位置再撤回`);
  const p=copy(entry.pet);if(data.pets.some(other=>other.id===p.id))throw Error('这位小伙伴已经在家园了');
  if(!roomFor(p))p.roomId=home().activeRoomId;
  maps.clear();const spot=freeSpot(p);maps.delete(p.id);
  if(!spot)throw Error('房间太满，先留一块宠物活动的空地再撤回');
  [p.x,p.z]=spot;data.pets.splice(Math.min(entry.index,data.pets.length),0,p);removedPets.pop();maps.clear();save();return p;
 }
 function adopt(assetId,name,traits=[],sourceId){
  if(data.pets.length>=PET_CAPACITY)throw Error(`家园最多养 ${PET_CAPACITY} 只宠物`);
  const a=catalog.find(a=>a.id===assetId&&a.petSpecies);if(!a)throw Error('找不到宠物素材');
  const owner=home().rooms.find(r=>r.items.some(i=>i.id===sourceId)),source=owner?.items.find(i=>i.id===sourceId);
  if(sourceId&&(!source||source.assetId!==assetId))throw Error('这个摆件已经不在了');
  const p={hat:null,id:uid(),name:String(name||a.name).trim().slice(0,24)||a.name,assetId,roomId:owner?.id||home().activeRoomId,x:source?.x||0,z:source?.z||0,rotation:0,color:source?.color||null,materialColors:copy(source?.materialColors||{}),traits:traits.filter(t=>Object.hasOwn(PET_TRAITS,t)).slice(0,2),needs:{food:75,energy:80,social:65,fun:70},relations:{},memory:{},bondCooldown:0,sourceFurnitureId:sourceId||null};
  // Exclude the converted ornament while checking its new living footprint.
  const oldStored=source?.stored;if(source)source.stored=true;const spot=freeSpot(p);if(source)source.stored=oldStored;maps.delete(p.id);
  if(!spot)throw Error('房间太满，先留一块宠物活动的空地');
  [p.x,p.z]=spot;data.pets.push(p);if(source)owner.items=owner.items.filter(i=>i.id!==sourceId);event(p,'加入了家园');save();return p;
 }
 function candidates(p){
  const map=mapFor(p),start=[p.x,p.z],result=[{kind:'idle'},{kind:'sleep'}];
  const add=(kind,target,extra={})=>{const path=findWalkPath(map,start,target);if(path)result.push({kind,path,distance:path.reduce((n,v,i)=>n+(i?Math.hypot(v[0]-path[i-1][0],v[1]-path[i-1][1]):0),0),...extra});};
  const near=(kind,x,z,extra)=>{for(let i=0;i<8;i++){const angle=i*Math.PI/4,target=[x+Math.sin(angle)*1.15,z+Math.cos(angle)*1.15];if(map.free(...target)){const before=result.length;add(kind,target,extra);if(result.length>before)break;}}};
  for(const i of roomFor(p).items.filter(i=>!i.stored))if(i.assetId==='pet_bowls'&&(data.supplies[i.id]||0)>0&&!Array.from(runtime.values()).some(r=>r.itemId===i.id))near('eat',i.x,i.z,{itemId:i.id});
  for(const a of actors().filter(a=>a.roomId===p.roomId&&!a.busy))near('attention',a.x,a.z,{actorId:a.id});
  for(const i of roomFor(p).items.filter(i=>!i.stored&&!Array.from(runtime.values()).some(r=>r.itemId===i.id))){const capability=catalog.find(a=>a.id===i.assetId)?.petInteraction;if(capability==='play')near('play',i.x,i.z,{itemId:i.id});}
  for(let i=0;i<3;i++)add('wander',[(random()-.5)*(ROOM_HALF.x*2-1.5),(random()-.5)*(ROOM_HALF.z*2-1.5)]);
  result.push(...petSleepCandidates(roomFor(p),catalog,p,map,actors().filter(a=>a.roomId===p.roomId),new Set([...runtime.values()].map(r=>r.itemId))));
  return result;
 }
 function start(p,action){const target=action.itemId&&roomFor(p).items.find(i=>i.id===action.itemId);runtime.set(p.id,{...action,targetPosition:target?[target.x,target.z]:null,targetRotation:target?.rotation,path:action.path?.slice(1)||[],phase:0,duration:action.kind==='sleep'||action.kind==='rest'?18:action.kind==='idle'?4:6,started:clock});}
 function interact(id,kind){
  const p=data.pets.find(p=>p.id===id);if(!p)throw Error('找不到宠物');if(p.roomId!==home().activeRoomId&&kind!=='approach')throw Error('先到它所在的房间');
  if(!['pet','feed','play','approach','rest'].includes(kind))throw Error('未知互动');
  if(wake(id,kind))return true;
  const previous=runtime.get(id);if(previous?.manual)throw Error('等这次互动结束再来吧');
  if(kind==='approach'){
   const actor=actors().find(a=>a.id==='user'&&a.roomId===home().activeRoomId);if(!actor)throw Error('你现在不在房间里');
   const previousPlace={roomId:p.roomId,x:p.x,z:p.z};
   if(p.roomId!==home().activeRoomId){p.roomId=home().activeRoomId;maps.delete(p.id);const spot=freeSpot(p);if(!spot){Object.assign(p,previousPlace);maps.delete(p.id);throw Error('这里没有宠物能落脚的位置');}[p.x,p.z]=spot;}
   const map=mapFor(p);let path=null;for(let i=0;i<8&&!path;i++){const a=i*Math.PI/4;path=findWalkPath(map,[p.x,p.z],[actor.x+Math.sin(a)*1.15,actor.z+Math.cos(a)*1.15]);}if(!path){Object.assign(p,previousPlace);maps.delete(p.id);throw Error('它暂时走不过来，先清出通道');}start(p,{kind,path,actorId:'user',manual:true});save();
  }else start(p,{kind,actorId:'user',manual:true});
  return true;
 }
 function wake(id,next){const r=runtime.get(id);if(!r?.sleepSpot||r.path.length)return false;if(r.sleepStage!=='down'){const p=data.pets.find(p=>p.id===id);r.sleepSpot=petSleepPose(p,r);r.sleepStage='down';r.sleepTime=0;}r.afterWake=next;sleepCooldown.set(id,clock+60);return true;}
 function finish(p,r){
  const before={...p.needs},bond=p.relations.user||0;
  const effect={eat:['food',40],feed:['food',25],sleep:['energy',35],rest:['energy',30],play:['fun',30],pet:['social',25],attention:['social',18],approach:['social',8]}[r.kind];
  if(r.kind==='eat'){if(!(data.supplies[r.itemId]>0))return;data.supplies[r.itemId]--;}
  if(effect)p.needs[effect[0]]=clamp(p.needs[effect[0]]+effect[1]);
  if(r.actorId&&effect){if(!p.bondCooldown){p.relations[r.actorId]=clamp((p.relations[r.actorId]||0)+2);p.bondCooldown=30;}if(r.kind==='feed')p.memory.lastFedBy=r.actorId;if(r.kind==='play')p.memory.lastPlayedBy=r.actorId;}
  if(r.kind==='sleep'&&r.itemId)p.memory.favoriteSpot=r.itemId;
  p.memory.recentAction=r.kind;
  if(r.source==='local'&&r.actorId&&r.actorId!=='user')event(p,(r.kind==='play'?'和'+r.actorName+'玩了一会儿':'被'+r.actorName+'轻轻摸了摸'),'local',r.actorName);
  else if(r.manual||r.kind==='eat')event(p,({carry:'被你轻轻放回地面',pet:'被你摸了摸',feed:'吃了你给的零食',play:r.manual?'和你玩了一会儿':'玩了一会儿',approach:'蹦跳着来到你身边',rest:'安心休息了一会儿',eat:'在食盆吃了一餐'})[r.kind]||PET_ACTIONS[r.kind],r.manual?'user':'local');
  r.result={needs:Object.fromEntries(Object.keys(PET_NEEDS).map(k=>[k,Math.max(0,p.needs[k]-before[k])])),bond:Math.max(0,(p.relations.user||0)-bond)};
  if(effect)save();
 }
 function step(dt,active=true){
  if(!active||!data.pets.length)return false;dt=Math.max(0,Math.min(dt,1));clock+=dt;let moving=false;
  for(const p of data.pets){if(p.roomId!==home().activeRoomId){if(runtime.get(p.id)?.manual)runtime.delete(p.id);continue;}
   p.bondCooldown=Math.max(0,(p.bondCooldown||0)-dt);
   for(const k of Object.keys(PET_NEEDS))p.needs[k]=clamp(p.needs[k]-dt*({food:.018,energy:.014,social:.012,fun:.02}[k]));
   let r=runtime.get(p.id);if(!r){
    const options=data.autonomy?candidates(p):[],due=(petBedtime(getHour())||p.needs.energy<30)&&clock>=(sleepCooldown.get(p.id)||0);
    const choice=due?options.find(a=>a.sleepSpot):null;
    start(p,choice?{...choice,scheduled:true}:data.autonomy?choosePetAction(options.filter(a=>!a.sleepSpot||clock>=(sleepCooldown.get(p.id)||0)),p,random):{kind:'idle'});r=runtime.get(p.id);
   }
   if(r.external){moving=true;continue;}
   if(r.sleepSpot&&!r.path.length){
    const target=roomFor(p).items.find(i=>i.id===r.itemId&&!i.stored),valid=target&&target.x===r.targetPosition[0]&&target.z===r.targetPosition[1]&&target.rotation===r.targetRotation;
    r.sleepStage??='up';r.sleepTime=(r.sleepTime||0)+dt;
    if((!valid||!data.autonomy||r.scheduled&&!petBedtime(getHour())&&p.needs.energy>=75)&&r.sleepStage!=='down'){r.sleepSpot=petSleepPose(p,r);r.sleepStage='down';r.sleepTime=0;}
    if(r.sleepStage==='up'&&r.sleepTime>=.8){r.sleepStage='sleep';r.sleepTime=0;event(p,r.nest?'回到窝里睡下了':'跳上床睡下了','local');save();}
    if(r.sleepStage==='sleep'){p.needs.energy=clamp(p.needs.energy+dt*.6);if(!r.scheduled&&r.sleepTime>=30){r.sleepStage='down';r.sleepTime=0;}}
    if(r.sleepStage==='down'&&r.sleepTime>=.8){runtime.delete(p.id);sleepCooldown.set(p.id,clock+60);const next=r.afterWake;if(next)interact(p.id,next);else if(valid){p.memory.favoriteSpot=r.itemId;p.memory.recentAction='sleep';save();}}
    moving=true;continue;
   }
   if(r.itemId){const target=roomFor(p).items.find(i=>i.id===r.itemId&&!i.stored);if(!target||r.targetPosition&&Math.hypot(target.x-r.targetPosition[0],target.z-r.targetPosition[1])>.01||!r.path.length&&Math.hypot(target.x-p.x,target.z-p.z)>1.55){runtime.delete(p.id);continue;}}
   if(r.actorId&&(!r.manual||r.kind==='approach')&&!actors().some(a=>a.id===r.actorId&&a.roomId===p.roomId&&(r.kind==='approach'||!a.busy)&&Math.hypot(a.x-p.x,a.z-p.z)<(r.path.length?20:1.8))){runtime.delete(p.id);continue;}
   if(r.path.length){const target=r.path[0],dx=target[0]-p.x,dz=target[1]-p.z,d=Math.hypot(dx,dz),speed=.9*dt,next=d<=speed?target:[p.x+dx/d*speed,p.z+dz/d*speed];if(!mapFor(p).free(...next)){runtime.delete(p.id);continue;}[p.x,p.z]=next;p.rotation=Math.atan2(dx,dz);if(d<=speed){r.path.shift();if(!r.path.length)r.phase=0;}moving=true;if(r.path.length)r.phase+=dt;}
   else{const target=r.itemId?roomFor(p).items.find(i=>i.id===r.itemId):actors().find(a=>a.id===r.actorId);if(target&&Math.hypot(target.x-p.x,target.z-p.z)>.05)p.rotation=Math.atan2(target.x-p.x,target.z-p.z);r.phase+=dt;if(r.phase>=r.duration){finish(p,r);runtime.delete(p.id);}moving=true;}
  }
  if(clock-lastSave>15){lastSave=clock;save();}return moving;
 }
 reconcile();
 return {data,runtime,restore,adopt,remove,undoRemove,get lastRemoved(){return removedPets.at(-1)?.pet;},interact,wake,recordContact(id,text){const p=data.pets.find(p=>p.id===id);if(p){event(p,text);save();}},complete(id,r){const p=data.pets.find(p=>p.id===id);if(p&&runtime.get(id)===r){finish(p,r);runtime.delete(id);}},step,reconcile,attach,save,candidates,refill(id){if(!home().rooms.some(r=>r.items.some(i=>i.id===id&&i.assetId==='pet_bowls'&&!i.stored)))throw Error('食盆已不在房间');data.supplies[id]=5;onEvent({petName:'',text:'你补满了宠物食盆',source:'user',roomId:home().rooms.find(r=>r.items.some(i=>i.id===id)).id});save();},inspect:()=>({pets:copy(data.pets),actions:Object.fromEntries([...runtime].map(([id,r])=>[id,{kind:r.kind,moving:!!r.path.length,manual:!!r.manual,sleepStage:r.sleepStage||null,sleepSpot:r.sleepSpot||null,position:petSleepPose(data.pets.find(p=>p.id===id),r)}]))})};
}
