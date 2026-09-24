import {bathroomActivities,isBathAction} from './bathroom.js';
import {createBathroomEffects} from './bathroomEffects.js';
import {interactionIcon,actionIcon} from './interactionIcons.js';
import {roomPixelRatio} from './renderQuality.js';
import {furnitureInteractions,interactionArcLayout} from './furnitureInteractions.js';
import {mirrorActivities,isMirrorAction} from './mirror.js';
import {createMirrorJourney,mirrorJourneyFrame} from './mirrorJourney.js';
import {SHOWROOMS,addShowroom,applyShowroomStyle} from './showrooms.js';
import {ROOM_PALETTES,applyRoomPalette} from './roomPalettes.js';
import {exportRoomLayout,parseRoomLayout,applyRoomLayout} from './roomSharing.js';
import {ROOM_CATEGORIES,USE_CATEGORIES,matchesFurniture,furnitureActions} from './furnitureCatalog.js';
import {createFurnitureHalo} from './furnitureHalo.js';
import {applyRetroFurniture} from './furnitureStyle.js';
import {applyRugPattern} from './rugPattern.js';
import {furniturePaintMaterials,validFurnitureColor} from './furniturePaint.js';
import {roomPlush,plushPose} from './plush.js';
import {furnitureGroup,isDockChair} from './furnitureDock.js';
import {FLOOR_STYLES,WALL_STYLES} from './finishes.js';
import {createRoomFinishes} from './finishMeshes.js';
import {windowDaylightSources} from './windowDaylight.js';
import {windowOpenings,subtractOpenings} from './windowOpenings.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {createWindowDaylight} from './windowDaylightLights.js';
import {isPhoneBrowser,PHONE_BUDGET,furnishingCounts,phoneBudgetError} from './deviceBudget.js';
import {ROOM_HALF,ROOM_SCALE,MAX_BUILDING_LENGTH} from './dimensions.js';
import {gamingActivities,placeGamingPreset,GAMING_ACTIONS} from './gaming.js';
import {diningActivities,placeDiningPreset,fridgeOpenError} from './dining.js';
import {createKitchenEffects} from './kitchenEffects.js';
import {planKitchenAction,kitchenFingerprint,kitchenHands} from './kitchenActivities.js';
import {createKitchenWorkEffects} from './kitchenWorkEffects.js';
import {createGamingEffects} from './gamingEffects.js';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {previewFurniture} from './model.js';
import {roomSeats,roomBeds,seatTransform} from './seating.js';
import {wallFaces,mountOnFace,wallPlacementError} from './wallMount.js';
import {wateringSpot,roomPlants} from './watering.js';
import {createWateringEffect} from './wateringEffect.js';
import {BUILDING_ASSETS,BUILDING_LENGTH,buildingScale,ROOM_EDGES,buildingEdge,placeBuildingOnEdge,snapBuildingToEdge} from './building.js';
import {createBuildingTemplates} from './buildingMeshes.js';
import {ROOM_STEP,OPPOSITE,EDGE_NAMES,WALL_VIEWS,DOOR_KINDS,boundary,neighbor,roomOffset,roomBoundarySegments,connectedRooms,roomGroups,displayRooms,wallVisible,setBoundary} from './topology.js';
import {layoutRoom,moveInHome,layoutError} from './layout.js';
import {walkingMap,findWalkPath,doorTarget} from './navigation.js';
import {createDoor} from './doorMeshes.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {createHome,validateHome,addRoom,findPlace,placementError,clone,PALETTE,STEP,snapToSupport,snapToFurniture,supportSurfaces,moveFurniture} from './model.js';

const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=new Set(['lavender','purple','pink','blush','peri','rug']);
export async function mountHomeEditor(host,{assetBase,initialState,onChange,onBack,storageKey,signal}={}){
 host.classList.add('home3d');host.innerHTML='<div class="h3-stage"></div><div class="h3-ui"></div><div class="h3-loading">正在把家具搬进来…</div>';
 let suspended=false;
 let destroyed=false,state,catalog,kit,selected=null,panel=null,overview=false,edit=false,message='',error=false,undo=[],redo=[],saved=true;
 let sharedRoomText='',roomImportDraft=null;
 let rotationPreview=null,roomScope='floor',interaction=null;
 try{if(localStorage.getItem('sully-home3d-room-scope')==='room')roomScope='room';}catch{}
 let wallView='cutaway',boundaryEdge='back',visibleRoomIds=new Set(),detailedRoomIds=new Set(),doors=[],walking=null,visitorLocation=null;
 try{const v=localStorage.getItem('sully-home3d-wall-view');if(WALL_VIEWS[v])wallView=v;}catch{}
 let objects=[],animated=[],elapsed=0,manual=false,frame=0,drag=null,pointerDown=null,lastTick=performance.now(),lastDraw=0,dirty=true;
 const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
 const touch=matchMedia('(pointer:coarse)').matches;
 const phone=isPhoneBrowser({userAgent:navigator.userAgent,mobile:navigator.userAgentData?.mobile,coarse:touch,width:screen.width,height:screen.height});
 const qualities={eco:{label:'省电',ratio:.75,fps:30,shadows:false,motion:false,details:1},balanced:{label:'均衡',ratio:1,fps:30,shadows:true,motion:true,details:2},clear:{label:'清晰',ratio:1.5,fps:touch?30:60,shadows:true,motion:true,details:touch?2:4}};
 let showroomPalette='';
 let quality='eco';try{const saved=localStorage.getItem('sully-home3d-quality');if(qualities[saved])quality=saved}catch{}
 let detailBudget=qualities[quality].details,frameInterval=1000/qualities[quality].fps,orbitMode=false,inTick=false;
 function wake(){if(!destroyed&&!suspended&&!document.hidden&&!frame&&!inTick&&state)frame=requestAnimationFrame(tick)}
 const materialCache=new Map(),usedMaterials=new Set(),paintTargets=new Map(),defaultPaintColors=new Map();
 let furnitureOutlineEnabled=true;try{furnitureOutlineEnabled=localStorage.getItem('sully-home3d-furniture-outline')!=='off';}catch{}
 let furnitureStyle='retro';try{if(localStorage.getItem('sully-home3d-furniture-style')==='original')furnitureStyle='original';}catch{}
 let renderedFrames=0,category='all',catalogMode='room';
 const stage=host.querySelector('.h3-stage'),ui=host.querySelector('.h3-ui');
 const abort=new AbortController();
 const actionOrbit=document.createElement('div');actionOrbit.className='h3-interaction';actionOrbit.hidden=true;host.append(actionOrbit);
 const scene=new THREE.Scene();scene.background=new THREE.Color('#e8dde7');const windowDaylight=createWindowDaylight(scene);
 let renderer;
 try{renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});}catch(e){host.querySelector('.h3-loading').textContent='这台设备暂时无法打开 3D 小屋，可返回 2D 小屋。';throw e}
 renderer.setPixelRatio(roomPixelRatio(quality,devicePixelRatio,touch));renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.VSMShadowMap;renderer.shadowMap.autoUpdate=false;stage.append(renderer.domElement);
 const camera=new THREE.OrthographicCamera(-5,5,5,-5,.1,200);camera.position.set(9,10,12);
 const furnitureHalo=createFurnitureHalo(renderer,scene,camera);
 function renderScene(){bathroomEffects.update(objects,!edit&&!overview?visitorActivity:null,elapsed-visitorStart,reducedMotion);const reset=renderer.info.autoReset;renderer.info.autoReset=false;renderer.info.reset();try{if(furnitureStyle==='retro'&&furnitureOutlineEnabled){const ids=new Set(state.rooms.flatMap(r=>r.items).filter(i=>!asset(i.assetId)?.building).map(i=>i.id));furnitureHalo.render(objects.filter(o=>ids.has(o.userData.itemId)));}else renderer.render(scene,camera);}finally{renderer.info.autoReset=reset;}}
 const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.enablePan=true;controls.screenSpacePanning=true;controls.target.set(0,2,0);
 let residentFraming=false;
 controls.addEventListener('start',()=>{residentFraming=false});
 controls.addEventListener('change',()=>{dirty=true;wake();positionInteraction()});
 // Let the view descend to almost eye level, including when focused on a
 // short resident, instead of stopping at the old steep room overview.
 controls.minPolarAngle=.5;controls.maxPolarAngle=Math.PI/2-.015;controls.minZoom=.6;controls.maxZoom=10;
 // Warm daylight from the open side, with a restrained cool frontal fill.
 // Keep the resident's no-self-shadow treatment; shape comes from light direction.
 const hemi=new THREE.HemisphereLight('#fff4e7','#c4bbd0',1.45);scene.add(hemi);
 const key=new THREE.DirectionalLight('#fff4e6',2.6);key.position.set(-3.8,9.5,7);key.target.position.set(0,.7,0);scene.add(key.target);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.radius=9;key.shadow.blurSamples=10;key.shadow.normalBias=.012;key.shadow.bias=-.00008;
 // The old shadow camera still fitted the smaller room; cover the enlarged
 // active tile without expanding the map over every neighboring room.
 Object.assign(key.shadow.camera,{left:-7.6,right:7.6,top:7.6,bottom:-7.6,near:.5,far:30});scene.add(key);
 const fill=new THREE.DirectionalLight('#e5ebff',.85);fill.position.set(6,5,3);scene.add(fill);
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(160,160),new THREE.ShadowMaterial({color:'#8b779b',opacity:.12}));ground.rotation.x=-Math.PI/2;ground.position.y=-.47;ground.receiveShadow=true;scene.add(ground);
 const content=new THREE.Group();scene.add(content);const finishes=createRoomFinishes();
 const resident=new THREE.Group();scene.add(resident);
 const plushRoot=new THREE.Group();plushRoot.name='held-plush';resident.add(plushRoot);
 let heldPlush=null,heldMesh=null;
 function putPlushBack(){
  for(const o of objects)if(o.userData.itemId===heldPlush?.itemId)o.visible=true;
  plushRoot.clear();heldMesh=null;heldPlush=null;if(visitorMotion==='hug')visitorMotion='idle';renderer.shadowMap.needsUpdate=true;windowDaylight.invalidate();
 }
 function syncPlush(){
  if(!heldPlush)return;
  const i=current().items.find(i=>i.id===heldPlush.itemId&&!i.stored),a=i&&asset(i.assetId);
  if(heldPlush.roomId!==current().id||!a?.holdable||visitorMotion!=='hug'||visitorSeat?.bed){putPlushBack();return;}
  plushRoot.clear();heldMesh=instance(i.assetId,i.color,false,i.materialColors);plushRoot.add(heldMesh);
  objects.find(o=>o.userData.itemId===i.id)?.traverse(o=>{if(o.userData.itemId===i.id)o.visible=false;});
  const pose=plushPose(a);heldMesh.scale.setScalar(pose.scale);heldMesh.position.fromArray(pose.position);
 }
 let visitor=null,visitorMotion='idle',visitorStart=0,visitorUntil=0,visitorSeat=null,visitorPlant=null,visitorActivity=null,headWidth=1.5;
 const bathroomEffects=createBathroomEffects(),gamingEffects=createGamingEffects(),kitchenEffects=createKitchenEffects(resident),kitchenWork=createKitchenWorkEffects(resident);
 const activities=()=>[...gamingActivities(placementRoom(),catalog,{headWidth}),...diningActivities(placementRoom(),catalog,{headWidth}),...mirrorActivities(placementRoom(),catalog,{headWidth}),...bathroomActivities(placementRoom(),catalog,{headWidth})];
 function stopMirror(){if(!isMirrorAction(visitorActivity?.kind)&&!isBathAction(visitorActivity?.kind))return;visitorActivity=null;visitorMotion='idle';visitorUntil=0;gamingEffects.clear();visitor?.animate(0,'idle');message='镜前动作结束啦';dirty=true;wake();}
 let kitchenTask=null;
 function cancelKitchen(){if(kitchenTask){visitorMotion='idle';visitorUntil=0;resident.position.y=.18;}kitchenTask=null;kitchenWork.clear();}
 const navMap=()=>walkingMap(state,current().level,catalog,{headWidth});
 function stopWalking(keepKitchen=false){walking=null;if(!keepKitchen)cancelKitchen();if(visitorMotion==='walk')visitorMotion='idle';}
 function walkTo(target){
  cancelKitchen();
  if(!visitor||!resident.visible)return false;
  if(visitorSeat||visitorPlant||visitorActivity){visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorSeat=null;visitorPlant=null;visitorLocation=null;placeVisitor();}
  const start=[resident.position.x+current().x*ROOM_STEP.x,resident.position.z+current().z*ROOM_STEP.z],path=findWalkPath(navMap(),start,target);
  if(!path){notify('这里走不过去，检查门洞宽度和两边的家具，给大脑袋留点空间',true);return false;}
  edit=false;overview=false;selected=null;panel=null;visitorMotion='walk';visitorStart=elapsed;walking={path,index:1,last:elapsed};
  visitorLocation={x:start[0],z:start[1],level:current().level};message='出发！';error=false;updateSelection();dirty=true;wake();renderUI();return true;
 }
 function updateWalk(){
  if(!walking)return;let remaining=Math.max(0,elapsed-walking.last)*1.45;walking.last=elapsed;
  while(walking&&walking.index<walking.path.length){const p=walking.path[walking.index],dx=p[0]-visitorLocation.x,dz=p[1]-visitorLocation.z,length=Math.hypot(dx,dz);
   if(length>.001)resident.rotation.y=Math.atan2(dx,dz);
   if(length>remaining){visitorLocation.x+=dx*remaining/length;visitorLocation.z+=dz*remaining/length;break;}
   visitorLocation.x=p[0];visitorLocation.z=p[1];remaining-=length;walking.index++;
  }
  const locationRoom=state.rooms.find(r=>r.level===visitorLocation.level&&Math.abs(visitorLocation.x-r.x*ROOM_STEP.x)<ROOM_HALF.x&&Math.abs(visitorLocation.z-r.z*ROOM_STEP.z)<ROOM_HALF.z);if(roomScope==='room'&&locationRoom&&locationRoom.id!==current().id){activateRoom(locationRoom);persist();rebuild();renderUI();}else if(locationRoom&&!detailedRoomIds.has(locationRoom.id))rebuild();
  resident.position.set(visitorLocation.x-current().x*ROOM_STEP.x,.18,visitorLocation.z-current().z*ROOM_STEP.z);
  if(walking.index>=walking.path.length){const arrived=walking.arrived;stopWalking(true);visitorUntil=elapsed+.1;message='到啦';arrived?.();renderUI();}
  dirty=true;renderer.shadowMap.needsUpdate=true;
 }
 function kitchenLeg(task,station,stage){
  const start=[resident.position.x+current().x*ROOM_STEP.x,resident.position.z+current().z*ROOM_STEP.z],path=findWalkPath(navMap(),start,station.target);
  if(!path){cancelKitchen();visitorMotion='idle';notify('路线被挡住了，先把通道腾出来',true);return;}
  task.stage=stage;task.phaseStart=elapsed;visitorMotion='walk';visitorStart=elapsed;
  visitorLocation={x:start[0],z:start[1],level:current().level};
  walking={path,index:1,last:elapsed,arrived:()=>{
   if(kitchenTask!==task)return;
   resident.rotation.y=station.rotation;task.stage=stage==='approach'?(task.kind==='wash'?'pickup':'work'):stage==='toSink'?'work':'putback';
   task.phaseStart=elapsed;visitorStart=elapsed;visitorMotion=task.kind;visitorUntil=elapsed+15;message=task.stage==='pickup'?'拿好盘子':task.stage==='putback'?'把盘子放回去':({coffee:'咖啡萃取中',wash:'冲洗、擦擦盘子',cook:'慢慢搅拌，煮饭中'}[task.kind]);
  }};dirty=true;wake();
 }
 function updateKitchen(){
  const task=kitchenTask;if(!task)return;
  const room=state.rooms.find(r=>r.id===task.roomId);
  if(current().id!==task.roomId||edit||overview||kitchenFingerprint(room,room?.items.map(i=>i.id)||[])!==task.layoutFingerprint){stopWalking();visitorMotion='idle';message='厨房动作已停止';return;}
  const time=elapsed-task.phaseStart;
  if(task.stage==='pickup'&&time>=1.2){task.carrying=true;kitchenLeg(task,task.sink,'toSink');}
  else if(task.stage==='work'&&time>=(task.kind==='wash'?7:task.kind==='coffee'?8:10)){
   if(task.kind==='wash')kitchenLeg(task,task.source,'return');
   else{message=task.kind==='coffee'?'咖啡做好啦':'饭煮好啦';cancelKitchen();visitorMotion='idle';visitorUntil=0;renderUI();}
  }else if(task.stage==='putback'&&time>=1.2){message='盘子洗干净，放回原处啦';cancelKitchen();visitorMotion='idle';visitorUntil=0;renderUI();}
 }
 function kitchenHandPositions(hands){
  resident.updateWorldMatrix(true,true);
  if(visitor?.rig)return ['R_hand','L_hand'].map(name=>resident.worldToLocal(visitor.rig.bones[name].getWorldPosition(new THREE.Vector3())).toArray());
  return hands.map(p=>p.map(v=>v*.7));
 }
 function updateDoors(){
  if(!state)return;
  for(const door of doors){const leaf=door.userData.doorLeaf,p=door.getWorldPosition(new THREE.Vector3()),near=!!visitor&&resident.visible&&Math.hypot(p.x-resident.position.x,p.z-resident.position.z)<2;
   if(door.userData.doorKind==='door')leaf.rotation.y=near?-Math.PI/2:0;
   if(door.userData.doorKind==='sliding')leaf.position.x=near?door.userData.doorWidth+.06:0;
  }
 }
 const watering=createWateringEffect();resident.add(watering.root);
 const motions=[['idle','站好'],['wave-cute','可爱挥手'],['wave-calm','冷静挥手'],['sleep','睡觉'],['angry','生气'],['dance','晃一晃']];
 function animateVisitor(time){
  updateKitchen();updateWalk();updateDoors();
  if(kitchenTask){
   const working=['work','pickup','putback'].includes(kitchenTask.stage);
   kitchenTask.lift=!visitor?.rig&&working?.58:0;
   resident.position.y=.18+kitchenTask.lift;
  }
  const journey=visitorActivity?.journey;
  let poseTime=time;
  if(journey){
   const f=mirrorJourneyFrame(journey,reducedMotion?journey.duration:time);
   resident.position.fromArray(f.position);resident.rotation.y=f.rotation;
   visitorMotion=f.motion;poseTime=f.time;renderer.shadowMap.needsUpdate=true;
   const stage=f.destination+f.round;
   if(visitorActivity.journeyStage!==stage){visitorActivity.journeyStage=stage;message=f.destination==='wardrobe'?(f.teleported?'通路不够，瞬移到衣柜挑衣服':'去衣柜挑一套衣服'):'回镜子前看看搭配';renderUI();}
   if(f.done){visitorActivity=null;visitorMotion='idle';visitorUntil=0;message='搭配好啦！';renderUI();}
  }
  if(visitorPlant&&time>=4.4){visitorPlant=null;visitorMotion='idle';renderUI();}
  if(visitorActivity&&!journey&&time>=(visitorActivity.duration||12)){const bathing=isBathAction(visitorActivity.kind);if(bathing){bathroomEffects.clear();visitorActivity=null;visitorSeat=null;visitorMotion='idle';visitorUntil=0;placeVisitor();message='好啦，清清爽爽！';renderUI();}else{message=visitorActivity.kind==='eat'?'吃好啦，坐着歇一会儿':visitorActivity.kind==='mirror-admire'?'今天也很可爱呢':visitorActivity.kind==='mirror-outfit'?'搭配好啦，满意地转个身':'这一局结束啦';visitorActivity=null;visitorMotion='idle';visitorUntil=0;renderUI();}}
  if(heldPlush&&visitorMotion!=='hug')putPlushBack();
  const heldAsset=heldPlush&&asset(current().items.find(i=>i.id===heldPlush.itemId)?.assetId),hug=heldAsset&&plushPose(heldAsset,time);
  if(hug&&heldMesh)heldMesh.position.fromArray(hug.position);
  const workHands=kitchenTask?kitchenHands(kitchenTask.kind,elapsed-kitchenTask.phaseStart,kitchenTask.stage!=='work'):null;
  const workPose=workHands&&kitchenTask.stage!=='approach'?{kind:kitchenTask.kind,hands:workHands,carrying:kitchenTask.stage!=='work'}:null;
  visitor?.animate(reducedMotion&&visitorMotion==='rhythm'?0:poseTime,visitorMotion,visitorActivity?.posture||(visitorSeat?.bed?'lying':visitorSeat?'seated':'standing'),workPose||(hug?{kind:'hug',hands:hug.hands}:visitorMotion==='walk'?null:visitorActivity));
  kitchenWork.update(kitchenTask,reducedMotion?1:elapsed-(kitchenTask?.phaseStart||0),workHands?kitchenHandPositions(workHands):[]);
  gamingEffects.update(objects,visitorActivity,time);kitchenEffects.updateMeal(visitorActivity,time);
  watering.update(time,visitorPlant?.spot);
 }
 function placeVisitor(){
  if(kitchenTask){const room=state.rooms.find(r=>r.id===kitchenTask.roomId);if(current().id!==kitchenTask.roomId||edit||overview||kitchenFingerprint(room,room?.items.map(i=>i.id)||[])!==kitchenTask.layoutFingerprint)stopWalking();}
  resident.visible=!!visitor&&!overview;
  if(!visitor||!state)return;
  if((isMirrorAction(visitorActivity?.kind)||isBathAction(visitorActivity?.kind))&&(edit||visitorActivity.roomId!==current().id))stopMirror();
  const focusItem=visitorActivity?.itemId||visitorSeat?.itemId||visitorPlant?.itemId,focusRoom=focusItem&&state.rooms.find(r=>r.items.some(i=>i.id===focusItem));
  if(!overview&&roomScope==='room'&&focusRoom&&focusRoom.id!==current().id){visitorSeat=null;visitorPlant=null;visitorActivity=null;visitorMotion='idle';gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitor.animate(0,'idle');}
  else if(!overview&&focusRoom&&focusRoom.level===current().level&&!detailedRoomIds.has(focusRoom.id)){rebuild();return;}

  if(visitorActivity){const next=activities().find(a=>a.itemId===visitorActivity.itemId&&a.kind===visitorActivity.kind&&a.stationId===visitorActivity.stationId&&!a.reason&&a.roomId===visitorActivity.roomId);if(next){if(visitorActivity.journey){if(next.wardrobeId===visitorActivity.wardrobeId)return;stopMirror();return;}visitorActivity=next;visitorSeat=next.seat;resident.position.fromArray(next.position);resident.rotation.y=next.rotation;kitchenEffects.updateMeal(next,reducedMotion?1:elapsed-visitorStart);return;}visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorMotion='idle';visitor.animate(0,'idle',visitorSeat?.bed?'lying':visitorSeat?'seated':'standing');}
  if(visitorLocation&&visitorLocation.level===current().level&&!visitorSeat&&!visitorPlant){const map=navMap(),{x,z}=visitorLocation;if(map.free(x,z)&&map.areas.some(a=>visibleRoomIds.has(a.roomId)&&x>=a.rect[0]&&x<=a.rect[2]&&z>=a.rect[1]&&z<=a.rect[3])){resident.position.set(x-current().x*ROOM_STEP.x,.18,z-current().z*ROOM_STEP.z);return;}}
  visitorLocation=null;
  if(visitorPlant){
   const spot=visitorPlant.roomId===current().id?wateringSpot(current(),catalog,visitorPlant.itemId):null;
   if(spot){visitorPlant.spot=spot;resident.position.fromArray(spot.position);resident.rotation.y=spot.rotation;watering.update(elapsed-visitorStart,spot);return;}
   visitorPlant=null;visitorMotion='idle';visitor.animate(0,'idle');
  }
  watering.root.visible=false;
  const seat=seatTransform(placementRoom(),catalog,visitorSeat);
  if(seat){resident.position.fromArray(seat.position);resident.position.y+=visitorSeat.bed ? .34 :-(visitor.seatOffset??0);resident.rotation.y=seat.rotation;return;}
  if(visitorSeat){visitorSeat=null;visitorMotion='idle';visitor.animate(0,'idle');}
  resident.rotation.y=0;
  // Reserve the entire head footprint, and prefer open floor near the viewer.
  const map=navMap(),r=current();let spot=null;
  for(let z=ROOM_HALF.z-.85;z>=-ROOM_HALF.z+.85&&!spot;z-=.2)for(const x of Array.from({length:Math.ceil((ROOM_HALF.x-.85)/.4)*2-1},(_,k)=>k===0?0:Math.ceil(k/2)*.4*(k%2?1:-1)))if(map.free(x+r.x*ROOM_STEP.x,z+r.z*ROOM_STEP.z)){spot=[x,.18,z];break;}
  if(spot)resident.position.fromArray(spot);
  resident.visible=!!spot&&!overview;
 }
 function setVisitor(next,{preservePose=false}={}){
  preservePose=!!(preservePose&&visitor&&next);
  if(!preservePose){
   cancelKitchen();closeInteraction();putPlushBack();
   walking=null;visitorLocation=null;visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);
   visitorPlant=null;visitorSeat=null;visitorMotion='idle';visitorStart=elapsed;visitorUntil=0;
  }
  visitor?.dispose();visitor=next;resident.clear();resident.add(watering.root,kitchenEffects.meal,plushRoot,kitchenWork.root);
  if(visitor){resident.add(visitor.root);visitor.animate(0,'idle');visitor.root.updateWorldMatrix(true,true);const bounds=new THREE.Box3();visitor.root.traverse(o=>{if(o.isMesh&&o.name==='chibi-body')bounds.union(new THREE.Box3().setFromObject(o));});headWidth=bounds.isEmpty()?1.5:Math.max(1.5,bounds.getSize(new THREE.Vector3()).x+.08);}
  if(state){if(preservePose){animateVisitor(elapsed-visitorStart);if(residentFraming)focusResident();}else placeVisitor();dirty=true;wake();renderUI();}
 }
 const selection=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({length:4},()=>new THREE.Vector3())),new THREE.LineBasicMaterial({color:0x9d80bd,transparent:true,opacity:.6,depthTest:false}));
 selection.setFromObject=o=>{const b=new THREE.Box3().setFromObject(o),p=selection.geometry.attributes.position,y=b.min.y+.025;[[b.min.x,b.min.z],[b.max.x,b.min.z],[b.max.x,b.max.z],[b.min.x,b.max.z]].forEach(([x,z],i)=>p.setXYZ(i,x,y,z));p.needsUpdate=true;selection.geometry.computeBoundingSphere()};selection.renderOrder=9;selection.visible=false;scene.add(selection);
 const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2(),plane=new THREE.Plane(),hit=new THREE.Vector3();
 const templates=new Map(),thumbs=new Map();let ribbonDoorTemplate=null;
 // Selection-only inverted hulls reuse the asset geometry; no full-screen bloom pass.
 const outlineMaterials=[new THREE.ShaderMaterial({side:THREE.BackSide,transparent:true,depthWrite:false,uniforms:{width:{value:.06},tint:{value:new THREE.Color('#c4a7ff')},alpha:{value:.28}},vertexShader:'uniform float width; void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position+normal*width,1.0);}',fragmentShader:'uniform vec3 tint; uniform float alpha; void main(){gl_FragColor=vec4(tint,alpha);}'}),new THREE.ShaderMaterial({side:THREE.BackSide,transparent:true,depthWrite:false,uniforms:{width:{value:.025},tint:{value:new THREE.Color('#fff2bd')},alpha:{value:.95}},vertexShader:'uniform float width; void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position+normal*width,1.0);}',fragmentShader:'uniform vec3 tint; uniform float alpha; void main(){gl_FragColor=vec4(tint,alpha);} '})];
 let outlinedObject=null,outlineGroup=null;
 function clearOutline(){outlineGroup?.removeFromParent();outlineGroup=null;outlinedObject=null}
 function outlineObject(obj){
  if(outlinedObject===obj)return;clearOutline();if(!obj)return;
  outlineGroup=new THREE.Group();
  for(const material of outlineMaterials){const copy=obj.clone(true);copy.position.set(0,0,0);copy.rotation.set(0,0,0);copy.scale.set(1,1,1);copy.traverse(o=>{if(o.isMesh){o.material=material;o.castShadow=false;o.receiveShadow=false;o.raycast=()=>{};o.renderOrder=2}});outlineGroup.add(copy)}
  obj.add(outlineGroup);outlinedObject=obj;
 }
 const grid=new THREE.Mesh(new THREE.PlaneGeometry(ROOM_STEP.x-.2,ROOM_STEP.z-.2),new THREE.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{tint:{value:new THREE.Color('#b3a0ce')}},vertexShader:'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'varying vec2 vUv; uniform vec3 tint; void main(){vec2 p=(vUv-.5)*vec2(9.1,7.75)/.4; vec2 d=abs(fract(p-.5)-.5)/max(fwidth(p),vec2(.001));float line=1.-min(min(d.x,d.y),1.);vec2 q=p*2.;vec2 e=abs(fract(q-.5)-.5)/max(fwidth(q),vec2(.001));float minor=1.-min(min(e.x,e.y),1.);gl_FragColor=vec4(tint,max(line*.34,minor*.09));}' }));grid.rotation.x=-Math.PI/2;grid.position.y=.166;grid.visible=false;grid.renderOrder=3;scene.add(grid);
 const footprint=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({color:'#8ccea2',transparent:true,opacity:.23,depthWrite:false,depthTest:false}));footprint.rotation.x=-Math.PI/2;footprint.visible=false;footprint.renderOrder=4;scene.add(footprint);
 function placementGuide(obj,valid=true){
  const active=!!drag&&edit&&!overview,kind=item()?asset(item().assetId).surface:'';
  grid.visible=active&&['floor','rug'].includes(kind);footprint.visible=active&&['floor','rug','tabletop'].includes(kind);
  const tint=valid?'#80c99a':'#ef8c99';footprint.material.color.set(tint);selection.material.color.set(active?tint:'#b69be3');
  if(footprint.visible&&obj){const b=new THREE.Box3().setFromObject(obj);footprint.position.set((b.min.x+b.max.x)/2,kind==='tabletop'?obj.position.y+.012:.18,(b.min.z+b.max.z)/2);footprint.scale.set(b.max.x-b.min.x,b.max.z-b.min.z,1)}
 }
 const distantGeometry=new THREE.BoxGeometry(1,1,1);
 const distantMaterials=new Map();
 function distantShell(color){
  let material=distantMaterials.get(color);
  if(!material){material=new THREE.MeshStandardMaterial({color,roughness:.85});distantMaterials.set(color,material)}
  const root=new THREE.Group();
  for(const [x,y,z,w,h,d] of [[0,-.04,0,ROOM_STEP.x,.38,ROOM_STEP.z]]){
   const mesh=new THREE.Mesh(distantGeometry,material);mesh.position.set(x,y,z);mesh.scale.set(w,h,d);root.add(mesh);
  }
  return root;
 }
 let size={w:1,h:1};
 const current=()=>state.rooms.find(r=>r.id===state.activeRoomId);
 function activateRoom(room){
  closeInteraction();
  if(!room||room.id===state.activeRoomId)return;
  if(!overview&&room.level===current().level){const [x,z]=roomOffset(room,current());camera.position.x-=x;camera.position.z-=z;controls.target.x-=x;controls.target.z-=z;controls.update();}
  state.activeRoomId=room.id;
 }
 const selectedOwner=()=>state.rooms.find(r=>r.items.some(i=>i.id===selected));
 const item=()=>{const owner=selectedOwner(),i=owner?.items.find(i=>i.id===selected);if(!i)return;const [x,z]=roomOffset(owner,current()),result={...i,x:i.x+x,z:i.z+z};return rotationPreview?.id===i.id?{...result,...rotationPreview}:result;};
 const placementRoom=()=>layoutRoom(state,current(),catalog);
 function objectPose(obj,i){const room=state.rooms.find(r=>r.id===obj.userData.roomId),[x,z]=roomOffset(room,current());obj.position.set(i.x-x,i.y,i.z-z);obj.rotation.y=i.rotation*Math.PI/180;}
 const assetIndex=new Map();const asset=id=>assetIndex.get(id);
 function notify(text,bad=false){message=text;error=bad;renderUI()}
 function persist(){
  saved=true;
  try{if(storageKey)localStorage.setItem(storageKey,JSON.stringify(state));const result=onChange?.(clone(state));if(result?.catch)result.catch(()=>{saved=false;notify('保存失败，当前布置仍保留在画面中，可导出备份',true)});}catch{saved=false;message='保存失败，请导出备份';error=true}
 }
 function commit(mutator){
  const before=clone(state),selectionBefore=selected,panelBefore=panel,rotationBefore=rotationPreview;stopWalking();message='';error=false;
  try{mutator();const budgetError=phone&&phoneBudgetError(before,state,catalog);if(budgetError)throw Error(budgetError);let unmounted=0;for(const r of state.rooms)for(const i of r.items){const a=asset(i.assetId);if(a?.surface==='wall'&&!i.stored&&wallPlacementError(i,a,r,catalog)){i.stored=true;unmounted++;}}if(unmounted)message='墙面变化，失去承托的挂墙物件已收纳，可撤销';undo.push(before);if(undo.length>40)undo.shift();redo=[];persist();rebuild();renderUI();return true;}catch(e){state=before;selected=selectionBefore;panel=panelBefore;rotationPreview=rotationBefore;rebuild();notify(e.message,true);return false;}
 }
 function applyColor(root,color,wall=false,id='',materialColors={}){
  root.traverse(o=>{if(!o.isMesh)return;const mats=Array.isArray(o.material)?o.material:[o.material];
   o.castShadow=asset(id)?.surface!=='rug'&&mats.every(m=>!m.transparent);o.receiveShadow=true;
   o.material=mats.map(m=>{
    const primary=paintTargets.get(id)||[];
    const paint=wall?((m.name==='cream'&&o.userData.wallPart!=='floor')?color.wall:colors.has(m.name)?color.trim:color.floor&&['wood','woodLight','cream'].includes(m.name)&&o.userData.wallPart==='floor'?color.floor:''):materialColors[m.name]||(color&&primary.includes(m.name)?color:'');
    const retro=furnitureStyle==='retro'&&!wall&&!asset(id)?.building;
    const key=m.uuid+'/'+paint+'/'+retro;usedMaterials.add(key);let c=materialCache.get(key);
    if(!c){c=m.clone();if(retro)applyRetroFurniture(c);if(paint)c.color.set(paint);if(asset(id)?.rugPattern)applyRugPattern(c,o.geometry,asset(id).rugPattern);if(id==='wooden_window'&&m.name==='window-blue'){c.emissive.set('#fff1ce');c.emissiveIntensity=.20;}if(c.transparent)c.depthWrite=false;materialCache.set(key,c)}
    return c});if(o.material.length===1)o.material=o.material[0];
  });
 }
 function instance(id,color,wall,materialColors){const template=templates.get(id);if(!template)throw Error('缺少家具模型：'+id);const obj=template.clone(true);applyColor(obj,color,wall,id,materialColors);obj.traverse(o=>{if(o.isMesh&&o!==obj&&!o.userData.animated&&!o.userData.gamingRole){o.updateMatrix();o.matrixAutoUpdate=false;}});return obj}
 function clearContent(){bathroomEffects.clear();gamingEffects.clear();kitchenEffects.clear();clearOutline();content.traverse(o=>{if(o.isMesh){if(o.geometry.userData.owned)o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])if(m.userData.owned)m.dispose()}});content.clear();objects=[];animated=[]}
 let lastViewKey='';
 function rebuild(){
  closeInteraction();
  finishes.begin();
  const shadowSize=quality==='clear'&&!touch?2048:1024;
  key.shadow.radius=9*shadowSize/1024;
  if(key.shadow.mapSize.x!==shadowSize){key.shadow.map?.dispose();key.shadow.mapPass?.dispose();key.shadow.map=null;key.shadow.mapPass=null;key.shadow.mapSize.set(shadowSize,shadowSize);}
  clearContent();usedMaterials.clear();dirty=true;key.castShadow=!overview&&qualities[quality].shadows;renderer.shadowMap.enabled=key.castShadow;renderer.shadowMap.needsUpdate=true;const active=current();
  // The reference study uses warm bounced light; restore the default rig when leaving it.
  const warmStudy=!overview&&active.items.some(i=>!i.stored&&['study_ref_window','living_ref_window'].includes(i.assetId));
  hemi.color.set(warmStudy?'#fff5e5':'#fff4e7');hemi.groundColor.set(warmStudy?'#c3b49c':'#c4bbd0');
  key.color.set(warmStudy?'#fff1dd':'#fff4e6');fill.color.set(warmStudy?'#fff1d8':'#e5ebff');fill.intensity=warmStudy?.65:.85;
  const visible=overview?state.rooms:displayRooms(state,active,roomScope);visibleRoomIds=new Set(visible.map(r=>r.id));doors=[];
  const detailed=new Set((overview?visible.slice(0,detailBudget):[...visible.filter(r=>r.id===active.id||r.items.some(i=>[visitorActivity?.itemId,visitorSeat?.itemId,visitorPlant?.itemId].includes(i.id))||visitorLocation&&r.level===visitorLocation.level&&Math.abs(visitorLocation.x-r.x*ROOM_STEP.x)<ROOM_HALF.x&&Math.abs(visitorLocation.z-r.z*ROOM_STEP.z)<ROOM_HALF.z),...visible.slice(0,Math.max(phone?1:3,detailBudget))]).map(r=>r.id));detailedRoomIds=detailed;
  for(const r of visible){
   const room=new THREE.Group();room.userData.roomId=r.id;
   const [dx,dz]=roomOffset(r,active);room.position.set(dx,overview?(r.level-active.level)*5.08:0,dz);
   const shell=detailed.has(r.id)?instance('shell',{wall:r.wall,trim:r.trim||'',floor:r.floor||''},true):distantShell(r.floor||'#dfc7ad');shell.userData.roomId=r.id;if(detailed.has(r.id))shell.scale.set(ROOM_SCALE,1,ROOM_SCALE);room.add(shell);
   shell.traverse(o=>{if(o.userData.wallPart&&o.userData.wallPart!=='floor')o.visible=false;if(r.floorStyle&&r.floorStyle!=='original'&&o.isMesh&&o.userData.wallPart==='floor'&&(Array.isArray(o.material)?o.material:[o.material]).some(m=>m.name==='woodLight'))o.visible=false;});
   for(const [edge,e] of Object.entries(ROOM_EDGES)){
    const other=neighbor(state,r,edge),internal=!!other;
    if(other&&visibleRoomIds.has(other.id)&&r.id>other.id)continue;
    let segments=roomBoundarySegments(r,edge,catalog);
    if(other)for(const extra of roomBoundarySegments(other,OPPOSITE[edge],catalog).filter(s=>s.itemId)){
     segments=segments.flatMap(s=>s.hi<=extra.lo||s.lo>=extra.hi?[s]:[{...s,hi:Math.min(s.hi,extra.lo)},{...s,lo:Math.max(s.lo,extra.hi)}].filter(s=>s.hi>s.lo));segments.push(extra);
    }
    for(const segment of segments.filter(s=>!s.itemId||other&&!visibleRoomIds.has(other.id)&&other.items.some(i=>i.id===s.itemId))){
     const replacement=instance(segment.kind,{wall:r.wall,trim:r.trim||'',floor:''},true);
     const holes=segment.kind==='wall_high'?windowOpenings(r,edge,catalog):[];
     if(holes.length){
      const scale=(segment.hi-segment.lo)/BUILDING_LENGTH,mid=(segment.lo+segment.hi)/2;
      const pieces=subtractOpenings({...segment,bottom:.15,top:4.70},holes).map(p=>{
       const g=new THREE.BoxGeometry((p.hi-p.lo)/scale,p.top-p.bottom,.22);g.translate(((p.lo+p.hi)/2-mid)/scale,(p.bottom+p.top)/2-.15,0);return g;
      });
      const geometry=mergeGeometries(pieces);geometry.userData.owned=true;pieces.forEach(g=>g.dispose());
      replacement.traverse(o=>{if(o.isMesh&&o.material.name==='cream')o.geometry=geometry;});
     }
     replacement.position.set(e.axis==='x'?e.at:(segment.lo+segment.hi)/2,.15,e.axis==='z'?e.at:(segment.lo+segment.hi)/2);replacement.rotation.y=e.rotation*Math.PI/180;replacement.scale.x=(segment.hi-segment.lo)/BUILDING_LENGTH;
     replacement.userData.roomId=r.id;replacement.userData.boundaryEdge=edge;replacement.visible=wallVisible(wallView,edge,internal);room.add(replacement);
    }
    const d=boundary(r,edge).door;
    if(d){
     const doorway=createDoor(d,r.wall,r.trim,boundary(r,edge).kind==='wall_high',ribbonDoorTemplate);doorway.position.set(e.axis==='x'?e.at:d.at,.15,e.axis==='z'?e.at:d.at);doorway.rotation.y=e.rotation*Math.PI/180;doorway.userData.roomId=r.id;doorway.userData.boundaryEdge=edge;doorway.visible=wallVisible(wallView,edge,internal);room.add(doorway);doors.push(doorway);
     if(boundary(r,edge).kind==='wall_high'&&d.kind!=='arch'){
      const header=instance('wall_high',{wall:r.wall,trim:r.trim||'',floor:''},true);header.position.copy(doorway.position);header.position.y=2.5;header.rotation.copy(doorway.rotation);header.scale.set(d.width/BUILDING_LENGTH,2.3/4.65,1);header.userData.roomId=r.id;header.userData.boundaryEdge=edge;header.visible=doorway.visible;room.add(header);
     }
     if(!other){
      const apron=new THREE.Mesh(new THREE.BoxGeometry(e.axis==='z'?d.width+.7:2.2,.12,e.axis==='z'?2.2:d.width+.7),new THREE.MeshStandardMaterial({color:r.floor||'#dfc7ad',roughness:1}));apron.geometry.userData.owned=true;apron.material.userData.owned=true;apron.position.copy(doorway.position);apron.position[e.axis]+=Math.sign(e.at)*1.1;apron.position.y=.09;apron.userData.roomId=r.id;room.add(apron);
     }
    }
   }
   if(detailed.has(r.id))for(const i of r.items){if(i.stored)continue;const a=asset(i.assetId),edge=buildingEdge(i);
    // Edge segments are rendered once as part of the shared physical boundary.

    const obj=instance(i.assetId,i.color,false,i.materialColors);obj.position.set(i.x,i.y,i.z);obj.rotation.y=i.rotation*Math.PI/180;if(a.building)obj.scale.x=buildingScale(i);obj.userData.itemId=i.id;obj.userData.roomId=r.id;
    if(a.building)obj.visible=edge?wallVisible(wallView,edge,!!neighbor(state,r,edge)):wallView!=='hidden';
    if(['wall','back','left'].includes(a.surface)){const side=Math.abs(i.x)>ROOM_HALF.x-.7?(i.x>0?'right':'left'):Math.abs(i.z)>ROOM_HALF.z-.65?(i.z>0?'front':'back'):null;obj.visible=side?wallVisible(wallView,side,!!neighbor(state,r,side)):wallView!=='hidden';}
    room.add(obj);objects.push(obj);
    obj.traverse(o=>{if(o.userData.animated)animated.push({o,y:o.position.y,phase:o.userData.phase||0,speed:o.userData.floatSpeed||.6,amplitude:o.userData.floatAmplitude||.02});});
   }
   room.add(finishes.add(r,state,catalog,wallView));content.add(room);
  }
  windowDaylight.update(windowDaylightSources(state,active,catalog,detailed),{quality,touch,overview});
  syncPlush();finishes.end();for(const [key,m] of materialCache)if(!usedMaterials.has(key)){m.dispose();materialCache.delete(key)}
  showRotationPreview();placeVisitor();updateDoors();
  const viewKey=overview+'-'+active.level+'-'+visible.map(r=>r.id).sort().join();resize(viewKey!==lastViewKey);lastViewKey=viewKey;updateSelection();
 }
 function showRotationPreview(){
  if(!rotationPreview)return;const preview=previewFurniture(placementRoom(),rotationPreview.id,rotationPreview);
  for(const i of furnitureGroup(preview,rotationPreview.id)){const obj=objects.find(o=>o.userData.itemId===i.id);if(obj){objectPose(obj,i);}}
 }
 function cancelRotation(){rotationPreview=null;drag=null;pointerDown=null;controls.enableRotate=true;controls.enablePan=true;message='';error=false;rebuild();renderUI();}
 function rotateItem(){
  const chosen=item();if(chosen?.dockId){select(chosen.dockId);}
  const i=item();if(!i||['left','back','wall'].includes(asset(i.assetId).surface))return;
  rotationPreview={id:i.id,rotation:(i.rotation+90)%360};message='转好后拖动放下，或点「放下」';error=false;
  const original=selectedOwner().items.find(v=>v.id===i.id);if(rotationPreview.rotation===original.rotation)rotationPreview=null;
  rebuild();renderUI();host.focus({preventScroll:true});
 }
 function updateSelection(){dirty=true;wake();const obj=objects.find(o=>o.userData.itemId===selected);selection.visible=!!obj&&edit&&!overview;outlineObject(selection.visible?obj:null);if(obj)selection.setFromObject(obj);placementGuide(obj)}
 function resize(fit=false){
  dirty=true;wake();size={w:stage.clientWidth||1,h:stage.clientHeight||1};const ratio=size.w/size.h;
  const box=new THREE.Box3().setFromObject(content),extent=box.isEmpty()?new THREE.Vector3(6.4,4.9,5.5):box.getSize(new THREE.Vector3());
  const multi=overview||visibleRoomIds.size>1;
  let span=multi?Math.max(extent.x*.9+extent.z*.7,extent.y*1.25+extent.z*.5)+2:14.4;
  const height=Math.max(span,span/ratio);camera.left=-height*ratio/2;camera.right=height*ratio/2;camera.top=height/2;camera.bottom=-height/2;
  camera.setViewOffset(size.w,size.h,0,Math.round(size.h*.045),size.w,size.h);
  if(fit){residentFraming=false;const center=multi?box.getCenter(new THREE.Vector3()):new THREE.Vector3(0,2,0);controls.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(9,8,12).multiplyScalar(multi?Math.max(1,extent.length()/12):1));camera.far=Math.max(200,extent.length()*4+50);camera.zoom=1;}
  camera.updateProjectionMatrix();renderer.setSize(size.w,size.h);controls.update();if(interaction)renderInteraction();
 }
 function selectedPanel(){
  const i=item();if(!i||i.stored)return '';const a=asset(i.assetId);
  const dockInfo=`${isDockChair(a)?`<div class="h3-object-actions"><span>${i.dockId?'已吸附 · 拖开椅子可分离':i.dockDisabled?'自动吸附已关闭':'靠近桌子自动吸附'}</span><button data-action="toggle-dock">${i.dockDisabled?'开启吸附':'关闭吸附'}</button></div>`:furnitureGroup(selectedOwner(),i.id).some(n=>n.dockId===i.id)?'<div class="h3-object-actions">桌椅组合 · 移动、转向会一起跟随</div>':''}`;
  const placement=rotationPreview?'<div class="h3-object-actions"><button data-action="place-rotation">✓ 放下</button><button data-action="cancel-rotation">取消旋转</button></div>':'';
  const edgeControls=`<div class="h3-building-types" aria-label="墙段位置">${[['front','前沿'],['back','后沿'],['left','左沿'],['right','右沿'],['inside','室内']].map(([key,label])=>`<button data-action="building-edge" data-value="${key}" aria-pressed="${(buildingEdge(i)||'inside')===key}">${label}</button>`).join('')}</div>`;
  if(a.building)return `${placement}${dockInfo}<div class="h3-object-title"><strong>${esc(a.name)} · ${(i.length??BUILDING_LENGTH).toFixed(1)} 格</strong><button data-action="deselect" aria-label="取消选中">×</button></div><div class="h3-building-types">${BUILDING_ASSETS.map(v=>`<button data-action="building-type" data-id="${v.id}" aria-pressed="${i.assetId===v.id}">${v.name}</button>`).join('')}</div>${edgeControls}<div class="h3-object-actions"><button data-action="building-length" data-delta="-.2" ${(i.length??BUILDING_LENGTH)<=.4?'disabled':''}>缩短</button><button data-action="building-length" data-delta=".2" ${(i.length??BUILDING_LENGTH)>=MAX_BUILDING_LENGTH?'disabled':''}>加长</button><button data-action="rotate">↻ 旋转</button><button data-action="copy">＋ 复制</button><button data-action="remove-building">拆除</button></div>`;
  return `${placement}${dockInfo}<div class="h3-object-title"><strong>${esc(a.name)}${furnitureActions(a).length?`<small class="h3-action-detail">${esc(furnitureActions(a).join(' · '))}</small>`:''}</strong><button data-action="deselect" aria-label="取消选中">×</button></div><div class="h3-object-actions"><button data-action="rotate" ${['left','back','wall'].includes(a.surface)?'disabled':''}>↻ 旋转</button><button data-action="palette">◉ 换色</button><button data-action="copy">＋ 复制</button><button data-action="store">▱ 收纳</button>${a.appliance==='fridge'?'<button data-action="fridge-toggle">'+(kitchenEffects.isOpen(i.id)?'关上冰箱':'打开冰箱')+'</button>':''}${['left','back','wall','ceiling'].includes(a.surface)?'<button data-action="height" data-dy=".2">↑</button><button data-action="height" data-dy="-.2">↓</button>':''}</div>${panel==='palette'?`<div class="h3-swatches">${PALETTE.map(c=>`<button aria-label="换色 ${c}" aria-pressed="${i.color?.toLowerCase()===c.toLowerCase()}" style="background:${c}" data-action="color" data-value="${c}"></button>`).join('')}<button class="reset" data-action="color" data-value="">原色</button></div><label class="h3-custom-color">自选主体颜色<input aria-label="自选家具颜色" type="color" data-furniture-color value="${esc(i.color||defaultPaintColors.get(a.id)||PALETTE[0])}"></label>${(a.colorParts||[]).map(p=>`<label class="h3-custom-color">${esc(p.label)}<input aria-label="${esc(p.label)}颜色" type="color" data-material-color="${p.material}" value="${esc(i.materialColors?.[p.material]||p.color)}"></label>`).join('')}${a.colorParts?.length?'<button data-action="reset-part-colors">枕头恢复原色</button>':''}`:''}`;
 }
 function boundaryPanel(doorsOnly=false){
  const r=current(),v=boundary(r,boundaryEdge),other=neighbor(state,r,boundaryEdge),d=v.door;
  return `<div class="h3-categories" aria-label="选择要改造的房间">${displayRooms(state,r).map(n=>`<button data-action="building-room" data-id="${n.id}" aria-pressed="${n.id===r.id}">${esc(n.name)}</button>`).join('')}</div><div class="h3-building-types" aria-label="房间边界">${Object.entries(EDGE_NAMES).map(([id,label])=>`<button data-action="boundary-edge" data-value="${id}" aria-pressed="${id===boundaryEdge}">${label}</button>`).join('')}</div><p>${other?`与「${esc(other.name)}」之间的隔墙`:'小屋外围'} · ${v.kind==='open'?'已拆除':v.kind==='wall_high'?'高墙':v.kind==='wall_low'?'矮墙':'栅栏'}${d?' · '+DOOR_KINDS[d.kind]:''}</p>
  ${doorsOnly?'':`<div class="h3-actions">${[['wall_high','高墙'],['wall_low','矮墙'],['wall_fence','栅栏'],['open',other?'敲掉隔墙':'拆掉这侧']].map(([id,label])=>`<button data-action="boundary-kind" data-value="${id}" aria-pressed="${v.kind===id}">${label}</button>`).join('')}</div><p>完整隔墙分开房间；拆掉后，两边连成一个可布置的空间。</p>`}
  <div class="h3-actions">${Object.entries(DOOR_KINDS).map(([id,label])=>`<button data-action="boundary-door" data-value="${id}" aria-pressed="${d?.kind===id}">${label}</button>`).join('')}</div>
  ${d?`<p>门洞 ${d.width.toFixed(1)} 格宽 · 至少容得下小人的头</p><div class="h3-actions"><button data-action="door-width" data-delta="-.2">窄一点</button><button data-action="door-width" data-delta=".2">宽一点</button><button data-action="door-offset" data-delta="-.2">沿墙 −</button><button data-action="door-offset" data-delta=".2">沿墙 ＋</button><button data-action="remove-door">拆门补墙</button></div>`:'<p>选择门款即可装到这侧中央；没有墙时会一起立上高墙。</p>'}`;
 }
 function editBoundary(value){commit(()=>{setBoundary(state,current().id,boundaryEdge,value,catalog);const why=layoutError(state,catalog);if(why)throw Error('先挪开隔墙附近的家具：'+why);stopWalking();message=value.kind==='open'?'隔墙已拆除，两边连在一起啦':'墙面已更新';});}
 function doorLinks(){const x=resident.position.x+current().x*ROOM_STEP.x,z=resident.position.z+current().z*ROOM_STEP.z,local=state.rooms.find(r=>visibleRoomIds.has(r.id)&&Math.abs(x-r.x*ROOM_STEP.x)<ROOM_HALF.x&&Math.abs(z-r.z*ROOM_STEP.z)<ROOM_HALF.z);return (local?[local.id]:[...visibleRoomIds]).flatMap(id=>{const r=state.rooms.find(v=>v.id===id);return Object.keys(EDGE_NAMES).filter(edge=>boundary(r,edge).door).map(edge=>{const e=ROOM_EDGES[edge],at=(e.axis==='x'?resident.position.x+current().x*ROOM_STEP.x-r.x*ROOM_STEP.x:resident.position.z+current().z*ROOM_STEP.z-r.z*ROOM_STEP.z),outside=Math.sign(e.at)*(at-e.at)>0,other=neighbor(state,r,edge);return `<button data-action="chibi-door" data-room="${r.id}" data-edge="${edge}" data-inside="${outside}">${esc(r.name)} · ${EDGE_NAMES[edge]}${other?(outside?'回来':'去 '+esc(other.name)):(outside?'进门':'出门')}</button>`;});}).join('');}
 function renderUI(){if(!state)return;
  if(edit||overview||panel)closeInteraction();
  const r=current(),levels=[...new Set(state.rooms.map(r=>r.level))].sort((a,b)=>b-a);
  let sheet='';
  if(panel==='room-share')sheet=`<header><h2>分享房间布局</h2><button data-action="close" aria-label="关闭分享">×</button></header><p>「${esc(r.name)}」· ${r.items.filter(i=>!i.stored).length} 件家具。包含位置、朝向、配色和墙地面；不包含角色、聊天或收纳箱。</p><div class="h3-actions"><button data-action="room-layout-download">下载房间参数</button><button data-action="room-layout-copy">复制参数</button></div><textarea class="h3-layout-text" aria-label="当前房间参数" readonly spellcheck="false">${esc(sharedRoomText)}</textarea><h3>导入他人的房间</h3><textarea class="h3-layout-text" aria-label="粘贴房间参数" placeholder="粘贴房间 JSON 参数，或选择文件" spellcheck="false"></textarea><div class="h3-actions"><button data-action="room-layout-preview">读取粘贴参数</button><button data-action="room-layout-file">选择参数文件</button></div>${roomImportDraft?`<div class="h3-layout-preview"><strong>${esc(roomImportDraft.room.name)}</strong><p>${roomImportDraft.room.items.length} 件家具 · 配色、墙地面与门窗均已读取。</p><p>替换「${esc(r.name)}」已摆放的家具；收纳箱及其他房间保留。与邻房共用的墙面保留，空间不适配时不会应用。</p><button data-action="room-layout-apply">应用到当前房间（可撤销）</button></div>`:''}`;
  if(panel==='building')sheet=`<header><h2>墙体与房间</h2><button data-action="close">×</button></header>${boundaryPanel()}<details><summary>室内墙段 / 局部替换</summary><div class="h3-assets">${BUILDING_ASSETS.map(a=>`<button class="h3-asset" data-action="add-item" data-id="${a.id}"><img alt="" src="${thumbs.get(a.id)||''}">${a.name}</button>`).join('')}</div></details>`;
  else if(panel==='furniture'||panel==='storage'){
   const list=panel==='storage'?state.rooms.flatMap(room=>room.items.filter(i=>i.stored&&!i.supportId&&!i.dockId)).map(i=>({...asset(i.assetId),storedId:i.id})):catalog.filter(a=>matchesFurniture(a,catalogMode,category));
   const categories=catalogMode==='room'?ROOM_CATEGORIES:USE_CATEGORIES;
   const tabs=panel==='furniture'?`<div class="h3-catalog-modes" aria-label="家具分类方式"><button data-action="catalog-mode" data-value="room" aria-pressed="${catalogMode==='room'}">按房间</button><button data-action="catalog-mode" data-value="use" aria-pressed="${catalogMode==='use'}">按用途</button></div><div class="h3-categories h3-catalog-categories" data-mode="${catalogMode}" aria-label="家具分类">${Object.entries({all:'全部',...categories}).map(([key,label])=>`<button data-action="category" data-value="${key}" aria-pressed="${category===key}">${label}</button>`).join('')}</div>`:'';
   const mobileSelect=panel==='furniture'&&catalogMode==='use'?`<label class="h3-catalog-select">用途<select data-catalog-category aria-label="按用途筛选">${Object.entries({all:'全部',...USE_CATEGORIES}).map(([key,label])=>`<option value="${key}" ${category===key?'selected':''}>${label}</option>`).join('')}</select></label>`:'';
   sheet=`<header><h2>${panel==='storage'?'收纳箱':'家具架'}</h2><button data-action="close">×</button></header>${tabs}${mobileSelect}<p class="h3-catalog-legend">${list.length} 件 · 右上角「动作」表示支持互动</p><div class="h3-assets">${list.map(a=>{const actions=furnitureActions(a),label=actions.join('、');return `<button class="h3-asset" data-action="${a.storedId?'restore':'add-item'}" data-id="${a.storedId||a.id}" title="${esc(actions.length?a.name+' · '+label:a.name)}">${actions.length?`<small class="h3-action-badge" aria-label="可互动：${esc(label)}">动作</small>`:''}${thumbs.has(a.id)?`<img alt="" src="${thumbs.get(a.id)}">`:'<span>◇</span>'}${esc(a.name)}</button>`}).join('')}</div>${!list.length?'<p>这个分类暂时还没有家具。</p>':''}`;
  }else if(panel==='selected'||panel==='palette')sheet='';
  else if(panel==='rooms')sheet=`<header><h2>房间与楼层</h2><button data-action="close">×</button></header><div class="h3-actions" aria-label="房间显示范围"><button data-action="room-scope" data-value="floor" aria-pressed="${roomScope==='floor'}">显示同层</button><button data-action="room-scope" data-value="room" aria-pressed="${roomScope==='room'}">只看当前房间</button></div><p>选择下方房间切换；总览仍可查看全部小屋。</p><div class="h3-roomlist">${state.rooms.map(n=>`<button data-action="room" data-id="${n.id}" aria-pressed="${n.id===r.id}"><span>${esc(n.name)}</span><small>${n.level+1}F · ${connectedRooms(state,n.id,catalog).length>1?'已合并 · ':''}${n.x}, ${n.z}</small></button>`).join('')}</div>`;
  else if(panel==='expand')sheet=`<header><h2>从${esc(r.name)}扩建</h2><button data-action="close">×</button></header><div class="h3-expand">${[['back','后方'],['up','楼上'],['front','前方'],['left','左边'],['down','楼下'],['right','右边']].map(([dir,label])=>`<button data-action="expand" data-direction="${dir}" ${dir==='down'&&r.level===0?'disabled':''}>＋ ${label}</button>`).join('')}</div><p>已有房间的位置会直接进入。新房间先留空，慢慢布置。</p>`;
  else if(panel==='room-style')sheet=`<header><h2>${esc(r.name)} · 装扮</h2><button data-action="close">×</button></header><input class="h3-rename" aria-label="房间名字" maxlength="40" value="${esc(r.name)}"><div class="h3-actions"><button data-action="rename">保存名字</button><button data-action="room-share">分享当前房间</button><button data-action="export">导出整屋备份</button><button data-action="import">恢复整屋备份</button></div><p>墙面颜色</p><div class="h3-swatches">${['#FFF2E3',...PALETTE.slice(0,5)].map(c=>`<button aria-label="墙色 ${c}" style="background:${c}" data-action="wall" data-value="${c}"></button>`).join('')}</div>`;
  if(panel==='rooms')sheet+='<div class="h3-actions"><button data-action="room-share">分享当前房间</button></div>';
  if(panel==='rooms'||panel==='expand')sheet+=`<p>精装房配色</p><select aria-label="新样板房配色" data-showroom-palette><option value="">原木黑白绿 · 原版</option>${Object.entries(ROOM_PALETTES).filter(([id])=>id!=='sage').map(([id,p])=>`<option value="${id}" ${showroomPalette===id?'selected':''}>${p.name}</option>`).join('')}</select><p>追加一间样板房 · 保留已有布置</p><div class="h3-actions">${Object.entries(SHOWROOMS).map(([id,t])=>`<button data-action="showroom" data-value="${id}">＋ ${t.name}</button>`).join('')}</div><p>自动放在当前房间旁的空位，可撤销；家具、墙纸和地板均可继续修改。</p>`;
  if(panel==='room-style')sheet+=`<p>精装房配色 · 家具与墙地一起换色</p><div class="h3-actions">${Object.entries(ROOM_PALETTES).map(([id,p])=>`<button data-action="room-palette" data-value="${id}"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:5px;background:${p.accent}"></span>${p.name}</button>`).join('')}</div><p>浅色系保留原木；黑白紫统一黑白家具。可撤销、导出分享。</p>`;
  if(panel==='room-style')sheet+=`<p>原包风格 · 只更新配色和墙地面</p><div class="h3-actions">${Object.entries(SHOWROOMS).map(([key,t])=>`<button data-action="room-style-preset" data-value="${key}">${t.name}</button>`).join('')}</div><p>正在装扮哪间房</p><div class="h3-categories">${displayRooms(state,r).map(n=>`<button data-action="style-room" data-id="${n.id}" aria-pressed="${n.id===r.id}">${esc(n.name)}</button>`).join('')}</div><p>壁纸样式 · 只改这间房</p><div class="h3-categories">${Object.entries(WALL_STYLES).map(([id,label])=>`<button data-action="room-finish" data-part="wallStyle" data-value="${id}" aria-pressed="${(r.wallStyle||'solid')===id}">${label}</button>`).join('')}</div><p>地板样式</p><div class="h3-categories">${Object.entries(FLOOR_STYLES).map(([id,label])=>`<button data-action="room-finish" data-part="floorStyle" data-value="${id}" aria-pressed="${(r.floorStyle||'original')===id}">${label}</button>`).join('')}</div>`;
  if(panel==='room-style')sheet+=`<p>原包风格 · 只更新配色和墙地面</p><div class="h3-actions">${Object.entries(SHOWROOMS).map(([key,t])=>`<button data-action="room-style-preset" data-value="${key}">${t.name}</button>`).join('')}</div><p>房间配色（墙面、边框和地板）</p><div class="h3-actions">${['奶油紫','草莓奶','鼠尾草','云朵蓝'].map((label,i)=>`<button data-action="house-theme" data-value="${i}">${label}</button>`).join('')}</div>${[['trim','边框与底座'],['floor','地板']].map(([part,label])=>`<p>${label}</p><div class="h3-swatches">${PALETTE.map(c=>`<button aria-label="${label} ${c}" style="background:${c}" data-action="house-color" data-part="${part}" data-value="${c}"></button>`).join('')}</div>`).join('')}`;
  if(panel==='quality')sheet=`<header><h2>画质与耗电</h2><button data-action="close">×</button></header><p>家具风格</p><div class="h3-actions">${[['original','原始'],['retro','复古']].map(([id,label])=>`<button data-action="furniture-style" data-value="${id}" aria-pressed="${furnitureStyle===id}">${label}</button>`).join('')}</div><p>复古：清晰色块、简化明暗。只影响这台设备，自动记住选择。</p>${furnitureStyle==='retro'?`<div class="h3-actions"><button data-action="furniture-outline" aria-pressed="${furnitureOutlineEnabled}">家具描边：${furnitureOutlineEnabled?'开':'关'}</button></div><p>关闭描边更省电，保留家具配色与白色反光。</p>`:''}<div class="h3-actions">${Object.entries(qualities).map(([id,q])=>`<button data-action="quality" data-value="${id}" aria-pressed="${quality===id}">${q.label} · ${q.ratio}×</button>`).join('')}</div><p>${quality==='eco'?'低分辨率，关闭阴影与水母动画；静止时停止绘制。':quality==='balanced'?'标准分辨率，柔和阴影与轻微水母动画，最高 30 帧。':'高分辨率，保留阴影和动画，耗电相对较高。'}</p><p>当前绘制尺寸 ${Math.floor(size.w*renderer.getPixelRatio())} × ${Math.floor(size.h*renderer.getPixelRatio())}。所有档位在页面隐藏时停止绘制。</p>`;
  if(panel==='chibi')sheet=`<header><h2>陪小人待一会儿</h2><button data-action="close">×</button></header><div class="h3-actions"><button data-action="chibi-view">蹲下看小人</button><button data-action="room-view">看全屋</button></div><div class="h3-actions" style="margin-top:10px">${motions.filter(([id])=>!visitorSeat?.bed||id==='sleep').map(([id,label])=>`<button data-action="chibi-motion" data-value="${id}" aria-pressed="${visitorMotion===id}">${visitorSeat&&id==='idle'?'坐好':visitorSeat?.bed&&id==='sleep'?'睡一会儿':visitorSeat&&id==='sleep'?'打瞌睡':label}</button>`).join('')}${visitorSeat?'<button data-action="chibi-stand">起身</button>':''}${(kitchenTask||(visitorActivity&&!isMirrorAction(visitorActivity.kind)))?'<button data-action="chibi-game-stop">休息一下</button>':''}${heldPlush?'<button data-action="plush-put-back">放回原位</button>':''}</div><p>点床、座椅、绿植或设备，就能选择它的互动。</p><p>${resident.visible?'小手只轻轻挥，不会拉长。':'房间没有足够空地，请先收起一件落地家具。'}</p>`;
  if(panel==='furniture'&&catalogMode==='room'&&category==='kitchen')sheet=sheet.replace('<div class="h3-assets">','<div class="h3-actions"><button data-action="dining-preset">摆好餐桌和两张餐椅</button></div><div class="h3-assets">');
  if(panel==='furniture'&&catalogMode==='room'&&category==='gaming')sheet=sheet.replace('<div class="h3-assets">',`<p>摆好一套（每件仍能单独移动）</p><div class="h3-actions">${Object.entries(GAMING_ACTIONS).map(([id,label])=>`<button data-action="gaming-preset" data-kind="${id}">${label}套装</button>`).join('')}</div><div class="h3-assets">`);
  if(panel==='chibi')sheet+=`<p>点空地走过去；门会在靠近时打开。</p><div class="h3-actions">${doorLinks()}</div>`;
  if(phone&&['furniture','storage','expand','rooms','room-style'].includes(panel)){const count=furnishingCounts(state,catalog).get(r.id)||0;sheet=sheet.replace('</header>',`</header><p class="h3-budget">手机容量 · 面积 ${state.rooms.length}/${PHONE_BUDGET.rooms} 块 · 本区域家具 ${count}/${PHONE_BUDGET.furniture} 件${state.rooms.length>PHONE_BUDGET.rooms||count>PHONE_BUDGET.furniture?' · 已超限，可继续收纳整理':''}</p>`);}
  ui.innerHTML=`<div class="h3-top">${onBack?'<button class="h3-pill" data-action="back">2D 小屋</button>':''}<div class="h3-title"><strong>${esc(overview?'我的小小世界':r.name)}</strong><small>${r.level+1}F · ${roomGroups(state,catalog).length} 间房 · ${rotationPreview?'旋转预览 · 待放下':saved?'布置已保存':'尚未保存'}</small></div><button class="h3-pill" data-active="${overview}" data-action="overview">${overview?'回房间':'总览'}</button><button class="h3-pill" data-active="${edit}" data-action="edit">${edit?'完成':'布置'}</button></div><div class="h3-wall-views" aria-label="墙面显示">${Object.entries(WALL_VIEWS).map(([id,label])=>`<button data-action="wall-view" data-value="${id}" aria-pressed="${wallView===id}">${label}</button>`).join('')}</div><div class="h3-floor">${levels.map(l=>`<button data-active="${l===r.level}" data-action="floor" data-level="${l}">${l+1}F</button>`).join('')}</div><div class="h3-camera-tools"><button data-action="zoom" data-factor="1.2" aria-label="放大">＋</button><button data-action="zoom" data-factor=".833333" aria-label="缩小">−</button><button data-action="turn-view" data-angle="-.785398" aria-label="视角向左">↶</button><button data-action="turn-view" data-angle=".785398" aria-label="视角向右">↷</button></div>${edit?`<div class="h3-history"><button data-action="undo" aria-label="撤销" ${undo.length||rotationPreview?'':'disabled'}>↶ 撤销</button><button data-action="redo" aria-label="重做" ${redo.length?'':'disabled'}>↷ 重做</button></div>`:''}${edit&&selected&&!sheet?`<section class="h3-object-bar">${selectedPanel()}</section>`:''}${sheet?`<section class="h3-sheet">${sheet}</section>`:''}<div class="h3-status" ${sheet||selected&&!error?'style="display:none"':''}><span class="${error?'error':''}">${esc(message||(overview?'点一间房，进去看看':edit?'拖选中家具 · 单指转向 · 双指缩放平移':'点家具互动 · 拖动转向 · 双击小人放大'))}</span></div><nav class="h3-dock">${[...(visitor?[['chibi','♡','小人']]:[]),['furniture','♧','家具'],['building','▥','建造'],['storage','▱','收纳'],['expand','＋','扩建'],['rooms','⌂','房间'],['room-style','◌','装扮'],['quality','◇','画质']].map(([id,icon,label])=>`<button data-action="panel" data-panel="${id}" data-active="${panel===id}"><b>${interactionIcon({chibi:'jelly',furniture:'furniture',building:'building',storage:'storage',expand:'expand',rooms:'rooms','room-style':'style',quality:'quality'}[id])}</b>${label}</button>`).join('')}</nav>`;
 }
 const placementFor=a=>['floor','rug'].includes(a.surface)&&!a.building?placementRoom():current();
 function checkWallLayout(){const why=layoutError(state,catalog);if(why)throw Error('墙段会挡住家具：'+why);}
 function changeItem(patch){const i=item();if(!i)return false;return commit(()=>{moveInHome(state,current(),i.id,{...(rotationPreview?.id===i.id?rotationPreview:{}),...patch},catalog);if(asset(item()?.assetId)?.building)checkWallLayout();rotationPreview=null;message='已放好';error=false})}
 function select(id){closeInteraction();if(rotationPreview&&id!==selected&&!changeItem(rotationPreview))return;selected=id;const owner=selectedOwner();if(owner&&owner.id!==current().id){activateRoom(owner);persist();rebuild();}panel='selected';edit=true;overview=false;controls.enabled=true;updateSelection();renderUI()}
 function action(e){const b=e.target.closest('[data-action]');if(!b||b.disabled)return;const d=b.dataset;
  if(d.action==='room-share'){
   try{sharedRoomText=JSON.stringify(exportRoomLayout(current(),catalog),null,2);roomImportDraft=null;panel='room-share';selected=null;renderUI();}catch(e){notify(e.message,true);}return;
  }
  if(d.action==='room-layout-download'){
   const url=URL.createObjectURL(new Blob([sharedRoomText],{type:'application/json'})),a=document.createElement('a');
   a.href=url;a.download=(current().name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')||'房间')+'.room.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
  }
  if(d.action==='room-layout-copy'){
   navigator.clipboard?.writeText(sharedRoomText).then(()=>{if(!destroyed)notify('房间参数已复制，可以发给朋友');}).catch(()=>{if(!destroyed)notify('请选中上方参数文本手动复制',true);});
   if(!navigator.clipboard)notify('请选中上方参数文本手动复制',true);return;
  }
  if(d.action==='room-layout-preview'){
   try{roomImportDraft={room:parseRoomLayout(ui.querySelector('[aria-label="粘贴房间参数"]').value,catalog),targetId:current().id};renderUI();}catch(e){roomImportDraft=null;notify(e.message,true);}return;
  }
  if(d.action==='room-layout-file'){
   const input=document.createElement('input'),targetId=current().id;input.type='file';input.accept='.json,application/json';
   input.onchange=async()=>{try{const f=input.files?.[0];if(!f)return;if(f.size>1024*1024)throw Error('房间参数过大（上限 1 MB）');const text=await f.text();if(destroyed||current().id!==targetId||panel!=='room-share')return;roomImportDraft={room:parseRoomLayout(text,catalog),targetId};renderUI();}catch(e){if(!destroyed){roomImportDraft=null;notify(e.message,true);}}};input.click();return;
  }
  if(d.action==='room-layout-apply'){
   if(!roomImportDraft||roomImportDraft.targetId!==current().id){notify('请在目标房间重新读取参数',true);return;}
   if(commit(()=>{state=applyRoomLayout(state,current().id,roomImportDraft.room,catalog);selected=null;panel=null;message='房间布局已应用，可撤销';})){roomImportDraft=null;visitorActivity=null;visitorSeat=null;visitorPlant=null;heldPlush=null;visitorMotion='idle';edit=true;overview=false;controls.enabled=true;placeVisitor();renderUI();host.focus({preventScroll:true});dirty=true;wake();}return;
  }
  if(d.blocked){notify(d.blocked,true);return;}
  if(d.action==='interaction-close'){closeInteraction();host.focus({preventScroll:true});return;}
  if(d.action==='interaction-more'){if(interaction){interaction.page++;renderInteraction();}return;}
  if(!['zoom','turn-view'].includes(d.action))closeInteraction();
  if(d.action==='plush-put-back'){putPlushBack();animateVisitor(0);dirty=true;wake();notify('玩偶放回原位啦');return;}
  if(d.action==='chibi-hug'&&visitor){
   if(!roomPlush(current(),catalog).some(p=>p.itemId===d.id))return;
   stopWalking();putPlushBack();visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorPlant=null;if(visitorSeat?.bed)visitorSeat=null;
   placeVisitor();if(!resident.visible){notify('先给孩子留一点站立空间，再抱玩偶',true);return;}
   heldPlush={roomId:current().id,itemId:d.id};visitorMotion='hug';visitorStart=elapsed;visitorUntil=elapsed+4.4;edit=false;overview=false;selected=null;panel=null;syncPlush();animateVisitor(0);updateSelection();renderer.shadowMap.needsUpdate=true;notify('抱住啦！在小人面板可以放回原位');return;
  }
  if(d.action==='dining-preset'){commit(()=>{const items=placeDiningPreset(placementRoom(),catalog);if(current().items.length+items.length>100)throw Error('每间房最多保存 100 件家具');current().items.push(...items);panel=null;selected=null;message='餐桌椅摆好啦，点餐桌或餐椅就能吃饭';});return;}
  if(d.action==='fridge-toggle'){const i=d.id?placementRoom().items.find(i=>i.id===d.id):item(),obj=objects.find(o=>o.userData.itemId===i?.id);if(!obj||asset(i.assetId)?.appliance!=='fridge')return;const why=kitchenEffects.isOpen(i.id)?'':fridgeOpenError(i,placementRoom(),catalog,resident.visible?resident.position.toArray():null);if(why){notify(why,true);return;}kitchenEffects.toggle(obj);dirty=true;wake();renderUI();return;}
  if(d.action==='gaming-preset'){commit(()=>{const items=placeGamingPreset(d.kind,placementRoom(),catalog);if(current().items.length+items.length>100)throw Error('每间房最多保存 100 件家具');current().items.push(...items);panel=null;selected=null;message='设备和座位摆好啦，点设备就能开始玩啦';});return;}
  if(d.action==='chibi-kitchen'&&visitor){
   stopWalking();putPlushBack();visitorActivity=null;visitorPlant=null;visitorSeat=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);placeVisitor();
   const start=[resident.position.x+current().x*ROOM_STEP.x,resident.position.z+current().z*ROOM_STEP.z];
   const task=planKitchenAction(state,current(),catalog,d.id,start,headWidth);
   if(task.reason){notify(task.reason,true);return;}
   edit=false;overview=false;selected=null;panel=null;kitchenTask=task;kitchenLeg(task,task.source,'approach');message='这就去'+({coffee:'做咖啡',wash:'取盘子洗碗',cook:'煮饭'}[task.kind]);updateSelection();renderUI();return;
  }
  if(['chibi-game','chibi-mirror','chibi-bath'].includes(d.action)&&visitor){const next=activities().find(a=>a.itemId===d.id&&a.kind===d.kind&&(a.stationId||'')===(d.station||''));if(!next||next.reason){notify(next?.reason||'家具或搭配条件已经变了',true);return;}stopWalking();visitorLocation=null;visitorPlant=null;visitorActivity=next;visitorSeat=next.seat;visitorMotion=next.kind;if(next.kind==='mirror-outfit'){
   const map=navMap(),ox=current().x*ROOM_STEP.x,oz=current().z*ROOM_STEP.z;
   next.journey=createMirrorJourney(next,resident.position.toArray(),(a,b)=>findWalkPath(map,[a[0]+ox,a[2]+oz],[b[0]+ox,b[2]+oz])?.map(p=>[p[0]-ox,.18,p[1]-oz]));
  }if(next.kind==='rhythm'&&camera.zoom>1.8){const offset=camera.position.clone().sub(controls.target);controls.target.fromArray(next.position).add(new THREE.Vector3(0,1.6,0));camera.position.copy(controls.target).add(offset);camera.zoom=1.8;camera.updateProjectionMatrix();controls.update();}visitorStart=elapsed;visitorUntil=elapsed+(next.journey?.duration||next.duration||12);edit=false;overview=false;selected=null;panel=null;placeVisitor();animateVisitor(reducedMotion?1:0);message=next.label+((isMirrorAction(next.kind)||isBathAction(next.kind))?'中':'中 · 在小人面板可随时休息');dirty=true;wake();renderUI();return;}
  if(d.action==='chibi-game-stop'){stopWalking();const bathing=isBathAction(visitorActivity?.kind);visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorMotion='idle';visitorUntil=0;if(bathing){bathroomEffects.clear();placeVisitor();}animateVisitor(0);dirty=true;wake();renderUI();return;}
  if(['chibi-water','chibi-sit','chibi-stand','chibi-motion'].includes(d.action)){stopWalking();visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);}
  if(d.action==='wall-view'){wallView=d.value;try{localStorage.setItem('sully-home3d-wall-view',wallView)}catch{}rebuild();renderUI();return;}
  if(d.action==='boundary-edge'){boundaryEdge=d.value;renderUI();return;}
  if(d.action==='boundary-kind'){editBoundary({kind:d.value});return;}
  if(d.action==='boundary-door'){const v=boundary(current(),boundaryEdge);editBoundary({kind:v.kind==='open'?'wall_high':v.kind,door:{at:0,width:Math.ceil(Math.max(1.8,headWidth+.3)*5)/5,...v.door,kind:d.value}});return;}
  if(d.action==='remove-door'){editBoundary({kind:boundary(current(),boundaryEdge).kind});return;}
  if(['door-width','door-offset'].includes(d.action)){const v=clone(boundary(current(),boundaryEdge));if(v.door){const field=d.action==='door-width'?'width':'at';v.door[field]=Math.round((v.door[field]+Number(d.delta))*10)/10;if(v.door.width<Math.max(1.8,headWidth+.15)){notify('门洞不能比小人的头更窄',true);return;}editBoundary(v);}return;}
  if(d.action==='chibi-door'){const r=state.rooms.find(r=>r.id===d.room),target=doorTarget(state,r,d.edge,d.inside==='true');if(target)walkTo(target);return;}
  if(d.action==='rotate'){rotateItem();return;}
  if(d.action==='place-rotation'){if(rotationPreview)changeItem(rotationPreview);return;}
  if(d.action==='cancel-rotation'){cancelRotation();return;}
  if(rotationPreview){
   if(['undo','deselect'].includes(d.action)){cancelRotation();return;}
   if(['store','remove-building'].includes(d.action))cancelRotation();
   else if(!['zoom','turn-view','orbit','height','nudge'].includes(d.action)&&!changeItem(rotationPreview))return;
  }
  if(d.action==='chibi-view'&&visitor&&resident.visible){
   const offset=camera.position.clone().sub(controls.target),distance=offset.length();
   offset.y=0;if(offset.lengthSq()<.001)offset.set(0,0,1);offset.normalize().multiplyScalar(distance);
   // Look slightly down at held toys and sleeping faces instead of hiding them
   // behind a nearby table or the bed's footboard. Orbit remains freely movable.
   offset.y=distance*(kitchenTask?.stage==='work'?.8:visitorSeat?.bed?.75:heldPlush?.55:.045);
   const jumping=visitorActivity?.kind==='rhythm';controls.target.copy(resident.position).add(new THREE.Vector3(0,jumping?1.6:.85,0));camera.position.copy(controls.target).add(offset);camera.zoom=jumping?1.8:2.4;
   camera.updateProjectionMatrix();controls.update();if(!jumping){focusResident();return;}panel=null;dirty=true;wake();renderUI();return;
  }
  if(d.action==='room-view'){resize(true);panel=null;renderUI();return}
  if(d.action==='panel'&&d.panel==='chibi'){panel=panel==='chibi'?null:'chibi';edit=false;overview=false;selected=null;rebuild();renderUI();return}
  if(d.action==='chibi-water'&&visitor){stopWalking();visitorLocation=null;
   const spot=wateringSpot(current(),catalog,d.id);if(!spot){notify('绿植四周都太挤啦，先挪开一点家具',true);return;}
   visitorSeat=null;visitorPlant={roomId:current().id,itemId:d.id,spot};visitorMotion='water';visitorStart=elapsed;visitorUntil=elapsed+4.5;
   edit=false;overview=false;selected=null;panel=null;placeVisitor();animateVisitor(reducedMotion?1:0);dirty=true;wake();notify('找到空位啦，给绿植浇一点水');return;
  }
  if(d.action==='chibi-bed'&&visitor){
   const bed=roomBeds(current(),catalog).find(s=>s.itemId===d.id&&s.seatId===d.seat);if(!bed)return;
   stopWalking();visitorLocation=null;visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorPlant=null;visitorSeat=bed;visitorMotion='sleep';visitorStart=elapsed;visitorUntil=elapsed+4.4;
   edit=false;overview=false;selected=null;panel=null;placeVisitor();animateVisitor(0);updateSelection();renderer.shadowMap.needsUpdate=true;notify('躺好啦，睡个好觉');return;
  }
  if(d.action==='chibi-sit'&&visitor){stopWalking();visitorLocation=null;visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);
   const seat=roomSeats(current(),catalog).find(s=>s.itemId===d.id&&s.seatId===d.seat);
   if(!seat)return;visitorPlant=null;visitorSeat=seat;visitorMotion='idle';visitorStart=elapsed;visitorUntil=elapsed+4.4;
   animateVisitor(0);edit=false;overview=false;selected=null;panel=null;placeVisitor();updateSelection();renderer.shadowMap.needsUpdate=true;
   notify('坐好啦，小脚晃不到地面');return;
  }
  if(d.action==='chibi-stand'&&visitor){visitorPlant=null;visitorSeat=null;visitorMotion='idle';visitorStart=elapsed;visitorUntil=0;placeVisitor();animateVisitor(0);dirty=true;wake();renderUI();return}
  if(d.action==='chibi-motion'&&visitor){stopWalking();visitorPlant=null;visitorMotion=d.value;visitorStart=elapsed;visitorUntil=elapsed+4.4;placeVisitor();animateVisitor(reducedMotion?1:0);dirty=true;wake();renderUI();return}
  if(d.action==='orbit'){orbitMode=!orbitMode;controls.enabled=true;renderUI();return}
  if(d.action==='turn-view'){const offset=camera.position.clone().sub(controls.target);offset.applyAxisAngle(new THREE.Vector3(0,1,0),Number(d.angle));camera.position.copy(controls.target).add(offset);controls.update();dirty=true;wake();return}
  if(d.action==='furniture-outline'){furnitureOutlineEnabled=!furnitureOutlineEnabled;try{localStorage.setItem('sully-home3d-furniture-outline',furnitureOutlineEnabled?'on':'off')}catch{}dirty=true;wake();renderUI();return}
  if(d.action==='furniture-style'){furnitureStyle=d.value==='original'?'original':'retro';try{localStorage.setItem('sully-home3d-furniture-style',furnitureStyle)}catch{}rebuild();renderUI();return}
  if(d.action==='quality'){quality=d.value;if(!qualities[quality])quality='eco';const q=qualities[quality];detailBudget=q.details;frameInterval=1000/q.fps;renderer.setPixelRatio(roomPixelRatio(quality,devicePixelRatio,touch));try{localStorage.setItem('sully-home3d-quality',quality)}catch{}rebuild();renderUI();return}
  if(d.action==='room-palette'){commit(()=>{applyRoomPalette(current(),d.value,catalog);message='已应用'+ROOM_PALETTES[d.value].name;});return;}
  if(d.action==='room-style-preset'){commit(()=>applyShowroomStyle(current(),d.value));return;}
  if(d.action==='room-finish'){const options=d.part==='floorStyle'?FLOOR_STYLES:d.part==='wallStyle'?WALL_STYLES:null;if(options&&Object.hasOwn(options,d.value))commit(()=>{current()[d.part]=d.value});return}
  if(d.action==='style-room'){activateRoom(state.rooms.find(r=>r.id===d.id));selected=null;persist();rebuild();renderUI();return}
  if(d.action==='house-color'){commit(()=>{current()[d.part]=d.value});return}
  if(d.action==='house-theme'){commit(()=>{const themes=[['#FFF2E3','#A99BE8','#D7B28A'],['#FFF8F2','#F2B8D5','#E6C9B1'],['#F3F6EE','#A5B99A','#D7B28A'],['#FFF8F2','#91C9F4','#DAD3DE']];const t=themes[Number(d.value)];[current().wall,current().trim,current().floor]=t});return}
  if(d.action==='catalog-mode'){if(!['room','use'].includes(d.value))return;catalogMode=d.value;category='all';renderUI();return}
  if(d.action==='category'){if(d.value!=='all'&&!(d.value in (catalogMode==='room'?ROOM_CATEGORIES:USE_CATEGORIES)))return;category=d.value;renderUI();return}
  if(d.action==='building-type'){if(item()&&asset(item().assetId)?.building&&BUILDING_ASSETS.some(a=>a.id===d.id))changeItem({assetId:d.id});return}
  if(d.action==='building-edge'){if(item()&&asset(item().assetId)?.building){const i=item();changeItem(d.value==='inside'?{x:0,z:-.8}:placeBuildingOnEdge(i,d.value));}return}
  if(d.action==='building-length'){if(item()&&asset(item().assetId)?.building)changeItem({length:Math.round(((item().length??BUILDING_LENGTH)+Number(d.delta))*10)/10});return}
  if(d.action==='remove-building'){if(item()&&asset(item().assetId)?.building)commit(()=>{selectedOwner().items=selectedOwner().items.filter(i=>i.id!==selected);selected=null;panel=null;message='墙段已拆除，可以撤销'});return}
  if(d.action==='back'){onBack?.();return}
  if(d.action==='close'){panel=null;renderUI();return}
  if(d.action==='edit'){if(!edit){putPlushBack();stopMirror();}stopWalking();edit=!edit;selected=null;panel=null;controls.enabled=true;updateSelection();renderUI();return}
  if(d.action==='room-scope'){if(!['floor','room'].includes(d.value))return;if(rotationPreview&&!changeItem(rotationPreview))return;stopWalking();visitorLocation=null;roomScope=d.value;overview=false;selected=null;try{localStorage.setItem('sully-home3d-room-scope',roomScope);}catch{}rebuild();renderUI();return;}
  if(d.action==='overview'){stopWalking();overview=!overview;edit=false;panel=null;selected=null;controls.enabled=true;rebuild();renderUI();return}
  if(d.action==='panel'){panel=panel===d.panel?null:d.panel;if(['furniture','storage','building','room-style'].includes(panel)){stopWalking();edit=true;overview=false;controls.enabled=true;rebuild()}renderUI();return}
  if(d.action==='deselect'){selected=null;panel=null;updateSelection();renderUI();return}
  if(d.action==='palette'){panel=panel==='palette'?'selected':'palette';renderUI();return}
  if(d.action==='zoom'){residentFraming=false;camera.zoom=Math.max(controls.minZoom,Math.min(controls.maxZoom,camera.zoom*Number(d.factor)));camera.updateProjectionMatrix();dirty=true;wake();return}
  if(d.action==='redo'){if(redo.length){undo.push(clone(state));state=redo.pop();stopWalking();visitorLocation=null;selected=null;panel=null;persist();rebuild();renderUI()}return}
  if(d.action==='undo'){if(undo.length){redo.push(clone(state));state=undo.pop();stopWalking();visitorLocation=null;selected=null;panel=null;persist();rebuild();renderUI()}return}
  if(d.action==='building-room'){stopWalking();visitorLocation=null;activateRoom(state.rooms.find(r=>r.id===d.id));selected=null;persist();rebuild();renderUI();return}
  if(d.action==='room'||d.action==='floor'){const r=d.action==='room'?state.rooms.find(r=>r.id===d.id):state.rooms.find(r=>r.level===Number(d.level));if(r){stopWalking();visitorLocation=null;activateRoom(r);overview=false;selected=null;panel=null;persist();rebuild();renderUI()}return}
  if(d.action==='showroom'){commit(()=>{const added=addShowroom(state,d.value,catalog,{compact:phone});if(showroomPalette)applyRoomPalette(added,showroomPalette,catalog);visitorLocation=null;panel=null;selected=null;edit=true;overview=false;controls.enabled=true;message=phone&&d.value==='bedroom'?'已添加手机精简卧室，每件家具都可以单独调整':'样板房已搬来，每件家具都可以单独调整';});return;}
  if(d.action==='expand'){commit(()=>{visitorLocation=null;addRoom(state,d.direction);panel=null;selected=null;edit=true;overview=false;controls.enabled=true;message='新空间，留给新的生活';error=false});return}
  if(d.action==='add-item'||d.action==='restore'){commit(()=>{
   if(d.action==='add-item'){
    if(current().items.length>=100)throw Error('每间房最多保存 100 件家具');
    const added=findPlace(asset(d.id),placementFor(asset(d.id)),catalog);current().items.push(added);selected=added.id;if(asset(added.assetId).building)checkWallLayout();
   }else{
    const owner=state.rooms.find(r=>r.items.some(i=>i.id===d.id&&i.stored));if(!owner)throw Error('收纳箱里没有这件家具');
    if(owner!==current()&&current().items.length>=100)throw Error('每间房最多保存 100 件家具');
    const stored=owner.items.find(i=>i.id===d.id),next=findPlace(asset(stored.assetId),placementFor(asset(stored.assetId)),catalog,stored.id,stored.length);
    const group=furnitureGroup(owner,stored.id);
    if(owner!==current()&&current().items.length+group.length>100)throw Error('每间房最多保存 100 件家具');
    owner.items=owner.items.filter(i=>!group.includes(i));
    for(const i of group)i.stored=false;
    current().items.push(...group);moveInHome(state,current(),stored.id,{...next,color:stored.color},catalog);selected=next.id;
   }
   panel='selected';message='拖动试试新的位置';error=false;
  });return}
  if(d.action==='copy'){const original=item();if(original)commit(()=>{if(current().items.length>=100)throw Error('每间房最多保存 100 件家具');const added=findPlace(asset(original.assetId),placementFor(asset(original.assetId)),catalog,undefined,original.length);added.color=original.color;if(original.materialColors)added.materialColors=clone(original.materialColors);if(asset(original.assetId).building){added.rotation=original.rotation;const angle=original.rotation*Math.PI/180,length=original.length??BUILDING_LENGTH;added.x=original.x+Math.cos(angle)*length;added.z=original.z-Math.sin(angle)*length;if(placementError(added,current(),catalog)){Object.assign(added,findPlace(asset(original.assetId),placementFor(asset(original.assetId)),catalog,added.id,original.length));}}current().items.push(added);selected=added.id;if(asset(added.assetId).building)checkWallLayout();});return}
  if(d.action==='nudge'){const i=item();if(i){const a=asset(i.assetId);changeItem({x:i.x+(a.surface==='left'?0:Number(d.dx)),z:i.z+(a.surface==='back'?0:Number(d.dz))})}return}
  if(d.action==='height'){if(item())changeItem({y:Math.max(.15,Math.min(4.5,item().y+Number(d.dy)))});return}
  if(d.action==='reset-part-colors'){commit(()=>{if(item())delete selectedOwner().items.find(i=>i.id===selected).materialColors;});return;}
  if(d.action==='color'){if(d.value&&!validFurnitureColor(d.value))return;commit(()=>{if(item())selectedOwner().items.find(i=>i.id===selected).color=d.value||null});return}
  if(d.action==='toggle-dock'){const i=item();if(i)changeItem({dockDisabled:!i.dockDisabled,dockId:null,dockSlot:null});return}
  if(d.action==='store'){commit(()=>{const i=item();if(i){for(const member of furnitureGroup(selectedOwner(),i.id)){member.stored=true;if(member.id===i.id){member.supportId=null;member.dockId=null;member.dockSlot=null;}}}selected=null;panel=null;message='已收纳，桌面小物和吸附的椅子会一起收好';error=false});return}
  if(d.action==='wall'){commit(()=>{current().wall=d.value});return}
  if(d.action==='rename'){const name=ui.querySelector('.h3-rename').value.trim();if(name)commit(()=>{current().name=name});return}
  if(d.action==='export'){const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='我的小屋.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return}
  if(d.action==='import'){const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.onchange=async()=>{try{const f=input.files?.[0];if(!f)return;if(f.size>1024*1024)throw Error('布置文件过大');const incoming=validateHome(JSON.parse(await f.text()),catalog);const budgetError=phone&&phoneBudgetError(null,incoming,catalog);if(budgetError)throw Error(budgetError);commit(()=>{state=incoming;selected=null;panel=null;message='布置已导入，可撤销回到刚才的房间'})}catch(e){notify(e.message,true)}};input.click();}
 }
 ui.addEventListener('click',action,{signal:abort.signal});
 actionOrbit.addEventListener('click',action,{signal:abort.signal});
 ui.addEventListener('change',e=>{const input=e.target;if(input.matches?.('[data-showroom-palette]')){showroomPalette=input.value;return;}if(input.matches?.('[data-material-color]')){const i=item(),name=input.dataset.materialColor;if(i&&i.materialColors?.[name]!==input.value&&validFurnitureColor(input.value)&&asset(i.assetId).colorParts?.some(p=>p.material===name)){const color=input.value;commit(()=>{const target=selectedOwner().items.find(v=>v.id===selected);target.materialColors={...target.materialColors,[name]:color};});}return;}if(input.matches?.('[data-catalog-category]')){if(input.value==='all'||input.value in USE_CATEGORIES){category=input.value;renderUI();}return;}if(!input.matches?.('[data-furniture-color]')||!validFurnitureColor(input.value)||!item()||item().color===input.value)return;const color=input.value;commit(()=>{selectedOwner().items.find(i=>i.id===selected).color=color;});},{signal:abort.signal});
 function closeInteraction(){interaction=null;actionOrbit.hidden=true;actionOrbit.replaceChildren();}
 function interactionOptions(id){return furnitureInteractions(current(),catalog,id,{activities:activities(),seat:visitorSeat,held:heldPlush,active:visitorActivity||kitchenTask,fridgeOpen:kitchenEffects.isOpen(id)});}
 function openInteraction(id){
  if(interaction?.itemId===id){closeInteraction();return;}
  closeInteraction();const owner=state.rooms.find(r=>r.items.some(i=>i.id===id&&!i.stored));if(!owner)return;
  if(owner.id!==current().id){activateRoom(owner);persist();rebuild();}
  const options=interactionOptions(id);if(!options.length)return;
  panel=null;selected=null;edit=false;renderUI();
  interaction={itemId:id,page:0,options};renderInteraction();host.focus({preventScroll:true});
 }
 function positionInteraction(){
  if(!interaction||actionOrbit.hidden)return;
  const obj=objects.find(o=>o.userData.itemId===interaction.itemId);if(!obj||!isVisible(obj)){closeInteraction();return;}
  obj.updateWorldMatrix(true,true);camera.updateMatrixWorld();
  const bounds=new THREE.Box3().setFromObject(obj),point=bounds.getCenter(new THREE.Vector3()).project(camera);
  if(point.z< -1||point.z>1){closeInteraction();return;}
  let minX=Infinity,maxX=-Infinity;
  for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){
   const projected=new THREE.Vector3(x,y,z).project(camera),sx=(projected.x+1)*size.w/2;minX=Math.min(minX,sx);maxX=Math.max(maxX,sx);
  }
  const layout=interactionArcLayout({x:(point.x+1)*size.w/2,y:(1-point.y)*size.h/2,width:size.w,height:size.h,count:interaction.shown.length,modelWidth:maxX-minX});
  const scale=Math.min(1,layout.width/440);
  actionOrbit.style.setProperty('--choice-size',Math.max(44,94*scale)+'px');
  actionOrbit.style.setProperty('--choice-font',Math.max(10,12*scale)+'px');
  actionOrbit.style.setProperty('--icon-size',Math.max(19,33*scale)+'px');
  actionOrbit.style.setProperty('--heading-size',Math.max(11,16*scale)+'px');
  actionOrbit.classList.toggle('is-small',layout.width<290);
  actionOrbit.dataset.projectedWidth=String(Math.round(maxX-minX));
  actionOrbit.style.left=layout.left+'px';actionOrbit.style.top=layout.top+'px';actionOrbit.style.width=layout.width+'px';actionOrbit.style.height=layout.height+'px';
  actionOrbit.dataset.side=layout.side;
  actionOrbit.querySelectorAll('.h3-interaction-choice').forEach((button,i)=>{button.style.left=layout.points[i].x+'px';button.style.top=layout.points[i].y+'px';});
  const cy=layout.height*.77,rx=layout.width*.40,ry=layout.height*.56;
  actionOrbit.style.setProperty('--hint-y',(layout.height*.53)+'px');
  actionOrbit.classList.toggle('is-compact',size.h<500);
  actionOrbit.querySelector('.h3-interaction-arc path').setAttribute('d',`M ${layout.width/2-rx} ${cy} A ${rx} ${ry} 0 0 1 ${layout.width/2+rx} ${cy}`);
 }
 function renderInteraction(){
  if(!interaction)return;
  interaction.options=interactionOptions(interaction.itemId);const perPage=size.h<500?1:3,pages=Math.ceil(interaction.options.length/perPage);if(!pages){closeInteraction();return;}
  interaction.page%=pages;interaction.shown=interaction.options.slice(interaction.page*perPage,interaction.page*perPage+perPage);
  const i=current().items.find(i=>i.id===interaction.itemId),name=asset(i.assetId).name;
  actionOrbit.hidden=false;actionOrbit.setAttribute('role','group');actionOrbit.setAttribute('aria-label',name+'的动作');
  const isBed=interaction.options.some(a=>a.action==='chibi-bed'),isSeat=interaction.options.some(a=>a.action==='chibi-sit');
  const heading=isBed?(interaction.options.filter(a=>a.action==='chibi-bed').length>1?'想睡在哪一边？':'躺下来休息吧'):isSeat?'在这里歇一会儿':'想和它做点什么？',hint=isBed?'选个舒服的位置，躺下来吧':isSeat?'挑个座位，慢慢待着':'点一个动作，让孩子来试试';
  actionOrbit.innerHTML=`<div class="h3-interaction-glow"></div><svg class="h3-interaction-arc" aria-hidden="true"><path/></svg><button class="h3-interaction-close" data-action="interaction-close" aria-label="关闭家具动作">×</button><div class="h3-interaction-caption">${interactionIcon('jelly')}<strong>${heading}</strong><span>${hint}</span><small>${esc(name)}</small></div>${interaction.shown.map((a,j)=>`<button class="h3-interaction-choice" style="--order:${j}" data-action="${a.action}" data-id="${esc(a.id)}" ${a.seat?`data-seat="${esc(a.seat)}"`:''} ${a.kind?`data-kind="${a.kind}" data-station="${esc(a.station)}"`:''} ${a.reason?`aria-disabled="true" data-blocked="${esc(a.reason)}"`:''} title="${esc(a.reason||a.label)}" aria-label="${esc(a.label+(a.reason?'：'+a.reason:''))}">${actionIcon(a.action,a.kind)}<span>${esc(a.label)}</span>${a.reason?'<small>查看条件</small>':''}<i aria-hidden="true">✦</i></button>`).join('')}${pages>1?`<button class="h3-interaction-more" data-action="interaction-more">更多行动 · ${interaction.page+1}/${pages}</button>`:''}`;

  positionInteraction();
 }
 function coordinates(e){const rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);raycaster.setFromCamera(pointer,camera)}
 function pointerSupport(next){
  if(asset(next.assetId).surface!=='tabletop')return next;
  for(const parent of placementRoom().items){if(parent.stored)continue;for(const surface of supportSurfaces(asset(parent.assetId))){
   const height=parent.y+surface.height,point=new THREE.Vector3();
   if(!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-height),point))continue;
   const candidate=snapToSupport({...next,x:Math.round((point.x+drag.offset.x)/.05)*.05,z:Math.round((point.z+drag.offset.z)/.05)*.05},placementRoom(),catalog);
   if(candidate.supportId===parent.id&&Math.abs(candidate.y-height)<.025)return candidate;
  }}
  return snapToSupport(next,placementRoom(),catalog);
 }
 function pointerWall(next){
  const a=asset(next.assetId),candidates=[];
  for(const face of wallFaces(current(),catalog)){
   const fitted=mountOnFace(next,a,face);if(!fitted)continue;
   const normal=face.axis==='z'?new THREE.Vector3(0,0,1):new THREE.Vector3(1,0,0),p=new THREE.Vector3();
   if(!raycaster.ray.intersectPlane(new THREE.Plane(normal,-fitted[face.axis]),p))continue;
   const along=face.axis==='z'?'x':'z';if(p[along]<face.lo||p[along]>face.hi||p.y<face.bottom||p.y>face.top)continue;
   const sign=[0,270].includes(face.rotation)?1:-1;
   const proposed={...fitted,[along]:Math.round((p[along]+sign*(drag.wallGrabX??0))/STEP)*STEP,y:Math.round((p.y+(drag.wallGrabY??-a.size[1]/2))/STEP)*STEP};
   const mounted=mountOnFace(proposed,a,face);if(mounted)candidates.push({item:mounted,distance:p.distanceTo(raycaster.ray.origin)});
  }
  return candidates.sort((a,b)=>a.distance-b.distance)[0]?.item??null;
 }
 function pick(e){coordinates(e);const hits=raycaster.intersectObjects(content.children,true);for(const hit of hits){let ancestor=hit.object,visible=true;while(ancestor){if(!ancestor.visible){visible=false;break;}ancestor=ancestor.parent;}if(!visible)continue;let o=hit.object;while(o&&!o.userData.itemId&&!o.userData.roomId)o=o.parent;if(o)return o}return null}
 const activePointers=new Set();let multiGesture=false;
 controls.touches.ONE=THREE.TOUCH.ROTATE;controls.touches.TWO=THREE.TOUCH.DOLLY_PAN;controls.mouseButtons.LEFT=THREE.MOUSE.ROTATE;controls.mouseButtons.RIGHT=THREE.MOUSE.PAN;
 let lastResidentTap=null;
 function isVisible(object){for(let o=object;o;o=o.parent)if(!o.visible)return false;return true;}
 function pickResident(e){
  if(!visitor||!resident.visible||overview)return false;
  coordinates(e);resident.updateWorldMatrix(true,true);content.updateWorldMatrix(true,true);
  const actor=raycaster.intersectObjects(resident.children,true).find(h=>isVisible(h.object));if(!actor)return false;
  const obstacle=raycaster.intersectObjects(content.children,true).find(h=>isVisible(h.object));
  return !obstacle||actor.distance<=obstacle.distance+.01;
 }
 function focusResident(){
  if(!visitor||!resident.visible||overview)return;
  if(!kitchenTask)stopWalking();resident.updateWorldMatrix(true,true);
  const box=new THREE.Box3();resident.traverse(o=>{if(o.isMesh&&isVisible(o))box.union(new THREE.Box3().setFromObject(o));});if(box.isEmpty())return;
  const center=box.getCenter(new THREE.Vector3()),offset=camera.position.clone().sub(controls.target);
  controls.target.copy(center);camera.position.copy(center).add(offset);controls.update();camera.updateMatrixWorld(true);
  const projected=box.clone().applyMatrix4(camera.matrixWorldInverse).getSize(new THREE.Vector3());
  camera.zoom=THREE.MathUtils.clamp(Math.min((camera.right-camera.left)*.72/Math.max(.1,projected.x),(camera.top-camera.bottom)*.78/Math.max(.1,projected.y)),controls.minZoom,controls.maxZoom);
  residentFraming=true;camera.clearViewOffset();camera.updateProjectionMatrix();panel=null;selected=null;updateSelection();dirty=true;wake();renderUI();
 }
 function down(e){
  activePointers.add(e.pointerId);
  if(activePointers.size>1){multiGesture=true;if(drag){drag=null;rebuild()}pointerDown=null;lastResidentTap=null;controls.enableRotate=true;controls.enablePan=true;return}
  if(e.button!==0)return;const actor=pickResident(e),picked=pick(e);pointerDown={x:e.clientX,y:e.clientY,picked,actor,moved:false};if(actor)return;
  if(overview||!edit||!picked?.userData.itemId||picked.userData.itemId!==selected)return;
  controls.enableRotate=false;controls.enablePan=false;const i=item(),a=asset(i.assetId);drag={id:e.pointerId,start:clone(i),candidate:clone(i),valid:true};
  const wallTurned=a.surface==='wall'&&i.rotation%180!==0;
  const normal=a.surface==='back'||a.surface==='wall'&&!wallTurned?new THREE.Vector3(0,0,1):a.surface==='left'||wallTurned?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0);
  plane.setFromNormalAndCoplanarPoint(normal,new THREE.Vector3(i.x,i.y,i.z));raycaster.ray.intersectPlane(plane,hit);drag.offset=new THREE.Vector3(i.x,i.y,i.z).sub(hit);
  if(a.surface==='wall'){const along=wallTurned?'z':'x',sign=[0,270].includes(i.rotation)?1:-1;drag.wallGrabX=(i[along]-hit[along])*sign;drag.wallGrabY=i.y-hit.y;}
 }
 function move(e){
  if(pointerDown&&Math.hypot(e.clientX-pointerDown.x,e.clientY-pointerDown.y)>=8){pointerDown.moved=true;lastResidentTap=null;}
  if(!drag||drag.id!==e.pointerId||multiGesture)return;
  if(pointerDown&&Math.hypot(e.clientX-pointerDown.x,e.clientY-pointerDown.y)<5)return;
  coordinates(e);const a=asset(drag.start.assetId);let next={...drag.start};
  if(a.surface==='wall'){
   next=pointerWall(next);
   if(!next){drag.valid=false;message='把窗户拖到附近的高墙上';error=true;dirty=true;wake();return;}
  }else{
   if(!raycaster.ray.intersectPlane(plane,hit))return;const p=hit.clone().add(drag.offset);
   if(a.surface==='back'){next.x=Math.round(p.x/STEP)*STEP;next.y=Math.round(p.y/STEP)*STEP}
   else if(a.surface==='left'){next.z=Math.round(p.z/STEP)*STEP;next.y=Math.round(p.y/STEP)*STEP}
   else{next.x=Math.round(p.x/STEP)*STEP;next.z=Math.round(p.z/STEP)*STEP}
   next=a.building?snapBuildingToEdge(next):pointerSupport(next);
  }
  next=snapToFurniture(next,placementRoom(),catalog);const signature=JSON.stringify(next);if(signature===drag.lastCandidate)return;drag.lastCandidate=signature;
  drag.candidate=next;let why='';const preview=previewFurniture(placementRoom(),next.id,next);try{const candidate=clone(state);moveInHome(candidate,current(),next.id,next,catalog);const budgetError=phone&&phoneBudgetError(state,candidate,catalog);if(budgetError)throw Error(budgetError);}catch(e){why=e.message}
  drag.valid=!why;drag.why=why;message=a.surface==='wall'?'松手贴到这面墙':next.dockId?'松手吸附到桌子 · 桌椅会一起转向':'松手放下';error=false;
  const obj=objects.find(o=>o.userData.itemId===next.id);objectPose(obj,next);
  windowDaylight.preview(next.id,next);windowDaylight.invalidate();renderer.shadowMap.needsUpdate=true;
  for(const child of furnitureGroup(preview,next.id).filter(i=>i.id!==next.id)){const mesh=objects.find(o=>o.userData.itemId===child.id);if(mesh){objectPose(mesh,child)}}
  selection.setFromObject(obj);placementGuide(obj,!why);dirty=true;wake();
 }

 function up(e){
  if(e.type==='pointercancel')closeInteraction();
  activePointers.delete(e.pointerId);controls.enableRotate=true;controls.enablePan=true;
  if(multiGesture){if(!activePointers.size)multiGesture=false;pointerDown=null;return}
  if(drag&&drag.id===e.pointerId){const final=drag;drag=null;placementGuide(null);dirty=true;wake();selection.material.color.set('#9d80bd');
   if(e.type==='pointercancel'||!final.valid){rebuild();notify(e.type==='pointercancel'?'已取消移动':final.why||message,true)}
   else if(rotationPreview||JSON.stringify(final.start)!==JSON.stringify(final.candidate))changeItem(final.candidate);
   pointerDown=null;return;
  }
  if(e.type!=='pointercancel'&&pointerDown&&!pointerDown.moved&&Math.hypot(e.clientX-pointerDown.x,e.clientY-pointerDown.y)<8){const p=pointerDown.picked;
   if(pointerDown.actor){
    closeInteraction();
    const now=performance.now();
    if(lastResidentTap&&now-lastResidentTap.time<400&&Math.hypot(e.clientX-lastResidentTap.x,e.clientY-lastResidentTap.y)<24){lastResidentTap=null;focusResident();}
    else lastResidentTap={time:now,x:e.clientX,y:e.clientY};
    pointerDown=null;return;
   }
   lastResidentTap=null;
   if(overview&&p?.userData.roomId){stopWalking();visitorLocation=null;state.activeRoomId=p.userData.roomId;overview=false;persist();rebuild();renderUI()}
   else if(edit&&p?.userData.itemId)select(p.userData.itemId);
   else if(edit&&p?.userData.boundaryEdge){activateRoom(state.rooms.find(r=>r.id===p.userData.roomId));boundaryEdge=p.userData.boundaryEdge;selected=null;panel='building';persist();rebuild();renderUI();}
   else if(edit&&p?.userData.roomId&&p.userData.roomId!==current().id){stopWalking();visitorLocation=null;activateRoom(state.rooms.find(r=>r.id===p.userData.roomId));selected=null;persist();rebuild();renderUI();}
   else if(edit){if(rotationPreview){changeItem(rotationPreview);}else{selected=null;panel=null;updateSelection();renderUI()}}
   else if(!overview&&visitor&&p?.userData.itemId){openInteraction(p.userData.itemId);}
   else if(!overview&&interaction){closeInteraction();}
   else if(!overview&&visitor){coordinates(e);const point=raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-.18),new THREE.Vector3());if(point)walkTo([point.x+current().x*ROOM_STEP.x,point.z+current().z*ROOM_STEP.z]);}
  }if(e.type==='pointercancel')lastResidentTap=null;pointerDown=null;
 }
 for(const [name,fn] of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up]])renderer.domElement.addEventListener(name,fn,{signal:abort.signal,capture:true});
 function keydown(e){if(e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement||e.target.isContentEditable)return;if(e.key==='Escape'){closeInteraction();if(rotationPreview){cancelRotation();return;}panel=null;selected=null;updateSelection();renderUI()}if(e.key==='f'){if(document.fullscreenElement)document.exitFullscreen();else host.requestFullscreen?.()}if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();ui.querySelector('[data-action="'+(e.shiftKey||e.key.toLowerCase()==='y'?'redo':'undo')+'"]')?.click()}if(edit&&item()){const deltas={ArrowLeft:[-.2,0],ArrowRight:[.2,0],ArrowUp:[0,-.2],ArrowDown:[0,.2]};if(deltas[e.key]){e.preventDefault();const [x,z]=deltas[e.key],a=asset(item().assetId);changeItem({x:item().x+(a.surface==='left'?0:x),z:item().z+(a.surface==='back'?0:z)})}}}
 host.tabIndex=0;host.addEventListener('keydown',keydown,{signal:abort.signal});
 const observer=new ResizeObserver(()=>resize());observer.observe(stage);
 function tick(now=performance.now()){
  frame=0;if(destroyed||suspended||document.hidden)return;inTick=true;const dt=Math.min(.05,(now-lastTick)/1000);lastTick=now;
  let settling=false;if(!manual&&!document.hidden)elapsed+=dt;
  if(!document.hidden&&now-lastDraw>=frameInterval-.5){
   const applianceChanged=kitchenEffects.updateDoors(manual?0:dt,reducedMotion);if(applianceChanged){dirty=true;windowDaylight.invalidate();renderer.shadowMap.needsUpdate=true;}
   const breathing=animated.length&&!overview&&!reducedMotion&&qualities[quality].motion;
   if(breathing)for(const a of animated)a.o.position.y=a.y+Math.sin(elapsed*a.speed+a.phase)*a.amplitude;
   const acting=visitor&&resident.visible&&!edit&&(!!walking||!!kitchenTask||!reducedMotion&&(qualities[quality].motion||elapsed<visitorUntil));
   if(acting)animateVisitor(elapsed-visitorStart);
   settling=controls.update();if(dirty||breathing||acting||drag){renderScene();renderedFrames++;dirty=false;lastDraw=now}
  }
  inTick=false;if(settling||dirty||drag||kitchenEffects.moving||animated.length&&!overview&&!reducedMotion&&qualities[quality].motion||visitor&&resident.visible&&!edit&&(!!walking||!!kitchenTask||!reducedMotion&&(qualities[quality].motion||elapsed<visitorUntil)))wake();
 }
 document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0}else{dirty=true;lastTick=performance.now();wake()}},{signal:abort.signal});
 function dispose(){if(destroyed&&!kit)return;gamingEffects.clear();visitor?.dispose();visitor=null;watering.dispose();kitchenEffects.dispose();kitchenWork.dispose();bathroomEffects.dispose();finishes.dispose();windowDaylight.dispose();resident.clear();destroyed=true;abort.abort();observer.disconnect();cancelAnimationFrame(frame);controls.dispose();clearContent();for(const m of materialCache.values())m.dispose();materialCache.clear();kit?.scene.traverse(o=>{if(o.isMesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material]){for(const value of Object.values(m))if(value?.isTexture)value.dispose();m.dispose()}}});distantGeometry.dispose();for(const m of distantMaterials.values())m.dispose();distantMaterials.clear();key.shadow.dispose();grid.geometry.dispose();grid.material.dispose();footprint.geometry.dispose();footprint.material.dispose();for(const material of outlineMaterials)material.dispose();ground.geometry.dispose();ground.material.dispose();selection.geometry.dispose();selection.material.dispose();furnitureHalo.dispose();renderer.dispose();host.innerHTML='';host.classList.remove('home3d');}
 signal?.addEventListener('abort',dispose,{once:true});
 try{
  [catalog,kit]=await Promise.all([fetch(new URL('catalog.json',assetBase),{signal:abort.signal,cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('家具目录加载失败');return r.json()}),fetch(new URL('kit.glb',assetBase),{signal:abort.signal}).then(r=>{if(!r.ok)throw Error('家具模型加载失败');return r.arrayBuffer()}).then(data=>new GLTFLoader().parseAsync(data,assetBase))]);
  if(destroyed){dispose();return {dispose}}
  const doorData=await fetch(new URL('showroom-door.glb',assetBase),{signal:abort.signal}).then(r=>{if(!r.ok)throw Error('蝴蝶结门加载失败');return r.arrayBuffer()});
  ribbonDoorTemplate=(await new GLTFLoader().parseAsync(doorData,assetBase)).scene;kit.scene.add(ribbonDoorTemplate);
  const externalLoads=await Promise.allSettled(catalog.filter(a=>a.url).map(async a=>{
   const data=await fetch(new URL(a.url+(a.revision?'?v='+encodeURIComponent(a.revision):''),assetBase),{signal:abort.signal}).then(r=>{if(!r.ok)throw Error('家具模型加载失败：'+a.name);return r.arrayBuffer()});
   const loaded=await new GLTFLoader().parseAsync(data,assetBase),root=new THREE.Group();root.userData.assetId=a.id;
   const model=loaded.scene,bounds=new THREE.Box3().setFromObject(model),scale=a.size[0]/bounds.getSize(new THREE.Vector3()).x;
   model.scale.multiplyScalar(scale);bounds.setFromObject(model);const center=bounds.getCenter(new THREE.Vector3());model.position.sub(new THREE.Vector3(center.x,bounds.min.y,center.z));
   // Flat rugs have no thickness: keep their single face above the floor finish.
   if(a.surface==='rug'&&bounds.max.y-bounds.min.y<.001)model.position.y+=.026;
   root.add(model);kit.scene.add(root);
  }));
  for(const result of externalLoads)if(result.status==='rejected')throw result.reason;
  if(destroyed){dispose();return {dispose}}
  catalog.push(...BUILDING_ASSETS);for(const a of catalog)assetIndex.set(a.id,a);
  for(const root of createBuildingTemplates())kit.scene.add(root);
  for(const root of kit.scene.children)if(root.userData.assetId){const id=root.userData.assetId;templates.set(id,root);const mats=[];root.traverse(o=>{if(o.isMesh)mats.push(...(Array.isArray(o.material)?o.material:[o.material]))});const names=furniturePaintMaterials(asset(id),mats.map(m=>m.name));paintTargets.set(id,names);defaultPaintColors.set(id,"#"+(mats.find(m=>names.includes(m.name))?.color.getHexString()||"b2a2cd"));}
  let incoming=initialState;
  if(!incoming&&storageKey){const text=localStorage.getItem(storageKey);if(text)incoming=JSON.parse(text)}
  state=incoming?validateHome(incoming,catalog):createHome(catalog);if(!incoming||JSON.stringify(incoming)!==JSON.stringify(state))persist();
  host.querySelector('.h3-loading').remove();rebuild();renderUI();tick();
  // Photographs of the actual asset geometries, generated once and reused in the shelf.
  const ts=new THREE.Scene();ts.background=new THREE.Color('#f1e8ee');ts.add(new THREE.HemisphereLight('#fff7f0','#aca1b9',2.5));const tl=new THREE.DirectionalLight('#fff5e7',3);tl.position.set(3,6,4);ts.add(tl);
  const tc=new THREE.OrthographicCamera(-2,2,2,-2,.1,100);const target=new THREE.WebGLRenderTarget(128,100);const pixels=new Uint8Array(128*100*4);const canvas=document.createElement('canvas');canvas.width=128;canvas.height=100;const ctx=canvas.getContext('2d');
  for(const a of catalog.filter(a=>a.id!=='shell')){const obj=templates.get(a.id)?.clone(true);if(!obj)continue;ts.add(obj);const b=new THREE.Box3().setFromObject(obj),c=b.getCenter(new THREE.Vector3()),s=b.getSize(new THREE.Vector3());const h=Math.max(s.x,s.y,s.z)*1.3+.1;tc.left=-h*.64;tc.right=h*.64;tc.top=h/2;tc.bottom=-h/2;tc.position.copy(c).add(new THREE.Vector3(6,5,8));tc.lookAt(c);tc.updateProjectionMatrix();renderer.setRenderTarget(target);renderer.render(ts,tc);renderer.readRenderTargetPixels(target,0,0,128,100,pixels);const image=ctx.createImageData(128,100);for(let y=0;y<100;y++)image.data.set(pixels.subarray((99-y)*512,(100-y)*512),y*512);ctx.putImageData(image,0,0);thumbs.set(a.id,canvas.toDataURL());ts.remove(obj)}
  renderer.setRenderTarget(null);target.dispose();dirty=true;wake();renderUI();
 }catch(e){if(destroyed)return {dispose};dispose();host.innerHTML=`<div class="h3-loading"><span>${esc(e.message)}</span><button>重新加载</button></div>`;host.querySelector('button').onclick=()=>location.reload();throw e}
 return {dispose,setSuspended(value){suspended=value;if(value){cancelAnimationFrame(frame);frame=0;}else{dirty=true;lastTick=performance.now();wake();}},setVisitor,getState:()=>clone(state),inspect:()=>({ready:true,furnitureStyle,furnitureOutlineEnabled,furnitureOutline:furnitureHalo.inspect(),kitchen:kitchenEffects.inspect(),windowDaylight:windowDaylight.inspect(),lighting:{shadows:renderer.shadowMap.enabled,shadowSize:key.shadow.mapSize.x,ambient:hemi.intensity,key:key.intensity,fill:fill.intensity},phoneBudget:phone?PHONE_BUDGET:null,furnitureCounts:Object.fromEntries(furnishingCounts(state,catalog)),wallView,roomScope,visibleRoomIds:[...visibleRoomIds],roomGroups:roomGroups(state,catalog).map(rs=>rs.map(r=>r.id)),walking:!!walking,headWidth,visitorLocation,doorStates:doors.map(d=>({kind:d.userData.doorKind,rotation:d.userData.doorLeaf.rotation.y,x:d.userData.doorLeaf.position.x})),rotationPreview:rotationPreview?{...rotationPreview}:null,interaction:interaction?{itemId:interaction.itemId,page:interaction.page,actions:interaction.options.map(a=>({label:a.label,action:a.action,reason:a.reason}))}:null,chibiVisible:resident.visible,chibiMotion:visitorMotion,chibiPosture:visitorActivity?.posture||(visitorSeat?.bed?'lying':visitorSeat?'seated':'standing'),chibiSeat:visitorSeat,chibiHeldPlush:heldPlush,chibiWatering:visitorPlant,chibiActivity:visitorActivity,kitchenTask:kitchenTask?{kind:kitchenTask.kind,stage:kitchenTask.stage,carrying:!!kitchenTask.carrying,itemId:kitchenTask.itemId,sinkId:kitchenTask.sink?.id}:null,kitchenPropsVisible:kitchenWork.root.visible,wateringVisible:watering.root.visible,chibiRotation:resident.rotation.y,chibiPosition:resident.position.toArray(),outlineVisible:!!outlineGroup,gridVisible:grid.visible,footprintVisible:footprint.visible,placementValid:drag?.valid??null,quality,pixelRatio:renderer.getPixelRatio(),cameraPosition:camera.position.toArray(),cameraTarget:controls.target.toArray(),zoom:camera.zoom,undoCount:undo.length,redoCount:redo.length,orbitMode,overview,edit,selected,rooms:state.rooms,activeRoomId:state.activeRoomId,panel,message,saved,assets:catalog.map(a=>a.id),drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,materials:materialCache.size,finishMaterials:finishes.count,renderedFrames,frameCap:1000/frameInterval,detailRooms:detailedRoomIds.size}),advanceTime:ms=>{manual=true;elapsed+=ms/1000;if(kitchenEffects.updateDoors(ms/1000,reducedMotion)){windowDaylight.invalidate();renderer.shadowMap.needsUpdate=true;}if(visitor&&resident.visible&&!edit)animateVisitor(reducedMotion?1:elapsed-visitorStart);for(const a of animated)a.o.position.y=a.y+Math.sin(elapsed*a.speed+a.phase)*a.amplitude;renderScene()},select,projectPoint:position=>{const p=new THREE.Vector3(...position).project(camera);return {x:(p.x+1)*size.w/2,y:(1-p.y)*size.h/2}},projectItem:id=>{const o=objects.find(o=>o.userData.itemId===id);if(!o)return null;const p=new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).project(camera);return {x:(p.x+1)*size.w/2,y:(1-p.y)*size.h/2}}};
}
