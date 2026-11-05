import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as T from 'three';
import {FBXLoader} from 'three/examples/jsm/loaders/FBXLoader.js';
const dir=process.env.MESHY_PHOTO_DIR;
if(!dir)throw Error('Set MESHY_PHOTO_DIR to the downloaded sources');
globalThis.window={URL};T.TextureLoader.prototype.load=()=>new T.Texture();
const ledger=JSON.parse(fs.readFileSync(path.join(dir,'ledger.json'),'utf8'));
const catalog=JSON.parse(fs.readFileSync('apps/room3d/chibi/photoPairCatalog.json','utf8'));
const mapping={hips:'Pelvis',spine:'Spine1',chest:'Spine3',neck:'Neck',head:'Head'},parents={hips:null,spine:'hips',chest:'spine',neck:'chest',head:'neck'};
for(const side of ['L','R'])for(const [target,source,parent] of [['clavicle','Collar','chest'],['upperArm','Shoulder','clavicle'],['forearm','Elbow','upperArm'],['hand','Wrist','forearm'],['thigh','Hip','hips'],['shin','Knee','thigh'],['foot','Ankle','shin'],['toe','Foot','foot']]){
 mapping[`${side}_${target}`]=`${side}_${source}`;parents[`${side}_${target}`]=['chest','hips'].includes(parent)?parent:`${side}_${parent}`;
}
const round=n=>+n.toFixed(5),duration=6,cache=new Map();
function convert(id){
 if(cache.has(id))return cache.get(id);
 const entry=ledger.jobs.find(j=>j.id===id&&j.status==='SUCCEEDED'&&j.file);if(!entry)throw Error('Missing motion '+id);
 const bytes=fs.readFileSync(path.join(dir,entry.file));if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('Source hash mismatch '+id);
 const source=new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');source.updateMatrixWorld(true);
 const nodes=Object.fromEntries(Object.entries(mapping).map(([n,s])=>[n,source.getObjectByName(s)]));
 if(Object.values(nodes).some(n=>!n))throw Error('Unexpected skeleton');
 const rest=Object.fromEntries(Object.entries(nodes).map(([n,b])=>[n,b.getWorldQuaternion(new T.Quaternion()).invert()]));
 const leg=nodes.L_shin.position.length()+nodes.L_foot.position.length();
 const clip=source.animations[0],mixer=new T.AnimationMixer(source),action=mixer.clipAction(clip);action.setLoop(T.LoopOnce,1);action.clampWhenFinished=true;action.play();
 const pose=t=>{action.reset().play();mixer.setTime(t);source.updateMatrixWorld(true);return nodes.hips.getWorldPosition(new T.Vector3());};
 const start=pose(0),times=[],positions=[],tracks=Object.fromEntries(Object.keys(nodes).map(n=>[n,[]])),points=Object.fromEntries(Object.keys(nodes).map(n=>[n,[]]));
 for(let i=0;i<=120;i++){
  const t=i/20,pelvis=pose(t/duration*clip.duration),hip=nodes.hips.getWorldQuaternion(new T.Quaternion()).multiply(rest.hips);
  const forward=new T.Vector3(0,0,1).applyQuaternion(hip),unheading=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),-Math.atan2(forward.x,forward.z));
  const world=Object.fromEntries(Object.entries(nodes).map(([n,b])=>[n,unheading.clone().multiply(b.getWorldQuaternion(new T.Quaternion())).multiply(rest[n]).normalize()]));
  const pos=new T.Vector3(0,1.18+(pelvis.y-start.y)/leg,0);times.push(round(t));positions.push(...pos.toArray().map(round));
  for(const n of Object.keys(nodes)){
   const q=(world[parents[n]]?.clone()??new T.Quaternion()).invert().multiply(world[n]).normalize(),v=tracks[n];
   if(v.length&&q.dot(new T.Quaternion().fromArray(v,v.length-4))<0)q.set(-q.x,-q.y,-q.z,-q.w);
   v.push(...q.toArray().map(round));
   points[n].push(...nodes[n].getWorldPosition(new T.Vector3()).sub(pelvis).applyQuaternion(unheading).divideScalar(leg).add(pos).toArray().map(round));
  }
 }
 const result={duration,times,tracks,positions,points,hipHeight:1.18};cache.set(id,result);return result;
}
function mirror(track){
 const flip=n=>n.startsWith('L_')?'R_'+n.slice(2):n.startsWith('R_')?'L_'+n.slice(2):n;
 return {...track,tracks:Object.fromEntries(Object.entries(track.tracks).map(([n,v])=>[flip(n),v.map((x,i)=>i%4===1||i%4===2?-x:x)])),points:Object.fromEntries(Object.entries(track.points).map(([n,v])=>[flip(n),v.map((x,i)=>i%3===0?-x:x)])),positions:track.positions.map((x,i)=>i%3===0?-x:x)};
}
const output='public/room3d/motions/photo-pairs';fs.mkdirSync(output,{recursive:true});
const report=[],outputs=[];
for(const entry of catalog){
 const actors=entry.sources.map((id,i)=>i===1?mirror(convert(id)):convert(id));
 const text=JSON.stringify({version:1,id:entry.id,source:'meshy-text-to-motion',duration,actors})+'\n';
 outputs.push([`${output}/${entry.id}.json`,text]);
 report.push({id:entry.id,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),sources:entry.sources.map(id=>{const j=ledger.jobs.find(j=>j.id===id);return {id,taskId:j.taskId,sha256:j.sha256,prompt:j.params.prompt,credits:j.consumedCredits};})});
}
// Validate every original and complete conversion before replacing any runtime asset.
for(const [file,text] of outputs)fs.writeFileSync(file,text);
fs.writeFileSync('art/photo-mode-2026/portrait-sources.json',JSON.stringify(report,null,2)+'\n');
console.log(report.map(({id,bytes})=>({id,bytes})));
