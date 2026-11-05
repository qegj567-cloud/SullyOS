import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Process-only credential; original FBX files and resumable ledger stay outside the repository.
const token=process.env.MESHY_API_KEY,dir=process.env.MESHY_PHOTO_DIR;
if(!token||!dir)throw Error('Set MESHY_API_KEY and MESHY_PHOTO_DIR');
const jobs=[
 ['heart','A cute couple photo pose facing camera. Your partner is on your left. Lift your left arm in a large curved arc above your head to form half of a big heart with your partner. Bend the elbow overhead and point fingertips inward. Right hand on hip. Gently tilt head toward partner, keep face visible looking forward. Hold seconds 2 to 6, subtle breathing, feet planted, no turns.'],
 ['peace','Stand facing the camera for a cute portrait. Lift the right hand out to the side beside the shoulder and make a V peace sign, palm forward. Keep the hand outside the face silhouette. Left hand rests on hip. Feet planted with a small relaxed knee bend. Head upright looking straight ahead throughout. Hold the pose from second 2 through 6. No turning or walking.'],
 ['handhold','Playful best-friend portrait, facing camera with partner on your left. Link your left arm with their right arm at elbow height. Put right hand on hip, tilt head gently toward partner. Bend right knee and lift the right heel backward in a cute photo pose. Balance on left leg and hold seconds 2 through 6. Keep chest and face toward camera, tiny natural sway, no walking or turning.'],
 ['shoulder','Pose for a photo facing the camera beside a friend on your left. Extend the left arm sideways at shoulder height and bend the elbow gently to rest the forearm behind their shoulders. Right hand on your own hip. Keep the torso upright and face looking straight ahead. Feet stay planted. Hold from second 2 through 6 with subtle breathing. No turning, hugging in front, or walking.'],
 ['peek','Sweet couple photo: stand behind and slightly to the right of a partner, facing camera. Gently extend both arms forward at waist height to hug their waist. Lean head slightly to the right to peek beside their head, keeping your face visible to camera. Feet planted, upper body upright, gentle breathing. Hold from second 2 to 6, no turning or walking.'],
 ['bunny','Playful photo booth portrait, facing camera. Raise both hands beside and above your own head with index and middle fingers extended like bunny ears, keeping hands completely outside the face silhouette. Tilt head gently left and bend one knee inward, a tiny happy shoulder bounce. Hold from second 2 to 6, no walking or turning.'],
];
await fs.mkdir(dir,{recursive:true});
const file=path.join(dir,'ledger.json'),lockFile=path.join(dir,'active.lock');
const lock=await fs.open(lockFile,'wx');
const ledger=await fs.readFile(file,'utf8').then(JSON.parse,()=>({jobs:[]}));
const save=async()=>{await fs.writeFile(file+'.pending',JSON.stringify(ledger,null,2)+'\n');await fs.rename(file+'.pending',file);};
async function api(endpoint,body){
 const r=await fetch('https://api.meshy.ai/openapi/v1/'+endpoint,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});
 if(!r.ok){const error=Error('Meshy HTTP '+r.status);error.status=r.status;throw error;}return r.json();
}
try{
 ledger.balanceBefore??=await api('balance');await save();
 let submitted=0;
 if(process.argv[2]==='submit')for(const [id,prompt] of jobs){
  if(submitted>=4)break;
  if(ledger.jobs.some(j=>j.id===id&&j.status!=='RATE_LIMITED'))continue;
  if(prompt.length>400)throw Error('Prompt too long: '+id);
  let entry=ledger.jobs.find(j=>j.id===id);if(!entry){entry={id,params:{prompt,mode:'prime',duration:6}};ledger.jobs.push(entry);}
  entry.status='SUBMITTING';await save();
  try{entry.taskId=(await api('text-to-motion',entry.params)).result;submitted++;await save();console.log(id,'submitted',entry.taskId);}
  catch(error){if(error.status!==429)throw error;entry.status='RATE_LIMITED';await save();console.log(id,'rate limited; resume later');break;}
 }
 for(const entry of ledger.jobs){
  if(!entry.taskId||entry.file)continue;
  const task=await api('text-to-motion/'+encodeURIComponent(entry.taskId));
  Object.assign(entry,{status:task.status,progress:task.progress,consumedCredits:task.consumed_credits});
  console.log(entry.id,task.status,task.progress);
  if(task.status==='SUCCEEDED'){
   const url=new URL(task.result.motion_url);if(url.protocol!=='https:'||!url.hostname.endsWith('.meshy.ai'))throw Error('Unexpected asset host');
   const r=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('Download failed');
   const bytes=Buffer.from(await r.arrayBuffer());entry.file=entry.id+'.'+task.result.motion_format;
   entry.sha256=createHash('sha256').update(bytes).digest('hex');entry.bytes=bytes.length;entry.durationMs=task.result.duration_ms;
   await fs.writeFile(path.join(dir,entry.file),bytes);
  }
  await save();
 }
 ledger.balanceAfter=await api('balance');await save();console.log('Balance',ledger.balanceAfter.balance);
}finally{await lock.close();await fs.unlink(lockFile);}
