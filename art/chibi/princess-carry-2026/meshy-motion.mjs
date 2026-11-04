import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'motions');
await fs.mkdir(dir,{recursive:true});
const token=process.env.MESHY_API_KEY;
if(!token)throw Error('Set MESHY_API_KEY in the process environment');
const jobs=[
 ['carry-a','Facing forward, gently lift a partner in a bridal carry. Seconds 0-2 bend knees and reach one arm behind their back, other under knees. Seconds 2-4 push through legs and rise, elbows cradling the weight. Seconds 4-7 hold them close with soft breathing, a tiny reassuring sway and downward head glance. Seconds 7-10 squat slowly, lower partner to floor, release arms. No walking or spinning.'],
 ['carry-b','Being gently lifted in a bridal carry by a partner. Begin standing, reach arms toward their shoulders. Seconds 2-4 curl knees up, lean back slightly and turn sideways into their arms. Seconds 4-7 relax with head leaning toward partner, small breathing and a relaxed ankle movement. Seconds 7-10 uncurl legs gradually to stand, then release shoulders. Smooth gentle motion, no jumping.'],
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
  let entry=ledger.jobs.find(j=>j.id===id);if(!entry){entry={id,params:{prompt,mode:'prime',duration:10}};ledger.jobs.push(entry);}
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
