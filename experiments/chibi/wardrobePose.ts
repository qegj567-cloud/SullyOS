import * as T from 'three';
import type {bindBlankBody} from '../../apps/room3d/chibi/blankRig';
import approvedStandingPose from '../../apps/room3d/chibi/approvedStandingPose.json';
import motions from './wardrobeMotions.json';
import vrmaMotions from './wardrobeVrmaMotions.json';
import mmdMotions from './wardrobeMmdMotions.json';
import overteMotions from './wardrobeOverteMotions.json';
import {constrainForearmTwist} from './forearmTwist';
import catalog from '../../apps/room3d/chibi/wardrobeMotionCatalog.json';
import approvedMotions from '../../apps/room3d/chibi/approvedWardrobeMotions.json';

export type WardrobeStyle='normal'|keyof typeof catalog;
export const wardrobeMotionChoices=[{id:'normal',label:'普通站姿',group:'普通站姿'},...Object.entries(approvedMotions).map(([id,m])=>({id,label:`${m.number} · ${catalog[id as keyof typeof catalog].label}`,group:'已选动作'}))] as {id:WardrobeStyle;label:string;group:string}[];
const allMotions={...motions,...vrmaMotions,...mmdMotions,...overteMotions};
export function cleanWardrobeStyle(value:unknown):WardrobeStyle{return typeof value==='string'&&Object.hasOwn(approvedMotions,value)?value as WardrobeStyle:'normal';}

/** Old saved boy/cute values fall back to the approved stance.
 * Retired motions live only in test/fixtures for clothing stress regressions. */
export function createWardrobePose(rig:ReturnType<typeof bindBlankBody>,style?:string){
 const pose=Object.fromEntries(Object.keys(rig.bones).map(name=>[name,new T.Quaternion()]));
 const standing=Object.fromEntries(Object.keys(pose).map(name=>[name,new T.Quaternion()]));
 for(const [name,v] of Object.entries(approvedStandingPose.state)){
  const sign=name.startsWith('L')?1:-1;
  standing[name].setFromEuler(new T.Euler(T.MathUtils.degToRad(v[2]),-sign*T.MathUtils.degToRad(v[1]),-sign*T.MathUtils.degToRad(v[0]),'XYZ'));
 }
 // Keep archived candidates callable for asset/pose regression tests, while
 // saved UI choices are restricted by cleanWardrobeStyle to the approved set.
 const selected=typeof style==='string'&&Object.hasOwn(catalog,style)?style as keyof typeof catalog:'normal';
 if(selected!=='normal'){
  const entry=catalog[selected],motionId='motionId' in entry?entry.motionId:selected;
  const data=allMotions[motionId as keyof typeof allMotions],values=Object.fromEntries(Object.keys(pose).map(n=>[n,[] as number[]]));
  const additive='additive' in entry&&entry.additive,narrow='stance' in entry&&entry.stance==='narrow',sample=new T.Quaternion();
  for(let frame=0;frame<data.times.length;frame++){
   for(const [name,q] of Object.entries(pose))additive?q.copy(standing[name]):q.identity();
   for(const [name,track] of Object.entries(data.tracks)){
    sample.fromArray(track,frame*4).normalize();
    if(additive)pose[name]?.multiply(sample).normalize();else pose[name]?.copy(sample);
   }
   // Standing-only audition variants keep the approved pelvis and legs. Never
   // apply this to locomotion/dance: those require foot contacts and root motion.
   if(narrow)for(const [name,q] of Object.entries(pose))if(name==='hips'||/_(thigh|shin|foot|toe)$/.test(name))q.copy(standing[name]);
   for(const side of ['L','R'] as const){rig.setHandCurl(side,approvedStandingPose.handCurl,pose);if(!additive)constrainForearmTwist(rig,pose,side);}
   for(const [name,q] of Object.entries(pose))q.toArray(values[name],values[name].length);
  }
  // One-shot gestures need a short return to their first frame for repeated
  // auditioning. Keep the source segment intact and append only the return.
  const needsReturn=Object.values(values).some(v=>new T.Quaternion().fromArray(v).angleTo(new T.Quaternion().fromArray(v,v.length-4))>.03);
  const times=[...data.times];let duration=data.duration;
  if(needsReturn){duration+=.45;times.push(duration);for(const v of Object.values(values))v.push(...v.slice(0,4));}
  const provider='provider' in entry?entry.provider:'Mesh2Motion';
  return new T.AnimationClip(`${provider}_${data.sourceName}`,duration,Object.entries(values).map(([name,v])=>new T.QuaternionKeyframeTrack(`${name}.quaternion`,times,v)));
 }
 for(const [name,q] of Object.entries(pose))q.copy(standing[name]);
 for(const side of ['L','R'] as const)rig.setHandCurl(side,approvedStandingPose.handCurl,pose);
 return new T.AnimationClip('WardrobeStandNeutral',4,Object.entries(pose).map(([name,q])=>
  new T.QuaternionKeyframeTrack(`${name}.quaternion`,[0,4],[...q.toArray(),...q.toArray()])));
}
