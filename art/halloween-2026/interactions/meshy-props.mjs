import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const dir=path.dirname(fileURLToPath(import.meta.url));
const token=process.env.MESHY_API_KEY;
if(!token)throw Error('Set MESHY_API_KEY in the process environment');
const jobs=[
 {id:'pumpkin-pail',prompt:'One cute Halloween pumpkin candy bucket, hollow open top, thick rounded pumpkin lobes, simple carved smiling jack o lantern face with recessed eyes, one sturdy semicircular arch handle above the opening. Toy prop for a cozy chibi game. Single isolated object, no candy inside, no ground, no character. Clean rounded silhouette, thick walls, no tiny details.',target_polycount:2400},
 {id:'wrapped-candy',prompt:'One single wrapped round candy bonbon with two short twisted wrapper ends. Cute chunky toy game prop, simple rounded center, broad folded wrapper tips. Symmetric isolated object, horizontal long axis, no ground, no text, no characters, no other objects.',target_polycount:800},
 {id:'little-ghost',prompt:'One small cute ghost puppet toy, rounded domed head flowing into a short wavy sheet skirt, two recessed oval eyes and a small recessed round mouth, tiny outstretched side arms. Friendly Halloween chibi handheld prop, solid closed bottom, no stick, no ground, no character, no accessories. Chunky smooth rounded silhouette.',target_polycount:1800},
];
const ledgerFile=path.join(dir,'meshy-ledger.json');
let ledger=await fs.readFile(ledgerFile,'utf8').then(JSON.parse,()=>({jobs:[]}));
async function save(){await fs.writeFile(ledgerFile+'.pending',JSON.stringify(ledger,null,2));await fs.rename(ledgerFile+'.pending',ledgerFile);}
async function api(endpoint,body){const res=await fetch('https://api.meshy.ai/openapi/'+endpoint,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});if(!res.ok)throw Error('Meshy HTTP '+res.status);return res.json();}
const lock=await fs.open(path.join(dir,'active.lock'),'wx');
try{
 ledger.balanceBefore??=await api('v1/balance');await save();
 for(const job of jobs){
  if(ledger.jobs.some(j=>j.id===job.id))continue;
  if(process.argv[2]!=='run')continue;
  const params={mode:'preview',ai_model:'meshy-6',should_remesh:true,topology:'triangle',target_formats:['glb'],prompt:job.prompt,target_polycount:job.target_polycount};
  const entry={id:job.id,params,status:'SUBMITTING'};ledger.jobs.push(entry);await save();
  // Ambiguous submission is recorded before POST and is never automatically repeated.
  entry.taskId=(await api('v2/text-to-3d',params)).result;await save();console.log(job.id,'submitted',entry.taskId);
 }
 for(let attempt=0;attempt<60;attempt++){
  let pending=false;
  for(const entry of ledger.jobs){
   if(!entry.taskId||entry.file)continue;
   const task=await api('v2/text-to-3d/'+encodeURIComponent(entry.taskId));
   Object.assign(entry,{status:task.status,progress:task.progress,consumedCredits:task.consumed_credits});console.log(entry.id,task.status,task.progress);
   if(task.status==='SUCCEEDED'){
    const url=new URL(task.model_urls.glb);if(url.protocol!=='https:'||!url.hostname.endsWith('.meshy.ai'))throw Error('Unexpected asset host');
    const res=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!res.ok)throw Error('Asset download failed');
    const bytes=Buffer.from(await res.arrayBuffer());if(bytes.toString('utf8',0,4)!=='glTF'||bytes.readUInt32LE(8)!==bytes.length)throw Error('Invalid GLB');
    entry.file=entry.id+'-source.glb';await fs.writeFile(path.join(dir,entry.file),bytes);entry.sha256=createHash('sha256').update(bytes).digest('hex');entry.bytes=bytes.length;
   }else if(!['FAILED','CANCELED'].includes(task.status))pending=true;
   await save();
  }
  if(!pending||process.argv[2]!=='run')break;
  await new Promise(r=>setTimeout(r,20000));
 }
 ledger.balanceAfter=await api('v1/balance');await save();console.log('Balance',ledger.balanceAfter.balance);
}finally{await lock.close();await fs.unlink(path.join(dir,'active.lock'));}
