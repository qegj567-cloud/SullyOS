import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Home3DView from '../../apps/room3d/Home3DView';
import {createHome} from '../../apps/room3d/model.js';
// @ts-expect-error Runtime showroom fixture helper.
import {furnishShowroom} from '../../apps/room3d/showrooms.js';
import {testCharacter} from './room3d-test-character';
import {DB} from '../../utils/db';
import {requestHomeVisit,readHomeVisits,cancelHomeVisit} from '../../utils/homeVisits';
import {loadCharacterContextRange} from '../../utils/chatContextRange';
localStorage.setItem('sully-home3d-quality','eco');
localStorage.setItem('sully-home3d-quality-tip-v1','seen');
const catalog=await fetch('/room3d/catalog.json').then(r=>r.json()),home=createHome(catalog);home.rooms[0].items=[];furnishShowroom(home.rooms[0],'living',catalog);home.autonomy=true;
const ids=['qa-social-owner','qa-social-b','qa-social-c'],names=['小栗','小蓝','小桃'],visitMode=new URLSearchParams(location.search).has('visit');
home.socialMemberIds=visitMode?['user']:['user',ids[1],ids[2]];
const chars=ids.map((id,i)=>({id,name:names[i],avatar:'',description:'',memories:[],systemPrompt:names[i]+'自己的秘密是：'+['栗子糖','蓝色风铃','桃子汽水'][i],home3D:structuredClone(home),chibiStudio:{home3D:{state:testCharacter.state}},phoneState:{contacts:ids.filter(other=>other!==id).map(other=>({id:'contact-'+other,kind:'real',linkedCharId:other,name:names[ids.indexOf(other)],status:'friend',affinity:70}))}} as any));
for(const char of chars)await DB.saveCharacter(char);
const nativeFetch=window.fetch.bind(window),requests:any[]=[];let failOnce=false;
window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(!url.startsWith('/__social-qa__/'))return nativeFetch(input,init);
 const body=JSON.parse(String(init?.body)),id=(init as any).__sullyMeta?.charId||ids[0];requests.push({id,messages:body.messages});await new Promise(resolve=>setTimeout(resolve,600));if(init?.signal?.aborted)throw new DOMException('已取消','AbortError');if(failOnce&&id===ids[1]){failOnce=false;return new Response('模拟网络错误',{status:503});}
 return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:['我刚泡好茶，大家坐一会儿吧。','闻到茶香了，我在窗边看看。','那我也一起坐坐，听你们聊。'][ids.indexOf(id)],actionIds:[]})}}]}),{headers:{'Content-Type':'application/json'}});
};
const hair={bodyShape:'classic' as const,layers:{},extras:[]},residents=[{id:'user',label:'你',state:testCharacter.state},...chars.slice(1).map(c=>({id:c.id,label:c.name,state:testCharacter.state}))];
function Ready({editor}:{editor:any}){const [ready,setReady]=useState(false);useEffect(()=>{const timer=setInterval(()=>setReady((editor?.getPresentResidents().length||0)>=(visitMode?2:4)),500);return()=>clearInterval(timer);},[editor]);return ready?<button className="qa-ready" onClick={()=>editor.performGuestAction(ids[1],'guest:wander')}>场景已就绪 · 走动</button>:<span>正在加载小人…</span>;}
let queue=Promise.resolve();
function App(){const [editor,setEditor]=useState<any>(),[report,setReport]=useState(''),[savingError,setSavingError]=useState('');
 const run=async(fn:()=>Promise<unknown>)=>{try{setReport(JSON.stringify(await fn(),null,2));}catch(e){setReport(String(e));}};
 return <><Home3DView value={home} character={chars[0]} user={{name:'你'} as any} api={{baseUrl:'/__social-qa__',model:'fixture-only',apiKey:''} as any} hair={hair} residents={residents} onChange={state=>{chars[0]={...chars[0],home3D:state};const snapshot=structuredClone(chars[0]);queue=queue.then(()=>DB.saveCharacter(snapshot)).catch(e=>setSavingError(String(e)));}} onBack={()=>{}} onEditor={e=>{setEditor(e);const w=window as any;w.advanceTime=(ms:number)=>e.advanceTime?.(ms);w.render_game_to_text=()=>JSON.stringify({present:e.getPresentResidents(),records:e.getState().records,requests:requests.map(r=>r.id),scene:e.inspect?.()});}}/>
 <details className="qa-social"><summary>本地模拟验收 · 不调用真实 API</summary><Ready editor={editor}/><button onClick={()=>{editor?.openPanel('chat');}}>打开群聊</button><button onClick={()=>setReport(String(editor?.performGuestAction(ids[1],'guest:wander')))}>访客走动</button><button onClick={()=>{const action=editor?.getGuestActions(ids[1]).find((a:any)=>a.kind==='sit');setReport(action?String(editor.performGuestAction(ids[1],action.id)):'暂无空座位');}}>访客坐下</button><button onClick={()=>{failOnce=true;setReport('下一轮第二人模拟失败');}}>模拟中途失败</button><button onClick={()=>void run(()=>requestHomeVisit({hostId:ids[0],guestId:ids[1],startsAt:Date.now()-1,endsAt:Date.now()+300000,purpose:'带点茶点来'}))}>准备即刻串门</button><button onClick={()=>void run(async()=>{for(const v of await readHomeVisits())if(v.hostId===ids[0])await cancelHomeVisit(ids[0],v.id);return '已取消';})}>取消串门</button><button onClick={()=>void run(async()=>{await queue;return Promise.all(chars.map(async c=>({name:c.name,context:(await loadCharacterContextRange(c)).messages.map(m=>m.content)})));})}>检查三人记忆</button><output>{savingError||report}</output></details></>;
}
const root=createRoot(document.getElementById('root')!);root.render(<App/>);
import.meta.hot?.dispose(()=>{root.unmount();window.fetch=nativeFetch;});
