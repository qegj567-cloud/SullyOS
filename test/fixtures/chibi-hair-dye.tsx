import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CreatorRollBridge,type RollResult} from '../../apps/room3d/chibi/CreatorRollBridge';
import {decodeParts} from '../../apps/room3d/chibi/visitor';
import {tintAppearancePart} from '../../apps/room3d/chibi/appearanceColors';
import {HUE_PALETTE,hexForTint,type CreatorHairTint} from '../../apps/room3d/chibi/creatorHairTint';
import {testCharacter} from './room3d-test-character';

function App(){
 const [flipped,setFlipped]=useState(false);
 const [tint,setTint]=useState<CreatorHairTint>({hueIdx:2,sat:50,light:0}),[ready,setReady]=useState(false),[rows,setRows]=useState<{key:string;original:string;direct:string;difference:number}[]>([]),[error,setError]=useState('');
 const state={...testCharacter.state,flipped:{fronthair:flipped,earhair:flipped,back1:flipped},tintColor:{...testCharacter.state.tintColor,...Object.fromEntries(['fronthair','earhair','back1','back2'].map(key=>[key,tint]))}};
 const accept=async(result:RollResult)=>{
  const parts=await decodeParts(result),next=[];
  for(const key of ['fronthair','earhair','back1']){
   const direct=tintAppearancePart(parts[key+'-raw'],hexForTint(tint),tint.gradientColor,tint,parts[key+'-shadow']);
   const canvas=document.createElement('canvas');canvas.width=canvas.height=472;const ctx=canvas.getContext('2d')!;
   ctx.drawImage(parts[key],0,0,472,472);const before=ctx.getImageData(0,0,472,472).data;
   ctx.clearRect(0,0,472,472);ctx.drawImage(direct,0,0,472,472);const after=ctx.getImageData(0,0,472,472).data;let difference=0;
   for(let i=0;i<before.length;i+=4){difference=Math.max(difference,Math.abs(before[i+3]-after[i+3]));for(let c=0;c<3;c++)difference=Math.max(difference,Math.abs(Math.round(before[i+c]*before[i+3]/255)-Math.round(after[i+c]*after[i+3]/255)));}
   next.push({key,original:result.layers[key],direct:canvas.toDataURL(),difference});
  }
  setRows(next);
 };
 return <main style={{fontFamily:'sans-serif',maxWidth:1000,margin:'24px auto',background:'#f7f5ef',padding:20}}><h1>Chibi 与 3D 发色对照</h1><p>同一原始发片：左侧先在 Chibi 染色再导入，右侧在 3D 直接染色。</p><select aria-label="候选发色" value={tint.hueIdx} onChange={e=>{setReady(false);setTint({hueIdx:Number(e.target.value),sat:50,light:0});}}>{HUE_PALETTE.map((p,i)=><option value={i} key={i}>{p.name}</option>)}</select><button onClick={()=>{setReady(false);setTint({...tint,color:'#e2b8cb',gradientColor:'#b7c8e1'});}}>检查粉蓝渐变</button><button onClick={()=>{setReady(false);setFlipped(value=>!value);}}>切换发片镜像</button><p role="status">{error||rows.map(r=>`${r.key} 最大像素差 ${r.difference}`).join('；')}</p>{rows.map(r=><section key={r.key}><h2>{r.key}</h2><img width="40%" src={r.original}/><img width="40%" src={r.direct}/></section>)}<CreatorRollBridge key={JSON.stringify([tint,flipped])} savedState={state} request={ready?1:0} onReady={()=>setReady(true)} onResult={r=>void accept(r).catch(e=>setError(String(e)))} onError={setError}/></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
