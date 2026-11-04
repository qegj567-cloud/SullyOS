import type {CharacterProfile, APIConfig} from '../types';
import {DB} from './db';
import {homeRecords} from './homeRecords';
import {homeSegmentMessages as homeTurnMessages} from './homeContextSegments';
import {processNewMessagesWithAutoArchive} from './memoryPalace/autoArchive';
import {incrementDigestRound,runCognitiveDigestion} from './memoryPalace/digestion';
import type {EmbeddingConfig} from './memoryPalace/types';
import type {LightLLMConfig} from './memoryPalace/pipeline';
import type {HomeRecord} from '../apps/room3d/types';
import {homeSharedRecipients,isSharedHomeRecord} from './homeSharedEvents';

const seen=new Set<string>();
const chains=new Map<string,Promise<void>>();
/** Called only after the journal and its shared message projection have committed. */
export function processHomeMemoryAfterSave(before:CharacterProfile|undefined,after:CharacterProfile,config:{embedding?:EmbeddingConfig;lightLLM?:LightLLMConfig},api:APIConfig,userName:string):Promise<void>{
 if(before?.home3D?.records===after.home3D?.records)return Promise.resolve();
 const previous=homeRecords(before?.home3D),records=homeRecords(after.home3D);
 const recipients=new Set([after.id,...homeSharedRecipients(records)]);
 return Promise.all([...recipients].map(charId=>{
  const visible=(record:HomeRecord)=>isSharedHomeRecord(record)?record.sharedScene!.participantIds.includes(charId):charId===after.id;
  return processHomeRecordMemory(charId,previous.filter(visible),records.filter(visible),config,api,userName);
 })).then(()=>{});
}

function processHomeRecordMemory(charId:string,previous:HomeRecord[],records:HomeRecord[],config:{embedding?:EmbeddingConfig;lightLLM?:LightLLMConfig},api:APIConfig,userName:string):Promise<void>{
 const oldIds=new Set(previous.map(r=>r.id));
 const replies=records.filter(r=>!oldIds.has(r.id)&&r.kind==='message'&&r.actor==='character'&&r.source==='model'&&(!r.actorId||r.actorId===charId));
 const oldTurns=new Set(homeTurnMessages(charId,previous).map(r=>r.metadata.homeTurnId));
 const turns=homeTurnMessages(charId,records).filter(r=>!oldTurns.has(r.metadata.homeTurnId));
 const keys=[...turns.map(r=>'turn:'+r.metadata.homeTurnId),...replies.map(r=>'reply:'+r.id)].map(k=>charId+':'+k);
 if(!keys.length||keys.every(k=>seen.has(k)))return Promise.resolve();
 const freshReplies=replies.filter(r=>!seen.has(charId+':reply:'+r.id));
 for(const k of keys)seen.add(k);
 while(seen.size>2000)seen.delete(seen.values().next().value!);
 const task=(chains.get(charId)||Promise.resolve()).catch(()=>{}).then(async()=>{
  const live=await DB.getCharacter(charId),emb=config.embedding;
  const llm=config.lightLLM?.baseUrl?config.lightLLM:api;
  if(!live?.memoryPalaceEnabled||!emb?.baseUrl||!emb.apiKey||!llm.baseUrl)return;
  // The shared pipeline reads the full persisted timeline and the character's own waterline.
  await processNewMessagesWithAutoArchive([],live.id,live.name,emb,llm,userName,false);
  for(const _reply of freshReplies){
   const latest=await DB.getCharacter(live.id);
   if(!latest?.memoryPalaceEnabled)return;
   if(incrementDigestRound(live.id))await runCognitiveDigestion(live.id,latest.name,[latest.systemPrompt,latest.worldview].filter(Boolean).join('\n'),llm,false,userName,emb);
  }
 });
 chains.set(charId,task);
 void task.finally(()=>{if(chains.get(charId)===task)chains.delete(charId);}).catch(()=>{});
 return task;
}
