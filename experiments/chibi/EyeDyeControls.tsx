import React from 'react';
import {AppearanceColorControl} from './AppearanceColorControl';
import {FigureSlider} from './FigureSlider';
import {HUE_PALETTE,hexForTint} from '../../apps/room3d/chibi/creatorHairTint';
import type {EyeTint} from '../../apps/room3d/chibi/faceTint';

export function EyeDyeControls({label,value,tint,onChange,onBegin,onEnd}:{label:string;value?:string;tint?:EyeTint;onChange:(color?:string,tint?:EyeTint)=>void;onBegin:()=>void;onEnd:()=>void}){
 const current=tint??{hueIdx:0,sat:50,light:0,color:value};
 const set=(next:EyeTint)=>onChange(hexForTint(next),next);
 return <>
  <fieldset className="appearance-colors"><legend>{label} · Chibi 候选色</legend><div>{HUE_PALETTE.map((swatch,hueIdx)=><button key={swatch.name} className="appearance-swatch" style={{backgroundColor:swatch.hex}} title={swatch.name} aria-label={`${label} ${swatch.name}`} aria-pressed={!!tint&&!tint.color&&tint.hueIdx===hueIdx} onClick={()=>set({...current,hueIdx,color:undefined})}/>)}</div></fieldset>
  {tint&&!tint.color&&<>
   <FigureSlider label={`${label}饱和度`} value={tint.sat} min={0} max={100} onChange={sat=>set({...tint,sat})} onBegin={onBegin} onEnd={onEnd}/>
   <FigureSlider label={`${label}明度`} value={tint.light} min={-50} max={50} onChange={light=>set({...tint,light})} onBegin={onBegin} onEnd={onEnd}/>
  </>}
  <AppearanceColorControl label={label} value={value} colors={[]} onChange={color=>color?set({...current,color}):onChange()} onBegin={onBegin} onEnd={onEnd}/>
 </>;
}
