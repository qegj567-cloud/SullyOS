import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'motions');
await fs.mkdir(dir,{recursive:true});
const token=process.env.MESHY_API_KEY;
if(!token)throw Error('Set MESHY_API_KEY in the process environment');
const jobs=[
 ['boo-a','A playful person facing forward. Begin relaxed with arms down. Crouch slightly and slowly raise both hands like monster claws. At second 2 spring up and lean forward to playfully scare a friend in front. Then relax, chuckle with a small shoulder bounce, lower hands and settle back to standing. Natural full body weight shifts, planted feet, no walking or turning.'],
 ['boo-b','A person facing forward is playfully startled by a friend. Begin standing relaxed. At second 2 suddenly recoil, bend knees and raise open hands defensively near chest, shoulders lift. Recover balance with a small backward weight shift, then realize it is a joke and laugh softly, lower hands and settle relaxed. Stay in place facing forward, no turning.'],
 ['trick-a','Facing forward, a person holds a small candy bucket low in their left hand. Gently lift and offer the bucket to a friend in front, lean forward expectantly, raise the right palm in a playful request. Wait while receiving candy, then bounce slightly with delight and relax. Natural knees and shoulders, stay in place, no turning, eight seconds.'],
 ['trick-b','Facing forward, a person takes a small candy from near their waist with the right hand, bends gently toward a friend in front, extends the right hand to place candy in a low bucket at second 3.5. Release the candy, retract the hand, give a friendly small nod and return to relaxed standing. Natural full body movement, stay in place, no turning.'],
 ['candy-a','Facing forward, a cheerful person scoops a handful of candy with the right hand near their waist, dips the knees, then gently tosses it upward and forward to a friend around second 3. Follow through with wrist and shoulder, watch the candy fall, smile with a light shoulder bounce, return relaxed. Natural weight transfer, stay in place, no turning.'],
 ['candy-b','Facing forward, a person watches a friend toss candy. Look slightly upward, bend knees and extend both cupped hands forward at waist level by second 3, shift weight softly from side to side to catch falling candy through second 5. Look down at hands delighted, then relax. Fluid whole body acting, stay in place, no turning.'],
 ['ghost-a','Facing forward, playfully show a tiny ghost puppet held in the right hand just below shoulder height. Gently wave the puppet side to side toward a friend in front, lean with it, tease with two small wrist bobs, then pull the puppet back and lower it, chuckling. Soft playful full body motion, stay in place with no turning.'],
 ['ghost-b','Facing forward, react to a friend waving a tiny ghost puppet. Begin curious, tilt the head and lean back slightly in playful surprise at second 2.5. Lift the left hand to gently reach toward the puppet, then relax and laugh, lowering the hand. Natural knees and weight shifts, remain standing in place with no turning.'],
 ['forehead-a','Facing forward toward a loved partner, slowly raise the right hand to their shoulder and offer the left hand low. Soften knees and gently lean the upper body forward to rest foreheads together between seconds 2.5 and 5, tender small head tilt. Ease back and lower hands. Gentle natural full body motion, standing in place, no turning.'],
 ['forehead-b','Facing forward toward a loved partner, offer the right hand low and raise the left hand to their shoulder. Gently bend knees and lean forward to meet their forehead between seconds 2.5 and 5. Pause tenderly with a small relaxed sway, then ease back and lower hands. Soft natural full body movement, standing in place, no turning.'],
 ['kiss-a','Facing forward toward a romantic partner, gently lift the right hand toward their shoulder and left hand low to hold theirs. Lean forward gradually with soft knees, tilt head a little to the right and share a brief tender kiss between seconds 2.7 and 4.2. Slowly ease back, relax shoulders and lower hands. Natural standing full body movement, no walking or turning.'],
 ['kiss-b','Facing forward toward a romantic partner, gently lift the left hand toward their shoulder and right hand low to hold theirs. Lean forward gradually with soft knees, tilt head a little to the right and receive a brief tender kiss between seconds 2.7 and 4.2. Slowly ease back, relax shoulders and lower hands. Natural standing full body movement, no walking or turning.'],
];
const ledgerFile=path.join(dir,'ledger.json');
const ledger=await fs.readFile(ledgerFile,'utf8').then(JSON.parse,()=>({jobs:[]}));
const save=async()=>{await fs.writeFile(ledgerFile+'.pending',JSON.stringify(ledger,null,2));await fs.rename(ledgerFile+'.pending',ledgerFile);};
async function api(endpoint,body){const r=await fetch('https://api.meshy.ai/openapi/v1/'+endpoint,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});if(!r.ok){const error=new Error('Meshy HTTP '+r.status);error.status=r.status;throw error;}return r.json();}
const lockFile=path.join(dir,'active.lock'),lock=await fs.open(lockFile,'wx');
try{
 ledger.balanceBefore??=await api('balance');await save();
 if(process.argv[2]==='submit')for(const [id,prompt] of jobs){
  if(ledger.jobs.some(j=>j.id===id&&j.status!=='RATE_LIMITED'))continue;
  if(prompt.length>400)throw Error('Prompt too long: '+id);
  let entry=ledger.jobs.find(j=>j.id===id);if(!entry){entry={id,params:{prompt,mode:'prime',duration:8}};ledger.jobs.push(entry);}
  entry.status='SUBMITTING';await save();
  try{entry.taskId=(await api('text-to-motion',entry.params)).result;await save();console.log(id,'submitted',entry.taskId);}
  catch(error){if(error.status!==429)throw error;entry.status='RATE_LIMITED';await save();console.log(id,'queue full; retry after pending jobs finish');break;}
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
