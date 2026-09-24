import React,{useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {cleanFace,applyEyePreset} from '../../apps/room3d/chibi/faceAppearance';
import {HairEditor} from './HairEditor';
import {CreatorRollBridge,type RollResult} from './CreatorRollBridge';
import {decodeParts} from '../../apps/room3d/chibi/visitor';
import {selectedHairAssets,type HairSettings,type Parts} from '../../apps/room3d/chibi/types';
import './style.css';
import './wardrobe-studio.css';
const DRAFT='chibi-wardrobe-studio-draft-v1';
const APPEARANCE_DRAFT='chibi-wardrobe-appearance-draft-v1';
const defaults:HairSettings={layers:{},extras:[],bodyShape:'blank',wardrobeStyle:'normal'};
function read(key:string){try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}}
function closedMouthHair(h:HairSettings):HairSettings{if(!h.face)return h;const face=cleanFace(h.face);return {...h,face:{...face,mouth:face.mouths!.closed}};}
function Studio(){
 const [hair,setHair]=useState<HairSettings>(()=>{const h=read(DRAFT)??read('chibi-world-hair-settings');return h?.layers&&Array.isArray(h.extras)?closedMouthHair({...h,bodyShape:h.bodyShape??'blank'}):defaults;});
 const [editing,setEditing]=useState(false),[capturing,setCapturing]=useState(false),[captureOnly,setCaptureOnly]=useState(false),[appearanceImage,setAppearanceImage]=useState('');
 const [preview,setPreview]=useState(hair),[parts,setParts]=useState<Parts>(),[request,setRequest]=useState(0),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [savedState]=useState(()=>read(APPEARANCE_DRAFT)??read('chibi-world-experiment-appearance'));
 const [appearance,setAppearance]=useState<unknown>(),[assets,setAssets]=useState<Record<string,string>>({}),[extraParts,setExtraParts]=useState<Parts>();
 const past=useRef<HairSettings[]>([]),future=useRef<HairSettings[]>([]),group=useRef(false),recorded=useRef(false);
 const change=(next:HairSettings)=>{next=closedMouthHair(next);if(JSON.stringify(next)===JSON.stringify(hair))return;if(!group.current||!recorded.current){past.current.push(hair);if(past.current.length>40)past.current.shift();recorded.current=true;}future.current=[];setHair(next);setNotice('');};
 const undo=()=>{const h=past.current.pop();if(h){future.current.push(hair);setHair(h);group.current=false;}};
 const redo=()=>{const h=future.current.pop();if(h){past.current.push(hair);setHair(h);group.current=false;}};
 useEffect(()=>{const timer=setTimeout(()=>{setPreview(hair);try{localStorage.setItem(DRAFT,JSON.stringify(hair));}catch{setError('草稿未保存：本机存储空间不足。');}},120);return()=>clearTimeout(timer);},[hair]);
 useEffect(()=>{let cancelled=false;if(!parts)return;Promise.all(hair.extras.filter(e=>e.src).map(async e=>{const image=new Image();image.src=e.src!;await image.decode();return [e.source,image] as const;})).then(extra=>{if(!cancelled)setExtraParts({...parts,...Object.fromEntries(extra)});}).catch(e=>setError(String(e)));return()=>{cancelled=true};},[parts,hair.extras]);
 const effective=useMemo(()=>({...preview,assets}),[preview,assets]);
 const accept=async(result:RollResult)=>{try{
  const decoded=await decodeParts(result);setParts(decoded);setAssets(selectedHairAssets(result.state));setAppearanceImage(result.image);
  const selected=(result.state as {selected?:Record<string,string>}|undefined)?.selected;
  const oldSelected=(appearance as {selected?:Record<string,string>}|undefined)?.selected;
  const eyeId=selected?.eyes?.match(/^eyes_0?([1-7])$/)?.[1]?.padStart(2,'0');
  if(!hair.face||(editing&&selected?.eyes!==oldSelected?.eyes)){
   const current=cleanFace(hair.face),style=eyeId??'01';
   const face={...applyEyePreset(current,style),enabled:true,mouth:current.mouths!.closed};
   setHair(h=>({...h,face}));
  }
  setAppearance(result.state);if(result.state){try{localStorage.setItem(APPEARANCE_DRAFT,JSON.stringify(result.state));}catch{setError('形象草稿未保存：本机存储空间不足。');}}
  if(capturing){setEditing(false);setCapturing(false);past.current=[];future.current=[];}
 }catch(e){setError(String(e));setCapturing(false);}};
 const finishAppearance=()=>{setCapturing(true);setCaptureOnly(true);setRequest(n=>n+1);};
 const save=()=>{try{localStorage.setItem('chibi-world-hair-settings',JSON.stringify(hair));if(appearance)localStorage.setItem('chibi-world-experiment-appearance',JSON.stringify(appearance));setNotice('搭配已保存，下次打开会恢复。');}catch{setError('保存失败：本机存储空间不足。');}};
 return <><header className="wardrobe-studio-top"><div><strong>CHIBI 工坊</strong><span>形象 · 捏脸 · 换装</span></div><button onClick={editing?finishAppearance:save} disabled={!parts||capturing}>{editing?(capturing?'正在应用…':'完成形象'):'保存形象'}</button></header><CreatorRollBridge savedState={savedState??undefined} request={request} onReady={()=>setRequest(1)} onResult={accept} editing={editing} captureOnly={captureOnly} onError={message=>{setError(message);setCapturing(false);}}/>{extraParts&&!editing?<HairEditor appearanceImage={appearanceImage} onEditAppearance={()=>setEditing(true)} parts={extraParts} hair={hair} previewHair={effective} assets={assets} onChange={change} onUndo={undo} onRedo={redo} onReset={()=>change(structuredClone(defaults))} canUndo={!!past.current.length} canRedo={!!future.current.length} onBegin={()=>{group.current=true;recorded.current=false;}} onEnd={()=>{group.current=false;}}/>:editing?null:<div className="wardrobe-loading">正在准备你的衣橱…</div>}{(notice||error)&&<div className="wardrobe-notice" role={error?'alert':'status'}>{error||notice}<button aria-label="关闭提示" onClick={()=>{setError('');setNotice('');}}>×</button></div>}</>;
}
const root=import.meta.hot?.data.root??createRoot(document.getElementById('root')!);
root.render(<Studio/>);
if(import.meta.hot)import.meta.hot.dispose(data=>{data.root=root;});
