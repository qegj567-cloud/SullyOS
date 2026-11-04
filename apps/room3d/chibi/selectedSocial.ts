import {isSeasonalSocial,poseSeasonalSocial,seasonalExpression} from './seasonalSocial';
import {loadHalloweenProps} from './halloweenProps';
import {isFaceSocial} from './faceSocialContact';
import {actionExpression} from './actionExpression';
import * as T from 'three';
import type {ChibiVisitor} from './visitor';
import {selectedMotions,loadSelectedMotion,sampleSelected,type SelectedClip,type MotionFrame} from './selectedMotions';
import {contactSolver} from './socialContact';
import {furniturePalm} from './furnitureMotion';
import {createSocialProp} from './socialProps';
import {isIntimacy,isPrincessCarry,poseIntimacy} from './intimacyMotion';
import {prepareCarryFrame,carryCaptureWeight} from './princessCarry';
import {splitMotionHeading} from './motionHeading';
export {motionCategories} from './selectedMotions';
export type SocialAction=string;
export const socialActions=Object.fromEntries(selectedMotions.map(e=>[e.id,{...e,duration:e.duration+1.2}]));
export interface SocialResident {id:string;visitor:ChibiVisitor}
const yAxis=new T.Vector3(0,1,0),smooth=T.MathUtils.smootherstep;
/** Both roles share a clock and capture transform. Observers stay independent. */
export function createSocialScene(residents:SocialResident[],options:{canInteract?:(action:string,a:string,b?:string)=>boolean;facingTarget?:T.Vector3;pinned?:{id:string;pose:any};onComplete?:()=>void;canPlace?:(paths:T.Vector3[][])=>boolean;canPerform?:(paths:T.Vector3[][])=>boolean;origins?:T.Vector3[];findPath?:(from:T.Vector3,to:T.Vector3)=>T.Vector3[]|null}={}){
 if(new Set(residents.map(r=>r.id)).size!==residents.length)throw Error('Duplicate resident ID');
 if(residents.some(r=>!!r.visitor.rig!==!!residents[0]?.visitor.rig))throw Error('A home must use one body type');
 const states=new Map(residents.map(r=>[r.id,{...r,solver:contactSolver(r.visitor),home:r.visitor.root.position.clone(),rotation:r.visitor.root.quaternion.clone()}]));
 type Session={action:string;ids:string[];time:number;clip:SelectedClip;origin:T.Vector3;sourceOrigin:T.Vector3;rotation:T.Quaternion;scale:number;starts:T.Vector3[];turns:T.Quaternion[];paths:T.Vector3[][];approach:number};
 let session:Session|null=null,generation=0,loading=false;
 const pinned=options.pinned, pinnedState=pinned?states.get(pinned.id):undefined;
 const pinnedPosition=pinnedState?.home.clone(),pinnedRotation=pinnedState?.rotation.clone();
 const holdPinned=()=>{if(pinnedState&&pinned){pinnedState.visitor.root.position.copy(pinnedPosition!);pinnedState.visitor.root.quaternion.copy(pinnedRotation!);pinnedState.visitor.animate(0,'idle','seated',pinned.pose);}};
 let prop:ReturnType<typeof createSocialProp>=null;
 const finish=()=>{for(const r of states.values())r.visitor.finishPose();};
 function locations(s:Session,time:number){
  const points=s.clip.actors.map(a=>{const f=T.MathUtils.clamp((pinned?0:time)/a.duration,0,1)*(a.times.length-1),i=Math.floor(f),j=Math.min(i+1,a.times.length-1);return new T.Vector3().fromArray(a.positions,i*3).lerp(new T.Vector3().fromArray(a.positions,j*3),f-i).sub(s.sourceOrigin).setY(0).multiplyScalar(s.scale).applyQuaternion(s.rotation).add(s.origin);});
  if(points.length===2){const delta=points[1].clone().sub(points[0]),gap=delta.length(),minimum=residents[0].visitor.rig?.66:1.38;if(gap<minimum){if(gap<.001)delta.set(1,0,0);delta.normalize().multiplyScalar((minimum-gap)/2);points[0].sub(delta);points[1].add(delta);}}
  if(pinned){const index=s.ids.indexOf(pinned.id);if(index>=0){const offset=pinnedPosition!.clone().sub(points[index]);points.forEach((p,i)=>{p.add(offset);if(i!==index)p.y=s.starts[i].y;});}}
  if(pinned&&(s.action==='cmu-22_09'||s.action==='home-hug')){
   const seated=s.ids.indexOf(pinned.id),standing=1-seated;
   const distance=residents[0].visitor.rig?(s.action==='cmu-22_09'?1.2:1.0):1.4;
   const offset=new T.Vector3(0,0,(s.action==='cmu-22_09'?-1:1)*distance).applyQuaternion(pinnedRotation!);
   points[seated].copy(pinnedPosition!);points[standing].copy(pinnedPosition!).add(offset);points[standing].y=s.starts[standing].y;
  }
  return points;
 }
 const palm=(v:ChibiVisitor,side:string)=>v.rig!.bones[side+'_hand'].localToWorld(furniturePalm(side as 'L'|'R'));
 function contacts(both:ReturnType<typeof states.get>[],frames:MotionFrame[],weight:number){
  if(both.length!==2)return;
  if(session?.action==='home-hug'){
   both.forEach((owner,i)=>{const partner=both[1-i]!;
    for(const side of ['L','R'] as const){
     const opposite=side==='L'?'R':'L';
     const target=partner.visitor.rig?partner.visitor.rig.bones[opposite+'_upperArm'].getWorldPosition(new T.Vector3()):partner.visitor.classicPoint(opposite+'_upperArm');
     // Wrap toward the partner's back, with arms staggered to avoid interlocking.
     const q=partner.visitor.root.getWorldQuaternion(new T.Quaternion());
     target.add(new T.Vector3(0,i===0?-.08:-.14,-.18).applyQuaternion(q));
     if(owner!.solver)owner!.solver({side,point:target,direction:new T.Vector3(side==='L'?1:-1,0,0).applyQuaternion(q),normal:new T.Vector3(0,1,0),curl:.12},weight);
     else owner!.visitor.classicContact(side,target,weight);
    }
   });return;
  }
  const handled=new Set<string>();
  for(let i=0;i<2;i++)for(const side of ['L','R'] as const){
   const from=side+'_hand',a=frames[i].points[from],j=1-i;
   const passing=session!.action==='cmu-22_13';
   if(passing)continue; // The cup owns the two opposed grip targets during handover.
   const shoulders=['cmu-22_07','cmu-22_05','cmu-22_04','cmu-22_09','cmu-22_03'].includes(session!.action);
   const choices=(passing?[i===0?'R_hand':'L_hand']:shoulders?['L_upperArm','R_upperArm']:['L_hand','R_hand']).map(n=>({n,d:a.distanceTo(frames[j].points[n])})).sort((a,b)=>a.d-b.d),nearest=choices[0];
   const near=shoulders?.47:passing?.5:.20,far=shoulders?.64:passing?.6:.36;
   if(nearest.d>far||handled.has(i+from))continue;
   const owner=both[i]!,partner=both[j]!;
   if(!owner.visitor.rig){
    const target=partner.visitor.classicPoint(nearest.n),w=weight*(1-smooth(nearest.d,near,far));
    if(nearest.n.endsWith('hand')){target.lerp(owner.visitor.classicPoint(from),.5);partner.visitor.classicContact(nearest.n[0] as 'L'|'R',target,w);handled.add(j+nearest.n);}
    owner.visitor.classicContact(side,target,w);handled.add(i+from);continue;
   }
   const hand=owner.visitor.rig.bones[from],other=partner.visitor.rig!.bones[nearest.n];
   const target=nearest.n.endsWith('hand')?palm(partner.visitor,nearest.n[0]).lerp(palm(owner.visitor,side),.5):other.getWorldPosition(new T.Vector3()).add(new T.Vector3(nearest.n[0]==='L'?.04:-.04,.025,0).applyQuaternion(partner.visitor.root.getWorldQuaternion(new T.Quaternion())));
   const contactWeight=weight*(1-smooth(nearest.d,near,far));
   const q=hand.getWorldQuaternion(new T.Quaternion()),direction=new T.Vector3(side==='L'?1:-1,0,0).applyQuaternion(q),normal=new T.Vector3(0,1,0).applyQuaternion(q);
   owner.solver!({side,point:target,direction,normal,curl:nearest.n.endsWith('hand')?.35:0},contactWeight);
   if(nearest.n.endsWith('hand')){const otherSide=nearest.n[0] as 'L'|'R',oq=other.getWorldQuaternion(new T.Quaternion());partner.solver!({side:otherSide,point:target,direction:new T.Vector3(otherSide==='L'?1:-1,0,0).applyQuaternion(oq),normal:new T.Vector3(0,1,0).applyQuaternion(oq),curl:.35},contactWeight);handled.add(j+nearest.n);}
   handled.add(i+from);
  }
 }
 function draw(){
  if(!session){for(const r of states.values())if(r.id!==pinned?.id)r.visitor.animate(0,'idle');holdPinned();finish();return;}
  const s=session;
  if(s.time<s.approach){
   s.ids.forEach((id,i)=>{if(id===pinned?.id){holdPinned();return;}const v=states.get(id)!.visitor,path=s.paths[i],lengths=path.slice(1).map((p,j)=>p.distanceTo(path[j])),total=lengths.reduce((a,b)=>a+b,0);let distance=total*s.time/s.approach,index=0;while(index<lengths.length-1&&distance>lengths[index])distance-=lengths[index++];const from=path[index],to=path[index+1]??from;
    v.root.position.copy(from).lerp(to,lengths[index]?distance/lengths[index]:0);
    if(total>.01){const q=new T.Quaternion().setFromAxisAngle(yAxis,Math.atan2(to.x-from.x,to.z-from.z));v.root.quaternion.copy(s.turns[i]).slerp(q,smooth(s.time,0,.2));v.animate(s.time,'walk');}else v.animate(s.time,'idle');
   });finish();return;
  }
  const actionTime=s.time-s.approach,sourceTime=T.MathUtils.clamp(actionTime-.6,0,s.clip.duration),weight=smooth(actionTime,0,.6)*(1-smooth(actionTime,s.clip.duration+.6,s.clip.duration+1.2));
  const both=s.ids.map(id=>states.get(id)!),frames=s.clip.actors.map(a=>sampleSelected(a,sourceTime)),points=locations(s,sourceTime);
  for(const r of states.values())if(!s.ids.includes(r.id))r.visitor.animate(s.time,'idle');
  both.forEach((r,i)=>{
   if(r.id===pinned?.id){holdPinned();if(!isIntimacy(s.action))r.visitor.applySelectedFrame(frames[i],weight,pinned.pose);r.visitor.root.updateWorldMatrix(true,true);return;}
   r.visitor.root.position.copy(points[i]);const path=s.paths[i],last=path.at(-1)!,previous=path.at(-2)??last,turn=last.distanceTo(previous)>.001?new T.Quaternion().setFromAxisAngle(yAxis,Math.atan2(last.x-previous.x,last.z-previous.z)):s.turns[i];r.visitor.root.quaternion.copy(turn).slerp(s.rotation,smooth(actionTime,0,.6));
   if(r.visitor.rig&&['cmu-22_07','cmu-22_05','cmu-22_04','cmu-22_09'].includes(s.action))for(const n of ['hips','spine','chest','neck','head']){
    const q=frames[i].rotations[n],e=new T.Euler().setFromQuaternion(q,'YXZ'),limit=n==='head'?.08:n==='neck'?.06:n==='hips'?.04:.05;
    e.x=T.MathUtils.clamp(e.x,-limit,limit);e.z=T.MathUtils.clamp(e.z,-limit,limit);q.setFromEuler(e);
   }
   if(r.visitor.rig&&both.length===2&&['cmu-22_07','cmu-22_05','cmu-22_04','cmu-22_09'].includes(s.action)){
    const difference=r.visitor.rig.bodyHeight-both[1-i].visitor.rig!.bodyHeight;
    // The taller resident bends their knees to bring the shoulder into reach.
    // Keep segment lengths unchanged; sole grounding is applied by the visitor.
    const bend=T.MathUtils.clamp((difference-.15)*2.5,0,.78);
    if(bend){for(const side of ['L','R'])for(const [joint,angle] of [['thigh',-bend],['shin',bend*2],['foot',-bend]] as const)frames[i].rotations[`${side}_${joint}`].multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),angle));frames[i].position.y-=1-Math.cos(bend);}
   }
   if(isIntimacy(s.action)||isSeasonalSocial(s.action)){
    const other=points[1-i],toward=new T.Quaternion().setFromAxisAngle(yAxis,Math.atan2(other.x-points[i].x,other.z-points[i].z));
    r.visitor.root.quaternion.copy(turn).slerp(toward,smooth(actionTime,0,.6));
    if(s.clip.source==='meshy-text-to-motion'){
     if(isPrincessCarry(s.action))prepareCarryFrame(frames[i],sourceTime);
     if(isFaceSocial(s.action)){
      // Human torso bends place the oversized chibi head inside its partner.
      // Compress the captured angles smoothly, retaining their changing rhythm.
      for(const n of ['hips','spine','chest','neck','head']){
       const q=frames[i].rotations[n],e=new T.Euler().setFromQuaternion(q,'YXZ');
       const limit=n==='hips'?.12:n==='spine'||n==='neck'?.08:.16;
       e.x=limit*Math.tanh(e.x/.4);e.y=.18*Math.tanh(e.y/.4);e.z=.16*Math.tanh(e.z/.4);q.setFromEuler(e);
      }
     }
     r.visitor.applySelectedFrame(frames[i],weight*(isPrincessCarry(s.action)?carryCaptureWeight(sourceTime):1));
    }
    else r.visitor.animate(sourceTime,'idle');
   }else{
    const {heading,lean}=splitMotionHeading(frames[i].rotations.hips);
    // The sampled pelvis already contains this actor's capture heading. Put it
    // on the root before blending from the approach (and back out to idle).
    // At full weight root * lean is exactly the original root * pelvis pose.
    const facing=pinned&&s.action==='cmu-22_09'?pinnedRotation!.clone():s.rotation.clone().multiply(heading);
    r.visitor.root.quaternion.copy(turn).slerp(facing,smooth(actionTime,0,.6));
    if(both.length===2&&!(pinned&&s.action==='cmu-22_09')){const other=points[1-i],toward=new T.Quaternion().setFromAxisAngle(yAxis,Math.atan2(other.x-points[i].x,other.z-points[i].z));r.visitor.root.quaternion.slerp(toward,smooth(actionTime,s.clip.duration+.6,s.clip.duration+1.2));}
    frames[i].rotations.hips=lean;
    // Classic reconstructs hand offsets from capture points instead of bones.
    // Rotate those offsets into the same heading-free space, while contacts
    // continue reading the untouched paired capture coordinates in frames.
    const frame=frames[i],inverse=heading.clone().invert();
    const poseFrame=r.visitor.rig?frame:{...frame,points:Object.fromEntries(Object.entries(frame.points).map(([name,p])=>[name,p.clone().sub(frame.position).applyQuaternion(inverse).add(frame.position)]))};
    r.visitor.applySelectedFrame(poseFrame,weight);
   }
   r.visitor.root.updateWorldMatrix(true,true);
  });
  // The head has very different proportions from the source human. Separate
  // the actual posed head centres before solving hands, including height gaps.
  if(!pinned&&both.length===2&&both[0].visitor.rig&&!isIntimacy(s.action)){
   const heads=both.map(r=>r.visitor.rig!.bones.head.localToWorld(new T.Vector3(0,.72,0))),delta=heads[1].clone().sub(heads[0]),vertical=delta.y;delta.y=0;
   const needed=Math.sqrt(Math.max(0,.74**2-vertical**2)),gap=delta.length();
   if(gap<needed){if(gap<.001)delta.copy(points[1]).sub(points[0]);delta.normalize().multiplyScalar((needed-gap)/2);both[0].visitor.root.position.sub(delta);both[1].visitor.root.position.add(delta);both.forEach(r=>r.visitor.root.updateWorldMatrix(true,true));}
  }
  if(isSeasonalSocial(s.action))poseSeasonalSocial(s.action,both,sourceTime);else if(isIntimacy(s.action)&&both[0].visitor.rig)poseIntimacy(s.action,both,sourceTime,pinned?s.ids.indexOf(pinned.id):undefined);else contacts(both,frames,weight);prop?.update(sourceTime,s.clip.duration,weight);for(const [i,r] of both.entries())r.visitor.setActionExpression(isSeasonalSocial(s.action)?seasonalExpression(s.action,sourceTime,i):actionTime<s.clip.duration? actionExpression(s.action,socialActions[s.action].category,socialActions[s.action].label):'neutral',sourceTime);finish();
 }
 const restore=()=>{prop?.dispose();prop=null;session=null;draw();};
 return {
  get active(){return !!session;},
  async start(action:SocialAction,a:string,b?:string){
   const checkRelation=()=>{if(options.canInteract&&!options.canInteract(action,a,b))throw Error('这两位未设置浪漫关系，不能执行亲密动作');};checkRelation();
   const entry=socialActions[action];if(!entry)throw Error('这个动作没有被选中');
   if(!states.has(a)||entry.participants===2&&(!b||!states.has(b)||a===b))throw Error('请选择两位不同的居民');
   if(isSeasonalSocial(action)&&pinned)throw Error('这段互动需要两个人先站起来');
   if(isPrincessCarry(action)&&!states.get(a)!.visitor.rig)throw Error('公主抱需要二号素体');
   const token=++generation;restore();loading=true;
   try{const [sourceClip,propModels]=await Promise.all([loadSelectedMotion(action),loadHalloweenProps(action)]);if(token!==generation)return false;checkRelation();
    // This capture stores the seated recipient first and the crouching comforter second.
    // Keep semantic participant IDs (initiator, recipient) stable; only map the tracks.
    const clip=action==='cmu-22_03'?{...sourceClip,actors:[sourceClip.actors[1],sourceClip.actors[0]]}:sourceClip;
    const ids=entry.participants===2?(action==='home-princess-carried'?[b!,a]:[a,b!]):[a],both=ids.map(id=>states.get(id)!.visitor),starts=both.map(v=>v.root.position.clone()),turns=both.map(v=>v.root.quaternion.clone());
    const sourceOrigin=clip.actors.reduce((p,c)=>p.add(new T.Vector3().fromArray(c.positions)),new T.Vector3()).multiplyScalar(1/both.length);sourceOrigin.y=0;
    const origin=starts.reduce((p,c)=>p.add(c),new T.Vector3()).multiplyScalar(1/both.length),scale=both.reduce((n,v)=>n+v.motionScale,0)/both.length;
    const sourceAxis=clip.actors.length===2?new T.Vector3().fromArray(clip.actors[1].positions).sub(new T.Vector3().fromArray(clip.actors[0].positions)):new T.Vector3(0,0,1),axis=starts.length===2?starts[1].clone().sub(starts[0]):new T.Vector3(0,0,1).applyQuaternion(turns[0]);
    const rotation=new T.Quaternion().setFromAxisAngle(yAxis,Math.atan2(axis.x,axis.z)-Math.atan2(sourceAxis.x,sourceAxis.z));
    if(ids.length===1&&options.facingTarget){const direction=options.facingTarget.clone().sub(starts[0]);if(direction.lengthSq()>.0001)rotation.setFromAxisAngle(yAxis,Math.atan2(direction.x,direction.z));}
    if(pinned){const i=ids.indexOf(pinned.id),sourceHeading=splitMotionHeading(sampleSelected(clip.actors[i],0).rotations.hips).heading;rotation.copy(pinnedRotation!).multiply(sourceHeading.invert());}
    const candidate={action,ids,time:0,clip,origin,sourceOrigin,rotation,scale,starts,turns,paths:[] as T.Vector3[][],approach:0};
    const fits=()=>{const paths=both.map(()=>[] as T.Vector3[]),first=locations(candidate,0);
     const routes=starts.map((p,i)=>ids[i]===pinned?.id?[p.clone(),p.clone()]:options.findPath?options.findPath(p,first[i]):[p.clone(),first[i].clone()]);if(routes.some(p=>!p?.length))return false;
     candidate.paths=routes as T.Vector3[][];
     candidate.approach=Math.max(...candidate.paths.map((path,i)=>path.slice(1).reduce((n,p,j)=>n+p.distanceTo(path[j]),0)/(both[i].walkSpeed??1.05)));
     for(let i=0;i<routes.length;i++)for(let j=1;j<routes[i]!.length;j++){const from=routes[i]![j-1],to=routes[i]![j],steps=Math.max(1,Math.ceil(from.distanceTo(to)/.08));for(let step=0;step<=steps;step++)paths[i].push(from.clone().lerp(to,step/steps));}
     const moving=(paths:T.Vector3[][])=>paths.filter((_,i)=>ids[i]!==pinned?.id);
     if(options.canPlace&&!options.canPlace(moving(paths)))return false;
     const motion=both.map(()=>[] as T.Vector3[]);
     for(let t=0;t<=clip.duration+.001;t+=.1)locations(candidate,Math.min(t,clip.duration)).forEach((p,i)=>motion[i].push(p));
     if(isFaceSocial(action))for(const path of motion){const bases=[...path];for(const p of bases)for(const [x,z] of [[.24,0],[-.24,0],[0,.24],[0,-.24]])path.push(p.clone().add(new T.Vector3(x,0,z)));}
     const perform=options.canPerform||options.canPlace;
     if(perform&&!perform(moving(motion)))return false;
     // Temporary furniture overlap must not leave the residents standing in it.
     return !options.canPlace||options.canPlace(moving(locations(candidate,clip.duration).map(p=>[p])));};
    let valid=fits();if(!valid&&pinned&&action!=='cmu-22_09'&&action!=='home-hug'){const base=rotation.clone();for(const angle of [.35,-.35,.7,-.7,1.1,-1.1,Math.PI]){candidate.rotation=base.clone().multiply(new T.Quaternion().setFromAxisAngle(yAxis,angle));if(fits()){valid=true;break;}}}if(!valid&&!pinned)for(const alternative of options.origins??[]){candidate.origin=alternative.clone();if(fits()){valid=true;break;}}
    if(!valid)throw Error(action==='cmu-22_09'?'坐着的人身后没有可站立的位置，请先给椅背后留出空地':'这段动作需要更大的空地，先移动居民或挪开家具');
    session=candidate;prop=createSocialProp(action,both,propModels);draw();return true;
   }finally{if(token===generation)loading=false;}
  },
  advance(seconds:number){if(!Number.isFinite(seconds)||seconds<0)return;if(session){session.time=Math.min(session.time+seconds,socialActions[session.action].duration+session.approach);draw();if(session.time>=socialActions[session.action].duration+session.approach){restore();options.onComplete?.();}}},
  seek(seconds:number){if(session&&Number.isFinite(seconds)){session.time=T.MathUtils.clamp(seconds,0,socialActions[session.action].duration+session.approach);draw();}},
  cancel(){generation++;loading=false;restore();},
  reset(){generation++;loading=false;restore();for(const r of states.values()){r.visitor.root.position.copy(r.home);r.visitor.root.quaternion.copy(r.rotation);}draw();},
  inspect(){return {loading,session:session&&{action:session.action,participants:session.ids,time:session.time,duration:socialActions[session.action].duration+session.approach,phase:session.time<session.approach?'approach':session.time<session.approach+.6?'enter':session.time>session.approach+session.clip.duration+.6?'release':'perform'},residents:residents.map(r=>({id:r.id,body:r.visitor.rig?'blank':'classic',position:r.visitor.root.position.toArray(),role:session?.ids[0]===r.id?'initiator':session?.ids[1]===r.id?'recipient':'observer'}))};},
 };
}
