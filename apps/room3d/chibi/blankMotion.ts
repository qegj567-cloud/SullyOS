import * as T from 'three';
import {BLANK_SCALE} from './blankBody';
import type {bindBlankBody} from './blankRig';
import type {Motion,Posture,ActivityPose} from './types';

// Small FK poses in the rig's bind axes. Bone lengths and mesh data never change.
// Seat contact is normalized here, rather than adding offsets to every furniture.
export function createBlankMotion(rig:ReturnType<typeof bindBlankBody>,body:T.Group){
 const entries=Object.entries(rig.bones),targets=Object.fromEntries(entries.map(([name])=>[name,new T.Quaternion()]));
 const targetRotations=Object.values(targets),euler=new T.Euler(),position=new T.Vector3(),rotation=new T.Quaternion();
 let previous:number|undefined,previousMotion:Motion='idle',previousPosture:Posture='standing';
 const angle=(name:string,x=0,y=0,z=0)=>targets[name].setFromEuler(euler.set(x,y,z));
 return (time:number,motion:Motion,posture:Posture,activity?:ActivityPose)=>{
  time=Number.isFinite(time)?Math.max(0,time):0;
  const seated=posture==='seated'||motion==='sit',lying=posture==='lying';
  const wave=['wave','wave-calm','wave-cute'].includes(motion),cute=motion==='wave-cute';
  const dt=previous===undefined?0:time<previous||motion!==previousMotion||posture!==previousPosture?1/30:time-previous;
  // A static/reduced-motion draw must also reach the requested pose. A posture
  // change snaps to its contact plane; limb emotes can blend while it stays put.
  const blend=previous===undefined||posture!==previousPosture||motion==='idle'||dt===0||time>=.5&&motion!==previousMotion?1:1-Math.exp(-Math.min(dt,.5)*14);
  previous=time;previousMotion=motion;previousPosture=posture;
  for(const q of targetRotations)q.identity();
  position.set(0,0,0);rotation.identity();
  const breathe=Math.sin(time*1.8);
  angle('chest',-.015+breathe*.008);
  angle('head',.025+breathe*.008);
  for(const [side,prefix] of [[1,'L'],[-1,'R']] as const){
   rig.setHandCurl(prefix,motion==='angry'?.8:wave&&prefix==='L'?0:.12,targets);
   angle(`${prefix}_upperArm`,-.08,0,-side*1.25);
   angle(`${prefix}_forearm`,0,-side*.08,-side*.07);
   angle(`${prefix}_hand`,0,0,side*.05);
   if(seated){
    angle(`${prefix}_thigh`,-1.40,0,-side*.035);
    angle(`${prefix}_shin`,1.32+Math.sin(time*2.2+side)*.025);
    angle(`${prefix}_foot`,.08);
    // Rest beside the hips, with just enough outward space for the loose sleeves.
    angle(`${prefix}_upperArm`,-.04,0,-side*1.25);
    angle(`${prefix}_forearm`,0,-side*.04,-side*.04);
    angle(`${prefix}_hand`,0,0,side*.025);
   }
   if(motion==='walk'&&!seated&&!lying){
    const step=Math.sin(time*7)*side;
    angle(`${prefix}_thigh`,step*.24);
    angle(`${prefix}_shin`,Math.max(0,-step)*.30);
    angle(`${prefix}_foot`,-Math.max(0,-step)*.10);
    angle(`${prefix}_upperArm`,-step*.18,0,-side*1.25);
   }
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
  if(seated)position.y=(-.38*rig.bodyHeight+.05)*BLANK_SCALE;
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
  if(lying){
   // Existing bed anchor supplies the pillow clearance; lay the whole rig down.
   rotation.setFromEuler(euler.set(-Math.PI/2,0,0));position.set(0,0,0);
  }
  for(const [name,bone] of entries)bone.quaternion.slerp(targets[name],blend);
  const footwear=body.userData.wardrobeLift as {height:number;applied:number}|undefined;
  if(footwear){const lift=seated||lying?0:footwear.height;position.y+=lift;footwear.applied=T.MathUtils.lerp(footwear.applied,lift,blend);}
  body.position.lerp(position,blend);body.quaternion.slerp(rotation,blend);
  body.updateWorldMatrix(true,true);rig.skeleton.update();
  Object.assign(rig.mesh,{boundingBox:null,boundingSphere:null});
 };
}
