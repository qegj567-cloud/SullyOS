import {trackHomeFeature,trackHomeTransfer} from '../../utils/homeAnalytics';
import {createAssetQueue} from './assetQueue.js';
import {loadHomeGLTF} from './resourcePackGLTF';
import {hydratePackImages,resourcePacks,resourcePackStatus,subscribeResourcePacks} from './resourcePacks';
import './resourcePacks.css';
import {nowInTimeZone} from '../../utils/timezone';
import {createPhotoSession} from './photoSession.js';
import {paintPhoto} from './photoEffects';
import {createPhotoRenderer} from './photoRenderer';
import {diningGrip} from './diningGrip.js';
import {isSustainedFurnitureActivity,furnitureActivitySeconds} from './furnitureActivityLifetime';
import {conversationHeading,conversationHead} from './conversationFacing';
import {petIcon} from './petPanel.js';
import {socialWheelLayout} from './socialWheelLayout';
import './socialWheel.css';
import './petWheel.css';
import {withResidents,residentBlocksStep,planResidentWalk,residentDestinationFree} from './residentNavigation.js';
import {petHomeRecord} from '../../utils/homePetRecords';
import {homeDisposalReason} from '../../utils/homeAssetCancellation';
import {socialPostureAllowed,SEATED_TARGET_ACTIONS} from './socialPosture';
import {BED_LEISURE,isBedLeisure} from './chibi/bedLeisure';
import {createSocialProp} from './chibi/socialProps';
import {isDevDebugAvailable} from '../../utils/devDebug';

import {mountPetSystem} from './petSystem.js';
import {automaticWallVisible} from './automaticWalls.js';
import {createInteriorBackdrop} from './interiorBackdrop.js';
import {furnitureSearch} from './furnitureSearch';
import {setResidentHeading} from './residentFacing';
import {loadSelectedMotion,sampleSelected} from './chibi/selectedMotions';
import {createStarterHome,defaultRoomLayout,hasDefaultRoomLayout} from './starterHome.js';
import {furnishingSpaceError} from './furnishingSpace.js';
import {homeMap,homeDisplayX} from './homeMap.js';
import {createSocialScene,socialActions} from './chibi/social';
import {homeSocialActionAllowed,hasRomanticPair,updateRomanticPair} from './homeRomance';
import {createGuestLife} from './guestLife.js';
import {setCharacterRoomTint,setCharacterRoomLighting} from './chibi/illustration';
import {getCharacterStyle,setCharacterStyle,subscribeCharacterStyle} from './chibi/characterStyle';
import {comparisonSpot,visitorFootprintWidth} from './visitorComparison.js';
import {bathroomActivities,isBathAction} from './bathroom.js';
import {bathroomEntryCandidates,createBathroomJourney,bathroomJourneyFrame} from './bathroomJourney.js';
import {createBathroomEffects} from './bathroomEffects.js';
import {interactionIcon,actionIcon} from './interactionIcons.js';
import {roomPixelRatio,roomLightBudget} from './renderQuality.js';
import {fitFlatView} from './flatView.js';
import {homelyTouchPose,homelyTouchText} from './homelyTouch';
import {homelyFrame} from './homelyView';
import {homelyMusicPose} from './homelyPresence';
import {createHomelyForeground} from './homelyForeground.js';
import {furnitureInteractions,interactionArcLayout} from './furnitureInteractions.js';
import {mirrorActivities,isMirrorAction} from './mirror.js';
import {createMirrorJourney,mirrorJourneyFrame} from './mirrorJourney.js';
import {SHOWROOMS,addShowroom,applyShowroomStyle} from './showrooms.js';
import {addActivityRoom} from './activityRooms.js';
import {ROOM_PALETTES,applyRoomPalette,hasFixedRoomPalette} from './roomPalettes.js';
import {exportRoomLayout,parseRoomLayout,applyRoomLayout} from './roomSharing.js';
import {ROOM_CATEGORIES,USE_CATEGORIES,matchesFurniture,furnitureActions} from './furnitureCatalog.js';
import {createFurnitureHalo} from './furnitureHalo.js';
import {applyRetroFurniture} from './furnitureStyle.js';
import {applyRugPattern} from './rugPattern.js';
import {furniturePaintMaterials,validFurnitureColor,applyFurnitureColorPreset,setFurniturePrimaryColor,resetFurnitureColors} from './furniturePaint.js';
import {paintPanel} from './paintPanel.js';
import {roomPlush,plushPose,body2PlushPose} from './plush.js';
import {furnitureGroup,isDockChair} from './furnitureDock.js';
import {FLOOR_STYLES,WALL_STYLES} from './finishes.js';
import {createRoomFinishes} from './finishMeshes.js';
import {windowDaylightSources} from './windowDaylight.js';
import {windowOpenings,subtractOpenings} from './windowOpenings.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {createWindowDaylight} from './windowDaylightLights.js';
import {applyWindowSky} from './windowSky.js';
import {inferWindowAperture,isWindowPane,windowSunPose} from './windowAperture.js';
import {createRoomFinishPass} from './roomFinishPass.js';
import {ROOM_LIGHT_PHASES,resolveRoomLightPhase,createRoomLightUniforms,updateRoomLightUniforms} from './roomLighting.js';
import {isPhoneBrowser,PHONE_BUDGET,furnishingCounts,phoneBudgetError} from './deviceBudget.js';
import {ROOM_HALF,ROOM_SCALE,MAX_BUILDING_LENGTH} from './dimensions.js';
import {gamingActivities,placeGamingPreset,GAMING_ACTIONS} from './gaming.js';
import {diningActivities,placeDiningPreset,fridgeOpenError} from './dining.js';
import {createKitchenEffects} from './kitchenEffects.js';
import {kitchenActions,planKitchenAction,kitchenFingerprint,kitchenHands} from './kitchenActivities.js';
import {createKitchenWorkEffects} from './kitchenWorkEffects.js';
import {coffeeGrip} from './coffeeGrip.js';
import {createGamingEffects} from './gamingEffects.js';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {previewFurniture} from './model.js';
import {roomSeats,roomBeds,seatTransform} from './seating.js';
import {wallFaces,mountOnFace,wallPlacementError} from './wallMount.js';
import {wateringSpot,roomPlants} from './watering.js';
import {createWateringEffect} from './wateringEffect.js';
import {seatEntry,seatChangePose} from './seatChange.js';
import {body2BedTransform,bedFootSurface,bedEntry,bedEdge} from './bedMotion.js';
import {seatChangeDuration} from './chibi/roomMotionFrame.ts';
import {meshyMotions} from './chibi/meshyMotions';
import {BUILDING_ASSETS,BUILDING_LENGTH,buildingScale,ROOM_EDGES,buildingEdge,placeBuildingOnEdge,snapBuildingToEdge} from './building.js';
import {createBuildingTemplates} from './buildingMeshes.js';
import {ROOM_STEP,OPPOSITE,EDGE_NAMES,WALL_VIEWS,DOOR_KINDS,boundary,neighbor,roomOffset,roomBoundarySegments,connectedRooms,roomGroups,displayRooms,wallVisible,setBoundary} from './topology.js';
import {layoutRoom,moveInHome,layoutError} from './layout.js';
import {walkingMap,findWalkPath,doorTarget} from './navigation.js';
import {createWalkFeedback} from './walkFeedback.js';
import {createLampGlow} from './lampGlow.js';
import {createDoor} from './doorMeshes.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {createHome,validateHome,addRoom,findPlace,placementError,clone,PALETTE,STEP,snapToSupport,snapToFurniture,supportSurfaces,moveFurniture} from './model.js';
import {homeRecords as readHomeRecords,makeHomeRecord} from '../../utils/homeRecords';
import {assignHomeTurns} from '../../utils/homeTurns';
import {stampHomeSceneRecords} from '../../utils/homeSharedEvents';

const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=new Set(['lavender','purple','pink','blush','peri','rug']);
export async function mountHomeEditor(host,{assetBase,initialState,onChange,onBack,onMenu,storageKey,signal,timeZone,thumbnailExport,firstPerson=false}={}){
 const knownHomeRecords=new Map(readHomeRecords(initialState).map(record=>[record.id,record]));
 host.classList.add('home3d');host.innerHTML='<div class="h3-stage"></div><div class="h3-ui"></div><div class="h3-loading">正在把家具搬进来…</div>';
 let petSystem=null;
 let homelyChatOpen=true;
 let homelyForeground=null;
 let homelyAttention=null,homelyMusic={playing:false,position:0,at:0,weight:0,last:0};
 let suspended=false;
 let destroyed=false,state,catalog,kit,selected=null,panel=null,overview=false,edit=false,message='',error=false,undo=[],redo=[],saved=true;
 let sharedRoomText='',roomImportDraft=null;
 let rotationPreview=null,roomScope='floor',interaction=null;
 try{if(localStorage.getItem('sully-home3d-room-scope')==='room')roomScope='room';}catch{}
 let wallView='cutaway',boundaryEdge='back',visibleRoomIds=new Set(),detailedRoomIds=new Set(),doors=[],walking=null,visitorLocation=null;
 try{const v=localStorage.getItem('sully-home3d-wall-view');if(!onMenu&&WALL_VIEWS[v])wallView=v;}catch{}
 let objects=[],animated=[],elapsed=0,manual=false,frame=0,drag=null,pointerDown=null,lastTick=performance.now(),lastDraw=0,dirty=true;
 const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
 const touch=matchMedia('(pointer:coarse)').matches;
 const phone=isPhoneBrowser({userAgent:navigator.userAgent,mobile:navigator.userAgentData?.mobile,coarse:touch,width:screen.width,height:screen.height});
 const qualities={eco:{label:'省电',ratio:.75,fps:30,shadows:false,motion:false,details:1},balanced:{label:'均衡',ratio:1,fps:30,shadows:true,motion:true,details:2},clear:{label:'清晰',ratio:1.5,fps:touch||phone?30:60,shadows:true,motion:true,details:touch?2:4}};
 let viewMode='free';try{if(!onMenu&&localStorage.getItem('sully-home3d-view-mode')==='flat')viewMode='flat';}catch{}
 let showroomPalette='';
 let faceTimer=0;const residentExpressions=new Map();
 let lightMode='auto',lightPhase=null,lightTimer=0,finishEnabled=true;
 try{finishEnabled=localStorage.getItem('sully-home3d-light-finish')!=='off'}catch{}
 try{const mode=localStorage.getItem('sully-home3d-light-mode');if(mode==='auto'||Object.hasOwn(ROOM_LIGHT_PHASES,mode))lightMode=mode;}catch{}
 const lightUniforms=createRoomLightUniforms();
 let quality='clear';try{const saved=localStorage.getItem('sully-home3d-quality');if(qualities[saved])quality=saved}catch{}
 let detailBudget=qualities[quality].details,frameInterval=1000/qualities[quality].fps,orbitMode=false,inTick=false;
 function wake(){if(!destroyed&&!suspended&&!document.hidden&&!frame&&!inTick&&state)frame=requestAnimationFrame(tick)}
 const materialCache=new Map(),usedMaterials=new Set(),paintTargets=new Map(),defaultPaintColors=new Map();
 let furnitureOutlineEnabled=true;try{furnitureOutlineEnabled=localStorage.getItem('sully-home3d-furniture-outline')!=='off';}catch{}
 let furnitureStyle='retro';try{if(localStorage.getItem('sully-home3d-furniture-style')==='original')furnitureStyle='original';}catch{}
 let renderedFrames=0,category='all',catalogMode='room',furnitureQuery='';
 const stage=host.querySelector('.h3-stage'),ui=host.querySelector('.h3-ui');
 const abort=new AbortController();
 const actionOrbit=document.createElement('div');actionOrbit.className='h3-interaction';actionOrbit.hidden=true;host.append(actionOrbit);
 const portraitRail=document.createElement('nav');portraitRail.className='h3-resident-rail';portraitRail.setAttribute('aria-label','定位房间成员');host.append(portraitRail);
 let residentPortraits={},cameraResident=null,portraitSignature='',scheduleLabel='';
 portraitRail.addEventListener('click',event=>{const pet=event.target.closest('button[data-home-pets]');if(pet){petSystem?.open(pet.dataset.homePets||undefined);return;}const call=event.target.closest('button[data-summon-all]');if(call){summonAll();return;}const button=event.target.closest('button[data-resident]');if(button){centerResident(button.dataset.resident);if(button.dataset.resident===primaryResidentId)onMenu?.('mood',primaryResidentId);}},{signal:abort.signal});
 portraitRail.addEventListener('error',event=>{if(event.target.tagName==='IMG')event.target.hidden=true;},true);
 const scene=new THREE.Scene();scene.background=new THREE.Color('#e8dde7');const windowDaylight=createWindowDaylight(scene);
 const interiorBackdrop=createInteriorBackdrop();scene.add(interiorBackdrop.root);let interiorBases=[];
 const walkFeedback=createWalkFeedback({reducedMotion});scene.add(walkFeedback.root);
 const lampGlow=createLampGlow();scene.add(lampGlow.root);
 let renderer;
 try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:firstPerson,powerPreference:'high-performance'});}catch(e){host.querySelector('.h3-loading').textContent='这台设备暂时无法打开 3D 小屋，请返回选择页。';throw e}
 renderer.setPixelRatio(roomPixelRatio(quality,devicePixelRatio,touch||phone));renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.shadowMap.autoUpdate=false;stage.append(renderer.domElement);
 let photoSession=null,photoPendingRoom=null,photoRenderer=null;const photoListeners=new Set();
 const camera=new THREE.OrthographicCamera(-5,5,5,-5,.1,200);camera.position.set(9,10,12);
 const furnitureHalo=createFurnitureHalo(renderer,scene,camera),roomFinish=createRoomFinishPass(renderer);
 let outlinedObjects=[];
 const lightBudget=()=>roomLightBudget(quality,touch||phone,overview);
 function invalidateRoomShadows(){key.shadow.needsUpdate=true;windowDaylight.invalidate();renderer.shadowMap.needsUpdate=true;}
 const residentLightPhases=new WeakMap();
 function syncResidentLight(v){if(v&&residentLightPhases.get(v.root)!==lightPhase){setCharacterRoomLighting(v.root,lightUniforms);setCharacterRoomTint(v.root,ROOM_LIGHT_PHASES[lightPhase].character);residentLightPhases.set(v.root,lightPhase);}}
 function updateResidentFaces(){
  clearTimeout(faceTimer);faceTimer=0;
  const animateEyes=!edit&&!overview&&!reducedMotion,clock=manual?elapsed:performance.now()/1000;
  let delay=Infinity;
  const apply=(v,id,visible)=>{if(!v||!visible)return;const settings=residentExpressions.get(id)||{};const result=v.updateExpression?.(clock,{...settings,speaking:animateEyes&&((userSpeech?.person===v&&elapsed<userSpeech.until)||(conversation?.person===v&&Number.isFinite(conversation.until)&&elapsed<conversation.until)),...(!animateEyes?{blink:false}:{})});if(result)delay=Math.min(delay,result.nextIn);};
  apply(visitor,activeResidentId(),resident.visible);
  for(const e of socialEntries)apply(e.visitor,e.id,e.group.visible);
  for(const e of comparisonEntries)if(e.visitor!==visitor)apply(e.visitor,e.id,e.group.visible);
  if(!manual&&!destroyed&&!suspended&&!document.hidden&&Number.isFinite(delay))faceTimer=setTimeout(()=>{faceTimer=0;dirty=true;wake();},Math.ceil(delay*1000));
 }
 function setResidentExpression(id,settings){if(!id)return;residentExpressions.set(id,{eyes:['closed','happy'].includes(settings.eyes)?settings.eyes:'auto',blink:settings.blink!==false});dirty=true;wake();}
 function renderScene(){updateHomelyAttention();if(firstPerson&&!photoSession){syncHomelyCamera();faceHomelyCamera();}const restorePresence=applyHomelyPresence(),restorePoke=applyHomelyPoke();if(interaction?.petId)positionInteraction();syncPortraitRail();syncAutomaticWalls();syncInteriorPresentation();lampGlow.update(finishEnabled&&lightPhase==='night'&&!overview,renderer.domElement.height);walkFeedback.update(elapsed,[current().x*ROOM_STEP.x,current().z*ROOM_STEP.z],!edit&&!overview,Math.max(1,28*(camera.right-camera.left)/(camera.zoom*size.w*.69)));syncResidentLight(visitor);for(const e of comparisonEntries)syncResidentLight(e.visitor);for(const e of socialEntries)syncResidentLight(e.visitor);if(!photoSession){placeComparisonVisitors();placeSocialVisitors();updateResidentFaces();}bathroomEffects.update(objects,!edit&&!overview?visitorActivity:null,elapsed-visitorStart,reducedMotion);const reset=renderer.info.autoReset;renderer.info.autoReset=false;renderer.info.reset();let restoreForeground;try{if(firstPerson){if(homelyAttention?.close&&!photoSession){homelyForeground??=createHomelyForeground({renderer,scene,camera,resident,container:host.parentElement,stage});restoreForeground=homelyForeground.capture(homelyAttention.close,visitor?.getHeadWorldPosition?.());}else homelyForeground?.hide();}if(furnitureStyle==='retro'&&furnitureOutlineEnabled&&lightBudget().outline){furnitureHalo.render(outlinedObjects);}else renderer.render(scene,camera);if(finishEnabled)roomFinish.render(lightPhase);}finally{restoreForeground?.();restorePoke?.();restorePresence?.();renderer.info.autoReset=reset;}}
 const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.enablePan=true;controls.screenSpacePanning=true;controls.target.set(0,2,0);
 const effectiveRoomScope=()=>onMenu||viewMode==='flat'?'room':roomScope;
 const displayOffset=(r,anchor)=>overview?[(homeDisplayX(state,r)-homeDisplayX(state,anchor))*ROOM_STEP.x,(r.z-anchor.z)*ROOM_STEP.z]:roomOffset(r,anchor);
 const effectiveWallView=()=>firstPerson?'auto':overview?'dollhouse':wallView==='cutaway'?(!edit?'auto':'flat'):wallView;
 function syncCameraControls(){if(firstPerson){controls.enabled=false;controls.enableRotate=false;controls.enablePan=false;controls.enableZoom=false;return;}controls.enabled=true;controls.enableRotate=viewMode==='free';controls.enablePan=true;controls.enableZoom=true;controls.touches.ONE=viewMode==='free'?THREE.TOUCH.ROTATE:THREE.TOUCH.PAN;controls.mouseButtons.LEFT=viewMode==='free'?THREE.MOUSE.ROTATE:THREE.MOUSE.PAN;}
 syncCameraControls();
 let residentFraming=false,roomWide=!!onMenu&&!firstPerson;
 controls.addEventListener('start',()=>{cameraArrival=null;residentFraming=false});
 controls.addEventListener('change',()=>{dirty=true;wake();positionInteraction()});
 // Let the view descend to almost eye level, including when focused on a
 // short resident, instead of stopping at the old steep room overview.
 controls.minPolarAngle=.5;controls.maxPolarAngle=Math.PI/2-.015;controls.minZoom=.6;controls.maxZoom=10;
 // Warm daylight from the open side, with a restrained cool frontal fill.
 // Keep the resident's no-self-shadow treatment; shape comes from light direction.
 const hemi=new THREE.HemisphereLight('#d5e7ff','#9a87ad',.95);scene.add(hemi);
 const key=new THREE.DirectionalLight('#fff1d5',1.7);key.position.set(-3.8,9.5,7);key.target.position.set(0,.7,0);scene.add(key.target);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.radius=2;key.shadow.autoUpdate=false;key.shadow.normalBias=.012;key.shadow.bias=-.00008;
 // The old shadow camera still fitted the smaller room; cover the enlarged
 // active tile without expanding the map over every neighboring room.
 Object.assign(key.shadow.camera,{left:-7.6,right:7.6,top:7.6,bottom:-7.6,near:.5,far:30});scene.add(key);
 const fill=new THREE.DirectionalLight('#b8d8ff',.35);fill.position.set(6,5,3);scene.add(fill);
 function configureWindowSun(){
  const source=windowDaylight.primary(),p=ROOM_LIGHT_PHASES[lightPhase],sun=!!source&&!!p.directSun&&!overview;
  windowDaylight.setDirectSun(sun);lightUniforms.roomSunContrast.value=sun?(p.sunContrast??1):0;
  if(sun){const pose=windowSunPose(source,lightPhase);key.position.fromArray(pose.position);key.target.position.fromArray(pose.target);key.intensity=p.sunPower;key.color.set(p.window);}
  else{key.position.set(-3.8,9.5,7);key.target.position.set(0,.7,0);key.intensity=p.keyPower;key.color.set(p.key);}
  key.castShadow=sun||lightBudget().keyShadow&&!source;renderer.shadowMap.enabled=key.castShadow||!!source;invalidateRoomShadows();
 }
 function refreshRoomLighting(force=false){
  const next=resolveRoomLightPhase(lightMode,timeZone);if(!force&&next===lightPhase)return false;
  lightPhase=next;const p=ROOM_LIGHT_PHASES[next];updateRoomLightUniforms(lightUniforms,p);
  hemi.color.set(p.sky);hemi.groundColor.set(p.ground);hemi.intensity=p.ambient;
  key.color.set(p.key);key.intensity=p.keyPower;fill.color.set(p.fill);fill.intensity=p.fillPower;
  scene.background.set(p.background);if(onMenu)scene.background.set('#f8f8f0');windowDaylight.setLighting(p.window,p.windowPower);configureWindowSun();
  dirty=true;wake();return true;
 }
 function scheduleRoomLighting(){
  clearTimeout(lightTimer);lightTimer=0;
  if(destroyed||suspended||document.hidden||lightMode!=='auto')return;
  lightTimer=setTimeout(()=>{if(refreshRoomLighting())renderUI();scheduleRoomLighting();},60000);
 }
 function setLightingMode(mode){
  if(mode!=='auto'&&!Object.hasOwn(ROOM_LIGHT_PHASES,mode))return;
  lightMode=mode;try{localStorage.setItem('sully-home3d-light-mode',mode)}catch{}
  refreshRoomLighting();scheduleRoomLighting();renderUI();
 }
 refreshRoomLighting();
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(160,160),new THREE.ShadowMaterial({color:'#8b779b',opacity:.12}));ground.rotation.x=-Math.PI/2;ground.position.y=-.47;ground.receiveShadow=true;scene.add(ground);
 const content=new THREE.Group();scene.add(content);const finishes=createRoomFinishes();
 const resident=new THREE.Group();resident.rotation.order='YXZ';scene.add(resident);
 const comparisonRoot=new THREE.Group();scene.add(comparisonRoot);let comparisonEntries=[],activeComparisonId=null,comparisonRevision=0;
 const plushRoot=new THREE.Group();plushRoot.name='held-plush';resident.add(plushRoot);
 let heldPlush=null,heldMesh=null;
 function putPlushBack(){
  for(const o of objects)if(o.userData.itemId===heldPlush?.itemId)o.visible=true;
  plushRoot.clear();heldMesh=null;heldPlush=null;if(visitorMotion==='hug')visitorMotion='idle';invalidateRoomShadows();
 }
 function syncPlush(){
  if(!heldPlush)return;
  const i=current().items.find(i=>i.id===heldPlush.itemId&&!i.stored),a=i&&asset(i.assetId);
  if(heldPlush.roomId!==current().id||!a?.holdable||visitorMotion!=='hug'||visitorSeat?.bed){putPlushBack();return;}
  plushRoot.clear();heldMesh=instance(i.assetId,i.color,false,i.materialColors);heldMesh.traverse(o=>{if(o.isMesh)o.castShadow=false;});plushRoot.add(heldMesh);
  objects.find(o=>o.userData.itemId===i.id)?.traverse(o=>{if(o.userData.itemId===i.id)o.visible=false;});
  const pose=plushPose(a);heldMesh.scale.setScalar(pose.scale);heldMesh.position.fromArray(pose.position);
 }
 let socialEntries=[],socialRuntime=null,socialRoom=null,socialLast=0,primaryResidentId='resident';
 let parkedMealEffects=null;
 let furnitureUser=null,manualControl='user',mapCollapsed=false,seatedReaction=null,reactionGeneration=0;
 const activeResidentId=()=>furnitureUser?'user':primaryResidentId;
 function resetFurnitureMotion(){stopWalking();putPlushBack();visitorSeat=null;visitorPlant=null;visitorActivity=null;seatChange=null;visitorMotion='idle';visitorUntil=0;visitorLocation=null;gamingEffects.clear();bathroomEffects.clear();kitchenEffects.updateMeal(null,0);visitor?.animate(0,'idle');}
 function exchangeFurnitureVisitor(entry){
  socialPlacementMap=null;
  const next=entry.visitor,old=visitor,position=resident.position.clone(),rotation=resident.quaternion.clone(),visible=resident.visible;
  resident.add(next.root);entry.group.add(old.root);visitor=next;entry.visitor=old;
  resident.position.copy(entry.group.position);resident.quaternion.copy(entry.group.quaternion);resident.visible=entry.group.visible;
  entry.group.position.copy(position);entry.group.quaternion.copy(rotation);entry.group.visible=visible;
  entry.width=visitorFootprintWidth(old);headWidth=visitorFootprintWidth(next);
  for(const task of [companionTravel,companionIdle,companionGesture,companionRise])if(task?.person){if(task.person.visitor===old)task.person.group=entry.group;else if(task.person.visitor===next)task.person.group=resident;}
  if(companionFacing)companionFacing.root=companionFacing.root===resident?entry.group:resident;
 }
 function snapshotFurniture(){return {parkedSeat:visitorSeat,parkedPose:currentSeatPose(),parkedActivity:{activity:visitorActivity,motion:visitorMotion,start:visitorStart,until:visitorUntil}};}
 function resumeFurniture(snapshot){visitorSeat=snapshot?.parkedSeat||null;const p=snapshot?.parkedActivity;visitorActivity=p?.activity||null;visitorMotion=p?.motion||'idle';visitorStart=p?.start??elapsed;visitorUntil=p?.until||0;if(visitorSeat)visitor.animate(elapsed-visitorStart,visitorMotion,visitorSeat.bed?'lying':'seated',currentSeatPose());}
 function restoreFurnitureCharacter(){
  petSystem?.contact.cancel();
  if(!furnitureUser)return;parkedMealEffects?.dispose();parkedMealEffects=null;
  const outgoing=snapshotFurniture(),entry=furnitureUser,incoming={...entry};resetFurnitureMotion();exchangeFurnitureVisitor(entry);entry.id='user';furnitureUser=null;resumeFurniture(incoming);Object.assign(entry,outgoing);
  visitorLocation={x:resident.position.x+current().x*ROOM_STEP.x,z:resident.position.z+current().z*ROOM_STEP.z,level:current().level};dirty=true;wake();
 }
 function setManualResident(id){
  if(id!=='user'&&id!==primaryResidentId)return false;
  if(manualControl===id){renderUI();return true;}
  if(id===primaryResidentId){cancelCompanionAction();manualRevision++;}restoreFurnitureCharacter();manualControl=id;
  const ready=id==='user'||useFurnitureUser();
  renderUI();if(ready)notify(id==='user'?'已切回你的小人':'正在操控'+ownerName+' · 家具和移动将由对方执行');return ready;
 }
 function useFurnitureUser(){
  if(!onMenu||manualControl===primaryResidentId||furnitureUser)return true;
  const entry=socialEntries.find(e=>e.id==='user');
  if(!entry?.visitor||!entry.group.visible){notify('先在成员中邀请你的小人，等形象准备好再使用家具',true);return false;}
  const outgoing=snapshotFurniture(),incoming={...entry};resetFurnitureMotion();if(outgoing.parkedSeat)visitor.animate(0,outgoing.parkedActivity.motion,outgoing.parkedSeat.bed?'lying':'seated',outgoing.parkedPose);exchangeFurnitureVisitor(entry);entry.id=primaryResidentId;furnitureUser=entry;resumeFurniture(incoming);Object.assign(entry,outgoing);
  visitorLocation={x:resident.position.x+current().x*ROOM_STEP.x,z:resident.position.z+current().z*ROOM_STEP.z,level:current().level};dirty=true;wake();return true;
 }
 function stopSocial(){reactionGeneration++;seatedReaction=null;if(socialRuntime){socialRuntime.cancel();socialRuntime=null;for(const e of socialEntries)e.settledRoom=current().id;visitorLocation={x:resident.position.x+current().x*ROOM_STEP.x,z:resident.position.z+current().z*ROOM_STEP.z,level:current().level};dirty=true;}socialRoom=null;}
 function removeSocialResident(id){guestLife.cancel(id);restoreFurnitureCharacter();stopSocial();const entry=socialEntries.find(e=>e.id===id);if(entry){entry.visitor.dispose();entry.group.removeFromParent();socialEntries=socialEntries.filter(e=>e!==entry);}dirty=true;wake();}
 function setSocialResident(id,next,label=id){
  if(firstPerson){next.dispose();return;}
  restoreFurnitureCharacter();
  if(id===primaryResidentId)throw Error('居民 ID 重复');
  if(visitor&&!!next.rig!==!!visitor.rig){next.dispose();throw Error('所有居民需要使用同一种素体');}
  removeSocialResident(id);const group=new THREE.Group();group.rotation.order='YXZ';group.add(next.root);scene.add(group);socialEntries.push({id,label,visitor:next,group,width:visitorFootprintWidth(next)});placeSocialVisitors();dirty=true;wake();
 }
 let socialPlacementMap=null;
 function placeSocialVisitors(){
  if(!state||!visitor||!socialEntries.length)return;
  if(socialRuntime?.active)return;
  const r=current(),key=r.id+':'+headWidth;if(!socialPlacementMap||socialPlacementMap.key!==key)socialPlacementMap={key,map:walkingMap(state,r.level,catalog,{headWidth,...visitor?.navigation})};const map=socialPlacementMap.map,reserved=[];
  for(const e of socialEntries){
   if(e===furnitureUser){e.group.visible=!overview&&!edit&&(residentRoom===undefined||residentRoom===r.id);continue;}
   // Placement is for entering a room, not a per-frame collision response.
   if(e.settledRoom===r.id){e.group.visible=!overview&&!edit&&(e.id==='user'||resident.visible);reserved.push(e.group.position.toArray());continue;}
   e.settledRoom=null;guestLife.cancel(e.id);e.parkedSeat=null;e.parkedPose=null;
   const spot=comparisonSpot(map,{offset:[r.x*ROOM_STEP.x,r.z*ROOM_STEP.z],width:e.width,activeWidth:headWidth,active:resident.position.toArray(),preferred:e.room===r.id?e.group.position.toArray():null,reserved});
   e.group.visible=!!spot&&!overview&&!edit&&(e.id==='user'||resident.visible);e.room=r.id;if(spot){e.group.position.fromArray(spot);e.settledRoom=r.id;reserved.push(spot);}
  }
 }
 function getResidentPosture(id){const seat=id===activeResidentId()?visitorSeat:socialEntries.find(e=>e.id===id)?.parkedSeat;return id===activeResidentId()&&seatChange?'transition':seat?(seat.bed?'lying':'seated'):'standing';}
 function setResidentBedMode(id,mode){
  if(getResidentPosture(id)!=='lying'||(mode!=='sleep'&&!isBedLeisure(mode)))return false;
  if(id==='user'){if(!useFurnitureUser())return false;}else if(id===primaryResidentId)restoreFurnitureCharacter();else return false;
  if(!visitor?.rig||!visitorSeat?.bed||seatChange)return false;
  runAction({action:'chibi-bed-mode',value:mode});return true;
 }
 function standResident(id){
  if(getResidentPosture(id)==='standing'||getResidentPosture(id)==='transition')return false;
  if(id===primaryResidentId)restoreFurnitureCharacter();else if(id==='user'){manualControl='user';if(!useFurnitureUser())return false;}
  runAction({action:'chibi-stand'});return true;
 }
 function canPlaySocial(action,a,b){return homeSocialActionAllowed(state,action,a,b);}
 function romanticPartners(id){return getPresentResidents().filter(p=>hasRomanticPair(state,id,p.id));}
 function setRomanticRelation(a,b,enabled){const pairs=updateRomanticPair(state,a,b,enabled);stopSocial();photoSession?.cancelInteraction();homeActionPlan=null;state.romanticPairs=pairs;persist();dirty=true;wake();}
 async function playSocial(action,a,b,source='user',replyTo){
  if(!canPlaySocial(action,a,b))throw Error('这两位未设置浪漫关系，不能执行亲密动作');
  const seatedHug=action==='home-hug'&&(getResidentPosture(a)==='seated'||getResidentPosture(b)==='seated');
  const seatedTarget=SEATED_TARGET_ACTIONS.has(action)||seatedHug,pinnedId=seatedHug&&getResidentPosture(a)==='seated'?a:b;
  if(!socialPostureAllowed(action,getResidentPosture(a),getResidentPosture(b),socialActions[action]?.participants))throw Error('当前姿势不支持这个动作');
  if(action==='vrma-ad2a5118837bfa67'){
   if(getResidentPosture(a)!=='seated')throw Error('这个动作需要先坐下');
   stopSocial();const token=reactionGeneration,seat=visitorSeat,person=visitor;
   const clip=await loadSelectedMotion(action);
   if(token!==reactionGeneration||seat!==visitorSeat||person!==visitor)return false;
   seatedReaction={clip,start:elapsed};visitorUntil=elapsed+clip.duration;recordHomeActivity('吓了一跳','user',a==='user'?'user':'character');dirty=true;wake();return true;
  }
  if((visitorSeat||seatChange)&&!seatedTarget)throw Error('先起身，再一起互动');
  if(!seatedTarget)restoreFurnitureCharacter();
  if(source==='user'){manualRevision++;manualUntil=Date.now()+90000;}
  if(!visitor||edit||overview||socialActions[action]?.participants===2&&!resident.visible)throw Error('先到角色所在的房间，再一起互动');
  if(!socialActions[action])throw Error('这个动作没有被选中');
  stopWalking();putPlushBack();if(!seatedTarget)visitorSeat=null;visitorActivity=null;visitorPlant=null;visitorMotion='idle';visitorUntil=0;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorLocation={x:resident.position.x+current().x*ROOM_STEP.x,z:resident.position.z+current().z*ROOM_STEP.z,level:current().level};
  const entries=[...(resident.visible?[{id:activeResidentId(),visitor:{...visitor,root:resident}}]:[]),...socialEntries.filter(e=>e.group.visible).map(e=>({id:e.id,visitor:{...e.visitor,root:e.group}}))];
  // Social trajectories start at the same valid walking positions as the resident.
  const room=current(),map=navMap();
  const motionMap=walkingMap({...state,rooms:state.rooms.map(r=>({...r,items:r.items.filter(i=>asset(i.assetId)?.building)}))},room.level,catalog,{headWidth,...visitor?.navigation,walkClearance:true});
  const clearOfOthers=paths=>paths.every(path=>path.every(p=>entries.filter(e=>e.id!==a&&(socialActions[action].participants!==2||e.id!==b)).every(e=>Math.hypot(e.visitor.root.position.x-p.x,e.visitor.root.position.z-p.z)>=headWidth+.08)));

  socialRuntime=createSocialScene(entries,{canInteract:canPlaySocial,facingTarget:socialActions[action].participants===1?entries.find(e=>e.id===(a==='user'?primaryResidentId:'user'))?.visitor.root.position.clone():undefined,pinned:seatedTarget?{id:pinnedId,pose:pinnedId===activeResidentId()?currentSeatPose()||{}:socialEntries.find(e=>e.id===pinnedId)?.parkedPose||{}}:undefined,onComplete:()=>{if(action==='cmu-22_01')queueMicrotask(()=>standResident(b));},findPath:(from,to)=>{const path=findWalkPath(map,[from.x+room.x*ROOM_STEP.x,from.z+room.z*ROOM_STEP.z],[to.x+room.x*ROOM_STEP.x,to.z+room.z*ROOM_STEP.z]);return path?[from.clone(),...path.map(p=>new THREE.Vector3(p[0]-room.x*ROOM_STEP.x,.18,p[1]-room.z*ROOM_STEP.z)),to.clone()]:null;},origins:Array.from({length:17},(_,i)=>(i-8)*.45).flatMap(z=>Array.from({length:21},(_,i)=>new THREE.Vector3((i-10)*.45,.18,z))).filter(p=>map.free(p.x+room.x*ROOM_STEP.x,p.z+room.z*ROOM_STEP.z)).sort((p,q)=>p.distanceToSquared(resident.position)-q.distanceToSquared(resident.position)),canPerform:paths=>clearOfOthers(paths)&&paths.every(path=>path.every(p=>motionMap.free(p.x+room.x*ROOM_STEP.x,p.z+room.z*ROOM_STEP.z))),canPlace:paths=>paths.every(path=>path.every(p=>map.free(p.x+room.x*ROOM_STEP.x,p.z+room.z*ROOM_STEP.z)&&entries.filter(e=>e.id!==a&&(socialActions[action].participants!==2||e.id!==b)).every(e=>Math.hypot(e.visitor.root.position.x-p.x,e.visitor.root.position.z-p.z)>=headWidth+.08)))});
  socialRoom=room.id;const runtime=socialRuntime;const started=await runtime.start(action,a,b);if(!started||runtime!==socialRuntime)return false;
  const person=id=>id===primaryResidentId?ownerName:socialEntries.find(e=>e.id===id)?.label||'你';
  const label=socialActions[action].label.replace(/\s*[AB]→[AB]/g,'').replace(/\s*·\s*双人/g,'');
  const roomRecord=current();journal.push(makeHomeRecord({kind:'action',source,replyTo:source==='model'?replyTo:undefined,actor:a==='user'?'user':'character',actorId:a,actorName:person(a),targetIds:socialActions[action].participants===2?[b]:[],text:action==='home-princess-carried'?person(a)+'被'+person(b)+'公主抱':person(a)+(socialActions[action].participants===2?'对'+person(b):'')+'开始'+label,roomId:roomRecord.id,roomName:roomRecord.name}));persist();
  if(source==='user'&&a==='user'&&b===primaryResidentId)companionReaction={id:journal.at(-1).id,at:Date.now(),room:roomRecord.id};
  socialLast=elapsed;visitorUntil=elapsed+socialActions[action].duration;message=socialActions[action].label;dirty=true;wake();renderUI();return true;
 }
 let visitor=null,visitorMotion='idle',visitorStart=0,visitorUntil=0,visitorSeat=null,visitorPlant=null,visitorActivity=null,headWidth=1.5;
 const bathroomEffects=createBathroomEffects(),gamingEffects=createGamingEffects(),kitchenEffects=createKitchenEffects(resident),kitchenWork=createKitchenWorkEffects(resident);
 const activities=()=>{
  const map=navMap(),r=current(),canStand=p=>map.free(p[0]+r.x*ROOM_STEP.x,p[2]+r.z*ROOM_STEP.z);
  return [...gamingActivities(placementRoom(),catalog,{headWidth,body2:!!visitor?.rig,...visitor?.gamingReach}),...diningActivities(placementRoom(),catalog,{headWidth}),...mirrorActivities(placementRoom(),catalog,{...visitorClearance(),headWidth,canStand,body2:!!visitor?.rig}),...bathroomActivities(placementRoom(),catalog,{headWidth,body2:!!visitor?.rig})].map(a=>a.seat&&furnitureUser?.parkedSeat?.itemId===a.seat.itemId&&furnitureUser.parkedSeat.seatId===a.seat.seatId?{...a,reason:'这个位置已经有人坐着啦'}:a);
 };
 function stopMirror(){if(!isMirrorAction(visitorActivity?.kind)&&!isBathAction(visitorActivity?.kind))return;if(visitorActivity?.bathJourney)finishBathroom();visitorActivity=null;visitorMotion='idle';visitorUntil=0;gamingEffects.clear();visitor?.animate(0,'idle');message='镜前动作结束啦';dirty=true;wake();}
 let kitchenTask=null,seatChange=null;
 function cancelKitchen(){if(kitchenTask){visitorMotion='idle';visitorUntil=0;resident.position.y=.18;}kitchenTask=null;kitchenWork.clear();}
 const visitorClearance=()=>visitor?.navigation?{...visitor.navigation,headWidth}:undefined;
 const navMap=()=>{
  const map=walkingMap(state,current().level,catalog,{headWidth,...visitor?.navigation,walkClearance:true}),r=current();
  for(const e of comparisonEntries)if(e.id!==activeComparisonId&&e.group.visible){const [x,,z]=e.group.position.toArray(),half=e.width/2;map.obstacles.push([x+r.x*ROOM_STEP.x-half,.18,z+r.z*ROOM_STEP.z-half,x+r.x*ROOM_STEP.x+half,3,z+r.z*ROOM_STEP.z+half]);}
  return map;
 };
 function stopWalking(keepKitchen=false,keepFeedback=false){
  if(!keepFeedback)walkFeedback.clear();
  stopSocial();
  walking=null;if(!keepKitchen){cancelKitchen();if(visitorActivity?.bathJourney)finishBathroom();}
  if(visitorMotion==='yoga'){mat.visible=false;visitorMotion='idle';visitorUntil=0;visitor?.animate(0,'idle');}
  if(seatChange){seatChange=null;visitorMotion=visitorSeat?.bed?'sleep':'idle';placeVisitor();visitor?.animate(0,visitorMotion,visitorSeat?.bed?'lying':visitorSeat?'seated':'standing',currentSeatPose());}
  if(visitorPlant){visitorPlant=null;watering.root.visible=false;visitorMotion='idle';visitor?.animate(0,'idle');}
  if(visitorMotion==='walk')visitorMotion='idle';
 }
 function resolvedVisitorSeat(){
  const seat=seatTransform(placementRoom(),catalog,visitorSeat,!!visitor?.rig);
  return visitor?.rig?body2BedTransform(seat,visitor.bedHeadToHip,visitor.bedHipHeight):seat;
 }
 function currentSeatPose(){
  if(!visitor?.rig||!visitorSeat)return null;
  const seat=resolvedVisitorSeat();
  if(visitorSeat.bed)return seat?.pose==='bed'?{kind:'bed-rest',hands:[],bedFootSurface:bedFootSurface(seat,visitor.seatScale),bedWeight:1,bedRecline:1,bedMode:visitorSeat.bedMode,bedFrom:visitorSeat.bedFrom,bedFromTime:visitorSeat.bedFromTime,bedTime:Math.max(0,elapsed-(visitorSeat.modeStart??elapsed))}:null;
  return seat?{kind:'seat-rest',hands:[],seatPose:seat.pose,seatHeight:seat.height/(visitor.seatScale??1),...(visitorSeat.alternate&&seat.pose==='floor'?{clip:'sit-alternate',clipTime:Math.max(0,elapsed-visitorStart-seatChangeDuration('floor')),clipWeight:seatChange?0:1}:{})}:null;
 }
 function beginSeatChange(rising,entry){
  if(!visitor?.rig||reducedMotion||!visitorSeat)return false;
  const transform=resolvedVisitorSeat();if(!transform||visitorSeat.bed&&transform.pose!=='bed'||transform.bed?.entry===false)return false;
  let front=entry||(transform.pose==='bed'?bedEntry:seatEntry)(transform,navMap(),[current().x*ROOM_STEP.x,current().z*ROOM_STEP.z]);
  if(!front&&current().items.find(i=>i.id===visitorSeat.itemId)?.assetId==='gaming_chair'){const map=navMap();for(const side of [-1,1])for(const diagonal of [0,.20])for(const distance of [.9,1.1,1.3,1.5,1.8,2]){const a=transform.rotation+side*Math.PI*(.5+diagonal),p=[transform.position[0]+Math.sin(a)*distance,.18,transform.position[2]+Math.cos(a)*distance];if(!front&&map.free(p[0]+current().x*ROOM_STEP.x,p[2]+current().z*ROOM_STEP.z))front=p;}}
  if(!front)return false;
  const edge=transform.pose==='bed'?bedEdge(transform,front):null;
  seatChange={rising,bedFrom:rising?visitorSeat.bedMode:undefined,bedFromTime:elapsed-(visitorSeat.modeStart??elapsed),front,sleepStart:transform.sleepStart,seat:transform.position,rotation:transform.rotation,edge,startRotation:rising?edge?.rotation:resident.rotation.y,pose:transform.pose,start:elapsed};
  visitorStart=elapsed;visitorUntil=elapsed+seatChangeDuration(transform.pose)+.2;return true;
 }
 let modelReplyTo,homeActionPlan=null,socialReplyBusy=false;
 let journal=[],manualUntil=0,manualRevision=0,autonomousRevision=null;
 let conversation=null;

 let companionGesture=null;
 let companionFacing=null,companionSmile=null,companionWalk=null,companionReaction=null,companionUserPosition=null,homeBubble=null,companionTravel=null,companionIdle=null,companionLastResult='尚未尝试',companionPhone=null,companionRise=null,companionSeatKey=null,companionSeatAt=0,companionFurnitureId=null,companionFurniture=null;
 function showHomeBubble(id,text,kind='speech'){
  homeBubble={id,text:String(text).slice(0,8000),kind,roomId:current().id,at:Date.now()};
 }
 function nearbyCompanionSeat(user){
  if(firstPerson)user={group:resident}; // No physical user: search around the resident, not the camera outside the room.
  return roomSeats(current(),catalog).map(seat=>({seat,pose:seatTransform(current(),catalog,seat,true)})).filter(e=>e.pose&&Math.hypot(e.pose.position[0]-user.group.position.x,e.pose.position[2]-user.group.position.z)>Math.max(.65,headWidth*.6)&&Math.hypot(e.pose.position[0]-user.group.position.x,e.pose.position[2]-user.group.position.z)<3.5).sort((a,b)=>Math.hypot(a.pose.position[0]-user.group.position.x,a.pose.position[2]-user.group.position.z)-Math.hypot(b.pose.position[0]-user.group.position.x,b.pose.position[2]-user.group.position.z))[0]?.seat;
 }
 function companionActors(){return {person:furnitureUser?{group:furnitureUser.group,visitor:furnitureUser.visitor}: {group:resident,visitor},user:firstPerson?{group:camera,label:'你'}:furnitureUser?{group:resident,visitor,label:residentPortraits.user?.label||'你'}:socialEntries.find(e=>e.id==='user')};}
 function getCompanionSnapshot(){
  getHomeScene(); // Release the user's idle furniture slot only through the existing guard.
  const {user,person}=companionActors(),p=user?.group.position;
  const characterSeat=furnitureUser?.parkedSeat||(!furnitureUser?visitorSeat:null);
  const characterBusy=furnitureUser?!!characterSeat?.bed||!!furnitureUser.parkedActivity?.activity||elapsed<(furnitureUser.parkedActivity?.until||0):!!walking||!!seatChange||!!kitchenTask||!!visitorActivity||!!visitorPlant||!!heldPlush||!!visitorSeat?.bed||visitorMotion==='sleep'||elapsed<visitorUntil||!!petSystem?.contactBusy;
  const ready=!socialReplyBusy&&!homeActionPlan&&!photoSession&&!!person.visitor&&!!user?.group.visible&&person.group.visible&&manualControl!==primaryResidentId&&!suspended&&!edit&&!overview&&!conversation&&!greeting&&!companionGesture&&!characterBusy&&!companionTravel&&!companionIdle&&!companionPhone&&!companionRise&&!socialRuntime?.active;
  if(isDevDebugAvailable())host.dataset.companionDebug=JSON.stringify({ready,userVisible:!!user?.group.visible,charVisible:resident.visible,userFurniture:!!furnitureUser,controlled:manualControl===primaryResidentId,greeting:!!greeting,conversation:!!conversation,walking:!!walking,seated:!!visitorSeat,social:!!socialRuntime?.active,activity:!!visitorActivity,manualRemaining:Math.max(0,manualUntil-Date.now()),animationRemaining:Math.max(0,visitorUntil-elapsed),autonomy:state.autonomy!==false});
  if(p&&!companionUserPosition)companionUserPosition={x:p.x,z:p.z,room:current().id};
  const seatKey=characterSeat?current().id+':'+characterSeat.itemId+':'+characterSeat.seatId:null;if(seatKey!==companionSeatKey){companionSeatKey=seatKey;companionSeatAt=Date.now();}
  const blockers=[homeActionPlan&&'正在执行回复动作计划',photoSession&&'正在拍照',!person.visitor&&'角色形象未就绪',!user?.group.visible&&'用户不在当前房间',!person.group.visible&&'角色不在当前房间',manualControl===primaryResidentId&&'正在手动操控角色',suspended&&'家园已挂起',edit&&'正在布置房间',overview&&'正在看总览',conversation&&'正在交谈',greeting&&'正在入场打招呼',characterBusy&&'角色正在执行家具或其他动作',companionTravel&&'正在自主走动',companionIdle&&'正在待机',companionPhone&&'正在看手机',companionRise&&'正在起身',socialRuntime?.active&&'正在双人互动',state.autonomy===false&&'自主活动已关闭',Date.now()<manualUntil&&'刚执行手动操作，短暂让行'].filter(Boolean);
  return {canInteractPet:ready&&!furnitureUser&&!characterSeat&&!!visitor?.rig&&!petSystem?.contactBusy&&petSystem?.life.data.pets.some(p=>p.roomId===current().id&&(!petSystem.life.runtime.has(p.id)||petSystem.life.runtime.get(p.id).kind==='idle'&&!petSystem.life.runtime.get(p.id).manual)),canRise:ready&&!!characterSeat&&!characterSeat.bed&&Date.now()-companionSeatAt>=60000&&Date.now()>=manualUntil,canUseFurniture:ready&&!furnitureUser&&!characterSeat&&homeActionOptions().some(a=>['water','mirror-outfit','computer','race','coffee'].includes(a.kind)),blockers,posture:characterSeat?.bed?'躺着':characterSeat?'坐着':'站着',userFurniture:!!furnitureUser,manualRemaining:Math.max(0,manualUntil-Date.now()),lastResult:companionLastResult,speechReady:ready,ready:ready&&state.autonomy!==false,canIdle:ready&&Date.now()>=manualUntil,canMove:ready&&!characterSeat&&Date.now()>=manualUntil,distance:firstPerson?0:p?Math.hypot(p.x-person.group.position.x,p.z-person.group.position.z):Infinity,userMoved:!firstPerson&&!!p&&companionUserPosition?.room===current().id&&Math.hypot(p.x-companionUserPosition.x,p.z-companionUserPosition.z)>1,canSit:ready&&!furnitureUser&&!!nearbyCompanionSeat(user),reactionId:companionReaction&&companionReaction.room===current().id&&Date.now()-companionReaction.at<90000?companionReaction.id:undefined};
 }
 function characterSeatState(){return furnitureUser?{seat:furnitureUser.parkedSeat,pose:furnitureUser.parkedPose}:{seat:visitorSeat,pose:currentSeatPose()};}
 function playHomeResponse(source='local',replyTo,warmth=.3,motion='vrma-788371d87156b583'){
  const {person}=companionActors();if(!person?.group.visible||suspended||photoSession||companionPhone||companionRise||companionTravel||greeting||edit||overview||socialRuntime?.active||(!furnitureUser&&(walking||seatChange||visitorActivity||kitchenTask||visitorPlant||petSystem?.contactPose())))return false;
  companionGesture={person,start:elapsed,revision:manualRevision,room:current().id,source,replyTo,wave:!reducedMotion&&warmth>=.35&&!characterSeatState().seat?.bed,clip:null,recorded:false};
  const gesture=companionGesture;
  if(gesture.wave)loadSelectedMotion(motion).then(clip=>{if(destroyed||companionGesture!==gesture)return;gesture.clip=clip;gesture.start=elapsed;dirty=true;wake();}).catch(()=>{if(!destroyed&&companionGesture===gesture){gesture.wave=false;gesture.start=elapsed;dirty=true;wake();}});
  dirty=true;wake();return true;
 }
 function animateCompanionIdle(){
  if(companionGesture){const s=companionGesture,seat=characterSeatState(),t=elapsed-s.start;
   if(s.revision!==manualRevision||s.room!==current().id||s.person.visitor!==companionActors().person.visitor||edit||overview||socialRuntime?.active||(!furnitureUser&&(walking||seatChange||visitorActivity||kitchenTask||petSystem?.contactPose()))||t>(s.wave?(s.clip?.duration??15):3)){companionGesture=null;return;}
   const posture=seat.seat?.bed?'lying':seat.seat?'seated':'standing';
   s.person.visitor.animate(t,'idle',posture,seat.pose);
   if(s.wave){if(!s.clip){dirty=true;return;}const weight=Math.max(0,Math.min(1,t/.35,(s.clip.duration-t)/.35));s.person.visitor.applySelectedFrame(sampleSelected(s.clip.actors[0],t),weight,seat.seat?seat.pose||{}:undefined);}
   if(!s.wave){const nod=Math.sin(Math.min(1,t/2.4)*Math.PI*2)*.16*Math.sin(Math.min(1,t/3)*Math.PI);if(s.person.visitor.rig){s.person.visitor.rig.bones.head.rotation.x+=nod;s.person.visitor.finishPose();}else s.person.visitor.animate(t,'idle',posture,{...seat.pose,kind:'social',hands:[],socialHead:[nod,0,0]});}
   if(!s.recorded){s.recorded=true;journal.push(makeHomeRecord({kind:'action',source:s.source,actor:'character',replyTo:s.replyTo,text:ownerName+(s.wave?'轻轻挥手回应':'轻轻点头回应'),roomId:current().id,roomName:current().name}));persist();}
   dirty=true;return;
  }
  const s=companionIdle;if(!s)return;
  const {person}=companionActors(),seat=characterSeatState();
  if(person.visitor!==s.person.visitor||s.revision!==manualRevision||s.room!==current().id||conversation||edit||overview||state.autonomy===false){cancelCompanionAction();return;}
  const t=elapsed-s.start,weight=Math.max(0,Math.min(1,t/.6,(5-t)/.6));
  person.visitor.animate(t,'idle',seat.seat?'seated':'standing',seat.pose);
  if(!reducedMotion&&person.visitor.rig){const head=person.visitor.rig.bones.head;head.rotation.y+=Math.sin(t*1.2)*.23*weight;head.rotation.x+=Math.sin(t*2)*.06*weight;person.visitor.finishPose();}
  else if(!reducedMotion)person.visitor.animate(t,'idle',seat.seat?'seated':'standing',{...seat.pose,kind:'social',hands:[],socialHead:[Math.sin(t*2)*.06*weight,0,Math.sin(t*1.2)*.12*weight]});
  dirty=true;if(t>=5)companionIdle=null;
 }
 function companionRecord(text){journal.push(makeHomeRecord({kind:'action',source:'local',actor:'character',text:ownerName+text,roomId:current().id,roomName:current().name}));persist();}
 function faceCompanionUser(user){const root=companionActors().person.group;companionFacing={root,from:root.rotation.y,to:Math.atan2(user.group.position.x-root.position.x,user.group.position.z-root.position.z),start:elapsed,revision:manualRevision,room:current().id};dirty=true;wake();}
 function cancelCompanionAction(){
  companionGesture=null;
  if(companionPhone){const old=companionPhone;companionPhone=null;old.prop?.dispose();endConversationPose(old);}
  if(companionRise){const old=companionRise;companionRise=null;old.person.group.position.fromArray(old.seat);old.person.visitor.animate(0,'idle','seated',old.poseData);}

  if(companionIdle){const a=companionActors();if(a.person.visitor===companionIdle.person.visitor)a.person.visitor.animate(0,'idle',characterSeatState().seat?'seated':'standing',characterSeatState().pose);companionIdle=null;}
  companionFacing=null;
  if(companionTravel){companionTravel.person.visitor.animate(0,'idle');companionTravel=null;dirty=true;wake();}
  if(companionWalk&&walking===companionWalk)stopWalking(true,true);
  companionWalk=null;
  if(companionSmile){setResidentExpression(primaryResidentId,companionSmile.old||{});companionSmile=null;}
 }
 function updateCompanion(){
  if(companionFurniture){const f=companionFurniture;if(f.revision!==manualRevision||f.room!==current().id){companionFurniture=null;}else if(!conversation&&elapsed>=f.until){companionFurniture=null;if(furnitureUser){if(furnitureUser.parkedActivity){furnitureUser.parkedActivity.activity=null;furnitureUser.parkedActivity.motion='idle';furnitureUser.parkedActivity.until=0;}dirty=true;}else if(['computer','race','mirror-outfit'].includes(f.kind))runAction({action:'chibi-game-stop'});else if(f.kind==='water')stopWalking();dirty=true;}}

  if(companionRise){const r=companionRise;if(r.revision!==manualRevision||r.room!==current().id||companionActors().person.visitor!==r.person.visitor||conversation||edit||overview||state.autonomy===false){cancelCompanionAction();return;}
   const f=seatChangePose(r,elapsed-r.start);r.person.group.position.fromArray(f.position);setResidentHeading(r.person.group,f.rotation??r.rotation);r.person.visitor.animate(elapsed-r.start,'idle','seated',{...r.poseData,kind:'seat-change',hands:[],seatWeight:f.weight,seatLean:f.lean,seatFold:f.fold,seatSupport:f.support});
   dirty=true;if(f.done){if(furnitureUser){furnitureUser.parkedSeat=null;furnitureUser.parkedPose=null;furnitureUser.settledRoom=current().id;}else{visitorSeat=null;visitorLocation={x:r.front[0]+current().x*ROOM_STEP.x,z:r.front[2]+current().z*ROOM_STEP.z,level:current().level};}r.person.visitor.animate(0,'idle');companionRise=null;companionRecord('起身离开座位');}
  }

  const travel=companionTravel;
  if(travel){
   if(travel.revision!==manualRevision||travel.room!==current().id||companionActors().person.visitor!==travel.person.visitor||state.autonomy===false||edit||overview||conversation||socialRuntime?.active){cancelCompanionAction();return;}
   const root=travel.person.group,user=companionActors().user,offset=travel.offset;
   let remaining=Math.max(0,elapsed-travel.last)*(travel.person.visitor.walkSpeed||1.05);travel.last=elapsed;
   while(remaining>0&&travel.index<travel.path.length){const p=travel.path[travel.index],dx=p[0]-offset[0]-root.position.x,dz=p[1]-offset[1]-root.position.z,d=Math.hypot(dx,dz),step=Math.min(remaining,d);
    const nx=root.position.x+(d?dx/d*step:0),nz=root.position.z+(d?dz/d*step:0);
    if(user&&residentBlocksStep([root.position.x,root.position.z],[nx,nz],[[user.group.position.x,user.group.position.z]])){if(!furnitureUser)visitorLocation={x:root.position.x+offset[0],z:root.position.z+offset[1],level:current().level};cancelCompanionAction();return;}
    if(d>.001)setResidentHeading(root,Math.atan2(dx,dz));root.position.x=nx;root.position.z=nz;remaining-=step;if(d<=step+.001)travel.index++;else break;
   }
   travel.person.visitor.animate(elapsed-travel.start,'walk');
   if(!furnitureUser)visitorLocation={x:root.position.x+offset[0],z:root.position.z+offset[1],level:current().level};else furnitureUser.settledRoom=current().id;
   if(travel.index>=travel.path.length){companionTravel=null;travel.person.visitor.animate(0,'idle');if(user)faceCompanionUser(user);if(travel.action!=='wander')companionRecord((travel.action==='follow'?'跟着':'走到')+travel.name+'身边停下');}
   dirty=true;renderer.shadowMap.needsUpdate=true;
  }
  if(companionSmile&&(elapsed>=companionSmile.until||companionSmile.revision!==manualRevision)){setResidentExpression(primaryResidentId,companionSmile.old||{});companionSmile=null;}
  const f=companionFacing;if(!f)return;
  if(f.revision!==manualRevision||f.room!==current().id||(!furnitureUser&&walking)||conversation||f.root!==companionActors().person.group||socialRuntime?.active){companionFacing=null;return;}
  const t=THREE.MathUtils.smoothstep(elapsed-f.start,0,.65),delta=Math.atan2(Math.sin(f.to-f.from),Math.cos(f.to-f.from));setResidentHeading(f.root,f.from+delta*t);dirty=true;if(t>=1)companionFacing=null;
 }
 function performCompanionAction(action,warmth=.3){
  const snapshot=getCompanionSnapshot();companionLastResult='已启动（不代表已完成）';if(!snapshot.ready||!['react','idle','look','phone','stand'].includes(action)&&!snapshot.canMove){companionLastResult=snapshot.blockers.join('、')||'当前姿势不允许移动';return false;}
  const {user,person}=companionActors(),name=user.label||'你';
  if(action==='pet'){
   if(!snapshot.canInteractPet)return false;
   const pets=petSystem.life.data.pets.filter(p=>p.roomId===current().id&&(!petSystem.life.runtime.has(p.id)||petSystem.life.runtime.get(p.id).kind==='idle'&&!petSystem.life.runtime.get(p.id).manual));
   pets.sort((a,b)=>Math.hypot(a.x-person.group.position.x,a.z-person.group.position.z)-Math.hypot(b.x-person.group.position.x,b.z-person.group.position.z));
   for(const pet of pets){try{petSystem.contact.start(pet.id,Math.random()<.5?'pet':'play',{actorId:primaryResidentId,actorName:ownerName,source:'local'});companionLastResult='正在走向'+pet.name+'，到达后陪伴';dirty=true;wake();return true;}catch(error){companionLastResult=error.message;}}
   return false;
  }
  if(action==='phone'){
   if(!snapshot.canIdle){companionLastResult='当前动作不能被打断';return false;}
   const session={person:person.visitor,root:person.group,room:current().id,revision:manualRevision,start:elapsed,clip:null,prop:null};companionPhone=session;
   loadSelectedMotion('vrma-54a37ca48a1d4ffb').then(clip=>{if(companionPhone!==session)return;session.clip=clip;session.start=elapsed;session.prop=createSocialProp('vrma-54a37ca48a1d4ffb',[session.person]);companionRecord(characterSeatState().seat?'坐着看手机':'拿出手机看了一会儿');dirty=true;wake();}).catch(()=>{if(companionPhone===session){companionPhone=null;companionLastResult='手机动作加载失败';}});
   dirty=true;wake();return true;
  }
  if(action==='stand'){
   if(!snapshot.canRise){companionLastResult='尚在休息或正在交谈';return false;}
   const seat=characterSeatState(),transform=seatTransform(current(),catalog,seat.seat,!!person.visitor.rig),front=transform&&seatEntry(transform,navMap(),[current().x*ROOM_STEP.x,current().z*ROOM_STEP.z]);
   if(!front||Math.hypot(front[0]-user.group.position.x,front[2]-user.group.position.z)<.55){companionLastResult='座位前没有安全起身位置';return false;}
   companionRise={person,room:current().id,revision:manualRevision,rising:true,front,seat:transform.position,rotation:transform.rotation,pose:transform.pose,poseData:seat.pose,start:elapsed};dirty=true;wake();return true;
  }
  if(action==='furniture'){
   if(furnitureUser){companionLastResult='用户占用家具动作槽';return false;}
   const options=homeActionOptions().filter(a=>['water','mirror-outfit','computer','race','coffee'].includes(a.kind)&&a.id!==companionFurnitureId);
   if(!options.length){companionLastResult='当前没有新的可用家具活动';return false;}
   const option=options[Math.floor(Math.random()*options.length)];
   if(option.kind==='water'){
    const spot=wateringSpot(current(),catalog,option.data.id,visitorClearance()),r=current(),ox=r.x*ROOM_STEP.x,oz=r.z*ROOM_STEP.z;
    const path=spot&&findWalkPath(navMap(),[person.group.position.x+ox,person.group.position.z+oz],[spot.position[0]+ox,spot.position[2]+oz]);
    if(!path||path.some(p=>Math.hypot(p[0]-ox-user.group.position.x,p[1]-oz-user.group.position.z)<.55)){companionLastResult='浇水位置不可达或被用户占用';return false;}
    if(!walkTo([spot.position[0]+ox,spot.position[2]+oz])||!walking){companionLastResult='无法走向绿植';return false;}
    const revision=manualRevision;companionWalk=walking;walking.arrived=()=>{companionWalk=null;if(revision!==manualRevision||current().id!==r.id||state.autonomy===false||conversation)return;runAction({...option.data,recordSource:'local'});companionFurniture={room:r.id,revision,kind:'water',until:elapsed+8};};
    companionFurnitureId=option.id;companionLastResult='正在走向绿植，到达后浇水';return true;
   }
   const result=performHomeAction(option.id,'local');
   if(result==='unavailable'){companionLastResult='家具活动未能启动：入口或路径不可用';return false;}companionFurnitureId=option.id;companionFurniture={room:current().id,revision:manualRevision,kind:option.kind,until:isSustainedFurnitureActivity(option.kind)?Infinity:elapsed+45};companionLastResult='已发起：'+option.label;return true;
  }
  if(action==='idle'){if(!snapshot.canIdle)return false;companionIdle={person,start:elapsed,revision:manualRevision,room:current().id};dirty=true;wake();return true;}
  if(action==='look'||action==='react'){
   if(action==='react'&&!snapshot.reactionId)return false;
   if(action==='react'){if(!playHomeResponse('local',undefined,warmth))return false;companionReaction=null;}
   const seated=!!(furnitureUser?.parkedSeat||(!furnitureUser&&visitorSeat));
   if(!seated)faceCompanionUser(user);
   if(action==='look'){companionIdle={person,start:elapsed,revision:manualRevision,room:current().id};dirty=true;wake();}
   if(action==='react'&&warmth>=.35){companionSmile={old:residentExpressions.get(primaryResidentId),until:elapsed+2.5,revision:manualRevision};setResidentExpression(primaryResidentId,{eyes:'happy',blink:false});showHomeBubble(primaryResidentId,'♪','reaction');}
   if(action==='react'&&seated&&warmth<.35){companionSmile={old:residentExpressions.get(primaryResidentId),until:elapsed+.45,revision:manualRevision};setResidentExpression(primaryResidentId,{eyes:'closed',blink:false});}
   if(action==='look')companionRecord('看向'+name);return true;
  }
  if(action==='sit'){
   const seat=nearbyCompanionSeat(user);if(!seat){companionLastResult='附近没有可用空座';return false;}
   const option=homeActionOptions().find(a=>a.kind==='sit'&&a.data.id===seat.itemId&&a.data.seat===seat.seatId);
   if(!option)return false;
   const room=current(),offset=[room.x*ROOM_STEP.x,room.z*ROOM_STEP.z],map=navMap(),pose=seatTransform(room,catalog,seat,true),front=pose&&seatEntry(pose,map,offset);
   if(!front){companionLastResult='座位入口被挡住';return false;}
   const path=findWalkPath(map,[resident.position.x+offset[0],resident.position.z+offset[1]],[front[0]+offset[0],front[2]+offset[1]]);
   if(!path||path.some(p=>Math.hypot(p[0]-offset[0]-user.group.position.x,p[1]-offset[1]-user.group.position.z)<Math.max(.5,headWidth*.5))){companionLastResult='座位路线不可达或会撞到用户';return false;}
   const revision=manualRevision;
   if(!walkTo([front[0]+offset[0],front[2]+offset[1]]))return false;
   companionWalk=walking;autonomousRevision=manualRevision;
   walking.arrived=()=>{companionWalk=null;if(revision!==manualRevision||current().id!==room.id||state.autonomy===false)return;runAction({...option.data,recordSource:'local'});};return true;
  }
  if(!['approach','follow','wander'].includes(action)||action!=='wander'&&snapshot.distance<2)return false;
  const room=current(),offset=[room.x*ROOM_STEP.x,room.z*ROOM_STEP.z],map=navMap(),radius=.95;
  const start=[person.group.position.x+offset[0],person.group.position.z+offset[1]],candidates=[];
  for(let i=0;i<12;i++){const a=i*Math.PI/6+(action==='wander'?Math.random()*.25:0),origin=action==='wander'?person.group.position:user.group.position,r=action==='wander'?1.4:radius,p=[origin.x+Math.sin(a)*r+offset[0],origin.z+Math.cos(a)*r+offset[1]];
   if(Math.abs(p[0]-offset[0])>=ROOM_HALF.x-.3||Math.abs(p[1]-offset[1])>=ROOM_HALF.z-.3)continue;
   const path=findWalkPath(map,start,p);if(path&&path.every(q=>Math.hypot(q[0]-offset[0]-user.group.position.x,q[1]-offset[1]-user.group.position.z)>.55))candidates.push({p,path});
  }
  candidates.sort((a,b)=>a.path.length-b.path.length);if(!candidates.length){if(action==='wander'){companionLastResult='没有可达空地，本次未走动';return false;}companionLastResult='未找到可达的靠近位置';return false;}
  companionUserPosition={x:user.group.position.x,z:user.group.position.z,room:room.id};
  companionTravel={person,path:candidates[0].path,index:1,offset,room:room.id,revision:manualRevision,action,name,start:elapsed,last:elapsed};dirty=true;wake();
  return true;
 }

 const guestLife=createGuestLife(()=>({entries:socialEntries,ownerId:primaryResidentId,main:{group:resident,width:headWidth},seat:visitorSeat,room:current(),catalog,time:elapsed,offset:[current().x*ROOM_STEP.x,current().z*ROOM_STEP.z],autonomy:state.autonomy!==false&&!socialReplyBusy,
  blocked:suspended||edit||overview||roomLoading||!!photoSession||!!socialRuntime?.active||!!conversation||!!homeActionPlan,
  map:id=>walkingMap(state,current().level,catalog,{headWidth:socialEntries.find(e=>e.id===id)?.width||headWidth,...socialEntries.find(e=>e.id===id)?.visitor.navigation}),
  wake:()=>{dirty=true;wake();},record:(id,name,text,source,replyTo)=>{journal.push(makeHomeRecord({kind:'action',actor:'character',actorId:id,actorName:name,source,replyTo,text,roomId:current().id,roomName:current().name}));persist();}
 }));
 function getPresentResidents(){return [...(visitor&&resident.visible?[{id:activeResidentId(),name:activeResidentId()===primaryResidentId?ownerName:'用户'}]:[]),...socialEntries.filter(e=>e.group.visible).map(e=>({id:e.id,name:e.label}))];}
 function getResidentScene(id){const base=getHomeScene();if(id===primaryResidentId)return {...base,participants:getPresentResidents(),...(furnitureUser?{actions:[]}: {})};const e=socialEntries.find(e=>e.id===id);return {...base,romanticPartners:romanticPartners(id),participants:getPresentResidents(),present:!!e?.group.visible,busy:guestLife.busy(id),activity:e?.parkedSeat?'坐着休息':'在屋里',actions:guestLife.actions(id)};}
 async function performResidentActions(id,ids,replyTo,signal){if(id===primaryResidentId)return performHomeActions(ids,replyTo,signal);for(const action of ids){if(signal?.aborted)return 'cancelled';if(!guestLife.start(id,action,'model',replyTo))return 'unavailable';const deadline=Date.now()+60000;while(guestLife.busy(id)){if(signal?.aborted||Date.now()>deadline||destroyed){guestLife.cancel(id);return 'cancelled';}await new Promise(resolve=>setTimeout(resolve,50));}if(guestLife.result(id)!=='completed')return 'unavailable';}return 'completed';}
 function hasIdleResidents(){return !suspended&&!edit&&!overview&&!socialRuntime?.active&&socialEntries.some(e=>e!==furnitureUser&&e.group.visible);}
 function animateIdleResidents(){
  if(!hasIdleResidents())return false;
  for(const entry of socialEntries)if(entry!==furnitureUser&&entry.group.visible&&!guestLife.animate(entry)&&!entry.parkedSeat&&!entry.parkedActivity?.activity)entry.visitor.animate(elapsed,'idle','standing');
  return true;
 }
 function animateParkedCharacter(){
  parkedMealEffects?.updateMeal(null,0);
  const entry=furnitureUser||socialEntries.find(e=>e.id==='user'),p=entry?.parkedActivity;if(!p||socialRuntime?.active||furnitureUser&&(companionPhone||companionTravel||companionIdle||companionGesture||companionRise||conversation))return;
  if(p.activity?.kind==='eat'&&elapsed>=p.until){p.activity=null;p.motion='idle';}
  const seat=entry.parkedSeat,activity=p.activity||entry.parkedPose;
  entry.visitor.animate(elapsed-p.start,p.motion,seat?.bed?'lying':seat?'seated':p.activity?.posture||'standing',activity);
  if(activity?.kind==='eat'&&elapsed<p.until){parkedMealEffects??=createKitchenEffects(entry.group);parkedMealEffects.updateMeal(activity,elapsed-p.start,entry.visitor.rig?diningGrip(entry.group,entry.visitor.rig):null);}
 }
 function setPhoneReply(active){if(photoSession)return false;
  if(!active){if(companionPhone?.phoneReply)cancelCompanionAction();return false;}
  if(companionPhone?.phoneReply)return true;
  const {person}=companionActors(),seat=characterSeatState();
  if(!person?.visitor||!person.group.visible||suspended||edit||overview||greeting||conversation||socialRuntime?.active||seat.seat?.bed||companionTravel||companionRise||(!furnitureUser&&(walking||seatChange||visitorActivity||kitchenTask||visitorPlant))||furnitureUser?.parkedActivity?.activity)return false;
  if(companionPhone)cancelCompanionAction();
  const session={person:person.visitor,root:person.group,room:current().id,revision:manualRevision,start:elapsed,clip:null,prop:null,phoneReply:true};companionPhone=session;
  loadSelectedMotion('vrma-54a37ca48a1d4ffb').then(clip=>{if(companionPhone!==session)return;session.clip=clip;session.start=elapsed;session.prop=createSocialProp('vrma-54a37ca48a1d4ffb',[session.person]);companionRecord('拿起手机回复消息');dirty=true;wake();}).catch(()=>{if(companionPhone===session)cancelCompanionAction();});dirty=true;wake();return true;
 }
 function animateCompanionPhone(){
  const s=companionPhone;if(!s)return;
  if(s.person!==companionActors().person.visitor||s.room!==current().id||s.revision!==manualRevision||conversation||edit||overview||(!s.phoneReply&&state.autonomy===false)){cancelCompanionAction();return;}
  if(!s.clip)return;
  const d=s.clip.duration,t=s.phoneReply?(elapsed-s.start)%d:elapsed-s.start,weight=Math.max(0,Math.min(1,t/.5,(d-t)/.5)),seat=characterSeatState();
  if(t>=d){cancelCompanionAction();dirty=true;return;}
  s.person.applySelectedFrame(sampleSelected(s.clip.actors[0],t),weight,seat.seat?seat.pose||{}:undefined);s.prop?.update(t,d,weight);dirty=true;
 }
 function endConversationPose(s){
  if(s?.person!==companionActors().person.visitor)return;
  const seat=characterSeatState();
  if(seat.seat?.bed){seat.seat.bedFrom='bed-talk';seat.seat.bedFromTime=elapsed-s.start;seat.seat.modeStart=elapsed;if(seat.pose)Object.assign(seat.pose,{bedFrom:'bed-talk',bedFromTime:elapsed-s.start,bedTime:0});}
  if(furnitureUser||(!walking&&!seatChange&&!visitorActivity&&!kitchenTask)){s.person.animate(0,seat.seat?.bed&&!seat.seat.bedMode?'sleep':'idle',seat.seat?.bed?'lying':seat.seat?'seated':'standing',seat.pose);dirty=true;wake();}
 }
 let userSpeech=null;
 function playUserSpeech(text){
  const person=companionActors().user;if(!person?.visitor||!person.group.visible)return;
  const s={person:person.visitor,room:current().id,start:elapsed,until:elapsed+Math.min(12,Math.max(3,text.length/6)),clip:null};userSpeech=s;
  loadSelectedMotion('vrma-0c64f7e2cbde3af4').then(clip=>{if(userSpeech===s){s.clip=clip;dirty=true;wake();}}).catch(()=>{if(userSpeech===s)userSpeech=null;});dirty=true;wake();
 }
 function animateUserSpeech(){
  const s=userSpeech;if(!s)return;
  const person=companionActors().user;
  if(elapsed>=s.until||s.room!==current().id||s.person!==person?.visitor){userSpeech=null;return;}
  if(!s.clip||reducedMotion||edit||overview||socialRuntime?.active||!person.group.visible)return;
  if(furnitureUser&&(walking||seatChange||visitorActivity||kitchenTask||visitorPlant||heldPlush||petSystem?.contactPose()))return;
  const posture=getResidentPosture('user');if(posture==='lying'||posture==='transition')return;
  const t=elapsed-s.start,frame=t%s.clip.duration,weight=Math.max(0,Math.min(1,t/.4,(s.until-elapsed)/.4));
  s.person.applySelectedFrame(sampleSelected(s.clip.actors[0],frame),weight,posture==='seated'?currentSeatPose()||{}:undefined);s.person.finishPose();dirty=true;
 }
 function beginHomeConversation(){
  cancelCompanionAction();
  const session={room:current().id,revision:manualRevision,person:companionActors().person.visitor,until:Infinity,clip:null,start:elapsed,index:Math.floor(Math.random()*3),loading:false};conversation=session;
  dirty=true;wake();
  return (seconds=0)=>{if(conversation!==session)return;if(seconds>0)session.until=elapsed+Math.min(12,seconds);else {endConversationPose(session);conversation=null;}dirty=true;wake();};
 }
 function lookAtResident(person,target,id){
  if(['lying','transition'].includes(getResidentPosture(id)))return;
  const point=target.visitor.getHeadWorldPosition();
  if(getResidentPosture(id)==='standing')conversationHeading(person.group,point,reducedMotion?1:.12);
  if(person.visitor.rig){conversationHead(person.visitor.rig.bones.head,point,.8);person.visitor.finishPose();}else person.visitor.lookToward?.(point);
  dirty=true;
 }
 function faceNearbyResidents(){
  if(firstPerson)return;
  if(edit||overview||suspended||greeting||socialRuntime?.active||conversation||companionGesture||userSpeech)return;
  const actors=[{id:activeResidentId(),group:resident,visitor},...socialEntries].filter(p=>p.visitor&&p.group.visible);
  const free=p=>p.id===activeResidentId()?!(walking||seatChange||visitorActivity||kitchenTask||visitorPlant||heldPlush||elapsed<visitorUntil||petSystem?.contactPose()):true;
  const idle=p=>free(p)&&(p.id!==primaryResidentId||!(companionTravel||companionPhone||companionIdle||companionRise));
  const user=actors.find(p=>p.id==='user');if(!user||!idle(user))return;
  const near=actors.filter(p=>p.id!=='user'&&idle(p)&&Math.abs(p.group.position.y-user.group.position.y)<1.5&&Math.hypot(p.group.position.x-user.group.position.x,p.group.position.z-user.group.position.z)<=3.2);
  near.sort((a,b)=>a.group.position.distanceToSquared(user.group.position)-b.group.position.distanceToSquared(user.group.position));
  for(const person of near)lookAtResident(person,user,person.id);
  if(near[0])lookAtResident(user,near[0],'user');
 }
 function faceConversationPartner(){
  if(firstPerson){faceHomelyCamera();return;}
  if(edit||overview||greeting)return;
  if(socialRuntime?.active){
   const session=socialRuntime.inspect().session;if(!session||session.participants.length!==1||socialActions[session.action]?.category==='self')return;
   const speakerId=session.participants[0],listenerId=speakerId==='user'?primaryResidentId:'user';
   const find=id=>id===activeResidentId()?{group:resident,visitor}:socialEntries.find(e=>e.id===id);
   const speaker=find(speakerId),listener=find(listenerId);
   if(speaker?.group.visible&&listener?.group.visible)lookAtResident(listener,speaker,listenerId);
   return;
  }
  if(!conversation&&!companionGesture&&!userSpeech)return;
  const {person,user}=companionActors();if(!person.visitor||!user?.visitor||!person.group.visible||!user.group.visible)return;
  if(!furnitureUser&&(walking||seatChange||visitorActivity||kitchenTask||visitorPlant||petSystem?.contactPose()))return;
  const seat=characterSeatState(),target=user.visitor.getHeadWorldPosition();
  if(seat.seat?.bed)return;
  if(!seat.seat){conversationHeading(person.group,target,reducedMotion?1:.12);visitorLocation={x:resident.position.x+current().x*ROOM_STEP.x,z:resident.position.z+current().z*ROOM_STEP.z,level:current().level};}
  if(person.visitor.rig){conversationHead(person.visitor.rig.bones.head,target,.8);person.visitor.finishPose();}else person.visitor.lookToward?.(target);
  if(!furnitureUser||!walking&&!seatChange&&!visitorActivity&&!kitchenTask&&!visitorPlant&&!heldPlush&&!petSystem?.contactPose())lookAtResident(user,person,'user');
  dirty=true;
 }
 function animateConversation(){
  const s=conversation;if(!s)return false;
  if(s.room!==current().id||s.revision!==manualRevision||s.person!==companionActors().person.visitor||elapsed>=s.until){endConversationPose(s);conversation=null;return false;}
  const seat=characterSeatState();
  if(seat.seat?.bed&&s.person.rig&&(furnitureUser||!walking&&!seatChange)){s.person.animate(reducedMotion?1:elapsed-s.start,'idle','lying',{...seat.pose,kind:'bed-rest',hands:[],bedMode:'bed-talk',bedFrom:seat.seat.bedMode,bedFromTime:elapsed-(seat.seat.modeStart??elapsed),bedTime:reducedMotion?1:elapsed-s.start});dirty=true;return true;}
  if(reducedMotion||seat.seat?.bed||(!furnitureUser&&(walking||seatChange||kitchenTask||visitorActivity||visitorPlant||heldPlush||visitorMotion!=='idle'||petSystem?.contactPose()))||!companionActors().person.group.visible||edit||overview)return false;
  if(s.clip&&elapsed-s.start>=s.clip.duration){s.clip=null;s.index=(s.index+1+Math.floor(Math.random()*2))%3;}
  if(!s.clip&&!s.loading){s.loading=true;const id=['vrma-0c64f7e2cbde3af4','vrma-fdcc1a71495a8b1b','vrma-3b1c1155dfac93d4'][s.index];loadSelectedMotion(id).then(clip=>{if(conversation===s){s.clip=clip;s.start=elapsed;dirty=true;wake();}}).catch(()=>{if(conversation===s)conversation=null;}).finally(()=>{s.loading=false;});}
  if(!s.clip)return false;
  const t=elapsed-s.start,weight=Math.max(0,Math.min(1,t/.4,(s.clip.duration-t)/.4,(s.until-elapsed)/.4));
  s.person.applySelectedFrame(sampleSelected(s.clip.actors[0],t),weight,seat.seat?seat.pose||{}:undefined);dirty=true;return true;
 }
 function homeActionOptions(){
  if(!visitor||!(furnitureUser?furnitureUser.group.visible:resident.visible)||edit||overview)return [];
  const otherSeat=furnitureUser?visitorSeat:socialEntries.find(e=>e.id==='user')?.parkedSeat;
  const available=s=>(!otherSeat||s.itemId!==otherSeat.itemId||s.seatId!==otherSeat.seatId)&&!guestLife.reserved(s,activeResidentId());
  const room=current(),options=activities().filter(a=>!a.reason&&a.roomId===room.id&&(!a.seat||available(a.seat))).map(a=>({kind:a.kind,label:a.label,data:{action:isBathAction(a.kind)?'chibi-bath':isMirrorAction(a.kind)?'chibi-mirror':'chibi-game',id:a.itemId,kind:a.kind,station:a.stationId||''}}));
  for(const item of room.items)for(const action of kitchenActions(room,catalog,item.id).filter(a=>!a.reason))options.push({kind:action.kind,label:action.label,data:{action:'chibi-kitchen',id:item.id,kind:action.kind}});
  for(const seat of roomSeats(room,catalog).filter(available))options.push({kind:'sit',label:'坐下休息',data:{action:'chibi-sit',id:seat.itemId,seat:seat.seatId}});
  for(const plant of roomPlants(room,catalog,visitorClearance()).filter(p=>p.spot))options.push({kind:'water',label:'给植物浇水',data:{action:'chibi-water',id:plant.itemId}});
  options.push({kind:'stand',label:'起身',target:'自己',data:{action:'chibi-stand'}});
  for(const bed of roomBeds(room,catalog).filter(available)){
   options.push({kind:'sleep',label:'上床休息',data:{action:'chibi-bed',id:bed.itemId,seat:bed.seatId}});
   if(visitor.rig)for(const [mode,label] of BED_LEISURE)options.push({kind:mode,label,prerequisite:'先躺在该床位',data:{action:'chibi-bed',id:bed.itemId,seat:bed.seatId,mode}});
  }
  for(const [id,action] of Object.entries(socialActions)){
   if(!canPlaySocial(id,primaryResidentId,action.participants===2?'user':undefined))continue;
   if(firstPerson&&action.participants===2)continue;
   if(action.participants===2&&!companionActors().user?.group.visible)continue;
   const prerequisite=id==='vrma-ad2a5118837bfa67'?'自己先坐下':SEATED_TARGET_ACTIONS.has(id)?'自己先起身；对方先坐下':action.participants===2&&id!=='home-hug'?'双方先起身':id==='home-hug'?'双方坐或站，至少一方站着':'自己先起身';
   options.push({kind:'social',label:action.label,prerequisite,target:action.participants===2?'用户':'自己',data:{action:'home-model-social',id,kind:'social'}});
  }
  return options.map(a=>({...a,actor:'character',target:a.target||asset(room.items.find(i=>i.id===a.data.id)?.assetId)?.name||'当前家具',roomId:room.id,id:JSON.stringify([room.id,a.data.action,a.data.id,a.kind,a.data.station||a.data.seat||''])}));
 }
 function homeLifeDock(){return [['chat','聊聊','M4 5h16v11H9l-5 4V5z'],['journal','日常','M4 4h7l1 2 1-2h7v16h-7l-1 1-1-1H4z'],['pets','宠物',''],['more','我的家','M3 11l9-8 9 8M6 10v11h12V10']].map(([id,label,path])=>`<button data-action="life" data-panel="${id}">${id==='pets'?petIcon('paw'):`<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`}${label}</button>`).join('');}
 function getHomeScene(){if(!homeActionPlan&&!photoSession&&furnitureUser&&!conversation&&!companionIdle&&!companionTravel&&!companionPhone&&!companionRise&&!walking&&!seatChange&&!kitchenTask&&!visitorActivity&&!visitorSeat&&!visitorPlant&&!heldPlush&&elapsed>=visitorUntil&&Date.now()>=manualUntil)restoreFurnitureCharacter();return {romanticPartners:romanticPartners(primaryResidentId),perspective:firstPerson?'first-person':undefined,manualRevision,roomId:current().id,roomName:current().name,present:!!visitor&&(furnitureUser?furnitureUser.group.visible:resident.visible)&&!edit&&!overview,busy:roomLoading||!!companionGesture||!!homeActionPlan||!!photoSession||!!companionPhone||!!companionRise||!!companionTravel||!!conversation||!!socialRuntime?.active||(furnitureUser?!!furnitureUser.parkedActivity?.activity:Date.now()<manualUntil||!!walking||!!seatChange||!!kitchenTask||!!visitorActivity||elapsed<visitorUntil),activity:furnitureUser?(furnitureUser.parkedActivity?.activity?.label||(furnitureUser.parkedSeat?.bed?'躺着休息':furnitureUser.parkedSeat?'坐着':'安静待着')):visitorActivity?.label||kitchenTask?.kind||(visitorSeat?.bed?(BED_LEISURE.find(([id])=>id===visitorSeat.bedMode)?.[1]||'休息'):visitorSeat?'坐着':'安静待着'),furniture:current().items.filter(i=>!i.stored).map(i=>({id:i.id,name:asset(i.assetId)?.name||i.assetId})),actions:homeActionOptions().map(({data,...a})=>a)};}
 function performHomeAction(id,source='model',replyTo){if(photoSession)return 'unavailable';
  if(source==='model')cancelCompanionAction();
  if(furnitureUser&&source==='local')return 'unavailable';
  restoreFurnitureCharacter();
  if(source==='local'&&(socialReplyBusy||Date.now()<manualUntil||state.autonomy===false||getHomeScene().busy))return 'unavailable';
  const option=homeActionOptions().find(a=>a.id===id);if(!option)return 'unavailable';
  if(source==='model')modelReplyTo=replyTo;
  if(option.data.action==='home-model-social'){if(source!=='model')return 'unavailable';conversation=null;void playSocial(option.data.id,primaryResidentId,socialActions[option.data.id].participants===2?'user':undefined,source,replyTo).then(ok=>{if(!ok)notify('当前空间无法完成这次互动',true);}).catch(e=>notify(e.message||'这个动作暂时无法执行',true));return 'pending';}
  autonomousRevision=source==='local'?manualRevision:null;
  const count=journal.length;runAction({...option.data,recordSource:source});
  return journal.length>count?'started':walking||seatChange?'pending':'unavailable';
 }
 // One owner for a model plan. Posture prerequisites finish before the next action starts.
 async function performHomeActions(ids,replyTo,signal){
  if(!Array.isArray(ids)||!ids.length||ids.length>8||photoSession||suspended)return 'unavailable';
  const plan={room:current().id};homeActionPlan=plan;cancelCompanionAction();stopSocial();conversation=null;
  const valid=()=>!signal?.aborted&&homeActionPlan===plan&&!destroyed&&!suspended&&!edit&&current().id===plan.room&&manualControl!==primaryResidentId&&!!companionActors().person.group.visible;
  const wait=async(done)=>{let ticks=0;while(valid()){if(!photoSession&&done())return true;await new Promise(resolve=>setTimeout(resolve,80));if(!photoSession&&++ticks>1500)return false;}return false;};
  const settled=()=>!walking&&!seatChange&&!kitchenTask&&!socialRuntime?.active&&elapsed>=visitorUntil;
  const activate=actor=>actor==='user'?useFurnitureUser():(restoreFurnitureCharacter(),true);
  const rise=async(actor='character')=>{
   if(!activate(actor))return false;if(!visitorSeat)return true;
   // A blocked exit is a failure, not permission to snap the actor off the furniture.
   if(!beginSeatChange(true))return false;
   visitorActivity=null;gamingEffects.clear();bathroomEffects.clear();kitchenEffects.updateMeal(null,0);
   if(!await wait(()=>!seatChange))return false;
   recordHomeActivity('起身','model');return !visitorSeat;
  };
  const sit=async(selected,actor='character')=>{
   if(!activate(actor))return false;
   if(visitorSeat&&!visitorSeat.bed&&(!selected||visitorSeat.itemId===selected.data.id&&visitorSeat.seatId===selected.data.seat))return true;if(!await rise(actor))return false;
   const occupied=(furnitureUser||socialEntries.find(e=>e.id==='user'))?.parkedSeat;
   const seats=roomSeats(current(),catalog).filter(seat=>!occupied||seat.itemId!==occupied.itemId||seat.seatId!==occupied.seatId).map(seat=>({kind:'sit',data:{action:'chibi-sit',id:seat.itemId,seat:seat.seatId}}));
   const option=(selected?[selected]:seats).filter(a=>a.kind==='sit').map(a=>({a,pose:seatTransform(placementRoom(),catalog,{roomId:current().id,itemId:a.data.id,seatId:a.data.seat},true)})).filter(v=>v.pose).sort((a,b)=>Math.hypot(a.pose.position[0]-resident.position.x,a.pose.position[2]-resident.position.z)-Math.hypot(b.pose.position[0]-resident.position.x,b.pose.position[2]-resident.position.z))[0];
   if(!option)return false;
   const offset=[current().x*ROOM_STEP.x,current().z*ROOM_STEP.z],start=[resident.position.x+offset[0],resident.position.z+offset[1]],map=residentWalkMap(start);
   const front=seatEntry(option.pose,{free:(x,z)=>map.free(x,z)&&!!findWalkPath(map,start,[x,z])},offset);
   if(!front||!walkTo([front[0]+current().x*ROOM_STEP.x,front[2]+current().z*ROOM_STEP.z]))return false;
   if(!await wait(()=>!walking))return false;
   runAction({...option.a.data,recordSource:'model'});
   return await wait(()=>!seatChange)&&!!visitorSeat&&!visitorSeat.bed;
  };
  try{
   restoreFurnitureCharacter();modelReplyTo=replyTo;
   for(const id of ids){
    if(!valid())return 'cancelled';
    if(!await wait(()=>!walking&&!seatChange))return valid()?'unavailable':'cancelled';
    restoreFurnitureCharacter();const option=homeActionOptions().find(a=>a.id===id);if(!option)return 'unavailable';
    const d=option.data;
    if(d.action==='home-model-social'){
     const participants=socialActions[d.id].participants;
     if(participants===2){
      if(SEATED_TARGET_ACTIONS.has(d.id)){if(!await sit(undefined,'user'))return 'unavailable';}
      else if(d.id!=='home-hug'||getResidentPosture('user')==='lying'){if(!await rise('user'))return 'unavailable';}
      restoreFurnitureCharacter();
     }
     const target=getResidentPosture('user');
     const required=d.id==='vrma-ad2a5118837bfa67'?'seated':d.id==='home-hug'&&getResidentPosture(primaryResidentId)==='seated'&&target==='standing'?'seated':'standing';
     if(!(required==='seated'?await sit():await rise()))return 'unavailable';
     if(!socialPostureAllowed(d.id,getResidentPosture(primaryResidentId),target,participants))return 'unavailable';
     if(!valid())return 'cancelled';
     if(!await playSocial(d.id,primaryResidentId,participants===2?'user':undefined,'model',replyTo))return 'unavailable';
    }else if(d.action==='chibi-sit'){
     if(!await sit(option))return 'unavailable';
    }else if(d.action==='chibi-stand'){
     if(!await rise())return 'unavailable';
    }else{
     const sameSeat=visitorSeat?.itemId===d.id&&visitorSeat?.seatId===d.seat;
     if(visitorSeat&&!sameSeat&&!await rise())return 'unavailable';
     if(isBedLeisure(d.mode)&&(!sameSeat||!visitorSeat?.bed)){
      runAction({...d,mode:undefined,recordSource:'model'});
      if(!await wait(()=>!walking&&!seatChange)||!visitorSeat?.bed||visitorSeat.itemId!==d.id||visitorSeat.seatId!==d.seat)return 'unavailable';
     }
     if(!valid())return 'cancelled';
     const before=journal.length;runAction({...d,recordSource:'model'});
     if(isBedLeisure(d.mode))visitorUntil=Math.max(visitorUntil,elapsed+8);
     if(journal.length===before&&!walking&&!seatChange)return 'unavailable';
    }
    if(!await wait(settled))return valid()?'unavailable':'cancelled';
    if(d.action==='chibi-bed'&&(!visitorSeat?.bed||visitorSeat.itemId!==d.id||visitorSeat.seatId!==d.seat))return 'unavailable';
    // Furniture rest persists; the next action will perform its own explicit rise if needed.
   }
   return 'completed';
  }catch(error){notify(error.message||'动作计划暂时无法完成',true);return 'unavailable';}
  finally{if(homeActionPlan===plan){homeActionPlan=null;if(signal?.aborted){stopWalking();stopSocial();}}}
 }
 function finishAutonomousAction(){
  const canStop=autonomousRevision!==null&&autonomousRevision===manualRevision;autonomousRevision=null;if(!canStop)return;
  if(isBathAction(visitorActivity?.kind))finishBathroom();
  runAction({action:'chibi-stand'});
 }
 function updateRecords(records){journal=clone(records);persist();}
 function recordHomeActivity(label,source='user',actor=furnitureUser?'user':'character'){
  if(!resident.visible||activeComparisonId||!label)return;
  const room=current(),focus=visitorActivity?.itemId||visitorSeat?.itemId||visitorPlant?.itemId||kitchenTask?.itemId||heldPlush?.itemId,target=focus&&asset(room.items.find(i=>i.id===focus)?.assetId)?.name;journal.push(makeHomeRecord({kind:'action',source,replyTo:source==='model'?modelReplyTo:undefined,actor,text:`${actor==='user'?(socialEntries.find(e=>e.id==='user'||e===furnitureUser)?.label||'你'):ownerName}开始${String(label).slice(0,100)}${target?'（'+target+'）':''}`,roomId:room.id,roomName:room.name}));persist();
 }
 function startDeskActivity(next){
  visitorActivity=next;visitorSeat=next.seat;visitorMotion=next.kind;visitorStart=elapsed;visitorUntil=elapsed+furnitureActivitySeconds(next.kind,next.duration||12);visitorLocation=null;
  placeVisitor();animateVisitor(0);recordHomeActivity(next.label,next.recordSource);message=next.label+'中';dirty=true;wake();renderUI();
 }
 function approachDeskActivity(next){
  if(visitorSeat?.itemId===next.seat.itemId&&visitorSeat?.seatId===next.seat.seatId&&!seatChange){stopWalking();startDeskActivity(next);return;}
  const transform=seatTransform(placementRoom(),catalog,next.seat,true),r=current(),offset=[r.x*ROOM_STEP.x,r.z*ROOM_STEP.z],map=navMap();
  const start=[resident.position.x+offset[0],resident.position.z+offset[1]],candidates=[];
  // Approach from either side: the front of a computer chair is occupied by its desk.
  for(const side of [-1,1])for(const diagonal of [0,.20])for(const distance of [.9,1.1,1.3,1.5,1.8,2]){
   const a=transform.rotation+side*Math.PI*(.5+diagonal),p=[transform.position[0]+Math.sin(a)*distance,.18,transform.position[2]+Math.cos(a)*distance];
   if(!map.free(p[0]+offset[0],p[2]+offset[1]))continue;
   const path=findWalkPath(map,start,[p[0]+offset[0],p[2]+offset[1]]);if(path)candidates.push({p,length:path.reduce((sum,v,i)=>sum+(i?Math.hypot(v[0]-path[i-1][0],v[1]-path[i-1][1]):0),0)});
  }
  candidates.sort((a,b)=>a.length-b.length);const front=candidates[0]?.p;
  if(!front){notify('椅子旁没有能走到的空位，先留一点坐下的空间',true);return;}
  if(!walkTo([front[0]+offset[0],front[2]+offset[1]]))return;
  walking.arrived=()=>{
   const currentActivity=activities().find(a=>a.itemId===next.itemId&&a.kind===next.kind&&a.stationId===next.stationId&&!a.reason);if(!currentActivity)return;currentActivity.recordSource=next.recordSource;
   visitorLocation=null;visitorSeat=currentActivity.seat;visitorMotion='idle';
   if(beginSeatChange(false,front)){seatChange.pendingActivity=currentActivity;message='先坐好，再'+currentActivity.label;}
   else startDeskActivity(currentActivity);
  };
  notify('走到座椅旁');
 }
 function finishBathroom(){
  const front=visitorActivity?.bathJourney?.front;if(!front)return;
  resident.position.fromArray(front);visitorLocation={x:front[0]+current().x*ROOM_STEP.x,z:front[2]+current().z*ROOM_STEP.z,level:current().level};
  visitorActivity=null;visitorSeat=null;visitorMotion='idle';visitorUntil=0;bathroomEffects.clear();visitor?.animate(0,'idle');
 }
 function approachBathroom(next){
  stopWalking();const item=current().items.find(i=>i.id===next.itemId);if(!item)return;
  const map=navMap(),ox=current().x*ROOM_STEP.x,oz=current().z*ROOM_STEP.z,start=[resident.position.x+ox,resident.position.z+oz];
  const front=bathroomEntryCandidates(item,next.kind).find(p=>map.free(p[0]+ox,p[2]+oz)&&findWalkPath(map,start,[p[0]+ox,p[2]+oz]));
  if(!front){notify('家具前没有能走到的空位，先留一点进出的空间',true);return;}
  if(!walkTo([front[0]+ox,front[2]+oz]))return;
  walking.arrived=()=>{
   const currentActivity=activities().find(a=>a.itemId===next.itemId&&a.kind===next.kind&&a.stationId===next.stationId&&!a.reason);if(!currentActivity)return;
   visitorActivity={...currentActivity,recordSource:next.recordSource,bathJourney:createBathroomJourney(currentActivity,front,resident.rotation.y)};recordHomeActivity(currentActivity.label,next.recordSource);
   visitorSeat=null;visitorLocation=null;visitorMotion=next.kind;visitorStart=elapsed;visitorUntil=elapsed+currentActivity.duration+8;message='准备'+next.label;
  };message='走过去'+next.label;
 }
 function approachBed(bed,source='user'){
  stopWalking();
  gamingEffects.clear();kitchenEffects.updateMeal(null,0);
  if(visitorSeat||visitorActivity||visitorPlant){visitorSeat=null;visitorActivity=null;visitorPlant=null;visitorLocation=null;visitorMotion='idle';placeVisitor();}
  const transform=body2BedTransform(seatTransform(placementRoom(),catalog,bed,true),visitor.bedHeadToHip,visitor.bedHipHeight),r=current(),offset=[r.x*ROOM_STEP.x,r.z*ROOM_STEP.z];
  const start=[resident.position.x+offset[0],resident.position.z+offset[1]];
  // A free endpoint alone is not enough: its side of the bed must be reachable.
  const map=residentWalkMap(start);
  const front=bedEntry(transform,{free:(x,z)=>map.free(x,z)&&!!findWalkPath(map,start,[x,z])},offset);
  if(!front){notify('床边没有能走到的空位，先给床边留一点空间',true);return;}
  if(!walkTo([front[0]+offset[0],front[2]+offset[1]]))return;
  walking.bed=true;
  walking.arrived=()=>{
   if(current().id!==bed.roomId||!roomBeds(current(),catalog).some(s=>s.itemId===bed.itemId&&s.seatId===bed.seatId))return;
   visitorLocation=null;visitorSeat=bed;visitorMotion=bed.bedMode?'idle':'sleep';beginSeatChange(false,front);recordHomeActivity(BED_LEISURE.find(([id])=>id===bed.bedMode)?.[1]||'上床休息',source);message='坐稳床沿，再慢慢躺下';
  };
  notify('走到床边，准备休息');
 }
 function showWalkFeedback(target,status){
  const origin=[current().x*ROOM_STEP.x,current().z*ROOM_STEP.z],x=target[0]-origin[0],z=target[1]-origin[1];
  // Raise the marker above the actual rug surface, including imported flat rugs.
  const rugs=objects.filter(o=>{const owner=state.rooms.find(r=>r.id===o.userData.roomId),i=owner?.items.find(i=>i.id===o.userData.itemId);return owner?.level===current().level&&asset(i?.assetId)?.surface==='rug'&&isVisible(o);});
  scene.updateMatrixWorld(true);
  const ray=new THREE.Raycaster(new THREE.Vector3(x,5,z),new THREE.Vector3(0,-1,0));
  const surface=ray.intersectObjects(rugs,true).find(h=>isVisible(h.object));
  walkFeedback.show([target[0],Math.max(.18,surface?.point.y??.18)+.035,target[1]],status,elapsed);
  dirty=true;wake();
 }
 function walkTo(target,{targetRadius=0,feedback=false}={}){
  // Only the explicit get-up action can release a seated/lying resident.
  if(visitorSeat||seatChange)return false;
  if(feedback&&!furnitureUser){manualUntil=Date.now()+6000;manualRevision++;}
  stopWalking();
  if(!visitor||!resident.visible)return false;
  if(visitorSeat||visitorPlant||visitorActivity){visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorSeat=null;visitorPlant=null;visitorLocation={x:resident.position.x+current().x*ROOM_STEP.x,z:resident.position.z+current().z*ROOM_STEP.z,level:current().level};}
  const start=[resident.position.x+current().x*ROOM_STEP.x,resident.position.z+current().z*ROOM_STEP.z],route=planResidentWalk(navMap(),nearbyResidents(),start,target,{targetRadius});
  if(!route){if(feedback)showWalkFeedback(target,'blocked');notify('这边暂时没有通路，试试旁边的空地',true);return false;}
  const {path,passResidents}=route;
  edit=false;overview=false;selected=null;panel=null;visitorMotion='walk';visitorStart=elapsed;walking={path,passResidents,index:1,last:elapsed,recordWalk:feedback};
  if(feedback)showWalkFeedback(path[path.length-1],'walking');
  visitorLocation={x:start[0],z:start[1],level:current().level};message='出发！';error=false;updateSelection();dirty=true;wake();renderUI();return true;
 }
 function nearbyResidents(){const r=current();return socialEntries.filter(e=>e.group.visible).map(e=>[e.group.position.x+r.x*ROOM_STEP.x,e.group.position.z+r.z*ROOM_STEP.z]);}
 function residentWalkMap(start){return withResidents(navMap(),nearbyResidents(),start);}
 function updateWalk(){
  if(!walking)return;let remaining=Math.max(0,elapsed-walking.last)*(visitor?.walkSpeed??(visitor?.rig?1.05:1.45));walking.last=elapsed;
  while(walking&&walking.index<walking.path.length&&remaining>1e-6){const p=walking.path[walking.index],dx=p[0]-visitorLocation.x,dz=p[1]-visitorLocation.z,length=Math.hypot(dx,dz);
   // Replan when someone enters the route; a narrow passage may temporarily
   // overlap people, but never ends on them or moves/respawns the neighbour.
   const step=Math.min(length,remaining),next=[visitorLocation.x+(length?dx*step/length:0),visitorLocation.z+(length?dz*step/length:0)];
   const people=nearbyResidents(),blocked=walking.passResidents?!residentDestinationFree(walking.path.at(-1),people):residentBlocksStep([visitorLocation.x,visitorLocation.z],next,people);
   if(blocked){
    const route=planResidentWalk(navMap(),people,[visitorLocation.x,visitorLocation.z],walking.path.at(-1));
    if(route){Object.assign(walking,route,{index:1});continue;}
    resident.position.set(visitorLocation.x-current().x*ROOM_STEP.x,.18,visitorLocation.z-current().z*ROOM_STEP.z);stopWalking();notify('落脚处有人，试试旁边的空地');return;
   }
   if(length>.001)setResidentHeading(resident,Math.atan2(dx,dz));
   if(length>remaining){visitorLocation.x+=dx*remaining/length;visitorLocation.z+=dz*remaining/length;break;}
   visitorLocation.x=p[0];visitorLocation.z=p[1];remaining-=length;walking.index++;
  }
  const locationRoom=state.rooms.find(r=>r.level===visitorLocation.level&&Math.abs(visitorLocation.x-r.x*ROOM_STEP.x)<ROOM_HALF.x&&Math.abs(visitorLocation.z-r.z*ROOM_STEP.z)<ROOM_HALF.z);if(effectiveRoomScope()==='room'&&locationRoom&&locationRoom.id!==current().id){activateRoom(locationRoom);persist();rebuild();renderUI();}else if(locationRoom&&!detailedRoomIds.has(locationRoom.id))rebuild();
  resident.position.set(visitorLocation.x-current().x*ROOM_STEP.x,.18,visitorLocation.z-current().z*ROOM_STEP.z);
  if(walking.index>=walking.path.length){const arrived=walking.arrived,recordWalk=walking.recordWalk;stopWalking(true,true);walkFeedback.arrive(elapsed);visitorUntil=elapsed+.1;message='到啦';arrived?.();renderUI();}
  dirty=true;renderer.shadowMap.needsUpdate=true;
 }
 function kitchenLeg(task,station,stage){
  const start=[resident.position.x+current().x*ROOM_STEP.x,resident.position.z+current().z*ROOM_STEP.z],path=findWalkPath(navMap(),start,station.target);
  if(!path){cancelKitchen();visitorMotion='idle';notify('路线被挡住了，先把通道腾出来',true);return;}
  task.stage=stage;task.phaseStart=elapsed;visitorMotion='walk';visitorStart=elapsed;
  visitorLocation={x:start[0],z:start[1],level:current().level};
  walking={path,index:1,last:elapsed,arrived:()=>{
   if(kitchenTask!==task)return;
   setResidentHeading(resident,station.rotation);task.stage=stage==='approach'?(task.kind==='wash'?'pickup':'work'):stage==='toSink'?'work':'putback';
   if(task.stage==='work'&&!task.recorded){recordHomeActivity({coffee:'做咖啡',wash:'洗碗',cook:'煮饭'}[task.kind],task.recordSource);task.recorded=true;}task.phaseStart=elapsed;visitorStart=elapsed;visitorMotion=task.kind;visitorUntil=elapsed+15;message=task.stage==='pickup'?'拿好盘子':task.stage==='putback'?'把盘子放回去':({coffee:'咖啡萃取中',wash:'冲洗、擦擦盘子',cook:'慢慢搅拌，煮饭中'}[task.kind]);
  }};dirty=true;wake();
 }
 function updateKitchen(){
  const task=kitchenTask;if(!task)return;
  const room=state.rooms.find(r=>r.id===task.roomId);
  if(current().id!==task.roomId||edit||overview||kitchenFingerprint(room,room?.items.map(i=>i.id)||[])!==task.layoutFingerprint){stopWalking();visitorMotion='idle';message='厨房动作已停止';return;}
  const time=elapsed-task.phaseStart;
  if(task.stage==='pickup'&&time>=1.2){task.carrying=true;kitchenLeg(task,task.sink,'toSink');}
  else if(task.stage==='work'&&time>=furnitureActivitySeconds(task.kind)){
   if(task.kind==='wash')kitchenLeg(task,task.source,'return');
   else if(task.kind==='coffee'&&visitor?.rig){task.stage='sip';task.phaseStart=elapsed;visitorStart=elapsed;visitorUntil=elapsed+meshyMotions['coffee-drink'].duration;message='咖啡做好了，喝一口';renderUI();}
   else{message=task.kind==='coffee'?'咖啡做好啦':'饭煮好啦';cancelKitchen();visitorMotion='idle';visitorUntil=0;renderUI();}
  }else if(task.stage==='sip'&&time>=meshyMotions['coffee-drink'].duration){message='咖啡喝好啦';cancelKitchen();visitorMotion='idle';visitorUntil=0;renderUI();}
  else if(task.stage==='putback'&&time>=1.2){message='盘子洗干净，放回原处啦';cancelKitchen();visitorMotion='idle';visitorUntil=0;renderUI();}
 }
 function kitchenHandPositions(hands){
  resident.updateWorldMatrix(true,true);
  if(visitor?.rig)return ['R_hand','L_hand'].map(name=>resident.worldToLocal(visitor.rig.bones[name].getWorldPosition(new THREE.Vector3())).toArray());
  return hands.map(p=>p.map(v=>v*.7));
 }
 function updateDoors(){
  if(!state)return;
  for(const door of doors){const leaf=door.userData.doorLeaf,oldRotation=leaf.rotation.y,oldX=leaf.position.x,p=door.getWorldPosition(new THREE.Vector3()),near=!!visitor&&resident.visible&&Math.hypot(p.x-resident.position.x,p.z-resident.position.z)<2;
   if(door.userData.doorKind==='door')leaf.rotation.y=near?-Math.PI/2:0;
   if(door.userData.doorKind==='sliding')leaf.position.x=near?door.userData.doorWidth+.06:0;
   if(oldRotation!==leaf.rotation.y||oldX!==leaf.position.x)invalidateRoomShadows();
  }
 }
 const watering=createWateringEffect();resident.add(watering.root);
 const mat=new THREE.Mesh(new THREE.BoxGeometry(1.6,.025,3.5),new THREE.MeshStandardMaterial({color:'#697e69',roughness:1}));mat.name='portable-yoga-mat';mat.position.set(0,.01,-.45);mat.visible=false;resident.add(mat);
 const motions=[['yoga','瑜伽垫 · 13 卷腹'],['wave-alternate-1','08 挥手'],['wave-alternate-2','09 挥手'],['idle','站好'],['sleep','睡觉'],['angry','生气'],['dance','晃一晃']];
 function beginPetContact(pet,options={}){
  if(edit||overview||suspended||walking||socialRuntime?.active||visitorActivity||visitorSeat||kitchenTask||heldPlush||greeting)throw Error('先结束当前动作，再来陪小伙伴');
  const autonomous=options.source==='local',actorId=autonomous?primaryResidentId:'user';
  if(autonomous){if(furnitureUser||activeResidentId()!==primaryResidentId||state.autonomy===false||photoSession)throw Error('角色当前不能接近宠物');}
  else {manualControl='user';if(!useFurnitureUser()||activeResidentId()!=='user')throw Error('先邀请你的小人到房间里');}
  if(!visitor?.rig)throw Error('请使用家园骨骼形象来摸摸和抱起宠物');
  const person=visitor,group=resident,room=current(),ox=room.x*ROOM_STEP.x,oz=room.z*ROOM_STEP.z,map=navMap(),start=[group.position.x+ox,group.position.z+oz],choices=[];
  const angle=Math.atan2(group.position.x-pet.x,group.position.z-pet.z);
  for(const offset of [0,.5,-.5,1,-1,Math.PI]){
   const target=[pet.x+Math.sin(angle+offset)*.85+ox,pet.z+Math.cos(angle+offset)*.85+oz],path=findWalkPath(map,start,target);
   if(path)choices.push({target,length:path.reduce((n,p,i)=>n+(i?Math.hypot(p[0]-path[i-1][0],p[1]-path[i-1][1]):0),0)});
  }
  choices.sort((a,b)=>a.length-b.length);if(!choices.length||!walkTo(choices[0].target))throw Error('走不到它身边，先留一点空地');
  manual=false;
  return {visitor:person,group,walking:()=>!!walking,valid:()=>visitor===person&&activeResidentId()===actorId&&(!autonomous||state.autonomy!==false)&&!edit&&!overview&&!visitorActivity&&!visitorSeat&&!socialRuntime?.active&&!kitchenTask,
   face(point){setResidentHeading(group,Math.atan2(point[0]-group.position.x,point[2]-group.position.z));},
   stop(){if(visitor===person)stopWalking();},reset(keepActivity=false){person.animate(0,'idle');if(visitor===person){if(!keepActivity)visitorMotion='idle';dirty=true;wake();}}};
 }
 function animateVisitor(time){
  if(greeting?.clip){const t=elapsed-greeting.start,d=greeting.clip.duration;visitor.applySelectedFrame(sampleSelected(greeting.clip.actors[0],t),Math.max(0,Math.min(1,t/.35,(d-t)/.35)),visitorSeat?currentSeatPose()||{}:undefined);return;}
  if(seatedReaction){const time=elapsed-seatedReaction.start;if(time>=seatedReaction.clip.duration){seatedReaction=null;visitor.animate(0,'idle','seated',currentSeatPose());}else{const weight=Math.min(1,time/.3,(seatedReaction.clip.duration-time)/.3);visitor.applySelectedFrame(sampleSelected(seatedReaction.clip.actors[0],time),Math.max(0,weight),currentSeatPose()||{});}return;}
  if(socialRuntime?.active){const runtime=socialRuntime;runtime.advance(Math.max(0,elapsed-socialLast));socialLast=elapsed;if(!runtime.active){socialRuntime=null;visitorUntil=0;for(const e of socialEntries)e.settledRoom=current().id;visitorLocation={x:resident.position.x+current().x*ROOM_STEP.x,z:resident.position.z+current().z*ROOM_STEP.z,level:current().level};}return;}
  if(!furnitureUser&&animateConversation())return;
  updateKitchen();updateWalk();updateDoors();
  if(visitorMotion==='yoga'&&elapsed-visitorStart>=meshyMotions.yoga.duration*4){visitorMotion='idle';visitorUntil=0;message='运动好啦';renderUI();}
  mat.visible=!!visitor?.rig&&visitorMotion==='yoga'&&!edit&&!overview;
  let seatPose=null;
  if(seatChange){
   const f=seatChangePose(seatChange,elapsed-seatChange.start);
   resident.position.fromArray(f.position);setResidentHeading(resident,f.rotation??seatChange.rotation);
   seatPose=seatChange.pose==='bed'?{kind:'bed-change',hands:[],bedFootSurface:currentSeatPose()?.bedFootSurface,bedFrom:seatChange.bedFrom,bedFromTime:seatChange.bedFromTime,bedTime:elapsed-seatChange.start,bedWeight:f.weight,bedRecline:f.recline,bedLegLift:f.legLift,bedStep:f.stepping,...(f.clipBlend>0?{clip:'sleep',clipTime:f.recline*meshyMotions.sleep.duration,clipWeight:f.clipBlend}:{})}:{...currentSeatPose(),kind:'seat-change',hands:[],seatWeight:f.weight,seatLean:f.lean,seatFold:f.fold,seatSupport:f.support};
   renderer.shadowMap.needsUpdate=true;
   if(f.done){
    if(seatChange.rising){visitorSeat=null;visitorLocation={x:resident.position.x+current().x*ROOM_STEP.x,z:resident.position.z+current().z*ROOM_STEP.z,level:current().level};}
    const pendingActivity=seatChange.pendingActivity;visitorMotion=seatChange.pose==='bed'&&!seatChange.rising&&!visitorSeat?.bedMode?'sleep':'idle';if(visitorSeat?.bed)visitorSeat.modeStart=elapsed;seatChange=null;
    if(pendingActivity){startDeskActivity(pendingActivity);seatPose=null;time=0;}renderUI();
   }
  }
  if(kitchenTask){
   const working=['work','pickup','putback'].includes(kitchenTask.stage);
   kitchenTask.lift=!visitor?.rig&&working?.58:0;
   resident.position.y=.18+kitchenTask.lift;
  }
  let bathPose=null;
  if(visitorActivity?.bathJourney){const f=bathroomJourneyFrame(visitorActivity.bathJourney,elapsed-visitorStart);resident.position.fromArray(f.position);setResidentHeading(resident,f.rotation);if(visitorActivity.bathPhase!==f.phase){message=f.phase==='work'?visitorActivity.label+'中':f.phase==='exit'?'慢慢起身，回到地垫上':'准备'+visitorActivity.label;visitorActivity.bathPhase=f.phase;renderUI();}visitorActivity.bathTime=f.time;bathPose={...visitorActivity,seatWeight:f.seatWeight,bathLegLift:f.legLift};if(f.done){finishBathroom();bathPose=null;message='好啦，清清爽爽！';renderUI();}}
  const journey=visitorActivity?.journey;
  let poseTime=bathPose?visitorActivity.bathTime:visitorMotion==='yoga'?elapsed-visitorStart:time;
  if(journey){
   const f=mirrorJourneyFrame(journey,reducedMotion?journey.duration:time);
   resident.position.fromArray(f.position);setResidentHeading(resident,f.rotation);
   visitorMotion=f.motion;poseTime=f.time;renderer.shadowMap.needsUpdate=true;
   const stage=f.destination+f.round;
   if(visitorActivity.journeyStage!==stage){visitorActivity.journeyStage=stage;message=f.destination==='wardrobe'?(f.teleported?'通路不够，瞬移到衣柜挑衣服':'去衣柜挑一套衣服'):'回镜子前看看搭配';renderUI();}
   if(f.done){visitorActivity=null;visitorMotion='idle';visitorUntil=0;message='搭配好啦！';renderUI();}
  }
  if(visitorPlant&&time>=4.4){visitorPlant=null;visitorMotion='idle';renderUI();}
  if(visitorActivity&&!isSustainedFurnitureActivity(visitorActivity.kind)&&!visitorActivity.bathJourney&&!journey&&time>=furnitureActivitySeconds(visitorActivity.kind,visitorActivity.duration||12)){const bathing=isBathAction(visitorActivity.kind);if(bathing){bathroomEffects.clear();visitorActivity=null;visitorSeat=null;visitorMotion='idle';visitorUntil=0;placeVisitor();message='好啦，清清爽爽！';renderUI();}else{message=visitorActivity.kind==='eat'?'吃好啦，坐着歇一会儿':visitorActivity.kind==='mirror-admire'?'今天也很可爱呢':visitorActivity.kind==='mirror-outfit'?'搭配好啦，满意地转个身':'这一局结束啦';visitorActivity=null;visitorMotion='idle';visitorUntil=0;renderUI();}}
  if(heldPlush&&visitorMotion!=='hug')putPlushBack();
  const heldAsset=heldPlush&&asset(current().items.find(i=>i.id===heldPlush.itemId)?.assetId),hug=heldAsset&&(visitor?.rig?body2PlushPose(heldAsset,time,resident.worldToLocal(visitor.rig.bones.chest.getWorldPosition(new THREE.Vector3())).y):plushPose(heldAsset,time));
  if(hug&&heldMesh)heldMesh.position.fromArray(hug.position);
  const workHands=kitchenTask?kitchenHands(kitchenTask.kind,elapsed-kitchenTask.phaseStart,kitchenTask.stage!=='work'):null;
  const workPose=workHands&&kitchenTask.stage!=='approach'?{kind:kitchenTask.kind,hands:workHands,carrying:kitchenTask.stage!=='work',...(kitchenTask.stage==='sip'?{clip:'coffee-drink',clipTime:elapsed-kitchenTask.phaseStart}:{})}:null;
  const petPose=petSystem?.contactPose();
  if(petPose&&petPose.actorId===activeResidentId())visitor.animate(petPose.time,walking?'walk':'idle','standing',petPose.activity);
  else visitor?.animate(reducedMotion&&visitorMotion==='rhythm'?1:poseTime,bathPose&&bathPose.bathPhase!=='work'&&bathPose.posture!=='seated'?'walk':visitorMotion,visitorActivity?.posture||(visitorSeat?.bed?'lying':visitorSeat?'seated':'standing'),seatPose||bathPose||workPose||(hug?{...currentSeatPose(),kind:'hug',hands:hug.hands}:visitorMotion==='walk'?null:visitorActivity?{...currentSeatPose(),...visitorActivity}:currentSeatPose()));
  petSystem?.placeHeld();
  kitchenWork.update(kitchenTask,reducedMotion?1:elapsed-(kitchenTask?.phaseStart||0),workHands?(visitor?.rig&&kitchenTask?.kind==='coffee'?kitchenHandPositions(workHands).reverse():kitchenHandPositions(workHands)):[],visitor?.rig&&kitchenTask?.kind==='coffee'?coffeeGrip(resident,visitor.rig):null);
  gamingEffects.update(objects,visitorActivity,time);kitchenEffects.updateMeal(visitorActivity,time,visitor?.rig&&visitorActivity?.kind==='eat'?diningGrip(resident,visitor.rig):null);
  watering.update(time,visitorPlant?.spot,visitorPlant&&visitor?.rig?kitchenHandPositions([]):null);
 }
 let residentRoom,lastScheduleRoom,ownerName='TA',greeted=false,greeting=null,tapTimer=0,cameraArrival=null,cameraMenu=false,greetingGeneration=0;
 function setResidentRoom(id,force=false){if(force)lastScheduleRoom=undefined;if(photoSession){photoPendingRoom={id};return;}
  if(id===undefined){lastScheduleRoom=undefined;if(residentRoom===undefined)residentRoom=current().id;renderUI();return;}
  if(lastScheduleRoom===id)return;lastScheduleRoom=id;
  restoreFurnitureCharacter();residentRoom=id;stopWalking();stopSocial();visitorLocation=null;visitorSeat=null;visitorActivity=null;visitorPlant=null;visitorMotion='idle';
  if((firstPerson||!greeted)&&id&&state.rooms.some(r=>r.id===id)){activateRoom(state.rooms.find(r=>r.id===id));rebuild();}
  placeVisitor();placeSocialVisitors();persist();dirty=true;wake();renderUI();
 }
 function summonAll(){summonOwner();petSystem?.summon();portraitSignature='';syncPortraitRail();}
 function summonOwner(){restoreFurnitureCharacter();stopWalking();stopSocial();residentRoom=current().id;visitorLocation=null;visitorSeat=null;visitorActivity=null;placeVisitor();placeSocialVisitors();manualRevision++;manualUntil=Date.now()+90000;if(resident.visible){journal.push(makeHomeRecord({kind:'presence',source:'user',actor:'user',text:(socialEntries.find(e=>e.id==='user')?.label||'你')+'把'+ownerName+'叫到了'+current().name,roomId:current().id,roomName:current().name}));persist();}else notify('这间房暂时没有站得下的位置',true);dirty=true;wake();renderUI();return true;}
 async function greetOwner(action='vrma-8bd33d84e90c0243'){if(firstPerson||photoSession||greeted||!visitor||!resident.visible||residentRoom===null)return;greeted=true;const token=++greetingGeneration;let clip=null;try{if(!action.startsWith('wave-'))clip=await loadSelectedMotion(action);}catch{greeted=false;return;}if(destroyed||token!==greetingGeneration)return;restoreFurnitureCharacter();const restoreWide=onMenu&&roomWide,old=residentExpressions.get(primaryResidentId),from={position:camera.position.clone(),target:controls.target.clone(),zoom:camera.zoom};focusResident(primaryResidentId,false);const offset=camera.position.clone().sub(controls.target);offset.y=Math.hypot(offset.x,offset.z)*.075;camera.position.copy(controls.target).add(offset);controls.update();focusResident(primaryResidentId,false);camera.zoom=Math.max(controls.minZoom,camera.zoom*.82);camera.updateProjectionMatrix();const greetingHeading=Math.atan2(camera.position.x-resident.position.x,camera.position.z-resident.position.z);cameraArrival={from,to:{position:camera.position.clone(),target:controls.target.clone(),zoom:camera.zoom},start:elapsed};camera.position.copy(from.position);controls.target.copy(from.target);camera.zoom=from.zoom;camera.updateProjectionMatrix();setResidentHeading(resident,greetingHeading);visitorMotion=clip?'idle':action;visitorStart=elapsed+1.1;visitorUntil=visitorStart+(clip?.duration||3.8);manualUntil=Date.now()+(clip?.duration||3.8)*1000+2100;setResidentExpression(primaryResidentId,{eyes:'happy',blink:false});greeting={until:visitorUntil,start:visitorStart,clip,old,restoreWide};dirty=true;wake();}

 function placeVisitor(){
  if(!furnitureUser&&residentRoom!==undefined&&(residentRoom===null||current().id!==residentRoom)){resident.visible=false;return;}
  if(socialRuntime){if(edit||overview||current().id!==socialRoom)stopSocial();else if(socialRuntime.active)return;}
  if(kitchenTask){const room=state.rooms.find(r=>r.id===kitchenTask.roomId);if(current().id!==kitchenTask.roomId||edit||overview||kitchenFingerprint(room,room?.items.map(i=>i.id)||[])!==kitchenTask.layoutFingerprint)stopWalking();}
  resident.visible=!!visitor&&!overview;
  if(!visitor||!state)return;
  if(seatChange){
   if(edit||overview||!resolvedVisitorSeat())seatChange=null;
   else{const f=seatChangePose(seatChange,elapsed-seatChange.start);resident.position.fromArray(f.position);setResidentHeading(resident,f.rotation??seatChange.rotation);return;}
  }
  if((isMirrorAction(visitorActivity?.kind)||isBathAction(visitorActivity?.kind))&&(edit||visitorActivity.roomId!==current().id))stopMirror();
  const focusItem=visitorActivity?.itemId||visitorSeat?.itemId||visitorPlant?.itemId,focusRoom=focusItem&&state.rooms.find(r=>r.items.some(i=>i.id===focusItem));
  if(!overview&&effectiveRoomScope()==='room'&&focusRoom&&focusRoom.id!==current().id){visitorSeat=null;visitorPlant=null;visitorActivity=null;visitorMotion='idle';gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitor.animate(0,'idle');}
  else if(!overview&&focusRoom&&focusRoom.level===current().level&&!detailedRoomIds.has(focusRoom.id)){rebuild();return;}

  if(visitorActivity){const next=activities().find(a=>a.itemId===visitorActivity.itemId&&a.kind===visitorActivity.kind&&a.stationId===visitorActivity.stationId&&!a.reason&&a.roomId===visitorActivity.roomId);if(next){if(visitorActivity.bathJourney){if(JSON.stringify(next.position)===JSON.stringify(visitorActivity.position)&&next.rotation===visitorActivity.rotation)return;finishBathroom();placeVisitor();return;}if(visitorActivity.journey){if(next.wardrobeId===visitorActivity.wardrobeId)return;stopMirror();return;}visitorActivity=next;visitorSeat=next.seat;resident.position.fromArray(next.position);setResidentHeading(resident,next.rotation);kitchenEffects.updateMeal(next,reducedMotion?1:elapsed-visitorStart);return;}if(visitorActivity.bathJourney)finishBathroom();visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorMotion='idle';visitor.animate(0,'idle',visitorSeat?.bed?'lying':visitorSeat?'seated':'standing',currentSeatPose());}
  // An accepted movement/social endpoint is authoritative; rechecking clearance here
  // can respawn someone when a neighbour or pose changes their footprint.
  if(visitorLocation&&visitorLocation.level===current().level&&!visitorSeat&&!visitorPlant){const map=navMap(),{x,z}=visitorLocation;if(map.areas.some(a=>visibleRoomIds.has(a.roomId)&&x>=a.rect[0]&&x<=a.rect[2]&&z>=a.rect[1]&&z<=a.rect[3])){resident.position.set(x-current().x*ROOM_STEP.x,.18,z-current().z*ROOM_STEP.z);return;}}
  visitorLocation=null;
  if(visitorPlant){
   const spot=visitorPlant.roomId===current().id?wateringSpot(current(),catalog,visitorPlant.itemId,visitorClearance()):null;
   if(spot){visitorPlant.spot=spot;resident.position.fromArray(spot.position);setResidentHeading(resident,spot.rotation);watering.update(elapsed-visitorStart,spot,visitor?.rig?kitchenHandPositions([]):null);return;}
   visitorPlant=null;visitorMotion='idle';visitor.animate(0,'idle');
  }
  watering.root.visible=false;
  const seat=resolvedVisitorSeat();
  if(seat){resident.position.fromArray(seat.position);resident.position.y+=visitorSeat.bed ? seat.pose==='bed'?0:.34 :-(visitor.seatOffset??0);setResidentHeading(resident,seat.rotation);return;}
  if(visitorSeat){visitorSeat=null;visitorMotion='idle';visitor.animate(0,'idle');}
  setResidentHeading(resident,0);
  // Reserve the entire head footprint, and prefer open floor near the viewer.
  const map=navMap(),r=current();let spot=null;
  for(let z=ROOM_HALF.z-.85;z>=-ROOM_HALF.z+.85&&!spot;z-=.2)for(const x of Array.from({length:Math.ceil((ROOM_HALF.x-.85)/.4)*2-1},(_,k)=>k===0?0:Math.ceil(k/2)*.4*(k%2?1:-1)))if(map.free(x+r.x*ROOM_STEP.x,z+r.z*ROOM_STEP.z)){spot=[x,.18,z];break;}
  if(spot)resident.position.fromArray(spot);
  resident.visible=!!spot&&!overview;
 }
 function attachVisitor(next,{preservePose=false,keepPrevious=false}={}){
  stopSocial();for(const e of [...socialEntries])if(!next||!!e.visitor.rig!==!!next.rig)removeSocialResident(e.id);
  preservePose=!!(preservePose&&visitor&&next);
  if(!preservePose){
   cancelKitchen();closeInteraction();putPlushBack();bathroomEffects.clear();
   walking=null;seatChange=null;visitorLocation=null;visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);
   mat.visible=false;visitorPlant=null;visitorSeat=null;visitorMotion='idle';visitorStart=elapsed;visitorUntil=0;
  }
  if(!keepPrevious)visitor?.dispose();visitor=next;resident.clear();resident.add(watering.root,kitchenEffects.meal,plushRoot,kitchenWork.root,mat);
  if(visitor){resident.add(visitor.root);visitor.animate(0,'idle');headWidth=visitorFootprintWidth(visitor);}
  if(state){if(preservePose){animateVisitor(elapsed-visitorStart);if(residentFraming)focusResident();}else placeVisitor();dirty=true;wake();renderUI();}
 }
 function clearComparison(){
  for(const e of comparisonEntries)if(e.visitor!==visitor)e.visitor.dispose();
  comparisonRoot.clear();comparisonEntries=[];activeComparisonId=null;
 }
 function setVisitor(next,options){socialPlacementMap=null;restoreFurnitureCharacter();clearComparison();attachVisitor(next,options);}
 function setComparisonVisitors(entries,activeId=entries[0]?.id){
  if(entries.length!==2||new Set(entries.map(e=>e.id)).size!==2||new Set(entries.map(e=>e.visitor)).size!==2||!entries.some(e=>e.id===activeId))throw new Error('对照需要两只不同的小人及有效的当前角色');
  clearComparison();attachVisitor(null);
  comparisonEntries=entries.map(e=>{const group=new THREE.Group();group.visible=false;comparisonRoot.add(group);e.visitor.animate(0,'idle');return {...e,group,width:visitorFootprintWidth(e.visitor)};});
  setActiveComparisonVisitor(activeId);
 }
 function setActiveComparisonVisitor(id){
  const next=comparisonEntries.find(e=>e.id===id);if(!next)return false;if(activeComparisonId===id)return true;
  for(const e of comparisonEntries)e.group.visible=false;
  activeComparisonId=id;attachVisitor(next.visitor,{keepPrevious:true});
  for(const e of comparisonEntries)if(e.id!==id){e.group.add(e.visitor.root);e.visitor.animate(0,'idle');}
  placeComparisonVisitors();if(residentFraming)focusResident();message='正在测试：'+next.label;dirty=true;wake();renderUI();return true;
 }
 function setComparisonVisitorScale(id,multiplier){
  const entry=comparisonEntries.find(e=>e.id===id);if(!entry?.visitor.setScaleMultiplier||!Number.isFinite(multiplier))return false;
  if(id===activeComparisonId){
   stopWalking();
   if(!visitorSeat&&!visitorActivity&&!visitorPlant)visitorLocation={x:resident.position.x+current().x*ROOM_STEP.x,z:resident.position.z+current().z*ROOM_STEP.z,level:current().level};
  }
  entry.visitor.setScaleMultiplier(multiplier);entry.width=visitorFootprintWidth(entry.visitor);comparisonRevision++;
  if(id===activeComparisonId){headWidth=entry.width;placeVisitor();animateVisitor(elapsed-visitorStart);}
  placeComparisonVisitors();renderer.shadowMap.needsUpdate=true;dirty=true;wake();return true;
 }
 function previewComparisonWalk(enabled=true){
  if(!comparisonEntries.length||!visitor?.rig)return false;
  stopWalking();putPlushBack();visitorSeat=null;visitorActivity=null;visitorPlant=null;gamingEffects.clear();bathroomEffects.clear();kitchenEffects.updateMeal(null,0);
  visitorMotion=enabled?'walk':'idle';visitorStart=elapsed;visitorUntil=enabled?Infinity:0;edit=false;overview=false;selected=null;panel=null;
  placeVisitor();focusResident();visitorMotion=enabled?'walk':'idle';animateVisitor(0);message=enabled?'原地试看走路 · 点空地可实际走动':'走路试看已停止';dirty=true;wake();renderUI();return true;
 }
 function walkComparisonRoute(){
  if(!previewComparisonWalk(false))return false;
  const r=current(),start=[resident.position.x+r.x*ROOM_STEP.x,resident.position.z+r.z*ROOM_STEP.z],map=navMap();
  for(const distance of [1.6,1.2,2])for(const [x,z]of [[1,0],[-1,0],[0,-1],[0,1],[.7,-.7],[-.7,-.7]]){
   const target=[start[0]+x*distance,start[1]+z*distance];
   if(findWalkPath(map,start,target)){if(viewMode==='free'){camera.zoom=Math.min(camera.zoom,2);camera.updateProjectionMatrix();}return walkTo(target);}
  }
  notify('附近没有足够的通路，可以先原地试看',true);return false;
 }
 function placeComparisonVisitors(){
  if(!comparisonEntries.length||!state)return;
  const r=current(),map=walkingMap(state,r.level,catalog,{headWidth,...visitor?.navigation});
  // A comparison spectator must not occupy the mirror/wardrobe approach.
  const reserved=mirrorActivities(placementRoom(),catalog,{...visitorClearance(),headWidth,canStand:p=>map.free(p[0]+r.x*ROOM_STEP.x,p[2]+r.z*ROOM_STEP.z)}).filter(a=>!a.reason).flatMap(a=>a.wardrobePose?[a.position,a.wardrobePose.position]:[a.position]);
  for(const e of comparisonEntries){
   if(e.id===activeComparisonId){e.group.visible=false;continue;}
   if(e.revision!==comparisonRevision){e.map=walkingMap(state,r.level,catalog,{headWidth:e.width,...e.visitor.navigation});e.revision=comparisonRevision;}
   const point=comparisonSpot(e.map,{offset:[r.x*ROOM_STEP.x,r.z*ROOM_STEP.z],width:e.width,activeWidth:headWidth,active:resident.position.toArray(),preferred:e.group.visible?e.group.position.toArray():null,reserved});
   e.group.visible=!!point&&!overview&&resident.visible;if(point)e.group.position.fromArray(point);
  }
 }
 const selection=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({length:4},()=>new THREE.Vector3())),new THREE.LineBasicMaterial({color:0x9d80bd,transparent:true,opacity:.6,depthTest:false}));
 selection.setFromObject=o=>{const b=new THREE.Box3().setFromObject(o),p=selection.geometry.attributes.position,y=b.min.y+.025;[[b.min.x,b.min.z],[b.max.x,b.min.z],[b.max.x,b.max.z],[b.min.x,b.max.z]].forEach(([x,z],i)=>p.setXYZ(i,x,y,z));p.needsUpdate=true;selection.geometry.computeBoundingSphere()};selection.renderOrder=9;selection.visible=false;scene.add(selection);
 const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2(),plane=new THREE.Plane(),hit=new THREE.Vector3();
 const templates=new Map(),thumbs=new Map();let ribbonDoorTemplate=null,releasePackImages=()=>{};
 let furniturePackInstalled=false;
 const refreshFurniturePack=()=>{resourcePackStatus(resourcePacks.find(p=>p.id==='halloween-furniture')).then(status=>{if(destroyed)return;furniturePackInstalled=status.installed;if(state&&kit)renderUI();}).catch(()=>{});};
 const unsubscribeResourcePacks=subscribeResourcePacks(refreshFurniturePack);refreshFurniturePack();
 let roomLoading=false,loadRevision=0;
 function registerTemplate(root){const id=root.userData.assetId;if(!id)return;templates.set(id,root);const mats=[];root.traverse(o=>{if(o.isMesh)mats.push(...(Array.isArray(o.material)?o.material:[o.material]))});const names=furniturePaintMaterials(asset(id),mats.map(m=>m.name));paintTargets.set(id,names);defaultPaintColors.set(id,'#'+(mats.find(m=>names.includes(m.name))?.color.getHexString()||'b2a2cd'));const a=asset(id);if(a&&(a.daylight||id==='wooden_window')&&!a.wallOpening)a.wallOpening=inferWindowAperture(root);}
 const ensureAsset=createAssetQueue(async id=>{if(destroyed)throw Error('Room disposed');if(templates.has(id))return;const a=asset(id);if(!a?.url)throw Error('缺少家具模型：'+id);
   const loaded=await loadHomeGLTF(new URL(a.url+(a.revision?'?v='+encodeURIComponent(a.revision):''),assetBase).href,abort.signal),root=new THREE.Group();root.userData.assetId=a.id;
   if(destroyed){loaded.scene.traverse(o=>{if(o.isMesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material]){for(const value of Object.values(m))if(value?.isTexture)value.dispose();m.dispose();}}});return;}
   const model=loaded.scene;
   if(a.textureSource==='meshy-reference')model.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])for(const t of Object.values(m))if(t?.isTexture){t.generateMipmaps=false;t.minFilter=THREE.LinearFilter;t.needsUpdate=true;}});
   const bounds=new THREE.Box3().setFromObject(model),scale=a.size[0]/bounds.getSize(new THREE.Vector3()).x;
   model.scale.multiplyScalar(scale);bounds.setFromObject(model);const center=bounds.getCenter(new THREE.Vector3());model.position.sub(new THREE.Vector3(center.x,bounds.min.y,center.z));
   // Flat rugs have no thickness: keep their single face above the floor finish.
   if(a.surface==='rug'&&bounds.max.y-bounds.min.y<.001)model.position.y+=.026;
   root.add(model);kit.scene.add(root);
 registerTemplate(root);});
 function neededAssets(){const rooms=overview?state.rooms:displayRooms(state,current(),effectiveRoomScope());return [...new Set(rooms.flatMap(r=>r.items.filter(i=>!i.stored).map(i=>i.assetId)))].filter(id=>!templates.has(id));}
 function loadRoomAssets(ids){const revision=++loadRevision;roomLoading=true;let overlay=host.querySelector('.h3-loading');if(!overlay){overlay=document.createElement('div');overlay.className='h3-loading';host.append(overlay);}overlay.textContent='正在搬入这个房间的家具…';Promise.all(ids.map(ensureAsset)).then(()=>{if(destroyed||revision!==loadRevision)return;roomLoading=false;overlay.remove();rebuild();renderUI();lastTick=performance.now();wake();}).catch(e=>{if(destroyed||revision!==loadRevision)return;overlay.textContent='家具加载失败，点击重试';overlay.onclick=()=>{overlay.onclick=null;loadRoomAssets(neededAssets());};console.error(e);});}

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
  restoreFurnitureCharacter();
  if(viewMode==='free'&&!overview&&room.level===current().level){const [x,z]=roomOffset(room,current());camera.position.x-=x;camera.position.z-=z;controls.target.x-=x;controls.target.z-=z;controls.update();}
  state.activeRoomId=room.id;
 }
 const selectedOwner=()=>state.rooms.find(r=>r.items.some(i=>i.id===selected));
 const item=()=>{const owner=selectedOwner(),i=owner?.items.find(i=>i.id===selected);if(!i)return;const [x,z]=roomOffset(owner,current()),result={...i,x:i.x+x,z:i.z+z};return rotationPreview?.id===i.id?{...result,...rotationPreview}:result;};
 const placementRoom=()=>layoutRoom(state,current(),catalog);
 function objectPose(obj,i){const room=state.rooms.find(r=>r.id===obj.userData.roomId),[x,z]=roomOffset(room,current());obj.position.set(i.x-x,i.y,i.z-z);obj.rotation.y=i.rotation*Math.PI/180;}
 const assetIndex=new Map();const asset=id=>assetIndex.get(id);
 function notify(text,bad=false){message=text;error=bad;renderUI()}
 function persist(){
  if(petSystem)petSystem.life.attach();
  // All joined characters share the scene, even when the camera is in a
  // different room. Capture membership now, never when history is read later.
  if(onMenu)journal=stampHomeSceneRecords(journal,knownHomeRecords,{id:primaryResidentId,name:ownerName},
   [...socialEntries.map(entry=>({id:entry.id,name:entry.label})),{id:'user',name:residentPortraits.user?.label||'用户'}]);
  journal=assignHomeTurns(journal);state.records=journal;if(residentRoom!==undefined)state.residentRoomId=residentRoom;delete state.activityLog;
  saved=true;
  try{if(storageKey)localStorage.setItem(storageKey,JSON.stringify(state));const result=onChange?.(clone(state));if(result?.catch)result.catch(()=>{saved=false;notify('保存失败，当前布置仍保留在画面中，可导出备份',true)});}catch{saved=false;message='保存失败，请导出备份';error=true}
 }
 const restoredLifeSnapshots=new WeakSet();
 function restoreSavedLife(){
  petSystem?.contact.cancel(true,false);restoreFurnitureCharacter();cancelCompanionAction();stopSocial();
  journal=readHomeRecords(state);state.records=journal;
  residentRoom=state.residentRoomId===null?null:state.rooms.some(r=>r.id===state.residentRoomId)?state.residentRoomId:state.activeRoomId;
  lastScheduleRoom=undefined;visitorLocation=null;visitorSeat=null;visitorActivity=null;visitorPlant=null;visitorMotion='idle';
  petSystem?.life.restore(state.petLife);
 }
 function travelHistory(from,to){
  if(!from.length)return;
  const target=from.pop(),before=clone(state),restoreLife=restoredLifeSnapshots.has(target);
  if(restoreLife)restoredLifeSnapshots.add(before);
  to.push(before);state=target;stopWalking();visitorLocation=null;selected=null;panel=null;
  if(restoreLife)restoreSavedLife();
  persist();rebuild();renderUI();
 }
 function commit(mutator,{templateUpgrade=false,restoreLife=false}={}){
  const before=clone(state),selectionBefore=selected,panelBefore=panel,rotationBefore=rotationPreview;stopWalking();message='';error=false;
  try{mutator();const budgetError=phone&&!templateUpgrade&&phoneBudgetError(before,state,catalog);if(budgetError)throw Error(budgetError);if(!templateUpgrade){const spaceError=furnishingSpaceError(before,state,catalog,{headWidth,...visitor?.navigation});if(spaceError)throw Error(spaceError);}let unmounted=0;for(const r of state.rooms)for(const i of r.items){const a=asset(i.assetId);if(a?.surface==='wall'&&!i.stored&&wallPlacementError(i,a,r,catalog)){i.stored=true;unmounted++;}}if(unmounted)message='墙面变化，失去承托的挂墙物件已收纳，可撤销';if(restoreLife){restoreSavedLife();restoredLifeSnapshots.add(before);}undo.push(before);if(undo.length>40)undo.shift();redo=[];persist();rebuild();renderUI();return true;}catch(e){state=before;if(restoreLife&&restoredLifeSnapshots.has(before))restoreSavedLife();selected=selectionBefore;panel=panelBefore;rotationPreview=rotationBefore;rebuild();notify(e.message,true);return false;}
 }
 function applyColor(root,color,wall=false,id='',materialColors={}){
  root.traverse(o=>{if(!o.isMesh)return;const mats=Array.isArray(o.material)?o.material:[o.material];
   o.castShadow=asset(id)?.surface!=='rug'&&mats.every(m=>!m.transparent)&&!((asset(id)?.daylight||id==='wooden_window')&&mats.every(isWindowPane));o.receiveShadow=true;
   o.material=mats.map(m=>{
    const primary=paintTargets.get(id)||[];
    const paint=wall?((m.name==='cream'&&o.userData.wallPart!=='floor')?color.wall:colors.has(m.name)?color.trim:color.floor&&['wood','woodLight','cream'].includes(m.name)&&o.userData.wallPart==='floor'?color.floor:''):materialColors[m.name]||(color&&primary.includes(m.name)?color:'');
    const retro=furnitureStyle==='retro'&&!wall&&!asset(id)?.building&&asset(id)?.materialStyle!=='pbr';
    const sky=(id==='wooden_window'||asset(id)?.daylight===true)&&['glass','window-blue'].includes(m.name);
    const key=m.uuid+'/'+paint+'/'+retro+'/'+(sky?o.geometry.uuid:'');usedMaterials.add(key);let c=materialCache.get(key);
    if(!c){c=m.clone();if(retro)applyRetroFurniture(c,lightUniforms);if(paint)c.color.set(paint);if(asset(id)?.rugPattern)applyRugPattern(c,o.geometry,asset(id).rugPattern);if(sky)applyWindowSky(c,o.geometry,lightUniforms);if(c.transparent)c.depthWrite=false;materialCache.set(key,c)}
    return c});if(o.material.length===1)o.material=o.material[0];
  });
 }
 function instance(id,color,wall,materialColors){const template=templates.get(id);if(!template)throw Error('缺少家具模型：'+id);const obj=template.clone(true);applyColor(obj,color,wall,id,materialColors);obj.traverse(o=>{if(o.isMesh&&o!==obj&&!o.userData.animated&&!o.userData.gamingRole){o.updateMatrix();o.matrixAutoUpdate=false;}});return obj}
 function clearContent(){bathroomEffects.clear();gamingEffects.clear();kitchenEffects.clear();clearOutline();content.traverse(o=>{if(o.isMesh){if(o.geometry.userData.owned)o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])if(m.userData.owned)m.dispose()}});content.clear();objects=[];outlinedObjects=[];animated=[]}
 function syncInteriorPresentation(){
  const active=!!onMenu&&!edit&&!overview&&!roomWide&&wallView!=='dollhouse';
  interiorBackdrop.root.visible=active;
  for(const mesh of interiorBases)mesh.visible=!active;
  controls.minZoom=active?.85:.6;
  if(active&&camera.zoom<controls.minZoom){camera.zoom=controls.minZoom;camera.updateProjectionMatrix();}
 }
 let lastWallCamera='';
 function syncAutomaticWalls(){
  if(overview)return;
  const dx=camera.position.x-controls.target.x,dz=camera.position.z-controls.target.z;
  const cameraKey=[dx,dz,wallView,edit].join(':');if(cameraKey===lastWallCamera)return;lastWallCamera=cameraKey;
  let changed=false;
  for(const root of [content,interiorBackdrop.root])root.traverse(o=>{const edge=o.userData.boundaryEdge;if(!edge)return;const visible=wallView==='cutaway'&&!edit?automaticWallVisible(edge,dx,dz,o.visible):wallVisible(effectiveWallView(),edge);if(o.visible!==visible){o.visible=visible;changed=true;}});
  if(changed)invalidateRoomShadows();
 }
 let lastViewKey='',furnitureContextRoom=null,furnitureContextEditing=false;
 function rebuild(){
  // Furniture poses belong to the old room/layout, including the parked user after swapping control.
  if(furnitureContextRoom&&(furnitureContextRoom!==state.activeRoomId||edit&&!furnitureContextEditing)){
   // Walking through a doorway is also a room transition. Preserve locomotion when no furniture is active.
   if(edit||visitorSeat||visitorActivity||visitorPlant||seatChange||heldPlush){restoreFurnitureCharacter();cancelCompanionAction();resetFurnitureMotion();}
   for(const entry of socialEntries){entry.parkedSeat=null;entry.parkedPose=null;entry.parkedActivity=null;entry.settledRoom=null;entry.visitor.animate(0,'idle','standing');}
   parkedMealEffects?.dispose();parkedMealEffects=null;socialPlacementMap=null;
  }
  furnitureContextRoom=state.activeRoomId;furnitureContextEditing=edit;
  const missing=neededAssets();if(missing.length){loadRoomAssets(missing);return;}
  socialPlacementMap=null;lastWallCamera='';
  petSystem?.reconcile();
  comparisonRevision++;
  closeInteraction();
  finishes.begin();
  const shadowSize=quality==='eco'||phone||touch?512:lightBudget().shadowSize;
  if(key.shadow.mapSize.x!==shadowSize){key.shadow.map?.dispose();key.shadow.mapPass?.dispose();key.shadow.map=null;key.shadow.mapPass=null;key.shadow.mapSize.set(shadowSize,shadowSize);}
  clearContent();interiorBases=[];interiorBackdrop.update(current(),wallView,finishes.extendedFloor(current()));usedMaterials.clear();dirty=true;key.castShadow=lightBudget().keyShadow;key.shadow.needsUpdate=true;renderer.shadowMap.needsUpdate=true;const active=current();
  const visible=overview?state.rooms:displayRooms(state,active,effectiveRoomScope());visibleRoomIds=new Set(visible.map(r=>r.id));doors=[];
  const detailed=new Set((overview?visible.slice(0,detailBudget):[...visible.filter(r=>r.id===active.id||r.items.some(i=>[visitorActivity?.itemId,visitorSeat?.itemId,visitorPlant?.itemId].includes(i.id))||visitorLocation&&r.level===visitorLocation.level&&Math.abs(visitorLocation.x-r.x*ROOM_STEP.x)<ROOM_HALF.x&&Math.abs(visitorLocation.z-r.z*ROOM_STEP.z)<ROOM_HALF.z),...visible.slice(0,Math.max(phone?1:3,detailBudget))]).map(r=>r.id));detailedRoomIds=detailed;
  for(const r of visible){
   const room=new THREE.Group();room.userData.roomId=r.id;
   const [dx,dz]=displayOffset(r,active);room.position.set(dx,overview?(r.level-active.level)*5.08:0,dz);
   const shell=detailed.has(r.id)?instance('shell',{wall:r.wall,trim:r.trim||'',floor:r.floor||''},true):distantShell(r.floor||'#dfc7ad');shell.userData.roomId=r.id;if(detailed.has(r.id))shell.scale.set(ROOM_SCALE,1,ROOM_SCALE);room.add(shell);
   interiorBases.push(shell);
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
     replacement.userData.roomId=r.id;replacement.userData.boundaryEdge=edge;replacement.visible=wallVisible(effectiveWallView(),edge,internal);room.add(replacement);
    }
    const d=boundary(r,edge).door;
    if(d){
     const doorway=createDoor(d,r.wall,r.trim,boundary(r,edge).kind==='wall_high',ribbonDoorTemplate);doorway.position.set(e.axis==='x'?e.at:d.at,.15,e.axis==='z'?e.at:d.at);doorway.rotation.y=e.rotation*Math.PI/180;doorway.userData.roomId=r.id;doorway.userData.boundaryEdge=edge;doorway.visible=wallVisible(effectiveWallView(),edge,internal);room.add(doorway);doors.push(doorway);
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
    if(a.building)obj.userData.boundaryEdge=edge;
    if(a.building)obj.visible=edge?wallVisible(effectiveWallView(),edge,!!neighbor(state,r,edge)):wallView!=='hidden';
    if(['wall','back','left'].includes(a.surface)){const side=Math.abs(i.x)>ROOM_HALF.x-.7?(i.x>0?'right':'left'):Math.abs(i.z)>ROOM_HALF.z-.65?(i.z>0?'front':'back'):null;obj.userData.boundaryEdge=side;obj.visible=side?wallVisible(effectiveWallView(),side,!!neighbor(state,r,side)):wallView!=='hidden';}
    room.add(obj);objects.push(obj);
    obj.traverse(o=>{if(o.userData.animated)animated.push({o,y:o.position.y,phase:o.userData.phase||0,speed:o.userData.floatSpeed||.6,amplitude:o.userData.floatAmplitude||.02});});
   }
   const surfaces=finishes.add(r,state,catalog,effectiveWallView());surfaces.traverse(o=>{if(o.isMesh&&o.material?.name?.startsWith('floor/'))interiorBases.push(o);});room.add(surfaces);content.add(room);
  }
  windowDaylight.update(windowDaylightSources(state,active,catalog,detailed),{quality,touch:touch||phone,overview});
  // A room with a window has one sun direction. The frontal fill must not
  // cast a second, contradictory window/sill shadow back onto the wall.
  configureWindowSun();
  const outlinedIds=new Set(state.rooms.flatMap(r=>r.items).filter(i=>!asset(i.assetId)?.building).map(i=>i.id));outlinedObjects=objects.filter(o=>outlinedIds.has(o.userData.itemId));
  syncPlush();finishes.end();for(const [key,m] of materialCache)if(!usedMaterials.has(key)){m.dispose();materialCache.delete(key)}
  showRotationPreview();placeVisitor();updateDoors();lampGlow.sync(objects);
  const viewKey=viewMode+'-'+overview+'-'+active.id+'-'+active.level+'-'+visible.map(r=>r.id).sort().join();resize(viewKey!==lastViewKey);lastViewKey=viewKey;updateSelection();
 }
 function showRotationPreview(){
  if(!rotationPreview)return;const preview=previewFurniture(placementRoom(),rotationPreview.id,rotationPreview);
  for(const i of furnitureGroup(preview,rotationPreview.id)){const obj=objects.find(o=>o.userData.itemId===i.id);if(obj){objectPose(obj,i);}}
 }
 function cancelRotation(){rotationPreview=null;drag=null;pointerDown=null;syncCameraControls();message='';error=false;rebuild();renderUI();}
 function rotateItem(){
  const chosen=item();if(chosen?.dockId){select(chosen.dockId);}
  const i=item();if(!i||['left','back','wall'].includes(asset(i.assetId).surface))return;
  rotationPreview={id:i.id,rotation:(i.rotation+90)%360};message='转好后拖动放下，或点「放下」';error=false;
  const original=selectedOwner().items.find(v=>v.id===i.id);if(rotationPreview.rotation===original.rotation)rotationPreview=null;
  rebuild();renderUI();host.focus({preventScroll:true});
 }
 function updateSelection(){dirty=true;wake();const obj=objects.find(o=>o.userData.itemId===selected);selection.visible=!!obj&&edit&&!overview;outlineObject(selection.visible?obj:null);if(obj)selection.setFromObject(obj);placementGuide(obj)}
 function setViewMode(next){
  if(firstPerson)return;
  if(!['flat','free'].includes(next)||next===viewMode)return;
  viewMode=next;residentFraming=false;orbitMode=false;drag=null;pointerDown=null;syncCameraControls();
  try{localStorage.setItem('sully-home3d-view-mode',viewMode);}catch{}
  if(!onMenu)rebuild();resize(true);renderUI();
 }
 function syncHomelyCamera(){
  if(!state)return;
  const frame=homelyFrame(size.w,size.h,homelyChatOpen);
  const position=homelyAttention?homelyAttention.anchor.clone().lerp(resident.position,homelyAttention.phase==='walk'?0:homelyAttention.phase==='near'?THREE.MathUtils.smoothstep(elapsed-homelyAttention.start,0,1.2):1):resident.visible?resident.position:new THREE.Vector3(0,.18,0);
  // Keep pitch and yaw fixed. Only translate the framing when the resident moves.
  camera.left=-frame.viewWidth/2;camera.right=frame.viewWidth/2;
  camera.top=frame.viewHeight/2;camera.bottom=-frame.viewHeight/2;
  const eye=position.y+(visitorSeat?1.25:1.7)+frame.offsetY;
  controls.target.set(position.x+frame.offsetX,eye,position.z);
  camera.position.set(controls.target.x,eye,position.z+40);
  camera.zoom=1;camera.clearViewOffset();camera.lookAt(controls.target);camera.updateProjectionMatrix();camera.updateMatrixWorld();
 }
 let homelyPoke=null,lastHomelyTouch=null;
 function pokeHomelyResident(hit){
  lastHomelyTouch={hit:hit?.id??null,resident:primaryResidentId};
  if(!firstPerson||photoSession||!visitor||!resident.visible||suspended||homelyPoke||hit?.id!==primaryResidentId)return false;
  const touch=hit?.point?visitor.getTouchRegion(hit.point):{zone:'body',side:1};
  lastHomelyTouch={...lastHomelyTouch,...touch};homelyPoke={person:visitor,start:elapsed,room:current().id,revision:manualRevision,touch};
  showHomeBubble(primaryResidentId,homelyTouchText[touch.zone],'reaction');dirty=true;wake();return true;
 }
 function applyHomelyPoke(){
  const poke=homelyPoke;if(!poke)return;
  const t=elapsed-poke.start;
  if(poke.person!==visitor||poke.room!==current().id||poke.revision!==manualRevision||!resident.visible||photoSession||t>=.85){homelyPoke=null;return;}
  const handsBusy=!!(companionPhone||visitorActivity||kitchenTask||visitorPlant||heldPlush||walking||seatChange||companionRise||companionTravel||socialRuntime?.active||petSystem?.contactPose()||visitorSeat?.bed);
  const pose=homelyTouchPose(t,poke.touch,handsBusy,reducedMotion);
  return applyHomelyPose(pose);
 }
 function applyHomelyPose(pose){
  if(!visitor.rig){const root=visitor.root,before=root.quaternion.clone(),angles=pose.head||pose.chest||[0,0,0];root.rotation.x+=angles[0]*.3;root.rotation.y+=angles[1]*.3;root.rotation.z+=angles[2]*.5;root.updateWorldMatrix(true,true);return ()=>{root.quaternion.copy(before);root.updateWorldMatrix(true,true);};}
  const entries=Object.entries(pose).filter(([name])=>visitor.rig.bones[name]),bones=entries.map(([name])=>visitor.rig.bones[name]),before=bones.map(b=>b.quaternion.clone());
  entries.forEach(([,angles],i)=>{bones[i].rotation.x+=angles[0];bones[i].rotation.y+=angles[1];bones[i].rotation.z+=angles[2];});visitor.finishPose();
  // Restore immediately after drawing: repeated renders never accumulate the offset.
  return ()=>{bones.forEach((b,i)=>b.quaternion.copy(before[i]));visitor.finishPose();};
 }

 function homelyOccupied(){
  return !visitor||!resident.visible||suspended||photoSession||edit||overview||roomLoading||visitorActivity||kitchenTask||visitorPlant||heldPlush||seatChange||companionRise||companionTravel||companionGesture||companionPhone||companionIdle||conversation||userSpeech||socialRuntime?.active||petSystem?.contactPose()||visitorSeat?.bed;
 }
 function endHomelyAttention(){
  const a=homelyAttention;if(!a)return;
  if(a.walk&&walking===a.walk)stopWalking(true,true);
  if(visitorUntil===a.until)visitorUntil=elapsed;
  homelyAttention=null;homelyForeground?.hide();dirty=true;wake();
 }
 function cancelHomelyAttention(){
  const a=homelyAttention;if(!a||a.phase==='return')return;
  if(a.walk&&walking===a.walk)stopWalking(true,true);
  if(!a.close){endHomelyAttention();return;}
  a.phase='return';a.start=elapsed;a.fromClose=a.close;dirty=true;wake();
 }
 function startHomelyAttention(){
  if(!firstPerson||!homelyChatOpen||homelyAttention||reducedMotion||state.autonomy===false||homelyOccupied()||walking||visitorSeat||homelyPoke||elapsed<visitorUntil||Date.now()<manualUntil)return false;
  const r=current(),offset=[r.x*ROOM_STEP.x,r.z*ROOM_STEP.z],start=[resident.position.x+offset[0],resident.position.z+offset[1]],map=residentWalkMap(start);
  let path;
  for(const [dx,dz] of [[.4,.9],[0,.9],[-.4,.7],[.7,.3]]){
   const candidate=findWalkPath(map,start,[start[0]+dx,start[1]+dz]);
   if(!candidate||candidate.length<2||candidate.some(p=>Math.abs(p[0]-offset[0])>=ROOM_HALF.x-.2||Math.abs(p[1]-offset[1])>=ROOM_HALF.z-.2))continue;
   let length=0;for(let i=1;i<candidate.length;i++)length+=Math.hypot(candidate[i][0]-candidate[i-1][0],candidate[i][1]-candidate[i-1][1]);
   if(length>=.35&&length<3){path=candidate;break;}
  }
  if(!path)return false;
  const a={person:visitor,room:r.id,revision:manualRevision,anchor:resident.position.clone(),phase:'walk',start:elapsed,close:0,until:elapsed+16,walk:null};
  homelyAttention=a;visitorUntil=a.until;visitorMotion='walk';visitorStart=elapsed;
  visitorLocation={x:start[0],z:start[1],level:r.level};
  walking={path,index:1,last:elapsed,recordWalk:false,arrived:()=>{if(homelyAttention!==a)return;a.phase='near';a.start=elapsed;visitorUntil=a.until;}};
  a.walk=walking;dirty=true;wake();return true;
 }
 function updateHomelyAttention(){
  const a=homelyAttention;if(!a)return;
  if(a.person!==visitor||a.room!==current().id||a.revision!==manualRevision||!homelyChatOpen||homelyOccupied()||state.autonomy===false){endHomelyAttention();return;}
  if(a.phase==='walk'){if(walking!==a.walk||elapsed-a.start>7)endHomelyAttention();return;}
  const t=elapsed-a.start;
  a.close=a.phase==='return'?a.fromClose*(1-THREE.MathUtils.smoothstep(t,0,.65)):THREE.MathUtils.smoothstep(t,0,1.2)*(1-THREE.MathUtils.smoothstep(t,4.8,6));
  if(t>=(a.phase==='return'?.65:6))endHomelyAttention();
 }
 function applyHomelyPresence(){
  if(!firstPerson||reducedMotion||!qualities[quality].motion||homelyOccupied()){homelyMusic.weight=0;homelyMusic.last=elapsed;return;}
  const dt=Math.min(.1,Math.max(0,elapsed-homelyMusic.last));homelyMusic.last=elapsed;
  const canSway=homelyMusic.playing&&!walking&&!homelyPoke&&!homelyAttention&&elapsed>=visitorUntil;
  homelyMusic.weight=THREE.MathUtils.lerp(homelyMusic.weight,canSway?1:0,Math.min(1,dt*5));
  if(homelyAttention?.close){const c=homelyAttention.close;return applyHomelyPose({head:[-.1*c,-.2*c,-.16*c],chest:[.08*c,0,.07*c],R_upperArm:[-.3*c,0,-.22*c],R_forearm:[-.8*c,0,0]});}
  if(walking||homelyPoke||homelyAttention||homelyMusic.weight<.001)return;
  return applyHomelyPose(homelyMusicPose(homelyMusic.position+(homelyMusic.playing?Math.max(0,elapsed-homelyMusic.at):0),homelyMusic.weight,!!visitorSeat));
 }
 function faceHomelyCamera(){
  if(!firstPerson||!visitor||!resident.visible||suspended||walking||seatChange||visitorActivity||kitchenTask||visitorPlant||heldPlush||socialRuntime?.active||companionPhone||companionRise||companionTravel||petSystem?.contactPose()||visitorSeat?.bed)return;
  // A seated body stays aligned to its furniture; only its head meets the viewer.
  const target=camera.position.clone();
  if(!visitorSeat)conversationHeading(resident,target,1);
  if(visitor.rig){conversationHead(visitor.rig.bones.head,target,.8);visitor.finishPose();}
  else visitor.lookToward?.(target);
 }
 function resize(fit=false,wide=roomWide){
  if(destroyed||!state)return;
  if(fit)roomWide=wide;
  dirty=true;wake();size={w:stage.clientWidth||1,h:stage.clientHeight||1};const ratio=size.w/size.h;if(photoSession){photoRenderer?.invalidate();for(const notify of photoListeners)notify();return;}
  if(firstPerson){syncHomelyCamera();renderer.setSize(size.w,size.h);return;}
  const box=new THREE.Box3().setFromObject(content),extent=box.isEmpty()?new THREE.Vector3(6.4,4.9,5.5):box.getSize(new THREE.Vector3());
  // Portrait living view uses a fixed vertical field, rather than fitting the house width.
  // Keep the room front outside the crop; overview and decorating retain the full model.
  if(onMenu&&!edit&&!overview&&ratio<.8&&!roomWide){
   const height=5.8;camera.left=-height*ratio/2;camera.right=height*ratio/2;camera.top=height/2;camera.bottom=-height/2;camera.clearViewOffset();
   if(fit){residentFraming=false;controls.target.set(resident.visible?resident.position.x:0,1.45,0);camera.position.copy(controls.target).add(new THREE.Vector3(0,4.5,60));camera.zoom=1;camera.far=200;}
   camera.updateProjectionMatrix();renderer.setSize(size.w,size.h);controls.update();if(interaction)renderInteraction();return;
  }
  if(viewMode==='flat'&&!overview){
   const frameBox=new THREE.Box3();
   for(const r of state.rooms.filter(r=>visibleRoomIds.has(r.id))){const [x,z]=displayOffset(r,current()),y=overview?(r.level-current().level)*5.08:0;frameBox.union(new THREE.Box3(new THREE.Vector3(x-ROOM_HALF.x-.6,y-.5,z-ROOM_HALF.z-.6),new THREE.Vector3(x+ROOM_HALF.x+.6,y+4.95,z+ROOM_HALF.z+1.4)));}
   fitFlatView(camera,controls,frameBox,ratio,fit);if(fit&&onMenu&&!overview&&ratio<.75){camera.zoom=1.1;camera.updateProjectionMatrix();}renderer.setSize(size.w,size.h);if(interaction)renderInteraction();return;}
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
  return `${placement}${dockInfo}${a.petSpecies?'<button data-action="adopt-pet">♡ 成为家园宠物</button>':''}<div class="h3-object-title"><strong>${esc(a.name)}${furnitureActions(a).length?`<small class="h3-action-detail">${esc(furnitureActions(a).join(' · '))}</small>`:''}</strong><button data-action="deselect" aria-label="取消选中">×</button></div><div class="h3-object-actions"><button data-action="rotate" ${['left','back','wall'].includes(a.surface)?'disabled':''}>↻ 旋转</button><button data-action="palette">◉ 换色</button><button data-action="copy">＋ 复制</button><button data-action="store">▱ 收纳</button>${a.appliance==='fridge'?'<button data-action="fridge-toggle">'+(kitchenEffects.isOpen(i.id)?'关上冰箱':'打开冰箱')+'</button>':''}${['left','back','wall','ceiling'].includes(a.surface)?'<button data-action="height" data-dy=".2">↑</button><button data-action="height" data-dy="-.2">↓</button>':''}</div>${panel==='palette'?paintPanel(i,a,defaultPaintColors.get(a.id),ui.querySelector('.h3-part-colors')?.open):''}`;
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
 function renderUI(){if(!state)return;releasePackImages();if(firstPerson){ui.innerHTML='';return;}host.classList.toggle('h3-playing',!edit);
  if(edit||overview||panel)closeInteraction();host.classList.toggle('h3-formal-home',!!onMenu);
  const r=current(),levels=[...new Set(state.rooms.map(r=>r.level))].sort((a,b)=>b-a);
  let sheet='';
  if(panel==='room-share')sheet=`<header><h2>分享房间布局</h2><button data-action="close" aria-label="关闭分享">×</button></header><p>「${esc(r.name)}」· ${r.items.filter(i=>!i.stored).length} 件家具。包含位置、朝向、配色和墙地面；不包含角色、聊天或收纳箱。</p><div class="h3-actions"><button data-action="room-layout-download">下载房间参数</button><button data-action="room-layout-copy">复制参数</button></div><textarea class="h3-layout-text" aria-label="当前房间参数" readonly spellcheck="false">${esc(sharedRoomText)}</textarea><h3>导入他人的房间</h3><textarea class="h3-layout-text" aria-label="粘贴房间参数" placeholder="粘贴房间 JSON 参数，或选择文件" spellcheck="false"></textarea><div class="h3-actions"><button data-action="room-layout-preview">读取粘贴参数</button><button data-action="room-layout-file">选择参数文件</button></div>${roomImportDraft?`<div class="h3-layout-preview"><strong>${esc(roomImportDraft.room.name)}</strong><p>${roomImportDraft.room.items.length} 件家具 · 配色、墙地面与门窗均已读取。</p><p>替换「${esc(r.name)}」已摆放的家具；收纳箱及其他房间保留。与邻房共用的墙面保留，空间不适配时不会应用。</p><button data-action="room-layout-apply">应用到当前房间（可撤销）</button></div>`:''}`;
  if(panel==='building')sheet=`<header><h2>墙体与房间</h2><button data-action="close">×</button></header>${boundaryPanel()}<details><summary>室内墙段 / 局部替换</summary><div class="h3-assets">${BUILDING_ASSETS.map(a=>`<button class="h3-asset" data-action="add-item" data-id="${a.id}"><img alt="" src="${thumbs.get(a.id)||''}">${a.name}</button>`).join('')}</div></details>`;
  else if(panel==='furniture'||panel==='storage'){
   const list=panel==='storage'?state.rooms.flatMap(room=>room.items.filter(i=>i.stored&&!i.supportId&&!i.dockId)).map(i=>({...asset(i.assetId),storedId:i.id})).filter(a=>furnitureSearch(a.name,furnitureQuery)):catalog.filter(a=>(!onMenu||!a.building)&&(furnitureQuery?furnitureSearch(a.name+' '+furnitureActions(a).join(' '),furnitureQuery):matchesFurniture(a,catalogMode,category)));
   const categories=catalogMode==='room'?ROOM_CATEGORIES:USE_CATEGORIES;
   const tabs=panel==='furniture'?`<div class="h3-catalog-modes" aria-label="家具分类方式"><button data-action="catalog-mode" data-value="room" aria-pressed="${catalogMode==='room'}">按房间</button><button data-action="catalog-mode" data-value="use" aria-pressed="${catalogMode==='use'}">按用途</button></div><div class="h3-categories h3-catalog-categories" data-mode="${catalogMode}" aria-label="家具分类">${Object.entries({all:'全部',...categories}).map(([key,label])=>`<button data-action="category" data-value="${key}" aria-pressed="${category===key}">${label}</button>`).join('')}</div>`:'';
   const mobileSelect=panel==='furniture'&&catalogMode==='use'?`<label class="h3-catalog-select">用途<select data-catalog-category aria-label="按用途筛选">${Object.entries({all:'全部',...USE_CATEGORIES}).map(([key,label])=>`<option value="${key}" ${category===key?'selected':''}>${label}</option>`).join('')}</select></label>`:'';
   sheet=`<header><h2>${panel==='storage'?'收纳箱':'家具架'}</h2><button data-action="close">×</button></header><input class="h3-furniture-search" type="search" aria-label="搜索家具" placeholder="搜索家具或动作…" value="${esc(furnitureQuery)}">${tabs}<p class="h3-catalog-legend">${list.length} 件 · 右上角「动作」表示支持互动</p><div class="h3-assets">${list.map(a=>{const actions=furnitureActions(a),label=actions.join('、');return `<button class="h3-asset" data-pack-locked="${a.id.startsWith('halloween_')&&!furniturePackInstalled}" data-action="${a.storedId?'restore':'add-item'}" data-id="${a.storedId||a.id}" title="${esc(actions.length?a.name+' · '+label:a.name)}">${actions.length?`<small class="h3-action-badge" aria-label="可互动：${esc(label)}">动作</small>`:''}${thumbs.has(a.id)?`<img alt="" loading="lazy" data-pack-src="${thumbs.get(a.id)}">`:'<span>◇</span>'}${esc(a.name)}</button>`}).join('')}</div>${!list.length?'<p>这个分类暂时还没有家具。</p>':''}`;
  }else if(panel==='selected'||panel==='palette')sheet='';
  else if(panel==='rooms')sheet=`<header><h2>房间与楼层</h2><button data-action="close">×</button></header><div class="h3-actions" aria-label="房间显示范围"><button data-action="room-scope" data-value="floor" ${viewMode==='flat'?'disabled':''} aria-pressed="${effectiveRoomScope()==='floor'}">显示同层</button><button data-action="room-scope" data-value="room" aria-pressed="${effectiveRoomScope()==='room'}">只看当前房间</button></div><p>${viewMode==='flat'?'锁定视角时逐间呈现；':''}选择下方房间切换；总览仍可查看全部小屋。</p><div class="h3-roomlist">${state.rooms.map(n=>`<button data-action="room" data-id="${n.id}" aria-pressed="${n.id===r.id}"><span>${esc(n.name)}</span><small>${n.level+1}F · ${connectedRooms(state,n.id,catalog).length>1?'已合并 · ':''}${n.x}, ${n.z}</small></button>`).join('')}</div>`;
  else if(panel==='expand')sheet=`<header><h2>从${esc(r.name)}扩建</h2><button data-action="close">×</button></header><div class="h3-expand">${[['back','后方'],['up','楼上'],['front','前方'],['left','左边'],['down','楼下'],['right','右边']].map(([dir,label])=>`<button data-action="expand" data-direction="${dir}" ${dir==='down'&&r.level===0?'disabled':''}>＋ ${label}</button>`).join('')}</div><p>已有房间的位置会直接进入。新房间先留空，慢慢布置。</p>`;
  else if(panel==='room-style')sheet=`<header><h2>${esc(r.name)} · 装扮</h2><button data-action="close">×</button></header><input class="h3-rename" aria-label="房间名字" maxlength="40" value="${esc(r.name)}"><div class="h3-actions"><button data-action="rename">保存名字</button><button data-action="room-share">分享当前房间</button><button data-action="export">导出整屋备份</button><button data-action="import">恢复整屋备份</button></div><p>整屋备份包含房屋、日常记录与宠物。双方形象、自绘素材、秘密与日程请在设置中使用整合导出备份。</p><p>墙面颜色</p><div class="h3-swatches">${['#FFF2E3',...PALETTE.slice(0,5)].map(c=>`<button aria-label="墙色 ${c}" style="background:${c}" data-action="wall" data-value="${c}"></button>`).join('')}</div>`;
  if(panel==='rooms')sheet+='<div class="h3-actions"><button data-action="panel" data-panel="room-style">修改当前房间名称与装扮</button><button data-action="room-share">分享当前房间</button></div>';
  if(!onMenu&&(panel==='rooms'||panel==='expand'))sheet+=`<p>精装房配色</p><select aria-label="新样板房配色" data-showroom-palette><option value="">原木黑白绿 · 原版</option>${Object.entries(ROOM_PALETTES).filter(([id])=>id!=='sage').map(([id,p])=>`<option value="${id}" ${showroomPalette===id?'selected':''}>${p.name}</option>`).join('')}</select><p>追加一间样板房 · 保留已有布置</p><div class="h3-actions">${Object.entries(SHOWROOMS).map(([id,t])=>`<button data-action="showroom" data-value="${id}">＋ ${t.name}</button>`).join('')}</div><p>自动放在当前房间旁的空位，可撤销；家具、墙纸和地板均可继续修改。</p>`;
  if(panel==='room-style'&&hasDefaultRoomLayout(state,r))sheet+='<div class="h3-actions"><button data-action="reset-room-layout">恢复当前房间初始布局</button></div><p>恢复初始家具与配色，保留房间名字和收纳箱；可以撤销。</p>';
  if(panel==='room-style'&&!hasFixedRoomPalette(r))sheet+=`<p>精装房配色 · 家具与墙地一起换色</p><div class="h3-actions">${Object.entries(ROOM_PALETTES).map(([id,p])=>`<button data-action="room-palette" data-value="${id}"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:5px;background:${p.accent}"></span>${p.name}</button>`).join('')}</div><p>浅色系保留原木；黑白紫统一黑白家具。可撤销、导出分享。</p>`;
  if(panel==='room-style')sheet+=`${hasFixedRoomPalette(r)?'<p>万圣节小屋保留主题原色，不支持一键染色；全屋换色会跳过这间房。</p>':'<p>原包风格 · 只更新配色和墙地面</p>'}<div class="h3-actions">${Object.entries(SHOWROOMS).filter(()=>!hasFixedRoomPalette(r)).map(([key,t])=>`<button data-action="room-style-preset" data-value="${key}">${t.name}</button>`).join('')}</div><p>正在装扮哪间房</p><div class="h3-categories">${displayRooms(state,r).map(n=>`<button data-action="style-room" data-id="${n.id}" aria-pressed="${n.id===r.id}">${esc(n.name)}</button>`).join('')}</div><p>壁纸样式 · 只改这间房</p><div class="h3-categories">${Object.entries(WALL_STYLES).map(([id,label])=>`<button data-action="room-finish" data-part="wallStyle" data-value="${id}" aria-pressed="${(r.wallStyle||'solid')===id}">${label}</button>`).join('')}</div><p>地板样式</p><div class="h3-categories">${Object.entries(FLOOR_STYLES).map(([id,label])=>`<button data-action="room-finish" data-part="floorStyle" data-value="${id}" aria-pressed="${(r.floorStyle||'original')===id}">${label}</button>`).join('')}</div>`;
  if(panel==='room-style')sheet+=`<p>房间配色（墙面、边框和地板）</p><div class="h3-actions">${(hasFixedRoomPalette(r)?[]:['奶油紫','草莓奶','鼠尾草','云朵蓝']).map((label,i)=>`<button data-action="house-theme" data-value="${i}">${label}</button>`).join('')}</div>${[['trim','边框与底座'],['floor','地板']].map(([part,label])=>`<p>${label}</p><div class="h3-swatches">${PALETTE.map(c=>`<button aria-label="${label} ${c}" style="background:${c}" data-action="house-color" data-part="${part}" data-value="${c}"></button>`).join('')}</div>`).join('')}`;
  if(panel==='quality')sheet=`<header><h2>光影与画质</h2><button data-action="close">×</button></header><div class="h3-actions">${Object.entries(qualities).map(([id,q])=>`<button data-action="quality" data-value="${id}" aria-pressed="${quality===id}">${q.label} · ${roomPixelRatio(id,devicePixelRatio,touch||phone)}×</button>`).join('')}</div><p>${quality==='eco'?'节省动态绘制，保留一扇窗的光影，暂停描边与水母动画；静止时停止绘制。':quality==='balanced'?'标准分辨率，保留窗光与轻微水母动画，最高 30 帧；触屏设备使用轻量光影。':'高分辨率，桌面最多两扇窗光；触屏设备保留一扇窗光、最高 30 帧，耗电相对较高。'}</p><p>房间光线 · ${ROOM_LIGHT_PHASES[lightPhase].label}</p><div class="h3-actions" aria-label="光照时段">${[['auto','自动'],...Object.entries(ROOM_LIGHT_PHASES).map(([id,p])=>[id,p.label])].map(([id,label])=>`<button data-action="lighting-mode" data-value="${id}" aria-pressed="${lightMode===id}">${label}</button>`).join('')}</div><p>${lightMode==='auto'?(timeZone?'跟随房主时区：'+esc(timeZone):'跟随设备时间'):'固定为'+ROOM_LIGHT_PHASES[lightPhase].label+'光线，点「自动」恢复随时间变化。'}</p><div class="h3-actions"><button data-action="light-finish" aria-pressed="${finishEnabled}">柔光调色：${finishEnabled?'开':'关'}</button></div><p>轻柔扩散亮部，保留人物和家具轮廓；可关闭以进一步省电。</p><p>清晨 05–08 · 白天 08–16 · 夕阳 16–19 · 夜晚 19–05。保留室内亮度，用光色表现时段。</p><p>人物渲染</p><div class="h3-actions" aria-label="人物渲染">${[['modern','新版 · 风格化'],['legacy','旧版 · 经典']].map(([id,label])=>`<button data-action="character-style" data-value="${id}" aria-pressed="${getCharacterStyle()===id}">${label}</button>`).join('')}</div><p>新版默认开启，可随时切回旧版。本机记住选择，小屋与捏人预览同步生效。</p><p>家具风格</p><div class="h3-actions">${[['original','原始'],['retro','复古']].map(([id,label])=>`<button data-action="furniture-style" data-value="${id}" aria-pressed="${furnitureStyle===id}">${label}</button>`).join('')}</div><p>复古：清晰色块、简化明暗。只影响这台设备，自动记住选择。</p>${furnitureStyle==='retro'?`<div class="h3-actions"><button data-action="furniture-outline" aria-pressed="${furnitureOutlineEnabled}">家具描边：${!lightBudget().outline?'当前档位暂停':furnitureOutlineEnabled?'开':'关'}</button></div><p>省电档与触屏设备暂停描边，保留配色和窗光；桌面均衡、清晰档使用此开关。</p>`:''}<p>当前绘制尺寸 ${Math.floor(size.w*renderer.getPixelRatio())} × ${Math.floor(size.h*renderer.getPixelRatio())}。所有档位在页面隐藏时停止绘制。</p>`;
  if(panel==='chibi')sheet=`<header><h2>陪小人待一会儿</h2><button data-action="close">×</button></header><div class="h3-actions"><button data-action="chibi-view">蹲下看小人</button><button data-action="room-view">看全屋</button></div><div class="h3-actions" style="margin-top:10px">${motions.filter(([id])=>(visitor?.rig||!['yoga','wave-alternate-1','wave-alternate-2'].includes(id))&&(!visitorSeat?.bed||id==='sleep')).map(([id,label])=>`<button data-action="chibi-motion" data-value="${id}" aria-pressed="${visitorMotion===id}">${visitorSeat&&id==='idle'?'坐好':visitorSeat?.bed&&id==='sleep'?'睡一会儿':visitorSeat&&id==='sleep'?'打瞌睡':label}</button>`).join('')}${visitorSeat?.bed&&visitor?.rig&&!seatChange&&!walking?BED_LEISURE.map(([id,label])=>`<button data-action="chibi-bed-mode" data-value="${id}" ${seatChange?'disabled':''}>${label}</button>`).join(''):''}${visitorSeat?'<button data-action="chibi-stand">起身</button>':''}${(kitchenTask||(visitorActivity&&!isMirrorAction(visitorActivity.kind)))?'<button data-action="chibi-game-stop">休息一下</button>':''}${heldPlush?'<button data-action="plush-put-back">放回原位</button>':''}</div><p>点床、座椅、绿植或设备，就能选择它的互动。</p><p>${resident.visible?'小手只轻轻挥，不会拉长。':'房间没有足够空地，请先收起一件落地家具。'}</p>`;
  if(panel==='furniture'&&catalogMode==='room'&&category==='kitchen')sheet=sheet.replace('<div class="h3-assets">','<div class="h3-actions"><button data-action="dining-preset">摆好餐桌和两张餐椅</button></div><div class="h3-assets">');
  if(panel==='furniture'&&catalogMode==='room'&&category==='gaming')sheet=sheet.replace('<div class="h3-assets">',`<p>摆好一套（每件仍能单独移动）</p><div class="h3-actions">${Object.entries(GAMING_ACTIONS).map(([id,label])=>`<button data-action="gaming-preset" data-kind="${id}">${label}套装</button>`).join('')}</div><div class="h3-assets">`);
  if(panel==='chibi')sheet+=`<p>点空地走过去；门会在靠近时打开。</p><div class="h3-actions">${doorLinks()}</div>`;
  if(!onMenu&&phone&&['furniture','storage','expand','rooms','room-style'].includes(panel)){const count=furnishingCounts(state,catalog).get(r.id)||0;sheet=sheet.replace('</header>',`</header><p class="h3-budget">手机容量 · 面积 ${state.rooms.filter(room=>!room.activityRoom).length}/${PHONE_BUDGET.rooms} 块${state.rooms.some(room=>room.activityRoom)?' ＋ 活动别馆':''} · 本区域家具 ${count}/${PHONE_BUDGET.furniture} 件${state.rooms.filter(room=>!room.activityRoom).length>PHONE_BUDGET.rooms||count>PHONE_BUDGET.furniture?' · 已超限，可继续收纳整理':''}</p>`);}
  if(panel==='settings')sheet=`<header><h2>家园设置</h2><button data-action="close" aria-label="关闭设置">×</button></header><h3>家里的颜色</h3><div class="h3-palette-grid">${Object.entries(ROOM_PALETTES).map(([id,p])=>`<button data-action="home-palette" data-value="${id}" aria-pressed="${state.homePalette===id}"><span style="background:${p.wall}"><i style="background:${p.accent}"></i><i style="background:${p.floor}"></i></span>${p.name}</button>`).join('')}</div><p>应用到普通房间，万圣节小屋保留主题原色；家具位置保持不变，可撤销。</p><div class="h3-actions"><button data-action="panel" data-panel="room-style">当前房间装扮</button><button data-action="panel" data-panel="quality">画面与光影</button><button data-action="view-mode">${viewMode==='flat'?'开启自由视角':'锁定视角'}</button><button data-action="room-view">画面复位</button></div>`;
  if(onMenu&&panel==='rooms')sheet=`<header><h2>家里的房间</h2><button data-action="close" aria-label="关闭房间面板">×</button></header><div class="h3-roomlist">${state.rooms.map(n=>`<button data-action="room" data-id="${n.id}" aria-pressed="${n.id===r.id}"><span>${esc(n.name)}</span><small>${n.level+1}F${n.id===residentRoom?' · ★ 房主在这里':''}</small></button>`).join('')}</div><div class="h3-actions"><button data-action="panel" data-panel="room-style">修改「${esc(r.name)}」的名称与装扮</button><button data-action="room-share">分享当前房间</button></div><p>名字也会同步到角色的日程可选房间。</p>`;
  if(panel==='rooms'){const annex=state.rooms.find(room=>room.activityRoom==='halloween');sheet+=`<h3>活动别馆</h3><p>独立放在主屋侧边，保留原有房间和布置。万圣节主题不参与一键染色。</p><div class="h3-actions">${annex?`<button data-action="room" data-id="${annex.id}">🎃 前往万圣节小屋</button>`:'<button data-action="activity-room" data-value="halloween">＋ 追加万圣节小屋</button>'}</div>`;}
  ui.innerHTML=`${onMenu&&manualControl===primaryResidentId?`<div class="h3-control-status" role="status"><span>正在操控 ${esc(ownerName)}</span><button data-action="control-self" aria-label="结束操控角色，切回自己">切回自己 ↩</button></div>`:''}${!panel&&!overview&&!edit?homeMap(state,residentRoom,mapCollapsed):''}<div class="h3-top">${onBack?`<button class="h3-pill h3-back" data-action="back" aria-label="返回">${interactionIcon('back')}</button>`:''}<div class="h3-title"><div class="h3-title-row"><strong>${esc(overview?'我的小小世界':r.name)}</strong>${onMenu&&!edit&&!overview?`<button class="h3-camera-menu-toggle" data-action="camera-menu" aria-label="视角与墙面" aria-expanded="${cameraMenu}">视角 <span aria-hidden="true">⌄</span></button>`:''}</div><small class="h3-schedule-label" title="${esc(scheduleLabel)}">${esc(scheduleLabel)}</small><small>${r.level+1}F · ${roomGroups(state,catalog).length} 间房 · ${rotationPreview?'旋转预览 · 待放下':saved?'布置已保存':'尚未保存'}</small></div>${onMenu&&!edit&&!overview?`<button class="h3-pill h3-quality-entry" data-action="panel" data-panel="quality" aria-label="画质设置">${interactionIcon('quality')}<span>画质</span></button>`:''}<button class="h3-pill" ${overview&&onBack?'hidden style="display:none"':''} data-active="${overview}" data-action="overview">${interactionIcon('map')}${overview?'回房间':'总览'}</button><button class="h3-pill" data-active="${edit}" data-action="edit">${edit?'完成':'布置'}</button></div>${cameraMenu&&onMenu&&!edit&&!overview?`<section class="h3-camera-menu" aria-label="视角与墙面设置"><div>${[['free','自由'],['flat','锁定']].map(([id,label])=>`<button data-action="camera-choice" data-value="${id}" aria-pressed="${viewMode===id}">${label}</button>`).join('')}</div><div>${[['hidden','无墙'],['cutaway','自动墙面'],['dollhouse','玩具屋']].map(([id,label])=>`<button data-action="wall-view" data-value="${id}" aria-pressed="${wallView===id}">${label}</button>`).join('')}</div><div><button data-action="living-view">室内近景</button><button data-action="room-view">看全屋</button></div><button data-action="camera-default">恢复默认</button></section>`:''}<div class="h3-floor">${levels.map(l=>`<button data-active="${l===r.level}" data-action="floor" data-level="${l}">${l+1}F</button>`).join('')}</div><div class="h3-camera-tools"><button class="h3-wall-cycle" ${overview?'hidden style="display:none!important"':''} data-action="wall-cycle" aria-label="切换墙面显示"><span>${({hidden:'无墙',cutaway:'自动墙面',dollhouse:'玩具屋'})[wallView]} ▾</span></button><button class="h3-view-mode" data-action="view-mode" aria-label="切换视角锁定或自由视角" aria-pressed="${viewMode==='flat'}">${interactionIcon('view')}<span>${viewMode==='flat'?'视角锁定':'自由视角'}</span></button>${onMenu&&!edit&&!overview?`<button class="h3-decorate" data-action="edit">${interactionIcon('seat')}<span>布置家具</span></button>`:''}<button data-action="room-view" aria-label="画面复位">⌂</button><button data-action="zoom" data-factor="1.2" aria-label="放大">＋</button><button data-action="zoom" data-factor=".833333" aria-label="缩小">−</button>${viewMode==='free'?`<button data-action="turn-view" data-angle="-.785398" aria-label="视角向左">↶</button><button data-action="turn-view" data-angle=".785398" aria-label="视角向右">↷</button>`:''}</div>${edit?`<div class="h3-history"><button data-action="undo" aria-label="撤销" ${undo.length||rotationPreview?'':'disabled'}>↶ 撤销</button><button data-action="redo" aria-label="重做" ${redo.length?'':'disabled'}>↷ 重做</button></div>`:''}${edit&&selected&&!sheet?`<section class="h3-object-bar">${selectedPanel()}</section>`:''}${sheet?`<section class="h3-sheet">${sheet}</section>`:''}<div class="h3-status" ${sheet||selected&&!error?'style="display:none"':''}><span class="${error?'error':''}">${esc(message||(overview?'点一间房，进去看看':edit?(viewMode==='flat'?'拖选中家具 · 镜头保持固定':'拖选中家具 · 单指转向 · 双指缩放平移'):(viewMode==='flat'?'点地面走动 · 滚轮或双指缩放 · 视角锁定':'点家具互动 · 拖动转向 · 双击小人放大')))}</span></div><nav class="h3-dock">${onMenu&&!edit?homeLifeDock():[...(!onMenu&&visitor?[['chibi','♡','小人']]:[]),['furniture','♧','家具'],...(edit?[...(!onMenu?[['building','▥','建造']]:[]),['storage','▱','收纳'],...(!onMenu?[['expand','＋','扩建']]:[])]:[]),['rooms','⌂','房间'],['settings','◌','设置']].map(([id,icon,label])=>`<button data-action="panel" data-panel="${id}" data-active="${panel===id}"><b>${interactionIcon({chibi:'jelly',furniture:'furniture',building:'building',storage:'storage',expand:'expand',rooms:'rooms','room-style':'style',settings:'style',quality:'quality'}[id])}</b>${label}</button>`).join('')}</nav>`;
  releasePackImages=hydratePackImages(ui);
 }
 const placementFor=a=>['floor','rug'].includes(a.surface)&&!a.building?placementRoom():current();
 function checkWallLayout(){const why=layoutError(state,catalog);if(why)throw Error('墙段会挡住家具：'+why);}
 function changeItem(patch){const i=item();if(!i)return false;return commit(()=>{moveInHome(state,current(),i.id,{...(rotationPreview?.id===i.id?rotationPreview:{}),...patch},catalog);if(asset(item()?.assetId)?.building)checkWallLayout();rotationPreview=null;message='已放好';error=false})}
 function select(id){closeInteraction();if(rotationPreview&&id!==selected&&!changeItem(rotationPreview))return;selected=id;const owner=selectedOwner();if(owner&&owner.id!==current().id){activateRoom(owner);persist();rebuild();}panel='selected';edit=true;overview=false;controls.enabled=true;updateSelection();renderUI()}
 function action(e){const b=e.target.closest('[data-action]');if(!b||b.disabled)return;if(b.dataset.action.startsWith('chibi-')&&!useFurnitureUser())return;if(b.dataset.action.startsWith('chibi-')&&!furnitureUser||b.dataset.action==='edit'){manualUntil=Date.now()+6000;manualRevision++;}runAction(b.dataset);}
 function runAction(d){
  const enteringRoom=d.action==='room'||d.action==='style-room'?state.rooms.find(r=>r.id===d.id):d.action==='floor'?state.rooms.find(r=>r.level===Number(d.level)):null;
  if(!d.packConfirmed&&enteringRoom&&hasFixedRoomPalette(enteringRoom)){
   import('./ResourcePackPanel').then(({confirmResourcePack})=>confirmResourcePack('halloween-furniture',abort.signal)).then(ok=>{if(ok&&!destroyed)runAction({...d,packConfirmed:true});}).catch(e=>{if(!destroyed)notify(e.message,true);});return;
  }
  if(!d.packConfirmed&&(d.action==='add-item'||d.action==='restore'||d.action==='activity-room'||d.action==='showroom'&&d.value==='halloween')){
   const id=['activity-room','showroom'].includes(d.action)?'halloween_room':d.action==='add-item'?d.id:state.rooms.flatMap(r=>r.items).find(i=>i.id===d.id)?.assetId;
   if(id?.startsWith('halloween_')){import('./ResourcePackPanel').then(({confirmResourcePack})=>confirmResourcePack('halloween-furniture',abort.signal)).then(ok=>{if(ok&&!destroyed)runAction({...d,packConfirmed:true});}).catch(e=>notify(e.message,true));return;}
  }
  if(/^(camera-|wall-|view-mode$|living-view$|room-view$|zoom$|turn-view$)/.test(d.action||'')){cameraArrival=null;if(greeting)greeting.restoreWide=false;}
  if(d.action==='control-self'){setManualResident('user');return;}
  if(d.action==='map-toggle'){mapCollapsed=!mapCollapsed;renderUI();return;}
  if(d.action==='edit'||d.action==='overview')restoreFurnitureCharacter();
  if(d.action==='life'){panel=null;closeInteraction();renderUI();if(d.panel==='pets')petSystem?.open();else onMenu?.(d.panel);return;}
  if(d.action?.startsWith('chibi-')&&!furnitureUser&&residentRoom!==undefined&&(residentRoom===null||current().id!==residentRoom)){notify('角色现在不在这个房间哦');return;}
  if(d.action==='room-share'){trackHomeFeature('room-share');
   try{sharedRoomText=JSON.stringify(exportRoomLayout(current(),catalog),null,2);roomImportDraft=null;panel='room-share';selected=null;renderUI();}catch(e){notify(e.message,true);}return;
  }
  if(d.action==='room-layout-download'){
   const url=URL.createObjectURL(new Blob([sharedRoomText],{type:'application/json'})),a=document.createElement('a');
   a.href=url;a.download=(current().name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')||'房间')+'.room.json';a.click();trackHomeTransfer('export-room');setTimeout(()=>URL.revokeObjectURL(url),1000);return;
  }
  if(d.action==='room-layout-copy'){
   navigator.clipboard?.writeText(sharedRoomText).then(()=>{trackHomeTransfer('copy-room');if(!destroyed)notify('房间参数已复制，可以发给朋友');}).catch(()=>{if(!destroyed)notify('请选中上方参数文本手动复制',true);});
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
   if(commit(()=>{state=applyRoomLayout(state,current().id,roomImportDraft.room,catalog);selected=null;panel=null;message='房间布局已应用，可撤销';})){trackHomeTransfer('import-room');roomImportDraft=null;visitorActivity=null;visitorSeat=null;visitorPlant=null;heldPlush=null;visitorMotion='idle';edit=true;overview=false;controls.enabled=true;placeVisitor();renderUI();host.focus({preventScroll:true});dirty=true;wake();}return;
  }
  if(d.blocked){notify(d.blocked,true);return;}
  if(d.action==='pet-panel'){closeInteraction();petSystem.open(d.id);return;}
  if(d.action==='pet-interact'){try{petSystem.interact(d.id,d.kind);closeInteraction();notify(d.kind==='carry'?'抱稳小伙伴，点地面就能一起走':d.kind==='pet'?'走到它身边，轻轻摸摸':'正在'+(petSystem.interactionOptions(d.id).find(a=>a.kind===d.kind)?.label||'陪它'));}catch(err){notify(err.message,true);renderInteraction();}return;}
  if(d.action==='interaction-close'){closeInteraction();host.focus({preventScroll:true});return;}
  if(d.action==='interaction-more'){if(interaction){interaction.page++;renderInteraction();}return;}
  if(d.action==='interaction-back'){if(interaction?.page){interaction.page--;renderInteraction();}else{closeInteraction();host.focus({preventScroll:true});}return;}
  if(!['zoom','turn-view'].includes(d.action))closeInteraction();
  if(d.action==='plush-put-back'){putPlushBack();animateVisitor(0);dirty=true;wake();notify('玩偶放回原位啦');return;}
  if(d.action==='chibi-hug'&&visitor){
   if(!roomPlush(current(),catalog).some(p=>p.itemId===d.id))return;
   stopWalking();putPlushBack();visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorPlant=null;if(visitorSeat?.bed)visitorSeat=null;
   placeVisitor();if(!resident.visible){notify('先给孩子留一点站立空间，再抱玩偶',true);return;}
   heldPlush={roomId:current().id,itemId:d.id};visitorMotion='hug';visitorStart=elapsed;visitorUntil=elapsed+4.4;edit=false;overview=false;selected=null;panel=null;syncPlush();animateVisitor(0);updateSelection();invalidateRoomShadows();recordHomeActivity('抱玩偶',d.recordSource);notify('抱住啦！在小人面板可以放回原位');return;
  }
  if(d.action==='dining-preset'){commit(()=>{const items=placeDiningPreset(placementRoom(),catalog);if(current().items.length+items.length>100)throw Error('每间房最多保存 100 件家具');current().items.push(...items);panel=null;selected=null;message='餐桌椅摆好啦，点餐桌或餐椅就能吃饭';});return;}
  if(d.action==='fridge-toggle'){const i=d.id?placementRoom().items.find(i=>i.id===d.id):item(),obj=objects.find(o=>o.userData.itemId===i?.id);if(!obj||asset(i.assetId)?.appliance!=='fridge')return;const why=kitchenEffects.isOpen(i.id)?'':fridgeOpenError(i,placementRoom(),catalog,resident.visible?resident.position.toArray():null);if(why){notify(why,true);return;}kitchenEffects.toggle(obj);dirty=true;wake();renderUI();return;}
  if(d.action==='gaming-preset'){commit(()=>{const items=placeGamingPreset(d.kind,placementRoom(),catalog);if(current().items.length+items.length>100)throw Error('每间房最多保存 100 件家具');current().items.push(...items);panel=null;selected=null;message='设备和座位摆好啦，点设备就能开始玩啦';});return;}
  if(d.action==='chibi-kitchen'&&visitor){
   stopWalking();putPlushBack();visitorActivity=null;visitorPlant=null;visitorSeat=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);placeVisitor();
   const start=[resident.position.x+current().x*ROOM_STEP.x,resident.position.z+current().z*ROOM_STEP.z];
   const task=planKitchenAction(state,current(),catalog,d.id,start,headWidth,navMap());
   if(task.reason){notify(task.reason,true);return;}
   edit=false;overview=false;selected=null;panel=null;task.recordSource=d.recordSource||'user';kitchenTask=task;kitchenLeg(task,task.source,'approach');message='这就去'+({coffee:'做咖啡',wash:'取盘子洗碗',cook:'煮饭'}[task.kind]);updateSelection();renderUI();return;
  }
  if(['chibi-game','chibi-mirror','chibi-bath'].includes(d.action)&&visitor){const next=activities().find(a=>a.itemId===d.id&&a.kind===d.kind&&(a.stationId||'')===(d.station||''));if(!next||next.reason||next.seat&&guestLife.reserved(next.seat,activeResidentId())){notify(next?.reason||'家具或搭配条件已经变了',true);return;}next.recordSource=d.recordSource||'user';if(visitor?.rig&&isBathAction(next.kind)){approachBathroom(next);return;}if(visitor?.rig&&next.seat&&['computer','stream','race','eat'].includes(next.kind)){approachDeskActivity(next);return;}stopWalking();visitorLocation=null;visitorPlant=null;visitorActivity=next;visitorSeat=next.seat;visitorMotion=next.kind;if(next.kind==='mirror-outfit'){
   const map=navMap(),ox=current().x*ROOM_STEP.x,oz=current().z*ROOM_STEP.z;
   next.journey=createMirrorJourney(next,resident.position.toArray(),(a,b)=>findWalkPath(map,[a[0]+ox,a[2]+oz],[b[0]+ox,b[2]+oz])?.map(p=>[p[0]-ox,.18,p[1]-oz]),{speed:visitor?.rig?visitor.walkSpeed??1.05:1.7});
  }if(viewMode==='free'&&next.kind==='rhythm'&&camera.zoom>1.8){const offset=camera.position.clone().sub(controls.target);controls.target.fromArray(next.position).add(new THREE.Vector3(0,1.6,0));camera.position.copy(controls.target).add(offset);camera.zoom=1.8;camera.updateProjectionMatrix();controls.update();}visitorStart=elapsed;visitorUntil=elapsed+(next.journey?.duration||furnitureActivitySeconds(next.kind,next.duration||12));edit=false;overview=false;selected=null;panel=null;placeVisitor();animateVisitor(reducedMotion?1:0);recordHomeActivity(next.label,next.recordSource);message=next.label+((isMirrorAction(next.kind)||isBathAction(next.kind))?'中':'中 · 在小人面板可随时休息');dirty=true;wake();renderUI();return;}
  if(d.action==='chibi-game-stop'){stopWalking();const bathing=isBathAction(visitorActivity?.kind);visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorMotion='idle';visitorUntil=0;if(bathing){bathroomEffects.clear();placeVisitor();}animateVisitor(0);dirty=true;wake();renderUI();return;}
  if(['chibi-water','chibi-sit','chibi-stand','chibi-motion'].includes(d.action)){stopWalking();visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);}
  if(d.action==='camera-menu'){cameraMenu=!cameraMenu;renderUI();return;}
  if(d.action==='camera-default'){cameraArrival=null;if(greeting)greeting.restoreWide=false;viewMode='free';wallView='cutaway';roomWide=true;overview=false;cameraMenu=false;panel=null;syncCameraControls();try{localStorage.setItem('sully-home3d-view-mode','free');localStorage.setItem('sully-home3d-wall-view','cutaway');}catch{}resize(true,true);renderUI();return;}
  if(d.action==='camera-choice'){setViewMode(d.value);cameraMenu=false;renderUI();return;}
  if(d.action==='wall-cycle'){const modes=['hidden','cutaway','dollhouse'];runAction({action:'wall-view',value:modes[(modes.indexOf(wallView)+1)%3]});return;}
  if(d.action==='wall-view'){cameraMenu=false;wallView=d.value;try{localStorage.setItem('sully-home3d-wall-view',wallView)}catch{}dirty=true;wake();renderUI();return;}
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
  if(d.action==='chibi-view'&&viewMode==='flat'){panel='chibi';notify('视角方向已锁定，可用滚轮、双指或 ＋／− 拉近拉远');return;}
  if(d.action==='chibi-view'&&visitor&&resident.visible){
   const offset=camera.position.clone().sub(controls.target),distance=offset.length();
   offset.y=0;if(offset.lengthSq()<.001)offset.set(0,0,1);offset.normalize().multiplyScalar(distance);
   // Look slightly down at held toys and sleeping faces instead of hiding them
   // behind a nearby table or the bed's footboard. Orbit remains freely movable.
   offset.y=distance*(kitchenTask?.stage==='work'?.8:visitorSeat?.bed?.75:visitor?.rig&&(visitorSeat||visitorPlant)?.42:heldPlush?.55:.045);
   const jumping=visitorActivity?.kind==='rhythm';controls.target.copy(resident.position).add(new THREE.Vector3(0,jumping?1.6:.85,0));camera.position.copy(controls.target).add(offset);camera.zoom=jumping?1.8:2.4;
   camera.updateProjectionMatrix();controls.update();if(!jumping){focusResident();return;}panel=null;dirty=true;wake();renderUI();return;
  }
  if(d.action==='living-view'){cameraMenu=false;resize(true,false);panel=null;renderUI();return}
  if(d.action==='room-view'){cameraMenu=false;resize(true,true);panel=null;renderUI();return}
  if(d.action==='panel'&&d.panel==='chibi'){panel=panel==='chibi'?null:'chibi';edit=false;overview=false;selected=null;rebuild();renderUI();return}
  if(d.action==='chibi-water'&&visitor){stopWalking();visitorLocation=null;
   const spot=wateringSpot(current(),catalog,d.id,visitorClearance());if(!spot){notify('绿植四周都太挤啦，先挪开一点家具',true);return;}
   visitorSeat=null;visitorPlant={roomId:current().id,itemId:d.id,spot};visitorMotion='water';visitorStart=elapsed;visitorUntil=elapsed+4.5;
   edit=false;overview=false;selected=null;panel=null;placeVisitor();animateVisitor(reducedMotion?1:0);dirty=true;wake();recordHomeActivity('给植物浇水',d.recordSource);notify('找到空位啦，给绿植浇一点水');return;
  }
  if(d.action==='chibi-bed'&&visitor){
   const occupied=(furnitureUser||socialEntries.find(e=>e.id==='user'))?.parkedSeat;if(occupied?.itemId===d.id&&occupied.seatId===d.seat){notify('这个床位已经有人躺着啦');return;}
   const found=roomBeds(current(),catalog).find(s=>s.itemId===d.id&&s.seatId===d.seat);if(!found)return;
   if(isBedLeisure(d.mode)&&(!visitor.rig||!visitorSeat?.bed||visitorSeat.itemId!==found.itemId||visitorSeat.seatId!==found.seatId||seatChange||walking))return;
   const bed={...found,...(visitor.rig&&isBedLeisure(d.mode)?{bedMode:d.mode,modeStart:elapsed}:{})};
   if(visitorSeat?.bed&&visitorSeat.itemId===bed.itemId&&visitorSeat.seatId===bed.seatId&&!seatChange){bed.bedFrom=visitorSeat.bedMode;bed.bedFromTime=elapsed-(visitorSeat.modeStart??elapsed);visitorSeat=bed;visitorMotion=bed.bedMode?'idle':'sleep';visitorStart=elapsed;animateVisitor(0);recordHomeActivity(BED_LEISURE.find(([id])=>id===bed.bedMode)?.[1]||'睡一会儿',d.recordSource);dirty=true;wake();renderUI();return;}
   const bedProfile=visitor.rig&&seatTransform(placementRoom(),catalog,bed,true)?.bed;
   if(bedProfile&&!reducedMotion&&bedProfile.entry!==false){approachBed(bed,d.recordSource);return;}
   stopWalking();visitorLocation=null;visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorPlant=null;visitorSeat=bed;visitorMotion=bed.bedMode?'idle':'sleep';visitorStart=elapsed;visitorUntil=elapsed+4.4;beginSeatChange(false);
   edit=false;overview=false;selected=null;panel=null;placeVisitor();animateVisitor(0);updateSelection();renderer.shadowMap.needsUpdate=true;recordHomeActivity(BED_LEISURE.find(([id])=>id===bed.bedMode)?.[1]||'上床休息',d.recordSource);notify(bed.bedMode?'躺好啦':'躺好啦，睡个好觉');return;
  }
  if(d.action==='chibi-sit'&&visitor){if(guestLife.reserved({roomId:current().id,itemId:d.id,seatId:d.seat},activeResidentId())){notify('这个座位已经有人使用或正在前往');return;}stopWalking();visitorLocation=null;visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);
   const seat=roomSeats(current(),catalog).find(s=>s.itemId===d.id&&s.seatId===d.seat);
   if(!seat)return;visitorPlant=null;visitorSeat={...seat,alternate:d.alternate==='true'&&!!visitor.rig};visitorMotion='idle';visitorStart=elapsed;visitorUntil=elapsed+4.4;
   beginSeatChange(false);
   animateVisitor(0);edit=false;overview=false;selected=null;panel=null;placeVisitor();updateSelection();renderer.shadowMap.needsUpdate=true;
   recordHomeActivity('坐下休息',d.recordSource);notify(currentSeatPose()?.seatPose==='floor'?'双脚放好，在软垫上歇一会儿':'坐好啦，小脚晃不到地面');return;
  }
  if(d.action==='chibi-bed-mode'&&visitor?.rig&&visitorSeat?.bed&&!seatChange){visitorSeat.bedFrom=visitorSeat.bedMode;visitorSeat.bedFromTime=elapsed-(visitorSeat.modeStart??elapsed);visitorSeat.bedMode=isBedLeisure(d.value)?d.value:undefined;visitorSeat.modeStart=elapsed;visitorMotion=visitorSeat.bedMode?'idle':'sleep';visitorStart=elapsed;animateVisitor(0);recordHomeActivity(BED_LEISURE.find(([id])=>id===d.value)?.[1]||'睡一会儿',d.recordSource);dirty=true;wake();renderUI();return;}
  if(d.action==='chibi-stand'&&visitor){visitorPlant=null;visitorMotion='idle';if(!beginSeatChange(true)){visitorSeat=null;visitorStart=elapsed;visitorUntil=0;}placeVisitor();animateVisitor(0);dirty=true;wake();renderUI();return}
  if(d.action==='chibi-motion'&&visitor){
   if(visitorSeat?.bed&&d.value==='sleep'){visitorSeat.bedFrom=visitorSeat.bedMode;visitorSeat.bedFromTime=elapsed-(visitorSeat.modeStart??elapsed);visitorSeat.bedMode=undefined;visitorSeat.modeStart=elapsed;}
   if(['yoga','wave-alternate-1','wave-alternate-2'].includes(d.value)&&!visitor.rig){notify('这组动作适用于二号素体',true);return;}
   if(['yoga','wave-alternate-1','wave-alternate-2'].includes(d.value)&&visitorSeat){notify('先起身，再做这个动作',true);return;}
   if(d.value==='yoga'){
    if(visitorSeat){notify('先起身，再找空地铺垫子',true);return;}
    const map=navMap(),r=current();
    const fits=(px,pz,angle)=>[-.7,0,.7].every(x=>[-2.1,-.5,1.2].every(z=>map.free(px+Math.cos(angle)*x+Math.sin(angle)*z+r.x*ROOM_STEP.x,pz-Math.sin(angle)*x+Math.cos(angle)*z+r.z*ROOM_STEP.z)));
    if(!fits(resident.position.x,resident.position.z,resident.rotation.y)){
     const start=[resident.position.x+r.x*ROOM_STEP.x,resident.position.z+r.z*ROOM_STEP.z],candidates=[];
     for(let x=-ROOM_HALF.x+1;x<ROOM_HALF.x-1;x+=.5)for(let z=-ROOM_HALF.z+1;z<ROOM_HALF.z-1;z+=.5)candidates.push([x,z]);
     candidates.sort((a,b)=>Math.hypot(a[0]-resident.position.x,a[1]-resident.position.z)-Math.hypot(b[0]-resident.position.x,b[1]-resident.position.z));
     for(const [x,z]of candidates)for(const rotation of [0,Math.PI/2,Math.PI,-Math.PI/2])if(fits(x,z,rotation)){
      const target=[x+r.x*ROOM_STEP.x,z+r.z*ROOM_STEP.z];if(!findWalkPath(map,start,target))continue;
      if(walkTo(target)&&walking){walking.arrived=()=>{setResidentHeading(resident,rotation);visitorMotion='yoga';visitorStart=elapsed;visitorUntil=elapsed+meshyMotions.yoga.duration*4;recordHomeActivity('做瑜伽',d.recordSource);message='在垫子上活动一下';renderUI();};notify('去空地铺瑜伽垫');return;}
     }
     notify('这里放不下瑜伽垫，先腾出一块空地',true);return;
    }
   }
   stopWalking();visitorPlant=null;visitorMotion=d.value;recordHomeActivity(motions.find(([id])=>id===d.value)?.[1]||d.value,d.recordSource);visitorStart=elapsed;visitorUntil=elapsed+(d.value==='yoga'?meshyMotions.yoga.duration*4:meshyMotions[d.value]?.duration??4.4);placeVisitor();animateVisitor(reducedMotion?1:0);dirty=true;wake();renderUI();return}
  if(d.action==='view-mode'){setViewMode(viewMode==='flat'?'free':'flat');return;}
  if(d.action==='orbit'){if(viewMode==='flat')return;orbitMode=!orbitMode;controls.enabled=true;renderUI();return}
  if(d.action==='turn-view'){if(viewMode==='flat')return;const offset=camera.position.clone().sub(controls.target);offset.applyAxisAngle(new THREE.Vector3(0,1,0),Number(d.angle));camera.position.copy(controls.target).add(offset);controls.update();dirty=true;wake();return}
  if(d.action==='furniture-outline'){furnitureOutlineEnabled=!furnitureOutlineEnabled;try{localStorage.setItem('sully-home3d-furniture-outline',furnitureOutlineEnabled?'on':'off')}catch{}dirty=true;wake();renderUI();return}
  if(d.action==='character-style'){setCharacterStyle(d.value==='legacy'?'legacy':'modern');return}
  if(d.action==='furniture-style'){furnitureStyle=d.value==='original'?'original':'retro';try{localStorage.setItem('sully-home3d-furniture-style',furnitureStyle)}catch{}rebuild();renderUI();return}
  if(d.action==='light-finish'){finishEnabled=!finishEnabled;try{localStorage.setItem('sully-home3d-light-finish',finishEnabled?'on':'off')}catch{}dirty=true;wake();renderUI();return;}
  if(d.action==='lighting-mode'){setLightingMode(d.value);return;}
  if(d.action==='quality'){quality=d.value;if(!qualities[quality])quality='clear';const q=qualities[quality];detailBudget=q.details;frameInterval=1000/q.fps;renderer.setPixelRatio(roomPixelRatio(quality,devicePixelRatio,touch||phone));try{localStorage.setItem('sully-home3d-quality',quality)}catch{}rebuild();renderUI();return}
  if(d.action==='full-living'){commit(()=>{const room=current(),replacement=createStarterHome(catalog,state.homePalette||'sage').rooms[0];state.livingTemplateBackup=clone(room);Object.assign(room,replacement,{id:room.id,name:room.name,x:room.x,z:room.z,level:room.level});visitorLocation=null;visitorSeat=null;visitorActivity=null;panel=null;selected=null;message='已恢复完整客厅样板，原布置已备份';},{templateUpgrade:true});return;}
  if(d.action==='restore-living'&&state.livingTemplateBackup){commit(()=>{const previous=state.livingTemplateBackup,room=state.rooms.find(r=>r.id===previous.id);if(room)Object.assign(room,clone(previous));delete state.livingTemplateBackup;visitorLocation=null;visitorSeat=null;visitorActivity=null;panel=null;selected=null;},{templateUpgrade:true});return;}
  if(d.action==='upgrade-starter'){commit(()=>{const backup=clone(state);delete backup.starterBackup;state={...state,...createStarterHome(catalog,state.homePalette||'sage'),starterBackup:backup};visitorLocation=null;visitorSeat=null;visitorActivity=null;residentRoom=undefined;panel=null;selected=null;edit=false;overview=false;message='六间样板房已布置好，原小屋已备份';});return;}
  if(d.action==='restore-starter'&&state.starterBackup){commit(()=>{state=clone(state.starterBackup);visitorLocation=null;visitorSeat=null;visitorActivity=null;residentRoom=undefined;panel=null;selected=null;message='已恢复原来的小屋';});return;}

  if(['room-palette','room-style-preset','house-theme'].includes(d.action)&&hasFixedRoomPalette(current())){notify('万圣节小屋保留主题原色，不支持一键染色');return;}
  if(d.action==='home-palette'){commit(()=>{for(const room of state.rooms)applyRoomPalette(room,d.value,catalog);state.homePalette=d.value;message=state.rooms.some(hasFixedRoomPalette)?'配色已更新，万圣节小屋保留原色':'全屋配色已更新';});return;}
  if(d.action==='room-palette'){commit(()=>{applyRoomPalette(current(),d.value,catalog);message='已应用'+ROOM_PALETTES[d.value].name;});return;}
  if(d.action==='reset-room-layout'){const source=defaultRoomLayout(state,current(),catalog);if(!source){notify('这间房没有初始模板',true);return;}if(!confirm('恢复当前房间的初始家具与配色？房间名字和收纳箱会保留，可以撤销。'))return;commit(()=>{const room=current();source.name=room.name;const template=room.defaultTemplate;state=applyRoomLayout(state,room.id,source,catalog);if(template)current().defaultTemplate=template;selected=null;panel=null;rotationPreview=null;message='已恢复当前房间初始布局，可撤销';},{templateUpgrade:true});return;}
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
  if(d.action==='back'){if(overview){overview=false;rebuild();renderUI();}else if(panel){panel=null;renderUI();}else if(edit){edit=false;selected=null;message='';error=false;rebuild();renderUI();}else onBack?.();return}
  if(d.action==='close'){panel=null;renderUI();return}
  if(d.action==='edit'){if(!edit){trackHomeFeature('edit');putPlushBack();stopMirror();visitorActivity=null;gamingEffects.clear();kitchenEffects.updateMeal(null,0);visitorMotion='idle';visitor?.animate(0,'idle',visitorSeat?.bed?'lying':visitorSeat?'seated':'standing',currentSeatPose());}stopWalking();edit=!edit;selected=null;panel=null;message='';error=false;controls.enabled=true;rebuild();resize(true);updateSelection();renderUI();return}
  if(d.action==='room-scope'){if(viewMode==='flat')return;if(!['floor','room'].includes(d.value))return;if(rotationPreview&&!changeItem(rotationPreview))return;stopWalking();visitorLocation=null;roomScope=d.value;overview=false;selected=null;try{localStorage.setItem('sully-home3d-room-scope',roomScope);}catch{}rebuild();renderUI();return;}
  if(d.action==='overview'){stopWalking();overview=!overview;edit=false;panel=null;selected=null;message='';error=false;controls.enabled=true;rebuild();renderUI();return}
  if(onMenu&&(d.action==='expand'||d.action==='showroom'||d.action==='panel'&&['building','expand','chibi'].includes(d.panel)))return;
  if(d.action==='panel'){panel=panel===d.panel?null:d.panel;if(['furniture','storage','building','room-style'].includes(panel)){stopWalking();edit=true;overview=false;controls.enabled=true;rebuild()}renderUI();return}
  if(d.action==='deselect'){selected=null;panel=null;updateSelection();renderUI();return}
  if(d.action==='adopt-pet'){petSystem?.open(null,selected);return;}
  if(d.action==='palette'){panel=panel==='palette'?'selected':'palette';renderUI();return}
  if(d.action==='zoom'){residentFraming=false;camera.zoom=Math.max(controls.minZoom,Math.min(controls.maxZoom,camera.zoom*Number(d.factor)));camera.updateProjectionMatrix();dirty=true;wake();return}
  if(d.action==='redo'){travelHistory(redo,undo);return}
  if(d.action==='undo'){travelHistory(undo,redo);return}
  if(d.action==='building-room'){stopWalking();visitorLocation=null;activateRoom(state.rooms.find(r=>r.id===d.id));selected=null;persist();rebuild();renderUI();return}
  if(d.action==='room'||d.action==='floor'){const r=d.action==='room'?state.rooms.find(r=>r.id===d.id):state.rooms.find(r=>r.level===Number(d.level));if(r){stopWalking();visitorLocation=null;activateRoom(r);overview=false;selected=null;panel=null;persist();rebuild();renderUI()}return}
  if(d.action==='activity-room'){commit(()=>{addActivityRoom(state,d.value,catalog);visitorLocation=null;panel=null;selected=null;overview=false;controls.enabled=true;message='万圣节活动别馆已追加，可从地图进入，也可以撤销';});return;}
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
  if(d.action==='color-preset'){const i=item();if(i&&asset(i.assetId).colorPresets?.some(p=>p.id===d.value))commit(()=>{applyFurnitureColorPreset(selectedOwner().items.find(v=>v.id===selected),asset(i.assetId),d.value);});return;}
  if(d.action==='reset-all-colors'){if(item())commit(()=>resetFurnitureColors(selectedOwner().items.find(v=>v.id===selected)));return;}
  if(d.action==='reset-part-colors'){commit(()=>{if(item())delete selectedOwner().items.find(i=>i.id===selected).materialColors;});return;}
  if(d.action==='color'){if(d.value&&!validFurnitureColor(d.value))return;commit(()=>{if(item())setFurniturePrimaryColor(selectedOwner().items.find(v=>v.id===selected),asset(item().assetId),d.value||null)});return}
  if(d.action==='toggle-dock'){const i=item();if(i)changeItem({dockDisabled:!i.dockDisabled,dockId:null,dockSlot:null});return}
  if(d.action==='store'){commit(()=>{const i=item();if(i){for(const member of furnitureGroup(selectedOwner(),i.id)){member.stored=true;if(member.id===i.id){member.supportId=null;member.dockId=null;member.dockSlot=null;}}}selected=null;panel=null;message='已收纳，桌面小物和吸附的椅子会一起收好';error=false});return}
  if(d.action==='wall'){commit(()=>{current().wall=d.value});return}
  if(d.action==='rename'){const name=ui.querySelector('.h3-rename').value.trim();if(name)commit(()=>{current().name=name});return}
  if(d.action==='export'){try{const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});if(blob.size>16*1024*1024)throw Error('整屋备份超过 16 MB，请在设置中使用整合导出');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='我的小屋.json';a.click();trackHomeTransfer('export-home');setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){notify(e.message,true);}return}
  if(d.action==='import'){const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.onchange=async()=>{try{const f=input.files?.[0];if(!f)return;if(f.size>16*1024*1024)throw Error('整屋备份过大（上限 16 MB）');const text=await f.text();if(destroyed)return;const incoming=validateHome(JSON.parse(text),catalog);const budgetError=phone&&phoneBudgetError(null,incoming,catalog);if(budgetError)throw Error(budgetError);if(commit(()=>{state=incoming;selected=null;panel=null;message='布置已导入，可撤销回到刚才的房间'},{restoreLife:true}))trackHomeTransfer('import-home')}catch(e){notify(e.message,true)}};input.click();}
 }
 ui.addEventListener('input',e=>{if(!e.target.matches?.('.h3-furniture-search')||e.isComposing)return;furnitureQuery=e.target.value;renderUI();const input=ui.querySelector('.h3-furniture-search');input?.focus();},{signal:abort.signal});
 ui.addEventListener('compositionend',e=>{if(e.target.matches?.('.h3-furniture-search')){furnitureQuery=e.target.value;renderUI();ui.querySelector('.h3-furniture-search')?.focus();}},{signal:abort.signal});
 ui.addEventListener('click',action,{signal:abort.signal});
 actionOrbit.addEventListener('click',action,{signal:abort.signal});
 ui.addEventListener('change',e=>{const input=e.target;if(input.matches?.('[data-showroom-palette]')){showroomPalette=input.value;return;}if(input.matches?.('[data-material-color]')){const i=item(),name=input.dataset.materialColor;if(i&&i.materialColors?.[name]!==input.value&&validFurnitureColor(input.value)&&asset(i.assetId).colorParts?.some(p=>p.material===name)){const color=input.value;commit(()=>{const target=selectedOwner().items.find(v=>v.id===selected);target.materialColors={...target.materialColors,[name]:color};});}return;}if(input.matches?.('[data-catalog-category]')){if(input.value==='all'||input.value in USE_CATEGORIES){category=input.value;renderUI();}return;}if(!input.matches?.('[data-furniture-color]')||!validFurnitureColor(input.value)||!item())return;const color=input.value;commit(()=>{setFurniturePrimaryColor(selectedOwner().items.find(v=>v.id===selected),asset(item().assetId),color);});},{signal:abort.signal});
 function closeInteraction(){interaction=null;actionOrbit.hidden=true;actionOrbit.replaceChildren();}
 function interactionOptions(id){return furnitureInteractions(current(),catalog,id,{activities:activities(),seat:visitorSeat,held:heldPlush,active:visitorActivity||kitchenTask,fridgeOpen:kitchenEffects.isOpen(id),clearance:visitorClearance(),body2:!!visitor?.rig,transitioning:!!seatChange||!!walking});}
 function openInteraction(id){
  if(interaction?.itemId===id){closeInteraction();return;}
  closeInteraction();const owner=state.rooms.find(r=>r.items.some(i=>i.id===id&&!i.stored));if(!owner)return;
  if(owner.id!==current().id){activateRoom(owner);persist();rebuild();}
  if(!useFurnitureUser())return;
  const options=interactionOptions(id);if(!options.length)return;
  panel=null;selected=null;edit=false;renderUI();
  interaction={itemId:id,page:0,options};renderInteraction();host.focus({preventScroll:true});
 }
 function openPetInteraction(id){
  if(interaction?.petId===id){closeInteraction();return;}
  closeInteraction();const options=petSystem?.interactionOptions(id);if(!options?.length)return;
  panel=null;selected=null;renderUI();interaction={petId:id,page:0,options};renderInteraction();actionOrbit.querySelector('button.social-petal')?.focus({preventScroll:true});
 }
 function positionInteraction(){
  if(!interaction||actionOrbit.hidden)return;
  if(interaction.petId){const options=petSystem.interactionOptions(interaction.petId);if(JSON.stringify(options)!==JSON.stringify(interaction.options)){renderInteraction();return;}}
  const obj=interaction.petId?petSystem?.getObject(interaction.petId):objects.find(o=>o.userData.itemId===interaction.itemId);if(!obj||!isVisible(obj)){closeInteraction();return;}
  obj.updateWorldMatrix(true,true);camera.updateMatrixWorld();
  const bounds=new THREE.Box3().setFromObject(obj),point=bounds.getCenter(new THREE.Vector3()).project(camera);
  if(point.z< -1||point.z>1){closeInteraction();return;}
  if(interaction.petId){
   const layout=socialWheelLayout((point.x+1)*size.w/2,(1-point.y)*size.h/2,size.w,size.h,interaction.shown.length);
   Object.assign(actionOrbit.style,{left:'0px',top:'0px',width:size.w+'px',height:size.h+'px'});
   actionOrbit.querySelectorAll('.social-petal').forEach((button,i)=>{button.style.left=layout.points[i].x+'px';button.style.top=layout.points[i].y+'px';});
   const navigation=actionOrbit.querySelector('.social-wheel-navigation');
   navigation.style.left=Math.max(76,Math.min(size.w-76,layout.center.x))+'px';
   navigation.style.top=Math.min(size.h-60,Math.max(...layout.points.map(p=>p.y))+58)+'px';
   return;
  }
  let minX=Infinity,maxX=-Infinity;
  for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){
   const projected=new THREE.Vector3(x,y,z).project(camera),sx=(projected.x+1)*size.w/2;minX=Math.min(minX,sx);maxX=Math.max(maxX,sx);
  }
  const layout=interactionArcLayout({x:(point.x+1)*size.w/2,y:(1-point.y)*size.h/2,width:size.w,height:size.h,count:interaction.shown.length,modelWidth:interaction.petId?Math.max(320,maxX-minX):maxX-minX});
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
  interaction.options=interaction.petId?petSystem.interactionOptions(interaction.petId):interactionOptions(interaction.itemId);const perPage=interaction.petId?(size.h<560?3:4):size.h<500?1:3,pages=Math.ceil(interaction.options.length/perPage);if(!pages){closeInteraction();return;}
  interaction.page%=pages;interaction.shown=interaction.options.slice(interaction.page*perPage,interaction.page*perPage+perPage);
  const i=current().items.find(i=>i.id===interaction.itemId),name=interaction.petId?petSystem.life.data.pets.find(p=>p.id===interaction.petId)?.name:asset(i.assetId).name;
  actionOrbit.hidden=false;actionOrbit.setAttribute('role','group');actionOrbit.setAttribute('aria-label',name+'的动作');
  actionOrbit.classList.toggle('home-social-wheel',!!interaction.petId);actionOrbit.classList.toggle('h3-pet-wheel',!!interaction.petId);
  if(interaction.petId){
   actionOrbit.innerHTML=interaction.shown.map((a,j)=>`<button type="button" class="social-petal" style="--petal-index:${j}" data-action="${a.action}" data-id="${esc(a.id)}" ${a.kind?`data-kind="${a.kind}"`:''} ${a.kind==='pet'?'data-affection="true"':''} ${a.reason?`aria-disabled="true" data-blocked="${esc(a.reason)}"`:''} title="${esc(a.reason||a.label)}" aria-label="${esc(a.label+(a.reason?'：'+a.reason:''))}"><i class="social-petal-icon">${petIcon(a.icon)}</i><span>${esc(a.label)}</span></button>`).join('')+`<div class="social-wheel-near-pages social-wheel-navigation"><button type="button" data-action="interaction-back" aria-label="${interaction.page?'上一组互动':'返回家园'}"><span>${petIcon('back')}返回</span></button><span class="social-wheel-page-count" aria-live="polite">${interaction.page+1}/${pages}</span>${pages>1?`<button type="button" data-action="interaction-more" aria-label="下一组互动"><span class="h3-pet-next">${petIcon('back')}</span></button>`:''}</div>`;
   positionInteraction();return;
  }
  const isBed=interaction.options.some(a=>a.action==='chibi-bed'),isSeat=interaction.options.some(a=>a.action==='chibi-sit');
  const heading=interaction.petId?'想陪它做什么？':isBed?(interaction.options.filter(a=>a.action==='chibi-bed').length>1?'想睡在哪一边？':'躺下来休息吧'):isSeat?'在这里歇一会儿':'想和它做点什么？',hint=interaction.petId?'直接互动，也可以打开宠物面板':isBed?'选个舒服的位置，躺下来吧':isSeat?'挑个座位，慢慢待着':'点一个动作，让孩子来试试';
  actionOrbit.innerHTML=`<div class="h3-interaction-glow"></div><svg class="h3-interaction-arc" aria-hidden="true"><path/></svg><button class="h3-interaction-close" data-action="interaction-close" aria-label="关闭互动动作">×</button><div class="h3-interaction-caption">${interactionIcon('jelly')}<strong>${heading}</strong><span>${hint}</span><small>${esc(name)}</small></div>${interaction.shown.map((a,j)=>`<button class="h3-interaction-choice" style="--order:${j}" data-action="${a.action}" data-id="${esc(a.id)}" ${a.mode?`data-mode="${a.mode}"`:""} ${a.alternate?`data-alternate="true"`:""} ${a.seat?`data-seat="${esc(a.seat)}"`:''} ${a.kind?`data-kind="${a.kind}" data-station="${esc(a.station)}"`:''} ${a.reason?`aria-disabled="true" data-blocked="${esc(a.reason)}"`:''} title="${esc(a.reason||a.label)}" aria-label="${esc(a.label+(a.reason?'：'+a.reason:''))}">${a.icon?petIcon(a.icon):actionIcon(a.action,a.kind)}<span>${esc(a.label)}</span>${a.reason?'<small>查看条件</small>':''}<i aria-hidden="true">✦</i></button>`).join('')}${pages>1?`<button class="h3-interaction-more" data-action="interaction-more">更多行动 · ${interaction.page+1}/${pages}</button>`:''}`;

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
 function isWalkableRug(object){const owner=state.rooms.find(r=>r.id===object?.userData.roomId),i=owner?.items.find(i=>i.id===object?.userData.itemId);return asset(i?.assetId)?.surface==='rug';}
 function pick(e){coordinates(e);const hits=raycaster.intersectObjects(content.children,true);for(const hit of hits){let ancestor=hit.object,visible=true;while(ancestor){if(!ancestor.visible){visible=false;break;}ancestor=ancestor.parent;}if(!visible)continue;let o=hit.object;while(o&&!o.userData.itemId&&!o.userData.roomId)o=o.parent;if(o)return o}return null}
 const activePointers=new Set();let multiGesture=false;
 syncCameraControls();controls.touches.TWO=THREE.TOUCH.DOLLY_PAN;controls.mouseButtons.LEFT=viewMode==='free'?THREE.MOUSE.ROTATE:THREE.MOUSE.PAN;controls.mouseButtons.RIGHT=THREE.MOUSE.PAN;
 let lastResidentTap=null;
 function isVisible(object){for(let o=object;o;o=o.parent)if(!o.visible)return false;return true;}
 function pickResident(e,details=false){
  if(!visitor||overview)return null;
  coordinates(e);content.updateWorldMatrix(true,true);
  const residents=[{id:activeResidentId(),group:resident},...socialEntries].filter(e=>e.group.visible);
  const hits=residents.flatMap(entry=>{entry.group.updateWorldMatrix(true,true);entry.group.updateMatrixWorld(true);entry.group.traverse(o=>{if(o.isSkinnedMesh)o.computeBoundingSphere();});const hit=raycaster.intersectObjects(entry.group.children,true).find(h=>isVisible(h.object));return hit?[{id:entry.id,distance:hit.distance,point:hit.point}]:[];}).sort((a,b)=>a.distance-b.distance);
  const actor=hits[0];if(!actor)return null;
  const obstacle=raycaster.intersectObjects(content.children,true).find(h=>isVisible(h.object));
  return !obstacle||actor.distance<=obstacle.distance+.01?(details?actor:actor.id):null;
 }
 function roomResidents(){return [...(visitor&&resident.visible?[{id:activeResidentId(),group:resident}]:[]),...socialEntries.filter(e=>e.group.visible)].map(e=>({...e,label:residentPortraits[e.id]?.label||(e.id===primaryResidentId?ownerName:e.label)||'你'}));}
 function syncPortraitRail(){
  const entries=onMenu&&!edit&&!overview?roomResidents():[];
  const pets=petSystem?.life.data.pets||[];
  const signature=JSON.stringify([pets.map(p=>[p.id,p.name,p.color,p.materialColors]),residentRoom,current().id,onMenu,edit,overview,entries.map(e=>[e.id,e.label,residentPortraits[e.id]?.avatar]),cameraResident]);if(signature===portraitSignature)return;portraitSignature=signature;
  portraitRail.hidden=firstPerson||!onMenu||edit||overview;portraitRail.innerHTML=entries.map(e=>{const avatar=residentPortraits[e.id]?.avatar||'',picture=/^(https?:|blob:|data:image\/|\/)/.test(avatar);return '<button type="button" data-resident="'+esc(e.id)+'" aria-label="定位'+esc(e.label)+'" aria-pressed="'+(cameraResident===e.id)+'"><span class="h3-resident-face"><span>'+esc(picture||avatar.startsWith('blobref:')?Array.from(e.label)[0]:avatar||Array.from(e.label)[0])+'</span>'+(picture?'<img src="'+esc(avatar)+'" alt="" draggable="false">':'')+'</span><span class="h3-resident-name">'+esc(e.label)+'</span></button>';}).join('')+pets.map(p=>'<button type="button" data-home-pets="'+esc(p.id)+'" aria-label="宠物 '+esc(p.name)+'"><span class="h3-resident-face"><img src="'+esc(petSystem.portrait(p))+'" alt=""/></span><span class="h3-resident-name">'+esc(p.name)+'</span></button>').join('')+(residentRoom!==current().id?'<button class="h3-summon-all" type="button" data-summon-all aria-label="把大家叫过来">把大家<br>叫过来</button>':'');
 }
 function centerResident(id){
  const entry=roomResidents().find(e=>e.id===id);if(!entry)return;
  if(greeting)greeting.restoreWide=false;
  const from={position:camera.position.clone(),target:controls.target.clone(),zoom:camera.zoom};
  entry.group.updateWorldMatrix(true,true);const box=new THREE.Box3();entry.group.traverse(o=>{if(o.isMesh&&isVisible(o))box.union(new THREE.Box3().setFromObject(o));});const target=box.isEmpty()?entry.group.position.clone():box.getCenter(new THREE.Vector3());
  const shift=target.clone().sub(controls.target);cameraArrival={from,to:{position:camera.position.clone().add(shift),target,zoom:camera.zoom},start:elapsed};
  cameraResident=id;residentFraming=false;dirty=true;wake();
 }
 function focusResident(id=activeResidentId(),lock=false){
  if(!visitor||overview)return;
  const subject=id===activeResidentId()?resident:socialEntries.find(e=>e.id===id)?.group;if(!subject?.visible)return;if(lock){viewMode='flat';syncCameraControls();}
  resident.updateWorldMatrix(true,true);
  const box=new THREE.Box3();subject.traverse(o=>{if(o.isMesh&&isVisible(o))box.union(new THREE.Box3().setFromObject(o));});if(box.isEmpty())return;
  const center=box.getCenter(new THREE.Vector3()),offset=camera.position.clone().sub(controls.target);
  controls.target.copy(center);camera.position.copy(center).add(offset);controls.update();camera.updateMatrixWorld(true);
  const projected=box.clone().applyMatrix4(camera.matrixWorldInverse).getSize(new THREE.Vector3());
  camera.zoom=THREE.MathUtils.clamp(Math.min((camera.right-camera.left)*.72/Math.max(.1,projected.x),(camera.top-camera.bottom)*.78/Math.max(.1,projected.y)),controls.minZoom,controls.maxZoom);
  residentFraming=true;camera.clearViewOffset();camera.updateProjectionMatrix();panel=null;selected=null;updateSelection();dirty=true;wake();renderUI();
 }
 function down(e){if(photoSession)return;if(firstPerson){if(e.button===0)pointerDown={x:e.clientX,y:e.clientY,actor:pickResident(e)};return;}if(photoSession)return;
  if(greeting)greeting.restoreWide=false;cameraArrival=null;
  activePointers.add(e.pointerId);
  if(activePointers.size>1){multiGesture=true;if(drag){drag=null;rebuild()}pointerDown=null;lastResidentTap=null;syncCameraControls();return}
  if(e.button!==0)return;const actor=pickResident(e),picked=pick(e);pointerDown={x:e.clientX,y:e.clientY,picked,actor,moved:false};if(!edit&&!overview){coordinates(e);pointerDown.pet=petSystem?.pick(raycaster,[...content.children,resident,...socialEntries.map(e=>e.group)]);if(pointerDown.pet)return;}if(actor)return;
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
  windowDaylight.preview(next.id,next);configureWindowSun();
  for(const child of furnitureGroup(preview,next.id).filter(i=>i.id!==next.id)){const mesh=objects.find(o=>o.userData.itemId===child.id);if(mesh){objectPose(mesh,child)}}
  selection.setFromObject(obj);placementGuide(obj,!why);dirty=true;wake();
 }

 function up(e){if(photoSession)return;if(firstPerson){if(e.type!=='pointercancel'&&pointerDown?.actor&&Math.hypot(e.clientX-pointerDown.x,e.clientY-pointerDown.y)<8)pokeHomelyResident(pickResident(e,true));pointerDown=null;return;}if(photoSession)return;
  if(e.type==='pointercancel')closeInteraction();
  activePointers.delete(e.pointerId);syncCameraControls();
  if(multiGesture){if(!activePointers.size)multiGesture=false;pointerDown=null;return}
  if(drag&&drag.id===e.pointerId){const final=drag;drag=null;placementGuide(null);dirty=true;wake();selection.material.color.set('#9d80bd');
   if(e.type==='pointercancel'||!final.valid){rebuild();notify(e.type==='pointercancel'?'已取消移动':final.why||message,true)}
   else if(rotationPreview||JSON.stringify(final.start)!==JSON.stringify(final.candidate))changeItem(final.candidate);
   pointerDown=null;return;
  }
  if(e.type!=='pointercancel'&&pointerDown&&!pointerDown.moved&&Math.hypot(e.clientX-pointerDown.x,e.clientY-pointerDown.y)<8){const p=pointerDown.picked;
   if(pointerDown.pet){openPetInteraction(pointerDown.pet);pointerDown=null;return;}
   if(pointerDown.actor){
    closeInteraction();const actor=pointerDown.actor,now=performance.now();
    if(lastResidentTap&&now-lastResidentTap.time<400&&Math.hypot(e.clientX-lastResidentTap.x,e.clientY-lastResidentTap.y)<24){lastResidentTap=null;clearTimeout(tapTimer);focusResident(actor,false);}
    else {lastResidentTap={time:now,x:e.clientX,y:e.clientY};clearTimeout(tapTimer);tapTimer=setTimeout(()=>{if(!destroyed&&onMenu&&!edit)onMenu('interact',actor);},400);}
    pointerDown=null;return;
   }
   lastResidentTap=null;
   if(overview&&p?.userData.roomId){stopWalking();visitorLocation=null;state.activeRoomId=p.userData.roomId;overview=false;persist();rebuild();renderUI()}
   else if(edit&&p?.userData.itemId)select(p.userData.itemId);
   else if(edit&&!onMenu&&p?.userData.boundaryEdge){activateRoom(state.rooms.find(r=>r.id===p.userData.roomId));boundaryEdge=p.userData.boundaryEdge;selected=null;panel='building';persist();rebuild();renderUI();}
   else if(edit&&p?.userData.roomId&&p.userData.roomId!==current().id){stopWalking();visitorLocation=null;activateRoom(state.rooms.find(r=>r.id===p.userData.roomId));selected=null;persist();rebuild();renderUI();}
   else if(edit){if(rotationPreview){changeItem(rotationPreview);}else{selected=null;panel=null;updateSelection();renderUI()}}
   else if(!overview&&visitor&&p?.userData.itemId&&!isWalkableRug(p)){openInteraction(p.userData.itemId);}
   else if(!overview&&visitor){
    closeInteraction();coordinates(e);
    // A rug receives the tap as floor in visit mode; furniture/edit picking stays intact.
    const point=isWalkableRug(p)?raycaster.intersectObject(p,true).find(h=>isVisible(h.object))?.point:raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-.18),new THREE.Vector3());
    if(point&&getResidentPosture(manualControl===primaryResidentId?primaryResidentId:'user')==='standing'&&useFurnitureUser())walkTo([point.x+current().x*ROOM_STEP.x,point.z+current().z*ROOM_STEP.z],{targetRadius:.6,feedback:true});
   }
  }if(e.type==='pointercancel')lastResidentTap=null;pointerDown=null;
 }
 for(const [name,fn] of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up]])renderer.domElement.addEventListener(name,fn,{signal:abort.signal,capture:true});
 function keydown(e){if(photoSession)return;if(e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement||e.target.isContentEditable)return;if(e.key==='Escape'){stopSocial();closeInteraction();if(rotationPreview){cancelRotation();return;}panel=null;selected=null;updateSelection();renderUI()}if(e.key==='f'){if(document.fullscreenElement)document.exitFullscreen();else host.requestFullscreen?.()}if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();ui.querySelector('[data-action="'+(e.shiftKey||e.key.toLowerCase()==='y'?'redo':'undo')+'"]')?.click()}if(edit&&item()){const deltas={ArrowLeft:[-.2,0],ArrowRight:[.2,0],ArrowUp:[0,-.2],ArrowDown:[0,.2]};if(deltas[e.key]){e.preventDefault();const [x,z]=deltas[e.key],a=asset(item().assetId);changeItem({x:item().x+(a.surface==='left'?0:x),z:item().z+(a.surface==='back'?0:z)})}}}
 host.tabIndex=0;host.addEventListener('keydown',keydown,{signal:abort.signal});
 const observer=new ResizeObserver(()=>resize());observer.observe(stage);
 function tick(now=performance.now()){
  frame=0;if(destroyed||suspended||document.hidden||roomLoading)return;if(photoSession){lastTick=now;if(dirty){photoRenderer?.invalidate();dirty=false;for(const notify of photoListeners)notify();}return;}inTick=true;const dt=Math.min(.05,(now-lastTick)/1000);lastTick=now;
  if(greeting&&elapsed>=greeting.until){setResidentExpression(primaryResidentId,greeting.old||{});const restoreWide=greeting.restoreWide;greeting=null;visitorMotion='idle';if(restoreWide){const from={position:camera.position.clone(),target:controls.target.clone(),zoom:camera.zoom};resize(true,true);cameraArrival={from,to:{position:camera.position.clone(),target:controls.target.clone(),zoom:camera.zoom},start:elapsed};}}
  updateCompanion();
  if(cameraArrival){const t=THREE.MathUtils.smootherstep(elapsed-cameraArrival.start,0,reducedMotion?.01:1.1),{from,to}=cameraArrival;camera.position.copy(from.position).lerp(to.position,t);controls.target.copy(from.target).lerp(to.target,t);camera.zoom=THREE.MathUtils.lerp(from.zoom,to.zoom,t);camera.updateProjectionMatrix();dirty=true;if(t>=1)cameraArrival=null;}
  let settling=false;if(!manual&&!document.hidden)elapsed+=dt;
  const petMoving=petSystem?.update(manual?0:dt);if(petMoving)dirty=true;
  if(!document.hidden&&now-lastDraw>=frameInterval-.5){
   if(petSystem?.consumeShadowChange())invalidateRoomShadows();
   const applianceChanged=kitchenEffects.updateDoors(manual?0:dt,reducedMotion);if(applianceChanged){dirty=true;invalidateRoomShadows();}
   const breathing=animated.length&&!overview&&!reducedMotion&&qualities[quality].motion;
   if(breathing)for(const a of animated)a.o.position.y=a.y+Math.sin(elapsed*a.speed+a.phase)*a.amplitude;
   const acting=visitor&&resident.visible&&!edit&&(!!socialRuntime?.active||!!walking||!!petSystem?.contactBusy||!!kitchenTask||!reducedMotion&&(qualities[quality].motion||!!conversation||elapsed<visitorUntil));
   if(acting&&!companionRise&&!(companionTravel&&!furnitureUser))animateVisitor(elapsed-visitorStart);
   animateIdleResidents();animateParkedCharacter();if(furnitureUser)animateConversation();animateCompanionIdle();animateCompanionPhone();animateUserSpeech();faceNearbyResidents();faceConversationPartner();
   settling=controls.update();if(dirty||homelyAttention||homelyMusic.playing&&!reducedMotion||homelyPoke||breathing||acting||hasIdleResidents()||drag||walkFeedback.active){renderScene();renderedFrames++;dirty=false;lastDraw=now}
  }
  inTick=false;if(homelyAttention||homelyMusic.playing&&!reducedMotion&&qualities[quality].motion||homelyMusic.weight>.001||homelyPoke||hasIdleResidents()||companionGesture||companionPhone||companionRise||companionIdle||companionTravel||companionFacing||companionSmile||petMoving||cameraArrival||settling||dirty||drag||walkFeedback.active||kitchenEffects.moving||animated.length&&!overview&&!reducedMotion&&qualities[quality].motion||visitor&&resident.visible&&!edit&&(!!socialRuntime?.active||!!walking||!!petSystem?.contactBusy||!!kitchenTask||!reducedMotion&&(qualities[quality].motion||!!conversation||elapsed<visitorUntil)))wake();
 }
 document.addEventListener('visibilitychange',()=>{if(document.hidden){petSystem?.life.save();clearTimeout(faceTimer);faceTimer=0;cancelAnimationFrame(frame);frame=0}else{if(refreshRoomLighting())renderUI();dirty=true;lastTick=performance.now();wake()}scheduleRoomLighting();},{signal:abort.signal});
 const unsubscribeCharacterStyle=subscribeCharacterStyle(()=>{dirty=true;wake();for(const button of ui.querySelectorAll('[data-action="character-style"]'))button.setAttribute('aria-pressed',String(button.dataset.value===getCharacterStyle()));});
 function dispose(){unsubscribeResourcePacks();releasePackImages();unsubscribeCharacterStyle();photoRenderer?.dispose();photoRenderer=null;photoListeners.clear();homelyForeground?.dispose();homelyForeground=null;parkedMealEffects?.dispose();parkedMealEffects=null;userSpeech=null;cancelCompanionAction();petSystem?.dispose();petSystem=null;interiorBackdrop.dispose();clearTimeout(tapTimer);lampGlow.dispose();walkFeedback.dispose();clearTimeout(faceTimer);faceTimer=0;clearTimeout(lightTimer);lightTimer=0;if(destroyed&&!kit)return;stopSocial();for(const e of [...socialEntries])removeSocialResident(e.id);gamingEffects.clear();clearComparison();visitor?.dispose();visitor=null;watering.dispose();mat.geometry.dispose();mat.material.dispose();kitchenEffects.dispose();kitchenWork.dispose();bathroomEffects.dispose();finishes.dispose();windowDaylight.dispose();resident.clear();destroyed=true;abort.abort(homeDisposalReason());observer.disconnect();cancelAnimationFrame(frame);controls.dispose();clearContent();for(const m of materialCache.values())m.dispose();materialCache.clear();kit?.scene.traverse(o=>{if(o.isMesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material]){for(const value of Object.values(m))if(value?.isTexture)value.dispose();m.dispose()}}});distantGeometry.dispose();for(const m of distantMaterials.values())m.dispose();distantMaterials.clear();key.shadow.dispose();grid.geometry.dispose();grid.material.dispose();footprint.geometry.dispose();footprint.material.dispose();for(const material of outlineMaterials)material.dispose();ground.geometry.dispose();ground.material.dispose();selection.geometry.dispose();selection.material.dispose();furnitureHalo.dispose();roomFinish.dispose();renderer.dispose();host.innerHTML='';host.classList.remove('home3d');}
 signal?.addEventListener('abort',dispose,{once:true});
 try{
  [catalog,kit]=await Promise.all([fetch(new URL('catalog.json',assetBase),{signal:abort.signal,cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('家具目录加载失败');return r.json()}),fetch(new URL('kit.glb',assetBase),{signal:abort.signal}).then(r=>{if(!r.ok)throw Error('家具模型加载失败');return r.arrayBuffer()}).then(data=>new GLTFLoader().parseAsync(data,assetBase))]);
  if(destroyed){dispose();return {dispose}}
  const doorData=await fetch(new URL('showroom-door.glb',assetBase),{signal:abort.signal}).then(r=>{if(!r.ok)throw Error('蝴蝶结门加载失败');return r.arrayBuffer()});
  ribbonDoorTemplate=(await new GLTFLoader().parseAsync(doorData,assetBase)).scene;kit.scene.add(ribbonDoorTemplate);
  catalog.push(...BUILDING_ASSETS);for(const a of catalog)assetIndex.set(a.id,a);
  for(const root of createBuildingTemplates())kit.scene.add(root);
  for(const root of kit.scene.children)if(root.userData.assetId){const id=root.userData.assetId;templates.set(id,root);const mats=[];root.traverse(o=>{if(o.isMesh)mats.push(...(Array.isArray(o.material)?o.material:[o.material]))});const names=furniturePaintMaterials(asset(id),mats.map(m=>m.name));paintTargets.set(id,names);defaultPaintColors.set(id,"#"+(mats.find(m=>names.includes(m.name))?.color.getHexString()||"b2a2cd"));}
  // Give window sunlight a real aperture instead of shining through a solid wall.
  for(const a of catalog)if((a.daylight||a.id==='wooden_window')&&!a.wallOpening){const root=templates.get(a.id),opening=root&&inferWindowAperture(root);if(opening)a.wallOpening=opening;}
  let incoming=initialState;
  if(!incoming&&storageKey){const text=localStorage.getItem(storageKey);if(text)incoming=JSON.parse(text)}
  state=incoming?validateHome(incoming,catalog):(onMenu?createStarterHome(catalog):createHome(catalog));residentRoom=state.rooms.some(r=>r.id===state.residentRoomId)?state.residentRoomId:state.activeRoomId;if(onMenu)state.activeRoomId=residentRoom;journal=readHomeRecords(state);state.records=journal;
  for(const record of journal)knownHomeRecords.set(record.id,record);
  await Promise.all([...new Set([...current().items.filter(i=>!i.stored).map(i=>i.assetId),...catalog.filter(a=>a.petSpecies).map(a=>a.id)])].filter(id=>!templates.has(id)).map(ensureAsset));
  if(destroyed)return {dispose};
  for(const a of catalog)thumbs.set(a.id,new URL('thumbnails/'+a.id+'.png'+(a.revision?'?v='+encodeURIComponent(a.revision):''),assetBase).href);
  petSystem=mountPetSystem({host,scene,getHour:()=>nowInTimeZone(timeZone).getHours(),showEntry:!onMenu,onEvent:event=>{const record=petHomeRecord(event,state,residentPortraits.user?.label||'用户');if(record){journal.push(record);persist();}},contactBridge:beginPetContact,beforeOpen:closeInteraction,home:()=>state,catalog,templates,changed:(rebuildScene=false)=>{persist();if(rebuildScene){rebuild();renderUI();}},invalidate:()=>{dirty=true;wake();},context:()=>({paused:suspended||document.hidden,edit,overview,reducedMotion}),actors:()=>{const entries=[...(visitor&&resident.visible?[{id:activeResidentId(),group:resident}]:[]),...socialEntries.filter(e=>e.group.visible)];return entries.map(e=>({id:e.id,roomId:current().id,x:e.group.position.x,z:e.group.position.z,busy:!!walking||!!socialRuntime?.active||!!kitchenTask||!!visitorActivity||!!visitorSeat}));}});
  if(!incoming||JSON.stringify(incoming)!==JSON.stringify(state))persist();
  host.querySelector('.h3-loading').remove();rebuild();renderUI();tick();
  if(thumbnailExport){
  await Promise.all(catalog.filter(a=>a.url&&!templates.has(a.id)).map(a=>ensureAsset(a.id)));
  // Offline export only: never render the entire catalogue on a user device.
  const ts=new THREE.Scene();ts.background=new THREE.Color('#f1e8ee');ts.add(new THREE.HemisphereLight('#fff7f0','#aca1b9',2.5));const tl=new THREE.DirectionalLight('#fff5e7',3);tl.position.set(3,6,4);ts.add(tl);
  const tc=new THREE.OrthographicCamera(-2,2,2,-2,.1,100);const target=new THREE.WebGLRenderTarget(128,100);const pixels=new Uint8Array(128*100*4);const canvas=document.createElement('canvas');canvas.width=128;canvas.height=100;const ctx=canvas.getContext('2d');
  for(const a of catalog.filter(a=>a.id!=='shell')){const obj=templates.get(a.id)?.clone(true);if(!obj)continue;ts.add(obj);const b=new THREE.Box3().setFromObject(obj),c=b.getCenter(new THREE.Vector3()),s=b.getSize(new THREE.Vector3());const h=Math.max(s.x,s.y,s.z)*1.3+.1;tc.left=-h*.64;tc.right=h*.64;tc.top=h/2;tc.bottom=-h/2;tc.position.copy(c).add(new THREE.Vector3(6,5,8));tc.lookAt(c);tc.updateProjectionMatrix();renderer.setRenderTarget(target);renderer.render(ts,tc);renderer.readRenderTargetPixels(target,0,0,128,100,pixels);const image=ctx.createImageData(128,100);for(let y=0;y<100;y++)image.data.set(pixels.subarray((99-y)*512,(100-y)*512),y*512);ctx.putImageData(image,0,0);thumbs.set(a.id,canvas.toDataURL());ts.remove(obj)}
  renderer.setRenderTarget(null);target.dispose();await thumbnailExport(Object.fromEntries(thumbs));dirty=true;wake();renderUI();
  }
 }catch(e){if(destroyed)return {dispose};dispose();host.innerHTML=`<div class="h3-loading"><span>${esc(e.message)}</span><button>重新加载</button></div>`;host.querySelector('button').onclick=()=>location.reload();throw e}
 scheduleRoomLighting();
 return {canPlaySocial,setRomanticRelation,isSocialReplyBusy:()=>socialReplyBusy,setSocialReplyBusy(value){socialReplyBusy=!!value;},getPresentResidents,getResidentScene,performResidentActions,performGuestAction:(id,action)=>guestLife.start(id,action),getGuestActions:id=>guestLife.actions(id),setJoinedResidentIds(ids){state.socialMemberIds=[...new Set(ids)].filter(id=>typeof id==="string"&&id!==primaryResidentId).slice(0,3);persist();},startHomelyAttention,cancelHomelyAttention,setHomelyMusic(value){homelyMusic={...homelyMusic,playing:!!value.playing,position:Number.isFinite(value.position)?value.position:0,at:elapsed};dirty=true;wake();},setHomelyChatOpen(value){if(!firstPerson)return;homelyChatOpen=value;dirty=true;wake();},beginPhotoMode(){if(photoSession)return photoSession.actors;closeInteraction();clearTimeout(tapTimer);pointerDown=null;controls.enabled=false;photoSession=createPhotoSession({canInteract:canPlaySocial,actors:[{id:activeResidentId(),label:residentPortraits[activeResidentId()]?.label||ownerName,root:resident,person:visitor},...socialEntries.map(e=>({id:e.id,label:e.label,root:e.group,person:e.visitor}))],camera,controls,invalidate:(shadows=true)=>{if(shadows)invalidateRoomShadows();photoRenderer?.invalidate();for(const notify of photoListeners)notify();}});photoRenderer=createPhotoRenderer(renderer,camera,()=>{const reset=photoSession?.prepare();try{renderScene();}finally{reset?.();}});return photoSession.actors;},endPhotoMode(){if(!photoSession)return;photoRenderer?.dispose();photoRenderer=null;photoSession.restore();photoSession=null;resize();if(photoPendingRoom){const pending=photoPendingRoom;photoPendingRoom=null;setResidentRoom(pending.id);}syncCameraControls();lastTick=performance.now();dirty=true;wake();},setPhotoCamera(values){photoSession?.camera(values);},setPhotoTogether(gap){photoSession?.together(gap);},setPhotoPose(id,motion,time){return photoSession?.pose(id,motion,time)??Promise.resolve();},setPhotoInteraction(id,a,b,time){return photoSession?.interaction(id,a,b,time)??Promise.resolve();},setPhotoTurn(id,degrees){photoSession?.turn(id,degrees);},setPhotoFace(id,values){photoSession?.face(id,values);},subscribePhoto(notify){photoListeners.add(notify);return ()=>photoListeners.delete(notify);},renderPhoto(canvas,look,options){if(photoRenderer){photoRenderer.render(canvas,look,options);return;}renderScene();paintPhoto(renderer.domElement,canvas,look);},setPhoneReply,capturePhoto:()=>{renderScene();return new Promise((resolve,reject)=>renderer.domElement.toBlob(blob=>blob?resolve(blob):reject(new Error("照片生成失败")),"image/png"));},playUserSpeech,playHomeResponse,getCompanionSnapshot,performCompanionAction,cancelCompanionAction,showHomeBubble,getHomeBubble:()=>homeBubble?.roomId===current().id?homeBubble:null,setResidentPortraits(entries){residentPortraits=Object.fromEntries(entries.map(e=>[e.id,e]));dirty=true;wake();},previewWave(action){manual=false;greeted=false;return greetOwner(action);},greetOwner,summonOwner,summonAll,setScheduleLabel(text){if(scheduleLabel!==text){scheduleLabel=text;renderUI();}},getOwnerName:()=>ownerName,getResidentPosture,standResident,setResidentBedMode,controlResident:setManualResident,getResidentAnchor(id=primaryResidentId){const entry=socialEntries.find(e=>e.id===id),root=id===activeResidentId()?resident:entry?.group,person=id===activeResidentId()?visitor:entry?.visitor;if(!root?.visible||!person)return null;camera.updateMatrixWorld();root.updateWorldMatrix(true,false);const p=(person.getHeadWorldPosition?.()??root.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0,1.2,0))).project(camera);const top=firstPerson?person.getHeadTopWorldPosition?.().project(camera):undefined;return {x:(p.x+1)*size.w/2,y:(1-p.y)*size.h/2,width:size.w,height:size.h,headTopY:top?(1-top.y)*size.h/2:undefined};},dispose,beginHomeConversation,finishAutonomousAction,updateRecords,getHomeScene,performHomeAction,performHomeActions,openPanel(name){if(name==='decorate'){manualRevision++;manualUntil=Date.now()+90000;}panel=null;closeInteraction();if(name==='decorate')runAction({action:'edit'});else runAction({action:'panel',panel:name});},setCompanionPreference(key,value){if(key==='directSpeech')state.directSpeech=value===true;else if(key==='speechFrequency'&&['often','normal','quiet'].includes(value))state.speechFrequency=value;else if(key==='activityFrequency'&&['quiet','normal','lively'].includes(value))state.activityFrequency=value;else return;persist();},setAutonomy(enabled){state.autonomy=enabled;if(!enabled)cancelCompanionAction();persist();},setResidentRoom,setResidentExpression,setViewMode,setLightingMode,setTimeZone(next){timeZone=next;refreshRoomLighting();scheduleRoomLighting();renderUI();},setPrimaryResidentId(id,label){restoreFurnitureCharacter();stopSocial();primaryResidentId=id;ownerName=label||'TA';},setSocialResident,removeSocialResident,playSocial,cancelSocial(){stopSocial();restoreFurnitureCharacter();visitorUntil=0;dirty=true;wake();},previewComparisonWalk,walkComparisonRoute,setSuspended(value){suspended=value;if(value){homelyForeground?.hide();petSystem?.life.save();clearTimeout(faceTimer);faceTimer=0;cancelAnimationFrame(frame);frame=0;}else{if(refreshRoomLighting())renderUI();dirty=true;lastTick=performance.now();wake();}scheduleRoomLighting();},setVisitor,setComparisonVisitors,setActiveComparisonVisitor,setComparisonVisitorScale,openPets:(id)=>petSystem?.open(id),getPetSystem:()=>petSystem,getPetPortrait(id){const pet=petSystem?.life.data.pets.find(p=>p.id===id);return pet?petSystem.portrait(pet):'';},advancePets:seconds=>{for(let t=0;t<seconds;t+=.05){const dt=Math.min(.05,seconds-t);if(!suspended&&!edit&&!overview){elapsed+=dt;if(visitor&&resident.visible)animateVisitor(elapsed-visitorStart);}petSystem?.update(dt);petSystem?.placeHeld();}if(petSystem?.consumeShadowChange())invalidateRoomShadows();dirty=true;renderScene();},getState:()=>clone(state),inspect:()=>({ready:true,photo:photoRenderer?.inspect()??null,firstPerson,homelyAttention:homelyAttention?{phase:homelyAttention.phase,close:homelyAttention.close}:null,musicSway:homelyMusic.weight,poking:!!homelyPoke,touchZone:homelyPoke?.touch.zone??null,lastHomelyTouch,responseMotion:companionGesture?.clip?.id??null,phoneReply:companionPhone?.phoneReply===true,userSpeech:userSpeech?{loaded:!!userSpeech.clip,until:userSpeech.until}:null,residentHeadings:[{id:activeResidentId(),yaw:resident.rotation.y},...socialEntries.map(e=>({id:e.id,yaw:e.group.rotation.y}))],controlledResidentId:manualControl,residentPositions:[{id:activeResidentId(),position:resident.position.toArray()},...socialEntries.map(e=>({id:e.id,position:e.group.position.toArray()}))],conversation:conversation?{actor:conversation.person===companionActors().person.visitor?'character':'other',loaded:!!conversation.clip,seated:!!characterSeatState().seat}:null,pets:petSystem?.inspect(),viewMode,cameraGestures:{rotate:controls.enableRotate,pan:controls.enablePan,zoom:controls.enableZoom},characterStyle:'illustration',faces:{scheduled:!!faceTimer,residents:[...(visitor?[{id:primaryResidentId,...visitor.faceState}]:[]),...socialEntries.map(e=>({id:e.id,...e.visitor.faceState}))]},social:socialRuntime?.inspect()??{session:null,residents:[{id:primaryResidentId},...socialEntries.map(e=>({id:e.id,visible:e.group.visible}))]},comparison:comparisonEntries.map(e=>({id:e.id,label:e.label,active:e.id===activeComparisonId,visible:e.id===activeComparisonId?resident.visible:e.group.visible,position:e.id===activeComparisonId?resident.position.toArray():e.group.position.toArray(),bodyId:e.visitor.root.uuid})),furnitureStyle,furnitureOutlineEnabled,furnitureOutlineActive:furnitureStyle==='retro'&&furnitureOutlineEnabled&&lightBudget().outline,furnitureOutline:furnitureHalo.inspect(),kitchen:kitchenEffects.inspect(),windowDaylight:windowDaylight.inspect(),lighting:{lampGlow:lampGlow.inspect(),finish:finishEnabled,directSun:!!windowDaylight.primary()&&!!ROOM_LIGHT_PHASES[lightPhase].directSun&&!overview,profile:lightPhase,mode:lightMode,timeZone:timeZone??null,scheduled:!!lightTimer,budget:lightBudget(),keyShadow:key.castShadow,shadows:renderer.shadowMap.enabled,shadowSize:key.shadow.mapSize.x,ambient:hemi.intensity,key:key.intensity,fill:fill.intensity},phoneBudget:phone?PHONE_BUDGET:null,furnitureCounts:Object.fromEntries(furnishingCounts(state,catalog)),wallView:effectiveWallView(),roomScope:effectiveRoomScope(),visibleRoomIds:[...visibleRoomIds],roomGroups:roomGroups(state,catalog).map(rs=>rs.map(r=>r.id)),walking:!!walking,walkFeedback:walkFeedback.inspect(),walkDestination:walking?.path.at(-1)??null,headWidth,visitorLocation,doorStates:doors.map(d=>({kind:d.userData.doorKind,rotation:d.userData.doorLeaf.rotation.y,x:d.userData.doorLeaf.position.x})),rotationPreview:rotationPreview?{...rotationPreview}:null,interaction:interaction?{itemId:interaction.itemId,petId:interaction.petId,page:interaction.page,actions:interaction.options.map(a=>({label:a.label,action:a.action,reason:a.reason}))}:null,furnitureActor:activeResidentId(),chibiVisible:resident.visible,chibiMotion:visitorMotion,chibiPosture:visitorActivity?.posture||(visitorSeat?.bed?'lying':visitorSeat?'seated':'standing'),chibiSeat:visitorSeat,chibiSeatPose:currentSeatPose()?.seatPose??null,bedMode:visitorSeat?.bedMode??null,seatChange:seatChange?{rising:seatChange.rising,pose:seatChange.pose,progress:Math.min(1,(elapsed-seatChange.start)/seatChangeDuration(seatChange.pose))}:null,chibiHeldPlush:heldPlush,chibiWatering:visitorPlant,chibiActivity:visitorActivity,kitchenTask:kitchenTask?{kind:kitchenTask.kind,stage:kitchenTask.stage,carrying:!!kitchenTask.carrying,itemId:kitchenTask.itemId,sinkId:kitchenTask.sink?.id}:null,kitchenPropsVisible:kitchenWork.root.visible,yogaMatVisible:mat.visible,wateringVisible:watering.root.visible,chibiRotation:resident.rotation.y,chibiPosition:resident.position.toArray(),outlineVisible:!!outlineGroup,gridVisible:grid.visible,footprintVisible:footprint.visible,placementValid:drag?.valid??null,quality,pixelRatio:renderer.getPixelRatio(),cameraPosition:camera.position.toArray(),cameraTarget:controls.target.toArray(),zoom:camera.zoom,undoCount:undo.length,redoCount:redo.length,orbitMode,overview,edit,selected,rooms:state.rooms,activeRoomId:state.activeRoomId,panel,message,saved,assets:catalog.map(a=>a.id),drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,programs:renderer.info.programs?.length,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,materials:materialCache.size,finishMaterials:finishes.count,renderedFrames,frameCap:1000/frameInterval,detailRooms:detailedRoomIds.size}),advanceTime:ms=>{manual=true;elapsed+=ms/1000;updateCompanion();if(kitchenEffects.updateDoors(ms/1000,reducedMotion)){invalidateRoomShadows();}if(visitor&&resident.visible&&!edit&&!companionRise&&!(companionTravel&&!furnitureUser))animateVisitor(reducedMotion?1:elapsed-visitorStart);for(const a of animated)a.o.position.y=a.y+Math.sin(elapsed*a.speed+a.phase)*a.amplitude;animateIdleResidents();animateParkedCharacter();if(furnitureUser)animateConversation();animateCompanionIdle();animateCompanionPhone();animateUserSpeech();faceNearbyResidents();faceConversationPartner();renderScene()},select,projectPoint:position=>{const p=new THREE.Vector3(...position).project(camera);return {x:(p.x+1)*size.w/2,y:(1-p.y)*size.h/2}},projectItem:id=>{const o=objects.find(o=>o.userData.itemId===id);if(!o)return null;const p=new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).project(camera);return {x:(p.x+1)*size.w/2,y:(1-p.y)*size.h/2}}};
}
