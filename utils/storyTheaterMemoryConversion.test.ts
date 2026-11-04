import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {CharacterProfile,StoryTheaterEntry} from '../types';
import type {MemoryNode} from './memoryPalace/types';
import {DB} from './db';
import {MemoryNodeDB,MemoryVectorDB} from './memoryPalace/db';
import {extractMemoriesFromBuffer} from './memoryPalace/extraction';
import {getEmbeddings} from './memoryPalace/embedding';
import {convertStoryArchiveToMemory,storyArchiveExtractionMessages,storyMemoryDate} from './storyTheaterMemoryConversion';
import {getLocalDateKey} from './localDate';
import {mergePalaceFragmentsIntoMemories} from './memoryPalace/pipeline';
vi.mock('./memoryPalace/extraction',()=>({extractMemoriesFromBuffer:vi.fn()}));
vi.mock('./memoryPalace/embedding',async original=>({...await original<any>(),getEmbeddings:vi.fn()}));
let serial=0,entry:StoryTheaterEntry,char:CharacterProfile;
const llm={baseUrl:'https://llm.invalid/v1',apiKey:'test',model:'test'},embedding={...llm,dimensions:2};
const node=():MemoryNode=>({id:`converted-${serial}`,charId:char.id,content:'我和小雨在车站等待，最后一起走回家。',room:'bedroom',importance:7,tags:['车站'],mood:'tender',embedded:false,createdAt:0,lastAccessedAt:0,accessCount:0,eventBoxId:null});
const call=()=>convertStoryArchiveToMemory({entryId:entry.id,archiveId:'box',charId:char.id,date:'2025-02-03',identityName:'小雨',userName:'用户',llm,embedding});
beforeEach(async()=>{
 serial++;vi.clearAllMocks();
 char={id:`convert-char-${serial}`,name:'阿泽',memoryPalaceEnabled:true,autoArchiveEnabled:false,hideBeforeMessageId:88,memories:[{id:'old',date:'2025-02-03',summary:'旧记忆',mood:'archive'}]} as CharacterProfile;
 entry={id:`convert-story-${serial}`,title:'雨夜车站',mask:{type:'custom',id:'rain'},characterIds:[char.id],writesToCharacterMemory:false,carryCharacterMemory:false,characterMemoryDates:{},characterContextLimits:{},archiveAfter:40,archiveStrategy:'summary',archives:[{id:'box',strategy:'summary',fromMessageId:1,toMessageId:8,messageCount:8,summary:'小雨和阿泽在车站等待，最后一起走回家。',createdAt:12}],selectedWorldbookIds:[],premise:'',createdAt:10,updatedAt:12};
 await DB.saveCharacter(char);await DB.saveStoryTheater(entry);localStorage.setItem(`mp_lastMsgId_${char.id}`,'77');
 vi.mocked(extractMemoriesFromBuffer).mockImplementation(async()=>({memories:[node()],crossTimeLinks:[],eventBoxHints:[],unpinIds:[],corrections:[]}));
 vi.mocked(getEmbeddings).mockResolvedValue([new Float32Array([1,0])]);
});
describe('story box → character memory',()=>{
 it('requires an explicit valid date and passes every character of a long summary to extraction',async()=>{
  for(const date of ['','2025-02-30','nonsense'])expect(()=>storyMemoryDate(date)).toThrow();
  const summary='开头'+ '甲😀'.repeat(1500)+'最后的承诺';
  const messages=storyArchiveExtractionMessages({...entry.archives[0],summary},char.id,'2025-02-03');
  expect(messages.map(m=>m.content.replace(/^.*?\n/, '')).join('')).toBe(summary);
  expect(messages.every(m=>m.content.length<600)).toBe(true);
  await expect(convertStoryArchiveToMemory({entryId:entry.id,archiveId:'box',charId:char.id,date:'',userName:'U',identityName:'U',llm,embedding})).rejects.toThrow('日期');
  expect(extractMemoriesFromBuffer).not.toHaveBeenCalled();
 });
 it('atomically writes palace nodes, vectors, linked neural memories and receipt without moving chat watermarks',async()=>{
  const result=await call();
  const saved=await MemoryNodeDB.getById(node().id),actor=await DB.getCharacter(char.id);
  expect(saved).toMatchObject({embedded:true,charId:char.id,origin:'system'});
  expect(saved!.content).toContain('剧情《雨夜车站》的经历');expect(getLocalDateKey(new Date(saved!.createdAt))).toBe('2025-02-03');
  expect(await MemoryVectorDB.getByMemoryId(node().id)).toBeDefined();
  expect(actor!.memories).toHaveLength(2);expect(actor!.memories[1]).toMatchObject({palaceMemoryId:node().id,date:'2025-02-03',summary:saved!.content});
  expect(actor!.hideBeforeMessageId).toBe(88);expect(localStorage.getItem(`mp_lastMsgId_${char.id}`)).toBe('77');
  expect(result.entry.archives[0].memoryConversions?.[char.id]).toMatchObject({date:'2025-02-03',destination:'palace',memoryIds:[node().id]});
  expect(result.entry.writesToCharacterMemory).toBe(false);expect(result.entry.archives[0].summary).toBe(entry.archives[0].summary);
  expect((await call()).alreadyConverted).toBe(true);expect(extractMemoriesFromBuffer).toHaveBeenCalledTimes(1);
 });
 it('writes neural-only memories without embedding and does not merge or duplicate them on runtime sync',async()=>{
  char.memoryPalaceEnabled=false;await DB.saveCharacter(char);
  await call();const saved=await DB.getCharacter(char.id);
  expect(getEmbeddings).not.toHaveBeenCalled();expect(await MemoryNodeDB.getById(node().id)).toBeUndefined();
  expect(saved!.memories[1]).toMatchObject({mood:'story',date:'2025-02-03'});expect(saved!.memories[1].palaceMemoryId).toBeUndefined();
  expect(mergePalaceFragmentsIntoMemories(saved!.memories,[saved!.memories[1]])).toEqual(saved!.memories);
 });
 it('keeps inputs retryable on empty extraction or embedding failure',async()=>{
  vi.mocked(extractMemoriesFromBuffer).mockResolvedValueOnce({memories:[],crossTimeLinks:[],eventBoxHints:[],unpinIds:[],corrections:[]});
  await expect(call()).rejects.toThrow('没有提取');
  vi.mocked(getEmbeddings).mockRejectedValueOnce(new Error('embedding failed'));
  await expect(call()).rejects.toThrow('embedding failed');
  expect(await MemoryNodeDB.getById(node().id)).toBeUndefined();
  expect((await DB.getStoryTheaters()).find(e=>e.id===entry.id)!.archives[0].memoryConversions).toBeUndefined();
  await expect(call()).resolves.toMatchObject({alreadyConverted:false});
 });
 it('rejects stale sources while retaining concurrent changes to the character and other boxes',async()=>{
  vi.mocked(getEmbeddings).mockImplementationOnce(async()=>{
   await DB.saveStoryTheater({...entry,archives:[{...entry.archives[0],summary:'已改写'}]});return [new Float32Array([1,0])];
  });
  await expect(call()).rejects.toThrow('来源');expect(await MemoryNodeDB.getById(node().id)).toBeUndefined();
  await DB.saveStoryTheater(entry);
  vi.mocked(getEmbeddings).mockImplementationOnce(async()=>{
   await DB.saveCharacter({...char,name:'新的名字'});
   await DB.saveStoryTheater({...entry,archives:[...entry.archives,{...entry.archives[0],id:'new-box'}]});return [new Float32Array([1,0])];
  });
  const result=await call();expect(result.entry.archives).toHaveLength(2);expect((await DB.getCharacter(char.id))!.name).toBe('新的名字');
 });
 it('rolls back the whole local write if saving the vector fails',async()=>{
  const original=IDBObjectStore.prototype.put;
  const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){if(this.name==='memory_vectors')throw new Error('disk full');return original.apply(this,args);});
  try{await expect(call()).rejects.toThrow('disk full');}finally{spy.mockRestore();}
  expect(await MemoryNodeDB.getById(node().id)).toBeUndefined();expect((await DB.getCharacter(char.id))!.memories).toHaveLength(1);
  expect((await DB.getStoryTheaters()).find(e=>e.id===entry.id)!.archives[0].memoryConversions).toBeUndefined();
 });
 it('records an all-duplicate batch without linking to nonexistent nodes',async()=>{
  const old={...node(),id:`existing-${serial}`,embedded:true};await MemoryNodeDB.saveVectorizedMany([{node:old,vector:{memoryId:old.id,charId:char.id,vector:[1,0],dimensions:2,model:'test'}}]);
  const result=await call();expect(result.receipt).toMatchObject({memoryIds:[],skipped:1});expect((await DB.getCharacter(char.id))!.memories).toHaveLength(1);
 });
});
