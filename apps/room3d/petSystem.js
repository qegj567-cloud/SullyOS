import {attachPetHat} from './petHatModel.js';
import {normalizePetHat} from './petWardrobe.js';
import {petSleepPose} from './petSleep.js';
import * as THREE from 'three';
import {createPetLife,PET_NEEDS,PET_ACTIONS} from './petLife.js';
import {ROOM_STEP} from './dimensions.js';
import {petPanelMarkup,petMood,bondLabel,petIcon,PET_CARE} from './petPanel.js';
import {createPetContact} from './petContact.js';
import {createPetPortraits} from './petPortraits.js';
import {applyFurnitureColorPreset,setFurniturePrimaryColor,resetFurnitureColors} from './furniturePaint.js';
import './petSystem.css';
export function mountPetSystem({host,scene,home,catalog,templates,actors,contactBridge,beforeOpen,changed,invalidate,context,onEvent,showEntry=true,getHour}){
 const life=createPetLife({home,catalog,actors,changed,onEvent,getHour}),layer=new THREE.Group(),models=new Map(),portraits=createPetPortraits();scene.add(layer);
 const button=document.createElement('button');button.className='h3-pets-entry';button.innerHTML=petIcon('paw')+'<span>宠物</span>';button.onclick=()=>open();if(showEntry)host.append(button);
 const overlay=document.createElement('div');overlay.className='h3-pets-overlay';overlay.hidden=true;host.append(overlay);
 const contact=createPetContact({life,home,catalog,bridge:contactBridge,headPoint});
 let contactHudMarkup='';const contactHud=document.createElement('div');contactHud.className='pet-contact-hud';contactHud.hidden=true;host.append(contactHud);
 contactHud.onclick=e=>{try{if(e.target.closest('[data-drop]'))contact.drop();else if(e.target.closest('[data-cancel]'))contact.cancel();}catch(err){error=err.message;open(contact.inspect()?.petId);error=err.message;render();}invalidate();};
 let selected=null,sourceId=null,previousFocus=null,error='',disposed=false,shadowDirty=true,tab='pets',detailTab='care',pending=null,feedback=null,wakeContact=null;
 let removeConfirm=null;
 const asset=id=>catalog.find(a=>a.id===id);
 function clearModels(){for(const root of models.values())root.traverse(o=>{if(o.isMesh){if(o.userData.petHat)o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});models.clear();layer.clear();}
 function sync(){
  shadowDirty=true;clearModels();
  for(const p of life.data.pets){const template=templates.get(p.assetId);if(!template)continue;const root=new THREE.Group(),visual=template.clone(true);root.userData.petId=p.id;root.userData.visual=visual;visual.scale.setScalar(.75);root.add(visual);
   visual.traverse(o=>{if(!o.isMesh)return;o.castShadow=true;o.receiveShadow=true;const paint=m=>{const c=m.clone(),color=p.materialColors?.[m.name]||(asset(p.assetId).paintMaterials?.includes(m.name)?p.color:null);if(color)c.color.set(color);return c;};o.material=Array.isArray(o.material)?o.material.map(paint):paint(o.material);});attachPetHat(visual,p.hat,asset(p.assetId));layer.add(root);models.set(p.id,root);
  }update(0);
 }
 function update(dt){
  const ctx=context(),current=home().rooms.find(r=>r.id===home().activeRoomId),active=!ctx.paused&&!ctx.edit&&!ctx.overview;
  button.hidden=ctx.overview;layer.visible=!ctx.overview;
  const contacting=contact.tick(active?dt:0,active),moving=life.step(dt,active)||contacting;
  if(wakeContact&&!life.runtime.get(wakeContact.id)?.sleepSpot&&active){const task=wakeContact;wakeContact=null;try{contact.start(task.id,task.kind);close();}catch(err){error=err.message;render();}}
  for(const p of life.data.pets){const root=models.get(p.id);if(!root)continue;const room=home().rooms.find(r=>r.id===p.roomId),r=life.runtime.get(p.id),v=root.userData.visual;root.visible=room?.id===current.id;
   const sleepPosition=petSleepPose(p,r);root.position.set(sleepPosition[0]+(room.x-current.x)*ROOM_STEP.x,sleepPosition[1],sleepPosition[2]+(room.z-current.z)*ROOM_STEP.z);root.rotation.y=p.rotation;
   const t=r?.phase||0,hop=r?.path.length&&active&&!ctx.reducedMotion?Math.abs(Math.sin(t*9)):0,sleep=['sleep','rest'].includes(r?.kind),eat=['eat','feed'].includes(r?.kind),play=['play','pet','attention'].includes(r?.kind);
   v.position.y=hop*.18+(active&&!ctx.reducedMotion&&r?.kind==='play'?Math.abs(Math.sin(t*6))*.12:0);v.rotation.z=active&&!ctx.reducedMotion?(play&&!r?.external?Math.sin(t*7)*.1:0):0;v.rotation.x=eat&&active&&!ctx.reducedMotion?.13+Math.sin(t*7)*.09:0;
   const squash=sleep?.97:hop?1+hop*.07:1;v.scale.set(.75/Math.sqrt(squash),.75*squash,.75/Math.sqrt(squash));
   const pose=[root.visible,...root.position.toArray(),root.rotation.y,...v.position.toArray(),v.rotation.x,v.rotation.z,...v.scale.toArray()].join();if(root.userData.shadowPose!==pose){root.userData.shadowPose=pose;shadowDirty=true;}
  }
  placeHeld();const state=contact.inspect(),label=state?.phase==='held'?'抱稳啦，点地面可以抱着走':state?.phase==='approach'?'走到小伙伴身边':state?.phase==='stroke'?'蹲下来，轻轻摸摸':state?.phase==='lower'?'慢慢放到地上':'抱到怀里';
  contactHud.hidden=!state||ctx.overview||ctx.edit;
  const markup=state?`<span>${label}</span><button ${state.phase==='held'?'data-drop':'data-cancel'}>${state.phase==='held'?'放下来':'取消'}</button>`:'';if(contactHudMarkup!==markup){contactHud.innerHTML=markup;contactHudMarkup=markup;}
  return moving;
 }
 function headPoint(p){
  const root=models.get(p.id);if(!root)return null;root.updateWorldMatrix(true,true);const box=new THREE.Box3(),meshes=[];
  root.traverse(o=>{if(o.isMesh){meshes.push(o);if((Array.isArray(o.material)?o.material:[o.material]).some(m=>m.name==='pet-eyes'))box.union(new THREE.Box3().setFromObject(o));}});
  if(box.isEmpty())return null;const center=box.getCenter(new THREE.Vector3());center.x-=Math.sin(p.rotation)*.08;center.z-=Math.cos(p.rotation)*.08;center.y=3;
  const hit=new THREE.Raycaster(center,new THREE.Vector3(0,-1,0)).intersectObjects(meshes,false)[0];return hit?hit.point.clone().add(new THREE.Vector3(0,.025,0)):null;
 }
 function placeHeld(){const f=contact.frame(),root=f&&models.get(f.petId);if(!f||!root||f.phase==='stroke')return;root.position.copy(f.position);root.rotation.y=f.rotation;const v=root.userData.visual;v.position.set(0,0,0);v.rotation.set(0,0,0);v.scale.setScalar(.75);shadowDirty=true;}
 function interact(id,kind){
  const ctx=context();if(ctx.paused||ctx.edit||ctx.overview)throw Error('先回到房间，再陪它玩吧');
  if(['pet','carry'].includes(kind)&&life.wake(id)){wakeContact={id,kind};invalidate();return;}
  if(['pet','carry'].includes(kind)){contact.start(id,kind);close();}else{if(contact.busy)throw Error('先把怀里的小伙伴放下来');life.interact(id,kind);}
  pending={id,runtime:life.runtime.get(id)};feedback=null;invalidate();refresh();
 }
 function interactionOptions(id){
  const p=life.data.pets.find(p=>p.id===id);if(!p)return [];
  const r=life.runtime.get(id),held=contact.inspect()?.petId===id&&contact.inspect()?.phase==='held';
  const care=PET_CARE.map(([kind,label,,icon])=>({action:'pet-interact',id,kind,label:kind==='carry'&&held?'放下来':label,icon,reason:(r?.manual||contact.busy)&&!(held&&kind==='carry')?'等当前互动结束，或先把小伙伴放下':''}));
  return [{action:'pet-panel',id,label:'宠物面板',icon:'book'},care[0],care[5],care[1],care[2],care[3],care[4]];
 }
 function close(){removeConfirm=null;overlay.hidden=true;previousFocus?.focus?.();}
 function open(id=null,source=null){removeConfirm=null;beforeOpen?.();previousFocus=document.activeElement;selected=id;sourceId=source;error='';tab='pets';detailTab='care';overlay.hidden=false;render();overlay.querySelector('button')?.focus();}
 function render(){
  const hadFocus=overlay.contains(document.activeElement),scroll=overlay.querySelector('.h3-pets-body')?.scrollTop||0;
  const adoptionOpen=overlay.querySelector('.pet-adoption')?.open;
  overlay.innerHTML=petPanelMarkup({life,home:home(),catalog,selected,sourceId,tab,detailTab,error,removeConfirm,context:context(),portrait:p=>portraits.get(JSON.stringify([p.id,p.color,p.materialColors,p.hat]),models.get(p.id)?.userData.visual)});
  if(adoptionOpen&&overlay.querySelector('.pet-adoption'))overlay.querySelector('.pet-adoption').open=true;
  overlay.querySelector('.h3-pets-body').scrollTop=scroll;
  refresh();if(hadFocus)overlay.querySelector('button')?.focus({preventScroll:true});
 }
 function navigate(){render();overlay.querySelector('.h3-pets-body').scrollTop=0;}
 overlay.addEventListener('click',e=>{
  if(e.target===overlay){close();return;}const b=e.target.closest('button');if(!b)return;const action=b.dataset.petAction,p=life.data.pets.find(p=>p.id===selected);
  if(action==='remove'&&p){removeConfirm=p.id;error='';navigate();overlay.querySelector('[data-pet-action="cancel-remove"]')?.focus();return;}
  if(action==='cancel-remove'){removeConfirm=null;navigate();return;}
  if(action==='confirm-remove'){
   if(!p||removeConfirm!==p.id)return;
   try{
    if(contact.inspect()?.petId===p.id)contact.cancel();
    if(wakeContact?.id===p.id)wakeContact=null;
    if(pending?.id===p.id)pending=null;
    if(feedback?.id===p.id)feedback=null;
    life.remove(p.id);selected=null;sourceId=null;removeConfirm=null;tab='pets';error='';
    sync();changed(true);navigate();overlay.querySelector('[data-pet-action="undo-remove"]')?.focus();
   }catch(err){error=err.message;render();}invalidate();return;
  }
  if(action==='undo-remove'){
   try{const pet=life.undoRemove();selected=pet.id;sourceId=null;removeConfirm=null;detailTab='care';error='';sync();changed(true);navigate();}
   catch(err){error=err.message;render();}invalidate();return;
  }
  if(['close','select','back','tab','detail-tab'].includes(action))removeConfirm=null;
  try{error='';if(action==='close')return close();if(action==='select'){selected=b.dataset.id;detailTab='care';navigate();}if(action==='back'){selected=null;sourceId=null;navigate();}if(action==='tab'){tab=b.dataset.tab;navigate();}if(action==='detail-tab'){detailTab=b.dataset.tab;navigate();}if(action==='interact'){interact(selected,b.dataset.kind);render();}if(action==='refill'){life.refill(b.dataset.id);render();}
   if(p&&b.hasAttribute('data-pet-hat')){p.hat=normalizePetHat(b.dataset.petHat);life.save();sync();render();}
   if(p&&b.dataset.action==='color-preset'){applyFurnitureColorPreset(p,asset(p.assetId),b.dataset.value);life.save();sync();render();}
   if(p&&b.dataset.action==='color'){setFurniturePrimaryColor(p,asset(p.assetId),b.dataset.value||null);life.save();sync();render();}
   if(p&&b.dataset.action==='reset-all-colors'){resetFurnitureColors(p);life.save();sync();render();}
  }catch(err){error=err.message;render();}invalidate();
 });
 overlay.addEventListener('change',e=>{const input=e.target,p=life.data.pets.find(p=>p.id===selected);if(input.matches('[data-pet-autonomy]')){life.data.autonomy=input.checked;if(!input.checked)for(const [id,r] of life.runtime)if(!r.manual)life.runtime.delete(id);life.save();}if(p){if(input.matches('[data-pet-name]'))p.name=input.value.trim().slice(0,24)||p.name;if(input.matches('[data-furniture-color]'))setFurniturePrimaryColor(p,asset(p.assetId),input.value);if(input.matches('[data-material-color]'))(p.materialColors??={})[input.dataset.materialColor]=input.value;life.save();sync();render();invalidate();}});
 overlay.addEventListener('submit',e=>{e.preventDefault();try{const form=new FormData(e.target),traits=form.getAll('trait');if(traits.length>2)throw Error('性格最多选两种');const p=life.adopt(form.get('asset'),form.get('name'),traits,sourceId);selected=p.id;sourceId=null;sync();changed(true);error='';render();invalidate();}catch(err){error=err.message;render();}});
 overlay.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();if(removeConfirm){removeConfirm=null;navigate();}else close();}if(e.key==='Tab'){const nodes=[...overlay.querySelectorAll('button,input,select,summary')].filter(n=>!n.disabled&&n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}});
 function refresh(){
  if(pending&&life.runtime.get(pending.id)!==pending.runtime){
   const result=pending.runtime.result,completed=!!result;
   const gains=result?Object.entries(PET_NEEDS).map(([k,label])=>[label,Math.round(result.needs[k])]).concat([['亲密度',Math.round(result.bond)]]).filter(([,v])=>v>0):[];
   feedback={id:pending.id,text:completed?`${pending.runtime.kind==='carry'?'抱抱':PET_CARE.find(([id])=>id===pending.runtime.kind)?.[1]}完成${gains.length?' · '+gains.map(([label,v])=>`${label} +${v}`).join(' · '):' · 它收到了你的陪伴。'}`:'这次互动停下了，可以再试一次。'};pending=null;
  }
  if(overlay.hidden)return;
  for(const node of overlay.querySelectorAll('[data-roster-status]')){const p=life.data.pets.find(p=>p.id===node.dataset.rosterStatus);if(p)node.textContent=petMood(p);}
  const p=life.data.pets.find(p=>p.id===selected);if(!p)return;
  const r=life.runtime.get(p.id),ctx=context(),paused=ctx.paused||ctx.edit||ctx.overview,here=p.roomId===home().activeRoomId;
  for(const k of Object.keys(PET_NEEDS)){const meter=overlay.querySelector(`[data-need="${k}"]`),label=overlay.querySelector(`[data-need-text="${k}"]`);if(meter)meter.value=p.needs[k];if(label)label.textContent=Math.round(p.needs[k]);const row=overlay.querySelector(`[data-need-row="${k}"]`);if(row)row.dataset.low=p.needs[k]<35;}
  const set=(selector,text)=>{const node=overlay.querySelector(selector);if(node&&node.textContent!==String(text))node.textContent=text;};
  set('[data-pet-status]',paused?'安心等你回来':PET_ACTIONS[r?.kind]||'发呆');set('[data-pet-mood]',petMood(p));
  const stage=overlay.querySelector('.pet-stage');if(stage)stage.dataset.petMotion=paused||ctx.reducedMotion||!here?'idle':r?.kind||'idle';
  const bond=Math.round(p.relations.user||0);set('[data-bond-label]',bondLabel(bond));set('[data-bond-value]',`${bond} / 100`);const bondMeter=overlay.querySelector('[data-pet-bond]');if(bondMeter)bondMeter.value=bond;
  for(const b of overlay.querySelectorAll('[data-pet-action=interact]')){const held=contact.inspect()?.petId===p.id&&contact.inspect()?.phase==='held';b.disabled=(!here&&b.dataset.kind!=='approach')||paused||((!!r?.manual||contact.busy)&&!(held&&b.dataset.kind==='carry'));if(b.dataset.kind==='carry')b.querySelector('strong').textContent=held?'放下来':'抱起来';b.setAttribute('aria-pressed',String(!!r?.manual&&r.kind===b.dataset.kind));}
  const contactState=contact.inspect(),holding=contactState?.petId===p.id&&contactState.phase==='held';
  set('[data-pet-feedback]',holding?'抱稳啦，关掉面板，点地面可以抱着走。':paused?'活动暂停，回来后继续。':r?.manual?`${PET_CARE.find(([id])=>id===r.kind)?.[1]}中${r.path.length?' · 正蹦跳着靠近你':' · 等它享受这一刻'}`:feedback?.id===p.id?feedback.text:here?'选一个动作，看看它的反应。':'点叫过来，让它来这个房间陪你。');
  const progress=overlay.querySelector('[data-action-progress]');if(progress){progress.hidden=!r?.manual||holding;if(r?.manual){if(r.path.length||contactState?.phase==='approach')progress.removeAttribute('value');else progress.value=Math.min(1,r.phase/r.duration);}}
 }
 const timer=setInterval(()=>{if(disposed)return;refresh();},250);
 sync();
 return {life,open,portrait:p=>portraits.get(JSON.stringify([p.id,p.color,p.materialColors,p.hat]),models.get(p.id)?.userData.visual),summon(){contact.cancel();for(const p of life.data.pets){life.runtime.delete(p.id);p.roomId=home().activeRoomId;p.x=0;p.z=0;}life.reconcile();life.save();sync();invalidate();},update,interact,interactionOptions,getObject:id=>models.get(id),contact,contactPose:()=>contact.frame(),placeHeld,get contactBusy(){return contact.busy;},consumeShadowChange(){const value=shadowDirty;shadowDirty=false;return value;},reconcile(){life.reconcile();sync();},pick(raycaster,occluders){const hits=raycaster.intersectObjects([...layer.children,...occluders],true).filter(h=>{let o=h.object;while(o){if(!o.visible)return false;o=o.parent;}return true;});let o=hits[0]?.object;while(o&&!o.userData.petId)o=o.parent;return o?.userData.petId;},dispose(){disposed=true;contact.cancel();contactHud.remove();clearInterval(timer);life.save();portraits.dispose();clearModels();layer.removeFromParent();overlay.remove();button.remove();},inspect:()=>({...life.inspect(),contact:contact.inspect()})};
}
