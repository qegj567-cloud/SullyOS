import {createBedLeisure,isBedLeisure} from './bedLeisure';
import {computerFrame,createComputerContact} from './computerMotion';
import {createFurnitureContact} from './furnitureMotion';
import {bathroomFrame,createBathroomContact} from './bathroomMotion';
import * as T from 'three';
import {bodyHeightY} from './bodyHeight';
import {BLANK_SCALE} from './blankBody';
import type {bindBlankBody} from './blankRig';
import type {Motion,Posture,ActivityPose} from './types';
import {mirrorFrame} from '../mirrorMotion.js';
import {wateringFrame} from './roomMotionFrame';
import {createFloorSeatContact} from './floorSeatContact';
import {createRoomWalkSampler,type RoomWalkClip} from './roomWalk';
import {constrainForearmTwist} from '../../../experiments/chibi/forearmTwist';
import {createMeshySampler,meshyMotions,type MeshyMotion} from './meshyMotions';
import {createMotionSurfaceContact} from './motionSurfaceContact';
import {createBedSurface} from './bedSurface';
import {createMirrorGrooming,mirrorGroomFrame} from './mirrorGrooming';

// Small FK poses in the rig's bind axes. Bone lengths remain unchanged.
// Seat contact is normalized here, rather than adding offsets to every furniture.
export function createBlankMotion(rig:ReturnType<typeof bindBlankBody>,body:T.Group,options:{walk?:RoomWalkClip}={}){
 const entries=Object.entries(rig.bones),targets=Object.fromEntries(entries.map(([name])=>[name,new T.Quaternion()]));
 const targetRotations=Object.values(targets),euler=new T.Euler(),position=new T.Vector3(),rotation=new T.Quaternion();
 const floorContact=createFloorSeatContact(rig,body);
 const surfaceContact=createMotionSurfaceContact(rig,body);
 const bedSurface=createBedSurface(rig,body);
 const bedHeadPitch=new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),.6),bedHeadBlend=new T.Quaternion();
 const supportBedHead=(mode:ActivityPose['bedMode'],recline:number)=>{if(mode!=='bed-side')rig.bones.head.quaternion.multiply(bedHeadBlend.identity().slerp(bedHeadPitch,T.MathUtils.smootherstep(recline,.45,1)));};
 const groom=createMirrorGrooming(rig,body);
 const bedLeisure=createBedLeisure(rig,body);
 const computerContact=createComputerContact(rig,body);
 const furnitureContact=createFurnitureContact(rig,body);
 const bathroomContact=createBathroomContact(rig,body);
 let walkClip:RoomWalkClip|undefined,sampleWalk:ReturnType<typeof createRoomWalkSampler>|undefined;
 const footPoint=new T.Vector3();
 const importedPose=Object.fromEntries(entries.map(([name])=>[name,new T.Quaternion()])),importedRoot=new T.Vector3();
 const samples=Object.fromEntries(Object.keys(meshyMotions).map(id=>[id,createMeshySampler(id as MeshyMotion)]));
 let previous:number|undefined,previousMotion:Motion='idle',previousPosture:Posture='standing';
 const angle=(name:string,x=0,y=0,z=0)=>targets[name].setFromEuler(euler.set(x,y,z));
 return (time:number,motion:Motion,posture:Posture,activity?:ActivityPose)=>{
  time=Number.isFinite(time)?Math.max(0,time):0;
  const seated=posture==='seated'||motion==='sit',lying=posture==='lying';
  const bed=activity?.kind==='bed-rest'||activity?.kind==='bed-change';
  const seatWeight=bed?activity.bedWeight??1:activity?.kind==='seat-change'||activity?.kind.startsWith('bath-')&&activity.seatWeight!==undefined?activity.seatWeight??0:seated?1:0;
  const floorSeat=activity?.seatPose==='floor'&&!lying;
  const fold=floorSeat?(activity?.kind==='seat-change'?activity.seatFold??0:seatWeight):0;
  const support=floorSeat?activity?.seatSupport??0:0;
  const water=motion==='water'?wateringFrame(time):null;
  const wave=['wave','wave-calm','wave-cute'].includes(motion),cute=motion==='wave-cute';
  const dt=previous===undefined?0:time<previous||motion!==previousMotion||posture!==previousPosture?1/30:time-previous;
  // A static/reduced-motion draw must also reach the requested pose. A posture
  // change snaps to its contact plane; limb emotes can blend while it stays put.
  const blend=activity?.kind==='seat-change'||bed||water||previous===undefined||posture!==previousPosture||motion==='idle'||dt===0||time>=.5&&motion!==previousMotion?1:1-Math.exp(-Math.min(dt,.5)*14);
  previous=time;previousMotion=motion;previousPosture=posture;
  for(const q of targetRotations)q.identity();
  position.set(0,0,0);rotation.identity();
  const breathe=Math.sin(time*1.8);
  angle('chest',-.015+breathe*.008);
  angle('head',.025+breathe*.008);
  if(motion==='idle'&&!seated&&!lying&&!activity){
   // Relaxed upper-body weight shifts; feet and world position stay anchored.
   angle('spine',Math.sin(time*.63)*.018,Math.sin(time*.37)*.022,Math.sin(time*.51)*.025);
   angle('chest',-.015+breathe*.012,Math.sin(time*.37+.8)*.018);
   angle('head',.025+Math.sin(time*.79)*.024,Math.sin(time*.29)*.055,Math.sin(time*.43)*.018);
  }
  for(const [side,prefix] of [[1,'L'],[-1,'R']] as const){
   rig.setHandCurl(prefix,motion==='angry'?.8:wave&&prefix==='L'?0:.12,targets);
   angle(`${prefix}_upperArm`,-.08,0,-side*1.25);
   angle(`${prefix}_forearm`,0,-side*.08,-side*.07);
   angle(`${prefix}_hand`,0,0,side*.05);
   if(seatWeight>0){
    angle(`${prefix}_thigh`,-1.40*seatWeight,0,-side*.015*seatWeight);
    angle(`${prefix}_shin`,(1.32+Math.sin(time*1.6+side)*.012)*seatWeight);
    angle(`${prefix}_foot`,.08*seatWeight);
    // Rest beside the hips, with just enough outward space for the loose sleeves.
    angle(`${prefix}_upperArm`,-.04,0,-side*1.25);
    angle(`${prefix}_forearm`,0,-side*.04,-side*.04);
    angle(`${prefix}_hand`,0,0,side*.025);
   }
   if(motion==='walk'&&!seated&&!lying){
    const step=Math.sin(time*8.5)*side,swing=Math.max(0,-step);
    angle(`${prefix}_thigh`,step*.27,0,-side*.006);
    angle(`${prefix}_shin`,swing*.48);
    angle(`${prefix}_foot`,-swing*.18);
    angle(`${prefix}_upperArm`,-step*.13,0,-side*1.30);
    angle(`${prefix}_forearm`,0,-side*(.14+swing*.10),-side*.06);
   }
   if(floorSeat&&seatWeight>0){
    // A relaxed forward rest: parallel knees and level feet, without side folding.
    angle(`${prefix}_thigh`,-1.18*seatWeight);
    angle(`${prefix}_shin`,.65*seatWeight);
    angle(`${prefix}_foot`,.53*seatWeight);
    // Keep the relaxed arms beside the hips, as on other seats. Only the
    // temporary support gesture reaches away from that resting position.
    if(prefix==='R'&&support>0){
     angle('R_upperArm',-.04-.08*support,0,1.25+support*.05);
     angle('R_forearm',0,.04,.04);
     angle('R_hand',-.18*support,0,-.025-.095*support);
    }
   }
  }
  if(activity&&['computer','stream'].includes(activity.kind)&&seated){
   const f=computerFrame(time,activity.kind==='stream');angle('spine',.035*f.enter);angle('head',.055-f.greet*.04,f.look-f.greet*.06,activity.kind==='stream'?Math.sin(time*2)*.018:0);
   for(const [sign,side]of [[1,'L'],[-1,'R']]as const){angle(side+'_upperArm',-.1,-sign*.2,-sign*1.15);angle(side+'_forearm',0,-sign*.7,-sign*.08);}
  }
  const furniture=activity&&['race','rhythm','eat','hug'].includes(activity.kind);
  if(furniture&&!lying){
   angle('head',activity.kind==='eat'?.075:.025,activity.kind==='race'?Math.sin(time*1.9)*.025:0);
   for(const [sign,side]of [[1,'L'],[-1,'R']]as const){angle(side+'_upperArm',-.15,-sign*.3,-sign*1.10);angle(side+'_forearm',0,-sign*.85,-sign*.08);}
  }
  if(activity&&['coffee','wash','cook'].includes(activity.kind)&&!lying){
   const work=!activity.carrying,cycle=work?Math.sin(time*(activity.kind==='wash'?7:3)):0;
   for(const [side,prefix]of [[1,'L'],[-1,'R']] as const){
    angle(`${prefix}_upperArm`,-.18,-side*.48,-side*.74);
    angle(`${prefix}_forearm`,0,-side*(1.55+(prefix==='L'?cycle*.13:0)),-side*.12);
    angle(`${prefix}_hand`,work&&prefix==='L'?cycle*.10:0,0,side*.08);
    rig.setHandCurl(prefix,.38,targets);
   }
   angle('head',.10,work?Math.sin(time)*.025:0);
  }
  if(seatWeight>0)position.y=(-bodyHeightY(.38*BLANK_SCALE,rig.bodyHeight)+.05*BLANK_SCALE)*seatWeight;
  if(floorSeat)angle('spine',.035*seatWeight);
  if(activity?.kind==='seat-change'){
   angle('spine',(floorSeat?.035*seatWeight:0)+(activity.seatLean??0));angle('head',.025+breathe*.008-(activity.seatLean??0)*.4);
  }
  if(motion==='walk'&&!seated&&!lying){angle('spine',0,Math.sin(time*8.5)*.018);angle('head',.025,0,-Math.sin(time*8.5)*.012);}
  if(water&&!seated&&!lying){
   for(const [side,prefix]of [[1,'L'],[-1,'R']] as const){
    // Elbows stay low and outside the hoodie. Both wrists carry the can.
    angle(`${prefix}_upperArm`,-.08-water.reach*.22,-side*water.reach*.70,-side*(1.25-water.reach*.15));
    angle(`${prefix}_forearm`,0,-side*(.08+water.reach*1.12),-side*.07);
    angle(`${prefix}_hand`,water.tilt,0,side*.05);
    rig.setHandCurl(prefix,.12+water.reach*.30,targets);
   }
   angle('spine',water.pour*.055);angle('head',.025+water.reach*.09,Math.sin(time*1.3)*water.pour*.025);
  }
  if(wave&&!lying){
   // Raise a nearly straight arm outwards, in front of the head's silhouette.
   // The shallow diagonal leaves room for the large head instead of folding at the ear.
   angle('L_upperArm',-.10,-.22,.66+Math.sin(time*6)*.055);
   angle('L_forearm',0,-.04,.09);
   angle('L_hand',0,Math.sin(time*6)*.12,Math.sin(time*6)*.22);
   angle('head',.02,-.045,cute?-.10:-.035);
   if(cute&&!seated)position.y=Math.max(0,Math.sin(time*4.5))*.07*BLANK_SCALE;
  }
  if(motion==='sleep'){
   angle('head',lying?.015:.13+Math.sin(time*1.7)*.025,0,seated?.04:0);
   angle('chest',.025+Math.sin(time*1.7)*.012);
  }
  if(motion==='angry'&&!lying){angle('head',.055,Math.sin(time*5)*.06);angle('chest',.04,0,Math.sin(time*5)*.018);}
  if(motion==='dance'&&!lying){angle('spine',0,0,Math.sin(time*3)*.045);angle('head',0,0,-Math.sin(time*3)*.045);}
  if((motion==='mirror-admire'||motion==='mirror-outfit')&&!lying){
   const pose=mirrorFrame(motion,time);angle('head',pose.nod,0,pose.tilt);angle('spine',0,pose.yaw,0);
   if(motion==='mirror-admire'){
    const f=mirrorGroomFrame(time);angle('head',f.nod,-f.yaw*.5,f.tilt);angle('spine',0,f.yaw,0);
    for(const [sign,side]of [[1,'L'],[-1,'R']]as const){
     angle(side+'_upperArm',-.12,0,-sign*(1.25-f.check*.12));
     angle(side+'_forearm',0,-sign*(.12+f.check*.12),-sign*.07);
    }
   }else for(const [side,prefix]of [[1,'L'],[-1,'R']] as const){
    angle(`${prefix}_upperArm`,-.26,0,-side*1.05);angle(`${prefix}_forearm`,-.40,0,-side*.18);angle(`${prefix}_hand`,.08+Math.sin(time*2)*.06);
   }
  }
  if(motion==='bath-shower'){
   const w=activity?.bathPhase&&activity.bathPhase!=='work'?0:bathroomFrame(time).wash;
   angle('head',.05+w*.035,Math.sin(time*1.1)*.035*w);angle('spine',.025*w);
   for(const [s,p]of [[1,'L'],[-1,'R']]as const){angle(p+'_upperArm',-.22*w,-s*.35*w,-s*(1.25-.70*w));angle(p+'_forearm',0,-s*(.08+1.6*w),-s*.1);}
  }
  if(motion==='bath-soak'){
   const lift=activity?.bathLegLift??1;
   angle('head',-.045*seatWeight,Math.sin(time*.7)*.025);angle('spine',-.045*seatWeight);
   for(const [s,p]of [[1,'L'],[-1,'R']]as const){angle(p+'_thigh',(-1.40-.12*lift)*seatWeight,0,-s*.015*seatWeight);angle(p+'_shin',(1.32-1.02*lift)*seatWeight);angle(p+'_foot',.14*seatWeight);angle(p+'_upperArm',-.08,0,-s*(1.25-.4*seatWeight));angle(p+'_forearm',0,-s*.30*seatWeight,-s*.08);}
  }
  if(motion==='bath-laundry'){
   const press=activity?.bathPhase&&activity.bathPhase!=='work'?0:bathroomFrame(time).press;
   angle('head',.08*press+Math.sin(time*.9)*.018);angle('spine',.055*press);
   angle('R_upperArm',-.12*press,press*.25,1.25-.32*press);angle('R_forearm',0,.08+1.10*press,.07);
  }
  if(motion==='bath-toilet'){angle('head',.035);angle('spine',.035*seatWeight);for(const [s,p]of [[1,'L'],[-1,'R']]as const){angle(p+'_upperArm',-.08,0,-s*1.23);angle(p+'_forearm',0,-s*.38,-s*.05);}}
  if(bed){
   const recline=activity.bedRecline??1,legLift=activity.bedLegLift??1,tilt=-Math.PI/2*recline,hip=bodyHeightY(.38*BLANK_SCALE,rig.bodyHeight);
   rotation.setFromEuler(euler.set(tilt,0,0));
   // Rotate around the pelvis on the mattress, not around the standing feet.
   position.set(0,(-hip+.055*BLANK_SCALE)*seatWeight+hip*(1-Math.cos(tilt)),-Math.sin(tilt)*hip);
   angle('spine',.18*recline);angle('chest',.015*recline+Math.sin(time*1.7)*.006*recline);angle('neck',.07*recline);angle('head',.015*recline);
   for(const [side,prefix]of [[1,'L'],[-1,'R']] as const){
    // Dangle outside the edge, then lift both shins before turning onto the bed.
    angle(`${prefix}_thigh`,(-Math.PI/2*(1-recline)-.035)*seatWeight);
    angle(`${prefix}_shin`,T.MathUtils.lerp(1.32,.065,legLift)*seatWeight);
    angle(`${prefix}_foot`,.04*seatWeight);
    angle(`${prefix}_upperArm`,-.04,0,-side*1.25);angle(`${prefix}_forearm`,0,-side*.04,-side*.04);
    rig.setHandCurl(prefix,.24,targets);
   }
  }else if(lying){
   // Existing bed anchor supplies the pillow clearance; lay the whole rig down.
   rotation.setFromEuler(euler.set(-Math.PI/2,0,0));position.set(0,0,0);
  }
  const importedWalk=motion==='walk'&&!seated&&!lying&&options.walk;
  if(importedWalk){
   if(walkClip!==importedWalk){walkClip=importedWalk;sampleWalk=createRoomWalkSampler(importedWalk);}
   sampleWalk!(time,targets);
   for(const side of ['L','R'] as const){rig.setHandCurl(side,.12,targets);constrainForearmTwist(rig,targets,side);}
  }
  if(bed&&Math.abs(activity.bedStep??0)>0&&options.walk){
   if(walkClip!==options.walk){walkClip=options.walk;sampleWalk=createRoomWalkSampler(walkClip);}
   sampleWalk!(activity.bedStep!>0?-time:time,importedPose);
   for(const name of ['L_thigh','L_shin','L_foot','L_toe','R_thigh','R_shin','R_foot','R_toe'])targets[name]?.slerp(importedPose[name],Math.abs(activity.bedStep!));
  }
  const selected=activity?.clip??(bed&&(activity.bedRecline??1)>0?'sleep':['wave-alternate-1','wave-alternate-2','dress-once','yoga'].includes(motion)?motion:undefined);
  const imported=selected&&selected in samples?selected as MeshyMotion:undefined;
  if(imported!=='sleep'||(activity?.bedRecline??1)<=0)bedSurface.reset();
  if(imported){
   const clip=meshyMotions[imported],hip=bodyHeightY(.38*BLANK_SCALE,rig.bodyHeight);
   for(const q of Object.values(importedPose))q.identity();
   samples[imported](activity?.clipTime??(imported==='sleep'?(activity?.bedRecline??1)*clip.duration:time),importedPose,importedRoot,imported==='yoga');
   const weight=activity?.clipWeight??(imported==='sleep'?T.MathUtils.smoothstep(activity?.bedRecline??1,0,.06):1);
   for(const [name,q]of Object.entries(importedPose))targets[name].slerp(q,weight);
   const offset=importedRoot.clone().multiplyScalar(hip);
   // Stationary furniture actions retain their local hip travel, not the source spawn location.
   offset.x-=clip.root[0]*hip;offset.z-=clip.root[2]*hip;
   if(imported==='sleep'){
    offset.z-=(clip.root.at(-1)!-clip.root[2])*hip;
    offset.y=-hip+.055*BLANK_SCALE+(importedRoot.y-clip.root.at(-2)!)*hip;
   }else if(imported==='sit-alternate')offset.y=-hip+.05*BLANK_SCALE;
   else if(imported!=='yoga')offset.y=0;
   position.lerp(offset,weight);rotation.slerp(new T.Quaternion(),weight);
   for(const side of ['L','R']as const){rig.setHandCurl(side,imported==='coffee-drink'?.4:.12,targets);constrainForearmTwist(rig,targets,side);}
  }
  if(activity?.kind==='pet-contact'){
   const crouch=activity.petCrouch??0;
   if(crouch>0){
    for(const [side,sign]of [['L',1],['R',-1]]as const){angle(side+'_thigh',-1.45*crouch,0,-sign*.09*crouch);angle(side+'_shin',2.45*crouch);angle(side+'_foot',-1*crouch);}
    angle('spine',.25*crouch);angle('head',.12*crouch);
   }
   // Keep the locomotion legs; hands are solved after the walk clip and foot grounding.
   for(const [side,sign]of [['L',1],['R',-1]]as const){angle(side+'_upperArm',-.15,-sign*.3,-sign*1.1);angle(side+'_forearm',0,-sign*.85,-sign*.08);}
  }
  for(const [name,bone] of entries)bone.quaternion.slerp(targets[name],blend);
  const footwear=body.userData.wardrobeLift as {height:number;applied:number}|undefined;
  if(footwear){const lift=lying&&!bed?0:footwear.height*(1-seatWeight);position.y+=lift;footwear.applied=T.MathUtils.lerp(footwear.applied,lift,blend);}
  body.position.lerp(position,blend);body.quaternion.slerp(rotation,blend);
  if(activity?.kind==='pet-contact'||importedWalk||bed&&Math.abs(activity.bedStep??0)>0||imported&&['dress-once','coffee-drink','wave-alternate-1','wave-alternate-2'].includes(imported)){
   // The source avatar's dimensions/root translation are not ours. Keep the
   // lower ankle on our own standing plane; preserve the source leg rotations.
   body.updateWorldMatrix(true,true);
   const lowest=Math.min(...['L_foot','R_foot'].map(name=>body.worldToLocal(rig.bones[name].getWorldPosition(footPoint)).y));
   body.position.y=position.y+bodyHeightY(.049*BLANK_SCALE,rig.bodyHeight)-lowest;
  }
  if(floorSeat&&(!imported||activity?.clipWeight===0)&&seatWeight>0&&activity?.seatHeight!==undefined)floorContact(activity.seatHeight,seatWeight,fold,support,footwear?.height??0);
  if(imported==='sleep'){
   const leisureTime=activity?.bedTime??time;
   let from:T.Quaternion[]|undefined;
   if(isBedLeisure(activity?.bedFrom)&&leisureTime<1.2){
    const base=entries.map(([,b])=>b.quaternion.clone());
    bedLeisure(Math.max(1.2,activity.bedFromTime??3),activity.bedFrom);
    supportBedHead(activity.bedFrom,activity?.bedRecline??1);
    from=entries.map(([,b])=>b.quaternion.clone());
    entries.forEach(([,b],i)=>b.quaternion.copy(base[i]));body.updateWorldMatrix(true,true);
   }
   if(activity?.kind==='bed-rest'&&isBedLeisure(activity.bedMode))bedLeisure(leisureTime,activity.bedMode);
   // The source has a human-sized skull. Let the chibi head rest with its chin
   // gently tucked instead of lifting the back/legs to clear the larger occiput.
   supportBedHead(activity?.bedMode,activity?.bedRecline??1);
   if(from){const mix=T.MathUtils.smootherstep(leisureTime,0,1.2);entries.forEach(([,b],i)=>b.quaternion.copy(from![i].slerp(b.quaternion,mix)));}
   const recline=activity?.bedRecline??1;
   const settle=activity?.bedMode==='bed-side'?0:T.MathUtils.smootherstep(recline,.75,1)*(activity?.bedFrom==='bed-side'?T.MathUtils.smootherstep(leisureTime,0,1.2):1);
   if(recline>0)bedSurface(.015*BLANK_SCALE,T.MathUtils.smootherstep(recline,0,.3),settle,activity?.bedFootSurface);
   if(settle===0)surfaceContact(.049*BLANK_SCALE);
  }
  if(imported==='sit-alternate'&&activity?.seatHeight!==undefined)surfaceContact(-activity.seatHeight+.049*BLANK_SCALE);
  if(imported==='yoga'){
   body.position.y=0;body.updateWorldMatrix(true,true);body.updateMatrixWorld(true);rig.skeleton.update();rig.mesh.computeBoundingBox();
   // Meshy's clip is exported below its own ground. Ground the posed body,
   // not its hip or its feet (which deliberately lift during the crunch).
   body.position.y=.035-rig.mesh.boundingBox!.min.y;
  }
  if(activity?.kind==='stream'&&seated){
   const f=computerFrame(time,true);samples['wave-alternate-1'](Math.max(0,time-.65),importedPose,importedRoot);
   for(const [name,bone]of entries)if(name.startsWith('L_')&&!['L_thigh','L_shin','L_foot','L_toe'].includes(name)){bone.quaternion.slerp(importedPose[name],f.greet);}
  }
  if(motion==='mirror-admire'&&!seated&&!lying)groom(time);
  if(activity&&['computer','stream'].includes(activity.kind)&&seated)computerContact(time,activity);
  if(furniture&&!lying)furnitureContact(time,activity);
  if(activity?.kind==='pet-contact')furnitureContact(Math.max(.65,time),activity);
  if(activity?.kind.startsWith('bath-'))bathroomContact(time,activity);
  if(seated&&!bed&&!floorSeat&&activity?.seatHeight!==undefined&&!activity.kind.startsWith('bath-')){
   surfaceContact(bodyHeightY(.049*BLANK_SCALE,rig.bodyHeight)-activity.seatHeight);
  }
  body.updateWorldMatrix(true,true);rig.skeleton.update();
  Object.assign(rig.mesh,{boundingBox:null,boundingSphere:null});
 };
}
