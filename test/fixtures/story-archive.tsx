import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OSPreviewProvider} from '../../context/OSContext';
import StoryArchivePanel from '../../components/date/story/StoryArchivePanel';
import {StoryTheaterThemeProvider} from '../../components/date/story/StoryTheaterTheme';
import {DB} from '../../utils/db';
import {MemoryNodeDB} from '../../utils/memoryPalace/db';
import {createStoryTheaterDraft} from '../../utils/storyTheater';
import type {CharacterProfile,StoryTheaterEntry} from '../../types';
if(location.port!=='5191')throw Error('请使用独立验收端口 5191');
const original=window.fetch.bind(window);let requests=0;
window.fetch=async(input,init)=>{
 const url=String(input);
 if(!url.includes('/__story_memory_mock'))return original(input,init);
 requests++;
 const result=url.endsWith('/embeddings')?{data:[{index:0,embedding:[1,0,0,0]}]}:{choices:[{message:{content:JSON.stringify([{content:'在《雨夜车站》的剧情中，我和小雨错过末班车。我们等雨变小后一起走回家。',room:'bedroom',importance:7,tags:['雨夜','车站'],mood:'tender',date:'2099-01-01'}])}}]};
 return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});
};
function App(){
 const [entry,setEntry]=useState<StoryTheaterEntry>(),[report,setReport]=useState('仅使用演示数据和本地模拟 API；不调用真实模型。');
 const [characters]=useState(()=>[{id:'qa-story-palace',name:'阿泽',memoryPalaceEnabled:true,memories:[],hideBeforeMessageId:70},{id:'qa-story-neural',name:'小北',memoryPalaceEnabled:false,memories:[]}] as unknown as CharacterProfile[]);
 const config={baseUrl:location.origin+'/__story_memory_mock',apiKey:'demo',model:'demo',dimensions:4};
 useEffect(()=>{void(async()=>{
  const old=(await DB.getStoryTheaters()).find(e=>e.id==='qa-story-memory');
  if(old){setEntry(old);return;}
  for(const c of characters)await DB.saveCharacter(c);
  localStorage.setItem('mp_lastMsgId_qa-story-palace','60');
  const next={...createStoryTheaterDraft(),id:'qa-story-memory',title:'雨夜车站',characterIds:characters.map(c=>c.id),writesToCharacterMemory:false,archives:[{id:'qa-box-one',strategy:'summary' as const,fromMessageId:1,toMessageId:35,messageCount:35,createdAt:1,summary:'小雨和阿泽错过了末班车。雨势太大，他们在车站等了一会儿。阿泽借给小雨外套，两人约定等雨变小后一起走回家。小北没有参加这段经历。'},{id:'qa-box-two',strategy:'summary' as const,fromMessageId:36,toMessageId:70,messageCount:35,createdAt:2,summary:'第二天，小北来归还借走的书。小雨与他在咖啡馆聊起了书里的结尾，阿泽此时并不在场。'}]};
  await DB.saveStoryTheater(next);setEntry(next);
 })();},[]);
 const inspect=async()=>{const c=await DB.getCharacter(characters[0].id),nodes=await MemoryNodeDB.getByCharId(characters[0].id);setReport(JSON.stringify({mockRequests:requests,chatWatermark:localStorage.getItem('mp_lastMsgId_qa-story-palace'),hiddenThrough:c?.hideBeforeMessageId,palace:nodes.map(n=>({content:n.content,date:new Date(n.createdAt).toLocaleDateString()})),neural:c?.memories,receipts:(await DB.getStoryTheaters()).find(e=>e.id==='qa-story-memory')?.archives.map(a=>a.memoryConversions)},null,2));};
 const os={theme:{},characters,userProfile:{name:'小雨'},apiConfig:config,memoryPalaceConfig:{lightLLM:config,embedding:config},remoteVectorConfig:{enabled:false},addToast:(s:string)=>setReport(s),registerBackHandler:()=>()=>{}} as any;
 return <OSPreviewProvider value={os}><div className='qa-layout'><div className='qa-phone'>{entry&&<StoryTheaterThemeProvider><StoryArchivePanel entry={entry} masks={[]} onBack={()=>setReport('返回剧情')} onUpdated={setEntry}/></StoryTheaterThemeProvider>}</div><aside className='qa-report'><h1>事件盒 → 角色记忆</h1><p className='my-4'>模拟 LLM + Embedding，实际界面与 IndexedDB。日期应采用手填值；聊天水位 60、隐藏线 70 应不变。</p><button className='p-3 bg-white rounded-lg' onClick={()=>void inspect()}>检查写入结果</button><pre className='mt-4 text-xs' role='status'>{report}</pre></aside></div></OSPreviewProvider>;
}
const root=createRoot(document.getElementById('root')!);root.render(<App/>);import.meta.hot?.dispose(()=>{root.unmount();window.fetch=original;});
