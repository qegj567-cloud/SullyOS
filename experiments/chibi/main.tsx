import React, { useEffect, useState, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { Puppet, type Motion } from './Puppet';
import type { Parts } from './Puppet';
import './style.css';
import { CreatorRollBridge, type RollResult } from './CreatorRollBridge';
import {decodeParts} from '../../apps/room3d/chibi/visitor';
import Home3DView from '../../apps/room3d/Home3DView';
import type {Home3DState} from '../../apps/room3d/types';
import {HairEditor} from './HairEditor';
import {BodyControls} from './BodyControls';
import {selectedHairAssets,type HairSettings} from '../../apps/room3d/chibi/types';

function App() {
    const [parts, setParts] = useState<Parts>();
    const [image, setImage] = useState(''), [error, setError] = useState('');
    const [yaw, setYaw] = useState(18);
    const [flat, setFlat] = useState(false), [wire, setWire] = useState(false);
    const [motion, setMotion] = useState<Motion>('idle');
    const [playing, setPlaying] = useState(true);
    const [rollRequest, setRollRequest] = useState(0);
    const [rolling, setRolling] = useState(false);
    const [rollReady, setRollReady] = useState(false);
    const [bare, setBare] = useState(false);
    const [world,setWorld]=useState(true);
    const [proportionsOpen,setProportionsOpen]=useState(false);
    const [home,setHome]=useState<Home3DState|undefined>(()=>{try{return JSON.parse(localStorage.getItem('chibi-world-experiment-home')||'null')??undefined;}catch{return undefined;}});
    const saveHome=(next:Home3DState)=>{setHome(next);localStorage.setItem('chibi-world-experiment-home',JSON.stringify(next));};
    const [editing,setEditing]=useState(false),[captureOnly,setCaptureOnly]=useState(false);
    const [editMode,setEditMode]=useState<'2d'|'3d'>('2d');
    const captureTarget=useRef<'world'|'3d'>('world');
    const [hair,setHair]=useState<HairSettings>(()=>{try{const saved=JSON.parse(localStorage.getItem('chibi-world-hair-settings')||'null');if(saved?.layers&&Array.isArray(saved.extras))return saved;}catch{}return {layers:{},extras:[]};});
    const toggleBody=()=>changeHair({...hair,bodyShape:hair.bodyShape==='blank'?'classic':'blank'});
    const [appliedHair,setAppliedHair]=useState(hair);
    const [assets,setAssets]=useState<Record<string,string>>({});
    const effectiveHair=useMemo(()=>({...appliedHair,assets}),[appliedHair,assets]);
    const history=useRef<{past:HairSettings[];future:HairSettings[];group:boolean;recorded:boolean}>({past:[],future:[],group:false,recorded:false});
    const [,refreshHistory]=useState(0);
    const changeHair=(next:HairSettings)=>{if(JSON.stringify(next)===JSON.stringify(hair))return;const h=history.current;if(!h.group||!h.recorded){h.past.push(hair);if(h.past.length>40)h.past.shift();h.recorded=true;}h.future=[];setHair(next);refreshHistory(v=>v+1);};
    const undoHair=()=>{const h=history.current,next=h.past.pop();if(next){h.future.push(hair);h.group=false;setHair(next);refreshHistory(v=>v+1);}};
    const redoHair=()=>{const h=history.current,next=h.future.pop();if(next){h.past.push(hair);h.group=false;setHair(next);refreshHistory(v=>v+1);}};
    useEffect(()=>{const timer=setTimeout(()=>{setAppliedHair(hair);try{localStorage.setItem('chibi-world-hair-settings',JSON.stringify(hair));}catch{setError('比例已在预览中生效，本机存储空间不足，未能保存。');}},120);return()=>clearTimeout(timer);},[hair]);
    const [renderParts,setRenderParts]=useState<Parts>();
    useEffect(()=>{let cancelled=false;if(!parts)return;Promise.all(hair.extras.filter(e=>e.src).map(async e=>{const img=new Image();img.src=e.src!;await img.decode();return [e.source,img] as const;})).then(images=>{if(!cancelled)setRenderParts({...parts,...Object.fromEntries(images)});}).catch(e=>setError(String(e)));return()=>{cancelled=true};},[parts,hair.extras]);
    const saveHair=()=>{try{localStorage.setItem('chibi-world-hair-settings',JSON.stringify(hair));}catch{setError('3D 调整在本次预览中生效，但本机存储空间不足，未能保存。');}};
    const show3d=()=>{captureTarget.current='3d';setRolling(true);setCaptureOnly(true);setRollRequest(v=>v+1);};
    const [initialAppearance]=useState<unknown>(()=>{try{return JSON.parse(localStorage.getItem('chibi-world-experiment-appearance')||'null');}catch{return undefined;}});
    const confirmAppearance=()=>{saveHair();captureTarget.current='world';setError('');setRolling(true);setCaptureOnly(true);setRollRequest(v=>v+1);};

    const requestRoll=()=>{setError('');setRolling(true);setRollRequest(v=>v+1);};
    const acceptRoll=async(result:RollResult)=>{
        try{
            const loaded=await decodeParts(result);
            setParts(loaded);setImage(result.image);setAssets(selectedHairAssets(result.state));
            if(captureTarget.current==='3d')setEditMode('3d');else setEditing(false);
            if(result.state)try{localStorage.setItem('chibi-world-experiment-appearance',JSON.stringify(result.state));}catch{}
        }catch(e){setError(String(e));}finally{setRolling(false);}
    };
    useEffect(()=>{
        if(!rolling)return;
        const timer=window.setTimeout(()=>{setRolling(false);setError('形象读取超时，可以再确认一次。');},20000);
        return()=>window.clearTimeout(timer);
    },[rolling,rollRequest]);    return <main style={world?{height:'100svh',minHeight:0,padding:0,overflow:'hidden'}:undefined}><CreatorRollBridge editing={editing&&editMode==='2d'} captureOnly={captureOnly} savedState={initialAppearance} request={rollRequest} onReady={()=>{setRollReady(true);requestRoll();}} onResult={acceptRoll} onError={message=>{setError(message);setRolling(false);}}/>
        {editing&&<div style={{position:'fixed',top:0,left:0,right:0,height:60,zIndex:31,background:'#fff8f0',display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 16px'}}><button onClick={()=>setEditing(false)}>返回</button><button onClick={()=>setEditMode('2d')} aria-pressed={editMode==='2d'}>选素材</button><button disabled={rolling} onClick={show3d} aria-pressed={editMode==='3d'}>3D 调整</button><button disabled={rolling} onClick={confirmAppearance}>{rolling?'读取中…':'捏好了，去小屋'}</button></div>}
        {editing&&editMode==='3d'&&renderParts&&<HairEditor parts={renderParts} hair={hair} previewHair={effectiveHair} assets={assets} onChange={changeHair} onUndo={undoHair} onRedo={redoHair} onReset={()=>changeHair({layers:{},extras:[]})} canUndo={history.current.past.length>0} canRedo={history.current.future.length>0} onBegin={()=>{history.current.group=true;history.current.recorded=false;}} onEnd={()=>{history.current.group=false;}}/>}
        {world?<><section style={{position:'fixed',inset:0,zIndex:10}}>{parts?<Home3DView suspended={editing} hair={effectiveHair} parts={renderParts||parts} value={home} onChange={saveHome} onBack={()=>setWorld(false)}/>:<p>{error||'小人正在搬家…'}</p>}<div className="chibi-home-appearance"><button disabled={!rollReady||rolling} onClick={()=>setEditing(true)}>{rolling?'读取中…':'✎ 捏小人'}</button><button onClick={toggleBody}>体型：{hair.bodyShape==='blank'?'新模型':'原版'}</button>{hair.bodyShape==='blank'&&<button aria-expanded={proportionsOpen} onClick={()=>setProportionsOpen(v=>!v)}>调整比例</button>}{proportionsOpen&&hair.bodyShape==='blank'&&<section className="body-proportion-popover" aria-label="小人比例"><h2>小人比例</h2><BodyControls hair={hair} onChange={changeHair} onBegin={()=>{history.current.group=true;history.current.recorded=false;}} onEnd={()=>{history.current.group=false;}}/><div className="body-history"><button disabled={!history.current.past.length} onClick={undoHair}>撤销</button><button disabled={!history.current.future.length} onClick={redoHair}>重做</button><button onClick={()=>setProportionsOpen(false)}>收起</button></div></section>}</div>{error&&<p role="alert" style={{position:'absolute',left:18,top:195}}>{error}</p>}</section></>:<>
        <header><div className="eyebrow">KANATA / HAIR SHEETS</div><h1>再试一次，发片小人。</h1><p>前后一圈薄发片，包住圆墩墩的素体。</p><button onClick={()=>setWorld(true)}>带去 Little World →</button></header>
        <section className="stage">{parts ? <><div className="model-layer" style={{ visibility: flat ? 'hidden' : 'visible' }}><Puppet hair={effectiveHair} parts={renderParts||parts} yaw={yaw} motion={motion} wire={wire} playing={playing && !flat} appearance={bare ? 'skin' : 'outfit'} /></div>{flat && <img className="original" src={image} alt="原始分层 chibi 合成图" />}</> : <p>{error || '正在读取分层素材…'}</p>}</section>
        <footer>
            <div className="actions">{([['idle','站立'],['wave-cute','可爱挥手'],['wave-calm','冷静挥手'],['sleep','睡觉'],['angry','生气'],['walk','走路'],['dance','晃一晃']] as const).map(([key,label])=><button key={key} aria-pressed={motion===key} onClick={()=>{setMotion(key);setPlaying(true);setFlat(false);}}>{label}</button>)}<button onClick={()=>setPlaying(!playing)}>{playing?'暂停':'继续'}</button></div>
            <div className="controls"><label>转角 <input aria-label="转角" type="range" min="-180" max="180" value={yaw} onChange={e => setYaw(+e.target.value)} /><output>{yaw}°</output></label></div>
            <nav><button onClick={toggleBody}>体型：{hair.bodyShape==='blank'?'新模型':'原版'}</button><button aria-pressed={bare} onClick={()=>setBare(!bare)}>{bare ? '穿回发片' : '看光头素体'}</button><button aria-pressed={flat} onClick={() => setFlat(!flat)}>{flat ? '返回立体' : '对照原图'}</button><button aria-pressed={wire} onClick={() => setWire(!wire)}>{wire ? '隐藏网格' : '显示网格'}</button><button disabled={!rollReady||rolling} onClick={()=>setEditing(true)}>{rolling ? '读取中…' : '✎ 捏小人'}</button><button onClick={() => { setYaw(0); }}>正面</button></nav>
            <p className="note">前发与后发使用同一圈曲面的前后两半，侧边对齐。发片没有厚度；保留原图透明轮廓。</p>
            {error && <p role="alert">{error}</p>}
        </footer></>}
    </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
