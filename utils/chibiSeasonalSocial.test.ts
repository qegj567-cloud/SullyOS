import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {createBlankBody,BLANK_SCALE} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {createBlankMotion} from '../apps/room3d/chibi/blankMotion';
import {contactSolver} from '../apps/room3d/chibi/socialContact';
import {poseSeasonalSocial,seasonalActions,seasonalExpression} from '../apps/room3d/chibi/seasonalSocial';
import {faceSocialPoint} from '../apps/room3d/chibi/faceSocialContact';
import {createSocialScene} from '../apps/room3d/chibi/selectedSocial';
import {createHalloweenProp} from '../apps/room3d/chibi/halloweenProps';
import {homeSocialActionAllowed} from '../apps/room3d/homeRomance';
import {socialPostureAllowed} from '../apps/room3d/socialPosture';
import {selectedMotions,sampleSelected,type MotionFrame} from '../apps/room3d/chibi/selectedMotions';
import type {ChibiVisitor} from '../apps/room3d/chibi/visitor';

function actor(height:number,z:number,angle:number){
 const root=new T.Group(),body=new T.Group(),hair=new T.Group();root.scale.setScalar(2.8/BLANK_SCALE);root.position.z=z;root.rotation.y=angle;root.add(body);
 const mesh=new T.Mesh(createBlankBody('skin',{bodyHeight:height}),new T.MeshBasicMaterial());body.add(mesh,hair);
 const rig=bindBlankBody(mesh,hair,true),animate=createBlankMotion(rig,body);
 const visitor={root,rig,motionScale:1,animate:(time:number)=>animate(time,'idle','standing'),applySelectedFrame:vi.fn((frame:MotionFrame,weight=1)=>{animate(0,'idle','standing');for(const [n,q] of Object.entries(frame.rotations))rig.bones[n]?.quaternion.slerp(q,weight);root.updateWorldMatrix(true,true);}),setActionExpression:vi.fn(),finishPose:()=>root.updateWorldMatrix(true,true),translatePose(delta:T.Vector3){const start=root.worldToLocal(new T.Vector3()),end=root.worldToLocal(delta.clone());body.position.add(end.sub(start));root.updateWorldMatrix(true,true);}} as unknown as ChibiVisitor;
 const reset=()=>{animate(0,'idle','standing');root.updateWorldMatrix(true,true);};reset();
 return {visitor,solver:contactSolver(visitor),body,reset};
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('ships genuine changing Meshy motion for both roles, with traceable successful source tasks',()=>{
 const ledger=JSON.parse(readFileSync('art/halloween-2026/interactions/motions/ledger.json','utf8'));
 for(const id of seasonalActions){
  const clip=JSON.parse(readFileSync(`public/room3d/motions/selected/${id}.json`,'utf8')),entry=selectedMotions.find(e=>e.id===id)!;
  expect(clip.source).toBe('meshy-text-to-motion');expect(entry.hashes).toHaveLength(2);
  for(const hash of entry.hashes)expect(ledger.jobs.some((j:any)=>j.sha256===hash&&j.status==='SUCCEEDED'&&j.params.mode==='prime')).toBe(true);
  for(const actor of clip.actors){
   expect(actor.times.length).toBeGreaterThan(100);expect(Object.keys(actor.tracks).length).toBeGreaterThan(20);
   for(const name of ['hips','chest','L_upperArm','R_upperArm']){
    const first=sampleSelected(actor,0).rotations[name];
    const movement=actor.times.reduce((max:number,t:number)=>Math.max(max,first.angleTo(sampleSelected(actor,t).rotations[name])),0);
    expect(movement,`${id} ${name} must not freeze at the last FBX frame`).toBeGreaterThan(.025);
   }
  }
 }
});
it('plays Meshy full-body poses without the old scare IK overwriting them, including backward seeks',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>JSON.parse(readFileSync('public/'+url.replace(/^\//,''),'utf8'))})));
 const both=[actor(1,-1,0),actor(1,1,Math.PI)],runtime=createSocialScene(both.map((r,i)=>({id:String(i),visitor:r.visitor})));
 await runtime.start('halloween-boo','0','1');const offset=runtime.inspect().session!.duration-9.2+.6;
 const capture=JSON.parse(readFileSync('public/room3d/motions/selected/halloween-boo.json','utf8'));
 for(const time of [1,3,6,3]){
  runtime.seek(offset+time);
  both.forEach((r,i)=>{const frame=sampleSelected(capture.actors[i],time);for(const n of ['hips','chest','L_upperArm','R_upperArm'])expect(r.visitor.rig!.bones[n].quaternion.angleTo(frame.rotations[n])).toBeLessThan(1e-5);});
 }
});
it('exposes four paired mischief actions and two new romance-gated actions, all standing only',()=>{
 const added=selectedMotions.filter(x=>seasonalActions.includes(x.id as any));expect(added).toHaveLength(6);
 expect(added.filter(x=>x.category==='mischief')).toHaveLength(4);
 for(const m of added){expect(m.participants).toBe(2);expect(socialPostureAllowed(m.id,'standing','seated',2)).toBe(false);expect(homeSocialActionAllowed({},m.id,'a','b')).toBe(m.category!=='close');expect(homeSocialActionAllowed({romanticPairs:[['a','b']]},m.id,'a','b')).toBe(true);}
 expect(seasonalExpression('halloween-boo',2,0)).toBe('smiling');expect(seasonalExpression('halloween-boo',2,1)).toBe('surprised');expect(seasonalExpression('home-kiss',3,0)).toBe('tender');
});
it('keeps skeletons finite, preserves bone lengths, and restores after seeking for all six actions',()=>{
 for(const heights of [[1,1],[.8,1.25],[1.25,.8]]){
  const both=[actor(heights[0],-.42,0),actor(heights[1],.42,Math.PI)];
  const lengths=both.map(r=>r.visitor.rig!.skeleton.bones.map(b=>b.position.length()));
  for(const id of seasonalActions){
   const sample=(t:number)=>{both.forEach(r=>r.reset());poseSeasonalSocial(id,both,t);return both.map(r=>r.visitor.rig!.bones.L_hand.getWorldPosition(new T.Vector3()));};
   const start=sample(0),middle=sample(3.5);sample(6);const repeated=sample(3.5);
   repeated.forEach((p,i)=>expect(p.distanceTo(middle[i])).toBeLessThan(1e-7));
   for(const [i,r]of both.entries()){expect(r.visitor.rig!.skeleton.bones.map(b=>b.position.length())).toEqual(lengths[i]);expect(r.visitor.rig!.skeleton.bones.every(b=>b.matrixWorld.elements.every(Number.isFinite))).toBe(true);}
   sample(8).forEach((p,i)=>expect(p.distanceTo(start[i])).toBeLessThan(.001));
   both.forEach(r=>expect(r.body.position.length()).toBeLessThan(.0001));
  }
 }
});
it('aligns fitted mouth and forehead surfaces while keeping feet above the floor',()=>{
 for(const heights of [[1,1],[1,1.15],[.8,1.25],[1.25,.8]])for(const id of ['home-kiss','home-forehead-touch']){
  const both=[actor(heights[0],-.42,0),actor(heights[1],.42,Math.PI)];
  const floor=both.map(r=>Math.min(...['L_foot','R_foot','L_toe','R_toe'].map(n=>r.visitor.rig!.bones[n].getWorldPosition(new T.Vector3()).y)));
  poseSeasonalSocial(id,both,3.5);
  const points=both.map(r=>faceSocialPoint(r.visitor,id));expect(Math.abs(points[0].y-points[1].y)).toBeLessThan(.055);expect(points[0].distanceTo(points[1])).toBeLessThan(.06);
  both.forEach((r,i)=>{for(const n of ['L_foot','R_foot','L_toe','R_toe'])expect(r.visitor.rig!.bones[n].getWorldPosition(new T.Vector3()).y).toBeGreaterThanOrEqual(floor[i]-.001);});
 }
});
it('ships compact untextured GLBs with finite geometry and no external assets',()=>{
 for(const id of ['pumpkin-pail','wrapped-candy','little-ghost']){
  const b=readFileSync(`public/room3d/props/halloween/${id}.glb`),j=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());expect(b.length).toBeLessThan(100000);expect(j.images??[]).toHaveLength(0);expect(j.textures??[]).toHaveLength(0);expect(j.buffers.every((x:any)=>!x.uri)).toBe(true);
  let faces=0;for(const m of j.meshes)for(const p of m.primitives){expect(p.attributes.TEXCOORD_0).toBeUndefined();faces+=j.accessors[p.indices].count/3;expect(j.accessors[p.attributes.POSITION].min.every(Number.isFinite)).toBe(true);}expect(faces).toBeLessThan(4000);
 }
});
it('failed prop loading leaves the residents untouched, and canceled loading cannot resurrect an action',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>JSON.parse(readFileSync('public/'+url.replace(/^\//,''),'utf8'))})));
 const both=[actor(1,-.5,0),actor(1,.5,Math.PI)],stage=new T.Group();both.forEach(r=>stage.add(r.visitor.root));
 const runtime=createSocialScene(both.map((r,i)=>({id:String(i),visitor:r.visitor}))),before=both.map(r=>r.visitor.root.position.clone());
 const loader=vi.spyOn(GLTFLoader.prototype,'loadAsync').mockRejectedValueOnce(Error('offline'));
 await expect(runtime.start('halloween-ghost-tease','0','1')).rejects.toThrow('offline');expect(runtime.active).toBe(false);expect(runtime.inspect().loading).toBe(false);
 both.forEach((r,i)=>expect(r.visitor.root.position.distanceTo(before[i])).toBe(0));
 let resolve!:(x:any)=>void;loader.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const loading=runtime.start('halloween-ghost-tease','0','1');runtime.cancel();resolve({scene:new T.Group()});expect(await loading).toBe(false);expect(runtime.active).toBe(false);expect(stage.getObjectByName('halloween-social-props')).toBeUndefined();
});
it('removes every temporary prop on cancel and completion without disposing shared templates',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>JSON.parse(readFileSync('public/'+url.replace(/^\//,''),'utf8'))})));
 const template=new T.Group(),geometry=new T.BoxGeometry(.1,.1,.1),material=new T.MeshBasicMaterial();template.add(new T.Mesh(geometry,material));const dispose=vi.spyOn(geometry,'dispose');
 vi.spyOn(GLTFLoader.prototype,'loadAsync').mockResolvedValue({scene:template} as any);
 const both=[actor(1,-.5,0),actor(1,.5,Math.PI)],stage=new T.Group();both.forEach(r=>stage.add(r.visitor.root));const complete=vi.fn();
 const runtime=createSocialScene(both.map((r,i)=>({id:String(i),visitor:r.visitor})),{onComplete:complete});
 for(const action of ['halloween-trick-or-treat','halloween-candy-shower','halloween-ghost-tease']){
  await runtime.start(action,'0','1');runtime.seek(4);expect(stage.getObjectByName('halloween-social-props')).toBeTruthy();runtime.cancel();expect(stage.getObjectByName('halloween-social-props')).toBeUndefined();expect(complete).not.toHaveBeenCalled();
  await runtime.start(action,'1','0');runtime.advance(100);expect(stage.getObjectByName('halloween-social-props')).toBeUndefined();complete.mockClear();
 }
 expect(dispose).not.toHaveBeenCalled();
});
it('rewinding the candy transfer restores ownership and visibility deterministically',()=>{
 const both=[actor(1,-.5,0),actor(1,.5,Math.PI)],stage=new T.Group();both.forEach(r=>stage.add(r.visitor.root));const template=new T.Group();
 const props=createHalloweenProp('halloween-trick-or-treat',both.map(r=>r.visitor),{'pumpkin-pail':template,'wrapped-candy':template})!;
 props.update(2,8,1);const candy=stage.getObjectByName('wrapped-candy')!,initial=candy.position.clone();props.update(4,8,1);expect(candy.visible).toBe(false);props.update(2,8,1);expect(candy.visible).toBe(true);expect(candy.position.distanceTo(initial)).toBeLessThan(1e-8);props.dispose();
});
