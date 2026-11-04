import fs from 'node:fs';
import {createHash} from 'node:crypto';
import * as T from 'three';
import {FBXLoader} from 'three/examples/jsm/loaders/FBXLoader.js';
// Text-to-Motion FBX includes a preview mannequin. Import only its animation.
globalThis.window={URL};T.TextureLoader.prototype.load=()=>new T.Texture();
const dir='art/chibi/princess-carry-2026/motions';
const ledger=JSON.parse(fs.readFileSync(dir+'/ledger.json','utf8'));
const mapping={hips:'Pelvis',spine:'Spine1',chest:'Spine3',neck:'Neck',head:'Head'},parents={hips:null,spine:'hips',chest:'spine',neck:'chest',head:'neck'};
for(const side of ['L','R'])for(const [target,source,parent] of [['clavicle','Collar','chest'],['upperArm','Shoulder','clavicle'],['forearm','Elbow','upperArm'],['hand','Wrist','forearm'],['thigh','Hip','hips'],['shin','Knee','thigh'],['foot','Ankle','shin'],['toe','Foot','foot']]){
 mapping[`${side}_${target}`]=`${side}_${source}`;parents[`${side}_${target}`]=['chest','hips'].includes(parent)?parent:`${side}_${parent}`;
}
const round=n=>+n.toFixed(6),duration=10;
function convert(id,role,gap){
 const entry=ledger.jobs.find(j=>j.id===id);if(!entry?.file)throw Error('Missing successful motion '+id);
 const bytes=fs.readFileSync(dir+'/'+entry.file);if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('Source changed '+id);
 const source=new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');source.updateMatrixWorld(true);
 // FBX has duplicate skin helper nodes with the same name; the first node is
 // the animated joint. Sampling that node avoids multiplying the pose twice.
 const nodes=Object.fromEntries(Object.entries(mapping).map(([n,s])=>[n,source.getObjectByName(s)]));
 if(Object.values(nodes).some(n=>!n))throw Error('Unexpected skeleton');
 const rest=Object.fromEntries(Object.entries(nodes).map(([n,b])=>[n,b.getWorldQuaternion(new T.Quaternion()).invert()]));
 const leg=nodes.L_shin.position.length()+nodes.L_foot.position.length();
 const clip=source.animations[0],mixer=new T.AnimationMixer(source),action=mixer.clipAction(clip);action.setLoop(T.LoopOnce,1);action.clampWhenFinished=true;action.play();
 const pose=t=>{action.reset().play();mixer.setTime(t);source.updateMatrixWorld(true);return nodes.hips.getWorldPosition(new T.Vector3());};
 const start=pose(0),end=pose(clip.duration),times=[],positions=[],tracks=Object.fromEntries(Object.keys(nodes).map(n=>[n,[]])),points=Object.fromEntries(Object.keys(nodes).map(n=>[n,[]]));
 for(let i=0;i<=300;i++){
  const t=i/30,u=t/duration,pelvis=pose(t/duration*clip.duration);
  const hip=nodes.hips.getWorldQuaternion(new T.Quaternion()).multiply(rest.hips);
  const forward=new T.Vector3(0,0,1).applyQuaternion(hip);const unheading=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),-Math.atan2(forward.x,forward.z));
  const world=Object.fromEntries(Object.entries(nodes).map(([n,b])=>[n,unheading.clone().multiply(b.getWorldQuaternion(new T.Quaternion())).multiply(rest[n]).normalize()]));
  // Remove locomotion drift, retain the captured local weight transfer. Both
  // actors face their partner at runtime, so accidental turns are removed.
  const delta=pelvis.clone().sub(start.clone().lerp(end,u)).divideScalar(leg);
  const pos=new T.Vector3(T.MathUtils.clamp(delta.x,-.16,.16)*(role===0?1:-1),1.18+(pelvis.y-start.y)/leg,(role===0?-1:1)*gap/2+T.MathUtils.clamp(delta.z,-.16,.16)*(role===0?1:-1));
  times.push(round(t));positions.push(0,round(pos.y),(role===0?-1:1)*gap/2);
  for(const n of Object.keys(nodes)){
   const q=(world[parents[n]]?.clone()??new T.Quaternion()).invert().multiply(world[n]).normalize(),values=tracks[n];
   if(values.length&&q.dot(new T.Quaternion().fromArray(values,values.length-4))<0)q.set(-q.x,-q.y,-q.z,-q.w);
   values.push(...q.toArray().map(round));
   const point=nodes[n].getWorldPosition(new T.Vector3()).sub(pelvis).applyQuaternion(unheading).divideScalar(leg).add(pos);
   points[n].push(...point.toArray().map(round));
  }
 }
 // Symmetric filtering removes one-frame wrist jitter without a phase delay.
 for(let pass=0;pass<3;pass++)for(const values of Object.values(tracks)){
  const copy=[...values];for(let i=1;i<times.length-1;i++){
   const mid=new T.Quaternion().fromArray(copy,i*4).normalize();
   const neighbors=new T.Quaternion().fromArray(copy,(i-1)*4).normalize().slerp(new T.Quaternion().fromArray(copy,(i+1)*4).normalize(),.5);
   mid.slerp(neighbors,.5);values.splice(i*4,4,...mid.toArray().map(round));
  }
 }
 return {duration,times,tracks,positions,points,hipHeight:1.18};
}
const definitions=[['home-princess-carry','carry',.90],['home-princess-carried','carry',.90]];
const catalogFile='apps/room3d/chibi/selectedMotionCatalog.json',catalog=JSON.parse(fs.readFileSync(catalogFile,'utf8'));
for(const [id,prefix,gap] of definitions){
 if(!['a','b'].every(s=>ledger.jobs.some(j=>j.id===prefix+'-'+s&&j.file))){console.log(id,'waiting for source pair');continue;}
 const actors=['a','b'].map((suffix,i)=>convert(prefix+'-'+suffix,i,gap));
 fs.writeFileSync(`public/room3d/motions/selected/${id}.json`,JSON.stringify({version:1,id,source:'meshy-text-to-motion',duration,actors})+'\n');
 const entry=catalog.find(e=>e.id===id);entry.source='Meshy Text-to-Motion Prime; retargeted and contact-corrected';entry.sourceUrl='https://docs.meshy.ai/en/api/text-to-motion';entry.hashes=['a','b'].map(s=>ledger.jobs.find(j=>j.id===prefix+'-'+s).sha256);
 console.log(id,actors[0].times.length,'frames per role');
}
fs.writeFileSync(catalogFile,JSON.stringify(catalog,null,2)+'\n');
