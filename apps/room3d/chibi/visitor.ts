import {classifyHomelyTouch} from '../homelyTouch';
import {actionExpression,actionMouthFrame,type ActionExpression} from './actionExpression';
import {createSocialProp,type SocialProp} from './socialProps';
import {residentBlinkSeed,residentFaceFrame,type ResidentExpression} from './residentExpression';
import * as THREE from 'three';
import {setCharacterIllustration} from './illustration';
import {subscribeCharacterStyle} from './characterStyle';
import {buildBody,loadBody} from './FbxBody';
import {BLANK_SCALE} from './blankBody';
import {bodyHeightY} from './bodyHeight';
import {roomWalkSpeed,type RoomWalkClip} from './roomWalk';
import {approvedRoomWalk} from './approvedRoomWalk';
import type {MotionFrame} from './selectedMotions';
import {constrainForearmTwist} from '../../../experiments/chibi/forearmTwist';
import {dressHoodie} from './hoodieClothes';
import {dressApprovedWardrobe} from './approvedClothing';
import type {Parts,Motion,Posture,HairSettings,ActivityPose} from './types';
import type {RollResult} from './CreatorRollBridge';
export const NEW_BODY_HOME_PERCENT=200;

export async function decodeParts(result:RollResult,hair?:HairSettings):Promise<Parts>{
 const parts:Parts={};
 await Promise.all(Object.entries(result.layers).map(async([key,url])=>{const img=new Image();img.src=url;await img.decode();img.dataset.creatorLineart=String((result.state as {preserveLineart?:number})?.preserveLineart??25);parts[key]=img;}));
 await Promise.all((hair?.extras??[]).filter(e=>e.src).map(async e=>{const img=new Image();img.src=e.src!;await img.decode();parts[e.source]=img;}));
 return parts;
}
export async function createVisitor(parts:Parts,hair?:HairSettings){
 const source=await loadBody();
 let body:ReturnType<typeof buildBody>;
 try{body=buildBody(source,parts,'outfit',hair);try{await body.setFaceSettings(hair?.face);}catch(e){body.resources.forEach(r=>r.dispose());throw e;}}
 finally{source.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});}
 let updateOutfitPose:(()=>void)|undefined;
 const root=new THREE.Group();root.name='little-world-chibi';root.add(body.root);
 if(body.rig){try{if(hair?.wardrobe!==undefined){const outfit=await dressApprovedWardrobe(body.rig,hair.wardrobe,hair.wardrobeFits,hair.wardrobeColors,hair.wardrobeLayering);body.resources.push(outfit);let nextFit=0;updateOutfitPose=()=>{const start=performance.now();if(start<nextFit)return;outfit.updatePose?.();const end=performance.now(),cost=end-start;nextFit=end+(cost>12?Math.min(500,Math.max(100,cost*4)):0);};}else{const outfit=dressHoodie(body.rig);body.resources.push(...outfit.resources);}}catch(e){body.resources.forEach(r=>r.dispose());throw e;}}
 // Current user-selected home size: 200% of the original 1.4-unit baseline.
 // Scale the whole hierarchy so hair, clothing and the skeleton stay aligned.
 body.root.scale.setScalar(hair?.bodyShape==='blank'?1.4/BLANK_SCALE*(NEW_BODY_HOME_PERCENT/100):.7);
 // Keep the painted features legible under the room's brighter directional light.
 body.root.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=false;o.receiveShadow=false;for(const m of Array.isArray(o.material)?o.material:[o.material])if(m instanceof THREE.MeshStandardMaterial){m.emissive.set('#ffffff');m.emissiveIntensity=.04;}}});
 const unsubscribeStyle=subscribeCharacterStyle(()=>setCharacterIllustration(body.root));
 setCharacterIllustration(body.root);
 let actionFace:ActionExpression='neutral';
 const blinkSeed=residentBlinkSeed(root.uuid);let faceState={...residentFaceFrame(0,blinkSeed,{blink:false}),mouth:'base' as ReturnType<typeof actionMouthFrame>['mouth']};
 const updateExpression=(time:number,settings:Partial<ResidentExpression>&{speaking?:boolean}={})=>{const mouth=actionMouthFrame(settings.speaking?'speaking':actionFace,time);const eyes=residentFaceFrame(time,blinkSeed,{blink:hair?.face?.enabled?hair.face.blink:true,...settings},body.expressionBase);faceState={...eyes,...(actionFace==='tender'?{eyes:'closed' as const}:{}),mouth:mouth.mouth,nextIn:Math.min(eyes.nextIn,mouth.nextIn)};body.setExpressionFace(faceState.eyes,faceState.mouth);return faceState;};
 const setActionExpression=(expression:ActionExpression,time:number)=>{actionFace=expression;updateExpression(time);};
 let disposed=false;
 let bedPhone:SocialProp|null=null;
 const updateBedPhone=(time:number,activity?:ActivityPose)=>{
  if(body.rig&&activity?.kind==='bed-rest'&&activity.bedMode==='bed-phone'){
   bedPhone??=createSocialProp('bed-phone',[{root,rig:body.rig} as ChibiVisitor]);
   bedPhone?.update(time,Infinity,THREE.MathUtils.smootherstep(activity.bedTime??time,.65,1.2));
  }else{bedPhone?.dispose();bedPhone=null;}
 };
 // Measure the actual fitted head/hair instead of assuming an extra fixed cap.
 root.updateMatrixWorld(true);body.rig?.skeleton.update();
 root.traverse(o=>{if(o instanceof THREE.SkinnedMesh)o.computeBoundingBox();});
 const standingBounds=new THREE.Box3().setFromObject(root);
 const headAnchor=body.rig?.bones.head??body.motionBody;
 const headTopPoint=headAnchor.getWorldPosition(new THREE.Vector3());headTopPoint.y=standingBounds.max.y;headAnchor.worldToLocal(headTopPoint);
 const navigation=body.rig?{
  headBottom:.18+bodyHeightY(.56*BLANK_SCALE,body.rig.bodyHeight)*body.root.scale.y,
  headTop:.18+standingBounds!.max.y+.04,
 }:undefined;
 const baseScale=body.root.scale.y,baseHeadBottom=navigation?.headBottom;
 const setScaleMultiplier=(value:number)=>{
  if(!Number.isFinite(value))return;
  const scale=THREE.MathUtils.clamp(value,.4,2.6);body.root.scale.setScalar(baseScale*scale);
  if(navigation){navigation.headBottom=.18+(baseHeadBottom!-.18)*scale;navigation.headTop=.18+standingBounds!.max.y*scale+.04;}
  root.updateWorldMatrix(true,true);
 };
 // Paired actions solve both residents before updating clothing and skin bounds.
 const finishPose=()=>{root.updateWorldMatrix(true,true);body.rig?.skeleton.update();if(body.rig)Object.assign(body.rig.mesh,{boundingBox:null,boundingSphere:null});updateOutfitPose?.();};
 let walkSpeed:number|undefined;
 const setWalkMotion=(clip?:RoomWalkClip)=>{body.setWalkMotion(clip);walkSpeed=clip&&body.rig?roomWalkSpeed(clip,body.rig.bones):undefined;};
 if(body.rig)setWalkMotion(approvedRoomWalk);
 const motionLeg=body.rig?(body.rig.bones.L_shin.position.length()+body.rig.bones.L_foot.position.length()):.36;
 const applySelectedFrame=(frame:MotionFrame,weight=1,seatedPose?:ActivityPose)=>{
  actionFace='neutral';
  if(seatedPose){
   body.animate(0,'idle','seated',seatedPose);
   if(body.rig){for(const [name,q] of Object.entries(frame.rotations))if(/^(spine|chest|neck|head|[LR]_(upperArm|forearm|hand))$/.test(name))body.rig.bones[name]?.quaternion.slerp(q,weight);}
   else{const e=new THREE.Euler().setFromQuaternion(frame.rotations.head);body.animate(0,'idle','seated',{...seatedPose,kind:'social',hands:[],socialHead:[THREE.MathUtils.clamp(e.x,-.3,.3)*weight,0,THREE.MathUtils.clamp(e.z,-.3,.3)*weight]});}
   finishPose();return;
  }
  updateBedPhone(0);
  body.animate(0,'idle');
  if(body.rig){
   const rig=body.rig;
   for(const [name,q] of Object.entries(frame.rotations))rig.bones[name]?.quaternion.slerp(q,weight);
   const pose=Object.fromEntries(Object.entries(rig.bones).map(([n,b])=>[n,b.quaternion.clone()]));
   for(const side of ['L','R'] as const){constrainForearmTwist(rig,pose,side);for(const suffix of ['twist1','twist2','twist3'])rig.bones[`${side}_${suffix}`]?.quaternion.copy(pose[`${side}_${suffix}`]);}
   body.motionBody.position.y=(frame.position.y*motionLeg-rig.bones.hips.position.y)*weight;
   body.root.updateWorldMatrix(true,true);
   // Only lift a penetrated sole; retain captured crouching and jumping.
   const floor=Math.min(...['L_foot','R_foot','L_toe','R_toe'].map(n=>body.root.worldToLocal(rig.bones[n].getWorldPosition(new THREE.Vector3())).y));
   if(floor<.012*BLANK_SCALE)body.motionBody.position.y+=.012*BLANK_SCALE-floor;
  }else{
   const hips=frame.rotations.hips,inv=hips.clone().invert();
   const hands=['R_hand','L_hand'].map((n,i)=>{
    const point=frame.points[n].clone().sub(frame.position).applyQuaternion(inv).multiplyScalar(.42);point.y+=.35;
    return new THREE.Vector3(i===0?-.415:.415,.51,0).lerp(point,weight).toArray();
   });
   const head=new THREE.Quaternion();for(const n of ['spine','chest','neck','head'])head.multiply(frame.rotations[n]);const e=new THREE.Euler().setFromQuaternion(head);
   body.animate(0,'idle','standing',{kind:'social',hands,socialHead:[THREE.MathUtils.clamp(e.x,-.3,.3)*weight,0,THREE.MathUtils.clamp(e.z,-.3,.3)*weight]});
   // Classic's large head cannot inherit a human pelvis's full lean.
   const lean=new THREE.Euler().setFromQuaternion(hips,'YXZ');lean.x=THREE.MathUtils.clamp(lean.x,-.12,.12);lean.z=THREE.MathUtils.clamp(lean.z,-.12,.12);
   body.motionBody.quaternion.identity().slerp(new THREE.Quaternion().setFromEuler(lean),weight);
   body.motionBody.position.y=Math.max(-.12,(frame.position.y-frame.hipHeight)*.3)*weight;
  }
  finishPose();
 };
 // The body keeps its original contact plane; action feet hang independently.
 const translatePose=(delta:THREE.Vector3)=>{const parent=body.motionBody.parent!;parent.updateWorldMatrix(true,false);const origin=parent.worldToLocal(new THREE.Vector3()),end=parent.worldToLocal(delta.clone());body.motionBody.position.add(end.sub(origin));root.updateWorldMatrix(true,true);};
 return {root,getTouchRegion(point:THREE.Vector3){
  root.updateWorldMatrix(true,true);
  const crown=headAnchor.localToWorld(headTopPoint.clone()),base=headAnchor.getWorldPosition(new THREE.Vector3());
  if(!body.rig)base.y=crown.y-standingBounds.getSize(new THREE.Vector3()).y*.46*body.root.scale.y/baseScale;
  const arms=body.rig?(['L','R'] as const).map(side=>({side:(side==='L'?1:-1) as 1|-1,points:['upperArm','forearm','hand'].map(part=>body.rig!.bones[side+'_'+part].getWorldPosition(new THREE.Vector3()))})):[];
  return classifyHomelyTouch(point,base,crown,arms);
 },getHeadTopWorldPosition(){root.updateWorldMatrix(true,true);return headAnchor.localToWorld(headTopPoint.clone());},setPhotoExpression:body.setExpressionFace,lookToward:body.lookToward,translatePose,getHeadWorldPosition(){root.updateWorldMatrix(true,false);return body.rig?body.rig.bones.head.localToWorld(new THREE.Vector3(0,.72,0)):body.motionBody.localToWorld(new THREE.Vector3(0,1.2,0));},updateExpression,setActionExpression,get faceState(){return faceState;},rig:body.rig,navigation,finishPose,applySelectedFrame,classicPoint:body.classicPoint,classicContact:body.classicContact,get motionScale(){return motionLeg*body.root.scale.y;},setScaleMultiplier,setWalkMotion,get walkSpeed(){return walkSpeed===undefined?body.rig?1.05:1.45:walkSpeed*body.root.scale.y;},get seatScale(){return body.root.scale.y;},get gamingReach(){return body.rig?{shoulderHeight:bodyHeightY(.59*BLANK_SCALE,body.rig.bodyHeight)*body.root.scale.y,armReach:(body.rig.bones.L_forearm.position.length()+body.rig.bones.L_hand.position.length())*body.root.scale.y}:undefined;},get bedHipHeight(){return body.rig?bodyHeightY(.38*BLANK_SCALE,body.rig.bodyHeight)*body.root.scale.y:0;},get bedHeadToHip(){return body.rig?(standingBounds!.max.y/baseScale-bodyHeightY(.38*BLANK_SCALE,body.rig.bodyHeight))*body.root.scale.y:0;},seatOffset:0,animate(time:number,motion:Motion,posture:Posture='standing',activity?:ActivityPose){actionFace=actionExpression(activity?.bedMode==='bed-talk'?'bed-talk':motion);body.animate(time,motion,posture,body.rig&&activity&&(['computer','stream','race','rhythm','eat','hug','pet-contact'].includes(activity.kind)||activity.kind.startsWith('bath-'))?{...activity,handScale:(activity.kind.startsWith('bath-')?1:.7)/body.root.scale.y}:activity);updateBedPhone(time,activity);updateOutfitPose?.();updateExpression(time);},dispose():void{if(disposed)return;disposed=true;unsubscribeStyle();bedPhone?.dispose();root.removeFromParent();for(const resource of body.resources)resource.dispose();}};
}
export type ChibiVisitor=Awaited<ReturnType<typeof createVisitor>>;
