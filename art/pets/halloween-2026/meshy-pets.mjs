import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const dir='art/pets/halloween-2026',token=process.env.MESHY_API_KEY;
if(!token)throw Error('Set MESHY_API_KEY in the process environment');
const ledgerFile=dir+'/meshy-ledger.json',ledger=await fs.readFile(ledgerFile,'utf8').then(JSON.parse,()=>({jobs:[]}));
const save=async()=>{await fs.writeFile(ledgerFile+'.pending',JSON.stringify(ledger,null,2));await fs.rename(ledgerFile+'.pending',ledgerFile);};
async function api(endpoint,body){const r=await fetch('https://api.meshy.ai/openapi/v1/'+endpoint,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('Meshy HTTP '+r.status);return r.json();}
const lock=await fs.open(dir+'/active.lock','wx');
try{
 ledger.balanceBefore??=await api('balance');await save();
 if(process.argv[2]==='submit')for(const id of ['hamster','jellyfish']){
  if(ledger.jobs.some(j=>j.id===id))continue;
  const bytes=await fs.readFile(dir+'/'+id+'-reference.png');
  const params={ai_model:'meshy-6',should_remesh:true,target_polycount:6000,should_texture:false,target_formats:['glb']};
  const entry={id,params,imageFile:id+'-reference.png',imageSha256:createHash('sha256').update(bytes).digest('hex'),status:'SUBMITTING'};ledger.jobs.push(entry);await save();
  entry.taskId=(await api('image-to-3d',{...params,image_url:'data:image/png;base64,'+bytes.toString('base64')})).result;await save();console.log(id,'submitted',entry.taskId);
 }
 for(const entry of ledger.jobs){
  if(!entry.taskId||entry.file)continue;
  const task=await api('image-to-3d/'+encodeURIComponent(entry.taskId));Object.assign(entry,{status:task.status,progress:task.progress,consumedCredits:task.consumed_credits});console.log(entry.id,task.status,task.progress);
  if(task.status==='SUCCEEDED'){
   const url=new URL(task.model_urls.glb);if(url.protocol!=='https:'||!url.hostname.endsWith('.meshy.ai'))throw Error('Unexpected asset host');
   const r=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('Download failed');const bytes=Buffer.from(await r.arrayBuffer());
   if(bytes.toString('utf8',0,4)!=='glTF'||bytes.readUInt32LE(8)!==bytes.length)throw Error('Invalid GLB');
   entry.file=entry.id+'-source.glb';await fs.writeFile(dir+'/'+entry.file,bytes);entry.sha256=createHash('sha256').update(bytes).digest('hex');entry.bytes=bytes.length;
  }await save();
 }
 ledger.balanceAfter=await api('balance');await save();console.log('Balance',ledger.balanceAfter.balance);
}finally{await lock.close();await fs.unlink(dir+'/active.lock');}
