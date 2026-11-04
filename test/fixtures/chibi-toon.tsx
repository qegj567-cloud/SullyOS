import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Puppet} from '../../experiments/chibi/Puppet';
import {CreatorRollBridge} from '../../apps/room3d/chibi/CreatorRollBridge';
import {decodeParts} from '../../apps/room3d/chibi/visitor';
import {selectedHairAssets,type Parts,type HairSettings} from '../../apps/room3d/chibi/types';
import {testCharacter} from './room3d-test-character';
const hair:HairSettings={layers:{},extras:[],assets:selectedHairAssets(testCharacter.state)};
function ToonQA(){
 const [parts,setParts]=useState<Parts>(),[request,setRequest]=useState(0),[yaw,setYaw]=useState(24),[error,setError]=useState('');
 useEffect(()=>{const w=window as any;w.advanceTime=()=>{};w.render_game_to_text=()=>JSON.stringify({ready:!!parts,yaw,models:Array.from(document.querySelectorAll<HTMLElement>('.puppet')).map(o=>({...o.dataset}))});},[parts,yaw]);
 return <><CreatorRollBridge request={request} onReady={()=>setRequest(1)} savedState={testCharacter.state} onError={setError} onResult={r=>{void decodeParts(r,hair).then(setParts);}}/><main>{(['classic','blank'] as const).map((body,i)=><section key={body}><h2>{i?'二号素体':'原版小人'}</h2>{parts&&<Puppet parts={parts} hair={{...hair,bodyShape:body}} yaw={yaw} motion="idle" wire={false} playing={false}/>}</section>)}</main><footer><label>转动人物 <input aria-label="转动人物" type="range" min="-180" max="180" value={yaw} onChange={e=>setYaw(+e.target.value)}/></label><span>{error||'正式人物材质 · 原色预览'}</span></footer></>;
}
createRoot(document.getElementById('root')!).render(<ToonQA/>);
