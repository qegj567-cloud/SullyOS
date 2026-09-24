// DiSK's CC0 Breath_1800F.vmd only. This is not a general MMD retargeter.
// Format parsing / handedness: mmd-parser (MIT). Rotation curve layout follows
// three.js r169 MMDLoader AnimationBuilder: destination key bytes 3,7,11,15.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import MMDParser from 'mmd-parser';
import {Quaternion} from 'three';

export function rotationEase(curve,progress){
 if(progress<=0)return 0;if(progress>=1)return 1;
 const cubic=(t,a,b)=>3*(1-t)*(1-t)*t*a+3*(1-t)*t*t*b+t*t*t;
 let lo=0,hi=1;
 for(let i=0;i<24;i++){const t=(lo+hi)/2;if(cubic(t,curve[3]/127,curve[11]/127)<progress)lo=t;else hi=t;}
 return cubic((lo+hi)/2,curve[7]/127,curve[15]/127);
}
export function sampleRotation(keys,frame){
 const next=keys.findIndex(k=>k.frameNum>=frame);
 if(next<=0)return new Quaternion().fromArray(keys[next===0?0:keys.length-1].rotation).normalize();
 const a=keys[next-1],b=keys[next];
 // MMD one-frame keys are discrete; exact destination keys still land on b.
 const alpha=frame===b.frameNum?1:b.frameNum-a.frameNum<=1?0:rotationEase(b.interpolation,(frame-a.frameNum)/(b.frameNum-a.frameNum));
 return new Quaternion().fromArray(a.rotation).slerp(new Quaternion().fromArray(b.rotation),alpha).normalize();
}
export function convertBreath(bytes){
 const vmd=new MMDParser.Parser().parseVmd(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),true);
 const mapping={'上半身':'spine','上半身2':'chest','首':'neck','左肩P':'L_clavicle','右肩P':'R_clavicle','左腕':'L_upperArm','右腕':'R_upperArm'};
 const duration=Math.max(...vmd.motions.map(m=>m.frameNum))/30,times=Array.from({length:Math.round(duration*30)+1},(_,i)=>+(i/30).toFixed(6)),tracks={};
 for(const [source,target] of Object.entries(mapping)){
  const keys=vmd.motions.filter(m=>m.boneName===source).sort((a,b)=>a.frameNum-b.frameNum);
  if(!keys.length)throw Error(`Missing breath bone: ${source}`);
  tracks[target]=times.flatMap((_,i)=>sampleRotation(keys,i).toArray().map(n=>+n.toFixed(6)));
 }
 // Additive rotations are composed with approved standing pose at playback.
 // No source bone translations, eye motion, model mesh or skin weights.
 return {'mmd-breath':{sourceName:'Breath_1800F',duration,times,tracks}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const bytes=fs.readFileSync(new URL('./motion-sources/DiSK-Breath_1800F.vmd',import.meta.url));
 if(createHash('sha256').update(bytes).digest('hex')!=='d1a1cbb09865c3a408cd2a2fad58ad480da0153b0bec47bf57f38000fb3eedc6')throw Error('Unreviewed DiSK source');
 fs.writeFileSync(new URL('../../experiments/chibi/wardrobeMmdMotions.json',import.meta.url),JSON.stringify(convertBreath(bytes))+'\n');
}
