import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const home=path.dirname(fileURLToPath(import.meta.url));
const batchFile=path.resolve(process.argv[3]||path.join(home,'batch-01.json'));
const batch=JSON.parse(await fs.readFile(batchFile,'utf8'));
const endpoint=batch.endpoint||'image-to-3d';
if(!['image-to-3d','retexture'].includes(endpoint))throw Error('Unsupported endpoint');
const mode=process.argv[2]||'status';
if(!['run','status'].includes(mode))throw Error('Use run or status');
if(!/^[a-z0-9-]+$/.test(batch.id)||batch.jobs.length>Math.min(4,batch.maxTasks))throw Error('Invalid batch or task limit');
if(batch.jobs.reduce((n,x)=>n+x.estimatedCredits,0)>batch.maxEstimatedCredits)throw Error('Credit cap exceeded');
const token=process.env.MESHY_API_KEY;
if(!token)throw Error('Set MESHY_API_KEY only in the current shell; never save it in this directory');
const out=path.join(home,batch.id);await fs.mkdir(out,{recursive:true});
const stateFile=path.join(out,'ledger.json');
const exists=async file=>fs.access(file).then(()=>true,()=>false);
let state=await exists(stateFile)?JSON.parse(await fs.readFile(stateFile,'utf8')):{batch:batch.id,jobs:[]};
const lock=await fs.open(path.join(out,'active.lock'),'wx');
async function save(){const file=stateFile+'.pending';await fs.writeFile(file,JSON.stringify(state,null,2));await fs.rename(file,stateFile);}
async function api(endpoint,body){
 const res=await fetch('https://api.meshy.ai/openapi/v1/'+endpoint,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(body?120000:30000)});
 const json=await res.json();if(!res.ok)throw Error(`Meshy HTTP ${res.status}: ${JSON.stringify(json).replaceAll(token,'[redacted]')}`);return json;
}
try{
 const balance=await api('balance');console.log('Balance:',balance.balance);state.latestBalance=balance;
 if(!state.balanceBefore)state.balanceBefore=balance;
 if(mode==='run'){
  const pending=batch.jobs.filter(j=>!state.jobs.some(s=>s.id===j.id));
  if(balance.balance<pending.reduce((n,j)=>n+j.estimatedCredits,0))throw Error('Insufficient batch balance');
  for(const job of pending){
   if(!/^[a-z0-9-]+$/.test(job.id))throw Error('Invalid job id');
   const image=await fs.readFile(path.resolve(path.dirname(batchFile),job.image));
   const params={...batch.defaults,...(job.target_polycount?{target_polycount:job.target_polycount}:{}),...(job.pose_mode?{pose_mode:job.pose_mode}:{}),...(job.input_task_id?{input_task_id:job.input_task_id}:{})};
   const model=job.model?await fs.readFile(path.resolve(path.dirname(batchFile),job.model)):null;
   if(model&&(endpoint!=='retexture'||job.input_task_id))throw Error('Uploaded models require retexture without input_task_id');
   const entry={id:job.id,image:job.image,imageSha256:createHash('sha256').update(image).digest('hex'),params,estimatedCredits:job.estimatedCredits,status:'SUBMITTING',submittedAt:new Date().toISOString()};
   if(model)Object.assign(entry,{model:job.model,modelSha256:createHash('sha256').update(model).digest('hex')});
   state.jobs.push(entry);await save();
   // A failed/ambiguous POST is never retried automatically: recover its task ID first.
   const created=await api(endpoint,{...params,...(model?{model_url:'data:application/octet-stream;base64,'+model.toString('base64')}:{}),[endpoint==='retexture'?'image_style_url':'image_url']:'data:image/png;base64,'+image.toString('base64')});
   if(!created.result)throw Error('Missing task ID; reconcile before retrying');
   entry.taskId=created.result;entry.status='PENDING';await save();console.log('Created:',job.id,entry.taskId);
  }
 }
 let active=true;const deadline=Date.now()+25*60*1000;
 while(active){
  active=false;
  for(const job of state.jobs){
   if(!job.taskId){console.log(job.id,'Needs submission reconciliation');continue;}
   if(job.downloaded)continue;
   const task=await api(endpoint+'/'+encodeURIComponent(job.taskId));
   const changed=job.status!==task.status||job.progress!==task.progress;
   Object.assign(job,{status:task.status,progress:task.progress,consumedCredits:task.consumed_credits,error:task.task_error?.message||undefined});
   if(changed)console.log(job.id,job.status,job.progress,job.error||'');
   if(task.status==='SUCCEEDED'){
    // Keep the detailed source alongside the working mesh; never overwrite it during reduction.
    if(task.model_urls.pre_remeshed_glb && !job.sourceFile){
     const sourceUrl=new URL(task.model_urls.pre_remeshed_glb);if(sourceUrl.protocol!=='https:'||!sourceUrl.hostname.endsWith('.meshy.ai'))throw Error('Unexpected source download host');
     const sourceRes=await fetch(sourceUrl,{signal:AbortSignal.timeout(180000)});if(!sourceRes.ok)throw Error('Source download HTTP '+sourceRes.status);
     const sourceBytes=Buffer.from(await sourceRes.arrayBuffer());if(sourceBytes.toString('utf8',0,4)!=='glTF'||sourceBytes.readUInt32LE(8)!==sourceBytes.length)throw Error('Invalid source GLB');
     const sourceFile=job.id+'-source.glb',sourceDest=path.join(out,sourceFile);await fs.writeFile(sourceDest+'.pending',sourceBytes);await fs.rename(sourceDest+'.pending',sourceDest);
     Object.assign(job,{sourceFile,sourceBytes:sourceBytes.length,sourceSha256:createHash('sha256').update(sourceBytes).digest('hex')});await save();console.log('Source saved:',job.id,sourceBytes.length,'bytes');
    }
    const url=new URL(task.model_urls.glb);if(url.protocol!=='https:'||!url.hostname.endsWith('.meshy.ai'))throw Error('Unexpected download host');
    const res=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!res.ok)throw Error('Download HTTP '+res.status);
    const bytes=Buffer.from(await res.arrayBuffer());if(bytes.toString('utf8',0,4)!=='glTF'||bytes.readUInt32LE(8)!==bytes.length)throw Error('Invalid or incomplete GLB');
    const dest=path.join(out,job.id+'.glb');await fs.writeFile(dest+'.pending',bytes);await fs.rename(dest+'.pending',dest);
    Object.assign(job,{downloaded:true,file:job.id+'.glb',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});console.log('Saved:',job.id,bytes.length,'bytes');
   }else if(!['FAILED','CANCELED'].includes(task.status))active=true;
   await save();
  }
  if(!active||mode==='status'||Date.now()>deadline)break;
  await new Promise(resolve=>setTimeout(resolve,20000));
 }
 state.latestBalance=await api('balance');await save();console.log('Remaining:',state.latestBalance.balance,'Task credits:',state.jobs.reduce((n,j)=>n+(j.consumedCredits||0),0));
}finally{await lock.close();await fs.unlink(path.join(out,'active.lock'));}
