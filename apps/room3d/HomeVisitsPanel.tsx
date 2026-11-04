import React,{useState} from 'react';
import {requestHomeVisit,decideHomeVisit,cancelHomeVisit,type HomeVisit} from '../../utils/homeVisits';
import './homeVisits.css';
const labels:Record<HomeVisit['status'],string>={pending:'待回复',accepted:'已同意 · 等待到场',arrived:'串门中',declined:'已婉拒',cancelled:'已取消',done:'已结束'};
export function HomeVisitsPanel({ownerId,options,rows,onError}:{ownerId:string;options:Array<{id:string;label:string}>;rows:HomeVisit[];onError:(s:string)=>void}){
 const [target,setTarget]=useState(''),[when,setWhen]=useState(''),[duration,setDuration]=useState('30'),[purpose,setPurpose]=useState(''),[busy,setBusy]=useState(false);
 const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);onError('');try{await fn();}catch(e){onError(e instanceof Error?e.message:'串门处理失败');}finally{setBusy(false);}};
 const relevant=rows.filter(v=>v.hostId===ownerId||v.guestId===ownerId).sort((a,b)=>b.startsAt-a.startsAt).slice(0,12);
 return <fieldset className="home-visits"><legend>串个门</legend><p>按设备时间预约；对方下次聊天可以答复，到点未回复自动同意。房主在家且有空位时，访客才会进来。</p>
 <label>去谁家<select aria-label="串门目标" value={target} disabled={busy} onChange={e=>setTarget(e.target.value)}><option value="">选一个角色</option>{options.filter(p=>p.id!=='user'&&p.id!==ownerId).map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
 <div className="home-visits-time"><label>什么时候<input type="datetime-local" aria-label="串门时间" value={when} onChange={e=>setWhen(e.target.value)}/></label><label>待多久<select value={duration} onChange={e=>setDuration(e.target.value)}><option value="5">5 分钟</option><option value="30">半小时</option><option value="60">1 小时</option><option value="120">2 小时</option></select></label></div>
 <label>来意<input value={purpose} maxLength={160} placeholder="聊聊天，看看对方的新家…" onChange={e=>setPurpose(e.target.value)}/></label>
 <button disabled={busy||!target||!when} onClick={()=>void run(()=>requestHomeVisit({guestId:ownerId,hostId:target,startsAt:new Date(when).getTime(),endsAt:new Date(when).getTime()+Number(duration)*60000,purpose:purpose.trim()||'过来坐坐'}))}>发出申请</button>
 <ul>{relevant.map(v=><li key={v.id}><div><strong>{v.hostId===ownerId?'来访 · ':'去拜访 · '}{options.find(p=>p.id===(v.hostId===ownerId?v.guestId:v.hostId))?.label||'已删除角色'}</strong><span>{labels[v.status]}{v.automatic?' · 到点自动同意':''}</span><time>{new Date(v.startsAt).toLocaleString([], {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} · {Math.round((v.endsAt-v.startsAt)/60000)} 分钟</time>{v.purpose&&<p>{v.purpose}</p>}{v.reason&&<p role="status">{v.reason}</p>}</div><div className="home-visits-actions">{v.hostId===ownerId&&v.status==='pending'&&<><button disabled={busy} onClick={()=>void run(()=>decideHomeVisit(ownerId,v.id,true))}>同意</button><button disabled={busy} onClick={()=>void run(()=>decideHomeVisit(ownerId,v.id,false))}>婉拒</button></>}{['pending','accepted','arrived'].includes(v.status)&&<button disabled={busy} onClick={()=>void run(()=>cancelHomeVisit(ownerId,v.id))}>取消</button>}</div></li>)}</ul>
 {!relevant.length&&<p>还没有约好的串门。</p>}</fieldset>;
}
