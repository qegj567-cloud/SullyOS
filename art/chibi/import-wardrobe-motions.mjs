// Extract selected CC0 Mesh2Motion candidates into our T-pose coordinates.
// Input is pinned in docs/chibi-motion-sources.md; no mesh/skin is imported.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
globalThis.self=globalThis;globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
const bytes=fs.readFileSync(process.argv[2]??'.tmp/motion-research/human-base-animations.glb');
if(createHash('sha256').update(bytes).digest('hex')!=='406eb0a8dc4ab366e623b79b6e3005a4951392e1bda78ae39c1099d31147733c')throw Error('Source does not match the reviewed Mesh2Motion revision');
const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
gltf.scene.updateMatrixWorld(true);
const mapping={hips:'pelvis',spine:'spine_01',chest:'spine_03',neck:'neck_01',head:'head'};
const parents={hips:'root',spine:'hips',chest:'spine',neck:'chest',head:'neck'};
for(const side of ['L','R'])for(const [target,source,parent] of [['clavicle','clavicle','chest'],['upperArm','upperarm','clavicle'],['forearm','lowerarm','upperArm'],['hand','hand','forearm'],['thigh','thigh','hips'],['shin','calf','thigh'],['foot','foot','shin'],['toe','ball','foot']]){
 mapping[`${side}_${target}`]=`${source}_${side.toLowerCase()}`;
 parents[`${side}_${target}`]=['chest','hips'].includes(parent)?parent:`${side}_${parent}`;
}
const nodes=Object.fromEntries(Object.entries(mapping).map(([name,source])=>[name,gltf.scene.getObjectByName(source)]));
const rest=Object.fromEntries(Object.entries(nodes).map(([name,b])=>[name,b.getWorldQuaternion(new T.Quaternion()).invert()]));
const mixer=new T.AnimationMixer(gltf.scene),output={};
const catalog=JSON.parse(fs.readFileSync('apps/room3d/chibi/wardrobeMotionCatalog.json','utf8'));
for(const [id,{sourceName}] of Object.entries(catalog).filter(([,entry])=>!entry.provider)){
 const source=gltf.animations.find(a=>a.name===sourceName);if(!source)throw Error(sourceName);
 mixer.stopAllAction();const action=mixer.clipAction(source);action.setLoop(T.LoopOnce,1);action.clampWhenFinished=true;action.play();
 const frames=Math.ceil(source.duration*30),times=[],tracks=Object.fromEntries(Object.keys(nodes).map(n=>[n,[]]));
 for(let i=0;i<=frames;i++){
  const time=i/frames*source.duration;times.push(+time.toFixed(6));mixer.setTime(time);gltf.scene.updateMatrixWorld(true);
  const world=Object.fromEntries(Object.entries(nodes).map(([name,b])=>[name,b.getWorldQuaternion(new T.Quaternion()).multiply(rest[name]).normalize()]));
  for(const name of Object.keys(nodes)){
   const q=(world[parents[name]]?.clone()??new T.Quaternion()).invert().multiply(world[name]).normalize();
   // q/-q are identical rotations; retain shortest interpolation paths.
   const values=tracks[name];if(values.length&&q.dot(new T.Quaternion().fromArray(values,values.length-4))<0)q.set(-q.x,-q.y,-q.z,-q.w);
   values.push(...q.toArray().map(v=>+v.toFixed(6)));
  }
 }
 output[id]={sourceName,duration:source.duration,times,tracks};
}
fs.writeFileSync('experiments/chibi/wardrobeMotions.json',JSON.stringify(output)+'\n');
console.log(Object.fromEntries(Object.entries(output).map(([id,c])=>[id,{duration:c.duration,frames:c.times.length}])));
