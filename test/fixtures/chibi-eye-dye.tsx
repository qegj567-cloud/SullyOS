import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CreatorRollBridge,type RollResult} from '../../apps/room3d/chibi/CreatorRollBridge';
import {decodeParts} from '../../apps/room3d/chibi/visitor';
import {colorBaseEyes} from '../../apps/room3d/chibi/baseEyeColors';
import {cleanFace} from '../../apps/room3d/chibi/faceAppearance';
import {testCharacter} from './room3d-test-character';

function App(){
 const [flipped,setFlipped]=useState(false),[threshold,setThreshold]=useState(0),[ready,setReady]=useState(false),[result,setResult]=useState<{left:string;right:string;difference:number;untouched:number}>(),[error,setError]=useState('');
 const L={hueIdx:6,sat:50,light:50},R={hueIdx:15,sat:65,light:0};
 const state={...testCharacter.state,preserveLineart:threshold,flipped:{eyes:flipped},tintColor:{...testCharacter.state.tintColor,eyes:{L,R,linked:false}}};
 const accept=async(r:RollResult)=>{
  const p=await decodeParts(r),face=cleanFace({useBaseEyes:true,irisColors:r.eyeColors,irisTints:r.eyeTints});
  const direct=colorBaseEyes(p.eyes,p['eyes-raw'],face),one=colorBaseEyes(p.eyes,p['eyes-raw'],cleanFace({useBaseEyes:true,irisColors:{L:'#ff0000'}}));
  const canvas=document.createElement('canvas');canvas.width=canvas.height=472;const ctx=canvas.getContext('2d')!;
  const pixels=(source:CanvasImageSource)=>{ctx.clearRect(0,0,472,472);ctx.drawImage(source,0,0,472,472);return ctx.getImageData(0,0,472,472).data;};
  const before=pixels(p.eyes),after=pixels(direct),single=pixels(one);let difference=0,untouched=0;
  for(let i=0;i<before.length;i+=4){for(let c=0;c<4;c++){const delta=Math.abs(c===3?before[i+c]-after[i+c]:Math.round(before[i+c]*before[i+3]/255)-Math.round(after[i+c]*after[i+3]/255));difference=Math.max(difference,delta);if((i/4)%472>=236)untouched=Math.max(untouched,Math.abs(before[i+c]-single[i+c]));}}
  const crop=(source:CanvasImageSource)=>{ctx.clearRect(0,0,472,472);ctx.drawImage(source,100,220,272,120,0,0,472,208);return canvas.toDataURL();};
  setResult({left:crop(p.eyes),right:crop(direct),difference,untouched});
 };
 return <main style={{fontFamily:'sans-serif',maxWidth:900,margin:'24px auto',padding:20,background:'#f4f3ec'}}><h1>Chibi / 3D 眼睛染色</h1><p>左：Chibi 导出。右：3D 原图重染。奶白银高明度 + 薄荷绿异色瞳。</p><button onClick={()=>{setReady(false);setFlipped(!flipped);}}>切换眼睛镜像</button><button onClick={()=>{setReady(false);setThreshold(threshold===0?55:0);}}>切换线稿阈值</button><p>镜像：{flipped?'是':'否'}；线稿阈值：{threshold}</p><p role="status">{error||(result?`最大像素差 ${result.difference}；单眼染色时另一侧像素差 ${result.untouched}`:'准备中…')}</p>{result&&<div style={{display:'flex'}}><img width="50%" src={result.left}/><img width="50%" src={result.right}/></div>}<CreatorRollBridge key={JSON.stringify([flipped,threshold])} savedState={state} request={ready?1:0} onReady={()=>setReady(true)} onResult={r=>void accept(r).catch(e=>setError(String(e)))} onError={setError}/></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
