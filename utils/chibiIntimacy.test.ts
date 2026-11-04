import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {createBlankBody,BLANK_SCALE} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {createBlankMotion} from '../apps/room3d/chibi/blankMotion';
import {contactSolver} from '../apps/room3d/chibi/socialContact';
import {poseIntimacy} from '../apps/room3d/chibi/intimacyMotion';
import type {ChibiVisitor} from '../apps/room3d/chibi/visitor';
import {createSocialScene} from '../apps/room3d/chibi/selectedSocial';
import {furniturePalm} from '../apps/room3d/chibi/furnitureMotion';
import {BLANK_FINGERS} from '../apps/room3d/chibi/blankFingers';
import {carryPhase} from '../apps/room3d/chibi/princessCarry';

it('keeps captured carry contacts continuous, supports through landing and replays independently of seek order',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>JSON.parse(readFileSync('public/'+url.replace(/^\//,''),'utf8'))})));
 try{for(const heights of [[1,1],[.8,1.25],[1.25,.8]])for(const action of ['home-princess-carry','home-princess-carried']){
  const both=[actor(heights[0],-.45,0),actor(heights[1],.45,Math.PI)];
  const runtime=createSocialScene(both.map((r,i)=>({id:String(i),visitor:r.visitor})));
  await runtime.start(action,'0','1');const start=runtime.inspect().session!.duration-10.6;
  const sample=(t:number)=>{runtime.seek(start+t);return both.flatMap(r=>Object.entries(r.visitor.rig!.bones).map(([name,b])=>({name,q:b.getWorldQuaternion(new T.Quaternion()),p:b.getWorldPosition(new T.Vector3())})));};
  let previous=sample(0),max=0,where='';
  for(let i=1;i<=300;i++){const current=sample(i/30);current.forEach((b,j)=>{const step=b.q.angleTo(previous[j].q);if(step>max){max=step;where=`${b.name} at ${i/30}`;}expect(b.p.toArray().every(Number.isFinite)).toBe(true);});previous=current;}
  expect(max,`${action} ${heights}: ${where}`).toBeLessThan(.45);
  const hold=sample(5);sample(1);const replay=sample(5);hold.forEach((b,i)=>{expect(b.q.angleTo(replay[i].q)).toBeLessThan(1e-6);expect(b.p.distanceTo(replay[i].p)).toBeLessThan(1e-6);});
  const carrier=both[action==='home-princess-carry'?0:1].visitor,recipient=both[action==='home-princess-carry'?1:0].visitor;
  expect(carrier.rig!.bones.R_hand.localToWorld(furniturePalm('R')).distanceTo(recipient.rig!.bones.R_shin.getWorldPosition(new T.Vector3()))).toBeLessThan(.18);
  const moving=sample(5.6);expect(Math.max(...moving.map((b,i)=>b.p.distanceTo(hold[i].p)))).toBeGreaterThan(.005);
  // Both actions share a clock: feet finish lowering before support releases.
  expect(carryPhase(8.65).lift).toBe(0);expect(carryPhase(8.65).support).toBe(1);
  runtime.cancel();both.forEach(r=>r.visitor.rig!.mesh.geometry.dispose());
 }}finally{vi.unstubAllGlobals();}
});

function actor(height:number,z:number,angle:number){
 const root=new T.Group(),body=new T.Group(),hair=new T.Group();root.scale.setScalar(2.8/BLANK_SCALE);root.position.z=z;root.rotation.y=angle;root.add(body);
 const mesh=new T.Mesh(createBlankBody('skin',{bodyHeight:height}),new T.MeshBasicMaterial());body.add(mesh,hair);
 const rig=bindBlankBody(mesh,hair,true),animate=createBlankMotion(rig,body);
 const visitor={root,rig,motionScale:1,animate:(time:number,motion:any='idle',posture:any='standing',activity:any=undefined)=>animate(time,motion,posture,activity),setActionExpression:vi.fn(),finishPose:()=>root.updateWorldMatrix(true,true),translatePose(delta:T.Vector3){const start=root.worldToLocal(new T.Vector3()),end=root.worldToLocal(delta.clone());body.position.add(end.sub(start));root.updateWorldMatrix(true,true);}} as unknown as ChibiVisitor;
 const reset=()=>{animate(0,'idle','standing');root.updateWorldMatrix(true,true);};reset();
 visitor.applySelectedFrame=(frame,weight=1)=>{reset();for(const [name,q]of Object.entries(frame.rotations))rig.bones[name]?.quaternion.slerp(q,weight);root.updateWorldMatrix(true,true);};
 return {visitor,solver:contactSolver(visitor),body,reset};
}
it('paired intimacy preserves all 48 bones, grounds the carrier, lifts then releases the recipient across heights and headings',()=>{
 for(const heights of [[1,1],[.8,1.25],[1.25,.8]])for(const heading of [0,Math.PI/2]){
  const a=actor(heights[0],-.38,0),b=actor(heights[1],.38,Math.PI),both=[a,b];
  const stage=new T.Group();stage.rotation.y=heading;stage.add(a.visitor.root,b.visitor.root);stage.updateMatrixWorld(true);
  const lengths=both.map(r=>r.visitor.rig!.skeleton.bones.map(b=>b.position.length()));
  const foot=(r:typeof a)=>r.visitor.rig!.bones.L_foot.getWorldPosition(new T.Vector3());
  const initial=foot(a).y;
  for(const action of ['home-hug','home-princess-carry'])for(const time of [0,1.5,3,5,7.5,9,10]){
   both.forEach(r=>r.reset());poseIntimacy(action,both,time);
   both.forEach((r,i)=>{expect(r.visitor.rig!.skeleton.bones).toHaveLength(48);expect(r.visitor.rig!.skeleton.bones.map(b=>b.position.length())).toEqual(lengths[i]);expect(r.visitor.rig!.skeleton.bones.every(b=>b.matrixWorld.elements.every(Number.isFinite))).toBe(true);});
   expect(foot(a).y).toBeCloseTo(initial,2);
   if(action==='home-princess-carry'&&time===5)expect(foot(b).y).toBeGreaterThan(.2);
   if(time===10){expect(b.body.position.length()).toBeCloseTo(0,4);}
  }
  both.forEach(r=>{r.reset();expect(r.body.position.length()).toBe(0);r.visitor.rig!.mesh.geometry.dispose();});
 }
});
it('raises hands before contact, pats with one hand while the other supports, and returns smoothly when seeking',()=>{
 const both=[actor(1,-.33,0),actor(1.15,.33,Math.PI)];
 const sample=(time:number)=>{both.forEach(r=>r.reset());poseIntimacy('home-hug',both,time);return both.map(r=>Object.fromEntries(['L','R'].map(side=>[side,r.visitor.rig!.bones[side+'_hand'].localToWorld(furniturePalm(side))])));};
 const idle=sample(0),ready=sample(.9),hold=sample(3.85),lift=sample(4.09),land=sample(4.31);
 expect(ready[0].R.y-idle[0].R.y).toBeGreaterThan(.06);
 expect(lift[0].R.distanceTo(hold[0].R)).toBeGreaterThan(.04);
 expect(lift[0].L.distanceTo(hold[0].L)).toBeLessThan(.025);
 expect(land[0].R.distanceTo(hold[0].R)).toBeLessThan(.025);
 const replay=sample(4.09);expect(replay[0].R.distanceTo(lift[0].R)).toBeLessThan(1e-8);
 for(const boundary of [1.15,2.75,3.85,4.09,4.31,6.05,7.5,8.7,9.75]){
  const before=sample(boundary-.001),after=sample(boundary+.001);
  for(let i=0;i<2;i++)for(const side of ['L','R'])expect(before[i][side].distanceTo(after[i][side])).toBeLessThan(.02);
 }
 const end=sample(10);for(let i=0;i<2;i++)for(const side of ['L','R'])expect(end[i][side].distanceTo(idle[i][side])).toBeLessThan(.001);
});
it('cancel and completion clear the carried pose for either initiator without moving navigation roots into the air',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>JSON.parse(readFileSync('public/'+url.replace(/^\//,''),'utf8'))})));
 try{
  const both=[actor(1,-.45,0),actor(1.15,.45,Math.PI)];
  const runtime=createSocialScene(both.map((r,i)=>({id:String(i),visitor:r.visitor})));
  for(const action of ['home-princess-carry','home-princess-carried'])for(const ids of [['0','1'],['1','0']]){
   await runtime.start(action,...ids as [string,string]);runtime.seek(5);
   expect(both[Number(ids[action==='home-princess-carried'?0:1])].body.position.length()).toBeGreaterThan(.1);
   expect(both.map(r=>r.visitor.root.position.y)).toEqual([0,0]);
   runtime.cancel();expect(runtime.inspect().session).toBeNull();both.forEach(r=>expect(r.body.position.length()).toBe(0));
   await runtime.start(action,...ids as [string,string]);runtime.advance(100);
   expect(runtime.inspect().session).toBeNull();both.forEach(r=>expect(r.body.position.length()).toBe(0));
  }
 }finally{vi.unstubAllGlobals();}
});
it('rests curved fingers across the back, opens only the patting hand, and restores the idle fingers',()=>{
 const both=[actor(1,-.33,0),actor(1.15,.33,Math.PI)];
 const sample=(time:number)=>{both.forEach(r=>r.reset());poseIntimacy('home-hug',both,time);return both.map(r=>Object.fromEntries(Object.entries(r.visitor.rig!.bones).map(([n,b])=>[n,b.quaternion.clone()])));};
 const idle=sample(0),hold=sample(3.85);
 for(const [i,r] of both.entries())for(const side of ['L','R'] as const){
  const rig=r.visitor.rig!,sign=side==='L'?1:-1,handQ=rig.bones[side+'_hand'].getWorldQuaternion(new T.Quaternion());
  const backQ=both[1-i].visitor.rig!.bones.chest.getWorldQuaternion(new T.Quaternion());
  const palmIn=new T.Vector3(0,-1,0).applyQuaternion(handQ),backIn=new T.Vector3(0,0,1).applyQuaternion(backQ);
  expect(palmIn.dot(backIn)).toBeGreaterThan(.97);
  const fingers=new T.Vector3(sign,0,0).applyQuaternion(handQ).applyQuaternion(backQ.clone().invert());
  expect(Math.abs(fingers.x)).toBeGreaterThan(.9);expect(Math.abs(fingers.y)).toBeLessThan(.35);
  expect(hold[i][side+'_pinky_tip'].angleTo(new T.Quaternion())).toBeGreaterThan(hold[i][side+'_index_tip'].angleTo(new T.Quaternion())+.1);
  const tips=BLANK_FINGERS.filter(f=>f.name!=='thumb').map(f=>{const offset=new T.Vector3(sign*(f.tip[0]-f.start[0]),f.tip[1]-f.start[1],f.tip[2]-f.start[2]).multiplyScalar(.45*BLANK_SCALE);return rig.bones[`${side}_${f.name}_tip`].localToWorld(offset);});
  for(let j=1;j<tips.length;j++)expect(tips[j].distanceTo(tips[j-1])).toBeGreaterThan(.02);
 }
 const pat=sample(4.09);expect(pat[0].R_middle_tip.angleTo(new T.Quaternion())).toBeLessThan(hold[0].R_middle_tip.angleTo(new T.Quaternion())-.05);
 expect(pat[0].L_middle_tip.angleTo(hold[0].L_middle_tip)).toBeLessThan(.001);
 const end=sample(10);for(let i=0;i<2;i++)for(const side of ['L','R'])for(const finger of BLANK_FINGERS)for(const suffix of ['', '_tip']){
  const name=`${side}_${finger.name}${suffix}`;expect(end[i][name].angleTo(idle[i][name])).toBeLessThan(1e-6);
 }
});

it('kneels in front of the seated hug partner, preserves their seat, strokes the head and releases',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>JSON.parse(readFileSync('public/'+url.replace(/^\//,''),'utf8'))})));
 try{for(const heights of [[1,1],[.8,1.25],[1.25,.8]])for(const seatedFirst of [false,true]){
  const a=actor(heights[0],1,Math.PI),b=actor(heights[1],0,0);b.visitor.root.position.y=.95;
  const pose={kind:'seat',hands:[],seatHeight:.95/b.visitor.root.scale.y};
  const reset=()=>{a.reset();b.visitor.animate(0,'idle','seated',pose);b.visitor.root.updateWorldMatrix(true,true);};
  reset();const hip=b.visitor.rig!.bones.hips.getWorldPosition(new T.Vector3()),thigh=b.visitor.rig!.bones.L_thigh.quaternion.clone(),floor=Math.min(...['L_foot','R_foot','L_toe','R_toe'].map(n=>a.visitor.rig!.bones[n].getWorldPosition(new T.Vector3()).y));
  const both=seatedFirst?[b,a]:[a,b],sample=(time:number)=>{reset();poseIntimacy('home-hug',both,time,seatedFirst?0:1);};
  for(const time of [0,.5,1,2,3,4.5,6,8,9,10]){
   sample(time);expect(b.visitor.rig!.bones.hips.getWorldPosition(new T.Vector3()).distanceTo(hip)).toBeLessThan(.0001);expect(b.visitor.rig!.bones.L_thigh.quaternion.angleTo(thigh)).toBeLessThan(.0001);
   for(const n of ['L_shin','R_shin','L_foot','R_foot','L_toe','R_toe'])expect(a.visitor.rig!.bones[n].getWorldPosition(new T.Vector3()).y).toBeGreaterThanOrEqual(floor-.001);
   if(time>=3&&time<=6){const hands=both.flatMap(r=>['L','R'].map(side=>r.visitor.rig!.bones[side+'_hand'].localToWorld(furniturePalm(side))));for(let i=0;i<hands.length;i++)for(let j=i+1;j<hands.length;j++)expect(hands[i].distanceTo(hands[j]),`seated hug palms ${i}/${j}, heights ${heights}, time ${time}`).toBeGreaterThan(.25);}
   if(time===4.5){expect(a.visitor.rig!.bones.L_shin.getWorldPosition(new T.Vector3()).y-floor).toBeLessThan(.11);expect(a.visitor.rig!.bones.head.rotation.y).toBeGreaterThan(.5);}
  }
  sample(4.5);const hand=b.visitor.rig!.bones.L_hand.localToWorld(furniturePalm('L'));sample(5.1);expect(b.visitor.rig!.bones.L_hand.localToWorld(furniturePalm('L')).distanceTo(hand)).toBeGreaterThan(.008);
  const runtime=createSocialScene([{id:'a',visitor:a.visitor},{id:'b',visitor:b.visitor}],{pinned:{id:'b',pose}});
  await runtime.start('home-hug',seatedFirst?'b':'a',seatedFirst?'a':'b');runtime.seek(5);runtime.cancel();expect(b.visitor.root.position.y).toBe(.95);expect(b.visitor.rig!.bones.L_thigh.quaternion.angleTo(thigh)).toBeLessThan(.0001);expect(a.body.position.length()).toBe(0);
  both.forEach(r=>r.visitor.rig!.mesh.geometry.dispose());
 }}finally{vi.unstubAllGlobals();}
});
