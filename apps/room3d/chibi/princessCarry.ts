import * as T from 'three';
import type {ChibiVisitor} from './visitor';
import type {MotionFrame} from './selectedMotions';
import type {contactSolver} from './socialContact';
import {furnitureHandRotation,furniturePalm} from './furnitureMotion';

type Resident={visitor:ChibiVisitor;solver:ReturnType<typeof contactSolver>};
const smooth=T.MathUtils.smootherstep;
const rotation=(x=0,y=0,z=0)=>new T.Quaternion().setFromEuler(new T.Euler(x,y,z));
const envelope=(t:number,a:number,b:number,c:number,d:number)=>smooth(t,a,b)*(1-smooth(t,c,d));
/** A fixed elbow pole avoids the two valid CCD solutions swapping as the
 * partner turns. A stable bend plane keeps the forearm helpers from flipping. */
function cradleContact(v:ChibiVisitor,side:'L'|'R',palm:T.Vector3,handWorld:T.Quaternion,weight:number,curl:number){
 const rig=v.rig!,upper=rig.bones[side+'_upperArm'],fore=rig.bones[side+'_forearm'],hand=rig.bones[side+'_hand'];
 const scale=hand.getWorldScale(new T.Vector3()).y,shoulder=upper.getWorldPosition(new T.Vector3());
 const wrist=palm.clone().sub(furniturePalm(side).multiplyScalar(scale).applyQuaternion(handWorld));
 const direction=wrist.sub(shoulder),l1=fore.position.length()*scale,l2=hand.position.length()*scale;
 // Ease toward full reach instead of hitting the straight-elbow singularity.
 const reach=l1+l2,raw=direction.length(),soft=.8*reach;
 const distance=Math.max(Math.abs(l1-l2)+.001,raw<=soft?raw:soft+.17*reach*Math.tanh((raw-soft)/(.17*reach)));direction.normalize();
 const pole=new T.Vector3(side==='L'?.75:-.75,-.6,-.4).applyQuaternion(v.root.getWorldQuaternion(new T.Quaternion()));
 pole.addScaledVector(direction,-pole.dot(direction)).normalize();
 const along=(l1*l1-l2*l2+distance*distance)/(2*distance);
 const elbow=shoulder.clone().addScaledVector(direction,along).addScaledVector(pole,Math.sqrt(Math.max(0,l1*l1-along*along)));
 const end=shoulder.clone().addScaledVector(direction,distance);
 const sign=side==='L'?1:-1,x=end.sub(elbow).normalize().multiplyScalar(sign);
 const z=new T.Vector3().crossVectors(direction,pole).normalize().multiplyScalar(sign),y=new T.Vector3().crossVectors(z,x).normalize();
 const foreWorld=new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x,y,z));
 const upperWorld=new T.Quaternion().setFromUnitVectors(fore.position.clone().normalize().applyQuaternion(foreWorld),elbow.sub(shoulder).normalize()).multiply(foreWorld);
 upper.quaternion.slerp(upper.parent!.getWorldQuaternion(new T.Quaternion()).invert().multiply(upperWorld),weight);
 fore.quaternion.slerp(upperWorld.clone().invert().multiply(foreWorld),weight);
 hand.quaternion.slerp(foreWorld.clone().invert().multiply(handWorld),weight);
 for(const suffix of ['twist1','twist2','twist3'])rig.bones[side+'_'+suffix].quaternion.identity();
 rig.setHandCurl(side,curl*weight);v.root.updateWorldMatrix(true,true);
}
export const carryCaptureWeight=(time:number)=>envelope(time,.1,1,9.05,9.95);
export function carryPhase(time:number){
 return {
  arms:envelope(time,.15,.95,9.4,10),
  support:envelope(time,1.15,2.35,8.65,9.4),
  turn:envelope(time,1.45,3.65,7.4,8.7),
  lift:envelope(time,2.2,4.2,7.2,8.6),
  fold:envelope(time,2.05,3.9,7.4,8.6),
  hold:envelope(time,3.85,4.6,6.65,7.4),
  crouch:.64*(envelope(time,.55,1.95,2.3,4.15)+envelope(time,6.85,8.35,8.55,9.8)),
 };
}

/** Keep Meshy's changing performance within the doll's short torso and large head.
 * The pair solver owns translation/turning; raw human root drift is not a lift. */
export function prepareCarryFrame(frame:MotionFrame,time:number){
 const p=carryPhase(time);
 frame.position.y=0;
 for(const [name,q]of Object.entries(frame.rotations)){
  // Hands have shared pair targets; independent captured wrists cannot keep them.
  if(/^[LR]_(upperArm|forearm|hand)$/.test(name)){delete frame.rotations[name];continue;}
  const e=new T.Euler().setFromQuaternion(q,'YXZ');
  const limit=name==='hips'?.08:name==='spine'?.12:name==='chest'?.20:name==='neck'?.13:name==='head'?.23:null;
  if(limit!==null){e.x=limit*Math.tanh(e.x/.35);e.y=limit*Math.tanh(e.y/.35);e.z=limit*Math.tanh(e.z/.35);q.setFromEuler(e);}
  // Gentle capture detail in the free ankles; the support legs are grounded below.
  if(name.endsWith('_foot'))q.identity().slerp(rotation(e.x*.12,e.y*.08,e.z*.08),p.hold);
 }
}

/** Recomputed from this frame's captured pose, never integrated from the last frame. */
export function posePrincessCarry(both:Resident[],time:number){
 const [a,b]=both.map(r=>r.visitor),p=carryPhase(time);if(!a.rig||!b.rig)return;
 const point=(v:ChibiVisitor,n:string,offset=[0,0,0])=>v.rig!.bones[n].localToWorld(new T.Vector3(...offset));
 const turn=(v:ChibiVisitor,n:string,q:T.Quaternion,w:number)=>v.rig!.bones[n].quaternion.slerp(q,w);
 const add=(v:ChibiVisitor,n:string,x:number,y=0,z=0)=>v.rig!.bones[n].quaternion.multiply(rotation(x,y,z));
 const sole=(v:ChibiVisitor)=>Math.min(...['L_toe','R_toe','L_foot','R_foot'].map(n=>point(v,n).y));
 const floorA=sole(a),floorB=sole(b),axis=a.root.getWorldQuaternion(new T.Quaternion());
 const breathe=Math.sin((time-4.2)*2.3)*p.hold,sway=Math.sin((time-4.2)*1.3)*p.hold;
 // Bend before the load comes up; straighten through the legs rather than
 // translating an upright carrier. The second dip receives the partner's feet.
 for(const side of ['L','R']as const){
  const sign=side==='L'?1:-1;
  turn(a,side+'_thigh',rotation(-p.crouch,0,-sign*.045*p.arms),1);
  turn(a,side+'_shin',rotation(p.crouch*2),1);
  turn(a,side+'_foot',rotation(-p.crouch),1);
 }
 add(a,'spine',p.crouch*.16-.045*p.lift,0,sway*.012);
 add(a,'chest',breathe*.008,0,-sway*.008);
 add(a,'head',.10*p.lift,.12*p.hold,-.035*p.hold);
 a.root.updateWorldMatrix(true,true);a.translatePose(new T.Vector3(0,floorA-sole(a),0));

 // Turn and tuck are offset in time: the partner settles into the cradle,
 // then uncurls the legs as the carrier lowers, before either hand lets go.
 turn(b,'hips',rotation(0,Math.PI/2*p.turn,0).multiply(rotation(-.78*p.lift,0,.035*sway)),p.arms);
 for(const side of ['L','R']as const){
  const sign=side==='L'?1:-1;
  turn(b,side+'_thigh',rotation(-(1.18+(side==='R'?.10:0))*p.fold,0,-sign*.035*p.fold),p.arms);
  turn(b,side+'_shin',rotation((1.48+(side==='L'?.10:0))*p.fold),p.arms);
  add(b,side+'_foot',(.05+sign*.022*breathe)*p.fold,0,sign*.025*p.hold);
 }
 add(b,'chest',-.035*p.lift+breathe*.009,0,.018*sway);
 add(b,'head',.07*p.lift,-.18*p.lift,.09*p.lift);
 b.root.updateWorldMatrix(true,true);
 // Floor-ground the changing leg pose before blending into the carrier's cradle.
 b.translatePose(new T.Vector3(0,floorB-sole(b),0));
 const target=point(a,'hips',[.14,.43+.012*breathe,.75]);
 b.translatePose(target.sub(point(b,'hips')).multiplyScalar(p.lift));
 // A tall recipient reaches the floor earlier when held by a shorter carrier.
 b.translatePose(new T.Vector3(0,Math.max(0,floorB-sole(b)),0));
 // A small shared sway remains supported: the targets are evaluated after both torsos.
 for(const [i,v]of [a,b].entries())for(const side of ['L','R']as const){
  const sign=side==='L'?1:-1;
  turn(v,side+'_upperArm',rotation(-.12,-sign*.65,-sign*(i===0?.84:.72)),p.arms);
  turn(v,side+'_forearm',rotation(0,-sign*.32,-sign*.18),p.arms);
 }
 a.root.updateWorldMatrix(true,true);b.root.updateWorldMatrix(true,true);
 const solve=(i:number,side:'L'|'R',target:T.Vector3,normal:T.Vector3,direction:T.Vector3)=>{
  const v=both[i].visitor,sign=side==='L'?1:-1,owner=v.root.getWorldQuaternion(new T.Quaternion());
  const ready=point(v,'chest',[sign*.85,-.3,.65]);
  const goal=ready.lerp(target,p.support).add(new T.Vector3(sign*.25,.1,.4).applyQuaternion(owner).multiplyScalar(Math.sin(Math.PI*p.support)));
  const start=furnitureHandRotation(side,new T.Vector3(sign,0,.25).applyQuaternion(owner).toArray(),new T.Vector3(0,0,-1).applyQuaternion(owner).toArray());
  const end=furnitureHandRotation(side,direction.toArray(),normal.toArray());start.slerp(end,p.support);
  cradleContact(v,side,goal,start,p.arms,i===0?.35:.22);
 };
 const back=b.rig.bones.chest.getWorldQuaternion(new T.Quaternion());
 // +Y is the back of the hand; palms face into the back and up under the knees.
 solve(0,'L',point(b,'spine',[0,.06,-.23]),new T.Vector3(0,0,-1).applyQuaternion(back),new T.Vector3(1,.15,0).normalize().applyQuaternion(back));
 // As the legs unfold, roll from a palm-up cradle into a fingers-down guide.
 // Keeping a horizontal wrist under a straightening knee forces a 180° roll.
 solve(0,'R',point(b,'R_shin',[0,.10,-.12]),new T.Vector3(0,-p.lift,-(1-p.lift)).normalize().applyQuaternion(axis),new T.Vector3(-p.lift,-(1-p.lift),.1).normalize().applyQuaternion(axis));
 for(const side of ['L','R']as const){const sign=side==='L'?1:-1;
  solve(1,side,point(a,side==='L'?'R_upperArm':'L_upperArm',[0,.08,-.12]),new T.Vector3(0,0,-1).applyQuaternion(axis),new T.Vector3(sign,.1,0).normalize().applyQuaternion(axis));
 }
}
