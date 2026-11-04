import {HomeSocialWheel} from './HomeSocialWheel';
import {useHomeVisits} from './useHomeVisits';
import {HomeVisitsPanel} from './HomeVisitsPanel';
import {HomeRomanceSettings} from './HomeRomanceSettings';
import {presentHomeVisit} from '../../utils/homeVisits';
import {defaultResidentExpression,type ResidentExpression} from './chibi/residentExpression';
import React,{useEffect,useRef,useState} from 'react';
import type {HomeEditor} from './editor.js';
import {CreatorRollBridge,type RollResult} from './chibi/CreatorRollBridge';
import {createVisitor,decodeParts} from './chibi/visitor';
import {selectedHairAssets,type HairSettings} from './chibi/types';
import {loadCreatorPartsForRender} from '../../utils/creatorPartsBlob';
import {selectedMotions} from './chibi/selectedMotions';
import './socialPanel.css';
export interface HomeResidentOption {id:string;label:string;avatar?:string;state:unknown;hair?:HairSettings}
function Resident({entry,editor,body,height,onReady,onError}:{entry:HomeResidentOption;editor:HomeEditor;body:'blank'|'classic';height:number;onReady:()=>void;onError:(e:string)=>void}){
 const [items,setItems]=useState<unknown[]>(),[ready,setReady]=useState(false);const dead=useRef(false),revision=useRef(0),callbacks=useRef({onReady,onError});callbacks.current={onReady,onError};
 useEffect(()=>{dead.current=false;loadCreatorPartsForRender().then(items=>{if(!dead.current)setItems(items.map(p=>({...p,categoryKey:p.categoryKey})));}).catch(e=>callbacks.current.onError(String(e)));return()=>{dead.current=true;revision.current++;editor.removeSocialResident(entry.id);};},[editor,entry.id]);
 const result=async(result:RollResult)=>{const token=++revision.current;try{const parts=await decodeParts(result,entry.hair);if(dead.current||token!==revision.current)return;const visitor=await createVisitor(parts,{...entry.hair,layers:entry.hair?.layers??{},extras:entry.hair?.extras??[],assets:selectedHairAssets(result.state),bodyShape:body,bodyHeight:(entry.hair?.bodyHeight??1)*height});if(dead.current||token!==revision.current){visitor.dispose();return;}editor.setSocialResident(entry.id,visitor,entry.label);callbacks.current.onReady();}catch(e){if(!dead.current)callbacks.current.onError(String(e));}};
 return <CreatorRollBridge request={ready&&items?1:0} savedState={entry.state} extraItems={items} onReady={()=>setReady(true)} onResult={r=>void result(r)} onError={e=>callbacks.current.onError(e)}/>;
}
export function HomeSocialPanel({editor,primary,options,body,onBody,mainReady,hair,externalOpen,onClose,targetId,initialSettings=false}:{initialSettings?:boolean;targetId?:string;externalOpen?:boolean;onClose?:()=>void;editor:HomeEditor;primary:{id:string;label:string};options:HomeResidentOption[];body:'blank'|'classic';onBody:(b:'blank'|'classic')=>void;mainReady:boolean;hair:HairSettings}){
 const [internalOpen,setOpen]=useState(false),[joined,setJoined]=useState<string[]>(()=>editor.getState().socialMemberIds?.filter(id=>options.some(e=>e.id===id)).slice(0,3)??(options.some(e=>e.id==='user')?['user']:[])),[loaded,setLoaded]=useState<string[]>([]),[heights,setHeights]=useState<Record<string,number>>({}),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
 const a='user',target=targetId??primary.id,b=target==='user'?'':target;
 const [settings,setSettings]=useState(false);
 const open=externalOpen??internalOpen;
 useEffect(()=>{if(open){setSettings(initialSettings);setStatus('');}},[open,initialSettings]);const close=()=>{setOpen(false);onClose?.();};
 const [expressions,setExpressions]=useState<Record<string,ResidentExpression>>({});
 const expression=expressions[a]??{...defaultResidentExpression,blink:a===primary.id?(hair.face?.blink??true):true};
 const changeExpression=(patch:Partial<ResidentExpression>)=>{const next={...expression,...patch};setExpressions(value=>({...value,[a]:next}));editor.setResidentExpression(a,next);};
 const visits=useHomeVisits(editor,primary.id,mainReady,joined,options.map(o=>o.id),setStatus);
 const presentIds=[...new Set([...joined,...visits.guestIds])].filter(id=>{const visit=presentHomeVisit(visits.rows,id);return !visit||visit.hostId===primary.id;}).slice(0,3);
 const valid=presentIds.flatMap(id=>{const e=options.find(e=>e.id===id);return e?[e]:[];}),members=[primary,...valid];
 useEffect(()=>{editor.setPrimaryResidentId(primary.id,primary.label);return()=>editor.cancelSocial();},[editor,primary.id]);
 useEffect(()=>{setLoaded([]);setBusy(false);},[body,mainReady]);
 const changeMembers=(ids:string[])=>{editor.cancelSocial();setJoined(ids);editor.setJoinedResidentIds(ids);setLoaded(v=>v.filter(id=>ids.includes(id)));setStatus('');};
 const play=async(id:string)=>{setBusy(true);setStatus('准备动作…');try{if(await editor.playSocial(id,a,b)){setStatus(selectedMotions.find(e=>e.id===id)!.label);close();}}catch(e){setStatus(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 return <div className="home-social">{externalOpen===undefined&&<button className="home-social-toggle" onClick={()=>setOpen(v=>!v)} aria-expanded={open}>一起玩</button>}{open&&!settings&&<HomeSocialWheel body={body} editor={editor} actor={target} selfOnly={target==='user'} name={target==='user'?'自己':members.find(m=>m.id===target)?.label??primary.label} busy={busy} status={status} available={e=>mainReady&&loaded.includes('user')&&(e.participants!==2||!!b&&(b===primary.id||loaded.includes(b)))} onPlay={id=>void play(id)} onClose={close} onSettings={()=>setSettings(true)} onStop={()=>{editor.cancelSocial();setStatus("已停止");}}/>}{open&&settings&&<section aria-label="成员与形象" role="dialog" aria-modal="true" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setSettings(false);}}}><header><strong>成员与形象</strong><button autoFocus aria-label="返回互动菜单" onClick={()=>setSettings(false)}>返回</button></header><div className="home-social-settings"><label>统一体型<select value={body} disabled={busy} onChange={e=>{editor.cancelSocial();onBody(e.target.value as 'blank'|'classic');}}><option value="classic">Chibi</option><option value="blank">修长体型</option></select></label><p>所有居民使用同一种体型。</p><fieldset><legend>邀请到小屋</legend>{options.length?options.map(entry=><label key={entry.id}><input type="checkbox" checked={joined.includes(entry.id)} disabled={!joined.includes(entry.id)&&joined.length>=3} onChange={e=>changeMembers(e.target.checked?[...joined,entry.id]:joined.filter(id=>id!==entry.id))}/>{entry.label}{joined.includes(entry.id)&&!loaded.includes(entry.id)?' · 载入中':''}</label>):<p>先在手办柜或彼方保存自己的形象，就能邀请到小屋。</p>}</fieldset>{body==='blank'&&valid.map(entry=><label key={entry.id}>{entry.label}身高 <input type="range" min="80" max="125" step="5" value={(heights[entry.id]??1)*100} onChange={e=>{editor.cancelSocial();setLoaded(v=>v.filter(id=>id!==entry.id));setHeights(v=>({...v,[entry.id]:+e.target.value/100}));}}/></label>)}<HomeRomanceSettings editor={editor} members={members}/><HomeVisitsPanel ownerId={primary.id} options={options} rows={visits.rows} onError={setStatus}/><fieldset><legend>表情 · {members.find(member=>member.id===a)?.label}</legend><label>眼神<select aria-label="眼神" value={expression.eyes} onChange={e=>changeExpression({eyes:e.target.value as ResidentExpression['eyes']})}><option value="auto">自然 · 跟随动作</option><option value="happy">开心闭眼</option><option value="closed">闭眼</option></select></label><label><input type="checkbox" checked={expression.blink} onChange={e=>changeExpression({blink:e.target.checked})}/>自然眨眼</label></fieldset></div><p role="status">{status}</p></section>}{mainReady&&valid.map(entry=><Resident key={`${entry.id}:${body}:${heights[entry.id]??1}:${hair.bodyHeight??1}`} entry={entry} editor={editor} body={body} height={heights[entry.id]??1} onReady={()=>setLoaded(v=>[...new Set([...v,entry.id])])} onError={setStatus}/>)}</div>;
}
