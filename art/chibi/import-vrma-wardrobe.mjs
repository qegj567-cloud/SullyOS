// CC0 VRMA sources and immutable mirror hashes: docs/chibi-motion-sources.md.
// Read animation data only; never import a source avatar or change our rig.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';

const sources=process.argv[4]?JSON.parse(fs.readFileSync(process.argv[4],'utf8')):{
 'sachi-idle':{file:'idle-01',hash:'5ed6c016df035b21daaefe64751e1356387c6a33693d31366b0912ac7566ea92'},
 'sachi-speaking':{file:'speaking-01',hash:'ba0339d2d9755fc2e0dab06e96a0d91303d0a508c9f89f07dc17a07dc0e2535c'},
 'fumi-pose':{file:'pose-motion',hash:'e3b06f78b21df2fe1f26d80dd1826fd47941a891d44b46a6197f8a87de05ff2c'},
};
const mapping={hips:'hips',spine:'spine',chest:'chest',neck:'neck',head:'head'};
const parents={hips:'root',spine:'hips',chest:'spine',neck:'chest',head:'neck'};
for(const [side,prefix] of [['left','L'],['right','R']])for(const [target,source,parent] of [['clavicle','Shoulder','chest'],['upperArm','UpperArm','clavicle'],['forearm','LowerArm','upperArm'],['hand','Hand','forearm'],['thigh','UpperLeg','hips'],['shin','LowerLeg','thigh'],['foot','Foot','shin'],['toe','Toes','foot']]){
 mapping[`${prefix}_${target}`]=`${side}${source}`;
 parents[`${prefix}_${target}`]=['chest','hips'].includes(parent)?parent:`${prefix}_${parent}`;
}
const output={};
for(const [id,{file,hash}] of Object.entries(sources)){
 const bytes=fs.readFileSync(path.join(process.argv[2]??'.tmp/motion-research',`${file}.vrma`));
 if(createHash('sha256').update(bytes).digest('hex')!==hash)throw Error(`Unreviewed VRMA: ${file}`);
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const human=gltf.parser.json.extensions.VRMC_vrm_animation.humanoid.humanBones;
 const nodes={};for(const [name,semantic] of Object.entries(mapping)){
  const bone=human[name==='chest'&&human.upperChest?'upperChest':semantic];
  if(!bone)throw Error(`Missing ${semantic} in ${file}`);
  nodes[name]=await gltf.parser.getDependency('node',bone.node);
 }
 gltf.scene.updateMatrixWorld(true);
 const rest=Object.fromEntries(Object.entries(nodes).map(([name,b])=>[name,b.getWorldQuaternion(new T.Quaternion()).invert()]));
 const source=gltf.animations[0],mixer=new T.AnimationMixer(gltf.scene);
 const action=mixer.clipAction(source);action.setLoop(T.LoopOnce,1);action.clampWhenFinished=true;action.play();
 const frames=Math.ceil(source.duration*30),times=[],tracks=Object.fromEntries(Object.keys(nodes).map(n=>[n,[]]));
 for(let i=0;i<=frames;i++){
  const time=i/frames*source.duration;times.push(+time.toFixed(6));mixer.setTime(time);gltf.scene.updateMatrixWorld(true);
  const world=Object.fromEntries(Object.entries(nodes).map(([name,b])=>[name,b.getWorldQuaternion(new T.Quaternion()).multiply(rest[name]).normalize()]));
  for(const name of Object.keys(nodes)){
   const q=(world[parents[name]]?.clone()??new T.Quaternion()).invert().multiply(world[name]).normalize();
   const v=tracks[name];if(v.length&&q.dot(new T.Quaternion().fromArray(v,v.length-4))<0)q.set(-q.x,-q.y,-q.z,-q.w);
   v.push(...q.toArray().map(n=>+n.toFixed(6)));
  }
 }
 output[id]={sourceName:file,duration:source.duration,times,tracks};
 console.log(id,{duration:source.duration,frames:times.length});
}
fs.writeFileSync(process.argv[3]??'experiments/chibi/wardrobeVrmaMotions.json',JSON.stringify(output)+'\n');

