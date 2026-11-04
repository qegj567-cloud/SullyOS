import {photoLibrary,loadPhotoClip} from './photoLibrary';
import {createSocialScene} from './chibi/selectedSocial';
import {sampleSelected} from './chibi/selectedMotions';
import {conversationHead} from './conversationFacing';
import * as THREE from 'three';

// Temporary portrait staging. Never writes home state, records, or action queues.
export function createPhotoSession({actors,camera,controls,invalidate,canInteract}){
 const cameraBefore={position:camera.position.clone(),target:controls.target.clone(),zoom:camera.zoom};
 const entries=actors.filter(a=>a.person&&a.root.visible).map(a=>{
  const transforms=[];a.root.traverse(o=>transforms.push({o,p:o.position.clone(),q:o.quaternion.clone(),s:o.scale.clone(),visible:o.visible}));
  return {...a,transforms,faceBefore:{...a.person.faceState},expression:'original',lookCamera:false};
 });
 const center=entries.length?entries.reduce((p,e)=>p.add(e.root.position),new THREE.Vector3()).multiplyScalar(1/entries.length):controls.target.clone();
 let closed=false,pair=null,pairKey='',pairGeneration=0,pairRestore=null;const revisions=new Map();
 const cancelPair=()=>{pairGeneration++;if(pair){pair.cancel();pair=null;pairKey='';pairRestore?.();pairRestore=null;}};
 let yaw=0,pitch=4,zoom=1,height=1.2,pan=0;
 const aim=()=>{controls.target.set(center.x+Math.cos(yaw*Math.PI/180)*pan,center.y+height,center.z-Math.sin(yaw*Math.PI/180)*pan);camera.position.copy(controls.target).add(new THREE.Vector3(Math.sin(yaw*Math.PI/180)*20,Math.tan(pitch*Math.PI/180)*20,Math.cos(yaw*Math.PI/180)*20));camera.zoom=(camera.top-camera.bottom)/5.2*zoom;camera.lookAt(controls.target);camera.updateProjectionMatrix();invalidate(false);};
 const restoreActors=()=>{for(const e of entries){for(const t of e.transforms){t.o.position.copy(t.p);t.o.quaternion.copy(t.q);t.o.scale.copy(t.s);t.o.visible=t.visible;}e.person.finishPose?.();}};
 return {
  cancelInteraction:cancelPair,
  face(id,values){const e=entries.find(e=>e.id===id);if(e){Object.assign(e,values);invalidate();}},
  prepare(){
   const heads=[];
   const expressions={neutral:['open','closed'],smile:['open','smile'],happy:['happy','smile'],closed:['closed','smile'],surprised:['open','open']};
   for(const e of entries){
    const face=expressions[e.expression];
    e.person.setPhotoExpression?.(...(face||[e.faceBefore.eyes||'open',e.faceBefore.mouth||'base']));
    const head=e.person.rig?.bones.head;
    if(e.lookCamera&&head){heads.push({e,head,q:head.quaternion.clone()});conversationHead(head,camera.position,1);e.person.finishPose?.();}
   }
   return ()=>{for(const {e,head,q} of heads){head.quaternion.copy(q);e.person.finishPose?.();}};
  },
  actors:entries.map(e=>({id:e.id,label:e.label})),
  camera(values){({yaw,pitch,zoom,height,pan}={yaw,pitch,zoom,height,pan,...values});aim();},
  together(gap=.85){cancelPair();entries.forEach((e,i)=>{revisions.set(e.id,(revisions.get(e.id)||0)+1);e.person.animate(0,'idle','standing');e.root.position.set(center.x+(i-(entries.length-1)/2)*gap,center.y,center.z);e.root.rotation.set(0,0,0,'YXZ');});invalidate();aim();},
  async pose(id,motion,time=1){const e=entries.find(e=>e.id===id);if(!e||closed)return;cancelPair();const version=(revisions.get(id)||0)+1;revisions.set(id,version);if(photoLibrary.some(p=>p.id===motion&&p.participants===1)){const clip=await loadPhotoClip(motion);if(closed||revisions.get(id)!==version)return;e.person.applySelectedFrame(sampleSelected(clip.actors[0],time));e.person.finishPose?.();invalidate();return;} if(motion==='original'){const pos=e.root.position.clone(),q=e.root.quaternion.clone();for(const t of e.transforms){t.o.position.copy(t.p);t.o.quaternion.copy(t.q);t.o.scale.copy(t.s);}e.root.position.copy(pos);e.root.quaternion.copy(q);}else if(['idle','dance','angry'].includes(motion))e.person.animate(time,motion,'standing');e.person.finishPose?.();invalidate();},
  async interaction(action,a,b,time=1){
   if(canInteract&&!canInteract(action,a,b))throw Error('这两位未设置浪漫关系，不能执行亲密动作');
   if(closed||a===b)throw Error('请选择两位不同的居民');
   const chosen=[entries.find(e=>e.id===a),entries.find(e=>e.id===b)];if(chosen.some(e=>!e))throw Error('两位居民需要都在当前房间');
   const key=[action,a,b].join(':');
   if(pairKey!==key){cancelPair();for(const e of entries)revisions.set(e.id,(revisions.get(e.id)||0)+1);const version=pairGeneration;
    const staged=[];for(const e of entries)e.root.traverse(o=>staged.push({o,p:o.position.clone(),q:o.quaternion.clone(),s:o.scale.clone()}));pairRestore=()=>{for(const t of staged){t.o.position.copy(t.p);t.o.quaternion.copy(t.q);t.o.scale.copy(t.s);}for(const e of entries)e.person.finishPose?.();};
    const runtime=createSocialScene(chosen.map(e=>({id:e.id,visitor:{...e.person,root:e.root}})),{canInteract});pair=runtime;pairKey=key;
    try{await runtime.start(action,a,b);}catch(error){if(pair===runtime)cancelPair();throw error;}
    if(closed||version!==pairGeneration)return;
   }
   const info=pair?.inspect().session,entry=photoLibrary.find(p=>p.id===action);if(info&&entry)pair.seek(Math.max(0,info.duration-entry.duration-1.2)+.6+Math.min(time,entry.duration));invalidate();
  },
  turn(id,degrees){const e=entries.find(e=>e.id===id);if(e)e.root.rotation.set(0,degrees*Math.PI/180,0,'YXZ');invalidate();},
  restore(){closed=true;cancelPair();restoreActors();for(const e of entries)e.person.setPhotoExpression?.(e.faceBefore.eyes||'open',e.faceBefore.mouth||'base');camera.position.copy(cameraBefore.position);controls.target.copy(cameraBefore.target);camera.zoom=cameraBefore.zoom;camera.updateProjectionMatrix();invalidate();},
 };
}
