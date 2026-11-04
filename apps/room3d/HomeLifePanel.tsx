import {trackHomeFeature} from '../../utils/homeAnalytics';
import {loadMusicPlaybackSnapshot} from '../../context/MusicContext';
import type {HomeConversationContext} from '../../utils/homeConversation';
import {makeDebugLogger} from '../../utils/devDebug';
const actionLog=makeDebugLogger('api','Home action');
import {awaitHomeStage} from '../../utils/homeReplyStage';
import {getLastInnerState} from '../../utils/emotionState';
import {homeEmotionEnabled} from '../../utils/homeEmotion';
import type {HomeInitiativeRequest} from './HomePresenceBubbles';

import {Button,Switch} from './islandComponents';
import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowUp,BookOpen,ChatCircle,DotsThree,House,PawPrint,PaintBrush,Users,SlidersHorizontal,X,ArrowCounterClockwise,PencilSimple,Trash,Check} from '@phosphor-icons/react';
import type {APIConfig,CharacterProfile,UserProfile} from '../../types';
import type {HomeEditor} from './editor.js';
import type {HomeRecord} from './types';
import {homeRecords,makeHomeRecord,editHomeRecord} from '../../utils/homeRecords';
import {generateHomeReply} from '../../utils/homeConversation';
import {runHomeSocialRound} from '../../utils/homeSocialRound';
import './homeLife.css';
import {isScheduleFeatureOn} from '../../utils/scheduleFeature';
import HomeScheduleTip from './HomeScheduleTip';
import {waitForHomeSecretOrigin} from '../../utils/homeSecrets';
import type {SecretNoteOrigin} from '../../utils/secretNote';

export default function HomeLifePanel({editor,character,user,api,conversationContext,panel,onPanel,onDefinition,onFigures,initiative,active=true,onBusyChange,presentation='home'}:{presentation?:'home'|'homely';onBusyChange?:(busy:boolean)=>void;active?:boolean;initiative?:HomeInitiativeRequest;editor:HomeEditor;character?:CharacterProfile;user?:UserProfile;api?:APIConfig;conversationContext?:HomeConversationContext;panel:string|null;onPanel:(name:string|null)=>void;onDefinition?:()=>void;onFigures?:()=>void}){
 const [inner,setInner]=useState<{charId?:string;text:string}>({charId:character?.id,text:character?getLastInnerState(character.id):''});
 useEffect(()=>{
  const id=character?.id;
  setInner({charId:id,text:id?getLastInnerState(id):''});
  const updateInner=(event:Event)=>{const d=(event as CustomEvent).detail;if(id&&d?.charId===id&&typeof d.innerState==='string')setInner({charId:id,text:d.innerState});};
  window.addEventListener('emotion-innerstate-updated',updateInner);
  return ()=>window.removeEventListener('emotion-innerstate-updated',updateInner);
 },[character?.id,panel]);
 useEffect(()=>()=>onBusyChange?.(false),[onBusyChange]);
 const [draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[filter,setFilter]=useState('all'),[limit,setLimit]=useState(40),[revision,refresh]=useState(0);
 useEffect(()=>{onBusyChange?.(busy);},[busy,onBusyChange]);
 const [editing,setEditing]=useState<string>(),[editText,setEditText]=useState(''),[removed,setRemoved]=useState<{record:HomeRecord;index:number}>();
 const controller=useRef<AbortController>(),alive=useRef(true),list=useRef<HTMLDivElement>(null),sheet=useRef<HTMLElement>(null);
 const automaticRequest=useRef(false);
 const conversationEnd=useRef<((seconds?:number)=>void)>();
 const [replyStage,setReplyStage]=useState('准备上下文');
 const [retry,setRetry]=useState<{userId:string;replyId?:string}>();
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort(new DOMException('已离开家园或家园界面重新加载','AbortError'));conversationEnd.current?.();};},[]);
 useEffect(()=>{const stop=()=>{if((!active||document.hidden)&&(automaticRequest.current||editor.isSocialReplyBusy?.()))controller.current?.abort(new DOMException('已离开家园，停止自动开口','AbortError'));};stop();document.addEventListener('visibilitychange',stop);return()=>document.removeEventListener('visibilitychange',stop);},[active]);
 useEffect(()=>{if(!panel)return;refresh(n=>n+1);const timer=setInterval(()=>refresh(n=>n+1),1500);return()=>clearInterval(timer);},[panel]);
 useEffect(()=>{if(panel&&panel!=='interact'&&!(presentation==='homely'&&panel==='chat'))sheet.current?.querySelector<HTMLButtonElement>('button')?.focus();},[panel,presentation]);
 const home=editor.getState?.(),records=homeRecords(home),scene=editor.getHomeScene();
 const entries=panel==='chat'?records.filter(e=>e.kind==='message'||e.kind==='action').slice(-30):records.filter(e=>filter==='all'||filter==='conversation'&&e.kind==='message'||filter===e.source).slice(-limit);
 const scrollPosition=useRef({view:'',limit:0,count:0,height:0,top:0,nearBottom:true});
 const rememberScroll=()=>{
  const element=list.current;if(!element)return;
  Object.assign(scrollPosition.current,{height:element.scrollHeight,top:element.scrollTop,nearBottom:element.scrollHeight-element.clientHeight-element.scrollTop<100});
 };
 // Like Chat: position before paint, never animate through the entire history.
 // Preserve the reading anchor when older records are prepended or new replies arrive above a reader.
 useLayoutEffect(()=>{
  const element=list.current,previous=scrollPosition.current;
  if(!element||(panel!=='chat'&&panel!=='journal')){previous.view='';return;}
  const view=JSON.stringify([character?.id,panel,panel==='journal'?filter:'']);
  if(previous.view!==view||!previous.count)element.scrollTop=element.scrollHeight;
  else if(panel==='journal'&&limit>previous.limit)element.scrollTop=previous.top+element.scrollHeight-previous.height;
  else if(previous.nearBottom)element.scrollTop=element.scrollHeight;
  Object.assign(previous,{view,limit,count:entries.length});rememberScroll();
 });
 const update=(next:HomeRecord[])=>{editor.updateRecords(next);refresh(n=>n+1);};
 const current=()=>homeRecords(editor.getState?.());
 const reply=async(userId:string,replyId?:string)=>{
  if(controller.current||!character||!user||!api)return;
  const all=current(),input=all.find(e=>e.id===userId),old=replyId?all.find(e=>e.id===replyId):undefined;
  if(!input)return;
  const snapshot=editor.getResidentScene?.(character.id)??editor.getHomeScene();
  if(!replyId&&!snapshot.present){setError('到角色所在的房间，再当面聊聊吧');return;}
  const abort=new AbortController();automaticRequest.current=input.automatic===true;controller.current=abort;setBusy(true);setError('');setRetry(undefined);
  conversationEnd.current?.();const endConversation=replyId?undefined:editor.beginHomeConversation?.();conversationEnd.current=endConversation;let speakingSeconds=0;
  let timeout:ReturnType<typeof setTimeout>|undefined;
  const onStage=(stage:string)=>{if(abort.signal.aborted)return;setReplyStage(stage);clearTimeout(timeout);timeout=setTimeout(()=>abort.abort(new DOMException(stage+'等待超过 120 秒，可重试','TimeoutError')),120000);};
  onStage('准备上下文');
  let resolveOrigin!:(origin:SecretNoteOrigin|undefined)=>void;
  const secretOrigin=new Promise<SecretNoteOrigin|undefined>(resolve=>{resolveOrigin=resolve;});
  let savedReply=false;
  const replyRecord=old||makeHomeRecord({kind:'message',source:'model',actor:'character',text:'',roomId:input.roomId,roomName:input.roomName,replyTo:userId});
  try{
   if(!replyId&&(snapshot.participants?.filter(p=>p.id!=='user').length||0)>1){
    endConversation?.(0);conversationEnd.current=undefined;editor.setSocialReplyBusy(true);
    await runHomeSocialRound({editor,owner:character,user,api,inputId:userId,signal:abort.signal,context:{...conversationContext,musicSnapshot:loadMusicPlaybackSnapshot()},onStage,commit:update});
    savedReply=true;resolveOrigin(undefined);return;
   }
   const history=all.slice(0,all.findIndex(e=>e.id===userId)+1);
   const result=await awaitHomeStage(abort.signal,()=>generateHomeReply({secretOrigin,onStage,context:{...conversationContext,musicSnapshot:loadMusicPlaybackSnapshot()},char:{...character,home3D:editor.getState?.()??character.home3D},initiative:input.initiative,automatic:input.automatic,user,api,scene:replyId?{...snapshot,present:true,actions:[],roomId:input.roomId,roomName:input.roomName}:snapshot,records:history,regenerating:!!replyId,signal:abort.signal}));
   if(abort.signal.aborted||!alive.current)return;
   const latest=current();
   if(latest.find(e=>e.id===userId)?.text!==input.text||replyId&&latest.find(e=>e.id===replyId)?.text!==old?.text)throw Error('这段记录已修改，本次回复未覆盖它');
   const committedReply={...replyRecord,text:result.text};
   if(replyId)update(latest.map(e=>e.id===replyId?{...e,text:result.text,editedAt:Date.now()}:e));
   else{
    update([...latest,committedReply]);
    const actionIds=result.actionIds??(result.actionId?[result.actionId]:[]);
    const now=editor.getHomeScene();
    if(actionIds.length&&(!now.present||now.roomId!==snapshot.roomId||now.manualRevision!==snapshot.manualRevision)){actionLog.info('动作未执行：现场已变化',{present:now.present,sameRoom:now.roomId===snapshot.roomId,sameRevision:now.manualRevision===snapshot.manualRevision});setError('回复已收到，但等待期间现场发生变化，本次动作未执行');}
    if(now.present&&now.roomId===snapshot.roomId)editor.showHomeBubble?.(character.id,result.text);
    if(!actionIds.length&&now.present&&now.roomId===snapshot.roomId&&now.manualRevision===snapshot.manualRevision){speakingSeconds=Math.min(12,Math.max(3,result.text.length/6));editor.playHomeResponse?.('model',userId);}
    if(actionIds.length&&now.present&&now.roomId===snapshot.roomId&&now.manualRevision===snapshot.manualRevision){if(editor.performHomeActions){void editor.performHomeActions(actionIds,userId).then(outcome=>{actionLog.info('动作计划结束',{outcome});if(alive.current&&outcome==='unavailable')setError('回复已收到，动作计划有一步无法执行，已停在该步骤');}).catch(()=>{if(alive.current)setError('动作计划未能完成');});}else{const outcome=editor.performHomeAction(actionIds[0],'model',userId);if(outcome==='unavailable')setError('回复已收到，不过现在的空间没能执行这个动作');}}
   }
   savedReply=true;
   void waitForHomeSecretOrigin(character.id,[input,committedReply],abort.signal).then(resolveOrigin);
  }catch(e){if(alive.current){setError(abort.signal.aborted?(abort.signal.reason?.message||'回复已停止，可重试'):e instanceof Error?e.message:'暂时没收到回复');setRetry({userId,replyId});if(input.initiative)onPanel('chat');}}
  finally{editor.setSocialReplyBusy?.(false);if(!savedReply)resolveOrigin(undefined);endConversation?.(abort.signal.aborted?0:speakingSeconds);clearTimeout(timeout);if(controller.current===abort)controller.current=undefined;if(alive.current){setBusy(false);refresh(n=>n+1);}}
 };
 const handledInitiative=useRef<string>();
 useEffect(()=>{if(!initiative||handledInitiative.current===initiative.id)return;handledInitiative.current=initiative.id;
  const scene=editor.getHomeScene();if(!active||document.hidden||controller.current||!character||!user||!api||!scene.present||scene.roomId!==initiative.roomId)return;
  const record=makeHomeRecord({kind:'presence',source:'local',actor:'character',initiative:true,automatic:initiative.automatic,text:character.name+(initiative.automatic?'主动开口。最近：':'有话想说（用户点击听听）。最近：')+initiative.reason,roomId:scene.roomId,roomName:scene.roomName});
  update([...current(),record]);void reply(record.id);
 },[initiative?.id]);
 const send=()=>{
  const text=draft.trim();if(!text||busy||controller.current||!scene.present)return;
  if(!api||!character||!user){setError('请从角色家园入口进入，并在系统设置配置聊天 API');return;}
  const record=makeHomeRecord({kind:'message',source:'user',actor:'user',text,roomId:scene.roomId,roomName:scene.roomName});update([...current(),record]);editor.showHomeBubble?.('user',text);editor.playUserSpeech?.(text);setDraft('');void reply(record.id);
 };
 const remove=(record:HomeRecord)=>{controller.current?.abort(new DOMException('家园记录已修改，取消旧回复','AbortError'));const all=current();setRemoved({record,index:all.findIndex(e=>e.id===record.id)});update(all.filter(e=>e.id!==record.id));};
 const restore=()=>{if(!removed)return;const all=current();all.splice(Math.min(removed.index,all.length),0,removed.record);update(all);setRemoved(undefined);};
 const sourceName={user:'手动',local:'自主',model:'模型'};
 const title=panel==='mood'?`${character?.name||'TA'}的心情`:panel==='chat'?(editor.getPresentResidents?.().filter(p=>p.id!=='user').length>1?'大家聊聊':`和${character?.name||'TA'}聊聊`):panel==='journal'?'家里的日常':'我的家';
 if(!panel||panel==='interact'||panel==='visits')return null;
 const docked=presentation==='homely'&&panel==='chat';
 return <div className={`home-life-overlay ${docked?'homely-chat':''}`} onPointerDown={e=>{if(!docked&&e.target===e.currentTarget)onPanel(null);}}>
  <section ref={sheet} className={`home-life-sheet home-life-${panel}`} aria-label={title} role="dialog" aria-modal={docked?undefined:true} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();onPanel(null);}if(e.key==='Tab'&&!docked){const items=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),summary')].filter(el=>el.getClientRects().length);const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}}>
   <header><div><small>{scene.roomName}</small><h2>{title}</h2></div><button className="home-icon" aria-label={docked?'收起家园聊天':'关闭面板'} onClick={()=>onPanel(null)}>{docked?<span className="homely-chat-collapse" aria-hidden="true">⌄</span>:<X size={22}/>}</button></header>
   {panel==='mood'?<div className="home-mood-detail">
    {character&&homeEmotionEnabled(character)&&<section className="home-inner-state" aria-label="内心想法"><h3>内心想法</h3><p>{inner.charId===character.id&&inner.text?inner.text:'还没有内心想法，情绪评估完成后会显示在这里。'}</p></section>}
    {!character||!homeEmotionEnabled(character)?<p className="home-life-empty">尚未开启情绪 buff，可在角色的情绪设置中开启。</p>:!character.activeBuffs?.length?<p className="home-life-empty">暂时没有情绪 buff，交谈后的情绪更新会显示在这里。</p>:character.activeBuffs.map(buff=><article key={buff.id} className="home-mood-item"><span className="home-mood-icon" aria-hidden="true">{buff.emoji||'💭'}</span><div><h3>{buff.label}</h3><span className="home-mood-strength" aria-label={`强度 ${buff.intensity}`}>{'●'.repeat(Math.max(1,Math.min(5,buff.intensity||1)))}</span>{buff.description&&<p>{buff.description}</p>}</div></article>)}
   </div>:panel==='more'?<div className="home-menu-grid island-menu-grid">
    {[
     {label:'宠物',tone:'mint',note:'照顾伙伴、装扮与小记',Icon:PawPrint,run:()=>{onPanel(null);trackHomeFeature('pets');editor.openPets();}},
     ...(presentation==='home'?[{label:'邀请与串门',tone:'sky',note:'一起住、约个时间来玩',Icon:Users,run:()=>onPanel('visits')}]:[]),
     {label:'布置房间',tone:'butter',note:'家具与装修',Icon:PaintBrush,run:()=>{onPanel(null);trackHomeFeature('edit');editor.openPanel('decorate');}},
     ...(onFigures?[{label:'手办柜',tone:'rose',note:'双方形象',Icon:House,run:()=>{onPanel(null);onFigures();}}]:[]),
     ...(onDefinition?[{label:'家园设定',tone:'sky',note:'我们的共同空间',Icon:BookOpen,run:()=>{onPanel(null);onDefinition();}}]:[]),
     {label:'家园设置',tone:'peach',note:'配色与画面',Icon:SlidersHorizontal,run:()=>{onPanel(null);editor.openPanel('settings');}},
    ].map(({label,tone,note,Icon,run})=><button key={label} type="button" className="island-menu-card" data-tone={tone} onClick={run} aria-label={label+' '+note}><Icon size={26}/><strong>{label}</strong><small>{note}</small></button>)}
    <div className="home-autonomy island-autonomy"><Switch aria-label="自主活动与陪伴" checked={home?.autonomy!==false} onChange={checked=>{editor.setAutonomy(checked);refresh(n=>n+1);}}/><div>自主活动与陪伴<small>走动、使用家具、陪伴互动 · 本地运行，不调用 API</small></div></div>

    <div className="home-frequency" role="group" aria-label="本地活动频率">{[['quiet','安静'],['normal','日常'],['lively','活跃']].map(([value,label])=><button key={value} aria-pressed={(home?.activityFrequency||'normal')===value} onClick={()=>{editor.setCompanionPreference('activityFrequency',value);refresh(n=>n+1);}}>{label}</button>)}</div>
    <div className="home-autonomy island-autonomy"><Switch aria-label="角色自动开口" checked={home?.directSpeech===true} onChange={checked=>{editor.setCompanionPreference('directSpeech',checked);refresh(n=>n+1);}}/><div>角色自动开口<small>你在家园且同处一室时主动聊天 · 调用 API</small></div></div>
    <p className="home-auto-note">至少 3 次有效自主行为、90 秒后才可能开口；两次主动开口至少间隔 3 分钟。离开家园或切换 App 后不再自动调用。</p>
    {character&&!isScheduleFeatureOn(character)&&<HomeScheduleTip/>}
   </div>:<>
    {panel==='journal'&&<div className="home-record-filters" role="group" aria-label="记录筛选">{[['all','全部'],['conversation','对话'],['user','手动'],['local','自主'],['model','模型']].map(([id,label])=><button key={id} aria-pressed={filter===id} onClick={()=>{setFilter(id);setLimit(40);}}>{label}</button>)}</div>}
    <div className="home-record-list" ref={list} onScroll={rememberScroll} style={{scrollBehavior:'auto',overflowAnchor:'none'}}>
     {panel==='journal'&&records.length>limit&&<button className="home-load-more" onClick={()=>setLimit(n=>n+40)}>更早的日常</button>}
     {!entries.length&&<div className="home-life-empty"><ChatCircle size={36}/><p>{panel==='chat'?'聊点什么，让这里有你们的声音。':'一起做过的事，会慢慢留在这里。'}</p></div>}
     {entries.map(e=><article key={e.id} className={`home-record home-record-${e.kind} home-record-${e.actor}`}>
      <div className="home-record-meta"><span>{e.kind!=='message'&&<span className="home-event-mark" aria-label="行动">◇ </span>}{e.actorName||(e.actor==='user'?user?.name||'你':character?.name||'TA')}{panel==='journal'?` · ${sourceName[e.source]}`:''}{e.editedAt?' · 已编辑':''}</span><time>{new Date(e.at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} · {e.roomName}</time></div>
      {editing===e.id?<form onSubmit={event=>{event.preventDefault();if(!editText.trim())return;controller.current?.abort(new DOMException('家园记录已修改，取消旧回复','AbortError'));update(editHomeRecord(current(),e.id,editText));setEditing(undefined);}}><textarea aria-label="编辑记录" value={editText} maxLength={8000} onChange={event=>setEditText(event.target.value)}/><div className="home-record-edit-actions"><button type="button" onClick={()=>setEditing(undefined)}>取消</button><button type="submit"><Check/>保存</button></div></form>:<p>{e.text}</p>}
      <details className="home-record-menu"><summary aria-label="记录操作"><DotsThree size={22}/></summary><div>
       <button disabled={busy} onClick={()=>{setEditing(e.id);setEditText(e.text);}}><PencilSimple/>编辑</button>
       <button disabled={busy} onClick={()=>remove(e)}><Trash/>删除</button>
       {e.kind==='message'&&e.actor==='character'&&(!e.actorId||e.actorId===character?.id)&&e.replyTo&&records.some(r=>r.id===e.replyTo)&&<button disabled={busy||!api} title="重写回复，不重放动作" onClick={()=>void reply(e.replyTo!,e.id)}><ArrowCounterClockwise/>重新回复</button>}
       {e.kind==='message'&&e.actor==='user'&&!records.some(r=>r.replyTo===e.id)&&<button disabled={busy||!api||!scene.present} onClick={()=>void reply(e.id)}><ArrowCounterClockwise/>补回回复</button>}
      </div></details>
     </article>)}
     
     {busy&&<p className="home-typing" role="status">{editor.isSocialReplyBusy?.()?'':character?.name+' · '}{replyStage}<span>…</span><button onClick={()=>controller.current?.abort(new DOMException('用户点击停止家园回复','AbortError'))}>停止</button></p>}
    </div>
    {removed&&<div className="home-life-notice">已移除一条记录<button onClick={restore}>撤销</button></div>}
    {error&&<div role="alert" className="home-life-notice">{error}{retry&&<button disabled={busy} onClick={()=>void reply(retry.userId,retry.replyId)}>重试</button>}</div>}
    {panel==='chat'&&<form className="home-chat-compose" onSubmit={e=>{e.preventDefault();send();}}><textarea aria-label="在家园说句话" placeholder={scene.present?'说句话…':docked?'TA 外出了，晚点再聊':'TA 不在这个房间，先去找 TA 吧'} rows={1} maxLength={4000} disabled={!scene.present} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send();}}}/><button type="submit" aria-label="发送" disabled={busy||!scene.present||!draft.trim()}><ArrowUp size={22}/></button></form>}
   </>}
  </section>
 </div>;
}
