// Retired presentation poses retained ONLY for clothing stress regressions.
import * as T from 'three';
import {aimTwist,constrainForearmTwist,extractTwist} from '../../experiments/chibi/forearmTwist';
import {BLANK_SCALE} from '../../apps/room3d/chibi/blankBody';
import type {bindBlankBody} from '../../apps/room3d/chibi/blankRig';
import approvedStandingPose from '../../apps/room3d/chibi/approvedStandingPose.json';

// The fitting workbench's default-pose.json is the user's cardigan-pose (2).json.
// Its controls store [arm drop, twist, forward], in degrees, mirrored per side.
function applyApprovedStandingPose(rig:ReturnType<typeof bindBlankBody>,pose:Record<string,T.Quaternion>){
 for(const q of Object.values(pose))q.identity();
 for(const [name,v] of Object.entries(approvedStandingPose.state)){
  const sign=name.startsWith('L')?1:-1;
  pose[name].setFromEuler(new T.Euler(T.MathUtils.degToRad(v[2]),-sign*T.MathUtils.degToRad(v[1]),-sign*T.MathUtils.degToRad(v[0]),'XYZ'));
 }
 for(const side of ['L','R'] as const)rig.setHandCurl(side,approvedStandingPose.handCurl,pose);
}

/** Approved normal fitting stance, plus the separate boy/cute presentation idles. */
export type WardrobeStyle='cute'|'boy'|'normal';
export function createWardrobePose(rig:ReturnType<typeof bindBlankBody>,style:WardrobeStyle='cute'){
 const pose=Object.fromEntries(Object.keys(rig.bones).map(name=>[name,new T.Quaternion()]));
 const values=Object.fromEntries(Object.keys(pose).map(name=>[name,[] as number[]]));
 const times:number[]=[],duration=4,frames=120,euler=new T.Euler();
 const rotate=(name:string,x=0,y=0,z=0)=>pose[name].setFromEuler(euler.set(x,y,z));
 for(let frame=0;frame<=frames;frame++){
  const phase=(frame===frames?0:frame/frames)*Math.PI*2;
  const sway=Math.sin(phase),breath=Math.sin(phase-.45),lag=Math.sin(phase-.7);
  times.push(frame/30);for(const q of Object.values(pose))q.identity();
  // Keep the pelvis still so the supporting left foot stays planted.
  rotate('spine',-.035+breath*.018,0,.14+sway*.06);
  // Character-left is +X: chest turns left, head counters toward character-right.
  rotate('chest',.04+breath*.025,.14+sway*.025,-.05-sway*.025);
  rotate('head',.09+breath*.025,-.34+lag*.025,-.16-lag*.035);
  rotate('L_clavicle',0,0,-.085-breath*.012);rotate('R_clavicle',0,0,.035+breath*.025);
  // Cute outfit presentation: elbows slightly out, open forearms and soft lifted wrists.
  for(const [side,prefix] of [[1,'L'],[-1,'R']] as const){
   rotate(`${prefix}_upperArm`,.025+lag*.025,0,-side*(1.22+lag*.018));
   rotate(`${prefix}_forearm`,-.045,-side*.065,side*(.59+breath*.03));
   rotate(`${prefix}_hand`,.035,0,side*(.55+lag*.035));
  }
  for(const [side,prefix] of [[1,'L'],[-1,'R']] as const){
   rotate(`${prefix}_thigh`,0,-side*.055,0);
   rotate(`${prefix}_foot`,0,-side*.19,0);
   rig.setHandCurl(prefix,.08+breath*.015,pose);
  }
  // Right knee lifts slightly; ankle counters the leg bend to keep the shoe level.
  const thigh=-.30,knee=.95+breath*.045;
  rotate('R_thigh',thigh,.055,-.025);
  rotate('R_shin',knee,0,0);
  rotate('R_foot',-(thigh+knee),.19,0);
  if(style==='boy'){
   rotate('spine',-.025+breath*.014,0,-.055+sway*.025);
   rotate('chest',.025+breath*.018,.14+sway*.02,.02);
   rotate('head',.17+breath*.02,-.27+lag*.025,.055+lag*.02);
   rotate('L_clavicle',0,0,-.035);rotate('R_clavicle',0,0,.055);
   // Character-right hand rests on the waist; the opposite arm presents the outfit.
   rotate('R_upperArm',-.62,.20,.50);
   rotate('R_forearm',0,.10,2.50);rotate('R_hand',.04,0,.05);
   rotate('L_upperArm',.02+lag*.02,0,-1.23+lag*.02);
   rotate('L_forearm',-.04,-.10,.85+breath*.02);rotate('L_hand',.04,0,.08+lag*.02);
   rotate('L_thigh',0,0,.16);rotate('L_shin');rotate('L_foot',0,0,-.16);
   rotate('R_thigh',0,-.07,-.16);rotate('R_shin');rotate('R_foot',0,-.42,.16);
   rig.setHandCurl('R',.58,pose);rig.setHandCurl('L',.03,pose);
   // Solve the right arm to a waist-side target in chest space.
   const world=(name:string):{p:T.Vector3;q:T.Quaternion}=>{
    const bone=rig.bones[name],parent=bone.parent;
    const w=parent&&rig.bones[parent.name]?world(parent.name):{p:new T.Vector3(),q:new T.Quaternion()};
    return {p:bone.position.clone().applyQuaternion(w.q).add(w.p),q:w.q.clone().multiply(pose[name])};
   };
   const chest=world('chest'),shoulder=world('R_upperArm').p;
   const target=new T.Vector3(-.122,-.143*rig.bodyHeight,.048).multiplyScalar(BLANK_SCALE).applyQuaternion(chest.q).add(chest.p);
   const delta=target.clone().sub(shoulder),distance=delta.length(),direction=delta.normalize();
   const a=rig.bones.R_forearm.position.length(),b=rig.bones.R_hand.position.length();
   const along=(a*a-b*b+distance*distance)/(2*distance);
   const pole=new T.Vector3(-1,-.1,.1).applyQuaternion(chest.q);
   pole.addScaledVector(direction,-pole.dot(direction)).normalize();
   const elbow=shoulder.clone().addScaledVector(direction,along).addScaledVector(pole,Math.sqrt(Math.max(0,a*a-along*along)));
   const upperDirection=elbow.clone().sub(shoulder).normalize(),lowerDirection=target.clone().sub(elbow).normalize();
   const hinge=upperDirection.clone().cross(lowerDirection).normalize();
   const orient=(direction:T.Vector3)=>{
    const x=direction.clone().negate(),z=hinge.clone(),y=z.clone().cross(x).normalize();
    return new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x,y,z));
   };
   const upperWorld=orient(upperDirection);
   pose.R_upperArm.copy(world('R_clavicle').q.invert().multiply(upperWorld));
   const lowerWorld=orient(lowerDirection).multiply(new T.Quaternion().setFromUnitVectors(rig.bones.R_hand.position.clone().normalize(),new T.Vector3(-1,0,0)));
   pose.R_forearm.copy(upperWorld.clone().invert().multiply(lowerWorld));
   // Copy ONLY forearm-axis twist in local space; keep wrist bend separate.
   for(const side of ['L','R'] as const){
    const axis=rig.bones[`${side}_hand`].position.clone().normalize();
    const forearmWorld=world(`${side}_forearm`).q;
    const direction=new T.Vector3(0,side==='L'?-1:0,side==='R'?1:0).applyQuaternion(forearmWorld);
    const worldAxis=axis.clone().applyQuaternion(forearmWorld);
    let roll=aimTwist(direction,worldAxis,new T.Vector3(0,side==='L'?1:-1,0));
    let desiredHand:T.Quaternion|undefined;
    if(side==='R'){
     // Palm faces the flank; fingertips wrap diagonally toward the back.
     const x=new T.Vector3(-.4,.35,.91).normalize();
     const z=new T.Vector3(0,-1,0).addScaledVector(x,x.y).normalize();
     const y=z.clone().cross(x).normalize();
     desiredHand=chest.q.clone().multiply(new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x,y,z)));
     const local=forearmWorld.clone().invert().multiply(desiredHand),twist=extractTwist(local,axis);
     roll=2*Math.atan2(new T.Vector3(twist.x,twist.y,twist.z).dot(axis),twist.w);
    }
    // Spread axial roll over the full arm without moving elbow or wrist.
    // Upper arm takes 25%, forearm reaches 50%, hand completes the rotation.
    const upperAxis=rig.bones[`${side}_forearm`].position.clone().normalize();
    pose[`${side}_upperArm`].multiply(new T.Quaternion().setFromAxisAngle(upperAxis,roll*.25));
    const lowerWorld=forearmWorld.clone().multiply(new T.Quaternion().setFromAxisAngle(axis,roll*.5));
    pose[`${side}_forearm`].copy(world(`${side}_upperArm`).q.invert().multiply(lowerWorld));
    if(desiredHand)pose[`${side}_hand`].copy(lowerWorld.clone().invert().multiply(desiredHand));
    else pose[`${side}_hand`].setFromAxisAngle(axis,roll*.5);
    constrainForearmTwist(rig,pose,side);
   }


  }
  if(style==='normal'){
   applyApprovedStandingPose(rig,pose);
  }
  for(const [name,q] of Object.entries(pose))q.toArray(values[name],values[name].length);
 }
 return new T.AnimationClip(style==='boy'?'WardrobeStandBoy':style==='normal'?'WardrobeStandNeutral':'WardrobeStand',duration,Object.entries(values).map(([name,v])=>
  new T.QuaternionKeyframeTrack(`${name}.quaternion`,times,v)));
}

/** Ease from relaxed standing into the moving idle, matching its pose and velocity. */
export function createWardrobeEntrance(rig:ReturnType<typeof bindBlankBody>,idle=createWardrobePose(rig)){
 const duration=1.4,frames=42,times=Array.from({length:frames+1},(_,i)=>i/30);
 const neutral=Object.fromEntries(Object.keys(rig.bones).map(name=>[name,new T.Quaternion()]));
 const set=(name:string,x=0,y=0,z=0)=>neutral[name].setFromEuler(new T.Euler(x,y,z));
 for(const [side,prefix] of [[1,'L'],[-1,'R']] as const){
  set(`${prefix}_upperArm`,.025,0,-side*1.43);set(`${prefix}_forearm`,-.035,0,-side*.015);
  set(`${prefix}_hand`,0,0,side*.05);set(`${prefix}_thigh`,0,-side*.055);set(`${prefix}_foot`,0,-side*.19);
  rig.setHandCurl(prefix,.16,neutral);
 }
 if(idle.name==='WardrobeStandBoy'){
  set('L_thigh');set('L_foot');set('R_thigh',0,-.07);set('R_foot',0,-.42);
 }
 // Outfit changes rebuild the preview; keep normal at the approved pose throughout.
 if(idle.name==='WardrobeStandNeutral')applyApprovedStandingPose(rig,neutral);
 const tracks=idle.tracks.map(track=>{
  const name=track.name.replace('.quaternion',''),values:number[]=[],q=new T.Quaternion(),target=new T.Quaternion();
  const sample=new T.QuaternionLinearInterpolant(track.times,track.values,4);
  for(let frame=0;frame<=frames;frame++){
   const u=frame/frames,ease=u*u*u*(u*(u*6-15)+10);
   const idleTime=frame===frames?0:(times[frame]-duration+idle.duration)%idle.duration;
   target.fromArray(sample.evaluate(idleTime));q.slerpQuaternions(neutral[name],target,ease).toArray(values,values.length);
  }
  return new T.QuaternionKeyframeTrack(track.name,times,values);
 });
 return new T.AnimationClip(idle.name==='WardrobeStandBoy'?'StandToWardrobeBoy':'StandToWardrobe',duration,tracks);
}
