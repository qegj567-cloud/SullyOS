import type {CharacterProfile,Message,StoryTheaterArchive,StoryTheaterEntry} from '../types';
import {DB,openDB} from './db';
import {parseLocalDateKey} from './localDate';
import {extractMemoriesFromBuffer} from './memoryPalace/extraction';
import {buildAutoArchiveFragments,mergePalaceFragmentsIntoMemories,type LightLLMConfig} from './memoryPalace/pipeline';
import {vectorizeAndStore} from './memoryPalace/vectorStore';
import {ensureFloat32} from './memoryPalace/db';
import {bm25Index} from './memoryPalace/bm25Index';
import {notifyMemoryNodesChanged} from './memoryPalace/nodeChanges';
import {MEMORY_AUTO_ARCHIVE_SYNC_EVENT} from './memoryPalace/autoArchive';
import type {EmbeddingConfig,MemoryNode,MemoryVector,RemoteVectorConfig} from './memoryPalace/types';

type Receipt=NonNullable<StoryTheaterArchive['memoryConversions']>[string];
type Entry={node:MemoryNode;vector:MemoryVector};
const running=new Set<string>();

/** This is an explicit memory date, not a message timestamp or a story clock. */
export function storyMemoryDate(date:string):number {
 const parsed=parseLocalDateKey(date);
 if(!parsed)throw new Error('请填写有效的记忆日期');
 parsed.setHours(12,0,0,0);
 return parsed.getTime();
}

/** The normal extractor limits each message to 600 characters. Split without dropping the tail. */
export function storyArchiveExtractionMessages(archive:StoryTheaterArchive,charId:string,date:string):Message[]{
 const timestamp=storyMemoryDate(date),text=archive.summary?.trim();
 if(archive.strategy!=='summary'||!text)throw new Error('这个事件盒没有可转化的摘要');
 if(text.length>20000)throw new Error('单个事件盒超过 2 万字，请先导出后分段整理');
 const points=Array.from(text),messages:Message[]=[];
 for(let i=0;i<points.length;i+=240)messages.push({id:-(messages.length+1),charId,role:'system',type:'text',timestamp,content:`【剧情事件盒摘要，第 ${messages.length+1} 段】\n${points.slice(i,i+240).join('')}`} as Message);
 return messages;
}

const sourceKey=(entry:StoryTheaterEntry,archive:StoryTheaterArchive)=>JSON.stringify([
 entry.title,entry.mask,entry.writesToCharacterMemory,archive.id,archive.strategy,archive.summary,archive.fromMessageId,archive.toMessageId,
]);

/** Nodes, neural links and the per-box receipt either all commit or all roll back. */
export async function commitStoryMemoryConversion(snapshot:StoryTheaterEntry,archive:StoryTheaterArchive,char:CharacterProfile,date:string,nodes:MemoryNode[],entries:Entry[],skipped:number){
 const palace=!!char.memoryPalaceEnabled;
 const saved=palace?entries.map(e=>e.node):nodes;
 const linked=buildAutoArchiveFragments(saved,0,true)?.fragments??[];
 const fragments=palace?linked:linked.map(({palaceMemoryId,...fragment})=>({...fragment,mood:'story'}));
 const receipt:Receipt={date,convertedAt:Date.now(),destination:palace?'palace':'neural',memoryIds:saved.map(n=>n.id),skipped};
 const db=await openDB();
 const updated=await new Promise<StoryTheaterEntry>((resolve,reject)=>{
  const tx=db.transaction(['story_theaters','characters','memory_nodes','memory_vectors'],'readwrite');
  let failure:unknown,entry:StoryTheaterEntry;
  tx.oncomplete=()=>resolve(entry);
  tx.onerror=()=>reject(failure??tx.error);
  tx.onabort=()=>reject(failure??tx.error??new Error('记忆转化未保存，请重试'));
  const storyRead=tx.objectStore('story_theaters').get(snapshot.id),charRead=tx.objectStore('characters').get(char.id);
  let pending=2;
  const finish=()=>{
   if(--pending)return;
   try{
    const fresh=storyRead.result as StoryTheaterEntry|undefined,character=charRead.result as CharacterProfile|undefined;
    const source=fresh?.archives.find(a=>a.id===archive.id);
    if(!fresh||!source||!character||!fresh.characterIds.includes(char.id))throw new Error('剧情、事件盒或接收角色已变更，请重新打开后再试');
    if(source.memoryConversions?.[char.id])throw new Error('这个事件盒已经转化给该角色，无需重复操作');
    if(sourceKey(fresh,source)!==sourceKey(snapshot,archive)||!!character.memoryPalaceEnabled!==palace)throw new Error('来源或角色记忆设置已变更，本次未保存，请重试');
    for(const {node,vector} of entries){
     if(node.charId!==char.id||vector.charId!==char.id||node.id!==vector.memoryId)throw new Error('记忆所属角色不匹配');
     const floats=ensureFloat32(vector.vector);
     tx.objectStore('memory_nodes').put(node);
     tx.objectStore('memory_vectors').put({...vector,vector:new Uint8Array(floats.buffer.slice(floats.byteOffset,floats.byteOffset+floats.byteLength))});
    }
    if(fragments.length)tx.objectStore('characters').put({...character,memories:mergePalaceFragmentsIntoMemories(character.memories??[],fragments)});
    entry={...fresh,archives:fresh.archives.map(a=>a.id===archive.id?{...a,memoryConversions:{...a.memoryConversions,[char.id]:receipt}}:a),updatedAt:receipt.convertedAt};
    tx.objectStore('story_theaters').put(entry);
   }catch(error){failure=error;tx.abort();}
  };
  storyRead.onsuccess=finish;charRead.onsuccess=finish;
 });
 if(palace){bm25Index.onNodesSaved(saved);notifyMemoryNodesChanged(char.id);}
 if(typeof window!=='undefined'&&fragments.length)window.dispatchEvent(new CustomEvent(MEMORY_AUTO_ARCHIVE_SYNC_EVENT,{detail:{charId:char.id,fragments}}));
 return {entry:updated,receipt};
}

export async function convertStoryArchiveToMemory(options:{
 entryId:string;archiveId:string;charId:string;date:string;userName:string;identityName:string;
 llm:LightLLMConfig;embedding?:EmbeddingConfig;remote?:RemoteVectorConfig;onProgress?:(text:string)=>void;
}){
 const {entryId,archiveId,charId,date,llm,embedding,remote}=options;
 storyMemoryDate(date);
 const key=JSON.stringify([entryId,archiveId,charId]);
 if(running.has(key))throw new Error('这个事件盒正在转化，请稍候');
 running.add(key);
 try{
  const [stories,char]=await Promise.all([DB.getStoryTheaters(),DB.getCharacter(charId)]);
  const entry=stories.find(e=>e.id===entryId),archive=entry?.archives.find(a=>a.id===archiveId);
  if(!entry||!archive||!char||!entry.characterIds.includes(charId))throw new Error('找不到剧情事件盒或接收角色');
  if(archive.memoryConversions?.[charId])return {entry,receipt:archive.memoryConversions[charId],alreadyConverted:true};
  const messages=storyArchiveExtractionMessages(archive,charId,date);
  if(!llm?.baseUrl||!llm.model)throw new Error('请先配置记忆副 API 或主 API');
  if(char.memoryPalaceEnabled&&(!embedding?.baseUrl||!embedding.model||!embedding.apiKey))throw new Error('该角色已启用记忆宫殿，请先完成向量 API 配置');
  options.onProgress?.('LLM 正在把事件盒整理为角色记忆…');
  const context=`目标角色：${char.name}。用户：${options.userName||'用户'}。用户在剧情中使用的身份：${options.identityName}。\n来源是剧情《${entry.title}》的第三人称事件盒，不是角色亲口说出的对话。只转换目标角色参与或明确知晓的事件；其他人物保持原名，不得把用户扮演的角色当成用户现实身份。保留重要因果和情绪，不补写摘要里没有的细节。\n这是剧情经历，记忆正文须保留剧情来源，不得记成现实发生的共同经历。用户指定记忆日期为 ${date}，不使用故事正文中的虚构日期覆盖它。`;
  const extracted=await extractMemoriesFromBuffer(messages,char.id,char.name,{...llm,deferPlateMaintenance:true},context,options.userName,[],[]);
  if(!extracted.memories.length||extracted.memories.some(node=>typeof node.content!=='string'||!node.content.trim()))throw new Error('没有提取出可用记忆，本事件盒未标记为已转化，可稍后重试');
  const timestamp=storyMemoryDate(date);
  const nodes=extracted.memories.map((node):MemoryNode=>({...node,charId:char.id,content:`【剧情《${entry.title}》的经历】${node.content}`,createdAt:timestamp,lastAccessedAt:Date.now(),pinnedUntil:null,relativeTimeAnchor:undefined,origin:'system'}));
  let result:Awaited<ReturnType<typeof commitStoryMemoryConversion>>|undefined;
  if(char.memoryPalaceEnabled){
   options.onProgress?.('正在写入记忆宫殿并关联神经链接…');
   await vectorizeAndStore(nodes,embedding!,remote,{commit:async entries=>{result=await commitStoryMemoryConversion(entry,archive,char,date,nodes,entries,nodes.length-entries.length);}});
  }else{
   options.onProgress?.('正在写入神经链接记忆…');
   result=await commitStoryMemoryConversion(entry,archive,char,date,nodes,[],0);
  }
  return {...result!,alreadyConverted:false};
 }finally{running.delete(key);}
}
