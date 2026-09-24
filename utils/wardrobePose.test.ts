import {afterAll,describe,expect,it} from 'vitest';
import * as T from 'three';
import {createBlankBody} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {cleanWardrobeStyle,createWardrobePose,wardrobeMotionChoices} from '../experiments/chibi/wardrobePose';
import catalog from '../apps/room3d/chibi/wardrobeMotionCatalog.json';

const body=new T.Mesh(createBlankBody('skin'),new T.MeshBasicMaterial());
const root=new T.Group(),hair=new T.Group();root.add(body,hair);
const rig=bindBlankBody(body,hair);
afterAll(()=>{body.geometry.dispose();body.material.dispose();rig.skeleton.dispose();});

function rotationAt(clip:T.AnimationClip,bone:string,time:number){
 const track=clip.tracks.find(t=>t.name===`${bone}.quaternion`)!;
 return new T.Quaternion().fromArray(new T.QuaternionLinearInterpolant(track.times,track.values,4).evaluate(time));
}
function expectRotation(actual:T.Quaternion,expected:T.Quaternion){
 expect(Math.abs(actual.dot(expected))).toBeCloseTo(1,6);
}

describe('approved wardrobe standing pose',()=>{
 it.each(Object.entries(catalog).filter(([,m])=>'group' in m&&m.group==='新候选 · 窄站姿').map(([id,m])=>({id,label:m.label})))('keeps both feet planted at the approved spacing throughout $label',({id})=>{
  const clip=createWardrobePose(rig,id),neutral=createWardrobePose(rig,'normal');
  const mixer=new T.AnimationMixer(root),action=mixer.clipAction(clip);action.setLoop(T.LoopOnce,1);action.clampWhenFinished=true;action.play();
  const positions=rig.skeleton.bones.map(b=>b.position.toArray());
  let feet:T.Vector3[]|undefined;
  for(let i=0;i<=120;i++){
   const time=clip.duration*i/120;mixer.setTime(time);root.updateMatrixWorld(true);
   const current=['L_foot','R_foot'].map(name=>rig.bones[name].getWorldPosition(new T.Vector3()));
   feet??=current.map(p=>p.clone());current.forEach((p,j)=>expect(p.distanceTo(feet![j])).toBeLessThan(1e-6));
   for(const name of Object.keys(rig.bones).filter(n=>n==='hips'||/_(thigh|shin|foot|toe)$/.test(n)))expectRotation(rotationAt(clip,name,time),rotationAt(neutral,name,0));
  }
  expect(rig.skeleton.bones.map(b=>b.position.toArray())).toEqual(positions);
  mixer.stopAllAction();mixer.uncacheRoot(root);
 });
 it('preserves the original upper-body gestures in the two narrow variants',()=>{
  for(const id of ['narrow-idle','narrow-talk'] as const){
   const adapted=createWardrobePose(rig,id),source=createWardrobePose(rig,catalog[id].motionId);
   for(const bone of ['chest','spine','head','L_upperArm','R_upperArm','L_hand','R_hand'])for(const time of [0,.3,.8,1.2])expectRotation(rotationAt(adapted,bone,time),rotationAt(source,bone,time));
  }
 });
 it('adds MMD breathing onto approved arms and compensates chest tilt at the neck',()=>{
  const breath=createWardrobePose(rig,'mmd-breath'),neutral=createWardrobePose(rig,'normal');
  for(const name of Object.keys(rig.bones))expectRotation(rotationAt(breath,name,0),rotationAt(neutral,name,0));
  expect(T.MathUtils.radToDeg(rotationAt(breath,'chest',1).angleTo(new T.Quaternion()))).toBeCloseTo(5,1);
  expectRotation(rotationAt(breath,'chest',1).multiply(rotationAt(breath,'neck',1)),new T.Quaternion());
 });
 it.each(wardrobeMotionChoices.filter(m=>m.id!=='normal'))('plays audition candidate $label with finite rotations and a continuous replay boundary',({id})=>{
  expect(cleanWardrobeStyle(id)).toBe(id);
  const clip=createWardrobePose(rig,id);
  expect(clip.duration).toBeGreaterThan(1);
  expect(clip.tracks.length).toBe(rig.skeleton.bones.length);
  let movement=0;
  for(const track of clip.tracks){
   expect(Array.from(track.values).every(Number.isFinite)).toBe(true);
   const bone=track.name.replace('.quaternion','');
   for(const time of [0,clip.duration*.25,clip.duration*.5,clip.duration*.75,clip.duration]){
    const q=rotationAt(clip,bone,time);expect(q.length()).toBeCloseTo(1,5);
    movement=Math.max(movement,q.angleTo(rotationAt(clip,bone,0)));
   }
   expect(rotationAt(clip,bone,0).angleTo(rotationAt(clip,bone,clip.duration))).toBeLessThan(.031);
  }
  expect(movement).toBeGreaterThan(.01);
 });
 it('plays the imported idle as a continuous rotation-only clip without mutating the rig',()=>{
  const before=rig.skeleton.bones.map(b=>({p:b.position.toArray(),q:b.quaternion.toArray(),s:b.scale.toArray()}));
  const clip=createWardrobePose(rig,'library-idle');
  expect(clip.name).toBe('Mesh2Motion_Idle_A');expect(clip.duration).toBeCloseTo(3.125);
  expect(rotationAt(clip,'chest',0).angleTo(rotationAt(clip,'chest',1))).toBeGreaterThan(.01);
  for(const track of clip.tracks){
   expect(track.name.endsWith('.quaternion')).toBe(true);
   const name=track.name.replace('.quaternion','');
   expect(rotationAt(clip,name,0).angleTo(rotationAt(clip,name,clip.duration))).toBeLessThan(.005);
   for(const time of [0,.4,1,2,3.1])expect(rotationAt(clip,name,time).length()).toBeCloseTo(1,5);
  }
  expect(rig.skeleton.bones.map(b=>({p:b.position.toArray(),q:b.quaternion.toArray(),s:b.scale.toArray()}))).toEqual(before);
  expect(cleanWardrobeStyle('boy')).toBe('normal');expect(cleanWardrobeStyle('cute')).toBe('normal');
  expect(cleanWardrobeStyle('library-idle')).toBe('normal');
 });
 it('keeps the user-approved mirrored arm and wrist angles with 37% curled fingers',()=>{
  const normal=createWardrobePose(rig,'normal');
  const fingers:Record<string,T.Quaternion>={};
  for(const name of Object.keys(rig.bones))fingers[name]=new T.Quaternion();
  rig.setHandCurl('L',.37,fingers);rig.setHandCurl('R',.37,fingers);
  for(const time of [0,.65,2,3.75,4])for(const [side,sign] of [['L',1],['R',-1]] as const){
   expectRotation(rotationAt(normal,`${side}_upperArm`,time),new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),-sign*T.MathUtils.degToRad(56.56204993541357)));
   expectRotation(rotationAt(normal,`${side}_forearm`,time),new T.Quaternion().setFromEuler(new T.Euler(T.MathUtils.degToRad(.22869034709255356),-sign*T.MathUtils.degToRad(4.355252461993468),-sign*T.MathUtils.degToRad(.4959975074129086))));
   expectRotation(rotationAt(normal,`${side}_hand`,time),new T.Quaternion().setFromEuler(new T.Euler(T.MathUtils.degToRad(-.5192085023702001),-sign*T.MathUtils.degToRad(.45153134734424705),sign*T.MathUtils.degToRad(39.05468920902148))));
   for(const name of Object.keys(fingers).filter(n=>n.startsWith(`${side}_`)&&/(thumb|index|middle|ring|pinky)/.test(n)))expectRotation(rotationAt(normal,name,time),fingers[name]);
   expectRotation(rotationAt(normal,'chest',time),new T.Quaternion());
  }
 });
 it('restores the approved stance for retired saved styles, including the old default',()=>{
  const normal=createWardrobePose(rig,'normal');
  for(const style of ['boy','cute',undefined] as const){
   const clip=createWardrobePose(rig,style);
   for(const track of normal.tracks)for(const time of [0,.7,3.9]){
    const name=track.name.replace('.quaternion','');
    expectRotation(rotationAt(clip,name,time),rotationAt(normal,name,0));
   }
  }
 });
});
